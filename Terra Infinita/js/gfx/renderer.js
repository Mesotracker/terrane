/* =============================================================================
 * TERRA INFINITA — renderer: render targets, per-frame uniforms, pass ordering
 *
 *   shadows → G-buffer (terrain, vegetation, structures) → clouds → SSAO/GI →
 *   deferred lighting (+SSR, contact shadows, fog, sky) → water → particles →
 *   TAA → particles → volumetric light → bloom → exposure → DOF → composite/grade →
 *   FXAA or (after TAA) contrast-adaptive sharpening
 * ========================================================================== */
(function () {
  'use strict';
  var M = TERRA.math, U = TERRA.util, S = TERRA.shaders;

  function Renderer(engine, canvas) {
    this.engine = engine;
    var G = this.G = new TERRA.gfx.GL(canvas);
    var gl = this.gl = G.gl;
    this.canvas = canvas;
    this.ubo = gl.createBuffer();
    this.uboData = new Float32Array(192);
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
    gl.bufferData(gl.UNIFORM_BUFFER, this.uboData.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.ubo);
    this.tex = {};
    this.targets = null;
    this.dynScale = 1;
    this.frameIndex = 0;
    this.prevViewProj = M.mat4();
    this._makeUtilityTextures();
  }
  var P = Renderer.prototype;

  P._makeUtilityTextures = function () {
    var G = this.G, gl = this.gl;
    this.tex.black = G.texture2D(1, 1, { data: new Uint8Array([0, 0, 0, 0]), immutable: false });
    this.tex.white = G.texture2D(1, 1, { data: new Uint8Array([255, 255, 255, 255]), immutable: false });
    var cube = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, cube);
    for (var f = 0; f < 6; f++) gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([10, 12, 16, 255]));
    this.tex.blackCube = cube;
    this.tex.dummyShadow = G.textureArray(1, 1, 1, { internal: gl.DEPTH_COMPONENT32F, compare: gl.LEQUAL, filter: gl.NEAREST });
  };

  /** Create subsystems once textures are available. */
  P.initSystems = function (texgen) {
    this.tex.matAlbedo = texgen.materials.albedoH;
    this.tex.matNormal = texgen.materials.normalR;
    this.tex.noise = texgen.noise;
    this.tex.cloudNoise = texgen.cloudNoise;
    this.tex.foliage = texgen.foliage.color;
    this.tex.foliageN = texgen.foliage.normal;
    this.sky = new TERRA.gfx.Sky(this);
    this.shadows = new TERRA.gfx.Shadows(this);
    this.terrain = new TERRA.gfx.TerrainRenderer(this);
    this.water = new TERRA.world.Water(this);
    this.particles = new TERRA.env.Particles(this);
    this.post = new TERRA.gfx.PostFX(this);
    this.probe = new TERRA.gfx.Probe(this);
    try { this.pt = new TERRA.gfx.PathTracer(this); } catch (e) { U.warn('Path tracer unavailable', e); this.pt = null; }
    try { this.ff = new TERRA.gfx.FarField(this); } catch (e) { U.warn('Far-field terrain light unavailable', e); this.ff = null; }
    try { this.hiz = new TERRA.gfx.HiZ(this); if (!this.hiz.ok) this.hiz = null; } catch (e) { U.warn('Occlusion culling unavailable', e); this.hiz = null; }
    try { this.frameGen = new TERRA.gfx.FrameGen(this); } catch (e) { U.warn('Frame extrapolation unavailable', e); this.frameGen = null; }
    this.applySettings(this.engine.settings.graphics);
  };

  P.applySettings = function (g) {
    this.shadows.configure(g.shadowQuality);
    this.sky.setCloudQuality(g.cloudQuality);
    this.targets = null; // rebuild on next frame (resolution may change)
  };

  /* ---------------- render targets ---------------- */
  P._targetsFor = function (w, h) {
    var T = this.targets;
    if (T && T.w === w && T.h === h) return T;
    var G = this.G, gl = this.gl;
    if (T) this._destroyTargets(T);
    var hf = G.hdrFormat;
    var nf = G.caps.colorFloat ? { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT } : { internal: gl.RGBA8 };
    T = { w: w, h: h, hw: Math.max(1, w >> 1), hh: Math.max(1, h >> 1), cur: 0, list: [] };
    function tex(tw, th, fmt, opts) { var t = G.texture2D(tw, th, Object.assign({ internal: fmt.internal, format: fmt.format, type: fmt.type }, opts || {})); T.list.push(t); return t; }
    T.gAlbedo = tex(w, h, { internal: gl.RGBA8 });
    T.gNormal = tex(w, h, nf, { filter: gl.NEAREST });
    T.gMaterial = tex(w, h, { internal: gl.RGBA8 }, { filter: gl.NEAREST });
    T.depth = G.texture2D(w, h, { internal: gl.DEPTH_COMPONENT32F, filter: gl.NEAREST }); T.list.push(T.depth);
    T.gbufferFB = G.framebuffer([T.gAlbedo, T.gNormal, T.gMaterial], T.depth);
    T.hdr = [tex(w, h, hf), tex(w, h, hf)];
    T.hdrFB = [G.framebuffer([T.hdr[0]]), G.framebuffer([T.hdr[1]])];
    T.sceneCopy = tex(w, h, hf);
    T.copyFB = G.framebuffer([T.sceneCopy]);
    T.ao = tex(T.hw, T.hh, hf); T.aoTmp = tex(T.hw, T.hh, hf);
    T.aoFB = G.framebuffer([T.ao]); T.aoTmpFB = G.framebuffer([T.aoTmp]);
    // clear AO to "unoccluded"
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.aoFB); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    T.vol = tex(T.hw, T.hh, hf); T.volFB = G.framebuffer([T.vol]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.volFB); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    T.dof = tex(T.hw, T.hh, hf); T.dofFB = G.framebuffer([T.dof]);
    T.bloom = [];
    var bw = T.hw, bh = T.hh;
    for (var i = 0; i < 6; i++) {
      var bt = tex(bw, bh, hf);
      T.bloom.push({ tex: bt, fb: G.framebuffer([bt]), w: bw, h: bh });
      bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
    }
    T.lum = G.texture2D(256, 256, { internal: hf.internal, format: hf.format, type: hf.type, mips: true }); T.list.push(T.lum);
    T.lumFB = G.framebuffer([T.lum]);
    T.exp = [tex(1, 1, hf, { filter: gl.NEAREST }), tex(1, 1, hf, { filter: gl.NEAREST })];
    T.expFB = [G.framebuffer([T.exp[0]]), G.framebuffer([T.exp[1]])];
    T.expFB.forEach(function (fb) { gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); });
    // TAA history (ping-pong)
    T.taa = [tex(w, h, hf), tex(w, h, hf)];
    T.taaFB = [G.framebuffer([T.taa[0]]), G.framebuffer([T.taa[1]])];
    T.taaIdx = 0; T.taaValid = false;
    T.ldr = tex(w, h, { internal: gl.RGBA8 });
    T.ldrFB = G.framebuffer([T.ldr]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.targets = T;
    if (this.post) this.post.resetExposure = true;
    this.sky.resize(w, h);
    return T;
  };
  P._destroyTargets = function (T) {
    var gl = this.gl;
    T.list.forEach(function (t) { gl.deleteTexture(t); });
    ['gbufferFB', 'copyFB', 'aoFB', 'aoTmpFB', 'volFB', 'dofFB', 'lumFB', 'ldrFB'].forEach(function (k) { if (T[k]) gl.deleteFramebuffer(T[k]); });
    T.hdrFB.forEach(function (f) { gl.deleteFramebuffer(f); });
    T.expFB.forEach(function (f) { gl.deleteFramebuffer(f); });
    if (T.taaFB) T.taaFB.forEach(function (f) { gl.deleteFramebuffer(f); });
    if (this.pt) this.pt.destroyTargets(T);
    if (T.motionFB) gl.deleteFramebuffer(T.motionFB);
    T.bloom.forEach(function (b) { gl.deleteFramebuffer(b.fb); });
  };

  P.resize = function () {
    var c = this.canvas;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.floor(c.clientWidth * dpr)), h = Math.max(1, Math.floor(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  };

  P.renderSize = function (g) {
    var c = this.canvas;
    var aa = (g.antiAliasing === 2 || g.antiAliasing >= 4) ? 1.25 : 1;
    var s = U.clamp((g.resolutionScale || 1) * aa * this.dynScale, 0.35, 2);
    return [Math.max(64, Math.round(c.width * s)), Math.max(64, Math.round(c.height * s))];
  };

  /* ---------------- per-frame uniform block ---------------- */
  P._updateUBO = function (frame) {
    var d = this.uboData, cam = frame.cam, env = frame.env, T = this.targets;
    d.set(cam.view, 0); d.set(cam.proj, 16); d.set(cam.viewProj, 32); d.set(cam.invViewProj, 48);
    d.set(this.prevViewProj, 64); d.set(cam.invView, 80); d.set(cam.invProj, 96);
    var o = 112;
    function v4(a, b, c, e) { d[o] = a; d[o + 1] = b; d[o + 2] = c; d[o + 3] = e; o += 4; }
    v4(cam.pos[0], cam.pos[1], cam.pos[2], frame.time);
    v4(env.lightDir[0], env.lightDir[1], env.lightDir[2], env.lightIntensity);
    v4(env.lightColor[0], env.lightColor[1], env.lightColor[2], env.dayFactor);
    v4(env.sunDir[0], env.sunDir[1], env.sunDir[2], env.sunDir[1]);
    v4(env.moonDir[0], env.moonDir[1], env.moonDir[2], env.moonPhase);
    v4(0, 0, 0, 1);
    v4(0, 0, 0, env.ambientScale);
    v4(env.groundColor[0], env.groundColor[1], env.groundColor[2], env.giStrength);
    v4(env.fogDensity, env.fogFalloff, env.fogBase, env.fogAmount);
    v4(env.fogTint[0], env.fogTint[1], env.fogTint[2], env.mie);
    v4(env.windDir[0], env.windDir[1], env.windStrength, env.gust);
    v4(env.wetness, env.puddles, env.snowCover, env.rain);
    v4(env.snow, env.cloudCover, env.storm, env.lightningFlash);
    v4(T.w, T.h, 1 / T.w, 1 / T.h);
    v4(cam.near, cam.far, env.season, this.frameIndex);
    var ox = frame.originWorld[0] % 65536, oz = frame.originWorld[1] % 65536;
    v4(ox < 0 ? ox + 65536 : ox, 0, oz < 0 ? oz + 65536 : oz, env.seaLevel);
    v4(frame.player.pos[0], frame.player.pos[1], frame.player.pos[2], frame.player.speed);
    v4(frame.debugView, frame.settings.rtx ? 1 : 0, frame.settings.microDetail, frame.settings.pbrQuality >= 2 ? 1 : 0);
    v4(frame.trail.x, frame.trail.z, frame.trail.size, env.underwater ? 1 : 0);
    v4(env.tempAtCam, env.aurora, env.rainbow, env.cloudShadow);
    var gl = this.gl;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, d);
  };

  /* ---------------- frame ---------------- */
  P.render = function (frame) {
    var gl = this.gl, G = this.G, g = frame.settings;
    G.stats.drawCalls = 0; G.stats.triangles = 0;
    this.resize();
    var rs = this.renderSize(g);
    var T = this._targetsFor(rs[0], rs[1]);
    T.hdrPrev = T.hdr[1 - T.cur];
    this.frameIndex++;
    if (frame.timing) G.timerBegin();
    this._applyJitter(frame, g, T);
    this._updateUBO(frame);
    gl.disable(gl.CULL_FACE);

    // Environment lookups
    this.sky.update(frame);
    // Shadows
    var self = this;
    this.shadows.update(frame);
    this.shadows.render(frame, function (c, vp, planes) {
      self.terrain.drawShadow(frame, vp, planes, c);
      if (self.engine.vegetation) self.engine.vegetation.drawShadow(frame, vp, planes, c);
      if (self.engine.throwables && c <= 1) self.engine.throwables.drawShadow(frame, vp);
      if (frame.drawAvatar) frame.drawAvatar(true, vp);
      if (frame.drawExtras && c <= 2) frame.drawExtras(true, vp);
    });
    // Distant terrain light: mountain shadows beyond the cascades, valley sky occlusion
    if (this.ff) { try { this.ff.update(frame); } catch (e) { U.warn('far-field update failed', e); this.ff = null; } }
    // Interaction trail map & reflection probe
    if (this.engine.interaction) this.engine.interaction.render(frame);
    this.trailTex = this.engine.interaction ? this.engine.interaction.texture() : null;
    // interactive water ripples
    if (this.engine.watersim) this.engine.watersim.update(frame);
    // vegetation wind physics
    var ws = this.engine.windsim;
    if (ws && ws.ok) { ws.update(frame); this.windTex = ws.texture(); this.windArea = ws.area; } else { this.windTex = null; }
    var probeOn = g.rtx ? g.reflectionProbes : g.reflectionQuality >= 3;
    if (probeOn) this.probe.update(frame);

    // G-buffer
    G.bindFB(T.gbufferFB, T.w, T.h);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
    if (G.caps.reversedZ) { gl.clearDepth(0); gl.depthFunc(gl.GEQUAL); }
    else { gl.clearDepth(1); gl.depthFunc(gl.LEQUAL); }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.BLEND);
    this.terrain.drawGBuffer(frame);
    if (this.engine.vegetation) this.engine.vegetation.drawGBuffer(frame);
    if (this.engine.throwables) this.engine.throwables.drawGBuffer(frame);
    if (frame.drawAvatar) frame.drawAvatar(false);
    if (frame.drawExtras) frame.drawExtras(false);
    gl.disable(gl.DEPTH_TEST);
    // occlusion pyramid for next frame's culling
    if (this.hiz) { try { this.hiz.build(frame); } catch (e) { U.warn('occlusion pyramid failed', e); this.hiz = null; } }
    // motion buffer of moving objects (frame extrapolation)
    this._motionDrawn = false;
    var fg = this.frameGen;
    if (fg && fg.ok && fg.mult > 1 && frame.drawMotion) {
      fg.ensureTargets(T);
      G.bindFB(T.motionFB, T.w, T.h);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST); gl.depthMask(false);
      gl.depthFunc(G.caps.reversedZ ? gl.GEQUAL : gl.LEQUAL);
      frame.drawMotion();
      gl.depthMask(true); gl.disable(gl.DEPTH_TEST);
      this._motionDrawn = true;
    }

    // Simulated path tracing (diffuse GI + glossy reflections), replaces SSAO/SSR when active
    this.ptActive = false;
    if (this.pt) { try { this.ptActive = this.pt.run(frame); } catch (e) { U.warn('path tracing failed', e); this.pt = null; } }
    // Screen-space passes
    this.sky.renderClouds(frame);
    this.post.ssao(frame);
    this.post.lighting(frame);
    this.post.copyScene();
    G.bindFB(T.hdrFB[T.cur], T.w, T.h);
    this.water.draw(frame);
    this.post.taa(frame);          // temporal resolve (particles stay out of the history)
    G.bindFB(T.hdrFB[T.cur], T.w, T.h);
    this.particles.draw(frame);
    this.post.volumetric(frame);
    this.post.bloom(frame);
    this.post.exposure(frame);
    this.post.dof(frame);
    this.post.composite(frame);
    if (frame.timing) G.timerEnd();
    // Screenshot request (must read before the browser presents the frame)
    if (this._shot) { var cb = this._shot; this._shot = null; try { cb(this.canvas.toDataURL('image/png')); } catch (e) { cb(null); } }
    M.copy(this.prevViewProj, frame.cam.viewProj);
    M.copy(this.prevVPUnjit, this.curVPUnjit);
    this._restoreJitter(frame.cam);
    if (this.frameGen) this.frameGen.afterReal(frame);
    T.cur = 1 - T.cur;
  };

  /* ---------------- TAA sub-pixel jitter ---------------- */
  function halton(i, b) { var f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; }
  function jitterMat(m, ox, oy) { for (var c = 0; c < 4; c++) { m[c * 4] += ox * m[c * 4 + 3]; m[c * 4 + 1] += oy * m[c * 4 + 3]; } }
  P._applyJitter = function (frame, g, T) {
    var cam = frame.cam;
    if (!this.curVPUnjit) { this.curVPUnjit = M.mat4(); this.prevVPUnjit = M.mat4(); this._jSave = [M.mat4(), M.mat4(), M.mat4(), M.mat4()]; }
    M.copy(this.curVPUnjit, cam.viewProj);
    this.taaOn = (g.antiAliasing | 0) >= 3;
    // history is invalid after a floating-origin shift, a teleport or a camera cut
    var w = cam.world, lw = this._lastCam;
    this.taaReset = !lw || frame.originKey !== this._lastOriginKey || Math.abs(w[0] - lw[0]) + Math.abs(w[1] - lw[1]) + Math.abs(w[2] - lw[2]) > 40;
    this._lastCam = w.slice(); this._lastOriginKey = frame.originKey;
    this._jittered = false;
    if (!this.taaOn) return;
    var S = this._jSave;
    M.copy(S[0], cam.proj); M.copy(S[1], cam.viewProj); M.copy(S[2], cam.invViewProj); M.copy(S[3], cam.invProj);
    var k = (this.frameIndex % 8) + 1;
    var jx = (halton(k, 2) - 0.5) * 2 / T.w, jy = (halton(k, 3) - 0.5) * 2 / T.h;
    jitterMat(cam.proj, jx, jy); jitterMat(cam.viewProj, jx, jy);
    M.invert(cam.invViewProj, cam.viewProj); M.invert(cam.invProj, cam.proj);
    this._jittered = true;
  };
  P._restoreJitter = function (cam) {
    if (!this._jittered) return;
    var S = this._jSave;
    M.copy(cam.proj, S[0]); M.copy(cam.viewProj, S[1]); M.copy(cam.invViewProj, S[2]); M.copy(cam.invProj, S[3]);
    this._jittered = false;
  };

  P.screenshot = function (cb) { this._shot = cb; };

  TERRA.gfx.Renderer = Renderer;
})();
