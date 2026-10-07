/* =============================================================================
 * TERRA INFINITA — user interface: menus, loading, HUD, compass, pause, toasts,
 * map overlay, debug overlay. Panel contents are built in panels.js.
 * ========================================================================== */
(function () {
  'use strict';
  var U = TERRA.util;
  function $(id) { return document.getElementById(id); }

  /* Toasts are usable before the UI exists */
  TERRA.ui.toast = function (msg, kind) {
    var box = $('toasts'); if (!box) return;
    var t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    box.appendChild(t);
    while (box.children.length > 4) box.removeChild(box.firstChild);
    setTimeout(function () { t.style.transition = 'opacity 0.6s'; t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 650); }, 3200);
  };
  TERRA.ui.fatal = function (msg) {
    var w = $('gpuWarning');
    if (w) { w.textContent = msg + ' — please use a recent version of Chrome, Edge, Firefox or Safari with hardware acceleration enabled.'; w.classList.remove('hidden'); }
    ['btnPlay', 'btnContinue', 'btnNew', 'btnLoad'].forEach(function (id) { var b = $(id); if (b) b.disabled = true; });
  };

  function UI(engine) {
    this.E = engine;
    var self = this;
    this.hudVisible = true; this.debugOpen = !!engine.settings.ui.debug; this.mapOpen = false;
    this.openPanels = [];
    // ---- main menu
    $('seedInput').value = engine.seed;
    $('seedRandom').onclick = function () { $('seedInput').value = U.randomSeedString(); self.E.audio.click(); };
    $('seedCopy').onclick = function () {
      var v = $('seedInput').value;
      if (navigator.clipboard) navigator.clipboard.writeText(v).then(function () { TERRA.ui.toast('Seed copied: ' + v); }, function () { self._copyFallback(v); });
      else self._copyFallback(v);
    };
    $('seedInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('btnPlay').click(); });
    $('btnPlay').onclick = function () {
      var s = $('seedInput').value.trim() || U.randomSeedString();
      self.hideMainMenu();
      engine.startWorld({ seed: s, params: engine.worldParams });
    };
    $('btnContinue').onclick = function () {
      if (engine.worldLoaded) { self.hideMainMenu(); engine.state = 'paused'; engine.resume(); }
      else engine.save.load(0).then(function (d) { if (d) { self.hideMainMenu(); engine.startWorld({ data: d }); } else TERRA.ui.toast('No autosave found — press Play to generate a world'); });
    };
    $('btnNew').onclick = function () { var s = U.randomSeedString(); $('seedInput').value = s; self.hideMainMenu(); engine.startWorld({ seed: s, params: engine.worldParams }); };
    $('btnLoad').onclick = function () { self.showLoadPanel(); };
    $('btnSettings').onclick = function () { self.togglePanel('settingsPanel', true); };
    $('btnWorldSettings').onclick = function () { self.togglePanel('worldPanel', true); };
    $('btnImport').onclick = function () { $('importFile').click(); };
    $('importFile').onchange = function (e) {
      var f = e.target.files[0]; if (!f) return;
      engine.save.importFile(f).then(function (d) { self.hideMainMenu(); self.showPause(false); engine.startWorld({ data: d }); }, function (err) { TERRA.ui.toast('Import failed: ' + err.message, 'warn'); });
      e.target.value = '';
    };
    // ---- pause menu
    $('pResume').onclick = function () { engine.resume(); };
    $('pSave').onclick = function () { self._hidePause(); setTimeout(function () { engine.saveWorld(engine.slot).then(function () { self.showPause(true); }); }, 30); };
    $('pLoad').onclick = function () { self.showLoadPanel(); };
    $('pEnv').onclick = function () { self.togglePanel('envPanel', true); };
    $('pEditor').onclick = function () { engine.state = 'playing'; self.showPause(false); engine.editor.toggle(true); self.showEditor(true); };
    $('pMap').onclick = function () { engine.state = 'playing'; self.showPause(false); self.toggleMap(true); };
    $('pWorld').onclick = function () { self.togglePanel('worldPanel', true); };
    $('pSettings').onclick = function () { self.togglePanel('settingsPanel', true); };
    $('pExport').onclick = function () { engine.save.exportWorld(engine.serializeWorld()); TERRA.ui.toast('World exported'); };
    $('pShot').onclick = function () { self._hidePause(); setTimeout(function () { self.screenshot(function () { self.showPause(true); }); }, 60); };
    $('pMenu').onclick = function () { engine.save.save(0, engine.serializeWorld('Autosave')); engine.toMenu(); };
    // ---- close buttons
    document.querySelectorAll('[data-close]').forEach(function (b) { b.onclick = function () { self.togglePanel(b.getAttribute('data-close'), false); }; });
    // ---- map
    $('mapClose').onclick = function () { self.toggleMap(false); };
    $('mapCenter').onclick = function () { engine.map.centerOnPlayer(); };
    $('mapTeleport').onclick = function () {
      var w = engine.map.waypoint;
      if (!w) { TERRA.ui.toast('Click the map to set a waypoint first'); return; }
      engine.teleport(w[0], w[1]); self.toggleMap(false);
    };
    $('mapClearWp').onclick = function () { engine.map.waypoint = null; };
    this._buildLegend();
    this._buildCompass();
    TERRA.ui.panels.build(this, engine);
    this.showMainMenu();
    if (this.debugOpen) $('debugOverlay').classList.remove('hidden');
    this._backdropInit();
    TERRA.events.on('editorTool', function () { TERRA.ui.panels.refreshEditor(); });
  }
  var P = UI.prototype;

  P._copyFallback = function (v) {
    var i = $('seedInput'); i.select(); try { document.execCommand('copy'); TERRA.ui.toast('Seed copied: ' + v); } catch (e) { TERRA.ui.toast('Seed: ' + v); }
  };

  /* ---------------- menu & loading ---------------- */
  P.showMainMenu = function () {
    var m = $('mainMenu');
    m.classList.remove('hidden');
    m.classList.toggle('over-world', this.E.worldLoaded);
    $('hud').classList.add('hidden'); $('pauseMenu').classList.add('hidden');
    $('btnContinue').style.display = '';
    $('continueHint').textContent = this.E.worldLoaded ? 'Resume ' + this.E.seed : 'Load autosave';
    $('seedInput').value = this.E.seed;
    this._closeAllPanels();
    this.toggleMap(false);
  };
  P.hideMainMenu = function () { $('mainMenu').classList.add('hidden'); };
  P.showLoading = function (seed, tip) {
    var L = $('loading');
    L.classList.remove('hidden', 'fade-out'); L.style.opacity = '1';
    $('loadSeed').textContent = 'SEED  ' + seed;
    $('loadTip').textContent = tip;
    $('loadBar').style.width = '0%';
    document.querySelectorAll('#loadSteps li').forEach(function (li) { li.className = ''; });
    $('hud').classList.add('hidden');
    this._closeAllPanels();
  };
  P.loadProgress = function (step, f, detail) {
    $('loadBar').style.width = Math.round(f * 100) + '%';
    var reached = false;
    document.querySelectorAll('#loadSteps li').forEach(function (li) {
      var s = li.getAttribute('data-step');
      if (s === step) { li.className = f >= 1 ? 'done' : 'active'; reached = true; }
      else if (!reached) li.className = 'done';
      else li.className = '';
    });
    if (detail) $('loadDetail').textContent = detail;
  };
  P.loadError = function (e) {
    $('loadDetail').textContent = 'Error: ' + (e && e.message ? e.message : e);
    TERRA.ui.toast('World generation failed: ' + (e && e.message), 'warn');
    var self = this;
    setTimeout(function () { $('loading').classList.add('hidden'); self.showMainMenu(); }, 3500);
  };
  P.hideLoading = function () {
    var L = $('loading');
    L.classList.add('fade-out');
    setTimeout(function () { L.classList.add('hidden'); }, 1300);
  };
  P.onWorldStarted = function () {
    $('hud').classList.toggle('hidden', false);
    $('hud').classList.toggle('hidden-ui', !this.hudVisible);
    $('clickToPlay').classList.remove('hidden');
    var self = this;
    setTimeout(function () { $('hints').style.opacity = '0.0'; }, 20000);
    $('hints').style.opacity = '1';
    TERRA.ui.toast('Welcome to ' + this.E.seed);
  };

  /* ---------------- pause ---------------- */
  P.showPause = function (on) {
    $('pauseMenu').classList.toggle('hidden', !on);
    if (on) { $('pSaveHint').textContent = 'Slot ' + this.E.slot; this.E.input.unlock(); }
    else this._closeAllPanels();
  };
  P._hidePause = function () { $('pauseMenu').classList.add('hidden'); };

  /* ---------------- panels ---------------- */
  P.modalOpen = function () { return this.openPanels.length > 0 || this.mapOpen; };
  P.togglePanel = function (id, force) {
    var el = $(id);
    var on = force === undefined ? el.classList.contains('hidden') : force;
    el.classList.toggle('hidden', !on);
    var i = this.openPanels.indexOf(id);
    if (on && i < 0) this.openPanels.push(id);
    if (!on && i >= 0) this.openPanels.splice(i, 1);
    if (on) {
      TERRA.ui.panels.refresh(id);
      if (this.E.state === 'playing' && id !== 'editorPanel') this.E.input.unlock();
    }
    if (!on && id === 'editorPanel' && this.E.editor.active) { this.E.editor.toggle(false); $('editorBanner').classList.add('hidden'); }
  };
  P.closeTopPanel = function () {
    if (this.mapOpen) { this.toggleMap(false); return true; }
    var id = this.openPanels[this.openPanels.length - 1];
    if (!id) return false;
    this.togglePanel(id, false);
    return true;
  };
  P._closeAllPanels = function () {
    var self = this;
    this.openPanels.slice().forEach(function (id) { if (id !== 'editorPanel') self.togglePanel(id, false); });
  };
  P.showEditor = function (on) {
    this.togglePanel('editorPanel', on);
    $('editorBanner').classList.toggle('hidden', !on);
    $('crosshair').classList.toggle('hidden', on);
  };
  P.showLoadPanel = function () {
    var self = this, E = this.E;
    this.togglePanel('loadPanel', true);
    var list = $('slotList');
    list.innerHTML = '<div class="note">Loading…</div>';
    E.save.list().then(function (slots) {
      list.innerHTML = '';
      var bySlot = {}; slots.forEach(function (s) { bySlot[s.slot] = s; });
      for (var i = 0; i <= 5; i++) {
        (function (slot) {
          var s = bySlot[slot];
          var row = document.createElement('div'); row.className = 'slot';
          var thumb = s && s.thumb ? '<img src="' + s.thumb + '">' : '<div class="noimg"></div>';
          var label = slot === 0 ? 'Autosave' : 'Slot ' + slot;
          var meta = s ? '<b>' + label + ' · ' + (s.seed || '') + '</b><br>' + (s.biome || '') + ' · ' + new Date(s.savedAt).toLocaleString() : '<b>' + label + '</b><br>Empty';
          row.innerHTML = thumb + '<div class="meta">' + meta + '</div><div class="acts"></div>';
          var acts = row.querySelector('.acts');
          if (s) {
            var lb = document.createElement('button'); lb.className = 'btn accent'; lb.textContent = 'Load';
            lb.onclick = function () { E.save.load(slot).then(function (d) { if (!d) return; E.slot = slot || 1; self.togglePanel('loadPanel', false); self.hideMainMenu(); self.showPause(false); E.startWorld({ data: d }); }); };
            acts.appendChild(lb);
            var db = document.createElement('button'); db.className = 'btn danger'; db.textContent = '✕'; db.title = 'Delete';
            db.onclick = function () { E.save.remove(slot).then(function () { self.showLoadPanel(); }); };
            acts.appendChild(db);
          }
          if (E.worldLoaded && slot > 0) {
            var sb = document.createElement('button'); sb.className = 'btn'; sb.textContent = 'Save here';
            sb.onclick = function () { E.slot = slot; self.togglePanel('loadPanel', false); self._hidePause(); setTimeout(function () { E.saveWorld(slot).then(function () { if (E.state === 'paused') self.showPause(true); }); }, 30); };
            acts.appendChild(sb);
          }
          list.appendChild(row);
        })(i);
      }
    });
  };

  /* ---------------- map ---------------- */
  P.toggleMap = function (force) {
    var on = force === undefined ? !this.mapOpen : force;
    this.mapOpen = on;
    $('mapOverlay').classList.toggle('hidden', !on);
    if (!this.E.map) return;
    this.E.map.open = on;
    if (on) { this.E.input.unlock(); this.E.map.centerOnPlayer(); }
  };
  P._buildLegend = function () {
    var names = TERRA.core.BIOME_NAMES, cols = TERRA.core.BIOME_COLORS, html = '';
    for (var i = 0; i < names.length; i++) html += '<span><i style="background:rgb(' + cols[i].join(',') + ')"></i>' + names[i] + '</span>';
    html += '<span><i style="background:#ffd36e"></i>Discovered place</span><span><i style="background:#ff7a45"></i>Volcano</span>';
    $('mapLegend').innerHTML = html;
  };

  /* ---------------- HUD ---------------- */
  P.toggleHUD = function () { this.hudVisible = !this.hudVisible; $('hud').classList.toggle('hidden-ui', !this.hudVisible); };
  P.toggleDebug = function () { this.debugOpen = !this.debugOpen; $('debugOverlay').classList.toggle('hidden', !this.debugOpen); this.E.settings.ui.debug = this.debugOpen; };
  P._buildCompass = function () {
    var strip = $('compassStrip'), html = '';
    var labels = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    // three revolutions so the strip can scroll seamlessly
    for (var r = -1; r <= 1; r++) for (var d = 0; d < 360; d += 15) {
      var x = (r * 360 + d) * 4;
      if (labels[d]) html += '<div class="lbl' + (d % 90 ? ' minor' : '') + '" style="left:' + x + 'px">' + labels[d] + '</div>';
      else html += '<div class="tick" style="left:' + x + 'px"></div>';
    }
    strip.innerHTML = html + '<div id="compassMarks"></div>';
  };
  P._updateCompass = function () {
    var E = this.E, yaw = E.player.yaw;
    // heading: yaw=0 looks toward -z (north); heading grows clockwise
    var heading = ((-yaw * 180 / Math.PI) % 360 + 360) % 360;
    var el = $('compass'), w = el.clientWidth;
    $('compassStrip').style.transform = 'translateX(' + (w / 2 - heading * 4) + 'px)';
    // markers: nearby POIs & waypoint
    this._markT = (this._markT || 0) - 1;
    if (this._markT > 0) return;
    this._markT = 10;
    var marks = [], p = E.player.pos;
    var pois = E.vegetation.poiList || [];
    for (var i = 0; i < pois.length; i++) {
      var poi = pois[i], dx = poi.x - p[0], dz = poi.z - p[2], d = Math.hypot(dx, dz);
      if (d > 1500 || d < 25) continue;
      var b = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
      marks.push([b, E.map.discovered[poi.id] ? '◆' : '◇', '']);
    }
    var wp = E.map.waypoint;
    if (wp) { var b2 = (Math.atan2(wp[0] - p[0], -(wp[1] - p[2])) * 180 / Math.PI + 360) % 360; marks.push([b2, '▼ ' + U.fmtDist(Math.hypot(wp[0] - p[0], wp[1] - p[2])), 'wp']); }
    var html = '';
    marks.forEach(function (m) { for (var r = -1; r <= 1; r++) html += '<div class="mark ' + m[2] + '" style="left:' + ((r * 360 + m[0]) * 4) + 'px">' + m[1] + '</div>'; });
    var cm = $('compassMarks'); if (cm) cm.innerHTML = html;
  };

  P.update = function (dt, fs) {
    var E = this.E;
    if (E.state === 'menu' || !E.worldLoaded) return;
    var env = E.environment, L = env.local, pl = E.player;
    this._hudT = (this._hudT || 0) - dt;
    if (this._hudT <= 0 && this.hudVisible) {
      this._hudT = 0.2;
      $('hudBiome').textContent = L.biomeName || '';
      var near = '';
      var pois = E.vegetation.poiList || [];
      for (var i = 0; i < pois.length; i++) { if (Math.hypot(pois[i].x - pl.pos[0], pois[i].z - pl.pos[2]) < 90) { near = pois[i].name; break; } }
      $('hudPlace').textContent = near ? '◆ ' + near : (pl.swimming ? 'Swimming' : (pl.climbing ? 'Climbing' : ''));
      $('hudTime').textContent = U.fmtTime(env.time.hours) + ' · ' + env.time.label();
      $('hudWeather').textContent = env.weather.name();
      $('hudTemp').textContent = Math.round(L.temp) + '°C';
      $('hudAlt').textContent = 'Alt ' + Math.round(pl.pos[1] - E.gen.SEA) + ' m';
      $('hudCoords').textContent = Math.round(pl.pos[0]) + ', ' + Math.round(pl.pos[2]);
      if (E.relics > 0) { $('relicCounter').classList.remove('hidden'); $('relicCounter').textContent = '◈ ' + E.relics + ' relic' + (E.relics > 1 ? 's' : ''); }
      $('stamina').style.opacity = pl.stamina < 0.98 ? '1' : '0';
      $('stamina').firstChild.style.width = Math.round(pl.stamina * 100) + '%';
      $('clickToPlay').classList.toggle('hidden', E.input.locked || E.editor.active || E.state !== 'playing' || this.mapOpen || pl.mode === 'free' && E.input.locked);
    }
    if (this.hudVisible) this._updateCompass();
    var perf = E.perf;
    this._fpsT = (this._fpsT || 0) - fs.dt;
    if (this._fpsT <= 0) {
      this._fpsT = 0.25;
      var ui = E.settings.ui, html = '';
      if (ui.showFps) {
        var fg = E.renderer && E.renderer.frameGen, gen = fg && fg.active;
        // generated frames are labelled separately: native = real simulated & rendered frames
        html = gen ? Math.round(perf.displayFps || perf.fps) + ' FPS <span class="gen">×' + fg.mult + ' extrapolated</span><br><span class="ms">native ' + Math.round(perf.fps) + ' FPS · ' + perf.frameMs.toFixed(1) + ' ms</span>'
                   : Math.round(perf.fps) + ' FPS<br><span class="ms">' + perf.frameMs.toFixed(1) + ' ms</span>';
        if (ui.showStats !== false) {
          var mem = perf.memory(), cs = E.chunks.stats, G = E.G;
          var lines = [
            'CPU ' + perf.cpuMs.toFixed(1) + ' ms' + (G.gpuMs ? ' · GPU ' + G.gpuMs.toFixed(1) + ' ms' : ''),
            'res ' + Math.round(E.renderer.dynScale * (E.settings.graphics.resolutionScale || 1) * 100) + '% · LOD ' + Math.round((E.lodScale || 1) * 100) + '%',
            'chunks ' + cs.drawn + '/' + cs.loaded + (cs.pending ? ' · ' + cs.pending + ' gen' : ''),
            (mem ? 'heap ' + mem.toFixed(0) + ' MB · ' : '') + 'GPU mem ' + ((E.chunks.gpuBytes() / 1048576) | 0) + ' MB',
            'draws ' + G.stats.drawCalls + ' · ' + (G.stats.triangles / 1e6).toFixed(1) + 'M tris'
          ];
          if (E.vehicles && E.vehicles.current) lines.push(E.vehicles.statusLine());
          html += '<div class="stats">' + lines.join('<br>') + '</div>';
        }
      }
      $('fps').innerHTML = html;
    }
    if (this.debugOpen) this._updateDebug(fs);
    if (this.mapOpen) {
      var m = E.map;
      $('mapInfo').textContent = 'You: ' + Math.round(pl.pos[0]) + ', ' + Math.round(pl.pos[2]) + (m.waypoint ? '  ·  Waypoint: ' + Math.round(m.waypoint[0]) + ', ' + Math.round(m.waypoint[1]) + ' (' + U.fmtDist(Math.hypot(m.waypoint[0] - pl.pos[0], m.waypoint[1] - pl.pos[2])) + ')' : '') + '  ·  ' + U.fmtDist(m.mpp * 100) + ' / 100px';
    }
  };

  P._updateDebug = function (fs) {
    this._dbgT = (this._dbgT || 0) - fs.dt;
    if (this._dbgT > 0) return;
    this._dbgT = 0.25;
    var E = this.E, R = E.renderer, G = R.G, cs = E.chunks.stats, vs = E.vegetation.stats, pl = E.player, env = E.environment.env;
    var el = $('debugOverlay');
    if (!this._dbgBuilt) {
      el.innerHTML = '<div id="dbgText"></div><canvas id="dbgGraph" width="280" height="40"></canvas>' +
        '<select id="dbgView"><option value="0">View: Final render</option><option value="1">Chunk boundaries & LOD</option><option value="2">Biome map</option><option value="3">Height map</option>' +
        '<option value="4">Moisture map</option><option value="5">Temperature map</option><option value="6">Terrain normals</option><option value="7">Slope</option><option value="8">Wireframe grid (collision mesh)</option><option value="9">LOD morph factor</option></select>';
      var self = this;
      $('dbgView').onchange = function () { E.debugView = +this.value; };
      this._dbgBuilt = true;
    }
    var T = R.targets;
    var mem = E.perf.memory();
    var lines = [
      ['FPS', Math.round(E.perf.fps) + '  (' + E.perf.frameMs.toFixed(2) + ' ms, CPU ' + E.perf.cpuMs.toFixed(2) + ' ms' + (G.gpuMs ? ', GPU ' + G.gpuMs.toFixed(2) + ' ms' : '') + ')'],
      ['Resolution', T ? T.w + '×' + T.h + ' (' + Math.round(R.dynScale * 100) + '% dyn)' : '-'],
      ['Draw calls', G.stats.drawCalls + '  ·  tris ' + (G.stats.triangles / 1e6).toFixed(2) + 'M'],
      ['Chunks', cs.drawn + ' drawn / ' + cs.loaded + ' loaded  ·  ' + cs.pending + ' jobs'],
      ['Chunk gen', cs.genMs.toFixed(1) + ' ms avg  ·  workers ' + E.pool.workers.length + (E.pool.fallback ? ' (main thread)' : '')],
      ['Terrain GPU', (E.chunks.gpuBytes() / 1048576).toFixed(1) + ' MB' + (mem ? '  ·  JS heap ' + mem.toFixed(0) + ' MB' : '')],
      ['Vegetation', vs.trees + ' trees · ' + vs.impostors + ' impostors · ' + vs.props + ' props'],
      ['Grass blades', (vs.grass / 1000).toFixed(0) + 'k  ·  particles ' + (R.particles.stats.count / 1000).toFixed(1) + 'k'],
      ['Water chunks', R.water.stats.nodes],
      ['Position', pl.pos.map(function (v) { return v.toFixed(1); }).join(', ')],
      ['Origin', E.origin.join(', ')],
      ['Biome', (E.environment.local.biomeName || '') + ' · T ' + E.environment.local.temp.toFixed(1) + '°C · M ' + E.environment.local.moist.toFixed(2)],
      ['Weather', E.environment.weather.type + ' · cloud ' + env.cloudCover.toFixed(2) + ' · rain ' + env.rain.toFixed(2) + ' · snow ' + env.snow.toFixed(2)],
      ['Surface', 'wet ' + env.wetness.toFixed(2) + ' · puddles ' + env.puddles.toFixed(2) + ' · snow ' + env.snowCover.toFixed(2) + ' · ' + pl.surface],
      ['Wind', env.windStrength.toFixed(2) + ' @ ' + Math.round(Math.atan2(env.windDir[1], env.windDir[0]) * 57.3) + '°'],
      ['GPU', G.caps.renderer.slice(0, 38)],
      ['CPU', (navigator.hardwareConcurrency || '?') + ' threads · ' + E.pool.workers.length + ' terrain workers' + (navigator.deviceMemory ? ' · ' + navigator.deviceMemory + ' GB' : '')],
      ['Culling', (R.hiz && R.hiz.valid ? 'Hi-Z on' : 'Hi-Z off') + ' · LOD ' + Math.round((E.lodScale || 1) * 100) + '% · shadows cached ' + (E.settings.graphics.shadowCache !== false ? 'yes' : 'no')],
      ['Features', (G.caps.reversedZ ? 'reversed-Z ' : '') + (G.caps.colorFloat ? 'HDR ' : 'LDR ') + (E.settings.graphics.rtx ? 'RTX-sim' : '')]
    ];
    $('dbgText').innerHTML = lines.map(function (l) { return '<span class="k">' + l[0] + ':</span> ' + l[1]; }).join('<br>');
    var c = $('dbgGraph'), ctx = c.getContext('2d'), h = E.perf.history;
    ctx.clearRect(0, 0, 280, 40); ctx.fillStyle = 'rgba(127,208,255,0.7)';
    for (var i = 0; i < h.length; i++) { var v = h[(E.perf.hi + i) % h.length]; var bh = Math.min(40, v * 1.2); ctx.fillRect(i * 280 / h.length, 40 - bh, 2, bh); }
    ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.fillRect(0, 40 - 16.7 * 1.2, 280, 1);
  };

  P.screenshot = function (cb) {
    var E = this.E;
    E.renderer.screenshot(function (url) {
      if (url) { var a = document.createElement('a'); a.href = url; a.download = 'terra-' + E.seed + '-' + Date.now() + '.png'; document.body.appendChild(a); a.click(); a.remove(); TERRA.ui.toast('Screenshot saved'); }
      if (cb) cb();
    });
  };

  /* ---------------- animated menu backdrop (2D, lightweight) ---------------- */
  P._backdropInit = function () {
    var c = $('menuBackdrop'); this._bd = c; this._bdT = 0;
  };
  P.menuBackdrop = function (dt) {
    var c = this._bd;
    if (!c || $('mainMenu').classList.contains('hidden') || this.E.worldLoaded) return;
    this._bdT += dt;
    var w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    var ctx = c.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    // layered mountain silhouettes with parallax drift
    var core = TERRA.core;
    var layers = 5;
    for (var l = 0; l < layers; l++) {
      var depth = l / (layers - 1);
      var baseY = h * (0.45 + depth * 0.12);
      var amp = h * (0.22 - depth * 0.08);
      var off = this._bdT * (4 + depth * 10);
      ctx.beginPath(); ctx.moveTo(0, h);
      for (var x = 0; x <= w; x += 6) {
        var n = core.fbm((x + off) / (500 - depth * 200), l * 3.1, 5, 77 + l);
        var r = 1 - Math.abs(core.snoise((x + off) / (900 - depth * 300), l * 7.7, 99 + l));
        ctx.lineTo(x, baseY - (n * 0.6 + r * r * 0.9) * amp);
      }
      ctx.lineTo(w, h); ctx.closePath();
      var a = 0.35 + depth * 0.55;
      ctx.fillStyle = 'rgba(' + Math.round(14 + 10 * (1 - depth)) + ',' + Math.round(20 + 14 * (1 - depth)) + ',' + Math.round(30 + 18 * (1 - depth)) + ',' + a + ')';
      ctx.fill();
    }
  };

  TERRA.ui.UI = UI;
})();
