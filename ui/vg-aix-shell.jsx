/* ============================================================
   SparkGarden — AI Explorers shell: the garden-path map, Bolt the robot (and his outfits), confetti, sound, rewards.
   Games live in their own files and register themselves on window.AIX_GAMES[lessonId]; this file only hosts them.
   Everything stays in the browser. Progress is validated by AIXCore on every load and saved to localStorage only.
   No text inputs, no network, no markup injection: every interactive thing is a real <button>.
   ============================================================ */

const AIX = { ink: '#14202b', mute: '#5b6b79', faint: '#94a3b0', line: '#e4e8ec', sun: '#f5b82e', leaf: '#2f9e5b', pink: '#ff7aa8', red: '#e5484d', warm: '#b45309', paper: '#fffef9' };
const AIX_EYEBROW = { fontSize: 11.5, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: AIX.faint };

// ---- animation styles: built with createElement + textContent (never parsed as markup), injected once ----
(function injectAixStyles() {
  try {
    if (document.getElementById('aix-style')) return;
    const css = [
      '@keyframes aix-bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-9px)}}',
      '@keyframes aix-wobble{0%,100%{transform:rotate(-6deg)}50%{transform:rotate(6deg)}}',
      '@keyframes aix-tilt{0%,100%{transform:rotate(0)}40%{transform:rotate(-5deg)}70%{transform:rotate(4deg)}}',
      '@keyframes aix-pop{0%{transform:scale(0)}65%{transform:scale(1.3)}100%{transform:scale(1)}}',
      '@keyframes aix-fall{0%{transform:translate3d(0,-30px,0) rotate(0);opacity:1}100%{transform:translate3d(var(--dx),420px,0) rotate(var(--rot));opacity:0}}',
      '@keyframes aix-spin{to{transform:rotate(360deg)}}',
      '@keyframes aix-sway{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(4deg)}}',
      '@keyframes aix-rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}',
      '.aix-a-bounce{animation:aix-bounce 1.1s ease-in-out infinite}',
      '.aix-a-wobble{animation:aix-wobble .5s ease-in-out infinite}',
      '.aix-a-tilt{animation:aix-tilt 2.4s ease-in-out infinite}',
      '.aix-a-pop{animation:aix-pop .5s cubic-bezier(.34,1.56,.64,1) both}',
      '.aix-a-spin{animation:aix-spin .35s linear infinite;transform-box:fill-box;transform-origin:center}',
      '.aix-a-sway{animation:aix-sway 3s ease-in-out infinite;transform-box:fill-box;transform-origin:50% 100%}',
      '.aix-a-rise{animation:aix-rise .4s ease-out both}',
      '.aix-confetti{position:absolute;top:0;width:10px;height:14px;border-radius:2px;animation:aix-fall var(--dur) ease-in var(--delay) both}',
      '.aix-btn{transition:transform .18s cubic-bezier(.34,1.56,.64,1),box-shadow .18s}',
      '.aix-btn{min-height:44px}',
      '@media (hover:hover){.aix-btn:hover:not(:disabled){transform:translateY(-3px) scale(1.015)}}',   // hover is only a flourish, never the only cue
      '.aix-studios{display:grid;grid-template-columns:1fr 1fr;gap:16px}',
      '@media (max-width:639px){.aix-studios{grid-template-columns:1fr}}',   // phones: one column
      '.aix-btn:active:not(:disabled){transform:scale(.97)}',
      '.aix-btn:focus-visible{outline:3px solid #14202b;outline-offset:2px}',
      // kids who ask for less motion get a calm page: no bouncing, no confetti, no hover movement
      '@media (prefers-reduced-motion: reduce){[class*="aix-a-"],.aix-confetti{animation:none!important}.aix-btn{transition:none!important}.aix-btn:hover:not(:disabled){transform:none}}',
    ].join('\n');
    const el = document.createElement('style');
    el.id = 'aix-style';
    el.textContent = css;
    document.head.appendChild(el);
  } catch (e) { /* styling is a nicety; the page still works without it */ }
})();

/** True when the OS asks for reduced motion. Re-checked on change. */
function useAixReduced() {
  const q = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };
  const [r, setR] = React.useState(q);
  React.useEffect(() => {
    let m; try { m = window.matchMedia('(prefers-reduced-motion: reduce)'); } catch (e) { return; }
    const on = () => setR(m.matches);
    if (m.addEventListener) { m.addEventListener('change', on); return () => m.removeEventListener('change', on); }
  }, []);
  return r;
}

/** True on phone-width screens (< 640px). Re-checked on change. */
function useAixNarrow() {
  const Q = '(max-width: 639px)';
  const q = () => { try { return window.matchMedia(Q).matches; } catch (e) { return false; } };
  const [n, setN] = React.useState(q);
  React.useEffect(() => {
    let m; try { m = window.matchMedia(Q); } catch (e) { return; }
    const on = () => setN(m.matches);
    if (m.addEventListener) { m.addEventListener('change', on); return () => m.removeEventListener('change', on); }
  }, []);
  return n;
}

// ---- sound: tiny synthesised blips, created lazily on the first call (a user gesture), all in try/catch ----
(function () {
  let ctx = null, muted = false;
  const NOTES = {                                  // [frequency Hz, start s, length s, wave]
    pop:  [[520, 0, .09, 'sine'], [780, .05, .09, 'sine']],
    good: [[523, 0, .1, 'triangle'], [659, .09, .1, 'triangle'], [784, .18, .16, 'triangle']],
    oops: [[330, 0, .12, 'sawtooth'], [220, .11, .2, 'sawtooth']],
    win:  [[523, 0, .12, 'triangle'], [659, .11, .12, 'triangle'], [784, .22, .12, 'triangle'], [1047, .33, .3, 'triangle']],
    tick: [[900, 0, .04, 'square']],
  };
  /** Play a named blip. @param {'pop'|'good'|'oops'|'win'|'tick'} name  No-op when muted or unsupported. */
  function aixSfx(name) {
    try {
      if (muted || !NOTES[name]) return;
      if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; ctx = new AC(); }
      if (ctx.state === 'suspended') ctx.resume();
      const t0 = ctx.currentTime;
      NOTES[name].forEach(([f, at, len, wave]) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = wave; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + at);
        g.gain.exponentialRampToValueAtTime(0.12, t0 + at + 0.01);      // soft attack, quiet overall
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
        o.connect(g); g.connect(ctx.destination);
        o.start(t0 + at); o.stop(t0 + at + len + 0.02);
      });
    } catch (e) { /* no sound is fine */ }
  }
  aixSfx.setMuted = (m) => { muted = !!m; };
  window.aixSfx = aixSfx;
})();

// ---- drawn glyphs ----
function AixStar({ on, size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ flexShrink: 0 }}>
      <polygon points="12 2 15.1 8.6 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.6 12 2" fill={on ? AIX.sun : '#fff'} stroke={on ? '#d99a0b' : '#c3ccd4'} strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function AixStars({ n, size = 20, pop }) {
  return (
    <span role="img" aria-label={`${n} of 3 stars`} style={{ display: 'inline-flex', gap: 2 }}>
      {[0, 1, 2].map(i => (
        <span key={i} className={pop && i < n ? 'aix-a-pop' : ''} style={{ display: 'inline-flex', animationDelay: `${0.25 + i * 0.25}s` }}><AixStar on={i < n} size={size} /></span>
      ))}
    </span>
  );
}

/** A plant that grows with stars: 0 = seed, 1 = sprout, 2 = bud, 3 = flower. */
function AixPlant({ stage, size = 54 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 56 56" aria-hidden="true" style={{ flexShrink: 0 }}>
      <ellipse cx="28" cy="49" rx="17" ry="5.5" fill="#b98a5b" />
      {stage === 0 && <ellipse cx="28" cy="45" rx="3.5" ry="2.4" fill="#7a5a3a" />}
      {stage > 0 && (
        <g className="aix-a-sway">
          <path d="M28 46 V26" stroke={AIX.leaf} strokeWidth="3.4" strokeLinecap="round" />
          <path d="M28 38 q-12 -2 -13 -12 q11 0 13 12z" fill="#53c27f" />
          <path d="M28 33 q12 -2 13 -12 q-11 0 -13 12z" fill={AIX.leaf} />
          {stage === 2 && <circle cx="28" cy="22" r="6" fill={AIX.pink} />}
          {stage === 3 && <g>
            {[0, 72, 144, 216, 288].map(a => <circle key={a} cx={28 + 7.5 * Math.cos(a * Math.PI / 180)} cy={18 + 7.5 * Math.sin(a * Math.PI / 180)} r="5.4" fill={AIX.pink} />)}
            <circle cx="28" cy="18" r="5" fill={AIX.sun} />
          </g>}
        </g>
      )}
    </svg>
  );
}

const AIX_BODY = { 'p-starter-blue': '#5bb8f0', 'p-gold-color': '#f5b82e', 'p-stardust-color': '#a78bfa' };

/**
 * Bolt the robot, drawn in SVG.
 * @param {{mood?:'curious'|'confused'|'proud'|'dizzy'|'happy', size?:number, outfit?:Object}} props outfit maps slot -> part id
 */
function AixBolt({ mood = 'happy', size = 120, outfit = {} }) {
  const o = outfit || {};
  const body = AIX_BODY[o.color] || AIX_BODY['p-starter-blue'];
  const ink = AIX.ink;
  const wob = { happy: 'aix-a-bounce', proud: 'aix-a-bounce', dizzy: 'aix-a-wobble', curious: 'aix-a-tilt', confused: '' }[mood] || '';
  const eye = (cx) => {
    if (mood === 'proud') return <path key={cx} d={`M${cx - 6} 49 q6 -10 12 0`} stroke={ink} strokeWidth="3.6" fill="none" strokeLinecap="round" />;
    if (mood === 'dizzy') return <g key={cx} fill="none" stroke={ink} strokeWidth="2.2"><circle cx={cx} cy="46" r="6.5" /><circle cx={cx} cy="46" r="2.8" /></g>;
    const r = mood === 'curious' ? (cx > 60 ? 7.5 : 5) : mood === 'confused' ? (cx > 60 ? 7 : 4.2) : 5.8;
    const dx = mood === 'curious' ? 1.5 : 0, dy = mood === 'curious' ? -1.5 : 0;
    return <g key={cx}><circle cx={cx} cy="46" r={r} fill={ink} /><circle cx={cx + dx + 1.6} cy={46 + dy - 1.8} r="1.8" fill="#fff" /></g>;
  };
  const mouth = {
    happy: <path d="M50 58 q10 9 20 0" stroke={ink} strokeWidth="3.4" fill="none" strokeLinecap="round" />,
    proud: <path d="M47 56 q13 15 26 0z" fill={ink} />,
    curious: <circle cx="60" cy="60" r="3.4" fill={ink} />,
    confused: <path d="M49 60 q5.5 -6 11 0 t11 0" stroke={ink} strokeWidth="3" fill="none" strokeLinecap="round" />,
    dizzy: <path d="M49 60 q5.5 -6 11 0 t11 0" stroke={ink} strokeWidth="3" fill="none" strokeLinecap="round" />,
  }[mood] || null;
  return (
    <svg className={wob} width={size} height={size * 1.18} viewBox="0 -14 120 160" role="img" aria-label={`Bolt the robot looks ${mood}`} style={{ display: 'block', overflow: 'visible' }}>
      {o.body === 'p-cape-body' && <path d="M32 72 L88 72 L100 130 L20 130 Z" fill={AIX.red} stroke="#b4232a" strokeWidth="2" strokeLinejoin="round" />}
      {/* wheels (rocket wheels get a flame) */}
      {o.wheels === 'p-rocket-wheels' && <g fill={AIX.sun}><path d="M30 132 l-8 12 l12 -4z" /><path d="M90 132 l8 12 l-12 -4z" /></g>}
      {[40, 80].map(cx => (
        <g key={cx}><circle cx={cx} cy="132" r="12" fill={o.wheels === 'p-rocket-wheels' ? AIX.red : '#3b4654'} /><circle cx={cx} cy="132" r="4.5" fill="#cbd5e1" /></g>
      ))}
      <rect x="19" y="80" width="11" height="30" rx="5.5" fill={body} stroke="rgba(20,32,43,.35)" strokeWidth="2" />
      <rect x="90" y="80" width="11" height="30" rx="5.5" fill={body} stroke="rgba(20,32,43,.35)" strokeWidth="2" />
      <rect x="30" y="72" width="60" height="50" rx="15" fill={body} stroke="rgba(20,32,43,.35)" strokeWidth="2" />
      <rect x="42" y="86" width="36" height="22" rx="8" fill="#fff" opacity=".38" />
      <circle cx="60" cy="97" r="4.5" fill={AIX.sun} />
      {o.body === 'p-shield-body' && <g><path d="M48 80 h24 v17 q0 12 -12 17 q-12 -5 -12 -17z" fill="#cbd5e1" stroke="#64748b" strokeWidth="2.2" strokeLinejoin="round" /><polygon points="60 87 62.4 92.4 68 93 63.8 96.8 65 102.4 60 99.6 55 102.4 56.2 96.8 52 93 57.6 92.4" fill={AIX.sun} /></g>}
      {/* head */}
      <rect x="26" y="20" width="68" height="52" rx="19" fill={body} stroke="rgba(20,32,43,.35)" strokeWidth="2" />
      <rect x="33" y="29" width="54" height="36" rx="13" fill="#fff" opacity=".93" />
      {eye(47)}{eye(73)}
      {mouth}
      {mood === 'confused' && <text x="97" y="14" fontSize="22" fontWeight="800" fill={AIX.pink} aria-hidden="true">?</text>}
      {mood === 'proud' && <polygon className="aix-a-pop" points="98 8 100 14 106 15 101.5 19 103 25 98 22 93 25 94.5 19 90 15 96 14" fill={AIX.sun} />}
      {o.face === 'p-starter-smile' && <g fill={AIX.pink} opacity=".7"><circle cx="38" cy="56" r="4.6" /><circle cx="82" cy="56" r="4.6" /></g>}
      {o.face === 'p-goggles-face' && <g fill="rgba(120,200,255,.35)" stroke={ink} strokeWidth="3"><circle cx="47" cy="46" r="11" /><circle cx="73" cy="46" r="11" /><path d="M58 46 h4" fill="none" /><path d="M26 44 h10 M84 44 h10" fill="none" /></g>}
      {o.face === 'p-pilot-face' && <rect x="31" y="36" width="58" height="19" rx="9.5" fill="rgba(60,160,255,.38)" stroke="#1d4ed8" strokeWidth="2.4" />}
      {/* hats sit on top of the head; without one Bolt wears a little antenna */}
      {!o.hat && <g><path d="M60 20 V9" stroke={ink} strokeWidth="3" strokeLinecap="round" /><circle cx="60" cy="6" r="4.5" fill={AIX.pink} /></g>}
      {o.hat === 'p-explorer-hat' && <g><path d="M38 24 Q60 -6 82 24z" fill="#d8b36e" stroke="#9a7a3c" strokeWidth="2" /><ellipse cx="60" cy="24" rx="40" ry="7" fill="#c19a5b" stroke="#9a7a3c" strokeWidth="2" /><rect x="42" y="14" width="36" height="5" rx="2" fill="#7a5a2e" /></g>}
      {o.hat === 'p-propeller-hat' && <g><path d="M40 24 Q60 4 80 24z" fill={AIX.pink} stroke="#c2487a" strokeWidth="2" /><rect x="58" y="6" width="4" height="12" fill={ink} /><g className="aix-a-spin"><ellipse cx="60" cy="5" rx="19" ry="3" fill={AIX.sun} stroke="#d99a0b" strokeWidth="1.5" /></g></g>}
      {o.hat === 'p-antenna-hat' && <g><path d="M60 21 C48 10 72 6 60 -6" stroke={ink} strokeWidth="3" fill="none" strokeLinecap="round" /><circle className="aix-a-sway" cx="60" cy="-8" r="6" fill={AIX.pink} /></g>}
      {o.hat === 'p-detective-hat' && <g><path d="M34 26 Q60 -8 86 26z" fill="#7a5c3a" stroke="#4f3a22" strokeWidth="2" /><path d="M32 26 h56 q0 8 -28 8 q-28 0 -28 -8z" fill="#5e452a" stroke="#4f3a22" strokeWidth="2" /><circle cx="60" cy="2" r="3.4" fill="#4f3a22" /></g>}
    </svg>
  );
}

/** Confetti shower. Renders nothing when the kid prefers reduced motion. Pieces are fixed (no randomness at render). */
function AixConfetti({ count = 40 }) {
  const reduced = useAixReduced();
  if (reduced) return null;
  const rand = window.AIXCore.rng(2024);
  const colors = [AIX.pink, AIX.sun, '#5bb8f0', AIX.leaf, '#a78bfa', AIX.red];
  const pieces = Array.from({ length: count }, (_, i) => ({
    left: Math.round(rand() * 100), dx: Math.round((rand() - 0.5) * 120), rot: Math.round(180 + rand() * 540),
    dur: (1.8 + rand() * 1.6).toFixed(2), delay: (rand() * 0.9).toFixed(2), color: colors[i % colors.length],
  }));
  return (
    <div aria-hidden="true" style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 5 }}>
      {pieces.map((p, i) => <span key={i} className="aix-confetti" style={{ left: p.left + '%', background: p.color, '--dx': p.dx + 'px', '--rot': p.rot + 'deg', '--dur': p.dur + 's', '--delay': p.delay + 's' }} />)}
    </div>
  );
}

function AixIcon({ name, size = 18, color }) {
  return typeof VGIcon === 'function' ? <VGIcon name={name} size={size} color={color} /> : null;
}

/** Common page frame for a game: back arrow, title, sound toggle, content. */
function AixFrame({ title, theme, onExit, muted, onToggleMute, children }) {
  return (
    <div className="aix-a-rise" style={{ maxWidth: 980, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, borderBottom: `1px solid ${AIX.line}`, paddingBottom: 12, marginBottom: 22 }}>
        <button className="aix-btn" onClick={onExit} aria-label="Back to the garden" style={{ border: `1.5px solid ${AIX.line}`, background: '#fff', borderRadius: 999, width: 44, height: 44, flexShrink: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
          <AixIcon name="arrow-left" size={19} color={AIX.ink} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={AIX_EYEBROW}>AI Explorers</div>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', color: AIX.ink }}>{title}</div>
        </div>
        {onToggleMute && <AixSoundButton muted={muted} onToggle={onToggleMute} />}
      </div>
      {children}
    </div>
  );
}

function AixSoundButton({ muted, onToggle }) {
  return (
    <button className="aix-btn" onClick={onToggle} aria-pressed={!!muted} aria-label={muted ? 'Sound is off. Turn sound on' : 'Sound is on. Turn sound off'}
      style={{ border: `1.5px solid ${AIX.line}`, background: '#fff', borderRadius: 999, padding: '8px 14px', minHeight: 44, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13.5, fontWeight: 700, color: AIX.mute }}>
      <AixIcon name={muted ? 'mute' : 'music'} size={16} color={AIX.mute} />{muted ? 'Sound off' : 'Sound on'}
    </button>
  );
}

/** Catches a crashing game so one bug never blanks the page. */
class AixBoundary extends React.Component {
  constructor(p) { super(p); this.state = { bad: false }; }
  static getDerivedStateFromError() { return { bad: true }; }
  componentDidCatch() { /* nothing to report: no network, no personal data */ }
  render() { return this.state.bad ? <AixFallback title="Oops, Bolt tripped over a wire!" onExit={this.props.onExit} /> : this.props.children; }
}

function AixFallback({ title = 'This station is still being built', onExit }) {
  return (
    <div style={{ textAlign: 'center', padding: '30px 10px' }}>
      <div style={{ display: 'inline-block' }}><AixBolt mood="dizzy" size={120} /></div>
      <h2 style={{ fontSize: 22, margin: '14px 0 6px', color: AIX.ink }}>{title}</h2>
      <p style={{ color: AIX.mute, fontSize: 15.5, margin: '0 0 18px' }}>Bolt is fixing it. Let's go back to the garden and try another station.</p>
      <button className="aix-btn" onClick={onExit} style={{ border: 'none', background: AIX.ink, color: '#fff', borderRadius: 999, padding: '12px 22px', minHeight: 44, fontSize: 15, fontWeight: 800, cursor: 'pointer' }}>Back to the garden</button>
    </div>
  );
}

// ---- the garden path: one station, with a dotted curve joining it to the next ----
function AixStation({ lesson, stars, done, theme, onOpen, index, narrow }) {
  const right = !narrow && index % 2 === 1;   // the zig-zag only makes sense when there is room; phones get one column
  const stage = done ? Math.max(1, stars) : 0;
  const ready = lesson.ready;
  return (
    <button className={ready ? 'aix-btn aix-a-rise' : 'aix-a-rise'} disabled={!ready} onClick={() => onOpen(lesson.id)}
      aria-label={ready ? `Station ${lesson.n}: ${lesson.title}. ${lesson.tagline}. ${done ? stars + ' stars' : 'Not played yet'}` : `Station ${lesson.n}: ${lesson.title}. Coming soon`}
      style={{ animationDelay: `${index * 0.05}s`, alignSelf: narrow ? 'stretch' : right ? 'flex-end' : 'flex-start', width: narrow ? '100%' : 'min(440px, 100%)', minHeight: 44, boxSizing: 'border-box', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 14,
               padding: '14px 16px', borderRadius: 22, border: `1.5px solid ${ready ? theme.primary : AIX.line}`, background: ready ? '#fff' : '#f6f8fa', cursor: ready ? 'pointer' : 'not-allowed',
               boxShadow: ready ? '0 6px 0 ' + (theme.primaryLight || '#e3f2fd') : 'none', opacity: ready ? 1 : 0.72 }}>
      <span style={{ width: 38, height: 38, borderRadius: 999, background: ready ? theme.primary : '#cfd8df', color: '#fff', fontWeight: 800, fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{lesson.n}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 17, fontWeight: 800, letterSpacing: '-0.01em', color: AIX.ink }}>{lesson.title}</span>
        <span style={{ display: 'block', fontSize: 13.5, color: AIX.mute, margin: '2px 0 5px' }}>{lesson.tagline}</span>
        {ready ? <AixStars n={done ? stars : 0} size={17} /> : <span style={{ ...AIX_EYEBROW, color: AIX.faint }}>Coming soon</span>}
      </span>
      {ready ? <AixPlant stage={stage} /> : <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true"><ellipse cx="20" cy="30" rx="12" ry="7" fill="#cfd8df" /><ellipse cx="16" cy="27" rx="5" ry="3.5" fill="#dfe6eb" /></svg>}
    </button>
  );
}

function AixConnector({ flip, theme, narrow }) {
  if (narrow) return <div style={{ height: 14 }} aria-hidden="true" />;
  // a dotted S-curve that swings from one side of the path to the other
  return (
    <svg width="100%" height="40" viewBox="0 0 400 40" preserveAspectRatio="none" aria-hidden="true" style={{ display: 'block', margin: '2px 0' }}>
      <path d={flip ? 'M330 0 C330 22 70 18 70 40' : 'M70 0 C70 22 330 18 330 40'} fill="none" stroke={theme.primary} strokeOpacity=".4" strokeWidth="3" strokeDasharray="2 9" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// ---- Bolt's wardrobe: pick owned parts by slot ----
const AIX_SLOT_NAME = { hat: 'Hats', face: 'Faces', body: 'Body', wheels: 'Wheels', color: 'Paint' };

function AixDressUp({ progress, theme, onWear, onBack, muted, onToggleMute }) {
  const C = window.AIXCore;
  return (
    <AixFrame title="Bolt's dress-up box" theme={theme} onExit={onBack} muted={muted} onToggleMute={onToggleMute}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '24px 44px', alignItems: 'flex-start' }}>
        <div style={{ flex: '0 0 auto', margin: '0 auto', padding: '20px clamp(12px, 5vw, 30px)', borderRadius: 26, background: theme.tint || '#eff6ff', border: `1px solid ${AIX.line}` }}>
          <AixBolt mood="happy" size={170} outfit={progress.outfit} />
        </div>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <p style={{ margin: '0 0 14px', color: AIX.mute, fontSize: 15.5 }}>Finish a station to find a new part. Tap a part to put it on Bolt. Tap it again to take it off.</p>
          {C.SLOTS.map(slot => (
            <div key={slot} style={{ borderTop: `1px solid ${AIX.line}`, padding: '12px 0' }}>
              <div style={{ ...AIX_EYEBROW, marginBottom: 8 }}>{AIX_SLOT_NAME[slot]}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {C.PARTS.filter(p => p.slot === slot).map(p => {
                  const owned = C.isOwned(progress, p.id), worn = progress.outfit[slot] === p.id;
                  const from = C.CATALOG.find(c => c.part === p.id);
                  return (
                    <button key={p.id} className="aix-btn" disabled={!owned} aria-pressed={worn} onClick={() => onWear(p.id)}
                      aria-label={owned ? `${p.name}${worn ? ', on Bolt' : ''}` : `Locked part. Finish ${from ? from.title : 'a station'} to find it`}
                      style={{ border: `2px solid ${worn ? theme.primary : AIX.line}`, background: worn ? (theme.tint || '#eff6ff') : '#fff', color: owned ? AIX.ink : AIX.faint, borderRadius: 14, padding: '9px 14px', minHeight: 44,
                               fontSize: 14, fontWeight: 700, cursor: owned ? 'pointer' : 'not-allowed' }}>
                      {owned ? p.name : 'Locked'}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </AixFrame>
  );
}

// ---- reward: new part, stars, confetti, then the "Go further" card ----
function AixReward({ lesson, stars, isNew, progress, theme, onAgain, onBack, muted, onToggleMute }) {
  const C = window.AIXCore;
  const part = C.partOf(lesson.part);
  const link = C.safeLink(lesson.goFurther && lesson.goFurther.url);          // null => no link is rendered at all
  const [okLink, setOkLink] = React.useState(false);                           // a grown-up confirmed the outside link
  const msg = stars >= 3 ? 'Amazing! Bolt is so proud!' : stars === 2 ? 'Great job! Bolt learned a lot!' : 'You did it! Bolt is happy!';
  return (
    <AixFrame title={lesson.title} theme={theme} onExit={onBack} muted={muted} onToggleMute={onToggleMute}>
      <div style={{ position: 'relative', textAlign: 'center', padding: '10px 0 8px' }}>
        <AixConfetti />
        <div style={{ display: 'inline-block', position: 'relative', zIndex: 1 }}><AixBolt mood="proud" size={170} outfit={progress.outfit} /></div>
        <h2 style={{ fontSize: 'clamp(26px,4vw,34px)', letterSpacing: '-0.03em', color: AIX.ink, margin: '12px 0 6px' }}>{msg}</h2>
        <div style={{ marginBottom: 10 }}><AixStars n={stars} size={34} pop /></div>
        {part && <p style={{ fontSize: 17, color: AIX.ink, margin: '0 0 6px', fontWeight: 700 }}>{isNew ? <>New part: <span style={{ color: theme.primary }}>{part.name}</span>! Bolt is wearing it.</> : <>You already have the {part.name}.</>}</p>}
        <p style={{ color: AIX.mute, fontSize: 15.5, margin: '0 auto 20px', maxWidth: 460 }}>{lesson.concept}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center', marginBottom: 26 }}>
          <button className="aix-btn" onClick={onAgain} style={{ border: 'none', background: theme.primary, color: '#fff', borderRadius: 999, padding: '12px 24px', minHeight: 44, fontSize: 15.5, fontWeight: 800, cursor: 'pointer' }}>Play again</button>
          <button className="aix-btn" onClick={onBack} style={{ border: `1.5px solid ${AIX.line}`, background: '#fff', color: AIX.ink, borderRadius: 999, padding: '12px 24px', minHeight: 44, fontSize: 15.5, fontWeight: 800, cursor: 'pointer' }}>Back to the garden</button>
        </div>
        {link && (
          <div style={{ textAlign: 'left', maxWidth: 480, margin: '0 auto', border: `1.5px dashed ${AIX.line}`, borderRadius: 18, padding: '14px 18px', background: AIX.paper }}>
            <div style={AIX_EYEBROW}>Go further</div>
            <div style={{ fontSize: 15.5, color: AIX.ink, margin: '4px 0 6px', fontWeight: 700 }}>Want more? Try "{lesson.goFurther.label}" on Code.org.</div>
            {/* Real gate: the outside link is only rendered after a grown-up confirms (a click, not a promise). */}
            {!okLink ? (
              <>
                <div style={{ fontSize: 13.5, color: AIX.warm, fontWeight: 700, marginBottom: 8 }}>This opens a different website, so a grown-up needs to say OK first.</div>
                <button className="aix-btn" onClick={() => setOkLink(true)} style={{ border: `1.5px solid ${AIX.line}`, background: '#fff', color: AIX.ink, borderRadius: 999, padding: '10px 18px', minHeight: 44, fontSize: 14.5, fontWeight: 800, cursor: 'pointer' }}>A grown-up says OK</button>
              </>
            ) : (
              <a href={link} target="_blank" rel="noopener noreferrer" style={{ color: theme.primaryDark || theme.primary, fontWeight: 800, fontSize: 15 }}>Open {lesson.goFurther.label} (new tab)</a>
            )}
          </div>
        )}
      </div>
    </AixFrame>
  );
}

// ---- the two big studio cards (real-AI tools) shown above the stations ----
function AixStudioGlyph({ id, color }) {
  // drawn glyphs, no emoji: a book + spark for Study Buddy, a gamepad + pixel for Game Studio
  return id === 'study' ? (
    <svg width="52" height="52" viewBox="0 0 52 52" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M8 14 q9 -4 18 2 q9 -6 18 -2 v26 q-9 -4 -18 2 q-9 -6 -18 -2z" fill="#fff" stroke={color} strokeWidth="3" strokeLinejoin="round" />
      <path d="M26 16 v26" stroke={color} strokeWidth="3" />
      <circle cx="40" cy="9" r="4.5" fill={AIX.sun} /><path d="M40 1.5 v3 M40 13.5 v3 M32.5 9 h3 M44.5 9 h3" stroke={AIX.sun} strokeWidth="2" strokeLinecap="round" />
    </svg>
  ) : (
    <svg width="52" height="52" viewBox="0 0 52 52" aria-hidden="true" style={{ flexShrink: 0 }}>
      <rect x="5" y="14" width="42" height="26" rx="13" fill="#fff" stroke={color} strokeWidth="3" />
      <path d="M16 22 v10 M11 27 h10" stroke={color} strokeWidth="3.4" strokeLinecap="round" />
      <circle cx="35" cy="24" r="3" fill={AIX.pink} /><circle cx="40" cy="30" r="3" fill={AIX.sun} />
    </svg>
  );
}

function AixStudioCard({ studio, theme, done, onOpen }) {
  return (
    <button className="aix-btn aix-a-rise" onClick={() => onOpen(studio.id)} aria-label={`${studio.title}. ${studio.tagline}.${done ? ' You earned its badge.' : ''}`}
      style={{ boxSizing: 'border-box', width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 14, padding: '18px 18px', minHeight: 96, borderRadius: 24,
               border: `2px solid ${theme.primary}`, background: theme.tint || '#fff', cursor: 'pointer', boxShadow: '0 6px 0 ' + (theme.primaryLight || '#e3f2fd') }}>
      <AixStudioGlyph id={studio.id} color={theme.primary} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 20, fontWeight: 800, letterSpacing: '-0.02em', color: AIX.ink }}>{studio.title}</span>
        <span style={{ display: 'block', fontSize: 14.5, color: AIX.mute, marginTop: 3, lineHeight: 1.4 }}>{studio.tagline}</span>
        {done && <span style={{ display: 'inline-block', marginTop: 6, ...AIX_EYEBROW, color: AIX.leaf }}>Badge found</span>}
      </span>
    </button>
  );
}

// ---- grown-up gate: shown once before either AI studio, because what a child types is sent to an AI service ----
const AIX_CONSENT_KEY = 'sg-aix-grownup-v1';
function AixGrownUpGate({ theme, onOk, onBack }) {
  const [checked, setChecked] = React.useState(false);
  return (
    <AixFrame title="Before you start" theme={theme} onExit={onBack}>
      <div style={{ maxWidth: 560, margin: '0 auto', border: `1.5px solid ${AIX.line}`, borderRadius: 22, padding: '20px 22px', background: AIX.paper }}>
        <h2 style={{ margin: '0 0 8px', fontSize: 22, color: AIX.ink, letterSpacing: '-0.02em' }}>Grown-ups: how this works</h2>
        <p style={{ margin: '0 0 10px', fontSize: 15.5, lineHeight: 1.55, color: AIX.ink }}>Study Buddy and Game Studio send what your child types, and pictures they choose, to an AI service to get answers. We do not ask for names. Messages are not saved on our server. If a message is blocked for safety, we keep only a note of the kind of problem, not the words.</p>
        <p style={{ margin: '0 0 14px', fontSize: 15.5, lineHeight: 1.55, color: AIX.mute }}>The AI can make mistakes. The other games in the garden work on this device and send nothing.</p>
        <label style={{ display: 'flex', gap: 10, alignItems: 'center', minHeight: 44, fontSize: 15.5, fontWeight: 700, color: AIX.ink, cursor: 'pointer' }}>
          <input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} style={{ width: 24, height: 24, accentColor: theme.primary }} />
          A grown-up has read this and says OK.
        </label>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
          <button className="aix-btn" disabled={!checked} onClick={onOk} style={{ border: 'none', background: checked ? theme.primary : '#cbd5e1', color: '#fff', borderRadius: 999, padding: '12px 24px', minHeight: 44, fontSize: 15.5, fontWeight: 800, cursor: checked ? 'pointer' : 'default' }}>Start</button>
          <button className="aix-btn" onClick={onBack} style={{ border: `1.5px solid ${AIX.line}`, background: '#fff', color: AIX.ink, borderRadius: 999, padding: '12px 24px', minHeight: 44, fontSize: 15.5, fontWeight: 800, cursor: 'pointer' }}>Not now</button>
        </div>
      </div>
    </AixFrame>
  );
}

/**
 * The AI Explorers tab. Views: map (home) -> play -> reward, plus the dress-up box.
 * @param {{theme:Object, menuVisible:boolean}} props
 */
function AIExplorersPane({ theme, menuVisible }) {
  const C = window.AIXCore;
  const [progress, setProgress] = React.useState(() => { try { return C.loadProgress(window.localStorage); } catch (e) { return C.emptyProgress(); } });
  const [view, setView] = React.useState({ name: 'map' });          // map | dress | play {id, seed} | reward {id, stars, isNew} | studio {id}
  const finished = React.useRef(false);                              // a game may call onDone only once per play
  const narrow = useAixNarrow();
  const [notice, setNotice] = React.useState('');                    // "new part found" message shown inside a studio
  const [consent, setConsent] = React.useState(() => { try { return window.localStorage.getItem(AIX_CONSENT_KEY) === '1'; } catch (e) { return false; } });
  const giveConsent = () => { setConsent(true); try { window.localStorage.setItem(AIX_CONSENT_KEY, '1'); } catch (e) { /* storage blocked: asked again next visit */ } };
  const progressRef = React.useRef(progress);                        // lets two quick callbacks (award + explore) build on each other
  progressRef.current = progress;

  React.useEffect(() => { window.aixSfx.setMuted(progress.muted); }, [progress.muted]);
  React.useEffect(() => { try { C.saveProgress(window.localStorage, progress); } catch (e) {} }, [progress]);

  const toggleMute = () => setProgress(p => ({ ...p, muted: !p.muted }));
  const toMap = () => { setNotice(''); setView({ name: 'map' }); };
  const start = (id) => { finished.current = false; setView({ name: 'play', id, seed: Math.floor(Math.random() * 2147483647) }); window.aixSfx('pop'); };
  const wear = (partId) => { setProgress(p => C.wear(p, partId)); window.aixSfx('pop'); };

  /** Apply a pure AIXCore change; dress Bolt in any part it newly unlocked and tell the kid. */
  const commit = (change) => {
    const prev = progressRef.current;
    let next = change(prev);
    const fresh = next.parts.filter(id => prev.parts.indexOf(id) === -1);
    fresh.forEach(id => { const part = C.partOf(id); if (part && next.outfit[part.slot] !== id) next = C.wear(next, id); });
    progressRef.current = next;
    setProgress(next);
    if (fresh.length) { const part = C.partOf(fresh[0]); setNotice(part ? `New part: ${part.name}! Bolt is wearing it.` : ''); window.aixSfx('win'); }
  };
  const openStudio = (id) => { setNotice(''); setView({ name: 'studio', id }); window.aixSfx('pop'); };
  // Studio callbacks: ignore anything that is not a known studio id / explore key (the C.* functions validate again).
  const onStudioAward = (studioId) => { if (C.studioOf(studioId)) commit(p => C.award(p, studioId, 0)); };
  const onStudioExplore = (key, value) => commit(p => C.explore(p, key, value));

  const onDone = (id, stars) => {
    if (finished.current) return;
    finished.current = true;
    const lesson = C.lessonOf(id);
    if (!lesson) return;
    const isNew = progress.parts.indexOf(lesson.part) === -1;
    setProgress(p => {
      let next = C.award(p, id, stars);
      if (isNew && next.outfit[C.partOf(lesson.part).slot] !== lesson.part) next = C.wear(next, lesson.part);   // dress Bolt in the new part right away
      return next;
    });
    setView({ name: 'reward', id, isNew, stars: Math.max(0, Math.min(3, Math.floor(Number(stars) || 0))) });
    window.aixSfx('win');
  };

  // phones get tighter gutters plus safe-area insets (notch / home bar)
  const side = narrow ? 14 : menuVisible ? 28 : 40;
  const pad = `${narrow ? (menuVisible ? 56 : 20) : menuVisible ? 60 : 34}px max(${side}px, env(safe-area-inset-right)) calc(56px + env(safe-area-inset-bottom)) max(${side}px, env(safe-area-inset-left))`;
  let body;
  if (view.name === 'dress') {
    body = <AixDressUp progress={progress} theme={theme} onWear={wear} onBack={toMap} muted={progress.muted} onToggleMute={toggleMute} />;
  } else if (view.name === 'play') {
    const lesson = C.lessonOf(view.id);
    const Game = window.AIX_GAMES && window.AIX_GAMES[view.id];
    body = (
      <AixFrame title={lesson ? lesson.title : 'Station'} theme={theme} onExit={toMap} muted={progress.muted} onToggleMute={toggleMute}>
        {typeof Game === 'function'
          ? <AixBoundary onExit={toMap}><Game key={view.seed} seed={view.seed} theme={theme} onExit={toMap} onDone={(s) => onDone(view.id, s)} /></AixBoundary>
          : <AixFallback onExit={toMap} />}
      </AixFrame>
    );
  } else if (view.name === 'studio') {
    const studio = C.studioOf(view.id);
    const Studio = window.AIX_STUDIOS && window.AIX_STUDIOS[view.id];
    body = !consent ? <AixGrownUpGate theme={theme} onOk={giveConsent} onBack={toMap} /> : typeof Studio === 'function' && studio ? (
      <div style={{ maxWidth: 980, margin: '0 auto' }}>
        {notice && <div role="status" className="aix-a-pop" style={{ margin: '0 0 12px', padding: '12px 16px', borderRadius: 16, background: AIX.paper, border: `1.5px solid ${AIX.sun}`, fontWeight: 800, color: AIX.ink }}>{notice}</div>}
        <AixBoundary onExit={toMap}><Studio theme={theme} onExit={toMap} onAward={onStudioAward} onExplore={onStudioExplore} /></AixBoundary>
      </div>
    ) : (
      <AixFrame title={studio ? studio.title : 'Studio'} theme={theme} onExit={toMap} muted={progress.muted} onToggleMute={toggleMute}><AixFallback onExit={toMap} /></AixFrame>
    );
  } else if (view.name === 'reward') {
    const lesson = C.lessonOf(view.id);
    body = <AixReward lesson={lesson} stars={view.stars} isNew={view.isNew} progress={progress} theme={theme} onBack={toMap} onAgain={() => start(view.id)} muted={progress.muted} onToggleMute={toggleMute} />;
  } else {
    const readyCount = C.CATALOG.filter(c => c.ready).length;
    const doneCount = C.CATALOG.filter(c => c.ready && progress.done[c.id]).length;
    body = (
      <div style={{ maxWidth: 980, margin: '0 auto' }}>
        <div style={AIX_EYEBROW}>AI Explorers</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '18px 36px', alignItems: 'center', margin: '8px 0 26px' }}>
          <div style={{ flex: '1 1 380px', minWidth: 0 }}>
            <h1 style={{ fontSize: 'clamp(28px, 4vw, 40px)', lineHeight: 1.08, fontWeight: 800, letterSpacing: '-0.03em', color: AIX.ink, margin: '0 0 10px', maxWidth: 560 }}>
              Teach Bolt how AI <span style={{ color: theme.primary }}>really thinks</span>.
            </h1>
            <p style={{ margin: '0 0 16px', color: AIX.mute, fontSize: 16.5, lineHeight: 1.55, maxWidth: 540 }}>
              Walk the garden path. Every station is a little game that shows how AI learns, makes mistakes and can be used safely. Finish one to grow a plant and find a new part for Bolt.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
              <button className="aix-btn" onClick={() => setView({ name: 'dress' })} style={{ border: 'none', background: theme.primary, color: '#fff', borderRadius: 999, padding: '10px 20px', minHeight: 44, fontSize: 14.5, fontWeight: 800, cursor: 'pointer' }}>Dress up Bolt</button>
              <AixSoundButton muted={progress.muted} onToggle={toggleMute} />
              <span style={{ fontSize: 13.5, fontWeight: 700, color: AIX.faint }}>{doneCount} of {readyCount} open stations done</span>
            </div>
          </div>
          <div style={{ flex: '0 0 auto', margin: '0 auto', textAlign: 'center' }}>
            <div style={{ display: 'inline-block', background: '#fff', border: `1.5px solid ${AIX.line}`, borderRadius: 16, padding: '7px 14px', fontSize: 14, fontWeight: 700, color: AIX.ink, marginBottom: 8 }}>Hi! I'm Bolt. Pick a station!</div>
            <div style={{ display: 'flex', justifyContent: 'center' }}><AixBolt mood="happy" size={130} outfit={progress.outfit} /></div>
          </div>
        </div>
        <div style={{ ...AIX_EYEBROW, margin: '0 0 10px' }}>Make and wonder with a real AI</div>
        <div className="aix-studios" style={{ marginBottom: 30 }}>
          {C.STUDIOS.map(st => <AixStudioCard key={st.id} studio={st} theme={theme} done={!!progress.done[st.id]} onOpen={openStudio} />)}
        </div>
        <div style={{ ...AIX_EYEBROW, margin: '0 0 6px' }}>The garden path</div>
        <nav aria-label="Garden path of stations" style={{ display: 'flex', flexDirection: 'column', padding: '4px 0 10px' }}>
          {C.CATALOG.map((lesson, i) => (
            <React.Fragment key={lesson.id}>
              <AixStation lesson={lesson} index={i} theme={theme} done={!!progress.done[lesson.id]} stars={progress.stars[lesson.id] || 0} onOpen={start} narrow={narrow} />
              {i < C.CATALOG.length - 1 && <AixConnector flip={i % 2 === 1} theme={theme} narrow={narrow} />}
            </React.Fragment>
          ))}
        </nav>
      </div>
    );
  }
  return <div style={{ height: '100%', overflowY: 'auto', padding: pad, boxSizing: 'border-box' }}>{body}</div>;
}

Object.assign(window, { AIExplorersPane, AixBolt, AixConfetti, AixFrame, AixStars, AixStar, AixPlant, AixFallback });
