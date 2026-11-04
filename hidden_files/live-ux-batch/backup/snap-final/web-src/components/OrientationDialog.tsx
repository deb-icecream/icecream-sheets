/**
 * Orientation dialog (Home > Alignment > Orientation).
 *
 * Excel presets: Angle Counterclockwise, Angle Clockwise, Vertical Text,
 * Rotate Text Up, Rotate Text Down, plus Format Cell Alignment… (which
 * opens the full Format Cells dialog). Also offers a free -90..90° slider.
 *
 * Writes CellFormat.orientation (degrees, positive = counterclockwise) and
 * CellFormat.verticalText; see features/formatting.ts formatToCSS for the
 * grid rendering.
 */
import { useState } from 'react';
import type { CellFormat } from '../features/formatting';
import A11yDialog from './A11yDialog';

export interface OrientationDialogProps {
  format: CellFormat | undefined;
  onClose: () => void;
  /** Apply an orientation update to the selection (parent -> onFormat). */
  onApply: (update: Partial<CellFormat>) => void;
  /** Open the full Format Cells dialog (Alignment tab). */
  onOpenFormatCells: () => void;
}

const PRESETS: { label: string; orientation?: number; verticalText?: boolean }[] = [
  { label: 'Angle Counterclockwise', orientation: 45 },
  { label: 'Angle Clockwise', orientation: -45 },
  { label: 'Vertical Text', verticalText: true },
  { label: 'Rotate Text Up', orientation: 90 },
  { label: 'Rotate Text Down', orientation: -90 },
];

export function OrientationDialog({ format, onClose, onApply, onOpenFormatCells }: OrientationDialogProps) {
  const [degrees, setDegrees] = useState<number>(format?.verticalText ? 0 : (format?.orientation ?? 0));

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    if (p.verticalText) {
      onApply({ verticalText: true, orientation: undefined });
    } else {
      onApply({ orientation: p.orientation, verticalText: false });
      setDegrees(p.orientation ?? 0);
    }
  };

  const applyCustom = () => {
    const clamped = Math.max(-90, Math.min(90, Math.round(degrees)));
    onApply({ orientation: clamped === 0 ? undefined : clamped, verticalText: false });
    onClose();
  };

  const clear = () => {
    onApply({ orientation: undefined, verticalText: false });
    setDegrees(0);
  };

  const previewTransform = format?.verticalText
    ? 'vertical text'
    : `${format?.orientation ?? 0}°`;

  return (
    <A11yDialog title={<>Orientation</>} onClose={onClose}>

        <div className="dialog-row" style={{ gap: 16 }}>
          <div
            aria-hidden
            style={{
              width: 72,
              height: 72,
              border: '1px solid #ccc',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              fontSize: 13,
            }}
          >
            <span
              style={
                format?.verticalText
                  ? { writingMode: 'vertical-rl' }
                  : { transform: `rotate(${-(format?.orientation ?? 0)}deg)` }
              }
            >
              Text
            </span>
          </div>
          <div style={{ fontSize: 12, color: '#555' }}>
            Current: <strong>{previewTransform}</strong>
          </div>
        </div>

        {PRESETS.map((p) => (
          <div key={p.label} className="dialog-row">
            <button type="button" onClick={() => applyPreset(p)} style={{ minWidth: 190, textAlign: 'left' }}>
              {p.label}
            </button>
          </div>
        ))}

        <label className="dialog-row">
          <span>Custom angle (−90…90°):</span>
          <input
            type="range"
            min={-90}
            max={90}
            value={degrees}
            onChange={(e) => setDegrees(Number(e.target.value))}
            style={{ margin: '0 8px', flex: 1 }}
            aria-label="Custom orientation angle"
          />
          <input
            type="number"
            min={-90}
            max={90}
            value={degrees}
            onChange={(e) => setDegrees(Number(e.target.value))}
            style={{ width: 64 }}
            aria-label="Custom orientation degrees"
          />
          <span>°</span>
        </label>

        <div className="dialog-row">
          <button type="button" onClick={clear} title="Remove rotation and vertical text">
            Clear Orientation
          </button>
          <button
            type="button"
            onClick={() => {
              onOpenFormatCells();
              onClose();
            }}
            title="Open the full Format Cells dialog"
            style={{ marginLeft: 8 }}
          >
            Format Cell Alignment…
          </button>
        </div>

        <div className="dialog-actions">
          <button onClick={applyCustom}>OK</button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}
