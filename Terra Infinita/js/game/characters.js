/* =============================================================================
 * TERRA INFINITA — characters: skinned soldier rig, equipment and animator
 * -----------------------------------------------------------------------------
 * Builds a humanoid whose vertices reference 19 bones (two-bone blend at every
 * joint) in exactly the layout the `sldVS` shader expects:
 *
 *   location 0..4  vertex (pos / normal / uv / tint+ao / material+bone0+bone1+blend)
 *   location 5..8  instance world matrix
 *   location 9     bone row offset | team tint | damage | seed
 *   location 10    life fraction | pose state | visibility | fade
 *
 * The animator is fully procedural (no assets): idle stances, walk / run cycles
 * with foot plant and pelvis bob, crouch, prone, leaning, weapon ready / lowered,
 * two-bone IK arms locked to the rifle grips, head tracking, firing recoil,
 * reloads, hit flinches and a physical-looking death fall.
 * ========================================================================== */
(function () {
  'use strict';
  var U = TERRA.util;

  /* ---------------- bones ---------------- */
  var B = {
    PELVIS: 0, SPINE: 1, CHEST: 2, NECK: 3, HEAD: 4,
    SHOULDER_L: 5, ARM_L: 6, FOREARM_L: 7, HAND_L: 8,
    SHOULDER_R: 9, ARM_R: 10, FOREARM_R: 11, HAND_R: 12,
    THIGH_L: 13, SHIN_L: 14, FOOT_L: 15,
    THIGH_R: 16, SHIN_R: 17, FOOT_R: 18
  };
  var NBONES = 19, ROWS = 20;                 // padded so texture rows stay aligned

  // bind pose: bone origin in model space (character faces +Z, feet at y = 0)
  var BIND = [
    [0, 1.00, 0], [0, 1.16, 0.005], [0, 1.36, 0], [0, 1.53, 0], [0, 1.62, 0],
    [0.185, 1.44, 0], [0.215, 1.42, 0], [0.235, 1.13, 0.02], [0.245, 0.86, 0.06],
    [-0.185, 1.44, 0], [-0.215, 1.42, 0], [-0.235, 1.13, 0.02], [-0.245, 0.86, 0.06],
    [0.105, 0.94, 0], [0.115, 0.50, 0.005], [0.12, 0.075, 0],
    [-0.105, 0.94, 0], [-0.115, 0.50, 0.005], [-0.12, 0.075, 0]
  ];
  var PARENT = [-1, 0, 1, 2, 3, 2, 5, 6, 7, 2, 9, 10, 11, 0, 13, 14, 0, 16, 17];
  var LEN = new Float32Array(NBONES);         // distance to the child joint (bind)
  (function () {
    var d = [B.PELVIS, B.SPINE, B.CHEST, B.NECK, B.HEAD, B.SHOULDER_L, B.ARM_L, B.FOREARM_L, B.HAND_L,
      B.SHOULDER_R, B.ARM_R, B.FOREARM_R, B.HAND_R, B.THIGH_L, B.SHIN_L, B.FOOT_L, B.THIGH_R, B.SHIN_R, B.FOOT_R];
    for (var i = 0; i < NBONES; i++) {
      var c = -1;
      for (var j = 0; j < NBONES; j++) if (PARENT[j] === i) c = j;
      if (c < 0) { LEN[i] = 0.1; continue; }
      var a = BIND[i], b = BIND[c];
      LEN[i] = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }
    void d;
  })();
  // bind offsets in parent space
  var OFF = [];
  for (var bi = 0; bi < NBONES; bi++) {
    var pb = PARENT[bi] < 0 ? [0, 0, 0] : BIND[PARENT[bi]];
    OFF.push([BIND[bi][0] - pb[0], BIND[bi][1] - pb[1], BIND[bi][2] - pb[2]]);
  }

  /* ---------------- tiny quaternion / matrix helpers ---------------- */
  function qId() { return [0, 0, 0, 1]; }
  function qAxis(ax, ay, az, a) {
    var h = a * 0.5, s = Math.sin(h);
    return [ax * s, ay * s, az * s, Math.cos(h)];
  }
  /** Euler (pitch about x, yaw about y, roll about z) applied Y then X then Z. */
  function qEuler(pitch, yaw, roll) {
    var qx = qAxis(1, 0, 0, pitch), qy = qAxis(0, 1, 0, yaw), qz = qAxis(0, 0, 1, roll);
    return qMul(qMul(qy, qx), qz);
  }
  function qMul(a, b) {
    return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
  }
  function qNorm(q) {
    var l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  }
  function qSlerp(a, b, t) {
    var d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3], bb = b;
    if (d < 0) { bb = [-b[0], -b[1], -b[2], -b[3]]; d = -d; }
    if (d > 0.9995) return qNorm([a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t]);
    var th = Math.acos(U.clamp(d, -1, 1)), s = Math.sin(th), s0 = Math.sin((1 - t) * th) / s, s1 = Math.sin(t * th) / s;
    return [a[0] * s0 + bb[0] * s1, a[1] * s0 + bb[1] * s1, a[2] * s0 + bb[2] * s1, a[3] * s0 + bb[3] * s1];
  }
  function qRot(q, v, out) {
    var x = q[0], y = q[1], z = q[2], w = q[3];
    var ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
    out = out || [0, 0, 0];
    out[0] = ix * w + iw * -x + iy * -z - iz * -y;
    out[1] = iy * w + iw * -y + iz * -x - ix * -z;
    out[2] = iz * w + iw * -z + ix * -y - iy * -x;
    return out;
  }
  function qInv(q) { return [-q[0], -q[1], -q[2], q[3]]; }
  /** Rotation taking unit direction `from` to unit direction `to` (shortest arc). */
  function qFromTo(f, t) {
    var d = f[0] * t[0] + f[1] * t[1] + f[2] * t[2];
    if (d > 0.99999) return qId();
    if (d < -0.99999) {
      // opposite: rotate about any perpendicular axis
      var ax = Math.abs(f[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
      var p = [f[1] * ax[2] - f[2] * ax[1], f[2] * ax[0] - f[0] * ax[2], f[0] * ax[1] - f[1] * ax[0]];
      var l = Math.hypot(p[0], p[1], p[2]) || 1;
      return [p[0] / l, p[1] / l, p[2] / l, 0];
    }
    var c = [f[1] * t[2] - f[2] * t[1], f[2] * t[0] - f[0] * t[2], f[0] * t[1] - f[1] * t[0]];
    return qNorm([c[0], c[1], c[2], 1 + d]);
  }
  function m4() { return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); }
  /** out = a * b */
  function mMul(a, b, out) {
    for (var c = 0; c < 4; c++) {
      var b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
      out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
      out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
      out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
    return out;
  }
  /** out = T(off) * R(q) */
  function mTR(off, q, out) {
    var x = q[0], y = q[1], z = q[2], w = q[3];
    var xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
    out[0] = 1 - 2 * (yy + zz); out[1] = 2 * (xy + wz); out[2] = 2 * (xz - wy); out[3] = 0;
    out[4] = 2 * (xy - wz); out[5] = 1 - 2 * (xx + zz); out[6] = 2 * (yz + wx); out[7] = 0;
    out[8] = 2 * (xz + wy); out[9] = 2 * (yz - wx); out[10] = 1 - 2 * (xx + yy); out[11] = 0;
    out[12] = off[0]; out[13] = off[1]; out[14] = off[2]; out[15] = 1;
    return out;
  }
  /** bone matrix = world * T(-bindPos) : the shader skins bind-pose vertices. */
  function mBone(world, bindPos, out) {
    out[0] = world[0]; out[1] = world[1]; out[2] = world[2]; out[3] = 0;
    out[4] = world[4]; out[5] = world[5]; out[6] = world[6]; out[7] = 0;
    out[8] = world[8]; out[9] = world[9]; out[10] = world[10]; out[11] = 0;
    out[12] = world[12] - (world[0] * bindPos[0] + world[4] * bindPos[1] + world[8] * bindPos[2]);
    out[13] = world[13] - (world[1] * bindPos[0] + world[5] * bindPos[1] + world[9] * bindPos[2]);
    out[14] = world[14] - (world[2] * bindPos[0] + world[6] * bindPos[1] + world[10] * bindPos[2]);
    out[15] = 1;
    return out;
  }
  function mInvRigid(m, out) {
    // inverse of a rotation+translation matrix
    out[0] = m[0]; out[1] = m[4]; out[2] = m[8];
    out[4] = m[1]; out[5] = m[5]; out[6] = m[9];
    out[8] = m[2]; out[9] = m[6]; out[10] = m[10];
    out[3] = out[7] = out[11] = 0; out[15] = 1;
    var tx = m[12], ty = m[13], tz = m[14];
    out[12] = -(out[0] * tx + out[4] * ty + out[8] * tz);
    out[13] = -(out[1] * tx + out[5] * ty + out[9] * tz);
    out[14] = -(out[2] * tx + out[6] * ty + out[10] * tz);
    return out;
  }
  function mXformPoint(m, p, out) {
    out = out || [0, 0, 0];
    out[0] = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    out[1] = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    out[2] = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
    return out;
  }
  function mXformDir(m, p, out) {
    out = out || [0, 0, 0];
    out[0] = m[0] * p[0] + m[4] * p[1] + m[8] * p[2];
    out[1] = m[1] * p[0] + m[5] * p[1] + m[9] * p[2];
    out[2] = m[2] * p[0] + m[6] * p[1] + m[10] * p[2];
    return out;
  }
  function vsub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function vadd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function vscale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function vlen(a) { return Math.hypot(a[0], a[1], a[2]); }
  function vnorm(a) { var l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function vcross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

  /* ==========================================================================
   * Mesh construction
   * ======================================================================== */
  /** cylinder segment whose vertices blend toward the parent bone near the top. */
  function seg(g, p0, p1, r0, r1, bone, parentBone, o) {
    o = o || {};
    var start = g.count, CM = TERRA.game.Combat;
    g.cylinder(p0, p1, r0, r1, o.segs || 8, { mat: o.mat, col: o.col, uvScale: o.uv || 2.2, caps: o.caps !== false, edge: o.edge === undefined ? 110 : o.edge, wear: o.wear || 0 });
    var soft = o.blend === undefined ? 0.3 : o.blend;
    for (var i = start; i < g.count; i++) {
      var y = g.p[i * 3 + 1];
      var t = Math.abs(p0[1] - p1[1]) > 1e-4 ? (y - p1[1]) / (p0[1] - p1[1]) : 0;
      var bl = 0;
      if (soft > 0 && t > 1 - soft) bl = (t - (1 - soft)) / soft * 0.5;
      g.m[i * 4] = o.mat === undefined ? CM.CMAT.CLOTH : o.mat;
      g.m[i * 4 + 1] = bone; g.m[i * 4 + 2] = parentBone === undefined ? bone : parentBone;
      g.m[i * 4 + 3] = Math.round(U.clamp01(bl) * 255);
    }
    return g;
  }
  function boxB(g, c, h, bone, parentBone, o) {
    o = o || {};
    var start = g.count, CM = TERRA.game.Combat;
    var ax = o.axis === undefined ? 1 : o.axis;    // axis pointing at the parent joint
    g.box(c, h, { mat: o.mat, col: o.col, uvScale: o.uv || 2.0, edge: o.edge === undefined ? 170 : o.edge, wear: o.wear || 0 });
    var soft = o.blend === undefined ? 0.34 : o.blend, span = h[ax] * 2, top = c[ax] + h[ax];
    for (var i = start; i < g.count; i++) {
      var t = span > 1e-4 ? (g.p[i * 3 + ax] - (top - span)) / span : 0;
      var bl = soft > 0 && t > 1 - soft ? (t - (1 - soft)) / soft * 0.45 : 0;
      g.m[i * 4] = o.mat === undefined ? CM.CMAT.CLOTH : o.mat;
      g.m[i * 4 + 1] = bone; g.m[i * 4 + 2] = parentBone === undefined ? bone : parentBone;
      g.m[i * 4 + 3] = Math.round(U.clamp01(bl) * 255);
    }
    return g;
  }

  /** One soldier body. opts: { kind:'rifle'|'heavy'|'officer', weapon:'rifle'|'smg'|'lmg'|'sniper'|'launcher', camo:[rgb], gear:0..1 } */
  function buildBody(opts) {
    opts = opts || {};
    var CM = TERRA.game.Combat, g = new CM.CGeo();
    var kind = opts.kind || 'rifle';
    var heavy = kind === 'heavy';
    // uniform tone: the shader multiplies by the team kit tint as well
    var uni = opts.camo || [206, 200, 186];
    var uniD = [uni[0] * 0.82, uni[1] * 0.82, uni[2] * 0.8];
    var gearC = [96, 92, 78], bootC = [46, 42, 38], skinC = [198, 152, 118];
    var plateC = [84, 86, 74], helmetC = [78, 80, 68];

    /* --- legs --- */
    var hipY = BIND[B.THIGH_L][1], footY = BIND[B.FOOT_L][1];
    function leg(sx, side) {
      var th = side ? B.THIGH_R : B.THIGH_L, sh = side ? B.SHIN_R : B.SHIN_L, ft = side ? B.FOOT_R : B.FOOT_L;
      var hx = sx * 0.105;
      seg(g, [hx, hipY, 0], [hx * 1.1, 0.52, 0.005], heavy ? 0.115 : 0.10, heavy ? 0.095 : 0.085, th, B.PELVIS, { mat: CM.CMAT.CLOTH, col: uni, segs: 8 });
      seg(g, [hx * 1.1, 0.52, 0.005], [hx * 1.14, 0.10, 0], heavy ? 0.092 : 0.082, 0.07, sh, th, { mat: CM.CMAT.CLOTH, col: uniD, segs: 8 });
      // knee pad
      boxB(g, [hx * 1.12, 0.51, 0.075], [0.075, 0.085, 0.05], sh, th, { mat: CM.CMAT.KEVLAR, col: [58, 56, 52], axis: 1, blend: 0.5 });
      // boot: ankle + foot + sole
      boxB(g, [hx * 1.14, 0.075, 0.02], [0.078, 0.075, 0.115], ft, sh, { mat: CM.CMAT.RUBBER, col: bootC, axis: 1, blend: 0.5, edge: 200 });
      boxB(g, [hx * 1.14, 0.03, 0.115], [0.072, 0.03, 0.09], ft, ft, { mat: CM.CMAT.RUBBER, col: [26, 24, 24], axis: 1, blend: 0 });
      // thigh pocket
      if (opts.gear !== 0) boxB(g, [hx + sx * 0.075, 0.62, 0.03], [0.03, 0.075, 0.055], th, th, { mat: CM.CMAT.CANVAS, col: gearC, axis: 1, blend: 0 });
    }
    leg(1, 0); leg(-1, 1);

    /* --- hips / torso --- */
    boxB(g, [0, 1.0, 0], [heavy ? 0.175 : 0.155, 0.115, 0.115], B.PELVIS, B.PELVIS, { mat: CM.CMAT.CLOTH, col: uniD, uv: 2.4, y: 1 });
    seg(g, [0, 1.08, 0], [0, 1.42, 0], heavy ? 0.19 : 0.168, heavy ? 0.205 : 0.18, B.SPINE, B.PELVIS, { mat: CM.CMAT.CLOTH, col: uni, segs: 10, caps: false });
    seg(g, [0, 1.42, 0], [0, 1.52, 0], heavy ? 0.205 : 0.18, 0.165, B.CHEST, B.SPINE, { mat: CM.CMAT.CLOTH, col: uni, segs: 10, caps: false });
    // plate carrier: front, back and shoulders
    boxB(g, [0, 1.33, 0.135], [0.16, 0.155, 0.035], B.CHEST, B.SPINE, { mat: CM.CMAT.KEVLAR, col: plateC, axis: 1, blend: 0.35, edge: 210 });
    boxB(g, [0, 1.33, -0.135], [0.15, 0.15, 0.04], B.CHEST, B.SPINE, { mat: CM.CMAT.KEVLAR, col: plateC, axis: 1, blend: 0.35, edge: 210 });
    boxB(g, [0.15, 1.45, 0], [0.055, 0.03, 0.12], B.CHEST, B.CHEST, { mat: CM.CMAT.KEVLAR, col: plateC, axis: 1, blend: 0 });
    boxB(g, [-0.15, 1.45, 0], [0.055, 0.03, 0.12], B.CHEST, B.CHEST, { mat: CM.CMAT.KEVLAR, col: plateC, axis: 1, blend: 0 });
    // magazine pouches, dressing pouch, radio
    for (var mp = -1; mp <= 1; mp++) {
      boxB(g, [mp * 0.085, 1.2, 0.155], [0.045, 0.065, 0.035], B.SPINE, B.SPINE, { mat: CM.CMAT.CANVAS, col: gearC, axis: 1, blend: 0, edge: 220 });
    }
    boxB(g, [-0.16, 1.26, 0.13], [0.045, 0.055, 0.03], B.SPINE, B.SPINE, { mat: CM.CMAT.CANVAS, col: [70, 74, 62], axis: 1, blend: 0 });
    boxB(g, [0.16, 1.36, -0.12], [0.035, 0.07, 0.025], B.CHEST, B.CHEST, { mat: CM.CMAT.METAL, col: [40, 42, 40], axis: 1, blend: 0, edge: 190 });
    // webbing belt
    seg(g, [0, 1.06, 0], [0, 1.11, 0], heavy ? 0.185 : 0.166, heavy ? 0.185 : 0.166, B.PELVIS, B.PELVIS, { mat: CM.CMAT.WEBBING, col: [72, 68, 56], segs: 10, caps: false, blend: 0.45 });
    // backpack (riflemen) or radio pack (officer)
    if (opts.gear !== 0) {
      boxB(g, [0, 1.35, -0.22], [heavy ? 0.155 : 0.135, 0.15, 0.07], B.CHEST, B.CHEST, { mat: CM.CMAT.CANVAS, col: [88, 86, 70], axis: 1, blend: 0.3, edge: 200 });
      boxB(g, [0, 1.2, -0.21], [0.11, 0.05, 0.055], B.CHEST, B.SPINE, { mat: CM.CMAT.CANVAS, col: [76, 78, 62], axis: 1, blend: 0.5 });
      if (kind === 'officer') {
        g.cylinder([0.17, 1.42, -0.19], [0.17, 1.66, -0.19], 0.012, 0.012, 5, { mat: CM.CMAT.METAL, col: [30, 30, 32] });
        boxB(g, [0.21, 1.36, -0.19], [0.03, 0.07, 0.035], B.CHEST, B.CHEST, { mat: CM.CMAT.METAL, col: [48, 50, 46], axis: 1, blend: 0 });
      }
    }
    // collar + scarf
    seg(g, [0, 1.47, 0.01], [0, 1.52, 0.01], 0.085, 0.08, B.NECK, B.CHEST, { mat: CM.CMAT.CLOTH, col: uniD, segs: 8, caps: false, blend: 0.5 });

    /* --- arms --- */
    function arm(sx, side) {
      var sh = side ? B.SHOULDER_R : B.SHOULDER_L, ar = side ? B.ARM_R : B.ARM_L, fa = side ? B.FOREARM_R : B.FOREARM_L, hd = side ? B.HAND_R : B.HAND_L;
      var shx = sx * 0.185;
      boxB(g, [shx, 1.44, 0], [0.062, 0.055, 0.075], sh, B.CHEST, { mat: CM.CMAT.CLOTH, col: uni, axis: 1, blend: 0.4 });
      seg(g, [shx, 1.42, 0], [sx * 0.235, 1.15, 0.02], heavy ? 0.062 : 0.055, 0.048, ar, sh, { mat: CM.CMAT.CLOTH, col: uni, segs: 8 });
      // elbow pad
      boxB(g, [sx * 0.24, 1.13, 0.045], [0.045, 0.05, 0.035], fa, ar, { mat: CM.CMAT.KEVLAR, col: [56, 54, 50], axis: 1, blend: 0.5 });
      seg(g, [sx * 0.235, 1.13, 0.02], [sx * 0.245, 0.89, 0.055], 0.046, 0.042, fa, ar, { mat: CM.CMAT.CLOTH, col: uniD, segs: 8 });
      // glove
      boxB(g, [sx * 0.246, 0.865, 0.055], [0.042, 0.05, 0.055], hd, fa, { mat: CM.CMAT.RUBBER, col: [38, 36, 34], axis: 1, blend: 0.4 });
      if (opts.gear !== 0 && side === 0) {   // watch on the left wrist
        boxB(g, [sx * 0.256, 0.94, 0.05], [0.028, 0.014, 0.028], fa, fa, { mat: CM.CMAT.LENS, col: [150, 160, 170], axis: 1, blend: 0 });
      }
    }
    arm(1, 0); arm(-1, 1);

    /* --- head --- */
    boxB(g, [0, 1.7, 0.005], [0.083, 0.105, 0.09], B.HEAD, B.NECK, { mat: CM.CMAT.SKIN, col: skinC, axis: 1, blend: 0.45, uv: 3.0 });
    // helmet shell + rim
    boxB(g, [0, 1.795, 0], [0.105, 0.07, 0.115], B.HEAD, B.HEAD, { mat: CM.CMAT.KEVLAR, col: helmetC, axis: 1, blend: 0, edge: 230 });
    boxB(g, [0, 1.735, 0.09], [0.1, 0.028, 0.03], B.HEAD, B.HEAD, { mat: CM.CMAT.KEVLAR, col: [64, 66, 58], axis: 1, blend: 0 });
    // goggles / eye pro
    boxB(g, [0, 1.72, 0.082], [0.078, 0.022, 0.022], B.HEAD, B.HEAD, { mat: CM.CMAT.LENS, col: [40, 46, 50], axis: 1, blend: 0, edge: 120 });
    // face cover (balaclava) below the goggles
    boxB(g, [0, 1.67, 0.055], [0.08, 0.045, 0.045], B.HEAD, B.HEAD, { mat: CM.CMAT.CLOTH, col: [58, 58, 52], axis: 1, blend: 0 });
    // headset earpiece + boom mic
    boxB(g, [0.088, 1.72, 0], [0.022, 0.035, 0.035], B.HEAD, B.HEAD, { mat: CM.CMAT.METAL, col: [42, 42, 44], axis: 1, blend: 0 });
    g.cylinder([0.095, 1.71, 0.02], [0.03, 1.685, 0.075], 0.007, 0.007, 5, { mat: CM.CMAT.METAL, col: [30, 30, 32] });
    void footY;

    /* --- weapon, held in the right hand (grip == the bind position of HAND_R) --- */
    var wC = weaponGeometry(opts.weapon || 'rifle', B.HAND_R, B.HAND_L, BIND);
    g.append(wC, [0, 0, 0]);
    void hipY;

    return g;
  }

  /** Rifle / SMG / LMG / sniper built around the right hand: the grip sits at the
   *  bind position of HAND_R, the barrel points +Z, the stock reaches back. */
  function weaponGeometry(type, handBone, handLBone, BIND) {
    var CM = TERRA.game.Combat, g = new CM.CGeo();
    var h = BIND[handBone];                      // grip position in model space
    var bx = h[0], by = h[1] + 0.045, bz = h[2] - 0.02;
    var dark = [34, 34, 36], poly = [58, 56, 50], wood = [96, 66, 40];
    function part(c, hh, mat, col, o) {
      o = o || {};
      var start = g.count;
      g.box(c, hh, { mat: mat, col: col, uvScale: o.uv || 2.2, edge: o.edge === undefined ? 200 : o.edge, wear: o.wear || 12 });
      for (var i = start; i < g.count; i++) {
        g.m[i * 4] = mat;
        g.m[i * 4 + 1] = o.lh ? handLBone : handBone;
        g.m[i * 4 + 2] = o.blend === undefined ? handBone : handBone;
        g.m[i * 4 + 3] = Math.round(U.clamp01(o.blend || 0) * 255);
      }
      return g;
    }
    var len = type === 'smg' ? 0.42 : (type === 'sniper' ? 0.78 : (type === 'lmg' ? 0.62 : 0.56));
    // receiver + handguard
    part([bx, by, bz + 0.16], [0.028, 0.042, 0.13], CM.CMAT.METAL, dark);
    part([bx, by - 0.004, bz + 0.19], [0.022, 0.028, 0.10], CM.CMAT.METAL, [44, 44, 46]);
    // barrel + muzzle device
    g.cylinder([bx, by + 0.012, bz + 0.27], [bx, by + 0.012, bz + 0.27 + len * 0.62], 0.011, 0.009, 7, { mat: CM.CMAT.STEEL, col: [40, 40, 42] });
    g.cylinder([bx, by + 0.012, bz + 0.27 + len * 0.62], [bx, by + 0.012, bz + 0.30 + len * 0.62], 0.014, 0.016, 7, { mat: CM.CMAT.STEEL, col: [28, 28, 30] });
    // handguard / foregrip the left hand wraps
    part([bx + 0.02, by - 0.012, bz + 0.36], [0.024, 0.028, 0.09], CM.CMAT.METAL, poly, { lh: true, blend: 128, edge: 220 });
    // magazine (curved for AK-ish look), grip and stock
    part([bx, by - 0.075, bz + 0.11], [0.022, 0.062, 0.038], CM.CMAT.METAL, [30, 30, 32], { edge: 230 });
    part([bx, by - 0.045, bz + 0.045], [0.018, 0.048, 0.026], CM.CMAT.PAINT, [30, 30, 30]);
    part([bx, by + 0.006, bz - 0.075], [0.022, 0.038, 0.095], CM.CMAT.PAINT, type === 'sniper' ? wood : poly, { edge: 210 });
    // optic: rail + body + lens
    part([bx, by + 0.055, bz + 0.15], [0.012, 0.008, 0.09], CM.CMAT.STEEL, [36, 36, 38]);
    part([bx, by + 0.082, bz + 0.15], [0.021, 0.026, 0.075], CM.CMAT.METAL, [28, 28, 30]);
    g.cylinder([bx, by + 0.082, bz + 0.215], [bx, by + 0.082, bz + 0.245], 0.021, 0.024, 8, { mat: CM.CMAT.CANVAS, col: [24, 24, 26] });
    g.cylinder([bx, by + 0.082, bz + 0.152], [bx, by + 0.082, bz + 0.135], 0.018, 0.016, 8, { mat: CM.CMAT.LENS, col: [30, 60, 70] });
    if (type === 'lmg') {           // drum + bipod hint
      g.cylinder([bx + 0.05, by - 0.09, bz + 0.2], [bx - 0.03, by - 0.09, bz + 0.2], 0.075, 0.075, 10, { mat: CM.CMAT.METAL, col: [40, 40, 42], caps: true });
      g.cylinder([bx, by - 0.05, bz + 0.42], [bx - 0.05, by - 0.16, bz + 0.5], 0.008, 0.008, 5, { mat: CM.CMAT.STEEL, col: [50, 50, 52] });
      g.cylinder([bx, by - 0.05, bz + 0.42], [bx + 0.05, by - 0.16, bz + 0.5], 0.008, 0.008, 5, { mat: CM.CMAT.STEEL, col: [50, 50, 52] });
    }
    if (type === 'launcher') {      // fat tube
      g.cylinder([bx, by + 0.02, bz + 0.1], [bx, by + 0.02, bz + 0.9], 0.055, 0.055, 10, { mat: CM.CMAT.METAL, col: [56, 58, 50] });
    }
    if (type === 'sniper') {        // longer scope + muzzle brake
      g.cylinder([bx, by + 0.082, bz + 0.28], [bx, by + 0.082, bz + 0.30], 0.024, 0.026, 8, { mat: CM.CMAT.LENS, col: [30, 60, 70] });
    }
    // sling loop
    g.cylinder([bx - 0.03, by - 0.02, bz - 0.12], [bx - 0.03, by - 0.02, bz - 0.14], 0.006, 0.006, 5, { mat: CM.CMAT.WEBBING, col: [70, 66, 54] });
    return g;
  }

  /* ==========================================================================
   * Animator
   * ======================================================================== */
  function Animator(opts) {
    this.opt = opts || {};
    this.local = [];           // local quaternion per bone
    this.off = [];             // local translation offset per bone
    for (var i = 0; i < NBONES; i++) { this.local.push(qId()); this.off.push([0, 0, 0]); }
    this.world = [];           // world matrix per bone (bind space of the model)
    this.boneMat = new Float32Array(ROWS * 16);
    for (i = 0; i < NBONES; i++) this.world.push(m4());
    this.root = m4();          // model matrix (from the soldier transform)
    this.state = 'idle';
    this.phase = 0;
    this.speed = 0;
    this.aimYaw = 0; this.aimPitch = 0;
    this.lean = 0; this.bob = 0;
    this.crouch = 0; this.prone = 0;
    this.recoil = 0; this.reloadT = 1; this.hitT = 0;
    this.dead = false; this.deadT = 0; this.fallDir = 0;
    this.weaponDown = 0;
    this._mq = []; this._tmp = m4(); this._tmp2 = m4(); this._inv = m4();
    for (i = 0; i < 4; i++) this._mq.push(qId());
    this._p = [0, 0, 0];
  }
  var A = Animator.prototype;

  /** Pose targets: call every frame before update(). */
  A.set = function (o) {
    if (o.state !== undefined && o.state !== this.state) {
      if (o.state === 'dead') { this.dead = true; this.deadT = 0; this.fallDir = o.fallDir === undefined ? (Math.random() - 0.5) * 1.2 : o.fallDir; }
      else this.state = o.state;
    }
    if (o.speed !== undefined) this.speed = o.speed;
    if (o.aimYaw !== undefined) this.aimYaw = o.aimYaw;
    if (o.aimPitch !== undefined) this.aimPitch = o.aimPitch;
    if (o.crouch !== undefined) this.crouch = o.crouch;
    if (o.prone !== undefined) this.prone = o.prone;
    if (o.lean !== undefined) this.lean = o.lean;
    if (o.weaponDown !== undefined) this.weaponDown = o.weaponDown;
    if (o.fire) this.recoil = Math.min(1.6, this.recoil + o.fire);
    if (o.reload !== undefined && o.reload !== this._rl) { this._rl = o.reload; if (o.reload) this.reloadT = 0; }
    if (o.hit) this.hitT = Math.max(this.hitT, 0.35);
    if (o.root) this.root.set(o.root);
  };

  /** Advance and produce bone matrices (in model space) ready for the GPU. */
  A.update = function (dt) {
    var q = this.local, off = this.off, i;
    var RUN = this.speed > 3.4 ? 1 : 0;
    var move = U.clamp(this.speed / 4.6, 0, 1);
    this.phase += dt * (1.2 + this.speed * 0.95) * (this.speed > 0.05 ? 1 : 0);
    if (this.speed <= 0.05) this.phase += dt * 0.55;
    if (this.reloadT < 1) this.reloadT = Math.min(1, this.reloadT + dt / 3.1);
    this.recoil = Math.max(0, this.recoil - dt * 6.5);
    this.hitT = Math.max(0, this.hitT - dt);
    if (this.dead) this.deadT += dt;

    var crouch = this.crouch, prone = this.prone;
    var p = this.phase;
    var bobA = (0.008 + 0.03 * move) * (1 - prone * 0.8);

    for (i = 0; i < NBONES; i++) { q[i][0] = q[i][1] = q[i][2] = 0; q[i][3] = 1; off[i][0] = off[i][1] = off[i][2] = 0; }

    /* ---- death: fall to the ground, limbs go limp ---- */
    if (this.dead) {
      var t = U.clamp(this.deadT / 0.75, 0, 1), e = t * t * (3 - 2 * t);
      var limp = U.clamp((this.deadT - 0.25) / 1.2, 0, 1);
      q[B.PELVIS] = qEuler(-1.35 * e, this.fallDir * 0.5 * e, this.fallDir * 0.9 * e);
      off[B.PELVIS] = [0, -0.72 * e, -0.12 * e];
      q[B.SPINE] = qEuler(0.25 * e + limp * 0.1, 0, this.fallDir * 0.35 * e);
      q[B.CHEST] = qEuler(0.2 * e, 0, this.fallDir * 0.25 * e);
      q[B.NECK] = qEuler(0.35 * e, this.fallDir * 0.6 * e, 0);
      q[B.HEAD] = qEuler(0.2 * e, this.fallDir * 0.4 * e, 0);
      for (var s2 = 0; s2 < 2; s2++) {
        var sa = s2 ? [-1, 1] : [1, -1];
        var armB = s2 ? [B.SHOULDER_R, B.ARM_R, B.FOREARM_R, B.HAND_R] : [B.SHOULDER_L, B.ARM_L, B.FOREARM_L, B.HAND_L];
        q[armB[0]] = qEuler(0.2 * e, 0, sa[0] * 0.5 * e);
        q[armB[1]] = qEuler(-1.1 * e + limp * 0.5, 0.5 * e * sa[1], sa[0] * (0.9 * e));
        q[armB[2]] = qEuler(-1.2 * e - limp * 0.4, 0, 0);
        q[armB[3]] = qEuler(0.3 * e, 0, 0);
      }
      for (var l2 = 0; l2 < 2; l2++) {
        var legB = l2 ? [B.THIGH_R, B.SHIN_R, B.FOOT_R] : [B.THIGH_L, B.SHIN_L, B.FOOT_L];
        var sg = l2 ? 1 : -1;
        q[legB[0]] = qEuler(0.25 * e - 0.2, sg * 0.22 * e, sg * 0.3 * e);
        q[legB[1]] = qEuler(-0.5 * e - limp * 0.3, 0, 0);
        q[legB[2]] = qEuler(0.35 * e, 0, 0);
      }
      this._compose();
      return this;
    }

    /* ---- prone: body flat, propped on the elbows ---- */
    if (prone > 0.01) {
      var pr = prone;
      q[B.PELVIS] = qSlerp(q[B.PELVIS], qEuler(1.42, 0, 0), pr);
      off[B.PELVIS] = [0, -0.72 * pr, 0.2 * pr];
      q[B.SPINE] = qSlerp(q[B.SPINE], qEuler(-0.25, 0, 0), pr);
      q[B.CHEST] = qSlerp(q[B.CHEST], qEuler(-0.18, 0, 0), pr);
      for (var pl = 0; pl < 2; pl++) {
        var lb = pl ? [B.THIGH_R, B.SHIN_R, B.FOOT_R] : [B.THIGH_L, B.SHIN_L, B.FOOT_L];
        var sgn = pl ? 1 : -1;
        q[lb[0]] = qEuler(-1.5 - 0.1 * sgn, sgn * 0.16, sgn * 0.22);
        q[lb[1]] = qEuler(0.35, 0, 0);
        q[lb[2]] = qEuler(-0.45, 0, 0);
      }
    }

    /* ---- legs: walk / run cycle, stance, crouch ---- */
    var stride = (0.42 + 0.5 * move) * (1 - prone);
    var kneeBase = 0.08 + crouch * 1.15 + prone * 0.2;
    for (var L = 0; L < 2; L++) {
      var sideL = L === 0 ? -1 : 1;
      var ph = p + (L ? Math.PI : 0);
      var thighBone = L ? B.THIGH_R : B.THIGH_L, shinBone = L ? B.SHIN_R : B.SHIN_L, footBone = L ? B.FOOT_R : B.FOOT_L;
      var swing = Math.sin(ph) * stride;
      var lift = Math.max(0, Math.sin(ph + 0.9));
      var thigh = swing;
      var knee = kneeBase + lift * (0.5 + 1.15 * move) * (1 - crouch * 0.4);
      var foot = -0.16 - swing * 0.35 - (1 - lift) * 0.1 + crouch * 0.5;
      var idleSplay = (1 - move) * crouch * 0.25;
      if (prone > 0.01) { thigh = 0; knee = 0; foot = 0; }
      q[thighBone] = qSlerp(q[thighBone], qEuler(thigh, sideL * (0.02 + crouch * 0.12 + idleSplay * 0.4), sideL * (0.03 + crouch * 0.05)), 1 - prone);
      q[shinBone] = qEuler(-knee, 0, 0);
      q[footBone] = qEuler(foot, 0, 0);
      void RUN;
    }
    // pelvis bob, sway and stance width
    var bob = Math.cos(p * 2) * bobA, sway = Math.sin(p) * 0.02 * (0.4 + move);
    var stanceY = -0.055 * crouch - 0.02 * move + bob;
    off[B.PELVIS][1] += stanceY * (1 - prone);
    off[B.PELVIS][0] += sway + Math.sin(0.6 * p) * 0.004;
    q[B.PELVIS] = qMul(q[B.PELVIS], qEuler(0.02 + 0.06 * move + crouch * 0.22, sway * 0.6, Math.cos(p) * 0.02 * (0.3 + move)));

    /* ---- torso: lean into the run, twist with the step, recoil kick ---- */
    var lean = (0.12 * move + crouch * 0.34) * (1 - prone) + this.hitT * 0.12;
    var kick = this.recoil * 0.14;
    q[B.SPINE] = qMul(q[B.SPINE], qEuler(lean * 0.45 - kick * 0.4, -Math.sin(p) * 0.07 * (0.3 + move) + this.aimYaw * 0.18, this.lean * 0.1));
    q[B.CHEST] = qMul(q[B.CHEST], qEuler(lean * 0.55 - kick * 0.5 + this.aimPitch * 0.35, -Math.sin(p) * 0.09 * (0.3 + move) + this.aimYaw * 0.32, this.lean * 0.14));
    var headPitch = U.clamp(this.aimPitch - 0.0, -0.7, 0.8);
    q[B.NECK] = qEuler(headPitch * 0.45 - lean * 0.25, this.aimYaw * 0.35, -this.lean * 0.12);
    // idle scanning when nothing is happening
    if (this.speed < 0.1 && !this.aimYaw) q[B.HEAD] = qEuler(headPitch * 0.35, Math.sin(p * 0.42) * 0.28, 0);
    else q[B.HEAD] = qEuler(headPitch * 0.35, this.aimYaw * 0.2, 0);

    /* ---- arms + weapon: the rifle is locked to both hands ---- */
    this._composeWorld();
    var chest = this.world[B.CHEST];
    var qChest = this._quatOf(chest);
    // aim direction in model space (the model faces +Z, the root carries the facing)
    var ay = this.aimYaw, ap = this.aimPitch;
    var dir = vnorm([Math.sin(ay) * Math.cos(ap), Math.sin(ap), Math.cos(ay) * Math.cos(ap)]);
    var down = this.weaponDown;
    if (down > 0.001) {
      var dDir = vnorm([dir[0] * 0.6 + 0.18, -0.55, dir[2] * 0.6 + 0.25]);
      dir = vnorm([dir[0] + (dDir[0] - dir[0]) * down, dir[1] + (dDir[1] - dir[1]) * down, dir[2] + (dDir[2] - dir[2]) * down]);
    }
    var qWeapon = qFromTo([0, 0, 1], dir);
    // grip (right hand) position: in the chest frame, pushed back by the recoil
    var kick = this.recoil * 0.045;
    var gripChest = [0.15, -0.29 - down * 0.16, 0.26 - 0.06 * down - kick];
    var gripW = mXformPoint(chest, qRot(qChest, gripChest, this._p), [0, 0, 0]);
    // left hand rides the handguard, 32 cm up the barrel in the weapon frame
    var foreW = vadd(gripW, qRot(qWeapon, [0.0, 0.005 - 0.02 * down, 0.32], [0, 0, 0]));
    if (this.reloadT < 1) {                       // reload: the left hand drops to the mag pouch
      var rf = Math.sin(U.clamp01(this.reloadT) * Math.PI);
      foreW = vadd(foreW, [-0.13 * rf, -0.33 * rf, -0.28 * rf]);
    }
    var elbowL = [0.55, -0.9, 0.1], elbowR = [-0.6, -0.85, -0.25];
    if (down > 0.4) { elbowL = [0.4, -1.0, -0.1]; elbowR = [-0.5, -1.0, -0.35]; }
    this._solveArm(B.SHOULDER_L, B.ARM_L, B.FOREARM_L, B.HAND_L, foreW, elbowL, qMul(qWeapon, qEuler(0.1, 0.25, 0.0)));
    this._solveArm(B.SHOULDER_R, B.ARM_R, B.FOREARM_R, B.HAND_R, gripW, elbowR, qWeapon);
    this._compose();
    return this;
  };

  /** Rotation part of a matrix as a quaternion. */
  A._quatOf = function (m) {
    // extract a quaternion from the rotation part
    var t = m[0] + m[5] + m[10], q = this._mq[0];
    void t;
    var x, y, z, w;
    if (t > 0) { w = Math.sqrt(1 + t) * 0.5; x = (m[9] - m[6]) * 0.25 / w; y = (m[2] - m[8]) * 0.25 / w; z = (m[4] - m[1]) * 0.25 / w; }
    else if (m[0] > m[5] && m[0] > m[10]) { x = Math.sqrt(1 + m[0] - m[5] - m[10]) * 0.5; w = (m[9] - m[6]) * 0.25 / x; y = (m[1] + m[4]) * 0.25 / x; z = (m[2] + m[8]) * 0.25 / x; }
    else if (m[5] > m[10]) { y = Math.sqrt(1 + m[5] - m[0] - m[10]) * 0.5; w = (m[2] - m[8]) * 0.25 / y; x = (m[1] + m[4]) * 0.25 / y; z = (m[6] + m[9]) * 0.25 / y; }
    else { z = Math.sqrt(1 + m[10] - m[0] - m[5]) * 0.5; w = (m[4] - m[1]) * 0.25 / z; x = (m[2] + m[8]) * 0.25 / z; y = (m[6] + m[9]) * 0.25 / z; }
    q[0] = x; q[1] = y; q[2] = z; q[3] = w;
    return qNorm(q);
  };

  /** Two-bone IK: place the hand at `targetWorld` (model space), elbow toward `pole`,
   *  hand orientation = `handQuat` (model space). */
  A._solveArm = function (shBone, arBone, faBone, hdBone, targetWorld, pole, handQuat) {
    var pW = this.world[PARENT[arBone]];
    mInvRigid(pW, this._inv);
    var t = mXformPoint(this._inv, targetWorld, [0, 0, 0]);
    var sh = BIND[arBone], fp = BIND[faBone], hp = BIND[hdBone];
    var shoulderLocal = [sh[0], sh[1], sh[2]];
    var relBind = [fp[0] - sh[0], fp[1] - sh[1], fp[2] - sh[2]];
    var L1 = vlen(relBind);
    var L2 = vlen([hp[0] - fp[0], hp[1] - fp[1], hp[2] - fp[2]]);
    var to = vsub(t, shoulderLocal);
    var d = vlen(to);
    var limit = (L1 + L2) * 0.98;
    if (d > limit) { to = vscale(vnorm(to), limit); d = limit; }
    if (d < 1e-4) return;
    var axis = vnorm(to);
    var a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
    var hh = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    var poleV = vnorm(pole);
    var dv = poleV[0] * axis[0] + poleV[1] * axis[1] + poleV[2] * axis[2];
    var perp = vsub(poleV, vscale(axis, dv));
    perp = vlen(perp) < 1e-4 ? vnorm(vcross(axis, [0, 0, 1])) : vnorm(perp);
    var elbow = vadd(shoulderLocal, vadd(vscale(axis, a), vscale(perp, hh)));
    var qUp = qFromTo([0, -1, 0], vnorm(vsub(elbow, shoulderLocal)));
    var qLoWorld = qFromTo([0, -1, 0], vnorm(vsub(t, elbow)));
    this.local[arBone] = qUp;
    this.local[faBone] = qMul(qInv(qUp), qLoWorld);
    // hand: local rotation = inv(forearm world) * desired hand world rotation
    var qFore = qMul(qUp, this.local[faBone]);            // in the parent (chest) frame
    var qParent = this._quatOf(pW);
    var qForeWorld = qMul(qParent, qFore);
    this.local[hdBone] = qNorm(qMul(qInv(qForeWorld), handQuat));
    return this;
  };

  /** Compose world matrices from local rotations/offsets. */
  A._composeWorld = function () {
    for (var i = 0; i < NBONES; i++) {
      var par = PARENT[i];
      var o = OFF[i], q = this.local[i], off = this.off[i];
      var local = mTR([o[0] + off[0], o[1] + off[1], o[2] + off[2]], q, this._tmp2);
      if (par < 0) this.world[i].set(local);
      else mMul(this.world[par], local, this.world[i]);
    }
  };
  /** World matrices + bone matrices (what the GPU wants). */
  A._compose = function () {
    this._composeWorld();
    for (var i = 0; i < NBONES; i++) {
      mMul(this.root, this.world[i], this._tmp);
      mBone(this._tmp, BIND[i], this.boneMat.subarray(i * 16, i * 16 + 16));
    }
    // pad rows (identical to the last bone) so the texture upload stays aligned
    for (i = NBONES; i < ROWS; i++) this.boneMat.set(this.boneMat.subarray(0, 16), i * 16);
    return this.boneMat;
  };

  /* ==========================================================================
   * Rig assembly + GPU plumbing
   * ======================================================================== */
  var KINDS = {
    rifle: { kind: 'rifle', weapon: 'rifle', gear: 1, hp: 100 },
    heavy: { kind: 'heavy', weapon: 'lmg', gear: 1, hp: 145 },
    officer: { kind: 'officer', weapon: 'smg', gear: 1, hp: 90 },
    marksman: { kind: 'rifle', weapon: 'sniper', gear: 1, hp: 95 },
    scout: { kind: 'rifle', weapon: 'smg', gear: 1, hp: 85 },
    crew: { kind: 'rifle', weapon: 'rifle', gear: 0, hp: 90 }
  };

  function Characters(engine) {
    this.E = engine;
    this.G = engine.renderer.G;
    this.meshes = {};        // kind -> uploaded mesh
    this.cmats = {};
    this._built = false;
  }
  var CP = Characters.prototype;

  /** Build + upload one body mesh per class (lazily). */
  CP.mesh = function (kind) {
    var m = this.meshes[kind];
    if (m) return m;
    var spec = KINDS[kind] || KINDS.rifle;
    var geo = buildBody(spec);
    m = TERRA.game.Combat.upload(this.G, geo);
    m.geo = geo;
    this.meshes[kind] = m;
    return m;
  };
  CP.reset = function () {
    var gl = this.G.gl;
    for (var k in this.meshes) if (this.meshes[k]) gl.deleteVertexArray(this.meshes[k].vao);
    this.meshes = {};
  };

  /** Instance attributes 5..10 for the soldier shader (24 floats / 96 bytes each). */
  CP.bindInstances = function (mesh, instBuf) {
    var gl = this.G.gl;
    gl.bindVertexArray(mesh.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    for (var a = 0; a < 6; a++) {
      var loc = 5 + a;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 96, a * 16);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
  };

  /** Stand-alone float texture holding every soldier's bone matrices.
   *  Layout: width 4, one row per bone, RGBA32F (columns = matrix columns). */
  CP.boneTexture = function (rows) {
    return this.G.texture2D(4, rows, { internal: this.G.gl.RGBA32F, format: this.G.gl.RGBA, type: this.G.gl.FLOAT, filter: this.G.gl.NEAREST, mips: false, immutable: false });
  };

  Characters.B = B;
  Characters.NBONES = NBONES;
  Characters.ROWS = ROWS;
  Characters.BIND = BIND;
  Characters.PARENT = PARENT;
  Characters.LEN = LEN;
  Characters.Animator = Animator;
  Characters.KINDS = KINDS;
  Characters.buildBody = buildBody;
  Characters.qEuler = qEuler;
  Characters.qMul = qMul;
  Characters.mTR = mTR;
  TERRA.game.Characters = Characters;
})();
