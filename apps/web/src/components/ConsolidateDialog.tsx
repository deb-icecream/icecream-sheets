/**
 * Consolidate dialog (Data > Data Tools > Consolidate).
 *
 * Wraps features/consolidate.ts: pick an aggregate function, choose
 * "by position" or "by labels" (top row / left column), add any number
 * of source ranges, and write the consolidated table to a destination
 * cell. Ranges are read through the host; the result is written through
 * host.execute() so every write passes authorize().
 */
import { useState } from 'react';
import type { EngineHost } from '@icecream-sheets/engine';
import { parseA1RangeRef } from '@icecream-sheets/engine';
import { typedValueText } from '../features/typedText';
import A11yDialog from './A11yDialog';
import {
  consolidate,
  CONSOLIDATE_FNS,
  type ConsolidateFn,
  type ConsolidateMode,
} from '../features/consolidate';

interface ConsolidateDialogProps {
  host: EngineHost;
  sheet: string;
  onClose: () => void;
  onApplied?: (info: { destination: string; rows: number; cols: number }) => void;
}

export default function ConsolidateDialog({ host, sheet, onClose, onApplied }: ConsolidateDialogProps) {
  const [fn, setFn] = useState<ConsolidateFn>('sum');
  const [mode, setMode] = useState<ConsolidateMode>('position');
  const [ranges, setRanges] = useState<string[]>(['']);
  const [destination, setDestination] = useState(`${sheet}!A1`);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const readRange = (a1: string): string[][] => {
    const text = a1.includes('!') ? a1 : `${sheet}!${a1}`;
    const parsed = parseA1RangeRef(text, sheet);
    if (!parsed || !parsed.sheet) throw new Error(`Invalid range: ${a1}`);
    const view = host.getView();
    const out: string[][] = [];
    for (let r = parsed.startRow; r <= parsed.endRow; r++) {
      const row: string[] = [];
      for (let c = parsed.startCol; c <= parsed.endCol; c++) {
        row.push(typedValueText(view.readCell({ sheet: parsed.sheet, row: r, col: c }).value));
      }
      out.push(row);
    }
    return out;
  };

  const apply = (): void => {
    setError('');
    setDone('');
    try {
      const list = ranges.map((r) => r.trim()).filter(Boolean);
      if (list.length === 0) throw new Error('Add at least one source range.');
      const matrices = list.map(readRange);
      const result = consolidate(matrices, fn, mode);
      const destText = destination.includes('!') ? destination : `${sheet}!${destination}`;
      const dest = parseA1RangeRef(destText, sheet);
      if (!dest || !dest.sheet) throw new Error(`Invalid destination: ${destination}`);
      result.forEach((row, ri) => {
        row.forEach((value, ci) => {
          host.execute({ cmd: 'setCell', ref: { sheet: dest.sheet, row: dest.startRow + ri, col: dest.startCol + ci }, value });
        });
      });
      host.execute({ cmd: 'recalculate' });
      onApplied?.({ destination: destText, rows: result.length, cols: result[0]?.length ?? 0 });
      setDone(`Consolidated ${list.length} range(s) → ${result.length}×${result[0]?.length ?? 0} at ${destText}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Consolidation failed.');
    }
  };

  return (
    <A11yDialog title={<>Consolidate</>} width={500} onClose={onClose}>
        <div className="dialog-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
          <label>
            Function<br />
            <select value={fn} onChange={(e) => setFn(e.target.value as ConsolidateFn)} aria-label="Aggregate function">
              {CONSOLIDATE_FNS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </label>
          <div>
            <strong>Consolidate by</strong><br />
            <label><input type="radio" name="cm-mode" checked={mode === 'position'} onChange={() => setMode('position')} /> Position (ranges share the same layout)</label><br />
            <label><input type="radio" name="cm-mode" checked={mode === 'labels'} onChange={() => setMode('labels')} /> Labels (top row and left column are categories)</label>
          </div>
          <div>
            <strong>Source ranges</strong>
            {ranges.map((r, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <input
                  value={r}
                  onChange={(e) => setRanges((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
                  placeholder="e.g. Q1!A1:D10"
                  style={{ flex: 1 }}
                  aria-label={`Source range ${i + 1}`}
                  spellCheck={false}
                />
                <button onClick={() => setRanges((prev) => prev.filter((_, j) => j !== i))} aria-label={`Remove range ${i + 1}`}>×</button>
              </div>
            ))}
            <button style={{ marginTop: 6 }} onClick={() => setRanges((prev) => [...prev, ''])}>Add range</button>
          </div>
          <label>
            Destination (top-left cell)<br />
            <input value={destination} onChange={(e) => setDestination(e.target.value)} style={{ width: '100%' }} aria-label="Destination" spellCheck={false} />
          </label>
        </div>
        {error && <div style={{ color: 'red', fontSize: 13 }}>{error}</div>}
        {done && <div style={{ color: '#1a7f37', fontSize: 13 }}>{done}</div>}
        <div className="dialog-actions">
          <button onClick={apply}>OK</button>
          <button onClick={onClose}>Close</button>
        </div>
      </A11yDialog>
  );
}
