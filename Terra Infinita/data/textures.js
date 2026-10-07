/* =============================================================================
 * TERRA INFINITA — optional photographic texture overrides
 * -----------------------------------------------------------------------------
 * Every material is generated procedurally at startup, so no image files are
 * required. If you serve the project over http (see README) you may drop
 * appropriately licensed, seamless albedo textures (e.g. CC0 images from
 * Pixabay, ambientCG or Poly Haven) into assets/textures/ and list them here.
 * Browsers refuse WebGL uploads of file:// images, so overrides are skipped
 * automatically when the page is opened directly from disk.
 *   layer: material index from data/presets.js (0 grass … 15 cut stone)
 * ========================================================================== */
(function () {
  'use strict';
  TERRA.data.textureOverrides = [
    // { layer: 3, file: 'rock_albedo.jpg' },
    // { layer: 5, file: 'sand_albedo.jpg' }
  ];
})();
