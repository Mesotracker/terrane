/* =============================================================================
 * TERRA INFINITA — input: keyboard, mouse, pointer lock, wheel
 * ========================================================================== */
(function () {
  'use strict';

  function Input(canvas) {
    this.canvas = canvas;
    this.keys = {};
    this.pressed = {};      // keys pressed this frame
    this.mouse = { dx: 0, dy: 0, x: 0, y: 0, buttons: 0, wheel: 0, clicked: [false, false, false], released: [false, false, false] };
    this.locked = false;
    this.enabled = true;
    var self = this;
    window.addEventListener('keydown', function (e) {
      if (self._isTyping(e)) return;
      if (!self.keys[e.code]) self.pressed[e.code] = true;
      self.keys[e.code] = true;
      if (self.enabled && (e.code === 'Tab' || e.code === 'Space' || e.code === 'F3' || (e.code.indexOf('Arrow') === 0))) e.preventDefault();
      if (e.ctrlKey && (e.code === 'KeyS' || e.code === 'KeyW')) e.preventDefault();
    });
    window.addEventListener('keyup', function (e) { self.keys[e.code] = false; });
    window.addEventListener('blur', function () { self.keys = {}; self.mouse.buttons = 0; });
    canvas.addEventListener('mousemove', function (e) {
      self.mouse.x = e.clientX; self.mouse.y = e.clientY;
    });
    document.addEventListener('mousemove', function (e) {
      if (self.locked) { self.mouse.dx += e.movementX || 0; self.mouse.dy += e.movementY || 0; }
    });
    canvas.addEventListener('mousedown', function (e) {
      self.mouse.buttons |= (1 << e.button);
      self.mouse.clicked[e.button] = true;
      if (self.onCanvasMouseDown) self.onCanvasMouseDown(e);
    });
    window.addEventListener('mouseup', function (e) {
      self.mouse.buttons &= ~(1 << e.button);
      self.mouse.released[e.button] = true;
      if (self.onMouseUp) self.onMouseUp(e);
    });
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    canvas.addEventListener('wheel', function (e) { self.mouse.wheel += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
    document.addEventListener('pointerlockchange', function () {
      var was = self.locked;
      self.locked = document.pointerLockElement === canvas;
      if (was && !self.locked && self.onUnlock) self.onUnlock();
    });
  }
  var P = Input.prototype;

  P._isTyping = function (e) {
    var t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  };
  P.down = function (code) { return this.enabled && !!this.keys[code]; };
  P.hit = function (code) { return this.enabled && !!this.pressed[code]; };
  P.lock = function () {
    if (this.locked) return;
    try {
      var r = this.canvas.requestPointerLock({ unadjustedMovement: false });
      if (r && r.catch) r.catch(function () { /* user gesture required; ignore */ });
    } catch (e) { /* ignore */ }
  };
  P.unlock = function () { if (document.pointerLockElement) { this._intentionalUnlock = true; document.exitPointerLock(); } };
  /** Call at the end of each frame. */
  P.endFrame = function () {
    this.pressed = {};
    this.mouse.dx = 0; this.mouse.dy = 0; this.mouse.wheel = 0;
    this.mouse.clicked = [false, false, false]; this.mouse.released = [false, false, false];
  };

  TERRA.game.Input = Input;
})();
