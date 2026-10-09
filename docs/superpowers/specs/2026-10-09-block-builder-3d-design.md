# Block Builder phase 2 — first-person 3D "Explore" view — design + contract

Status: approved in conversation 2026-10-09 (user: "I need same like Minecraft, not simple"). Extends `2026-10-09-block-builder-design.md` (phase 1: data model, validator, isometric Build/Play, all merged in the working tree, 790 tests green).
Never use the word "Minecraft", Mojang names, textures, mobs or skins anywhere (code, UI, prompts, tests). We make our OWN blocks, textures and animals. Style target: chunky cartoon voxel world with pixel-art textures, sky, clouds, fog, day/night, trees, hills, water, friendly animals, first-person walking and building.

## Product
Block Builder gets a third mode button next to Play / Build: **Explore 3D**. It opens a first-person view of a much bigger world (48x48 columns, 24 high) that is generated around the kid's 12x12 "building plot". The plot is the AI/kid-designed `build` (phase 1 data). Everything the kid builds or removes **inside the plot** is saved (via the existing `onChange(toSpec)` path). Edits outside the plot work for fun but are session-only (reset on reload) — say so in a gentle line of UI text.

## Spec additions (server + client validators, both)
`world.terrain`: enum `meadow | desert | snow | island | candy` (default meadow when absent on blocks specs; for non-blocks templates the field is dropped).
`world.seed`: int clamped 0..999999 (default 1).
No other spec changes. `build` unchanged. MAX_JSON_CHARS unchanged. These two fields are optional for model output (defaulted), never required.

## Pure module `AIXVoxel` — `ui/vg-aix-voxel.js` (UMD; no DOM, no three.js, no network/storage; deterministic; never throws)
```
AIXVoxel.WX = 48; WY = 48 (depth, y axis); WZ = 24 (height); PLOT = {x0:18, y0:18, size:12, base:8}   // plot occupies x 18..29, y 18..29; build layer k sits at z = base + k
AIXVoxel.BLOCKS   // id -> {char, name, solid, see, top/side/bottom tile indexes}; ids 0 = air; reuse AIXBlocks.ALPHABET chars for plot blocks and add terrain-only blocks: 'snow','cactus','trunk','flowerRed','flowerYellow','tallGrass','cobble' (cartoon only)
AIXVoxel.generate(spec) -> world   // deterministic from spec.world.seed + terrain + spec.build. Layered value noise heightmap (hills 4..14), water below sea level 6, beaches/sand, trees (trunk+leaves, seeded), flowers, terrain-specific surface (desert sand+cactus, snow caps, island = water ring, candy = pink/white). The plot is levelled to z=base-1 (grass or terrain-matching surface) and the build copied in. world = { v:1, data:Uint8Array(WX*WY*WZ), seed, terrain, plotDirty:false }
AIXVoxel.get(world,x,y,z) -> id (0 out of range, never throws); AIXVoxel.set(world,x,y,z,id) -> {ok,reason?}  (bounds-checked; marks plotDirty when inside plot)
AIXVoxel.plotToBuild(world) -> {layers:string[][]} valid per AIXBlocks.validateBuild or null   // so Save works; the engine's validateBuild decides
AIXVoxel.spawn(world) -> {x,y,z}   // standing position next to the plot on dry land
AIXVoxel.physics(player, input, world, dtMs) -> player   // pure; player={x,y,z,vx,vy,vz,yaw,pitch,onGround,inWater}; input={mx,mz (-1..1 strafe/forward), jump, yawDelta, pitchDelta, sprint?}; AABB 0.6x1.8 collision, gravity, jump ~1.25 blocks, step-up none, swim in water (slow, buoyant), clamps pitch +-89deg, world edge is a soft wall; dt clamped to 50ms
AIXVoxel.raycast(world, origin, dir, maxDist=6) -> {x,y,z,face:{nx,ny,nz}, id} | null     // voxel DDA
AIXVoxel.place(world, player, hit, id) / AIXVoxel.breakBlock(world, hit) -> {ok,reason?}    // cannot place inside the player, cannot break bedrock row z=0, within reach
AIXVoxel.critters(world, seed) -> animals[]; AIXVoxel.stepCritters(animals, world, dtMs) -> animals   // 6..10 friendly animals of our own design: 'llama','goat','piglet','duckling' (kinds only; the renderer draws boxy models). Wander, idle, never attack, never leave land, avoid water.
AIXVoxel.gems(world, spec, seed) -> [{x,y,z}]   // goal.target collectibles (items.good) placed on reachable ground within 20 blocks of the plot; collect radius 1.2 handled in AIXVoxel.collect(player, gems) -> {gems, got}
AIXVoxel.timeOfDay(tMs) -> {sun:0..1, skyTop:'#hex', skyBottom:'#hex', ambient:0..1}   // 6-minute day, never fully dark (kids), pretty sunrise/sunset
AIXVoxel.heightmap(world) / chunk helpers: AIXVoxel.CHUNK = 16; AIXVoxel.chunkKey(cx,cy,cz)
```
Mesh data helper (still pure): `AIXVoxel.buildChunkGeometry(world, cx, cy, cz) -> {positions:Float32Array, normals:Float32Array, uvs:Float32Array, colors:Float32Array, indices:Uint32Array}` with hidden-face culling, per-face shading (top 1.0, sides 0.8/0.7, bottom 0.5) baked into `colors`, cheap vertex ambient occlusion (4 levels) baked into `colors`, UVs into a 16x16-tile atlas (tile index from BLOCKS). Transparent blocks (water, glass, leaves cut-out) go to a separate `transparent` geometry set `{opaque, transparent}`. Water surface lowered 0.1 block. This keeps the heavy maths testable in node.

## Renderer — `ui/vg-aix-fp.jsx` (text/babel) + vendored `ui/vendor/three.min.js` (r128, already copied, MIT, DO NOT edit)
- `window.AIX_FP = { ExploreView }`, `ExploreView({ spec, onExit, onPlotChange, onEnd?, theme })`.
- Lazily checks `window.THREE` and WebGL support; on failure shows a friendly message and a button back to the isometric view (never a blank screen, never throws).
- Textures: a 16-tile atlas drawn at runtime into a `<canvas>` by OUR code (`AIXFp.makeAtlas`): grass top/side, dirt, stone, wood planks, leaves, brick, water, sand, glass, cloud, candy, jelly, snow, cactus, trunk (bark + rings), flowers. Pixel-art look: `NearestFilter`, no mipmaps blur, subtle 2-3 tone noise per tile from a seeded RNG. Our own art; do not imitate any game's exact textures.
- Scene: sky gradient + sun/moon sprite from `timeOfDay`, blocky drifting clouds (flat white boxes), fog matching the sky, hemisphere + directional light (vertex colours carry the baked shading), chunk meshes built lazily around the player within render distance 5 chunks (cap total triangles; rebuild only dirty chunks, at most 2 chunk rebuilds per frame), animals as box-part models (body/head/legs/ears) with simple leg swing, gems as spinning faceted shapes with sparkle bob, a block-selection wireframe, a hand/held-block in the corner, a hotbar of the 9 plot materials (selected block previewed), crosshair, small HUD (gems x/N, hearts if lives apply, "Plot saved" indicator), gentle block-break crack animation (3 stages), soft step/break/place sounds via the existing `window.aixSfx` if present.
- Controls: desktop = click canvas to lock pointer (Pointer Lock API), mouse look, WASD move, Space jump (hold in water to swim up), left-click break (hold), right-click place, 1-9 / wheel hotbar, Shift sprint, Esc releases. Touch = left virtual joystick (move), right-drag look, big buttons Jump / Break / Place / Next block, hotbar tappable. Everything also reachable without a mouse where reasonable. Respect `prefers-reduced-motion` (no head bob, no cloud drift).
- Performance: requestAnimationFrame with delta clamp, devicePixelRatio capped at 2, `renderer.dispose()` + geometry/material/texture disposal and listener removal on unmount, pause when the tab is hidden, one `three` scene, no per-frame allocations in hot paths.
- Safety: no `innerHTML`; all text via React; nothing from the spec is ever used as code, URL or HTML. Animals' names are fixed constants. Hero/gem names from the spec appear only through React text nodes.
- Win/lose: collecting all gems (`goal.target`, capped by what exists) shows the existing-style win card ("You found them all!"); no lose state in explore mode (no hostile mobs). Report through `onEnd({status:'won', score, lives, seconds, template:'blocks', title})`.
- Save: when the plot changes, debounce 600ms and call `onPlotChange(AIXVoxel.plotToBuild(world))`; the host merges it into the spec with the existing `toSpec` path.

## Integration (UI agent owns)
- `ui/vg-aix-blocks.jsx`: add the "Explore 3D" mode button (also keyboard reachable) that mounts `AIX_FP.ExploreView`; on return the iso view reloads the plot build (so edits made in 3D appear in Build mode). Do not break phase 1 behaviour or tests.
- `ui/VideoGen.html`: add `<script src="/ui/vendor/three.min.js?v=1"></script>` (plain, before the babel scripts), `<script src="/ui/vg-aix-voxel.js?v=1">` after `vg-aix-blocks.js`, and `<script type="text/babel" src="/ui/vg-aix-fp.jsx?v=1">` after `vg-aix-blocks.jsx`. Bump `?v=` of every phase 1 file that changed to `?v=2` so browsers do not serve stale code (vg-aix-engine.js, vg-aix-blocks.js, vg-aix-blocks.jsx, vg-aix-game.jsx, vg-aix-studio.jsx, vg-aix-studio-logic.js).
- Studio: after the AI builds a blocks game show the three modes; the AI "ask/nextIdeas" flow is unchanged. Add blocks twist/tweak chips: "Add a castle", "Make it a desert", "Add a pond", "Snowy mountains".

## Server (Server agent owns gamespec.py, openrouter_chat.py and their tests)
- `gamespec.py`: `TERRAINS = ("meadow","desert","snow","island","candy")`; for template `blocks`, `world.terrain` (enum, default "meadow" when missing) and `world.seed` (int 0..999999 via `_int`, default 1 when missing); both dropped for other templates; strict on wrong types (error, not repair) when present.
- `openrouter_chat.py`: `_SPEC_SHAPE` documents the two fields (blocks only); `GAME_SYSTEM` blocks guidance mentions the plot is a 12x12 building site inside a big world, to match terrain to the idea ("desert pyramid" -> desert), and to put the interesting build ON the plot. Still cartoon-only.
- Tests: valid/invalid terrain, seed bounds/types, dropped on non-blocks, defaults, API round trip.

## Tests (all agents)
- Pure module: `tests/test_aix_voxel.py` via node like `tests/test_aix_blocks.py` — determinism (same seed same world, different seeds differ), plot contents equal the build, plot levelled, spawn is dry and not inside a block, physics (gravity lands, cannot walk through solid, jump height, water buoyancy, edge wall, NaN/huge input safe), raycast hits the expected face, place/break rules (not inside player, bedrock, reach), plotToBuild round trip validates via `AIXBlocks.validateBuild`, geometry builder (cull counts for known tiny worlds, index/array length invariants, transparent split, no NaN), critters stay on land and never throw, gems reachable and count correct, timeOfDay bounds, hostile inputs, source scan for `eval`/`innerHTML`/`fetch`/`localStorage`/forbidden product name.
- UI: `tests/test_aix_shell.py` / new `tests/test_aix_fp.py` source-safety scans (no innerHTML/eval/dangerouslySetInnerHTML, dispose on unmount present, pointer-lock fallback, forbidden word absent), script tag order and versions, three.min.js integrity test (SHA-384 equals `CI3ELBVUz9XQO+97x6nwMDPosPR5XvsxW2ua7N1Xeygeh1IxtgqtCkGfQY9WWdHu`).
- Full suite must stay green.

## Known limits (state them in the final report, do not hide)
Not verified in a real browser by agents. Textures are procedural pixel art, not photo-real. No multiplayer, no redstone, no hostile mobs, session-only edits outside the plot.
