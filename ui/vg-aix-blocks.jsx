/* ============================================================
   AI Explorers — Block Builder player: an isometric block world on a <canvas>.
   Three modes on the same world. EXPLORE 3D (vg-aix-fp.jsx) is a first-person walk-and-build view of a big world around the 12 x 12 plot. BUILD: tap a column to stack a block (or take one away), undo/redo, start over.
   PLAY: walk the hero (tap a tile, arrows / WASD, or the on-screen pad), jump, collect, dodge the silly critters.
   All rules live in AIXBlocks (pure engine, vg-aix-blocks.js); this file only draws, reads input and reports back.
   The world is data (a spec with a `build` grid), never code. Text is React text only; the canvas draws shapes from numbers.
   Respects prefers-reduced-motion, pauses when the tab is hidden, stops its frame loop when idle in build mode,
   and removes every listener / timer / frame request on unmount. Everything is reachable by keyboard.
   ============================================================ */
(function () {
  const TAP = 48;                                   // px, minimum touch target (spec says >= 44)
  const W = 600, H = 470;                           // canvas backing resolution; CSS scales it
  const TILE = 44;                                  // px width of one isometric tile
  const INK = '#14202b', MUTE = '#5b6b79', LINE = '#e4e8ec';
  const sfx = (n) => { try { if (typeof window.aixSfx === 'function') window.aixSfx(n); } catch (e) { /* sound is optional */ } };
  const reduced = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ---------- geometry: derived from AIXBlocks.project so the picture and the tap-picking always agree ----------
  /** Centre the whole 12 x 12 x 6 box in the canvas and return a fast affine projector P(x, y, z) -> {sx, sy}. */
  function makeGeometry(Bk) {
    const S = Bk.SIZE, M = Bk.MAX_LAYERS, v0 = { tile: TILE, ox: 0, oy: 0 };
    const pts = [Bk.project(0, 0, M, v0), Bk.project(S, 0, 0, v0), Bk.project(0, S, 0, v0), Bk.project(S, S, 0, v0)];
    const xs = pts.map((p) => p.sx), ys = pts.map((p) => p.sy);
    const minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs), minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    const view = { tile: TILE, ox: (W - (maxX - minX)) / 2 - minX, oy: (H - (maxY - minY)) / 2 - minY + 8 };
    const o = Bk.project(0, 0, 0, view), ex = Bk.project(1, 0, 0, view), ey = Bk.project(0, 1, 0, view), ez = Bk.project(0, 0, 1, view);
    const P = (x, y, z) => ({ sx: o.sx + (ex.sx - o.sx) * x + (ey.sx - o.sx) * y + (ez.sx - o.sx) * z, sy: o.sy + (ex.sy - o.sy) * x + (ey.sy - o.sy) * y + (ez.sy - o.sy) * z });
    return { view: view, P: P };
  }

  function poly(ctx, pts, fill, stroke) {
    ctx.beginPath(); ctx.moveTo(pts[0].sx, pts[0].sy);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].sx, pts[i].sy);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.lineJoin = 'round'; ctx.stroke(); }
  }

  /** One cube whose bottom is at height z. mat = AIXBlocks.MATERIALS entry, key = its character. */
  function drawCube(ctx, g, x, y, z, key, mat, t, motion) {
    const P = g.P;
    const T0 = P(x, y, z + 1), T1 = P(x + 1, y, z + 1), T2 = P(x + 1, y + 1, z + 1), T3 = P(x, y + 1, z + 1);
    const B1 = P(x + 1, y, z), B2 = P(x + 1, y + 1, z), B3 = P(x, y + 1, z);
    const edge = 'rgba(20,32,43,.22)';
    ctx.save();
    if (key === 't') ctx.globalAlpha = 0.5;                     // glass: see-through
    else if (key === 'a') ctx.globalAlpha = 0.85;               // water
    poly(ctx, [T3, T2, B2, B3], mat.left, edge);
    poly(ctx, [T1, T2, B2, B1], mat.right, edge);
    poly(ctx, [T0, T1, T2, T3], mat.top, edge);
    ctx.globalAlpha = 1;
    const cx = (T0.sx + T2.sx) / 2, cy = (T0.sy + T2.sy) / 2;
    if (key === 'a' && motion) {                                // little ripples that drift
      const k = (Math.sin(t / 500 + x * 1.3 + y * 0.9) + 1) / 2;
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.25 + 0.35 * k) + ')'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(cx, cy, TILE * (0.12 + 0.1 * k), TILE * (0.06 + 0.05 * k), 0, 0, Math.PI * 2); ctx.stroke();
    } else if (key === 'j') {                                   // jelly gloss
      ctx.fillStyle = 'rgba(255,255,255,.45)'; ctx.beginPath(); ctx.ellipse(cx - TILE * 0.08, cy - TILE * 0.02, TILE * 0.13, TILE * 0.06, 0, 0, Math.PI * 2); ctx.fill();
    } else if (key === 't') {
      ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(T3.sx + 4, T3.sy + 6); ctx.lineTo(T3.sx + 4, B3.sy - 6); ctx.stroke();
    }
    ctx.restore();
  }

  /** Draw one actor (kid sprite or shape) standing at screen point (sx, sy). Falls back to a dot if the shared helper is missing. */
  function drawStander(ctx, actor, sx, sy, r, lift) {
    const D = window.AixDraw;
    ctx.save();
    ctx.fillStyle = 'rgba(20,32,43,.22)'; ctx.beginPath(); ctx.ellipse(sx, sy, r * 0.85, r * 0.4, 0, 0, Math.PI * 2); ctx.fill();   // soft shadow
    const cy = sy - r * 1.05 - lift;
    if (D && D.drawActor) D.drawActor(ctx, actor, sx / D.K, cy / D.K, r / D.K);
    else { ctx.fillStyle = (actor && actor.color) || '#ffd23f'; ctx.beginPath(); ctx.arc(sx, cy, r, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }

  function drawFlag(ctx, sx, sy, t, motion) {
    const wave = motion ? Math.sin(t / 220) * 3 : 0;
    ctx.save();
    ctx.fillStyle = 'rgba(20,32,43,.22)'; ctx.beginPath(); ctx.ellipse(sx, sy, TILE * 0.2, TILE * 0.09, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx, sy - TILE * 0.95); ctx.stroke();
    ctx.fillStyle = '#ffd23f'; ctx.beginPath(); ctx.moveTo(sx, sy - TILE * 0.95); ctx.lineTo(sx + TILE * 0.5 + wave, sy - TILE * 0.78); ctx.lineTo(sx, sy - TILE * 0.6); ctx.closePath(); ctx.fill();
    ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
  }

  /**
   * Paint one frame. ui = { g, disp, hover, cursor, mode, op, parts, t, motion }.
   * Painter's order: cells from the far corner (x + y small) to the near one; inside a cell blocks go bottom to top and then
   * whatever stands in that cell, so nearer blocks always cover what is behind them.
   */
  function drawFrame(ctx, Bk, st, ui) {
    const sp = st.spec, S = Bk.SIZE, g = ui.g, layers = st.build.layers, M = Bk.MATERIALS;
    const bg = sp.world.bg, D = window.AixDraw;
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    if (D && D.drawScenery) D.drawScenery(ctx, sp.world.theme, bg, ui.motion ? ui.t : 0, ui.motion);

    // who stands where (items stay put; hero + critters glide, so they use their on-screen cell)
    const stand = {};
    const put = (cx, cy, fn) => { const k = clamp(cy, 0, S - 1) * S + clamp(cx, 0, S - 1); (stand[k] = stand[k] || []).push(fn); };
    const at = (e, key) => ui.disp[key] || { x: e.x, y: e.y, z: Bk.heightAt(st.build, e.x, e.y) };
    st.items.forEach((it) => {
      const sc = g.P(it.x + 0.5, it.y + 0.5, Bk.heightAt(st.build, it.x, it.y));
      put(it.x, it.y, () => {
        if (it.kind === 'flag') drawFlag(ctx, sc.sx, sc.sy, ui.t, ui.motion);
        else drawStander(ctx, sp.items.good, sc.sx, sc.sy, TILE * 0.26, TILE * 0.18 + (ui.motion ? (Math.sin(ui.t / 260 + it.id) + 1) * 3 : 0));
      });
    });
    st.critters.forEach((c) => {
      const d = at(c, 'c' + c.id), sc = g.P(d.x + 0.5, d.y + 0.5, d.z);
      put(Math.round(d.x), Math.round(d.y), () => drawStander(ctx, sp.items.bad, sc.sx, sc.sy, TILE * 0.3, ui.motion ? Math.abs(Math.sin(ui.t / 200 + c.id)) * 3 : 0));
    });
    {
      const d = at(st.hero, 'hero'), sc = g.P(d.x + 0.5, d.y + 0.5, d.z), hop = ui.motion && d.moving ? Math.abs(Math.sin(ui.t / 70)) * 6 : 0;
      put(Math.round(d.x), Math.round(d.y), () => drawStander(ctx, sp.hero, sc.sx, sc.sy, TILE * 0.36, hop));
    }

    for (let diag = 0; diag <= 2 * (S - 1); diag++) {
      for (let x = Math.max(0, diag - S + 1); x <= Math.min(S - 1, diag); x++) {
        const y = diag - x;
        for (let z = 0; z < layers.length; z++) {
          const ch = layers[z][y].charAt(x);
          if (ch !== '.' && M[ch]) drawCube(ctx, g, x, y, z, ch, M[ch], ui.t, ui.motion);
        }
        const list = stand[y * S + x];
        if (list) list.forEach((fn) => fn());
      }
    }

    // outline of the column under the finger / mouse / keyboard cursor (build mode only)
    const mark = (cell, colour) => {
      if (!cell) return;
      const h = Bk.heightAt(st.build, cell.x, cell.y);
      poly(ctx, [g.P(cell.x, cell.y, h), g.P(cell.x + 1, cell.y, h), g.P(cell.x + 1, cell.y + 1, h), g.P(cell.x, cell.y + 1, h)], colour + '33', colour);
      ctx.lineWidth = 3; ctx.stroke();
    };
    if (ui.mode === 'build') { const col = ui.op === 'remove' ? '#e5484d' : '#ffd23f'; mark(ui.cursor, col); if (ui.hover) mark(ui.hover, col); }

    ui.parts.forEach((p) => { ctx.globalAlpha = Math.max(0, p.life / 600); ctx.fillStyle = p.color; ctx.fillRect(p.sx - 3, p.sy - 3, 6, 6); });
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // ---------- small UI pieces ----------
  const btnStyle = (accent, extra) => Object.assign({ minWidth: TAP, minHeight: TAP, padding: '0 18px', borderRadius: 14, border: 'none', background: accent, color: '#fff', fontSize: 16, fontWeight: 800, cursor: 'pointer', userSelect: 'none', WebkitUserSelect: 'none' }, extra || {});
  const ghostStyle = { minHeight: TAP, padding: '0 20px', borderRadius: 999, border: `1.5px solid ${LINE}`, background: '#fff', color: INK, fontSize: 15, fontWeight: 800, cursor: 'pointer' };
  const ARROW = { up: 'M4 17 L13 7 L22 17 Z', down: 'M4 9 L13 19 L22 9 Z', jump: 'M13 3 L22 13 H16 V23 H10 V13 H4 Z' };
  const HEART = 'M12 21 C3 14 3 6 8 5 C10.5 4.7 12 7 12 7 C12 7 13.5 4.7 16 5 C21 6 21 14 12 21 Z';

  /** Hold-to-press pad button (touch, mouse, pen). `rot` turns the arrow to point along an isometric diagonal. */
  function PadButton({ label, glyph, rot, set, accent }) {
    const down = (e) => { e.preventDefault(); set(true); };
    const up = () => set(false);
    return (
      <button type="button" aria-label={label} onPointerDown={down} onPointerUp={up} onPointerLeave={up} onPointerCancel={up} onContextMenu={(e) => e.preventDefault()}
        style={btnStyle(accent, { width: TAP + 16, height: TAP + 16, padding: 0, borderRadius: 18, display: 'grid', placeItems: 'center', touchAction: 'none' })}>
        <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true" style={{ transform: `rotate(${rot || 0}deg)` }}><path d={glyph} fill="#fff" /></svg>
      </button>
    );
  }

  /** A tiny cube drawn from a material's three face colours. */
  function CubeIcon({ mat, size }) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ display: 'block' }}>
        <polygon points="12,2 22,7 12,12 2,7" fill={mat.top} /><polygon points="2,7 12,12 12,22 2,17" fill={mat.left} /><polygon points="22,7 12,12 12,22 22,17" fill={mat.right} />
        <polygon points="12,2 22,7 22,17 12,22 2,17 2,7" fill="none" stroke="rgba(20,32,43,.35)" strokeWidth="1" strokeLinejoin="round" />
      </svg>
    );
  }

  const KEY_MOVE = { arrowleft: [-1, 0], a: [-1, 0], arrowright: [1, 0], d: [1, 0], arrowup: [0, -1], w: [0, -1], arrowdown: [0, 1], s: [0, 1] };

  /** Friendly words for a refused edit (the engine's own reason text is only used to pick between a few kind messages). */
  function refusal(reason) {
    const r = String(reason || '').toLowerCase();
    if (r.indexOf('hero') >= 0 || r.indexOf('stand') >= 0) return 'The hero is standing there. Walk away first!';
    if (r.indexOf('last') >= 0) return 'Keep at least one block in your world.';
    if (r.indexOf('height') >= 0 || r.indexOf('tall') >= 0 || r.indexOf('layer') >= 0 || r.indexOf('max') >= 0) return 'That tower is as tall as it can go!';
    return 'That spot will not work. Try another one!';
  }

  /**
   * Plays and edits a block world.
   * @param {{spec:Object, onEnd:(r:{status:string,score:number,lives:number,seconds:number,template:string,title:string})=>void, onExit:()=>void, onChange?:(spec:Object)=>void, theme?:{primary?:string}}} props
   */
  function BlocksPlayer({ spec, onEnd, onExit, onChange, theme }) {
    const accent = (theme && theme.primary) || '#2f6fed';
    const Bk = window.AIXBlocks, Lg = window.AIXStudioLogic;
    const check = React.useMemo(() => (Bk && window.AIXEngine ? window.AIXEngine.clientValidate(spec) : { ok: false }), [spec]);
    const [mode, setMode] = React.useState('play');            // play | build | explore (first-person 3D)
    const [phase, setPhase] = React.useState('ready');         // ready | playing | paused | ended (play mode only)
    const [op, setOp] = React.useState('place');               // place | remove
    const [mat, setMat] = React.useState('b');                 // chosen material character
    const [hud, setHud] = React.useState({ status: 'playing', score: 0, lives: 0, progress: 0, secs: 0 });
    const [hi, setHi] = React.useState({ u: false, r: false }); // can undo / redo
    const [note, setNote] = React.useState('');
    const [tick, setTick] = React.useState(0);                 // bumps after every edit so the aria-label follows the world

    const canvasRef = React.useRef(null);
    const st = React.useRef(null);                             // AIXBlocks state (changes every frame; not React state)
    const geo = React.useRef(null);
    const hist = React.useRef(null);
    const disp = React.useRef({});                             // on-screen (gliding) positions of hero + critters
    const parts = React.useRef([]);
    const keys = React.useRef({});
    const btn = React.useRef({ jump: false });
    const pend = React.useRef(null);                           // a tap-to-walk target waiting for the next step
    const jumpUntil = React.useRef(0);
    const hover = React.useRef(null);
    const cursor = React.useRef({ x: 0, y: 0 });
    const raf = React.useRef(0), last = React.useRef(0), clock = React.useRef(0);
    const ended = React.useRef(false), hudKey = React.useRef('');
    const timer = React.useRef(0);
    const R = React.useRef({});                                // latest values for the long-lived loop / listeners
    R.current = { mode: mode, phase: phase, op: op, mat: mat, onEnd: onEnd, onChange: onChange };

    if (check.ok && !st.current) {
      st.current = Bk.create(check.spec, 1);
      geo.current = makeGeometry(Bk);
      hist.current = Lg.emptyHistory();
      cursor.current = { x: st.current.hero ? st.current.hero.x : 0, y: st.current.hero ? st.current.hero.y : 0 };
    }

    // ---------- the frame loop: runs only while something moves (play mode, a glide, sparkles), then rests ----------
    function frame(ts) {
      raf.current = 0;
      const s = st.current, c = canvasRef.current;
      if (!s || !c) return;
      const dt = last.current ? Math.min(ts - last.current, 100) : 16; last.current = ts;
      const motion = !reduced(), rr = R.current;
      clock.current += dt;
      let again = false;

      if (rr.mode === 'play' && rr.phase === 'playing' && s.status === 'playing') {
        const k = keys.current, b = btn.current;
        let dx = ((k.arrowright || k.d) ? 1 : 0) - ((k.arrowleft || k.a) ? 1 : 0), dy = ((k.arrowdown || k.s) ? 1 : 0) - ((k.arrowup || k.w) ? 1 : 0);
        if (dx !== 0) dy = 0;                                   // one axis at a time: one cell per move
        const input = { jump: !!(k[' '] || b.jump || performance.now() < jumpUntil.current) };
        if (dx) input.dx = dx; if (dy) input.dy = dy;
        if (pend.current) { input.goTo = pend.current; pend.current = null; }
        const next = Bk.step(s, input, dt);
        st.current = next;
        (next.events || []).forEach((ev) => {
          if (ev.type === 'good') sfx('good'); else if (ev.type === 'bad') sfx('oops'); else if (ev.type === 'jump' || ev.type === 'bounce') sfx('pop');
          if (motion && (ev.type === 'good' || ev.type === 'bad' || ev.type === 'bounce') && ev.x !== undefined) {
            const p = geo.current.P(ev.x + 0.5, ev.y + 0.5, Bk.heightAt(next.build, ev.x, ev.y) + 0.5);
            for (let i = 0; i < 8; i++) parts.current.push({ sx: p.sx, sy: p.sy, vx: (Math.random() - 0.5) * 140, vy: -Math.random() * 120, life: 600, color: ev.type === 'bad' ? '#ff8fa3' : '#ffe066' });
          }
        });
        again = true;
        const key = [next.score, next.lives, next.status, Math.floor((next.progress || 0) * 50), next.spec.goal.kind === 'survive' ? Math.floor(next.t / 1000) : 0].join('|');
        if (key !== hudKey.current) { hudKey.current = key; setHud({ status: next.status, score: next.score, lives: next.lives, progress: next.progress || 0, secs: Math.floor(next.t / 1000) }); }
        if (next.status !== 'playing' && !ended.current) {
          ended.current = true; sfx(next.status === 'won' ? 'win' : 'oops'); setPhase('ended');
          try { if (rr.onEnd) rr.onEnd({ status: next.status, score: next.score, lives: next.lives, seconds: Math.round(next.t / 100) / 10, template: next.template, title: next.spec.title }); } catch (e) { /* the host's problem, not the game's */ }
          again = false;
        }
      }

      // glide the hero / critters toward their cells (snap when motion is reduced)
      const cur = st.current, a = motion ? 1 - Math.exp(-dt / 70) : 1;
      const glide = (key, e) => {
        const tz = Bk.heightAt(cur.build, e.x, e.y), d = disp.current[key] || { x: e.x, y: e.y, z: tz };
        d.x += (e.x - d.x) * a; d.y += (e.y - d.y) * a; d.z += (tz - d.z) * a;
        d.moving = Math.abs(e.x - d.x) + Math.abs(e.y - d.y) > 0.02;
        if (!d.moving) { d.x = e.x; d.y = e.y; d.z = tz; }
        disp.current[key] = d;
        return d.moving || Math.abs(tz - d.z) > 0.01;
      };
      if (glide('hero', cur.hero)) again = true;
      cur.critters.forEach((cr) => { if (glide('c' + cr.id, cr)) again = true; });
      parts.current = parts.current.filter((p) => { p.sx += p.vx * dt / 1000; p.sy += p.vy * dt / 1000; p.vy += 300 * dt / 1000; p.life -= dt; return p.life > 0; });
      if (parts.current.length) again = true;

      drawFrame(c.getContext('2d'), Bk, cur, { g: geo.current, disp: disp.current, hover: hover.current, cursor: cursor.current, mode: rr.mode, op: rr.op, parts: parts.current, t: clock.current, motion: motion });
      if (again) raf.current = requestAnimationFrame(frame);
    }
    /** Ask for a redraw (and keep looping if anything is still moving). A no-op while a frame is already queued. */
    function kick() { if (!raf.current && check.ok) { last.current = 0; raf.current = requestAnimationFrame(frame); } }
    const kickRef = React.useRef(kick);
    kickRef.current = kick;

    React.useEffect(() => { kickRef.current(); }, [mode, phase, op, tick]);
    React.useEffect(() => () => {                              // unmount: stop the loop, flush a pending save
      if (raf.current) cancelAnimationFrame(raf.current); raf.current = 0;
      if (timer.current) { clearTimeout(timer.current); timer.current = 0; flushChange(); }
    }, []);

    // ---------- saving what the kid built (debounced) ----------
    function flushChange() {
      timer.current = 0;
      try { const sp = st.current && Bk.toSpec(st.current); if (sp && R.current.onChange) R.current.onChange(sp); } catch (e) { /* saving is the host's job */ }
    }
    function scheduleChange() { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(flushChange, 500); }

    // ---------- world actions ----------
    const seed = () => Math.floor(Math.random() * 2147483647);
    const resetDisp = () => { disp.current = {}; parts.current = []; };
    const syncHist = () => setHi({ u: hist.current.past.length > 0, r: hist.current.future.length > 0 });
    const blurFocus = () => { try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) { /* focus is a nicety */ } };

    /** Fresh run of the CURRENT world (edits included): items back, critters back, score and lives reset. */
    function freshWorld() {
      const sp = Bk.toSpec(st.current) || check.spec;
      st.current = Bk.create(sp, seed()); resetDisp(); ended.current = false; hudKey.current = ''; pend.current = null;
      setHud({ status: 'playing', score: 0, lives: st.current.lives, progress: 0, secs: 0 });
    }
    function begin() { blurFocus(); freshWorld(); setMode('play'); setPhase('playing'); setNote(''); sfx('pop'); }
    function enterBuild() {
      blurFocus();
      if (mode === 'build') return;
      freshWorld(); setMode('build'); setPhase('ready'); setNote('');
      cursor.current = { x: st.current.hero.x, y: st.current.hero.y };
    }
    function snapshot() { return clone(st.current); }

    // ---------- Explore 3D: the first-person view edits the same plot build ----------
    const exploreBase = React.useRef(null);                    // the spec the 3D view was opened with (stable, so it does not rebuild the world)
    const exploreSpec = React.useRef(null);                    // latest spec including what was built in 3D
    /** The spec the 3D view starts from: the current world plus the terrain / seed the isometric engine may not carry. */
    function specFor3D() {
      const base = Bk.toSpec(st.current) || check.spec, w = (spec && spec.world) || {};
      const world = Object.assign({}, base.world);
      if (w.terrain !== undefined) world.terrain = w.terrain;
      if (w.seed !== undefined) world.seed = w.seed;
      return Object.assign({}, base, { world: world });
    }
    function enterExplore() {
      blurFocus();
      if (mode === 'explore') return;
      if (!window.AIX_FP || !window.AIX_FP.ExploreView) { setNote('The 3D view is still loading. Try again in a second!'); return; }
      if (timer.current) { clearTimeout(timer.current); flushChange(); }
      exploreSpec.current = null; exploreBase.current = specFor3D(); keys.current = {}; setMode('explore'); setPhase('ready'); setNote(''); sfx('pop');
    }
    /** The 3D view saved a new plot: keep it as the world and tell the host (debounced there already). */
    function onPlotChange(build) {
      const sp = Object.assign({}, specFor3D(), { build: build });
      const v = window.AIXEngine && window.AIXEngine.clientValidate(sp);
      if (!v || !v.ok) return;
      exploreSpec.current = sp;
      try { if (R.current.onChange) R.current.onChange(sp); } catch (e) { /* saving is the host's job */ }
    }
    /** Back from 3D: reload the isometric world so edits made in 3D show up in Build and Play. */
    function leaveExplore() {
      const sp = exploreSpec.current && window.AIXEngine ? window.AIXEngine.clientValidate(exploreSpec.current) : null;
      if (sp && sp.ok) { const next = Bk.create(sp.spec, seed()); if (next && next.status !== 'invalid') { st.current = next; hist.current = Lg.emptyHistory(); setHi({ u: false, r: false }); } }
      exploreSpec.current = null; resetDisp(); ended.current = false; hudKey.current = '';
      setHud({ status: 'playing', score: 0, lives: st.current.lives, progress: 0, secs: 0 });
      setMode('play'); setPhase('ready'); setNote('Your 3D changes are in the flat view too!'); setTick((n) => n + 1);
    }

    /** Add or take away a block in column (x, y). Always undoable. */
    function applyEdit(x, y) {
      if (R.current.mode !== 'build' || !st.current) return;
      const o = R.current.op, m = R.current.mat;
      const res = Bk.edit(st.current, o === 'place' ? { op: 'place', x: x, y: y, mat: m } : { op: 'remove', x: x, y: y });
      if (!res || !res.ok) { sfx('oops'); setNote(refusal(res && res.reason)); return; }
      hist.current = Lg.histPush(hist.current, snapshot());
      st.current = Object.assign({}, res.state, { events: [] });
      sfx(o === 'place' ? 'pop' : 'tick');
      const name = (Bk.MATERIALS[m] || {}).name || 'block';
      setNote(o === 'place' ? `Added ${name} at column ${x + 1}, row ${y + 1}.` : `Took a block away at column ${x + 1}, row ${y + 1}.`);
      syncHist(); setTick((n) => n + 1); scheduleChange();
    }
    function undo() {
      const u = Lg.histUndo(hist.current, snapshot());
      if (!u) return;
      hist.current = u.h; st.current = u.snap; resetDisp(); sfx('tick'); setNote('Undid that.'); syncHist(); setTick((n) => n + 1); scheduleChange();
    }
    function redo() {
      const r = Lg.histRedo(hist.current, snapshot());
      if (!r) return;
      hist.current = r.h; st.current = r.snap; resetDisp(); sfx('tick'); setNote('Did that again.'); syncHist(); setTick((n) => n + 1); scheduleChange();
    }
    /** Back to the starter island. Undo brings your world back. */
    function startOver() {
      hist.current = Lg.histPush(hist.current, snapshot());
      const sp = Object.assign({}, Bk.toSpec(st.current) || check.spec, { build: Bk.starterBuild() });
      const next = Bk.create(sp, seed());
      if (!next || next.status === 'invalid') return;
      st.current = next; resetDisp(); cursor.current = { x: next.hero.x, y: next.hero.y };
      setNote('A fresh island! Undo brings your old world back.'); syncHist(); setTick((n) => n + 1); scheduleChange();
    }
    const pickMat = (m) => { setMat(m); R.current.mat = m; const mm = Bk.MATERIALS[m]; setNote(mm ? `${mm.name} chosen.` : ''); };
    const setOpBoth = (o) => { setOp(o); R.current.op = o; setNote(o === 'place' ? 'Adding blocks.' : 'Taking blocks away.'); };

    // ---------- pointer: tap a tile to walk there (play) or to build (build) ----------
    function cellAt(e) {
      const c = canvasRef.current;
      if (!c || !st.current) return null;
      const r = c.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const hit = Bk.pick((e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height), st.current.build, geo.current.view);
      return hit ? { x: hit.x, y: hit.y } : null;
    }
    const canvasDown = (e) => {
      const cell = cellAt(e);
      if (!cell) return;
      if (R.current.mode === 'build') { cursor.current = cell; applyEdit(cell.x, cell.y); }
      else if (R.current.phase === 'playing') pend.current = cell;
    };
    const canvasMove = (e) => {
      if (R.current.mode !== 'build' || e.pointerType !== 'mouse') return;
      const cell = cellAt(e), h = hover.current;
      if ((cell && h && cell.x === h.x && cell.y === h.y) || (!cell && !h)) return;
      hover.current = cell; kick();
    };
    const canvasLeave = () => { if (hover.current) { hover.current = null; kick(); } };

    // ---------- keyboard (ignored while typing; Space/Enter on a focused button presses that button) ----------
    React.useEffect(() => {
      const typing = (e) => { const t = e.target && e.target.tagName; return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || (e.target && e.target.isContentEditable); };
      const onBtn = (e) => e.target && e.target.tagName === 'BUTTON';
      const MATS = () => Bk.ALPHABET.replace('.', '').split('');
      const down = (e) => {
        if (!check.ok || typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
        const k = String(e.key).toLowerCase(), rr = R.current;
        if (rr.mode === 'explore') return;                      // the 3D view reads its own keys
        if (k === 'e' && !onBtn(e)) { e.preventDefault(); enterExplore(); return; }
        if (rr.mode === 'build') {
          const mv = KEY_MOVE[k];
          if (mv) { e.preventDefault(); const c = cursor.current; cursor.current = { x: clamp(c.x + mv[0], 0, Bk.SIZE - 1), y: clamp(c.y + mv[1], 0, Bk.SIZE - 1) }; kickRef.current(); return; }
          if ((k === 'enter' || k === ' ') && !onBtn(e)) { e.preventDefault(); applyEdit(cursor.current.x, cursor.current.y); return; }
          if (k === 'x') { e.preventDefault(); setOpBoth(rr.op === 'place' ? 'remove' : 'place'); return; }
          if (k === 'u') { e.preventDefault(); undo(); return; }
          if (k === 'r') { e.preventDefault(); redo(); return; }
          if (k === '[' || k === ']') { e.preventDefault(); const all = MATS(), i = all.indexOf(rr.mat); pickMat(all[(i + (k === ']' ? 1 : all.length - 1)) % all.length]); return; }
          if (k === 'b') { e.preventDefault(); begin(); }
          return;
        }
        if (KEY_MOVE[k] || k === ' ') {
          if (k === ' ' && onBtn(e)) return;
          e.preventDefault(); keys.current[k] = true;
        } else if (k === 'b' && !onBtn(e)) { e.preventDefault(); enterBuild(); }
      };
      const up = (e) => { keys.current[String(e.key).toLowerCase()] = false; };
      const clear = () => { keys.current = {}; };
      const onVis = () => { if (document.hidden) setPhase((p) => (p === 'playing' ? 'paused' : p)); };
      window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', clear);
      document.addEventListener('visibilitychange', onVis);
      return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', clear); document.removeEventListener('visibilitychange', onVis); };
    }, [check]);

    // ---------- render ----------
    if (check.ok && mode === 'explore') {
      const FP = window.AIX_FP && window.AIX_FP.ExploreView;
      return (
        <div style={{ maxWidth: 900, margin: '0 auto' }}>
          {FP ? <FP spec={exploreBase.current || specFor3D()} onExit={leaveExplore} onPlotChange={onPlotChange} onEnd={onEnd} theme={theme} />
            : <div role="status" style={{ padding: 16, color: MUTE }}>The 3D view is still loading. <button type="button" onClick={leaveExplore} style={ghostStyle}>Back</button></div>}
        </div>
      );
    }
    if (!check.ok) {
      return (
        <div role="alert" style={{ padding: 20, borderRadius: 18, border: `1.5px solid ${LINE}`, background: '#fff', maxWidth: 520 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: INK, marginBottom: 6 }}>This world came out a bit wobbly</div>
          <div style={{ fontSize: 14.5, color: MUTE, marginBottom: 14 }}>The recipe has something we cannot build safely, so we did not start it. Try another idea or a starter world!</div>
          <button type="button" onClick={onExit} style={ghostStyle}>Back</button>
        </div>
      );
    }
    const s = check.spec, goal = s.goal, M = Bk.MATERIALS, live = Bk.toSpec(st.current) || s;
    const goalLine = goal.kind === 'score' ? 'Collect ' + goal.target + ' treasures' : goal.kind === 'reach' ? 'Walk to the flag on the highest hill' : 'Stay safe for ' + goal.target + ' seconds';
    const progressLine = goal.kind === 'score' ? hud.score + ' of ' + goal.target : goal.kind === 'survive' ? hud.secs + ' of ' + goal.target + ' seconds' : hud.status === 'won' ? 'You made it!' : 'Keep climbing!';
    const overlay = (title, body, buttons) => (
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(10,18,28,.62)', borderRadius: 18, padding: 16 }}>
        <div role="status" aria-live="polite" style={{ textAlign: 'center', color: '#fff', maxWidth: 400 }}>
          <div style={{ fontSize: 26, fontWeight: 800, marginBottom: 8, lineHeight: 1.15 }}>{title}</div>
          <div style={{ fontSize: 16.5, fontWeight: 600, lineHeight: 1.4, marginBottom: 18 }}>{body}</div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>{buttons}</div>
        </div>
      </div>
    );
    const playBtn = (label, onClick) => <button type="button" autoFocus onClick={onClick} style={btnStyle(accent, { padding: '0 28px', borderRadius: 999 })}>{label}</button>;
    const buildBtn = <button type="button" onClick={enterBuild} style={Object.assign({}, ghostStyle, { background: 'rgba(255,255,255,.92)' })}>Change the world</button>;
    const exitBtn = <button type="button" onClick={onExit} style={Object.assign({}, ghostStyle, { background: 'rgba(255,255,255,.92)' })}>Back</button>;
    const seg = (id, label, on, onClick) => (
      <button type="button" aria-pressed={on} onClick={onClick}
        style={{ minHeight: TAP, padding: '0 22px', borderRadius: 999, border: `2px solid ${on ? accent : LINE}`, background: on ? accent : '#fff', color: on ? '#fff' : INK, fontSize: 16, fontWeight: 800, cursor: 'pointer' }}>{label}</button>
    );
    const tool = (label, on, onClick, disabled) => (
      <button type="button" aria-pressed={on === undefined ? undefined : on} disabled={disabled} onClick={onClick}
        style={{ minHeight: TAP, padding: '0 16px', borderRadius: 999, border: `2px solid ${on ? accent : LINE}`, background: on ? accent : '#fff', color: on ? '#fff' : INK, fontSize: 15, fontWeight: 800, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 }}>{label}</button>
    );
    const setJump = (v) => { btn.current.jump = v; if (v) jumpUntil.current = performance.now() + 400; };
    const setKey = (k) => (v) => { keys.current[k] = v; };

    return (
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: INK, lineHeight: 1.2 }}>{s.title}</div>
            <div style={{ fontSize: 13, color: MUTE, fontWeight: 600 }}>{mode === 'build' ? 'Build anything you imagine' : goalLine}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {mode === 'play' && phase === 'playing' && <button type="button" onClick={() => setPhase('paused')} style={ghostStyle}>Pause</button>}
            <button type="button" onClick={onExit} style={ghostStyle}>Back</button>
          </div>
        </div>

        <div role="group" aria-label="Choose what to do" style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          {seg('play', 'Play', mode === 'play', () => { if (mode !== 'play') begin(); else blurFocus(); })}
          {seg('build', 'Build', mode === 'build', enterBuild)}
          {seg('explore', 'Explore 3D', false, enterExplore)}
        </div>

        {mode === 'play' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap', fontSize: 15, fontWeight: 800, color: INK }}>
            <span>{progressLine}</span>
            <span style={{ display: 'inline-flex', gap: 3 }} role="img" aria-label={`${hud.lives} lives left`}>
              {Array.from({ length: s.rules.lives }, (_, i) => (
                <svg key={i} width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d={HEART} fill={i < hud.lives ? '#ff4d6d' : 'none'} stroke={i < hud.lives ? 'rgba(20,32,43,.6)' : MUTE} strokeWidth="2" /></svg>
              ))}
            </span>
            <span aria-hidden="true" style={{ flex: '1 1 80px', height: 8, borderRadius: 999, background: LINE, overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: Math.round(clamp(hud.progress, 0, 1) * 100) + '%', background: '#ffd23f' }} /></span>
          </div>
        )}

        <div style={{ position: 'relative' }}>
          <canvas ref={canvasRef} width={W} height={H} role="img" aria-label={`${s.title}. ${Bk.describe(live)} ${mode === 'build' ? 'Build mode.' : 'Play mode.'}`}
            onPointerDown={canvasDown} onPointerMove={canvasMove} onPointerLeave={canvasLeave}
            style={{ width: '100%', aspectRatio: `${W} / ${H}`, display: 'block', borderRadius: 18, touchAction: 'manipulation', background: s.world.bg, border: `1.5px solid ${LINE}` }} />
          {mode === 'play' && phase === 'ready' && overlay(s.title, s.texts.start, <>{playBtn('Play', begin)}{buildBtn}{exitBtn}</>)}
          {mode === 'play' && phase === 'paused' && overlay('Paused', 'Take your time. Your world waits for you.', <>{playBtn('Keep playing', () => { setPhase('playing'); })}{buildBtn}{exitBtn}</>)}
          {mode === 'play' && phase === 'ended' && overlay(hud.status === 'won' ? 'You did it!' : 'Good try!', hud.status === 'won' ? s.texts.win : s.texts.lose, <>{playBtn('Play again', begin)}{buildBtn}{exitBtn}</>)}
        </div>
        <div role="status" aria-live="polite" style={{ minHeight: 22, marginTop: 8, fontSize: 14, fontWeight: 700, color: INK, textAlign: 'center' }}>{note}</div>

        {mode === 'build' && (
          <div style={{ marginTop: 6 }}>
            <div role="group" aria-label="Add or take away" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
              {tool('Add blocks', op === 'place', () => setOpBoth('place'))}
              {tool('Take away', op === 'remove', () => setOpBoth('remove'))}
              <span style={{ flex: 1 }} />
              {tool('Undo', undefined, undo, !hi.u)}
              {tool('Redo', undefined, redo, !hi.r)}
              {tool('Start over', undefined, startOver)}
            </div>
            <div style={{ fontSize: 13, fontWeight: 800, color: MUTE, marginBottom: 6 }}>Pick a block</div>
            <div role="group" aria-label="Blocks to build with" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {Bk.ALPHABET.split('').filter((ch) => ch !== '.' && M[ch]).map((ch) => (
                <button key={ch} type="button" aria-label={M[ch].name} aria-pressed={mat === ch} title={M[ch].name} onClick={() => pickMat(ch)}
                  style={{ width: TAP + 8, minHeight: TAP + 8, padding: '4px 2px 2px', borderRadius: 14, border: `3px solid ${mat === ch ? accent : LINE}`, background: mat === ch ? '#fff' : '#fafbfc', cursor: 'pointer', display: 'grid', justifyItems: 'center', gap: 0, color: INK, fontSize: 11, fontWeight: 800 }}>
                  <CubeIcon mat={M[ch]} size={30} /><span>{M[ch].name}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {mode === 'play' && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 28, marginTop: 8, flexWrap: 'wrap' }}>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(2, ${TAP + 16}px)`, gap: 8 }}>
              <PadButton label="Walk up and left" glyph={ARROW.up} rot={-45} set={setKey('arrowleft')} accent={accent} />
              <PadButton label="Walk up and right" glyph={ARROW.up} rot={45} set={setKey('arrowup')} accent={accent} />
              <PadButton label="Walk down and left" glyph={ARROW.down} rot={45} set={setKey('arrowdown')} accent={accent} />
              <PadButton label="Walk down and right" glyph={ARROW.down} rot={-45} set={setKey('arrowright')} accent={accent} />
            </div>
            <PadButton label="Jump" glyph={ARROW.jump} set={setJump} accent="#e5484d" />
          </div>
        )}

        <div style={{ textAlign: 'center', fontSize: 12.5, color: MUTE, marginTop: 10, fontWeight: 600 }}>
          {mode === 'build'
            ? 'Tap a column to add a block. Keyboard: arrows move the glow, Enter adds, X switches add and take away, U undoes, R redoes, [ and ] change block, B plays.'
            : 'Tap a tile to walk there. Arrow keys or WASD walk, Space jumps, B builds.'}
        </div>
      </div>
    );
  }

  window.AIX_BLOCKS = { BlocksPlayer: BlocksPlayer };
})();
