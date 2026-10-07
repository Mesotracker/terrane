/* =============================================================================
 * TERRA INFINITA — far-field terrain light (mountain shadows, valley sky occlusion)
 * -----------------------------------------------------------------------------
 * A 12 km height + albedo field around the camera is rasterised top-down from the
 * terrain chunks actually loaded. Two GPU passes then derive, per 24 m texel:
 *   r  shadow top   — the height above which the sun is visible (max over the sun
 *                     ray of h(t) − t·tan(elevation)); a point is lit when it is
 *                     above it, so the same value shadows terrain, trees, water and
 *                     the air (light shafts) — mountains cast shadows for kilometres
 *   g  occluder distance — drives a physically sized penumbra (sun disc 0.53°)
 *   b  sky visibility — horizon scan in 12 directions, cos²-weighted
 * Path tracing also marches this field (world-space rays to ~4 km) and shades the
 * hits from it (albedo × sun × shadow + sky × visibility): real bounce light from
 * sunlit mountain faces into shaded valleys.
 * ========================================================================== */
(function () {
  'use strict';
  var S = TERRA.shaders, L = S.lib;

  S.ffHeightVS = [
    '#include <frame>',
    'layout(location = 0) in vec3 aPos;',
    'layout(location = 2) in vec4 aNormal;',
    'layout(location = 3) in vec4 aClimate;',
    'layout(location = 4) in vec4 aSurface;',
    'uniform vec3 uNodeOffset; uniform vec4 uFFRect;   // xy origin (render space), z size',
    'out float vH; out vec3 vAlb;',
    'void main(){',
    '  vec3 p = aPos + uNodeOffset;',
    '  vec2 uv = (p.xz - uFFRect.xy) / uFFRect.z;',
    '  vH = p.y;',
    '  // large-scale ground tone from the vertex climate/surface data',
    '  vec3 N = normalize(aNormal.xyz); float slope = 1.0 - N.y;',
    '  float T = aClimate.x * 80.0 - 40.0, M = aClimate.y; float rock = aSurface.y, forest = aSurface.z, gully = aSurface.w;',
    '  vec3 a = mix(vec3(0.30, 0.26, 0.15), vec3(0.075, 0.12, 0.035), smoothstep(0.22, 0.5, M) * smoothstep(-3.0, 6.0, T));',
    '  a = mix(a, vec3(0.55, 0.47, 0.33), smoothstep(0.24, 0.12, M) * smoothstep(12.0, 20.0, T));',
    '  a = mix(a, vec3(0.045, 0.07, 0.035), smoothstep(0.25, 0.6, forest));',
    '  a = mix(a, vec3(0.2, 0.19, 0.18), smoothstep(0.3, 0.55, slope + rock * 0.15));',
    '  float snow = smoothstep(-0.5, -4.5, T + slope * 5.0 - gully * 3.5) * (1.0 - smoothstep(0.6, 0.9, slope));',
    '  snow = max(snow, uWeather.z * smoothstep(3.0, -1.0, T) * smoothstep(0.7, 0.3, slope));',
    '  vAlb = mix(a, vec3(0.8, 0.82, 0.86), snow);',
    '  // depth keeps the highest surface where nodes/skirts overlap',
    '  gl_Position = vec4(uv * 2.0 - 1.0, 0.999 - 0.998 * clamp((p.y + 2000.0) / 12000.0, 0.0, 1.0), 1.0);',
    '}'
  ].join('\n');

  S.ffHeightFS = [
    'in float vH; in vec3 vAlb;',
    'layout(location = 0) out vec4 oH; layout(location = 1) out vec4 oA;',
    'void main(){ oH = vec4(vH, 0.0, 0.0, 1.0); oA = vec4(vAlb, 1.0); }'
  ].join('\n');

  /* sun shadow top + occluder distance (writes r, g) */
  S.ffShadowFS = [
    'in vec2 vUv; out vec4 o;',
    'uniform sampler2D uH; uniform vec4 uFFRect; uniform vec3 uL; uniform float uTexel;',
    'void main(){',
    '  vec2 p = vUv * uFFRect.z;',
    '  vec3 L = normalize(vec3(uL.x, max(uL.y, 0.012), uL.z));',
    '  float lh = length(L.xz); vec2 d = lh > 1e-4 ? L.xz / lh : vec2(1.0, 0.0); float tanE = L.y / max(lh, 1e-4);',
    '  float top = -1e4, tOcc = 0.0;',
    '  float t = uTexel;',
    '  for (int i = 0; i < 110; i++) {',
    '    vec2 q = p + d * t;',
    '    if (q.x < 0.0 || q.y < 0.0 || q.x > uFFRect.z || q.y > uFFRect.z) break;',
    '    float c = textureLod(uH, q / uFFRect.z, 0.0).r - t * tanE - 1.5;',
    '    if (c > top) { top = c; tOcc = t; }',
    '    t += max(uTexel * 0.7, t * 0.05);',
    '    if (t * tanE > 7000.0) break;',
    '  }',
    '  o = vec4(top, tOcc, 0.0, 0.0);',
    '}'
  ].join('\n');

  /* sky visibility (writes b): horizon elevation in 12 azimuths, cos² of each */
  S.ffSkyFS = [
    'in vec2 vUv; out vec4 o;',
    'uniform sampler2D uH; uniform vec4 uFFRect; uniform float uTexel;',
    'void main(){',
    '  vec2 p = vUv * uFFRect.z; float h0 = textureLod(uH, vUv, 0.0).r + 2.0;',
    '  float vis = 0.0;',
    '  for (int a = 0; a < 12; a++) {',
    '    float ang = float(a) * 0.5235988 + 0.26;',
    '    vec2 d = vec2(cos(ang), sin(ang)); float mt = 0.0; float t = uTexel;',
    '    for (int i = 0; i < 26; i++) {',
    '      vec2 q = p + d * t;',
    '      if (q.x < 0.0 || q.y < 0.0 || q.x > uFFRect.z || q.y > uFFRect.z) break;',
    '      mt = max(mt, (textureLod(uH, q / uFFRect.z, 0.0).r - h0) / t);',
    '      t *= 1.2; if (t > 4000.0) break;',
    '    }',
    '    vis += 1.0 / (1.0 + mt * mt);',
    '  }',
    '  o = vec4(0.0, 0.0, vis / 12.0, 0.0);',
    '}'
  ].join('\n');

  /* Sampling chunk for lighting, volumetrics and water. */
  L.farfield = [
    'uniform sampler2D uFFTex; uniform vec4 uFF;   // far-field light: xy origin (render space), z size, w enabled',
    '/* x: sun visibility from distant terrain (soft, physically sized penumbra),',
    '   y: large-scale sky visibility (valleys, gorges, under cliffs). */',
    'vec2 farTerrainLight(vec3 wp){',
    '  if (uFF.w < 0.5) return vec2(1.0);',
    '  vec2 uv = (wp.xz - uFF.xy) / uFF.z;',
    '  vec2 e = min(uv, 1.0 - uv); float edge = smoothstep(0.0, 0.05, min(e.x, e.y));',
    '  if (edge <= 0.0) return vec2(1.0);',
    '  vec4 f = textureLod(uFFTex, uv, 0.0);',
    '  float pen = 2.5 + f.g * 0.0047;',
    '  float sun = smoothstep(-pen, pen, wp.y - f.r);',
    '  return mix(vec2(1.0), vec2(sun, f.b), edge);',
    '}'
  ].join('\n');

  /* World-space tracing chunk for the path tracer. */
  L.farfieldTrace = [
    'uniform sampler2D uFFH; uniform sampler2D uFFA;',
    '/* March a ray through the far height field (24 m texels, ~4 km). */',
    'float ffTrace(vec3 wp, vec3 dir, float t0, out vec3 hitP){',
    '  hitP = wp;',
    '  if (uFF.w < 0.5 || dir.y > 0.75) return 0.0;',
    '  float t = t0;',
    '  for (int i = 0; i < 24; i++) {',
    '    vec3 p = wp + dir * t; vec2 uv = (p.xz - uFF.xy) / uFF.z;',
    '    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0;',
    '    float h = textureLod(uFFH, uv, 0.0).r;',
    '    if (p.y < h) { hitP = vec3(p.x, h, p.z); return 1.0; }',
    '    t *= 1.2; if (t > 4500.0) break;',
    '  }',
    '  return 0.0; }',
    '/* Outgoing radiance of far-field terrain: albedo × (sun × N·L × shadow + sky × visibility). */',
    'vec3 ffRadiance(vec3 hp, vec3 skyE){',
    '  vec2 uv = (hp.xz - uFF.xy) / uFF.z; float e = 1.0 / float(textureSize(uFFH, 0).x);',
    '  float hl = textureLod(uFFH, uv - vec2(e, 0.0), 0.0).r, hr = textureLod(uFFH, uv + vec2(e, 0.0), 0.0).r;',
    '  float hd = textureLod(uFFH, uv - vec2(0.0, e), 0.0).r, hu = textureLod(uFFH, uv + vec2(0.0, e), 0.0).r;',
    '  vec3 N = normalize(vec3(hl - hr, 2.0 * uFF.z * e, hd - hu));',
    '  vec3 alb = textureLod(uFFA, uv, 0.0).rgb;',
    '  vec4 f = textureLod(uFFTex, uv, 0.0);',
    '  float sun = smoothstep(-6.0, 6.0, hp.y + 3.0 - f.r);',
    '  vec3 E = uSunColor.rgb * max(dot(N, uSunDir.xyz), 0.0) * sun / PI + skyE * f.b * (0.6 + 0.4 * N.y);',
    '  return alb * E; }'
  ].join('\n');
})();
