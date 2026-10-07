/* =============================================================================
 * TERRA INFINITA — procedural environmental audio (Web Audio API)
 * Everything is synthesised at runtime (no audio files needed): wind, gusts,
 * rain, thunder, rivers, ocean surf, forest rustle, birds, crickets, frogs,
 * volcanic rumble and surface-specific footsteps. Optional sample overrides
 * could be placed in assets/audio (see README) when served over http.
 * ========================================================================== */
(function () {
  'use strict';
  var U = TERRA.util;

  function AudioEngine() { this.ctx = null; this.ready = false; this.muted = false; this._birdT = 2; this._cricketT = 0; this._frogT = 3; this._dripT = 0; }
  var P = AudioEngine.prototype;

  P.init = function (settings) {
    if (this.ctx) { this.resume(); return; }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { this.ctx = new AC(); } catch (e) { return; }
    var c = this.ctx;
    this.master = c.createGain(); this.master.gain.value = 0;
    var comp = c.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 3;
    this.lowpass = c.createBiquadFilter(); this.lowpass.type = 'lowpass'; this.lowpass.frequency.value = 20000;
    this.master.connect(this.lowpass); this.lowpass.connect(comp); comp.connect(c.destination);
    this.amb = c.createGain(); this.amb.connect(this.master);
    this.fx = c.createGain(); this.fx.connect(this.master);
    this.noise = this._noiseBuffer('white', 4);
    this.pink = this._noiseBuffer('pink', 6);
    this.brown = this._noiseBuffer('brown', 6);
    // continuous layers
    this.L = {};
    this.L.wind = this._loop(this.pink, [['bandpass', 420, 0.7]], this.amb);
    this.L.whistle = this._loop(this.noise, [['bandpass', 1500, 8]], this.amb);
    this.L.rain = this._loop(this.noise, [['highpass', 900, 0.5], ['lowpass', 7500, 0.5]], this.amb);
    this.L.rainHeavy = this._loop(this.pink, [['lowpass', 1800, 0.6]], this.amb);
    this.L.river = this._loop(this.noise, [['bandpass', 700, 1.4]], this.amb);
    this.L.river2 = this._loop(this.pink, [['bandpass', 1900, 2.5]], this.amb);
    this.L.ocean = this._loop(this.brown, [['lowpass', 650, 0.5]], this.amb);
    this.L.rustle = this._loop(this.noise, [['bandpass', 4200, 0.9]], this.amb);
    this.L.rumble = this._loop(this.brown, [['lowpass', 120, 0.7]], this.amb);
    this.L.underwater = this._loop(this.brown, [['lowpass', 400, 0.8]], this.amb);
    this.L.sand = this._loop(this.noise, [['bandpass', 2500, 0.6]], this.amb);
    this.ready = true;
    this.apply(settings);
    this.resume();
  };
  P.resume = function () { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); };
  P.apply = function (s) {
    if (!this.ctx) return;
    var t = this.ctx.currentTime;
    this.muted = !!s.muted;
    this.master.gain.setTargetAtTime(s.muted ? 0 : s.master * 0.9, t, 0.3);
    this.amb.gain.setTargetAtTime(s.ambience, t, 0.3);
    this.fx.gain.setTargetAtTime(s.effects, t, 0.3);
  };

  P._noiseBuffer = function (kind, secs) {
    var c = this.ctx, n = Math.floor(c.sampleRate * secs), buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
    var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (var i = 0; i < n; i++) {
      var w = Math.random() * 2 - 1;
      if (kind === 'white') d[i] = w * 0.5;
      else if (kind === 'pink') {
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
      } else { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    }
    return buf;
  };
  P._loop = function (buf, filters, dest) {
    var c = this.ctx, src = c.createBufferSource();
    src.buffer = buf; src.loop = true;
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    var node = src, fl = [];
    filters.forEach(function (f) { var bq = c.createBiquadFilter(); bq.type = f[0]; bq.frequency.value = f[1]; bq.Q.value = f[2]; node.connect(bq); node = bq; fl.push(bq); });
    var g = c.createGain(); g.gain.value = 0;
    node.connect(g); g.connect(dest);
    src.start(0, Math.random() * buf.duration);
    return { src: src, filters: fl, gain: g };
  };
  P._set = function (layer, v, tc) { layer.gain.gain.setTargetAtTime(Math.max(0, v), this.ctx.currentTime, tc || 0.4); };

  /** One-shot noise burst through a filter with an envelope. */
  P._burst = function (opts) {
    var c = this.ctx, t = c.currentTime + (opts.delay || 0);
    var src = c.createBufferSource(); src.buffer = opts.buf || this.noise;
    src.playbackRate.value = opts.rate || 1;
    var f = c.createBiquadFilter(); f.type = opts.type || 'bandpass'; f.frequency.value = opts.freq || 1000; f.Q.value = opts.q || 1;
    if (opts.sweep) f.frequency.setTargetAtTime(opts.sweep, t, opts.len * 0.4);
    var g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(opts.gain || 0.5, t + (opts.attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0008, t + opts.len);
    var pan = c.createStereoPanner ? c.createStereoPanner() : null;
    src.connect(f); f.connect(g);
    if (pan) { pan.pan.value = opts.pan || 0; g.connect(pan); pan.connect(opts.dest || this.fx); } else g.connect(opts.dest || this.fx);
    src.start(t, Math.random() * (src.buffer.duration - opts.len - 0.1)); src.stop(t + opts.len + 0.05);
  };
  P._tone = function (opts) {
    var c = this.ctx, t = c.currentTime + (opts.delay || 0);
    var o = c.createOscillator(); o.type = opts.wave || 'sine';
    o.frequency.setValueAtTime(opts.f0, t);
    if (opts.f1) o.frequency.exponentialRampToValueAtTime(opts.f1, t + opts.len);
    var g = c.createGain(); g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(opts.gain || 0.2, t + (opts.attack || 0.01));
    g.gain.exponentialRampToValueAtTime(0.0005, t + opts.len);
    var pan = c.createStereoPanner ? c.createStereoPanner() : null;
    o.connect(g);
    if (pan) { pan.pan.value = opts.pan || 0; g.connect(pan); pan.connect(opts.dest || this.amb); } else g.connect(opts.dest || this.amb);
    o.start(t); o.stop(t + opts.len + 0.05);
  };

  /* ---------------- events ---------------- */
  P.footstep = function (e) {
    if (!this.ready || this.muted) return;
    var s = e.surface, sp = e.sprint ? 1.25 : 1, pan = e.foot ? 0.12 : -0.12;
    var g = 0.28 * sp;
    if (s === 'grass') { this._burst({ freq: 1600, q: 0.8, len: 0.09, gain: g * 0.6, pan: pan }); this._burst({ freq: 300, q: 0.7, type: 'lowpass', len: 0.07, gain: g * 0.5, pan: pan }); }
    else if (s === 'leaves') { for (var i = 0; i < 4; i++) this._burst({ freq: 3200 + Math.random() * 1500, q: 1.5, len: 0.05, gain: g * 0.35, delay: i * 0.018, pan: pan }); }
    else if (s === 'rock') { this._burst({ freq: 2600, q: 4, len: 0.04, gain: g * 0.5, pan: pan }); this._burst({ freq: 180, type: 'lowpass', q: 1, len: 0.08, gain: g * 0.8, pan: pan }); this._burst({ freq: 5000, q: 2, len: 0.02, gain: g * 0.2, delay: 0.015, pan: pan }); }
    else if (s === 'sand') { this._burst({ freq: 1300, q: 0.6, len: 0.16, gain: g * 0.45, attack: 0.02, pan: pan }); }
    else if (s === 'snow') { for (var j = 0; j < 6; j++) this._burst({ freq: 1400 + Math.random() * 1800, q: 2, len: 0.04, gain: g * 0.35, delay: j * 0.02, pan: pan }); this._burst({ freq: 220, type: 'lowpass', len: 0.12, gain: g * 0.5, pan: pan }); }
    else if (s === 'mud') { this._burst({ freq: 350, type: 'lowpass', q: 3, len: 0.18, gain: g * 0.8, sweep: 150, pan: pan }); this._tone({ f0: 240, f1: 90, len: 0.12, gain: 0.05, dest: this.fx, pan: pan }); }
    else if (s === 'puddle') { this._burst({ freq: 1400, q: 1, len: 0.2, gain: g * 0.6, sweep: 700, pan: pan }); this._burst({ freq: 400, type: 'lowpass', len: 0.08, gain: g * 0.4, pan: pan }); }
    else if (s === 'ice') { this._burst({ freq: 3400, q: 5, len: 0.03, gain: g * 0.4, pan: pan }); this._burst({ freq: 900, q: 6, len: 0.06, gain: g * 0.25, delay: 0.01, pan: pan }); }
    else if (s === 'path') { for (var pth = 0; pth < 3; pth++) this._burst({ freq: 2000 + Math.random() * 1400, q: 1.8, len: 0.05, gain: g * 0.35, delay: pth * 0.015, pan: pan }); this._burst({ freq: 240, type: 'lowpass', len: 0.07, gain: g * 0.5, pan: pan }); }
    else if (s === 'water') { this._burst({ freq: 1200, q: 0.9, len: 0.28, gain: g * 0.8, sweep: 600, pan: pan }); this._burst({ freq: 2800, q: 3, len: 0.12, gain: g * 0.3, delay: 0.05, pan: pan }); }
    if (e.wet > 0.5 && s !== 'water') this._burst({ freq: 900, q: 1.2, len: 0.12, gain: g * 0.25 * e.wet, delay: 0.02, pan: pan });
  };
  P.land = function (e) {
    if (!this.ready || this.muted) return;
    var g = U.clamp(e.impact / 12, 0.2, 1);
    this._burst({ freq: 140, type: 'lowpass', len: 0.22, gain: 0.7 * g });
    this.footstep({ surface: e.surface, sprint: true, foot: 0 });
  };
  P.thunder = function (dist) {
    if (!this.ready || this.muted) return;
    var near = U.clamp(1 - dist / 5000, 0, 1);
    if (dist < 1200) this._burst({ freq: 3000, type: 'highpass', len: 0.35, gain: 0.5 * near, dest: this.amb });
    this._burst({ buf: this.brown, freq: 90 + near * 120, type: 'lowpass', q: 0.5, len: 3 + (1 - near) * 4, attack: 0.08 + (1 - near) * 0.4, gain: 0.35 + near * 0.9, dest: this.amb });
    this._burst({ buf: this.brown, freq: 60, type: 'lowpass', len: 5, attack: 0.6, gain: 0.3 + near * 0.3, delay: 0.3, dest: this.amb });
  };
  P.chime = function () {
    if (!this.ready || this.muted) return;
    [660, 880, 1320, 1760].forEach(function (f, i) { this._tone({ f0: f, len: 0.9, gain: 0.08, delay: i * 0.08, dest: this.fx }); }, this);
  };
  P.click = function () { if (this.ready && !this.muted) this._tone({ f0: 900, f1: 600, len: 0.05, gain: 0.04, dest: this.fx }); };

  /* ---------------- continuous soundscape ---------------- */
  P.update = function (dt, env, local, player) {
    if (!this.ready) return;
    var c = this.ctx, t = c.currentTime, L = this.L;
    var under = env.underwater;
    this.lowpass.frequency.setTargetAtTime(under ? 600 : 20000, t, 0.2);
    var alt = U.clamp(local.altitude / 2500, 0, 1);
    var ws = env.windStrength;
    // wind body + whistle (mountains, storms)
    this._set(L.wind, (0.05 + ws * 0.45 + alt * 0.12) * (under ? 0.1 : 1));
    L.wind.filters[0].frequency.setTargetAtTime(300 + ws * 500 + env.gust * 250, t, 0.8);
    this._set(L.whistle, Math.max(0, ws - 0.45) * 0.12 * (0.5 + alt) * (under ? 0 : 1));
    L.whistle.filters[0].frequency.setTargetAtTime(1100 + env.gust * 900 + alt * 400, t, 1.2);
    // rain intensity layers (louder during storms)
    this._set(L.rain, env.rain * 0.22 * (under ? 0.2 : 1));
    this._set(L.rainHeavy, U.smoothstep(0.4, 1, env.rain) * 0.35 * (1 + env.storm * 0.4));
    // blizzard/sandstorm hiss
    this._set(L.sand, (env.dust * 0.25 + env.snow * env.windStrength * 0.08) * (under ? 0 : 1));
    // rivers & waterfalls: louder near moving water
    var rd = local.rdist !== undefined ? local.rdist : 1e9;
    var riverNear = U.smoothstep(140, 5, rd) * (local.wtype === 3 || rd < 140 ? 1 : 0);
    this._set(L.river, riverNear * 0.25);
    this._set(L.river2, riverNear * 0.12);
    L.river2.filters[0].frequency.setTargetAtTime(1500 + Math.random() * 1200, t, 0.08);
    L.river.filters[0].frequency.setTargetAtTime(500 + Math.random() * 500, t, 0.1);
    // ocean surf with wave cycles
    var coast = local.cont < 0.2 ? U.smoothstep(0.2, 0.02, local.cont) * U.smoothstep(60, 2, Math.max(0, local.ground - env.seaLevel)) : 0;
    var waveCycle = 0.55 + 0.45 * Math.sin(t * 0.8) * Math.sin(t * 0.37 + 1.3);
    this._set(L.ocean, coast * (0.25 + 0.35 * waveCycle) * (under ? 0.4 : 1), 0.6);
    // forest rustle follows wind & canopy
    this._set(L.rustle, local.forest * (0.02 + ws * 0.12) * (under ? 0 : 1));
    // volcanic rumble
    this._set(L.rumble, env.volcanic * 0.35);
    this._set(L.underwater, under ? 0.4 : 0, 0.15);
    // birds (day), crickets (warm nights), frogs (wetlands at night)
    var day = env.dayFactor, calm = (1 - env.rain) * (1 - env.snow) * (1 - U.smoothstep(0.6, 1, ws));
    this._birdT -= dt;
    if (this._birdT <= 0 && !under) {
      this._birdT = 0.8 + Math.random() * 4;
      var birdiness = day * calm * U.clamp01(local.forest * 1.2 + local.moist * 0.4) * U.smoothstep(-2, 8, local.temp);
      if (Math.random() < birdiness) this._birdSong();
    }
    this._cricketT -= dt;
    if (this._cricketT <= 0 && !under) {
      this._cricketT = 0.35 + Math.random() * 0.4;
      var crick = (1 - day) * calm * U.smoothstep(12, 20, local.temp) * U.clamp01(1 - local.forest * 0.3);
      if (Math.random() < crick) this._cricket();
    }
    this._frogT -= dt;
    if (this._frogT <= 0) {
      this._frogT = 1 + Math.random() * 3;
      var frog = (1 - day * 0.7) * U.smoothstep(0.5, 0.9, local.moist) * U.smoothstep(12, 18, local.temp) * (local.wprox > 0.3 ? 1 : 0.2);
      if (Math.random() < frog) this._frog();
    }
  };
  P._birdSong = function () {
    var kind = Math.floor(Math.random() * 4), pan = Math.random() * 1.6 - 0.8, base = 2200 + Math.random() * 2400;
    var notes = 2 + Math.floor(Math.random() * 6);
    for (var i = 0; i < notes; i++) {
      var d = i * (0.08 + Math.random() * 0.1);
      if (kind === 0) this._tone({ f0: base * (1 + Math.random() * 0.2), f1: base * 0.6, len: 0.09, gain: 0.03, delay: d, pan: pan });
      else if (kind === 1) this._tone({ f0: base * 0.7, f1: base * 1.3, len: 0.07, gain: 0.025, delay: d, pan: pan });
      else if (kind === 2) this._tone({ f0: base, f1: base * (0.9 + Math.random() * 0.4), len: 0.15, gain: 0.02, delay: d * 1.5, pan: pan, wave: 'triangle' });
      else this._tone({ f0: base * 0.5, f1: base * 0.45, len: 0.25, gain: 0.025, delay: d * 2, pan: pan });
    }
  };
  P._cricket = function () {
    var pan = Math.random() * 1.6 - 0.8, f = 4200 + Math.random() * 900;
    for (var i = 0; i < 3; i++) this._tone({ f0: f, len: 0.035, gain: 0.012, delay: i * 0.05, pan: pan, attack: 0.004 });
  };
  P._frog = function () {
    var pan = Math.random() * 1.6 - 0.8, f = 180 + Math.random() * 140;
    for (var i = 0; i < 2; i++) this._tone({ f0: f, f1: f * 0.7, len: 0.16, gain: 0.05, delay: i * 0.22, pan: pan, wave: 'sawtooth' });
  };

  TERRA.game.AudioEngine = AudioEngine;
})();
