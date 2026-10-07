/* =============================================================================
 * TERRA INFINITA — Terrain Core
 * -----------------------------------------------------------------------------
 * Deterministic, self-contained procedural world generator.
 *
 * IMPORTANT: `TerrainCoreFactory` is stringified and injected into Web Workers
 * through Blob URLs (this keeps the project runnable from file://). It must NOT
 * reference anything outside of its own function scope.
 *
 * Everything is computed in float64 so that the same seed produces exactly the
 * same world on every thread, at any distance from the origin.
 *
 * Pipeline of a height sample (see `sample()`):
 *   1. Large-scale domain warp        → organic continent / range shapes
 *   2. Continentalness                → oceans, shelves, coasts, inland plateaus
 *   3. Climate (temperature/moisture) → drives biome & terrain *style*
 *   4. Mountain chains                → warped ridge masks + eroded ridged fBm
 *   5. Hills / rolling hills / plains → derivative-damped ("eroded") fBm
 *   6. Plateaus & escarpments         → sharp masks → huge cliffs
 *   7. Gully erosion                  → slope-aligned directional noise
 *   8. Arid geology                   → terraces, mesas, canyons, dunes
 *   9. Landmarks                      → volcanoes (lava craters), giant peaks
 *  10. Detail                         → outcrops, micro relief
 *  11. Rivers & streams               → meandering carved valleys, rapids/falls
 *  12. Lakes & ponds                  → basins in natural depressions
 *  13. Ocean, trails, water proximity
 * ========================================================================== */
(function (root) {
  'use strict';

  function TerrainCoreFactory() {
    'use strict';

    /* ------------------------------------------------------------------ *
     * Small math helpers
     * ------------------------------------------------------------------ */
    var PI = Math.PI, TAU = Math.PI * 2;
    function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
    function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
    function mix(a, b, t) { return a + (b - a) * t; }
    function smoothstep(e0, e1, x) {
      var t = (x - e0) / (e1 - e0);
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      return t * t * (3 - 2 * t);
    }
    function smin(a, b, k) { var h = clamp01(0.5 + 0.5 * (b - a) / k); return mix(b, a, h) - k * h * (1 - h); }
    function smax(a, b, k) { return -smin(-a, -b, k); }

    /* ------------------------------------------------------------------ *
     * Hashing (integer avalanche hash, seedable)
     * ------------------------------------------------------------------ */
    function ihash(x, y, s) {
      var h = (s ^ Math.imul(x | 0, 0x27d4eb2d)) | 0;
      h = (h + Math.imul(y | 0, 0x165667b1)) | 0;
      h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
      h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
      return (h ^ (h >>> 16)) >>> 0;
    }
    function hash01(x, y, s) { return ihash(x, y, s) * 2.3283064365386963e-10; }
    function hash3(x, y, z, s) { return ihash(x, ihash(y, z, s) | 0, s ^ 0x5bd1e995); }

    /** Turn any user seed (number or text) into a uint32. Pure digits map to themselves. */
    function stringToSeed(str) {
      str = String(str).trim();
      if (/^\d{1,9}$/.test(str)) return parseInt(str, 10) >>> 0;
      var h = 0x811c9dc5;
      for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
      h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
      h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
      return (h ^ (h >>> 16)) >>> 0;
    }

    /** Small deterministic PRNG (mulberry32) for per-object randomness. */
    function makeRng(seed) {
      var a = seed >>> 0;
      return function () {
        a = (a + 0x6D2B79F5) | 0;
        var t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    /* ------------------------------------------------------------------ *
     * Gradient noise with analytic derivatives.
     * Derivatives are written to _dx/_dy (module scratch registers) so the
     * hot paths never allocate.
     * ------------------------------------------------------------------ */
    var GRAD_N = 64, GX = new Float64Array(GRAD_N), GY = new Float64Array(GRAD_N);
    for (var gi = 0; gi < GRAD_N; gi++) {
      var ga = (gi + 0.37) / GRAD_N * TAU;
      GX[gi] = Math.cos(ga); GY[gi] = Math.sin(ga);
    }
    var F2 = 0.36602540378443865, G2 = 0.21132486540518713;
    var SIMPLEX_SCALE = 99.0;
    var _dx = 0, _dy = 0;

    /** 2D simplex noise in ~[-1,1] with analytic gradient (Gustavson/Quilez). */
    function snoise(x, y, seed) {
      var s = (x + y) * F2;
      var i = Math.floor(x + s), j = Math.floor(y + s);
      var t = (i + j) * G2;
      var x0 = x - i + t, y0 = y - j + t;
      var i1, j1;
      if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
      var x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
      var x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
      var n = 0, dx = 0, dy = 0, t0, t2, t4, g, gx, gy, gd, tt;
      t0 = 0.5 - x0 * x0 - y0 * y0;
      if (t0 > 0) {
        g = ihash(i, j, seed) & 63; gx = GX[g]; gy = GY[g]; gd = gx * x0 + gy * y0;
        t2 = t0 * t0; t4 = t2 * t2; n += t4 * gd; tt = -8 * t2 * t0 * gd;
        dx += tt * x0 + t4 * gx; dy += tt * y0 + t4 * gy;
      }
      t0 = 0.5 - x1 * x1 - y1 * y1;
      if (t0 > 0) {
        g = ihash(i + i1, j + j1, seed) & 63; gx = GX[g]; gy = GY[g]; gd = gx * x1 + gy * y1;
        t2 = t0 * t0; t4 = t2 * t2; n += t4 * gd; tt = -8 * t2 * t0 * gd;
        dx += tt * x1 + t4 * gx; dy += tt * y1 + t4 * gy;
      }
      t0 = 0.5 - x2 * x2 - y2 * y2;
      if (t0 > 0) {
        g = ihash(i + 1, j + 1, seed) & 63; gx = GX[g]; gy = GY[g]; gd = gx * x2 + gy * y2;
        t2 = t0 * t0; t4 = t2 * t2; n += t4 * gd; tt = -8 * t2 * t0 * gd;
        dx += tt * x2 + t4 * gx; dy += tt * y2 + t4 * gy;
      }
      _dx = dx * SIMPLEX_SCALE; _dy = dy * SIMPLEX_SCALE;
      return n * SIMPLEX_SCALE;
    }

    /** Classic quintic Perlin gradient noise with analytic derivatives. */
    function pnoise(x, y, seed) {
      var ix = Math.floor(x), iy = Math.floor(y);
      var fx = x - ix, fy = y - iy;
      var ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
      var dux = 30 * fx * fx * (fx * (fx - 2) + 1), duy = 30 * fy * fy * (fy * (fy - 2) + 1);
      var a = ihash(ix, iy, seed) & 63, b = ihash(ix + 1, iy, seed) & 63;
      var c = ihash(ix, iy + 1, seed) & 63, d = ihash(ix + 1, iy + 1, seed) & 63;
      var va = GX[a] * fx + GY[a] * fy;
      var vb = GX[b] * (fx - 1) + GY[b] * fy;
      var vc = GX[c] * fx + GY[c] * (fy - 1);
      var vd = GX[d] * (fx - 1) + GY[d] * (fy - 1);
      var k1 = vb - va, k2 = vc - va, k3 = va - vb - vc + vd;
      var v = va + ux * k1 + uy * k2 + ux * uy * k3;
      var gx = GX[a] + ux * (GX[b] - GX[a]) + uy * (GX[c] - GX[a]) + ux * uy * (GX[a] - GX[b] - GX[c] + GX[d]) + dux * (k1 + uy * k3);
      var gy = GY[a] + ux * (GY[b] - GY[a]) + uy * (GY[c] - GY[a]) + ux * uy * (GY[a] - GY[b] - GY[c] + GY[d]) + duy * (k2 + ux * k3);
      _dx = gx * 1.42; _dy = gy * 1.42;
      return v * 1.42;
    }

    /** Cellular (Voronoi) noise. Writes F1, F2 and the nearest cell/feature to `vor`. */
    var vor = { f1: 0, f2: 0, cx: 0, cy: 0, px: 0, py: 0 };
    function voronoi(x, y, seed, jitter) {
      var ix = Math.floor(x), iy = Math.floor(y);
      var f1 = 1e9, f2 = 1e9, bx = 0, by = 0, bpx = 0, bpy = 0;
      for (var j = -1; j <= 1; j++) {
        for (var i = -1; i <= 1; i++) {
          var cx = ix + i, cy = iy + j;
          var h = ihash(cx, cy, seed);
          var px = cx + 0.5 + ((h & 0xffff) / 65535 - 0.5) * jitter;
          var py = cy + 0.5 + ((h >>> 16) / 65535 - 0.5) * jitter;
          var dx = px - x, dy = py - y, d = dx * dx + dy * dy;
          if (d < f1) { f2 = f1; f1 = d; bx = cx; by = cy; bpx = px; bpy = py; }
          else if (d < f2) { f2 = d; }
        }
      }
      vor.f1 = Math.sqrt(f1); vor.f2 = Math.sqrt(f2); vor.cx = bx; vor.cy = by; vor.px = bpx; vor.py = bpy;
      return vor.f1;
    }

    /* ------------------------------------------------------------------ *
     * Fractal layers. Octave k is rotated by k·36.87° to kill axis bias.
     * `maxOct` sets the normalisation so skipping octaves (LOD) keeps the
     * low-frequency result identical.
     * ------------------------------------------------------------------ */
    var ROT_C = 0.8, ROT_S = 0.6;

    function octFor(wavelength, maxOct, lodW) {
      if (!(lodW > 0)) return maxOct;
      if (wavelength < lodW) return 0;
      var n = Math.floor(Math.log(wavelength / lodW) * 1.4426950408889634) + 1;
      return n < maxOct ? n : maxOct;
    }

    /** fBm of simplex noise. Returns ≈[-0.8,0.8], gradient in _dx/_dy (w.r.t. x,y). */
    function fbm(x, y, oct, seed, maxOct) {
      maxOct = maxOct || oct;
      var norm = 2 * (1 - Math.pow(0.5, maxOct));
      if (oct <= 0) { _dx = 0; _dy = 0; return 0; }
      var sum = 0, amp = 1, dxs = 0, dys = 0, c = 1, s = 0, sc = 1, px = x, py = y, v, gx, gy, t;
      for (var i = 0; i < oct; i++) {
        v = snoise(px, py, (seed + i * 7919) | 0);
        gx = _dx; gy = _dy;
        dxs += amp * sc * (c * gx + s * gy);
        dys += amp * sc * (-s * gx + c * gy);
        sum += amp * v;
        t = 2 * (ROT_C * px - ROT_S * py) + 19.19; py = 2 * (ROT_S * px + ROT_C * py) - 7.43; px = t;
        t = ROT_C * c - ROT_S * s; s = ROT_S * c + ROT_C * s; c = t;
        sc *= 2; amp *= 0.5;
      }
      _dx = dxs / norm; _dy = dys / norm;
      return sum / norm;
    }

    /** "Eroded" fBm (Quilez): octaves are damped where the accumulated slope is high,
     *  giving smooth flanks and detailed crests/valleys. */
    function erodedFbm(x, y, oct, seed, maxOct, k) {
      maxOct = maxOct || oct;
      var norm = 2 * (1 - Math.pow(0.5, maxOct));
      if (oct <= 0) { _dx = 0; _dy = 0; return 0; }
      // nx,ny: IQ-style accumulated *native* derivative (drives damping)
      // ax,ay: true gradient of the sum w.r.t. (x,y) (returned for erosion direction)
      var sum = 0, amp = 1, ax = 0, ay = 0, nx = 0, ny = 0, c = 1, s = 0, sc = 1, px = x, py = y, v, gx, gy, t, damp;
      for (var i = 0; i < oct; i++) {
        v = snoise(px, py, (seed + i * 7919) | 0);
        gx = _dx; gy = _dy;
        nx += gx * 0.35; ny += gy * 0.35;
        damp = 1 / (1 + (nx * nx + ny * ny) * k);
        sum += amp * v * damp;
        ax += amp * damp * sc * (c * gx + s * gy); ay += amp * damp * sc * (-s * gx + c * gy);
        t = 2 * (ROT_C * px - ROT_S * py) + 19.19; py = 2 * (ROT_S * px + ROT_C * py) - 7.43; px = t;
        t = ROT_C * c - ROT_S * s; s = ROT_S * c + ROT_C * s; c = t;
        sc *= 2; amp *= 0.5;
      }
      _dx = ax / norm; _dy = ay / norm;
      return sum / norm;
    }

    /** Ridged multifractal with slope damping. Returns [0,1], gradient in _dx/_dy. */
    function ridged(x, y, oct, seed, maxOct, k) {
      maxOct = maxOct || oct;
      var norm = 0, a = 1;
      for (var q = 0; q < maxOct; q++) { norm += a; a *= 0.5; }
      if (oct <= 0) { _dx = 0; _dy = 0; return 0; }
      var sum = 0, amp = 1, w = 1, ax = 0, ay = 0, nx = 0, ny = 0, c = 1, s = 0, sc = 1, px = x, py = y;
      var v, gx, gy, av, sg, r1, r, kk, damp, t;
      for (var i = 0; i < oct; i++) {
        v = snoise(px, py, (seed + i * 7919) | 0);
        gx = _dx; gy = _dy;
        av = v < 0 ? -v : v; sg = v < 0 ? -1 : 1;
        r1 = 1 - av; r = r1 * r1;
        kk = -2 * r1 * sg * w;
        nx += kk * gx * 0.3; ny += kk * gy * 0.3;
        damp = i === 0 ? 1 : 1 / (1 + (nx * nx + ny * ny) * k);
        sum += amp * r * w * damp;
        ax += kk * amp * damp * sc * (c * gx + s * gy); ay += kk * amp * damp * sc * (-s * gx + c * gy);
        w = clamp01(r * 1.25 + 0.15);
        t = 2.03 * (ROT_C * px - ROT_S * py) + 3.71; py = 2.03 * (ROT_S * px + ROT_C * py) - 11.3; px = t;
        t = ROT_C * c - ROT_S * s; s = ROT_S * c + ROT_C * s; c = t;
        sc *= 2.03; amp *= 0.5;
      }
      _dx = ax / norm; _dy = ay / norm;
      return sum / norm;
    }

    /** Directional gully erosion (after Clay John). `dirx,diry` is the slope-perpendicular
     *  vector of the underlying terrain; stripes therefore run *downhill*.
     *  Returns a carve factor in [-1, 0] (0 on flats/ridges, -1 in gully floors). */
    function gullies(x, y, dirx, diry, oct, maxOct, seed) {
      var h = 0, hdx = 0, hdy = 0, a = 0.5, f = 1, afull = 0, acomp = 0, aa = 0.5;
      for (var q = 0; q < maxOct; q++) { afull += aa; aa *= 0.45; }
      for (var o = 0; o < oct; o++) {
        var px = x * f, py = y * f;
        var ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy;
        var dX = dirx + hdy, dY = diry - hdx;
        var va = 0, vdx = 0, vdy = 0, wt = 0;
        for (var j = -1; j <= 1; j++) {
          for (var i = -1; i <= 1; i++) {
            var hh = ihash(ix + i, iy + j, (seed + o * 131) | 0);
            var ppx = fx - i - (hh & 0xffff) * 7.62951e-6;
            var ppy = fy - j - (hh >>> 16) * 7.62951e-6;
            var w = Math.exp(-(ppx * ppx + ppy * ppy) * 2.0);
            wt += w;
            var mag = (ppx * dX + ppy * dY) * TAU;
            var cs = Math.cos(mag), sn = Math.sin(mag);
            va += cs * w; vdx -= sn * dX * w; vdy -= sn * dY * w;
          }
        }
        va /= wt; vdx /= wt; vdy /= wt;
        h += va * a; hdx += vdx * a * f; hdy += vdy * a * f;
        acomp += a;
        a *= 0.45; f *= 2;
      }
      return (h - acomp) / (2 * afull);
    }

    /** Soft terrace: flat treads and steep risers. sharp∈[0,1]. */
    function terrace(h, step, sharp) {
      var t = h / step, f = Math.floor(t), r = t - f;
      var k = 0.5 - 0.47 * sharp;
      return (f + smoothstep(0.5 - k, 0.5 + k, r)) * step;
    }

    /* ------------------------------------------------------------------ *
     * Continental elevation curve (monotone cubic Hermite, Fritsch–Carlson)
     * ------------------------------------------------------------------ */
    var CC_X = [-1.6, -1.0, -0.55, -0.3, -0.12, -0.04, 0.0, 0.05, 0.14, 0.3, 0.55, 0.8, 1.1, 2.0];
    var CC_Y = [-1500, -1100, -700, -240, -70, -10, 0.4, 3.0, 11, 38, 95, 190, 330, 600];
    var CC_M = (function () {
      var n = CC_X.length, d = [], m = [];
      for (var i = 0; i < n - 1; i++) d.push((CC_Y[i + 1] - CC_Y[i]) / (CC_X[i + 1] - CC_X[i]));
      m.push(d[0]);
      for (i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
      m.push(d[n - 2]);
      for (i = 0; i < n - 1; i++) {
        if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
        var a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
        if (s > 9) { var tau = 3 / Math.sqrt(s); m[i] = tau * a * d[i]; m[i + 1] = tau * b * d[i]; }
      }
      return m;
    })();
    function contCurve(c) {
      var n = CC_X.length;
      if (c <= CC_X[0]) return CC_Y[0];
      if (c >= CC_X[n - 1]) return CC_Y[n - 1];
      var i = 0;
      while (c > CC_X[i + 1]) i++;
      var h = CC_X[i + 1] - CC_X[i], t = (c - CC_X[i]) / h, t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * CC_Y[i] + (t3 - 2 * t2 + t) * h * CC_M[i] +
             (-2 * t3 + 3 * t2) * CC_Y[i + 1] + (t3 - t2) * h * CC_M[i + 1];
    }

    /* ------------------------------------------------------------------ *
     * Biomes
     * ------------------------------------------------------------------ */
    var BIOME = {
      OCEAN: 0, BEACH: 1, DESERT: 2, ROCKY_DESERT: 3, SAVANNA: 4, GRASSLAND: 5,
      TEMPERATE_FOREST: 6, TROPICAL_FOREST: 7, BOREAL_FOREST: 8, TUNDRA: 9, ALPINE: 10,
      SNOWFIELD: 11, WETLAND: 12, COASTAL_FOREST: 13, MOUNTAIN: 14, HIGH_MOUNTAIN: 15,
      VOLCANIC: 16, FRESHWATER: 17, GLACIER: 18,
      STEPPE: 19, MEDITERRANEAN: 20, COLD_DESERT: 21, TEMPERATE_RAINFOREST: 22, TROPICAL_SWAMP: 23, BADLANDS: 24, SHRUBLAND: 25
    };
    var BIOME_NAMES = ['Ocean', 'Beach', 'Desert', 'Rocky Desert', 'Savanna', 'Grassland',
      'Temperate Forest', 'Tropical Forest', 'Boreal Forest', 'Tundra', 'Alpine Meadow',
      'Snowfield', 'Wetland', 'Coastal Forest', 'Mountain', 'High Mountain', 'Volcanic Region',
      'Lake / River', 'Glacier',
      'Steppe', 'Mediterranean Scrub', 'Cold Desert', 'Temperate Rainforest', 'Tropical Swamp', 'Badlands', 'Shrubland'];
    var BIOME_COLORS = [
      [29, 59, 90], [216, 201, 155], [214, 180, 126], [168, 136, 100], [176, 160, 92], [138, 160, 88],
      [74, 115, 56], [44, 100, 46], [60, 90, 66], [150, 156, 136], [132, 150, 112],
      [236, 240, 244], [88, 118, 86], [62, 108, 78], [128, 120, 110], [178, 174, 168], [70, 60, 56],
      [58, 116, 164], [206, 226, 238],
      [170, 168, 112], [150, 150, 92], [176, 166, 140], [48, 96, 60], [70, 104, 70], [186, 120, 84], [140, 140, 96]
    ];

    /* ------------------------------------------------------------------ *
     * Default world-generation parameters (World Settings panel)
     * ------------------------------------------------------------------ */
    var DEFAULT_PARAMS = {
      terrainScale: 1.0,       // horizontal feature scale
      mountainFrequency: 0.5,  // how often mountain chains appear
      mountainHeight: 1.0,     // vertical scale of mountains
      roughness: 0.5,          // hill amplitude / ruggedness
      erosion: 0.6,            // gully erosion strength
      riverFrequency: 0.5,
      lakeFrequency: 0.5,
      oceanCoverage: 0.35,     // fraction of the world covered by sea
      biomeSize: 1.0,
      temperature: 0.0,        // global climate offset (-1 cold … +1 hot)
      moisture: 0.0,           // global humidity offset
      vegetationDensity: 1.0,
      forestDensity: 1.0,
      rockDensity: 1.0,
      waterLevel: 0.0,         // sea level offset in metres
      caveFrequency: 0.5,      // caves & arches
      landmarkFrequency: 0.5,  // volcanoes, giant peaks, points of interest
      terrainDetail: 1.0       // small scale relief
    };

    /* =================================================================== *
     * Generator
     * =================================================================== */
    function createGenerator(seedIn, paramsIn) {
      var P = {};
      var k;
      for (k in DEFAULT_PARAMS) P[k] = DEFAULT_PARAMS[k];
      if (paramsIn) for (k in paramsIn) if (paramsIn[k] !== undefined && k in DEFAULT_PARAMS) P[k] = +paramsIn[k];
      var seed = typeof seedIn === 'number' ? (seedIn >>> 0) : stringToSeed(seedIn);
      var SEA = P.waterLevel;
      var invScale = 1 / clamp(P.terrainScale, 0.25, 4);

      function sd(n) { return ihash(seed | 0, n * 7919 + 13, 0x5bd1e995) | 0; }
      var S_WX = sd(1), S_WZ = sd(2), S_CONT = sd(3), S_COAST = sd(4), S_TEMP = sd(5), S_MOIST = sd(6),
          S_RANGE = sd(7), S_GATE = sd(8), S_ISO = sd(9), S_MTN = sd(10), S_HILLY = sd(11), S_HILLS = sd(12),
          S_ROLL = sd(13), S_PLAT = sd(14), S_GULLY = sd(15), S_DETAIL = sd(16), S_OUTCROP = sd(17),
          S_RWX = sd(18), S_RWZ = sd(19), S_RIVER = sd(20), S_STREAM = sd(21), S_RGATE = sd(22),
          S_LAKE = sd(23), S_LSHAPE = sd(24), S_VOLC = sd(25), S_PEAK = sd(26), S_CANYON = sd(27),
          S_MESA = sd(28), S_DUNE = sd(29), S_ISLAND = sd(30), S_PATH = sd(31), S_PGATE = sd(32),
          S_WET = sd(33), S_MWARP = sd(34), S_TERR = sd(35), S_POND = sd(36), S_FOREST = sd(37),
          S_VEG = sd(38), S_POI = sd(39), S_MICRO = sd(40), S_STRAT = sd(41);

      // Per-cell caches for large features (lakes, volcanoes, peaks). Deterministic,
      // so every worker builds identical caches independently.
      var lakeCache = new Map(), pondCache = new Map(), volcCache = new Map(), peakCache = new Map();
      function ckey(i, j) { return i * 4194304 + j; }
      function trimCache(m) { if (m.size > 20000) m.clear(); }

      var LAKE_GRID = 2800 / (0.35 + P.lakeFrequency);
      var POND_GRID = 760 / (0.35 + P.lakeFrequency);
      var VOLC_GRID = 17000;
      var PEAK_GRID = 26000;

      /** Output record of a sample (re-used, never allocate in loops). */
      function newSample() {
        return {
          h: 0, base: 0, water: -1e5, wtype: 0, fx: 0, fz: 0,
          temp: 0, moist: 0, arid: 0, cont: 0, mtn: 0, hilly: 0, volc: 0, rock: 0, gully: 0,
          path: 0, wet: 0, wprox: 0, rdist: 1e9, rl: 0, gx: 0, gz: 0, cgx: 0, cgz: 0, plat: 0,
          mtnFloor: 0, lava: 0, lake: 0, _rgate: 0, _pgate: 0
        };
      }

      /* ------------------------------------------------------------ *
       * Macro fields: everything with wavelengths ≥ ~4 km. For grids
       * (chunks, vegetation, maps) these are computed on a coarse lattice
       * and interpolated, which makes generation several times faster.
       * ------------------------------------------------------------ */
      var MACRO_N = 25;
      function newMacro() { return new Float64Array(MACRO_N); }
      // indices
      var M_W1 = 0, M_W2 = 1, M_C = 2, M_CGX = 3, M_CGZ = 4, M_T0 = 5, M_MN = 6, M_WET = 7, M_RN = 8,
          M_GATE = 9, M_ISO = 10, M_HILLY = 11, M_PN = 12, M_RGATE = 13, M_PGATE = 14, M_MW1 = 15, M_MW2 = 16, M_HSC = 17,
          M_MW1X = 18, M_MW1Z = 19, M_MW2X = 20, M_MW2Z = 21, M_C2 = 22, M_SHADOW = 23, M_OROG = 24;
      var MTN_L = 13000;
      function macroFields(X, Z, m) {
        var w1 = fbm(X * (1 / 14000), Z * (1 / 14000), 3, S_WX);
        var w2 = fbm(X * (1 / 14000) + 31.7, Z * (1 / 14000) - 11.3, 3, S_WZ);
        m[M_W1] = w1; m[M_W2] = w2;
        var qx = X + w1 * 3800, qz = Z + w2 * 3800;
        m[M_C] = fbm(qx * (1 / 52000), qz * (1 / 52000), 5, S_CONT) * 2.3;
        m[M_CGX] = _dx * 2.3 / 52000; m[M_CGZ] = _dy * 2.3 / 52000;
        // Mountain-mask fields use a gentler warp: the continental warp compresses space up to
        // ~3×, which would turn mask ramps into kilometre-high walls.
        var mqx = X + w1 * 1300, mqz = Z + w2 * 1300;
        m[M_C2] = fbm(mqx * (1 / 52000), mqz * (1 / 52000), 2, S_CONT, 5) * 2.3;   // smooth continentalness (mountain mask)
        var bs = 1 / clamp(P.biomeSize, 0.2, 5);
        m[M_T0] = fbm(X * bs / 17000 + 5.3, Z * bs / 17000 - 7.1, 3, S_TEMP);
        m[M_MN] = fbm(X * bs / 12500 - 3.3, Z * bs / 12500 + 9.9, 3, S_MOIST);
        m[M_WET] = snoise(X / 5200, Z / 5200, S_WET);
        m[M_RN] = snoise(mqx / 30000, mqz / 30000, S_RANGE);
        m[M_GATE] = fbm(mqx / 80000, mqz / 80000, 2, S_GATE);
        m[M_ISO] = fbm(mqx / 19000, mqz / 19000, 2, S_ISO);
        m[M_HILLY] = fbm(X / 15000 + 1.1, Z / 15000 - 2.2, 2, S_HILLY);
        m[M_PN] = fbm(qx / 16000 + 3.0, qz / 16000 - 5.0, 3, S_PLAT);
        m[M_RGATE] = fbm(X / 42000, Z / 42000, 2, S_RGATE);
        m[M_PGATE] = fbm(X / 9000, Z / 9000, 2, S_PGATE);
        m[M_MW1] = fbm(X / (MTN_L * 0.7), Z / (MTN_L * 0.7), 2, S_MWARP) * MTN_L * 0.07;
        m[M_MW1X] = _dx * (0.07 / 0.7); m[M_MW1Z] = _dy * (0.07 / 0.7);
        m[M_MW2] = fbm(X / (MTN_L * 0.7) + 3.3, Z / (MTN_L * 0.7) - 1.7, 2, S_MWARP + 1) * MTN_L * 0.07;
        m[M_MW2X] = _dx * (0.07 / 0.7); m[M_MW2Z] = _dy * (0.07 / 0.7);
        m[M_HSC] = fbm(X / 7000 - 4.4, Z / 7000 + 2.2, 2, S_HILLS + 5);
        // Rain shadow & orographic rain: prevailing westerlies (blowing toward +x) drop their
        // moisture on the windward side of mountain chains and leave the lee dry.
        var mfq = clamp(P.mountainFrequency, 0, 1), sh = 0;
        for (var u = 0; u < 3; u++) {
          var off = u === 0 ? 4500 : (u === 1 ? 11000 : 21000), wgt = u === 0 ? 1 : (u === 1 ? 0.8 : 0.55);
          var ux = mqx - off;
          var chU = 1 - Math.abs(snoise(ux / 30000, mqz / 30000, S_RANGE));
          var gU = smoothstep(-0.28 - 0.32 * mfq, 0.28 - 0.3 * mfq, fbm(ux / 80000, mqz / 80000, 2, S_GATE));
          sh = Math.max(sh, smoothstep(0.5, 0.92, chU) * gU * wgt);
        }
        var dxw = mqx + 3500;
        var chD = 1 - Math.abs(snoise(dxw / 30000, mqz / 30000, S_RANGE));
        m[M_SHADOW] = sh;
        m[M_OROG] = smoothstep(0.5, 0.92, chD) * smoothstep(-0.28 - 0.32 * mfq, 0.28 - 0.3 * mfq, m[M_GATE]);
        return m;
      }
      /** Bilinear lattice of macro fields over [x0, x0+span]² with n cells. */
      function macroGrid(x0, z0, span, n) {
        var N = n + 1, st = span / n, arr = new Float64Array(N * N * MACRO_N), m = newMacro();
        for (var j = 0; j < N; j++) for (var i = 0; i < N; i++) {
          macroFields((x0 + i * st) * invScale, (z0 + j * st) * invScale, m);
          arr.set(m, (j * N + i) * MACRO_N);
        }
        return { x0: x0, z0: z0, st: st, n: n, a: arr };
      }
      function macroAt(g, x, z, m) {
        var fx = (x - g.x0) / g.st, fz = (z - g.z0) / g.st, N = g.n + 1;
        var i = Math.floor(fx), j = Math.floor(fz);
        if (i < 0) i = 0; if (j < 0) j = 0; if (i > g.n - 1) i = g.n - 1; if (j > g.n - 1) j = g.n - 1;
        var tx = fx - i, tz = fz - j, a = g.a;
        var o00 = (j * N + i) * MACRO_N, o10 = o00 + MACRO_N, o01 = o00 + N * MACRO_N, o11 = o01 + MACRO_N;
        var w00 = (1 - tx) * (1 - tz), w10 = tx * (1 - tz), w01 = (1 - tx) * tz, w11 = tx * tz;
        for (var k2 = 0; k2 < MACRO_N; k2++) m[k2] = a[o00 + k2] * w00 + a[o10 + k2] * w10 + a[o01 + k2] * w01 + a[o11 + k2] * w11;
        return m;
      }

      /** Multi-octave erosion filter (gain 0.5 / lacunarity 2 → equal slope detail at every
       *  scale). `dX,dY` = slope-perpendicular vector × stripe frequency, so gullies run
       *  downhill, are dense on steep ground and vanish on flats and crests; each octave
       *  bends toward the previous octave's channels (`branch`) → dendritic networks.
       *  Skipped (LOD) octaves add their expected carve so coarse and fine LODs agree.
       *  Returns carve in ≈[-2, 0] (≈-1 on average on steep slopes, 0 on crests/flats);
       *  `_ev` receives the ridge/gully indicator of the finest computed octaves. */
      var _ev = 0;
      function erosionFilter(px, pz, dX, dY, oct, maxOct, seed, branch, gain) {
        var h = 0, edx = 0, edy = 0, a = 0.5, f = 1, asum = 0, fine = 0;
        var dm2 = dX * dX + dY * dY;
        for (var k2 = 0; k2 < maxOct; k2++) {
          if (k2 >= oct) {
            // expected value of a skipped octave: E[cos] of a random-phase stripe
            h += a * Math.exp(-3.2 * dm2); asum += a; a *= gain; continue;
          }
          var qx = px * f, qz = pz * f;
          var ix = Math.floor(qx), iz = Math.floor(qz), fx = qx - ix, fz = qz - iz;
          var ddx = dX + edy * branch, ddy = dY - edx * branch;
          var va = 0, vdx = 0, vdy = 0, wt = 1e-6;
          for (var j = -1; j <= 1; j++) {
            for (var i = -1; i <= 1; i++) {
              var hh = ihash(ix - i, iz - j, (seed + k2 * 131) | 0);
              var ppx = fx + i - (hh & 0xffff) * 7.62951e-6;
              var ppy = fz + j - (hh >>> 16) * 7.62951e-6;
              var d = ppx * ppx + ppy * ppy;
              if (d >= 0.9) continue;
              var tt = 1 - d * 1.1111111; var w = tt * tt * tt;
              wt += w;
              var t = ppx * ddx + ppy * ddy;
              t -= Math.round(t);
              var x = t * TAU;
              var sn = 1.2732395 * x - 0.4052847 * x * (x < 0 ? -x : x);
              sn = 0.225 * (sn * (sn < 0 ? -sn : sn) - sn) + sn;
              var xc = x + 1.5707963; if (xc > PI) xc -= TAU;
              var cs = 1.2732395 * xc - 0.4052847 * xc * (xc < 0 ? -xc : xc);
              cs = 0.225 * (cs * (cs < 0 ? -cs : cs) - cs) + cs;
              va += cs * w; vdx -= sn * ddx * w; vdy -= sn * ddy * w;
            }
          }
          va /= wt;
          if (k2 >= oct - 2) fine += va * a;
          h += va * a; edx += vdx / wt * a * f; edy += vdy / wt * a * f;
          asum += a; a *= gain; f *= 2;
        }
        _ev = fine;
        return (h - asum) / (0.5 / (1 - gain));
      }

      /* ------------------------------------------------------------ *
       * Stage 1 — base terrain (everything except fresh water)
       * ------------------------------------------------------------ */
      var _mTmp = newMacro(), _mTmp2 = newMacro();
      function stageBase(X, Z, o, lodW, skipLandmarks, m) {
        if (!m) m = macroFields(X, Z, _mTmp);
        var w1 = m[M_W1], w2 = m[M_W2];
        var qx = X + w1 * 3800, qz = Z + w2 * 3800;

        // ---- Continentalness (+ coastline detail)
        var c = m[M_C];
        var cdo = octFor(7000, 3, lodW);
        if (cdo > 0 && c > -0.6 && c < 0.7) c += fbm(qx * (1 / 7000), qz * (1 / 7000), cdo, S_COAST, 3) * 0.16;
        c += (0.5 - P.oceanCoverage) * 1.6;
        o.cont = c; o.cgx = m[M_CGX]; o.cgz = m[M_CGZ];
        var land = smoothstep(-0.03, 0.16, c);

        // ---- Climate at sea level
        // latitude-like climate bands (~160 km north–south cycle) under regional noise
        var lat = Math.sin(Z / 26000 + 0.7);
        var T0 = 13 + m[M_T0] * 25 + lat * 7 + P.temperature * 15;
        var M = clamp01(0.47 + m[M_MN] * 0.95 + P.moisture * 0.45 + 0.14 * (1 - smoothstep(0.0, 0.4, c)));
        // lee of the ranges is drier, windward slopes wetter
        M = clamp01(M - 0.26 * m[M_SHADOW] + 0.12 * m[M_OROG]);
        var arid = smoothstep(0.36, 0.15, M) * smoothstep(5, 17, T0) * land;
        o.moist = M; o.arid = arid;
        var base = contCurve(c);
        var wet = smoothstep(0.64, 0.82, M + m[M_WET] * 0.12) * smoothstep(90, 12, base) * land;

        // ---- Mountain chain mask
        var mf = clamp(P.mountainFrequency, 0, 1);
        var chain = 1 - Math.abs(m[M_RN]);
        var gate = smoothstep(-0.28 - 0.32 * mf, 0.28 - 0.3 * mf, m[M_GATE]);
        // Broad transitions (≥ 5–10 km): mountain height scales with this mask, so a narrow
        // ramp would raise kilometre-high walls instead of foothills.
        var rangeM = smoothstep(0.4 - 0.26 * mf, 0.93 - 0.1 * mf, chain) * gate;
        var iso = smoothstep(0.12 - 0.16 * mf, 0.6, m[M_ISO]) * 0.75;
        var mMask = Math.max(rangeM, iso) * smoothstep(0.08, 0.62, m[M_C2] + (0.5 - P.oceanCoverage) * 1.6);
        wet *= 1 - smoothstep(0.0, 0.3, mMask);

        // Giant peak landmarks
        var peakAdd = 0;
        if (!skipLandmarks && P.landmarkFrequency > 0.01) {
          var pci = Math.floor(X / PEAK_GRID), pcj = Math.floor(Z / PEAK_GRID);
          for (var pj = -1; pj <= 1; pj++) for (var pi = -1; pi <= 1; pi++) {
            var pk = peakCell(pci + pi, pcj + pj);
            if (!pk) continue;
            var pdx = X - pk.x, pdz = Z - pk.z, pd = Math.sqrt(pdx * pdx + pdz * pdz);
            if (pd < pk.R) {
              var pt = 1 - pd / pk.R;
              mMask = Math.max(mMask, smoothstep(0.0, 0.55, pt));
              peakAdd = Math.max(peakAdd, pk.H * smoothstep(0.0, 1.0, pt));
            }
          }
        }
        o.mtn = mMask;

        // ---- Mountains: a broad uplifted massif (valleys inside a range sit high, as in
        //      real ranges) carved by a 6-octave slope-aligned erosion filter: dendritic
        //      gully networks and spurs on every flank, sharp crests between them, and no
        //      carving on valley floors (sediment), so floors stay broad and flat.
        var mAmp = 3300 * P.mountainHeight;
        var mm = Math.pow(mMask, 1.1);
        var boost = 1 + peakAdd / Math.max(mAmp, 1);
        var FLOOR = 0.2;
        var mtnH = 0, mgx = 0, mgz = 0, mtnFloor = FLOOR * mm * mAmp * boost, gullyV = 0;
        if (mm > 0.002) {
          var LR = 15000;
          var px = (X + m[M_MW1]) / LR, pz = (Z + m[M_MW2]) / LR;
          var fv = fbm(px, pz, octFor(LR, 4, lodW * 1.5), S_MTN, 4);
          var n = 0.5 + 0.7 * fv, ndx = 0.7 * _dx, ndz = 0.7 * _dy;
          if (n < 0) { n = 0; ndx = 0; ndz = 0; }
          else if (n > 0.8) {            // soft summit clamp (no flat tops)
            var ex = Math.exp(-(n - 0.8) / 0.2);
            n = 1 - 0.2 * ex; ndx *= ex; ndz *= ex;
          }
          // chain rule through the domain warp: ∂(px,pz)/∂(X,Z)
          var jx = ndx * (1 + m[M_MW1X]) + ndz * m[M_MW2X], jz = ndx * m[M_MW1Z] + ndz * (1 + m[M_MW2Z]);
          var sh = Math.pow(n, 1.2), dsh = 1.2 * Math.pow(Math.max(n, 1e-4), 0.2);
          var amp = mm * mAmp * boost;
          // slope of the uneroded massif (m/m) → stripe direction (downhill) & density
          var g0x = amp * (1 - FLOOR) * dsh * jx / LR, g0z = amp * (1 - FLOOR) * dsh * jz / LR;
          var g0 = Math.sqrt(g0x * g0x + g0z * g0z) + 1e-9;
          var fr = 2.3 / (g0 + 0.25);
          var EC = 2400;
          var eo = octFor(EC * 0.5, 6, lodW * 1.25);
          var ero = erosionFilter((X + m[M_MW1] * 0.25) / EC, (Z + m[M_MW2] * 0.25) / EC, g0z * fr, -g0x * fr, eo, 6, S_GULLY, 1.6, 0.38);
          var carve = amp * 0.11 * (P.erosion / 0.6) * smoothstep(0.0, 0.45, sh);
          gullyV = -clamp01((-ero - 0.95) * 1.4) * smoothstep(0.0, 0.15, sh);
          mtnH = amp * (FLOOR + (1 - FLOOR) * sh) + ero * carve;
          mgx = g0x; mgz = g0z;
        }
        o.mtnFloor = mtnFloor;

        // ---- Hills & rolling plains (derivative-damped fBm + light erosion)
        var hilly = smoothstep(-0.32, 0.42, m[M_HILLY]);
        o.hilly = hilly;
        var hn = erodedFbm(X / 2400, Z / 2400, octFor(2400, 5, lodW), S_HILLS, 5, 0.9);
        var hgx = _dx / 2400, hgz = _dy / 2400;
        var hills01 = clamp01(hn * 1.05 + 0.5 + m[M_HSC] * 0.25);
        var hAmp = (26 + 200 * hilly * (0.55 + 0.9 * P.roughness)) * (1 - 0.75 * smoothstep(0, 0.45, mMask)) * land * (1 - 0.85 * wet);
        var hillH = Math.pow(hills01, 1.55) * hAmp;
        var hd = 1.55 * Math.pow(Math.max(hills01, 1e-4), 0.55) * 1.05 * hAmp;
        hgx *= hd; hgz *= hd;
        if (hAmp > 25) {
          var heo = octFor(640 * 0.5, 4, lodW * 1.25);
          var hsl = Math.sqrt(hgx * hgx + hgz * hgz);
          var hfr = 1.8 / (hsl + 0.12);
          var her = erosionFilter(X / 640, Z / 640, hgz * hfr, -hgx * hfr, heo, 4, S_GULLY + 77, 1.4, 0.42);
          var hcar = hAmp * 0.07 * (P.erosion / 0.6) * smoothstep(0.08, 0.45, hills01);
          hillH += her * hcar;
          var hg = -clamp01((-her - 0.95) * 1.4) * smoothstep(0.03, 0.15, hsl);
          if (hg < gullyV) gullyV = hg;
        }
        var coastal = smoothstep(0.02, 0.22, c);
        var roll = fbm(X / 650, Z / 650, octFor(650, 3, lodW), S_ROLL, 3) * (4 + 13 * hilly) * land * coastal * (1 - 0.7 * wet);

        // ---- Plateaus & escarpments
        var pn = m[M_PN];
        if (pn > 0.1 && lodW < 700) pn += 0.03 * snoise(X / 700, Z / 700, S_PLAT + 1);
        var platM = smoothstep(0.18, 0.205, pn) * smoothstep(0.25, 0.5, c) * (1 - mMask);
        var platH = platM * (170 + 180 * P.roughness);
        o.plat = platM;

        var h = base + hillH + roll + mtnH + platH;
        var gx = hgx + mgx, gz = hgz + mgz;
        o.gx = gx; o.gz = gz;
        o.gully = clamp01(-gullyV);

        // ---- Arid geology: mesas, terraces, canyons, dunes
        if (arid > 0.01) {
          var mesaN = fbm(X / 1900, Z / 1900, octFor(1900, 3, lodW), S_MESA, 3);
          var mesa = smoothstep(0.2, 0.26, mesaN + (lodW < 160 ? 0.02 * snoise(X / 160, Z / 160, S_MESA + 5) : 0)) * arid * land * (1 - mMask);
          h += mesa * (55 + 45 * snoise(X / 4000, Z / 4000, S_MESA + 9));
          var tStep = 34 + 16 * snoise(X / 6000, Z / 6000, S_TERR);
          var relief = h - base;
          var tw = arid * smoothstep(12, 45, relief) * (0.55 + 0.45 * mesa) * (1 - mMask) * (1 - mMask);
          if (tw > 0.001) h = mix(h, base + terrace(relief, tStep, 0.72), tw * 0.9);
          var cn = snoise(qx / 7500, qz / 7500, S_CANYON);
          var cg = Math.sqrt(_dx * _dx + _dy * _dy) / 7500;
          var cdist = Math.abs(cn) / Math.max(cg, 1.6 / 7500);
          var cw = 70 + 60 * hilly;
          var canyon = (1 - smoothstep(cw * 0.45, cw * 1.25, cdist)) * arid * smoothstep(30, 110, h - base) * land * smoothstep(1.4, 2.6, cg * 7500);
          if (canyon > 0.001) {
            var cdepth = Math.min(200, (h - base) * 0.85);
            h -= terrace(canyon, 0.25, 0.65) * cdepth;
          }
          var dm = smoothstep(0.45, 0.85, arid) * smoothstep(19, 26, T0) * smoothstep(90, 25, h - base) * land;
          if (dm > 0.01 && lodW < 60) {
            var dw = fbm(X / 420, Z / 420, 2, S_DUNE);
            var along = (X * 0.8 + Z * 0.6) / 78 + dw * 2.4;
            var ss = along - Math.floor(along);
            var dprof = ss < 0.72 ? smoothstep(0, 0.72, ss) : 1 - smoothstep(0.72, 1.0, ss);
            var along2 = (X * -0.35 + Z * 0.94) / 190 + dw * 1.2;
            var s2 = along2 - Math.floor(along2);
            var dprof2 = s2 < 0.7 ? smoothstep(0, 0.7, s2) : 1 - smoothstep(0.7, 1.0, s2);
            var damp = 5 + 10 * clamp01(snoise(X / 1600, Z / 1600, S_DUNE + 3) * 0.7 + 0.5);
            h += (dprof * 0.75 + dprof2 * 0.45) * damp * dm;
          }
        }

        // ---- Islands in shallow seas
        if (c < 0.08 && c > -0.95) {
          var isl = fbm(X / 3300 + 9.1, Z / 3300 - 4.4, octFor(3300, 4, lodW), S_ISLAND, 4);
          var im = smoothstep(0.34, 0.45, isl) * smoothstep(0.1, -0.12, c) * smoothstep(-0.9, -0.4, c);
          if (im > 0) h = mix(h, Math.max(h, 18 + 70 * clamp01((isl - 0.34) * 4) + roll * 2), im);
        }

        // ---- Volcanoes
        var volc = 0, lava = -1e5;
        if (!skipLandmarks && P.landmarkFrequency > 0.01) {
          var vci = Math.floor(X / VOLC_GRID), vcj = Math.floor(Z / VOLC_GRID);
          for (var vj = -1; vj <= 1; vj++) for (var vi = -1; vi <= 1; vi++) {
            var vc = volcanoCell(vci + vi, vcj + vj);
            if (!vc) continue;
            var vdx = X - vc.x, vdz = Z - vc.z, vd = Math.sqrt(vdx * vdx + vdz * vdz);
            if (vd > vc.R * 2.0) continue;
            var ang = Math.atan2(vdz, vdx), ca = Math.cos(ang), sa = Math.sin(ang);
            var rad = 1 + 0.07 * snoise(ca * 3.5 + vd / 900, sa * 3.5, S_VOLC + 7);
            var vt = clamp01(1 - vd / (vc.R * rad));
            var cone = vc.H * Math.pow(vt, 1.75);
            var rg = snoise(ca * 14, sa * 14 + vd / 500, S_VOLC + 3);
            cone *= 1 - 0.05 * Math.abs(rg) * smoothstep(0.05, 0.6, vt);
            var rc = vc.R * 0.12;
            var floorH = vc.baseH + vc.H * 0.7;
            var craterW = smoothstep(rc * 1.25, rc * 0.55, vd);
            var hv = h + cone;
            hv = mix(hv, Math.min(hv, floorH + (vd / rc) * vc.H * 0.08), craterW);
            h = hv;
            volc = Math.max(volc, smoothstep(vc.R * 1.9, vc.R * 0.7, vd));
            if (vd < rc * 0.62) lava = Math.max(lava, floorH + vc.H * 0.012);
          }
        }
        o.volc = volc; o.lava = lava;

        // ---- Detail: rock outcrops & micro relief
        var det = P.terrainDetail;
        var slp = Math.sqrt(gx * gx + gz * gz);
        var rockiness = clamp01(mMask * 1.1 + smoothstep(0.35, 0.9, slp) + arid * 0.35 + platM * 0.3 + volc * 0.5 + o.gully * 0.3);
        o.rock = rockiness;
        h += fbm(X / 90, Z / 90, octFor(90, 3, lodW), S_DETAIL, 3) * 1.6 * det * (0.35 + P.roughness) * land;
        if (rockiness > 0.05 && lodW < 90) {
          var oc = ridged(X / 170, Z / 170, octFor(170 / 2.03, 3, lodW) + 1, S_OUTCROP, 3, 0.4) * 1.7;
          h += oc * oc * 5 * rockiness * det;
        }
        if (lodW < 10) h += snoise(X / 11, Z / 11, S_MICRO) * 0.14 * det * land;

        o.base = base + platH;
        o.h = h;
        o.wet = wet;
        o.temp = T0;
        o.rl = base + mtnFloor + platH;
        o._rgate = m[M_RGATE]; o._pgate = m[M_PGATE];
        return h;
      }

      /* ------------------------------------------------------------ *
       * Landmark cells (cached)
       * ------------------------------------------------------------ */
      var tmpS = newSample();
      function peakCell(i, j) {
        var key = ckey(i, j);
        var v = peakCache.get(key);
        if (v !== undefined) return v;
        v = null;
        var hsh = hash01(i, j, S_PEAK);
        if (hsh < 0.3 * P.landmarkFrequency) {
          var x = (i + 0.25 + 0.5 * hash01(i, j, S_PEAK + 1)) * PEAK_GRID;
          var z = (j + 0.25 + 0.5 * hash01(i, j, S_PEAK + 2)) * PEAK_GRID;
          stageBase(x, z, tmpS, 400, true, macroFields(x, z, _mTmp2));
          if (tmpS.cont > 0.25 && tmpS.wet < 0.2) {
            v = { x: x, z: z, R: 4200 + 2800 * hash01(i, j, S_PEAK + 3), H: 1400 + 1400 * hash01(i, j, S_PEAK + 4) * P.mountainHeight };
          }
        }
        trimCache(peakCache);
        peakCache.set(key, v);
        return v;
      }
      function volcanoCell(i, j) {
        var key = ckey(i, j);
        var v = volcCache.get(key);
        if (v !== undefined) return v;
        v = null;
        var hsh = hash01(i, j, S_VOLC);
        if (hsh < 0.16 * P.landmarkFrequency) {
          var x = (i + 0.2 + 0.6 * hash01(i, j, S_VOLC + 1)) * VOLC_GRID;
          var z = (j + 0.2 + 0.6 * hash01(i, j, S_VOLC + 2)) * VOLC_GRID;
          stageBase(x, z, tmpS, 400, true, macroFields(x, z, _mTmp2));
          if (tmpS.cont > 0.18) {
            v = { x: x, z: z, R: 2600 + 1800 * hash01(i, j, S_VOLC + 3), H: 900 + 1100 * hash01(i, j, S_VOLC + 4), baseH: tmpS.h };
          }
        }
        trimCache(volcCache);
        volcCache.set(key, v);
        return v;
      }

      /* ------------------------------------------------------------ *
       * Stage 2 — rivers & streams
       * All channels share one smooth water-level field (o.rl) so that
       * confluences always meet at the same level.
       * ------------------------------------------------------------ */
      function stageRivers(X, Z, o, lodW) {
        var rf = P.riverFrequency;
        o.rdist = 1e9;
        if (rf <= 0.01 || o.cont < -0.05) return;
        var w1 = fbm(X / 3400, Z / 3400, 2, S_RWX), w2 = fbm(X / 3400 + 5.2, Z / 3400 - 1.7, 2, S_RWZ);
        var rx = X + w1 * 1000, rz = Z + w2 * 1000;
        var RW = 12500 / (0.35 + rf * 1.3);
        var v1 = snoise(rx / RW, rz / RW, S_RIVER);
        var g1x = _dx / RW, g1z = _dy / RW, gm1 = Math.sqrt(g1x * g1x + g1z * g1z);
        var d1 = Math.abs(v1) / Math.max(gm1, 1.2 / RW);
        var SW = RW * 0.31;
        var v2 = snoise(rx / SW + 7.7, rz / SW - 3.1, S_STREAM);
        var g2x = _dx / SW, g2z = _dy / SW, gm2 = Math.sqrt(g2x * g2x + g2z * g2z);
        var d2 = Math.abs(v2) / Math.max(gm2, 1.2 / SW);

        var gate = smoothstep(-0.3, 0.12, o._rgate + (rf - 0.5) * 0.5);
        var wetF = smoothstep(0.1, 0.34, o.moist);
        var coastF = smoothstep(-0.03, 0.02, o.cont);
        var mtnF = 1 - smoothstep(0.25, 0.6, o.mtn);
        var volF = 1 - smoothstep(0.1, 0.5, o.volc);
        var rs = gate * wetF * coastF * mtnF * volF;
        var lowF = 1 - smoothstep(0, 700, o.rl);
        // weak-gradient segments form small closed loops → fade them out
        var W1 = rs * (6 + 24 * lowF) * smoothstep(1.5, 2.8, gm1 * RW);
        var W2 = rs * smoothstep(0.25, 0.5, o.moist) * (1.6 + 2.6 * lowF) * smoothstep(0.02, 0.08, o.cont) * smoothstep(1.5, 2.8, gm2 * SW);
        if (W1 < 0.25 && W2 < 0.2) return;

        var rlSmooth = Math.max(o.rl, SEA + 0.55 * smoothstep(0.0, 0.06, o.cont));
        // Channel water level: terraced where the land rises steeply → rapids & waterfalls
        var rl = rlSmooth;
        var stepW = smoothstep(0.05, 0.25, o.mtn) + o.plat * 0.5;
        if (stepW > 0.01) {
          var stepH = 12 + 6 * snoise(X / 3000, Z / 3000, S_RIVER + 9);
          var tl = rl / stepH, fl = Math.floor(tl), fr = tl - fl;
          rl = mix(rl, (fl + smoothstep(0.9, 1.0, fr)) * stepH, clamp01(stepW));
        }

        // Valley carving (smooth level → no terraced walls); fades with river size
        var h = o.h;
        var vs1 = 0.12 + 0.3 * o.hilly + 0.3 * o.mtn;
        var fade1 = (1 - smoothstep(0.0, 0.3, W1 / 30)) * 900;
        var V1 = rlSmooth + 1.2 + Math.max(0, d1 - W1) * vs1 + fade1;
        var fade2 = (1 - smoothstep(0.0, 0.35, W2 / 4)) * 900;
        var V2 = rlSmooth + 0.8 + Math.max(0, d2 - W2) * (vs1 + 0.12) + fade2;
        var V = Math.min(V1, V2);
        if (V < h + 40) h = smin(h, V, 14);

        var p1 = W1 > 0.25 ? d1 / W1 : 1e9, p2 = W2 > 0.2 ? d2 / W2 : 1e9;
        var rho, W, fdx, fdz;
        if (p1 <= p2) { rho = p1; W = W1; fdx = -g1z; fdz = g1x; }
        else { rho = p2; W = W2; fdx = -g2z; fdz = g2x; }
        o.rdist = rho * W;
        if (rho < 3) {
          var depth = 0.9 + W * 0.11;
          if (rho < 1.4) {
            var bed = rl - depth * (1 - Math.min(rho * rho, 1));
            h = mix(h, Math.min(h, bed), smoothstep(1.4, 0.7, rho));
          }
          var liftW = smoothstep(0.75, 1.05, rho) * smoothstep(1.6 + 14 / W, 1.25 + 8 / W, rho) * smoothstep(-0.02, 0.03, o.cont);
          if (liftW > 0) h = mix(h, Math.max(h, rl + 0.35 + (rho - 1) * W * 0.06), liftW);
          if (rho < 1.2 && W > 0.6 && o.cont > -0.01) {
            o.water = rl; o.wtype = 3;
            var fl2 = Math.sqrt(fdx * fdx + fdz * fdz) || 1;
            fdx /= fl2; fdz /= fl2;
            var sgn = (fdx * o.cgx + fdz * o.cgz) > 0 ? -1 : 1;
            var spd = 0.7 + 2.5 * stepW + 0.4 * (1 - lowF);
            o.fx = fdx * sgn * spd; o.fz = fdz * sgn * spd;
          }
        }
        o.rl = rl;
        o.h = h;
      }

      /* ------------------------------------------------------------ *
       * Stage 3 — lakes & ponds in natural depressions (cached per cell)
       * ------------------------------------------------------------ */
      var tmpL = newSample();
      function heightNoLakes(x, z) {
        stageBase(x, z, tmpL, 0, false);
        stageRivers(x, z, tmpL, 0);
        return tmpL;
      }
      function lakeCellGeneric(i, j, grid, cache, sseed, prob, rMin, rMax, bigChance) {
        var key = ckey(i, j);
        var v = cache.get(key);
        if (v !== undefined) return v;
        v = null;
        if (hash01(i, j, sseed) < prob) {
          var cx = (i + 0.2 + 0.6 * hash01(i, j, sseed + 1)) * grid;
          var cz = (j + 0.2 + 0.6 * hash01(i, j, sseed + 2)) * grid;
          var hr = hash01(i, j, sseed + 3);
          var R = rMin + (rMax - rMin) * hr * hr;
          if (hash01(i, j, sseed + 4) < bigChance) R *= 2.6;
          var s = heightNoLakes(cx, cz);
          var ok = s.cont > 0.05 && s.mtn < 0.5 && s.volc < 0.2 && s.wtype === 0 && s.moist > 0.16 && s.arid < 0.6;
          if (ok) {
            var hc = s.h, minRim = 1e9;
            for (var a = 0; a < 12 && ok; a++) {
              var an = a / 12 * TAU;
              var rs = heightNoLakes(cx + Math.cos(an) * R * 1.15, cz + Math.sin(an) * R * 1.15);
              if (rs.wtype === 1 || rs.cont < 0.02) ok = false;
              if (rs.h < minRim) minRim = rs.h;
            }
            var level = minRim - 1.2;
            if (ok && hc < level + 7 && level > SEA + 1.0) {
              v = { x: cx, z: cz, R: R, level: level, depth: 2.5 + R * 0.035 };
            }
          }
        }
        trimCache(cache);
        cache.set(key, v);
        return v;
      }
      function applyLakeSet(X, Z, o, grid, cache, sseed, prob, rMin, rMax, bigChance) {
        var ci = Math.floor(X / grid), cj = Math.floor(Z / grid);
        for (var j = -1; j <= 1; j++) for (var i = -1; i <= 1; i++) {
          var L = lakeCellGeneric(ci + i, cj + j, grid, cache, sseed, prob, rMin, rMax, bigChance);
          if (!L) continue;
          var dx = X - L.x, dz = Z - L.z;
          var d2 = dx * dx + dz * dz, lim = L.R * 1.75;
          if (d2 > lim * lim) continue;
          var d = Math.sqrt(d2);
          var sh = 1 + 0.24 * snoise(X / (L.R * 0.8), Z / (L.R * 0.8), S_LSHAPE) + 0.06 * snoise(X / 60, Z / 60, S_LSHAPE + 1);
          var dl = d / L.R * sh;
          if (dl > 1.65) continue;
          var h = o.h;
          var Pin = dl < 1 ? L.level - L.depth * (1 - dl * dl) : L.level + (dl - 1) * L.R * 0.04;
          h = mix(h, Math.min(h, Pin), smoothstep(1.3, 0.55, dl));
          var wr = smoothstep(0.8, 1.05, dl) * smoothstep(1.62, 1.38, dl);
          if (wr > 0) h = mix(h, Math.max(h, L.level + 0.45 + (dl - 1) * L.R * 0.03), wr);
          o.h = h;
          if (dl < 1.2) {
            o.water = L.level; o.wtype = 2; o.fx = 0; o.fz = 0;
            o.lake = Math.max(o.lake, 1 - dl);
          }
          o.rdist = Math.min(o.rdist, Math.max(0, (dl - 1) * L.R));
        }
      }
      function stageLakes(X, Z, o) {
        o.lake = 0;
        if (P.lakeFrequency <= 0.01) return;
        applyLakeSet(X, Z, o, LAKE_GRID, lakeCache, S_LAKE, 0.62, 110, 520, 0.07);
        applyLakeSet(X, Z, o, POND_GRID, pondCache, S_POND, 0.34 * (0.4 + P.lakeFrequency), 22, 70, 0);
      }

      /* ------------------------------------------------------------ *
       * Full sample
       * ------------------------------------------------------------ */
      function sample(x, z, o, lodW, m) {
        var X = x * invScale, Z = z * invScale;
        lodW = (lodW || 0) * invScale;
        o.water = -1e5; o.wtype = 0; o.fx = 0; o.fz = 0;
        stageBase(X, Z, o, lodW, false, m);
        stageRivers(X, Z, o, lodW);
        stageLakes(X, Z, o);

        var h = o.h;
        // ---- Trails (dirt paths) through gentle land
        o.path = 0;
        var slope = Math.sqrt(o.gx * o.gx + o.gz * o.gz);
        if (o.cont > 0.06 && o.mtn < 0.55 && o.wtype === 0 && o.volc < 0.3) {
          var pg = smoothstep(-0.05, 0.25, o._pgate);
          if (pg > 0.01) {
            var pv = snoise(X / 1700 + 0.37 * snoise(X / 800, Z / 800, S_PATH + 2), Z / 1700, S_PATH);
            var pgm = Math.sqrt(_dx * _dx + _dy * _dy) / 1700;
            var pd = Math.abs(pv) / Math.max(pgm, 0.3 / 1700);
            var pm = (1 - smoothstep(0.7, 1.7, pd)) * pg * (1 - smoothstep(0.18, 0.4, slope)) * (1 - 0.7 * o.arid);
            pm *= smoothstep(4, 12, o.rdist);
            if (pm > 0.001) { h -= pm * 0.14; o.path = pm; }
          }
        }

        // ---- Lava lakes in volcano craters
        if (o.lava > -1e4 && o.lava > h) { o.water = o.lava; o.wtype = 4; }

        // ---- Ocean
        if (h < SEA && (o.wtype === 0 || o.water < SEA) && o.wtype !== 4) {
          o.water = SEA; o.wtype = 1; o.fx = 0; o.fz = 0;
        }
        o.h = h;

        // ---- Water proximity (for sand, moisture, vegetation)
        var dw = o.rdist;
        if (o.wtype > 0 && o.wtype < 4 && o.water > h) dw = 0;
        var oceanProx = 1 - smoothstep(0.5, 5.0, h - SEA);
        o.wprox = Math.max(1 - smoothstep(0, 45, dw), oceanProx * smoothstep(0.2, -0.05, o.cont + 0.1));
        // Temperature with altitude lapse rate (6.5 °C / km)
        o.temp = o.temp - 6.5 * Math.max(0, h - SEA) / 1000;
        o.moist = clamp01(o.moist + o.wprox * 0.2);
        return o;
      }

      function height(x, z) { return sample(x, z, tmpH, 0).h; }
      var tmpH = newSample();

      /* ------------------------------------------------------------ *
       * Biome classification (Whittaker-style with altitude/slope/water)
       * ------------------------------------------------------------ */
      function classify(o, slope) {
        var T = o.temp, M = o.moist, h = o.h;
        if (o.wtype === 1 && o.water - h > 0.2) return BIOME.OCEAN;
        if ((o.wtype === 2 || o.wtype === 3) && o.water - h > 0.2) return BIOME.FRESHWATER;
        if (o.volc > 0.5) return BIOME.VOLCANIC;
        if (h < SEA + 2.8 && o.cont < 0.16 && slope < 0.35 && T > -3 && o.wprox > 0.3) return BIOME.BEACH;
        if (T < -9) return slope < 0.55 ? BIOME.GLACIER : BIOME.HIGH_MOUNTAIN;
        if (T < -3.5) return slope > 0.75 ? BIOME.HIGH_MOUNTAIN : BIOME.SNOWFIELD;
        if (slope > 0.95 || (o.mtn > 0.55 && slope > 0.65)) return T < 2 ? BIOME.HIGH_MOUNTAIN : BIOME.MOUNTAIN;
        if (o.mtn > 0.45 && T < 3.5) return BIOME.ALPINE;
        if (T < 1) return BIOME.TUNDRA;
        if (o.wet > 0.5) return T > 21 ? BIOME.TROPICAL_SWAMP : BIOME.WETLAND;
        if (T < 7) return M > 0.36 ? BIOME.BOREAL_FOREST : (M > 0.11 ? BIOME.STEPPE : BIOME.COLD_DESERT);
        if (T < 19) {
          if (M < 0.17) return T < 12 && M < 0.11 ? BIOME.COLD_DESERT : (T < 12 ? BIOME.STEPPE : BIOME.ROCKY_DESERT);
          if (M < 0.3) return T < 12 ? BIOME.STEPPE : (o.cont < 0.3 && T > 14 ? BIOME.MEDITERRANEAN : BIOME.SHRUBLAND);
          if (M < 0.42) return o.cont < 0.3 && T > 14 ? BIOME.MEDITERRANEAN : BIOME.GRASSLAND;
          if (M > 0.74 && o.cont < 0.3 && T < 16) return BIOME.TEMPERATE_RAINFOREST;
          return o.cont < 0.2 ? BIOME.COASTAL_FOREST : BIOME.TEMPERATE_FOREST;
        }
        if (M < 0.15) return o.rock > 0.35 ? (slope > 0.3 ? BIOME.BADLANDS : BIOME.ROCKY_DESERT) : BIOME.DESERT;
        if (M < 0.24) return o.rock > 0.5 ? (slope > 0.3 ? BIOME.BADLANDS : BIOME.ROCKY_DESERT) : BIOME.DESERT;
        if (M < 0.32 && T < 23) return BIOME.SHRUBLAND;
        if (M < 0.48) return BIOME.SAVANNA;
        return M > 0.6 ? BIOME.TROPICAL_FOREST : (o.cont < 0.2 ? BIOME.COASTAL_FOREST : BIOME.SAVANNA);
      }

      /* ------------------------------------------------------------ *
       * Vegetation densities (shared by terrain shading & placement)
       * ------------------------------------------------------------ */
      function forestDensity(o, slope, X, Z) {
        if (o.wtype > 0 && o.water > o.h - 0.3) return 0;
        var T = o.temp, M = o.moist;
        var f = smoothstep(0.3, 0.58, M);
        f *= smoothstep(-2.5, 2.0, T);                 // tree line
        f *= 1 - 0.75 * smoothstep(24, 31, T) * (1 - smoothstep(0.5, 0.75, M)); // hot → savanna
        var clump = fbm(X / 1100, Z / 1100, 3, S_FOREST) + (M - 0.5) * 0.9;
        f *= smoothstep(-0.28, 0.2, clump);
        f *= 1 - smoothstep(0.55, 1.0, slope);
        f *= 1 - smoothstep(0.25, 0.9, o.volc);
        f *= 1 - 0.85 * o.path;
        f *= 1 - smoothstep(0.5, 0.2, o.h - SEA) ;
        f *= 1 - 0.6 * o.wet;
        f *= smoothstep(-0.02, 0.08, o.cont);
        return clamp01(f * P.forestDensity);
      }

      /* ------------------------------------------------------------ *
       * Terrain node (chunk) generation.
       * Vertex layout (36 bytes):
       *   0  f32x3 position (local x, height, local z)
       *   12 f32   morph height (height of the coarser LOD at this vertex)
       *   16 i16x4 normal (normalised) + w unused
       *   24 u8x4  climate: temperature, moisture, water proximity, volcanic
       *   28 u8x4  surface: curvature, rockiness, forest density, gully
       *   32 u8x4  extra:   trail, wetland, paint id, paint weight
       * ------------------------------------------------------------ */
      var VSTRIDE = 36;
      function generateNode(req) {
        var G = req.grid, size = req.size, dx = size / G;
        var ox = req.ox, oz = req.oz;
        var W = G + 3, VN = G + 1;
        var lodW = dx * 0.9;
        var hs = new Float32Array(W * W);
        var nVert = VN * VN + 4 * VN; // + skirts
        var buf = new ArrayBuffer(nVert * VSTRIDE);
        var f32 = new Float32Array(buf), i16 = new Int16Array(buf), u8 = new Uint8Array(buf);
        // water fields
        var wl = new Float32Array(VN * VN), wty = new Uint8Array(VN * VN);
        var wfx = new Float32Array(VN * VN), wfz = new Float32Array(VN * VN);
        var o = newSample();
        var mg = macroGrid(ox, oz, size, 16), mrec = newMacro();
        var minH = 1e9, maxH = -1e9, hasWater = false, waterMin = 1e9, waterMax = -1e9;
        var clim = new Uint8Array(VN * VN * 4), surf = new Uint8Array(VN * VN * 4), extra = new Uint8Array(VN * VN * 4);
        var fx, fz, X, Z;
        for (var j = 0; j < W; j++) {
          for (var i = 0; i < W; i++) {
            fx = ox + (i - 1) * dx; fz = oz + (j - 1) * dx;
            sample(fx, fz, o, lodW, macroAt(mg, fx, fz, mrec));
            hs[j * W + i] = o.h;
            var vi = i - 1, vj = j - 1;
            if (vi >= 0 && vj >= 0 && vi < VN && vj < VN) {
              var v = vj * VN + vi;
              if (o.h < minH) minH = o.h;
              if (o.h > maxH) maxH = o.h;
              if (o.wtype > 0) {
                wl[v] = o.water; wty[v] = o.wtype; wfx[v] = o.fx; wfz[v] = o.fz;
                if (o.water > o.h - 0.05) { hasWater = true; if (o.water < waterMin) waterMin = o.water; if (o.water > waterMax) waterMax = o.water; }
              } else { wl[v] = -1e5; wty[v] = 0; }
              var c4 = v * 4;
              clim[c4] = clamp((o.temp + 40) / 80 * 255, 0, 255);
              clim[c4 + 1] = clamp(o.moist * 255, 0, 255);
              clim[c4 + 2] = clamp(o.wprox * 255, 0, 255);
              clim[c4 + 3] = clamp(o.volc * 255, 0, 255);
              surf[c4 + 1] = clamp(o.rock * 255, 0, 255);
              X = fx * invScale; Z = fz * invScale;
              surf[c4 + 2] = clamp(forestDensity(o, Math.sqrt(o.gx * o.gx + o.gz * o.gz), X, Z) * 255, 0, 255);
              surf[c4 + 3] = clamp(o.gully * 255, 0, 255);
              extra[c4] = clamp(o.path * 255, 0, 255);
              extra[c4 + 1] = clamp(o.wet * 255, 0, 255);
            }
          }
        }
        buildVertexBuffer(hs, G, dx, clim, surf, extra, f32, i16, u8, size);
        var water = hasWater ? buildWater(hs, wl, wty, wfx, wfz, G, dx) : null;
        return {
          vbuf: buf, heights: hs, minH: minH, maxH: maxH,
          clim: clim, surf: surf, extra: extra,
          wl: wl, wty: wty, wfx: wfx, wfz: wfz,
          water: water, waterMin: waterMin, waterMax: waterMax
        };
      }

      /** Build (or rebuild after edits) the packed vertex buffer from a bordered height grid. */
      function buildVertexBuffer(hs, G, dx, clim, surf, extra, f32, i16, u8, size) {
        var W = G + 3, VN = G + 1;
        var skirt = Math.max(2, dx * 3);
        var i, j, v, o4, b;
        for (j = 0; j < VN; j++) {
          for (i = 0; i < VN; i++) {
            v = j * VN + i;
            var hi = (j + 1) * W + (i + 1);
            var h = hs[hi];
            var hl = hs[hi - 1], hr = hs[hi + 1], hd = hs[hi - W], hu = hs[hi + W];
            // normal via central differences
            var nx = (hl - hr), nz = (hd - hu), ny = 2 * dx;
            var nl = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
            nx *= nl; ny *= nl; nz *= nl;
            // morph target: height of the next coarser grid (consistent diagonal split)
            var mh;
            var ie = (i & 1) === 0, je = (j & 1) === 0;
            if (ie && je) mh = h;
            else if (!ie && je) mh = 0.5 * (hl + hr);
            else if (ie && !je) mh = 0.5 * (hd + hu);
            else mh = 0.5 * (hs[hi - W - 1] + hs[hi + W + 1]);
            // curvature (depression > 0.5)
            var dev = (hl + hr + hd + hu) * 0.25 - h;
            var curv = clamp(0.5 + dev / (dx * 0.12 + 0.05), 0, 1);
            b = v * VSTRIDE;
            f32[b >> 2] = i * dx; f32[(b >> 2) + 1] = h; f32[(b >> 2) + 2] = j * dx; f32[(b >> 2) + 3] = mh;
            i16[(b + 16) >> 1] = nx * 32767; i16[((b + 16) >> 1) + 1] = ny * 32767; i16[((b + 16) >> 1) + 2] = nz * 32767; i16[((b + 16) >> 1) + 3] = 0;
            o4 = v * 4;
            u8[b + 24] = clim[o4]; u8[b + 25] = clim[o4 + 1]; u8[b + 26] = clim[o4 + 2]; u8[b + 27] = clim[o4 + 3];
            u8[b + 28] = curv * 255; u8[b + 29] = surf[o4 + 1]; u8[b + 30] = surf[o4 + 2]; u8[b + 31] = surf[o4 + 3];
            u8[b + 32] = extra[o4]; u8[b + 33] = extra[o4 + 1]; u8[b + 34] = extra[o4 + 2]; u8[b + 35] = extra[o4 + 3];
          }
        }
        // Skirts: duplicate edge vertices pushed down (hides cracks between LODs)
        var base = VN * VN;
        for (var e = 0; e < 4; e++) {
          for (var k = 0; k < VN; k++) {
            var si;
            if (e === 0) si = k;                     // z = 0 edge
            else if (e === 1) si = (VN - 1) * VN + k; // z = max edge
            else if (e === 2) si = k * VN;            // x = 0 edge
            else si = k * VN + VN - 1;                // x = max edge
            var src = si * VSTRIDE, dst = (base + e * VN + k) * VSTRIDE;
            for (var q = 0; q < VSTRIDE; q++) u8[dst + q] = u8[src + q];
            f32[(dst >> 2) + 1] -= skirt; f32[(dst >> 2) + 3] -= skirt;
          }
        }
      }

      /** Water surface mesh for a node: vertices at the water level, only cells that contain water. */
      function buildWater(hs, wl, wty, wfx, wfz, G, dx) {
        var VN = G + 1, W = G + 3;
        var lvl = new Float32Array(VN * VN), has = new Uint8Array(VN * VN);
        var i, j, v;
        for (v = 0; v < VN * VN; v++) { lvl[v] = wl[v]; has[v] = wl[v] > -1e4 ? 1 : 0; }
        // dilate one ring so the surface tucks under the shoreline
        var lvl2 = new Float32Array(lvl), has2 = new Uint8Array(has), fx2 = new Float32Array(wfx), fz2 = new Float32Array(wfz), ty2 = new Uint8Array(wty);
        for (j = 0; j < VN; j++) for (i = 0; i < VN; i++) {
          v = j * VN + i;
          if (has[v]) continue;
          var sum = 0, n = 0, bestT = 0, sfx = 0, sfz = 0;
          for (var dj = -1; dj <= 1; dj++) for (var di = -1; di <= 1; di++) {
            var ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= VN || jj >= VN) continue;
            var u = jj * VN + ii;
            if (has[u]) { sum += lvl[u]; n++; bestT = wty[u]; sfx += wfx[u]; sfz += wfz[u]; }
          }
          if (n) { lvl2[v] = sum / n; has2[v] = 1; ty2[v] = bestT; fx2[v] = sfx / n; fz2[v] = sfz / n; }
        }
        // collect cells where every corner has a level and at least one corner is wet
        var idx = [];
        for (j = 0; j < G; j++) for (i = 0; i < G; i++) {
          var a = j * VN + i, b = a + 1, c = a + VN, d = c + 1;
          if (!(has2[a] && has2[b] && has2[c] && has2[d])) continue;
          var wetAny = false;
          var corners = [a, b, c, d];
          for (var q = 0; q < 4; q++) {
            var cv = corners[q], ci = cv % VN, cj = (cv / VN) | 0;
            if (lvl2[cv] > hs[(cj + 1) * W + ci + 1] - 0.05) { wetAny = true; break; }
          }
          if (!wetAny) continue;
          idx.push(a, c, d, a, d, b);
        }
        if (!idx.length) return null;
        // vertex buffer: f32 x, y, z, morphY, i16 flowx, flowz, u8 type, pad, pad, pad  (24 bytes)
        var vb = new ArrayBuffer(VN * VN * 24);
        var f32 = new Float32Array(vb), i16 = new Int16Array(vb), u8 = new Uint8Array(vb);
        for (j = 0; j < VN; j++) for (i = 0; i < VN; i++) {
          v = j * VN + i;
          var L = has2[v] ? lvl2[v] : -1e3;
          var ie = (i & 1) === 0, je = (j & 1) === 0, mh = L;
          if (has2[v]) {
            var pa = -1, pb = -1;
            if (!ie && je) { pa = v - 1; pb = v + 1; }
            else if (ie && !je) { pa = v - VN; pb = v + VN; }
            else if (!ie && !je) { pa = v - VN - 1; pb = v + VN + 1; }
            if (pa >= 0 && has2[pa] && has2[pb]) mh = 0.5 * (lvl2[pa] + lvl2[pb]);
          }
          var o = v * 24;
          f32[o >> 2] = i * dx; f32[(o >> 2) + 1] = L; f32[(o >> 2) + 2] = j * dx; f32[(o >> 2) + 3] = mh;
          i16[(o + 16) >> 1] = clamp(fx2[v] * 8000, -32767, 32767);
          i16[((o + 16) >> 1) + 1] = clamp(fz2[v] * 8000, -32767, 32767);
          u8[o + 20] = ty2[v];
        }
        var ib = (VN * VN > 65535) ? new Uint32Array(idx) : new Uint16Array(idx);
        return { vbuf: vb, ibuf: ib.buffer, i32: ib instanceof Uint32Array, count: idx.length };
      }

      /* ------------------------------------------------------------ *
       * Vegetation placement
       * Tree cells (256 m): trees + boulders (visible from far away)
       * Prop cells (64 m):   bushes, ferns, logs, rocks, cacti, reeds …
       * Instance record (8 floats): x, y, z, rotation, scale, type, variant, tint
       * ------------------------------------------------------------ */
      var TREE = { CONIFER: 0, PINE: 1, OAK: 2, BIRCH: 3, PALM: 4, ACACIA: 5, DEAD: 6, CACTUS: 7, TROPICAL: 8, ANCIENT: 9, BOULDER: 10 };
      var PROP = { BUSH: 0, FERN: 1, SHRUB_DRY: 2, LOG: 3, BRANCH: 4, ROCK: 5, PEBBLES: 6, MUSHROOM: 7, REEDS: 8, CACTUS_SMALL: 9, FLOWERS: 10, STUMP: 11, TUMBLE: 12 };

      /** Coarse field grid for fast rejection sampling. */
      function fieldGrid(ox, oz, size, n) {
        var st = size / n, N = n + 1;
        var g = { n: n, st: st, ox: ox, oz: oz, h: new Float64Array(N * N), T: new Float64Array(N * N), M: new Float64Array(N * N),
          f: new Float64Array(N * N), s: new Float64Array(N * N), w: new Float64Array(N * N), wat: new Uint8Array(N * N),
          rock: new Float64Array(N * N), volc: new Float64Array(N * N), path: new Float64Array(N * N), wet: new Float64Array(N * N),
          arid: new Float64Array(N * N), mtn: new Float64Array(N * N), cont: new Float64Array(N * N), wprox: new Float64Array(N * N) };
        var o = newSample();
        var mg = macroGrid(ox, oz, size, 4), mrec = newMacro();
        g.mg = mg; g.mrec = mrec;
        for (var j = 0; j < N; j++) for (var i = 0; i < N; i++) {
          var x = ox + i * st, z = oz + j * st, k2 = j * N + i;
          sample(x, z, o, st * 0.5, macroAt(mg, x, z, mrec));
          g.h[k2] = o.h; g.T[k2] = o.temp; g.M[k2] = o.moist; g.rock[k2] = o.rock; g.volc[k2] = o.volc;
          g.path[k2] = o.path; g.wet[k2] = o.wet; g.arid[k2] = o.arid; g.mtn[k2] = o.mtn; g.cont[k2] = o.cont; g.wprox[k2] = o.wprox;
          g.wat[k2] = (o.wtype > 0 && o.water > o.h - 0.25) ? o.wtype : 0;
          g.s[k2] = Math.sqrt(o.gx * o.gx + o.gz * o.gz);
          g.f[k2] = forestDensity(o, g.s[k2], x * invScale, z * invScale);
        }
        // slope from the grid itself (more accurate than the analytic estimate)
        for (j = 0; j < N; j++) for (i = 0; i < N; i++) {
          var kk = j * N + i;
          var hl = g.h[j * N + Math.max(0, i - 1)], hr = g.h[j * N + Math.min(n, i + 1)];
          var hd = g.h[Math.max(0, j - 1) * N + i], hu = g.h[Math.min(n, j + 1) * N + i];
          var sx = (hr - hl) / (st * ((i > 0 && i < n) ? 2 : 1)), sz = (hu - hd) / (st * ((j > 0 && j < n) ? 2 : 1));
          g.s[kk] = Math.max(g.s[kk] * 0.5, Math.sqrt(sx * sx + sz * sz));
        }
        return g;
      }
      function gridAt(g, arr, x, z) {
        var fx = (x - g.ox) / g.st, fz = (z - g.oz) / g.st, N = g.n + 1;
        var i = Math.min(g.n - 1, Math.max(0, Math.floor(fx))), j = Math.min(g.n - 1, Math.max(0, Math.floor(fz)));
        var tx = fx - i, tz = fz - j;
        var a = arr[j * N + i], b = arr[j * N + i + 1], c = arr[(j + 1) * N + i], d = arr[(j + 1) * N + i + 1];
        return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
      }
      function gridMax(g, arr, x, z) {
        var fx = (x - g.ox) / g.st, fz = (z - g.oz) / g.st, N = g.n + 1;
        var i = Math.min(g.n - 1, Math.max(0, Math.floor(fx))), j = Math.min(g.n - 1, Math.max(0, Math.floor(fz)));
        return Math.max(arr[j * N + i], arr[j * N + i + 1], arr[(j + 1) * N + i], arr[(j + 1) * N + i + 1]);
      }

      function pushInst(out, x, y, z, rot, sc, type, variant, tint) { out.push(x, y, z, rot, sc, type, variant, tint); }

      function generateTreeCell(req) {
        var size = req.size, ox = req.ix * size, oz = req.iz * size;
        var g = fieldGrid(ox, oz, size, 16);
        var rng = makeRng(ihash(req.ix, req.iz, S_VEG));
        var out = [];
        var spacing = 5.2;
        var n = Math.floor(size / spacing);
        var o = newSample();
        var vd = P.vegetationDensity;
        // ancient forest landmark: some forest regions get giant trees
        var ancient = smoothstep(0.62, 0.7, fbm(ox / 6000, oz / 6000, 2, S_FOREST + 11)) * P.landmarkFrequency * 2;
        for (var j = 0; j < n; j++) {
          for (var i = 0; i < n; i++) {
            var x = ox + (i + 0.15 + 0.7 * rng()) * spacing, z = oz + (j + 0.15 + 0.7 * rng()) * spacing;
            var r0 = rng(), r1 = rng(), r2 = rng(), r3 = rng();
            if (gridMax(g, g.wat, x, z) > 0) continue;
            var f = gridAt(g, g.f, x, z), T = gridAt(g, g.T, x, z), M = gridAt(g, g.M, x, z);
            var s = gridAt(g, g.s, x, z), arid = gridAt(g, g.arid, x, z), volc = gridAt(g, g.volc, x, z);
            var hh = gridAt(g, g.h, x, z), path = gridAt(g, g.path, x, z), rock = gridAt(g, g.rock, x, z);
            var wprox = gridAt(g, g.wprox, x, z), cont = gridAt(g, g.cont, x, z);
            if (path > 0.25 || hh < SEA + 0.4) continue;
            var type = -1, scale = 1;
            // density: forest + sparse savanna/steppe trees
            var dens = f * 0.92 * vd;
            var sparse = 0;
            if (T > 18 && M > 0.22 && M < 0.55) sparse = 0.045;             // savanna acacias
            else if (T > 3 && M > 0.25) sparse = 0.02;                      // lone trees in grassland
            if (arid > 0.4 && T > 17) sparse = 0.02 * (1 - smoothstep(0.35, 0.8, s)); // cacti
            if (volc > 0.3) sparse = 0.012;
            dens = Math.max(dens, sparse * vd);
            if (r0 < dens) {
              // species selection
              if (volc > 0.3) type = TREE.DEAD;
              else if (arid > 0.4 && T > 17) type = TREE.CACTUS;
              else if (T > 23 && M > 0.58) type = (wprox > 0.5 || cont < 0.1) && r1 < 0.6 ? TREE.PALM : TREE.TROPICAL;
              else if (T > 19 && M < 0.58) type = r1 < 0.85 ? TREE.ACACIA : TREE.DEAD;
              else if (cont < 0.1 && T > 16 && wprox > 0.6 && r1 < 0.5) type = TREE.PALM;
              else if (T < 5.5) type = r1 < 0.75 ? TREE.CONIFER : (r1 < 0.93 ? TREE.PINE : TREE.DEAD);
              else if (T < 10) type = r1 < 0.45 ? TREE.CONIFER : (r1 < 0.7 ? TREE.PINE : (r1 < 0.88 ? TREE.BIRCH : TREE.OAK));
              else if (T < 16) type = r1 < 0.5 ? TREE.OAK : (r1 < 0.72 ? TREE.BIRCH : (r1 < 0.9 ? TREE.PINE : TREE.CONIFER));
              else type = r1 < 0.62 ? TREE.OAK : (r1 < 0.8 ? TREE.PINE : TREE.BIRCH);
              if (type === TREE.OAK && ancient > 0.3 && r3 < 0.35 * ancient) type = TREE.ANCIENT;
              // age / size variation, smaller at the tree line and on slopes
              var age = 0.55 + 0.6 * Math.pow(r2, 0.7);
              scale = age * (0.75 + 0.35 * smoothstep(-2, 8, T)) * (1 - 0.35 * smoothstep(0.35, 0.8, s));
              if (f < 0.3 && type !== TREE.ACACIA && type !== TREE.CACTUS) scale *= 0.85;
            } else if (rock > 0.25 && r0 > 1 - 0.018 * rock * P.rockDensity * (0.6 + s)) {
              type = TREE.BOULDER; scale = 0.8 + 2.4 * r2 * r2;
            }
            if (type < 0) continue;
            sample(x, z, o, 0, macroAt(g.mg, x, z, g.mrec));
            if (o.wtype > 0 && o.water > o.h - 0.3) continue;
            var y = o.h - (type === TREE.BOULDER ? scale * 0.35 : 0.08);
            pushInst(out, x, y, z, r3 * TAU, scale, type, Math.floor(rng() * 4), rng());
          }
        }
        return { inst: new Float32Array(out) };
      }

      function generatePropCell(req) {
        var size = req.size, ox = req.ix * size, oz = req.iz * size;
        var g = fieldGrid(ox, oz, size, 8);
        var rng = makeRng(ihash(req.ix, req.iz, S_VEG + 101));
        var out = [];
        var spacing = 2.3;
        var n = Math.floor(size / spacing);
        var o = newSample();
        var vd = P.vegetationDensity, rd = P.rockDensity;
        for (var j = 0; j < n; j++) {
          for (var i = 0; i < n; i++) {
            var x = ox + (i + 0.1 + 0.8 * rng()) * spacing, z = oz + (j + 0.1 + 0.8 * rng()) * spacing;
            var r0 = rng(), r1 = rng(), r2 = rng(), r3 = rng();
            var wat = gridMax(g, g.wat, x, z);
            var f = gridAt(g, g.f, x, z), T = gridAt(g, g.T, x, z), M = gridAt(g, g.M, x, z);
            var s = gridAt(g, g.s, x, z), arid = gridAt(g, g.arid, x, z), rock = gridAt(g, g.rock, x, z);
            var wprox = gridAt(g, g.wprox, x, z), path = gridAt(g, g.path, x, z), hh = gridAt(g, g.h, x, z);
            var volc = gridAt(g, g.volc, x, z), wet = gridAt(g, g.wet, x, z);
            var type = -1, scale = 1;
            if (path > 0.3) { if (r0 < 0.01) { type = PROP.PEBBLES; scale = 0.6 + r2; } }
            else if (wat && hh > SEA - 1.2 && wprox > 0.6 && T > 2 && wat !== 4) {
              if (r0 < 0.07 * vd) { type = PROP.REEDS; scale = 0.7 + 0.6 * r2; }
            } else if (!wat) {
              var rockP = 0.004 + 0.05 * rock * (0.5 + s) * rd;
              if (r0 < rockP) { type = r1 < 0.6 ? PROP.ROCK : PROP.PEBBLES; scale = 0.35 + 1.3 * r2 * r2; }
              else if (arid > 0.4 && T > 16) {
                var q = r0 - rockP;
                if (q < 0.012 * vd) { type = PROP.CACTUS_SMALL; scale = 0.6 + 0.7 * r2; }
                else if (q < 0.04 * vd) { type = PROP.SHRUB_DRY; scale = 0.5 + 0.7 * r2; }
                else if (q < 0.043 * vd) { type = PROP.TUMBLE; scale = 0.6 + 0.5 * r2; }
              } else if (volc > 0.4) {
                if (r0 - rockP < 0.03 * rd) { type = PROP.ROCK; scale = 0.3 + 0.9 * r2; }
              } else if (T > -1) {
                var q2 = r0 - rockP;
                var bushP = (0.018 + 0.05 * f + 0.04 * wet) * vd * smoothstep(0.15, 0.45, M);
                if (q2 < bushP) { type = PROP.BUSH; scale = 0.5 + 0.9 * r2; }
                else if ((q2 -= bushP) < 0.06 * f * vd * smoothstep(0.45, 0.7, M) * smoothstep(4, 12, T)) { type = PROP.FERN; scale = 0.6 + 0.7 * r2; }
                else if ((q2 -= 0.06 * f * vd) < 0.012 * f) { type = r1 < 0.6 ? PROP.LOG : PROP.STUMP; scale = 0.7 + 0.6 * r2; }
                else if ((q2 -= 0.012 * f) < 0.02 * f) { type = PROP.BRANCH; scale = 0.6 + 0.8 * r2; }
                else if ((q2 -= 0.02 * f) < 0.012 * f * smoothstep(0.5, 0.75, M)) { type = PROP.MUSHROOM; scale = 0.6 + 0.8 * r2; }
                else if ((q2 -= 0.012 * f) < 0.035 * vd * (1 - f) * smoothstep(0.3, 0.55, M) * smoothstep(6, 14, T)) { type = PROP.FLOWERS; scale = 0.7 + 0.6 * r2; }
              }
              if (type === PROP.BUSH && T < 3) scale *= 0.7;
            }
            if (type < 0) continue;
            sample(x, z, o, 0, macroAt(g.mg, x, z, g.mrec));
            if (type !== PROP.REEDS && o.wtype > 0 && o.water > o.h - 0.1) continue;
            if (type === PROP.REEDS && !(o.wtype > 0 && o.water - o.h < 0.9 && o.water - o.h > -0.4)) continue;
            var y = o.h - (type === PROP.ROCK ? scale * 0.25 : (type === PROP.LOG ? -0.05 : 0.03));
            pushInst(out, x, y, z, r3 * TAU, scale, type, Math.floor(rng() * 4), rng());
          }
        }
        return { inst: new Float32Array(out) };
      }

      /* ------------------------------------------------------------ *
       * Points of interest (deterministic per 1024 m cell)
       * ------------------------------------------------------------ */
      var POI = { NONE: 0, RUINS: 1, CAMP: 2, VILLAGE: 3, TOWER: 4, STONES: 5, ARCH: 6, CAVE: 7, MONOLITH: 8, SHRINE: 9 };
      var POI_NAMES = ['', 'Ancient Ruins', 'Campsite', 'Village', 'Watchtower', 'Standing Stones', 'Natural Arch', 'Cave', 'Monolith', 'Shrine'];
      var POI_GRID = 1024;
      var poiCache = new Map();
      function poiCell(i, j) {
        var key = ckey(i, j);
        var v = poiCache.get(key);
        if (v !== undefined) return v;
        v = null;
        var lf = P.landmarkFrequency, cf = P.caveFrequency;
        var r = hash01(i, j, S_POI);
        if (r < 0.2 * (lf + 0.2)) {
          var x = (i + 0.2 + 0.6 * hash01(i, j, S_POI + 1)) * POI_GRID;
          var z = (j + 0.2 + 0.6 * hash01(i, j, S_POI + 2)) * POI_GRID;
          var o = newSample();
          sample(x, z, o, 0);
          var hL = height(x - 6, z), hR = height(x + 6, z), hD = height(x, z - 6), hU = height(x, z + 6);
          var slope = Math.sqrt((hR - hL) * (hR - hL) + (hU - hD) * (hU - hD)) / 12;
          var dry = !(o.wtype > 0 && o.water > o.h - 0.5) && o.h > SEA + 1.5;
          var t = hash01(i, j, S_POI + 3);
          var type = 0;
          if (dry) {
            var flat = slope < 0.12;
            if (slope > 0.45 && slope < 1.4 && o.rock > 0.3 && t < 0.3 + 0.4 * cf) type = POI.CAVE;
            else if (o.arid > 0.4 && o.rock > 0.2 && slope < 0.5 && t < 0.25 + 0.4 * cf) type = POI.ARCH;
            else if (flat && o.wprox > 0.15 && o.temp > 4 && o.moist > 0.3 && t < 0.12) type = POI.VILLAGE;
            else if (flat && t < 0.36) type = POI.RUINS;
            else if (flat && o.temp > 0 && t < 0.56) type = POI.CAMP;
            else if (slope < 0.25 && o.hilly > 0.4 && t < 0.68) type = POI.TOWER;
            else if (slope < 0.2 && (o.temp < 8 || o.moist < 0.45) && t < 0.8) type = POI.STONES;
            else if (slope < 0.3 && t < 0.9) type = POI.MONOLITH;
            else if (slope < 0.25) type = POI.SHRINE;
          }
          if (type) {
            // caves face downhill
            var rot = type === POI.CAVE ? Math.atan2(hR - hL, hU - hD) : hash01(i, j, S_POI + 4) * TAU;
            v = { id: i + ':' + j, type: type, x: x, z: z, y: o.h, rot: rot, seed: ihash(i, j, S_POI + 5), relic: hash01(i, j, S_POI + 6) < 0.45, name: POI_NAMES[type] };
          }
        }
        if (poiCache.size > 4000) poiCache.clear();
        poiCache.set(key, v);
        return v;
      }
      function poisNear(x, z, radius) {
        var out = [];
        var i0 = Math.floor((x - radius) / POI_GRID), i1 = Math.floor((x + radius) / POI_GRID);
        var j0 = Math.floor((z - radius) / POI_GRID), j1 = Math.floor((z + radius) / POI_GRID);
        for (var j = j0; j <= j1; j++) for (var i = i0; i <= i1; i++) {
          var p = poiCell(i, j);
          if (p) out.push(p);
        }
        return out;
      }
      /** Big terrain landmarks (volcanoes, giant peaks, large lakes) near a point. */
      function landmarksNear(x, z, radius) {
        var X = x * invScale, Z = z * invScale, R = radius * invScale, out = [], i, j, c;
        var sc = P.terrainScale;
        for (j = Math.floor((Z - R) / VOLC_GRID); j <= Math.floor((Z + R) / VOLC_GRID); j++)
          for (i = Math.floor((X - R) / VOLC_GRID); i <= Math.floor((X + R) / VOLC_GRID); i++) {
            c = volcanoCell(i, j); if (c) out.push({ type: 'volcano', name: 'Volcano', x: c.x * sc, z: c.z * sc, r: c.R * sc });
          }
        for (j = Math.floor((Z - R) / PEAK_GRID); j <= Math.floor((Z + R) / PEAK_GRID); j++)
          for (i = Math.floor((X - R) / PEAK_GRID); i <= Math.floor((X + R) / PEAK_GRID); i++) {
            c = peakCell(i, j); if (c) out.push({ type: 'peak', name: 'Great Peak', x: c.x * sc, z: c.z * sc, r: c.R * sc });
          }
        for (j = Math.floor((Z - R) / LAKE_GRID); j <= Math.floor((Z + R) / LAKE_GRID); j++)
          for (i = Math.floor((X - R) / LAKE_GRID); i <= Math.floor((X + R) / LAKE_GRID); i++) {
            c = lakeCellGeneric(i, j, LAKE_GRID, lakeCache, S_LAKE, 0.62, 110, 520, 0.07);
            if (c && c.R > 600) out.push({ type: 'lake', name: 'Great Lake', x: c.x * sc, z: c.z * sc, r: c.R * sc });
          }
        return out;
      }

      /* ------------------------------------------------------------ *
       * Map tiles (RGBA) — shaded biome map straight from world data
       * ------------------------------------------------------------ */
      function generateMapTile(req) {
        var N = req.res, x0 = req.x0, z0 = req.z0, mpp = req.mpp;
        var px = new Uint8ClampedArray(N * N * 4);
        var hs = new Float32Array((N + 1) * (N + 1));
        var info = new Uint8Array(N * N * 2);
        var o = newSample();
        var cols = new Float32Array(N * N * 3), wat = new Float32Array(N * N);
        var mg = macroGrid(x0, z0, N * mpp, Math.max(4, N >> 3)), mrec = newMacro();
        for (var j = 0; j <= N; j++) for (var i = 0; i <= N; i++) {
          var x = x0 + i * mpp, z = z0 + j * mpp;
          sample(x, z, o, mpp, macroAt(mg, x, z, mrec));
          hs[j * (N + 1) + i] = o.h;
          if (i < N && j < N) {
            var k2 = j * N + i;
            var sl = Math.sqrt(o.gx * o.gx + o.gz * o.gz);
            var b = classify(o, sl);
            var col = BIOME_COLORS[b];
            var r = col[0], g = col[1], bb = col[2];
            if (o.path > 0.5 && mpp < 8) { r = 150; g = 120; bb = 84; }
            // snow cover
            if (o.temp < -2 && b !== BIOME.OCEAN) { var sn = smoothstep(-2, -6, o.temp); r = mix(r, 240, sn); g = mix(g, 243, sn); bb = mix(bb, 247, sn); }
            cols[k2 * 3] = r; cols[k2 * 3 + 1] = g; cols[k2 * 3 + 2] = bb;
            wat[k2] = (o.wtype > 0 && o.water > o.h) ? (o.wtype === 4 ? -1 : o.water - o.h) : 0;
            info[k2 * 2] = b; info[k2 * 2 + 1] = o.wtype;
          }
        }
        for (j = 0; j < N; j++) for (i = 0; i < N; i++) {
          var k3 = j * (N + 1) + i;
          var dzx = hs[k3 + 1] - hs[k3], dzz = hs[k3 + N + 1] - hs[k3];
          var nx = -dzx / mpp, nz = -dzz / mpp;
          var shade = clamp(1 + (nx * -0.6 + nz * -0.75) * 0.9, 0.35, 1.45);
          var k4 = j * N + i, w = wat[k4];
          var r2 = cols[k4 * 3] * shade, g2 = cols[k4 * 3 + 1] * shade, b2 = cols[k4 * 3 + 2] * shade;
          if (w > 0) {
            var dd = clamp01(w / 60);
            r2 = mix(70, 18, dd); g2 = mix(128, 52, dd); b2 = mix(168, 96, dd);
          } else if (w < 0) { r2 = 255; g2 = 110; b2 = 30; }
          // contour lines every 100 m
          var hh = hs[k3];
          if (hh > SEA && mpp <= 32) {
            var cl = hh / 100, fr = cl - Math.floor(cl);
            if (fr < mpp / 100 * 0.9) { r2 *= 0.86; g2 *= 0.86; b2 *= 0.86; }
          }
          px[k4 * 4] = r2; px[k4 * 4 + 1] = g2; px[k4 * 4 + 2] = b2; px[k4 * 4 + 3] = 255;
        }
        return { pixels: px, info: info };
      }

      /** Find a pleasant spawn point near (x,z): dry land, gentle slope, temperate if possible. */
      function findSpawn(x, z) {
        var o = newSample(), best = null, bestScore = -1e9;
        for (var r = 0; r < 60000; r += 400) {
          var steps = r === 0 ? 1 : Math.max(8, Math.floor(r / 300));
          for (var a = 0; a < steps; a++) {
            var an = a / steps * TAU + r * 0.001;
            var px = x + Math.cos(an) * r, pz = z + Math.sin(an) * r;
            sample(px, pz, o, 0);
            if (o.wtype > 0 && o.water > o.h - 0.5) continue;
            if (o.h < SEA + 2) continue;
            var hs = height(px + 3, pz), hz = height(px, pz + 3);
            var sl = Math.sqrt((hs - o.h) * (hs - o.h) + (hz - o.h) * (hz - o.h)) / 3;
            if (sl > 0.25) continue;
            var score = -Math.abs(o.temp - 14) * 0.5 - Math.abs(o.moist - 0.5) * 10 - sl * 20 - r * 0.0004 + o.mtn * 6 + o.wprox * 3 + o.hilly * 3;
            if (score > bestScore) { bestScore = score; best = { x: px, z: pz, y: o.h }; }
          }
          if (best && r > 3000) break;
        }
        return best || { x: x, z: z, y: height(x, z) };
      }

      return {
        seed: seed, params: P, SEA: SEA,
        newSample: newSample, sample: sample, height: height, classify: classify,
        forestDensity: function (o, slope, x, z) { return forestDensity(o, slope, x * invScale, z * invScale); },
        generateNode: generateNode, buildVertexBuffer: buildVertexBuffer, buildWater: buildWater,
        generateTreeCell: generateTreeCell, generatePropCell: generatePropCell,
        generateMapTile: generateMapTile, findSpawn: findSpawn,
        poisNear: poisNear, poiCell: poiCell, landmarksNear: landmarksNear,
        VSTRIDE: VSTRIDE, POI_GRID: POI_GRID
      };
    }

    return {
      createGenerator: createGenerator,
      DEFAULT_PARAMS: DEFAULT_PARAMS,
      BIOME: BIOME, BIOME_NAMES: BIOME_NAMES, BIOME_COLORS: BIOME_COLORS,
      TREE: { CONIFER: 0, PINE: 1, OAK: 2, BIRCH: 3, PALM: 4, ACACIA: 5, DEAD: 6, CACTUS: 7, TROPICAL: 8, ANCIENT: 9, BOULDER: 10 },
      PROP: { BUSH: 0, FERN: 1, SHRUB_DRY: 2, LOG: 3, BRANCH: 4, ROCK: 5, PEBBLES: 6, MUSHROOM: 7, REEDS: 8, CACTUS_SMALL: 9, FLOWERS: 10, STUMP: 11, TUMBLE: 12 },
      POI: { NONE: 0, RUINS: 1, CAMP: 2, VILLAGE: 3, TOWER: 4, STONES: 5, ARCH: 6, CAVE: 7, MONOLITH: 8, SHRINE: 9 },
      stringToSeed: stringToSeed, ihash: ihash, hash01: hash01, makeRng: makeRng,
      snoise: snoise, fbm: fbm, voronoi: voronoi, pnoise: pnoise,
      smoothstep: smoothstep, clamp: clamp, mix: mix
    };
  }

  root.TERRA = root.TERRA || {};
  root.TERRA.TerrainCoreFactory = TerrainCoreFactory;
  root.TERRA.core = TerrainCoreFactory();
  if (typeof module !== 'undefined' && module.exports) module.exports = TerrainCoreFactory;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
