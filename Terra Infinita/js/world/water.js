/* =============================================================================
 * TERRA INFINITA — water rendering (per-chunk water meshes)
 * ========================================================================== */
(function () {
  'use strict';
  var S = TERRA.shaders, M = TERRA.math;

  function Water(R) {
    this.R = R; this.G = R.G; this.gl = R.G.gl;
    this.prog = this.G.program('water', S.waterVS, S.waterFS);
    this.stats = { nodes: 0 };
  }
  Water.prototype.draw = function (frame) {
    var gl = this.gl, cm = frame.chunks, R = this.R;
    if (!cm) return;
    var list = cm.drawList, origin = frame.origin, planes = frame.cam.planes;
    var p = this.prog.use();
    R.sky.bindAtmo(p, 0);
    R.sky.bindCloudCommon(p, 2, frame.env);
    R.shadows.bind(p, 4);
    p.tex('uSceneTex', 5, R.targets.sceneCopy).tex('uDepth', 6, R.targets.depth).tex('uNoiseTex', 7, R.tex.noise)
     .tex('uProbe', 8, R.probe && R.probe.ready ? R.probe.cube : R.tex.blackCube, gl.TEXTURE_CUBE_MAP)
     .tex('uTrailTex', 9, R.trailTex || R.tex.black);
    var g = frame.settings;
    var useProbe = !!(R.probe && R.probe.ready && (g.rtx ? g.reflectionProbes : g.reflectionQuality >= 3));
    p.v4('uWaterQ', g.waterQuality, (g.reflectionQuality >= 1 || (g.rtx && g.rtxReflections)) ? 1 : 0, useProbe ? 1 : 0, 0);
    p.f('uWaveAmp', Water.waveAmp(frame.env));
    var ws = R.engine.watersim, simOn = !!(ws && ws.ok && ws.active !== false);
    p.tex('uSimTex', 10, simOn ? ws.texture() : R.tex.black);
    var sa = simOn ? ws.area : [0, 0, 1];
    p.v4('uSimArea', sa[0], sa[1], sa[2], simOn ? 1 : 0);
    if (R.ff) R.ff.bind(p, 11, frame); else p.tex('uFFTex', 11, R.tex.black).v4('uFF', 0, 0, 1, 0);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      var node = list[i];
      if (!node.water) continue;
      var x0 = node.ox - origin[0], z0 = node.oz - origin[1];
      if (!M.aabbInFrustum(planes, x0, node.waterMin - 3, z0, x0 + node.size, node.waterMax + 3, z0 + node.size, 6)) continue;
      var mr = cm.morphRange(node.level);
      p.v3('uNodeOffset', x0, 0, z0).v2('uMorphRange', mr[0], mr[1]).v4('uNodeInfo', node.size, node.level, 0, cm.grid);
      gl.bindVertexArray(node.water.vao);
      gl.drawElements(gl.TRIANGLES, node.water.count, node.water.type, 0);
      n++;
    }
    gl.bindVertexArray(null);
    this.G.stats.drawCalls += n;
    this.stats.nodes = n;
  };
  /* ---------------- CPU mirror of the wave spectrum (buoyancy, camera) ---------------- */
  function fract(x) { return x - Math.floor(x); }
  function hash11(p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
  Water.waveAmp = function (env) { return 0.25 + env.windStrength * 0.9 + env.storm * 0.6; };
  /** Surface elevation offset of the swell at render-space (x, z) — same waves as the vertex shader. */
  Water.waveHeight = function (x, z, t, type, env) {
    if (type !== 1 && type !== 2) return 0;
    var ws = env.windStrength, sm = Math.max(0, Math.min(1, (ws - 0.08) / 0.52)); sm = sm * sm * (3 - 2 * sm);
    var lake = type === 2, A = Water.waveAmp(env) * (lake ? 0.06 + 0.5 * sm : 1), w = env.windDir;
    var base = Math.atan2(w[1], w[0]), h = 0;
    for (var i = 0; i < 6; i++) {
      var wl = 64 * Math.pow(0.7, i) * (lake ? 0.3 : 1);
      var a0 = base + (hash11(i * 7.13 + 1) - 0.5) * (0.9 + i * 0.09);
      var amp = wl * 0.0105 * (0.45 + 0.55 * hash11(i * 3.1 + 2)) * (lake ? 0.6 : 1) * A;
      var k = 2 * Math.PI / wl, c = Math.sqrt(9.8 / k);
      h += amp * Math.sin(k * (Math.cos(a0) * x + Math.sin(a0) * z - c * t));
    }
    return h;
  };
  TERRA.world.Water = Water;
})();
