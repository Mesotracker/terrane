/* =============================================================================
 * TERRA INFINITA — Frame Extrapolation (generated frames)
 * -----------------------------------------------------------------------------
 * Between two real (simulated + rendered) frames the engine can present extra
 * frames that are *generated* from the last real frame:
 *
 *   real A → generated → generated → real B …   (×3 shown)
 *
 * The simulation (input, player, camera, vehicles, physics) still runs on every
 * display refresh, so a generated frame knows the camera's actual new pose. Its
 * image is the last real frame re-projected into that pose:
 *   • every pixel's 3-D position comes from the real frame's depth buffer;
 *   • moving objects (vehicles, thrown bodies, the player avatar) wrote their
 *     world-space velocity into a motion buffer, so they are extrapolated along
 *     their own motion — a plane you chase stays sharp instead of juddering;
 *   • first-person tools are screen-locked (no extrapolation);
 *   • the backward warp is solved per pixel by fixed-point iteration (Bowles et
 *     al., "Iterative Image Warping"); pixels that were hidden in the real frame
 *     (disocclusions) are filled from the background side, never from the
 *     foreground object, which avoids ghosts and double images.
 * The HUD and menus are HTML on top of the canvas, so they are never warped.
 * Generated FPS is reported separately from the native render rate.
 * ========================================================================== */
(function () {
  'use strict';
  var S = TERRA.shaders, M = TERRA.math, U = TERRA.util;

  S.frameGenFS = [
    '#include <frame>',
    '#include <common>',
    'in vec2 vUv; out vec4 o;',
    'uniform sampler2D uColor; uniform sampler2D uDepth; uniform sampler2D uMotion;',
    'uniform mat4 uInvVPold; uniform mat4 uVPold; uniform mat4 uVPnew; uniform mat4 uInvVPnew;',
    'uniform vec3 uShift;      // old render space → new render space (floating origin)',
    'uniform float uDt;        // seconds since the real frame × motion sensitivity',
    'uniform int uIters; uniform float uArtifact;',
    'uniform vec4 uTex;        // xy texel size, z sharpen, w motion buffer present',
    '#ifdef REVERSED_Z',
    'float farNdc(){ return 1e-6; }',
    'float ndcZ(float d){ return max(d, 2e-6); }',
    'bool skyD(float d){ return d <= 0.0; }',
    '#else',
    'float farNdc(){ return 0.99999; }',
    'float ndcZ(float d){ return min(d, 0.99999) * 2.0 - 1.0; }',
    'bool skyD(float d){ return d >= 1.0; }',
    '#endif',
    'vec3 unprojOld(vec2 uv, float d){ vec4 p = uInvVPold * vec4(uv * 2.0 - 1.0, ndcZ(d), 1.0); return p.xyz / p.w + uShift; }',
    'vec2 projNew(vec3 p){ vec4 c = uVPnew * vec4(p, 1.0); return c.xy / max(c.w, 1e-4) * 0.5 + 0.5; }',
    '/* forward map: where does the real-frame pixel uvs land in the generated frame? */',
    'vec2 fwd(vec2 uvs){',
    '  float d = textureLod(uDepth, uvs, 0.0).r;',
    '  vec4 mo = uTex.w > 0.5 ? textureLod(uMotion, uvs, 0.0) : vec4(0.0);',
    '  if (mo.a > 1.5) return uvs;                      // screen-locked (held tools)',
    '  vec3 p = unprojOld(uvs, d);',
    '  if (mo.a > 0.5) p += mo.xyz * uDt;                // moving object: extrapolate its own motion',
    '  return projNew(p); }',
    'float depthAt(vec2 uv){ return textureLod(uDepth, uv, 0.0).r; }',
    '/* "farther" for either depth convention */',
    '#ifdef REVERSED_Z',
    'bool farther(float a, float b){ return a < b; }',
    '#else',
    'bool farther(float a, float b){ return a > b; }',
    '#endif',
    'vec3 colorAt(vec2 uv){',
    '  vec3 c = textureLod(uColor, uv, 0.0).rgb;',
    '  if (uTex.z > 0.0) {',
    '    vec3 n = textureLod(uColor, uv + vec2(uTex.x, 0.0), 0.0).rgb + textureLod(uColor, uv - vec2(uTex.x, 0.0), 0.0).rgb',
    '           + textureLod(uColor, uv + vec2(0.0, uTex.y), 0.0).rgb + textureLod(uColor, uv - vec2(0.0, uTex.y), 0.0).rgb;',
    '    c = clamp(c + (c - n * 0.25) * uTex.z, 0.0, 1.0);',
    '  }',
    '  return c; }',
    'void main(){',
    '  // initial guess: rotation-only re-projection (exact for the sky and distant terrain)',
    '  vec4 pf = uInvVPnew * vec4(vUv * 2.0 - 1.0, farNdc(), 1.0);',
    '  vec4 co = uVPold * vec4(pf.xyz / pf.w - uShift, 1.0);',
    '  vec2 uvs = co.w > 0.0 ? clamp(co.xy / co.w * 0.5 + 0.5, 0.0, 1.0) : vUv;',
    '  vec2 f = vUv;',
    '  for (int i = 0; i < 10; i++) {',
    '    if (i >= uIters) break;',
    '    f = fwd(uvs);',
    '    uvs = clamp(uvs + (vUv - f) * 0.92, vec2(0.0), vec2(1.0));',
    '  }',
    '  f = fwd(uvs);',
    '  vec2 px = 1.0 / uTex.xy;',
    '  float err = length((f - vUv) * px);',
    '  vec3 c;',
    '  if (err < 1.25) c = colorAt(uvs);',
    '  else {',
    '    // disocclusion: this pixel was hidden in the real frame. Take the background side',
    '    // (farthest depth among candidates along the motion), so foreground objects never smear.',
    '    vec2 dir = normalize((vUv - f) + 1e-6) * uTex.xy * 2.0;',
    '    vec2 best = uvs; float bd = depthAt(uvs);',
    '    for (int k = 1; k <= 6; k++) {',
    '      vec2 a = clamp(uvs + dir * float(k), 0.0, 1.0), b = clamp(uvs - dir * float(k), 0.0, 1.0);',
    '      float da = depthAt(a), db = depthAt(b);',
    '      if (farther(da, bd)) { bd = da; best = a; }',
    '      if (farther(db, bd)) { bd = db; best = b; }',
    '    }',
    '    c = colorAt(best);',
    '    // artifact reduction: soften the filled region slightly (it carries no new detail)',
    '    vec3 blur = (textureLod(uColor, best + uTex.xy * vec2(1.5, 0.5), 0.0).rgb + textureLod(uColor, best - uTex.xy * vec2(1.5, 0.5), 0.0).rgb',
    '               + textureLod(uColor, best + uTex.xy * vec2(-0.5, 1.5), 0.0).rgb + textureLod(uColor, best - uTex.xy * vec2(-0.5, 1.5), 0.0).rgb) * 0.25;',
    '    c = mix(c, blur, uArtifact * 0.6);',
    '  }',
    '  o = vec4(c, 1.0);',
    '}'
  ].join('\n');

  /* Motion-buffer pass for moving objects (world velocity, flag). */
  S.motionFS = [
    'in vec3 vVel; in float vFlag; out vec4 o;',
    'void main(){ o = vec4(vVel, vFlag); }'
  ].join('\n');

  function FrameGen(R) {
    this.R = R; this.G = R.G; this.gl = R.G.gl;
    this.ok = !!R.G.caps.colorFloat;
    this.mult = 0; this.active = false; this.phase = 0;
    this.valid = false;
    this.vpOld = M.mat4(); this.invVPold = M.mat4(); this.invVPnew = M.mat4();
    this.originOld = [0, 0]; this.timeOld = 0;
    this.genCount = 0;
    if (!this.ok) return;
    this.prog = this.G.program('frameGen', S.fullscreenVS, S.frameGenFS);
  }
  var P = FrameGen.prototype;

  P.configure = function (g) {
    var m = +g.frameGen || 0;
    this.mult = m > 1 ? m : 0;
    if (!this.mult) { this.active = false; this.valid = false; }
  };

  /** Motion buffer (shares the G-buffer depth so only visible pixels of moving objects write). */
  P.ensureTargets = function (T) {
    if (T.motion) return;
    var gl = this.gl, G = this.G;
    T.motion = G.texture2D(T.w, T.h, { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, filter: gl.NEAREST });
    T.list.push(T.motion);
    T.motionFB = G.framebuffer([T.motion], T.depth);
  };

  /** Decide whether this display refresh shows a generated frame. */
  P.wantGenerate = function (E) {
    var g = E.settings.graphics;
    if (this.mult !== ((+g.frameGen > 1) ? +g.frameGen : 0)) this.configure(g);
    this.active = this.ok && this.mult > 1 && E.state === 'playing' && E.worldLoaded && !E.ui.mapOpen;
    if (!this.active || !this.valid) { this.phase = 0; return false; }
    // after a teleport / camera cut the last frame is unusable
    if (E.renderer.taaReset) return false;
    this.phase += 1 / this.mult;
    if (this.phase >= 0.999) { this.phase -= 1; return false; }
    return true;
  };

  /** Snapshot the real frame (call right after it was rendered). */
  P.afterReal = function (frame) {
    if (!this.ok || !this.mult) { this.valid = false; return; }
    var R = this.R;
    M.copy(this.vpOld, R.curVPUnjit || frame.cam.viewProj);
    M.invert(this.invVPold, this.vpOld);
    this.originOld = [frame.origin[0], frame.origin[1]];
    this.timeOld = performance.now();
    this.motionValid = !!(R.targets && R.targets.motion && R._motionDrawn);
    this.valid = !!(R.targets && R.targets.ldr);
  };

  /** Draw a generated frame to the canvas for the current camera. */
  P.generate = function (E) {
    var R = this.R, T = R.targets, gl = this.gl, G = this.G, cam = E.camera, g = E.settings.graphics;
    if (!T || !this.valid) return false;
    M.invert(this.invVPnew, cam.viewProj);
    var c = G.canvas;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, c.width, c.height);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    var q = U.clamp(g.frameGenQuality === undefined ? 1 : g.frameGenQuality, 0, 2);
    var iters = g.frameGenPerf ? 3 : [3, 5, 8][q];
    var dt = (performance.now() - this.timeOld) / 1000 * (g.frameGenSensitivity || 1);
    var o = E.origin, oo = this.originOld;
    var p = this.prog.use();
    p.tex('uColor', 0, T.ldr).tex('uDepth', 1, T.depth).tex('uMotion', 2, this.motionValid ? T.motion : R.tex.black);
    p.m4('uInvVPold', this.invVPold).m4('uVPold', this.vpOld).m4('uVPnew', cam.viewProj).m4('uInvVPnew', this.invVPnew);
    p.v3('uShift', oo[0] - o[0], 0, oo[1] - o[1]).f('uDt', Math.min(dt, 0.1)).i('uIters', iters)
     .f('uArtifact', g.frameGenArtifacts === undefined ? 0.6 : g.frameGenArtifacts)
     .v4('uTex', 1 / T.w, 1 / T.h, g.antiAliasing >= 3 && !g.frameGenPerf ? 0.18 : 0, this.motionValid ? 1 : 0);
    G.drawFullscreen();
    this.genCount++;
    return true;
  };

  FrameGen.labelFor = function (m) { return m > 1 ? (m === 1.5 ? '1.5×' : m + '×') : 'Off'; };
  TERRA.gfx.FrameGen = FrameGen;
})();
