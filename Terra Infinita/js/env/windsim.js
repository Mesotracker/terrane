/* =============================================================================
 * TERRA INFINITA — vegetation wind physics
 * -----------------------------------------------------------------------------
 * A GPU simulation of plant motion over a 160 m × 160 m area that follows the
 * camera (256² texels, 0.625 m each). Every texel is a damped spring:
 *
 *     a = k · (target − x) − c · v + player push
 *
 * where `target` is the lean the local wind would hold the plants at. The wind
 * comes from the shared gust field (travelling gust fronts + turbulence, see
 * shaders/lib.glsl.js), so gust waves visibly roll across meadows, grass
 * overshoots and springs back when a gust passes, and walking through it pushes
 * blades aside and lets them recover with a little wobble.
 *
 *   R,G  lean (x, z)   B,A  velocity (x, z)
 *
 * Grass samples this texture; outside the area it falls back to the analytic
 * wind field. Trees use the same gust field with an inertial response.
 * ========================================================================== */
(function () {
  'use strict';
  var S = TERRA.shaders, U = TERRA.util;
  var SIZE = 160, RES = 256, SNAP = 10;

  var FS = [
    '#include <frame>',
    '#include <common>',
    '#include <wind>',
    'in vec2 vUv; out vec4 o;',
    'uniform sampler2D uPrev; uniform vec2 uShift; uniform float uDt;',
    'uniform vec4 uArea;     // xy render-space origin (uv 0), z size',
    'uniform vec4 uPush;     // xyz player velocity, w contact strength',
    'uniform vec2 uSpring;   // stiffness, damping',
    'vec2 accel(vec2 x, vec2 v, vec2 target, vec2 pushF){ return uSpring.x * (target - x) - uSpring.y * v + pushF; }',
    'void main(){',
    '  vec2 puv = vUv + uShift;',
    '  vec4 s = (all(greaterThan(puv, vec2(0.0))) && all(lessThan(puv, vec2(1.0)))) ? texture(uPrev, puv) : vec4(0.0);',
    '  vec2 wp = uArea.xy + vUv * uArea.z;',
    '  vec2 w = windField(vec3(wp.x, 0.0, wp.y));',
    '  // lean the wind would hold the grass at (saturating with strength)',
    '  float wl = length(w); vec2 target = wl > 1e-4 ? w / wl * (1.0 - exp(-wl * 1.6)) * 1.05 : vec2(0.0);',
    '  // player: radial push while moving through, plus drag along the walking direction',
    '  vec2 d = wp - uPlayer.xz; float pd = length(d);',
    '  float contact = (1.0 - smoothstep(0.1, 0.9, pd)) * uPush.w;',
    '  vec2 pushF = (d / max(pd, 1e-3)) * contact * (140.0 + 60.0 * length(uPush.xz)) + uPush.xz * contact * 12.0;',
    '  vec2 x = s.xy, v = s.zw;',
    '  float h = min(uDt, 0.05) * 0.5;',
    '  for (int i = 0; i < 2; i++) {',
    '    v += accel(x, v, target, pushF) * h;',
    '    x += v * h;',
    '  }',
    '  float lx = length(x); if (lx > 1.6) { x *= 1.6 / lx; v *= 0.5; }',
    '  o = vec4(x, v);',
    '}'
  ].join('\n');

  function WindSim(engine) {
    this.engine = engine;
    var R = engine.renderer, G = this.G = R.G, gl = this.gl = G.gl;
    // needs a float target for signed values
    this.ok = !!G.caps.colorFloat;
    if (!this.ok) return;
    var f = { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT };
    this.tex = [G.texture2D(RES, RES, f), G.texture2D(RES, RES, f)];
    this.fb = [G.framebuffer([this.tex[0]]), G.framebuffer([this.tex[1]])];
    this.clear();
    this.cur = 0;
    this.prog = G.program('windsim', S.fullscreenVS, FS);
    this.center = null;
    this.area = [0, 0, SIZE];
  }
  var P = WindSim.prototype;

  P.clear = function () {
    if (!this.ok) return;
    var gl = this.gl;
    this.fb.forEach(function (f) { gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.center = null;
  };
  P.texture = function () { return this.ok ? this.tex[this.cur] : null; };

  /** Step the simulation (called once per frame before the G-buffer). */
  P.update = function (frame) {
    if (!this.ok) return;
    var gl = this.gl, G = this.G, cam = frame.cam.world;
    var cx = Math.floor(cam[0] / SNAP) * SNAP, cz = Math.floor(cam[2] / SNAP) * SNAP;
    var shift = [0, 0];
    if (!this.center || Math.abs(cx - this.center[0]) > SIZE || Math.abs(cz - this.center[1]) > SIZE) { this.center = [cx, cz]; }
    else if (cx !== this.center[0] || cz !== this.center[1]) {
      shift = [(cx - this.center[0]) / SIZE, (cz - this.center[1]) / SIZE];
      this.center = [cx, cz];
    }
    // render-space origin of uv (0,0)
    this.area[0] = this.center[0] - SIZE / 2 - frame.origin[0];
    this.area[1] = this.center[1] - SIZE / 2 - frame.origin[1];
    this.area[2] = SIZE;
    var pl = this.engine.player;
    var contact = (pl.mode !== 'free' && pl.onGround && !pl.swimming) ? U.clamp01(0.35 + pl.speed / 3) : 0;
    var v = pl.vel || [0, 0, 0];
    var next = 1 - this.cur;
    G.bindFB(this.fb[next], RES, RES);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    this.prog.use().tex('uPrev', 0, this.tex[this.cur]).v2('uShift', shift[0], shift[1]).f('uDt', Math.max(0.001, Math.min(frame.dt, 0.1)))
      .v4('uArea', this.area[0], this.area[1], SIZE, 1 / SIZE).v4('uPush', v[0], v[1], v[2], contact)
      .v2('uSpring', 150.0, 4.4);
    G.drawFullscreen();
    this.cur = next;
  };

  WindSim.SIZE = SIZE;
  TERRA.env.WindSim = WindSim;
})();
