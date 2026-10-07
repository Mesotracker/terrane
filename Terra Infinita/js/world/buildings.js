/* =============================================================================
 * TERRA INFINITA — buildings, settlements and structural destruction
 * -----------------------------------------------------------------------------
 * Deterministic architecture on the infinite terrain: houses, shop blocks,
 * warehouses, watchtowers, bunkers, checkpoints, container yards, ruins, roads,
 * walls, street furniture — every piece generated from boxes, sloped slabs and
 * wall openings (real reveals, frames, sills, glass, shutters, gutters, stairs,
 * furniture) with material ids shared with the shaders.
 *
 *  - one settlement every few kilometres, chosen where the terrain and climate
 *    suit a settlement (flat-ish ground, no water, mild temperature)
 *  - every part is a solid OBB: bullets stop (or punch through thin material),
 *    the player and AI collide with walls and walk up stairs and across floors
 *  - damage model: bullets chip, explosions break walls out, floors lose
 *    support and collapse, buildings burn down to rubble
 *  - cover points are extracted while building so the AI knows where to fight
 *  - one merged draw call per settlement (+ a reduced LOD beyond ~450 m), with
 *    emissive windows and street lamps at night
 * ========================================================================== */
(function () {
  'use strict';
  var U = TERRA.util, M = TERRA.math, CM = null;
  var CELL = 2600;            // settlement grid (m)
  var VIEW = 1500;            // stream/building radius (m)
  var LOD_FAR = 520;          // beyond this, the reduced mesh is used

  function cm() { return CM || (CM = TERRA.game.Combat); }
  /** Live combat instance (bullet decals, sounds). Falls back to null before init. */
  function cc() { var C = TERRA.game.Combat; return (C && C.inst) || null; }
  function CGeo() { return new (cm().CGeo)(); }
  function MAT(name) { return cm().CMAT[name]; }

  /* ---------------- deterministic random ---------------- */
  function hash32(s) {
    var h = 2166136261 >>> 0;
    s = String(s);
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rngFrom(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function Buildings(engine) {
    this.E = engine;
    var G = engine.renderer.G, S = TERRA.shaders;
    this.G = G; this.gl = G.gl;
    this.prog = G.program('cmbObj', S.cmbVS, S.cmbFS);
    this.progShadow = G.program('cmbObjShadow', S.cmbVS, S.cmbFS, { SHADOW: 1 });
    this.progMotion = G.program('cmbObjMotion', S.cmbVS, S.cmbMotionFS, { MOTION: 1 });
    this.settlements = new Map();
    this.list = [];                    // settlements being streamed
    this.grid = new Map();             // local cell "i:j" -> colliders
    this.colliders = [];
    this.lights = [];                  // night lights (render space)
    this.stats = { parts: 0, tris: 0, settlements: 0, destroyed: 0 };
    this._tmp = { c: [0, 0, 0], h: [0, 0, 0], yaw: 0 };
    this._buildTimer = 0;
    this._cellSeen = {};
  }
  var P = Buildings.prototype;

  P.configure = function (g) {
    this.quality = U.clamp(g.combatDetail === undefined ? 2 : g.combatDetail, 0, 3);
    this.maxParts = [0, 260, 700, 1500][this.quality];
    this.detail = this.quality;
  };

  P.clear = function () {
    // settlements are deterministic; only their damage state is forgotten here
    this.settlements.forEach(function (s) {
      if (!s) return;                                    // empty cells are cached as null
      if (s.mesh) { this.gl.deleteVertexArray(s.mesh.vao); }
      if (s.lodMesh) { this.gl.deleteVertexArray(s.lodMesh.vao); }
      s.mesh = null; s.lodMesh = null;
    }, this);
    this.settlements.clear(); this.list.length = 0; this.colliders.length = 0; this.grid.clear();
    this.lights.length = 0;
  };
  P.reset = P.clear;
  P.forget = function () { this.settlements.clear(); this.list.length = 0; this.colliders.length = 0; this.grid.clear(); };

  /* ==========================================================================
   * Geometry helpers (settlement-local space: +x east, +z south, y up)
   * ======================================================================== */
  /** Closed box in "wall space": u along the wall direction, d across it. */
  function WB(geo, o) {
    this.geo = geo;
    this.ox = o.x; this.oz = o.z;                       // wall start (local)
    var dx = o.dx === undefined ? 1 : o.dx, dz = o.dz === undefined ? 0 : o.dz;
    var l = Math.hypot(dx, dz) || 1;
    this.ux = dx / l; this.uz = dz / l;                 // along
    this.nx = this.uz; this.nz = -this.ux;              // across (right-hand)
    this.mat = o.mat; this.col = o.col || [235, 233, 228]; this.matZ = o.matZ; this.matY = o.matY;
    this.uv = o.uvScale || 1; this.wear = o.wear || 0; this.ao = o.ao === undefined ? 255 : o.ao;
  }
  WB.prototype.p = function (u, y, d) { return [this.ox + this.ux * u + this.nx * d, y, this.oz + this.uz * u + this.nz * d]; };
  WB.prototype.n = function (du, dy, dd) { return [this.ux * du + this.nx * dd, dy, this.uz * du + this.nz * dd]; };
  /** Box spanning u0..u1, y0..y1, d0..d1 (all in wall space). */
  WB.prototype.box = function (u0, y0, d0, u1, y1, d1, opts) {
    var g = this.geo, mat = this.mat, matY = this.matY === undefined ? mat : this.matY, matZ = this.matZ === undefined ? mat : this.matZ;
    var col = { col: (opts && opts.col) || this.col, edge: (opts && opts.edge !== undefined) ? opts.edge : 200, wear: (opts && opts.wear !== undefined) ? opts.wear : this.wear, ao: (opts && opts.ao !== undefined) ? opts.ao : this.ao };
    var us = (opts && opts.uvScale) || this.uv;
    var w = (u1 - u0) * us, h = (y1 - y0) * us;
    // +d and -d faces
    g.face(this.p(u0, y0, d1), this.p(u1, y0, d1), this.p(u1, y1, d1), this.p(u0, y1, d1), { mat: matZ, col: col.col, edge: col.edge, wear: col.wear, ao: col.ao, uvScale: us });
    g.face(this.p(u1, y0, d0), this.p(u0, y0, d0), this.p(u0, y1, d0), this.p(u1, y1, d0), { mat: matZ, col: col.col, edge: col.edge, wear: col.wear, ao: col.ao, uvScale: us });
    // +u / -u faces
    g.face(this.p(u1, y0, d1), this.p(u1, y0, d0), this.p(u1, y1, d0), this.p(u1, y1, d1), { mat: mat, col: col.col, edge: col.edge, wear: col.wear, ao: col.ao, uvScale: us });
    g.face(this.p(u0, y0, d0), this.p(u0, y0, d1), this.p(u0, y1, d1), this.p(u0, y1, d0), { mat: mat, col: col.col, edge: col.edge, wear: col.wear, ao: col.ao, uvScale: us });
    // +y / -y
    g.face(this.p(u0, y1, d1), this.p(u1, y1, d1), this.p(u1, y1, d0), this.p(u0, y1, d0), { mat: matY, col: col.col, edge: col.edge, wear: col.wear, ao: col.ao, uvScale: us });
    g.face(this.p(u0, y0, d0), this.p(u1, y0, d0), this.p(u1, y0, d1), this.p(u0, y0, d1), { mat: mat, col: col.col, edge: col.edge, wear: col.wear, ao: col.ao, uvScale: us });
    void w; void h;
    return this;
  };
  /** A thin sloped slab from a quad (roofs, awnings, ramps, stair treads). */
  function slab(geo, p0, p1, p2, p3, opts) {
    opts = opts || {};
    var ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    var vx = p3[0] - p0[0], vy = p3[1] - p0[1], vz = p3[2] - p0[2];
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    var l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    var t = opts.thickness === undefined ? 0.14 : opts.thickness;
    var us = opts.uvScale || 1;
    var col = opts.col || [220, 220, 215];
    var mat = opts.mat === undefined ? 0 : opts.mat;
    var a = [], b = [], c = [], d = [], e = [], f = [], gg = [], h2 = [];
    var pts = [p0, p1, p2, p3], up = [], dn = [];
    for (var i = 0; i < 4; i++) {
      up.push([pts[i][0] + nx * t * 0.5, pts[i][1] + ny * t * 0.5, pts[i][2] + nz * t * 0.5]);
      dn.push([pts[i][0] - nx * t * 0.5, pts[i][1] - ny * t * 0.5, pts[i][2] - nz * t * 0.5]);
    }
    a = up; b = dn;
    geo.face(a[0], a[1], a[2], a[3], { mat: mat, col: col, uvScale: us, edge: opts.edge === undefined ? 40 : opts.edge });
    geo.face(b[3], b[2], b[1], b[0], { mat: mat, col: col, uvScale: us, edge: opts.edge === undefined ? 40 : opts.edge });
    for (i = 0; i < 4; i++) {
      var j = (i + 1) % 4;
      geo.face(b[i], b[j], a[j], a[i], { mat: opts.matEdge === undefined ? mat : opts.matEdge, col: col, uvScale: us, edge: 180 });
    }
    void c; void d; void e; void f; void gg; void h2;
    return geo;
  }
  /** Glazed opening inside a wall: reveals, frame, mullions, glass, sill. */
  function window1(w, u0, u1, y0, y1, opts) {
    opts = opts || {};
    var d = opts.d === 0.06;                     // half wall thickness used for the reveal
    var frameMat = opts.frameMat === undefined ? 4 : opts.frameMat;   // timber frame
    var g = w.geo;
    var fw = 0.07;
    // reveal surfaces (top/bottom/sides of the opening, facing inward)
    w.box(u0, y0, -d, u1, y0 - 0.001, d, { mat: w.mat, edge: 220 });
    w.box(u0, y1, -d, u1, y1 + 0.001, d, { mat: w.mat, edge: 220 });
    w.box(u0 - 0.004, y0, -d, u0, y1, d, { mat: w.mat, edge: 220 });
    w.box(u1, y0, -d, u1 + 0.004, y1, d, { mat: w.mat, edge: 220 });
    if (!opts.noFrame) {
      w.box(u0, y0, -d - 0.03, u1, y0 + fw, d + 0.03, { mat: frameMat, edge: 150 });
      w.box(u0, y1 - fw, -d - 0.03, u1, y1, d + 0.03, { mat: frameMat, edge: 150 });
      w.box(u0, y0, -d - 0.03, u0 + fw, y1, d + 0.03, { mat: frameMat, edge: 150 });
      w.box(u1 - fw, y0, -d - 0.03, u1, y1, d + 0.03, { mat: frameMat, edge: 150 });
      // mullions every ~0.55 m
      var span = u1 - u0 - fw * 2, nm = Math.max(0, Math.round(span / 0.62) - 1);
      for (var m = 1; m <= nm; m++) {
        var mu = u0 + fw + span * m / (nm + 1);
        w.box(mu - 0.028, y0 + fw, -d - 0.012, mu + 0.028, y1 - fw, d + 0.012, { mat: frameMat, edge: 180 });
      }
      // sill
      w.box(u0 - 0.06, y0 - 0.05, -d - 0.09, u1 + 0.06, y0, d + 0.09, { mat: opts.sillMat === undefined ? MAT('STONE') : opts.sillMat, edge: 200 });
    }
    if (!opts.noGlass) {
      var gl = w.geo;
      var gp0 = w.p(u0 + fw, y0 + fw, 0), gp1 = w.p(u1 - fw, y0 + fw, 0), gp2 = w.p(u1 - fw, y1 - fw, 0), gp3 = w.p(u0 + fw, y1 - fw, 0);
      gl.face(gp0, gp1, gp2, gp3, { mat: MAT('GLASS'), col: [200, 210, 220], edge: 0, uvScale: 0.05 });
      if (!opts.noCurtain) {
        // a curtain / blind behind the glass (some windows only)
        if (opts.curtain) gl.face(gp0, gp1, gp2, gp3, { mat: MAT('CANVAS'), col: opts.curtain, edge: 0, uvScale: 0.5 });
      }
    }
    if (opts.shutters) {
      var sh = 0.5 + Math.random() * 0.2;
      w.box(u0 - 0.02, y0, d + 0.02, u0 + (u1 - u0) * sh * 0.5, y1, d + 0.06, { mat: frameMat, edge: 160 });
      w.box(u1 - (u1 - u0) * sh * 0.5, y0, d + 0.02, u1 + 0.02, y1, d + 0.06, { mat: frameMat, edge: 160 });
    }
    void g;
  }
  /** A door opening: reveals, frame, leaf (closed or ajar), step. */
  function door1(w, u0, u1, y0, y1, opts) {
    opts = opts || {};
    var d = opts.d === undefined ? 0.06 : opts.d;
    var mat = opts.mat === undefined ? 4 : opts.mat;
    w.box(u0 - 0.005, y0, -d, u0, y1, d, { mat: w.mat, edge: 220 });
    w.box(u1, y0, -d, u1 + 0.005, y1, d, { mat: w.mat, edge: 220 });
    w.box(u0, y1, -d, u1, y1 + 0.005, d, { mat: w.mat, edge: 220 });
    w.box(u0, y0, -d - 0.04, u1, y0 + 0.08, d + 0.04, { mat: mat, edge: 170 });          // threshold
    w.box(u0, y0 + 0.02, -d - 0.035, u0 + 0.07, y1, d + 0.035, { mat: mat, edge: 170 });
    w.box(u1 - 0.07, y0 + 0.02, -d - 0.035, u1, y1, d + 0.035, { mat: mat, edge: 170 });
    w.box(u0, y1 - 0.08, -d - 0.035, u1, y1, d + 0.035, { mat: mat, edge: 170 });
    if (opts.leaf !== false) {
      var ajar = opts.ajar || 0;
      var wu = u1 - u0 - 0.14, hh = y1 - y0 - 0.1;
      // door leaf rotated about the hinge column
      var hx = u0 + 0.07, hy = y0 + 0.05;
      var lx = Math.cos(ajar) * wu, ld = Math.sin(ajar) * wu;
      w.box(hx, hy, -0.02, hx + lx, hy + hh, -0.02 + ld, { mat: mat, edge: 190 });
      if (opts.panel) {
        w.box(hx + 0.05, hy + hh * 0.12, 0.02, hx + lx - 0.05, hy + hh * 0.42, 0.03, { mat: mat, edge: 210 });
        w.box(hx + 0.05, hy + hh * 0.55, 0.02, hx + lx - 0.05, hy + hh * 0.85, 0.03, { mat: mat, edge: 210 });
      }
    }
  }
  /** Wall with real openings: piers, headers below/above every opening. */
  function wall(wx, wz, dx, dz, u0, u1, y0, y1, th, opts) {
    opts = opts || {};
    var geo = opts.geo;
    var w = new WB(geo, { x: wx, z: wz, dx: dx, dz: dz, mat: opts.mat, col: opts.col, uvScale: opts.uvScale, wear: opts.wear, matY: opts.matY, matZ: opts.matZ, ao: opts.ao });
    var half = th * 0.5;
    if (opts.ao !== undefined) w.ao = opts.ao;
    var openings = (opts.openings || []).slice().sort(function (a, b) { return a.u0 - b.u0; });
    var gaps = [];                       // [u0, y0, u1, y1] of every walk-through opening
    var cursor = u0;
    for (var i = 0; i < openings.length; i++) {
      var op = openings[i];
      if (op.door || op.arch) gaps.push(op.u0, op.y0 === undefined ? y0 : op.y0, op.u1, op.y1 === undefined ? y1 : op.y1);
      if (op.u0 > cursor) w.box(cursor, y0, -half, op.u0, y1, half);
      // below and above the opening
      if (op.y0 !== undefined && op.y0 > y0) w.box(op.u0, y0, -half, op.u1, op.y0, half);
      if (op.y1 !== undefined && op.y1 < y1) w.box(op.u0, op.y1, -half, op.u1, y1, half);
      if (op.window) window1(w, op.u0, op.u1, op.y0, op.y1, { d: half, shutters: op.shutters, curtain: op.curtain, noFrame: op.noFrame, sillMat: opts.sillMat, frameMat: opts.frameMat });
      else if (op.door) door1(w, op.u0, op.u1, op.y0, op.y1, { d: half, leaf: op.leaf, ajar: op.ajar || 0, panel: opts.panelDoors, mat: opts.frameMat });
      else if (op.arch) {
        // crude arch: stacked boxes forming the curve
        var n = 7, R = (op.u1 - op.u0) * 0.5, cu = (op.u0 + op.u1) * 0.5, base = op.y0 + R * 0.15;
        for (var k = 0; k < n; k++) {
          var a0 = Math.PI * k / n, a1 = Math.PI * (k + 1) / n;
          var mu0 = cu - Math.cos(a0) * R, mu1 = cu - Math.cos(a1) * R;
          var my = base + Math.sin(a0) * R * 0.55;
          w.box(Math.min(mu0, mu1), op.y1 - my * 0.5, -half, Math.max(mu0, mu1), y1, half);
          void my;
        }
      }
      cursor = op.u1;
    }
    if (cursor < u1) w.box(cursor, y0, -half, u1, y1, half);
    // The part's OBB is centred on the wall's mid-point, so express every opening
    // relative to it: movement code can then test a body against the part it has and
    // let it through the doorways (walls are authored in their own nested space).
    var uMid = (u0 + u1) * 0.5;
    for (var gm = 0; gm < gaps.length; gm += 4) { gaps[gm] -= uMid; gaps[gm + 2] -= uMid; }
    return { w: w, geo: geo, gaps: gaps,
      ref: { ux: w.ux, uz: w.uz, nx: w.nx, nz: w.nz, half: half } };
  }

  /* ==========================================================================
   * Prefabs
   * ======================================================================== */
  var PALETTE = [
    { key: 'brick', mat: 0, col: [214, 208, 200], roof: 6, roofCol: [176, 122, 96], trim: [236, 234, 226] },
    { key: 'plaster', mat: 1, col: [232, 228, 216], roof: 6, roofCol: [168, 132, 108], trim: [240, 238, 230] },
    { key: 'stone', mat: 3, col: [212, 210, 200], roof: 6, roofCol: [150, 140, 132], trim: [228, 226, 218] },
    { key: 'timber', mat: 4, col: [206, 178, 138], roof: 6, roofCol: [150, 120, 96], trim: [232, 214, 184] },
    { key: 'concrete', mat: 2, col: [206, 204, 200], roof: 2, roofCol: [200, 200, 196], trim: [218, 216, 210] },
    { key: 'painted', mat: 9, col: [196, 190, 172], roof: 7, roofCol: [148, 148, 152], trim: [226, 224, 214] }
  ];

  /**
   * A house: plinth, walls with windows and a door, floors, staircase, gable or
   * flat roof with parapet, chimney, gutters and downpipes, wall lamp, steps.
   */
  function buildHouse(ctx, o) {
    var parts = ctx.parts, rng = ctx.rng, pal = o.pal || PALETTE[Math.floor(rng() * 3)];
    var w = o.w, d = o.d, floors = o.floors || 1, fh = 2.85;
    var y0 = 0;
    var wallTh = 0.32;
    var padH = o.padH || 0;
    var base = -3.2;
    // plinth + foundation skirt (sinks into the ground so slopes never show a gap)
    var g0 = CGeo();
    var wb = new WB(g0, { x: 0, z: 0, mat: MAT('CONCRETE'), col: [196, 194, 188] });
    wb.box(-w / 2 - 0.14, base, -d / 2 - 0.14, w / 2 + 0.14, 0.18, d / 2 + 0.14, { edge: 190 });
    parts.push({ kind: 'wall', hp: 520, maxHp: 520, geo: g0, surface: 'concrete',
      obb: { c: [0, (base + 0.18) / 2, 0], h: [w / 2 + 0.14, (0.18 - base) / 2, d / 2 + 0.14], yaw: 0 }, solid: true, cover: true });
    // floor slabs + ceilings
    for (var f = 0; f <= floors; f++) {
      var g = CGeo();
      var wf = new WB(g, { x: 0, z: 0, mat: MAT('PLANK'), col: [206, 178, 138], uvScale: 1.2, matY: MAT('PLANK') });
      var yf = f * fh - (f === 0 ? 0.16 : 0.26);
      if (f > 0 && f < floors) {
        wf.box(-w / 2, yf - 0.24, -d / 2, w / 2, yf, d / 2, { matZ: MAT('PLASTER') });   // ceiling underside
      }
      wf.box(-w / 2 - 0.05, yf - (f === 0 ? 0.45 : 0.26), -d / 2 - 0.05, w / 2 + 0.05, yf, d / 2 + 0.05, {});
      parts.push({ kind: 'floor', hp: 420, maxHp: 420, geo: g, surface: 'plank', walk: true,
        obb: { c: [0, yf - 0.13, 0], h: [w / 2 + 0.05, 0.13, d / 2 + 0.05], yaw: 0 }, solid: true, cover: true, level: f });
    }
    // exterior walls with openings
    var winsPerFloor = Math.max(2, Math.round(w / 2.6));
    var skip = Math.floor(rng() * 4);
    for (var side = 0; side < 4; side++) {
      var along = (side % 2 === 0) ? w : d, sideLen = along;
      var sx, sz, dx, dz;
      if (side === 0) { sx = -w / 2; sz = d / 2; dx = 1; dz = 0; }
      else if (side === 1) { sx = w / 2; sz = -d / 2; dx = 1; dz = 0; }
      else if (side === 2) { sx = -w / 2; sz = -d / 2; dx = 0; dz = 1; }
      else { sx = w / 2; sz = d / 2; dx = 0; dz = -1; }
      for (var fl = 0; fl < floors; fl++) {
        var fy = fl * fh;
        var openings = [], cursor = 0.35;
        if (fl === 0 && side !== skip) {
          // door on this side
          var dw = 1.05;
          openings.push({ u0: sideLen * 0.5 - dw * 0.5, u1: sideLen * 0.5 + dw * 0.5, y0: fy + 0.14, y1: fy + 2.12, door: true, leaf: rng() < 0.5, ajar: rng() < 0.4 ? 0.4 + rng() * 0.7 : 0, panel: true });
        }
        for (var i = 0; i < winsPerFloor; i++) {
          var uw = 0.9 + rng() * 0.3, gap = sideLen / (winsPerFloor + 1);
          var u0 = gap * (i + 1) - uw * 0.5 + (rng() - 0.5) * 0.2;
          u0 = U.clamp(u0, 0.35, sideLen - uw - 0.35);
          if (openings.some(function (op) { return u0 < op.u1 + 0.4 && u0 + uw > op.u0 - 0.4; })) continue;
          openings.push({ u0: u0, u1: u0 + uw, y0: fy + 0.95, y1: fy + 2.15, window: true,
            shutters: rng() < 0.35, curtain: rng() < 0.25 ? [180 + rng() * 60, 160 + rng() * 50, 140 + rng() * 40] : null });
        }
        var gg = CGeo();
        var res = wall(sx, sz, dx, dz, 0, sideLen, fy, fy + fh, wallTh, { geo: gg, mat: pal.mat, col: pal.col, openings: openings, uvScale: 1, frameMat: 4, trimCol: pal.trim });
        parts.push({ kind: 'wall', hp: 260 * (pal.key === 'stone' ? 1.5 : 1), maxHp: 260, geo: res.geo, surface: pal.key === 'timber' ? 'plank' : (pal.key === 'plaster' ? 'plaster' : (pal.key === 'stone' ? 'stone' : 'brick')),
          obb: { c: [sx + dx * sideLen * 0.5, fy + fh * 0.5, sz + dz * sideLen * 0.5], h: [Math.max(0.06, Math.abs(dx) * sideLen * 0.5 + wallTh * Math.abs(dz) * 0.5), fh * 0.5, Math.max(0.06, Math.abs(dz) * sideLen * 0.5 + wallTh * Math.abs(dx) * 0.5)], yaw: 0 },
          gaps: res.gaps, wallRef: res.ref,
          solid: true, floor: fl, cover: true, interior: true });
      }
    }
    // interior walls (a couple of rooms per floor)
    for (fl = 0; fl < floors; fl++) {
      var nInner = floors > 1 ? 1 : (rng() < 0.5 ? 1 : 0);
      for (var k = 0; k < nInner; k++) {
        var along2 = rng() < 0.5;
        var len2 = along2 ? w : d;
        var off = (rng() - 0.5) * 0.4 * (along2 ? d : w);
        var iw = CGeo();
        var openings2 = [{ u0: len2 * 0.5 - 0.55, u1: len2 * 0.5 + 0.55, y0: fl * fh + 0.14, y1: fl * fh + 2.05, arch: false }];
        var res2 = wall(along2 ? -w / 2 : off, along2 ? off : -d / 2, along2 ? 1 : 0, along2 ? 0 : 1, 0, len2, fl * fh, fl * fh + fh, 0.16,
          { geo: iw, mat: MAT('PLASTER'), col: [232, 228, 220], openings: openings2, uvScale: 1 });
        parts.push({ kind: 'wall', hp: 120, maxHp: 120, geo: res2.geo, surface: 'plaster',
          obb: { c: [along2 ? 0 : off, fl * fh + fh * 0.5, along2 ? off : 0], h: [along2 ? len2 * 0.5 : 0.08, fh * 0.5, along2 ? 0.08 : len2 * 0.5], yaw: 0 },
          gaps: res2.gaps, wallRef: res2.ref,
          solid: true, interior: true, floor: fl, cover: true });
      }
      // staircase to the next floor
      if (fl < floors - 1) {
        var st = CGeo();
        var steps = 14, rise = fh / steps, run = 0.26;
        var sx0 = -w * 0.5 + 0.7, sz0 = -d * 0.5 + 0.7;
        var dirX = rng() < 0.5 ? 1 : 0;
        var tbl = [];
        for (var s = 0; s < steps; s++) {
          var yy = fl * fh + 0.14 + rise * (s + 1);
          if (dirX) stBox(st, sx0 + s * run, fl * fh + 0.14 + rise * s, sz0, sx0 + (s + 1) * run, yy, sz0 + 1.1, MAT('PLANK'));
          else stBox(st, sx0, fl * fh + 0.14 + rise * s, sz0 + s * run, sx0 + 1.1, yy, sz0 + (s + 1) * run, MAT('PLANK'));
          tbl.push(yy);
        }
        parts.push({ kind: 'stairs', hp: 200, maxHp: 200, geo: st, surface: 'plank', walk: true, stairs: true,
          obb: { c: [dirX ? sx0 + run * steps * 0.5 : sx0 + 0.55, fl * fh + fh * 0.5, dirX ? sz0 + 0.55 : sz0 + run * steps * 0.5], h: [dirX ? run * steps * 0.5 : 0.55, fh * 0.5, dirX ? 0.55 : run * steps * 0.5], yaw: 0 },
          solid: true, cover: true });
      }
    }
    // roof
    var roof = CGeo();
    if (o.flat) {
      var wb2 = new WB(roof, { x: 0, z: 0, mat: MAT('CONCRETE'), col: [198, 196, 190] });
      wb2.box(-w / 2 - 0.1, floors * fh, -d / 2 - 0.1, w / 2 + 0.1, floors * fh + 0.22, d / 2 + 0.1, {});
      // parapet
      wb2.box(-w / 2 - 0.1, floors * fh + 0.22, d / 2 - 0.03, w / 2 + 0.1, floors * fh + 0.72, d / 2 + 0.14, {});
      wb2.box(-w / 2 - 0.1, floors * fh + 0.22, -d / 2 - 0.14, w / 2 + 0.1, floors * fh + 0.72, -d / 2 + 0.03, {});
      wb2.box(w / 2 - 0.03, floors * fh + 0.22, -d / 2 - 0.14, w / 2 + 0.14, floors * fh + 0.72, d / 2 + 0.14, {});
      wb2.box(-w / 2 - 0.14, floors * fh + 0.22, -d / 2 - 0.14, -w / 2 + 0.03, floors * fh + 0.72, d / 2 + 0.14, {});
      // roof access hut + vents
      wb2.box(w * 0.18, floors * fh + 0.2, -d * 0.16, w * 0.42, floors * fh + 2.2, d * 0.1, { mat: MAT('CONCRETE') });
      parts.push({ kind: 'roof', hp: 420, maxHp: 420, geo: roof, surface: 'concrete', walk: true,
        obb: { c: [0, floors * fh + 0.11, 0], h: [w / 2 + 0.1, 0.11, d / 2 + 0.1], yaw: 0 }, solid: true, cover: true, top: true });
    } else {
      var rh = o.roofH || (2.1 + rng() * 0.8);
      var ov = 0.4;
      var ru = w / 2 + ov, rd = d / 2 + ov;
      var yb = floors * fh;
      var spine = rng() < 0.5;
      var rmat = pal.roof, rcol = pal.roofCol;
      function slopeQuad(a, b, c, dd) { slab(roof, a, b, c, dd, { mat: rmat, col: rcol, thickness: 0.16, uvScale: 1.6, matEdge: 4 }); }
      if (spine) {
        slopeQuad([-ru, yb, -rd], [ru, yb, -rd], [ru, yb + rh, 0], [-ru, yb + rh, 0]);
        slopeQuad([ru, yb, rd], [-ru, yb, rd], [-ru, yb + rh, 0], [ru, yb + rh, 0]);
        // gable ends
        var wb3 = new WB(roof, { x: 0, z: 0, mat: pal.mat, col: pal.col });
        wb3.box(-ru, yb, -rd, -w / 2, yb + rh * 0.5, rd, {});
        wb3.box(w / 2, yb, -rd, ru, yb + rh * 0.5, rd, {});
        // ridge cap
        wb3.box(-ru, yb + rh - 0.06, -0.12, ru, yb + rh + 0.08, 0.12, { mat: rmat, col: rcol });
      } else {
        slopeQuad([-ru, yb, -rd], [ru, yb, -rd], [ru, yb + rh, rd * 0.0], [-ru, yb + rh * 0.2, rd * 0.0]);
        slopeQuad([ru, yb, rd], [-ru, yb, rd], [-ru, yb + rh * 0.2, 0], [ru, yb + rh, 0]);
      }
      parts.push({ kind: 'roof', hp: 300, maxHp: 300, geo: roof, surface: 'tile', walk: true, roof: true,
        obb: { c: [0, yb + rh * 0.5, 0], h: [ru, rh * 0.5, rd], yaw: 0 }, solid: true, cover: true, top: true });
      // chimney
      var chx = (rng() - 0.5) * w * 0.5, chz = (rng() - 0.5) * d * 0.4;
      var cg = CGeo();
      var wc = new WB(cg, { x: 0, z: 0, mat: MAT('BRICK'), col: [186, 174, 166] });
      wc.box(chx - 0.36, yb, chz - 0.36, chx + 0.36, yb + rh + 1.1, chz + 0.36, {});
      wc.box(chx - 0.46, yb + rh + 1.1, chz - 0.46, chx + 0.46, yb + rh + 1.36, chz + 0.46, {});
      parts.push({ kind: 'prop', hp: 200, maxHp: 200, geo: cg, surface: 'brick',
        obb: { c: [chx, yb + rh * 0.5, chz], h: [0.36, rh * 0.5, 0.36], yaw: 0 }, solid: true, cover: true });
    }
    // gutter pipes + wall lamp + entrance steps + doorway lamp (emissive at night)
    var det = CGeo();
    var wd = new WB(det, { x: 0, z: 0, mat: MAT('METAL'), col: [150, 150, 148], uvScale: 1 });
    var cx0 = -w / 2 + 0.16, cz0 = d / 2 - 0.02;
    wd.box(cx0 - 0.06, 0, cz0, cx0 + 0.06, floors * fh + 0.3, cz0 + 0.12, {});
    wd.box(cx0 - 0.06, -0.3, cz0 - 0.1, cx0 + 0.06, 0.2, cz0 + 0.14, {});
    var lp = CGeo();
    var wl = new WB(lp, { x: 0, z: 0, mat: MAT('EMISSIVE'), col: [255, 236, 200] });
    wl.box(w / 2 - 0.55, 2.3, d / 2 + 0.16, w / 2 - 0.34, 2.5, d / 2 + 0.34, { edge: 120 });
    parts.push({ kind: 'light', hp: 40, maxHp: 40, geo: lp, emissive: [w / 2 - 0.45, 2.4, d / 2 + 0.25], solid: false, light: true });
    parts.push({ kind: 'decor', hp: 90, maxHp: 90, geo: det, solid: false, noRay: true });
    void padH;
    return { w: w, d: d, floors: floors, fh: fh, pal: pal, roofY: floors * fh };
  }
  /** small helper: axis-aligned box into a geo (settlement-local) */
  function stBox(g, x0, y0, z0, x1, y1, z1, mat, col) {
    var w = new WB(g, { x: 0, z: 0, mat: mat, col: col || [210, 200, 186], uvScale: 1 });
    w.box(x0, y0, z0, x1, y1, z1, {});
  }
  /** Multi-storey town block with a shop front, awnings, balconies and a flat roof. */
  function buildBlock(ctx, o) {
    var parts = ctx.parts, rng = ctx.rng;
    var w = o.w, d = o.d, floors = o.floors || 3, fh = 3.1;
    var pal = PALETTE[Math.floor(rng() * 4)];
    var base = -3.4;
    var g0 = CGeo(), wb = new WB(g0, { x: 0, z: 0, mat: MAT('CONCRETE'), col: [194, 192, 186] });
    wb.box(-w / 2 - 0.2, base, -d / 2 - 0.2, w / 2 + 0.2, 0.2, d / 2 + 0.2, {});
    parts.push({ kind: 'wall', hp: 640, maxHp: 640, geo: g0, surface: 'concrete',
      obb: { c: [0, (base + 0.2) / 2, 0], h: [w / 2 + 0.2, (0.2 - base) / 2, d / 2 + 0.2], yaw: 0 }, solid: true });
    for (var side = 0; side < 4; side++) {
      var along = (side % 2 === 0) ? w : d;
      var sx, sz, dx, dz;
      if (side === 0) { sx = -w / 2; sz = d / 2; dx = 1; dz = 0; }
      else if (side === 1) { sx = w / 2; sz = -d / 2; dx = 1; dz = 0; }
      else if (side === 2) { sx = -w / 2; sz = -d / 2; dx = 0; dz = 1; }
      else { sx = w / 2; sz = d / 2; dx = 0; dz = -1; }
      for (var fl = 0; fl < floors; fl++) {
        var fy = fl * fh;
        var openings = [], n = Math.max(2, Math.round(along / 3.0));
        var gap = along / (n + 1);
        for (var i = 0; i < n; i++) {
          var uw = fl === 0 && side === 0 ? gap * 0.95 : Math.min(1.6, gap * 0.55);
          var u0 = gap * (i + 1) - uw * 0.5;
          openings.push({ u0: u0, u1: u0 + uw, y0: fy + (fl === 0 && side === 0 ? 0.5 : 1.0), y1: fy + (fl === 0 && side === 0 ? 2.5 : 2.35), window: true, shutters: fl > 0 && rng() < 0.3, curtain: rng() < 0.4 ? [170 + rng() * 70, 150 + rng() * 60, 130 + rng() * 60] : null, noFrame: fl === 0 && side === 0 });
        }
        if (fl === 0 && side !== 0) openings.push({ u0: along * 0.5 - 0.6, u1: along * 0.5 + 0.6, y0: 0.2, y1: 2.3, door: true, leaf: rng() < 0.6, ajar: rng() < 0.5 ? 0.5 + rng() * 0.8 : 0, panel: true });
        var gg = CGeo();
        var res = wall(sx, sz, dx, dz, 0, along, fy, fy + fh, 0.34, { geo: gg, mat: pal.mat, col: pal.col, openings: openings, uvScale: 1, frameMat: 4 });
        parts.push({ kind: 'wall', hp: 300, maxHp: 300, geo: res.geo, surface: pal.key === 'plaster' ? 'plaster' : 'brick',
          obb: { c: [sx + dx * along * 0.5, fy + fh * 0.5, sz + dz * along * 0.5], h: [Math.max(0.07, Math.abs(dx) * along * 0.5 + 0.17 * Math.abs(dz)), fh * 0.5, Math.max(0.07, Math.abs(dz) * along * 0.5 + 0.17 * Math.abs(dx))], yaw: 0 },
          gaps: res.gaps, wallRef: res.ref,
          solid: true, floor: fl, cover: true });
      }
    }
    // floors + ceiling slabs
    for (var f = 0; f <= floors; f++) {
      var yf = f * fh - 0.3;
      var gf = CGeo(), wf = new WB(gf, { x: 0, z: 0, mat: f === floors ? MAT('CONCRETE') : MAT('PLANK'), col: f === floors ? [198, 196, 190] : [196, 172, 140], uvScale: 1.2 });
      wf.box(-w / 2, yf, -d / 2, w / 2, yf + 0.3, d / 2, {});
      parts.push({ kind: 'floor', hp: 480, maxHp: 480, geo: gf, surface: 'plank', walk: true,
        obb: { c: [0, yf + 0.15, 0], h: [w / 2, 0.15, d / 2], yaw: 0 }, solid: true, cover: true, level: f, top: f === floors });
      if (f < floors) {                     // staircase shaft along one wall
        var st = CGeo();
        var steps = 16, rise = fh / steps, run = 0.28;
        var dirX = f % 2 === 0;
        var sx0 = -w / 2 + 0.8, sz0 = d / 2 - 1.8;
        for (var s = 0; s < steps; s++) {
          var yy = yf + 0.3 + rise * (s + 1);
          if (dirX) stBox(st, sx0 + s * run, yf + 0.3 + rise * s, sz0, sx0 + (s + 1) * run, yy, sz0 + 1.2, MAT('CONCRETE'), [200, 198, 192]);
          else stBox(st, sx0, yf + 0.3 + rise * s, sz0 - s * run, sx0 + 1.2, yy, sz0 - (s + 1) * run, MAT('CONCRETE'), [200, 198, 192]);
        }
        parts.push({ kind: 'stairs', hp: 260, maxHp: 260, geo: st, surface: 'concrete', walk: true, stairs: true,
          obb: { c: [dirX ? sx0 + run * steps * 0.5 : sx0 + 0.6, yf + fh * 0.5, dirX ? sz0 + 0.6 : sz0 - run * steps * 0.5], h: [dirX ? run * steps * 0.5 : 0.6, fh * 0.5, dirX ? 0.6 : run * steps * 0.5], yaw: 0 }, solid: true, cover: true });
      }
    }
    // shop front: glass + awning + sign, ground floor facing +z
    var shop = CGeo(), wsh = new WB(shop, { x: 0, z: 0, mat: 4, col: [180, 150, 118] });
    wsh.box(-w * 0.42, 2.5, d / 2 + 0.34, w * 0.42, 2.62, d / 2 + 1.5, { mat: MAT('CANVAS'), col: [180, 96, 70] });
    wsh.box(-w * 0.42, 2.62, d / 2 + 1.4, -w * 0.36, 2.5, d / 2 + 1.52, { edge: 200 });
    var sign = CGeo(), wsg = new WB(sign, { x: 0, z: 0, mat: MAT('EMISSIVE'), col: [230, 240, 255] });
    wsg.box(-w * 0.3, 2.75, d / 2 + 0.36, w * 0.3, 3.35, d / 2 + 0.46, { edge: 150 });
    parts.push({ kind: 'decor', hp: 120, maxHp: 120, geo: shop, solid: false, cover: false, noRay: false, surface: 'canvas' });
    parts.push({ kind: 'light', hp: 40, maxHp: 40, geo: sign, emissive: [0, 3.05, d / 2 + 0.45], solid: false, light: true });
    // balconies on the upper floors
    var nbal = Math.max(1, Math.round(w / 5));
    for (var b = 0; b < nbal; b++) {
      if (rng() < 0.35) continue;
      var bx = -w * 0.4 + (b + 0.5) * (w * 0.8 / nbal);
      var by = (1 + Math.floor(rng() * Math.max(1, floors - 1))) * fh;
      var bg = CGeo(), wb2 = new WB(bg, { x: 0, z: 0, mat: MAT('CONCRETE'), col: [198, 196, 190] });
      wb2.box(bx - 1.2, by - 0.22, d / 2, bx + 1.2, by, d / 2 + 1.3, {});
      wb2.box(bx - 1.2, by, d / 2 + 1.2, bx + 1.2, by + 1.0, d / 2 + 1.3, { mat: MAT('METAL'), col: [120, 120, 124] });
      wb2.box(bx - 1.2, by, d / 2, bx - 1.1, by + 1.0, d / 2 + 1.3, { mat: MAT('METAL'), col: [120, 120, 124] });
      wb2.box(bx + 1.1, by, d / 2, bx + 1.2, by + 1.0, d / 2 + 1.3, { mat: MAT('METAL'), col: [120, 120, 124] });
      parts.push({ kind: 'floor', hp: 200, maxHp: 200, geo: bg, surface: 'concrete', walk: true,
        obb: { c: [bx, by - 0.11, d / 2 + 0.65], h: [1.2, 0.11, 0.65], yaw: 0 }, solid: true, cover: true, top: true });
    }
    // roof: parapet, water tank, vents, stair hut, AC units
    var roof = CGeo(), wr = new WB(roof, { x: 0, z: 0, mat: MAT('CONCRETE'), col: [196, 194, 188] });
    var ry = floors * fh;
    wr.box(-w / 2 - 0.05, ry, d / 2 - 0.02, w / 2 + 0.05, ry + 0.55, d / 2 + 0.16, {});
    wr.box(-w / 2 - 0.05, ry, -d / 2 - 0.16, w / 2 + 0.05, ry + 0.55, -d / 2 + 0.02, {});
    wr.box(w / 2 - 0.02, ry, -d / 2 - 0.16, w / 2 + 0.16, ry + 0.55, d / 2 + 0.16, {});
    wr.box(-w / 2 - 0.16, ry, -d / 2 - 0.16, -w / 2 + 0.02, ry + 0.55, d / 2 + 0.16, {});
    wr.box(w * 0.1, ry, -d * 0.3, w * 0.38, ry + 2.3, d * 0.05, { mat: MAT('PLASTER'), col: [210, 206, 198] });
    wr.box(-w * 0.34, ry, -d * 0.3, -w * 0.1, ry + 1.1, d * 0.0, { mat: MAT('METAL'), col: [140, 140, 142] });    // AC / plant
    parts.push({ kind: 'roof', hp: 620, maxHp: 620, geo: roof, surface: 'concrete', walk: true, top: true,
      obb: { c: [0, ry + 0.14, 0], h: [w / 2 + 0.05, 0.14, d / 2 + 0.05], yaw: 0 }, solid: true, cover: true });
    return { w: w, d: d, floors: floors, fh: fh, roofY: ry + 0.28 };
  }
  /** Warehouse / factory shed: steel frame, corrugated walls, big doors, skylights. */
  function buildWarehouse(ctx, o) {
    var parts = ctx.parts, rng = ctx.rng;
    var w = o.w, d = o.d, h = o.h || 7.5;
    var g0 = CGeo(), wb = new WB(g0, { x: 0, z: 0, mat: MAT('CONCRETE'), col: [186, 184, 178] });
    wb.box(-w / 2 - 0.3, -3, -d / 2 - 0.3, w / 2 + 0.3, 0.3, d / 2 + 0.3, {});
    parts.push({ kind: 'wall', hp: 520, maxHp: 520, geo: g0, surface: 'concrete',
      obb: { c: [0, -1.35, 0], h: [w / 2 + 0.3, 1.65, d / 2 + 0.3], yaw: 0 }, solid: true });
    var sides = [
      { sx: -w / 2, sz: d / 2, dx: 1, dz: 0, len: w, door: 3.6 },
      { sx: w / 2, sz: -d / 2, dx: 1, dz: 0, len: w, door: 0 },
      { sx: -w / 2, sz: -d / 2, dx: 0, dz: 1, len: d, door: 0 },
      { sx: w / 2, sz: d / 2, dx: 0, dz: -1, len: d, door: rng() < 0.5 ? 3.2 : 0 }
    ];
    for (var i = 0; i < 4; i++) {
      var s = sides[i], openings = [];
      if (s.door) openings.push({ u0: s.len * 0.5 - s.door * 0.5, u1: s.len * 0.5 + s.door * 0.5, y0: 0.3, y1: 4.3, door: false, noFrame: true });
      // clerestory strip windows up high
      var n = Math.max(2, Math.round(s.len / 4));
      for (var k = 0; k < n; k++) {
        var u0 = s.len * (k + 0.5) / n - 0.9;
        openings.push({ u0: u0, u1: u0 + 1.8, y0: h - 2.1, y1: h - 0.9, window: true, noFrame: false, noCurtain: true });
      }
      var gg = CGeo();
      var res = wall(s.sx, s.sz, s.dx, s.dz, 0, s.len, 0.05, h, 0.16, { geo: gg, mat: MAT('METAL'), col: [178, 178, 180], openings: openings, uvScale: 0.6, frameMat: MAT('STEEL') });
      parts.push({ kind: 'wall', hp: 170, maxHp: 170, geo: res.geo, surface: 'metal',
        obb: { c: [s.sx + s.dx * s.len * 0.5, h * 0.5, s.sz + s.dz * s.len * 0.5], h: [Math.max(0.09, Math.abs(s.dx) * s.len * 0.5 + 0.08 * Math.abs(s.dz)), h * 0.5, Math.max(0.09, Math.abs(s.dz) * s.len * 0.5 + 0.08 * Math.abs(s.dx))], yaw: 0 },
        gaps: res.gaps, wallRef: res.ref,
        solid: true, cover: true });
    }
    // interior: steel columns, a mezzanine, crates, a crane rail
    var col = CGeo(), wc = new WB(col, { x: 0, z: 0, mat: MAT('STEEL'), col: [150, 152, 156] });
    for (var cx = -w / 2 + 4; cx < w / 2 - 2; cx += 8) for (var cz = -d / 2 + 4; cz < d / 2 - 2; cz += 8)
      wc.box(cx - 0.18, 0, cz - 0.18, cx + 0.18, h, cz + 0.18, {});
    wc.box(-w / 2, h - 1.4, 0, w / 2, h - 1.0, 0.4, { mat: MAT('STEEL') });
    parts.push({ kind: 'prop', hp: 260, maxHp: 260, geo: col, surface: 'steel',
      obb: { c: [0, h * 0.5, 0], h: [w * 0.02, h * 0.5, d * 0.02], yaw: 0 }, solid: true, cover: true, sparse: true });
    var mezz = CGeo(), wm = new WB(mezz, { x: 0, z: 0, mat: MAT('PLANK'), col: [186, 160, 128], uvScale: 1.4 });
    wm.box(-w / 2, h * 0.45, -d / 2, -w / 2 + w * 0.3, h * 0.45 + 0.3, d / 2, {});
    wm.box(-w / 2, h * 0.45 + 0.3, d / 2 - 0.1, -w / 2 + w * 0.3, h * 0.45 + 1.4, d / 2, { mat: MAT('METAL'), col: [130, 130, 132] });
    parts.push({ kind: 'floor', hp: 300, maxHp: 300, geo: mezz, surface: 'plank', walk: true,
      obb: { c: [-w / 2 + w * 0.15, h * 0.45 + 0.15, 0], h: [w * 0.15, 0.15, d / 2], yaw: 0 }, solid: true, cover: true, top: true });
    var st = CGeo(), steps = 14, rise = h * 0.45 / steps, run = 0.3;
    for (var s2 = 0; s2 < steps; s2++) stBox(st, -w / 2 + 0.6 + s2 * run, 0.3 + rise * s2, -d / 2 + 1.2, -w / 2 + 0.6 + (s2 + 1) * run, 0.3 + rise * (s2 + 1), -d / 2 + 2.4, MAT('STEEL'), [150, 152, 156]);
    parts.push({ kind: 'stairs', hp: 240, maxHp: 240, geo: st, surface: 'steel', walk: true, stairs: true,
      obb: { c: [-w / 2 + 0.6 + run * steps * 0.5, h * 0.225, -d / 2 + 1.8], h: [run * steps * 0.5, h * 0.225, 0.6], yaw: 0 }, solid: true, cover: true });
    // roof: ridged sheet with skylights and vents
    var roof = CGeo();
    var rh = 1.4 + rng() * 0.6;
    slab(roof, [-w / 2 - 0.4, h, -d / 2 - 0.4], [w / 2 + 0.4, h, -d / 2 - 0.4], [w / 2 + 0.4, h + rh, 0], [-w / 2 - 0.4, h + rh, 0], { mat: MAT('METAL'), col: [172, 172, 174], thickness: 0.18, uvScale: 0.8 });
    slab(roof, [w / 2 + 0.4, h, d / 2 + 0.4], [-w / 2 - 0.4, h, d / 2 + 0.4], [-w / 2 - 0.4, h + rh, 0], [w / 2 + 0.4, h + rh, 0], { mat: MAT('METAL'), col: [172, 172, 174], thickness: 0.18, uvScale: 0.8 });
    var wr2 = new WB(roof, { x: 0, z: 0, mat: MAT('RUST'), col: [150, 110, 80] });
    for (var v = 0; v < 3; v++) { var vx = -w * 0.3 + v * w * 0.3; wr2.box(vx - 0.4, h + rh - 0.2, -0.4, vx + 0.4, h + rh + 0.5, 0.4, {}); }
    parts.push({ kind: 'roof', hp: 220, maxHp: 220, geo: roof, surface: 'metal', walk: true, top: true,
      obb: { c: [0, h + rh * 0.5, 0], h: [w / 2, rh * 0.5 + 0.2, d / 2], yaw: 0 }, solid: true, cover: true });
    return { w: w, d: d, h: h, flat: true };
  }
  /** Concrete bunker / strongpoint with embrasures. */
  function buildBunker(ctx, o) {
    var parts = ctx.parts;
    var w = o.w || 8, d = o.d || 6, h = 3.1;
    var g = CGeo(), wb = new WB(g, { x: 0, z: 0, mat: MAT('CONCRETE'), col: [196, 194, 188], uvScale: 0.8 });
    wb.box(-w / 2, -2.6, -d / 2, w / 2, 0.2, d / 2, {});
    var sides = [
      { sx: -w / 2, sz: d / 2, dx: 1, dz: 0, len: w, slit: true },
      { sx: w / 2, sz: -d / 2, dx: 1, dz: 0, len: w, slit: false },
      { sx: -w / 2, sz: -d / 2, dx: 0, dz: 1, len: d, slit: true },
      { sx: w / 2, sz: d / 2, dx: 0, dz: -1, len: d, slit: false, door: true }
    ];
    for (var i = 0; i < 4; i++) {
      var s = sides[i], openings = [];
      if (s.slit) {
        var n = Math.max(2, Math.round(s.len / 3));
        for (var k = 0; k < n; k++) {
          var u0 = s.len * (k + 0.5) / n - 0.7;
          openings.push({ u0: u0, u1: u0 + 1.4, y0: 1.35, y1: 1.75, window: false, noFrame: true, noGlass: true });
        }
      }
      if (s.door) openings.push({ u0: s.len * 0.5 - 0.55, u1: s.len * 0.5 + 0.55, y0: 0.2, y1: 2.15, door: true, leaf: true, ajar: 0.9, panel: true });
      var gg = CGeo();
      var res = wall(s.sx, s.sz, s.dx, s.dz, 0, s.len, 0.2, h, 0.3, { geo: gg, mat: MAT('CONCRETE'), col: [192, 190, 184], openings: openings, uvScale: 0.8, frameMat: MAT('STEEL') });
      parts.push({ kind: 'wall', hp: 1100, maxHp: 1100, geo: res.geo, surface: 'concrete',
        obb: { c: [s.sx + s.dx * s.len * 0.5, 0.2 + (h - 0.2) * 0.5, s.sz + s.dz * s.len * 0.5], h: [Math.max(0.15, Math.abs(s.dx) * s.len * 0.5 + 0.15 * Math.abs(s.dz)), (h - 0.2) * 0.5, Math.max(0.15, Math.abs(s.dz) * s.len * 0.5 + 0.15 * Math.abs(s.dx))], yaw: 0 },
        gaps: res.gaps, wallRef: res.ref,
        solid: true, cover: true });
    }
    var roof = CGeo(), wr = new WB(roof, { x: 0, z: 0, mat: MAT('CONCRETE'), col: [190, 188, 182] });
    wr.box(-w / 2 - 0.2, h, -d / 2 - 0.2, w / 2 + 0.2, h + 0.5, d / 2 + 0.2, {});
    wr.box(-w / 2 - 0.2, h + 0.5, -d / 2 - 0.2, w / 2 + 0.2, h + 1.0, d / 2 + 0.2, { mat: MAT('SANDBAG'), col: [150, 140, 110] });   // sandbag parapet
    parts.push({ kind: 'roof', hp: 1400, maxHp: 1400, geo: roof, surface: 'concrete', walk: true, top: true,
      obb: { c: [0, h + 0.25, 0], h: [w / 2 + 0.2, 0.25, d / 2 + 0.2], yaw: 0 }, solid: true, cover: true });
    return { w: w, d: d, h: h + 0.5 };
  }
  /** Watchtower / water tower: legs or a shaft with an observation deck. */
  function buildTower(ctx, o) {
    var parts = ctx.parts, rng = ctx.rng;
    var shaft = o.shaft !== false, h = o.h || 8.5, deck = 3.0;
    var g = CGeo();
    if (shaft) {
      var wb = new WB(g, { x: 0, z: 0, mat: MAT('CONCRETE'), col: [198, 196, 190], uvScale: 0.9 });
      wb.box(-1.1, -2, -1.1, 1.1, h, 1.1, {});
      var wb2 = new WB(g, { x: 0, z: 0, mat: MAT('CONCRETE'), col: [186, 184, 178] });
      wb2.box(-deck / 2, h, -deck / 2, deck / 2, h + 0.3, deck / 2, {});
      wb2.box(-deck / 2, h + 0.3, deck / 2 - 0.12, deck / 2, h + 1.25, deck / 2, {});
      wb2.box(-deck / 2, h + 0.3, -deck / 2, deck / 2, h + 1.25, -deck / 2 + 0.12, {});
      wb2.box(deck / 2 - 0.12, h + 0.3, -deck / 2, deck / 2, h + 1.25, deck / 2, {});
      wb2.box(-deck / 2, h + 0.3, -deck / 2, -deck / 2 + 0.12, h + 1.25, deck / 2, {});
      wb2.box(-deck / 2 - 0.25, h + 1.25, -deck / 2 - 0.25, deck / 2 + 0.25, h + 1.45, deck / 2 + 0.25, {});
      var st = CGeo(), steps = 40, rise = h / steps, run = 0.22;
      for (var s = 0; s < steps; s++) stBox(st, 1.1 + 0.0, -2 + rise * s, -1.1 + (s % 2 ? 0.0 : 0.0), 1.1 + 1.1, -2 + rise * (s + 1), 1.1, MAT('METAL'), [150, 150, 152]);
      // spiral-ish stair hugging the shaft
      for (s = 0; s < steps; s++) {
        var a = s / steps * Math.PI * 2;
        stBox(st, Math.cos(a) * 1.1, rise * s - 1.2, Math.sin(a) * 1.1, Math.cos(a) * 2.2, rise * (s + 1) - 1.2 + 0.05, Math.sin(a) * 2.2, MAT('METAL'), [150, 150, 152]);
      }
      parts.push({ kind: 'wall', hp: 900, maxHp: 900, geo: g, surface: 'concrete',
        obb: { c: [0, h * 0.5, 0], h: [1.1, h * 0.5 + 1, 1.1], yaw: 0 }, solid: true, cover: true });
      parts.push({ kind: 'floor', hp: 400, maxHp: 400, geo: st, surface: 'steel', walk: true,
        obb: { c: [0, h + 0.15, 0], h: [deck / 2, 0.35, deck / 2], yaw: 0 }, solid: true, cover: true, top: true });
    } else {
      var wc = new WB(g, { x: 0, z: 0, mat: MAT('TIMBER'), col: [178, 150, 116] });
      var legs = [[-1.4, -1.4], [1.4, -1.4], [1.4, 1.4], [-1.4, 1.4]];
      for (var L = 0; L < 4; L++) wc.box(legs[L][0] - 0.14, -2, legs[L][1] - 0.14, legs[L][0] + 0.14, h, legs[L][1] + 0.14, {});
      for (var b = 1; b < 4; b++) wc.box(-1.4, h * b / 4 - 0.1, -1.4, 1.4, h * b / 4 + 0.1, -1.34, {});
      wc.box(-1.4, h * 0.75 - 0.1, 1.34, 1.4, h * 0.75 + 0.1, 1.4, {});
      wc.box(-1.4, h, -1.4, 1.4, h + 0.25, 1.4, {});
      wc.box(-1.4, h + 0.25, -1.4, 1.4, h + 1.3, -1.28, {});
      wc.box(-1.4, h + 0.25, 1.28, 1.4, h + 1.3, 1.4, {});
      wc.box(1.28, h + 0.25, -1.4, 1.4, h + 1.3, 1.4, {});
      wc.box(-1.4, h + 0.25, -1.4, -1.28, h + 1.3, 1.4, {});
      if (rng() < 0.5) slab(g, [-1.6, h + 1.3, -1.6], [1.6, h + 1.3, -1.6], [1.6, h + 2.0, 0], [-1.6, h + 2.0, 0], { mat: MAT('RUST'), col: [140, 110, 84], thickness: 0.1 });
      parts.push({ kind: 'wall', hp: 260, maxHp: 260, geo: g, surface: 'timber',
        obb: { c: [0, (h + 0.6) * 0.5, 0], h: [1.5, (h + 0.6) * 0.5, 1.5], yaw: 0 }, solid: true, cover: true });
      parts.push({ kind: 'floor', hp: 200, maxHp: 200, geo: CGeo(), surface: 'plank', walk: true,
        obb: { c: [0, h + 0.12, 0], h: [1.4, 0.12, 1.4], yaw: 0 }, solid: true, cover: true, top: true });
      var st2 = CGeo(), steps2 = 22, rise2 = h / steps2;
      for (var s2 = 0; s2 < steps2; s2++) { var aa = s2 / steps2 * Math.PI * 3; stBox(st2, Math.cos(aa) * 1.0, rise2 * s2 - 1.2, Math.sin(aa) * 1.0, Math.cos(aa) * 2.0, rise2 * (s2 + 1) - 1.2 + 0.04, Math.sin(aa) * 2.0, MAT('PLANK'), [170, 140, 106]); }
      parts.push({ kind: 'stairs', hp: 160, maxHp: 160, geo: st2, surface: 'plank', walk: true, stairs: true,
        obb: { c: [0, h * 0.5, 0], h: [2.0, h * 0.5 + 1, 2.0], yaw: 0 }, solid: true, sparse: true });
    }
    return { w: deck, d: deck, h: h };
  }
  /** Bombed-out shell: broken walls, exposed floor slabs, rubble. */
  function buildRuins(ctx, o) {
    var parts = ctx.parts, rng = ctx.rng;
    var w = o.w, d = o.d, floors = 1 + Math.floor(rng() * 2);
    var pal = PALETTE[Math.floor(rng() * 4)];
    for (var fl = 0; fl < floors; fl++) {
      var fy = fl * 3.0;
      var sides = [
        { sx: -w / 2, sz: d / 2, dx: 1, dz: 0, len: w }, { sx: w / 2, sz: -d / 2, dx: 1, dz: 0, len: w },
        { sx: -w / 2, sz: -d / 2, dx: 0, dz: 1, len: d }, { sx: w / 2, sz: d / 2, dx: 0, dz: -1, len: d }
      ];
      for (var i = 0; i < 4; i++) {
        if (rng() < 0.3) continue;                     // whole wall gone
        var s = sides[i];
        var segs = Math.max(2, Math.round(s.len / 3)), cursor = 0;
        for (var k = 0; k < segs; k++) {
          var segLen = s.len / segs;
          if (rng() < 0.3) { cursor += segLen; continue; }   // a gap
          var hgt = fy + 1.2 + rng() * 1.6;
          var gg = CGeo();
          var wb = new WB(gg, { x: s.sx + s.dx * cursor, z: s.sz + s.dz * cursor, dx: s.dx, dz: s.dz, mat: pal.mat, col: pal.col, uvScale: 1 });
          wb.box(0, fy, -0.16, segLen, hgt, 0.16, { edge: 230, wear: 120 });
          parts.push({ kind: 'wall', hp: 150, maxHp: 150, geo: gg, surface: pal.key === 'plaster' ? 'plaster' : 'brick',
            obb: { c: [s.sx + s.dx * (cursor + segLen * 0.5), (fy + hgt) * 0.5, s.sz + s.dz * (cursor + segLen * 0.5)], h: [Math.max(0.09, Math.abs(s.dx) * segLen * 0.5 + 0.16 * Math.abs(s.dz)), (hgt - fy) * 0.5, Math.max(0.09, Math.abs(s.dz) * segLen * 0.5 + 0.16 * Math.abs(s.dx))], yaw: 0 },
            solid: true, cover: true });
          cursor += segLen;
        }
      }
      // partial floor slab
      if (fl > 0 && rng() < 0.7) {
        var gf = CGeo(), wf = new WB(gf, { x: 0, z: 0, mat: MAT('CONCRETE'), col: [192, 190, 184], uvScale: 0.9 });
        var hx = w / 2 * (0.6 + rng() * 0.4), hz = d / 2 * (0.6 + rng() * 0.4);
        wf.box(-hx, fy - 0.3, -hz, hx, fy, hz, { edge: 240, wear: 140 });
        parts.push({ kind: 'floor', hp: 260, maxHp: 260, geo: gf, surface: 'concrete', walk: true,
          obb: { c: [0, fy - 0.15, 0], h: [hx, 0.15, hz], yaw: 0 }, solid: true, cover: true });
      }
    }
    // rubble piles + rebar (decorative but solid enough to be cover)
    for (var r = 0; r < 3 + Math.floor(rng() * 4); r++) {
      var g = CGeo(), wb2 = new WB(g, { x: 0, z: 0, mat: MAT('GRAVEL'), col: [170, 166, 158], uvScale: 1.4 });
      var rx = (rng() - 0.5) * w, rz = (rng() - 0.5) * d, rw = 1.2 + rng() * 2.4, rh = 0.35 + rng() * 0.8;
      wb2.box(rx - rw, 0, rz - rw * 0.8, rx + rw, rh, rz + rw * 0.8, { edge: 250, wear: 180 });
      parts.push({ kind: 'prop', hp: 90, maxHp: 90, geo: g, surface: 'gravel', rubble: true,
        obb: { c: [rx, rh * 0.5, rz], h: [rw, rh * 0.5, rw * 0.8], yaw: 0 }, solid: true, cover: true });
    }
    void pal;
    return { w: w, d: d, ruins: true };
  }
  /** Military checkpoint: sandbags, jersey barriers, hut, tower, wire, camo net. */
  function buildCheckpoint(ctx, o) {
    var parts = ctx.parts, rng = ctx.rng;
    var w = o.w || 26, d = o.d || 10;
    // sandbag walls along both sides of the road
    for (var s = 0; s < 2; s++) {
      var zz = s ? d * 0.42 : -d * 0.42;
      var g = CGeo(), wb = new WB(g, { x: 0, z: 0, mat: MAT('SANDBAG'), col: [146, 136, 108], uvScale: 1.6 });
      var len = w * 0.7, x0 = -len * 0.5;
      for (var i = 0; i < Math.round(len / 1.5); i++) {
        var bx = x0 + i * 1.5;
        wb.box(bx, 0, zz - 0.45, bx + 1.45, 0.42, zz + 0.45, { edge: 220 });
        wb.box(bx + 0.05, 0.42, zz - 0.42, bx + 1.4, 0.82, zz + 0.42, { edge: 220 });
        if (i % 2) wb.box(bx + 0.2, 0.82, zz - 0.4, bx + 1.25, 1.1, zz + 0.4, { edge: 220 });
      }
      parts.push({ kind: 'cover', hp: 260, maxHp: 260, geo: g, surface: 'sandbag',
        obb: { c: [0, 0.55, zz], h: [len * 0.5, 0.55, 0.45], yaw: 0 }, solid: true, cover: true, low: true });
    }
    // jersey barriers across the road with a chicane
    for (var b = 0; b < 3; b++) {
      var g2 = CGeo(), wb2 = new WB(g2, { x: 0, z: 0, mat: MAT('CONCRETE'), col: [206, 204, 198], uvScale: 1 });
      var bx0 = -w * 0.3 + b * w * 0.28, bz = (b % 2 ? -1.6 : 1.6);
      wb2.box(bx0, 0, bz - 0.35, bx0 + 2.6, 0.75, bz + 0.35, {});
      wb2.box(bx0 + 0.3, 0.75, bz - 0.25, bx0 + 2.3, 1.0, bz + 0.25, {});
      parts.push({ kind: 'cover', hp: 340, maxHp: 340, geo: g2, surface: 'concrete',
        obb: { c: [bx0 + 1.3, 0.5, bz], h: [1.3, 0.5, 0.35], yaw: 0 }, solid: true, cover: true, low: true });
    }
    // guard hut
    var hut = ctx.at(0, 0, 0, function () { return buildHouse(ctx, { w: 4.6, d: 3.6, floors: 1, flat: true, pal: PALETTE[4] }); });
    void hut;
    // watchtower beside the road
    ctx.at(-w * 0.32, d * 0.75, 0, function () { return buildTower(ctx, { h: 7.5, deck: 2.8, shaft: false }); });
    // barbed-wire posts + camo netting over the road
    var wire = CGeo(), ww = new WB(wire, { x: 0, z: 0, mat: MAT('METAL'), col: [130, 130, 132] });
    for (var p = 0; p < 8; p++) {
      var px = -w * 0.42 + p * (w * 0.84 / 7);
      ww.box(px - 0.05, 0, d * 0.75, px + 0.05, 1.5, d * 0.75 + 0.1, {});
      ww.box(px - 0.05, 0, -d * 0.75 - 0.1, px + 0.05, 1.5, -d * 0.75, {});
    }
    parts.push({ kind: 'prop', hp: 60, maxHp: 60, geo: wire, surface: 'metal', solid: false, noRay: true });
    var net = CGeo(), wn = new WB(net, { x: 0, z: 0, mat: MAT('CANVAS'), col: [120, 124, 96] });
    wn.box(-w * 0.42, 2.4, -2.6, w * 0.42, 2.55, 2.6, { edge: 120 });
    parts.push({ kind: 'prop', hp: 40, maxHp: 40, geo: net, surface: 'canvas', solid: false, noRay: true });
    // crates and barrels
    for (var c = 0; c < 5; c++) {
      var g3 = CGeo(), wb3 = new WB(g3, { x: 0, z: 0, mat: MAT('PLANK'), col: [172, 146, 112], uvScale: 1.2 });
      var cx = (rng() - 0.5) * w * 0.7, cz = (rng() - 0.5) * d * 0.8, cs = 0.55 + rng() * 0.35;
      wb3.box(cx - cs, 0, cz - cs, cx + cs, cs * 2, cz + cs, { edge: 210 });
      parts.push({ kind: 'prop', hp: 70, maxHp: 70, geo: g3, surface: 'plank', yaw: 0,
        obb: { c: [cx, cs, cz], h: [cs, cs, cs], yaw: 0 }, solid: true, cover: true, low: true });
    }
    return { w: w, d: d };
  }
  /** Container yard / industrial plot. */
  function buildYard(ctx, o) {
    var parts = ctx.parts, rng = ctx.rng;
    var w = o.w || 24, d = o.d || 18;
    var n = 3 + Math.floor(rng() * 4);
    for (var i = 0; i < n; i++) {
      var g = CGeo(), wb = new WB(g, { x: 0, z: 0, mat: MAT('METAL'), col: [rng() < 0.5 ? 150 : 120, rng() < 0.7 ? 110 : 140, 90 + rng() * 60], uvScale: 0.8 });
      var cx = (rng() - 0.5) * (w - 8), cz = (rng() - 0.5) * (d - 6), yaw = rng() < 0.6 ? 0 : 1.57;
      var stacked = rng() < 0.4;
      var hw = yaw ? 1.22 : 3.05, hd = yaw ? 3.05 : 1.22;
      wb.box(-3.05, 0, -1.22, 3.05, 1.3, 1.22, { edge: 200 });
      if (stacked) wb.box(-3.05, 1.3, -1.22, 3.05, 2.6, 1.22, { edge: 200, wear: 60 });
      parts.push({ kind: 'prop', hp: 300, maxHp: 300, geo: g, surface: 'metal', yaw: yaw,
        obb: { c: [cx, stacked ? 1.3 : 0.65, cz], h: [hw, stacked ? 1.3 : 0.65, hd], yaw: yaw }, solid: true, cover: true });
      // fix the OBB position (the geometry is placed at the origin, moved below)
      var part = parts[parts.length - 1];
      part.geo = null;
      var moved = CGeo();
      moved.append(g, [cx, 0, cz], 0);
      part.geo = moved;
      part.obb.c[0] = cx; part.obb.c[2] = cz;
    }
    // barrels, tires, pallets
    for (var b = 0; b < 10; b++) {
      var g2 = CGeo();
      var bx = (rng() - 0.5) * (w - 3), bz = (rng() - 0.5) * (d - 3);
      g2.cylinder([bx - 0.3, 0, bz], [bx - 0.3, 0.9, bz], 0.3, 0.3, 12, { mat: rng() < 0.4 ? MAT('RUST') : MAT('METAL'), col: rng() < 0.5 ? [120, 90, 60] : [110, 130, 90], caps: true });
      if (rng() < 0.3) g2.cylinder([bx + 0.62, 0, bz], [bx + 0.62, 0.9, bz], 0.3, 0.3, 12, { mat: MAT('METAL'), col: [110, 130, 90], caps: true });
      parts.push({ kind: 'prop', hp: 40, maxHp: 40, geo: g2, surface: 'metal',
        obb: { c: [bx, 0.45, bz], h: [0.9, 0.45, 0.32], yaw: 0 }, solid: true, cover: true, low: true });
    }
    return { w: w, d: d };
  }

  /* ==========================================================================
   * Settlement generation
   * ======================================================================== */
  function settlementPool(E, ci, cj) {
    var gen = E.gen;
    var o = gen.newSample();
    var best = null, rng0 = rngFrom(hash32(E.seed + ':st:' + ci + ',' + cj));
    for (var i = 0; i < 7; i++) {
      var x = (ci + 0.12 + rng0() * 0.76) * CELL, z = (cj + 0.12 + rng0() * 0.76) * CELL;
      gen.sample(x, z, o, 0);
      if (o.wtype > 0 || o.h < gen.SEA + 3) continue;
      if (o.h > gen.SEA + 1500) continue;
      // flatness over a 70 m footprint
      var h0 = gen.height(x, z), flat = 0;
      for (var k = 0; k < 6; k++) {
        var a = k / 6 * Math.PI * 2;
        flat = Math.max(flat, Math.abs(gen.height(x + Math.cos(a) * 42, z + Math.sin(a) * 42) - h0));
      }
      if (flat > 14) continue;
      var biome = gen.classify(o, flat / 42);
      var score = 100 - flat * 2.4 + (biome === TERRA.core.BIOME.MEDITERRANEAN ? 22 : biome === TERRA.core.BIOME.GRASSLAND ? 20 :
        biome === TERRA.core.BIOME.TEMPERATE_FOREST ? 14 : biome === TERRA.core.BIOME.STEPPE ? 12 :
        biome === TERRA.core.BIOME.SHRUBLAND ? 10 : biome === TERRA.core.BIOME.COLD_DESERT ? 4 :
        biome === TERRA.core.BIOME.BADLANDS ? 2 : biome === TERRA.core.BIOME.SAVANNA ? 8 : -18);
      score += rng0() * 12;
      if (!best || score > best.score) best = { x: x, z: z, score: score, h: h0, biome: biome, temp: o.temp, moist: o.moist };
    }
    return best;
  }

  P.settlementAt = function (ci, cj) {
    var key = ci + ':' + cj;
    var s = this.settlements.get(key);
    if (s) return s;
    var E = this.E;
    var site = settlementPool(E, ci, cj);
    if (!site || site.score < 12) { this.settlements.set(key, null); return null; }
    var rng = rngFrom(hash32(E.seed + ':set:' + ci + ',' + cj));
    s = {
      key: key, x: site.x, z: site.z, y: site.h, site: site, rng: rng,
      kind: null, name: null, parts: [], cover: [], spawns: [], patrol: [],
      mesh: null, lodMesh: null, dirty: true, built: false, destroyedCount: 0,
      radius: 120, hpScale: 1, fire: 0, collapseQueue: []
    };
    var gen = E.gen;
    var temp = site.temp, biome = site.biome;
    var B = TERRA.core.BIOME;
    var hostiles = temp > -6 && biome !== B.GLACIER;
    // pick a settlement kind
    var r = rng();
    if (biome === B.MEDITERRANEAN || biome === B.GRASSLAND || biome === B.TEMPERATE_FOREST || biome === B.COASTAL_FOREST || biome === B.STEPPE) {
      s.kind = r < 0.34 ? 'town' : (r < 0.72 ? 'village' : 'outpost');
    } else if (biome === B.SHRUBLAND || biome === B.SAVANNA || biome === B.TROPICAL_FOREST || biome === B.SAVANNA) {
      s.kind = r < 0.3 ? 'village' : (r < 0.6 ? 'outpost' : 'ruins');
    } else if (biome === B.ROCKY_DESERT || biome === B.DESERT || biome === B.COLD_DESERT) {
      s.kind = r < 0.45 ? 'village' : (r < 0.8 ? 'outpost' : 'ruins');
    } else if (biome === B.BADLANDS || biome === B.MOUNTAIN || biome === B.ALPINE) {
      s.kind = r < 0.5 ? 'ruins' : 'outpost';
    } else {
      s.kind = r < 0.5 ? 'village' : 'ruins';
    }
    s.hostile = hostiles && (s.kind === 'town' || s.kind === 'village' || s.kind === 'outpost');
    s.name = settlementName(rng, s.kind);
    s.planned = false;
    this.settlements.set(key, s);
    return s;
  };

  function settlementName(rng, kind) {
    var pre = ['Kara', 'Voln', 'Draz', 'Bel', 'Tir', 'Mar', 'Ostro', 'Kras', 'Som', 'Alba', 'Verd', 'Nira', 'Zel', 'Har', 'Kol', 'Ur', 'Rav', 'Miro', 'Pald', 'Sena'];
    var suf = ['grad', 'ovka', 'nik', 'ich', 'ovo', 'ino', 'burg', 'ton', 'mer', 'stad', 'vka', 'yevo'];
    var base = pre[(rng() * pre.length) | 0] + suf[(rng() * suf.length) | 0];
    var tag = { town: '', village: '', outpost: ' Outpost', ruins: ' Ruins', industrial: ' Works' }[kind] || '';
    return base + tag;
  }

  /** Layout: streets, plots, buildings, props, cover points and AI spawns. */
  /** Layout is generated on demand (first build) so the streaming loop stays cheap. */
  P.ensurePlanned = function (s) {
    if (s.planned) return s;
    s.planned = true;
    this._plan(s);
    if (this._pendingDamage && this._pendingDamage[s.key]) this._applyDamage(s, this._pendingDamage[s.key]);
    return s;
  };

  P._plan = function (s) {
    var E = this.E, rng = s.rng, gen = E.gen, parts = s.parts;
    var ctx = {
      parts: parts, rng: rng, gen: gen, E: E,
      at: function (dx, dz, yaw, fn) { return at(ctx, s, dx, dz, yaw, fn); }
    };
    s.roads = [];
    // Everything inside a settlement is authored in its local frame: y = 0 is the
    // terrain under its centre, so the whole plan can be lifted onto the ground by
    // adding s.y once (draw, colliders) instead of touching every prefab.
    var groundAt = function (x, z) { return gen.height(s.x + x, s.z + z) + (E.edits ? E.edits.heightDelta(s.x + x, s.z + z) : 0) - s.y; };
    s.groundAt = groundAt;
    if (s.kind === 'town') planTown(ctx, s, rng);
    else if (s.kind === 'village') planVillage(ctx, s, rng);
    else if (s.kind === 'outpost') planOutpost(ctx, s, rng);
    else if (s.kind === 'ruins') planRuins(ctx, s, rng);
    else planVillage(ctx, s, rng);
    // perimeter: fences, hedges, rubble berms, walls
    planPerimeter(ctx, s, rng);
    // streets: props, lamps, parked cars, wires
    planStreets(ctx, s, rng);
    // bounds
    var rmax = 0;
    for (var i = 0; i < s.roads.length; i++) rmax = Math.max(rmax, Math.hypot(s.roads[i].x, s.roads[i].z));
    s.radius = U.clamp(rmax + 60, 90, 420);
    // AI spawns & patrol route
    buildSpawns(s, rng);
    // cover points from solid parts
    s.cover = extractCover(s);
    s.parts.forEach(function (p, idx) { p.id = idx; });
    TERRA.events.emit('settlement', s);
  };

  function at(ctx, s, dx, dz, yaw, fn) {
    // build a prefab in a temporary list, then offset its parts into the settlement;
    // the plot's own ground height goes in as well, so a house on a slope is not
    // half-buried and its doorway still lines up with the terrain outside
    var gy = s.groundAt ? s.groundAt(dx, dz) : 0;
    var sub = { parts: [], rng: ctx.rng, gen: ctx.gen, E: ctx.E, at: ctx.at };
    var res = fn(sub);
    var cs = Math.cos(yaw), sn = Math.sin(yaw);
    for (var i = 0; i < sub.parts.length; i++) {
      var p = sub.parts[i];
      var g = CGeo();
      g.append(p.geo, [dx, gy, dz], yaw);
      p.geo = g;
      if (p.gaps) for (var gi = 0; gi < p.gaps.length; gi += 4) { p.gaps[gi + 1] += gy; p.gaps[gi + 3] += gy; }
      if (p.obb) {
        p.obb.c = [dx + cs * p.obb.c[0] - sn * p.obb.c[2], p.obb.c[1] + gy, dz + sn * p.obb.c[0] + cs * p.obb.c[2]];
        p.obb.yaw = (p.obb.yaw || 0) + yaw;
      }
      if (p.emissive) p.emissive = [dx + cs * p.emissive[0] - sn * p.emissive[2], p.emissive[1], dz + sn * p.emissive[0] + cs * p.emissive[2]];
      ctx.parts.push(p);
    }
    void cs; void sn;
    return res;
  }

  /** Road ribbon that follows the terrain (asphalt / dirt track). */
  function roadRibbon(ctx, s, pts, width, mat, col) {
    var g = CGeo();
    var hw = width * 0.5, step = 4, lift = mat === MAT('ASPHALT') ? 0.07 : 0.05;
    for (var i = 0; i < pts.length - 1; i++) {
      var a = pts[i], b = pts[i + 1];
      var len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.01) continue;
      var dirx = (b[0] - a[0]) / len, dirz = (b[1] - a[1]) / len;
      var yaw = Math.atan2(dirx, dirz);
      for (var t = 0; t < len - 0.001; t += step) {
        var t1 = Math.min(len, t + step);
        var p0x = a[0] + dirx * t, p0z = a[1] + dirz * t;
        var p1x = a[0] + dirx * t1, p1z = a[1] + dirz * t1;
        // corners across the road (perpendicular in xz)
        var nx = -dirz * hw, nz = dirx * hw;
        var q0 = [p0x - nx, s.groundAt(p0x - nx, p0z - nz) + lift, p0z - nz];
        var q1 = [p0x + nx, s.groundAt(p0x + nx, p0z + nz) + lift, p0z + nz];
        var q2 = [p1x + nx, s.groundAt(p1x + nx, p1z + nz) + lift, p1z + nz];
        var q3 = [p1x - nx, s.groundAt(p1x - nx, p1z - nz) + lift, p1z - nz];
        g.face(q0, q1, q2, q3, { mat: mat, col: col, uvScale: 0.25, edge: 40, ao: 240, wear: 40 });
      }
      s.roads.push({ x: (a[0] + b[0]) * 0.5, z: (a[1] + b[1]) * 0.5, yaw: yaw, len: len, width: width, mat: mat });
    }
    ctx.parts.push({ kind: 'road', hp: 99999, maxHp: 99999, geo: g, surface: mat === MAT('ASPHALT') ? 'asphalt' : 'dirt',
      solid: false, road: true, noCollide: true });
    return g;
  }

  function planTown(ctx, s, rng) {
    var nbx = 3 + Math.floor(rng() * 2), nbz = 2 + Math.floor(rng() * 2);
    var bw = 13 + rng() * 5, bd = 12 + rng() * 4, roadW = 9;
    var pitchX = bw + roadW, pitchZ = bd + roadW;
    var x0 = -(nbx - 1) * pitchX * 0.5, z0 = -(nbz - 1) * pitchZ * 0.5;
    // main street through the middle + cross streets
    var streets = [];
    for (var i = 0; i < nbx + 1; i++) {
      var sx = x0 - pitchX * 0.5 + i * pitchX;
      streets.push([[sx, z0 - pitchZ * 0.7], [sx, z0 + (nbz - 0.3) * pitchZ]]);
    }
    for (var j = 0; j < nbz + 1; j++) {
      var sz = z0 - pitchZ * 0.5 + j * pitchZ;
      streets.push([[x0 - pitchX * 0.7, sz], [x0 + (nbx - 0.3) * pitchX, sz]]);
    }
    for (i = 0; i < streets.length; i++) roadRibbon(ctx, s, streets[i], roadW * 0.55, MAT('ASPHALT'), [58, 58, 60]);
    s.streetPts = streets;
    for (var bi = 0; bi < nbx; bi++) for (var bj = 0; bj < nbz; bj++) {
      var cx = x0 + bi * pitchX, cz = z0 + bj * pitchZ;
      var r = rng();
      var yaw = rng() < 0.5 ? 0 : Math.PI * 0.5;
      if (r < 0.5) {
        ctx.at(cx, cz, yaw, function (sub) { return buildBlock(sub, { w: bw, d: bd, floors: 2 + Math.floor(rng() * 3) }); });
        s.spawns.push({ x: cx, z: cz, y: 0, type: 'interior' });
      } else if (r < 0.82) {
        ctx.at(cx, cz, yaw, function (sub) { return buildHouse(sub, { w: bw, d: bd, floors: rng() < 0.7 ? 2 : 1 }); });
        s.spawns.push({ x: cx, z: cz, y: 0, type: 'interior' });
      } else if (r < 0.92) {
        ctx.at(cx, cz, yaw, function (sub) { return buildWarehouse(sub, { w: bw + 5, d: bd + 4, h: 7 }); });
        s.spawns.push({ x: cx, z: cz, y: 0, type: 'interior' });
      } else {
        ctx.at(cx, cz, yaw, function (sub) { return buildRuins(sub, { w: bw, d: bd }); });
        s.spawns.push({ x: cx, z: cz, y: 0, type: 'interior' });
      }
      if (rng() < 0.3) ctx.at(cx + (rng() - 0.5) * 6, cz + bd * 0.9 + roadW * 0.3, rng() * 6.28, function (sub) { return buildYard(sub, { w: 10, d: 8 }); });
    }
    s.townSquare = [x0 + pitchX * (nbx - 1) * 0.5, z0 + pitchZ * (nbz - 1) * 0.5];
  }

  function planVillage(ctx, s, rng) {
    // a winding main road with houses on both sides
    var n = 5 + Math.floor(rng() * 5);
    var pts = [], ang = rng() * 6.28, x = -70 - rng() * 20, z = -40 + rng() * 80;
    pts.push([x, z]);
    for (var i = 0; i < n; i++) {
      ang += (rng() - 0.5) * 0.7;
      x += Math.cos(ang) * (22 + rng() * 14); z += Math.sin(ang) * (22 + rng() * 14);
      pts.push([x, z]);
    }
    roadRibbon(ctx, s, pts, 6.5, rng() < 0.4 ? MAT('ASPHALT') : MAT('GRAVEL'), rng() < 0.4 ? [58, 58, 60] : [128, 122, 110]);
    s.streetPts = [pts];
    for (i = 0; i < pts.length - 1; i++) {
      var a = pts[i], b = pts[i + 1];
      var dirx = b[0] - a[0], dirz = b[1] - a[1], len = Math.hypot(dirx, dirz);
      dirx /= len; dirz /= len;
      var yaw = Math.atan2(dirx, dirz);
      for (var side = -1; side <= 1; side += 2) {
        if (rng() < 0.22) continue;
        var t = 0.25 + rng() * 0.5;
        var px = a[0] + dirx * len * t - dirz * side * (10 + rng() * 7);
        var pz = a[1] + dirz * len * t + dirx * side * (10 + rng() * 7);
        var r = rng();
        var oy = yaw + (rng() - 0.5) * 0.5 + (side > 0 ? 0 : Math.PI);
        if (r < 0.62) {
          ctx.at(px, pz, oy, function (sub) { return buildHouse(sub, { w: 7 + rng() * 4, d: 6 + rng() * 3, floors: rng() < 0.5 ? 1 : 2 }); });
          s.spawns.push({ x: px, z: pz, y: 0, type: 'interior' });
        } else if (r < 0.8) {
          ctx.at(px, pz, oy, function (sub) { return buildWarehouse(sub, { w: 9 + rng() * 4, d: 7, h: 6 }); });
          s.spawns.push({ x: px, z: pz, y: 0, type: 'interior' });
        } else if (r < 0.92) {
          ctx.at(px, pz, oy, function (sub) { return buildTower(sub, { h: 6 + rng() * 3, deck: 3, shaft: rng() < 0.5 }); });
          s.spawns.push({ x: px, z: pz, y: 0, type: 'tower' });
        } else {
          ctx.at(px, pz, oy, function (sub) { return buildYard(sub, { w: 10, d: 9 }); });
          s.spawns.push({ x: px, z: pz, y: 0, type: 'yard' });
        }
      }
    }
    s.villageRoad = pts;
  }

  function planOutpost(ctx, s, rng) {
    var yaw = rng() * 6.28;
    var roadAng = yaw;
    roadRibbon(ctx, s, [[-90 * Math.cos(roadAng), -90 * Math.sin(roadAng)], [90 * Math.cos(roadAng), 90 * Math.sin(roadAng)]], 8, MAT('ASPHALT'), [56, 56, 58]);
    s.streetPts = [[[-90 * Math.cos(roadAng), -90 * Math.sin(roadAng)], [90 * Math.cos(roadAng), 90 * Math.sin(roadAng)]]];
    // checkpoint straddling the road
    ctx.at(0, 0, yaw, function (sub) { return buildCheckpoint(sub, { w: 30, d: 11 }); });
    // bunker + towers + yards around it
    ctx.at(-22 - rng() * 8, 14 + rng() * 8, rng() * 6.28, function (sub) { return buildBunker(sub, { w: 9, d: 7 }); });
    ctx.at(24 + rng() * 8, -12 - rng() * 8, rng() * 6.28, function (sub) { return buildBunker(sub, { w: 7, d: 6 }); });
    for (var t = 0; t < 2; t++) {
      var tx = (t ? 26 : -26) + (rng() - 0.5) * 8, tz = (t ? 14 : -14) + (rng() - 0.5) * 8;
      ctx.at(tx, tz, rng() * 6.28, function (sub) { return buildTower(sub, { h: 8 + rng() * 3, deck: 3, shaft: true }); });
      s.spawns.push({ x: tx, z: tz, y: 0, type: 'tower' });
    }
    for (var y = 0; y < 2; y++) {
      var yx = (rng() - 0.5) * 50, yz = (y ? 34 : -34) + (rng() - 0.5) * 10;
      ctx.at(yx, yz, rng() * 6.28, function (sub) { return buildYard(sub, { w: 16, d: 12 }); });
    }
    ctx.at(-14 + rng() * 6, -26 - rng() * 6, rng() * 6.28, function (sub) { return buildWarehouse(sub, { w: 14, d: 10, h: 6.5 }); });
    // revetments and Hesco-style walls
    for (var w = 0; w < 6; w++) {
      var g = CGeo(), wb = new WB(g, { x: 0, z: 0, mat: MAT('SANDBAG'), col: [150, 140, 112], uvScale: 1.2 });
      var wx = (rng() - 0.5) * 60, wz = (rng() - 0.5) * 60, len = 4 + rng() * 8, wide = 0.9;
      wb.box(-len / 2, 0, -wide / 2, len / 2, 1.5, wide / 2, { edge: 210 });
      var moved = CGeo(); moved.append(g, [wx, 0, wz], 0);
      s.parts.push({ kind: 'cover', hp: 320, maxHp: 320, geo: moved, surface: 'sandbag',
        obb: { c: [wx, 0.75, wz], h: [len / 2, 0.75, wide / 2], yaw: 0 }, solid: true, cover: true });
    }
    s.spawns.push({ x: 0, z: 0, y: 0, type: 'road' }, { x: 0, z: 10, y: 0, type: 'road' }, { x: 0, z: -10, y: 0, type: 'road' });
  }

  function planRuins(ctx, s, rng) {
    var n = 3 + Math.floor(rng() * 4);
    for (var i = 0; i < n; i++) {
      var cx = (rng() - 0.5) * 90, cz = (rng() - 0.5) * 90;
      ctx.at(cx, cz, rng() * 6.28, function (sub) { return buildRuins(sub, { w: 9 + rng() * 8, d: 8 + rng() * 7 }); });
      s.spawns.push({ x: cx, z: cz, y: 0, type: 'ruin' });
    }
    roadRibbon(ctx, s, [[-80, 0], [0, 6], [80, -4]], 6, MAT('GRAVEL'), [126, 120, 108]);
    s.streetPts = [[[-80, 0], [0, 6], [80, -4]]];
  }

  function planPerimeter(ctx, s, rng) {
    if (s.kind === 'ruins' && rng() < 0.5) return;
    var R = 62 + rng() * 30;
    var segs = Math.round(R * 0.5);
    var g = CGeo(), kind = rng();
    var mat = kind < 0.4 ? MAT('PLANK') : (kind < 0.7 ? MAT('STONE') : MAT('METAL'));
    var col = mat === MAT('PLANK') ? [172, 148, 114] : (mat === MAT('STONE') ? [186, 182, 172] : [150, 150, 152]);
    var wb = new WB(g, { x: 0, z: 0, mat: mat, col: col, uvScale: 1 });
    for (var i = 0; i < segs; i++) {
      if (rng() < 0.25) continue;                       // holes in the fence
      var a0 = i / segs * Math.PI * 2, a1 = (i + 1) / segs * Math.PI * 2;
      var ax = Math.cos(a0) * R, az = Math.sin(a0) * R, bx = Math.cos(a1) * R, bz = Math.sin(a1) * R;
      var dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
      var gy = s.groundAt((ax + bx) * 0.5, (az + bz) * 0.5);
      var sub = new WB(g, { x: ax, z: az, dx: dx / len, dz: dz / len, mat: mat, col: col, uvScale: 1 });
      var y0 = gy - 0.4;
      if (mat === MAT('METAL')) sub.box(0, y0, -0.04, len, y0 + 2.0, 0.04, { edge: 180, wear: 80 });
      else sub.box(0, y0, -0.12, len, y0 + 1.5, 0.12, { edge: 220, wear: 40 });
    }
    s.parts.push({ kind: 'fence', hp: 120, maxHp: 120, geo: g, surface: mat === MAT('METAL') ? 'metal' : 'plank',
      obb: null, solid: false, noRay: true, fence: true });
  }

  function planStreets(ctx, s, rng) {
    var E = ctx.E;
    // street lamps, power poles with wires, parked cars, crates, dumpsters, market
    var pts = s.streetPts || [];
    for (var i = 0; i < pts.length; i++) {
      var line = pts[i];
      for (var j = 0; j < line.length - 1; j += 1) {
        var a = line[j], b = line[j + 1];
        var len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        var dirx = (b[0] - a[0]) / len, dirz = (b[1] - a[1]) / len;
        var off = 0;
        while (off < len) {
          off += 14 + rng() * 16;
          if (off >= len) break;
          var px = a[0] + dirx * off - dirz * 6.5, pz = a[1] + dirz * off + dirx * 6.5;
          if (!s.groundAt) continue;
          var gy = s.groundAt(px, pz);
          var r = rng();
          var g = CGeo();
          if (r < 0.4) {
            // street lamp
            g.cylinder([px, gy, pz], [px, gy + 5.4, pz], 0.09, 0.07, 8, { mat: MAT('METAL'), col: [140, 140, 142] });
            g.cylinder([px, gy + 5.3, pz], [px + dirx * 1.1, gy + 5.6, pz + dirz * 1.1], 0.07, 0.05, 6, { mat: MAT('METAL'), col: [140, 140, 142] });
            var lamp = CGeo();
            lamp.box([px + dirx * 1.25, gy + 5.45, pz + dirz * 1.25], [0.22, 0.12, 0.22], { mat: MAT('EMISSIVE'), col: [255, 240, 205], edge: 120 });
            s.parts.push({ kind: 'prop', hp: 70, maxHp: 70, geo: g, surface: 'metal', noCollide: true, solid: false, noRay: true,
              obb: { c: [px, gy + 2.7, pz], h: [0.12, 2.7, 0.12], yaw: 0 } });
            s.parts.push({ kind: 'light', hp: 30, maxHp: 30, geo: lamp, solid: false, light: true, emissive: [px + dirx * 1.25, gy + 5.4, pz + dirz * 1.25], lampRange: 26 });
            s.lights = s.lights || [];
            s.lights.push({ x: px + dirx * 1.25, z: pz + dirz * 1.25, y: gy + 5.4 });
          } else if (r < 0.55) {
            // power pole + a span of wire
            g.cylinder([px, gy, pz], [px, gy + 7.2, pz], 0.13, 0.1, 8, { mat: MAT('TIMBER'), col: [140, 118, 90] });
            g.cylinder([px - 0.8, gy + 6.8, pz], [px + 0.8, gy + 6.8, pz], 0.05, 0.05, 6, { mat: MAT('TIMBER'), col: [140, 118, 90] });
            s.parts.push({ kind: 'prop', hp: 60, maxHp: 60, geo: g, surface: 'timber', solid: false, noRay: true,
              obb: { c: [px, gy + 3.6, pz], h: [0.16, 3.6, 0.16], yaw: 0 } });
            if (s.lastPole) {
              var wire = CGeo();
              var ww = new WB(wire, { x: s.lastPole[0], z: s.lastPole[1], dx: px - s.lastPole[0], dz: pz - s.lastPole[1], mat: MAT('METAL'), col: [60, 60, 62] });
              var span = Math.hypot(px - s.lastPole[0], pz - s.lastPole[1]);
              ww.box(0, gy + 6.6, -0.03, span, gy + 6.66, 0.03, { edge: 0, ao: 180 });
              s.parts.push({ kind: 'prop', hp: 20, maxHp: 20, geo: wire, surface: 'metal', solid: false, noRay: true, noCollide: true });
            }
            s.lastPole = [px, pz];
          } else if (r < 0.8) {
            // parked / wrecked car
            var yaw2 = Math.atan2(dirx, dirz) + (rng() < 0.5 ? 0 : Math.PI);
            var wreck = rng() < 0.35;
            var cg = CGeo();
            var wc = new WB(cg, { x: 0, z: 0, mat: MAT('PAINT'), col: [rng() * 120 + 90, rng() * 60 + 70, rng() * 60 + 60], uvScale: 1 });
            wc.box(-0.9, 0.32, -2.1, 0.9, 0.95, 2.1, { edge: 170 });
            wc.box(-0.82, 0.95, -1.25, 0.82, 1.5, 0.75, { mat: MAT('GLASS'), col: [60, 70, 80], edge: 120 });
            wc.box(-0.78, 0.6, -2.16, 0.78, 0.95, -2.1, { mat: MAT('RUST'), col: [90, 60, 40] });
            // wheels
            var ws = [[-0.95, -1.35], [0.95, -1.35], [-0.95, 1.35], [0.95, 1.35]];
            for (var w = 0; w < 4; w++) cg.cylinder([ws[w][0], 0.33, ws[w][1] - 0.22], [ws[w][0], 0.33, ws[w][1] + 0.22], 0.33, 0.33, 10, { mat: MAT('RUBBER'), col: [40, 40, 42], caps: true });
            var moved = CGeo(); moved.append(cg, [px, gy, pz], yaw2);
            s.parts.push({ kind: 'prop', hp: 260, maxHp: 260, geo: moved, surface: 'paint', wreck: wreck,
              obb: { c: [px, gy + 0.8, pz], h: [1.0, 0.8, 2.2], yaw: yaw2 }, solid: true, cover: true, low: true });
          } else {
            // crate / barrel cluster in the gutter
            var pxx = px + (rng() - 0.5) * 2, pzz = pz + (rng() - 0.5) * 2;
            var gy2 = s.groundAt(pxx, pzz);
            var cr = CGeo();
            if (rng() < 0.5) {
              var cs2 = 0.4 + rng() * 0.3;
              cr.box([pxx, gy2 + cs2, pzz], [cs2, cs2, cs2], { mat: MAT('PLANK'), col: [170, 144, 112] });
            } else {
              cr.cylinder([pxx, gy2, pzz], [pxx, gy2 + 0.88, pzz], 0.3, 0.3, 10, { mat: rng() < 0.5 ? MAT('RUST') : MAT('METAL'), col: [110, 120, 90], caps: true });
            }
            s.parts.push({ kind: 'prop', hp: 55, maxHp: 55, geo: cr, surface: 'plank',
              obb: { c: [pxx, gy2 + 0.45, pzz], h: [0.45, 0.45, 0.45], yaw: 0 }, solid: true, cover: true, low: true });
          }
        }
      }
    }
    void E;
  }

  function buildSpawns(s, rng) {
    s.patrol = [];
    var pts = s.streetPts || [];
    for (var i = 0; i < pts.length; i++) {
      var line = pts[i];
      for (var j = 0; j < line.length; j += 1) {
        if (rng() < 0.5) s.patrol.push([line[j][0], line[j][1]]);
      }
    }
    if (!s.patrol.length) {
      for (var k = 0; k < 6; k++) {
        var a = k / 6 * Math.PI * 2;
        s.patrol.push([Math.cos(a) * s.radius * 0.5, Math.sin(a) * s.radius * 0.5]);
      }
    }
  }

  /** Cover points: stand here, be protected from that side. */
  function extractCover(s) {
    var out = [];
    for (var i = 0; i < s.parts.length; i++) {
      var p = s.parts[i];
      if (!p.obb || !p.solid) continue;
      if (p.kind === 'floor' || p.kind === 'stairs' || p.kind === 'road') continue;
      var h = p.obb.h;
      var top = p.obb.c[1] + h[1];
      var isLow = top < 1.9;
      if (!p.cover && !isLow) continue;
      var cs = Math.cos(p.obb.yaw || 0), sn = Math.sin(p.obb.yaw || 0);
      // sample points around the box on the two long sides
      var long = h[0] >= h[2] ? 0 : 1;
      var step = 2.4;
      var n = Math.max(1, Math.floor((long === 0 ? h[0] : h[2]) * 2 / step));
      for (var side = -1; side <= 1; side += 2) {
        for (var k = 0; k <= n; k++) {
          var t = -1 + 2 * k / Math.max(1, n);
          var lx = long === 0 ? t * h[0] : side * (h[0] + 0.65);
          var lz = long === 0 ? side * (h[2] + 0.65) : t * h[2];
          var wx = cs * lx - sn * lz + p.obb.c[0];
          var wz = sn * lx + cs * lz + p.obb.c[2];
          var nxp = long === 0 ? 0 : side, nzp = long === 0 ? side : 0;
          var nw = [cs * nxp - sn * nzp, sn * nxp + cs * nzp];
          out.push({ x: wx, z: wz, y: top, nx: nw[0], nz: nw[1], low: isLow ? 1 : 0, part: p.id });
        }
      }
    }
    // dedupe / cap
    var capped = [];
    for (var c = 0; c < out.length && capped.length < 260; c++) {
      var pt = out[c];
      var dup = false;
      for (var d = Math.max(0, capped.length - 24); d < capped.length; d++) {
        if (Math.hypot(capped[d].x - pt.x, capped[d].z - pt.z) < 1.6) { dup = true; break; }
      }
      if (!dup) capped.push(pt);
    }
    return capped;
  }

  /* ==========================================================================
   * Mesh building
   * ======================================================================== */
  P.buildMesh = function (s) {
    var E = this.E, gl = this.gl;
    this.ensurePlanned(s);
    var full = CGeo(), far = CGeo();
    var any = false;
    for (var i = 0; i < s.parts.length; i++) {
      var p = s.parts[i];
      if (p.destroyed || !p.geo || !p.geo.count) continue;
      full.append(p.geo, [0, 0, 0]);
      if (p.kind !== 'decor' && p.kind !== 'light' && !p.noFar) far.append(p.geo, [0, 0, 0]);
      any = true;
    }
    if (s.mesh) { gl.deleteVertexArray(s.mesh.vao); s.mesh = null; }
    if (s.lodMesh) { gl.deleteVertexArray(s.lodMesh.vao); s.lodMesh = null; }
    if (any) {
      s.mesh = cm().upload(this.G, full);
      s.lodMesh = far.count > 8 ? cm().upload(this.G, far) : null;
    }
    s.built = true; s.dirty = false;
    this.stats.tris = (this.stats.tris || 0) + (s.mesh ? s.mesh.tris : 0);
  };

  P.rebuildColliders = function () {
    var E = this.E;
    this.colliders.length = 0;
    this.grid.clear();
    for (var n = 0; n < this.list.length; n++) {
      var s = this.list[n];
      for (var i = 0; i < s.parts.length; i++) {
        var p = s.parts[i];
        if (!p.obb || p.destroyed || p.noCollide || !p.solid) continue;
        var obb = { c: [p.obb.c[0] + s.x, p.obb.c[1] + s.y, p.obb.c[2] + s.z], h: p.obb.h, yaw: p.obb.yaw || 0 };
        var rec = { obb: obb, part: p, s: s, walk: p.walk, low: !!p.low, stairs: !!p.stairs };
        var idx = this.colliders.push(rec) - 1;
        // a long wall spans several 32 m cells: register it in every one it overlaps,
        // otherwise a query near its end would not find it
        var rx = Math.abs(obb.h[0] * Math.cos(obb.yaw)) + Math.abs(obb.h[2] * Math.sin(obb.yaw));
        var rz = Math.abs(obb.h[0] * Math.sin(obb.yaw)) + Math.abs(obb.h[2] * Math.cos(obb.yaw));
        var ci0 = Math.floor((obb.c[0] - rx) / 32), ci1 = Math.floor((obb.c[0] + rx) / 32);
        var cj0 = Math.floor((obb.c[2] - rz) / 32), cj1 = Math.floor((obb.c[2] + rz) / 32);
        if ((ci1 - ci0) * (cj1 - cj0) > 64) { ci0 = ci1 = Math.floor(obb.c[0] / 32); cj0 = cj1 = Math.floor(obb.c[2] / 32); }
        for (var gi = ci0; gi <= ci1; gi++) for (var gj = cj0; gj <= cj1; gj++) {
          var key = gi + ':' + gj;
          var cell = this.grid.get(key);
          if (!cell) { cell = []; this.grid.set(key, cell); }
          cell.push(idx);
        }
      }
    }
    this.stats.parts = this.colliders.length;
  };

  /* ==========================================================================
   * Streaming & drawing
   * ======================================================================== */
  var _tmpV = [0, 0, 0];
  P.update = function (frame) {
    var E = this.E, cam = frame.cam.world;
    // stream settlements in range
    var ci0 = Math.floor((cam[0] - VIEW) / CELL), ci1 = Math.floor((cam[0] + VIEW) / CELL);
    var cj0 = Math.floor((cam[2] - VIEW) / CELL), cj1 = Math.floor((cam[2] + VIEW) / CELL);
    var want = [];
    for (var ci = ci0; ci <= ci1; ci++) for (var cj = cj0; cj <= cj1; cj++) {
      var s = this.settlementAt(ci, cj);
      if (!s) continue;
      if (!s.planned && Math.hypot(s.x - cam[0], s.z - cam[2]) > VIEW) continue;
      if (!s.built) { if (this._builtThisFrame !== frame.index && this._buildTimer <= 0) { this.buildMesh(s); this._builtThisFrame = frame.index; } else want.push(s); continue; }
      s._dist = Math.hypot(s.x - cam[0], s.z - cam[2]);
      if (s._dist < VIEW + s.radius) want.push(s);
    }
    want.sort(function (a, b) { return a._dist - b._dist; });
    var changed = want.length !== this.list.length;
    if (!changed) for (var k = 0; k < want.length; k++) if (want[k] !== this.list[k]) { changed = true; break; }
    this.list = want;
    if (changed) this.rebuildColliders();
    // lazily build one settlement per frame to avoid a hitch
    this._buildTimer -= frame.dt;
    if (this._buildTimer <= 0) {
      for (var b = 0; b < this.list.length; b++) if (!this.list[b].built) { this.buildMesh(this.list[b]); this._buildTimer = 0.06; break; }
    }
    // rebuild damaged settlements (at most one per 0.2 s)
    for (var r = 0; r < this.list.length; r++) {
      var st = this.list[r];
      if (st.dirty && st.built) {
        this._rebuildT = (this._rebuildT || 0) - frame.dt;
        if (this._rebuildT <= 0) { this.buildMesh(st); this.rebuildColliders(); this._rebuildT = 0.2; }
        break;
      }
    }
    // structural collapse queue
    for (var c = 0; c < this.list.length; c++) this._stepCollapse(this.list[c], frame.dt);
    this.stats.settlements = this.list.length;
    this._updateLights(frame);
  };

  P._stepCollapse = function (s, dt) {
    if (!s.collapseQueue.length) return;
    for (var i = s.collapseQueue.length - 1; i >= 0; i--) {
      var q = s.collapseQueue[i];
      q.t -= dt;
      if (q.t <= 0) {
        s.collapseQueue.splice(i, 1);
        this.destroyPart(s, q.part, { silent: false, collapse: true });
      }
    }
  };

  P._updateLights = function (frame) {
    var E = this.E, cam = frame.cam.world, o = frame.origin, night = 1 - frame.env.dayFactor;
    this.lights.length = 0;
    if (night < 0.35) return;
    var n = 0;
    for (var i = 0; i < this.list.length && n < 6; i++) {
      var s = this.list[i];
      if (s._dist > 260) continue;
      var lamps = s.lights;
      if (!lamps) continue;
      for (var l = 0; l < lamps.length && n < 6; l++) {
        var L = lamps[l];
        if (L.dead) continue;
        var d = Math.hypot(L.x - cam[0], L.z - cam[2]);
        if (d > 160) continue;
        var flick = 0.9 + 0.1 * Math.sin(frame.time * 13 + l);
        this.lights.push({ pos: [s.x + L.x - o[0], s.y + L.y + 0.2, s.z + L.z - o[1]], radius: 26, color: [3.4 * flick * night, 2.8 * flick * night, 1.7 * night] });
        n++;
      }
    }
  };

  /** G-buffer / shadow / motion draws. Called from the engine's drawExtras hooks. */
  P.draw = function (frame, shadow, vp) {
    var list = this.list;
    if (!list.length) return;
    var gl = this.gl, R = this.E.renderer, o = frame.origin, P2 = frame.cam.planes;
    var prog = this.prog, p = prog.use();
    var albedo = R.tex.matAlbedo;
    p.tex('uAlbedoH', 0, albedo, gl.TEXTURE_2D_ARRAY);
    if (this.quality >= 2) p.tex('uNormalR', 1, R.tex.matNormal, gl.TEXTURE_2D_ARRAY);
    else p.tex('uNormalR', 1, R.tex.black, gl.TEXTURE_2D_ARRAY);
    var m4 = this._m || (this._m = M.mat4());
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var mesh = (s._dist > LOD_FAR && s.lodMesh) ? s.lodMesh : s.mesh;
      if (!mesh) continue;
      if (s._dist > VIEW + s.radius + 200) continue;
      if (!M.sphereInFrustum(P2, s.x - o[0], s.y + (s.mesh ? s.mesh.height * 0.5 : 0), s.z - o[1], s.radius, 0)) continue;
      var wet = frame.env.wetness;
      p.m4('uModel', idMat(m4, s.x - o[0], s.y, s.z - o[1]));
      p.f('uWet', wet).f('uSnow', frame.env.snowCover).f('uNight', 1 - frame.env.dayFactor)
        .v3('uSun', frame.env.lightDir[0], frame.env.lightDir[1], frame.env.lightDir[2])
        .v3('uTint', 1, 1, 1);
      gl.bindVertexArray(mesh.vao);
      gl.drawElements(gl.TRIANGLES, mesh.count, mesh.indexType, 0);
      R.G.stats.drawCalls++; R.G.stats.triangles += mesh.tris;
    }
    gl.bindVertexArray(null);
    void prog;
  };
  function idMat(m, x, y, z) {
    M.identity(m); m[12] = x; m[13] = y; m[14] = z;
    return m;
  }
  P.drawShadow = function (frame, vp) {
    var gl = this.gl, E = this.E, sh = E.renderer.shadows, list = this.list;
    var p = this.progShadow.use();
    p.m4('uShadowVP', vp).i('uShadowPass', 1);
    var m4 = this._ms || (this._ms = M.mat4());
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var mesh = (s._dist > LOD_FAR && s.lodMesh) ? s.lodMesh : s.mesh;
      if (!mesh || s._dist > 420) continue;
      p.m4('uModel', idMat(m4, s.x - frame.origin[0], s.y, s.z - frame.origin[1]));
      gl.bindVertexArray(mesh.vao);
      gl.drawElements(gl.TRIANGLES, mesh.count, mesh.indexType, 0);
      E.renderer.G.stats.drawCalls++;
    }
    gl.bindVertexArray(null);
    void sh;
  };
  P.drawMotion = function () { /* settlements are static: nothing to write */ };

  /* ==========================================================================
   * Ray queries, collision, floors
   * ======================================================================== */
  P._candidates = function (x, z, r) {
    var out = [], seen = {};
    var i0 = Math.floor((x - r) / 32), i1 = Math.floor((x + r) / 32);
    var j0 = Math.floor((z - r) / 32), j1 = Math.floor((z + r) / 32);
    for (var i = i0; i <= i1; i++) for (var j = j0; j <= j1; j++) {
      var cell = this.grid.get(i + ':' + j);
      if (!cell) continue;
      for (var k = 0; k < cell.length; k++) {
        var id = cell[k];
        if (seen[id]) continue;
        seen[id] = 1;
        out.push(this.colliders[id]);
      }
    }
    return out;
  };

  /** Ray provider for Combat.cast: walls, floors, roofs, props. */
  P.raycast = function (o, d, maxT, filter) {
    var span = Math.min(maxT, 600);
    var cx = o[0] + d[0] * span * 0.5, cz = o[2] + d[2] * span * 0.5;
    var cand = this._candidates(cx, cz, span * 0.5 + 40);
    var best = null;
    for (var i = 0; i < cand.length; i++) {
      var c = cand[i];
      var p = c.part;
      if (!p.obb || p.destroyed) continue;
      if (p.kind === 'floor' && d[1] > -0.02 && d[1] < 0.02) continue;   // ignore grazing shots on floors
      var h = TERRA.game.Combat.rayOBB(o, d, c.obb);
      if (!h || h.t > maxT) continue;
      if (!best || h.t < best.t) {
        best = { t: h.t, n: h.n, type: 'building', ref: c.s, part: p, surface: p.surface || 'concrete', obb: c.obb };
      }
    }
    return best;
  };

  /** Strongest surface below (x, z) that the body at height `y` could stand on. */
  P.floorHeight = function (x, z, y, step) {
    var cand = this._candidates(x, z, 3.2);
    var best = -1e9;
    step = step === undefined ? 0.62 : step;
    for (var i = 0; i < cand.length; i++) {
      var c = cand[i], p = c.part;
      if (!p.walk && !p.top) continue;
      if (p.destroyed) continue;
      var ob = c.obb;
      // point in box (xz), with a small margin
      var cs = Math.cos(-ob.yaw), sn = Math.sin(-ob.yaw);
      var lx = cs * (x - ob.c[0]) - sn * (z - ob.c[2]);
      var lz = sn * (x - ob.c[0]) + cs * (z - ob.c[2]);
      if (Math.abs(lx) > ob.h[0] + 0.25 || Math.abs(lz) > ob.h[2] + 0.25) continue;
      var top = ob.c[1] + ob.h[1];
      if (top <= y + step && top > best) best = top;
    }
    return best;
  };

  /** Push a vertical capsule out of walls. Returns [dx, dz] or null. */
  P.resolveCircle = function (x, z, y, r, height) {
    var cand = this._candidates(x, z, r + 3.5);
    var px = 0, pz = 0, hitAny = false;
    height = height || 1.7;
    for (var i = 0; i < cand.length; i++) {
      var c = cand[i], p = c.part;
      if (p.destroyed || p.low) continue;
      if (p.stairs) continue;                           // walkable ramp, not a wall to be pushed off
      var ob = c.obb;
      var top = ob.c[1] + ob.h[1], bot = ob.c[1] - ob.h[1];
      if (top <= y + 0.55) continue;                    // it's a step, not a wall
      if (bot >= y + height) continue;                  // above the body
      if (p.gaps && p.gaps.length && p.wallRef) {
        // the part's OBB spans doorways too: let the body through an opening it fits
        // (openings are measured from the OBB centre, along/across the wall)
        var wr = p.wallRef, lx0 = x - ob.c[0], lz0 = z - ob.c[2];
        var wu = lx0 * wr.ux + lz0 * wr.uz, wd = lx0 * wr.nx + lz0 * wr.nz;
        if (Math.abs(wd) < wr.half + 0.55) {
          var ly = y - c.s.y;                     // openings are authored in settlement-local y
          var through = false;
          for (var gi = 0; gi < p.gaps.length; gi += 4) {
            var gy0 = p.gaps[gi + 1], gy1 = p.gaps[gi + 3];
            if (wu > p.gaps[gi] - 0.12 && wu < p.gaps[gi + 2] + 0.12 && !(ly + height < gy0 || ly > gy1)) { through = true; break; }
          }
          if (through) continue;
        }
      }
      var cs = Math.cos(-ob.yaw), sn = Math.sin(-ob.yaw);
      var lx = cs * (x - ob.c[0]) - sn * (z - ob.c[2]);
      var lz = sn * (x - ob.c[0]) + cs * (z - ob.c[2]);
      var dx = Math.max(-ob.h[0], Math.min(lx, ob.h[0]));
      var dz = Math.max(-ob.h[2], Math.min(lz, ob.h[2]));
      var ddx = lx - dx, ddz = lz - dz;
      var dist = Math.hypot(ddx, ddz);
      if (dist >= r) continue;
      var nlx, nlz, pen;
      if (dist > 1e-5) { nlx = ddx / dist; nlz = ddz / dist; pen = r - dist; }
      else {
        // inside the box: push out along the smallest axis
        var ox = ob.h[0] - Math.abs(lx), oz = ob.h[2] - Math.abs(lz);
        if (ox < oz) { nlx = lx < 0 ? -1 : 1; nlz = 0; pen = ox + r; }
        else { nlx = 0; nlz = lz < 0 ? -1 : 1; pen = oz + r; }
      }
      var cs2 = Math.cos(ob.yaw), sn2 = Math.sin(ob.yaw);
      px += (cs2 * nlx - sn2 * nlz) * pen;
      pz += (sn2 * nlx + cs2 * nlz) * pen;
      hitAny = true;
    }
    return hitAny ? [px, pz] : null;
  };

  /* ==========================================================================
   * Damage & destruction
   * ======================================================================== */
  P.damage = function (s, part, dmg, hit, opts) {
    opts = opts || {};
    if (!part || part.destroyed) return { blocked: true };
    if (part.hp > 9000) return { blocked: true };       // roads etc. are indestructible
    if (opts.explosive) dmg *= 1.6;
    var matName = part.surface || 'concrete';
    if (!opts.explosive && opts.dmgType === 'bullet') {
      // bullets mostly chip; only heavy or many hits break a wall
      dmg *= 0.35;
    }
    part.hp -= dmg;
    this.stats.destroyed = this.stats.destroyed;
    if (part.hp <= 0) {
      this.destroyPart(s, part, opts);
      return { killed: true };
    }
    // cosmetic damage accumulates (rebuild is expensive, so do it rarely)
    part.dmgAcc = (part.dmgAcc || 0) + dmg;
    if (part.dmgAcc > (part.maxHp || 100) * 0.45 && !part.dirtyWear) {
      part.dirtyWear = true;
      if (!opts.noWearFx) {
        var fx = this.E.effects;
        if (fx && hit && hit.p) fx.dust(hit.p, 0.5, [0.55, 0.5, 0.45]);
        this._spawnChips(hit, part, 3);
      }
    }
    return { killed: false };
  };

  P._spawnChips = function (hit, part, n) {
    var fx = this.E.effects;
    if (!fx || !hit || !hit.p) return;
    var col = part.surface === 'plank' ? [0.5, 0.36, 0.2] : (part.surface === 'metal' ? [0.5, 0.5, 0.52] : [0.45, 0.3, 0.24]);
    var out = hit.n ? [hit.n[0], hit.n[1], hit.n[2]] : [0, 1, 0];
    fx.chips(hit.p, out, n, col);
  };

  /** Break a part out of the building; unsupported parts above fall soon after. */
  P.destroyPart = function (s, part, opts) {
    opts = opts || {};
    if (part.destroyed) return;
    if (!part.obb) { part.destroyed = true; s.dirty = true; return; }
    part.destroyed = true;
    s.destroyedCount++;
    s.dirty = true;
    var E = this.E, fx = E.effects;
    var cx = s.x + part.obb.c[0], cy = part.obb.c[1], cz = s.z + part.obb.c[2];
    var vol = part.obb.h[0] * part.obb.h[1] * part.obb.h[2];
    if (fx && !opts.silent) {
      var n = U.clamp(Math.round(6 + vol * 26), 6, 40);
      var col = part.surface === 'plank' ? [0.42, 0.3, 0.18] : (part.surface === 'metal' ? [0.45, 0.45, 0.46] : (part.surface === 'glass' ? [0.7, 0.78, 0.85] : [0.5, 0.46, 0.42]));
      for (var i = 0; i < n; i++) {
        var a = Math.random() * Math.PI * 2, e = 0.3 + Math.random() * 1.0;
        var sp = 2 + Math.random() * 5;
        fx.emit(TERRA.game.Effects.K.DEBRIS, [cx + (Math.random() - 0.5) * part.obb.h[0] * 2, cy + (Math.random() - 0.5) * part.obb.h[1] * 2, cz + (Math.random() - 0.5) * part.obb.h[2] * 2],
          [Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp + 1.5, Math.sin(a) * Math.cos(e) * sp],
          2 + Math.random() * 2.5, 0.05 + Math.random() * 0.13, 0, col, 1, Math.random() * 6);
      }
      for (var d = 0; d < Math.min(16, 4 + vol * 10); d++) {
        fx.emit(TERRA.game.Effects.K.DUST, [cx + (Math.random() - 0.5) * part.obb.h[0] * 2.4, cy, cz + (Math.random() - 0.5) * part.obb.h[2] * 2.4],
          [(Math.random() - 0.5) * 2.4, 0.6 + Math.random() * 1.4, (Math.random() - 0.5) * 2.4],
          1.6 + Math.random() * 2.4, 0.35 + Math.random() * 0.5, 1.4, [0.62, 0.58, 0.52], 0.5);
      }
      this.sfxDebris(cx, cy, cz, vol);
    }
    // detached neighbours: parts sitting on or next to this one may collapse
    if (part.kind === 'wall' || part.kind === 'floor' || part.kind === 'roof') this._scheduleCollapse(s, part, opts);
    TERRA.events.emit('buildingDamage', { s: s, part: part });
  };

  P._scheduleCollapse = function (s, part, opts) {
    var top = part.obb.c[1] + part.obb.h[1];
    for (var i = 0; i < s.parts.length; i++) {
      var q = s.parts[i];
      if (q === part || q.destroyed || !q.obb) continue;
      if (q.kind !== 'wall' && q.kind !== 'floor' && q.kind !== 'roof' && q.kind !== 'stairs') continue;
      var qTop = q.obb.c[1] + q.obb.h[1], qBot = q.obb.c[1] - q.obb.h[1];
      // directly above, or sharing a corner within a metre
      var above = qBot >= top - 0.55 && qBot < top + 3.4;
      var near = Math.hypot(q.obb.c[0] - part.obb.c[0], q.obb.c[2] - part.obb.c[2]) < (q.obb.h[0] + q.obb.h[2] + part.obb.h[0] + part.obb.h[2]) * 1.05;
      if (!touching(q.obb, part.obb)) continue;
      if (!above || !near) continue;
      if (q.collapseT) continue;
      q.collapseT = 0.4 + Math.random() * 2.1;
      s.collapseQueue.push({ part: q, t: q.collapseT });
      if (s.collapseQueue.length > 24) s.collapseQueue.shift();
    }
    void opts;
  };
  function touching(a, b) {
    var dx = Math.abs(a.c[0] - b.c[0]) - (a.h[0] + b.h[0]);
    var dy = Math.abs(a.c[1] - b.c[1]) - (a.h[1] + b.h[1]);
    var dz = Math.abs(a.c[2] - b.c[2]) - (a.h[2] + b.h[2]);
    return dx < 0.35 && dy < 3.4 && dz < 0.35;
  }

  /** Explosion damage: nearest parts take the hit, roofs and walls cave in. */
  P.blast = function (p, power, R, opts) {
    var E = this.E;
    for (var n = 0; n < this.list.length; n++) {
      var s = this.list[n];
      if (Math.hypot(s.x + s.radius - p[0], s.z + s.radius - p[2]) > R + s.radius * 2 + 60) {
        if (Math.hypot(s.x - p[0], s.z - p[2]) > R + s.radius + 30) continue;
      }
      for (var i = 0; i < s.parts.length; i++) {
        var part = s.parts[i];
        if (part.destroyed || !part.obb || part.kind === 'road' || part.kind === 'decor' || part.kind === 'light') continue;
        var ob = part.obb;
        var wx = s.x + ob.c[0], wy = ob.c[1], wz = s.z + ob.c[2];
        // distance to the box surface
        var d = Math.hypot(Math.max(0, Math.abs(p[0] - wx) - ob.h[0]), Math.max(0, Math.abs(p[1] - wy) - ob.h[1]), Math.max(0, Math.abs(p[2] - wz) - ob.h[2]));
        if (d > R) continue;
        var falloff = Math.pow(U.clamp01(1 - d / R), 1.5);
        var dmg = 90 * power * falloff;
        // keep the blast from removing the whole town in one hit
        if (part.maxHp && dmg > part.maxHp * 1.6) dmg = part.maxHp * 1.6;
        if (dmg < 4) continue;
        this.damage(s, part, dmg, { p: [p[0], p[1], p[2]], n: null }, { explosive: true, source: opts && opts.source, noWearFx: true });
      }
    }
  };
  /** Scorch decals on nearby walls and the ground. */
  P.craterScorch = function (p, R) {
    for (var n = 0; n < this.list.length; n++) {
      var s = this.list[n];
      if (Math.hypot(s.x - p[0], s.z - p[2]) > s.radius + R + 40) continue;
      for (var i = 0; i < s.parts.length; i++) {
        var part = s.parts[i];
        if (part.destroyed || !part.obb) continue;
        var ob = part.obb;
        var wx = s.x + ob.c[0], wy = ob.c[1], wz = s.z + ob.c[2];
        var d = Math.hypot(Math.max(0, Math.abs(p[0] - wx) - ob.h[0]), Math.max(0, Math.abs(p[1] - wy) - ob.h[1]), Math.max(0, Math.abs(p[2] - wz) - ob.h[2]));
        if (d > R * 0.9) continue;
        // project the blast centre onto the box surface for the decal position/normal
        var lx = p[0] - wx, ly = p[1] - wy, lz = p[2] - wz;
        var nx = U.clamp(lx / ob.h[0], -1, 1), ny = U.clamp(ly / ob.h[1], -1, 1), nz = U.clamp(lz / ob.h[2], -1, 1);
        var axisN = [Math.abs(nx), Math.abs(ny), Math.abs(nz)], ax = axisN[0] > axisN[1] ? (axisN[0] > axisN[2] ? 0 : 2) : (axisN[1] > axisN[2] ? 1 : 2);
        var nrm = ax === 0 ? [nx < 0 ? -1 : 1, 0, 0] : (ax === 1 ? [0, ny < 0 ? -1 : 1, 0] : [0, 0, nz < 0 ? -1 : 1]);
        var pos = [wx + (ax === 0 ? nrm[0] * ob.h[0] : lx), wy + (ax === 1 ? nrm[1] * ob.h[1] : ly), wz + (ax === 2 ? nrm[2] * ob.h[2] : lz)];
        if (Math.abs(pos[1] - wy) > ob.h[1] || Math.abs(pos[2] - wz) > ob.h[2] || Math.abs(pos[0] - wx) > ob.h[0]) continue;
        var C0 = cc(); if (C0) C0.decals.add(pos, nrm, 2, U.clamp(R * 0.5, 0.6, 3.4), 0.6);
        if (Math.random() < 0.35) break;      // a couple per building is enough
      }
    }
  };

  P.sfxDebris = function (x, y, z, vol) {
    var C = cc();
    if (C) C.sfx(vol > 1.5 ? 'crack' : 'dirt', [x, y, z], 0.5);
  };

  /** Ignite / burn: burning parts smoke and slowly lose health. */
  P.updateFires = function (dt) {
    var E = this.E, fx = E.effects;
    for (var n = 0; n < this.list.length; n++) {
      var s = this.list[n];
      for (var i = 0; i < s.parts.length; i++) {
        var p = s.parts[i];
        if (!p.fire || p.destroyed) continue;
        p.fireT = (p.fireT || 0) + dt;
        if (fx && Math.random() < 0.5) {
          var px = s.x + p.obb.c[0] + (Math.random() - 0.5) * p.obb.h[0] * 2;
          var py = p.obb.c[1] + p.obb.h[1] * 0.6;
          var pz = s.z + p.obb.c[2] + (Math.random() - 0.5) * p.obb.h[2] * 2;
          fx.emit(TERRA.game.Effects.K.FIRE, [px, py, pz], [0, 1.6 + Math.random(), 0], 0.5 + Math.random() * 0.5, 0.5 + Math.random() * 0.5, 1.2, [1, 0.55, 0.2], 0.7);
          if (Math.random() < 0.4) fx.emit(TERRA.game.Effects.K.SMOKE, [px, py + 1, pz], [(Math.random() - 0.5) * 1.2, 2.4, (Math.random() - 0.5) * 1.2], 5, 1.2, 1.6, [0.18, 0.17, 0.16], 0.5);
        }
        if (p.fireT > 3 && p.maxHp < 9000) {
          p.fireT = 0;
          this.damage(s, p, p.maxHp * 0.22, { p: [s.x + p.obb.c[0], p.obb.c[1], s.z + p.obb.c[2]], n: null }, { explosive: true, noWearFx: true });
        }
      }
    }
  };

  /** Nearest cover point that protects from `threat` direction. */
  P.coverNear = function (x, z, radius, threat, maxDist) {
    var best = null, bestScore = -1e9;
    for (var n = 0; n < this.list.length; n++) {
      var s = this.list[n];
      if (Math.hypot(s.x - x, s.z - z) > s.radius + radius) continue;
      var cv = s.cover;
      for (var i = 0; i < cv.length; i++) {
        var c = cv[i];
        var wx = s.x + c.x, wz = s.z + c.z;
        var d = Math.hypot(wx - x, wz - z);
        if (d > radius) continue;
        var dx = (threat[0] - (wx)) , dz = (threat[1] - (wz));
        var dl = Math.hypot(dx, dz) || 1;
        var align = (dx / dl) * c.nx + (dz / dl) * c.nz;
        if (align < 0.25) continue;
        if (maxDist !== undefined && dl > maxDist) continue;
        var wy = c.y + s.y;
        var score = align * 3 - d * 0.12 + (threat[2] !== undefined ? (wy - threat[2]) * 0.1 : 0);
        if (score > bestScore) { bestScore = score; best = { x: wx, y: wy, z: wz, nx: c.nx, nz: c.nz, low: c.low, s: s, align: align }; }
      }
    }
    return best;
  };

  /* ==========================================================================
   * Persistence
   * ======================================================================== */
  P.serialize = function () {
    var out = {};
    this.settlements.forEach(function (s, key) {
      if (!s) return;
      var dead = [];
      for (var i = 0; i < s.parts.length; i++) if (s.parts[i].destroyed) dead.push(i);
      if (dead.length) out[key] = dead;
    });
    return out;
  };
  P.deserialize = function (data) {
    if (!data) return;
    var self = this;
    // settlements are rebuilt lazily; the damage list is applied when one is planned
    this._pendingDamage = data;
    Object.keys(data).forEach(function (key) {
      var s = self.settlements.get(key);
      if (s) self._applyDamage(s, data[key]);
    });
  };
  P._applyDamage = function (s, dead) {
    for (var i = 0; i < dead.length; i++) { var p = s.parts[dead[i]]; if (p) p.destroyed = true; }
    s.dirty = true;
  };

  TERRA.world.Buildings = Buildings;
})();
