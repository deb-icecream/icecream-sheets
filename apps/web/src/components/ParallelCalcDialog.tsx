/**
 * Parallel recalculation settings dialog (track 13).
 * Exposed via Formulas > Calculation > Calculation Options…
 *
 * - Enable/disable the worker-pool recalculation.
 * - Worker count (default = hardware concurrency).
 * - Minimum formula cells before the pool engages (avoids thread
 *   overhead on small workbooks).
 * - Last recalculation stats: parallel vs serial, workers used, timing.
 */
import { useState } from 'react';
import {
  defaultWorkerCount,
  type ParallelRecalcOptions,
  type ParallelRecalcStats,
} from '@icecream-sheets/engine';
import A11yDialog from './A11yDialog';

interface Props {
  initial: ParallelRecalcOptions;
  lastStats: ParallelRecalcStats | null;
  workersAvailable: boolean;
  onClose: () => void;
  onSave: (opts: ParallelRecalcOptions) => void;
}

export default function ParallelCalcDialog({
  initial,
  lastStats,
  workersAvailable,
  onClose,
  onSave,
}: Props) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [workerCount, setWorkerCount] = useState(String(initial.workerCount));
  const [minFormulaCells, setMinFormulaCells] = useState(String(initial.minFormulaCells ?? 2000));

  const save = () => {
    const def = defaultWorkerCount();
    onSave({
      enabled,
      workerCount: Math.min(64, Math.max(1, parseInt(workerCount, 10) || def)),
      minFormulaCells: Math.max(0, parseInt(minFormulaCells, 10) || 0),
    });
    onClose();
  };

  return (
    <A11yDialog title={<>Calculation Options</>} width={360} onClose={onClose}>
        {!workersAvailable && (
          <p style={{ color: '#a33', fontSize: 13 }}>
            Web Workers are not available in this browser — recalculation will
            use the single-threaded fallback. Results are identical either way.
          </p>
        )}
        <label style={{ display: 'block', marginBottom: 12 }}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={!workersAvailable}
            onChange={(e) => setEnabled(e.target.checked)}
          />{' '}
          Enable parallel recalculation (worker pool)
        </label>
        <label style={{ display: 'block', marginBottom: 8 }}>
          Worker count (default {defaultWorkerCount()}, 1–64):
          <input
            type="number"
            min={1}
            max={64}
            value={workerCount}
            disabled={!enabled}
            onChange={(e) => setWorkerCount(e.target.value)}
            style={{ width: '100%', marginTop: 4 }}
          />
        </label>
        <label style={{ display: 'block', marginBottom: 16 }}>
          Minimum formula cells before parallel engages:
          <input
            type="number"
            min={0}
            value={minFormulaCells}
            disabled={!enabled}
            onChange={(e) => setMinFormulaCells(e.target.value)}
            style={{ width: '100%', marginTop: 4 }}
          />
        </label>
        {lastStats && (
          <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>
            Last recalculation: {lastStats.parallel ? 'parallel' : 'serial'}
            {lastStats.parallel && ` (${lastStats.workersUsed} workers, ${lastStats.partitions} partitions)`}
            {' '}— {lastStats.elapsedMs} ms
            {lastStats.reason && ` (${lastStats.reason})`}
          </p>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose}>Cancel</button>
          <button onClick={save} className="primary">
            OK
          </button>
        </div>
      </A11yDialog>
  );
}
