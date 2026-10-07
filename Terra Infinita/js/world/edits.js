/* =============================================================================
 * TERRA INFINITA — editable world layer
 * Procedural terrain is never mutated; the editor writes into sparse tiles that
 * are layered on top: height deltas, material paint, biome overrides, water
 * overrides, vegetation removals/additions and spawned objects.
 * Everything is undoable per brush stroke and serialisable to JSON.
 * ========================================================================== */
(function () {
  'use strict';
  var U = TERRA.util;
  var TS = 64, TN = TS + 1;   // tile size (m) and samples per side (1 m resolution)

  function tkey(tx, tz) { return tx + ':' + tz; }

  function Edits() { this.clear(); }
  var P = Edits.prototype;

  P.clear = function () {
    this.height = new Map();   // Float32Array(TN*TN) deltas
    this.paint = new Map();    // Uint8Array(TN*TN*2) material id, weight
    this.biome = new Map();    // Uint8Array(TN*TN*3) temp, moist, weight
    this.water = new Map();    // Float32Array(TN*TN) level (NaN = none, -1e5 = removed)
    this.vegRemove = [];       // [x, z, r]
    this.vegAdd = [];          // instance records: [x,y,z,rot,scale,type,variant,tint, kind(0 tree,1 prop)]
    this.objects = [];         // spawned objects {type, x, y, z, rot, scale, id}
    this.undoStack = []; this.redoStack = [];
    this.stroke = null;
    this.hasWater = false;
    this.version = 0;
    this.bounds = null;
  };
  P.isEmpty = function () { return !this.height.size && !this.paint.size && !this.biome.size && !this.water.size && !this.vegRemove.length && !this.vegAdd.length && !this.objects.length; };

  P._tile = function (map, tx, tz, create, ctor, len, fill) {
    var k = tkey(tx, tz), t = map.get(k);
    if (!t && create) {
      t = new ctor(len);
      if (fill !== undefined) t.fill(fill);
      map.set(k, t);
      this._extend(tx * TS, tz * TS);
    }
    if (t && this.stroke) this._snapshot(map, k, t);
    return t;
  };
  P._extend = function (x, z) {
    var b = this.bounds || (this.bounds = [x, z, x + TS, z + TS]);
    b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], z); b[2] = Math.max(b[2], x + TS); b[3] = Math.max(b[3], z + TS);
  };
  P.overlaps = function (ox, oz, size) {
    var b = this.bounds;
    if (!b) return false;
    if (ox > b[2] || oz > b[3] || ox + size < b[0] || oz + size < b[1]) return false;
    // fine check: any tile in range
    var t0x = Math.floor(ox / TS) - 1, t1x = Math.floor((ox + size) / TS) + 1;
    var t0z = Math.floor(oz / TS) - 1, t1z = Math.floor((oz + size) / TS) + 1;
    if ((t1x - t0x) * (t1z - t0z) > 400) return true;
    for (var z = t0z; z <= t1z; z++) for (var x = t0x; x <= t1x; x++) {
      var k = tkey(x, z);
      if (this.height.has(k) || this.paint.has(k) || this.biome.has(k) || this.water.has(k)) return true;
    }
    return false;
  };

  /* ---------------- queries ---------------- */
  P.heightDelta = function (x, z) {
    if (!this.height.size) return 0;
    var tx = Math.floor(x / TS), tz = Math.floor(z / TS);
    var t = this.height.get(tkey(tx, tz));
    if (!t) return 0;
    var fx = x - tx * TS, fz = z - tz * TS;
    var i = Math.min(TS - 1, Math.floor(fx)), j = Math.min(TS - 1, Math.floor(fz));
    var ax = fx - i, az = fz - j;
    return (t[j * TN + i] * (1 - ax) + t[j * TN + i + 1] * ax) * (1 - az) + (t[(j + 1) * TN + i] * (1 - ax) + t[(j + 1) * TN + i + 1] * ax) * az;
  };
  P.paintAt = function (x, z) {
    if (!this.paint.size) return null;
    var tx = Math.floor(x / TS), tz = Math.floor(z / TS), t = this.paint.get(tkey(tx, tz));
    if (!t) return null;
    var i = Math.round(x - tx * TS), j = Math.round(z - tz * TS), o = (j * TN + i) * 2;
    return t[o + 1] > 0 ? [t[o], t[o + 1]] : null;
  };
  P.biomeAt = function (x, z) {
    if (!this.biome.size) return null;
    var tx = Math.floor(x / TS), tz = Math.floor(z / TS), t = this.biome.get(tkey(tx, tz));
    if (!t) return null;
    var i = Math.round(x - tx * TS), j = Math.round(z - tz * TS), o = (j * TN + i) * 3;
    return t[o + 2] > 0 ? [t[o], t[o + 1], t[o + 2]] : null;
  };
  P.waterAt = function (x, z) {
    if (!this.water.size) return null;
    var tx = Math.floor(x / TS), tz = Math.floor(z / TS), t = this.water.get(tkey(tx, tz));
    if (!t) return null;
    var i = Math.round(x - tx * TS), j = Math.round(z - tz * TS), v = t[j * TN + i];
    return isNaN(v) ? null : v;
  };
  P.vegRemoved = function (x, z) {
    var r = this.vegRemove;
    if (r.length < 48) {
      for (var i = 0; i < r.length; i += 3) { var dx = x - r[i], dz = z - r[i + 1]; if (dx * dx + dz * dz < r[i + 2] * r[i + 2]) return true; }
      return false;
    }
    // many removals (chopped trees, explosions): bucket them in a 16 m grid, rebuilt when the list changes
    if (!this._vrGrid || this._vrLen !== r.length) {
      var g = new Map();
      for (var k = 0; k < r.length; k += 3) {
        var rad = r[k + 2], i0 = Math.floor((r[k] - rad) / 16), i1 = Math.floor((r[k] + rad) / 16), j0 = Math.floor((r[k + 1] - rad) / 16), j1 = Math.floor((r[k + 1] + rad) / 16);
        for (var j = j0; j <= j1; j++) for (var ii = i0; ii <= i1; ii++) { var key = ii + ':' + j, l = g.get(key); if (!l) g.set(key, l = []); l.push(k); }
      }
      this._vrGrid = g; this._vrLen = r.length;
    }
    var lst = this._vrGrid.get(Math.floor(x / 16) + ':' + Math.floor(z / 16));
    if (!lst) return false;
    for (var q = 0; q < lst.length; q++) { var o = lst[q], ex = x - r[o], ez = z - r[o + 1]; if (ex * ex + ez * ez < r[o + 2] * r[o + 2]) return true; }
    return false;
  };

  /* ---------------- strokes & undo ---------------- */
  P.beginStroke = function (label) {
    this.stroke = { label: label, tiles: new Map(), objectsBefore: this.objects.slice(), vegRemoveLen: this.vegRemove.length, vegAddLen: this.vegAdd.length, vegRemoveBefore: null, vegAddBefore: null };
  };
  P._snapshot = function (map, k, t) {
    var id = (map === this.height ? 'h' : map === this.paint ? 'p' : map === this.biome ? 'b' : 'w') + '|' + k;
    if (!this.stroke.tiles.has(id)) this.stroke.tiles.set(id, { map: map, k: k, before: t.slice() });
  };
  P.endStroke = function () {
    var s = this.stroke;
    if (!s) return;
    this.stroke = null;
    // capture "after" states
    var self = this;
    s.tiles.forEach(function (e) { var cur = e.map.get(e.k); e.after = cur ? cur.slice() : null; });
    s.objectsAfter = this.objects.slice();
    s.vegRemoveAfter = this.vegRemove.slice();
    s.vegAddAfter = this.vegAdd.slice();
    s.vegRemoveBefore = this.vegRemove.slice(0, s.vegRemoveLen);
    s.vegAddBefore = this.vegAdd.slice(0, s.vegAddLen);
    this.undoStack.push(s);
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack.length = 0;
    this.version++;
    void self;
  };
  P._restore = function (s, which) {
    var bb = [1e18, 1e18, -1e18, -1e18];
    s.tiles.forEach(function (e) {
      var data = which === 'before' ? e.before : e.after;
      if (data) e.map.set(e.k, data.slice()); else e.map.delete(e.k);
      var p = e.k.split(':'), x = +p[0] * TS, z = +p[1] * TS;
      bb[0] = Math.min(bb[0], x); bb[1] = Math.min(bb[1], z); bb[2] = Math.max(bb[2], x + TS); bb[3] = Math.max(bb[3], z + TS);
    });
    this.objects = (which === 'before' ? s.objectsBefore : s.objectsAfter).slice();
    this.vegRemove = (which === 'before' ? s.vegRemoveBefore : s.vegRemoveAfter).slice();
    this.vegAdd = (which === 'before' ? s.vegAddBefore : s.vegAddAfter).slice();
    this._recomputeWaterFlag();
    this.version++;
    return bb;
  };
  P.undo = function () { var s = this.undoStack.pop(); if (!s) return null; this.redoStack.push(s); return this._restore(s, 'before'); };
  P.redo = function () { var s = this.redoStack.pop(); if (!s) return null; this.undoStack.push(s); return this._restore(s, 'after'); };
  P._recomputeWaterFlag = function () { this.hasWater = this.water.size > 0; };

  /* ---------------- brush application ---------------- */
  /** Brush weight for a point at distance r from the centre. */
  P.brushWeight = function (r, B, x, z) {
    var t = r / B.radius;
    if (t >= 1) return 0;
    var w = 1 - U.smoothstep(B.hardness * 0.98, 1, t);
    w = Math.pow(w, B.falloff);
    if (B.noise > 0) {
      var n = TERRA.core.fbm(x / 6, z / 6, 3, 1234) * 0.5 + 0.5;
      w *= 1 - B.noise + B.noise * n * 1.6;
    }
    return Math.max(0, w);
  };

  /**
   * Apply a height tool. `sampleH(x,z)` returns the current final height.
   * Returns the touched bbox [x0,z0,x1,z1] or null.
   */
  P.applyHeight = function (tool, cx, cz, B, dt, sampleH, extra) {
    var R = B.radius;
    var x0 = Math.floor(cx - R), x1 = Math.ceil(cx + R), z0 = Math.floor(cz - R), z1 = Math.ceil(cz + R);
    var rate = B.strength * dt;
    var target = extra && extra.target !== undefined ? extra.target : 0;
    var neighbors = tool === 'smooth' ? this._gridHeights(x0 - 1, z0 - 1, x1 + 1, z1 + 1, sampleH) : null;
    var W = x1 - x0 + 3;
    for (var z = z0; z <= z1; z++) {
      for (var x = x0; x <= x1; x++) {
        var dx = x - cx, dz = z - cz, r = Math.sqrt(dx * dx + dz * dz);
        var w = this.brushWeight(r, B, x, z);
        if (w <= 0) continue;
        var d = 0;
        if (tool === 'raise') d = rate * 8 * w;
        else if (tool === 'lower') d = -rate * 8 * w;
        else if (tool === 'flatten') { var h = sampleH(x, z); d = (target - h) * Math.min(1, rate * 3 * w); }
        else if (tool === 'smooth') {
          var gi = (z - z0 + 1) * W + (x - x0 + 1), hc = neighbors[gi];
          var avg = (neighbors[gi - 1] + neighbors[gi + 1] + neighbors[gi - W] + neighbors[gi + W] + hc * 2 + neighbors[gi - W - 1] + neighbors[gi + W + 1] + neighbors[gi - W + 1] + neighbors[gi + W - 1]) / 10;
          d = (avg - hc) * Math.min(1, rate * 4 * w) * (1 + B.smoothing);
        }
        else if (tool === 'mountain') {
          // stamped once per call (dt is the stamp strength)
          var t = r / R, ridge = Math.abs(TERRA.core.snoise(x / (R * 0.35), z / (R * 0.35), 77));
          d = B.strength * R * 0.55 * Math.pow(Math.max(0, 1 - t), 1.6) * (0.75 + 0.5 * (1 - ridge)) * w * dt;
        }
        else if (tool === 'valley') {
          d = -B.strength * R * 0.25 * Math.pow(Math.max(0, 1 - r / R), 1.2) * w * dt;
        }
        if (d !== 0) this._addHeight(x, z, d);
      }
    }
    return [x0 - 2, z0 - 2, x1 + 2, z1 + 2];
  };
  P._gridHeights = function (x0, z0, x1, z1, sampleH) {
    var W = x1 - x0 + 1, H = z1 - z0 + 1, a = new Float32Array(W * H);
    for (var j = 0; j < H; j++) for (var i = 0; i < W; i++) a[j * W + i] = sampleH(x0 + i, z0 + j);
    return a;
  };
  /** Add a delta at an integer sample, keeping shared tile borders consistent. */
  P._addHeight = function (x, z, d) {
    var tx = Math.floor(x / TS), tz = Math.floor(z / TS);
    var i = x - tx * TS, j = z - tz * TS;
    this._tile(this.height, tx, tz, true, Float32Array, TN * TN)[j * TN + i] += d;
    // duplicate onto neighbours' border rows (sample x = tile edge belongs to two tiles)
    if (i === 0) this._tile(this.height, tx - 1, tz, true, Float32Array, TN * TN)[j * TN + TS] += d;
    if (j === 0) this._tile(this.height, tx, tz - 1, true, Float32Array, TN * TN)[TS * TN + i] += d;
    if (i === 0 && j === 0) this._tile(this.height, tx - 1, tz - 1, true, Float32Array, TN * TN)[TS * TN + TS] += d;
  };
  P._setSample = function (map, ctor, len, stride, x, z, fn) {
    var tx = Math.floor(x / TS), tz = Math.floor(z / TS), i = x - tx * TS, j = z - tz * TS;
    fn(this._tile(map, tx, tz, true, ctor, len * stride, ctor === Float32Array ? NaN : 0), (j * TN + i) * stride);
    if (i === 0) fn(this._tile(map, tx - 1, tz, true, ctor, len * stride, ctor === Float32Array ? NaN : 0), (j * TN + TS) * stride);
    if (j === 0) fn(this._tile(map, tx, tz - 1, true, ctor, len * stride, ctor === Float32Array ? NaN : 0), (TS * TN + i) * stride);
    if (i === 0 && j === 0) fn(this._tile(map, tx - 1, tz - 1, true, ctor, len * stride, ctor === Float32Array ? NaN : 0), (TS * TN + TS) * stride);
  };

  P.applyPaint = function (cx, cz, B, dt, matId) {
    var R = B.radius, x0 = Math.floor(cx - R), x1 = Math.ceil(cx + R), z0 = Math.floor(cz - R), z1 = Math.ceil(cz + R);
    for (var z = z0; z <= z1; z++) for (var x = x0; x <= x1; x++) {
      var w = this.brushWeight(Math.hypot(x - cx, z - cz), B, x, z);
      if (w <= 0) continue;
      var add = w * B.strength * dt * 600;
      this._setSample(this.paint, Uint8Array, TN * TN, 2, x, z, function (t, o) {
        if (t[o] !== matId && t[o + 1] > 0) { t[o + 1] = Math.max(0, t[o + 1] - add); if (t[o + 1] < 8) t[o] = matId; }
        else { t[o] = matId; t[o + 1] = Math.min(255, t[o + 1] + add); }
      });
    }
    return [x0 - 2, z0 - 2, x1 + 2, z1 + 2];
  };
  P.applyBiome = function (cx, cz, B, dt, temp01, moist01) {
    var R = B.radius, x0 = Math.floor(cx - R), x1 = Math.ceil(cx + R), z0 = Math.floor(cz - R), z1 = Math.ceil(cz + R);
    var T = Math.round(temp01 * 255), M = Math.round(moist01 * 255);
    for (var z = z0; z <= z1; z++) for (var x = x0; x <= x1; x++) {
      var w = this.brushWeight(Math.hypot(x - cx, z - cz), B, x, z);
      if (w <= 0) continue;
      var add = w * B.strength * dt * 500;
      this._setSample(this.biome, Uint8Array, TN * TN, 3, x, z, function (t, o) { t[o] = T; t[o + 1] = M; t[o + 2] = Math.min(255, t[o + 2] + add); });
    }
    return [x0 - 2, z0 - 2, x1 + 2, z1 + 2];
  };
  /** Add water: a flat pond at `level` inside the brush, with a small berm at the rim. */
  P.applyWater = function (cx, cz, B, level, sampleH, remove) {
    var R = B.radius, x0 = Math.floor(cx - R), x1 = Math.ceil(cx + R), z0 = Math.floor(cz - R), z1 = Math.ceil(cz + R);
    for (var z = z0; z <= z1; z++) for (var x = x0; x <= x1; x++) {
      var r = Math.hypot(x - cx, z - cz);
      if (r > R) continue;
      var h = sampleH(x, z);
      if (remove) {
        this._setSample(this.water, Float32Array, TN * TN, 1, x, z, function (t, o) { t[o] = -1e5; });
        var fill = level + 0.4 - h;
        var w = this.brushWeight(r, B, x, z);
        if (fill > 0) this._addHeight(x, z, fill * Math.min(1, w * 1.5));
      } else {
        if (r < R * 0.82) this._setSample(this.water, Float32Array, TN * TN, 1, x, z, function (t, o) { t[o] = level; });
        else if (h < level + 0.35) this._addHeight(x, z, level + 0.35 - h);
      }
    }
    this.hasWater = true;
    return [x0 - 2, z0 - 2, x1 + 2, z1 + 2];
  };

  /* ---------------- serialisation ---------------- */
  P.serialize = function () {
    function packMap(map) {
      var out = {};
      map.forEach(function (v, k) { out[k] = U.bufToB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)); });
      return out;
    }
    return {
      v: 1, tile: TS,
      height: packMap(this.height), paint: packMap(this.paint), biome: packMap(this.biome), water: packMap(this.water),
      vegRemove: this.vegRemove.slice(), vegAdd: this.vegAdd.slice(), objects: this.objects.slice()
    };
  };
  P.deserialize = function (d) {
    this.clear();
    if (!d) return;
    var self = this;
    function unpack(obj, map, ctor) {
      for (var k in (obj || {})) {
        var u8 = U.b64ToBuf(obj[k]);
        var arr = new ctor(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
        map.set(k, arr);
        var p = k.split(':'); self._extend(+p[0] * TS, +p[1] * TS);
      }
    }
    unpack(d.height, this.height, Float32Array);
    unpack(d.paint, this.paint, Uint8Array);
    unpack(d.biome, this.biome, Uint8Array);
    unpack(d.water, this.water, Float32Array);
    this.vegRemove = d.vegRemove || []; this.vegAdd = d.vegAdd || []; this.objects = d.objects || [];
    this._recomputeWaterFlag();
    this.version++;
  };

  Edits.TILE = TS;
  TERRA.world.Edits = Edits;
})();
