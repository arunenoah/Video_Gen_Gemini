// AI Explorers game engine — pure (no DOM, no network, no storage) so it can be tested with node.
// The AI only ever writes a small JSON "game spec"; this engine validates it (clientValidate) and plays it.
// No AI text is ever run as code: specs are data, rules live here. Deterministic: same spec + seed + inputs = same game.
(function (root) {
  const TEMPLATES = ['catcher', 'runner', 'maze', 'shooter', 'quiz'];
  const SHAPES = ['circle', 'square', 'triangle', 'star', 'heart'];
  const THEMES = ['space', 'forest', 'sea', 'city', 'candy'];
  const KINDS = ['score', 'survive', 'reach'];
  const HEX = /^#[0-9a-fA-F]{6}$/;
  // Fixed fallback colours (same idea as the server's palette): a bad colour is swapped, never trusted.
  const DEFAULT_COLOR = { hero: '#ff7a59', good: '#2f9e5b', bad: '#6b4bd6', bg: '#14202b', sprite: '#888888' };
  const W = 100, H = 100;                 // logical world; the canvas scales it
  const MAX_DT = 50;                      // ms; a long frame (tab switch) never teleports things

  // ---------- validation ----------
  const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
  const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
  // Control and invisible direction characters are removed; angle brackets and javascript: are refused outright (defence in depth).
  const CTRL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;
  const UNSAFE = /[<>]|javascript\s*:|data\s*:\s*text|vbscript\s*:/i;

  /** Coerce to a clamped int; numeric strings accepted; NaN/other types -> null. */
  function toInt(v, lo, hi) {
    let n = v;
    if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) n = Number(v);
    if (typeof n !== 'number' || Number.isNaN(n)) return null;
    return Math.max(lo, Math.min(hi, Math.round(n)));
  }

  /** Strip, remove control chars, cap length. Returns {s} or {err}. */
  function cleanStr(v, max, what, errors, required) {
    if (typeof v !== 'string') { if (v !== undefined || required) errors.push(what + ' must be text'); return null; }
    const s = v.replace(CTRL, '').trim().slice(0, max).trim();
    if (UNSAFE.test(s)) { errors.push(what + ' has unsafe characters'); return null; }
    if (!s) { if (required) errors.push(what + ' is empty'); return null; }
    return s;
  }

  function cleanColor(v, role) { return typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : DEFAULT_COLOR[role]; }

  /** A sprite is exactly {palette:[1..6 hex], rows:[8 strings of 8 digits < palette length]} or it is dropped (null). */
  function cleanSprite(sp) {
    if (!isObj(sp)) return null;
    const pal = own(sp, 'palette'), rows = own(sp, 'rows');
    if (!Array.isArray(pal) || pal.length < 1 || pal.length > 6 || !Array.isArray(rows) || rows.length !== 8) return null;
    const palette = [];
    for (let i = 0; i < pal.length; i++) { if (typeof pal[i] !== 'string' || !HEX.test(pal[i])) return null; palette.push(pal[i].toLowerCase()); }
    const out = [];
    for (let r = 0; r < 8; r++) {
      const row = rows[r];
      if (typeof row !== 'string' || row.length !== 8) return null;
      for (let c = 0; c < 8; c++) { const d = row.charCodeAt(c) - 48; if (d < 0 || d > 9 || d >= palette.length) return null; }
      out.push(row);
    }
    const res = { palette, rows: out };
    // Provenance tag: only the two hand-made sources are honoured. The server strips it from AI output, so a
    // sprite the model drew can never claim to be the kid's own work.
    const by = own(sp, 'by');
    if (by === 'kid' || by === 'starter') res.by = by;
    return res;
  }

  function cleanActor(a, role, what, errors) {
    if (!isObj(a)) { errors.push(what + ' is missing'); return null; }
    const shape = own(a, 'shape');
    if (SHAPES.indexOf(shape) < 0) errors.push(what + ' shape is not one of ' + SHAPES.join('/'));
    const name = cleanStr(own(a, 'name'), 20, what + ' name', errors, true);
    const o = { shape: shape, color: cleanColor(own(a, 'color'), role), name: name };
    const sp = cleanSprite(own(a, 'sprite'));
    if (sp) o.sprite = sp;
    return o;
  }

  /**
   * Validate a game spec with the same rules as the server's gamespec.py (allow-list, clamp, enums, text safety).
   * Never throws, whatever it is given.
   * @param {*} spec anything
   * @returns {{ok:boolean, spec:Object|null, errors:string[]}} a fresh clean copy when ok
   */
  function clientValidate(spec) {
    const errors = [];
    try {
      if (!isObj(spec)) return { ok: false, spec: null, errors: ['spec must be an object'] };
      if (own(spec, 'v') !== 1) errors.push('v must be 1');
      const template = own(spec, 'template');
      if (TEMPLATES.indexOf(template) < 0) errors.push('template is not one of ' + TEMPLATES.join('/'));
      const title = cleanStr(own(spec, 'title'), 40, 'title', errors, true);
      const hero = cleanActor(own(spec, 'hero'), 'hero', 'hero', errors);
      const g = own(spec, 'goal');
      let goal = null;
      if (!isObj(g)) errors.push('goal is missing');
      else {
        const kind = own(g, 'kind'), target = toInt(own(g, 'target'), 3, 50);
        if (KINDS.indexOf(kind) < 0) errors.push('goal kind is not one of ' + KINDS.join('/'));
        if (target === null) errors.push('goal target must be a number');
        goal = { kind: kind, target: target };
      }
      const it = own(spec, 'items');
      let items = null;
      if (!isObj(it)) errors.push('items is missing');
      else items = { good: cleanActor(own(it, 'good'), 'good', 'good item', errors), bad: cleanActor(own(it, 'bad'), 'bad', 'bad item', errors) };
      const w = own(spec, 'world');
      let world = null;
      if (!isObj(w)) errors.push('world is missing');
      else {
        const theme = own(w, 'theme');
        if (THEMES.indexOf(theme) < 0) errors.push('world theme is not one of ' + THEMES.join('/'));
        world = { bg: cleanColor(own(w, 'bg'), 'bg'), theme: theme };
      }
      const r = own(spec, 'rules');
      let rules = null;
      if (!isObj(r)) errors.push('rules is missing');
      else {
        rules = { speed: toInt(own(r, 'speed'), 1, 5), lives: toInt(own(r, 'lives'), 1, 5), spawnRate: toInt(own(r, 'spawnRate'), 1, 5) };
        ['speed', 'lives', 'spawnRate'].forEach((k) => { if (rules[k] === null) errors.push('rules ' + k + ' must be a number'); });
      }
      const t = own(spec, 'texts');
      let texts = null;
      if (!isObj(t)) errors.push('texts is missing');
      else texts = { start: cleanStr(own(t, 'start'), 80, 'start text', errors, true), win: cleanStr(own(t, 'win'), 80, 'win text', errors, true), lose: cleanStr(own(t, 'lose'), 80, 'lose text', errors, true) };

      const out = { v: 1, template: template, title: title, hero: hero, goal: goal, items: items, world: world, rules: rules, texts: texts };

      if (template === 'quiz') {
        const q = own(spec, 'quiz'), qs = isObj(q) ? own(q, 'questions') : undefined;
        if (!Array.isArray(qs) || qs.length < 1 || qs.length > 6) errors.push('quiz needs 1 to 6 questions');
        else {
          const list = [];
          for (let i = 0; i < qs.length; i++) {
            const item = qs[i], text = cleanStr(own(item, 'q'), 80, 'question ' + (i + 1), errors, true);
            const opts = own(item, 'options'), ans = own(item, 'answer');
            const options = [];
            if (!Array.isArray(opts) || opts.length !== 3) errors.push('question ' + (i + 1) + ' needs exactly 3 options');
            else for (let k = 0; k < 3; k++) options.push(cleanStr(opts[k], 30, 'option ' + (i + 1) + '.' + (k + 1), errors, true));
            if (!(typeof ans === 'number' && Number.isInteger(ans) && ans >= 0 && ans <= 2)) errors.push('question ' + (i + 1) + ' answer must be 0, 1 or 2');
            list.push({ q: text, options: options, answer: ans });
          }
          out.quiz = { questions: list };
        }
      }
      const ask = own(spec, 'ask');
      if (ask !== undefined && ask !== null) { const a = cleanStr(ask, 80, 'ask', errors, false); if (a) out.ask = a; }
      const ni = own(spec, 'nextIdeas');
      if (ni !== undefined && ni !== null) {
        if (!Array.isArray(ni) || ni.length < 2 || ni.length > 3) errors.push('nextIdeas needs 2 or 3 ideas');
        else { const list = ni.map((x, i) => cleanStr(x, 30, 'idea ' + (i + 1), errors, true)); out.nextIdeas = list; }
      }
      if (errors.length) return { ok: false, spec: null, errors: errors };
      return { ok: true, spec: out, errors: [] };
    } catch (e) {
      return { ok: false, spec: null, errors: ['spec could not be read'] };
    }
  }

  // ---------- starter games ----------
  const spr = (palette, rows) => ({ palette: palette, rows: rows, by: 'starter' });
  const BLOB = spr(['#ffd23f', '#14202b', '#ff6b6b'], ['00000000', '01100110', '01100110', '00000000', '20000002', '02222220', '00000000', '00000000']);
  const ROCKET = spr(['#e8eef5', '#ff6b6b', '#14202b', '#ffd23f'], ['00011000', '00111100', '00122100', '00111100', '01111110', '01011010', '03000030', '00300300']);

  const STARTERS = {
    catcher: {
      v: 1, template: 'catcher', title: 'Star Basket', hero: { shape: 'circle', color: '#ffb703', name: 'Pip the Basket', sprite: BLOB },
      goal: { kind: 'score', target: 10 }, items: { good: { shape: 'star', color: '#ffe066', name: 'Falling star' }, bad: { shape: 'square', color: '#6b4bd6', name: 'Grumpy brick' } },
      world: { bg: '#10243f', theme: 'space' }, rules: { speed: 2, lives: 3, spawnRate: 3 },
      texts: { start: 'Slide Pip under the falling stars. Dodge the grumpy bricks!', win: 'Pip caught the whole sky!', lose: 'Bonk! The bricks won this time.' },
      ask: 'Should the bad guys be silly or sleepy?', nextIdeas: ['Make it glow in the dark', 'Add a rainbow boss']
    },
    runner: {
      v: 1, template: 'runner', title: 'Jelly Dash', hero: { shape: 'heart', color: '#ff5d8f', name: 'Jelly' },
      goal: { kind: 'survive', target: 20 }, items: { good: { shape: 'circle', color: '#ffd166', name: 'Gold bubble' }, bad: { shape: 'triangle', color: '#2ec4b6', name: 'Spiky coral' } },
      world: { bg: '#0b3d5c', theme: 'sea' }, rules: { speed: 2, lives: 3, spawnRate: 3 },
      texts: { start: 'Hop between the three streams. Dodge the coral!', win: 'Jelly zoomed all the way home!', lose: 'Ouch! Jelly got tangled in coral.' },
      ask: 'What sound does Jelly make when it zooms?', nextIdeas: ['Add a speedy shark', 'Make the sea sparkle']
    },
    maze: {
      v: 1, template: 'maze', title: 'Candy Maze', hero: { shape: 'star', color: '#ffb703', name: 'Sprinkle' },
      goal: { kind: 'reach', target: 12 }, items: { good: { shape: 'circle', color: '#ff8fab', name: 'Gumdrop' }, bad: { shape: 'square', color: '#7b2cbf', name: 'Sticky goo' } },
      world: { bg: '#3a1c4a', theme: 'candy' }, rules: { speed: 3, lives: 3, spawnRate: 2 },
      texts: { start: 'Find the glowing door. Gumdrops are bonus snacks!', win: 'Sprinkle found the way out!', lose: 'Stuck in the goo! Try a new path.' },
      ask: 'Where does the maze door lead?', nextIdeas: ['Make the walls bouncy', 'Hide a secret treat']
    },
    shooter: {
      v: 1, template: 'shooter', title: 'Space Bubbles', hero: { shape: 'triangle', color: '#8ecae6', name: 'Zippy', sprite: ROCKET },
      goal: { kind: 'score', target: 10 }, items: { good: { shape: 'heart', color: '#ff8fab', name: 'Friendly cloud' }, bad: { shape: 'circle', color: '#9d4edd', name: 'Grumble bubble' } },
      world: { bg: '#0d1b2a', theme: 'space' }, rules: { speed: 2, lives: 3, spawnRate: 3 },
      texts: { start: 'Pop the grumble bubbles. Keep the friendly clouds safe!', win: 'Zippy popped them all!', lose: 'The bubbles floated through!' },
      ask: 'What should happen when a bubble pops?', nextIdeas: ['Pops turn into confetti', 'Add a giant bubble']
    },
    quiz: {
      v: 1, template: 'quiz', title: 'Brainy Bugs', hero: { shape: 'circle', color: '#80ed99', name: 'Professor Bug' },
      goal: { kind: 'score', target: 3 }, items: { good: { shape: 'star', color: '#ffd166', name: 'Idea star' }, bad: { shape: 'square', color: '#e76f51', name: 'Fuzzy fib' } },
      world: { bg: '#1b4332', theme: 'forest' }, rules: { speed: 2, lives: 3, spawnRate: 2 },
      texts: { start: 'Pick the best answer. Wrong guesses cost a heart!', win: 'Professor Bug is amazed!', lose: 'Out of hearts. Try again, smarty!' },
      quiz: { questions: [
        { q: 'How many legs does a spider have?', options: ['6', '8', '10'], answer: 1 },
        { q: 'Which planet is called the red planet?', options: ['Mars', 'Venus', 'Earth'], answer: 0 },
        { q: 'What do bees make?', options: ['Milk', 'Honey', 'Bread'], answer: 1 },
        { q: 'Blue and yellow mixed make...', options: ['Green', 'Purple', 'Orange'], answer: 0 }] },
      ask: 'What silly question should Professor Bug ask?', nextIdeas: ['Add animal sounds', 'Make it about space']
    }
  };

  /** @param {string} template one of TEMPLATES @returns {Object} a fresh, valid, fun starter spec (falls back to catcher). */
  function defaultSpec(template) {
    const s = STARTERS[TEMPLATES.indexOf(template) >= 0 ? template : 'catcher'];
    return JSON.parse(JSON.stringify(s));
  }

  // ---------- seeded random (mulberry32); state lives in the game state so step stays pure ----------
  function rand(s) {
    s.rs = (s.rs + 0x6D2B79F5) >>> 0;
    let t = s.rs;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // ---------- tuning: speed / spawnRate / lives scale from rules ----------
  const fallSpeed = (r) => 14 + 8 * r.speed;                 // world units per second
  const spawnEvery = (r) => 1800 - (r.spawnRate - 1) * 300;  // ms between spawns
  const HERO_SPEED = 75, HERO_R = 6, ITEM_R = 4.5, LANE_Y = [26, 52, 78];

  // ---------- maze ----------
  /** Seeded perfect maze on an n x n cell grid, drawn as a (2n+1)^2 tile grid: 0 floor, 1 wall, 2 bad, 3 good. */
  function buildMaze(spec, s) {
    const n = 5 + Math.floor((spec.goal.target - 3) / 12), w = 2 * n + 1;
    const g = new Array(w * w).fill(1);
    const at = (c, r) => r * w + c;
    const stack = [[1, 1]]; g[at(1, 1)] = 0;
    while (stack.length) {
      const [c, r] = stack[stack.length - 1];
      const nb = [[2, 0], [-2, 0], [0, 2], [0, -2]].map((d) => [c + d[0], r + d[1], d]).filter((p) => p[0] > 0 && p[1] > 0 && p[0] < w - 1 && p[1] < w - 1 && g[at(p[0], p[1])] === 1);
      if (!nb.length) { stack.pop(); continue; }
      const p = nb[Math.floor(rand(s) * nb.length)];
      g[at(c + p[2][0] / 2, r + p[2][1] / 2)] = 0; g[at(p[0], p[1])] = 0;
      stack.push([p[0], p[1]]);
    }
    const bfs = (from) => {                                  // distance map over floor tiles
      const d = new Array(w * w).fill(-1); d[at(from[0], from[1])] = 0;
      const q = [from];
      for (let i = 0; i < q.length; i++) {
        const [c, r] = q[i];
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach((m) => { const x = c + m[0], y = r + m[1]; if (g[at(x, y)] === 0 && d[at(x, y)] < 0) { d[at(x, y)] = d[at(c, r)] + 1; q.push([x, y]); } });
      }
      return d;
    };
    const fromStart = bfs([1, 1]);
    let exit = [1, 1];
    for (let i = 0; i < g.length; i++) if (fromStart[i] > fromStart[at(exit[0], exit[1])]) exit = [i % w, Math.floor(i / w)];
    const dist = bfs(exit);                                  // distance to the door, for the progress bar
    // The route from start to door is kept free of goo, so a careful kid is never forced to lose a heart.
    const onPath = {};
    let cur = [1, 1];
    onPath[at(1, 1)] = true;
    while (dist[at(cur[0], cur[1])] > 0) {
      const m = [[1, 0], [-1, 0], [0, 1], [0, -1]].find((v) => dist[at(cur[0] + v[0], cur[1] + v[1])] === dist[at(cur[0], cur[1])] - 1);
      cur = [cur[0] + m[0], cur[1] + m[1]]; onPath[at(cur[0], cur[1])] = true;
    }
    const free = [];
    for (let i = 0; i < g.length; i++) if (g[i] === 0 && !onPath[i]) free.push(i);
    for (let i = free.length - 1; i > 0; i--) { const j = Math.floor(rand(s) * (i + 1)); const t = free[i]; free[i] = free[j]; free[j] = t; }
    const bads = Math.min(spec.rules.spawnRate + 1, free.length);
    for (let i = 0; i < bads; i++) g[free[i]] = 2;
    for (let i = bads; i < Math.min(bads + 3, free.length); i++) g[free[i]] = 3;
    return { w: w, tiles: g, exit: exit, dist: dist, startDist: dist[at(1, 1)] };
  }

  // ---------- create / step ----------
  /**
   * Make the initial game state. Invalid specs give status 'invalid' (nothing playable).
   * @param {Object} spec a spec (re-validated here) @param {number} seed any number
   * @returns {Object} state
   */
  function create(spec, seed) {
    const v = clientValidate(spec);
    const s0 = { rs: (Number.isFinite(seed) ? Math.floor(seed) : 1) >>> 0 };
    if (!v.ok) return { status: 'invalid', errors: v.errors, events: [], ents: [], bullets: [] };
    const sp = v.spec;
    const st = { v: 1, template: sp.template, spec: sp, status: 'playing', t: 0, score: 0, lives: sp.rules.lives, rs: s0.rs, progress: 0, events: [], ents: [], bullets: [], nextId: 1, spawnIn: 500, cd: 0, prev: 0, forceGood: true,
      hero: { x: W / 2, y: 90 }, msg: sp.texts.start };
    if (sp.template === 'runner') { st.hero = { x: 18, y: LANE_Y[1], lane: 1 }; }
    if (sp.template === 'shooter') { st.hero.y = 92; }
    if (sp.template === 'maze') { st.maze = buildMaze(sp, st); st.hero = { c: 1, r: 1 }; }
    if (sp.template === 'quiz') { st.q = { i: 0, fb: null }; }
    return st;
  }

  const clone = (st) => { const spec = st.spec, c = JSON.parse(JSON.stringify(Object.assign({}, st, { spec: null }))); c.spec = spec; return c; };
  const hits = (a, b, r) => (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) < r * r;
  const clampX = (x) => Math.max(HERO_R, Math.min(W - HERO_R, x));
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : d);

  /** Spawn timer: add falling/sliding items as `make(kind)` says. */
  function spawnTick(st, dt, make) {
    st.spawnIn -= dt;
    while (st.spawnIn <= 0) {
      const kind = st.forceGood ? 'good' : (rand(st) < 0.6 ? 'good' : 'bad');
      st.forceGood = false;
      const e = make(kind); e.id = st.nextId++; e.kind = kind;
      st.ents.push(e);
      st.spawnIn += spawnEvery(st.spec.rules);
    }
  }

  function loseLife(st, x, y) { st.lives -= 1; st.events.push({ type: 'bad', x: x, y: y }); }
  function gain(st, x, y) { st.score += 1; st.events.push({ type: 'good', x: x, y: y }); }

  /**
   * Advance the game by dtMs. Pure: returns a new state, never mutates the old one.
   * @param {Object} state from create/step
   * @param {{x?:number,y?:number,action?:boolean,pick?:number}} input held controls (pick is a one-shot 0..2)
   * @param {number} dtMs frame time in ms (clamped to 0..50)
   * @returns {Object} next state; status is 'playing' | 'won' | 'lost'
   */
  function step(state, input, dtMs) {
    if (!state || state.status !== 'playing') return state;
    const st = clone(state), sp = st.spec, rules = sp.rules, goal = sp.goal;
    const inp = isObj(input) ? input : {};
    const dt = Math.max(0, Math.min(MAX_DT, Number.isFinite(dtMs) ? dtMs : 0)), sec = dt / 1000;
    const ix = num(inp.x, 0), iy = num(inp.y, 0);
    st.events = []; st.t += dt;
    const fall = fallSpeed(rules);

    if (st.template === 'catcher') {
      st.hero.x = clampX(st.hero.x + ix * HERO_SPEED * sec);
      spawnTick(st, dt, (kind) => ({ x: 6 + rand(st) * 88, y: -5, vy: fall * (0.85 + 0.3 * rand(st)) }));
      st.ents = st.ents.filter((e) => {
        e.y += e.vy * sec;
        if (hits(e, st.hero, HERO_R + ITEM_R)) { if (e.kind === 'good') gain(st, e.x, e.y); else loseLife(st, e.x, e.y); return false; }
        return e.y < H + 8;
      });
    } else if (st.template === 'runner') {
      // Lane hops are edge-triggered: one press = one hop, so holding a key does not zoom to the edge.
      const dir = iy > 0.5 ? 1 : iy < -0.5 ? -1 : 0;
      if (dir !== 0 && dir !== st.prev) st.hero.lane = Math.max(0, Math.min(2, st.hero.lane + dir));
      st.prev = dir;
      const ty = LANE_Y[st.hero.lane], dy = ty - st.hero.y;
      st.hero.y += Math.sign(dy) * Math.min(Math.abs(dy), 320 * sec);
      spawnTick(st, dt, () => { const lane = Math.floor(rand(st) * 3); return { x: W + 6, y: LANE_Y[lane], vx: -fall * 1.1 }; });
      st.ents = st.ents.filter((e) => {
        e.x += e.vx * sec;
        if (hits(e, st.hero, HERO_R + ITEM_R)) { if (e.kind === 'good') gain(st, e.x, e.y); else loseLife(st, e.x, e.y); return false; }
        return e.x > -8;
      });
    } else if (st.template === 'shooter') {
      st.hero.x = clampX(st.hero.x + ix * HERO_SPEED * sec);
      st.cd = Math.max(0, st.cd - dt);
      if (inp.action === true && st.cd === 0) { st.bullets.push({ x: st.hero.x, y: st.hero.y - 8 }); st.cd = 260; st.events.push({ type: 'shoot', x: st.hero.x, y: st.hero.y }); }
      spawnTick(st, dt, () => ({ x: 6 + rand(st) * 88, y: -5, vy: fall * (0.7 + 0.25 * rand(st)) }));
      st.bullets.forEach((b) => { b.y -= 120 * sec; });
      st.bullets = st.bullets.filter((b) => b.y > -6);
      st.ents = st.ents.filter((e) => {
        e.y += e.vy * sec;
        const bi = st.bullets.findIndex((b) => hits(b, e, ITEM_R + 2.5));
        if (bi >= 0) {                              // popped by a bullet: bad = point, good = oops
          st.bullets.splice(bi, 1);
          if (e.kind === 'bad') gain(st, e.x, e.y); else loseLife(st, e.x, e.y);
          return false;
        }
        if (e.kind === 'bad' && hits(e, st.hero, HERO_R + ITEM_R)) { loseLife(st, e.x, e.y); return false; }
        if (e.y >= H) { if (e.kind === 'bad') loseLife(st, e.x, H - 4); return false; }   // a bad one slipped past
        return true;
      });
    } else if (st.template === 'maze') {
      stepMaze(st, ix, iy, dt);
    } else if (st.template === 'quiz') {
      stepQuiz(st, inp.pick, dt);
    }

    // progress, then win / lose. Lose is checked first so the result is never ambiguous.
    const need = st.template === 'quiz' ? Math.min(goal.target, sp.quiz.questions.length) : goal.target;
    if (st.template === 'maze') st.progress = st.maze.startDist ? 1 - st.maze.dist[st.hero.r * st.maze.w + st.hero.c] / st.maze.startDist : 1;
    else if (st.template === 'quiz') st.progress = Math.min(1, st.score / need);
    else if (goal.kind === 'score') st.progress = Math.min(1, st.score / need);
    else st.progress = Math.min(1, st.t / (goal.target * 1000));
    if (st.status === 'playing') {
      if (st.lives <= 0) { st.lives = 0; st.status = 'lost'; st.msg = sp.texts.lose; st.events.push({ type: 'lose' }); }
      else if (st.winNow || (st.template !== 'maze' && st.template !== 'quiz' && st.progress >= 1)) { st.status = 'won'; st.progress = 1; st.msg = sp.texts.win; st.events.push({ type: 'win' }); }
    }
    return st;
  }

  function stepMaze(st, ix, iy, dt) {
    const m = st.maze, spd = st.spec.rules.speed;
    st.cd = Math.max(0, st.cd - dt);
    if (st.cd > 0) return;
    // One tile per move; holding a direction repeats at a pace set by speed. Bigger axis wins on diagonals.
    let dc = 0, dr = 0;
    if (Math.abs(ix) >= Math.abs(iy)) { if (ix > 0.4) dc = 1; else if (ix < -0.4) dc = -1; } else if (iy > 0.4) dr = 1; else if (iy < -0.4) dr = -1;
    if (!dc && !dr) return;
    const c = st.hero.c + dc, r = st.hero.r + dr, k = r * m.w + c, tile = m.tiles[k];
    st.cd = 190 - spd * 20;
    if (tile === undefined || tile === 1) return;            // wall: stay put
    st.hero.c = c; st.hero.r = r;
    if (tile === 2) { m.tiles[k] = 0; loseLife(st, c, r); }
    else if (tile === 3) { m.tiles[k] = 0; gain(st, c, r); }
    if (c === m.exit[0] && r === m.exit[1] && st.lives > 0) st.winNow = true;
  }

  function stepQuiz(st, pick, dt) {
    const qs = st.spec.quiz.questions, q = st.q;
    if (q.fb) {                                              // showing right/wrong for a moment, then move on
      q.fb.ttl -= dt;
      if (q.fb.ttl <= 0) {
        q.fb = null; q.i += 1;
        const need = Math.min(st.spec.goal.target, qs.length);
        if (st.lives > 0 && (st.score >= need || q.i >= qs.length)) st.winNow = true;
      }
      return;
    }
    if (pick === 0 || pick === 1 || pick === 2) {
      const ok = qs[q.i].answer === pick;
      if (ok) gain(st, 0, 0); else loseLife(st, 0, 0);
      st.events.push({ type: ok ? 'right' : 'wrong' });
      q.fb = { pick: pick, ok: ok, answer: qs[q.i].answer, ttl: 900 };
    }
  }

  // ---------- describe / friendlyDiff ----------
  /** Nearest everyday colour word for a #rrggbb string (for the settings card). */
  function colorName(hex) {
    const n = parseInt(String(hex).slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 510, d = mx - mn;
    if (l < 0.15) return 'black'; if (l > 0.9) return 'white';
    if (d < 25) return l < 0.5 ? 'dark grey' : 'grey';
    let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    const names = [[15, 'red'], [40, 'orange'], [68, 'yellow'], [165, 'green'], [200, 'teal'], [255, 'blue'], [290, 'purple'], [335, 'pink'], [361, 'red']];
    const nm = names.find((x) => h < x[0])[1];
    return l > 0.7 ? 'light ' + nm : l < 0.3 ? 'dark ' + nm : nm;
  }

  const GOAL_TEXT = { score: 'Collect', survive: 'Survive', reach: 'Reach the finish' };
  const actorText = (a) => a.name + ' (' + colorName(a.color) + ' ' + a.shape + (a.sprite ? (a.sprite.by === 'kid' ? ', drawn by you' : a.sprite.by === 'starter' ? ', starter drawing' : ', AI-drawn') : '') + ')';

  /**
   * Kid-readable settings card: what the AI decided. Empty list if the spec is not valid.
   * @param {Object} spec @returns {{label:string,value:string,hint:string}[]}
   */
  function describe(spec) {
    const v = clientValidate(spec);
    if (!v.ok) return [];
    const s = v.spec, r = s.rules;
    const unit = { catcher: 'catches', runner: 'bubbles', shooter: 'pops', maze: 'tiles', quiz: 'right answers' }[s.template];
    let goalVal;
    if (s.template === 'maze') goalVal = 'Find the way out';
    else if (s.template === 'quiz') goalVal = 'Get ' + Math.min(s.goal.target, s.quiz.questions.length) + ' right';
    else if (s.goal.kind === 'score') goalVal = 'Get ' + s.goal.target + ' ' + unit;
    else goalVal = (s.goal.kind === 'survive' ? 'Survive ' : 'Keep going ') + s.goal.target + ' seconds';
    return [
      { label: 'Game', value: s.title + ' (' + s.template + ')', hint: 'The kind of game the AI picked.' },
      { label: 'Hero', value: actorText(s.hero), hint: 'You play as this one.' },
      { label: 'Goal', value: goalVal, hint: 'How you win. ' + (GOAL_TEXT[s.goal.kind] || '') },
      { label: 'Good stuff', value: actorText(s.items.good), hint: 'Grab these!' },
      { label: 'Bad stuff', value: actorText(s.items.bad), hint: 'These cost a life.' },
      { label: 'Speed', value: r.speed + ' of 5', hint: 'How fast things move.' },
      { label: 'Lives', value: String(r.lives), hint: 'How many oopses you get.' },
      { label: 'Spawn rate', value: r.spawnRate + ' of 5', hint: 'How often new things show up.' },
      { label: 'World', value: s.world.theme + ', ' + colorName(s.world.bg) + ' sky', hint: 'Where it all happens.' }
    ];
  }

  /**
   * What changed between two specs, in kid words ("Speed 2 -> 4"). [] if nothing changed or either is invalid.
   * @param {Object} a old spec @param {Object} b new spec @returns {string[]}
   */
  function friendlyDiff(a, b) {
    const va = clientValidate(a), vb = clientValidate(b);
    if (!va.ok || !vb.ok) return [];
    const da = describe(va.spec), db = describe(vb.spec), out = [];
    db.forEach((row, i) => { if (da[i].value !== row.value) out.push(row.label === 'Game' ? 'Game ' + da[i].value + ' -> ' + row.value : row.label + ' ' + da[i].value + ' -> ' + row.value); });
    const A = va.spec, B = vb.spec;
    if (JSON.stringify(A.texts) !== JSON.stringify(B.texts)) out.push('The story words changed');
    ['hero', 'good', 'bad'].forEach((k) => {
      const x = k === 'hero' ? A.hero : A.items[k], y = k === 'hero' ? B.hero : B.items[k];
      if (JSON.stringify(x.sprite || null) !== JSON.stringify(y.sprite || null)) out.push((k === 'hero' ? 'Hero' : k === 'good' ? 'Good stuff' : 'Bad stuff') + ' drawing changed');
    });
    if (A.template === 'quiz' && B.template === 'quiz' && JSON.stringify(A.quiz) !== JSON.stringify(B.quiz)) out.push('The questions changed');
    return out;
  }

  const api = { TEMPLATES, SHAPES, THEMES, W, H, LANE_Y, defaultSpec, clientValidate, create, step, describe, friendlyDiff, colorName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AIXEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
