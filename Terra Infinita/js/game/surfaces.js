/* =============================================================================
 * TERRA INFINITA — ground surface physics (shared by the player, bikes, aircraft
 * wheels, tools and thrown objects)
 * -----------------------------------------------------------------------------
 * Every surface has a friction coefficient (mu), rolling resistance (rr), a
 * walking speed / acceleration multiplier, a "softness" (how deep footprints and
 * tyre ruts get) and a dust colour. Weather modifies them: rain makes grass,
 * rock and leaves slick, wet sand firmer, cold wet ground freezes into ice, and
 * standing puddles are slippery and splash.
 * ========================================================================== */
(function () {
  'use strict';
  var U = TERRA.util;

  var T = {
    grass:  { mu: 0.72, rr: 0.035, speed: 1.00, accel: 1.00, soft: 0.15, dust: [0.40, 0.38, 0.27], slip: 0.0 },
    leaves: { mu: 0.62, rr: 0.040, speed: 0.97, accel: 0.95, soft: 0.20, dust: [0.36, 0.29, 0.19], slip: 0.0 },
    path:   { mu: 0.78, rr: 0.022, speed: 1.02, accel: 1.00, soft: 0.35, dust: [0.55, 0.47, 0.36], slip: 0.0 },
    rock:   { mu: 0.85, rr: 0.016, speed: 0.95, accel: 1.00, soft: 0.00, dust: [0.55, 0.53, 0.50], slip: 0.0 },
    sand:   { mu: 0.55, rr: 0.140, speed: 0.80, accel: 0.75, soft: 0.80, dust: [0.80, 0.70, 0.52], slip: 0.0 },
    snow:   { mu: 0.32, rr: 0.070, speed: 0.72, accel: 0.70, soft: 1.00, dust: [0.93, 0.95, 0.98], slip: 0.2 },
    mud:    { mu: 0.38, rr: 0.110, speed: 0.68, accel: 0.60, soft: 0.90, dust: [0.30, 0.22, 0.15], slip: 0.3 },
    ice:    { mu: 0.09, rr: 0.010, speed: 0.90, accel: 0.22, soft: 0.00, dust: [0.86, 0.91, 0.96], slip: 0.85 },
    puddle: { mu: 0.45, rr: 0.060, speed: 0.90, accel: 0.80, soft: 0.40, dust: [0.55, 0.60, 0.62], slip: 0.25 },
    water:  { mu: 0.50, rr: 0.250, speed: 0.60, accel: 0.60, soft: 0.00, dust: [0.80, 0.85, 0.90], slip: 0.0 }
  };

  var Surfaces = { table: T };

  /** Name of the surface under a point. local = environment.local (biome info at the player). */
  Surfaces.classify = function (env, local, slope, waterDepth, puddle) {
    var B = TERRA.core.BIOME;
    if (waterDepth > 0.08) return 'water';
    var temp = local.temp;
    if (temp < -1.5 && env.wetness > 0.3 && slope < 0.25 && env.snowCover < 0.45) return 'ice';
    if (local.biome === B.GLACIER) return 'ice';
    if (env.snowCover > 0.35 && temp < 2) return 'snow';
    if (temp < -2.5 || local.biome === B.SNOWFIELD) return 'snow';
    if (puddle > 0.35) return temp < -1 ? 'ice' : 'puddle';
    if (local.biome === B.BEACH || local.biome === B.DESERT) return 'sand';
    if (local.biome === B.COLD_DESERT) return 'path';
    if (local.biome === B.WETLAND || local.biome === B.TROPICAL_SWAMP || (env.wetness > 0.6 && local.biome !== B.MOUNTAIN && slope < 0.5)) return 'mud';
    if (slope > 0.55 || local.biome === B.MOUNTAIN || local.biome === B.HIGH_MOUNTAIN || local.biome === B.VOLCANIC || local.biome === B.ROCKY_DESERT || local.biome === B.BADLANDS) return 'rock';
    if (local.path > 0.4) return 'path';
    if (local.forest > 0.4) return 'leaves';
    return 'grass';
  };

  /** Physical parameters of a surface with the current weather applied. */
  Surfaces.info = function (name, env, out) {
    var s = T[name] || T.grass, w = env.wetness || 0;
    out = out || {};
    out.name = name; out.soft = s.soft; out.dust = s.dust; out.slip = s.slip;
    var mu = s.mu, rr = s.rr, sp = s.speed, ac = s.accel;
    if (name === 'grass' || name === 'leaves' || name === 'path') { mu *= 1 - 0.3 * w; out.slip = Math.max(s.slip, w * 0.2); }
    else if (name === 'rock') { mu *= 1 - 0.32 * w; out.slip = w * 0.25; }
    else if (name === 'sand') { mu *= 1 + 0.15 * w; rr *= 1 - 0.4 * w; sp = U.mix(sp, 0.9, w * 0.6); ac = U.mix(ac, 0.9, w * 0.6); }
    else if (name === 'path' && w > 0.5) { rr *= 1 + w; }
    out.mu = mu; out.rr = rr; out.speed = sp; out.accel = ac;
    out.wet = w; out.dry = (1 - w) * (name === 'water' || name === 'puddle' || name === 'snow' || name === 'ice' ? 0 : 1);
    return out;
  };

  /** Rough CPU estimate of standing water in a depression (matches the terrain shader's
   *  puddles in spirit: flat, locally concave ground holds water while it rains). */
  Surfaces.puddleAt = function (E, x, z, env) {
    var lvl = env.puddles || 0;
    if (lvl < 0.05) return 0;
    var h = E.groundHeight(x, z), r = 1.6, s = 0;
    s += E.groundHeight(x + r, z) + E.groundHeight(x - r, z) + E.groundHeight(x, z + r) + E.groundHeight(x, z - r);
    var curv = s / 4 - h;                                   // > 0 in a hollow
    var slope = Math.abs(E.groundHeight(x + r, z) - E.groundHeight(x - r, z)) / (2 * r) + Math.abs(E.groundHeight(x, z + r) - E.groundHeight(x, z - r)) / (2 * r);
    var flat = U.smoothstep(0.08, 0.0, slope);
    var hollow = U.smoothstep(-0.01, 0.06, curv);
    var n = Math.sin(x * 0.37 + z * 0.21) * Math.sin(x * 0.13 - z * 0.29) * 0.5 + 0.5;   // patchiness
    return U.clamp01(flat * (hollow * 0.8 + n * 0.35) * (lvl * 1.4) - 0.15);
  };

  TERRA.game.Surfaces = Surfaces;
})();
