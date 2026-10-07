/* =============================================================================
 * TERRA INFINITA — hierarchical-Z occlusion culling
 * -----------------------------------------------------------------------------
 * After the G-buffer pass the depth buffer is reduced into a max-depth (farthest)
 * pyramid of *linear* view depth: level 0 = 4×4 blocks, each further level 2×2.
 * During the next frame, instanced vegetation (impostors and tree meshes) tests
 * its bounding sphere against the pyramid in the vertex shader, projected with the
 * previous frame's camera: a tree hidden behind a ridge, a hill or a building is
 * dropped before rasterisation (no fragment shading, no overdraw). Objects that
 * were off screen last frame are always kept, and the test is disabled for one
 * frame after teleports/origin shifts, so nothing pops out of view.
 * ========================================================================== */
(function () {
  'use strict';
  var S = TERRA.shaders, U = TERRA.util;

  S.hizFirstFS = [
    '#include <frame>',
    '#include <common>',
    'out vec4 o; uniform sampler2D uDepth;',
    'void main(){',
    '  ivec2 sz = textureSize(uDepth, 0); ivec2 b = ivec2(gl_FragCoord.xy) * 4;',
    '  float m = 0.0;',
    '  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {',
    '    float d = texelFetch(uDepth, min(b + ivec2(i, j), sz - 1), 0).r;',
    '    m = max(m, isSkyDepth(d) ? 1e7 : linearDepth(d));',
    '  }',
    '  o = vec4(m, 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');
  S.hizDownFS = [
    'out vec4 o; uniform highp sampler2D uSrc; uniform int uLevel;',
    'void main(){',
    '  ivec2 sz = textureSize(uSrc, uLevel); ivec2 b = ivec2(gl_FragCoord.xy) * 2;',
    '  float m = 0.0;',
    '  // 3×3 so odd-sized levels stay conservative',
    '  for (int j = 0; j < 3; j++) for (int i = 0; i < 3; i++) m = max(m, texelFetch(uSrc, min(b + ivec2(i, j), sz - 1), uLevel).r);',
    '  o = vec4(m, 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  /* Shared GLSL used by vertex shaders that cull against the pyramid. */
  S.lib.hiz = [
    'uniform highp sampler2D uHiZ; uniform vec4 uHiZInfo;   // x enabled, y levels, z min distance',
    '/* true when a bounding sphere (render space) was fully behind last frame\'s depth */',
    'bool hizHidden(vec3 c, float rad){',
    '  if (uHiZInfo.x < 0.5) return false;',
    '  vec4 pc = uPrevViewProj * vec4(c, 1.0);',
    '  if (pc.w < rad * 2.0 + uHiZInfo.z) return false;',
    '  vec2 uv = pc.xy / pc.w * 0.5 + 0.5;',
    '  float ry = rad * uProj[1][1] * 0.5 / pc.w, rx = ry * uScreen.y / uScreen.x;',
    '  vec2 lo = uv - vec2(rx, ry), hi = uv + vec2(rx, ry);',
    '  if (any(lessThan(lo, vec2(0.0))) || any(greaterThan(hi, vec2(1.0)))) return false;',
    '  vec2 s0 = vec2(textureSize(uHiZ, 0));',
    '  float span = max((hi.x - lo.x) * s0.x, (hi.y - lo.y) * s0.y);',
    '  int lv = int(clamp(ceil(log2(max(span, 1.0))), 0.0, uHiZInfo.y - 1.0));',
    '  ivec2 s = textureSize(uHiZ, lv);',
    '  ivec2 a = clamp(ivec2(lo * vec2(s)), ivec2(0), s - 1), b = clamp(ivec2(hi * vec2(s)), ivec2(0), s - 1);',
    '  float zf = max(max(texelFetch(uHiZ, a, lv).r, texelFetch(uHiZ, ivec2(b.x, a.y), lv).r), max(texelFetch(uHiZ, ivec2(a.x, b.y), lv).r, texelFetch(uHiZ, b, lv).r));',
    '  return pc.w - rad > zf * 1.015 + 1.5;',
    '}'
  ].join('\n');

  var MAXL = 6;

  function HiZ(R) {
    this.R = R; this.G = R.G; this.gl = R.G.gl;
    this.ok = !!R.G.caps.colorFloat;
    if (!this.ok) return;
    this.pFirst = this.G.program('hizFirst', S.fullscreenVS, S.hizFirstFS);
    this.pDown = this.G.program('hizDown', S.fullscreenVS, S.hizDownFS);
    this.valid = false; this.w = 0; this.h = 0;
  }
  var P = HiZ.prototype;

  P._ensure = function (T) {
    var w = Math.max(1, Math.ceil(T.w / 4)), h = Math.max(1, Math.ceil(T.h / 4));
    if (this.tex && this.w === w && this.h === h) return;
    var gl = this.gl, G = this.G;
    if (this.tex) { gl.deleteTexture(this.tex); this.fbs.forEach(function (f) { gl.deleteFramebuffer(f); }); }
    this.w = w; this.h = h;
    this.levels = Math.max(1, Math.min(MAXL, Math.floor(Math.log2(Math.min(w, h))) - 1));
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texStorage2D(gl.TEXTURE_2D, this.levels, gl.R32F, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, this.levels - 1);
    this.fbs = [];
    for (var l = 0; l < this.levels; l++) this.fbs.push(G.framebuffer([{ tex: this.tex, level: l }]));
    this.valid = false;
  };

  /** Build the pyramid from this frame's depth buffer (call after the G-buffer). */
  P.build = function (frame) {
    if (!this.ok || frame.settings.occlusionCulling === false) { this.valid = false; return; }
    var T = this.R.targets, gl = this.gl, G = this.G;
    this._ensure(T);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    var w = this.w, h = this.h;
    G.bindFB(this.fbs[0], w, h);
    this.pFirst.use().tex('uDepth', 0, T.depth);
    G.drawFullscreen();
    for (var l = 1; l < this.levels; l++) {
      var lw = Math.max(1, w >> l), lh = Math.max(1, h >> l);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, l - 1);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, l - 1);
      G.bindFB(this.fbs[l], lw, lh);
      this.pDown.use().tex('uSrc', 0, this.tex).i('uLevel', l - 1);
      G.drawFullscreen();
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, this.levels - 1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.valid = true;
  };

  /** Bind on a program that includes <hiz>; minDist skips the test for nearby instances. */
  /** Always binds a 2D texture to uHiZ (a sampler left on unit 0 would clash with the array
   *  textures there and invalidate the draw), with culling off when `off` or not ready. */
  P.bind = function (prog, unit, minDist, off) {
    var on = !off && this.ok && this.valid && !this.R.taaReset && !this.R.engine._hizSuspend;
    prog.tex('uHiZ', unit, on ? this.tex : this.R.tex.black);
    prog.v4('uHiZInfo', on ? 1 : 0, this.levels || 1, minDist || 0, 0);
  };

  /** Static helper for programs that include <hiz> when no pyramid exists. */
  HiZ.bindOff = function (R, prog, unit) {
    if (R.hiz) R.hiz.bind(prog, unit, 0, true);
    else prog.tex('uHiZ', unit, R.tex.black).v4('uHiZInfo', 0, 1, 0, 0);
  };
  TERRA.gfx.HiZ = HiZ;
})();
