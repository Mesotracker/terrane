/* =============================================================================
 * TERRA INFINITA — soldiers: AI, squads, skinned rendering and small-arms fire
 * -----------------------------------------------------------------------------
 *  - soldiers stream in around the player (settlement garrisons, road patrols,
 *    wilderness recon), fight, take cover, reload, flank, suppress and die
 *  - navigation walks the real world: terrain height, edited craters, building
 *    floors and stairs, wall collision, tree trunks
 *  - ballistics go through Combat.cast(), so walls stop bullets, glass shatters,
 *    thin panels are punched through and explosions hurt whoever is exposed
 *  - every soldier is one instance of a shared skinned mesh; all bone matrices
 *    live in a single float texture, so a squad is a handful of draw calls
 * ========================================================================== */
(function () {
  'use strict';
  var U = TERRA.util, M = TERRA.math, CH = null;
  function chars() { return CH || (CH = TERRA.game.Characters); }
  function combat() { return TERRA.game.Combat && TERRA.game.Combat.inst ? TERRA.game.Combat.inst : null; }

  var CLASSES = ['rifle', 'heavy', 'officer', 'marksman', 'scout', 'crew'];
  var WEAPONS = {
    rifle: { dmg: 21, rpm: 620, mag: 30, spread: 0.012, moveSpread: 0.03, reload: 2.6, burst: [2, 5], range: 320, snd: 'shot', tracer: [1.0, 0.82, 0.45], speed: 880, kick: 0.22, pen: 1.0 },
    smg: { dmg: 17, rpm: 780, mag: 25, spread: 0.018, moveSpread: 0.035, reload: 2.3, burst: [3, 7], range: 190, snd: 'shot', tracer: [1.0, 0.85, 0.5], speed: 720, kick: 0.16, pen: 0.9 },
    lmg: { dmg: 26, rpm: 660, mag: 45, spread: 0.017, moveSpread: 0.045, reload: 4.4, burst: [6, 14], range: 380, snd: 'shotHeavy', tracer: [1.0, 0.8, 0.42], speed: 900, kick: 0.3, pen: 1.2 },
    sniper: { dmg: 74, rpm: 46, mag: 5, spread: 0.002, moveSpread: 0.05, reload: 3.6, burst: [1, 1], range: 900, snd: 'shotHeavy', tracer: [1.0, 0.9, 0.6], speed: 1150, kick: 0.5, pen: 1.6, scope: 1 },
    launcher: { dmg: 60, rpm: 30, mag: 1, spread: 0.03, moveSpread: 0.04, reload: 5.5, burst: [1, 1], range: 400, snd: 'shotHeavy', tracer: [1.0, 0.6, 0.3], speed: 120, kick: 0.7, pen: 1.0, rocket: 4 },
    pistol: { dmg: 15, rpm: 420, mag: 15, spread: 0.02, moveSpread: 0.04, reload: 1.9, burst: [1, 3], range: 90, snd: 'shot', tracer: [1.0, 0.84, 0.5], speed: 420, kick: 0.1, pen: 0.7 }
  };
  var SPEC = {
    rifle: { weapon: 'rifle', speed: 4.3, hp: 100, armor: 0.75, skill: 0.62 },
    heavy: { weapon: 'lmg', speed: 3.3, hp: 140, armor: 0.9, skill: 0.5 },
    officer: { weapon: 'smg', speed: 4.6, hp: 90, armor: 0.6, skill: 0.72 },
    marksman: { weapon: 'sniper', speed: 3.9, hp: 95, armor: 0.6, skill: 0.82 },
    scout: { weapon: 'smg', speed: 5.1, hp: 85, armor: 0.5, skill: 0.66 },
    crew: { weapon: 'rifle', speed: 4.0, hp: 90, armor: 0.5, skill: 0.45 }
  };

  function hash(s) { var h = 2166136261 >>> 0; s = String(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function angDiff(a, b) { var d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; }

  function Soldiers(engine) {
    this.E = engine;
    var G = engine.renderer.G;
    this.G = G; this.gl = G.gl;
    var S = TERRA.shaders;
    this.prog = G.program('soldier', S.sldVS, S.sldFS);
    this.progShadow = G.program('soldierShadow', S.sldVS, S.sldFS, { SHADOW: 1 });
    this.list = [];
    this.corpseT = 0;
    this.maxAlive = 14;
    this.maxTotal = 26;
    this.spawnTimer = 2;
    this.rows = 0;              // bone texture rows in use
    this.boneTex = null;
    this.boneData = null;
    this.boneCap = 0;
    this.inst = {};             // class -> { buf, data, cap, n }
    this._m = M.mat4(); this._wm = M.mat4(); this._q = [0, 0, 0, 1];
    this._v = [0, 0, 0];
    this.stats = { alive: 0, dead: 0, shots: 0, kills: 0 };
    this.spotted = 0;
    this._cm = new (chars())(engine);
  }
  var P = Soldiers.prototype;

  P.configure = function (g) {
    this.quality = U.clamp(g.combatDetail === undefined ? 2 : g.combatDetail, 0, 3);
    this.maxAlive = [0, 6, 14, 22][this.quality];
    this.maxTotal = [0, 12, 26, 40][this.quality];
    this.spawn = this.quality > 0;
    this._resize();
  };

  P._resize = function () {
    var gl = this.gl, total = this.maxTotal;
    if (total <= 0) return;
    if (this.boneCap >= total * chars().ROWS) return;
    this.boneCap = total * chars().ROWS;
    this.boneData = new Float32Array(this.boneCap * 16);
    if (this.boneTex) gl.deleteTexture(this.boneTex);
    this.boneTex = this._cm.boneTexture(this.boneCap);
  };

  P.clear = function () {
    this.list.length = 0;
    for (var k in this.inst) this.inst[k].n = 0;
  };
  P.reset = P.clear;

  /* ==========================================================================
   * Spawning
   * ======================================================================== */
  P.spawnAt = function (x, z, opts) {
    opts = opts || {};
    if (this.list.length >= this.maxTotal) return null;
    var E = this.E;
    var y = E.groundHeight(x, z);
    var w = E.waterAt(x, z);
    if (w.level > -1e4 && w.type !== 4 && y < w.level + 0.15) return null;
    var cls = opts.cls || CLASSES[Math.floor(Math.random() * CLASSES.length)];
    var sp = SPEC[cls] || SPEC.rifle;
    var s = {
      id: 'sol' + (this._id = (this._id || 0) + 1),
      pos: [x, y, z], vel: [0, 0, 0],
      yaw: opts.yaw === undefined ? Math.random() * Math.PI * 2 : opts.yaw,
      cls: cls, weapon: WEAPONS[sp.weapon] || WEAPONS.rifle, wname: sp.weapon,
      hp: sp.hp, maxHp: sp.hp, armor: sp.armor, skill: sp.skill,
      damage: 0, team: opts.team === undefined ? 1 : opts.team, dead: false, deadT: 0,
      state: 'patrol', fireT: 0, reloadT: 0, mag: (WEAPONS[sp.weapon] || WEAPONS.rifle).mag,
      burst: 0, burstPause: 0, alertT: 0, aimYaw: 0, aimPitch: 0, aimTime: 0,
      crouch: 0, prone: 0, weaponDown: 1, suppress: 0, lastSeen: null, losT: 0,
      patrol: opts.patrol || null, patrolI: 0, home: [x, z], homeR: opts.homeR || 90,
      seed: Math.random() * 100, voice: 0, stagger: Math.random() * 0.4,
      cover: null, coverT: 0, reactT: 0, recoil: 0, anim: null, boneRow: -1, instIdx: -1,
      footsteps: 0, corpses: false, groupId: opts.groupId || 0, waypoint: [x, z]
    };
    s.anim = new (chars().Animator)();
    s.anim.aimPitch = 0;
    if (this._allocBone(s) < 0) return null;
    this.list.push(s);
    TERRA.events.emit('soldierSpawn', s);
    return s;
  };

  P._allocBone = function (s) {
    var rows = chars().ROWS;
    for (var i = 0; i < this.maxTotal; i++) {
      var used = false;
      for (var j = 0; j < this.list.length; j++) if (this.list[j].boneRow === i * rows) { used = true; break; }
      if (!used) { s.boneRow = i * rows; return 0; }
    }
    return -1;
  };

  /** Spawn a squad near a settlement or on a patrol route. */
  P.spawnSquad = function (x, z, count, opts) {
    opts = opts || {};
    var squad = [];
    var ang = Math.random() * Math.PI * 2;
    for (var i = 0; i < count; i++) {
      var a = ang + (i - count / 2) * 0.35, r = 2 + i * 1.7;
      var sx = x + Math.cos(a) * r, sz = z + Math.sin(a) * r;
      var patrol = opts.patrol;
      var s = this.spawnAt(sx, sz, { team: opts.team, cls: opts.cls && opts.cls[i % opts.cls.length], patrol: patrol, homeR: opts.homeR, groupId: opts.groupId });
      if (s) { s.weaponDown = 1; squad.push(s); }
    }
    return squad;
  };

  /** Ambient spawning: garrisons near hostile settlements, roving patrols elsewhere. */
  P._ambient = function (dt, cam) {
    if (!this.spawn) return;
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnTimer = 3.5 + Math.random() * 4;
    var E = this.E;
    var alive = 0;
    for (var i = 0; i < this.list.length; i++) if (!this.list[i].dead) alive++;
    this.stats.alive = alive;
    if (alive >= this.maxAlive) return;
    // find a settlement nearby that is hostile
    var B = E.buildings, best = null;
    if (B && B.list) {
      for (var n = 0; n < B.list.length; n++) {
        var st = B.list[n];
        if (!st.hostile) continue;
        var d = Math.hypot(st.x - cam[0], st.z - cam[2]);
        if (d < 40) continue;
        if (d > 210) continue;
        if (!best || d < best.d) best = { st: st, d: d };
      }
    }
    var wx, wz, patrol = null, homeR = 90;
    if (best) {
      // garrison: post inside the settlement
      var ang = Math.random() * Math.PI * 2, r = Math.random() * Math.min(70, best.st.radius * 0.7);
      wx = best.st.x + Math.cos(ang) * r; wz = best.st.z + Math.sin(ang) * r;
      // patrol routes are authored in settlement-local coords: move them to world space
      patrol = best.st.patrol ? best.st.patrol.map(function (pt) { return [best.st.x + pt[0], best.st.z + pt[1]]; }) : null;
      homeR = best.st.radius;
    } else {
      // wilderness patrol: only in reasonably safe, walkable ground
      var a2 = Math.random() * Math.PI * 2, r2 = 90 + Math.random() * 110;
      wx = cam[0] + Math.cos(a2) * r2; wz = cam[2] + Math.sin(a2) * r2;
      var o = E.gen.newSample();
      E.gen.sample(wx, wz, o, 0);
      if (o.wtype > 0 || o.h < E.gen.SEA + 2 || o.h > E.gen.SEA + 1400) return;
      if (Math.random() > 0.45) return;
    }
    // never spawn in plain sight
    var px = this.E.player.pos;
    var toP = [px[0] - wx, px[1] + 1.2 - (this.E.groundHeight(wx, wz) + 1.2), px[2] - wz];
    var dl = Math.hypot(toP[0], toP[1], toP[2]) || 1;
    var C = combat();
    if (C) {
      var h = C.cast([px[0], px[1] + 1.6, px[2]], [-toP[0] / dl, -toP[1] / dl, -toP[2] / dl], dl - 1, { skip: ['soldier'] });
      if (h && h.t > dl - 6) return;   // the player would see them pop in
    }
    var n2 = 2 + Math.floor(Math.random() * 3);
    this.spawnSquad(wx, wz, n2, {
      team: 1, groupId: (this._gid = (this._gid || 0) + 1), patrol: patrol, homeR: homeR,
      cls: ['rifle', 'rifle', 'scout', 'heavy', 'officer', 'marksman']
    });
  };

  /* ==========================================================================
   * Navigation helpers
   * ======================================================================== */
  P._groundAt = function (x, z, y) {
    var E = this.E;
    var g = E.groundHeight(x, z);
    var B = E.buildings;
    if (B && B.floorHeight && B.list.length) {
      var f = B.floorHeight(x, z, y === undefined ? g + 1.2 : y, 0.65);
      if (f > g - 0.3) g = Math.max(g, f);
    }
    return g;
  };

  P._slide = function (s, dx, dz) {
    var E = this.E, x = s.pos[0] + dx, z = s.pos[2] + dz, y = s.pos[1];
    var B = E.buildings;
    if (B && B.resolveCircle && B.list.length) {
      var p = B.resolveCircle(x, z, y, 0.38, 1.7);
      if (p) { x += p[0]; z += p[1]; }
    }
    // trees and rocks
    var veg = E.vegetation;
    if (veg && veg.collidersNear) {
      var cols = veg.collidersNear(x, z, 0.95, true);
      for (var i = 0; i < cols.length; i += 4) {
        var cx = cols[i], cz = cols[i + 1], cr = cols[i + 2] * 0.55;
        var ddx = x - cx, ddz = z - cz, d = Math.hypot(ddx, ddz);
        if (d < cr + 0.35 && d > 1e-4) { x += ddx / d * (cr + 0.35 - d); z += ddz / d * (cr + 0.35 - d); }
      }
    }
    s.pos[0] = x; s.pos[2] = z;
  };

  /* ==========================================================================
   * Perception & combat
   * ======================================================================== */
  P._canSee = function (s, from, to, pad) {
    var C = combat();
    if (!C) return false;
    var dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
    var d = Math.hypot(dx, dy, dz);
    if (d < 0.4) return true;
    var h = C.cast(from, [dx / d, dy / d, dz / d], d - (pad || 0.35), { skip: ['soldier'] });
    return !h;
  };

  P._targetOf = function (s) {
    var E = this.E;
    if (s.team === 1 || s.team === 2) {
      // hostile to the player
      var pl = E.player;
      if (E.warmode && E.warmode.dead) return null;
      return { pos: [pl.pos[0], pl.pos[1] + (pl.crouch ? 0.95 : 1.35), pl.pos[2]], ref: pl, isPlayer: true };
    }
    return null;
  };

  P._fire = function (s, dt) {
    var E = this.E, C = combat();
    if (!C) return;
    var t = s._tgt;
    if (!t) return;
    var w = s.weapon;
    s.fireT -= dt;
    if (s.reloadT > 0) {
      s.reloadT -= dt;
      s.anim.set({ reload: s.reloadT > 0 });
      if (s.reloadT <= 0) { s.mag = w.mag; s.anim.set({ reload: false }); }
      return;
    }
    if (s.mag <= 0) { s.reloadT = w.reload; C.sfx('reload', s.pos, 0.5); return; }
    if (s.fireT > 0) return;
    if (s.burst <= 0) {
      if (s.burstPause > 0) { s.burstPause -= dt; if (s.burstPause > 0) return; }
      s.burst = w.burst[0] + Math.floor(Math.random() * (w.burst[1] - w.burst[0] + 1));
    }
    // aim error: distance, movement, suppression, skill and how long they've been aiming
    var dist = Math.hypot(t.pos[0] - s.pos[0], t.pos[1] - s.pos[1], t.pos[2] - s.pos[2]);
    var settle = U.clamp(s.aimTime / 0.9, 0, 1);
    var err = w.spread * (2.4 - s.skill * 1.2) * (1.5 - settle * 0.7) + w.moveSpread * U.clamp(Math.hypot(s.vel[0], s.vel[2]) / 4, 0, 1);
    err *= 1 + s.suppress * 1.6;
    err *= 1 + U.clamp(dist / 400, 0, 1.6);
    if (s.prone > 0.5) err *= 0.55;
    else if (s.crouch > 0.5) err *= 0.75;
    var muz = this._muzzle(s);
    var dir = [t.pos[0] - muz[0], t.pos[1] - muz[1], t.pos[2] - muz[2]];
    var dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    dir[0] /= dl; dir[1] /= dl; dir[2] /= dl;
    // spray inside the cone
    var a1 = Math.random() * Math.PI * 2, e1 = err * (Math.random() + Math.random() - 1) * 0.8;
    var ca = Math.cos(e1), sa = Math.sin(e1);
    var right = [dir[2], 0, -dir[0]];
    var rl = Math.hypot(right[0], right[2]) || 1; right[0] /= rl; right[2] /= rl;
    var d2 = [dir[0] * ca + right[0] * sa * Math.cos(a1), dir[1] * ca + sa * Math.sin(a1), dir[2] * ca + right[2] * sa * Math.cos(a1)];
    d2[1] += 0.02 * (Math.random() - 0.5);
    var dl2 = Math.hypot(d2[0], d2[1], d2[2]) || 1;
    d2[0] /= dl2; d2[1] /= dl2; d2[2] /= dl2;
    // muzzle flash, light, smoke, tracer, sound
    var col = w.tracer;
    C.tracers.flash(muz, 0.22 + Math.random() * 0.1, [1.0, 0.82, 0.5], 0.045);
    if (E.effects) {
      E.effects.lights.push({ pos: [muz[0], muz[1], muz[2]], color: [3.2, 2.2, 1.0], radius: 7, age: 0, life: 0.05 });
      E.effects.emit(TERRA.game.Effects.K.SMOKE, muz, [d2[0] * 3, d2[1] * 3 + 0.6, d2[2] * 3], 0.5, 0.12, 0.8, [0.7, 0.7, 0.68], 0.05);
      if (Math.random() < 0.5) E.effects.emit(TERRA.game.Effects.K.SPARK, muz, [d2[0] * 6, d2[1] * 6, d2[2] * 6], 0.06, 0.02, 0, [1, 0.85, 0.5], 1);
    }
    C.sfx(w.snd, s.pos, 1, w.dmg / 21);
    var hit = C.cast(muz, d2, w.range, { skip: ['soldier'] });
    if (hit) {
      C.tracers.streak(muz, hit.p, col, 0.05 + Math.random() * 0.04, 0.014);
      if (hit.type === 'terrain' || hit.type === 'building' || hit.type === 'object') {
        C.impact(hit, { noDecal: false });
      }
      if (hit.type === 'building' || hit.type === 'gvehicle' || hit.type === 'vehicle') {
        C.applyDamage(hit, w.dmg * 0.6, { source: s, team: s.team, dmgType: 'bullet' });
      }
      if (hit.type === 'player' || hit.type === 'soldier') {
        var dmg = w.dmg * (1 - U.clamp(dist / (w.range * 1.35), 0, 0.55));
        if (hit.type === 'player' && E.warmode) E.warmode.damagePlayer(dmg, { source: s, dir: d2, pos: hit.p, explosive: false });
        else if (hit.type === 'soldier' && hit.ref !== s && hit.ref.team !== s.team) this.damage(hit.ref, dmg, hit, { source: s, team: s.team });
      }
      // rounds passing near the player: a whizz and a flinch
      this._nearMiss(hit.p, d2, s);
    } else {
      var far = [muz[0] + d2[0] * w.range, muz[1] + d2[1] * w.range, muz[2] + d2[2] * w.range];
      C.tracers.streak(muz, far, col, 0.05, 0.012);
    }
    s.mag--; s.burst--; s.shots = (s.shots || 0) + 1;
    this.stats.shots++;
    var rpm = w.rpm * (1 + (s.skill - 0.6) * 0.1);
    s.fireT = 60 / rpm * (1 + Math.random() * 0.25);
    if (s.burst <= 0) s.burstPause = 0.25 + Math.random() * 0.7;
    s.recoil = Math.min(1.2, s.recoil + w.kick);
    if (s.recoil > 0.45) s.anim.set({ fire: 0.06 });
    // recoil walks the aim up
    s.aimPitch += w.kick * 0.05 * (0.6 + Math.random() * 0.6);
  };

  /** Silent round passing close to the player: panicked whizz + camera nudge. */
  P._nearMiss = function (p, dir, s) {
    var E = this.E, C = combat();
    if (!C || !E.player) return;
    var pl = E.player.pos;
    var d = TERRA.game.Combat.segPointDist([p[0] - dir[0] * 8, p[1] - dir[1] * 8, p[2] - dir[2] * 8], p, [pl[0], pl[1] + 1.2, pl[2]]);
    if (d > 1.8) return;
    C.sfx('whiz', p, 0.7);
    if (E.effects) E.effects.shake = Math.max(E.effects.shake || 0, 0.12);
    s.suppress = Math.max(s.suppress, 0.4);
  };

  P._muzzle = function (s) {
    var fwd = [Math.sin(s.yaw), 0, Math.cos(s.yaw)];
    var up = [0, 1, 0];
    var y = s.pos[1] + (1.34 + Math.sin(s.aimPitch) * 0.28) * (1 - s.crouch * 0.18) - s.crouch * 0.32 - s.prone * 1.05;
    var f = Math.cos(s.aimPitch) * 0.52;
    return [s.pos[0] + fwd[0] * f + up[0] * 0, y, s.pos[2] + fwd[2] * f];
  };

  /* ==========================================================================
   * AI
   * ======================================================================== */
  P.update = function (frame) {
    var E = this.E, dt = frame.dt, cam = frame.cam.world, pl = E.player;
    this._ambient(dt, cam);
    var alive = 0;
    for (var i = this.list.length - 1; i >= 0; i--) {
      var s = this.list[i];
      var d = Math.hypot(s.pos[0] - cam[0], s.pos[2] - cam[2]);
      if (s.dead) {
        s.deadT += dt;
        if (d > 130 || s.deadT > 45) { this._remove(i); continue; }
      } else if (d > 320) { this._remove(i); continue; }
      else alive++;
      this._think(s, dt, d, cam, pl);
    }
    this.stats.alive = alive;
    this.stats.dead = this.list.length - alive;
    this._writeInstances(frame);
  };

  P._remove = function (i) {
    var s = this.list[i];
    s.boneRow = -1;
    this.list.splice(i, 1);
  };

  P._think = function (s, dt, dist, cam, pl) {
    var E = this.E, C = combat();
    var far = dist > 110;
    var step = far ? Math.min(dt * 4, 0.25) : dt;      // far soldiers think at 4 Hz-equivalent
    s.thinkAcc = (s.thinkAcc || 0) + dt;
    if (far && s.thinkAcc < 0.25) { this._animate(s, dt, true); return; }
    s.thinkAcc = 0;
    s.suppress = Math.max(0, s.suppress - step * 0.5);
    s.aimTime += step;
    s.recoil = Math.max(0, s.recoil - step * 4);

    /* --- perception --- */
    var tgt = this._targetOf(s);
    var eye = [s.pos[0], s.pos[1] + 1.55 - s.crouch * 0.3, s.pos[2]];
    var sees = false, tdist = 0;
    if (tgt && !s.dead) {
      tdist = Math.hypot(tgt.pos[0] - s.pos[0], tgt.pos[2] - s.pos[2]);
      var visRange = 210 * (1 - s.crouch * 0.25);
      if (tdist < visRange) {
        var fwd = [Math.sin(s.yaw), 0, Math.cos(s.yaw)];
        var toT = [(tgt.pos[0] - s.pos[0]) / Math.max(1e-3, tdist), 0, (tgt.pos[2] - s.pos[2]) / Math.max(1e-3, tdist)];
        var dot = fwd[0] * toT[0] + fwd[2] * toT[2];
        var fov = s.state === 'engage' ? -0.4 : 0.15;              // wider once alerted
        if (dot > fov || tdist < 22) {
          s.losT -= step;
          if (s.losT <= 0) {
            s.losT = 0.18 + Math.random() * 0.2;
            sees = this._canSee(s, eye, tgt.pos, 0.5);
            s._sees = sees;
          } else sees = !!s._sees;
        } else s._sees = false;
      }
    }
    if (sees) { s.lastSeen = [tgt.pos[0], tgt.pos[1], tgt.pos[2]]; s.alertT = 6; s.state = 'engage'; s.weaponDown = Math.max(0, s.weaponDown - step * 3); }
    else {
      if (s.state === 'engage') { s.state = s.lastSeen ? 'hunt' : 'patrol'; s.alertT = 4; }
      s.alertT -= step;
      s.weaponDown = Math.min(1, s.weaponDown + step * (s.state === 'hunt' ? 0.6 : 1.6));
    }
    if (s.alertT <= 0 && s.state === 'hunt') s.state = 'patrol';
    s._tgt = (s.state === 'engage' || s.state === 'hunt') ? (s.lastSeen ? { pos: s.lastSeen } : tgt) : tgt;

    /* --- goal selection --- */
    var goal = null, speedScale = 1, wantCrouch = 0, wantProne = 0;
    if (s.state === 'engage' && sees && tgt) {
      // pick cover that protects from the target, otherwise stand and shoot
      s.coverT -= step;
      if (s.coverT <= 0) {
        s.coverT = 1.4 + Math.random() * 1.6;
        var B = E.buildings;
        if (B && B.coverNear && tdist > 12) {
          var cv = B.coverNear(s.pos[0], s.pos[2], 26, [tgt.pos[0], tgt.pos[2], tgt.pos[1]], 40);
          if (cv && cv.align > 0.55 && Math.random() < 0.75) s.cover = cv;
        }
      }
      if (s.cover) {
        var dcv = Math.hypot(s.cover.x - s.pos[0], s.cover.z - s.pos[2]);
        if (dcv > 1.4) goal = [s.cover.x, s.cover.z];
        else {
          wantCrouch = s.cover.low ? 1 : 0;
          if (s.weapon === WEAPONS.sniper && tdist > 90) wantProne = 1;
          if (Math.random() < 0.002) s.cover = null;
        }
      } else {
        // no cover: shuffle sideways, keep the range open at long distance, close in with SMGs
        var hold = s.wname === 'smg' ? 26 : (s.wname === 'lmg' ? 45 : 34);
        var side = ((s.seed | 0) % 2) ? 1 : -1;
        var strafe = (Math.sin((this.E.time || 0) * 1.3 + s.seed) > 0 ? 1 : -1) * side;
        var tx = s.pos[0] + (s.lastSeen[0] - s.pos[0]) / Math.max(1e-3, tdist) * (tdist - hold) * -1 + -((s.lastSeen[2] - s.pos[2]) / Math.max(1e-3, tdist)) * strafe * 4;
        var tz = s.pos[2] + (s.lastSeen[2] - s.pos[2]) / Math.max(1e-3, tdist) * (tdist - hold) * -1 + ((s.lastSeen[0] - s.pos[0]) / Math.max(1e-3, tdist)) * strafe * 4;
        goal = [tx, tz];
        if (tdist < 9) wantCrouch = 1;
      }
      if (sees) this._fire(s, step);
    } else if (s.state === 'hunt' && s.lastSeen) {
      goal = [s.lastSeen[0], s.lastSeen[2]];
      speedScale = 1.15;
      s.reloadT = 0; if (s.mag < s.weapon.mag * 0.6) s.reloadT = s.weapon.reload;
      if (Math.hypot(goal[0] - s.pos[0], goal[1] - s.pos[2]) < 3) { s.lastSeen = null; s.state = 'patrol'; }
    } else {
      // patrol the assigned route, or mill about the home position
      var patrol = s.patrol;
      if (patrol && patrol.length) {
        var wp = patrol[s.patrolI % patrol.length];
        var wx = (wp[0] === undefined ? wp.x : wp[0]), wz = (wp[1] === undefined ? wp.z : wp[1]);
        if (Math.hypot(wx - s.pos[0], wz - s.pos[2]) < 3.5) s.patrolI++;
        goal = [wx, wz];
      } else if (Math.hypot(s.waypoint[0] - s.pos[0], s.waypoint[1] - s.pos[2]) < 4 || s.waypoint[1] === undefined) {
        var a = Math.random() * Math.PI * 2, r = 12 + Math.random() * s.homeR;
        s.waypoint = [s.home[0] + Math.cos(a) * r, s.home[1] + Math.sin(a) * r];
        goal = s.waypoint;
      } else goal = s.waypoint;
      speedScale = 0.55;
      if (s.wname !== 'lmg' && s.wname !== 'sniper') { s.crouch = Math.max(0, s.crouch - step); }
    }
    if (goal) {
      var gx = goal[0] - s.pos[0], gz = goal[1] - s.pos[2];
      var gd = Math.hypot(gx, gz);
      if (gd > 0.4) {
        var want = SPEC[s.cls].speed * speedScale;
        var ux = gx / gd, uz = gz / gd;
        // simple steering around buildings
        var ax = ux, az = uz;
        var B2 = E.buildings;
        if (B2 && B2.resolveCircle && B2.list.length) {
          var px = s.pos[0] + ux * 1.6, pz = s.pos[2] + uz * 1.6;
          var push = B2.resolveCircle(px, pz, s.pos[1], 0.4, 1.7);
          if (push) { ax += push[0] * 1.6; az += push[1] * 1.6; var al = Math.hypot(ax, az) || 1; ax /= al; az /= al; }
        }
        var accel = 14;
        s.vel[0] += (ax * want - s.vel[0]) * Math.min(1, accel * step / Math.max(1, want || 1));
        s.vel[2] += (az * want - s.vel[2]) * Math.min(1, accel * step / Math.max(1, want || 1));
      } else { s.vel[0] *= 0.8; s.vel[2] *= 0.8; }
    } else {
      s.vel[0] *= 0.86; s.vel[2] *= 0.86;
    }
    // gravity + step up onto floors/stairs
    s.vel[1] -= 22 * step;
    this._move(s, step);
    s.crouch += (wantCrouch - s.crouch) * Math.min(1, step * 5);
    s.prone += (wantProne - s.prone) * Math.min(1, step * 2.2);

    /* --- facing / aim --- */
    var aimSource = null;
    if (s.state === 'engage' && s.lastSeen) aimSource = s.lastSeen;
    else if (s.lastSeen) aimSource = s.lastSeen;
    else if (s.vel[0] || s.vel[2]) aimSource = [s.pos[0] + s.vel[0] * 6, s.pos[1] + 1.5, s.pos[2] + s.vel[2] * 6];
    if (aimSource) {
      var dx2 = aimSource[0] - s.pos[0], dz2 = aimSource[2] - s.pos[2];
      var wantYaw = Math.atan2(dx2, dz2);
      var dy = (aimSource[1] === undefined ? s.pos[1] + 1.4 : aimSource[1]) - (s.pos[1] + 1.45 - s.crouch * 0.3);
      var wantPitch = Math.atan2(dy, Math.max(1, Math.hypot(dx2, dz2)));
      var turn = s.state === 'engage' ? 5.5 : 2.4;
      s.yaw += angDiff(wantYaw, s.yaw) * Math.min(1, turn * step);
      var dp = angDiff(wantPitch, s.aimPitch);
      s.aimPitch += U.clamp(dp, -1.6 * step, 1.6 * step) * 3;
      s.aimPitch = U.clamp(s.aimPitch, -0.9, 0.95);
      // decouple the weapon from the body a little: it lags the turn
      s.aimYaw = U.clamp(angDiff(wantYaw, s.yaw), -0.45, 0.45);
    }
    if (s.mag <= 0 && s.reloadT <= 0 && !s.dead) { s.reloadT = s.weapon.reload; if (C) C.sfx('reload', s.pos, 0.4); }
    this._animate(s, dt, far);
  };

  P._move = function (s, dt) {
    var E = this.E;
    var wasY = s.pos[1];
    s.pos[0] += s.vel[0] * dt; s.pos[2] += s.vel[2] * dt;
    this._slide(s, 0, 0);
    s.pos[1] += s.vel[1] * dt;
    var gh = this._groundAt(s.pos[0], s.pos[2], s.pos[1]);
    if (s.pos[1] <= gh + 0.02) {
      if (Math.abs(s.vel[1]) > 5.5) {                     // hard landing
        C2sfx(this, s, 'dirt', 0.4);
        if (E.effects) E.effects.dust([s.pos[0], gh + 0.05, s.pos[2]], 0.5);
        if (s.vel[1] < -14) this.damage(s, (-s.vel[1] - 12) * 4, { p: [s.pos[0], gh, s.pos[2]], n: [0, 1, 0], surface: 'dirt' }, { fall: true });
      }
      s.pos[1] = gh; s.vel[1] = 0; s.grounded = true;
    } else s.grounded = false;
    // footsteps
    var spd = Math.hypot(s.vel[0], s.vel[2]);
    if (spd > 0.6 && s.grounded) {
      s.footsteps += spd * dt;
      if (s.footsteps > 2.05) {
        s.footsteps = 0;
        if (E.effects) E.effects.dust([s.pos[0], s.pos[1] + 0.04, s.pos[2]], 0.22);
      }
    }
    void wasY;
  };
  function C2sfx(self, s, name, g) { var C = combat(); if (C) C.sfx(name, s.pos, g); }

  P._animate = function (s, dt, lod) {
    var a = s.anim;
    if (s.dead) { if (!a.dead) a.set({ state: 'dead' }); }
    else {
      a.set({
        speed: Math.hypot(s.vel[0], s.vel[2]),
        aimYaw: s.aimYaw * (1 - s.weaponDown), aimPitch: s.aimPitch * (1 - s.weaponDown * 0.6),
        crouch: s.crouch, prone: s.prone, weaponDown: s.weaponDown, state: 'idle'
      });
      a.recoil = s.recoil * 0.5;
      if (s.reloadT > 0) a.set({ reload: true });
      else if (a._rl) a.set({ reload: false });
    }
    a.update(lod ? Math.min(dt, 0.25) : dt);
  };

  /* ==========================================================================
   * Rendering
   * ======================================================================== */
  /** Per-frame: instance attributes (world matrix, kit tint, damage, seed) and
   *  the bone matrix texture. The pose itself is produced by the animator. */
  P._writeInstances = function (frame) {
    var E = this.E, gl = this.gl, o = frame.origin;
    var rows = chars().ROWS;
    var counts = {}, i, s;
    var m = this._m;
    for (i = 0; i < this.list.length; i++) {
      s = this.list[i];
      if (s.boneRow < 0) continue;
      var cl = s.cls;
      if (!this.inst[cl]) this._makeInst(cl);
      var inst = this.inst[cl];
      var idx = counts[cl] || 0;
      if (idx >= inst.cap) continue;
      counts[cl] = idx + 1;
      s.instIdx = idx;
      var d = inst.data, b = idx * 24;
      var scale = s.scale || (s.scale = 0.95 + (s.seed % 0.11));
      var cy = Math.cos(s.yaw), sy = Math.sin(s.yaw);
      // instance world matrix (render space): yaw + scale + position
      d[b] = cy * scale; d[b + 1] = 0; d[b + 2] = -sy * scale; d[b + 3] = 0;
      d[b + 4] = 0; d[b + 5] = scale; d[b + 6] = 0; d[b + 7] = 0;
      d[b + 8] = sy * scale; d[b + 9] = 0; d[b + 10] = cy * scale; d[b + 11] = 0;
      d[b + 12] = s.pos[0] - o[0]; d[b + 13] = s.pos[1]; d[b + 14] = s.pos[2] - o[1]; d[b + 15] = 1;
      d[b + 16] = s.boneRow;                                  // bone row offset in the texture
      d[b + 17] = s.team;                                     // team kit tint
      d[b + 18] = s.dead ? 1 : U.clamp01(s.damage);           // blood / grime amount
      d[b + 19] = s.seed;
      d[b + 20] = s.dead ? U.clamp01(1 - s.deadT / 30) : 1;   // corpse fade
      d[b + 21] = s.dead ? 4 : (s.prone > 0.5 ? 3 : (s.crouch > 0.5 ? 2 : 1));
      d[b + 22] = s.dead && s.deadT > 30 ? 3 : 1;
      d[b + 23] = 1;
      // rotation-only root: the instance matrix carries the position
      m[0] = cy; m[2] = -sy; m[8] = sy; m[10] = cy;
      var a = s.anim;
      a.root = m;
      a._compose();
      this.boneData.set(a.boneMat.subarray(0, rows * 16), s.boneRow * 16);
    }
    this._counts = counts;
    gl.bindTexture(gl.TEXTURE_2D, this.boneTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 4, this.boneCap, gl.RGBA, gl.FLOAT, this.boneData);
    for (var k in this.inst) {
      var list = this.inst[k];
      list.n = counts[k] || 0;
      if (!list.n) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, list.buf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, list.data.subarray(0, list.n * 24));
    }
  };

  P._makeInst = function (cls) {
    var gl = this.gl, cap = Math.max(8, this.maxTotal);
    var data = new Float32Array(cap * 24);
    var buf = this.G.buffer(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
    this._cm.bindInstances(this.charOf(cls), buf);
    this.inst[cls] = { buf: buf, data: data, cap: cap, n: 0 };
  };
  /** Uploaded (and cached) mesh for a soldier class. */
  P.charOf = function (cls) { return this._cm.mesh(cls); };

  P.draw = function (frame, shadow, vp) {
    var list = this.list;
    if (!list.length || !this.boneTex) return;
    var gl = this.gl, E = this.E, o = frame.origin;
    var prog = shadow ? this.progShadow : this.prog;
    var p = prog.use();
    if (shadow) p.m4('uShadowVP', vp).i('uShadowPass', 1);
    else {
      var R = E.renderer;
      p.tex('uAlbedoH', 0, R.tex.matAlbedo, gl.TEXTURE_2D_ARRAY);
      p.tex('uNormalR', 1, R.tex.matNormal, gl.TEXTURE_2D_ARRAY);
      p.tex('uBones', 2, this.boneTex, gl.TEXTURE_2D);
      p.f('uWet', frame.env.wetness).f('uSnow', frame.env.snowCover)
        .v3('uSun', frame.env.lightDir[0], frame.env.lightDir[1], frame.env.lightDir[2]);
    }
    var cam = frame.cam.world;
    for (var k in this.inst) {
      var inst = this.inst[k];
      if (!inst.n) continue;
      var mesh = this.charOf(k);
      gl.bindVertexArray(mesh.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, mesh.count, mesh.indexType, 0, inst.n);
      E.renderer.G.stats.drawCalls++; E.renderer.G.stats.triangles += mesh.tris * inst.n;
      E.renderer.G.stats.instances += inst.n;
    }
    gl.bindVertexArray(null);
    void cam; void o;
  };
  P.drawShadow = function (frame, vp) { this.draw(frame, true, vp); };
  P.drawMotion = function () { /* velocities are small: skipped for motion vectors */ };

  /* ==========================================================================
   * Damage, death, queries — called by Combat
   * ======================================================================== */
  P.damage = function (s, dmg, hit, opts) {
    if (!s || s.dead) return { killed: false };
    opts = opts || {};
    var E = this.E, C = combat();
    var head = opts.head || (hit && hit.part === 'head');
    var surface = hit && hit.surface;
    if (head) dmg *= 2.7;
    if (surface === 'kevlar') dmg *= 1 - s.armor * 0.55;
    else if (surface === 'cloth' || surface === 'kevlarx') dmg *= 1 - s.armor * 0.25;
    else if (surface === 'webbing') dmg *= 0.95;
    if (opts.explosive) dmg *= 1.1;
    s.hp -= dmg;
    s.damage = U.clamp01(s.damage + dmg / (s.maxHp * 1.5));
    s.suppress = Math.min(1.6, s.suppress + 0.5);
    s.alertT = 8;
    if (!s.dead) {
      s.state = 'engage';
      s.lastSeen = s.lastSeen || [E.player.pos[0], E.player.pos[1] + 1.3, E.player.pos[2]];
      s.anim.set({ hit: 1 });
      if (head && s.hp > 0 && Math.random() < 0.3) { s.staggered = 1.2; }
      if (C) {
        C.blood(hit && hit.p ? hit.p : [s.pos[0], s.pos[1] + 1.2, s.pos[2]], hit && hit.n ? hit.n : [0, 0.4, 0], 8);
        C.sfx('flesh', s.pos, 0.8);
      }
      if (E.effects) E.effects.emit(TERRA.game.Effects.K.DUST, [s.pos[0], s.pos[1] + 1.1, s.pos[2]], [0, 0.6, 0], 0.4, 0.2, 0.6, [0.45, 0.1, 0.08], 0.3);
    }
    if (s.hp <= 0) this._kill(s, hit, opts);
    return { killed: s.dead, hp: s.hp };
  };

  P._kill = function (s, hit, opts) {
    if (s.dead) return;
    var E = this.E, C = combat();
    s.dead = true; s.deadT = 0; s.hp = 0; s.state = 'dead';
    s.anim.set({ state: 'dead', fallDir: (Math.random() - 0.5) * 1.4 });
    s.vel[0] *= 0.4; s.vel[2] *= 0.4;
    if (C) {
      C.blood([s.pos[0], s.pos[1] + 1.1, s.pos[2]], [0, 0.5, 0], 22);
      C.sfx('flesh', s.pos, 1);
      if (hit && hit.p) {
        C.decals.add([hit.p[0], hit.p[1], hit.p[2]], hit.n || [0, 1, 0], 1, 0.5 + Math.random() * 0.4, 0.85);
      }
      C.decals.add([s.pos[0], this._groundAt(s.pos[0], s.pos[2], s.pos[1]) + 0.02, s.pos[2]], [0, 1, 0], 1, 0.9 + Math.random() * 0.5, 0.8);
    }
    if (E.effects) E.effects.dust([s.pos[0], s.pos[1] + 0.1, s.pos[2]], 0.8, [0.4, 0.16, 0.12]);
    // gear drops: a rifle and a helmet that the physics layer can nudge
    if (E.throwables && E.throwables.spawn && Math.random() < 0.5) {
      try {
        E.throwables.spawn('crate', [s.pos[0] + (Math.random() - 0.5) * 0.6, s.pos[1] + 0.9, s.pos[2] + (Math.random() - 0.5) * 0.6], [(Math.random() - 0.5) * 1.3, 1.4, (Math.random() - 0.5) * 1.3]);
      } catch (e) { /* props are optional */ }
    }
    this.stats.kills++;
    if (E.warmode && opts && opts.source && (opts.source === E.player || opts.source.isPlayer)) {
      E.warmode.kills = (E.warmode.kills || 0) + 1;
      E.warmode.lastKillT = E.time || 0;
    }
    TERRA.events.emit('soldierKilled', { soldier: s, by: opts && opts.source });
  };

  P.push = function (s, dir, power) {
    if (!s) return;
    s.vel[0] += dir[0] * power; s.vel[1] += dir[1] * power * 0.8; s.vel[2] += dir[2] * power;
    if (!s.dead) { s.suppress = Math.min(1.6, s.suppress + power * 0.2); s.anim.set({ hit: 1 }); }
  };

  /** Grenades and other explosives in range cook off. */
  P.chainExplosives = function (p, R) {
    void p; void R;
  };

  P.queryRadius = function (p, r) {
    var out = [];
    for (var i = 0; i < this.list.length; i++) {
      var s = this.list[i];
      if (Math.hypot(s.pos[0] - p[0], s.pos[2] - p[2]) <= r) out.push(s);
    }
    return out;
  };
  P.nearest = function (p, r, team) {
    var best = null, bd = r;
    for (var i = 0; i < this.list.length; i++) {
      var s = this.list[i];
      if (s.dead) continue;
      if (team !== undefined && s.team !== team) continue;
      var d = Math.hypot(s.pos[0] - p[0], s.pos[2] - p[2]);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  };

  /** Ray provider: capsule body + head sphere, reports the hit region. */
  P.raycast = function (o, d, maxT, filter) {
    if (!this.list.length) return null;
    var C = TERRA.game.Combat;
    var best = null;
    for (var i = 0; i < this.list.length; i++) {
      var s = this.list[i];
      var r = s.dead ? 0.42 : 0.34;
      var top = s.pos[1] + (s.dead ? 0.45 : 1.62 - s.crouch * 0.35 - s.prone * 1.2);
      var bot = s.pos[1] + (s.dead ? 0.03 : 0.02);
      var t = C.rayCylinderY(o, d, s.pos, r, bot, top);
      var headT = null;
      if (!s.dead) {
        headT = C.raySphere(o, d, [s.pos[0], s.pos[1] + 1.66 - s.crouch * 0.32 - s.prone * 1.18, s.pos[2]], 0.135);
      }
      var part = 'body', useT = t, surface = 'cloth';
      if (s.dead) part = 'body';
      if (headT !== null && (useT === null || headT < useT)) { useT = headT; part = 'head'; surface = 'skin'; }
      if (useT === null || useT > maxT) continue;
      if (filter && filter.skip && filter.skip.indexOf('soldier') >= 0) continue;
      if (!best || useT < best.t) {
        // chest / armour plates read as kevlar when hit from the front or back
        if (part !== 'head') {
          var ly = (o[1] + d[1] * useT) - s.pos[1];
          if (ly > 1.05 && ly < 1.55) surface = 'kevlar';
        }
        best = { t: useT, type: 'soldier', ref: s, part: part, surface: surface,
          n: [-(o[0] + d[0] * useT - s.pos[0]), 0, -(o[2] + d[2] * useT - s.pos[2])] };
        var nl = Math.hypot(best.n[0], best.n[2]) || 1;
        best.n[0] /= nl; best.n[2] /= nl; best.n[1] = 0.15;
      }
    }
    if (best) best.head = best.part === 'head';
    return best;
  };

  /* ==========================================================================
   * Persistence
   * ======================================================================== */
  P.serialize = function () {
    var out = [];
    for (var i = 0; i < this.list.length; i++) {
      var s = this.list[i];
      out.push({ c: s.cls, t: s.team, x: +s.pos[0].toFixed(2), y: +s.pos[1].toFixed(2), z: +s.pos[2].toFixed(2),
        yaw: +s.yaw.toFixed(3), hp: Math.round(s.hp), d: s.dead ? 1 : 0 });
    }
    return out;
  };
  P.deserialize = function (data) {
    this.clear();
    if (!data || !data.length) return;
    for (var i = 0; i < data.length; i++) {
      var r = data[i];
      var s = this.spawnAt(r.x, r.z, { cls: r.c, team: r.t, yaw: r.yaw });
      if (!s) continue;
      s.pos[1] = r.y; s.hp = r.hp;
      if (r.d) { s.dead = true; s.deadT = 20; s.hp = 0; s.anim.set({ state: 'dead' }); }
    }
  };

  TERRA.game.Soldiers = Soldiers;
  TERRA.game.weapons = WEAPONS;
})();
