// AI Explorers core — pure logic (no DOM, no network) so it can be tested with node.
// Holds the lesson catalog, Bolt's robot parts, kid progress (validated on every load) and the one safe-link gate.
(function (root) {
  const KEY = 'sg-aix-v1';
  const MAX_BYTES = 4096;   // saved progress is tiny; anything bigger is junk or tampering

  const CODE = 'https://studio.code.org/';
  const L = (id, n, title, tagline, concept, label, url, part, ready) =>
    ({ id, n, title, tagline, concept, goFurther: { label, url }, part, ready });

  // Single source of truth for the ten stations. Phase 1: only sorter / sabotage / fib are playable.
  const CATALOG = [
    L('safari', 1, 'AI Safari', 'Spot the hidden AI', 'AI is hiding in lots of everyday things.', 'AI for Oceans', CODE + 's/oceans', 'p-explorer-hat', false),
    L('sorter', 2, 'Pet Sorter', 'Teach Bolt cats and dogs', 'AI learns from examples you show it.', 'How AI Makes Decisions', CODE + 's/k5-ai-data', 'p-propeller-hat', true),
    L('sabotage', 3, 'Sabotage!', 'Be naughty, then fix it', 'AI is only as good as its data.', 'AI for Oceans', CODE + 's/oceans', 'p-rocket-wheels', true),
    L('twenty', 4, '20-Questions Machine', 'Build a yes/no tree', 'AI can decide by asking simple questions.', 'How AI Makes Decisions', CODE + 's/k5-ai-data', 'p-antenna-hat', false),
    L('pixels', 5, 'Pixel Peek', 'Guess as pictures sharpen', 'Computers see pictures as tiny dots.', 'Computer Vision', CODE + 's/computer-vision', 'p-goggles-face', false),
    L('bias', 6, 'Case of the Unfair Robot', 'Fix the skewed data', 'Unfair examples make an unfair AI.', 'How AI Works', CODE + 's/how-ai-works', 'p-cape-body', false),
    L('fib', 7, 'Fib Finder', 'Find the made-up sentence', 'AI can say wrong things that sound right.', 'AI Discoveries', CODE + 'courses/ai-discoveries-2026', 'p-detective-hat', true),
    L('copilot', 8, 'Co-Pilot Challenge', 'Follow or override tips', 'You are the boss of the AI helper.', 'Coding with AI', CODE + 's/coding-with-ai', 'p-pilot-face', false),
    L('privacy', 9, 'Secret Keeper', 'Catch the private bubbles', 'Keep private things private.', 'How AI Works', CODE + 's/how-ai-works', 'p-shield-body', false),
    L('ethics', 10, 'Story Fork', 'Choose what the AI should do', 'People decide how AI should be used.', 'Our AI Code of Ethics', CODE + 's/ai-ethics', 'p-gold-color', false),
  ];

  // slot is one of hat | face | body | wheels | color. free:true parts are owned from the start.
  const PARTS = [
    { id: 'p-starter-smile', name: 'Happy smile', slot: 'face', free: true },
    { id: 'p-starter-blue', name: 'Sky blue paint', slot: 'color', free: true },
    { id: 'p-starter-wheels', name: 'Zippy wheels', slot: 'wheels', free: true },
    { id: 'p-explorer-hat', name: 'Explorer hat', slot: 'hat' },
    { id: 'p-propeller-hat', name: 'Propeller cap', slot: 'hat' },
    { id: 'p-rocket-wheels', name: 'Rocket wheels', slot: 'wheels' },
    { id: 'p-antenna-hat', name: 'Wiggly antenna', slot: 'hat' },
    { id: 'p-goggles-face', name: 'Cool goggles', slot: 'face' },
    { id: 'p-cape-body', name: 'Hero cape', slot: 'body' },
    { id: 'p-detective-hat', name: 'Detective hat', slot: 'hat' },
    { id: 'p-pilot-face', name: 'Pilot visor', slot: 'face' },
    { id: 'p-shield-body', name: 'Shiny shield', slot: 'body' },
    { id: 'p-gold-color', name: 'Golden paint', slot: 'color' },
    // earned by the two studios (one each) and by exploring (trying things, never by being "right")
    { id: 'p-scholar-face', name: 'Wise glasses', slot: 'face' },
    { id: 'p-maker-hat', name: 'Maker beret', slot: 'hat' },
    { id: 'p-compass-body', name: 'Explorer backpack', slot: 'body' },
    { id: 'p-stardust-color', name: 'Stardust paint', slot: 'color' },
    { id: 'p-pixel-face', name: 'Pixel visor', slot: 'face' },
    { id: 'p-spark-hat', name: 'Idea spark', slot: 'hat' },
  ];

  // The two big "studios" above the stations. Same shape as a lesson so award()/parts treat them alike.
  const STUDIOS = [
    { id: 'study', title: 'Study Buddy', tagline: 'Ask Sunny anything: homework help or wonders', part: 'p-scholar-face', ready: true },
    { id: 'studio', title: 'Game Studio', tagline: 'Dream up a game, draw your hero, play it', part: 'p-maker-hat', ready: true },
  ];

  // Hard-coded on purpose (must equal AIXEngine.TEMPLATES): core must not depend on the engine being loaded.
  const TEMPLATES = ['catcher', 'runner', 'maze', 'shooter', 'quiz'];
  const COUNTERS = ['wonder', 'sprites', 'ideas'];     // each 0..99
  const COUNTER_MAX = 99;
  // Exploration milestones -> the part they unlock. Each is checked by explored(): templates needs all five.
  const EXPLORE_PARTS = { templates: 'p-compass-body', wonder: 'p-stardust-color', sprites: 'p-pixel-face', ideas: 'p-spark-hat' };
  const EXPLORE_GOAL = { wonder: 3, sprites: 1, ideas: 1 };

  const SLOTS = ['hat', 'face', 'body', 'wheels', 'color'];
  const lessonOf = (id) => CATALOG.find(c => c.id === id) || null;
  const studioOf = (id) => STUDIOS.find(c => c.id === id) || null;
  const partOf = (id) => PARTS.find(p => p.id === id) || null;
  const isOwned = (p, id) => { const part = partOf(id); return !!part && (part.free === true || p.parts.indexOf(id) !== -1); };

  /** Deterministic mulberry32 generator. @param {number} seed @returns {() => number} floats in [0,1). */
  function rng(seed) {
    let a = (Number(seed) || 0) >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Fisher-Yates. @param {Array} arr @param {() => number} rand @returns {Array} a shuffled copy (input untouched). */
  function shuffle(arr, rand) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /** @returns {{v:number,done:Object,stars:Object,parts:string[],outfit:Object,muted:boolean,explored:Object}} a fresh progress record. */
  function emptyProgress() { return { v: 1, done: {}, stars: {}, parts: [], outfit: {}, muted: false, explored: emptyExplored() }; }

  /** @returns {{templates:string[],wonder:number,sprites:number,ideas:number}} nothing tried yet. */
  function emptyExplored() { return { templates: [], wonder: 0, sprites: 0, ideas: 0 }; }

  /** Clamp to an integer 0..99; only real numbers count (strings/objects/NaN become 0). */
  function clampCount(n) { return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(COUNTER_MAX, Math.floor(n))) : 0; }

  /**
   * Turn ANY value into a clean progress record. Never throws; unknown keys are dropped and bad values reset.
   * @param {*} raw whatever came out of storage
   * @returns {Object} Progress
   */
  function validateProgress(raw) {
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyProgress();
      const out = emptyProgress();
      const done = raw.done && typeof raw.done === 'object' ? raw.done : {};
      const stars = raw.stars && typeof raw.stars === 'object' ? raw.stars : {};
      CATALOG.concat(STUDIOS).forEach(c => {
        if (Object.prototype.hasOwnProperty.call(done, c.id) && done[c.id] === true) out.done[c.id] = true;
        if (Object.prototype.hasOwnProperty.call(stars, c.id)) {
          const s = Number(stars[c.id]);
          out.stars[c.id] = Number.isFinite(s) ? Math.max(0, Math.min(3, Math.floor(s))) : 0;
        }
      });
      if (Array.isArray(raw.parts)) {
        PARTS.forEach(p => { if (!p.free && raw.parts.indexOf(p.id) !== -1) out.parts.push(p.id); });   // PARTS order de-dupes and drops junk
      }
      const outfit = raw.outfit && typeof raw.outfit === 'object' ? raw.outfit : {};
      SLOTS.forEach(slot => {
        if (!Object.prototype.hasOwnProperty.call(outfit, slot)) return;
        const part = partOf(outfit[slot]);
        if (part && part.slot === slot && isOwned(out, part.id)) out.outfit[slot] = part.id;
      });
      out.muted = raw.muted === true;
      const ex = raw.explored && typeof raw.explored === 'object' && !Array.isArray(raw.explored) ? raw.explored : {};
      if (Array.isArray(ex.templates)) out.explored.templates = TEMPLATES.filter(t => ex.templates.indexOf(t) !== -1);   // allow-list order de-dupes and drops junk
      COUNTERS.forEach(k => { out.explored[k] = clampCount(ex[k]); });
      return out;
    } catch (e) { return emptyProgress(); }
  }

  /**
   * Record a finished lesson. Immutable. Keeps the best stars, marks done, grants the lesson's part once.
   * @param {Object} progress @param {string} lessonId @param {number} stars 0..3 @returns {Object} new Progress
   */
  function award(progress, lessonId, stars) {
    const p = validateProgress(progress);
    const lesson = lessonOf(lessonId) || studioOf(lessonId);   // studios award a part the same way (stars stay 0)
    if (!lesson) return p;
    const s = Number.isFinite(Number(stars)) ? Math.max(0, Math.min(3, Math.floor(Number(stars)))) : 0;
    p.done[lessonId] = true;
    p.stars[lessonId] = Math.max(p.stars[lessonId] || 0, s);
    if (p.parts.indexOf(lesson.part) === -1) p.parts.push(lesson.part);
    return p;
  }

  /**
   * Record that the kid TRIED something (never a score). Immutable, validated, unknown keys ignored.
   * key 'templates': value is a template id (added once). key 'wonder'|'sprites'|'ideas': value is how many to add
   * (default 1; capped at 99 in total). Crossing a milestone grants its part once.
   * @param {Object} progress @param {string} key @param {*} value @returns {Object} new Progress
   */
  function explore(progress, key, value) {
    const p = validateProgress(progress);
    const e = p.explored;
    if (key === 'templates') {
      if (TEMPLATES.indexOf(value) === -1 || e.templates.indexOf(value) !== -1) return p;
      e.templates = TEMPLATES.filter(t => t === value || e.templates.indexOf(t) !== -1);
    } else if (COUNTERS.indexOf(key) !== -1) {
      const add = value === undefined ? 1 : clampCount(value);
      e[key] = Math.min(COUNTER_MAX, e[key] + add);
    } else return p;
    const reached = e.templates.length === TEMPLATES.length ? ['templates'] : [];
    COUNTERS.forEach(k => { if (e[k] >= EXPLORE_GOAL[k]) reached.push(k); });
    reached.forEach(k => { if (p.parts.indexOf(EXPLORE_PARTS[k]) === -1) p.parts.push(EXPLORE_PARTS[k]); });
    return p;
  }

  /**
   * Put an owned part on Bolt (one per slot). Wearing the part that is already on takes it off again.
   * Not owned / unknown part: returns an unchanged copy. Immutable.
   */
  function wear(progress, partId) {
    const p = validateProgress(progress);
    const part = partOf(partId);
    if (!part || !isOwned(p, partId)) return p;
    if (p.outfit[part.slot] === partId) delete p.outfit[part.slot]; else p.outfit[part.slot] = partId;
    return p;
  }

  /** @param {{getItem:Function}} storage injected (localStorage in the page). @returns {Object} Progress; empty on any problem. */
  function loadProgress(storage) {
    try {
      const raw = storage.getItem(KEY);
      if (typeof raw !== 'string' || raw.length > MAX_BYTES) return emptyProgress();
      return validateProgress(JSON.parse(raw));
    } catch (e) { return emptyProgress(); }
  }

  /** @returns {boolean} true if saved; false when storage failed or the record would exceed the size cap. */
  function saveProgress(storage, p) {
    try {
      const s = JSON.stringify(validateProgress(p));
      if (s.length > MAX_BYTES) return false;
      storage.setItem(KEY, s);
      return true;
    } catch (e) { return false; }
  }

  // https only; host is exactly code.org or any subdomain of it. No userinfo, port, spaces, backslashes or uppercase scheme tricks.
  const LINK_RE = /^https:\/\/(?:[a-z0-9-]+\.)*code\.org(?:\/[^\s\\@]*)?$/;
  /** @param {*} url @returns {string|null} the same url if it is a safe code.org link, else null. */
  function safeLink(url) {
    return typeof url === 'string' && url.length <= 300 && LINK_RE.test(url) ? url : null;
  }

  const api = { KEY, MAX_BYTES, SLOTS, CATALOG, STUDIOS, TEMPLATES, PARTS, lessonOf, studioOf, partOf, isOwned, rng, shuffle, emptyProgress, emptyExplored, validateProgress, award, explore, wear, loadProgress, saveProgress, safeLink };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AIXCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
