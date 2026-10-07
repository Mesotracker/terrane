/* =============================================================================
 * TERRA INFINITA — performance monitoring & dynamic resolution
 * ========================================================================== */
(function () {
  'use strict';
  var U = TERRA.util;

  function Perf() {
    this.fps = 60; this.frameMs = 16.7; this.cpuMs = 0; this.gpuMs = 0;
    this.history = new Float32Array(120); this.hi = 0;
    this._acc = 0; this._frames = 0; this._adjT = 0; this._slow = 0;
  }
  var P = Perf.prototype;

  P.frame = function (dt, cpuMs) {
    var ms = dt * 1000;
    this.frameMs = this.frameMs * 0.92 + ms * 0.08;
    this.cpuMs = this.cpuMs * 0.9 + cpuMs * 0.1;
    this.history[this.hi] = ms; this.hi = (this.hi + 1) % this.history.length;
    this._acc += dt; this._frames++;
    if (this._acc >= 0.5) { this.fps = this._frames / this._acc; this._acc = 0; this._frames = 0; }
  };

  /**
   * Adjust the renderer's dynamic resolution scale toward the target frame rate
   * (quantised to 5 % steps so render targets are not reallocated constantly).
   * If the frame time stays far above target even at the minimum scale, the automatic
   * quality governor steps the graphics preset down (engine.autoLowerQuality).
   */
  P.adapt = function (renderer, g, dt, engine) {
    if (dt > 0.25) return;                           // tab switch / hitch: ignore
    var target = 1000 / (g.targetFps || 60);
    // with frame extrapolation the real frame rate only needs to reach target / multiplier
    var fx = engine && engine.frameGen && engine.frameGen.active ? engine.frameGen.mult : 1;
    target *= fx;
    var ms = this.frameMs;
    var minS = g.performanceMode ? 0.5 : 0.6;
    var adaptiveLod = g.adaptiveLod !== false;
    if (engine && engine.lodScale === undefined) engine.lodScale = 1;
    var minL = g.performanceMode ? 0.6 : 0.72;
    this._adjT += dt;
    if (this._adjT >= 0.6) {
      this._adjT = 0;
      var s = renderer.dynScale, L = engine ? engine.lodScale : 1;
      var dyn = g.dynamicResolution || g.performanceMode;
      if (ms > target * 1.15) {
        // first trade a little detail distance (invisible at first), then resolution
        if (adaptiveLod && L > minL + 0.001) L -= ms > target * 1.6 ? 0.08 : 0.04;
        else if (dyn) s -= ms > target * 1.6 ? 0.1 : 0.05;
      } else if (ms < target * 0.8) {
        if (dyn && s < 1) s += 0.05;
        else if (adaptiveLod && L < 1) L += 0.04;
      }
      renderer.dynScale = dyn ? Math.round(U.clamp(s, minS, 1) * 20) / 20 : 1;
      if (engine) engine.lodScale = adaptiveLod ? Math.round(U.clamp(L, minL, 1) * 100) / 100 : 1;
    }
    if (!g.dynamicResolution && !g.performanceMode) renderer.dynScale = 1;
    // automatic quality governor
    this._playT = (this._playT || 0) + dt;
    this._govCool = Math.max(0, (this._govCool || 0) - dt);
    if (g.autoQuality === false || !engine || this._playT < 12 || this._govCool > 0) { this._slow = 0; return; }
    var atFloor = (!(g.dynamicResolution || g.performanceMode) || renderer.dynScale <= minS + 0.001) && (!adaptiveLod || engine.lodScale <= minL + 0.001);
    if (atFloor && ms > target * 1.45) this._slow += dt; else this._slow = Math.max(0, this._slow - dt * 2);
    if (this._slow > 6) { this._slow = 0; this._govCool = 20; engine.autoLowerQuality(); }
  };

  /** Every presented frame (real or generated): displayed frame rate. */
  P.display = function (dt) {
    this._dAcc = (this._dAcc || 0) + dt; this._dFrames = (this._dFrames || 0) + 1;
    if (this._dAcc >= 0.5) { this.displayFps = this._dFrames / this._dAcc; this._dAcc = 0; this._dFrames = 0; }
  };

  P.memory = function () {
    var m = performance.memory;
    return m ? (m.usedJSHeapSize / 1048576) : null;
  };

  TERRA.game.Perf = Perf;
})();
