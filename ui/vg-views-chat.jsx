/* ============================================================
   SparkGarden — ChatGPT-style shell: sidebar + Chat + Image conversations.
   Video mode is the existing studio, embedded in the same shell (see VideoStudio in VideoGen.html).
   Conversation history lives in this browser only (localStorage, per user) — nothing is stored server-side
   except generated images (they are library items, owned by the creator).
   ============================================================ */

const { useState: useS, useEffect: useE, useRef: useR, useCallback: useC } = React;

const VG_CHAT_SUGGESTIONS = [
  { icon: 'book', text: 'Tell me a short bedtime story about a brave little robot' },
  { icon: 'sun', text: 'Why is the sky blue? Explain it like I am six' },
  { icon: 'smile', text: 'Give me three funny riddles' },
  { icon: 'film', text: 'Help me plan a 3-scene video about a friendly dragon' },
];
const VG_IMAGE_SUGGESTIONS = [
  { icon: 'star', text: 'A baby elephant waving hello, bright cartoon colours' },
  { icon: 'sun', text: 'A happy sun wearing sunglasses over a rainbow' },
  { icon: 'heart', text: 'A cozy treehouse in a forest at sunset' },
  { icon: 'moon', text: 'A sleepy owl reading a book under the moon' },
];

// ---------- helpers ----------
function vgUid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

/** POST JSON. A redirected/non-JSON reply means the session ended (e.g. account paused) → go to /login. */
async function vgPost(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const isJson = (res.headers.get('content-type') || '').includes('json');
  if (res.redirected || res.status === 401 || !isJson) { window.location.href = '/login'; return { ok: false, status: 401, data: {} }; }
  if (res.status === 423) window.dispatchEvent(new Event('vg-timeup'));          // today's time allowance is used up
  return { ok: res.ok, status: res.status, data: await res.json() };
}

const VG_MAX_UPLOAD = 2 * 1024 * 1024;          // pictures must be smaller than 2 MB (server enforces the same)

/** Validate + shrink a picked picture to a JPEG data URL safely under the 2 MB limit (the server re-checks). */
async function vgPreparePicture(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Please pick a PNG, JPEG or WebP picture.');
  if (file.size >= VG_MAX_UPLOAD) throw new Error('That picture is too big. Please pick one smaller than 2 MB.');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, 1536 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    for (const q of [0.88, 0.75, 0.6, 0.45]) {
      const out = c.toDataURL('image/jpeg', q);
      if (out.length * 0.75 < VG_MAX_UPLOAD * 0.95) return out;          // base64 → bytes, with headroom
    }
    throw new Error('That picture is too big. Please pick a smaller one.');
  } finally { URL.revokeObjectURL(url); }
}

/** Small JPEG thumbnail (data URL) of a picture, for showing it in the conversation history. */
function vgThumb(dataUrl, max = 160) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

function useNarrow(px = 860) {
  const [narrow, setNarrow] = useS(() => window.matchMedia(`(max-width:${px}px)`).matches);
  useE(() => {
    const mq = window.matchMedia(`(max-width:${px}px)`);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [px]);
  return narrow;
}

/** Tiny safe renderer: paragraphs, bullet/numbered lists, **bold**, `code`, ``` fences. Builds React nodes (no HTML injection). */
function vgInline(text, key) {
  const parts = String(text).split(/(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (/^\*\*[^*]+\*\*$/.test(p)) return <strong key={key + i}>{p.slice(2, -2)}</strong>;
    if (/^\*[^*\n]+\*$/.test(p)) return <em key={key + i}>{p.slice(1, -1)}</em>;
    if (/^`[^`]+`$/.test(p)) return <code key={key + i} style={{ background: '#f1f3f5', padding: '1px 6px', borderRadius: 6, fontSize: '0.92em' }}>{p.slice(1, -1)}</code>;
    return p;
  });
}
function vgRich(text) {
  const blocks = String(text).split(/```/);
  const out = [];
  blocks.forEach((blk, bi) => {
    if (bi % 2 === 1) {
      out.push(<pre key={'c' + bi} style={{ background: '#f6f7f9', padding: 12, borderRadius: 12, overflowX: 'auto', fontSize: 13.5, margin: '10px 0' }}>{blk.replace(/^\w*\n/, '')}</pre>);
      return;
    }
    blk.split(/\n{2,}/).forEach((para, pi) => {
      const lines = para.split('\n').filter(l => l.trim() !== '');
      if (!lines.length) return;
      if (lines.every(l => /^\s*([-*•]|\d+[.)])\s+/.test(l))) {
        const ordered = /^\s*\d+[.)]/.test(lines[0]);
        const items = lines.map((l, li) => <li key={li} style={{ margin: '3px 0' }}>{vgInline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ''), `l${bi}${pi}${li}`)}</li>);
        out.push(ordered ? <ol key={`o${bi}${pi}`} style={{ margin: '8px 0', paddingLeft: 24 }}>{items}</ol> : <ul key={`u${bi}${pi}`} style={{ margin: '8px 0', paddingLeft: 22 }}>{items}</ul>);
      } else {
        out.push(<p key={`p${bi}${pi}`} style={{ margin: '8px 0' }}>{lines.map((l, li) => <React.Fragment key={li}>{li > 0 && <br />}{vgInline(l, `t${bi}${pi}${li}`)}</React.Fragment>)}</p>);
      }
    });
  });
  return out;
}

/** Reveals fresh assistant text progressively (ChatGPT feel); old messages render instantly. */
function TypedText({ text, animate, onTick }) {
  const [n, setN] = useS(animate ? 0 : text.length);
  useE(() => {
    if (!animate) { setN(text.length); return; }
    let i = 0;
    const step = Math.max(2, Math.ceil(text.length / 90));
    const t = setInterval(() => { i = Math.min(text.length, i + step); setN(i); if (onTick) onTick(); if (i >= text.length) clearInterval(t); }, 16);
    return () => clearInterval(t);
  }, [text, animate]);
  return <>{vgRich(text.slice(0, n))}</>;
}

// ---------- conversation storage (per user, this browser) ----------
function useConversations(username) {
  const key = 'vg_conv_v1_' + username;
  const [store, setStore] = useS(() => {
    try { const s = JSON.parse(localStorage.getItem(key) || 'null'); if (s && s.chat && s.image) return s; } catch (e) {}
    return { chat: [], image: [] };
  });
  useE(() => {
    try {
      const clean = {};
      for (const m of ['chat', 'image']) clean[m] = store[m].map(c => ({ ...c, messages: c.messages.filter(x => !x.loading).slice(-100).map(({ fresh, ...r }) => r) }));
      localStorage.setItem(key, JSON.stringify(clean));
    } catch (e) { /* storage full/blocked — conversations just won't persist */ }
  }, [store]);
  const upsert = useC((mode, id, fn, seed) => setStore(s => {
    const list = s[mode];
    const found = list.find(c => c.id === id);
    const next = found ? list.map(c => c.id === id ? { ...fn(c), updated: Date.now() } : c)
                       : [{ ...fn({ id, title: 'New chat', messages: [], ...seed }), updated: Date.now() }, ...list].slice(0, 40);
    return { ...s, [mode]: next.sort((a, b) => b.updated - a.updated) };
  }), []);
  const remove = useC((mode, id) => setStore(s => ({ ...s, [mode]: s[mode].filter(c => c.id !== id) })), []);
  return { store, upsert, remove };
}

// ---------- shared UI bits ----------
function Avatar({ theme, size = 30 }) {
  return (
    <div style={{ width: size, height: size, borderRadius: 999, background: theme.logo, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <VGIcon name="sun" size={size * 0.56} color="#fff" />
    </div>
  );
}

/** Message box: text, optional attached picture (button / drag-drop / paste) and voice typing (mic).
 *  `busy` = a reply is on its way (shows the spinner); `disabled` = can't send right now (no spinner). */
function Composer({ theme, placeholder, busy, disabled, onSend, footnote, canAttach, attachHint, onNotice, onAttached, prefill }) {
  const [text, setText] = useS('');
  const [pic, setPic] = useS(null);                 // { dataUrl, thumb }
  const [listening, setListening] = useS(false);
  const [dragOver, setDragOver] = useS(false);
  const ref = useR(null), fileRef = useR(null), rec = useR(null), base = useR('');
  useE(() => { const el = ref.current; if (!el) return; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 180) + 'px'; }, [text]);
  useE(() => () => { if (rec.current) { try { rec.current.abort(); } catch (e) {} } }, []);
  useE(() => { if (prefill) { setText(prefill.text); if (ref.current) ref.current.focus(); } }, [prefill && prefill.nonce]);   // e.g. 'Draw this' from a chat answer

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micOk = !!SR && window.isSecureContext;

  function toggleMic() {
    if (!SR) { onNotice('Voice typing needs Chrome, Edge or Safari.'); return; }
    if (!window.isSecureContext) { onNotice('Voice typing needs a secure (https) connection. Ask a grown-up to set that up.'); return; }
    if (listening) { try { rec.current.stop(); } catch (e) {} return; }
    const r = new SR();
    r.lang = navigator.language || 'en-US'; r.interimResults = true; r.continuous = true;
    base.current = text ? text.replace(/\s*$/, ' ') : '';
    r.onresult = (e) => { let t = ''; for (let k = 0; k < e.results.length; k++) t += e.results[k][0].transcript; setText((base.current + t).slice(0, 2000)); };
    r.onerror = (e) => {
      setListening(false);
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') onNotice('Please allow the microphone, then try again.');
      else if (e.error === 'no-speech') onNotice("I didn't hear anything. Try again!");
      else if (e.error !== 'aborted') onNotice('Voice typing stopped. Try again.');
    };
    r.onend = () => setListening(false);
    rec.current = r;
    try { r.start(); setListening(true); } catch (e) { setListening(false); }
  }

  async function attach(file) {
    if (!file) return;
    if (!canAttach) { onNotice(attachHint || 'Pictures are not available here.'); return; }
    try {
      const dataUrl = await vgPreparePicture(file);                    // PNG/JPEG/WebP, < 2 MB, downsized
      setPic({ dataUrl, thumb: await vgThumb(dataUrl) });
      if (onAttached) onAttached();
    } catch (e) { onNotice(e && e.message ? e.message : 'Could not read that picture'); }
  }

  const go = () => {
    const t = text.trim();
    if ((!t && !pic) || busy || disabled) return;
    if (rec.current) { try { rec.current.abort(); } catch (e) {} }
    setListening(false);
    onSend(t, pic ? { mime: 'image/jpeg', base64: pic.dataUrl.split(',')[1] } : null, pic ? pic.thumb : null);
    setText(''); setPic(null);
  };
  const can = (text.trim() || pic) && !busy && !disabled;
  return (
    <div style={{ padding: '0 16px 14px' }}
      onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
      onDrop={e => { e.preventDefault(); setDragOver(false); attach(e.dataTransfer.files && e.dataTransfer.files[0]); }}>
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <div style={{ background: '#fff', border: `1.5px ${dragOver ? 'dashed' : 'solid'} ${dragOver ? theme.primary : '#e3e6ea'}`, borderRadius: 26, padding: '8px 8px 8px 12px', boxShadow: '0 4px 20px rgba(15,20,25,0.07)' }}>
          {pic && (
            <div style={{ display: 'flex', padding: '6px 8px 2px' }}>
              <div style={{ position: 'relative' }}>
                <img src={pic.thumb || pic.dataUrl} alt="Your picture" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 14, border: '1px solid #e5e7eb', display: 'block' }} />
                <button onClick={() => setPic(null)} aria-label="Remove picture" style={{ position: 'absolute', top: -7, right: -7, width: 22, height: 22, borderRadius: 999, border: 'none', background: '#0f1419', color: '#fff', cursor: 'pointer', fontSize: 14, lineHeight: '22px', padding: 0 }}>×</button>
              </div>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={e => { attach(e.target.files[0]); e.target.value = ''; }} />
            <button onClick={() => canAttach ? fileRef.current.click() : onNotice(attachHint || 'Pictures are not available here.')} aria-label="Add a picture" title={canAttach ? 'Add a picture or drawing' : attachHint}
              style={{ ...roundBtn, opacity: canAttach ? 1 : 0.4 }}><VGIcon name="image" size={20} color="#6b7280" /></button>
            <textarea ref={ref} value={text} rows={1} maxLength={2000} autoFocus
              placeholder={listening ? 'Listening… speak now' : placeholder}
              onChange={e => setText(e.target.value)}
              onPaste={e => { const f = Array.from(e.clipboardData.files || []).find(x => x.type.startsWith('image/')); if (f) { e.preventDefault(); attach(f); } }}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); go(); } }}
              style={{ flex: 1, border: 'none', outline: 'none', resize: 'none', fontSize: 16, lineHeight: 1.45, padding: '8px 0', background: 'transparent', maxHeight: 180 }} />
            <button onClick={toggleMic} aria-label={listening ? 'Stop listening' : 'Speak instead of typing'} title={micOk ? (listening ? 'Tap to stop' : 'Tap and talk') : 'Voice typing'}
              style={{ ...roundBtn, background: listening ? '#ef4444' : 'transparent', animation: listening ? 'vgpulse 1.4s infinite' : 'none', opacity: micOk || listening ? 1 : 0.55 }}>
              <VGIcon name="mic" size={20} color={listening ? '#fff' : '#6b7280'} />
            </button>
            <button onClick={go} disabled={!can} aria-label="Send" style={{
              ...roundBtn, cursor: can ? 'pointer' : 'default', background: can ? theme.primary : '#e5e7eb', transition: 'background .15s' }}>
              {busy ? <span className="vg-spin" style={{ width: 16, height: 16, border: '2.5px solid rgba(255,255,255,.5)', borderTopColor: '#fff', borderRadius: 999 }} />
                    : <VGIcon name="arrow-up" size={19} color="#fff" stroke={2.4} />}
            </button>
          </div>
        </div>
        <div style={{ textAlign: 'center', fontSize: 12, color: '#9ca3af', marginTop: 8 }}>{footnote}</div>
      </div>
    </div>
  );
}
const roundBtn = { width: 38, height: 38, borderRadius: 999, border: 'none', cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', padding: 0 };

function EmptyState({ theme, kind, name, suggestions, onPick }) {
  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '8vh 20px 24px', textAlign: 'center' }}>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 18 }}><img src="/ui/logo.png" alt="" width={72} height={72} style={{ borderRadius: 16, boxShadow: '0 8px 24px rgba(1,88,252,.25)' }} /></div>
      <h1 style={{ fontFamily: "'Inter',sans-serif", fontSize: 30, fontWeight: 800, letterSpacing: '-0.6px', margin: '0 0 8px', color: '#0f1419' }}>
        Hi {name}! {kind === 'chat' ? 'What shall we talk about?' : 'What shall we draw?'}
      </h1>
      <p style={{ margin: '0 0 28px', color: '#6b7280', fontSize: 16 }}>{kind === 'chat' ? 'Ask me anything, or pick an idea below.' : 'Describe a picture and I will make it for you.'}</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))', gap: 12, textAlign: 'left' }}>
        {suggestions.map(s => (
          <button key={s.text} onClick={() => onPick(s.text)} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '14px 16px', border: '1.5px solid #e8eaed', borderRadius: 16, background: '#fff', cursor: 'pointer', fontSize: 14.5, color: '#374151', lineHeight: 1.4, fontWeight: 500 }}>
            <span style={{ marginTop: 1 }}><VGIcon name={s.icon} size={18} color={theme.primary} /></span>{s.text}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Popup viewer for a picture or video: click outside / Esc / Close to dismiss. Used by Pictures and My Library. */
function MediaViewer({ view, onClose, onUseImage }) {
  const [useMenu, setUseMenu] = useS(false);
  useE(() => {
    const on = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  return (
    <div onClick={onClose} role="dialog" aria-modal="true" aria-label={view.title}
      style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(15,20,25,.82)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 22, maxWidth: 'min(1000px,100%)', maxHeight: '100%', overflow: 'auto', padding: 16 }}>
        {view.type === 'image'
          ? <img src={view.url} alt={view.title} style={{ display: 'block', maxWidth: '100%', maxHeight: '78vh', margin: '0 auto', borderRadius: 14 }} />
          : <video src={view.url} controls autoPlay playsInline style={{ display: 'block', maxWidth: '100%', maxHeight: '78vh', margin: '0 auto', borderRadius: 14, background: '#000' }} />}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap', position: 'relative' }}>
          <div style={{ flex: 1, minWidth: 160, fontWeight: 600, color: '#1f2933' }}>{view.title}</div>
          <a href={view.url} download={`sparkgarden-${view.id}`} style={chipBtn}><VGIcon name="download" size={15} /> Save</a>
          {view.type === 'image' && onUseImage && <button onClick={() => setUseMenu(m => !m)} style={chipBtn}><VGIcon name="film" size={15} /> Use in a video</button>}
          <button onClick={onClose} style={chipBtn}>Close</button>
          {useMenu && (
            <div style={{ position: 'absolute', bottom: 46, right: 80, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, boxShadow: '0 12px 30px rgba(0,0,0,.14)', padding: 6, zIndex: 5, minWidth: 240 }}>
              <button style={menuItem} onClick={() => { onClose(); onUseImage(view.url, 'ref'); }}>Character look (stays the same in every scene)</button>
              <button style={menuItem} onClick={() => { onClose(); onUseImage(view.url, 'scene'); }}>Start picture of scene 1</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ImageCard({ theme, msg, onUse, toast }) {
  const [gone, setGone] = useS(false);
  const [menu, setMenu] = useS(false);
  const [open, setOpen] = useS(false);
  if (msg.loading) {
    return (
      <div style={{ width: 'min(460px,100%)', aspectRatio: '1 / 1', borderRadius: 20, background: 'linear-gradient(90deg,#f1f3f5 25%,#e9ecef 37%,#f1f3f5 63%)', backgroundSize: '400% 100%', animation: 'vgshimmer 1.4s ease infinite', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280', fontWeight: 600, textAlign: 'center', padding: 20 }}>
        <div><div style={{ fontSize: 34 }}>🎨</div>Drawing your picture…<div style={{ fontSize: 12.5, fontWeight: 500, marginTop: 4 }}>this can take up to a minute</div></div>
      </div>
    );
  }
  if (gone) return <div style={{ color: '#9ca3af', fontSize: 14 }}>This picture was removed from the library.</div>;
  return (
    <div>
      <button onClick={() => setOpen(true)} aria-label="Open picture" title="Click to enlarge" style={{ display: 'block', padding: 0, border: 'none', background: 'transparent', cursor: 'zoom-in', width: 'min(460px,100%)' }}>
        <img src={msg.url} alt={msg.prompt} onError={() => setGone(true)} style={{ width: '100%', borderRadius: 20, display: 'block', border: '1px solid #eef0f2', background: '#f6f7f9' }} />
      </button>
      {open && <MediaViewer view={{ type: 'image', url: msg.url, title: msg.prompt, id: msg.genId }} onClose={() => setOpen(false)} onUseImage={onUse} />}
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', position: 'relative' }}>
        <a href={msg.url} download={`picture-${msg.genId}`} style={chipBtn}><VGIcon name="download" size={15} /> Save</a>
        <button onClick={() => setMenu(m => !m)} style={chipBtn}><VGIcon name="film" size={15} /> Use in a video</button>
        {menu && (
          <div style={{ position: 'absolute', top: 40, left: 70, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, boxShadow: '0 12px 30px rgba(0,0,0,.14)', padding: 6, zIndex: 5, minWidth: 230 }}>
            <button style={menuItem} onClick={() => { setMenu(false); onUse(msg.url, 'ref'); }}>Character look (stays the same in every scene)</button>
            <button style={menuItem} onClick={() => { setMenu(false); onUse(msg.url, 'scene'); }}>Start picture of scene 1</button>
          </div>
        )}
      </div>
    </div>
  );
}
const chipBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', border: '1.5px solid #e3e6ea', borderRadius: 999, background: '#fff', color: '#374151', fontSize: 13, fontWeight: 600, cursor: 'pointer', textDecoration: 'none' };
const menuItem = { display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', border: 'none', background: 'transparent', borderRadius: 10, cursor: 'pointer', fontSize: 13.5, color: '#374151', lineHeight: 1.35 };

// ---------- one conversation (chat or image) ----------
function ConversationView({ theme, kind, user, models, conv, convId, upsert, onUseScript, onUseImage, onDraw, prefill, toast, narrow }) {
  const scroller = useR(null);
  const [busy, setBusy] = useS(false);
  const msgs = conv ? conv.messages : [];
  const modelKey = 'vg_model_' + kind;
  const modelList = Array.isArray(models) ? models : [];
  const allowed = modelList.filter(m => m.allowed);
  const pictureModel = allowed.find(m => m.pictures);
  const [engine, setEngine] = useS(() => localStorage.getItem(modelKey) || '');
  const active = allowed.find(m => m.id === engine) || allowed[0];

  const scrollDown = useC(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, []);
  useE(() => { scrollDown(); }, [msgs.length, convId]);

  const add = (id, m) => upsert(kind, id, c => ({ ...c, messages: [...c.messages, { id: vgUid(), ...m }] }), { engine: active && active.id });
  const replaceLoading = (id, m) => upsert(kind, id, c => ({ ...c, messages: c.messages.filter(x => !x.loading).concat([{ id: vgUid(), ...m }]) }));
  const markLastUser = (id, flag) => upsert(kind, id, c => {
    const idx = c.messages.map(x => x.role).lastIndexOf('user');
    return { ...c, messages: c.messages.map((x, i) => i === idx ? { ...x, ...flag } : x) };
  });

  async function send(rawText, picture, thumb) {
    if (!active) return;
    const text = rawText || (kind === 'chat' ? 'Here is my picture! What do you think?' : 'Turn my drawing into a beautiful finished picture');
    const id = convId || vgUid();
    if (!convId) upsert(kind, id, c => ({ ...c, title: (rawText || (picture ? 'My drawing' : '')).slice(0, 42) || 'New chat' }), { engine: active.id });
    const prior = msgs;
    add(id, { role: 'user', text: rawText, thumb: thumb || undefined, shownText: text });
    setBusy(true);
    try {
      if (kind === 'chat') {
        const history = prior.filter(m => (m.role === 'user' || m.role === 'assistant') && !m.blocked && !m.failed && (m.text || '').trim())
          .map(m => ({ role: m.role, content: m.text })).concat([{ role: 'user', content: text }]).slice(-12);   // pictures are never re-sent
        const { ok, data } = await vgPost('/api/chat', { engine: active.id, messages: history, ...(picture ? { image: picture } : {}) });
        if (ok) add(id, { role: 'assistant', text: data.reply, filtered: !!data.filtered, fresh: true });
        else { markLastUser(id, data.blocked ? { blocked: true } : { failed: true }); add(id, { role: 'notice', text: data.error || 'Something went wrong.', blocked: !!data.blocked }); }
      } else {
        add(id, { role: 'assistant', loading: true });
        const { ok, data } = await vgPost('/api/image', { engine: active.id, prompt: rawText || '', ...(picture ? { ref: picture } : {}) });
        if (ok) replaceLoading(id, { role: 'assistant', kind: 'image', genId: data.genId, url: data.url, prompt: text });
        else { markLastUser(id, data.blocked ? { blocked: true } : { failed: true }); replaceLoading(id, { role: 'notice', text: data.error || 'Something went wrong.', blocked: !!data.blocked }); }
      }
    } catch (e) {
      if (kind === 'image') replaceLoading(id, { role: 'notice', text: 'Could not reach the server. Please try again.' });
      else add(id, { role: 'notice', text: 'Could not reach the server. Please try again.' });
    } finally {
      setBusy(false);
      window.dispatchEvent(new Event('vg-credits'));
    }
  }

  const copy = (t) => { try { navigator.clipboard.writeText(t); toast('Copied!'); } catch (e) { toast('Select the text and copy it'); } };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 }}>
      {/* top bar: model picker */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: narrow ? '10px 16px 10px 64px' : '12px 20px', minHeight: 56 }}>
        {allowed.length > 0 ? (
          <select value={active ? active.id : ''} onChange={e => { setEngine(e.target.value); try { localStorage.setItem(modelKey, e.target.value); } catch (x) {} }}
            style={{ border: 'none', background: '#f3f4f6', borderRadius: 12, padding: '8px 12px', fontSize: 15, fontWeight: 700, color: '#374151', cursor: 'pointer' }}>
            {allowed.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        ) : <span style={{ color: models && models.error ? '#b45309' : '#9ca3af', fontSize: 14 }}>
              {models === null ? 'Loading…'
                : (models && models.error) ? 'Could not load the helpers. Reload the page — if it keeps happening, the server needs a restart.'
                : 'No helpers are turned on for your account — ask an admin.'}</span>}
      </div>

      {/* messages */}
      <div ref={scroller} style={{ flex: 1, overflowY: 'auto' }}>
        {msgs.length === 0 ? (
          <EmptyState theme={theme} kind={kind} name={user.username} suggestions={kind === 'chat' ? VG_CHAT_SUGGESTIONS : VG_IMAGE_SUGGESTIONS} onPick={t => send(t)} />
        ) : (
          <div style={{ maxWidth: 760, margin: '0 auto', padding: '8px 20px 24px', display: 'flex', flexDirection: 'column', gap: 22 }}>
            {msgs.map(m => {
              if (m.role === 'user') return (
                <div key={m.id} style={{ alignSelf: 'flex-end', maxWidth: '82%', background: m.blocked ? '#fef2f2' : theme.tint, color: '#0f1419', padding: '11px 18px', borderRadius: 22, fontSize: 16, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {m.thumb && <img src={m.thumb} alt="Your picture" style={{ display: 'block', maxWidth: 160, maxHeight: 160, borderRadius: 14, marginBottom: m.text ? 8 : 0, opacity: m.blocked ? 0.45 : 1 }} />}
                  {m.text || (m.thumb ? '' : m.shownText)}
                </div>
              );
              if (m.role === 'notice') return (
                <div key={m.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <Avatar theme={theme} />
                  <div style={{ background: m.blocked ? '#fff7ed' : '#f3f4f6', border: `1px solid ${m.blocked ? '#fed7aa' : '#e5e7eb'}`, color: '#7c2d12', padding: '12px 16px', borderRadius: 16, fontSize: 15.5, lineHeight: 1.5 }}>{m.text}</div>
                </div>
              );
              return (
                <div key={m.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <Avatar theme={theme} />
                  <div style={{ flex: 1, minWidth: 0, fontSize: 16, lineHeight: 1.6, color: '#1f2933', wordBreak: 'break-word' }}>
                    {m.kind === 'image' || m.loading
                      ? <ImageCard theme={theme} msg={m} onUse={onUseImage} toast={toast} />
                      : <>
                          <TypedText text={m.text} animate={!!m.fresh} onTick={scrollDown} />
                          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                            <button onClick={() => copy(m.text)} style={chipBtn}><VGIcon name="copy" size={14} /> Copy</button>
                            {kind === 'chat' && !m.filtered && m.text.length > 80 && onDraw && (() => {
                              const q = msgs.slice(0, msgs.indexOf(m)).reverse().find(x => x.role === 'user');
                              return q ? <button onClick={() => onDraw(((q.text || q.shownText) || '').slice(0, 300))} style={chipBtn}><VGIcon name="brush" size={14} /> Draw this</button> : null;
                            })()}
                            {kind === 'chat' && !m.filtered && m.text.length > 120 && <button onClick={() => onUseScript(m.text)} style={chipBtn}><VGIcon name="film" size={14} /> Make a video from this</button>}
                          </div>
                        </>}
                  </div>
                </div>
              );
            })}
            {busy && kind === 'chat' && (
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <Avatar theme={theme} />
                <div style={{ display: 'flex', gap: 5 }}>{[0, 1, 2].map(i => <span key={i} style={{ width: 8, height: 8, borderRadius: 999, background: '#9ca3af', animation: `vgdots 1.1s ${i * 0.16}s infinite ease-in-out` }} />)}</div>
              </div>
            )}
          </div>
        )}
      </div>

      <Composer theme={theme} busy={busy} disabled={!active} onNotice={toast} prefill={prefill}
        canAttach={!!pictureModel} attachHint={kind === 'chat' ? 'Ask an admin to turn on the helper that can look at pictures.' : 'Ask an admin to turn on the model that can use your drawing.'}
        onAttached={() => { if (!(active && active.pictures) && pictureModel) { setEngine(pictureModel.id); try { localStorage.setItem(modelKey, pictureModel.id); } catch (x) {} toast(`Switched to ${pictureModel.label.split(' (')[0]} so it can use your picture`); } }}
        placeholder={!active ? (models === null ? 'Loading…' : 'No helpers available') : (kind === 'chat' ? 'Message Sunny…' : 'Describe the picture you want…')}
        footnote={kind === 'chat' ? 'Sunny is an AI and can make mistakes. Ask a grown-up if you are not sure.' : 'Pictures are made by AI. Keep your ideas kind and friendly.'}
        onSend={send} />
    </div>
  );
}

// ---------- Library: all of my pictures and videos (stored on the server, so they follow me to any device) ----------
function LibraryPane({ theme, onUseImage, toast, menuVisible }) {
  const [items, setItems] = useS(null);
  const [filter, setFilter] = useS('all');
  const [view, setView] = useS(null);          // item open in the viewer
  const [sure, setSure] = useS(null);          // id awaiting a second click to delete

  const kindOf = (e) => { const m = e.meta || {}; return m.kind === 'image' ? 'image' : (m.kind === 'script' ? null : 'video'); };
  const load = useC(() => {
    fetch('/api/list').then(r => { if (!r.ok || r.redirected) throw new Error('list'); return r.json(); }).then(list => {
      const storyIds = new Set(list.filter(e => (e.meta || {}).kind === 'story').map(e => e.id));
      setItems(list.filter(e => kindOf(e) && !((e.meta || {}).kind === 'clip' && (e.meta || {}).storyId && storyIds.has(e.meta.storyId)))
        .map(e => {
          const m = e.meta || {}, isImg = kindOf(e) === 'image';
          const file = isImg ? (m.file || 'image.png') : (m.clipPath || 'clip.mp4');
          return { id: e.id, type: isImg ? 'image' : 'video', title: (m.prompt || '').replace(/^📖\s*/, '').slice(0, 80) || (isImg ? 'Picture' : 'Video'),
                   when: m.createdAt, expires: isImg ? null : m.expiresAt, url: `/generations/${e.id}/${file}`, thumb: e.thumb || (isImg ? `/generations/${e.id}/${file}` : null), file };
        }));
    }).catch(() => setItems({ error: true }));
  }, []);
  useE(() => { load(); }, []);

  const list = Array.isArray(items) ? items : [];
  const shown = list.filter(i => filter === 'all' || i.type === filter);
  const counts = { all: list.length, image: list.filter(i => i.type === 'image').length, video: list.filter(i => i.type === 'video').length };

  async function remove(id) {
    if (sure !== id) { setSure(id); setTimeout(() => setSure(s2 => s2 === id ? null : s2), 3500); return; }
    try {
      const r = await fetch('/api/delete/' + id, { method: 'DELETE' });
      if (!r.ok) throw new Error('delete');
      setItems(prev => prev.filter(i => i.id !== id)); setView(null); setSure(null); toast('Deleted');
    } catch (e) { toast('Could not delete that'); }
  }
  const chip = (id, label) => (
    <button key={id} onClick={() => setFilter(id)} style={{ padding: '8px 16px', borderRadius: 999, border: '1.5px solid ' + (filter === id ? theme.primary : '#e3e6ea'),
      background: filter === id ? theme.tint : '#fff', color: filter === id ? theme.primaryDark : '#4b5563', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
      {label} <span style={{ opacity: .6, fontWeight: 600 }}>{counts[id]}</span>
    </button>
  );

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: menuVisible ? '60px 28px 40px' : '28px 32px 40px', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <h1 style={{ fontFamily: "'Inter',sans-serif", fontSize: 26, fontWeight: 800, letterSpacing: '-0.5px', margin: '0 0 6px' }}>My Library</h1>
        <p style={{ margin: '0 0 18px', color: '#6b7280', fontSize: 15 }}>Everything you have made — pictures and videos. It is saved for you, on any device.</p>
        {vgRetentionNote() && (
          <div style={{ margin: '-6px 0 18px', padding: '10px 16px', borderRadius: 14, background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', fontSize: 14, fontWeight: 600 }}>
            ⏳ {vgRetentionNote()}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>{chip('all', 'All')}{chip('image', 'Pictures')}{chip('video', 'Videos')}</div>

        {items === null && <div style={{ color: '#9ca3af' }}>Loading…</div>}
        {items && items.error && <div style={{ color: '#b45309' }}>Could not load your library. Reload the page — if it keeps happening, the server needs a restart.</div>}
        {Array.isArray(items) && shown.length === 0 && (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: '#6b7280' }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>🌱</div>
            <div style={{ fontWeight: 700, fontSize: 17, color: '#374151' }}>Nothing here yet</div>
            <div style={{ marginTop: 4 }}>Make a picture or a video and it will show up here.</div>
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', gap: 16 }}>
          {shown.map(i => (
            <div key={i.id} style={{ border: '1px solid #eceef1', borderRadius: 18, overflow: 'hidden', background: '#fff', boxShadow: '0 2px 10px rgba(15,20,25,.04)' }}>
              <button onClick={() => setView(i)} style={{ display: 'block', width: '100%', aspectRatio: '1 / 1', border: 'none', padding: 0, cursor: 'pointer', background: '#f3f4f6', position: 'relative' }}>
                {i.thumb ? <img src={i.thumb} alt={i.title} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                         : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}><VGIcon name="film" size={40} color="#9ca3af" /></div>}
                <span style={{ position: 'absolute', top: 10, left: 10, background: 'rgba(15,20,25,.7)', color: '#fff', borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 700, display: 'flex', gap: 5, alignItems: 'center' }}>
                  <VGIcon name={i.type === 'image' ? 'image' : 'film'} size={13} color="#fff" /> {i.type === 'image' ? 'Picture' : 'Video'}
                </span>
                {i.type === 'video' && <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span style={{ width: 46, height: 46, borderRadius: 999, background: 'rgba(255,255,255,.9)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><VGIcon name="play" size={20} color="#0f1419" /></span></span>}
              </button>
              <div style={{ padding: '10px 12px 12px' }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#1f2933', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={i.title}>{i.title}</div>
                <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{i.when ? new Date(i.when).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''}</div>
                {vgExpiry(i.expires) && <div style={{ fontSize: 12, fontWeight: 700, marginTop: 3, color: vgExpiry(i.expires).soon ? '#b45309' : '#6b7280' }}>⏳ {vgExpiry(i.expires).text}</div>}
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <a href={i.url} download={`${i.title.slice(0, 30) || 'sparkgarden'}-${i.id}`} style={{ ...chipBtn, padding: '5px 10px', fontSize: 12 }}><VGIcon name="download" size={13} /> Save</a>
                  <button onClick={() => remove(i.id)} style={{ ...chipBtn, padding: '5px 10px', fontSize: 12, color: sure === i.id ? '#fff' : '#b91c1c', background: sure === i.id ? '#dc2626' : '#fff', borderColor: sure === i.id ? '#dc2626' : '#fecaca' }}>
                    <VGIcon name="trash" size={13} color={sure === i.id ? '#fff' : '#b91c1c'} /> {sure === i.id ? 'Sure?' : 'Delete'}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {view && <MediaViewer view={view} onClose={() => setView(null)} onUseImage={onUseImage} />}
    </div>
  );
}

// ---------- daily time allowance ----------
function TimeLeft({ clock }) {
  if (!clock || !clock.limitMin) return null;
  if (clock.up) return <div style={{ fontSize: 12.5, fontWeight: 700, color: '#b45309' }}>⏱ Time's up for today</div>;
  const mins = Math.ceil((clock.leftSec || 0) / 60);
  return <div style={{ fontSize: 12.5, fontWeight: 600, color: mins <= 10 ? '#b45309' : '#6b7280' }} title="Time left today">⏱ {mins} min left today</div>;
}

function LockedPane({ theme, onLibrary, menuVisible }) {
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: menuVisible ? '60px 24px 24px' : 24, boxSizing: 'border-box' }}>
      <div style={{ maxWidth: 460, textAlign: 'center' }}>
        <div style={{ fontSize: 64, marginBottom: 6 }}>🌙</div>
        <h1 style={{ fontFamily: "'Inter',sans-serif", fontSize: 28, fontWeight: 800, letterSpacing: '-0.5px', margin: '0 0 10px' }}>Time's up for today!</h1>
        <p style={{ color: '#6b7280', fontSize: 17, lineHeight: 1.55, margin: '0 0 22px' }}>
          You did great. Rest your eyes, go play outside, and come back tomorrow. You can still look at everything you made.
        </p>
        <button onClick={onLibrary} style={{ padding: '12px 24px', border: 'none', borderRadius: 999, background: theme.primary, color: '#fff', fontWeight: 700, fontSize: 16, cursor: 'pointer', boxShadow: theme.glow }}>
          Open My Library
        </button>
        <div style={{ marginTop: 16 }}><button onClick={() => window.location.reload()} style={{ border: 'none', background: 'transparent', color: '#9ca3af', fontSize: 13, cursor: 'pointer', textDecoration: 'underline' }}>A grown-up added time? Check again</button></div>
      </div>
    </div>
  );
}

// ---------- sidebar ----------
function Sidebar({ theme, mode, setMode, convs, activeId, onNew, onSelect, onDelete, user, onClose, narrow, clock }) {
  const modeBtn = (id, icon, label) => {
    const on = mode === id;
    return (
      <button key={id} onClick={() => { setMode(id); if (narrow) onClose(); }} style={{
        display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '10px 12px', border: 'none', borderRadius: 12, cursor: 'pointer',
        background: on ? theme.tint : 'transparent', color: on ? theme.primaryDark : '#374151', fontWeight: on ? 700 : 600, fontSize: 15, textAlign: 'left' }}>
        <VGIcon name={icon} size={19} color={on ? theme.primary : '#6b7280'} />{label}
      </button>
    );
  };
  return (
    <aside style={{ width: 272, background: 'rgba(255,255,255,0.72)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)', borderRight: '1px solid rgba(226,232,240,0.8)', display: 'flex', flexDirection: 'column', height: '100%', flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 14px 8px 16px' }}>
        <VGLogo theme={theme} size={30} />
        <button onClick={onClose} aria-label="Hide sidebar" style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 6, borderRadius: 8 }}><VGIcon name="panel" size={19} color="#6b7280" /></button>
      </div>
      <div style={{ padding: '6px 12px' }}>
        {/* the Users item below is admins only; /admin also returns 404 for everyone else on the server */}
        {(mode === 'chat' || mode === 'image') && (
          <button onClick={() => { onNew(); if (narrow) onClose(); }} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '11px 14px', border: '1.5px solid #e3e6ea', borderRadius: 14, background: '#fff', cursor: 'pointer', fontSize: 15, fontWeight: 700, color: '#0f1419', marginBottom: 8 }}>
            <VGIcon name="plus" size={18} color={theme.primary} stroke={2.4} /> {mode === 'chat' ? 'New chat' : 'New picture'}
          </button>
        )}
        {modeBtn('chat', 'message', 'Chat')}
        {modeBtn('image', 'image', 'Pictures')}
        {modeBtn('video', 'film', 'Videos')}
        {modeBtn('library', 'grid', 'My Library')}
        {user.role === 'admin' && (
          <>
            <div style={{ height: 1, background: '#e8eaed', margin: '8px 6px' }} />
            {modeBtn('users', 'user', 'Users & credits')}
          </>
        )}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px' }}>
        {(mode === 'chat' || mode === 'image') && convs.length > 0 && <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: '#9ca3af', padding: '6px 10px' }}>Recent</div>}
        {(mode === 'chat' || mode === 'image') && convs.map(c => (
          <div key={c.id} className="vg-conv" onClick={() => { onSelect(c.id); if (narrow) onClose(); }} style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '9px 10px', borderRadius: 10, cursor: 'pointer', fontSize: 14.5,
            background: c.id === activeId ? '#eceff3' : 'transparent', color: '#1f2933' }}>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
            <button className="vg-conv-del" onClick={e => { e.stopPropagation(); onDelete(c.id); }} aria-label="Delete conversation" style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 4, opacity: 0 }}><VGIcon name="trash" size={15} color="#9ca3af" /></button>
          </div>
        ))}
      </div>
      <div style={{ borderTop: '1px solid #eceef1', padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 34, height: 34, borderRadius: 999, background: theme.primary, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 15, flexShrink: 0 }}>{user.username.slice(0, 1).toUpperCase()}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#0f1419', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.username}</div>
          <CreditsBadge inline />
          <TimeLeft clock={clock} />
        </div>
        <form method="POST" action="/logout" style={{ margin: 0 }}>
          <button type="submit" style={{ border: 'none', background: 'transparent', color: '#9ca3af', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', padding: '4px 2px' }}>Sign out</button>
        </form>
      </div>
    </aside>
  );
}

// ---------- the shell ----------
function AppShell({ theme, renderVideo }) {
  const user = window.VG_USER || { username: 'friend', role: 'user' };
  const narrow = useNarrow();
  const [mode, setModeState] = useS(() => {
    try {
      const m = localStorage.getItem('vg_mode');
      return ['chat', 'image', 'video', 'library'].includes(m) || (m === 'users' && user.role === 'admin') ? m : 'chat';   // 'users' is admin-only
    } catch (e) { return 'chat'; }
  });
  const [videoSeen, setVideoSeen] = useS(false);
  const [viewKey, setViewKey] = useS(0);            // bump to reset the conversation view (new / select / switch)
  const setMode = (m) => { setModeState(m); setViewKey(k => k + 1); try { localStorage.setItem('vg_mode', m); } catch (e) {} };
  useE(() => { if (mode === 'video') setVideoSeen(true); }, [mode]);
  const [open, setOpen] = useS(() => {
    try { const v = localStorage.getItem('vg_sidebar'); if (v !== null) return v !== '0'; } catch (e) {}
    return !window.matchMedia('(max-width:860px)').matches;      // closed by default on phones
  });
  const toggle = (v) => { setOpen(v); try { localStorage.setItem('vg_sidebar', v ? '1' : '0'); } catch (e) {} };
  const { store, upsert, remove } = useConversations(user.username);
  const [active, setActive] = useS({ chat: null, image: null });
  const [models, setModels] = useS(null);
  const [injected, setInjected] = useS(null);
  const [prefill, setPrefill] = useS(null);
  const [toastMsg, setToastMsg] = useS(null);
  const toast = (m) => { setToastMsg(m); clearTimeout(toast._t); toast._t = setTimeout(() => setToastMsg(null), 2600); };

  // ---- daily time allowance: report activity while the page is open, visible and in use; show/lock on the answer ----
  const [clock, setClock] = useS(null);
  const lastAct = useR(Date.now());
  useE(() => {
    const mark = () => { lastAct.current = Date.now(); };
    const evs = ['pointerdown', 'keydown', 'mousemove', 'touchstart', 'scroll'];
    evs.forEach(e => window.addEventListener(e, mark, { passive: true }));
    return () => evs.forEach(e => window.removeEventListener(e, mark));
  }, []);
  useE(() => {
    if (user.role === 'admin') return;                                   // admins are never limited
    const tick = async (force) => {
      if (!force && (document.visibilityState !== 'visible' || Date.now() - lastAct.current > 60000)) return;   // idle/hidden = no time used
      try {
        const r = await fetch('/api/ping', { method: 'POST' });
        if (r.redirected || r.status === 401) { window.location.href = '/login'; return; }
        setClock(await r.json());
      } catch (e) { /* offline — try again next tick */ }
    };
    tick(true);
    const t = setInterval(() => tick(false), 30000);
    const up = () => setClock(c => ({ ...(c || { limitMin: 1 }), up: true, leftSec: 0 }));
    window.addEventListener('vg-timeup', up);
    return () => { clearInterval(t); window.removeEventListener('vg-timeup', up); };
  }, []);
  useE(() => {                                                           // one gentle heads-up per day
    if (!clock || !clock.limitMin || clock.up || clock.leftSec == null || clock.leftSec > 300) return;
    const key = 'vg_warned_' + new Date().toDateString();
    try { if (!localStorage.getItem(key)) { localStorage.setItem(key, '1'); toast('⏳ About 5 minutes left today'); } } catch (e) {}
  }, [clock && clock.leftSec]);
  const locked = !!(clock && clock.up) && user.role !== 'admin';

  useE(() => {
    fetch('/api/models').then(r => { if (!r.ok || r.redirected) throw new Error('models'); return r.json(); }).then(setModels)
      .catch(() => setModels({ error: true, chat: { error: true }, image: { error: true } }));
  }, []);

  const isConv = mode === 'chat' || mode === 'image';
  const convs = isConv ? store[mode] : [];
  const convId = !isConv ? null : (convs.find(c => c.id === active[mode]) ? active[mode] : null);
  const conv = convId ? convs.find(c => c.id === convId) : null;

  // upsert wrapper: remember a newly created conversation as the active one
  const upsertActive = (m, id, fn, seed) => { upsert(m, id, fn, seed); setActive(a => a[m] === id ? a : { ...a, [m]: id }); };

  async function useImage(url, kindOfUse) {
    try {
      const blob = await (await fetch(url)).blob();
      const dataUrl = await vgReadImage(new File([blob], 'picture', { type: blob.type }));
      setInjected({ kind: kindOfUse, value: dataUrl, nonce: Date.now() });
      setMode('video');
    } catch (e) { toast('Could not load that picture'); }
  }
  const drawThis = (question) => { setPrefill({ text: `Draw a bright, friendly picture that helps explain: ${question}`, nonce: Date.now() }); setMode('image'); };
  const useScript = (text) => { setInjected({ kind: 'script', value: text, nonce: Date.now() }); setMode('video'); };

  const menuBtn = (!open || narrow) && (
    <button onClick={() => toggle(true)} aria-label="Show sidebar" style={{ position: 'absolute', top: 10, left: 12, zIndex: 20, border: 'none', background: '#fff', boxShadow: '0 1px 6px rgba(0,0,0,.12)', borderRadius: 12, cursor: 'pointer', padding: 9 }}>
      <VGIcon name="menu" size={20} color="#374151" />
    </button>
  );

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#f6faff url(/ui/app-bg-v1.jpg) center/cover no-repeat', position: 'relative', overflow: 'hidden' }}>
      {open && !narrow && <Sidebar theme={theme} mode={mode} setMode={setMode} convs={convs} activeId={convId} user={user} narrow={false} clock={clock}
        onNew={() => { setActive(a => ({ ...a, [mode]: null })); setViewKey(k => k + 1); }} onSelect={id => { setActive(a => ({ ...a, [mode]: id })); setViewKey(k => k + 1); }}
        onDelete={id => { remove(mode, id); setActive(a => a[mode] === id ? { ...a, [mode]: null } : a); if (id === convId) setViewKey(k => k + 1); }} onClose={() => toggle(false)} />}
      {open && narrow && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 40, display: 'flex' }}>
          <Sidebar theme={theme} mode={mode} setMode={setMode} convs={convs} activeId={convId} user={user} narrow={true} clock={clock}
            onNew={() => { setActive(a => ({ ...a, [mode]: null })); setViewKey(k => k + 1); }} onSelect={id => { setActive(a => ({ ...a, [mode]: id })); setViewKey(k => k + 1); }}
            onDelete={id => { remove(mode, id); setActive(a => a[mode] === id ? { ...a, [mode]: null } : a); if (id === convId) setViewKey(k => k + 1); }} onClose={() => toggle(false)} />
          <div onClick={() => toggle(false)} style={{ flex: 1, background: 'rgba(15,20,25,.35)' }} />
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0, height: '100%', position: 'relative' }}>
      <main style={{ height: '100%', position: 'relative', overflowY: mode === 'video' ? 'auto' : 'hidden' }}>
        {menuBtn}
        {videoSeen && <div style={{ display: mode === 'video' && !locked ? 'block' : 'none' }}>{renderVideo({ embedded: true, injected, narrow, menuVisible: !open || narrow })}</div>}
        {mode === 'users' && user.role === 'admin' && (
          <div style={{ height: '100%', paddingTop: (!open || narrow) ? 56 : 0, boxSizing: 'border-box' }}>
            <iframe key={viewKey} title="Users and credits" src="/admin?embed=1" allow="clipboard-write" style={{ width: '100%', height: '100%', border: 0, display: 'block' }} />
          </div>
        )}
        {locked && (mode === 'chat' || mode === 'image' || mode === 'video') && <LockedPane theme={theme} menuVisible={!open || narrow} onLibrary={() => setMode('library')} />}
        {mode === 'library' && <LibraryPane key={viewKey} theme={theme} onUseImage={useImage} toast={toast} menuVisible={!open || narrow} />}
        {isConv && !locked && <ConversationView key={mode + viewKey} theme={theme} kind={mode} user={user}
              models={models ? (models.error ? { error: true } : models[mode]) : null} conv={conv} convId={convId} upsert={upsertActive}
              onUseScript={useScript} onUseImage={useImage} onDraw={drawThis} prefill={mode === 'image' ? prefill : null} toast={toast} narrow={narrow} />}
        {toastMsg && <div style={{ position: 'fixed', bottom: 90, left: '50%', transform: 'translateX(-50%)', zIndex: 60, background: '#0f1419', color: '#fff', padding: '11px 20px', borderRadius: 999, fontWeight: 700, fontSize: 14, boxShadow: '0 12px 32px rgba(0,0,0,.28)' }}>{toastMsg}</div>}
      </main>
      </div>
    </div>
  );
}

Object.assign(window, { AppShell });
