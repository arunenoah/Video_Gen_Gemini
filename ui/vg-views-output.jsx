/* ============================================================
   VideoGen for Kids — Output views: Style + Review + Library
   ============================================================ */

function vgEstimate(scenes, tier, res) {
  const seconds = scenes.reduce((a, s) => a + s.duration, 0);
  const cost = seconds * vgRate(tier.id, res.id);
  return { seconds, cost };
}

// ---------- STYLE VIEW ----------
function StyleView({ theme, scenes, tierId, setTierId, resId, setResId, styleId, setStyleId, voiceId, setVoiceId, musicId, setMusicId, goBack, goNext }) {
  const tier = VG_TIERS.find(t => t.id === tierId);
  const res = VG_RESOLUTIONS.find(r => r.id === resId);
  const est = vgEstimate(scenes, tier, res);

  const ChipGrid = ({ items, value, onPick, cols = 3 }) => (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols},1fr)`, gap: 9 }}>
      {items.map(it => {
        const on = value === it.id;
        return (
          <button key={it.id} onClick={() => onPick(it.id)} style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '11px 13px', borderRadius: 12, cursor: 'pointer',
            border: '2px solid ' + (on ? theme.primary : '#e5e7eb'), background: on ? theme.tint : '#fff',
            fontFamily: "'Instrument Sans',sans-serif", fontWeight: 600, fontSize: 13.5, color: on ? theme.primaryDark : '#374151',
            transition: 'all .15s',
          }}>
            <VGIcon name={it.icon} size={17} color={on ? theme.primary : '#9ca3af'} />{it.label}
          </button>
        );
      })}
    </div>
  );

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', display: 'grid', gridTemplateColumns: '1.55fr 1fr', gap: 26, alignItems: 'start' }}>
      <div style={{ display: 'grid', gap: 24 }}>
        {/* tiers */}
        <section>
          <VGOverline style={{ marginBottom: 11 }}>Quality tier</VGOverline>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            {VG_TIERS.map(t => {
              const on = tierId === t.id;
              return (
                <VGCard key={t.id} theme={theme} hover active={on} onClick={() => setTierId(t.id)} style={{ padding: '16px 14px', position: 'relative', textAlign: 'center' }}>
                  {t.popular && <div style={{ position: 'absolute', top: -10, left: '50%', transform: 'translateX(-50%)', background: theme.primary, color: '#fff', fontSize: 10.5, fontWeight: 800, padding: '3px 10px', borderRadius: 999, letterSpacing: '0.03em', whiteSpace: 'nowrap' }}>★ {t.tag}</div>}
                  <div style={{ display: 'flex', justifyContent: 'center', color: on ? theme.primary : '#9ca3af' }}><VGIcon name={t.icon} size={26} /></div>
                  <div style={{ fontWeight: 800, fontSize: 16, color: '#0f1419', marginTop: 6, fontFamily: "'Inter',sans-serif" }}>{t.name}</div>
                  {!t.popular && <div style={{ fontSize: 11.5, color: '#9ca3af', fontWeight: 600 }}>{t.tag}</div>}
                  <div style={{ fontSize: 13, color: theme.primaryDark, fontWeight: 700, marginTop: 6 }}>${(t.perSec).toFixed(3)}<span style={{ color: '#9ca3af', fontWeight: 600 }}>/sec</span></div>
                  <div style={{ fontSize: 11.5, color: '#6b7280', marginTop: 8, lineHeight: 1.4 }}>{t.blurb}</div>
                </VGCard>
              );
            })}
          </div>
        </section>

        {/* resolution */}
        <section>
          <VGOverline style={{ marginBottom: 11 }}>Resolution</VGOverline>
          <div style={{ display: 'flex', gap: 10 }}>
            {VG_RESOLUTIONS.map(r => {
              const on = resId === r.id;
              return (
                <button key={r.id} onClick={() => setResId(r.id)} style={{
                  flex: 1, padding: '13px', borderRadius: 12, cursor: 'pointer', textAlign: 'center',
                  border: '2px solid ' + (on ? theme.primary : '#e5e7eb'), background: on ? theme.tint : '#fff',
                  fontFamily: "'Instrument Sans',sans-serif", transition: 'all .15s',
                }}>
                  <div style={{ fontWeight: 800, fontSize: 16, color: on ? theme.primaryDark : '#0f1419' }}>{r.label}</div>
                  <div style={{ fontSize: 11.5, color: '#9ca3af', fontWeight: 600, marginTop: 2 }}>{r.note}{r.mult > 1 ? ` · ${r.mult}×` : ''}</div>
                </button>
              );
            })}
          </div>
        </section>

        {/* art style */}
        <section>
          <VGOverline style={{ marginBottom: 11 }}>Art style</VGOverline>
          <ChipGrid items={VG_STYLES} value={styleId} onPick={setStyleId} cols={3} />
        </section>

        {/* audio */}
        <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          <div>
            <VGOverline style={{ marginBottom: 11 }}>Narration voice</VGOverline>
            <ChipGrid items={VG_VOICES} value={voiceId} onPick={setVoiceId} cols={1} />
          </div>
          <div>
            <VGOverline style={{ marginBottom: 11 }}>Music vibe</VGOverline>
            <ChipGrid items={VG_MUSIC} value={musicId} onPick={setMusicId} cols={1} />
          </div>
        </section>
      </div>

      {/* sticky cost rail */}
      <div style={{ position: 'sticky', top: 18 }}>
        <VGCard theme={theme} style={{ padding: 20, background: theme.tint, border: '1.5px solid ' + theme.primary + '33' }}>
          <VGOverline>Estimated cost</VGOverline>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 6 }}>
            <span style={{ fontFamily: "'Inter',sans-serif", fontWeight: 800, fontSize: 40, color: theme.primaryDark, letterSpacing: '-1px' }}>{vgMoney(est.cost)}</span>
          </div>
          <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>{scenes.length} scenes · {est.seconds}s of video</div>
          <div style={{ height: 1, background: theme.primary + '22', margin: '16px 0' }} />
          <div style={{ display: 'grid', gap: 9, fontSize: 13.5 }}>
            {[
              ['Tier', VG_TIERS.find(t => t.id === tierId).name],
              ['Resolution', VG_RESOLUTIONS.find(r => r.id === resId).label],
              ['Art style', (VG_STYLES.find(s => s.id === styleId) || {}).label],
              ['Voice', (VG_VOICES.find(v => v.id === voiceId) || {}).label],
              ['Music', (VG_MUSIC.find(m => m.id === musicId) || {}).label],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#6b7280' }}>{k}</span>
                <span style={{ fontWeight: 700, color: '#374151' }}>{v}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 18 }}><VGButton theme={theme} full onClick={goNext}>Review & generate →</VGButton></div>
          <button onClick={goBack} style={{ width: '100%', marginTop: 10, background: 'transparent', border: 'none', color: theme.primaryDark, fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: "'Instrument Sans',sans-serif" }}>← Back to scenes</button>
        </VGCard>
        <div style={{ fontSize: 12, color: '#9ca3af', lineHeight: 1.5, marginTop: 12, padding: '0 4px' }}>
          Every tier includes native audio — voices and ambience. Generation takes about 1–6 min per clip.
        </div>
      </div>
    </div>
  );
}

// ---------- REVIEW VIEW ----------
function ReviewView({ theme, mode, scenes, tierId, resId, styleId, voiceId, musicId, onGenerate, generating, progress, goBack }) {
  const tier = VG_TIERS.find(t => t.id === tierId);
  const res = VG_RESOLUTIONS.find(r => r.id === resId);
  const est = vgEstimate(scenes, tier, res);
  const st = VG_STYLES.find(s => s.id === styleId) || {};
  const vc = VG_VOICES.find(v => v.id === voiceId) || {};
  const mu = VG_MUSIC.find(m => m.id === musicId) || {};

  return (
    <div style={{ maxWidth: 820, margin: '0 auto', display: 'grid', gap: 20 }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontFamily: "'Inter',sans-serif", fontWeight: 800, fontSize: 24, color: '#0f1419' }}>Ready to roll?</div>
        <div style={{ fontSize: 14, color: '#6b7280', marginTop: 4 }}>Here’s everything we’ll generate, then stitch into one movie.</div>
      </div>

      {/* settings summary chips */}
      <VGCard theme={theme} style={{ padding: 16, display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
        {[
          [mode === 'story' ? 'layers' : 'video', mode === 'story' ? 'Story' : 'Single clip'],
          ['clapper', `${scenes.length} scenes`],
          ['clock', `${est.seconds}s`],
          [tier.icon, tier.name],
          ['monitor', res.label],
          [st.icon, st.label],
          [vc.icon, vc.label],
          [mu.icon, mu.label],
        ].map(([ic, l], i) => <VGPill key={i} color={theme.primaryDark} bg={theme.tint}><VGIcon name={ic} size={13} />{l}</VGPill>)}
      </VGCard>

      {/* per-scene breakdown */}
      <VGCard theme={theme} style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '13px 18px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', fontSize: 12.5, fontWeight: 700, color: '#9ca3af', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          <span>Scene</span><span>Length · Cost</span>
        </div>
        {scenes.map((s, i) => (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px', borderBottom: i < scenes.length - 1 ? '1px solid #f6f7f8' : 'none' }}>
            <div style={{ width: 26, height: 26, borderRadius: 999, background: s.accent.solid, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 12.5, flexShrink: 0 }}>{i + 1}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: '#0f1419', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.title}</div>
              <div style={{ fontSize: 12, color: '#9ca3af', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.body.split('\n')[0] || '—'}</div>
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>{s.duration}s</div>
              <div style={{ fontSize: 12, color: theme.primaryDark, fontWeight: 600 }}>{vgMoney(s.duration * vgRate(tierId, resId))}</div>
            </div>
          </div>
        ))}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', background: theme.tint }}>
          <span style={{ fontWeight: 700, color: '#374151' }}>Total — {scenes.length} clips + 1 stitch</span>
          <span style={{ fontFamily: "'Inter',sans-serif", fontWeight: 800, fontSize: 22, color: theme.primaryDark }}>{vgMoney(est.cost)}</span>
        </div>
      </VGCard>

      {/* generate */}
      {generating ? (
        <VGCard theme={theme} style={{ padding: 22 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <div className="vg-spin" style={{ width: 20, height: 20, border: '3px solid ' + theme.primaryLight, borderTopColor: theme.primary, borderRadius: 999 }} />
            <div style={{ fontWeight: 700, fontSize: 15, color: '#0f1419' }}>{progress.label}</div>
            <div style={{ marginLeft: 'auto', fontWeight: 700, color: theme.primaryDark }}>{Math.round(progress.pct)}%</div>
          </div>
          <div style={{ height: 10, borderRadius: 999, background: '#eef0f2', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: progress.pct + '%', background: theme.hero, borderRadius: 999, transition: 'width .4s ease' }} />
          </div>
          <div style={{ fontSize: 12.5, color: '#9ca3af', marginTop: 10 }}>Generating scene {progress.scene} of {scenes.length}. You can keep this tab open — finished clips land in your Library.</div>
        </VGCard>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
          <VGButton theme={theme} variant="ghost" onClick={goBack}>← Style</VGButton>
          <VGButton theme={theme} size="lg" onClick={onGenerate} style={{ flex: 1, maxWidth: 460 }}>
            <VGIcon name="play" size={15} color="#fff" /> Generate {mode === 'story' ? 'story' : 'clip'} {mode === 'story' ? '(all scenes + stitch)' : ''}
          </VGButton>
        </div>
      )}
    </div>
  );
}

// ---------- LIBRARY VIEW ----------
function LibraryView({ theme, generations, clipsByStory = {}, selected, toggleSelect, onStitch, onResume, onUseScript, onNew }) {
  const totalSec = generations.reduce((a, g) => a + g.seconds, 0);
  const totalCost = generations.reduce((a, g) => a + g.cost, 0);
  const [openId, setOpenId] = React.useState(null);

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto' }}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        {[
          ['film', generations.length, generations.length === 1 ? 'movie' : 'movies'],
          ['clock', totalSec + 's', 'of video'],
          ['dollar', vgMoney(totalCost), 'spent'],
        ].map(([ic, big, small], i) => (
          <VGCard key={i} theme={theme} style={{ padding: '14px 18px', flex: 1, minWidth: 150, display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 11, background: theme.tint, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.primary, flexShrink: 0 }}><VGIcon name={ic} size={20} /></div>
            <div>
              <div style={{ fontFamily: "'Inter',sans-serif", fontWeight: 800, fontSize: 20, color: '#0f1419' }}>{big}</div>
              <div style={{ fontSize: 12.5, color: '#9ca3af' }}>{small}</div>
            </div>
          </VGCard>
        ))}
      </div>

      {generations.length === 0 ? (
        <VGCard theme={theme} style={{ padding: '60px 24px', textAlign: 'center' }}>
          <div style={{ color: theme.primary, display: 'flex', justifyContent: 'center' }}><VGIcon name="film" size={52} stroke={1.5} /></div>
          <div style={{ fontFamily: "'Inter',sans-serif", fontWeight: 800, fontSize: 22, color: '#0f1419', marginTop: 12 }}>No movies yet</div>
          <div style={{ fontSize: 14.5, color: '#6b7280', marginTop: 6, maxWidth: 380, marginLeft: 'auto', marginRight: 'auto' }}>Write a story, build your storyboard, and hit Generate. Your finished clips will play here.</div>
          <div style={{ marginTop: 20 }}><VGButton theme={theme} onClick={onNew}><VGIcon name="pencil" size={15} />Start a story</VGButton></div>
        </VGCard>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <div style={{ fontFamily: "'Inter',sans-serif", fontWeight: 800, fontSize: 20, color: '#0f1419' }}>Your movies</div>
            <VGButton theme={theme} variant="soft" size="sm" onClick={onStitch} disabled={selected.length < 2}><VGIcon name="stitch" size={14} />Stitch selected ({selected.length})</VGButton>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 16 }}>
            {generations.map(g => {
              const on = selected.includes(g.id);
              return (
                <VGCard key={g.id} theme={theme} hover active={on} style={{ padding: 0, overflow: 'hidden' }}>
                  <div style={{ position: 'relative' }}>
                    <div onClick={() => setOpenId(g.id)}
                      style={{ aspectRatio: '16/9', cursor: 'pointer', background: g.thumb ? '#000' : `linear-gradient(135deg, ${g.accent.bg}, #fff 140%)`, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}
                      title={g.kind === 'script' ? 'Read script' : 'Play movie'}>
                      {g.thumb
                        ? <img src={g.thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        : <div style={{ color: g.accent.fg, opacity: 0.85 }}><VGIcon name={g.kind === 'script' ? 'book' : (g.styleIcon || 'film')} size={38} stroke={1.6} /></div>}
                      {g.kind !== 'script' && (
                        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                          <div style={{ width: 48, height: 48, borderRadius: 999, background: 'rgba(255,255,255,0.92)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 14px rgba(0,0,0,0.25)' }}>
                            <div style={{ width: 0, height: 0, borderLeft: '15px solid ' + theme.primary, borderTop: '9px solid transparent', borderBottom: '9px solid transparent', marginLeft: 4 }} />
                          </div>
                        </div>
                      )}
                      {g.kind !== 'script' && <div style={{ position: 'absolute', bottom: 8, right: 8, background: 'rgba(15,20,25,0.78)', color: '#fff', fontSize: 11.5, fontWeight: 700, padding: '3px 8px', borderRadius: 6 }}>{g.seconds}s</div>}
                      {g.kind !== 'script' && <button onClick={e => { e.stopPropagation(); toggleSelect(g.id); }} style={{ position: 'absolute', top: 8, left: 8, width: 24, height: 24, borderRadius: 7, border: '2px solid #fff', background: on ? theme.primary : 'rgba(15,20,25,0.35)', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800 }}>{on ? '✓' : ''}</button>}
                    </div>
                  </div>
                  <div style={{ padding: 14 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
                      {g.kind === 'script'
                        ? <VGPill color={theme.primaryDark} bg={theme.tint}><VGIcon name="book" size={12} />Script — {g.sceneCount} scenes</VGPill>
                        : g.status === 'partial'
                          ? <VGPill color="#b45309" bg="#fef3c7"><VGIcon name="clock" size={12} />Partial — {g.pendingCount} scene{g.pendingCount === 1 ? '' : 's'} pending</VGPill>
                          : <VGPill color="#15803d" bg="#dcfce7"><VGIcon name="check" size={12} />Ready</VGPill>}
                      <span style={{ fontSize: 12, color: '#9ca3af' }}>{g.kind === 'script' ? 'Haiku' : `${g.tier} · ${g.res}`}</span>
                    </div>
                    <div style={{ fontWeight: 700, fontSize: 14.5, color: '#0f1419', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.title}</div>
                    <div style={{ fontSize: 12.5, color: '#9ca3af', marginTop: 3 }}>{g.sceneCount} clips · {g.when} · {vgMoney(g.cost)}</div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {(clipsByStory[g.id] || []).length > 0 && (
                        <button onClick={() => setOpenId(g.id)} style={{
                          marginTop: 9, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px',
                          borderRadius: 999, border: '1.5px solid #e5e7eb', background: '#fff', cursor: 'pointer',
                          fontFamily: "'Instrument Sans',sans-serif", fontWeight: 700, fontSize: 12.5, color: '#374151',
                        }}>
                          <VGIcon name="layers" size={13} color={theme.primary} />
                          View {clipsByStory[g.id].length} clips & images
                        </button>
                      )}
                      {g.status === 'partial' && onResume && (
                        <button onClick={() => onResume(g.id)} style={{
                          marginTop: 9, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px',
                          borderRadius: 999, border: 'none', background: theme.primary, color: '#fff', cursor: 'pointer',
                          fontFamily: "'Instrument Sans',sans-serif", fontWeight: 700, fontSize: 12.5, boxShadow: theme.glow,
                        }}>
                          <VGIcon name="refresh" size={13} color="#fff" />
                          Generate remaining {g.pendingCount}
                        </button>
                      )}
                      {g.kind === 'script' && onUseScript && (
                        <button onClick={() => onUseScript(g)} style={{
                          marginTop: 9, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px',
                          borderRadius: 999, border: 'none', background: theme.primary, color: '#fff', cursor: 'pointer',
                          fontFamily: "'Instrument Sans',sans-serif", fontWeight: 700, fontSize: 12.5, boxShadow: theme.glow,
                        }}>
                          <VGIcon name="video" size={13} color="#fff" />
                          Make this video
                        </button>
                      )}
                    </div>
                  </div>
                </VGCard>
              );
            })}
          </div>
        </>
      )}
      {openId && (() => {
        const g = generations.find(x => x.id === openId);
        return g ? <LibraryDrawer theme={theme} gen={g} clips={clipsByStory[g.id] || []} onClose={() => setOpenId(null)} /> : null;
      })()}
    </div>
  );
}

// ---------- LIBRARY DRAWER (right pane: player + story + clips + source images) ----------
function DrawerSection({ theme, title, count, defaultOpen, children }) {
  const [open, setOpen] = React.useState(!!defaultOpen);
  return (
    <div style={{ border: '1.5px solid #eef0f2', borderRadius: 12, overflow: 'hidden', flexShrink: 0 }}>
      <button onClick={() => setOpen(o => !o)} style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '11px 14px',
        border: 'none', background: open ? theme.tint : '#fafbfc', cursor: 'pointer',
        fontFamily: "'Instrument Sans',sans-serif", fontWeight: 700, fontSize: 13,
        color: open ? theme.primaryDark : '#374151', textAlign: 'left',
      }}>
        <VGIcon name={open ? 'chevron-up' : 'chevron-down'} size={14} />
        {title}
        {count != null && <span style={{ fontWeight: 600, color: '#9ca3af' }}>({count})</span>}
      </button>
      {open && <div style={{ padding: 12 }}>{children}</div>}
    </div>
  );
}

function LibraryDrawer({ theme, gen, clips, onClose }) {
  const [active, setActive] = React.useState({ id: gen.id, url: gen.clipUrl, title: gen.title, seconds: gen.seconds });
  const allImages = [
    ...(gen.images || []).map((u, i) => ({ u, from: clips.length ? 'Story' : 'Start frame' })),
    ...clips.flatMap((c, i) => (c.images || []).map(u => ({ u, from: `Scene ${i + 1}` }))),
  ];
  const scripts = clips.length
    ? clips.map((c, i) => ({ label: c.title || `Scene ${i + 1}`, text: c.prompt }))
    : [{ label: gen.title, text: gen.prompt }];
  React.useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    // lock the page behind the drawer — wheel events stay inside the pane
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, []);
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,20,25,0.38)', zIndex: 65, backdropFilter: 'blur(2px)' }} />
      <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, height: '100vh', width: 'min(760px, 94vw)', background: '#fff', zIndex: 70, boxShadow: '-16px 0 48px rgba(0,0,0,0.20)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid #eef0f2' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: "'Inter',sans-serif", fontWeight: 800, fontSize: 16, color: '#0f1419', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{gen.title}</div>
            <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 1 }}>{gen.seconds}s · {gen.tier} · {gen.res} · {vgMoney(gen.cost)}{gen.costNote ? ` (${gen.costNote})` : ''}</div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ width: 32, height: 32, borderRadius: 999, border: '1.5px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 16, color: '#6b7280', lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch', padding: 18, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {gen.kind !== 'script' && (
            <div style={{ flexShrink: 0 }}>
              <video key={active.url} src={active.url} controls autoPlay playsInline
                style={{ width: '100%', borderRadius: 12, background: '#000', display: 'block' }} />
              <div style={{ fontSize: 12.5, color: '#6b7280', marginTop: 7, display: 'flex', alignItems: 'center', gap: 6 }}>
                <VGIcon name="play" size={11} color={theme.primary} />
                Now playing: <strong style={{ color: '#374151' }}>{active.title}</strong>
              </div>
            </div>
          )}
          {gen.kind === 'script' && (
            <div style={{ flexShrink: 0, fontSize: 13, lineHeight: 1.7, color: '#374151', whiteSpace: 'pre-wrap',
              background: '#fafbfc', border: '1px solid #f3f4f6', borderRadius: 12, padding: '14px 16px' }}>{gen.scriptText}</div>
          )}

          {clips.length > 0 && (
            <DrawerSection theme={theme} title="Clips in this movie" count={clips.length} defaultOpen>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div onClick={() => setActive({ id: gen.id, url: gen.clipUrl, title: gen.title, seconds: gen.seconds })}
                  style={rowStyle(active.id === gen.id, theme)}>
                  <div style={thumbBox}>{gen.thumb ? <img src={gen.thumb} alt="" style={thumbImg} /> : <VGIcon name="film" size={16} color={theme.primary} />}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={rowTitle}>▶ Full movie</div>
                    <div style={rowSub}>{gen.seconds}s</div>
                  </div>
                </div>
                {clips.map((c, i) => (
                  <div key={c.id} onClick={() => setActive({ id: c.id, url: c.clipUrl, title: c.title, seconds: c.seconds })}
                    style={rowStyle(active.id === c.id, theme)}>
                    <div style={{ ...thumbBox, background: c.accent.bg }}>
                      {c.thumb ? <img src={c.thumb} alt="" style={thumbImg} /> : <VGIcon name="film" size={16} color={c.accent.fg} />}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={rowTitle}>{c.title}</div>
                      <div style={rowSub}>{c.seconds}s · {vgMoney(c.cost)}</div>
                    </div>
                    <VGIcon name="play" size={13} color={active.id === c.id ? theme.primary : '#c4c9cf'} />
                  </div>
                ))}
              </div>
            </DrawerSection>
          )}

          <DrawerSection theme={theme} title="Story script & prompts" count={scripts.length} defaultOpen={!clips.length}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {scripts.map((s, i) => (
                <div key={i}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: theme.primaryDark, marginBottom: 4 }}>
                    {clips.length ? `${i + 1}. ` : ''}{s.label}
                  </div>
                  <div style={{ fontSize: 12, lineHeight: 1.6, color: '#4b5563', whiteSpace: 'pre-wrap',
                    background: '#fafbfc', border: '1px solid #f3f4f6', borderRadius: 9, padding: '9px 11px',
                    maxHeight: 180, overflowY: 'auto' }}>{s.text || '—'}</div>
                </div>
              ))}
            </div>
          </DrawerSection>

          {allImages.length > 0 && (
            <DrawerSection theme={theme} title="Images used" count={allImages.length}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
                {allImages.map((im, i) => (
                  <div key={i} onClick={() => window.open(im.u, '_blank')} title="Open full size"
                    style={{ position: 'relative', borderRadius: 9, overflow: 'hidden', cursor: 'pointer', aspectRatio: '16/10', background: '#f3f4f6' }}>
                    <img src={im.u} alt={im.from} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                    <div style={{ position: 'absolute', bottom: 4, left: 4, background: 'rgba(15,20,25,0.72)', color: '#fff', fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 999 }}>{im.from}</div>
                  </div>
                ))}
              </div>
            </DrawerSection>
          )}
        </div>
      </div>
    </>
  );
}
function rowStyle(on, theme) {
  return { display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer', borderRadius: 10, padding: '6px 8px',
           background: on ? theme.tint : 'transparent', border: '1.5px solid ' + (on ? theme.primary + '44' : 'transparent'), transition: 'all .12s' };
}
const thumbBox = { width: 58, height: 36, borderRadius: 6, overflow: 'hidden', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f3f4f6' };
const thumbImg = { width: '100%', height: '100%', objectFit: 'cover' };
const rowTitle = { fontSize: 12.5, fontWeight: 700, color: '#374151', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const rowSub = { fontSize: 11, color: '#9ca3af' };

Object.assign(window, { StyleView, ReviewView, LibraryView, LibraryDrawer, vgEstimate });
