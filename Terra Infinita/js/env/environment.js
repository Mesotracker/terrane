/* =============================================================================
 * TERRA INFINITA — environment aggregator
 * Combines time of day, weather, wind, surface state and the local climate at
 * the player into the flat `env` record consumed by the renderer and audio.
 * ========================================================================== */
(function () {
  'use strict';
  var U = TERRA.util, E = TERRA.env;

  function Environment(engine) {
    this.engine = engine;
    this.time = new E.TimeOfDay();
    this.weather = new E.Weather();
    this.wind = new E.Wind();
    this.surface = new E.Surface();
    this.local = { temp: 14, baseTemp: 14, moist: 0.5, arid: 0, forest: 0, altitude: 0, biome: 5, volc: 0, mtn: 0, wprox: 0, ground: 0, water: -1e5, wtype: 0, open: 0.5, cont: 0.5 };
    this._sampleT = 0;
    this._s = null;
    this.env = {
      sunDir: [0, 1, 0], moonDir: [0, -1, 0], moonPhase: 0.5, lightDir: [0, 1, 0], lightColor: [1, 1, 1], lightIntensity: 1,
      sunI: 22, moonI: 0.03, dayFactor: 1, ambientScale: 1.7, groundColor: [0.2, 0.2, 0.15], giStrength: 1,
      fogDensity: 0.0001, fogFalloff: 0.002, fogBase: 0, fogAmount: 0, fogTint: [1, 1, 1], mie: 0.5, humidity: 0.5,
      windDir: [1, 0], windStrength: 0.3, gust: 0, wetness: 0, puddles: 0, snowCover: 0, rain: 0, snow: 0,
      cloudCover: 0.2, storm: 0, lightningFlash: 0, dust: 0, cloudBase: 1600, cloudThickness: 1400, cloudDensity: 1,
      cloudShadow: 0.6, season: 0.3, seaLevel: 0, tempAtCam: 14, aurora: 0, rainbow: 0, underwater: false,
      fireflies: 0, leaves: 0, embers: 0, motes: 0, waterTint: [0.1, 0.35, 0.4], volcanic: 0
    };
  }
  var P = Environment.prototype;

  P._sampleLocal = function (pos) {
    var gen = this.engine.gen;
    if (!gen) return;
    if (!this._s) this._s = gen.newSample();
    var o = gen.sample(pos[0], pos[2], this._s, 0);
    var L = this.local;
    var ed = this.engine.edits;
    L.baseTemp = o.temp; L.moist = o.moist; L.arid = o.arid; L.volc = o.volc; L.mtn = o.mtn; L.wprox = o.wprox; L.cont = o.cont;
    L.ground = o.h + (ed ? ed.heightDelta(pos[0], pos[2]) : 0);
    L.forest = gen.forestDensity(o, Math.hypot(o.gx, o.gz), pos[0], pos[2]);
    L.altitude = Math.max(0, pos[1] - gen.SEA);
    L.open = 1 - L.forest;
    var sl = Math.hypot(o.gx, o.gz);
    L.biome = gen.classify(o, sl);
    L.biomeName = TERRA.core.BIOME_NAMES[L.biome];
    L.water = o.water; L.wtype = o.wtype;
    var wov = ed ? ed.waterAt(pos[0], pos[2]) : null;
    if (wov !== null) { L.water = wov; L.wtype = wov > -1e4 ? 2 : 0; }
    L.rdist = o.rdist;
  };

  P.update = function (dt, camWorld, playerWorld) {
    var L = this.local, env = this.env, w = this.weather, t = this.time;
    this._sampleT -= dt;
    if (this._sampleT <= 0) { this._sampleLocal(playerWorld); this._sampleT = 0.4; }
    t.update(dt);
    var season = t.season;
    var seasonal = -Math.cos((season - 0.25) * Math.PI * 2) * 7.5;        // summer +7.5, winter -7.5
    var diurnal = -Math.cos((t.hours - 3) / 24 * Math.PI * 2) * 3.5;      // warmest mid-afternoon
    L.temp = L.baseTemp + seasonal + diurnal - w.p.storm * 3 - w.p.rain * 2;
    w.update({ dt: dt, temp: L.temp, arid: L.arid, desert: L.arid > 0.55 });
    this.wind.update(dt, w.p.wind, L);
    var sunDir = t.sunDir(), moonDir = t.moonDir();
    var sunEl = sunDir[1];
    var sunUp = U.smoothstep(-0.05, 0.25, sunEl);
    this.surface.update(dt, w, L.temp, sunUp, this.wind.strength);

    // ---- light sources
    var phase = t.moonPhase(), illum = 0.5 * (1 - Math.cos(phase * Math.PI * 2));
    env.sunI = 22; env.moonI = 0.045 * (0.15 + 0.85 * illum);
    var haze = 0.1 + env.fogAmount * 5 + w.p.dust * 10 + L.moist * 0.35;
    var tint = [1 + w.p.dust * 0.2, 1 + w.p.dust * 0.6, 1 + w.p.dust * 1.6];
    var alt = Math.max(0, camWorld[1]);
    var useSun = sunEl > -0.035;
    var dir = useSun ? sunDir : moonDir;
    var I = useSun ? env.sunI * U.smoothstep(-0.035, 0.03, sunEl) : env.moonI * U.smoothstep(-0.035, -0.09, sunEl) * U.smoothstep(-0.02, 0.1, moonDir[1]);
    var T = t.transmittance(dir, alt, haze, tint);
    var cloudDim = 1 - w.p.storm * 0.5;
    env.lightColor = [T[0] * I * cloudDim, T[1] * I * cloudDim, T[2] * I * cloudDim];
    if (!useSun) { env.lightColor[0] *= 0.75; env.lightColor[1] *= 0.87; env.lightColor[2] *= 1.1; }
    env.lightDir = dir.slice();
    if (env.lightDir[1] < 0.03) { env.lightDir[1] = 0.03; var ll = Math.hypot(env.lightDir[0], env.lightDir[1], env.lightDir[2]); env.lightDir = env.lightDir.map(function (v) { return v / ll; }); }
    env.lightIntensity = I;
    env.sunDir = sunDir; env.moonDir = moonDir; env.moonPhase = phase;
    env.dayFactor = U.smoothstep(-0.12, 0.15, sunEl);

    // ---- weather-driven parameters
    env.rain = w.p.rain; env.snow = w.p.snow; env.storm = w.p.storm; env.dust = w.p.dust;
    env.cloudCover = w.p.cloud;
    env.lightningFlash = w.flash;
    env.wetness = this.surface.wetness; env.puddles = this.surface.puddles; env.snowCover = this.surface.snowCover;
    env.windDir = this.wind.dir; env.windStrength = this.wind.strength; env.gust = this.wind.gust;
    env.season = season;
    env.tempAtCam = L.temp;
    env.humidity = L.moist;

    // ---- fog: weather fog hugs the ground near the player; morning haze in humid valleys
    var morning = U.smoothstep(4.5, 6.5, t.hours) * (1 - U.smoothstep(8, 10.5, t.hours)) * U.smoothstep(0.45, 0.8, L.moist) * (1 - w.p.wind);
    var fogAmt = U.clamp01(w.p.fog + morning * 0.35 + w.p.snow * 0.3 + w.p.dust * 0.8 + w.p.rain * 0.15);
    env.fogAmount = fogAmt;
    env.fogDensity = 0.000012 + fogAmt * fogAmt * 0.018 + w.p.rain * 0.0009 + w.p.snow * 0.004 + w.p.dust * 0.01;
    env.fogFalloff = fogAmt > 0.05 ? U.mix(1 / 900, 1 / 140, U.smoothstep(0.05, 0.7, fogAmt)) : 1 / 1200;
    env.fogBase = U.damp(env.fogBase || L.ground, L.ground - (fogAmt > 0.3 ? 5 : 60), 0.5, dt);
    env.fogTint = w.p.dust > 0.05 ? [U.mix(1, 1.25, w.p.dust), U.mix(1, 0.95, w.p.dust), U.mix(1, 0.62, w.p.dust)] : [1, 1, 1];
    env.mie = 0.35 + L.moist * 0.5 + fogAmt;

    // ---- clouds
    env.cloudBase = Math.max(1500, L.ground + 700) - w.p.storm * 300;
    env.cloudThickness = 1300 + w.p.storm * 1600;
    env.cloudDensity = 0.9 + w.p.storm * 0.9 + w.p.rain * 0.4;
    env.cloudShadow = 0.2 + 0.65 * U.smoothstep(0.3, 0.9, w.p.cloud);

    // ---- ambient
    env.ambientScale = 1.8;
    var bc = TERRA.core.BIOME_COLORS[L.biome] || [120, 120, 100];
    env.groundColor = [Math.pow(bc[0] / 255, 2.2) * 0.9, Math.pow(bc[1] / 255, 2.2) * 0.9, Math.pow(bc[2] / 255, 2.2) * 0.9];
    env.giStrength = 1.0;
    env.seaLevel = this.engine.gen ? this.engine.gen.SEA : 0;

    // ---- special effects
    var night = 1 - env.dayFactor;
    env.aurora = night * U.smoothstep(3, -4, L.temp) * (1 - U.smoothstep(0.3, 0.7, w.p.cloud));
    env.rainbow = this.surface.rainbow * U.smoothstep(0.05, 0.2, sunEl) * (1 - U.smoothstep(0.35, 0.6, sunEl));
    var summer = U.smoothstep(0.1, 0.2, season) * (1 - U.smoothstep(0.42, 0.5, season));
    env.fireflies = night * summer * U.smoothstep(10, 16, L.temp) * (1 - w.p.rain * 4) * U.clamp01(L.forest + L.moist * 0.6);
    var autumn = U.smoothstep(0.42, 0.52, season) * (1 - U.smoothstep(0.7, 0.78, season));
    env.leaves = autumn * U.clamp01(L.forest * 1.5) * (0.4 + w.p.wind) * U.smoothstep(4, 10, L.temp);
    env.embers = U.smoothstep(0.3, 0.8, L.volc);
    env.motes = env.dayFactor * (1 - w.p.rain) * (1 - w.p.snow) * 0.6 * (0.4 + L.forest);
    env.volcanic = L.volc;

    // ---- underwater (camera below a water surface)
    var camWater = this.engine.cameraWaterLevel ? this.engine.cameraWaterLevel() : -1e5;
    env.underwater = camWater > camWorld[1] + 0.05;
    env.waterTint = L.wtype === 1 ? [0.06, 0.28, 0.34] : [0.1, 0.3, 0.26];
    if (env.underwater) { env.fogDensity = 0.08; env.fogFalloff = 0.0001; env.fogBase = camWater; env.fogTint = [0.25, 0.8, 0.85]; }
    return env;
  };

  P.serialize = function () {
    return { hours: this.time.hours, day: this.time.day, dayMinutes: this.time.dayMinutes, paused: this.time.paused, season: this.time.season, latitude: this.time.latitude,
      weather: this.weather.type, auto: this.weather.auto, p: Object.assign({}, this.weather.p), wetness: this.surface.wetness, puddles: this.surface.puddles, snowCover: this.surface.snowCover,
      wind: this.wind.override };
  };
  P.deserialize = function (d) {
    if (!d) return;
    var t = this.time;
    t.hours = d.hours !== undefined ? d.hours : t.hours; t.day = d.day || 0; t.dayMinutes = d.dayMinutes || t.dayMinutes; t.paused = !!d.paused;
    t.season = d.season !== undefined ? d.season : t.season; t.latitude = d.latitude || t.latitude;
    this.weather.type = d.weather || 'clear'; this.weather.auto = d.auto !== false;
    if (d.p) Object.assign(this.weather.p, d.p);
    this.surface.wetness = d.wetness || 0; this.surface.puddles = d.puddles || 0; this.surface.snowCover = d.snowCover || 0;
    this.wind.override = d.wind || null;
  };

  TERRA.env.Environment = Environment;
})();
