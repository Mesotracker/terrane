/* =============================================================================
 * TERRA INFINITA — vehicles: boats, aircraft and bikes
 * -----------------------------------------------------------------------------
 *   N        vehicle menu (1–7 spawns one in front of you)
 *   F        enter / leave the nearest vehicle
 *   V        chase camera / cockpit camera        R  reset (upright / repair)
 *   L        lights
 *
 * Boats   rigid bodies floating on the real water surface: buoyancy is integrated
 *         over a grid of hull columns against the same Gerstner swell the water
 *         shader draws, so hulls heave, pitch and roll on waves. Hydrodynamics:
 *         Froude-number resistance with a displacement "hump" and planing lift
 *         (bow rises while accelerating, levels out once planing), keel lateral
 *         resistance, an outboard thrust vector that steers by swinging the motor,
 *         lower-unit lift, banking into turns, river currents, shallow-water squat,
 *         propeller strikes and beaching on shorelines. Wakes and bow spray feed
 *         the ripple simulation, the foam trail and the particle system.
 * Aircraft  6-DOF flight model from real light-aircraft coefficients: lift with
 *         stall and post-stall, induced + parasitic drag, sideslip, static/dynamic
 *         stability derivatives (pitch, roll, yaw damping, weathervane, dihedral
 *         effect, adverse yaw), propeller thrust falling with airspeed, air density
 *         with altitude, wind and gust turbulence, ground effect, sprung tricycle
 *         gear with tyre friction, nose-wheel steering and brakes. The seaplane
 *         floats on its pontoons and takes off from water. Contrails at altitude,
 *         wingtip vortices under load, prop wash dust, tyre smoke on touchdown.
 * Bikes   bicycle-model steering, rider lean from centripetal balance, tyre
 *         grip limited by the surface under the wheels (mud, sand, snow, ice, wet
 *         rock, puddles), traction-limited drive and wheelspin, rolling resistance,
 *         gravity on slopes, sprung suspension with jumps and landings, airborne
 *         pitch control, crashes, tyre ruts in soft ground, dust, mud and spray.
 * All vehicles are drawn into the G-buffer (PBR materials, lamps, wet/mud
 * layers), cast shadows, write motion vectors for frame extrapolation, use a
 * reduced LOD mesh beyond 60 m, and sleep when parked or far away.
 * ========================================================================== */
(function () {
  'use strict';
  var S = TERRA.shaders, U = TERRA.util, M = TERRA.math;
  var GRAV = 9.81, RHO_W = 1000, RHO_A = 1.225, MAXV = 8;

  /* ======================= shaders ======================= */
  S.vehVS = [
    '#include <frame>',
    'layout(location = 0) in vec3 aPos;',
    'layout(location = 1) in vec3 aNormal;',
    'layout(location = 2) in vec3 aCol;',
    'layout(location = 3) in float aMat;',
    'uniform mat4 uModel; uniform mat4 uLocal; uniform int uShadowPass; uniform mat4 uShadowVP;',
    'out vec3 vWorld; out vec3 vNormal; out vec3 vCol; flat out int vMat; out vec3 vObj;',
    '#ifdef MOTION',
    'uniform vec3 uLinVel; uniform vec3 uAngVel; uniform vec3 uCOM; uniform float uMotionFlag; out vec3 vVel; out float vFlag;',
    '#endif',
    'void main(){',
    '  vec4 wp = uModel * vec4(aPos, 1.0);',
    '  vWorld = wp.xyz; vNormal = mat3(uModel) * aNormal; vCol = aCol; vMat = int(aMat + 0.5);',
    '  vObj = (uLocal * vec4(aPos, 1.0)).xyz;',
    '#ifdef MOTION',
    '  vVel = uLinVel + cross(uAngVel, wp.xyz - uCOM); vFlag = uMotionFlag > 0.5 ? uMotionFlag : 1.0;   // 2 = screen-locked',
    '#endif',
    '  gl_Position = uShadowPass == 1 ? uShadowVP * wp : uViewProj * wp;',
    '}'
  ].join('\n');
  S.vehFS = [
    '#include <frame>',
    '#include <common>',
    '#ifdef SHADOW',
    'out vec4 oDummy;',
    'void main(){ oDummy = vec4(1.0); }',
    '#else',
    '#include <gbufferOut>',
    'in vec3 vWorld; in vec3 vNormal; in vec3 vCol; flat in int vMat; in vec3 vObj;',
    'uniform vec4 uState;   // x wet, y mud, z body-space y where mud is full, w where it fades out (z < w)',
    'uniform vec4 uLamp;    // x headlamps, y tail / brake, z navigation, w instruments',
    'uniform float uRing;   // growth rings across the radius (cut wood)',
    'uniform highp sampler2DArray uAlbedoH;',
    'void main(){',
    '  // thin parts (props, glazing, panels) are two-sided: orient the shading normal to the visible side',
    '  vec3 N = normalize(vNormal);',
    '  vec3 gn = normalize(cross(dFdx(vWorld), dFdy(vWorld)));',
    '  if (dot(gn, uCamPos.xyz - vWorld) < 0.0) gn = -gn;',
    '  if (dot(N, gn) < 0.0) N = -N;',
    '  vec3 alb = vCol; float rough = 0.5, metal = 0.0, emis = 0.0, film = 0.0;',
    '  int m = vMat;',
    '  float nz = vnoise3(vObj * 9.0);',
    '  if (m == 0) { rough = 0.2; film = 0.22; alb *= 0.965 + 0.07 * nz; }               // gloss paint + clear coat',
    '  else if (m == 1) { metal = 0.85; rough = 0.34 + (nz - 0.5) * 0.1; }               // brushed alloy',
    '  else if (m == 2) { metal = 1.0; rough = 0.06; alb = max(alb, vec3(0.62)); }       // chrome',
    '  else if (m == 3) { alb = vCol * 0.1; rough = 0.025; film = 0.7; }                  // glass',
    '  else if (m == 4) { rough = 0.86; alb *= 0.9 + 0.2 * nz; }                          // rubber',
    '  else if (m == 5) {                                                                   // varnished wood',
    '    vec3 bw = pow(abs(N), vec3(4.0)); bw /= dot(bw, vec3(1.0)); vec3 op = vObj * 1.3;',
    '    vec3 w = texture(uAlbedoH, vec3(op.zy, 14.0)).rgb * bw.x + texture(uAlbedoH, vec3(op.xz, 14.0)).rgb * bw.y + texture(uAlbedoH, vec3(op.xy, 14.0)).rgb * bw.z;',
    '    alb = saturate(w * vCol * 2.7); alb = mix(vec3(luma(alb)), alb, 0.8); rough = 0.42; film = 0.08; }',
    '  else if (m == 6) { rough = 0.42; }',
    '  else if (m == 7) { emis = uLamp.x; rough = 0.08; film = 0.5; alb = mix(vCol, vec3(1.0, 0.94, 0.82), uLamp.x); }',
    '  else if (m == 8) { emis = max(uLamp.z, uLamp.y) * 0.7; rough = 0.15; }',
    '  else if (m == 12) { emis = uLamp.z * 0.7; rough = 0.15; }',
    '  else if (m == 9) { rough = 0.92; alb *= 0.9 + 0.2 * vnoise3(vObj * 40.0); }        // canvas',
    '  else if (m == 10) { rough = 0.72; }                                                  // antifouling',
    '  else if (m == 11) { rough = 0.55; metal = 0.15; }',
    '  else if (m == 13) { rough = 0.55; }',
    '  else if (m == 14) { rough = 0.95; alb *= 0.85 + 0.3 * vnoise3(vObj * 70.0); }     // cloth',
    '  else if (m == 15) { metal = 0.9; rough = 0.28 + (nz - 0.5) * 0.08; }',
    '  else if (m == 16) {                                                                  // sawn / chopped end grain',
    '    float rr = length(vObj.xz); float wob = vnoise3(vObj * 3.0) * 0.5 + vnoise3(vObj * 11.0) * 0.12;',
    '    float ring = fract(rr * uRing + wob);',
    '    float late = smoothstep(0.62, 0.95, ring) * 0.55;                                     // dark latewood bands',
    '    vec3 sap = vec3(0.80, 0.66, 0.46), heart = vec3(0.56, 0.37, 0.21);',
    '    alb = mix(sap, heart, smoothstep(0.72, 0.5, rr + wob * 0.1)) * (1.0 - late * 0.45);',
    '    float ang = atan(vObj.z, vObj.x);',
    '    float crack = smoothstep(0.93, 1.0, abs(sin(ang * 2.5 + vnoise3(vObj * 6.0) * 2.2))) * smoothstep(0.12, 0.3, rr) * smoothstep(0.98, 0.7, rr);',
    '    alb *= 1.0 - crack * 0.7; alb = mix(alb, vec3(0.26, 0.19, 0.13), smoothstep(0.9, 0.98, rr));   // bark rim',
    '    alb *= 0.85 + 0.3 * vnoise3(vObj * 40.0); rough = 0.82; }',
    '  else if (m == 17) {                                                                  // bark',
    '    float ang = atan(vObj.z, vObj.x);',
    '    vec3 bk = texture(uAlbedoH, vec3(ang / TAU * 3.0, vObj.y * 0.9, 13.0)).rgb;',
    '    alb = saturate(bk * vCol * 2.3); rough = 0.9;',
    '    float moss = smoothstep(0.55, 0.8, vnoise3(vObj * 2.0 + 9.0)) * smoothstep(0.3, -0.2, vObj.y);',
    '    alb = mix(alb, vec3(0.16, 0.24, 0.07), moss * 0.7); }',
    '  // mud spattered up from the wheels / dust',
    '  if (m != 3 && m != 7 && m != 8 && m != 12 && m < 16) {',
    '    float band = 1.0 - smoothstep(uState.z, uState.w, vObj.y);',
    '    float sp = smoothstep(0.35, 0.75, vnoise3(vObj * 11.0 + 3.7) * 0.6 + band * 0.6);',
    '    float mud = uState.y * band * sp;',
    '    alb = mix(alb, vec3(0.2, 0.15, 0.1), mud); rough = mix(rough, 0.92, mud); metal *= 1.0 - mud; film *= 1.0 - mud;',
    '  }',
    '  // rain / spray: darker porous materials, glossy water film on everything',
    '  float wet = uState.x;',
    '  float porous = (m == 4 || m == 5 || m == 9 || m == 14 || m >= 16) ? 1.0 : 0.25;',
    '  alb *= mix(1.0, 0.72, wet * porous * (1.0 - metal));',
    '  rough = mix(rough, rough * 0.45, wet); film = max(film, wet * 0.45);',
    '  gAlbedo = vec4(saturate(alb), 1.0);',
    '  gNormal = vec4(N, clamp(rough, 0.02, 1.0));',
    '  gMaterial = vec4(metal, saturate(film), 0.0, saturate(emis));',
    '}',
    '#endif'
  ].join('\n');

  /* ======================= math helpers ======================= */
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
  function qinvrot(q, v) { return qrot([-q[0], -q[1], -q[2], q[3]], v); }
  function qaxis(x, y, z, a) { var s = Math.sin(a / 2); return [x * s, y * s, z * s, Math.cos(a / 2)]; }
  function qlerp(a, b, t) {
    var d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3], s = d < 0 ? -1 : 1;
    return qnorm([a[0] + (b[0] * s - a[0]) * t, a[1] + (b[1] * s - a[1]) * t, a[2] + (b[2] * s - a[2]) * t, a[3] + (b[3] * s - a[3]) * t]);
  }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function len(a) { return Math.hypot(a[0], a[1], a[2]); }
  function addAt(F, T, r, f) { F[0] += f[0]; F[1] += f[1]; F[2] += f[2]; var t = cross(r, f); T[0] += t[0]; T[1] += t[1]; T[2] += t[2]; }
  function wrapA(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }
  /** Column-major rigid transform T(p)·R(q). */
  function m4QP(m, q, x, y, z) {
    var qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    m[0] = 1 - 2 * (qy * qy + qz * qz); m[1] = 2 * (qx * qy + qz * qw); m[2] = 2 * (qx * qz - qy * qw); m[3] = 0;
    m[4] = 2 * (qx * qy - qz * qw); m[5] = 1 - 2 * (qx * qx + qz * qz); m[6] = 2 * (qy * qz + qx * qw); m[7] = 0;
    m[8] = 2 * (qx * qz + qy * qw); m[9] = 2 * (qy * qz - qx * qw); m[10] = 1 - 2 * (qx * qx + qy * qy); m[11] = 0;
    m[12] = x; m[13] = y; m[14] = z; m[15] = 1;
    return m;
  }
  var ID = M.mat4();

  /* ======================= vehicle catalogue ======================= */
  var SPECS = {
    skiff:    { cat: 'boat', name: 'Aluminium skiff', boat: 'skiff', mass: 340, thrust: 1700, vmax: 14, hump: 0.14, plane: 1.0, skeg: 0.05, sound: { f: 24, cyl: 2, noise: 0.4 } },
    speed:    { cat: 'boat', name: 'Speedboat', boat: 'speed', mass: 1650, thrust: 10500, vmax: 23, hump: 0.16, plane: 1.0, skeg: 0.09, sound: { f: 19, cyl: 8, noise: 0.5 } },
    cruiser:  { cat: 'boat', name: 'Cabin cruiser', boat: 'cruiser', mass: 7200, thrust: 19000, vmax: 12.5, hump: 0.11, plane: 0.45, skeg: 0.32, sound: { f: 14, cyl: 6, noise: 0.35 } },
    plane:    { cat: 'plane', name: 'Light aircraft', floats: false, mass: 1050, I: [1850, 2700, 1350], tmax: 16500 },
    seaplane: { cat: 'plane', name: 'Seaplane', floats: true, mass: 650, I: [2050, 2950, 1550], tmax: 12500 },
    mtb:      { cat: 'bike', name: 'Mountain bike', kind: 'mtb', mass: 92, power: 260, sprint: 650, vmax: 35, cda: 0.45 },
    dirt:     { cat: 'bike', name: 'Dirt bike', kind: 'dirt', mass: 195, power: 28000, vmax: 65, cda: 0.62 }
  };
  var ORDER = ['skiff', 'speed', 'cruiser', 'plane', 'seaplane', 'mtb', 'dirt'];
  var MENU = [
    ['skiff', 'Aluminium skiff', 'small outboard boat · light & nimble'],
    ['speed', 'Speedboat', 'planing hull · 45 knots'],
    ['cruiser', 'Cabin cruiser', 'heavy displacement · steady in waves'],
    ['plane', 'Light aircraft', 'high-wing tricycle gear · needs a runway-ish field'],
    ['seaplane', 'Seaplane', 'takes off from lakes, rivers and the sea'],
    ['mtb', 'Mountain bike', 'pedal power · Shift to sprint · Space to hop'],
    ['dirt', 'Dirt bike', '250 cc · knobbly tyres · jumps']
  ];

  /* ======================= Vehicles manager ======================= */
  function Vehicles(engine) {
    this.E = engine;
    var G = this.G = engine.renderer.G;
    this.gl = G.gl;
    this.prog = G.program('vehicle', S.vehVS, S.vehFS);
    this.progShadow = G.program('vehicleShadow', S.vehVS, S.vehFS, { SHADOW: 1 });
    this.progMotion = G.program('vehicleMotion', S.vehVS, S.motionFS, { MOTION: 1 });
    this.list = [];
    this.current = null;
    this.models = {};
    this._uploaded = new Map();
    this.acc = 0;
    this.camMode = { boat: 'chase', plane: 'chase', bike: 'chase' };
    this.look = { yaw: 0, pitch: 0, idle: 0 };
    this.cam = null;
    this.ms = 0;
    this.mBody = new Float32Array(16); this.mTmp = new Float32Array(16); this.mPart = new Float32Array(16); this.mLoc = new Float32Array(16); this.mLoc2 = new Float32Array(16);
    this._surf = {};
    this.audio = new VehicleAudio(engine);
    this._buildDom();
  }
  var P = Vehicles.prototype;
  Vehicles.SPECS = SPECS;

  /* ---------------- models (built lazily, shared by all vehicles of a type) ---------------- */
  P._upload = function (mb) {
    var u = this._uploaded.get(mb);
    if (!u) { u = mb.upload(this.gl, this.G); this._uploaded.set(mb, u); }
    return u;
  };
  P._model = function (type) {
    if (this.models[type]) return this.models[type];
    var VM = TERRA.game.VehicleModels, sp = SPECS[type], self = this, lods = [], info = {};
    for (var l = 0; l < 2; l++) {
      var raw = sp.cat === 'boat' ? VM.boat(sp.boat, l) : (sp.cat === 'plane' ? VM.plane(sp.floats, l) : VM.bike(sp.kind, l));
      var parts = raw.parts.map(function (p) { return { name: p.name, kind: p.kind, pivot: p.pivot, axis: p.axis, parent: p.parent, mesh: self._upload(p.mesh) }; });
      lods.push({ body: this._upload(raw.body), parts: parts });
      if (l === 0) info.raw = raw;
    }
    var raw0 = info.raw;
    if (sp.cat === 'boat') {
      var L = raw0.L, B = raw0.B, D = raw0.D;
      info.L = L; info.B = B; info.D = D;
      info.radius = L * 0.55 + 0.5;
      info.I = [sp.mass * (L * L + D * D) / 12 * 0.75, sp.mass * (L * L + B * B) / 12 * 0.8, sp.mass * (B * B + D * D) / 12 * 1.1];
      info.cols = [];
      var nz = 6, nx = 3;
      for (var i = 0; i < nz; i++) {
        var t = (i + 0.5) / nz, z = (0.5 - t) * L * 0.94;
        var bow = Math.max(0, (t - 0.55) / 0.45), hb = B * 0.5 * (1 - Math.pow(bow, 1.6) * 0.9);
        var keel = -D + Math.pow(bow, 2.2) * D * 0.75;
        for (var j = 0; j < nx; j++) {
          var x = (j - 1) * hb * 0.62;
          var y = keel + 0.3 * Math.abs(x);
          var A = (L * 0.94 / nz) * (hb * 2 * 0.92 / nx);
          info.cols.push({ p: [x, y, z], A: A, H: Math.max(0.2, D * 1.15 - (y + D) * 0.8), damp: 0.55 * RHO_W * Math.sqrt(GRAV * D) * A });
        }
      }
      // shift the columns so the hull's centre of buoyancy sits under the centre of mass (level trim)
      var cz = 0, ca = 0;
      info.cols.forEach(function (c) { var w = c.A * Math.max(0, Math.min(c.H, D * 0.35 - (c.p[1] + D))); cz += c.p[2] * w; ca += w; });
      cz = ca > 0 ? cz / ca : 0;
      info.cols.forEach(function (c) { c.p[2] -= cz; });
      info.ground = [[0, -D * 0.25, -L * 0.48], [0, -D * 0.8, -L * 0.3], [0, -D, 0], [0, -D, L * 0.45], [B * 0.45, -D * 0.55, -L * 0.15], [-B * 0.45, -D * 0.55, -L * 0.15], [B * 0.45, -D * 0.55, L * 0.4], [-B * 0.45, -D * 0.55, L * 0.4]];
      info.prop = [0, -D - 0.35, L * 0.5 + 0.25];
      info.stern = [0, -D * 0.4, L * 0.5];
      info.bow = [0, 0, -L * 0.48];
      info.eye = [raw0.seat[0], raw0.seat[1] + 0.86, raw0.seat[2] - 0.05];
      info.seat = raw0.seat;
      info.chase = [L * 1.05 + 4.5, L * 0.32 + 1.9];
      info.reach = Math.max(3.2, L * 0.6 + 1.5);
      info.offset = [0, 0, 0];
      info.mud = [-D * 2.5, -D * 2];
    } else if (sp.cat === 'plane') {
      info.radius = 6.2;
      info.I = sp.I;
      info.S = 16.2; info.b = 11.2; info.c = 1.45;
      info.gear = sp.floats ? [] : [
        { p: [-1.15, -1.55, 0.35], wheel: 'wheelL' }, { p: [1.15, -1.55, 0.35], wheel: 'wheelR' }, { p: [0, -1.55, -2.5], wheel: 'wheelN', nose: true }
      ];
      info.hard = [[-5.6, 0.92, -0.62], [5.6, 0.92, -0.62], [0, 0.35, 5.6], [0, 1.75, 5.35], [0, -0.02, -3.85], [0, -0.45, 0.4], [0, -0.3, 3.2]];
      info.skids = sp.floats ? [[-1.25, -1.8, -2.6], [-1.25, -1.8, 0.2], [-1.25, -1.8, 3.0], [1.25, -1.8, -2.6], [1.25, -1.8, 0.2], [1.25, -1.8, 3.0]] : [];
      info.cols = [];
      if (sp.floats) {
        for (var sd = -1; sd <= 1; sd += 2) for (var k = 0; k < 6; k++) {
          var zf = -2.9 + k * 1.25;
          info.cols.push({ p: [sd * 1.25, -1.82, zf], A: 0.56 * 1.25 * 0.85, H: 0.56, damp: 0.6 * RHO_W * 2.2 * 0.6 });
        }
      } else {
        for (var k2 = 0; k2 < 5; k2++) info.cols.push({ p: [0, -0.45, -2.6 + k2 * 1.6], A: 1.0, H: 0.9, damp: 600 });
      }
      info.eye = [-0.18, 0.62, -1.05];
      info.seat = raw0.seat;
      info.chase = [15, 3.2];
      info.reach = 5.0;
      info.offset = [0, 0, 0];
      info.mud = [-1.7, -1.0];
      info.tips = [[-5.55, 0.92, -0.3], [5.55, 0.92, -0.3]];
    } else {
      info.R = raw0.R; info.wb = raw0.wb;
      info.radius = raw0.wb * 0.75 + 0.6;
      info.eye = sp.kind === 'dirt' ? [0, 1.88, raw0.wb * 0.5 - 0.42] : [0, 1.86, raw0.wb * 0.5 - 0.3];
      info.chase = [4.6, 1.75];
      info.reach = 2.6;
      info.offset = [0, 0, raw0.wb / 2];
      info.mud = [0.15, 0.95];
      info.cda = sp.cda;
      info.I = [sp.mass, sp.mass, sp.mass];
    }
    info.tris = lods[0].body.tris + lods[0].parts.reduce(function (a, p) { return a + p.mesh.tris; }, 0);
    this.models[type] = { lods: lods, info: info };
    return this.models[type];
  };

  /* ---------------- vehicle state ---------------- */
  function Vehicle(type, model) {
    var sp = SPECS[type];
    this.type = type; this.spec = sp; this.cat = sp.cat; this.model = model; this.info = model.info;
    this.pos = [0, 0, 0]; this.vel = [0, 0, 0]; this.q = [0, 0, 0, 1]; this.w = [0, 0, 0];
    this.prevPos = [0, 0, 0]; this.prevQ = [0, 0, 0, 1]; this.rpos = [0, 0, 0]; this.rq = [0, 0, 0, 1];
    this.mass = sp.mass; this.I = model.info.I.slice();
    this.ctl = { throttle: 0, steer: 0, pitch: 0, roll: 0, yaw: 0, brake: 0, boost: 0, hop: false };
    this.anim = { wheel: 0, wheelF: 0, wheelL: 0, wheelR: 0, wheelN: 0, prop: 0, steer: 0, suspF: 0, suspR: 0, gear: {} };
    this.rpm = 0; this.engineOn = false; this.lightsOn = false; this.wet = 0; this.mud = 0;
    this.sleep = 0; this.asleep = false; this.damaged = false; this.driven = false;
    this.immersion = 0; this.keelDepth = 99; this.agl = 0; this.speed = 0; this.airspeed = 0; this.alpha = 0;
    this.fx = { wake: 0, spray: 0, exhaust: 0, dust: 0, trail: 0, contrail: 0, track: 0, splash: 0, tick: 0 };
    this.lastTrack = null;
    this.status = '';
    if (sp.cat === 'bike') this.bk = { yaw: 0, vh: [0, 0], vy: 0, by: 0, ycPrev: null, pitch: 0, pitchV: 0, lean: 0, leanV: 0, steer: 0, air: false, airT: 0, crashed: false, crashT: 0, surfT: 0, surf: null, susp: 0, suspV: 0, gear: 1, wheelspin: 0, skid: 0, yawRate: 0, puddle: 0 };
  }

  /* ======================= public API ======================= */
  P.count = function () { return this.list.length; };
  P.clear = function () { if (this.current) this.exit(true); this.list.length = 0; this.audio.stop(); };

  P.toggleMenu = function (on) {
    this.menuOpen = on === undefined ? !this.menuOpen : on;
    this.dom.menu.classList.toggle('hidden', !this.menuOpen);
  };

  /** Spawn a vehicle in front of the player. */
  P.spawn = function (type) {
    var E = this.E, pl = E.player, sp = SPECS[type];
    if (!sp || !E.gen) return null;
    var model = this._model(type), info = model.info;
    var yaw = pl.yaw, f = [-Math.sin(yaw), 0, -Math.cos(yaw)];
    var pos, needWater = sp.cat === 'boat' || (sp.cat === 'plane' && sp.floats);
    if (needWater) {
      var spot = this._findWater(pl.pos, yaw, sp.cat === 'boat' ? info.D + 0.5 : 1.4, info.radius);
      if (!spot) { TERRA.ui.toast((sp.cat === 'boat' ? 'Boats' : 'Seaplanes') + ' need open water — face a lake, river or the sea (within 200 m)', 'warn'); return null; }
      pos = [spot.x, spot.level + (sp.cat === 'boat' ? info.D * 0.6 : 1.7), spot.z];
      yaw = spot.yaw;
    } else {
      var d = sp.cat === 'plane' ? 16 : 3.2;
      var x = pl.pos[0] + f[0] * d, z = pl.pos[2] + f[2] * d;
      var w = E.waterAt(x, z), gh = E.groundHeight(x, z);
      if (w.level > gh + 0.6 && w.type !== 4) { TERRA.ui.toast('That spot is under water — ' + (sp.cat === 'plane' ? 'try the seaplane' : 'find dry ground'), 'warn'); return null; }
      pos = [x, gh + (sp.cat === 'plane' ? 1.62 : 0.02), z];
    }
    var v = new Vehicle(type, model);
    v.pos = pos; v.q = qaxis(0, 1, 0, yaw);
    if (v.bk) { v.bk.yaw = yaw; v.bk.by = pos[1]; v.bk.lean = 0.2; v.bk.ycPrev = null; }
    v.prevPos = pos.slice(); v.prevQ = v.q.slice(); v.rpos = pos.slice(); v.rq = v.q.slice();
    this.list.push(v);
    // despawn the oldest unused vehicles beyond the cap
    while (this.list.length > MAXV) {
      var idx = -1;
      for (var i = 0; i < this.list.length; i++) if (this.list[i] !== this.current && this.list[i] !== v) { idx = i; break; }
      if (idx < 0) break;
      this.list.splice(idx, 1);
    }
    TERRA.ui.toast(sp.name + ' ready — walk up and press F to ' + (sp.cat === 'bike' ? 'ride' : (sp.cat === 'plane' ? 'fly' : 'drive')));
    if (E.audio && E.audio.click) E.audio.click();
    return v;
  };

  /** Search outward in the facing direction for water deep enough for a hull. */
  P._findWater = function (from, yaw, depth, radius) {
    var E = this.E, angs = [0, 0.35, -0.35, 0.8, -0.8, 1.4, -1.4, 2.2, -2.2, Math.PI];
    for (var dist = 6; dist <= 200; dist += dist < 40 ? 4 : 10) {
      for (var a = 0; a < angs.length; a++) {
        var y = yaw + angs[a], x = from[0] - Math.sin(y) * dist, z = from[2] - Math.cos(y) * dist;
        var w = E.waterAt(x, z);
        if (w.level < -1e4 || w.type === 4) continue;
        var gh = E.groundHeight(x, z);
        if (w.level - gh < depth) continue;
        // a little room around the hull
        var ok = true;
        for (var k = 0; k < 4 && ok; k++) {
          var ax = x + Math.cos(k * 1.57) * radius * 0.8, az = z + Math.sin(k * 1.57) * radius * 0.8;
          if (w.level - E.groundHeight(ax, az) < depth * 0.6) ok = false;
        }
        if (ok) return { x: x, z: z, level: w.level, yaw: y };
      }
    }
    return null;
  };

  P.nearest = function (maxExtra) {
    var pl = this.E.player.pos, best = null, bd = 1e9;
    for (var i = 0; i < this.list.length; i++) {
      var v = this.list[i];
      var d = Math.hypot(v.pos[0] - pl[0], (v.pos[1] - pl[1] - 0.8) * 0.6, v.pos[2] - pl[2]) - v.info.reach;
      if (d < bd) { bd = d; best = v; }
    }
    return best && bd < (maxExtra || 0) ? best : null;
  };

  P.enter = function (v) {
    var E = this.E;
    if (this.current) this.exit();
    if (E.tools && E.tools.held) E.tools.drop(true);
    this.current = v; v.driven = true; v.asleep = false; v.sleep = 0;
    v.engineOn = !v.damaged;
    if (v.cat === 'plane') v.ctl.throttle = v.agl > 3 ? Math.max(v.ctl.throttle, 0.6) : 0;
    this.look.yaw = 0; this.look.pitch = 0; this.look.idle = 0;
    this.cam = null;
    if (v.bk) { v.bk.crashed = false; }
    var night = 1 - E.environment.env.dayFactor;
    v.lightsOn = night > 0.6;
    this.audio.start(v);
    this.dom.hud.classList.remove('hidden');
    this.dom.prompt.classList.add('hidden');
    var hints = { boat: '<kbd>W</kbd>/<kbd>S</kbd> throttle · <kbd>A</kbd>/<kbd>D</kbd> steer · <kbd>Shift</kbd> full power · <kbd>V</kbd> camera · <kbd>L</kbd> lights · <kbd>R</kbd> reset · <kbd>F</kbd> leave',
      plane: '<kbd>Shift</kbd>/<kbd>Ctrl</kbd> throttle · <kbd>W</kbd>/<kbd>S</kbd> pitch · <kbd>A</kbd>/<kbd>D</kbd> roll · <kbd>Q</kbd>/<kbd>E</kbd> rudder · <kbd>Space</kbd> brakes · <kbd>V</kbd> camera · <kbd>R</kbd> reset · <kbd>F</kbd> leave',
      bike: '<kbd>W</kbd> ' + (v.spec.kind === 'mtb' ? 'pedal' : 'throttle') + ' · <kbd>S</kbd> brake · <kbd>A</kbd>/<kbd>D</kbd> steer · <kbd>Shift</kbd> ' + (v.spec.kind === 'mtb' ? 'sprint' : 'full throttle') + ' · <kbd>Space</kbd> hop · <kbd>V</kbd> camera · <kbd>R</kbd> reset · <kbd>F</kbd> leave' };
    this.dom.hints.innerHTML = hints[v.cat];
    var h = document.getElementById('hints'); if (h) h.classList.add('veh-hidden');
    this.dom.hints.classList.remove('hidden');
  };

  P.exit = function (silent) {
    var v = this.current, E = this.E, pl = E.player;
    if (!v) return;
    this.current = null; v.driven = false;
    var fwd = qrot(v.q, [0, 0, -1]), right = qrot(v.q, [1, 0, 0]);
    var side = v.cat === 'plane' ? 2.6 : (v.cat === 'boat' ? v.info.B * 0.5 + 0.8 : 0.9);
    var x = v.pos[0] - right[0] * side, z = v.pos[2] - right[2] * side;
    var gh = E.groundHeight(x, z), w = E.waterAt(x, z);
    var y = Math.max(gh, v.cat === 'plane' && v.agl > 4 ? v.pos[1] - 1 : gh);
    if (w.level > gh && w.type !== 4) y = Math.max(y, w.level - 1.2);
    pl.pos = [x, y + 0.05, z];
    var air = v.cat === 'plane' ? v.agl > 3 : false;
    pl.vel = air ? v.vel.slice() : [v.vel[0] * 0.15, 0, v.vel[2] * 0.15];
    var hy = Math.atan2(-fwd[0], -fwd[2]);
    pl.yaw = pl.tYaw = hy; pl.pitch = pl.tPitch = -0.08; pl.roll = 0; pl.camUp = null;
    pl.onGround = false;
    pl._camera(0, E.settings.controls, E.environment.env);
    v.ctl.steer = 0; v.ctl.pitch = 0; v.ctl.roll = 0; v.ctl.yaw = 0; v.ctl.brake = v.cat === 'plane' && !air ? 1 : 0;
    if (v.cat === 'boat') v.ctl.throttle = 0;
    if (v.cat === 'bike') { v.ctl.throttle = 0; v.ctl.brake = 1; v.engineOn = false; }
    if (v.cat === 'plane') { v.ctl.throttle = 0; if (!air) v.engineOn = false; }
    this.audio.stop();
    this.dom.hud.classList.add('hidden');
    this.dom.hints.classList.add('hidden');
    var h = document.getElementById('hints'); if (h) h.classList.remove('veh-hidden');
    if (!silent && E.audio && E.audio.click) E.audio.click();
  };

  P.toggleCamera = function () {
    var v = this.current; if (!v) return;
    var m = this.camMode[v.cat] = this.camMode[v.cat] === 'chase' ? 'cockpit' : 'chase';
    this.look.yaw = 0; this.look.pitch = 0; this.cam = null;
    TERRA.ui.toast(m === 'chase' ? 'Chase camera' : (v.cat === 'plane' ? 'Cockpit camera' : 'First-person camera'));
  };
  P.toggleLights = function () {
    var v = this.current; if (!v) return false;
    v.lightsOn = !v.lightsOn;
    if (this.E.audio && this.E.audio.click) this.E.audio.click();
    return true;
  };

  /** Put the vehicle back on its wheels / keel (and repair it). */
  P.reset = function (v) {
    v = v || this.current; if (!v) return;
    var E = this.E, fwd = qrot(v.q, [0, 0, -1]), yaw = Math.atan2(-fwd[0], -fwd[2]);
    v.q = qaxis(0, 1, 0, yaw); v.w = [0, 0, 0]; v.vel = [0, 0, 0]; v.damaged = false; v.engineOn = true;
    var gh = E.groundHeight(v.pos[0], v.pos[2]);
    if (v.cat === 'boat') { var wi = this._water(v, true); v.pos[1] = Math.max(gh, wi.level) + v.info.D * 0.4; }
    else if (v.cat === 'plane') {
      var wi2 = this._water(v, true);
      v.pos[1] = (v.spec.floats && wi2.level > gh ? wi2.level + 1.7 : gh + 1.65); v.ctl.throttle = 0;
    }
    else { var b = v.bk; b.yaw = yaw; b.vh = [0, 0]; b.vy = 0; b.by = gh; b.ycPrev = null; b.pitch = 0; b.pitchV = 0; b.lean = 0; b.leanV = 0; b.crashed = false; b.air = false; v.pos[1] = gh; }
    v.prevPos = v.pos.slice(); v.prevQ = v.q.slice();
    TERRA.ui.toast(v.spec.name + ' reset');
  };

  /** Radial impulse from an explosion (dynamite) — wakes and throws vehicles. */
  P.impulse = function (pos, power, radius) {
    for (var i = 0; i < this.list.length; i++) {
      var v = this.list[i], d = [v.pos[0] - pos[0], v.pos[1] - pos[1] + 0.5, v.pos[2] - pos[2]], dl = len(d);
      if (dl > radius) continue;
      var k = power * (1 - dl / radius) / Math.max(1, dl) * 2600 / v.mass;
      v.asleep = false; v.sleep = 0;
      if (v.bk) {
        var b = v.bk; b.vh[0] += d[0] / dl * k; b.vh[1] += d[2] / dl * k; b.vy += k * 0.6 + 2; b.air = true;
        if (k > 4) { b.crashed = true; b.crashT = 0; }
      } else {
        v.vel[0] += d[0] / dl * k; v.vel[1] += Math.abs(d[1] / dl) * k + k * 0.4; v.vel[2] += d[2] / dl * k;
        v.w[0] += (Math.random() - 0.5) * k * 0.4; v.w[2] += (Math.random() - 0.5) * k * 0.4;
      }
    }
  };

  /* ======================= driver input ======================= */
  P.updateDriver = function (dt, input) {
    var v = this.current, E = this.E;
    if (!v) return;
    var ctl = E.settings.controls;
    dt = Math.min(dt, 0.05);
    // look around (camera only)
    var sens = 0.0022 * (ctl.sensitivity || 1);
    var mdx = input.locked ? input.mouse.dx : 0, mdy = input.locked ? input.mouse.dy : 0;
    if (mdx || mdy) this.look.idle = 0; else this.look.idle += dt;
    this.look.yaw = wrapA(this.look.yaw - mdx * sens);
    this.look.pitch = U.clamp(this.look.pitch - mdy * sens * (ctl.invertY ? -1 : 1), -1.2, 1.2);
    if (input.mouse.wheel && this.camMode[v.cat] === 'chase') this.zoom = U.clamp((this.zoom || 1) * Math.pow(1.12, input.mouse.wheel), 0.5, 3);
    if (this.camMode[v.cat] === 'chase' && this.look.idle > 1.5) {
      var k = 1 - Math.exp(-dt * 1.6);
      this.look.yaw -= this.look.yaw * k; this.look.pitch -= this.look.pitch * k;
    }
    var d = function (a, b) { return input.down(a) || (b && input.down(b)); };
    var shift = d('ShiftLeft', 'ShiftRight'), ctrlK = d('ControlLeft', 'ControlRight');
    var c = v.ctl;
    if (v.cat === 'boat') {
      var tgt = d('KeyW', 'ArrowUp') ? (shift ? 1 : 0.7) : (d('KeyS', 'ArrowDown') ? -0.6 : 0);
      c.throttle = U.approach(c.throttle, tgt, dt * (tgt === 0 ? 1.4 : 0.7));
      var st = (d('KeyA', 'ArrowLeft') ? 1 : 0) - (d('KeyD', 'ArrowRight') ? 1 : 0);
      c.steer = U.approach(c.steer, st, dt * (st ? 2.2 : 3));
    } else if (v.cat === 'plane') {
      if (shift) c.throttle = Math.min(1, c.throttle + dt * 0.55);
      if (ctrlK || d('KeyZ')) c.throttle = Math.max(0, c.throttle - dt * 0.55);
      var pi = (d('KeyS', 'ArrowDown') ? 1 : 0) - (d('KeyW', 'ArrowUp') ? 1 : 0);
      var ri = (d('KeyD', 'ArrowRight') ? 1 : 0) - (d('KeyA', 'ArrowLeft') ? 1 : 0);
      var yi = (d('KeyQ') ? 1 : 0) - (d('KeyE') ? 1 : 0);
      c.pitch = U.approach(c.pitch, pi, dt * (pi ? 2.5 : 4));
      c.roll = U.approach(c.roll, ri, dt * (ri ? 3 : 5));
      c.yaw = U.approach(c.yaw, yi, dt * (yi ? 2.5 : 4));
      c.brake = d('Space') ? 1 : 0;
      if (c.throttle > 0.02 && !v.damaged) v.engineOn = true;
    } else {
      c.throttle = U.approach(c.throttle, d('KeyW', 'ArrowUp') ? 1 : 0, dt * 4);
      c.brake = d('KeyS', 'ArrowDown') ? 1 : 0;
      c.boost = shift ? 1 : 0;
      var s2 = (d('KeyA', 'ArrowLeft') ? 1 : 0) - (d('KeyD', 'ArrowRight') ? 1 : 0);
      c.steer = U.approach(c.steer, s2, dt * (s2 ? 3.2 : 4.5));
      c.pitch = (d('KeyS', 'ArrowDown') ? 1 : 0) - (d('KeyW', 'ArrowUp') ? 1 : 0);   // airborne lean back / forward
      if (input.hit('Space')) c.hop = true;
      if (v.spec.kind === 'dirt' && !v.damaged) v.engineOn = true;
    }
  };

  /* ======================= simulation ======================= */
  P.update = function (dt) {
    var t0 = performance.now(), E = this.E;
    this._prompt(dt);
    if (!this.list.length) { this.ms = 0; return; }
    if (dt > 0) {
      var q = E.settings.graphics.physicsQuality; q = q === undefined ? 2 : q;
      var STEP = [1 / 60, 1 / 90, 1 / 120, 1 / 160][U.clamp(q, 0, 3)];
      this.acc = Math.min(this.acc + dt, STEP * 6);
      var cam = E.camera.world;
      // activation: vehicles far from the camera are frozen; parked ones sleep
      for (var i = 0; i < this.list.length; i++) {
        var v = this.list[i];
        var dc = Math.hypot(v.pos[0] - cam[0], v.pos[2] - cam[2]);
        v.camDist = dc;
        v.active = v.driven || (!v.asleep && dc < 600) || (v.cat === 'boat' && dc < 260 && v.immersion > 0);
        if (v.cat === 'plane' && !v.driven && v.agl > 2 && dc < 3000) v.active = true;   // a pilotless plane keeps gliding
      }
      while (this.acc >= STEP) {
        this.acc -= STEP;
        for (var j = 0; j < this.list.length; j++) {
          var w = this.list[j];
          if (!w.active) continue;
          w.prevPos[0] = w.pos[0]; w.prevPos[1] = w.pos[1]; w.prevPos[2] = w.pos[2];
          w.prevQ[0] = w.q[0]; w.prevQ[1] = w.q[1]; w.prevQ[2] = w.q[2]; w.prevQ[3] = w.q[3];
          if (w.cat === 'boat') this._stepBoat(w, STEP);
          else if (w.cat === 'plane') this._stepPlane(w, STEP);
          else this._stepBike(w, STEP);
          this._sanitize(w);
        }
        this._collide(STEP);
      }
      var alpha = this.acc / STEP;
      for (var k = 0; k < this.list.length; k++) {
        var u = this.list[k];
        if (u.active) {
          u.rpos[0] = u.prevPos[0] + (u.pos[0] - u.prevPos[0]) * alpha; u.rpos[1] = u.prevPos[1] + (u.pos[1] - u.prevPos[1]) * alpha; u.rpos[2] = u.prevPos[2] + (u.pos[2] - u.prevPos[2]) * alpha;
          u.rq = qlerp(u.prevQ, u.q, alpha);
        }
        this._frameFx(u, dt);
        this._sleep(u, dt);
      }
    }
    if (this.current) { this._camera(dt); this._hud(dt); this.audio.update(this.current, dt); }
    this.ms = performance.now() - t0;
  };

  P._sanitize = function (v) {
    for (var a = 0; a < 3; a++) {
      if (!(v.pos[a] === v.pos[a]) || !(v.vel[a] === v.vel[a]) || !(v.w[a] === v.w[a])) {
        v.pos = v.prevPos.slice(); v.vel = [0, 0, 0]; v.w = [0, 0, 0]; v.q = v.prevQ.slice(); return;
      }
      v.vel[a] = U.clamp(v.vel[a], -150, 150); v.w[a] = U.clamp(v.w[a], -12, 12);
    }
    if (!(v.q[3] === v.q[3])) v.q = [0, 0, 0, 1];
  };

  P._sleep = function (v, dt) {
    if (v.driven) { v.asleep = false; v.sleep = 0; return; }
    var moving = len(v.vel) > 0.06 || len(v.w) > 0.05;
    if (v.cat === 'boat' && v.immersion > 0 && v.camDist < 260) moving = true;   // keep bobbing on the waves while visible
    if (moving) { v.sleep = 0; v.asleep = false; }
    else { v.sleep += dt; if (v.sleep > 1.2) { v.asleep = true; v.vel = [0, 0, 0]; v.w = [0, 0, 0]; } }
  };

  /** Water level / current under a vehicle (cached; a full world sample is costly). */
  P._water = function (v, force) {
    var wi = v.wi, E = this.E;
    if (force || !wi || E.time - wi.t > 0.3 || Math.abs(v.pos[0] - wi.x) + Math.abs(v.pos[2] - wi.z) > 3) {
      var w = E.waterAt(v.pos[0], v.pos[2]);
      var gh = E.groundHeight(v.pos[0], v.pos[2]);
      wi = v.wi = { x: v.pos[0], z: v.pos[2], t: E.time, level: w.type === 4 ? -1e5 : w.level, type: w.type, fx: w.fx || 0, fz: w.fz || 0, ground: gh };
      v.keelDepth = wi.level > -1e4 ? wi.level - gh : -1;
    }
    return wi;
  };
  P._surfaceHere = function (x, z, slope) {
    var E = this.E, env = E.environment.env, Sf = TERRA.game.Surfaces;
    var wi = E.waterAt(x, z), gh = E.groundHeight(x, z);
    var wd = wi.level > -1e4 && wi.type !== 4 ? Math.max(0, wi.level - gh) : 0;
    var pud = Sf.puddleAt(E, x, z, env);
    var name = Sf.classify(env, E.environment.local, slope || 0, wd, pud);
    var info = Sf.info(name, env, {});
    info.waterDepth = wd; info.puddle = pud; info.waterLevel = wi.level;
    return info;
  };

  /* -------- rigid body integration (semi-implicit Euler, diagonal inertia, gyroscopic term) -------- */
  function integrate(v, F, Tq, h) {
    var im = 1 / v.mass;
    v.vel[0] += F[0] * im * h; v.vel[1] += F[1] * im * h; v.vel[2] += F[2] * im * h;
    var I = v.I, wb = qinvrot(v.q, v.w), tb = qinvrot(v.q, Tq);
    var gx = wb[1] * I[2] * wb[2] - wb[2] * I[1] * wb[1], gy = wb[2] * I[0] * wb[0] - wb[0] * I[2] * wb[2], gz = wb[0] * I[1] * wb[1] - wb[1] * I[0] * wb[0];
    wb[0] += (tb[0] - gx) / I[0] * h; wb[1] += (tb[1] - gy) / I[1] * h; wb[2] += (tb[2] - gz) / I[2] * h;
    v.w = qrot(v.q, wb);
    v.pos[0] += v.vel[0] * h; v.pos[1] += v.vel[1] * h; v.pos[2] += v.vel[2] * h;
    var dq = qmul([v.w[0] * h * 0.5, v.w[1] * h * 0.5, v.w[2] * h * 0.5, 0], v.q);
    v.q = qnorm([v.q[0] + dq[0], v.q[1] + dq[1], v.q[2] + dq[2], v.q[3] + dq[3]]);
  }

  /* -------- buoyancy over hull / float columns against the wavy surface -------- */
  /** shiftZ > 0 moves lift toward the bow (hump trim), shiftX > 0 toward the right side (bank left). */
  P._buoyancy = function (v, wi, F, Tq, cols, shiftZ, shiftX, focus, focusZ) {
    var hl = v.info.L ? v.info.L * 0.5 : 4, hb = v.info.B ? v.info.B * 0.5 : 1.5;
    shiftZ = shiftZ || 0; shiftX = shiftX || 0;
    var E = this.E, env = E.environment.env, Wt = TERRA.world.Water, org = E.origin, t = E.time;
    var vol = 0, cnt = 0, bowSub = 0;
    if (wi.level < -1e4) { v.immersion = 0; return 0; }
    for (var i = 0; i < cols.length; i++) {
      var c = cols[i], r = qrot(v.q, c.p);
      var px = v.pos[0] + r[0], py = v.pos[1] + r[1], pz = v.pos[2] + r[2];
      var surf = wi.level + Wt.waveHeight(px - org[0], pz - org[1], t, wi.type, env);
      var d = surf - py;
      if (d <= 0) continue;
      var dd = Math.min(d, c.H);
      cnt += dd / c.H; vol += c.A * dd;
      var pv = cross(v.w, r);
      var vy = v.vel[1] + pv[1];
      var mul = U.clamp(1 - shiftZ * c.p[2] / hl + shiftX * c.p[0] / hb, 0.25, 1.9);
      // planing on the step: pressure concentrates near the step, bow and tail run light
      if (focus) mul *= 1 + focus * (2.6 * Math.exp(-Math.pow((c.p[2] - focusZ) / 0.9, 2)) - 1);
      var f = [0, RHO_W * GRAV * c.A * dd * mul - c.damp * vy * Math.min(1, dd / c.H * 2 + 0.25), 0];
      // horizontal damping of the point (water resists sway, surge is handled by hull resistance)
      addAt(F, Tq, r, f);
      if (c.p[2] < 0) bowSub += dd / c.H;
    }
    v.immersion = cnt / cols.length;
    v.bowSub = bowSub;
    return vol;
  };

  /* -------- hull / skid contacts with the terrain (beaching, shallows, crashes) -------- */
  P._contacts = function (v, pts, F, Tq, h, mu, kMul) {
    var E = this.E, n = pts.length, hit = 0, maxV = 0, mask = 0;
    var k = v.mass * GRAV * 24 * (kMul || 1) / Math.max(1, n * 0.5), c = 2 * Math.sqrt(k * v.mass / n) * 0.8;
    for (var i = 0; i < n; i++) {
      var r = qrot(v.q, pts[i]);
      var px = v.pos[0] + r[0], py = v.pos[1] + r[1], pz = v.pos[2] + r[2];
      var gh = E.groundHeight(px, pz), pen = gh - py;
      if (pen <= 0) continue;
      var e = 0.6, gx = (E.groundHeight(px + e, pz) - E.groundHeight(px - e, pz)) / (2 * e), gz = (E.groundHeight(px, pz + e) - E.groundHeight(px, pz - e)) / (2 * e);
      var nl = Math.hypot(gx, 1, gz), nrm = [-gx / nl, 1 / nl, -gz / nl];
      var pv = cross(v.w, r), vp = [v.vel[0] + pv[0], v.vel[1] + pv[1], v.vel[2] + pv[2]];
      var vn = dot(vp, nrm);
      maxV = Math.max(maxV, -vn);
      var fnm = Math.max(0, k * Math.min(pen, 0.6) - c * vn);
      var vt = [vp[0] - nrm[0] * vn, vp[1] - nrm[1] * vn, vp[2] - nrm[2] * vn], vtl = len(vt);
      var f = [nrm[0] * fnm, nrm[1] * fnm, nrm[2] * fnm];
      if (vtl > 1e-4) {
        var ft = Math.min(mu * fnm, vtl * v.mass / n / h * 0.5);
        f[0] -= vt[0] / vtl * ft; f[1] -= vt[1] / vtl * ft; f[2] -= vt[2] / vtl * ft;
      }
      addAt(F, Tq, r, f);
      hit++; mask |= 1 << i;
    }
    return { hit: hit, impact: maxV, mask: mask };
  };

  /* ======================= boats ======================= */
  P._stepBoat = function (v, h) {
    var sp = v.spec, info = v.info, q = v.q, E = this.E;
    var F = [0, -GRAV * v.mass, 0], Tq = [0, 0, 0];
    var wi = this._water(v);
    var ax = qrot(q, [1, 0, 0]), az = qrot(q, [0, 0, 1]);
    var rv = [v.vel[0] - wi.fx, v.vel[1], v.vel[2] - wi.fz];
    var vf = -dot(rv, az), vl = dot(rv, ax);
    var Fn = Math.abs(vf) / Math.sqrt(GRAV * info.L);
    var bump = Math.exp(-Math.pow((Fn - 0.45) / 0.2, 2));
    var planing = U.smoothstep(0.55, 1.15, Fn) * sp.plane;
    // hydrodynamic pressure moves the centre of lift: forward in the hump (bow rises, stern squats),
    // toward the outside of a turn on a planing V-hull (it banks into the turn)
    var wb0 = qinvrot(q, v.w);
    var thr0 = v.engineOn ? v.ctl.throttle : 0;
    var bankT = U.clamp(wb0[1] * vf * 0.05, -0.3, 0.3) * (0.3 + 0.7 * planing);
    v.subVol = this._buoyancy(v, wi, F, Tq, info.cols, 0.6 * bump * U.clamp01(Math.abs(thr0) * 1.6) * sp.plane + 0.12 * planing, bankT * 2.4);
    var imm = U.clamp01(v.immersion * 4);
    v.planing = planing;
    var shallow = v.keelDepth >= 0 ? 1 + 1.5 * U.clamp01(1 - (v.keelDepth - info.D) / (info.D * 2.5)) : 1;
    // longitudinal resistance: friction + wave-making hump (Froude number)
    // calibrated so full thrust (which falls with speed) balances resistance at the rated top speed
    var kq = Math.max(0.5, (sp.thrust * 0.28 - v.mass * 0.02 * sp.vmax) / (sp.vmax * sp.vmax));
    var Rl = (kq * vf * Math.abs(vf) + sp.hump * v.mass * GRAV * bump * U.clamp(vf, -1, 1) + v.mass * 0.02 * vf) * shallow * imm;
    addAt(F, Tq, [0, 0, 0], [az[0] * Rl, az[1] * Rl, az[2] * Rl]);
    // lateral (keel) resistance, distributed along the hull: resists sideslip and yaw together,
    // so the boat turns by the stern sliding out while the bow holds its line
    var kl = 0.5 * RHO_W * info.L * info.D * 0.55 * 1.1 / 3, kl1 = v.mass * 1.4 / 3;
    var wyb = qinvrot(q, v.w)[1];
    for (var st3 = -1; st3 <= 1; st3++) {
      var zs = st3 * info.L * 0.36, vls = vl + wyb * zs;
      var Rs = (kl * vls * Math.abs(vls) + kl1 * vls) * imm * (st3 < 0 ? 1 - planing * 0.5 : 1);
      addAt(F, Tq, qrot(q, [0, -info.D * 0.5 * (1 - planing), zs]), [-ax[0] * Rs, -ax[1] * Rs, -ax[2] * Rs]);   // a planing V-hull's side force acts high
    }
    // planing lift (hull rises out of the water)
    if (planing > 0) F[1] += 0.5 * v.mass * GRAV * planing * imm;
    // outboard: thrust vector steered with the motor; ventilates when the prop leaves the water
    v.anim.steer = U.approach(v.anim.steer, v.ctl.steer * U.mix(0.55, 0.3, U.clamp01(Math.abs(vf) / 20)), h * 1.8);
    var st = v.anim.steer, thr = v.engineOn ? v.ctl.throttle : 0;
    var pr = qrot(q, info.prop), ppx = v.pos[0] + pr[0], ppy = v.pos[1] + pr[1], ppz = v.pos[2] + pr[2];
    var surfP = wi.level > -1e4 ? wi.level + TERRA.world.Water.waveHeight(ppx - E.origin[0], ppz - E.origin[1], E.time, wi.type, E.environment.env) : -1e5;
    var propIn = ppy < surfP - 0.04;
    v.propOut = !propIn;
    var Tm = thr >= 0 ? thr * sp.thrust * U.clamp01(1.05 - vf / (sp.vmax * 1.3)) : thr * sp.thrust * 0.45 * U.clamp01(1 + vf / (sp.vmax * 0.5));
    if (!propIn) Tm = 0;
    if (v.propStrike > 0) Tm *= 0.25;
    var tdir = [ax[0] * Math.sin(st) - az[0] * Math.cos(st), ax[1] * Math.sin(st) - az[1] * Math.cos(st), ax[2] * Math.sin(st) - az[2] * Math.cos(st)];
    // thrust acts low (bow lifts under power) but its side component is taken at hull height:
    // the lower unit's steering force is resisted by the whole hull, not by heeling it over
    addAt(F, Tq, qrot(q, [0, -info.D * 0.6, info.L * 0.5]), [tdir[0] * Tm, tdir[1] * Tm, tdir[2] * Tm]);
    v.thrust = Tm;
    // lower unit / rudder lift: steering while coasting
    var ksk = 0.5 * RHO_W * sp.skeg * 1.6 * imm;
    var fs = ksk * vf * Math.abs(vf) * Math.sin(st);
    addAt(F, Tq, qrot(q, [0, 0, info.L * 0.5]), [ax[0] * fs, ax[1] * fs, ax[2] * fs]);
    // water damps pitch, roll and yaw rotation — measured against the horizon, not the hull axes,
    // so a steady banked turn is not mistaken for rolling
    var wb = qinvrot(q, v.w);
    var hl2 = Math.hypot(az[0], az[2]) || 1, hf = [-az[0] / hl2, 0, -az[2] / hl2], hr = [-hf[2], 0, hf[0]];
    var rr = dot(v.w, hf), pr2 = dot(v.w, hr), yr = v.w[1];
    var cR = v.I[2] * (0.5 + 4.0 * imm), cP = v.I[0] * (0.4 + 2.5 * imm), cY = v.I[1] * (0.6 + Math.abs(vf) * 0.08) * Math.max(imm, 0.3);
    Tq[0] -= hf[0] * rr * cR + hr[0] * pr2 * cP; Tq[1] -= yr * cY; Tq[2] -= hf[2] * rr * cR + hr[2] * pr2 * cP;
    // shallows and shorelines
    v.propStrike = Math.max(0, (v.propStrike || 0) - h);
    if (v.keelDepth < info.D * 2.2 + 1.5) {
      var res = this._contacts(v, info.ground, F, Tq, h, 0.42, 1);
      if (res.hit) {
        v.grounded = true;
        var gp = E.groundHeight(ppx, ppz);
        if (gp > ppy - 0.1 && Math.abs(thr) > 0.1) { v.propStrike = 0.4; if (Math.random() < 0.2) this._fxPropStrike(v, [ppx, gp, ppz]); }
        if (res.impact > 2.5 && (v.fx.bump || 0) <= 0) { v.fx.bump = 0.5; this._sfx('thud', v, U.clamp01(res.impact / 8)); }
      } else v.grounded = false;
    } else v.grounded = false;
    v.fx.bump = (v.fx.bump || 0) - h;
    // air drag
    var vs = len(v.vel);
    if (vs > 0.1) { var ad = 0.5 * RHO_A * info.B * info.D * 1.2 * vs; F[0] -= v.vel[0] * ad; F[1] -= v.vel[1] * ad; F[2] -= v.vel[2] * ad; }
    integrate(v, F, Tq, h);
    v.speed = Math.abs(vf); v.fwdSpeed = vf;
    // engine
    var rpmT = v.engineOn ? 900 + Math.abs(thr) * 4600 + (propIn ? 0 : Math.abs(thr) * 1200) : 0;
    v.rpm = U.approach(v.rpm, rpmT, h * 6000);
    v.anim.prop += (propIn ? 1 : 1.4) * v.rpm / 60 * Math.PI * 2 * h * Math.sign(thr || 1) * 0.12;
  };

  /* ======================= aircraft ======================= */
  function CLof(a) {
    var as = 0.27, s = a < 0 ? -1 : 1, aa = Math.abs(a);
    var lin = 0.3 + 4.7 * a;
    if (aa <= as) return lin;
    var peak = 0.3 + 4.7 * as * s, post = 1.05 * Math.sin(2 * a);
    var t = U.clamp01((aa - as) / 0.12);
    return peak * (1 - t) + post * t;
  }
  P._wind = function (v) {
    var env = this.E.environment.env, ws = env.windStrength, k = ws * 14 * (1 + U.clamp01(v.agl / 400) * 0.6);
    var tb = v.turb || (v.turb = { t: 0, x: 0, y: 0, z: 0 });
    return [env.windDir[0] * k + tb.x, tb.y, env.windDir[1] * k + tb.z];
  };
  P._stepPlane = function (v, h) {
    var E = this.E, sp = v.spec, info = v.info, q = v.q, env = E.environment.env;
    var F = [0, -GRAV * v.mass, 0], Tq = [0, 0, 0];
    var ax = qrot(q, [1, 0, 0]), ay = qrot(q, [0, 1, 0]), az = qrot(q, [0, 0, 1]);
    // turbulence: smoothed random gusts, stronger near the ground and in storms
    var tb = v.turb || (v.turb = { t: 0, x: 0, y: 0, z: 0 });
    var ta = env.windStrength * (0.5 + env.gust) * (v.agl < 300 ? 1.6 : 0.8) * 2.2;
    var kt = 1 - Math.exp(-h * 1.5);
    tb.x += ((Math.random() - 0.5) * ta * 2 - tb.x) * kt; tb.y += ((Math.random() - 0.5) * ta * 1.4 - tb.y) * kt; tb.z += ((Math.random() - 0.5) * ta * 2 - tb.z) * kt;
    var wind = this._wind(v);
    var va = [v.vel[0] - wind[0], v.vel[1] - wind[1], v.vel[2] - wind[2]], V = len(va);
    var vb = [dot(va, ax), dot(va, ay), dot(va, az)];
    var alt = v.pos[1] - (E.gen ? E.gen.SEA : 0);
    var rho = RHO_A * Math.exp(-Math.max(0, alt) / 8500);
    var qbar = 0.5 * rho * V * V, Sw = info.S, b = info.b, c = info.c;
    var wb = qinvrot(q, v.w);
    var alpha = 0, beta = 0, cl = 0;
    var ctl = v.ctl;
    var ge = 1 + 0.35 * Math.pow(U.clamp01(1 - v.agl / b), 2);      // ground effect
    if (V > 0.8) {
      alpha = Math.atan2(-vb[1], -vb[2]); beta = Math.asin(U.clamp(vb[0] / V, -1, 1));
      // alpha is only meaningful for forward flight
      if (vb[2] > 0) alpha = 0;
      cl = CLof(alpha) * ge;
      var stallD = Math.abs(alpha) > 0.27 ? 1.2 * Math.pow(Math.sin(alpha), 2) : 0;
      var cd = 0.03 + 0.048 * cl * cl / ge + stallD + 0.004 * ctl.brake;
      var vd = [va[0] / V, va[1] / V, va[2] / V];
      var ld = cross(ax, vd); var ll = len(ld) || 1;
      var Lm = qbar * Sw * cl, Dm = qbar * Sw * cd, Ym = qbar * Sw * (-0.62 * beta);
      F[0] += ld[0] / ll * Lm - vd[0] * Dm + ax[0] * Ym;
      F[1] += ld[1] / ll * Lm - vd[1] * Dm + ax[1] * Ym;
      F[2] += ld[2] / ll * Lm - vd[2] * Dm + ax[2] * Ym;
      // moments (body axes: x pitch nose-up, y yaw left, z roll left)
      var Vs = Math.max(V, 10);
      var ph = wb[0] * c / (2 * Vs), yh = wb[1] * b / (2 * Vs), rh = wb[2] * b / (2 * Vs);
      var de = ctl.pitch * 0.3, da = ctl.roll, dr = ctl.yaw;
      var Mx = qbar * Sw * c * (0.05 - 1.15 * alpha + 0.95 * de - 24 * ph);
      var My = qbar * Sw * b * (-0.075 * beta + 0.045 * dr - 0.13 * yh + 0.006 * da);
      var Mz = qbar * Sw * b * (-0.06 * da - 0.48 * rh + 0.09 * beta + 0.07 * yh);
      // P-factor / torque: slight left yaw at high power and low speed
      My += (v.engineOn ? ctl.throttle : 0) * 120 * U.clamp01(1 - V / 45);
      var tw = qrot(q, [Mx, My, Mz]);
      Tq[0] += tw[0]; Tq[1] += tw[1]; Tq[2] += tw[2];
    }
    // structural / control damping so the airframe never oscillates at low speed
    var damp = qrot(q, [-wb[0] * v.I[0] * 0.35, -wb[1] * v.I[1] * 0.3, -wb[2] * v.I[2] * 0.25]);
    Tq[0] += damp[0]; Tq[1] += damp[1]; Tq[2] += damp[2];
    // turbulence torque
    if (ta > 0.05) { var tt = qrot(q, [tb.y * 60, tb.x * 40, tb.z * 80]); Tq[0] += tt[0]; Tq[1] += tt[1]; Tq[2] += tt[2]; }
    v.alpha = alpha; v.beta = beta; v.airspeed = V; v.cl = cl;
    // propeller thrust (falls with airspeed and air density)
    var vfw = -vb[2];
    var thr = v.engineOn && !v.damaged ? ctl.throttle : 0;
    var Tm = thr * sp.tmax * U.clamp01(1 - vfw / 95) * (rho / RHO_A);
    F[0] -= az[0] * Tm; F[1] -= az[1] * Tm; F[2] -= az[2] * Tm;
    v.thrust = Tm;
    // ground and water
    var gh0 = E.groundHeight(v.pos[0], v.pos[2]);
    v.agl = v.pos[1] - 1.6 - gh0;
    var wi = v.pos[1] - gh0 < 80 || !v.wi ? this._water(v) : v.wi;
    if (wi.level > -1e4) v.agl = Math.min(v.agl, v.pos[1] - 1.6 - wi.level);
    v.onWater = false;
    if (wi.level > -1e4 && v.pos[1] - wi.level < 4) {
      var fsp = -dot([v.vel[0] - wi.fx, v.vel[1], v.vel[2] - wi.fz], az);
      var onStep = sp.floats ? U.smoothstep(4, 14, fsp) * 0.95 : 0;
      var humpF = sp.floats ? Math.exp(-Math.pow((fsp - 5) / 3, 2)) * 0.35 : 0;   // bow rides up in the hump
      var vol = this._buoyancy(v, wi, F, Tq, info.cols, humpF, 0, onStep, -0.35);
      if (vol > 0) {
        v.onWater = true;
        // float / hull hydrodynamics (planing pontoons)
        var rv = [v.vel[0] - wi.fx, v.vel[1], v.vel[2] - wi.fz], wf = -dot(rv, az), wl = dot(rv, ax);
        var imm = U.clamp01(v.immersion * 3);
        var Fn = Math.abs(wf) / Math.sqrt(GRAV * 7.6);
        var hump = Math.exp(-Math.pow((Fn - 0.5) / 0.22, 2));
        // as the wing takes the weight the floats unload and their drag falls away
        var unload = 1 - 0.85 * U.clamp01(qbar * Sw * Math.max(0, cl) / (v.mass * GRAV));
        var Rl = (1.1 * wf * Math.abs(wf) + 0.18 * v.mass * GRAV * hump * U.clamp(wf, -1, 1) + v.mass * 0.02 * wf) * imm * unload * (sp.floats ? 1 : 5);
        F[0] += az[0] * Rl; F[1] += az[1] * Rl; F[2] += az[2] * Rl;
        var Rt = (900 * wl * Math.abs(wl) + v.mass * 1.5 * wl) * imm;
        F[0] -= ax[0] * Rt; F[1] -= ax[1] * Rt; F[2] -= ax[2] * Rt;
        // water rudders steer with the rudder pedals
        var yawW = qrot(q, [0, ctl.yaw * 1400 * U.clamp01(1.2 - Math.abs(wf) / 20) * imm * (1 + Math.abs(wf) * 0.4) - wb[1] * v.I[1] * 1.2 * imm, -wb[2] * v.I[2] * 0.8 * imm]);
        Tq[0] += yawW[0]; Tq[1] += yawW[1]; Tq[2] += yawW[2];
        if (!sp.floats && wf > 8 && !v.damaged) this._crash(v, 'ditched');
      }
    } else v.immersion = 0;
    // landing gear (sprung wheels with tyre friction and brakes)
    v.onGround = false;
    if (v.agl < 9 || v.pos[1] - gh0 < 9) {
      var surf = this._planeSurf(v);
      for (var g = 0; g < info.gear.length; g++) this._wheel(v, info.gear[g], F, Tq, h, surf);
      if (info.skids.length) { var rs = this._contacts(v, info.skids, F, Tq, h, 0.55, 1.5); if (rs.hit) v.onGround = true; }
      // trees: wings and fuselage against trunks when low
      v._treeT = (v._treeT || 0) - 1;
      if (v._treeT <= 0 && E.vegetation && v.speed > 2) {
        v._treeT = 4;
        var cols = E.vegetation.collidersNear(v.pos[0], v.pos[2], 7);
        var tL = qrot(q, info.tips[0]), tR = qrot(q, info.tips[1]);
        for (var ci = 0; ci < cols.length; ci += 4) {
          if (cols[ci + 3] + 7 < v.pos[1] - 1.5) continue;
          var ax0 = v.pos[0] + tL[0], az0 = v.pos[2] + tL[2], bx0 = v.pos[0] + tR[0], bz0 = v.pos[2] + tR[2];
          var ux = bx0 - ax0, uz = bz0 - az0, tt = U.clamp01(((cols[ci] - ax0) * ux + (cols[ci + 1] - az0) * uz) / (ux * ux + uz * uz));
          var dxs = cols[ci] - (ax0 + ux * tt), dzs = cols[ci + 1] - (az0 + uz * tt);
          var dc = Math.hypot(dxs, dzs), dcf = Math.hypot(cols[ci] - v.pos[0], cols[ci + 1] - v.pos[2]);
          if (dc < cols[ci + 2] + 0.25 || dcf < cols[ci + 2] + 0.7) {
            if (v.speed > 9 && !v.damaged) this._crash(v, 'crash');
            var push = 0.6 / Math.max(0.2, dcf);
            v.vel[0] -= (cols[ci] - v.pos[0]) * push; v.vel[2] -= (cols[ci + 1] - v.pos[2]) * push;
            v.vel[0] *= 0.6; v.vel[2] *= 0.6;
            break;
          }
        }
      }
      // airframe hits the ground: scrape or crash
      var hr = this._contacts(v, info.hard, F, Tq, h, 0.6, 2);
      // tail and belly scrapes are survivable; wingtips, nose or a hard impact are not
      if (hr.hit && !v.damaged && (hr.impact > 4.5 || (len(v.vel) > 16 && (hr.mask & 19)))) this._crash(v, 'crash');
      else if (hr.hit && len(v.vel) > 4 && Math.random() < 0.3 && E.effects) { var sp2 = qrot(q, info.hard[2]); E.effects.sparks([v.pos[0] + sp2[0], v.pos[1] + sp2[1], v.pos[2] + sp2[2]], 4, 3); }
    }
    integrate(v, F, Tq, h);
    v.speed = len(v.vel);
    // engine & propeller
    var rpmT = v.engineOn && !v.damaged ? 650 + thr * 1950 + U.clamp(vfw, 0, 80) * 5 : U.clamp(vfw, 0, 80) * 9;
    v.rpm = U.approach(v.rpm, rpmT, h * 1800);
    v.anim.prop += Math.min(v.rpm / 60 * Math.PI * 2 * h, 0.9);
    // control surface animation
    v.anim.ail = U.approach(v.anim.ail || 0, ctl.roll, h * 6); v.anim.elev = U.approach(v.anim.elev || 0, ctl.pitch, h * 6); v.anim.rud = U.approach(v.anim.rud || 0, ctl.yaw, h * 6);
  };
  P._planeSurf = function (v) {
    v._surfT = (v._surfT || 0) - 1;
    if (!v._surf || v._surfT <= 0) { v._surf = this._surfaceHere(v.pos[0], v.pos[2], 0); v._surfT = 24; }
    return v._surf;
  };
  /** One sprung landing-gear wheel. */
  P._wheel = function (v, g, F, Tq, h, surf) {
    var E = this.E, r = qrot(v.q, g.p);
    var px = v.pos[0] + r[0], py = v.pos[1] + r[1], pz = v.pos[2] + r[2];
    var gh = E.groundHeight(px, pz), pen = gh - py;
    var st = v.anim.gear[g.wheel] || (v.anim.gear[g.wheel] = { comp: 0, contact: false, spin: 0 });
    if (pen <= 0) { st.comp = U.approach(st.comp, 0, h * 2); st.contact = false; st.spin *= 0.995; return; }
    var e = 0.5, gx = (E.groundHeight(px + e, pz) - E.groundHeight(px - e, pz)) / (2 * e), gz = (E.groundHeight(px, pz + e) - E.groundHeight(px, pz - e)) / (2 * e);
    var nl = Math.hypot(gx, 1, gz), n = [-gx / nl, 1 / nl, -gz / nl];
    var pv = cross(v.w, r), vp = [v.vel[0] + pv[0], v.vel[1] + pv[1], v.vel[2] + pv[2]], vn = dot(vp, n);
    var k = v.mass * GRAV / 3 / 0.09, c = 2 * Math.sqrt(k * v.mass / 3) * 0.7, travel = 0.28;
    var comp = Math.min(pen, travel);
    var Fn = k * comp - c * vn;
    if (pen > travel) Fn += k * 12 * (pen - travel) - c * 2 * vn;
    Fn = Math.max(0, Fn);
    if (!st.contact && -vn > 0.8) this._touchdown(v, [px, gh, pz], -vn, surf);
    if (!st.contact && -vn > 7.5 && !v.damaged) this._crash(v, 'hard landing');
    st.contact = true; st.comp = comp;
    v.onGround = true;
    // tyre frame: heading projected on the ground, nose wheel steers with the rudder pedals
    var fw = qrot(v.q, [0, 0, -1]);
    if (g.nose) { var sa = v.ctl.yaw * 0.32 * U.clamp01(1.3 - v.speed / 25); fw = qrot(qaxis(n[0], n[1], n[2], sa), fw); }
    var fd = dot(fw, n); fw = [fw[0] - n[0] * fd, fw[1] - n[1] * fd, fw[2] - n[2] * fd]; var fl = len(fw) || 1; fw = [fw[0] / fl, fw[1] / fl, fw[2] / fl];
    var sw = cross(n, fw);
    var vlong = dot(vp, fw), vlat = dot(vp, sw);
    var meff = v.mass / 3;
    var rr = (surf.rr * 0.6 + 0.012 + (g.nose ? 0 : v.ctl.brake * 0.55 * surf.mu));
    var fLong = -U.clamp(vlong * meff / h * 0.5, -rr * Fn, rr * Fn);
    var fLat = -U.clamp(vlat * meff / h * 0.5, -surf.mu * Fn, surf.mu * Fn);
    addAt(F, Tq, r, [n[0] * Fn + fw[0] * fLong + sw[0] * fLat, n[1] * Fn + fw[1] * fLong + sw[1] * fLat, n[2] * Fn + fw[2] * fLong + sw[2] * fLat]);
    st.spin -= vlong / 0.3 * h;
    st.vlong = vlong;
  };
  P._touchdown = function (v, p, vn, surf) {
    var fx = this.E.effects;
    if ((v.fx.touch || 0) > 0) return;
    v.fx.touch = 0.3;
    if (fx) {
      if (surf.dry > 0.3) fx.dust(p, U.clamp01(vn / 3), surf.dust);
      if (v.speed > 15) for (var i = 0; i < 4; i++) fx.emit(TERRA.game.Effects.K.SMOKE, [p[0], p[1] + 0.2, p[2]], [v.vel[0] * 0.3, 0.6, v.vel[2] * 0.3], 1.2 + Math.random(), 0.25, 0.8, [0.7, 0.7, 0.7], 0.3);
    }
    this._sfx('chirp', v, U.clamp01(vn / 4));
  };

  /** Crashes: debris, dust and sparks, engine dead until reset (R). */
  P._crash = function (v, why) {
    if (v.damaged) return;
    v.damaged = true; v.engineOn = false;
    var fx = this.E.effects, p = v.pos;
    if (fx) {
      fx.dust(p, 1, [0.5, 0.45, 0.38]); fx.dust(p, 1, [0.4, 0.38, 0.35]);
      fx.sparks(p, 40, 7); fx.chips([p[0], p[1] + 0.5, p[2]], [v.vel[0] * 0.05, 0, v.vel[2] * 0.05], 30, [0.85, 0.85, 0.82]);
      for (var i = 0; i < 12; i++) fx.emit(TERRA.game.Effects.K.SMOKE, [p[0] + (Math.random() - 0.5) * 2, p[1] + Math.random(), p[2] + (Math.random() - 0.5) * 2], [0, 1 + Math.random(), 0], 4 + Math.random() * 3, 0.6, 1.2, [0.25, 0.24, 0.23], 0.45);
      fx.shake = Math.max(fx.shake, this.current === v ? 0.7 : 0.2);
    }
    this._sfx('crash', v, 1);
    if (this.current === v) TERRA.ui.toast(why === 'ditched' ? 'Ditched in the water! Press R to recover the aircraft' : (why === 'hard landing' ? 'Hard landing — the gear collapsed. Press R to repair' : 'Crashed! Press R to reset'), 'warn');
  };

  /* ======================= bikes ======================= */
  P._bikeSurface = function (v) {
    var b = v.bk;
    b.surf = this._surfaceHere(v.pos[0], v.pos[2], b.slope || 0);
  };
  P._stepBike = function (v, h) {
    var E = this.E, sp = v.spec, info = v.info, b = v.bk, c = v.ctl, m = v.mass, g = GRAV;
    var cy = Math.cos(b.yaw), sy = Math.sin(b.yaw);
    var f = [-sy, 0, -cy], r = [cy, 0, -sy], half = info.wb / 2;
    var hr = E.groundHeight(v.pos[0] - f[0] * half, v.pos[2] - f[2] * half), hf = E.groundHeight(v.pos[0] + f[0] * half, v.pos[2] + f[2] * half);
    var hs = E.groundHeight(v.pos[0] + r[0] * 0.5, v.pos[2] + r[2] * 0.5) - E.groundHeight(v.pos[0] - r[0] * 0.5, v.pos[2] - r[2] * 0.5);
    var yc = (hr + hf) / 2, tp = Math.atan2(hf - hr, info.wb);
    b.slope = Math.hypot((hf - hr) / info.wb, hs);
    b.surfT -= h;
    if (!b.surf || b.surfT <= 0) { b.surfT = 0.2; this._bikeSurface(v); }
    var Sf = b.surf;
    var vf = b.vh[0] * f[0] + b.vh[1] * f[2], vl = b.vh[0] * r[0] + b.vh[1] * r[2];
    if (b.ycPrev === null) { b.ycPrev = yc; b.by = Math.max(b.by, yc); }
    var vg = (yc - b.ycPrev) / h; b.ycPrev = yc;
    vg = U.clamp(vg, -Math.abs(vf) * 1.4 - 2, Math.abs(vf) * 1.4 + 2);   // terrain mesh kinks are not launch ramps
    var dirt = sp.kind === 'dirt';
    var ext = 0.12, travel = dirt ? 0.26 : 0.12;
    var gap = b.by - yc;                                       // > 0: body above its rest height
    var contact = !b.air && !b.crashed && gap < ext;
    var omega = 0;
    // water: wading drag; deep water stalls the engine
    var wd = Sf.waterDepth > 0 ? Math.max(0, Sf.waterLevel - yc) : 0;
    // a step taller than the wheel (rock ledge, cliff) is a wall, not something to roll up
    if (!b.crashed) {
      var lead = vf >= 0 ? hf : hr, stepH = lead - b.by;
      if (stepH > info.R * 1.15 && Math.abs(vf) > 0.2) {
        var vin = Math.abs(vf);
        b.vh[0] -= f[0] * vf * 1.25; b.vh[1] -= f[2] * vf * 1.25;
        v.pos[0] -= f[0] * Math.sign(vf) * 0.05; v.pos[2] -= f[2] * Math.sign(vf) * 0.05;
        if (vin > 7) { b.crashed = true; b.crashT = 0; this._sfx('crash', v, 0.7); if (this.current === v) TERRA.ui.toast('Crashed into a ledge!', 'warn'); }
        else if (vin > 1.5) this._sfx('thud', v, vin / 7);
        vf = -vf * 0.25;
      }
    }
    if (contact) {
      // ---- traction-limited drive, braking, rolling resistance, slopes, air drag
      var Pw = dirt ? (v.engineOn ? sp.power * (c.boost ? 1 : 0.72) : 0) : (c.boost ? sp.sprint : sp.power);
      var drive = 0;
      if (c.throttle > 0) drive = c.throttle * Pw / Math.max(Math.abs(vf), dirt ? 3.2 : 1.4);
      if (dirt && vf > sp.vmax) drive = 0;                     // rev limiter
      if (!dirt && vf > 15) drive *= U.clamp01((18 - vf) / 3);   // spinning out on the pedals
      var Nr = m * g * Math.cos(tp) * (dirt ? 0.75 : 0.62);
      var maxT = Sf.mu * Nr;
      b.wheelspin = drive > maxT ? U.clamp01((drive - maxT) / maxT) : U.approach(b.wheelspin, 0, h * 3);
      drive = Math.min(drive, maxT);
      var brakeF = c.brake * Sf.mu * m * g * 0.85;
      var rrF = Sf.rr * m * g * Math.cos(tp) * (1 + (wd > 0.1 ? wd * 6 : 0));
      var aero = 0.5 * 1.2 * info.cda * vf * vf;
      var grade = m * g * Math.sin(tp);
      var vfn = vf + (drive - grade) / m * h;
      var res = (rrF + aero + (vfn > 0.05 || vfn < -0.05 ? brakeF : 0)) / m * h;
      if (Math.abs(vfn) <= res) vfn = 0; else vfn -= Math.sign(vfn) * res;
      if (c.brake > 0 && vf < 0.6 && c.throttle <= 0) vfn = Math.max(vfn - 1.6 * h, -1.6);   // walk / roll backwards
      // ---- steering: bicycle model, the front tyre can wash out
      var maxSteer = U.mix(0.62, 0.065, U.clamp01(Math.abs(vfn) / 24));
      b.steer = U.approach(b.steer, c.steer * maxSteer, h * 2.6);
      omega = vfn * Math.tan(b.steer) / info.wb;
      var maxLat = Sf.mu * g;
      var latA = Math.abs(vfn * omega);
      if (latA > maxLat) omega *= Math.sqrt(maxLat / latA);   // understeer: front tyre slides
      b.yaw += omega * h;
      // ---- lateral grip in the new heading (rear slides on ice, mud, wet rock)
      var vh0 = f[0] * vfn + r[0] * vl, vh2 = f[2] * vfn + r[2] * vl;
      cy = Math.cos(b.yaw); sy = Math.sin(b.yaw); f = [-sy, 0, -cy]; r = [cy, 0, -sy];
      var vf2 = vh0 * f[0] + vh2 * f[2], vl2 = vh0 * r[0] + vh2 * r[2];
      var grip = Sf.mu * g * h * (1 - b.wheelspin * 0.6) * (c.brake > 0 && Math.abs(vf2) > 3 ? 0.75 : 1);
      var dl = U.clamp(-vl2, -grip, grip);
      vl2 += dl;
      b.skid = Math.abs(vl2) > 0.4 ? U.clamp01(Math.abs(vl2) / 4) : U.approach(b.skid, 0, h * 4);
      b.vh[0] = f[0] * vf2 + r[0] * vl2; b.vh[1] = f[2] * vf2 + r[2] * vl2;
      vf = vf2;
      // ---- lean from centripetal balance (actual lateral acceleration)
      var aLat = U.clamp(vf * omega, -Sf.mu * g, Sf.mu * g);
      var leanT = Math.atan(U.clamp(aLat / g, -1.6, 1.6)) * 0.95;
      if (Math.abs(vf) < 0.8) leanT = v.driven ? 0.14 : 0.2;   // foot down / kickstand
      b.leanV += (55 * (leanT - b.lean) - 11 * b.leanV) * h;
      b.lean += b.leanV * h;
      // ---- suspension (sprung body over the wheels; follows terrain bumps)
      var kS = m * g / 0.05, cS = 2 * Math.sqrt(kS * m) * 0.55;
      var Fs = m * g + kS * (yc - b.by) - cS * (b.vy - vg);
      if (Fs < 0) Fs = 0;
      b.vy += (Fs / m - g) * h;
      b.by += b.vy * h;
      if (yc - b.by > travel) { var impact = vg - b.vy; b.by = yc - travel; if (b.vy < vg) b.vy = vg; if (impact > 3) this._bikeLand(v, impact, tp, true); }
      // hop / jump
      if (c.hop) { b.vy = Math.max(b.vy, vg) + (dirt ? 4.2 : 3.4); b.by += 0.02; c.hop = false; this._sfx('hop', v, 0.6); }
      // pitch follows the terrain
      b.pitchV += (90 * (tp - b.pitch) - 16 * b.pitchV) * h;
      b.pitch += b.pitchV * h;
      if (b.by - yc > ext) { b.air = true; b.airT = 0; }
      // trees: hit at speed = crash
      this._bikeTrees(v, f, vf);
      if (wd > 0.85 && dirt && v.engineOn) { v.engineOn = false; if (v.driven) TERRA.ui.toast('Engine flooded — too deep! Press R to restart', 'warn'); }
    } else {
      // ---- airborne / crashed
      c.hop = false;
      if (!b.crashed && !b.air) { b.air = true; b.airT = 0; }
      b.vy -= g * h;
      var drag = b.crashed ? 0 : 0.5 * 1.2 * info.cda / m * h;
      b.vh[0] -= b.vh[0] * Math.hypot(b.vh[0], b.vh[1]) * drag; b.vh[1] -= b.vh[1] * Math.hypot(b.vh[0], b.vh[1]) * drag;
      b.by += b.vy * h;
      if (!b.crashed) {
        b.pitchV += (c.pitch * 3.2 - b.pitchV * 0.8) * h;      // lean back / forward in the air
        b.pitch += b.pitchV * h;
        b.lean += b.leanV * h; b.leanV *= 1 - h * 1.5;
        b.airT += h;
        b.steer = U.approach(b.steer, c.steer * 0.3, h * 2);
        b.yaw += (c.steer * 0.6) * h;                         // body english
      } else {
        // sliding on its side
        var sl = Math.hypot(b.vh[0], b.vh[1]), dec = Sf.mu * g * 1.1 * h;
        if (sl <= dec) { b.vh[0] = 0; b.vh[1] = 0; } else { b.vh[0] -= b.vh[0] / sl * dec; b.vh[1] -= b.vh[1] / sl * dec; }
        b.lean = U.approach(b.lean, b.lean >= 0 ? 1.33 : -1.33, h * 4);
        b.pitch = U.approach(b.pitch, tp, h * 3);
        b.crashT += h;
        if (b.crashT > 2.4 && sl < 0.5 && v.driven) { b.crashed = false; b.lean = 0.15; b.leanV = 0; b.by = yc; b.vy = 0; if (v.spec.kind === 'dirt') v.engineOn = true; TERRA.ui.toast('Back on the bike'); }
        if (b.by < yc) { b.by = yc; b.vy = Math.max(0, b.vy); }
      }
      if (!b.crashed && b.by <= yc) {
        // touchdown: the suspension takes the impact from here (contact branch)
        var imp = vg - b.vy;
        b.air = false;
        this._bikeLand(v, imp, tp, false);
      }
    }
    v.pos[0] += b.vh[0] * h; v.pos[2] += b.vh[1] * h; v.pos[1] = b.by;
    // suspension pose for drawing: wheels stay on the ground while the body moves
    var compT = U.clamp(yc - b.by, -ext, travel);
    b.susp = compT;
    // derived rigid-body quantities (rendering, motion vectors, interactions)
    v.q = qmul(qmul(qaxis(0, 1, 0, b.yaw), qaxis(1, 0, 0, b.pitch)), qaxis(0, 0, 1, b.lean));
    v.vel[0] = b.vh[0]; v.vel[1] = b.vy; v.vel[2] = b.vh[1];
    v.w = [qrot(v.q, [0, 0, 1])[0] * b.leanV + r[0] * b.pitchV, omega + (b.air ? c.steer * 0.6 : 0), qrot(v.q, [0, 0, 1])[2] * b.leanV + r[2] * b.pitchV];
    v.speed = Math.hypot(b.vh[0], b.vh[1]); v.fwdSpeed = vf;
    b.yawRate = omega; b.wd = wd;
    var spin = vf / info.R * h;
    v.anim.wheel -= spin * (1 + b.wheelspin * 2.5); v.anim.wheelF -= b.air ? spin * 0.99 : spin;
    v.anim.steer = b.steer;
    // engine / gearbox (dirt bike)
    if (dirt) {
      var tops = [8.5, 14, 20, 26.5, 33];
      while (b.gear < 5 && vf > tops[b.gear - 1] * 0.94) b.gear++;
      while (b.gear > 1 && vf < tops[b.gear - 2] * 0.72) b.gear--;
      var rpmT = v.engineOn ? U.clamp(1500 + Math.max(0, vf) / tops[b.gear - 1] * 9500 + b.wheelspin * 3000 + (b.air ? c.throttle * 3000 : 0), 1500, 11500) : 0;
      if (v.engineOn && c.throttle < 0.05 && Math.abs(vf) < 0.5) rpmT = 1500;
      v.rpm = U.approach(v.rpm, rpmT, h * 22000);
    } else v.rpm = Math.abs(vf) / info.R / (Math.PI * 2) * 60;
  };
  P._bikeLand = function (v, impact, tp, bottom) {
    var b = v.bk, lim = v.spec.kind === 'dirt' ? 12 : 8;
    var bad = Math.abs(wrapA(b.pitch - tp)) > 0.75 || Math.abs(b.lean) > 0.85;
    if (impact > 2.2) {
      var fx = this.E.effects;
      if (fx && b.surf && b.surf.dry > 0.3) fx.dust([v.pos[0], v.pos[1], v.pos[2]], U.clamp01(impact / 8), b.surf.dust);
      this._sfx('land', v, U.clamp01(impact / 10));
    }
    if ((impact > lim || bad) && !bottom) {
      b.crashed = true; b.crashT = 0; b.air = false;
      if (v.spec.kind === 'dirt') v.engineOn = false;
      this._sfx('crash', v, 0.6);
      if (this.current === v) TERRA.ui.toast('Crashed! Getting back up…', 'warn');
    }
    b.pitch = bad ? b.pitch : U.mix(b.pitch, tp, 0.6);
    b.pitchV = 0;
  };
  P._bikeTrees = function (v, f, vf) {
    var veg = this.E.vegetation, b = v.bk;
    if (!veg || Math.abs(vf) < 0.3) return;
    b._treeT = (b._treeT || 0) - 1;
    if (b._treeT > 0 && Math.abs(vf) < 8) return;
    b._treeT = 4;
    var cols = veg.collidersNear(v.pos[0] + f[0] * 0.6, v.pos[2] + f[2] * 0.6, 3);
    for (var i = 0; i < cols.length; i += 4) {
      var dx = v.pos[0] + f[0] * 0.6 - cols[i], dz = v.pos[2] + f[2] * 0.6 - cols[i + 1], rr = cols[i + 2] + 0.35;
      var d2 = dx * dx + dz * dz;
      if (d2 > rr * rr) continue;
      var d = Math.sqrt(d2) || 1e-3, nx = dx / d, nz = dz / d;
      var vn = b.vh[0] * nx + b.vh[1] * nz;
      if (vn < 0) {
        var sp = Math.hypot(b.vh[0], b.vh[1]);
        b.vh[0] -= nx * vn * 1.3; b.vh[1] -= nz * vn * 1.3;
        if (-vn > 6) { b.crashed = true; b.crashT = 0; this._sfx('crash', v, 0.8); if (this.current === v) TERRA.ui.toast('Hit a tree!', 'warn'); }
        else if (sp > 1.5) this._sfx('thud', v, U.clamp01(-vn / 6));
      }
      v.pos[0] += nx * (rr - d) * 0.5; v.pos[2] += nz * (rr - d) * 0.5;
    }
  };

  /* ======================= interactions between bodies ======================= */
  P._collide = function (h) {
    var L = this.list, th = this.E.throwables, pl = this.E.player;
    // vehicles against each other (bounding spheres, broad phase by distance)
    for (var i = 0; i < L.length; i++) for (var j = i + 1; j < L.length; j++) {
      var a = L[i], b = L[j];
      if (!a.active && !b.active) continue;
      var ra = a.info.radius * (a.cat === 'plane' ? 0.5 : 0.75), rb = b.info.radius * (b.cat === 'plane' ? 0.5 : 0.75);
      var d = [b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2]], dl = len(d);
      if (dl >= ra + rb || dl < 1e-4) continue;
      var n = [d[0] / dl, d[1] / dl * 0.3, d[2] / dl], pen = ra + rb - dl, wa = 1 / a.mass, wb = 1 / b.mass, ws = wa + wb;
      this._push(a, n, -pen * wa / ws); this._push(b, n, pen * wb / ws);
      var vr = (b.vel[0] - a.vel[0]) * n[0] + (b.vel[2] - a.vel[2]) * n[2];
      if (vr < 0) { var jn = -1.2 * vr / ws; this._kick(a, n, -jn * wa); this._kick(b, n, jn * wb); if (-vr > 3) this._sfx('thud', a, U.clamp01(-vr / 10)); }
      a.asleep = b.asleep = false;
    }
    // vehicles push thrown objects and the player
    for (var k = 0; k < L.length; k++) {
      var v = L[k];
      if (!v.active) continue;
      var rv = v.info.radius * (v.cat === 'plane' ? 0.55 : 0.7);
      if (th && th.objs.length) for (var o = 0; o < th.objs.length; o++) {
        var ob = th.objs[o]; if (ob.held) continue; var or = th.smpFor(ob).radius;
        var dx = ob.pos[0] - v.pos[0], dy = ob.pos[1] - v.pos[1], dz = ob.pos[2] - v.pos[2], dd = Math.hypot(dx, dy * 1.5, dz);
        if (dd > rv + or || dd < 1e-4) continue;
        var nx = dx / dd, ny = dy / dd, nz = dz / dd;
        ob.pos[0] += nx * (rv + or - dd); ob.pos[2] += nz * (rv + or - dd);
        var rel = (ob.vel[0] - v.vel[0]) * nx + (ob.vel[1] - v.vel[1]) * ny + (ob.vel[2] - v.vel[2]) * nz;
        if (rel < 0) { ob.vel[0] -= nx * rel * 1.4; ob.vel[1] -= ny * rel * 1.4 - Math.abs(rel) * 0.2; ob.vel[2] -= nz * rel * 1.4; ob.sleep = 0; }
      }
      if (v !== this.current && pl.mode !== 'free' && !this.current) {
        var px = pl.pos[0] - v.pos[0], pz = pl.pos[2] - v.pos[2], pd = Math.hypot(px, pz);
        var pr = rv * (v.cat === 'bike' ? 0.6 : 0.85);
        if (pd < pr && pl.pos[1] > v.pos[1] - 2.5 && pl.pos[1] < v.pos[1] + 2) {
          pl.pos[0] = v.pos[0] + px / (pd || 1) * pr; pl.pos[2] = v.pos[2] + pz / (pd || 1) * pr;
        }
      }
    }
    void h;
  };
  P._push = function (v, n, s) {
    if (v.bk) { v.pos[0] += n[0] * s; v.pos[2] += n[2] * s; } else { v.pos[0] += n[0] * s; v.pos[1] += n[1] * s; v.pos[2] += n[2] * s; }
  };
  P._kick = function (v, n, s) {
    if (v.bk) { v.bk.vh[0] += n[0] * s; v.bk.vh[1] += n[2] * s; if (Math.abs(s) > 6) { v.bk.crashed = true; v.bk.crashT = 0; } }
    else { v.vel[0] += n[0] * s; v.vel[2] += n[2] * s; }
  };

  /* ======================= per-frame effects ======================= */
  P._frameFx = function (v, dt) {
    var E = this.E, fx = E.effects, env = E.environment.env, info = v.info;
    // wet from rain / spray, drying in sun and wind; mud from soft wet ground
    var rainWet = env.rain > 0.05 ? 1 : 0;
    var wetT = Math.max(rainWet, v.immersion > 0.01 && v.cat !== 'plane' ? 0.85 : 0, v.cat === 'boat' && v.speed > 4 ? 0.7 : 0);
    v.wet = wetT > v.wet ? Math.min(wetT, v.wet + dt * 0.8) : Math.max(wetT, v.wet - dt / 60 * (0.5 + env.windStrength + env.dayFactor));
    if (!v.active || dt <= 0 || !fx) return;
    var near = v.camDist < 350;
    if (v.cat === 'boat') this._boatFx(v, dt, near);
    else if (v.cat === 'plane') this._planeFx(v, dt, near, env);
    else this._bikeFx(v, dt, near);
    void info;
  };
  P._boatFx = function (v, dt, near) {
    var E = this.E, fx = E.effects, info = v.info, q = v.rq, p = v.rpos, F = v.fx, ws = E.watersim, it = E.interaction;
    if (v.immersion <= 0.01) return;
    var sp = v.speed, wl = v.wi ? v.wi.level : p[1];
    var stern = qrot(q, [0, 0, info.L * 0.5]), bowL = qrot(q, [-info.B * 0.42, 0, -info.L * 0.3]), bowR = qrot(q, [info.B * 0.42, 0, -info.L * 0.3]);
    var sx = p[0] + stern[0], sz = p[2] + stern[2];
    var ax = qrot(q, [1, 0, 0]), back = qrot(q, [0, 0, 1]);
    F.wake -= dt;
    if (F.wake <= 0 && sp > 0.5) {
      F.wake = 0.07;
      if (ws) {
        ws.addDrop(sx, sz, info.B * 0.45, U.clamp(sp * 0.008, 0.004, 0.06));
        // V-wake: disturbances off both bow shoulders
        ws.addDrop(p[0] + bowL[0], p[2] + bowL[2], info.B * 0.3, U.clamp(sp * 0.005, 0.002, 0.04));
        ws.addDrop(p[0] + bowR[0], p[2] + bowR[2], info.B * 0.3, U.clamp(sp * 0.005, 0.002, 0.04));
      }
      if (it) { it.stamps.push({ kind: 2, x: sx, z: sz, r: info.B * (0.6 + v.planing * 0.4), s: U.clamp01(sp / 6) }); if (sp > 6) it.stamps.push({ kind: 2, x: p[0], z: p[2], r: info.B * 0.7, s: U.clamp01(sp / 14) }); }
    }
    if (!near) return;
    // bow spray when running fast, prop wash behind the stern
    F.spray -= dt;
    if (F.spray <= 0 && sp > 4) {
      F.spray = U.mix(0.12, 0.03, U.clamp01(sp / 20));
      var st = U.clamp01((sp - 4) / 16) * (0.5 + (v.bowSub || 0) * 0.15);
      fx.spray([p[0] + bowL[0], wl + 0.05, p[2] + bowL[2]], [-ax[0], 0, -ax[2]], st);
      fx.spray([p[0] + bowR[0], wl + 0.05, p[2] + bowR[2]], [ax[0], 0, ax[2]], st);
      if (Math.abs(v.thrust || 0) > 200) fx.spray([sx, wl + 0.05, sz], [back[0], 0, back[2]], U.clamp01(Math.abs(v.thrust) / v.spec.thrust) * 0.6);
    }
    // slamming into waves
    F.splash -= dt;
    if (F.splash <= 0 && v.vel[1] < -1.6 && (v.bowSub || 0) > 0.5 && sp > 3) {
      F.splash = 0.5;
      var bp = qrot(q, info.bow);
      fx.splash([p[0] + bp[0], wl, p[2] + bp[2]], U.clamp01(-v.vel[1] / 4) * 0.8);
      if (ws) ws.addDrop(p[0] + bp[0], p[2] + bp[2], info.B * 0.6, 0.08);
      this._sfx('slap', v, U.clamp01(-v.vel[1] / 4));
    }
    // outboard exhaust at idle
    F.exhaust -= dt;
    if (F.exhaust <= 0 && v.engineOn) { F.exhaust = 0.25; var ep = qrot(q, [0, 0.3, info.L * 0.5 + 0.3]); fx.exhaust([p[0] + ep[0], p[1] + ep[1], p[2] + ep[2]], v.vel, false); }
  };
  P._fxPropStrike = function (v, p) {
    var fx = this.E.effects; if (!fx) return;
    fx.dust(p, 0.6, [0.6, 0.55, 0.45]); fx.sparks(p, 6, 3);
    this._sfx('scrape', v, 0.5);
  };
  P._planeFx = function (v, dt, near, env) {
    var E = this.E, fx = E.effects, q = v.rq, p = v.rpos, F = v.fx, info = v.info;
    F.touch = (F.touch || 0) - dt;
    // contrails: cold, humid air at altitude; wingtip vortices when pulling g in moist air
    var temp = E.environment.local.temp - Math.max(0, v.agl) * 0.0065;
    var load = v.cl * 0.5 * RHO_A * v.airspeed * v.airspeed * info.S / (v.mass * GRAV);
    var humid = Math.max(env.rain, (env.cloudCover || 0) * 0.6, env.fog || 0);
    var trail = (temp < -12 && v.airspeed > 30) || (load > 2.2 && humid > 0.3 && v.airspeed > 25);
    F.contrail -= dt;
    if (trail && F.contrail <= 0) {
      F.contrail = 0.045;
      for (var i = 0; i < 2; i++) { var tp = qrot(q, info.tips[i]); fx.contrail([p[0] + tp[0], p[1] + tp[1], p[2] + tp[2]]); }
    }
    if (!near) return;
    // exhaust stacks
    F.exhaust -= dt;
    if (F.exhaust <= 0 && v.engineOn) { F.exhaust = U.mix(0.2, 0.06, v.ctl.throttle); var ep = qrot(q, [0.25, -0.42, -2.6]); fx.exhaust([p[0] + ep[0], p[1] + ep[1], p[2] + ep[2]], v.vel, v.ctl.throttle > 0.8); }
    // prop wash / downwash raising dust or spray near the ground
    F.dust -= dt;
    if (F.dust <= 0 && v.engineOn && v.agl < 5 && v.ctl.throttle > 0.3) {
      F.dust = 0.07;
      var bk = qrot(q, [0, 0, 5]), x = p[0] + bk[0], z = p[2] + bk[2];
      if (v.onWater) fx.spray([x, v.wi.level + 0.1, z], [bk[0] / 5, 0, bk[2] / 5], v.ctl.throttle * 0.7);
      else { var sf = this._planeSurf(v); if (sf.dry > 0.3) fx.dust([x, E.groundHeight(x, z), z], v.ctl.throttle * 0.6, sf.dust); }
    }
    // float spray on the water run
    if (v.onWater && v.speed > 5) {
      F.spray -= dt;
      if (F.spray <= 0) {
        F.spray = 0.05;
        for (var s = -1; s <= 1; s += 2) { var fp = qrot(q, [s * 1.25, -1.6, -1.5]); fx.spray([p[0] + fp[0], v.wi.level + 0.05, p[2] + fp[2]], [s * qrot(q, [1, 0, 0])[0], 0, s * qrot(q, [1, 0, 0])[2]], U.clamp01(v.speed / 25)); }
        if (E.watersim) E.watersim.addDrop(p[0], p[2], 2.5, U.clamp(v.speed * 0.004, 0.003, 0.05));
        if (E.interaction) E.interaction.stamps.push({ kind: 2, x: p[0], z: p[2], r: 3.5, s: U.clamp01(v.speed / 15) });
      }
    }
    // rolling on the ground: tyre tracks & grass
    if (v.onGround && E.interaction && v.speed > 0.5) {
      F.track -= dt;
      if (F.track <= 0) {
        F.track = 0.05;
        var sf2 = this._planeSurf(v), yaw = Math.atan2(-qrot(q, [0, 0, -1])[0], -qrot(q, [0, 0, -1])[2]);
        var gs = info.gear;
        for (var g = 0; g < gs.length; g++) { var wp = qrot(q, gs[g].p); E.interaction.stamps.push({ kind: 3, x: p[0] + wp[0], z: p[2] + wp[2], ang: yaw, r: 0.12, len: Math.min(1.2, v.speed * 0.05 + 0.1), s: sf2.soft * 0.8 }); }
      }
    }
  };
  P._bikeFx = function (v, dt, near) {
    var E = this.E, fx = E.effects, b = v.bk, F = v.fx, p = v.rpos, q = v.rq, Sf = b.surf;
    if (!Sf) return;
    var sp = v.speed, f = qrot(q, [0, 0, -1]), half = v.info.wb / 2;
    var rear = [p[0] - f[0] * half, p[1], p[2] - f[2] * half], front = [p[0] + f[0] * half, p[1], p[2] + f[2] * half];
    var onG = !b.air && !b.crashed;
    // mud builds up on the bike in soft wet ground, washes off in water and rain
    if (onG && sp > 1) {
      var mudGain = (Sf.name === 'mud' ? 1 : (Sf.name === 'puddle' ? 0.5 : 0)) + Sf.wet * Sf.soft * 0.4;
      v.mud = U.clamp01(v.mud + mudGain * dt * sp * 0.012);
    }
    if (b.wd > 0.2 || this.E.environment.env.rain > 0.5) v.mud = Math.max(0, v.mud - dt * (b.wd > 0.2 ? 0.25 : 0.01));
    // ruts and flattened grass
    if (onG && E.interaction && sp > 0.4) {
      var yaw = b.yaw, moved = v.lastTrack ? Math.hypot(rear[0] - v.lastTrack[0], rear[2] - v.lastTrack[2]) : 9;
      if (moved > 0.35) {
        var depth = Sf.soft * (v.spec.kind === 'dirt' ? 0.9 : 0.55) * (1 + b.wheelspin);
        E.interaction.stamps.push({ kind: 3, x: (rear[0] + (v.lastTrack ? v.lastTrack[0] : rear[0])) / 2, z: (rear[2] + (v.lastTrack ? v.lastTrack[2] : rear[2])) / 2, ang: yaw, r: v.spec.kind === 'dirt' ? 0.075 : 0.045, len: Math.min(moved * 0.5 + 0.05, 1.0), s: depth });
        E.interaction.stamps.push({ kind: 3, x: front[0], z: front[2], ang: yaw - b.steer, r: v.spec.kind === 'dirt' ? 0.07 : 0.04, len: 0.15, s: depth * 0.8 });
        v.lastTrack = rear;
      }
    }
    if (!near || !fx) return;
    // dust trail on dry loose ground, roost from a spinning rear wheel, mud & water spray
    F.dust -= dt;
    if (onG && F.dust <= 0 && sp > 3) {
      F.dust = U.mix(0.16, 0.04, U.clamp01(sp / 25));
      var loose = Sf.name === 'sand' || Sf.name === 'path' || Sf.name === 'rock' || Sf.name === 'snow' ? 1 : (Sf.name === 'grass' || Sf.name === 'leaves' ? 0.25 : 0);
      if (Sf.dry > 0.3 && loose > 0) fx.dust([rear[0], rear[1], rear[2]], U.clamp01(sp / 18) * loose * (1 + b.wheelspin), Sf.dust);
      if ((Sf.name === 'mud' || Sf.name === 'puddle' || Sf.wet > 0.6) && Sf.name !== 'rock') fx.chips([rear[0], rear[1] + 0.25, rear[2]], [-f[0] * 0.8, 0, -f[2] * 0.8], 2 + sp * 0.3, Sf.name === 'puddle' ? [0.42, 0.4, 0.36] : [0.24, 0.18, 0.12]);
      if (Sf.name === 'puddle' || b.wd > 0.03) {
        fx.spray([rear[0], rear[1] + 0.05, rear[2]], [-f[0], 0, -f[2]], U.clamp01(sp / 10) * 0.6);
        if (E.watersim) E.watersim.addDrop(rear[0], rear[2], 0.5, U.clamp(sp * 0.006, 0.003, 0.04));
      }
    }
    if (onG && b.wheelspin > 0.25 && Sf.soft > 0.1 && Math.random() < 0.6) fx.chips([rear[0], rear[1] + 0.15, rear[2]], [-f[0] * 1.5, 0.5, -f[2] * 1.5], 3, Sf.dust);
    if (onG && b.skid > 0.4 && Sf.dry > 0.3 && Math.random() < 0.5) fx.dust(rear, b.skid * 0.5, Sf.dust);
    // exhaust
    F.exhaust -= dt;
    if (v.spec.kind === 'dirt' && v.engineOn && F.exhaust <= 0) { F.exhaust = U.mix(0.3, 0.07, v.ctl.throttle); var ep = qrot(q, [0.16, 0.86, v.info.wb * 0.5 + 0.12]); fx.exhaust([p[0] + ep[0], p[1] + ep[1], p[2] + ep[2]], v.vel, v.ctl.throttle > 0.7 && v.rpm > 8000); }
    // entering water
    if (b.wd > 0.2 && sp > 2) {
      F.splash -= dt;
      if (F.splash <= 0) { F.splash = 0.15; fx.splash([front[0], b.surf.waterLevel, front[2]], U.clamp01(sp / 10) * 0.6); }
    }
  };

  /* ======================= camera ======================= */
  P._camera = function (dt) {
    var v = this.current, E = this.E, pl = E.player, info = v.info, ctl = E.settings.controls;
    var p = v.rpos, q = v.rq, mode = this.camMode[v.cat];
    var fwd = qrot(q, [0, 0, -1]), upB = qrot(q, [0, 1, 0]);
    var eye, dir, up;
    var ly = this.look.yaw, lp = this.look.pitch;
    var shake = E.effects ? E.effects.shake : 0;
    if (mode === 'cockpit') {
      var ep = info.eye;
      if (v.bk) ep = [ep[0], ep[1] - v.bk.susp, ep[2]];
      var eo = qrot(q, ep);
      eye = [p[0] + eo[0], p[1] + eo[1], p[2] + eo[2]];
      var dl = [-Math.sin(ly) * Math.cos(lp - 0.06), Math.sin(lp - 0.06), -Math.cos(ly) * Math.cos(lp - 0.06)];
      // bikes and boats: the head stays more level than the vehicle (vestibular reflex)
      var qv = q;
      if (v.cat !== 'plane') { var hy = Math.atan2(-fwd[0], -fwd[2]); qv = qlerp(qaxis(0, 1, 0, hy), q, v.cat === 'bike' ? 0.35 : 0.6); }
      dir = qrot(qv, dl); up = qrot(qv, [0, 1, 0]);
    } else {
      var dist = info.chase[0] * (this.zoom || 1), ht = info.chase[1];
      if (v.cat === 'plane') {
        // follow the aircraft's full attitude (smoothed), so rolls and loops read clearly
        this.cam = this.cam || { q: q.slice(), yaw: 0 };
        this.cam.q = qlerp(this.cam.q, q, 1 - Math.exp(-dt * 4.5));
        var qc = this.cam.q;
        var dLoc = [-Math.sin(ly) * Math.cos(lp - 0.1), Math.sin(lp - 0.1), -Math.cos(ly) * Math.cos(lp - 0.1)];
        dir = qrot(qc, dLoc);
        var lift = qrot(qc, [0, ht, 0]);
        var tgt = [p[0] + lift[0] * 0.35, p[1] + lift[1] * 0.35, p[2] + lift[2] * 0.35];
        eye = [tgt[0] - dir[0] * dist + lift[0] * 0.65, tgt[1] - dir[1] * dist + lift[1] * 0.65, tgt[2] - dir[2] * dist + lift[2] * 0.65];
        var uq = qrot(qc, [0, 1, 0]);
        up = [uq[0] * 0.55, uq[1] * 0.55 + 0.45, uq[2] * 0.55];
      } else {
        // heading-locked chase camera with lag, slight lean with the bike / boat
        var hy2 = Math.atan2(-fwd[0], -fwd[2]);
        var mv = Math.hypot(v.vel[0], v.vel[2]);
        if (mv > 2.5 && v.cat === 'bike') { var vy2 = Math.atan2(-v.vel[0], -v.vel[2]); if (Math.abs(wrapA(vy2 - hy2)) < 1.2) hy2 = hy2 + wrapA(vy2 - hy2) * 0.5; }   // follow drifts
        this.cam = this.cam || { yaw: hy2, q: null };
        this.cam.yaw += wrapA(hy2 - this.cam.yaw) * (1 - Math.exp(-dt * (v.cat === 'bike' ? 5 : 3)));
        var cyaw = this.cam.yaw + ly, cp = -0.2 + lp;
        dir = [-Math.sin(cyaw) * Math.cos(cp), Math.sin(cp), -Math.cos(cyaw) * Math.cos(cp)];
        var tgt2 = [p[0], p[1] + ht * 0.62 - (v.bk ? v.bk.susp : 0), p[2]];
        eye = [tgt2[0] - dir[0] * dist, tgt2[1] - dir[1] * dist + ht * 0.25, tgt2[2] - dir[2] * dist];
        var lean = v.bk ? v.bk.lean * 0.18 : 0;
        up = [Math.cos(cyaw) * Math.sin(lean), Math.cos(lean), -Math.sin(cyaw) * Math.sin(lean)];
        void upB;
      }
      // keep the camera out of the terrain and above the water
      var gh = E.groundHeight(eye[0], eye[2]) + 0.5;
      if (eye[1] < gh) eye[1] = gh;
      if (v.wi && v.wi.level > -1e4 && eye[1] < v.wi.level + 0.6 && v.cat !== 'bike') eye[1] = v.wi.level + 0.6;
    }
    if (shake > 0) { var s = shake * 0.08; eye = [eye[0] + (Math.random() - 0.5) * s, eye[1] + (Math.random() - 0.5) * s, eye[2] + (Math.random() - 0.5) * s]; }
    var dlen = len(dir) || 1; dir = [dir[0] / dlen, dir[1] / dlen, dir[2] / dlen];
    pl.camPos = eye; pl.forward = dir; pl.camUp = up; pl.roll = 0;
    pl.yaw = Math.atan2(-dir[0], -dir[2]); pl.pitch = Math.asin(U.clamp(dir[1], -1, 1));
    // the "player" rides along (streaming, environment, audio and the trail map follow the vehicle)
    var so = qrot(q, info.seat || [0, 1, 0]);
    pl.pos = [p[0] + so[0], p[1] + so[1], p[2] + so[2]];
    pl.vel = v.vel.slice(); pl.speed = v.speed; pl.onGround = false; pl.swimming = false; pl.climbing = false; pl.crouch = 0;
    var fovT = ctl.motionEffects ? U.clamp((v.speed - 8) * 0.25, 0, 10) : 0;
    pl.fovBoost = U.damp(pl.fovBoost || 0, fovT, 3, dt);
  };

  /* ======================= HUD ======================= */
  P._buildDom = function () {
    var hud = document.getElementById('hud') || document.body;
    function el(tag, id, cls, html) { var e = document.createElement(tag); if (id) e.id = id; if (cls) e.className = cls; if (html) e.innerHTML = html; hud.appendChild(e); return e; }
    this.dom = {};
    this.dom.hud = el('div', 'vehHud', 'hidden', '<div class="vh-name"></div><div class="vh-big"><b class="vh-speed">0</b><span class="vh-unit">km/h</span></div><div class="vh-bar"><i></i></div><div class="vh-grid"></div><div class="vh-warn"></div>');
    this.dom.prompt = el('div', 'vehPrompt', 'hidden');
    this.dom.hints = el('div', 'vehHints', 'hidden');
    var items = MENU.map(function (m, i) { return '<div class="vm-item" data-type="' + m[0] + '"><kbd>' + (i + 1) + '</kbd><b>' + m[1] + '</b><span>' + m[2] + '</span></div>'; }).join('');
    this.dom.menu = el('div', 'vehMenu', 'hidden', '<div class="vm-head">VEHICLES <span>press a number · N to close</span></div>' + items);
    var self = this;
    this.dom.menu.addEventListener('mousedown', function (e) {
      var it = e.target.closest ? e.target.closest('.vm-item') : null;
      if (it) { self.spawn(it.getAttribute('data-type')); self.toggleMenu(false); e.stopPropagation(); }
    });
    this.dom.name = this.dom.hud.querySelector('.vh-name'); this.dom.speed = this.dom.hud.querySelector('.vh-speed'); this.dom.unit = this.dom.hud.querySelector('.vh-unit');
    this.dom.bar = this.dom.hud.querySelector('.vh-bar i'); this.dom.grid = this.dom.hud.querySelector('.vh-grid'); this.dom.warn = this.dom.hud.querySelector('.vh-warn');
  };
  P.handleKeys = function (input) {
    if (this.menuOpen) {
      for (var i = 0; i < ORDER.length; i++) if (input.hit('Digit' + (i + 1)) || input.hit('Numpad' + (i + 1))) { this.spawn(ORDER[i]); this.toggleMenu(false); return; }
    }
    if (input.hit('KeyN')) this.toggleMenu();
    if (input.hit('KeyF')) {
      if (this.current) this.exit();
      else { var v = this.nearest(1.0); if (v) this.enter(v); }
    }
    if (this.current && input.hit('KeyR')) this.reset(this.current);
  };
  P._prompt = function (dt) {
    this._promptT = (this._promptT || 0) - dt;
    if (this._promptT > 0) return;
    this._promptT = 0.15;
    if (this.current || this.E.player.mode === 'free') { this.dom.prompt.classList.add('hidden'); return; }
    var v = this.nearest(1.0);
    if (v) {
      this.dom.prompt.innerHTML = '<kbd>F</kbd> ' + (v.cat === 'bike' ? 'Ride' : (v.cat === 'plane' ? 'Fly' : 'Drive')) + ' ' + v.spec.name + (v.damaged ? ' <span class="warn">(damaged — R to repair once aboard)</span>' : '');
      this.dom.prompt.classList.remove('hidden');
    } else this.dom.prompt.classList.add('hidden');
  };
  P._hud = function (dt) {
    this._hudT = (this._hudT || 0) - dt;
    if (this._hudT > 0) return;
    this._hudT = 0.1;
    var v = this.current, d = this.dom, grid = [], warn = '';
    d.name.textContent = v.spec.name + (v.damaged ? ' — damaged' : '');
    if (v.cat === 'boat') {
      d.speed.textContent = (v.speed * 1.944).toFixed(1); d.unit.textContent = 'knots';
      d.bar.style.width = Math.round(Math.abs(v.ctl.throttle) * 100) + '%'; d.bar.className = v.ctl.throttle < 0 ? 'rev' : '';
      grid.push(['Throttle', (v.ctl.throttle < 0 ? 'astern ' : '') + Math.round(Math.abs(v.ctl.throttle) * 100) + '%'], ['RPM', Math.round(v.rpm)], ['Depth', v.keelDepth > 0 ? v.keelDepth.toFixed(1) + ' m' : '—'], ['Trim', v.planing > 0.5 ? 'planing' : (v.speed > 2 ? 'displacement' : 'idle')]);
      if (v.keelDepth >= 0 && v.keelDepth < v.info.D + 0.6) warn = 'SHALLOW WATER';
      if (v.grounded) warn = 'AGROUND';
      if (v.wi && v.wi.type === 3) grid.push(['Current', Math.hypot(v.wi.fx, v.wi.fz).toFixed(1) + ' m/s']);
    } else if (v.cat === 'plane') {
      d.speed.textContent = Math.round(v.airspeed * 1.944); d.unit.textContent = 'kt IAS';
      d.bar.style.width = Math.round(v.ctl.throttle * 100) + '%'; d.bar.className = '';
      var fwd = qrot(v.q, [0, 0, -1]), hdg = (Math.atan2(fwd[0], -fwd[2]) * 180 / Math.PI + 360) % 360;
      grid.push(['Throttle', Math.round(v.ctl.throttle * 100) + '%'], ['Alt', Math.round((v.pos[1] - this.E.gen.SEA) * 3.281) + ' ft'], ['AGL', Math.round(Math.max(0, v.agl)) + ' m'], ['V/S', Math.round(v.vel[1] * 196.85) + ' fpm'], ['HDG', ('00' + Math.round(hdg)).slice(-3) + '°'], ['RPM', Math.round(v.rpm)]);
      if (Math.abs(v.alpha) > 0.22 && !v.onGround && v.airspeed > 5) warn = 'STALL';
      else if (v.agl < 60 && v.vel[1] < -6 && !v.onGround) warn = 'SINK RATE — PULL UP';
      if (v.ctl.brake && v.onGround) grid.push(['Brakes', 'on']);
    } else {
      d.speed.textContent = Math.round(v.speed * 3.6); d.unit.textContent = 'km/h';
      d.bar.style.width = Math.round(v.ctl.throttle * 100) + '%'; d.bar.className = '';
      var b = v.bk;
      grid.push(['Surface', b.surf ? b.surf.name : '—'], ['Grade', Math.round(Math.tan(b.pitch) * 100) + '%'], ['Lean', Math.round(b.lean * 57.3) + '°']);
      if (v.spec.kind === 'dirt') grid.push(['Gear', b.gear], ['RPM', Math.round(v.rpm)]);
      else grid.push(['Cadence', Math.round(v.ctl.throttle > 0 ? v.speed / (v.info.R * 2 * Math.PI) * 60 / 2.6 : 0) + ' rpm']);
      if (b.air) warn = 'AIRBORNE ' + b.airT.toFixed(1) + ' s';
      if (b.skid > 0.5) warn = 'SLIDING';
      if (b.crashed) warn = 'CRASHED';
      if (b.surf && b.surf.name === 'ice') warn = warn || 'ICE';
    }
    if (!v.engineOn && v.cat !== 'bike' || (v.cat === 'bike' && v.spec.kind === 'dirt' && !v.engineOn)) grid.push(['Engine', v.damaged ? 'dead' : 'off']);
    d.grid.innerHTML = grid.map(function (g) { return '<span>' + g[0] + '</span><b>' + g[1] + '</b>'; }).join('');
    d.warn.textContent = warn; d.warn.style.display = warn ? '' : 'none';
  };
  P.statusLine = function () {
    var v = this.current;
    if (!v) return '';
    return v.spec.name + ' · ' + Math.round(v.speed * 3.6) + ' km/h · physics ' + this.ms.toFixed(2) + ' ms · ' + this.list.length + ' vehicle' + (this.list.length > 1 ? 's' : '');
  };

  /* ======================= lights ======================= */
  P.lights = function (frame) {
    var out = [], o = frame.origin, env = frame.env, night = 1 - env.dayFactor;
    for (var i = 0; i < this.list.length; i++) {
      var v = this.list[i];
      if (!v.lightsOn || v.camDist > 250 || out.length >= 3) continue;
      var info = v.info, q = v.rq, p = v.rpos;
      var a = v.cat === 'plane' ? [0, -0.3, -12] : (v.cat === 'bike' ? [0, 0.6, -info.wb * 0.5 - 6] : [0, 1.0, -info.L * 0.5 - 7]);
      if (v.cat === 'bike') a[2] += info.wb * 0.5;
      var lp = qrot(q, a), gh = this.E.groundHeight(p[0] + lp[0], p[2] + lp[2]);
      var y = Math.max(p[1] + lp[1], gh + 1.2);
      var k = 0.35 + night * 0.65;
      out.push({ pos: [p[0] + lp[0] - o[0], y, p[2] + lp[2] - o[1]], radius: v.cat === 'plane' ? 34 : 24, color: [5.2 * k, 4.9 * k, 4.2 * k] });
    }
    return out;
  };

  /* ======================= rendering ======================= */
  P._partMatrix = function (v, part, out) {
    var a = v.anim, ax = 0, ang = 0, pv = part.pivot;
    switch (part.kind) {
      case 'steer': ang = -a.steer; ax = 1; break;
      case 'spinZ': ang = a.prop; ax = 2; break;
      case 'spinX':
        if (v.cat === 'plane') { var st = a.gear[part.name]; ang = st ? st.spin : 0; } else ang = a.wheel;
        ax = 0; break;
      case 'ailL': ang = (a.ail || 0) * 0.35; ax = 0; break;
      case 'ailR': ang = -(a.ail || 0) * 0.35; ax = 0; break;
      case 'elev': ang = -(a.elev || 0) * 0.4; ax = 0; break;
      case 'rudder': ang = -(a.rud || 0) * 0.4; ax = 1; break;
      case 'fork': break;
      case 'spinXFork': break;
    }
    var susp = v.bk ? v.bk.susp : 0;
    if (part.kind === 'fork' || part.kind === 'spinXFork') {
      var fax = part.kind === 'fork' ? part.axis : this._forkAxis(v);
      var fpiv = part.kind === 'fork' ? pv : this._forkPivot(v);
      m4QP(this.mLoc, qaxis(fax[0], fax[1], fax[2], a.steer), fpiv[0], fpiv[1] + susp * 0.5, fpiv[2]);
      if (part.kind === 'fork') { out.set(this.mLoc); return out; }
      m4QP(this.mLoc2, qaxis(1, 0, 0, a.wheelF), pv[0] - fpiv[0], pv[1] - fpiv[1] + susp * 0.5, pv[2] - fpiv[2]);
      M.multiply(out, this.mLoc, this.mLoc2);
      return out;
    }
    var qq = ax === 0 ? qaxis(1, 0, 0, ang) : (ax === 1 ? qaxis(0, 1, 0, ang) : qaxis(0, 0, 1, ang));
    var py = pv[1];
    if (v.cat === 'plane' && part.kind === 'spinX') { var gs = a.gear[part.name]; py += gs ? gs.comp : 0; }
    if (v.bk && part.name === 'wheelR') py += susp;
    m4QP(out, qq, pv[0], py, pv[2]);
    if (part.parent) {
      var par = this._findPart(v, part.parent);
      if (par) { this._partMatrix(v, par, this.mLoc2); var tmp = new Float32Array(16); M.multiply(tmp, this.mLoc2, out); out.set(tmp); }
    }
    return out;
  };
  P._findPart = function (v, name) {
    var ps = v.model.lods[0].parts;
    for (var i = 0; i < ps.length; i++) if (ps[i].name === name) return ps[i];
    return null;
  };
  P._forkAxis = function (v) { var f = this._findPart(v, 'fork'); return f ? f.axis : [0, 1, 0]; };
  P._forkPivot = function (v) { var f = this._findPart(v, 'fork'); return f ? f.pivot : [0, 0, 0]; };

  P._bodyMatrix = function (v, origin) {
    var p = v.rpos, off = v.info.offset;
    var y = p[1] - (v.bk ? v.bk.susp * 0.0 : 0);
    m4QP(this.mTmp, v.rq, p[0] - origin[0], y, p[2] - origin[1]);
    if (off[2] || off[1]) { m4QP(this.mPart, [0, 0, 0, 1], off[0], off[1], off[2]); M.multiply(this.mBody, this.mTmp, this.mPart); }
    else this.mBody.set(this.mTmp);
    return this.mBody;
  };

  P._drawVehicle = function (p, v, lod, frame, mode) {
    var gl = this.gl, G = this.G, L = v.model.lods[lod], o = frame.origin;
    var body = this._bodyMatrix(v, o);
    if (mode === 0) {
      var night = 1 - frame.env.dayFactor;
      p.v4('uState', v.wet, v.mud, v.info.mud[0], v.info.mud[1]);
      p.v4('uLamp', v.lightsOn ? 1 : 0, (v.ctl.brake > 0 && v.cat === 'bike') ? 1 : (v.lightsOn ? 0.4 : 0), night > 0.5 || v.lightsOn ? 1 : 0, v.driven ? 1 : 0);
    } else if (mode === 2) {
      p.v3('uLinVel', v.vel[0], v.vel[1], v.vel[2]).v3('uAngVel', v.w[0], v.w[1], v.w[2]).v3('uCOM', v.rpos[0] - o[0], v.rpos[1], v.rpos[2] - o[1]);
    }
    p.m4('uModel', body).m4('uLocal', v.info.offset[2] ? this.mPart : ID);
    gl.bindVertexArray(L.body.vao);
    gl.drawElements(gl.TRIANGLES, L.body.count, L.body.type, 0);
    G.stats.drawCalls++; G.stats.triangles += L.body.tris;
    var loc = new Float32Array(16), wm = new Float32Array(16), lm = new Float32Array(16);
    for (var i = 0; i < L.parts.length; i++) {
      var part = L.parts[i];
      if (lod && mode === 1 && part.mesh.tris < 60) continue;     // tiny parts cast no visible shadow
      this._partMatrix(v, v.model.lods[0].parts[i], loc);
      M.multiply(wm, body, loc);
      if (v.info.offset[2]) M.multiply(lm, this.mPart, loc); else lm.set(loc);
      p.m4('uModel', wm).m4('uLocal', lm);
      gl.bindVertexArray(part.mesh.vao);
      gl.drawElements(gl.TRIANGLES, part.mesh.count, part.mesh.type, 0);
      G.stats.drawCalls++; G.stats.triangles += part.mesh.tris;
    }
  };

  /** G-buffer (shadow = false) or shadow cascade (shadow = true) geometry. */
  P.draw = function (frame, shadow, vp) {
    if (!this.list.length || !frame) return;
    var gl = this.gl, R = this.E.renderer, planes = frame.cam.planes, o = frame.origin;
    var p = shadow ? this.progShadow : this.prog;
    p.use();
    p.i('uShadowPass', shadow ? 1 : 0);
    if (shadow) p.m4('uShadowVP', vp);
    else p.tex('uAlbedoH', 0, R.tex.matAlbedo, gl.TEXTURE_2D_ARRAY);
    var cam = frame.cam.world;
    for (var i = 0; i < this.list.length; i++) {
      var v = this.list[i];
      var d = Math.hypot(v.rpos[0] - cam[0], v.rpos[1] - cam[1], v.rpos[2] - cam[2]);
      var maxD = v.cat === 'plane' ? 4000 : 1500;
      if (d > maxD) continue;
      if (!shadow && !M.sphereInFrustum(planes, v.rpos[0] - o[0], v.rpos[1], v.rpos[2] - o[1], v.info.radius + 1, 0)) continue;
      if (shadow && d > 700) continue;
      var lod = d > 60 * (this.E.lodScale || 1) * (v.cat === 'plane' ? 1.6 : 1) || (shadow && d > 25) ? 1 : 0;
      if (v === this.current && this.camMode[v.cat] === 'cockpit' && !shadow) lod = 0;
      this._drawVehicle(p, v, lod, frame, shadow ? 1 : 0);
    }
    gl.bindVertexArray(null);
  };
  /** World-space velocity of moving vehicles → motion buffer (frame extrapolation). */
  P.drawMotion = function (frame) {
    if (!this.list.length || !frame) return;
    var gl = this.gl, p = this.progMotion.use(), cam = frame.cam.world, planes = frame.cam.planes, o = frame.origin;
    p.i('uShadowPass', 0);
    for (var i = 0; i < this.list.length; i++) {
      var v = this.list[i];
      if (!v.active || v.asleep) continue;
      if (!M.sphereInFrustum(planes, v.rpos[0] - o[0], v.rpos[1], v.rpos[2] - o[1], v.info.radius + 1, 0)) continue;
      var d = Math.hypot(v.rpos[0] - cam[0], v.rpos[1] - cam[1], v.rpos[2] - cam[2]);
      this._drawVehicle(p, v, d > 60 ? 1 : 0, frame, 2);
    }
    gl.bindVertexArray(null);
  };

  /* ======================= sound ======================= */
  P._sfx = function (kind, v, s) {
    var A = this.E.audio;
    if (!A || !A.ready || A.muted) return;
    var cam = this.E.camera.world, d = Math.hypot(v.pos[0] - cam[0], v.pos[1] - cam[1], v.pos[2] - cam[2]);
    var g = U.clamp01(1.2 - d / 120) * s;
    if (g < 0.02) return;
    if (kind === 'crash') { A._burst({ buf: A.brown, freq: 200, type: 'lowpass', len: 1.2, gain: 0.9 * g }); A._burst({ freq: 2400, q: 1.5, len: 0.6, gain: 0.35 * g }); A._burst({ freq: 900, q: 3, len: 0.3, gain: 0.3 * g, delay: 0.08 }); }
    else if (kind === 'thud') A._burst({ buf: A.brown, freq: 150, type: 'lowpass', len: 0.35, gain: 0.6 * g });
    else if (kind === 'land') { A._burst({ buf: A.brown, freq: 180, type: 'lowpass', len: 0.3, gain: 0.55 * g }); A._burst({ freq: 1600, q: 1, len: 0.12, gain: 0.15 * g }); }
    else if (kind === 'slap') { A._burst({ freq: 700, q: 0.8, len: 0.35, gain: 0.5 * g, sweep: 300 }); A._burst({ buf: A.brown, freq: 120, type: 'lowpass', len: 0.3, gain: 0.4 * g }); }
    else if (kind === 'chirp') { A._tone({ f0: 1300, f1: 500, len: 0.18, gain: 0.05 * g, wave: 'sawtooth', dest: A.fx }); A._burst({ freq: 2500, q: 2, len: 0.2, gain: 0.25 * g }); }
    else if (kind === 'scrape') A._burst({ freq: 3200, q: 4, len: 0.25, gain: 0.25 * g });
    else if (kind === 'hop') A._burst({ freq: 900, q: 1, len: 0.08, gain: 0.15 * g });
  };

  /* ======================= persistence ======================= */
  P.serialize = function () {
    return this.list.map(function (v) {
      var o = { type: v.type, pos: v.pos.slice(), q: v.q.slice(), damaged: v.damaged };
      if (v.bk) o.yaw = v.bk.yaw;
      return o;
    });
  };
  P.deserialize = function (arr) {
    this.clear();
    if (!arr || !arr.length) return;
    for (var i = 0; i < arr.length && i < MAXV; i++) {
      var d = arr[i]; if (!SPECS[d.type]) continue;
      var v = new Vehicle(d.type, this._model(d.type));
      v.pos = d.pos.slice(); v.q = qnorm(d.q.slice()); v.damaged = !!d.damaged;
      if (v.bk) { v.bk.yaw = d.yaw || 0; v.bk.by = v.pos[1]; v.bk.lean = 0.2; }
      v.prevPos = v.pos.slice(); v.prevQ = v.q.slice(); v.rpos = v.pos.slice(); v.rq = v.q.slice();
      this.list.push(v);
    }
  };

  /* ======================= engine & motion sound ======================= */
  function VehicleAudio(E) { this.E = E; this.n = null; this.tick = 0; }
  VehicleAudio.prototype.start = function (v) {
    var A = this.E.audio;
    this.stop();
    if (!A || !A.ready || !A.ctx) return;
    var c = A.ctx, t = c.currentTime;
    var out = c.createGain(); out.gain.value = 0; out.connect(A.fx);
    var lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 0.7; lp.connect(out);
    var o1 = c.createOscillator(); o1.type = 'sawtooth';
    var o2 = c.createOscillator(); o2.type = 'square';
    var g1 = c.createGain(), g2 = c.createGain(); g1.gain.value = 0; g2.gain.value = 0;
    o1.connect(g1); g1.connect(lp); o2.connect(g2); g2.connect(lp);
    // combustion roughness: noise amplitude-modulated by the firing frequency
    var nz = c.createBufferSource(); nz.buffer = A.pink; nz.loop = true;
    var nb = c.createBiquadFilter(); nb.type = 'bandpass'; nb.frequency.value = 300; nb.Q.value = 0.8;
    var ng = c.createGain(); ng.gain.value = 0; nz.connect(nb); nb.connect(ng); ng.connect(lp);
    // air / water / tyre rush
    var rz = c.createBufferSource(); rz.buffer = A.noise; rz.loop = true;
    var rb = c.createBiquadFilter(); rb.type = 'bandpass'; rb.frequency.value = 900; rb.Q.value = 0.6;
    var rg = c.createGain(); rg.gain.value = 0; rz.connect(rb); rb.connect(rg); rg.connect(out);
    o1.start(t); o2.start(t); nz.start(t, Math.random() * 3); rz.start(t, Math.random() * 3);
    out.gain.setTargetAtTime(1, t, 0.3);
    this.n = { out: out, lp: lp, o1: o1, o2: o2, g1: g1, g2: g2, nz: nz, nb: nb, ng: ng, rz: rz, rb: rb, rg: rg };
  };
  VehicleAudio.prototype.stop = function () {
    var n = this.n; if (!n) return;
    var A = this.E.audio, t = A.ctx.currentTime;
    n.out.gain.setTargetAtTime(0, t, 0.15);
    setTimeout(function () { try { n.o1.stop(); n.o2.stop(); n.nz.stop(); n.rz.stop(); n.out.disconnect(); } catch (e) { /* already stopped */ } }, 900);
    this.n = null;
  };
  VehicleAudio.prototype.update = function (v, dt) {
    var n = this.n, A = this.E.audio;
    if (!n || !A.ctx) return;
    var t = A.ctx.currentTime, tc = 0.06;
    var under = this.E.environment.env.underwater;
    var on = v.engineOn && !v.damaged, f, load = 0, rush = 0, rushF = 900, eg = 0;
    if (v.cat === 'boat') {
      var s = v.spec.sound;
      f = v.rpm / 60 * s.cyl / 2;
      load = Math.abs(v.ctl.throttle);
      eg = on ? 0.05 + load * 0.08 : 0;
      rush = U.clamp01(v.speed / 18) * 0.12 * (v.immersion > 0 ? 1 : 0.3); rushF = 500 + v.speed * 30;
      n.lp.frequency.setTargetAtTime(500 + load * 1400 + (v.propOut ? 900 : 0), t, tc);
    } else if (v.cat === 'plane') {
      f = v.rpm / 60 * 2;                                     // two-blade propeller
      load = v.ctl.throttle;
      eg = on ? 0.07 + load * 0.07 : 0;
      rush = U.clamp01(v.airspeed / 70) * 0.16; rushF = 400 + v.airspeed * 18;
      n.lp.frequency.setTargetAtTime(350 + load * 900 + v.rpm * 0.1, t, tc);
    } else if (v.spec.kind === 'dirt') {
      f = v.rpm / 60 / 2;                                     // single-cylinder four-stroke
      load = v.ctl.throttle;
      eg = on ? 0.06 + load * 0.09 : 0;
      rush = U.clamp01(v.speed / 30) * 0.08; rushF = 600 + v.speed * 30;
      n.lp.frequency.setTargetAtTime(600 + load * 2200, t, tc);
    } else {
      // bicycle: no engine — tyre hum and a freewheel ticking while coasting
      f = 0; eg = 0;
      var surf = v.bk && v.bk.surf ? v.bk.surf.name : 'grass';
      rush = U.clamp01(v.speed / 12) * (surf === 'rock' || surf === 'path' ? 0.09 : 0.06); rushF = surf === 'sand' || surf === 'snow' ? 1800 : (surf === 'mud' ? 400 : 1100);
      this.tick -= dt;
      if (v.ctl.throttle < 0.1 && v.speed > 1.2 && this.tick <= 0) { this.tick = 1 / U.clamp(v.speed * 3, 4, 26); A._tone({ f0: 5200, len: 0.012, gain: 0.006, dest: A.fx, attack: 0.001 }); }
    }
    if (f > 0) { n.o1.frequency.setTargetAtTime(Math.max(8, f), t, tc); n.o2.frequency.setTargetAtTime(Math.max(8, f * 2.01), t, tc); n.nb.frequency.setTargetAtTime(Math.max(60, f * 3), t, tc); }
    n.g1.gain.setTargetAtTime(eg * 0.55, t, tc); n.g2.gain.setTargetAtTime(eg * 0.25 * (0.4 + load), t, tc); n.ng.gain.setTargetAtTime(eg * (0.6 + load * 0.8), t, tc);
    n.rg.gain.setTargetAtTime(rush * (under ? 0.3 : 1), t, 0.1); n.rb.frequency.setTargetAtTime(rushF, t, 0.1);
  };

  TERRA.game.Vehicles = Vehicles;
})();
