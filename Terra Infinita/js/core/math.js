/* =============================================================================
 * TERRA INFINITA — compact linear algebra (column-major, OpenGL conventions)
 * ========================================================================== */
(function () {
  'use strict';
  var M = TERRA.math = {};

  M.mat4 = function () { var m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
  M.identity = function (m) { m.fill(0); m[0] = m[5] = m[10] = m[15] = 1; return m; };
  M.copy = function (o, a) { o.set(a); return o; };

  M.multiply = function (out, a, b) {
    var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7],
        a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    for (var i = 0; i < 4; i++) {
      var b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
      out[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    }
    return out;
  };

  M.invert = function (out, a) {
    var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7],
        a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    var b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10,
        b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12,
        b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30,
        b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    var det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return null;
    det = 1.0 / det;
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return out;
  };

  /** Standard GL perspective (depth -1..1). */
  M.perspective = function (out, fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    out.fill(0);
    out[0] = f / aspect; out[5] = f; out[10] = (far + near) * nf; out[11] = -1; out[14] = 2 * far * near * nf;
    return out;
  };
  /** Reversed-Z infinite perspective for glClipControl(LOWER_LEFT, ZERO_TO_ONE): depth = near / -z. */
  M.perspectiveReversedInf = function (out, fovy, aspect, near) {
    var f = 1 / Math.tan(fovy / 2);
    out.fill(0);
    out[0] = f / aspect; out[5] = f; out[10] = 0; out[11] = -1; out[14] = near;
    return out;
  };
  /** Orthographic, GL depth convention (-1..1) or zeroToOne. */
  M.ortho = function (out, l, r, b, t, n, f, zeroToOne) {
    var lr = 1 / (l - r), bt = 1 / (b - t), nf = 1 / (n - f);
    out.fill(0);
    out[0] = -2 * lr; out[5] = -2 * bt;
    out[12] = (l + r) * lr; out[13] = (t + b) * bt; out[15] = 1;
    if (zeroToOne) { out[10] = nf; out[14] = n * nf; }
    else { out[10] = 2 * nf; out[14] = (f + n) * nf; }
    return out;
  };
  M.lookAt = function (out, eye, center, up) {
    var zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
    var l = 1 / Math.hypot(zx, zy, zz); zx *= l; zy *= l; zz *= l;
    var xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    l = Math.hypot(xx, xy, xz); if (l < 1e-9) { xx = 1; xy = 0; xz = 0; l = 1; } l = 1 / l; xx *= l; xy *= l; xz *= l;
    var yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
    out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
    out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
    out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    out[15] = 1;
    return out;
  };
  M.transformPoint = function (out, m, x, y, z) {
    var w = m[3] * x + m[7] * y + m[11] * z + m[15];
    out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
    return out;
  };

  M.v3 = function (x, y, z) { return [x || 0, y || 0, z || 0]; };
  M.norm3 = function (v) { var l = Math.hypot(v[0], v[1], v[2]) || 1; v[0] /= l; v[1] /= l; v[2] /= l; return v; };
  M.cross3 = function (a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; };
  M.dot3 = function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; };

  /** Frustum as 6 planes (nx, ny, nz, d); point p is inside when dot(n,p)+d >= 0. Extracted from any clip matrix. */
  M.frustumFromMatrix = function (m, planes, zeroToOne) {
    planes = planes || new Float32Array(24);
    function set(i, a, b, c, d) { var l = Math.hypot(a, b, c) || 1; planes[i * 4] = a / l; planes[i * 4 + 1] = b / l; planes[i * 4 + 2] = c / l; planes[i * 4 + 3] = d / l; }
    set(0, m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]);   // left
    set(1, m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]);   // right
    set(2, m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]);   // bottom
    set(3, m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]);   // top
    if (zeroToOne) set(4, m[2], m[6], m[10], m[14]);                  // near (z >= 0)
    else set(4, m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]);
    set(5, m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]);   // far
    return planes;
  };
  /** Test AABB against planes; `count` planes are used (skip far plane for infinite projections). */
  M.aabbInFrustum = function (planes, minx, miny, minz, maxx, maxy, maxz, count) {
    count = count || 6;
    for (var i = 0; i < count; i++) {
      var a = planes[i * 4], b = planes[i * 4 + 1], c = planes[i * 4 + 2], d = planes[i * 4 + 3];
      var px = a > 0 ? maxx : minx, py = b > 0 ? maxy : miny, pz = c > 0 ? maxz : minz;
      if (a * px + b * py + c * pz + d < 0) return false;
    }
    return true;
  };
  M.sphereInFrustum = function (planes, x, y, z, r, count) {
    count = count || 6;
    for (var i = 0; i < count; i++) {
      if (planes[i * 4] * x + planes[i * 4 + 1] * y + planes[i * 4 + 2] * z + planes[i * 4 + 3] < -r) return false;
    }
    return true;
  };
})();
