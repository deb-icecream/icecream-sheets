/**
 * Group-by View dialog (Data > Data Tools > Group-by View).
 *
 * Pick group fields, value fields and aggregations over the active sheet's
 * used range; the dialog computes the pivot matrix via features/groupBy.ts
 * and reports it through onApply so the parent can write it to a new
 * sheet. Optional date/numeric grouping operators per group field.
 */
import { useState } from 'react';
import type { EngineHost } from '@icecream-sheets/engine';
import { PIVOT_AGGREGATIONS, type PivotAggregation, type PivotGrouping, type PivotDateUnit } from '@icecream-sheets/service';
import A11yDialog from './A11yDialog';
import { typedValueText } from '../features/typedText';
import { groupByView } from '../features/groupBy';

interface GroupByDialogProps {
  host: EngineHost;
  sheet: string;
  onClose: () => void;
  onApply: (result: { matrix: (string | number | null)[][]; title: string }) => void;
}

const DATE_UNITS: PivotDateUnit[] = ['year', 'quarter', 'month', 'week', 'day'];

export default function GroupByDialog({ host, sheet, onClose, onApply }: GroupByDialogProps) {
  const used = host.getView().usedRange(sheet);
  const headers: string[] = [];
  const dataRows: unknown[][] = [];
  if (used) {
    const view = host.getView();
    for (let c = used.startCol; c <= used.endCol; c++) {
      headers.push(
        typedValueText(view.readCell({ sheet, row: used.startRow, col: c }).value) || `Column ${c + 1}`,
      );
    }
    for (let r = used.startRow + 1; r <= used.endRow; r++) {
      const row: unknown[] = [];
      for (let c = used.startCol; c <= used.endCol; c++) {
        const cell = view.readCell({ sheet, row: r, col: c });
        const v = cell.value;
        row.push(v.kind === 'number' || v.kind === 'string' || v.kind === 'boolean' ? v.value : null);
      }
      dataRows.push(row);
    }
  }

  const [groupFields, setGroupFields] = useState<string[]>(headers.length > 0 ? [headers[0]!] : []);
  const [valueFields, setValueFields] = useState<{ field: string; aggregation: PivotAggregation }[]>(
    headers.length > 1 ? [{ field: headers[1]!, aggregation: 'sum' }] : [],
  );
  const [groupOps, setGroupOps] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  const toggleGroup = (h: string): void => {
    setGroupFields((prev) => (prev.includes(h) ? prev.filter((x) => x !== h) : [...prev, h]));
  };

  const apply = (): void => {
    setError('');
    try {
      if (!used) throw new Error('The sheet is empty.');
      const groupings: PivotGrouping[] = [];
      for (const f of groupFields) {
        const op = groupOps[f];
        if (op === 'date-month') groupings.push({ field: f, kind: 'date', unit: 'month' });
        else if (op === 'date-quarter') groupings.push({ field: f, kind: 'date', unit: 'quarter' });
        else if (op === 'date-year') groupings.push({ field: f, kind: 'date', unit: 'year' });
      }
      const result = groupByView(headers, dataRows, {
        groupFields,
        valueFields,
        groupings: groupings.length > 0 ? groupings : undefined,
      });
      onApply(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <A11yDialog title="Group-by View" onClose={onClose} width={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Group by</div>
          {headers.map((h) => (
            <label key={h} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
              <input type="checkbox" checked={groupFields.includes(h)} onChange={() => toggleGroup(h)} />
              <span style={{ minWidth: 160 }}>{h}</span>
              {groupFields.includes(h) && (
                <select
                  value={groupOps[h] ?? 'exact'}
                  onChange={(e) => setGroupOps((prev) => ({ ...prev, [h]: e.target.value }))}
                  aria-label={`Grouping for ${h}`}
                >
                  <option value="exact">Exact values</option>
                  <option value="date-year">Date: by year</option>
                  <option value="date-quarter">Date: by quarter</option>
                  <option value="date-month">Date: by month</option>
                </select>
              )}
            </label>
          ))}
        </div>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Values</div>
          {valueFields.map((vf, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
              <select
                value={vf.field}
                onChange={(e) =>
                  setValueFields((prev) => prev.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))
                }
                aria-label="Value field"
              >
                {headers.map((h) => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
              <select
                value={vf.aggregation}
                onChange={(e) =>
                  setValueFields((prev) =>
                    prev.map((x, j) => (j === i ? { ...x, aggregation: e.target.value as PivotAggregation } : x)),
                  )
                }
                aria-label="Aggregation"
              >
                {PIVOT_AGGREGATIONS.map((a) => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
              </select>
              <button type="button" onClick={() => setValueFields((prev) => prev.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            disabled={headers.length === 0}
            onClick={() => setValueFields((prev) => [...prev, { field: headers[0]!, aggregation: 'sum' }])}
          >
            Add value field
          </button>
        </div>
        {error !== '' && <div role="alert" style={{ color: 'var(--error, #c00)' }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" onClick={apply}>Create view</button>
        </div>
      </div>
    </A11yDialog>
  );
}

export { DATE_UNITS };
