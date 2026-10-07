/* =============================================================================
 * TERRA INFINITA — dynamic weather, wind and surface state
 * -----------------------------------------------------------------------------
 * Weather is a set of continuous parameters (cloud, rain, snow, fog, wind, storm,
 * dust, lightning) that always *approach* the targets of the selected weather
 * type at physically-motivated rates, so changes are gradual:
 *   clouds build → rain starts only once it's overcast → storm → rain stops → clears.
 * In automatic mode a biome-aware Markov chain picks the next weather.
 * ========================================================================== */
(function () {
  'use strict';
  var U = TERRA.util, D = TERRA.data;

  /* ---------------- weather ---------------- */
  function Weather() {
    this.type = 'clear';
    this.auto = true;
    this.p = { cloud: 0.15, rain: 0, snow: 0, fog: 0, wind: 0.25, storm: 0, dust: 0, lightning: 0 };
    this.nextChange = 240;      // seconds until auto change
    this.transitionSpeed = 1;
    this.lightningTimer = 3;
    this.flash = 0;
    this.pendingThunder = [];
  }
  var W = Weather.prototype;

  W.set = function (type, instant) {
    if (!D.weatherTypes[type]) return;
    this.type = type;
    if (instant) { var t = D.weatherTypes[type]; for (var k in this.p) this.p[k] = t[k]; }
    TERRA.events.emit('weather', type);
  };

  // Markov chain of plausible successions
  var NEXT = {
    clear: [['clear', 2], ['partlyCloudy', 4], ['windy', 1], ['fog', 0.6]],
    partlyCloudy: [['clear', 3], ['overcast', 3], ['partlyCloudy', 2], ['windy', 1]],
    overcast: [['lightRain', 3], ['partlyCloudy', 2], ['fog', 1], ['snow', 1]],
    lightRain: [['heavyRain', 2], ['overcast', 2], ['lightRain', 1]],
    heavyRain: [['storm', 2], ['lightRain', 2], ['overcast', 1]],
    storm: [['thunderstorm', 2], ['heavyRain', 2]],
    thunderstorm: [['heavyRain', 2], ['storm', 1]],
    fog: [['denseFog', 1], ['partlyCloudy', 2], ['clear', 1]],
    denseFog: [['fog', 2], ['overcast', 1]],
    snow: [['blizzard', 1], ['overcast', 2], ['snow', 1]],
    blizzard: [['snow', 2]],
    windy: [['clear', 2], ['partlyCloudy', 2], ['sandstorm', 0.5]],
    sandstorm: [['windy', 2], ['clear', 1]]
  };
  function pick(list) {
    var tot = 0, i; for (i = 0; i < list.length; i++) tot += list[i][1];
    var r = Math.random() * tot;
    for (i = 0; i < list.length; i++) { r -= list[i][1]; if (r <= 0) return list[i][0]; }
    return list[0][0];
  }

  /** ctx: { dt, temp (°C at player), arid (0..1), cold, desert } */
  W.update = function (ctx) {
    var dt = ctx.dt;
    if (this.auto) {
      this.nextChange -= dt;
      if (this.nextChange <= 0) {
        var n = pick(NEXT[this.type] || NEXT.clear);
        // climate-aware substitutions
        if (ctx.desert && (n === 'lightRain' || n === 'heavyRain')) n = Math.random() < 0.5 ? 'windy' : 'partlyCloudy';
        if (ctx.desert && n === 'windy' && Math.random() < 0.35) n = 'sandstorm';
        if (!ctx.desert && n === 'sandstorm') n = 'windy';
        if (ctx.temp > 4 && (n === 'snow' || n === 'blizzard')) n = 'lightRain';
        this.set(n);
        this.nextChange = 150 + Math.random() * 300;
      }
    }
    var tgt = D.weatherTypes[this.type];
    var p = this.p, sp = this.transitionSpeed;
    // Precipitation needs clouds first; clouds clear only after precipitation stops.
    var precipGate = U.smoothstep(0.55, 0.8, p.cloud);
    var cold = U.smoothstep(1.5, -1.0, ctx.temp);
    var precip = Math.max(tgt.rain, tgt.snow);
    var rainT = precip * precipGate * (1 - cold);
    var snowT = precip * precipGate * cold;
    var cloudT = Math.max(tgt.cloud, (p.rain + p.snow) > 0.05 ? 0.8 : 0);
    function approach(cur, target, up, down) { return U.approach(cur, target, (target > cur ? up : down) * dt * sp); }
    p.cloud = approach(p.cloud, cloudT, 0.018, 0.012);
    p.rain = approach(p.rain, rainT, 0.02, 0.03);
    p.snow = approach(p.snow, snowT, 0.02, 0.025);
    p.fog = approach(p.fog, Math.max(tgt.fog, ctx.desert ? tgt.dust * 0.8 : 0), 0.015, 0.012);
    p.wind = approach(p.wind, tgt.wind, 0.03, 0.02);
    p.storm = approach(p.storm, tgt.storm, 0.015, 0.012);
    p.dust = approach(p.dust, ctx.desert || ctx.arid > 0.3 ? tgt.dust : tgt.dust * 0.2, 0.02, 0.02);
    p.lightning = approach(p.lightning, tgt.lightning * precipGate, 0.05, 0.05);
    // lightning strikes
    this.flash = Math.max(0, this.flash - dt * 6);
    this.strike = null;
    if (p.lightning > 0.02) {
      this.lightningTimer -= dt;
      if (this.lightningTimer <= 0) {
        this.lightningTimer = 2 + Math.random() * 12 / (0.2 + p.lightning);
        var dist = 400 + Math.random() * 5000;
        this.flash = Math.min(1.2, 0.35 + 1500 / dist);
        this.strike = { dist: dist, angle: Math.random() * Math.PI * 2, bolt: dist < 3500 && Math.random() < 0.8 };
        this.pendingThunder.push({ t: dist / 343, dist: dist });
      }
    }
    for (var i = this.pendingThunder.length - 1; i >= 0; i--) {
      var th = this.pendingThunder[i];
      th.t -= dt;
      if (th.t <= 0) { TERRA.events.emit('thunder', th.dist); this.pendingThunder.splice(i, 1); }
    }
  };
  W.name = function () { return D.weatherTypes[this.type].name; };

  /* ---------------- wind ---------------- */
  function Wind() {
    this.angle = 0.6;       // radians (direction the wind blows toward)
    this.override = null;   // {angle, strength} from the editor
    this.base = 0.25;
    this.dir = [Math.cos(0.6), Math.sin(0.6)];
    this.strength = 0.25; this.gust = 0; this.t = 0;
  }
  Wind.prototype.update = function (dt, weatherWind, local) {
    this.t += dt;
    var n = TERRA.core.snoise(this.t * 0.01, 3.3, 99);
    if (!this.override) this.angle += n * dt * 0.02;
    var ang = this.override ? this.override.angle : this.angle;
    this.dir[0] = Math.cos(ang); this.dir[1] = Math.sin(ang);
    var base = this.override ? this.override.strength : weatherWind;
    // gusts: layered noise in time
    var g = TERRA.core.snoise(this.t * 0.35, 1.7, 7) * 0.6 + TERRA.core.snoise(this.t * 1.3, 8.1, 8) * 0.4;
    this.gust = U.clamp01(g * 0.5 + 0.5);
    // local modulation: stronger at altitude and in the open, weaker in forests
    var mod = 1 + U.clamp(local.altitude / 1500, 0, 0.8) - local.forest * 0.45 + local.open * 0.15;
    var target = base * mod * (0.75 + 0.5 * this.gust);
    this.strength = U.damp(this.strength, target, 1.5, dt);
  };

  /* ---------------- surface state: wetness, puddles, snow cover ---------------- */
  function Surface() { this.wetness = 0; this.puddles = 0; this.snowCover = 0; this.rainbow = 0; this._wasRaining = 0; }
  Surface.prototype.update = function (dt, w, temp, sunUp, windS) {
    var p = w.p;
    var dry = (0.002 + 0.006 * sunUp + 0.003 * windS) * U.clamp((temp + 5) / 25, 0.2, 1.6);
    this.wetness = U.clamp01(this.wetness + p.rain * 0.06 * dt - (p.rain < 0.02 ? dry * dt : 0));
    if (p.rain > 0.1 && this.wetness > 0.4) this.puddles = U.clamp01(this.puddles + p.rain * 0.012 * dt);
    else this.puddles = U.clamp01(this.puddles - dry * 0.35 * dt);
    if (temp < 1) this.snowCover = U.clamp01(this.snowCover + p.snow * 0.012 * dt);
    if (temp > 1.5) {
      var melt = (temp - 1.5) * 0.0015 * dt * (0.5 + sunUp);
      this.snowCover = U.clamp01(this.snowCover - melt);
      if (this.snowCover > 0.01) this.wetness = U.clamp01(this.wetness + melt * 2); // slush
    }
    // rainbow: rain just stopped, sun low behind the viewer
    if (p.rain > 0.25) this._wasRaining = 1;
    this._wasRaining = Math.max(0, this._wasRaining - dt / 120);
    var want = this._wasRaining * U.smoothstep(0.3, 0.02, p.rain) * sunUp * (1 - U.smoothstep(0.7, 0.95, p.cloud));
    this.rainbow = U.damp(this.rainbow, want, 0.5, dt);
  };

  TERRA.env.Weather = Weather;
  TERRA.env.Wind = Wind;
  TERRA.env.Surface = Surface;
})();
