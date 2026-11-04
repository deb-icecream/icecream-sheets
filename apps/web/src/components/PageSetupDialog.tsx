/**
 * PageSetupDialog: Page Layout > Page Setup — margins, orientation,
 * paper size, and print titles (rows/columns to repeat on every page).
 *
 * Wired to the existing pagesetup metadata: the parent owns the PageSetup
 * value (components/PrintLayout.tsx) and persists it under
 * `icecream.pagesetup.<sheet>`; print titles persist alongside under
 * `icecream.printtitles.<sheet>`.
 */
import { useState } from 'react';
import type { PrintPageSetup } from '@icecream-sheets/service';
import {
  PAPER_SIZES,
  type PageSetup,
} from './PrintLayout';
import A11yDialog from './A11yDialog';

export interface PrintTitles {
  /** e.g. "1:3" — rows repeated at the top of every printed page. */
  rows: string;
  /** e.g. "A:C" — columns repeated at the left of every printed page. */
  cols: string;
}

export const PRINT_TITLES_METADATA_PREFIX = 'icecream.printtitles.';
export const DEFAULT_PRINT_TITLES: PrintTitles = { rows: '', cols: '' };

export function printTitlesToMetadata(t: PrintTitles): unknown {
  return JSON.parse(JSON.stringify(t)) as unknown;
}

export function printTitlesFromMetadata(meta: unknown): PrintTitles | null {
  if (typeof meta !== 'object' || meta === null) return null;
  const r = meta as Record<string, unknown>;
  if (typeof r.rows !== 'string' || typeof r.cols !== 'string') return null;
  return { rows: r.rows, cols: r.cols };
}

/**
 * Adapt the dialog's PageSetup + PrintTitles model to the service
 * pagination engine (packages/service/src/pagination.ts). Blank title
 * strings become null (no titles); whitespace is trimmed.
 */
export function toPrintPageSetup(ps: PageSetup, titles: PrintTitles): PrintPageSetup {
  const rows = titles.rows.trim();
  const cols = titles.cols.trim();
  return {
    orientation: ps.orientation,
    paperSize: ps.paperSize,
    margins: { ...ps.margins },
    scale: ps.scale,
    printArea: ps.printArea,
    printTitleRows: rows === '' ? null : rows,
    printTitleCols: cols === '' ? null : cols,
    header: ps.header,
    footer: ps.footer,
    pageOrder: 'downOver',
  };
}

type MarginPreset = 'normal' | 'wide' | 'narrow' | 'custom';

const MARGIN_PRESETS: Record<Exclude<MarginPreset, 'custom'>, PageSetup['margins']> = {
  normal: { top: 0.75, right: 0.7, bottom: 0.75, left: 0.7 },
  wide: { top: 1, right: 1, bottom: 1, left: 1 },
  narrow: { top: 0.25, right: 0.25, bottom: 0.25, left: 0.25 },
};

function detectPreset(m: PageSetup['margins']): MarginPreset {
  for (const [name, preset] of Object.entries(MARGIN_PRESETS) as [Exclude<MarginPreset, 'custom'>, PageSetup['margins']][]) {
    if (preset.top === m.top && preset.right === m.right && preset.bottom === m.bottom && preset.left === m.left) {
      return name;
    }
  }
  return 'custom';
}

export interface PageSetupDialogProps {
  sheet: string;
  setup: PageSetup;
  onSetupChange: (setup: PageSetup) => void;
  titles: PrintTitles;
  onTitlesChange: (titles: PrintTitles) => void;
  onClose: () => void;
}

export default function PageSetupDialog({ sheet, setup, onSetupChange, titles, onTitlesChange, onClose }: PageSetupDialogProps) {
  const [preset, setPreset] = useState<MarginPreset>(() => detectPreset(setup.margins));

  const applyPreset = (p: MarginPreset) => {
    setPreset(p);
    if (p !== 'custom') onSetupChange({ ...setup, margins: { ...MARGIN_PRESETS[p] } });
  };

  const setMargin = (k: keyof PageSetup['margins'], v: number) => {
    setPreset('custom');
    onSetupChange({ ...setup, margins: { ...setup.margins, [k]: Math.max(0, Math.min(3, v)) } });
  };

  const titlesValid =
    (/^(\d+:\d+)?$/.test(titles.rows.replace(/\s/g, '')) || titles.rows.trim() === '') &&
    (/^([A-Za-z]{1,3}:[A-Za-z]{1,3})?$/.test(titles.cols.replace(/\s/g, '')) || titles.cols.trim() === '');

  return (
    <A11yDialog title={<>Page Setup — {sheet}</>} width={480} onClose={onClose}>
        <div style={{ padding: 14, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <fieldset style={{ margin: 0, padding: 10 }}>
            <legend>Margins</legend>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              {(['normal', 'wide', 'narrow', 'custom'] as MarginPreset[]).map((p) => (
                <button
                  key={p}
                  onClick={() => applyPreset(p)}
                  style={{ fontWeight: preset === p ? 700 : 400, textTransform: 'capitalize', cursor: 'pointer' }}
                  title={p === 'custom' ? 'Enter custom margin values below' : `Use ${p} margins`}
                >
                  {p}
                </button>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {(['top', 'right', 'bottom', 'left'] as const).map((k) => (
                <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 52, textTransform: 'capitalize' }}>{k}</span>
                  <input
                    type="number"
                    step={0.25}
                    min={0}
                    max={3}
                    value={setup.margins[k]}
                    onChange={(e) => setMargin(k, Number(e.target.value))}
                    style={{ width: 64 }}
                  />
                  <span style={{ color: '#666' }}>in</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset style={{ margin: 0, padding: 10 }}>
            <legend>Orientation &amp; paper</legend>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <label>
                Orientation{' '}
                <select
                  value={setup.orientation}
                  onChange={(e) => onSetupChange({ ...setup, orientation: e.target.value as PageSetup['orientation'] })}
                >
                  <option value="portrait">Portrait</option>
                  <option value="landscape">Landscape</option>
                </select>
              </label>
              <label>
                Paper size{' '}
                <select
                  value={setup.paperSize}
                  onChange={(e) => onSetupChange({ ...setup, paperSize: e.target.value as PageSetup['paperSize'] })}
                >
                  {(Object.keys(PAPER_SIZES) as PageSetup['paperSize'][]).map((k) => (
                    <option key={k} value={k}>{PAPER_SIZES[k].label}</option>
                  ))}
                </select>
              </label>
            </div>
          </fieldset>

          <fieldset style={{ margin: 0, padding: 10 }}>
            <legend>Print titles</legend>
            <label style={{ display: 'block', marginBottom: 8 }}>
              Rows to repeat at top{' '}
              <input
                value={titles.rows}
                placeholder="e.g. 1:3"
                onChange={(e) => onTitlesChange({ ...titles, rows: e.target.value })}
                style={{ width: 90 }}
                title="Row numbers like 1:3 — repeated at the top of every printed page"
              />
            </label>
            <label style={{ display: 'block' }}>
              Columns to repeat at left{' '}
              <input
                value={titles.cols}
                placeholder="e.g. A:C"
                onChange={(e) => onTitlesChange({ ...titles, cols: e.target.value })}
                style={{ width: 90 }}
                title="Column letters like A:C — repeated at the left of every printed page"
              />
            </label>
            {!titlesValid && (
              <p style={{ color: '#b00020', margin: '8px 0 0' }}>
                Use row ranges like 1:3 and column ranges like A:C.
              </p>
            )}
            <p style={{ color: '#666', margin: '8px 0 0' }}>
              Print titles are honored by the print path: the repeated rows and
              columns are prepended to every printed page.
            </p>
          </fieldset>
        </div>
        <div style={{ padding: '10px 14px', borderTop: '1px solid #ddd', display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onClose}>Done</button>
        </div>
      </A11yDialog>
  );
}
