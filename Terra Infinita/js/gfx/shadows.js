/* =============================================================================
 * TERRA INFINITA — cascaded shadow maps
 * Up to 4 cascades in a depth texture array. Each cascade is a light-space
 * orthographic box fitted to a slice of the view frustum, snapped to texel
 * increments so shadows don't shimmer when the camera moves.
 * ========================================================================== */
(function () {
  'use strict';
  var M = TERRA.math, U = TERRA.util;

  function Shadows(R) {
    this.R = R; this.G = R.G; this.gl = R.G.gl;
    this.size = 0; this.count = 0;
    this.mats = [M.mat4(), M.mat4(), M.mat4(), M.mat4()];
    this.matArr = new Float32Array(64);
    this.splits = [0, 0, 0, 0];
    this.planes = [new Float32Array(24), new Float32Array(24), new Float32Array(24), new Float32Array(24)];
    this.lightDir = [0, 1, 0];
    this.frame = 0;
  }
  var P = Shadows.prototype;

  P.configure = function (quality) {
    var gl = this.gl;
    var cfg = [[0, 0], [1024, 2], [2048, 3], [2048, 4], [4096, 4]][U.clamp(quality | 0, 0, 4)];
    this.enabled = cfg[0] > 0;
    this.soft = quality >= 3 ? 2 : 1;
    if (cfg[0] === this.size && cfg[1] === this.count) return;
    if (this.tex) { gl.deleteTexture(this.tex); this.fbs.forEach(function (f) { gl.deleteFramebuffer(f); }); }
    this.size = cfg[0]; this.count = cfg[1];
    this.tex = null; this.fbs = [];
    if (!this.enabled) return;
    this.tex = this.G.textureArray(this.size, this.size, 4, { internal: gl.DEPTH_COMPONENT32F, filter: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE, compare: gl.LEQUAL });
    for (var i = 0; i < 4; i++) this.fbs.push(this.G.framebuffer([], { tex: this.tex, layer: i }));
    // splits (metres)
    var far = [0, 0, 180, 700, 2400][U.clamp(quality | 0, 0, 4)];
    this.splitDist = this.count === 2 ? [40, 280, 0, 0] : (this.count === 3 ? [30, 150, 700, 0] : [25, 110, 480, 1800]);
    if (quality >= 4) this.splitDist = [22, 90, 380, 2600];
    void far;
  };

  /** Compute cascade matrices for this frame. `cam` holds render-space position & basis.
   *  Cascades are camera-centred spheres of radius = split distance: rotation-invariant
   *  (no re-fit when looking around) and, for a wide field of view, tighter than a sphere
   *  around the frustum slice. Because they do not depend on the view direction, the far
   *  cascades can be re-rendered less often (see render) without visible swimming. */
  P.update = function (frame) {
    if (!this.enabled) return;
    var cam = frame.cam, L = frame.env.lightDir;
    this.lightDir = L;
    var zeroToOne = this.G.caps.reversedZ;
    if (!this.next) { this.next = [M.mat4(), M.mat4(), M.mat4(), M.mat4()]; this.nextPlanes = [new Float32Array(24), new Float32Array(24), new Float32Array(24), new Float32Array(24)]; this.lastCtr = [null, null, null, null]; this.lastL = [null, null, null, null]; this.age = [99, 99, 99, 99]; }
    for (var c = 0; c < this.count; c++) {
      var far = this.splitDist[c] * (frame.shadowRangeScale || 1);
      this.splits[c] = far;
      var r = Math.ceil(far * 1.06 + 2);
      var ctr = [cam.pos[0], cam.pos[1], cam.pos[2]];
      var up = Math.abs(L[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
      var eye = [ctr[0] + L[0] * 6000, ctr[1] + L[1] * 6000, ctr[2] + L[2] * 6000];
      var view = M.lookAt(M.mat4(), eye, ctr, up);
      // snap centre to texel grid in light space (no shimmer while moving)
      var texel = (2 * r) / this.size;
      var lc = M.transformPoint([0, 0, 0], view, ctr[0], ctr[1], ctr[2]);
      var sx = Math.round(lc[0] / texel) * texel - lc[0], sy = Math.round(lc[1] / texel) * texel - lc[1];
      var proj = M.ortho(M.mat4(), -r + sx, r + sx, -r + sy, r + sy, 10, 12000, zeroToOne);
      M.multiply(this.next[c], proj, view);
      M.frustumFromMatrix(this.next[c], this.nextPlanes[c], zeroToOne);
      this._radius = this._radius || []; this._radius[c] = r;
    }
    this.texelWorld = (2 * Math.ceil(this.splitDist[0] * 1.06 + 2)) / this.size;
  };

  /** Render the cascades that are due; `drawCasters(cascadeIndex, viewProj, planes)` issues
   *  draw calls. Near cascades render every frame; the large far cascades are cached and
   *  refreshed every 2nd / 4th frame (staggered so they never land on the same frame), or at
   *  once when the camera has moved a noticeable fraction of the cascade or the light moved. */
  P.render = function (frame, drawCasters) {
    if (!this.enabled) return;
    var gl = this.gl;
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.colorMask(false, false, false, false);
    this.frame++;
    var cam = frame.cam.pos, L = this.lightDir, stagger = frame.settings.shadowCache !== false;
    var period = frame.performance ? [1, 2, 4, 8] : [1, 1, 2, 4];
    var phase = [0, 0, 1, 2];
    for (var c = 0; c < this.count; c++) {
      this.age[c]++;
      var lc = this.lastCtr[c], ll = this.lastL[c], r = this._radius[c];
      var moved = !lc || Math.hypot(cam[0] - lc[0], cam[1] - lc[1], cam[2] - lc[2]) > r * 0.06;
      var lmoved = !ll || Math.abs(L[0] - ll[0]) + Math.abs(L[1] - ll[1]) + Math.abs(L[2] - ll[2]) > 0.002;
      var due = !stagger || period[c] === 1 || moved || lmoved || frame.originChanged || this.age[c] >= period[c] * 2 ||
        ((this.frame + phase[c]) % period[c]) === 0;
      if (!due) continue;
      M.copy(this.mats[c], this.next[c]);
      this.planes[c].set(this.nextPlanes[c]);
      this.matArr.set(this.mats[c], c * 16);
      this.lastCtr[c] = [cam[0], cam[1], cam[2]]; this.lastL[c] = [L[0], L[1], L[2]]; this.age[c] = 0;
      this.G.bindFB(this.fbs[c], this.size, this.size);
      gl.clearDepth(1.0);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.polygonOffset(1.5 + c * 0.5, 2.0 + c);
      drawCasters(c, this.mats[c], this.planes[c]);
    }
    gl.colorMask(true, true, true, true);
    gl.disable(gl.POLYGON_OFFSET_FILL);
  };

  /** Bind shadow uniforms on a program that includes <shadows>. */
  P.bind = function (prog, unit) {
    var gl = this.gl;
    if (!this.enabled) {
      prog.tex('uShadowMap', unit, this.R.tex.dummyShadow, gl.TEXTURE_2D_ARRAY);
      prog.v4('uShadowParams', 0, 0, 0, 0);
      return;
    }
    prog.tex('uShadowMap', unit, this.tex, gl.TEXTURE_2D_ARRAY);
    gl.uniformMatrix4fv(prog.loc('uShadowMat[0]'), false, this.matArr);
    prog.v4('uShadowSplits', this.splits[0], this.splits[1] || 1e9, this.splits[2] || 1e9, this.splits[3] || 1e9);
    prog.v4('uShadowParams', this.texelWorld, this.count, this.soft === 2 ? 2.2 : 1.2, 1);
  };

  TERRA.gfx.Shadows = Shadows;
})();
