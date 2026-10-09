/* ============================================================
   AI Explorers — Game Studio. The kid is the author; the AI is an imagination amplifier.
   Dream (idea + chips + sparks + Surprise me + twists) -> Build (/api/game-spec) -> Play (AixGamePlayer)
   -> Ask back / Tweak / Fix -> What-the-AI-decided (sliders) -> Words-to-choices diff -> Time machine
   -> 8x8 hero editor -> Remix / Make it mine -> Creator shelf (localStorage sg-aix-games-v1).
   Pure logic lives in vg-aix-studio-logic.js. Everything the AI sends is validated by AIXEngine.clientValidate
   before it is shown or played; all text is rendered as React text nodes (no markup injection). No emoji: drawn SVG glyphs.
   ============================================================ */
(function () {
  const L = window.AIXStudioLogic, E = window.AIXEngine;
  // Colours come from the shell when it is loaded; these fallbacks keep the studio usable on its own.
  const T = typeof AIX !== 'undefined' ? AIX : { ink: '#14202b', mute: '#5b6b79', faint: '#94a3b0', line: '#e4e8ec', sun: '#f5b82e', leaf: '#2f9e5b', pink: '#ff7aa8', red: '#e5484d', paper: '#fffef9' };
  const sfx = (n) => { try { if (typeof window.aixSfx === 'function') window.aixSfx(n); } catch (e) { /* sound is optional */ } };

  // ---------- storage: every access guarded; every read re-validated by the logic file ----------
  function loadShelf() { try { return L.parseShelf(window.localStorage.getItem(L.SAVE_KEY)); } catch (e) { return []; } }
  function storeShelf(list) { try { window.localStorage.setItem(L.SAVE_KEY, L.serializeShelf(list)); return true; } catch (e) { return false; } }

  // ---------- small drawn glyphs ----------
  const GLYPH = {
    spark: 'M12 2 L14 9 L21 12 L14 15 L12 22 L10 15 L3 12 L10 9 Z',
    dice: 'M5 3 H19 a2 2 0 0 1 2 2 V19 a2 2 0 0 1 -2 2 H5 a2 2 0 0 1 -2 -2 V5 a2 2 0 0 1 2 -2 Z M8 8 h.01 M16 8 h.01 M12 12 h.01 M8 16 h.01 M16 16 h.01',
    undo: 'M9 14 L4 9 L9 4 M4 9 H15 a5 5 0 0 1 0 10 H11',
    trash: 'M4 7 H20 M9 7 V4 H15 V7 M6 7 L7 20 H17 L18 7',
    back: 'M15 5 L8 12 L15 19',
    mirror: 'M12 3 V21 M8 7 L3 12 L8 17 Z M16 7 L21 12 L16 17 Z',
    clock: 'M12 3 a9 9 0 1 0 0.01 0 M12 7 V12 L15 14',
    pencil: 'M4 20 L5 15 L16 4 L20 8 L9 19 Z',
  };
  function Glyph({ name, size = 18, color = 'currentColor', fill = false }) {
    return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ flexShrink: 0 }}><path d={GLYPH[name]} fill={fill ? color : 'none'} stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }

  // ---------- shared bits ----------
  function Chip({ children, on, onClick, theme, glyph, title, disabled }) {
    return (
      <button type="button" className="aix-btn" onClick={onClick} disabled={disabled} aria-pressed={on === undefined ? undefined : !!on} title={title}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 44, padding: '8px 16px', borderRadius: 999, fontSize: 15, fontWeight: 700, cursor: disabled ? 'default' : 'pointer', textAlign: 'left',
                 border: `2px solid ${on ? theme.primary : T.line}`, background: on ? theme.primary : '#fff', color: on ? '#fff' : T.ink, opacity: disabled ? 0.55 : 1 }}>
        {glyph && <Glyph name={glyph} size={16} />}{children}
      </button>
    );
  }
  function Big({ children, onClick, theme, disabled, glyph, quiet }) {
    return (
      <button type="button" className="aix-btn" onClick={onClick} disabled={disabled}
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 52, padding: '12px 24px', borderRadius: 999, fontSize: 17, fontWeight: 800, cursor: disabled ? 'not-allowed' : 'pointer',
                 border: quiet ? `2px solid ${T.line}` : 'none', background: quiet ? '#fff' : theme.primary, color: quiet ? T.ink : '#fff', opacity: disabled ? 0.5 : 1,
                 boxShadow: quiet || disabled ? 'none' : '0 5px 0 ' + (theme.primaryLight || '#cfe3fb') }}>
        {glyph && <Glyph name={glyph} size={18} />}{children}
      </button>
    );
  }
  function Card({ title, sub, children, tint }) {
    return (
      <section style={{ borderRadius: 22, border: `1.5px solid ${T.line}`, background: tint || '#fff', padding: '16px 16px 18px', marginBottom: 14 }}>
        {title && <h3 style={{ margin: '0 0 2px', fontSize: 18, fontWeight: 800, letterSpacing: '-0.01em', color: T.ink }}>{title}</h3>}
        {sub && <p style={{ margin: '0 0 12px', fontSize: 14, color: T.mute, lineHeight: 1.4 }}>{sub}</p>}
        {!sub && title && <div style={{ height: 10 }} />}
        {children}
      </section>
    );
  }
  const Row = ({ children, gap = 8 }) => <div style={{ display: 'flex', flexWrap: 'wrap', gap }}>{children}</div>;
  const inputStyle = { width: '100%', boxSizing: 'border-box', borderRadius: 16, border: `2px solid ${T.line}`, padding: '12px 14px', fontSize: 16, fontFamily: 'inherit', color: T.ink, resize: 'vertical', background: '#fff' };

  // ---------- the hero's face: the kid's drawing when there is one, otherwise the shape ----------
  const SHAPE_PATH = {
    circle: (c) => <circle cx="12" cy="12" r="9" fill={c} />,
    square: (c) => <rect x="4" y="4" width="16" height="16" rx="2" fill={c} />,
    triangle: (c) => <path d="M12 3 L22 20 H2 Z" fill={c} />,
    star: (c) => <path d="M12 2 L15 9 L22 9.5 L16.5 14 L18.5 21 L12 17 L5.5 21 L7.5 14 L2 9.5 L9 9 Z" fill={c} />,
    heart: (c) => <path d="M12 21 C3 14 3 6 8 5 C10.5 4.7 12 7 12 7 C12 7 13.5 4.7 16 5 C21 6 21 14 12 21 Z" fill={c} />,
  };
  /** Draws an actor from a VALIDATED spec (colours/rows are checked by clientValidate before they get here). */
  function Face({ actor, size = 56 }) {
    if (actor && actor.sprite) {
      const sp = actor.sprite, cells = [];
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) cells.push(<rect key={r * 8 + c} x={c} y={r} width="1.04" height="1.04" fill={sp.palette[sp.rows[r].charCodeAt(c) - 48]} />);
      return <svg width={size} height={size} viewBox="0 0 8 8" role="img" aria-label="Hero drawing" style={{ display: 'block', borderRadius: 10, shapeRendering: 'crispEdges' }}>{cells}</svg>;
    }
    const draw = actor && SHAPE_PATH[actor.shape];
    return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ display: 'block' }}>{draw ? draw(actor.color) : null}</svg>;
  }

  // ---------- the waiting screen: Bolt is "mixing" the idea ----------
  const WAIT_LINES = ['Bolt is stirring your idea with stardust...', 'Teaching the hero how to wiggle...', 'Painting the sky just the way you said...', 'Asking the bad guys to be silly...', 'Polishing the very last pixel...'];
  function Waiting({ theme }) {
    const [i, setI] = React.useState(0);
    React.useEffect(() => { const t = setInterval(() => setI((x) => (x + 1) % WAIT_LINES.length), 2200); return () => clearInterval(t); }, []);
    const Bolt = window.AixBolt;
    return (
      <div role="status" aria-live="polite" style={{ textAlign: 'center', padding: '34px 12px' }}>
        {Bolt && <div style={{ display: 'inline-block' }}><Bolt mood="curious" size={150} /></div>}
        <h2 style={{ fontSize: 22, margin: '10px 0 6px', color: T.ink }}>Building your game...</h2>
        <p style={{ margin: 0, fontSize: 16, color: T.mute, minHeight: 24 }}>{WAIT_LINES[i]}</p>
        <div style={{ margin: '18px auto 0', width: 220, height: 10, borderRadius: 999, background: T.line, overflow: 'hidden' }} aria-hidden="true">
          <div className="aix-a-rise" style={{ width: '40%', height: '100%', borderRadius: 999, background: theme.primary, animation: 'aix-sway 1.2s ease-in-out infinite' }} />
        </div>
      </div>
    );
  }

  // ---------- 8x8 pixel editor: grid of labelled buttons ----------
  function PixelEditor({ spec, theme, onUse, onRemove }) {
    const [target, setTarget] = React.useState('hero');
    const actorOf = (s, t) => (t === 'hero' ? s.hero : s.items[t]);
    const [rows, setRows] = React.useState(() => L.fromSprite(actorOf(spec, 'hero').sprite));
    const [stack, setStack] = React.useState([]);
    const [color, setColor] = React.useState(1);
    const [mirror, setMirror] = React.useState(false);
    const pal = L.spritePalette(spec.world.bg);
    const names = ['see-through', 'ink', 'coral', 'sun', 'leaf', 'sky'];
    const pickTarget = (t) => { setTarget(t); setRows(L.fromSprite(actorOf(spec, t).sprite)); setStack([]); };
    const paint = (r, c) => { setStack((s) => L.pushUndo(s, rows)); setRows(mirror ? L.paintMirror(rows, r, c, color) : L.paintCell(rows, r, c, color)); };
    const labels = { hero: 'My hero', good: 'Good stuff', bad: 'Bad stuff' };
    return (
      <Card title="Draw it yourself" sub="Tap squares to paint. The game will use your drawing instead of the plain shape.">
        <Row>{['hero', 'good', 'bad'].map((t) => <Chip key={t} theme={theme} on={target === t} onClick={() => pickTarget(t)}>{labels[t]}</Chip>)}</Row>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 14, alignItems: 'flex-start' }}>
          <div role="group" aria-label="Pixel grid, 8 by 8" style={{ display: 'grid', gridTemplateColumns: 'repeat(8, minmax(30px, 40px))', gap: 3, padding: 6, borderRadius: 16, background: T.line, touchAction: 'manipulation' }}>
            {rows.map((row, r) => row.split('').map((d, c) => (
              <button key={r * 8 + c} type="button" aria-label={`Row ${r + 1}, column ${c + 1}, ${names[Number(d)]}. Tap to paint.`}
                onPointerDown={() => paint(r, c)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); paint(r, c); } }}
                onPointerEnter={(e) => { if (e.buttons === 1 && e.pointerType === 'mouse') paint(r, c); }}
                style={{ aspectRatio: '1 / 1', minWidth: 30, padding: 0, border: '1px solid rgba(20,32,43,.25)', borderRadius: 6, background: pal[Number(d)], cursor: 'pointer' }} />
            )))}
          </div>
          <div style={{ flex: '1 1 180px', minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: T.mute, marginBottom: 6 }}>Paint colour</div>
            <Row gap={6}>{pal.map((hex, i) => (
              <button key={i} type="button" aria-label={`Colour: ${names[i]}`} aria-pressed={color === i} onClick={() => setColor(i)}
                style={{ width: 44, height: 44, borderRadius: 12, background: hex, border: `3px solid ${color === i ? T.ink : '#fff'}`, boxShadow: '0 0 0 1.5px ' + T.line, cursor: 'pointer' }} />
            ))}</Row>
            <div style={{ height: 12 }} />
            <Row>
              <Chip theme={theme} glyph="undo" disabled={!stack.length} onClick={() => { const u = L.undo(stack, rows); setRows(u.rows); setStack(u.stack); }}>Undo</Chip>
              <Chip theme={theme} glyph="trash" onClick={() => { setStack(L.pushUndo(stack, rows)); setRows(L.clearGrid()); }}>Clear</Chip>
              <Chip theme={theme} glyph="mirror" on={mirror} onClick={() => setMirror(!mirror)}>Mirror</Chip>
            </Row>
            <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ borderRadius: 12, overflow: 'hidden', border: `1.5px solid ${T.line}` }}><Face actor={{ shape: 'square', color: pal[0], sprite: L.toSprite(rows, spec.world.bg) || undefined }} size={56} /></div>
              <span style={{ fontSize: 13, color: T.mute }}>Your drawing, small</span>
            </div>
          </div>
        </div>
        <div style={{ marginTop: 14 }}>
          <Row>
            <Big theme={theme} disabled={L.isBlank(rows)} onClick={() => onUse(target, L.toSprite(rows, spec.world.bg))}>Use my drawing</Big>
            {!!actorOf(spec, target).sprite && <Big quiet theme={theme} onClick={() => { setRows(L.clearGrid()); onRemove(target); }}>Go back to the shape</Big>}
          </Row>
        </div>
      </Card>
    );
  }

  /** Read-aloud with the device's own voice (nothing leaves the device). Hidden when speech is not supported. */
  function ReadAloud({ text, theme }) {
    const ok = typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance === 'function';
    if (!ok) return null;
    const say = () => { try { window.speechSynthesis.cancel(); window.speechSynthesis.speak(new window.SpeechSynthesisUtterance(text)); } catch (e) { /* speech is optional */ } };
    return <div style={{ margin: '0 0 12px' }}><Chip theme={theme} onClick={say}>Read it to me</Chip></div>;
  }

  // ---------- twist cards (client constants, no AI) ----------
  function TwistCards({ theme, onPick, label }) {
    const [seed, setSeed] = React.useState(() => Math.floor(Math.random() * 100));
    const list = L.shuffleTwists(seed, 3);
    return (
      <div>
        <Row>{list.map((t) => <Chip key={t.id} theme={theme} onClick={() => onPick(t)} glyph="spark" title={t.text}>{t.label}</Chip>)}</Row>
        <div style={{ marginTop: 8 }}><Chip theme={theme} glyph="dice" onClick={() => setSeed(seed + 1)}>{label || 'Shuffle a twist'}</Chip></div>
      </div>
    );
  }

  // ======================================================================
  function GameStudio({ onExit, onAward, onExplore, theme: themeProp, launch }) {
    const theme = themeProp || { primary: '#2563eb', primaryLight: '#dbe7ff', tint: '#eff6ff' };
    const explore = (k, v) => { try { if (typeof onExplore === 'function') onExplore(k, v); } catch (e) { /* the shell's problem */ } };
    const [view, setView] = React.useState('dream');            // dream | play | shelf
    const [template, setTemplate] = React.useState(launch === 'blocks' ? 'blocks' : L.AUTO);   // 'auto' = let the AI choose the game type
    const [mixSeed] = React.useState(() => Math.floor(Math.random() * 1e6));   // rotates the example pools per visit
    const [idea, setIdea] = React.useState('');
    const [picks, setPicks] = React.useState({});
    const [sparkSeed, setSparkSeed] = React.useState(0);
    const [ideas, setIdeas] = React.useState(null);
    const [sel, setSel] = React.useState([]);
    const [busy, setBusy] = React.useState(null);               // null | 'build' | 'ideas'
    const [fail, setFail] = React.useState(null);               // {message, retryable}
    const [note, setNote] = React.useState('');                 // friendly one-liners (filtered, etc.)
    const [spec, setSpec] = React.useState(null);
    const [versions, setVersions] = React.useState([]);
    const [diff, setDiff] = React.useState(null);               // {words, lines}
    const [playKey, setPlayKey] = React.useState(0);
    const [result, setResult] = React.useState(null);
    const [tweak, setTweak] = React.useState('');
    const [ov, setOv] = React.useState(null);
    const [draw, setDraw] = React.useState(false);
    const [reflect, setReflect] = React.useState(null);
    const [shelf, setShelf] = React.useState(loadShelf);
    const [gameId, setGameId] = React.useState(null);
    const [myName, setMyName] = React.useState('');
    const [saved, setSaved] = React.useState('');
    const [cooling, setCooling] = React.useState(false);      // brief rest after a care message
    const [breakNote, setBreakNote] = React.useState(false);
    const lastTweak = React.useRef('');
    const playKeyRef = React.useRef(0);                         // newest Player key: a world edit from an older Player is stale
    playKeyRef.current = playKey;
    const shelfRef = React.useRef(shelf);
    shelfRef.current = shelf;
    const started = React.useRef(Date.now());
    const awarded = React.useRef(false), alive = React.useRef(true), token = React.useRef(0), tweakRef = React.useRef(null), ideaRef = React.useRef(null);
    React.useEffect(() => () => { alive.current = false; }, []);
    // One quiet nudge after 20 minutes, once per visit. It never blocks anything.
    React.useEffect(() => {
      const t = setInterval(() => { if (window.AIXStudyLogic && window.AIXStudyLogic.breakDue(started.current, Date.now())) { setBreakNote(true); clearInterval(t); } }, 30000);
      return () => clearInterval(t);
    }, []);

    const word = (n) => L.wordCount(n);
    const curVersion = versions.length ? versions[versions.length - 1].n : 1;

    function showSpec(next, words, prev, fresh) {
      setSpec(next); setOv(null); setResult(null); setReflect(null); setSaved(''); setDraw(false);
      setVersions((list) => L.addVersion(fresh ? [] : list, next, words));
      setDiff(prev ? { words: words, lines: E.friendlyDiff(prev, next) } : null);
      setPlayKey((k) => k + 1); setView('play');
    }
    const startStarter = (t) => { const tt = t || (template !== L.AUTO && template) || 'catcher'; setTemplate(tt); setFail(null); setNote(''); setGameId(null); showSpec(E.defaultSpec(tt), 'Starter game', null, true); explore('templates', tt); };
    React.useEffect(() => { if (launch === 'blocks') startStarter('blocks'); }, []);   // sidebar / Explorers shortcut: straight into the block-world starter

    /** Shows a failed call: care and blocked messages are calm and never retryable; the rest may offer a retry. */
    function failWith(status, data) {
      const info = L.failInfo(status, data);
      setFail(info);
      if (info.kind === 'care') { setCooling(true); setTimeout(() => { if (alive.current) setCooling(false); }, 8000); }
    }

    /** One call to the AI game maker. `previous` makes it a tweak. Failure never loses the kid's idea or game. Resolves true on success. */
    async function build(o) {
      const req = L.buildSpecRequest({ template: o.template, idea: o.idea, tweak: o.tweak, previousSpec: o.previous, picks: o.picks });
      if (!req.ok) { setFail({ kind: 'error', message: req.error, retryable: false }); return false; }
      const my = ++token.current;
      setBusy('build'); setFail(null); setNote('');
      try {
        const { ok, status, data } = await vgPost('/api/game-spec', req.body);
        if (!alive.current || my !== token.current) return false;
        if (data && data.filtered) { setNote(String(data.message || "Let's try a different idea!")); return false; }
        if (!ok || !data || !data.spec) { failWith(status, data); return false; }
        const check = E.clientValidate(data.spec);          // never trust the wire: validate again before anything is shown or played
        if (!check.ok) { setFail({ kind: 'error', message: "The AI's game didn't come out right. Try again, or pick a starter game!", retryable: true }); return false; }
        const next = o.previous ? L.carryProvenance(o.previous, check.spec) : check.spec;   // keep "drawn by you" on unchanged drawings
        showSpec(next, o.tweak || 'First version', o.previous || null, !o.previous);
        explore('templates', next.template);
        return true;
      } catch (e) {
        if (alive.current && my === token.current) setFail({ kind: 'error', message: 'The connection wobbled. Try again!', retryable: true });
        return false;
      } finally { if (alive.current && my === token.current) setBusy(null); }
    }
    const buildFromDream = () => { setGameId(null); build({ template: template, idea: idea, picks: picks }); };
    /** A tweak always carries the previous spec, so the AI changes the game rather than starting over. */
    const doTweak = async (text) => {
      if (!spec) return;
      lastTweak.current = text;
      const base = idea.trim().length >= 3 ? idea : 'A game called ' + spec.title;
      const ok = await build({ template: spec.template, idea: base, tweak: text, previous: spec, picks: {} });
      // the typed change is cleared only when it worked; a failed try keeps the words so nothing is lost
      if (ok && alive.current) setTweak((cur) => (cur.trim() === String(text).trim() ? '' : cur));
    };

    async function surprise() {
      const req = L.buildIdeasRequest({ idea: idea, picks: picks });
      if (!req.ok) { setFail({ kind: 'error', message: req.error, retryable: false }); return; }
      const my = ++token.current;
      setBusy('ideas'); setFail(null); setNote('');
      try {
        const { ok, status, data } = await vgPost('/api/game-spec', req.body);
        if (!alive.current || my !== token.current) return;
        if (data && data.filtered) { setNote(String(data.message || "Let's try a different one!")); return; }
        const list = ok ? L.readIdeas(data) : null;
        if (!list) {
          const info = L.failInfo(status, data);
          if (info.kind === 'error') setFail({ kind: 'error', message: (data && data.error) ? info.message : 'The idea machine is resting. Type your own wild idea instead!', retryable: false });
          else failWith(status, data);
          return;
        }
        setIdeas(list); setSel([]); sfx('good'); explore('ideas', 1);
      } catch (e) {
        if (alive.current && my === token.current) setFail({ kind: 'error', message: 'The connection wobbled. Try again!', retryable: false });
      } finally { if (alive.current && my === token.current) setBusy(null); }
    }
    function toggleIdea(i) {
      const next = sel.indexOf(i) >= 0 ? sel.filter((x) => x !== i) : sel.concat([i]).slice(-2);
      setSel(next);
      if (next.length === 1) setIdea(ideas[next[0]]);
      else if (next.length === 2) setIdea(L.mixIdeas(ideas[next[0]], ideas[next[1]]));
    }

    // game finished (win or lose): first time awards the robot part; reflection chips show up
    const onEnd = (r) => { setResult(r); if (!awarded.current) { awarded.current = true; try { if (typeof onAward === 'function') onAward('studio'); } catch (e) { /* shell's problem */ } } };

    function useDrawing(target, sprite) {
      const next = L.applySprite(spec, target, sprite);
      if (!next) { setNote('That drawing would not fit the game. Try painting a few squares!'); return; }
      showSpec(next, 'You drew the ' + (target === 'hero' ? 'hero' : target === 'good' ? 'good stuff' : 'bad stuff'), spec, false);
      setDraw(true); explore('sprites', 1); sfx('good');
    }
    function removeDrawing(target) {
      const next = L.applySprite(spec, target, null);
      if (next) { showSpec(next, 'Back to the shape', spec, false); setDraw(true); }
    }
    function commitSliders() {
      const next = L.applyOverrides(spec, ov);
      const v = E.clientValidate(next);
      if (v.ok) showSpec(v.spec, 'You changed the settings', spec, false);
    }
    function restore(n) {
      const v = L.getVersion(versions, n), ok = v && E.clientValidate(v.spec);
      if (!ok || !ok.ok) return;
      setDiff({ words: 'Going back to version ' + n, lines: E.friendlyDiff(spec, ok.spec) });
      setSpec(ok.spec); setOv(null); setResult(null); setReflect(null); setPlayKey((k) => k + 1);
    }
    /**
     * The Block Builder reports the kid's hand-built world (debounced). Keep it as the current game WITHOUT restarting the player
     * (the player owns its own undo history). Already on the shelf -> update it there; otherwise wait for the Save button so a
     * building session never pushes an older game off a full shelf. Calls from a replaced player are ignored.
     */
    function onWorldChange(next, forKey) {
      if (forKey !== playKeyRef.current || !alive.current) return;
      const v = E.clientValidate(next);
      if (!v.ok) return;
      setSpec(v.spec); setResult(null);
      setVersions((list) => L.touchVersion(list, v.spec, 'You built the blocks'));
      if (!L.fitsShelf(v.spec)) { setSaved('This world is too big for My games. Try taking a few blocks away.'); return; }
      if (!gameId) { setSaved('Your world changed. Press Save to keep it.'); return; }
      const prev = shelfRef.current, old = prev.find((x) => x.id === gameId);
      const list = L.saveGame(prev, v.spec, old ? old.name : v.spec.title, old ? old.version : 1, gameId);
      shelfRef.current = list; setShelf(list);
      setSaved(storeShelf(list) ? 'World saved to My games.' : 'Could not save on this device, but your world is still here.');
    }
    function save() {
      if (!L.fitsShelf(spec)) { setSaved('This game is too big for My games. Try making it a little smaller.'); return; }
      const name = (spec.title || 'My game');
      const list = L.saveGame(shelf, spec, name, curVersion, gameId || undefined);
      const id = (list[0] && list[0].id) || null;
      setGameId(id); setShelf(list);
      setSaved(storeShelf(list) ? 'Saved to My games!' : 'Could not save on this device, but your game is still here.');
    }
    function makeMine() {
      const entry = { name: spec.title, spec: spec, version: curVersion };
      const mine = L.makeItMine(entry, myName || spec.title + ' (mine)', Date.now());
      if (!mine) return;
      const list = L.saveGame(shelf, mine.spec, mine.name, 1, mine.id);
      setShelf(list); setGameId(mine.id); setSaved(storeShelf(list) ? 'Now it is yours: ' + mine.name : 'Could not save on this device.');
      showSpec(mine.spec, 'Made it mine', null, true);
    }
    const openFromShelf = (e) => { setGameId(e.id); setTemplate(e.spec.template); setFail(null); showSpec(e.spec, 'Opened from My games', null, true); };
    const dropFromShelf = (id) => { const list = L.removeGame(shelf, id); setShelf(list); storeShelf(list); };

    const header = (title, back) => (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <button type="button" className="aix-btn" onClick={back} aria-label="Go back" style={{ minHeight: 44, minWidth: 44, borderRadius: 999, border: `2px solid ${T.line}`, background: '#fff', cursor: 'pointer', color: T.ink, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Glyph name="back" size={20} /></button>
        <h2 style={{ margin: 0, fontSize: 24, letterSpacing: '-0.02em', color: T.ink, flex: 1, minWidth: 0 }}>{title}</h2>
        {view !== 'shelf' && <Chip theme={theme} onClick={() => setView('shelf')}>My games{shelf.length ? ` (${shelf.length})` : ''}</Chip>}
      </div>
    );
    const careLine = () => { const S = window.AIXStudyLogic; return S && S.careText ? S.careText() : 'Please tell a grown-up you trust right now. You matter.'; };
    const failCard = fail && (fail.kind === 'care' || fail.kind === 'blocked' ? (
      // a calm card: no "Oh!" header, no retry (resending the same words would only add safety strikes)
      <div role="alert" style={{ borderRadius: 20, border: `2px solid ${T.line}`, background: T.paper, padding: 16, marginBottom: 14 }}>
        <div style={{ fontSize: 16, color: T.ink, lineHeight: 1.5, marginBottom: fail.kind === 'care' ? 4 : 12 }}>{fail.kind === 'care' ? careLine() : fail.message}</div>
        {fail.kind === 'blocked' && <Row><Big quiet theme={theme} onClick={() => { setFail(null); if (ideaRef.current) ideaRef.current.focus(); }}>Ask something else</Big></Row>}
        {fail.kind === 'care' && <div style={{ fontSize: 13.5, color: T.mute }}>The buttons rest for a moment. There is no hurry.</div>}
      </div>
    ) : (
      <div role="alert" style={{ borderRadius: 20, border: `2px solid ${T.sun}`, background: T.paper, padding: 16, marginBottom: 14 }}>
        <div style={{ fontWeight: 800, fontSize: 17, color: T.ink, marginBottom: 4 }}>Oh! That did not work out.</div>
        <div style={{ fontSize: 15, color: T.mute, marginBottom: 12 }}>{fail.message} {view === 'play' ? 'Your game is safe.' : 'Your idea is safe.'}</div>
        <Row>
          {view === 'dream' && fail.retryable && <Big theme={theme} disabled={!!busy} onClick={buildFromDream}>Try again</Big>}
          {view === 'play' && fail.retryable && lastTweak.current && <Big theme={theme} disabled={!!busy || cooling} onClick={() => doTweak(lastTweak.current)}>Try that change again</Big>}
          {view === 'play' && <Big quiet theme={theme} onClick={() => setFail(null)}>Keep my game as it is</Big>}
          {view !== 'play' && <Big quiet theme={theme} onClick={() => startStarter(template)}>Use a starter game</Big>}
        </Row>
      </div>
    ));
    const noteCard = note && <div role="status" style={{ borderRadius: 18, background: theme.tint || '#eff6ff', padding: '12px 16px', marginBottom: 14, fontSize: 15.5, fontWeight: 700, color: T.ink }}>{note}</div>;

    const breakCard = breakNote && (
      <div role="status" style={{ borderRadius: 18, background: T.paper, border: `1.5px solid ${T.sun}`, padding: '12px 16px', marginBottom: 14, fontSize: 15.5, fontWeight: 700, color: T.ink, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 200 }}>You have been exploring for 20 minutes. Time for a stretch or a look outside! You can come back any time.</span>
        <Chip theme={theme} onClick={() => setBreakNote(false)}>OK</Chip>
      </div>
    );

    if (busy === 'build') return <div><Waiting theme={theme} /></div>;

    // ---------------- My games (creator shelf) ----------------
    if (view === 'shelf') {
      return (
        <div>
          {header('My games', () => setView(spec ? 'play' : 'dream'))}
          {!shelf.length && <Card title="Your shelf is empty" sub="Build a game and press Save. It will show up here with your own drawing on the cover."><Big theme={theme} onClick={() => setView('dream')}>Dream up a game</Big></Card>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
            {shelf.map((e) => (
              <div key={e.id} style={{ borderRadius: 22, border: `1.5px solid ${T.line}`, background: '#fff', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <div style={{ borderRadius: 14, overflow: 'hidden', background: e.spec.world.bg, padding: 6 }}><Face actor={e.spec.hero} size={64} /></div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 800, fontSize: 16, color: T.ink, overflowWrap: 'anywhere' }}>{e.name}</div>
                    <div style={{ fontSize: 13, color: T.mute }}>{e.spec.template}, version {e.version}</div>
                  </div>
                </div>
                <Row><Chip theme={theme} onClick={() => openFromShelf(e)}>Play and remix</Chip><Chip theme={theme} glyph="trash" onClick={() => dropFromShelf(e.id)}>Remove</Chip></Row>
              </div>
            ))}
          </div>
        </div>
      );
    }

    // ---------------- Dream ----------------
    if (view === 'dream') {
      const sparks = L.sparks(idea, sparkSeed);
      const tooLong = idea.length > L.LIMITS.idea;
      const canBuild = idea.trim().length >= L.LIMITS.ideaMin && !tooLong && !cooling;
      const togglePick = (k, v) => setPicks((p) => { const n = Object.assign({}, p); if (n[k] === v) delete n[k]; else n[k] = v; return n; });
      const heroes = L.pickSome(L.HERO_POOL, 6, mixSeed), examples = L.pickSome(L.IDEA_POOL, 3, mixSeed + sparkSeed);
      const typeChips = [{ id: L.AUTO, label: 'Let the AI choose', hint: 'The AI picks the kind of game that fits your idea' }].concat(L.TEMPLATE_CHIPS);
      const typeHint = typeChips.find((t) => t.id === template);
      return (
        <div>
          {header('Game Studio', onExit)}
          <p style={{ margin: '0 0 6px', fontSize: 17, color: T.mute, lineHeight: 1.4 }}>You are the boss of this game. Dream it up, and the AI will help build it. The wilder the better!</p>
          <ReadAloud text="You are the boss of this game. Tell me your idea, and the AI will help build it. The wilder the better!" theme={theme} />
          {failCard}{noteCard}{breakCard}
          <Card title="Your idea" sub="Silly, spooky, impossible: all welcome.">
            <Row><Big quiet theme={theme} glyph="dice" disabled={busy === 'ideas' || cooling} onClick={surprise}>{busy === 'ideas' ? 'Thinking up wild ideas...' : 'Surprise me'}</Big></Row>
            {ideas && <div role="group" aria-label="Wild ideas" style={{ display: 'grid', gap: 8, marginTop: 12 }}>
              {ideas.map((t, i) => <Chip key={i} theme={theme} on={sel.indexOf(i) >= 0} onClick={() => toggleIdea(i)}>{t}</Chip>)}
              <span style={{ fontSize: 13, color: T.mute }}>Tap one, tap two to mix them, or change them however you like.</span>
            </div>}
            <textarea ref={ideaRef} value={idea} maxLength={L.LIMITS.idea} rows={3} onChange={(e) => { setIdea(e.target.value); setSel([]); }} aria-label="Your game idea"
              placeholder="A llama who bakes rainbow pies for sleepy clouds..." style={Object.assign({}, inputStyle, { marginTop: 12 })} />
            <div style={{ textAlign: 'right', fontSize: 13, color: T.faint, marginTop: 2 }} aria-live="polite">{idea.length} / {L.LIMITS.idea}</div>
            <div style={{ fontSize: 13, fontWeight: 800, color: T.mute, margin: '6px 0 6px' }}>Need a spark? Tap one.</div>
            <Row>{sparks.map((s) => <Chip key={s} theme={theme} glyph="spark" onClick={() => { setIdea(L.appendSpark(idea, s)); sfx('tick'); if (ideaRef.current) ideaRef.current.focus(); }}>{s}</Chip>)}
              <Chip theme={theme} glyph="dice" onClick={() => setSparkSeed(sparkSeed + 1)}>More sparks</Chip></Row>
            {!idea && <div style={{ marginTop: 12 }}><div style={{ fontSize: 13, fontWeight: 800, color: T.mute, marginBottom: 6 }}>Need a starting point?</div>
              <Row>{examples.map((x) => <Chip key={x} theme={theme} onClick={() => setIdea(x)}>{x}</Chip>)}</Row></div>}
          </Card>
          <Card title="Make it yours (optional)" sub="Tap to mix in extras. Tap again to take them out. Or skip all of this.">
            <div style={{ fontSize: 13, fontWeight: 800, color: T.mute, margin: '0 0 6px' }}>Kind of game</div>
            <Row>{typeChips.map((t) => <Chip key={t.id} theme={theme} on={template === t.id} onClick={() => setTemplate(t.id)} title={t.hint}>{t.label}</Chip>)}</Row>
            {typeHint && <p style={{ margin: '8px 0 0', fontSize: 14, color: T.mute }}>{typeHint.hint}.</p>}
            <div style={{ fontSize: 13, fontWeight: 800, color: T.mute, margin: '12px 0 6px' }}>Hero</div>
            <Row>{heroes.map((v) => <Chip key={v} theme={theme} on={picks.hero === v} onClick={() => togglePick('hero', v)}>{v}</Chip>)}</Row>
            <div style={{ fontSize: 13, fontWeight: 800, color: T.mute, margin: '12px 0 6px' }}>World</div>
            <Row>{L.WORLD_CHIPS.map((v) => <Chip key={v} theme={theme} on={picks.world === v} onClick={() => togglePick('world', v)}>{v}</Chip>)}</Row>
            <div style={{ fontSize: 13, fontWeight: 800, color: T.mute, margin: '12px 0 6px' }}>Goal</div>
            <Row>{L.GOAL_CHIPS.map((v) => <Chip key={v} theme={theme} on={picks.goal === v} onClick={() => togglePick('goal', v)}>{v}</Chip>)}</Row>
            <div style={{ fontSize: 13, fontWeight: 800, color: T.mute, margin: '12px 0 6px' }}>A what-if twist</div>
            <TwistCards theme={theme} onPick={(t) => { setPicks((p) => Object.assign({}, p, { twist: t.label })); setIdea((x) => L.appendSpark(x, t.text.slice(0, 90))); }} />
            {picks.twist && <p style={{ margin: '10px 0 0', fontSize: 14, color: T.ink, fontWeight: 700 }}>Twist added: {picks.twist}</p>}
          </Card>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 18 }}>
            <Big theme={theme} disabled={!canBuild || !!busy} onClick={buildFromDream} glyph="spark">Build my game</Big>
            {!canBuild && !cooling && <span style={{ fontSize: 14, color: T.mute }}>Add a few words about your idea.</span>}
          </div>
          <Card title="Or start from a starter game" sub="Play one right now, then change anything you like.">
            <Row>{L.TEMPLATE_CHIPS.map((t) => <Chip key={t.id} theme={theme} onClick={() => startStarter(t.id)}>{t.label} starter</Chip>)}</Row>
          </Card>
        </div>
      );
    }

    // ---------------- Play + everything around it ----------------
    const rows = E.describe(spec);
    const draft = ov || { speed: spec.rules.speed, lives: spec.rules.lives, spawnRate: spec.rules.spawnRate };
    const changed = ov && (ov.speed !== spec.rules.speed || ov.lives !== spec.rules.lives || ov.spawnRate !== spec.rules.spawnRate);
    const Player = window.AixGamePlayer;
    return (
      <div>
        {header(spec.title, () => setView('dream'))}
        {failCard}{noteCard}{breakCard}
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 340px', minWidth: 0 }}>
            {Player ? <Player key={playKey} spec={spec} onEnd={onEnd} onExit={() => setView('dream')} onChange={(sp) => onWorldChange(sp, playKey)} theme={theme} /> : <Card title="The game player is still loading">Give it a second and try again.</Card>}
            {result && (
              <Card tint={T.paper} title="You made this!" sub={`Version ${curVersion}. ${result.status === 'won' ? 'You won your own game.' : 'Good try! Games get better with every tweak.'}`}>
                <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div className="aix-a-bounce" style={{ borderRadius: 16, overflow: 'hidden', background: spec.world.bg, padding: 8 }}><Face actor={spec.hero} size={72} /></div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 800, fontSize: 20, color: T.ink, overflowWrap: 'anywhere' }}>{spec.title}</div>
                    <div style={{ fontSize: 14, color: T.mute }}>Starring {spec.hero.name}. Dreamed up by you, built with the AI.</div>
                  </div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 800, color: T.mute, margin: '14px 0 6px' }}>Think about it</div>
                <Row>{L.REFLECTIONS.map((r) => <Chip key={r.id} theme={theme} on={reflect === r.id} onClick={() => { setReflect(r.id); if (r.id === 'change' && tweakRef.current) tweakRef.current.focus(); }}>{r.label}</Chip>)}</Row>
                {reflect === 'missed' && <p role="status" style={{ margin: '10px 0 0', fontSize: 15, fontWeight: 700, color: T.ink }}>You spotted something the AI missed! That is real inventor skill. Tell it in the change box and watch what happens.</p>}
                {reflect === 'surprise' && <p role="status" style={{ margin: '10px 0 0', fontSize: 15, fontWeight: 700, color: T.ink }}>Surprises are the best part. Tell someone about the surprise!</p>}
                {reflect === 'change' && <p role="status" style={{ margin: '10px 0 0', fontSize: 15, fontWeight: 700, color: T.ink }}>Tell the AI what to change in the box below, or pick a chip.</p>}
              </Card>
            )}
          </div>

          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            {spec.ask && (
              <Card tint={theme.tint || '#eff6ff'} title="The AI is wondering..." sub={spec.ask}>
                <Row>{(spec.nextIdeas || []).map((t) => { const tw = L.ideaToTweak(t); return tw ? <Chip key={t} theme={theme} glyph="spark" disabled={!!busy || cooling} onClick={() => doTweak(tw)}>{t}</Chip> : null; })}</Row>
                <p style={{ margin: '10px 0 0', fontSize: 13.5, color: T.mute }}>Or type your own answer in the change box. You decide.</p>
              </Card>
            )}
            <Card title="Change your game" sub="Tap a change, or tell the AI in your own words.">
              <Row>{(spec.template === 'blocks' ? L.TWEAK_CHIPS.concat(L.BLOCK_TWEAK_CHIPS) : L.TWEAK_CHIPS).map((c) => <Chip key={c.id} theme={theme} disabled={!!busy || cooling} onClick={() => doTweak(c.text)}>{c.label}</Chip>)}</Row>
              <textarea ref={tweakRef} value={tweak} maxLength={L.LIMITS.tweak} rows={2} onChange={(e) => setTweak(e.target.value)} aria-label="What should change?"
                placeholder="Make the bad guys dance..." style={Object.assign({}, inputStyle, { marginTop: 12 })} />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: T.faint }}>{tweak.length} / {L.LIMITS.tweak}</span>
                <Big theme={theme} disabled={tweak.trim().length < L.LIMITS.tweakMin || !!busy || cooling} onClick={() => doTweak(tweak.trim())}>Change it</Big>
              </div>
              <div style={{ fontSize: 13, fontWeight: 800, color: T.mute, margin: '14px 0 6px' }}>What if...</div>
              <TwistCards theme={theme} onPick={(t) => doTweak(t.text)} />
              <div style={{ fontSize: 13, fontWeight: 800, color: T.mute, margin: '14px 0 2px' }}>Not quite right?</div>
              <p style={{ margin: '0 0 6px', fontSize: 13, color: T.mute }}>The AI has never played your game. You are the game tester!</p>
              <Row>{L.FIX_BUTTONS.map((c) => <Chip key={c.id} theme={theme} disabled={!!busy || cooling} onClick={() => doTweak(c.text)}>{c.label}</Chip>)}</Row>
            </Card>

            {diff && (
              <Card tint={T.paper} title="Your words, its choices" sub={diff.words ? `You said: ${diff.words}` : undefined}>
                {diff.lines.length
                  ? <ul style={{ margin: 0, paddingLeft: 20, fontSize: 15.5, color: T.ink, lineHeight: 1.6 }}>{diff.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
                  : <p style={{ margin: 0, fontSize: 15, color: T.ink }}>I cannot see a change in the numbers. Did the AI skip your idea? If you noticed, you spotted something the AI missed! Try saying it in different words.</p>}
              </Card>
            )}

            <Card title="What the AI decided" sub="You can change what the AI chose.">
              <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px', fontSize: 14.5 }}>
                {rows.map((r) => <React.Fragment key={r.label}><dt style={{ fontWeight: 800, color: T.mute }}>{r.label}</dt><dd style={{ margin: 0, color: T.ink, overflowWrap: 'anywhere' }} title={r.hint}>{r.value}</dd></React.Fragment>)}
              </dl>
              <div style={{ marginTop: 14, display: 'grid', gap: 10 }}>
                {[['speed', 'Speed'], ['lives', 'Lives'], ['spawnRate', 'How many things show up']].map(([k, label]) => (
                  <label key={k} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 4, fontSize: 14, fontWeight: 700, color: T.ink }}>
                    <span>{label}</span><span style={{ color: theme.primary }}>{draft[k]}</span>
                    <input type="range" min="1" max="5" step="1" value={draft[k]} onChange={(e) => setOv(Object.assign({}, draft, { [k]: Number(e.target.value) }))}
                      aria-label={`${label}, from 1 to 5`} style={{ gridColumn: '1 / -1', width: '100%', minHeight: 32, accentColor: theme.primary }} />
                  </label>
                ))}
                <div><Big theme={theme} disabled={!changed} onClick={commitSliders}>Play with my settings</Big></div>
              </div>
            </Card>

            <Card title="Draw your own hero" sub="Make the hero, or the good and bad things, look exactly how you imagine.">
              {!draw && <Big quiet theme={theme} glyph="pencil" onClick={() => setDraw(true)}>Open the drawing board</Big>}
              {draw && <Chip theme={theme} onClick={() => setDraw(false)}>Close the drawing board</Chip>}
            </Card>
            {draw && <PixelEditor key={playKey} spec={spec} theme={theme} onUse={useDrawing} onRemove={removeDrawing} />}

            {versions.length > 1 && (
              <Card title="Time machine" sub="Go back to an earlier version and play it, to see how different words made a different game.">
                <div style={{ display: 'grid', gap: 8 }}>
                  {versions.slice().reverse().map((v) => (
                    <button key={v.n} type="button" className="aix-btn" onClick={() => restore(v.n)} aria-label={`Go to version ${v.n}: ${v.words}`}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 48, textAlign: 'left', padding: '8px 14px', borderRadius: 16, border: `2px solid ${v.n === curVersion ? theme.primary : T.line}`, background: '#fff', cursor: 'pointer', color: T.ink, fontSize: 14.5 }}>
                      <Glyph name="clock" size={18} color={theme.primary} />
                      <span style={{ fontWeight: 800 }}>Version {v.n}</span><span style={{ color: T.mute, minWidth: 0, overflowWrap: 'anywhere' }}>{v.words}</span>
                    </button>
                  ))}
                </div>
              </Card>
            )}

            <Card title="Keep it, remix it" sub="Save your game on this device. Or make a copy and call it your own.">
              <Row><Big theme={theme} onClick={save}>Save to My games</Big></Row>
              {saved && <p role="status" style={{ margin: '10px 0 0', fontWeight: 700, color: T.ink, fontSize: 15 }}>{saved}</p>}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
                <input value={myName} maxLength={40} onChange={(e) => setMyName(e.target.value)} aria-label="A new name for your copy" placeholder="Name your remix"
                  style={Object.assign({}, inputStyle, { flex: '1 1 160px', width: 'auto', minHeight: 44 })} />
                <Big quiet theme={theme} onClick={makeMine}>Make it mine</Big>
              </div>
              <div style={{ marginTop: 14 }}><Chip theme={theme} onClick={() => setView('dream')}>Dream up a brand new game</Chip></div>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  window.AIX_STUDIOS = window.AIX_STUDIOS || {};
  window.AIX_STUDIOS.studio = GameStudio;
})();
