/* =============================================================================
 * TERRA INFINITA — simulated path tracing driver
 * -----------------------------------------------------------------------------
 * Runs after the G-buffer, before deferred lighting:
 *   trace (half res, MRT: diffuse + specular) → temporal accumulation (MRT) →
 *   à-trous denoise (diffuse, 2–3 iterations).
 * The lighting pass then uses the traced irradiance in place of the sky/ground
 * ambient model and SSAO, and the traced glossy reflections in place of SSR.
 * Quality levels: 1 balanced (1 spp), 2 high (2 spp), 3 ultra (4 spp),
 *                 4 = 8 rays per pixel, 5 = 16 rays per pixel (stratified).
 * ========================================================================== */
(function () {
  'use strict';
  var S = TERRA.shaders;

  function PathTracer(R) {
    this.R = R; this.G = R.G; this.gl = R.G.gl;
    var G = this.G;
    this.ok = !!G.caps.colorFloat;
    if (!this.ok) return;
    this.pTrace = G.program('ptTrace', S.fullscreenVS, S.ptTraceFS);
    this.pTemporal = G.program('ptTemporal', S.fullscreenVS, S.ptTemporalFS);
    this.pAtrous = G.program('ptAtrous', S.fullscreenVS, S.ptAtrousFS);
    this.frameN = 0;
    this.active = false;
  }
  var P = PathTracer.prototype;

  P._ensure = function (T) {
    if (T.pt) return T.pt;
    var G = this.G, gl = this.gl, w = T.hw, h = T.hh;
    var f = { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT };
    function tex() { var t = G.texture2D(w, h, Object.assign({}, f)); T.list.push(t); return t; }
    var pt = { w: w, h: h };
    pt.rawD = tex(); pt.rawS = tex();
    pt.rawFB = G.framebuffer([pt.rawD, pt.rawS]);
    pt.histD = [tex(), tex()]; pt.histS = [tex(), tex()];
    pt.histFB = [G.framebuffer([pt.histD[0], pt.histS[0]]), G.framebuffer([pt.histD[1], pt.histS[1]])];
    pt.tmp = [tex(), tex()];
    pt.tmpFB = [G.framebuffer([pt.tmp[0]]), G.framebuffer([pt.tmp[1]])];
    pt.cur = 0; pt.valid = false;
    // clear history
    pt.histFB.forEach(function (fb) { gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    T.pt = pt;
    return pt;
  };
  P.destroyTargets = function (T) {
    if (!T.pt) return;
    var gl = this.gl, pt = T.pt;
    [pt.rawFB].concat(pt.histFB, pt.tmpFB).forEach(function (fb) { gl.deleteFramebuffer(fb); });
    T.pt = null;
  };

  /** Returns true when path-traced lighting is available this frame. */
  P.run = function (frame) {
    var g = frame.settings, R = this.R, T = R.targets, gl = this.gl, G = this.G;
    var q = g.pathTracing | 0;
    this.active = false;
    if (!this.ok || q <= 0) return false;
    var pt = this._ensure(T);
    this.frameN = (this.frameN + 1) % 4096;
    var env = frame.env;
    var veg = R.engine.vegetation;
    var hOn = !!(veg && veg.fieldCenter && veg.heightTex);
    var sunUp = Math.max(env.sunDir[1], 0);
    var gc = env.groundColor || [0.3, 0.28, 0.24], lc = env.lightColor || [1, 1, 1];
    var amb = (env.dayFactor || 0) * 0.06 + 0.004;
    var ground = [gc[0] * (lc[0] * sunUp * 0.3 + amb), gc[1] * (lc[1] * sunUp * 0.3 + amb), gc[2] * (lc[2] * sunUp * 0.3 + amb * 1.2)];
    q = Math.min(q, 5);
    var spp = [0, 1, 2, 4, 8, 16][q], steps = [0, 14, 18, 24, 22, 20][q], iters = [0, 2, 3, 3, 3, 2][q];
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);

    // ---- trace
    G.bindFB(pt.rawFB, pt.w, pt.h);
    var p = this.pTrace.use();
    p.tex('uDepth', 0, T.depth).tex('uGNormal', 1, T.gNormal).tex('uPrevHDR', 2, T.hdrPrev).tex('uExposure', 3, T.exp[R.post.expIdx])
     .tex('uHeightTex', 4, hOn ? veg.heightTex : R.tex.black).tex('uGMat', 7, T.gMaterial);
    R.sky.bindAtmo(p, 5);
    if (hOn) { var fo = veg.fieldOriginLinear(frame.origin); p.v4('uHField', fo[0], fo[1], veg.FIELD, 1); }
    else p.v4('uHField', 0, 0, 1, 0);
    p.i('uSPP', spp).i('uSteps', steps).f('uFrameN', this.frameN).v3('uGroundBounce', ground[0], ground[1], ground[2]);
    if (R.ff) { R.ff.bind(p, 8, frame); R.ff.bindTrace(p, 9, 10, frame); }
    else p.tex('uFFTex', 8, R.tex.black).tex('uFFH', 9, R.tex.black).tex('uFFA', 10, R.tex.black).v4('uFF', 0, 0, 1, 0);
    G.drawFullscreen();

    // ---- temporal accumulation
    var next = 1 - pt.cur;
    G.bindFB(pt.histFB[next], pt.w, pt.h);
    var reset = !pt.valid || R.taaReset;
    this.pTemporal.use().tex('uCurD', 0, pt.rawD).tex('uCurS', 1, pt.rawS).tex('uHistD', 2, pt.histD[pt.cur]).tex('uHistS', 3, pt.histS[pt.cur])
      .tex('uDepth', 4, T.depth).m4('uPrevVP', R.prevVPUnjit || frame.cam.viewProj).f('uReset', reset ? 1 : 0)
      .f('uMaxD', [0, 48, 48, 64, 40, 28][q]).f('uMaxS', [0, 12, 12, 12, 10, 8][q]);
    G.drawFullscreen();
    pt.cur = next; pt.valid = true;

    // ---- à-trous denoise (diffuse)
    var src = pt.histD[next];
    var a = this.pAtrous;
    for (var i = 0; i < iters; i++) {
      var dst = i % 2;
      G.bindFB(pt.tmpFB[dst], pt.w, pt.h);
      a.use().tex('uSrc', 0, src).tex('uDepth', 1, T.depth).tex('uGNormal', 2, T.gNormal).v2('uTexel', 1 / pt.w, 1 / pt.h).f('uStep', 1 << i);
      G.drawFullscreen();
      src = pt.tmp[dst];
    }
    this.outD = src; this.outS = pt.histS[next];
    this.active = true;
    return true;
  };

  TERRA.gfx.PathTracer = PathTracer;
})();
