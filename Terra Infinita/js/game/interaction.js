/* =============================================================================
 * TERRA INFINITA — environmental interaction (trail map)
 * A 64 m × 64 m render target that follows the player:
 *   R  footprint depth (sand, snow, mud) — slowly fills back in (faster while snowing)
 *   G  flattened grass / vegetation contact
 *   B  water wake & ripples
 * Sampled by the terrain, grass and water shaders.
 * ========================================================================== */
(function () {
  'use strict';
  var S = TERRA.shaders, U = TERRA.util;
  var SIZE = 64, RES = 512, MAXS = 24;

  var FS = [
    'in vec2 vUv; out vec4 o;',
    'uniform sampler2D uPrev; uniform vec2 uShift; uniform float uDt; uniform vec3 uDecay;',
    'uniform vec4 uStampA[24]; uniform vec4 uStampB[24]; uniform int uCount;',
    'void main(){',
    '  vec2 puv = vUv + uShift;',
    '  vec4 p = (all(greaterThan(puv, vec2(0.0))) && all(lessThan(puv, vec2(1.0)))) ? texture(uPrev, puv) : vec4(0.0);',
    '  p.rgb = max(vec3(0.0), p.rgb - uDecay * uDt);',
    '  for (int i = 0; i < 24; i++) {',
    '    if (i >= uCount) break;',
    '    vec4 A = uStampA[i], B = uStampB[i];',
    '    vec2 d = (vUv - A.xy) * ' + SIZE.toFixed(1) + ';',
    '    int kind = int(B.y + 0.5);',
    '    if (kind == 0) {',
    '      float c = cos(B.x), s = sin(B.x); vec2 q = vec2(c * d.x - s * d.y, s * d.x + c * d.y);',
    '      // sole: forefoot + heel',
    '      float fore = length((q - vec2(0.0, 0.05)) / vec2(0.055, 0.075));',
    '      float heel = length((q - vec2(0.0, -0.085)) / vec2(0.045, 0.05));',
    '      float m = smoothstep(1.0, 0.7, min(fore, heel));',
    '      float rim = smoothstep(1.35, 1.0, min(fore, heel)) - m;',
    '      p.r = max(p.r, m * B.z); p.g = max(p.g, (m + rim) * 0.8);',
    '    } else if (kind == 1) {',
    '      float m = smoothstep(A.z, A.z * 0.3, length(d));',
    '      p.g = max(p.g, m);',
    '    } else if (kind == 3) {',
    '      // tyre track: a capsule along the direction of travel (rut in soft ground, flattened grass)',
    '      float c = cos(B.x), s = sin(B.x); vec2 q = vec2(c * d.x - s * d.y, s * d.x + c * d.y);',
    '      vec2 qq = vec2(q.x, max(abs(q.y) - A.w, 0.0));',
    '      float dd = length(qq) / max(A.z, 0.01);',
    '      float m = smoothstep(1.0, 0.55, dd); float rim = smoothstep(1.6, 1.0, dd) - m;',
    '      p.r = max(p.r, m * B.z); p.g = max(p.g, (m + rim) * 0.95);',
    '    } else if (kind == 4) {',
    '      // tilled / raked soil: grass flattened, shallow furrow',
    '      float m = smoothstep(A.z, A.z * 0.6, length(d));',
    '      p.g = max(p.g, m); p.r = max(p.r, m * B.z);',
    '    } else if (kind == 5) {',
    '      // rake: tine grooves along the pull direction over a rectangle (A.z half width, A.w half length)',
    '      float c = cos(B.x), s = sin(B.x); vec2 q = vec2(c * d.x - s * d.y, s * d.x + c * d.y);',
    '      float m = smoothstep(A.z, A.z * 0.7, abs(q.x)) * smoothstep(A.w + 0.1, A.w * 0.7, abs(q.y));',
    '      float grooves = 0.5 + 0.5 * cos(q.x * 25.1);',
    '      p.g = max(p.g, m); p.r = max(p.r, m * grooves * B.z);',
    '    } else {',
    '      float r = length(d); float m = smoothstep(A.z, A.z * 0.5, r);',
    '      p.b = max(p.b, m * B.z);',
    '    }',
    '  }',
    '  o = p;',
    '}'
  ].join('\n');

  function Interaction(engine) {
    this.engine = engine;
    var R = engine.renderer, G = this.G = R.G, gl = this.gl = G.gl;
    var hf = G.hdrFormat;
    this.tex = [G.texture2D(RES, RES, { internal: hf.internal, format: hf.format, type: hf.type }), G.texture2D(RES, RES, { internal: hf.internal, format: hf.format, type: hf.type })];
    this.fb = [G.framebuffer([this.tex[0]]), G.framebuffer([this.tex[1]])];
    this.fb.forEach(function (f) { gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.cur = 0;
    this.prog = G.program('trail', S.fullscreenVS, FS);
    this.center = null;
    this.stamps = [];
    this.A = new Float32Array(MAXS * 4); this.B = new Float32Array(MAXS * 4);
    var self = this;
    TERRA.events.on('footstep', function (e) {
      var soft = { sand: 0.8, snow: 1.0, mud: 0.9, grass: 0.15, leaves: 0.2, rock: 0, water: 0, puddle: 0.5, path: 0.4, ice: 0 }[e.surface] || 0;
      if (e.surface === 'puddle') self.stamps.push({ kind: 2, x: e.pos[0], z: e.pos[2], r: 0.5, s: 0.6 });
      if (e.surface === 'water') { self.stamps.push({ kind: 2, x: e.pos[0], z: e.pos[2], r: 0.9, s: 1 }); return; }
      self.stamps.push({ kind: 0, x: e.pos[0], z: e.pos[2], ang: e.yaw, s: soft * (e.sprint ? 1 : 0.85) });
    });
  }
  var P = Interaction.prototype;

  P.texture = function () { return this.tex[this.cur]; };

  P.render = function (frame) {
    var p = frame.player.worldPos, gl = this.gl, G = this.G;
    var cx = Math.floor(p[0] / 8) * 8, cz = Math.floor(p[2] / 8) * 8;
    var shift = [0, 0];
    if (!this.center) this.center = [cx, cz];
    if (cx !== this.center[0] || cz !== this.center[1]) {
      shift = [(cx - this.center[0]) / SIZE, (cz - this.center[1]) / SIZE];
      this.center = [cx, cz];
    }
    frame.trail.x = this.center[0] - frame.origin[0]; frame.trail.z = this.center[1] - frame.origin[1]; frame.trail.size = SIZE;
    // continuous stamps: body (flattens grass) and wake while in water
    var pl = this.engine.player;
    if (pl.mode !== 'free' && (pl.onGround || pl.swimming) && pl.speed > 0.1) {
      if (pl.swimming || pl.waterDepth > 0.15) this.stamps.push({ kind: 2, x: p[0], z: p[2], r: pl.swimming ? 1.6 : 0.7, s: U.clamp01(pl.speed / 3) });
      else this.stamps.push({ kind: 1, x: p[0], z: p[2], r: 0.45 });
    }
    var n = Math.min(MAXS, this.stamps.length);
    for (var i = 0; i < n; i++) {
      var s = this.stamps[i];
      this.A[i * 4] = (s.x - this.center[0]) / SIZE + 0.5; this.A[i * 4 + 1] = (s.z - this.center[1]) / SIZE + 0.5; this.A[i * 4 + 2] = s.r || 0.3; this.A[i * 4 + 3] = s.len || 0;
      this.B[i * 4] = (s.ang || 0) + Math.PI; this.B[i * 4 + 1] = s.kind; this.B[i * 4 + 2] = s.s !== undefined ? s.s : 1; this.B[i * 4 + 3] = 0;
    }
    this.stamps.splice(0, n);
    if (this.stamps.length > 96) this.stamps.splice(0, this.stamps.length - 48);   // keep the newest under heavy load
    var env = frame.env;
    var decayR = 1 / 300 + env.snow * 0.03 + env.rain * 0.004 + env.windStrength * env.dust * 0.03;
    var next = 1 - this.cur;
    G.bindFB(this.fb[next], RES, RES);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    var pr = this.prog.use();
    pr.tex('uPrev', 0, this.tex[this.cur]).v2('uShift', shift[0], shift[1]).f('uDt', Math.min(frame.dt, 0.1)).v3('uDecay', decayR, 1 / 7, 1 / 1.6).i('uCount', n);
    gl.uniform4fv(pr.loc('uStampA[0]'), this.A); gl.uniform4fv(pr.loc('uStampB[0]'), this.B);
    G.drawFullscreen();
    this.cur = next;
  };
  P.clear = function () {
    var gl = this.gl;
    this.fb.forEach(function (f) { gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.center = null;
  };

  TERRA.game.Interaction = Interaction;
})();
