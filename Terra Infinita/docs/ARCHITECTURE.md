# Architecture notes

## Frame
`js/main.js` → `Engine._frame()`:
input → player (or the driven vehicle) / editor → vehicles, tools, throwables, effects
(fixed-step physics with interpolation) → camera + floating origin → (frame extrapolation:
either present a generated frame and stop here, or continue) → environment (time, weather,
wind, surface) → chunk streaming (quadtree select, uploads, eviction) → vegetation lists →
audio → map → `Renderer.render()` → UI.

## Frame extrapolation (`js/gfx/framegen.js`)
Real frames store their depth, colour and a motion buffer (world velocity of vehicles and
thrown bodies; flag 2 = screen-locked view models). Generated frames are full-screen passes:
for each output pixel the source pixel is found by fixed-point iteration of the forward
map (unproject with the old view-projection, add the object's velocity × elapsed time,
project with the new camera); pixels that fail to converge are disocclusions and take the
farthest-depth neighbour along the motion direction (background side), softened by the
artifact-reduction setting. Scheduling uses a phase accumulator so 1.5× alternates.

## Occlusion & LOD (`js/gfx/hiz.js`, `vegetation.js`, `chunk-manager.js`)
The G-buffer depth is reduced into a max-depth (farthest) pyramid each frame; vertex
shaders of trees and impostors test their bounding sphere against the previous frame's
pyramid and collapse hidden instances before any shading. `engine.lodScale` (0.5–1.3) is
driven by the performance governor and scales chunk split distances, tree mesh/LOD/impostor
distances and the grass ring smoothly. Chunk requests are prioritised by distance, view
direction and a velocity look-ahead.

## Vehicles (`js/game/vehicles.js`, `vehicle-models.js`)
Each vehicle is a rigid body (float64 position, quaternion, angular velocity, diagonal
inertia with the gyroscopic term) stepped at the physics-quality rate (60–160 Hz) with
render interpolation. Boats: buoyancy columns against `Water.waveHeight`, Froude-based
resistance with hump, distributed keel resistance (yaw/sideslip), steered thrust vector,
lower-unit lift, hydrodynamic centre-of-lift shifts for trim and banking, horizon-frame
rotational damping, terrain contacts for shallows and beaching. Aircraft: stability-
derivative flight model (CL(α) with stall, CD = CD0 + kCL², CY(β), Cm, Cl, Cn with damping
terms), density lapse, wind/turbulence, ground effect, spring–damper gear with friction,
float buoyancy with planing-step pressure. Bikes: kinematic bicycle model with grip-limited
lateral velocity, centripetal lean, sprung body over terrain-following wheels, ballistic
flight, ledge/tree collisions. Meshes are lofted/extruded procedurally with per-vertex
material ids (two LODs), moving parts posed per frame, drawn with one PBR program (plus
shadow and motion variants).

## Combat (`js/game/combat-core.js`, `buildings.js`, `characters.js`, `soldiers.js`, `gvehicles.js`, `weapons.js`, `warmode.js`)

`TERRA.game.Combat` is the referee and the only module that owns ray casting. Ray providers
(buildings, ground vehicles, soldiers, the player capsule) each expose `raycast(o, d, maxT,
filter)`; `Combat.cast` also marches the analytic terrain, keeps the nearest hit and returns it
with `{t, type, ref, part, surface, n, p}`. `applyDamage` routes that hit to the right owner,
`impact` picks the debris/decal/sound from a 26-material table, `explode(pos, power, opts)`
does radial damage with cover tests, throws debris, fells trees, craters the height field,
knocks over props and detonates other explosives.

* **Materials** — `CMAT`/`ARMOR` in `combat-core.js` mirror `TERRA.shaders.lib.cmbmat`; each id
  has armour cost (how much penetration it eats), an albedo/normal layer in the 2D texture
  arrays and a procedural surface pattern (brick coursing, plank gaps, plaster, concrete form
  boards, weave, camo) evaluated in the fragment shader.
* **Buildings** — deterministic sites on a 2600 m cell grid, planned lazily, meshed per
  settlement (full + far LOD) and rebuilt when parts are destroyed so holes and missing floors
  are real geometry. Also provides `floorHeight`/`resolveCircle` so the player, soldiers and
  vehicles walk on the right surface, and `coverNear` for the AI.
* **Soldiers** — one shared skinned mesh per class, bone matrices uploaded to a `RGBA32F`
  texture each frame, all instances drawn in a single instanced call per class; AI runs at 4 Hz
  past 110 m and is culled beyond 320 m.
* **Ground vehicles** — one template mesh per family, per-vehicle meshes rebuilt on damage,
  turret traverse/elevation limits, LOS-gated fire, part-specific kills (tracks, wheels,
  engine, fuel, gun, turret ring).
* **Frame integration** — `_drawExtras` (G-buffer and shadow cascades) draws buildings,
  vehicles, soldiers, the view model and effect debris; decals are stamped into the G-buffer
  right after it; tracers are drawn additively after TAA; the HUD reads `weapons.hud` and
  `warmode.hud` in `ui._updateCombat`.

## Tools (`js/game/tools.js`)
View models are posed in camera space from keyframed animations and drawn into the
G-buffer with the vehicle program. Hits are resolved by ray casts against trunk cylinders,
felled-trunk capsules, stumps, rigid bodies, vehicles and a terrain march. Felled trees are
removed from the vegetation set (`edits.vegRemove`, spatially hashed) and redrawn by the
vegetation renderer with a per-instance tilt (`iData.w`: direction + angle, cut at the
stump). Tilling, raking and craters are edits (`edits.applyPaint / applyHeight`) committed
to chunks and the vegetation field in batches. Dynamite is a throwable with a fuse; its
explosion edits terrain, fells trees, applies impulses and chain-detonates.

## Ground surfaces (`js/game/surfaces.js`)
One table of friction, rolling resistance, speed/acceleration factors, softness and dust
colour per surface (grass, leaves, path, rock, sand, snow, mud, ice, puddle, water),
modified by weather (wetness, freezing), shared by the player, bikes, aircraft wheels and
tools; puddles are estimated from local concavity and the puddle level.

## Renderer passes (`js/gfx/renderer.js`)
1. Sky-view LUT (192×108) and 4×1 ambient texture (irradiance, sun transmittance, fog colour)
2. Cascaded shadow maps (terrain; far cascades use coarser ancestors; trees/impostors/grass)
2b. Far-field terrain light (`js/gfx/farfield.js`): 512² × 24 m height + albedo field
   rasterised top-down from the loaded chunks (coarser index buffers for fine nodes), then
   a sun pass storing the *shadow-top height* (max over the sun ray of h(t) − t·tanθ) and
   occluder distance, and a 12-direction horizon pass storing sky visibility. Heights
   refresh on recentre (~1.5 km) or terrain changes (≤ ~1/s), the sun pass when the light
   moves. Lighting, water, light shafts and the path tracer sample it
3. Trail map update (footprints, flattened grass, wakes), water ripple simulation
   (`js/world/watersim.js`, wave equation, fixed 60 Hz steps), vegetation wind physics
   (`js/env/windsim.js`, spring–damper field driven by travelling gusts) and the
   reflection probe (1 face/frame)
4. G-buffer: RGBA8 albedo+AO, RGBA16F normal+roughness, RGBA8 material, 32-bit depth
   (reversed-Z infinite projection when `EXT_clip_control` exists)
5. Path tracing when enabled (`js/gfx/pathtracer.js`): half-res trace of 1–16 stratified
   diffuse + 1 GGX glossy ray per pixel through the depth buffer, the 1 m terrain height
   field and the far field (world-space, shaded hits) → temporal accumulation → à-trous
   denoise. Otherwise: volumetric clouds (reduced resolution),
   SSAO + one-bounce GI (half res, bilateral blur)
6. Deferred lighting: GGX/Burley, CSM PCF, contact shadows, cloud shadows, sky ambient,
   SSR with previous-frame reprojection, probe/sky reflections, point lights, flashlight,
   caustics, height fog / aerial perspective, sky/stars/moon/aurora/rainbow for sky pixels
7. Scene copy → forward water (wave spectrum, SSS, refraction, SSR, foam, lava) → TAA
   resolve (jittered projection, history reprojection, variance clipping) → particles (rain, snow, dust,
   splashes, fireflies, leaves, embers, motes), lightning bolts, birds
8. Volumetric light shafts (half res) → bloom (13-tap down / tent up) → auto exposure
   (log-luminance mip chain + temporal adaptation) → DOF → composite (motion blur, grading,
   vignette, grain, underwater) → FXAA to the canvas

## Mountains (`terrain-core.js`, `stageBase`)
Range masks use a gentler domain warp and smooth continentalness so the uplift ramps over
5–10 km (mountain height scales with the mask). The massif is a 4-octave fBm (15 km) with
a soft summit clamp; its analytic gradient (through the warp Jacobian) orients a 6-octave
erosion filter (`erosionFilter`: per-cell plane waves along the slope, compact kernel,
gain 0.38, branch coupling) that carves dendritic gullies; carving fades out on valley
floors. Skipped LOD octaves add their expected carve so LODs agree. The gully indicator is
stored per vertex and drives snow (couloirs), gravel and the far-field albedo.

## Determinism
`TerrainCoreFactory` is pure: the same seed and parameters always produce the same world on
every thread. Large features (lakes, volcanoes, peaks, POIs) are evaluated per grid cell and
cached. Grids (chunks, vegetation cells, map tiles) interpolate macro fields (≥4 km
wavelengths) from a coarse lattice for speed.

## Editing
`js/world/edits.js` stores sparse 64 m tiles (1 m resolution) of height deltas, material
paint, biome overrides and water overrides, plus vegetation removals/additions and spawned
objects. Chunks re-apply the layer when loaded or edited; everything is undoable per stroke
and serialises to base64 inside the world JSON.
