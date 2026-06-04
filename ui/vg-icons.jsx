/* ============================================================
   VideoGen for Kids — Professional line-icon set
   Lucide-style, 24×24, 2px stroke, currentColor. No emoji.
   ============================================================ */

const VG_FILLED = { play: true };

function VGIcon({ name, size = 20, stroke = 2, color = 'currentColor', style = {} }) {
  const filled = VG_FILLED[name];
  const common = {
    width: size, height: size, viewBox: '0 0 24 24',
    fill: filled ? color : 'none',
    stroke: filled ? 'none' : color,
    strokeWidth: stroke, strokeLinecap: 'round', strokeLinejoin: 'round',
    style: { flexShrink: 0, display: 'block', ...style },
  };
  const P = (d, extra) => <path d={d} {...(extra || {})} />;
  const body = (() => {
    switch (name) {
      // --- chrome / nav ---
      case 'pencil': return <>{P('M12 20h9')}{P('M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z')}</>;
      case 'clapper': return <>{P('M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z')}{P('m6.2 5.3 3.1 3.9')}{P('m12.4 3.4 3.1 4')}{P('M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z')}</>;
      case 'film': return <><rect x="3" y="3" width="18" height="18" rx="2" />{P('M7 3v18')}{P('M17 3v18')}{P('M3 12h18')}{P('M3 7.5h4')}{P('M3 16.5h4')}{P('M17 7.5h4')}{P('M17 16.5h4')}</>;
      case 'sliders': return <>{P('M21 4h-7')}{P('M10 4H3')}{P('M21 12h-9')}{P('M8 12H3')}{P('M21 20h-5')}{P('M12 20H3')}{P('M14 2v4')}{P('M8 10v4')}{P('M16 18v4')}</>;
      case 'check-circle': return <>{P('M22 11.08V12a10 10 0 1 1-5.93-9.14')}<polyline points="22 4 12 14.01 9 11.01" /></>;
      case 'video': return <>{P('m22 8-6 4 6 4V8Z')}<rect x="2" y="6" width="14" height="12" rx="2" /></>;
      case 'layers': return <>{P('m12 2 9 5-9 5-9-5 9-5Z')}{P('m3 12 9 5 9-5')}{P('m3 17 9 5 9-5')}</>;

      // --- actions ---
      case 'play': return <><polygon points="6 3 20 12 6 21 6 3" /></>;
      case 'plus': return <>{P('M12 5v14')}{P('M5 12h14')}</>;
      case 'trash': return <>{P('M3 6h18')}{P('M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6')}{P('M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2')}{P('M10 11v6')}{P('M14 11v6')}</>;
      case 'chevron-up': return <><polyline points="18 15 12 9 6 15" /></>;
      case 'chevron-down': return <><polyline points="6 9 12 15 18 9" /></>;
      case 'arrow-right': return <>{P('M5 12h14')}{P('m12 5 7 7-7 7')}</>;
      case 'arrow-left': return <>{P('M19 12H5')}{P('m12 19-7-7 7-7')}</>;
      case 'image': return <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="1.6" />{P('m21 15-5-5L5 21')}</>;
      case 'refresh': return <>{P('M21 12a9 9 0 1 1-3-6.7L21 8')}{P('M21 3v5h-5')}</>;
      case 'wand': return <>{P('m12 3 1.9 4.6L18.5 9l-4.6 1.4L12 15l-1.9-4.6L5.5 9l4.6-1.4L12 3Z')}{P('M19 13v3')}{P('M20.5 14.5h-3')}{P('M5 17v2')}{P('M6 18H4')}</>;
      case 'plus-square': return <><rect x="3" y="3" width="18" height="18" rx="3" />{P('M12 8v8')}{P('M8 12h8')}</>;
      case 'stitch': return <><rect x="3" y="4" width="7" height="16" rx="2" /><rect x="14" y="4" width="7" height="16" rx="2" />{P('M10 12h4')}</>;

      // --- meta ---
      case 'clock': return <><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15.5 14" /></>;
      case 'message': return <>{P('M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z')}</>;
      case 'mic': return <><rect x="9" y="2" width="6" height="11" rx="3" />{P('M5 10v1a7 7 0 0 0 14 0v-1')}{P('M12 18v4')}{P('M8 22h8')}</>;
      case 'music': return <>{P('M9 18V5l12-2v13')}<circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>;
      case 'monitor': return <><rect x="2" y="3" width="20" height="14" rx="2" />{P('M8 21h8')}{P('M12 17v4')}</>;
      case 'dollar': return <>{P('M12 1v22')}{P('M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6')}</>;
      case 'check': return <><polyline points="20 6 9 17 4 12" /></>;

      // --- tiers ---
      case 'zap': return <><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></>;
      case 'star': return <><polygon points="12 2 15.1 8.6 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.6 12 2" /></>;
      case 'gem': return <>{P('M6 3h12l4 6-10 12L2 9Z')}{P('M11 3 8 9l4 12 4-12-3-6')}{P('M2 9h20')}</>;

      // --- styles ---
      case 'smile': return <><circle cx="12" cy="12" r="10" />{P('M8 14s1.5 2 4 2 4-2 4-2')}{P('M9 9h.01')}{P('M15 9h.01')}</>;
      case 'brush': return <>{P('m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08')}{P('M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02Z')}</>;
      case 'box': return <>{P('M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z')}{P('m3.3 7 8.7 5 8.7-5')}{P('M12 22V12')}</>;
      case 'scissors': return <><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" />{P('M20 4 8.12 15.88')}{P('M14.47 14.48 20 20')}{P('M8.12 8.12 12 12')}</>;
      case 'grid': return <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /></>;
      case 'book': return <>{P('M4 19.5A2.5 2.5 0 0 1 6.5 17H20')}{P('M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z')}</>;

      // --- voices ---
      case 'sun': return <><circle cx="12" cy="12" r="4" />{P('M12 2v2')}{P('M12 20v2')}{P('m4.9 4.9 1.4 1.4')}{P('m17.7 17.7 1.4 1.4')}{P('M2 12h2')}{P('M20 12h2')}{P('m6.3 17.7-1.4 1.4')}{P('m19.1 4.9-1.4 1.4')}</>;
      case 'user': return <>{P('M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2')}<circle cx="12" cy="7" r="4" /></>;
      case 'cpu': return <><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" rx="1" />{P('M9 1v3')}{P('M15 1v3')}{P('M9 20v3')}{P('M15 20v3')}{P('M20 9h3')}{P('M20 14h3')}{P('M1 9h3')}{P('M1 14h3')}</>;

      // --- music vibes ---
      case 'compass': return <><circle cx="12" cy="12" r="10" /><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" /></>;
      case 'mute': return <><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />{P('m22 9-6 6')}{P('m16 9 6 6')}</>;
      case 'feather': return <>{P('M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5Z')}{P('M16 8 2 22')}{P('M17.5 15H9')}</>;

      // --- templates ---
      case 'moon': return <>{P('M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z')}</>;
      case 'hash': return <>{P('M4 9h16')}{P('M4 15h16')}{P('M10 3 8 21')}{P('M16 3 14 21')}</>;
      case 'heart': return <>{P('M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78Z')}</>;

      default: return null;
    }
  })();
  return <svg {...common}>{body}</svg>;
}

Object.assign(window, { VGIcon });
