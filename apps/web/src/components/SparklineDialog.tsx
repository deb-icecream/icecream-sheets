/**
 * Insert-sparkline dialog (track 14): pick the sparkline type and the data
 * range; the sparkline renders in the currently selected cell.
 */
import { useState } from 'react';
import type { SparklineType } from '../features/sparklines';
import A11yDialog from './A11yDialog';

export const SPARKLINE_TYPES: { id: SparklineType; label: string }[] = [
  { id: 'line', label: 'Line' },
  { id: 'column', label: 'Column' },
  { id: 'winloss', label: 'Win/Loss' },
];

interface SparklineDialogProps {
  /** Suggested data range, e.g. "A1:E1". */
  defaultRange: string;
  /** Address of the cell the sparkline will render in, e.g. "G1". */
  locationLabel: string;
  onClose: () => void;
  onInsert: (type: SparklineType, range: string) => void;
}

export default function SparklineDialog({ defaultRange, locationLabel, onClose, onInsert }: SparklineDialogProps) {
  const [type, setType] = useState<SparklineType>('line');
  const [range, setRange] = useState(defaultRange);
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    // Accept "B2:F2" (colons) or "B2-F2"; require a valid A1 range shape.
    if (!/^[A-Za-z]+\d+:[A-Za-z]+\d+$/.test(range.trim())) {
      setError('Enter a data range like B2:F2.');
      return;
    }
    onInsert(type, range.trim());
    onClose();
  };

  return (
    <A11yDialog title={<>Insert Sparkline</>} onClose={onClose}>
        <p style={{ fontSize: 13, color: 'var(--text-dim)' }}>
          Renders a tiny in-cell chart in <strong>{locationLabel}</strong> from the data range below.
        </p>
        <label className="dialog-row">
          <span>Type:</span>
          <select value={type} onChange={(e) => setType(e.target.value as SparklineType)}>
            {SPARKLINE_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="dialog-row">
          <span>Data range:</span>
          <input value={range} onChange={(e) => setRange(e.target.value)} placeholder="B2:F2" aria-label="Data range" />
        </label>
        {error && (
          <div className="dialog-error" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
          <button onClick={submit} className="primary">
            Insert
          </button>
        </div>
      </A11yDialog>
  );
}
