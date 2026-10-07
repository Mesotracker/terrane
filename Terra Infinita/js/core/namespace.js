/* =============================================================================
 * TERRA INFINITA — namespace, utilities, event bus, settings store
 * All modules are classic scripts (no ES modules) so the project runs from file://
 * ========================================================================== */
(function () {
  'use strict';
  var T = window.TERRA = window.TERRA || {};
  T.version = '1.0.0';
  T.gfx = T.gfx || {}; T.world = T.world || {}; T.env = T.env || {};
  T.game = T.game || {}; T.ui = T.ui || {}; T.shaders = T.shaders || {}; T.data = T.data || {};

  /* ---------------- utilities ---------------- */
  var U = T.util = {};
  U.clamp = function (x, a, b) { return x < a ? a : (x > b ? b : x); };
  U.clamp01 = function (x) { return x < 0 ? 0 : (x > 1 ? 1 : x); };
  U.mix = function (a, b, t) { return a + (b - a) * t; };
  U.smoothstep = function (e0, e1, x) { var t = U.clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
  U.damp = function (a, b, lambda, dt) { return U.mix(a, b, 1 - Math.exp(-lambda * dt)); };
  U.approach = function (a, b, step) { return a < b ? Math.min(b, a + step) : Math.max(b, a - step); };
  U.fract = function (x) { return x - Math.floor(x); };
  U.lerpAngle = function (a, b, t) { var d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; return a + d * t; };
  U.now = function () { return performance.now(); };
  U.fmt = function (n, d) { return (+n).toFixed(d === undefined ? 1 : d); };
  U.fmtDist = function (m) { return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 2 : 1) + ' km'; };
  U.fmtTime = function (h) { h = ((h % 24) + 24) % 24; var hh = Math.floor(h), mm = Math.floor((h - hh) * 60); return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm; };
  U.randomSeedString = function () {
    var words = ['AURORA', 'BOREAL', 'CANYON', 'DELTA', 'EMBER', 'FJORD', 'GLACIER', 'HIGHLAND', 'ISLE', 'JADE', 'KESTREL', 'LAGOON', 'MESA', 'NORTH', 'OASIS', 'PINE', 'QUARTZ', 'RIDGE', 'SIERRA', 'TUNDRA', 'UMBER', 'VALE', 'WILD', 'XERIC', 'YONDER', 'ZEPHYR'];
    return words[Math.floor(Math.random() * words.length)] + '-' + Math.floor(Math.random() * 90000 + 10000);
  };
  U.deepClone = function (o) { return JSON.parse(JSON.stringify(o)); };
  U.deepMerge = function (dst, src) {
    for (var k in src) {
      if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) { if (!dst[k] || typeof dst[k] !== 'object') dst[k] = {}; U.deepMerge(dst[k], src[k]); }
      else dst[k] = src[k];
    }
    return dst;
  };
  U.safeStorage = {
    get: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    del: function (k) { try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };
  U.download = function (filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  };
  /** base64 <-> typed array helpers for save files */
  U.bufToB64 = function (u8) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  };
  U.b64ToBuf = function (b64) {
    var s = atob(b64), u8 = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  };
  U.log = function () { var a = ['%c[TERRA]', 'color:#7fb4ff']; for (var i = 0; i < arguments.length; i++) a.push(arguments[i]); console.log.apply(console, a); };
  U.warn = function () { var a = ['[TERRA]']; for (var i = 0; i < arguments.length; i++) a.push(arguments[i]); console.warn.apply(console, a); };

  /* ---------------- event bus ---------------- */
  var listeners = {};
  T.events = {
    on: function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); return fn; },
    off: function (name, fn) { var l = listeners[name]; if (!l) return; var i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); },
    emit: function (name, data) { var l = listeners[name]; if (!l) return; for (var i = 0; i < l.length; i++) { try { l[i](data); } catch (e) { console.error(e); } } }
  };

  /* ---------------- global error guard ---------------- */
  // Never let a single failure crash the whole experience: log and show a toast.
  window.addEventListener('error', function (e) {
    if (T.ui && T.ui.toast) T.ui.toast('Recovered from an error: ' + (e.message || 'unknown'), 'warn');
  });
})();
