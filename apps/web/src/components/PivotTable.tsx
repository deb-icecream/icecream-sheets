/**
 * PivotTable builder dialog and result view (Insert tab).
 *
 * The builder collects a versioned PivotSpec (data bindings + layout +
 * filters); the view renders the PivotResult matrix. All computation goes
 * through the pivot service component in @icecream-sheets/engine, which
 * reads plain records — the dialog never touches engine internals.
 */
import { useState } from 'react';
import {
  PIVOT_AGGREGATIONS,
  PIVOT_DATE_UNITS,
  PIVOT_SPEC_VERSION,
  pivotToMatrix,
  type PivotAggregation,
  type PivotDateGrouping,
  type PivotDateUnit,
  type PivotGrouping,
  type PivotNumericGrouping,
  type PivotResult,
  type PivotSpec,
  type PivotValueField,
} from '@icecream-sheets/service';
import A11yDialog from './A11yDialog';

interface PivotField {
  name: string;
  /** Distinct display labels in the source data. */
  values: string[];
}

interface PivotTableBuilderProps {
  /** Fields from the source table's header row, with distinct values. */
  fields: PivotField[];
  onClose: () => void;
  onCreate: (spec: PivotSpec) => void;
}

type Area = 'rows' | 'columns' | 'values' | 'filters';

const AREA_LABELS: { id: Area; label: string }[] = [
  { id: 'rows', label: 'Rows' },
  { id: 'columns', label: 'Columns' },
  { id: 'values', label: 'Values' },
  { id: 'filters', label: 'Filters' },
];

/**
 * Guess which grouping kind fits a field from its distinct display values
 * (Excel's Group dialog offers date grouping on date fields and numeric
 * binning on number fields; anything else gets custom value lists).
 */
export function detectPivotGroupKind(values: string[]): 'date' | 'numeric' | 'custom' {
  const nonEmpty = values.map((v) => v.trim()).filter((v) => v !== '');
  if (nonEmpty.length === 0) return 'custom';
  // Numeric first: Date.parse accepts bare numbers ('10' -> a year), and a
  // column of numbers groups numerically in Excel.
  if (nonEmpty.every((v) => Number.isFinite(Number(v)))) return 'numeric';
  if (nonEmpty.every((v) => !Number.isNaN(Date.parse(v)))) return 'date';
  return 'custom';
}

/** Short summary shown on the field chip, e.g. "📅 month" / "# 0-9" / "🏷 3 groups". */
export function groupingSummary(g: PivotGrouping): string {
  if (g.kind === 'date') return `📅 ${g.unit}`;
  if (g.kind === 'numeric') return `# ±${g.by}`;
  return `🏷 ${g.groups.length} group${g.groups.length === 1 ? '' : 's'}`;
}

interface GroupEditorProps {
  field: string;
  values: string[];
  existing: PivotGrouping | undefined;
  onSave: (g: PivotGrouping) => void;
  onClear: () => void;
  onCancel: () => void;
}

/**
 * Excel-style Group dialog for one pivot row/column field: date fields get a
 * unit picker (year/quarter/month/week/day), numeric fields get fixed-width
 * binning, everything else gets custom value→label lists. Writes into the
 * PivotSpec.groupings the engine's applyGroupings() consumes.
 */
function GroupEditor({ field, values, existing, onSave, onClear, onCancel }: GroupEditorProps) {
  const initialKind = existing?.kind ?? detectPivotGroupKind(values);
  const [kind, setKind] = useState<'date' | 'numeric' | 'custom'>(initialKind);
  const [unit, setUnit] = useState<PivotDateUnit>(
    existing?.kind === 'date' ? existing.unit : 'month',
  );
  const [by, setBy] = useState(
    existing?.kind === 'numeric' ? String(existing.by) : '10',
  );
  const [start, setStart] = useState(
    existing?.kind === 'numeric' && existing.start !== undefined ? String(existing.start) : '',
  );
  const [end, setEnd] = useState(
    existing?.kind === 'numeric' && existing.end !== undefined ? String(existing.end) : '',
  );
  const [customGroups, setCustomGroups] = useState<{ label: string; values: string }[]>(
    existing?.kind === 'custom'
      ? existing.groups.map((g) => ({ label: g.label, values: g.values.map(String).join(', ') }))
      : [{ label: '', values: '' }],
  );
  const [error, setError] = useState<string | null>(null);

  const save = (): void => {
    setError(null);
    if (kind === 'date') {
      if (!PIVOT_DATE_UNITS.includes(unit)) {
        setError(`Unknown date unit "${unit}".`);
        return;
      }
      const g: PivotDateGrouping = { field, kind: 'date', unit };
      onSave(g);
      return;
    }
    if (kind === 'numeric') {
      const width = Number(by);
      if (!Number.isFinite(width) || width <= 0) {
        setError('Bin width must be a positive number.');
        return;
      }
      const g: PivotNumericGrouping = { field, kind: 'numeric', by: width };
      const s = start.trim() === '' ? undefined : Number(start);
      const e = end.trim() === '' ? undefined : Number(end);
      if (s !== undefined && !Number.isFinite(s)) {
        setError('Start must be a number.');
        return;
      }
      if (e !== undefined && !Number.isFinite(e)) {
        setError('End must be a number.');
        return;
      }
      if (s !== undefined && e !== undefined && e <= s) {
        setError('End must be greater than start.');
        return;
      }
      if (s !== undefined) g.start = s;
      if (e !== undefined) g.end = e;
      onSave(g);
      return;
    }
    const groups = customGroups
      .map((cg) => ({
        label: cg.label.trim(),
        values: cg.values
          .split(',')
          .map((v) => v.trim())
          .filter((v) => v !== ''),
      }))
      .filter((cg) => cg.label !== '' && cg.values.length > 0);
    if (groups.length === 0) {
      setError('Add at least one group with a label and one or more values.');
      return;
    }
    onSave({ field, kind: 'custom', groups });
  };

  return (
    <div
      style={{
        border: '1px solid #9db8dd',
        borderRadius: 4,
        padding: 8,
        marginTop: 6,
        background: '#f4f8ff',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: 12 }}>Group “{field}”</strong>
        <button type="button" onClick={onCancel} aria-label="Close group editor" style={{ fontSize: 11 }}>
          ✕
        </button>
      </div>
      <div style={{ margin: '6px 0', fontSize: 12 }}>
        <label style={{ marginRight: 8 }}>
          <input
            type="radio"
            name={`group-kind-${field}`}
            checked={kind === 'date'}
            onChange={() => setKind('date')}
          />{' '}
          Date
        </label>
        <label style={{ marginRight: 8 }}>
          <input
            type="radio"
            name={`group-kind-${field}`}
            checked={kind === 'numeric'}
            onChange={() => setKind('numeric')}
          />{' '}
          Numeric
        </label>
        <label>
          <input
            type="radio"
            name={`group-kind-${field}`}
            checked={kind === 'custom'}
            onChange={() => setKind('custom')}
          />{' '}
          Custom
        </label>
      </div>
      {kind === 'date' && (
        <label style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
          Group by{' '}
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value as PivotDateUnit)}
            aria-label="Date grouping unit"
          >
            {PIVOT_DATE_UNITS.map((u) => (
              <option key={u} value={u}>
                {u[0]!.toUpperCase() + u.slice(1)}
              </option>
            ))}
          </select>
        </label>
      )}
      {kind === 'numeric' && (
        <div style={{ fontSize: 12, marginBottom: 6, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <label>
            Bin width{' '}
            <input
              type="number"
              min={0}
              step="any"
              value={by}
              onChange={(e) => setBy(e.target.value)}
              style={{ width: 80 }}
            />
          </label>
          <label>
            Start (optional){' '}
            <input
              type="number"
              step="any"
              value={start}
              placeholder="auto"
              onChange={(e) => setStart(e.target.value)}
              style={{ width: 80 }}
            />
          </label>
          <label>
            End (optional){' '}
            <input
              type="number"
              step="any"
              value={end}
              placeholder="auto"
              onChange={(e) => setEnd(e.target.value)}
              style={{ width: 80 }}
            />
          </label>
        </div>
      )}
      {kind === 'custom' && (
        <div style={{ fontSize: 12, marginBottom: 6 }}>
          {customGroups.map((cg, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
              <input
                type="text"
                value={cg.label}
                placeholder="Group label"
                aria-label={`Group ${i + 1} label`}
                onChange={(e) =>
                  setCustomGroups((prev) => prev.map((p, j) => (j === i ? { ...p, label: e.target.value } : p)))
                }
                style={{ width: 110 }}
              />
              <input
                type="text"
                value={cg.values}
                placeholder="values, comma separated"
                aria-label={`Group ${i + 1} values`}
                onChange={(e) =>
                  setCustomGroups((prev) => prev.map((p, j) => (j === i ? { ...p, values: e.target.value } : p)))
                }
                style={{ flex: 1 }}
              />
              <button
                type="button"
                aria-label={`Remove group ${i + 1}`}
                onClick={() => setCustomGroups((prev) => prev.filter((_, j) => j !== i))}
                style={{ fontSize: 11 }}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setCustomGroups((prev) => [...prev, { label: '', values: '' }])}
            style={{ fontSize: 11 }}
          >
            + Add group
          </button>
        </div>
      )}
      {error && (
        <div role="alert" style={{ color: '#a00', fontSize: 12, marginBottom: 6 }}>
          {error}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" onClick={save} style={{ fontSize: 12 }}>
          Apply grouping
        </button>
        {existing && (
          <button type="button" onClick={onClear} style={{ fontSize: 12 }}>
            Clear
          </button>
        )}
        <button type="button" onClick={onCancel} style={{ fontSize: 12 }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function PivotTableBuilderDialog({ fields, onClose, onCreate }: PivotTableBuilderProps) {
  const [rows, setRows] = useState<string[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [values, setValues] = useState<PivotValueField[]>([]);
  const [filters, setFilters] = useState<string[]>([]);
  /** Per filter field, the checked (included) values. Defaults to all. */
  const [filterSel, setFilterSel] = useState<Record<string, string[]>>({});
  /** Excel-style groupings for row/column fields (PivotSpec.groupings). */
  const [groupings, setGroupings] = useState<PivotGrouping[]>([]);
  /** Field currently open in the Group editor; null when closed. */
  const [groupField, setGroupField] = useState<string | null>(null);

  const fieldByName = (name: string): PivotField | undefined => fields.find((f) => f.name === name);

  const addTo = (area: Area, field: string): void => {
    if (area === 'rows' && !rows.includes(field)) setRows([...rows, field]);
    if (area === 'columns' && !columns.includes(field)) setColumns([...columns, field]);
    if (area === 'filters' && !filters.includes(field)) {
      setFilters([...filters, field]);
      setFilterSel((prev) => ({ ...prev, [field]: fieldByName(field)?.values ?? [] }));
    }
    if (area === 'values' && !values.some((v) => v.field === field)) {
      setValues([...values, { field, aggregation: 'sum' }]);
    }
  };

  const removeFrom = (area: Area, field: string): void => {
    if (area === 'rows') {
      setRows(rows.filter((f) => f !== field));
      setGroupings((prev) => prev.filter((g) => g.field !== field));
      if (groupField === field) setGroupField(null);
    }
    if (area === 'columns') {
      setColumns(columns.filter((f) => f !== field));
      setGroupings((prev) => prev.filter((g) => g.field !== field));
      if (groupField === field) setGroupField(null);
    }
    if (area === 'filters') {
      setFilters(filters.filter((f) => f !== field));
      setFilterSel((prev) => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
    }
    if (area === 'values') setValues(values.filter((v) => v.field !== field));
  };

  const toggleFilterValue = (field: string, value: string): void => {
    setFilterSel((prev) => {
      const cur = prev[field] ?? [];
      const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
      return { ...prev, [field]: next };
    });
  };

  const setAgg = (field: string, aggregation: PivotAggregation): void => {
    setValues(values.map((v) => (v.field === field ? { ...v, aggregation } : v)));
  };

  const areaFields = (area: Area): string[] => {
    if (area === 'rows') return rows;
    if (area === 'columns') return columns;
    if (area === 'filters') return filters;
    return values.map((v) => v.field);
  };

  const groupingFor = (field: string): PivotGrouping | undefined =>
    groupings.find((g) => g.field === field);

  const saveGrouping = (g: PivotGrouping): void => {
    setGroupings((prev) => {
      const rest = prev.filter((x) => x.field !== g.field);
      return [...rest, g];
    });
    setGroupField(null);
  };

  const clearGrouping = (field: string): void => {
    setGroupings((prev) => prev.filter((g) => g.field !== field));
    setGroupField(null);
  };

  const submit = (): void => {
    onCreate({
      version: PIVOT_SPEC_VERSION,
      rows,
      columns,
      values,
      filters: filters.map((field) => ({
        field,
        selected: filterSel[field] ?? fieldByName(field)?.values ?? [],
      })),
      groupings: groupings.length > 0 ? groupings : undefined,
    });
    onClose();
  };

  return (
    <A11yDialog title={<>Create PivotTable</>} width={560} onClose={onClose}>
        <p style={{ fontSize: 12, color: '#555', margin: '0 0 8px' }}>
          Choose fields from the source table (first row is the header). Add fields to
          Rows, Columns, Values and Filters.
        </p>
        <div style={{ display: 'flex', gap: 16 }}>
          <div style={{ flex: 1 }}>
            <strong style={{ fontSize: 12 }}>Fields</strong>
            <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid #ddd', marginTop: 4 }}>
              {fields.map((f) => (
                <div
                  key={f.name}
                  style={{ display: 'flex', alignItems: 'center', padding: '4px 6px', borderBottom: '1px solid #f0f0f0' }}
                >
                  <span style={{ flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis' }} title={f.name}>
                    {f.name}
                  </span>
                  {AREA_LABELS.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      title={`Add to ${a.label}`}
                      onClick={() => addTo(a.id, f.name)}
                      style={{ fontSize: 10, marginLeft: 2, padding: '1px 4px' }}
                    >
                      {a.label[0]}
                    </button>
                  ))}
                </div>
              ))}
              {fields.length === 0 && (
                <div style={{ padding: 12, fontSize: 12, color: '#888' }}>No fields found.</div>
              )}
            </div>
          </div>
          <div style={{ flex: 1.2, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {AREA_LABELS.map((a) => (
              <div key={a.id}>
                <strong style={{ fontSize: 12 }}>{a.label}</strong>
                <div
                  style={{
                    minHeight: 34,
                    border: '1px dashed #bbb',
                    borderRadius: 4,
                    padding: 4,
                    marginTop: 2,
                  }}
                >
                  {areaFields(a.id).map((f) => (
                    <span
                      key={f}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        background: '#e8f0fe',
                        borderRadius: 3,
                        padding: '2px 4px',
                        margin: 2,
                        fontSize: 12,
                      }}
                    >
                      {f}
                      {a.id === 'values' && (
                        <select
                          value={values.find((v) => v.field === f)?.aggregation ?? 'sum'}
                          onChange={(e) => setAgg(f, e.target.value as PivotAggregation)}
                          style={{ fontSize: 11, marginLeft: 4 }}
                          aria-label={`Aggregation for ${f}`}
                        >
                          {PIVOT_AGGREGATIONS.map((agg) => (
                            <option key={agg.id} value={agg.id}>
                              {agg.label}
                            </option>
                          ))}
                        </select>
                      )}
                      {(a.id === 'rows' || a.id === 'columns') && (
                        <button
                          type="button"
                          onClick={() => setGroupField(f)}
                          title={`Group “${f}” (date / numeric / custom)`}
                          aria-label={`Group ${f}`}
                          style={{
                            marginLeft: 4,
                            fontSize: 11,
                            border: 'none',
                            background: 'none',
                            cursor: 'pointer',
                            color: groupingFor(f) ? '#1a56db' : '#666',
                            fontWeight: groupingFor(f) ? 700 : undefined,
                          }}
                        >
                          {groupingFor(f) ? groupingSummary(groupingFor(f)!) : 'Group…'}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => removeFrom(a.id, f)}
                        style={{ marginLeft: 4, fontSize: 11, border: 'none', background: 'none', cursor: 'pointer' }}
                        aria-label={`Remove ${f} from ${a.label}`}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                  {a.id === 'filters' &&
                    filters.map((ff) => (
                      <div key={`fv-${ff}`} style={{ margin: '2px 2px 6px', fontSize: 11 }}>
                        <div style={{ fontWeight: 600 }}>{ff}</div>
                        <div style={{ maxHeight: 64, overflowY: 'auto', paddingLeft: 4 }}>
                          {(fieldByName(ff)?.values ?? []).map((v) => (
                            <label key={v} style={{ display: 'block', cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={(filterSel[ff] ?? []).includes(v)}
                                onChange={() => toggleFilterValue(ff, v)}
                              />{' '}
                              {v}
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                  {areaFields(a.id).length === 0 && (
                    <span style={{ fontSize: 11, color: '#999' }}>Drop fields here</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
        {groupField && (
          <GroupEditor
            field={groupField}
            values={fieldByName(groupField)?.values ?? []}
            existing={groupingFor(groupField)}
            onSave={saveGrouping}
            onClear={() => clearGrouping(groupField)}
            onCancel={() => setGroupField(null)}
          />
        )}
        <div className="dialog-actions">
          <button onClick={submit} disabled={values.length === 0 || fields.length === 0}>
            Create PivotTable
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}

interface PivotTableViewProps {
  pivot: PivotResult;
  title: string;
  onClose: () => void;
  onRefresh: () => void;
  /** Insert a PivotChart bound to this pivot's live result. */
  onInsertChart?: () => void;
  /**
   * Pre-built display matrix. When omitted, `pivotToMatrix(pivot)` is used.
   * Imported XLSX pivots pass their layout here (e.g. the values-on-rows
   * transpose), which the plain PivotResult cannot express.
   */
  matrix?: (string | number | null)[][];
}

function formatCell(v: string | number | null): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    return Number.isInteger(v) ? v.toLocaleString('en-US') : String(Math.round(v * 100) / 100);
  }
  return v;
}

export function PivotTableView({ pivot, title, onClose, onRefresh, onInsertChart, matrix: matrixProp }: PivotTableViewProps) {
  const matrix = matrixProp ?? pivotToMatrix(pivot);
  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid #ccc',
        boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
        padding: 8,
        maxWidth: 640,
        maxHeight: 440,
        overflow: 'auto',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <strong style={{ fontSize: 13 }}>{title}</strong>
        <div>
          {onInsertChart && (
            <button
              type="button"
              onClick={onInsertChart}
              title="Insert a chart bound to this pivot table — it stays in sync on refresh"
              style={{ marginRight: 6 }}
            >
              PivotChart
            </button>
          )}
          <button type="button" onClick={onRefresh} title="Recompute from the source range" style={{ marginRight: 6 }}>
            Refresh
          </button>
          <button type="button" onClick={onClose} aria-label="Close PivotTable">
            ✕
          </button>
        </div>
      </div>
      <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
        <tbody>
          {matrix.map((row, ri) => (
            <tr key={ri} style={{ background: ri === 0 || ri === matrix.length - 1 ? '#f2f6fc' : undefined }}>
              {row.map((cell, ci) => {
                const isHeader = ri === 0 || ci === 0 || ri === matrix.length - 1;
                const Tag = isHeader ? 'th' : 'td';
                return (
                  <Tag
                    key={ci}
                    style={{
                      border: '1px solid #d0d7e3',
                      padding: '4px 8px',
                      textAlign: typeof cell === 'number' ? 'right' : 'left',
                      fontWeight: isHeader ? 600 : undefined,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {formatCell(cell)}
                  </Tag>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 11, color: '#777', marginTop: 6 }}>
        {pivot.filteredRowCount} of {pivot.sourceRowCount} source rows · {pivot.valueLabels.join(', ')}
      </div>
    </div>
  );
}
