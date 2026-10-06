/* ============================================================
   Pet Sorter — teach Bolt "cat or dog?" by sorting pets, watch his confidence meter climb, then test him.
   Logic lives in vg-aix-sorter.js (window.AIX_SORTER). Drag pets onto a pile, OR tap a pet then tap a pile.
   Reuses the shell's AIX colours, AixBolt and aixSfx. No text input, no network, no markup injection.
   ============================================================ */

// fur colour -> [main, shade]
const SORTER_FUR = { gray: ['#9aa5b1', '#7b8794'], orange: ['#f3a04a', '#d9822b'], cream: ['#f4dfb8', '#dcc08a'], black: ['#4a5461', '#343c47'], white: ['#f7f7f4', '#d9dcd9'], brown: ['#b98657', '#96653a'] };
const SORTER_SIZE = { s: 0.82, m: 1, l: 1.14 };

/** One drawn pet. Ears, tail and size follow the creature's tags; cats get whiskers, dogs get a tongue. */
function AixPet({ pet, size = 96 }) {
  const [main, shade] = SORTER_FUR[pet.color] || SORTER_FUR.gray;
  const k = SORTER_SIZE[pet.size] || 1;
  const ink = AIX.ink;
  const cat = pet.cls === 'cat';
  const earsBehind = pet.ears !== 'floppy';          // floppy ears hang over the face, the others sit behind the head
  const tail = {
    thin: <path d="M72 74 Q94 68 90 46" stroke={main} strokeWidth="4.5" fill="none" strokeLinecap="round" />,
    fluffy: <g><ellipse cx="82" cy="62" rx="9" ry="16" fill={main} transform="rotate(24 82 62)" /><ellipse cx="84" cy="58" rx="4" ry="9" fill="#fff" opacity=".35" transform="rotate(24 82 62)" /></g>,
    curly: <path d="M72 76 q18 2 13 -11 q-5 -9 -12 -2 q-3 5 3 6" stroke={main} strokeWidth="4.5" fill="none" strokeLinecap="round" />,
    stubby: <circle cx="76" cy="73" r="5.5" fill={main} />,
  }[pet.tail];
  const ears = {
    pointy: <g><polygon points="31 36 33 12 47 26" fill={main} stroke={shade} strokeWidth="1.5" strokeLinejoin="round" /><polygon points="69 36 67 12 53 26" fill={main} stroke={shade} strokeWidth="1.5" strokeLinejoin="round" /><polygon points="35 31 36 19 43 26" fill="#ffb3c6" /><polygon points="65 31 64 19 57 26" fill="#ffb3c6" /></g>,
    round: <g><circle cx="33" cy="27" r="9.5" fill={main} stroke={shade} strokeWidth="1.5" /><circle cx="67" cy="27" r="9.5" fill={main} stroke={shade} strokeWidth="1.5" /><circle cx="33" cy="27" r="4.5" fill="#ffb3c6" /><circle cx="67" cy="27" r="4.5" fill="#ffb3c6" /></g>,
    floppy: <g><ellipse cx="29" cy="48" rx="8" ry="15" fill={shade} transform="rotate(14 29 48)" /><ellipse cx="71" cy="48" rx="8" ry="15" fill={shade} transform="rotate(-14 71 48)" /></g>,
  }[pet.ears];
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" style={{ display: 'block', overflow: 'visible' }}>
      <g transform={`translate(50 94) scale(${k}) translate(-50 -94)`}>
        {tail}
        {earsBehind && ears}
        <ellipse cx="50" cy="75" rx="24" ry="17" fill={main} stroke={shade} strokeWidth="1.5" />
        <ellipse cx="50" cy="80" rx="12" ry="9" fill="#fff" opacity=".3" />
        <ellipse cx="39" cy="91" rx="7" ry="4" fill={main} stroke={shade} strokeWidth="1.5" />
        <ellipse cx="61" cy="91" rx="7" ry="4" fill={main} stroke={shade} strokeWidth="1.5" />
        <circle cx="50" cy="45" r="21" fill={main} stroke={shade} strokeWidth="1.5" />
        {!earsBehind && ears}
        <circle cx="42" cy="44" r="3.2" fill={ink} /><circle cx="58" cy="44" r="3.2" fill={ink} />
        <circle cx="43" cy="43" r="1" fill="#fff" /><circle cx="59" cy="43" r="1" fill="#fff" />
        <ellipse cx="50" cy="52" rx="3.2" ry="2.3" fill={cat ? '#ff8fb0' : ink} />
        <path d="M45 57 q5 5 10 0" stroke={ink} strokeWidth="1.8" fill="none" strokeLinecap="round" />
        {cat
          ? <g stroke={ink} strokeWidth="1" strokeLinecap="round" opacity=".55"><path d="M34 52 l-12 -3 M34 55 l-12 3 M66 52 l12 -3 M66 55 l12 3" /></g>
          : <ellipse cx="50" cy="61.5" rx="3" ry="3.6" fill="#ff7aa8" />}
      </g>
    </svg>
  );
}

/** The three tags Bolt can see for a pet, as small pills. */
function AixPetTags({ pet }) {
  const pill = { fontSize: 12, fontWeight: 700, color: AIX.mute, background: '#f1f4f7', borderRadius: 999, padding: '3px 9px' };
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 5, justifyContent: 'center' }}>
      <span style={pill}>{pet.ears} ears</span><span style={pill}>{pet.tail} tail</span><span style={pill}>says {pet.sound}</span>
    </span>
  );
}

/** Bolt's confidence meter: the fill animates smoothly each time the number changes. */
function AixMeter({ value, theme }) {
  const pct = Math.round(value * 100);
  return (
    <div style={{ width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', ...AIX_EYEBROW, marginBottom: 5 }}><span>Bolt's confidence</span><span>{pct}%</span></div>
      <div role="img" aria-label={`Bolt is ${pct} percent sure`} style={{ height: 16, borderRadius: 999, background: '#eef1f4', overflow: 'hidden', border: `1px solid ${AIX.line}` }}>
        <div style={{ width: `${Math.max(4, (pct - 50) * 2)}%`, height: '100%', borderRadius: 999, background: value >= 0.8 ? AIX.leaf : value >= 0.65 ? theme.primary : AIX.sun, transition: 'width .6s cubic-bezier(.34,1.56,.64,1), background .4s' }} />
      </div>
    </div>
  );
}

function AixSortBubble({ children, wobble }) {
  return (
    <div className={wobble ? 'aix-a-wobble' : ''} role="status" aria-live="polite" style={{ background: '#fff', border: `1.5px solid ${AIX.line}`, borderRadius: 16, padding: '9px 14px', fontSize: 14.5, fontWeight: 700, color: AIX.ink, lineHeight: 1.4, minHeight: 22 }}>{children}</div>
  );
}

const sortSfx = (n) => { try { if (typeof window.aixSfx === 'function') window.aixSfx(n); } catch (e) { /* sound is optional */ } };

/**
 * Pet Sorter game component (shell contract).
 * @param {{onDone:(stars:number)=>void, onExit:()=>void, theme:Object, seed:number}} props
 */
function AixSorterGame({ onDone, theme, seed }) {
  const S = window.AIX_SORTER;
  const plan = React.useMemo(() => S.pickTrainAndTest(window.AIXCore.rng(seed)), [seed]);
  const rand = React.useRef(window.AIXCore.rng((Number(seed) || 0) + 77));       // separate stream for Bolt's chatter
  const [phase, setPhase] = React.useState('sort');                              // sort | test | result
  const [piles, setPiles] = React.useState({});                                  // petId -> 'cat' | 'dog'
  const [picked, setPicked] = React.useState(null);                              // petId chosen for click-to-place
  const [hover, setHover] = React.useState(null);                                // pile under a drag
  const [say, setSay] = React.useState({ mood: 'curious', text: "Hi! I'm Bolt and I have never seen a cat or a dog. Show me some pets!" });
  const [idx, setIdx] = React.useState(0);                                       // current mystery pet
  const [shown, setShown] = React.useState(false);                               // has Bolt guessed this one yet
  const dragId = React.useRef(null);
  const finished = React.useRef(false);

  const byId = React.useMemo(() => { const m = {}; plan.train.forEach(p => { m[p.id] = p; }); return m; }, [plan]);
  const sorted = Object.keys(piles);
  const examples = sorted.map(id => ({ creature: byId[id], label: piles[id] }));
  const model = React.useMemo(() => S.train(examples), [piles]);                 // retrained after every drop
  const everyone = plan.train.concat(plan.test);
  const conf = S.meter(model, everyone);
  const tray = plan.train.filter(p => !piles[p.id]);

  const place = (id, label) => {
    const pet = byId[id];
    if (!pet || phase !== 'sort') return;
    const r = S.reaction(pet, label, rand.current);
    setPiles(p => ({ ...p, [id]: label }));
    setSay({ mood: r.mood, text: r.text });
    setPicked(null); setHover(null);
    sortSfx(r.agree ? 'good' : 'oops');
  };
  const putBack = (id) => {                                                    // tapping a pet in a pile returns it to the tray
    setPiles(p => { const n = { ...p }; delete n[id]; return n; });
    setSay({ mood: 'curious', text: `Okay, ${byId[id].name} is back in the tray. Bolt forgets that one.` });
    sortSfx('tick');
  };
  const pickPet = (id) => { setPicked(picked === id ? null : id); sortSfx('pop'); };

  const canTest = sorted.length >= S.MIN_TO_TEST;
  const test = phase === 'test' || phase === 'result' ? S.scoreTest(model, plan.test) : null;
  const finish = () => {
    if (finished.current) return;
    finished.current = true;
    onDone(S.starsFor(test.correct, sorted.length));
  };

  // ---- Bolt's mood follows the live meter unless he just reacted to a drop ----
  const boltMood = say.mood;

  const pileBox = (label, title) => {
    const mine = sorted.filter(id => piles[id] === label);
    const active = hover === label;
    return (
      <div onDragOver={(e) => { e.preventDefault(); setHover(label); }} onDragLeave={() => setHover(null)}
        onDrop={(e) => { e.preventDefault(); if (dragId.current) place(dragId.current, label); dragId.current = null; }}
        style={{ flex: '1 1 240px', minWidth: 0, borderRadius: 22, border: `2px ${active || picked ? 'solid' : 'dashed'} ${active ? theme.primary : AIX.line}`, background: active ? (theme.tint || '#eff6ff') : '#fff', padding: 12, transition: 'background .2s, border-color .2s' }}>
        <button className="aix-btn" disabled={!picked} onClick={() => picked && place(picked, label)}
          aria-label={picked ? `Put ${byId[picked].name} in the ${title} pile` : `${title} pile. ${mine.length} pets. Pick a pet first`}
          style={{ width: '100%', border: 'none', borderRadius: 14, padding: '10px 12px', background: picked ? theme.primary : '#f1f4f7', color: picked ? '#fff' : AIX.mute, fontSize: 16, fontWeight: 800, cursor: picked ? 'pointer' : 'default' }}>
          {title} pile ({mine.length}){picked ? ' - put it here' : ''}
        </button>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, minHeight: 74, marginTop: 8, alignContent: 'flex-start' }}>
          {mine.map(id => (
            <button key={id} className="aix-a-pop" onClick={() => putBack(id)} aria-label={`${byId[id].name} is in the ${title} pile. Tap to put back`} style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer' }}>
              <AixPet pet={byId[id]} size={54} />
            </button>
          ))}
          {!mine.length && <span style={{ color: AIX.faint, fontSize: 13.5, padding: '22px 6px' }}>Drop pets here</span>}
        </div>
      </div>
    );
  };

  // ---- Bolt + meter panel, shared by both phases ----
  const boltPanel = (mood, text, wobble, value) => (
    <div style={{ flex: '0 0 230px', maxWidth: '100%', margin: '0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
      <AixSortBubble wobble={wobble}>{text}</AixSortBubble>
      <AixBolt mood={mood} size={130} />
      <AixMeter value={value} theme={theme} />
    </div>
  );

  if (phase === 'sort') {
    const pk = picked ? byId[picked] : null;
    return (
      <div>
        <p style={{ margin: '0 0 16px', color: AIX.mute, fontSize: 15.5, maxWidth: 640 }}>
          Show Bolt some pets! Drag each pet onto the Cat pile or the Dog pile, or tap a pet and then tap a pile. Bolt learns from what you show him. Sort at least {S.MIN_TO_TEST} to test him.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '20px 28px', alignItems: 'flex-start' }}>
          {boltPanel(boltMood, say.text, false, conf)}
          <div style={{ flex: '1 1 380px', minWidth: 0 }}>
            <div style={{ ...AIX_EYEBROW, marginBottom: 8 }}>The pet tray ({tray.length} left)</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, minHeight: 112, padding: 10, borderRadius: 20, background: AIX.paper, border: `1.5px solid ${AIX.line}` }}>
              {tray.map(p => (
                <button key={p.id} className="aix-btn" draggable onDragStart={(e) => { dragId.current = p.id; setPicked(p.id); try { e.dataTransfer.setData('text/plain', p.id); e.dataTransfer.effectAllowed = 'move'; } catch (er) { /* drag still works via the ref */ } }}
                  onDragEnd={() => { dragId.current = null; setHover(null); }} onClick={() => pickPet(p.id)} aria-pressed={picked === p.id}
                  aria-label={`${p.name}: ${p.ears} ears, ${p.tail} tail, says ${p.sound}${picked === p.id ? '. Picked. Now tap a pile' : '. Tap to pick'}`}
                  style={{ border: `2px solid ${picked === p.id ? theme.primary : AIX.line}`, background: picked === p.id ? (theme.tint || '#eff6ff') : '#fff', borderRadius: 18, padding: '6px 8px 8px', cursor: 'grab', width: 96, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <span className={picked === p.id ? 'aix-a-bounce' : ''} style={{ display: 'block' }}><AixPet pet={p} size={70} /></span>
                  <span style={{ fontSize: 12.5, fontWeight: 800, color: AIX.ink }}>{p.name}</span>
                </button>
              ))}
              {!tray.length && <span style={{ color: AIX.faint, fontSize: 14, padding: 30 }}>All sorted! Bolt has seen every pet.</span>}
            </div>
            <div style={{ minHeight: 36, margin: '10px 0' }}>
              {pk && <div className="aix-a-rise" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 13.5, color: AIX.mute, fontWeight: 700 }}>Bolt can only see: <AixPetTags pet={pk} /></div>}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>{pileBox('cat', 'Cat')}{pileBox('dog', 'Dog')}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginTop: 18 }}>
              <button className="aix-btn" disabled={!canTest} onClick={() => { setPhase('test'); setIdx(0); setShown(false); setPicked(null); sortSfx('pop'); setSay({ mood: 'curious', text: 'Ooh, a test! Show me a mystery pet.' }); }}
                style={{ border: 'none', borderRadius: 999, padding: '13px 28px', fontSize: 16, fontWeight: 800, background: canTest ? theme.primary : '#cfd8df', color: '#fff', cursor: canTest ? 'pointer' : 'not-allowed' }}>Test Bolt</button>
              {!canTest && <span style={{ color: AIX.faint, fontSize: 13.5, fontWeight: 700 }}>Sort {S.MIN_TO_TEST - sorted.length} more to unlock the test</span>}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---- test phase: one mystery pet at a time, Bolt guesses, then the truth is revealed ----
  const cur = plan.test[idx], res = test.results[idx];
  const last = idx === plan.test.length - 1;
  const doneSoFar = test.results.slice(0, shown ? idx + 1 : idx);
  const rightSoFar = doneSoFar.filter(r => r.right).length;
  let testSay = { mood: 'curious', text: 'Who is this mystery pet? Tap the button and I will guess!' };
  if (shown) {
    const pctText = Math.round(res.confidence * 100);
    testSay = res.right
      ? { mood: 'proud', text: res.unsure ? `Hmm, maybe a ${res.label}? (${pctText}% sure) ... and I was right!` : `A ${res.label}! (${pctText}% sure) Easy peasy!` }
      : { mood: res.unsure ? 'dizzy' : 'confused', text: res.unsure ? `Hmm, maybe a ${res.label}? (${pctText}% sure) ... oh, it was a ${cur.cls}! Oops!` : `A ${res.label}! (${pctText}% sure) ... wait, it is a ${cur.cls}? Bolt needs more examples!` };
  }
  return (
    <div>
      <p style={{ margin: '0 0 16px', color: AIX.mute, fontSize: 15.5 }}>Mystery pet {idx + 1} of {plan.test.length}. Bolt has never seen this one before. Bolt got {rightSoFar} right so far.</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '20px 36px', alignItems: 'center', justifyContent: 'center' }}>
        {boltPanel(testSay.mood, testSay.text, shown && res.unsure, shown ? res.confidence : conf)}
        <div style={{ flex: '0 1 340px', textAlign: 'center' }}>
          <div key={cur.id} className="aix-a-pop" style={{ display: 'inline-block', background: AIX.paper, border: `1.5px solid ${AIX.line}`, borderRadius: 26, padding: '14px 26px 12px' }}>
            <AixPet pet={cur} size={150} />
            <div style={{ fontSize: 18, fontWeight: 800, color: AIX.ink, margin: '4px 0 6px' }}>{shown ? `${cur.name} the ${cur.cls}` : 'Mystery pet'}</div>
            <AixPetTags pet={cur} />
          </div>
          <div style={{ marginTop: 18, display: 'flex', justifyContent: 'center', gap: 10 }}>
            {!shown && <button className="aix-btn" onClick={() => { setShown(true); sortSfx(res.right ? 'good' : 'oops'); }} style={{ border: 'none', borderRadius: 999, padding: '13px 26px', fontSize: 16, fontWeight: 800, background: theme.primary, color: '#fff', cursor: 'pointer' }}>What is it, Bolt?</button>}
            {shown && !last && <button className="aix-btn" onClick={() => { setIdx(idx + 1); setShown(false); sortSfx('pop'); }} style={{ border: 'none', borderRadius: 999, padding: '13px 26px', fontSize: 16, fontWeight: 800, background: theme.primary, color: '#fff', cursor: 'pointer' }}>Next mystery pet</button>}
            {shown && last && <button className="aix-btn" onClick={finish} style={{ border: 'none', borderRadius: 999, padding: '13px 26px', fontSize: 16, fontWeight: 800, background: AIX.leaf, color: '#fff', cursor: 'pointer' }}>All done! See my stars</button>}
          </div>
          {shown && last && <p style={{ color: AIX.mute, fontSize: 14.5, marginTop: 14 }}>Bolt got {test.correct} of {test.total}. {test.correct === test.total ? 'Perfect!' : 'The more pets you show him, the better he gets!'}</p>}
        </div>
      </div>
    </div>
  );
}

window.AIX_GAMES = window.AIX_GAMES || {};
window.AIX_GAMES.sorter = AixSorterGame;
