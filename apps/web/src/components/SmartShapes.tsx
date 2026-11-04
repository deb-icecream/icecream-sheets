/**
 * Icons, SmartArt, and Screenshot (Insert > Illustrations).
 *
 * - Icons: a gallery of 28 stroke-style SVG icons inserted as picture-like
 *   overlays (color + size chosen in the dialog).
 * - SmartArt: four basic layouts (List, Process, Cycle, Hierarchy) rendered
 *   as SVG from editable text items, inserted the same way.
 * - Screenshot: captures a frame via getDisplayMedia (the user picks which
 *   screen/window/tab to share) and inserts it as a picture. This is the
 *   workable web route: the browser deliberately exposes no window
 *   enumeration, so Excel's "Available Windows" list cannot be reproduced;
 *   the permission prompt is the honest equivalent.
 */
import { useRef, useState } from 'react';
import A11yDialog from './A11yDialog';

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

export interface IconDef {
  id: string;
  name: string;
  /** Inner SVG content for a 24x24 viewBox (stroke style). */
  body: string;
}

const S = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

export const ICONS: IconDef[] = [
  { id: 'arrow-right', name: 'Arrow Right', body: `<g ${S}><line x1="4" y1="12" x2="20" y2="12"/><polyline points="13 5 20 12 13 19"/></g>` },
  { id: 'arrow-up', name: 'Arrow Up', body: `<g ${S}><line x1="12" y1="20" x2="12" y2="4"/><polyline points="5 11 12 4 19 11"/></g>` },
  { id: 'check', name: 'Check', body: `<g ${S}><polyline points="4 12 10 18 20 6"/></g>` },
  { id: 'x', name: 'Cross', body: `<g ${S}><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></g>` },
  { id: 'plus', name: 'Plus', body: `<g ${S}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></g>` },
  { id: 'star', name: 'Star', body: `<g ${S}><polygon points="12 3 15 9 21 9 16 13 18 19 12 15 6 19 8 13 3 9 9 9"/></g>` },
  { id: 'heart', name: 'Heart', body: `<g ${S}><path d="M12 20 C7 16 3 12 3 8.5 C3 6 5 4 7.5 4 C9.5 4 11 5.5 12 7 C13 5.5 14.5 4 16.5 4 C19 4 21 6 21 8.5 C21 12 17 16 12 20 Z"/></g>` },
  { id: 'flag', name: 'Flag', body: `<g ${S}><line x1="6" y1="3" x2="6" y2="21"/><path d="M6 4 H18 L15 8 L18 12 H6"/></g>` },
  { id: 'bulb', name: 'Idea', body: `<g ${S}><path d="M9 18 H15 M10 21 H14"/><path d="M12 3 C8 3 5 6 5 10 C5 12.5 6.5 14.5 8 16 H16 C17.5 14.5 19 12.5 19 10 C19 6 16 3 12 3 Z"/></g>` },
  { id: 'gear', name: 'Settings', body: `<g ${S}><circle cx="12" cy="12" r="3"/><path d="M12 2 V5 M12 19 V22 M2 12 H5 M19 12 H22 M4.9 4.9 L7 7 M17 17 L19.1 19.1 M19.1 4.9 L17 7 M7 17 L4.9 19.1"/></g>` },
  { id: 'search', name: 'Search', body: `<g ${S}><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></g>` },
  { id: 'home', name: 'Home', body: `<g ${S}><path d="M3 11 L12 3 L21 11"/><path d="M6 10 V21 H18 V10"/></g>` },
  { id: 'user', name: 'User', body: `<g ${S}><circle cx="12" cy="8" r="4"/><path d="M4 21 C4 16 8 14 12 14 C16 14 20 16 20 21"/></g>` },
  { id: 'users', name: 'Users', body: `<g ${S}><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20 C2.5 16 6 14 9 14 C12 14 15.5 16 15.5 20"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.5 C19 14.5 21.5 16 21.5 19.5"/></g>` },
  { id: 'calendar', name: 'Calendar', body: `<g ${S}><rect x="3" y="5" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/></g>` },
  { id: 'clock', name: 'Clock', body: `<g ${S}><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></g>` },
  { id: 'mail', name: 'Mail', body: `<g ${S}><rect x="3" y="5" width="18" height="14" rx="2"/><polyline points="3 7 12 13 21 7"/></g>` },
  { id: 'camera', name: 'Camera', body: `<g ${S}><path d="M4 8 H8 L10 5 H14 L16 8 H20 V19 H4 Z"/><circle cx="12" cy="13" r="3.5"/></g>` },
  { id: 'image', name: 'Image', body: `<g ${S}><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M3 18 L9 12 L14 17 L17 14 L21 18"/></g>` },
  { id: 'file', name: 'Document', body: `<g ${S}><path d="M6 2 H14 L20 8 V22 H6 Z"/><polyline points="14 2 14 8 20 8"/></g>` },
  { id: 'chart', name: 'Chart', body: `<g ${S}><line x1="4" y1="4" x2="4" y2="20" x2="20" y2="20"/><line x1="8" y1="16" x2="8" y2="12"/><line x1="12" y1="16" x2="12" y2="8"/><line x1="16" y1="16" x2="16" y2="11"/></g>` },
  { id: 'lock', name: 'Lock', body: `<g ${S}><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11 V7 C8 4.5 10 3 12 3 C14 3 16 4.5 16 7 V11"/></g>` },
  { id: 'info', name: 'Info', body: `<g ${S}><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><circle cx="12" cy="8" r="0.5"/></g>` },
  { id: 'warning', name: 'Warning', body: `<g ${S}><path d="M12 3 L22 20 H2 Z"/><line x1="12" y1="10" x2="12" y2="14"/><circle cx="12" cy="17" r="0.5"/></g>` },
  { id: 'thumbs-up', name: 'Thumbs Up', body: `<g ${S}><path d="M7 11 V21 H4 V11 Z"/><path d="M7 11 L11 3 C12.5 3 13 4.5 12.5 6 L11 10 H19 C20 10 20.5 11 20 12 L17.5 20 C17.3 20.7 16.6 21 16 21 H7"/></g>` },
  { id: 'phone', name: 'Phone', body: `<g ${S}><path d="M5 4 H9 L11 9 L8 11 C9 14 11 16 14 17 L16 14 L21 16 V20 C21 20.5 20.5 21 20 21 C10.5 21 3.5 14 3 4.5 C3 4 3.5 4 4 4 Z"/></g>` },
  { id: 'download', name: 'Download', body: `<g ${S}><line x1="12" y1="3" x2="12" y2="15"/><polyline points="7 10 12 15 17 10"/><line x1="4" y1="21" x2="20" y2="21"/></g>` },
  { id: 'music', name: 'Music', body: `<g ${S}><circle cx="7" cy="18" r="3"/><circle cx="17" cy="16" r="3"/><path d="M10 18 V5 L20 3 V16"/></g>` },
];

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Render an icon to a standalone SVG with the given color and pixel size. */
export function iconSvg(icon: IconDef, color: string, size: number): { svg: string; width: number; height: number } {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" color="${escapeXml(color)}">` +
    icon.body.replace(/currentColor/g, escapeXml(color)) +
    `</svg>`;
  return { svg, width: size, height: size };
}

export interface IconGalleryProps {
  onClose: () => void;
  onInsert: (svg: string, width: number, height: number) => void;
}

export function IconGallery({ onClose, onInsert }: IconGalleryProps) {
  const [color, setColor] = useState('#2b579a');
  const [size, setSize] = useState(96);

  return (
    <A11yDialog title={<>Icons</>} width={560} onClose={onClose}>
        <div className="dialog-row" style={{ gap: 16 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            Color:
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            Size:
            <input
              type="range" min={32} max={256} value={size}
              onChange={(e) => setSize(Number(e.target.value))}
            />
            <span>{size}px</span>
          </label>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(7, 1fr)',
            gap: 6,
            maxHeight: 320,
            overflowY: 'auto',
            border: '1px solid #ddd',
            padding: 8,
            marginBottom: 8,
          }}
        >
          {ICONS.map((icon) => (
            <button
              key={icon.id}
              type="button"
              title={icon.name}
              onClick={() => {
                const { svg, width, height } = iconSvg(icon, color, size);
                onInsert(svg, width, height);
                onClose();
              }}
              style={{ border: '1px solid #eee', background: '#fff', padding: 8, cursor: 'pointer', color }}
              dangerouslySetInnerHTML={{
                __html: `<svg viewBox="0 0 24 24" width="28" height="28">${icon.body}</svg>`,
              }}
              aria-label={icon.name}
            />
          ))}
        </div>
        <div className="dialog-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </A11yDialog>
  );
}

// ---------------------------------------------------------------------------
// SmartArt
// ---------------------------------------------------------------------------

export type SmartArtLayout = 'list' | 'process' | 'cycle' | 'hierarchy' | 'relationship' | 'pyramid' | 'matrix';

export const SMARTART_LAYOUTS: { id: SmartArtLayout; name: string; hint: string }[] = [
  { id: 'list', name: 'List', hint: 'Vertical bulleted list' },
  { id: 'process', name: 'Process', hint: 'Left-to-right chevron steps' },
  { id: 'cycle', name: 'Cycle', hint: 'Nodes around a circle' },
  { id: 'hierarchy', name: 'Hierarchy', hint: 'Top-down org tree' },
  { id: 'relationship', name: 'Relationship', hint: 'Central hub with satellites' },
  { id: 'pyramid', name: 'Pyramid', hint: 'Stacked pyramid layers' },
  { id: 'matrix', name: 'Matrix', hint: 'Four-quadrant grid' },
];

const SMART_COLORS = ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'];

/**
 * Word-wrap a label into at most `maxLines` lines of at most `maxChars`
 * chars each. Overlong words are truncated; leftover text is cut with an
 * ellipsis so a long label never bleeds into a neighbouring node.
 */
function wrapLabel(t: string, maxChars: number, maxLines: number): string[] {
  const words = t.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let i = 0;
  let cur = '';
  const pushCur = () => {
    if (cur) {
      lines.push(cur);
      cur = '';
    }
  };
  while (i < words.length && lines.length < maxLines) {
    const w = words[i];
    const word = w.length > maxChars ? `${w.slice(0, Math.max(0, maxChars - 1))}…` : w;
    const next = cur ? `${cur} ${word}` : word;
    if (next.length > maxChars && cur) {
      pushCur();
      continue;
    }
    cur = next;
    i += 1;
  }
  pushCur();
  if (i < words.length && lines.length > 0) {
    // Overflow: mark the final line as truncated.
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = last.length > maxChars - 1 ? `${last.slice(0, Math.max(0, maxChars - 2))}…` : `${last}…`;
  }
  return lines.slice(0, Math.max(1, maxLines));
}

export interface SmartArtSvgOptions {
  /**
   * Visible substitution note rendered as a caption strip under the
   * graphic (used for imported SmartArt whose layout had no exact
   * renderer — the closest-kind fallback is never silent).
   */
  note?: string;
}

/**
 * Render a SmartArt layout to SVG. `items` are the node labels; layouts
 * use up to 6 items (extras ignored, missing items blank).
 */
export function smartArtSvg(
  layout: SmartArtLayout,
  items: string[],
  opts?: SmartArtSvgOptions,
): { svg: string; width: number; height: number } {
  const labels = items.slice(0, 6);
  while (labels.length < 2) labels.push('');
  const n = labels.length;
  const W = 560;
  let H = 360;
  const font = "font-family=\"Arial, sans-serif\" font-size=\"14\"";
  const note = opts?.note?.trim() ?? '';
  let body = '';

  if (layout === 'list') {
    const rowH = Math.min(64, (H - 20) / n);
    labels.forEach((t, i) => {
      const y = 10 + i * rowH;
      const c = SMART_COLORS[i % SMART_COLORS.length];
      body += `<rect x="10" y="${y}" width="${W - 20}" height="${rowH - 8}" rx="6" fill="${c}" opacity="0.85"/>` +
        `<circle cx="38" cy="${y + (rowH - 8) / 2}" r="10" fill="#fff" opacity="0.9"/>` +
        `<text x="38" y="${y + (rowH - 8) / 2 + 5}" text-anchor="middle" ${font} font-weight="700" fill="${c}">${i + 1}</text>` +
        `<text x="60" y="${y + (rowH - 8) / 2 + 5}" ${font} fill="#fff">${escapeXml(t)}</text>`;
    });
  } else if (layout === 'process') {
    const cw = (W - 20) / n;
    labels.forEach((t, i) => {
      const x = 10 + i * cw;
      const c = SMART_COLORS[i % SMART_COLORS.length];
      const w = cw - 6;
      const h = 90;
      const y = H / 2 - h / 2;
      const tip = 18;
      const pts = i === n - 1
        ? `${x},${y} ${x + w},${y} ${x + w},${y + h} ${x},${y + h}`
        : `${x},${y} ${x + w},${y} ${x + w + tip},${y + h / 2} ${x + w},${y + h} ${x},${y + h}`;
      body += `<polygon points="${pts}" fill="${c}" opacity="0.85"/>` +
        `<text x="${x + w / 2}" y="${y + h / 2 + 5}" text-anchor="middle" ${font} fill="#fff">${escapeXml(t)}</text>`;
    });
  } else if (layout === 'cycle') {
    const cx = W / 2, cy = H / 2, R = 120, r = 44;
    labels.forEach((t, i) => {
      const a = (2 * Math.PI * i) / n - Math.PI / 2;
      const x = cx + R * Math.cos(a);
      const y = cy + R * Math.sin(a);
      const c = SMART_COLORS[i % SMART_COLORS.length];
      body += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="#bbb" stroke-width="2" stroke-dasharray="6 4"/>` +
        `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${c}" opacity="0.9"/>` +
        `<text x="${x.toFixed(1)}" y="${(y + 5).toFixed(1)}" text-anchor="middle" ${font} fill="#fff">${escapeXml(t)}</text>`;
    });
  } else if (layout === 'hierarchy') {
    // hierarchy: first item on top, rest spread below. Child boxes shrink
    // to fit their slot so they never overlap; long labels word-wrap onto
    // up to two lines so text never bleeds into neighbouring boxes.
    const topY = 30;
    body += `<rect x="${W / 2 - 90}" y="${topY}" width="180" height="52" rx="6" fill="${SMART_COLORS[0]}"/>` +
      `<text x="${W / 2}" y="${topY + 32}" text-anchor="middle" ${font} fill="#fff">${escapeXml(labels[0])}</text>`;
    const kids = labels.slice(1);
    const kw = (W - 40) / kids.length;
    const bw = Math.min(150, kw - 10);
    const maxChars = Math.max(8, Math.floor((bw - 16) / 7.2));
    kids.forEach((t, i) => {
      const x = 20 + i * kw + kw / 2;
      const y = topY + 130;
      const c = SMART_COLORS[(i + 1) % SMART_COLORS.length];
      const lines = wrapLabel(t, maxChars, 2).map(escapeXml);
      body += `<line x1="${W / 2}" y1="${topY + 52}" x2="${x}" y2="${y}" stroke="#999" stroke-width="2"/>` +
        `<rect x="${(x - bw / 2).toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="52" rx="6" fill="${c}" opacity="0.9"/>`;
      lines.forEach((ln, li) => {
        const ly = lines.length === 1 ? y + 32 : y + 22 + li * 16;
        body += `<text x="${x.toFixed(1)}" y="${ly}" text-anchor="middle" ${font} fill="#fff">${ln}</text>`;
      });
    });
  } else if (layout === 'relationship') {
    // relationship: first item as the central hub, rest as satellites
    const cx = W / 2, cy = H / 2;
    const hub = labels[0];
    const sats = labels.slice(1);
    const R = 118, r = 40;
    sats.forEach((t, i) => {
      const a = (2 * Math.PI * i) / Math.max(1, sats.length) - Math.PI / 2;
      const x = cx + R * Math.cos(a);
      const y = cy + R * Math.sin(a);
      const c = SMART_COLORS[(i + 1) % SMART_COLORS.length];
      body += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#999" stroke-width="2"/>` +
        `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${c}" opacity="0.9"/>` +
        `<text x="${x.toFixed(1)}" y="${(y + 5).toFixed(1)}" text-anchor="middle" ${font} fill="#fff">${escapeXml(t)}</text>`;
    });
    body += `<circle cx="${cx}" cy="${cy}" r="52" fill="${SMART_COLORS[0]}"/>` +
      `<text x="${cx}" y="${cy + 5}" text-anchor="middle" ${font} fill="#fff">${escapeXml(hub)}</text>`;
  } else if (layout === 'pyramid') {
    // pyramid: layers stacked wide-at-bottom, first item at the apex
    const layers = labels.slice(0, 5);
    const topY = 20;
    const layerH = Math.min(64, (H - 40) / layers.length);
    const maxW = W - 80;
    layers.forEach((t, i) => {
      const wTop = (maxW * (i + 1)) / layers.length;
      const wBot = Math.min(maxW, (maxW * (i + 2)) / layers.length);
      const cx = W / 2;
      const y = topY + i * layerH;
      const c = SMART_COLORS[i % SMART_COLORS.length];
      const pts = `${cx - wTop / 2},${y} ${cx + wTop / 2},${y} ` +
        `${cx + wBot / 2},${y + layerH - 4} ${cx - wBot / 2},${y + layerH - 4}`;
      body += `<polygon points="${pts}" fill="${c}" opacity="0.88" stroke="#fff" stroke-width="2"/>` +
        `<text x="${cx}" y="${(y + layerH / 2 + 5).toFixed(1)}" text-anchor="middle" ${font} fill="#fff">${escapeXml(t)}</text>`;
    });
  } else if (layout === 'matrix') {
    // matrix: four-quadrant grid (uses up to 4 items)
    const quads = labels.slice(0, 4);
    const gw = (W - 40) / 2, gh = (H - 40) / 2;
    quads.forEach((t, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const x = 20 + col * gw, y = 20 + row * gh;
      const c = SMART_COLORS[i % SMART_COLORS.length];
      body += `<rect x="${x}" y="${y}" width="${gw - 8}" height="${gh - 8}" rx="8" fill="${c}" opacity="0.88"/>` +
        `<text x="${(x + (gw - 8) / 2).toFixed(1)}" y="${(y + (gh - 8) / 2 + 5).toFixed(1)}" text-anchor="middle" ${font} fill="#fff">${escapeXml(t)}</text>`;
    });
  }

  if (note) {
    // Word-wrap the note to ~64 chars so the caption never clips.
    const words = note.split(/\s+/);
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > 64 && cur) {
        lines.push(cur);
        cur = w;
      } else {
        cur = (cur + ' ' + w).trim();
      }
    }
    if (cur) lines.push(cur);
    const shown = lines.slice(0, 2);
    const capH = 16 + shown.length * 16;
    const ny = H;
    H += capH;
    body += `<rect x="0" y="${ny}" width="${W}" height="${capH}" fill="#fffbe6"/>` +
      `<line x1="0" y1="${ny}" x2="${W}" y2="${ny}" stroke="#e3c878" stroke-width="1"/>`;
    shown.forEach((ln, i) => {
      body += `<text x="12" y="${ny + 20 + i * 16}" font-family="Arial, sans-serif" font-size="12" fill="#7a5c00">${escapeXml(ln)}</text>`;
    });
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
  return { svg, width: W, height: H };
}

export interface SmartArtDialogProps {
  onClose: () => void;
  onInsert: (svg: string, width: number, height: number) => void;
}

export function SmartArtDialog({ onClose, onInsert }: SmartArtDialogProps) {
  const [layout, setLayout] = useState<SmartArtLayout>('process');
  const [count, setCount] = useState(4);
  const [items, setItems] = useState<string[]>(['Step 1', 'Step 2', 'Step 3', 'Step 4', '', '']);

  const labels = items.slice(0, count);
  const { svg } = smartArtSvg(layout, labels);
  const previewUrl = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

  const setItem = (i: number, v: string) =>
    setItems((prev) => prev.map((p, j) => (j === i ? v : p)));

  return (
    <A11yDialog title={<>SmartArt Graphic</>} width={620} onClose={onClose}>
        <div className="dialog-row" style={{ gap: 6 }} role="tablist" aria-label="Layouts">
          {SMARTART_LAYOUTS.map((l) => (
            <button
              key={l.id}
              type="button"
              role="tab"
              aria-selected={layout === l.id}
              title={l.hint}
              onClick={() => setLayout(l.id)}
              style={{
                padding: '6px 12px',
                border: '1px solid #ccc',
                background: layout === l.id ? '#e8f0fe' : '#fff',
                fontWeight: layout === l.id ? 600 : undefined,
                cursor: 'pointer',
              }}
            >
              {l.name}
            </button>
          ))}
          <label style={{ marginLeft: 'auto', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            Items:
            <input
              type="number" min={2} max={6} value={count}
              onChange={(e) => setCount(Math.max(2, Math.min(6, Number(e.target.value) || 2)))}
              style={{ width: 52 }}
            />
          </label>
        </div>
        {labels.map((t, i) => (
          <label key={i} className="dialog-row" style={{ fontSize: 12 }}>
            <span style={{ width: 64 }}>Item {i + 1}:</span>
            <input value={t} onChange={(e) => setItem(i, e.target.value)} style={{ flex: 1 }} />
          </label>
        ))}
        <div style={{ border: '1px solid #ddd', padding: 8, marginBottom: 8, background: '#fff' }}>
          <img src={previewUrl} alt="SmartArt preview" style={{ width: '100%' }} />
        </div>
        <div className="dialog-actions">
          <button
            onClick={() => {
              const { svg: out, width, height } = smartArtSvg(layout, labels);
              // addPicture expects a data URL (like the preview above), not
              // raw SVG — without this the inserted graphic renders broken.
              onInsert(`data:image/svg+xml;utf8,${encodeURIComponent(out)}`, width, height);
              onClose();
            }}
          >
            Insert
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

export interface ScreenshotDialogProps {
  onClose: () => void;
  /** Insert the captured frame as a picture (data URL, JPEG). */
  onInsert: (dataUrl: string, width: number, height: number) => void;
  onError: (msg: string) => void;
}

/**
 * Screenshot via getDisplayMedia: the browser asks the user which
 * screen / window / tab to share, we grab one video frame to canvas.
 * No window enumeration is possible from a web page — the permission
 * prompt is the web's honest equivalent of "Available Windows".
 */
export function ScreenshotDialog({ onClose, onInsert, onError }: ScreenshotDialogProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [sharing, setSharing] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const stopSharing = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setSharing(false);
  };

  const startSharing = async () => {
    setFailed(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      streamRef.current = stream;
      stream.getVideoTracks()[0]?.addEventListener('ended', stopSharing);
      setSharing(true);
      // Attach once the video element exists.
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      });
    } catch (e) {
      setFailed(
        e instanceof DOMException && e.name === 'NotAllowedError'
          ? 'Screen sharing was cancelled or denied.'
          : `Could not start screen sharing: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  const capture = () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) {
      onError('No video frame available yet — wait a moment and try again.');
      return;
    }
    try {
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 1600 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D unavailable');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      stopSharing();
      onInsert(dataUrl, canvas.width, canvas.height);
      onClose();
    } catch (e) {
      onError(`Screenshot failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <A11yDialog title={<>Screenshot</>} width={520} onClose={() => {
        stopSharing();
        onClose();
      }}>
        <div className="dialog-hint">
          Your browser will ask which screen, window, or tab to share. Then
          capture a frame to insert it as a picture.
        </div>
        {!sharing ? (
          <div className="dialog-row">
            <button type="button" onClick={startSharing}>
              Share Screen…
            </button>
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              muted
              playsInline
              style={{ width: '100%', border: '1px solid #ccc', marginBottom: 8, background: '#000' }}
            />
            <div className="dialog-row">
              <button type="button" onClick={capture}>
                Capture Frame
              </button>
              <button type="button" onClick={stopSharing} style={{ marginLeft: 8 }}>
                Stop Sharing
              </button>
            </div>
          </>
        )}
        {failed && <div style={{ color: '#b00020', fontSize: 12, marginTop: 8 }}>{failed}</div>}
        <div className="dialog-actions">
          <button
            onClick={() => {
              stopSharing();
              onClose();
            }}
          >
            Close
          </button>
        </div>
      </A11yDialog>
  );
}
