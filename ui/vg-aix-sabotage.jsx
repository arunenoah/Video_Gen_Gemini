/* ============================================================
   AI Explorers — Sabotage! Be the naughty genius: flip Bolt's labels, watch the silly orders, then fix the data.
   A: sabotage (tap an item to flip it, or drag it to the other shelf)  B: orders run  C: fix + before/after.
   Wrapped in an IIFE so its helper names never clash with the other game files. No text inputs, no network, no markup injection.
   ============================================================ */
(function () {
  const INK = '#14202b', MUTE = '#5b6b79', FAINT = '#94a3b0', LINE = '#e4e8ec', RED = '#e5484d', LEAF = '#2f9e5b', SUN = '#f5b82e';
  const ORDERS_PER_RUN = 5;
  const sfx = (n) => { try { if (typeof window.aixSfx === 'function') window.aixSfx(n); } catch (e) {} };
  const reducedMotion = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };

  // ---- drawn glyphs for the 8 items ----
  function Glyph({ id, size = 52 }) {
    const s = { stroke: INK, strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round' };
    const art = {
      banana: <g><path d="M9 13 Q12 41 40 35 Q45 33 42 29 Q22 33 17 11 Z" fill="#f7d23a" {...s} /><path d="M9 13 l3 -4" {...s} fill="none" /></g>,
      apple: <g><path d="M24 14 Q10 12 10 28 Q12 42 24 40 Q36 42 38 28 Q38 12 24 14z" fill="#ef4444" {...s} /><path d="M24 14 V7" {...s} fill="none" /><path d="M25 9 Q33 4 34 11 Q27 13 25 9z" fill="#53c27f" {...s} /></g>,
      carrot: <g><path d="M13 16 Q30 14 36 32 L34 38 L8 22 Q8 17 13 16z" fill="#fb923c" {...s} transform="rotate(-20 24 24)" /><path d="M30 12 l4 -7 M34 16 l8 -3 M27 9 l-1 -6" {...s} stroke="#2f9e5b" fill="none" /></g>,
      cupcake: <g><path d="M11 25 L15 41 H33 L37 25z" fill="#f59ec0" {...s} /><path d="M10 25 Q8 15 18 14 Q24 5 31 14 Q40 15 38 25z" fill="#fff4d6" {...s} /><circle cx="24" cy="10" r="3" fill={RED} {...s} /></g>,
      shoe: <g><path d="M5 33 V21 Q17 24 21 14 L29 18 Q31 27 42 28 Q45 33 43 37 H5z" fill="#6b7ee0" {...s} /><path d="M5 37 H43" {...s} stroke="#334155" strokeWidth="4" /><path d="M23 19 l3 -3 M27 22 l3 -3" {...s} fill="none" stroke="#fff" /></g>,
      ball: <g><circle cx="24" cy="25" r="16" fill="#fb923c" {...s} /><path d="M8 25 H40 M24 9 Q14 25 24 41 M24 9 Q34 25 24 41" {...s} fill="none" strokeWidth="1.6" /></g>,
      sock: <g><path d="M16 6 H31 V26 L42 33 Q45 41 38 41 Q30 41 20 34 Q16 30 16 26z" fill="#ff8fb7" {...s} /><path d="M16 12 H31 M16 18 H31" {...s} fill="none" stroke="#fff" /></g>,
      pillow: <g><path d="M6 12 Q24 6 42 12 Q38 25 42 38 Q24 44 6 38 Q10 25 6 12z" fill="#cdb4f6" {...s} /><path d="M14 20 Q24 17 34 20" {...s} fill="none" stroke="#fff" strokeWidth="1.8" /></g>,
    }[id] || null;
    return <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" style={{ flexShrink: 0 }}>{art}</svg>;
  }

  function Mark({ ok, size = 26 }) {           // drawn tick / cross badge
    return (
      <svg width={size} height={size} viewBox="0 0 26 26" role="img" aria-label={ok ? 'Right' : 'Oops'} style={{ flexShrink: 0 }}>
        <circle cx="13" cy="13" r="12" fill={ok ? LEAF : RED} />
        {ok ? <path d="M7 13.5 l4 4 l8 -9" stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            : <path d="M8.5 8.5 l9 9 M17.5 8.5 l-9 9" stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" />}
      </svg>
    );
  }

  // ---- one item, sitting on a shelf. Click flips the label; dragging to the other shelf sets it. ----
  function Item({ item, label, wrong, hint, theme, onFlip, onDragStart, flash }) {
    const isFood = label === 'food';
    return (
      <button className={'aix-btn' + (flash ? ' aix-a-pop' : '')} draggable onClick={() => onFlip(item.id)} onDragStart={(e) => onDragStart(e, item.id)}
        aria-label={`${item.name}, labelled ${label}. Press to flip the label.`}
        style={{ cursor: 'grab', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '10px 12px', minWidth: 92, borderRadius: 18, background: '#fff',
                 border: `2px ${hint && wrong ? 'dashed' : 'solid'} ${hint && wrong ? RED : LINE}`, boxShadow: '0 3px 0 ' + LINE }}>
        <Glyph id={item.id} />
        <span style={{ fontSize: 14, fontWeight: 800, color: INK }}>{item.name}</span>
        <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: '#fff', background: isFood ? LEAF : '#7a6bd6', borderRadius: 999, padding: '2px 9px' }}>{label}</span>
        {hint && wrong && <span style={{ fontSize: 11.5, fontWeight: 700, color: RED }}>hmm, check me!</span>}
      </button>
    );
  }

  function Shelf({ title, tint, bar, children, onDropId }) {
    const [over, setOver] = React.useState(false);
    return (
      <div onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); onDropId(); }}
        style={{ flex: '1 1 300px', minWidth: 0, borderRadius: 22, background: tint, border: `2px ${over ? 'solid' : 'dashed'} ${over ? bar : LINE}`, padding: '12px 14px 16px', minHeight: 150, transition: 'border-color .15s' }}>
        <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: bar, marginBottom: 10 }}>{title}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>{children}</div>
      </div>
    );
  }

  function Speech({ children }) {
    return <div style={{ background: '#fff', border: `1.5px solid ${LINE}`, borderRadius: 16, padding: '9px 14px', fontSize: 15, fontWeight: 700, color: INK, lineHeight: 1.4, maxWidth: 380 }}>{children}</div>;
  }

  function BoltSays({ mood, outfit, children }) {
    const Bolt = window.AixBolt;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 18 }}>
        <div style={{ flex: '0 0 auto' }}>{Bolt ? <Bolt mood={mood} size={96} outfit={outfit} /> : null}</div>
        <div role="status" aria-live="polite"><Speech>{children}</Speech></div>
      </div>
    );
  }

  const btn = (bg, color, border) => ({ border: border || 'none', background: bg, color, borderRadius: 999, padding: '12px 24px', fontSize: 15.5, fontWeight: 800, cursor: 'pointer' });

  /** Reveals order results one by one (all at once for reduced motion). Calls onAllShown once at the end. */
  function OrderRun({ results, title, onAllShown, instant }) {
    const [shown, setShown] = React.useState(instant || reducedMotion() ? results.length : 0);
    const called = React.useRef(false);
    React.useEffect(() => {
      if (shown >= results.length) { if (!called.current) { called.current = true; onAllShown && onAllShown(); } return; }
      const t = setTimeout(() => { setShown(shown + 1); sfx(results[shown].correct ? 'good' : 'oops'); }, shown === 0 ? 400 : 1200);
      return () => clearTimeout(t);
    }, [shown]);
    return (
      <div style={{ flex: '1 1 320px', minWidth: 0 }}>
        {title && <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: FAINT, marginBottom: 8 }}>{title}</div>}
        {results.slice(0, shown).map((r, i) => (
          <div key={r.order.id} className="aix-a-rise" style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 12px', marginBottom: 8, borderRadius: 16, border: `1.5px solid ${r.correct ? '#bfe7cf' : '#f6c4c6'}`, background: r.correct ? '#f4fbf6' : '#fff6f6' }}>
            <span className={r.correct ? '' : 'aix-a-wobble'} style={{ display: 'inline-flex' }}><Glyph id={r.item.id} size={44} /></span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13, color: MUTE, fontWeight: 700 }}>{r.order.text}</span>
              <span style={{ display: 'block', fontSize: 15, color: INK, fontWeight: 700, marginTop: 2 }}>{window.AIX_SABOTAGE.outcomeLine(r)}</span>
            </span>
            <Mark ok={r.correct} />
          </div>
        ))}
        {shown < results.length && <div style={{ color: FAINT, fontSize: 14, fontWeight: 700, padding: '6px 4px' }}>Bolt is working on it...</div>}
      </div>
    );
  }

  /**
   * Sabotage! game. See the spec: A sabotage, B orders, C fix with before/after.
   * @param {{onDone:(stars:number)=>void, onExit:()=>void, theme:Object, seed:number}} props
   */
  function AixSabotageGame({ onDone, theme, seed }) {
    const S = window.AIX_SABOTAGE, C = window.AIXCore;
    const th = theme || { primary: '#2f6fe4' };
    const items = React.useMemo(() => S.pickItems(C.rng(seed)), [seed]);
    const [labels, setLabels] = React.useState(() => Object.fromEntries(S.ITEMS.map(it => [it.id, it.label])));
    const [phase, setPhase] = React.useState('A');            // A sabotage | B first run | C fix
    const [orders, setOrders] = React.useState([]);
    const [before, setBefore] = React.useState(null);        // results of the corrupted run
    const [after, setAfter] = React.useState(null);          // results of the latest fix run
    const [runDone, setRunDone] = React.useState(false);     // all rows of the current run revealed
    const [flash, setFlash] = React.useState(null);
    const [runId, setRunId] = React.useState(0);               // remounts the reveal on every re-run
    const [flipsA, setFlipsA] = React.useState(0);
    const dragId = React.useRef(null);
    const finished = React.useRef(false);

    const flips = S.countFlips(S.ITEMS, labels);
    const setLabel = (id, label) => { setLabels(l => l[id] === label ? l : { ...l, [id]: label }); setFlash(id); setTimeout(() => setFlash(null), 600); sfx(label === S.ITEMS.find(i => i.id === id).label ? 'good' : 'pop'); };
    const flip = (id) => setLabel(id, labels[id] === 'food' ? 'not food' : 'food');
    const onDragStart = (e, id) => { dragId.current = id; try { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; } catch (err) {} };
    const dropOn = (label) => () => { if (dragId.current) setLabel(dragId.current, label); dragId.current = null; };

    const run = (ords) => S.runOrders(S.train(S.labelled(S.ITEMS, labels)), ords);
    const goOrders = () => {
      const ords = S.pickOrders(C.rng(seed + 7), ORDERS_PER_RUN, S.flippedIds(S.ITEMS, labels));
      setOrders(ords); setFlipsA(flips); setBefore(run(ords)); setAfter(null); setRunDone(false); setPhase('B'); sfx('pop');
    };
    const rerun = () => { setAfter(run(orders)); setRunId(n => n + 1); setRunDone(false); sfx('pop'); };
    const finish = (finalCorrect) => { if (finished.current) return; finished.current = true; onDone(S.starsFor(flipsA, finalCorrect)); };

    const wrongIds = new Set(S.flippedIds(S.ITEMS, labels));
    const shelf = (label) => items.filter(it => labels[it.id] === label).map(it => (
      <Item key={it.id} item={it} label={labels[it.id]} wrong={wrongIds.has(it.id)} hint={phase === 'C'} theme={th} onFlip={flip} onDragStart={onDragStart} flash={flash === it.id} />
    ));
    const shelves = (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginBottom: 18 }}>
        <Shelf title="Food shelf" tint="#f4fbf6" bar={LEAF} onDropId={dropOn('food')}>{shelf('food')}</Shelf>
        <Shelf title="Not-food shelf" tint="#f6f4ff" bar="#7a6bd6" onDropId={dropOn('not food')}>{shelf('not food')}</Shelf>
      </div>
    );
    const score = (rs) => rs.filter(r => r.correct).length;

    // ---- Phase A ----
    if (phase === 'A') {
      const say = flips === 0 ? "Hi, I'm Bolt! I learn from the labels you give me. Tap an item to flip its label. Go on, be naughty!"
        : flips < 3 ? `Ooh, ${flips} sneaky ${flips === 1 ? 'label' : 'labels'}! I believe everything you tell me. Try one more!`
        : `${flips} naughty labels! I trust you completely. This is going to be hilarious.`;
      return (
        <div>
          <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: FAINT, marginBottom: 6 }}>Step 1 of 3: Be the naughty genius</div>
          <BoltSays mood={flips === 0 ? 'curious' : 'happy'}>{say}</BoltSays>
          <p style={{ color: MUTE, fontSize: 15, margin: '0 0 12px' }}>Tap an item to flip its label, or drag it to the other shelf. Bolt will learn whatever you teach him.</p>
          {shelves}
          <button className="aix-btn" onClick={goOrders} style={btn(th.primary, '#fff')}>{flips === 0 ? 'Skip the naughtiness, test Bolt' : 'Test Bolt with some orders!'}</button>
        </div>
      );
    }

    // ---- Phase B: the first (corrupted) run ----
    if (phase === 'B') {
      const bad = ORDERS_PER_RUN - score(before);
      const nowMood = !runDone ? 'curious' : bad > 0 ? 'dizzy' : 'happy';
      const msg = !runDone ? 'Orders are coming in...' : bad > 0 ? `Whoops! I got ${bad} wrong. I only know what my labels told me!` : 'I got all of them right. Boring! Want to be naughtier?';
      return (
        <div>
          <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: FAINT, marginBottom: 6 }}>Step 2 of 3: Bolt takes orders</div>
          <BoltSays mood={nowMood}>{msg}</BoltSays>
          <OrderRun results={before} onAllShown={() => setRunDone(true)} />
          {runDone && (
            <div className="aix-a-rise" style={{ marginTop: 14 }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: INK, marginBottom: 12 }}>{score(before)} / {ORDERS_PER_RUN} correct</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {bad > 0 && <button className="aix-btn" onClick={() => { setPhase('C'); sfx('pop'); }} style={btn(th.primary, '#fff')}>Fix Bolt's data</button>}
                {bad === 0 && <button className="aix-btn" onClick={() => finish(ORDERS_PER_RUN)} style={btn(th.primary, '#fff')}>Finish</button>}
                {flips < 3 && <button className="aix-btn" onClick={() => setPhase('A')} style={btn('#fff', INK, `1.5px solid ${LINE}`)}>Be naughtier first</button>}
              </div>
            </div>
          )}
        </div>
      );
    }

    // ---- Phase C: fix the labels, run again, compare ----
    const afterScore = after ? score(after) : null;
    const allGood = after && afterScore === ORDERS_PER_RUN;
    const mood = !after ? 'confused' : !runDone ? 'curious' : allGood ? 'proud' : 'confused';
    const msg = !after ? 'My data looks fishy! Tap the shelf items marked "check me" to put the labels right.'
      : !runDone ? 'Let me try again...'
      : allGood ? 'Perfect! Good labels make a good helper. AI is only as good as its data!'
      : `Better: ${afterScore} out of ${ORDERS_PER_RUN}! A few labels still look fishy. Fix them and run again.`;
    return (
      <div>
        <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: FAINT, marginBottom: 6 }}>Step 3 of 3: Fix the data</div>
        <BoltSays mood={mood}>{msg}</BoltSays>
        {shelves}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 20 }}>
          <button className="aix-btn" onClick={rerun} disabled={after && !runDone} style={btn(th.primary, '#fff')}>{after ? 'Run the orders again' : 'Run the same orders again'}</button>
        </div>
        {after && (
          <div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20 }}>
              <div style={{ flex: '1 1 320px', minWidth: 0 }}>
                <OrderRun key="before" instant results={before} title={`Before: ${score(before)} / ${ORDERS_PER_RUN} (messy labels)`} />
              </div>
              <OrderRun key={'after' + runId} results={after} title={`After: ${afterScore} / ${ORDERS_PER_RUN} (fixed labels)`} onAllShown={() => setRunDone(true)} />
            </div>
            {runDone && (
              <div className="aix-a-rise" style={{ marginTop: 16, padding: '14px 18px', borderRadius: 18, border: `1.5px dashed ${LINE}`, background: '#fffef9' }}>
                <div style={{ fontSize: 17, fontWeight: 800, color: INK }}>AI is only as good as its data.</div>
                <div style={{ fontSize: 14.5, color: MUTE, margin: '4px 0 12px' }}>Same Bolt, same orders. Only the labels changed.</div>
                <button className="aix-btn" onClick={() => finish(afterScore)} style={btn(SUN, INK)}>{allGood ? 'Finish' : 'Finish for now'}</button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  window.AIX_GAMES = window.AIX_GAMES || {};
  window.AIX_GAMES.sabotage = AixSabotageGame;
})();
