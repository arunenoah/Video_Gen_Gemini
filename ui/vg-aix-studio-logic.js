// Game Studio — pure logic (no DOM, no network; storage is passed in as a string) so it is node-testable.
// Request builders mirror the server's limits (server.py _game_spec). The kid is the author: sparks and twists
// are offers, never grades. Anything read back from localStorage is re-validated with AIXEngine.clientValidate.
(function (root) {
  const LIMITS = { idea: 300, ideaMin: 3, tweak: 200, tweakMin: 3, pick: 40 };
  const SAVE_KEY = 'sg-aix-games-v1';
  const MAX_GAMES = 10;
  const MAX_GAME_BYTES = 6 * 1024;            // ponytail: cap is per saved game (a shelf of ten with drawings would never fit in 6 KB total)
  const MAX_SHELF_BYTES = 80 * 1024;          // refuse to even JSON.parse something absurd
  const MAX_VERSIONS = 5;
  const CTRL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\ufeff]', 'g');
  const HEX = /^#[0-9a-fA-F]{6}$/;

  // The engine is loaded before this file in the page; under node we require it.
  function engine() {
    if (root.AIXEngine) return root.AIXEngine;
    if (typeof require === 'function') { try { return require('./vg-aix-engine.js'); } catch (e) { /* fall through */ } }
    return null;
  }
  const TEMPLATES = ['catcher', 'runner', 'maze', 'shooter', 'quiz'];

  // ---------- chips (client constants, no AI) ----------
  const AUTO = 'auto';                        // "let the AI choose the game type" (server accepts it too)
  const TEMPLATE_CHIPS = [
    { id: 'catcher', label: 'Catch it', hint: 'Slide and catch things falling from the sky' },
    { id: 'runner', label: 'Dash', hint: 'Hop between lanes and zoom along' },
    { id: 'maze', label: 'Maze', hint: 'Find the way through twisty walls' },
    { id: 'shooter', label: 'Pop it', hint: 'Aim and pop the baddies' },
    { id: 'quiz', label: 'Quiz', hint: 'Answer brainy questions' },
  ];
  // Pools are bigger than what is shown; pickSome() rotates them so every kid does not get the same three jokes.
  const HERO_POOL = ['a sleepy dragon', 'a tiny robot', 'a brave jellyfish', 'a dancing cloud', 'a space hamster', 'a shy volcano',
    'a llama in roller skates', 'a grumpy moon', 'a very small giant', 'a pancake knight', 'a singing cactus', 'a time-travelling snail'];
  const HERO_CHIPS = HERO_POOL.slice(0, 6);
  const WORLD_CHIPS = ['space', 'forest', 'sea', 'city', 'candy'];
  const GOAL_CHIPS = ['collect lots of treasure', 'survive as long as possible', 'reach the secret door'];
  const IDEA_POOL = ['A dragon who collects falling marshmallows', 'A robot hamster racing through a candy maze', 'A cloud that rains confetti on a sleepy town',
    'A snail knight guarding a giant strawberry', 'A jellyfish band playing music for hungry whales', 'A tiny volcano that burps glitter',
    'A llama delivering pizza to the moon', 'A shy ghost learning to juggle stars', 'A pancake spaceship dodging syrup meteors',
    'A cactus who sings to thirsty raindrops', 'A time-travelling turtle collecting lost socks', 'A penguin chef in a world made of ice cream'];
  const IDEA_EXAMPLES = IDEA_POOL.slice(0, 3);
  /** n different items from a pool, in a seeded shuffle (same seed, same answer: easy to test). */
  function pickSome(pool, n, seed) {
    const a = pool.slice();
    let x = (Number(seed) || 0) % 2147483647 + 1;
    for (let i = a.length - 1; i > 0; i--) { x = (x * 48271) % 2147483647; const j = x % (i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a.slice(0, n);
  }

  // What-if twists: each maps to a fixed tweak text (3..200 chars) so the server never sees anything unvetted.
  const TWISTS = [
    { id: 'gravity', label: 'Gravity flips', text: 'What if gravity flipped, so things float up instead of falling down?' },
    { id: 'tiny', label: 'Hero shrinks', text: 'What if the hero shrank to be tiny and everything felt giant?' },
    { id: 'friends', label: 'Enemies become friends', text: 'What if the bad guys turned out to be friendly and silly instead?' },
    { id: 'glow', label: 'Glow in the dark', text: 'What if everything glowed in the dark with bright neon colours?' },
    { id: 'echo', label: 'Everything is a bit sleepy', text: 'What if everything moved in slow, dreamy motion?' },
    { id: 'party', label: 'It is a party', text: 'What if the whole game was a surprise birthday party?' },
    { id: 'giant', label: 'A giant appears', text: 'What if a giant friendly creature joined the game?' },
    { id: 'rainbow', label: 'Rainbow world', text: 'What if the whole world was made of rainbow colours?' },
  ];
  const TWEAK_CHIPS = [
    { id: 'faster', label: 'Faster', text: 'Make everything a bit faster' },
    { id: 'slower', label: 'Slower', text: 'Make everything a bit slower and calmer' },
    { id: 'morelives', label: 'More lives', text: 'Give the hero more lives' },
    { id: 'fewerlives', label: 'Fewer lives', text: 'Give the hero fewer lives for a bigger challenge' },
    { id: 'colours', label: 'Different colours', text: 'Change the colours to something totally different' },
    { id: 'story', label: 'Change the story', text: 'Change the story words to something new and funny' },
  ];
  // "Fix" buttons map to fixed tweak texts.
  const FIX_BUTTONS = [
    { id: 'hard', label: 'Too hard', text: 'It is too hard. Make it gentler and easier to win' },
    { id: 'easy', label: 'Too easy', text: 'It is too easy. Make it trickier and more exciting' },
    { id: 'boring', label: 'Boring', text: 'It feels boring. Add something surprising and fun' },
    { id: 'broken', label: 'It feels off', text: 'The game feels off when I play it. Make it simpler to understand and easier to play' },
  ];
  const REFLECTIONS = [
    { id: 'change', label: 'What would you change?' },
    { id: 'surprise', label: 'What surprised you?' },
    { id: 'missed', label: 'What did the AI miss?' },
  ];
  const SPARKS = [
    'What sound does the hero make?', 'Where does it happen?', 'Who is the hero friends with?', 'What is the hero scared of?',
    'What does the hero collect?', 'What is the weirdest thing in this world?', 'What colour is the sky?', 'What happens when you win?',
  ];

  const cleanText = (s, max) => String(s == null ? '' : s).replace(CTRL, '').trim().slice(0, max).trim();
  const wordCount = (s) => (String(s || '').trim().match(/\S+/g) || []).length;
  const lookup = (list, id) => list.find((x) => x.id === id) || null;

  // ---------- request builders (same limits as server.py) ----------
  /** Keep only the four allowed pick keys, each text <= 40 chars; empty ones are dropped. */
  function cleanPicks(picks) {
    const out = {};
    const src = picks && typeof picks === 'object' ? picks : {};
    ['hero', 'goal', 'world', 'twist'].forEach((k) => { const v = cleanText(src[k], LIMITS.pick); if (v) out[k] = v; });
    return out;
  }

  /**
   * Body for POST /api/game-spec (kind build).
   * @param {{engine:string,template:string,idea:string,tweak?:string,previousSpec?:Object,picks?:Object}} o
   * @returns {{ok:boolean, body?:Object, error?:string}} a friendly error, never a throw
   */
  function buildSpecRequest(o) {
    const E = engine(), a = o || {};
    const idea = cleanText(a.idea, LIMITS.idea + 1);
    const tweak = a.tweak == null ? '' : cleanText(a.tweak, LIMITS.tweak + 1);
    if (TEMPLATES.indexOf(a.template) < 0 && a.template !== AUTO) return { ok: false, error: 'Pick what kind of game you want first.' };
    if (idea.length < LIMITS.ideaMin || idea.length > LIMITS.idea) return { ok: false, error: 'Tell me your idea in a few words (up to 300 letters).' };
    if (tweak && (tweak.length < LIMITS.tweakMin || tweak.length > LIMITS.tweak)) return { ok: false, error: 'Say the change in a few words (up to 200 letters).' };
    const body = { engine: String(a.engine || 'chat-deepseek'), kind: 'build', template: a.template, idea: idea, picks: cleanPicks(a.picks) };
    if (tweak) body.tweak = tweak;
    if (a.previousSpec != null) {
      const v = E ? E.clientValidate(a.previousSpec) : { ok: false };
      if (!v.ok) return { ok: false, error: 'I lost track of the last version. Try building again.' };
      body.previous_spec = v.spec;
    }
    return { ok: true, body: body };
  }

  /** Body for POST /api/game-spec (kind ideas): "Surprise me". idea is optional. */
  function buildIdeasRequest(o) {
    const a = o || {};
    const body = { engine: String(a.engine || 'chat-deepseek'), kind: 'ideas', picks: cleanPicks(a.picks) };
    const idea = cleanText(a.idea, LIMITS.idea + 1);
    if (idea.length > LIMITS.idea) return { ok: false, error: 'That idea is a bit long for sparks. Shorten it a little.' };
    if (idea) body.idea = idea;
    return { ok: true, body: body };
  }

  /**
   * Classify a failed /api/game-spec call. 'care' and 'blocked' are calm, never retryable (resending the same words
   * would only add safety strikes); 'error' is a real hiccup. The care text itself comes from AIXStudyLogic.careText.
   * @param {number} status @param {Object} data @returns {{kind:'care'|'blocked'|'error', message:string, retryable:boolean}}
   */
  function failInfo(status, data) {
    const msg = data && typeof data.error === 'string' ? data.error.slice(0, 200) : '';
    if (data && data.retryable && status === 422) return { kind: 'error', message: msg || 'We could not check that just now. Try again in a moment!', retryable: true };
    if (status === 422 || (data && data.blocked)) {
      if (data && data.care) return { kind: 'care', message: '', retryable: false };
      return { kind: 'blocked', message: msg || "Let's try a different idea!", retryable: false };
    }
    return { kind: 'error', message: msg || 'The AI took a nap. Try again!', retryable: status !== 429 && status !== 400 };
  }

  /** Accept the server's ideas reply: exactly 3 non-empty strings, shown as React text only. */
  function readIdeas(data) {
    const list = data && Array.isArray(data.ideas) ? data.ideas : null;
    if (!list || list.length < 1) return null;
    const out = list.slice(0, 3).map((s) => cleanText(s, 80)).filter(Boolean);
    return out.length ? out : null;
  }

  // ---------- idea sparks (offers, never judging) ----------
  /**
   * 2-3 inspiration sparks the kid may tap to append or ignore. Skips sparks already answered in the idea
   * (cheap word check) so the list feels fresh. Deterministic for a given seed.
   */
  function sparks(idea, seed) {
    const text = String(idea || '').toLowerCase();
    const pool = SPARKS.filter((s) => !text.includes(s.toLowerCase().slice(0, 12)));
    const n = Number.isFinite(seed) ? Math.abs(Math.floor(seed)) : 0;
    const out = [];
    for (let i = 0; i < pool.length && out.length < 3; i++) out.push(pool[(n + i * 3) % pool.length]);
    return out.filter((s, i) => out.indexOf(s) === i).slice(0, 3);
  }

  /** Append a tapped spark (as a prompt for the kid to answer) without ever exceeding the 300-char limit. */
  function appendSpark(idea, spark) {
    const base = String(idea || '').trim();
    const add = cleanText(spark, 80);
    const joined = base ? base + (/[.!?]$/.test(base) ? ' ' : '. ') + add : add;
    return joined.length <= LIMITS.idea ? joined : base;
  }

  /** Pick an idea chosen by tapping; mixing two joins them with "and also" if it fits. */
  function mixIdeas(a, b) {
    const x = cleanText(a, 150), y = cleanText(b, 150);
    if (!x || !y) return x || y;
    const joined = x.replace(/[.!?]+$/, '') + ', and also ' + y.charAt(0).toLowerCase() + y.slice(1);
    return joined.length <= LIMITS.idea ? joined : x;
  }

  /** @returns {{id:string,label:string,text:string}|null} a twist by id */
  const twistById = (id) => lookup(TWISTS, id);

  /** A few different twists to show; "shuffle" passes a new seed. Deterministic. */
  function shuffleTwists(seed, n) {
    const k = Math.max(1, Math.min(n || 3, TWISTS.length));
    const start = Number.isFinite(seed) ? Math.abs(Math.floor(seed)) : 0;
    const out = [];
    for (let i = 0; i < k; i++) out.push(TWISTS[(start * 3 + i) % TWISTS.length]);
    return out;
  }

  /** The tweak text for a chip / fix / twist / AI-asked idea. Unknown id -> null. */
  function tweakText(group, id) {
    const list = group === 'twist' ? TWISTS : group === 'fix' ? FIX_BUTTONS : TWEAK_CHIPS;
    const hit = lookup(list, id);
    return hit ? hit.text : null;
  }

  /** The AI's own nextIdeas chips become tweaks: "Add a rainbow boss" -> "Add a rainbow boss" (padded to >= 3 chars). */
  function ideaToTweak(text) {
    const t = cleanText(text, LIMITS.tweak);
    return t.length >= LIMITS.tweakMin ? t : null;
  }

  // ---------- by-hand overrides ("you can change what the AI chose") ----------
  /** @returns {Object} a new spec with speed/lives/spawnRate replaced (each clamped 1..5); other keys untouched. */
  function applyOverrides(spec, o) {
    const out = JSON.parse(JSON.stringify(spec));
    ['speed', 'lives', 'spawnRate'].forEach((k) => {
      if (o && o[k] !== undefined) { const n = Math.round(Number(o[k])); if (Number.isFinite(n)) out.rules[k] = Math.max(1, Math.min(5, n)); }
    });
    return out;
  }

  // ---------- 8x8 pixel hero editor ----------
  // Index 0 is always the "see-through" colour (the world's background), then 5 paint colours: max 6 total, as the engine requires.
  const PAINT = ['#14202b', '#ff6b6b', '#ffd23f', '#2f9e5b', '#4dabf7'];
  const BG_FALLBACK = '#14202b';

  const emptyGrid = () => new Array(8).fill('00000000');
  /** Set one cell (0..7, 0..7) to colour digit d (0..5). Immutable. Out of range -> unchanged. */
  function paintCell(rows, r, c, d) {
    if (!Array.isArray(rows) || r < 0 || r > 7 || c < 0 || c > 7 || !(d >= 0 && d <= 5) || !Number.isInteger(r) || !Number.isInteger(c)) return rows;
    return rows.map((row, i) => (i === r ? row.slice(0, c) + String(d) + row.slice(c + 1) : row));
  }
  const clearGrid = emptyGrid;
  const isBlank = (rows) => !Array.isArray(rows) || rows.every((r) => /^0*$/.test(r));
  /** Mirror painting: also paint the left-right twin of (r,c) so symmetrical heroes are easy. */
  function paintMirror(rows, r, c, d) { return paintCell(paintCell(rows, r, c, d), r, 7 - c, d); }
  /** Push `rows` onto an undo stack (max 20 deep). Returns a new stack. */
  const pushUndo = (stack, rows) => (stack || []).concat([rows]).slice(-20);
  /** @returns {{rows:string[], stack:string[][]}} the previous drawing; an empty stack changes nothing. */
  function undo(stack, rows) { return stack && stack.length ? { rows: stack[stack.length - 1], stack: stack.slice(0, -1) } : { rows: rows, stack: [] }; }

  /** Palette for a sprite: bg first, then the five paint colours. */
  function spritePalette(bg) { return [HEX.test(bg || '') ? bg.toLowerCase() : BG_FALLBACK].concat(PAINT); }

  /** Build the spec's sprite object, or null when the grid is blank (so we never "draw" an empty box). */
  function toSprite(rows, bg) {
    return isBlank(rows) ? null : { palette: spritePalette(bg), rows: rows.slice() };
  }
  /** Load a spec sprite back into editor rows (digits >= 6 cannot occur: palette is <= 6). */
  function fromSprite(sprite) { return sprite && Array.isArray(sprite.rows) && sprite.rows.length === 8 ? sprite.rows.slice() : emptyGrid(); }

  /**
   * Put (or remove, when sprite is null) a drawing on hero / good / bad. Re-validated; returns the clean spec or null.
   * @param {Object} spec @param {'hero'|'good'|'bad'} target @param {Object|null} sprite
   */
  function applySprite(spec, target, sprite) {
    const E = engine();
    if (!E || ['hero', 'good', 'bad'].indexOf(target) < 0) return null;
    const out = JSON.parse(JSON.stringify(spec));
    const actor = target === 'hero' ? out.hero : out.items[target];
    // only this function (the kid's own pixel editor) may stamp a sprite as the kid's work
    if (sprite) actor.sprite = Object.assign({}, sprite, { by: 'kid' }); else delete actor.sprite;
    const v = E.clientValidate(out);
    return v.ok ? v.spec : null;
  }

  /**
   * After a tweak the server hands back a sprite without its provenance tag. If a sprite is unchanged from the previous
   * version, keep the tag it had, so the kid's own drawing stays "drawn by you" and the diff does not cry wolf.
   * @param {Object} prev previous spec @param {Object} next freshly validated spec @returns {Object} next (mutated copy)
   */
  function carryProvenance(prev, next) {
    const out = JSON.parse(JSON.stringify(next));
    const pick = (s, k) => (k === 'hero' ? s.hero : s.items[k]);
    ['hero', 'good', 'bad'].forEach((k) => {
      const p = pick(prev, k).sprite, n = pick(out, k).sprite;
      if (p && p.by && n && !n.by && JSON.stringify([p.palette, p.rows]) === JSON.stringify([n.palette, n.rows])) n.by = p.by;
    });
    return out;
  }

  // ---------- versions (time machine: last 5, in memory) ----------
  /**
   * Add a version. `n` counts up forever so "Version 7" stays unique even after old ones fall off.
   * @returns {Object[]} new list, oldest first, at most 5
   */
  function addVersion(list, spec, words) {
    const cur = Array.isArray(list) ? list : [];
    const n = cur.reduce((m, v) => Math.max(m, v.n), 0) + 1;
    return cur.concat([{ n: n, spec: JSON.parse(JSON.stringify(spec)), words: cleanText(words, 80) }]).slice(-MAX_VERSIONS);
  }
  /** @returns {Object|null} a version by number (a fresh copy of its spec) */
  function getVersion(list, n) {
    const v = (list || []).find((x) => x.n === n);
    return v ? { n: v.n, words: v.words, spec: JSON.parse(JSON.stringify(v.spec)) } : null;
  }

  // ---------- Creator shelf (localStorage text in/out; caller owns try/catch around the actual storage) ----------
  const newId = (seed) => Math.abs(Math.floor(Number.isFinite(seed) ? seed : Date.now())).toString(36).slice(-8).padStart(4, '0');

  /** Validate one stored entry; null if it is not a clean, small game. */
  function cleanEntry(e) {
    const E = engine();
    if (!E || !e || typeof e !== 'object' || Array.isArray(e)) return null;
    const v = E.clientValidate(e.spec);
    if (!v.ok) return null;
    if (JSON.stringify(v.spec).length > MAX_GAME_BYTES) return null;
    const name = cleanText(e.name, 40) || v.spec.title;
    const id = typeof e.id === 'string' && /^[a-z0-9]{4,12}$/.test(e.id) ? e.id : newId();
    const version = Number.isInteger(e.version) && e.version >= 1 && e.version <= 999 ? e.version : 1;
    return { id: id, name: name, version: version, spec: v.spec };
  }

  /** Parse the stored shelf text. Anything odd (not JSON, too big, wrong shape) -> []. Entries re-validated; max 10; no dup ids. */
  function parseShelf(raw) {
    try {
      if (typeof raw !== 'string' || raw.length > MAX_SHELF_BYTES) return [];
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return [];
      const out = [], seen = {};
      for (let i = 0; i < data.length && out.length < MAX_GAMES; i++) {
        const c = cleanEntry(data[i]);
        if (c && !seen[c.id]) { seen[c.id] = true; out.push(c); }
      }
      return out;
    } catch (e) { return []; }
  }
  /** @returns {string} the shelf as JSON text (validated again so a bad entry can never be written). */
  function serializeShelf(list) {
    const clean = (Array.isArray(list) ? list : []).map(cleanEntry).filter(Boolean).slice(0, MAX_GAMES);
    return JSON.stringify(clean);
  }
  /** Save a game to the front of the shelf (same id replaces). The oldest falls off past 10. Immutable. */
  function saveGame(list, spec, name, version, id, seed) {
    const e = cleanEntry({ id: id || newId(seed), name: name, version: version, spec: spec });
    if (!e) return Array.isArray(list) ? list : [];
    return [e].concat((list || []).filter((x) => x.id !== e.id)).slice(0, MAX_GAMES);
  }
  const removeGame = (list, id) => (list || []).filter((x) => x.id !== id);
  /** "Make it mine": a copy with a new id and a new name (kid's own), version reset to 1. Does not touch the original. */
  function makeItMine(entry, name, seed) {
    const e = cleanEntry({ id: newId(seed), name: cleanText(name, 40) || (entry && entry.name) + ' (mine)', version: 1, spec: entry && entry.spec });
    if (!e) return null;
    e.spec.title = cleanText(name, 40) || e.spec.title;
    return cleanEntry(e);
  }

  const api = {
    LIMITS, SAVE_KEY, MAX_GAMES, MAX_GAME_BYTES, MAX_VERSIONS, TEMPLATE_CHIPS, HERO_CHIPS, WORLD_CHIPS, GOAL_CHIPS, IDEA_EXAMPLES, TWISTS, TWEAK_CHIPS, FIX_BUTTONS, REFLECTIONS, PAINT,
    cleanPicks, failInfo, buildSpecRequest, buildIdeasRequest, readIdeas, sparks, appendSpark, mixIdeas, twistById, shuffleTwists, tweakText, ideaToTweak, wordCount,
    applyOverrides, emptyGrid, paintCell, paintMirror, clearGrid, isBlank, pushUndo, undo, spritePalette, toSprite, fromSprite, applySprite, carryProvenance, pickSome, AUTO, HERO_POOL, IDEA_POOL,
    addVersion, getVersion, parseShelf, serializeShelf, saveGame, removeGame, makeItMine,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AIXStudioLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
