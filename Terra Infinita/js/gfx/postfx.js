/* =============================================================================
 * TERRA INFINITA — screen-space effects & post-processing
 * SSAO/GI, deferred lighting, volumetric light, bloom, auto-exposure, DOF,
 * motion blur, colour grading, temporal AA, FXAA / sharpening.
 * ========================================================================== */
(function () {
  'use strict';
  var S = TERRA.shaders, U = TERRA.util;

  function PostFX(R) {
    this.R = R; this.G = R.G; this.gl = R.G.gl;
    var G = this.G;
    this.pSSAO = G.program('ssao', S.fullscreenVS, S.ssaoFS);
    this.pBilat = G.program('bilateral', S.fullscreenVS, S.bilateralFS);
    this.pLight = G.program('lighting', S.fullscreenVS, S.lightingFS);
    this.pVol = G.program('volumetric', S.fullscreenVS, S.volumetricFS);
    this.pDown = G.program('bloomDown', S.fullscreenVS, S.bloomDownFS);
    this.pUp = G.program('bloomUp', S.fullscreenVS, S.bloomUpFS);
    this.pLum = G.program('lum', S.fullscreenVS, S.lumFS);
    this.pAdapt = G.program('adapt', S.fullscreenVS, S.adaptFS);
    this.pDof = G.program('dof', S.fullscreenVS, S.dofFS);
    this.pComp = G.program('composite', S.fullscreenVS, S.compositeFS);
    this.pFxaa = G.program('fxaa', S.fullscreenVS, S.fxaaFS);
    this.pTaa = G.program('taa', S.fullscreenVS, S.taaFS);
    this.pCopy = G.program('copy', S.fullscreenVS, S.copyFS);
    this.expIdx = 0;
    this.resetExposure = true;
    this.lightArr = new Float32Array(32); this.lightColArr = new Float32Array(32);
  }
  var P = PostFX.prototype;

  P.ssao = function (frame) {
    var T = this.R.targets, gl = this.gl, g = frame.settings;
    var gi = g.rtx && g.rtxGI;
    if (this.R.ptActive) return;                 // path tracing supplies occlusion and GI
    if (!(g.ambientOcclusion > 0 || gi)) return;
    this.G.bindFB(T.aoFB, T.hw, T.hh);
    var p = this.pSSAO.use();
    p.tex('uDepth', 0, T.depth).tex('uGNormal', 1, T.gNormal).tex('uPrevHDR', 2, T.hdrPrev);
    p.i('uSamples', gi ? 12 : (g.ambientOcclusion >= 2 ? 10 : 6)).i('uGI', gi ? 1 : 0).f('uIntensity', 1.0);
    this.G.drawFullscreen();
    // depth-aware blur (H then V)
    var b = this.pBilat;
    this.G.bindFB(T.aoTmpFB, T.hw, T.hh);
    b.use().tex('uSrc', 0, T.ao).tex('uDepth', 1, T.depth).v2('uDir', 1 / T.hw, 0);
    this.G.drawFullscreen();
    this.G.bindFB(T.aoFB, T.hw, T.hh);
    b.use().tex('uSrc', 0, T.aoTmp).tex('uDepth', 1, T.depth).v2('uDir', 0, 1 / T.hh);
    this.G.drawFullscreen();
  };

  P.lighting = function (frame) {
    var T = this.R.targets, gl = this.gl, g = frame.settings, R = this.R;
    this.G.bindFB(T.hdrFB[T.cur], T.w, T.h);
    var p = this.pLight.use();
    p.tex('uGAlbedo', 0, T.gAlbedo).tex('uGNormal', 1, T.gNormal).tex('uGMaterial', 2, T.gMaterial).tex('uDepth', 3, T.depth)
     .tex('uAOTex', 4, T.ao).tex('uPrevHDR', 5, T.hdrPrev);
    R.sky.bindAtmo(p, 6);
    R.sky.bindCloudCommon(p, 8, frame.env);
    R.shadows.bind(p, 10);
    var probeOn = !!(R.probe && R.probe.ready && (g.rtx ? g.reflectionProbes : g.reflectionQuality >= 3));
    p.tex('uProbe', 11, probeOn ? R.probe.cube : R.tex.blackCube, gl.TEXTURE_CUBE_MAP);
    var ssr = g.rtx && g.rtxReflections ? 2 : (g.reflectionQuality >= 2 ? 2 : (g.reflectionQuality === 1 ? 1 : 0));
    if (frame.performance) ssr = Math.min(ssr, 1);
    var pt = R.ptActive && R.pt;
    if (pt) ssr = 0;
    p.v4('uFeatures', ssr, !pt && g.rtx && g.rtxGI ? 1 : 0, g.rtx && g.rtxContactShadows ? 1 : (g.shadowQuality >= 4 ? 1 : 0), probeOn ? 1 : 0);
    p.v4('uFeatures2', !pt && (g.ambientOcclusion > 0 || (g.rtx && g.rtxGI)) ? 1 : 0, g.rtx && g.rtxSoftShadows ? 1 : 0, 1, 0);
    p.tex('uPTDiff', 12, pt ? R.pt.outD : R.tex.black).tex('uPTSpec', 13, pt ? R.pt.outS : R.tex.black);
    var veg = R.engine.vegetation, hOn = !!(veg && veg.fieldCenter && veg.heightTex);
    var rts = !!g.rtShadows && R.shadows.enabled;
    p.tex('uHFTex', 14, hOn ? veg.heightTex : R.tex.black);
    if (hOn) { var fo = veg.fieldOriginLinear(frame.origin); p.v4('uHField', fo[0], fo[1], veg.FIELD, 1); } else p.v4('uHField', 0, 0, 1, 0);
    p.v4('uPT', pt ? 1 : 0, rts ? 1 : 0, 0, 0);
    if (R.ff) R.ff.bind(p, 15, frame); else p.tex('uFFTex', 15, R.tex.black).v4('uFF', 0, 0, 1, 0);
    // point lights
    var lights = ((R.engine.vegetation && R.engine.vegetation.lights) || []).slice(0, 8);
    // transient effect lights (explosions, fires) and vehicle lamps, render space
    var extra = [];
    var fx = R.engine.effects, o = frame.origin;
    if (fx) for (var e = 0; e < fx.lights.length; e++) {
      var FL = fx.lights[e], k = 1 - FL.age / FL.life;
      extra.push({ pos: [FL.pos[0] - o[0], FL.pos[1], FL.pos[2] - o[1]], radius: FL.radius, color: [FL.color[0] * k, FL.color[1] * k, FL.color[2] * k] });
    }
    if (R.engine.vehicles && R.engine.vehicles.lights) extra = extra.concat(R.engine.vehicles.lights(frame));
    if (extra.length) lights = extra.concat(lights);
    var n = Math.min(8, lights.length);
    for (var i = 0; i < n; i++) {
      var L = lights[i];
      this.lightArr.set([L.pos[0], L.pos[1], L.pos[2], L.radius], i * 4);
      this.lightColArr.set([L.color[0], L.color[1], L.color[2], 0], i * 4);
    }
    gl.uniform4fv(p.loc('uLightPos[0]'), this.lightArr); gl.uniform4fv(p.loc('uLightCol[0]'), this.lightColArr);
    p.i('uNumLights', n);
    var fl = frame.flashlight;
    p.v4('uFlash', fl.dir[0], fl.dir[1], fl.dir[2], fl.on ? 9 : 0);
    this.G.drawFullscreen();
  };

  P.copyScene = function () {
    var T = this.R.targets, gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, T.hdrFB[T.cur]);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, T.copyFB);
    gl.blitFramebuffer(0, 0, T.w, T.h, 0, 0, T.w, T.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  };

  /** Temporal AA resolve into history, then copied back into the scene buffer. */
  P.taa = function (frame) {
    var R = this.R, T = R.targets, gl = this.gl;
    if (!R.taaOn) { T.taaValid = false; return; }
    var dst = 1 - T.taaIdx;
    this.G.bindFB(T.taaFB[dst], T.w, T.h);
    var p = this.pTaa.use();
    p.tex('uCur', 0, T.hdr[T.cur]).tex('uHist', 1, T.taa[T.taaIdx]).tex('uDepth', 2, T.depth).tex('uExposure', 3, T.exp[this.expIdx]);
    p.m4('uCurVP', R.curVPUnjit).m4('uPrevVP', R.prevVPUnjit).f('uReset', (T.taaValid && !R.taaReset) ? 0 : 1).v2('uTexel', 1 / T.w, 1 / T.h);
    this.G.drawFullscreen();
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, T.taaFB[dst]);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, T.hdrFB[T.cur]);
    gl.blitFramebuffer(0, 0, T.w, T.h, 0, 0, T.w, T.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    T.taaIdx = dst; T.taaValid = true;
  };

  P.volumetric = function (frame) {
    var T = this.R.targets, g = frame.settings, R = this.R;
    // budget: no shafts when there is no direct light to scatter (night without moon, solid overcast)
    var on = g.volumetrics > 0 && g.godRays !== false && R.shadows.enabled && !frame.env.underwater &&
      (frame.env.lightIntensity === undefined || frame.env.lightIntensity > 0.02) && frame.env.cloudCover < 0.93;
    this.volOn = on;
    if (!on) return;
    this.G.bindFB(T.volFB, T.hw, T.hh);
    var p = this.pVol.use();
    R.sky.bindAtmo(p, 0);
    R.shadows.bind(p, 2);
    p.tex('uDepth', 3, T.depth).i('uSteps', g.volumetrics >= 2 ? 28 : 14).f('uMaxDist', g.volumetrics >= 2 ? 900 : 500).f('uStrength', 1.0);
    if (R.ff) R.ff.bind(p, 4, frame); else p.tex('uFFTex', 4, R.tex.black).v4('uFF', 0, 0, 1, 0);
    this.G.drawFullscreen();
  };

  P.bloom = function (frame) {
    var T = this.R.targets, gl = this.gl;
    if (!frame.settings.bloom) { this.bloomOn = false; return; }
    this.bloomOn = true;
    var mips = T.bloom;
    var src = T.hdr[T.cur], sw = T.w, sh = T.h;
    for (var i = 0; i < mips.length; i++) {
      var m = mips[i];
      this.G.bindFB(m.fb, m.w, m.h);
      this.pDown.use().tex('uSrc', 0, src).v2('uTexel', 1 / sw, 1 / sh).f('uThreshold', 1.2).i('uFirst', i === 0 ? 1 : 0);
      this.G.drawFullscreen();
      src = m.tex; sw = m.w; sh = m.h;
    }
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    for (i = mips.length - 1; i > 0; i--) {
      var dst = mips[i - 1];
      this.G.bindFB(dst.fb, dst.w, dst.h);
      this.pUp.use().tex('uSrc', 0, mips[i].tex).v2('uTexel', 1 / mips[i].w, 1 / mips[i].h).f('uRadius', 1.0);
      this.G.drawFullscreen();
    }
    gl.disable(gl.BLEND);
  };

  P.exposure = function (frame) {
    var T = this.R.targets, gl = this.gl;
    // log-luminance at 256² then mip down to 1×1
    this.G.bindFB(T.lumFB, 256, 256);
    this.pLum.use().tex('uSrc', 0, T.hdr[T.cur]);
    this.G.drawFullscreen();
    gl.bindTexture(gl.TEXTURE_2D, T.lum); gl.generateMipmap(gl.TEXTURE_2D);
    var next = 1 - this.expIdx;
    this.G.bindFB(T.expFB[next], 1, 1);
    this.pAdapt.use().tex('uLum', 0, T.lum).tex('uPrev', 1, T.exp[this.expIdx]).f('uDt', Math.min(frame.dt, 0.1))
      .f('uBias', frame.settings.exposure || 0).f('uLevel', 8).f('uReset', this.resetExposure ? 1 : 0);
    this.G.drawFullscreen();
    this.expIdx = next;
    this.resetExposure = false;
  };

  P.dof = function (frame) {
    var T = this.R.targets, g = frame.settings;
    this.dofOn = !!g.dof;
    if (!this.dofOn) return;
    this.G.bindFB(T.dofFB, T.hw, T.hh);
    this.pDof.use().tex('uSrc', 0, T.hdr[T.cur]).tex('uDepth', 1, T.depth).f('uFocus', frame.focusDist || 20).f('uAperture', 1.4);
    this.G.drawFullscreen();
  };

  P.composite = function (frame) {
    var T = this.R.targets, g = frame.settings, gl = this.gl;
    this.G.bindFB(T.ldrFB, T.w, T.h);
    var p = this.pComp.use();
    p.tex('uHDR', 0, T.hdr[T.cur]).tex('uBloom', 1, this.bloomOn ? T.bloom[0].tex : this.R.tex.black).tex('uExposure', 2, T.exp[this.expIdx])
     .tex('uVolTex', 3, T.vol).tex('uDepth', 4, T.depth).tex('uDof', 5, this.dofOn ? T.dof : this.R.tex.black);
    p.v4('uGrade', g.contrast || 1, (g.saturation === undefined ? 1 : g.saturation) * (1 - frame.env.storm * 0.15), g.temperature || 0, g.vignette || 0);
    p.v4('uGrade2', g.filmGrain || 0, this.bloomOn ? 0.05 : 0, g.motionBlur ? 0.6 : 0, this.dofOn ? 1 : 0);
    p.v4('uGrade3', this.volOn ? 1 : 0, frame.env.underwater ? 1 : 0, frame.flash || 0, frame.exposureMul || 1);
    p.i('uTonemap', g.tonemap === 'agx' ? 1 : 0);
    var wt = frame.env.waterTint || [0.1, 0.35, 0.4];
    p.v3('uWaterTint', wt[0], wt[1], wt[2]);
    this.G.drawFullscreen();
    // FXAA / upscale to the canvas
    var c = this.G.canvas;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, c.width, c.height);
    this.pFxaa.use().tex('uSrc', 0, T.ldr).v2('uTexel', 1 / T.w, 1 / T.h).i('uEnabled', g.antiAliasing >= 3 ? 2 : (g.antiAliasing > 0 ? 1 : 0));
    this.G.drawFullscreen();
  };

  TERRA.gfx.PostFX = PostFX;
})();
