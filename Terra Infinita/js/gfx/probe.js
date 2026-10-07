/* =============================================================================
 * TERRA INFINITA — dynamic reflection probe (part of the simulated RTX mode)
 * A low-resolution cubemap around the camera containing sky + terrain, updated
 * one face per frame. Used for off-screen reflections on water, puddles and
 * glossy surfaces when screen-space reflections miss.
 * ========================================================================== */
(function () {
  'use strict';
  var S = TERRA.shaders, M = TERRA.math;

  var SKY_FS = [
    '#include <frame>',
    '#include <common>',
    '#include <atmosphere>',
    '#include <cloudCommon>',
    '#include <skyColor>',
    'in vec2 vUv; out vec4 o; uniform mat4 uInvVP;',
    'void main(){',
    '  vec4 w = uInvVP * vec4(vUv * 2.0 - 1.0, 0.5, 1.0); vec3 d = normalize(w.xyz / w.w - uCamPos.xyz);',
    '  vec3 c = skyRadiance(d); c = flatClouds(d, c);',
    '  o = vec4(c, 1.0);',
    '}'
  ].join('\n');

  var TERRAIN_FS = [
    '#include <frame>',
    '#include <common>',
    '#include <atmosphere>',
    'in vec3 vWorld; in vec3 vNormal; in vec4 vClimate; in vec4 vSurface; in vec4 vExtra; in vec3 vLocal; in float vMorph;',
    'out vec4 o;',
    'void main(){',
    '  vec3 N = normalize(vNormal); float slope = 1.0 - N.y;',
    '  float T = vClimate.x * 80.0 - 40.0, Mo = vClimate.y;',
    '  vec3 grass = mix(vec3(0.45, 0.42, 0.25), vec3(0.16, 0.24, 0.07), smoothstep(0.2, 0.55, Mo));',
    '  vec3 c = mix(grass, vec3(0.1, 0.16, 0.08), vSurface.z);',
    '  c = mix(c, vec3(0.42, 0.4, 0.37), smoothstep(0.3, 0.55, slope));',
    '  c = mix(c, vec3(0.75, 0.68, 0.52), smoothstep(0.25, 0.1, Mo) * smoothstep(14.0, 20.0, T));',
    '  c = mix(c, vec3(0.9, 0.92, 0.95), smoothstep(-1.0, -4.0, T) * (1.0 - smoothstep(0.55, 0.8, slope)));',
    '  c = pow(c, vec3(2.2));',
    '  vec3 sky = texelFetch(uAmbientTex, ivec2(0, 0), 0).rgb / PI;',
    '  vec3 col = c * (uSunColor.rgb * max(dot(N, uSunDir.xyz), 0.0) / PI * 0.9 + sky * (0.6 + 0.4 * N.y) * uSkyAmb1.w);',
    '  float Tf = fogTransmittance(uCamPos.xyz, vWorld);',
    '  vec3 dir = normalize(vWorld - uCamPos.xyz);',
    '  col = col * Tf + fogInscatter(dir) * (1.0 - Tf);',
    '  o = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var FACES = [
    { f: [1, 0, 0], u: [0, -1, 0] }, { f: [-1, 0, 0], u: [0, -1, 0] },
    { f: [0, 1, 0], u: [0, 0, 1] }, { f: [0, -1, 0], u: [0, 0, -1] },
    { f: [0, 0, 1], u: [0, -1, 0] }, { f: [0, 0, -1], u: [0, -1, 0] }
  ];

  function Probe(R) {
    this.R = R; this.G = R.G; var gl = this.gl = R.G.gl;
    this.size = 128;
    this.ready = false;
    this.face = 0;
    this.pos = [0, 0, 0];
    this.progSky = this.G.program('probeSky', S.fullscreenVS, SKY_FS);
    this.progTer = this.G.program('probeTerrain', S.terrainVS, TERRAIN_FS);
    var hf = this.G.hdrFormat;
    var cube = this.cube = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, cube);
    gl.texStorage2D(gl.TEXTURE_CUBE_MAP, Math.log2(this.size) + 1, hf.internal, this.size, this.size);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, this.size, this.size);
    this.fbs = [];
    for (var i = 0; i < 6; i++) {
      var fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, cube, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
      this.fbs.push(fb);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.planes = new Float32Array(24);
  }

  Probe.prototype.update = function (frame) {
    var gl = this.gl, G = this.G, R = this.R, cm = frame.chunks;
    if (!cm) return;
    if (this.face === 0) this.pos = frame.cam.pos.slice();
    var fi = this.face, F = FACES[fi], p = this.pos;
    var view = M.lookAt(M.mat4(), p, [p[0] + F.f[0], p[1] + F.f[1], p[2] + F.f[2]], F.u);
    var proj = G.caps.reversedZ ? M.perspectiveReversedInf(M.mat4(), Math.PI / 2, 1, 0.5) : M.perspective(M.mat4(), Math.PI / 2, 1, 0.5, 30000);
    var vp = M.multiply(M.mat4(), proj, view);
    var inv = M.invert(M.mat4(), vp);
    G.bindFB(this.fbs[fi], this.size, this.size);
    if (G.caps.reversedZ) { gl.clearDepth(0); gl.depthFunc(gl.GEQUAL); } else { gl.clearDepth(1); gl.depthFunc(gl.LEQUAL); }
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    var ps = this.progSky.use();
    R.sky.bindAtmo(ps, 0); R.sky.bindCloudCommon(ps, 2, frame.env);
    ps.m4('uInvVP', inv);
    G.drawFullscreen();
    gl.enable(gl.DEPTH_TEST);
    var pt = this.progTer.use();
    R.sky.bindAtmo(pt, 0);
    pt.i('uShadowPass', 1).m4('uShadowVP', vp).v3('uLightCam', frame.cam.pos[0], frame.cam.pos[1], frame.cam.pos[2]);
    M.frustumFromMatrix(vp, this.planes, G.caps.reversedZ);
    var list = cm.drawList, origin = frame.origin;
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      var x0 = n.ox - origin[0], z0 = n.oz - origin[1];
      if (!M.aabbInFrustum(this.planes, x0, n.minH, z0, x0 + n.size, n.maxH, z0 + n.size, 6)) continue;
      var mr = cm.morphRange(n.level);
      pt.v3('uNodeOffset', x0, 0, z0).v4('uNodeInfo', n.size, n.level, n.edge || 0, cm.grid).v2('uMorphRange', mr[0], mr[1]);
      gl.bindVertexArray(n.vbo.vao);
      gl.drawElements(gl.TRIANGLES, cm.indexCount, gl.UNSIGNED_SHORT, 0);
    }
    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
    this.face = (this.face + 1) % 6;
    if (this.face === 0) {
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.cube);
      gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
      this.ready = true;
    }
  };

  TERRA.gfx.Probe = Probe;
})();
