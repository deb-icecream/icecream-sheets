/**
 * No-code app builder: builder UI (design-docs/no-code-app-builder.md §3).
 *
 * Flow: pick data source (a table/range on a sheet) -> choose views ->
 * configure (titles, columns) -> preview against live engine data ->
 * create. The generated spec is validated before it is handed to the host,
 * which persists it in the service metadata store.
 */
import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { EngineHost } from '@icecream-sheets/engine';
import {
  APP_TEMPLATES,
  generateAppSpec,
  getAppTemplate,
  inferColumns,
  newAppId,
  validateAppSpec,
  type AppSpec,
  type ColumnSpec,
  type RangeBinding,
  type ViewKind,
  type ViewSpec,
  type CellInput,
} from '@icecream-sheets/service';
import { AppRunner } from './AppViews';
import A11yDialog from './A11yDialog';

export interface AppBuilderDialogProps {
  host: EngineHost;
  sheets: string[];
  initialSheet: string;
  onClose: () => void;
  onCreate: (spec: AppSpec) => void;
}

const VIEW_KIND_LABELS: { kind: ViewKind; label: string; hint: string }[] = [
  { kind: 'table', label: 'Table', hint: 'Grid of all rows' },
  { kind: 'detail', label: 'Detail', hint: 'One record at a time' },
  { kind: 'form', label: 'Form', hint: 'Add / edit with type-driven inputs' },
  { kind: 'cards', label: 'Cards', hint: 'Card per row' },
];

const STEPS = ['Data source', 'Views', 'Configure', 'Preview'] as const;

function readPreviewGrid(
  host: EngineHost,
  sheet: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): CellInput[][] {
  try {
    const view = host.getView();
    return view
      .readRangeValues({ sheet, startRow, startCol, endRow, endCol })
      .map((row) =>
        row.map((v): CellInput => {
          if (v.kind === 'error') return { error: v.code };
          if (v.kind === 'image') return v.src;
          if (v.kind === 'null') return null;
          return v.value;
        }),
      );
  } catch {
    return [];
  }
}

export function AppBuilderDialog({
  host,
  sheets,
  initialSheet,
  onClose,
  onCreate,
}: AppBuilderDialogProps): ReactElement {
  const [step, setStep] = useState(0);
  const [name, setName] = useState('My app');
  const [sheet, setSheet] = useState(initialSheet);
  // 1-based inputs, converted to 0-based bindings.
  const [startRow1, setStartRow1] = useState(1);
  const [startCol1, setStartCol1] = useState(1);
  const [endRow1, setEndRow1] = useState(20);
  const [endCol1, setEndCol1] = useState(6);
  const [headerRow, setHeaderRow] = useState(true);
  const [enabledViews, setEnabledViews] = useState<ViewKind[]>(['table', 'detail', 'form', 'cards']);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [hiddenCols, setHiddenCols] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  /**
   * Start-from-template (product-owned sample templates, §7): when set, the
   * builder instantiates the template spec instead of generating one from
   * the wizard — the spec is copied and its range binding is pointed at the
   * sheet chosen below.
   */
  const [templateId, setTemplateId] = useState<string | null>(null);

  const binding: RangeBinding = useMemo(
    () => ({
      sheet,
      startRow: Math.max(0, startRow1 - 1),
      startCol: Math.max(0, startCol1 - 1),
      endRow: Math.max(Math.max(0, startRow1 - 1), endRow1 - 1),
      endCol: Math.max(Math.max(0, startCol1 - 1), endCol1 - 1),
      headerRow,
    }),
    [sheet, startRow1, startCol1, endRow1, endCol1, headerRow],
  );

  const preview = useMemo(
    () =>
      readPreviewGrid(host, binding.sheet, binding.startRow, binding.startCol, binding.endRow, binding.endCol),
    [host, binding],
  );

  const columns: ColumnSpec[] = useMemo(() => {
    if (preview.length === 0) return [];
    if (!headerRow) {
      const width = preview[0]?.length ?? 0;
      const headers = Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
      return inferColumns(headers, preview);
    }
    const headers = (preview[0] ?? []).map((h, i) =>
      typeof h === 'string' && h.trim() !== '' ? h.trim() : `Column ${i + 1}`,
    );
    return inferColumns(headers, preview.slice(1));
  }, [preview, headerRow]);

  const toggleView = (kind: ViewKind): void =>
    setEnabledViews((prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]));

  const pickTemplate = (id: string): void => {
    const t = getAppTemplate(id);
    if (!t) return;
    setTemplateId(id);
    setName(t.name);
    // Point the template at the suggested sheet when the workbook has it;
    // otherwise keep the current sheet and the binding is retargeted there.
    if (sheets.includes(t.suggestedSheet)) setSheet(t.suggestedSheet);
    setError(null);
  };

  const clearTemplate = (): void => setTemplateId(null);

  /** Instantiate the picked template: copy the spec, retarget its range binding at the chosen sheet. */
  const instantiateTemplate = (): AppSpec => {
    const t = templateId ? getAppTemplate(templateId) : undefined;
    if (!t) throw new Error('unknown template');
    const spec = JSON.parse(JSON.stringify(t.spec)) as AppSpec;
    spec.name = name.trim() === '' ? t.name : name.trim();
    spec.dataSource = {
      ...spec.dataSource,
      binding: { ...spec.dataSource.binding, sheet },
    };
    const validated = validateAppSpec(spec);
    if (!validated.ok) throw new Error(validated.errors.join('; '));
    return validated.spec;
  };

  const buildDraft = (): AppSpec => {
    if (templateId) return instantiateTemplate();
    const base = generateAppSpec(name.trim() === '' ? 'My app' : name.trim(), binding, columns, {
      id: newAppId(),
    });
    const views: ViewSpec[] = base.views
      .filter((v) => enabledViews.includes(v.kind))
      .map((v) => {
        const next: ViewSpec = { ...v };
        const title = titles[v.kind];
        if (title && title.trim() !== '') next.title = title.trim();
        if (hiddenCols.length > 0) {
          const shown = (v.columns ?? []).filter((c) => !hiddenCols.includes(c));
          if (shown.length > 0) next.columns = shown;
        }
        return next;
      });
    const viewIds = new Set(views.map((v) => v.id));
    const actions = base.actions.filter(
      (a) => a.kind !== 'navigate' || (a.targetViewId && viewIds.has(a.targetViewId)),
    );
    const draft: AppSpec = {
      ...base,
      views,
      actions,
      navigation: {
        initialViewId: views[0]?.id ?? 'view_table',
        viewOrder: views.map((v) => v.id),
      },
    };
    const validated = validateAppSpec(draft);
    if (!validated.ok) throw new Error(validated.errors.join('; '));
    return validated.spec;
  };

  const canNext = (): boolean => {
    if (step === 0) return columns.length > 0;
    if (step === 1) return enabledViews.length > 0;
    return true;
  };

  const handleCreate = (): void => {
    try {
      setError(null);
      onCreate(buildDraft());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const draftForPreview = (): AppSpec | null => {
    try {
      return buildDraft();
    } catch {
      return null;
    }
  };

  const usingTemplate = templateId !== null;
  const activeTemplate = usingTemplate ? getAppTemplate(templateId!) : undefined;

  return (
    <A11yDialog title="Build app" width={640} onClose={onClose} className="appbuilder-dialog">

        {!usingTemplate && (
          <ol className="appbuilder-steps">
            {STEPS.map((s, i) => (
              <li key={s} className={i === step ? 'active' : i < step ? 'done' : ''}>
                {s}
              </li>
            ))}
          </ol>
        )}

        {error && (
          <div className="dialog-error" role="alert">
            {error}
          </div>
        )}

        {usingTemplate && activeTemplate ? (
          <div className="appbuilder-step">
            <p className="dialog-hint">
              Starting from the <strong>{activeTemplate.name}</strong> template. Pick the sheet
              holding your table — the template's views are copied and pointed at it.
            </p>
            <label className="dialog-field">
              <span>Sheet</span>
              <select value={sheet} onChange={(e) => setSheet(e.target.value)}>
                {sheets.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="dialog-field">
              <span>App name</span>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            </label>
            <p className="dialog-hint">
              Your table should have these columns: {activeTemplate.suggestedHeaders.join(', ')}.
            </p>
            <button type="button" onClick={clearTemplate}>
              ← Back to the builder wizard
            </button>
          </div>
        ) : (
          <>
            {step === 0 && (
              <div className="appbuilder-step">
                <h4>Start from a template</h4>
                <div className="appbuilder-templates" style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
                  {APP_TEMPLATES.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => pickTemplate(t.id)}
                      style={{
                        textAlign: 'left',
                        border: '1px solid #d0d7e3',
                        borderRadius: 6,
                        padding: '8px 10px',
                        background: '#f8fafd',
                        cursor: 'pointer',
                      }}
                    >
                      <strong style={{ fontSize: 13 }}>{t.name}</strong>
                      <div style={{ fontSize: 12, color: '#555', marginTop: 2 }}>{t.description}</div>
                      <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                        Columns: {t.suggestedHeaders.join(', ')}
                      </div>
                    </button>
                  ))}
                </div>
                <h4>Or build from scratch</h4>
            <p className="dialog-hint">
              Point the builder at a table: the used range becomes the app's data source, and column
              types are inferred from the typed view.
            </p>
            <label className="dialog-field">
              <span>Sheet</span>
              <select value={sheet} onChange={(e) => setSheet(e.target.value)}>
                {sheets.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <div className="appbuilder-range-row">
              <label className="dialog-field">
                <span>First row</span>
                <input type="number" min={1} value={startRow1} onChange={(e) => setStartRow1(Number(e.target.value))} />
              </label>
              <label className="dialog-field">
                <span>First col</span>
                <input type="number" min={1} value={startCol1} onChange={(e) => setStartCol1(Number(e.target.value))} />
              </label>
              <label className="dialog-field">
                <span>Last row</span>
                <input type="number" min={1} value={endRow1} onChange={(e) => setEndRow1(Number(e.target.value))} />
              </label>
              <label className="dialog-field">
                <span>Last col</span>
                <input type="number" min={1} value={endCol1} onChange={(e) => setEndCol1(Number(e.target.value))} />
              </label>
            </div>
            <label className="appbuilder-check">
              <input type="checkbox" checked={headerRow} onChange={(e) => setHeaderRow(e.target.checked)} />
              First row holds column headers
            </label>
            <div className="appbuilder-colpreview">
              <h4>Detected columns</h4>
              {columns.length === 0 && <p className="dialog-hint">No data in this range.</p>}
              <ul>
                {columns.map((c) => (
                  <li key={c.name}>
                    <strong>{c.name}</strong> <em className="appbuilder-coltype">{c.type}</em>
                    {c.type === 'reference' && c.referenceTableId && (
                      <span className="dialog-hint"> → links to {c.referenceTableId}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="appbuilder-step">
            <p className="dialog-hint">Choose the views your app starts with. You get a working app immediately.</p>
            {VIEW_KIND_LABELS.map((v) => (
              <label key={v.kind} className="appbuilder-check">
                <input
                  type="checkbox"
                  checked={enabledViews.includes(v.kind)}
                  onChange={() => toggleView(v.kind)}
                />
                <span>
                  <strong>{v.label}</strong> <span className="dialog-hint">{v.hint}</span>
                </span>
              </label>
            ))}
            {columns.some((c) => c.type === 'reference') && (
              <p className="dialog-hint">
                Reference columns automatically get a linked detail view into the related table.
              </p>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="appbuilder-step">
            <label className="dialog-field">
              <span>App name</span>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            </label>
            <h4>View titles</h4>
            {VIEW_KIND_LABELS.filter((v) => enabledViews.includes(v.kind)).map((v) => (
              <label key={v.kind} className="dialog-field">
                <span>{v.label}</span>
                <input
                  type="text"
                  value={titles[v.kind] ?? v.label}
                  onChange={(e) => setTitles((prev) => ({ ...prev, [v.kind]: e.target.value }))}
                  maxLength={60}
                />
              </label>
            ))}
            <h4>Columns</h4>
            <p className="dialog-hint">Uncheck columns to hide them from every view.</p>
            {columns.map((c) => (
              <label key={c.name} className="appbuilder-check">
                <input
                  type="checkbox"
                  checked={!hiddenCols.includes(c.name)}
                  onChange={() =>
                    setHiddenCols((prev) =>
                      prev.includes(c.name) ? prev.filter((x) => x !== c.name) : [...prev, c.name],
                    )
                  }
                />
                <span>
                  {c.name} <em className="appbuilder-coltype">{c.type}</em>
                </span>
              </label>
            ))}
          </div>
        )}

        {step === 3 && (
          <div className="appbuilder-step appbuilder-preview">
            {(() => {
              const draft = draftForPreview();
              return draft ? (
                <AppRunner spec={draft} host={host} />
              ) : (
                <p className="dialog-hint">Configure the app to see a live preview.</p>
              );
            })()}
          </div>
        )}
          </>
        )}

        <div className="dialog-actions appbuilder-footer">
          {usingTemplate ? (
            <>
              <span className="appbuilder-spacer" />
              <button className="primary" onClick={handleCreate}>
                Create app from template
              </button>
            </>
          ) : (
            <>
              <button disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
                Back
              </button>
              <span className="appbuilder-spacer" />
              {step < STEPS.length - 1 ? (
                <button className="primary" disabled={!canNext()} onClick={() => setStep((s) => s + 1)}>
                  Next
                </button>
              ) : (
                <button className="primary" disabled={!canNext()} onClick={handleCreate}>
                  Create app
                </button>
              )}
            </>
          )}
        </div>
    </A11yDialog>
  );
}
