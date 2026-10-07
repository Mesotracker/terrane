/* =============================================================================
 * TERRA INFINITA — world map (generated from the procedural world data)
 * Tiles are rendered by the worker pool from the same generator as the terrain:
 * biome colours, hill shading, contour lines, water, rivers, trails, snow.
 * ========================================================================== */
(function () {
  'use strict';
  var U = TERRA.util;
  var TILE_RES = 128;
  var LEVELS = [2, 8, 32, 128];   // metres per map pixel at each tile level

  function MapView(engine, canvas) {
    this.engine = engine;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tiles = new Map();
    this.center = [0, 0];
    this.mpp = 16;          // metres per screen pixel
    this.open = false;
    this.waypoint = null;
    this.discovered = {};
    this.follow = true;
    var self = this;
    var drag = null;
    canvas.addEventListener('mousedown', function (e) { drag = { x: e.clientX, y: e.clientY, cx: self.center[0], cz: self.center[1], moved: false }; });
    window.addEventListener('mousemove', function (e) {
      if (!drag || !self.open) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      self.center = [drag.cx - dx * self.mpp, drag.cz - dy * self.mpp];
      self.follow = false;
    });
    window.addEventListener('mouseup', function (e) {
      if (drag && !drag.moved && self.open && e.target === canvas) {
        var w = self.screenToWorld(e.clientX, e.clientY);
        self.waypoint = w;
        TERRA.events.emit('waypoint', w);
      }
      drag = null;
    });
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var before = self.screenToWorld(e.clientX, e.clientY);
      self.mpp = U.clamp(self.mpp * (e.deltaY > 0 ? 1.25 : 0.8), 1, 400);
      var after = self.screenToWorld(e.clientX, e.clientY);
      self.center[0] += before[0] - after[0]; self.center[1] += before[1] - after[1];
      self.follow = false;
    }, { passive: false });
  }
  var P = MapView.prototype;

  P.screenToWorld = function (sx, sy) {
    var r = this.canvas.getBoundingClientRect();
    return [this.center[0] + (sx - r.left - r.width / 2) * this.mpp, this.center[1] + (sy - r.top - r.height / 2) * this.mpp];
  };
  P.worldToScreen = function (x, z) {
    var w = this.canvas.width / (window.devicePixelRatio || 1), h = this.canvas.height / (window.devicePixelRatio || 1);
    return [(x - this.center[0]) / this.mpp + w / 2, (z - this.center[1]) / this.mpp + h / 2];
  };
  P.reset = function () { this.tiles.clear(); this.waypoint = null; };
  P.centerOnPlayer = function () { var p = this.engine.player.pos; this.center = [p[0], p[2]]; this.follow = true; };

  P._tile = function (lvl, i, j) {
    var k = lvl + ':' + i + ':' + j, t = this.tiles.get(k);
    if (t) { t.used = performance.now(); return t; }
    var tmpp = LEVELS[lvl], span = TILE_RES * tmpp;
    t = { state: 'pending', canvas: null, used: performance.now() };
    this.tiles.set(k, t);
    var self = this;
    this.engine.pool.submit({ type: 'map', res: TILE_RES, x0: i * span, z0: j * span, mpp: tmpp }, -100 + lvl, function (r) {
      var c = document.createElement('canvas'); c.width = c.height = TILE_RES;
      var img = new ImageData(new Uint8ClampedArray(r.pixels.buffer), TILE_RES, TILE_RES);
      c.getContext('2d').putImageData(img, 0, 0);
      t.canvas = c; t.state = 'ready';
    });
    if (this.tiles.size > 700) {
      var arr = []; this.tiles.forEach(function (v, key) { arr.push([key, v.used]); });
      arr.sort(function (a, b) { return a[1] - b[1]; });
      for (var q = 0; q < 200; q++) this.tiles.delete(arr[q][0]);
    }
    return t;
  };

  P.update = function () {
    var E = this.engine, p = E.player.pos;
    // discover nearby points of interest
    var pois = E.vegetation ? E.vegetation.poiList : [];
    for (var i = 0; i < pois.length; i++) {
      var poi = pois[i];
      if (!this.discovered[poi.id] && Math.hypot(poi.x - p[0], poi.z - p[2]) < 70) {
        this.discovered[poi.id] = { name: poi.name, x: poi.x, z: poi.z, type: poi.type };
        TERRA.events.emit('discovered', poi);
      }
    }
    if (!this.open) return;
    if (this.follow) this.center = [p[0], p[2]];
    this.draw();
  };

  P.draw = function () {
    var c = this.canvas, dpr = window.devicePixelRatio || 1;
    var W = c.clientWidth, H = c.clientHeight;
    if (c.width !== Math.floor(W * dpr) || c.height !== Math.floor(H * dpr)) { c.width = Math.floor(W * dpr); c.height = Math.floor(H * dpr); }
    var ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b1016'; ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    // choose tile level: tile pixel ≈ 1-2 screen px
    var lvl = 0;
    while (lvl < LEVELS.length - 1 && LEVELS[lvl] * 1.6 < this.mpp) lvl++;
    var tmpp = LEVELS[lvl], span = TILE_RES * tmpp;
    var x0 = this.center[0] - W / 2 * this.mpp, z0 = this.center[1] - H / 2 * this.mpp;
    var x1 = x0 + W * this.mpp, z1 = z0 + H * this.mpp;
    var i0 = Math.floor(x0 / span), i1 = Math.floor(x1 / span), j0 = Math.floor(z0 / span), j1 = Math.floor(z1 / span);
    var pending = 0;
    for (var j = j0; j <= j1; j++) for (var i = i0; i <= i1; i++) {
      var t = this._tile(lvl, i, j);
      var s = this.worldToScreen(i * span, j * span), size = span / this.mpp;
      if (t.state === 'ready') ctx.drawImage(t.canvas, s[0], s[1], size + 0.6, size + 0.6);
      else {
        pending++;
        // fall back to a coarser ready tile if available
        if (lvl + 1 < LEVELS.length) {
          var cspan = TILE_RES * LEVELS[lvl + 1], ci = Math.floor(i * span / cspan), cj = Math.floor(j * span / cspan);
          var ct = this.tiles.get((lvl + 1) + ':' + ci + ':' + cj);
          if (ct && ct.state === 'ready') {
            var frac = span / cspan, sx = ((i * span - ci * cspan) / cspan) * TILE_RES, sy = ((j * span - cj * cspan) / cspan) * TILE_RES;
            ctx.drawImage(ct.canvas, sx, sy, TILE_RES * frac, TILE_RES * frac, s[0], s[1], size + 0.6, size + 0.6);
          }
        }
      }
    }
    // grid
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
    var gstep = Math.pow(10, Math.ceil(Math.log10(this.mpp * 120)));
    for (var gx = Math.floor(x0 / gstep) * gstep; gx < x1; gx += gstep) { var sx2 = this.worldToScreen(gx, 0)[0]; ctx.beginPath(); ctx.moveTo(sx2, 0); ctx.lineTo(sx2, H); ctx.stroke(); }
    for (var gz = Math.floor(z0 / gstep) * gstep; gz < z1; gz += gstep) { var sy2 = this.worldToScreen(0, gz)[1]; ctx.beginPath(); ctx.moveTo(0, sy2); ctx.lineTo(W, sy2); ctx.stroke(); }
    var E = this.engine, gen = E.gen;
    // landmarks
    var radius = Math.max(W, H) * this.mpp;
    var lms = gen.landmarksNear(this.center[0], this.center[1], radius);
    ctx.font = '600 12px Inter, system-ui, sans-serif'; ctx.textAlign = 'center';
    lms.forEach(function (l) {
      var s = this.worldToScreen(l.x, l.z);
      ctx.fillStyle = l.type === 'volcano' ? '#ff7a45' : (l.type === 'lake' ? '#7fc3ff' : '#e8e2d6');
      ctx.beginPath(); ctx.arc(s[0], s[1], 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillText(l.name, s[0] + 1, s[1] - 9);
      ctx.fillStyle = '#fff'; ctx.fillText(l.name, s[0], s[1] - 10);
    }, this);
    // discovered POIs
    for (var id in this.discovered) {
      var d = this.discovered[id], s = this.worldToScreen(d.x, d.z);
      if (s[0] < -20 || s[1] < -20 || s[0] > W + 20 || s[1] > H + 20) continue;
      ctx.fillStyle = '#ffd36e'; ctx.beginPath(); ctx.moveTo(s[0], s[1] - 6); ctx.lineTo(s[0] + 5, s[1]); ctx.lineTo(s[0], s[1] + 6); ctx.lineTo(s[0] - 5, s[1]); ctx.closePath(); ctx.fill();
      if (this.mpp < 30) { ctx.fillStyle = '#fff'; ctx.fillText(d.name, s[0], s[1] - 10); }
    }
    // waypoint
    if (this.waypoint) {
      var w = this.worldToScreen(this.waypoint[0], this.waypoint[1]);
      ctx.strokeStyle = '#6cf'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(w[0], w[1], 8, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(w[0], w[1] - 14); ctx.lineTo(w[0], w[1] + 14); ctx.moveTo(w[0] - 14, w[1]); ctx.lineTo(w[0] + 14, w[1]); ctx.stroke();
    }
    // player arrow
    var p = E.player.pos, ps = this.worldToScreen(p[0], p[2]), yaw = E.player.yaw;
    ctx.save(); ctx.translate(ps[0], ps[1]); ctx.rotate(-yaw);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(7, 8); ctx.lineTo(0, 4); ctx.lineTo(-7, 8); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    // scale bar
    var bar = Math.pow(10, Math.floor(Math.log10(this.mpp * 150)));
    var bl = bar / this.mpp;
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(18, H - 44, bl + 20, 28);
    ctx.fillStyle = '#fff'; ctx.fillRect(28, H - 26, bl, 3);
    ctx.textAlign = 'left'; ctx.fillText(U.fmtDist(bar), 28, H - 31);
    // north indicator
    ctx.textAlign = 'center'; ctx.fillStyle = '#fff'; ctx.font = '700 14px Inter, system-ui, sans-serif'; ctx.fillText('N', W - 30, 34);
    ctx.beginPath(); ctx.moveTo(W - 30, 40); ctx.lineTo(W - 25, 54); ctx.lineTo(W - 35, 54); ctx.closePath(); ctx.fill();
    this.pending = pending;
  };

  P.serialize = function () { return { discovered: this.discovered, waypoint: this.waypoint }; };
  P.deserialize = function (d) { if (!d) return; this.discovered = d.discovered || {}; this.waypoint = d.waypoint || null; };

  TERRA.game.MapView = MapView;
})();
