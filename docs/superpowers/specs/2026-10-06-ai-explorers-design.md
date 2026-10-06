# AI Explorers — "Sunny's Robot Workshop" (design spec)

Status: design approved in conversation 2026-10-06; written spec for implementation.

## Purpose
A kids' AI-literacy section inside SparkGarden that is **not** about image/video generation. Ten short mini-games teach how AI
learns, decides, sees, errs, is biased, and how to use it safely. Inspired by Code.org topics (AI for Oceans, How AI Makes
Decisions, Computer Vision, AI Discoveries Unit 1, Coding with AI, Our AI Code of Ethics) and the engagement patterns of Code.org's
Minecraft Hour of AI activities (AI helper makes mistakes you correct, detective cases, instant visual payoff, rewards, free play).
Content is **original**; Code.org is only linked ("Go further").

## Success criteria
- A kid can open the tab, play a game for 2-3 minutes, finish, and get a robot part for Bolt without any help.
- Nothing is sent to the server. No free-text input. No timers that punish. Wrong moves give a funny reaction plus a hint, never a penalty.
- Every game plays differently (tap / drag / slider / catch / story fork) and is replayable (content shuffled from a pool).
- All logic is pure JS and tested under node, the same way `ui/vg-lab-logic.js` is tested in `tests/test_lab.py`.

## Scope and phases
- **Phase 1 (this build):** shell (map, Bolt, garden, robot parts, sounds, progress) + 3 games: **Pet Sorter** (#2), **Sabotage!** (#3),
  **Fib Finder** (#7). Stations for the other 7 games render as locked "Coming soon" tiles and must never crash.
- **Phase 2 (later):** AI Safari (#1), 20-Questions Machine (#4), Pixel Peek (#5), Case of the Unfair Robot (#6),
  Co-Pilot Challenge (#8), Secret Keeper (#9), Story Fork (#10). Same game contract.
- Out of scope: server APIs, accounts/sync of progress, leaderboards, timers, free-text input, LLM calls, fetched audio/images.

## Lesson catalog (single source of truth in `vg-aix-core.js`)
| # | id | Title | Game | Go further (label → URL) |
|---|----|-------|------|-----|
| 1 | `safari` | AI Safari | tap hidden AI in a scene | AI for Oceans → https://studio.code.org/s/oceans |
| 2 | `sorter` | Pet Sorter | drag creatures to train Bolt | How AI Makes Decisions → https://studio.code.org/s/k5-ai-data |
| 3 | `sabotage` | Sabotage! | mislabel then fix | AI for Oceans → https://studio.code.org/s/oceans |
| 4 | `twenty` | 20-Questions Machine | build a yes/no tree | How AI Makes Decisions → https://studio.code.org/s/k5-ai-data |
| 5 | `pixels` | Pixel Peek | guess from sharpening pixels | Computer Vision → https://studio.code.org/s/computer-vision |
| 6 | `bias` | Case of the Unfair Robot | fix skewed training data | How AI Works → https://studio.code.org/s/how-ai-works |
| 7 | `fib` | Fib Finder | find the made-up sentence | AI Discoveries → https://studio.code.org/courses/ai-discoveries-2026 |
| 8 | `copilot` | Co-Pilot Challenge | follow or override AI tips | Coding with AI → https://studio.code.org/s/coding-with-ai |
| 9 | `privacy` | Secret Keeper | catch private info bubbles | How AI Works → https://studio.code.org/s/how-ai-works |
| 10 | `ethics` | Story Fork | choose-your-own AI dilemmas | Our AI Code of Ethics → https://studio.code.org/s/ai-ethics |

Each entry: `{ id, n, title, tagline, concept, goFurther:{label,url}, part, ready:boolean }`. Phase 1 sets `ready:true` for
`sorter`, `sabotage`, `fib` only. `part` is the robot part id awarded on first finish.

## Files and ownership (FLAT in `ui/` — do not create subfolders; the static handler is tested only for flat files)
| File | Owner | Purpose |
|------|-------|---------|
| `ui/vg-aix-core.js` | Shell agent | Pure logic, UMD (`window.AIXCore` / `module.exports`): catalog, parts, progress, rng, links |
| `ui/vg-aix-shell.jsx` | Shell agent | `AIExplorersPane`, `AixBolt`, `AixConfetti`, `AixFrame`, sfx, map; exports to `window` |
| `ui/vg-aix-sorter.js` + `ui/vg-aix-sorter.jsx` | Sorter agent | Pet Sorter logic + view |
| `ui/vg-aix-sabotage.js` + `ui/vg-aix-sabotage.jsx` | Sabotage agent | Sabotage! logic + view |
| `ui/vg-aix-fib.js` + `ui/vg-aix-fib.jsx` | Fib agent | Fib Finder logic + view |
| `ui/VideoGen.html` | Shell agent only | script tags (all games pre-registered, load order below) |
| `ui/vg-views-chat.jsx` | Shell agent only | sidebar button `aix`, mode allow-list, pane mount |
| `ui/parents.html` | Parents agent | one short paragraph on "AI Explorers" |
| `tests/test_aix_core.py`, `tests/test_aix_shell.py` | Shell agent | core logic + wiring + security tests |
| `tests/test_aix_<game>.py` | each game agent | its logic tests |
| `tests/test_parents.py` | Parents agent | assert the paragraph exists |

Script load order in `VideoGen.html` (after `vg-views-lab.jsx`): `vg-aix-core.js`, `vg-aix-sorter.js`, `vg-aix-sabotage.js`,
`vg-aix-fib.js` (plain scripts), then `vg-aix-shell.jsx`, `vg-aix-sorter.jsx`, `vg-aix-sabotage.jsx`, `vg-aix-fib.jsx`
(type="text/babel"). The shell agent creates **stub** files for all game files so the page never 404s; game agents replace them.

## Contracts

### `AIXCore` (pure; no DOM, no network)
```
CATALOG: Lesson[]                     // table above
PARTS: [{id,name,slot}]               // slot in 'hat'|'face'|'body'|'wheels'|'color'; >= 1 part per lesson id in CATALOG, plus 3 free starters
rng(seed:number) -> () => number      // deterministic mulberry32, for tests and shuffles
shuffle(arr, rand) -> arr             // Fisher-Yates, returns a copy
emptyProgress() -> {v:1, done:{}, stars:{}, parts:[], outfit:{}, muted:false}
validateProgress(raw:any) -> Progress // NEVER throws. Unknown keys dropped; done/stars only for CATALOG ids; stars clamped 0..3 integers;
                                      // parts only ids in PARTS; outfit slot->partId only if owned and slot matches; muted boolean; else emptyProgress()
award(progress, lessonId, stars:0..3) -> Progress   // immutable; keeps max stars; marks done; adds lesson's part once
wear(progress, partId) -> Progress    // only if owned; one part per slot
loadProgress(storage) / saveProgress(storage, p)    // storage injected; ALL access try/catch; cap serialized size 4096 bytes; key 'sg-aix-v1'
safeLink(url) -> string|null          // https: only; host exactly code.org or studio.code.org (or subdomain of code.org); else null
```

### Game module contract (what the shell expects)
Each game file `vg-aix-<id>.jsx` registers a React component:
```
window.AIX_GAMES = window.AIX_GAMES || {};
window.AIX_GAMES.<lessonId> = AixXxxGame;     // function AixXxxGame({ onDone, onExit, theme, seed })
```
- `onDone(stars)` — called once when the kid finishes; `stars` integer 0..3 (>=1 on any completion). Shell shows reward + confetti.
- `onExit()` — kid pressed the back arrow.
- `seed` — integer; use `AIXCore.rng(seed)` for all shuffling (replays get a new seed).
- `theme` — same theme object Prompt Lab gets (`theme.primary` etc.).
- A game must render inside the shell frame (no own page chrome), and use `window.AixBolt` (props `{mood, size, outfit}`; moods
  `'curious'|'confused'|'proud'|'dizzy'|'happy'`) and `window.aixSfx(name)` (names `'pop','good','oops','win','tick'`; no-op if muted/unavailable).
- Each game's pure logic lives in `vg-aix-<id>.js` as UMD (`window.AIX_<ID>` / `module.exports`), no DOM, tested under node.

### Shell behaviour
- Sidebar mode id `aix`, label **AI Explorers**, same pattern as `lab` in `vg-views-chat.jsx` (button, allow-list, pane mount `<AIExplorersPane key={viewKey} theme={theme} menuVisible={...} />`).
- Home = garden path map with 10 stations (tile: number, title, tagline, stars, plant that grows when done). Locked (`ready:false`) tiles show "Coming soon" and are not clickable.
- Bolt dress-up: simple panel where kid picks owned parts by slot (no text input).
- After `onDone`: reward screen — Bolt wearing the new part, confetti, stars, then the **Go further** card: note "Ask a grown-up first", link rendered
  only if `safeLink()` returns non-null, `target="_blank" rel="noopener noreferrer"`.
- Sound: Web Audio synthesised blips only; mute toggle persisted in progress; created lazily on first user gesture; all in try/catch.
- Respect `prefers-reduced-motion` (no confetti / bounce when set). Keyboard: every interactive element is a `<button>` with an accessible name; drag games must also support click-to-pick then click-to-place.

## Phase 1 games — exact mechanics (so logic can be tested)

### Pet Sorter (`sorter`) — drag to train, then test
- Creatures are described by 3 feature tags (e.g. ears: `pointy|floppy`, tail: `fluffy|thin|curly`, sound: `meow|woof|squeak`) plus a drawn SVG look and a true class `cat|dog`
  (pool >= 14 creatures; some deliberately tricky e.g. a floppy-eared cat).
- Kid drags (or click-picks then clicks a pile) creatures into **Cat** pile / **Dog** pile. Kid chooses the labels themselves (kid labels may be "wrong" — Bolt learns what it is shown).
- Model: naive-Bayes-style feature counting with Laplace smoothing. `train(examples) -> model`, `predict(model, creature) -> {label, confidence 0..1}`.
- Bolt's confidence meter updates live after each drop. After >= 6 sorted creatures the kid can press "Test Bolt": 4 unseen mystery creatures, Bolt guesses each (wobbles when confidence < 0.65).
- `stars`: 1 for finishing; 2 if Bolt gets >= 3/4 right; 3 if 4/4 **and** kid trained with >= 8 examples.
- Logic exports: `POOL`, `pickTrainAndTest(rand)`, `train`, `predict`, `scoreTest(model, tests)`, `starsFor(correct, trained)`.

### Sabotage! (`sabotage`) — be the naughty genius, then fix it
- Phase A (Sabotage): kid sees 6-8 items (banana, apple, shoe, ball, carrot, sock, ...) each with a true label `food|not food`; kid is *encouraged* to flip labels (tap an item to flip). Bolt trains on the labels.
- Phase B (Orders): 5 "orders" run through Bolt (e.g. "Bring me a snack!"), Bolt's decisions follow the corrupted data and produce silly cartoon outcomes (serves a shoe). Shows `x/5 correct`.
- Phase C (Fix): kid corrects labels, re-runs, sees Bolt behave. Lesson text: "AI is only as good as its data."
- Model: nearest-label lookup by item feature tags (`round|long|soft|hard|sweet`) with majority vote (k=3 on tags). `train(items) -> model`, `decide(model, item) -> 'food'|'not food'`, `runOrders(model, orders) -> [{order, item, decision, correct}]`.
- `stars`: 1 finish; 2 if kid sabotaged >= 3 labels in A **and** fixed back to >= 4/5 in C; 3 if final is 5/5.
- Logic exports: `ITEMS`, `ORDERS`, `train`, `decide`, `runOrders`, `countFlips(items, labels)`, `starsFor(flips, finalCorrect)`.

### Fib Finder (`fib`) — find the made-up sentence
- Pool of >= 12 rounds. Each round: a kid question ("How do octopuses move?"), a chatbot answer of 4-5 short sentences, exactly **one** made-up (false) sentence, an explanation of the truth, and a "how to check" tip.
- **All non-fib sentences must be factually correct** (reviewer checks). Topics: animals, space, nature, everyday science. No scary, political, medical or sensitive content.
- Kid taps one sentence per round (magnifier cursor/visual). 3 rounds per play drawn with the seeded rng, never repeating a round within a play.
- `check(round, idx) -> {correct:boolean, fibIndex:number}`; Bolt/Sunny reaction by result; wrong guess shows hint and lets the kid try once more.
- `stars`: 1 finish; 2 if >= 2 found first try; 3 if 3/3 first try.
- Logic exports: `ROUNDS`, `pickRounds(rand, n)`, `check`, `starsFor(firstTryCorrect, total)`.

## Security requirements (from pass 1 — binding)
1. No `innerHTML`, `dangerouslySetInnerHTML`, `eval`, `new Function`, `document.write` in any `vg-aix-*` file. Tested by grep in `tests/test_aix_shell.py`.
2. `loadProgress` always routes through `validateProgress`; corrupted/hostile JSON yields empty progress; size capped at 4096 bytes.
3. Outbound links only via `safeLink()` + `rel="noopener noreferrer"`. Negative tests: `javascript:`, `http:`, `data:`, `https://code.org.evil.com`, `https://evilcode.org`, `//code.org`, uppercase scheme tricks → `null`.
4. No network calls (`fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`) in any `vg-aix-*` file. Tested by grep.
5. No personal data stored or shown; sample data in games is fictional.
6. Free-text input: none (no `<input type=text>`, no `<textarea>`).

## Testing
- Node-run tests (pattern: `tests/test_lab.py`): core (catalog integrity, validateProgress fuzz, award/wear immutability, safeLink negatives, rng determinism), each game's logic (positive/negative/edge), page wiring (script order, mode allow-list, sidebar button, no banned APIs, no text inputs, stubs exist).
- Run all: `python3 -m unittest discover -s tests -p 'test_aix_*.py' -v` plus the existing suite must still pass (`python3 -m unittest discover -s tests`).
- Manual: open `http://127.0.0.1:8767/`, sign in, AI Explorers tab, play each game with mouse and keyboard.

## Review gate
All code is subject to peer review before merging (org policy). Pass 2 of security-first runs after the build.
