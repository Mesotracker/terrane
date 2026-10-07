# Optional texture overrides

Every terrain material is generated procedurally at start-up, so this folder can stay empty.

If you serve the project over http (browsers block WebGL uploads of `file://` images), you can
replace the albedo of any material layer with a seamless, appropriately licensed photograph —
e.g. CC0 textures from Pixabay, ambientCG or Poly Haven. Only use images whose licence allows it.

1. Put the image here, e.g. `assets/textures/rock_albedo.jpg` (square, tileable).
2. List it in `data/textures.js`:  `{ layer: 3, file: 'rock_albedo.jpg' }`
   Layer numbers are listed in `data/presets.js` (`TERRA.data.materials`).
3. Serve the folder (`python3 -m http.server`) and open `http://localhost:8000`.

If a file is missing or fails to load, the procedural material stays in place.
