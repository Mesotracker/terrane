/* =============================================================================
 * TERRA INFINITA — hand tools, felling, tilling, raking and throwing
 * -----------------------------------------------------------------------------
 *   1–6 / mouse wheel   select: hands · axe · hoe · rake · stones · dynamite
 *   Left mouse          use the tool  ·  hold & release to throw (charge = power)
 *   E                   pick up / drop the object you look at (balls, crates, logs, stones)
 *   Right mouse         cancel a throw / gently drop what you hold
 *
 * Axe     swing with wind-up, strike and recoil; the blade is tested against tree
 *         trunks, felled trunks, stumps, logs, crates, rocks and the ground. Trees
 *         take more hits the thicker they are, shed wood chips and creak, then
 *         topple away from you (rigid-rod fall under gravity), crash down shaking
 *         the leaves and leave a stump with growth rings. Chop the fallen trunk to
 *         buck it into logs — real rigid bodies that roll, float and can be thrown.
 *         Rock and metal make sparks and blunt the blade (durability).
 * Hoe     tills the soil: a persistent edit that turns the ground to dirt (mud when
 *         wet), removes the grass there and leaves a furrow.
 * Rake    drags tine grooves through soil, sand and snow, flattens grass, smooths
 *         small bumps and gathers leaf litter.
 * Throwing  stones, dynamite and anything you pick up, with mass-dependent speed,
 *         spin, gravity, drag, bouncing, rolling and an optional trajectory preview.
 * Dynamite  lit fuse with sparks and hiss (cook it at your peril), explosion with
 *         fireball, smoke, debris, light and a delayed boom; it blasts a crater into
 *         the terrain (chunk-aware persistent edit), scorches and clears grass, fells
 *         nearby trees, splits fallen trunks, flings objects, vehicles and you, chain-
 *         detonates other dynamite and throws up a water column in lakes and the sea.
 * The first-person view model is drawn into the G-buffer (lit, reflected, path
 * traced like everything else) and marked screen-locked for frame extrapolation.
 * ========================================================================== */
(function () {
  'use strict';
  var U = TERRA.util, M = TERRA.math;

  var SLOTS = [
    { id: 'hand', name: 'Hands' },
    { id: 'axe', name: 'Axe', dur: 140 },
    { id: 'hoe', name: 'Hoe', dur: 180 },
    { id: 'rake', name: 'Rake', dur: 220 },
    { id: 'stone', name: 'Stones' },
    { id: 'dynamite', name: 'Dynamite' }
  ];
  var ICONS = {
    hand: '<path d="M8 21v-7l-2-3V7a1 1 0 0 1 2 0v4M8 7V4a1 1 0 0 1 2 0v7M10 4a1 1 0 0 1 2 0v7M12 5a1 1 0 0 1 2 0v6M14 7a1 1 0 0 1 2 0v6c0 4-2 6-4 8"/>',
    axe: '<path d="M6 21L17 6"/><path d="M14 4c2-1 5 0 6 2l-4 5c-1-2-2-3-4-3z" fill="currentColor"/>',
    hoe: '<path d="M7 21L18 5"/><path d="M15 4l5 3-2 2-4-2z" fill="currentColor"/>',
    rake: '<path d="M12 21V8"/><path d="M5 8h14M6 8v4M9 8v4M12 8v4M15 8v4M18 8v4"/>',
    stone: '<ellipse cx="12" cy="14" rx="7" ry="5" fill="currentColor"/>',
    dynamite: '<path d="M7 9h3v12H7zM11 9h3v12h-3zM15 9h3v12h-3z" fill="currentColor"/><path d="M12 9c0-3 2-4 4-5" /><circle cx="17" cy="3.6" r="1.4" fill="#ffcc55" stroke="none"/>'
  };
  var TT = TERRA.game.Throwables;
  var K_STONE = 5, K_DYN = 6, K_LOG = 7;

  /* ---------------- view-model poses (camera space: x right, y up, -z ahead; rotations rx, ry, rz) ---------------- */
  var BASE = {
    hand: null,
    axe: [0.30, -0.34, -0.58, 0.18, -0.35, -0.22],
    hoe: [0.28, -0.44, -0.62, 0.55, -0.25, -0.12],
    rake: [0.27, -0.46, -0.66, 0.62, -0.2, -0.08],
    stone: [0.24, -0.25, -0.46, 0.0, 0.0, 0.0],
    dynamite: [0.24, -0.24, -0.46, -0.1, 0.3, 0.1]
  };
  // keyframes: [t, x, y, z, rx, ry, rz]
  var ANIM = {
    axe: { dur: 0.62, hit: 0.44, keys: [[0, 0.30, -0.34, -0.58, 0.18, -0.35, -0.22], [0.3, 0.34, -0.06, -0.38, -0.95, -0.25, -0.45], [0.44, 0.06, -0.42, -0.74, 1.3, 0.05, 0.12], [0.55, 0.1, -0.4, -0.72, 1.12, 0.0, 0.1], [1, 0.30, -0.34, -0.58, 0.18, -0.35, -0.22]] },
    hoe: { dur: 0.7, hit: 0.48, keys: [[0, 0.28, -0.44, -0.62, 0.55, -0.25, -0.12], [0.32, 0.28, -0.1, -0.42, -0.7, -0.2, -0.2], [0.48, 0.12, -0.58, -0.86, 1.45, -0.05, 0.0], [0.62, 0.14, -0.55, -0.8, 1.3, -0.05, 0.0], [1, 0.28, -0.44, -0.62, 0.55, -0.25, -0.12]] },
    rake: { dur: 1.0, hit: 0.35, drag: [0.35, 0.78], keys: [[0, 0.27, -0.46, -0.66, 0.62, -0.2, -0.08], [0.3, 0.16, -0.52, -1.05, 1.15, -0.1, 0.0], [0.38, 0.16, -0.6, -1.02, 1.28, -0.1, 0.0], [0.78, 0.24, -0.62, -0.52, 1.0, -0.15, 0.0], [1, 0.27, -0.46, -0.66, 0.62, -0.2, -0.08]] },
    throw: { dur: 0.32, keys: [[0, 0.34, -0.12, -0.24, -0.6, 0.1, 0.2], [0.35, 0.16, -0.14, -0.9, 0.5, 0.0, 0.0], [1, 0.24, -0.25, -0.46, 0.0, 0.0, 0.0]] }
  };
  var CHARGE = [0.36, -0.1, -0.22, -0.65, 0.15, 0.25];

  function ease(t) { return t * t * (3 - 2 * t); }
  function samplePose(keys, t, out) {
    var k = 0;
    while (k < keys.length - 2 && t > keys[k + 1][0]) k++;
    var a = keys[k], b = keys[k + 1], f = ease(U.clamp01((t - a[0]) / Math.max(1e-4, b[0] - a[0])));
    for (var i = 0; i < 6; i++) out[i] = a[i + 1] + (b[i + 1] - a[i + 1]) * f;
    return out;
  }
  function qmul(a, b) {
    return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
  }
  function qaxis(x, y, z, a) { var s = Math.sin(a / 2); return [x * s, y * s, z * s, Math.cos(a / 2)]; }
  function m4QPS(m, q, x, y, z, s) {
    var qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    m[0] = (1 - 2 * (qy * qy + qz * qz)) * s; m[1] = 2 * (qx * qy + qz * qw) * s; m[2] = 2 * (qx * qz - qy * qw) * s; m[3] = 0;
    m[4] = 2 * (qx * qy - qz * qw) * s; m[5] = (1 - 2 * (qx * qx + qz * qz)) * s; m[6] = 2 * (qy * qz + qx * qw) * s; m[7] = 0;
    m[8] = 2 * (qx * qz + qy * qw) * s; m[9] = 2 * (qy * qz - qx * qw) * s; m[10] = (1 - 2 * (qx * qx + qy * qy)) * s; m[11] = 0;
    m[12] = x; m[13] = y; m[14] = z; m[15] = 1;
    return m;
  }
  function eulerQ(rx, ry, rz) { return qmul(qmul(qaxis(0, 1, 0, ry), qaxis(1, 0, 0, rx)), qaxis(0, 0, 1, rz)); }

  /* ======================= Tools ======================= */
  function Tools(engine) {
    this.E = engine;
    var G = this.G = engine.renderer.G, gl = this.gl = G.gl, VM = TERRA.game.VehicleModels, MAT = VM.MAT;
    var V = engine.vehicles;
    // the vehicle shader handles every hand-made mesh (same vertex layout and materials)
    this.prog = V ? V.prog : G.program('vehicle', TERRA.shaders.vehVS, TERRA.shaders.vehFS);
    this.progShadow = V ? V.progShadow : G.program('vehicleShadow', TERRA.shaders.vehVS, TERRA.shaders.vehFS, { SHADOW: 1 });
    this.progMotion = V ? V.progMotion : G.program('vehicleMotion', TERRA.shaders.vehVS, TERRA.shaders.motionFS, { MOTION: 1 });
    var self = this;
    function up(mb) { return mb.upload(gl, G); }
    // view models: tool + gloved hand / sleeve
    this.meshes = {};
    ['axe', 'hoe', 'rake', 'dynamite', 'rock'].forEach(function (k) {
      var mb = VM.tool(k, 0);
      var grip = k === 'axe' ? [0, -0.3, 0] : (k === 'hoe' || k === 'rake' ? [0, -0.35, 0] : [0, -0.02, 0.02]);
      self._hand(mb, grip, MAT, k === 'rock' || k === 'dynamite');
      if (k === 'hoe' || k === 'rake') self._hand(mb, [0, 0.12, 0], MAT, false, true);
      self.meshes[k] = up(mb);
    });
    // empty hand
    var hm = new VM.MB(0); this._hand(hm, [0, 0, 0], MAT, true); this.meshes.hand = up(hm);
    // stump: bark sides, cut top with growth rings, root flare (unit radius)
    var sm = new VM.MB(0), bark = [0.42, 0.36, 0.3];
    sm.tube([0, -0.7, 0], [0, 1.4, 0], 1.0, 0.96, 18, bark, MAT.BARK, false);
    for (var k = 0; k < 18; k++) {
      var a0 = k / 18 * Math.PI * 2, a1 = (k + 1) / 18 * Math.PI * 2, tilt = 0.08;
      var p0 = [Math.cos(a0) * 0.96, 1.4 + Math.cos(a0) * tilt, Math.sin(a0) * 0.96], p1 = [Math.cos(a1) * 0.96, 1.4 + Math.cos(a1) * tilt, Math.sin(a1) * 0.96];
      sm.tri(sm.vert([0, 1.4, 0], [0, 1, 0], [1, 1, 1], MAT.ENDGRAIN), sm.vert(p1, [0, 1, 0], [1, 1, 1], MAT.ENDGRAIN), sm.vert(p0, [0, 1, 0], [1, 1, 1], MAT.ENDGRAIN));
    }
    for (var r = 0; r < 5; r++) { var ra = r / 5 * Math.PI * 2 + 0.4; sm.tube([Math.cos(ra) * 0.55, 0.35, Math.sin(ra) * 0.55], [Math.cos(ra) * 2.0, -0.45, Math.sin(ra) * 2.0], 0.42, 0.12, 8, bark, MAT.BARK, true); }
    this.meshes.stump = up(sm);
    this.slot = 1;                 // start with the axe
    this.dur = SLOTS.map(function (s) { return s.dur || 0; });
    this.broken = SLOTS.map(function () { return 0; });
    this.anim = null;
    this.charge = 0; this.charging = false; this.fuse = 0; this.fuseLit = false;
    this.held = null;
    this.pose = [0, 0, 0, 0, 0, 0]; this.sway = [0, 0];
    this.trees = {};               // damage per tree
    this.felled = [];              // toppling / lying trees
    this.stumps = [];
    this.mModel = new Float32Array(16); this.mTmp = new Float32Array(16); this.mW = new Float32Array(16);
    this.handlesThrow = false;
    this._buildDom();
    var th = engine.throwables;
    if (th) {
      th.onExplode = function (o) { self.explode(o.pos, 1.0, o); };
      th.onFuse = function (o, dt) { self._fuseFx(o.pos, dt); };
      th.onImpact = function (o, v) { self._impactSound(o, v); };
    }
  }
  var P = Tools.prototype;
  Tools.SLOTS = SLOTS;

  P._hand = function (mb, grip, MAT, open, left) {
    var skin = [0.78, 0.6, 0.48], glove = [0.3, 0.22, 0.15], sleeve = left ? [0.22, 0.27, 0.34] : [0.22, 0.27, 0.34];
    var g = grip, sx = left ? -1 : 1;
    if (open) mb.sphere([g[0], g[1] - 0.03, g[2] + 0.02], [0.05, 0.035, 0.06], skin, MAT.SKIN, 8);
    else {
      mb.sphere([g[0], g[1], g[2]], [0.045, 0.055, 0.05], glove, MAT.CLOTH, 8);
      mb.sphere([g[0] - 0.012 * sx, g[1] + 0.035, g[2] - 0.03], [0.022, 0.02, 0.03], glove, MAT.CLOTH, 6);   // thumb
    }
    mb.tube([g[0] + 0.01 * sx, g[1] - 0.04, g[2] + 0.04], [g[0] + 0.1 * sx, g[1] - 0.2, g[2] + 0.36], 0.042, 0.05, 10, skin, MAT.SKIN, true);
    mb.tube([g[0] + 0.05 * sx, g[1] - 0.11, g[2] + 0.17], [g[0] + 0.14 * sx, g[1] - 0.3, g[2] + 0.6], 0.056, 0.066, 10, sleeve, MAT.CLOTH, true);
  };

  /* ---------------- state persistence ---------------- */
  P.clear = function () { this.trees = {}; this.felled.length = 0; this.stumps.length = 0; this.held = null; this.anim = null; this.charging = false; this.fuseLit = false; };
  P.serialize = function () {
    return { stumps: this.stumps.map(function (s) { return [s.x, s.y, s.z, s.r, s.rot]; }), felled: this.felled.filter(function (f) { return f.state === 'rest'; }).map(function (f) { return [f.x, f.y, f.z, f.rot, f.scale, f.type, f.variant, f.seed, f.dir, f.theta, f.r, f.H]; }) };
  };
  P.deserialize = function (d) {
    this.clear();
    if (!d) return;
    var self = this;
    (d.stumps || []).forEach(function (s) { self.stumps.push({ x: s[0], y: s[1], z: s[2], r: s[3], rot: s[4] }); });
    (d.felled || []).forEach(function (f) { self.felled.push({ x: f[0], y: f[1], z: f[2], rot: f[3], scale: f[4], type: f[5], variant: f[6], seed: f[7], dir: f[8], theta: f[9], r: f[10], H: f[11], w: 0, state: 'rest', hits: 0 }); });
  };

  /* ---------------- input ---------------- */
  P.handleKeys = function (input) {
    var E = this.E;
    if (E.vehicles && E.vehicles.menuOpen) return;
    for (var i = 0; i < SLOTS.length; i++) if (input.hit('Digit' + (i + 1))) this.select(i);
    if (input.mouse.wheel && E.player.mode !== 'free' && input.locked) this.select((this.slot + (input.mouse.wheel > 0 ? 1 : SLOTS.length - 1)) % SLOTS.length);
    if (input.hit('KeyE') && E.player.mode !== 'free') { if (this.held) this.drop(false); else this.pickUp(); }
  };
  P.select = function (i) {
    if (i === this.slot) return;
    if (this.charging) this._cancelCharge();
    this.slot = i; this.anim = null;
    this.switchT = 0.25;
    if (this.held && SLOTS[i].id !== 'hand') this.drop(false);
    this._hudDirty = true;
    var A = this.E.audio; if (A && A.ready) A._burst({ freq: 1800, q: 1.2, len: 0.06, gain: 0.05 });
  };

  /* ---------------- per frame ---------------- */
  P.update = function (dt, input) {
    var E = this.E, pl = E.player;
    var driving = E.vehicles && E.vehicles.current;
    this.visible = !driving && pl.mode === 'first' && !E.editor.active && E.state === 'playing';
    this._updateFelled(dt);
    this._hud(dt);
    if (this.broken.some(function (b) { return b > 0; })) for (var b = 0; b < this.broken.length; b++) if (this.broken[b] > 0) { this.broken[b] -= dt; if (this.broken[b] <= 0) { this.broken[b] = 0; this.dur[b] = SLOTS[b].dur; TERRA.ui.toast(SLOTS[b].name + ' sharpened and ready'); this._hudDirty = true; } }
    if (dt <= 0) return;
    if (this.switchT > 0) this.switchT -= dt;
    var canUse = !driving && pl.mode !== 'free' && !E.editor.active && input.locked && !(E.vehicles && E.vehicles.menuOpen);
    var id = SLOTS[this.slot].id;
    // held object follows the hand
    if (this.held) this._carry(dt);
    // lit dynamite in hand
    if (this.fuseLit) {
      this.fuse -= dt;
      var hp = this._handWorld();
      this._fuseFx(hp, dt);
      if (this.fuse <= 0) { this.fuseLit = false; this.charging = false; this.explode(hp, 1.0, null); TERRA.ui.toast('You held the dynamite too long!', 'warn'); }
    }
    if (canUse) {
      var lmbDown = input.mouse.clicked[0], lmbUp = input.mouse.released[0], held = (input.mouse.buttons & 1) !== 0;
      if (input.mouse.clicked[2]) { if (this.charging) this._cancelCharge(); else if (this.held) this.drop(true); }
      if (id === 'axe' || id === 'hoe' || id === 'rake') {
        if ((lmbDown || (held && !this.anim)) && !this.anim && this.switchT <= 0) {
          if (this.broken[this.slot] > 0) { if (lmbDown) TERRA.ui.toast(SLOTS[this.slot].name + ' is blunt — sharpening (' + Math.ceil(this.broken[this.slot]) + ' s)', 'warn'); }
          else { this.anim = { kind: id, t: 0, hit: false, dragT: 0 }; this._sound('swish', 0.6); }
        }
      } else if (id === 'stone' || id === 'dynamite' || (id === 'hand' && this.held)) {
        if (lmbDown && !this.charging && !this.anim) {
          this.charging = true; this.charge = 0;
          if (id === 'dynamite') { this.fuseLit = true; this.fuse = 4.0; this._sound('light', 0.6); }
        }
        if (this.charging) {
          this.charge = Math.min(1, this.charge + dt / 1.1);
          this._preview();
          if (lmbUp || !held) this._throw();
        }
      } else if (id === 'hand' && lmbDown) this.pickUp();
    } else if (this.charging && !driving && !input.locked) { /* keep charging state until the pointer returns */ }
    if (!this.charging && E.effects) E.effects.setPreview(null);
    // animation
    if (this.anim) {
      var A = this.anim, def = ANIM[A.kind];
      A.t += dt / def.dur;
      if (!A.hit && def.hit !== undefined && A.t >= def.hit) { A.hit = true; this._impact(A.kind); }
      if (def.drag && A.t >= def.drag[0] && A.t <= def.drag[1]) { A.dragT -= dt; if (A.dragT <= 0) { A.dragT = 0.07; this._rakeStep((A.t - def.drag[0]) / (def.drag[1] - def.drag[0])); } }
      if (A.t >= 1) this.anim = null;
    }
    // weapon sway
    var mdx = input.locked ? input.mouse.dx : 0, mdy = input.locked ? input.mouse.dy : 0;
    this.sway[0] = U.damp(this.sway[0], U.clamp(-mdx * 0.0012, -0.08, 0.08), 9, dt);
    this.sway[1] = U.damp(this.sway[1], U.clamp(mdy * 0.0012, -0.06, 0.06), 9, dt);
  };

  /* ---------------- ray casting against the world ---------------- */
  P._ray = function (reach) {
    var E = this.E, o = E.camera.world, d = E.player.forward, best = { t: reach, type: null };
    // trees (vertical trunk cylinders) and tools' own colliders
    var veg = E.vegetation;
    if (veg) {
      var cols = veg.collidersNear(o[0] + d[0] * reach * 0.5, o[2] + d[2] * reach * 0.5, reach * 0.5 + 2.5, true);
      for (var i = 0; i < cols.length; i += 4) {
        var cx = cols[i], cz = cols[i + 1], r = cols[i + 2], cy = cols[i + 3];
        var t = rayCircle(o[0], o[2], d[0], d[2], cx, cz, r);
        if (t === null || t > best.t) continue;
        var y = o[1] + d[1] * t;
        if (y < cy - 0.5 || y > cy + 8) continue;
        best = { t: t, type: 'tree', cx: cx, cz: cz, cy: cy, r: r };
      }
    }
    // felled trunks (capsules) and stumps
    for (var f = 0; f < this.felled.length; f++) {
      var F = this.felled[f]; if (F.state !== 'rest') continue;
      var seg = this._trunkSeg(F), tt = raySeg(o, d, seg[0], seg[1], F.r + 0.12);
      if (tt !== null && tt < best.t) best = { t: tt, type: 'felled', ref: F };
    }
    for (var s = 0; s < this.stumps.length; s++) {
      var St = this.stumps[s], ts = rayCircle(o[0], o[2], d[0], d[2], St.x, St.z, St.r * 1.05);
      if (ts === null || ts > best.t) continue;
      var ys = o[1] + d[1] * ts;
      if (ys < St.y - 0.3 || ys > St.y + St.r * 1.45) continue;
      // the stump top is below the trunk-circle hit: keep tree hits that are on the stump
      if (best.type === 'tree' && Math.hypot(best.cx - St.x, best.cz - St.z) < 0.2) continue;
      best = { t: ts, type: 'stump', ref: St };
    }
    // loose objects
    var th = E.throwables;
    if (th) for (var k = 0; k < th.objs.length; k++) {
      var ob = th.objs[k]; if (ob.held) continue;
      var rr = th.smpFor(ob).radius * (ob.kind === K_LOG ? 0.7 : 1.0);
      var tq = raySphere(o, d, ob.pos, rr);
      if (ob.kind === K_LOG) { var ax = qrotv(ob.q, [0, 1, 0]), hl = th.sizeFor(ob)[1]; var tl = raySeg(o, d, [ob.pos[0] - ax[0] * hl, ob.pos[1] - ax[1] * hl, ob.pos[2] - ax[2] * hl], [ob.pos[0] + ax[0] * hl, ob.pos[1] + ax[1] * hl, ob.pos[2] + ax[2] * hl], th.sizeFor(ob)[0] + 0.05); tq = tl; }
      if (tq !== null && tq < best.t) best = { t: tq, type: 'object', ref: ob };
    }
    // vehicles
    var vs = E.vehicles;
    if (vs) for (var v = 0; v < vs.list.length; v++) { var Vh = vs.list[v], tv = raySphere(o, d, Vh.pos, Vh.info.radius * 0.45); if (tv !== null && tv < best.t) best = { t: tv, type: 'vehicle', ref: Vh }; }
    // ground / water (march)
    var step = 0.08;
    for (var g = 0.3; g < best.t; g += step) {
      var x = o[0] + d[0] * g, y2 = o[1] + d[1] * g, z = o[2] + d[2] * g;
      var gh = E.groundHeight(x, z);
      if (y2 <= gh) { best = { t: g, type: 'ground', p: [x, gh, z] }; break; }
    }
    best.p = best.p || [o[0] + d[0] * best.t, o[1] + d[1] * best.t, o[2] + d[2] * best.t];
    if (best.type === 'ground' || best.type === null) {
      var w = E.waterAt(best.p[0], best.p[2]);
      if (w.level > -1e4 && w.type !== 4 && best.p[1] < w.level + 0.05) {
        var tw = (w.level - o[1]) / (d[1] || -1e-3);
        if (tw > 0 && tw < reach) best = { t: tw, type: 'water', p: [o[0] + d[0] * tw, w.level, o[2] + d[2] * tw] };
      }
    }
    return best;
  };
  function rayCircle(ox, oz, dx, dz, cx, cz, r) {
    var a = dx * dx + dz * dz; if (a < 1e-6) return null;
    var fx = ox - cx, fz = oz - cz, b = 2 * (fx * dx + fz * dz), c = fx * fx + fz * fz - r * r;
    var disc = b * b - 4 * a * c; if (disc < 0) return null;
    var t = (-b - Math.sqrt(disc)) / (2 * a);
    return t > 0 ? t : null;
  }
  function raySphere(o, d, c, r) {
    var fx = o[0] - c[0], fy = o[1] - c[1], fz = o[2] - c[2], b = fx * d[0] + fy * d[1] + fz * d[2], cc = fx * fx + fy * fy + fz * fz - r * r;
    var disc = b * b - cc; if (disc < 0) return null;
    var t = -b - Math.sqrt(disc); return t > 0 ? t : null;
  }
  /** Closest approach of a ray to a segment; hit if within radius. */
  function raySeg(o, d, a, b, r) {
    var u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w0 = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
    var A = d[0] * d[0] + d[1] * d[1] + d[2] * d[2], B = d[0] * u[0] + d[1] * u[1] + d[2] * u[2], C = u[0] * u[0] + u[1] * u[1] + u[2] * u[2];
    var D = d[0] * w0[0] + d[1] * w0[1] + d[2] * w0[2], Ee = u[0] * w0[0] + u[1] * w0[1] + u[2] * w0[2];
    var den = A * C - B * B, sc, tc;
    if (den < 1e-8) { sc = 0; tc = Ee / C; } else { sc = (B * Ee - C * D) / den; tc = (A * Ee - B * D) / den; }
    tc = U.clamp01(tc);
    sc = Math.max(0, (B * tc - D) / A);
    var px = o[0] + d[0] * sc - (a[0] + u[0] * tc), py = o[1] + d[1] * sc - (a[1] + u[1] * tc), pz = o[2] + d[2] * sc - (a[2] + u[2] * tc);
    return px * px + py * py + pz * pz <= r * r ? Math.max(0.05, sc - r * 0.5) : null;
  }
  function qrotv(q, v) {
    var x = q[0], y = q[1], z = q[2], w = q[3];
    var ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
    return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
  }

  /* ---------------- tool impacts ---------------- */
  P._impact = function (kind) {
    var E = this.E, fx = E.effects, hit = this._ray(kind === 'axe' ? 2.6 : 2.9), p = hit.p, f = E.player.forward;
    var back = [-f[0], 0, -f[2]];
    if (kind === 'axe') {
      if (hit.type === 'tree') this._chopTree(hit);
      else if (hit.type === 'felled') this._chopFelled(hit.ref, p);
      else if (hit.type === 'stump') { if (fx) fx.chips(p, back, 10, [0.75, 0.6, 0.4]); this._sound('chop', 0.7); this._wear(1); }
      else if (hit.type === 'object') this._chopObject(hit.ref, p);
      else if (hit.type === 'vehicle') { if (fx) fx.sparks(p, 14, 3); this._sound('clang', 0.8); this._wear(3); }
      else if (hit.type === 'ground') {
        var sf = this._surfaceAt(p);
        if (sf.name === 'rock' || sf.name === 'ice') { if (fx) fx.sparks(p, 12, 3); this._sound('clink', 0.9); this._wear(3); }
        else { if (fx) fx.dust(p, 0.4, sf.dust); this._sound('dirt', 0.5); }
      } else if (hit.type === 'water') this._splash(p, 0.3);
    } else if (kind === 'hoe') {
      if (hit.type === 'ground') this._till(p);
      else if (hit.type === 'water') this._splash(p, 0.35);
      else if (hit.type === 'tree' || hit.type === 'stump' || hit.type === 'felled') { if (fx) fx.chips(p, back, 4); this._sound('chop', 0.4); }
      else if (hit.type === 'object' && hit.ref) { this._nudge(hit.ref, f, 2.5); this._sound('thud', 0.4); }
    } else if (kind === 'rake') {
      this._rakeTarget = hit.type === 'ground' ? p : null;
      if (hit.type === 'water') this._splash(p, 0.15);
    }
  };
  P._wear = function (n) {
    var s = this.slot;
    if (!SLOTS[s].dur) return;
    this.dur[s] = Math.max(0, this.dur[s] - n);
    this._hudDirty = true;
    if (this.dur[s] <= 0) { this.broken[s] = 15; TERRA.ui.toast('Your ' + SLOTS[s].name.toLowerCase() + ' went blunt — sharpening for 15 s', 'warn'); this._sound('clink', 0.6); }
  };
  P._surfaceAt = function (p) {
    var E = this.E, Sf = TERRA.game.Surfaces, env = E.environment.env;
    var e = 0.6, gx = (E.groundHeight(p[0] + e, p[2]) - E.groundHeight(p[0] - e, p[2])) / (2 * e), gz = (E.groundHeight(p[0], p[2] + e) - E.groundHeight(p[0], p[2] - e)) / (2 * e);
    var name = Sf.classify(env, E.environment.local, Math.hypot(gx, gz), 0, Sf.puddleAt(E, p[0], p[2], env));
    return Sf.info(name, env, {});
  };
  P._splash = function (p, s) {
    var E = this.E;
    if (E.effects) E.effects.splash(p, s);
    if (E.watersim) E.watersim.addDrop(p[0], p[2], 0.6, 0.06 * s * 3);
    this._sound('splash', s * 2);
  };
  P._nudge = function (ob, f, sp) { ob.vel[0] += f[0] * sp; ob.vel[1] += 1.5; ob.vel[2] += f[2] * sp; ob.sleep = 0; };

  /** Find the vegetation record of the tree whose trunk was hit. */
  P._treeRecord = function (hit) {
    var veg = this.E.vegetation, best = null, bd = 1.0;
    veg._eachTree(hit.cx, hit.cz, 2, function (a, k, y) {
      var d = Math.hypot(a[k] - hit.cx, a[k + 2] - hit.cz);
      if (d < bd) { bd = d; best = { x: a[k], y: y, z: a[k + 2], rot: a[k + 3], scale: a[k + 4], type: a[k + 5] | 0, variant: a[k + 6] | 0, seed: a[k + 7] }; }
    });
    return best;
  };
  P._chopTree = function (hit) {
    var E = this.E, fx = E.effects, f = E.player.forward, p = hit.p;
    var key = hit.cx.toFixed(1) + ',' + hit.cz.toFixed(1);
    var rec = this.trees[key];
    if (!rec) {
      var tr = this._treeRecord(hit);
      if (!tr) { if (fx) fx.chips(p, [-f[0], 0, -f[2]], 8); this._sound('chop', 0.7); return; }
      if (tr.type === 10) { if (fx) fx.sparks(p, 14, 3.5); this._sound('clink', 1); this._wear(4); return; }   // boulder
      if (tr.type === 9 && hit.r > 2.5) { if (fx) fx.chips(p, [-f[0], 0, -f[2]], 10); this._sound('chop', 0.8); this._wear(1); return; }   // ancient giant: too big
      var need = Math.round(3 + hit.r * 26 * (tr.type === 7 ? 0.4 : 1));
      rec = this.trees[key] = { tree: tr, r: hit.r, hits: 0, need: need };
    }
    rec.hits++;
    this._wear(1);
    var tr2 = rec.tree, cactus = tr2.type === 7;
    var nrm = [p[0] - hit.cx, 0, p[2] - hit.cz], nl = Math.hypot(nrm[0], nrm[2]) || 1;
    if (fx) {
      fx.chips(p, [nrm[0] / nl, 0, nrm[2] / nl], 10 + rec.r * 20, cactus ? [0.45, 0.62, 0.3] : (rec.hits > rec.need * 0.5 ? [0.85, 0.72, 0.5] : [0.42, 0.33, 0.24]));
      // shaken leaves drift down from the crown
      var m = E.models && E.models.trees[tr2.type] && E.models.trees[tr2.type][tr2.variant % E.models.variants];
      var H = m ? m.height * tr2.scale : 8;
      if (!cactus && tr2.type !== 6) for (var l = 0; l < 3; l++) fx.emit(TERRA.game.Effects.K.LEAF, [tr2.x + (Math.random() - 0.5) * 3, tr2.y + H * (0.55 + Math.random() * 0.35), tr2.z + (Math.random() - 0.5) * 3], [0, -0.3, 0], 4 + Math.random() * 3, 0.06, 0, [0.3, 0.42, 0.12], 1, Math.random() * 6);
    }
    this._sound('chop', 0.9 + Math.random() * 0.2);
    if (rec.hits >= rec.need - 2 && rec.hits < rec.need) this._sound('creak', 0.7);
    if (rec.hits >= rec.need) { delete this.trees[key]; this._fell(tr2, rec.r, [hit.cx - E.player.pos[0], hit.cz - E.player.pos[2]]); }
    else if (rec.hits === 1) TERRA.ui.toast('Chopping… ' + rec.need + ' hits to fell this tree');
  };
  /** Remove a standing tree from the world and start its fall. dir: horizontal fall direction. */
  P._fell = function (tr, r, dir) {
    var E = this.E, models = E.models;
    var m = models.trees[tr.type] && models.trees[tr.type][tr.variant % models.variants];
    var H = m ? m.height * tr.scale : 8;
    E.edits.vegRemove.push(tr.x, tr.z, 0.45);
    E.vegetation._dirtyFar = true;
    var dl = Math.hypot(dir[0], dir[1]) || 1;
    var ang = Math.atan2(dir[1] / dl, dir[0] / dl) + (Math.random() - 0.5) * 0.3;
    this.felled.push({ x: tr.x, y: tr.y, z: tr.z, rot: tr.rot, scale: tr.scale, type: tr.type, variant: tr.variant, seed: tr.seed, dir: ang, theta: 0.02, w: 0.12, H: H, r: r, state: 'falling', hits: 0, t: 0 });
    this.stumps.push({ x: tr.x, y: tr.y, z: tr.z, r: Math.max(0.1, r * 0.92), rot: Math.random() * 6.28 });
    this._sound('crack', 1);
    TERRA.ui.toast('Timber!');
  };
  /** Rigid rod pivoting on its stump: θ'' = 3g/(2H)·sin θ, until the crown meets the ground. */
  P._updateFelled = function (dt) {
    if (!this.felled.length || dt <= 0) return;
    var E = this.E, fx = E.effects;
    for (var i = 0; i < this.felled.length; i++) {
      var F = this.felled[i];
      if (F.state !== 'falling') continue;
      F.t += dt;
      var sub = 4, h = Math.min(dt, 0.05) / sub;
      for (var s = 0; s < sub; s++) {
        F.w += 3 * 9.81 / (2 * Math.max(3, F.H)) * Math.sin(F.theta) * h;
        F.theta += F.w * h;
        var c = Math.cos(F.dir), sn = Math.sin(F.dir);
        // ground under the upper trunk / crown
        var L = F.H * 0.62, tx = F.x + c * Math.sin(F.theta) * L, tz = F.z + sn * Math.sin(F.theta) * L, ty = F.y + 0.42 + Math.cos(F.theta) * L;
        var gh = E.groundHeight(tx, tz) + Math.max(0.25, F.r * 1.2);
        if (ty <= gh || F.theta > 1.58) {
          if (F.w > 0.4) {
            var imp = F.w * L;
            if (fx) {
              var cp = [F.x + c * Math.sin(F.theta) * F.H * 0.75, gh, F.z + sn * Math.sin(F.theta) * F.H * 0.75];
              fx.dust(cp, U.clamp01(imp / 8), [0.45, 0.42, 0.33]); fx.dust([F.x + c * L * 0.5, gh, F.z + sn * L * 0.5], 0.6, [0.45, 0.42, 0.33]);
              for (var l = 0; l < 26; l++) fx.emit(TERRA.game.Effects.K.LEAF, [cp[0] + (Math.random() - 0.5) * 4, cp[1] + Math.random() * 2, cp[2] + (Math.random() - 0.5) * 4], [(Math.random() - 0.5) * 3, 1 + Math.random() * 3, (Math.random() - 0.5) * 3], 3 + Math.random() * 4, 0.06, 0, [0.3 + Math.random() * 0.1, 0.42, 0.12], 1, Math.random() * 6);
              fx.chips(cp, [0, 1, 0], 14, [0.4, 0.32, 0.22]);
              var dc = Math.hypot(cp[0] - E.camera.world[0], cp[2] - E.camera.world[2]);
              fx.shake = Math.max(fx.shake, U.clamp01(1 - dc / 40) * 0.35);
            }
            this._sound('crash', U.clamp01(imp / 10) + 0.3, [F.x, F.y, F.z]);
            // the trunk flattens the grass along its length
            if (E.interaction) for (var g = 2; g < F.H; g += 2) E.interaction.stamps.push({ kind: 1, x: F.x + c * g, z: F.z + sn * g, r: 1.2 });
            F.w = -F.w * 0.12;          // small bounce
            if (Math.abs(F.w) < 0.05) F.w = 0;
            F.theta = Math.min(F.theta, 1.6);
            if (ty <= gh - 0.05) F.theta -= 0.002;
          } else { F.w = 0; F.state = 'rest'; break; }
        }
      }
    }
  };
  /** Instances for the vegetation renderer (felled trees share the tree meshes, tilted in the shader). */
  P.vegInstances = function (add, cx, cz) {
    for (var i = 0; i < this.felled.length; i++) {
      var F = this.felled[i];
      if (Math.abs(F.x - cx) > 900 || Math.abs(F.z - cz) > 900) continue;
      var dirQ = Math.floor(((F.dir / (Math.PI * 2)) % 1 + 1) % 1 * 256) % 256;
      var extra = dirQ + U.clamp(F.theta / 1.6, 0.0005, 0.9995);
      add(F.type, F.variant, F.x, F.y, F.z, F.rot, F.scale, F.seed, extra);
    }
  };
  P._trunkSeg = function (F) {
    var c = Math.cos(F.dir), s = Math.sin(F.dir), st = Math.sin(F.theta), ct = Math.cos(F.theta), L = F.H * 0.7;
    return [[F.x, F.y + 0.42, F.z], [F.x + c * st * L, F.y + 0.42 + ct * L, F.z + s * st * L]];
  };
  /** Collision circles for the player and bikes: stumps and lying trunks. */
  P.colliders = function (x, z, radius, out) {
    for (var i = 0; i < this.stumps.length; i++) { var S = this.stumps[i]; if (Math.abs(S.x - x) < radius + 1 && Math.abs(S.z - z) < radius + 1) out.push(S.x, S.z, S.r, S.y); }
    for (var f = 0; f < this.felled.length; f++) {
      var F = this.felled[f];
      if (Math.abs(F.x - x) > radius + F.H || Math.abs(F.z - z) > radius + F.H) continue;
      var c = Math.cos(F.dir), s = Math.sin(F.dir), st = Math.sin(F.theta);
      for (var g = 1.2; g < F.H * 0.65; g += Math.max(0.6, F.r * 1.5)) out.push(F.x + c * st * g, F.z + s * st * g, F.r * 0.9, F.y);
    }
  };
  /** Buck a fallen trunk into logs (4 hits). */
  P._chopFelled = function (F, p) {
    var E = this.E, fx = E.effects;
    F.hits++;
    this._wear(1);
    if (fx) fx.chips(p, [0, 1, 0], 12, [0.82, 0.68, 0.46]);
    this._sound('chop', 1);
    if (F.hits < 4) return;
    this._buck(F, 0);
  };
  P._buck = function (F, blast) {
    var E = this.E, th = E.throwables, fx = E.effects;
    var i = this.felled.indexOf(F); if (i >= 0) this.felled.splice(i, 1);
    if (!th) return;
    var seg = this._trunkSeg(F), dir = [seg[1][0] - seg[0][0], seg[1][1] - seg[0][1], seg[1][2] - seg[0][2]], L = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    dir = [dir[0] / L, dir[1] / L, dir[2] / L];
    var r = U.clamp(F.r * 0.85, 0.09, 0.45), n = U.clamp(Math.floor(L / 2.0), 1, 4), segL = Math.min(2.2, L / n);
    // orientation: object y axis along the trunk
    var axis = [dir[2], 0, -dir[0]], al = Math.hypot(axis[0], axis[2]) || 1, ang = Math.acos(U.clamp(dir[1], -1, 1));
    var q = qaxis(axis[0] / al, 0, axis[2] / al, ang);
    for (var k = 0; k < n; k++) {
      var t = (k + 0.5) * L / n;
      var pos = [seg[0][0] + dir[0] * t, seg[0][1] + dir[1] * t + r * 0.3, seg[0][2] + dir[2] * t];
      var gh = E.groundHeight(pos[0], pos[2]); if (pos[1] < gh + r) pos[1] = gh + r + 0.02;
      var vel = blast ? [(Math.random() - 0.5) * blast * 4, blast * (2 + Math.random() * 3), (Math.random() - 0.5) * blast * 4] : [0, 0.5, 0];
      th.spawn(K_LOG, pos, vel, { size: [r, segL * 0.46, r], q: q, w: [0, 0, 0] });
    }
    if (fx) {
      var cp = seg[1];
      for (var l = 0; l < 30; l++) fx.emit(TERRA.game.Effects.K.LEAF, [cp[0] + (Math.random() - 0.5) * 4, cp[1] + Math.random() * 1.5, cp[2] + (Math.random() - 0.5) * 4], [(Math.random() - 0.5) * 2, 1 + Math.random() * 2, (Math.random() - 0.5) * 2], 3 + Math.random() * 4, 0.06, 0, [0.32, 0.4, 0.13], 1, Math.random() * 6);
      fx.chips(cp, [0, 1, 0], 24, [0.35, 0.28, 0.2]);
    }
    if (!blast) { this._sound('crack', 0.6); TERRA.ui.toast(n + ' log' + (n > 1 ? 's' : '') + ' — press E to pick one up'); }
  };
  P._chopObject = function (ob, p) {
    var E = this.E, fx = E.effects, th = E.throwables, f = E.player.forward;
    var T = TT.TYPES[ob.kind];
    if (ob.kind === 2) {                     // crate: smash to planks
      if (fx) { fx.chips(ob.pos, [0, 1, 0], 40, [0.8, 0.66, 0.44]); fx.dust(ob.pos, 0.4, [0.6, 0.55, 0.45]); }
      th.remove(ob); this._sound('smash', 1); return;
    }
    if (ob.kind === K_LOG) {                 // split a big log
      var sz = th.sizeFor(ob);
      if (fx) fx.chips(p, [0, 1, 0], 14, [0.85, 0.72, 0.5]);
      this._sound('chop', 1); this._wear(1);
      ob.splitHits = (ob.splitHits || 0) + 1;
      if (ob.splitHits >= 3 && sz[1] > 0.45) {
        var ax = qrotv(ob.q, [0, 1, 0]);
        for (var s = -1; s <= 1; s += 2) th.spawn(K_LOG, [ob.pos[0] + ax[0] * sz[1] * 0.5 * s, ob.pos[1] + 0.05, ob.pos[2] + ax[2] * sz[1] * 0.5 * s], [ax[0] * s, 1, ax[2] * s], { size: [sz[0], sz[1] * 0.48, sz[0]], q: ob.q, w: [0, 0, 0] });
        th.remove(ob);
      }
      return;
    }
    if (ob.kind === 4 || ob.kind === K_STONE) { if (fx) fx.sparks(p, 10, 3); this._sound('clink', 0.9); this._wear(3); this._nudge(ob, f, 1); return; }
    if (ob.kind === K_DYN) { this._nudge(ob, f, 3); return; }
    this._nudge(ob, f, 4); this._sound(T.shape === 'sphere' ? 'boing' : 'thud', 0.6);
  };

  /* ---------------- hoe & rake ---------------- */
  P._editBrush = function (r, s) { return { radius: r, hardness: 0.55, falloff: 1.2, noise: 0.15, strength: s, smoothing: 0 }; };
  P._till = function (p) {
    var E = this.E, ed = E.edits, fx = E.effects, sf = this._surfaceAt(p);
    if (sf.name === 'rock' || sf.name === 'ice') { if (fx) fx.sparks(p, 8, 2.5); this._sound('clink', 0.8); this._wear(5); return; }
    var wet = E.environment.env.wetness > 0.5 || sf.name === 'mud' || sf.name === 'puddle';
    var bb = ed.applyPaint(p[0], p[2], this._editBrush(0.95, 1), 0.7, wet ? 9 : 2);
    // a shallow furrow at the nearest height samples
    var B = this._editBrush(0.8, 0.012);
    var bb2 = ed.applyHeight('lower', p[0], p[2], B, 0.4, function (x, z) { return E.groundHeight(x, z); });
    this._commit([Math.min(bb[0], bb2[0]), Math.min(bb[1], bb2[1]), Math.max(bb[2], bb2[2]), Math.max(bb[3], bb2[3])]);
    if (E.interaction) E.interaction.stamps.push({ kind: 4, x: p[0], z: p[2], r: 0.75, s: 0.85 });
    if (fx) { fx.chips([p[0], p[1] + 0.05, p[2]], [0, 1, 0], 12, wet ? [0.25, 0.19, 0.13] : [0.42, 0.32, 0.22]); if (!wet && sf.dry > 0.3) fx.dust(p, 0.35, sf.dust); }
    this._sound(sf.name === 'snow' ? 'snow' : 'dirt', 0.9);
    this._wear(sf.name === 'sand' ? 0 : 1);
  };
  P._rakeStep = function (f) {
    var E = this.E, p0 = this._rakeTarget, fx = E.effects;
    if (!p0) return;
    var pl = E.player, fw = [-Math.sin(pl.yaw), -Math.cos(pl.yaw)];
    // the rake head travels from the far point back toward the player
    var d = 1.0 * f, x = p0[0] - fw[0] * d, z = p0[2] - fw[1] * d, y = E.groundHeight(x, z);
    var sf = this._surfaceAt([x, y, z]);
    if (E.interaction) E.interaction.stamps.push({ kind: 5, x: x, z: z, ang: pl.yaw, r: 0.2, len: 0.12, s: sf.soft > 0.1 ? 0.55 : 0.2 });
    if (f < 0.15) {
      // level small bumps once per stroke
      var bb = E.edits.applyHeight('smooth', x, z, this._editBrush(0.9, 0.5), 0.12, function (a, b) { return E.groundHeight(a, b); });
      this._commit(bb);
      this._sound('rake', sf.name === 'sand' || sf.name === 'snow' ? 0.8 : 1);
      this._wear(sf.name === 'rock' ? 2 : 0.25);
    }
    if (fx) {
      if (sf.name === 'leaves' || (E.environment.local.forest > 0.3 && Math.random() < 0.6)) fx.emit(TERRA.game.Effects.K.LEAF, [x, y + 0.05, z], [fw[0] * -0.8, 0.4, fw[1] * -0.8], 1.5 + Math.random(), 0.05, 0, [0.42, 0.3, 0.12], 1, Math.random() * 6);
      if (sf.dry > 0.3 && (sf.name === 'sand' || sf.name === 'path') && Math.random() < 0.4) fx.dust([x, y, z], 0.2, sf.dust);
      if (sf.name === 'snow' && Math.random() < 0.5) fx.dust([x, y, z], 0.25, [0.95, 0.96, 1]);
    }
  };
  /** Push a terrain/paint edit to the chunks and vegetation (persistent, saved with the world). */
  P._commit = function (bb) {
    var E = this.E;
    if (!bb) return;
    var p = this._pendingBB;
    this._pendingBB = p ? [Math.min(p[0], bb[0]), Math.min(p[1], bb[1]), Math.max(p[2], bb[2]), Math.max(p[3], bb[3])] : bb.slice();
    var self = this;
    if (!this._commitT) this._commitT = setTimeout(function () {
      self._commitT = null; var b = self._pendingBB; self._pendingBB = null;
      if (!b) return;
      E.chunks.onEdit(b[0], b[1], b[2], b[3]);
      if (E.vegetation) { E.vegetation.invalidateField(); E.vegetation._dirtyFar = true; }
    }, 30);
  };

  /* ---------------- picking up & throwing ---------------- */
  P.pickUp = function () {
    var E = this.E, th = E.throwables;
    if (!th || this.held) return;
    var hit = this._ray(3.0);
    if (hit.type !== 'object') { if (hit.type === 'felled') TERRA.ui.toast('Chop the trunk into logs first (axe)'); return; }
    var ob = hit.ref, m = ob.mass;
    if (m > 140) { TERRA.ui.toast('Too heavy to lift (' + Math.round(m) + ' kg)', 'warn'); return; }
    if (ob.fuse !== undefined && ob.fuse < 0.6) return;
    ob.held = true; ob.sleep = 0; this.held = ob;
    if (this.slot !== 0) { this.slot = 0; this._hudDirty = true; }
    this._sound('pick', 0.6);
  };
  P.drop = function (gentle) {
    var ob = this.held; if (!ob) return;
    ob.held = false; this.held = null;
    var pv = this.E.player.vel;
    ob.vel = [pv[0], pv[1] + (gentle ? 0 : 0.5), pv[2]];
    ob.sleep = 0;
  };
  P._handWorld = function () {
    var E = this.E, c = E.camera.world, f = E.player.forward, yaw = E.player.yaw;
    var r = [Math.cos(yaw), 0, -Math.sin(yaw)];
    return [c[0] + f[0] * 0.55 + r[0] * 0.24, c[1] + f[1] * 0.55 - 0.22, c[2] + f[2] * 0.55 + r[2] * 0.24];
  };
  P._carry = function () {
    var ob = this.held, E = this.E, th = E.throwables;
    if (th.objs.indexOf(ob) < 0) { this.held = null; return; }
    var rad = th.smpFor(ob).radius, f = E.player.forward, c = E.camera.world;
    var dist = 0.55 + rad;
    var p = [c[0] + f[0] * dist, c[1] + f[1] * dist - 0.25 - rad * 0.3, c[2] + f[2] * dist];
    var gh = E.groundHeight(p[0], p[2]); if (p[1] < gh + rad * 0.6) p[1] = gh + rad * 0.6;
    ob.pos = p; ob.vel = E.player.vel.slice(); ob.w = [0, 0, 0];
    var yaw = E.player.yaw;
    ob.q = ob.kind === K_LOG ? qmul(qaxis(0, 1, 0, yaw), qaxis(0, 0, 1, Math.PI / 2)) : qaxis(0, 1, 0, yaw);
  };
  P._throwParams = function () {
    var E = this.E, id = SLOTS[this.slot].id, th = E.throwables;
    var kind = id === 'stone' ? K_STONE : (id === 'dynamite' ? K_DYN : (this.held ? this.held.kind : K_STONE));
    var mass = this.held ? this.held.mass : TT.TYPES[kind].density * th.samples[kind].vol;
    var energy = U.mix(18, 230, Math.pow(this.charge, 1.2));       // joules from the arm
    var sp = Math.min(26, Math.sqrt(2 * energy / Math.max(0.2, mass)));
    var f = E.player.forward, pv = E.player.vel;
    // aim slightly above the crosshair
    var dir = [f[0], f[1] + 0.12, f[2]], dl = Math.hypot(dir[0], dir[1], dir[2]);
    var vel = [dir[0] / dl * sp + pv[0] * 0.8, dir[1] / dl * sp + pv[1] * 0.5, dir[2] / dl * sp + pv[2] * 0.8];
    return { kind: kind, vel: vel, pos: this.held ? this.held.pos.slice() : this._handWorld() };
  };
  P._preview = function () {
    var E = this.E;
    if (!E.effects || E.settings.controls.throwPreview === false) return;
    var tp = this._throwParams(), p = tp.pos.slice(), v = tp.vel.slice(), pts = [];
    var h = 1 / 30;
    for (var i = 0; i < 90; i++) {
      v[1] -= 9.81 * h;
      var k = Math.exp(-0.02 * h); v[0] *= k; v[2] *= k;
      p = [p[0] + v[0] * h, p[1] + v[1] * h, p[2] + v[2] * h];
      if (i % 2 === 0) pts.push([p[0], p[1], p[2], 0.03]);
      if (p[1] < E.groundHeight(p[0], p[2])) { pts.push([p[0], E.groundHeight(p[0], p[2]) + 0.05, p[2], 0.12]); break; }
    }
    E.effects.setPreview(pts);
  };
  P._throw = function () {
    var E = this.E, th = E.throwables;
    if (!th) return;
    var tp = this._throwParams();
    this.charging = false;
    if (this.held) {
      var ob = this.held; ob.held = false; this.held = null;
      ob.vel = tp.vel; ob.w = [(Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6]; ob.sleep = 0;
    } else {
      var o = th.spawn(tp.kind, tp.pos, tp.vel, tp.kind === K_DYN ? { fuse: Math.max(0.05, this.fuse) } : {});
      if (tp.kind === K_DYN) { this.fuseLit = false; o.w = [(Math.random() - 0.5) * 10, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 10]; }
    }
    this.anim = { kind: 'throw', t: 0 };
    this._sound('swish', 0.4 + this.charge * 0.6);
    if (E.effects) E.effects.setPreview(null);
  };
  P._cancelCharge = function () {
    this.charging = false;
    if (this.fuseLit) {                       // pinch out the fuse? no — drop the lit stick at your feet
      var th = this.E.throwables;
      if (th) { var p = this._handWorld(); th.spawn(K_DYN, p, this.E.player.vel.slice(), { fuse: this.fuse }); }
      this.fuseLit = false;
      TERRA.ui.toast('Dropped the lit dynamite — run!', 'warn');
    }
    if (this.E.effects) this.E.effects.setPreview(null);
  };
  P._fuseFx = function (p, dt) {
    var fx = this.E.effects;
    this._hissT = (this._hissT || 0) - dt;
    if (fx && Math.random() < 0.8) { fx.sparks([p[0], p[1] + 0.1, p[2]], 2, 1.2); if (Math.random() < 0.2) fx.emit(TERRA.game.Effects.K.SMOKE, [p[0], p[1] + 0.12, p[2]], [0, 0.4, 0], 1.2, 0.04, 0.25, [0.6, 0.6, 0.6], 0.25); }
    if (this._hissT <= 0) { this._hissT = 0.07; this._sound('hiss', 0.5, p); }
  };

  /* ---------------- dynamite ---------------- */
  P.explode = function (pos, power, obj) {
    var E = this.E, fx = E.effects, cam = E.camera.world;
    var wi = E.waterAt(pos[0], pos[2]), gh = E.groundHeight(pos[0], pos[2]);
    var inWater = wi.level > -1e4 && wi.type !== 4 && pos[1] < wi.level + 0.3;
    var R = 1.4 + power * 1.8;
    if (fx) fx.explosion([pos[0], Math.max(pos[1], gh), pos[2]], power, inWater);
    if (inWater) {
      if (E.watersim) { E.watersim.addDrop(pos[0], pos[2], 4, 0.6); E.watersim.addDrop(pos[0], pos[2], 1.5, 0.5); }
      if (fx) for (var c = 0; c < 40; c++) { var a = Math.random() * 6.28, s = Math.random() * 2; fx.emit(TERRA.game.Effects.K.WATER, [pos[0] + Math.cos(a) * s, wi.level, pos[2] + Math.sin(a) * s], [Math.cos(a) * 2, 8 + Math.random() * 10, Math.sin(a) * 2], 1.8 + Math.random(), 0.12 + Math.random() * 0.1, 0.4, [0.92, 0.95, 0.98], 0.5); }
      if (E.interaction) E.interaction.stamps.push({ kind: 2, x: pos[0], z: pos[2], r: 6, s: 1 });
    } else if (pos[1] < gh + 1.5) {
      // crater: bowl with a raised rim, scorched and stripped of grass (persistent edit)
      var ed = E.edits, depth = 0.55 * power;
      var x0 = Math.floor(pos[0] - R * 1.3), x1 = Math.ceil(pos[0] + R * 1.3), z0 = Math.floor(pos[2] - R * 1.3), z1 = Math.ceil(pos[2] + R * 1.3);
      for (var z = z0; z <= z1; z++) for (var x = x0; x <= x1; x++) {
        var r = Math.hypot(x - pos[0], z - pos[2]) / R;
        if (r > 1.3) continue;
        var d = r < 1 ? -depth * Math.pow(1 - r * r, 1.5) : 0;
        d += depth * 0.28 * Math.exp(-Math.pow((r - 1.0) / 0.18, 2));
        if (d !== 0) ed._addHeight(x, z, d);
      }
      var bb = ed.applyPaint(pos[0], pos[2], this._editBrush(R * 1.1, 1), 1, 10);
      this._commit([Math.min(bb[0], x0 - 2), Math.min(bb[1], z0 - 2), Math.max(bb[2], x1 + 2), Math.max(bb[3], z1 + 2)]);
      if (E.interaction) E.interaction.stamps.push({ kind: 1, x: pos[0], z: pos[2], r: R * 2.2 });
    }
    // trees: close ones are blown over, stumps and fallen trunks are shattered
    var veg = E.vegetation;
    if (veg) {
      var cols = veg.collidersNear(pos[0], pos[2], R + 2.5, true), self = this, done = {};
      for (var i = 0; i < cols.length; i += 4) {
        var dx = cols[i] - pos[0], dz = cols[i + 1] - pos[2], dd = Math.hypot(dx, dz);
        if (dd > R + 1.5 || cols[i + 2] > 1.2) continue;
        var key = cols[i].toFixed(1) + ',' + cols[i + 1].toFixed(1);
        if (done[key]) continue; done[key] = 1;
        var tr = self._treeRecord({ cx: cols[i], cz: cols[i + 1] });
        if (tr && tr.type !== 10 && tr.type !== 9) self._fell(tr, cols[i + 2], [dx || 0.1, dz || 0.1]);
      }
    }
    for (var s = this.stumps.length - 1; s >= 0; s--) { var St = this.stumps[s]; if (Math.hypot(St.x - pos[0], St.z - pos[2]) < R) { if (fx) fx.chips([St.x, St.y + 0.3, St.z], [0, 1, 0], 20, [0.5, 0.4, 0.28]); this.stumps.splice(s, 1); } }
    for (var f = this.felled.length - 1; f >= 0; f--) { var F = this.felled[f]; if (F.state === 'rest' && Math.hypot(F.x - pos[0], F.z - pos[2]) < R + F.H * 0.4) this._buck(F, power); }
    // objects: radial impulse, other dynamite chain-detonates
    var th = E.throwables;
    if (th) for (var k = 0; k < th.objs.length; k++) {
      var ob = th.objs[k]; if (ob === obj) continue;
      var vx = ob.pos[0] - pos[0], vy = ob.pos[1] - pos[1] + 0.5, vz = ob.pos[2] - pos[2], dl = Math.hypot(vx, vy, vz);
      if (dl > R * 4) continue;
      if (ob.kind === K_DYN && dl < R * 1.4 && ob.fuse !== undefined) ob.fuse = Math.min(ob.fuse, 0.08 + Math.random() * 0.25);
      else if (ob.kind === K_DYN && dl < R * 1.4) ob.fuse = 0.08 + Math.random() * 0.25;
      var imp = power * 900 * Math.pow(1 - dl / (R * 4), 2) / Math.sqrt(Math.max(1, ob.mass));
      ob.vel[0] += vx / dl * imp; ob.vel[1] += Math.abs(vy / dl) * imp + imp * 0.4; ob.vel[2] += vz / dl * imp;
      ob.w[0] += (Math.random() - 0.5) * imp; ob.w[2] += (Math.random() - 0.5) * imp;
      ob.sleep = 0; ob.frozen = false;
      if (ob.held) this.drop(false);
    }
    if (E.vehicles) E.vehicles.impulse(pos, power * 1.6, R * 4);
    // the player is knocked back
    var pl = E.player, pdx = pl.pos[0] - pos[0], pdz = pl.pos[2] - pos[2], pdy = pl.pos[1] + 1 - pos[1], pd = Math.hypot(pdx, pdy, pdz);
    if (pd < R * 3 && !(E.vehicles && E.vehicles.current) && pl.mode !== 'free') {
      var kb = (1 - pd / (R * 3)) * 11 * power;
      pl.vel[0] += pdx / pd * kb; pl.vel[1] += 3 + kb * 0.5; pl.vel[2] += pdz / pd * kb; pl.onGround = false;
    }
    // sound travels at 343 m/s
    var dist = Math.hypot(pos[0] - cam[0], pos[1] - cam[1], pos[2] - cam[2]);
    var self2 = this;
    setTimeout(function () { self2._sound('boom', U.clamp01(1.3 - dist / 600), pos, true); }, Math.min(3000, dist / 343 * 1000));
  };

  /* ---------------- audio ---------------- */
  P._sound = function (kind, g, pos, ignoreDist) {
    var A = this.E.audio;
    if (!A || !A.ready || A.muted) return;
    if (pos && !ignoreDist) { var c = this.E.camera.world, d = Math.hypot(pos[0] - c[0], pos[1] - c[1], pos[2] - c[2]); g *= U.clamp01(1.15 - d / 90); }
    if (g < 0.02) return;
    var r = 0.9 + Math.random() * 0.2;
    switch (kind) {
      case 'swish': A._burst({ freq: 1400 * r, q: 0.8, len: 0.2, gain: 0.12 * g, sweep: 500, attack: 0.04 }); break;
      case 'chop': A._burst({ buf: A.brown, freq: 280 * r, type: 'lowpass', q: 1, len: 0.14, gain: 0.7 * g }); A._burst({ freq: 1700 * r, q: 3, len: 0.05, gain: 0.3 * g }); A._tone({ f0: 210 * r, f1: 140, len: 0.08, gain: 0.05 * g, dest: A.fx }); break;
      case 'clink': A._tone({ f0: 2500 * r, f1: 2300, len: 0.3, gain: 0.05 * g, dest: A.fx }); A._tone({ f0: 3900 * r, len: 0.18, gain: 0.03 * g, dest: A.fx }); A._burst({ freq: 5000, type: 'highpass', len: 0.05, gain: 0.25 * g }); break;
      case 'clang': A._tone({ f0: 900 * r, f1: 860, len: 0.6, gain: 0.06 * g, dest: A.fx, wave: 'triangle' }); A._burst({ freq: 3000, q: 2, len: 0.08, gain: 0.3 * g }); break;
      case 'dirt': A._burst({ buf: A.brown, freq: 420 * r, type: 'lowpass', len: 0.22, gain: 0.5 * g }); A._burst({ freq: 1300 * r, q: 0.8, len: 0.12, gain: 0.15 * g, delay: 0.02 }); break;
      case 'snow': for (var s = 0; s < 4; s++) A._burst({ freq: 1500 + Math.random() * 1500, q: 2, len: 0.05, gain: 0.2 * g, delay: s * 0.02 }); break;
      case 'rake': A._burst({ freq: 2600 * r, q: 1.4, len: 0.42, gain: 0.13 * g, attack: 0.06 }); A._burst({ freq: 900 * r, q: 0.8, len: 0.35, gain: 0.08 * g, attack: 0.05 }); break;
      case 'creak': for (var c2 = 0; c2 < 5; c2++) A._burst({ freq: 900 + Math.random() * 1600, q: 9, len: 0.08, gain: 0.12 * g, delay: c2 * 0.09 }); A._tone({ f0: 110, f1: 70, len: 0.7, gain: 0.04 * g, dest: A.fx, wave: 'sawtooth' }); break;
      case 'crack': A._burst({ freq: 2200, q: 3, len: 0.1, gain: 0.5 * g }); for (var k = 0; k < 6; k++) A._burst({ freq: 700 + Math.random() * 2400, q: 6, len: 0.07, gain: 0.25 * g, delay: 0.05 + k * 0.11 }); A._tone({ f0: 90, f1: 55, len: 1.2, gain: 0.06 * g, dest: A.fx, wave: 'sawtooth' }); break;
      case 'crash': A._burst({ buf: A.brown, freq: 160, type: 'lowpass', len: 1.6, gain: 0.95 * g }); A._burst({ freq: 3800, q: 0.7, len: 1.4, gain: 0.25 * g, attack: 0.02 }); A._burst({ freq: 700, q: 1, len: 0.5, gain: 0.3 * g }); break;
      case 'splash': A._burst({ freq: 1100, q: 0.9, len: 0.4, gain: 0.4 * g, sweep: 500 }); break;
      case 'thud': A._burst({ buf: A.brown, freq: 200, type: 'lowpass', len: 0.25, gain: 0.5 * g }); break;
      case 'boing': A._tone({ f0: 380 * r, f1: 260, len: 0.25, gain: 0.05 * g, dest: A.fx }); break;
      case 'smash': A._burst({ freq: 1800, q: 1, len: 0.4, gain: 0.5 * g }); A._burst({ buf: A.brown, freq: 300, type: 'lowpass', len: 0.3, gain: 0.5 * g }); break;
      case 'pick': A._burst({ freq: 800, q: 1, len: 0.08, gain: 0.15 * g }); break;
      case 'light': A._burst({ freq: 3500, q: 1, len: 0.25, gain: 0.25 * g, attack: 0.01 }); break;
      case 'hiss': A._burst({ freq: 5200 + Math.random() * 1500, type: 'highpass', q: 0.7, len: 0.09, gain: 0.07 * g }); break;
      case 'stone': A._burst({ freq: 2100 * r, q: 2.5, len: 0.06, gain: 0.35 * g }); A._burst({ freq: 600, q: 1, len: 0.05, gain: 0.2 * g }); break;
      case 'log': A._burst({ buf: A.brown, freq: 260 * r, type: 'lowpass', len: 0.3, gain: 0.6 * g }); A._tone({ f0: 160 * r, f1: 120, len: 0.15, gain: 0.04 * g, dest: A.fx }); break;
      case 'boom':
        A._burst({ buf: A.brown, freq: 110, type: 'lowpass', q: 0.6, len: 3.2, attack: 0.01, gain: 1.0 * g, dest: A.amb });
        A._burst({ buf: A.brown, freq: 520, type: 'lowpass', len: 0.8, gain: 0.9 * g });
        A._burst({ freq: 2500, type: 'highpass', len: 0.18, gain: 0.6 * g });
        for (var b = 0; b < 6; b++) A._burst({ freq: 1500 + Math.random() * 2500, q: 2, len: 0.05, gain: 0.15 * g, delay: 0.3 + Math.random() * 1.2 });   // falling debris
        break;
    }
  };
  P._impactSound = function (o, v) {
    var T = TT.TYPES[o.kind], g = U.clamp01(v / 8);
    var kind = T.snd || (T.shape === 'sphere' ? 'boing' : (o.kind === 2 ? 'log' : 'thud'));
    this._sound(kind, g, o.pos);
    if (o.kind === K_STONE && v > 6 && this.E.effects && Math.random() < 0.3) this.E.effects.sparks(o.pos, 3, 2);
  };

  /* ---------------- view model & world meshes ---------------- */
  P._viewPose = function () {
    var id = SLOTS[this.slot].id, out = this.pose, E = this.E, pl = E.player;
    if (this.held) { this.drawKey = null; return null; }
    var base = BASE[id];
    var key = id === 'stone' ? 'rock' : id;
    if (this.anim) samplePose(ANIM[this.anim.kind].keys, this.anim.t, out);
    else if (this.charging) { var c = ease(Math.min(1, this.charge * 1.6)); for (var i = 0; i < 6; i++) out[i] = (base ? base[i] : 0) + (CHARGE[i] - (base ? base[i] : 0)) * c; }
    else if (base) for (var j = 0; j < 6; j++) out[j] = base[j];
    else { out[0] = 0.26; out[1] = -0.36; out[2] = -0.48; out[3] = 0.2; out[4] = 0; out[5] = 0; }
    // walk bob, sway and the switch-in motion
    var bob = pl.bobAmt || 0, ph = pl.bobPhase || 0;
    out[0] += Math.cos(ph) * 0.014 * bob + this.sway[0]; out[1] += -Math.abs(Math.sin(ph)) * 0.018 * bob + this.sway[1] - (this.switchT > 0 ? this.switchT * 1.2 : 0);
    out[3] += this.sway[1] * 1.5; out[4] += this.sway[0] * 1.5;
    if (pl.landDip) out[1] += pl.landDip * 0.5;
    this.drawKey = this.broken[this.slot] > 0 && !this.anim ? key : key;
    return out;
  };
  P._viewMatrix = function (frame, pose) {
    var q = eulerQ(pose[3], pose[4], pose[5]);
    m4QPS(this.mTmp, q, pose[0], pose[1], pose[2], 1);
    M.multiply(this.mModel, frame.cam.invView, this.mTmp);
    return this.mModel;
  };
  P.draw = function (frame, shadow, vp) {
    if (!frame) return;
    var gl = this.gl, G = this.G, R = this.E.renderer, o = frame.origin, planes = frame.cam.planes;
    var stumps = this.stumps.length, vis = this.visible && !shadow;
    if (!stumps && !vis) return;
    var p = shadow ? this.progShadow : this.prog;
    p.use();
    p.i('uShadowPass', shadow ? 1 : 0);
    if (shadow) p.m4('uShadowVP', vp); else p.tex('uAlbedoH', 0, R.tex.matAlbedo, gl.TEXTURE_2D_ARRAY);
    if (!shadow) p.v4('uState', this.E.environment.env.rain > 0.1 ? 0.6 : 0, 0, -10, -9).v4('uLamp', 0, 0, 0, 0);
    // stumps
    var sm = this.meshes.stump, cam = frame.cam.world;
    for (var i = 0; i < stumps; i++) {
      var S = this.stumps[i];
      if (Math.hypot(S.x - cam[0], S.z - cam[2]) > (shadow ? 120 : 400)) continue;
      if (!shadow && !M.sphereInFrustum(planes, S.x - o[0], S.y, S.z - o[1], S.r * 2.5, 0)) continue;
      m4QPS(this.mW, qaxis(0, 1, 0, S.rot), S.x - o[0], S.y - 0.02, S.z - o[1], S.r);
      p.m4('uModel', this.mW).m4('uLocal', M.mat4());
      if (!shadow) p.f('uRing', S.r * 40);
      gl.bindVertexArray(sm.vao); gl.drawElements(gl.TRIANGLES, sm.count, sm.type, 0);
      G.stats.drawCalls++; G.stats.triangles += sm.tris;
    }
    // first-person view model
    if (vis) {
      var pose = this._viewPose();
      if (pose && this.drawKey) {
        var mesh = this.meshes[this.drawKey];
        p.m4('uModel', this._viewMatrix(frame, pose)).m4('uLocal', M.mat4()).f('uRing', 30);
        p.v4('uState', 0, 0, -10, -9);
        gl.bindVertexArray(mesh.vao); gl.drawElements(gl.TRIANGLES, mesh.count, mesh.type, 0);
        G.stats.drawCalls++; G.stats.triangles += mesh.tris;
      }
    }
    gl.bindVertexArray(null);
  };
  /** The view model is screen-locked: generated frames must not extrapolate it with the world. */
  P.drawMotion = function (frame) {
    if (!this.visible || !frame || this.held) return;
    var pose = this._viewPose(); if (!pose || !this.drawKey) return;
    var gl = this.gl, p = this.progMotion.use(), mesh = this.meshes[this.drawKey];
    p.i('uShadowPass', 0).f('uMotionFlag', 2).v3('uLinVel', 0, 0, 0).v3('uAngVel', 0, 0, 0).v3('uCOM', 0, 0, 0);
    p.m4('uModel', this._viewMatrix(frame, pose)).m4('uLocal', M.mat4());
    gl.bindVertexArray(mesh.vao); gl.drawElements(gl.TRIANGLES, mesh.count, mesh.type, 0);
    gl.bindVertexArray(null);
    p.f('uMotionFlag', 1);
  };

  /* ---------------- HUD ---------------- */
  P._buildDom = function () {
    var hud = document.getElementById('hud') || document.body;
    var bar = document.createElement('div'); bar.id = 'toolbar';
    bar.innerHTML = SLOTS.map(function (s, i) {
      return '<div class="tb-slot" data-i="' + i + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + ICONS[s.id] + '</svg><kbd>' + (i + 1) + '</kbd><i class="tb-dur"><b></b></i><span class="tb-name">' + s.name + '</span></div>';
    }).join('') + '<div class="tb-charge"><b></b></div>';
    hud.appendChild(bar);
    this.dom = { bar: bar, slots: bar.querySelectorAll('.tb-slot'), charge: bar.querySelector('.tb-charge'), chargeB: bar.querySelector('.tb-charge b') };
    this._hudDirty = true;
  };
  P._hud = function (dt) {
    var E = this.E, show = this.visible || (E.player.mode === 'third' && !(E.vehicles && E.vehicles.current) && E.state === 'playing');
    this.dom.bar.classList.toggle('hidden', !show);
    if (!show) return;
    if (this.charging) { this.dom.charge.style.opacity = '1'; this.dom.chargeB.style.width = Math.round(this.charge * 100) + '%'; this.dom.chargeB.className = this.fuseLit ? 'lit' : ''; }
    else this.dom.charge.style.opacity = '0';
    this._hudT = (this._hudT || 0) - dt;
    if (!this._hudDirty && this._hudT > 0) return;
    this._hudDirty = false; this._hudT = 0.5;
    for (var i = 0; i < this.dom.slots.length; i++) {
      var el = this.dom.slots[i], s = SLOTS[i];
      el.classList.toggle('on', i === this.slot);
      el.classList.toggle('broken', this.broken[i] > 0);
      var d = el.querySelector('.tb-dur');
      d.style.display = s.dur ? '' : 'none';
      if (s.dur) d.firstChild.style.width = Math.round(this.dur[i] / s.dur * 100) + '%';
    }
  };

  TERRA.game.Tools = Tools;
})();
