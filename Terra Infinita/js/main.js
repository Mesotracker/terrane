/* =============================================================================
 * TERRA INFINITA — engine bootstrap & main loop
 * ========================================================================== */
(function () {
  'use strict';
  var U = TERRA.util, M = TERRA.math;

  var TIPS = [
    'Rivers flow toward the coast and carve their own valleys — follow one downstream to find the sea.',
    'Rain gradually soaks the ground: watch puddles form in depressions and on dirt trails.',
    'Every seed is a different planet. Share yours from the main menu.',
    'Press Tab to open the world editor and sculpt mountains, paint biomes or add lakes.',
    'Glowing relics are hidden at ancient ruins, campsites and caves.',
    'The simulated RTX mode adds screen-space reflections, bounce light, contact shadows and reflection probes.',
    'Snow accumulates only when it is cold enough — and melts into slush when the sun comes out.',
    'Clouds cast moving shadows across the landscape. Climb a peak to watch them.',
    'Volcanoes, great peaks and ancient forests are rare landmarks — use the map (M) to spot them.'
  ];

  function Engine() {
    var self = this;
    TERRA.engine = this;
    this.save = new TERRA.game.SaveSystem();
    this.settings = this.save.loadSettings();
    this.canvas = document.getElementById('view');
    this.state = 'menu';
    this.time = 0;
    this.origin = [0, 0];
    this.originKey = '0:0';
    this.camera = { world: [0, 0, 0], pos: [0, 0, 0], view: M.mat4(), proj: M.mat4(), viewProj: M.mat4(), invViewProj: M.mat4(), invView: M.mat4(), invProj: M.mat4(), planes: new Float32Array(24), fov: 1.3, aspect: 1, near: 0.2, far: 40000, forward: [0, 0, -1] };
    this.flashlight = { on: false, dir: [0, 0, -1] };
    this.debugView = 0;
    this.worldLoaded = false;
    this.seed = U.safeStorage.get('terra.lastSeed') || 'TERRA-42';
    this.worldParams = {};
    this.relics = 0;
    this.slot = 1;
    try {
      this.renderer = new TERRA.gfx.Renderer(this, this.canvas);
    } catch (e) {
      TERRA.ui.fatal('WebGL2 is required but could not be initialised: ' + e.message);
      return;
    }
    this.G = this.renderer.G;
    this.input = new TERRA.game.Input(this.canvas);
    var cores = navigator.hardwareConcurrency || 4;
    this.pool = new TERRA.world.WorkerPool(U.clamp(cores - 1, 2, 8));
    this.edits = new TERRA.world.Edits();
    this.chunks = new TERRA.world.ChunkManager(this);
    this.vegetation = new TERRA.world.Vegetation(this);
    this.environment = new TERRA.env.Environment(this);
    this.player = new TERRA.game.Player(this);
    this.editor = new TERRA.game.Editor(this);
    this.audio = new TERRA.game.AudioEngine();
    this.perf = new TERRA.game.Perf();
    this.gpuReady = false;
    this.input.onUnlock = function () { if (self.state === 'playing' && !self.editor.active && !self.ui.modalOpen() && !self._intentionalUnlock) self.pause(); self._intentionalUnlock = false; };
    this.input.onCanvasMouseDown = function (e) {
      if (self.state === 'playing' && !self.editor.active && e.button === 0) self.input.lock();
      self.audio.resume();
    };
    TERRA.events.on('footstep', function (e) { self.audio.footstep(e); });
    TERRA.events.on('land', function (e) { self.audio.land(e); });
    TERRA.events.on('thunder', function (d) { self.audio.thunder(d); });
    TERRA.events.on('discovered', function (p) { TERRA.ui.toast('Discovered: ' + p.name, 'discover'); });
    this.map = new TERRA.game.MapView(this, document.getElementById('mapCanvas'));
    this.ui = new TERRA.ui.UI(this);
    this._last = performance.now();
    // The loop must never die: errors are logged (throttled) and the next frame is always scheduled.
    var errCount = 0;
    requestAnimationFrame(function loop(t) {
      requestAnimationFrame(loop);
      try { self._frame(t); }
      catch (e) {
        if (errCount++ < 5) { console.error('Frame error (recovered):', e && e.stack || e); if (errCount === 1) TERRA.ui.toast('Recovered from a rendering error — see console', 'warn'); }
        try { self.input.endFrame(); } catch (e2) { /* ignore */ }
      }
    });
  }
  var P = Engine.prototype;

  /* ---------------- world queries ---------------- */
  /** Ground height matching the rendered terrain (leaf mesh when loaded, else analytic + edits). */
  P.groundHeight = function (x, z) {
    var n = this.chunks.finestNode(x, z);
    if (n && n.level <= 1) return this.chunks.meshHeight(x, z);
    return this.gen ? this.gen.height(x, z) + this.edits.heightDelta(x, z) : 0;
  };
  P.waterAt = function (x, z) {
    if (!this.gen) return { level: -1e5, type: 0 };
    var ov = this.edits.waterAt(x, z);
    if (ov !== null) return { level: ov, type: ov > -1e4 ? 2 : 0 };
    var o = this._ws || (this._ws = this.gen.newSample());
    this.gen.sample(x, z, o, 0);
    if (o.wtype > 0) return { level: o.water, type: o.wtype, fx: o.fx || 0, fz: o.fz || 0 };
    return { level: -1e5, type: 0, fx: 0, fz: 0 };
  };
  P.cameraWaterLevel = function () {
    var c = this.camera.world;
    var t = this.time;
    if (!this._cw || t - this._cwT > 0.15 || Math.hypot(c[0] - this._cw[0], c[2] - this._cw[1]) > 2) {
      var wa = this.waterAt(c[0], c[2]);
      this._cw = [c[0], c[2]]; this._cwT = t; this._cwL = wa.level; this._cwType = wa.type;
    }
    // the surface above/below the camera rides on the swell (same waves as the water shader)
    if (this._cwL > -1e4 && TERRA.world.Water && TERRA.world.Water.waveHeight)
      return this._cwL + TERRA.world.Water.waveHeight(c[0] - this.origin[0], c[2] - this.origin[1], t, this._cwType, this.environment.env);
    return this._cwL;
  };

  /* ---------------- GPU assets (built once) ---------------- */
  P._initGPU = async function (progress) {
    var g = this.settings.graphics;
    progress('shaders', 0.05, 'Compiling rendering pipeline');
    await U.tick();
    if (!this.texgen || this._texQuality !== g.textureQuality) {
      this.texgen = new TERRA.gfx.TexGen(this.G);
      progress('materials', 0.1, 'Painting procedural materials');
      await this.texgen.generate(g.textureQuality, function (f, label) { progress('materials', 0.1 + f * 0.3, label); });
      this._texQuality = g.textureQuality;
    }
    if (!this.renderer.sky) {
      progress('shaders', 0.42, 'Compiling lighting & post-processing shaders');
      await U.tick();
      this.renderer.initSystems(this.texgen);
      this.interaction = new TERRA.game.Interaction(this);
      try { this.windsim = new TERRA.env.WindSim(this); } catch (e) { U.warn('Wind simulation unavailable', e); this.windsim = null; }
      try { this.watersim = new TERRA.world.WaterSim(this); } catch (e) { U.warn('Water simulation unavailable', e); this.watersim = null; }
    } else {
      this.renderer.tex.matAlbedo = this.texgen.materials.albedoH; this.renderer.tex.matNormal = this.texgen.materials.normalR;
    }
    if (!this.models) {
      progress('models', 0.46, 'Growing trees, rocks and structures');
      await U.tick();
      this.models = TERRA.world.Models.buildAll(this.G, g.vegetationQuality);
      try { this.throwables = new TERRA.game.Throwables(this); } catch (e) { U.warn('Physics objects unavailable', e); this.throwables = null; }
      try { this.effects = new TERRA.game.Effects(this); } catch (e) { U.warn('Effects unavailable', e); this.effects = null; }
      try { this.vehicles = new TERRA.game.Vehicles(this); } catch (e) { U.warn('Vehicles unavailable', e); this.vehicles = null; }
      try { this.tools = new TERRA.game.Tools(this); } catch (e) { U.warn('Tools unavailable', e); this.tools = null; }
      // combat layer: buildings, soldiers, player weapons and the damage model.
      // Every part is optional: if one fails the rest of the world keeps running.
      try {
        this.combat = new TERRA.game.Combat(this);
        TERRA.game.Combat.inst = this.combat;
        this.buildings = new TERRA.world.Buildings(this);
        this.characters = new TERRA.game.Characters(this);
        this.soldiers = new TERRA.game.Soldiers(this);
        this.weapons = new TERRA.game.Weapons(this);
        this.gvehicles = new TERRA.game.GVehicles(this);
        this.warmode = new TERRA.game.Warmode(this);
        this.combat.addProvider(this.buildings.raycast.bind(this.buildings));
        this.combat.addProvider(this.gvehicles.raycast.bind(this.gvehicles));
        this.combat.addProvider(this.soldiers.raycast.bind(this.soldiers));
        this.warmode.init(this.combat);
        this.buildings.configure(g); this.soldiers.configure(g); this.weapons.configure(g);
        this.gvehicles.configure(g);
        this.warmode.configure(g); this.combat.decals.configure(g.combatDetail === undefined ? 2 : g.combatDetail);
      } catch (e) {
        U.warn('Combat layer unavailable', e);
        this.combat = this.buildings = this.soldiers = this.weapons = this.gvehicles = this.warmode = null;
      }
      this.vegetation.init(this.models, g.vegetationQuality);
      progress('models', 0.52, 'Baking tree impostors');
      await U.tick();
      this.vegetation.bakeImpostors(this.texgen);
    }
    this.gpuReady = true;
  };

  /* ---------------- world lifecycle ---------------- */
  /** Start (or restart) a world. opts: { seed, params, data (saved world) } */
  P.startWorld = async function (opts) {
    opts = opts || {};
    if (this._starting) return;
    this._starting = true;
    var self = this, ui = this.ui;
    var data = opts.data || null;
    var seed = String(data ? data.seed : (opts.seed || this.seed));
    var params = data ? (data.params || {}) : (opts.params || this.worldParams);
    this.seed = seed; this.worldParams = params;
    U.safeStorage.set('terra.lastSeed', seed);
    this.state = 'loading';
    ui.showLoading(seed, TIPS[Math.floor(Math.random() * TIPS.length)]);
    this.audio.init(this.settings.audio);
    var progress = function (step, f, detail) { ui.loadProgress(step, f, detail); };
    try {
      await this._initGPU(progress);
      progress('world', 0.55, 'Seeding generator');
      await U.tick();
      this.gen = TERRA.core.createGenerator(seed, params);
      this.edits.clear();
      if (data && data.edits) this.edits.deserialize(data.edits);
      await this.pool.init(seed, params);
      this.chunks.configure(this.settings.graphics);
      this.chunks.reset(this.gen);
      this.vegetation.reset();
      this.map.reset();
      if (this.interaction) this.interaction.clear();
      if (this.windsim) this.windsim.clear();
      if (this.watersim) this.watersim.clear();
      if (this.throwables) this.throwables.clear();
      if (this.vehicles) this.vehicles.clear();
      if (this.effects) this.effects.clear();
      if (this.tools) this.tools.clear();
      if (this.combat) this.combat.clear();
      if (this.buildings) { this.buildings.clear(); }
      if (this.soldiers) this.soldiers.clear();
      if (this.weapons) this.weapons.clear();
      if (this.gvehicles) this.gvehicles.clear();
      this.relics = 0; this.vegetation.collected = {};
      // player & environment
      if (data) {
        this.player.deserialize(data.player);
        this.environment.deserialize(data.env);
        this.map.deserialize(data.map);
        this.vegetation.collected = data.collected || {};
        this.relics = Object.keys(this.vegetation.collected).length;
        if (this.vehicles && data.vehicles) this._pendingVehicles = data.vehicles;
        if (this.tools && data.tools) this.tools.deserialize(data.tools);
        if (data.combat) this._pendingCombat = data.combat;
      } else {
        var sp = this.gen.findSpawn(0, 0);
        this.player.pos = [sp.x, sp.y, sp.z];
        this.player.yaw = this.player.tYaw = Math.random() * Math.PI * 2;
        this.player.pitch = this.player.tPitch = -0.08;
        this.player.mode = this.settings.controls.cameraMode === 'free' ? 'first' : this.settings.controls.cameraMode;
        this.environment.time.hours = 9.2; this.environment.time.day = 0;
        this.environment.weather.set('clear', true);
        this.environment.weather.auto = true;
        this.environment.surface.wetness = 0; this.environment.surface.puddles = 0; this.environment.surface.snowCover = 0;
      }
      this.player.vel = [0, 0, 0];
      this.player._camera(0, this.settings.controls, this.environment.env);
      this.renderer.post.resetExposure = true;
      // stream terrain around the player before revealing the world
      progress('terrain', 0.58, 'Requesting chunks');
      var t0 = performance.now();
      var p = this.player.pos;
      while (true) {
        this._updateCamera(0.016);
        this.chunks.update(this.camera);
        var ready = this.chunks.isAreaReady(p[0], p[2], 96, 0);
        var pend = this.pool.pending();
        var frac = ready ? 1 : Math.min(0.95, 1 - pend / (pend + this.chunks.stats.loaded + 1));
        progress('terrain', 0.58 + frac * 0.3, this.chunks.stats.loaded + ' chunks · ' + pend + ' pending · ' + this.pool.workers.length + ' workers');
        if ((ready && pend < 40) || performance.now() - t0 > 25000) break;
        await U.sleep(30);
      }
      // settle the player on the (now exact) ground
      var gh = this.groundHeight(p[0], p[2]);
      if (!data || this.player.pos[1] < gh) this.player.pos[1] = gh;
      this.player._camera(0, this.settings.controls, this.environment.env);
      progress('environment', 0.9, 'Growing vegetation & weather');
      var t1 = performance.now();
      while (performance.now() - t1 < 8000) {
        this._updateCamera(0.016);
        this.chunks.update(this.camera);
        this.vegetation.update(this._frameState(0.016));
        var cellsPending = 0;
        this.vegetation.propCells.forEach(function (c) { if (c.state !== 'ready') cellsPending++; });
        this.vegetation.treeCells.forEach(function (c) { if (c.state !== 'ready' && Math.hypot((c.i + 0.5) * 256 - p[0], (c.j + 0.5) * 256 - p[2]) < 600) cellsPending++; });
        progress('environment', 0.9 + 0.09 * (1 - Math.min(1, cellsPending / 40)), cellsPending + ' vegetation cells pending');
        if (cellsPending === 0) break;
        await U.sleep(30);
      }
      this.environment.update(0.01, this.camera.world, this.player.pos);
      progress('environment', 1, 'Ready');
      await U.sleep(250);
      if (this._pendingVehicles && this.vehicles) { try { this.vehicles.deserialize(this._pendingVehicles); } catch (e) { U.warn('Could not restore vehicles', e); } }
      this._pendingVehicles = null;
      if (this._pendingCombat) {
        try {
          var cc = this._pendingCombat;
          if (this.weapons && cc.weapons) this.weapons.deserialize(cc.weapons);
          if (this.warmode && cc.warmode) this.warmode.deserialize(cc.warmode);
          if (this.buildings && cc.buildings) this.buildings.deserialize(cc.buildings);
          if (this.soldiers && cc.soldiers) this.soldiers.deserialize(cc.soldiers);
          if (this.gvehicles && cc.gvehicles) this.gvehicles.deserialize(cc.gvehicles);
        } catch (e) { U.warn('Could not restore combat state', e); }
      }
      this._pendingCombat = null;
      this.worldLoaded = true;
      this.state = 'playing';
      this.time = 0;
      ui.hideLoading();
      ui.onWorldStarted();
    } catch (e) {
      console.error(e);
      ui.loadError(e);
      this.state = 'menu';
    }
    this._starting = false;
  };

  P.pause = function () {
    if (this.state !== 'playing') return;
    if (this.vehicles) this.vehicles.toggleMenu(false);
    this.state = 'paused';
    this.ui.showPause(true);
  };
  P.resume = function () {
    if (!this.worldLoaded) return;
    this.state = 'playing';
    this.ui.showPause(false);
    if (!this.editor.active) this.input.lock();
  };
  P.toMenu = function () {
    this.state = 'menu';
    if (this.editor.active) this.editor.toggle(false);
    this.input.unlock();
    this.ui.showMainMenu();
  };

  /** Gather everything that defines the current world. */
  P.serializeWorld = function (name) {
    return {
      format: 'terra-infinita-world', version: 1,
      name: name || ('World ' + this.seed), seed: this.seed, params: this.worldParams,
      player: this.player.serialize(), env: this.environment.serialize(), edits: this.edits.serialize(),
      map: this.map.serialize(), collected: this.vegetation.collected, biome: this.environment.local.biomeName,
      vehicles: this.vehicles ? this.vehicles.serialize() : [],
      tools: this.tools ? this.tools.serialize() : null,
      combat: this.combat ? {
        weapons: this.weapons.serialize(), warmode: this.warmode.serialize(),
        buildings: this.buildings.serialize(), soldiers: this.soldiers.serialize(),
        gvehicles: this.gvehicles ? this.gvehicles.serialize() : []
      } : null,
      graphics: this.settings.graphics
    };
  };
  P.saveWorld = function (slot) {
    var self = this;
    slot = slot || this.slot;
    var data = this.serializeWorld();
    return new Promise(function (resolve) {
      self.renderer.screenshot(function (url) {
        // thumbnail
        if (url) {
          var img = new Image();
          img.onload = function () {
            var c = document.createElement('canvas'); c.width = 240; c.height = 135;
            c.getContext('2d').drawImage(img, 0, 0, 240, 135);
            data.thumb = c.toDataURL('image/jpeg', 0.7);
            self.save.save(slot, data).then(function () { TERRA.ui.toast('World saved to slot ' + slot); resolve(true); }, function (e) { TERRA.ui.toast('Save failed: ' + e.message, 'warn'); resolve(false); });
          };
          img.src = url;
        } else self.save.save(slot, data).then(function () { TERRA.ui.toast('World saved to slot ' + slot); resolve(true); });
      });
    });
  };
  P.applyGraphics = function () {
    var g = this.settings.graphics;
    this.save.saveSettings(this.settings);
    if (!this.renderer.sky) return;
    this.renderer.applySettings(g);
    this.chunks.configure(g);
    this.vegetation.configure(g);
    if (this.buildings) this.buildings.configure(g);
    if (this.soldiers) this.soldiers.configure(g);
    if (this.weapons) this.weapons.configure(g);
    if (this.gvehicles) this.gvehicles.configure(g);
    if (this.combat) this.combat.decals.configure(g.combatDetail === undefined ? 2 : g.combatDetail);
    this.renderer.dynScale = 1;
  };
  /** Photoreal mode: path tracing + ray-traced soft shadows + every realism setting. Turning it
   *  off restores exactly the settings it replaced. */
  P.setPhotoreal = function (on) {
    var g = this.settings.graphics, D = TERRA.data, k;
    if (on === undefined) on = !g.photoreal;
    if (on && !g.photoreal) {
      var prev = {};
      for (k in D.photorealBundle) prev[k] = g[k] === undefined ? null : g[k];
      g.photorealPrev = prev;
      for (k in D.photorealBundle) g[k] = D.photorealBundle[k];
      g.photoreal = true;
    } else if (!on && g.photoreal) {
      var pv = g.photorealPrev;
      if (pv) for (k in pv) { if (pv[k] === null) delete g[k]; else g[k] = pv[k]; }
      else { g.pathTracing = 0; g.rtShadows = false; }
      g.photorealPrev = null; g.photoreal = false;
    } else return;
    this.applyGraphics();
    if (TERRA.ui.panels && TERRA.ui.panels.refresh) TERRA.ui.panels.refresh('settingsPanel');
    TERRA.ui.toast(on ? 'Path tracing ON — photoreal lighting (T to turn off)' : 'Path tracing OFF — previous settings restored');
  };
  /** Called by the performance governor: step down one preset (texture quality is kept
   *  to avoid a material rebuild); at the bottom, enable performance mode. */
  P.autoLowerQuality = function () {
    var g = this.settings.graphics, D = TERRA.data;
    // photoreal mode is an explicit choice: lower its cost first instead of switching it off
    if (g.photoreal) {
      if (g.pathTracing > 1) { g.pathTracing--; this.applyGraphics(); TERRA.ui.toast('Frame rate is low — path tracing lowered to ' + ['', '1', '2', '4', '8', '16'][g.pathTracing] + ' ray(s) / pixel'); return; }
      if (g.shadowQuality > 3) { g.shadowQuality = 3; g.cloudQuality = Math.min(g.cloudQuality, 2); this.applyGraphics(); TERRA.ui.toast('Frame rate is low — shadows and clouds reduced (photoreal mode stays on)'); return; }
      return;
    }
    var order = ['cinematic', 'ultra', 'veryhigh', 'high', 'medium', 'low'];
    var i = order.indexOf(g.preset);
    if (i < 0) i = 1;
    if (i >= order.length - 1) {
      if (g.performanceMode) return;
      g.performanceMode = true;
      this.applyGraphics();
      TERRA.ui.toast('Frame rate is low — performance mode enabled (Settings → Graphics)');
    } else {
      var next = order[i + 1], tq = g.textureQuality;
      U.deepMerge(g, D.graphicsPresets[next]);
      g.textureQuality = tq; g.preset = next;
      this.applyGraphics();
      TERRA.ui.toast('Frame rate is low — graphics lowered to ' + ({ ultra: 'Ultra', veryhigh: 'Very High', high: 'High', medium: 'Medium', low: 'Low' }[next] || next) + ' (automatic quality can be turned off in Settings)');
    }
    if (TERRA.ui.panels && TERRA.ui.panels.refresh) TERRA.ui.panels.refresh('settingsPanel');
  };
  P.regenerate = function (params) {
    this.worldParams = params;
    var data = this.worldLoaded ? this.serializeWorld() : null;
    if (data) { data.params = params; data.edits = this.edits.serialize(); }
    this.startWorld(data ? { data: data } : { seed: this.seed, params: params });
  };
  P.teleport = function (x, z) {
    this.player.teleport(x, z);
    this.chunks.update(this.camera);
    TERRA.ui.toast('Travelling… terrain will stream in around you');
  };

  /* ---------------- camera ---------------- */
  P._updateCamera = function (dt) {
    var pl = this.player, cam = this.camera, g = this.settings.graphics, ctl = this.settings.controls;
    var w = pl.mode === 'free' ? pl.pos.slice(0) : (pl.camPos && pl.camPos.length ? pl.camPos : [pl.pos[0], pl.pos[1] + 1.7, pl.pos[2]]);
    if (pl.mode === 'free') w = pl.pos.slice(0);
    if (!pl.camPos || pl.camPos.length === 0) pl.camPos = w;
    cam.world = w.slice();
    // floating origin: multiples of 8192 m keep float32 precision everywhere
    var ox = Math.round(w[0] / 8192) * 8192, oz = Math.round(w[2] / 8192) * 8192;
    if (ox !== this.origin[0] || oz !== this.origin[1]) {
      var dox = this.origin[0] - ox, doz = this.origin[1] - oz;
      this.origin = [ox, oz]; this.originKey = ox + ':' + oz;
      if (this.combat) { this.combat.decals.shiftOrigin(dox, doz); this.combat.tracers.clear(); }
    }
    cam.pos = [w[0] - this.origin[0], w[1], w[2] - this.origin[1]];
    var c = this.canvas;
    cam.aspect = Math.max(0.2, (c.clientWidth || 1) / (c.clientHeight || 1));
    cam.fov = ((ctl.fov || 75) + pl.fovBoost) * Math.PI / 180;
    cam.fov = 2 * Math.atan(Math.tan(cam.fov / 2) / Math.max(1, cam.aspect / 1.78) * Math.max(1, cam.aspect / 1.78));
    var reversed = this.G.caps.reversedZ;
    cam.near = reversed ? 0.15 : 0.4; cam.far = reversed ? 1e7 : 30000;
    if (reversed) M.perspectiveReversedInf(cam.proj, cam.fov, cam.aspect, cam.near);
    else M.perspective(cam.proj, cam.fov, cam.aspect, cam.near, cam.far);
    var f = pl.forward;
    var up = pl.camUp || [Math.sin(pl.roll || 0) * Math.cos(pl.yaw), Math.cos(pl.roll || 0), -Math.sin(pl.roll || 0) * Math.sin(pl.yaw)];
    // explosions shake the camera (vehicles apply their own shake)
    var sh = this.effects && !(this.vehicles && this.vehicles.current) ? this.effects.shake : 0;
    if (sh > 0.01) { var a = sh * 0.06; cam.pos = [cam.pos[0] + (Math.random() - 0.5) * a, cam.pos[1] + (Math.random() - 0.5) * a, cam.pos[2] + (Math.random() - 0.5) * a]; }
    M.lookAt(cam.view, cam.pos, [cam.pos[0] + f[0], cam.pos[1] + f[1], cam.pos[2] + f[2]], up);
    cam.forward = f;
    M.multiply(cam.viewProj, cam.proj, cam.view);
    M.invert(cam.invViewProj, cam.viewProj);
    M.invert(cam.invView, cam.view);
    M.invert(cam.invProj, cam.proj);
    M.frustumFromMatrix(cam.viewProj, cam.planes, reversed);
  };

  P._frameState = function (dt) {
    var pl = this.player;
    var fs = this._fs || (this._fs = { trail: { x: 0, z: 0, size: 64 }, player: {} });
    fs.dt = dt; fs.time = this.time; fs.cam = this.camera; fs.origin = this.origin; fs.originWorld = this.origin; fs.originKey = this.originKey;
    fs.index = this._frameIndex = (this._frameIndex || 0) + 1;
    fs.env = this.environment.env; fs.settings = this.settings.graphics; fs.chunks = this.chunks;
    fs.player.pos = [pl.pos[0] - this.origin[0], pl.pos[1], pl.pos[2] - this.origin[1]];
    fs.player.worldPos = pl.pos; fs.player.speed = pl.speed;
    fs.debugView = this.debugView; fs.performance = this.settings.graphics.performanceMode;
    fs.flashlight = this.flashlight; fs.focusDist = this._focus || 30;
    fs.flash = 0; fs.exposureMul = 1;
    fs.drawMotion = this._drawMotionCb || (this._drawMotionCb = function () { self._drawMotion(); });
    fs.drawExtras = this._drawExtrasCb || (this._drawExtrasCb = function (shadow, vp) { self._drawExtras(shadow, vp); });
    fs.timing = this.ui && (this.ui.debugOpen || this.settings.ui.showStats !== false);
    var self = this;
    fs.drawAvatar = pl.mode === 'third' ? function (shadow, vp) { self._drawAvatar(shadow, vp); } : null;
    return fs;
  };

  /** Moving objects write world velocity into the motion buffer (frame extrapolation). */
  P._drawMotion = function () {
    if (this.vehicles) this.vehicles.drawMotion(this._fs);
    if (this.throwables && this.throwables.drawMotion) this.throwables.drawMotion(this._fs);
    if (this.tools) this.tools.drawMotion(this._fs);
    if (this.effects && this.effects.drawMotion) this.effects.drawMotion(this._fs);
  };
  /** Extra G-buffer geometry: vehicles, held tools, effect debris. */
  P._drawExtras = function (shadow, vp) {
    if (this.buildings) this.buildings.draw(this._fs, shadow, vp);
    if (this.gvehicles) this.gvehicles.draw(this._fs, shadow, vp);
    if (this.vehicles) this.vehicles.draw(this._fs, shadow, vp);
    if (this.soldiers) this.soldiers.draw(this._fs, shadow, vp);
    if (this.tools) this.tools.draw(this._fs, shadow, vp);
    if (!shadow) {
      if (this.weapons) { this.weapons.draw(this._fs, false); this.weapons.drawGrenades(this._fs); }
    }
    if (this.effects) this.effects.draw(this._fs, shadow, vp);
  };

  P._drawAvatar = function (shadow, vp) {
    var m = this.models && this.models.hiker; if (!m) return;
    var veg = this.vegetation, gl = this.G.gl, pl = this.player;
    var p = shadow ? veg.progMeshShadow : veg.progMesh;
    veg._bindMeshProg(p, this._fs, shadow, vp);
    p.f('uHeight', 1.8).f('uInteract', 0).i('uDeciduous', 0).f('uWindScale', 0);
    var inst = new Float32Array([pl.pos[0] - this.origin[0], pl.pos[1] - (pl.swimming ? 1.2 : 0) - pl.crouch * 0.5, pl.pos[2] - this.origin[1], -pl.yaw, 1, 0.5, 1, 0]);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.inst); gl.bufferData(gl.ARRAY_BUFFER, inst, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(m.vao); gl.drawElementsInstanced(gl.TRIANGLES, m.count, m.indexType, 0, 1); gl.bindVertexArray(null);
  };

  /* ---------------- main loop ---------------- */
  P._hotkeys = function () {
    var inp = this.input, ui = this.ui;
    if (this.state === 'playing' || this.state === 'paused') {
      if (inp.hit('Escape')) {
        if (ui.closeTopPanel()) { /* closed a panel */ }
        else if (this.editor.active) this.editor.toggle(false);
        else if (this.state === 'paused') this.resume();
        else this.pause();
      }
    }
    if (this.state !== 'playing') return;
    var driving = this.vehicles && this.vehicles.current;
    if (inp.hit('Tab')) { if (driving) { this.vehicles.exit(); driving = null; } this.editor.toggle(); ui.showEditor(this.editor.active); }
    if (this.vehicles && !this.editor.active) this.vehicles.handleKeys(inp);
    driving = this.vehicles && this.vehicles.current;
    if (this.tools && !this.editor.active && !driving) this.tools.handleKeys(inp);
    if (inp.hit('KeyM')) ui.toggleMap();
    if (inp.hit('KeyK')) ui.togglePanel('envPanel');
    if (inp.hit('KeyH')) ui.toggleHUD();
    if (inp.hit('F3') || inp.hit('Backquote')) ui.toggleDebug();
    if (inp.hit('KeyL')) { if (!(driving && this.vehicles.toggleLights())) { this.flashlight.on = !this.flashlight.on; this.audio.click(); } }
    if (inp.hit('KeyT')) this.setPhotoreal();
    // physics playground: G throw (Shift = harder, Ctrl = remove all), B change object
    if (this.throwables && !this.editor.active && !driving && !(this.tools && this.tools.handlesThrow) && !(this.weapons && this.weapons.enabled)) {
      if (inp.hit('KeyG') || inp.hit('KeyY')) {
        if (inp.down('ControlLeft') || inp.down('ControlRight') || inp.down('MetaLeft') || inp.down('MetaRight')) { this.throwables.clear(); TERRA.ui.toast('Removed all thrown objects'); }
        else this.throwables.throwObject(inp.down('ShiftLeft') || inp.down('ShiftRight'));
      }
      if (inp.hit('KeyB')) this.throwables.cycle();
    }
    if (inp.hit('KeyP')) ui.screenshot();
    if (inp.hit('KeyV') && driving) this.vehicles.toggleCamera();
    else if (inp.hit('KeyV') && !this.editor.active) {
      var modes = ['first', 'third', 'free'], i = modes.indexOf(this.player.mode);
      this.player.mode = modes[(i + 1) % 3];
      if (this.player.mode === 'first') { var h = this.groundHeight(this.player.pos[0], this.player.pos[2]); if (this.player.pos[1] > h + 3) this.player.vel[1] = 0; }
      TERRA.ui.toast({ first: 'First-person camera', third: 'Third-person camera', free: 'Free camera — Space/C up/down, wheel = speed' }[this.player.mode]);
    }
  };

  P._frame = function (now) {
    var dt = Math.min(0.1, Math.max(0.0001, (now - this._last) / 1000));
    this._last = now;
    var t0 = performance.now();
    // frame extrapolation: this display refresh may show a generated frame instead of a render
    var fg = this.renderer && this.renderer.frameGen;
    var gen = !!(fg && this.worldLoaded && fg.wantGenerate(this));
    this._hotkeys();
    if (this.state === 'menu' || this.state === 'loading' || !this.worldLoaded) {
      this.ui.menuBackdrop(dt);
      this.input.endFrame();
      if (!this.worldLoaded) return;
      if (this.state === 'loading') return;
    }
    var active = this.state === 'playing';
    var simDt = active ? dt : 0;
    this.time += simDt;
    this.engineTime = this.time;
    // simulation
    if (active && !this.ui.mapOpen) {
      var driving = this.vehicles && this.vehicles.current;
      if (driving) this.vehicles.updateDriver(dt, this.input);
      else if (this.input.locked || this.editor.active || this.player.mode === 'free') this.player.update(dt, this.input, this.settings, this.environment.env);
      else { var mx = this.input.mouse.dx; this.input.mouse.dx = 0; this.input.mouse.dy = 0; this.player.update(dt, this.input, this.settings, this.environment.env); void mx; }
      this.editor.update(dt, this.input);
      if (this.vehicles) this.vehicles.update(simDt);
      if (this.tools) this.tools.update(simDt, this.input);
      if (this.throwables) this.throwables.update(simDt);
      if (this.effects) this.effects.update(simDt);
    }
    var pl = this.player;
    this.flashlight.dir = pl.forward;
    this._updateCamera(dt);
    if (gen) {
      // generated frame: simulation & camera advanced above; present a re-projection of the last real frame
      this._envAcc = (this._envAcc || 0) + simDt;
      if (fg.generate(this)) {
        this.perf.display(dt);
        this.ui.update(dt, this._frameState(dt));
        this.input.endFrame();
        return;
      }
    }
    var envDt = simDt + (this._envAcc || 0); this._envAcc = 0;
    this.environment.update(envDt, this.camera.world, pl.pos);
    var env = this.environment.env;
    // lightning bolts & relics
    var w = this.environment.weather;
    if (w.strike && w.strike.bolt && this.renderer.particles) {
      var a = w.strike.angle, d = Math.min(w.strike.dist, 3000);
      var bx = this.camera.pos[0] + Math.cos(a) * d, bz = this.camera.pos[2] + Math.sin(a) * d;
      var gy = this.gen.height(bx + this.origin[0], bz + this.origin[1]);
      this.renderer.particles.spawnBolt(this._frameState(dt), bx, bz, gy, env.cloudBase);
    }
    if (active) {
      var got = this.vegetation.tryCollect(pl.pos);
      if (got) { this.relics++; this.audio.chime(); TERRA.ui.toast('Relic recovered at ' + got.name + ' · ' + this.relics + ' found', 'discover'); }
    }
    // focus distance for depth of field
    this._focusT = (this._focusT || 0) - dt;
    if (this._focusT <= 0 && this.settings.graphics.dof) {
      this._focusT = 0.25;
      var hit = this._rayGround(this.camera.world, pl.forward, 800);
      this._focus = U.mix(this._focus || 30, hit || 800, 0.5);
    }
    var fs = this._frameState(dt);
    fs.flash = Math.min(0.12, env.lightningFlash * 0.05);
    this.chunks.update(this.camera);
    this.vegetation.update(fs);
    if (this.combat && active && !this.ui.mapOpen) {
      if (this.buildings) this.buildings.update(fs);
      if (this.soldiers) this.soldiers.update(fs);
      if (this.gvehicles) this.gvehicles.update(fs);
      if (this.weapons) { this.weapons.update(fs); this.weapons.updateGrenades(fs.dt, fs); }
      if (this.warmode) this.warmode.update(fs);
      this.combat.update(fs.dt);
    }
    this.audio.update(simDt, env, this.environment.local, pl);
    this.map.update();
    // render
    this.renderer.render(fs);
    var cpu = performance.now() - t0;
    // native (real) frame timing vs. displayed frames (real + generated)
    var realDt = Math.min(0.25, Math.max(0.0001, (now - (this._lastReal || now - dt * 1000)) / 1000));
    this._lastReal = now;
    this.perf.frame(realDt, cpu);
    this.perf.display(dt);
    this.perf.adapt(this.renderer, this.settings.graphics, realDt, this);
    this.ui.update(dt, fs);
    this.input.endFrame();
  };

  P._rayGround = function (o, d, maxD) {
    var t = 0.5;
    while (t < maxD) {
      var x = o[0] + d[0] * t, y = o[1] + d[1] * t, z = o[2] + d[2] * t;
      if (y < this.groundHeight(x, z)) return t;
      t += Math.max(0.5, t * 0.05);
    }
    return null;
  };

  U.tick = function () { return new Promise(function (r) { requestAnimationFrame(function () { r(); }); }); };
  U.sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  window.addEventListener('load', function () {
    try { new Engine(); } catch (e) { console.error(e); if (TERRA.ui.fatal) TERRA.ui.fatal(e.message); }
  });
})();
