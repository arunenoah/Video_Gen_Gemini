/* ============================================================
   SparkGarden — Study Buddy ("Sunny"): a curious friend for homework doubts and wonder questions.
   The kid is the author; Sunny asks back, hints, and is honest about not being sure.
   Rules: every chat string is rendered as a React text node (white-space: pre-wrap), never as markup.
   The conversation lives in memory only; the only storage is the Wonder Journal (validated by AIXStudyLogic).
   The only network call is vgPost('/api/study'). Kid text is never logged.
   ============================================================ */

const SB = { ink: '#14202b', mute: '#5b6b79', faint: '#94a3b0', line: '#e4e8ec', sun: '#f5b82e', leaf: '#2f9e5b', warm: '#b45309', paper: '#fffef9', red: '#e5484d' };
const SB_GRADES = [{ id: 'g1-3', label: 'Grades 1-3' }, { id: 'g4-6', label: 'Grades 4-6' }, { id: 'g7-9', label: 'Grades 7-9' }];
const SB_STARTERS = {
  homework: ["I'm stuck on a fractions question", 'I want to write a story. Help me find ideas!', 'I do not get how plants make food'],
  wonder: ['Why do cats purr?', 'What if the moon disappeared?', 'How do birds know where to fly?'],
};
const SB_FEEL = {
  yes: { label: 'Yes!', say: 'Hooray! Want to try the next one all by yourself?' },
  maybe: { label: 'Kind of', say: 'Thanks for telling me. Let us make it smaller together.' },
  no: { label: 'Not yet', say: 'That is okay, tricky things take time. Let us take a smaller step.' },
};

/** Sunny's face: a round sun with rays. Pure drawn SVG, no emoji. */
function SunnyFace({ size = 40 }) {
  const rays = [0, 45, 90, 135, 180, 225, 270, 315];
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" style={{ flexShrink: 0 }}>
      {rays.map(a => <line key={a} x1="20" y1="3" x2="20" y2="8" stroke={SB.sun} strokeWidth="3" strokeLinecap="round" transform={`rotate(${a} 20 20)`} />)}
      <circle cx="20" cy="20" r="11" fill={SB.sun} stroke="#d99a0b" strokeWidth="1.5" />
      <circle cx="16.5" cy="18" r="1.5" fill={SB.ink} /><circle cx="23.5" cy="18" r="1.5" fill={SB.ink} />
      <path d="M15.5 22.5 q4.5 4.5 9 0" fill="none" stroke={SB.ink} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** Understanding glyphs for "Did that make sense?": a smile, a so-so face, and a puzzled face. */
function FeelGlyph({ kind, color, size = 26 }) {
  const mouth = kind === 'yes' ? 'M9 16 q5 5 10 0' : kind === 'maybe' ? 'M9.5 17.5 h9' : 'M9 19 q5 -5 10 0';
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
      <circle cx="14" cy="14" r="11.5" fill="none" stroke={color} strokeWidth="2" />
      <circle cx="10.5" cy="11.5" r="1.4" fill={color} /><circle cx="17.5" cy="11.5" r="1.4" fill={color} />
      {kind === 'maybe' && <path d="M8 7.8 l5 -1.4" stroke={color} strokeWidth="1.6" strokeLinecap="round" />}
      <path d={mouth} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Read-aloud for key prompts. Uses the device's own speech voice (nothing leaves the device); hidden when unsupported. */
function SbSpeak({ text, theme }) {
  const ok = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';
  if (!ok) return null;
  const say = () => { try { window.speechSynthesis.cancel(); window.speechSynthesis.speak(new window.SpeechSynthesisUtterance(text)); } catch (e) { /* speech is optional */ } };
  return <button className="aix-btn" onClick={say} aria-label="Read this out loud" style={{ ...sbChip(theme), marginTop: 6 }}>Read it to me</button>;
}

function SbIcon({ name, size = 18, color = SB.ink }) {
  const common = { fill: 'none', stroke: color, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {name === 'camera' && <g {...common}><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></g>}
      {name === 'send' && <g {...common}><path d="M12 19V5" /><path d="M6 11l6-6 6 6" /></g>}
      {name === 'book' && <g {...common}><path d="M4 5h6a2 2 0 0 1 2 2v12a2 2 0 0 0-2-2H4z" /><path d="M20 5h-6a2 2 0 0 0-2 2v12a2 2 0 0 1 2-2h6z" /></g>}
      {name === 'close' && <g {...common}><path d="M6 6l12 12M18 6L6 18" /></g>}
      {name === 'spark' && <g {...common}><path d="M12 3l2.2 6.3L21 12l-6.8 2.7L12 21l-2.2-6.3L3 12l6.8-2.7z" /></g>}
    </svg>
  );
}

const sbPill = (on, theme) => ({
  border: `1.5px solid ${on ? theme.primary : SB.line}`, background: on ? theme.primary : '#fff', color: on ? '#fff' : SB.ink,
  borderRadius: 999, padding: '8px 16px', minHeight: 44, fontSize: 14.5, fontWeight: 800, cursor: 'pointer',
});
const sbChip = (theme, strong) => ({
  border: `1.5px solid ${strong ? theme.primary : SB.line}`, background: strong ? (theme.tint || '#fff') : '#fff', color: SB.ink,
  borderRadius: 999, padding: '8px 14px', minHeight: 44, fontSize: 14, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7,
});

/** One chat bubble. Text only, newlines kept, long words wrapped. */
function SbBubble({ m, theme }) {
  const kid = m.role === 'user';
  return (
    <div style={{ display: 'flex', gap: 10, justifyContent: kid ? 'flex-end' : 'flex-start', alignItems: 'flex-start', margin: '12px 0' }} className="aix-a-rise">
      {!kid && <SunnyFace size={36} />}
      <div style={{ maxWidth: 'min(86%, 560px)', padding: '12px 15px', borderRadius: kid ? '20px 20px 6px 20px' : '20px 20px 20px 6px',
                    background: kid ? theme.primary : SB.paper, color: kid ? '#fff' : SB.ink, border: kid ? 'none' : `1.5px solid ${SB.line}`,
                    fontSize: 16, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {m.thumb && <img src={m.thumb} alt="The picture you showed Sunny" style={{ display: 'block', maxWidth: 160, maxHeight: 160, borderRadius: 12, marginBottom: 8 }} />}
        {m.content}
      </div>
    </div>
  );
}

/** Three bouncing dots while Sunny thinks. */
function SbThinking() {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '12px 0' }} role="status" aria-label="Sunny is thinking">
      <SunnyFace size={36} />
      <div style={{ display: 'flex', gap: 6, padding: '14px 16px', borderRadius: 20, background: SB.paper, border: `1.5px solid ${SB.line}` }}>
        {[0, 1, 2].map(i => <span key={i} className="aix-a-bounce" style={{ width: 9, height: 9, borderRadius: 999, background: SB.sun, display: 'block', animationDelay: `${i * 0.15}s` }} />)}
      </div>
    </div>
  );
}

/**
 * One conversation (homework or wonder). Kept mounted while the other tab is open so nothing is lost.
 * @param {{mode:'homework'|'wonder', grade:string, theme:Object, hidden:boolean, onCheck:Function, onWonder:Function, journal:Array, onSave:Function}} props
 */
function SbChat({ mode, grade, theme, hidden, onCheck, onWonder, journal, onSave }) {
  const L = window.AIXStudyLogic;
  const [msgs, setMsgs] = React.useState([]);
  const [st, setSt] = React.useState(L.newLadder);
  const [text, setText] = React.useState('');
  const [pic, setPic] = React.useState(null);              // {thumb, mime, base64}
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [feel, setFeel] = React.useState(null);
  const [teach, setTeach] = React.useState(null);          // null = closed, string = open with draft
  const [suggest, setSuggest] = React.useState(null);
  const [saved, setSaved] = React.useState(false);
  const [canRetry, setCanRetry] = React.useState(true);    // false for rate limits and other errors where resending cannot help
  const [blocked, setBlocked] = React.useState(null);      // {kind:'care'|'blocked', text}: a calm card, never a retry
  const [cooling, setCooling] = React.useState(false);     // brief pause on the send box after a care message
  const [checking, setChecking] = React.useState(false);   // the latest reply answers 'Check it': ask how the check went
  const [verdict, setVerdict] = React.useState(null);      // 'right' | 'slip' | 'unsure' after the child checked
  const [deeperCount, setDeeperCount] = React.useState(0);
  const [askPhoto, setAskPhoto] = React.useState(false);   // one-time "only homework pictures" note
  const lastBody = React.useRef(null);                     // for "Try again"
  const lastQ = React.useRef('');                          // the kid's own latest typed question (journal title)
  const bottom = React.useRef(null);
  const fileRef = React.useRef(null);
  const wonder = mode === 'wonder';

  React.useEffect(() => { if (!hidden && bottom.current && bottom.current.scrollIntoView) { try { bottom.current.scrollIntoView({ block: 'end' }); } catch (e) {} } }, [msgs.length, busy, error, hidden]);

  const lastReply = [...msgs].reverse().find(m => m.role === 'assistant');
  const showTools = !busy && !error && msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant' && !msgs[msgs.length - 1].filtered;
  const conf = showTools ? L.confidence(lastReply.content) : null;
  const answerOpen = L.canShowAnswer(st, text);

  /** Call Sunny with a prepared body; on success append the reply and advance the ladder. */
  async function call(body, stAfterSend, countWonder, sentMsg) {
    setBusy(true); setError(''); setCanRetry(true); setBlocked(null); setFeel(null); setSuggest(null); setSaved(false); setVerdict(null);
    lastBody.current = { body, stAfterSend, countWonder, sentMsg };
    try {
      const { ok, status, data } = await vgPost('/api/study', body);
      if (!ok) {
        const info = L.errorInfo(status, data);
        if (info.kind === 'error') { setError(info.text); setCanRetry(info.retry); return; }
        // A blocked message is taken back out of the chat. If it stayed, every later turn (and Try again) would
        // resend it and add another safety strike.
        lastBody.current = null;
        setMsgs(ms => ms.filter(m => m !== sentMsg));
        setBlocked({ kind: info.kind, text: info.text });
        if (info.kind === 'care') { setCooling(true); setTimeout(() => setCooling(false), 8000); }
        return;
      }
      const reply = data && typeof data.reply === 'string' ? data.reply.trim() : '';
      if (!reply) { setError(L.friendlyError(502, null)); return; }
      setMsgs(ms => [...ms, { role: 'assistant', content: reply, filtered: !!data.filtered }]);
      setSt(L.afterReply(stAfterSend));
      setChecking(body.intent === 'check');
      if (body.intent === 'deeper') setDeeperCount(n => n + 1);
      if (countWonder && !data.filtered) onWonder();
      if (window.aixSfx) window.aixSfx('pop');
    } catch (e) { setError(L.friendlyError(0, null)); }
    finally { setBusy(false); }
  }

  /**
   * One kid action: 'send' | 'hint' | 'step' | 'answer' | 'check' | 'teachback' | 'deeper'.
   * Builds the user turn, the validated request and the next ladder state.
   */
  function act(action, teachText) {
    if (busy) return;
    const draft = text.trim();
    const withPic = action === 'send' || action === 'hint' || action === 'step' || action === 'answer';
    let content = action === 'teachback' ? (teachText || '').trim() : action === 'send' ? draft : (action === 'check' || action === 'deeper') ? L.CANNED[action] : (draft || L.CANNED[action]);
    if (!content && pic && withPic) content = 'Can you help me with this picture?';
    if (!content) return;
    if (action === 'answer' && !answerOpen) return;
    const ladder = wonder ? 1 : L.ladderFor(st, action);
    const typed = action === 'send' || action === 'teachback' || (withPic && !!draft);
    const msg = { role: 'user', content: content.slice(0, L.MAX_CONTENT), thumb: withPic && pic ? pic.thumb : null };
    const history = [...msgs.filter(m => !m.filtered), msg].map(({ role, content }) => ({ role, content }));
    const req = L.buildRequest({ mode, grade, ladder, intent: L.routeIntent(mode, action), messages: history,
                                 image: withPic && pic ? { mime: pic.mime, base64: pic.base64 } : null });
    if (!req.ok) { setNotice(req.error); return; }
    setNotice('');
    setMsgs(ms => [...ms, msg]);
    if (typed && action !== 'teachback') lastQ.current = content.slice(0, 80);
    if (withPic) { setPic(null); }
    if (action === 'send' || withPic) setText('');
    if (action === 'teachback') setTeach(null);
    const next = L.afterSend(st, { action, text: content, ladder, typed });
    call(req.body, next, wonder && action === 'send', msg);
  }

  function retry() { const l = lastBody.current; if (l && !busy) call(l.body, l.stAfterSend, l.countWonder, l.sentMsg); }

  /** Start over: clears the chat, the ladder and every card. */
  function newChat() {
    setMsgs([]); setSt(L.newLadder()); setText(''); setPic(null); setError(''); setBlocked(null); setFeel(null); setTeach(null);
    setSuggest(null); setSaved(false); setChecking(false); setVerdict(null); setDeeperCount(0); setNotice('');
    lastBody.current = null; lastQ.current = '';
  }

  function cameraClick() {
    let seen = false;
    try { seen = window.localStorage.getItem('sg-aix-photo-ok') === '1'; } catch (e) { /* ask each time */ }
    if (seen) { if (fileRef.current) fileRef.current.click(); } else setAskPhoto(true);
  }
  function photoOk() {
    try { window.localStorage.setItem('sg-aix-photo-ok', '1'); } catch (e) { /* storage blocked */ }
    setAskPhoto(false);
    if (fileRef.current) fileRef.current.click();
  }

  /** The child says how their own check went. This (not pressing Check it) earns the study badge. */
  function giveVerdict(v) { setVerdict(v); setChecking(false); onCheck(); }

  async function attach(file) {
    if (!file) return;
    try {
      if (typeof vgPreparePicture !== 'function') throw new Error('Pictures are not ready yet.');
      const dataUrl = await vgPreparePicture(file);                    // same PNG/JPEG/WebP < 2 MB check as the chat
      const thumb = typeof vgThumb === 'function' ? await vgThumb(dataUrl) : null;
      setPic({ thumb, mime: 'image/jpeg', base64: dataUrl.split(',')[1] });
      setNotice('');
    } catch (e) { setNotice(e && e.message ? e.message : 'I could not read that picture.'); }
  }

  function choose(f) { setFeel(f); setSt(s => L.applyFeedback(s, f)); setSuggest(L.suggestion(st, f)); }

  function save() {
    const q = lastQ.current || 'My wonder';
    if (fact && onSave(q, fact)) setSaved(true);
  }

  const canSend = !busy && !cooling && (text.trim() || pic);
  const fact = wonder && lastReply ? L.pickFact(lastReply.content) : '';
  const starters = SB_STARTERS[mode];
  const answerLocked = !answerOpen;
  const ladderBtn = (action, label, disabled) => (
    <button className="aix-btn" disabled={busy || disabled} onClick={() => act(action)} aria-disabled={busy || disabled}
      style={{ ...sbChip(theme, suggest === action), opacity: busy || disabled ? 0.5 : 1, cursor: busy || disabled ? 'default' : 'pointer' }}>{label}</button>
  );

  return (
    <div style={{ display: hidden ? 'none' : 'block' }}>
      {msgs.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
          <button className="aix-btn" onClick={newChat} style={sbChip(theme)}>New chat</button>
        </div>
      )}
      {msgs.length === 0 && (
        <div style={{ textAlign: 'center', padding: '10px 6px 6px' }}>
          {window.AixBolt ? <div style={{ display: 'inline-block' }}><window.AixBolt mood="happy" size={96} /></div> : null}
          <h2 style={{ fontSize: 21, margin: '8px 0 6px', color: SB.ink, letterSpacing: '-0.02em' }}>
            {wonder ? 'What are you wondering about today?' : 'What is puzzling you?'}
          </h2>
          <p style={{ color: SB.mute, fontSize: 15.5, lineHeight: 1.5, margin: '0 auto 14px', maxWidth: 460 }}>
            {wonder ? 'Any weird, wild question is welcome. Sunny is a computer program that loves wonder questions!'
                    : 'Tell me what you are stuck on and what you have tried. We will figure it out together, and you stay the boss.'}
          </p>
          <SbSpeak theme={theme} text={wonder ? 'What are you wondering about today? Any weird, wild question is welcome.' : 'What is puzzling you? Tell me what you are stuck on and what you have tried.'} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 8 }}>
            {starters.map(s => <button key={s} className="aix-btn" onClick={() => setText(s)} style={sbChip(theme)}>{s}</button>)}
          </div>
        </div>
      )}

      <div aria-live="polite">
        {msgs.map((m, i) => <SbBubble key={i} m={m} theme={theme} />)}
        {busy && <SbThinking />}
      </div>

      {error && (
        <div role="alert" style={{ margin: '10px 0', padding: '12px 14px', borderRadius: 16, background: '#fff7ed', border: `1.5px solid ${SB.sun}`, color: SB.ink, fontSize: 15, lineHeight: 1.45 }}>
          {error}
          {canRetry && lastBody.current && <div style={{ marginTop: 8 }}><button className="aix-btn" onClick={retry} disabled={busy} style={sbChip(theme, true)}>Try again</button></div>}
        </div>
      )}

      {blocked && (
        <div role="alert" style={{ margin: '10px 0', padding: '14px 16px', borderRadius: 16, background: SB.paper, border: `1.5px solid ${SB.line}`, color: SB.ink, fontSize: 15.5, lineHeight: 1.5 }}>
          {blocked.text}
          {blocked.kind !== 'care' && <div style={{ marginTop: 8 }}><button className="aix-btn" onClick={() => setBlocked(null)} style={sbChip(theme, true)}>Ask something else</button></div>}
          {blocked.kind === 'care' && <div style={{ marginTop: 8, fontSize: 13.5, color: SB.mute }}>The message box rests for a moment. There is no hurry.</div>}
        </div>
      )}

      {showTools && (
        <div style={{ margin: '4px 0 6px 46px' }}>
          {conf && (
            <div style={{ fontSize: 13.5, color: conf.level === 'unsure' ? SB.warm : SB.mute, fontWeight: 700, marginBottom: 8, whiteSpace: 'pre-wrap' }}>
              {conf.level === 'unsure' ? 'Sunny is not totally sure: ' + conf.text : 'Sunny sounds sure, but Sunny can sound sure and still be wrong.'}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="aix-btn" onClick={() => act('check')} style={sbChip(theme, true)}>Check it</button>
            <button className="aix-btn" onClick={() => setTeach(t => t === null ? '' : null)} aria-expanded={teach !== null} style={sbChip(theme)}>Teach it back</button>
            {wonder && deeperCount < L.DEEPER_LIMIT && <button className="aix-btn" onClick={() => act('deeper')} style={sbChip(theme, true)}><SbIcon name="spark" size={16} color={theme.primary} />{L.deeperLabel(deeperCount)}</button>}
            {wonder && deeperCount >= L.DEEPER_LIMIT && <div role="status" style={{ ...sbChip(theme, true), cursor: 'default' }}><SbIcon name="spark" size={16} color={theme.primary} />{L.deeperLabel(deeperCount)}</div>}
            {fact && <button className="aix-btn" disabled={saved} onClick={save} style={{ ...sbChip(theme), opacity: saved ? 0.6 : 1 }}><SbIcon name="book" size={16} />{saved ? 'Saved to your journal' : 'Save to my journal'}</button>}
          </div>
          {fact && <div style={{ fontSize: 12.5, color: SB.faint, marginTop: 6 }}>Sunny can be wrong. Check it!</div>}

          {checking && (
            <div role="group" aria-label="Did you check it?" style={{ marginTop: 10, padding: 12, borderRadius: 16, border: `1.5px dashed ${theme.primary}`, background: '#fff' }}>
              <div style={{ fontSize: 14.5, fontWeight: 800, color: SB.ink, marginBottom: 8 }}>Now go and check it with a book, another way of asking, or a grown-up. Did you check it? Sunny was:</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="aix-btn" onClick={() => giveVerdict('right')} style={sbChip(theme)}>Right</button>
                <button className="aix-btn" onClick={() => giveVerdict('slip')} style={sbChip(theme)}>Slipped up</button>
                <button className="aix-btn" onClick={() => giveVerdict('unsure')} style={sbChip(theme)}>I couldn't tell</button>
              </div>
            </div>
          )}
          {verdict && (
            <div role="status" style={{ marginTop: 10, fontSize: 14.5, color: SB.ink, lineHeight: 1.45 }}>
              {verdict === 'right' ? 'Nice checking! Now you know it, not just Sunny.' : verdict === 'slip' ? 'You caught a slip! That is exactly what good checkers do. Fib Finder in the garden is great practice for spotting slips.' : 'That is okay. A book or a grown-up can help you find out.'}
            </div>
          )}

          {teach !== null && (
            <div style={{ marginTop: 10, padding: 12, borderRadius: 16, border: `1.5px dashed ${theme.primary}`, background: '#fff' }}>
              <label htmlFor="sb-teach" style={{ display: 'block', fontSize: 14.5, fontWeight: 800, color: SB.ink, marginBottom: 6 }}>Now you be the teacher! Explain it in your own words.</label>
              <textarea id="sb-teach" value={teach} rows={3} maxLength={1900} onChange={e => setTeach(e.target.value)} placeholder="It works like this..."
                style={{ width: '100%', boxSizing: 'border-box', border: `1.5px solid ${SB.line}`, borderRadius: 12, padding: 10, fontSize: 16, fontFamily: 'inherit', resize: 'vertical' }} />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="aix-btn" disabled={!teach.trim()} onClick={() => act('teachback', teach)} style={{ ...sbPill(true, theme), opacity: teach.trim() ? 1 : 0.5 }}>Send to Sunny</button>
                <button className="aix-btn" onClick={() => setTeach(null)} style={sbPill(false, theme)}>Not now</button>
              </div>
            </div>
          )}

          <div role="group" aria-label="Did that make sense?" style={{ marginTop: 12 }}>
            <div style={{ fontSize: 13.5, fontWeight: 800, color: SB.mute, marginBottom: 6 }}>Did that make sense?</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {['yes', 'maybe', 'no'].map(k => (
                <button key={k} className="aix-btn" onClick={() => choose(k)} aria-pressed={feel === k}
                  style={{ ...sbChip(theme, feel === k), gap: 8 }}><FeelGlyph kind={k} color={feel === k ? theme.primary : SB.mute} />{SB_FEEL[k].label}</button>
              ))}
            </div>
            {feel && <div role="status" style={{ fontSize: 14.5, color: SB.ink, marginTop: 8, lineHeight: 1.45 }}>{SB_FEEL[feel].say}</div>}
          </div>
        </div>
      )}
      <div ref={bottom} />

      {/* composer: sticks to the bottom so it is always in thumb reach on phones */}
      <div style={{ position: 'sticky', bottom: 0, background: '#fff', paddingTop: 8, paddingBottom: 'max(8px, env(safe-area-inset-bottom))', marginTop: 8 }}>
        {notice && <div role="status" style={{ fontSize: 14, color: SB.warm, fontWeight: 700, margin: '0 0 6px' }}>{notice}</div>}
        {!wonder && msgs.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} role="group" aria-label="How much help?">
              {ladderBtn('hint', 'Give me a hint', !st.hasReply)}
              {ladderBtn('step', 'Show me a step', !st.hasReply)}
              {ladderBtn('answer', 'Show the answer', answerLocked)}
            </div>
            {answerLocked && st.hasReply && <div style={{ fontSize: 13, color: SB.faint, marginTop: 5 }}>The answer button opens after one hint or one try.</div>}
          </div>
        )}
        {askPhoto && (
          <div role="dialog" aria-label="Before you send a picture" style={{ marginBottom: 8, padding: 12, borderRadius: 16, border: `1.5px solid ${SB.sun}`, background: SB.paper, fontSize: 15, color: SB.ink, lineHeight: 1.45 }}>
            Only send pictures of your homework. No faces, names or addresses.
            <div style={{ marginTop: 8 }}><button className="aix-btn" onClick={photoOk} style={sbChip(theme, true)}>OK</button></div>
          </div>
        )}
        <div style={{ border: `1.5px solid ${SB.line}`, borderRadius: 22, padding: 8, background: '#fff' }}>
          {pic && (
            <div style={{ position: 'relative', display: 'inline-block', margin: '2px 4px 6px' }}>
              {pic.thumb && <img src={pic.thumb} alt="Your picture, ready to send" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 12, display: 'block' }} />}
              <button className="aix-btn" onClick={() => setPic(null)} aria-label="Remove picture" style={{ position: 'absolute', top: -8, right: -8, width: 28, height: 28, minHeight: 28, borderRadius: 999, border: 'none', background: SB.ink, cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><SbIcon name="close" size={14} color="#fff" /></button>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={e => { attach(e.target.files[0]); e.target.value = ''; }} />
            <button className="aix-btn" onClick={cameraClick} aria-label="Show Sunny a picture" style={{ width: 44, height: 44, borderRadius: 999, border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><SbIcon name="camera" size={22} color={SB.mute} /></button>
            <textarea value={text} rows={1} maxLength={L.MAX_CONTENT} aria-label={wonder ? 'What are you wondering about?' : 'Tell Sunny what you are stuck on'}
              placeholder={wonder ? 'I wonder why...' : msgs.length ? 'Tell me what you tried or think...' : 'I am stuck on...'}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (canSend) act('send'); } }}
              style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', resize: 'none', fontSize: 16, lineHeight: 1.45, padding: '10px 2px', background: 'transparent', fontFamily: 'inherit', maxHeight: 160 }} />
            <button className="aix-btn" disabled={!canSend} onClick={() => act('send')} aria-label="Send to Sunny"
              style={{ width: 44, height: 44, borderRadius: 999, border: 'none', cursor: canSend ? 'pointer' : 'default', background: canSend ? theme.primary : '#e5e7eb', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><SbIcon name="send" size={20} color="#fff" /></button>
          </div>
        </div>
        <div style={{ textAlign: 'center', fontSize: 12.5, color: SB.faint, marginTop: 6 }}>Only send pictures of your homework. No faces, names or addresses. Sunny is a computer program and can slip up, so you check it!</div>
      </div>
    </div>
  );
}

/** The Wonder Journal list: the kid's saved questions and Sunny's one-line facts, as plain text. */
function SbJournal({ journal, onRemove, onClose, theme }) {
  return (
    <div style={{ margin: '0 0 14px', padding: 14, borderRadius: 18, border: `1.5px solid ${SB.sun}`, background: SB.paper }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <div style={{ flex: 1, fontSize: 17, fontWeight: 800, color: SB.ink }}>My wonder journal</div>
        <button className="aix-btn" onClick={onClose} aria-label="Close my journal" style={{ ...sbPill(false, theme), padding: '6px 14px' }}>Close</button>
      </div>
      <p style={{ margin: '0 0 6px', color: SB.faint, fontSize: 13 }}>Sunny can be wrong. Check it!</p>
      {journal.length === 0 && <p style={{ margin: 0, color: SB.mute, fontSize: 15 }}>Nothing yet. After a wonder answer with a fun fact, tap Save to my journal and it will live here.</p>}
      {journal.map((e, i) => (
        <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 0', borderTop: i ? `1px solid ${SB.line}` : 'none' }}>
          <div style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
            <div style={{ fontWeight: 800, color: SB.ink, fontSize: 15.5 }}>{e.q}</div>
            <div style={{ color: SB.mute, fontSize: 14.5, marginTop: 2, lineHeight: 1.4 }}>Sunny said: {e.fact}</div>
          </div>
          <button className="aix-btn" onClick={() => onRemove(i)} aria-label={`Remove "${e.q}" from my journal`} style={{ width: 44, height: 44, borderRadius: 999, border: `1.5px solid ${SB.line}`, background: '#fff', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><SbIcon name="close" size={16} color={SB.mute} /></button>
        </div>
      ))}
    </div>
  );
}

/**
 * Study Buddy studio. Props come from the AI Explorers shell.
 * @param {{onExit:Function, onAward:(id:string)=>void, onExplore?:(key:string, n:number)=>void, theme:Object}} props
 */
function StudyBuddy({ onExit, onAward, onExplore, theme }) {
  const L = window.AIXStudyLogic;
  theme = theme || { primary: '#2563eb' };
  const [mode, setMode] = React.useState('homework');
  const [grade, setGrade] = React.useState('g4-6');
  const [journal, setJournal] = React.useState(() => { try { return L.loadJournal(window.localStorage); } catch (e) { return []; } });
  const [showJournal, setShowJournal] = React.useState(false);
  const awarded = React.useRef(false);                                   // the badge is given the first time the child says how their check went
  const started = React.useRef(Date.now());
  const [breakNote, setBreakNote] = React.useState(false);
  // One quiet nudge after 20 minutes. It shows once per visit and never blocks anything.
  React.useEffect(() => {
    const t = setInterval(() => { if (L.breakDue(started.current, Date.now())) { setBreakNote(true); clearInterval(t); } }, 30000);
    return () => clearInterval(t);
  }, []);

  const onCheck = () => { if (!awarded.current) { awarded.current = true; if (onAward) onAward('study'); } };
  const onWonder = () => { if (onExplore) onExplore('wonder', 1); };     // +1 for each new wonder question asked
  const saveEntry = (q, fact) => {
    const next = L.addEntry(journal, q, fact);
    setJournal(next);
    try { L.saveJournal(window.localStorage, next); } catch (e) {}
    return true;                                                         // it is in the journal for this visit even if storage is blocked
  };
  const removeEntry = (i) => { const next = L.removeEntry(journal, i); setJournal(next); try { L.saveJournal(window.localStorage, next); } catch (e) {} };

  const Frame = window.AixFrame;
  const body = (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      {breakNote && (
        <div role="status" style={{ margin: '0 0 12px', padding: '12px 16px', borderRadius: 16, background: SB.paper, border: `1.5px solid ${SB.sun}`, color: SB.ink, fontSize: 15.5, fontWeight: 700, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 200 }}>You have been exploring for 20 minutes. Time for a stretch or a look outside! You can come back any time.</span>
          <button className="aix-btn" onClick={() => setBreakNote(false)} style={sbChip(theme)}>OK</button>
        </div>
      )}
      <div role="group" aria-label="What would you like to do?" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10, marginBottom: 12 }}>
        {[['homework', 'Homework doubt', 'Stuck? Let us figure it out together.'], ['wonder', "I'm curious", 'Wonder about anything at all.']].map(([id, title, sub]) => (
          <button key={id} className="aix-btn" aria-pressed={mode === id} onClick={() => setMode(id)}
            style={{ textAlign: 'left', padding: '12px 16px', borderRadius: 18, cursor: 'pointer', border: `2px solid ${mode === id ? theme.primary : SB.line}`, background: mode === id ? (theme.tint || '#fff') : '#fff' }}>
            <span style={{ display: 'block', fontSize: 17, fontWeight: 800, color: SB.ink }}>{title}</span>
            <span style={{ display: 'block', fontSize: 13.5, color: SB.mute, marginTop: 2 }}>{sub}</span>
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }} role="group" aria-label="Your grade">
        <span style={{ fontSize: 13.5, fontWeight: 800, color: SB.mute }}>I am in</span>
        {SB_GRADES.map(g => <button key={g.id} className="aix-btn" aria-pressed={grade === g.id} onClick={() => setGrade(g.id)} style={sbPill(grade === g.id, theme)}>{g.label}</button>)}
        {mode === 'wonder' && <button className="aix-btn" onClick={() => setShowJournal(s => !s)} aria-expanded={showJournal} style={{ ...sbChip(theme), marginLeft: 'auto' }}><SbIcon name="book" size={16} />My journal ({journal.length})</button>}
      </div>
      {mode === 'wonder' && showJournal && <SbJournal journal={journal} onRemove={removeEntry} onClose={() => setShowJournal(false)} theme={theme} />}
      <SbChat mode="homework" grade={grade} theme={theme} hidden={mode !== 'homework'} onCheck={onCheck} onWonder={onWonder} journal={journal} onSave={saveEntry} />
      <SbChat mode="wonder" grade={grade} theme={theme} hidden={mode !== 'wonder'} onCheck={onCheck} onWonder={onWonder} journal={journal} onSave={saveEntry} />
    </div>
  );
  if (!L || !L.buildRequest) return window.AixFallback ? <window.AixFallback title="Sunny is still getting ready" onExit={onExit} /> : null;
  return typeof Frame === 'function' ? <Frame title="Study Buddy" theme={theme} onExit={onExit}>{body}</Frame> : body;
}

window.AIX_STUDIOS = window.AIX_STUDIOS || {};
window.AIX_STUDIOS.study = StudyBuddy;
