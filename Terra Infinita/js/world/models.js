/* =============================================================================
 * TERRA INFINITA — procedural 3D models
 * Trees (10 species × 3 variants), boulders, ground props and landmark structures
 * are generated at startup from seeded recipes. No external model files are
 * needed; if assets/models/*.json exist they could replace these, but the
 * procedural versions are always available as a fallback.
 *
 * Vertex format (36 bytes):
 *   0  f32x3 position    12 i16x4 normal    20 f32x2 uv
 *   28 u8x4 colour (rgb tint/AO, a = material id)
 *   32 u8x4 wind   (x height weight, y branch weight, z leaf flutter, w foliage layer)
 * Materials: 0 bark, 1 foliage card, 2 rock, 3 wood, 4 stone, 5 cloth, 6 thatch,
 *            7 cactus, 8 fire/emissive, 9 metal, 10 fern/grass card, 11 birch bark, 12 mushroom, 13 crystal
 * ========================================================================== */
(function () {
  'use strict';
  var U = TERRA.util;
  var MAT = { BARK: 0, LEAF: 1, ROCK: 2, WOOD: 3, STONE: 4, CLOTH: 5, THATCH: 6, CACTUS: 7, FIRE: 8, METAL: 9, FERN: 10, BIRCH: 11, SHROOM: 12, CRYSTAL: 13, ENDGRAIN: 14 };

  /* ---------------- geometry builder ---------------- */
  function Geo() { this.v = []; this.idx = []; this.n = 0; }
  Geo.prototype.vert = function (p, nrm, uv, col, mat, wind) {
    this.v.push(p[0], p[1], p[2], nrm[0], nrm[1], nrm[2], uv[0], uv[1],
      col[0], col[1], col[2], mat, wind[0], wind[1], wind[2], wind[3]);
    return this.n++;
  };
  Geo.prototype.tri = function (a, b, c) { this.idx.push(a, b, c); };
  Geo.prototype.quad = function (a, b, c, d) { this.idx.push(a, b, c, a, c, d); };
  Geo.prototype.append = function (g) {
    var off = this.n;
    for (var i = 0; i < g.v.length; i++) this.v.push(g.v[i]);
    for (i = 0; i < g.idx.length; i++) this.idx.push(g.idx[i] + off);
    this.n += g.n;
  };
  Geo.prototype.bounds = function () {
    var r = 0, h = 0, lo = 1e9;
    for (var i = 0; i < this.v.length; i += 16) {
      r = Math.max(r, Math.hypot(this.v[i], this.v[i + 2]));
      h = Math.max(h, this.v[i + 1]); lo = Math.min(lo, this.v[i + 1]);
    }
    return { radius: r, height: h, bottom: lo };
  };

  function norm(v) { var l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function scl(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function perp(d) { var up = Math.abs(d[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0]; return norm(cross(d, up)); }
  function rotY(p, a) { var c = Math.cos(a), s = Math.sin(a); return [c * p[0] - s * p[2], p[1], s * p[0] + c * p[2]]; }

  /**
   * Generalised cylinder along a polyline with per-point radius.
   * `windFn(point, t)` returns [height weight, branch weight].
   */
  /* Mid-distance LOD switches (set while building the reduced tree meshes): leaf cards are
     thinned deterministically (no rng consumed, so the tree keeps its exact shape) and the
     survivors grow to keep the crown's coverage; tubes lose segments and the finest twigs. */
  var LOD = { keep: 1, grow: 1, seg: 1, cnt: 0 };
  function tube(g, pts, radii, segs, mat, col, windFn, uvScale, cap) {
    if (LOD.seg < 1) { if (radii[0] < 0.06) return; segs = Math.max(3, Math.round(segs * LOD.seg)); }   // thin wood is hidden by foliage at mid range
    var rings = [], n = pts.length, vAcc = 0;
    var prevSide = null;
    for (var i = 0; i < n; i++) {
      var dir = i < n - 1 ? norm(sub(pts[i + 1], pts[i])) : norm(sub(pts[i], pts[i - 1]));
      if (i > 0 && i < n - 1) dir = norm(add(norm(sub(pts[i + 1], pts[i])), norm(sub(pts[i], pts[i - 1]))));
      var side = prevSide ? norm(sub(prevSide, scl(dir, dotp(prevSide, dir)))) : perp(dir);
      prevSide = side;
      var up = cross(dir, side);
      if (i > 0) vAcc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
      var ring = [];
      for (var s = 0; s <= segs; s++) {
        var a = s / segs * Math.PI * 2;
        var nrm = add(scl(side, Math.cos(a)), scl(up, Math.sin(a)));
        var p = add(pts[i], scl(nrm, radii[i]));
        var w = windFn(pts[i], i / (n - 1));
        ring.push(g.vert(p, nrm, [s / segs * uvScale[0], vAcc * uvScale[1]], col, mat, [w[0], w[1], 0, 0]));
      }
      rings.push(ring);
    }
    for (i = 0; i < n - 1; i++) for (s = 0; s < segs; s++) g.quad(rings[i][s], rings[i + 1][s], rings[i + 1][s + 1], rings[i][s + 1]);
    if (cap) {
      var last = pts[n - 1], dl = norm(sub(pts[n - 1], pts[n - 2]));
      var w2 = windFn(last, 1);
      var c = g.vert(last, dl, [0.5, 0.5], [col[0] * 0.8, col[1] * 0.75, col[2] * 0.6], mat === MAT.BARK ? MAT.WOOD : mat, [w2[0], w2[1], 0, 0]);
      for (s = 0; s < segs; s++) g.tri(rings[n - 1][s], rings[n - 1][s + 1], c);
    }
  }
  function dotp(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  /** A leaf card: quad centred at c, spanned by u/v, with an outward "crown" normal for soft lighting. */
  function card(g, c, u, v, crownN, layer, wind, col, mat) {
    if (LOD.keep < 1) {
      LOD.cnt++;
      if ((((LOD.cnt * 2654435761) >>> 0) / 4294967296) > LOD.keep) return;
      u = scl(u, LOD.grow); v = scl(v, LOD.grow);
    }
    var n = norm(add(norm(cross(u, v)), scl(crownN, 1.4)));
    var p0 = sub(sub(c, u), v), p1 = sub(add(c, u), v), p2 = add(add(c, u), v), p3 = add(sub(c, u), v);
    col = col || [255, 255, 255];
    var m = mat === undefined ? MAT.LEAF : mat;
    var a = g.vert(p0, n, [0, 0], col, m, [wind[0], wind[1], 0.2, layer]);
    var b = g.vert(p1, n, [1, 0], col, m, [wind[0], wind[1], 0.2, layer]);
    var cc = g.vert(p2, n, [1, 1], col, m, [wind[0], wind[1], 1, layer]);
    var d = g.vert(p3, n, [0, 1], col, m, [wind[0], wind[1], 1, layer]);
    g.quad(a, b, cc, d);
  }
  /** Crossed cluster of cards (reads as volume from all angles). */
  function leafCluster(g, c, size, crownCenter, layer, wind, rng, col, count) {
    var cn = norm(sub(c, crownCenter));
    count = count || 3;
    for (var k = 0; k < count; k++) {
      // cards face roughly outward from the crown with random roll → volume from every angle
      var n = norm(add(cn, [(rng() - 0.5) * 1.6, (rng() - 0.3) * 1.2, (rng() - 0.5) * 1.6]));
      var ref = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      var u0 = norm(cross(n, ref)), v0 = cross(n, u0);
      var roll = rng() * Math.PI * 2, cr = Math.cos(roll), sr = Math.sin(roll);
      var u = scl(add(scl(u0, cr), scl(v0, sr)), size);
      var v = scl(add(scl(u0, -sr), scl(v0, cr)), size);
      card(g, c, u, v, cn, layer, wind, col);
    }
  }

  /**
   * A leaf sprig card. The sprig textures draw a stem from uv (0.5, 0) upward with leaves on
   * both sides, so the card is placed with its bottom edge centred on `base` (a point on a
   * twig) and its long axis along `dir`: every leaf visibly grows out of wood.
   */
  function sprig(g, base, dir, len, width, roll, crownN, layer, wind, col) {
    var ref = Math.abs(dir[1]) < 0.92 ? [0, 1, 0] : [1, 0, 0];
    var s0 = norm(cross(dir, ref)), s1 = cross(dir, s0);
    var side = add(scl(s0, Math.cos(roll)), scl(s1, Math.sin(roll)));
    var v = scl(dir, len * 0.5), u = scl(side, width * 0.5);
    card(g, add(base, v), u, v, crownN, layer, wind, col);
  }
  /** Per-sprig colour jitter (brightness + a little yellow/blue hue drift): real crowns are
   *  never one flat green — sun leaves, shade leaves and new growth all differ. */
  function jit(col, rng, amt) {
    amt = amt === undefined ? 1 : amt;
    var b = 1 + (rng() - 0.5) * 0.3 * amt, hue = (rng() - 0.5) * 0.16 * amt;
    return [Math.min(255, col[0] * b * (1 + hue)), Math.min(255, col[1] * b), Math.min(255, col[2] * b * (1 - hue * 1.5))];
  }
  /** Distance from a point inside an ellipsoid (centre c, radii rx, ry, rx) to its surface along d. */
  function toEnvelope(o, d, c, rx, ry) {
    var ox = (o[0] - c[0]) / rx, oy = (o[1] - c[1]) / ry, oz = (o[2] - c[2]) / rx;
    var dx = d[0] / rx, dy = d[1] / ry, dz = d[2] / rx;
    var A = dx * dx + dy * dy + dz * dz, B = 2 * (ox * dx + oy * dy + oz * dz), C = ox * ox + oy * oy + oz * oz - 1;
    var disc = B * B - 4 * A * C;
    if (disc < 0) return 0.4;
    return Math.max(0.3, (-B + Math.sqrt(disc)) / (2 * A));
  }
  function pointOnPolyline(pts, t) {
    var f = t * (pts.length - 1), i = Math.min(pts.length - 2, Math.floor(f));
    return lerp3(pts[i], pts[i + 1], f - i);
  }
  function dirOnPolyline(pts, t) {
    var f = t * (pts.length - 1), i = Math.min(pts.length - 2, Math.floor(f));
    return norm(sub(pts[i + 1], pts[i]));
  }
  /** Rotate v around unit axis k by angle a (Rodrigues). */
  function rotAxis(v, k, a) {
    var c = Math.cos(a), s = Math.sin(a), kd = dotp(k, v), kx = cross(k, v);
    return [v[0] * c + kx[0] * s + k[0] * kd * (1 - c), v[1] * c + kx[1] * s + k[1] * kd * (1 - c), v[2] * c + kx[2] * s + k[2] * kd * (1 - c)];
  }
  /** Bent limb polyline growing from p along d; gravitropism `up` bends it upward (negative droops). */
  function limb(rng, p, d, len, segs, up, wobble) {
    var pts = [p.slice()], cur = p.slice(), dd = d.slice();
    for (var k = 1; k <= segs; k++) {
      dd = norm(add(dd, [(rng() - 0.5) * wobble, up, (rng() - 0.5) * wobble]));
      cur = add(cur, scl(dd, len / segs));
      pts.push(cur.slice());
    }
    return pts;
  }

  /* ---------------- trees ---------------- */
  /**
   * Broadleaf trees grown as a branch hierarchy inside a crown envelope:
   * trunk (+ leader) → limbs → branches → twigs → leaf sprigs. Limb and branch lengths are
   * derived from the distance to the envelope, so the foliage fills the crown shell evenly
   * and hides the inner wood, and every sprig is anchored on a twig or branch.
   */
  function makeBroadleaf(rng, opt) {
    var g = new Geo();
    var H = opt.height, trunkH = H * opt.trunkFrac;
    var col = opt.barkCol, mat = opt.barkMat || MAT.BARK;
    var windH = function (p) { return [U.clamp01(p[1] / H), 0]; };
    var dens = opt.density || 1;
    // trunk with gentle bends, continuing as a thinner leader into the crown
    var pts = [], radii = [], segs = 7;
    var lean = [(rng() - 0.5) * 0.35, (rng() - 0.5) * 0.35];
    var leaderH = trunkH + (H - trunkH) * 0.55;
    for (var i = 0; i <= segs; i++) {
      var t = i / segs, y = t * leaderH;
      pts.push([lean[0] * t * t * leaderH * 0.25 + (rng() - 0.5) * 0.08, y, lean[1] * t * t * leaderH * 0.25 + (rng() - 0.5) * 0.08]);
      var rt = y < trunkH ? 1 - (y / trunkH) * 0.45 : 0.55 * (1 - (y - trunkH) / (leaderH - trunkH) * 0.8);
      radii.push(opt.radius * rt * (i === 0 ? 1.35 : 1));
    }
    tube(g, pts, radii, opt.tubeSegs || 9, mat, col, windH, [1, 0.35], false);
    // broken-off limbs: short stubs with a splintered end grain face below the crown
    var nStub = 1 + Math.floor(rng() * 3);
    for (var st = 0; st < nStub; st++) {
      var sy = trunkH * (0.25 + rng() * 0.6), sp = pointOnPolyline(pts, sy / leaderH), sa = rng() * Math.PI * 2;
      var sd = norm([Math.cos(sa), 0.35 + rng() * 0.5, Math.sin(sa)]), sr = opt.radius * (0.22 + rng() * 0.16);
      var se = add(sp, scl(sd, 0.18 + rng() * 0.35));
      tube(g, [sp, se], [sr, sr * 0.85], 6, mat, col, windH, [1, 0.5], false);
      capDisc(g, se, sd, sr * 0.85, 6, [200, 170, 130], MAT.ENDGRAIN, rng() * 0.25);
    }
    if (opt.roots) for (var r = 0; r < 5; r++) {
      var ra = r / 5 * Math.PI * 2 + rng() * 0.5;
      var rp = [[0, 0.8, 0], [Math.cos(ra) * opt.radius * 1.4, 0.25, Math.sin(ra) * opt.radius * 1.4], [Math.cos(ra) * opt.radius * 2.4, -0.1, Math.sin(ra) * opt.radius * 2.4]];
      tube(g, rp, [opt.radius * 0.5, opt.radius * 0.35, opt.radius * 0.12], 5, mat, col, function () { return [0, 0]; }, [1, 0.35], false);
    }
    // crown envelope
    var crownRy = (H - trunkH) * 0.52, crownRx = opt.crownR;
    var top = pointOnPolyline(pts, trunkH / leaderH);
    var crownC = [top[0], trunkH + crownRy * 0.92, top[2]];
    var leafLen = opt.leafSize * 1.15, leafW = opt.leafSize * 0.95;
    var droop = opt.droop || 0;
    function crownN(p) { return norm(sub(p, crownC)); }
    function bw(p) { return [U.clamp01(p[1] / H), U.clamp01(Math.hypot(p[0] - top[0], p[2] - top[2]) / crownRx)]; }
    function leafAt(base, d, sz) {
      // sprig pointing outward/along the twig, drooping species hang down
      var dd = norm(add(d, [0, -droop * (0.6 + rng() * 0.6), 0]));
      var w = bw(base);
      sprig(g, base, dd, leafLen * sz, leafW * sz, rng() * Math.PI * 2, crownN(base), opt.leafLayer, [w[0], Math.max(w[1], 0.55)], jit(opt.leafCol, rng));
    }
    var nb = Math.round(opt.branches * (0.9 + 0.2 * rng()));
    for (var b = 0; b < nb; b++) {
      var t0 = opt.branchStart + (1 - opt.branchStart) * ((b + 0.5) / nb) + (rng() - 0.5) * 0.05;
      var ty = t0 * leaderH;
      var basePt = pointOnPolyline(pts, ty / leaderH);
      var az = b * 2.39996 + rng() * 0.5;
      // lower limbs spread wider, upper limbs climb steeper
      var elev = opt.branchAngle * (1.05 - 0.4 * (ty - trunkH * opt.branchStart) / Math.max(leaderH - trunkH * opt.branchStart, 1)) + (rng() - 0.5) * 0.3;
      var dir = norm([Math.cos(az) * Math.sin(elev), Math.cos(elev), Math.sin(az) * Math.sin(elev)]);
      var reach = toEnvelope(basePt, dir, crownC, crownRx, crownRy);
      var len = Math.max(0.8, reach * (0.72 + 0.18 * rng()));
      var r1 = opt.radius * 0.5 * (1 - (ty / leaderH) * 0.45);
      var lp = limb(rng, basePt, dir, len, 4, opt.branchCurve, 0.25);
      tube(g, lp, [r1, r1 * 0.72, r1 * 0.5, r1 * 0.3, r1 * 0.12], 5, mat, col, bw, [1, 0.5], true);
      // limb tip leaves reach the envelope
      var tipD = dirOnPolyline(lp, 1);
      leafAt(lp[4], tipD, 1.0);
      leafAt(pointOnPolyline(lp, 0.9), norm(add(tipD, [rng() - 0.5, 0.3, rng() - 0.5])), 0.9);
      // branches
      var n2 = Math.max(2, Math.round((opt.sub || 5) * (0.8 + 0.4 * rng()) * Math.min(1.4, len / 3)));
      for (var k = 0; k < n2; k++) {
        var tt = 0.22 + 0.72 * (k + rng() * 0.6) / n2;
        var p2 = pointOnPolyline(lp, tt), dl = dirOnPolyline(lp, tt);
        var sideV = rotAxis(perp(dl), dl, k * 2.39996 + rng());
        var d2 = norm(add(add(scl(dl, 0.55), scl(sideV, 0.75)), [0, 0.2 + (rng() - 0.5) * 0.3, 0]));
        var reach2 = toEnvelope(p2, d2, crownC, crownRx * 1.05, crownRy * 1.05);
        var len2 = Math.max(0.5, Math.min(reach2 * 0.92, len * 0.62) * (0.75 + 0.3 * rng()));
        var r2 = r1 * 0.42 * (1 - tt * 0.5);
        var bp2 = limb(rng, p2, d2, len2, 2, opt.branchCurve * 0.6 - droop * 0.2, 0.35);
        tube(g, bp2, [r2, r2 * 0.55, 0.012], 4, mat, col, bw, [1, 0.5], false);
        // twigs with sprigs
        var n3 = Math.max(2, Math.round((opt.twigs || 3) * dens));
        for (var q = 0; q < n3; q++) {
          var t3 = 0.3 + 0.7 * (q + rng() * 0.5) / n3;
          var p3 = pointOnPolyline(bp2, t3), dd2 = dirOnPolyline(bp2, t3);
          var d3 = norm(add(add(scl(dd2, 0.6), scl(rotAxis(perp(dd2), dd2, q * 2.1 + rng() * 2), 0.7)), [0, 0.25 - droop * 0.6, 0]));
          var len3 = (opt.twigLen || 0.7) * (0.6 + 0.6 * rng());
          var e3 = add(p3, scl(d3, len3));
          tube(g, [p3, e3], [Math.max(r2 * 0.25, 0.008), 0.004], 3, mat, col, bw, [1, 0.5], false);
          leafAt(lerp3(p3, e3, 0.35), d3, 0.95 + 0.2 * rng());
          leafAt(e3, norm(add(d3, [rng() - 0.5, 0.2, rng() - 0.5])), 0.85 + 0.25 * rng());
          if (dens > 1.05 && rng() < dens - 1) leafAt(lerp3(p3, e3, 0.7), norm(add(scl(d3, -0.2), [rng() - 0.5, 0.5, rng() - 0.5])), 0.8);
        }
        // leaves along the branch itself cover the inner wood
        leafAt(pointOnPolyline(bp2, 0.45), norm(add(d2, [rng() - 0.5, 0.35, rng() - 0.5])), 0.9);
        leafAt(pointOnPolyline(bp2, 1.0), d2, 1.0);
      }
    }
    // leader top: a small tuft of branches closing the crown
    var lt = pts[segs];
    for (var f = 0; f < 5; f++) {
      var fa = f * 1.2566 + rng() * 0.4;
      var fd = norm([Math.cos(fa) * 0.7, 0.8, Math.sin(fa) * 0.7]);
      var fl = Math.max(0.6, toEnvelope(lt, fd, crownC, crownRx, crownRy) * 0.8);
      var fe = add(lt, scl(fd, fl));
      tube(g, [lt, lerp3(lt, fe, 0.5), fe], [radii[segs] * 0.8, radii[segs] * 0.4, 0.01], 3, mat, col, bw, [1, 0.5], false);
      leafAt(lerp3(lt, fe, 0.5), fd, 0.95);
      leafAt(fe, norm(add(fd, [0, 0.3, 0])), 1.0);
    }
    return g;
  }

  /**
   * Spruce (Norway-spruce habit): a straight, strongly tapered trunk with dead stubs below
   * the crown; whorls of branches that sag and then sweep their tips upward; each branch
   * clothed with a flat main spray, paired lateral sprays, hanging "curtain" branchlets and
   * an upturned tip. The crown is a narrow cone with a slightly convex skirt and a sharp
   * leader, dense enough that the trunk disappears a metre above the ground.
   */
  function makeConifer(rng, opt) {
    var g = new Geo();
    var H = opt.height;
    var windH = function (p) { return [U.clamp01(p[1] / H), 0]; };
    var pts = [], radii = [], sweep = [(rng() - 0.5) * 0.25, (rng() - 0.5) * 0.25];
    for (var i = 0; i <= 10; i++) {
      var t = i / 10;
      pts.push([sweep[0] * t * t + (rng() - 0.5) * 0.04, t * H, sweep[1] * t * t + (rng() - 0.5) * 0.04]);
      radii.push(opt.radius * Math.pow(1 - t * 0.96, 1.15) * (i === 0 ? 1.3 : 1));
    }
    tube(g, pts, radii, 8, MAT.BARK, opt.barkCol, windH, [1, 0.3], false);
    function trunkAt(y) { return pointOnPolyline(pts, U.clamp01(y / H)); }
    // dead branch stubs on the bare lower trunk
    for (var k = 0; k < 7; k++) {
      var sy = 0.5 + rng() * Math.max(0.2, opt.crownBase - 0.5), sa = rng() * Math.PI * 2;
      var sp = trunkAt(sy), sd = norm([Math.cos(sa), -0.25 - rng() * 0.3, Math.sin(sa)]);
      tube(g, [sp, add(sp, scl(sd, 0.25 + rng() * 0.6))], [0.03, 0.006], 3, MAT.BARK, [100, 90, 82], windH, [1, 1], false);
    }
    var crownC = [0, (opt.crownBase + H) * 0.55, 0];
    var y = opt.crownBase, whorl = 0;
    var pendant = opt.pendant === undefined ? 0.8 : opt.pendant;
    while (y < H - 0.7) {
      var t2 = (y - opt.crownBase) / (H - opt.crownBase);
      // crown profile: convex skirt, straight cone, sharp spire
      var R = opt.crownR * Math.pow(1 - t2, 0.82) * (0.82 + 0.18 * Math.min(1, t2 / 0.12)) + 0.22;
      var n = Math.max(4, Math.round(opt.perWhorl * (1 - t2 * 0.4)));
      var base = trunkAt(y);
      for (var b = 0; b < n; b++) {
        var az = b / n * Math.PI * 2 + whorl * 0.62 + rng() * 0.5;
        var hd = [Math.cos(az), 0, Math.sin(az)];
        var sag = opt.droop * (1.1 - t2) * (0.8 + rng() * 0.4);
        var curl = 0.18 + 0.25 * (1 - t2) + rng() * 0.1;
        var len = R * (0.85 + rng() * 0.3);
        // sag first, then the tip sweeps up (classic spruce branch)
        var bp = [base,
          add(base, add(scl(hd, len * 0.33), [0, -sag * len * 0.14 + 0.08 * t2 * len, 0])),
          add(base, add(scl(hd, len * 0.68), [0, -sag * len * 0.24 + 0.1 * t2 * len, 0])),
          add(base, add(scl(hd, len), [0, -sag * len * 0.2 + curl * len * 0.25 + 0.12 * t2 * len, 0]))];
        var bwf = (function (L) { return function (p) { return [U.clamp01(p[1] / H), U.clamp01(Math.hypot(p[0], p[2]) / Math.max(L, 0.5))]; }; })(len);
        var r0 = opt.radius * 0.17 * (1 - t2 * 0.6);
        tube(g, bp, [r0, r0 * 0.62, r0 * 0.32, 0.008], 3, MAT.BARK, opt.barkCol, bwf, [1, 1], false);
        var w0 = [U.clamp01(y / H), 0.8];
        var lc = jit(opt.leafCol, rng, 0.6);
        var bd = norm(sub(bp[3], bp[0]));
        var side = norm(cross(bd, [0, 1, 0]));
        var sw = len * 0.55 + 0.28;
        // flat main spray along the branch (seen from above and below)
        sprig(g, bp[0], bd, len * 1.04, sw, 0.25 + (rng() - 0.5) * 0.4, norm(sub(bp[2], crownC)), opt.leafLayer, w0, lc);
        // paired lateral sprays
        for (var q = 0; q < 2; q++) {
          var tq = q ? 0.62 : 0.32, mp = pointOnPolyline(bp, tq);
          var ll = len * (q ? 0.42 : 0.55);
          sprig(g, mp, norm(add(add(bd, scl(side, 0.85)), [0, 0.05 - 0.2 * sag, 0])), ll, sw * 0.62, 0.2 + rng() * 0.3, norm(sub(mp, crownC)), opt.leafLayer, w0, lc);
          sprig(g, mp, norm(add(sub(bd, scl(side, 0.85)), [0, 0.05 - 0.2 * sag, 0])), ll, sw * 0.62, -0.2 - rng() * 0.3, norm(sub(mp, crownC)), opt.leafLayer, w0, lc);
        }
        // hanging curtain branchlets (vertical cards facing outward) — give the side view its mass
        if (pendant > 0 && len > 0.7) {
          for (var c2 = 0; c2 < 2; c2++) {
            if (rng() > pendant) continue;
            var tp2 = 0.4 + c2 * 0.3, pp = pointOnPolyline(bp, tp2);
            var pl = len * (0.42 + rng() * 0.15) * (1 - t2 * 0.4);
            sprig(g, add(pp, [0, 0.04, 0]), norm(add([0, -1, 0], scl(bd, 0.35))), pl, sw * 0.55, Math.PI * 0.5 + (rng() - 0.5) * 0.5, norm(sub(pp, crownC)), opt.leafLayer, w0, lc);
          }
        }
        // upturned tip
        sprig(g, bp[2], norm(add(bd, [0, 0.55 + curl, 0])), len * 0.42, sw * 0.6, 0.3 + rng() * 0.8, norm(sub(bp[3], crownC)), opt.leafLayer, w0, lc);
      }
      y += opt.whorlStep * (0.85 + rng() * 0.3) * (1 - t2 * 0.25);
      whorl++;
    }
    // leader: a crossed spire of upward sprays
    var tipB = trunkAt(H - 1.5);
    for (var k2 = 0; k2 < 4; k2++) sprig(g, tipB, norm([Math.cos(k2 * 1.57) * 0.12, 1, Math.sin(k2 * 1.57) * 0.12]), 1.75, 0.6, k2 * 0.8, [0, 1, 0], opt.leafLayer, [1, 0.5], opt.leafCol);
    return g;
  }

  /** Pine: tall bare trunk; upper branches split into shoots ending in radiating needle tufts. */
  function makePine(rng, opt) {
    var g = new Geo(), H = opt.height;
    var windH = function (p) { return [U.clamp01(p[1] / H), 0]; };
    var pts = [], radii = [], lean = (rng() - 0.5) * 0.4;
    for (var i = 0; i <= 8; i++) { var t = i / 8; pts.push([lean * t * t * 1.5 + (rng() - 0.5) * 0.1, t * H * 0.94, (rng() - 0.5) * 0.1]); radii.push(opt.radius * (1 - t * 0.8)); }
    tube(g, pts, radii, 7, MAT.BARK, [150, 110, 85], windH, [1, 0.3], false);
    var crownC = [pts[8][0], H * 0.8, pts[8][2]];
    var tuft = function (p, sz) { leafCluster(g, p, sz, crownC, 5, [U.clamp01(p[1] / H), 0.85], rng, [205, 215, 195], 4); };
    var NB = opt.branches || 15;
    for (var b = 0; b < NB; b++) {
      var y0 = H * (0.52 + 0.4 * b / NB), az = b * 2.39996 + rng();
      var base = pointOnPolyline(pts, y0 / (H * 0.94));
      var dir = norm([Math.cos(az), 0.3 + rng() * 0.35, Math.sin(az)]);
      var len = (2.0 + rng() * 1.6) * (1.25 - b / (NB * 1.18));
      var bp = limb(rng, base, dir, len, 3, 0.08, 0.3);
      tube(g, bp, [opt.radius * 0.3, opt.radius * 0.22, opt.radius * 0.13, 0.03], 4, MAT.BARK, [150, 110, 85], function (p) { return [U.clamp01(p[1] / H), 0.6]; }, [1, 0.5], false);
      tuft(bp[3], 0.95 + rng() * 0.35);
      tuft(bp[2], 0.8 + rng() * 0.3);
      // two forks with tufts
      for (var f = 0; f < 3; f++) {
        var fp = pointOnPolyline(bp, 0.35 + f * 0.22), fd = norm(add(dirOnPolyline(bp, 0.5), [(rng() - 0.5) * 1.4, 0.45, (rng() - 0.5) * 1.4]));
        var fe = add(fp, scl(fd, len * 0.35));
        tube(g, [fp, fe], [0.04, 0.015], 3, MAT.BARK, [150, 110, 85], function (p) { return [U.clamp01(p[1] / H), 0.7]; }, [1, 0.5], false);
        tuft(fe, 0.75 + rng() * 0.3);
      }
    }
    tuft(pts[8], 1.0);
    return g;
  }

  function makePalm(rng, opt) {
    var g = new Geo(), H = opt.height;
    var windH = function (p) { return [U.clamp01(p[1] / H), 0]; };
    var pts = [], radii = [], bend = 1.2 + rng() * 1.5, az = rng() * Math.PI * 2;
    for (var i = 0; i <= 10; i++) { var t = i / 10; var off = bend * t * t; pts.push([Math.cos(az) * off, t * H, Math.sin(az) * off]); radii.push(0.22 * (1 - t * 0.3) * (1 + 0.08 * Math.sin(i * 3.1))); }
    tube(g, pts, radii, 8, MAT.BARK, [170, 150, 120], windH, [1, 0.8], false);
    var top = pts[10];
    var crownC = add(top, [0, -0.5, 0]);
    var nf = 11;
    for (var f = 0; f < nf; f++) {
      var a = f / nf * Math.PI * 2 + rng() * 0.3;
      var d = [Math.cos(a), 0.55 - rng() * 0.3, Math.sin(a)];
      var L = 3.2 + rng() * 1.2;
      // frond as a bending strip of cards
      var prev = top.slice(), dir = norm(d);
      for (var s = 0; s < 4; s++) {
        dir = norm(add(dir, [0, -0.28, 0]));
        var next = add(prev, scl(dir, L / 4));
        var side = norm(cross(dir, [0, 1, 0]));
        var c = lerp3(prev, next, 0.5);
        var w = [U.clamp01(c[1] / H), 0.5 + s * 0.15];
        var u = scl(sub(next, prev), 0.5), v = scl(side, 0.75 - s * 0.1);
        var n = norm(add(cross(u, v), [0, 0.6, 0]));
        var p0 = sub(prev, v), p1 = add(prev, v), p2 = add(next, v), p3 = sub(next, v);
        var ia = g.vert(p0, n, [0, s / 4], [230, 240, 210], MAT.LEAF, [w[0], w[1], 0.4, 3]);
        var ib = g.vert(p1, n, [1, s / 4], [230, 240, 210], MAT.LEAF, [w[0], w[1], 0.4, 3]);
        var ic = g.vert(p2, n, [1, (s + 1) / 4], [230, 240, 210], MAT.LEAF, [w[0], w[1], 1, 3]);
        var id = g.vert(p3, n, [0, (s + 1) / 4], [230, 240, 210], MAT.LEAF, [w[0], w[1], 1, 3]);
        g.quad(ia, ib, ic, id);
        prev = next;
      }
    }
    return g;
  }

  function makeAcacia(rng, opt) {
    var g = new Geo(), H = opt.height;
    var windH = function (p) { return [U.clamp01(p[1] / H), 0]; };
    var trunkTop = H * 0.45;
    tube(g, [[0, 0, 0], [0.1, trunkTop * 0.5, 0.05], [0.15, trunkTop, 0]], [0.28, 0.22, 0.18], 7, MAT.BARK, [120, 100, 85], windH, [1, 0.4], false);
    var crownY = H * 0.85, crownC = [0, crownY - 0.6, 0];
    var bwf = function (p) { return [U.clamp01(p[1] / H), U.clamp01(Math.hypot(p[0], p[2]) / 4.5)]; };
    for (var b = 0; b < 6; b++) {
      var a = b / 6 * Math.PI * 2 + rng() * 0.6;
      var end = [Math.cos(a) * (1.8 + rng() * 1.0), crownY - 0.4 - rng() * 0.5, Math.sin(a) * (1.8 + rng() * 1.0)];
      var mid = [end[0] * 0.4, (trunkTop + crownY) * 0.5, end[2] * 0.4];
      tube(g, [[0.15, trunkTop, 0], mid, end], [0.14, 0.09, 0.05], 4, MAT.BARK, [120, 100, 85], bwf, [1, 0.5], false);
      // horizontal shoots fan out to form the flat umbrella; sprigs lie flat along them
      for (var s2 = 0; s2 < 4; s2++) {
        var sa = a + (s2 - 1.5) * 0.45 + (rng() - 0.5) * 0.2;
        var sd = norm([Math.cos(sa), 0.08 + rng() * 0.06, Math.sin(sa)]);
        var sl = 1.4 + rng() * 1.3;
        var se = add(end, scl(sd, sl));
        tube(g, [end, lerp3(end, se, 0.5), se], [0.045, 0.025, 0.01], 3, MAT.BARK, [120, 100, 85], bwf, [1, 0.5], false);
        for (var q = 0; q < 3; q++) {
          var sp = lerp3(end, se, 0.2 + q * 0.3);
          var ld = norm(add(sd, [(rng() - 0.5) * 0.9, 0.05, (rng() - 0.5) * 0.9]));
          var w = bwf(sp);
          sprig(g, sp, ld, 1.25 + rng() * 0.4, 1.05, (rng() - 0.5) * 0.5, [0, 1, 0], 4, [w[0], 0.8], [220, 215, 170]);
          sprig(g, add(sp, [0, -0.08, 0]), norm(add(ld, [0, -0.35, 0])), 0.9, 0.8, Math.PI * 0.5 + (rng() - 0.5) * 0.6, norm(sub(sp, crownC)), 4, [w[0], 0.8], [220, 215, 170]);
        }
      }
    }
    return g;
  }

  function makeDead(rng, opt) {
    var g = new Geo(), H = opt.height;
    var windH = function (p) { return [U.clamp01(p[1] / H) * 0.4, 0]; };
    var pts = [], radii = [];
    for (var i = 0; i <= 6; i++) { var t = i / 6; pts.push([(rng() - 0.5) * 0.3 * t, t * H, (rng() - 0.5) * 0.3 * t]); radii.push(0.3 * (1 - t * 0.85)); }
    tube(g, pts, radii, 7, MAT.BARK, [130, 125, 118], windH, [1, 0.35], true);
    for (var b = 0; b < 7; b++) {
      var t0 = 0.35 + 0.6 * b / 7, bp = pts[Math.floor(t0 * 6)];
      var a = b * 2.3 + rng();
      var d = norm([Math.cos(a), 0.5 + rng() * 0.6, Math.sin(a)]);
      var L = (1.2 + rng() * 2) * (1.2 - t0 * 0.6);
      var e = add(bp, scl(d, L));
      tube(g, [bp, lerp3(bp, e, 0.5), e], [radii[Math.floor(t0 * 6)] * 0.4, 0.05, 0.015], 4, MAT.BARK, [130, 125, 118], function (p) { return [U.clamp01(p[1] / H) * 0.4, 0.4]; }, [1, 0.5], false);
      var a2 = a + (rng() - 0.5) * 1.5, e2 = add(e, scl(norm([Math.cos(a2), 0.8, Math.sin(a2)]), L * 0.5));
      tube(g, [e, e2], [0.03, 0.008], 3, MAT.BARK, [130, 125, 118], function (p) { return [U.clamp01(p[1] / H) * 0.4, 0.5]; }, [1, 0.5], false);
    }
    return g;
  }

  function makeCactus(rng, opt) {
    var g = new Geo(), H = opt.height;
    var windH = function () { return [0, 0]; };
    function column(base, dir, len, r0) {
      var pts = [], radii = [];
      for (var i = 0; i <= 6; i++) { var t = i / 6; pts.push(add(base, scl(dir, len * t))); radii.push(r0 * (i === 6 ? 0.55 : (1 - 0.1 * t))); }
      // ribbed: modulate radius per segment via many sides
      tube(g, pts, radii, 14, MAT.CACTUS, [255, 255, 255], windH, [7, 0.5], true);
    }
    column([0, 0, 0], [0, 1, 0], H, 0.32);
    var arms = 1 + Math.floor(rng() * 3);
    for (var a = 0; a < arms; a++) {
      var az = a * 2.1 + rng(), y = H * (0.35 + rng() * 0.3);
      var out = [Math.cos(az), 0, Math.sin(az)];
      var start = add([0, y, 0], scl(out, 0.2));
      var elbow = add(start, scl(out, 0.55 + rng() * 0.3));
      tube(g, [start, add(lerp3(start, elbow, 0.5), [0, 0.05, 0]), elbow], [0.2, 0.2, 0.2], 12, MAT.CACTUS, [255, 255, 255], windH, [6, 0.5], false);
      column(elbow, [0, 1, 0], H * (0.25 + rng() * 0.25), 0.2);
    }
    return g;
  }

  /* ---------------- rocks ---------------- */
  function icosphere(sub) {
    var t = (1 + Math.sqrt(5)) / 2;
    var verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(norm);
    var faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    for (var s = 0; s < sub; s++) {
      var cache = {}, nf = [];
      var mid = function (a, b) { var k = a < b ? a + '_' + b : b + '_' + a; if (cache[k] !== undefined) return cache[k]; verts.push(norm(scl(add(verts[a], verts[b]), 0.5))); return (cache[k] = verts.length - 1); };
      faces.forEach(function (f) { var a = mid(f[0], f[1]), b = mid(f[1], f[2]), c = mid(f[2], f[0]); nf.push([f[0], a, c], [f[1], b, a], [f[2], c, b], [a, b, c]); });
      faces = nf;
    }
    return { verts: verts, faces: faces };
  }
  function makeRock(rng, opt) {
    var g = new Geo(), ico = icosphere(opt.sub || 2);
    var core = TERRA.core, seed = Math.floor(rng() * 1e6);
    var sx = 1 + rng() * 0.6, sy = 0.55 + rng() * 0.35, sz = 0.8 + rng() * 0.5;
    // A fractured chunk: the intersection of random half-spaces (flat joint faces), with
    // softly rounded (weathered) edges, low-frequency lumpiness and fine surface noise.
    var planes = [], np = 9 + Math.floor(rng() * 6);
    for (var k = 0; k < np; k++) {
      var pn = norm([rng() * 2 - 1, (rng() * 2 - 1) * 0.8, rng() * 2 - 1]);
      planes.push([pn, 0.72 + rng() * 0.3]);
    }
    planes.push([[0, 1, 0], 0.8 + rng() * 0.2]);              // weathered top
    var sharp = opt.round ? 5 : 11 + rng() * 6;
    var P = ico.verts.map(function (v) {
      var acc = 0;
      for (var q = 0; q < planes.length; q++) {
        var dn = dotp(v, planes[q][0]);
        if (dn > 0.04) acc += Math.exp(-sharp * planes[q][1] / dn);
      }
      acc += Math.exp(-sharp * 1.12);                           // cap at the circumscribed sphere
      var r = -Math.log(acc) / sharp;
      r *= 1 + core.fbm(v[0] * 1.3 + 3, v[2] * 1.3 + v[1] * 0.7, 3, seed) * 0.12 + core.fbm(v[1] * 4.5 + 1, v[0] * 4.5 - v[2], 3, seed + 7) * 0.035;
      var p = [v[0] * r * sx, v[1] * r * sy, v[2] * r * sz];
      if (p[1] < -0.2) p[1] = -0.2 - (p[1] + 0.2) * 0.25;
      return p;
    });
    // accumulate smooth vertex normals, keep a hint of the facet normal for crisp edges
    var acc = P.map(function () { return [0, 0, 0]; });
    ico.faces.forEach(function (f) {
      var n = cross(sub(P[f[1]], P[f[0]]), sub(P[f[2]], P[f[0]]));
      for (var k = 0; k < 3; k++) { acc[f[k]][0] += n[0]; acc[f[k]][1] += n[1]; acc[f[k]][2] += n[2]; }
    });
    var ids = P.map(function (p, i) {
      var shade = 205 + 50 * U.clamp01(0.5 + p[1] * 0.5);   // darker underside (baked AO)
      var col = [opt.col[0] * shade / 255, opt.col[1] * shade / 255, opt.col[2] * shade / 255];
      return g.vert(p, norm(acc[i]), [p[0], p[2]], col, MAT.ROCK, [0, 0, 0, 0]);
    });
    ico.faces.forEach(function (f) { g.tri(ids[f[0]], ids[f[1]], ids[f[2]]); });
    return g;
  }

  /* ---------------- ground props ---------------- */
  function makeBush(rng, opt) {
    var g = new Geo();
    var C = [0, opt.r * 0.7, 0];
    var bwf = function (p) { return [U.clamp01(p[1] / (opt.r * 2)), 0.3 + U.clamp01(Math.hypot(p[0], p[2]) / opt.r) * 0.5]; };
    var stems = 7 + Math.floor(rng() * 3);
    for (var b = 0; b < stems; b++) {
      var a = b / stems * Math.PI * 2 + rng() * 0.5;
      var d = norm([Math.cos(a) * (0.5 + rng() * 0.4), 0.9 + rng() * 0.5, Math.sin(a) * (0.5 + rng() * 0.4)]);
      var L = opt.r * (1.0 + rng() * 0.6);
      var sp = limb(rng, [(rng() - 0.5) * 0.1, 0, (rng() - 0.5) * 0.1], d, L, 3, -0.12, 0.4);
      tube(g, sp, [0.035, 0.025, 0.015, 0.006], 3, MAT.BARK, [120, 100, 80], bwf, [1, 1], false);
      var n = Math.round(opt.clusters / stems * 2) + 1;
      for (var i = 0; i < n; i++) {
        var t = 0.3 + 0.7 * (i + rng() * 0.5) / n;
        var p = pointOnPolyline(sp, t), dd = dirOnPolyline(sp, t);
        var ld = norm(add(add(scl(dd, 0.5), scl(norm(sub(p, C)), 0.8)), [(rng() - 0.5) * 0.5, 0.1, (rng() - 0.5) * 0.5]));
        sprig(g, p, ld, opt.leaf * 1.25 * (0.8 + rng() * 0.4), opt.leaf * 1.05, rng() * Math.PI * 2, norm(sub(p, C)), opt.layer, bwf(p), opt.col);
      }
      sprig(g, sp[3], dirOnPolyline(sp, 1), opt.leaf * 1.2, opt.leaf, rng() * Math.PI * 2, norm(sub(sp[3], C)), opt.layer, bwf(sp[3]), opt.col);
    }
    return g;
  }
  function makeFern(rng) {
    var g = new Geo();
    var n = 9;
    for (var f = 0; f < n; f++) {
      var a = f / n * Math.PI * 2 + rng() * 0.4;
      var L = 0.7 + rng() * 0.4;
      var prev = [0, 0.02, 0], dir = norm([Math.cos(a), 0.9, Math.sin(a)]);
      for (var s = 0; s < 3; s++) {
        dir = norm(add(dir, [0, -0.45, 0]));
        var next = add(prev, scl(dir, L / 3));
        var side = norm(cross(dir, [0, 1, 0]));
        var v = scl(side, 0.17 - s * 0.03);
        var nn = [0, 1, 0];
        var ia = g.vert(sub(prev, v), nn, [0, s / 3], [255, 255, 255], MAT.LEAF, [s * 0.3, 0.5, 0.3, 3]);
        var ib = g.vert(add(prev, v), nn, [1, s / 3], [255, 255, 255], MAT.LEAF, [s * 0.3, 0.5, 0.3, 3]);
        var ic = g.vert(add(next, v), nn, [1, (s + 1) / 3], [255, 255, 255], MAT.LEAF, [(s + 1) * 0.3, 0.5, 1, 3]);
        var id = g.vert(sub(next, v), nn, [0, (s + 1) / 3], [255, 255, 255], MAT.LEAF, [(s + 1) * 0.3, 0.5, 1, 3]);
        g.quad(ia, ib, ic, id);
        prev = next;
      }
    }
    return g;
  }
  /** Cut / broken wood face: a disc whose UVs map the radius (growth rings in the shader).
   *  `jag` > 0 splinters the rim (broken rather than sawn). */
  function capDisc(g, c, axis, r, segs, col, mat, jag) {
    var a = norm(axis), s = perp(a), t = cross(a, s), ring = [], ctr = g.vert(c, a, [0.5, 0.5], col, mat, [0, 0, 0, 0]);
    for (var k = 0; k <= segs; k++) {
      var an = k / segs * Math.PI * 2, ca = Math.cos(an), sa = Math.sin(an);
      var off = jag ? (Math.sin(an * 5 + jag * 40) * 0.5 + 0.5) * jag * r * 1.4 : 0;
      var p = add(add(c, add(scl(s, ca * r), scl(t, sa * r))), scl(a, off));
      ring.push(g.vert(p, a, [0.5 + ca * 0.5, 0.5 + sa * 0.5], col, mat, [0, 0, 0, 0]));
    }
    for (k = 0; k < segs; k++) g.tri(ctr, ring[k], ring[k + 1]);
  }
  /** Fallen log (bark, taper, bend, sawn or broken ends, branch stubs, moss, half sunk) or stump
   *  (root flare, cut or snapped top with growth rings, bracket fungi). */
  function makeLog(rng, stump) {
    var g = new Geo(), still = function () { return [0, 0]; };
    var bark = [130 + Math.floor(rng() * 30), 110 + Math.floor(rng() * 20), 90 + Math.floor(rng() * 15)];
    var grain = [205, 172, 128];
    if (stump) {
      var r = 0.22 + rng() * 0.18, h = 0.3 + rng() * 0.4, snapped = rng() < 0.4;
      tube(g, [[0, -0.3, 0], [0, 0.06, 0], [0, h * 0.6, 0], [0, h, 0]], [r * 1.4, r * 1.15, r * 1.02, r], 12, MAT.BARK, bark, still, [1, 0.5], false);
      var nr = 4 + Math.floor(rng() * 3);
      for (var k = 0; k < nr; k++) {
        var a = k / nr * Math.PI * 2 + rng() * 0.6, l = 1.6 + rng() * 1.2;
        tube(g, [[Math.cos(a) * r * 0.65, 0.16, Math.sin(a) * r * 0.65], [Math.cos(a) * r * 1.5, 0.0, Math.sin(a) * r * 1.5], [Math.cos(a) * r * l * 1.5, -0.18, Math.sin(a) * r * l * 1.5]], [r * 0.45, r * 0.3, r * 0.08], 6, MAT.BARK, bark, still, [1, 0.5], false);
      }
      capDisc(g, [0, h, 0], [0.08 * (rng() - 0.5), 1, 0.08 * (rng() - 0.5)], r * 0.97, 14, grain, MAT.ENDGRAIN, snapped ? 0.25 + rng() * 0.2 : 0);
      if (rng() < 0.5) for (var f = 0; f < 2 + Math.floor(rng() * 3); f++) {       // bracket fungi
        var fa = rng() * Math.PI * 2, fy = 0.1 + rng() * h * 0.7, fr = 0.05 + rng() * 0.06;
        var fc = [Math.cos(fa) * r * 1.05, fy, Math.sin(fa) * r * 1.05];
        capDisc(g, fc, [Math.cos(fa) * 0.3, 1, Math.sin(fa) * 0.3], fr, 7, [190, 160, 110], MAT.SHROOM, 0);
      }
      return g;
    }
    var L = 2.6 + rng() * 3.4, R = 0.18 + rng() * 0.17, bend = (rng() - 0.5) * 0.4;
    var segN = 6, pts = [], radii = [];
    for (var i = 0; i <= segN; i++) {
      var t = i / segN;
      pts.push([-L / 2 + t * L, R * 0.72 + Math.sin(t * Math.PI) * 0.04, Math.sin(t * Math.PI) * bend]);
      radii.push(R * (1.08 - t * 0.3) * (1 + (rng() - 0.5) * 0.06));
    }
    tube(g, pts, radii, 12, MAT.BARK, bark, still, [1, 0.5], false);
    // butt end sawn or snapped, top end broken (splintered)
    capDisc(g, pts[0], [-1, 0, 0], radii[0], 12, grain, MAT.ENDGRAIN, rng() < 0.5 ? 0 : 0.2);
    capDisc(g, pts[segN], sub(pts[segN], pts[segN - 1]), radii[segN], 12, grain, MAT.ENDGRAIN, 0.2 + rng() * 0.25);
    // branch stubs
    for (var b = 0; b < 2 + Math.floor(rng() * 3); b++) {
      var bt = 0.2 + rng() * 0.7, bp = pointOnPolyline(pts, bt), ba = rng() * Math.PI * 2;
      var bd = norm([(rng() - 0.5) * 0.6, Math.cos(ba) * 0.8 + 0.4, Math.sin(ba)]);
      var br = R * (0.2 + rng() * 0.15), be = add(bp, scl(bd, R + 0.12 + rng() * 0.3));
      tube(g, [bp, be], [br, br * 0.8], 6, MAT.BARK, bark, still, [1, 0.5], false);
      capDisc(g, be, bd, br * 0.8, 6, grain, MAT.ENDGRAIN, rng() * 0.3);
    }
    // moss patches as small cards on top
    for (var m = 0; m < 5; m++) { var x = (rng() - 0.5) * L * 0.8; card(g, [x, R * 1.6, (rng() - 0.5) * 0.1], [0.3 + rng() * 0.2, 0, 0], [0, 0.02, 0.2], [0, 1, 0], 0, [0, 0], [110 + Math.floor(rng() * 30), 160, 90]); }
    return g;
  }
  function makeBranch(rng) {
    var g = new Geo(), L = 1.2 + rng() * 1.5;
    tube(g, [[-L / 2, 0.05, 0], [0, 0.08, 0.1], [L / 2, 0.04, 0]], [0.05, 0.04, 0.02], 4, MAT.BARK, [130, 110, 90], function () { return [0, 0]; }, [1, 1], false);
    tube(g, [[0, 0.08, 0.1], [0.3, 0.1, 0.5]], [0.025, 0.01], 3, MAT.BARK, [130, 110, 90], function () { return [0, 0]; }, [1, 1], false);
    return g;
  }
  function makeMushrooms(rng) {
    var g = new Geo();
    var n = 3 + Math.floor(rng() * 4);
    for (var i = 0; i < n; i++) {
      var x = (rng() - 0.5) * 0.4, z = (rng() - 0.5) * 0.4, h = 0.06 + rng() * 0.1, r = 0.04 + rng() * 0.06;
      tube(g, [[x, 0, z], [x, h, z]], [0.012, 0.01], 5, MAT.SHROOM, [235, 225, 205], function () { return [0, 0]; }, [1, 1], false);
      var cap = [x, h, z];
      var red = rng() < 0.3;
      var col = red ? [200, 40, 30] : [150, 100, 60];
      var ring = [];
      for (var s = 0; s <= 8; s++) { var a = s / 8 * Math.PI * 2; ring.push(g.vert([x + Math.cos(a) * r, h - r * 0.25, z + Math.sin(a) * r], norm([Math.cos(a), 0.6, Math.sin(a)]), [s / 8, 0], col, MAT.SHROOM, [0, 0, 0, 0])); }
      var top = g.vert([x, h + r * 0.45, z], [0, 1, 0], [0.5, 1], col, MAT.SHROOM, [0, 0, 0, 0]);
      for (s = 0; s < 8; s++) g.tri(ring[s], top, ring[s + 1]);
      void cap;
    }
    return g;
  }
  function makeReeds(rng) {
    var g = new Geo();
    for (var i = 0; i < 16; i++) {
      var x = (rng() - 0.5) * 0.9, z = (rng() - 0.5) * 0.9, h = 1.0 + rng() * 0.9, a = rng() * Math.PI;
      var w = [Math.cos(a) * 0.03, 0, Math.sin(a) * 0.03], lean = [(rng() - 0.5) * 0.3, 0, (rng() - 0.5) * 0.3];
      var base = [x, -0.2, z], tip = add([x, h, z], lean);
      var n = norm(cross(w, [0, 1, 0]));
      var ia = g.vert(sub(base, w), n, [0, 0], [120, 140, 70], MAT.FERN, [0, 0.5, 0, 0]);
      var ib = g.vert(add(base, w), n, [1, 0], [120, 140, 70], MAT.FERN, [0, 0.5, 0, 0]);
      var ic = g.vert(tip, n, [0.5, 1], [170, 170, 100], MAT.FERN, [1, 0.5, 0.6, 0]);
      g.tri(ia, ib, ic);
      if (rng() < 0.4) { // cattail head
        tube(g, [add(tip, [0, -0.3, 0]), add(tip, [0, -0.08, 0])], [0.025, 0.025], 5, MAT.BARK, [90, 60, 40], function () { return [1, 0.5]; }, [1, 1], true);
      }
    }
    return g;
  }
  function makeFlowers(rng) {
    var g = new Geo();
    var palette = [[230, 210, 60], [220, 80, 90], [240, 240, 240], [150, 110, 220], [240, 140, 50], [80, 120, 230]];
    var col = palette[Math.floor(rng() * palette.length)];
    for (var i = 0; i < 10; i++) {
      var x = (rng() - 0.5) * 0.7, z = (rng() - 0.5) * 0.7, h = 0.2 + rng() * 0.3;
      tube(g, [[x, 0, z], [x + (rng() - 0.5) * 0.05, h, z]], [0.006, 0.005], 3, MAT.FERN, [90, 130, 60], function (p) { return [p[1] / 0.5, 0.5]; }, [1, 1], false);
      var s = 0.035 + rng() * 0.02;
      var c = [x, h, z];
      var n = [0, 1, 0];
      for (var p = 0; p < 5; p++) {
        var a = p / 5 * Math.PI * 2;
        var t0 = add(c, [Math.cos(a) * s * 2, 0.005, Math.sin(a) * s * 2]);
        var t1 = add(c, [Math.cos(a + 0.5) * s, 0.01, Math.sin(a + 0.5) * s]);
        var t2 = add(c, [Math.cos(a - 0.5) * s, 0.01, Math.sin(a - 0.5) * s]);
        var ia = g.vert(c, n, [0, 0], [255, 230, 120], MAT.SHROOM, [h / 0.5, 0.5, 1, 0]);
        var ib = g.vert(t1, n, [1, 0], col, MAT.SHROOM, [h / 0.5, 0.5, 1, 0]);
        var ic = g.vert(t0, n, [1, 1], col, MAT.SHROOM, [h / 0.5, 0.5, 1, 0]);
        var id = g.vert(t2, n, [0, 1], col, MAT.SHROOM, [h / 0.5, 0.5, 1, 0]);
        g.quad(ia, ib, ic, id);
      }
    }
    return g;
  }
  function makeShrubDry(rng) {
    var g = new Geo();
    for (var b = 0; b < 12; b++) {
      var a = rng() * Math.PI * 2, e = [Math.cos(a) * (0.3 + rng() * 0.4), 0.3 + rng() * 0.5, Math.sin(a) * (0.3 + rng() * 0.4)];
      tube(g, [[0, 0, 0], lerp3([0, 0, 0], e, 0.5), e], [0.025, 0.015, 0.005], 3, MAT.BARK, [150, 120, 90], function (p) { return [p[1], 0.5]; }, [1, 1], false);
      if (rng() < 0.7) sprig(g, lerp3([0, 0, 0], e, 0.6), norm(e), 0.32, 0.26, rng() * Math.PI * 2, norm(sub(e, [0, 0.3, 0])), 4, [e[1], 0.6], [200, 190, 130]);
    }
    return g;
  }
  function makeSmallCactus(rng) {
    var g = new Geo();
    if (rng() < 0.5) { // barrel
      var pts = [], radii = [];
      for (var i = 0; i <= 5; i++) { var t = i / 5; pts.push([0, t * 0.55, 0]); radii.push(0.28 * Math.sin(0.35 + t * 2.4) + 0.02); }
      tube(g, pts, radii, 16, MAT.CACTUS, [255, 255, 255], function () { return [0, 0]; }, [8, 1], true);
    } else { // prickly pear pads
      for (var p = 0; p < 6; p++) {
        var c = [(rng() - 0.5) * 0.5, 0.2 + rng() * 0.5, (rng() - 0.5) * 0.5], a = rng() * Math.PI;
        var u = [Math.cos(a) * 0.16, 0, Math.sin(a) * 0.16], v = [0, 0.2, 0];
        var n = norm(cross(u, v));
        var ring = [], cc = g.vert(c, n, [0.5, 0.5], [255, 255, 255], MAT.CACTUS, [0, 0, 0, 0]);
        for (var s = 0; s <= 10; s++) { var ang = s / 10 * Math.PI * 2; ring.push(g.vert(add(c, add(scl(u, Math.cos(ang)), scl(v, Math.sin(ang)))), norm(add(n, scl(add(scl(u, Math.cos(ang)), scl(v, Math.sin(ang))), 2))), [Math.cos(ang), Math.sin(ang)], [255, 255, 255], MAT.CACTUS, [0, 0, 0, 0])); }
        for (s = 0; s < 10; s++) { g.tri(cc, ring[s], ring[s + 1]); g.tri(cc, ring[s + 1], ring[s]); }
      }
    }
    return g;
  }
  function makePebbles(rng) {
    var g = new Geo();
    for (var i = 0; i < 6; i++) {
      var r = makeRock(rng, { sub: 1, col: [200, 195, 185], round: true });
      var s = 0.06 + rng() * 0.12, x = (rng() - 0.5) * 1.2, z = (rng() - 0.5) * 1.2;
      for (var k = 0; k < r.v.length; k += 16) { r.v[k] = r.v[k] * s + x; r.v[k + 1] = r.v[k + 1] * s + s * 0.3; r.v[k + 2] = r.v[k + 2] * s + z; }
      g.append(r);
    }
    return g;
  }
  function makeTumble(rng) {
    var g = new Geo();
    for (var i = 0; i < 26; i++) {
      var a = norm([rng() - 0.5, rng() - 0.5, rng() - 0.5]), b = norm([rng() - 0.5, rng() - 0.5, rng() - 0.5]);
      tube(g, [add(scl(a, 0.35), [0, 0.35, 0]), [0, 0.35, 0], add(scl(b, 0.35), [0, 0.35, 0])], [0.008, 0.01, 0.008], 3, MAT.BARK, [180, 150, 110], function () { return [0.5, 0.5]; }, [1, 1], false);
    }
    return g;
  }

  /* ---------------- structures (points of interest) ---------------- */
  function box(g, c, hx, hy, hz, mat, col, rotA) {
    rotA = rotA || 0;
    var faces = [[[1, 0, 0], [0, 0, 1], [0, 1, 0]], [[-1, 0, 0], [0, 0, -1], [0, 1, 0]], [[0, 1, 0], [1, 0, 0], [0, 0, 1]], [[0, -1, 0], [1, 0, 0], [0, 0, -1]], [[0, 0, 1], [-1, 0, 0], [0, 1, 0]], [[0, 0, -1], [1, 0, 0], [0, 1, 0]]];
    var ext = [hx, hy, hz];
    faces.forEach(function (f) {
      var n = f[0], u = f[1], v = f[2];
      var su = Math.abs(u[0]) * hx + Math.abs(u[1]) * hy + Math.abs(u[2]) * hz, sv = Math.abs(v[0]) * hx + Math.abs(v[1]) * hy + Math.abs(v[2]) * hz;
      var cc = [c[0] + n[0] * ext[0], c[1] + n[1] * ext[1], c[2] + n[2] * ext[2]];
      var pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(function (q) { return rotY(sub(add(cc, add(scl(u, q[0] * su), scl(v, q[1] * sv))), c), rotA); });
      var nr = rotY(n, rotA);
      var ids = pts.map(function (p, k) { return g.vert(add(p, c), nr, [([0, 1, 1, 0][k]) * su, ([0, 0, 1, 1][k]) * sv], col, mat, [0, 0, 0, 0]); });
      g.quad(ids[0], ids[1], ids[2], ids[3]);
    });
  }
  function roof(g, c, w, d, h, mat, col, rotA) {
    // gabled roof along x
    var p = [[-w, 0, -d], [w, 0, -d], [w, 0, d], [-w, 0, d], [-w, h, 0], [w, h, 0]].map(function (q) { return add(rotY(q, rotA), c); });
    var n1 = rotY(norm([0, d, -h]), rotA), n2 = rotY(norm([0, d, h]), rotA);
    var a = g.vert(p[0], n1, [0, 0], col, mat, [0, 0, 0, 0]), b = g.vert(p[1], n1, [w, 0], col, mat, [0, 0, 0, 0]), e = g.vert(p[5], n1, [w, d], col, mat, [0, 0, 0, 0]), f = g.vert(p[4], n1, [0, d], col, mat, [0, 0, 0, 0]);
    g.quad(a, b, e, f);
    a = g.vert(p[2], n2, [0, 0], col, mat, [0, 0, 0, 0]); b = g.vert(p[3], n2, [w, 0], col, mat, [0, 0, 0, 0]); e = g.vert(p[4], n2, [w, d], col, mat, [0, 0, 0, 0]); f = g.vert(p[5], n2, [0, d], col, mat, [0, 0, 0, 0]);
    g.quad(a, b, e, f);
    var n3 = rotY([-1, 0, 0], rotA), n4 = rotY([1, 0, 0], rotA);
    g.tri(g.vert(p[3], n3, [0, 0], col, MAT.WOOD, [0, 0, 0, 0]), g.vert(p[0], n3, [1, 0], col, MAT.WOOD, [0, 0, 0, 0]), g.vert(p[4], n3, [0.5, 1], col, MAT.WOOD, [0, 0, 0, 0]));
    g.tri(g.vert(p[1], n4, [0, 0], col, MAT.WOOD, [0, 0, 0, 0]), g.vert(p[2], n4, [1, 0], col, MAT.WOOD, [0, 0, 0, 0]), g.vert(p[5], n4, [0.5, 1], col, MAT.WOOD, [0, 0, 0, 0]));
  }
  function cabin(g, c, rotA, rng) {
    var w = 2.6 + rng(), d = 2.0 + rng() * 0.6, h = 2.4;
    box(g, add(c, [0, h / 2 - 0.3, 0]), w, h / 2 + 0.3, d, MAT.WOOD, [200, 170, 140], rotA);
    roof(g, add(c, [0, h, 0]), w + 0.4, d + 0.5, 1.7, MAT.THATCH, [190, 160, 120], rotA);
    // door & windows (emissive at night via fire material tint)
    box(g, add(c, rotY([0, 0.9, d + 0.02], rotA)), 0.45, 0.9, 0.03, MAT.WOOD, [110, 80, 60], rotA);
    box(g, add(c, rotY([w * 0.55, 1.4, d + 0.02], rotA)), 0.35, 0.3, 0.03, MAT.FIRE, [255, 190, 110], rotA);
    box(g, add(c, rotY([-w * 0.55, 1.4, d + 0.02], rotA)), 0.35, 0.3, 0.03, MAT.FIRE, [255, 190, 110], rotA);
    // chimney
    box(g, add(c, rotY([w * 0.6, h + 1.3, 0], rotA)), 0.3, 0.9, 0.3, MAT.STONE, [200, 195, 185], rotA);
  }

  function makeStructure(type, rng) {
    var g = new Geo(), i, a;
    var POI = TERRA.core.POI;
    if (type === POI.RUINS) {
      var W = 7 + rng() * 5, D = 5 + rng() * 4;
      var walls = [[0, -D, W, 0], [0, D, W, 0], [-W, 0, D, 1], [W, 0, D, 1]];
      walls.forEach(function (wl, k) {
        var len = wl[2], vertical = wl[3];
        var segs = Math.ceil(len * 2 / 1.6);
        for (var s = 0; s < segs; s++) {
          if (rng() < 0.22) continue;
          var t = (s + 0.5) / segs * 2 - 1;
          var hh = (0.5 + rng() * 2.6) * (k === 0 ? 1.2 : 1);
          var cx = vertical ? wl[0] : t * len, cz = vertical ? t * len : wl[1];
          box(g, [cx, hh / 2 - 0.2, cz], vertical ? 0.4 : 0.82, hh / 2 + 0.2, vertical ? 0.82 : 0.4, MAT.STONE, [210 - rng() * 30, 205 - rng() * 30, 190 - rng() * 30], 0);
        }
      });
      for (i = 0; i < 4; i++) { var px = (i % 2 ? 1 : -1) * W * 0.5, pz = (i < 2 ? 1 : -1) * D * 0.3, ph = 2 + rng() * 3.5; tube(g, [[px, -0.2, pz], [px, ph, pz]], [0.45, 0.4], 10, MAT.STONE, [220, 215, 200], function () { return [0, 0]; }, [2, 0.5], true); }
      for (i = 0; i < 8; i++) { var r = makeRock(rng, { sub: 1, col: [205, 200, 190] }); var s = 0.3 + rng() * 0.5, x = (rng() - 0.5) * W * 2.4, z = (rng() - 0.5) * D * 2.4; for (var k2 = 0; k2 < r.v.length; k2 += 16) { r.v[k2] = r.v[k2] * s + x; r.v[k2 + 1] = r.v[k2 + 1] * s; r.v[k2 + 2] = r.v[k2 + 2] * s + z; r.v[k2 + 11] = MAT.STONE; } g.append(r); }
    } else if (type === POI.CAMP) {
      // tent
      var tp = [[-1.3, 0, -1.2], [1.3, 0, -1.2], [1.3, 0, 1.2], [-1.3, 0, 1.2], [-1.3, 1.6, 0], [1.3, 1.6, 0]];
      var tc = [[60, 110, 80], [200, 120, 50], [60, 90, 150]][Math.floor(rng() * 3)];
      var n1 = norm([0, 1.2, -1.6]), n2 = norm([0, 1.2, 1.6]);
      g.quad(g.vert(tp[0], n1, [0, 0], tc, MAT.CLOTH, [0, 0.2, 0, 0]), g.vert(tp[1], n1, [1, 0], tc, MAT.CLOTH, [0, 0.2, 0, 0]), g.vert(tp[5], n1, [1, 1], tc, MAT.CLOTH, [0.3, 0.2, 0.3, 0]), g.vert(tp[4], n1, [0, 1], tc, MAT.CLOTH, [0.3, 0.2, 0.3, 0]));
      g.quad(g.vert(tp[2], n2, [0, 0], tc, MAT.CLOTH, [0, 0.2, 0, 0]), g.vert(tp[3], n2, [1, 0], tc, MAT.CLOTH, [0, 0.2, 0, 0]), g.vert(tp[4], n2, [1, 1], tc, MAT.CLOTH, [0.3, 0.2, 0.3, 0]), g.vert(tp[5], n2, [0, 1], tc, MAT.CLOTH, [0.3, 0.2, 0.3, 0]));
      g.tri(g.vert(tp[1], [1, 0, 0], [0, 0], tc, MAT.CLOTH, [0, 0, 0, 0]), g.vert(tp[2], [1, 0, 0], [1, 0], tc, MAT.CLOTH, [0, 0, 0, 0]), g.vert(tp[5], [1, 0, 0], [0.5, 1], tc, MAT.CLOTH, [0, 0, 0, 0]));
      // campfire ring
      var fc = [3.2, 0, 1.0];
      for (i = 0; i < 9; i++) { a = i / 9 * Math.PI * 2; var rk = makeRock(rng, { sub: 1, col: [150, 145, 140] }); for (var k3 = 0; k3 < rk.v.length; k3 += 16) { rk.v[k3] = rk.v[k3] * 0.18 + fc[0] + Math.cos(a) * 0.6; rk.v[k3 + 1] = rk.v[k3 + 1] * 0.15 + 0.05; rk.v[k3 + 2] = rk.v[k3 + 2] * 0.18 + fc[2] + Math.sin(a) * 0.6; } g.append(rk); }
      for (i = 0; i < 4; i++) { a = i / 4 * Math.PI * 2 + 0.3; tube(g, [add(fc, [Math.cos(a) * 0.45, 0.05, Math.sin(a) * 0.45]), add(fc, [0, 0.4, 0])], [0.05, 0.03], 5, MAT.BARK, [90, 70, 55], function () { return [0, 0]; }, [1, 1], false); }
      // glowing embers (emissive)
      box(g, add(fc, [0, 0.08, 0]), 0.25, 0.05, 0.25, MAT.FIRE, [255, 120, 40], 0.4);
      // seat logs
      var lg = makeLog(rng); for (var k4 = 0; k4 < lg.v.length; k4 += 16) { var p0 = rotY([lg.v[k4] * 0.45, lg.v[k4 + 1], lg.v[k4 + 2]], 1.2); lg.v[k4] = p0[0] + 4.5; lg.v[k4 + 1] = p0[1]; lg.v[k4 + 2] = p0[2] + 2.4; } g.append(lg);
    } else if (type === POI.VILLAGE) {
      var nh = 3 + Math.floor(rng() * 4);
      for (i = 0; i < nh; i++) { a = i / nh * Math.PI * 2 + rng() * 0.5; var rr = 9 + rng() * 6; cabin(g, [Math.cos(a) * rr, 0, Math.sin(a) * rr], -a + Math.PI / 2, rng); }
      // well
      tube(g, [[0, -0.2, 0], [0, 0.9, 0]], [0.9, 0.9], 12, MAT.STONE, [210, 205, 195], function () { return [0, 0]; }, [3, 0.5], true);
      box(g, [0, 1.8, 0], 1.0, 0.08, 0.2, MAT.WOOD, [160, 130, 100], 0);
      box(g, [-0.9, 1.35, 0], 0.07, 0.5, 0.07, MAT.WOOD, [160, 130, 100], 0); box(g, [0.9, 1.35, 0], 0.07, 0.5, 0.07, MAT.WOOD, [160, 130, 100], 0);
    } else if (type === POI.TOWER) {
      var th = 9 + rng() * 4;
      for (i = 0; i < 4; i++) { var sx = i % 2 ? 1.4 : -1.4, sz = i < 2 ? 1.4 : -1.4; tube(g, [[sx, -0.3, sz], [sx * 0.8, th, sz * 0.8]], [0.16, 0.13], 6, MAT.WOOD, [170, 140, 110], function () { return [0, 0]; }, [1, 0.5], false); }
      for (var lv = 1; lv < 4; lv++) { var y = th * lv / 4; box(g, [0, y, 1.35 - lv * 0.05], 1.4, 0.06, 0.06, MAT.WOOD, [170, 140, 110], 0); box(g, [0, y, -1.35 + lv * 0.05], 1.4, 0.06, 0.06, MAT.WOOD, [170, 140, 110], 0); }
      box(g, [0, th, 0], 1.7, 0.1, 1.7, MAT.WOOD, [180, 150, 120], 0);
      box(g, [0, th + 0.6, 1.65], 1.7, 0.5, 0.05, MAT.WOOD, [170, 140, 110], 0); box(g, [0, th + 0.6, -1.65], 1.7, 0.5, 0.05, MAT.WOOD, [170, 140, 110], 0);
      roof(g, [0, th + 2.2, 0], 1.9, 1.9, 1.2, MAT.THATCH, [190, 160, 120], 0);
      for (i = 0; i < 4; i++) { var cx = i % 2 ? 1.6 : -1.6, cz = i < 2 ? 1.6 : -1.6; box(g, [cx, th + 1.1, cz], 0.08, 1.1, 0.08, MAT.WOOD, [170, 140, 110], 0); }
    } else if (type === POI.STONES) {
      var ns = 9 + Math.floor(rng() * 5), R = 6 + rng() * 3;
      for (i = 0; i < ns; i++) {
        a = i / ns * Math.PI * 2; var hh = 2.2 + rng() * 1.8;
        if (rng() < 0.15) continue;
        box(g, [Math.cos(a) * R, hh / 2 - 0.4, Math.sin(a) * R], 0.45 + rng() * 0.2, hh / 2 + 0.4, 0.3, MAT.STONE, [185, 182, 175], -a);
        if (i % 2 === 0 && rng() < 0.5) { var a2 = (i + 1) / ns * Math.PI * 2; box(g, [Math.cos((a + a2) / 2) * R, hh + 0.1, Math.sin((a + a2) / 2) * R], 1.6, 0.25, 0.35, MAT.STONE, [180, 177, 170], -(a + a2) / 2 + Math.PI / 2); }
      }
      box(g, [0, 0.3, 0], 1.2, 0.35, 0.7, MAT.STONE, [175, 172, 165], rng() * 3);
    } else if (type === POI.ARCH) {
      var span = 10 + rng() * 8, ah = 8 + rng() * 6;
      var pts = [], rad = [];
      for (i = 0; i <= 14; i++) { var t = i / 14; var ang = Math.PI * t; pts.push([-Math.cos(ang) * span / 2, Math.sin(ang) * ah - 0.5, (rng() - 0.5) * 0.3]); rad.push(1.6 + 1.2 * Math.pow(Math.abs(t - 0.5) * 2, 2) + rng() * 0.2); }
      tube(g, pts, rad, 10, MAT.ROCK, [210, 170, 130], function () { return [0, 0]; }, [0.3, 0.1], false);
      for (i = 0; i < 2; i++) { var fr = makeRock(rng, { sub: 2, col: [210, 170, 130] }); var sgn = i ? 1 : -1; for (var k5 = 0; k5 < fr.v.length; k5 += 16) { fr.v[k5] = fr.v[k5] * 3 + sgn * span / 2; fr.v[k5 + 1] = fr.v[k5 + 1] * 3 + 0.5; fr.v[k5 + 2] *= 3; } g.append(fr); }
    } else if (type === POI.CAVE) {
      // rock shell around a dark opening that faces +z (rotated to face downhill)
      var sh = makeRock(rng, { sub: 3, col: [175, 170, 162] });
      var vv = sh.v, keep = [], idx2 = sh.idx;
      for (var k6 = 0; k6 < vv.length; k6 += 16) { vv[k6] *= 9; vv[k6 + 1] = vv[k6 + 1] * 7 + 2.5; vv[k6 + 2] *= 8; }
      // cut the front faces to make an opening
      for (i = 0; i < idx2.length; i += 3) {
        var ia = idx2[i] * 16, ib = idx2[i + 1] * 16, ic = idx2[i + 2] * 16;
        var cz2 = (vv[ia + 2] + vv[ib + 2] + vv[ic + 2]) / 3, cx2 = (vv[ia] + vv[ib] + vv[ic]) / 3, cy2 = (vv[ia + 1] + vv[ib + 1] + vv[ic + 1]) / 3;
        if (cz2 > 3 && Math.abs(cx2) < 4.5 && cy2 < 7.5) continue;
        keep.push(idx2[i], idx2[i + 1], idx2[i + 2]);
      }
      sh.idx = keep;
      g.append(sh);
      // inside (inverted, dark)
      var inner = makeRock(rng, { sub: 2, col: [40, 38, 36] });
      for (var k7 = 0; k7 < inner.v.length; k7 += 16) { inner.v[k7] *= 7.5; inner.v[k7 + 1] = inner.v[k7 + 1] * 5.5 + 2.5; inner.v[k7 + 2] *= 6.5; inner.v[k7 + 3] *= -1; inner.v[k7 + 4] *= -1; inner.v[k7 + 5] *= -1; }
      for (i = 0; i < inner.idx.length; i += 3) { var tmp = inner.idx[i]; inner.idx[i] = inner.idx[i + 1]; inner.idx[i + 1] = tmp; }
      g.append(inner);
    } else if (type === POI.MONOLITH) {
      box(g, [0, 4.5, 0], 1.1, 5, 0.5, MAT.STONE, [70, 72, 78], rng() * 3);
      box(g, [0, 0.2, 0], 2.2, 0.35, 1.6, MAT.STONE, [150, 148, 140], 0);
    } else if (type === POI.SHRINE) {
      box(g, [0, 0.25, 0], 2.2, 0.3, 2.2, MAT.STONE, [200, 195, 185], 0);
      for (i = 0; i < 4; i++) { var qx = i % 2 ? 1.7 : -1.7, qz = i < 2 ? 1.7 : -1.7; tube(g, [[qx, 0.5, qz], [qx, 3.4, qz]], [0.18, 0.16], 8, MAT.STONE, [215, 210, 200], function () { return [0, 0]; }, [1, 0.5], true); }
      roof(g, [0, 3.4, 0], 2.3, 2.3, 1.2, MAT.STONE, [150, 90, 70], 0);
      box(g, [0, 0.95, 0], 0.35, 0.4, 0.35, MAT.STONE, [180, 175, 165], 0);
    }
    return g;
  }
  /** Floating relic (collectible). */
  function makeRelic() {
    var g = new Geo();
    var top = [0, 0.7, 0], bot = [0, -0.7, 0];
    var ring = [];
    for (var s = 0; s < 6; s++) { var a = s / 6 * Math.PI * 2; ring.push([Math.cos(a) * 0.32, 0, Math.sin(a) * 0.32]); }
    for (s = 0; s < 6; s++) {
      var p0 = ring[s], p1 = ring[(s + 1) % 6];
      var n1 = norm(cross(sub(p1, p0), sub(top, p0))), n2 = norm(cross(sub(bot, p0), sub(p1, p0)));
      g.tri(g.vert(p0, n1, [0, 0], [120, 220, 255], MAT.CRYSTAL, [0, 0, 0, 0]), g.vert(top, n1, [0.5, 1], [180, 240, 255], MAT.CRYSTAL, [0, 0, 0, 0]), g.vert(p1, n1, [1, 0], [120, 220, 255], MAT.CRYSTAL, [0, 0, 0, 0]));
      g.tri(g.vert(p0, n2, [0, 0], [120, 220, 255], MAT.CRYSTAL, [0, 0, 0, 0]), g.vert(p1, n2, [1, 0], [120, 220, 255], MAT.CRYSTAL, [0, 0, 0, 0]), g.vert(bot, n2, [0.5, 1], [60, 160, 220], MAT.CRYSTAL, [0, 0, 0, 0]));
    }
    return g;
  }
  /** Low-poly hiker for third-person view. */
  function makeHiker() {
    var g = new Geo();
    var skin = [220, 180, 150], jacket = [180, 70, 50], pants = [60, 70, 80], pack = [70, 90, 60];
    tube(g, [[-0.12, 0, 0], [-0.12, 0.85, 0]], [0.09, 0.1], 6, MAT.CLOTH, pants, function () { return [0, 0]; }, [1, 1], true);
    tube(g, [[0.12, 0, 0], [0.12, 0.85, 0]], [0.09, 0.1], 6, MAT.CLOTH, pants, function () { return [0, 0]; }, [1, 1], true);
    tube(g, [[0, 0.8, 0], [0, 1.45, 0]], [0.2, 0.22], 8, MAT.CLOTH, jacket, function () { return [0, 0]; }, [1, 1], true);
    tube(g, [[-0.27, 1.42, 0], [-0.3, 0.9, 0.05]], [0.07, 0.06], 6, MAT.CLOTH, jacket, function () { return [0, 0]; }, [1, 1], true);
    tube(g, [[0.27, 1.42, 0], [0.3, 0.9, 0.05]], [0.07, 0.06], 6, MAT.CLOTH, jacket, function () { return [0, 0]; }, [1, 1], true);
    tube(g, [[0, 1.48, 0], [0, 1.72, 0]], [0.11, 0.1], 8, MAT.SHROOM, skin, function () { return [0, 0]; }, [1, 1], true);
    box(g, [0, 1.2, -0.28], 0.18, 0.28, 0.1, MAT.CLOTH, pack, 0);
    return g;
  }

  /* ---------------- species table ---------------- */
  var TREE_RECIPES = [
    // CONIFER (spruce)
    function (rng) { return makeConifer(rng, { height: 14 + rng() * 9, radius: 0.3, crownBase: 1.2 + rng() * 1.3, crownR: 2.6 + rng() * 0.9, perWhorl: 7, whorlStep: 0.62, droop: 0.55, pendant: 0.85, leafLayer: 2, barkCol: [112, 92, 80], leafCol: [176, 198, 186] }); },
    // PINE
    function (rng) { return makePine(rng, { height: 15 + rng() * 6, radius: 0.3 }); },
    // OAK
    function (rng) { return makeBroadleaf(rng, { height: 11 + rng() * 5, trunkFrac: 0.4, radius: 0.34, roots: true, branches: 8, branchStart: 0.55, branchAngle: 1.0, branchCurve: 0.1, sub: 5, twigs: 3, twigLen: 0.75, leafSize: 1.0, leafLayer: 0, crownR: 3.9, density: 1.25, barkCol: [125, 110, 95], leafCol: [215, 225, 200] }); },
    // BIRCH (drooping twigs)
    function (rng) { return makeBroadleaf(rng, { height: 12 + rng() * 5, trunkFrac: 0.45, radius: 0.18, branches: 10, branchStart: 0.45, branchAngle: 0.62, branchCurve: 0.14, sub: 4, twigs: 3, twigLen: 0.6, leafSize: 0.8, leafLayer: 1, crownR: 2.5, density: 1.2, droop: 0.55, barkCol: [235, 232, 225], barkMat: MAT.BIRCH, leafCol: [230, 235, 200] }); },
    // PALM
    function (rng) { return makePalm(rng, { height: 8 + rng() * 5 }); },
    // ACACIA
    function (rng) { return makeAcacia(rng, { height: 7 + rng() * 3 }); },
    // DEAD
    function (rng) { return makeDead(rng, { height: 7 + rng() * 5 }); },
    // CACTUS (saguaro)
    function (rng) { return makeCactus(rng, { height: 4 + rng() * 3.5 }); },
    // TROPICAL broadleaf
    function (rng) { return makeBroadleaf(rng, { height: 14 + rng() * 8, trunkFrac: 0.58, radius: 0.36, branches: 7, branchStart: 0.7, branchAngle: 1.2, branchCurve: 0.14, sub: 5, twigs: 3, twigLen: 0.9, leafSize: 1.25, leafLayer: 0, crownR: 4.7, density: 1.25, barkCol: [150, 140, 120], leafCol: [190, 230, 170], roots: true }); },
    // ANCIENT giant
    function (rng) { return makeBroadleaf(rng, { height: 26 + rng() * 8, trunkFrac: 0.42, radius: 1.1, branches: 11, branchStart: 0.5, branchAngle: 1.05, branchCurve: 0.08, sub: 7, twigs: 3, twigLen: 1.4, leafSize: 1.8, leafLayer: 0, crownR: 8, density: 1.3, barkCol: [110, 100, 88], leafCol: [200, 215, 185], roots: true, tubeSegs: 12 }); },
    // BOULDER
    function (rng) { return makeRock(rng, { sub: 3, col: [255, 255, 255] }); }
  ];
  var PROP_RECIPES = [
    function (rng) { return makeBush(rng, { r: 0.9, clusters: 16, leaf: 0.55, layer: rng() < 0.5 ? 0 : 1, col: [210, 225, 200] }); }, // BUSH
    function (rng) { return makeFern(rng); },                                   // FERN
    function (rng) { return makeShrubDry(rng); },                               // SHRUB_DRY
    function (rng) { return makeLog(rng, false); },                             // LOG
    function (rng) { return makeBranch(rng); },                                 // BRANCH
    function (rng) { return makeRock(rng, { sub: 2, col: [255, 255, 255] }); }, // ROCK
    function (rng) { return makePebbles(rng); },                                // PEBBLES
    function (rng) { return makeMushrooms(rng); },                              // MUSHROOM
    function (rng) { return makeReeds(rng); },                                  // REEDS
    function (rng) { return makeSmallCactus(rng); },                            // CACTUS_SMALL
    function (rng) { return makeFlowers(rng); },                                // FLOWERS
    function (rng) { return makeLog(rng, true); },                              // STUMP
    function (rng) { return makeTumble(rng); }                                  // TUMBLE
  ];

  /* ---------------- GPU upload ---------------- */
  var STRIDE = 36;
  function upload(G, geo) {
    var gl = G.gl, n = geo.n;
    var buf = new ArrayBuffer(n * STRIDE), f32 = new Float32Array(buf), i16 = new Int16Array(buf), u8 = new Uint8Array(buf);
    var v = geo.v;
    for (var i = 0; i < n; i++) {
      var s = i * 16, o = i * STRIDE;
      f32[o >> 2] = v[s]; f32[(o >> 2) + 1] = v[s + 1]; f32[(o >> 2) + 2] = v[s + 2];
      var nl = Math.hypot(v[s + 3], v[s + 4], v[s + 5]) || 1;
      i16[(o + 12) >> 1] = v[s + 3] / nl * 32767; i16[((o + 12) >> 1) + 1] = v[s + 4] / nl * 32767; i16[((o + 12) >> 1) + 2] = v[s + 5] / nl * 32767; i16[((o + 12) >> 1) + 3] = 0;
      f32[(o + 20) >> 2] = v[s + 6]; f32[((o + 20) >> 2) + 1] = v[s + 7];
      u8[o + 28] = U.clamp(v[s + 8], 0, 255); u8[o + 29] = U.clamp(v[s + 9], 0, 255); u8[o + 30] = U.clamp(v[s + 10], 0, 255); u8[o + 31] = v[s + 11];
      u8[o + 32] = U.clamp(v[s + 12] * 255, 0, 255); u8[o + 33] = U.clamp(v[s + 13] * 255, 0, 255); u8[o + 34] = U.clamp(v[s + 14] * 255, 0, 255); u8[o + 35] = v[s + 15];
    }
    var vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    var vb = G.buffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.SHORT, true, STRIDE, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, STRIDE, 20);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, STRIDE, 28);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 4, gl.UNSIGNED_BYTE, false, STRIDE, 32);
    var big = n > 65535;
    var ib = G.buffer(gl.ELEMENT_ARRAY_BUFFER, big ? new Uint32Array(geo.idx) : new Uint16Array(geo.idx));
    // per-instance attributes (filled later): vec4 pos+rot, vec4 scale/seed/fade/extra
    var inst = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, inst);
    gl.bufferData(gl.ARRAY_BUFFER, 64, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 4, gl.FLOAT, false, 32, 0); gl.vertexAttribDivisor(5, 1);
    gl.enableVertexAttribArray(6); gl.vertexAttribPointer(6, 4, gl.FLOAT, false, 32, 16); gl.vertexAttribDivisor(6, 1);
    gl.bindVertexArray(null);
    var b = geo.bounds();
    return { vao: vao, vb: vb, ib: ib, inst: inst, instCap: 2, count: geo.idx.length, indexType: big ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, radius: b.radius, height: b.height, bottom: b.bottom, tris: geo.idx.length / 3 };
  }

  /** Build every model. Returns { trees[type][variant], props[type][variant], structures{type}, relic, hiker }. */
  function buildAll(G, quality) {
    var core = TERRA.core;
    var variants = quality >= 2 ? 3 : 2;
    var out = { trees: [], props: [], structures: {}, variants: variants, MAT: MAT };
    // trunks continue 1.5 m below the root collar so trees on slopes never show a gap
    function sinkTrunk(geo) {
      for (var k = 0; k < geo.v.length; k += 16) {
        var m = geo.v[k + 11];
        if ((m === MAT.BARK || m === MAT.BIRCH || m === MAT.CACTUS) && geo.v[k + 1] < 0.05 && Math.hypot(geo.v[k], geo.v[k + 2]) < 1.2) geo.v[k + 1] = -1.5;
      }
      return geo;
    }
    // structure foundations run 3 m into the ground (buildings on slopes sit on a plinth, never hover)
    function foundations(geo) {
      for (var k = 0; k < geo.v.length; k += 16) if (geo.v[k + 1] < 0.05) geo.v[k + 1] = Math.min(geo.v[k + 1], -3.0);
      return geo;
    }
    out._foundations = foundations;
    out.treesLod = [];
    TREE_RECIPES.forEach(function (fn, t) {
      out.trees[t] = []; out.treesLod[t] = [];
      for (var v = 0; v < variants; v++) {
        try { var tg = fn(core.makeRng(1000 + t * 31 + v * 7)); out.trees[t][v] = upload(G, t === 10 ? tg : sinkTrunk(tg)); }
        catch (e) { U.warn('Tree model failed, using fallback', t, e); out.trees[t][v] = upload(G, makeRock(core.makeRng(t), { sub: 1, col: [255, 255, 255] })); }
        // reduced mesh for the middle distance (same tree, ~half the cards, enlarged)
        if (t !== 10 && out.trees[t][v]) {
          try {
            LOD.keep = 0.5; LOD.grow = 1.3; LOD.seg = 0.6; LOD.cnt = 0;
            var tl = fn(core.makeRng(1000 + t * 31 + v * 7));
            out.treesLod[t][v] = upload(G, sinkTrunk(tl));
          } catch (e2) { out.treesLod[t][v] = out.trees[t][v]; }
          LOD.keep = 1; LOD.grow = 1; LOD.seg = 1; LOD.cnt = 0;
          // impostor baking and footprints use the full mesh's bounds
          out.treesLod[t][v].height = out.trees[t][v].height; out.treesLod[t][v].radius = out.trees[t][v].radius;
        }
      }
    });
    PROP_RECIPES.forEach(function (fn, t) {
      out.props[t] = [];
      for (var v = 0; v < 2; v++) {
        try { out.props[t][v] = upload(G, fn(core.makeRng(5000 + t * 17 + v * 3))); }
        catch (e) { U.warn('Prop model failed, using fallback', t, e); out.props[t][v] = upload(G, makeRock(core.makeRng(t), { sub: 1, col: [255, 255, 255] })); }
      }
    });
    for (var p = 1; p <= 9; p++) {
      out.structures[p] = [];
      for (var sv = 0; sv < 3; sv++) {
        try { out.structures[p][sv] = upload(G, p === 7 ? makeStructure(p, core.makeRng(9000 + p * 13 + sv)) : foundations(makeStructure(p, core.makeRng(9000 + p * 13 + sv)))); }
        catch (e) { U.warn('Structure model failed', p, e); }
      }
    }
    out.relic = upload(G, makeRelic());
    out.hiker = upload(G, makeHiker());
    return out;
  }

  /** Simple rigid bodies for the physics playground: unit-sized meshes, scaled per object.
   *  0 beach ball, 1 mirror ball (spheres, r = 1), 2 crate (cube, half-size 1),
   *  3 barrel (cylinder r = 1, y −1…1), 4 rock. */
  function buildThrowables(G) {
    var ico = icosphere(3), out = [];
    function sphere() {
      var g = new Geo();
      var ids = ico.verts.map(function (v) { return g.vert(v, v, [Math.atan2(v[2], v[0]) / (2 * Math.PI) + 0.5, v[1] * 0.5 + 0.5], [255, 255, 255], MAT.METAL, [0, 0, 0, 0]); });
      ico.faces.forEach(function (f) { g.tri(ids[f[0]], ids[f[1]], ids[f[2]]); });
      return g;
    }
    function crate() { var g = new Geo(); box(g, [0, 0, 0], 1, 1, 1, MAT.WOOD, [255, 255, 255], 0); return g; }
    function barrel() {
      var g = new Geo(), pts = [], radii = [], S = 24;
      for (var i = 0; i <= 10; i++) { var t = i / 10; pts.push([0, -1 + 2 * t, 0]); radii.push(1 + 0.09 * Math.sin(t * Math.PI)); }
      tube(g, pts, radii, S, MAT.METAL, [255, 255, 255], function () { return [0, 0]; }, [1, 0.5], true);
      // bottom cap
      var c = g.vert([0, -1, 0], [0, -1, 0], [0.5, 0.5], [255, 255, 255], MAT.METAL, [0, 0, 0, 0]), ring = [];
      for (var k = 0; k <= S; k++) { var a = k / S * Math.PI * 2; ring.push(g.vert([Math.cos(a), -1, Math.sin(a)], [0, -1, 0], [0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5], [255, 255, 255], MAT.METAL, [0, 0, 0, 0])); }
      for (k = 0; k < S; k++) g.tri(c, ring[k + 1], ring[k]);
      return g;
    }
    var rng = TERRA.core.makeRng(4242);
    function rock() {
      var g = makeRock(rng, { sub: 3, col: [255, 255, 255] });
      // normalise to roughly a unit half-size and centre vertically
      var lo = 1e9, hi = -1e9, r = 0;
      for (var k = 0; k < g.v.length; k += 16) { lo = Math.min(lo, g.v[k + 1]); hi = Math.max(hi, g.v[k + 1]); r = Math.max(r, Math.abs(g.v[k]), Math.abs(g.v[k + 2])); }
      var cy = (lo + hi) / 2, sy = (hi - lo) / 2;
      for (k = 0; k < g.v.length; k += 16) { g.v[k] /= r; g.v[k + 2] /= r; g.v[k + 1] = (g.v[k + 1] - cy) / sy; }
      return g;
    }
    [sphere(), sphere(), crate(), barrel(), rock()].forEach(function (geo) { out.push(upload(G, geo)); });
    return out;
  }

  TERRA.world.Models = { buildAll: buildAll, buildThrowables: buildThrowables, MAT: MAT, upload: upload };
})();
