/* =============================================================================
 * TERRA INFINITA — chunk streaming & quadtree LOD (CDLOD-style)
 * -----------------------------------------------------------------------------
 * The world is an infinite grid of root nodes (size LEAF·2^ROOT). Each frame the
 * quadtree is refined around the camera: a node splits when the camera is closer
 * than size·K and all four children are generated. Otherwise the node itself is
 * drawn. Vertices morph toward the next coarser grid with distance so LOD changes
 * never pop, and skirts hide any sub-pixel cracks.
 *
 * Every node shares one index buffer; vertex buffers come from a pool (all nodes
 * have the same vertex count), so streaming never re-allocates GPU memory.
 * ========================================================================== */
(function () {
  'use strict';
  var U = TERRA.util, Mth = TERRA.math;

  var LEAF = 64;
  var ROOT_LEVEL = 8;             // root node = 16384 m
  var VSTRIDE = 36;

  function key(l, ix, iz) { return l + ':' + ix + ':' + iz; }

  function ChunkManager(engine) {
    this.engine = engine;
    this.G = engine.G; this.gl = engine.G.gl;
    this.nodes = new Map();
    this.drawList = [];
    this.waterList = [];
    this.vboPool = [];
    this.stats = { loaded: 0, drawn: 0, pending: 0, genMs: 0, triangles: 0, waterNodes: 0 };
    this.frame = 0;
    this.configure(engine.settings.graphics);
  }
  var P = ChunkManager.prototype;

  P.configure = function (g) {
    var q = U.clamp(g.terrainQuality | 0, 0, 3);
    var grid = [32, 48, 64, 64][q];
    var K = [1.6, 1.85, 2.1, 2.6][q] * (g.lodDistance || 1);
    if (g.performanceMode) K *= 0.8;
    var changed = grid !== this.grid;
    this.grid = grid;
    this.K = K;
    this.viewDist = 24000 * (g.renderDistance || 1);
    if (changed) this._rebuildGrid();
  };

  P._rebuildGrid = function () {
    var gl = this.gl, G = this.grid, VN = G + 1;
    this.vcount = VN * VN + 4 * VN;
    var idx = [];
    for (var j = 0; j < G; j++) for (var i = 0; i < G; i++) {
      var a = j * VN + i, b = a + 1, c = a + VN, d = c + 1;
      idx.push(a, c, d, a, d, b);
    }
    var base = VN * VN;
    // skirts: e0 z=0, e1 z=max, e2 x=0, e3 x=max
    var edgeIdx = [
      function (k) { return k; }, function (k) { return (VN - 1) * VN + k; },
      function (k) { return k * VN; }, function (k) { return k * VN + VN - 1; }
    ];
    for (var e = 0; e < 4; e++) for (var k = 0; k < G; k++) {
      var t0 = edgeIdx[e](k), t1 = edgeIdx[e](k + 1), s0 = base + e * VN + k, s1 = s0 + 1;
      idx.push(t0, s0, s1, t0, s1, t1);
    }
    this.indexCount = idx.length;
    if (this.ibo) gl.deleteBuffer(this.ibo);
    this.ibo = this.G.buffer(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx));
    // Drop everything (vertex counts changed)
    this.clear();
  };

  P.clear = function () {
    var self = this;
    this.nodes.forEach(function (n) { self._freeNode(n); });
    this.nodes.clear();
    this.vboPool.forEach(function (v) { self.gl.deleteBuffer(v.buf); self.gl.deleteVertexArray(v.vao); });
    this.vboPool = [];
    this.drawList = []; this.waterList = [];
    this._pendingUploads = [];
  };

  P.reset = function (gen) {
    this.gen = gen;
    this.clear();
  };

  /* ---------------- GPU buffers ---------------- */
  P._allocVBO = function () {
    var gl = this.gl;
    if (this.vboPool.length) return this.vboPool.pop();
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.vcount * VSTRIDE, gl.DYNAMIC_DRAW);
    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, VSTRIDE, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, VSTRIDE, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.SHORT, true, VSTRIDE, 16);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, VSTRIDE, 24);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 4, gl.UNSIGNED_BYTE, true, VSTRIDE, 28);
    gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 4, gl.UNSIGNED_BYTE, true, VSTRIDE, 32);
    gl.bindVertexArray(null);
    return { buf: buf, vao: vao };
  };
  P._freeNode = function (n) {
    var gl = this.gl;
    if (n.job) { this.engine.pool.cancel(n.job); n.job = null; }
    if (n.vbo) { if (this.vboPool.length < 64) this.vboPool.push(n.vbo); else { gl.deleteBuffer(n.vbo.buf); gl.deleteVertexArray(n.vbo.vao); } n.vbo = null; }
    if (n.water) { gl.deleteBuffer(n.water.vb); gl.deleteBuffer(n.water.ib); gl.deleteVertexArray(n.water.vao); n.water = null; }
  };

  P._upload = function (n, r) {
    var gl = this.gl;
    n.vbo = n.vbo || this._allocVBO();
    gl.bindBuffer(gl.ARRAY_BUFFER, n.vbo.buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(r.vbuf));
    n.vbuf = r.vbuf;
    n.vf = new Float32Array(r.vbuf);   // CPU view of positions/morph heights (renderedHeight)
    n.heights = r.heights; n.clim = r.clim; n.surf = r.surf; n.extra = r.extra;
    n.wl = r.wl; n.wty = r.wty; n.wfx = r.wfx; n.wfz = r.wfz;
    n.minH = r.minH; n.maxH = r.maxH;
    n.waterMin = r.waterMin; n.waterMax = r.waterMax;
    if (n.water) { gl.deleteBuffer(n.water.vb); gl.deleteBuffer(n.water.ib); gl.deleteVertexArray(n.water.vao); n.water = null; }
    if (r.water) this._uploadWater(n, r.water);
    n.state = 'ready';
    n.readyFrame = this.frame;
    // re-apply editor modifications if this area was edited
    var ed = this.engine.edits;
    if (ed && ed.overlaps(n.ox, n.oz, n.size)) this.applyEdits(n);
  };
  P._uploadWater = function (n, w) {
    var gl = this.gl;
    var vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    var vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(w.vbuf), gl.STATIC_DRAW);
    var ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, w.i32 ? new Uint32Array(w.ibuf) : new Uint16Array(w.ibuf), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 24, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.SHORT, false, 24, 16);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, false, 24, 20);
    gl.bindVertexArray(null);
    n.water = { vao: vao, vb: vb, ib: ib, count: w.count, type: w.i32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT };
  };

  /* ---------------- node lifecycle ---------------- */
  P._get = function (l, ix, iz, create) {
    var k = key(l, ix, iz);
    var n = this.nodes.get(k);
    if (!n && create) {
      var size = LEAF * Math.pow(2, l);
      n = { key: k, id: (this._nid = (this._nid || 0) + 1), level: l, ix: ix, iz: iz, size: size, ox: ix * size, oz: iz * size, state: 'new', lastUsed: this.frame, drawFrame: -1, minH: 0, maxH: 400, job: null, vbo: null, water: null, vf: null };
      var parent = l < ROOT_LEVEL ? this.nodes.get(key(l + 1, Math.floor(ix / 2), Math.floor(iz / 2))) : null;
      if (parent && parent.state === 'ready') { n.minH = parent.minH; n.maxH = parent.maxH; }
      this.nodes.set(k, n);
    }
    return n;
  };

  P._request = function (n, pri) {
    if (n.state !== 'new') { if (n.job && n.state === 'pending' && pri < n.job.pri) { n.job.pri = pri; this.engine.pool._dirty = true; } return; }
    n.state = 'pending';
    var self = this;
    n.job = this.engine.pool.submit({ type: 'node', grid: this.grid, size: n.size, ox: n.ox, oz: n.oz, level: n.level }, pri, function (r, ms) {
      n.job = null;
      if (self.nodes.get(n.key) !== n) return;
      self._pendingUploads.push({ n: n, r: r });
      self.stats.genMs = self.stats.genMs * 0.9 + ms * 0.1;
    });
  };

  /** Distance from camera to the node's bounding box (world units). */
  P._dist = function (n, cx, cy, cz) {
    var dx = Math.max(n.ox - cx, 0, cx - (n.ox + n.size));
    var dz = Math.max(n.oz - cz, 0, cz - (n.oz + n.size));
    var dy = Math.max(n.minH - cy, 0, cy - n.maxH);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };

  /* ---------------- per-frame update ---------------- */
  P.update = function (cam) {
    this.frame++;
    var cx = cam.world[0], cy = cam.world[1], cz = cam.world[2];
    this.camWorld = cam.world;
    if (!this._pendingUploads) this._pendingUploads = [];
    // Upload finished jobs (budgeted to avoid hitches)
    var t0 = performance.now(), up = 0;
    this._pendingUploads.sort(function (a, b) { return b.n.level - a.n.level; });
    while (this._pendingUploads.length && (up < 2 || performance.now() - t0 < 4)) {
      var pu = this._pendingUploads.shift();
      if (this.nodes.get(pu.n.key) === pu.n) this._upload(pu.n, pu.r);
      up++;
      if (up > 24) break;
    }

    var drawList = this.drawList; drawList.length = 0;
    // adaptive LOD (performance governor) and movement look-ahead: nodes ahead of the camera
    // along its velocity refine early, so terrain is ready before you arrive
    this.Keff = this.K * U.clamp(this.engine.lodScale || 1, 0.5, 1.3);
    var lc = this._lastCamW;
    if (lc) {
      var dtc = Math.max(1e-3, (performance.now() - this._lastCamT) / 1000);
      var vx = (cx - lc[0]) / dtc, vz = (cz - lc[2]) / dtc;
      if (Math.abs(vx) + Math.abs(vz) > 400) { vx = 0; vz = 0; }   // teleport
      this._vel = this._vel ? [this._vel[0] * 0.85 + vx * 0.15, this._vel[1] * 0.85 + vz * 0.15] : [vx, vz];
    }
    this._lastCamW = [cx, cy, cz]; this._lastCamT = performance.now();
    var vel = this._vel || [0, 0], sp = Math.hypot(vel[0], vel[1]);
    var la = Math.min(2.5, 250 / Math.max(sp, 1));
    this.ahead = sp > 2 ? [cx + vel[0] * la, cz + vel[1] * la] : null;
    var f = cam.forward || [0, 0, -1], fl = Math.hypot(f[0], f[2]) || 1;
    this.fwdH = [f[0] / fl, f[2] / fl];
    var rootSize = LEAF * Math.pow(2, ROOT_LEVEL);
    var R = this.viewDist;
    var i0 = Math.floor((cx - R) / rootSize), i1 = Math.floor((cx + R) / rootSize);
    var j0 = Math.floor((cz - R) / rootSize), j1 = Math.floor((cz + R) / rootSize);
    for (var j = j0; j <= j1; j++) for (var i = i0; i <= i1; i++) {
      var root = this._get(ROOT_LEVEL, i, j, true);
      var rd = this._dist(root, cx, cy, cz);
      if (rd > R) continue;
      root.lastUsed = this.frame;
      if (root.state !== 'ready') { this._request(root, -1e6 + rd * 0.001); continue; }
      this._select(root, cx, cy, cz);
    }
    this._computeNeighbors();
    // signature of the drawn set: changes whenever any node is swapped for another LOD
    var sig = drawList.length;
    for (var q = 0; q < drawList.length; q++) sig = (sig * 31 + drawList[q].id * 2654435761) % 4294967291;
    if (sig !== this._drawHash) { this._drawHash = sig; this.drawSig = (this.drawSig || 0) + 1; }
    this._evict();
    this.stats.drawn = drawList.length;
    this.stats.loaded = this.nodes.size;
    this.stats.pending = this.engine.pool.pending();
  };

  P._select = function (n, cx, cy, cz) {
    n.lastUsed = this.frame;
    var d = this._dist(n, cx, cy, cz);
    if (this.ahead) d = Math.min(d, this._dist(n, this.ahead[0], cy, this.ahead[1]) * 1.15);
    if (n.level > 0 && d < n.size * this.Keff) {
      var l = n.level - 1, bx = n.ix * 2, bz = n.iz * 2, ready = true, kids = this._kids || (this._kids = []);
      kids.length = 0;
      for (var q = 0; q < 4; q++) {
        var c = this._get(l, bx + (q & 1), bz + (q >> 1), true);
        c.lastUsed = this.frame;
        kids.push(c);
        if (c.state !== 'ready') {
          ready = false;
          var cd = this._dist(c, cx, cy, cz);
          // view-direction priority: what the camera looks at streams in first
          var ddx = c.ox + c.size * 0.5 - cx, ddz = c.oz + c.size * 0.5 - cz, dl = Math.hypot(ddx, ddz) || 1;
          var facing = (ddx * this.fwdH[0] + ddz * this.fwdH[1]) / dl;
          this._request(c, cd / c.size + (ROOT_LEVEL - c.level) * 0.15 + (1 - facing) * (dl > c.size ? 0.45 : 0.05));
        }
      }
      if (ready) {
        var k0 = kids[0], k1 = kids[1], k2 = kids[2], k3 = kids[3];
        this._select(k0, cx, cy, cz); this._select(k1, cx, cy, cz);
        this._select(k2, cx, cy, cz); this._select(k3, cx, cy, cz);
        return;
      }
    }
    n.drawFrame = this.frame;
    this.drawList.push(n);
  };

  /** Neighbour LOD flags (bit per edge: 1 z-, 2 z+, 4 x-, 8 x+) so edges can force full morph. */
  P._computeNeighbors = function () {
    var set = this._drawnSet || (this._drawnSet = new Map());
    set.clear();
    var list = this.drawList, i, n;
    for (i = 0; i < list.length; i++) set.set(list[i].key, list[i]);
    var self = this;
    function levelAt(x, z, minL) {
      for (var l = minL; l <= ROOT_LEVEL; l++) {
        var s = LEAF * Math.pow(2, l);
        if (set.has(key(l, Math.floor(x / s), Math.floor(z / s)))) return l;
      }
      return minL;
    }
    for (i = 0; i < list.length; i++) {
      n = list[i];
      var h = n.size * 0.5, e = 0.5, f = 0;
      if (levelAt(n.ox + h, n.oz - e, n.level) > n.level) f |= 1;
      if (levelAt(n.ox + h, n.oz + n.size + e, n.level) > n.level) f |= 2;
      if (levelAt(n.ox - e, n.oz + h, n.level) > n.level) f |= 4;
      if (levelAt(n.ox + n.size + e, n.oz + h, n.level) > n.level) f |= 8;
      n.edge = f;
    }
    void self;
  };

  P._evict = function () {
    var budget = 1400;   // keep more generated terrain cached (fewer regenerations when turning back)
    if (this.nodes.size <= budget || (this.frame % 30) !== 0) return;
    var arr = [];
    this.nodes.forEach(function (n) { arr.push(n); });
    var frame = this.frame;
    arr.sort(function (a, b) { return a.lastUsed - b.lastUsed; });
    var remove = this.nodes.size - Math.floor(budget * 0.85);
    for (var i = 0; i < arr.length && remove > 0; i++) {
      var n = arr[i];
      if (frame - n.lastUsed < 60) break;
      this._freeNode(n);
      this.nodes.delete(n.key);
      remove--;
    }
  };

  /** Morph distances for a node level (vertex blends to the coarser grid across [start,end]). */
  P.morphRange = function (level) {
    var S = LEAF * Math.pow(2, level);
    var end = (this.Keff || this.K) * 2 * S * 0.96;
    return [end * 0.62, end];
  };

  /** Is the terrain around (x,z) within radius r fully streamed at leaf level? */
  P.isAreaReady = function (x, z, r, maxLevel) {
    maxLevel = maxLevel || 0;
    var list = this.drawList;
    if (!list.length) return false;
    var covered = 0, needed = 0;
    for (var dz = -r; dz <= r; dz += LEAF) for (var dx = -r; dx <= r; dx += LEAF) {
      needed++;
      for (var i = 0; i < list.length; i++) {
        var n = list[i];
        if (x + dx >= n.ox && x + dx < n.ox + n.size && z + dz >= n.oz && z + dz < n.oz + n.size) { if (n.level <= maxLevel) covered++; break; }
      }
    }
    return covered >= needed;
  };
  P.progress = function () {
    // fraction of the drawn set that is at the desired LOD (approx: no pending jobs)
    var pend = this.engine.pool.pending();
    return 1 / (1 + pend * 0.05);
  };

  /* ---------------- height queries ---------------- */
  /** Find the finest ready node containing (x,z). */
  P.finestNode = function (x, z) {
    for (var l = 0; l <= ROOT_LEVEL; l++) {
      var s = LEAF * Math.pow(2, l);
      var n = this.nodes.get(key(l, Math.floor(x / s), Math.floor(z / s)));
      if (n && n.state === 'ready') return n;
    }
    return null;
  };
  /** Height from the loaded mesh data (bilinear on the node grid, matches what is rendered). */
  P.meshHeight = function (x, z) {
    var n = this.finestNode(x, z);
    if (!n) return null;
    var G = this.grid, W = G + 3, dx = n.size / G;
    var fx = (x - n.ox) / dx, fz = (z - n.oz) / dx;
    var i = Math.min(G - 1, Math.max(0, Math.floor(fx))), j = Math.min(G - 1, Math.max(0, Math.floor(fz)));
    var tx = fx - i, tz = fz - j, hs = n.heights;
    var a = hs[(j + 1) * W + i + 1], b = hs[(j + 1) * W + i + 2], c = hs[(j + 2) * W + i + 1], d = hs[(j + 2) * W + i + 2];
    // match the triangulation (diagonal a-d)
    if (tx > tz) return a + (b - a) * tx + (d - b) * tz;
    return a + (d - c) * tx + (c - a) * tz;
  };

  /** The node currently drawn at (x,z) (valid after update() this frame). */
  P.drawnNodeAt = function (x, z) {
    var set = this._drawnSet;
    if (!set) return null;
    for (var l = 0; l <= ROOT_LEVEL; l++) {
      var s = LEAF * Math.pow(2, l);
      var n = set.get(key(l, Math.floor(x / s), Math.floor(z / s)));
      if (n) return n;
    }
    return null;
  };
  /**
   * Height of the terrain exactly as it is rasterised this frame: the drawn node's grid,
   * its triangulation and the CDLOD geomorph toward the coarser grid (same formula as the
   * terrain vertex shader). Vegetation, rocks and structures are snapped to this so they
   * never float above (or sink into) coarse distant terrain.
   * `hint` is an optional {n} cache for spatially coherent queries.
   */
  P.renderedHeight = function (x, z, cam, hint) {
    var n = hint ? hint.n : null;
    if (!n || n.drawFrame !== this.frame || x < n.ox || z < n.oz || x >= n.ox + n.size || z >= n.oz + n.size) {
      n = this.drawnNodeAt(x, z);
      if (hint) hint.n = n;
    }
    if (!n || !n.vf) return null;
    var G = this.grid, VN = G + 1, dx = n.size / G, vf = n.vf;
    var fx = (x - n.ox) / dx, fz = (z - n.oz) / dx;
    var i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0) i = 0; else if (i > G - 1) i = G - 1;
    if (j < 0) j = 0; else if (j > G - 1) j = G - 1;
    var tx = fx - i, tz = fz - j;
    var end = (this.Keff || this.K) * 2 * n.size * 0.96, start = end * 0.62;
    var a = this._vh(n, vf, i, j, VN, G, dx, start, end, cam), d = this._vh(n, vf, i + 1, j + 1, VN, G, dx, start, end, cam);
    if (tx > tz) { var b = this._vh(n, vf, i + 1, j, VN, G, dx, start, end, cam); return a + (b - a) * tx + (d - b) * tz; }
    var c = this._vh(n, vf, i, j + 1, VN, G, dx, start, end, cam);
    return a + (d - c) * tx + (c - a) * tz;
  };
  /** Geomorphed height of one vertex (same formula as the terrain vertex shader). */
  P._vh = function (n, vf, ii, jj, VN, G, dx, start, end, cam) {
    var o = (jj * VN + ii) * 9, h = vf[o + 1], mh = vf[o + 3];
    var px = n.ox + ii * dx - cam[0], py = h - cam[1], pz = n.oz + jj * dx - cam[2];
    var m = (Math.sqrt(px * px + py * py + pz * pz) - start) / (end - start);
    m = m < 0 ? 0 : (m > 1 ? 1 : m);
    var ef = n.edge | 0;
    if (((ef & 1) && jj === 0) || ((ef & 2) && jj === G) || ((ef & 4) && ii === 0) || ((ef & 8) && ii === G)) m = 1;
    return h + (mh - h) * m;
  };

  /* ---------------- editing ---------------- */
  /** Re-apply the edit layer to a node's heights/attributes and re-upload. */
  P.applyEdits = function (n) {
    var ed = this.engine.edits, core = this.engine.gen;
    if (!n.baseHeights) n.baseHeights = new Float32Array(n.heights);
    if (!n.baseExtra) n.baseExtra = new Uint8Array(n.extra);
    if (!n.baseClim) n.baseClim = new Uint8Array(n.clim);
    var G = this.grid, W = G + 3, VN = G + 1, dx = n.size / G;
    var hs = n.heights, bh = n.baseHeights;
    var minH = 1e9, maxH = -1e9;
    for (var j = 0; j < W; j++) for (var i = 0; i < W; i++) {
      var x = n.ox + (i - 1) * dx, z = n.oz + (j - 1) * dx;
      var h = bh[j * W + i] + ed.heightDelta(x, z);
      hs[j * W + i] = h;
      if (i > 0 && j > 0 && i <= VN && j <= VN) { if (h < minH) minH = h; if (h > maxH) maxH = h; }
    }
    // paint & biome layers
    for (j = 0; j < VN; j++) for (i = 0; i < VN; i++) {
      var v = j * VN + i, x2 = n.ox + i * dx, z2 = n.oz + j * dx;
      var paint = ed.paintAt(x2, z2);
      n.extra[v * 4] = n.baseExtra[v * 4]; n.extra[v * 4 + 1] = n.baseExtra[v * 4 + 1];
      n.extra[v * 4 + 2] = paint ? paint[0] : 0; n.extra[v * 4 + 3] = paint ? paint[1] : 0;
      var bio = ed.biomeAt(x2, z2);
      for (var q = 0; q < 4; q++) n.clim[v * 4 + q] = n.baseClim[v * 4 + q];
      if (bio) {
        n.clim[v * 4] = U.mix(n.baseClim[v * 4], bio[0], bio[2] / 255);
        n.clim[v * 4 + 1] = U.mix(n.baseClim[v * 4 + 1], bio[1], bio[2] / 255);
      }
    }
    n.minH = minH; n.maxH = maxH;
    var buf = n.vbuf;
    core.buildVertexBuffer(hs, G, dx, n.clim, n.surf, n.extra, new Float32Array(buf), new Int16Array(buf), new Uint8Array(buf), n.size);
    var gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, n.vbo.buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(buf));
    // water: rebuild if the edit layer adds/removes water or changes heights under water
    if (ed.hasWater || n.water || n.waterMax > -1e4) this._rebuildWater(n);
  };
  P._rebuildWater = function (n) {
    var ed = this.engine.edits, gen = this.engine.gen;
    var G = this.grid, VN = G + 1, dx = n.size / G;
    var wl = new Float32Array(VN * VN), wty = new Uint8Array(VN * VN), wfx = new Float32Array(VN * VN), wfz = new Float32Array(VN * VN);
    var any = false;
    for (var j = 0; j < VN; j++) for (var i = 0; i < VN; i++) {
      var v = j * VN + i, x = n.ox + i * dx, z = n.oz + j * dx;
      var ov = ed.waterAt(x, z);
      if (ov !== null) { wl[v] = ov; wty[v] = ov > -1e4 ? 2 : 0; any = any || ov > -1e4; continue; }
      wl[v] = n.wl[v]; wty[v] = n.wty[v]; wfx[v] = n.wfx[v]; wfz[v] = n.wfz[v];
      if (wty[v] > 0) any = true;
    }
    var gl = this.gl;
    if (n.water) { gl.deleteBuffer(n.water.vb); gl.deleteBuffer(n.water.ib); gl.deleteVertexArray(n.water.vao); n.water = null; }
    if (!any) return;
    var w = gen.buildWater(n.heights, wl, wty, wfx, wfz, G, dx);
    if (w) this._uploadWater(n, w);
  };
  /** Called by the editor after a stroke: patch every loaded node overlapping the area. */
  P.onEdit = function (x0, z0, x1, z1) {
    var self = this;
    (this.editBoxes || (this.editBoxes = [])).push([x0, z0, x1, z1]);   // consumed by vegetation height snapping
    this.nodes.forEach(function (n) {
      if (n.state !== 'ready') return;
      if (n.ox > x1 || n.oz > z1 || n.ox + n.size < x0 || n.oz + n.size < z0) return;
      self.applyEdits(n);
    });
  };

  P.gpuBytes = function () {
    var b = (this.nodes.size) * this.vcount * VSTRIDE;
    return b;
  };

  ChunkManager.LEAF = LEAF;
  ChunkManager.ROOT_LEVEL = ROOT_LEVEL;
  TERRA.world.ChunkManager = ChunkManager;
})();
