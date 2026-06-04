/* ============================================================
   VideoGen for Kids — Core: themes, data, primitives
   Bright, playful, kid-friendly twist on the SettleiX system.
   ============================================================ */

// ---------- THEMES (color dimension) ----------
const VG_THEMES = {
  ocean: {
    name: 'Ocean',
    primary: '#177bb5', primaryDark: '#0d5a96', primaryLight: '#e3f2fd',
    accent: '#00d9ff',
    logo: 'linear-gradient(135deg,#34d399 0%,#14b8a6 45%,#177bb5 100%)',
    hero: 'linear-gradient(135deg,#177bb5 0%,#00d9ff 100%)',
    page: 'linear-gradient(180deg,#eff6ff 0%,#f9fafb 240px,#f9fafb 100%)',
    tint: '#eff6ff', ring: 'rgba(23,123,181,0.16)',
    glow: '0 10px 28px rgba(23,123,181,0.30)',
  },
  sunset: {
    name: 'Sunset',
    primary: '#f97316', primaryDark: '#ea580c', primaryLight: '#ffedd5',
    accent: '#fbbf24',
    logo: 'linear-gradient(135deg,#fbbf24 0%,#fb7185 50%,#f97316 100%)',
    hero: 'linear-gradient(135deg,#f97316 0%,#fbbf24 100%)',
    page: 'linear-gradient(180deg,#fff7ed 0%,#fffaf5 240px,#fffaf5 100%)',
    tint: '#fff7ed', ring: 'rgba(249,115,22,0.16)',
    glow: '0 10px 28px rgba(249,115,22,0.28)',
  },
  bubblegum: {
    name: 'Bubblegum',
    primary: '#db2777', primaryDark: '#be185d', primaryLight: '#fce7f3',
    accent: '#a855f7',
    logo: 'linear-gradient(135deg,#f472b6 0%,#a855f7 55%,#7c3aed 100%)',
    hero: 'linear-gradient(135deg,#db2777 0%,#a855f7 100%)',
    page: 'linear-gradient(180deg,#fdf2f8 0%,#fdf6fb 240px,#fdf6fb 100%)',
    tint: '#fdf2f8', ring: 'rgba(219,39,119,0.16)',
    glow: '0 10px 28px rgba(219,39,119,0.26)',
  },
  forest: {
    name: 'Forest',
    primary: '#059669', primaryDark: '#047857', primaryLight: '#d1fae5',
    accent: '#84cc16',
    logo: 'linear-gradient(135deg,#84cc16 0%,#22c55e 50%,#059669 100%)',
    hero: 'linear-gradient(135deg,#059669 0%,#84cc16 100%)',
    page: 'linear-gradient(180deg,#ecfdf5 0%,#f4fdf8 240px,#f4fdf8 100%)',
    tint: '#ecfdf5', ring: 'rgba(5,150,105,0.16)',
    glow: '0 10px 28px rgba(5,150,105,0.26)',
  },
};

// Playful per-scene accent palette (theme-independent, cycles)
const SCENE_ACCENTS = [
  { bg: '#eef2ff', fg: '#4f46e5', solid: '#6366f1' }, // indigo
  { bg: '#fef3c7', fg: '#b45309', solid: '#f59e0b' }, // amber
  { bg: '#dcfce7', fg: '#15803d', solid: '#22c55e' }, // green
  { bg: '#fce7f3', fg: '#be185d', solid: '#ec4899' }, // pink
  { bg: '#cffafe', fg: '#0e7490', solid: '#06b6d4' }, // cyan
  { bg: '#ede9fe', fg: '#6d28d9', solid: '#8b5cf6' }, // purple
];

// ---------- MODEL TIERS (real pricing, USD/second) ----------
const VG_PRICING = {
  lite:     { '720p': 0.05,  '1080p': 0.08 },
  standard: { '720p': 0.10,  '1080p': 0.12 },
  pro:      { '720p': 0.40,  '1080p': 0.40 },
  grok:     { '720p': 0.05 },                      // 720p max — no 1080p
  seedance: { '720p': 0.024, '1080p': 0.052 },
};
function vgRate(tierId, resId) { return (VG_PRICING[tierId] || {})[resId] || 0; }

const VG_TIERS = [
  { id: 'lite', icon: 'zap', name: 'Lite', tag: 'Quick & cheap', perSec: 0.05, api: 'lite', engine: 'Veo 3.1', blurb: 'Veo 3.1 Lite — great for drafts and trying ideas.' },
  { id: 'standard', icon: 'star', name: 'Standard', tag: 'Most popular', perSec: 0.10, api: 'fast', engine: 'Veo 3.1', blurb: 'Veo 3.1 Fast — crisp motion and rich color.', popular: true },
  { id: 'pro', icon: 'gem', name: 'Pro', tag: 'Best quality', perSec: 0.40, api: 'quality', engine: 'Veo 3.1', blurb: 'Veo 3.1 — film-grade detail for the final cut.' },
  { id: 'grok', icon: 'video', name: 'Grok Imagine', tag: 'xAI · OpenRouter', perSec: 0.05, api: 'grok', engine: 'xAI', maxRes: '720p', blurb: 'xAI Grok Imagine Video — fast, expressive motion. 720p max.' },
  { id: 'seedance', icon: 'film', name: 'Seedance 1.5', tag: 'ByteDance · OpenRouter', perSec: 0.024, api: 'seedance', engine: 'ByteDance', blurb: 'Seedance 1.5 Pro — cinematic camera moves, native lip-synced audio.' },
];

const VG_RESOLUTIONS = [
  { id: '720p', label: '720p', note: 'HD' },
  { id: '1080p', label: '1080p', note: 'Full HD' },
];

const VG_STYLES = [
  { id: 'cartoon', icon: 'smile', label: 'Cartoon' },
  { id: 'watercolor', icon: 'brush', label: 'Watercolor' },
  { id: 'clay', icon: 'box', label: 'Claymation' },
  { id: 'papercut', icon: 'scissors', label: 'Paper cut-out' },
  { id: 'pixel', icon: 'grid', label: 'Pixel' },
  { id: 'storybook', icon: 'book', label: 'Storybook' },
];

const VG_VOICES = [
  { id: 'sunny', icon: 'sun', label: 'Sunny narrator' },
  { id: 'grandpa', icon: 'user', label: 'Cozy grandpa' },
  { id: 'robot', icon: 'cpu', label: 'Friendly robot' },
  { id: 'fairy', icon: 'wand', label: 'Sparkly fairy' },
];

const VG_MUSIC = [
  { id: 'gentle', icon: 'feather', label: 'Gentle' },
  { id: 'playful', icon: 'music', label: 'Playful' },
  { id: 'adventure', icon: 'compass', label: 'Adventure' },
  { id: 'none', icon: 'mute', label: 'No music' },
];

// ---------- STARTER TEMPLATES ----------
const VG_TEMPLATES = [
  {
    icon: 'moon', title: 'Bedtime story',
    script: `Clip 1 — Cold Winter Night
Slow camera push toward a cozy bed. Snow falls softly outside the window.
Dialogue:
Dad: "Brrr! It's freezing out there!"

Clip 2 — The Mystery
Daughter lifts a corner of the warm blanket and peeks underneath, eyes wide.
Dialogue:
Daughter: "Daddy... what's glowing under here?"

Clip 3 — The Glow
A tiny, friendly firefly floats up from the blanket, lighting the whole room gold.
Dialogue:
Dad: "Well hello there, little light!"`,
  },
  {
    icon: 'hash', title: 'Counting adventure',
    script: `Clip 1 — One Red Balloon
A single red balloon drifts across a bright blue sky. Cheerful music.
Dialogue:
Narrator: "One... red... balloon!"

Clip 2 — Two Happy Ducks
Two yellow ducks waddle into frame by a sparkling pond.
Dialogue:
Narrator: "Two little ducks say quack quack!"

Clip 3 — Three Jumping Frogs
Three green frogs hop across lily pads, splashing.
Dialogue:
Narrator: "Three frogs jump — one, two, three!"`,
  },
  {
    icon: 'heart', title: 'Animal friends',
    script: `Clip 1 — Meet Fennel the Fox
A fluffy orange fox pokes its head out of a burrow in a sunny meadow.
Dialogue:
Fennel: "Good morning, world!"

Clip 2 — A New Friend
A shy hedgehog rolls up to Fennel and slowly uncurls.
Dialogue:
Fennel: "Don't be scared — want to play?"`,
  },
];

const VG_DEFAULT_SCRIPT = VG_TEMPLATES[0].script;

// ---------- SCRIPT PARSER ----------
function vgParseScript(text) {
  if (!text || !text.trim()) return [];
  const lines = text.replace(/\r/g, '').split('\n');
  const scenes = [];
  let cur = null;
  const headerRe = /^\s*(clip|scene)\s*\d+\b/i;
  const dashRe = /^\s*-{3,}\s*$/;
  lines.forEach((line) => {
    if (dashRe.test(line)) { if (cur) { scenes.push(cur); cur = null; } return; }
    const isHeader = headerRe.test(line);
    if (isHeader || cur === null) {
      if (cur) scenes.push(cur);
      let title = line.trim();
      title = title.replace(/^\s*(clip|scene)\s*\d+\s*[—\-:]*\s*/i, '').trim();
      if (!title) title = isHeader ? '' : line.trim();
      cur = { rawHeader: isHeader ? line.trim() : '', title: title || 'Untitled scene', body: isHeader ? '' : line.trim() + '\n', dialogue: [] };
      if (isHeader) cur.body = '';
    } else {
      const dl = line.match(/^\s*([A-Za-z][\w .'-]{0,20}):\s*["“](.+)["”]\s*$/);
      if (dl) cur.dialogue.push({ who: dl[1].trim(), line: dl[2].trim() });
      else if (/^\s*dialogue\s*:?\s*$/i.test(line)) { /* skip label */ }
      else cur.body += line + '\n';
    }
  });
  if (cur) scenes.push(cur);
  return scenes.map((s, i) => {
    const words = (s.body + ' ' + s.dialogue.map(d => d.line).join(' ')).trim().split(/\s+/).filter(Boolean).length;
    // Veo only generates 4, 6 or 8 second clips — snap the word-count estimate
    const raw = 4 + words / 9;
    const dur = raw <= 5 ? 4 : raw <= 7.5 ? 6 : 8;
    return {
      id: 'sc' + i,
      n: i + 1,
      title: s.title || `Scene ${i + 1}`,
      body: s.body.trim(),
      dialogue: s.dialogue,
      duration: dur,
      accent: SCENE_ACCENTS[i % SCENE_ACCENTS.length],
      image: null,
    };
  });
}

function vgMoney(n) {
  if (n === 0) return '$0.00';
  if (n < 0.1) return '$' + n.toFixed(3);
  return '$' + n.toFixed(2);
}

// ---------- LOGO ----------
function VGLogo({ theme, size = 34 }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{
        width: size, height: size, borderRadius: size * 0.32,
        background: theme.logo, display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: '0 4px 12px rgba(0,0,0,0.12)', flexShrink: 0,
      }}>
        <svg width={size * 0.56} height={size * 0.56} viewBox="0 0 24 24" fill="none">
          <path d="M8 5l8 7-8 7V5z" fill="#fff" />
        </svg>
      </div>
      <span style={{ fontFamily: "'Inter',sans-serif", fontWeight: 800, fontSize: size * 0.52, letterSpacing: '-0.4px', color: '#0f1419' }}>
        VideoGen <span style={{ fontWeight: 600, color: theme.primary }}>Kids</span>
      </span>
    </div>
  );
}

// ---------- PRIMITIVES ----------
function VGButton({ children, onClick, theme, variant = 'primary', size = 'md', style = {}, disabled, full }) {
  const [hover, setHover] = React.useState(false);
  const pad = size === 'lg' ? '15px 26px' : size === 'sm' ? '8px 14px' : '12px 20px';
  const fs = size === 'lg' ? 16 : size === 'sm' ? 13 : 14.5;
  let base = {};
  if (variant === 'primary') base = {
    background: theme.primary, color: '#fff', border: 'none',
    boxShadow: hover ? theme.glow : '0 6px 16px rgba(0,0,0,0.10)',
    transform: hover && !disabled ? 'translateY(-2px)' : 'none',
  };
  else if (variant === 'soft') base = {
    background: hover ? theme.primaryLight : theme.tint, color: theme.primaryDark,
    border: '1.5px solid ' + (hover ? theme.primary : 'transparent'),
  };
  else if (variant === 'ghost') base = {
    background: hover ? '#f3f4f6' : 'transparent', color: '#374151', border: '1.5px solid #e5e7eb',
  };
  else if (variant === 'outline') base = {
    background: hover ? theme.tint : '#fff', color: theme.primary, border: '2px solid ' + theme.primary,
  };
  return (
    <button onClick={disabled ? undefined : onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        padding: pad, borderRadius: 12, fontWeight: 700, fontSize: fs, cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: "'Instrument Sans',sans-serif", display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        gap: 8, transition: 'all .18s ease', opacity: disabled ? 0.5 : 1, width: full ? '100%' : 'auto',
        whiteSpace: 'nowrap', ...base, ...style,
      }}>{children}</button>
  );
}

function VGCard({ children, style = {}, hover: hoverable, theme, onClick, active }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        background: '#fff', borderRadius: 16,
        border: '1.5px solid ' + (active ? theme.primary : '#e5e7eb'),
        boxShadow: active ? theme.glow : (hoverable && hover ? '0 8px 24px rgba(0,0,0,0.08)' : '0 1px 3px rgba(0,0,0,0.05)'),
        transform: hoverable && hover && !active ? 'translateY(-2px)' : 'none',
        transition: 'all .18s ease', cursor: onClick ? 'pointer' : 'default', ...style,
      }}>{children}</div>
  );
}

function VGPill({ children, color = '#6b7280', bg = '#f3f4f6', style = {} }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 11px', borderRadius: 999,
      fontSize: 12, fontWeight: 700, color, background: bg, fontFamily: "'Instrument Sans',sans-serif",
      whiteSpace: 'nowrap', ...style,
    }}>{children}</span>
  );
}

function VGOverline({ children, style = {} }) {
  return <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: '#9ca3af', ...style }}>{children}</div>;
}

// Soft decorative thumbnail placeholder (a friendly frame)
function VGThumb({ accent, label, style = {}, src }) {
  if (src) {
    return <div style={{ borderRadius: 12, overflow: 'hidden', background: '#000', ...style }}>
      <img src={src} alt={label || ''} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
    </div>;
  }
  return (
    <div style={{
      borderRadius: 12, background: `linear-gradient(135deg, ${accent.bg} 0%, #fff 130%)`,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
      border: '1.5px dashed ' + accent.solid + '55', position: 'relative', overflow: 'hidden', ...style,
    }}>
      <VGIcon name="image" size={30} color={accent.solid} stroke={1.8} />
      {label && <div style={{ fontSize: 11, fontWeight: 600, color: accent.fg }}>{label}</div>}
    </div>
  );
}

// ---------- IMAGE READER (downscale to ≤2048px JPEG to keep payloads small) ----------
function vgReadImage(file) {
  return new Promise((resolve, reject) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { reject(new Error('PNG, JPEG or WebP only')); return; }
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 2048 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

Object.assign(window, {
  VG_THEMES, SCENE_ACCENTS, VG_TIERS, VG_RESOLUTIONS, VG_STYLES, VG_VOICES, VG_MUSIC,
  VG_TEMPLATES, VG_DEFAULT_SCRIPT, VG_PRICING, vgRate, vgParseScript, vgMoney, vgReadImage,
  VGLogo, VGButton, VGCard, VGPill, VGOverline, VGThumb,
});
