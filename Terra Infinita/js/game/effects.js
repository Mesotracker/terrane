/* =============================================================================
 * TERRA INFINITA — local effects: pooled CPU particles + debris
 * -----------------------------------------------------------------------------
 * One pooled particle system for every gameplay effect: water spray & splashes,
 * engine exhaust, contrails, dust, wood chips, sparks, dynamite fuse sparks,
 * explosion fireballs, smoke columns and flying debris. Particles live in typed
 * arrays (no allocation per particle), are simulated with gravity, drag, wind and
 * a cheap ground bounce, and are drawn in one instanced call (soft, depth-tested,
 * lit by the sun/sky). A global budget (Particle quality) caps the count, and
 * emitters far from the camera are thinned, so several explosions at once stay
 * cheap. Debris chunks are particles with bounce and spin.
 * ========================================================================== */
(function () {
  'use strict';
  var S = TERRA.shaders, U = TERRA.util;

  // kinds
  var K = { SMOKE: 0, FIRE: 1, SPARK: 2, WATER: 3, DUST: 4, CHIP: 5, DEBRIS: 6, CONTRAIL: 7, STEAM: 8, LEAF: 9, MARKER: 10 };
  var FLOATS = 16;  // x y z vx vy vz age life size grow r g b a kind spin

  S.fxVS = [
    '#include <frame>',
    '#include <common>',
    'layout(location = 0) in vec4 iA;   // xyz pos (render space), w size',
    'layout(location = 1) in vec4 iB;   // rgb colour, a alpha',
    'layout(location = 2) in vec4 iC;   // x kind, y life fraction, z spin, w stretch',
    'out vec2 vQ; out vec4 vCol; flat out int vK; out float vLife; out float vDepthV;',
    'void main(){',
    '  int c = gl_VertexID; vec2 q = vec2(c == 1 || c == 2 ? 1.0 : -1.0, c >= 2 ? 1.0 : -1.0);',
    '  vQ = q; vCol = iB; vK = int(iC.x + 0.5); vLife = iC.y;',
    '  vec3 toCam = normalize(uCamPos.xyz - iA.xyz);',
    '  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam) + vec3(1e-4, 0.0, 0.0)); vec3 up = cross(toCam, right);',
    '  float a = iC.z; vec3 r2 = right * cos(a) + up * sin(a), u2 = -right * sin(a) + up * cos(a);',
    '  vec3 wp = iA.xyz + (r2 * q.x + u2 * q.y * (1.0 + iC.w)) * iA.w;',
    '  vec4 vp = uView * vec4(wp, 1.0); vDepthV = -vp.z;',
    '  gl_Position = uProj * vp;',
    '}'
  ].join('\n');
  S.fxFS = [
    '#include <frame>',
    '#include <common>',
    '#include <atmosphere>',
    'in vec2 vQ; in vec4 vCol; flat in int vK; in float vLife; in float vDepthV; out vec4 o;',
    'uniform sampler2D uDepth; uniform float uSunVis;   // canopy shade around the camera',
    'void main(){',
    '  float r2 = dot(vQ, vQ); if (r2 > 1.0) discard;',
    '  float sd = texture(uDepth, gl_FragCoord.xy * uScreen.zw).r;',
    '  float sz = isSkyDepth(sd) ? 1e7 : linearDepth(sd);',
    '  bool soft = vK == 0 || vK == 4 || vK == 7 || vK == 8 || vK == 1;',
    '  float s = saturate((sz - vDepthV) * (soft ? 0.6 : 6.0)); if (s <= 0.0) discard;',
    '  vec3 amb = texelFetch(uAmbientTex, ivec2(0, 0), 0).rgb / PI; vec3 sun = uSunColor.rgb * max(uSunDir.y, 0.0) * uSunVis;',
    '  float a = vCol.a * s; vec3 c;',
    '  if (vK == 1) { float core = smoothstep(1.0, 0.0, r2); c = vCol.rgb * (6.0 + 10.0 * core) * (1.0 - vLife * 0.7); a *= core; }',
    '  else if (vK == 2) { c = vCol.rgb * 12.0; a *= smoothstep(1.0, 0.2, r2); }',
    '  else if (vK == 5 || vK == 6 || vK == 9) { a *= step(r2, 0.85); c = vCol.rgb * (amb * 1.4 + sun * 0.35); }',
    '  else if (vK == 10) { float dm = smoothstep(1.0, 0.2, r2); a *= dm; c = vCol.rgb * (0.6 + amb * 0.8); }',
    '  else if (vK == 3) { float dp = smoothstep(1.0, 0.25, r2); a *= dp; c = vCol.rgb * (amb * 1.2 + sun * 0.3) + sun * 0.08 * pow(dp, 6.0); }',
    '  else { float puff = smoothstep(1.0, 0.0, r2); puff *= 0.75 + 0.25 * sin(vQ.x * 5.0 + vQ.y * 4.0 + vLife * 6.0);',
    '    a *= puff; c = vCol.rgb * (amb * 1.6 + sun * 0.45); }',
    '  float T = exp(-vDepthV * (uFog.x + 0.00001));',
    '  c *= T;',
    '  o = vec4(c * a, (vK == 1 || vK == 2 || vK == 10) ? a * 0.35 : a);',
    '}'
  ].join('\n');

  function Effects(engine) {
    this.engine = engine;
    var R = engine.renderer, G = this.G = R.G, gl = this.gl = G.gl;
    this.prog = G.program('effects', S.fxVS, S.fxFS);
    this.cap = 6000;
    this.data = new Float32Array(this.cap * FLOATS);
    this.n = 0;
    this.inst = new Float32Array(this.cap * 12);
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf); gl.bufferData(gl.ARRAY_BUFFER, this.inst.byteLength, gl.DYNAMIC_DRAW);
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    for (var i = 0; i < 3; i++) { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, 4, gl.FLOAT, false, 48, i * 16); gl.vertexAttribDivisor(i, 1); }
    gl.bindVertexArray(null);
    this.lights = [];       // transient point lights (explosions, fires)
    this.shake = 0;
    var self = this;
    // feet in puddles and mud
    TERRA.events.on('footstep', function (e) {
      if (e.surface === 'puddle') self.splash(e.pos, 0.1 + (e.sprint ? 0.08 : 0));
      else if (e.surface === 'mud' && Math.random() < 0.6) self.chips([e.pos[0], e.pos[1] + 0.05, e.pos[2]], [0, 0.4, 0], 2 + (e.sprint ? 3 : 0), [0.25, 0.19, 0.13]);
      else if (e.surface === 'snow' && e.sprint) self.dust(e.pos, 0.15, [0.95, 0.96, 1]);
    });
  }
  var P = Effects.prototype;
  Effects.K = K;

  P.budget = function () {
    var q = this.engine.settings.graphics.particleQuality;
    return [1200, 2500, 4200, 6000][U.clamp(q === undefined ? 2 : q, 0, 3)];
  };
  P.clear = function () { this.n = 0; this.lights.length = 0; this.preview = null; };
  /** Trajectory preview dots (world positions) drawn this frame only. */
  P.setPreview = function (pts) { this.preview = pts; };

  /** Emit one particle. pos world (float64). opts: vel, life, size, grow, color, alpha, spin, kind */
  P.emit = function (kind, pos, vel, life, size, grow, col, alpha, spin) {
    if (this.n >= Math.min(this.cap, this.budget())) {
      // recycle the oldest-looking slot (cheap: random replace)
      var k2 = Math.floor(Math.random() * this.n);
      this._write(k2, kind, pos, vel, life, size, grow, col, alpha, spin);
      return;
    }
    this._write(this.n++, kind, pos, vel, life, size, grow, col, alpha, spin);
  };
  P._write = function (i, kind, pos, vel, life, size, grow, col, alpha, spin) {
    var d = this.data, o = i * FLOATS;
    d[o] = pos[0]; d[o + 1] = pos[1]; d[o + 2] = pos[2];
    d[o + 3] = vel ? vel[0] : 0; d[o + 4] = vel ? vel[1] : 0; d[o + 5] = vel ? vel[2] : 0;
    d[o + 6] = 0; d[o + 7] = life; d[o + 8] = size; d[o + 9] = grow || 0;
    d[o + 10] = col[0]; d[o + 11] = col[1]; d[o + 12] = col[2]; d[o + 13] = alpha;
    d[o + 14] = kind; d[o + 15] = spin || 0;
  };
  /** Distance thinning: far emitters spawn fewer particles. */
  P.scale = function (pos) {
    var c = this.engine.camera.world, d = Math.hypot(pos[0] - c[0], pos[1] - c[1], pos[2] - c[2]);
    var q = this.engine.settings.graphics.particleQuality; q = q === undefined ? 2 : q;
    return U.clamp(1.4 - d / 220, 0.15, 1) * [0.35, 0.6, 0.85, 1][U.clamp(q, 0, 3)];
  };
  P.count = function (n, pos) { var s = n * this.scale(pos); var k = Math.floor(s); return k + (Math.random() < s - k ? 1 : 0); };

  /* ---------------- preset emitters ---------------- */
  P.splash = function (pos, strength) {
    var n = this.count(26 * strength + 6, pos);
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, r = Math.random();
      var sp = (1.5 + 3.5 * strength) * (0.4 + Math.random());
      this.emit(K.WATER, [pos[0] + Math.cos(a) * r * 0.3, pos[1] + 0.05, pos[2] + Math.sin(a) * r * 0.3], [Math.cos(a) * sp * 0.45, sp * (1.2 + Math.random()), Math.sin(a) * sp * 0.45], 0.7 + Math.random() * 0.6, 0.05 + Math.random() * 0.08 * (1 + strength), 0.15, [0.85, 0.9, 0.95], 0.55);
    }
    var m = this.count(5 * strength + 2, pos);
    for (var j = 0; j < m; j++) this.emit(K.STEAM, [pos[0] + (Math.random() - 0.5), pos[1] + 0.3, pos[2] + (Math.random() - 0.5)], [0, 0.6 + Math.random(), 0], 1.2 + Math.random(), 0.4 + strength * 0.8, 0.9, [0.9, 0.93, 0.96], 0.18);
  };
  /** Bow spray / wheel spray: a sheet of fine droplets plus drifting mist. */
  P.spray = function (pos, dir, strength) {
    var n = this.count(5 + strength * 12, pos);
    for (var i = 0; i < n; i++) {
      var s = 1.5 + Math.random() * 4.5 * strength;
      var j = (Math.random() - 0.5) * 0.4;
      this.emit(K.WATER, [pos[0] + j * dir[2], pos[1], pos[2] - j * dir[0]], [dir[0] * s + (Math.random() - 0.5) * 1.6, 1.2 + Math.random() * 3.2 * strength, dir[2] * s + (Math.random() - 0.5) * 1.6], 0.35 + Math.random() * 0.45, 0.018 + Math.random() * 0.035, 0.05, [0.9, 0.94, 0.97], 0.32);
    }
    if (Math.random() < 0.75 * strength) this.emit(K.STEAM, [pos[0], pos[1] + 0.2, pos[2]], [dir[0] * 1.5, 0.6 + Math.random() * 0.6, dir[2] * 1.5], 1.0 + Math.random() * 0.8, 0.35 + strength * 0.6, 1.6, [0.93, 0.96, 0.99], 0.07);
  };
  P.exhaust = function (pos, vel, dark) {
    if (Math.random() > this.scale(pos)) return;
    var c = dark ? [0.2, 0.2, 0.21] : [0.42, 0.43, 0.46];
    this.emit(K.SMOKE, pos, [vel[0] * 0.3 + (Math.random() - 0.5) * 0.4, vel[1] * 0.3 + 0.4, vel[2] * 0.3 + (Math.random() - 0.5) * 0.4], 0.7 + Math.random() * 0.5, 0.1, 0.8, c, dark ? 0.16 : 0.08);
  };
  P.contrail = function (pos) {
    this.emit(K.CONTRAIL, pos, [0, 0, 0], 9 + Math.random() * 4, 0.35, 0.55, [0.97, 0.98, 1.0], 0.5);
  };
  P.dust = function (pos, strength, color) {
    var n = this.count(1 + strength * 5, pos);
    var c = color || [0.6, 0.53, 0.42];
    for (var i = 0; i < n; i++) this.emit(K.DUST, [pos[0] + (Math.random() - 0.5) * 0.6, pos[1] + 0.1, pos[2] + (Math.random() - 0.5) * 0.6], [(Math.random() - 0.5) * 1.5, 0.4 + Math.random() * 0.8 * strength, (Math.random() - 0.5) * 1.5], 1.2 + Math.random() * 1.2, 0.25 + strength * 0.4, 1.2, c, 0.28 * Math.min(1, strength + 0.3));
  };
  P.chips = function (pos, dir, n, wood) {
    var k = this.count(n, pos);
    for (var i = 0; i < k; i++) {
      var s = 2 + Math.random() * 3;
      var c = wood || [0.72, 0.55, 0.34];
      this.emit(K.CHIP, [pos[0], pos[1], pos[2]], [dir[0] * s + (Math.random() - 0.5) * 3, 1.5 + Math.random() * 3, dir[2] * s + (Math.random() - 0.5) * 3], 1.5 + Math.random() * 1.5, 0.025 + Math.random() * 0.03, 0, [c[0] * (0.8 + Math.random() * 0.4), c[1] * (0.8 + Math.random() * 0.4), c[2] * (0.8 + Math.random() * 0.4)], 1, Math.random() * 6);
    }
  };
  P.sparks = function (pos, n, speed) {
    var k = this.count(n, pos);
    for (var i = 0; i < k; i++) {
      var a = Math.random() * Math.PI * 2, e = Math.random() * 1.4 - 0.2, s = (speed || 2) * (0.4 + Math.random());
      this.emit(K.SPARK, pos, [Math.cos(a) * Math.cos(e) * s, Math.sin(e) * s + 0.5, Math.sin(a) * Math.cos(e) * s], 0.2 + Math.random() * 0.35, 0.012 + Math.random() * 0.01, -0.5, [1.0, 0.65, 0.25], 1);
    }
  };
  /** Dynamite / generic explosion visuals. */
  P.explosion = function (pos, power, inWater) {
    var c = this.engine.camera.world, d = Math.hypot(pos[0] - c[0], pos[1] - c[1], pos[2] - c[2]);
    var sc = U.clamp(1.4 - d / 400, 0.3, 1);
    var n = Math.floor(18 * power * sc) + 4;
    for (var i = 0; i < n; i++) {   // fireball
      var a = Math.random() * Math.PI * 2, e = Math.random() * 1.2, s = (3 + Math.random() * 7) * power;
      this.emit(K.FIRE, [pos[0], pos[1] + 0.3, pos[2]], [Math.cos(a) * Math.cos(e) * s, Math.sin(e) * s * 0.8 + 2, Math.sin(a) * Math.cos(e) * s], 0.35 + Math.random() * 0.35, 0.6 + Math.random() * 0.8 * power, 2.5, [1.0, 0.55 + Math.random() * 0.2, 0.18], 0.9);
    }
    var m = Math.floor(26 * power * sc) + 6;
    for (var j = 0; j < m; j++) {   // smoke column
      var a2 = Math.random() * Math.PI * 2, s2 = (1 + Math.random() * 3) * power;
      var g = 0.16 + Math.random() * 0.12;
      this.emit(K.SMOKE, [pos[0] + (Math.random() - 0.5) * power, pos[1] + 0.5 + Math.random() * power, pos[2] + (Math.random() - 0.5) * power], [Math.cos(a2) * s2, 2.5 + Math.random() * 4 * power, Math.sin(a2) * s2], 4 + Math.random() * 5, 0.8 + power * 0.6, 1.6 + power * 0.5, inWater ? [0.85, 0.88, 0.9] : [g, g * 0.95, g * 0.9], inWater ? 0.35 : 0.55);
    }
    this.sparks(pos, Math.floor(40 * power * sc), 9 * power);
    if (!inWater) {
      var db = Math.floor(30 * power * sc);
      for (var k = 0; k < db; k++) {   // debris: soil & stones
        var a3 = Math.random() * Math.PI * 2, e3 = 0.4 + Math.random() * 1.0, s3 = (4 + Math.random() * 9) * power;
        var gc = 0.2 + Math.random() * 0.15;
        this.emit(K.DEBRIS, [pos[0], pos[1] + 0.2, pos[2]], [Math.cos(a3) * Math.cos(e3) * s3, Math.sin(e3) * s3, Math.sin(a3) * Math.cos(e3) * s3], 2.5 + Math.random() * 2, 0.04 + Math.random() * 0.1 * power, 0, [gc * 1.1, gc, gc * 0.85], 1, Math.random() * 6);
      }
    } else this.splash(pos, Math.min(2.5, power * 1.5));
    this.lights.push({ pos: [pos[0], pos[1] + 1.5, pos[2]], color: [9, 5, 2], radius: 18 * power, age: 0, life: 0.45 });
    this.shake = Math.max(this.shake, U.clamp(1.2 - d / (60 * power), 0, 1) * 0.6);
  };

  /* ---------------- ambient rain interaction ---------------- */
  /** Canopy drips under trees and rain drumming on vehicles near the camera. */
  P._ambient = function (dt) {
    var E = this.engine, env = E.environment.env, L = E.environment.local, cam = E.camera.world;
    if (env.rain < 0.05 || env.underwater || env.snow > 0.5) return;
    var q = this.engine.settings.graphics.particleQuality; q = q === undefined ? 2 : q;
    var qs = [0.3, 0.6, 1, 1.4][U.clamp(q, 0, 3)];
    // leaves intercept the rain and release it in fewer, bigger drops
    var forest = L.forest || 0;
    this._dripAcc = (this._dripAcc || 0) + dt * env.rain * forest * 45 * qs;
    while (this._dripAcc >= 1) {
      this._dripAcc -= 1;
      var a = Math.random() * Math.PI * 2, r = 1 + Math.random() * 7, x = cam[0] + Math.cos(a) * r, z = cam[2] + Math.sin(a) * r;
      var gy = E.groundHeight(x, z);
      this.emit(K.WATER, [x, gy + 3 + Math.random() * 5, z], [0, -3, 0], 2.0, 0.014, 0, [0.8, 0.85, 0.9], 0.45);
    }
    // rain hitting hulls, wings and seats
    var V = E.vehicles;
    if (V) for (var i = 0; i < V.list.length; i++) {
      var v = V.list[i];
      if (!(v.camDist < 45)) continue;
      var info = v.info, top = v.cat === 'boat' ? info.D * 0.3 : (v.cat === 'plane' ? 0.95 : 0.95), span = v.cat === 'plane' ? [5.4, 1.2] : (v.cat === 'boat' ? [info.B * 0.45, info.L * 0.45] : [0.2, 0.7]);
      var n = env.rain * dt * span[0] * span[1] * 60 * qs, k2 = Math.floor(n) + (Math.random() < n % 1 ? 1 : 0);
      for (var j = 0; j < k2; j++) {
        var lx = (Math.random() * 2 - 1) * span[0], lz = (Math.random() * 2 - 1) * span[1];
        var cq = v.rq, p = v.rpos;
        // rotate the local point by the vehicle orientation (inline quaternion rotate)
        var qx = cq[0], qy = cq[1], qz = cq[2], qw = cq[3], vx = lx, vy = top, vz = lz;
        var ix = qw * vx + qy * vz - qz * vy, iy = qw * vy + qz * vx - qx * vz, iz = qw * vz + qx * vy - qy * vx, iw = -qx * vx - qy * vy - qz * vz;
        var wx = ix * qw + iw * -qx + iy * -qz - iz * -qy, wy = iy * qw + iw * -qy + iz * -qx - ix * -qz, wz = iz * qw + iw * -qz + ix * -qy - iy * -qx;
        this.emit(K.WATER, [p[0] + wx, p[1] + wy + 0.03, p[2] + wz], [(Math.random() - 0.5) * 0.8, 0.5 + Math.random() * 0.9, (Math.random() - 0.5) * 0.8], 0.22, 0.012, 0.05, [0.85, 0.9, 0.95], 0.4);
      }
    }
  };

  /* ---------------- simulation ---------------- */
  P.update = function (dt) {
    if (dt <= 0) return;
    this._ambient(dt);
    var d = this.data, E = this.engine, env = E.environment.env;
    var wx = env.windDir[0] * env.windStrength * 6, wz = env.windDir[1] * env.windStrength * 6;
    for (var i = 0; i < this.n; i++) {
      var o = i * FLOATS;
      d[o + 6] += dt;
      if (d[o + 6] >= d[o + 7]) {   // dead: swap with last
        this.n--;
        if (i !== this.n) { d.copyWithin(o, this.n * FLOATS, this.n * FLOATS + FLOATS); i--; }
        continue;
      }
      var kind = d[o + 14];
      var g = 9.81, drag = 0.15, buoy = 0, windK = 0.2;
      if (kind === K.SMOKE || kind === K.STEAM || kind === K.CONTRAIL || kind === K.DUST) { g = 0; drag = 1.2; buoy = kind === K.SMOKE ? 0.9 : (kind === K.STEAM ? 0.5 : 0.05); windK = 1; }
      else if (kind === K.FIRE) { g = 0; drag = 3.0; buoy = 3; windK = 0.3; }
      else if (kind === K.SPARK) { g = 6; drag = 0.6; }
      else if (kind === K.LEAF) { g = 1.5; drag = 2.0; windK = 1; }
      else if (kind === K.WATER) { drag = 0.4; }
      var k = Math.exp(-drag * dt);
      d[o + 3] = (d[o + 3] - wx * windK) * k + wx * windK;
      d[o + 5] = (d[o + 5] - wz * windK) * k + wz * windK;
      d[o + 4] = d[o + 4] * k + (buoy - g) * dt;
      d[o] += d[o + 3] * dt; d[o + 1] += d[o + 4] * dt; d[o + 2] += d[o + 5] * dt;
      d[o + 8] += d[o + 9] * dt;
      if (kind === K.CHIP || kind === K.DEBRIS || kind === K.WATER || kind === K.SPARK) {
        d[o + 15] += dt * 8;
        // cheap ground contact: each particle checks every 3rd frame, only while falling
        if (d[o + 4] > 0 || ((i + (E._fxTick | 0)) % 3) !== 0) continue;
        var gh = E.groundHeight(d[o], d[o + 2]);
        if (d[o + 1] < gh) {
          if (kind === K.WATER || kind === K.SPARK) { d[o + 6] = d[o + 7]; continue; }
          d[o + 1] = gh + 0.01; d[o + 4] = -d[o + 4] * 0.3; d[o + 3] *= 0.5; d[o + 5] *= 0.5;
          if (Math.abs(d[o + 4]) < 0.5) { d[o + 4] = 0; d[o + 3] *= 0.6; d[o + 5] *= 0.6; }
        }
      }
    }
    E._fxTick = (E._fxTick || 0) + 1;
    for (var l = this.lights.length - 1; l >= 0; l--) { var L = this.lights[l]; L.age += dt; if (L.age > L.life) this.lights.splice(l, 1); }
    this.shake = Math.max(0, this.shake - dt * 1.6);
  };

  /** Particles are drawn after lighting (forward), like weather particles. */
  P.drawParticles = function (frame) {
    var pv = this.preview, np = pv ? Math.min(pv.length, 200) : 0;
    if (!this.n && !np) return;
    var gl = this.gl, R = this.engine.renderer, o = frame.origin, d = this.data, a = this.inst;
    var nAll = Math.min(this.cap, this.n + np);
    for (var j = 0; j < np && this.n + j < this.cap; j++) {
      var t2 = (this.n + j) * 12, P2 = pv[j], fade = 1 - j / np;
      a[t2] = P2[0] - o[0]; a[t2 + 1] = P2[1]; a[t2 + 2] = P2[2] - o[1]; a[t2 + 3] = P2[3] || 0.035;
      a[t2 + 4] = 1.0; a[t2 + 5] = 0.95; a[t2 + 6] = 0.8; a[t2 + 7] = 0.85 * (0.35 + 0.65 * fade);
      a[t2 + 8] = K.MARKER; a[t2 + 9] = 0; a[t2 + 10] = 0; a[t2 + 11] = 0;
    }
    for (var i = 0; i < this.n; i++) {
      var s = i * FLOATS, t = i * 12, lf = d[s + 6] / d[s + 7];
      a[t] = d[s] - o[0]; a[t + 1] = d[s + 1]; a[t + 2] = d[s + 2] - o[1]; a[t + 3] = d[s + 8];
      var fadeIn = Math.min(1, lf * 8), fadeOut = 1 - lf * lf;
      a[t + 4] = d[s + 10]; a[t + 5] = d[s + 11]; a[t + 6] = d[s + 12]; a[t + 7] = d[s + 13] * fadeIn * fadeOut;
      var k = d[s + 14];
      var stretch = (k === K.SPARK || k === K.WATER) ? Math.min(3, Math.hypot(d[s + 3], d[s + 4], d[s + 5]) * 0.08) : 0;
      a[t + 8] = k; a[t + 9] = lf; a[t + 10] = d[s + 15]; a[t + 11] = stretch;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, a.subarray(0, nAll * 12));
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    var p = this.prog.use();
    R.sky.bindAtmo(p, 0);
    p.tex('uDepth', 2, R.targets.depth);
    var L = this.engine.environment.local;
    p.f('uSunVis', U.clamp(1 - (L.forest || 0) * 0.75, 0.2, 1));
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, nAll);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  };

  /* G-buffer hooks (nothing solid; debris are particles) */
  P.draw = function () {};
  P.drawMotion = function () {};

  TERRA.game.Effects = Effects;
})();
