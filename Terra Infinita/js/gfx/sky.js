/* =============================================================================
 * TERRA INFINITA — sky system: atmosphere LUT, ambient light, volumetric clouds
 * ========================================================================== */
(function () {
  'use strict';
  var S = TERRA.shaders, U = TERRA.util;

  function Sky(R) {
    this.R = R; this.G = R.G; var gl = this.gl = R.G.gl;
    var hf = R.G.hdrFormat;
    this.lutW = 192; this.lutH = 108;
    this.lut = this.G.texture2D(this.lutW, this.lutH, { internal: hf.internal, format: hf.format, type: hf.type, wrap: gl.CLAMP_TO_EDGE });
    // wrap azimuth
    gl.bindTexture(gl.TEXTURE_2D, this.lut); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    this.lutFB = this.G.framebuffer([this.lut]);
    this.amb = this.G.texture2D(4, 1, { internal: hf.internal, format: hf.format, type: hf.type, filter: gl.NEAREST });
    this.ambFB = this.G.framebuffer([this.amb]);
    this.progLut = this.G.program('skyLUT', S.fullscreenVS, S.skyLutFS);
    this.progAmb = this.G.program('skyAmbient', S.fullscreenVS, S.skyAmbientFS);
    this.progClouds = null;
    this.cloudTex = null; this.cloudFB = null;
    this.cloudOffset = [0, 0];
    this.frame = 0;
  }
  var P = Sky.prototype;

  P.setCloudQuality = function (q) {
    this.cloudQuality = q;
    if (q >= 1 && !this.progClouds) this.progClouds = this.G.program('clouds', S.fullscreenVS, S.cloudsFS);
  };

  P.resize = function (w, h) {
    var gl = this.gl, hf = this.G.hdrFormat;
    var div = this.cloudQuality >= 3 ? 2 : (this.cloudQuality === 2 ? 3 : 4);
    var cw = Math.max(1, Math.ceil(w / div)), ch = Math.max(1, Math.ceil(h / div));
    if (this.cloudTex && this.cloudTex.w === cw && this.cloudTex.h === ch) return;
    if (this.cloudTex) { gl.deleteTexture(this.cloudTex); gl.deleteFramebuffer(this.cloudFB); }
    this.cloudTex = this.G.texture2D(cw, ch, { internal: hf.internal, format: hf.format, type: hf.type });
    this.cloudFB = this.G.framebuffer([this.cloudTex]);
  };

  P.bindAtmo = function (prog, unit) {
    var gl = this.gl;
    prog.tex('uSkyLUT', unit, this.lut).tex('uAmbientTex', unit + 1, this.amb);
  };
  P.bindCloudCommon = function (prog, unit, env) {
    var gl = this.gl;
    prog.tex('uNoiseTex2', unit, this.R.tex.noise);
    prog.v4('uCloudParams', env.cloudCover, env.cloudBase, env.cloudThickness, env.cloudDensity);
    prog.v2('uCloudOffset', this.cloudOffset[0], this.cloudOffset[1]);
    prog.tex('uCloudTex', unit + 1, this.cloudTex || this.R.tex.black);
    prog.i('uCloudMode', this.cloudQuality >= 1 ? 1 : 0);
  };

  /** Atmosphere parameters that depend on weather. */
  P.haze = function (env) { return 0.1 + env.fogAmount * 5 + env.dust * 10 + env.humidity * 0.35; };

  P.update = function (frame) {
    var gl = this.gl, env = frame.env;
    // advect clouds with high-altitude wind
    var ws = 6 + env.windStrength * 28;
    this.cloudOffset[0] -= env.windDir[0] * ws * frame.dt;
    this.cloudOffset[1] -= env.windDir[1] * ws * frame.dt;
    // keep the offset bounded (period of the cloud lookups is 65536 m)
    this.cloudOffset[0] %= 65536; this.cloudOffset[1] %= 65536;
    this.frame++;
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    var camAlt = Math.max(0, frame.cam.world[1]);
    var dust = env.dust;
    var tint = [1 + dust * 0.2, 1 + dust * 0.6, 1 + dust * 1.6];
    // Sky LUT (cheap: 192×108)
    this.G.bindFB(this.lutFB, this.lutW, this.lutH);
    this.progLut.use().f('uCamAlt', camAlt).f('uSunI', env.sunI).f('uMoonI', env.moonI).f('uHaze', this.haze(env)).v3('uDustTint', tint[0], tint[1], tint[2]);
    this.G.drawFullscreen();
    // Ambient integration
    this.G.bindFB(this.ambFB, 4, 1);
    this.progAmb.use().f('uCamAlt', camAlt).f('uCloud', env.cloudCover).f('uStorm', env.storm).f('uSunI', env.sunI).f('uMoonI', env.moonI)
      .f('uHaze', this.haze(env)).v3('uDustTint', tint[0], tint[1], tint[2]).tex('uSkyLUT', 0, this.lut);
    this.G.drawFullscreen();
  };

  P.renderClouds = function (frame) {
    if (this.cloudQuality < 1 || !this.progClouds) return;
    var gl = this.gl, env = frame.env;
    this.G.bindFB(this.cloudFB, this.cloudTex.w, this.cloudTex.h);
    var steps = [0, 24, 40, 64][this.cloudQuality], lsteps = [0, 3, 4, 6][this.cloudQuality];
    if (frame.performance) { steps = Math.min(steps, 24); lsteps = 3; }
    var p = this.progClouds.use();
    this.bindAtmo(p, 0);
    p.tex('uNoiseTex2', 2, this.R.tex.noise);
    p.v4('uCloudParams', env.cloudCover, env.cloudBase, env.cloudThickness, env.cloudDensity);
    p.v2('uCloudOffset', this.cloudOffset[0], this.cloudOffset[1]);
    p.tex('uCloudNoise', 3, this.R.tex.cloudNoise, gl.TEXTURE_3D);
    p.tex('uDepth', 4, this.R.targets.depth);
    p.i('uSteps', steps).i('uLightSteps', lsteps);
    this.G.drawFullscreen();
  };

  TERRA.gfx.Sky = Sky;
})();
