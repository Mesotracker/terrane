# TERRA INFINITA — Procedural World Engine

An infinite, procedurally generated 3D landscape you can explore, sculpt and save —
running entirely in the browser with WebGL2. No server, no install, no downloads.

## Launching

**Double-click `index.html`.** It opens in your default browser and runs straight from the
file system (`file://`). Chrome, Edge, Firefox and Safari (recent versions, with hardware
acceleration enabled) are supported; Chrome/Edge give the best performance.

Everything the engine needs — shaders, materials, trees, rocks, sounds — is generated at
start-up from code, so the project works fully offline.

### Optional: serving over http

Nothing requires a server. The only feature that does is **photographic texture
overrides** (see `assets/textures/README.md`), because browsers refuse to upload `file://`
images into WebGL. To use them, serve the folder with any static server, for example:

```
python3 -m http.server 8080      # then open http://localhost:8080
```

## Controls

| Key | Action |
| --- | --- |
| **W A S D** / arrows | Move |
| **Mouse** | Look (click the view to capture the mouse) |
| **Shift** | Sprint (uses stamina) |
| **Space** | Jump · swim up · climb steep slopes (hold with **W**) |
| **C** / **Ctrl** | Crouch · swim down |
| **X** | Toggle walk / run |
| **V** | Cycle camera: first person → third person → free camera |
| **Tab** | World editor |
| **M** | World map (click to set a waypoint, "Travel to waypoint" teleports) |
| **K** | Weather, time & wind panel |
| **L** | Flashlight |
| **T** | Path tracing — photoreal mode on/off |
| **1 – 6** | Hands · axe · hoe · rake · stones · dynamite |
| **Mouse wheel** / **Alt+1–6** | Cycle the seven firearms (rifle, SMG, shotgun, marksman, LMG, pistol, rocket launcher) |
| **Left mouse** | Fire · with a tool selected: use it / charge a throw |
| **Right mouse** | Aim down sights (with a weapon) · cancel a throw (with a tool) |
| **R** | Reload (any weapon) |
| **G** | Frag grenade (weapons) · throw a test object (physics playground) |
| **Left mouse** | Use the tool · hold and release to throw (longer hold = harder throw) |
| **Right mouse** | Cancel a throw / set down what you are holding |
| **E** | Pick up / drop the object you are looking at (balls, crates, logs, stones …) |
| **N** | Vehicle menu — **1–7** spawns a skiff, speedboat, cabin cruiser, light aircraft, seaplane, mountain bike or dirt bike in front of you |
| **F** | Enter / leave the nearest vehicle |
| **B** | Change the test object: beach ball · mirror ball · wooden crate · barrel · rock |
| **H** | Hide / show the interface |
| **F3** or **`** | Debug overlay (stats, LOD, biome/height/moisture/temperature maps …) |
| **P** | Screenshot (PNG download) |
| **Esc** | Pause menu |

Free camera: **Space/E** up, **C/Q** down, mouse wheel changes speed, **Shift** ×4.

In a vehicle: **V** chase / cockpit camera, mouse looks around, wheel zooms the chase camera,
**R** resets (upright / repaired), **L** lights, **F** to get out.

| | Boats | Aircraft | Bikes |
| --- | --- | --- | --- |
| Throttle | **W** (Shift = full) / **S** astern | **Shift** up · **Ctrl** or **Z** down (stays set) | **W** pedal / throttle (Shift = sprint / full) |
| Steer | **A D** | **A D** roll · **W S** pitch · **Q E** rudder | **A D** |
| Brake | — | **Space** (wheel brakes) | **S** (hold at a standstill to roll back) |
| Other | | | **Space** hop · **W/S** in the air lean forward/back |

Editor: right-drag to look, **WASD** to fly, left-click/drag to apply the tool,
**1–0** select tools, **[ ]** brush size, **Ctrl+Z / Ctrl+Y** undo/redo.

## What's inside

**World generation** (`js/world/terrain-core.js`) — a deterministic, float64 generator
shared by the main thread and Web Workers:

* domain-warped continents, shelves, coasts, islands
* mountain ranges as broad uplifted massifs (valley floors inside a range sit high, as in
  real ranges) carved by a 6-octave **slope-aligned erosion filter**: dendritic gully
  networks that branch downhill, spurs and knife-edge crests between them, flat
  sediment-filled valley floors; ranges rise through 5–10 km of foothills; giant-peak
  landmarks; snow collects in gullies and hollows and is scoured from crests and steep faces
* derivative-damped ("eroded") fBm hills, rolling plains, micro relief, rock outcrops
* arid geology: mesas, sedimentary terraces, canyon systems, sand dunes
* volcanoes with craters and lava lakes
* meandering rivers and streams that share one water-level field so confluences match,
  carved valleys, rapids and waterfalls where the land steps down, river mouths
* lakes and ponds that only form in natural depressions (rim-checked), wetlands, trails
* climate (temperature with altitude lapse rate, moisture, aridity) → 19 biomes with
  smooth transitions
* points of interest: ruins, campsites, villages, watchtowers, standing stones, natural
  arches, caves, monoliths, shrines — with collectible relics

**Streaming & LOD** (`js/world/chunk-manager.js`) — an infinite grid of 16 km quadtree
roots refined around the camera (CDLOD). Vertices geomorph toward the next coarser grid
with distance, edges bordering coarser neighbours are stitched and skirts hide any
sub-pixel cracks, so LOD changes never pop. Chunk generation runs in a pool of Web
Workers built from Blob URLs (which is why the project works from `file://`). All chunks
share one index buffer and pooled vertex buffers. A floating render origin (multiples of
8192 m) keeps float32 precision anywhere in the world.

**Rendering** (`js/gfx/*`, `shaders/*`) — a deferred WebGL2 pipeline:

* procedural PBR materials generated on the GPU (albedo, height, normal, roughness, AO
  for 16 materials), height-blended splatting driven by slope, altitude, temperature,
  moisture, curvature, water proximity and forest cover; triplanar rock, anti-tiling,
  close-range micro-detail, **parallax occlusion mapping** (real relief depth on rock,
  gravel, cracks and pebbles up close), sedimentary strata, far forest canopy shading
* PBR lighting: GGX + Burley diffuse with **multiple-scattering energy compensation**,
  directional sky irradiance sampled from the atmosphere, AO micro-shadowing, specular
  occlusion and specular anti-aliasing
* physically based atmosphere (Rayleigh/Mie/ozone single scattering + multiple-scattering
  approximation) → sky, sun & moon light colour, ambient light, aerial perspective
* volumetric ray-marched clouds with cloud shadows, flat cloud fallback, stars, Milky Way,
  moon phases, aurora in cold regions, rainbows after rain
* cascaded shadow maps (up to 4 × 4096²) with PCF soft shadows
* **distant terrain light** (`js/gfx/farfield.js`): a 12 km height/albedo field around the
  camera gives mountain shadows far beyond the shadow cascades (with a physically sized
  penumbra from the sun disc), the same shadows on lakes and in the light shafts, and
  large-scale sky occlusion that darkens deep valleys and gorges
* **path tracing** (`js/gfx/pathtracer.js`, `shaders/pt.glsl.js`): per pixel, 1, 2, 4,
  **8 or 16** stratified cosine-weighted diffuse rays and a GGX importance-sampled glossy
  ray are marched through the depth buffer, then through the 1 m terrain height field, then
  as world-space rays through the 12 km terrain field, whose hits are shaded with albedo,
  sun, mountain shadows and sky (real bounce light from sunlit slopes into shaded valleys);
  misses gather sky light, on-screen hits gather the previous lit frame so bounces
  accumulate (multi-bounce GI, colour bleeding, emissive light). Temporal accumulation with
  disocclusion rejection + à-trous denoising. Replaces SSAO/SSR/ambient light when enabled
* SSAO, screen-space reflections, contact shadows, one-bounce screen-space GI, dynamic
  reflection probe — combined in the **Simulated RTX** mode
* volumetric light shafts, height fog, weather fog, bloom, auto-exposure, ACES filmic or
  **AgX** (natural, camera-like) tone mapping, colour grading, depth of field, camera motion blur, **temporal anti-aliasing**
  (or FXAA), dynamic resolution and an automatic quality governor
* water: a wind-driven **wave spectrum** (16 Gerstner waves, analytic per-pixel normals;
  lakes go glassy and mirror the shore in calm air),
  whitecaps where crests fold, **subsurface scattering** through wave crests, chromatic
  refraction with depth absorption, SSR + probe reflections, shoreline foam, flow-mapped
  rivers, waterfalls/rapids foam, underwater fog and caustics, glowing lava
* **water physics** (`js/world/watersim.js`): a wave-equation ripple simulation around the
  camera — rain drops, wading, swimming strokes and splashes make ripples that spread,
  interfere and fade; swimmers bob on the swell; river currents push you downstream
* vegetation: 10 procedural tree species grown as branch hierarchies (trunk → limbs →
  branches → twigs) inside a crown envelope (spruces with the Norway-spruce habit: sagging
  branches whose tips sweep up, hanging curtain branchlets, dead stubs on the bare trunk), clothed in **leaf sprigs anchored on twigs**
  (sprig textures with stems, petioles and veined leaves; spruce branchlets, bipinnate
  acacia, radiating pine tufts), instanced with dithered mesh↔impostor cross-fades and baked
  impostors to ~1.8 km; props (bushes, ferns, logs, rocks, mushrooms, reeds, cacti, flowers),
  seasonal colours and snow on foliage
* **grass**: GPU-generated clumps of curved, twisted Bézier blades with pointed tips and a
  rounded cross-section; broad, fine, seed-head and dead blades; tall-grass meadow patches
  and **wildflower drifts** (nodding bluebells, buttercups, ox-eye daisies, campion,
  poppies); up to hundreds of thousands of clumps in three LOD rings; the ground beneath dense grass is shaded as
  thatch so no bare terrain shows through
* **wind physics** (`js/env/windsim.js`): travelling gust fronts roll across the land; a
  GPU spring–damper field makes grass lean, overshoot and spring back, and part around
  the player; trees respond to the same gusts with inertia and their own sway frequency

**Weather & environment** (`js/env/*`) — clear → partly cloudy → overcast → rain → storm →
thunderstorm, fog, dense fog, snow, blizzard, windy, sandstorm; gradual transitions and a
biome-aware automatic cycle. Rain wets the ground over time, darkens materials, forms
puddles in depressions and on trails (with animated rain ripples and reflections), and
dries afterwards. Snow accumulates when it is cold and melts into slush. Lightning with
distance-delayed thunder. Day/night cycle with real solar geometry, seasons and latitude.

**Gameplay** — first-person controller with acceleration, surface-dependent speed (sand,
snow, mud, shallow water), slope handling, jumping, crouching, sprinting with stamina,
swimming, climbing; head bob, landing dips, sprint FOV; third-person and free cameras;
footprints in sand/snow/mud, grass flattening and water wakes via a trail map.

**Editor** — raise, lower, smooth, flatten, add mountain, add valley, paint materials,
paint/remove vegetation, add rocks, add/remove water, change biome, spawn/delete objects;
brush size, strength, falloff, hardness, noise, smoothing; full undo/redo.

**Saving** — worlds (seed, parameters, player, time, weather, editor changes, discoveries)
are stored in IndexedDB (localStorage fallback), can be exported/imported as JSON, and
world-generation configurations can be exported on their own.

**Audio** — fully synthesised with the Web Audio API: wind and gusts, rain intensity,
thunder, rivers, ocean surf, forest rustle, birds, crickets, frogs, volcanic rumble,
underwater muffling and surface-specific footsteps.

## Vehicles

Spawn with **N** then **1–7** (boats and the seaplane need open water within 200 m of where
you are looking). Walk up to a vehicle and press **F**.

* **Boats** float on the real swell: buoyancy is integrated over a grid of hull columns
  against the same waves the water shader draws, so they heave, pitch and roll in waves and
  drift with river currents. Resistance follows the Froude number — the bow climbs over the
  "hump" while accelerating, then the hull planes and levels out; planing hulls bank into
  turns, the heavy cruiser heels outward. The outboard swings to steer, ventilates when the
  propeller leaves the water, strikes bottom in the shallows, and boats run aground on
  beaches. Wakes, bow spray, prop wash and wave slams feed the ripple simulation, the foam
  trail and the particle system.
* **Aircraft** use a 6-degree-of-freedom flight model with light-aircraft coefficients: lift
  with stall and post-stall, induced and parasitic drag, sideslip, pitch/roll/yaw damping,
  weathervane stability, dihedral effect and adverse yaw, propeller thrust that falls with
  airspeed, thinner air with altitude, wind and gust turbulence, ground effect, sprung
  tricycle gear with tyre friction, nose-wheel steering and brakes. The seaplane floats on
  its pontoons and runs up "on the step" before lifting off. Contrails form in cold air at
  altitude, wingtip vortices under hard manoeuvres in moist air; prop wash raises dust or
  spray, touchdowns puff tyre smoke. Crashes are possible (**R** repairs).
* **Bikes** (pedal mountain bike and 250 cc dirt bike): bicycle-model steering, the rider
  leans with the centripetal acceleration, tyre grip depends on the ground — dry grass,
  rock, wet rock, mud, sand, snow, ice and puddles all behave differently (wheelspin, slides,
  long braking distances) — gravity on slopes, rolling resistance, a sprung suspension that
  soaks up bumps, jumps with mid-air lean control, hard landings and crashes, tyre ruts in
  soft ground, dust, mud spray, splashing through water and mud building up on the frame.

All vehicles have full-detail and reduced meshes (LOD), cast shadows, carry PBR materials
(paint with clear coat, chrome, glass, rubber, lamps), get wet in rain and spray, write
motion vectors for frame extrapolation, and sleep when parked or far away.

## Combat — the shooter layer

The explorer grew a battlefield. Nothing about the world changed: the same infinite terrain,
the same weather, the same 8 km-precision floating origin, no downloads — all combat geometry
and every soldier is generated procedurally from the world seed. Turn it off with
**Settings → Graphics → Combat detail → Off** (or set `combatDetail` in `data/presets.js`) and
you get exactly the peaceful world back; frames keep rendering while it streams.

**Weapons.** Seven firearms, each with its own recoil signature, spread model, magazine, reserve
and reload timing: AK-pattern rifle, compact SMG, pump shotgun (buckshot pellets), bolt-action
marksman rifle, belt-fed LMG, service pistol and a shoulder-fired rocket launcher that fires a
power-4 explosive. Bullets are traced through a material-aware penetration model: a rifle round
punches through planks and glass, is stopped by brick and concrete, and loses energy with every
surface it crosses, so shooting through a wall is possible but weak. Impacts spawn the right
debris per material (brick dust + chips, wood splinters, glass shards, metal sparks, sand
plumes), a matching sound, a bullet hole decal on the surface and a tracer that is drawn after
TAA so it stays crisp. Recoil kicks the view model and walks the aim up; shells eject; the
muzzle flash lights up the street for a frame.

**Soldiers.** Squads live in settlements — garrisons inside houses, patrols on the streets and
in the ruins — and are streamed with the same deterministic cell grid the buildings use. They
are skinned characters (19 bones, procedural walk/run/crouch/prone/aim/reload/fire/death
animation, two-bone IK so the hands actually hold the weapon), textured by the same material
library as the world, and driven by a state machine with line-of-sight, cover seeking
(`buildings.coverNear`), suppression, burst fire, reloads, wound states, blood decals and a
life count that scales with **Combat detail**.

**Vehicles.** Tanks, 8×8 APCs and machine-gun technicals garrison the hostile settlements. They
patrol, react to gunfire, hunt you with a traverse-limited turret, use lead for moving targets,
launch smoke screens when badly hurt and can be disabled part by part: shoot the tracks off and
they are immobilised, hit the engine or fuel and they burn out into a wreck with a popping
turret, boiling smoke and secondary explosions. The tank's 120 mm gun fires a real shell that
craters the ground and shakes the camera through the effects system.

**Damage and destruction.** Buildings are hit-zone aware (walls, roofs, floors, timber, brick,
glass, sandbags) with material armour values, progressive damage that rebuilds the mesh with
holes and missing parts, structural collapse that drops floors and roofs when supports die,
fires that spread and burn, scorch marks and bullet-hole decals. Explosions (grenades, rockets,
tank shells, dynamite, airstrike-scale blasts) apply radial damage with line-of-sight cover,
throw debris, fell trees, crater the terrain through the height-field edits and chain-detonate
other explosives.

**How the pieces fit.** `shaders/combat.glsl.js` holds the object, soldier, decal and tracer
shaders (one shared 26-material library with normal-mapped brick, planks, plaster, concrete,
glass, cloth camo, kevlar and skin); `js/game/combat-core.js` is the ray caster, damage router,
impact/explosion/decals/tracers engine; `js/world/buildings.js` generates and destroys the
settlements; `js/game/characters.js` + `js/game/soldiers.js` build and drive the enemies;
`js/game/gvehicles.js` the ground vehicles; `js/game/weapons.js` the player's guns;
`js/game/warmode.js` your health, armour plates, bleeding, regeneration and respawn.

## Tools, felling and throwing

* **Axe** — trees take more blows the thicker they are; chips fly, the tree creaks, then
  topples away from you (a rigid rod falling under gravity), crashes down in a burst of
  leaves and dust and leaves a stump with growth rings. Chop the fallen trunk to buck it
  into logs: real rigid bodies that roll down slopes, float, can be picked up (if light
  enough) and thrown. Axes blunt on rock and metal (sparks) and resharpen after a while.
* **Hoe** — tills the ground into dirt (mud when wet), removes the grass there and leaves a
  furrow. This is a persistent world edit, saved with the world.
* **Rake** — drags tine grooves through soil, sand and snow, flattens grass, smooths small
  bumps and gathers leaf litter.
* **Throwing** — stones and dynamite from the tool bar, or anything picked up with **E**:
  throw speed depends on the object's mass, with spin, gravity, drag, bouncing and rolling.
  A dotted arc previews the throw while you charge (Settings → Controls to turn it off).
* **Dynamite** — the fuse is lit when you start the throw (4 s, sparks and hiss — don't hold
  it too long). The blast throws up a fireball, smoke and debris (or a water column), lights
  the area, shakes the camera, cracks a scorched crater into the terrain (persistent,
  chunk-aware edit), clears grass, blows over nearby trees, splits fallen trunks into logs,
  flings objects, vehicles and you, and sets off other dynamite nearby.

## Climate and biomes

Temperature comes from latitude-like climate bands (a full cold–warm cycle every ~160 km
north–south), regional noise, the seasons and a 6.5 °C/km altitude lapse rate; moisture from
continental distance, water proximity and **rain shadows** — prevailing westerlies drop rain
on the windward side of mountain ranges and leave the lee dry. 26 biomes blend smoothly:
oceans, beaches, deserts, rocky and cold deserts, badlands, savanna, shrubland, steppe,
grassland, Mediterranean scrub, temperate, coastal, boreal and tropical forests, temperate
rainforest, wetlands and tropical swamps, tundra, alpine meadows, mountains, snowfields,
glaciers and volcanic regions.

Forests contain fallen logs with sawn or splintered ends and growth rings, branch stubs and
moss, stumps with root flares, snapped tops and bracket fungi; tree trunks carry knots, broken
limbs, lichen and moss on the damp lower bark.

## Weather and the ground

Rain falls as near streaks plus distant curtains (scaled by *Weather quality*), splashes on
the ground, ripples water, drips from tree canopies, drums on vehicles, makes surfaces wet and
glossy and fills puddles in hollows and on flat ground, which dry again in sun and wind.
Puddles, mud, wet rock, snow, sand and ice change how you move: grip sets acceleration,
braking and how much you slide, soft ground slows you and cushions landings, steep slippery
slopes make you slide, high ledges block you (jump or climb), and footsteps splash, squelch
or crunch accordingly.

## Performance & frame extrapolation

* **Settings → Graphics** has presets (Low · Medium · High · Very High · Ultra · Cinematic;
  changing any option marks it *Custom*) and individual controls for render distance, LOD
  distance, terrain/vegetation/texture/shadow/water/weather/particle/physics quality,
  anti-aliasing, ambient occlusion, volumetrics and more.
* Streaming prioritises chunks in front of you and in your direction of travel; terrain and
  vegetation generate in Web Workers; distant terrain uses coarse geomorphing LODs; trees cross-
  fade between full meshes, reduced meshes and impostors; hidden trees are culled against the
  previous frame's depth pyramid (Hi-Z occlusion); far shadow cascades are cached; detail
  distances adapt smoothly to the frame rate (*Adaptive LOD*).
* **Frame extrapolation** (Off, 1.5×, 2×, 3×, 4×) presents generated frames between real
  ones by re-projecting the last frame with its depth, the camera motion and the motion
  vectors of moving objects (vehicles, thrown objects); hidden areas are filled from the
  background side to avoid ghosting; the interface is never warped. The FPS counter shows the
  displayed rate and the native (really rendered) rate separately.
* The FPS panel (Settings → Interface → *Performance statistics*) shows frame time, CPU/GPU
  time, resolution and LOD scale, chunks, memory, draw calls, triangles and vehicle physics.

## Project structure

```
index.html            entry point (classic scripts — works from file://)
css/main.css          interface styles
data/                 settings, graphics presets, weather table, texture override list
shaders/              GLSL (as JS strings): terrain, sky, clouds, water, vegetation,
                      particles, post-processing, texture generation
js/core/              namespace/utilities/event bus, math
js/gfx/               WebGL2 layer, renderer, texture generation, sky, shadows,
                      terrain renderer, post-processing, reflection probe
js/world/             terrain generator, worker pool, chunk streaming/LOD, editor layer,
                      procedural models, vegetation, water, water physics simulation
js/env/               time of day, weather/wind/surface state, environment, particles
js/game/              input, player, interaction (trail map), audio, editor, map,
                      save system, performance, surfaces (ground physics), effects
                      (pooled particles), throwables, vehicles + vehicle models, tools
js/ui/                menus, HUD, panels
assets/               optional texture/model/audio overrides (not required)
docs/                 architecture notes
```

## Path tracing — photoreal mode

Press **T** (or Settings → Graphics → *Path tracing — photoreal mode*) to switch on the
most realistic lighting in one go:

* path-traced global illumination: every pixel traces diffuse light paths (sky light,
  occlusion, coloured bounce light from terrain, trees and fires, accumulating over frames
  into multi-bounce lighting) and glossy reflection paths, then denoises them
* ray-traced soft sun shadows with contact hardening (screen-space + terrain height field)
* ultra shadows, high volumetric clouds and light shafts, full PBR with parallax relief,
  reflection probe, temporal anti-aliasing and subtle filmic grading

Press **T** again to return to exactly the settings you had before. The individual parts
can also be set separately under Settings → Effects (*Path-traced lighting*: Balanced 1,
High 2, Ultra 4, **Extreme 8** or **Reference 16 rays per pixel**; *Ray-traced soft sun
shadows*; *Distant mountain shadows & valley sky occlusion*; *Tone mapping*). The Cinematic
preset uses 8 rays per pixel. It is demanding: on laptops keep dynamic
resolution on; if the frame rate stays low the path tracer steps down to Balanced first.

## Physics playground

Throw simple objects (**G**, change type with **B**) to test the water physics and the
reflections. Every object is a rigid body simulated at 120 Hz: buoyancy is computed per
sub-volume against the real wavy water surface, so objects float at the depth their density
dictates (beach ball barely wet, crate half submerged, the rock sinks), bob and tilt on the
swell, right themselves, drift downstream in rivers and come to rest on the bottom or shore.
Hitting the water splashes; moving through it leaves wakes in the ripple simulation. They
bounce and roll on terrain with friction, knock into each other and can be pushed by walking
into them. The **mirror ball** is a perfect chrome sphere for judging reflections (sky,
reflection probe, screen-space and path-traced reflections all show on it), and every object
is mirrored in the water.

## Performance tips

* Start with the **High** preset; use **Medium/Low** or **Performance mode** on laptops.
* **Dynamic resolution** keeps the frame rate near the target automatically.
* The **Cinematic** preset (1.25× supersampling, depth of field, motion blur, simulated RTX)
  is meant for screenshots on fast GPUs.
* The debug overlay (**F3**) shows frame time, draw calls, triangles, chunks, workers and
  memory.

## Fallbacks

* No Web Workers → generation runs on the main thread in small time slices.
* No float render targets → LDR pipeline.
* No `EXT_clip_control` → conventional depth buffer.
* Missing optional assets → procedural materials/models are always used.
* Per-frame errors are caught and logged so one failure never stops the world.
