/* =============================================================================
 * TERRA INFINITA — settings, world generation, weather/time and editor panels
 * Built from small declarative schemas so every control stays in sync.
 * ========================================================================== */
(function () {
  'use strict';
  var U = TERRA.util, D = TERRA.data;
  function $(id) { return document.getElementById(id); }
  var E, ui;
  var refreshers = {};

  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }
  function title(parent, t) { parent.appendChild(el('div', 'section-title', t)); }
  function note(parent, t) { var n = el('div', 'note', t); parent.appendChild(n); return n; }

  /** Range slider row. get/set operate on the model; fmt formats the value label. */
  function range(parent, label, get, set, min, max, step, fmt, live) {
    var row = el('div', 'row-ctl');
    var lb = el('label', '', label);
    var inp = document.createElement('input'); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step;
    var val = el('span', 'val');
    fmt = fmt || function (v) { return (+v).toFixed(step < 1 ? (step < 0.1 ? 2 : 1) : 0); };
    function sync() { var v = get(); inp.value = v; val.textContent = fmt(v); }
    inp.addEventListener('input', function () { val.textContent = fmt(+inp.value); if (live !== false) set(+inp.value); });
    inp.addEventListener('change', function () { set(+inp.value); });
    row.appendChild(lb); row.appendChild(inp); row.appendChild(val);
    parent.appendChild(row);
    sync();
    return sync;
  }
  function toggle(parent, label, get, set) {
    var row = el('div', 'row-ctl toggle-row');
    row.appendChild(el('label', '', label));
    var t = el('label', 'toggle'); var inp = document.createElement('input'); inp.type = 'checkbox'; var sp = el('span');
    t.appendChild(inp); t.appendChild(sp); row.appendChild(t);
    inp.addEventListener('change', function () { set(inp.checked); });
    parent.appendChild(row);
    function sync() { inp.checked = !!get(); }
    sync();
    return sync;
  }
  function select(parent, label, options, get, set) {
    var row = el('div', 'row-ctl');
    row.style.gridTemplateColumns = '1fr 1.3fr';
    row.appendChild(el('label', '', label));
    var s = document.createElement('select');
    options.forEach(function (o) { var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; s.appendChild(op); });
    s.addEventListener('change', function () { set(isNaN(+s.value) || s.value === '' ? s.value : +s.value); });
    row.appendChild(s);
    parent.appendChild(row);
    function sync() { s.value = String(get()); }
    sync();
    return sync;
  }
  function buttons(parent, list, cls) {
    var g = el('div', cls || 'btn-grid');
    list.forEach(function (b) { var bt = el('button', 'btn' + (b.cls ? ' ' + b.cls : ''), b.label); bt.onclick = b.fn; if (b.id) bt.id = b.id; if (b.title) bt.title = b.title; g.appendChild(bt); });
    parent.appendChild(g);
    return g;
  }
  var Q4 = [[0, 'Low'], [1, 'Medium'], [2, 'High'], [3, 'Ultra']];

  /* ================= SETTINGS ================= */
  function buildSettings() {
    var body = $('settingsBody'), tabs = $('settingsTabs');
    var g = function () { return E.settings.graphics; };
    var syncs = [];
    function gset(key, needsRebuild) { return function (v) { g()[key] = v; if (key !== 'preset') g().preset = 'custom'; E.applyGraphics(); if (needsRebuild) needsRebuild(v); }; }
    function gget(key) { return function () { return g()[key]; }; }
    var pages = {};
    function page(name) { var p = el('div'); p.dataset.page = name; pages[name] = p; body.appendChild(p); return p; }

    // ---- graphics
    var pg = page('graphics');
    title(pg, 'Path tracing');
    syncs.push(toggle(pg, 'Path tracing — photoreal mode (key T)', function () { return !!g().photoreal; }, function (v) { E.setPhotoreal(!!v); }));
    note(pg, 'Turns on path-traced global illumination and reflections, ray-traced soft sun shadows and every realism setting at once. Turning it off restores your previous settings. Demanding: best on fast GPUs; on laptops dynamic resolution keeps it playable.');
    title(pg, 'Preset');
    var pr = el('div', 'preset-row');
    var PRESET_NAMES = { low: 'Low', medium: 'Medium', high: 'High', veryhigh: 'Very High', ultra: 'Ultra', cinematic: 'Cinematic' };
    ['low', 'medium', 'high', 'veryhigh', 'ultra', 'cinematic'].forEach(function (k) {
      var b = el('button', 'btn', PRESET_NAMES[k]);
      b.onclick = function () {
        var prevTex = g().textureQuality;
        U.deepMerge(g(), D.graphicsPresets[k]); g().preset = k; g().performanceMode = false;
        E.applyGraphics(); syncAll(); TERRA.ui.toast('Graphics preset: ' + b.textContent);
        if (g().textureQuality !== prevTex) rebuildTextures();
      };
      b.dataset.preset = k; pr.appendChild(b);
    });
    pg.appendChild(pr);
    var customNote = note(pg, '');
    syncs.push(function () { if (customNote) customNote.textContent = g().preset === 'custom' ? 'Current: Custom (individual settings changed)' : 'Current: ' + (PRESET_NAMES[g().preset] || g().preset); });
    syncs.push(toggle(pg, 'Performance mode (prioritise frame rate)', gget('performanceMode'), function (v) { g().performanceMode = v; E.applyGraphics(); }));
    title(pg, 'Resolution');
    syncs.push(range(pg, 'Resolution scale', gget('resolutionScale'), gset('resolutionScale'), 0.5, 2, 0.05, function (v) { return Math.round(v * 100) + '%'; }));
    syncs.push(toggle(pg, 'Dynamic resolution', gget('dynamicResolution'), gset('dynamicResolution')));
    syncs.push(toggle(pg, 'Automatic quality (lower preset if frame rate stays low)', function () { return g().autoQuality !== false; }, function (v) { g().autoQuality = v; E.applyGraphics(); }));
    syncs.push(select(pg, 'Target frame rate', [[30, '30 FPS'], [45, '45 FPS'], [60, '60 FPS'], [90, '90 FPS'], [120, '120 FPS']], gget('targetFps'), gset('targetFps')));
    syncs.push(select(pg, 'Anti-aliasing', [[0, 'Off'], [1, 'FXAA'], [2, 'FXAA + 1.25× supersampling'], [3, 'TAA (temporal)'], [4, 'TAA + 1.25× supersampling']], gget('antiAliasing'), gset('antiAliasing')));
    title(pg, 'Frame Extrapolation');
    note(pg, 'Generates extra frames between real frames by re-projecting the last frame with depth, camera motion and the motion of moving objects (vehicles, thrown objects). Movement looks smoother; the game still simulates every displayed frame, but only the native frames are fully rendered — the counter shows both. Generated frames can only be seen if your display refreshes faster than the native frame rate (e.g. 30 native → 60 shown on a 60 Hz screen). Adds no input latency for camera turning; turn it off if you prefer only native frames.');
    syncs.push(select(pg, 'Frame extrapolation', [[0, 'Off (native frames only)'], [1.5, '1.5× FPS'], [2, '2× FPS'], [3, '3× FPS'], [4, '4× FPS']], function () { return +g().frameGen || 0; }, gset('frameGen')));
    syncs.push(select(pg, 'Extrapolation quality', [[0, 'Fast'], [1, 'Balanced'], [2, 'Quality']], function () { return g().frameGenQuality === undefined ? 1 : g().frameGenQuality; }, gset('frameGenQuality')));
    syncs.push(range(pg, 'Motion sensitivity', function () { return g().frameGenSensitivity || 1; }, gset('frameGenSensitivity'), 0.5, 1.5, 0.05, function (v) { return Math.round(v * 100) + '%'; }));
    syncs.push(range(pg, 'Artifact reduction', function () { return g().frameGenArtifacts === undefined ? 0.6 : g().frameGenArtifacts; }, gset('frameGenArtifacts'), 0, 1, 0.05, function (v) { return Math.round(v * 100) + '%'; }));
    syncs.push(toggle(pg, 'Extrapolation performance mode (fewer search steps, no sharpening)', function () { return !!g().frameGenPerf; }, gset('frameGenPerf')));
    title(pg, 'World detail');
    syncs.push(range(pg, 'Render distance', gget('renderDistance'), gset('renderDistance'), 0.4, 3, 0.05, function (v) { return Math.round(24 * v) + 'km'; }));
    syncs.push(select(pg, 'Terrain quality', Q4, gget('terrainQuality'), gset('terrainQuality')));
    syncs.push(range(pg, 'LOD distance', gget('lodDistance'), gset('lodDistance'), 0.6, 2, 0.05, function (v) { return v.toFixed(2) + '×'; }));
    syncs.push(select(pg, 'Vegetation quality', Q4, gget('vegetationQuality'), gset('vegetationQuality')));
    syncs.push(toggle(pg, 'Adaptive LOD (detail distance follows the frame rate)', function () { return g().adaptiveLod !== false; }, gset('adaptiveLod')));
    syncs.push(toggle(pg, 'Occlusion culling (skip trees hidden behind hills & objects)', function () { return g().occlusionCulling !== false; }, gset('occlusionCulling')));
    syncs.push(toggle(pg, 'Grass blades (full ground cover)', function () { return g().grass !== false; }, gset('grass')));
    syncs.push(range(pg, 'Grass density', function () { return g().grassDensity || 1; }, gset('grassDensity'), 0.4, 1.6, 0.05, function (v) { return Math.round(v * 100) + '%'; }));
    syncs.push(select(pg, 'Texture quality', [[0, 'Low (256)'], [1, 'Medium (512)'], [2, 'High (1024)'], [3, 'Ultra (1024 + 16× aniso, 1K foliage)']], gget('textureQuality'), function (v) { g().textureQuality = v; g().preset = 'custom'; E.save.saveSettings(E.settings); rebuildTextures(); }));
    syncs.push(select(pg, 'Microtexture detail', [[0, 'Off'], [1, 'Low'], [2, 'High']], gget('microDetail'), gset('microDetail')));
    syncs.push(select(pg, 'PBR material quality', [[0, 'Basic (2 layers)'], [1, 'Standard (3 layers)'], [2, 'Full (4 layers, triplanar)']], gget('pbrQuality'), gset('pbrQuality')));
    syncs.push(toggle(pg, 'Parallax occlusion (terrain relief, Full PBR)', function () { return g().parallax !== false; }, gset('parallax')));
    title(pg, 'Lighting & atmosphere');
    syncs.push(select(pg, 'Shadow quality', [[0, 'Off'], [1, 'Low'], [2, 'Medium'], [3, 'High'], [4, 'Ultra']], gget('shadowQuality'), gset('shadowQuality')));
    syncs.push(toggle(pg, 'Cache far shadow cascades (faster, same quality)', function () { return g().shadowCache !== false; }, gset('shadowCache')));
    syncs.push(select(pg, 'Cloud quality', [[0, 'Flat layer'], [1, 'Volumetric low'], [2, 'Volumetric medium'], [3, 'Volumetric high']], gget('cloudQuality'), gset('cloudQuality')));
    syncs.push(select(pg, 'Water quality', Q4, gget('waterQuality'), gset('waterQuality')));
    syncs.push(select(pg, 'Weather quality', Q4, function () { return g().weatherQuality === undefined ? 2 : g().weatherQuality; }, gset('weatherQuality')));
    syncs.push(select(pg, 'Particle quality', Q4, function () { return g().particleQuality === undefined ? 2 : g().particleQuality; }, gset('particleQuality')));
    syncs.push(select(pg, 'Physics quality', Q4, function () { return g().physicsQuality === undefined ? 2 : g().physicsQuality; }, gset('physicsQuality')));
    syncs.push(select(pg, 'Fog quality', [[0, 'Simple'], [1, 'Height fog'], [2, 'Height + patchy volumetric']], gget('fogQuality'), gset('fogQuality')));

    // ---- effects & RTX
    var pe = page('effects');
    title(pe, 'Path tracing');
    note(pe, 'Path tracing: every pixel traces 1–16 stratified diffuse rays plus a glossy ray — through the depth buffer, then the 1 m terrain height field, then a 12 km world-space terrain field whose hits are shaded with sun, mountain shadows and sky (real bounce light off sunlit slopes). Bounces accumulate over frames and are denoised. Replaces SSAO, SSR and ambient light. 8 and 16 rays per pixel are for fast GPUs and screenshots.');
    syncs.push(select(pe, 'Path-traced lighting', [[0, 'Off'], [1, 'Balanced (1 ray / pixel)'], [2, 'High (2 rays / pixel)'], [3, 'Ultra (4 rays / pixel)'], [4, 'Extreme (8 rays / pixel)'], [5, 'Reference (16 rays / pixel)']], function () { return g().pathTracing | 0; }, gset('pathTracing')));
    syncs.push(toggle(pe, 'Ray-traced soft sun shadows', function () { return !!g().rtShadows; }, gset('rtShadows')));
    syncs.push(toggle(pe, 'Distant mountain shadows & valley sky occlusion', function () { return g().farShadows !== false; }, gset('farShadows')));
    title(pe, 'Simulated RTX mode');
    note(pe, 'Browser WebGL has no hardware ray tracing. This mode approximates it with screen-space reflections, one-bounce screen-space global illumination, contact shadows, softer shadows and a dynamic reflection probe.');
    syncs.push(toggle(pe, 'Enable simulated RTX', gget('rtx'), gset('rtx')));
    syncs.push(toggle(pe, 'Ray-traced-style reflections (SSR)', gget('rtxReflections'), gset('rtxReflections')));
    syncs.push(toggle(pe, 'Global illumination (light bounce)', gget('rtxGI'), gset('rtxGI')));
    syncs.push(toggle(pe, 'Contact shadows', gget('rtxContactShadows'), gset('rtxContactShadows')));
    syncs.push(toggle(pe, 'Soft shadow approximation', gget('rtxSoftShadows'), gset('rtxSoftShadows')));
    syncs.push(toggle(pe, 'Dynamic reflection probe', gget('reflectionProbes'), gset('reflectionProbes')));
    title(pe, 'Screen-space effects');
    syncs.push(select(pe, 'Reflections (non-RTX)', [[0, 'Sky only'], [1, 'SSR low'], [2, 'SSR high'], [3, 'SSR + probe']], gget('reflectionQuality'), gset('reflectionQuality')));
    syncs.push(select(pe, 'Ambient occlusion', [[0, 'Off'], [1, 'SSAO low'], [2, 'SSAO high']], gget('ambientOcclusion'), gset('ambientOcclusion')));
    syncs.push(select(pe, 'Volumetric light', [[0, 'Off'], [1, 'Low'], [2, 'High']], gget('volumetrics'), gset('volumetrics')));
    syncs.push(toggle(pe, 'God rays / light shafts', gget('godRays'), gset('godRays')));
    syncs.push(toggle(pe, 'Bloom', gget('bloom'), gset('bloom')));
    syncs.push(toggle(pe, 'Depth of field', gget('dof'), gset('dof')));
    syncs.push(toggle(pe, 'Motion blur', gget('motionBlur'), gset('motionBlur')));
    title(pe, 'Camera & colour grading');
    syncs.push(range(pe, 'Exposure', gget('exposure'), gset('exposure'), -2, 2, 0.05, function (v) { return (v > 0 ? '+' : '') + v.toFixed(1) + 'EV'; }));
    syncs.push(select(pe, 'Tone mapping', [['aces', 'ACES filmic (punchy)'], ['agx', 'AgX (natural, camera-like)']], function () { return g().tonemap || 'aces'; }, gset('tonemap')));
    syncs.push(range(pe, 'Contrast', gget('contrast'), gset('contrast'), 0.8, 1.3, 0.01));
    syncs.push(range(pe, 'Saturation', gget('saturation'), gset('saturation'), 0.5, 1.5, 0.01));
    syncs.push(range(pe, 'Colour temperature', gget('temperature'), gset('temperature'), -1, 1, 0.05));
    syncs.push(range(pe, 'Vignette', gget('vignette'), gset('vignette'), 0, 0.8, 0.01));
    syncs.push(range(pe, 'Film grain', gget('filmGrain'), gset('filmGrain'), 0, 0.1, 0.005, function (v) { return (v * 100).toFixed(1); }));

    // ---- controls
    var pc = page('controls');
    var c = function () { return E.settings.controls; };
    function cset(k) { return function (v) { c()[k] = v; E.save.saveSettings(E.settings); }; }
    function cget(k) { return function () { return c()[k]; }; }
    title(pc, 'Mouse & camera');
    syncs.push(range(pc, 'Mouse sensitivity', cget('sensitivity'), cset('sensitivity'), 0.2, 3, 0.05));
    syncs.push(toggle(pc, 'Invert Y axis', cget('invertY'), cset('invertY')));
    syncs.push(range(pc, 'Field of view', cget('fov'), cset('fov'), 55, 110, 1, function (v) { return v + '°'; }));
    syncs.push(range(pc, 'Camera smoothing', cget('smoothing'), cset('smoothing'), 0, 0.9, 0.05));
    syncs.push(toggle(pc, 'Head bob', cget('headBob'), cset('headBob')));
    syncs.push(toggle(pc, 'Motion effects (sprint FOV, lean)', cget('motionEffects'), cset('motionEffects')));
    syncs.push(toggle(pc, 'Throw trajectory preview', function () { return E.settings.controls.throwPreview !== false; }, cset('throwPreview')));
    syncs.push(select(pc, 'Default camera', [['first', 'First person'], ['third', 'Third person'], ['free', 'Free camera']], cget('cameraMode'), function (v) { c().cameraMode = v; E.player.mode = v; E.save.saveSettings(E.settings); }));

    // ---- audio
    var pa = page('audio');
    var a = function () { return E.settings.audio; };
    function aset(k) { return function (v) { a()[k] = v; E.audio.apply(a()); E.save.saveSettings(E.settings); }; }
    syncs.push(range(pa, 'Master volume', function () { return a().master; }, aset('master'), 0, 1, 0.01, function (v) { return Math.round(v * 100); }));
    syncs.push(range(pa, 'Ambience', function () { return a().ambience; }, aset('ambience'), 0, 1, 0.01, function (v) { return Math.round(v * 100); }));
    syncs.push(range(pa, 'Effects & footsteps', function () { return a().effects; }, aset('effects'), 0, 1, 0.01, function (v) { return Math.round(v * 100); }));
    syncs.push(toggle(pa, 'Mute', function () { return a().muted; }, aset('muted')));
    note(pa, 'All sounds are synthesised in real time: wind, rain, thunder, rivers, surf, birds, insects and surface-specific footsteps.');

    // ---- interface
    var pi = page('interface');
    var uu = function () { return E.settings.ui; };
    syncs.push(toggle(pi, 'Show FPS counter', function () { return uu().showFps; }, function (v) { uu().showFps = v; E.save.saveSettings(E.settings); }));
    syncs.push(toggle(pi, 'Show performance statistics (frame time, CPU/GPU, memory, chunks)', function () { return uu().showStats !== false; }, function (v) { uu().showStats = v; E.save.saveSettings(E.settings); }));
    syncs.push(toggle(pi, 'Show HUD (H)', function () { return ui.hudVisible; }, function () { ui.toggleHUD(); }));
    syncs.push(toggle(pi, 'Debug overlay (F3)', function () { return ui.debugOpen; }, function () { ui.toggleDebug(); }));
    buttons(pi, [{ label: 'Reset all settings', cls: 'danger', fn: function () { E.settings = U.deepClone(D.defaultSettings); E.applyGraphics(); E.audio.apply(E.settings.audio); syncAll(); TERRA.ui.toast('Settings reset'); } }]);

    function show(name) {
      for (var k in pages) pages[k].classList.toggle('hidden', k !== name);
      tabs.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === name); });
    }
    tabs.querySelectorAll('.tab').forEach(function (t) { t.onclick = function () { show(t.dataset.tab); }; });
    show('graphics');
    function syncAll() {
      syncs.forEach(function (s) { s(); });
      pr.querySelectorAll('.btn').forEach(function (b) { b.classList.toggle('active', b.dataset.preset === g().preset); });
    }
    refreshers.settingsPanel = syncAll;
    syncAll();
  }
  function rebuildTextures() {
    if (!E.gpuReady) return;
    TERRA.ui.toast('Regenerating materials…');
    var tg = new TERRA.gfx.TexGen(E.G);
    tg.generate(E.settings.graphics.textureQuality).then(function () {
      E.texgen = tg; E._texQuality = E.settings.graphics.textureQuality;
      var R = E.renderer;
      R.tex.matAlbedo = tg.materials.albedoH; R.tex.matNormal = tg.materials.normalR; R.tex.noise = tg.noise; R.tex.cloudNoise = tg.cloudNoise;
      R.tex.foliage = tg.foliage.color; R.tex.foliageN = tg.foliage.normal;
      TERRA.ui.toast('Materials updated');
    });
  }

  /* ================= WORLD GENERATION ================= */
  var WORLD_PARAMS = [
    ['Terrain', [['terrainScale', 'Terrain scale', 0.5, 2.5, 0.05], ['terrainDetail', 'Terrain detail', 0, 2, 0.05], ['roughness', 'Terrain roughness', 0, 1, 0.01], ['erosion', 'Erosion strength', 0, 1, 0.01]]],
    ['Mountains', [['mountainFrequency', 'Mountain frequency', 0, 1, 0.01], ['mountainHeight', 'Mountain height', 0.2, 2, 0.05]]],
    ['Water', [['oceanCoverage', 'Ocean coverage', 0.05, 0.85, 0.01], ['waterLevel', 'Sea level offset (m)', -60, 60, 1], ['riverFrequency', 'River frequency', 0, 1, 0.01], ['lakeFrequency', 'Lake frequency', 0, 1, 0.01]]],
    ['Climate & biomes', [['biomeSize', 'Biome size', 0.3, 3, 0.05], ['temperature', 'Temperature', -1, 1, 0.01], ['moisture', 'Moisture', -1, 1, 0.01]]],
    ['Life & features', [['vegetationDensity', 'Vegetation density', 0, 2, 0.05], ['forestDensity', 'Forest density', 0, 2, 0.05], ['rockDensity', 'Rock density', 0, 3, 0.05], ['caveFrequency', 'Caves & arches', 0, 1, 0.01], ['landmarkFrequency', 'Landmarks & POIs', 0, 1, 0.01]]]
  ];
  function buildWorld() {
    var body = $('worldBody');
    var draft = {};
    var syncs = [];
    function cur() { var d = TERRA.core.DEFAULT_PARAMS, p = E.worldParams || {}, o = {}; for (var k in d) o[k] = p[k] !== undefined ? p[k] : d[k]; return o; }
    title(body, 'Seed');
    var sr = el('div', 'seed-row');
    var si = document.createElement('input'); si.type = 'text'; si.spellcheck = false; sr.appendChild(si);
    var rb = el('button', 'icon-btn', '⟳'); rb.title = 'Randomize'; rb.onclick = function () { si.value = U.randomSeedString(); }; sr.appendChild(rb);
    var cb = el('button', 'icon-btn', '⧉'); cb.title = 'Copy'; cb.onclick = function () { if (navigator.clipboard) navigator.clipboard.writeText(si.value); TERRA.ui.toast('Seed copied'); }; sr.appendChild(cb);
    body.appendChild(sr);
    note(body, 'The same seed and parameters always recreate exactly the same world.');
    WORLD_PARAMS.forEach(function (sec) {
      title(body, sec[0]);
      sec[1].forEach(function (p) {
        syncs.push(range(body, p[1], function () { return draft[p[0]] !== undefined ? draft[p[0]] : cur()[p[0]]; }, function (v) { draft[p[0]] = v; }, p[2], p[3], p[4]));
      });
    });
    title(body, 'Streaming');
    syncs.push(range(body, 'Chunk render distance', function () { return E.settings.graphics.renderDistance; }, function (v) { E.settings.graphics.renderDistance = v; E.applyGraphics(); }, 0.4, 2, 0.05, function (v) { return Math.round(24 * v) + 'km'; }));
    syncs.push(range(body, 'LOD distance', function () { return E.settings.graphics.lodDistance; }, function (v) { E.settings.graphics.lodDistance = v; E.applyGraphics(); }, 0.6, 2, 0.05, function (v) { return v.toFixed(2) + '×'; }));
    note(body, 'Generation parameters take effect when you apply them (the world regenerates; your editor changes are kept).');
    buttons(body, [
      { label: 'Apply & Regenerate', cls: 'accent', fn: function () {
        var params = cur(); for (var k in draft) params[k] = draft[k];
        var seed = si.value.trim() || E.seed;
        draft = {};
        ui.togglePanel('worldPanel', false);
        ui.hideMainMenu(); ui.showPause(false);
        if (seed !== E.seed || !E.worldLoaded) { E.worldParams = params; E.startWorld({ seed: seed, params: params }); }
        else E.regenerate(params);
      } },
      { label: 'Reset defaults', fn: function () { draft = U.deepClone(TERRA.core.DEFAULT_PARAMS); syncs.forEach(function (s) { s(); }); } },
      { label: 'Export config', fn: function () { var p = cur(); for (var k in draft) p[k] = draft[k]; U.download('terra-config-' + (si.value || E.seed) + '.json', JSON.stringify({ format: 'terra-infinita-config', seed: si.value || E.seed, params: p }, null, 2)); } },
      { label: 'Import config', fn: function () {
        var f = document.createElement('input'); f.type = 'file'; f.accept = '.json';
        f.onchange = function () { var r = new FileReader(); r.onload = function () { try { var d = JSON.parse(r.result); if (d.seed) si.value = d.seed; draft = d.params || {}; syncs.forEach(function (s) { s(); }); TERRA.ui.toast('Configuration imported — press Apply'); } catch (e) { TERRA.ui.toast('Invalid configuration file', 'warn'); } }; r.readAsText(f.files[0]); };
        f.click();
      } }
    ]);
    refreshers.worldPanel = function () { si.value = E.seed; draft = {}; syncs.forEach(function (s) { s(); }); };
  }

  /* ================= WEATHER, TIME, WIND ================= */
  function buildEnv() {
    var body = $('envBody');
    var env = function () { return E.environment; };
    var syncs = [];
    title(body, 'Weather');
    var wg = el('div', 'btn-grid');
    D.weatherOrder.forEach(function (k) {
      var b = el('button', 'btn', D.weatherTypes[k].name); b.dataset.w = k;
      b.onclick = function () { env().weather.set(k); env().weather.auto = false; syncAll(); TERRA.ui.toast('Weather → ' + D.weatherTypes[k].name); };
      wg.appendChild(b);
    });
    body.appendChild(wg);
    syncs.push(toggle(body, 'Automatic weather cycle', function () { return env().weather.auto; }, function (v) { env().weather.auto = v; if (v) env().weather.nextChange = 60; }));
    syncs.push(range(body, 'Transition speed', function () { return env().weather.transitionSpeed; }, function (v) { env().weather.transitionSpeed = v; }, 0.25, 20, 0.25, function (v) { return v.toFixed(2) + '×'; }));
    buttons(body, [{ label: 'Apply instantly', fn: function () { env().weather.set(env().weather.type, true); } }]);
    title(body, 'Time of day');
    syncs.push(range(body, 'Time', function () { return env().time.hours; }, function (v) { env().time.hours = v; }, 0, 23.99, 0.05, function (v) { return U.fmtTime(v); }));
    buttons(body, [
      { label: 'Sunrise', fn: function () { env().time.hours = 6.2; syncAll(); } }, { label: 'Morning', fn: function () { env().time.hours = 9; syncAll(); } }, { label: 'Noon', fn: function () { env().time.hours = 12.5; syncAll(); } },
      { label: 'Golden hour', fn: function () { env().time.hours = 18.3; syncAll(); } }, { label: 'Twilight', fn: function () { env().time.hours = 19.9; syncAll(); } }, { label: 'Night', fn: function () { env().time.hours = 23; syncAll(); } }
    ]);
    syncs.push(range(body, 'Day length', function () { return env().time.dayMinutes; }, function (v) { env().time.dayMinutes = v; }, 2, 120, 1, function (v) { return v + ' min'; }));
    syncs.push(toggle(body, 'Pause time', function () { return env().time.paused; }, function (v) { env().time.paused = v; }));
    title(body, 'Season & location');
    syncs.push(range(body, 'Season', function () { return env().time.season; }, function (v) { env().time.season = v; }, 0, 0.999, 0.005, function (v) { return v < 0.125 ? 'Spring' : v < 0.375 ? 'Summer' : v < 0.625 ? 'Autumn' : v < 0.875 ? 'Winter' : 'Spring'; }));
    syncs.push(toggle(body, 'Seasons advance daily', function () { return env().time.autoSeason; }, function (v) { env().time.autoSeason = v; }));
    syncs.push(range(body, 'Latitude', function () { return env().time.latitude; }, function (v) { env().time.latitude = v; }, 0, 75, 1, function (v) { return v + '°'; }));
    title(body, 'Wind');
    syncs.push(toggle(body, 'Override wind', function () { return !!env().wind.override; }, function (v) { env().wind.override = v ? { angle: env().wind.angle, strength: env().wind.strength } : null; syncAll(); }));
    syncs.push(range(body, 'Direction', function () { return ((env().wind.override ? env().wind.override.angle : env().wind.angle) * 180 / Math.PI % 360 + 360) % 360; }, function (v) { if (!env().wind.override) env().wind.override = { angle: 0, strength: env().wind.strength }; env().wind.override.angle = v * Math.PI / 180; }, 0, 359, 1, function (v) { return Math.round(v) + '°'; }));
    syncs.push(range(body, 'Strength', function () { return env().wind.override ? env().wind.override.strength : env().wind.strength; }, function (v) { if (!env().wind.override) env().wind.override = { angle: env().wind.angle, strength: 0 }; env().wind.override.strength = v; }, 0, 1.5, 0.01));
    title(body, 'Ground state');
    syncs.push(range(body, 'Wetness', function () { return env().surface.wetness; }, function (v) { env().surface.wetness = v; }, 0, 1, 0.01));
    syncs.push(range(body, 'Puddles', function () { return env().surface.puddles; }, function (v) { env().surface.puddles = v; }, 0, 1, 0.01));
    syncs.push(range(body, 'Snow cover', function () { return env().surface.snowCover; }, function (v) { env().surface.snowCover = v; }, 0, 1, 0.01));
    function syncAll() {
      syncs.forEach(function (s) { s(); });
      wg.querySelectorAll('.btn').forEach(function (b) { b.classList.toggle('active', b.dataset.w === env().weather.type); });
    }
    refreshers.envPanel = syncAll;
    // keep live values moving while open
    setInterval(function () { if (!$('envPanel').classList.contains('hidden')) syncAll(); }, 1000);
  }

  /* ================= EDITOR ================= */
  function buildEditor() {
    var body = $('editorBody'), ed = E.editor;
    title(body, 'Tools');
    var tg = el('div', 'tool-grid');
    ed.TOOLS.forEach(function (t) {
      var b = el('button', 'tool', '<b>' + t.icon + '</b>' + t.name + (t.key ? ' <span style="opacity:.5">' + t.key + '</span>' : ''));
      b.dataset.tool = t.id;
      b.onclick = function () { ed.tool = t.id; refreshEditor(); };
      tg.appendChild(b);
    });
    body.appendChild(tg);
    title(body, 'Brush');
    var B = ed.brush, syncs = [];
    syncs.push(range(body, 'Size', function () { return B.radius; }, function (v) { B.radius = v; }, 1, 200, 1, function (v) { return Math.round(v) + 'm'; }));
    syncs.push(range(body, 'Strength', function () { return B.strength; }, function (v) { B.strength = v; }, 0.02, 2, 0.01));
    syncs.push(range(body, 'Falloff', function () { return B.falloff; }, function (v) { B.falloff = v; }, 0.3, 4, 0.05));
    syncs.push(range(body, 'Hardness', function () { return B.hardness; }, function (v) { B.hardness = v; }, 0, 0.95, 0.01));
    syncs.push(range(body, 'Noise', function () { return B.noise; }, function (v) { B.noise = v; }, 0, 1, 0.01));
    syncs.push(range(body, 'Smoothing', function () { return B.smoothing; }, function (v) { B.smoothing = v; }, 0, 1, 0.01));
    // tool-specific options
    var matBox = el('div'); body.appendChild(matBox);
    title(matBox, 'Material');
    var sw = el('div', 'swatches');
    var swCols = ['#51722a', '#a3935a', '#6b5238', '#7d7a74', '#9a7e5e', '#cdb88a', '#e8ecf2', '#8a857c', '#4a3524', '#3b2d22', '#2a2524', '#7c8158', '#b7d3e6'];
    TERRA.data.materials.slice(0, 13).forEach(function (m, i) {
      var s = el('div', 'swatch', m.name); s.style.background = swCols[i]; s.dataset.mat = i;
      s.onclick = function () { ed.material = i; refreshEditor(); };
      sw.appendChild(s);
    });
    matBox.appendChild(sw);
    var vegBox = el('div'); body.appendChild(vegBox);
    syncs.push(select(vegBox, 'Vegetation type', Object.keys(ed.VEG_TYPES).map(function (k) { return [k, k]; }), function () { return ed.vegType; }, function (v) { ed.vegType = v; }));
    var bioBox = el('div'); body.appendChild(bioBox);
    syncs.push(select(bioBox, 'Target biome', Object.keys(ed.BIOME_TARGETS).map(function (k) { return [k, k]; }), function () { return ed.biomeTarget; }, function (v) { ed.biomeTarget = v; }));
    var spBox = el('div'); body.appendChild(spBox);
    syncs.push(select(spBox, 'Object', Object.keys(ed.SPAWN_TYPES).map(function (k) { return [k, k]; }), function () { return ed.spawnType; }, function (v) { ed.spawnType = v; }));
    title(body, 'History');
    buttons(body, [
      { label: '↶ Undo', fn: function () { ed.undo(); } }, { label: '↷ Redo', fn: function () { ed.redo(); } },
      { label: 'Clear edits', cls: 'danger', fn: function () {
        if (!confirm('Remove every change made with the editor in this world?')) return;
        E.edits.clear(); E.chunks.onEdit(-1e9, -1e9, 1e9, 1e9); E.vegetation._dirtyFar = true; E.vegetation.invalidateField(); TERRA.ui.toast('All edits cleared');
      } }
    ]);
    title(body, 'Environment');
    buttons(body, [{ label: 'Weather & time…', fn: function () { ui.togglePanel('envPanel', true); } }, { label: 'World settings…', fn: function () { ui.togglePanel('worldPanel', true); } }, { label: 'Exit editor', fn: function () { E.editor.toggle(false); ui.showEditor(false); } }]);
    var info = el('div', 'note'); body.appendChild(info);
    function refreshEditor() {
      tg.querySelectorAll('.tool').forEach(function (b) { b.classList.toggle('active', b.dataset.tool === ed.tool); });
      sw.querySelectorAll('.swatch').forEach(function (s) { s.classList.toggle('active', +s.dataset.mat === ed.material); });
      matBox.classList.toggle('hidden', ed.tool !== 'paint');
      vegBox.classList.toggle('hidden', ed.tool !== 'vegPaint');
      bioBox.classList.toggle('hidden', ed.tool !== 'biome');
      spBox.classList.toggle('hidden', ed.tool !== 'spawn');
      syncs.forEach(function (s) { s(); });
      info.textContent = 'Edited tiles: ' + E.edits.height.size + ' height · ' + E.edits.paint.size + ' paint · ' + E.edits.objects.length + ' objects · ' + (E.edits.undoStack.length) + ' undo steps';
    }
    refreshers.editorPanel = refreshEditor;
    TERRA.ui.panels.refreshEditor = refreshEditor;
    refreshEditor();
  }

  TERRA.ui.panels = {
    build: function (u, engine) { ui = u; E = engine; buildSettings(); buildWorld(); buildEnv(); buildEditor(); },
    refresh: function (id) { if (refreshers[id]) refreshers[id](); },
    refreshEditor: function () {}
  };
})();
