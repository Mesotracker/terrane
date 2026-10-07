/* =============================================================================
 * TERRA INFINITA — vegetation, props & structures
 * -----------------------------------------------------------------------------
 *  • Tree cells (256 m) and prop cells (64 m) are generated in workers.
 *  • Near trees are instanced meshes (frustum-culled every frame); distant trees
 *    are impostor billboards baked at startup; beyond that the terrain shader
 *    paints forest canopy. Transitions use complementary dithering (no popping).
 *  • Grass is generated entirely on the GPU from gl_InstanceID around the camera,
 *    using a local height/density field sampled from the streamed terrain.
 * ========================================================================== */
(function () {
  'use strict';
  var S = TERRA.shaders, M = TERRA.math, U = TERRA.util;
  var TREE_CELL = 256, PROP_CELL = 64;
  var FIELD = 320;     // local field size (m) & resolution (texels, 1 m): covers the farthest grass ring (125 m) with margin
  var FIELD_SNAP = 8, FIELD_MOVE = 16, FIELD_ROWS = 48;   // recentre after 16 m; rebuild 48 rows per frame (~7 frames)
  var DECIDUOUS = { 2: 1, 3: 1, 9: 1 };

  function Vegetation(engine) {
    this.engine = engine; this.G = engine.G; var gl = this.gl = engine.G.gl;
    this.treeCells = new Map(); this.propCells = new Map();
    this.models = null;
    this.fieldCenter = null;
    this.stats = { trees: 0, impostors: 0, props: 0, grass: 0, cells: 0 };
    this.lastFarBuild = null;
    this.frame = 0;
    this.lights = [];
    this.collected = {};
    this.poiList = [];
    this._scratch = new Float32Array(8 * 4096);
  }
  var P = Vegetation.prototype;
  P.FIELD = FIELD;

  P.init = function (models, quality) {
    var G = this.G, gl = this.gl;
    this.models = models;
    this.progMesh = G.program('vegMesh', S.meshVS, S.meshFS);
    this.progMeshShadow = G.program('vegMeshShadow', S.meshVS, S.meshFS, { SHADOW: 1 });
    this.progImp = G.program('impostor', S.impostorVS, S.impostorFS);
    this.progImpShadow = G.program('impostorShadow', S.impostorVS, S.impostorFS, { SHADOW: 1 });
    this.progGrass = G.program('grass', S.grassVS, S.grassFS);
    this.progGrassShadow = G.program('grassShadow', S.grassVS, S.grassFS, { SHADOW: 1 });
    // impostor instance buffer & VAO (no per-vertex data: corners from gl_VertexID)
    this.impVAO = gl.createVertexArray(); gl.bindVertexArray(this.impVAO);
    this.impBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.impBuf);
    gl.bufferData(gl.ARRAY_BUFFER, 64, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 4, gl.FLOAT, false, 32, 0); gl.vertexAttribDivisor(5, 1);
    gl.enableVertexAttribArray(6); gl.vertexAttribPointer(6, 4, gl.FLOAT, false, 32, 16); gl.vertexAttribDivisor(6, 1);
    gl.bindVertexArray(null);
    this.impCount = 0;
    // grass blade strip
    this._buildGrassMeshes();
    // local fields
    this.heightTex = G.texture2D(FIELD, FIELD, { internal: gl.R32F, format: gl.RED, type: gl.FLOAT, filter: this.G.caps.floatLinear ? gl.LINEAR : gl.NEAREST, immutable: false });
    this.grassTex = G.texture2D(FIELD, FIELD, { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, immutable: false });
    this.heightData = new Float32Array(FIELD * FIELD);
    this.grassData = new Uint8Array(FIELD * FIELD * 4);
    this.configure(this.engine.settings.graphics);
  };

  P.configure = function (g) {
    var q = U.clamp(g.vegetationQuality | 0, 0, 3);
    var perf = g.performanceMode;
    this.q = q;
    this.treeMeshDist = [60, 95, 140, 200][q] * (perf ? 0.75 : 1);
    this.treeLodDist = this.treeMeshDist * 0.42;   // beyond this, trees use the reduced mesh
    this.impDist = Math.min(3000, [700, 1000, 1400, 1800][q] * (perf ? 0.8 : 1) * Math.max(0.7, Math.sqrt(g.renderDistance || 1)));
    this.propDist = [35, 55, 85, 120][q] * (perf ? 0.75 : 1);
    this.boulderDist = [300, 500, 800, 1100][q];
    // [spacing, inner radius, outer radius, blade scale, mesh]  mesh: 0 = 5 blades × 5 segments, 1 = 4 × 3, 2 = 3 × 2
    this.grassRings = [
      [[0.19, 0, 14, 1.0, 1], [0.42, 13, 34, 1.9, 2]],
      [[0.14, 0, 11, 1.0, 0], [0.28, 10, 30, 1.6, 1], [0.58, 28, 58, 2.5, 2]],
      [[0.105, 0, 11, 1.0, 0], [0.21, 10, 30, 1.5, 1], [0.52, 28, 95, 2.7, 2]],
      [[0.09, 0, 13, 1.0, 0], [0.18, 12, 36, 1.45, 1], [0.48, 34, 125, 2.7, 2]]
    ][q];
    if (perf) this.grassRings = this.grassRings.slice(0, 2);
  };

  P._buildGrassMeshes = function () {
    var gl = this.gl;
    var self = this;
    // a clump of tapered blades with a pointed tip vertex; aBlade = (across, along, blade index)
    // blades 0 and 1 may become wildflowers: they get extra segments packed toward the tip
    // (bell/head profiles and the arch of nodding stems need the resolution there)
    function clump(blades, segs, flowerSegs) {
      var v = [], idx = [], segs0 = segs;
      for (var b = 0; b < blades; b++) {
        var base = v.length / 3;
        var fl = flowerSegs && b < 2, ns = fl ? flowerSegs : segs;
        for (var i = 0; i < ns; i++) { var u = i / ns, t = fl ? 1 - Math.pow(1 - u, 1.7) : u; v.push(-0.5, t, b, 0.5, t, b); }
        segs = ns;
        v.push(0, 1, b);                                   // tip
        for (i = 0; i < segs - 1; i++) { var a = base + i * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
        var l = base + (segs - 1) * 2; idx.push(l, l + 1, base + segs * 2);
        segs = segs0;
      }
      var vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      self.G.buffer(gl.ARRAY_BUFFER, new Float32Array(v));
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
      self.G.buffer(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx));
      gl.bindVertexArray(null);
      return { vao: vao, count: idx.length, tris: idx.length / 3 };
    }
    this.grassMeshes = [clump(5, 5, 10), clump(4, 3, 6), clump(3, 2)];
  };

  /* ---------------- impostor baking ---------------- */
  P.bakeImpostors = function (texgen) {
    var G = this.G, gl = this.gl, models = this.models;
    var size = this.engine.settings.graphics.vegetationQuality >= 2 ? 512 : 256;
    var nv = models.variants, types = models.trees.length - 1; // exclude boulder
    var layers = types * nv;
    this.impColor = G.textureArray(size, size, layers, { mips: true, wrap: gl.CLAMP_TO_EDGE, aniso: 4 });
    this.impNormal = G.textureArray(size, size, layers, { mips: true, wrap: gl.CLAMP_TO_EDGE });
    this.atlasInfo = new Float32Array(40 * 4);
    var prog = G.program('bake', S.meshVS, S.meshFS, { BAKE: 1 });
    var inst = new Float32Array([0, 0, 0, 0, 1, 0.5, 1, 0]);
    gl.enable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    var depth = G.texture2D(size, size, { internal: gl.DEPTH_COMPONENT32F, format: gl.DEPTH_COMPONENT, type: gl.FLOAT, filter: gl.NEAREST });
    for (var t = 0; t < types; t++) for (var v = 0; v < nv; v++) {
      var m = models.trees[t][v], L = t * nv + v;
      var hw = m.radius * 1.04, bot = Math.min(0, m.bottom), top = m.height * 1.03;
      this.atlasInfo[L * 4] = hw; this.atlasInfo[L * 4 + 1] = top - bot; this.atlasInfo[L * 4 + 2] = bot;
      var fb = G.framebuffer([{ tex: this.impColor, layer: L }, { tex: this.impNormal, layer: L }], depth);
      G.bindFB(fb, size, size);
      gl.clearColor(0, 0, 0, 0); gl.clearDepth(this.G.caps.reversedZ ? 1 : 1); gl.depthFunc(gl.LEQUAL);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      var mid = (top + bot) / 2;
      var view = M.lookAt(M.mat4(), [0, mid, 200], [0, mid, 0], [0, 1, 0]);
      var proj = M.ortho(M.mat4(), -hw, hw, bot - mid, top - mid, 1, 400, this.G.caps.reversedZ);
      var vp = M.multiply(M.mat4(), proj, view);
      prog.use().i('uBake', 1).m4('uBakeVP', vp).m4('uBakeView', view).f('uHeight', m.height).f('uInteract', 0).f('uWindScale', 0)
        .i('uShadowPass', 0).i('uDeciduous', 0)
        .tex('uAlbedoH', 0, this.engine.renderer.tex.matAlbedo, gl.TEXTURE_2D_ARRAY).tex('uNormalR', 1, this.engine.renderer.tex.matNormal, gl.TEXTURE_2D_ARRAY)
        .tex('uFoliage', 2, texgen.foliage.color, gl.TEXTURE_2D_ARRAY).tex('uFoliageN', 3, texgen.foliage.normal, gl.TEXTURE_2D_ARRAY);
      TERRA.gfx.HiZ.bindOff(this.engine.renderer, prog, 5);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.inst); gl.bufferData(gl.ARRAY_BUFFER, inst, gl.DYNAMIC_DRAW);
      gl.bindVertexArray(m.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, m.count, m.indexType, 0, 1);
      gl.bindVertexArray(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fb);
    }
    gl.deleteTexture(depth);
    prog.destroy();
    texgen._dilateFoliage(this.impColor, size, layers);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.impColor); gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.impNormal); gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    this.impLayers = layers;
  };

  /* ---------------- streaming ---------------- */
  P.reset = function () {
    var pool = this.engine.pool;
    this.treeCells.forEach(function (c) { if (c.job) pool.cancel(c.job); });
    this.propCells.forEach(function (c) { if (c.job) pool.cancel(c.job); });
    this.treeCells.clear(); this.propCells.clear();
    this.lastFarBuild = null; this.fieldCenter = null; this._fieldBuild = null; this._fieldSigCur = null;
    this.poiList = []; this._poiAt = null;
  };

  P._requestCells = function (map, cellSize, cx, cz, radius, type, priBase) {
    var i0 = Math.floor((cx - radius) / cellSize), i1 = Math.floor((cx + radius) / cellSize);
    var j0 = Math.floor((cz - radius) / cellSize), j1 = Math.floor((cz + radius) / cellSize);
    var pool = this.engine.pool, frame = this.frame, self = this;
    for (var j = j0; j <= j1; j++) for (var i = i0; i <= i1; i++) {
      var dx = Math.max(i * cellSize - cx, 0, cx - (i + 1) * cellSize), dz = Math.max(j * cellSize - cz, 0, cz - (j + 1) * cellSize);
      var d = Math.hypot(dx, dz);
      if (d > radius) continue;
      var k = i + ':' + j, c = map.get(k);
      if (!c) {
        c = { i: i, j: j, state: 'pending', inst: null, used: frame };
        map.set(k, c);
        (function (cell) {
          cell.job = pool.submit({ type: type, ix: i, iz: j, size: cellSize }, priBase + d / 200, function (r) {
            cell.job = null; cell.inst = r.inst; cell.state = 'ready'; self._dirtyFar = true;
          });
        })(c);
      }
      c.used = frame;
    }
    // evict far cells
    if (frame % 60 === 0) {
      map.forEach(function (c, key) {
        if (frame - c.used > 120) { if (c.job) pool.cancel(c.job); map.delete(key); }
      });
    }
  };

  /* ---------------- local height & grass density field ----------------
   * A 320 m × 320 m field (1 m texels) around the camera holding, per texel:
   *   heightTex  the terrain height EXACTLY as drawn (ChunkManager.renderedHeight: drawn node,
   *              its triangulation and geomorph) — or -1e5 where no terrain is drawn yet
   *   grassTex   grass density, dryness, flowers, blade height
   * Texel (i, j) sits at world (originX + i, originZ + j). The field is rebuilt when the camera
   * has moved 16 m, when the terrain drawn under it changes (streaming, LOD refinement) and
   * after edits. Rebuilds run incrementally (24 rows per frame) into staging arrays and are
   * uploaded atomically, so grass never sits on stale or extrapolated heights, never appears
   * off the mesh, and fills in as soon as the terrain under it exists. */
  P._fieldSig = function (fx, fz) {
    var list = this.engine.chunks.drawList, sig = list.length, x1 = fx + FIELD, z1 = fz + FIELD;
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (n.ox > x1 || n.oz > z1 || n.ox + n.size < fx || n.oz + n.size < fz) continue;
      sig = (sig * 31 + n.id * 7 + 1) % 2147483629;
    }
    return sig;
  };
  P._updateField = function (cam) {
    var cm = this.engine.chunks;
    if (!cm.drawList.length) return;
    var cx = cam.world[0], cz = cam.world[2];
    var tfx = Math.floor(cx / FIELD_SNAP) * FIELD_SNAP - FIELD / 2, tfz = Math.floor(cz / FIELD_SNAP) * FIELD_SNAP - FIELD / 2;
    var B = this._fieldBuild, cur = this.fieldCenter;
    if (!B) {
      var need = !cur || Math.abs(tfx - cur[0]) >= FIELD_MOVE || Math.abs(tfz - cur[1]) >= FIELD_MOVE || this._fieldDirty;
      // terrain under the field changed (streamed in / refined / LOD swapped)
      if (!need && (this.frame % 4) === 0 && this._fieldSig(cur[0], cur[1]) !== this._fieldSigCur) need = true;
      if (!need) return;
      B = this._fieldBuild = { fx: tfx, fz: tfz, k: 0, sig: this._fieldSig(tfx, tfz), complete: true };
      this._fieldDirty = false;
      // no field yet, or the camera jumped (teleport): build it all now
      B.sync = !cur || Math.abs(cx - (cur[0] + FIELD / 2)) > FIELD / 2 - 130 || Math.abs(cz - (cur[1] + FIELD / 2)) > FIELD / 2 - 130;
      // same origin (terrain refined/edited under the field): update rows in place, live
      B.inPlace = !!cur && cur[0] === tfx && cur[1] === tfz && !B.sync;
      // rows nearest the camera first, so grass around the player is corrected first
      var crow = U.clamp(Math.floor(cz - tfz), 0, FIELD - 1), order = [];
      for (var r = 0; r < FIELD; r++) order.push(r);
      order.sort(function (a, b) { return Math.abs(a - crow) - Math.abs(b - crow); });
      B.order = order;
    }
    var gl = this.gl;
    var n = B.sync ? FIELD : FIELD_ROWS;
    var end = Math.min(FIELD, B.k + n);
    for (var q = B.k; q < end; q++) {
      var row = B.order[q];
      this._buildFieldRows(B, row, row + 1, cam.world);
      if (B.inPlace) {
        gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, FIELD, 1, gl.RED, gl.FLOAT, this.heightData, row * FIELD);
        gl.bindTexture(gl.TEXTURE_2D, this.grassTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, FIELD, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.grassData, row * FIELD * 4);
      }
    }
    B.k = end;
    if (B.k < FIELD) return;
    if (!B.inPlace) {
      gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, FIELD, FIELD, 0, gl.RED, gl.FLOAT, this.heightData);
      gl.bindTexture(gl.TEXTURE_2D, this.grassTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, FIELD, FIELD, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.grassData);
    }
    this.fieldCenter = [B.fx, B.fz];
    this._fieldSigCur = B.sig;
    this.fieldComplete = B.complete;
    this._fieldBuild = null;
  };
  P._buildFieldRows = function (B, j0, j1, camW) {
    var cm = this.engine.chunks, gen = this.engine.gen, G = cm.grid, W = G + 3, VN = G + 1;
    var hd = this.heightData, gd = this.grassData;
    var hint = this._fieldHint || (this._fieldHint = { n: null });
    for (var j = j0; j < j1; j++) {
      var wz = B.fz + j;
      for (var i = 0; i < FIELD; i++) {
        var wx = B.fx + i, ti = j * FIELD + i;
        var h = cm.renderedHeight(wx, wz, camW, hint);
        if (h === null) {
          // terrain not drawn here yet: no grass (never stale or guessed heights)
          hd[ti] = -1e5; gd[ti * 4] = 0; gd[ti * 4 + 1] = 0; gd[ti * 4 + 2] = 0; gd[ti * 4 + 3] = 0;
          B.complete = false;
          continue;
        }
        hd[ti] = h;
        var n = hint.n;
        if (n.level > 1) B.complete = false;
        // climate / surface bytes and slope at the nearest vertex of the node that is drawn here
        var dx = n.size / G;
        var gx = (wx - n.ox) / dx, gz = (wz - n.oz) / dx;
        var ri = Math.max(0, Math.min(G, Math.round(gx))), rj = Math.max(0, Math.min(G, Math.round(gz)));
        var vi = rj * VN + ri;
        var hs = n.heights, hc = (rj + 1) * W + (ri + 1);
        var slope = Math.min(1, Math.hypot(hs[hc + 1] - hs[hc - 1], hs[hc + W] - hs[hc - W]) / (2 * dx));
        var T = n.clim[vi * 4] / 255 * 80 - 40, Mo = n.clim[vi * 4 + 1] / 255, wprox = n.clim[vi * 4 + 2] / 255, volc = n.clim[vi * 4 + 3] / 255;
        var rock = n.surf[vi * 4 + 1] / 255, forest = n.surf[vi * 4 + 2] / 255;
        var path = n.extra[vi * 4] / 255, wet = n.extra[vi * 4 + 1] / 255, paintId = n.extra[vi * 4 + 2], paintW = n.extra[vi * 4 + 3] / 255;
        // grass holds on slopes up to ~38° and thins only in genuinely dry or rocky ground
        var dens = U.smoothstep(0.07, 0.26, Mo) * U.smoothstep(-3, 4, T) * (1 - U.smoothstep(0.5, 0.82, slope)) * (1 - U.smoothstep(0.4, 0.75, rock));
        dens *= (1 - path * 0.9) * (1 - U.smoothstep(0.25, 0.65, volc)) * (1 - forest * 0.3);
        if (h < gen.SEA + 1.5 && wprox > 0.3) dens *= U.smoothstep(gen.SEA + 0.3, gen.SEA + 1.5, h) * 0.5;
        // never under lakes, ponds or rivers (reeds take over at the waterline)
        if (n.wty && n.wty[vi] > 0 && n.wl[vi] > h - 0.25) dens = 0;
        if (Mo < 0.2 && T > 16) dens *= 0.25;               // desert
        dens = U.clamp01(dens * 1.25);                        // lush ground is fully carpeted
        if (T < -2) dens *= 0.2;                              // snowline
        if (paintW > 0) dens *= (paintId === 0 || paintId === 1) ? 1 + paintW : 1 - paintW;
        var dry = U.clamp01(1 - U.smoothstep(0.25, 0.55, Mo) + U.smoothstep(22, 32, T) * 0.4 + (paintId === 1 ? paintW : 0));
        var flowers = U.smoothstep(0.35, 0.6, Mo) * U.smoothstep(8, 16, T) * (1 - forest);
        var heightS = U.clamp01(0.4 + Mo * 0.6 + wet * 0.3 - rock * 0.3);
        gd[ti * 4] = U.clamp(dens * 255, 0, 255); gd[ti * 4 + 1] = dry * 255; gd[ti * 4 + 2] = flowers * 255; gd[ti * 4 + 3] = heightS * 255;
      }
    }
  };
  /** Field origin (render space) for consumers that sample the field with bilinear filtering
   *  (texel centres sit half a texel in from the world sample points). */
  P.fieldOriginLinear = function (origin) { return [this.fieldCenter[0] - 0.5 - origin[0], this.fieldCenter[1] - 0.5 - origin[1]]; };
  P.invalidateField = function () { this._fieldDirty = true; };

  /* ---------------- per-frame update ---------------- */
  P.update = function (frame) {
    this.frame++;
    var cam = frame.cam, cx = cam.world[0], cz = cam.world[2];
    this._requestCells(this.treeCells, TREE_CELL, cx, cz, this.impDist + TREE_CELL * 0.5, 'tree', 2);
    this._requestCells(this.propCells, PROP_CELL, cx, cz, this.propDist + PROP_CELL, 'prop', 1);
    this._fixHeights(frame);
    this._updateField(cam);
    this._updatePOIs(frame);
    // far (impostor) list: rebuild when moved or new cells arrived
    var moved = !this.lastFarBuild || Math.hypot(cx - this.lastFarBuild[0], cz - this.lastFarBuild[1]) > 20 || this.lastFarBuild[2] !== frame.originKey;
    if (moved || (this._dirtyFar && this.frame % 10 === 0)) { this._buildFar(frame); this.lastFarBuild = [cx, cz, frame.originKey]; this._dirtyFar = false; }
    this._buildNear(frame);
  };


  /* ---------------- snapping to the rendered terrain ----------------
   * Cells are generated against the full-detail height function, but distant terrain is
   * drawn from coarser, geomorphing LOD meshes (and the editor can reshape the ground).
   * Each cell therefore keeps a per-instance height snapped to ChunkManager.renderedHeight.
   * A cell is refreshed when a node it sits on stops being drawn (LOD swap), when the camera
   * has moved far enough to change the geomorph, or when an edit touches it. Work is
   * budgeted per frame, nearest cells first. */
  function sinkTree(type, sc) { return type === 10 ? sc * 0.3 : 0.1; }
  function sinkProp(type, sc) { return type === 5 ? sc * 0.22 : (type === 3 ? 0.02 : 0.04); }
  // footprint radius (m) sampled around an instance: it is seated on the LOWEST point so the
  // downhill side never hovers (the uphill side tucks into the slope like a real object)
  function footTree(type, sc) { return type === 10 ? 1.05 * sc : 0.45 * sc; }
  function footProp(type, sc) { return type === 5 ? 0.75 * sc : (type === 3 ? 2.2 * sc : (type === 0 ? 0.45 * sc : (type === 6 ? 0.55 * sc : 0.25 * sc))); }
  P._fixHeights = function (frame) {
    var CM = this.engine.chunks;
    if (!CM || !CM.renderedHeight) return;
    var cam = frame.cam.world, cx = cam[0], cz = cam[2], cf = CM.frame;
    // edits: invalidate the cells they touch
    var boxes = CM.editBoxes;
    if (boxes && boxes.length) {
      var inval = function (map, size) {
        map.forEach(function (c) {
          for (var b = 0; b < boxes.length; b++) {
            var B = boxes[b];
            if (c.i * size <= B[2] && (c.i + 1) * size >= B[0] && c.j * size <= B[3] && (c.j + 1) * size >= B[1]) { c.fixNodes = null; break; }
          }
        });
      };
      inval(this.treeCells, TREE_CELL); inval(this.propCells, PROP_CELL);
      boxes.length = 0;
    }
    var list = this._fixList || (this._fixList = []);
    list.length = 0;
    function consider(map, size, kind) {
      map.forEach(function (c) {
        if (c.state !== 'ready' || !c.inst || !c.inst.length) return;
        var mx = (c.i + 0.5) * size - cx, mz = (c.j + 0.5) * size - cz, d = Math.sqrt(mx * mx + mz * mz);
        var stale = !c.fixNodes || c.fixMiss;
        if (!stale) {
          var tol = 4 + d * 0.06;
          if (Math.abs(c.fixCx - cx) > tol || Math.abs(c.fixCz - cz) > tol) stale = true;
          else for (var q = 0; q < c.fixNodes.length; q++) if (c.fixNodes[q].drawFrame !== cf) { stale = true; break; }
        }
        if (stale) list.push({ c: c, d: d - (c.fixY ? 0 : 1e5), kind: kind });
      });
    }
    consider(this.propCells, PROP_CELL, 1);
    consider(this.treeCells, TREE_CELL, 0);
    if (!list.length) return;
    list.sort(function (a, b) { return a.d - b.d; });
    var budget = this.q >= 2 ? 5000 : 3500, done = 0, t0 = performance.now(), hint = { n: null }, anyTree = false;
    for (var li = 0; li < list.length; li++) {
      var e = list[li], c = e.c, a = c.inst, cnt = a.length >> 3;
      if (!c.fixY) { c.fixY = new Float32Array(cnt); for (var k0 = 0; k0 < cnt; k0++) c.fixY[k0] = a[k0 * 8 + 1]; }
      var nodes = [], miss = false;
      hint.n = null;
      for (var k = 0; k < cnt; k++) {
        var o = k * 8, x = a[o], z = a[o + 2], t = a[o + 5] | 0, sc = a[o + 4];
        var h = CM.renderedHeight(x, z, cam, hint);
        if (h === null) { miss = true; continue; }
        if (nodes.indexOf(hint.n) < 0) nodes.push(hint.n);
        var fr = e.kind === 0 ? footTree(t, sc) : footProp(t, sc);
        if (fr > 0.15) {
          var ca = Math.cos(a[o + 3]), sa = Math.sin(a[o + 3]);
          if (e.kind === 1 && t === 3) {
            // logs: both ends along the log axis
            var h1 = CM.renderedHeight(x + ca * fr, z + sa * fr, cam, hint), h2 = CM.renderedHeight(x - ca * fr, z - sa * fr, cam, hint);
            if (h1 !== null) h = Math.min(h, h1); if (h2 !== null) h = Math.min(h, h2);
          } else {
            for (var q = 0; q < 4; q++) {
              var qa = q * 1.5708, dx = Math.cos(qa) * fr, dz = Math.sin(qa) * fr;
              var hq = CM.renderedHeight(x + dx * ca - dz * sa, z + dx * sa + dz * ca, cam, hint);
              if (hq !== null && hq < h) h = hq;
            }
          }
        }
        c.fixY[k] = h - (e.kind === 0 ? sinkTree(t, sc) : sinkProp(t, sc));
      }
      c.fixNodes = nodes; c.fixMiss = miss; c.fixCx = cx; c.fixCz = cz;
      if (e.kind === 0) anyTree = true;
      done += cnt;
      if (done > budget || performance.now() - t0 > 4) break;
    }
    if (anyTree) this._dirtyFar = true;
    this.stats.heightFixes = done;
  };

  function pushInst(arr, n, x, y, z, rot, sc, seed, fade, extra) {
    var o = n * 8;
    arr[o] = x; arr[o + 1] = y; arr[o + 2] = z; arr[o + 3] = rot; arr[o + 4] = sc; arr[o + 5] = seed; arr[o + 6] = fade; arr[o + 7] = extra;
  }

  P._eachTree = function (cx, cz, radius, fn) {
    var edits = this.engine.edits;
    var hasRemove = edits && edits.vegRemove.length > 0;
    var i0 = Math.floor((cx - radius) / TREE_CELL), i1 = Math.floor((cx + radius) / TREE_CELL);
    var j0 = Math.floor((cz - radius) / TREE_CELL), j1 = Math.floor((cz + radius) / TREE_CELL);
    for (var j = j0; j <= j1; j++) for (var i = i0; i <= i1; i++) {
      var c = this.treeCells.get(i + ':' + j);
      if (!c || c.state !== 'ready' || !c.inst) continue;
      var a = c.inst, fy = c.fixY;
      for (var k = 0; k < a.length; k += 8) {
        if (hasRemove && edits.vegRemoved(a[k], a[k + 2])) continue;
        fn(a, k, fy ? fy[k >> 3] : a[k + 1]);
      }
    }
    if (edits && edits.vegAdd.length) {
      var va = edits.vegAdd;
      for (var q = 0; q < va.length; q += 9) if (va[q + 8] === 0) fn(va, q, va[q + 1]);
    }
  };

  P._buildFar = function (frame) {
    var cam = frame.cam, cx = cam.world[0], cz = cam.world[2], o = frame.origin;
    var lodS = U.clamp(this.engine.lodScale || 1, 0.5, 1.3);
    var nv = this.models.variants, D = this.impDist * Math.min(1.15, lodS), near = this.treeMeshDist * lodS;
    var cap = 120000, arr = this._farArr || (this._farArr = new Float32Array(cap * 8)), n = 0;
    var bArr = this._boulderFar || (this._boulderFar = []);
    bArr.length = 0;
    var bd = this.boulderDist;
    this._eachTree(cx, cz, D, function (a, k, y) {
      var x = a[k], z = a[k + 2], type = a[k + 5] | 0;
      var dx = x - cx, dz = z - cz, d2 = dx * dx + dz * dz;
      if (type === 10) { if (d2 < bd * bd) bArr.push(k, a); return; }
      if (d2 > D * D || d2 < (near - 20) * (near - 20)) return;
      var d = Math.sqrt(d2);
      // distance thinning (the terrain canopy fills in far forests)
      var keep = d < 550 ? 1 : (d < 1000 ? 0.55 : 0.3);
      var hsh = (a[k + 7] * 7.13) % 1;
      if (hsh > keep) return;
      var scaleComp = keep < 1 ? 1 / Math.sqrt(keep) * 0.85 : 1;
      if (n >= cap) return;
      var farFade = 1 - U.smoothstep(D - 120, D, d);
      pushInst(arr, n++, x - o[0], y, z - o[1], a[k + 3], a[k + 4] * Math.min(scaleComp, 1.6), a[k + 7], farFade, type * nv + (a[k + 6] % nv));
    });
    this.farCount = n;
    var gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.impBuf);
    gl.bufferData(gl.ARRAY_BUFFER, arr.subarray(0, n * 8), gl.DYNAMIC_DRAW);
    this.stats.impostors = n;
  };

  P._buildNear = function (frame) {
    var cam = frame.cam, cx = cam.world[0], cz = cam.world[2], cy = cam.world[1], o = frame.origin;
    var models = this.models, nv = models.variants;
    var planes = cam.planes;
    var lodS = U.clamp(this.engine.lodScale || 1, 0.5, 1.3);
    var D = this.treeMeshDist * lodS, LD = this.treeLodDist * lodS, BAND = 7;
    // buckets per mesh
    var buckets = this._buckets || (this._buckets = {});
    for (var key in buckets) buckets[key].n = 0;
    function bucket(kind, t, v) {
      var k = kind * 10000 + t * 100 + v;
      var b = buckets[k];
      if (!b) b = buckets[k] = { kind: kind, t: t, v: v, n: 0, arr: new Float32Array(8 * 256) };
      return b;
    }
    function add(b, x, y, z, rot, sc, seed, fade, extra) {
      if ((b.n + 1) * 8 > b.arr.length) { var na = new Float32Array(b.arr.length * 2); na.set(b.arr); b.arr = na; }
      pushInst(b.arr, b.n++, x, y, z, rot, sc, seed, fade, extra || 0);
    }
    var nearTrees = 0;
    var self = this;
    // near trees (+ fade band into impostors) and boulders
    this._eachTree(cx, cz, Math.max(D, this.boulderDist), function (a, k, y) {
      var x = a[k], z = a[k + 2], type = a[k + 5] | 0;
      var dx = x - cx, dz = z - cz, d2 = dx * dx + dz * dz;
      var lim = type === 10 ? self.boulderDist : D;
      if (d2 > lim * lim) return;
      var m = models.trees[type][a[k + 6] % nv];
      var sc = a[k + 4];
      var rx = x - o[0], rz = z - o[1];
      if (!M.sphereInFrustum(planes, rx, y + m.height * sc * 0.5, rz, Math.max(m.radius, m.height * 0.5) * sc + 1, 5)) return;
      var d = Math.sqrt(d2);
      var fade = type === 10 ? 1 - U.smoothstep(lim - 60, lim, d) : 1 - U.smoothstep(D - 20, D, d);
      var vv = a[k + 6] % nv;
      if (type === 10 || !models.treesLod) add(bucket(0, type, vv), rx, y, rz, a[k + 3], sc, a[k + 7], fade);
      else {
        // full mesh ↔ reduced mesh: dithered cross-fade across a band (no popping)
        var ld = LD * (0.92 + 0.16 * a[k + 7]);
        if (d < ld - BAND) add(bucket(0, type, vv), rx, y, rz, a[k + 3], sc, a[k + 7], fade);
        else if (d > ld + BAND) add(bucket(4, type, vv), rx, y, rz, a[k + 3], sc, a[k + 7], fade);
        else {
          var tb = (d - (ld - BAND)) / (2 * BAND);
          add(bucket(0, type, vv), rx, y, rz, a[k + 3], sc, a[k + 7], Math.max(0.001, 1 - tb));
          add(bucket(4, type, vv), rx, y, rz, a[k + 3], sc, a[k + 7], -Math.max(0.001, tb));
        }
      }
      nearTrees++;
    });
    // props
    var edits = this.engine.edits, hasRemove = edits && edits.vegRemove.length > 0;
    var PD = this.propDist, props = 0;
    var i0 = Math.floor((cx - PD) / PROP_CELL), i1 = Math.floor((cx + PD) / PROP_CELL), j0 = Math.floor((cz - PD) / PROP_CELL), j1 = Math.floor((cz + PD) / PROP_CELL);
    for (var j = j0; j <= j1; j++) for (var i = i0; i <= i1; i++) {
      var c = this.propCells.get(i + ':' + j);
      if (!c || c.state !== 'ready') continue;
      var a = c.inst, fy = c.fixY;
      for (var k = 0; k < a.length; k += 8) {
        var x = a[k], z = a[k + 2];
        var dx = x - cx, dz = z - cz, d2 = dx * dx + dz * dz;
        var type = a[k + 5] | 0, py = fy ? fy[k >> 3] : a[k + 1];
        var lim2 = (type === 5 || type === 3) ? PD * 1.4 : PD;
        if (d2 > lim2 * lim2) continue;
        if (hasRemove && edits.vegRemoved(x, z)) continue;
        var rx = x - o[0], rz = z - o[1];
        if (!M.sphereInFrustum(planes, rx, py, rz, 3 * a[k + 4], 5)) continue;
        var d = Math.sqrt(d2);
        add(bucket(1, type, a[k + 6] % 2), rx, py, rz, a[k + 3], a[k + 4], a[k + 7], 1 - U.smoothstep(lim2 - 12, lim2, d));
        props++;
      }
    }
    if (edits && edits.vegAdd.length) {
      var va = edits.vegAdd;
      for (var q = 0; q < va.length; q += 9) {
        if (va[q + 8] !== 1) continue;
        var ddx = va[q] - cx, ddz = va[q + 2] - cz;
        if (ddx * ddx + ddz * ddz > PD * PD * 2) continue;
        add(bucket(1, va[q + 5] | 0, (va[q + 6] | 0) % 2), va[q] - o[0], va[q + 1], va[q + 2] - o[1], va[q + 3], va[q + 4], va[q + 7], 1);
      }
    }
    // structures & relics & editor objects
    var list = this.poiList, CM = this.engine.chunks, camW = cam.world, hint = this._poiHint || (this._poiHint = { n: null });
    for (var p = 0; p < list.length; p++) {
      var poi = list[p];
      var pdx = poi.x - cx, pdz = poi.z - cz;
      if (pdx * pdx + pdz * pdz > 1500 * 1500) continue;
      // sit on the terrain as rendered (coarse LOD far away)
      var rh = CM && CM.renderedHeight ? CM.renderedHeight(poi.x, poi.z, camW, hint) : null;
      // structures have deep foundations, so they sit at the centre height (never float: walls continue into the ground)
      poi.ry = rh === null ? poi.y : rh - (poi.type === 7 ? 1.5 : 0.15);
      if (!M.sphereInFrustum(planes, poi.x - o[0], poi.ry, poi.z - o[1], 30, 5)) continue;
      add(bucket(2, poi.type, poi.seed % 3), poi.x - o[0], poi.ry, poi.z - o[1], poi.rot, 1, (poi.seed % 1000) / 1000, 1);
      if (poi.relic && !this.collected[poi.id] && pdx * pdx + pdz * pdz < 400 * 400) {
        var rp = this.relicPos(poi);
        add(bucket(3, 0, 0), rp[0] - o[0], rp[1], rp[2] - o[1], frame.time * 0.8, 1, 0.3, 1);
      }
    }
    var objs = edits ? edits.objects : [];
    for (var ob = 0; ob < objs.length; ob++) {
      var obj = objs[ob];
      var odx = obj.x - cx, odz = obj.z - cz;
      if (odx * odx + odz * odz > 900 * 900) continue;
      // spawned objects follow later terrain edits and distant LOD
      var orh = CM && CM.renderedHeight ? CM.renderedHeight(obj.x, obj.z, camW, hint) : null;
      var oy = orh === null ? obj.y : orh - (obj.kind === 'structure' ? 0.1 : 0.05);
      if (obj.kind === 'tree') add(bucket(0, obj.type, obj.variant % nv), obj.x - o[0], oy, obj.z - o[1], obj.rot, obj.scale, obj.seed || 0.5, 1);
      else if (obj.kind === 'prop') add(bucket(1, obj.type, obj.variant % 2), obj.x - o[0], oy, obj.z - o[1], obj.rot, obj.scale, obj.seed || 0.5, 1);
      else if (obj.kind === 'structure') add(bucket(2, obj.type, obj.variant % 3), obj.x - o[0], oy, obj.z - o[1], obj.rot, obj.scale || 1, obj.seed || 0.5, 1);
    }
    // felled / toppling trees (tools)
    var tools = this.engine.tools;
    if (tools && tools.felled.length) tools.vegInstances(function (type, variant, x, y, z, rot, sc, seed, extra) {
      add(bucket(0, type, variant % nv), x - o[0], y, z - o[1], rot, sc, seed, 1, extra);
    }, cx, cz);
    // upload
    var gl = this.gl;
    for (var bk in buckets) {
      var b = buckets[bk];
      if (!b.n) continue;
      var mesh = this._meshFor(b);
      if (!mesh) { b.n = 0; continue; }
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.inst);
      gl.bufferData(gl.ARRAY_BUFFER, b.arr.subarray(0, b.n * 8), gl.DYNAMIC_DRAW);
    }
    this.stats.trees = nearTrees; this.stats.props = props;
  };

  P._meshFor = function (b) {
    var m = this.models;
    if (b.kind === 0) return m.trees[b.t] && m.trees[b.t][b.v];
    if (b.kind === 1) return m.props[b.t] && m.props[b.t][b.v];
    if (b.kind === 2) return m.structures[b.t] && m.structures[b.t][b.v];
    if (b.kind === 3) return m.relic;
    if (b.kind === 4) return (m.treesLod && m.treesLod[b.t] && m.treesLod[b.t][b.v]) || (m.trees[b.t] && m.trees[b.t][b.v]);
    return null;
  };

  /* ---------------- points of interest ---------------- */
  P._updatePOIs = function (frame) {
    var cam = frame.cam, cx = cam.world[0], cz = cam.world[2];
    if (this._poiAt && Math.hypot(cx - this._poiAt[0], cz - this._poiAt[1]) < 200) { this._updateLights(frame); return; }
    this._poiAt = [cx, cz];
    var gen = this.engine.gen;
    var list = gen.poisNear(cx, cz, 3500);
    // settle structures on edited terrain
    var ed = this.engine.edits;
    for (var i = 0; i < list.length; i++) { var p = list[i]; p.y = gen.height(p.x, p.z) + (ed ? ed.heightDelta(p.x, p.z) : 0) - (p.type === 7 ? 1.5 : 0.1); }
    this.poiList = list;
    this._updateLights(frame);
    TERRA.events.emit('pois', list);
  };
  P.relicPos = function (poi) {
    var off = poi.type === 7 ? [0, 1.2, 4] : (poi.type === 2 ? [2, 1.3, -2] : [0, 1.4, 0]);
    var c = Math.cos(poi.rot), s = Math.sin(poi.rot);
    var t = this.engine.time || 0;
    return [poi.x + c * off[0] - s * off[2], (poi.ry !== undefined ? poi.ry : poi.y) + off[1] + Math.sin(t * 1.5 + poi.seed) * 0.15 + 0.4, poi.z + s * off[0] + c * off[2]];
  };
  P._updateLights = function (frame) {
    var cam = frame.cam, cx = cam.world[0], cz = cam.world[2], o = frame.origin;
    var night = 1 - frame.env.dayFactor;
    var lights = this.lights; lights.length = 0;
    for (var i = 0; i < this.poiList.length && lights.length < 8; i++) {
      var p = this.poiList[i];
      var d = Math.hypot(p.x - cx, p.z - cz);
      if (d > 400) continue;
      var flick = 0.85 + 0.15 * Math.sin(frame.time * 11 + i) * Math.sin(frame.time * 7.3 + i * 2);
      if (p.type === 2) {
        var c = Math.cos(p.rot), s = Math.sin(p.rot);
        lights.push({ pos: [p.x + c * 3.2 - s * 1.0 - o[0], p.y + 0.6, p.z + s * 3.2 + c * 1.0 - o[1]], radius: 14, color: [6 * flick, 2.6 * flick, 0.8 * flick].map(function (v) { return v * (0.3 + night * 0.7); }) });
      } else if (p.type === 3 && night > 0.3) {
        lights.push({ pos: [p.x - o[0], p.y + 2.5, p.z - o[1]], radius: 22, color: [2.4 * flick * night, 1.4 * flick * night, 0.5 * night] });
      } else if (p.relic && !this.collected[p.id]) {
        var rp = this.relicPos(p);
        lights.push({ pos: [rp[0] - o[0], rp[1], rp[2] - o[1]], radius: 6, color: [0.3, 1.0, 1.6] });
      }
    }
  };
  /** Relic pickup check; returns the collected POI or null. */
  P.tryCollect = function (pos) {
    for (var i = 0; i < this.poiList.length; i++) {
      var p = this.poiList[i];
      if (!p.relic || this.collected[p.id]) continue;
      var rp = this.relicPos(p);
      if (Math.hypot(rp[0] - pos[0], rp[1] - 0.9 - pos[1], rp[2] - pos[2]) < 1.6) { this.collected[p.id] = true; this._poiAt = null; return p; }
    }
    return null;
  };

  /** Collision circles near a point: [x, z, r, ...] (trunks, boulders, structures). */
  P.collidersNear = function (x, z, radius, noTools) {
    var out = [];
    var i0 = Math.floor((x - radius) / TREE_CELL), i1 = Math.floor((x + radius) / TREE_CELL);
    var j0 = Math.floor((z - radius) / TREE_CELL), j1 = Math.floor((z + radius) / TREE_CELL);
    var edits = this.engine.edits;
    for (var j = j0; j <= j1; j++) for (var i = i0; i <= i1; i++) {
      var c = this.treeCells.get(i + ':' + j);
      if (!c || !c.inst) continue;
      var a = c.inst;
      for (var k = 0; k < a.length; k += 8) {
        var dx = a[k] - x, dz = a[k + 2] - z;
        if (dx * dx + dz * dz > radius * radius) continue;
        if (edits && edits.vegRemoved(a[k], a[k + 2])) continue;
        var type = a[k + 5] | 0, s = a[k + 4];
        var r = type === 10 ? s * 1.1 : (type === 9 ? 1.4 * s : (type === 7 ? 0.35 * s : 0.3 * s));
        out.push(a[k], a[k + 2], r, a[k + 1]);
      }
    }
    if (this.engine.tools && !noTools) this.engine.tools.colliders(x, z, radius, out);
    for (var p = 0; p < this.poiList.length; p++) {
      var poi = this.poiList[p];
      if (Math.hypot(poi.x - x, poi.z - z) > radius + 20) continue;
      if (poi.type === 5 || poi.type === 8) out.push(poi.x, poi.z, poi.type === 8 ? 1.4 : 1.2, poi.y);
      if (poi.type === 4) out.push(poi.x, poi.z, 2.0, poi.y);
    }
    return out;
  };

  /* ---------------- drawing ---------------- */
  P._bindMeshProg = function (p, frame, shadow, vp) {
    var gl = this.gl, R = this.engine.renderer;
    p.use();
    p.tex('uAlbedoH', 0, R.tex.matAlbedo, gl.TEXTURE_2D_ARRAY).tex('uNormalR', 1, R.tex.matNormal, gl.TEXTURE_2D_ARRAY)
     .tex('uFoliage', 2, R.tex.foliage, gl.TEXTURE_2D_ARRAY).tex('uFoliageN', 3, R.tex.foliageN, gl.TEXTURE_2D_ARRAY);
    p.i('uBake', 0).i('uShadowPass', shadow ? 1 : 0);
    p.f('uAlphaJitter', !shadow && R.taaOn ? 1 : 0);
    if (shadow) { p.m4('uShadowVP', vp); TERRA.gfx.HiZ.bindOff(R, p, 5); }
    else if (R.hiz) R.hiz.bind(p, 5, 35);
    else TERRA.gfx.HiZ.bindOff(R, p, 5);
    p.f('uWindScale', 1);
  };
  P._drawBuckets = function (p, shadow, cascade) {
    var gl = this.gl, buckets = this._buckets;
    if (!buckets) return;
    for (var bk in buckets) {
      var b = buckets[bk];
      if (!b.n) continue;
      if (shadow && b.kind === 1 && (cascade > 0 || b.t === 6 || b.t === 4 || b.t === 10)) continue;
      if (shadow && (b.kind === 0 || b.kind === 4) && cascade > 2) continue;
      var m = this._meshFor(b);
      if (!m) continue;
      p.f('uHeight', m.height).v2('uBound', m.height || 2, m.radius || 2);
      if (!shadow) p.v4('uHiZInfo', this._hizOn && (b.kind === 0 || b.kind === 4) ? 1 : 0, this._hizLevels || 1, 35, 0);
      p.f('uInteract', b.kind === 1 && (b.t === 0 || b.t === 1 || b.t === 8 || b.t === 10 || b.t === 2) ? 1 : 0);
      p.i('uDeciduous', (b.kind === 0 || b.kind === 4) && DECIDUOUS[b.t] ? 1 : (b.kind === 1 && b.t === 0 ? 1 : 0));
      gl.bindVertexArray(m.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, m.count, m.indexType, 0, b.n);
      this.G.stats.drawCalls++; this.G.stats.triangles += m.tris * b.n;
    }
    gl.bindVertexArray(null);
  };
  P._drawImpostors = function (p, frame, shadow, vp, cascade) {
    if (!this.farCount || !this.impColor) return;
    var gl = this.gl;
    p.use();
    p.tex('uImpColor', 0, this.impColor, gl.TEXTURE_2D_ARRAY).tex('uImpNormal', 1, this.impNormal, gl.TEXTURE_2D_ARRAY);
    gl.uniform4fv(p.loc('uAtlasInfo[0]'), this.atlasInfo);
    p.i('uShadowPass', shadow ? 1 : 0);
    p.f('uAlphaJitter', !shadow && this.engine.renderer.taaOn ? 1 : 0);
    var R = this.engine.renderer;
    if (shadow) { p.m4('uShadowVP', vp); var L = frame.env.lightDir; p.v3('uShadowDir', -L[0], -L[1], -L[2]); TERRA.gfx.HiZ.bindOff(R, p, 4); }
    else { if (R.hiz) R.hiz.bind(p, 4, 0); else TERRA.gfx.HiZ.bindOff(R, p, 4); }
    gl.bindVertexArray(this.impVAO);
    gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, this.farCount);
    gl.bindVertexArray(null);
    this.G.stats.drawCalls++; this.G.stats.triangles += this.farCount * 2;
  };
  P._drawGrass = function (p, frame, shadow, vp) {
    if (!this.fieldCenter || this.engine.settings.graphics.grass === false) return;
    var gl = this.gl, R = this.engine.renderer, o = frame.origin;
    var snowHide = frame.env.snowCover * U.smoothstep(3, -1, frame.env.tempAtCam);
    if (snowHide > 0.95) return;
    p.use();
    p.tex('uHeightTex', 0, this.heightTex).tex('uGrassTex', 1, this.grassTex).tex('uTrailTex', 2, R.trailTex || R.tex.black)
     .tex('uWindTex', 3, R.windTex || R.tex.black).tex('uNoiseTex', 4, R.tex.noise);
    var wa = R.windArea || [0, 0, 1];
    p.v4('uWindArea', wa[0], wa[1], wa[2], R.windTex ? 1 : 0);
    p.v4('uField', this.fieldCenter[0] - o[0], this.fieldCenter[1] - o[1], FIELD, 1 / FIELD);
    p.i('uShadowPass', shadow ? 1 : 0);
    if (shadow) p.m4('uShadowVP', vp);
    p.f('uDensityScale', this.engine.settings.graphics.grassDensity || 1.0).f('uBladeScale', 1.0);
    var cam = frame.cam;
    var rings = shadow ? this.grassRings.slice(0, 1) : this.grassRings;
    var total = 0;
    var lodS = U.clamp(this.engine.lodScale || 1, 0.6, 1.2);
    for (var r = 0; r < rings.length; r++) {
      var ring = rings[r], sp = ring[0], outer = r === rings.length - 1 ? Math.max(ring[1] + 8, ring[2] * lodS) : ring[2];
      var half = Math.ceil(outer / sp);
      var cellX = Math.floor(cam.world[0] / sp) * sp - o[0], cellZ = Math.floor(cam.world[2] / sp) * sp - o[1];
      p.v4('uRing', sp, half, ring[1], outer).v2('uCellOrigin', cellX, cellZ).f('uBladeScale', ring[3]);
      var mesh = this.grassMeshes[shadow ? 1 : ring[4]];
      gl.bindVertexArray(mesh.vao);
      var count = (half * 2) * (half * 2);
      gl.drawElementsInstanced(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0, count);
      total += count;
      this.G.stats.drawCalls++; this.G.stats.triangles += count * mesh.tris * 0.35;
    }
    gl.bindVertexArray(null);
    this.stats.grass = total;
  };

  P.drawGBuffer = function (frame) {
    if (!this.models) return;
    var gl = this.gl;
    gl.disable(gl.CULL_FACE);
    this._bindMeshProg(this.progMesh, frame, false);
    var R = this.engine.renderer;
    this._hizOn = !!(R.hiz && R.hiz.ok && R.hiz.valid && !R.taaReset && frame.settings.occlusionCulling !== false);
    this._hizLevels = R.hiz ? R.hiz.levels : 1;
    this._drawBuckets(this.progMesh, false, 0);
    this._drawImpostors(this.progImp, frame, false);
    this._drawGrass(this.progGrass, frame, false);
  };
  P.drawShadow = function (frame, vp, planes, cascade) {
    if (!this.models) return;
    this._bindMeshProg(this.progMeshShadow, frame, true, vp);
    this._drawBuckets(this.progMeshShadow, true, cascade);
    if (cascade >= 1) this._drawImpostors(this.progImpShadow, frame, true, vp, cascade);
    if (cascade === 0 && this.q >= 2) this._drawGrass(this.progGrassShadow, frame, true, vp);
  };

  Vegetation.FIELD = FIELD;
  TERRA.world.Vegetation = Vegetation;
})();
