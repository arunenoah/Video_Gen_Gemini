/* ============================================================
   AI Explorers — Block Builder "Explore 3D": a first-person walk-and-build view of a big blocky world (three.js r128, WebGL).
   All world rules live in AIXVoxel (pure, vg-aix-voxel.js): terrain, physics, raycast, place/break, animals, gems, day and night,
   chunk geometry. This file only draws it (scene, sky, clouds, animals, gems, hand, cracks), reads input and reports back.
   The pixel-art block textures are painted at runtime by makeAtlas below: our own art, no image files, nothing downloaded.
   The world is data (a spec), never code. All text is React text; nothing from the spec is used as markup, a URL or code.
   Controls: mouse (pointer lock, drag-look fallback) + keyboard, or touch (joystick, look-drag, big buttons).
   Shortcuts while playing: Space jump, F break, G place, V My view, M Map view (from above, north is where you were facing), B Big. Your Game Studio hero is a blocky character seen in Map view.
   Safety and care: friendly message instead of a blank screen when WebGL or three.js is missing, pauses when the tab is hidden,
   devicePixelRatio capped at 2, at most 2 chunk rebuilds per frame, and every renderer / geometry / material / texture / listener /
   timer is released on unmount. Respects prefers-reduced-motion (no head bob, no cloud drift).
   ============================================================ */
(function () {
  const TAP = 48;                                   // px, minimum touch target (spec says >= 44)
  const INK = '#14202b', MUTE = '#5b6b79', LINE = '#e4e8ec';
  const EYE = 1.62;                                 // eye height above the feet, in blocks
  const REACH = 6;                                  // how far the kid can break / place
  const BREAK_MS = 450;                             // hold time to break a block
  const DAY_MS = 360000;                            // one day, matches AIXVoxel.timeOfDay
  const MAX_RENDER_CHUNKS = 5;                      // render distance, in chunks
  const CHUNKS_PER_FRAME = 2;
  const MAP_H = 26;                                 // map view: camera height above the player, in blocks
  const MAP_PITCH = -1.22;                          // about -70 degrees: a steep look down, like a game map
  const MAP_BACK = MAP_H / Math.tan(-MAP_PITCH);    // how far behind the player the camera sits so the player stays centred
  const SAVE_DELAY = 600;
  const sfx = (n) => { try { if (typeof window.aixSfx === 'function') window.aixSfx(n); } catch (e) { /* sound is optional */ } };
  const reduced = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const HEX = /^#[0-9a-fA-F]{6}$/;
  const fin0 = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const hexNum = (h, fallback) => (typeof h === 'string' && HEX.test(h) ? parseInt(h.slice(1), 16) : fallback);

  // ---------- the pixel-art atlas: 16 x 16 tiles of 16 px, painted from a seeded RNG ----------
  const TILE_PX = 16, ATLAS_TILES = 16;
  /** Tile names in atlas order. AIXVoxel.TILES (when it publishes one) wins so both sides always agree. */
  const DEFAULT_TILES = ['grassTop', 'grassSide', 'dirt', 'stone', 'planks', 'leaves', 'brick', 'water', 'sand', 'glass', 'cloud', 'candy', 'jelly', 'snow', 'cactusSide', 'cactusTop',
    'trunkSide', 'trunkTop', 'flowerRed', 'flowerYellow', 'tallGrass', 'cobble'];

  function mulberry(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  /** How each tile is painted: base tones, then a few decorations. put(x, y, colour) writes one pixel of the tile. */
  const ART = {
    grassTop: (p, r) => { p.fill(['#5fbf4a', '#6fd05a', '#52ad41'], r); for (let i = 0; i < 10; i++) p.put((r() * 16) | 0, (r() * 16) | 0, '#7fe06a'); },
    grassSide: (p, r) => { p.fill(['#8a5a34', '#7b4e2b', '#966339'], r); for (let x = 0; x < 16; x++) { const h = 3 + ((r() * 3) | 0); for (let y = 0; y < h; y++) p.put(x, y, y === h - 1 ? '#52ad41' : '#5fbf4a'); } },
    dirt: (p, r) => { p.fill(['#8a5a34', '#7b4e2b', '#966339'], r); for (let i = 0; i < 12; i++) p.put((r() * 16) | 0, (r() * 16) | 0, '#5f3d20'); },
    stone: (p, r) => { p.fill(['#9aa1a8', '#8d949b', '#a7adb3'], r); for (let i = 0; i < 14; i++) p.put((r() * 16) | 0, (r() * 16) | 0, '#767c83'); },
    planks: (p, r) => { p.fill(['#c8924f', '#bd8745', '#d29d5a'], r); for (let x = 0; x < 16; x++) { p.put(x, 3, '#8a5e2c'); p.put(x, 7, '#8a5e2c'); p.put(x, 11, '#8a5e2c'); p.put(x, 15, '#8a5e2c'); } p.put(4, 1, '#8a5e2c'); p.put(11, 5, '#8a5e2c'); p.put(7, 9, '#8a5e2c'); p.put(13, 13, '#8a5e2c'); },
    leaves: (p, r) => { p.fill(['#3f9a3a', '#47a840', '#368b33'], r); for (let i = 0; i < 26; i++) p.put((r() * 16) | 0, (r() * 16) | 0, null); },
    brick: (p, r) => { p.fill(['#b5523b', '#a64934', '#c25c44'], r); for (let y = 0; y < 16; y += 4) { for (let x = 0; x < 16; x++) p.put(x, y + 3, '#d9cfc2'); const off = (y / 4) % 2 ? 4 : 0; for (let k = 0; k < 2; k++) for (let yy = 0; yy < 3; yy++) p.put((off + k * 8) % 16, y + yy, '#d9cfc2'); } },
    water: (p, r) => { p.fill(['#3f86e0', '#4a93ea', '#377cd4'], r, 0.78); for (let i = 0; i < 8; i++) p.put((r() * 16) | 0, (r() * 16) | 0, '#a9d3ff'); },
    sand: (p, r) => { p.fill(['#ecd699', '#e4cc8a', '#f2dfa8'], r); for (let i = 0; i < 8; i++) p.put((r() * 16) | 0, (r() * 16) | 0, '#cdb577'); },
    glass: (p) => { p.clear(); for (let i = 0; i < 16; i++) { p.put(i, 0, '#cfeaf5'); p.put(i, 15, '#cfeaf5'); p.put(0, i, '#cfeaf5'); p.put(15, i, '#cfeaf5'); } for (let i = 3; i < 8; i++) p.put(i, 11 - i, 'rgba(255,255,255,.8)'); p.put(10, 4, 'rgba(255,255,255,.6)'); p.put(9, 5, 'rgba(255,255,255,.6)'); },
    cloud: (p, r) => { p.fill(['#ffffff', '#f4f8ff', '#e9f0fb'], r); },
    candy: (p, r) => { p.fill(['#ff9ec7', '#ffb3d5', '#ff8bbb'], r); for (let i = 0; i < 16; i++) { p.put(i, (i + 4) % 16, '#ffffff'); p.put(i, (i + 5) % 16, '#ffffff'); } },
    jelly: (p, r) => { p.fill(['#b86cf0', '#c47cf5', '#a95ee6'], r); p.put(3, 3, '#e6c5ff'); p.put(4, 3, '#e6c5ff'); p.put(3, 4, '#e6c5ff'); p.put(11, 11, '#8f45cc'); },
    snow: (p, r) => { p.fill(['#f6faff', '#ebf3fb', '#ffffff'], r); for (let i = 0; i < 6; i++) p.put((r() * 16) | 0, (r() * 16) | 0, '#cfe0f0'); },
    cactusTop: (p, r) => { p.fill(['#4fa24a', '#58ad52', '#47993f'], r); for (let i = 2; i < 14; i++) { p.put(i, 2, '#2f7a30'); p.put(i, 13, '#2f7a30'); p.put(2, i, '#2f7a30'); p.put(13, i, '#2f7a30'); } },
    cactusSide: (p, r) => { p.fill(['#4fa24a', '#58ad52', '#47993f'], r); for (let y = 0; y < 16; y++) { p.put(0, y, '#2f7a30'); p.put(15, y, '#2f7a30'); } for (let i = 0; i < 6; i++) p.put(2 + ((r() * 12) | 0), (r() * 16) | 0, '#f4efc2'); },
    trunkSide: (p, r) => { p.fill(['#7a5230', '#6b4527', '#86593a'], r); for (let x = 1; x < 16; x += 4) for (let y = 0; y < 16; y++) if (r() < 0.8) p.put(x, y, '#4f3219'); },
    trunkTop: (p, r) => { p.fill(['#c79a5e', '#bd9055', '#d1a468'], r); for (let i = 2; i < 14; i++) { p.put(i, 2, '#7a5230'); p.put(i, 13, '#7a5230'); p.put(2, i, '#7a5230'); p.put(13, i, '#7a5230'); } for (let i = 5; i < 11; i++) { p.put(i, 5, '#7a5230'); p.put(i, 10, '#7a5230'); p.put(5, i, '#7a5230'); p.put(10, i, '#7a5230'); } },
    flowerRed: (p) => { p.clear(); for (let y = 8; y < 16; y++) p.put(8, y, '#3f9a3a'); p.put(7, 11, '#3f9a3a'); p.put(9, 12, '#3f9a3a'); [[8, 5], [7, 6], [9, 6], [8, 7], [6, 5], [10, 5], [8, 4]].forEach((q) => p.put(q[0], q[1], '#e5484d')); p.put(8, 6, '#ffd23f'); },
    flowerYellow: (p) => { p.clear(); for (let y = 8; y < 16; y++) p.put(8, y, '#3f9a3a'); p.put(9, 11, '#3f9a3a'); [[8, 5], [7, 6], [9, 6], [8, 7], [6, 5], [10, 5], [8, 4]].forEach((q) => p.put(q[0], q[1], '#ffd23f')); p.put(8, 6, '#c8741a'); },
    tallGrass: (p, r) => { p.clear(); for (let x = 1; x < 15; x += 2) { const h = 5 + ((r() * 8) | 0); for (let y = 16 - h; y < 16; y++) p.put(x, y, y < 16 - h + 2 ? '#7fe06a' : '#52ad41'); } },
    cobble: (p, r) => { p.fill(['#9a9a96', '#8c8c88', '#a8a8a3'], r); for (let y = 0; y < 16; y += 5) for (let x = 0; x < 16; x++) p.put(x, y, '#6f6f6b'); for (let x = 0; x < 16; x += 5) for (let y = 0; y < 16; y++) if (r() < 0.7) p.put((x + (((y / 5) | 0) % 2) * 3) % 16, y, '#6f6f6b'); },
  };

  /** Paint the atlas into a canvas. Returns the canvas (the caller wraps it in a texture). */
  function makeAtlas(names, seed) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = TILE_PX * ATLAS_TILES;
    const ctx = cv.getContext('2d');
    if (!ctx) return cv;
    for (let i = 0; i < names.length && i < ATLAS_TILES * ATLAS_TILES; i++) {
      const art = ART[names[i]];
      if (!art) continue;
      const ox = (i % ATLAS_TILES) * TILE_PX, oy = Math.floor(i / ATLAS_TILES) * TILE_PX, r = mulberry(seed + i * 977);
      const p = {
        put(x, y, col) { if (x < 0 || y < 0 || x > 15 || y > 15) return; if (col === null) ctx.clearRect(ox + x, oy + y, 1, 1); else { ctx.clearRect(ox + x, oy + y, 1, 1); ctx.fillStyle = col; ctx.fillRect(ox + x, oy + y, 1, 1); } },
        clear() { ctx.clearRect(ox, oy, TILE_PX, TILE_PX); },
        fill(tones, rnd, alpha) { ctx.save(); ctx.globalAlpha = alpha === undefined ? 1 : alpha; for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { ctx.fillStyle = tones[(rnd() * tones.length) | 0]; ctx.fillRect(ox + x, oy + y, 1, 1); } ctx.restore(); },
      };
      art(p, r);
    }
    return cv;
  }

  /** Three small crack stages side by side (48 x 16) drawn with dark pixels. */
  function makeCracks() {
    const cv = document.createElement('canvas'); cv.width = 48; cv.height = 16;
    const ctx = cv.getContext('2d');
    if (!ctx) return cv;
    const r = mulberry(4242);
    ctx.fillStyle = 'rgba(20,32,43,.75)';
    for (let s = 0; s < 3; s++) {
      const n = 14 + s * 16;
      let x = 8, y = 8;
      for (let i = 0; i < n; i++) { ctx.fillRect(s * 16 + x, y, 1, 1); x = clamp(x + ((r() * 3) | 0) - 1, 0, 15); y = clamp(y + ((r() * 3) | 0) - 1, 0, 15); if (i % 9 === 8) { x = (r() * 16) | 0; y = (r() * 16) | 0; } }
    }
    return cv;
  }

  /** A square pixel sun or moon. */
  function makeBody(kind) {
    const cv = document.createElement('canvas'); cv.width = cv.height = 32;
    const ctx = cv.getContext('2d');
    if (!ctx) return cv;
    if (kind === 'sun') { ctx.fillStyle = '#ffe9a0'; ctx.fillRect(2, 2, 28, 28); ctx.fillStyle = '#fff6cf'; ctx.fillRect(6, 6, 20, 20); ctx.fillStyle = '#ffd23f'; ctx.fillRect(10, 10, 12, 12); }
    else { ctx.fillStyle = '#dfe6f2'; ctx.fillRect(4, 4, 24, 24); ctx.fillStyle = '#c3cce0'; ctx.fillRect(9, 9, 5, 5); ctx.fillRect(18, 15, 6, 6); ctx.fillRect(12, 21, 4, 4); }
    return cv;
  }

  // ---------- animal and gem models (boxes only, our own friendly design) ----------
  const ANIMALS = {
    llama: { body: '#efe4cf', dark: '#c9b99a', size: [0.5, 0.55, 0.95], legH: 0.6, head: [0.3, 0.3, 0.42], neck: 0.5 },
    goat: { body: '#f4f4f0', dark: '#8a8a86', size: [0.4, 0.45, 0.75], legH: 0.45, head: [0.26, 0.26, 0.32], neck: 0.15 },
    piglet: { body: '#ffb3c6', dark: '#ff8fa8', size: [0.42, 0.4, 0.62], legH: 0.22, head: [0.3, 0.28, 0.28], neck: 0 },
    duckling: { body: '#ffe066', dark: '#ffb52e', size: [0.3, 0.28, 0.36], legH: 0.14, head: [0.22, 0.22, 0.22], neck: 0.08 },
  };

  /** Build one animal as a Group of boxes. Forward is +z. Returns { group, legs[], head }. */
  function makeAnimal(THREE, kind, unit, mat) {
    const a = ANIMALS[kind] || ANIMALS.piglet;
    const g = new THREE.Group(), legs = [];
    const box = (parent, w, h, d, x, y, z, col) => { const m = new THREE.Mesh(unit, mat(col)); m.scale.set(w, h, d); m.position.set(x, y, z); parent.add(m); return m; };
    const S = a.size, bodyY = a.legH + S[1] / 2;
    box(g, S[0], S[1], S[2], 0, bodyY, 0, a.body);
    [[-1, 1], [1, 1], [-1, -1], [1, -1]].forEach((q) => {
      const pivot = new THREE.Group(); pivot.position.set(q[0] * S[0] * 0.3, a.legH, q[1] * S[2] * 0.33);
      box(pivot, S[0] * 0.28, a.legH, S[0] * 0.28, 0, -a.legH / 2, 0, a.dark); g.add(pivot); legs.push(pivot);
    });
    const head = new THREE.Group(), hy = bodyY + S[1] / 2 + a.neck * 0.7;
    head.position.set(0, hy, S[2] / 2 + a.head[2] * 0.2);
    if (a.neck > 0.2) box(g, 0.18, a.neck, 0.18, 0, bodyY + S[1] / 2 + a.neck * 0.25, S[2] / 2 - 0.05, a.body);
    box(head, a.head[0], a.head[1], a.head[2], 0, 0, 0, a.body);
    box(head, a.head[0] * 0.14, a.head[1] * 0.2, 0.02, -a.head[0] * 0.25, a.head[1] * 0.12, a.head[2] / 2 + 0.01, '#14202b');
    box(head, a.head[0] * 0.14, a.head[1] * 0.2, 0.02, a.head[0] * 0.25, a.head[1] * 0.12, a.head[2] / 2 + 0.01, '#14202b');
    if (kind === 'llama') { box(head, 0.07, 0.16, 0.07, -0.09, a.head[1] / 2 + 0.07, -0.05, a.dark); box(head, 0.07, 0.16, 0.07, 0.09, a.head[1] / 2 + 0.07, -0.05, a.dark); }
    if (kind === 'goat') { box(head, 0.05, 0.14, 0.05, -0.08, a.head[1] / 2 + 0.06, -0.04, '#d9cfc2'); box(head, 0.05, 0.14, 0.05, 0.08, a.head[1] / 2 + 0.06, -0.04, '#d9cfc2'); box(head, 0.08, 0.1, 0.08, 0, -a.head[1] / 2 - 0.04, a.head[2] / 2 - 0.05, '#d9cfc2'); }
    if (kind === 'piglet') { box(head, 0.14, 0.1, 0.06, 0, -0.04, a.head[2] / 2 + 0.03, a.dark); box(head, 0.07, 0.07, 0.04, -0.1, a.head[1] / 2 + 0.03, -0.04, a.dark); box(head, 0.07, 0.07, 0.04, 0.1, a.head[1] / 2 + 0.03, -0.04, a.dark); }
    if (kind === 'duckling') box(head, 0.14, 0.06, 0.1, 0, -0.04, a.head[2] / 2 + 0.05, '#ff8a1f');
    g.add(head);
    return { group: g, legs: legs, head: head };
  }

  // ---------- my hero as a blocky character ----------
  const toHex = (n) => '#' + (n & 0xffffff).toString(16).padStart(6, '0');
  /** Blend colour a toward colour b by t (0..1). Anything that is not #rrggbb falls back to the default hero orange. */
  function mixHex(a, b, t) {
    const x = hexNum(a, 0xff7a59), y = hexNum(b, 0xff7a59), k = clamp(t, 0, 1);
    const ch = (sh) => Math.round(((x >> sh) & 255) + ((((y >> sh) & 255) - ((x >> sh) & 255)) * k));
    return toHex((ch(16) << 16) | (ch(8) << 8) | ch(0));
  }
  /**
   * What the character looks like, read defensively from spec.hero (already validated, checked again here).
   * @returns {{color:string, hair:string, sprite:?{palette:string[], rows:string[]}}}
   */
  function heroLook(hero) {
    const h = hero && typeof hero === 'object' ? hero : {};
    const color = typeof h.color === 'string' && HEX.test(h.color) ? h.color : '#ff7a59';
    let sprite = null;
    const sp = h.sprite;
    if (sp && Array.isArray(sp.palette) && Array.isArray(sp.rows) && sp.palette.length >= 1 && sp.palette.length <= 6 && sp.rows.length === 8
      && sp.palette.every((c) => typeof c === 'string' && HEX.test(c))
      && sp.rows.every((r) => typeof r === 'string' && r.length === 8 && r.split('').every((d) => d >= '0' && d <= '9' && Number(d) < sp.palette.length))) {
      sprite = { palette: sp.palette, rows: sp.rows };
    }
    let hair = '#6b4a2f';                                     // the sprite's most common colour becomes the hair and the rest of the head
    if (sprite) {
      const count = sprite.palette.map(() => 0);
      sprite.rows.forEach((r) => { for (let i = 0; i < 8; i++) count[Number(r[i])]++; });
      hair = sprite.palette[count.indexOf(Math.max.apply(null, count))];
    }
    return { color: color, hair: hair, sprite: sprite };
  }
  /** Paint the 8 x 8 front of the head: the kid's own sprite, or our friendly default face. */
  function paintFace(cv, look) {
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    if (look.sprite) {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { ctx.fillStyle = look.sprite.palette[Number(look.sprite.rows[y][x])]; ctx.fillRect(x, y, 1, 1); }
      return;
    }
    ctx.fillStyle = look.hair; ctx.fillRect(0, 0, 8, 8);
    ctx.fillStyle = '#f6d3b0'; ctx.fillRect(0, 2, 8, 6);
    ctx.fillStyle = '#14202b'; ctx.fillRect(2, 3, 1, 2); ctx.fillRect(5, 3, 1, 2);
    ctx.fillStyle = '#ff9ea8'; ctx.fillRect(1, 5, 1, 1); ctx.fillRect(6, 5, 1, 1);
    ctx.fillStyle = '#b5443a'; ctx.fillRect(2, 5, 1, 1); ctx.fillRect(5, 5, 1, 1); ctx.fillRect(3, 6, 2, 1);
  }
  /** Build the character (1.8 blocks tall, 0.6 wide) from boxes. Forward is +z. Returns { group, upper, legs[2], arms[2] }. */
  function makeAvatar(THREE, unit, mat, faceMat, look) {
    const g = new THREE.Group(), upper = new THREE.Group(), legs = [], arms = [];
    const box = (parent, w, h, d, x, y, z, m) => { const mesh = new THREE.Mesh(unit, m); mesh.scale.set(w, h, d); mesh.position.set(x, y, z); parent.add(mesh); return mesh; };
    const hairM = mat(look.hair), armM = mat(mixHex(look.color, '#ffffff', 0.25)), legM = mat(mixHex(look.color, '#000000', 0.35));
    [-1, 1].forEach((q) => {
      const leg = new THREE.Group(); leg.position.set(q * 0.09, 0.65, 0); box(leg, 0.17, 0.65, 0.2, 0, -0.325, 0, legM); g.add(leg); legs.push(leg);
      const arm = new THREE.Group(); arm.position.set(q * 0.24, 1.25, 0); box(arm, 0.12, 0.6, 0.14, 0, -0.28, 0, armM); upper.add(arm); arms.push(arm);
    });
    box(upper, 0.36, 0.65, 0.2, 0, 0.975, 0, mat(look.color));
    box(upper, 0.5, 0.5, 0.5, 0, 1.55, 0, [hairM, hairM, hairM, hairM, faceMat, hairM]);   // +x -x +y -y +z -z: the face is on +z
    g.add(upper);
    return { group: g, upper: upper, legs: legs, arms: arms };
  }

  // ---------- small UI pieces ----------
  const btnStyle = (accent, extra) => Object.assign({ minWidth: TAP, minHeight: TAP, padding: '0 18px', borderRadius: 14, border: 'none', background: accent, color: '#fff', fontSize: 16, fontWeight: 800, cursor: 'pointer', userSelect: 'none', WebkitUserSelect: 'none' }, extra || {});
  const ghostStyle = { minHeight: TAP, padding: '0 20px', borderRadius: 999, border: `1.5px solid ${LINE}`, background: '#fff', color: INK, fontSize: 15, fontWeight: 800, cursor: 'pointer' };
  const HINTS = [['Space', 'Jump'], ['F', 'Break'], ['G', 'Place'], ['V', 'My view'], ['M', 'Map view'], ['B', 'Big']];
  const glassBtn = { minWidth: TAP, minHeight: TAP, padding: '0 14px', borderRadius: 999, border: '2px solid rgba(255,255,255,.7)', background: 'rgba(20,32,43,.5)', color: '#fff', fontSize: 15, fontWeight: 800, cursor: 'pointer', userSelect: 'none', WebkitUserSelect: 'none' };

  /** Friendly card shown when 3D cannot start (never a blank screen). */
  function Fallback({ onExit, body }) {
    return (
      <div role="alert" style={{ padding: 20, borderRadius: 18, border: `1.5px solid ${LINE}`, background: '#fff', maxWidth: 520, margin: '0 auto' }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: INK, marginBottom: 6 }}>The 3D world cannot wake up here</div>
        <div style={{ fontSize: 14.5, color: MUTE, marginBottom: 14 }}>{body || 'This screen cannot show 3D right now. Your world is safe! You can keep playing and building in the flat view.'}</div>
        <button type="button" onClick={onExit} style={ghostStyle}>Back to the flat view</button>
      </div>
    );
  }

  /** Hold-to-press round button for touch (also works with a mouse). */
  function HoldButton({ label, text, size, set, bg }) {
    const down = (e) => { e.preventDefault(); try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* capture is a nicety */ } set(true); };
    const up = () => set(false);
    return (
      <button type="button" aria-label={label} onPointerDown={down} onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up} onContextMenu={(e) => e.preventDefault()}
        style={{ width: size, height: size, minWidth: TAP, minHeight: TAP, borderRadius: '50%', border: '3px solid rgba(255,255,255,.85)', background: bg, color: '#fff', fontSize: size > 60 ? 15 : 13, fontWeight: 800, cursor: 'pointer', touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', padding: 0, boxShadow: '0 2px 8px rgba(0,0,0,.3)' }}>{text}</button>
    );
  }

  const KEYS = { w: 'f', arrowup: 'f', s: 'b', arrowdown: 'b', a: 'l', arrowleft: 'l', d: 'r', arrowright: 'r' };

  /**
   * The first-person world.
   * @param {{spec:Object, onExit:()=>void, onPlotChange?:(build:Object)=>void, onEnd?:(r:Object)=>void, theme?:{primary?:string}}} props
   */
  function ExploreView({ spec, onExit, onPlotChange, onEnd, theme }) {
    const accent = (theme && theme.primary) || '#2f6fed';
    const THREE = window.THREE, V = window.AIXVoxel, Bk = window.AIXBlocks;
    const missing = !THREE || !V || !Bk;
    const [fail, setFail] = React.useState('');                 // '' | 'webgl' | 'lost'
    const [phase, setPhase] = React.useState('ready');          // ready | playing | paused | won
    const [touch, setTouch] = React.useState(() => { try { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (e) { return false; } });
    const [noLock, setNoLock] = React.useState(false);          // pointer lock refused -> drag to look
    const [hud, setHud] = React.useState({ got: 0, total: 0 });
    const [sel, setSel] = React.useState(0);
    const [saved, setSaved] = React.useState(false);
    const [note, setNote] = React.useState('');
    const [under, setUnder] = React.useState(false);
    const [full, setFull] = React.useState(false);
    const [mapView, setMapView] = React.useState(false);        // false = my view (first person), true = map view (from above)

    const boxRef = React.useRef(null), canvasRef = React.useRef(null), stickRef = React.useRef(null), knobRef = React.useRef(null);
    const ctl = React.useRef({ f: 0, b: 0, l: 0, r: 0, jump: false, sprint: false, brk: false, put: false, lookX: 0, lookY: 0, jx: 0, jy: 0, active: false, locked: false, noLock: false, sel: 0, map: false });
    const api = React.useRef({});                                // functions the effect hands back to the buttons
    const R = React.useRef({});
    R.current = { onPlotChange: onPlotChange, onEnd: onEnd, phase: phase, touch: touch };

    // hotbar: the materials the plot already uses first, then friendly defaults, nine in all
    const hotbar = React.useMemo(() => {
      if (missing) return [];
      const out = [], add = (ch) => { if (ch && ch !== '.' && out.indexOf(ch) < 0 && Bk.MATERIALS[ch] && out.length < 9) out.push(ch); };
      try { ((spec && spec.build && spec.build.layers) || []).forEach((layer) => layer.forEach((row) => String(row).split('').forEach(add))); } catch (e) { /* defaults below */ }
      'gdswbltyapcj'.split('').forEach(add);
      return out;
    }, [spec, missing]);
    const atlasUrl = React.useRef('');

    React.useEffect(() => { ctl.current.sel = sel; if (api.current.heldChanged) api.current.heldChanged(); }, [sel]);

    // ---------- build the scene, run the loop, tear everything down ----------
    React.useEffect(() => {
      if (missing) return undefined;
      const canvas = canvasRef.current, box = boxRef.current;
      if (!canvas || !box) return undefined;
      const c = ctl.current;
      c.map = false; setMapView(false);
      const own = { geoms: [], mats: [], texs: [] };               // everything we must dispose
      const track = (arr, o) => { arr.push(o); return o; };
      const motion = !reduced();
      let renderer = null, raf = 0, saveTimer = 0, savedTimer = 0, noteTimer = 0, alive = true, hidden = false;
      const listeners = [];
      const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); listeners.push([target, type, fn, opts]); };

      try {
        renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
        if (!renderer.getContext()) throw new Error('no context');
      } catch (e) { if (renderer) { try { renderer.dispose(); } catch (e2) { /* nothing more to release */ } } setFail('webgl'); return undefined; }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

      // ----- world -----
      const world = V.generate(spec);
      const WX = V.WX, WY = V.WY, WZ = V.WZ, CH = V.CHUNK || 16;
      const seed = (spec && spec.world && Number.isFinite(spec.world.seed)) ? spec.world.seed : 1;
      const idByChar = {}, charById = {};
      V.BLOCKS.forEach((b, id) => { if (b && b.char) { idByChar[b.char] = id; charById[id] = b.char; } });
      const isWater = (id) => id === V.ID.water;
      const tileNames = Array.isArray(V.TILES) && V.TILES.length ? V.TILES : DEFAULT_TILES;
      const atlasCanvas = makeAtlas(tileNames, 20260901);
      try { atlasUrl.current = atlasCanvas.toDataURL('image/png'); } catch (e) { atlasUrl.current = ''; }

      let player = V.spawn(world);
      player = { x: player.x, y: player.y, z: player.z, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, onGround: false, inWater: false };
      let animals = V.critters(world, seed) || [];
      let gems = V.gems(world, spec, seed) || [];
      const totalGems = gems.length;

      // ----- three basics -----
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(72, 1, 0.05, 400);
      scene.add(camera);
      scene.fog = new THREE.Fog(0xbfe3ff, 24, MAX_RENDER_CHUNKS * CH);
      const hemi = new THREE.HemisphereLight(0xffffff, 0x7a8a6a, 0.8); scene.add(hemi);
      const sunLight = new THREE.DirectionalLight(0xfff2cc, 0.6); sunLight.position.set(0.4, 1, 0.3); scene.add(sunLight);

      const atlasTex = track(own.texs, new THREE.CanvasTexture(atlasCanvas));
      atlasTex.magFilter = THREE.NearestFilter; atlasTex.minFilter = THREE.NearestFilter; atlasTex.generateMipmaps = false;
      const matOpaque = track(own.mats, new THREE.MeshBasicMaterial({ map: atlasTex, vertexColors: true }));
      const matTrans = track(own.mats, new THREE.MeshBasicMaterial({ map: atlasTex, vertexColors: true, transparent: true, alphaTest: 0.05 }));
      // Render space: AIXVoxel meshes are built with X = x, Y = z (up), Z = y, so cell (x, y, z) sits at three.js (x, z, y).
      const terrain = new THREE.Group();
      scene.add(terrain);
      camera.rotation.order = 'YXZ';

      // ----- sky dome, sun, moon, stars, clouds -----
      const domeGeo = track(own.geoms, new THREE.SphereGeometry(320, 16, 10));
      const domePos = domeGeo.attributes.position, domeN = domePos.count;
      domeGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(domeN * 3), 3));
      const domeCol = domeGeo.attributes.color;
      const dome = new THREE.Mesh(domeGeo, track(own.mats, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })));
      dome.renderOrder = -3; dome.frustumCulled = false; scene.add(dome);
      const bodyMat = (kind) => track(own.mats, new THREE.SpriteMaterial({ map: track(own.texs, (() => { const t = new THREE.CanvasTexture(makeBody(kind)); t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; return t; })()), fog: false, depthWrite: false, transparent: true }));
      const sunSpr = new THREE.Sprite(bodyMat('sun')), moonSpr = new THREE.Sprite(bodyMat('moon'));
      sunSpr.scale.set(60, 60, 1); moonSpr.scale.set(44, 44, 1); sunSpr.renderOrder = -2; moonSpr.renderOrder = -2; scene.add(sunSpr); scene.add(moonSpr);
      const starGeo = track(own.geoms, new THREE.BufferGeometry());
      { const rr = mulberry(77), pos = new Float32Array(120 * 3); for (let i = 0; i < 120; i++) { const a = rr() * Math.PI * 2, e = 0.15 + rr() * 1.2, r = 300; pos[i * 3] = Math.cos(a) * Math.cos(e) * r; pos[i * 3 + 1] = Math.sin(e) * r; pos[i * 3 + 2] = Math.sin(a) * Math.cos(e) * r; } starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); }
      const starMat = track(own.mats, new THREE.PointsMaterial({ color: 0xffffff, size: 2, sizeAttenuation: false, fog: false, transparent: true, opacity: 0, depthWrite: false }));
      const stars = new THREE.Points(starGeo, starMat); stars.frustumCulled = false; stars.renderOrder = -2; scene.add(stars);

      const unit = track(own.geoms, new THREE.BoxGeometry(1, 1, 1));
      const cloudMat = track(own.mats, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.92 }));
      const clouds = [];
      { const rr = mulberry(seed * 31 + 5); for (let i = 0; i < 12; i++) { const cg = new THREE.Group(); const parts = 2 + ((rr() * 3) | 0); for (let k = 0; k < parts; k++) { const m = new THREE.Mesh(unit, cloudMat); m.scale.set(6 + rr() * 8, 1.6, 4 + rr() * 5); m.position.set(k * 5 - 4, rr() * 0.8, (rr() - 0.5) * 4); cg.add(m); } cg.position.set(rr() * 220 - 90, WZ + 14 + rr() * 8, rr() * 220 - 90); scene.add(cg); clouds.push(cg); } }

      // ----- chunks -----
      const NCX = Math.ceil(WX / CH), NCY = Math.ceil(WY / CH), NCZ = Math.ceil(WZ / CH);
      const chunks = [];
      for (let cz = 0; cz < NCZ; cz++) for (let cy = 0; cy < NCY; cy++) for (let cx = 0; cx < NCX; cx++) chunks.push({ cx: cx, cy: cy, cz: cz, opaque: null, trans: null, dirty: true, mx: cx * CH + CH / 2, my: cy * CH + CH / 2 });
      const chunkAt = (cx, cy, cz) => (cx < 0 || cy < 0 || cz < 0 || cx >= NCX || cy >= NCY || cz >= NCZ) ? null : chunks[(cz * NCY + cy) * NCX + cx];
      /** Mark the chunk holding (x, y, z) and any neighbour whose faces or shading it can change. */
      function markDirty(x, y, z) {
        for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const ch = chunkAt(Math.floor((x + dx) / CH), Math.floor((y + dy) / CH), Math.floor((z + dz) / CH));
          if (ch) ch.dirty = true;
        }
      }
      function setMesh(ch, slot, data, mat) {
        const old = ch[slot];
        if (old) { terrain.remove(old); old.geometry.dispose(); ch[slot] = null; }
        if (!data || !data.positions || data.positions.length === 0) return;
        const g = new THREE.BufferGeometry(), n = data.positions.length / 3;
        g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
        if (data.normals) g.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
        if (data.uvs) g.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
        if (data.colors) g.setAttribute('color', new THREE.BufferAttribute(data.colors, Math.round(data.colors.length / n) === 4 ? 4 : 3));
        g.setIndex(new THREE.BufferAttribute(data.indices, 1));
        const m = new THREE.Mesh(g, mat); m.matrixAutoUpdate = false; terrain.add(m); ch[slot] = m;
      }
      function rebuild(ch) {
        ch.dirty = false;
        let g = null;
        try { g = V.buildChunkGeometry(world, ch.cx, ch.cy, ch.cz); } catch (e) { g = null; }
        const o = g && (g.opaque || (g.positions ? g : null)), t = g && g.transparent;
        setMesh(ch, 'opaque', o, matOpaque); setMesh(ch, 'trans', t, matTrans);
      }
      function rebuildSome(px, py) {
        for (let n = 0; n < CHUNKS_PER_FRAME; n++) {
          let best = null, bd = 1e9;
          for (let i = 0; i < chunks.length; i++) {
            const ch = chunks[i];
            if (!ch.dirty) continue;
            const dx = ch.mx - px, dy = ch.my - py, d = dx * dx + dy * dy;
            if (d < bd) { bd = d; best = ch; }
          }
          if (!best) return;
          rebuild(best);
        }
      }

      // ----- animals -----
      const matCache = {};
      const lambert = (col) => matCache[col] || (matCache[col] = track(own.mats, new THREE.MeshLambertMaterial({ color: hexNum(col, 0xcccccc) })));
      const models = animals.map((a) => { const m = makeAnimal(THREE, a.kind, unit, lambert); m.face = a.yaw + Math.PI; m.phase = 0; scene.add(m.group); return m; });

      // ----- gems -----
      const gemColor = hexNum(spec && spec.items && spec.items.good && spec.items.good.color, 0xffd23f);
      const gemGeo = track(own.geoms, new THREE.OctahedronGeometry(0.26, 0));
      const gemMat = track(own.mats, new THREE.MeshLambertMaterial({ color: gemColor, emissive: gemColor, emissiveIntensity: 0.45 }));
      const sparkMat = track(own.mats, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }));
      const gemMeshes = gems.map((g) => { const m = new THREE.Mesh(gemGeo, gemMat); m.scale.y = 1.35; const s = new THREE.Mesh(gemGeo, sparkMat); s.scale.set(0.35, 0.5, 0.35); m.add(s); m.userData.key = g.x + ',' + g.y + ',' + g.z; m.userData.px = g.x + 0.5; m.userData.py = g.z + 0.8; m.userData.pz = g.y + 0.5; m.userData.spark = s; scene.add(m); return m; });

      // ----- my hero as a blocky character (seen from the map view; hidden in first person) -----
      const look = heroLook(spec && spec.hero);
      const faceCv = document.createElement('canvas'); faceCv.width = faceCv.height = 8; paintFace(faceCv, look);
      const faceTex = track(own.texs, new THREE.CanvasTexture(faceCv));
      faceTex.magFilter = THREE.NearestFilter; faceTex.minFilter = THREE.NearestFilter; faceTex.generateMipmaps = false;
      const avatar = makeAvatar(THREE, unit, lambert, track(own.mats, new THREE.MeshBasicMaterial({ map: faceTex })), look);
      const shadow = new THREE.Mesh(track(own.geoms, new THREE.CircleGeometry(0.55, 12)), track(own.mats, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })));
      shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.03; avatar.group.add(shadow);   // a soft blob under the feet
      avatar.group.visible = false; scene.add(avatar.group);

      // ----- selection outline, cracks, debris -----
      const edgeGeo = track(own.geoms, new THREE.EdgesGeometry(new THREE.BoxGeometry(1.012, 1.012, 1.012)));
      const outline = new THREE.LineSegments(edgeGeo, track(own.mats, new THREE.LineBasicMaterial({ color: 0x14202b, transparent: true, opacity: 0.85 })));
      outline.visible = false; outline.frustumCulled = false; scene.add(outline);
      const crackTex = track(own.texs, new THREE.CanvasTexture(makeCracks()));
      crackTex.magFilter = THREE.NearestFilter; crackTex.minFilter = THREE.NearestFilter; crackTex.generateMipmaps = false; crackTex.repeat.set(1 / 3, 1);
      const crack = new THREE.Mesh(unit, track(own.mats, new THREE.MeshBasicMaterial({ map: crackTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })));
      crack.scale.set(1.01, 1.01, 1.01); crack.visible = false; crack.frustumCulled = false; scene.add(crack);
      const debrisMat = track(own.mats, new THREE.MeshBasicMaterial({ color: 0x9a8f7a }));
      const debris = [];
      for (let i = 0; i < 10; i++) { const m = new THREE.Mesh(unit, debrisMat); m.scale.set(0.12, 0.12, 0.12); m.visible = false; scene.add(m); debris.push({ m: m, vx: 0, vy: 0, vz: 0, life: 0 }); }
      let debrisNext = 0;
      const puff = (x, y, z, col) => {
        debrisMat.color.setHex(col);
        for (let i = 0; i < 6; i++) { const d = debris[debrisNext]; debrisNext = (debrisNext + 1) % debris.length; d.m.position.set(x + (Math.random() - 0.5) * 0.6, y + (Math.random() - 0.5) * 0.6, z + (Math.random() - 0.5) * 0.6); d.vx = (Math.random() - 0.5) * 3; d.vy = 1 + Math.random() * 2.5; d.vz = (Math.random() - 0.5) * 3; d.life = 600; d.m.visible = true; }
      };
      const matColour = (id) => { const mm = Bk.MATERIALS[charById[id]]; return hexNum(mm && mm.top, 0x9a8f7a); };

      // ----- the held block (bottom right of the view) -----
      const handGeo = track(own.geoms, new THREE.BoxGeometry(1, 1, 1));
      const handUv0 = Float32Array.from(handGeo.attributes.uv.array);
      const handMat = track(own.mats, new THREE.MeshBasicMaterial({ map: atlasTex, fog: false, depthTest: false, transparent: true }));
      const hand = new THREE.Mesh(handGeo, handMat);
      hand.scale.set(0.22, 0.22, 0.22); hand.renderOrder = 999; hand.frustumCulled = false; camera.add(hand);
      let swing = 0;
      function tileUv(tile, arr, face) {                         // remap one BoxGeometry face's UVs into an atlas tile
        const col = tile % ATLAS_TILES, row = Math.floor(tile / ATLAS_TILES), s = 1 / ATLAS_TILES, uv = handGeo.attributes.uv.array;
        for (let i = 0; i < 4; i++) { uv[(face * 4 + i) * 2] = col * s + arr[(face * 4 + i) * 2] * s; uv[(face * 4 + i) * 2 + 1] = 1 - (row + 1) * s + arr[(face * 4 + i) * 2 + 1] * s; }
      }
      function heldChanged() {
        const id = idByChar[hotbar[c.sel]], b = V.BLOCKS[id];
        if (!b) return;
        const top = Number(b.top), side = Number(b.side), bottom = Number(b.bottom);
        for (let f = 0; f < 6; f++) tileUv(f === 2 ? top : f === 3 ? bottom : side, handUv0, f);
        handGeo.attributes.uv.needsUpdate = true;
        hand.visible = true;
      }
      api.current.heldChanged = heldChanged;
      api.current.flushNow = () => { if (saveTimer) { clearTimeout(saveTimer); flushSave(); } };
      heldChanged();

      // ----- sizing -----
      function resize() {
        const w = Math.max(1, box.clientWidth), h = Math.max(1, box.clientHeight);
        renderer.setSize(w, h, false);
        camera.aspect = w / h; camera.updateProjectionMatrix();
        hand.position.set(0.42 * camera.aspect / 1.3, -0.36, -0.7);
      }
      resize();
      let ro = null;
      try { if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(resize); ro.observe(box); } } catch (e) { ro = null; }
      on(window, 'resize', resize);

      // ----- saving what is built on the plot -----
      function flushSave() {
        saveTimer = 0;
        let build = null;
        try { build = V.plotToBuild(world); } catch (e) { build = null; }
        if (!build) { say('Keep at least one block on your plot so it can be saved.'); return; }
        try { if (R.current.onPlotChange) R.current.onPlotChange(build); } catch (e) { /* saving is the host's job */ }
        if (alive) { setSaved(true); if (savedTimer) clearTimeout(savedTimer); savedTimer = setTimeout(() => { savedTimer = 0; if (alive) setSaved(false); }, 2200); }
      }
      function afterEdit() {
        if (world.plotDirty) { world.plotDirty = false; if (saveTimer) clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, SAVE_DELAY); }
      }
      function say(text) { if (!alive) return; setNote(text); if (noteTimer) clearTimeout(noteTimer); noteTimer = setTimeout(() => { noteTimer = 0; if (alive) setNote(''); }, 2600); }

      // ----- input -----
      const typing = (e) => { const t = e.target && e.target.tagName; return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || (e.target && e.target.isContentEditable); };
      const cycle = (d) => { const n = hotbar.length || 1; const next = (c.sel + d + n) % n; c.sel = next; setSel(next); sfx('tick'); };
      api.current.cycle = cycle;
      /** Switch between my view (first person) and map view (from above). Building is off in map view. */
      const setView = (map) => { if (c.map === map) return; c.map = map; setMapView(map); if (map) { c.brk = false; c.put = false; } sfx('tick'); };
      api.current.setView = setView;
      const onKeyDown = (e) => {
        if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
        const k = String(e.key).toLowerCase();
        const dir = KEYS[k];
        if (dir) { if (c.active) e.preventDefault(); c[dir] = 1; return; }
        if (k === ' ') { if (c.active) e.preventDefault(); c.jump = true; return; }
        if (k === 'shift') { c.sprint = true; return; }
        if (k >= '1' && k <= '9') { const i = Number(k) - 1; if (i < hotbar.length) { c.sel = i; setSel(i); } return; }
        if (!c.active) return;
        if (k === 'v') { setView(false); return; }
        if (k === 'm') { if (!e.repeat) setView(!c.map); return; }
        if (k === 'b') { if (!e.repeat && api.current.fullscreen) api.current.fullscreen(); return; }
        if (k === 'f' || k === 'enter') { if (e.target && e.target.tagName === 'BUTTON') return; e.preventDefault(); c.brk = true; }
        else if (k === 'g') { c.put = true; }
        else if (k === 'e' || k === 'tab') { e.preventDefault(); cycle(1); }
        else if (k === 'q') { cycle(-1); }
      };
      const onKeyUp = (e) => {
        const k = String(e.key).toLowerCase(), dir = KEYS[k];
        if (dir) c[dir] = 0; else if (k === ' ') c.jump = false; else if (k === 'shift') c.sprint = false; else if (k === 'f' || k === 'enter') c.brk = false; else if (k === 'g') c.put = false;
      };
      const clearKeys = () => { c.f = c.b = c.l = c.r = 0; c.jump = c.sprint = c.brk = c.put = false; };
      on(window, 'keydown', onKeyDown); on(window, 'keyup', onKeyUp); on(window, 'blur', clearKeys);
      on(document, 'mousemove', (e) => { if (c.locked) { c.lookX += clamp(e.movementX || 0, -200, 200); c.lookY += clamp(e.movementY || 0, -200, 200); } });
      on(document, 'pointerlockchange', () => {
        const lockedNow = document.pointerLockElement === canvas;
        c.locked = lockedNow;
        if (lockedNow) { c.active = true; setPhase('playing'); }
        else if (c.active && !c.noLock && R.current.phase === 'playing') { c.active = false; clearKeys(); setPhase('paused'); }
      });
      on(document, 'pointerlockerror', () => { c.noLock = true; setNoLock(true); c.active = true; setPhase('playing'); say('Your browser would not hide the mouse. Drag to look around!'); });
      on(canvas, 'contextmenu', (e) => e.preventDefault());
      on(canvas, 'wheel', (e) => { if (!c.active) return; e.preventDefault(); cycle(e.deltaY > 0 ? 1 : -1); }, { passive: false });
      let dragId = -1, dragX = 0, dragY = 0;
      on(canvas, 'pointerdown', (e) => {
        if (e.pointerType === 'touch') return;                    // touch uses the on-screen zones
        if (!c.active) return;
        if (c.locked) { if (e.button === 2) c.put = true; else if (e.button === 0) c.brk = true; return; }
        if (c.noLock) { dragId = e.pointerId; dragX = e.clientX; dragY = e.clientY; try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* nicety */ } }
        else tryLock();
      });
      on(canvas, 'pointermove', (e) => { if (e.pointerId === dragId) { c.lookX += e.clientX - dragX; c.lookY += e.clientY - dragY; dragX = e.clientX; dragY = e.clientY; } });
      const upMouse = (e) => { if (e.pointerId === dragId) dragId = -1; if (e.pointerType !== 'touch') { if (e.button === 2) c.put = false; else if (e.button === 0) c.brk = false; } };
      on(canvas, 'pointerup', upMouse); on(canvas, 'pointercancel', upMouse);
      function tryLock() {
        try {
          const p = canvas.requestPointerLock && canvas.requestPointerLock();
          if (p && typeof p.catch === 'function') p.catch(() => { c.noLock = true; setNoLock(true); c.active = true; setPhase('playing'); });
          if (!canvas.requestPointerLock) { c.noLock = true; setNoLock(true); c.active = true; setPhase('playing'); }
        } catch (e) { c.noLock = true; setNoLock(true); c.active = true; setPhase('playing'); }
      }
      api.current.start = () => { c.active = true; setPhase('playing'); if (!R.current.touch && !c.noLock) tryLock(); };
      api.current.keepGoing = () => { c.active = true; setPhase('playing'); if (!R.current.touch && !c.noLock) tryLock(); };
      api.current.leave = () => { try { if (document.pointerLockElement === canvas && document.exitPointerLock) document.exitPointerLock(); } catch (e) { /* leaving anyway */ } };
      on(document, 'visibilitychange', () => {
        hidden = document.hidden;
        if (hidden) { if (raf) cancelAnimationFrame(raf); raf = 0; clearKeys(); }
        else if (!raf && alive) { last = 0; raf = requestAnimationFrame(frame); }
      });
      on(canvas, 'webglcontextlost', (e) => { e.preventDefault(); setFail('lost'); });
      on(document, 'fullscreenchange', () => setFull(!!document.fullscreenElement));
      api.current.fullscreen = () => { try { if (document.fullscreenElement) document.exitFullscreen(); else if (box.requestFullscreen) box.requestFullscreen(); } catch (e) { /* fullscreen is a nicety */ } };

      // ----- the frame loop -----
      let tod = V.timeOfDay(0), last = 0, clock = 0, hitNow = null, crackKey = '', crackT = 0, placeCd = 0, bob = 0, hudKey = '', wasUnder = false, domeT = 1e9, fov = 72, ended = false;
      let mapT = 0, mapNoteCd = 0, avFace = player.yaw + Math.PI, avPhase = 0, avAmp = 0;   // map-view blend (0 = my view, 1 = map), note timer, avatar heading / walk cycle
      const t0 = DAY_MS * 0.1;                                    // start a little after sunrise
      const eye = { x: 0, y: 0, z: 0 }, dir = { x: 0, y: 0, z: 0 };
      const input = { mx: 0, mz: 0, jump: false, yawDelta: 0, pitchDelta: 0, sprint: false };
      const col = new THREE.Color(), colTop = new THREE.Color(), colBot = new THREE.Color();
      let startedAt = performance.now();

      /** Forward unit vector (voxel space, z up) for a yaw / pitch pair. */
      function lookDir(yaw, pitch, out) {                          // same maths as AIXVoxel.lookDir, without a new object per frame
        const cp = Math.cos(pitch);
        out.x = -Math.sin(yaw) * cp; out.y = -Math.cos(yaw) * cp; out.z = Math.sin(pitch);
      }

      function updateSky(tod) {
        colTop.set(tod.skyTop); colBot.set(tod.skyBottom);
        for (let i = 0; i < domeN; i++) {
          const y = domePos.getY(i) / 320, t = y <= 0 ? 0 : Math.pow(y, 0.6);
          domeCol.setXYZ(i, colBot.r + (colTop.r - colBot.r) * t, colBot.g + (colTop.g - colBot.g) * t, colBot.b + (colTop.b - colBot.b) * t);
        }
        domeCol.needsUpdate = true;
        scene.fog.color.copy(colBot);
        const amb = clamp(tod.ambient, 0.3, 1);
        matOpaque.color.setScalar(amb); matTrans.color.setScalar(amb); cloudMat.color.setScalar(0.55 + 0.45 * amb);
        hemi.intensity = 0.35 + 0.6 * amb; sunLight.intensity = 0.15 + 0.6 * clamp(tod.sun, 0, 1);
        starMat.opacity = clamp(1 - tod.sun * 1.6, 0, 1) * 0.9;
      }

      function frame(ts) {
        raf = 0;
        if (!alive || hidden) return;
        const dtMs = last ? Math.min(ts - last, 50) : 16; last = ts;
        clock += dtMs;

        // physics
        let fwd = c.f - c.b, str = c.r - c.l;
        fwd += -c.jy; str += c.jx;
        input.mz = clamp(fwd, -1, 1); input.mx = clamp(str, -1, 1);
        input.jump = c.jump; input.sprint = c.sprint;
        const look3 = c.active && !c.map;                           // mouse and drag look are off in map view
        input.yawDelta = look3 ? -c.lookX * 0.0024 : 0; input.pitchDelta = look3 ? -c.lookY * 0.0024 : 0;
        c.lookX = 0; c.lookY = 0;
        if (!c.active) { input.mx = 0; input.mz = 0; input.jump = false; input.yawDelta = 0; input.pitchDelta = 0; }
        player = V.physics(player, input, world, dtMs) || player;

        // camera
        const moving = c.active && (input.mx !== 0 || input.mz !== 0) && player.onGround;
        bob = moving && motion ? bob + dtMs * 0.012 * (c.sprint ? 1.4 : 1) : bob;
        const bobY = moving && motion ? Math.sin(bob) * 0.04 : 0;
        eye.x = player.x; eye.y = player.y; eye.z = player.z + EYE + bobY;
        lookDir(player.yaw, player.pitch, dir);
        // ease between my view and map view (no easing when the kid prefers reduced motion)
        const goal = c.map ? 1 : 0;
        mapT = motion ? mapT + (goal - mapT) * (1 - Math.exp(-dtMs / 120)) : goal;
        if (Math.abs(goal - mapT) < 0.004) mapT = goal;
        const mv = mapT * mapT * (3 - 2 * mapT);
        // map camera: MAP_H above the player, looking down, yaw kept as it was so up on screen is forward
        const fx = -Math.sin(player.yaw), fy = -Math.cos(player.yaw);
        camera.position.set(eye.x + (player.x - fx * MAP_BACK - eye.x) * mv, eye.z + (player.z + MAP_H - eye.z) * mv, eye.y + (player.y - fy * MAP_BACK - eye.y) * mv);
        camera.rotation.y = player.yaw; camera.rotation.x = player.pitch + (MAP_PITCH - player.pitch) * mv;
        hand.visible = mv < 0.02;
        const wantFov = 72 + (c.sprint && moving ? 8 : 0);
        if (Math.abs(wantFov - fov) > 0.2) { fov += (wantFov - fov) * 0.15; camera.fov = fov; camera.updateProjectionMatrix(); }

        // water tint + fog
        const inWater = mv < 0.5 && isWater(V.get(world, Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z)));
        if (inWater !== wasUnder) { wasUnder = inWater; setUnder(inWater); }
        scene.fog.near = inWater ? 0.5 : 24 + 20 * mv; scene.fog.far = inWater ? 18 : MAX_RENDER_CHUNKS * CH + 140 * mv;   // map view sees much further

        // what am I looking at
        hitNow = null;
        mapNoteCd = Math.max(0, mapNoteCd - dtMs);
        if (c.active && c.map && (c.brk || c.put) && mapNoteCd === 0) { mapNoteCd = 2600; say('Switch to My view to build.'); }
        if (c.active && !c.map) {
          const h = V.raycast(world, eye, dir, REACH);
          if (h && !isWater(h.id)) hitNow = h;
        }
        if (hitNow) {
          outline.visible = true; outline.position.set(hitNow.x + 0.5, hitNow.z + 0.5, hitNow.y + 0.5);
        } else outline.visible = false;

        // break (hold) and place (tap or hold)
        placeCd = Math.max(0, placeCd - dtMs);
        if (c.active && c.brk && hitNow) {
          const key = hitNow.x + ',' + hitNow.y + ',' + hitNow.z;
          if (key !== crackKey) { crackKey = key; crackT = 0; }
          crackT += dtMs; swing = Math.max(swing, 0.5);
          const stage = Math.min(2, Math.floor((crackT / BREAK_MS) * 3));
          crack.visible = true; crack.position.copy(outline.position); crackTex.offset.x = stage / 3;
          if (crackT >= BREAK_MS) {
            const res = V.breakBlock(world, hitNow, player);
            if (res && res.ok) { markDirty(hitNow.x, hitNow.y, hitNow.z); puff(hitNow.x + 0.5, hitNow.z + 0.5, hitNow.y + 0.5, matColour(hitNow.id)); sfx('tick'); afterEdit(); }
            else { sfx('oops'); say('That block cannot be broken.'); }
            crackKey = ''; crackT = 0; crack.visible = false;
          }
        } else { crackKey = ''; crackT = 0; crack.visible = false; }
        if (c.active && c.put && placeCd === 0 && hitNow) {
          placeCd = 260; swing = 1;
          const id = idByChar[hotbar[c.sel]];
          const res = id !== undefined ? V.place(world, player, hitNow, id) : null;
          if (res && res.ok) { markDirty(hitNow.x + hitNow.face.nx, hitNow.y + hitNow.face.ny, hitNow.z + hitNow.face.nz); sfx('pop'); afterEdit(); }
          else { sfx('oops'); say('You cannot put a block there.'); }
        }
        if (swing > 0) { swing = Math.max(0, swing - dtMs / 220); hand.rotation.set(-swing * 0.7, 0.5 - swing * 0.2, 0); } else hand.rotation.set(0, 0.5, 0);

        // animals
        animals = V.stepCritters(animals, world, dtMs) || animals;
        for (let i = 0; i < models.length && i < animals.length; i++) {
          const a = animals[i], m = models[i], walking = a.moving === true;
          const want = fin0(a.yaw) + Math.PI;                  // AIXVoxel walks along (-sin yaw, -cos yaw); the model faces +z
          let d = want - m.face; d = Math.atan2(Math.sin(d), Math.cos(d)); m.face += d * 0.2;
          if (walking) m.phase += dtMs * 0.012;
          m.group.position.set(a.x, a.z, a.y); m.group.rotation.y = m.face;
          const sw = walking ? Math.sin(m.phase) * 0.7 : 0;
          m.legs[0].rotation.x = sw; m.legs[3].rotation.x = sw; m.legs[1].rotation.x = -sw; m.legs[2].rotation.x = -sw;
          m.head.rotation.x = walking ? 0 : Math.sin(clock / 700 + i) * 0.12;
        }

        // my character: faces the way it walks, swings arms and legs, bobs when still
        avatar.group.visible = mv > 0.15;
        if (avatar.group.visible) {
          const spd = Math.sqrt(fin0(player.vx) * fin0(player.vx) + fin0(player.vy) * fin0(player.vy)), walking = c.active && spd > 0.4 && player.onGround;
          if (spd > 0.4) { let d = Math.atan2(fin0(player.vx), fin0(player.vy)) - avFace; d = Math.atan2(Math.sin(d), Math.cos(d)); avFace += d * 0.25; }
          if (walking) avPhase += dtMs * 0.012 * (c.sprint ? 1.4 : 1);
          avAmp += ((walking && motion ? 0.8 : 0) - avAmp) * 0.2;
          const sw = Math.sin(avPhase) * avAmp;
          avatar.group.position.set(player.x, player.z, player.y); avatar.group.rotation.y = avFace;
          avatar.legs[0].rotation.x = sw; avatar.legs[1].rotation.x = -sw; avatar.arms[0].rotation.x = -sw; avatar.arms[1].rotation.x = sw;
          avatar.upper.position.y = motion ? Math.sin(clock / 450) * 0.015 * (1 - avAmp) : 0;
        }

        // gems
        if (gems.length) {
          const got = V.collect(player, gems);
          if (got && Array.isArray(got.gems) && got.gems.length !== gems.length) {
            const keep = {}; got.gems.forEach((g) => { keep[g.x + ',' + g.y + ',' + g.z] = true; });
            gemMeshes.forEach((m) => { if (!keep[m.userData.key]) m.visible = false; });
            gems = got.gems; sfx('good');
            if (gems.length === 0 && totalGems > 0 && !ended) {
              ended = true; sfx('win'); c.active = false; clearKeys(); api.current.leave(); setPhase('won');
              try { if (R.current.onEnd) R.current.onEnd({ status: 'won', score: totalGems, lives: (spec.rules && spec.rules.lives) || 0, seconds: Math.round((performance.now() - startedAt) / 100) / 10, template: 'blocks', title: spec.title }); } catch (e) { /* the host's problem */ }
            }
          }
        }
        const key = (totalGems - gems.length) + '/' + totalGems;
        if (key !== hudKey) { hudKey = key; setHud({ got: totalGems - gems.length, total: totalGems }); }
        for (let i = 0; i < gemMeshes.length; i++) {
          const m = gemMeshes[i]; if (!m.visible) continue;
          const bobG = motion ? Math.sin(clock / 400 + i) * 0.1 : 0;
          m.position.set(m.userData.px, m.userData.py + bobG, m.userData.pz);
          m.scale.set(1 + 1.2 * mv, 1.35 * (1 + 1.2 * mv), 1 + 1.2 * mv);   // bigger from far above so they stay easy to spot
          if (motion) { m.rotation.y = clock / 500 + i; m.userData.spark.rotation.y = -clock / 300; }
        }

        // debris
        for (let i = 0; i < debris.length; i++) {
          const d = debris[i]; if (!d.m.visible) continue;
          d.life -= dtMs; if (d.life <= 0) { d.m.visible = false; continue; }
          d.vy -= 9 * dtMs / 1000; d.m.position.x += d.vx * dtMs / 1000; d.m.position.y += d.vy * dtMs / 1000; d.m.position.z += d.vz * dtMs / 1000;
        }

        // sky and time of day (recoloured about ten times a second)
        domeT += dtMs;
        const tms = t0 + clock;
        if (domeT > 100) { domeT = 0; tod = V.timeOfDay(tms); updateSky(tod); }
        const ph = tod.phase * Math.PI * 2, sx = Math.cos(ph), sy = tod.elev;   // elev = sin(phase * 2 pi): the sun's height
        dome.position.copy(camera.position); stars.position.copy(camera.position);
        sunSpr.position.set(camera.position.x + sx * 280, camera.position.y + sy * 280, camera.position.z + 60); sunSpr.visible = sy > -0.15;
        moonSpr.position.set(camera.position.x - sx * 280, camera.position.y - sy * 280, camera.position.z - 60); moonSpr.visible = sy < 0.15;
        sunLight.position.set(sx, Math.max(0.2, sy), 0.3);
        if (motion) for (let i = 0; i < clouds.length; i++) { const cl = clouds[i]; cl.position.x += dtMs * 0.0009 * (1 + (i % 3) * 0.4); if (cl.position.x > 130) cl.position.x = -110; }

        rebuildSome(player.x, player.y);
        renderer.render(scene, camera);
        raf = requestAnimationFrame(frame);
      }
      raf = requestAnimationFrame(frame);

      return () => {
        alive = false;
        if (raf) cancelAnimationFrame(raf); raf = 0;
        if (savedTimer) clearTimeout(savedTimer);
        if (noteTimer) clearTimeout(noteTimer);
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; flushSave(); }   // the last edit must not be lost
        listeners.forEach((l) => { try { l[0].removeEventListener(l[1], l[2], l[3]); } catch (e) { /* already gone */ } });
        if (ro) { try { ro.disconnect(); } catch (e) { /* already gone */ } }
        try { if (document.pointerLockElement === canvas && document.exitPointerLock) document.exitPointerLock(); } catch (e) { /* leaving anyway */ }
        chunks.forEach((ch) => { if (ch.opaque) ch.opaque.geometry.dispose(); if (ch.trans) ch.trans.geometry.dispose(); ch.opaque = ch.trans = null; });
        own.geoms.forEach((g) => g.dispose()); own.mats.forEach((m) => m.dispose()); own.texs.forEach((t) => t.dispose());
        handGeo.dispose();
        renderer.dispose();
        try { renderer.forceContextLoss(); } catch (e) { /* older contexts */ }
        api.current = {};
      };
    }, [spec, missing]);   // eslint-disable-line react-hooks/exhaustive-deps

    // ---------- touch zones: floating joystick on the left, look-drag on the right ----------
    const zone = React.useRef({ stick: -1, look: -1, ox: 0, oy: 0, lx: 0, ly: 0 });
    const STICK_R = 52;
    const moveKnob = (dx, dy) => { const k = knobRef.current; if (k) k.style.transform = `translate(${dx}px, ${dy}px)`; };
    const stickDown = (e) => {
      if (!ctl.current.active) return;
      e.preventDefault(); setTouch(true);
      const z = zone.current, r = e.currentTarget.getBoundingClientRect();
      z.stick = e.pointerId; z.ox = e.clientX; z.oy = e.clientY;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* nicety */ }
      const s = stickRef.current; if (s) { s.style.display = 'block'; s.style.left = (e.clientX - r.left - STICK_R) + 'px'; s.style.top = (e.clientY - r.top - STICK_R) + 'px'; }
      moveKnob(0, 0);
    };
    const stickMove = (e) => {
      const z = zone.current; if (e.pointerId !== z.stick) return;
      let dx = e.clientX - z.ox, dy = e.clientY - z.oy; const len = Math.sqrt(dx * dx + dy * dy);
      if (len > STICK_R) { dx = dx / len * STICK_R; dy = dy / len * STICK_R; }
      ctl.current.jx = Math.abs(dx) < 6 ? 0 : dx / STICK_R; ctl.current.jy = Math.abs(dy) < 6 ? 0 : dy / STICK_R; moveKnob(dx, dy);
    };
    const stickUp = (e) => { const z = zone.current; if (e.pointerId !== z.stick) return; z.stick = -1; ctl.current.jx = 0; ctl.current.jy = 0; const s = stickRef.current; if (s) s.style.display = 'none'; };
    const lookDown = (e) => { if (!ctl.current.active) return; e.preventDefault(); setTouch(true); const z = zone.current; z.look = e.pointerId; z.lx = e.clientX; z.ly = e.clientY; try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* nicety */ } };
    const lookMove = (e) => { const z = zone.current; if (e.pointerId !== z.look) return; ctl.current.lookX += (e.clientX - z.lx) * 1.7; ctl.current.lookY += (e.clientY - z.ly) * 1.7; z.lx = e.clientX; z.ly = e.clientY; };
    const lookUp = (e) => { const z = zone.current; if (e.pointerId === z.look) z.look = -1; };

    // ---------- render ----------
    if (missing) return <Fallback onExit={onExit} body="The 3D tools are still loading. Give it a second, or keep playing and building in the flat view." />;
    if (fail) return <Fallback onExit={onExit} body={fail === 'lost' ? 'The 3D picture got interrupted. Your world is safe! Go back and try Explore 3D again.' : undefined} />;

    const showPad = touch || noLock;
    /** Leaving saves any plot change still waiting, so the flat view starts from the latest build. */
    const exit = () => { if (api.current.flushNow) api.current.flushNow(); onExit(); };
    const hbBtn = (ch, i) => {
      const b = Bk.MATERIALS[ch], vb = V.BLOCKS, id = Object.keys(vb).filter((k) => vb[k] && vb[k].char === ch)[0], tile = id !== undefined ? Number(vb[id].side) : 0;
      const col = tile % 16, row = Math.floor(tile / 16);
      return (
        <button key={ch} type="button" aria-label={`${b.name}, slot ${i + 1}`} aria-pressed={sel === i} title={b.name} onClick={() => setSel(i)}
          style={{ width: TAP, height: TAP, minWidth: TAP, padding: 0, borderRadius: 8, border: `3px solid ${sel === i ? '#fff' : 'rgba(255,255,255,.35)'}`, backgroundColor: b.top, backgroundImage: atlasUrl.current ? `url(${atlasUrl.current})` : 'none', backgroundRepeat: 'no-repeat',
            backgroundSize: '1600% 1600%', backgroundPosition: `${col / 15 * 100}% ${row / 15 * 100}%`, imageRendering: 'pixelated', cursor: 'pointer', flex: '0 0 auto', boxShadow: sel === i ? '0 0 0 2px rgba(20,32,43,.6)' : 'none' }} />
      );
    };
    const goodName = (spec && spec.items && spec.items.good && spec.items.good.name) || 'treasures';
    const overlay = (title, body, buttons) => (
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(10,18,28,.62)', padding: 16, zIndex: 20 }}>
        <div role="status" aria-live="polite" style={{ textAlign: 'center', color: '#fff', maxWidth: 420 }}>
          <div style={{ fontSize: 26, fontWeight: 800, marginBottom: 8, lineHeight: 1.15 }}>{title}</div>
          <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.4, marginBottom: 16 }}>{body}</div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>{buttons}</div>
        </div>
      </div>
    );
    const goBtn = (label, fn) => <button type="button" autoFocus onClick={fn} style={btnStyle(accent, { padding: '0 28px', borderRadius: 999 })}>{label}</button>;
    const backBtn = <button type="button" onClick={exit} style={Object.assign({}, ghostStyle, { background: 'rgba(255,255,255,.92)' })}>Back</button>;

    return (
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <div ref={boxRef} style={{ position: 'relative', width: '100%', height: 'min(76vh, 620px)', minHeight: 320, borderRadius: 18, overflow: 'hidden', background: '#bfe3ff', border: `1.5px solid ${LINE}`, touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none' }}>
          <canvas ref={canvasRef} aria-label={`${(spec && spec.title) || 'Block world'}. A 3D world you can walk around in and build.`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} />
          {under && <div aria-hidden="true" style={{ position: 'absolute', inset: 0, background: 'rgba(40,110,200,.35)', pointerEvents: 'none' }} />}

          {/* crosshair (not in map view) */}
          {!mapView && <div aria-hidden="true" style={{ position: 'absolute', left: '50%', top: '50%', width: 22, height: 22, marginLeft: -11, marginTop: -11, pointerEvents: 'none', mixBlendMode: 'difference' }}>
            <div style={{ position: 'absolute', left: 10, top: 0, width: 2, height: 22, background: '#fff' }} /><div style={{ position: 'absolute', left: 0, top: 10, width: 22, height: 2, background: '#fff' }} />
          </div>}

          {/* top bar */}
          <div style={{ position: 'absolute', left: 10, right: 10, top: 10, display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', pointerEvents: 'none', zIndex: 10 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {hud.total > 0 && <span role="status" style={{ padding: '6px 12px', borderRadius: 999, background: 'rgba(20,32,43,.55)', color: '#fff', fontSize: 15, fontWeight: 800 }}>{hud.got} of {hud.total} {goodName}</span>}
              {saved && <span role="status" style={{ padding: '6px 12px', borderRadius: 999, background: 'rgba(47,160,90,.85)', color: '#fff', fontSize: 14, fontWeight: 800 }}>Plot saved</span>}
            </div>
            <div style={{ display: 'flex', gap: 8, pointerEvents: 'auto', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <button type="button" aria-label="My view, first person (V)" aria-pressed={!mapView} onClick={() => api.current.setView && api.current.setView(false)} style={Object.assign({}, glassBtn, !mapView ? { background: 'rgba(20,32,43,.85)' } : null)}>My view</button>
              <button type="button" aria-label="Map view, from above (M)" aria-pressed={mapView} onClick={() => api.current.setView && api.current.setView(true)} style={Object.assign({}, glassBtn, mapView ? { background: 'rgba(20,32,43,.85)' } : null)}>Map view</button>
              <button type="button" aria-label={full ? 'Small screen (B)' : 'Big screen (B)'} aria-pressed={full} onClick={() => api.current.fullscreen && api.current.fullscreen()} style={glassBtn}>{full ? 'Small' : 'Big'}</button>
              <button type="button" onClick={exit} style={glassBtn}>Back</button>
            </div>
          </div>
          {note && <div role="status" aria-live="polite" style={{ position: 'absolute', left: 10, right: 10, top: 64, textAlign: 'center', color: '#fff', fontSize: 15, fontWeight: 800, textShadow: '0 1px 3px rgba(0,0,0,.7)', pointerEvents: 'none', zIndex: 10 }}>{note}</div>}

          {/* touch zones (below the buttons) */}
          {showPad && phase === 'playing' && (
            <>
              <div onPointerDown={stickDown} onPointerMove={stickMove} onPointerUp={stickUp} onPointerCancel={stickUp} onContextMenu={(e) => e.preventDefault()}
                style={{ position: 'absolute', left: 0, top: 70, bottom: 0, width: '40%', touchAction: 'none', zIndex: 5 }}>
                <div aria-hidden="true" style={{ position: 'absolute', left: 18, bottom: 84, width: 104, height: 104, borderRadius: '50%', border: '3px solid rgba(255,255,255,.4)', background: 'rgba(255,255,255,.1)', pointerEvents: 'none' }} />
                <div ref={stickRef} aria-hidden="true" style={{ display: 'none', position: 'absolute', width: 104, height: 104, borderRadius: '50%', border: '3px solid rgba(255,255,255,.7)', background: 'rgba(255,255,255,.15)', pointerEvents: 'none' }}>
                  <div ref={knobRef} style={{ position: 'absolute', left: 32, top: 32, width: 40, height: 40, borderRadius: '50%', background: 'rgba(255,255,255,.85)' }} />
                </div>
              </div>
              <div onPointerDown={lookDown} onPointerMove={lookMove} onPointerUp={lookUp} onPointerCancel={lookUp} onContextMenu={(e) => e.preventDefault()}
                style={{ position: 'absolute', right: 0, top: 70, bottom: 0, width: '60%', touchAction: 'none', zIndex: 4 }} />
              <div style={{ position: 'absolute', right: 12, bottom: 78, display: 'grid', gridTemplateColumns: 'auto auto', gap: 10, alignItems: 'end', justifyItems: 'end', zIndex: 8 }}>
                <HoldButton label="Break the block" text="Break" size={60} bg="rgba(229,72,77,.85)" set={(v) => { ctl.current.brk = v; }} />
                <HoldButton label="Jump" text="Jump" size={72} bg="rgba(47,111,237,.88)" set={(v) => { ctl.current.jump = v; }} />
                <HoldButton label="Place a block" text="Place" size={60} bg="rgba(47,160,90,.88)" set={(v) => { ctl.current.put = v; }} />
                <HoldButton label="Next block" text="Next" size={TAP} bg="rgba(20,32,43,.65)" set={(v) => { if (v) api.current.cycle && api.current.cycle(1); }} />
              </div>
            </>
          )}

          {/* shortcut hints (keyboard players only; touch players have the buttons) */}
          {!touch && (
            <div role="group" aria-label="Keyboard shortcuts" style={{ position: 'absolute', left: 8, right: 8, bottom: 70, display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap', pointerEvents: 'none', zIndex: 9 }}>
              {HINTS.map((h) => (
                <span key={h[0]} style={{ padding: '3px 9px', borderRadius: 999, background: 'rgba(20,32,43,.5)', color: '#fff', fontSize: 12, fontWeight: 700 }}>
                  <kbd style={{ fontFamily: 'inherit', fontWeight: 800, padding: '0 5px', marginRight: 5, borderRadius: 5, background: 'rgba(255,255,255,.25)' }}>{h[0]}</kbd>{h[1]}
                </span>
              ))}
            </div>
          )}

          {/* hotbar */}
          <div role="group" aria-label="Blocks to build with" style={{ position: 'absolute', left: 8, right: 8, bottom: 8, display: 'flex', gap: 3, justifyContent: 'center', overflowX: 'auto', padding: 4, borderRadius: 12, background: 'rgba(20,32,43,.45)', zIndex: 9, maxWidth: 'max-content', margin: '0 auto' }}>
            {hotbar.map(hbBtn)}
          </div>

          {phase === 'ready' && overlay('Explore your world!', (touch ? 'Left thumb walks, right thumb looks around. Tap Break and Place to change the world.' : 'Click to start. WASD walks, Space jumps, mouse looks. Left click breaks, right click places, 1 to 9 picks a block.') + ' ' + (hud.total > 0 ? `Find all the ${goodName}! ` : '') + 'Your hero from Game Studio is your character. ' + (touch ? 'Tap Map view to see it.' : 'Press M to see it.'), <>{goBtn('Start', () => api.current.start && api.current.start())}{backBtn}</>)}
          {phase === 'paused' && overlay('Paused', 'Take your time. Your world waits for you.', <>{goBtn('Keep exploring', () => api.current.keepGoing && api.current.keepGoing())}{backBtn}</>)}
          {phase === 'won' && overlay('You found them all!', `Every ${goodName} is yours. Your world is still here to explore.`, <>{goBtn('Keep exploring', () => api.current.keepGoing && api.current.keepGoing())}{backBtn}</>)}
        </div>
        <div style={{ textAlign: 'center', fontSize: 12.5, color: MUTE, marginTop: 10, fontWeight: 600 }}>
          Blocks you add or break on your 12 by 12 plot are saved. Building anywhere else is just for fun and goes away when you leave. Keys: Space jumps, F breaks, G places, E or Q changes block, V is My view, M is Map view, B is Big.
        </div>
      </div>
    );
  }

  window.AIX_FP = { ExploreView: ExploreView };
})();
