/**
 * No-code app builder: web runtime views (design-docs/no-code-app-builder.md §4-§6).
 *
 * The four v1 views (table, detail, form, cards) rendered as React components
 * from an AppSpec against live engine data. The runtime never touches the
 * engine or storage directly: all reads go through host.readRange() with the
 * end user's principal (per-subject filtered, denied cells arrive as #PERM!
 * markers), and all writes go through host.execute() with auth — every
 * mutation passes through authorize() exactly like any other client.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { EngineHost, TypedValue } from '@icecream-sheets/engine';
import {
  ActionError,
  AuthorizationError,
  appTarget,
  applySliceFilter,
  applySubjectFilter,
  coerceValue,
  displayValue,
  dropTrailingBlankRows,
  executeAction,
  isDenied,
  recordsFromValues,
  specColumns,
  viewColumns,
  type ActionInvocation,
  type AppRecord,
  type AppSpec,
  type CellInput,
  type ColumnSpec,
  type RangeBinding,
  type RowMutationPort,
  type ViewSpec,
} from '@icecream-sheets/service';
import { cellRef } from '../engine';
import A11yDialog from './A11yDialog';

// ---------------------------------------------------------------------------
// Web port: RowMutationPort over the engine protocol
// ---------------------------------------------------------------------------

/** The web runtime acts as the signed-in user (v1 single-user principal). */
export const APP_PRINCIPAL = 'user';

function toCellInput(v: TypedValue): CellInput {
  if (v.kind === 'error') return { error: v.code };
  if (v.kind === 'null') return null;
  // In-cell image: text surfaces carry the alt text.
  if (v.kind === 'image') return v.alt;
  return v.value as string | number | boolean;
}

function toEngineInput(v: CellInput): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return null;
  return v;
}

export interface TableSnapshot {
  headers: string[];
  records: AppRecord[];
}

export interface WebAppPort extends RowMutationPort {
  /** Read the bound table through authorize() per cell (permission-model.md §4). */
  readTable(binding: RangeBinding): TableSnapshot;
}

interface Snap {
  value: string | number | boolean | null;
  formula?: string;
}

function snapshotCell(host: EngineHost, sheet: string, row: number, col: number): Snap {
  const cell = host.getView().readCell(cellRef(sheet, row, col));
  const v = cell.value;
  let value: string | number | boolean | null = null;
  if (v.kind === 'number' || v.kind === 'string' || v.kind === 'boolean') {
    value = v.value as string | number | boolean;
  }
  return { value, formula: cell.formula };
}

function writeSnap(
  host: EngineHost,
  sheet: string,
  snap: Snap,
  row: number,
  col: number,
  auth: { principal: string },
): void {
  const ref = cellRef(sheet, row, col);
  const res =
    snap.formula !== undefined
      ? host.execute({ cmd: 'setFormula', ref, formula: snap.formula, auth })
      : host.execute({ cmd: 'setCell', ref, value: snap.value, auth });
  if (!res.ok) throw new ActionError(res.error);
}

/** Create the engine-protocol port the app runtime executes actions through. */
export function createWebAppPort(host: EngineHost, principal: string): WebAppPort {
  const auth = { principal };
  const bindingRange = (b: RangeBinding) => ({
    sheet: b.sheet,
    startRow: b.startRow,
    startCol: b.startCol,
    endRow: Math.max(b.endRow, b.startRow),
    endCol: Math.max(b.endCol, b.startCol),
  });
  const dataStartRow = (b: RangeBinding): number => b.startRow + (b.headerRow === false ? 0 : 1);

  function authorize(action: 'app.read' | 'app.write' | 'app.manage', target: string): void {
    let allowed: boolean;
    try {
      allowed = host.getAuthorizer().authorize(action, target, auth);
    } catch {
      throw new AuthorizationError(principal, action, target);
    }
    if (!allowed) throw new AuthorizationError(principal, action, target);
  }

  function readHeaders(b: RangeBinding): string[] {
    const snap = readTable(b);
    return snap.headers;
  }

  function readTable(binding: RangeBinding): TableSnapshot {
    const grid = host
      .readRange(bindingRange(binding), auth)
      .map((row) => row.map(toCellInput));
    return dropTrailingBlankRows(
      recordsFromValues(grid, { headerRow: binding.headerRow !== false }),
    );
  }

  function colIndex(headers: string[], name: string): number {
    const i = headers.indexOf(name);
    if (i < 0) throw new ActionError(`column "${name}" is not in the bound table`);
    return i;
  }

  return {
    principal,

    authorize,

    readTable,

    rowCount(binding: RangeBinding): number {
      return readTable(binding).records.length;
    },

    insertRow(binding: RangeBinding, index: number, values: Record<string, CellInput>): void {
      const b = binding;
      const headers = readHeaders(b);
      const nCols = headers.length;
      if (nCols === 0) throw new ActionError('bound table has no columns');
      const at = dataStartRow(b) + index;
      const lastData = dataStartRow(b) + this.rowCount(b) - 1;
      // Shift existing rows down within the binding columns (read-shift-write,
      // same protocol pattern as features/sheetOps).
      for (let r = lastData; r >= at; r--) {
        for (let c = 0; c < nCols; c++) {
          writeSnap(host, b.sheet, snapshotCell(host, b.sheet, r, b.startCol + c), r + 1, b.startCol + c, auth);
        }
      }
      for (const [name, v] of Object.entries(values)) {
        const c = colIndex(headers, name);
        const res = host.execute({
          cmd: 'setCell',
          ref: cellRef(b.sheet, at, b.startCol + c),
          value: toEngineInput(v),
          auth,
        });
        if (!res.ok) throw new ActionError(res.error);
      }
    },

    updateRow(binding: RangeBinding, index: number, values: Record<string, CellInput>): void {
      const b = binding;
      const headers = readHeaders(b);
      const row = dataStartRow(b) + index;
      for (const [name, v] of Object.entries(values)) {
        const c = colIndex(headers, name);
        const res = host.execute({
          cmd: 'setCell',
          ref: cellRef(b.sheet, row, b.startCol + c),
          value: toEngineInput(v),
          auth,
        });
        if (!res.ok) throw new ActionError(res.error);
      }
    },

    deleteRow(binding: RangeBinding, index: number): void {
      const b = binding;
      const headers = readHeaders(b);
      const nCols = headers.length;
      const at = dataStartRow(b) + index;
      const lastData = dataStartRow(b) + this.rowCount(b) - 1;
      for (let r = at + 1; r <= lastData; r++) {
        for (let c = 0; c < nCols; c++) {
          writeSnap(host, b.sheet, snapshotCell(host, b.sheet, r, b.startCol + c), r - 1, b.startCol + c, auth);
        }
      }
      for (let c = 0; c < nCols; c++) {
        const res = host.execute({
          cmd: 'setCell',
          ref: cellRef(b.sheet, lastData, b.startCol + c),
          value: null,
          auth,
        });
        if (!res.ok) throw new ActionError(res.error);
      }
    },

    readRows(binding: RangeBinding): AppRecord[] {
      return readTable(binding).records;
    },
  };
}

// ---------------------------------------------------------------------------
// Shared view context
// ---------------------------------------------------------------------------

export interface ViewContext {
  columns: ColumnSpec[];
  records: AppRecord[];
  selected: number | null;
  onSelect: (rowIndex: number | null) => void;
  onNavigate: (viewId: string, rowIndex?: number) => void;
}

function renderCell(col: ColumnSpec, value: CellInput): ReactNode {
  if (isDenied(value)) return <span className="appbuilder-denied" />;
  if (col.type === 'imageUrl' && typeof value === 'string' && /^https?:\/\//.test(value)) {
    return <img src={value} alt="" className="appbuilder-thumb" />;
  }
  if (col.type === 'reference' && typeof value === 'string' && value !== '') {
    return <span className="appbuilder-link">{displayValue(value)}</span>;
  }
  return <span>{displayValue(value)}</span>;
}

// ---------------------------------------------------------------------------
// Table view
// ---------------------------------------------------------------------------

export function AppTableView({ columns, records, selected, onSelect }: ViewContext) : ReactElement {
  return (
    <div className="appbuilder-tablewrap">
      <table className="appbuilder-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.name}>{c.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr
              key={r.rowIndex}
              className={r.rowIndex === selected ? 'selected' : ''}
              onClick={() => onSelect(r.rowIndex === selected ? null : r.rowIndex)}
            >
              {columns.map((c) => (
                <td key={c.name}>{renderCell(c, r.values[c.name] ?? null)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {records.length === 0 && <p className="dialog-hint">No rows match.</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

export function AppDetailView({ columns, records, selected, onSelect }: ViewContext) : ReactElement {
  const idx = records.findIndex((r) => r.rowIndex === selected);
  const record = idx >= 0 ? records[idx] : records[0];
  const pos = record ? records.indexOf(record) : -1;
  const step = (d: number): void => {
    if (records.length === 0) return;
    const next = records[(pos + d + records.length) % records.length];
    if (next) onSelect(next.rowIndex);
  };
  if (!record) return <p className="dialog-hint">No rows match.</p>;
  return (
    <div className="appbuilder-detail">
      <div className="appbuilder-pager">
        <button onClick={() => step(-1)} disabled={records.length < 2} aria-label="Previous record">
          ‹
        </button>
        <span>
          Record {pos + 1} of {records.length}
        </span>
        <button onClick={() => step(1)} disabled={records.length < 2} aria-label="Next record">
          ›
        </button>
        <select
          value={record.rowIndex}
          onChange={(e) => onSelect(Number(e.target.value))}
          aria-label="Choose record"
        >
          {records.map((r, i) => (
            <option key={r.rowIndex} value={r.rowIndex}>
              {i + 1}: {displayValue(r.values[columns[0]?.name ?? ''] ?? null).slice(0, 40) || `Row ${r.rowIndex + 1}`}
            </option>
          ))}
        </select>
      </div>
      <dl className="appbuilder-fields">
        {columns.map((c) => (
          <div key={c.name} className="appbuilder-field">
            <dt>{c.name}</dt>
            <dd>{renderCell(c, record.values[c.name] ?? null)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form view (add / edit with type-driven inputs and validation)
// ---------------------------------------------------------------------------

export interface FormViewProps {
  columns: ColumnSpec[];
  mode: 'add' | 'edit';
  initial?: Record<string, CellInput>;
  submitLabel: string;
  onSubmit: (values: Record<string, CellInput>) => void;
  onCancel: () => void;
}

export function AppFormView({
  columns,
  mode,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: FormViewProps) : ReactElement {
  const [vals, setVals] = useState<Record<string, string | boolean>>(() => {
    const out: Record<string, string | boolean> = {};
    for (const c of columns) {
      const v = initial?.[c.name];
      if (c.type === 'boolean') {
        out[c.name] = v === true || (typeof v === 'string' && /^(true|yes|1)$/i.test(v));
      } else {
        out[c.name] = displayValue(v ?? null);
      }
    }
    return out;
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const set = (name: string, v: string | boolean): void => {
    setVals((prev) => ({ ...prev, [name]: v }));
    setErrors((prev) => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const submit = (): void => {
    const coerced: Record<string, CellInput> = {};
    const errs: Record<string, string> = {};
    for (const c of columns) {
      const raw = vals[c.name];
      try {
        coerced[c.name] =
          c.type === 'boolean'
            ? raw === true
            : coerceValue(c, (typeof raw === 'string' ? raw : String(raw ?? '')) as CellInput);
      } catch (e) {
        errs[c.name] = e instanceof Error ? e.message : String(e);
      }
    }
    setErrors(errs);
    if (Object.keys(errs).length === 0) onSubmit(coerced);
  };

  const inputFor = (c: ColumnSpec): ReactNode => {
    const v = vals[c.name];
    if (c.type === 'boolean') {
      return (
        <input type="checkbox" checked={v === true} onChange={(e) => set(c.name, e.target.checked)} />
      );
    }
    if (c.type === 'numeric') {
      return (
        <input
          type="number"
          value={typeof v === 'string' ? v : ''}
          onChange={(e) => set(c.name, e.target.value)}
        />
      );
    }
    if (c.type === 'date') {
      return (
        <input
          type="date"
          value={typeof v === 'string' ? v.slice(0, 10) : ''}
          onChange={(e) => set(c.name, e.target.value)}
        />
      );
    }
    return (
      <input
        type="text"
        value={typeof v === 'string' ? v : ''}
        placeholder={c.type === 'imageUrl' ? 'https://…' : c.type === 'reference' ? 'Table[key]' : ''}
        onChange={(e) => set(c.name, e.target.value)}
      />
    );
  };

  return (
    <div className="appbuilder-form">
      <h4>{mode === 'add' ? 'Add row' : 'Edit row'}</h4>
      {columns.map((c) => (
        <label key={c.name} className="dialog-field">
          <span>
            {c.name} <em className="appbuilder-coltype">{c.type}</em>
          </span>
          {inputFor(c)}
          {c.type === 'imageUrl' && typeof vals[c.name] === 'string' && (vals[c.name] as string) !== '' && (
            <img src={vals[c.name] as string} alt="" className="appbuilder-thumb" />
          )}
          {errors[c.name] && <span className="appbuilder-field-error">{errors[c.name]}</span>}
        </label>
      ))}
      <div className="dialog-actions">
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" onClick={submit}>
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cards view
// ---------------------------------------------------------------------------

export interface CardsViewProps extends ViewContext {
  view: ViewSpec;
}

export function AppCardsView({ columns, records, view, onNavigate }: CardsViewProps) : ReactElement {
  const titleCol = view.titleColumn ?? columns[0]?.name;
  const subCol = view.subtitleColumn;
  const rest = columns.filter((c) => c.name !== titleCol && c.name !== subCol).slice(0, 4);
  if (records.length === 0) return <p className="dialog-hint">No rows match.</p>;
  return (
    <div className="appbuilder-cards">
      {records.map((r) => {
        const imgCol = columns.find((c) => c.type === 'imageUrl');
        const imgVal = imgCol ? r.values[imgCol.name] : null;
        return (
          <button
            key={r.rowIndex}
            className="appbuilder-card"
            onClick={() => onNavigate('__detail__', r.rowIndex)}
          >
            {typeof imgVal === 'string' && imgVal !== '' && !isDenied(imgVal) && (
              <img src={imgVal} alt="" className="appbuilder-card-img" />
            )}
            <div className="appbuilder-card-title">
              {displayValue(titleCol ? (r.values[titleCol] ?? null) : null) || `Row ${r.rowIndex + 1}`}
            </div>
            {subCol && (
              <div className="appbuilder-card-sub">{displayValue(r.values[subCol] ?? null)}</div>
            )}
            {rest.map((c) => (
              <div key={c.name} className="appbuilder-card-field">
                <span>{c.name}</span>
                <span>{displayValue(r.values[c.name] ?? null)}</span>
              </div>
            ))}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// App runner: navigation + action bar + view hosting
// ---------------------------------------------------------------------------

export interface AppRunnerProps {
  spec: AppSpec;
  host: EngineHost;
  principal?: string;
  /** Called when the runner mutates the spec (e.g. the binding grows). */
  onSpecChange?: (next: AppSpec) => void;
}

interface FormState {
  actionId: string;
  mode: 'add' | 'edit';
  viaView: boolean;
}

export function AppRunner({ spec, host, principal = APP_PRINCIPAL, onSpecChange }: AppRunnerProps) : ReactElement {
  const [liveSpec, setLiveSpec] = useState(spec);
  const [viewId, setViewId] = useState(spec.navigation.initialViewId);
  const [selected, setSelected] = useState<number | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ actionId: string; rowIndex: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const port = useMemo(() => createWebAppPort(host, principal), [host, principal]);

  // Materialized refresh: re-read the bound table on every engine event.
  useEffect(() => host.subscribe(() => setTick((t) => t + 1)), [host]);

  const applySpec = (next: AppSpec): void => {
    setLiveSpec(next);
    onSpecChange?.(next);
  };

  const dataResult = useMemo(() => {
    try {
      port.authorize('app.read', appTarget(liveSpec));
      return { data: port.readTable(liveSpec.dataSource.binding), error: null as string | null };
    } catch (e) {
      return {
        data: { headers: [] as string[], records: [] as AppRecord[] },
        error: e instanceof Error ? e.message : String(e),
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port, liveSpec, tick]);
  const data = dataResult.data;
  const authError = dataResult.error;

  const filtered = useMemo(
    () =>
      applySubjectFilter(specColumns(liveSpec), data.records, {
        principal,
        tableId: liveSpec.dataSource.binding.tableId,
      }),
    [liveSpec, data, principal],
  );

  const order = liveSpec.navigation.viewOrder ?? liveSpec.views.map((v) => v.id);
  const views = order
    .map((id) => liveSpec.views.find((v) => v.id === id))
    .filter((v): v is ViewSpec => v !== undefined);
  const view: ViewSpec = views.find((v) => v.id === viewId) ?? views[0] ?? liveSpec.views[0]!;
  const viewCols = useMemo(() => viewColumns(view, filtered.columns), [view, filtered.columns]);
  const records = useMemo(() => applySliceFilter(filtered.records, view.filter), [filtered.records, view.filter]);

  const detailViewId = liveSpec.views.find((v) => v.kind === 'detail')?.id;

  const runInvocation = (inv: ActionInvocation): void => {
    setError(null);
    try {
      const outcome = executeAction(port, inv);
      // Keep the binding in sync with the table shape after structural writes.
      const b = liveSpec.dataSource.binding;
      const dataStart = b.startRow + (b.headerRow === false ? 0 : 1);
      if (inv.actionId && liveSpec.actions.find((a) => a.id === inv.actionId)?.kind === 'addRow') {
        const needEnd = dataStart + (outcome.rowIndex ?? 0);
        if (needEnd > b.endRow) applySpec({ ...liveSpec, dataSource: { ...liveSpec.dataSource, binding: { ...b, endRow: needEnd } } });
      }
      if (inv.actionId && liveSpec.actions.find((a) => a.id === inv.actionId)?.kind === 'deleteRow') {
        const shrink = Math.max(b.startRow, b.endRow - 1);
        if (shrink !== b.endRow) applySpec({ ...liveSpec, dataSource: { ...liveSpec.dataSource, binding: { ...b, endRow: shrink } } });
      }
      setTick((t) => t + 1);
      if (outcome.navigatedTo) setViewId(outcome.navigatedTo);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  };

  const dispatch = (actionId: string, args?: { rowIndex?: number; values?: Record<string, CellInput> }): void => {
    const action = liveSpec.actions.find((a) => a.id === actionId);
    if (!action) {
      setError(`Unknown action "${actionId}"`);
      return;
    }
    setError(null);
    if (action.kind === 'navigate') {
      if (action.targetViewId) setViewId(action.targetViewId);
      return;
    }
    if (action.kind === 'addRow' || action.kind === 'editRow') {
      const rowIndex = args?.rowIndex ?? selected;
      if (action.kind === 'editRow' && rowIndex == null) {
        setError('Select a row to edit.');
        return;
      }
      const formView = liveSpec.views.find((v) => v.kind === 'form');
      const mode = action.kind === 'addRow' ? 'add' : 'edit';
      if (formView && (formView.formMode ?? 'both').includes(mode)) {
        setForm({ actionId, mode, viaView: true });
        setViewId(formView.id);
      } else {
        setForm({ actionId, mode, viaView: false });
      }
      return;
    }
    if (action.kind === 'deleteRow') {
      const rowIndex = args?.rowIndex ?? selected;
      if (rowIndex == null) {
        setError('Select a row to delete.');
        return;
      }
      setConfirmDelete({ actionId, rowIndex });
    }
  };

  const submitForm = (values: Record<string, CellInput>): void => {
    if (!form) return;
    try {
      runInvocation({
        spec: liveSpec,
        actionId: form.actionId,
        rowIndex: form.mode === 'edit' ? (selected ?? undefined) : undefined,
        values,
        confirmed: true,
      });
      setForm(null);
      if (form.viaView) {
        const table = liveSpec.views.find((v) => v.kind === 'table');
        if (table) setViewId(table.id);
      }
    } catch {
      // runInvocation already surfaced the error.
    }
  };

  const confirmDeleteRow = (): void => {
    if (!confirmDelete) return;
    try {
      runInvocation({ spec: liveSpec, actionId: confirmDelete.actionId, rowIndex: confirmDelete.rowIndex, confirmed: true });
      setSelected(null);
    } catch {
      // surfaced
    }
    setConfirmDelete(null);
  };

  const navigate = (target: string, rowIndex?: number): void => {
    if (target === '__detail__') {
      if (detailViewId) {
        if (rowIndex !== undefined) setSelected(rowIndex);
        setViewId(detailViewId);
      }
      return;
    }
    const action = liveSpec.actions.find((a) => a.kind === 'navigate' && a.targetViewId === target);
    if (action) dispatch(action.id);
    else setViewId(target);
  };

  const ctx: ViewContext = {
    columns: viewCols,
    records,
    selected,
    onSelect: setSelected,
    onNavigate: navigate,
  };

  const formAction = form ? liveSpec.actions.find((a) => a.id === form.actionId) : null;
  const editingRecord =
    form?.mode === 'edit' && selected != null
      ? filtered.records.find((r) => r.rowIndex === selected)
      : undefined;

  return (
    <div className="appbuilder">
      <nav className="appbuilder-nav" aria-label="App views">
        {views.map((v) => (
          <button
            key={v.id}
            className={v.id === view.id ? 'active' : ''}
            onClick={() => {
              setViewId(v.id);
              setForm(null);
            }}
          >
            {v.title}
          </button>
        ))}
      </nav>

      {(error ?? authError) && (
        <div className="dialog-error" role="alert">
          {error ?? authError}
        </div>
      )}

      <div className="appbuilder-view">
        {view.kind === 'table' && <AppTableView {...ctx} />}
        {view.kind === 'detail' && <AppDetailView {...ctx} />}
        {view.kind === 'cards' && <AppCardsView {...ctx} view={view} />}
        {view.kind === 'form' &&
          (form ? (
            <AppFormView
              columns={viewCols}
              mode={form.mode}
              initial={editingRecord?.values}
              submitLabel={form.mode === 'add' ? 'Add row' : 'Save changes'}
              onSubmit={submitForm}
              onCancel={() => {
                setForm(null);
                const table = liveSpec.views.find((v) => v.kind === 'table');
                if (table) setViewId(table.id);
              }}
            />
          ) : (
            <div className="appbuilder-form-launch">
              <p className="dialog-hint">Use the action bar below to add or edit a row.</p>
              <div className="dialog-actions" style={{ justifyContent: 'flex-start' }}>
                {liveSpec.actions
                  .filter((a) => a.kind === 'addRow')
                  .map((a) => (
                    <button key={a.id} className="primary" onClick={() => dispatch(a.id)}>
                      {a.label}
                    </button>
                  ))}
              </div>
            </div>
          ))}
      </div>

      <div className="appbuilder-actionbar">
        {liveSpec.actions
          .filter((a) => a.kind !== 'navigate' || !views.some((v) => v.id === a.targetViewId))
          .map((a) => (
            <button
              key={a.id}
              className={a.kind === 'deleteRow' ? 'danger' : a.kind === 'addRow' ? 'primary' : ''}
              disabled={(a.kind === 'editRow' || a.kind === 'deleteRow') && selected == null}
              title={
                (a.kind === 'editRow' || a.kind === 'deleteRow') && selected == null
                  ? 'Select a row first'
                  : a.label
              }
              onClick={() => dispatch(a.id)}
            >
              {a.label}
            </button>
          ))}
      </div>

      {form && !form.viaView && formAction && (
        <A11yDialog title={<>{formAction.label}</>} onClose={() => setForm(null)}>
            <AppFormView
              columns={viewCols}
              mode={form.mode}
              initial={editingRecord?.values}
              submitLabel={form.mode === 'add' ? 'Add row' : 'Save changes'}
              onSubmit={submitForm}
              onCancel={() => setForm(null)}
            />
        </A11yDialog>
      )}

      {confirmDelete && (
        <A11yDialog title="Delete row?" onClose={() => setConfirmDelete(null)}>
            <p className="dialog-hint">
              This permanently deletes the selected row from {liveSpec.dataSource.binding.sheet}. This
              cannot be undone.
            </p>
            <div className="dialog-actions">
              <button onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="danger" onClick={confirmDeleteRow}>
                Delete row
              </button>
            </div>
        </A11yDialog>
      )}
    </div>
  );
}

export interface AppRunnerDialogProps extends AppRunnerProps {
  onClose: () => void;
}

/** Full-screen dialog hosting a running app. */
export function AppRunnerDialog({ onClose, spec, ...rest }: AppRunnerDialogProps) : ReactElement {
  return (
    <A11yDialog
      title={<>{spec.name}</>}
      onClose={onClose}
      className="appbuilder-dialog"
      width="min(860px, 94vw)"
    >
      <AppRunner spec={spec} {...rest} />
    </A11yDialog>
  );
}
