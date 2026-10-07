/* =============================================================================
 * TERRA INFINITA — GPU procedural texture generation
 * Produces:
 *   materials.albedoH  TEXTURE_2D_ARRAY  rgb albedo (sRGB) + height      (16 layers)
 *   materials.normalR  TEXTURE_2D_ARRAY  normal.xy, roughness, AO          (16 layers)
 *   noise              TEXTURE_2D        tileable multi-band noise
 *   cloudNoise         TEXTURE_3D        perlin-worley volume for clouds
 *   foliage.color/normal TEXTURE_2D_ARRAY alpha-tested leaf clusters
 * Optional image overrides (assets/textures/*.jpg) are tried only when served over http.
 * ========================================================================== */
(function () {
  'use strict';
  var S = TERRA.shaders, U = TERRA.util;

  var NORMAL_STRENGTH = [3.0, 3.0, 4.0, 6.5, 6.0, 2.5, 1.8, 6.0, 4.0, 3.0, 6.0, 4.0, 1.5, 7.0, 3.0, 5.0];

  function nextFrame() { return new Promise(function (r) { setTimeout(r, 0); }); }

  function TexGen(G) { this.G = G; this.gl = G.gl; }

  TexGen.prototype.generate = async function (quality, onProgress) {
    var G = this.G, gl = this.gl;
    var size = [256, 512, 1024, 1024][U.clamp(quality | 0, 0, 3)];
    var nLayers = TERRA.data.materials.length;
    var progMat = G.program('texgenMat', S.fullscreenVS, S.texgenMaterialFS);
    var progNrm = G.program('texgenNrm', S.fullscreenVS, S.texgenNormalFS);
    var aniso = [2, 4, 8, 16][U.clamp(quality | 0, 0, 3)];
    var albedoH = G.textureArray(size, size, nLayers, { mips: true, aniso: aniso });
    var normalR = G.textureArray(size, size, nLayers, { mips: true, aniso: aniso });
    var tmp = G.texture2D(size, size, { filter: gl.NEAREST });
    var seed = 17.31;
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    for (var L = 0; L < nLayers; L++) {
      var fb1 = G.framebuffer([{ tex: albedoH, layer: L }, tmp]);
      G.bindFB(fb1, size, size);
      progMat.use().i('uLayer', L).f('uSeed', seed + L * 3.17);
      G.drawFullscreen();
      var fb2 = G.framebuffer([{ tex: normalR, layer: L }]);
      G.bindFB(fb2, size, size);
      progNrm.use().i('uLayer', L).f('uStrength', NORMAL_STRENGTH[L] || 4).i('uSize', size)
        .tex('uAlbedoH', 0, albedoH, gl.TEXTURE_2D_ARRAY).tex('uRoughTmp', 1, tmp);
      G.drawFullscreen();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb1); gl.deleteFramebuffer(fb2);
      if (onProgress) onProgress((L + 1) / (nLayers + 4), 'Material: ' + TERRA.data.materials[L].name);
      await nextFrame();
    }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, albedoH); gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, normalR); gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.deleteTexture(tmp);
    progMat.destroy(); progNrm.destroy();
    this.materials = { albedoH: albedoH, normalR: normalR, size: size, layers: nLayers };

    // ---- utility noise texture
    var noise = G.texture2D(256, 256, { mips: true, wrap: gl.REPEAT });
    var pn = G.program('texgenNoise', S.fullscreenVS, S.texgenNoiseFS);
    var fbn = G.framebuffer([noise]);
    G.bindFB(fbn, 256, 256); pn.use().f('uSeed', 3.3); G.drawFullscreen();
    gl.bindTexture(gl.TEXTURE_2D, noise); gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fbn); pn.destroy();
    this.noise = noise;
    if (onProgress) onProgress((nLayers + 1) / (nLayers + 4), 'Noise fields');
    await nextFrame();

    // ---- 3D cloud noise
    var CS = 64;
    var cloud = G.texture3D(CS, CS, CS, { mips: true });
    var pc = G.program('texgenCloud', S.fullscreenVS, S.texgenCloudFS);
    for (var z = 0; z < CS; z++) {
      var fbc = G.framebuffer([{ tex: cloud, layer: z }]);
      G.bindFB(fbc, CS, CS);
      pc.use().f('uSlice', (z + 0.5) / CS).f('uSeed', 7.7);
      G.drawFullscreen();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fbc);
      if ((z & 15) === 15) await nextFrame();
    }
    gl.bindTexture(gl.TEXTURE_3D, cloud); gl.generateMipmap(gl.TEXTURE_3D);
    pc.destroy();
    this.cloudNoise = cloud;
    if (onProgress) onProgress((nLayers + 2) / (nLayers + 4), 'Cloud volumes');
    await nextFrame();

    // ---- foliage atlas
    var FS = quality >= 3 ? 1024 : (quality >= 1 ? 512 : 256), FL = 6;
    var fcol = G.textureArray(FS, FS, FL, { mips: true, wrap: gl.CLAMP_TO_EDGE, aniso: 4 });
    var fnrm = G.textureArray(FS, FS, FL, { mips: true, wrap: gl.CLAMP_TO_EDGE });
    var pf = G.program('texgenFoliage', S.fullscreenVS, S.texgenFoliageFS);
    for (var f = 0; f < FL; f++) {
      var fbf = G.framebuffer([{ tex: fcol, layer: f }, { tex: fnrm, layer: f }]);
      G.bindFB(fbf, FS, FS);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      pf.use().i('uLayer', f).f('uSeed', 1.23);
      G.drawFullscreen();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fbf);
    }
    this._dilateFoliage(fcol, FS, FL);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, fcol); gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, fnrm); gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    pf.destroy();
    this.foliage = { color: fcol, normal: fnrm, layers: FL };
    if (onProgress) onProgress(1, 'Foliage');
    await nextFrame();

    this._tryImageOverrides();
    return this;
  };

  /** Bleed leaf colours into transparent texels so mipmaps don't darken edges. */
  TexGen.prototype._dilateFoliage = function (tex, size, layers) {
    var G = this.G, gl = this.gl;
    var fs = [
      'in vec2 vUv; out vec4 o; uniform highp sampler2DArray uSrc; uniform int uLayer;',
      'void main(){ ivec2 p = ivec2(gl_FragCoord.xy); vec4 c = texelFetch(uSrc, ivec3(p, uLayer), 0);',
      '  if (c.a < 0.5) { vec3 acc = vec3(0.0); float n = 0.0;',
      '    for (int y = -3; y <= 3; y++) for (int x = -3; x <= 3; x++) { vec4 s = texelFetch(uSrc, ivec3(clamp(p + ivec2(x, y) * 2, ivec2(0), textureSize(uSrc, 0).xy - 1), uLayer), 0); if (s.a > 0.5) { acc += s.rgb; n += 1.0; } }',
      '    c.rgb = n > 0.0 ? acc / n : vec3(0.18, 0.26, 0.1); }',
      '  o = c; }'
    ].join('\n');
    var p = G.program('foliageDilate', S.fullscreenVS, fs);
    var tmp = G.textureArray(size, size, layers, {});
    for (var l = 0; l < layers; l++) {
      var fb = G.framebuffer([{ tex: tmp, layer: l }]);
      G.bindFB(fb, size, size);
      p.use().i('uLayer', l).tex('uSrc', 0, tex, gl.TEXTURE_2D_ARRAY);
      G.drawFullscreen();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fb);
    }
    // copy back
    for (l = 0; l < layers; l++) {
      var fbr = G.framebuffer([{ tex: tmp, layer: l }]);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbr);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
      gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, l, 0, 0, size, size);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.deleteFramebuffer(fbr);
    }
    gl.deleteTexture(tmp);
    p.destroy();
  };

  /**
   * Optional photographic overrides. Browsers block WebGL uploads of images loaded from file://,
   * so this only runs when the project is served over http(s). Missing files are silently skipped
   * and the procedural textures stay in place (see assets/textures/README.md).
   */
  TexGen.prototype._tryImageOverrides = function () {
    if (location.protocol === 'file:') return;
    var manifest = (TERRA.data.textureOverrides || []);
    var self = this, gl = this.gl;
    manifest.forEach(function (entry) {
      var img = new Image();
      img.onload = function () {
        try {
          var c = document.createElement('canvas'); c.width = c.height = self.materials.size;
          var ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, c.width, c.height);
          var data = ctx.getImageData(0, 0, c.width, c.height);
          // keep procedural height in alpha
          gl.bindTexture(gl.TEXTURE_2D_ARRAY, self.materials.albedoH);
          var px = data.data; for (var i = 3; i < px.length; i += 4) px[i] = 128;
          gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, entry.layer, c.width, c.height, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
          U.log('Loaded texture override', entry.file);
        } catch (e) { U.warn('Texture override failed, keeping procedural', entry.file); }
      };
      img.onerror = function () { /* graceful fallback: procedural texture remains */ };
      img.src = 'assets/textures/' + entry.file;
    });
  };

  TERRA.gfx.TexGen = TexGen;
})();
