/* =============================================================================
 * TERRA INFINITA — weather & ambient particles, lightning bolts, birds
 * ========================================================================== */
(function () {
  'use strict';
  var S = TERRA.shaders, U = TERRA.util;

  var BIRD_VS = [
    '#include <frame>',
    '#include <common>',
    'layout(location = 0) in vec4 iPos;   // xyz position, w heading',
    'layout(location = 1) in vec4 iData;  // x flap phase, y size',
    'out float vZ;',
    'void main(){',
    '  int v = gl_VertexID;',
    '  float flap = sin(uCamPos.w * 9.0 + iData.x * 6.28);',
    '  vec3 lp = v == 0 ? vec3(0.0, 0.0, 0.35) : (v == 1 ? vec3(-1.0, flap * 0.5, -0.2) : (v == 2 ? vec3(0.0, 0.0, -0.2) : (v == 3 ? vec3(0.0, 0.0, 0.35) : (v == 4 ? vec3(0.0, 0.0, -0.2) : vec3(1.0, flap * 0.5, -0.2)))));',
    '  lp *= iData.y;',
    '  float c = cos(iPos.w), s = sin(iPos.w);',
    '  vec3 wp = iPos.xyz + vec3(c * lp.x + s * lp.z, lp.y, -s * lp.x + c * lp.z);',
    '  vec4 vp = uView * vec4(wp, 1.0); vZ = -vp.z;',
    '  gl_Position = uProj * vp;',
    '}'
  ].join('\n');
  var BIRD_FS = ['#include <frame>', '#include <common>', 'in float vZ; out vec4 o; uniform sampler2D uDepth;',
    'void main(){ float d = texture(uDepth, gl_FragCoord.xy * uScreen.zw).r; if (!isSkyDepth(d) && linearDepth(d) < vZ) discard;',
    '  vec3 c = vec3(0.02, 0.02, 0.025) + uSunColor.rgb * 0.002; o = vec4(c, 1.0); }'].join('\n');

  function Particles(R) {
    this.R = R; this.G = R.G; var gl = this.gl = R.G.gl;
    this.prog = this.G.program('particles', S.particleVS, S.particleFS);
    this.boltProg = this.G.program('bolt', S.boltVS, S.boltFS);
    this.birdProg = this.G.program('birds', BIRD_VS, BIRD_FS);
    this.vao = gl.createVertexArray();
    this.bolts = [];
    this.boltVAO = gl.createVertexArray(); gl.bindVertexArray(this.boltVAO);
    this.boltBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.boltBuf); gl.bufferData(gl.ARRAY_BUFFER, 16, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
    gl.bindVertexArray(null);
    // birds
    this.birdVAO = gl.createVertexArray(); gl.bindVertexArray(this.birdVAO);
    this.birdBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.birdBuf); gl.bufferData(gl.ARRAY_BUFFER, 16, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 32, 0); gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 16); gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
    this.flocks = [];
    this.stats = { count: 0 };
  }
  var P = Particles.prototype;

  /** Create a lightning bolt geometry (render-space) from the sky to the ground. */
  P.spawnBolt = function (frame, x, z, groundY, cloudY) {
    var pts = [], segs = 22;
    var cx = x, cz = z;
    for (var i = 0; i <= segs; i++) {
      var t = i / segs;
      cx += (Math.random() - 0.5) * 60 * (1 - t * 0.5); cz += (Math.random() - 0.5) * 60 * (1 - t * 0.5);
      pts.push([cx, U.mix(cloudY, groundY, t), cz]);
    }
    var verts = [];
    var width = 6;
    var cam = frame.cam.pos;
    function strip(p) {
      for (var k = 0; k < p.length - 1; k++) {
        var a = p[k], b = p[k + 1];
        var dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
        var tx = cam[0] - a[0], ty = cam[1] - a[1], tz = cam[2] - a[2];
        var sx = dy * tz - dz * ty, sy = dz * tx - dx * tz, sz = dx * ty - dy * tx;
        var l = Math.hypot(sx, sy, sz) || 1; sx *= width / l; sy *= width / l; sz *= width / l;
        verts.push(a[0] - sx, a[1] - sy, a[2] - sz, 1, a[0] + sx, a[1] + sy, a[2] + sz, 1, b[0] + sx, b[1] + sy, b[2] + sz, 1);
        verts.push(a[0] - sx, a[1] - sy, a[2] - sz, 1, b[0] + sx, b[1] + sy, b[2] + sz, 1, b[0] - sx, b[1] - sy, b[2] - sz, 1);
      }
    }
    strip(pts);
    // branches
    for (var br = 0; br < 3; br++) {
      var start = pts[4 + Math.floor(Math.random() * 10)], bp = [start];
      var bx = start[0], by = start[1], bz = start[2];
      for (var s = 0; s < 6; s++) { bx += (Math.random() - 0.5) * 90; bz += (Math.random() - 0.5) * 90; by -= 40 + Math.random() * 60; bp.push([bx, by, bz]); }
      width = 3; strip(bp);
    }
    this.bolts.push({ data: new Float32Array(verts), life: 0.35, age: 0 });
  };

  P._updateBirds = function (frame) {
    var env = frame.env;
    var want = env.dayFactor > 0.3 && env.rain < 0.3 && env.snow < 0.3 ? 3 : 0;
    var cam = frame.cam.world, o = frame.origin;
    while (this.flocks.length < want) {
      var a = Math.random() * Math.PI * 2, d = 150 + Math.random() * 350;
      this.flocks.push({ cx: cam[0] + Math.cos(a) * d, cz: cam[2] + Math.sin(a) * d, alt: 55 + Math.random() * 90, r: 30 + Math.random() * 60, speed: 0.25 + Math.random() * 0.2, phase: Math.random() * 6, n: 6 + Math.floor(Math.random() * 12), seed: Math.random() * 100 });
    }
    if (this.flocks.length > want) this.flocks.length = want;
    var arr = this._birdArr || (this._birdArr = new Float32Array(8 * 64)), n = 0;
    var gen = this.R.engine.gen;
    for (var f = 0; f < this.flocks.length; f++) {
      var fl = this.flocks[f];
      // recycle flocks that drift too far
      if (Math.hypot(fl.cx - cam[0], fl.cz - cam[2]) > 900) { this.flocks.splice(f, 1); f--; continue; }
      fl.cx += Math.cos(frame.time * 0.05 + fl.seed) * frame.dt * 3; fl.cz += Math.sin(frame.time * 0.04 + fl.seed) * frame.dt * 3;
      if (!fl.ground || frame.time - fl.groundT > 3) { fl.ground = gen.height(fl.cx, fl.cz); fl.groundT = frame.time; }
      var baseY = Math.max(fl.ground, gen.SEA) + fl.alt;
      for (var b = 0; b < fl.n && n < 64; b++) {
        var t = frame.time * fl.speed + fl.phase + b * 0.09;
        var r = fl.r + Math.sin(b * 1.7) * 8;
        var x = fl.cx + Math.cos(t) * r + Math.sin(b * 3.1) * 4, z = fl.cz + Math.sin(t) * r + Math.cos(b * 2.3) * 4;
        var y = baseY + Math.sin(b * 0.7 + frame.time * 0.3) * 5;
        var heading = -t + Math.PI;
        arr[n * 8] = x - o[0]; arr[n * 8 + 1] = y; arr[n * 8 + 2] = z - o[1]; arr[n * 8 + 3] = heading;
        arr[n * 8 + 4] = b * 0.37 + fl.seed; arr[n * 8 + 5] = 0.45 + (b % 3) * 0.08; arr[n * 8 + 6] = 0; arr[n * 8 + 7] = 0;
        n++;
      }
    }
    this.birdCount = n;
    if (n) { var gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, this.birdBuf); gl.bufferData(gl.ARRAY_BUFFER, arr.subarray(0, n * 8), gl.DYNAMIC_DRAW); }
  };

  P.draw = function (frame) {
    var gl = this.gl, env = frame.env, R = this.R, q = frame.settings.vegetationQuality;
    var veg = R.engine.vegetation;
    this._updateBirds(frame);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    var p = this.prog.use();
    R.sky.bindAtmo(p, 0);
    p.tex('uDepth', 2, R.targets.depth);
    if (veg && veg.fieldCenter) {
      p.tex('uHeightTex', 3, veg.heightTex);
      var fo = veg.fieldOriginLinear(frame.origin);
      p.v4('uField', fo[0], fo[1], veg.FIELD, 1 / veg.FIELD);
    } else p.tex('uHeightTex', 3, R.tex.black);
    gl.bindVertexArray(this.vao);
    var total = 0;
    var scale = [0.35, 0.6, 0.85, 1][U.clamp(q, 0, 3)];
    var self = this;
    function sys(kind, count, box, intensity, additive) {
      if (intensity <= 0.001 || count <= 0) return;
      if (additive) gl.blendFunc(gl.ONE, gl.ONE); else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      p.i('uKind', kind).v3('uBox', box[0], box[1], box[2]).f('uIntensity', U.clamp01(intensity)).f('uCount', count);
      var n = Math.ceil(count * U.clamp01(intensity));
      gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, n);
      total += n; self.G.stats.drawCalls++;
    }
    var under = env.underwater;
    var wq = frame.settings.weatherQuality; wq = wq === undefined ? 2 : U.clamp(wq, 0, 3);
    var ws = [0.4, 0.7, 1.0, 1.35][wq];
    if (!under) {
      sys(0, 34000 * ws, [46, 32, 46], env.rain, false);
      if (wq >= 1) sys(9, 9000 * ws, [150, 70, 150], env.rain * U.smoothstep(0.15, 0.7, env.rain), false);
      sys(3, 1296, [1, 1, 1], env.rain * 1.2 * (1 - env.snowCover), false);
      sys(1, 24000 * Math.max(scale, ws * 0.8), [42, 28, 42], env.snow, false);
      sys(2, 1400 * scale, [120, 40, 120], env.dust, false);
      sys(4, 180, [60, 8, 60], env.fireflies, true);
      sys(5, 360 * scale, [40, 22, 40], env.leaves, false);
      sys(6, 600 * scale, [60, 30, 60], env.embers, true);
      sys(7, 400 * scale, [16, 10, 16], env.motes, true);
    }
    gl.bindVertexArray(null);
    // lightning bolts (additive)
    if (this.bolts.length) {
      gl.blendFunc(gl.ONE, gl.ONE);
      var bp = this.boltProg.use();
      gl.bindVertexArray(this.boltVAO);
      for (var i = this.bolts.length - 1; i >= 0; i--) {
        var b = this.bolts[i];
        b.age += frame.dt;
        if (b.age > b.life) { this.bolts.splice(i, 1); continue; }
        var flick = (Math.sin(b.age * 90) > -0.3 ? 1 : 0.2) * (1 - b.age / b.life);
        bp.f('uAlpha', flick).v3('uColor', 30, 32, 40);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.boltBuf);
        gl.bufferData(gl.ARRAY_BUFFER, b.data, gl.DYNAMIC_DRAW);
        gl.drawArrays(gl.TRIANGLES, 0, b.data.length / 4);
      }
      gl.bindVertexArray(null);
    }
    gl.disable(gl.BLEND);
    // gameplay effects (spray, exhaust, dust, chips, explosions)
    if (R.engine.effects) R.engine.effects.drawParticles(frame);
    // birds (opaque silhouettes; depth-tested manually by being high in the sky)
    if (this.birdCount && !under) {
      this.birdProg.use().tex('uDepth', 0, R.targets.depth);
      gl.bindVertexArray(this.birdVAO);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.birdCount);
      gl.bindVertexArray(null);
    }
    this.stats.count = total;
  };

  TERRA.env.Particles = Particles;
})();
