/* =============================================================================
 * TERRA INFINITA — interactive water physics
 * -----------------------------------------------------------------------------
 * A 2D wave-equation height field (64 m × 64 m, 256², 25 cm per texel) that
 * follows the camera. Each fixed 1/60 s step:
 *
 *     h' = (2h − h_prev + c²·∇²h) · damping
 *
 * Ripples spread, interfere, reflect off each other and fade. Sources:
 *   • rain drops (random impulses, count ∝ rain intensity)
 *   • the player wading, swimming strokes and jumping/falling into water
 *   • footsteps in shallow water
 * The water shader reads height (R) and previous height (G) for normals, a
 * little vertex displacement and foam on fast-moving crests.
 * ========================================================================== */
(function () {
  'use strict';
  var S = TERRA.shaders, U = TERRA.util;
  var SIZE = 64, RES = 256, SNAP = 4, MAXD = 24, STEP = 1 / 60;

  var FS = [
    'in vec2 vUv; out vec4 o;',
    'uniform sampler2D uPrev; uniform vec2 uShift; uniform vec4 uDrops[' + MAXD + ']; uniform int uCount;',
    'uniform float uC2; uniform float uDamp;',
    'vec2 S(vec2 uv){ return (all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0)))) ? texture(uPrev, uv).rg : vec2(0.0); }',
    'void main(){',
    '  vec2 px = 1.0 / vec2(' + RES.toFixed(1) + ');',
    '  vec2 uv = vUv + uShift;',
    '  vec2 c = S(uv);',
    '  float l = S(uv - vec2(px.x, 0.0)).r, r = S(uv + vec2(px.x, 0.0)).r, d = S(uv - vec2(0.0, px.y)).r, u = S(uv + vec2(0.0, px.y)).r;',
    '  float lap = l + r + d + u - 4.0 * c.r;',
    '  float h = (2.0 * c.r - c.g + uC2 * lap) * uDamp;',
    '  // drop impulses (x, z in uv, radius in uv, strength)',
    '  for (int i = 0; i < ' + MAXD + '; i++) {',
    '    if (i >= uCount) break;',
    '    vec4 D = uDrops[i];',
    '    float dd = length(vUv - D.xy) / max(D.z, 1e-4);',
    '    if (dd < 1.0) h -= D.w * (0.5 + 0.5 * cos(dd * 3.14159));',
    '  }',
    '  h = clamp(h, -0.6, 0.6);',
    '  o = vec4(h, c.r, 0.0, 1.0);',
    '}'
  ].join('\n');

  function WaterSim(engine) {
    this.engine = engine;
    var G = this.G = engine.renderer.G, gl = this.gl = G.gl;
    this.ok = !!G.caps.colorFloat;
    if (!this.ok) return;
    var f = { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT };
    this.tex = [G.texture2D(RES, RES, f), G.texture2D(RES, RES, f)];
    this.fb = [G.framebuffer([this.tex[0]]), G.framebuffer([this.tex[1]])];
    this.prog = G.program('watersim', S.fullscreenVS, FS);
    this.cur = 0; this.center = null; this.acc = 0;
    this.drops = [];
    this.arr = new Float32Array(MAXD * 4);
    this.area = [0, 0, SIZE];
    this.clear();
    var self = this;
    TERRA.events.on('footstep', function (e) {
      if (e.surface === 'water' || e.depth > 0.05) self.addDrop(e.pos[0], e.pos[2], 0.35, 0.05 + Math.min(e.depth || 0, 0.6) * 0.08);
    });
    TERRA.events.on('swimstroke', function () {
      var p = self.engine.player.pos;
      self.addDrop(p[0] + (Math.random() - 0.5) * 0.6, p[2] + (Math.random() - 0.5) * 0.6, 0.5, 0.09);
    });
    TERRA.events.on('splash', function (e) { self.addDrop(e.pos[0], e.pos[2], 0.9 + e.strength * 0.8, 0.15 + e.strength * 0.25); });
  }
  var P = WaterSim.prototype;

  P.clear = function () {
    if (!this.ok) return;
    var gl = this.gl;
    this.fb.forEach(function (f) { gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.center = null; this.drops.length = 0;
  };
  P.texture = function () { return this.ok ? this.tex[this.cur] : null; };
  /** World-space impulse: radius (m), strength (m of depression). */
  P.addDrop = function (x, z, r, s) { if (this.drops.length < 96) this.drops.push([x, z, r, s]); };

  P.update = function (frame) {
    if (!this.ok) return;
    var gl = this.gl, G = this.G, cam = frame.cam.world, env = frame.env;
    var cx = Math.floor(cam[0] / SNAP) * SNAP, cz = Math.floor(cam[2] / SNAP) * SNAP;
    var shift = [0, 0];
    if (!this.center || Math.abs(cx - this.center[0]) > SIZE || Math.abs(cz - this.center[1]) > SIZE) this.center = [cx, cz];
    else if (cx !== this.center[0] || cz !== this.center[1]) { shift = [(cx - this.center[0]) / SIZE, (cz - this.center[1]) / SIZE]; this.center = [cx, cz]; }
    this.area[0] = this.center[0] - SIZE / 2 - frame.origin[0];
    this.area[1] = this.center[1] - SIZE / 2 - frame.origin[1];
    // budget: no water within the simulated square → skip the simulation entirely
    this._nearT = (this._nearT || 0) - frame.dt;
    if (this._nearT <= 0) {
      this._nearT = 0.5;
      var cm = this.engine.chunks, near = false;
      for (var q = 0; q < 9 && !near; q++) {
        var n = cm.finestNode(cam[0] + ((q % 3) - 1) * SIZE * 0.5, cam[2] + (Math.floor(q / 3) - 1) * SIZE * 0.5);
        if (n && n.water && n.waterMax > cam[1] - 400) near = true;
      }
      if (this.engine.edits && this.engine.edits.hasWater) near = true;
      if (near && this.active === false) { this.clear(); this.active = true; return; }
      this.active = near;
    }
    if (!this.active) { this.drops = this.drops || []; this.drops.length = 0; return; }
    // continuous sources
    var pl = this.engine.player;
    if (pl.mode !== 'free' && (pl.swimming || pl.waterDepth > 0.12) && pl.speed > 0.2) {
      this.addDrop(pl.pos[0], pl.pos[2], pl.swimming ? 0.7 : 0.45, U.clamp(pl.speed * 0.012, 0.004, 0.05));
    }
    // rain: drops everywhere in the area (only visible on water surfaces)
    var rain = env.rain || 0;
    if (rain > 0.02) {
      var n = Math.min(10, Math.floor(rain * 10 + Math.random()));
      for (var i = 0; i < n; i++) this.addDrop(this.center[0] + (Math.random() - 0.5) * SIZE, this.center[1] + (Math.random() - 0.5) * SIZE, 0.08 + Math.random() * 0.06, 0.012 + rain * 0.02);
    }
    // fixed-rate steps (stable, frame-rate independent)
    this.acc = Math.min(this.acc + Math.min(frame.dt, 0.1), STEP * 3);
    if ((shift[0] || shift[1]) && this.acc < STEP) this.acc = STEP;   // a recentre must be applied this frame
    var first = true;
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      var cnt = first ? Math.min(MAXD, this.drops.length) : 0;
      for (var k = 0; k < cnt; k++) {
        var d = this.drops[k];
        this.arr[k * 4] = (d[0] - this.center[0]) / SIZE + 0.5; this.arr[k * 4 + 1] = (d[1] - this.center[1]) / SIZE + 0.5;
        this.arr[k * 4 + 2] = d[2] / SIZE; this.arr[k * 4 + 3] = d[3];
      }
      if (first) this.drops.splice(0, cnt);
      var next = 1 - this.cur;
      G.bindFB(this.fb[next], RES, RES);
      var p = this.prog.use().tex('uPrev', 0, this.tex[this.cur]).v2('uShift', first ? shift[0] : 0, first ? shift[1] : 0).i('uCount', cnt)
        .f('uC2', 0.42).f('uDamp', 0.9935);
      gl.uniform4fv(p.loc('uDrops[0]'), this.arr);
      G.drawFullscreen();
      this.cur = next;
      first = false;
    }
    if (this.drops.length > 64) this.drops.length = 0;
  };

  WaterSim.SIZE = SIZE; WaterSim.RES = RES;
  TERRA.world.WaterSim = WaterSim;
})();
