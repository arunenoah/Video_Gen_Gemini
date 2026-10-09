/* ============================================================
   AI Explorers — AixGamePlayer: plays a validated game spec on a <canvas>.
   Draws ONLY shapes / colours / pixel sprites / text taken from the spec (themes are decoration drawn here in code).
   The spec is re-validated with AIXEngine.clientValidate before anything runs; invalid specs are refused.
   Controls: keyboard (arrows / WASD / space / 1-3), pointer drag or tap on the canvas, and big on-screen buttons.
   Pauses when the tab is hidden; respects prefers-reduced-motion (no shake, no particles, still scenery).
   No network, no storage, no markup injection. Wrapped in an IIFE so helper names never clash with other game files.
   ============================================================ */
(function () {
  const TAP = 48;                                   // px, minimum touch target (spec says >= 44)
  const SIZE = 600;                                 // canvas backing resolution; CSS scales it
  const K = SIZE / 100;                             // engine world (0..100) -> canvas pixels
  const INK = '#14202b', MUTE = '#5b6b79', LINE = '#e4e8ec';
  const sfx = (n) => { try { if (typeof window.aixSfx === 'function') window.aixSfx(n); } catch (e) { /* sound is optional */ } };
  const reduced = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };

  // ---------- colour helpers ----------
  const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const luma = (hex) => { const c = rgb(hex); return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255; };
  /** Blend hex `a` toward hex `b` by t (0..1) -> css colour. */
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',')})`; };

  // ---------- shapes ----------
  function shapePath(ctx, shape, x, y, r) {
    ctx.beginPath();
    if (shape === 'circle') ctx.arc(x, y, r, 0, Math.PI * 2);
    else if (shape === 'square') ctx.rect(x - r * 0.85, y - r * 0.85, r * 1.7, r * 1.7);
    else if (shape === 'triangle') { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r * 0.8); ctx.lineTo(x - r, y + r * 0.8); ctx.closePath(); }
    else if (shape === 'star') {
      for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r; ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
      ctx.closePath();
    } else {                                           // heart
      ctx.moveTo(x, y + r * 0.9);
      ctx.bezierCurveTo(x - r * 1.6, y, x - r * 0.9, y - r * 1.1, x, y - r * 0.4);
      ctx.bezierCurveTo(x + r * 0.9, y - r * 1.1, x + r * 1.6, y, x, y + r * 0.9);
      ctx.closePath();
    }
  }

  /** Draw one actor: the kid's 8x8 sprite when present, otherwise its shape + colour. `r` is world units. */
  function drawActor(ctx, actor, x, y, r, extra) {
    const px = x * K, py = y * K, pr = r * K;
    ctx.save();
    if (extra && extra.alpha !== undefined) ctx.globalAlpha = extra.alpha;
    if (actor.sprite) {
      const d = pr * 2.4, cell = d / 8, ox = px - d / 2, oy = py - d / 2;
      for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
        ctx.fillStyle = actor.sprite.palette[actor.sprite.rows[row].charCodeAt(col) - 48];
        ctx.fillRect(ox + col * cell, oy + row * cell, cell + 0.6, cell + 0.6);
      }
    } else {
      shapePath(ctx, actor.shape, px, py, pr);
      ctx.fillStyle = actor.color; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(20,32,43,.55)'; ctx.stroke();
      ctx.beginPath(); ctx.arc(px - pr * 0.28, py - pr * 0.1, pr * 0.1, 0, 7); ctx.arc(px + pr * 0.28, py - pr * 0.1, pr * 0.1, 0, 7);   // little eyes
      ctx.fillStyle = 'rgba(20,32,43,.8)'; ctx.fill();
    }
    ctx.restore();
  }

  // ---------- scenery: decoration per theme, all drawn from numbers (no assets) ----------
  const hash = (i, s) => { const v = Math.sin(i * 127.1 + s * 311.7) * 43758.5453; return v - Math.floor(v); };
  function drawScenery(ctx, theme, bg, t, motion) {
    const light = luma(bg) > 0.55, ink = light ? '20,32,43' : '255,255,255', drift = motion ? t / 1000 : 0;
    ctx.save();
    if (theme === 'space') {
      for (let i = 0; i < 40; i++) { const tw = motion ? 0.5 + 0.5 * Math.sin(drift * 2 + i) : 1; ctx.fillStyle = `rgba(${ink},${0.2 + 0.5 * tw * hash(i, 1)})`; ctx.fillRect(hash(i, 2) * SIZE, ((hash(i, 3) * SIZE) + drift * 8 * (1 + hash(i, 4))) % SIZE, 2 + hash(i, 5) * 3, 2 + hash(i, 5) * 3); }
      ctx.fillStyle = `rgba(${ink},.1)`; ctx.beginPath(); ctx.arc(SIZE * 0.82, SIZE * 0.2, 46, 0, 7); ctx.fill();
    } else if (theme === 'forest') {
      for (let i = 0; i < 9; i++) { const x = (i + 0.5) * (SIZE / 9), h = 90 + hash(i, 1) * 80, sway = motion ? Math.sin(drift + i) * 4 : 0; ctx.fillStyle = `rgba(${ink},.12)`; ctx.beginPath(); ctx.moveTo(x + sway, SIZE - h); ctx.lineTo(x + 38, SIZE); ctx.lineTo(x - 38, SIZE); ctx.closePath(); ctx.fill(); }
    } else if (theme === 'sea') {
      ctx.strokeStyle = `rgba(${ink},.14)`; ctx.lineWidth = 4;
      for (let row = 0; row < 7; row++) { ctx.beginPath(); for (let x = 0; x <= SIZE; x += 20) { const y = row * 90 + 40 + Math.sin(x / 50 + drift * 1.5 + row) * 8; ctx[x ? 'lineTo' : 'moveTo'](x, y); } ctx.stroke(); }
      for (let i = 0; i < 12; i++) { ctx.fillStyle = `rgba(${ink},.12)`; ctx.beginPath(); ctx.arc(hash(i, 6) * SIZE, SIZE - ((hash(i, 7) * SIZE + drift * 20) % SIZE), 5 + hash(i, 8) * 8, 0, 7); ctx.fill(); }
    } else if (theme === 'city') {
      for (let i = 0; i < 10; i++) { const x = i * 62, h = 110 + hash(i, 9) * 190; ctx.fillStyle = `rgba(${ink},.11)`; ctx.fillRect(x, SIZE - h, 54, h); ctx.fillStyle = `rgba(${ink},.2)`; for (let w = 0; w < h / 36 - 1; w++) ctx.fillRect(x + 8 + (w % 2) * 24, SIZE - h + 14 + w * 36, 10, 14); }
    } else {                                           // candy
      for (let i = 0; i < 26; i++) { ctx.fillStyle = `rgba(${ink},${0.1 + 0.1 * hash(i, 3)})`; ctx.beginPath(); ctx.arc(hash(i, 1) * SIZE, (hash(i, 2) * SIZE + drift * 10) % SIZE, 8 + hash(i, 4) * 22, 0, 7); ctx.fill(); }
    }
    ctx.restore();
  }

  function drawHearts(ctx, lives, max, color) {
    for (let i = 0; i < max; i++) {
      shapePath(ctx, 'heart', SIZE - 28 - i * 38, 36, 13);
      if (i < lives) { ctx.fillStyle = '#ff4d6d'; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(20,32,43,.6)'; ctx.stroke(); }
      else { ctx.lineWidth = 2.5; ctx.strokeStyle = color; ctx.globalAlpha = 0.5; ctx.stroke(); ctx.globalAlpha = 1; }
    }
  }

  /** Paint one full frame of `st` onto ctx. `fx` = {parts, shake} cosmetic extras. */
  function drawFrame(ctx, st, fx, motion) {
    const sp = st.spec, bg = sp.world.bg, fg = luma(bg) > 0.55 ? INK : '#ffffff';
    ctx.save();
    ctx.clearRect(0, 0, SIZE, SIZE);
    if (motion && fx.shake > 0) ctx.translate((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10);
    ctx.fillStyle = bg; ctx.fillRect(-20, -20, SIZE + 40, SIZE + 40);
    drawScenery(ctx, sp.world.theme, bg, st.t, motion);
    const bob = motion ? Math.sin(st.t / 180) * 0.8 : 0;

    if (st.template === 'maze') {
      const m = st.maze, cell = SIZE / m.w, wall = mix(bg, luma(bg) > 0.55 ? '#000000' : '#ffffff', 0.28);
      for (let i = 0; i < m.tiles.length; i++) {
        const c = i % m.w, r = Math.floor(i / m.w), tile = m.tiles[i], x = c * cell, y = r * cell;
        if (tile === 1) { ctx.fillStyle = wall; ctx.fillRect(x, y, cell + 0.5, cell + 0.5); }
        else if (tile === 2) drawActor(ctx, sp.items.bad, (c + 0.5) * cell / K, (r + 0.5) * cell / K, cell / K * 0.4);
        else if (tile === 3) drawActor(ctx, sp.items.good, (c + 0.5) * cell / K, (r + 0.5) * cell / K, cell / K * 0.4);
      }
      const ex = (m.exit[0] + 0.5) * cell, ey = (m.exit[1] + 0.5) * cell, glow = motion ? 0.7 + 0.3 * Math.sin(st.t / 200) : 1;
      ctx.fillStyle = '#ffd23f'; ctx.globalAlpha = 0.35 * glow; ctx.beginPath(); ctx.arc(ex, ey, cell * 0.85, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
      ctx.fillStyle = '#ffd23f'; ctx.fillRect(ex - cell * 0.28, ey - cell * 0.38, cell * 0.56, cell * 0.76);
      ctx.fillStyle = INK; ctx.beginPath(); ctx.arc(ex + cell * 0.12, ey, cell * 0.06, 0, 7); ctx.fill();
      drawActor(ctx, sp.hero, (st.hero.c + 0.5) * cell / K, (st.hero.r + 0.5) * cell / K + bob * 0.3, cell / K * 0.42);
    } else if (st.template === 'quiz') {
      // the question itself is real DOM text under the canvas; the canvas shows the cheering hero
      const fb = st.q.fb, cheer = fb ? (fb.ok ? -4 : 2) : bob;
      drawActor(ctx, sp.hero, 50, 62 + cheer, 20);
      if (fb) { ctx.font = '700 44px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = fb.ok ? '#7bed9f' : '#ff8fa3'; ctx.fillText(fb.ok ? 'Yes!' : 'Not this time', SIZE / 2, 270); }
      for (let i = 0; i < sp.quiz.questions.length; i++) {      // progress pips
        ctx.fillStyle = i < st.q.i ? '#7bed9f' : i === st.q.i ? '#ffd23f' : 'rgba(255,255,255,.35)';
        ctx.beginPath(); ctx.arc(SIZE / 2 - (sp.quiz.questions.length - 1) * 16 + i * 32, 150, 9, 0, 7); ctx.fill();
      }
    } else {
      st.ents.forEach((e) => drawActor(ctx, e.kind === 'good' ? sp.items.good : sp.items.bad, e.x, e.y, 4.8));
      if (st.template === 'runner') {                           // faint lane guides
        ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 2; ctx.setLineDash([14, 14]);
        window.AIXEngine.LANE_Y.forEach((ly) => { ctx.beginPath(); ctx.moveTo(0, ly * K + 40); ctx.lineTo(SIZE, ly * K + 40); ctx.stroke(); });
        ctx.setLineDash([]);
      }
      ctx.fillStyle = '#ffe066';
      st.bullets.forEach((b) => { ctx.beginPath(); ctx.arc(b.x * K, b.y * K, 7, 0, 7); ctx.fill(); });
      drawActor(ctx, sp.hero, st.hero.x, st.hero.y + bob, 6.5);
    }

    fx.parts.forEach((p) => { ctx.globalAlpha = Math.max(0, p.life / 600); ctx.fillStyle = p.color; ctx.fillRect(p.x * K - 4, p.y * K - 4, 8, 8); });
    ctx.globalAlpha = 1;

    // HUD: goal progress bar on top, score text, lives
    ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(0, 0, SIZE, 10);
    ctx.fillStyle = '#ffd23f'; ctx.fillRect(0, 0, SIZE * Math.max(0, Math.min(1, st.progress)), 10);
    ctx.font = '800 26px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = fg;
    ctx.fillText('Score ' + st.score, 16, 44);
    drawHearts(ctx, st.lives, sp.rules.lives, fg);
    ctx.restore();
  }

  const btnStyle = (accent, extra) => Object.assign({ minWidth: TAP, minHeight: TAP, padding: '0 18px', borderRadius: 14, border: 'none', background: accent, color: '#fff', fontSize: 16, fontWeight: 800, cursor: 'pointer', touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none' }, extra || {});
  const ghostStyle = { minHeight: TAP, padding: '0 20px', borderRadius: 999, border: `1.5px solid ${LINE}`, background: '#fff', color: INK, fontSize: 15, fontWeight: 800, cursor: 'pointer' };

  /** Hold-to-press control (touch, mouse and pen). Reports pressed state through `set`. */
  function HoldButton({ label, glyph, set, accent }) {
    const down = (e) => { e.preventDefault(); set(true); };
    const up = () => set(false);
    return (
      <button type="button" aria-label={label} onPointerDown={down} onPointerUp={up} onPointerLeave={up} onPointerCancel={up} onContextMenu={(e) => e.preventDefault()}
        style={btnStyle(accent, { width: TAP + 16, height: TAP + 16, padding: 0, borderRadius: 18, display: 'grid', placeItems: 'center' })}>
        <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><path d={glyph} fill="#fff" /></svg>
      </button>
    );
  }
  // arrow glyphs (drawn, no emoji)
  const ARROW = { left: 'M17 4 L7 13 L17 22 Z', right: 'M9 4 L19 13 L9 22 Z', up: 'M4 17 L13 7 L22 17 Z', down: 'M4 9 L13 19 L22 9 Z', fire: 'M13 3 L16 12 L24 13 L16 15 L13 24 L10 15 L2 13 L10 12 Z' };

  /**
   * Plays a classic (non-blocks) game spec.
   * @param {{spec:Object, onEnd:(result:{status:'won'|'lost',score:number,lives:number,seconds:number,template:string,title:string})=>void, onExit:()=>void, theme?:{primary?:string}}} props
   */
  function AixClassicPlayer({ spec, onEnd, onExit, theme }) {
    const accent = (theme && theme.primary) || '#2f6fed';
    const [dropped, setDropped] = React.useState([]);          // quiz questions the child reported as wrong (this visit only)
    const [bannerDone, setBannerDone] = React.useState(false);
    const playSpec = React.useMemo(() => {
      if (!dropped.length || !spec || !spec.quiz || !Array.isArray(spec.quiz.questions)) return spec;
      return Object.assign({}, spec, { quiz: Object.assign({}, spec.quiz, { questions: spec.quiz.questions.filter((_, i) => dropped.indexOf(i) < 0) }) });
    }, [spec, dropped]);
    const check = React.useMemo(() => window.AIXEngine.clientValidate(playSpec), [playSpec]);
    const [phase, setPhase] = React.useState('ready');          // ready | playing | paused | ended
    const [view, setView] = React.useState({ status: 'playing', score: 0, lives: 0, q: 0, fb: null });
    const canvasRef = React.useRef(null);
    const gs = React.useRef(null);                              // current engine state (not React state: changes every frame)
    const keys = React.useRef({});
    const btn = React.useRef({ left: false, right: false, up: false, down: false, fire: false });
    const pick = React.useRef(null);
    const drag = React.useRef(null);                            // pointer position in world units while pressed
    const fx = React.useRef({ parts: [], shake: 0 });
    const ended = React.useRef(false);
    const onEndRef = React.useRef(onEnd);
    onEndRef.current = onEnd;
    const tpl = check.ok ? check.spec.template : null;

    /** "Report a wrong question": drop it and restart the quiz with the rest (the last question can not be dropped). */
    function reportQuestion() {
      const kept = (spec.quiz.questions || []).map((_, i) => i).filter((i) => dropped.indexOf(i) < 0);
      const current = kept[Math.min(view.q, kept.length - 1)];
      if (kept.length < 2 || current === undefined) return;
      gs.current = null; ended.current = false;
      setDropped((d) => d.concat([current])); setPhase('ready');
    }

    const setBtn = (k) => (v) => { btn.current[k] = v; };

    function paint() {
      const c = canvasRef.current;
      if (!c || !gs.current || gs.current.status === 'invalid') return;
      drawFrame(c.getContext('2d'), gs.current, fx.current, !reduced());
    }

    function begin() {
      ended.current = false; fx.current = { parts: [], shake: 0 }; drag.current = null; pick.current = null;
      gs.current = window.AIXEngine.create(check.spec, Math.floor(Math.random() * 2147483647));
      setView({ status: 'playing', score: 0, lives: gs.current.lives, q: 0, fb: null });
      setPhase('playing'); sfx('pop');
    }

    // Draw a still frame whenever we are not animating (ready / paused / ended / first mount).
    React.useEffect(() => {
      if (!check.ok) return;
      if (!gs.current) gs.current = window.AIXEngine.create(check.spec, 1);
      if (phase !== 'playing') paint();
    }, [phase, check]);

    // Game loop.
    React.useEffect(() => {
      if (phase !== 'playing' || !check.ok) return;
      let raf = 0, last = 0, lastKey = '';
      const motion = !reduced();
      const tick = (ts) => {
        const dt = last ? ts - last : 16; last = ts;
        const E = window.AIXEngine, prev = gs.current;
        const st = E.step(prev, readInput(prev), dt);
        gs.current = st;
        st.events.forEach((ev) => {                              // sound + sparkle for what just happened
          if (ev.type === 'good' || ev.type === 'right') sfx('good'); else if (ev.type === 'bad' || ev.type === 'wrong') { sfx('oops'); fx.current.shake = 180; } else if (ev.type === 'shoot') sfx('tick');
          if (motion && (ev.type === 'good' || ev.type === 'bad') && ev.x !== undefined) {
            const wx = st.template === 'maze' ? (ev.x + 0.5) * 100 / st.maze.w : ev.x, wy = st.template === 'maze' ? (ev.y + 0.5) * 100 / st.maze.w : ev.y;
            for (let i = 0; i < 8; i++) fx.current.parts.push({ x: wx, y: wy, vx: (Math.random() - 0.5) * 60, vy: (Math.random() - 0.5) * 60, life: 600, color: ev.type === 'good' ? '#ffe066' : '#ff8fa3' });
          }
        });
        fx.current.shake = Math.max(0, fx.current.shake - dt);
        fx.current.parts = fx.current.parts.filter((p) => { p.x += p.vx * dt / 1000; p.y += p.vy * dt / 1000; p.life -= dt; return p.life > 0; });
        paint();
        const key = [st.score, st.lives, st.q ? st.q.i : 0, st.q && st.q.fb ? st.q.fb.pick : -1, st.status].join('|');
        if (key !== lastKey) { lastKey = key; setView({ status: st.status, score: st.score, lives: st.lives, q: st.q ? st.q.i : 0, fb: st.q ? st.q.fb : null }); }
        if (st.status !== 'playing') {
          if (!ended.current) {
            ended.current = true; sfx(st.status === 'won' ? 'win' : 'oops');
            setPhase('ended');
            try { if (onEndRef.current) onEndRef.current({ status: st.status, score: st.score, lives: st.lives, seconds: Math.round(st.t / 100) / 10, template: st.template, title: st.spec.title }); } catch (e) { /* the host's problem, not the game's */ }
          }
          return;
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }, [phase, check]);

    // Pause when the tab is hidden (so a kid never loses a life in another tab).
    React.useEffect(() => {
      const onVis = () => { if (document.hidden) setPhase((p) => (p === 'playing' ? 'paused' : p)); };
      document.addEventListener('visibilitychange', onVis);
      return () => document.removeEventListener('visibilitychange', onVis);
    }, []);

    // Keyboard. Ignored while typing in a field so the game never steals keys from a text box.
    React.useEffect(() => {
      const typing = (e) => { const t = e.target && e.target.tagName; return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || (e.target && e.target.isContentEditable); };
      const GAME_KEYS = ['arrowleft', 'arrowright', 'arrowup', 'arrowdown', ' ', 'a', 'd', 'w', 's', '1', '2', '3'];
      const down = (e) => {
        if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
        const k = String(e.key).toLowerCase();
        if (GAME_KEYS.indexOf(k) < 0) return;
        if (k === ' ' && e.target && e.target.tagName === 'BUTTON') return;      // space presses the focused button instead
        e.preventDefault();
        keys.current[k] = true;
        if (k === '1' || k === '2' || k === '3') pick.current = Number(k) - 1;
      };
      const up = (e) => { keys.current[String(e.key).toLowerCase()] = false; };
      window.addEventListener('keydown', down); window.addEventListener('keyup', up);
      return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
    }, []);

    /** Turn held keys / buttons / pointer into the engine's input object. */
    function readInput(st) {
      const k = keys.current, b = btn.current;
      let x = ((k.arrowright || k.d || b.right) ? 1 : 0) - ((k.arrowleft || k.a || b.left) ? 1 : 0);
      let y = ((k.arrowdown || k.s || b.down) ? 1 : 0) - ((k.arrowup || k.w || b.up) ? 1 : 0);
      const p = drag.current;
      if (p) {                                                  // pointer steers toward where the finger is
        if (st.template === 'catcher' || st.template === 'shooter') { const dx = p.x - st.hero.x; x = Math.abs(dx) < 2 ? 0 : Math.max(-1, Math.min(1, dx / 5)); }
        else if (st.template === 'runner') { const dy = p.y - st.hero.y; y = Math.abs(dy) < 10 ? 0 : Math.sign(dy); }
        else if (st.template === 'maze') { const hx = (st.hero.c + 0.5) * 100 / st.maze.w, hy = (st.hero.r + 0.5) * 100 / st.maze.w, dx = p.x - hx, dy = p.y - hy; x = Math.abs(dx) > Math.abs(dy) ? Math.sign(dx) : 0; y = Math.abs(dy) >= Math.abs(dx) ? Math.sign(dy) : 0; }
      }
      const action = !!(k[' '] || b.fire || (p && st.template === 'shooter'));
      const out = { x: x, y: y, action: action };
      if (pick.current !== null) { out.pick = pick.current; pick.current = null; }
      return out;
    }

    const worldPoint = (e) => { const r = canvasRef.current.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 }; };
    const canvasDown = (e) => { if (phase !== 'playing') return; try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* capture is a nicety */ } drag.current = worldPoint(e); };
    const canvasMove = (e) => { if (drag.current) drag.current = worldPoint(e); };
    const canvasUp = () => { drag.current = null; };

    if (!check.ok) {
      return (
        <div role="alert" style={{ padding: 20, borderRadius: 18, border: `1.5px solid ${LINE}`, background: '#fff', maxWidth: 520 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: INK, marginBottom: 6 }}>This game came out a bit wobbly</div>
          <div style={{ fontSize: 14.5, color: MUTE, marginBottom: 14 }}>The game recipe has something we cannot play safely, so we did not start it. Try another idea or a starter game!</div>
          <button type="button" onClick={onExit} style={ghostStyle}>Back</button>
        </div>
      );
    }

    const s = check.spec, q = tpl === 'quiz' ? s.quiz.questions[Math.min(view.q, s.quiz.questions.length - 1)] : null;
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
    const exitBtn = <button type="button" onClick={onExit} style={Object.assign({}, ghostStyle, { background: 'rgba(255,255,255,.92)' })}>Back</button>;

    const goalLine = tpl === 'maze' ? 'Find the glowing door' : tpl === 'quiz' ? 'Get ' + Math.min(s.goal.target, s.quiz.questions.length) + ' right' : s.goal.kind === 'score' ? 'Goal: ' + s.goal.target : 'Goal: ' + s.goal.target + ' seconds';

    return (
      <div style={{ maxWidth: 560, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: INK, lineHeight: 1.2 }}>{s.title}</div>
            <div style={{ fontSize: 13, color: MUTE, fontWeight: 600 }}>{goalLine}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {phase === 'playing' && <button type="button" onClick={() => setPhase('paused')} style={ghostStyle}>Pause</button>}
            <button type="button" onClick={onExit} style={ghostStyle}>Back</button>
          </div>
        </div>

        <div style={{ position: 'relative' }}>
          <canvas ref={canvasRef} width={SIZE} height={SIZE} role="img" aria-label={`${s.title}. ${s.hero.name} plays. Score ${view.score}, ${view.lives} lives left.`}
            onPointerDown={canvasDown} onPointerMove={canvasMove} onPointerUp={canvasUp} onPointerCancel={canvasUp}
            style={{ width: '100%', aspectRatio: '1 / 1', display: 'block', borderRadius: 18, touchAction: 'none', background: s.world.bg, border: `1.5px solid ${LINE}` }} />
          {phase === 'ready' && overlay(s.title, s.texts.start, <>{playBtn('Play', begin)}{exitBtn}</>)}
          {phase === 'paused' && overlay('Paused', 'Take your time. The game waits for you.', <>{playBtn('Keep playing', () => setPhase('playing'))}{exitBtn}</>)}
          {phase === 'ended' && overlay(view.status === 'won' ? 'You did it!' : 'Good try!', view.status === 'won' ? s.texts.win : s.texts.lose, <>{playBtn('Play again', begin)}{exitBtn}</>)}
        </div>

        {tpl === 'quiz' && q && (
          <div style={{ marginTop: 12 }}>
            {!bannerDone && (
              <div role="note" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10, padding: '8px 12px', borderRadius: 14, background: '#fffef9', border: `1.5px solid ${LINE}`, fontSize: 14, color: INK, fontWeight: 600 }}>
                <span style={{ flex: 1, minWidth: 180 }}>A computer helper wrote these questions. Computers make mistakes, so you check.</span>
                <button type="button" onClick={() => setBannerDone(true)} style={ghostStyle}>Got it</button>
              </div>
            )}
            <div style={{ fontSize: 17, fontWeight: 800, color: INK, marginBottom: 8, lineHeight: 1.3 }}>{q.q}</div>
            <div style={{ display: 'grid', gap: 8 }}>
              {q.options.map((o, i) => {
                const fb = view.fb, mark = fb && (i === fb.answer ? '#2f9e5b' : i === fb.pick ? '#e5484d' : null);
                return (
                  <button key={i} type="button" disabled={phase !== 'playing' || !!fb} onClick={() => { pick.current = i; }} aria-label={`Answer ${i + 1}: ${o}`}
                    style={btnStyle(mark || accent, { justifyContent: 'flex-start', textAlign: 'left', minHeight: TAP + 4, padding: '8px 16px', opacity: phase === 'playing' ? 1 : 0.6 })}>
                    {i + 1}. {o}
                  </button>
                );
              })}
            </div>
            {view.fb && (
              <div role="status" style={{ marginTop: 10, fontSize: 14, color: INK, lineHeight: 1.45 }}>
                {!view.fb.ok && <div style={{ fontWeight: 700 }}>Not this time. Want to double-check with a book or a grown-up?</div>}
                <div style={{ color: MUTE }}>Not sure the AI got that right? Look it up!</div>
                {s.quiz.questions.length > 1 && <button type="button" onClick={reportQuestion} style={Object.assign({}, ghostStyle, { marginTop: 8 })}>Report a wrong question</button>}
              </div>
            )}
          </div>
        )}

        {(tpl === 'catcher' || tpl === 'shooter') && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 12 }}>
            <HoldButton label="Move left" glyph={ARROW.left} set={setBtn('left')} accent={accent} />
            {tpl === 'shooter' && <HoldButton label="Fire" glyph={ARROW.fire} set={setBtn('fire')} accent="#e5484d" />}
            <HoldButton label="Move right" glyph={ARROW.right} set={setBtn('right')} accent={accent} />
          </div>
        )}
        {tpl === 'runner' && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 12 }}>
            <HoldButton label="Hop up a lane" glyph={ARROW.up} set={setBtn('up')} accent={accent} />
            <HoldButton label="Hop down a lane" glyph={ARROW.down} set={setBtn('down')} accent={accent} />
          </div>
        )}
        {tpl === 'maze' && (
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(3, ${TAP + 16}px)`, gap: 8, justifyContent: 'center', marginTop: 12 }}>
            <span /><HoldButton label="Move up" glyph={ARROW.up} set={setBtn('up')} accent={accent} /><span />
            <HoldButton label="Move left" glyph={ARROW.left} set={setBtn('left')} accent={accent} />
            <HoldButton label="Move down" glyph={ARROW.down} set={setBtn('down')} accent={accent} />
            <HoldButton label="Move right" glyph={ARROW.right} set={setBtn('right')} accent={accent} />
          </div>
        )}
        <div style={{ textAlign: 'center', fontSize: 12.5, color: MUTE, marginTop: 10, fontWeight: 600 }}>
          {tpl === 'quiz' ? 'Tap an answer or press 1, 2 or 3.' : tpl === 'shooter' ? 'Arrow keys or drag to aim. Space or Fire to pop.' : tpl === 'runner' ? 'Up and down arrows (or tap above or below the hero) to hop lanes.' : 'Arrow keys, WASD, drag, or the buttons.'}
        </div>
      </div>
    );
  }

  /**
   * Entry point the Studio uses. Block Builder worlds ('blocks') go to AIX_BLOCKS.BlocksPlayer; everything else
   * to the classic player. A wrapper (not a branch inside the player) keeps hook order stable for each player.
   */
  function AixGamePlayer(props) {
    if (props.spec && props.spec.template === 'blocks') {
      const B = window.AIX_BLOCKS;
      if (B && B.BlocksPlayer) return <B.BlocksPlayer {...props} />;
      return <div role="status" style={{ padding: 16, color: MUTE }}>The block world is still loading. Give it a second and try again.</div>;
    }
    return <AixClassicPlayer {...props} />;
  }

  window.AixGamePlayer = AixGamePlayer;
  // Drawing helpers shared with the Block Builder canvas (kid sprites + shapes + scenery stay in one place).
  window.AixDraw = { drawActor: drawActor, drawScenery: drawScenery, luma: luma, mix: mix, K: K };
})();
