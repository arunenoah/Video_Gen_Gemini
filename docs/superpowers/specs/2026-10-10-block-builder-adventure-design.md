# Block Builder Adventure, part A: describe a world, mine, level up — design

Status: DRAFT for review (2026-10-10). Builds on `2026-10-09-block-builder-design.md` (iso Build/Play) and `2026-10-09-block-builder-3d-design.md` (first-person Explore 3D).
Sub-project 1 of 4. Later specs (not in this one): 2) characters, 3) shop + currency, 4) more worlds/landmarks.

## Purpose
Block Builder should feel like "build my own adventure", not "play a clone". A child **describes a world in their own words**, the AI builds it, the child **mines resources with digging tools**, reaches a goal ("collect 5 gold"), and is then asked **"what will you add next?"**, which creates the next level.
Naming: our own words only (never Mojang/Minecraft/Roblox names or characters; no "Steve", "Noob", "Villager", "Iron Golem").

## Decisions already made with the user
- **Describe-first.** The first screen is a big "Describe your world" box. The six world names (Meadow Farm, Snowy Mountain, Modern City, Desert, Island, Candy Land) are tap-to-fill idea sparks, plus Surprise me. Not a fixed menu.
- **Digging tools only, no weapons.** Shovel, pickaxe, hammer, later a super-drill. Matches the parents page and the AI prompt ("no weapons"). No hitting animals or people. Monsters (later spec) are silly, never scary.
- **Hybrid generation.** World terrain is built in the browser from an AI-written *recipe* (data from fixed lists). The AI is used for: the world recipe + build plot (existing `/api/game-spec`), and "what next?" ideas (existing `kind:"ideas"`). No new endpoints.
- Progress (inventory, tools, level) lives on the device only.

## Success criteria
- A child types "a snowy mountain village with gold caves" and plays in a world that visibly matches it within ~15 s, or gets the nearest preset with a kind note if the AI fails.
- Mining an ore shows a sparkle, takes the right tool, drops into the inventory bar.
- Finishing the goal shows "Level N done! What will you add next?" with 3 ideas + free text; choosing one produces level N+1 (richer world, new goal, better tool unlocked).
- Zero AI text or AI data is ever executed; nothing a child types is logged server-side.

## World recipe (spec additions; blocks template only, all optional, defaults from `world.terrain`)
`world.terrain` gains two values: `TERRAINS = meadow|desert|snow|island|candy|farm|city`. New optional object `world.recipe`:
```
"recipe": {
  "surface": "grass|sand|snow|candy|stone|dirt",        // top block of the land
  "hills": 0-5,  "water": 0-3,  "trees": 0-5,           // amplitude, lakes/sea amount, tree density
  "landmarks": ["barn|fields|fence|tower|road|igloo|pines|bridge|house|pond|windmill", ... up to 4],
  "ores": {"coal":0-5,"iron":0-5,"gold":0-5,"diamond":0-5,"ruby":0-5},   // richness; 0 = none
  "start": "dawn|day|sunset|night"                       // time of day when you arrive
}
```
Rules: unknown keys dropped; wrong types are errors (never repaired); ints clamped; enums case-normalised; at most 4 landmarks, duplicates removed; absent recipe = derived from the terrain preset so old saved games still load. `world.seed` (existing) drives all randomness.
If the idea can't be built from these pieces, the AI picks the nearest allowed pieces and says what it changed in `ask` ("I turned the lava river into a pond and kept the volcano tower. Want it sillier?").

## Goals and levels
- `goal.kind` gains `mine` with new `goal.resource` (`coal|iron|gold|diamond|ruby`) and the existing `goal.target` (3..50). Existing kinds unchanged.
- New optional `spec.level` int 1..20 (default 1). The AI prompt receives it ("make level N a bit richer and give a new goal").
- Level-up flow (client): goal reached -> card "Level N done! What will you add next?" -> `kind:"ideas"` call (idea = world title + resource) -> 3 ideas + free text (offline fallback: 3 built-in ideas per world type) -> child picks -> existing `/api/game-spec` tweak call with `previous_spec` and the idea as `tweak` -> validated spec with `level` = N+1 -> Explore reloads the *same seed/area* with more landmarks/ores and the new goal. World size stays 48x48.
- Tool unlocks by level: L1 shovel + stone pickaxe (coal, iron, gold), L2 iron pickaxe (diamond, ruby), L3 hammer, L4 super-drill (breaks a 3x3 patch). Shop-based unlocks come in spec 3.

## Mining, tools and inventory (pure engine `AIXVoxel`, new `AIXMining`)
- New block ids: `coalOre, ironOre, goldOre, diamondOre, rubyOre` (stone with sparkly cartoon flecks; own art). Placed by `generate` from `recipe.ores` richness in veins below the surface and inside mountains; `generate` guarantees at least `goal.target` of the goal resource are reachable by digging within 24 blocks of spawn (verified by a test).
- Breaking: each block has a hardness; each tool has a speed per block class and a tier. Ores need a minimum pickaxe tier; with the wrong tool the break animation does not finish and a gentle note says "Try a pickaxe!". Breaking an ore adds 1 (or 1-2 with richness) to `inventory[resource]`; ordinary blocks add nothing. Hotbar building blocks stay unlimited (creative building), only resources are counted.
- Tools: `hand, shovel, pickaxe, hammer, drill`; cartoon models in the held-item slot. Keys: `T` or the tool button cycles, `1-9` still pick building blocks.
- Inventory bar: resource icons + counts (coal, iron, gold, diamond, ruby), shown in the HUD; reaching the goal triggers the level card.
- Sparkle: ores within ~6 blocks of the player emit a slow sparkle on exposed faces (reduced-motion: static glint).

## Progress store (`ui/vg-aix-progress.js`, pure + tiny localStorage wrapper)
`{v:1, level:1..20, inventory:{coal,iron,gold,diamond,ruby: 0..9999}, tools:[...], games:{<gameId>:{level,inv}}}`. Key per game id on the existing Creator shelf; total size cap 2 KB per game; on load every field is re-validated and clamped, corrupt data resets to level 1. Storage access wrapped in try/catch; works without storage.

## Server changes (small, additive; `gamespec.py`, `openrouter_chat.py`)
- `TERRAINS` += `farm, city`; `_recipe()` strict validator as above; `goal.kind` += `mine` with `goal.resource` enum required for that kind; `level` int 1..20; all dropped for non-blocks templates.
- Prompt: `_SPEC_SHAPE` documents recipe/mine/level; `GAME_SYSTEM` blocks guidance: describe -> recipe, keep cartoon-only, "no weapons", use landmarks sparingly, state what you changed in `ask`; `game_spec_messages` passes `level`.
- `MAX_JSON_CHARS` stays 8000 (recipe adds ~250 chars); `GAME_MAX_TOKENS` stays 3000.
- No new endpoints, no new auth, no new logging; the existing per-user hourly `game` cap and credit reserve/settle still apply. A full level costs 2 AI calls (ideas + tweak); the offline fallback means a spent cap never blocks a kid from continuing to build and mine.

## Client changes
- `ui/vg-aix-voxel.js`: recipe-driven `generate` (surface, hills, water, trees, landmarks as small deterministic structure stamps: barn, fields+fence, tower, road grid, igloo, pine stands, bridge, house, pond, windmill), ore veins, `farm` and `city` terrain presets.
- New `ui/vg-aix-mining.js` (pure UMD): tools table, hardness/tier rules, break progress, drop rules, inventory add/validate, `goalReached`, `unlocksForLevel`. Everything deterministic and total.
- `ui/vg-aix-fp.jsx`: tool button + held tool model, inventory bar, mining feedback (sparkle, crack stages exist), level-complete card with ideas + free-text box, "Try a pickaxe!" note. Pause/won cards keep working.
- `ui/vg-aix-engine.js` (`clientValidate`) mirrors the new fields exactly; `vg-aix-studio*.js(x)`: the "Build a world" flow opens on the describe screen with world-name sparks; Surprise me is world-themed.
- Time-limit lock already covers Block Builder (commit pending) and must keep unmounting this pane when time is up.

## Safety and security (pass 1 summary, full pass before coding)
New untrusted inputs: AI recipe/goal/level fields (enums/ints, validated server + client); kid text (existing `_guard`); localStorage progress (re-validated). No new endpoints, files, URLs or HTML; canvas/WebGL only; no `eval`/`innerHTML`. Child safety: no weapons, no hostile mobs, no chat, cartoon-only names, no brand names; monsters/shop are separate later specs.

## Testing
- `gamespec`: recipe valid/invalid (types, enums, >4 landmarks, dup landmarks, unknown keys, hostile nesting), `mine` needs `resource`, `level` bounds, all dropped on non-blocks, defaults, API round trip incl. `previous_spec` with recipe.
- Engine: determinism, recipe changes terrain as expected, ore reachability for `goal.target` (independent flood fill), tool/tier/hardness table, drops, inventory clamps, level unlocks, progress store corruption cases, source scan (no forbidden sinks or brand words).
- UI: static checks for tool/inventory/level-card, dispose, a11y labels, 44 px targets, reduced-motion; JSX compiles; manual browser pass for feel.
- Full suite stays green (baseline 926).

## Out of scope for this spec
Characters (silly monster, iron-block robot, townsfolk, shopkeeper), shop and currency, weapons of any kind, multiplayer, resizing the world, more than 11 landmarks, sound design beyond the existing `aixSfx`.

## Risks / open questions
- AI quality: a free-text description can exceed what the recipe lists can express; mitigated by the "what I changed" note and offline preset fallback.
- Landmark stamps (barn, tower, windmill, city blocks) need art-direction care; v1 ships simple, recognisable shapes.
- AI cost per level (2 calls) with the hourly cap: offline ideas keep the loop playable.
- Browser verification of the 3D feel is still manual.
