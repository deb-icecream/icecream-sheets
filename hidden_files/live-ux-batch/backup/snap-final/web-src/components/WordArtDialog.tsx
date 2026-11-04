/**
 * WordArt dialog (Insert > Text > WordArt).
 *
 * Decorative text rendered as SVG: 8 presets (gradients, outlines,
 * shadows) with a live preview. Inserting hands the SVG string to the
 * parent, which adds it as a picture-like overlay (data URL).
 */
import { useState } from 'react';
import A11yDialog from './A11yDialog';

export interface WordArtPreset {
  id: string;
  name: string;
  /** <defs> content (gradients). IDs are namespaced per render. */
  defs: string;
  fill: string;
  stroke: string;
  strokeWidth: number;
  /** Extra filter markup (shadows), optional. */
  filter?: string;
  filterId?: string;
  fontWeight?: number;
  letterSpacing?: number;
}

export const WORDART_PRESETS: WordArtPreset[] = [
  {
    id: 'classic-blue', name: 'Classic Blue',
    defs: `<linearGradient id="wag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9cc3ff"/><stop offset=".5" stop-color="#2b6cb0"/><stop offset="1" stop-color="#1a365d"/></linearGradient>`,
    fill: 'url(#wag)', stroke: '#1a365d', strokeWidth: 1,
  },
  {
    id: 'sunset', name: 'Sunset',
    defs: `<linearGradient id="wag" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#f6ad55"/><stop offset=".5" stop-color="#ed8936"/><stop offset="1" stop-color="#c53030"/></linearGradient>`,
    fill: 'url(#wag)', stroke: '#7b2d0e', strokeWidth: 1,
  },
  {
    id: 'gold', name: 'Gold',
    defs: `<linearGradient id="wag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fefcbf"/><stop offset=".5" stop-color="#ecc94b"/><stop offset="1" stop-color="#975a16"/></linearGradient>`,
    fill: 'url(#wag)', stroke: '#744210', strokeWidth: 1.5,
  },
  {
    id: 'outline', name: 'Outline',
    defs: '', fill: 'none', stroke: '#2b6cb0', strokeWidth: 2, fontWeight: 700,
  },
  {
    id: 'shadow', name: 'Drop Shadow',
    defs: `<filter id="waf" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="3" dy="3" stdDeviation="2" flood-color="#4a5568" flood-opacity="0.6"/></filter>`,
    fill: '#2d3748', stroke: 'none', strokeWidth: 0, filter: 'url(#waf)', filterId: 'waf', fontWeight: 700,
  },
  {
    id: 'neon', name: 'Neon',
    defs: `<filter id="waf" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="#00e5ff"/></filter>`,
    fill: '#e6fffa', stroke: '#00b5d8', strokeWidth: 1, filter: 'url(#waf)', filterId: 'waf', fontWeight: 700,
  },
  {
    id: 'rainbow', name: 'Rainbow',
    defs: `<linearGradient id="wag" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#e53e3e"/><stop offset=".2" stop-color="#dd6b20"/><stop offset=".4" stop-color="#d69e2e"/><stop offset=".6" stop-color="#38a169"/><stop offset=".8" stop-color="#3182ce"/><stop offset="1" stop-color="#805ad5"/></linearGradient>`,
    fill: 'url(#wag)', stroke: 'none', strokeWidth: 0, fontWeight: 700,
  },
  {
    id: 'ice', name: 'Ice',
    defs: `<linearGradient id="wag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#90cdf4"/></linearGradient>`,
    fill: 'url(#wag)', stroke: '#2b6cb0', strokeWidth: 1,
  },
];

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Render WordArt text to a standalone SVG string. Width is estimated from
 * the text length; the parent converts this to a data URL for the overlay.
 */
export function wordArtSvg(text: string, preset: WordArtPreset, fontSize: number): { svg: string; width: number; height: number } {
  const label = text === '' ? 'WordArt' : text;
  const width = Math.max(80, Math.ceil(label.length * fontSize * 0.62 + fontSize * 0.8));
  const height = Math.ceil(fontSize * 1.6);
  const filterAttr = preset.filter ? ` filter="${preset.filter}"` : '';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    (preset.defs ? `<defs>${preset.defs}</defs>` : '') +
    `<text x="${width / 2}" y="${fontSize * 1.15}" text-anchor="middle" font-family="Arial, sans-serif" font-size="${fontSize}"` +
    ` font-weight="${preset.fontWeight ?? 600}" fill="${preset.fill}"` +
    (preset.stroke !== 'none' ? ` stroke="${preset.stroke}" stroke-width="${preset.strokeWidth}"` : '') +
    `${filterAttr}>${escapeXml(label)}</text></svg>`;
  return { svg, width, height };
}

export interface WordArtDialogProps {
  onClose: () => void;
  onInsert: (svg: string, width: number, height: number) => void;
}

export function WordArtDialog({ onClose, onInsert }: WordArtDialogProps) {
  const [text, setText] = useState('WordArt');
  const [presetId, setPresetId] = useState(WORDART_PRESETS[0].id);
  const [fontSize, setFontSize] = useState(48);

  const preset = WORDART_PRESETS.find((p) => p.id === presetId) ?? WORDART_PRESETS[0];
  const { svg } = wordArtSvg(text, preset, fontSize);
  const previewUrl = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

  return (
    <A11yDialog title={<>WordArt</>} width={560} onClose={onClose}>
        <label className="dialog-row">
          <span>Text:</span>
          <input value={text} onChange={(e) => setText(e.target.value)} style={{ marginLeft: 8, flex: 1 }} />
        </label>
        <label className="dialog-row">
          <span>Size:</span>
          <input
            type="range"
            min={16}
            max={120}
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
            style={{ margin: '0 8px', flex: 1 }}
          />
          <span>{fontSize}pt</span>
        </label>
        <div style={{ fontSize: 12, fontWeight: 600, margin: '8px 0 4px' }}>Style:</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 12 }}>
          {WORDART_PRESETS.map((p) => {
            const prev = wordArtSvg('Ag', p, 28);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setPresetId(p.id)}
                title={p.name}
                style={{
                  border: presetId === p.id ? '2px solid #2b579a' : '1px solid #ccc',
                  background: '#fff',
                  padding: 4,
                  cursor: 'pointer',
                }}
              >
                <img
                  src={`data:image/svg+xml;utf8,${encodeURIComponent(prev.svg)}`}
                  alt={p.name}
                  style={{ width: '100%', height: 34 }}
                />
                <div style={{ fontSize: 10, textAlign: 'center' }}>{p.name}</div>
              </button>
            );
          })}
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Preview:</div>
        <div style={{ border: '1px solid #ddd', padding: 12, textAlign: 'center', marginBottom: 8, background: '#fafafa' }}>
          <img src={previewUrl} alt="WordArt preview" style={{ maxWidth: '100%' }} />
        </div>
        <div className="dialog-actions">
          <button
            onClick={() => {
              const { svg: out, width, height } = wordArtSvg(text, preset, fontSize);
              onInsert(out, width, height);
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
