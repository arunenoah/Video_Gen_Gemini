/* ============================================================
   Fib Finder — a chatbot answers a kid question, but ONE sentence is a made-up fib. Tap a sentence with the
   magnifying glass, then accuse it. Wrong guesses are free: a funny reaction plus a hint, and one more try.
   Pure logic lives in vg-aix-fib.js (window.AIX_FIB). No text inputs, no network, no markup injection.
   ============================================================ */

const AIX_FIB_ROUNDS = 3;

// Bolt's lines. Picked by round number so a replay feels different without any randomness at render time.
const AIX_FIB_LOOK = ['Hmm, let me look closer...', 'My magnifier says: suspicious!', 'Zooming in. Bzzzt!', 'Is this one telling the truth?'];
const AIX_FIB_OOPS = ['Oops! That one is true. The fib is sneakier than that!', 'Nope! That sentence is honest. Try another one!', 'Bzzt! Wrong suspect. Read the hint!'];
const AIX_FIB_YES = ['Gotcha, fib! You have super detective eyes!', 'Caught it! That sentence was fibbing!', 'Yes! You spotted the made-up sentence!'];
const AIX_FIB_SNEAKY = ['Wow, that fib was a sneaky one! Now you know the truth.', 'Fibs can sound very sure of themselves. Now you know!'];

/** The drawn magnifying glass: round lens and a handle. No emoji, just SVG. */
function AixMagnifier({ size = 40, theme }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" style={{ flexShrink: 0 }}>
      <line x1="25" y1="25" x2="36" y2="36" stroke="#7a5a3a" strokeWidth="5" strokeLinecap="round" />
      <circle cx="16" cy="16" r="12" fill="rgba(120,200,255,.28)" stroke={theme.primary} strokeWidth="3.5" />
      <path d="M9 14 q2 -6 8 -6" stroke="#fff" strokeWidth="2.6" fill="none" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Fib Finder game.
 * @param {{onDone:(stars:number)=>void, onExit:()=>void, theme:Object, seed:number}} props
 */
function AixFibGame({ onDone, theme, seed }) {
  const F = window.AIX_FIB, C = window.AIXCore;
  const sfx = (n) => { try { window.aixSfx && window.aixSfx(n); } catch (e) {} };
  const rounds = React.useMemo(() => F.pickRounds(C.rng(seed), AIX_FIB_ROUNDS), [seed]);

  const [i, setI] = React.useState(0);                  // which round we are on
  const [looking, setLooking] = React.useState(null);   // sentence under the magnifier (not accused yet)
  const [struck, setStruck] = React.useState([]);       // wrongly accused sentences this round
  const [state, setState] = React.useState('hunting');  // hunting | found | gaveUp
  const [firstTry, setFirstTry] = React.useState(0);    // rounds found on the very first accusation
  const [said, setSaid] = React.useState('Read the chatbot answer. One sentence is a fib. Tap a sentence to look at it closely!');
  const [mood, setMood] = React.useState('curious');

  const round = rounds[i];
  const isLast = i === rounds.length - 1;
  const over = state !== 'hunting';

  const look = (idx) => {
    if (over || struck.indexOf(idx) !== -1) return;
    setLooking(idx); setMood('curious'); sfx('tick');
    setSaid(AIX_FIB_LOOK[(i + idx) % AIX_FIB_LOOK.length]);
  };

  const accuse = () => {
    if (looking === null || over) return;
    const r = F.check(round, looking);
    if (r.correct) {
      if (struck.length === 0) setFirstTry(n => n + 1);   // only a first-guess catch counts for stars
      setState('found'); setMood('proud'); sfx('good');
      setSaid(AIX_FIB_YES[i % AIX_FIB_YES.length]);
    } else if (struck.length === 0) {
      setStruck([looking]); setMood('confused'); sfx('oops');   // one free retry, with the hint showing
      setSaid(AIX_FIB_OOPS[i % AIX_FIB_OOPS.length]);
    } else {
      setStruck(s => s.concat(looking)); setState('gaveUp'); setMood('dizzy'); sfx('oops');
      setSaid(AIX_FIB_SNEAKY[i % AIX_FIB_SNEAKY.length]);
    }
    setLooking(null);
  };

  const next = () => {
    if (isLast) { onDone(F.starsFor(firstTry, rounds.length)); return; }
    setI(i + 1); setLooking(null); setStruck([]); setState('hunting'); setMood('curious');
    setSaid('New question! Which sentence is the fib this time?'); sfx('pop');
  };

  const btn = (bg, color, extra) => ({ border: 'none', background: bg, color, borderRadius: 999, padding: '11px 22px', fontSize: 15.5, fontWeight: 800, cursor: 'pointer', ...extra });

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <div role="status" aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{said}</div>

      {/* Bolt, his speech bubble and the round counter */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 18 }}>
        <div style={{ flex: '0 0 auto' }}><AixBolt mood={mood} size={96} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...AIX_EYEBROW, marginBottom: 6 }}>Round {i + 1} of {rounds.length} · {round.topic}</div>
          <div style={{ background: '#fff', border: `1.5px solid ${AIX.line}`, borderRadius: 16, padding: '10px 14px', fontSize: 15.5, fontWeight: 700, color: AIX.ink }}>{said}</div>
        </div>
      </div>

      {/* the kid's question */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
        <div style={{ background: theme.primary, color: '#fff', borderRadius: '18px 18px 4px 18px', padding: '10px 16px', fontSize: 16.5, fontWeight: 800, maxWidth: '85%' }}>{round.question}</div>
      </div>

      {/* the chatbot's answer: every sentence is a real button, so keyboard and touch work the same */}
      <div style={{ background: AIX.paper, border: `1.5px solid ${AIX.line}`, borderRadius: '18px 18px 18px 4px', padding: '14px 14px 8px' }}>
        <div style={{ ...AIX_EYEBROW, marginBottom: 8 }}>Chatterbox says</div>
        {round.sentences.map((s, idx) => {
          const isStruck = struck.indexOf(idx) !== -1;
          const isFib = over && idx === round.fib;
          const isLook = looking === idx;
          const border = isFib ? (state === 'found' ? AIX.leaf : AIX.red) : isLook ? theme.primary : isStruck ? AIX.line : 'transparent';
          return (
            <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <button className={'aix-btn' + (isFib ? ' aix-a-pop' : isStruck ? ' aix-a-wobble' : '')} disabled={over || isStruck} onClick={() => look(idx)} aria-pressed={isLook}
                aria-label={`Sentence ${idx + 1}: ${s}${isStruck ? '. Not the fib' : ''}${isFib ? '. This is the fib' : ''}`}
                style={{ flex: 1, textAlign: 'left', border: `2px solid ${border}`, background: isFib ? (state === 'found' ? '#e8f7ee' : '#fdecec') : isLook ? (theme.tint || '#eff6ff') : '#fff',
                         color: isStruck ? AIX.faint : AIX.ink, textDecoration: isStruck ? 'line-through' : 'none', borderRadius: 12, padding: isLook ? '14px 14px' : '10px 14px',
                         fontSize: isLook ? 19 : 16, lineHeight: 1.45, fontWeight: isLook ? 800 : 600, cursor: over || isStruck ? 'default' : 'zoom-in', transition: 'font-size .15s, padding .15s' }}>
                {s}
              </button>
              {isLook && <span className="aix-a-pop"><AixMagnifier theme={theme} /></span>}
            </div>
          );
        })}
      </div>

      {/* actions: accuse the sentence under the magnifier, hint after a miss, reveal after the round */}
      <div style={{ marginTop: 16, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        {!over && <button className="aix-btn" disabled={looking === null} onClick={accuse} style={btn(looking === null ? '#cfd8df' : theme.primary, '#fff', { cursor: looking === null ? 'not-allowed' : 'pointer' })}>That is the fib!</button>}
        {!over && looking !== null && <button className="aix-btn" onClick={() => setLooking(null)} style={btn('#fff', AIX.ink, { border: `1.5px solid ${AIX.line}` })}>Keep looking</button>}
        {!over && looking === null && <span style={{ color: AIX.faint, fontSize: 14, fontWeight: 700 }}>Tap a sentence to put the magnifier on it.</span>}
        {over && <button className="aix-btn" onClick={next} style={btn(theme.primary, '#fff')}>{isLast ? 'Finish' : 'Next question'}</button>}
      </div>

      {!over && struck.length > 0 && (
        <div className="aix-a-rise" style={{ marginTop: 14, border: `1.5px dashed ${AIX.warm}`, borderRadius: 14, padding: '10px 14px', background: '#fff8ee', color: AIX.ink, fontSize: 15 }}>
          <strong>Hint:</strong> {round.tip}
        </div>
      )}
      {over && (
        <div className="aix-a-rise" style={{ marginTop: 14, border: `1.5px solid ${AIX.line}`, borderRadius: 14, padding: '12px 16px', background: '#fff' }}>
          <div style={AIX_EYEBROW}>The truth</div>
          <div style={{ fontSize: 16, color: AIX.ink, margin: '4px 0 8px', fontWeight: 700 }}>{round.truth}</div>
          <div style={AIX_EYEBROW}>How to check</div>
          <div style={{ fontSize: 15, color: AIX.mute, marginTop: 4 }}>{round.tip}</div>
          <div style={{ fontSize: 14, color: AIX.faint, marginTop: 8 }}>AI can sound very sure and still be wrong. Always check with a grown-up or a good book.</div>
        </div>
      )}
    </div>
  );
}

window.AIX_GAMES = window.AIX_GAMES || {};
window.AIX_GAMES.fib = AixFibGame;
