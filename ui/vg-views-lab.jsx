/* ============================================================
   SparkGarden — Prompt Lab: practice writing a good picture / video prompt, step by step.
   Everything happens in the browser (logic in vg-lab-logic.js, formats in vg-formats.js): nothing is sent to the
   server or billed, except the optional "Ask Sunny" story review (POST /api/story-review).

   Look: editorial rather than dashboard — one accent colour (the theme), hairline rules instead of boxes, big step
   numbers, one open step at a time, and a ruled "notebook page" where the prompt is written out.
   ============================================================ */

const LAB = { ink: '#14202b', mute: '#5b6b79', faint: '#94a3b0', line: '#e4e8ec', warm: '#b45309', good: '#15803d' };
const LAB_MARKS = ['#cfe3ff', '#ffe9a8', '#ffd3e4', '#c9f0d4'];       // soft highlighter colours for the parts of a prompt
const LAB_EYEBROW = { fontSize: 11.5, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: LAB.faint };

// ---- small drawn glyphs (no emoji) ----
function LabMark({ status, color, size = 22 }) {
  const c = status === 'ok' ? color : status === 'vague' ? LAB.warm : '#c3ccd4';
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" aria-hidden="true" style={{ flexShrink: 0 }}>
      {status === 'ok' && <><circle cx="11" cy="11" r="10" fill={c} /><path d="M6.4 11.4l3.1 3.1 6.2-6.6" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></>}
      {status === 'vague' && <><circle cx="11" cy="11" r="9.2" fill="none" stroke={c} strokeWidth="2" /><path d="M1.8 11a9.2 9.2 0 0 1 18.4 0z" fill={c} opacity=".28" /><path d="M6.8 11h8.4" stroke={c} strokeWidth="2" strokeLinecap="round" /></>}
      {status === 'missing' && <circle cx="11" cy="11" r="9.2" fill="none" stroke={c} strokeWidth="2" />}
    </svg>
  );
}

function LabRing({ value, color, size = 64 }) {
  const r = 26, C = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label="Score" style={{ flexShrink: 0 }}>
      <circle cx="32" cy="32" r={r} fill="none" stroke={LAB.line} strokeWidth="6" />
      <circle cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - value / 100)}
        transform="rotate(-90 32 32)" style={{ transition: 'stroke-dashoffset .35s ease' }} />
      <text x="32" y="37.5" textAnchor="middle" fontSize="17" fontWeight="800" fill={LAB.ink} style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</text>
    </svg>
  );
}

// The notebook page: ruled lines behind the text, parts highlighted like a marker pen
const LAB_PAPER = {
  background: 'repeating-linear-gradient(to bottom, transparent 0, transparent 29px, #dfe7f1 29px, #dfe7f1 30px) #fffef9',
  borderRadius: 4, border: `1px solid ${LAB.line}`, borderLeft: '3px solid #f1b9b9', padding: '2px 16px 4px 18px', lineHeight: '30px', fontSize: 16, color: LAB.ink,
};

function LabTabs({ value, onChange, theme, items }) {
  return (
    <div role="tablist" style={{ display: 'flex', gap: 26, borderBottom: `1px solid ${LAB.line}`, marginBottom: 26 }}>
      {items.map(([k, label]) => (
        <button key={k} role="tab" aria-selected={value === k} onClick={() => onChange(k)}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '10px 0 11px', fontSize: 15, fontWeight: 800, color: value === k ? LAB.ink : LAB.faint,
                   borderBottom: `3px solid ${value === k ? theme.primary : 'transparent'}`, marginBottom: -1, transition: 'color .15s' }}>{label}</button>
      ))}
    </div>
  );
}

function PromptLabPane({ theme, menuVisible }) {
  const [kind, setKind] = React.useState('image');                 // 'image' | 'video' | 'story'
  const [values, setValues] = React.useState({});
  const [active, setActive] = React.useState('idea');              // the one open step
  const [copied, setCopied] = React.useState(false);
  const L = window.VGLab;
  const promptKind = kind === 'video' ? 'video' : 'image';
  const cards = L.cardsFor(promptKind);
  const report = L.validate(promptKind, values);
  const prompt = L.assemble(promptKind, values);
  const statusOf = (id) => (report.items.find(i => i.id === id) || { status: 'missing' }).status;
  const markOf = (id) => LAB_MARKS[L.CARDS.findIndex(c => c.id === id) % LAB_MARKS.length];
  const set = (id, text) => setValues(v => ({ ...v, [id]: text.slice(0, L.MAX_LEN) }));
  const open = (id) => {
    setActive(id);
    setTimeout(() => { const el = document.getElementById('lab-card-' + id); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); const t = el.querySelector('textarea'); if (t) t.focus({ preventScroll: true }); } }, 30);
  };
  const copy = () => { try { navigator.clipboard.writeText(prompt).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); } catch (e) {} };
  const level = report.score >= 90 ? 'A super prompt' : report.ready ? 'Ready to go' : report.score >= 40 ? 'Getting there' : 'Just starting';
  const ringColor = report.ready ? LAB.good : theme.primary;

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: menuVisible ? '60px 28px 56px' : '34px 40px 56px', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: 1120, margin: '0 auto' }}>
        <div style={LAB_EYEBROW}>Prompt Lab</div>
        <h1 style={{ fontSize: 'clamp(28px, 4vw, 40px)', lineHeight: 1.08, fontWeight: 800, letterSpacing: '-0.03em', color: LAB.ink, margin: '8px 0 10px', maxWidth: 640 }}>
          Say it so the AI can <span style={{ color: theme.primary }}>see it</span>.
        </h1>
        <p style={{ margin: '0 0 26px', color: LAB.mute, fontSize: 16.5, lineHeight: 1.55, maxWidth: 600 }}>
          A good prompt answers what, who, where and how. Work through the steps and watch your prompt grow on the page. It's only practice, so it's free.
        </p>
        <LabTabs theme={theme} value={kind} onChange={setKind} items={[['image', 'Picture'], ['video', 'Video'], ['story', 'Story check']]} />

        {kind === 'story' ? <StoryCheck theme={theme} /> : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '36px 56px', alignItems: 'flex-start' }}>
            {/* steps — only the open one shows its help */}
            <ol style={{ flex: '1 1 480px', minWidth: 0, listStyle: 'none', margin: 0, padding: 0 }}>
              {cards.map((c, n) => {
                const st = statusOf(c.id), isOpen = active === c.id, val = values[c.id] || '';
                return (
                  <li key={c.id} id={'lab-card-' + c.id} style={{ borderTop: `1px solid ${LAB.line}`, padding: isOpen ? '20px 0 24px' : '14px 0' }}>
                    <button onClick={() => isOpen ? setActive(null) : open(c.id)} aria-expanded={isOpen}
                      style={{ display: 'flex', alignItems: 'center', gap: 14, width: '100%', border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, textAlign: 'left' }}>
                      <span style={{ width: 30, fontSize: 13, fontWeight: 800, color: LAB.faint, fontVariantNumeric: 'tabular-nums' }}>{String(n + 1).padStart(2, '0')}</span>
                      <span style={{ fontSize: isOpen ? 21 : 17, fontWeight: 800, letterSpacing: '-0.01em', color: LAB.ink }}>{c.title}</span>
                      {!c.required && <span style={{ ...LAB_EYEBROW, fontSize: 10.5, color: LAB.faint }}>bonus</span>}
                      {!isOpen && val && <span style={{ flex: 1, minWidth: 0, color: LAB.mute, fontSize: 14.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{val}</span>}
                      <span style={{ marginLeft: 'auto', paddingLeft: 10 }}><LabMark status={st} color={theme.primary} /></span>
                    </button>
                    {isOpen && (
                      <div style={{ padding: '10px 0 0 44px' }}>
                        <div style={{ fontSize: 16, fontWeight: 700, color: LAB.ink }}>{c.ask}</div>
                        <div style={{ fontSize: 14.5, color: LAB.mute, margin: '4px 0 12px', lineHeight: 1.5, maxWidth: 520 }}>{c.why}</div>
                        <textarea value={val} onChange={e => set(c.id, e.target.value)} rows={2} maxLength={L.MAX_LEN} aria-label={c.title} placeholder="Write it here, or pick an idea"
                          style={{ width: '100%', boxSizing: 'border-box', border: `1.5px solid ${LAB.line}`, borderRadius: 10, padding: '11px 14px', fontSize: 16, fontFamily: 'inherit', color: LAB.ink, resize: 'vertical', outline: 'none', background: '#fff' }}
                          onFocus={e => e.target.style.borderColor = theme.primary} onBlur={e => e.target.style.borderColor = LAB.line} />
                        {st === 'vague' && <div style={{ color: LAB.warm, fontSize: 13.5, fontWeight: 700, marginTop: 6 }}>Say a little more — at least {c.minWords} words.</div>}
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', marginTop: 10 }}>
                          {c.chips.map(t => (
                            <button key={t} onClick={() => set(c.id, t)} style={{ border: 'none', background: 'transparent', padding: '4px 0', fontSize: 14, color: theme.primaryDark, cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'rgba(0,0,0,.18)', textUnderlineOffset: 3, textAlign: 'left' }}>{t}</button>
                          ))}
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
              <li style={{ borderTop: `1px solid ${LAB.line}` }} aria-hidden="true" />
            </ol>

            {/* right: score + checklist, then the page being written — stays in view while the steps scroll */}
            <aside style={{ flex: '0 1 380px', minWidth: 290, position: 'sticky', top: 14, alignSelf: 'flex-start', display: 'flex', flexDirection: 'column', gap: 30 }}>
              <section aria-label="Checklist">
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 14 }}>
                  <LabRing value={report.score} color={ringColor} />
                  <div>
                    <div style={LAB_EYEBROW}>Checklist</div>
                    <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.015em', color: LAB.ink }}>{level}</div>
                  </div>
                </div>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {report.items.map(i => (
                    <li key={i.id}>
                      <button onClick={() => open(i.id)} style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'left', border: 'none', background: active === i.id ? theme.tint : 'transparent', borderRadius: 8, padding: '6px 8px', margin: '1px -8px', cursor: 'pointer', fontSize: 15, color: LAB.ink }}>
                        <LabMark status={i.status} color={theme.primary} size={18} />
                        <span style={{ fontWeight: i.status === 'ok' ? 600 : 500, color: i.status === 'ok' ? LAB.mute : LAB.ink }}>{i.title}</span>
                        {!i.required && <span style={{ marginLeft: 'auto', fontSize: 11.5, color: LAB.faint }}>bonus</span>}
                      </button>
                    </li>
                  ))}
                </ul>
                {report.nextHint
                  ? <p style={{ margin: '12px 0 0', fontSize: 14.5, color: LAB.ink, lineHeight: 1.5 }}><strong style={{ color: theme.primaryDark }}>Next:</strong> {report.nextHint}</p>
                  : report.ready && <p style={{ margin: '12px 0 0', fontSize: 14.5, color: LAB.good, fontWeight: 700 }}>Every needed step is done. Add the bonus steps to make it shine.</p>}
              </section>

              <section aria-label="Your prompt">
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div style={LAB_EYEBROW}>Your prompt</div>
                  {prompt && <button onClick={copy} style={{ border: 'none', background: 'transparent', color: theme.primaryDark, fontWeight: 800, fontSize: 13.5, cursor: 'pointer', padding: 0 }}>{copied ? 'Copied' : 'Copy'}</button>}
                </div>
                <div style={LAB_PAPER}>
                  {prompt
                    ? L.parts(promptKind, values).map(p => (
                        <span key={p.id} title={p.title} style={{ background: `linear-gradient(transparent 30%, ${markOf(p.id)} 30%, ${markOf(p.id)} 88%, transparent 88%)`, padding: '0 2px', marginRight: 5, boxDecorationBreak: 'clone', WebkitBoxDecorationBreak: 'clone' }}>{p.text.replace(/[.\s]+$/, '') + '.'}</span>
                      ))
                    : <span style={{ color: LAB.faint, fontStyle: 'italic' }}>Your page is empty. Start with step 01.</span>}
                </div>
              </section>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- "How do you want it explained?" — shared by Chat (under an answer), Pictures and the Lab ----------
function FormatPicker({ theme, question, onPick, askTopic }) {
  const F = window.VGFormats;
  const [typed, setTyped] = React.useState('');
  const [more, setMore] = React.useState(false);
  const topic = askTopic ? typed.trim() : F.topicOf(question);
  const { top, more: rest } = F.suggestFormats(askTopic ? typed : question);
  const row = (f, i) => (
    <button key={f.id} disabled={!topic} onClick={() => onPick(F.buildFormatPrompt(topic, f), f)} title={f.example}
      style={{ display: 'flex', alignItems: 'baseline', gap: 12, width: '100%', textAlign: 'left', border: 'none', borderTop: `1px solid ${LAB.line}`, background: 'transparent', padding: '10px 2px', cursor: topic ? 'pointer' : 'not-allowed', opacity: topic ? 1 : 0.5 }}>
      <span style={{ width: 22, fontSize: 12, fontWeight: 800, color: LAB.faint, fontVariantNumeric: 'tabular-nums' }}>{String(i + 1).padStart(2, '0')}</span>
      <span style={{ fontWeight: 800, fontSize: 15, color: LAB.ink, minWidth: 150 }}>{f.name}</span>
      <span style={{ fontSize: 14, color: LAB.mute, flex: 1 }}>{f.asks}</span>
      <span aria-hidden="true" style={{ color: theme.primary, fontWeight: 800 }}>→</span>
    </button>
  );
  return (
    <div style={{ background: 'rgba(255,255,255,.82)', border: `1px solid ${LAB.line}`, borderRadius: 14, padding: '14px 16px 6px', margin: '10px 0 2px' }}>
      <div style={LAB_EYEBROW}>Explain it with a picture</div>
      <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: '-0.01em', color: LAB.ink, margin: '4px 0 8px' }}>How do you want it explained?</div>
      {askTopic && <input value={typed} onChange={e => setTyped(e.target.value.slice(0, 120))} placeholder="What do you want explained? (like: how a car works)" aria-label="Topic to explain"
        style={{ width: '100%', boxSizing: 'border-box', border: `1.5px solid ${LAB.line}`, borderRadius: 10, padding: '9px 12px', fontSize: 15, marginBottom: 6, outline: 'none', background: '#fff' }} />}
      <div style={{ fontSize: 13, color: LAB.mute, margin: '2px 0 4px' }}>{askTopic && !topic ? 'Type your topic first, then pick a way.' : 'Best ways for this topic'}</div>
      {top.map(row)}
      <button onClick={() => setMore(m => !m)} style={{ border: 'none', borderTop: `1px solid ${LAB.line}`, background: 'transparent', width: '100%', textAlign: 'left', color: theme.primaryDark, fontWeight: 800, fontSize: 13.5, cursor: 'pointer', padding: '10px 2px' }}>{more ? 'Show fewer' : `${rest.length} more ways`}</button>
      {more && rest.map((f, i) => row(f, i + top.length))}
    </div>
  );
}

// ---------- Story check: free instant checklist + optional "Ask Sunny" AI review (costs a little credit) ----------
function StoryCheck({ theme }) {
  const L = window.VGLab;
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [review, setReview] = React.useState(null);        // { reply } | { error }
  const r = L.evaluateStory(text);
  const ready = text.trim().length >= 20;
  async function ask() {
    setBusy(true); setReview(null);
    try {
      const { ok, data } = await vgPost('/api/story-review', { story: text.trim() });
      setReview(ok ? { reply: data.reply } : { error: data.error || 'Something went wrong.' });
    } catch (e) { setReview({ error: 'Could not reach the server. Please try again.' }); }
    setBusy(false);
    window.dispatchEvent(new Event('vg-credits'));
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '36px 56px', alignItems: 'flex-start' }}>
      <div style={{ flex: '1 1 480px', minWidth: 0 }}>
        <div style={LAB_EYEBROW}>Your story</div>
        <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: '-0.01em', color: LAB.ink, margin: '4px 0 4px' }}>Write a story or a topic idea</div>
        <div style={{ fontSize: 14.5, color: LAB.mute, marginBottom: 12 }}>Four to eight sentences is plenty. The checklist shows if a reader will want to keep going.</div>
        <textarea value={text} onChange={e => setText(e.target.value.slice(0, L.STORY_MAX))} rows={9} maxLength={L.STORY_MAX} aria-label="Your story" placeholder="Once upon a time…"
          style={{ ...LAB_PAPER, width: '100%', boxSizing: 'border-box', padding: '0 16px 0 18px', minHeight: 270, fontFamily: 'inherit', resize: 'vertical', outline: 'none' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: LAB.faint, fontVariantNumeric: 'tabular-nums' }}>{r.words} words · {r.sentences} sentences · {text.length}/{L.STORY_MAX}</span>
          <button onClick={ask} disabled={!ready || busy}
            style={{ marginLeft: 'auto', border: 'none', borderRadius: 10, padding: '11px 20px', fontWeight: 800, fontSize: 15, cursor: ready && !busy ? 'pointer' : 'not-allowed', background: ready ? LAB.ink : '#e6eaee', color: ready ? '#fff' : LAB.faint }}>
            {busy ? 'Sunny is reading…' : 'Ask Sunny to review'}
          </button>
        </div>
        <div style={{ fontSize: 12.5, color: LAB.faint, marginTop: 8 }}>The checklist is always free. Asking Sunny uses a tiny bit of credit.</div>
        {review && (
          <div style={{ marginTop: 26, borderLeft: `4px solid ${review.error ? LAB.warm : theme.primary}`, paddingLeft: 18 }}>
            <div style={LAB_EYEBROW}>{review.error ? 'Hmm' : 'A note from Sunny'}</div>
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 16.5, lineHeight: 1.65, marginTop: 6, color: review.error ? LAB.warm : LAB.ink }}>{review.error || review.reply.replace(/[*#`]+/g, '')}</div>
          </div>
        )}
      </div>
      <aside style={{ flex: '0 1 380px', minWidth: 290, position: 'sticky', top: 14, alignSelf: 'flex-start' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 14 }}>
          <LabRing value={r.score} color={r.score >= 85 ? LAB.good : theme.primary} />
          <div>
            <div style={LAB_EYEBROW}>Will readers love it?</div>
            <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.015em', color: LAB.ink, lineHeight: 1.2 }}>{r.label}</div>
          </div>
        </div>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {r.checks.map(c => (
            <li key={c.id} style={{ borderTop: `1px solid ${LAB.line}`, padding: '10px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                <LabMark status={c.ok ? 'ok' : 'missing'} color={theme.primary} size={18} />
                <span style={{ fontSize: 15, fontWeight: c.ok ? 600 : 700, color: c.ok ? LAB.mute : LAB.ink }}>{c.title}</span>
              </div>
              {!c.ok && text.trim() && (
                <div style={{ margin: '5px 0 0 29px', fontSize: 13.5, color: LAB.mute, lineHeight: 1.5 }}>
                  {c.tip}
                  <button onClick={() => setText(t => (c.id === 'hook' ? c.example + ' ' + t.trim() : t.trim() + ' ' + c.example).slice(0, L.STORY_MAX))}   // a hook belongs at the start
                    style={{ display: 'block', marginTop: 4, border: 'none', background: 'transparent', padding: 0, fontSize: 13.5, color: theme.primaryDark, cursor: 'pointer', textAlign: 'left', textDecoration: 'underline', textDecorationColor: 'rgba(0,0,0,.18)', textUnderlineOffset: 3 }}>Add: “{c.example}”</button>
                </div>
              )}
            </li>
          ))}
          <li style={{ borderTop: `1px solid ${LAB.line}` }} aria-hidden="true" />
        </ul>
      </aside>
    </div>
  );
}

Object.assign(window, { PromptLabPane, FormatPicker });
