/* =============================================================================
 * TERRA INFINITA — default settings and graphics presets
 * (Stored as JS rather than JSON so they load from file:// without fetch())
 * ========================================================================== */
(function () {
  'use strict';
  var D = TERRA.data;

  D.defaultSettings = {
    graphics: {
      preset: 'high',
      resolutionScale: 1.0,
      dynamicResolution: true,
      autoQuality: true,        // step the preset down automatically if the frame rate stays low
      grass: true,              // grass blades (full ground cover in grassy areas)
      grassDensity: 1.0,
      parallax: true,           // parallax occlusion mapping on close terrain (Full PBR)
      pathTracing: 0,           // 0 off, 1 balanced (1 ray/px), 2 high (2), 3 ultra (4), 4 extreme (8), 5 reference (16)
      rtShadows: false,         // ray-traced soft sun shadows (screen + terrain height field)
      farShadows: true,         // distant terrain light: mountain shadows beyond the cascades, valley sky occlusion
      occlusionCulling: true,   // hierarchical-Z culling of vegetation hidden behind terrain/objects
      adaptiveLod: true,        // LOD distances follow the frame rate (smoothly)
      shadowCache: true,        // far shadow cascades are cached and refreshed every 2nd/4th frame
      weatherQuality: 2,        // 0..3 rain/snow particle density, splashes, puddle detail
      particleQuality: 2,       // 0..3 effect particles (explosions, wood chips, wakes, exhaust)
      physicsQuality: 2,        // 0..3 rigid-body step rate, body budget and activation radius
      combatDetail: 2,          // 0..3 soldiers alive, settlement density, decal budget, gore
      frameGen: 0,              // frame extrapolation multiplier: 0 off, 1.5, 2, 3, 4
      frameGenQuality: 1,       // 0 fast, 1 balanced, 2 quality (search iterations, hole filling)
      frameGenSensitivity: 1.0, // how far ahead motion is predicted (0.5 … 1.5)
      frameGenArtifacts: 0.6,   // artifact reduction strength (0 … 1)
      frameGenPerf: false,      // performance mode: half-resolution reprojection search
      photoreal: false,         // one-switch photoreal mode (path tracing + everything tuned for realism)
      targetFps: 60,
      performanceMode: false,
      renderDistance: 1.0,      // multiplier for terrain LOD ranges and max view distance
      terrainQuality: 2,        // 0 low … 3 ultra   (grid density & LOD factor)
      lodDistance: 1.0,         // extra multiplier on LOD split distances
      shadowQuality: 2,         // 0 off, 1 low, 2 medium, 3 high, 4 ultra
      textureQuality: 2,        // 0..3 → 256/512/1024/2048 material textures
      vegetationQuality: 2,     // 0..3
      waterQuality: 2,          // 0..3
      reflectionQuality: 2,     // 0 sky/probe only, 1 SSR low, 2 SSR high, 3 SSR + dynamic probe
      ambientOcclusion: 2,      // 0 off, 1 low, 2 high
      bloom: true,
      volumetrics: 1,           // 0 off, 1 low, 2 high (shadowed light shafts)
      fogQuality: 2,            // 0 simple, 1 height fog, 2 height + patchy volumetric
      cloudQuality: 2,          // 0 flat layer, 1 volumetric low, 2 medium, 3 high
      pbrQuality: 2,            // 0 basic, 1 standard, 2 full (anisotropic sampling, parallax-like height blend)
      microDetail: 2,           // 0 off, 1 low, 2 high
      antiAliasing: 3,          // 0 off, 1 FXAA, 2 FXAA + supersample (1.25×), 3 TAA, 4 TAA + supersample
      rtx: false,               // simulated RTX mode (master switch)
      rtxReflections: true,
      rtxGI: true,
      rtxContactShadows: true,
      rtxSoftShadows: true,
      reflectionProbes: true,
      dof: false,
      motionBlur: false,
      godRays: true,
      exposure: 0.0,
      contrast: 1.04,
      tonemap: 'aces',          // aces | agx
      saturation: 1.0,
      temperature: 0.0,
      vignette: 0.28,
      filmGrain: 0.02
    },
    controls: {
      sensitivity: 1.0,
      invertY: false,
      fov: 75,
      smoothing: 0.35,
      headBob: true,
      motionEffects: true,
      throwPreview: true,       // dotted arc while charging a throw
      cameraMode: 'first'       // first | third | free
    },
    audio: { master: 0.8, ambience: 0.8, effects: 0.8, muted: false },
    ui: { showFps: true, showStats: true, showHud: true, showCompass: true, debug: false }
  };

  /** One-switch photoreal mode (key T / Settings → Graphics). Texture quality is left alone
   *  (changing it rebuilds every material); everything else is set for maximum realism. */
  D.photorealBundle = {
    pathTracing: 2, rtShadows: true, antiAliasing: 3, shadowQuality: 4, cloudQuality: 3, volumetrics: 2,
    fogQuality: 2, pbrQuality: 2, microDetail: 2, parallax: true, reflectionQuality: 3, reflectionProbes: true,
    rtx: true, rtxReflections: true, rtxGI: true, rtxContactShadows: true, rtxSoftShadows: true, ambientOcclusion: 2,
    bloom: true, godRays: true, grass: true, dynamicResolution: true, farShadows: true,
    vignette: 0.16, filmGrain: 0.012, contrast: 1.04, saturation: 0.96, tonemap: 'agx'
  };

  /** Graphics presets. Only the listed keys are applied. */
  D.graphicsPresets = {
    low: {
      resolutionScale: 0.75, renderDistance: 0.7, terrainQuality: 0, lodDistance: 0.8, shadowQuality: 1, textureQuality: 1,
      vegetationQuality: 0, waterQuality: 1, reflectionQuality: 0, ambientOcclusion: 0, bloom: true, volumetrics: 0,
      fogQuality: 1, cloudQuality: 0, pbrQuality: 0, microDetail: 0, antiAliasing: 1, rtx: false, dof: false, motionBlur: false, godRays: false, pathTracing: 0, farShadows: false,
      weatherQuality: 0, particleQuality: 0, physicsQuality: 1, combatDetail: 1
    },
    medium: {
      resolutionScale: 0.9, renderDistance: 0.85, terrainQuality: 1, lodDistance: 0.9, shadowQuality: 2, textureQuality: 1,
      vegetationQuality: 1, waterQuality: 1, reflectionQuality: 1, ambientOcclusion: 1, bloom: true, volumetrics: 0,
      fogQuality: 1, cloudQuality: 1, pbrQuality: 1, microDetail: 1, antiAliasing: 3, rtx: false, dof: false, motionBlur: false, godRays: true, pathTracing: 0, farShadows: true,
      weatherQuality: 1, particleQuality: 1, physicsQuality: 2, combatDetail: 1
    },
    high: {
      resolutionScale: 1.0, renderDistance: 1.0, terrainQuality: 2, lodDistance: 1.0, shadowQuality: 3, textureQuality: 2,
      vegetationQuality: 2, waterQuality: 2, reflectionQuality: 2, ambientOcclusion: 2, bloom: true, volumetrics: 1,
      fogQuality: 2, cloudQuality: 2, pbrQuality: 2, microDetail: 2, antiAliasing: 3, rtx: false, dof: false, motionBlur: false, godRays: true, pathTracing: 0, farShadows: true,
      weatherQuality: 2, particleQuality: 2, physicsQuality: 2, combatDetail: 2
    },
    veryhigh: {
      resolutionScale: 1.0, renderDistance: 1.2, terrainQuality: 3, lodDistance: 1.1, shadowQuality: 4, textureQuality: 2,
      vegetationQuality: 3, waterQuality: 3, reflectionQuality: 2, ambientOcclusion: 2, bloom: true, volumetrics: 2,
      fogQuality: 2, cloudQuality: 3, pbrQuality: 2, microDetail: 2, antiAliasing: 3, rtx: false, dof: false, motionBlur: false, godRays: true, pathTracing: 0, farShadows: true,
      weatherQuality: 3, particleQuality: 3, physicsQuality: 2, combatDetail: 3
    },
    ultra: {
      resolutionScale: 1.0, renderDistance: 1.3, terrainQuality: 3, lodDistance: 1.2, shadowQuality: 4, textureQuality: 3,
      vegetationQuality: 3, waterQuality: 3, reflectionQuality: 3, ambientOcclusion: 2, bloom: true, volumetrics: 2,
      fogQuality: 2, cloudQuality: 3, pbrQuality: 2, microDetail: 2, antiAliasing: 3, rtx: true, dof: false, motionBlur: false, godRays: true, pathTracing: 1,
      weatherQuality: 3, particleQuality: 3, physicsQuality: 3, combatDetail: 3
    },
    cinematic: {
      resolutionScale: 1.25, renderDistance: 1.5, terrainQuality: 3, lodDistance: 1.4, shadowQuality: 4, textureQuality: 3,
      vegetationQuality: 3, waterQuality: 3, reflectionQuality: 3, ambientOcclusion: 2, bloom: true, volumetrics: 2,
      fogQuality: 2, cloudQuality: 3, pbrQuality: 2, microDetail: 2, antiAliasing: 4, rtx: true, dof: true, motionBlur: true, godRays: true, pathTracing: 4, rtShadows: true,
      vignette: 0.35, filmGrain: 0.035, contrast: 1.08, tonemap: 'agx',
      weatherQuality: 3, particleQuality: 3, physicsQuality: 3, combatDetail: 3
    }
  };

  /** Weather definitions: target values the weather system blends toward. */
  D.weatherTypes = {
    clear:        { name: 'Clear',          cloud: 0.12, rain: 0, snow: 0, fog: 0.00, wind: 0.25, storm: 0, dust: 0, lightning: 0 },
    partlyCloudy: { name: 'Partly Cloudy',  cloud: 0.42, rain: 0, snow: 0, fog: 0.02, wind: 0.35, storm: 0, dust: 0, lightning: 0 },
    overcast:     { name: 'Overcast',       cloud: 0.85, rain: 0, snow: 0, fog: 0.10, wind: 0.40, storm: 0.25, dust: 0, lightning: 0 },
    lightRain:    { name: 'Light Rain',     cloud: 0.80, rain: 0.35, snow: 0, fog: 0.15, wind: 0.40, storm: 0.35, dust: 0, lightning: 0 },
    heavyRain:    { name: 'Heavy Rain',     cloud: 0.95, rain: 0.8, snow: 0, fog: 0.30, wind: 0.60, storm: 0.6, dust: 0, lightning: 0.05 },
    storm:        { name: 'Storm',          cloud: 1.00, rain: 0.9, snow: 0, fog: 0.35, wind: 0.85, storm: 0.85, dust: 0, lightning: 0.25 },
    thunderstorm: { name: 'Thunderstorm',   cloud: 1.00, rain: 1.0, snow: 0, fog: 0.35, wind: 0.95, storm: 1.0, dust: 0, lightning: 1.0 },
    fog:          { name: 'Fog',            cloud: 0.55, rain: 0, snow: 0, fog: 0.60, wind: 0.05, storm: 0.1, dust: 0, lightning: 0 },
    denseFog:     { name: 'Dense Fog',      cloud: 0.75, rain: 0, snow: 0, fog: 1.00, wind: 0.02, storm: 0.15, dust: 0, lightning: 0 },
    snow:         { name: 'Snow',           cloud: 0.90, rain: 0, snow: 0.6, fog: 0.25, wind: 0.30, storm: 0.3, dust: 0, lightning: 0 },
    blizzard:     { name: 'Blizzard',       cloud: 1.00, rain: 0, snow: 1.0, fog: 0.70, wind: 1.00, storm: 0.7, dust: 0, lightning: 0 },
    windy:        { name: 'Windy',          cloud: 0.35, rain: 0, snow: 0, fog: 0.02, wind: 0.95, storm: 0.05, dust: 0.1, lightning: 0 },
    sandstorm:    { name: 'Sandstorm',      cloud: 0.35, rain: 0, snow: 0, fog: 0.75, wind: 1.00, storm: 0.2, dust: 1.0, lightning: 0 }
  };
  D.weatherOrder = ['clear', 'partlyCloudy', 'overcast', 'lightRain', 'heavyRain', 'storm', 'thunderstorm', 'fog', 'denseFog', 'snow', 'blizzard', 'windy', 'sandstorm'];

  /** Terrain material layers (texture array indices). Shared by texgen, shaders, editor. */
  D.materials = [
    { id: 0, key: 'grass', name: 'Grass' },
    { id: 1, key: 'drygrass', name: 'Dry Grass' },
    { id: 2, key: 'dirt', name: 'Dirt' },
    { id: 3, key: 'rock', name: 'Rock' },
    { id: 4, key: 'cliff', name: 'Layered Cliff' },
    { id: 5, key: 'sand', name: 'Sand' },
    { id: 6, key: 'snow', name: 'Snow' },
    { id: 7, key: 'gravel', name: 'Gravel' },
    { id: 8, key: 'forest', name: 'Forest Floor' },
    { id: 9, key: 'mud', name: 'Mud' },
    { id: 10, key: 'volcanic', name: 'Volcanic Rock' },
    { id: 11, key: 'moss', name: 'Moss / Tundra' },
    { id: 12, key: 'ice', name: 'Ice' },
    { id: 13, key: 'bark', name: 'Bark' },
    { id: 14, key: 'wood', name: 'Wood Planks' },
    { id: 15, key: 'stone', name: 'Cut Stone' }
  ];
})();
