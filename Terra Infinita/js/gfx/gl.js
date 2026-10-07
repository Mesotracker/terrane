/* =============================================================================
 * TERRA INFINITA — thin WebGL2 layer
 * Context creation, capability detection, shader compilation with #include,
 * textures, framebuffers, buffers, and a few state helpers.
 * ========================================================================== */
(function () {
  'use strict';
  var U = TERRA.util;

  function GL(canvas) {
    var gl = canvas.getContext('webgl2', {
      antialias: false, alpha: false, depth: false, stencil: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: false, premultipliedAlpha: false
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.canvas = canvas;
    this.caps = {
      colorFloat: !!gl.getExtension('EXT_color_buffer_float'),
      floatLinear: !!gl.getExtension('OES_texture_float_linear'),
      halfFloatBlend: !!gl.getExtension('EXT_float_blend'),
      clipControl: gl.getExtension('EXT_clip_control'),
      aniso: gl.getExtension('EXT_texture_filter_anisotropic'),
      timer: gl.getExtension('EXT_disjoint_timer_query_webgl2'),
      debugInfo: gl.getExtension('WEBGL_debug_renderer_info'),
      maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
      maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS)
    };
    this.caps.maxAniso = this.caps.aniso ? gl.getParameter(this.caps.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1;
    this.caps.renderer = this.caps.debugInfo ? gl.getParameter(this.caps.debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    this.caps.reversedZ = !!this.caps.clipControl;
    if (this.caps.reversedZ) {
      var cc = this.caps.clipControl;
      cc.clipControlEXT(cc.LOWER_LEFT_EXT, cc.ZERO_TO_ONE_EXT);
    }
    // HDR render target format (fallback to RGBA8 when float targets are unavailable)
    this.hdrFormat = this.caps.colorFloat ? { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT } : { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
    this.programs = [];
    this.stats = { drawCalls: 0, triangles: 0, instances: 0 };
    this._fsTri = null;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    U.log('WebGL2 ready:', this.caps.renderer, 'reversedZ=' + this.caps.reversedZ, 'floatRT=' + this.caps.colorFloat);
  }
  var P = GL.prototype;

  /* ---------------- shaders ---------------- */
  P.preprocess = function (src, defines) {
    var lib = TERRA.shaders.lib || {};
    var seen = {};
    function inc(s, depth) {
      if (depth > 8) return s;
      return s.replace(/^[ \t]*#include\s+<(\w+)>[ \t]*$/gm, function (m, name) {
        if (seen[name]) return '';
        seen[name] = true;
        if (!(name in lib)) { U.warn('missing shader chunk', name); return ''; }
        return inc(lib[name], depth + 1);
      });
    }
    var header = '#version 300 es\n' +
      'precision highp float;\nprecision highp int;\nprecision highp sampler2D;\nprecision highp sampler2DArray;\n' +
      'precision highp sampler3D;\nprecision highp sampler2DShadow;\nprecision highp sampler2DArrayShadow;\n';
    var defs = '';
    if (this.caps.reversedZ) defs += '#define REVERSED_Z 1\n';
    if (defines) for (var k in defines) { if (defines[k] === false || defines[k] === null || defines[k] === undefined) continue; defs += '#define ' + k + ' ' + (defines[k] === true ? 1 : defines[k]) + '\n'; }
    return header + defs + inc(src, 0);
  };

  P.compile = function (type, src, name) {
    var gl = this.gl, sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh) || '';
      var lines = src.split('\n');
      var m = /ERROR: \d+:(\d+)/.exec(log), ctx = '';
      if (m) { var ln = +m[1]; for (var i = Math.max(1, ln - 3); i <= Math.min(lines.length, ln + 2); i++) ctx += i + ': ' + lines[i - 1] + '\n'; }
      console.error('Shader compile error in ' + name + ':\n' + log + '\n' + ctx);
      gl.deleteShader(sh);
      throw new Error('Shader "' + name + '" failed to compile: ' + log.split('\n')[0]);
    }
    return sh;
  };

  /** Create a program. Returns an object with `use()`, `loc(name)` and uniform setters. */
  P.program = function (name, vs, fs, defines, opts) {
    var gl = this.gl;
    var vsrc = this.preprocess(vs, defines), fsrc = this.preprocess(fs, defines);
    var v = this.compile(gl.VERTEX_SHADER, vsrc, name + '.vs'), f = this.compile(gl.FRAGMENT_SHADER, fsrc, name + '.fs');
    var p = gl.createProgram();
    gl.attachShader(p, v); gl.attachShader(p, f);
    if (opts && opts.attribs) for (var a in opts.attribs) gl.bindAttribLocation(p, opts.attribs[a], a);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      var log = gl.getProgramInfoLog(p);
      console.error('Link error in ' + name + ': ' + log);
      throw new Error('Program "' + name + '" failed to link: ' + log);
    }
    gl.deleteShader(v); gl.deleteShader(f);
    var blk = gl.getUniformBlockIndex(p, 'Frame');
    if (blk !== gl.INVALID_INDEX) gl.uniformBlockBinding(p, blk, 0);
    var locs = {};
    var self = this;
    var prog = {
      name: name, p: p,
      use: function () { gl.useProgram(p); return prog; },
      loc: function (n) { if (!(n in locs)) locs[n] = gl.getUniformLocation(p, n); return locs[n]; },
      i: function (n, x) { gl.uniform1i(prog.loc(n), x); return prog; },
      f: function (n, x) { gl.uniform1f(prog.loc(n), x); return prog; },
      v2: function (n, x, y) { gl.uniform2f(prog.loc(n), x, y); return prog; },
      v3: function (n, x, y, z) { gl.uniform3f(prog.loc(n), x, y, z); return prog; },
      v4: function (n, x, y, z, w) { gl.uniform4f(prog.loc(n), x, y, z, w); return prog; },
      v4a: function (n, arr) { gl.uniform4fv(prog.loc(n), arr); return prog; },
      v3a: function (n, arr) { gl.uniform3fv(prog.loc(n), arr); return prog; },
      m4: function (n, m) { gl.uniformMatrix4fv(prog.loc(n), false, m); return prog; },
      m4a: function (n, m) { gl.uniformMatrix4fv(prog.loc(n), false, m); return prog; },
      tex: function (n, unit, tex, target) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(target || gl.TEXTURE_2D, tex); gl.uniform1i(prog.loc(n), unit); return prog; },
      destroy: function () { gl.deleteProgram(p); var i = self.programs.indexOf(prog); if (i >= 0) self.programs.splice(i, 1); }
    };
    this.programs.push(prog);
    return prog;
  };

  /* ---------------- textures ---------------- */
  P.texture2D = function (w, h, o) {
    var gl = this.gl; o = o || {};
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    var internal = o.internal || gl.RGBA8, format = o.format || gl.RGBA, type = o.type || gl.UNSIGNED_BYTE;
    if (o.immutable !== false && !o.data) {
      var levels = o.mips ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
      gl.texStorage2D(gl.TEXTURE_2D, levels, internal, w, h);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, o.data || null);
    }
    var filter = o.filter || gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, o.mips ? gl.LINEAR_MIPMAP_LINEAR : filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    var wrap = o.wrap || gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    if (o.compare) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, o.compare);
    }
    if (o.aniso && this.caps.aniso) gl.texParameterf(gl.TEXTURE_2D, this.caps.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(o.aniso, this.caps.maxAniso));
    t.w = w; t.h = h; t.internal = internal; t.format = format; t.type = type;
    return t;
  };
  P.textureArray = function (w, h, layers, o) {
    var gl = this.gl; o = o || {};
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    var internal = o.internal || gl.RGBA8;
    var levels = o.mips ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, internal, w, h, layers);
    var filter = o.filter || gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, o.mips ? gl.LINEAR_MIPMAP_LINEAR : filter);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, filter);
    var wrap = o.wrap || gl.REPEAT;
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, wrap);
    if (o.compare) {
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_FUNC, o.compare);
    }
    if (o.aniso && this.caps.aniso) gl.texParameterf(gl.TEXTURE_2D_ARRAY, this.caps.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(o.aniso, this.caps.maxAniso));
    t.w = w; t.h = h; t.layers = layers; t.internal = internal;
    return t;
  };
  P.texture3D = function (w, h, d, o) {
    var gl = this.gl; o = o || {};
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texStorage3D(gl.TEXTURE_3D, o.mips ? Math.floor(Math.log2(Math.max(w, h, d))) + 1 : 1, o.internal || gl.RGBA8, w, h, d);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, o.mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);
    t.w = w; t.h = h; t.d = d;
    return t;
  };
  P.deleteTexture = function (t) { if (t) this.gl.deleteTexture(t); };

  /* ---------------- framebuffers ---------------- */
  /** colors: array of {tex, layer?, level?} or textures; depth: texture or {tex, layer}. */
  P.framebuffer = function (colors, depth) {
    var gl = this.gl, fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    var bufs = [];
    (colors || []).forEach(function (c, i) {
      var tex = c.tex || c;
      if (c.layer !== undefined) gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, tex, c.level || 0, c.layer);
      else gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, c.level || 0);
      bufs.push(gl.COLOR_ATTACHMENT0 + i);
    });
    if (depth) {
      var dt = depth.tex || depth;
      if (depth.layer !== undefined) gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, dt, 0, depth.layer);
      else gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, dt, 0);
    }
    gl.drawBuffers(bufs.length ? bufs : [gl.NONE]);
    if (!bufs.length) gl.readBuffer(gl.NONE);
    var st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) U.warn('Framebuffer incomplete: 0x' + st.toString(16));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    fb.count = bufs.length;
    fb.ok = st === gl.FRAMEBUFFER_COMPLETE;
    return fb;
  };
  P.bindFB = function (fb, w, h) {
    var gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, w, h);
  };

  /* ---------------- buffers & geometry ---------------- */
  P.buffer = function (target, data, usage) {
    var gl = this.gl, b = gl.createBuffer();
    gl.bindBuffer(target, b);
    gl.bufferData(target, data, usage || gl.STATIC_DRAW);
    b.size = data.byteLength !== undefined ? data.byteLength : data;
    return b;
  };
  /** Fullscreen triangle (no vertex buffers; uses gl_VertexID). */
  P.drawFullscreen = function () {
    var gl = this.gl;
    if (!this._fsTri) this._fsTri = gl.createVertexArray();
    gl.bindVertexArray(this._fsTri);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.stats.drawCalls++;
  };

  /* ---------------- GPU timing (optional) ---------------- */
  P.timerBegin = function () {
    if (!this.caps.timer || this._timerActive) return;
    var gl = this.gl;
    if (!this._queries) this._queries = [];
    var q = gl.createQuery();
    gl.beginQuery(this.caps.timer.TIME_ELAPSED_EXT, q);
    this._timerActive = q;
  };
  P.timerEnd = function () {
    if (!this._timerActive) return;
    var gl = this.gl;
    gl.endQuery(this.caps.timer.TIME_ELAPSED_EXT);
    this._queries.push(this._timerActive);
    this._timerActive = null;
    // poll oldest
    while (this._queries.length) {
      var q = this._queries[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      var disjoint = gl.getParameter(this.caps.timer.GPU_DISJOINT_EXT);
      if (!disjoint) this.gpuMs = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(q);
      this._queries.shift();
    }
    if (this._queries.length > 6) { gl.deleteQuery(this._queries.shift()); }
  };

  TERRA.gfx.GL = GL;
})();
