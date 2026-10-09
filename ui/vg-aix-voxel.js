// Block Builder 3D world — pure (no DOM, no three.js, no network, no storage) so it can be tested with node.
// A 48x48x24 voxel world is generated around the kid's 12x12 building plot. Deterministic (seeded hashing, no clock,
// no ambient randomness) and total: every public function returns a safe value instead of throwing.
//
// Coordinates: WORLD space is x east, y "depth", z UP; a cell (i,j,k) occupies [i,i+1) x [j,j+1) x [k,k+1).
// buildChunkGeometry() alone emits RENDER space (Y up): renderX = x, renderY = z, renderZ = y.
(function (root) {
  const WX = 48, WY = 48, WZ = 24, N = WX * WY * WZ;
  const PLOT = Object.freeze({ x0: 18, y0: 18, size: 12, base: 8 });
  const SEA = 6;                          // water fills every empty cell below this z
  const CHUNK = 16;
  const MAX_ID = 19;
  const ALPHABET = '.gdswlbaytcpj';      // same order as AIXBlocks.ALPHABET: a plot char's index is its block id
  const TAU = Math.PI * 2;

  // ---------- block table ----------
  // Tile indexes into the 16x16 atlas (row-major, row 0 at the top of the canvas).
  const TILES = Object.freeze(['grassTop', 'grassSide', 'dirt', 'stone', 'planks', 'leaves', 'brick', 'water', 'sand', 'glass', 'cloud',
    'candy', 'jelly', 'snow', 'cactusSide', 'cactusTop', 'trunkSide', 'trunkTop', 'flowerRed', 'flowerYellow', 'tallGrass', 'cobble']);
  const T = {}; TILES.forEach((n, i) => { T[n] = i; });
  const blk = (char, name, solid, see, top, side, bottom, extra) => Object.freeze(Object.assign({ char: char, name: name, solid: solid, see: see, top: top, side: side, bottom: bottom }, extra));
  const BLOCKS = Object.freeze([
    blk('.', 'Air', false, true, 0, 0, 0),
    blk('g', 'Grass', true, false, T.grassTop, T.grassSide, T.dirt),
    blk('d', 'Dirt', true, false, T.dirt, T.dirt, T.dirt),
    blk('s', 'Stone', true, false, T.stone, T.stone, T.stone),
    blk('w', 'Wood', true, false, T.planks, T.planks, T.planks),
    blk('l', 'Leaves', true, true, T.leaves, T.leaves, T.leaves),
    blk('b', 'Brick', true, false, T.brick, T.brick, T.brick),
    blk('a', 'Water', false, true, T.water, T.water, T.water, { liquid: true }),
    blk('y', 'Sand', true, false, T.sand, T.sand, T.sand),
    blk('t', 'Glass', true, true, T.glass, T.glass, T.glass),
    blk('c', 'Cloud', true, false, T.cloud, T.cloud, T.cloud),
    blk('p', 'Candy', true, false, T.candy, T.candy, T.candy),
    blk('j', 'Jelly', true, false, T.jelly, T.jelly, T.jelly, { bouncy: true }),
    blk('', 'Snow', true, false, T.snow, T.snow, T.snow),
    blk('', 'Cactus', true, false, T.cactusTop, T.cactusSide, T.cactusTop),
    blk('', 'Trunk', true, false, T.trunkTop, T.trunkSide, T.trunkTop),
    blk('', 'Red flower', false, true, T.flowerRed, T.flowerRed, T.flowerRed, { plant: true }),
    blk('', 'Yellow flower', false, true, T.flowerYellow, T.flowerYellow, T.flowerYellow, { plant: true }),
    blk('', 'Tall grass', false, true, T.tallGrass, T.tallGrass, T.tallGrass, { plant: true }),
    blk('', 'Cobble', true, false, T.cobble, T.cobble, T.cobble)
  ]);
  const ID = Object.freeze({ air: 0, grass: 1, dirt: 2, stone: 3, wood: 4, leaves: 5, brick: 6, water: 7, sand: 8, glass: 9, cloud: 10, candy: 11, jelly: 12,
    snow: 13, cactus: 14, trunk: 15, flowerRed: 16, flowerYellow: 17, tallGrass: 18, cobble: 19 });
  const SOLID = new Uint8Array(32), SEE = new Uint8Array(32), OPQ = new Uint8Array(32), PLANT = new Uint8Array(32);
  BLOCKS.forEach((b, i) => { SOLID[i] = b.solid ? 1 : 0; SEE[i] = b.see ? 1 : 0; OPQ[i] = b.solid && !b.see ? 1 : 0; PLANT[i] = b.plant ? 1 : 0; });
  const PLACEABLE = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  // Terrain-only blocks a kid can somehow place still save as the closest plot material (plants vanish).
  const ID2CHAR = ['.', 'g', 'd', 's', 'w', 'l', 'b', 'a', 'y', 't', 'c', 'p', 'j', 'c', 'l', 'w', '.', '.', '.', 's'];

  // ---------- small helpers ----------
  const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
  const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
  const fin = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const lerp = (a, b, t) => a + (b - a) * t;
  const ix = (x, y, z) => (z * WY + y) * WX + x;
  const inRange = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < WX && y < WY && z < WZ;
  const inPlotXY = (x, y) => x >= PLOT.x0 && y >= PLOT.y0 && x < PLOT.x0 + PLOT.size && y < PLOT.y0 + PLOT.size;
  const validWorld = (w) => isObj(w) && w.data instanceof Uint8Array && w.data.length === N;

  /** Cell lookup with a plain array index; callers must have range-checked. */
  const at = (d, x, y, z) => d[(z * WY + y) * WX + x];

  /** Integer hash -> [0,1). Pure function of the lattice point and a salt, so decoration never depends on call order. */
  function hash2(x, y, salt) {
    let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  /** Smoothly interpolated lattice noise in [0,1]. */
  function vnoise(x, y, salt) {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const a = hash2(x0, y0, salt), b = hash2(x0 + 1, y0, salt), c = hash2(x0, y0 + 1, salt), d = hash2(x0 + 1, y0 + 1, salt);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  }

  /** mulberry32 as a closure over its own state. */
  function rng(seed) {
    let s = (Number.isFinite(seed) ? Math.floor(seed) : 1) >>> 0;
    return () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function blocksMod() {
    if (typeof module !== 'undefined' && module.exports) { try { return require('./vg-aix-blocks.js'); } catch (e) { return null; } }
    return root.AIXBlocks || null;
  }

  // ---------- terrain generation ----------
  const TERRAINS = ['meadow', 'desert', 'snow', 'island', 'candy'];
  // surface / filler / beach block per terrain (beach = used at or below sea level + 1)
  const SURF = {
    meadow: { top: ID.grass, sub: ID.dirt, beach: ID.sand },
    desert: { top: ID.sand, sub: ID.sand, beach: ID.sand },
    snow: { top: ID.snow, sub: ID.dirt, beach: ID.sand },
    island: { top: ID.grass, sub: ID.dirt, beach: ID.sand },
    candy: { top: ID.candy, sub: ID.cloud, beach: ID.cloud }
  };

  /** Raw hill height before plot blending: layered value noise, per-terrain character. */
  function rawHeight(x, y, terrain, seed) {
    const s = seed * 7919;
    const n = 0.55 * vnoise(x / 22, y / 22, s + 1) + 0.3 * vnoise(x / 10, y / 10, s + 2) + 0.15 * vnoise(x / 4.5, y / 4.5, s + 3);
    const t = clamp((n - 0.2) / 0.6, 0, 1);
    // Separate low-frequency noise carves lakes below sea level (rare oases in the desert).
    const lake = smooth(terrain === 'desert' ? 0.22 : 0.36, terrain === 'desert' ? 0.12 : 0.2, vnoise(x / 13, y / 13, s + 4));
    if (terrain === 'desert') return lerp(5.2 + t * 6.5, 3, lake);   // rolling dunes
    if (terrain === 'snow') return lerp(5 + t * 9.5, 3, lake);
    if (terrain === 'candy') return lerp(5 + t * 7.5, 3, lake);
    if (terrain === 'island') {
      const r = Math.hypot(x + 0.5 - WX / 2, y + 0.5 - WY / 2);
      return lerp(1.8, 4 + t * 10, 1 - smooth(13, 21, r));  // land fades into a ring of sea
    }
    return lerp(4 + t * 10, 3, lake);
  }

  function buildHeights(terrain, seed) {
    const h = new Float32Array(WX * WY);
    for (let y = 0; y < WY; y++) for (let x = 0; x < WX; x++) {
      const dx = Math.max(PLOT.x0 - x, 0, x - (PLOT.x0 + PLOT.size - 1)), dy = Math.max(PLOT.y0 - y, 0, y - (PLOT.y0 + PLOT.size - 1));
      const w = smooth(0, 10, Math.hypot(dx, dy));           // 0 on the plot, 1 ten blocks away: the plot melts into the hills
      h[y * WX + x] = lerp(PLOT.base - 1, rawHeight(x, y, terrain, seed), w);
    }
    const r = new Int8Array(WX * WY);
    for (let i = 0; i < r.length; i++) r[i] = Math.round(h[i]);
    // Two chamfer sweeps cap every step between neighbours at 1 block, so the kid can walk (jump) up any slope.
    const fixed = (x, y) => inPlotXY(x, y);
    for (let y = 0; y < WY; y++) for (let x = 0; x < WX; x++) {
      if (fixed(x, y)) { r[y * WX + x] = PLOT.base - 1; continue; }
      let v = r[y * WX + x];
      if (x > 0) v = Math.min(v, r[y * WX + x - 1] + 1);
      if (y > 0) v = Math.min(v, r[(y - 1) * WX + x] + 1);
      r[y * WX + x] = v;
    }
    for (let y = WY - 1; y >= 0; y--) for (let x = WX - 1; x >= 0; x--) {
      if (fixed(x, y)) continue;
      let v = r[y * WX + x];
      if (x < WX - 1) v = Math.min(v, r[y * WX + x + 1] + 1);
      if (y < WY - 1) v = Math.min(v, r[(y + 1) * WX + x] + 1);
      r[y * WX + x] = v;
    }
    for (let i = 0; i < r.length; i++) r[i] = clamp(r[i], 1, 17);
    return r;
  }

  const put = (d, x, y, z, id, airOnly) => {
    if (!inRange(x, y, z)) return;
    const i = ix(x, y, z);
    if (!airOnly || d[i] === 0) d[i] = id;
  };

  function growTree(d, x, y, top, terrain, r) {
    if (terrain === 'candy') {                               // lollipop tree: short stick, round candy ball
      for (let k = 1; k <= 2; k++) put(d, x, y, top + k, ID.trunk, false);
      for (let dz = 0; dz <= 2; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) put(d, x + dx, y + dy, top + 2 + dz, ID.candy, true);
      return;
    }
    const th = 3 + Math.floor(r() * 2), t = top + th;
    for (let k = 1; k <= th; k++) put(d, x, y, top + k, ID.trunk, false);
    for (let dz = -1; dz <= 2; dz++) {
      const rad = dz <= 0 ? 2 : 1;
      for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
        if (dz === 2 && (dx || dy)) continue;
        if (Math.abs(dx) === rad && Math.abs(dy) === rad && (rad === 1 || r() < 0.5)) continue;   // ragged corners
        put(d, x + dx, y + dy, t + dz, dz === 2 && terrain === 'snow' ? ID.snow : ID.leaves, true);
      }
    }
  }

  /** Scatter trees / cacti / flowers; every roll is a pure hash of the cell so the world is order independent. */
  function decorate(d, hs, terrain, seed) {
    const trees = new Uint8Array(WX * WY), s = seed * 31;
    const nearPlot = (x, y, m) => x >= PLOT.x0 - m && y >= PLOT.y0 - m && x < PLOT.x0 + PLOT.size + m && y < PLOT.y0 + PLOT.size + m;
    for (let y = 0; y < WY; y++) for (let x = 0; x < WX; x++) {
      const h = hs[y * WX + x], top = at(d, x, y, h);
      if (h < SEA + 1 || h + 7 >= WZ || at(d, x, y, h + 1) !== 0) continue;
      const edge = x < 3 || y < 3 || x >= WX - 3 || y >= WY - 3;
      const roll = hash2(x, y, s + 11);
      if (terrain === 'desert') {
        if (!edge && !nearPlot(x, y, 2) && top === ID.sand && roll < 0.014 && !trees[y * WX + x]) {
          const ch = 1 + Math.floor(hash2(x, y, s + 12) * 3);
          for (let k = 1; k <= ch; k++) put(d, x, y, h + k, ID.cactus, false);
          trees[y * WX + x] = 1;
        }
        continue;
      }
      if (top !== SURF[terrain].top) continue;
      const fn = smooth(0.45, 0.8, vnoise(x / 11, y / 11, s + 13));
      const p = (0.01 + 0.075 * fn) * (terrain === 'candy' ? 0.6 : terrain === 'snow' ? 0.7 : 1);
      let blocked = edge || nearPlot(x, y, 3);
      for (let dy = -3; dy <= 3 && !blocked; dy++) for (let dx = -3; dx <= 3; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < WX && ny < WY && trees[ny * WX + nx]) { blocked = true; break; }
      }
      if (!blocked && roll < p) {
        growTree(d, x, y, h, terrain, rng(Math.floor(hash2(x, y, s + 14) * 4294967296)));
        trees[y * WX + x] = 1;
        continue;
      }
      if (nearPlot(x, y, 1) || terrain === 'snow') continue;
      const pf = smooth(0.55, 0.8, vnoise(x / 6, y / 6, s + 15)), r2 = hash2(x, y, s + 16);
      if (terrain !== 'candy' && r2 < 0.1) put(d, x, y, h + 1, ID.tallGrass, true);
      else if (r2 < 0.1 + 0.015 + 0.1 * pf) put(d, x, y, h + 1, hash2(x, y, s + 17) < 0.5 ? ID.flowerRed : ID.flowerYellow, true);
    }
  }

  /**
   * Make a world: terrain from spec.world.seed/terrain, a levelled plot with spec.build copied in.
   * Invalid or missing pieces fall back to seed 1, meadow and the starter build; never throws.
   * @param {Object} spec a blocks spec (anything is tolerated) @returns {{v:1,data:Uint8Array,seed:number,terrain:string,plotDirty:boolean}}
   */
  function generate(spec) {
    const data = new Uint8Array(N);
    let terrain = 'meadow', seed = 1;
    try {
      const w = own(spec, 'world'), tr = own(w, 'terrain'), sd = own(w, 'seed');
      if (TERRAINS.indexOf(tr) >= 0) terrain = tr;
      if (typeof sd === 'number' && Number.isFinite(sd)) seed = clamp(Math.round(sd), 0, 999999);
      const sf = SURF[terrain], hs = buildHeights(terrain, seed);
      for (let y = 0; y < WY; y++) for (let x = 0; x < WX; x++) {
        const h = hs[y * WX + x], beach = h <= SEA, top = beach ? sf.beach : sf.top, sub = beach ? sf.beach : sf.sub;
        for (let z = 0; z <= h; z++) data[ix(x, y, z)] = z === h ? top : z >= h - 3 ? sub : ID.stone;
        data[ix(x, y, 0)] = ID.stone;
        for (let z = h + 1; z < SEA; z++) data[ix(x, y, z)] = ID.water;
      }
      decorate(data, hs, terrain, seed);
      // The plot: clear everything above its ground, then copy the kid's build (one layer per z).
      const bm = blocksMod();
      let build = null;
      if (bm) { const v = bm.validateBuild(own(spec, 'build')); build = v.ok ? v.build : bm.starterBuild(); }
      for (let y = 0; y < PLOT.size; y++) for (let x = 0; x < PLOT.size; x++) {
        for (let z = PLOT.base; z < WZ; z++) data[ix(PLOT.x0 + x, PLOT.y0 + y, z)] = 0;
        if (!build) continue;
        for (let k = 0; k < build.layers.length; k++) {
          const id = ALPHABET.indexOf(build.layers[k][y].charAt(x));
          if (id > 0) data[ix(PLOT.x0 + x, PLOT.y0 + y, PLOT.base + k)] = id;
        }
      }
    } catch (e) { /* a half-built world is still a valid (if plain) world */ }
    return { v: 1, data: data, seed: seed, terrain: terrain, plotDirty: false };
  }

  // ---------- access ----------
  /** @returns {number} block id at the cell, 0 outside the world or for bad input */
  function get(world, x, y, z) {
    try {
      if (!validWorld(world)) return 0;
      x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
      return inRange(x, y, z) ? at(world.data, x, y, z) : 0;
    } catch (e) { return 0; }
  }

  /** Bounds-checked write; marks plotDirty when a saved plot layer changes. @returns {{ok:boolean, reason?:string}} */
  function set(world, x, y, z, id) {
    try {
      if (!validWorld(world)) return { ok: false, reason: 'bad-world' };
      if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z) || !inRange(x, y, z)) return { ok: false, reason: 'out-of-range' };
      if (!Number.isInteger(id) || id < 0 || id > MAX_ID) return { ok: false, reason: 'bad-block' };
      const i = ix(x, y, z);
      if (world.data[i] === id) return { ok: true };
      world.data[i] = id;
      if (inPlotXY(x, y) && z >= PLOT.base && z < PLOT.base + 6) world.plotDirty = true;
      return { ok: true };
    } catch (e) { return { ok: false, reason: 'bad-input' }; }
  }

  /** The plot as phase-1 build data, or null when it would not validate (e.g. everything was removed). */
  function plotToBuild(world) {
    try {
      const bm = blocksMod();
      if (!bm || !validWorld(world)) return null;
      const layers = [];
      for (let k = 0; k < 6; k++) {
        const rows = [];
        for (let y = 0; y < PLOT.size; y++) {
          let row = '';
          for (let x = 0; x < PLOT.size; x++) row += ID2CHAR[world.data[ix(PLOT.x0 + x, PLOT.y0 + y, PLOT.base + k)]] || '.';
          rows.push(row);
        }
        layers.push(rows);
      }
      while (layers.length > 1 && layers[layers.length - 1].every((r) => /^\.+$/.test(r))) layers.pop();
      const v = bm.validateBuild({ layers: layers });
      return v.ok ? v.build : null;
    } catch (e) { return null; }
  }

  /** Highest solid block + 1 for every column (index y*WX+x). */
  function heightmap(world) {
    const hm = new Uint8Array(WX * WY);
    try {
      if (!validWorld(world)) return hm;
      for (let y = 0; y < WY; y++) for (let x = 0; x < WX; x++) {
        for (let z = WZ - 1; z >= 0; z--) if (SOLID[at(world.data, x, y, z)]) { hm[y * WX + x] = z + 1; break; }
      }
    } catch (e) { /* zeros */ }
    return hm;
  }

  // ---------- walking rules shared by spawn, gems and animals ----------
  const solidAt = (d, x, y, z) => (inRange(x, y, z) ? SOLID[at(d, x, y, z)] === 1 : z < 0 || x < 0 || y < 0 || x >= WX || y >= WY);
  /** Feet cell (x,y,z) is somewhere a body can stand: dry, two cells of headroom, solid underneath. */
  function standable(d, x, y, z) {
    if (x < 0 || y < 0 || x >= WX || y >= WY || z < 1 || z + 1 >= WZ) return false;
    const a = at(d, x, y, z), b = at(d, x, y, z + 1);
    return !SOLID[a] && !SOLID[b] && a !== ID.water && b !== ID.water && SOLID[at(d, x, y, z - 1)] === 1;
  }

  const NEIGH = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  /** Flood fill over standing cells: step up 1 (with headroom to jump), step down up to 3. Index = ix(x,y,z). */
  function reach(d, sx, sy, sz) {
    const seen = new Uint8Array(N), q = new Int32Array(N);
    let head = 0, tail = 0, count = 0;
    if (!standable(d, sx, sy, sz)) return { seen: seen, count: 0 };
    seen[ix(sx, sy, sz)] = 1; q[tail++] = ix(sx, sy, sz);
    while (head < tail) {
      const c = q[head++], x = c % WX, y = ((c / WX) | 0) % WY, z = (c / (WX * WY)) | 0;
      count++;
      for (let k = 0; k < 4; k++) {
        const nx = x + NEIGH[k][0], ny = y + NEIGH[k][1];
        if (nx < 0 || ny < 0 || nx >= WX || ny >= WY) continue;
        for (let dz = 1; dz >= -3; dz--) {
          const nz = z + dz;
          if (dz === 1 && solidAt(d, x, y, z + 2)) continue;   // no room to jump up
          if (dz < 0) { let clear = true; for (let zz = nz; zz <= z + 1; zz++) if (solidAt(d, nx, ny, zz)) { clear = false; break; } if (!clear) continue; }   // walk off the edge and drop
          if (!standable(d, nx, ny, nz)) continue;
          const ni = ix(nx, ny, nz);
          if (!seen[ni]) { seen[ni] = 1; q[tail++] = ni; }
          break;                                                // the first matching level in the column is the one you land on
        }
      }
    }
    return { seen: seen, count: count };
  }

  // Natural ground a spawn may stand on (never leaves, trunks or kid-made blocks on top of a tree).
  const GROUND = new Uint8Array(32); [ID.grass, ID.dirt, ID.stone, ID.sand, ID.cloud, ID.candy, ID.snow].forEach((i) => { GROUND[i] = 1; });
  const distToPlot = (x, y) => Math.hypot(Math.max(PLOT.x0 - x, 0, x - (PLOT.x0 + PLOT.size - 1)), Math.max(PLOT.y0 - y, 0, y - (PLOT.y0 + PLOT.size - 1)));

  /** Ground-level standing cell of a column (highest natural-ground stand), or -1. */
  function groundStand(d, x, y) {
    for (let z = WZ - 3; z >= 1; z--) if (standable(d, x, y, z) && GROUND[at(d, x, y, z - 1)]) return z;
    return -1;
  }

  /** Where the player starts: dry land next to the plot with a big walkable region around it. */
  function spawnInfo(world) {
    const d = world.data, cx = PLOT.x0 + PLOT.size / 2;
    let best = null, tried = 0;
    for (let r = 2; r <= 12 && tried < 14; r++) {
      const x0 = PLOT.x0 - r, x1 = PLOT.x0 + PLOT.size - 1 + r, y0 = PLOT.y0 - r, y1 = PLOT.y0 + PLOT.size - 1 + r;
      const ring = [];
      for (let x = x0; x <= x1; x++) { ring.push([x, y0]); ring.push([x, y1]); }
      for (let y = y0 + 1; y < y1; y++) { ring.push([x0, y]); ring.push([x1, y]); }
      ring.sort((a, b) => Math.abs(a[0] - cx) + Math.abs(a[1] - PLOT.y0) * 0.5 - (Math.abs(b[0] - cx) + Math.abs(b[1] - PLOT.y0) * 0.5) || a[0] - b[0] || a[1] - b[1]);
      for (let i = 0; i < ring.length && tried < 14; i++) {
        const x = ring[i][0], y = ring[i][1];
        if (x < 1 || y < 1 || x >= WX - 1 || y >= WY - 1) continue;
        const z = groundStand(d, x, y);
        if (z < 0) continue;
        let open = true;
        for (let dy = -1; dy <= 1 && open; dy++) for (let dx = -1; dx <= 1; dx++) if (solidAt(d, x + dx, y + dy, z) || solidAt(d, x + dx, y + dy, z + 1) || (!dx && !dy && (at(d, x, y, z) !== 0 || at(d, x, y, z + 1) !== 0))) { open = false; break; }
        if (!open) continue;
        tried++;
        const rc = reach(d, x, y, z);
        if (!best || rc.count > best.count) best = { x: x, y: y, z: z, count: rc.count, seen: rc.seen };
        if (rc.count >= 500) return best;
      }
    }
    return best;
  }

  /** @returns {{x:number,y:number,z:number}} feet position (cell centre) of a safe starting spot */
  function spawn(world) {
    try {
      if (validWorld(world)) { const s = spawnInfo(world); if (s) return { x: s.x + 0.5, y: s.y + 0.5, z: s.z }; }
    } catch (e) { /* fall through */ }
    return { x: PLOT.x0 + PLOT.size / 2, y: PLOT.y0 - 2.5, z: PLOT.base };
  }

  // ---------- look / eye ----------
  const EYE = 1.62, HW = 0.3, HEIGHT = 1.8, REACH = 6;
  /** Unit look direction in WORLD space for a yaw/pitch (yaw 0 faces -y; matches a three.js camera with rotation.y = yaw, rotation.x = pitch). */
  function lookDir(yaw, pitch) {
    const yw = fin(yaw, 0), p = fin(pitch, 0), cp = Math.cos(p);
    return { x: -Math.sin(yw) * cp, y: -Math.cos(yw) * cp, z: Math.sin(p) };
  }

  // ---------- physics ----------
  const PMAX = 89 * Math.PI / 180, GRAV = 28, JUMP_V = 8.4, WALK = 4.3, SPRINT = 6.6;

  const hits = (d, x, y, z) => {
    const x0 = Math.floor(x - HW), x1 = Math.floor(x + HW - 1e-7), y0 = Math.floor(y - HW), y1 = Math.floor(y + HW - 1e-7), z0 = Math.floor(z), z1 = Math.floor(z + HEIGHT - 1e-7);
    for (let k = z0; k <= z1; k++) for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) if (solidAt(d, i, j, k)) return true;
    return false;
  };

  const wrapAngle = (a) => { a = a % TAU; return a > Math.PI ? a - TAU : a < -Math.PI ? a + TAU : a; };

  /**
   * One physics step for the player (pure: returns a new object). player = feet position (x,y,z; z up) + velocity.
   * input.mz > 0 walks forward, mx > 0 strafes right. dt is clamped to 50 ms.
   */
  function physics(player, input, world, dtMs) {
    const p0 = isObj(player) ? player : {};
    const p = { x: clamp(fin(p0.x, PLOT.x0 + 6), HW, WX - HW), y: clamp(fin(p0.y, PLOT.y0 - 2.5), HW, WY - HW), z: clamp(fin(p0.z, PLOT.base), 0, WZ + 8),
      vx: clamp(fin(p0.vx, 0), -60, 60), vy: clamp(fin(p0.vy, 0), -60, 60), vz: clamp(fin(p0.vz, 0), -60, 60),
      yaw: wrapAngle(fin(p0.yaw, 0)), pitch: clamp(fin(p0.pitch, 0), -PMAX, PMAX), onGround: p0.onGround === true, inWater: p0.inWater === true };
    try {
      const inp = isObj(input) ? input : {};
      const dt = clamp(fin(dtMs, 0), 0, 50) / 1000;
      p.yaw = wrapAngle(p.yaw + clamp(fin(own(inp, 'yawDelta'), 0), -Math.PI, Math.PI));
      p.pitch = clamp(p.pitch + clamp(fin(own(inp, 'pitchDelta'), 0), -Math.PI, Math.PI), -PMAX, PMAX);
      if (!validWorld(world) || dt === 0) return p;
      const d = world.data;
      for (let n = 0; n < 40 && hits(d, p.x, p.y, p.z); n++) p.z += 1;      // pushed out if a block appeared on the player

      const wet = (x, y, z) => get(world, x, y, z + 0.5) === ID.water;
      p.inWater = wet(p.x, p.y, p.z);
      let mx = clamp(fin(own(inp, 'mx'), 0), -1, 1), mz = clamp(fin(own(inp, 'mz'), 0), -1, 1);
      const len = Math.hypot(mx, mz);
      if (len > 1) { mx /= len; mz /= len; }
      const sp = (own(inp, 'sprint') === true ? SPRINT : WALK) * (p.inWater ? 0.55 : 1);
      const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
      const tx = (-sy * mz + cy * mx) * sp, ty = (-cy * mz - sy * mx) * sp;
      const k = 1 - Math.exp(-dt * (p.inWater ? 8 : p.onGround ? 30 : 7));
      p.vx += (tx - p.vx) * k; p.vy += (ty - p.vy) * k;

      const jump = own(inp, 'jump') === true;
      if (p.inWater) {
        p.vz = clamp(p.vz + (jump ? 20 : -8) * dt, -2, 3.2);
      } else {
        if (jump && p.onGround) p.vz = JUMP_V;
        p.vz = Math.max(-40, p.vz - GRAV * dt);
      }

      // Sub-steps of at most 0.25 block so fast falls cannot tunnel through a single block.
      const steps = Math.min(40, Math.max(1, Math.ceil(Math.max(Math.abs(p.vx), Math.abs(p.vy), Math.abs(p.vz)) * dt / 0.25)));
      const h = dt / steps;
      let grounded = false, vz = p.vz;
      for (let s = 0; s < steps; s++) {
        let nx = p.x + p.vx * h;
        if (hits(d, nx, p.y, p.z)) { nx = p.vx > 0 ? Math.floor(nx + HW) - HW - 1e-5 : Math.floor(nx - HW) + 1 + HW + 1e-5; p.vx = 0; }
        p.x = clamp(nx, HW, WX - HW);
        let ny = p.y + p.vy * h;
        if (hits(d, p.x, ny, p.z)) { ny = p.vy > 0 ? Math.floor(ny + HW) - HW - 1e-5 : Math.floor(ny - HW) + 1 + HW + 1e-5; p.vy = 0; }
        p.y = clamp(ny, HW, WY - HW);
        let nz = p.z + vz * h;
        if (hits(d, p.x, p.y, nz)) {
          if (vz > 0) { nz = Math.floor(nz + HEIGHT) - HEIGHT - 1e-5; vz = 0; }
          else {
            const under = get(world, p.x, p.y, Math.floor(nz));
            nz = Math.floor(nz) + 1;
            if (under === ID.jelly && vz < -3) vz = Math.min(11, -vz * 0.8); else { vz = 0; grounded = true; }
          }
        }
        p.z = nz;
      }
      p.vz = vz; p.onGround = grounded;
      p.inWater = wet(p.x, p.y, p.z);
    } catch (e) { /* the sanitised copy is returned as is */ }
    return p;
  }

  // ---------- raycast / edit ----------
  /** Voxel DDA from `origin` along `dir`; skips water and the cell the ray starts in. @returns {{x,y,z,face:{nx,ny,nz},id}|null} */
  function raycast(world, origin, dir, maxDist) {
    try {
      if (!validWorld(world) || !isObj(origin) || !isObj(dir)) return null;
      const ox = fin(origin.x, NaN), oy = fin(origin.y, NaN), oz = fin(origin.z, NaN);
      let dx = fin(dir.x, NaN), dy = fin(dir.y, NaN), dz = fin(dir.z, NaN);
      const dl = Math.hypot(dx, dy, dz);
      if (!(dl > 1e-9) || Number.isNaN(ox + oy + oz)) return null;
      dx /= dl; dy /= dl; dz /= dl;
      const max = clamp(fin(maxDist, 6), 0, 64);
      let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
      const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
      const tdx = dx === 0 ? Infinity : Math.abs(1 / dx), tdy = dy === 0 ? Infinity : Math.abs(1 / dy), tdz = dz === 0 ? Infinity : Math.abs(1 / dz);
      let tx = dx === 0 ? Infinity : ((dx > 0 ? x + 1 - ox : ox - x) * tdx);
      let ty = dy === 0 ? Infinity : ((dy > 0 ? y + 1 - oy : oy - y) * tdy);
      let tz = dz === 0 ? Infinity : ((dz > 0 ? z + 1 - oz : oz - z) * tdz);
      for (let n = 0; n < 400; n++) {
        let nx = 0, ny = 0, nz = 0, t;
        if (tx <= ty && tx <= tz) { t = tx; x += sx; tx += tdx; nx = -sx; }
        else if (ty <= tz) { t = ty; y += sy; ty += tdy; ny = -sy; }
        else { t = tz; z += sz; tz += tdz; nz = -sz; }
        if (t > max) return null;
        if (!inRange(x, y, z)) { if ((x < 0 && sx < 0) || (x >= WX && sx > 0) || (y < 0 && sy < 0) || (y >= WY && sy > 0) || (z < 0 && sz < 0) || (z >= WZ && sz > 0)) return null; continue; }
        const id = at(world.data, x, y, z);
        if (id !== 0 && id !== ID.water) return { x: x, y: y, z: z, face: { nx: nx, ny: ny, nz: nz }, id: id };
      }
      return null;
    } catch (e) { return null; }
  }

  const validHit = (hit) => isObj(hit) && Number.isInteger(hit.x) && Number.isInteger(hit.y) && Number.isInteger(hit.z) && isObj(hit.face)
    && [hit.face.nx, hit.face.ny, hit.face.nz].every((v) => v === -1 || v === 0 || v === 1) && Math.abs(hit.face.nx) + Math.abs(hit.face.ny) + Math.abs(hit.face.nz) === 1;

  /** Put block `id` against the face that was hit. Refuses when out of reach, inside the player, or onto something solid. */
  function place(world, player, hit, id) {
    try {
      if (!validWorld(world) || !validHit(hit)) return { ok: false, reason: 'bad-input' };
      if (!Number.isInteger(id) || id < 1 || id > MAX_ID) return { ok: false, reason: 'bad-block' };
      const x = hit.x + hit.face.nx, y = hit.y + hit.face.ny, z = hit.z + hit.face.nz;
      if (!inRange(x, y, z) || z < 1) return { ok: false, reason: 'out-of-range' };
      const cur = at(world.data, x, y, z);
      if (cur !== 0 && cur !== ID.water && !PLANT[cur]) return { ok: false, reason: 'occupied' };
      if (isObj(player)) {
        const px = fin(player.x, NaN), py = fin(player.y, NaN), pz = fin(player.z, NaN);
        if (!Number.isNaN(px + py + pz)) {
          if (Math.hypot(px - (x + 0.5), py - (y + 0.5), pz + EYE - (z + 0.5)) > REACH + 1) return { ok: false, reason: 'too-far' };
          if (SOLID[id] && px + HW > x && px - HW < x + 1 && py + HW > y && py - HW < y + 1 && pz + HEIGHT > z && pz < z + 1) return { ok: false, reason: 'inside-player' };
        }
      }
      return set(world, x, y, z, id);
    } catch (e) { return { ok: false, reason: 'bad-input' }; }
  }

  /** Remove the hit block. Row z=0 is unbreakable. Optional 3rd arg `player` enforces reach. @returns {{ok:boolean, reason?:string, id?:number}} */
  function breakBlock(world, hit, player) {
    try {
      if (!validWorld(world) || !validHit(hit)) return { ok: false, reason: 'bad-input' };
      if (!inRange(hit.x, hit.y, hit.z)) return { ok: false, reason: 'out-of-range' };
      if (hit.z === 0) return { ok: false, reason: 'bedrock' };
      const id = at(world.data, hit.x, hit.y, hit.z);
      if (id === 0 || id === ID.water) return { ok: false, reason: 'empty' };
      if (isObj(player)) {
        const px = fin(player.x, NaN), py = fin(player.y, NaN), pz = fin(player.z, NaN);
        if (!Number.isNaN(px + py + pz) && Math.hypot(px - (hit.x + 0.5), py - (hit.y + 0.5), pz + EYE - (hit.z + 0.5)) > REACH + 1) return { ok: false, reason: 'too-far' };
      }
      const r = set(world, hit.x, hit.y, hit.z, 0);
      return r.ok ? { ok: true, id: id } : r;
    } catch (e) { return { ok: false, reason: 'bad-input' }; }
  }

  // ---------- friendly animals ----------
  const KINDS = Object.freeze(['llama', 'goat', 'piglet', 'duckling']);

  /** 6..10 animals standing on land reachable from the spawn. Plain data: the renderer draws the models. */
  function critters(world, seed) {
    try {
      if (!validWorld(world)) return [];
      const sp = spawnInfo(world);
      if (!sp) return [];
      const sd = Number.isFinite(seed) ? Math.floor(seed) : 1, r = rng(sd ^ (world.seed * 7919));
      const cells = [];
      for (let z = 1; z < WZ; z++) for (let y = 0; y < WY; y++) for (let x = 0; x < WX; x++) {
        if (sp.seen[ix(x, y, z)] && distToPlot(x, y) > 3 && Math.hypot(x - sp.x, y - sp.y) >= 5 && x > 0 && y > 0 && x < WX - 1 && y < WY - 1) cells.push(ix(x, y, z));
      }
      const want = 6 + Math.floor(r() * 5), out = [];
      for (let i = 0; i < want && cells.length; i++) {
        const j = Math.floor(r() * cells.length), c = cells[j];
        cells[j] = cells[cells.length - 1]; cells.pop();
        out.push({ id: i + 1, kind: KINDS[i % KINDS.length], x: (c % WX) + 0.5, y: (((c / WX) | 0) % WY) + 0.5, z: (c / (WX * WY)) | 0,
          yaw: r() * TAU, moving: false, t: 500 + r() * 2500, rs: Math.floor(r() * 4294967296) });
      }
      return out;
    } catch (e) { return []; }
  }

  /** Feet level an animal could stand at in cell (x,y), within one block of z, or -1. */
  function critterLevel(d, x, y, z) {
    if (x < 1 || y < 1 || x >= WX - 1 || y >= WY - 1 || distToPlot(x, y) < 1) return -1;
    for (let dz = 0; dz <= 1; dz++) if (standable(d, x, y, z + dz)) return z + dz;
    return standable(d, x, y, z - 1) ? z - 1 : -1;
  }

  /** Wander / idle; never attack, never enter water, never climb the plot. Pure: returns fresh objects. */
  function stepCritters(animals, world, dtMs) {
    try {
      if (!Array.isArray(animals) || !validWorld(world)) return [];
      const dt = clamp(fin(dtMs, 0), 0, 50), d = world.data, out = [];
      for (let i = 0; i < animals.length && i < 64; i++) {
        const a = animals[i];
        if (!isObj(a) || KINDS.indexOf(a.kind) < 0) continue;
        const c = { id: fin(a.id, i + 1), kind: a.kind, x: clamp(fin(a.x, 1.5), 0.5, WX - 0.5), y: clamp(fin(a.y, 1.5), 0.5, WY - 0.5), z: Math.floor(clamp(fin(a.z, 1), 0, WZ - 1)),
          yaw: fin(a.yaw, 0), moving: a.moving === true, t: fin(a.t, 1000), rs: fin(a.rs, 1) >>> 0 };
        const rnd = () => { const f = rng(c.rs); const v = f(); c.rs = (c.rs + 0x9E3779B1) >>> 0; return v; };
        c.t -= dt;
        if (c.t <= 0) {
          if (c.moving) { c.moving = false; c.t = 800 + rnd() * 2200; }
          else { c.moving = true; c.t = 1500 + rnd() * 3000; c.yaw = rnd() * TAU; }
        }
        if (c.moving) {
          const dist = 1.1 * dt / 1000, nx = c.x - Math.sin(c.yaw) * dist, ny = c.y - Math.cos(c.yaw) * dist;
          const cx = Math.floor(nx), cy = Math.floor(ny);
          if (cx === Math.floor(c.x) && cy === Math.floor(c.y)) { c.x = nx; c.y = ny; }
          else {
            const lv = critterLevel(d, cx, cy, c.z);
            if (lv >= 0) { c.x = nx; c.y = ny; c.z = lv; }
            else { c.yaw = wrapAngle(c.yaw + Math.PI * (0.6 + rnd() * 0.8)); c.moving = false; c.t = 400 + rnd() * 800; }
          }
        }
        out.push(c);
      }
      return out;
    } catch (e) { return []; }
  }

  // ---------- gems ----------
  /** Goal collectibles on dry ground reachable on foot from the spawn, within 20 blocks of the plot. Cell coords (centre = +0.5, hover ~0.8). */
  function gems(world, spec, seed) {
    try {
      if (!validWorld(world)) return [];
      const sp = spawnInfo(world);
      if (!sp) return [];
      const g = own(spec, 'goal'), tg = own(g, 'target');
      const want = clamp(typeof tg === 'number' && Number.isFinite(tg) ? Math.round(tg) : 5, 1, 50);
      const r = rng((Number.isFinite(seed) ? Math.floor(seed) : 1) ^ (world.seed * 104729));
      const cells = [];
      for (let z = 1; z < WZ; z++) for (let y = 0; y < WY; y++) for (let x = 0; x < WX; x++) {
        if (sp.seen[ix(x, y, z)] && !inPlotXY(x, y) && distToPlot(x, y) <= 20 && Math.hypot(x - sp.x, y - sp.y) >= 4) cells.push([x, y, z]);
      }
      for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = cells[i]; cells[i] = cells[j]; cells[j] = t; }
      const out = [];
      for (let gap = 5; gap >= 0 && out.length < want; gap -= 2.5) {   // keep them spread out, relax if the land is small
        for (let i = 0; i < cells.length && out.length < want; i++) {
          const c = cells[i];
          if (c[3] === 1) continue;
          if (out.every((o) => Math.hypot(o.x - c[0], o.y - c[1]) >= gap)) { out.push({ x: c[0], y: c[1], z: c[2] }); c[3] = 1; }
        }
      }
      return out;
    } catch (e) { return []; }
  }

  /** Pick up every gem within 1.2 blocks of the player's body centre. @returns {{gems:Array, got:number}} remaining gems and how many were taken */
  function collect(player, list) {
    try {
      if (!isObj(player) || !Array.isArray(list)) return { gems: Array.isArray(list) ? list.slice() : [], got: 0 };
      const px = fin(player.x, NaN), py = fin(player.y, NaN), pz = fin(player.z, NaN);
      if (Number.isNaN(px + py + pz)) return { gems: list.slice(), got: 0 };
      const keep = [];
      let got = 0;
      list.forEach((q) => {
        if (isObj(q) && Math.hypot(px - (fin(q.x, 1e9) + 0.5), py - (fin(q.y, 1e9) + 0.5), pz + 0.9 - (fin(q.z, 1e9) + 0.8)) <= 1.2) got++; else keep.push(q);
      });
      return { gems: keep, got: got };
    } catch (e) { return { gems: [], got: 0 }; }
  }

  // ---------- day / night ----------
  const DAY_MS = 360000;
  const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const mixHex = (a, b, t) => {
    const A = hexRgb(a), B = hexRgb(b);
    return '#' + [0, 1, 2].map((i) => Math.round(lerp(A[i], B[i], t)).toString(16).padStart(2, '0')).join('');
  };
  const SKY = { dayTop: '#4fb0ff', dayBot: '#bfe6ff', duskTop: '#8a7fd8', duskBot: '#ffb36b', nightTop: '#1a2557', nightBot: '#42559b' };

  /** 6-minute day. sun = daylight 0..1, ambient never below 0.4 (never fully dark), elev -1..1 is the sun height, phase 0..1 the time of day. */
  function timeOfDay(tMs) {
    const t = fin(tMs, 0), phase = (((t / DAY_MS) + 0.1) % 1 + 1) % 1, elev = Math.sin(phase * TAU);
    const sun = smooth(-0.2, 0.4, elev), warm = clamp(1 - Math.abs(elev) / 0.32, 0, 1) * 0.8;
    const top = mixHex(mixHex(SKY.nightTop, SKY.dayTop, sun), SKY.duskTop, warm), bottom = mixHex(mixHex(SKY.nightBot, SKY.dayBot, sun), SKY.duskBot, warm);
    return { sun: sun, skyTop: top, skyBottom: bottom, ambient: 0.4 + 0.6 * sun, elev: elev, phase: phase };
  }

  // ---------- chunks ----------
  const chunkKey = (cx, cy, cz) => fin(cx, 0) + ',' + fin(cy, 0) + ',' + fin(cz, 0);
  /** Chunks whose mesh changes when cell (x,y,z) changes: its own plus any neighbour across a chunk border. */
  function dirtyChunks(x, y, z) {
    const out = [];
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return out;
    const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK), cz = Math.floor(z / CHUNK);
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 1) continue;
      const nx = cx + dx, ny = cy + dy, nz = cz + dz;
      // only add a neighbour when the edited cell actually touches that border
      if (dx && Math.floor((x + dx) / CHUNK) !== nx) continue;
      if (dy && Math.floor((y + dy) / CHUNK) !== ny) continue;
      if (dz && Math.floor((z + dz) / CHUNK) !== nz) continue;
      if (nx >= 0 && ny >= 0 && nz >= 0 && nx * CHUNK < WX && ny * CHUNK < WY && nz * CHUNK < WZ) out.push({ cx: nx, cy: ny, cz: nz });
    }
    return out;
  }

  // ---------- geometry ----------
  // Faces in RENDER space (X=x, Y=z, Z=y). a x b = n so corners (o, o+a, o+a+b, o+b) wind counter-clockwise seen from outside.
  const FACES = [
    { n: [1, 0, 0], a: [0, 1, 0], b: [0, 0, 1], o: [1, 0, 0], shade: 0.8 },
    { n: [-1, 0, 0], a: [0, 0, 1], b: [0, 1, 0], o: [0, 0, 0], shade: 0.8 },
    { n: [0, 1, 0], a: [0, 0, 1], b: [1, 0, 0], o: [0, 1, 0], shade: 1.0 },
    { n: [0, -1, 0], a: [1, 0, 0], b: [0, 0, 1], o: [0, 0, 0], shade: 0.5 },
    { n: [0, 0, 1], a: [1, 0, 0], b: [0, 1, 0], o: [0, 0, 1], shade: 0.7 },
    { n: [0, 0, -1], a: [0, 1, 0], b: [1, 0, 0], o: [0, 0, 0], shade: 0.7 }
  ];
  const CORNER = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const AO_LEVEL = [0.5, 0.68, 0.84, 1.0];
  const INSET = 0.002, TILE = 1 / 16;

  function newSet() { return { pos: new Float32Array(1536), nor: new Float32Array(1536), uv: new Float32Array(1024), col: new Float32Array(1536), idx: new Uint32Array(1536), nv: 0, ni: 0 }; }
  function grow(arr, need) { if (arr.length >= need) return arr; const b = new arr.constructor(Math.max(need, arr.length * 2)); b.set(arr); return b; }
  function reserve(s, verts, inds) {
    s.pos = grow(s.pos, (s.nv + verts) * 3); s.nor = grow(s.nor, (s.nv + verts) * 3); s.col = grow(s.col, (s.nv + verts) * 3);
    s.uv = grow(s.uv, (s.nv + verts) * 2); s.idx = grow(s.idx, s.ni + inds);
  }
  function vert(s, px, py, pz, nx, ny, nz, u, v, c) {
    const i = s.nv++, p = i * 3;
    s.pos[p] = px; s.pos[p + 1] = py; s.pos[p + 2] = pz;
    s.nor[p] = nx; s.nor[p + 1] = ny; s.nor[p + 2] = nz;
    s.col[p] = c; s.col[p + 1] = c; s.col[p + 2] = c;
    s.uv[i * 2] = u; s.uv[i * 2 + 1] = v;
  }
  const finish = (s) => ({ positions: s.pos.slice(0, s.nv * 3), normals: s.nor.slice(0, s.nv * 3), uvs: s.uv.slice(0, s.nv * 2), colors: s.col.slice(0, s.nv * 3), indices: s.idx.slice(0, s.ni) });

  /**
   * Mesh one 16^3 chunk. Hidden faces are culled; each vertex colour (RGB, itemSize 3) bakes face shade x ambient occlusion.
   * UVs assume a 16x16-tile atlas, tile = row*16+col with row 0 at the TOP of the canvas, and a texture with flipY = true.
   * @returns {{opaque:Geo, transparent:Geo}} Geo = {positions, normals, uvs, colors:Float32Array, indices:Uint32Array}; positions are RENDER space (Y up)
   */
  function buildChunkGeometry(world, cx, cy, cz) {
    const op = newSet(), tr = newSet();
    try {
      if (!validWorld(world) || !Number.isInteger(cx) || !Number.isInteger(cy) || !Number.isInteger(cz) || cx < 0 || cy < 0 || cz < 0) return { opaque: finish(op), transparent: finish(tr) };
      const d = world.data, x0 = cx * CHUNK, y0 = cy * CHUNK, z0 = cz * CHUNK;
      const x1 = Math.min(WX, x0 + CHUNK), y1 = Math.min(WY, y0 + CHUNK), z1 = Math.min(WZ, z0 + CHUNK);
      // Outside the world: air above it, solid everywhere else (no walls are drawn at the world's edge).
      const idAt = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= WX || y >= WY ? 1 : z >= WZ ? 0 : d[(z * WY + y) * WX + x]);
      const opq = (x, y, z) => OPQ[idAt(x, y, z)];
      for (let z = z0; z < z1; z++) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const id = d[(z * WY + y) * WX + x];
        if (id === 0) continue;
        const b = BLOCKS[id], isOp = OPQ[id] === 1;
        const s = isOp ? op : tr;
        if (PLANT[id]) { plantQuads(tr, x, y, z, b.side); continue; }
        const water = id === ID.water, hh = water && idAt(x, y, z + 1) !== ID.water ? 0.9 : 1;
        for (let f = 0; f < 6; f++) {
          const F = FACES[f], nb = idAt(x + F.n[0], y + F.n[2], z + F.n[1]);
          // a face shows when what is in front of it does not hide it
          if (isOp ? OPQ[nb] === 1 : (nb === id || OPQ[nb] === 1)) continue;
          const tile = f === 2 ? b.top : f === 3 ? b.bottom : b.side;
          const tu = (tile % 16) * TILE, tv = 1 - (((tile / 16) | 0) + 1) * TILE;
          reserve(s, 4, 6);
          const base = s.nv, ao = [1, 1, 1, 1];
          for (let c = 0; c < 4; c++) {
            const ca = CORNER[c][0], cb = CORNER[c][1];
            const ox = F.o[0] + ca * F.a[0] + cb * F.b[0], oy = F.o[1] + ca * F.a[1] + cb * F.b[1], oz = F.o[2] + ca * F.a[2] + cb * F.b[2];
            if (isOp) {
              // occluders sit in the layer just in front of the face, beside this corner (render axes -> world axes: y<->z)
              const da = ca ? 1 : -1, db = cb ? 1 : -1;
              const fx = x + F.n[0], fy = y + F.n[2], fz = z + F.n[1];
              const s1 = opq(fx + da * F.a[0], fy + da * F.a[2], fz + da * F.a[1]);
              const s2 = opq(fx + db * F.b[0], fy + db * F.b[2], fz + db * F.b[1]);
              const cc = opq(fx + da * F.a[0] + db * F.b[0], fy + da * F.a[2] + db * F.b[2], fz + da * F.a[1] + db * F.b[1]);
              ao[c] = AO_LEVEL[s1 && s2 ? 0 : 3 - (s1 + s2 + cc)];
            }
            const u = F.n[1] === 0 ? (F.n[0] !== 0 ? oz : ox) : ox, v = F.n[1] === 0 ? oy : oz;
            vert(s, x + ox, z + oy * hh, y + oz, F.n[0], F.n[1], F.n[2], tu + (u ? TILE - INSET : INSET), tv + (v ? TILE - INSET : INSET), F.shade * ao[c]);
          }
          // Split the quad along the diagonal that avoids an AO crease.
          const i = s.ni;
          if (ao[0] + ao[2] >= ao[1] + ao[3]) { s.idx[i] = base; s.idx[i + 1] = base + 1; s.idx[i + 2] = base + 2; s.idx[i + 3] = base; s.idx[i + 4] = base + 2; s.idx[i + 5] = base + 3; }
          else { s.idx[i] = base + 1; s.idx[i + 1] = base + 2; s.idx[i + 2] = base + 3; s.idx[i + 3] = base + 1; s.idx[i + 4] = base + 3; s.idx[i + 5] = base; }
          s.ni += 6;
        }
      }
    } catch (e) { /* return whatever was built */ }
    return { opaque: finish(op), transparent: finish(tr) };
  }

  /** Two crossed quads (each drawn from both sides) for flowers and tall grass. */
  function plantQuads(s, x, y, z, tile) {
    const tu = (tile % 16) * TILE, tv = 1 - (((tile / 16) | 0) + 1) * TILE;
    const quads = [[0.1, 0.1, 0.9, 0.9], [0.9, 0.1, 0.1, 0.9]];
    for (let q = 0; q < 2; q++) for (let side = 0; side < 2; side++) {
      reserve(s, 4, 6);
      const base = s.nv, Q = quads[q];
      const xs = side ? [Q[2], Q[0], Q[0], Q[2]] : [Q[0], Q[2], Q[2], Q[0]], zs = side ? [Q[3], Q[1], Q[1], Q[3]] : [Q[1], Q[3], Q[3], Q[1]];
      const ys = [0, 0, 1, 1], us = side ? [1, 0, 0, 1] : [0, 1, 1, 0];
      for (let c = 0; c < 4; c++) vert(s, x + xs[c], z + ys[c], y + zs[c], 0, 1, 0, tu + (us[c] ? TILE - INSET : INSET), tv + (ys[c] ? TILE - INSET : INSET), 0.95);
      const i = s.ni;
      s.idx[i] = base; s.idx[i + 1] = base + 1; s.idx[i + 2] = base + 2; s.idx[i + 3] = base; s.idx[i + 4] = base + 2; s.idx[i + 5] = base + 3;
      s.ni += 6;
    }
  }

  const api = { WX, WY, WZ, PLOT, SEA, CHUNK, BLOCKS, ID, TILES, TERRAINS, KINDS, PLACEABLE, EYE, HEIGHT, REACH, DAY_MS,
    generate, get, set, plotToBuild, heightmap, spawn, physics, lookDir, raycast, place, breakBlock, critters, stepCritters, gems, collect,
    timeOfDay, chunkKey, dirtyChunks, buildChunkGeometry };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AIXVoxel = api;
})(typeof window !== 'undefined' ? window : globalThis);
