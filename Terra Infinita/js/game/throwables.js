/* =============================================================================
 * TERRA INFINITA — physics playground: throwable objects
 * -----------------------------------------------------------------------------
 *   G        throw the selected object (hold Shift: throw harder)
 *   B        cycle object type: beach ball · mirror ball · wooden crate · barrel · rock
 *   Ctrl+G   remove all thrown objects
 *
 * Each object is a rigid body (position, velocity, orientation quaternion, angular
 * velocity) integrated at a fixed 120 Hz. Buoyancy is computed per sub-volume
 * against the real water surface (the same Gerstner swell as the water shader,
 * plus the river level), so objects bob on waves, tilt and right themselves,
 * drift with currents and waves, and sink if denser than water. Drag acts on
 * every sub-volume. Entering water and moving through it feed splashes and
 * wakes into the wave-equation ripple simulation. Bodies collide with the drawn
 * terrain (restitution + friction), with each other (spheres) and are pushed by
 * the player. They are drawn into the G-buffer with PBR materials, so they show
 * up in water reflections, SSR, path-traced reflections and shadows.
 * ========================================================================== */
(function () {
  'use strict';
  var S = TERRA.shaders, U = TERRA.util, M = TERRA.math;
  var MAX = 60, STEP = 1 / 120, RHO_W = 1000, GRAV = 9.81, CYCLE = 5;

  var TYPES = [
    { name: 'Beach ball', shape: 'sphere', size: [0.33, 0.33, 0.33], density: 45, color: [1, 1, 1], e: 0.68, mu: 0.4, mesh: 0 },
    { name: 'Mirror ball', shape: 'sphere', size: [0.38, 0.38, 0.38], density: 330, color: [1, 1, 1], e: 0.35, mu: 0.3, mesh: 1 },
    { name: 'Wooden crate', shape: 'box', size: [0.42, 0.42, 0.42], density: 480, color: [1, 1, 1], e: 0.15, mu: 0.7, mesh: 2 },
    { name: 'Barrel', shape: 'cyl', size: [0.32, 0.48, 0.32], density: 280, color: [0.58, 0.09, 0.06], e: 0.2, mu: 0.6, mesh: 3 },
    { name: 'Rock (sinks)', shape: 'box', size: [0.3, 0.22, 0.28], density: 2600, color: [1, 1, 1], e: 0.1, mu: 0.85, mesh: 4 },
    // hand-thrown items and cut timber (tools)
    { name: 'Stone', shape: 'box', size: [0.05, 0.038, 0.045], density: 2600, color: [1, 1, 1], e: 0.22, mu: 0.8, mesh: 4, snd: 'stone' },
    { name: 'Dynamite', shape: 'cyl', size: [0.036, 0.105, 0.036], density: 1250, color: [0.78, 0.12, 0.08], e: 0.25, mu: 0.6, mesh: 3, kind: 5, snd: 'stick' },
    { name: 'Log', shape: 'cyl', size: [0.2, 0.9, 0.2], density: 640, color: [0.45, 0.38, 0.3], e: 0.08, mu: 0.75, mesh: 3, kind: 6, snd: 'log' }
  ];

  /* ---------------- shaders ---------------- */
  S.throwVS = [
    '#include <frame>',
    'layout(location = 0) in vec3 aPos;',
    'layout(location = 1) in vec4 aNormal;',
    'layout(location = 2) in vec2 aUV;',
    'uniform mat4 uModel; uniform vec3 uScale; uniform int uShadowPass; uniform mat4 uShadowVP;',
    'out vec3 vWorld; out vec3 vNormal; out vec2 vUV; out vec3 vObj;',
    '#ifdef MOTION',
    'uniform vec3 uLinVel; uniform vec3 uAngVel; uniform vec3 uCOM; out vec3 vVel; out float vFlag;',
    '#endif',
    'void main(){',
    '  vec4 wp = uModel * vec4(aPos * uScale, 1.0);',
    '  vWorld = wp.xyz; vNormal = normalize(mat3(uModel) * (aNormal.xyz / uScale)); vUV = aUV; vObj = aPos;',
    '#ifdef MOTION',
    '  vVel = uLinVel + cross(uAngVel, wp.xyz - uCOM); vFlag = 1.0;',
    '#endif',
    '  gl_Position = uShadowPass == 1 ? uShadowVP * wp : uViewProj * wp;',
    '}'
  ].join('\n');
  S.throwFS = [
    '#include <frame>',
    '#include <common>',
    '#ifdef SHADOW',
    'out vec4 oDummy;',
    'void main(){ oDummy = vec4(1.0); }',
    '#else',
    '#include <gbufferOut>',
    'in vec3 vWorld; in vec3 vNormal; in vec2 vUV; in vec3 vObj;',
    'uniform int uKind; uniform vec3 uColor; uniform float uWet; uniform vec3 uScale;',
    'uniform highp sampler2DArray uAlbedoH; uniform highp sampler2DArray uNormalR;',
    'void main(){',
    '  vec3 N = normalize(vNormal); vec3 albedo = uColor; float rough = 0.5, metal = 0.0, ao = 1.0;',
    '  if (uKind == 0) {',
    '    // beach ball: six coloured gores around the axis, white caps',
    '    float a = atan(vObj.z, vObj.x) / TAU + 0.5; int seg = int(floor(a * 6.0)) % 6;',
    '    vec3 cols[6] = vec3[](vec3(0.86, 0.07, 0.05), vec3(0.93), vec3(0.05, 0.22, 0.78), vec3(0.95, 0.74, 0.04), vec3(0.93), vec3(0.08, 0.58, 0.14));',
    '    albedo = abs(vObj.y) > 0.9 ? vec3(0.93) : cols[seg];',
    '    rough = 0.22;',
    '  } else if (uKind == 1) {',
    '    albedo = vec3(0.97, 0.96, 0.94); metal = 1.0; rough = 0.025;   // mirror ball: tests reflections',
    '  } else if (uKind == 2) {',
    '    // crate: planks with a darker frame along the edges',
    '    vec4 w = texture(uAlbedoH, vec3(vUV * vec2(1.0, 0.5), 14.0));',
    '    vec3 q = abs(vObj); float e1 = min(q.x, q.y), e2 = min(q.y, q.z), e3 = min(q.x, q.z);',
    '    float frame = smoothstep(0.8, 0.84, max(max(e1, e2), e3));',
    '    albedo = saturate(w.rgb * vec3(2.1, 1.95, 1.7)) * mix(1.0, 0.6, frame); rough = 0.72;   // pale pine planks, darker frame',
    '    vec4 nr = texture(uNormalR, vec3(vUV * vec2(1.0, 0.5), 14.0));',
    '    vec3 T = normalize(cross(N, abs(N.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0))); vec3 B = cross(N, T);',
    '    N = normalize(N + (T * (nr.x - 0.5) + B * (nr.y - 0.5)) * 0.8);',
    '  } else if (uKind == 3) {',
    '    // painted steel barrel with raised steel hoops',
    '    float hoop = smoothstep(0.035, 0.0, abs(abs(vObj.y) - 0.52)) + smoothstep(0.93, 0.97, abs(vObj.y));',
    '    albedo = mix(uColor, vec3(0.32, 0.33, 0.35), saturate(hoop)); rough = mix(0.3, 0.25, hoop); metal = saturate(hoop) * 0.9;',
    '  } else if (uKind == 5) {',
    '    // dynamite stick: red paper wrap, printed band, waxed ends',
    '    float band = step(abs(vObj.y), 0.22);',
    '    albedo = mix(vec3(0.72, 0.1, 0.06), vec3(0.85, 0.78, 0.55), band * step(0.1, abs(vObj.y)));',
    '    albedo = mix(albedo, vec3(0.08), band * step(abs(vObj.y), 0.1));',
    '    if (abs(vObj.y) > 0.97) albedo = vec3(0.82, 0.74, 0.55);',
    '    rough = 0.55;',
    '  } else if (uKind == 6) {',
    '    // log: bark around, end grain with growth rings on the cut faces',
    '    float ang = atan(vObj.z, vObj.x);',
    '    if (abs(N.y) < 0.6 || abs(vObj.y) < 0.95) {',
    '      vec3 bk = texture(uAlbedoH, vec3(ang / TAU * 3.0 * uScale.x * 6.0, vObj.y * uScale.y * 0.9, 13.0)).rgb;',
    '      albedo = saturate(bk * uColor * 2.3); rough = 0.88;',
    '      vec4 nr = texture(uNormalR, vec3(ang / TAU * 3.0 * uScale.x * 6.0, vObj.y * uScale.y * 0.9, 13.0));',
    '      vec3 T = normalize(cross(vec3(0.0, 1.0, 0.0), N) + 1e-4); vec3 B = cross(N, T);',
    '      N = normalize(N + (T * (nr.x - 0.5) + B * (nr.y - 0.5)) * 1.2);',
    '    } else {',
    '      float rr = length(vObj.xz); float wob = vnoise3(vObj * 3.0) * 0.5;',
    '      float ring = fract(rr * uScale.x * 42.0 + wob); float late = smoothstep(0.62, 0.95, ring) * 0.55;',
    '      albedo = mix(vec3(0.8, 0.66, 0.46), vec3(0.56, 0.37, 0.21), smoothstep(0.72, 0.5, rr + wob * 0.1)) * (1.0 - late * 0.45);',
    '      float crack = smoothstep(0.94, 1.0, abs(sin(ang * 2.5 + wob * 4.0))) * smoothstep(0.12, 0.3, rr) * smoothstep(0.98, 0.7, rr);',
    '      albedo *= 1.0 - crack * 0.7; albedo = mix(albedo, vec3(0.26, 0.19, 0.13), smoothstep(0.9, 0.98, rr)); rough = 0.82;',
    '    }',
    '  } else {',
    '    vec3 bw = pow(abs(normalize(vObj + 1e-4)), vec3(4.0)); bw /= dot(bw, vec3(1.0)); vec3 op = vObj * 0.6;',
    '    vec4 a = texture(uAlbedoH, vec3(op.zy, 3.0)) * bw.x + texture(uAlbedoH, vec3(op.xz, 3.0)) * bw.y + texture(uAlbedoH, vec3(op.xy, 3.0)) * bw.z;',
    '    albedo = a.rgb; rough = 0.82;',
    '  }',
    '  // wet after being in water: darker, glossier',
    '  albedo *= mix(1.0, 0.72, uWet * (1.0 - metal)); rough = mix(rough, rough * 0.45, uWet);',
    '  gAlbedo = vec4(saturate(albedo), ao);',
    '  gNormal = vec4(N, clamp(rough, 0.02, 1.0));',
    '  gMaterial = vec4(metal, uWet * 0.3, 0.0, 0.0);',
    '}',
    '#endif'
  ].join('\n');

  /* ---------------- small quaternion helpers ---------------- */
  function qmul(a, b) {
    return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
  }
  function qnorm(q) { var l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; q[0] /= l; q[1] /= l; q[2] /= l; q[3] /= l; return q; }
  function qrot(q, v) {
    var x = q[0], y = q[1], z = q[2], w = q[3];
    var ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
    return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
  }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  /** Sub-volumes (local centre, volume fraction, vertical half-extent) and collision points per shape. */
  function samplesFor(t) {
    var s = t.size, sub = [], col = [];
    if (t.shape === 'sphere') {
      for (var i = 0; i < 8; i++) { var sx = i & 1 ? 1 : -1, sy = i & 2 ? 1 : -1, sz = i & 4 ? 1 : -1; sub.push({ p: [sx * s[0] * 0.42, sy * s[1] * 0.42, sz * s[2] * 0.42], v: 1 / 8, h: s[1] * 0.5 }); }
      col.push([0, 0, 0]);
    } else {
      for (var k = 0; k < 8; k++) {
        var ax = k & 1 ? 1 : -1, ay = k & 2 ? 1 : -1, az = k & 4 ? 1 : -1;
        sub.push({ p: [ax * s[0] * 0.5, ay * s[1] * 0.5, az * s[2] * 0.5], v: 1 / 8, h: s[1] * 0.5 });
        col.push(t.shape === 'cyl' ? [ax * s[0] * 0.707, ay * s[1], az * s[2] * 0.707] : [ax * s[0], ay * s[1], az * s[2]]);
      }
    }
    var vol = t.shape === 'sphere' ? 4 / 3 * Math.PI * s[0] * s[1] * s[2] : (t.shape === 'cyl' ? Math.PI * s[0] * s[2] * 2 * s[1] : 8 * s[0] * s[1] * s[2]);
    return { sub: sub, col: col, vol: vol, radius: Math.hypot(s[0], s[1], s[2]) * (t.shape === 'sphere' ? 0.58 : 0.85) };
  }

  function Throwables(engine) {
    this.engine = engine;
    var G = this.G = engine.renderer.G;
    this.gl = G.gl;
    this.meshes = TERRA.world.Models.buildThrowables(G);
    this.prog = G.program('throwable', S.throwVS, S.throwFS);
    this.progShadow = G.program('throwableShadow', S.throwVS, S.throwFS, { SHADOW: 1 });
    this.progMotion = G.program('throwableMotion', S.throwVS, S.motionFS, { MOTION: 1 });
    this.objs = [];
    this.kind = 0;
    this.acc = 0;
    this.model = new Float32Array(16);
    this.samples = TYPES.map(samplesFor);
  }
  var P = Throwables.prototype;
  Throwables.TYPES = TYPES;

  P.clear = function () { this.objs.length = 0; };
  P.smpFor = function (o) { return o.smp || this.samples[o.kind]; };
  P.sizeFor = function (o) { return o.size || TYPES[o.kind].size; };
  /** Generic spawn (tools: thrown stones, dynamite, logs). opts: size (per-object), q, w, fuse */
  P.spawn = function (kind, pos, vel, opts) {
    opts = opts || {};
    var t = TYPES[kind], size = opts.size || null;
    var smp = size ? samplesFor({ shape: t.shape, size: size }) : this.samples[kind];
    var o = {
      kind: kind, pos: pos.slice(), vel: vel ? vel.slice() : [0, 0, 0],
      q: opts.q ? qnorm(opts.q.slice()) : qnorm([Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5, 1]),
      w: opts.w ? opts.w.slice() : [(Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6],
      mass: t.density * smp.vol, wet: 0, inWater: 0, sleep: 0, water: null, waterT: 0, splashT: 0, wakeT: 0, sndT: 0
    };
    if (size) { o.size = size.slice(); o.smp = smp; }
    if (opts.fuse !== undefined) o.fuse = opts.fuse;
    o.inertia = o.mass * smp.radius * smp.radius * 0.4;
    this.objs.push(o);
    this._trim();
    return o;
  };
  /** Over the cap: drop the oldest objects that are asleep / far away first (never held or lit ones). */
  P._trim = function () {
    var cam = this.engine.camera.world;
    while (this.objs.length > MAX) {
      var bi = -1, bs = -1;
      for (var i = 0; i < this.objs.length; i++) {
        var o = this.objs[i]; if (o.held || o.fuse !== undefined) continue;
        var sc = Math.hypot(o.pos[0] - cam[0], o.pos[2] - cam[2]) + (o.sleep > 1.5 ? 200 : 0) + (this.objs.length - i);
        if (sc > bs) { bs = sc; bi = i; }
      }
      if (bi < 0) break;
      this.objs.splice(bi, 1);
    }
  };
  P.remove = function (o) { var i = this.objs.indexOf(o); if (i >= 0) this.objs.splice(i, 1); };
  P.cycle = function () {
    this.kind = (this.kind + 1) % CYCLE;
    TERRA.ui.toast('Throw object: ' + TYPES[this.kind].name + ' (G to throw, B to change)');
  };

  /** Throw the selected object from the camera. */
  P.throwObject = function (hard) {
    var E = this.engine, pl = E.player, cam = E.camera.world, f = pl.forward;
    var t = TYPES[this.kind], smp = this.samples[this.kind];
    var speed = hard ? 19 : 12;
    var pos = [cam[0] + f[0] * 0.9, cam[1] + f[1] * 0.9 - 0.15, cam[2] + f[2] * 0.9];
    var gh = E.groundHeight(pos[0], pos[2]);
    if (pos[1] < gh + smp.radius) pos[1] = gh + smp.radius + 0.05;
    var pv = pl.vel || [0, 0, 0];
    var o = {
      kind: this.kind, pos: pos, vel: [f[0] * speed + pv[0] * 0.8, f[1] * speed + 2.2 + pv[1] * 0.5, f[2] * speed + pv[2] * 0.8],
      q: qnorm([Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5, 1]),
      w: [(Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8],
      mass: t.density * smp.vol, wet: 0, inWater: 0, sleep: 0, water: null, waterT: 0, splashT: 0, wakeT: 0
    };
    o.inertia = o.mass * smp.radius * smp.radius * 0.4;
    this.objs.push(o);
    this._trim();
    if (E.audio && E.audio.click) E.audio.click();
  };

  P._waterInfo = function (o) {
    var E = this.engine;
    o.waterT -= 1;
    if (!o.water || o.waterT <= 0 || Math.abs(o.pos[0] - o.water.x) + Math.abs(o.pos[2] - o.water.z) > 2) {
      var w = E.waterAt(o.pos[0], o.pos[2]);
      o.water = { x: o.pos[0], z: o.pos[2], level: w.level, type: w.type, fx: w.fx || 0, fz: w.fz || 0 };
      o.waterT = 30;
    }
    return o.water;
  };

  P.update = function (dt) {
    if (!this.objs.length || dt <= 0) return;
    var q = this.engine.settings.graphics.physicsQuality; q = q === undefined ? 2 : q;
    var step = [1 / 60, 1 / 90, 1 / 120, 1 / 160][U.clamp(q, 0, 3)];
    this.acc = Math.min(this.acc + dt, step * 6);
    // distance activation: bodies far from the camera are frozen until it comes back
    var cam = this.engine.camera.world;
    var CM = this.engine.chunks;
    for (var a = 0; a < this.objs.length; a++) {
      var b = this.objs[a];
      if (b.held) { b.frozen = false; continue; }
      // far away, or over terrain that is only loaded coarsely (it would fall through): freeze
      var far = Math.hypot(b.pos[0] - cam[0], b.pos[2] - cam[2]) > 220;
      var fn = CM && CM.finestNode ? CM.finestNode(b.pos[0], b.pos[2]) : null;
      b.frozen = (far && b.fuse === undefined) || (fn ? fn.level > 1 : false);
    }
    while (this.acc >= step) { this.acc -= step; this._step(step); }
    for (var i = this.objs.length - 1; i >= 0; i--) {
      var o = this.objs[i]; o.wet = o.inWater > 0.05 ? 1 : Math.max(0, o.wet - dt / 25);
      o.sndT = (o.sndT || 0) - dt;
      if (o.fuse !== undefined) {
        o.fuse -= dt;
        if (this.onFuse) this.onFuse(o, dt);
        if (o.fuse <= 0) { this.objs.splice(i, 1); if (this.onExplode) this.onExplode(o); }
      }
    }
  };

  P._step = function (h) {
    var E = this.engine, env = E.environment.env, Wt = TERRA.world.Water, t = E.time, org = E.origin;
    var objs = this.objs, pl = E.player;
    for (var oi = 0; oi < objs.length; oi++) {
      var o = objs[oi], T = TYPES[o.kind], smp = this.smpFor(o);
      if (o.held || o.frozen) continue;
      if (o.sleep > 1.5) {
        // asleep on the ground: wake only if the player comes close
        if (Math.hypot(o.pos[0] - pl.pos[0], o.pos[2] - pl.pos[2]) < smp.radius + 0.7) o.sleep = 0; else continue;
      }
      var F = [0, -GRAV * o.mass, 0], Tq = [0, 0, 0];
      // air drag
      var sp = Math.hypot(o.vel[0], o.vel[1], o.vel[2]);
      var airK = 0.6 * smp.radius * smp.radius * sp;
      F[0] -= o.vel[0] * airK; F[1] -= o.vel[1] * airK; F[2] -= o.vel[2] * airK;
      // ---- water: buoyancy & drag per sub-volume against the wavy surface
      var wi = this._waterInfo(o), sub = smp.sub, subm = 0, Kd = 0;
      if (wi.level > -1e4 && wi.type !== 4) {
        for (var k = 0; k < sub.length; k++) {
          var r = qrot(o.q, sub[k].p);
          var px = o.pos[0] + r[0], py = o.pos[1] + r[1], pz = o.pos[2] + r[2];
          var surf = wi.level + Wt.waveHeight(px - org[0], pz - org[1], t, wi.type, env);
          var f = U.clamp01((surf - py) / (2 * sub[k].h) + 0.5);
          if (f <= 0) continue;
          subm += f * sub[k].v;
          var vol = smp.vol * sub[k].v * f;
          // velocity of this point relative to the water (rivers flow; swell surfaces push toward the troughs)
          var pv = cross(o.w, r);
          var rv = [o.vel[0] + pv[0] - wi.fx, o.vel[1] + pv[1], o.vel[2] + pv[2] - wi.fz];
          var rs = Math.hypot(rv[0], rv[1], rv[2]);
          var kd = RHO_W * Math.pow(vol, 0.6667) * (0.9 + 1.1 * rs);
          var e = 0.6;
          var gx = (Wt.waveHeight(px - org[0] + e, pz - org[1], t, wi.type, env) - Wt.waveHeight(px - org[0] - e, pz - org[1], t, wi.type, env)) / (2 * e);
          var gz = (Wt.waveHeight(px - org[0], pz - org[1] + e, t, wi.type, env) - Wt.waveHeight(px - org[0], pz - org[1] - e, t, wi.type, env)) / (2 * e);
          var fb = RHO_W * GRAV * vol;
          Kd += kd;   // drag is applied implicitly after integration (stable for light, fast objects)
          // the swell's push decays with depth (wave orbital motion ~ e^(-k·depth))
          var wpush = 0.35 * Math.exp(-Math.max(0, surf - py) / 1.2);
          var fp = [-gx * fb * wpush, fb, -gz * fb * wpush];
          F[0] += fp[0]; F[1] += fp[1]; F[2] += fp[2];
          var tq = cross(r, fp); Tq[0] += tq[0]; Tq[1] += tq[1]; Tq[2] += tq[2];
        }
        // entering the water: splash proportional to impact speed and size
        if (subm > 0.02 && o.inWater <= 0.02 && o.vel[1] < -1.2 && o.splashT <= 0) {
          TERRA.events.emit('splash', { pos: [o.pos[0], wi.level, o.pos[2]], strength: U.clamp01(-o.vel[1] / 10) * U.clamp(smp.radius * 2.2, 0.4, 1.2) });
          o.splashT = 0.4;
        }
        // wakes and bobbing ripples
        o.wakeT -= h;
        if (subm > 0.02 && subm < 0.98 && o.wakeT <= 0 && E.watersim) {
          var ms = Math.hypot(o.vel[0] - wi.fx, o.vel[2] - wi.fz) + Math.abs(o.vel[1]) * 1.5;
          if (ms > 0.15) E.watersim.addDrop(o.pos[0], o.pos[2], smp.radius * 1.2, U.clamp(ms * 0.012, 0.003, 0.05));
          o.wakeT = 0.12;
        }
      }
      o.inWater = subm; o.splashT -= h;
      // angular damping (air + water)
      var ad = 0.2 + subm * 3.0;
      Tq[0] -= o.w[0] * ad * o.inertia; Tq[1] -= o.w[1] * ad * o.inertia; Tq[2] -= o.w[2] * ad * o.inertia;
      // ---- integrate
      for (var a = 0; a < 3; a++) { o.vel[a] += F[a] / o.mass * h; o.w[a] += Tq[a] / o.inertia * h; }
      if (Kd > 0) {
        // implicit linear drag relative to the moving water (rivers carry objects downstream)
        var damp = 1 / (1 + Kd / o.mass * h);
        o.vel[0] = wi.fx + (o.vel[0] - wi.fx) * damp; o.vel[1] *= damp; o.vel[2] = wi.fz + (o.vel[2] - wi.fz) * damp;
      }
      o.pos[0] += o.vel[0] * h; o.pos[1] += o.vel[1] * h; o.pos[2] += o.vel[2] * h;
      var dq = qmul([o.w[0] * h * 0.5, o.w[1] * h * 0.5, o.w[2] * h * 0.5, 0], o.q);
      o.q = qnorm([o.q[0] + dq[0], o.q[1] + dq[1], o.q[2] + dq[2], o.q[3] + dq[3]]);
      // ---- ground contacts (drawn terrain)
      this._ground(o, T, smp);
      // ---- player pushes objects
      var dxp = o.pos[0] - pl.pos[0], dzp = o.pos[2] - pl.pos[2], dp = Math.hypot(dxp, dzp), rr = smp.radius + 0.4;
      if (dp < rr && o.pos[1] > pl.pos[1] - 0.5 && o.pos[1] < pl.pos[1] + 2.0 && pl.mode !== 'free') {
        var nx = dxp / (dp || 1), nz = dzp / (dp || 1), push = rr - dp;
        o.pos[0] += nx * push; o.pos[2] += nz * push;
        var pvn = (pl.vel[0] * nx + pl.vel[2] * nz), ovn = o.vel[0] * nx + o.vel[2] * nz;
        if (ovn < pvn) { o.vel[0] += nx * (pvn - ovn + 0.5); o.vel[2] += nz * (pvn - ovn + 0.5); }
        o.sleep = 0;
      }
      // sleep when at rest out of the water
      var lin = Math.hypot(o.vel[0], o.vel[1], o.vel[2]), ang = Math.hypot(o.w[0], o.w[1], o.w[2]);
      if (subm < 0.01 && lin < 0.08 && ang < 0.12 && o.grounded) o.sleep += h; else o.sleep = 0;
      if (o.sleep > 1.5) { o.vel[0] = o.vel[1] = o.vel[2] = 0; o.w[0] = o.w[1] = o.w[2] = 0; }
    }
    // ---- object vs object (bounding spheres); broad phase: a 2 m spatial hash when crowded
    var pairs = this._pairs(objs);
    for (var pi = 0; pi < pairs.length; pi += 2) {
      var A = objs[pairs[pi]], Bo = objs[pairs[pi + 1]];
      if (A.held || Bo.held || (A.sleep > 1.5 && Bo.sleep > 1.5)) continue;
      var ra = this.smpFor(A).radius, rb = this.smpFor(Bo).radius;
      var d = [Bo.pos[0] - A.pos[0], Bo.pos[1] - A.pos[1], Bo.pos[2] - A.pos[2]], dl = Math.hypot(d[0], d[1], d[2]);
      if (dl >= ra + rb || dl < 1e-5) continue;
      var n = [d[0] / dl, d[1] / dl, d[2] / dl], pen = ra + rb - dl, wa = 1 / A.mass, wb = 1 / Bo.mass, ws = wa + wb;
      for (var c = 0; c < 3; c++) { A.pos[c] -= n[c] * pen * wa / ws; Bo.pos[c] += n[c] * pen * wb / ws; }
      var vr = (Bo.vel[0] - A.vel[0]) * n[0] + (Bo.vel[1] - A.vel[1]) * n[1] + (Bo.vel[2] - A.vel[2]) * n[2];
      if (vr < 0) {
        var jimp = -(1 + Math.min(TYPES[A.kind].e, TYPES[Bo.kind].e)) * vr / ws;
        for (c = 0; c < 3; c++) { A.vel[c] -= n[c] * jimp * wa; Bo.vel[c] += n[c] * jimp * wb; }
      }
      A.sleep = 0; Bo.sleep = 0;
    }
  };

  P._pairs = function (objs) {
    var out = this._pairBuf || (this._pairBuf = []); out.length = 0;
    var n = objs.length;
    if (n < 16) { for (var i = 0; i < n; i++) for (var j = i + 1; j < n; j++) out.push(i, j); return out; }
    var grid = new Map(), C = 2;
    for (var k = 0; k < n; k++) {
      var o = objs[k], key = Math.floor(o.pos[0] / C) + ':' + Math.floor(o.pos[1] / C) + ':' + Math.floor(o.pos[2] / C);
      var l = grid.get(key); if (!l) grid.set(key, l = []); l.push(k);
    }
    for (var a = 0; a < n; a++) {
      var p = objs[a].pos, cx = Math.floor(p[0] / C), cy = Math.floor(p[1] / C), cz = Math.floor(p[2] / C);
      for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) for (var dz = -1; dz <= 1; dz++) {
        var lst = grid.get((cx + dx) + ':' + (cy + dy) + ':' + (cz + dz));
        if (!lst) continue;
        for (var m = 0; m < lst.length; m++) if (lst[m] > a) out.push(a, lst[m]);
      }
    }
    return out;
  };

  /** Contact with the drawn terrain: every touching point is resolved (two passes of sequential
   *  impulses) with restitution and Coulomb friction; resting contacts are damped so bodies settle. */
  P._ground = function (o, T, smp) {
    var E = this.engine, pts = smp.col, sphere = T.shape === 'sphere';
    o.grounded = false;
    var contacts = [], maxPen = 0, nAvg = [0, 0, 0];
    for (var k = 0; k < pts.length; k++) {
      var r = qrot(o.q, pts[k]);
      var x = o.pos[0] + r[0], z = o.pos[2] + r[2];
      var y = o.pos[1] + r[1] - (sphere ? this.sizeFor(o)[1] : 0);
      var pen = E.groundHeight(x, z) - y;
      if (pen <= 0) continue;
      var e = 0.4;
      var hx = E.groundHeight(x + e, z) - E.groundHeight(x - e, z), hz = E.groundHeight(x, z + e) - E.groundHeight(x, z - e);
      var n = [-hx / (2 * e), 1, -hz / (2 * e)], nl = Math.hypot(n[0], n[1], n[2]); n = [n[0] / nl, n[1] / nl, n[2] / nl];
      var sz = this.sizeFor(o);
      contacts.push({ r: sphere ? [-n[0] * sz[0], -n[1] * sz[1], -n[2] * sz[2]] : r, n: n });
      if (pen > maxPen) maxPen = pen;
      nAvg[0] += n[0]; nAvg[1] += n[1]; nAvg[2] += n[2];
    }
    if (!contacts.length) return;
    o.grounded = true;
    var nl2 = Math.hypot(nAvg[0], nAvg[1], nAvg[2]);
    o.pos[0] += nAvg[0] / nl2 * maxPen; o.pos[1] += nAvg[1] / nl2 * maxPen; o.pos[2] += nAvg[2] / nl2 * maxPen;
    var im = 1 / o.mass;
    for (var pass = 0; pass < 2; pass++) {
      for (var c = 0; c < contacts.length; c++) {
        var rc = contacts[c].r, cn = contacts[c].n;
        var vc = cross(o.w, rc); vc = [o.vel[0] + vc[0], o.vel[1] + vc[1], o.vel[2] + vc[2]];
        var vn = dot(vc, cn);
        if (vn >= 0) continue;
        if (pass === 0 && vn < -2.2 && o.sndT <= 0 && this.onImpact) { o.sndT = 0.12; this.onImpact(o, -vn); }
        var rn = cross(rc, cn), ii = dot(rn, rn) / o.inertia;
        var e2 = (pass === 0 && vn < -1.0) ? T.e : 0;
        var jn = -(1 + e2) * vn / (im + ii) / (pass === 0 ? 1 : contacts.length);
        var J = [cn[0] * jn, cn[1] * jn, cn[2] * jn];
        var vt = [vc[0] - cn[0] * vn, vc[1] - cn[1] * vn, vc[2] - cn[2] * vn], vtl = Math.hypot(vt[0], vt[1], vt[2]);
        if (vtl > 1e-4) {
          var td = [vt[0] / vtl, vt[1] / vtl, vt[2] / vtl], rt = cross(rc, td);
          var jt = Math.min(vtl / (im + dot(rt, rt) / o.inertia), T.mu * jn);
          J[0] -= td[0] * jt; J[1] -= td[1] * jt; J[2] -= td[2] * jt;
        }
        for (var a = 0; a < 3; a++) o.vel[a] += J[a] * im;
        var dw = cross(rc, J);
        for (a = 0; a < 3; a++) o.w[a] += dw[a] / o.inertia;
      }
    }
    // rolling resistance; resting contacts settle quickly (no endless rocking)
    var lin = Math.hypot(o.vel[0], o.vel[1], o.vel[2]), ang = Math.hypot(o.w[0], o.w[1], o.w[2]);
    var rk = sphere ? 0.996 : (contacts.length >= 3 && lin < 0.5 && ang < 1.5 ? 0.85 : 0.97);
    o.w[0] *= rk; o.w[1] *= rk; o.w[2] *= rk;
    if (!sphere && contacts.length >= 3 && lin < 0.25) { o.vel[0] *= 0.9; o.vel[2] *= 0.9; }
  };

  /* ---------------- rendering ---------------- */
  P._modelMatrix = function (o, origin) {
    var q = o.q, x = q[0], y = q[1], z = q[2], w = q[3], m = this.model;
    m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y + z * w); m[2] = 2 * (x * z - y * w); m[3] = 0;
    m[4] = 2 * (x * y - z * w); m[5] = 1 - 2 * (x * x + z * z); m[6] = 2 * (y * z + x * w); m[7] = 0;
    m[8] = 2 * (x * z + y * w); m[9] = 2 * (y * z - x * w); m[10] = 1 - 2 * (x * x + y * y); m[11] = 0;
    m[12] = o.pos[0] - origin[0]; m[13] = o.pos[1]; m[14] = o.pos[2] - origin[1]; m[15] = 1;
    return m;
  };
  P._draw = function (p, frame, shadow, vp) {
    if (!this.objs.length) return;
    var gl = this.gl, R = this.engine.renderer, planes = frame.cam.planes, o = frame.origin;
    p.use();
    if (!shadow) p.tex('uAlbedoH', 0, R.tex.matAlbedo, gl.TEXTURE_2D_ARRAY).tex('uNormalR', 1, R.tex.matNormal, gl.TEXTURE_2D_ARRAY);
    p.i('uShadowPass', shadow ? 1 : 0);
    if (shadow) p.m4('uShadowVP', vp);
    var cam = frame.cam.world;
    for (var i = 0; i < this.objs.length; i++) {
      var ob = this.objs[i], T = TYPES[ob.kind], smp = this.smpFor(ob), sz = this.sizeFor(ob);
      if (!shadow && !M.sphereInFrustum(planes, ob.pos[0] - o[0], ob.pos[1], ob.pos[2] - o[1], smp.radius * 1.5, 0)) continue;
      if (shadow && Math.hypot(ob.pos[0] - cam[0], ob.pos[2] - cam[2]) > 160) continue;
      var mesh = this.meshes[T.mesh];
      p.m4('uModel', this._modelMatrix(ob, o)).v3('uScale', sz[0], sz[1], sz[2]);
      if (!shadow) p.i('uKind', T.kind !== undefined ? T.kind : T.mesh).v3('uColor', T.color[0], T.color[1], T.color[2]).f('uWet', ob.wet);
      gl.bindVertexArray(mesh.vao);
      gl.drawElements(gl.TRIANGLES, mesh.count, mesh.indexType, 0);
      this.G.stats.drawCalls++;
    }
    gl.bindVertexArray(null);
  };
  P.drawGBuffer = function (frame) { this._draw(this.prog, frame, false); };
  /** World velocity of moving bodies → motion buffer (frame extrapolation). */
  P.drawMotion = function (frame) {
    if (!this.objs.length) return;
    var gl = this.gl, o = frame.origin, p = this.progMotion.use();
    p.i('uShadowPass', 0);
    for (var i = 0; i < this.objs.length; i++) {
      var ob = this.objs[i], T = TYPES[ob.kind];
      if (ob.sleep > 1.5 || ob.frozen) continue;
      var mesh = this.meshes[T.mesh], sz = this.sizeFor(ob);
      p.m4('uModel', this._modelMatrix(ob, o)).v3('uScale', sz[0], sz[1], sz[2]);
      p.v3('uLinVel', ob.vel[0], ob.vel[1], ob.vel[2]).v3('uAngVel', ob.w[0], ob.w[1], ob.w[2]).v3('uCOM', ob.pos[0] - o[0], ob.pos[1], ob.pos[2] - o[1]);
      gl.bindVertexArray(mesh.vao);
      gl.drawElements(gl.TRIANGLES, mesh.count, mesh.indexType, 0);
    }
    gl.bindVertexArray(null);
  };
  P.drawShadow = function (frame, vp) { this._draw(this.progShadow, frame, true, vp); };

  TERRA.game.Throwables = Throwables;
})();
