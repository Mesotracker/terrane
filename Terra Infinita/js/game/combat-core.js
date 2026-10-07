/* =============================================================================
 * TERRA INFINITA — combat core: geometry, ballistics, decals, explosions
 * -----------------------------------------------------------------------------
 * Shared foundation of the first-person shooter layer:
 *
 *   CMAT     material ids shared with shaders/combat.glsl.js
 *   CGeo     mesh builder (pos/normal/uv/tint+AO/material+edge+wear) and upload
 *   Combat.cast()      unified ray query over terrain, buildings, soldiers,
 *                      vehicles, props and water (providers register themselves)
 *   Combat.impact()    per-material impact effects: decals, particles, sound
 *   Combat.explode()   fireball, smoke, dust, shrapnel, crater terrain edit,
 *                      light, shake, damage falloff, chain reactions
 *   Combat.applyDamage() damage routing to soldiers / buildings / vehicles
 *   Combat.decals      bullet holes, blood, scorch and chips on any surface
 *   Combat.tracers     tracers, muzzle flashes, impact flashes, shockwave rings
 *
 * Everything is instanced or pooled: decals and tracers draw in a handful of
 * calls, geometry is one draw call per settlement / vehicle / squad.
 * ========================================================================== */
(function () {
  'use strict';
  var U = TERRA.util, M = TERRA.math;

  /* ---------------- materials (mirror of combat.glsl.js) ---------------- */
  var CMAT = {
    BRICK: 0, PLASTER: 1, CONCRETE: 2, STONE: 3, PLANK: 4, TIMBER: 5, TILE: 6, METAL: 7, RUST: 8,
    PAINT: 9, GLASS: 10, ASPHALT: 11, SANDBAG: 12, CLOTH: 13, WEBBING: 14, SKIN: 15, KEVLAR: 16,
    RUBBER: 17, GRAVEL: 18, EMISSIVE: 19, LENS: 20, STEEL: 21, CANVAS: 22, SAND: 23, DIRT: 24
  };

  /* Per-material projectile resistance (how much "penetration power" one metre costs)
   * and the damage multiplier a bullet keeps after passing through. */
  var ARMOR = {
    brick: { cost: 26, hp: 200, snd: 'crack' }, plaster: { cost: 14, hp: 90, snd: 'crack' },
    concrete: { cost: 52, hp: 420, snd: 'crack' }, stone: { cost: 40, hp: 300, snd: 'crack' },
    plank: { cost: 9, hp: 70, snd: 'wood' }, timber: { cost: 12, hp: 90, snd: 'wood' },
    tile: { cost: 14, hp: 60, snd: 'tile' }, metal: { cost: 30, hp: 220, snd: 'metal' },
    rust: { cost: 12, hp: 80, snd: 'metal' }, paint: { cost: 26, hp: 200, snd: 'metal' },
    glass: { cost: 2, hp: 12, snd: 'glass' }, asphalt: { cost: 40, hp: 300, snd: 'crack' },
    sandbag: { cost: 30, hp: 160, snd: 'sand' }, cloth: { cost: 4, hp: 30, snd: 'cloth' },
    webbing: { cost: 6, hp: 40, snd: 'cloth' }, skin: { cost: 12, hp: 100, snd: 'flesh' },
    kevlar: { cost: 34, hp: 260, snd: 'metal' }, rubber: { cost: 10, hp: 60, snd: 'cloth' },
    gravel: { cost: 18, hp: 120, snd: 'sand' }, emissive: { cost: 4, hp: 20, snd: 'glass' },
    lens: { cost: 2, hp: 10, snd: 'glass' }, steel: { cost: 34, hp: 280, snd: 'metal' },
    canvas: { cost: 4, hp: 25, snd: 'cloth' }, sand: { cost: 14, hp: 100, snd: 'sand' },
    dirt: { cost: 12, hp: 90, snd: 'dirt' }
  };
  var CMAT_NAME = ['brick', 'plaster', 'concrete', 'stone', 'plank', 'timber', 'tile', 'metal', 'rust', 'paint', 'glass',
    'asphalt', 'sandbag', 'cloth', 'webbing', 'skin', 'kevlar', 'rubber', 'gravel', 'emissive', 'lens', 'steel', 'canvas', 'sand', 'dirt'];

  /* ==========================================================================
   * Geometry builder
   * ======================================================================== */
  function CGeo() {
    this.p = []; this.n = []; this.uv = []; this.c = []; this.m = [];
    this.idx = []; this.count = 0;
  }
  CGeo.prototype.vert = function (pos, nrm, uv, col, mat) {
    var i = this.count++;
    this.p.push(pos[0], pos[1], pos[2]);
    this.n.push(nrm[0], nrm[1], nrm[2]);
    this.uv.push(uv[0], uv[1]);
    // colour: tint rgb + ambient occlusion; material: id, edge mask, wear, detail class
    var c = col && col.col ? col.col : (col && col.length ? col : [255, 255, 255]);
    var ao = col && col.ao !== undefined ? col.ao : 255;
    var edge = col && col.edge !== undefined ? col.edge : 0;
    var wear = col && col.wear !== undefined ? col.wear : 0;
    var detail = col && col.detail !== undefined ? col.detail : 0;
    this.c.push(U.clamp(c[0], 0, 255) | 0, U.clamp(c[1], 0, 255) | 0, U.clamp(c[2], 0, 255) | 0, U.clamp(ao, 0, 255) | 0);
    this.m.push(mat | 0, U.clamp(edge, 0, 255) | 0, U.clamp(wear, 0, 255) | 0, detail | 0);
    return i;
  };
  CGeo.prototype.tri = function (a, b, c) { this.idx.push(a, b, c); };
  CGeo.prototype.quad = function (a, b, c, d) { this.idx.push(a, b, c, a, c, d); };
  CGeo.prototype.append = function (g, offset, yaw) {
    var i, off = this.count, o = offset || [0, 0, 0];
    var cs = Math.cos(yaw || 0), sn = Math.sin(yaw || 0);
    for (i = 0; i < g.count; i++) {
      var x = g.p[i * 3], y = g.p[i * 3 + 1], z = g.p[i * 3 + 2];
      var rx = cs * x - sn * z, rz = sn * x + cs * z;
      this.vert([rx + o[0], y + o[1], rz + o[2]], [g.n[i * 3], g.n[i * 3 + 1], g.n[i * 3 + 2]],
        [g.uv[i * 2], g.uv[i * 2 + 1]], null, g.m[i * 4]);
      // copy packed attrs directly
      var k = this.count - 1;
      this.c[k * 4] = g.c[i * 4]; this.c[k * 4 + 1] = g.c[i * 4 + 1]; this.c[k * 4 + 2] = g.c[i * 4 + 2]; this.c[k * 4 + 3] = g.c[i * 4 + 3];
      this.m[k * 4] = g.m[i * 4]; this.m[k * 4 + 1] = g.m[i * 4 + 1]; this.m[k * 4 + 2] = g.m[i * 4 + 2]; this.m[k * 4 + 3] = g.m[i * 4 + 3];
    }
    for (i = 0; i < g.idx.length; i++) this.idx.push(g.idx[i] + off);
    return this;
  };
  function vsub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function vadd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function vmul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function vcross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function vnorm(a) { var l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

  /** Box with per-face UVs derived from world size (so tiling never stretches).
   *  opts: { mat, col, uvScale, edge (0..1 edge mask), wear, top/roof material } */
  CGeo.prototype.box = function (c, h, opts) {
    opts = opts || {};
    var mat = opts.mat === undefined ? CMAT.CONCRETE : opts.mat;
    var col = opts.col || [230, 230, 230];
    var uvScale = opts.uvScale || 1;
    var edge = opts.edge === undefined ? 200 : opts.edge;
    var wear = opts.wear || 0;
    var x0 = c[0] - h[0], x1 = c[0] + h[0], y0 = c[1] - h[1], y1 = c[1] + h[1], z0 = c[2] - h[2], z1 = c[2] + h[2];
    var mz = opts.matZ === undefined ? mat : opts.matZ;
    var my = opts.matY === undefined ? mat : opts.matY;
    function face(ax, ay, az, bx, by, bz, cx2, cy2, cz2, dx, dy, dz, n, mat2, u, v) {
      var col2 = { col: col, edge: edge, wear: wear };
      var a = this.vert([ax, ay, az], n, [0, 0], col2, mat2);
      var b = this.vert([bx, by, bz], n, [u, 0], col2, mat2);
      var cc = this.vert([cx2, cy2, cz2], n, [u, v], col2, mat2);
      var d = this.vert([dx, dy, dz], n, [0, v], col2, mat2);
      this.quad(a, b, cc, d);
    }
    var u, v;
    u = (x1 - x0) * uvScale; v = (y1 - y0) * uvScale;
    face.call(this, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, [0, 0, 1], mz, u, v);   // +z
    face.call(this, x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, [0, 0, -1], mz, u, v);  // -z
    u = (z1 - z0) * uvScale;
    face.call(this, x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, [1, 0, 0], mz, u, v);   // +x
    face.call(this, x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, [-1, 0, 0], mz, u, v);  // -x
    u = (x1 - x0) * uvScale; v = (z1 - z0) * uvScale;
    face.call(this, x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, [0, 1, 0], my, u, v);   // +y
    face.call(this, x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, [0, -1, 0], mat, u, v);  // -y
    return this;
  };
  /** Quad from 4 points, normal from winding. */
  CGeo.prototype.face = function (a, b, c, d, opts) {
    opts = opts || {};
    var n = vnorm(vcross(vsub(b, a), vsub(d, a)));
    var col = { col: opts.col || [230, 230, 230], edge: opts.edge === undefined ? 30 : opts.edge, wear: opts.wear || 0, ao: opts.ao };
    var mat = opts.mat === undefined ? CMAT.PLANK : opts.mat;
    var us = opts.uvScale || 1;
    var u = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * us, v = Math.hypot(d[0] - a[0], d[1] - a[1], d[2] - a[2]) * us;
    var i0 = this.vert(a, n, [opts.uv0x || 0, opts.uv0y || 0], col, mat);
    var i1 = this.vert(b, n, [(opts.uv0x || 0) + u, opts.uv0y || 0], col, mat);
    var i2 = this.vert(c, n, [(opts.uv0x || 0) + u, (opts.uv0y || 0) + v], col, mat);
    var i3 = this.vert(d, n, [opts.uv0x || 0, (opts.uv0y || 0) + v], col, mat);
    this.quad(i0, i1, i2, i3);
    return this;
  };
  /** Cylinder between p0 and p1 (radius r0..r1). */
  CGeo.prototype.cylinder = function (p0, p1, r0, r1, segs, opts) {
    opts = opts || {};
    var mat = opts.mat === undefined ? CMAT.METAL : opts.mat;
    var col = { col: opts.col || [210, 210, 210], edge: opts.edge === undefined ? 120 : opts.edge, wear: opts.wear || 0 };
    segs = segs || 10;
    var d = vnorm(vsub(p1, p0)), up = Math.abs(d[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
    var s = vnorm(vcross(d, up)), t = vcross(s, d);
    var base = this.count;
    for (var k = 0; k <= segs; k++) {
      var a = k / segs * Math.PI * 2;
      var n = vadd(vmul(s, Math.cos(a)), vmul(t, Math.sin(a)));
      var u = (k / segs) * (opts.uvScale || 1);
      this.vert(vadd(p0, vmul(n, r0)), n, [u, 0], col, mat);
      this.vert(vadd(p1, vmul(n, r1)), n, [u, (opts.uvScale || 1) * Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2])], col, mat);
    }
    for (k = 0; k < segs; k++) { var i0 = base + k * 2; this.quad(i0, i0 + 2, i0 + 3, i0 + 1); }
    if (opts.caps) {
      var c0 = this.vert(p0, vmul(d, -1), [0, 0], col, mat), c1 = this.vert(p1, d, [0, 0], col, mat);
      for (k = 0; k < segs; k++) {
        var a0 = k / segs * Math.PI * 2, a1 = (k + 1) / segs * Math.PI * 2;
        var q0 = vadd(vmul(s, Math.cos(a0)), vmul(t, Math.sin(a0))), q1 = vadd(vmul(s, Math.cos(a1)), vmul(t, Math.sin(a1)));
        this.tri(c0, this.vert(vadd(p0, vmul(q1, r0)), vmul(d, -1), [0, 0], col, mat), this.vert(vadd(p0, vmul(q0, r0)), vmul(d, -1), [0, 0], col, mat));
        this.tri(c1, this.vert(vadd(p1, vmul(q0, r1)), d, [0, 0], col, mat), this.vert(vadd(p1, vmul(q1, r1)), d, [0, 0], col, mat));
      }
    }
    return this;
  };
  /** Flat slab (floor / road / roof plane) given a centre, half extents in x/z and a y. */
  CGeo.prototype.slab = function (cx, y, cz, hx, hz, opts) {
    opts = opts || {};
    var a = [cx - hx, y, cz + hz], b = [cx + hx, y, cz + hz], c = [cx + hx, y, cz - hz], d = [cx - hx, y, cz - hz];
    this.face(a, b, c, d, opts);
    if (opts.thickness) {
      var th = opts.thickness;
      this.face([a[0], y - th, a[2]], [b[0], y - th, b[2]], [c[0], y - th, c[2]], [d[0], y - th, d[2]], { mat: opts.mat, col: opts.col, uvScale: opts.uvScale, edge: opts.edge });
    }
    return this;
  };
  /** Rotated box (yaw) — used for barricades, containers, wrecks. */
  CGeo.prototype.rotBox = function (c, h, yaw, opts) {
    var g = new CGeo(); g.box([0, 0, 0], h, opts);
    this.append(g, c, yaw);
    return this;
  };
  CGeo.prototype.bounds = function () {
    var r = 0, top = -1e9, bot = 1e9;
    for (var i = 0; i < this.count; i++) {
      r = Math.max(r, Math.hypot(this.p[i * 3], this.p[i * 3 + 2]));
      top = Math.max(top, this.p[i * 3 + 1]); bot = Math.min(bot, this.p[i * 3 + 1]);
    }
    return { radius: r, height: top, bottom: bot };
  };

  var STRIDE = 40;
  function upload(G, geo) {
    var gl = G.gl, n = geo.count;
    var buf = new ArrayBuffer(n * STRIDE), f32 = new Float32Array(buf), u8 = new Uint8Array(buf);
    for (var i = 0; i < n; i++) {
      var o = i * STRIDE;
      f32[o >> 2] = geo.p[i * 3]; f32[(o >> 2) + 1] = geo.p[i * 3 + 1]; f32[(o >> 2) + 2] = geo.p[i * 3 + 2];
      f32[(o + 12) >> 2] = geo.n[i * 3]; f32[((o + 12) >> 2) + 1] = geo.n[i * 3 + 1]; f32[((o + 12) >> 2) + 2] = geo.n[i * 3 + 2];
      f32[(o + 24) >> 2] = geo.uv[i * 2]; f32[((o + 24) >> 2) + 1] = geo.uv[i * 2 + 1];
      u8[o + 32] = geo.c[i * 4]; u8[o + 33] = geo.c[i * 4 + 1]; u8[o + 34] = geo.c[i * 4 + 2]; u8[o + 35] = geo.c[i * 4 + 3];
      u8[o + 36] = geo.m[i * 4]; u8[o + 37] = geo.m[i * 4 + 1]; u8[o + 38] = geo.m[i * 4 + 2]; u8[o + 39] = geo.m[i * 4 + 3];
    }
    var vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    var vb = G.buffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, STRIDE, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, STRIDE, 24);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, STRIDE, 32);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 4, gl.UNSIGNED_BYTE, true, STRIDE, 36);
    var big = n > 65535;
    var ib = G.buffer(gl.ELEMENT_ARRAY_BUFFER, big ? new Uint32Array(geo.idx) : new Uint16Array(geo.idx));
    gl.bindVertexArray(null);
    var b = geo.bounds();
    return { vao: vao, vb: vb, ib: ib, count: geo.idx.length, indexType: big ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
      tris: geo.idx.length / 3, radius: b.radius, height: b.height, bottom: b.bottom };
  }

  /* ==========================================================================
   * Ray helpers
   * ======================================================================== */
  function raySphere(o, d, c, r) {
    var fx = o[0] - c[0], fy = o[1] - c[1], fz = o[2] - c[2];
    var b = fx * d[0] + fy * d[1] + fz * d[2], cc = fx * fx + fy * fy + fz * fz - r * r;
    var disc = b * b - cc; if (disc < 0) return null;
    var t = -b - Math.sqrt(disc); return t > 0 ? t : null;
  }
  /** Oriented box: obb = { c:[x,y,z], h:[hx,hy,hz], yaw }. Returns {t, n} or null. */
  function rayOBB(o, d, obb) {
    var cs = Math.cos(-obb.yaw), sn = Math.sin(-obb.yaw);
    var ox = o[0] - obb.c[0], oy = o[1] - obb.c[1], oz = o[2] - obb.c[2];
    var rx = cs * ox - sn * oz, rz = sn * ox + cs * oz, ry = oy;
    var dx = cs * d[0] - sn * d[2], dz = sn * d[0] + cs * d[2], dy = d[1];
    var tn = -1e9, tf = 1e9, axis = -1, sign = 1;
    var h = obb.h;
    for (var a = 0; a < 3; a++) {
      var po = a === 0 ? rx : (a === 1 ? ry : rz), pd = a === 0 ? dx : (a === 1 ? dy : dz), ha = h[a];
      if (Math.abs(pd) < 1e-9) { if (po < -ha || po > ha) return null; continue; }
      var t1 = (-ha - po) / pd, t2 = (ha - po) / pd, sg = -1;
      if (t1 > t2) { var tmp = t1; t1 = t2; t2 = tmp; sg = 1; }
      if (t1 > tn) { tn = t1; axis = a; sign = sg; }
      if (t2 < tf) tf = t2;
      if (tn > tf) return null;
    }
    var t = tn > 0 ? tn : (tf > 0 ? tf : null);
    if (t === null) return null;
    var ln = [0, 0, 0];
    var j = t > tn + 1e-6 ? (axis === 0 ? 0 : (axis === 1 ? 1 : 2)) : axis;
    ln[j] = t > tn + 1e-6 ? -sign : sign;
    // rotate the local normal back to world space
    var cs2 = Math.cos(obb.yaw), sn2 = Math.sin(obb.yaw);
    return { t: t, n: [cs2 * ln[0] - sn2 * ln[2], ln[1], sn2 * ln[0] + cs2 * ln[2]] };
  }
  /** Vertical capsule/cylinder hit test (quick for trunks, legs). */
  function rayCylinderY(o, d, c, r, y0, y1) {
    var a = d[0] * d[0] + d[2] * d[2];
    if (a < 1e-9) return null;
    var fx = o[0] - c[0], fz = o[2] - c[2];
    var b = 2 * (fx * d[0] + fz * d[2]), cc = fx * fx + fz * fz - r * r;
    var disc = b * b - 4 * a * cc; if (disc < 0) return null;
    var sq = Math.sqrt(disc);
    for (var k = 0; k < 2; k++) {
      var t = (-b + (k ? sq : -sq)) / (2 * a);
      if (t <= 0) continue;
      var y = o[1] + d[1] * t;
      if (y >= y0 && y <= y1) return t;
    }
    return null;
  }
  function segPointDist(a, b, p) {
    var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    var wx = p[0] - a[0], wy = p[1] - a[1], wz = p[2] - a[2];
    var uu = ux * ux + uy * uy + uz * uz;
    var t = uu > 1e-9 ? U.clamp01((wx * ux + wy * uy + wz * uz) / uu) : 0;
    var px = a[0] + ux * t - p[0], py = a[1] + uy * t - p[1], pz = a[2] + uz * t - p[2];
    return Math.sqrt(px * px + py * py + pz * pz);
  }

  /* ==========================================================================
   * Combat — the module
   * ======================================================================== */
  function Combat(engine) {
    this.E = engine;
    var G = engine.renderer.G;
    this.G = G; this.gl = G.gl;
    this.providers = [];
    this.decals = new Decals(engine);
    this.tracers = new Tracers(engine);
    this.time = 0;
    this._lastImpact = 0;
    this.sfxCount = 0;
  }
  var P = Combat.prototype;
  Combat.CMAT = CMAT;
  Combat.CMAT_NAME = CMAT_NAME;
  Combat.ARMOR = ARMOR;
  Combat.CGeo = CGeo;
  Combat.upload = upload;
  Combat.rayOBB = rayOBB;
  Combat.raySphere = raySphere;
  Combat.rayCylinderY = rayCylinderY;
  Combat.segPointDist = segPointDist;

  /** Register a ray provider: fn(origin, dir, maxT, filter, out) → {t, ...} | null */
  P.addProvider = function (fn) { this.providers.push(fn); return fn; };
  P.removeProvider = function (fn) { var i = this.providers.indexOf(fn); if (i >= 0) this.providers.splice(i, 1); };

  /**
   * Cast a ray through every registered provider plus a terrain march.
   * filter: { skip: [types], team: n, ignore, through: [types] } — `through` types are
   * reported as `pierced` so bullets can punch through several thin panels.
   */
  P.cast = function (o, d, maxT, filter) {
    filter = filter || {};
    var best = null, i;
    var skip = filter.skip || [];
    function consider(h) {
      if (!h || h.t === undefined || h.t > maxT) return;
      if (h.t < 0.02) h.t = 0.02;
      for (var s = 0; s < skip.length; s++) if (skip[s] === h.type) return;
      if (!best || h.t < best.t) best = h;
    }
    // terrain march (analytic + edits, same as the rendered terrain)
    var march = terraRay(this.E, o, d, maxT);
    if (march) consider(march);
    for (i = 0; i < this.providers.length; i++) {
      var h = null;
      try { h = this.providers[i](o, d, best ? Math.min(best.t, maxT) : maxT, filter); } catch (e) { /* provider must never break the shot */ }
      consider(h);
    }
    if (!best) return null;
    best.p = [o[0] + d[0] * best.t, o[1] + d[1] * best.t, o[2] + d[2] * best.t];
    if (best.n && best.type !== 'terrain') { /* keep provider normal */ }
    return best;
  };

  /** March the terrain: returns {t, n, type:'terrain'} or null. */
  function terraRay(E, o, d, maxT) {
    var step = Math.max(0.06, Math.min(0.5, maxT * 0.002));
    var t = 0.05, hit = null;
    // long rays: coarse march then a fine refine (keeps bullets cheap at 1 km)
    while (t < maxT) {
      var x = o[0] + d[0] * t, y = o[1] + d[1] * t, z = o[2] + d[2] * t;
      var gh = E.groundHeight(x, z);
      if (y <= gh) { hit = t; break; }
      t += Math.max(step, t * 0.012);
    }
    if (hit === null) return null;
    var lo = Math.max(0.02, hit - Math.max(step, hit * 0.012)), hi = hit;
    for (var k = 0; k < 8; k++) {
      var mid = (lo + hi) * 0.5;
      var mx = o[0] + d[0] * mid, my = o[1] + d[1] * mid, mz = o[2] + d[2] * mid;
      if (my <= E.groundHeight(mx, mz)) hi = mid; else lo = mid;
    }
    var t2 = hi;
    var px = o[0] + d[0] * t2, py = o[1] + d[1] * t2, pz = o[2] + d[2] * t2;
    var e = 0.7;
    var gx = (E.groundHeight(px + e, pz) - E.groundHeight(px - e, pz)) / (2 * e);
    var gz = (E.groundHeight(px, pz + e) - E.groundHeight(px, pz - e)) / (2 * e);
    var w = E.waterAt(px, pz);
    var surf = (w.level > -1e4 && w.type !== 4 && py < w.level + 0.05) ? 'water' : surfName(E, px, pz);
    return { t: t2, type: 'terrain', surface: surf, n: vnorm([-gx, 1, -gz]), p: [px, py, pz] };
  }
  function surfName(E, x, z) {
    var env = E.environment.env, L = E.environment.local, Sf = TERRA.game.Surfaces;
    var e = 0.6;
    var gx = (E.groundHeight(x + e, z) - E.groundHeight(x - e, z)) / (2 * e);
    var gz = (E.groundHeight(x, z + e) - E.groundHeight(x, z - e)) / (2 * e);
    var name = Sf.classify(env, L, Math.hypot(gx, gz), 0, Sf.puddleAt(E, x, z, env));
    if (name === 'sand') return 'sand';
    if (name === 'snow') return 'snow';
    if (name === 'mud') return 'dirt';
    if (name === 'rock' || name === 'ice') return 'rock';
    if (name === 'water' || name === 'puddle') return 'water';
    if (name === 'grass' || name === 'leaves' || name === 'path') return 'dirt';
    return 'dirt';
  }

  /* ==========================================================================
   * Impact effects
   * ======================================================================== */
  var IMPACT = {
    brick: { decal: 0, dust: [0.62, 0.55, 0.5], chips: [0.5, 0.28, 0.22], snd: 'crack', n: 12 },
    plaster: { decal: 0, dust: [0.72, 0.7, 0.64], chips: [0.6, 0.58, 0.52], snd: 'crack', n: 12 },
    concrete: { decal: 4, dust: [0.6, 0.6, 0.58], chips: [0.45, 0.45, 0.43], snd: 'crack', n: 14 },
    stone: { decal: 4, dust: [0.55, 0.53, 0.5], chips: [0.42, 0.4, 0.38], snd: 'crack', n: 12 },
    plank: { decal: 6, dust: [0.5, 0.38, 0.24], chips: [0.55, 0.4, 0.24], snd: 'wood', n: 10 },
    timber: { decal: 6, dust: [0.45, 0.34, 0.2], chips: [0.5, 0.36, 0.2], snd: 'wood', n: 12 },
    tile: { decal: 4, dust: [0.5, 0.32, 0.26], chips: [0.45, 0.24, 0.18], snd: 'tile', n: 12 },
    metal: { decal: 5, dust: [0.6, 0.6, 0.62], chips: null, sparks: 10, snd: 'metal', n: 6 },
    rust: { decal: 5, dust: [0.5, 0.35, 0.22], chips: null, sparks: 6, snd: 'metal', n: 6 },
    paint: { decal: 5, dust: [0.55, 0.55, 0.58], chips: null, sparks: 8, snd: 'metal', n: 6 },
    glass: { decal: 3, dust: [0.75, 0.8, 0.85], chips: [0.8, 0.85, 0.9], snd: 'glass', n: 16 },
    asphalt: { decal: 4, dust: [0.35, 0.35, 0.36], chips: [0.3, 0.3, 0.3], snd: 'crack', n: 10 },
    sandbag: { decal: 7, dust: [0.55, 0.48, 0.32], chips: [0.5, 0.44, 0.3], snd: 'sand', n: 12 },
    cloth: { decal: null, dust: [0.4, 0.4, 0.34], chips: null, snd: 'cloth', n: 5 },
    webbing: { decal: null, dust: [0.35, 0.35, 0.3], chips: null, snd: 'cloth', n: 5 },
    skin: { decal: 1, blood: 14, snd: 'flesh', n: 0 },
    kevlar: { decal: null, dust: [0.45, 0.45, 0.42], sparks: 4, snd: 'metal', n: 5 },
    rubber: { decal: null, dust: [0.2, 0.2, 0.2], chips: null, snd: 'cloth', n: 5 },
    gravel: { decal: null, dust: [0.5, 0.48, 0.44], chips: [0.42, 0.4, 0.38], snd: 'sand', n: 12 },
    sand: { decal: 7, dust: [0.72, 0.66, 0.5], chips: null, snd: 'sand', n: 10 },
    snow: { decal: null, dust: [0.9, 0.93, 0.97], chips: null, snd: 'snow', n: 10 },
    dirt: { decal: 7, dust: [0.44, 0.38, 0.3], chips: [0.35, 0.3, 0.25], snd: 'dirt', n: 12 },
    rock: { decal: 4, dust: [0.5, 0.5, 0.48], chips: [0.4, 0.4, 0.38], sparks: 3, snd: 'crack', n: 12 },
    water: { decal: null, water: 1, snd: 'splash', n: 0 },
    foliage: { decal: null, chips: [0.3, 0.42, 0.16], snd: 'leaf', n: 8 },
    sandbagx: { decal: 7, dust: [0.55, 0.48, 0.32], snd: 'sand', n: 8 }
  };
  Combat.IMPACT = IMPACT;

  /** Surface-type impact: decal + particles + sound. */
  P.impact = function (hit, opts) {
    opts = opts || {};
    var E = this.E, fx = E.effects, tbl = IMPACT[hit.surface || 'dirt'] || IMPACT.dirt;
    var p = hit.p;
    if (!p) return;
    var n = hit.n || [0, 1, 0];
    if (fx) {
      if (tbl.dust && !opts.noParticles) {
        var k = fx.count(tbl.n, p);
        for (var i = 0; i < k; i++) {
          var sp = 1.2 + Math.random() * 3.2;
          fx.emit(TERRA.game.Effects.K.DUST, [p[0], p[1] + 0.03, p[2]],
            [n[0] * sp * Math.random() + (Math.random() - 0.5) * 1.4, n[1] * sp * 0.5 + Math.random() * 1.2, n[2] * sp * Math.random() + (Math.random() - 0.5) * 1.4],
            0.5 + Math.random() * 0.9, 0.05 + Math.random() * 0.1, 0.55, tbl.dust, 0.5);
        }
      }
      if (tbl.chips && !opts.noParticles) {
        var kc = fx.count(tbl.n * 0.7, p);
        for (var c = 0; c < kc; c++) {
          fx.emit(TERRA.game.Effects.K.CHIP, [p[0], p[1] + 0.02, p[2]],
            [n[0] * (1 + Math.random() * 5) + (Math.random() - 0.5) * 4, 1 + Math.random() * 4, n[2] * (1 + Math.random() * 5) + (Math.random() - 0.5) * 4],
            0.8 + Math.random() * 1.2, 0.02 + Math.random() * 0.03, 0, tbl.chips, 1, Math.random() * 6);
        }
      }
      if (tbl.sparks && !opts.noParticles) fx.sparks([p[0] + n[0] * 0.05, p[1] + n[1] * 0.05, p[2] + n[2] * 0.05], tbl.sparks, 3.4);
      if (tbl.blood && !opts.noParticles) this.blood(p, n, tbl.blood, opts);
      if (tbl.water && E.watersim) E.watersim.addDrop(p[0], p[2], 0.5, 0.03);
    }
    if (tbl.decal !== null && tbl.decal !== undefined && !opts.noDecal) {
      var size = opts.decalSize || (hit.type === 'terrain' ? 0.4 : 0.24);
      this.decals.add(p, n, tbl.decal, size * (0.8 + Math.random() * 0.6), 0.9);
    }
    if (hit.surface !== 'skin' && hit.surface !== 'foliage') this.sfx(tbl.snd, p, 0.55);
    TERRA.events.emit('impact', { hit: hit });
  };

  /** Blood spray (hit soldier) + occasional ground splat. */
  P.blood = function (p, n, amount, opts) {
    var fx = this.E.effects;
    if (!fx) return;
    var k = fx.count(amount, p);
    for (var i = 0; i < k; i++) {
      var sp = 1.5 + Math.random() * 5.5;
      fx.emit(TERRA.game.Effects.K.SPARK, [p[0], p[1], p[2]],
        [n[0] * sp * (0.4 + Math.random()) + (Math.random() - 0.5) * 3, n[1] * sp * 0.4 + Math.random() * 2.4, n[2] * sp * (0.4 + Math.random()) + (Math.random() - 0.5) * 3],
        0.3 + Math.random() * 0.5, 0.02 + Math.random() * 0.035, 0.4, [0.42, 0.03, 0.03], 0.85);
    }
    if (Math.random() < 0.5) {
      var gx = p[0] + (Math.random() - 0.5) * 1.4, gz = p[2] + (Math.random() - 0.5) * 1.4;
      this.decals.add([gx, this.E.groundHeight(gx, gz) + 0.02, gz], [0, 1, 0], 1, 0.4 + Math.random() * 0.5, 0.85);
    }
  };

  /* ==========================================================================
   * Damage routing
   * ======================================================================== */
  /** Armour interaction: how much damage survives `meters` of material. */
  P.through = function (material, meters, power) {
    var a = ARMOR[material] || ARMOR.concrete;
    return power - a.cost * meters;
  };
  /** Apply damage to whatever the ray hit. opts: { source, team, head, dmg, pen, explosive } */
  P.applyDamage = function (hit, dmg, opts) {
    opts = opts || {};
    var E = this.E;
    if (hit.type === 'soldier' && E.soldiers) return E.soldiers.damage(hit.ref, dmg, hit, opts);
    if (hit.type === 'building' && E.buildings) return E.buildings.damage(hit.ref, hit.part, dmg, hit, opts);
    if (hit.type === 'gvehicle' && E.gvehicles) return E.gvehicles.damage(hit.ref, hit.part, dmg, hit, opts);
    if (hit.type === 'vehicle' && E.vehicles) { if (E.vehicles.damage) return E.vehicles.damage(hit.ref, dmg, hit, opts); }
    if (hit.type === 'object' && E.throwables) { /* props are cosmetic: nudge them */ }
    if (hit.type === 'player' && E.warmode) return E.warmode.damagePlayer(dmg, opts);
    return { killed: false, blocked: true };
  };

  /* ==========================================================================
   * Explosions
   * ======================================================================== */
  /**
   * detonate(pos, power, opts)
   *   power  1 = 40 mm grenade, 2 = frag grenade, 4 = tank shell / RPG,
   *          8 = artillery / airstrike, 12 = demolition charge
   *   opts: { team, source, terrain (crater), damage, water, smoke, flash }
   */
  P.explode = function (pos, power, opts) {
    opts = opts || {};
    var E = this.E, fx = E.effects, R = this.blastRadius(power);
    var wi = E.waterAt(pos[0], pos[2]), gh = E.groundHeight(pos[0], pos[2]);
    var inWater = wi.level > -1e4 && wi.type !== 4 && pos[1] < wi.level + 0.4;
    var p = [pos[0], Math.max(pos[1], inWater ? wi.level : gh), pos[2]];
    // --- visuals
    if (fx) {
      fx.explosion(p, Math.min(4, power * 0.8 + 0.6), inWater);
      // extra fireball shells for a fuller, hotter core
      var shells = Math.min(26, Math.round(6 + power * 2.4));
      for (var i = 0; i < shells; i++) {
        var a = Math.random() * Math.PI * 2, e = Math.random() * 1.1, s = (1.5 + Math.random() * 4) * Math.min(2.2, power * 0.5 + 0.7);
        fx.emit(TERRA.game.Effects.K.FIRE, [p[0], p[1] + 0.4 + Math.random() * power * 0.3, p[2]],
          [Math.cos(a) * Math.cos(e) * s, Math.sin(e) * s * 0.9 + 2.5, Math.sin(a) * Math.cos(e) * s],
          0.3 + Math.random() * 0.5, 0.5 + Math.random() * 0.9, 2.6, [1.0, 0.5 + Math.random() * 0.25, 0.14], 0.95);
      }
      // smoke that keeps rising, then cools to grey
      var puffs = Math.min(40, Math.round(10 + power * 4));
      for (var j = 0; j < puffs; j++) {
        var a2 = Math.random() * Math.PI * 2, s2 = (1 + Math.random() * 4) * power * 0.5;
        var g = 0.2 + Math.random() * 0.14;
        fx.emit(TERRA.game.Effects.K.SMOKE, [p[0] + (Math.random() - 0.5) * power, p[1] + 0.6 + Math.random() * power * 1.2, p[2] + (Math.random() - 0.5) * power],
          [Math.cos(a2) * s2, 3 + Math.random() * 5 * Math.min(2, power * 0.4 + 0.6), Math.sin(a2) * s2],
          4 + Math.random() * 6, 0.9 + power * 0.55, 1.7 + power * 0.4,
          inWater ? [0.85, 0.88, 0.92] : [g, g * 0.96, g * 0.92], inWater ? 0.4 : 0.6);
      }
      // ground dust ring
      if (!inWater) {
        var ringN = Math.min(34, Math.round(8 + power * 3));
        for (var k = 0; k < ringN; k++) {
          var a3 = k / ringN * Math.PI * 2 + Math.random() * 0.2, sp2 = 6 + Math.random() * 6 * Math.min(3, power);
          fx.emit(TERRA.game.Effects.K.DUST, [p[0], gh + 0.15, p[2]],
            [Math.cos(a3) * sp2, 0.6 + Math.random() * 1.6, Math.sin(a3) * sp2],
            1.6 + Math.random() * 2.2, 0.4 + Math.random() * 0.6, 1.5, [0.5, 0.45, 0.38], 0.5);
        }
      }
      fx.sparks(p, Math.floor(30 * Math.min(4, power)), 8 * Math.min(3, power));
      fx.lights.push({ pos: [p[0], p[1] + 2, p[2]], color: [12 * Math.min(2, power * 0.5 + 0.7), 6.5, 2.2], radius: 22 * Math.min(3, power * 0.4 + 0.8), age: 0, life: 0.5 + power * 0.05 });
    }
    // shockwave ring + shrapnel streaks (additive quads)
    this.tracers.ring(p, this.blastRadius(power) * 1.5, [1.0, 0.72, 0.4], 0.45);
    var dirs = Math.min(22, Math.round(6 + power * 2));
    for (var s3 = 0; s3 < dirs; s3++) {
      var th = Math.random() * Math.PI * 2, ph = Math.random() * 0.9 - 0.15;
      var dx = Math.cos(th) * Math.cos(ph), dy = Math.sin(ph) + 0.25, dz = Math.sin(th) * Math.cos(ph);
      var L = R * (0.55 + Math.random() * 0.8);
      this.tracers.streak([p[0] + dx * 0.4, p[1] + dy * 0.4 + 0.3, p[2] + dz * 0.4],
        [p[0] + dx * L, p[1] + dy * L, p[2] + dz * L], [1.0, 0.55, 0.22], 0.12 + Math.random() * 0.2, 0.02);
    }
    // --- terrain: crater, scorch, forest shredding
    if (opts.terrain !== false && !inWater && p[1] < gh + 2.5) this.crater(p, R, power);
    if (inWater && E.watersim) { E.watersim.addDrop(p[0], p[2], R * 1.2, 0.5); E.watersim.addDrop(p[0], p[2], R * 0.5, 0.6); }
    // --- entities
    if (opts.damage !== false) this.blastDamage(p, power, R, opts);
    // --- sound + shake
    this.sfx('explosion', p, Math.min(1.6, 0.6 + power * 0.12), power);
    if (fx && E.camera) {
      var d = Math.hypot(p[0] - E.camera.world[0], p[1] - E.camera.world[1], p[2] - E.camera.world[2]);
      fx.shake = Math.max(fx.shake, U.clamp(1.5 - d / (70 * Math.min(3, power * 0.5 + 0.7)), 0, 1) * (0.35 + power * 0.1));
    }
    TERRA.events.emit('explosion', { pos: p, power: power });
  };

  P.blastRadius = function (power) { return 2.4 + power * 1.9; };

  /** Radial damage with line-of-sight checks; also shoves bodies, vehicles and props. */
  P.blastDamage = function (p, power, R, opts) {
    var E = this.E, dmg0 = 55 * power, i;
    // soldiers
    var sd = E.soldiers;
    if (sd) {
      var list = sd.queryRadius(p, R * 1.35);
      for (i = 0; i < list.length; i++) {
        var s = list[i];
        if (s.dead) continue;
        var dist = Math.hypot(s.pos[0] - p[0], s.pos[1] + 0.9 - p[1], s.pos[2] - p[2]);
        var los = this.cast([p[0], p[1] + 0.4, p[2]], vnorm([s.pos[0] - p[0], s.pos[1] + 0.9 - p[1], s.pos[2] - p[2]]), dist - 0.4, { skip: ['soldier'] });
        var cover = los && los.t < dist - 0.5 ? 0.28 : 1;
        var dmg = dmg0 * Math.pow(U.clamp01(1 - dist / (R * 1.2)), 1.6) * cover;
        if (dmg < 1) continue;
        sd.damage(s, dmg, { p: [s.pos[0], s.pos[1] + 1.1, s.pos[2]], n: vnorm([s.pos[0] - p[0], 0.4, s.pos[2] - p[2]]) },
          { explosive: true, source: opts.source, team: opts.team });
        sd.push(s, [(s.pos[0] - p[0]) / Math.max(0.6, dist), 0.6 + Math.random(), (s.pos[2] - p[2]) / Math.max(0.6, dist)], power * 1.8 * cover);
      }
    }
    // the player
    if (E.warmode) {
      var pl = E.player, pd = Math.hypot(pl.pos[0] - p[0], pl.pos[1] + 1 - p[1], pl.pos[2] - p[2]);
      if (pd < R * 1.5) {
        var pLos = this.cast([p[0], p[1] + 0.4, p[2]], vnorm([pl.pos[0] - p[0], pl.pos[1] + 1 - p[1], pl.pos[2] - p[2]]), pd - 0.5, { skip: ['soldier'] });
        var pCover = pLos && pLos.t < pd - 0.6 ? 0.25 : 1;
        var pdmg = dmg0 * Math.pow(U.clamp01(1 - pd / (R * 1.2)), 1.6) * pCover;
        if (pdmg >= 1) E.warmode.damagePlayer(pdmg, { explosive: true, source: opts.source, pos: p });
        var kx = (pl.pos[0] - p[0]) / Math.max(0.6, pd), kz = (pl.pos[2] - p[2]) / Math.max(0.6, pd);
        pl.vel[0] += kx * power * 2.2 * pCover; pl.vel[1] += (0.5 + Math.random() * 0.5) * power * 2.4 * pCover; pl.vel[2] += kz * power * 2.2 * pCover;
      }
    }
    // buildings (structural damage)
    if (E.buildings) E.buildings.blast(p, power, R, opts);
    // ground vehicles
    if (E.gvehicles) E.gvehicles.blast(p, power, R, opts);
    // vehicles (boats/planes/bikes), props and trees
    if (E.vehicles && E.vehicles.impulse) E.vehicles.impulse(p, power * 1.4, R * 3.6);
    if (E.throwables) for (i = 0; i < E.throwables.objs.length; i++) {
      var ob = E.throwables.objs[i];
      var vx = ob.pos[0] - p[0], vy = ob.pos[1] - p[1], vz = ob.pos[2] - p[2], dl = Math.hypot(vx, vy, vz);
      if (dl > R * 4 || dl < 1e-3) continue;
      var imp = power * 700 * Math.pow(1 - dl / (R * 4), 2) / Math.sqrt(Math.max(1, ob.mass));
      ob.vel[0] += vx / dl * imp; ob.vel[1] += Math.abs(vy / dl) * imp + imp * 0.4; ob.vel[2] += vz / dl * imp;
      ob.sleep = 0; ob.frozen = false;
    }
    // knock trees over
    var veg = E.vegetation, tools = E.tools;
    if (veg && tools && tools._fell) {
      var cols = veg.collidersNear(p[0], p[2], R + 2.5, true), done = {};
      for (i = 0; i < cols.length; i += 4) {
        var ddx = cols[i] - p[0], ddz = cols[i + 1] - p[2], dd = Math.hypot(ddx, ddz);
        if (dd > R + 1.5 || cols[i + 2] > 1.2) continue;
        var key = cols[i].toFixed(1) + ',' + cols[i + 1].toFixed(1);
        if (done[key]) continue; done[key] = 1;
        try {
          var tr = tools._treeRecord({ cx: cols[i], cz: cols[i + 1] });
          if (tr && tr.type !== 10 && tr.type !== 9) tools._fell(tr, cols[i + 2], [ddx || 0.1, ddz || 0.1]);
        } catch (e) { /* trees are optional */ }
      }
    }
    // chain reactions: other explosives detonate
    if (E.soldiers) E.soldiers.chainExplosives(p, R * 1.4);
  };

  /** Crater: bowl with a lip, scorched, grass stripped (persistent terrain edit). */
  P.crater = function (p, R, power) {
    var E = this.E, ed = E.edits, tools = E.tools;
    var depth = 0.45 * power;
    var x0 = Math.floor(p[0] - R * 1.3), x1 = Math.ceil(p[0] + R * 1.3), z0 = Math.floor(p[2] - R * 1.3), z1 = Math.ceil(p[2] + R * 1.3);
    for (var z = z0; z <= z1; z++) for (var x = x0; x <= x1; x++) {
      var r = Math.hypot(x - p[0], z - p[2]) / R;
      if (r > 1.3) continue;
      var d = r < 1 ? -depth * Math.pow(1 - r * r, 1.5) : 0;
      d += depth * 0.26 * Math.exp(-Math.pow((r - 1.0) / 0.2, 2));
      if (d !== 0) ed._addHeight(x, z, d);
    }
    if (tools && tools._editBrush && tools._commit) {
      var B = tools._editBrush(R * 1.15, 1);
      var bb = ed.applyPaint(p[0], p[2], B, 1, 10);
      try { tools._commit([Math.min(bb[0], x0 - 2), Math.min(bb[1], z0 - 2), Math.max(bb[2], x1 + 2), Math.max(bb[3], z1 + 2)]); } catch (e) { /* ignore */ }
    }
    if (E.interaction) E.interaction.stamps.push({ kind: 1, x: p[0], z: p[2], r: R * 2.0 });
    this.decals.add([p[0], E.groundHeight(p[0], p[2]) + 0.03, p[2]], [0, 1, 0], 2, R * 1.15, 0.7);
    // flung soil
    var fx = E.effects;
    if (fx) {
      var n = Math.min(40, Math.round(8 + power * 3));
      for (var i = 0; i < n; i++) {
        var a = Math.random() * Math.PI * 2, s = 3 + Math.random() * 6 * Math.min(2.5, power * 0.5 + 0.6);
        fx.emit(TERRA.game.Effects.K.DEBRIS, [p[0], p[1] + 0.2, p[2]],
          [Math.cos(a) * s, 3 + Math.random() * 7, Math.sin(a) * s],
          2 + Math.random() * 2, 0.04 + Math.random() * 0.1, 0, [0.24, 0.2, 0.15], 1, Math.random() * 6);
      }
    }
    if (E.buildings) E.buildings.craterScorch(p, R);
  };

  /* ==========================================================================
   * Sound (synthesised — no audio files)
   * ======================================================================== */
  var SND = {
    crack: function (A, g, pan) {
      A._burst({ freq: 2400, q: 1.1, len: 0.09, gain: 0.5 * g, sweep: 900, pan: pan });
      A._burst({ freq: 380, type: 'lowpass', q: 0.8, len: 0.12, gain: 0.45 * g, pan: pan });
      A._burst({ freq: 5200, q: 2.5, len: 0.05, gain: 0.18 * g, delay: 0.012, pan: pan });
    },
    wood: function (A, g, pan) {
      A._burst({ freq: 900, q: 1.6, len: 0.1, gain: 0.35 * g, sweep: 400, pan: pan });
      A._burst({ freq: 260, type: 'lowpass', len: 0.16, gain: 0.4 * g, pan: pan });
      for (var i = 0; i < 3; i++) A._burst({ freq: 2200 + Math.random() * 1800, q: 3, len: 0.04, gain: 0.1 * g, delay: i * 0.02, pan: pan });
    },
    tile: function (A, g, pan) {
      A._burst({ freq: 3200, q: 2, len: 0.08, gain: 0.3 * g, sweep: 1400, pan: pan });
      A._burst({ freq: 700, q: 1.2, len: 0.12, gain: 0.2 * g, pan: pan });
    },
    metal: function (A, g, pan) {
      A._tone({ f0: 1850 + Math.random() * 900, f1: 900, len: 0.3, gain: 0.09 * g, wave: 'triangle', pan: pan, dest: A.fx });
      A._burst({ freq: 4200, q: 5, len: 0.09, gain: 0.3 * g, pan: pan });
      A._burst({ freq: 220, q: 1.4, len: 0.1, gain: 0.24 * g, pan: pan });
    },
    glass: function (A, g, pan) {
      for (var i = 0; i < 7; i++) A._burst({ freq: 3000 + Math.random() * 4000, q: 6, len: 0.05 + Math.random() * 0.08, gain: 0.16 * g, delay: i * 0.015, pan: pan });
      A._burst({ freq: 1200, q: 2, len: 0.16, gain: 0.2 * g, pan: pan });
    },
    sand: function (A, g, pan) { A._burst({ freq: 1400, q: 0.7, len: 0.14, gain: 0.35 * g, sweep: 600, pan: pan }); },
    snow: function (A, g, pan) { A._burst({ freq: 2600, q: 1.5, len: 0.07, gain: 0.18 * g, pan: pan }); A._burst({ freq: 400, type: 'lowpass', len: 0.07, gain: 0.2 * g, pan: pan }); },
    dirt: function (A, g, pan) { A._burst({ freq: 500, type: 'lowpass', q: 1.2, len: 0.14, gain: 0.42 * g, sweep: 220, pan: pan }); },
    cloth: function (A, g, pan) { A._burst({ freq: 700, q: 1.1, len: 0.09, gain: 0.16 * g, pan: pan }); },
    flesh: function (A, g, pan) { A._burst({ freq: 320, type: 'lowpass', q: 1.4, len: 0.14, gain: 0.35 * g, sweep: 150, pan: pan }); A._burst({ freq: 900, q: 0.9, len: 0.08, gain: 0.14 * g, pan: pan }); },
    leaf: function (A, g, pan) { A._burst({ freq: 3400, q: 1.2, len: 0.12, gain: 0.12 * g, pan: pan }); },
    splash: function (A, g, pan) { A._burst({ freq: 1100, q: 0.9, len: 0.3, gain: 0.3 * g, sweep: 500, pan: pan }); },
    explosion: function (A, g, pan, power) {
      var p = Math.max(1, power || 1);
      A._burst({ buf: A.brown, freq: 70 + 60 / p, type: 'lowpass', q: 0.6, len: 1.4 + p * 0.15, attack: 0.01, gain: Math.min(1.5, 0.7 * g), pan: pan });
      A._burst({ freq: 1800, type: 'highpass', q: 0.7, len: 0.3, gain: 0.5 * g, sweep: 300, pan: pan });
      A._burst({ buf: A.brown, freq: 220, q: 1.2, len: 0.8, attack: 0.02, gain: 0.5 * g, delay: 0.05, pan: pan });
      A._burst({ freq: 3600, q: 0.8, len: 1.2, gain: 0.2 * g, delay: 0.2, pan: pan });
    },
    whiz: function (A, g, pan) { A._burst({ freq: 4200, q: 6, len: 0.05, gain: 0.12 * g, sweep: 1400, pan: pan }); },
    hit: function (A, g, pan) { A._tone({ f0: 1500, f1: 900, len: 0.07, gain: 0.06 * g, wave: 'square', pan: pan, dest: A.fx }); },
    shell: function (A, g, pan) { A._burst({ freq: 5200, q: 3, len: 0.05, gain: 0.1 * g, pan: pan }); A._tone({ f0: 3200, f1: 1400, len: 0.09, gain: 0.03 * g, pan: pan, dest: A.fx }); },
    reload: function (A, g, pan) { A._burst({ freq: 1400, q: 2, len: 0.06, gain: 0.16 * g, pan: pan }); A._burst({ freq: 2600, q: 3, len: 0.05, gain: 0.12 * g, delay: 0.09, pan: pan }); },
    shot: function (A, g, pan, power) {
      var p = power || 1;
      // crack + body: a rifle report has a sharp transient and a low thump
      A._burst({ freq: 5200 + Math.random() * 900, q: 0.7, len: 0.055, gain: 0.62 * g, sweep: 1200, pan: pan });
      A._burst({ buf: A.brown, freq: 260 + 120 / p, q: 0.9, len: 0.22 + 0.08 * p, attack: 0.004, gain: Math.min(1.1, 0.5 * g * (0.8 + p * 0.25)), pan: pan });
      A._burst({ freq: 900, type: 'lowpass', q: 1.4, len: 0.16, gain: 0.3 * g, sweep: 240, pan: pan });
      A._burst({ freq: 2600, type: 'highpass', q: 0.8, len: 0.4, gain: 0.1 * g, delay: 0.02, pan: pan });   // tail / reverb
    },
    shotHeavy: function (A, g, pan, power) {
      var p = power || 1.4;
      A._burst({ freq: 3800, q: 0.6, len: 0.08, gain: 0.7 * g, sweep: 700, pan: pan });
      A._burst({ buf: A.brown, freq: 150, q: 0.8, len: 0.34, attack: 0.005, gain: Math.min(1.3, 0.6 * g * p), pan: pan });
      A._burst({ freq: 700, type: 'lowpass', q: 1.2, len: 0.3, gain: 0.34 * g, sweep: 180, pan: pan });
    },
    shotSilenced: function (A, g, pan) {
      A._burst({ freq: 2400, q: 1.4, len: 0.05, gain: 0.16 * g, pan: pan });
      A._burst({ buf: A.brown, freq: 320, q: 1.2, len: 0.1, gain: 0.2 * g, pan: pan });
      A._burst({ freq: 1800, q: 3, len: 0.07, gain: 0.1 * g, delay: 0.01, pan: pan });
    },
    dry: function (A, g, pan) { A._burst({ freq: 3600, q: 5, len: 0.03, gain: 0.2 * g, pan: pan }); },
    bell: function (A, g, pan) { A._tone({ f0: 2200, f1: 1200, len: 0.3, gain: 0.1 * g, wave: 'sine', pan: pan, dest: A.fx }); },
    bolt: function (A, g, pan) { A._burst({ freq: 2200, q: 4, len: 0.07, gain: 0.2 * g, pan: pan }); A._burst({ freq: 900, q: 2, len: 0.05, gain: 0.14 * g, delay: 0.07, pan: pan }); }
  };
  /** Positional synth sound: distance attenuation + stereo pan. */
  P.sfx = function (name, pos, gain, power) {
    var A = this.E.audio;
    if (!A || !A.ready || A.muted) return;
    var fn = SND[name];
    if (!fn) return;
    var cam = this.E.camera.world, d = Math.hypot(pos[0] - cam[0], pos[1] - cam[1], pos[2] - cam[2]);
    if (d > 320) return;
    var g = (gain === undefined ? 0.6 : gain) * U.clamp01(1.15 - d / 320);
    if (g < 0.015) return;
    var f = this.E.player.forward, rl = [Math.cos(this.E.player.yaw), 0, -Math.sin(this.E.player.yaw)];
    var rx = (pos[0] - cam[0]) / Math.max(1e-3, d), rz = (pos[2] - cam[2]) / Math.max(1e-3, d);
    var pan = U.clamp((rx * rl[0] + rz * rl[2]) * 0.85, -0.9, 0.9);
    void f;
    this.sfxCount++;
    fn(A, g, pan, power);
    // distance delay for far explosions (sound travels)
    void d;
  };

  /* ==========================================================================
   * Decals — bullet holes, blood, scorch, chips. Drawn into the G-buffer after
   * opaque geometry (depth-tested, no depth write) by the renderer hook.
   * ======================================================================== */
  function Decals(engine) {
    this.E = engine;
    var G = engine.renderer.G;
    this.G = G; this.gl = G.gl;
    this.prog = G.program('decals', TERRA.shaders.decalVS, TERRA.shaders.decalFS);
    this.cap = 320;
    this.data = new Float32Array(this.cap * 12);
    this.n = 0;
    this.buf = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buf);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, this.data.byteLength, this.gl.DYNAMIC_DRAW);
    this.vao = this.gl.createVertexArray();
    this.gl.bindVertexArray(this.vao);
    for (var i = 0; i < 3; i++) {
      this.gl.enableVertexAttribArray(i);
      this.gl.vertexAttribPointer(i, 4, this.gl.FLOAT, false, 48, i * 16);
      this.gl.vertexAttribDivisor(i, 1);
    }
    this.gl.bindVertexArray(null);
    this.dirty = true;
    this.life = 240;      // decals fade out over four minutes
  }
  var DP = Decals.prototype;
  DP.configure = function (quality) { this.cap = [0, 140, 320, 520][U.clamp(quality | 0, 0, 3)]; };
  /** Add a decal: kind 0 bullet hole, 1 blood, 2 scorch, 3 glass, 4 chip, 5 metal dent, 6 splinter, 7 dirt. */
  DP.add = function (pos, normal, kind, size, alpha) {
    if (!this.cap) return;
    var i;
    if (this.n < this.cap) i = this.n++;
    else i = Math.floor(Math.random() * this.cap);
    var a = this.data, o = i * 12;
    a[o] = pos[0] - this.E.origin[0]; a[o + 1] = pos[1]; a[o + 2] = pos[2] - this.E.origin[1];
    a[o + 3] = size;
    a[o + 4] = normal[0]; a[o + 5] = normal[1]; a[o + 6] = normal[2];
    a[o + 7] = Math.random() * Math.PI * 2;
    a[o + 8] = kind; a[o + 9] = 0; a[o + 10] = Math.random() * 100; a[o + 11] = alpha === undefined ? 1 : alpha;
    this.dirty = true;
  };
  DP.clear = function () { this.n = 0; this.dirty = true; };
  /** Decals are stored in render space: after a floating-origin shift they must be re-based. */
  DP.shiftOrigin = function (dx, dz) {
    for (var i = 0; i < this.n; i++) { this.data[i * 12] -= dx; this.data[i * 12 + 2] -= dz; }
    this.dirty = true;
  };
  DP.update = function (dt) {
    this._t = (this._t || 0) + dt;
    if (this._acc === undefined) this._acc = 0;
    this._acc += dt;
    if (this._acc < 0.25) return;
    this._acc = 0;
    var a = this.data;
    for (var i = 0; i < this.n; i++) {
      var age = a[i * 12 + 9] + 0.25 / this.life;
      a[i * 12 + 9] = Math.min(1, age);
      if (age >= 1) {   // recycle: move the last decal here
        this.n--;
        if (i !== this.n) a.copyWithin(i * 12, this.n * 12, this.n * 12 + 12);
        i--; continue;
      }
      if (age > 0.7) a[i * 12 + 11] *= 0.995;
    }
    this.dirty = true;
  };
  DP.draw = function (frame, withDepth) {
    if (!this.n) return;
    var gl = this.gl, R = this.E.renderer;
    if (this.dirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data.subarray(0, this.n * 12));
      this.dirty = false;
    }
    var p = this.prog.use();
    if (withDepth) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(R.G.caps.reversedZ ? gl.GEQUAL : gl.LEQUAL); gl.depthMask(false); }
    else gl.disable(gl.DEPTH_TEST);
    p.f('uNight', 1 - frame.env.dayFactor);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, this.n);
    gl.bindVertexArray(null);
    gl.depthMask(true);
    R.G.stats.drawCalls++; R.G.stats.triangles += this.n * 2;
  };

  /* ==========================================================================
   * Tracers, muzzle flashes, impact flashes, shockwave rings (additive, drawn
   * after TAA so they stay crisp and bloom nicely)
   * ======================================================================== */
  function Tracers(engine) {
    this.E = engine;
    var G = engine.renderer.G;
    this.G = G; this.gl = G.gl;
    this.prog = G.program('tracers', TERRA.shaders.tracerVS, TERRA.shaders.tracerFS);
    this.cap = 512;
    this.data = new Float32Array(this.cap * 16);   // 16 floats per instance
    this.n = 0;
    this.buf = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buf);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, this.data.byteLength, this.gl.DYNAMIC_DRAW);
    this.vao = this.gl.createVertexArray();
    this.gl.bindVertexArray(this.vao);
    for (var i = 0; i < 4; i++) {
      this.gl.enableVertexAttribArray(i);
      this.gl.vertexAttribPointer(i, 4, this.gl.FLOAT, false, 64, i * 16);
      this.gl.vertexAttribDivisor(i, 1);
    }
    this.gl.bindVertexArray(null);
    this.dirty = true;
  }
  var TP = Tracers.prototype;
  TP._slot = function () {
    if (this.n < this.cap) return this.n++;
    return Math.floor(Math.random() * this.cap);
  };
  /** Bright tracer streak from a to b. */
  TP.streak = function (a, b, col, life, width) {
    var i = this._slot(), o = i * 16, d = this.data;
    d[o] = a[0] - this.E.origin[0]; d[o + 1] = a[1]; d[o + 2] = a[2] - this.E.origin[1]; d[o + 3] = 1;
    d[o + 4] = b[0] - this.E.origin[0]; d[o + 5] = b[1]; d[o + 6] = b[2] - this.E.origin[1]; d[o + 7] = width || 0.02;
    d[o + 8] = col[0]; d[o + 9] = col[1]; d[o + 10] = col[2]; d[o + 11] = 1;
    d[o + 12] = 0; d[o + 13] = 0; d[o + 14] = Math.random() * 10; d[o + 15] = life;
    this.dirty = true;
  };
  /** Muzzle / impact flash billboard (kind 2). */
  TP.flash = function (pos, size, col, life) {
    var i = this._slot(), o = i * 16, d = this.data;
    d[o] = pos[0] - this.E.origin[0]; d[o + 1] = pos[1]; d[o + 2] = pos[2] - this.E.origin[1]; d[o + 3] = 0;
    d[o + 4] = d[o]; d[o + 5] = d[o + 1]; d[o + 6] = d[o + 2]; d[o + 7] = size;
    d[o + 8] = col[0]; d[o + 9] = col[1]; d[o + 10] = col[2]; d[o + 11] = 1;
    d[o + 12] = 2; d[o + 13] = 0; d[o + 14] = Math.random() * 10; d[o + 15] = life || 0.06;
    this.dirty = true;
  };
  /** Small impact spark flash (kind 1). */
  TP.impact = function (pos, size, col) {
    var i = this._slot(), o = i * 16, d = this.data;
    d[o] = pos[0] - this.E.origin[0]; d[o + 1] = pos[1]; d[o + 2] = pos[2] - this.E.origin[1]; d[o + 3] = 0;
    d[o + 4] = d[o]; d[o + 5] = d[o + 1]; d[o + 6] = d[o + 2]; d[o + 7] = size;
    d[o + 8] = col[0]; d[o + 9] = col[1]; d[o + 10] = col[2]; d[o + 11] = 1;
    d[o + 12] = 1; d[o + 13] = 0; d[o + 14] = Math.random() * 10; d[o + 15] = 0.08;
    this.dirty = true;
  };
  /** Expanding shockwave ring (kind 3). */
  TP.ring = function (pos, radius, col, life) {
    var i = this._slot(), o = i * 16, d = this.data;
    d[o] = pos[0] - this.E.origin[0]; d[o + 1] = pos[1] + 0.35; d[o + 2] = pos[2] - this.E.origin[1]; d[o + 3] = 0;
    d[o + 4] = d[o]; d[o + 5] = d[o + 1]; d[o + 6] = d[o + 2]; d[o + 7] = radius;
    d[o + 8] = col[0]; d[o + 9] = col[1]; d[o + 10] = col[2]; d[o + 11] = 1;
    d[o + 12] = 3; d[o + 13] = 0; d[o + 14] = 0; d[o + 15] = life || 0.4;
    this.dirty = true;
  };
  TP.clear = function () { this.n = 0; this.dirty = true; };
  TP.update = function (dt) {
    var d = this.data;
    for (var i = 0; i < this.n; i++) {
      var o = i * 16, life = d[o + 15];
      var age = d[o + 13] + dt / Math.max(0.01, life);
      d[o + 13] = age;
      if (age >= 1) {
        this.n--;
        if (i !== this.n) d.copyWithin(o, this.n * 16, this.n * 16 + 16);
        i--; continue;
      }
      if (d[o + 12] === 3) d[o + 7] *= 1 + dt * 2.4;   // rings expand
      this.dirty = true;
    }
  };
  TP.draw = function (frame) {
    if (!this.n) return;
    var gl = this.gl, R = this.E.renderer;
    if (this.dirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data.subarray(0, this.n * 16));
      this.dirty = false;
    }
    var p = this.prog.use();
    p.tex('uDepth', 0, R.targets.depth);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, this.n);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    R.G.stats.drawCalls++; R.G.stats.triangles += this.n * 2;
  };

  P.update = function (dt) {
    this.time += dt;
    this.decals.update(dt);
    this.tracers.update(dt);
  };
  P.clear = function () {
    this.decals.clear();
    this.tracers.clear();
  };

  TERRA.game.Combat = Combat;
})();
