# Block Builder (isometric voxel sandbox template for Game Studio) — design + contract

Status: approved in conversation 2026-10-09. Extends `2026-10-06-study-buddy-game-studio-design.md`.
Name is **Block Builder**. Never use the word "Minecraft", Mojang names or textures anywhere (UI, prompts, code comments, tests).

## What it is
A sixth Game Studio template, `blocks`. The kid imagines a world ("a castle on a floating island with a jelly bridge"); the AI returns a JSON spec (data, never code); the browser draws it as a small isometric block world. Two modes on the same world:
- **Build**: tap a column to stack a block of the chosen material, tap "remove" mode to take the top block away. Undo/redo, clear-to-starter.
- **Play**: hero walks (tap a tile, arrow keys / WASD, or on-screen D-pad) and jumps one block at a time, collects the good item, bumps into wandering silly critters (items.bad). Win/lose reuse the existing goal/lives/texts.
Everything the kid builds is saved on the device only (existing Creator shelf). No chat, no multiplayer, no personal info.

## Spec shape (additive; everything else is the existing spec)
`template:"blocks"` reuses `title, hero, goal, items, world, rules, texts, ask, nextIdeas` with these meanings:
- `goal.kind`: `score` = collect `target` good items (engine places exactly `min(target, free walkable cells)` of them, seeded, deterministic); `reach` = reach the flag on the highest walkable column; `survive` = stay un-bumped for `target` seconds while critters wander.
- `items.good` = the collectible; `items.bad` = the wandering critter. `rules.speed` = walk speed, `rules.lives` = lives, `rules.spawnRate` = number of critters (1..5).
- `world.theme` / `world.bg` = sky colour and decoration theme.
New required field when `template == "blocks"`, forbidden (dropped) otherwise:
```
"build": { "layers": [ <1..6 layers, bottom first>
   [ <12 strings, each exactly 12 chars from the alphabet below; string index = y (row), char index = x (column)> ] ] }
```
Alphabet (one char = one block; `.` = air): `g` grass, `d` dirt, `s` stone, `w` wood, `l` leaves, `b` brick, `a` water, `y` sand, `t` glass, `p` candy-pink, `c` cloud, `j` jelly (bouncy, cartoon only). No lava, no TNT, nothing scary.
Grid is fixed `SIZE=12` x `12`, `MAX_LAYERS=6`. Must contain >= 1 solid block, and at least one walkable cell (a column whose top is not water/air-only).
Max JSON chars raised 6000 -> 8000; `GAME_MAX_TOKENS` 2000 -> 3000.

## Engine contract — `AIXBlocks` (pure UMD, `ui/vg-aix-blocks.js`; no DOM, no network, no storage, deterministic, never throws)
```
AIXBlocks.SIZE = 12; AIXBlocks.MAX_LAYERS = 6; AIXBlocks.ALPHABET = '.gdswlbaytcpj'
AIXBlocks.MATERIALS = { g:{name:'Grass', top:'#hex', left:'#hex', right:'#hex', walkable:true}, ... }  // every ALPHABET char except '.'; a:{walkable:true, slow:true}; j:{bouncy:true}; t:{solid:true, see:true}
AIXBlocks.validateBuild(build) -> { ok:boolean, build:{layers:string[][]}|null, errors:string[] }   // identical rules to server gamespec._build
AIXBlocks.starterBuild() -> a valid, pretty 12x12 build (island, tree, little house, pond)
AIXBlocks.heightAt(build, x, y) -> int 0..6        // number of the highest non-air layer + 1 (0 = empty column)
AIXBlocks.topMaterial(build, x, y) -> char|'.'
AIXBlocks.create(spec, seed) -> state              // called by AIXEngine.create when spec.template === 'blocks'
   state = { v:1, template:'blocks', spec, status:'playing'|'won'|'lost'|'invalid', t, score, lives, progress, events:[], msg,
             build:{layers}, hero:{x,y,z,dir}, items:[{id,x,y,z,kind:'good'|'flag'}], critters:[{id,x,y,z}], path:[{x,y}], rs }
AIXBlocks.step(state, input, dtMs) -> state        // pure; input = { dx?:-1|0|1, dy?:-1|0|1, jump?:bool, goTo?:{x,y} }  (grid directions, x = column, y = row)
   Rules: one cell per move (cooldown from rules.speed); may step up/down 1 block free, up 2 only with jump:true, jelly 'j' launches +2; water slows; cannot enter solid cells or leave the grid; goTo = BFS path (<= 200 steps) over walkable cells, cancelled by any dx/dy.
   Events pushed in state.events (cleared each step): {type:'step'|'jump'|'good'|'bad'|'win'|'lose'|'bounce'|'place'|'remove', x,y,z}
AIXBlocks.edit(state, { op:'place'|'remove', x, y, mat? }) -> { state, ok:boolean, reason?:string }
   place: stacks on top of column (x,y) if height < MAX_LAYERS, mat in ALPHABET minus '.', not onto the hero cell; remove: removes the top block unless the hero stands on it or it is the last block in the grid. Out-of-range / bad input -> ok:false, state unchanged. Keeps items/critters on valid ground (moves them up/down with the column).
AIXBlocks.toSpec(state) -> validated spec copy with the current build   // used by Save; returns null if invalid
AIXBlocks.project(x, y, z, view) -> { sx, sy }     // view = { tile:number (px width of one tile), ox:number, oy:number }; classic 2:1 isometric, +x = down-right, +y = down-left, +z = up (tile/2 px per level)
AIXBlocks.pick(sx, sy, build, view) -> { x, y, z, face:'top'|'left'|'right' } | null   // topmost block under the pixel; ties resolved front-most
AIXBlocks.describe(spec) -> string                // accessible one-sentence description (counts of blocks/materials)
AIXBlocks.hasBlocks = true
```
`AIXEngine` changes (owner: Engine agent): `TEMPLATES` gains `'blocks'`; `clientValidate` additionally validates `build` via `AIXBlocks.validateBuild` when template is blocks (error if missing, dropped otherwise); `create/step/describe` delegate to `AIXBlocks`; `defaultSpec('blocks')` returns a fun starter; `friendlyDiff` mentions block-count changes. In node the engine does `require('./vg-aix-blocks.js')`; in the browser it reads `root.AIXBlocks` lazily (so script order does not matter as long as both load before play).

## Server contract (Server agent)
- `gamespec.py`: `TEMPLATES += ("blocks",)`; `MATERIALS = ".gdswlbaytcpj"`; `_build(v)` strict (exactly 1..6 layers of exactly 12 strings of exactly 12 allowed chars, >= 1 solid block, >= 1 non-water solid top); error (never clamp/repair) otherwise; `validate_spec` adds `clean["build"]` iff template == blocks and ignores `build` otherwise; `MAX_JSON_CHARS = 8000`; `spec_texts` unchanged (build has no free text).
- `openrouter_chat.py`: `_SPEC_SHAPE` documents `build` (only when template is blocks); `GAME_SYSTEM` gets blocks guidance (build a small readable world: ground layer, 2-4 features, leave walkable paths, cartoon-only, no lava/TNT/weapons); `game_spec_messages` "auto" choice list includes blocks; `GAME_MAX_TOKENS = 3000`.
- `server.py`: nothing should need changing beyond template enum plumbing (it reads `gamespec.TEMPLATES`). Do not weaken any guard. No kid text or block grids in logs.
- Tests: `tests/test_gamespec.py`, `tests/test_game_api.py` — positive and negative (bad alphabet, 13-char row, 11 rows, 0 / 7 layers, all-air, all-water, giant nested JSON, `build` on a non-blocks template dropped, `build` missing on blocks template rejected, previous_spec round trip with blocks, auto template accepted).

## UI contract (UI agent)
- `ui/vg-aix-blocks.jsx` (new, text/babel): `window.AIX_BLOCKS = { BlocksPlayer }`, `BlocksPlayer({ spec, onEnd, onExit, onChange?, theme })` draws the isometric canvas (cube faces from `AIXBlocks.MATERIALS` top/left/right, painter's order back-to-front, hero + items + critters drawn from the existing sprite/shape helpers in `vg-aix-game.jsx` where possible, soft shadows, tile-hover outline), drives `AIXBlocks.step` on requestAnimationFrame (dirty-flag: stop looping when nothing moves AND mode is build), Play/Build toggle, material palette (big touch targets, >= 44 px), place/remove switch, undo/redo (<= 30 steps), on-screen D-pad + jump for touch, keyboard (arrows/WASD + space), tap-to-walk via `AIXBlocks.pick`. Calls `onChange(AIXBlocks.toSpec(state))` after the kid edits (debounced) so the Studio can save to the Creator shelf. `onEnd` payload is identical to the other templates (`{status, score, lives, seconds, template, title}`). Respect `prefers-reduced-motion`, give the canvas an `aria-label` from `AIXBlocks.describe`, and provide keyboard equivalents for everything. Never use innerHTML; all text through React.
- `vg-aix-game.jsx`: the existing player dispatches to `AIX_BLOCKS.BlocksPlayer` when `spec.template === 'blocks'`.
- `vg-aix-studio-logic.js` / `vg-aix-studio.jsx`: add `'blocks'` to `TEMPLATES`, a chip `{ id:'blocks', label:'Build a world', hint:'Build a block world, then explore it' }`, a starter, and wire `onChange` -> save to the Creator shelf using the existing save path (respecting `MAX_GAME_BYTES`; a blocks spec must fit). New twist/tweak chips for blocks are optional, keep them few.
- `ui/VideoGen.html`: add `<script src="/ui/vg-aix-blocks.js?v=1">` after `vg-aix-engine.js` and `<script type="text/babel" src="/ui/vg-aix-blocks.jsx?v=1">` after `vg-aix-game.jsx`.
- Tests: extend `tests/test_aix_studio.py` / `tests/test_aix_shell.py` for the new chip/template/script tags (follow the node-harness pattern those tests already use).

## Done = 
`./.venv/bin/python3 -m unittest discover -s tests` passes (baseline 661 + new), no existing test weakened, security pass 2 clean.
