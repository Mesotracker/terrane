/* =============================================================================
 * TERRA INFINITA — gvehicles: ground combat vehicles (tanks, APCs, technicals)
 * -----------------------------------------------------------------------------
 * Deterministic garrisons that live around settlements: they patrol the roads,
 * react to gunfire, hunt the player with turret + hull AI, and can be disabled
 * part by part — tracks shot off, engine on fire, turret ring jammed — until
 * they burn out into wrecks that keep smoking and block the street.
 *
 * Geometry is fully procedural (CGeo + the combat material library) and every
 * vehicle shares one template per kind; damage rebuilds a per-vehicle mesh so
 * blown-off parts actually disappear.
 * ========================================================================== */
(function () {
  'use strict';
  var U = TERRA.util, M = TERRA.math;

  var CM = null;
  function cm() { return CM || (CM = TERRA.game.Combat); }
  function cc() { var C = TERRA.game.Combat; return (C && C.inst) || null; }
  function CGeo() { return new (cm().CGeo)(); }
  function MAT(n) { return cm().CMAT[n] === undefined ? cm().CMAT.METAL : cm().CMAT[n]; }
  function hash(s) { s = String(s); var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rngFrom(seed) { var a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function clamp01(x) { return U.clamp01(x); }
  /** Was this damage dealt by the player? (weapons pass engine.player as source) */
  function isPlayerSource(E, src) { return !!src && (src === E.player || src.isPlayer === true); }
  function mulberry(seed) { return rngFrom(hash(seed)); }

  /* ---------------------------------------------------------------------------
   * Vehicle families
   * ------------------------------------------------------------------------ */
  var KINDS = {
    tank: {
      label: 'T-64 «Vanguard»', short: 'MBT', crew: 3, mass: 42,
      radius: 4.6, height: 2.6, len: 7.8, wid: 3.7,
      speed: 11, reverse: 4.5, accel: 2.6, turn: 1.25,
      turretRate: 0.55, turretPitch: [-0.16, 0.22],
      hp: 3200, armor: 1.0, gun: 'cannon', cannon: true,
      range: 420, mgRange: 190, reload: 4.6, burst: [4, 7], burstPause: [1.6, 3.2],
      team: 1, aggression: 0.9
    },
    apc: {
      label: 'BTR-82 «Vector»', short: 'APC', crew: 3, mass: 16,
      radius: 3.9, height: 2.4, len: 7.2, wid: 2.9,
      speed: 19, reverse: 7, accel: 4.2, turn: 1.7,
      turretRate: 1.15, turretPitch: [-0.28, 0.4],
      hp: 1650, armor: 0.6, gun: 'hmg', cannon: false,
      range: 260, mgRange: 210, reload: 2.6, burst: [6, 11], burstPause: [1.1, 2.4],
      team: 1, aggression: 1.0
    },
    technical: {
      label: 'Hilux «Scorpion»', short: 'TECH', crew: 2, mass: 2.4,
      radius: 3.1, height: 2.1, len: 5.4, wid: 2.1,
      speed: 24, reverse: 8, accel: 6.5, turn: 2.2,
      turretRate: 1.7, turretPitch: [-0.35, 0.55],
      hp: 520, armor: 0.25, gun: 'mg', cannon: false,
      range: 200, mgRange: 170, reload: 2.1, burst: [8, 16], burstPause: [1.4, 3.0],
      team: 1, aggression: 1.15
    }
  };
  var KIND_LIST = ['tank', 'apc', 'technical'];

  var COL = {
    olive: [104, 110, 96], oliveDark: [78, 84, 72], oliveLite: [124, 130, 112],
    sand: [168, 152, 118], grey: [128, 130, 132], dark: [58, 60, 58],
    rubber: [34, 34, 36], steel: [148, 150, 152], rust: [126, 82, 54],
    canvas: [122, 112, 88], glass: [92, 112, 120], burnt: [36, 32, 30]
  };

  function opt(o) { return o || {}; }

  /* ---------------------------------------------------------------------------
   * Geometry templates — one per kind, reused by every vehicle of that family
   * ------------------------------------------------------------------------ */
  var VEH = [];
  VEH.tank = {
    label: KINDS.tank.label,
    parts: [], // {name,kind,obb,c,h,mat,surface,maxHp,solid,geo}
    wreck: [],  // extra geometry when destroyed
    gunLocal: { x: 0, y: 0, z: 0 } // muzzle in turret space
  };
  VEH.apc = { label: KINDS.apc.label, parts: [], wreck: [], gunLocal: { x: 0, y: 0, z: 0 } };
  VEH.technical = { label: KINDS.technical.label, parts: [], wreck: [], gunLocal: { x: 0, y: 0, z: 0 } };

  /** Add a part: geometry + hit box. kind drives what breaking it does. */
  function addPart(tpl, name, kind, c, h, matName, hp, opts2) {
    var g = CGeo();
    var o = opt(opts2);
    if (o.geo) o.geo(g);
    var p = {
      name: name, kind: kind, c: c.slice(), h: h.slice(),
      mat: matName, surface: o.surface || SURF(matName),
      maxHp: hp, solid: o.solid !== false, top: !!o.top, geo: g, blocked: false
    };
    tpl.parts.push(p);
    return p;
  }
  function SURF(matName) {
    var m = { STEEL: 'metal', METAL: 'metal', RUST: 'rust', RUBBER: 'rubber', PAINT: 'paint', GLASS: 'glass',
      CANVAS: 'cloth', CLOTH: 'cloth', SKIN: 'skin', KEVLAR: 'kevlar', WOOD: 'plank', PLASTER: 'plaster' };
    return m[matName] || 'metal';
  }

  /* ---- shared sub-assemblies --------------------------------------------- */
  function wheel(g, x, y, z, r, w, col) {
    g.cylinder([x - w, y, z], [x + w, y, z], r, r, 14, { mat: MAT('RUBBER'), col: col || COL.rubber, caps: true, uvScale: 3 });
    g.cylinder([x - w * 1.05, y, z], [x - w * 0.55, y, z], r * 0.55, r * 0.55, 12, { mat: MAT('STEEL'), col: COL.steel, caps: true });
    g.cylinder([x + w * 0.55, y, z], [x + w * 1.05, y, z], r * 0.55, r * 0.55, 12, { mat: MAT('STEEL'), col: COL.steel, caps: true });
  }
  function trackRun(g, side, z0, z1, y, col) {
    var x = side * 1.55;
    g.box([x, y, (z0 + z1) * 0.5], [0.34, 0.055, (z1 - z0) * 0.5], { mat: MAT('RUBBER'), col: col || COL.dark, uvScale: 4, edge: 60 });
    for (var z = z0 + 0.22; z < z1; z += 0.44) {
      g.box([x + side * 0.06, y, z], [0.36, 0.035, 0.09], { mat: MAT('STEEL'), col: COL.steel, wear: 90, uvScale: 2 });
    }
  }
  function stowageBox(g, c, h, col, matName) {
    g.box(c, h, { mat: MAT(matName || 'STEEL'), col: col || COL.oliveDark, uvScale: 2, edge: 160 });
    // latch strip
    g.box([c[0], c[1] + h[1] * 0.62, c[2] + h[2] + 0.012], [h[0] * 0.85, h[1] * 0.14, 0.014], { mat: MAT('STEEL'), col: COL.steel, uvScale: 3 });
  }
  function antenna(g, x, y, z, hgt) {
    g.cylinder([x, y, z], [x, y + hgt, z], 0.016, 0.008, 5, { mat: MAT('METAL'), col: [70, 70, 72], caps: false, uvScale: 2 });
  }
  function lamp(g, x, y, z, r, red) {
    g.cylinder([x, y, z], [x, y, z + r * 1.2], r, r * 0.9, 10, { mat: MAT('GLASS'), col: red ? [150, 40, 34] : [214, 210, 180], caps: true });
    var b = CGeo();
    b.cylinder([x, y, z - r * 0.5], [x, y, z + r * 0.6], r * 0.85, r * 0.7, 10, { mat: MAT('EMISSIVE'), col: red ? [190, 40, 30] : [255, 236, 190], caps: true });
    g.append(b, [0, 0, 0]);
  }

  /* ======================= TANK ============================================ */
  (function buildTank() {
    var T = VEH.tank;
    // ---- lower hull: belly, sides, engine deck
    addPart(T, 'hull', 'hull', [0, 0.62, -0.2], [1.68, 0.42, 3.55], 'STEEL', 900, { geo: function (g) {
      g.box([0, 0.62, -0.2], [1.68, 0.42, 3.55], { mat: MAT('STEEL'), col: COL.olive, uvScale: 1.4, edge: 210 });
      // suspension arms
      for (var i = 0; i < 5; i++) {
        var z = -2.5 + i * 1.25;
        g.box([1.5, 0.36, z], [0.14, 0.1, 0.5], { mat: MAT('STEEL'), col: COL.oliveDark, uvScale: 2 });
        g.box([-1.5, 0.36, z], [0.14, 0.1, 0.5], { mat: MAT('STEEL'), col: COL.oliveDark, uvScale: 2 });
      }
    } });
    // ---- upper hull + sloped glacis + skirts
    addPart(T, 'deck', 'hull', [0, 1.04, -0.5], [1.62, 0.3, 3.2], 'STEEL', 760, { geo: function (g) {
      g.box([0, 1.04, -0.5], [1.62, 0.3, 3.2], { mat: MAT('STEEL'), col: COL.olive, uvScale: 1.4, edge: 210 });
      // glacis plate (sloped)
      g.face([-1.66, 1.12, 1.62], [1.66, 1.12, 1.62], [1.6, 0.72, 3.28], [-1.6, 0.72, 3.28],
        { mat: MAT('STEEL'), col: COL.oliveLite, uvScale: 1.6, edge: 230 });
      // driver's hatch + periscopes
      g.box([-0.62, 1.36, 1.4], [0.32, 0.05, 0.34], { mat: MAT('STEEL'), col: COL.oliveDark, uvScale: 3, edge: 200 });
      g.box([-0.62, 1.44, 1.04], [0.2, 0.06, 0.05], { mat: MAT('GLASS'), col: COL.glass, uvScale: 4 });
      // side skirts over the tracks
      g.box([1.72, 0.9, -0.1], [0.05, 0.42, 3.5], { mat: MAT('STEEL'), col: COL.oliveDark, uvScale: 1.8, edge: 190 });
      g.box([-1.72, 0.9, -0.1], [0.05, 0.42, 3.5], { mat: MAT('STEEL'), col: COL.oliveDark, uvScale: 1.8, edge: 190 });
      // fender lines
      g.box([1.74, 1.3, 0.2], [0.07, 0.06, 3.3], { mat: MAT('STEEL'), col: COL.oliveLite, uvScale: 3 });
      g.box([-1.74, 1.3, 0.2], [0.07, 0.06, 3.3], { mat: MAT('STEEL'), col: COL.oliveLite, uvScale: 3 });
      // ERA blocks on the glacis
      for (var ix = -1; ix <= 1; ix++) for (var iy = 0; iy < 3; iy++) {
        var t = iy / 2;
        g.box([ix * 0.95, 1.13 - t * 0.36, 1.82 + t * 1.32], [0.42, 0.07, 0.5], { mat: MAT('STEEL'), col: [96, 102, 88], uvScale: 2.4, edge: 240, wear: 40 });
      }
    } });
    // ---- tracks
    addPart(T, 'tracksL', 'track', [-1.55, 0.45, 0], [0.4, 0.46, 3.5], 'RUBBER', 320, { geo: function (g) {
      trackRun(g, -1, -3.4, 3.4, 0.06); trackRun(g, -1, -3.4, 3.4, 0.88);
      for (var i = 0; i < 5; i++) wheel(g, -1.55, 0.42, -2.5 + i * 1.25, 0.42, 0.22);
      wheel(g, -1.55, 0.5, 3.15, 0.36, 0.2); wheel(g, -1.55, 0.5, -3.2, 0.34, 0.2);
    } });
    addPart(T, 'tracksR', 'track', [1.55, 0.45, 0], [0.4, 0.46, 3.5], 'RUBBER', 320, { geo: function (g) {
      trackRun(g, 1, -3.4, 3.4, 0.06); trackRun(g, 1, -3.4, 3.4, 0.88);
      for (var i = 0; i < 5; i++) wheel(g, 1.55, 0.42, -2.5 + i * 1.25, 0.42, 0.22);
      wheel(g, 1.55, 0.5, 3.15, 0.36, 0.2); wheel(g, 1.55, 0.5, -3.2, 0.34, 0.2);
    } });
    // ---- engine + fuel (rear deck), critical
    addPart(T, 'engine', 'engine', [0, 1.16, -2.6], [1.1, 0.22, 0.9], 'STEEL', 380, { geo: function (g) {
      g.box([0, 1.36, -2.6], [1.05, 0.06, 0.85], { mat: MAT('STEEL'), col: COL.oliveDark, uvScale: 2.2, edge: 230 });
      for (var i = -1; i <= 1; i++) g.box([i * 0.7, 1.44, -2.6], [0.28, 0.03, 0.8], { mat: MAT('METAL'), col: COL.dark, uvScale: 3 });
      // exhaust
      g.cylinder([-1.2, 1.2, -3.1], [-1.2, 1.5, -3.35], 0.11, 0.13, 10, { mat: MAT('RUST'), col: [88, 62, 46], caps: true, uvScale: 2 });
      g.box([-1.2, 1.24, -2.9], [0.16, 0.12, 0.28], { mat: MAT('RUST'), col: [96, 70, 52], uvScale: 2.5, edge: 200 });
      // tow hooks + rear plate detail
      g.box([0, 0.78, -3.42], [1.5, 0.3, 0.06], { mat: MAT('STEEL'), col: COL.oliveDark, uvScale: 2, edge: 200 });
      g.box([0.9, 0.5, -3.5], [0.1, 0.1, 0.12], { mat: MAT('STEEL'), col: COL.steel, uvScale: 3 });
      g.box([-0.9, 0.5, -3.5], [0.1, 0.1, 0.12], { mat: MAT('STEEL'), col: COL.steel, uvScale: 3 });
      lamp(g, 0.85, 0.86, -3.46, 0.06, true); lamp(g, -0.85, 0.86, -3.46, 0.06, true);
    } });
    addPart(T, 'fuel', 'fuel', [0, 0.9, -3.2], [0.9, 0.28, 0.3], 'STEEL', 210, { geo: function (g) {
      g.cylinder([-0.62, 1.05, -3.28], [0.62, 1.05, -3.28], 0.22, 0.22, 12, { mat: MAT('RUST'), col: [120, 84, 58], caps: true, uvScale: 2, wear: 60 });
      g.box([0, 1.05, -3.28], [0.14, 0.24, 0.24], { mat: MAT('STEEL'), col: COL.oliveDark, uvScale: 3 });
    } });
    // ---- turret
    addPart(T, 'turret', 'turret', [0, 1.62, -0.25], [1.06, 0.42, 1.62], 'STEEL', 1100, { geo: function (g) {
      g.cylinder([0, 1.3, -0.25], [0, 1.38, -0.25], 0.98, 0.92, 18, { mat: MAT('STEEL'), col: COL.oliveDark, caps: true, uvScale: 2 });
      g.box([0, 1.62, -0.35], [1.02, 0.34, 1.5], { mat: MAT('STEEL'), col: COL.olive, uvScale: 1.5, edge: 215 });
      // sloped cheeks + rear bustle
      g.face([-1.02, 1.96, 1.05], [1.02, 1.96, 1.05], [0.6, 1.62, 1.72], [-0.6, 1.62, 1.72], { mat: MAT('STEEL'), col: COL.oliveLite, uvScale: 2, edge: 230 });
      g.box([0, 1.6, -2.02], [1.0, 0.3, 0.36], { mat: MAT('STEEL'), col: COL.oliveDark, uvScale: 2, edge: 200 });
      stowageBox(g, [0.72, 1.55, -1.5], [0.26, 0.18, 0.5], [96, 92, 76]);
      // commander cupola + hatch, loader hatch
      g.cylinder([0.46, 1.96, -0.6], [0.46, 2.14, -0.6], 0.34, 0.36, 14, { mat: MAT('STEEL'), col: COL.oliveDark, caps: true, uvScale: 2 });
      g.box([0.46, 2.16, -0.6], [0.3, 0.04, 0.3], { mat: MAT('STEEL'), col: COL.oliveLite, uvScale: 3, edge: 230 });
      for (var k = 0; k < 4; k++) {
        var a = k / 4 * Math.PI * 2 + 0.4;
        g.box([0.46 + Math.cos(a) * 0.3, 2.05, -0.6 + Math.sin(a) * 0.3], [0.07, 0.04, 0.03], { mat: MAT('GLASS'), col: COL.glass, uvScale: 5 });
      }
      g.box([-0.5, 2.0, -0.55], [0.28, 0.045, 0.3], { mat: MAT('STEEL'), col: COL.oliveLite, uvScale: 3, edge: 230 });
      // gunner's sight + thermal shroud
      g.box([0.1, 2.06, 0.5], [0.22, 0.09, 0.22], { mat: MAT('METAL'), col: COL.dark, uvScale: 2.4, edge: 200 });
      g.box([0.1, 2.08, 0.72], [0.15, 0.07, 0.02], { mat: MAT('GLASS'), col: [80, 104, 96], uvScale: 6 });
      // smoke launchers
      for (var s2 = -1; s2 <= 1; s2 += 2) for (var i2 = 0; i2 < 4; i2++) {
        g.cylinder([s2 * 0.86, 1.9, -0.35 + i2 * 0.3], [s2 * 1.02, 2.04, -0.35 + i2 * 0.34], 0.055, 0.055, 8, { mat: MAT('METAL'), col: COL.steel, caps: true });
      }
      // antennas
      antenna(g, 0.9, 1.95, -1.7, 2.5); antenna(g, -0.9, 1.95, -1.6, 2.1);
      // MG on the cupola
      g.box([0.46, 2.24, -0.28], [0.05, 0.05, 0.34], { mat: MAT('METAL'), col: COL.dark, uvScale: 4 });
      g.cylinder([0.46, 2.3, -0.05], [0.46, 2.3, 0.62], 0.028, 0.024, 8, { mat: MAT('METAL'), col: COL.steel, caps: true });
      g.box([0.46, 2.3, -0.16], [0.05, 0.06, 0.14], { mat: MAT('METAL'), col: COL.dark, uvScale: 5 });
    } });
    // ---- main gun (recoil group)
    addPart(T, 'gun', 'gun', [0, 1.62, 1.8], [0.3, 0.3, 1.9], 'STEEL', 520, { geo: function (g) {
      g.box([0, 1.62, 1.42], [0.44, 0.3, 0.24], { mat: MAT('STEEL'), col: COL.oliveDark, uvScale: 2, edge: 210 });    // mantlet
      g.cylinder([0, 1.62, 1.5], [0, 1.62, 3.1], 0.11, 0.105, 12, { mat: MAT('STEEL'), col: COL.dark, caps: true, uvScale: 2 });
      g.cylinder([0, 1.62, 2.05], [0, 1.62, 3.0], 0.155, 0.15, 12, { mat: MAT('CANVAS'), col: [96, 92, 78], caps: true, uvScale: 2 }); // thermal sleeve
      g.cylinder([0, 1.62, 3.1], [0, 1.62, 4.35], 0.105, 0.098, 12, { mat: MAT('STEEL'), col: COL.dark, caps: true, uvScale: 2 });
      g.cylinder([0, 1.62, 4.35], [0, 1.62, 4.6], 0.135, 0.13, 12, { mat: MAT('STEEL'), col: COL.steel, caps: true, uvScale: 3 }); // muzzle brake
      g.box([0, 1.62, 4.47], [0.09, 0.16, 0.1], { mat: MAT('STEEL'), col: COL.dark, uvScale: 4 });
      g.cylinder([0, 1.62, 1.5], [0, 1.62, 2.0], 0.075, 0.07, 8, { mat: MAT('METAL'), col: COL.steel, caps: true });  // recoil cylinder
      // tie-downs on the barrel
      g.box([0, 1.62, 1.75], [0.19, 0.19, 0.05], { mat: MAT('CANVAS'), col: [104, 98, 82], uvScale: 3 });
    } });
    T.gunLocal = { x: 0, y: 1.62, z: 4.62 };
    // ---- wreck extras: thrown turret, burnt panels, scattered track links
    addPart(T, 'wreckTurret', 'debris', [2.6, 0.5, -1.4], [1.0, 0.4, 1.5], 'STEEL', 1, { solid: false, geo: function (g) {
      g.box([2.6, 0.5, -1.4], [1.0, 0.34, 1.5], { mat: MAT('RUST'), col: COL.burnt, uvScale: 1.6, edge: 220, wear: 70 });
      g.cylinder([2.6, 2.05, -1.4], [2.6, 1.05, -1.4], 0.4, 0.62, 12, { mat: MAT('RUST'), col: COL.burnt, caps: true });
      g.box([2.6, 0.5, -0.1], [0.55, 0.16, 0.3], { mat: MAT('STEEL'), col: [70, 62, 56], uvScale: 2 });
      g.cylinder([2.6, 0.5, 0.2], [2.6, 0.5, 2.3], 0.1, 0.09, 10, { mat: MAT('RUST'), col: [64, 56, 50], caps: true });
    } });
    addPart(T, 'burn', 'debris', [0, 1.2, -0.4], [1.7, 0.5, 3.5], 'RUST', 1, { solid: false, geo: function (g) {
      g.box([0, 1.34, -0.5], [1.63, 0.06, 3.2], { mat: MAT('RUST'), col: COL.burnt, uvScale: 1.4, edge: 120 });
      g.box([0, 0.66, -0.2], [1.68, 0.3, 3.5], { mat: MAT('RUST'), col: [44, 40, 36], uvScale: 1.4, edge: 120 });
      g.face([-1.66, 1.12, 1.62], [1.66, 1.12, 1.62], [1.6, 0.72, 3.28], [-1.6, 0.72, 3.28], { mat: MAT('RUST'), col: [48, 42, 38], uvScale: 1.6 });
      for (var i = 0; i < 7; i++) {
        g.rotBox([2.1 + Math.random() * 1.6, 0.08, 1.2 - i * 0.7], [0.34, 0.05, 0.22], Math.random() * 0.7 - 0.35,
          { mat: MAT('RUST'), col: [58, 52, 48], uvScale: 2, wear: 80 });
      }
    } });
  })();

  /* ======================= APC ============================================= */
  (function buildApc() {
    var T = VEH.apc;
    addPart(T, 'hull', 'hull', [0, 0.86, 0], [1.42, 0.6, 3.55], 'STEEL', 620, { geo: function (g) {
      g.box([0, 0.86, -0.1], [1.42, 0.6, 3.5], { mat: MAT('STEEL'), col: COL.olive, uvScale: 1.5, edge: 215 });
      // sloped nose + rear ramp
      g.face([-1.44, 1.42, 2.4], [1.44, 1.42, 2.4], [1.05, 0.7, 3.6], [-1.05, 0.7, 3.6], { mat: MAT('STEEL'), col: COL.oliveLite, uvScale: 1.8, edge: 235 });
      g.face([-1.3, 1.4, -3.6], [1.3, 1.4, -3.6], [1.3, 0.42, -3.75], [-1.3, 0.42, -3.75], { mat: MAT('STEEL'), col: COL.oliveDark, uvScale: 1.8, edge: 220 });
      // side hatches + firing ports + handrails
      for (var s2 = -1; s2 <= 1; s2 += 2) {
        g.box([s2 * 1.47, 1.05, 0.55], [0.05, 0.3, 0.42], { mat: MAT('STEEL'), col: COL.oliveDark, uvScale: 2.4, edge: 200 });
        g.box([s2 * 1.47, 1.0, -0.9], [0.05, 0.26, 0.36], { mat: MAT('STEEL'), col: COL.oliveDark, uvScale: 2.4, edge: 200 });
        g.box([s2 * 1.45, 1.42, 1.3], [0.06, 0.05, 0.5], { mat: MAT('STEEL'), col: COL.steel, uvScale: 4 });
        g.box([s2 * 1.45, 1.42, -1.9], [0.06, 0.05, 0.5], { mat: MAT('STEEL'), col: COL.steel, uvScale: 4 });
        // mirrors
        g.cylinder([s2 * 1.5, 1.6, 2.5], [s2 * 1.72, 1.68, 2.62], 0.03, 0.03, 6, { mat: MAT('METAL'), col: COL.dark, caps: true });
        g.box([s2 * 1.74, 1.72, 2.64], [0.03, 0.12, 0.07], { mat: MAT('GLASS'), col: COL.glass, uvScale: 6 });
      }
      // roof hatches, periscopes, spotlight
      g.box([0.5, 1.5, 1.2], [0.28, 0.05, 0.3], { mat: MAT('STEEL'), col: COL.oliveLite, uvScale: 3, edge: 220 });
      g.box([-0.5, 1.5, 0.4], [0.26, 0.05, 0.28], { mat: MAT('STEEL'), col: COL.oliveLite, uvScale: 3, edge: 220 });
      for (var p2 = -1; p2 <= 1; p2++) g.box([0.5, 1.56, 1.56 + p2 * 0.0], [0.22, 0.03, 0.03], { mat: MAT('GLASS'), col: COL.glass, uvScale: 6 });
      g.cylinder([0.9, 1.42, 0.1], [0.9, 1.62, 0.1], 0.02, 0.02, 6, { mat: MAT('METAL'), col: COL.steel, caps: true });
      lamp(g, 0.92, 1.2, 3.5, 0.09); lamp(g, -0.92, 1.2, 3.5, 0.09);
      lamp(g, 0.9, 0.8, -3.72, 0.05, true); lamp(g, -0.9, 0.8, -3.72, 0.05, true);
      antenna(g, 1.1, 1.5, -2.6, 2.2); antenna(g, -1.1, 1.5, -2.2, 1.8);
      // stowage rails + boxes
      stowageBox(g, [1.5, 1.2, -1.4], [0.16, 0.2, 0.5], [110, 104, 84]);
      stowageBox(g, [-1.5, 1.2, -1.6], [0.16, 0.2, 0.44], [96, 92, 76]);
      g.box([1.5, 0.5, 2.2], [0.05, 0.16, 0.4], { mat: MAT('RUST'), col: COL.rust, uvScale: 2.5, wear: 60 });
    } });
    // ---- 8 wheels
    addPart(T, 'wheelsF', 'wheel', [0, 0.55, 2.35], [1.5, 0.55, 0.6], 'RUBBER', 300, { geo: function (g) {
      wheel(g, 1.42, 0.55, 2.35, 0.55, 0.24); wheel(g, -1.42, 0.55, 2.35, 0.55, 0.24);
      wheel(g, 1.42, 0.55, 1.15, 0.55, 0.24); wheel(g, -1.42, 0.55, 1.15, 0.55, 0.24);
      g.box([1.42, 0.95, 1.75], [0.1, 0.16, 0.9], { mat: MAT('STEEL'), col: COL.oliveDark, uvScale: 2.2, edge: 200 });
      g.box([-1.42, 0.95, 1.75], [0.1, 0.16, 0.9], { mat: MAT('STEEL'), col: COL.oliveDark, uvScale: 2.2, edge: 200 });
    } });
    addPart(T, 'wheelsR', 'wheel', [0, 0.55, -1.9], [1.5, 0.55, 0.6], 'RUBBER', 300, { geo: function (g) {
      wheel(g, 1.42, 0.55, -1.55, 0.55, 0.24); wheel(g, -1.42, 0.55, -1.55, 0.55, 0.24);
      wheel(g, 1.42, 0.55, -2.75, 0.55, 0.24); wheel(g, -1.42, 0.55, -2.75, 0.55, 0.24);
      g.box([1.42, 0.95, -2.15], [0.1, 0.16, 0.9], { mat: MAT('STEEL'), col: COL.oliveDark, uvScale: 2.2, edge: 200 });
      g.box([-1.42, 0.95, -2.15], [0.1, 0.16, 0.9], { mat: MAT('STEEL'), col: COL.oliveDark, uvScale: 2.2, edge: 200 });
    } });
    addPart(T, 'engine', 'engine', [0, 1.2, -2.9], [0.9, 0.25, 0.65], 'STEEL', 280, { geo: function (g) {
      g.box([0, 1.4, -2.9], [0.86, 0.06, 0.6], { mat: MAT('STEEL'), col: COL.oliveDark, uvScale: 2.4, edge: 225 });
      for (var i = -1; i <= 1; i++) g.box([i * 0.5, 1.46, -2.9], [0.2, 0.03, 0.55], { mat: MAT('METAL'), col: COL.dark, uvScale: 3 });
      g.cylinder([1.2, 1.3, -3.2], [1.2, 1.56, -3.35], 0.09, 0.1, 10, { mat: MAT('RUST'), col: [86, 60, 44], caps: true });
    } });
    addPart(T, 'fuel', 'fuel', [0, 0.75, -3.35], [0.8, 0.2, 0.25], 'STEEL', 160, { geo: function (g) {
      g.box([0, 0.78, -3.4], [0.72, 0.22, 0.22], { mat: MAT('STEEL'), col: COL.oliveDark, uvScale: 2.6, edge: 210 });
      g.cylinder([-0.5, 1.1, -3.4], [0.5, 1.1, -3.4], 0.16, 0.16, 10, { mat: MAT('RUST'), col: [112, 78, 52], caps: true, wear: 50 });
    } });
    addPart(T, 'turret', 'turret', [0, 1.72, -0.2], [0.62, 0.36, 0.78], 'STEEL', 460, { geo: function (g) {
      g.cylinder([0, 1.5, -0.2], [0, 1.58, -0.2], 0.6, 0.56, 14, { mat: MAT('STEEL'), col: COL.oliveDark, caps: true, uvScale: 2.4 });
      g.box([0, 1.76, -0.2], [0.6, 0.26, 0.72], { mat: MAT('STEEL'), col: COL.olive, uvScale: 1.8, edge: 215 });
      g.face([-0.6, 2.02, 0.5], [0.6, 2.02, 0.5], [0.4, 1.6, 0.86], [-0.4, 1.6, 0.86], { mat: MAT('STEEL'), col: COL.oliveLite, uvScale: 2.2, edge: 230 });
      g.box([0, 1.98, -0.66], [0.5, 0.05, 0.14], { mat: MAT('GLASS'), col: COL.glass, uvScale: 5 });
      antenna(g, 0.5, 1.96, -0.6, 1.9);
    } });
    addPart(T, 'gun', 'gun', [0, 1.78, 1.0], [0.18, 0.2, 1.0], 'METAL', 200, { geo: function (g) {
      g.box([0, 1.78, 0.78], [0.2, 0.18, 0.22], { mat: MAT('METAL'), col: COL.dark, uvScale: 2.4 });
      g.cylinder([0, 1.78, 0.95], [0, 1.78, 1.95], 0.05, 0.042, 10, { mat: MAT('METAL'), col: COL.steel, caps: true });
      g.box([0, 1.78, 1.98], [0.075, 0.075, 0.1], { mat: MAT('METAL'), col: COL.dark, uvScale: 4 });
      g.box([0, 1.78, 1.3], [0.07, 0.07, 0.18], { mat: MAT('METAL'), col: COL.dark, uvScale: 4 });
      g.box([0.24, 1.86, 0.6], [0.05, 0.14, 0.26], { mat: MAT('RUST'), col: COL.rust, uvScale: 3, wear: 60 }); // ammo box
    } });
    T.gunLocal = { x: 0, y: 1.78, z: 2.05 };
    addPart(T, 'wreckTurret', 'debris', [2.2, 0.4, -0.8], [0.6, 0.3, 0.7], 'RUST', 1, { solid: false, geo: function (g) {
      g.box([2.2, 0.4, -0.8], [0.6, 0.28, 0.68], { mat: MAT('RUST'), col: COL.burnt, uvScale: 1.8, wear: 70 });
      g.cylinder([2.2, 1.0, -0.8], [2.2, 0.6, -0.8], 0.3, 0.5, 10, { mat: MAT('RUST'), col: COL.burnt, caps: true });
      g.cylinder([2.2, 0.4, -0.2], [2.2, 0.4, 0.9], 0.05, 0.045, 8, { mat: MAT('RUST'), col: [64, 56, 50], caps: true });
    } });
    addPart(T, 'burn', 'debris', [0, 1.0, 0], [1.45, 0.5, 3.6], 'RUST', 1, { solid: false, geo: function (g) {
      g.box([0, 1.3, -0.1], [1.43, 0.05, 3.5], { mat: MAT('RUST'), col: COL.burnt, uvScale: 1.5, edge: 110 });
      g.box([0, 0.88, -0.1], [1.4, 0.5, 3.5], { mat: MAT('RUST'), col: [46, 42, 38], uvScale: 1.5, edge: 110 });
      g.face([-1.44, 1.42, 2.4], [1.44, 1.42, 2.4], [1.05, 0.7, 3.6], [-1.05, 0.7, 3.6], { mat: MAT('RUST'), col: [50, 44, 40], uvScale: 1.8 });
      for (var i = 0; i < 4; i++) g.rotBox([1.9 + i * 0.5, 0.5, -1 + i * 0.9], [0.3, 0.3, 0.3], i * 0.8, { mat: MAT('RUST'), col: [42, 38, 34], uvScale: 2 });
    } });
  })();

  /* ======================= TECHNICAL ====================================== */
  (function buildTech() {
    var T = VEH.technical;
    addPart(T, 'hull', 'hull', [0, 0.72, 0.2], [1.0, 0.42, 2.6], 'PAINT', 210, { geo: function (g) {
      // chassis + cab
      g.box([0, 0.72, 0.1], [0.98, 0.4, 2.55], { mat: MAT('PAINT'), col: [132, 118, 84], uvScale: 1.6, edge: 210 });
      g.box([0, 1.28, 1.35], [0.94, 0.42, 0.95], { mat: MAT('PAINT'), col: [140, 126, 90], uvScale: 1.6, edge: 215 });
      // windscreen + side glass
      g.face([-0.9, 1.34, 2.28], [0.9, 1.34, 2.28], [0.86, 1.72, 1.82], [-0.86, 1.72, 1.82], { mat: MAT('GLASS'), col: [104, 122, 130], uvScale: 3 });
      g.box([1.0, 1.5, 1.35], [0.02, 0.24, 0.5], { mat: MAT('GLASS'), col: [104, 122, 130], uvScale: 4 });
      g.box([-1.0, 1.5, 1.35], [0.02, 0.24, 0.5], { mat: MAT('GLASS'), col: [104, 122, 130], uvScale: 4 });
      // roof + doors + bed
      g.box([0, 1.72, 1.35], [0.92, 0.05, 0.95], { mat: MAT('PAINT'), col: [124, 112, 80], uvScale: 2, edge: 200 });
      g.box([0.98, 1.2, 1.0], [0.03, 0.34, 0.5], { mat: MAT('PAINT'), col: [120, 108, 78], uvScale: 2.4, edge: 200 });
      g.box([-0.98, 1.2, 1.0], [0.03, 0.34, 0.5], { mat: MAT('PAINT'), col: [120, 108, 78], uvScale: 2.4, edge: 200 });
      g.box([0, 0.98, -1.15], [0.98, 0.28, 1.25], { mat: MAT('PAINT'), col: [128, 116, 84], uvScale: 1.8, edge: 200 });
      g.box([0, 0.72, -2.32], [0.96, 0.36, 0.08], { mat: MAT('PAINT'), col: [118, 106, 76], uvScale: 2.4, edge: 200 });  // tailgate
      // roll bar over the bed
      g.cylinder([-0.92, 1.26, -0.35], [-0.92, 2.06, -0.35], 0.055, 0.055, 8, { mat: MAT('STEEL'), col: [70, 70, 72], caps: true });
      g.cylinder([0.92, 1.26, -0.35], [0.92, 2.06, -0.35], 0.055, 0.055, 8, { mat: MAT('STEEL'), col: [70, 70, 72], caps: true });
      g.cylinder([-0.92, 2.06, -0.35], [0.92, 2.06, -0.35], 0.055, 0.055, 8, { mat: MAT('STEEL'), col: [70, 70, 72], caps: true });
      g.box([-0.92, 1.66, -0.35], [0.05, 0.05, 0.5], { mat: MAT('STEEL'), col: [70, 70, 72], uvScale: 4 });
      g.box([0.92, 1.66, -0.35], [0.05, 0.05, 0.5], { mat: MAT('STEEL'), col: [70, 70, 72], uvScale: 4 });
      // jerry cans + sandbags in the bed
      stowageBox(g, [0.68, 1.24, -1.0], [0.16, 0.2, 0.3], [92, 78, 54], 'RUST');
      stowageBox(g, [-0.68, 1.24, -0.95], [0.16, 0.2, 0.3], [92, 78, 54], 'RUST');
      g.box([0.3, 1.2, -1.75], [0.5, 0.12, 0.3], { mat: MAT('CANVAS'), col: [128, 116, 88], uvScale: 2.2, edge: 180 });
      g.box([-0.35, 1.2, -1.75], [0.45, 0.12, 0.3], { mat: MAT('CANVAS'), col: [120, 110, 82], uvScale: 2.2, edge: 180 });
      // bull bar + lights + snorkel
      g.cylinder([-0.95, 0.7, 2.6], [-0.95, 1.4, 2.6], 0.05, 0.05, 8, { mat: MAT('STEEL'), col: [66, 66, 68], caps: true });
      g.cylinder([0.95, 0.7, 2.6], [0.95, 1.4, 2.6], 0.05, 0.05, 8, { mat: MAT('STEEL'), col: [66, 66, 68], caps: true });
      g.cylinder([-0.95, 1.4, 2.6], [0.95, 1.4, 2.6], 0.05, 0.05, 8, { mat: MAT('STEEL'), col: [66, 66, 68], caps: true });
      lamp(g, 0.72, 1.16, 2.5, 0.1); lamp(g, -0.72, 1.16, 2.5, 0.1);
      lamp(g, 0.8, 0.98, -2.42, 0.05, true); lamp(g, -0.8, 0.98, -2.42, 0.05, true);
      g.cylinder([1.02, 1.3, 1.9], [1.02, 1.9, 1.9], 0.045, 0.045, 8, { mat: MAT('RUBBER'), col: COL.dark, caps: true });
      antenna(g, -0.9, 1.74, 0.6, 2.0);
    } });
    addPart(T, 'wheelsF', 'wheel', [0, 0.42, 1.55], [1.05, 0.42, 0.4], 'RUBBER', 130, { geo: function (g) {
      wheel(g, 0.98, 0.42, 1.55, 0.42, 0.2); wheel(g, -0.98, 0.42, 1.55, 0.42, 0.2);
      g.box([0.98, 0.72, 1.55], [0.06, 0.14, 0.34], { mat: MAT('PAINT'), col: [116, 104, 76], uvScale: 2.6, edge: 190 });
      g.box([-0.98, 0.72, 1.55], [0.06, 0.14, 0.34], { mat: MAT('PAINT'), col: [116, 104, 76], uvScale: 2.6, edge: 190 });
    } });
    addPart(T, 'wheelsR', 'wheel', [0, 0.42, -1.7], [1.05, 0.42, 0.4], 'RUBBER', 130, { geo: function (g) {
      wheel(g, 0.98, 0.42, -1.7, 0.42, 0.2); wheel(g, -0.98, 0.42, -1.7, 0.42, 0.2);
      g.box([0.98, 0.72, -1.7], [0.06, 0.14, 0.34], { mat: MAT('PAINT'), col: [116, 104, 76], uvScale: 2.6, edge: 190 });
      g.box([-0.98, 0.72, -1.7], [0.06, 0.14, 0.34], { mat: MAT('PAINT'), col: [116, 104, 76], uvScale: 2.6, edge: 190 });
    } });
    addPart(T, 'engine', 'engine', [0, 0.98, 2.1], [0.8, 0.24, 0.5], 'METAL', 120, { geo: function (g) {
      g.box([0, 1.12, 2.12], [0.78, 0.05, 0.46], { mat: MAT('METAL'), col: COL.dark, uvScale: 3 });
      // bonnet with a scoop
      g.face([-0.92, 1.3, 2.32], [0.92, 1.3, 2.32], [0.92, 1.16, 1.86], [-0.92, 1.16, 1.86], { mat: MAT('PAINT'), col: [136, 122, 88], uvScale: 2.2, edge: 200 });
      g.box([0.2, 1.3, 2.1], [0.26, 0.05, 0.2], { mat: MAT('METAL'), col: COL.dark, uvScale: 3 });
      g.cylinder([0, 0.9, 2.62], [0, 1.0, 2.62], 0.09, 0.1, 8, { mat: MAT('RUST'), col: [88, 62, 46], caps: true });
    } });
    addPart(T, 'fuel', 'fuel', [0, 0.72, -0.2], [0.4, 0.16, 0.4], 'STEEL', 60, { geo: function (g) {
      g.box([-0.85, 0.66, -0.1], [0.16, 0.16, 0.34], { mat: MAT('STEEL'), col: COL.dark, uvScale: 3 });
    } });
    // ---- pintle-mounted MG + gunner silhouette
    addPart(T, 'gun', 'gun', [0, 1.86, -1.0], [0.24, 0.3, 1.2], 'METAL', 90, { geo: function (g) {
      g.cylinder([0, 1.28, -0.95], [0, 1.66, -0.95], 0.07, 0.06, 10, { mat: MAT('STEEL'), col: [62, 62, 64], caps: true });
      g.box([0, 1.7, -0.95], [0.24, 0.05, 0.24], { mat: MAT('STEEL'), col: [62, 62, 64], uvScale: 3 });
      g.box([0, 1.88, -1.15], [0.07, 0.09, 0.34], { mat: MAT('METAL'), col: COL.dark, uvScale: 3 });
      g.cylinder([0, 1.9, -0.85], [0, 1.9, 0.55], 0.032, 0.026, 10, { mat: MAT('METAL'), col: COL.steel, caps: true });
      g.box([0, 1.94, -0.62], [0.05, 0.06, 0.16], { mat: MAT('METAL'), col: COL.dark, uvScale: 4 });
      g.box([0.16, 1.78, -1.35], [0.14, 0.12, 0.2], { mat: MAT('RUST'), col: COL.rust, uvScale: 3, wear: 60 });
      // gunner: torso, head, arms (rigid, part of the vehicle)
      g.box([0, 1.35, -1.32], [0.2, 0.28, 0.16], { mat: MAT('CLOTH'), col: [96, 92, 70], uvScale: 3, edge: 160 });
      g.box([0, 1.68, -1.3], [0.12, 0.12, 0.12], { mat: MAT('SKIN'), col: [176, 140, 116], uvScale: 4, edge: 150 });
      g.box([0, 1.76, -1.3], [0.135, 0.075, 0.135], { mat: MAT('CLOTH'), col: [88, 86, 66], uvScale: 4, edge: 160 });
      g.box([0.18, 1.55, -1.22], [0.07, 0.22, 0.07], { mat: MAT('CLOTH'), col: [96, 92, 70], uvScale: 4 });
      g.box([-0.18, 1.55, -1.24], [0.07, 0.22, 0.07], { mat: MAT('CLOTH'), col: [96, 92, 70], uvScale: 4 });
      g.box([0.16, 1.5, -1.24], [0.11, 0.11, 0.11], { mat: MAT('SKIN'), col: [168, 134, 112], uvScale: 5 });
      g.box([-0.16, 1.52, -1.26], [0.11, 0.11, 0.11], { mat: MAT('SKIN'), col: [168, 134, 112], uvScale: 5 });
      // gun shield
      g.face([-0.34, 1.72, -1.62], [0.34, 1.72, -1.62], [0.34, 1.3, -1.66], [-0.34, 1.3, -1.66], { mat: MAT('STEEL'), col: [104, 96, 74], uvScale: 2.4, edge: 220 });
    } });
    T.gunLocal = { x: 0, y: 1.9, z: 0.62 };
    addPart(T, 'burn', 'debris', [0, 1.0, 0], [1.05, 0.55, 2.6], 'RUST', 1, { solid: false, geo: function (g) {
      g.box([0, 1.3, 0.1], [1.0, 0.06, 2.55], { mat: MAT('RUST'), col: COL.burnt, uvScale: 1.6, edge: 110 });
      g.box([0, 1.3, 1.35], [0.94, 0.42, 0.95], { mat: MAT('RUST'), col: [40, 36, 33], uvScale: 1.6, edge: 110 });
      g.box([0, 0.74, 0.1], [1.0, 0.42, 2.55], { mat: MAT('RUST'), col: [44, 40, 36], uvScale: 1.6, edge: 110 });
      g.cylinder([0, 1.28, -0.95], [0.6, 1.1, -0.6], 0.07, 0.06, 8, { mat: MAT('RUST'), col: [58, 50, 46], caps: true });
    } });
  })();

  /* ==========================================================================
   * GVehicles
   * ======================================================================== */
  function GVehicles(engine) {
    this.E = engine;
    var G = engine.renderer.G, S = TERRA.shaders;
    this.G = G; this.gl = G.gl;
    this.prog = G.program('cmbGveh', S.cmbVS, S.cmbFS);
    this.progShadow = G.program('cmbGvehShadow', S.cmbVS, S.cmbFS, { SHADOW: 1 });
    this.list = [];
    this.stats = { alive: 0, wrecks: 0, spawns: 0 };
    this.quality = 2;
    this.maxVehicles = 3;
    this._m = M.mat4();
    this._t = { c: [0, 0, 0], h: [0, 0, 0], yaw: 0 };
    this._spawnTimer = 0;
    this._tmpA = [0, 0, 0]; this._tmpB = [0, 0, 0];
  }
  var P = GVehicles.prototype;

  P.configure = function (g) {
    this.quality = U.clamp(g.combatDetail === undefined ? 2 : g.combatDetail, 0, 3);
    this.maxVehicles = [0, 1, 3, 5][this.quality];
    if (!this.maxVehicles) this.clear();
  };

  P.clear = function () {
    this.list.length = 0;
    this.stats.alive = 0; this.stats.wrecks = 0;
  };

  /* ---------------------------------------------------------------- meshes */
  P._template = function (kind) {
    var tpl = VEH[kind];
    if (!tpl._geo) {
      tpl._geo = {}; tpl._wreck = {};
      for (var i = 0; i < tpl.parts.length; i++) {
        var p = tpl.parts[i];
        tpl._geo[i] = cm().upload(this.G, p.geo);
      }
      var w = CGeo();
      for (i = 0; i < tpl.parts.length; i++) {
        var q = tpl.parts[i];
        if (q.name === 'wreckTurret' || q.name === 'burn') w.append(q.geo, [0, 0, 0]);
      }
      tpl._wreckGeo = cm().upload(this.G, w);
    }
    return tpl;
  };
  /** Rebuild the visible mesh from the live parts (called after damage). */
  P._rebuild = function (v) {
    var tpl = v.tpl, gl = this.gl;
    var g = CGeo();
    for (var i = 0; i < tpl.parts.length; i++) {
      var p = tpl.parts[i], st = v.parts[i];
      if (st.destroyed && (p.kind === 'track' || p.kind === 'wheel' || p.kind === 'gun')) continue;
      if (v.dead && p.name !== 'hull' && p.name !== 'wreckTurret' && p.name !== 'burn') continue;
      g.append(p.geo, [0, 0, 0]);
    }
    if (v.mesh) { gl.deleteVertexArray(v.mesh.vao); v.mesh = null; }
    if (g.count > 8) v.mesh = cm().upload(this.G, g);
    v.dirty = false;
  };

  /* ---------------------------------------------------------------- spawns */
  P._mkVehicle = function (kind, x, z, yaw, team, opts) {
    opts = opts || {};
    var K = KINDS[kind], tpl = this._template(kind);
    var rng = mulberry(this.E.seed + '|gv|' + kind + '|' + Math.round(x) + '|' + Math.round(z));
    var v = {
      kind: kind, K: K, tpl: tpl, team: team === undefined ? K.team : team,
      pos: [x, this.E.groundHeight(x, z), z], rpos: [x - this.E.origin[0], this.E.groundHeight(x, z), z - this.E.origin[1]],
      yaw: yaw, pitch: 0, roll: 0, speed: 0, targetSpeed: 0,
      turretYaw: yaw, turretPitch: -0.02, turretTarget: yaw,
      hp: K.hp, maxHp: K.hp, dead: false, deadT: 0, burning: 0,
      parts: [], mesh: null, dirty: true, seed: Math.floor(rng() * 1e9),
      rng: rng, camo: rng(),
      ai: { state: 'guard', alert: 0, lastSeen: null, wp: [], wpi: 0, think: 0, fireT: 0, burst: 0, pause: 0, stuck: 0, smokeT: 6 + rng() * 8, seen: 0 },
      crew: K.crew, kills: 0, shots: 0, flashT: 0, recoil: 0, shake: 0, squeak: 0,
      home: opts.home || null, patrolR: opts.patrolR || 90, _lod: 0, _dist: 0
    };
    for (var i = 0; i < tpl.parts.length; i++) v.parts.push({ hp: tpl.parts[i].maxHp, maxHp: tpl.parts[i].maxHp, destroyed: false, fire: 0 });
    this._rebuild(v);
    return v;
  };

  P.spawnAt = function (kind, x, z, yaw, team, opts) {
    if (this.list.length >= this.maxVehicles + 2) return null;
    var v = this._mkVehicle(kind, x, z, yaw === undefined ? Math.random() * Math.PI * 2 : yaw, team, opts);
    this.list.push(v);
    this.stats.spawns++;
    return v;
  };

  /** Keep garrisons around hostile settlements within streaming range. */
  P._ambient = function (dt, cam) {
    var B = this.E.buildings;
    if (!B || !B.list.length) return;
    this._spawnTimer -= dt;
    for (var i = 0; i < B.list.length; i++) {
      var s = B.list[i];
      if (!s.hostile && s.kind !== 'outpost' && s.kind !== 'town') continue;
      var dx = s.x - cam[0], dz = s.z - cam[2];
      var dist = Math.hypot(dx, dz);
      var want = (s.kind === 'town' ? 2 : s.kind === 'outpost' ? 1 : (s.hostile ? 1 : 0));
      if (this.quality >= 3) want += 1;
      if (this.quality <= 1) want = Math.min(want, 1);
      var have = 0;
      for (var k = 0; k < this.list.length; k++) if (this.list[k].home === s) have++;
      if (have >= want) continue;
      if (this._spawnTimer > 0) return;
      if (dist > 700 || dist < 60) continue;
      // pick a spot just outside the built-up area, off the player's view
      var ang = Math.atan2(dz, dx) + (Math.random() - 0.5) * 1.2;
      var r = (s.radius || 90) + 25 + Math.random() * 60;
      var x = s.x + Math.cos(ang) * r, z = s.z + Math.sin(ang) * r;
      var g = this.E.groundHeight(x, z);
      var w = this.E.waterAt(x, z);
      if (w.level > -1e4 && w.type !== 4 && g < w.level + 0.6) continue;
      var rc = B.resolveCircle(x, z, g + 1, KINDS.tank.radius * 0.5, 2.2);
      if (rc && (Math.abs(rc[0]) > 0.01 || Math.abs(rc[1]) > 0.01)) continue;
      // kind mix: towns get a tank, outposts an APC or a technical
      var kind = 'technical', roll = Math.random();
      if (s.kind === 'town') kind = roll < 0.42 ? 'tank' : (roll < 0.78 ? 'apc' : 'technical');
      else kind = roll < 0.45 ? 'apc' : 'technical';
      this.spawnAt(kind, x, z, ang + Math.PI, 1, { home: s, patrolR: 70 + Math.random() * 80 });
      this._spawnTimer = 3.5;
      return;
    }
    // despawn idle vehicles that are far away
    for (var j = this.list.length - 1; j >= 0; j--) {
      var v = this.list[j];
      var d = Math.hypot(v.pos[0] - cam[0], v.pos[2] - cam[2]);
      if (d > 1200 && v.ai.state === 'guard' && !v.dead) this.list.splice(j, 1);
    }
  };

  /* ------------------------------------------------------------------ maths */
  P._mat = function (v, out) {
    var o = this.E.origin;
    var cy = Math.cos(v.yaw), sy = Math.sin(v.yaw);
    var cp = Math.cos(v.pitch), sp = Math.sin(v.pitch);
    var cr = Math.cos(v.roll), sr = Math.sin(v.roll);
    // forward (with pitch), right (with roll), up
    var fx = sy * cp, fy = sp, fz = cy * cp;
    var rx = cy * cr + sy * sp * sr, ry = -cp * sr, rz = -sy * cr + cy * sp * sr;
    // orthonormalise
    var rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
    var ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
    out[0] = rx; out[1] = ry; out[2] = rz; out[3] = 0;
    out[4] = ux; out[5] = uy; out[6] = uz; out[7] = 0;
    out[8] = fx; out[9] = fy; out[10] = fz; out[11] = 0;
    out[12] = v.pos[0] - o[0]; out[13] = v.pos[1]; out[14] = v.pos[2] - o[1]; out[15] = 1;
    return out;
  };
  /** Local part box in world space (for rays and blasts). */
  P._partObb = function (v, pi) {
    var p = v.tpl.parts[pi], out = this._t;
    return this._partObbInto(v, pi, out);
  };
  P._partObbInto = function (v, pi, out) {
    var p = v.tpl.parts[pi];
    var cy = Math.cos(v.yaw), sy = Math.sin(v.yaw);
    var cp = Math.cos(v.pitch), sp = Math.sin(v.pitch);
    // pitch about the local x axis, then yaw (same basis as _mat)
    var y2 = p.c[1] * cp + p.c[2] * sp;
    var z2 = -p.c[1] * sp + p.c[2] * cp;
    out.c[0] = v.pos[0] + (cy * p.c[0] + sy * z2);
    out.c[1] = v.pos[1] + y2;
    out.c[2] = v.pos[2] + (-sy * p.c[0] + cy * z2);
    out.h[0] = p.h[0]; out.h[1] = p.h[1]; out.h[2] = p.h[2];
    out.yaw = v.yaw;
    return out;
  };

  /* ------------------------------------------------------------------- ray */
  P.raycast = function (o, d, maxT, filter) {
    var best = null, skipRef = filter && filter.ignore;
    for (var i = 0; i < this.list.length; i++) {
      var v = this.list[i];
      if (v === skipRef) continue;             // a vehicle must not shoot its own turret
      // quick sphere reject
      var vx = v.pos[0] - o[0], vy = v.pos[1] + 1 - o[1], vz = v.pos[2] - o[2];
      var along = vx * d[0] + vy * d[1] + vz * d[2];
      if (along < -8 || along > maxT + 12) continue;
      var R = v.K.radius + 1.5;
      var d2 = (vx * vx + vy * vy + vz * vz) - along * along;
      if (d2 > R * R) continue;
      var cy = Math.cos(-v.yaw), sy = Math.sin(-v.yaw);
      var cp = Math.cos(v.pitch), sp = Math.sin(v.pitch);
      // ray into vehicle space: yaw first, then undo the pitch about local x
      var ox = o[0] - v.pos[0], oy = o[1] - v.pos[1], oz = o[2] - v.pos[2];
      var yx = cy * ox - sy * oz, yz = sy * ox + cy * oz;
      var lo2 = [yx, oy * cp - yz * sp, oy * sp + yz * cp];
      var dx2 = cy * d[0] - sy * d[2], dz2 = sy * d[0] + cy * d[2];
      var ld = [dx2, d[1] * cp - dz2 * sp, d[1] * sp + dz2 * cp];
      for (var pi = 0; pi < v.tpl.parts.length; pi++) {
        var pd = v.tpl.parts[pi];
        if (v.parts[pi].destroyed && pd.kind !== 'hull') continue;
        var R2 = cm().rayOBB(lo2, ld, { c: pd.c, h: pd.h, yaw: 0 });
        if (!R2 || R2.t > maxT) continue;
        if (!best || R2.t < best.t) {
          // world normal
          var nx = cy * R2.n[0] - sy * R2.n[2], nz = sy * R2.n[0] + cy * R2.n[2];
          best = {
            t: R2.t, type: 'gvehicle', ref: v, part: v.parts[pi], partIndex: pi,
            partName: pd.name, surface: pd.surface, n: [nx, R2.n[1], nz], vehicle: v
          };
        }
      }
    }
    return best;
  };

  /* ---------------------------------------------------------------- damage */
  P.damage = function (v, part, dmg, hit, opts) {
    opts = opts || {};
    if (!v || !part) return { killed: false };
    var K = v.K, entry = null, idx = -1;
    for (var i = 0; i < v.parts.length; i++) if (v.parts[i] === part) { entry = part; idx = i; break; }
    if (!entry) return { killed: false };
    var pd = v.tpl.parts[idx];
    if (entry.destroyed && pd.kind !== 'hull') return { killed: false };
    // armour: steel plates stop a lot of small-arms fire
    var mult = pd.critical ? 1.25 : 1;
    if (opts.explosive) mult *= 1.5;
    else if (pd.mat === 'STEEL' || pd.mat === 'METAL') mult *= 0.55;
    var applied = dmg * mult * (1 / Math.max(0.35, K.armor));
    entry.hp -= applied;
    v.hp -= applied * (pd.kind === 'hull' || pd.kind === 'turret' ? 0.8 : 0.35);
    var C = cc();
    if (C && hit && hit.p) {
      C.impact(hit, { noDecal: pd.mat === 'GLASS' });
      if (Math.random() < 0.5) C.sfx(pd.mat === 'GLASS' ? 'glass' : 'metal', hit.p, 0.5, 1);
    }
    if (entry.hp <= 0 && !entry.destroyed) this._destroyPart(v, idx);
    if (v.hp <= 0) this._kill(v, hit, opts);
    else if (v.ai.state === 'guard') { v.ai.state = 'alert'; v.ai.alert = 1; }
    return { killed: v.dead, blocked: false };
  };

  P._destroyPart = function (v, idx) {
    var st = v.parts[idx], pd = v.tpl.parts[idx], C = cc();
    st.destroyed = true; st.hp = 0;
    v.dirty = true;
    var ob = this._partObb(v, idx);
    var p = [ob.c[0], ob.c[1], ob.c[2]];
    if (C) {
      C.sfx('metal', p, 0.9, 1.2);
      C.tracers.flash(p, 1.6, [1.0, 0.7, 0.35], 0.12);
    }
    var fx = this.E.effects;
    if (fx) {
      fx.sparks(p, 22, 6);
      fx.emit(TERRA.game.Effects.K.SMOKE, p, [0, 1.4, 0], 1.6, 0.5, 1.4, [0.2, 0.2, 0.2], 0.3);
      fx.lights.push({ pos: p.slice(), color: [3, 1.6, 0.6], radius: 12, age: 0, life: 0.18 });
      fx.shake = Math.max(fx.shake, 0.12);
    }
    if (pd.kind === 'track') { st.broken = true; this._stuckCheck(v); }
    else if (pd.kind === 'wheel') { st.broken = true; this._stuckCheck(v); }
    else if (pd.kind === 'engine') { st.fire = 1; v.ai.immobile = true; }
    else if (pd.kind === 'fuel') { st.fire = 1; if (Math.random() < 0.5) this._burn(v, 2); }
    else if (pd.kind === 'gun') {
      v.ai.gunDead = true;
      if (v.kind === 'technical' && this.E.soldiers) {
        this.E.soldiers.spawnAt(v.pos[0] + Math.cos(v.yaw) * 2.6, v.pos[2] - Math.sin(v.yaw) * 2.6, { cls: 'scout', team: v.team, alert: 1 });
      }
    }
    else if (pd.kind === 'turret') { v.ai.turretDead = true; }
  };
  P._stuckCheck = function (v) {
    var tracks = 0, broken = 0, wheels = 0, wbroken = 0;
    for (var i = 0; i < v.parts.length; i++) {
      var pd = v.tpl.parts[i], st = v.parts[i];
      if (pd.kind === 'track') { tracks++; if (st.destroyed) broken++; }
      else if (pd.kind === 'wheel') { wheels++; if (st.destroyed) wbroken++; }
    }
    if (tracks >= 2 && broken >= tracks) v.ai.immobile = true;
    else if (wheels >= 2 && wbroken >= Math.ceil(wheels / 2)) v.ai.immobile = true;
    else if (broken || wbroken) v.ai.crippled = true;
  };
  P._burn = function (v, seconds) { v.burning = Math.max(v.burning, seconds); };

  P._kill = function (v, hit, opts) {
    if (v.dead) return;
    var C = cc(), E = this.E;
    v.dead = true; v.deadT = 0; v.hp = 0; v.speed = 0; v.targetSpeed = 0;
    v.ai.state = 'wreck'; v.burning = 900;
    var K = v.K;
    var p = [v.pos[0], v.pos[1] + 1.1, v.pos[2]];
    if (C) {
      C.explode(p, v.kind === 'tank' ? 5.2 : (v.kind === 'apc' ? 4 : 2.6), { team: v.team, source: opts && opts.source, crater: K.mass > 5 });
      C.sfx('explosion', p, 1, v.kind === 'tank' ? 3 : 2);
    }
    var fx = E.effects;
    if (fx) {
      if (fx.explosion) fx.explosion(p, v.kind === 'tank' ? 3.2 : 2.2, false);
      fx.lights.push({ pos: p.slice(), color: [8, 3.4, 0.9], radius: v.kind === 'tank' ? 42 : 26, age: 0, life: 0.5 });
      fx.shake = Math.max(fx.shake, 0.6);
      for (var i = 0; i < 4; i++) {
        fx.emit(TERRA.game.Effects.K.DEBRIS, [v.pos[0] + (Math.random() - 0.5) * 3, v.pos[1] + 1.4, v.pos[2] + (Math.random() - 0.5) * 3],
          [(Math.random() - 0.5) * 9, 5 + Math.random() * 8, (Math.random() - 0.5) * 9], 2.4 + Math.random(), 0.16, 0, [0.3, 0.29, 0.28], 1, Math.random() * 6);
      }
    }
    this.stats.wrecks++;
    // the killer gets credit
    if (isPlayerSource(E, opts && opts.source)) {
      if (E.warmode) E.warmode.kills = (E.warmode.kills || 0) + 1;
      if (TERRA.ui && TERRA.ui.toast) TERRA.ui.toast(v.K.label + ' destroyed', 'discover');
    }
    if (E.soldiers && E.soldiers.stats) E.soldiers.stats.vehicles = (E.soldiers.stats.vehicles || 0) + 1;
    // crew bail out of light vehicles
    if (v.kind === 'technical' && E.soldiers && Math.random() < 0.8) {
      var a2 = Math.atan2(v.pos[0] - (opts && opts.source && opts.source.pos ? opts.source.pos[0] : v.pos[0]) || 0.1, v.pos[2] - (opts && opts.source && opts.source.pos ? opts.source.pos[2] : v.pos[2]) || 0.1);
      E.soldiers.spawnAt(v.pos[0] + Math.cos(a2) * 2.4, v.pos[2] + Math.sin(a2) * 2.4, { cls: 'scout', team: v.team, alert: 1 });
    }
  };

  P.blast = function (p, power, R, opts) {
    opts = opts || {};
    for (var i = 0; i < this.list.length; i++) {
      var v = this.list[i];
      var dv = Math.hypot(v.pos[0] - p[0], v.pos[1] + 1 - p[1], v.pos[2] - p[2]);
      if (dv > R * 1.9) continue;
      var fall = Math.pow(clamp01(1 - dv / (R * 1.9)), 1.5);
      if (fall < 0.02) continue;
      for (var pi = 0; pi < v.parts.length; pi++) {
        var ob = this._partObb(v, pi);
        var pd = v.tpl.parts[pi];
        if (pd.kind === 'debris') continue;
        var d = Math.hypot(ob.c[0] - p[0], ob.c[1] - p[1], ob.c[2] - p[2]);
        if (d > R * 2.2) continue;
        var ff = Math.pow(clamp01(1 - d / (R * 2.2)), 1.4);
        var dmg = 60 * power * ff * fall * (pd.kind === 'track' || pd.kind === 'wheel' ? 1.5 : 1);
        if (dmg < 2) continue;
        this.damage(v, v.parts[pi], dmg, { p: [ob.c[0], ob.c[1], ob.c[2]], n: [0, 1, 0], surface: pd.surface }, { explosive: true, source: opts.source, team: opts.team });
      }
      // shove the hull
      var kx = (v.pos[0] - p[0]) / Math.max(0.8, dv), kz = (v.pos[2] - p[2]) / Math.max(0.8, dv);
      v.pos[0] += kx * power * 0.35 * fall; v.pos[2] += kz * power * 0.35 * fall;
      v.yaw += (Math.random() - 0.5) * power * 0.02 * fall;
      if (v.ai.state === 'guard' && !v.dead) { v.ai.state = 'alert'; v.ai.alert = 1; }
    }
  };

  P.impulse = function (p, power, R) {
    for (var i = 0; i < this.list.length; i++) {
      var v = this.list[i];
      var d = Math.hypot(v.pos[0] - p[0], v.pos[2] - p[2]);
      if (d > R) continue;
      var f = (1 - d / R) * power * 0.2;
      v.pos[0] += (v.pos[0] - p[0]) / Math.max(0.5, d) * f;
      v.pos[2] += (v.pos[2] - p[2]) / Math.max(0.5, d) * f;
      v.yaw += (Math.random() - 0.5) * f * 0.1;
    }
  };

  /* ------------------------------------------------------------------- fire */
  P._fireCannon = function (v) {
    var C = cc(); if (!C) return;
    var K = v.K;
    var m = this._gunWorld(v);
    var dir = [Math.sin(v.yaw + v.turretYaw), Math.sin(v.turretPitch), Math.cos(v.yaw + v.turretYaw)];
    var dl = Math.hypot(dir[0], dir[1], dir[2]) || 1; dir[0] /= dl; dir[1] /= dl; dir[2] /= dl;
    var spread = 0.004 + (1 - this._aimQuality(v)) * 0.02;
    dir[0] += (Math.random() - 0.5) * spread * 2; dir[1] += (Math.random() - 0.5) * spread * 2; dir[2] += (Math.random() - 0.5) * spread * 2;
    dl = Math.hypot(dir[0], dir[1], dir[2]); dir[0] /= dl; dir[1] /= dl; dir[2] /= dl;
    var hit = C.cast(m, dir, K.range * 1.6, { ignore: v });
    var end = hit ? hit.p : [m[0] + dir[0] * K.range * 1.6, m[1] + dir[1] * K.range * 1.6, m[2] + dir[2] * K.range * 1.6];
    C.tracers.streak(m, end, [1.0, 0.78, 0.42], 0.06, 0.03);
    C.tracers.flash(m, 3.4, [1.0, 0.72, 0.4], 0.09);
    C.sfx('shotHeavy', m, 1, 3);
    var fx = this.E.effects;
    if (fx) {
      fx.lights.push({ pos: m.slice(), color: [7, 4.4, 2.2], radius: 34, age: 0, life: 0.12 });
      fx.emit(TERRA.game.Effects.K.SMOKE, m, [dir[0] * 6, dir[1] * 6 + 2, dir[2] * 6], 2.6, 0.7, 3.2, [0.55, 0.54, 0.5], 0.35);
      fx.emit(TERRA.game.Effects.K.SPARK, m, [dir[0] * 14, dir[1] * 14, dir[2] * 14], 0.35, 0.06, 4, [1, 0.8, 0.45], 1);
      fx.shake = Math.max(fx.shake, 0.35);
    }
    if (hit) {
      if (hit.type === 'terrain' || hit.type === 'building' || hit.type === 'object') C.impact(hit, {});
      if (hit.type === 'soldier' || hit.type === 'player' || hit.type === 'building' || hit.type === 'gvehicle') {
        C.applyDamage(hit, 95, { source: { isVehicle: v, team: v.team, isPlayer: false }, team: v.team, explosive: true, dmgType: 'shell' });
      }
      C.explode([end[0] + dir[0] * 0.6, end[1] + dir[1] * 0.6, end[2] + dir[2] * 0.6], 4.2, {
        team: v.team, source: { isVehicle: v, team: v.team, isPlayer: false }, terrain: true, crater: 1
      });
    }
    v.recoil = 1; v.flashT = 0.09; v.shake = 0.5; v.shots++;
    v.ai.burst = 0; v.ai.fireT = K.reload * (0.9 + Math.random() * 0.3);
    // recoil pushes the hull back slightly
    v.pos[0] -= Math.sin(v.yaw) * 0.06; v.pos[2] -= Math.cos(v.yaw) * 0.06;
    v.pitch += 0.012; v.recoilKick = 1;
  };

  /** Turret yaw/pitch → world muzzle position. */
  P._gunWorld = function (v) {
    var K = v.K, gl2 = v.tpl.gunLocal;
    var ta = v.yaw + v.turretYaw;
    var cy = Math.cos(ta), sy = Math.sin(ta), cp = Math.cos(v.turretPitch), sp = Math.sin(v.turretPitch);
    // turret-local: x right, y up, z forward along the barrel
    var lx = gl2.x, ly = gl2.y, lz = gl2.z;
    var fz = lz * cp, fy = lz * sp;
    var wy = v.pos[1] + ly + fy;
    var wx = v.pos[0] + sy * fz + cy * lx;
    var wz = v.pos[2] + cy * fz - sy * lx;
    return [wx, wy, wz];
  };

  P._fireMG = function (v) {
    var C = cc(); if (!C) return;
    var K = v.K;
    var distP = Math.hypot(v.pos[0] - this.E.player.pos[0], v.pos[2] - this.E.player.pos[2]);
    var m = this._gunWorld(v);
    var ta = v.yaw + v.turretYaw;
    var dir = [Math.sin(ta), Math.sin(v.turretPitch), Math.cos(ta)];
    var dl = Math.hypot(dir[0], dir[1], dir[2]) || 1; dir[0] /= dl; dir[1] /= dl; dir[2] /= dl;
    var spread = 0.009 + (1 - this._aimQuality(v)) * 0.06 + Math.max(0, distP - 60) * 0.0004;
    dir[0] += (Math.random() - 0.5) * spread * 2; dir[1] += (Math.random() - 0.5) * spread * 2; dir[2] += (Math.random() - 0.5) * spread * 2;
    dl = Math.hypot(dir[0], dir[1], dir[2]); dir[0] /= dl; dir[1] /= dl; dir[2] /= dl;
    var hit = C.cast(m, dir, K.mgRange, { ignore: v });
    var end = hit ? hit.p : [m[0] + dir[0] * K.mgRange, m[1] + dir[1] * K.mgRange, m[2] + dir[2] * K.mgRange];
    C.tracers.streak(m, end, [1.0, 0.85, 0.55], 0.05, 0.012);
    C.tracers.flash(m, 0.9, [1, 0.82, 0.5], 0.05);
    C.sfx(v.kind === 'technical' ? 'shot' : 'shotHeavy', m, 0.9, 1);
    var fx = this.E.effects;
    if (fx) fx.lights.push({ pos: m.slice(), color: [3.4, 2.2, 1.1], radius: 12, age: 0, life: 0.05 });
    if (hit) {
      if (hit.type === 'terrain' || hit.type === 'building' || hit.type === 'object') C.impact(hit, {});
      if (hit.type === 'player' || hit.type === 'soldier' || hit.type === 'building' || hit.type === 'gvehicle') {
        C.applyDamage(hit, 17, { source: { isVehicle: v, team: v.team, isPlayer: false }, team: v.team, dmgType: 'bullet' });
      }
    }
    v.shots++;
  };

  P._aimQuality = function (v) {
    var q = 0.55 + (this.quality * 0.12);
    if (v.ai.turretDead) q -= 0.35;
    if (v.burning > 1) q -= 0.2;
    return U.clamp(q, 0.15, 0.95);
  };

  /* ------------------------------------------------------------------- move */
  P._drive = function (v, dt, cam, pl) {
    var K = v.K, E = this.E;
    if (v.ai.immobile || v.dead) { v.speed = U.damp(v.speed, 0, 2.2, dt); }
    else {
      v.speed = U.damp(v.speed, v.targetSpeed * (v.ai.crippled ? 0.35 : 1), 1.6, dt);
    }
    if (Math.abs(v.speed) > 0.02) {
      var cy = Math.cos(v.yaw), sy = Math.sin(v.yaw);
      var nx = v.pos[0] + sy * v.speed * dt, nz = v.pos[2] + cy * v.speed * dt;
      // walls and other vehicles block the hull
      var B = E.buildings, blocked = null;
      if (B && B.list.length) blocked = B.resolveCircle(nx, nz, v.pos[1] + 1, K.radius * 0.45, K.height);
      if (blocked && (Math.abs(blocked[0]) > 1e-3 || Math.abs(blocked[1]) > 1e-3)) {
        nx += blocked[0]; nz += blocked[1];
        v.ai.stuck += dt;
        if (v.ai.stuck > 0.6) { v.targetSpeed = -Math.abs(v.targetSpeed) * 0.6; v.ai.stuck = 0; }
      } else v.ai.stuck = Math.max(0, v.ai.stuck - dt * 0.5);
      for (var i = 0; i < this.list.length; i++) {
        var o = this.list[i];
        if (o === v) continue;
        var dx = nx - o.pos[0], dz = nz - o.pos[2];
        var dd = Math.hypot(dx, dz), minD = (K.radius + o.K.radius) * 0.42;
        if (dd < minD && dd > 1e-3) {
          nx += dx / dd * (minD - dd) * 0.6; nz += dz / dd * (minD - dd) * 0.6;
        }
      }
      v.pos[0] = nx; v.pos[2] = nz;
    }
    // vertical: average of four contact points, plus pitch/roll from the slope
    var L = K.radius * 0.55, W = K.radius * 0.36;
    var cy2 = Math.cos(v.yaw), sy2 = Math.sin(v.yaw);
    function at(fx, sx) {
      var x = v.pos[0] + sy2 * fx + cy2 * sx, z = v.pos[2] + cy2 * fx - sy2 * sx;
      var h = E.groundHeight(x, z);
      var B2 = E.buildings;
      if (B2 && B2.list.length) {
        var f = B2.floorHeight(x, z, h + 1.4, 0.6);
        if (f > h - 0.4) h = Math.max(h, f);
      }
      return [x, h, z];
    }
    var pf = at(L, 0), pr = at(-L, 0), sl = at(0, -W), sr = at(0, W);
    var gy = (pf[1] + pr[1] + sl[1] + sr[1]) * 0.25;
    var pitch = Math.atan2(pr[1] - pf[1], L * 2);
    var roll = Math.atan2(sl[1] - sr[1], W * 2);
    v.pitch = U.damp(v.pitch, pitch, 6, dt) + (v.recoilKick ? v.recoilKick * 0.01 : 0);
    v.roll = U.damp(v.roll, roll, 6, dt);
    v.recoilKick = Math.max(0, (v.recoilKick || 0) - dt * 3);
    v.pos[1] = U.damp(v.pos[1], gy, 10, dt);
    // crush anyone under the tracks
    if (Math.abs(v.speed) > 3.5 && this.E.soldiers) {
      var near = this.E.soldiers.queryRadius(v.pos, K.radius * 0.55);
      for (var s = 0; s < near.length; s++) {
        var sd = near[s];
        if (sd.dead || sd.team === v.team) continue;
        this.E.soldiers.damage(sd, 400, { p: [sd.pos[0], sd.pos[1] + 0.4, sd.pos[2]], n: [0, 1, 0], surface: 'cloth' },
          { source: { isVehicle: v, isPlayer: false }, explosive: true, team: v.team });
      }
    }
    void cam; void pl;
  };

  /* --------------------------------------------------------------------- AI */
  P._think = function (v, dt, cam, pl) {
    var K = v.K, E = this.E, B = E.buildings;
    var ai = v.ai;
    var dxp = pl.pos[0] - v.pos[0], dzp = pl.pos[2] - v.pos[2];
    var distP = Math.hypot(dxp, dzp);
    var eye = [v.pos[0], v.pos[1] + 1.9, v.pos[2]];
    var target = null, tsight = false;
    if (!v.dead && distP < K.range * 1.05) {
      var dirP = [(pl.pos[0] - eye[0]) / Math.max(0.2, distP), (pl.pos[1] + 1.2 - eye[1]) / Math.max(0.2, distP), (pl.pos[2] - eye[2]) / Math.max(0.2, distP)];
      tsight = this._los(eye, pl.pos[0], pl.pos[1] + 1.2, pl.pos[2], v);
      if (tsight) {
        if (ai.seen <= 0) ai.react = 0.55 + Math.random() * 0.9 + (3 - this.quality) * 0.35;
        ai.seen = 4; ai.lastSeen = [pl.pos[0], pl.pos[1] + 1.2, pl.pos[2]]; ai.lost = 0;
      }
    }
    ai.seen = Math.max(0, ai.seen - dt);
    if (ai.seen > 0 && pl.pos) target = pl;
    // decide state
    if (v.dead) ai.state = 'wreck';
    else if (target || ai.lastSeen) ai.state = ai.seen > 0 ? 'engage' : 'search';
    else if (ai.alert > 0) ai.state = 'alert';
    else ai.state = 'guard';
    ai.alert = Math.max(0, ai.alert - dt * 0.12);

    // ------- aim
    if (!v.dead) {
      var aimAt = null;
      if (ai.seen > 0) aimAt = [pl.pos[0], pl.pos[1] + 1.1, pl.pos[2]];
      else if (ai.lastSeen) aimAt = ai.lastSeen;
      else if (ai.state === 'alert' && ai.alertPos) aimAt = ai.alertPos;
      if (aimAt) {
        var tx = aimAt[0] - v.pos[0], tz = aimAt[2] - v.pos[2];
        var want = Math.atan2(tx, tz) - v.yaw;
        while (want > Math.PI) want -= Math.PI * 2;
        while (want < -Math.PI) want += Math.PI * 2;
        // limit the turret traverse
        var lim = v.tpl === VEH.technical ? Math.PI * 0.95 : Math.PI;
        var maxT = K.turretRate * dt * (ai.turretDead ? 0.15 : 1);
        var delta = U.clamp(want - v.turretYaw, -maxT, maxT);
        // turret traverse lags: ease it
        if (Math.abs(want - v.turretYaw) > 0.02) delta *= ai.turretDead ? 0.15 : 1;
        v.turretYaw = U.clamp(v.turretYaw + delta, -lim, lim);
        // elevation: simple ballistic lead
        var aimY = aimAt[1], dy = aimY - (v.pos[1] + 1.7);
        var pitch = Math.atan2(dy, Math.max(1, Math.hypot(tx, tz)));
        if (K.cannon) pitch += Math.hypot(tx, tz) * 0.0016;      // slight arc
        v.turretPitch = U.damp(v.turretPitch, U.clamp(pitch, K.turretPitch[0], K.turretPitch[1]), 4, dt);
      } else {
        v.turretYaw = U.damp(v.turretYaw, 0, 0.8, dt);
        v.turretPitch = U.damp(v.turretPitch, -0.02, 1.2, dt);
      }
    }

    // ------- fire
    ai.fireT -= dt; ai.pause -= dt; ai.react = Math.max(0, (ai.react || 0) - dt);
    var relBear = Math.atan2(dxp, dzp) - v.yaw;
    while (relBear > Math.PI) relBear -= Math.PI * 2;
    while (relBear < -Math.PI) relBear += Math.PI * 2;
    var aligned = Math.abs(relBear - v.turretYaw) < 0.06;
    if (!v.dead && ai.seen > 0 && ai.react <= 0 && ai.fireT <= 0 && ai.pause <= 0 && aligned && !ai.gunDead) {
      if (K.cannon) {
        if (distP > 22 && distP < K.range) this._fireCannon(v);
      } else {
        if (ai.burst <= 0) { ai.burst = K.burst[0] + Math.floor(Math.random() * (K.burst[1] - K.burst[0] + 1)); }
        if (distP < K.mgRange) {
          this._fireMG(v);
          ai.burst--;
          ai.fireT = 60 / (K.cannon ? 120 : 460) * (1 + Math.random() * 0.4);
          if (ai.burst <= 0) ai.pause = K.burstPause[0] + Math.random() * (K.burstPause[1] - K.burstPause[0]);
        } else ai.fireT = 0.4;
      }
    }

    // ------- driving
    if (!v.dead) {
      var wp = ai.wp;
      var wantSpeed = 0, desiredYaw = v.yaw;
      if (ai.state === 'guard') {
        if (!wp.length) {
          // lazy patrol loop around the home settlement
          var rng = mulberry(v.seed);
          var home = v.home || { x: v.pos[0], z: v.pos[2] };
          for (var i = 0; i < 4; i++) {
            var a = rng() * Math.PI * 2;
            var rr = v.patrolR * (0.6 + rng() * 0.6);
            wp.push([home.x + Math.cos(a) * rr, home.z + Math.sin(a) * rr]);
          }
          ai.wp = wp; ai.wpi = 0;
        }
        var t = wp[ai.wpi % wp.length];
        var d = Math.hypot(t[0] - v.pos[0], t[1] - v.pos[2]);
        if (d < 12) { ai.wpi = (ai.wpi + 1) % wp.length; t = wp[ai.wpi]; d = Math.hypot(t[0] - v.pos[0], t[1] - v.pos[2]); }
        desiredYaw = Math.atan2(t[0] - v.pos[0], t[1] - v.pos[2]);
        wantSpeed = Math.min(K.speed * 0.45, d * 0.35);
      } else if (ai.state === 'alert') {
        wantSpeed = 0;
        if (ai.alertPos) desiredYaw = Math.atan2(ai.alertPos[0] - v.pos[0], ai.alertPos[2] - v.pos[2]);
      } else {
        // engage: hold ground but reposition when too close or when the hull blocks the gun
        if (distP < 26 && K.cannon) { wantSpeed = -K.reverse * 0.6; desiredYaw = Math.atan2(dxp, dzp); }
        else if (distP > 260) { wantSpeed = K.speed * 0.7; desiredYaw = Math.atan2(dxp, dzp); }
        else { wantSpeed = 0; desiredYaw = Math.atan2(dxp, dzp); }
      }
      if (ai.immobile) wantSpeed = 0;
      // steer
      var dyaw = desiredYaw - v.yaw;
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      v.yaw += U.clamp(dyaw, -K.turn * dt, K.turn * dt);
      v.targetSpeed = wantSpeed;
      if (ai.state === 'engage' && v.speed < 0) v.targetSpeed = Math.min(v.targetSpeed, 0);
      // obstacle ahead: back off
      var C = cc();
      if (C && Math.abs(v.speed) > 3) {
        var ahead = [v.pos[0] + Math.sin(v.yaw) * K.radius, v.pos[1] + 1.1, v.pos[2] + Math.cos(v.yaw) * K.radius];
        var h = C.cast(ahead, [Math.sin(v.yaw), 0, Math.cos(v.yaw)], 4.5, { skip: ['gvehicle'], ignore: v });
        if (h && h.t < 4.5 && v.speed > 0) { v.targetSpeed = -K.reverse * 0.5; ai.stuck = 0; }
      }
      // burning smoke screens when badly hurt
      if (!v.dead && v.hp < K.hp * 0.35) {
        ai.smokeT -= dt;
        if (ai.smokeT <= 0) { ai.smokeT = 18 + Math.random() * 12; this._smokeScreen(v); }
      }
    }

    // ------- damage feedback
    if (!v.dead) {
      if (v.hp < K.hp * 0.5) { if (v.smoke === undefined) v.smoke = 1; }
      this._fires(v, dt);
    } else {
      this._fires(v, dt);
      v.deadT += dt;
    }
  };

  P._los = function (from, tx, ty, tz, self) {
    var C = cc(); if (!C) return false;
    var dx = tx - from[0], dy = ty - from[1], dz = tz - from[2];
    var d = Math.hypot(dx, dy, dz);
    if (d < 0.5) return true;
    var hit = C.cast(from, [dx / d, dy / d, dz / d], d - 0.8, { skip: ['soldier'], ignore: self });
    return !hit;
  };

  P._smokeScreen = function (v) {
    var C = cc(), fx = this.E.effects;
    var m = [v.pos[0], v.pos[1] + 1.9, v.pos[2]];
    for (var i = 0; i < 4; i++) {
      var a = v.yaw + (i - 1.5) * 0.5;
      var p = [v.pos[0] + Math.sin(a) * 3, v.pos[1] + 1.4, v.pos[2] + Math.cos(a) * 3];
      if (fx) {
        fx.emit(TERRA.game.Effects.K.SMOKE, p, [Math.sin(a) * 3, 0.8, Math.cos(a) * 3], 5.5, 1.6, 5, [0.62, 0.62, 0.6], 0.55);
        fx.lights.push({ pos: p.slice(), color: [2, 1.6, 0.8], radius: 10, age: 0, life: 0.15 });
      }
    }
    if (C) C.sfx('shot', m, 0.8, 1);
    void m;
  };

  P._fires = function (v, dt) {
    var fx = this.E.effects;
    if (!fx) return;
    var K = v.K;
    // component fires
    for (var i = 0; i < v.parts.length; i++) {
      var st = v.parts[i], pd = v.tpl.parts[i];
      if (!st.fire || st.destroyed) continue;
      st.fireT = (st.fireT || 0) + dt;
      if (st.fireT < 0.08) continue;
      st.fireT = 0;
      var ob = this._partObb(v, i);
      if (Math.random() < 0.5) {
        fx.emit(TERRA.game.Effects.K.FIRE, [ob.c[0], ob.c[1], ob.c[2]],
          [(Math.random() - 0.5) * 0.6, 2.4 + Math.random(), (Math.random() - 0.5) * 0.6], 0.5, 0.34, 1.6,
          [1, 0.55 + Math.random() * 0.2, 0.16], 0.7);
      }
      fx.emit(TERRA.game.Effects.K.SMOKE, [ob.c[0], ob.c[1] + 0.2, ob.c[2]],
        [(Math.random() - 0.5), 2.0 + Math.random() * 2, (Math.random() - 0.5)], 3.4, 0.7, 3.4, [0.12, 0.12, 0.12], 0.42);
      if (Math.random() < 0.35) fx.lights.push({ pos: [ob.c[0], ob.c[1] + 0.4, ob.c[2]], color: [2.6, 1.1, 0.35], radius: 9, age: 0, life: 0.25 });
      void pd;
    }
    // burning wreck / damaged hull
    if (v.burning > 0) {
      if (!v.dead) v.burning -= dt;
      var p = [v.pos[0] + (Math.random() - 0.5) * K.radius, v.pos[1] + 1.4, v.pos[2] + (Math.random() - 0.5) * K.radius];
      if (Math.random() < 0.75) {
        fx.emit(TERRA.game.Effects.K.FIRE, p, [(Math.random() - 0.5) * 0.8, 3.2 + Math.random() * 1.6, (Math.random() - 0.5) * 0.8],
          0.6, 0.5, 2.2, [1, 0.52 + Math.random() * 0.2, 0.14], 0.75);
      }
      fx.emit(TERRA.game.Effects.K.SMOKE, [p[0], p[1] + 0.6, p[2]], [(Math.random() - 0.5) * 1.4, 3.4 + Math.random() * 2, (Math.random() - 0.5) * 1.4],
        5.5, 1.1, 5.5, [0.09, 0.09, 0.09], 0.5);
      if (Math.random() < 0.25) fx.lights.push({ pos: [p[0], p[1], p[2]], color: [3.4, 1.3, 0.4], radius: 16, age: 0, life: 0.3 });
    } else if (v.smoke && !v.dead) {
      if (Math.random() < 0.35) {
        fx.emit(TERRA.game.Effects.K.SMOKE, [v.pos[0], v.pos[1] + 1.9, v.pos[2]],
          [(Math.random() - 0.5) * 0.6, 2.4, (Math.random() - 0.5) * 0.6], 3.2, 0.6, 3, [0.3, 0.3, 0.3], 0.3);
      }
    }
  };

  P.update = function (frame) {
    var E = this.E, dt = Math.min(0.05, frame.dt), cam = frame.cam.world, pl = E.player;
    if (!this.maxVehicles) return;
    this._ambient(dt, cam);
    var alive = 0, wrecks = 0;
    for (var i = 0; i < this.list.length; i++) {
      var v = this.list[i];
      v._dist = Math.hypot(v.pos[0] - cam[0], v.pos[1] - cam[1], v.pos[2] - cam[2]);
      v.rpos[0] = v.pos[0] - E.origin[0]; v.rpos[1] = v.pos[1]; v.rpos[2] = v.pos[2] - E.origin[1];
      if (v.dead) wrecks++; else alive++;
      // LOD: far vehicles only fire, no steering detail
      var near = v._dist < 460;
      v.ai.think -= dt;
      if (!v.dead && v.ai.think <= 0) {
        v.ai.think = v._dist > 260 ? 0.35 : (1 / 60);
        this._think(v, v._dist > 260 ? 0.35 : dt, cam, pl);
      } else if (v.dead) {
        this._fires(v, dt);
      }
      if (near || v.dead) this._drive(v, dt, cam, pl);
      if (v.dirty) this._rebuild(v);
    }
    this.stats.alive = alive; this.stats.wrecks = wrecks;
  };

  /* ------------------------------------------------------------------ draws */
  P.draw = function (frame, shadow, vp) {
    if (!this.list.length) return;
    var gl = this.gl, R = this.E.renderer, o = frame.origin, planes = frame.cam.planes;
    var p = shadow ? this.progShadow.use() : this.prog.use();
    p.i('uShadowPass', shadow ? 1 : 0);
    if (shadow) p.m4('uShadowVP', vp);
    else {
      p.tex('uAlbedoH', 0, R.tex.matAlbedo, gl.TEXTURE_2D_ARRAY);
      if (this.quality >= 2) p.tex('uNormalR', 1, R.tex.matNormal, gl.TEXTURE_2D_ARRAY);
      else p.tex('uNormalR', 1, R.tex.black, gl.TEXTURE_2D_ARRAY);
    }
    var m4 = this._m;
    for (var i = 0; i < this.list.length; i++) {
      var v = this.list[i];
      if (!v.mesh) continue;
      if (shadow && v._dist > 420) continue;
      if (!shadow && v._dist > 900) continue;
      if (!M.sphereInFrustum(planes, v.pos[0] - o[0], v.pos[1] + v.K.height * 0.5, v.pos[2] - o[1], v.K.radius + 1.5, 0)) continue;
      this._mat(v, m4);
      p.m4('uModel', m4);
      if (!shadow) {
        var dmg = 1 - U.clamp01(v.hp / v.maxHp);
        var tint = 1 - dmg * 0.42 - (v.dead ? 0.25 : 0);
        p.f('uWet', frame.env.wetness).f('uSnow', frame.env.snowCover).f('uNight', 1 - frame.env.dayFactor)
          .v3('uSun', frame.env.lightDir[0], frame.env.lightDir[1], frame.env.lightDir[2])
          .v3('uTint', tint, tint * (1 - dmg * 0.12), tint * (1 - dmg * 0.24));
      }
      gl.bindVertexArray(v.mesh.vao);
      gl.drawElements(gl.TRIANGLES, v.mesh.count, v.mesh.indexType, 0);
      R.G.stats.drawCalls++; R.G.stats.triangles += v.mesh.tris;
    }
    gl.bindVertexArray(null);
  };
  P.drawShadow = function (frame, vp) { this.draw(frame, true, vp); };
  P.drawMotion = function () { /* heavy armour moves slowly: no motion vectors needed */ };

  /* --------------------------------------------------------- serialization */
  P.serialize = function () {
    var out = [];
    for (var i = 0; i < this.list.length; i++) {
      var v = this.list[i];
      if (v._dist > 900) continue;
      var parts = [];
      for (var k = 0; k < v.parts.length; k++) parts.push(Math.round(v.parts[k].hp));
      out.push({ k: v.kind, x: +v.pos[0].toFixed(2), z: +v.pos[2].toFixed(2), y: +v.yaw.toFixed(3),
        hp: Math.round(v.hp), dead: v.dead ? 1 : 0, br: v.burning > 0 ? 1 : 0, p: parts });
    }
    return out;
  };
  P.deserialize = function (data) {
    if (!data || !data.length) return;
    this.clear();
    for (var i = 0; i < data.length; i++) {
      var d = data[i];
      if (!KINDS[d.k]) continue;
      var v = this._mkVehicle(d.k, d.x, d.z, d.y || 0, 1, {});
      v.hp = d.hp === undefined ? v.maxHp : d.hp;
      if (d.p) for (var k = 0; k < v.parts.length && k < d.p.length; k++) {
        v.parts[k].hp = d.p[k];
        if (v.parts[k].hp <= 0) v.parts[k].destroyed = true;
      }
      if (d.br) v.burning = 600;
      if (d.dead) { v.dead = true; v.ai.state = 'wreck'; v.burning = 600; }
      this._rebuild(v);
      this.list.push(v);
    }
  };

  TERRA.game.GVehicles = GVehicles;
  TERRA.game.VEHICLE_KINDS = KINDS;
})();
