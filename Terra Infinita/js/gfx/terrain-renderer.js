/* =============================================================================
 * TERRA INFINITA — terrain rendering (G-buffer, shadow casters, reflection probe)
 * ========================================================================== */
(function () {
  'use strict';
  var S = TERRA.shaders, M = TERRA.math, U = TERRA.util;

  // metres per texture tile for each material layer (powers of two → continuous across origin shifts)
  var LAYER_SCALE = [4, 4, 4, 8, 16, 4, 8, 2, 4, 4, 8, 4, 8, 2, 2, 2];

  function TerrainRenderer(R) {
    this.R = R; this.G = R.G; this.gl = R.G.gl;
    this.prog = this.G.program('terrain', S.terrainVS, S.terrainFS);
    this.progShadow = this.G.program('terrainShadow', S.terrainVS, S.terrainShadowFS);
    this.scaleArr = new Float32Array(16);
    for (var i = 0; i < 16; i++) this.scaleArr[i] = LAYER_SCALE[i];
    this.brush = [0, 0, 0, 0]; this.brushColor = [1, 0.8, 0.3, 1];
    this.stats = { drawn: 0, tris: 0 };
  }
  var P = TerrainRenderer.prototype;

  P._nodeUniforms = function (prog, n, origin, cm) {
    var mr = cm.morphRange(n.level);
    prog.v3('uNodeOffset', n.ox - origin[0], 0, n.oz - origin[1]);
    prog.v4('uNodeInfo', n.size, n.level, n.edge || 0, cm.grid);
    prog.v2('uMorphRange', mr[0], mr[1]);
  };

  /** Draw visible terrain into the currently bound G-buffer. */
  P.drawGBuffer = function (frame) {
    var gl = this.gl, cm = frame.chunks, R = this.R;
    if (!cm || !cm.drawList.length) return;
    var p = this.prog.use();
    var tex = R.tex;
    p.tex('uAlbedoH', 0, tex.matAlbedo, gl.TEXTURE_2D_ARRAY)
     .tex('uNormalR', 1, tex.matNormal, gl.TEXTURE_2D_ARRAY)
     .tex('uNoiseTex', 2, tex.noise)
     .tex('uTrailTex', 3, R.trailTex || tex.black);
    gl.uniform1fv(p.loc('uLayerScale[0]'), this.scaleArr);
    var q = frame.settings.pbrQuality;
    p.i('uMaxLayers', q >= 2 ? 4 : (q === 1 ? 3 : 2));
    p.v4('uBrush', this.brush[0], this.brush[1], this.brush[2], this.brush[3]);
    p.v4('uBrushColor', this.brushColor[0], this.brushColor[1], this.brushColor[2], 1);
    p.i('uShadowPass', 0);
    // dense-grass ground cover (the ground under the blades reads as thatch) & parallax detail
    var veg = R.engine.vegetation, g = frame.settings;
    var grassOn = veg && veg.fieldCenter && g.grass !== false && veg.grassRings;
    p.tex('uGrassTex', 4, grassOn ? veg.grassTex : tex.black);
    if (grassOn) {
      var rings = veg.grassRings, outer = rings[rings.length - 1][2];
      var fo = veg.fieldOriginLinear(frame.origin);
      p.v4('uGrassField', fo[0], fo[1], veg.FIELD, outer);
    } else p.v4('uGrassField', 0, 0, 1, 0);
    p.f('uPOM', (g.pbrQuality >= 2 && g.parallax !== false) ? 1 : 0);
    var planes = frame.cam.planes, origin = frame.origin;
    var list = cm.drawList, drawn = 0, tris = 0;
    gl.disable(gl.CULL_FACE);
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      var x0 = n.ox - origin[0], z0 = n.oz - origin[1];
      if (!M.aabbInFrustum(planes, x0, n.minH - 5, z0, x0 + n.size, n.maxH + 5, z0 + n.size, 6)) continue;
      this._nodeUniforms(p, n, origin, cm);
      gl.bindVertexArray(n.vbo.vao);
      gl.drawElements(gl.TRIANGLES, cm.indexCount, gl.UNSIGNED_SHORT, 0);
      drawn++; tris += cm.indexCount / 3;
    }
    gl.bindVertexArray(null);
    this.G.stats.drawCalls += drawn; this.G.stats.triangles += tris;
    this.stats.drawn = drawn; this.stats.tris = tris;
  };

  /** Shadow casters for one cascade. */
  P.drawShadow = function (frame, vp, planes, cascade) {
    var gl = this.gl, cm = frame.chunks;
    if (!cm || !cm.drawList.length) return;
    var p = this.progShadow.use();
    p.i('uShadowPass', 1).m4('uShadowVP', vp);
    var c = frame.cam.pos;
    p.v3('uLightCam', c[0], c[1], c[2]);
    var origin = frame.origin, list = cm.drawList;
    gl.disable(gl.CULL_FACE);
    // far cascades draw coarser ancestors instead of every fine node (fewer draw calls)
    var minLevel = [0, 1, 3, 4][cascade] || 0;
    var seen = this._seen || (this._seen = new Set());
    seen.clear();
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (n.level < minLevel) {
        var L = minLevel, s2 = cm.constructor.LEAF * Math.pow(2, L);
        var an = cm.nodes.get(L + ':' + Math.floor(n.ox / s2) + ':' + Math.floor(n.oz / s2));
        if (an && an.state === 'ready') { if (seen.has(an.key)) continue; seen.add(an.key); n = an; }
      }
      var x0 = n.ox - origin[0], z0 = n.oz - origin[1];
      if (!M.aabbInFrustum(planes, x0, n.minH - 5, z0, x0 + n.size, n.maxH + 5, z0 + n.size, 6)) continue;
      this._nodeUniforms(p, n, origin, cm);
      gl.bindVertexArray(n.vbo.vao);
      gl.drawElements(gl.TRIANGLES, cm.indexCount, gl.UNSIGNED_SHORT, 0);
      this.G.stats.drawCalls++;
    }
    gl.bindVertexArray(null);
  };

  P.LAYER_SCALE = LAYER_SCALE;
  TERRA.gfx.TerrainRenderer = TerrainRenderer;
})();
