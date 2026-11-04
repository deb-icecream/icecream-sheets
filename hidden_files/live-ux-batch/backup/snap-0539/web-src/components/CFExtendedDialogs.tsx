/**
 * Dialogs for extended conditional formatting: top/bottom N, above average,
 * data bars, color scales, and icon sets.
 *
 * Dialog callbacks return styling choices; the parent builds ExtCFRule
 * objects (see features/cfExtended.ts) and wires them into App state.
 */
import { useState } from 'react';
import A11yDialog from './A11yDialog';

// ---------------------------------------------------------------------------
// Top / Bottom N / Above Average
// ---------------------------------------------------------------------------

interface TopBottomDialogProps {
  cellLabel: string;
  onClose: () => void;
  onAddTopBottom: (tb: 'top' | 'bottom', n: number) => void;
  onAddAboveAverage: () => void;
}

type TopBottomMode = 'top' | 'bottom' | 'above';

export function TopBottomDialog({ cellLabel, onClose, onAddTopBottom, onAddAboveAverage }: TopBottomDialogProps) {
  const [mode, setMode] = useState<TopBottomMode>('top');
  const [nText, setNText] = useState('10');

  const n = Math.max(1, Math.floor(Number(nText) || 10));

  return (
    <A11yDialog title={<>Top / Bottom {cellLabel}</>} onClose={onClose}>
        <div className="dialog-row">
          <label>
            <input type="radio" name="tb-mode" checked={mode === 'top'} onChange={() => setMode('top')} />
            {' '}Top N
          </label>
        </div>
        <div className="dialog-row">
          <label>
            <input type="radio" name="tb-mode" checked={mode === 'bottom'} onChange={() => setMode('bottom')} />
            {' '}Bottom N
          </label>
        </div>
        <div className="dialog-row">
          <label>
            <input type="radio" name="tb-mode" checked={mode === 'above'} onChange={() => setMode('above')} />
            {' '}Above Average
          </label>
        </div>
        {mode !== 'above' && (
          <label className="dialog-row">
            <span>N:</span>
            <input
              type="number"
              min={1}
              value={nText}
              onChange={(e) => setNText(e.target.value)}
              placeholder="10"
            />
          </label>
        )}
        <div className="dialog-hint">
          {mode === 'above'
            ? 'Highlights cells strictly greater than the average of the range.'
            : `Highlights the ${n} ${mode === 'top' ? 'highest' : 'lowest'} values in the range.`}
        </div>
        <div className="dialog-actions">
          <button
            onClick={() => {
              if (mode === 'above') onAddAboveAverage();
              else onAddTopBottom(mode, n);
              onClose();
            }}
          >
            Add Rule
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}

// ---------------------------------------------------------------------------
// Data bars
// ---------------------------------------------------------------------------

interface DataBarDialogProps {
  cellLabel: string;
  onClose: () => void;
  onAdd: (color: string) => void;
}

const DATA_BAR_COLORS: { name: string; value: string }[] = [
  { name: 'Blue', value: '#638EC6' },
  { name: 'Green', value: '#63C384' },
  { name: 'Red', value: '#F8696B' },
  { name: 'Orange', value: '#FFB628' },
  { name: 'Purple', value: '#9B6BCE' },
  { name: 'Teal', value: '#3BB5B5' },
];

export function DataBarDialog({ cellLabel, onClose, onAdd }: DataBarDialogProps) {
  const [color, setColor] = useState(DATA_BAR_COLORS[0].value);

  return (
    <A11yDialog title={<>Data Bars {cellLabel}</>} onClose={onClose}>
        <div className="dialog-hint">Pick a bar color. Bars scale with each cell's share of the range.</div>
        {DATA_BAR_COLORS.map((c) => (
          <label key={c.value} className="dialog-row" style={{ cursor: 'pointer' }}>
            <input
              type="radio"
              name="databar-color"
              checked={color === c.value}
              onChange={() => setColor(c.value)}
            />
            <span
              style={{
                display: 'inline-block',
                width: 64,
                height: 12,
                background: `linear-gradient(to right, ${c.value} 60%, #eee 60%)`,
                border: '1px solid #ccc',
                marginRight: 8,
              }}
            />
            <span>{c.name}</span>
          </label>
        ))}
        <div className="dialog-actions">
          <button
            onClick={() => {
              onAdd(color);
              onClose();
            }}
          >
            Add Data Bars
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}

// ---------------------------------------------------------------------------
// Color scales
// ---------------------------------------------------------------------------

interface ColorScaleDialogProps {
  cellLabel: string;
  onClose: () => void;
  onAdd: (low: string, high: string) => void;
}

interface ColorScalePreset {
  name: string;
  low: string;
  high: string;
}

const COLOR_SCALE_PRESETS: ColorScalePreset[] = [
  { name: 'Green-Yellow-Red', low: '#63C384', high: '#F8696B' },
  { name: 'Red-Yellow-Green', low: '#F8696B', high: '#63C384' },
  { name: 'Blue-White-Red', low: '#638EC6', high: '#F8696B' },
  { name: 'Green-White', low: '#63C384', high: '#FFFFFF' },
  { name: 'Red-White', low: '#F8696B', high: '#FFFFFF' },
  { name: 'Blue-White', low: '#638EC6', high: '#FFFFFF' },
];

export function ColorScaleDialog({ cellLabel, onClose, onAdd }: ColorScaleDialogProps) {
  const [index, setIndex] = useState(0);
  const preset = COLOR_SCALE_PRESETS[index];

  return (
    <A11yDialog title={<>Color Scale {cellLabel}</>} onClose={onClose}>
        <div className="dialog-hint">Cells shade from the low color to the high color across the range.</div>
        {COLOR_SCALE_PRESETS.map((p, i) => (
          <label key={p.name} className="dialog-row" style={{ cursor: 'pointer' }}>
            <input
              type="radio"
              name="colorscale-preset"
              checked={index === i}
              onChange={() => setIndex(i)}
            />
            <span
              style={{
                display: 'inline-block',
                width: 96,
                height: 14,
                background: `linear-gradient(to right, ${p.low}, ${p.high})`,
                border: '1px solid #ccc',
                marginRight: 8,
              }}
            />
            <span>{p.name}</span>
          </label>
        ))}
        <div className="dialog-actions">
          <button
            onClick={() => {
              onAdd(preset.low, preset.high);
              onClose();
            }}
          >
            Add Color Scale
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}

// ---------------------------------------------------------------------------
// Icon sets
// ---------------------------------------------------------------------------

interface IconSetDialogProps {
  cellLabel: string;
  onClose: () => void;
  onAdd: () => void;
}

export function IconSetDialog({ cellLabel, onClose, onAdd }: IconSetDialogProps) {
  return (
    <A11yDialog title={<>Icon Set {cellLabel}</>} onClose={onClose}>
        <div className="dialog-row">
          <span style={{ fontSize: 22, letterSpacing: 8 }} aria-hidden>
            <span style={{ color: '#2e7d32' }}>▲</span>
            <span style={{ color: '#c8a415' }}>►</span>
            <span style={{ color: '#c62828' }}>▼</span>
          </span>
          <span>3 Arrows (colored)</span>
        </div>
        <div className="dialog-hint">
          Cells in the top third of the range get ▲, the middle third ►, the bottom third ▼.
        </div>
        <div className="dialog-actions">
          <button
            onClick={() => {
              onAdd();
              onClose();
            }}
          >
            Add Icon Set
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}
