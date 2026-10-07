/* =============================================================================
 * TERRA INFINITA — day/night cycle, sun & moon ephemeris, seasons
 * World axes: +x east, +y up, +z south (north = -z).
 * ========================================================================== */
(function () {
  'use strict';
  var U = TERRA.util;
  var DEG = Math.PI / 180;

  function TimeOfDay() {
    this.hours = 9.5;           // 0..24
    this.dayMinutes = 24;       // real minutes per in-game day
    this.paused = false;
    this.speed = 1;
    this.latitude = 42;         // degrees
    this.season = 0.3;          // 0 spring, .25 summer, .5 autumn, .75 winter
    this.autoSeason = false;
    this.day = 0;
  }
  var P = TimeOfDay.prototype;

  P.update = function (dt) {
    if (this.paused) return;
    var hoursPerSec = 24 / (this.dayMinutes * 60) * this.speed;
    this.hours += dt * hoursPerSec;
    if (this.hours >= 24) { this.hours -= 24; this.day++; if (this.autoSeason) this.season = (this.season + 1 / 24) % 1; }
    if (this.hours < 0) this.hours += 24;
  };

  /** Solar declination from the season parameter (0 = spring equinox). */
  P.declination = function () { return 23.44 * DEG * Math.sin(this.season * Math.PI * 2); };

  function dirFromHour(hourAngle, dec, lat) {
    var x = -Math.cos(dec) * Math.sin(hourAngle);
    var y = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(hourAngle);
    var north = Math.cos(lat) * Math.sin(dec) - Math.sin(lat) * Math.cos(dec) * Math.cos(hourAngle);
    var v = [x, y, -north];
    var l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  }

  P.sunDir = function () {
    return dirFromHour((this.hours - 12) * 15 * DEG, this.declination(), this.latitude * DEG);
  };
  /** Moon phase (0 new … 0.5 full … 1) advances ~12.2° per day relative to the sun. */
  P.moonPhase = function () { return ((this.day + this.hours / 24) / 29.53 + 0.35) % 1; };
  P.moonDir = function () {
    var ph = this.moonPhase();
    var ha = (this.hours - 12) * 15 * DEG - ph * Math.PI * 2;
    return dirFromHour(ha, -this.declination() * 0.8 + 5 * DEG, this.latitude * DEG);
  };
  P.label = function () {
    var h = this.hours;
    if (h < 4.5) return 'Night';
    if (h < 6) return 'Dawn';
    if (h < 7.5) return 'Sunrise';
    if (h < 11) return 'Morning';
    if (h < 13.5) return 'Noon';
    if (h < 17) return 'Afternoon';
    if (h < 19) return 'Sunset';
    if (h < 20.5) return 'Twilight';
    return 'Night';
  };
  P.seasonLabel = function () { var s = this.season; return s < 0.125 || s >= 0.875 ? (s >= 0.875 ? 'Late Winter' : 'Spring') : s < 0.375 ? 'Summer' : s < 0.625 ? 'Autumn' : 'Winter'; };

  /* Atmospheric transmittance toward a direction (CPU mirror of the shader model),
     used to derive the sun/moon light colour for the frame uniforms. */
  var R_P = 6360e3, R_A = 6460e3;
  var BR = [5.802e-6, 13.558e-6, 33.1e-6], BM = 4.44e-6, BO = [0.65e-6, 1.881e-6, 0.085e-6];
  P.transmittance = function (dir, alt, haze, dustTint) {
    var ro = [0, R_P + Math.max(1, alt), 0];
    var b = ro[1] * dir[1];
    var c = ro[1] * ro[1] - R_A * R_A;
    var disc = b * b - c;
    if (disc < 0) return [1, 1, 1];
    var len = -b + Math.sqrt(disc);
    // ground occlusion (soft to avoid a hard cut at the horizon)
    var cg = ro[1] * ro[1] - R_P * R_P, dg = b * b - cg;
    var occl = 1;
    if (dg > 0 && -b - Math.sqrt(dg) > 0) occl = 0;
    var odR = 0, odM = 0, odO = 0, n = 12, st = len / n;
    for (var i = 0; i < n; i++) {
      var t = (i + 0.5) * st;
      var px = dir[0] * t, py = ro[1] + dir[1] * t, pz = dir[2] * t;
      var h = Math.sqrt(px * px + py * py + pz * pz) - R_P;
      h = Math.max(0, h);
      odR += Math.exp(-h / 8000) * st; odM += Math.exp(-h / 1200) * (1 + haze) * st; odO += Math.max(0, 1 - Math.abs(h - 25000) / 15000) * st;
    }
    dustTint = dustTint || [1, 1, 1];
    return [0, 1, 2].map(function (k) { return occl * Math.exp(-(BR[k] * odR + BM * odM * dustTint[k] + BO[k] * odO)); });
  };

  TERRA.env.TimeOfDay = TimeOfDay;
})();
