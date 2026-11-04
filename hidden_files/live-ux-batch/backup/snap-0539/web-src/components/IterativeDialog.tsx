/**
 * Iterative calculation settings dialog.
 * Exposes max iterations and max change per Excel's Calculation Options.
 */
import { useState } from 'react';
import type { IterativeSettings } from '@icecream-sheets/engine';
import A11yDialog from './A11yDialog';

interface Props {
  initial: IterativeSettings;
  onClose: () => void;
  onSave: (s: IterativeSettings) => void;
}

export default function IterativeDialog({ initial, onClose, onSave }: Props) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [maxIterations, setMaxIterations] = useState(String(initial.maxIterations));
  const [maxChange, setMaxChange] = useState(String(initial.maxChange));

  const save = () => {
    onSave({
      enabled,
      maxIterations: Math.min(32767, Math.max(1, parseInt(maxIterations, 10) || 100)),
      maxChange: parseFloat(maxChange) > 0 ? parseFloat(maxChange) : 0.001,
    });
    onClose();
  };

  return (
    <A11yDialog title={<>Iterative Calculation</>} width={320} onClose={onClose}>
        <label style={{ display: 'block', marginBottom: 12 }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />{' '}
          Enable iterative calculation
        </label>
        <label style={{ display: 'block', marginBottom: 8 }}>
          Maximum iterations (1–32767):
          <input
            type="number"
            min={1}
            max={32767}
            value={maxIterations}
            disabled={!enabled}
            onChange={(e) => setMaxIterations(e.target.value)}
            style={{ width: '100%', marginTop: 4 }}
          />
        </label>
        <label style={{ display: 'block', marginBottom: 16 }}>
          Maximum change:
          <input
            type="number"
            step="0.001"
            min="0"
            value={maxChange}
            disabled={!enabled}
            onChange={(e) => setMaxChange(e.target.value)}
            style={{ width: '100%', marginTop: 4 }}
          />
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose}>Cancel</button>
          <button onClick={save} className="primary">
            OK
          </button>
        </div>
      </A11yDialog>
  );
}
