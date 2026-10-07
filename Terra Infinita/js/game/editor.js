/* =============================================================================
 * TERRA INFINITA — world / gameplay editor
 * Terrain sculpting (raise, lower, smooth, flatten, mountains, valleys),
 * material & biome painting, vegetation painting/removal, rocks, water,
 * object spawning/deleting — all undoable, all saved with the world.
 * ========================================================================== */
(function () {
  'use strict';
  var U = TERRA.util, M = TERRA.math;

  var TOOLS = [
    { id: 'raise', name: 'Raise', key: '1', icon: '▲' },
    { id: 'lower', name: 'Lower', key: '2', icon: '▼' },
    { id: 'smooth', name: 'Smooth', key: '3', icon: '≈' },
    { id: 'flatten', name: 'Flatten', key: '4', icon: '▭' },
    { id: 'mountain', name: 'Add Mountain', key: '5', icon: '⛰' },
    { id: 'valley', name: 'Add Valley', key: '6', icon: '⌵' },
    { id: 'paint', name: 'Paint Material', key: '7', icon: '🖌' },
    { id: 'vegPaint', name: 'Paint Vegetation', key: '8', icon: '🌲' },
    { id: 'vegRemove', name: 'Remove Vegetation', key: '9', icon: '✂' },
    { id: 'rocks', name: 'Add Rocks', key: '0', icon: '◆' },
    { id: 'water', name: 'Add Water', key: '', icon: '💧' },
    { id: 'waterRemove', name: 'Remove Water', key: '', icon: '⛆' },
    { id: 'biome', name: 'Change Biome', key: '', icon: '◐' },
    { id: 'spawn', name: 'Spawn Object', key: '', icon: '＋' },
    { id: 'delete', name: 'Delete Object', key: '', icon: '✕' }
  ];
  var BIOME_TARGETS = {
    'Temperate Forest': [14, 0.65], 'Grassland': [14, 0.35], 'Desert': [28, 0.08], 'Savanna': [25, 0.35], 'Tropical Forest': [27, 0.8],
    'Boreal Forest': [3, 0.55], 'Tundra': [-1, 0.35], 'Snowfield': [-12, 0.5], 'Wetland': [14, 0.9]
  };
  var VEG_TYPES = { 'Spruce': [0, 0], 'Pine': [0, 1], 'Oak': [0, 2], 'Birch': [0, 3], 'Palm': [0, 4], 'Acacia': [0, 5], 'Dead Tree': [0, 6], 'Cactus': [0, 7], 'Ancient Tree': [0, 9],
    'Bush': [1, 0], 'Fern': [1, 1], 'Flowers': [1, 10], 'Reeds': [1, 8], 'Mushrooms': [1, 7] };
  var SPAWN_TYPES = { 'Ruins': ['structure', 1], 'Campsite': ['structure', 2], 'Village': ['structure', 3], 'Watchtower': ['structure', 4], 'Standing Stones': ['structure', 5],
    'Rock Arch': ['structure', 6], 'Cave': ['structure', 7], 'Monolith': ['structure', 8], 'Shrine': ['structure', 9], 'Boulder': ['tree', 10], 'Oak Tree': ['tree', 2], 'Spruce Tree': ['tree', 0], 'Log': ['prop', 3] };

  function Editor(engine) {
    this.engine = engine;
    this.active = false;
    this.tool = 'raise';
    this.brush = { radius: 12, strength: 0.5, falloff: 1.4, hardness: 0.35, noise: 0.0, smoothing: 0.3 };
    this.material = 0;
    this.vegType = 'Oak';
    this.biomeTarget = 'Temperate Forest';
    this.spawnType = 'Ruins';
    this.hit = null;
    this.stroking = false;
    this._acc = 0; this._pendingBox = null; this._flatTarget = 0;
    this.TOOLS = TOOLS; this.BIOME_TARGETS = BIOME_TARGETS; this.VEG_TYPES = VEG_TYPES; this.SPAWN_TYPES = SPAWN_TYPES;
  }
  var P = Editor.prototype;

  P.toggle = function (on) {
    this.active = on === undefined ? !this.active : on;
    var E = this.engine;
    if (this.active) {
      this._prevMode = E.player.mode;
      E.player.mode = 'free';
      E.player.freeSpeed = Math.max(E.player.freeSpeed, 30);
      E.input.unlock();
    } else {
      if (this.stroking) this._endStroke();
      E.player.mode = this._prevMode || 'first';
      if (E.player.mode !== 'free') { var h = E.groundHeight(E.player.pos[0], E.player.pos[2]); E.player.pos[1] = Math.max(h, Math.min(E.player.pos[1], h + 1)); }
      E.renderer.terrain.brush[3] = 0;
    }
    TERRA.events.emit('editor', this.active);
  };

  /** Ray-march the terrain under the mouse cursor. */
  P.raycast = function (mx, my) {
    var E = this.engine, cam = E.camera, c = E.renderer.canvas;
    var rect = c.getBoundingClientRect();
    var nx = (mx - rect.left) / rect.width * 2 - 1, ny = 1 - (my - rect.top) / rect.height * 2;
    var inv = cam.invViewProj;
    var p0 = M.transformPoint([0, 0, 0], inv, nx, ny, E.renderer.G.caps.reversedZ ? 1 : -1);
    var p1 = M.transformPoint([0, 0, 0], inv, nx, ny, E.renderer.G.caps.reversedZ ? 0.001 : 0.999);
    var d = M.norm3([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]);
    var o = [cam.world[0], cam.world[1], cam.world[2]];
    var t = 0.5, prevT = 0, step = 0.5;
    for (var i = 0; i < 600 && t < 6000; i++) {
      var x = o[0] + d[0] * t, y = o[1] + d[1] * t, z = o[2] + d[2] * t;
      var h = E.groundHeight(x, z);
      if (y < h) {
        var a = prevT, b = t;
        for (var k = 0; k < 10; k++) { var m = (a + b) / 2; if (o[1] + d[1] * m < E.groundHeight(o[0] + d[0] * m, o[2] + d[2] * m)) b = m; else a = m; }
        var tt = (a + b) / 2;
        return [o[0] + d[0] * tt, o[1] + d[1] * tt, o[2] + d[2] * tt];
      }
      prevT = t;
      step = Math.max(0.4, t * 0.012);
      t += step;
    }
    return null;
  };

  P.update = function (dt, input) {
    if (!this.active) return;
    var E = this.engine, ed = E.edits;
    // look while holding the right mouse button
    if (input.mouse.clicked[2]) input.lock();
    if (input.mouse.released[2]) input.unlock();
    // tool hotkeys
    for (var i = 0; i < TOOLS.length; i++) if (TOOLS[i].key && input.hit('Digit' + TOOLS[i].key)) { this.tool = TOOLS[i].id; TERRA.events.emit('editorTool', this.tool); }
    if (input.hit('BracketLeft')) this.brush.radius = Math.max(1, this.brush.radius / 1.2);
    if (input.hit('BracketRight')) this.brush.radius = Math.min(400, this.brush.radius * 1.2);
    if ((input.down('ControlLeft') || input.down('MetaLeft')) && input.hit('KeyZ')) { if (input.down('ShiftLeft')) this.redo(); else this.undo(); }
    if ((input.down('ControlLeft') || input.down('MetaLeft')) && input.hit('KeyY')) this.redo();
    this.hit = input.locked ? null : this.raycast(input.mouse.x, input.mouse.y);
    var tb = E.renderer.terrain.brush;
    if (this.hit) {
      var o = E.origin;
      tb[0] = this.hit[0] - o[0]; tb[1] = this.hit[2] - o[1]; tb[2] = this.brush.radius; tb[3] = 1;
      var colors = { lower: [0.3, 0.6, 1], smooth: [0.4, 1, 0.6], flatten: [1, 1, 0.5], paint: [1, 0.5, 0.9], vegPaint: [0.4, 1, 0.3], vegRemove: [1, 0.35, 0.3], water: [0.3, 0.7, 1], waterRemove: [0.8, 0.6, 0.3], biome: [0.9, 0.7, 0.3], 'delete': [1, 0.2, 0.2], spawn: [0.8, 0.8, 1] };
      E.renderer.terrain.brushColor = colors[this.tool] || [1, 0.8, 0.3];
    } else tb[3] = 0;
    // strokes
    var lmb = (input.mouse.buttons & 1) && !input.locked;
    if (input.mouse.clicked[0] && this.hit && !input.locked) this._beginStroke();
    if (this.stroking && lmb && this.hit) this._apply(dt);
    if (this.stroking && !lmb) this._endStroke();
    // flush chunk updates (throttled for performance)
    this._acc += dt;
    if (this._pendingBox && this._acc > 0.06) { this._flush(); }
  };

  P._beginStroke = function () {
    var ed = this.engine.edits;
    this.stroking = true;
    this._stampT = 0;
    ed.beginStroke(this.tool);
    this._flatTarget = this.hit[1];
    if (this.tool === 'spawn') this._spawn(this.hit);
    if (this.tool === 'delete') this._delete(this.hit);
  };
  P._endStroke = function () {
    this.stroking = false;
    this.engine.edits.endStroke();
    this._flush();
    TERRA.events.emit('edited');
  };
  P._grow = function (bb) {
    if (!bb) return;
    var p = this._pendingBox;
    this._pendingBox = p ? [Math.min(p[0], bb[0]), Math.min(p[1], bb[1]), Math.max(p[2], bb[2]), Math.max(p[3], bb[3])] : bb.slice();
  };
  P._flush = function () {
    var bb = this._pendingBox;
    this._pendingBox = null; this._acc = 0;
    if (!bb) return;
    this.engine.chunks.onEdit(bb[0], bb[1], bb[2], bb[3]);
    var veg = this.engine.vegetation;
    if (veg) { veg.invalidateField(); veg._dirtyFar = true; veg._poiAt = null; }
  };

  P._apply = function (dt) {
    var E = this.engine, ed = E.edits, B = this.brush, h = this.hit, tool = this.tool;
    var sampleH = function (x, z) { return E.groundHeight(x, z); };
    var bb = null;
    switch (tool) {
      case 'raise': case 'lower': case 'smooth':
        bb = ed.applyHeight(tool, h[0], h[2], B, dt, sampleH); break;
      case 'flatten':
        bb = ed.applyHeight('flatten', h[0], h[2], B, dt, sampleH, { target: this._flatTarget }); break;
      case 'mountain': case 'valley':
        this._stampT -= dt;
        if (this._stampT <= 0) { this._stampT = 0.45; bb = ed.applyHeight(tool, h[0], h[2], B, 1, sampleH); }
        break;
      case 'paint':
        bb = ed.applyPaint(h[0], h[2], B, dt, this.material); break;
      case 'biome':
        var bt = BIOME_TARGETS[this.biomeTarget] || [14, 0.5];
        bb = ed.applyBiome(h[0], h[2], B, dt, (bt[0] + 40) / 80, bt[1]); break;
      case 'water':
        this._stampT -= dt;
        if (this._stampT <= 0) { this._stampT = 0.3; bb = ed.applyWater(h[0], h[2], B, E.groundHeight(h[0], h[2]) + 0.6 + B.strength * 1.5, sampleH, false); }
        break;
      case 'waterRemove':
        var wl = E.waterAt(h[0], h[2]);
        bb = ed.applyWater(h[0], h[2], B, wl.level > -1e4 ? wl.level : E.groundHeight(h[0], h[2]), sampleH, true); break;
      case 'vegPaint': case 'rocks':
        this._stampT -= dt;
        if (this._stampT <= 0) { this._stampT = 0.12; this._scatter(tool, h, B); }
        break;
      case 'vegRemove':
        this._stampT -= dt;
        if (this._stampT <= 0) { this._stampT = 0.1; ed.vegRemove.push(h[0], h[2], B.radius); this._removeAdded(h, B.radius); this.engine.vegetation._dirtyFar = true; }
        break;
    }
    this._grow(bb);
  };

  P._scatter = function (tool, h, B) {
    var E = this.engine, ed = E.edits;
    var area = Math.PI * B.radius * B.radius;
    var n = Math.max(1, Math.round(area / (tool === 'rocks' ? 60 : 45) * B.strength));
    n = Math.min(n, 25);
    var vt = tool === 'rocks' ? (Math.random() < 0.4 ? [0, 10] : [1, 5]) : VEG_TYPES[this.vegType] || [0, 2];
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * B.radius;
      var x = h[0] + Math.cos(a) * r, z = h[2] + Math.sin(a) * r;
      var y = E.groundHeight(x, z);
      var sc = vt[0] === 0 ? (vt[1] === 10 ? 0.6 + Math.random() * 1.8 : 0.7 + Math.random() * 0.5) : 0.6 + Math.random() * 0.8;
      if (tool === 'rocks' && vt[0] === 1) sc = 0.4 + Math.random() * 1.2;
      ed.vegAdd.push(x, y - (vt[1] === 10 && vt[0] === 0 ? sc * 0.35 : 0.05), z, Math.random() * 6.28, sc, vt[1], Math.floor(Math.random() * 4), Math.random(), vt[0]);
    }
    E.vegetation._dirtyFar = true;
  };
  P._removeAdded = function (h, r) {
    var va = this.engine.edits.vegAdd, out = [];
    for (var i = 0; i < va.length; i += 9) { if (Math.hypot(va[i] - h[0], va[i + 2] - h[2]) > r) for (var k = 0; k < 9; k++) out.push(va[i + k]); }
    this.engine.edits.vegAdd = out;
  };
  P._spawn = function (h) {
    var st = SPAWN_TYPES[this.spawnType] || ['structure', 1];
    var E = this.engine;
    var obj = { kind: st[0], type: st[1], x: h[0], y: E.groundHeight(h[0], h[2]) - (st[0] === 'structure' ? 0.1 : 0.05), z: h[2], rot: E.player.yaw + Math.PI, scale: st[0] === 'tree' && st[1] === 10 ? 2 : 1, variant: Math.floor(Math.random() * 3), seed: Math.random(), id: 'o' + Date.now().toString(36) + Math.floor(Math.random() * 1000) };
    E.edits.objects.push(obj);
    TERRA.ui.toast && TERRA.ui.toast('Spawned ' + this.spawnType);
  };
  P._delete = function (h) {
    var ed = this.engine.edits, best = -1, bd = 12;
    for (var i = 0; i < ed.objects.length; i++) { var o = ed.objects[i]; var d = Math.hypot(o.x - h[0], o.z - h[2]); if (d < bd) { bd = d; best = i; } }
    if (best >= 0) { ed.objects.splice(best, 1); TERRA.ui.toast && TERRA.ui.toast('Object deleted'); return; }
    // otherwise remove vegetation at the point
    ed.vegRemove.push(h[0], h[2], Math.max(2, this.brush.radius * 0.25));
    this._removeAdded(h, Math.max(2, this.brush.radius * 0.25));
    this.engine.vegetation._dirtyFar = true;
  };

  P.undo = function () {
    var bb = this.engine.edits.undo();
    if (bb) { this._grow(bb); this._flush(); TERRA.ui.toast && TERRA.ui.toast('Undo'); }
  };
  P.redo = function () {
    var bb = this.engine.edits.redo();
    if (bb) { this._grow(bb); this._flush(); TERRA.ui.toast && TERRA.ui.toast('Redo'); }
  };

  TERRA.game.Editor = Editor;
})();
