/**
 * Recommended Charts and Recommended PivotTables dialogs (Insert tab).
 *
 * Recommended Charts analyzes the selected range's shape (label vs numeric
 * columns, date-like labels) with features/recommend.ts, shows the top 3
 * chart kinds with live previews rendered by the real chart engine
 * (extractSeries -> buildChartConfig -> ChartCanvas), and hands the chosen
 * kind + range to the parent (which opens the normal chart flow).
 *
 * Recommended PivotTables proposes row/value field combos for the source
 * table, previews each with the real pivot engine (createPivot), and hands
 * the chosen PivotSpec to the parent (which runs its normal pivot-create
 * path).
 */
import { useMemo } from 'react';
import ChartCanvas from './ChartCanvas';
import A11yDialog from './A11yDialog';
import {
  buildChartConfig,
  createPivot,
  extractSeries,
  kindLabel,
  makeChartSpec,
  pivotToMatrix,
  type CellReader,
  type ChartKind,
  type ChartRange,
  type PivotSpec,
} from '@icecream-sheets/service';
import {
  recommendCharts,
  recommendPivots,
  type PivotSourceProfile,
} from '../features/recommend';

// ---------------------------------------------------------------------------
// Recommended Charts
// ---------------------------------------------------------------------------

export interface RecommendedChartsDialogProps {
  range: ChartRange;
  read: CellReader;
  onClose: () => void;
  /** Parent opens its chart flow with this kind + range. */
  onPick: (kind: ChartKind, range: ChartRange) => void;
}

export function RecommendedChartsDialog({ range, read, onClose, onPick }: RecommendedChartsDialogProps) {
  const recs = useMemo(() => recommendCharts(read, range), [read, range]);

  const previews = useMemo(
    () =>
      recs.map((r) => {
        try {
          const draft = makeChartSpec({ kind: r.kind, range, title: kindLabel(r.kind) });
          const series = extractSeries(read, range);
          const built = buildChartConfig(draft, series);
          return { rec: r, config: built.config, error: null as string | null };
        } catch (e) {
          return { rec: r, config: null, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    [recs, read, range],
  );

  return (
    <A11yDialog title={<>Recommended Charts</>} width={720} onClose={onClose}>
        <div className="dialog-hint">
          Based on the shape of your data — pick one to fine-tune it in the chart dialog.
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          {previews.map(({ rec, config, error }) => (
            <button
              key={rec.kind}
              type="button"
              onClick={() => {
                onPick(rec.kind, range);
                onClose();
              }}
              style={{
                flex: 1,
                border: '1px solid #ccc',
                background: '#fff',
                padding: 8,
                cursor: 'pointer',
                textAlign: 'left',
              }}
              title={`Use ${kindLabel(rec.kind)}`}
            >
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{kindLabel(rec.kind)}</div>
              {config ? (
                <ChartCanvas config={config} width={200} height={150} title={kindLabel(rec.kind)} />
              ) : (
                <div style={{ fontSize: 11, color: '#b00020' }}>Preview unavailable: {error}</div>
              )}
              <div style={{ fontSize: 11, color: '#555', marginTop: 4 }}>{rec.reason}</div>
            </button>
          ))}
          {previews.length === 0 && (
            <div className="dialog-hint">Select a range with data first.</div>
          )}
        </div>
        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}

// ---------------------------------------------------------------------------
// Recommended PivotTables
// ---------------------------------------------------------------------------

export interface RecommendedPivotTablesDialogProps {
  /** Source table profile (headers, distinct values, numeric fields). */
  profile: PivotSourceProfile;
  /** Raw records for the live preview (same records the pivot builder uses). */
  records: Record<string, unknown>[];
  onClose: () => void;
  /** Parent runs its normal pivot-create path with this spec. */
  onPick: (spec: PivotSpec) => void;
}

export function RecommendedPivotTablesDialog({
  profile,
  records,
  onClose,
  onPick,
}: RecommendedPivotTablesDialogProps) {
  const recs = useMemo(() => recommendPivots(profile), [profile]);

  const previews = useMemo(
    () =>
      recs.map((r) => {
        try {
          const result = createPivot(records, r.spec);
          return { rec: r, matrix: pivotToMatrix(result).slice(0, 7), error: null as string | null };
        } catch (e) {
          return { rec: r, matrix: null, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    [recs, records],
  );

  return (
    <A11yDialog title={<>Recommended PivotTables</>} width={720} onClose={onClose}>
        <div className="dialog-hint">
          Suggested summaries of your table — pick one to create it.
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'stretch' }}>
          {previews.map(({ rec, matrix, error }) => (
            <button
              key={rec.title}
              type="button"
              onClick={() => {
                onPick(rec.spec);
                onClose();
              }}
              style={{
                flex: 1,
                border: '1px solid #ccc',
                background: '#fff',
                padding: 8,
                cursor: 'pointer',
                textAlign: 'left',
              }}
              title={`Create: ${rec.title}`}
            >
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{rec.title}</div>
              {matrix ? (
                <table style={{ borderCollapse: 'collapse', fontSize: 10, width: '100%', marginBottom: 4 }}>
                  <tbody>
                    {matrix.map((row, ri) => (
                      <tr key={ri}>
                        {row.slice(0, 4).map((cell, ci) => (
                          <td
                            key={ci}
                            style={{
                              border: '1px solid #ddd',
                              padding: '2px 4px',
                              background: ri === 0 ? '#f2f6fc' : undefined,
                              maxWidth: 90,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {cell === null || cell === undefined ? '' : String(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div style={{ fontSize: 11, color: '#b00020' }}>Preview unavailable: {error}</div>
              )}
              <div style={{ fontSize: 11, color: '#555' }}>{rec.reason}</div>
            </button>
          ))}
          {previews.length === 0 && (
            <div className="dialog-hint">No strong pivot candidates in this table.</div>
          )}
        </div>
        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}
