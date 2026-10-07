/* =============================================================================
 * TERRA INFINITA — player controller & cameras
 * First-person kinematic character with acceleration, surface-dependent speed,
 * slope handling, jumping, crouching, sprinting, swimming, climbing, head-bob,
 * landing response and footsteps; plus third-person and free-fly cameras.
 * ========================================================================== */
(function () {
  'use strict';
  var U = TERRA.util, M = TERRA.math;

  var EYE = 1.68, EYE_CROUCH = 1.05, RADIUS = 0.35;

  function Player(engine) {
    this.engine = engine;
    this.pos = [0, 0, 0];         // feet, world space (float64)
    this.vel = [0, 0, 0];
    this.yaw = 0; this.pitch = -0.05;
    this.tYaw = 0; this.tPitch = -0.05;
    this.onGround = false; this.swimming = false; this.climbing = false; this.crouch = 0; this.sprinting = false; this.walkToggle = false;
    this.mode = 'first';
    this.freeSpeed = 25;
    this.bobPhase = 0; this.bobAmt = 0; this.landDip = 0; this.landVel = 0;
    this.fovBoost = 0;
    this.stepDist = 0; this.foot = 0;
    this.surface = 'grass';
    this.waterLevel = -1e5; this.waterType = 0;
    this._waterT = 0;
    this.stamina = 1;
    this.eye = [0, 0, 0];
    this.camPos = [0, 0, 0];
    this.forward = [0, 0, -1];
    this.speed = 0;
    this.airTime = 0;
    this.tpDist = 4.5;
  }
  var P = Player.prototype;

  P.teleport = function (x, z, y) {
    var h = this.engine.groundHeight(x, z);
    this.pos = [x, y !== undefined ? Math.max(y, h) : h + 0.05, z];
    this.vel = [0, 0, 0];
    this._waterT = 0;
    this._camera(0, this.engine.settings.controls, this.engine.environment.env);
  };

  P._surfaceAt = function (env) {
    var L = this.engine.environment.local;
    var B = TERRA.core.BIOME;
    if (this.waterDepth > 0.08) return 'water';
    if (env.snowCover > 0.35 && L.temp < 2) return 'snow';
    if (L.temp < -2.5 || L.biome === B.SNOWFIELD || L.biome === B.GLACIER) return 'snow';
    if (L.biome === B.BEACH || L.biome === B.DESERT) return 'sand';
    if (L.biome === B.WETLAND || (env.wetness > 0.6 && L.biome !== B.MOUNTAIN)) return 'mud';
    if (this.slope > 0.55 || L.biome === B.MOUNTAIN || L.biome === B.HIGH_MOUNTAIN || L.biome === B.VOLCANIC || L.biome === B.ROCKY_DESERT) return 'rock';
    if (L.forest > 0.4) return 'leaves';
    return 'grass';
  };

  P.update = function (dt, input, settings, env) {
    var ctl = settings.controls, E = this.engine;
    dt = Math.min(dt, 0.05);
    // ---- look
    var sens = 0.0022 * (ctl.sensitivity || 1);
    this.tYaw -= input.mouse.dx * sens;
    this.tPitch -= input.mouse.dy * sens * (ctl.invertY ? -1 : 1);
    this.tPitch = U.clamp(this.tPitch, -1.53, 1.53);
    var sm = U.clamp(ctl.smoothing || 0, 0, 0.95);
    var k = sm > 0 ? 1 - Math.pow(sm * 0.9, dt * 60) : 1;
    this.yaw = U.mix(this.yaw, this.tYaw, k);
    this.pitch = U.mix(this.pitch, this.tPitch, k);
    var cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.forward = [-sy * cp, sp, -cy * cp];
    var fwdH = [-sy, 0, -cy], right = [cy, 0, -sy];

    if (this.mode === 'free') { this._free(dt, input, fwdH, right); this._camera(dt, ctl, env); return; }

    // ---- environment queries
    var gh = E.groundHeight(this.pos[0], this.pos[2]);
    var e = 0.6;
    var hx = E.groundHeight(this.pos[0] + e, this.pos[2]) - E.groundHeight(this.pos[0] - e, this.pos[2]);
    var hz = E.groundHeight(this.pos[0], this.pos[2] + e) - E.groundHeight(this.pos[0], this.pos[2] - e);
    var gx = hx / (2 * e), gz = hz / (2 * e);
    this.slope = Math.hypot(gx, gz);
    this._waterT -= dt;
    if (this._waterT <= 0) { var w = E.waterAt(this.pos[0], this.pos[2]); this.waterLevel0 = w.level; this.waterType = w.type; this.waterFlow = [w.fx || 0, w.fz || 0]; this._waterT = 0.12; }
    // the local surface rides on the swell (same wave spectrum as the water shader)
    this.waterLevel = (this.waterLevel0 === undefined ? -1e5 : this.waterLevel0) +
      (this.waterLevel0 > -1e4 ? TERRA.world.Water.waveHeight(this.pos[0] - E.origin[0], this.pos[2] - E.origin[1], E.time, this.waterType, env) : 0);
    this.waterDepth = Math.max(0, this.waterLevel - gh);
    var submerge = this.waterLevel - this.pos[1];
    this.swimming = this.waterType !== 4 && this.waterDepth > 1.25 && submerge > 1.0;
    // ground surface: friction, rolling, footprints and sound all follow it (weather included)
    this._surfT = (this._surfT || 0) - dt;
    if (this._surfT <= 0 || !this.surf) {
      this._surfT = 0.25;
      var Sf = TERRA.game.Surfaces;
      this.puddle = Sf.puddleAt(E, this.pos[0], this.pos[2], env);
      this.surface = Sf.classify(env, E.environment.local, this.slope, this.waterDepth, this.puddle);
      this.surf = Sf.info(this.surface, env, this.surf || {});
    }
    var surf = this.surf, grip = U.clamp(surf.mu / 0.7, 0.12, 1.15);

    // ---- input
    var mx = 0, mz = 0;
    if (input.down('KeyW') || input.down('ArrowUp')) mz += 1;
    if (input.down('KeyS') || input.down('ArrowDown')) mz -= 1;
    if (input.down('KeyD') || input.down('ArrowRight')) mx += 1;
    if (input.down('KeyA') || input.down('ArrowLeft')) mx -= 1;
    if (input.hit('KeyX')) this.walkToggle = !this.walkToggle;
    var wantCrouch = input.down('ControlLeft') || input.down('KeyC') || input.down('ControlRight');
    this.crouch = U.approach(this.crouch, wantCrouch && !this.swimming ? 1 : 0, dt * 5);
    this.sprinting = (input.down('ShiftLeft') || input.down('ShiftRight')) && mz > 0 && this.crouch < 0.5 && this.stamina > 0.05;
    var len = Math.hypot(mx, mz);
    if (len > 0) { mx /= len; mz /= len; }
    var wish = [fwdH[0] * mz + right[0] * mx, 0, fwdH[2] * mz + right[2] * mx];

    // ---- speed model
    var speed = this.walkToggle ? 2.3 : 4.6;
    if (this.sprinting) speed = 8.2;
    if (this.crouch > 0.5) speed = 1.8;
    var surfMul = surf.speed;
    if (this.surface === 'snow' && env.snowCover > 0.6) surfMul *= 0.85;
    if (this.stagger > 0) { this.stagger -= dt; surfMul *= 0.55; }
    if (this.waterDepth > 0.4 && !this.swimming) surfMul *= U.mix(1, 0.55, U.clamp01((this.waterDepth - 0.4) / 0.8));
    var uphill = len > 0 ? (gx * wish[0] + gz * wish[2]) : 0;
    var slopeMul = uphill > 0 ? 1 - U.clamp(uphill * 0.85, 0, 0.75) : 1 + U.clamp(-uphill * 0.15, 0, 0.12);
    var target = speed * surfMul * slopeMul;
    this.stamina = U.clamp01(this.stamina + (this.sprinting ? -0.07 : 0.1) * dt);

    if (this.swimming) {
      // ---- swimming
      var swimSpeed = this.sprinting ? 3.2 : 2.1;
      var vy = 0;
      if (input.down('Space')) vy = 1.6;
      else if (wantCrouch) vy = -1.6;
      var sw = [this.forward[0] * mz + right[0] * mx, this.forward[1] * mz, this.forward[2] * mz + right[2] * mx];
      var tv = [sw[0] * swimSpeed, sw[1] * swimSpeed + vy, sw[2] * swimSpeed];
      // buoyancy keeps the head near the surface when idle
      // the head rides the swell (a little above the local surface, tracking crests and troughs)
      if (!input.down('Space') && !wantCrouch && mz === 0) tv[1] = U.clamp((this.waterLevel - 1.25 - this.pos[1]) * 4.0, -2.5, 2.5);
      // river current carries the swimmer
      if (this.waterType === 3 && this.waterFlow) { tv[0] += this.waterFlow[0] * 0.8; tv[2] += this.waterFlow[1] * 0.8; }
      for (var i = 0; i < 3; i++) this.vel[i] = U.damp(this.vel[i], tv[i], i === 1 ? 7 : 3, dt);
      if (this.pos[1] > this.waterLevel - 1.3 && this.vel[1] > 0 && !input.down('Space')) this.vel[1] *= 0.5;
      this.onGround = false;
    } else {
      // ---- walking / running: momentum with surface-dependent acceleration and friction
      var tvx = wish[0] * target, tvz = wish[2] * target;
      var vx = this.vel[0], vz = this.vel[2];
      if (this.onGround) {
        if (len > 0) {
          var A = 12 * surf.accel * (0.35 + 0.65 * grip) * (this.sprinting ? 1.15 : 1);
          var ddx = tvx - vx, ddz = tvz - vz, ddl = Math.hypot(ddx, ddz), mx2 = A * dt;
          // turning on slippery ground keeps part of the old momentum (you slide around corners)
          if (ddl > mx2) { ddx *= mx2 / ddl; ddz *= mx2 / ddl; }
          vx += ddx; vz += ddz;
        } else {
          var D = 14 * (0.15 + 0.85 * grip), spd0 = Math.hypot(vx, vz), dec = D * dt;
          if (spd0 <= dec) { vx = 0; vz = 0; } else { vx -= vx / spd0 * dec; vz -= vz / spd0 * dec; }
        }
      } else {
        // limited air control; momentum carries
        var Aa = 2.4 * dt, adx = tvx - vx, adz = tvz - vz, adl = Math.hypot(adx, adz);
        if (len > 0 && adl > 0) { var k2 = Math.min(1, Aa / adl); vx += adx * k2; vz += adz * k2; }
        var drag = Math.exp(-0.05 * dt); vx *= drag; vz *= drag;
      }
      this.vel[0] = vx; this.vel[2] = vz;
      // steep slopes: slide unless climbing (slippery ground slides sooner)
      this.climbing = false;
      var slideAt = 0.5 + surf.mu * 0.75;
      if (this.onGround && this.slope > slideAt) {
        if (mz > 0 && input.down('Space') && uphill > 0 && this.stamina > 0.1 && surf.mu > 0.3) {
          this.climbing = true; this.stamina -= dt * 0.12;
          this.vel[0] = wish[0] * 1.3; this.vel[2] = wish[2] * 1.3; this.vel[1] = 1.3 * Math.min(1.5, this.slope);
        } else {
          var sl = this.slope;
          this.vel[0] -= gx / sl * 9 * dt * (sl - slideAt + 0.05); this.vel[2] -= gz / sl * 9 * dt * (sl - slideAt + 0.05);
        }
      }
      // jump
      if (this.onGround && input.hit('Space') && this.crouch < 0.5 && !this.climbing) {
        this.vel[1] = 6.2 * (surf.soft > 0.7 || this.surface === 'ice' ? 0.86 : 1); this.onGround = false;
        TERRA.events.emit('jump', { surface: this.surface });
      }
      if (!this.climbing) this.vel[1] -= 20 * dt;
      if (this.waterDepth > 0.5 && this.pos[1] < this.waterLevel) this.vel[1] = Math.max(this.vel[1], -3);
    }

    // wading in a river: the current pushes against the legs
    if (!this.swimming && this.waterType === 3 && this.waterDepth > 0.3 && this.waterFlow) {
      var push = U.clamp01((this.waterDepth - 0.3) / 1.0) * 0.6 * dt;
      this.vel[0] += this.waterFlow[0] * push; this.vel[2] += this.waterFlow[1] * push;
    }
    // ---- integrate & collide
    var wasAbove = this.pos[1] > this.waterLevel - 0.3;
    for (var vi = 0; vi < 3; vi++) { if (!(this.vel[vi] === this.vel[vi])) this.vel[vi] = 0; this.vel[vi] = U.clamp(this.vel[vi], -60, 60); }
    var ox = this.pos[0], oz = this.pos[2], oy = this.pos[1];
    this.pos[0] += this.vel[0] * dt; this.pos[1] += this.vel[1] * dt; this.pos[2] += this.vel[2] * dt;
    this._collideObjects();
    var h = E.groundHeight(this.pos[0], this.pos[2]);
    // a ledge higher than a big step blocks you (jump or climb instead of gliding up rock walls)
    if (this.onGround && !this.swimming && !this.climbing && h - oy > 0.55 + Math.max(0, this.vel[1]) * dt) {
      var nx = this.pos[0] - ox, nz = this.pos[2] - oz, nl = Math.hypot(nx, nz) || 1;
      this.pos[0] = ox; this.pos[2] = oz;
      var vin = (this.vel[0] * nx + this.vel[2] * nz) / nl;
      if (vin > 0) { this.vel[0] -= nx / nl * vin; this.vel[2] -= nz / nl * vin; }
      h = E.groundHeight(ox, oz);
    }
    var wasGround = this.onGround;
    if (this.pos[1] <= h) {
      if (!wasGround && this.vel[1] < -4) {
        var impact = -this.vel[1];
        var cushion = surf.soft > 0.7 ? 0.7 : 1;               // sand, snow and mud soften a landing
        this.landVel = -Math.min(impact * 0.045 * cushion, 0.45);
        if (impact * cushion > 10) { this.stagger = 0.45; this.vel[0] *= 0.4; this.vel[2] *= 0.4; }
        TERRA.events.emit('land', { impact: impact, surface: this.surface });
      }
      this.pos[1] = h; this.vel[1] = Math.max(0, this.vel[1]);
      this.onGround = true;
    } else if (wasGround && !this.swimming && this.vel[1] <= 0 && this.pos[1] - h < 0.45) {
      this.pos[1] = h; this.vel[1] = 0; this.onGround = true;   // stick to ground when walking downhill
    } else {
      this.onGround = this.swimming ? false : this.pos[1] - h < 0.02;
    }
    if (this.swimming && this.pos[1] < h + 0.2) this.pos[1] = h + 0.2;
    // a player can never get stuck under the terrain
    if (this.pos[1] < h - 2) this.pos[1] = h;

    // splash when dropping into water
    if (wasAbove && this.waterLevel > -1e4 && this.pos[1] <= this.waterLevel - 0.3 && this.vel[1] < -2.5) {
      TERRA.events.emit('splash', { pos: [this.pos[0], this.waterLevel, this.pos[2]], strength: U.clamp01(-this.vel[1] / 12) });
    }
    var moved = Math.hypot(this.pos[0] - ox, this.pos[2] - oz);
    this.speed = moved / Math.max(dt, 1e-4);
    // ---- footsteps & head bob
    if (this.onGround && moved > 0.001) {
      var stride = this.sprinting ? 1.45 : (this.crouch > 0.5 ? 0.6 : (this.walkToggle ? 0.75 : 1.05));
      this.stepDist += moved;
      this.bobPhase += moved / stride * Math.PI;
      if (this.stepDist >= stride) {
        this.stepDist -= stride;
        this.foot = 1 - this.foot;
        var side = this.foot ? 0.13 : -0.13;
        var fp = [this.pos[0] + right[0] * side, this.pos[1], this.pos[2] + right[2] * side];
        TERRA.events.emit('footstep', { surface: this.surface, pos: fp, yaw: this.yaw, foot: this.foot, speed: this.speed, sprint: this.sprinting, wet: env.wetness, depth: this.waterDepth });
      }
    } else if (this.swimming && moved > 0.001) {
      this.stepDist += moved;
      if (this.stepDist > 1.6) { this.stepDist = 0; TERRA.events.emit('swimstroke', {}); }
    }
    var bobTarget = ctl.headBob && this.onGround ? U.clamp(this.speed / 5, 0, 1.6) * (this.surface === 'rock' ? 1.25 : (this.surf && this.surf.soft > 0.7 ? 1.1 : 1)) : 0;
    this.bobAmt = U.damp(this.bobAmt, bobTarget, 8, dt);
    // landing spring
    this.landVel += (-this.landDip * 60 - this.landVel * 10) * dt;
    this.landDip += this.landVel * dt;
    this._camera(dt, ctl, env);
  };

  P._free = function (dt, input, fwdH, right) {
    if (input.mouse.wheel) this.freeSpeed = U.clamp(this.freeSpeed * Math.pow(1.25, -input.mouse.wheel), 2, 1500);
    var sp = this.freeSpeed * ((input.down('ShiftLeft') || input.down('ShiftRight')) ? 4 : 1);
    var f = this.forward, mv = [0, 0, 0];
    if (input.down('KeyW')) { mv[0] += f[0]; mv[1] += f[1]; mv[2] += f[2]; }
    if (input.down('KeyS')) { mv[0] -= f[0]; mv[1] -= f[1]; mv[2] -= f[2]; }
    if (input.down('KeyD')) { mv[0] += right[0]; mv[2] += right[2]; }
    if (input.down('KeyA')) { mv[0] -= right[0]; mv[2] -= right[2]; }
    if (input.down('Space') || input.down('KeyE')) mv[1] += 1;
    if (input.down('KeyC') || input.down('ControlLeft') || input.down('KeyQ')) mv[1] -= 1;
    for (var i = 0; i < 3; i++) this.vel[i] = U.damp(this.vel[i], mv[i] * sp, 6, dt);
    this.pos[0] += this.vel[0] * dt; this.pos[1] += this.vel[1] * dt; this.pos[2] += this.vel[2] * dt;
    var h = this.engine.groundHeight(this.pos[0], this.pos[2]);
    if (this.pos[1] < h + 0.3) { this.pos[1] = h + 0.3; this.vel[1] = Math.max(0, this.vel[1]); }
    this.speed = Math.hypot(this.vel[0], this.vel[2]);
    this.onGround = false; this.swimming = false;
  };

  P._collideObjects = function () {
    var veg = this.engine.vegetation;
    if (!veg) return;
    var cols = veg.collidersNear(this.pos[0], this.pos[2], 6);
    for (var i = 0; i < cols.length; i += 4) {
      var dx = this.pos[0] - cols[i], dz = this.pos[2] - cols[i + 1];
      var r = cols[i + 2] + RADIUS;
      var d2 = dx * dx + dz * dz;
      if (d2 < r * r && this.pos[1] < cols[i + 3] + 6) {
        var d = Math.sqrt(d2) || 1e-3;
        var push = (r - d);
        this.pos[0] += dx / d * push; this.pos[2] += dz / d * push;
        // remove velocity into the obstacle
        var vn = (this.vel[0] * dx + this.vel[2] * dz) / d;
        if (vn < 0) { this.vel[0] -= vn * dx / d; this.vel[2] -= vn * dz / d; }
      }
    }
  };

  P._camera = function (dt, ctl, env) {
    var eyeH = U.mix(EYE, EYE_CROUCH, this.crouch);
    if (this.swimming) eyeH = 1.55;
    var bob = this.bobAmt * (this.sprinting ? 0.055 : 0.035);
    var by = Math.abs(Math.sin(this.bobPhase)) * bob - bob * 0.5;
    var bx = Math.cos(this.bobPhase) * bob * 0.6;
    var right = [Math.cos(this.yaw), 0, -Math.sin(this.yaw)];
    // smooth the eye over steps and terrain kinks (never lags a fall or a jump)
    var py = this.pos[1];
    if (this.onGround && !this.swimming && this.smoothY !== undefined && Math.abs(this.smoothY - py) < 0.45 && dt > 0) py = this.smoothY = U.damp(this.smoothY, py, 22, dt);
    else this.smoothY = py;
    var eye = [this.pos[0] + right[0] * bx, py + eyeH + by + this.landDip, this.pos[2] + right[2] * bx];
    if (this.swimming) eye[1] += Math.sin(this.engine.time * 1.6) * 0.03;
    this.eye = eye;
    var fovTarget = (this.sprinting && ctl.motionEffects ? 6 : 0);
    this.fovBoost = U.damp(this.fovBoost, fovTarget, 4, dt);
    if (this.mode === 'third') {
      var f = this.forward;
      var dist = this.tpDist;
      var cp = [eye[0] - f[0] * dist, eye[1] - f[1] * dist + 0.4, eye[2] - f[2] * dist];
      var h = this.engine.groundHeight(cp[0], cp[2]) + 0.5;
      if (cp[1] < h) cp[1] = h;
      this.camPos = cp;
    } else {
      this.camPos = eye;
    }
    var side = this.vel[0] * Math.cos(this.yaw) - this.vel[2] * Math.sin(this.yaw);
    var rollT = this.mode === 'first' && ctl.motionEffects ? U.clamp(-side * 0.004, -0.03, 0.03) : 0;
    this.roll = U.damp(this.roll || 0, rollT, 6, dt);
    if (!(this.roll === this.roll)) this.roll = 0;
  };

  P.serialize = function () { return { pos: this.pos.slice(), yaw: this.yaw, pitch: this.pitch, mode: this.mode }; };
  P.deserialize = function (d) {
    if (!d) return;
    this.pos = d.pos.slice(); this.yaw = this.tYaw = d.yaw || 0; this.pitch = this.tPitch = d.pitch || 0; this.mode = d.mode || 'first';
    this.vel = [0, 0, 0];
  };

  TERRA.game.Player = Player;
})();
