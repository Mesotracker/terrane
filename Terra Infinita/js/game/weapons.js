/* =============================================================================
 * TERRA INFINITA — player weapons
 * -----------------------------------------------------------------------------
 *  - eight procedural weapons (assault rifle, SMG, shotgun, marksman rifle,
 *    light machine gun, pistol, rocket launcher and grenades) with distinct
 *    view models, recoil, spread, penetration and fire modes
 *  - ballistics run through Combat.cast(), so every shot interacts with the
 *    world: walls stop it, glass shatters, thin panels are punched through,
 *    flesh bleeds, helmets deflect and tracers/decal land where they should
 *  - aim down sights, magazine reloads, ammo pools by calibre, weapon sway and
 *    breathing, sprint-to-fire delay, muzzle climb and hit markers
 *  - the view model is lit by the world (it is drawn into the G-buffer), so it
 *    picks up the sun, weather and muzzle flashes like everything else
 * ========================================================================== */
(function () {
  'use strict';
  var U = TERRA.util, M = TERRA.math;
  function combat() { return TERRA.game.Combat.inst || null; }
  function V() { return V3; }
  var V3 = [0, 0, 0], V3b = [0, 0, 0];

  /* ---------------- weapon definitions ---------------- */
  var DEFS = {
    rifle: {
      name: 'AR-15 Pattern Rifle', short: 'RIFLE', mat: '5.56', dmg: 30, rpm: 700, mag: 30, reserve: 240, auto: true,
      spread: [0.0025, 0.012], moveSpread: 0.02, recoil: [0.006, 0.0026, 0.0009], range: 420, pen: 1.0, snd: 'shot',
      ads: 0.22, adsFov: 0.55, reload: 2.3, tracer: [1, 0.86, 0.5], shells: 2
    },
    smg: {
      name: 'Compact SMG', short: 'SMG', mat: '9 mm', dmg: 20, rpm: 880, mag: 32, reserve: 320, auto: true,
      spread: [0.0035, 0.017], moveSpread: 0.016, recoil: [0.005, 0.0022, 0.0012], range: 180, pen: 0.85, snd: 'shot',
      ads: 0.18, adsFov: 0.7, reload: 1.9, tracer: [1, 0.88, 0.55], shells: 2
    },
    shotgun: {
      name: 'Pump Shotgun', short: 'SHOTGUN', mat: '12 ga', dmg: 13, rpm: 75, mag: 7, reserve: 56, auto: false,
      pellets: 9, spread: [0.022, 0.035], moveSpread: 0.01, recoil: [0.018, 0.004, 0.002], range: 90, pen: 0.7, snd: 'shotHeavy',
      ads: 0.24, adsFov: 0.8, reload: 3.4, tracer: [1, 0.8, 0.45], shells: 1
    },
    marksman: {
      name: 'Marksman Rifle', short: 'DMR', mat: '7.62', dmg: 62, rpm: 110, mag: 20, reserve: 140, auto: false,
      spread: [0.0012, 0.008], moveSpread: 0.03, recoil: [0.013, 0.004, 0.002], range: 700, pen: 1.5, snd: 'shotHeavy',
      ads: 0.3, adsFov: 0.35, reload: 2.7, tracer: [1, 0.9, 0.6], shells: 1
    },
    lmg: {
      name: 'Light Machine Gun', short: 'LMG', mat: '7.62', dmg: 34, rpm: 720, mag: 100, reserve: 300, auto: true,
      spread: [0.004, 0.02], moveSpread: 0.045, recoil: [0.008, 0.003, 0.0016], range: 480, pen: 1.25, snd: 'shotHeavy',
      ads: 0.34, adsFov: 0.62, reload: 5.2, tracer: [1, 0.84, 0.48], shells: 2
    },
    pistol: {
      name: 'Service Pistol', short: 'PISTOL', mat: '9 mm', dmg: 26, rpm: 420, mag: 15, reserve: 90, auto: false,
      spread: [0.004, 0.018], moveSpread: 0.014, recoil: [0.008, 0.0022, 0.001], range: 120, pen: 0.7, snd: 'shot',
      ads: 0.14, adsFov: 0.82, reload: 1.6, tracer: [1, 0.86, 0.5], shells: 1
    },
    launcher: {
      name: 'Rocket Launcher', short: 'RPG', mat: 'RPG', dmg: 120, rpm: 40, mag: 1, reserve: 6, auto: false,
      spread: [0.004, 0.01], moveSpread: 0.02, recoil: [0.05, 0.006, 0.004], range: 900, pen: 0, snd: 'shotHeavy',
      ads: 0.3, adsFov: 0.7, reload: 4.2, tracer: [1, 0.7, 0.3], rocket: 5, shells: 0
    }
  };
  var ORDER = ['rifle', 'smg', 'shotgun', 'marksman', 'lmg', 'pistol', 'launcher'];

  function Weapons(engine) {
    this.E = engine;
    var G = engine.renderer.G, S = TERRA.shaders;
    this.G = G; this.gl = G.gl;
    this.prog = G.program('weaponView', S.cmbVS, S.cmbFS);
    this.cur = 'rifle';
    this.ammo = {};
    for (var k in DEFS) this.ammo[k] = { mag: DEFS[k].mag, reserve: DEFS[k].reserve };
    this.rockets = [];
    this.anim = { ads: 0, kick: 0, kickV: 0, sway: [0, 0], swayV: [0, 0], bob: 0, reload: 0, switch: 0, raise: 1 };
    this.recoilPitch = 0; this.recoilYaw = 0;
    this.fireT = 0; this.reloadT = 0; this.burst = 0; this.muzzleT = 0;
    this.ads = false; this.lastShot = 0; this.shellT = 0;
    this.hitMarker = 0; this.hitKill = 0;
    this.hud = { name: DEFS.rifle.name, short: 'RIFLE', mag: 30, magMax: 30, reserve: 240, mode: 'AUTO', reloading: 0, ads: 0, spread: 0 };
    this.meshes = {};
    this.stats = { shots: 0, hits: 0, kills: 0 };
  }
  var P = Weapons.prototype;

  P.configure = function (g) {
    this.quality = g.combatDetail === undefined ? 2 : g.combatDetail;
    this.enabled = this.quality > 0;
    if (!this.enabled) return;
    this.maxGrenades = [0, 2, 4, 5][U.clamp(this.quality, 0, 3)];
    if (this.grenadeCount === undefined) this.grenadeCount = this.maxGrenades;
  };
  P.clear = function () { this.rockets.length = 0; };
  P.reset = P.clear;

  P.def = function () { return DEFS[this.cur]; };

  /* ---------------- view models ---------------- */
  P.mesh = function (key) {
    var m = this.meshes[key];
    if (m) return m;
    var CM = TERRA.game.Combat, g = new CM.CGeo();
    var d = DEFS[key];
    var dark = [38, 38, 40], poly = [62, 60, 54], steel = [52, 52, 56], wood = [104, 72, 44];
    function part(c, hh, mat, col, edge) {
      g.box(c, hh, { mat: mat, col: col, uvScale: 2.4, edge: edge === undefined ? 200 : edge, wear: 16 });
    }
    // All view models sit in a right-handed frame: -Z is forward, +X right, +Y up.
    // The receiver spans the middle, the stock heads back toward the shooter.
    var L = key === 'pistol' ? 0.16 : (key === 'smg' ? 0.34 : (key === 'shotgun' ? 0.52 : (key === 'marksman' ? 0.58 : (key === 'lmg' ? 0.55 : (key === 'launcher' ? 0.75 : 0.46)))));
    var barrelR = key === 'pistol' ? 0.011 : 0.013;
    part([0, 0, -L * 0.5], [0.022, 0.032, L * 0.5], CM.CMAT.METAL, dark);
    part([0, 0.004, -L * 0.5 - 0.02], [0.018, 0.024, L * 0.5 * 0.9], CM.CMAT.PAINT, poly);
    // barrel
    g.cylinder([0, 0.008, -L * 0.5 - 0.04], [0, 0.008, -L - (key === 'marksman' ? 0.34 : 0.16)], barrelR, barrelR * 0.85, 8, { mat: CM.CMAT.STEEL, col: steel });
    g.cylinder([0, 0.008, -L - (key === 'marksman' ? 0.33 : 0.15)], [0, 0.008, -L - (key === 'marksman' ? 0.38 : 0.2)], barrelR * 1.5, barrelR * 1.7, 8, { mat: CM.CMAT.STEEL, col: [30, 30, 32] });
    // handguard / pump
    if (key !== 'pistol') part([0, -0.006, -L * 0.62], [0.024, 0.022, L * 0.34], key === 'shotgun' ? CM.CMAT.PLANK : CM.CMAT.METAL, key === 'shotgun' ? wood : poly);
    // magazine
    if (key !== 'launcher') part([0, -0.062, -L * 0.24], [0.017, 0.05, 0.03], CM.CMAT.METAL, [32, 32, 34], 230);
    else g.cylinder([0.0, 0.02, -L * 0.55], [0.0, 0.02, -L * 0.75], 0.045, 0.045, 10, { mat: CM.CMAT.METAL, col: [70, 72, 58] });
    // pistol grip + trigger guard
    part([0, -0.058, -0.02], [0.016, 0.042, 0.022], CM.CMAT.PAINT, [34, 34, 34]);
    part([0, -0.032, -0.055], [0.015, 0.005, 0.03], CM.CMAT.METAL, [30, 30, 30], 150);
    // stock
    if (key !== 'pistol') {
      part([0, -0.01, 0.06], [0.016, 0.024, 0.065], CM.CMAT.PAINT, key === 'marksman' ? wood : poly);
      part([0, 0.014, 0.1], [0.018, 0.03, 0.02], CM.CMAT.PAINT, [30, 30, 30]);
    }
    // optic
    if (key === 'marksman' || key === 'rifle' || key === 'lmg') {
      part([0, 0.05, -L * 0.42], [0.011, 0.007, 0.05], CM.CMAT.STEEL, [36, 36, 38]);
      part([0, 0.072, -L * 0.42], [0.019, 0.024, 0.055], CM.CMAT.METAL, [26, 26, 28]);
      g.cylinder([0, 0.072, -L * 0.42 + 0.055], [0, 0.072, -L * 0.42 + 0.075], 0.02, 0.022, 8, { mat: CM.CMAT.CANVAS, col: [22, 22, 24] });
      g.cylinder([0, 0.072, -L * 0.42 - 0.055], [0, 0.072, -L * 0.42 - 0.07], 0.018, 0.016, 8, { mat: CM.CMAT.LENS, col: [26, 54, 64] });
    }
    if (key === 'shotgun') g.cylinder([0, -0.026, -L * 0.55], [0, -0.026, -L * 0.95], 0.012, 0.012, 8, { mat: CM.CMAT.METAL, col: [40, 40, 42] });
    if (key === 'lmg') {   // drum + bipod
      g.cylinder([0.05, -0.05, -L * 0.45], [-0.05, -0.05, -L * 0.45], 0.07, 0.07, 10, { mat: CM.CMAT.METAL, col: [40, 40, 42], caps: true });
      g.cylinder([0, -0.03, -L - 0.05], [-0.04, -0.12, -L - 0.02], 0.007, 0.007, 5, { mat: CM.CMAT.STEEL, col: [50, 50, 52] });
      g.cylinder([0, -0.03, -L - 0.05], [0.04, -0.12, -L - 0.02], 0.007, 0.007, 5, { mat: CM.CMAT.STEEL, col: [50, 50, 52] });
    }
    if (key === 'launcher') {  // cone + warhead
      g.cylinder([0, 0.02, -L - 0.02], [0, 0.02, -L - 0.16], 0.055, 0.075, 10, { mat: CM.CMAT.RUST, col: [120, 84, 56] });
      g.cylinder([0, 0.02, -L - 0.16], [0, 0.02, -L - 0.3], 0.075, 0.02, 10, { mat: CM.CMAT.RUST, col: [126, 90, 60] });
    }
    // hand / glove around the grip so the weapon reads as held
    var hand = new CM.CGeo();
    hand.box([0, -0.05, -0.03], [0.03, 0.032, 0.036], { mat: CM.CMAT.RUBBER, col: [54, 48, 42], uvScale: 3, edge: 190 });
    hand.box([0.006, -0.03, -L * 0.6], [0.028, 0.026, 0.04], { mat: CM.CMAT.RUBBER, col: [54, 48, 42], uvScale: 3, edge: 190 });
    hand.box([-0.005, -0.062, -0.02], [0.024, 0.022, 0.03], { mat: CM.CMAT.CLOTH, col: [150, 146, 128], uvScale: 3, edge: 200 });
    g.append(hand, [0, 0, 0]);
    m = TERRA.game.Combat.upload(this.G, g);
    m.geo = g;
    this.meshes[key] = m;
    return m;
  };

  P.reset_meshes = function () {
    var gl = this.gl;
    for (var k in this.meshes) if (this.meshes[k]) gl.deleteVertexArray(this.meshes[k].vao);
    this.meshes = {};
  };

  /* ---------------- input + update ---------------- */
  P.update = function (frame) {
    var E = this.E, pl = E.player, inp = E.input, def = this.def(), a = this.ammo[this.cur];
    if (!this.enabled || E.state !== 'playing' || E.editor.active || (E.vehicles && E.vehicles.current)) { this.hudUpdate(); return; }
    var st = E.settings.controls, dt = frame.dt;
    this.fireT -= dt; this.reloadT -= dt; this.switchT = (this.switchT || 0) - dt;
    this.muzzleT -= dt; this.shellT -= dt; this.hitMarker = Math.max(0, this.hitMarker - dt); this.hitKill = Math.max(0, this.hitKill - dt);
    // weapon switching (mouse wheel + number row when the tool keys are free)
    var wheel = inp.mouse.wheel || 0;
    if (wheel) {
      var i = ORDER.indexOf(this.cur);
      i = (i + (wheel > 0 ? 1 : -1) + ORDER.length) % ORDER.length;
      this.select(ORDER[i]);
      inp.mouse.wheel = 0;
    }
    for (var d = 0; d < ORDER.length; d++) {
      if (inp.hit('Digit' + (d + 1 + 6)) || (inp.hit('Digit' + (d + 1)) && inp.down('AltLeft'))) this.select(ORDER[d]);
    }
    if (inp.hit('KeyR') || (a.mag <= 0 && this.fireT < -0.3)) this.reload();
    var wantAds = !pl.sprinting && (inp.down('MouseRight') || inp.down('ShiftRight'));
    this.ads = wantAds && this.reloadT <= 0;
    this.anim.ads = U.damp(this.anim.ads, this.ads ? 1 : 0, 12, dt);
    var canFire = this.reloadT <= 0 && this.switchT <= 0 && this.fireT <= 0 && a.mag > 0;
    var firing = def.auto ? inp.down('MouseLeft') : inp.hit('MouseLeft');
    if (this.ads) firing = def.auto ? inp.down('MouseLeft') : inp.hit('MouseLeft');
    if (firing && canFire) this.fire();
    if (firing && (a.mag <= 0 || this.reloadT > 0) && this.fireT <= 0 && this.dryT !== frame.time) {
      this.dryT = frame.time; this.fireT = 0.35;
      var C = combat(); if (C) C.sfx('dry', pl.eye, 0.4);
    }
    // grenade throw on G
    if (inp.hit('KeyG') && this.reloadT <= 0) this.throwGrenade();
    this.updateView(dt, frame);
    this.updateProjectiles(dt, frame);
    this.hudUpdate();
  };

  P.select = function (key) {
    if (!DEFS[key] || key === this.cur) return;
    var E = this.E, C = combat();
    this.cur = key;
    this.switchT = 0.45;
    this.reloadT = 0;
    this.anim.raise = 0;
    if (C) C.sfx('bolt', E.player.eye, 0.4);
  };

  P.reload = function () {
    var a = this.ammo[this.cur], def = this.def();
    if (this.reloadT > 0 || a.mag >= def.mag || a.reserve <= 0) return;
    this.reloadT = def.reload;
    this.anim.reload = 1;
    var C = combat();
    if (C) C.sfx('reload', this.E.player.eye, 0.6);
  };

  P.fire = function () {
    var E = this.E, pl = E.player, def = this.def(), a = this.ammo[this.cur], C = combat();
    if (!C) return;
    var spread = U.mix(def.spread[0], def.spread[1], U.clamp01((this.stats.shots % 12) / 12));
    spread += def.moveSpread * U.clamp(Math.hypot(pl.vel[0], pl.vel[2]) / 5.5, 0, 1);
    if (pl.crouch) spread *= 0.75;
    if (!pl.onGround) spread *= 2.2;
    if (this.ads) spread *= 0.35;
    if (pl.stamina < 0.35) spread *= 1.5;
    this.lastSpread = spread;
    var pellets = def.pellets || 1;
    var muzzle = this.muzzleWorld();
    var dir0 = this.aimDir();
    for (var i = 0; i < pellets; i++) {
      var dir = this.scatter(dir0, pellets > 1 ? def.spread[1] : spread);
      this.trace(muzzle, dir, def);
    }
    // mechanics
    a.mag--;
    this.stats.shots++;
    this.fireT = 60 / def.rpm;
    this.anim.kickV += def.recoil[0] * (this.ads ? 0.7 : 1);
    this.anim.kickV += def.recoil[1] * (Math.random() - 0.3);
    var dirYaw = (Math.random() - 0.5) * def.recoil[2] * 2;
    this.recoilPitch += def.recoil[0] * 42;
    this.recoilYaw += dirYaw * 42;
    this.muzzleT = 0.045;
    if (def.shells) this.shellT = 0.4;
    // muzzle flash: light, smoke, flash quad, shell
    var fx = E.effects;
    if (fx) {
      C.tracers.flash(muzzle, 0.2 + Math.random() * 0.08, [1.0, 0.8, 0.45], 0.04);
      fx.lights.push({ pos: [muzzle[0], muzzle[1], muzzle[2]], color: [4.5, 3.0, 1.2], radius: 8, age: 0, life: 0.05 });
      fx.emit(TERRA.game.Effects.K.SMOKE, muzzle, [dir0[0] * 3.4, dir0[1] * 3.4 + 1, dir0[2] * 3.4], 0.5, 0.1, 0.9, [0.72, 0.72, 0.7], 0.06);
      fx.emit(TERRA.game.Effects.K.SPARK, muzzle, [dir0[0] * 7, dir0[1] * 7, dir0[2] * 7], 0.06, 0.02, 0, [1, 0.85, 0.5], 1);
      if (def.shells) {
        var right = this.rightVec();
        fx.emit(TERRA.game.Effects.K.CHIP, [pl.eye[0] + right[0] * 0.2, pl.eye[1] - 0.05, pl.eye[2] + right[2] * 0.2],
          [right[0] * 3 + (Math.random() - 0.5), 2 + Math.random(), right[2] * 3 + (Math.random() - 0.5)], 1.4, 0.02, 0, [0.72, 0.55, 0.25], 1, 3);
      }
    }
    C.sfx(def.snd, muzzle, 1, def.dmg / 30);
    if (E.effects) E.effects.shake = Math.min(0.6, (E.effects.shake || 0) + def.recoil[0] * 4);
    if (def.rocket) {
      this.launchRocket(muzzle, dir0, def);
      a.mag = 0;
      this.reload();
    }
  };

  /** One bullet: walks through thin cover, damages what it hits. */
  P.trace = function (origin, dir, def) {
    var E = this.E, C = combat();
    var t = 0, penLeft = def.pen, guard = 0;
    var points = [];
    while (guard++ < 4) {
      var hit = C.cast([origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t], dir, def.range - t, { skip: ['player'] });
      if (!hit) { points.push([origin[0] + dir[0] * def.range, origin[1] + dir[1] * def.range, origin[2] + dir[2] * def.range]); break; }
      points.push(hit.p);
      var matName = hit.surface || 'dirt';
      var dmg = def.dmg * (1 - U.clamp01(t / (def.range * 1.4)) * 0.5);
      if (hit.type === 'terrain' || hit.type === 'objective') {
        C.impact(hit);
      } else {
        C.applyDamage(hit, dmg, { source: E.player, team: 0, dmgType: 'bullet' });
        C.impact(hit, { decalSize: hit.type === 'terrain' ? 0.45 : 0.22 });
        if (hit.type === 'soldier' || hit.type === 'gvehicle') {
          this.hitMarker = 0.22; this.stats.hits++;
          if (hit.type === 'gvehicle') {
            // armour: only penetrating rounds get the full marker
            if (!hit.part || !hit.part.destroyed) this.hitMarker = 0.14;
            if (hit.ref && hit.ref.dead) { this.hitKill = 0.6; this.stats.kills++; }
          } else if (hit.ref && hit.ref.dead) { this.hitKill = 0.5; this.stats.kills++; }
        }
        if (hit.type === 'soldier' || hit.type === 'player' || hit.type === 'gvehicle') break;
      }
      // armour: how much punch is left after passing through this material
      var ARM = TERRA.game.Combat.ARMOR[matName];
      var cost = ARM ? ARM.cost * 0.05 : 4;
      penLeft -= cost;
      if (penLeft <= 0 || hit.type === 'soldier') break;
      t += hit.t + 0.06;
      if (t > def.range) break;
    }
    if (points.length > 1) {
      var C2 = combat();
      for (var i = 0; i < points.length - 1; i++) C2.tracers.streak(points[i], points[i + 1], def.tracer, 0.045, 0.012);
    } else if (points.length === 1) {
      C.tracers.streak(origin, points[0], def.tracer, 0.04, 0.012);
    }
  };

  /* ---------------- rockets ---------------- */
  P.launchRocket = function (pos, dir, def) {
    this.rockets.push({ pos: [pos[0] + dir[0] * 0.5, pos[1] + dir[1] * 0.5, pos[2] + dir[2] * 0.5], dir: dir.slice(0), vel: 78, life: 6, power: def.rocket, smoke: 0 });
  };
  P.updateProjectiles = function (dt, frame) {
    var E = this.E, C = combat(), fx = E.effects;
    for (var i = this.rockets.length - 1; i >= 0; i--) {
      var r = this.rockets[i];
      r.life -= dt;
      var speed = r.vel;
      var step = Math.min(1, speed * dt);
      var hit = C ? C.cast(r.pos, r.dir, step + 0.3, { skip: ['player'] }) : null;
      if (hit) {
        C.explode(hit.p, r.power, { source: E.player, team: 0, terrain: true });
        this.rockets.splice(i, 1);
        if (fx) fx.shake = Math.max(fx.shake || 0, 0.5);
        continue;
      }
      r.pos[0] += r.dir[0] * step; r.pos[1] += r.dir[1] * step; r.pos[2] += r.dir[2] * step;
      r.dir[1] -= 0.06 * dt;                      // a little drop over distance
      var dl = Math.hypot(r.dir[0], r.dir[1], r.dir[2]) || 1;
      r.dir[0] /= dl; r.dir[1] /= dl; r.dir[2] /= dl;
      r.smoke -= dt;
      if (fx && r.smoke <= 0) {
        r.smoke = 0.012;
        fx.emit(TERRA.game.Effects.K.SMOKE, r.pos, [0, 0, 0], 1.4, 0.22, 1.2, [0.75, 0.75, 0.74], 0.35);
        fx.emit(TERRA.game.Effects.K.FIRE, [r.pos[0] - r.dir[0] * 0.4, r.pos[1] - r.dir[1] * 0.4, r.pos[2] - r.dir[2] * 0.4], [0, 0.4, 0], 0.12, 0.14, 0.6, [1, 0.6, 0.25], 0.8);
      }
      if (r.life <= 0 || r.pos[1] < E.groundHeight(r.pos[0], r.pos[2]) - 0.5) {
        if (C) C.explode([r.pos[0], Math.max(r.pos[1], E.groundHeight(r.pos[0], r.pos[2]) + 0.2), r.pos[2]], r.power, { source: E.player, team: 0 });
        this.rockets.splice(i, 1);
      }
    }
    void frame;
  };

  /* ---------------- grenades ---------------- */
  P.throwGrenade = function () {
    var E = this.E, C = combat();
    if (this.grenades === undefined) this.grenades = [], this.grenadeCount = 4;
    if (this.grenadeCount <= 0) return;
    this.grenadeCount--;
    var eye = E.player.eye, d = this.aimDir();
    this.grenades.push({
      pos: [eye[0] + d[0] * 0.5, eye[1] + d[1] * 0.5 - 0.1, eye[2] + d[2] * 0.5],
      vel: [d[0] * 18, d[1] * 18 + 3.4, d[2] * 18], fuse: 3.4, spin: Math.random() * 6
    });
    if (C) C.sfx('cloth', eye, 0.5);
  };
  P.updateGrenades = function (dt, frame) {
    if (!this.grenades) return;
    var E = this.E, C = combat();
    for (var i = this.grenades.length - 1; i >= 0; i--) {
      var gr = this.grenades[i];
      gr.fuse -= dt;
      gr.vel[1] -= 22 * dt;
      var nx = gr.pos[0] + gr.vel[0] * dt, ny = gr.pos[1] + gr.vel[1] * dt, nz = gr.pos[2] + gr.vel[2] * dt;
      var gh = E.groundHeight(nx, nz);
      var B = E.buildings;
      if (B && B.list && B.list.length) {
        var fh = B.floorHeight(nx, nz, ny, 0.5);
        if (fh > gh - 0.4 && fh > ny - 0.2 && fh < ny + 0.6) { gh = fh; }
      }
      if (ny <= gh + 0.12) {
        ny = gh + 0.12;
        gr.vel[1] = Math.abs(gr.vel[1]) * 0.28;
        gr.vel[0] *= 0.55; gr.vel[2] *= 0.55;
        if (Math.abs(gr.vel[1]) < 0.6) gr.vel[1] = 0;
      }
      gr.pos[0] = nx; gr.pos[1] = ny; gr.pos[2] = nz;
      if (gr.fuse <= 0) {
        if (C) C.explode(gr.pos, 2.6, { source: E.player, team: 0, terrain: true });
        this.grenades.splice(i, 1);
        if (E.effects) E.effects.shake = Math.max(E.effects.shake || 0, 0.4);
      }
    }
    void frame;
  };

  /* ---------------- view model transform ---------------- */
  P.forwardVec = function () { var f = this.E.player.forward; return [f[0], f[1], f[2]]; };
  P.rightVec = function () {
    var f = this.E.player.forward;
    var r = [f[2], 0, -f[0]];
    var l = Math.hypot(r[0], r[2]) || 1;
    return [r[0] / l, r[1], r[2] / l];
  };
  P.upVec = function () {
    var f = this.forwardVec(), r = this.rightVec();
    var u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    return u;
  };
  P.aimDir = function () {
    var f = this.forwardVec();
    var l = Math.hypot(f[0], f[1], f[2]) || 1;
    return [f[0] / l, f[1] / l, f[2] / l];
  };
  P.muzzleWorld = function () {
    var eye = this.E.player.eye, f = this.forwardVec(), r = this.rightVec(), u = this.upVec();
    var def = this.def(), off = def.rocket ? 0.9 : 0.72;
    var side = def.rocket ? 0.22 : 0.14;
    return [eye[0] + f[0] * off + r[0] * side - u[0] * 0.08,
      eye[1] + f[1] * off + r[1] * side - u[1] * 0.08,
      eye[2] + f[2] * off + r[2] * side - u[2] * 0.08];
  };
  P.scatter = function (dir, spread) {
    var a = Math.random() * Math.PI * 2, e = spread * (Math.random() + Math.random() - 1) * 0.7;
    var r = this.rightVec(), u = this.upVec(), ca = Math.cos(e), sa = Math.sin(e);
    var d = [dir[0] * ca + (r[0] * Math.cos(a) + u[0] * Math.sin(a)) * sa,
      dir[1] * ca + (r[1] * Math.cos(a) + u[1] * Math.sin(a)) * sa,
      dir[2] * ca + (r[2] * Math.cos(a) + u[2] * Math.sin(a)) * sa];
    var l = Math.hypot(d[0], d[1], d[2]) || 1;
    return [d[0] / l, d[1] / l, d[2] / l];
  };

  P.updateView = function (dt, frame) {
    var pl = this.E.player, a = this.anim;
    // spring the recoil kick back to rest
    a.kickV -= a.kick * 60 * dt; a.kickV *= Math.max(0, 1 - dt * 9); a.kick += a.kickV * dt * 6;
    a.kick = U.clamp(a.kick, -0.05, 0.16);
    // sway: the weapon lags the camera
    var yawRate = (pl.yaw - (this._ly || pl.yaw)) / Math.max(1e-3, dt);
    var pitchRate = (pl.pitch - (this._lp || pl.pitch)) / Math.max(1e-3, dt);
    this._ly = pl.yaw; this._lp = pl.pitch;
    a.swayV[0] += (-yawRate * 0.02 - a.sway[0] * 9) * dt;
    a.swayV[1] += (pitchRate * 0.02 - a.sway[1] * 9) * dt;
    a.sway[0] += a.swayV[0] * dt * 6; a.sway[1] += a.swayV[1] * dt * 6;
    a.sway[0] = U.clamp(a.sway[0], -0.06, 0.06); a.sway[1] = U.clamp(a.sway[1], -0.06, 0.06);
    // walk bob + breathing
    var speed = Math.hypot(pl.vel[0], pl.vel[2]);
    a.bob += dt * (2.2 + speed * 1.35);
    var amt = U.clamp(speed / 5.5, 0, 1) * (1 - a.ads * 0.75) * (pl.onGround ? 1 : 0.2);
    a.bobX = Math.cos(a.bob) * 0.014 * amt;
    a.bobY = Math.abs(Math.sin(a.bob)) * 0.012 * amt;
    this.breath = Math.sin(this.E.time * 1.5) * 0.0015 * (1 - a.ads * 0.6);
    a.raise = U.damp(a.raise, 1, 6, dt);
    if (a.reload > 0) a.reload = Math.max(0, a.reload - dt / Math.max(0.4, this.def().reload));
    var rl = Math.sin(U.clamp01(1 - a.reload) * Math.PI);
    a.reloadDip = rl * 0.16;
    a.reloadRoll = rl * 0.5;
    if (this.recoilPitch || this.recoilYaw) {
      var rec = Math.min(Math.abs(this.recoilPitch), 260 * dt);
      var ry = Math.min(Math.abs(this.recoilYaw), 260 * dt);
      pl.pitch = U.clamp(pl.pitch + Math.sign(this.recoilPitch) * rec, -1.5, 1.5);
      pl.yaw += Math.sign(this.recoilYaw) * ry;
      this.recoilPitch -= Math.sign(this.recoilPitch) * rec;
      this.recoilYaw -= Math.sign(this.recoilYaw) * ry;
    }
    void frame;
  };

  /** Model matrix for the view model: camera space, -Z forward. */
  P.viewMatrix = function (out) {
    var pl = this.E.player, eye = pl.eye, f = this.forwardVec(), r = this.rightVec(), u = this.upVec(), a = this.anim;
    var zz = [-f[0], -f[1], -f[2]];
    var ads = a.ads;
    // rest pose: low right, angled in; aiming: centred, slightly raised
    var px = U.mix(0.145, 0.0, ads) + a.sway[0] + (a.bobX || 0);
    var py = U.mix(-0.155, -0.075, ads) + a.sway[1] + (a.bobY || 0) + this.breath - a.reloadDip + a.kick * 0.4;
    var pz = U.mix(0.42, 0.34, ads) - a.kick * 0.9 - a.raise * 0.0;
    var off = 0.48 * (1 - a.raise);
    out[0] = r[0]; out[1] = r[1]; out[2] = r[2]; out[3] = 0;
    // rotate the model frame slightly inward and down so it reads as shouldered
    var tilt = U.mix(0.06, 0.0, ads), cant = U.mix(-0.05, 0.0, ads) + a.reloadRoll * 0.4;
    var u2 = [u[0] + zz[0] * tilt, u[1] + zz[1] * tilt, u[2] + zz[2] * tilt];
    var r2 = [r[0] + u[0] * cant, r[1] + u[1] * cant, r[2] + u[2] * cant];
    var l2 = Math.hypot(r2[0], r2[1], r2[2]) || 1;
    out[0] = r2[0] / l2; out[1] = r2[1] / l2; out[2] = r2[2] / l2;
    out[4] = u2[0]; out[5] = u2[1]; out[6] = u2[2];
    out[8] = zz[0]; out[9] = zz[1]; out[10] = zz[2];
    out[12] = eye[0] + r[0] * px + u2[0] * py + zz[0] * (pz - off);
    out[13] = eye[1] + r[1] * px + u2[1] * py + zz[1] * (pz - off);
    out[14] = eye[2] + r[2] * px + u2[2] * py + zz[2] * (pz - off);
    out[15] = 1;
    return out;
  };

  /* ---------------- drawing ---------------- */
  P.draw = function (frame, shadow) {
    if (shadow) return;                       // the view model is never in world shadows
    var E = this.E;
    if (!this.enabled || E.state !== 'playing' || (E.vehicles && E.vehicles.current) || E.player.mode === 'free') return;
    var gl = this.gl, R = E.renderer, mesh = this.mesh(this.cur), def = this.def();
    var p = this.prog.use();
    p.tex('uAlbedoH', 0, R.tex.matAlbedo, gl.TEXTURE_2D_ARRAY);
    if (this.quality >= 2 || this.quality === undefined) p.tex('uNormalR', 1, R.tex.matNormal, gl.TEXTURE_2D_ARRAY);
    else p.tex('uNormalR', 1, R.tex.black, gl.TEXTURE_2D_ARRAY);
    var m = this._vm || (this._vm = M.mat4());
    this.viewMatrix(m);
    // render space: the camera sits at frame.cam.pos, the eye offset is in world units
    m[12] -= frame.origin[0]; m[14] -= frame.origin[1];
    p.m4('uModel', m);
    p.f('uWet', frame.env.wetness * 0.5).f('uSnow', 0).f('uNight', 1 - frame.env.dayFactor)
      .v3('uSun', frame.env.lightDir[0], frame.env.lightDir[1], frame.env.lightDir[2])
      .v3('uTint', 1, 1, 1);
    // the view model must never be clipped by geometry the player stands in
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(mesh.vao);
    gl.drawElements(gl.TRIANGLES, mesh.count, mesh.indexType, 0);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    R.G.stats.drawCalls++; R.G.stats.triangles += mesh.tris;
    // grenades in flight (simple proxy boxes through the same program)
    void def;
  };

  P.drawGrenades = function (frame) {
    if (!this.grenades || !this.grenades.length) return;
    var gl = this.gl, R = this.E.renderer;
    var p = this.prog.use();
    p.tex('uAlbedoH', 0, R.tex.matAlbedo, gl.TEXTURE_2D_ARRAY);
    p.tex('uNormalR', 1, R.tex.matNormal, gl.TEXTURE_2D_ARRAY);
    var m = this._gm || (this._gm = M.mat4());
    if (!this._gmesh) {
      var CM = TERRA.game.Combat, g = new CM.CGeo();
      g.box([0, 0, 0], [0.032, 0.05, 0.032], { mat: CM.CMAT.METAL, col: [58, 66, 52], uvScale: 6, edge: 210, wear: 40 });
      g.box([0, 0.055, 0], [0.018, 0.012, 0.018], { mat: CM.CMAT.STEEL, col: [70, 70, 72], uvScale: 6, edge: 210 });
      this._gmesh = CM.upload(this.G, g);
    }
    for (var i = 0; i < this.grenades.length; i++) {
      var gr = this.grenades[i];
      M.identity(m);
      var yaw = gr.spin + this.E.time * 6;
      var cy = Math.cos(yaw), sy = Math.sin(yaw);
      var cp = Math.cos(gr.spin * 0.7), sp = Math.sin(gr.spin * 0.7);
      m[0] = cy * cp; m[1] = sy * sp; m[2] = -sy * cp; m[4] = 0; m[5] = cp; m[6] = sp;
      m[8] = sy * cp; m[9] = -cy * sp; m[10] = cy * cp;
      m[12] = gr.pos[0] - frame.origin[0]; m[13] = gr.pos[1]; m[14] = gr.pos[2] - frame.origin[1];
      p.m4('uModel', m);
      p.f('uWet', 0).f('uSnow', 0).f('uNight', 1 - frame.env.dayFactor)
        .v3('uSun', frame.env.lightDir[0], frame.env.lightDir[1], frame.env.lightDir[2]).v3('uTint', 1, 1, 1);
      gl.bindVertexArray(this._gmesh.vao);
      gl.drawElements(gl.TRIANGLES, this._gmesh.count, this._gmesh.indexType, 0);
      R.G.stats.drawCalls++;
    }
    gl.bindVertexArray(null);
  };

  /* ---------------- HUD state ---------------- */
  P.hudUpdate = function () {
    var def = this.def(), a = this.ammo[this.cur], h = this.hud;
    h.name = def.name; h.short = def.short; h.mat = def.mat;
    h.mag = a.mag; h.magMax = def.mag; h.reserve = a.reserve;
    h.mode = def.auto ? 'AUTO' : (def.pellets ? 'PUMP' : 'SEMI');
    h.reloading = this.reloadT > 0 ? 1 - this.reloadT / def.reload : 0;
    h.ads = this.anim.ads;
    h.spread = U.clamp01((this.lastSpread || def.spread[0]) / 0.03);
    h.grenades = this.grenadeCount === undefined ? 3 : this.grenadeCount;
    h.hitMarker = this.hitMarker; h.hitKill = this.hitKill;
    h.rockets = this.rockets.length;
  };

  P.serialize = function () {
    return { cur: this.cur, ammo: JSON.parse(JSON.stringify(this.ammo)), grenades: this.grenadeCount === undefined ? 3 : this.grenadeCount };
  };
  P.deserialize = function (d) {
    if (!d) return;
    if (d.cur && DEFS[d.cur]) this.cur = d.cur;
    if (d.ammo) for (var k in d.ammo) if (this.ammo[k]) this.ammo[k] = d.ammo[k];
    if (d.grenades !== undefined) this.grenadeCount = d.grenades;
  };

  Weapons.DEFS = DEFS;
  Weapons.ORDER = ORDER;
  TERRA.game.Weapons = Weapons;
})();
