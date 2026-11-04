/**
 * Subtotal dialog + outline controls (Data > Outline > Subtotal,
 * Show Detail, Hide Detail).
 *
 * Wraps features/subtotal.ts: pick the group-by column, value columns
 * and aggregate function; the dialog reads the used range, computes
 * detail + subtotal + grand-total rows with outline levels, and writes
 * them to a destination (default: below the source data). Show Detail /
 * Hide Detail step the outline level up/down; the resulting level and
 * rows are reported via onApplied so the parent can persist them and
 * render collapsed groups in the grid.
 */
import { useState } from 'react';
import type { EngineHost } from '@icecream-sheets/engine';
import { typedValueText } from '../features/typedText';
import A11yDialog from './A11yDialog';
import {
  applySubtotal,
  stepOutlineLevel,
  SUBTOTAL_FNS,
  type OutlineLevel,
  type SubtotalFn,
  type SubtotalRow,
} from '../features/subtotal';

interface SubtotalDialogProps {
  host: EngineHost;
  sheet: string;
  onClose: () => void;
  onApplied: (result: { rows: SubtotalRow[]; level: OutlineLevel; destSheet: string; destRow: number }) => void;
}

export default function SubtotalDialog({ host, sheet, onClose, onApplied }: SubtotalDialogProps) {
  const used = host.getView().usedRange(sheet);
  const headers: string[] = [];
  if (used) {
    const view = host.getView();
    for (let c = used.startCol; c <= used.endCol; c++) {
      headers.push(typedValueText(view.readCell({ sheet, row: used.startRow, col: c }).value) || `Column ${c + 1}`);
    }
  }
  const [groupCol, setGroupCol] = useState(0);
  const [valueCols, setValueCols] = useState<number[]>(headers.length > 1 ? [1] : []);
  const [fn, setFn] = useState<SubtotalFn>('sum');
  const [level, setLevel] = useState<OutlineLevel>(3);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const toggleValueCol = (c: number): void => {
    setValueCols((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  };

  const apply = (): void => {
    setError('');
    setDone('');
    try {
      if (!used) throw new Error('The sheet is empty.');
      if (valueCols.length === 0) throw new Error('Pick at least one value column.');
      const view = host.getView();
      const data: string[][] = [];
      for (let r = used.startRow; r <= used.endRow; r++) {
        const row: string[] = [];
        for (let c = used.startCol; c <= used.endCol; c++) {
          row.push(typedValueText(view.readCell({ sheet, row: r, col: c }).value));
        }
        data.push(row);
      }
      const rows = applySubtotal(data, { groupCol, valueCols: [...valueCols].sort((a, b) => a - b), fn });
      const destRow = used.endRow + 2;
      rows.forEach((row, ri) => {
        row.values.forEach((value, ci) => {
          host.execute({
            cmd: 'setCell',
            ref: { sheet, row: destRow + ri, col: used.startCol + ci },
            value,
          });
        });
      });
      host.execute({ cmd: 'recalculate' });
      onApplied({ rows, level, destSheet: sheet, destRow });
      setDone(`Wrote ${rows.length} rows (detail + subtotals + grand total) starting at row ${destRow + 1}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Subtotal failed.');
    }
  };

  return (
    <A11yDialog title={<>Subtotal</>} width={480} onClose={onClose}>
        <div className="dialog-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
          <label>
            At each change in (group by)<br />
            <select value={groupCol} onChange={(e) => setGroupCol(Number(e.target.value))} aria-label="Group by column" style={{ width: '100%' }}>
              {headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
            </select>
          </label>
          <label>
            Use function<br />
            <select value={fn} onChange={(e) => setFn(e.target.value as SubtotalFn)} aria-label="Aggregate function">
              {SUBTOTAL_FNS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </label>
          <fieldset style={{ border: '1px solid var(--line-soft)', padding: 8 }}>
            <legend>Add subtotal to</legend>
            {headers.map((h, i) => (
              <label key={i} style={{ display: 'block', fontSize: 13 }}>
                <input type="checkbox" checked={valueCols.includes(i)} onChange={() => toggleValueCol(i)} /> {h}
              </label>
            ))}
          </fieldset>
          <div>
            <strong>Outline level</strong>{' '}
            <button onClick={() => setLevel((l) => stepOutlineLevel(l, -1))} title="Hide Detail">− Hide Detail</button>{' '}
            <button onClick={() => setLevel((l) => stepOutlineLevel(l, 1))} title="Show Detail">+ Show Detail</button>{' '}
            <span style={{ fontSize: 13 }}>Level {level} {level === 1 ? '(grand total only)' : level === 2 ? '(subtotals)' : '(all rows)'}</span>
          </div>
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
