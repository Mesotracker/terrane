/* =============================================================================
 * TERRA INFINITA — worker pool for asynchronous world generation
 * Workers are created from Blob URLs built from the terrain core's source code,
 * which keeps the project runnable directly from file:// (no separate worker file).
 * If workers are unavailable, jobs run on the main thread in time-sliced batches.
 * ========================================================================== */
(function () {
  'use strict';
  var U = TERRA.util;

  function workerMain() {
    /* global CORE_FACTORY */
    var core = CORE_FACTORY();
    var gen = null;
    self.onmessage = function (e) {
      var m = e.data;
      try {
        if (m.type === 'init') { gen = core.createGenerator(m.seed, m.params); self.postMessage({ type: 'ready', epoch: m.epoch }); return; }
        if (!gen) return;
        var t0 = performance.now(), r, transfer = [];
        if (m.type === 'node') {
          r = gen.generateNode(m);
          transfer.push(r.vbuf, r.heights.buffer, r.clim.buffer, r.surf.buffer, r.extra.buffer, r.wl.buffer, r.wty.buffer, r.wfx.buffer, r.wfz.buffer);
          if (r.water) transfer.push(r.water.vbuf, r.water.ibuf);
        } else if (m.type === 'tree') {
          r = gen.generateTreeCell(m); transfer.push(r.inst.buffer);
        } else if (m.type === 'prop') {
          r = gen.generatePropCell(m); transfer.push(r.inst.buffer);
        } else if (m.type === 'map') {
          r = gen.generateMapTile(m); transfer.push(r.pixels.buffer, r.info.buffer);
        }
        self.postMessage({ type: 'done', id: m.id, epoch: m.epoch, result: r, ms: performance.now() - t0 }, transfer);
      } catch (err) {
        self.postMessage({ type: 'error', id: m.id, epoch: m.epoch, message: String(err && err.stack || err) });
      }
    };
  }

  function WorkerPool(count) {
    this.workers = [];
    this.queue = [];          // pending jobs (not yet dispatched)
    this.inflight = {};       // id → job
    this.nextId = 1;
    this.epoch = 0;
    this.stats = { done: 0, ms: 0, avgMs: 0, lastMs: 0 };
    this.fallback = false;
    var src;
    try {
      src = 'var CORE_FACTORY = ' + TERRA.TerrainCoreFactory.toString() + ';\n(' + workerMain.toString() + ')();';
      var blob = new Blob([src], { type: 'application/javascript' });
      this.url = URL.createObjectURL(blob);
      for (var i = 0; i < count; i++) this._spawn();
    } catch (e) {
      U.warn('Web Workers unavailable, generating on the main thread.', e);
      this.fallback = true;
    }
    if (!this.workers.length) this.fallback = true;
  }
  var P = WorkerPool.prototype;

  P._spawn = function () {
    var self = this;
    var w = new Worker(this.url);
    w.busy = null;
    w.onmessage = function (e) { self._onMessage(w, e.data); };
    w.onerror = function (e) { U.warn('Worker error', e.message); if (w.busy) { var j = w.busy; w.busy = null; delete self.inflight[j.id]; if (j.reject) j.reject(e); } self._pump(); };
    this.workers.push(w);
  };

  P.init = function (seed, params) {
    this.epoch++;
    this.seed = seed; this.params = params;
    // Drop everything queued from the previous world.
    this.queue.length = 0;
    this.inflight = {};
    var ep = this.epoch;
    if (this.fallback) { this.gen = TERRA.core.createGenerator(seed, params); return Promise.resolve(); }
    var self = this;
    return Promise.all(this.workers.map(function (w) {
      w.busy = null;
      return new Promise(function (res) {
        var h = function (e) { if (e.data.type === 'ready' && e.data.epoch === ep) { w.removeEventListener('message', h); res(); } };
        w.addEventListener('message', h);
        w.postMessage({ type: 'init', seed: seed, params: params, epoch: ep });
      });
    })).then(function () { self._pump(); });
  };

  /** Queue a job. `priority`: lower runs first. Returns a handle with .cancel(). */
  P.submit = function (msg, priority, onDone) {
    var job = { id: this.nextId++, msg: msg, pri: priority, cb: onDone, epoch: this.epoch, cancelled: false };
    msg.id = job.id; msg.epoch = this.epoch;
    this.queue.push(job);
    this._dirty = true;
    this._pump();
    return job;
  };
  P.cancel = function (job) { if (job) job.cancelled = true; };
  P.reprioritize = function (fn) {
    for (var i = 0; i < this.queue.length; i++) this.queue[i].pri = fn(this.queue[i]);
    this._dirty = true;
  };
  P.pending = function () { return this.queue.length + Object.keys(this.inflight).length; };

  P._take = function () {
    if (this._dirty) { this.queue.sort(function (a, b) { return a.pri - b.pri; }); this._dirty = false; }
    while (this.queue.length) {
      var j = this.queue.shift();
      if (!j.cancelled && j.epoch === this.epoch) return j;
    }
    return null;
  };

  P._pump = function () {
    if (this.fallback) { this._pumpMain(); return; }
    for (var i = 0; i < this.workers.length; i++) {
      var w = this.workers[i];
      if (w.busy) continue;
      var j = this._take();
      if (!j) return;
      w.busy = j;
      this.inflight[j.id] = j;
      w.postMessage(j.msg);
    }
  };

  P._onMessage = function (w, d) {
    if (d.type === 'ready') return;
    var j = this.inflight[d.id];
    w.busy = null;
    delete this.inflight[d.id];
    if (d.type === 'error') { U.warn('Generation job failed:', d.message); }
    else if (j && !j.cancelled && d.epoch === this.epoch) {
      this.stats.done++; this.stats.lastMs = d.ms; this.stats.ms += d.ms;
      this.stats.avgMs = this.stats.avgMs * 0.95 + d.ms * 0.05;
      if (j.cb) j.cb(d.result, d.ms);
    }
    this._pump();
  };

  /* Main-thread fallback: run jobs in ~8 ms slices */
  P._pumpMain = function () {
    if (this._mainScheduled) return;
    this._mainScheduled = true;
    var self = this;
    setTimeout(function () {
      self._mainScheduled = false;
      var t0 = performance.now();
      while (performance.now() - t0 < 8) {
        var j = self._take();
        if (!j) return;
        var m = j.msg, r, t1 = performance.now();
        try {
          if (m.type === 'node') r = self.gen.generateNode(m);
          else if (m.type === 'tree') r = self.gen.generateTreeCell(m);
          else if (m.type === 'prop') r = self.gen.generatePropCell(m);
          else if (m.type === 'map') r = self.gen.generateMapTile(m);
          self.stats.done++;
          if (j.cb) j.cb(r, performance.now() - t1);
        } catch (e) { U.warn('Main-thread generation failed', e); }
      }
      self._pumpMain();
    }, 0);
  };

  P.terminate = function () {
    this.workers.forEach(function (w) { w.terminate(); });
    this.workers = [];
    if (this.url) URL.revokeObjectURL(this.url);
  };

  TERRA.world.WorkerPool = WorkerPool;
})();
