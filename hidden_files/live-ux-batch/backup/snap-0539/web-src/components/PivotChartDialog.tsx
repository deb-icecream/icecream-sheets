/**
 * PivotChart (Insert > Charts > PivotChart).
 *
 * A chart bound to a PivotTable: pick an existing pivot, then the standard
 * ChartDialog opens with its kind/range controls reading from the pivot's
 * result matrix (via pivotToMatrix) instead of the grid. The parent stores
 * the returned (spec, pivotId) pair with a real pivot binding
 * (spec.pivot = { pivotId, valueIndex }) so the chart re-derives its series
 * from the live pivot result on every render — it stays in sync when the
 * pivot refreshes or a slicer changes, with no snapshot copies.
 *
 * The dialog previews against a virtual sheet name ("Pivot:<title>"); the
 * parent replaces that preview-only range with the pivot's real source
 * range before storing the spec.
 */
import { useMemo, useState } from 'react';
import ChartDialog from './ChartDialog';
import A11yDialog from './A11yDialog';
import {
  pivotToMatrix,
  type CellReader,
  type ChartRange,
  type ChartSpec,
  type PivotResult,
} from '@icecream-sheets/service';

export interface PivotChartSource {
  id: number;
  title: string;
  result: PivotResult;
}

export interface PivotChartDialogProps {
  pivots: PivotChartSource[];
  onClose: () => void;
  /** Parent stores the spec together with pivotId for refresh binding. */
  onCreate: (spec: ChartSpec, pivotId: number) => void;
}

/** Virtual sheet name marking a chart range as pivot-bound. */
export function pivotChartSheetName(title: string): string {
  return `Pivot:${title}`;
}

/** Build a CellReader over a pivot result matrix. */
export function pivotMatrixReader(result: PivotResult): CellReader {
  const matrix = pivotToMatrix(result);
  return (row: number, col: number) => {
    const v = matrix[row]?.[col];
    if (typeof v === 'number' && Number.isFinite(v)) return { text: String(v), num: v };
    if (typeof v === 'string') {
      const t = v.trim();
      const num = t !== '' && !Number.isNaN(Number(t)) ? Number(t) : null;
      return { text: v, num };
    }
    return { text: '', num: null };
  };
}

/** Default chart range over a pivot matrix (drops the grand-total row). */
export function pivotChartRange(result: PivotResult, sheet: string): ChartRange {
  const matrix = pivotToMatrix(result);
  const rows = matrix.length;
  const cols = Math.max(0, ...matrix.map((r) => r.length));
  return {
    sheet,
    startRow: 0,
    startCol: 0,
    endRow: Math.max(0, rows - 2),
    endCol: Math.max(0, cols - 1),
  };
}

export function PivotChartDialog({ pivots, onClose, onCreate }: PivotChartDialogProps) {
  const [pivotId, setPivotId] = useState<number | null>(
    pivots.length === 1 ? pivots[0].id : null,
  );
  const pivot = pivots.find((p) => p.id === pivotId) ?? null;

  const { read, range, sheet } = useMemo(() => {
    if (!pivot) return { read: null, range: null, sheet: '' };
    const s = pivotChartSheetName(pivot.title);
    return { read: pivotMatrixReader(pivot.result), range: pivotChartRange(pivot.result, s), sheet: s };
  }, [pivot]);

  if (!pivot || !read || !range) {
    return (
      <A11yDialog title={<>PivotChart</>} onClose={onClose}>
          {pivots.length === 0 ? (
            <div className="dialog-hint">
              Create a PivotTable first (Insert → PivotTable), then chart it here.
            </div>
          ) : (
            <>
              <div className="dialog-hint">Choose the PivotTable to chart:</div>
              {pivots.map((p) => (
                <div key={p.id} className="dialog-row">
                  <button type="button" onClick={() => setPivotId(p.id)} style={{ minWidth: 200, textAlign: 'left' }}>
                    {p.title}
                  </button>
                </div>
              ))}
            </>
          )}
          <div className="dialog-actions">
            <button onClick={onClose}>Close</button>
          </div>
        </A11yDialog>
    );
  }

  return (
    <ChartDialog
      sheet={sheet}
      initialKind="column-clustered"
      initialRange={range}
      read={read}
      onCreate={(spec) => {
        onCreate(spec, pivot.id);
        onClose();
      }}
      onClose={onClose}
    />
  );
}
