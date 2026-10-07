/* =============================================================================
 * TERRA INFINITA — far-field terrain light
 * -----------------------------------------------------------------------------
 * Keeps a 512² (24 m texel, ~12 km) height + albedo field centred on the camera by
 * rasterising the loaded terrain chunks top-down, then derives distant mountain
 * shadows (shadow-top height + occluder distance) and large-scale sky visibility on
 * the GPU. Used by the lighting pass (shadows far beyond the shadow cascades, valley
 * ambient occlusion), the light shafts (mountain shadows in haze), water, and the
 * path tracer (world-space rays + shaded hits).
 * Updates are incremental and cheap: heights re-render when the camera has moved
 * ~1.5 km or the loaded terrain changed (≤ 2×/s); shadows when the sun moved.
 * ========================================================================== */
(function () {
  'use strict';
  var S = TERRA.shaders, U = TERRA.util;

  var N = 512, TEXEL = 24, SIZE = N * TEXEL;

  function FarField(R) {
    this.R = R; this.G = R.G; this.gl = R.G.gl;
    var G = this.G, gl = this.gl;
    this.ok = !!G.caps.colorFloat;
    this.N = N; this.TEXEL = TEXEL; this.SIZE = SIZE;
    this.valid = false; this.center = null;
    if (!this.ok) return;
    try {
      this.pHeight = G.program('ffHeight', S.ffHeightVS, S.ffHeightFS);
      this.pShadow = G.program('ffShadow', S.fullscreenVS, S.ffShadowFS);
      this.pSky = G.program('ffSky', S.fullscreenVS, S.ffSkyFS);
      var f16 = { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT };
      this.hTex = G.texture2D(N, N, f16);
      this.aTex = G.texture2D(N, N, { internal: gl.RGBA8 });
      this.dTex = G.texture2D(N, N, { internal: gl.DEPTH_COMPONENT16, filter: gl.NEAREST });
      this.hFB = G.framebuffer([this.hTex, this.aTex], this.dTex);
      this.lTex = G.texture2D(N, N, f16);
      this.lFB = G.framebuffer([this.lTex]);
      this.ok = this.hFB.ok && this.lFB.ok;
    } catch (e) { U.warn('Far-field terrain light unavailable', e); this.ok = false; }
    this.ibos = {};
    this._lastH = -1e9; this._lastSig = -1; this._lastSun = [0, 0, 0]; this._lastShadow = -1e9;
    this._skyDirty = false;
  }
  var P = FarField.prototype;

  /** Index buffer covering the node grid with every `s`-th vertex (s divides the grid). */
  P._ibo = function (G0, s) {
    var k = G0 + ':' + s;
    if (this.ibos[k]) return this.ibos[k];
    var VN = G0 + 1, n = G0 / s, idx = new Uint16Array(n * n * 6), o = 0;
    for (var j = 0; j < n; j++) for (var i = 0; i < n; i++) {
      var a = (j * s) * VN + i * s, b = a + s, c = a + s * VN, d = c + s;
      idx[o++] = a; idx[o++] = c; idx[o++] = d; idx[o++] = a; idx[o++] = d; idx[o++] = b;
    }
    this.gl.bindVertexArray(null);
    var buf = this.G.buffer(this.gl.ELEMENT_ARRAY_BUFFER, idx);
    this.ibos[k] = { buf: buf, count: idx.length };
    return this.ibos[k];
  };

  /** Render-space rectangle [x0, z0, size] for the current floating origin. */
  P.rect = function (origin) {
    if (!this.center) return [0, 0, 1];
    return [this.center[0] - SIZE / 2 - origin[0], this.center[1] - SIZE / 2 - origin[1], SIZE];
  };
  P.enabled = function (g) {
    return this.ok && this.valid && g.farShadows !== false;
  };

  P.update = function (frame) {
    if (!this.ok) return;
    var g = frame.settings;
    if (g.farShadows === false) return;
    var cm = frame.chunks;
    if (!cm || !cm.drawList.length) return;
    var cw = frame.cam.world, now = performance.now();
    var dirtyH = false, recentred = false;
    if (this._lastHFrame === undefined) { this._lastHFrame = -1e9; this._frames = 0; }
    if (!this.center || Math.abs(cw[0] - this.center[0]) > SIZE * 0.12 || Math.abs(cw[2] - this.center[1]) > SIZE * 0.12) {
      var snap = TEXEL * 8;
      this.center = [Math.round(cw[0] / snap) * snap, Math.round(cw[2] / snap) * snap];
      dirtyH = true; recentred = true;
    } else if (cm.drawSig !== this._lastSig && now - this._lastH > 900 && this._frames - this._lastHFrame > 40) dirtyH = true;
    this._frames = (this._frames || 0) + 1;
    if (dirtyH) {
      this._renderHeights(frame, cm);
      this._lastSig = cm.drawSig; this._lastH = now; this._lastHFrame = this._frames;
      // sky visibility changes little as distant LODs refine: refresh it on recentre or every few updates
      this._hCount = (this._hCount || 0) + 1;
      if (recentred || this._hCount % 4 === 1) this._skyDirty = true;
      this._lastShadow = -1e9;
    }
    var L = frame.env.lightDir, ls = this._lastSun;
    var sunMoved = Math.abs(L[0] - ls[0]) + Math.abs(L[1] - ls[1]) + Math.abs(L[2] - ls[2]) > 0.0015;
    if (this._lastShadow < 0 || this._skyDirty || (sunMoved && now - this._lastShadow > 250) || now - this._lastShadow > 8000) {
      this._renderLight(frame, sunMoved || this._lastShadow < 0, this._skyDirty);
      this._lastSun = [L[0], L[1], L[2]]; this._lastShadow = now; this._skyDirty = false;
      this.valid = true;
    }
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
  };

  P._renderHeights = function (frame, cm) {
    var gl = this.gl, G = this.G, origin = frame.origin;
    var r = this.rect(origin);
    G.bindFB(this.hFB, N, N);
    gl.clearBufferfv(gl.COLOR, 0, new Float32Array([-500, 0, 0, 1]));
    gl.clearBufferfv(gl.COLOR, 1, new Float32Array([0.1, 0.1, 0.1, 1]));
    gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true);
    gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    var p = this.pHeight.use();
    p.v4('uFFRect', r[0], r[1], r[2], 0);
    var list = cm.drawList, G0 = cm.grid;
    var x0 = r[0], z0 = r[1], x1 = r[0] + r[2], z1 = r[1] + r[2];
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (!n.vbo) continue;
      var nx = n.ox - origin[0], nz = n.oz - origin[1];
      if (nx > x1 || nz > z1 || nx + n.size < x0 || nz + n.size < z0) continue;
      var dx = n.size / G0, s = 1;
      while (s < 16 && dx * s * 2 <= TEXEL) s *= 2;
      var ib = this._ibo(G0, s);
      p.v3('uNodeOffset', nx, 0, nz);
      gl.bindVertexArray(n.vbo.vao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib.buf);
      gl.drawElements(gl.TRIANGLES, ib.count, gl.UNSIGNED_SHORT, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, cm.ibo);   // the VAO owns its index binding: restore it
      G.stats.drawCalls++;
    }
    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
    // restore the renderer's depth convention
    if (G.caps.reversedZ) { gl.clearDepth(0); gl.depthFunc(gl.GEQUAL); } else { gl.clearDepth(1); gl.depthFunc(gl.LEQUAL); }
  };

  P._renderLight = function (frame, shadow, sky) {
    var gl = this.gl, G = this.G;
    var r = this.rect(frame.origin);
    G.bindFB(this.lFB, N, N);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    if (shadow) {
      gl.colorMask(true, true, false, false);
      var L = frame.env.lightDir;
      this.pShadow.use().tex('uH', 0, this.hTex).v4('uFFRect', r[0], r[1], r[2], 0).v3('uL', L[0], L[1], L[2]).f('uTexel', TEXEL);
      G.drawFullscreen();
    }
    if (sky) {
      gl.colorMask(false, false, true, false);
      this.pSky.use().tex('uH', 0, this.hTex).v4('uFFRect', r[0], r[1], r[2], 0).f('uTexel', TEXEL);
      G.drawFullscreen();
    }
    gl.colorMask(true, true, true, true);
  };

  /** Bind the light texture + rectangle on a program that includes <farfield>. */
  P.bind = function (prog, unit, frame) {
    var on = this.enabled(frame.settings);
    prog.tex('uFFTex', unit, on ? this.lTex : this.R.tex.black);
    if (on) { var r = this.rect(frame.origin); prog.v4('uFF', r[0], r[1], r[2], 1); }
    else prog.v4('uFF', 0, 0, 1, 0);
    return on;
  };
  /** Additionally bind height & albedo for <farfieldTrace>. */
  P.bindTrace = function (prog, unitH, unitA, frame) {
    var on = this.enabled(frame.settings);
    prog.tex('uFFH', unitH, on ? this.hTex : this.R.tex.black).tex('uFFA', unitA, on ? this.aTex : this.R.tex.black);
  };

  TERRA.gfx.FarField = FarField;
})();
