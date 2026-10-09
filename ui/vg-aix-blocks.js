// Block Builder engine — pure (no DOM, no network, no storage) so it can be tested with node.
// A world is a 12x12 grid of columns, up to 6 blocks tall, written as plain strings (data, never code).
// Deterministic: same spec + seed + inputs = same game. Every public function is total (never throws).
(function (root) {
  const SIZE = 12, MAX_LAYERS = 6, ALPHABET = '.gdswlbaytcpj';
  const N = SIZE * SIZE;
  const ROW = /^[.gdswlbaytcpj]{12}$/;
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const DIR_NAME = { '1,0': 'e', '-1,0': 'w', '0,1': 's', '0,-1': 'n' };
  const MAX_PATH = 200;                   // BFS depth cap (the grid only has 144 cells, so this is a hard ceiling, not a tuning knob)
  const MAX_DT = 50;                      // ms; a long frame (tab switch) never teleports things
  const AIR_MS = 700, INV_MS = 1200;      // jelly hang time; grace period after a bump
  const EPS = 1e-9;

  const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
  const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
  const isCell = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < SIZE && y < SIZE;
  const fin = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

  const mat = (name, top, left, right, extra) => Object.freeze(Object.assign({ name: name, top: top, left: left, right: right, walkable: true, solid: true }, extra));
  const MATERIALS = Object.freeze({
    g: mat('Grass', '#8bd45b', '#8a5a36', '#74492b'),
    d: mat('Dirt', '#a9744a', '#8a5a36', '#74492b'),
    s: mat('Stone', '#b8c0c8', '#98a2ac', '#818b96'),
    w: mat('Wood', '#d9a066', '#b87a43', '#9c6535'),
    l: mat('Leaves', '#4fc46a', '#37a152', '#2b8a43'),
    b: mat('Brick', '#e5735f', '#c4513f', '#a64334'),
    a: mat('Water', '#5cc8f2', '#3fa9db', '#3396c7', { solid: false, slow: true }),
    y: mat('Sand', '#f6e3a1', '#e0c97f', '#cdb36a'),
    t: mat('Glass', '#d8f3fb', '#b9e4f2', '#a3d6e8', { see: true }),
    p: mat('Candy', '#ffb3d1', '#ff8fba', '#f275a6'),
    c: mat('Cloud', '#ffffff', '#e8eef7', '#d3dcea'),
    j: mat('Jelly', '#c58bff', '#a96ef0', '#9558dc', { bouncy: true })
  });

  // ---------- reading a (possibly hostile) build safely ----------
  /** Block char at (x, y, z), or '.' for air / anything unreadable. */
  function cellAt(layers, z, x, y) {
    const layer = layers[z];
    if (!Array.isArray(layer)) return '.';
    const row = layer[y];
    if (typeof row !== 'string') return '.';
    const ch = row.charAt(x);
    return ALPHABET.indexOf(ch) > 0 ? ch : '.';
  }

  /** Number of blocks in a column = (index of its highest non-air layer) + 1. */
  function colHeight(layers, x, y) {
    for (let z = Math.min(layers.length, MAX_LAYERS) - 1; z >= 0; z--) if (cellAt(layers, z, x, y) !== '.') return z + 1;
    return 0;
  }

  function hmap(layers) {
    const h = new Array(N);
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) h[y * SIZE + x] = colHeight(layers, x, y);
    return h;
  }

  const topChar = (layers, i) => { const h = colHeight(layers, i % SIZE, (i / SIZE) | 0); return h ? cellAt(layers, h - 1, i % SIZE, (i / SIZE) | 0) : '.'; };

  function heightAt(build, x, y) {
    try {
      const layers = own(build, 'layers');
      return Array.isArray(layers) && isCell(x, y) ? colHeight(layers, x, y) : 0;
    } catch (e) { return 0; }
  }

  function topMaterial(build, x, y) {
    try {
      const layers = own(build, 'layers'), h = Array.isArray(layers) && isCell(x, y) ? colHeight(layers, x, y) : 0;
      return h ? cellAt(layers, h - 1, x, y) : '.';
    } catch (e) { return '.'; }
  }

  // ---------- validation (identical rules to the server's gamespec._build) ----------
  /**
   * Strict check, never repairs: 1..6 layers, each exactly 12 strings of exactly 12 allowed chars,
   * at least one block, and at least one top that can be walked on and is not water.
   * @param {*} build anything @returns {{ok:boolean, build:{layers:string[][]}|null, errors:string[]}} fresh copy when ok
   */
  function validateBuild(build) {
    const errors = [];
    const fail = (m) => { if (errors.length < 10) errors.push(m); };
    try {
      const layers = own(build, 'layers');
      if (!Array.isArray(layers)) return { ok: false, build: null, errors: ['build needs a list of layers'] };
      if (layers.length < 1 || layers.length > MAX_LAYERS) return { ok: false, build: null, errors: ['build needs 1 to ' + MAX_LAYERS + ' layers'] };
      const clean = [];
      for (let z = 0; z < layers.length; z++) {
        const layer = layers[z];
        if (!Array.isArray(layer) || layer.length !== SIZE) { fail('layer ' + (z + 1) + ' needs exactly ' + SIZE + ' rows'); continue; }
        const rows = [];
        for (let y = 0; y < SIZE; y++) {
          const row = layer[y];
          if (typeof row !== 'string' || !ROW.test(row)) { fail('layer ' + (z + 1) + ' row ' + (y + 1) + ' must be exactly ' + SIZE + ' characters from ' + ALPHABET); continue; }
          rows.push(row);
        }
        clean.push(rows);
      }
      if (errors.length) return { ok: false, build: null, errors: errors };
      const h = hmap(clean);
      if (!h.some((v) => v > 0)) return { ok: false, build: null, errors: ['build needs at least one block'] };
      if (!h.some((v, i) => v > 0 && topChar(clean, i) !== 'a')) return { ok: false, build: null, errors: ['build needs somewhere dry to stand'] };
      return { ok: true, build: { layers: clean }, errors: [] };
    } catch (e) {
      return { ok: false, build: null, errors: ['build could not be read'] };
    }
  }

  // ---------- starter world: a little island with a pond, a tree, a cottage and a jelly pad ----------
  const STARTER = [
    ['............', '..dddddddd..', '.dddddddddd.', '.dddddddddd.', '.yyyydddddd.', '.yaaydddddd.', '.yaaydddddd.', '.yyyydddddd.', '.dddddddddd.', '..dddddddd..', '............', '............'],
    ['............', '..gggggggg..', '.gggggggggg.', '.gggggggggg.', '.....gggggg.', '.....gggggg.', '.....gggggg.', '.....gggggg.', '.gggggggggg.', '..gggggggg..', '............', '............'],
    ['............', '............', '...w........', '.........j..', '............', '............', '.......bbb..', '......wbtb..', '.......bbb..', '............', '............', '............'],
    ['............', '...l........', '..lwl.......', '...l........', '............', '............', '.......ppp..', '.......ppp..', '.......ppp..', '............', '............', '............'],
    ['............', '............', '...l........', '............', '............', '............', '.........b..', '............', '............', '............', '............', '............'],
    ['.........cc.', '..........c.', '............', '............', '............', '............', '............', '............', '............', '............', '.c..........', '............']
  ];

  /** @returns {{layers:string[][]}} a fresh, valid, pretty world (the caller may edit its copy). */
  function starterBuild() { return { layers: STARTER.map((l) => l.slice()) }; }

  // ---------- seeded random (mulberry32); state lives in the game state so step stays pure ----------
  function rand(s) {
    s.rs = (s.rs + 0x6D2B79F5) >>> 0;
    let t = s.rs;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function shuffle(a, s) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand(s) * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  // ---------- movement rules shared by the hero, the path planner and the reachability check ----------
  /**
   * Breadth-first search over columns. A step may go up at most 2 blocks (the hero jumps automatically) and down any
   * distance; empty columns are void. Bounded: 144 cells, path length capped at MAX_PATH.
   * @returns {{dist:number[], prev:number[]}} dist -1 = unreachable
   */
  function bfs(hm, from, goal) {
    const dist = new Array(N).fill(-1), prev = new Array(N).fill(-1), q = [from];
    dist[from] = 0;
    for (let i = 0; i < q.length; i++) {
      const c = q[i];
      if (c === goal || dist[c] >= MAX_PATH) { if (c === goal) break; continue; }
      const cx = c % SIZE, cy = (c / SIZE) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = cx + DIRS[k][0], ny = cy + DIRS[k][1];
        if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
        const n = ny * SIZE + nx;
        if (dist[n] < 0 && hm[n] > 0 && hm[n] - hm[c] <= 2) { dist[n] = dist[c] + 1; prev[n] = c; q.push(n); }
      }
    }
    return { dist: dist, prev: prev };
  }

  function planPath(hm, hero, x, y) {
    if (!isCell(x, y)) return [];
    const from = hero.y * SIZE + hero.x, to = y * SIZE + x;
    if (from === to || hm[to] === 0) return [];
    const r = bfs(hm, from, to);
    if (r.dist[to] < 0) return [];
    const path = [];
    for (let c = to; c !== from; c = r.prev[c]) path.push({ x: c % SIZE, y: (c / SIZE) | 0 });
    return path.reverse();
  }

  const moveCd = (rules) => 260 - 40 * rules.speed;          // ms between moves: speed 1 = 220, speed 5 = 60

  /** One grid move for the hero. Returns true when the hero actually moved. Mutates the (already cloned) state. */
  function moveHero(st, hm, dx, dy, jump) {
    const h = st.hero;
    if (h.cd > 0) return false;
    h.dir = DIR_NAME[dx + ',' + dy];
    const nx = h.x + dx, ny = h.y + dy;
    if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) return false;
    const to = ny * SIZE + nx, top = hm[to], rise = top - h.z;
    if (top === 0 || rise > (jump ? 2 : 1)) return false;
    h.x = nx; h.y = ny; h.z = top; h.air = 0;
    const m = MATERIALS[topChar(st.build.layers, to)];
    h.cd = moveCd(st.spec.rules) * (m.slow ? 2 : 1);
    st.events.push({ type: rise > 1 ? 'jump' : 'step', x: nx, y: ny, z: top });
    if (m.bouncy) { h.z = top + 2; h.air = AIR_MS; st.events.push({ type: 'bounce', x: nx, y: ny, z: top }); }
    return true;
  }

  // ---------- create ----------
  function engine() {
    if (typeof module !== 'undefined' && module.exports) { try { return require('./vg-aix-engine.js'); } catch (e) { return null; } }
    return root.AIXEngine || null;
  }

  const invalid = (errors) => ({ status: 'invalid', errors: errors, events: [], items: [], critters: [], path: [] });

  /**
   * Make the initial game state. Items, flag and critters only ever go on cells the hero can really reach.
   * @param {Object} spec a blocks spec (re-validated here) @param {number} seed any number
   * @returns {Object} state (status 'invalid' when nothing is playable)
   */
  function create(spec, seed) {
    try {
      const E = engine(), v = E ? E.clientValidate(spec) : { ok: false, errors: ['engine not loaded'] };
      if (!v.ok || v.spec.template !== 'blocks') return invalid(v.ok ? ['template is not blocks'] : v.errors);
      const sp = v.spec, layers = sp.build.layers, hm = hmap(layers);
      const s = { rs: (Number.isFinite(seed) ? Math.floor(seed) : 1) >>> 0 };

      // Start: near the middle, on dry non-jelly ground, in whichever of the closest few spots opens up the most world.
      const byCentre = (a, b) => { const da = Math.pow(a % SIZE - 5.5, 2) + Math.pow(((a / SIZE) | 0) - 5.5, 2), db = Math.pow(b % SIZE - 5.5, 2) + Math.pow(((b / SIZE) | 0) - 5.5, 2); return da - db || a - b; };
      const land = [];
      for (let i = 0; i < N; i++) if (hm[i] > 0) land.push(i);
      land.sort(byCentre);
      let cands = land.filter((i) => { const c = topChar(layers, i); return c !== 'a' && c !== 'j'; });
      if (!cands.length) cands = land;
      let start = cands[0], bestSize = -1, reach = null;
      cands.slice(0, 10).forEach((i) => {
        const r = bfs(hm, i, -1), size = r.dist.filter((d) => d >= 0).length;
        if (size > bestSize) { bestSize = size; start = i; reach = r; }
      });

      // Everything else goes on reachable cells; dry ones first so loot is not all in the pond.
      const free = [];
      for (let i = 0; i < N; i++) if (reach.dist[i] >= 0 && i !== start) free.push(i);
      const dry = shuffle(free.filter((i) => topChar(layers, i) !== 'a'), s), wet = shuffle(free.filter((i) => topChar(layers, i) === 'a'), s);
      const pool = dry.concat(wet);
      const st = { v: 1, template: 'blocks', spec: sp, status: 'playing', t: 0, score: 0, lives: sp.rules.lives, progress: 0, events: [], msg: sp.texts.start,
        build: sp.build, hero: { x: start % SIZE, y: (start / SIZE) | 0, z: hm[start], dir: 's', cd: 0, inv: 0, air: 0, hop: 0 },
        items: [], critters: [], path: [], reach: [], need: 0, far: 1, nextId: 1, rs: s.rs };
      const place = (i, kind, list) => list.push({ id: st.nextId++, x: i % SIZE, y: (i / SIZE) | 0, z: hm[i], kind: kind });

      if (sp.goal.kind === 'reach') {
        let flag = start;                                    // a one-cell island: the flag sits under the hero's feet
        pool.forEach((i) => { if (flag === start || hm[i] > hm[flag]) flag = i; });
        if (pool.length) pool.splice(pool.indexOf(flag), 1);
        place(flag, 'flag', st.items);
        st.far = Math.max(1, Math.abs(flag % SIZE - st.hero.x) + Math.abs(((flag / SIZE) | 0) - st.hero.y));
      }
      const goods = Math.min(sp.goal.kind === 'score' ? sp.goal.target : 3, pool.length);
      pool.splice(0, goods).forEach((i) => place(i, 'good', st.items));
      if (sp.goal.kind === 'score') st.need = goods;

      const dist = (i) => Math.abs(i % SIZE - st.hero.x) + Math.abs(((i / SIZE) | 0) - st.hero.y);
      const spots = pool.filter((i) => dist(i) >= 4).concat(pool.filter((i) => dist(i) < 4));
      spots.slice(0, sp.rules.spawnRate).forEach((i) => { place(i, 'critter', st.critters); const c = st.critters[st.critters.length - 1]; delete c.kind; c.cd = 600 + Math.floor(rand(s) * 600); });
      st.rs = s.rs;
      for (let i = 0; i < N; i++) if (reach.dist[i] >= 0) st.reach.push(i);
      return st;
    } catch (e) {
      return invalid(['world could not be created']);
    }
  }

  // ---------- step ----------
  const cloneState = (st) => { const c = JSON.parse(JSON.stringify(Object.assign({}, st, { spec: null, build: null }))); c.spec = st.spec; c.build = st.build; return c; };
  const axis = (v) => { const n = fin(v, 0); return n; };

  function wander(st, hm, c) {
    const start = Math.floor(rand(st) * 4);
    for (let k = 0; k < 4; k++) {
      const d = DIRS[(start + k) % 4], nx = c.x + d[0], ny = c.y + d[1];
      if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
      const to = ny * SIZE + nx, from = c.y * SIZE + c.x;
      if (hm[to] === 0 || Math.abs(hm[to] - hm[from]) > 1 || st.critters.some((o) => o !== c && o.x === nx && o.y === ny)) continue;
      c.x = nx; c.y = ny; c.z = hm[to];
      break;
    }
    c.cd = 700 + Math.floor(rand(st) * 500);
  }

  /**
   * Advance the game by dtMs. Pure: returns a new state, never mutates the old one.
   * @param {Object} state from create/step
   * @param {{dx?:number,dy?:number,jump?:boolean,goTo?:{x:number,y:number}}} input held controls; any dx/dy cancels a goTo walk
   * @param {number} dtMs frame time in ms (clamped to 0..50)
   * @returns {Object} next state; status is 'playing' | 'won' | 'lost'
   */
  function step(state, input, dtMs) {
    try {
      if (!state || state.status !== 'playing') return state;
      const st = cloneState(state), sp = st.spec, goal = sp.goal, hero = st.hero;
      const inp = isObj(input) ? input : {};
      const dt = Math.max(0, Math.min(MAX_DT, fin(dtMs, 0)));
      const hm = hmap(st.build.layers);
      st.events = []; st.t += dt;
      hero.cd = Math.max(0, hero.cd - dt); hero.inv = Math.max(0, hero.inv - dt); hero.hop = Math.max(0, hero.hop - dt);
      hero.air = Math.max(0, hero.air - dt);
      if (hero.air === 0) hero.z = hm[hero.y * SIZE + hero.x];

      const goTo = own(inp, 'goTo');
      if (goTo !== undefined) st.path = planPath(hm, hero, own(goTo, 'x'), own(goTo, 'y'));
      const ax = axis(own(inp, 'dx')), ay = axis(own(inp, 'dy')), jump = own(inp, 'jump') === true;
      let dx = 0, dy = 0;                                    // one axis at a time; the bigger input wins
      if (Math.abs(ax) >= Math.abs(ay)) { if (Math.abs(ax) >= 0.4) dx = Math.sign(ax); } else if (Math.abs(ay) >= 0.4) dy = Math.sign(ay);

      if (dx || dy) { st.path = []; moveHero(st, hm, dx, dy, jump); }
      else if (st.path.length) {
        if (hero.cd === 0) {
          const n = st.path[0], ddx = n.x - hero.x, ddy = n.y - hero.y;
          if (Math.abs(ddx) + Math.abs(ddy) === 1 && moveHero(st, hm, ddx, ddy, true)) st.path.shift(); else st.path = [];
        }
      } else if (jump && hero.hop === 0) { hero.hop = 300; st.events.push({ type: 'jump', x: hero.x, y: hero.y, z: hero.z }); }

      // Critters wander one cell at a time; they stay on gentle slopes.
      st.critters.forEach((c) => { c.cd -= dt; if (c.cd <= 0) wander(st, hm, c); });

      // Pick-ups.
      let winNow = false;
      st.items = st.items.filter((it) => {
        if (it.x !== hero.x || it.y !== hero.y) return true;
        if (it.kind === 'flag') winNow = true; else { st.score += 1; st.events.push({ type: 'good', x: it.x, y: it.y, z: it.z }); }
        return it.kind === 'flag';
      });

      // Bumps: one life, then a short grace period, and the critter hops off to somewhere else.
      if (hero.inv === 0) {
        const hit = st.critters.find((c) => c.x === hero.x && c.y === hero.y);
        if (hit) {
          st.lives -= 1; hero.inv = INV_MS; st.events.push({ type: 'bad', x: hit.x, y: hit.y, z: hit.z });
          const far = st.reach.filter((i) => hm[i] > 0 && Math.abs(i % SIZE - hero.x) + Math.abs(((i / SIZE) | 0) - hero.y) >= 4);
          if (far.length) { const i = far[Math.floor(rand(st) * far.length)]; hit.x = i % SIZE; hit.y = (i / SIZE) | 0; hit.z = hm[i]; }
        }
      }

      // Progress, then win / lose. Lose is checked first so the result is never ambiguous.
      const flag = st.items.find((it) => it.kind === 'flag');
      if (goal.kind === 'score') st.progress = st.need ? Math.min(1, st.score / st.need) : 1;
      else if (goal.kind === 'reach') st.progress = flag ? Math.max(0, Math.min(1, 1 - (Math.abs(flag.x - hero.x) + Math.abs(flag.y - hero.y)) / st.far)) : 1;
      else st.progress = Math.min(1, st.t / (goal.target * 1000));
      const won = goal.kind === 'score' ? st.score >= st.need : goal.kind === 'reach' ? winNow : st.t >= goal.target * 1000;
      if (st.lives <= 0) { st.lives = 0; st.status = 'lost'; st.msg = sp.texts.lose; st.events.push({ type: 'lose' }); }
      else if (won) { st.status = 'won'; st.progress = 1; st.msg = sp.texts.win; st.events.push({ type: 'win' }); }
      return st;
    } catch (e) {
      return state;
    }
  }

  // ---------- edit (build mode) ----------
  function setCell(layers, z, x, y, ch) {
    const out = layers.map((l) => l.slice());
    while (out.length <= z) out.push(new Array(SIZE).fill('.'.repeat(SIZE)));
    const row = out[z][y];
    out[z][y] = row.slice(0, x) + ch + row.slice(x + 1);
    return out;
  }

  const trimEmpty = (layers) => { const out = layers.slice(); while (out.length > 1 && out[out.length - 1].every((r) => /^\.+$/.test(r))) out.pop(); return out; };

  /**
   * Place a block on top of a column or remove its top block. Never throws; on any refusal the state is returned untouched.
   * @param {Object} state @param {{op:'place'|'remove',x:number,y:number,mat?:string}} cmd
   * @returns {{state:Object, ok:boolean, reason?:string}}
   */
  function edit(state, cmd) {
    const no = (reason) => ({ state: state, ok: false, reason: reason });
    try {
      if (!isObj(state) || state.status === 'invalid' || !isObj(state.build) || !isObj(state.hero) || !isObj(cmd)) return no('bad-input');
      const layers = own(state.build, 'layers'), op = own(cmd, 'op'), x = own(cmd, 'x'), y = own(cmd, 'y');
      if (!Array.isArray(layers)) return no('bad-input');
      if (op !== 'place' && op !== 'remove') return no('bad-op');
      if (!isCell(x, y)) return no('out-of-range');
      if (state.hero.x === x && state.hero.y === y) return no('hero-here');
      const h = colHeight(layers, x, y);
      let next, z;
      if (op === 'place') {
        const m = own(cmd, 'mat');
        if (typeof m !== 'string' || m.length !== 1 || ALPHABET.indexOf(m) < 1) return no('bad-material');
        if (h >= MAX_LAYERS) return no('full');
        z = h; next = setCell(layers, z, x, y, m);
      } else {
        if (h === 0) return no('empty');
        if (layers.reduce((n, l) => n + l.join('').replace(/\./g, '').length, 0) <= 1) return no('last-block');
        z = h - 1; next = setCell(layers, z, x, y, '.');
        const onIt = (a) => Array.isArray(a) && a.some((o) => o.x === x && o.y === y);
        if (colHeight(next, x, y) === 0 && (onIt(state.items) || onIt(state.critters))) return no('occupied');
      }
      const v = validateBuild({ layers: trimEmpty(next) });
      if (!v.ok) return no('needs-land');                    // e.g. would leave only water to stand on
      const st = cloneState(state), nh = colHeight(v.build.layers, x, y);
      st.build = v.build; st.path = [];
      [st.items, st.critters].forEach((a) => { if (Array.isArray(a)) a.forEach((o) => { if (o.x === x && o.y === y) o.z = nh; }); });
      st.events = [{ type: op, x: x, y: y, z: z }];
      return { state: st, ok: true };
    } catch (e) {
      return no('bad-input');
    }
  }

  /** @returns {Object|null} a copy of the spec carrying the current (validated) build, or null when it is not valid. */
  function toSpec(state) {
    try {
      if (!isObj(state) || !isObj(state.spec) || state.status === 'invalid') return null;
      const v = validateBuild(state.build);
      if (!v.ok) return null;
      const copy = JSON.parse(JSON.stringify(Object.assign({}, state.spec, { build: null })));
      copy.build = v.build;
      return copy;
    } catch (e) { return null; }
  }

  // ---------- drawing helpers (classic 2:1 isometric) ----------
  // project() returns the centre of the cube's hexagonal outline: its top face is a diamond tile wide, tile/2 tall.
  const viewOf = (view) => ({ t: fin(own(view, 'tile'), 0), ox: fin(own(view, 'ox'), NaN), oy: fin(own(view, 'oy'), NaN) });

  /** @returns {{sx:number, sy:number}} screen centre of the block at grid (x, y, z). */
  function project(x, y, z, view) {
    try {
      const v = viewOf(view), t = v.t > 0 ? v.t : 64, ox = Number.isNaN(v.ox) ? 0 : v.ox, oy = Number.isNaN(v.oy) ? 0 : v.oy;
      const gx = fin(x, 0), gy = fin(y, 0), gz = fin(z, 0);
      return { sx: ox + (gx - gy) * t / 2, sy: oy + (gx + gy) * t / 4 - gz * t / 2 };
    } catch (e) { return { sx: 0, sy: 0 }; }
  }

  /**
   * Which block is under a pixel? Front-most wins (larger x+y+z hides smaller), which matches back-to-front painting.
   * @returns {{x:number,y:number,z:number,face:'top'|'left'|'right'}|null}
   */
  function pick(sx, sy, build, view) {
    try {
      const v = viewOf(view), t = v.t;
      if (!(t > 0) || Number.isNaN(v.ox) || Number.isNaN(v.oy) || !Number.isFinite(sx) || !Number.isFinite(sy) || typeof sx !== 'number' || typeof sy !== 'number') return null;
      const layers = own(build, 'layers');
      if (!Array.isArray(layers)) return null;
      let best = null, bestKey = -1;
      for (let z = 0; z < Math.min(layers.length, MAX_LAYERS); z++) for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
        if (cellAt(layers, z, x, y) === '.') continue;
        const dx = sx - (v.ox + (x - y) * t / 2), dy = sy - (v.oy + (x + y) * t / 4 - z * t / 2);
        if (Math.abs(dx) > t / 2 + EPS || Math.abs(dy) > t / 2 - Math.abs(dx) / 2 + EPS) continue;
        const key = x + y + z;
        if (key > bestKey || (key === bestKey && z > best.z)) {
          bestKey = key;
          best = { x: x, y: y, z: z, face: dy <= -Math.abs(dx) / 2 + EPS ? 'top' : dx < 0 ? 'left' : 'right' };
        }
      }
      return best;
    } catch (e) { return null; }
  }

  /** @returns {string} one accessible sentence about the world, e.g. for an aria-label. */
  function describe(spec) {
    try {
      const v = validateBuild(own(spec, 'build'));
      if (!v.ok) return 'An empty block world.';
      const counts = {};
      let total = 0;
      v.build.layers.forEach((l) => l.forEach((r) => { for (let i = 0; i < SIZE; i++) if (r[i] !== '.') { counts[r[i]] = (counts[r[i]] || 0) + 1; total++; } }));
      const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || (a < b ? -1 : 1)).slice(0, 3).map((k) => counts[k] + ' ' + MATERIALS[k].name.toLowerCase());
      return 'A block world with ' + total + ' blocks, mostly ' + top.join(', ') + ', up to ' + v.build.layers.length + ' blocks tall.';
    } catch (e) { return 'An empty block world.'; }
  }

  const api = { SIZE, MAX_LAYERS, ALPHABET, MATERIALS, hasBlocks: true, validateBuild, starterBuild, heightAt, topMaterial, create, step, edit, toSpec, project, pick, describe };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AIXBlocks = api;
})(typeof window !== 'undefined' ? window : globalThis);
