/* =============================================================================
 * TERRA INFINITA — procedural vehicle models (boats, aircraft, bikes) + tools
 * -----------------------------------------------------------------------------
 * Meshes are built from lofted hull/fuselage sections, extruded airfoils, tubes
 * and boxes with per-vertex material ids (paint, metal, chrome, glass, rubber,
 * wood, plastic, lamps…). Every model is built twice: full detail and a reduced
 * LOD (small parts dropped, fewer segments) used beyond ~60 m. Moving parts
 * (wheels, forks, propellers, outboards, rudders) are separate meshes posed
 * every frame around their pivots.
 * Local axes: +x right, +y up, −z forward (same as the camera / player yaw).
 * ========================================================================== */
(function () {
  'use strict';
  var U = TERRA.util;

  var MAT = { PAINT: 0, METAL: 1, CHROME: 2, GLASS: 3, RUBBER: 4, WOOD: 5, PLASTIC: 6, LAMP: 7, LAMP_RED: 8, CANVAS: 9, ANTIFOUL: 10, DARK: 11, LAMP_GREEN: 12, SKIN: 13, CLOTH: 14, STEEL: 15, ENDGRAIN: 16, BARK: 17 };

  function norm(v) { var l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function scl(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }

  /** Mesh builder: 10 floats per vertex (pos, normal, colour, material). */
  function MB(lod) { this.v = []; this.i = []; this.lod = lod || 0; }
  MB.prototype.vert = function (p, n, c, m) { this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], c[0], c[1], c[2], m); return this.v.length / 10 - 1; };
  MB.prototype.tri = function (a, b, c) { this.i.push(a, b, c); };
  MB.prototype.quad = function (a, b, c, d) { this.i.push(a, b, c, a, c, d); };
  /** Flat-shaded quad from 4 points (counter-clockwise seen from outside). */
  MB.prototype.face = function (p0, p1, p2, p3, c, m) {
    var n = norm(cross(sub(p1, p0), sub(p3, p0)));
    var a = this.vert(p0, n, c, m), b = this.vert(p1, n, c, m), cc = this.vert(p2, n, c, m), d = this.vert(p3, n, c, m);
    this.quad(a, b, cc, d);
  };
  MB.prototype.box = function (ctr, h, c, m) {
    var x0 = ctr[0] - h[0], x1 = ctr[0] + h[0], y0 = ctr[1] - h[1], y1 = ctr[1] + h[1], z0 = ctr[2] - h[2], z1 = ctr[2] + h[2];
    this.face([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], c, m);
    this.face([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], c, m);
    this.face([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], c, m);
    this.face([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], c, m);
    this.face([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], c, m);
    this.face([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], c, m);
  };
  /** Tube between two points (smooth sides, optional caps). */
  MB.prototype.tube = function (p0, p1, r0, r1, segs, c, m, caps) {
    if (this.lod) segs = Math.max(4, Math.round(segs * 0.55));
    var d = norm(sub(p1, p0)), up = Math.abs(d[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
    var s = norm(cross(d, up)), t = cross(s, d);
    var base = this.v.length / 10;
    for (var k = 0; k <= segs; k++) {
      var a = k / segs * Math.PI * 2, n = add(scl(s, Math.cos(a)), scl(t, Math.sin(a)));
      this.vert(add(p0, scl(n, r0)), n, c, m); this.vert(add(p1, scl(n, r1)), n, c, m);
    }
    for (k = 0; k < segs; k++) { var i0 = base + k * 2; this.quad(i0, i0 + 2, i0 + 3, i0 + 1); }
    if (caps) {
      var c0 = this.vert(p0, scl(d, -1), c, m), c1 = this.vert(p1, d, c, m);
      for (k = 0; k < segs; k++) {
        var a0 = k / segs * Math.PI * 2, a1 = (k + 1) / segs * Math.PI * 2;
        var q0 = add(scl(s, Math.cos(a0)), scl(t, Math.sin(a0))), q1 = add(scl(s, Math.cos(a1)), scl(t, Math.sin(a1)));
        this.tri(c0, this.vert(add(p0, scl(q1, r0)), scl(d, -1), c, m), this.vert(add(p0, scl(q0, r0)), scl(d, -1), c, m));
        this.tri(c1, this.vert(add(p1, scl(q0, r1)), d, c, m), this.vert(add(p1, scl(q1, r1)), d, c, m));
      }
    }
  };
  MB.prototype.sphere = function (ctr, r, c, m, segs) {
    segs = this.lod ? 6 : (segs || 10);
    var base = this.v.length / 10, rows = segs, cols = segs * 2;
    for (var j = 0; j <= rows; j++) for (var i = 0; i <= cols; i++) {
      var th = j / rows * Math.PI, ph = i / cols * Math.PI * 2;
      var n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
      this.vert(add(ctr, [n[0] * r[0], n[1] * r[1], n[2] * r[2]]), norm([n[0] / r[0], n[1] / r[1], n[2] / r[2]]), c, m);
    }
    for (j = 0; j < rows; j++) for (i = 0; i < cols; i++) { var a = base + j * (cols + 1) + i; this.quad(a, a + cols + 1, a + cols + 2, a + 1); }
  };
  /** Loft through closed sections (each an array of points); smooth normals. */
  MB.prototype.loft = function (sections, c, m, capStart, capEnd) {
    var ns = sections.length, np = sections[0].length, base = this.v.length / 10;
    var nrm = [];
    for (var s = 0; s < ns; s++) for (var p = 0; p < np; p++) {
      var sp = sections[Math.max(0, s - 1)][p], sn = sections[Math.min(ns - 1, s + 1)][p];
      var pp = sections[s][(p + np - 1) % np], pn = sections[s][(p + 1) % np];
      var along = sub(sn, sp), around = sub(pn, pp);
      nrm.push(norm(cross(around, along)));
    }
    for (s = 0; s < ns; s++) for (p = 0; p < np; p++) this.vert(sections[s][p], nrm[s * np + p], c, m);
    for (s = 0; s < ns - 1; s++) for (p = 0; p < np; p++) {
      var a = base + s * np + p, b = base + s * np + (p + 1) % np, cc = base + (s + 1) * np + (p + 1) % np, d = base + (s + 1) * np + p;
      this.quad(a, b, cc, d);
    }
    var self = this;
    function cap(sec, flip) {
      var ctr = [0, 0, 0]; sec.forEach(function (q) { ctr = add(ctr, q); }); ctr = scl(ctr, 1 / sec.length);
      var n = norm(cross(sub(sec[1], sec[0]), sub(sec[2], sec[0]))); if (flip) n = scl(n, -1);
      var ci = self.vert(ctr, n, c, m);
      for (var k = 0; k < sec.length; k++) {
        var i0 = self.vert(sec[k], n, c, m), i1 = self.vert(sec[(k + 1) % sec.length], n, c, m);
        if (flip) self.tri(ci, i1, i0); else self.tri(ci, i0, i1);
      }
    }
    if (capStart) cap(sections[0], true);
    if (capEnd) cap(sections[ns - 1], false);
  };
  /** Extruded airfoil (wing, tail) from root to tip along x (span), chord along z. */
  MB.prototype.wing = function (root, tip, chordR, chordT, thick, c, m, vertical) {
    var n = this.lod ? 6 : 10, secs = [];
    function airfoil(ctr, chord) {
      var pts = [];
      for (var k = 0; k < n * 2; k++) {
        var t = k < n ? k / (n - 1) : 1 - (k - n) / (n - 1);
        var x = t;                                       // 0 leading edge → 1 trailing edge
        var yt = 5 * thick * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1015 * x * x * x * x);
        var camber = 0.03 * Math.sin(Math.PI * x);
        var y = (k < n ? yt + camber : -yt + camber) * chord;
        var z = (x - 0.3) * chord;
        pts.push(vertical ? [ctr[0] + y, ctr[1], ctr[2] + z] : [ctr[0], ctr[1] + y, ctr[2] + z]);
      }
      return pts;
    }
    secs.push(airfoil(root, chordR)); secs.push(airfoil(tip, chordT));
    this.loft(secs, c, m, true, true);
  };
  /** Wheel: tyre (torus-ish), rim, hub, optional spokes. Axis = x. */
  MB.prototype.wheel = function (r, w, tyreC, rimC, spokes) {
    var segs = this.lod ? 12 : 24, rings = this.lod ? 4 : 6, tr = w * 0.5;
    var base = this.v.length / 10;
    for (var i = 0; i <= segs; i++) {
      var a = i / segs * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      for (var j = 0; j <= rings; j++) {
        var b = j / rings * Math.PI * 2;
        var rr = r - tr + Math.cos(b) * tr, x = Math.sin(b) * tr * 1.05;
        var p = [x, ca * rr, sa * rr], nn = norm([Math.sin(b), ca * Math.cos(b), sa * Math.cos(b)]);
        this.vert(p, nn, tyreC, MAT.RUBBER);
      }
    }
    for (i = 0; i < segs; i++) for (j = 0; j < rings; j++) { var q = base + i * (rings + 1) + j; this.quad(q, q + rings + 1, q + rings + 2, q + 1); }
    // rim disc / spokes
    if (spokes && !this.lod) {
      for (var s = 0; s < spokes; s++) { var a2 = s / spokes * Math.PI * 2; this.tube([0, 0, 0], [(s % 2 ? 0.02 : -0.02), Math.cos(a2) * (r - tr * 1.6), Math.sin(a2) * (r - tr * 1.6)], 0.004, 0.004, 3, rimC, MAT.CHROME, false); }
      this.tube([-0.035, 0, 0], [0.035, 0, 0], 0.022, 0.022, 8, rimC, MAT.METAL, true);
      this.tube([-0.012, 0, 0], [0.012, 0, 0], r - tr * 1.5, r - tr * 1.5, 24, rimC, MAT.CHROME, false);
    } else {
      this.tube([-w * 0.32, 0, 0], [w * 0.32, 0, 0], r - tr * 1.5, r - tr * 1.5, segs, rimC, MAT.METAL, true);
      this.tube([-w * 0.42, 0, 0], [w * 0.42, 0, 0], r * 0.22, r * 0.22, 8, rimC, MAT.CHROME, true);
    }
  };
  MB.prototype.upload = function (gl, G) {
    var vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    var vb = G.buffer(gl.ARRAY_BUFFER, new Float32Array(this.v));
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 40, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 40, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 40, 24);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 40, 36);
    var big = this.v.length / 10 > 65535;
    var ib = G.buffer(gl.ELEMENT_ARRAY_BUFFER, big ? new Uint32Array(this.i) : new Uint16Array(this.i));
    gl.bindVertexArray(null);
    void vb; void ib;
    return { vao: vao, count: this.i.length, type: big ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, tris: this.i.length / 3 };
  };

  /* ---------------- shared pieces ---------------- */
  function rider(mb, seat, hands, feet, shirt) {
    if (mb.lod) { mb.box([seat[0], seat[1] + 0.35, seat[2]], [0.18, 0.32, 0.12], shirt, MAT.CLOTH); mb.sphere([seat[0], seat[1] + 0.82, seat[2] - 0.03], [0.11, 0.13, 0.11], [0.85, 0.66, 0.52], MAT.SKIN); return; }
    var hip = [seat[0], seat[1] + 0.08, seat[2]], chest = [seat[0], seat[1] + 0.55, seat[2] - 0.08], head = [seat[0], seat[1] + 0.86, seat[2] - 0.1];
    mb.tube(hip, chest, 0.16, 0.18, 10, shirt, MAT.CLOTH, true);
    mb.sphere(head, [0.105, 0.125, 0.11], [0.85, 0.66, 0.52], MAT.SKIN);
    mb.sphere([head[0], head[1] + 0.06, head[2] + 0.01], [0.115, 0.08, 0.12], [0.18, 0.13, 0.09], MAT.CLOTH);   // hair / cap
    [-1, 1].forEach(function (sd) {
      var sh = [chest[0] + sd * 0.19, chest[1] + 0.05, chest[2]];
      var hand = hands ? [hands[0] + sd * Math.abs(hands[3] || 0.25), hands[1], hands[2]] : [sh[0] + sd * 0.1, sh[1] - 0.45, sh[2] - 0.15];
      var elbow = [(sh[0] + hand[0]) / 2 + sd * 0.06, (sh[1] + hand[1]) / 2 - 0.08, (sh[2] + hand[2]) / 2 + 0.05];
      mb.tube(sh, elbow, 0.055, 0.048, 7, shirt, MAT.CLOTH, true); mb.tube(elbow, hand, 0.045, 0.04, 7, [0.85, 0.66, 0.52], MAT.SKIN, true);
      var hp = [hip[0] + sd * 0.1, hip[1], hip[2]];
      var foot = feet ? [feet[0] + sd * Math.abs(feet[3] || 0.16), feet[1], feet[2]] : [hp[0], hp[1] - 0.05, hp[2] - 0.45];
      var knee = [(hp[0] + foot[0]) / 2 + sd * 0.04, Math.max(hp[1], foot[1]) + 0.12, (hp[2] + foot[2]) / 2 - 0.15];
      mb.tube(hp, knee, 0.075, 0.06, 7, [0.16, 0.18, 0.24], MAT.CLOTH, true); mb.tube(knee, foot, 0.058, 0.05, 7, [0.16, 0.18, 0.24], MAT.CLOTH, true);
      mb.box([foot[0], foot[1] - 0.03, foot[2] - 0.05], [0.05, 0.04, 0.11], [0.12, 0.1, 0.09], MAT.RUBBER);
    });
  }

  /* ---------------- boats ---------------- */
  /** Hull sections: V-bottom planing hull with flared topsides; L length, B beam, D depth. */
  function hullSections(L, B, D, deadrise, n, sheer) {
    var secs = [];
    for (var k = 0; k <= n; k++) {
      var t = k / n;                          // 0 stern … 1 bow
      var z = (0.5 - t) * L;                  // stern at +z, bow at −z
      var bow = Math.max(0, (t - 0.55) / 0.45);
      var hb = B * 0.5 * (1 - Math.pow(bow, 1.6) * 0.98) * (t < 0.05 ? 0.94 + t : 1);
      var keel = -D + Math.pow(bow, 2.2) * D * 0.75;     // bow rises
      var top = D * 0.15 + sheer * Math.pow(bow, 2) + (1 - t) * 0.04;
      var chineY = keel + deadrise * hb * (1 - bow * 0.5);
      secs.push([[0, keel, z], [hb * 0.82, chineY, z], [hb, chineY + 0.06, z], [hb * 1.03, top, z], [-hb * 1.03, top, z], [-hb, chineY + 0.06, z], [-hb * 0.82, chineY, z]]);
    }
    return secs;
  }
  function boatModel(kind, lod) {
    var mb = new MB(lod), parts = [];
    var spec = kind === 'skiff' ? { L: 4.2, B: 1.55, D: 0.55, c: [0.92, 0.92, 0.88], stripe: [0.12, 0.32, 0.55] }
      : kind === 'speed' ? { L: 6.6, B: 2.3, D: 0.75, c: [0.95, 0.95, 0.96], stripe: [0.75, 0.08, 0.06] }
      : { L: 9.6, B: 3.2, D: 1.05, c: [0.94, 0.93, 0.9], stripe: [0.1, 0.2, 0.35] };
    var L = spec.L, B = spec.B, D = spec.D;
    var secs = hullSections(L, B, D, kind === 'speed' ? 0.42 : 0.3, lod ? 6 : 14, kind === 'cruiser' ? 0.45 : 0.3);
    // hull: topsides paint, bottom antifouling (split by colouring sections)
    mb.loft(secs, spec.c, MAT.PAINT, true, false);
    // antifouling band below the waterline (a slightly larger lower loft)
    var low = secs.map(function (s) { return [s[0], s[1], s[2], [s[2][0], s[2][1] + 0.12, s[2][2]], [-s[2][0], s[2][1] + 0.12, s[2][2]], s[5], s[6]].map(function (p) { return [p[0] * 1.004, p[1] - 0.003, p[2]]; }); });
    mb.loft(low, kind === 'skiff' ? [0.2, 0.32, 0.22] : [0.55, 0.08, 0.06], MAT.ANTIFOUL, false, false);
    // stripe along the sheer
    if (!lod) {
      var stripe = secs.map(function (s) { var a = s[3], b = s[4]; return [[a[0] * 1.012, a[1] - 0.05, a[2]], [a[0] * 1.012, a[1] - 0.13, a[2]], [b[0] * 1.012, b[1] - 0.13, b[2]], [b[0] * 1.012, b[1] - 0.05, b[2]]]; });
      for (var k = 0; k < stripe.length - 1; k++) {
        var s0 = stripe[k], s1 = stripe[k + 1];
        mb.face(s0[1], s1[1], s1[0], s0[0], spec.stripe, MAT.PAINT);
        mb.face(s0[3], s1[3], s1[2], s0[2], spec.stripe, MAT.PAINT);
      }
    }
    // deck / cockpit floor
    var deckY = D * 0.15 - 0.25;
    mb.box([0, deckY, L * 0.08], [B * 0.42, 0.03, L * 0.36], kind === 'skiff' ? [0.55, 0.4, 0.25] : [0.82, 0.8, 0.76], kind === 'skiff' ? MAT.WOOD : MAT.PLASTIC);
    var seatC = [0.85, 0.83, 0.78];
    if (kind === 'skiff') {
      mb.box([0, deckY + 0.22, -L * 0.08], [B * 0.44, 0.04, 0.16], [0.6, 0.44, 0.28], MAT.WOOD);   // thwarts
      mb.box([0, deckY + 0.22, L * 0.25], [B * 0.42, 0.04, 0.14], [0.6, 0.44, 0.28], MAT.WOOD);
      if (!lod) [-1, 1].forEach(function (sd) { mb.tube([sd * B * 0.48, D * 0.18, L * 0.1], [sd * B * 0.5, D * 0.18 + 0.12, L * 0.1], 0.015, 0.012, 5, [0.6, 0.6, 0.6], MAT.STEEL, true); });
    } else if (kind === 'speed') {
      // windscreen + console + bench seats
      mb.box([0, deckY + 0.42, -L * 0.02], [B * 0.18, 0.4, 0.25], [0.95, 0.95, 0.95], MAT.PLASTIC);
      if (!lod) { mb.box([0, deckY + 0.86, -L * 0.03], [0.14, 0.12, 0.02], [0.12, 0.12, 0.13], MAT.DARK); mb.tube([0, deckY + 0.92, 0.05 - L * 0.02], [0, deckY + 0.88, 0.25 - L * 0.02], 0.012, 0.012, 6, [0.7, 0.7, 0.7], MAT.CHROME, true); }
      var ws = [[-B * 0.4, D * 0.18, -L * 0.12], [B * 0.4, D * 0.18, -L * 0.12], [B * 0.32, D * 0.18 + 0.48, -L * 0.04], [-B * 0.32, D * 0.18 + 0.48, -L * 0.04]];
      mb.face(ws[0], ws[1], ws[2], ws[3], [0.5, 0.6, 0.65], MAT.GLASS); mb.face(ws[1], ws[0], ws[3], ws[2], [0.5, 0.6, 0.65], MAT.GLASS);
      mb.box([0, deckY + 0.25, L * 0.18], [B * 0.4, 0.22, 0.3], seatC, MAT.PLASTIC);
      mb.box([0, deckY + 0.5, L * 0.3], [B * 0.4, 0.28, 0.07], seatC, MAT.PLASTIC);
      if (!lod) [-1, 1].forEach(function (sd) { for (var r = 0; r < 4; r++) mb.tube([sd * B * 0.46, D * 0.16, -L * 0.3 + r * 0.6], [sd * B * 0.46, D * 0.16 + 0.22, -L * 0.3 + r * 0.6], 0.012, 0.012, 5, [0.8, 0.8, 0.8], MAT.CHROME, true); mb.tube([sd * B * 0.46, D * 0.38, -L * 0.32], [sd * B * 0.46, D * 0.38, L * 0.12], 0.014, 0.014, 6, [0.8, 0.8, 0.8], MAT.CHROME, true); });
    } else {
      // cabin cruiser: cabin with windows, flybridge rail, mast, nav lights
      var cy = D * 0.15;
      mb.box([0, cy + 0.6, -L * 0.05], [B * 0.4, 0.62, L * 0.22], spec.c, MAT.PAINT);
      mb.box([0, cy + 1.26, -L * 0.03], [B * 0.43, 0.05, L * 0.26], [0.9, 0.9, 0.88], MAT.PAINT);
      for (var w = 0; w < 4; w++) [-1, 1].forEach(function (sd) { mb.box([sd * (B * 0.4 + 0.01), cy + 0.78, -L * 0.2 + w * L * 0.1], [0.012, 0.18, L * 0.035], [0.4, 0.5, 0.55], MAT.GLASS); });
      mb.box([0, cy + 0.78, -L * 0.27 - 0.01], [B * 0.32, 0.22, 0.012], [0.4, 0.5, 0.55], MAT.GLASS);
      mb.tube([0, cy + 1.3, L * 0.05], [0, cy + 3.0, L * 0.05], 0.04, 0.03, 8, [0.85, 0.85, 0.85], MAT.STEEL, true);
      mb.box([0, cy + 0.2, L * 0.3], [B * 0.42, 0.2, 0.28], seatC, MAT.PLASTIC);
      if (!lod) { mb.sphere([0, cy + 3.05, L * 0.05], [0.05, 0.05, 0.05], [1, 1, 1], MAT.LAMP); mb.box([-B * 0.44, cy + 1.32, -L * 0.18], [0.03, 0.04, 0.06], [1, 0.1, 0.1], MAT.LAMP_RED); mb.box([B * 0.44, cy + 1.32, -L * 0.18], [0.03, 0.04, 0.06], [0.1, 1, 0.2], MAT.LAMP_GREEN); }
    }
    // driver
    var seatPos = kind === 'skiff' ? [0.0, deckY + 0.26, L * 0.33] : (kind === 'speed' ? [-B * 0.15, deckY + 0.48, L * 0.13] : [B * 0.18, D * 0.15 + 1.32, -L * 0.02]);
    if (kind === 'cruiser') seatPos = [-B * 0.15, deckY + 0.48, L * 0.25];
    rider(mb, seatPos, kind === 'skiff' ? [0.35, seatPos[1] + 0.3, L * 0.42, 0.0] : [seatPos[0], seatPos[1] + 0.45, seatPos[2] - 0.4, 0.17], kind === 'skiff' ? [seatPos[0], deckY + 0.05, seatPos[2] - 0.45, 0.14] : null, [0.85, 0.35, 0.12]);
    // outboard / sterndrive as a steerable part
    var ob = new MB(lod);
    var obC = kind === 'speed' ? [0.08, 0.08, 0.09] : [0.85, 0.85, 0.85];
    var bigMotor = kind !== 'skiff';
    ob.box([0, 0.35, 0.18], [bigMotor ? 0.28 : 0.18, bigMotor ? 0.32 : 0.22, bigMotor ? 0.36 : 0.24], obC, MAT.PAINT);
    ob.box([0, -0.25, 0.12], [0.06, 0.5, 0.1], [0.2, 0.2, 0.21], MAT.DARK);
    ob.box([0, -0.72, 0.1], [0.07, 0.07, 0.2], [0.2, 0.2, 0.21], MAT.DARK);
    var pivot = [0, D * 0.15 - 0.05, L * 0.5 + 0.05];
    parts.push({ name: 'motor', mesh: ob, pivot: pivot, kind: 'steer' });
    var prop = new MB(lod);
    for (var b2 = 0; b2 < 3; b2++) { var a = b2 / 3 * Math.PI * 2; prop.face([0, 0, 0], [Math.cos(a) * 0.04, Math.sin(a) * 0.04, 0.02], [Math.cos(a + 0.6) * 0.17, Math.sin(a + 0.6) * 0.17, 0.0], [Math.cos(a + 0.3) * 0.16, Math.sin(a + 0.3) * 0.16, -0.02], [0.7, 0.7, 0.72], MAT.METAL); }
    parts.push({ name: 'prop', mesh: prop, pivot: [0, -0.72, 0.32], parent: 'motor', kind: 'spinZ' });
    return { body: mb, parts: parts, L: L, B: B, D: D, seat: seatPos };
  }

  /* ---------------- aircraft ---------------- */
  function planeModel(floats, lod) {
    var mb = new MB(lod), parts = [];
    var paint = [0.94, 0.94, 0.92], accent = floats ? [0.85, 0.42, 0.06] : [0.12, 0.3, 0.6];
    // fuselage loft (nose at −z)
    var secs = [], st = lod ? [ -3.6, -3.2, -2.2, -0.6, 1.2, 3.0, 4.6, 5.6 ] : [-3.6, -3.45, -3.2, -2.8, -2.2, -1.4, -0.6, 0.4, 1.2, 2.2, 3.0, 3.8, 4.6, 5.3, 5.6];
    var np = lod ? 8 : 14;
    st.forEach(function (z) {
      var t = (z + 3.6) / 9.2;
      var w = z < -2.2 ? 0.42 + (z + 3.6) / 1.4 * 0.16 : (z < 1.0 ? 0.58 : 0.58 - (z - 1.0) / 4.6 * 0.46);
      var h = z < -2.2 ? 0.5 + (z + 3.6) / 1.4 * 0.22 : (z < 1.0 ? 0.72 + (z > -1.2 ? 0.08 : 0) : 0.8 - (z - 1.0) / 4.6 * 0.6);
      var cyy = z < 1.0 ? 0.0 : (z - 1.0) / 4.6 * 0.35;
      if (z < -3.3) { w *= 0.6; h *= 0.6; }
      var ring = [];
      for (var k = 0; k < np; k++) { var a = k / np * Math.PI * 2; ring.push([Math.cos(a) * w * 0.5 * 2 * 0.5 * 2 * 0.5, cyy + Math.sin(a) * h * 0.5, z]); }
      void t; secs.push(ring);
    });
    mb.loft(secs, paint, MAT.PAINT, true, true);
    // accent stripe band
    if (!lod) for (var s = 0; s < 6; s++) { var z0 = -1.4 + s * 0.85; mb.box([0, -0.1, z0 + 0.42], [0.305, 0.05, 0.42], accent, MAT.PAINT); }
    // cockpit glazing (windscreen + side windows)
    mb.face([-0.27, 0.25, -1.75], [0.27, 0.25, -1.75], [0.25, 0.68, -1.15], [-0.25, 0.68, -1.15], [0.45, 0.55, 0.62], MAT.GLASS);
    [-1, 1].forEach(function (sd) { mb.face([sd * 0.3, 0.22, -1.6], [sd * 0.3, 0.22, -0.3], [sd * 0.29, 0.62, -0.4], [sd * 0.29, 0.62, -1.15], [0.45, 0.55, 0.62], MAT.GLASS); });
    // high wing on struts
    mb.wing([0, 0.86, -0.7], [5.6, 0.92, -0.62], 1.55, 1.15, 0.13, paint, MAT.PAINT, false);
    mb.wing([0, 0.86, -0.7], [-5.6, 0.92, -0.62], 1.55, 1.15, 0.13, paint, MAT.PAINT, false);
    mb.box([0, 0.88, -0.75], [0.62, 0.08, 0.72], paint, MAT.PAINT);
    if (!lod) [-1, 1].forEach(function (sd) { mb.tube([sd * 0.32, -0.25, -0.6], [sd * 2.6, 0.82, -0.62], 0.035, 0.03, 6, paint, MAT.PAINT, true); mb.box([sd * 5.55, 0.9, -0.62], [0.06, 0.04, 0.12], sd < 0 ? [1, 0.1, 0.1] : [0.1, 1, 0.2], sd < 0 ? MAT.LAMP_RED : MAT.LAMP_GREEN); });
    // tail
    mb.wing([0, 0.42, 5.0], [2.0, 0.44, 5.15], 1.1, 0.7, 0.1, paint, MAT.PAINT, false);
    mb.wing([0, 0.42, 5.0], [-2.0, 0.44, 5.15], 1.1, 0.7, 0.1, paint, MAT.PAINT, false);
    mb.wing([0, 0.4, 4.9], [0, 1.75, 5.35], 1.4, 0.8, 0.1, accent, MAT.PAINT, true);
    if (!lod) mb.sphere([0, 1.78, 5.62], [0.04, 0.04, 0.04], [1, 1, 1], MAT.LAMP);
    // engine cowl & spinner
    mb.tube([0, -0.02, -3.62], [0, -0.02, -3.82], 0.12, 0.02, 10, [0.85, 0.85, 0.85], MAT.CHROME, true);
    if (!lod) { mb.box([0, -0.42, -3.0], [0.12, 0.04, 0.25], [0.18, 0.18, 0.19], MAT.DARK); mb.tube([0.2, -0.32, -2.6], [0.2, -0.38, -1.9], 0.03, 0.03, 6, [0.3, 0.3, 0.3], MAT.METAL, true); }
    // landing gear or floats
    if (floats) {
      [-1, 1].forEach(function (sd) {
        var fs = [];
        for (var k = 0; k <= 8; k++) { var z = -3.2 + k * 0.95, t = k / 8; var r = 0.28 * Math.sin(Math.min(1, t * 2.2 + 0.08) * Math.PI * 0.5) * (1 - Math.pow(Math.max(0, t - 0.75) / 0.25, 2) * 0.6) + 0.02; var ring = []; for (var q = 0; q < 8; q++) { var a = q / 8 * Math.PI * 2; ring.push([sd * 1.25 + Math.cos(a) * r, -1.55 + Math.sin(a) * r * 0.9 + (t < 0.2 ? (0.2 - t) * 0.6 : 0), z]); } fs.push(ring); }
        mb.loft(fs, [0.85, 0.85, 0.86], MAT.PAINT, true, true);
        mb.tube([sd * 1.25, -1.35, -1.6], [sd * 0.35, -0.25, -1.5], 0.04, 0.04, 6, [0.6, 0.6, 0.62], MAT.STEEL, true);
        mb.tube([sd * 1.25, -1.35, 0.4], [sd * 0.35, -0.25, 0.3], 0.04, 0.04, 6, [0.6, 0.6, 0.62], MAT.STEEL, true);
      });
    } else {
      [-1, 1].forEach(function (sd) { mb.tube([sd * 0.3, -0.3, 0.3], [sd * 1.15, -1.2, 0.35], 0.05, 0.04, 6, [0.5, 0.5, 0.52], MAT.STEEL, true); });
      mb.tube([0, -0.3, -2.4], [0, -1.2, -2.5], 0.04, 0.04, 6, [0.5, 0.5, 0.52], MAT.STEEL, true);
      var wl = new MB(lod); wl.wheel(0.3, 0.16, [0.06, 0.06, 0.06], [0.75, 0.75, 0.75], 0);
      parts.push({ name: 'wheelL', mesh: wl, pivot: [-1.15, -1.25, 0.35], kind: 'spinX' });
      parts.push({ name: 'wheelR', mesh: wl, pivot: [1.15, -1.25, 0.35], kind: 'spinX' });
      parts.push({ name: 'wheelN', mesh: wl, pivot: [0, -1.25, -2.5], kind: 'spinX' });
    }
    // pilot (cockpit)
    rider(mb, [-0.18, -0.25, -0.95], [-0.18, 0.12, -1.45, 0.16], [-0.18, -0.25, -1.95, 0.12], [0.3, 0.35, 0.3]);
    // propeller (spins about z)
    var pr = new MB(lod);
    for (var b = 0; b < 2; b++) { var a2 = b * Math.PI; pr.face([0, 0, 0], [Math.cos(a2 + 0.25) * 0.08, Math.sin(a2 + 0.25) * 0.08, 0.0], [Math.cos(a2 + 0.08) * 0.95, Math.sin(a2 + 0.08) * 0.95, 0.02], [Math.cos(a2 - 0.06) * 0.95, Math.sin(a2 - 0.06) * 0.95, -0.02], [0.12, 0.12, 0.13], MAT.DARK); pr.face([Math.cos(a2 - 0.06) * 0.95, Math.sin(a2 - 0.06) * 0.95, -0.02], [Math.cos(a2 + 0.08) * 0.95, Math.sin(a2 + 0.08) * 0.95, 0.02], [Math.cos(a2 + 0.25) * 0.08, Math.sin(a2 + 0.25) * 0.08, 0.0], [0, 0, 0], [0.12, 0.12, 0.13], MAT.DARK); pr.box([Math.cos(a2) * 0.9, Math.sin(a2) * 0.9, 0], [0.04, 0.04, 0.01], [0.95, 0.85, 0.1], MAT.PAINT); }
    parts.push({ name: 'prop', mesh: pr, pivot: [0, -0.02, -3.78], kind: 'spinZ' });
    // control surfaces
    var ail = new MB(lod); ail.box([0, 0, 0.15], [1.2, 0.025, 0.15], paint, MAT.PAINT);
    parts.push({ name: 'ailL', mesh: ail, pivot: [-4.0, 0.9, -0.05], kind: 'ailL' });
    parts.push({ name: 'ailR', mesh: ail, pivot: [4.0, 0.9, -0.05], kind: 'ailR' });
    var elev = new MB(lod); elev.box([0, 0, 0.16], [1.8, 0.02, 0.16], paint, MAT.PAINT);
    parts.push({ name: 'elev', mesh: elev, pivot: [0, 0.44, 5.6], kind: 'elev' });
    var rud = new MB(lod); rud.box([0, 0.55, 0.16], [0.02, 0.6, 0.16], accent, MAT.PAINT);
    parts.push({ name: 'rudder', mesh: rud, pivot: [0, 0.75, 5.75], kind: 'rudder' });
    return { body: mb, parts: parts, seat: [-0.18, -0.25, -0.95] };
  }

  /* ---------------- bikes ---------------- */
  function bikeModel(kind, lod) {
    var mb = new MB(lod), parts = [];
    var moto = kind === 'dirt';
    var R = moto ? 0.36 : 0.35, wb = moto ? 1.45 : 1.08;
    var frameC = moto ? [0.92, 0.38, 0.05] : [0.12, 0.42, 0.62];
    // geometry in bike space: rear axle at (0, R, 0), front axle at (0, R, −wb)
    var ra = [0, R, 0], fa = [0, R, -wb];
    var bb = moto ? [0, R + 0.08, -0.62] : [0, R - 0.02, -0.42];
    var seatT = moto ? [0, R + 0.55, -0.42] : [0, R + 0.62, -0.25];
    var headT = moto ? [0, R + 0.72, -wb + 0.22] : [0, R + 0.62, -wb + 0.28];
    var headB = moto ? [0, R + 0.4, -wb + 0.12] : [0, R + 0.42, -wb + 0.22];
    var tR = moto ? 0.045 : 0.022;
    if (moto) {
      mb.tube(headT, [0, R + 0.5, -0.5], tR, tR, 8, frameC, MAT.PAINT, true);
      mb.tube(headB, bb, tR, tR, 8, frameC, MAT.PAINT, true);
      mb.tube(bb, [0, R + 0.5, -0.25], tR, tR, 8, frameC, MAT.PAINT, true);
      // engine block, tank, seat, side panels, exhaust
      mb.box([0, R + 0.18, -0.68], [0.15, 0.2, 0.22], [0.2, 0.2, 0.21], MAT.METAL);
      if (!lod) for (var f = 0; f < 5; f++) mb.box([0, R + 0.1 + f * 0.065, -0.88], [0.17, 0.012, 0.05], [0.35, 0.35, 0.36], MAT.METAL);
      mb.sphere([0, R + 0.62, -0.78], [0.17, 0.12, 0.3], frameC, MAT.PAINT, 10);
      mb.box([0, R + 0.62, -0.22], [0.13, 0.05, 0.42], [0.08, 0.08, 0.08], MAT.PLASTIC);
      [-1, 1].forEach(function (sd) { mb.box([sd * 0.14, R + 0.45, -0.25], [0.02, 0.15, 0.25], [0.95, 0.95, 0.95], MAT.PLASTIC); });
      mb.tube([0.12, R + 0.22, -0.55], [0.16, R + 0.5, 0.1], 0.035, 0.04, 8, [0.6, 0.6, 0.62], MAT.CHROME, true);
      mb.tube([0, R + 0.35, -0.2], ra, 0.035, 0.03, 6, [0.2, 0.2, 0.2], MAT.METAL, true);                     // swingarm
      [-1, 1].forEach(function (sd) { mb.tube([sd * 0.07, R + 0.5, -0.3], [sd * 0.07, R + 0.06, -0.02], 0.025, 0.02, 6, [0.85, 0.75, 0.2], MAT.METAL, true); });   // shock
      mb.box([0, R + 0.62, 0.22], [0.12, 0.03, 0.18], frameC, MAT.PAINT);   // rear fender
    } else {
      mb.tube(headT, seatT, tR, tR, 8, frameC, MAT.PAINT, true);           // top tube
      mb.tube(headB, bb, tR * 1.3, tR * 1.2, 8, frameC, MAT.PAINT, true);  // down tube
      mb.tube(bb, seatT, tR, tR, 8, frameC, MAT.PAINT, true);              // seat tube
      [-1, 1].forEach(function (sd) {
        mb.tube([sd * 0.05, bb[1], bb[2]], [sd * 0.06, R, 0], tR * 0.8, tR * 0.7, 6, frameC, MAT.PAINT, true);     // chainstays
        mb.tube([sd * 0.04, seatT[1] - 0.05, seatT[2]], [sd * 0.06, R, 0], tR * 0.7, tR * 0.7, 6, frameC, MAT.PAINT, true);   // seatstays
      });
      mb.tube(seatT, [0, seatT[1] + 0.12, seatT[2] + 0.05], 0.014, 0.014, 6, [0.2, 0.2, 0.2], MAT.METAL, true);
      mb.box([0, seatT[1] + 0.14, seatT[2] + 0.02], [0.07, 0.03, 0.13], [0.08, 0.08, 0.08], MAT.PLASTIC);
      if (!lod) { mb.tube([0.03, bb[1], bb[2]], [0.06, R, 0], 0.005, 0.005, 4, [0.4, 0.4, 0.42], MAT.STEEL, false); mb.tube([0.05, bb[1], bb[2]], [0.05, bb[1], bb[2]], 0.1, 0.1, 16, [0.3, 0.3, 0.32], MAT.STEEL, false); }
    }
    // rider (hands on the bars, feet on pegs/pedals)
    rider(mb, moto ? [0, R + 0.58, -0.3] : [0, R + 0.65, -0.18], [0, headT[1] + (moto ? 0.22 : 0.16), headT[2] + 0.02, moto ? 0.32 : 0.27], [0, bb[1] - (moto ? 0.0 : 0.12), bb[2], 0.17], moto ? [0.85, 0.85, 0.88] : [0.85, 0.25, 0.2]);
    if (moto && !lod) mb.sphere([0, R + 1.47, -0.42], [0.15, 0.15, 0.17], [0.92, 0.38, 0.05], MAT.PAINT);   // helmet
    // front: fork + bars (steering part, pivot on the head tube)
    var fk = new MB(lod);
    var steerAxis = norm(sub(headT, fa));
    var hp = headT;
    function L(p) { return sub(p, hp); }
    [-1, 1].forEach(function (sd) { fk.tube(L([sd * 0.07, headB[1], headB[2]]), L([sd * 0.07, fa[1], fa[2]]), moto ? 0.03 : 0.015, moto ? 0.028 : 0.012, 6, moto ? [0.85, 0.85, 0.86] : [0.15, 0.15, 0.16], moto ? MAT.CHROME : MAT.METAL, true); });
    fk.tube(L(headB), L(headT), tR * 1.1, tR * 1.1, 8, frameC, MAT.PAINT, true);
    var barY = headT[1] + (moto ? 0.22 : 0.16);
    fk.tube(L([-(moto ? 0.36 : 0.32), barY, headT[2] + 0.02]), L([(moto ? 0.36 : 0.32), barY, headT[2] + 0.02]), 0.014, 0.014, 6, [0.2, 0.2, 0.2], MAT.METAL, true);
    [-1, 1].forEach(function (sd) { fk.tube(L([sd * (moto ? 0.36 : 0.32), barY, headT[2] + 0.02]), L([sd * (moto ? 0.26 : 0.24), barY, headT[2] + 0.02]), 0.02, 0.02, 6, [0.05, 0.05, 0.05], MAT.RUBBER, true); });
    if (moto) { fk.box(L([0, R + 0.62, -wb - 0.02]), [0.1, 0.02, 0.22], frameC, MAT.PAINT); fk.box(L([0, headT[1] - 0.05, headT[2] - 0.1]), [0.1, 0.12, 0.04], [0.95, 0.95, 0.95], MAT.PLASTIC); fk.sphere(L([0, headT[1] - 0.05, headT[2] - 0.14]), [0.05, 0.05, 0.02], [1, 1, 0.9], MAT.LAMP); }
    parts.push({ name: 'fork', mesh: fk, pivot: hp, axis: steerAxis, kind: 'fork' });
    // wheels
    var wh = new MB(lod);
    wh.wheel(R, moto ? 0.11 : 0.055, moto ? [0.07, 0.07, 0.07] : [0.09, 0.08, 0.07], moto ? [0.2, 0.2, 0.22] : [0.65, 0.65, 0.67], moto ? 0 : 28);
    if (!moto && !lod) { wh.tube([-0.03, 0, 0], [0.03, 0, 0], 0.08, 0.08, 16, [0.6, 0.6, 0.62], MAT.STEEL, false); }
    parts.push({ name: 'wheelR', mesh: wh, pivot: ra, kind: 'spinX' });
    parts.push({ name: 'wheelF', mesh: wh, pivot: fa, kind: 'spinXFork' });
    return { body: mb, parts: parts, R: R, wb: wb };
  }

  /* ---------------- hand tools (first-person view models & world props) ---------------- */
  function toolModel(kind, lod) {
    var mb = new MB(lod);
    var wood = [0.58, 0.42, 0.26];
    if (kind === 'axe') {
      mb.tube([0, -0.42, 0], [0, 0.32, 0], 0.018, 0.016, 8, wood, MAT.WOOD, true);
      mb.box([0.0, 0.26, -0.05], [0.012, 0.045, 0.07], [0.45, 0.46, 0.48], MAT.STEEL);
      mb.face([0.012, 0.31, -0.12], [0.012, 0.21, -0.12], [0.004, 0.17, -0.22], [0.004, 0.35, -0.22], [0.7, 0.71, 0.73], MAT.CHROME);
      mb.face([-0.012, 0.21, -0.12], [-0.012, 0.31, -0.12], [-0.004, 0.35, -0.22], [-0.004, 0.17, -0.22], [0.7, 0.71, 0.73], MAT.CHROME);
      mb.box([0, 0.26, 0.04], [0.014, 0.03, 0.03], [0.4, 0.4, 0.42], MAT.STEEL);
    } else if (kind === 'hoe') {
      mb.tube([0, -0.7, 0], [0, 0.55, 0], 0.016, 0.016, 8, wood, MAT.WOOD, true);
      mb.box([0, 0.55, -0.06], [0.012, 0.03, 0.07], [0.35, 0.36, 0.38], MAT.STEEL);
      mb.face([-0.09, 0.53, -0.12], [0.09, 0.53, -0.12], [0.09, 0.4, -0.15], [-0.09, 0.4, -0.15], [0.5, 0.5, 0.52], MAT.STEEL);
      mb.face([0.09, 0.53, -0.12], [-0.09, 0.53, -0.12], [-0.09, 0.4, -0.15], [0.09, 0.4, -0.15], [0.5, 0.5, 0.52], MAT.STEEL);
    } else if (kind === 'rake') {
      mb.tube([0, -0.7, 0], [0, 0.55, 0], 0.015, 0.015, 8, wood, MAT.WOOD, true);
      mb.box([0, 0.56, -0.02], [0.17, 0.015, 0.02], [0.4, 0.4, 0.42], MAT.STEEL);
      for (var t = 0; t < 11; t++) mb.tube([-0.16 + t * 0.032, 0.55, -0.03], [-0.16 + t * 0.032, 0.48, -0.09], 0.004, 0.003, 4, [0.45, 0.45, 0.47], MAT.STEEL, false);
    } else if (kind === 'dynamite') {
      for (var s = 0; s < 3; s++) mb.tube([(s - 1) * 0.034, -0.1, 0], [(s - 1) * 0.034, 0.1, 0], 0.017, 0.017, 10, [0.75, 0.12, 0.08], MAT.PLASTIC, true);
      mb.box([0, 0.0, 0], [0.056, 0.012, 0.019], [0.2, 0.2, 0.2], MAT.DARK);
      mb.tube([0, 0.1, 0], [0.02, 0.17, 0.01], 0.003, 0.003, 4, [0.85, 0.8, 0.6], MAT.CANVAS, false);
    } else if (kind === 'rock') {
      mb.sphere([0, 0, 0], [0.07, 0.055, 0.06], [0.45, 0.43, 0.4], MAT.METAL, 6);
    }
    return mb;
  }

  TERRA.game.VehicleModels = { MB: MB, MAT: MAT, boat: boatModel, plane: planeModel, bike: bikeModel, tool: toolModel };
})();
