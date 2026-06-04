/* ============================================================
   VideoGen for Kids — Input views: Script + Scenes
   ============================================================ */

// ---------- SCRIPT VIEW ----------
function ScriptView({ theme, mode, setMode, script, setScript, scenes, onEnhance, enhancing, onImages, goNext }) {
  const fileRef = React.useRef(null);
  const [drag, setDrag] = React.useState(false);
  const totalDur = scenes.reduce((a, s) => a + s.duration, 0);

  function applyTemplate(t) { setScript(t.script); }
  function handleFiles(files) { if (files && files.length && onImages) onImages(files); }

  return (
    <div style={{ maxWidth: 880, margin: '0 auto', display: 'grid', gap: 22 }}>
      {/* mode toggle */}
      <div>
        <VGOverline style={{ marginBottom: 10 }}>What are we making?</VGOverline>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {[
            { id: 'single', icon: 'video', t: 'Single clip', d: 'One scene, one short video.' },
            { id: 'story', icon: 'layers', t: 'Story', d: 'Script → many clips → one stitched movie.' },
          ].map(m => (
            <VGCard key={m.id} theme={theme} hover active={mode === m.id} onClick={() => setMode(m.id)} style={{ padding: 16, display: 'flex', gap: 13, alignItems: 'center' }}>
              <div style={{ width: 46, height: 46, borderRadius: 13, background: mode === m.id ? theme.hero : '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <VGIcon name={m.icon} size={22} color={mode === m.id ? '#fff' : '#6b7280'} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 15.5, color: '#0f1419' }}>{m.t}</div>
                <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>{m.d}</div>
              </div>
            </VGCard>
          ))}
        </div>
      </div>

      {/* templates */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <VGOverline>Start from a spark</VGOverline>
          <span style={{ fontSize: 12.5, color: '#9ca3af' }}>or write your own below</span>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {VG_TEMPLATES.map(t => (
            <button key={t.title} onClick={() => applyTemplate(t)} style={{
              display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 15px', borderRadius: 999,
              border: '1.5px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontFamily: "'Instrument Sans',sans-serif",
              fontWeight: 600, fontSize: 13.5, color: '#374151',
            }}>
              <VGIcon name={t.icon} size={17} color={theme.primary} />{t.title}
            </button>
          ))}
        </div>
      </div>

      {/* script editor */}
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
          <label style={{ fontSize: 14, fontWeight: 700, color: '#374151' }}>
            {mode === 'story' ? 'Your story script' : 'Your clip prompt'}
          </label>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>
            {mode === 'story' ? 'New scenes start on “Clip N”, “Scene N”, or “---”' : 'Describe the shot, mood and any dialogue'}
          </span>
        </div>
        <div style={{ position: 'relative' }}>
          <textarea value={script} onChange={e => setScript(e.target.value)} spellCheck={false}
            placeholder={'Clip 1 — A sunny meadow\nA fluffy fox pokes its head out of a burrow...\nDialogue:\nFox: "Good morning, world!"'}
            style={{
              width: '100%', minHeight: 260, resize: 'vertical', boxSizing: 'border-box',
              padding: '16px 18px', borderRadius: 16, border: '2px solid #e5e7eb', outline: 'none',
              fontFamily: "'Instrument Sans',sans-serif", fontSize: 14.5, lineHeight: 1.65, color: '#1a1a1a',
              background: '#fff', transition: 'border .15s, box-shadow .15s',
            }}
            onFocus={e => { e.target.style.borderColor = theme.primary; e.target.style.boxShadow = '0 0 0 4px ' + theme.ring; }}
            onBlur={e => { e.target.style.borderColor = '#e5e7eb'; e.target.style.boxShadow = 'none'; }}
          />
          <button onClick={onEnhance} disabled={enhancing || !script.trim()} style={{
            position: 'absolute', right: 12, bottom: 12, display: 'inline-flex', alignItems: 'center', gap: 7,
            padding: '8px 14px', borderRadius: 999, border: 'none', cursor: script.trim() ? 'pointer' : 'not-allowed',
            background: '#0f1419', color: '#fff', fontFamily: "'Instrument Sans',sans-serif", fontWeight: 700, fontSize: 13,
            opacity: enhancing || !script.trim() ? 0.6 : 1, boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
          }}><VGIcon name="wand" size={15} color="#fff" />{enhancing ? 'Polishing…' : 'Enhance with Haiku'}</button>
        </div>
      </div>

      {/* quick image drop (auto-map) */}
      {mode === 'story' && (
        <div
          onDragOver={e => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); handleFiles(e.dataTransfer.files); }}
          onClick={() => fileRef.current && fileRef.current.click()}
          style={{
            border: '2px dashed ' + (drag ? theme.primary : '#d1d5db'), borderRadius: 16, padding: '20px',
            display: 'flex', alignItems: 'center', gap: 14, cursor: 'pointer',
            background: drag ? theme.tint : '#fafafa', transition: 'all .15s',
          }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, color: '#9ca3af' }}><VGIcon name="image" size={24} /></div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, color: '#374151' }}>Add reference images (optional)</div>
            <div style={{ fontSize: 12.5, color: '#9ca3af', marginTop: 2 }}>Drop a few — they’ll map to scenes in order. Fine-tune each one on the Scenes tab.</div>
          </div>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" multiple style={{ display: 'none' }}
            onChange={e => { handleFiles(e.target.files); e.target.value = ''; }} />
        </div>
      )}

      {/* live summary + next */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, paddingTop: 4 }}>
        <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
          <VGPill color={theme.primaryDark} bg={theme.tint}><VGIcon name="clapper" size={13} />{scenes.length} {scenes.length === 1 ? 'scene' : 'scenes'}</VGPill>
          <VGPill><VGIcon name="clock" size={13} />~{totalDur}s</VGPill>
          <VGPill><VGIcon name="message" size={13} />{scenes.reduce((a, s) => a + s.dialogue.length, 0)} lines</VGPill>
        </div>
        <VGButton theme={theme} onClick={goNext} size="lg" disabled={!scenes.length}>Next: Scenes →</VGButton>
      </div>
    </div>
  );
}

// ---------- ONE STORYBOARD SCENE CARD ----------
function SceneCard({ scene, theme, idx, count, layout, onChange, onMove, onDelete, onImage }) {
  const fileRef = React.useRef(null);
  const a = scene.accent;
  const horizontal = layout === 'list';

  function pickImage(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    vgReadImage(f).then(src => onImage(scene.id, src)).catch(err => alert(err.message));
    e.target.value = '';
  }

  const thumb = (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <VGThumb accent={a} label={scene.image ? null : 'Drop image'} src={scene.image}
        style={{ width: horizontal ? 168 : '100%', height: horizontal ? 112 : 150, cursor: 'pointer' }} />
      <button onClick={() => fileRef.current && fileRef.current.click()} style={{
        position: 'absolute', right: 8, bottom: 8, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 999, border: 'none',
        background: 'rgba(15,20,25,0.78)', color: '#fff', fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
        fontFamily: "'Instrument Sans',sans-serif", backdropFilter: 'blur(4px)',
      }}><VGIcon name={scene.image ? 'refresh' : 'plus'} size={12} color="#fff" />{scene.image ? 'Replace' : 'Image'}</button>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={pickImage} style={{ display: 'none' }} />
      <div style={{ position: 'absolute', top: 8, left: 8, width: 26, height: 26, borderRadius: 999, background: a.solid, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 13, boxShadow: '0 2px 6px rgba(0,0,0,0.25)' }}>{idx + 1}</div>
    </div>
  );

  const body = (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 9 }}>
      <input value={scene.title} onChange={e => onChange(scene.id, { title: e.target.value })}
        style={{ border: 'none', outline: 'none', fontFamily: "'Inter',sans-serif", fontWeight: 700, fontSize: 16, color: '#0f1419', background: 'transparent', padding: 0, width: '100%' }} />
      <textarea value={scene.body} onChange={e => onChange(scene.id, { body: e.target.value })} rows={horizontal ? 2 : 3}
        placeholder="Describe the shot…"
        style={{ border: '1.5px solid #eef0f2', borderRadius: 10, padding: '9px 11px', outline: 'none', resize: 'vertical',
          fontFamily: "'Instrument Sans',sans-serif", fontSize: 13.5, lineHeight: 1.55, color: '#374151', background: '#fafbfc' }}
        onFocus={e => e.target.style.borderColor = theme.primary} onBlur={e => e.target.style.borderColor = '#eef0f2'} />
      {scene.dialogue.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {scene.dialogue.map((d, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 7, fontSize: 13, lineHeight: 1.4 }}>
              <span style={{ fontWeight: 700, color: a.fg, flexShrink: 0 }}>{d.who}:</span>
              <span style={{ color: '#4b5563' }}>“{d.line}”</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#f3f4f6', borderRadius: 999, padding: '3px 5px' }} title="Veo clips are 4, 6 or 8 seconds">
          <button onClick={() => onChange(scene.id, { duration: VG_DURATIONS[Math.max(0, VG_DURATIONS.indexOf(scene.duration) - 1)] })} style={durBtn}>–</button>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: '#374151', minWidth: 30, textAlign: 'center' }}>{scene.duration}s</span>
          <button onClick={() => onChange(scene.id, { duration: VG_DURATIONS[Math.min(VG_DURATIONS.length - 1, VG_DURATIONS.indexOf(scene.duration) + 1)] })} style={durBtn}>+</button>
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={() => onMove(idx, -1)} disabled={idx === 0} style={moveBtn(idx === 0)} title="Move up"><VGIcon name="chevron-up" size={15} /></button>
        <button onClick={() => onMove(idx, 1)} disabled={idx === count - 1} style={moveBtn(idx === count - 1)} title="Move down"><VGIcon name="chevron-down" size={15} /></button>
        <button onClick={() => onDelete(scene.id)} style={{ ...moveBtn(false), color: '#dc2626' }} title="Delete scene"><VGIcon name="trash" size={14} /></button>
      </div>
    </div>
  );

  return (
    <VGCard theme={theme} style={{ padding: 14, display: 'flex', flexDirection: horizontal ? 'row' : 'column', gap: 14 }}>
      {thumb}{body}
    </VGCard>
  );
}
const VG_DURATIONS = [4, 6, 8]; // the only clip lengths Veo supports
const durBtn = { width: 24, height: 24, borderRadius: 999, border: 'none', background: '#fff', cursor: 'pointer', fontWeight: 800, fontSize: 15, color: '#374151', lineHeight: 1 };
function moveBtn(dis) { return { width: 30, height: 30, borderRadius: 9, border: '1.5px solid #e5e7eb', background: '#fff', cursor: dis ? 'not-allowed' : 'pointer', color: '#6b7280', opacity: dis ? 0.4 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }; }

// ---------- SCENES VIEW ----------
function ScenesView({ theme, scenes, layout, onChange, onMove, onDelete, onImage, onAdd, goBack, goNext }) {
  const totalDur = scenes.reduce((a, s) => a + s.duration, 0);
  if (!scenes.length) {
    return (
      <div style={{ maxWidth: 560, margin: '40px auto', textAlign: 'center' }}>
        <div style={{ color: theme.primary, display: 'flex', justifyContent: 'center' }}><VGIcon name="clapper" size={48} stroke={1.6} /></div>
        <div style={{ fontFamily: "'Inter',sans-serif", fontWeight: 800, fontSize: 22, color: '#0f1419', marginTop: 12 }}>No scenes yet</div>
        <div style={{ fontSize: 14.5, color: '#6b7280', marginTop: 6 }}>Head back to the Script tab and write or pick a story — your scenes will show up here as a storyboard.</div>
        <div style={{ marginTop: 20 }}><VGButton theme={theme} onClick={goBack} variant="soft">← Back to Script</VGButton></div>
      </div>
    );
  }
  return (
    <div style={{ maxWidth: layout === 'list' ? 820 : 1080, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 18 }}>
        <div>
          <div style={{ fontFamily: "'Inter',sans-serif", fontWeight: 800, fontSize: 22, color: '#0f1419' }}>Your storyboard</div>
          <div style={{ fontSize: 13.5, color: '#6b7280', marginTop: 2 }}>{scenes.length} scenes · ~{totalDur}s total · tap any text to edit, drop an image per scene</div>
        </div>
        <VGButton theme={theme} variant="soft" onClick={onAdd}><VGIcon name="plus" size={15} />Add scene</VGButton>
      </div>
      <div style={layout === 'list'
        ? { display: 'flex', flexDirection: 'column', gap: 14 }
        : { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: 16 }}>
        {scenes.map((s, i) => (
          <SceneCard key={s.id} scene={s} theme={theme} idx={i} count={scenes.length} layout={layout}
            onChange={onChange} onMove={onMove} onDelete={onDelete} onImage={onImage} />
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24 }}>
        <VGButton theme={theme} variant="ghost" onClick={goBack}>← Script</VGButton>
        <VGButton theme={theme} size="lg" onClick={goNext}>Next: Style →</VGButton>
      </div>
    </div>
  );
}

Object.assign(window, { ScriptView, ScenesView, SceneCard });
