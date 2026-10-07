/* =============================================================================
 * TERRA INFINITA — saving & loading (IndexedDB with localStorage fallback)
 * World files are plain JSON (seed, generation parameters, player, environment,
 * editor changes, discoveries) and can be exported/imported.
 * ========================================================================== */
(function () {
  'use strict';
  var U = TERRA.util;
  var DB = 'terra-infinita', STORE = 'worlds';

  function SaveSystem() { this.db = null; this.fallback = false; }
  var P = SaveSystem.prototype;

  P.open = function () {
    var self = this;
    if (this._opening) return this._opening;
    this._opening = new Promise(function (resolve) {
      if (!window.indexedDB) { self.fallback = true; resolve(); return; }
      try {
        var req = indexedDB.open(DB, 1);
        req.onupgradeneeded = function () { req.result.createObjectStore(STORE, { keyPath: 'slot' }); };
        req.onsuccess = function () { self.db = req.result; resolve(); };
        req.onerror = function () { self.fallback = true; resolve(); };
        req.onblocked = function () { self.fallback = true; resolve(); };
      } catch (e) { self.fallback = true; resolve(); }
    });
    return this._opening;
  };
  P._tx = function (mode) { return this.db.transaction(STORE, mode).objectStore(STORE); };

  P.list = function () {
    var self = this;
    return this.open().then(function () {
      if (self.fallback || !self.db) {
        var out = [];
        for (var i = 0; i < 8; i++) { var s = U.safeStorage.get('terra.save.' + i); if (s) { try { var d = JSON.parse(s); out.push(self._meta(d)); } catch (e) { /* skip */ } } }
        return out;
      }
      return new Promise(function (resolve) {
        var req = self._tx('readonly').getAll();
        req.onsuccess = function () { resolve(req.result.map(function (d) { return self._meta(d); })); };
        req.onerror = function () { resolve([]); };
      });
    });
  };
  P._meta = function (d) { return { slot: d.slot, name: d.name, seed: d.seed, savedAt: d.savedAt, thumb: d.thumb, biome: d.biome, pos: d.player && d.player.pos }; };

  P.save = function (slot, data) {
    var self = this;
    data.slot = slot;
    data.savedAt = Date.now();
    return this.open().then(function () {
      if (self.fallback || !self.db) {
        var ok = U.safeStorage.set('terra.save.' + slot, JSON.stringify(data));
        if (!ok) throw new Error('Browser storage is full or unavailable. Try exporting the world instead.');
        return;
      }
      return new Promise(function (resolve, reject) {
        var req = self._tx('readwrite').put(data);
        req.onsuccess = function () { resolve(); };
        req.onerror = function () { reject(req.error); };
      });
    });
  };
  P.load = function (slot) {
    var self = this;
    return this.open().then(function () {
      if (self.fallback || !self.db) { var s = U.safeStorage.get('terra.save.' + slot); return s ? JSON.parse(s) : null; }
      return new Promise(function (resolve) {
        var req = self._tx('readonly').get(slot);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { resolve(null); };
      });
    });
  };
  P.remove = function (slot) {
    var self = this;
    return this.open().then(function () {
      if (self.fallback || !self.db) { U.safeStorage.del('terra.save.' + slot); return; }
      return new Promise(function (resolve) { var req = self._tx('readwrite').delete(slot); req.onsuccess = req.onerror = function () { resolve(); }; });
    });
  };

  /* ---------------- settings ---------------- */
  P.loadSettings = function () {
    var s = U.safeStorage.get('terra.settings');
    var d = U.deepClone(TERRA.data.defaultSettings);
    if (s) { try { U.deepMerge(d, JSON.parse(s)); } catch (e) { /* keep defaults */ } }
    return d;
  };
  P.saveSettings = function (settings) { U.safeStorage.set('terra.settings', JSON.stringify(settings)); };

  /* ---------------- import / export ---------------- */
  P.exportWorld = function (data) {
    var name = (data.name || 'world').replace(/[^a-z0-9_-]+/gi, '_');
    U.download(name + '.terra.json', JSON.stringify(data));
  };
  P.importFile = function (file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () {
        try {
          var d = JSON.parse(r.result);
          if (d.format !== 'terra-infinita-world') throw new Error('Not a TERRA world file');
          resolve(d);
        } catch (e) { reject(e); }
      };
      r.onerror = function () { reject(r.error); };
      r.readAsText(file);
    });
  };

  TERRA.game.SaveSystem = SaveSystem;
})();
