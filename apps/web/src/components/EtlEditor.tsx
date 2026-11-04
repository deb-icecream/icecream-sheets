/**
 * ETL pipeline editor (design-docs/etl-pipeline.md §7).
 *
 * Applied-step list with expandable parameters, live output preview per
 * step, source configuration, refresh and schedule controls, and a run
 * history view. Recipes persist in the service metadata store
 * (localStorage-backed in this client); the schedule is a serializable
 * spec — the service host evaluates it (no scheduler in this client).
 *
 * Pure preview/add/remove/move logic lives in etlHelpers.ts (tested).
 */
import { useEffect, useMemo, useState } from 'react';
import A11yDialog from './A11yDialog';
import {
  TRANSFORM_OP_KINDS,
  csvTextToTable,
  defaultFailurePolicy,
  jsonTextToTable,
  nodeLabel,
  validateRecipe,
  validateRecipeColumns,
  runRecipe,
  type EtlRecipe,
  type EtlSource,
  type EtlTable,
  type RunRecord,
  type Aggregation,
  type ScheduleSpec,
  type TransformOp,
  type TransformOpKind,
} from '@icecream-sheets/service';
import {
  addTransformNode,
  inputColumnsFor,
  moveNode,
  newRecipe,
  previewRecipe,
  removeNode,
  tableToGrid,
} from './etlHelpers';
import {
  etlFetchText,
  etlRecipeStore,
  etlRunHistoryStore,
  etlVersionStore,
} from './etlStores';
import { suspended } from '../suspended';

interface EtlEditorProps {
  onClose: () => void;
  /** Load a finished table into the sheet at the current selection. */
  onLoadTable: (grid: string[][], tableName: string) => void;
}

const OP_LABELS: Record<TransformOpKind, string> = {
  select: 'Keep columns', drop: 'Drop columns', rename: 'Rename columns',
  convert: 'Change type', filter: 'Filter rows', sort: 'Sort rows',
  split: 'Split column', 'merge-columns': 'Merge columns',
  pivot: 'Pivot', unpivot: 'Unpivot', join: 'Merge (join) tables',
  append: 'Append tables', 'group-by': 'Group by', 'fill-down': 'Fill down',
  deduplicate: 'Remove duplicates', custom: 'Custom code (sandboxed)',
};

const csvList = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);

function PreviewTable({ table }: { table: EtlTable }) {
  const names = table.columns.map((c) => c.name);
  const rows = table.rows.slice(0, 8);
  return (
    <div style={{ overflow: 'auto', border: '1px solid var(--line-soft)', marginTop: 4 }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
        <thead>
          <tr>
            {names.map((h) => (
              <th key={h} style={{ border: '1px solid var(--line-soft)', padding: 4, background: '#f3f4f6', textAlign: 'left' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {names.map((c) => (
                <td key={c} style={{ border: '1px solid var(--line-soft)', padding: 4 }}>
                  {r[c] === null ? <span style={{ color: '#999' }}>null</span> : String(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 11, color: '#666', padding: 4 }}>
        {table.rows.length} rows × {names.length} columns{table.rows.length > 8 && ' (showing first 8)'}
      </div>
    </div>
  );
}

/** Parameter editor for one transform op. */
function StepParams({
  op, columns, onChange,
}: {
  op: TransformOp; columns: string[]; onChange: (op: TransformOp) => void;
}) {
  const listId = useMemo(() => `cols-${Math.random().toString(36).slice(2)}`, []);
  const colInput = (value: string, set: (v: string) => void, label: string) => (
    <label style={{ display: 'block', margin: '4px 0' }}>
      {label}:{' '}
      <input value={value} onChange={(e) => set(e.target.value)} list={listId} size={20} />
      <datalist id={listId}>
        {columns.map((c) => <option key={c} value={c} />)}
      </datalist>
    </label>
  );
  const csvInput = (value: string[], set: (v: string[]) => void, label: string) => (
    <label style={{ display: 'block', margin: '4px 0' }}>
      {label} (comma-separated):{' '}
      <input value={value.join(', ')} onChange={(e) => set(csvList(e.target.value))} size={28} />
    </label>
  );
  switch (op.op) {
    case 'select': return <>{csvInput(op.columns, (v) => onChange({ ...op, columns: v }), 'Columns to keep')}</>;
    case 'drop': return <>{csvInput(op.columns, (v) => onChange({ ...op, columns: v }), 'Columns to drop')}</>;
    case 'rename':
      return (
        <label style={{ display: 'block', margin: '4px 0' }}>
          Renames (one <code>old=new</code> per line):<br />
          <textarea
            rows={3} cols={30}
            value={Object.entries(op.mapping).map(([k, v]) => `${k}=${v}`).join('\n')}
            onChange={(e) => {
              const mapping: Record<string, string> = {};
              for (const line of e.target.value.split('\n')) {
                const i = line.indexOf('=');
                if (i > 0) mapping[line.slice(0, i).trim()] = line.slice(i + 1).trim();
              }
              onChange({ ...op, mapping });
            }}
          />
        </label>
      );
    case 'convert':
      return (
        <>
          {colInput(op.column, (v) => onChange({ ...op, column: v }), 'Column')}
          <label style={{ display: 'block', margin: '4px 0' }}>
            Convert to:{' '}
            <select value={op.to} onChange={(e) => onChange({ ...op, to: e.target.value as 'text' | 'number' | 'date' | 'boolean' })}>
              {(['text', 'number', 'date', 'boolean'] as const).map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
        </>
      );
    case 'filter':
      return (
        <>
          {colInput(op.column, (v) => onChange({ ...op, column: v }), 'Column')}
          <label style={{ display: 'block', margin: '4px 0' }}>
            Operator:{' '}
            <select value={op.operator} onChange={(e) => onChange({ ...op, operator: e.target.value as typeof op.operator })}>
              {(['eq', 'neq', 'contains', 'not-contains', 'gt', 'gte', 'lt', 'lte', 'is-null', 'is-not-null'] as const)
                .map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
          <label style={{ display: 'block', margin: '4px 0' }}>
            Value:{' '}
            <input value={op.value === null || op.value === undefined ? '' : String(op.value)}
              onChange={(e) => onChange({ ...op, value: e.target.value })} size={16} />
          </label>
        </>
      );
    case 'sort':
      return (
        <label style={{ display: 'block', margin: '4px 0' }}>
          Sort keys (one <code>column:asc|desc</code> per line):<br />
          <textarea
            rows={2} cols={30}
            value={op.keys.map((k) => `${k.column}:${k.dir}`).join('\n')}
            onChange={(e) => {
              const keys = e.target.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
                const [column, dir] = l.split(':');
                return { column: (column ?? '').trim(), dir: (dir ?? 'asc').trim() === 'desc' ? 'desc' as const : 'asc' as const };
              }).filter((k) => k.column);
              onChange({ ...op, keys });
            }}
          />
        </label>
      );
    case 'split':
      return (
        <>
          {colInput(op.column, (v) => onChange({ ...op, column: v }), 'Column')}
          <label style={{ display: 'block', margin: '4px 0' }}>
            Delimiter:{' '}
            <input value={op.delimiter} onChange={(e) => onChange({ ...op, delimiter: e.target.value })} size={6} />
          </label>
          {csvInput(op.into, (v) => onChange({ ...op, into: v }), 'New columns')}
        </>
      );
    case 'merge-columns':
      return (
        <>
          {csvInput(op.columns, (v) => onChange({ ...op, columns: v }), 'Columns')}
          <label style={{ display: 'block', margin: '4px 0' }}>
            Delimiter:{' '}
            <input value={op.delimiter} onChange={(e) => onChange({ ...op, delimiter: e.target.value })} size={6} />
          </label>
          <label style={{ display: 'block', margin: '4px 0' }}>
            Into:{' '}
            <input value={op.into} onChange={(e) => onChange({ ...op, into: e.target.value })} size={16} />
          </label>
        </>
      );
    case 'pivot':
      return (
        <>
          {csvInput(op.index, (v) => onChange({ ...op, index: v }), 'Index columns')}
          {colInput(op.column, (v) => onChange({ ...op, column: v }), 'Pivot column')}
          {colInput(op.value, (v) => onChange({ ...op, value: v }), 'Value column')}
          <label style={{ display: 'block', margin: '4px 0' }}>
            Aggregation:{' '}
            <select value={op.agg} onChange={(e) => onChange({ ...op, agg: e.target.value as typeof op.agg })}>
              {(['sum', 'avg', 'min', 'max', 'count', 'count-distinct', 'first', 'last'] as const)
                .map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
        </>
      );
    case 'unpivot':
      return (
        <>
          {csvInput(op.idColumns, (v) => onChange({ ...op, idColumns: v }), 'ID columns')}
          <label style={{ display: 'block', margin: '4px 0' }}>
            Variable column:{' '}
            <input value={op.variableColumn} onChange={(e) => onChange({ ...op, variableColumn: e.target.value })} size={16} />
          </label>
          <label style={{ display: 'block', margin: '4px 0' }}>
            Value column:{' '}
            <input value={op.valueColumn} onChange={(e) => onChange({ ...op, valueColumn: e.target.value })} size={16} />
          </label>
        </>
      );
    case 'join':
    case 'append': {
      const withTable = op.with.kind === 'literal' ? op.with.table : null;
      return (
        <>
          {op.op === 'join' && (
            <>
              {csvInput(op.on, (v) => onChange({ ...op, on: v }), 'Join keys')}
              <label style={{ display: 'block', margin: '4px 0' }}>
                How:{' '}
                <select value={op.how} onChange={(e) => onChange({ ...op, how: e.target.value as typeof op.how })}>
                  {(['inner', 'left', 'right', 'outer'] as const).map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </label>
            </>
          )}
          <label style={{ display: 'block', margin: '4px 0' }}>
            Other table source:{' '}
            <select
              value={op.with.kind}
              onChange={(e) => {
                const kind = e.target.value as 'literal' | 'recipe';
                onChange(kind === 'literal'
                  ? { ...op, with: { kind: 'literal', table: { columns: [], rows: [] } } }
                  : { ...op, with: { kind: 'recipe', recipeId: '' } });
              }}
            >
              <option value="literal">Pasted table (CSV)</option>
              <option value="recipe">Another recipe's output</option>
            </select>
          </label>
          {op.with.kind === 'literal' && (
            <label style={{ display: 'block', margin: '4px 0' }}>
              CSV (first row = headers):<br />
              <textarea
                rows={3} cols={34}
                value={withTable && withTable.columns.length > 0
                  ? [withTable.columns.map((c) => c.name).join(','),
                    ...withTable.rows.map((r) => withTable.columns.map((c) => String(r[c.name] ?? '')).join(','))].join('\n')
                  : ''}
                onChange={(e) => {
                  try {
                    const t = csvTextToTable(e.target.value);
                    onChange({ ...op, with: { kind: 'literal', table: t } });
                  } catch { /* keep typing */ }
                }}
              />
            </label>
          )}
          {op.with.kind === 'recipe' && (
            <label style={{ display: 'block', margin: '4px 0' }}>
              Recipe id:{' '}
              <input value={op.with.recipeId}
                onChange={(e) => onChange({ ...op, with: { kind: 'recipe', recipeId: e.target.value } })}
                size={20} />
            </label>
          )}
        </>
      );
    }
    case 'group-by':
      return (
        <>
          {csvInput(op.keys, (v) => onChange({ ...op, keys: v }), 'Group keys')}
          <label style={{ display: 'block', margin: '4px 0' }}>
            Aggregations (one <code>column:agg:as</code> per line):<br />
            <textarea
              rows={3} cols={30}
              value={op.aggregations.map((a) => `${a.column}:${a.agg}:${a.as}`).join('\n')}
              onChange={(e) => {
                const aggregations = e.target.value.split('\n').map((l) => l.trim()).filter(Boolean)
                  .map((l) => {
                    const [column, agg, as] = l.split(':');
                    return {
                      column: (column ?? '').trim(),
                      agg: (((agg ?? 'sum').trim() || 'sum') as Aggregation),
                      as: (as ?? '').trim() || `${column}_${agg}`,
                    };
                  }).filter((a) => a.column);
                onChange({ ...op, aggregations: aggregations as typeof op.aggregations });
              }}
            />
          </label>
        </>
      );
    case 'fill-down':
      return <>{colInput(op.column, (v) => onChange({ ...op, column: v }), 'Column')}</>;
    case 'deduplicate':
      return (
        <>
          {csvInput(op.columns ?? [], (v) => onChange({ ...op, columns: v.length ? v : undefined }), 'Key columns (empty = all)')}
          <label style={{ display: 'block', margin: '4px 0' }}>
            Keep:{' '}
            <select value={op.keep ?? 'first'} onChange={(e) => onChange({ ...op, keep: e.target.value as 'first' | 'last' })}>
              <option value="first">first</option>
              <option value="last">last</option>
            </select>
          </label>
        </>
      );
    case 'custom':
      return (
        <>
          <label style={{ display: 'block', margin: '4px 0' }}>
            Language:{' '}
            <select value={op.language} onChange={(e) => onChange({ ...op, language: e.target.value as typeof op.language })}>
              <option value="javascript">JavaScript</option>
              <option value="python">Python</option>
              <option value="typescript">TypeScript (service host only)</option>
            </select>
          </label>
          <div style={{ fontSize: 11, color: '#666', margin: '4px 0' }}>
            Contract: input <code>args = {'{ columns, rows }'}</code>; output must be{' '}
            <code>{'{ columns: string[], rows: object[] }'}</code> with scalar values.
            Runs sandboxed on the service host — no network, filesystem, or clock.
          </div>
          <textarea
            rows={6} cols={40} style={{ fontFamily: 'monospace', fontSize: 12 }}
            value={op.code}
            onChange={(e) => onChange({ ...op, code: e.target.value })}
            placeholder={op.language === 'python'
              ? '# args: {"columns": [...], "rows": [...]}\n# assign result = {"columns": [...], "rows": [...]}'
              : '// args.columns, args.rows are available\n// return { columns: [...], rows: [...] };'}
          />
        </>
      );
  }
}

export default function EtlEditor({ onClose, onLoadTable }: EtlEditorProps) {
  // Shared browser ETL stores (etlStores.ts): one memoized view of the
  // persisted recipes/runs/versions, shared with the report refresh path.
  const recipeStore = useMemo(() => etlRecipeStore(), []);
  const historyStore = useMemo(() => etlRunHistoryStore(), []);
  const versionStore = suspended(
    'etl-version-store',
    // Encrypted at rest (WebCrypto), so creation is async; the first render
    // suspends until the store resolves (Suspense boundary in main.tsx).
    () => etlVersionStore(),
  );

  const [recipeList, setRecipeList] = useState<EtlRecipe[]>(() => recipeStore.all());
  const [draft, setDraft] = useState<EtlRecipe>(() => {
    const all = recipeStore.all();
    return all[0] ?? newRecipe('Pipeline 1', 'local-user');
  });
  const [urlTables, setUrlTables] = useState<Record<string, EtlTable>>({});
  const [fetching, setFetching] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [addKind, setAddKind] = useState<TransformOpKind>('filter');
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState('');
  const [history, setHistory] = useState<RunRecord[]>(() =>
    historyStore.all().filter((r) => r.recipeId === (recipeStore.all()[0]?.id ?? '')),
  );
  const [showHistory, setShowHistory] = useState(false);
  const [activeTab, setActiveTab] = useState<'steps' | 'schedule' | 'history'>('steps');

  // Auto-save the draft to the metadata store.
  useEffect(() => {
    const others = recipeStore.all().filter((r) => r.id !== draft.id);
    recipeStore.saveAll([...others, draft]);
    setRecipeList(recipeStore.all());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const { previews, issues } = useMemo(() => previewRecipe(draft, urlTables), [draft, urlTables]);
  const sourceColumns = previews[0]?.table ? previews[0].table.columns.map((c) => c.name) : [];
  const columnIssues = useMemo(
    () => (sourceColumns.length > 0 ? validateRecipeColumns(draft, sourceColumns) : []),
    [draft, sourceColumns],
  );

  const updateNode = (nodeId: string, patch: (n: EtlRecipe['nodes'][number]) => EtlRecipe['nodes'][number]): void => {
    setDraft((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === nodeId ? patch(n) : n)) }));
  };

  const fetchUrlSource = async (nodeId: string, url: string, format: 'auto' | 'csv' | 'json'): Promise<void> => {
    setFetching(nodeId);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const fmt = format === 'auto'
        ? (text.trimStart().startsWith('{') || text.trimStart().startsWith('[') ? 'json' : 'csv')
        : format;
      setUrlTables((p) => ({ ...p, [nodeId]: fmt === 'json' ? jsonTextToTable(text) : csvTextToTable(text) }));
      setRunMsg('');
    } catch (e) {
      setRunMsg(`Fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setFetching('');
    }
  };

  const runNow = async (): Promise<void> => {
    if (issues.length > 0) {
      setRunMsg(`Cannot run: ${issues[0]}`);
      return;
    }
    setRunning(true);
    setRunMsg('Running…');
    try {
      const loadNode = draft.nodes.find((n) => n.kind === 'load');
      const tableName = loadNode && loadNode.kind === 'load' && loadNode.target.kind === 'workbook-table'
        ? loadNode.target.tableName : 'Table';
      const run = await runRecipe(draft, {
        fetchText: etlFetchText,
        writer: {
          // Browser host: load into the sheet at the selection. The service
          // host implements the atomic engine-protocol swap instead.
          writeAtomic: async (_target, table) => { onLoadTable(tableToGrid(table), tableName); },
        },
        versions: versionStore,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      });
      historyStore.add(run);
      setHistory(historyStore.all().filter((r) => r.recipeId === draft.id).reverse());
      setRunMsg(run.status === 'succeeded'
        ? `Loaded ${run.rowsLoaded} rows into "${tableName}"${run.quarantined.length ? ` (${run.quarantined.length} quarantined)` : ''}`
        : `Run ${run.status}: ${run.error ?? 'unknown error'}`);
    } catch (e) {
      setRunMsg(`Run failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
    }
  };

  const selectRecipe = (id: string): void => {
    const r = recipeList.find((x) => x.id === id);
    if (r) {
      setDraft(r);
      setUrlTables({});
      setHistory(historyStore.all().filter((x) => x.recipeId === id).reverse());
    }
  };

  const newDraft = (): void => {
    const r = newRecipe(`Pipeline ${recipeList.length + 1}`, 'local-user');
    setDraft(r);
    setUrlTables({});
    setHistory([]);
  };

  const deleteDraft = (): void => {
    recipeStore.remove((r) => r.id === draft.id);
    const rest = recipeStore.all();
    setRecipeList(rest);
    setDraft(rest[0] ?? newRecipe('Pipeline 1', 'local-user'));
  };

  const sourceNode = draft.nodes.find((n) => n.kind === 'source');
  const loadNode = draft.nodes.find((n) => n.kind === 'load');
  const transformNodes = draft.nodes.filter((n) => n.kind === 'transform');
  const schedule: ScheduleSpec = draft.schedule;

  return (
    <A11yDialog title={<>ETL Pipelines</>} width={860} onClose={onClose}>

        <div style={{ display: 'flex', gap: 16 }}>
          {/* Recipe list */}
          <div style={{ width: 180, flexShrink: 0 }}>
            <strong style={{ fontSize: 12 }}>Recipes</strong>
            <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0', fontSize: 13 }}>
              {recipeList.map((r) => (
                <li key={r.id} style={{ marginBottom: 2 }}>
                  <button
                    onClick={() => selectRecipe(r.id)}
                    style={{
                      width: '100%', textAlign: 'left',
                      fontWeight: r.id === draft.id ? 'bold' : 'normal',
                      background: r.id === draft.id ? '#eef' : undefined,
                    }}
                  >
                    {r.name}
                    <span style={{ color: '#888', fontWeight: 'normal' }}> · {r.schedule.trigger}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div style={{ display: 'flex', gap: 4 }}>
              <button onClick={newDraft}>New</button>
              <button onClick={deleteDraft} disabled={recipeList.length === 0}>Delete</button>
            </div>
          </div>

          {/* Editor */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="dialog-row">
              <label>
                Name:{' '}
                <input
                  value={draft.name}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                  size={24}
                />
              </label>
              <div role="tablist" aria-label="Editor section" style={{ marginLeft: 12 }}>
                {(['steps', 'schedule', 'history'] as const).map((t) => (
                  <button
                    key={t}
                    role="tab"
                    aria-selected={activeTab === t}
                    className={activeTab === t ? 'tab-active' : ''}
                    onClick={() => setActiveTab(t)}
                    style={{ marginRight: 6, textTransform: 'capitalize' }}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            {(issues.length > 0 || columnIssues.length > 0) && (
              <div style={{ color: '#a00', fontSize: 12, margin: '4px 0' }}>
                {[...issues, ...columnIssues.map((i) => i.message)].map((m, i) => <div key={i}>⚠ {m}</div>)}
              </div>
            )}

            {activeTab === 'steps' && (
              <>
                {/* Source */}
                {sourceNode && sourceNode.kind === 'source' && (
                  <details open style={{ marginBottom: 8 }}>
                    <summary><strong>Source</strong> — {nodeLabel(sourceNode)}</summary>
                    <SourceEditor
                      nodeId={sourceNode.id}
                      source={sourceNode.source}
                      onChange={(source) => updateNode(sourceNode.id, (n) =>
                        n.kind === 'source' ? { ...n, source } : n)}
                      onFetch={fetchUrlSource}
                      fetching={fetching === sourceNode.id}
                    />
                  </details>
                )}

                {/* Applied steps */}
                <strong style={{ fontSize: 12 }}>Applied steps</strong>
                {transformNodes.length === 0 && (
                  <div style={{ fontSize: 12, color: '#888' }}>No steps — the source loads as-is.</div>
                )}
                {transformNodes.map((n) => {
                  const preview = previews.find((p) => p.nodeId === n.id);
                  const isOpen = expanded === n.id;
                  return (
                    <div key={n.id} style={{ border: '1px solid var(--line-soft)', margin: '4px 0', padding: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <button onClick={() => setExpanded(isOpen ? null : n.id)} aria-expanded={isOpen}>
                          {isOpen ? '▾' : '▸'}
                        </button>
                        <strong style={{ fontSize: 13 }}>{nodeLabel(n)}</strong>
                        <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                          <button onClick={() => setDraft((d) => moveNode(d, n.id, -1))} title="Move up">↑</button>
                          <button onClick={() => setDraft((d) => moveNode(d, n.id, 1))} title="Move down">↓</button>
                          <button onClick={() => setDraft((d) => removeNode(d, n.id))} aria-label="Remove step">×</button>
                        </span>
                      </div>
                      {isOpen && n.kind === 'transform' && (
                        <StepParams
                          op={n.transform}
                          columns={inputColumnsFor(draft, n.id)}
                          onChange={(op) => updateNode(n.id, (x) =>
                            x.kind === 'transform' ? { ...x, transform: op } : x)}
                        />
                      )}
                      {preview?.error && <div style={{ color: '#a00', fontSize: 12 }}>⚠ {preview.error}</div>}
                      {preview?.table && <PreviewTable table={preview.table} />}
                    </div>
                  );
                })}

                {/* Add step */}
                <div className="dialog-row" style={{ fontSize: 12 }}>
                  <select value={addKind} onChange={(e) => setAddKind(e.target.value as TransformOpKind)} aria-label="Step type">
                    {TRANSFORM_OP_KINDS.map((k) => <option key={k} value={k}>{OP_LABELS[k]}</option>)}
                  </select>{' '}
                  <button onClick={() => setDraft((d) => addTransformNode(d, addKind))}>Add step</button>
                </div>

                {/* Load */}
                {loadNode && loadNode.kind === 'load' && loadNode.target.kind === 'workbook-table' && (
                  <details style={{ marginTop: 8 }}>
                    <summary><strong>Load</strong> — {nodeLabel(loadNode)}</summary>
                    <div style={{ fontSize: 12, marginTop: 4 }}>
                      <label>
                        Sheet:{' '}
                        <input
                          value={loadNode.target.sheetName}
                          onChange={(e) => updateNode(loadNode.id, (n) =>
                            n.kind === 'load' && n.target.kind === 'workbook-table'
                              ? { ...n, target: { ...n.target, sheetName: e.target.value } } : n)}
                          size={14}
                        />
                      </label>{' '}
                      <label>
                        Table name:{' '}
                        <input
                          value={loadNode.target.tableName}
                          onChange={(e) => updateNode(loadNode.id, (n) =>
                            n.kind === 'load' && n.target.kind === 'workbook-table'
                              ? { ...n, target: { ...n.target, tableName: e.target.value } } : n)}
                          size={14}
                        />
                      </label>{' '}
                      <label title="Prior loaded versions kept in the service metadata store">
                        Retention:{' '}
                        <input
                          type="number" min={0} max={50}
                          value={loadNode.retention ?? 5}
                          onChange={(e) => updateNode(loadNode.id, (n) =>
                            n.kind === 'load' ? { ...n, retention: Math.max(0, parseInt(e.target.value || '0', 10)) } : n)}
                          style={{ width: 56 }}
                        />
                      </label>
                      <div style={{ color: '#666', marginTop: 4 }}>
                        Every run materializes a full copy and swaps it in atomically — readers never
                        see a partially written table, and a failed run never replaces the last good load.
                      </div>
                    </div>
                  </details>
                )}
              </>
            )}

            {activeTab === 'schedule' && (
              <div style={{ fontSize: 13 }}>
                <label>
                  Trigger:{' '}
                  <select
                    value={schedule.trigger}
                    onChange={(e) => {
                      const trigger = e.target.value as ScheduleSpec['trigger'];
                      setDraft((d) => ({
                        ...d,
                        schedule: trigger === 'scheduled'
                          ? { trigger, cron: '0 6 * * *' }
                          : { trigger },
                      }));
                    }}
                  >
                    <option value="manual">Manual</option>
                    <option value="on-open">On workbook open</option>
                    <option value="scheduled">Scheduled</option>
                  </select>
                </label>
                {schedule.trigger === 'scheduled' && (
                  <label style={{ display: 'block', marginTop: 6 }}>
                    Cron (5 fields):{' '}
                    <input
                      value={schedule.cron}
                      onChange={(e) => setDraft((d) => ({
                        ...d,
                        schedule: { trigger: 'scheduled', cron: e.target.value },
                      }))}
                      size={16}
                      placeholder="0 6 * * *"
                    />
                  </label>
                )}
                <div style={{ color: '#666', marginTop: 6, fontSize: 12 }}>
                  The schedule is a serializable spec stored on the recipe — the service host
                  evaluates it (there is no scheduler inside this client). Scheduled runs execute
                  as the pipeline owner ({draft.owner || 'local-user'}).
                </div>
                <fieldset style={{ marginTop: 12 }}>
                  <legend>Failure handling</legend>
                  <FailurePolicyEditor draft={draft} setDraft={setDraft} />
                </fieldset>
              </div>
            )}

            {activeTab === 'history' && (
              <div style={{ fontSize: 12 }}>
                {history.length === 0 && <div style={{ color: '#888' }}>No runs yet for this recipe.</div>}
                {history.map((r) => (
                  <div key={r.id} style={{ border: '1px solid var(--line-soft)', margin: '4px 0', padding: 6 }}>
                    <div>
                      <strong style={{
                        color: r.status === 'succeeded' ? '#0a0' : r.status === 'aborted' ? '#a60' : '#a00',
                      }}>{r.status}</strong>
                      {' '}· {new Date(r.startedAt).toLocaleString()} · {r.rowsLoaded} rows loaded
                      {r.quarantined.length > 0 && ` · ${r.quarantined.length} quarantined`}
                    </div>
                    <div style={{ color: '#666' }}>
                      {r.steps.map((s) => `${s.label}: ${s.rowsIn}→${s.rowsOut}`).join(' · ')}
                    </div>
                    {r.error && <div style={{ color: '#a00' }}>{r.error}</div>}
                    {r.quarantined.length > 0 && (
                      <details>
                        <summary>Quarantined rows ({r.quarantined.length})</summary>
                        <ul>
                          {r.quarantined.slice(0, 10).map((q, i) => (
                            <li key={i}>row {q.rowIndex} ({q.stepId}): {q.reason}</li>
                          ))}
                          {r.quarantined.length > 10 && <li>…and {r.quarantined.length - 10} more</li>}
                        </ul>
                      </details>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {runMsg && <div style={{ fontSize: 12, marginTop: 8, color: runMsg.startsWith('Loaded') ? '#0a0' : '#a00' }}>{runMsg}</div>}

        <div className="dialog-actions">
          <button onClick={() => void runNow()} disabled={running || issues.length > 0}>
            {running ? 'Running…' : 'Run now & load'}
          </button>
          <button onClick={() => setActiveTab('history')}>
            Run history ({history.length})
          </button>
          <button onClick={onClose}>Close</button>
        </div>
      </A11yDialog>
  );
}

function SourceEditor({
  nodeId, source, onChange, onFetch, fetching,
}: {
  nodeId: string;
  source: EtlSource;
  onChange: (s: EtlSource) => void;
  onFetch: (nodeId: string, url: string, format: 'auto' | 'csv' | 'json') => Promise<void>;
  fetching: boolean;
}) {
  const tab = source.type === 'csv-text' ? 'csv' : source.type === 'json-text' ? 'json' : source.type;
  const switchTab = (t: 'csv' | 'json' | 'url' | 'connector'): void => {
    if (t === 'csv') onChange({ type: 'csv-text', text: '' });
    else if (t === 'json') onChange({ type: 'json-text', text: '[]' });
    else if (t === 'url') onChange({ type: 'url', url: '', format: 'auto' });
    else onChange({ type: 'connector', connectorId: '', credentialRef: '' });
  };
  return (
    <div style={{ fontSize: 12, marginTop: 4 }}>
      <div role="tablist" aria-label="Source type">
        {(['csv', 'json', 'url', 'connector'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'tab-active' : ''}
            onClick={() => switchTab(t)}
            style={{ marginRight: 6 }}
          >
            {t === 'csv' ? 'CSV' : t === 'json' ? 'JSON' : t === 'url' ? 'Web URL' : 'Connector'}
          </button>
        ))}
      </div>
      {source.type === 'csv-text' && (
        <>
          <textarea
            rows={4} cols={60} style={{ fontFamily: 'monospace', fontSize: 12, marginTop: 4 }}
            value={source.text}
            onChange={(e) => onChange({ ...source, text: e.target.value })}
            aria-label="CSV text"
          />
          <div>
            <label>
              Delimiter (blank = auto-detect):{' '}
              <input
                value={source.delimiter ?? ''}
                onChange={(e) => onChange({ ...source, delimiter: e.target.value || undefined })}
                size={4}
              />
            </label>{' '}
            <label>
              <input
                type="checkbox"
                checked={source.hasHeader ?? true}
                onChange={(e) => onChange({ ...source, hasHeader: e.target.checked })}
              />{' '}
              First row is headers
            </label>
          </div>
        </>
      )}
      {source.type === 'json-text' && (
        <textarea
          rows={4} cols={60} style={{ fontFamily: 'monospace', fontSize: 12, marginTop: 4 }}
          value={source.text}
          onChange={(e) => onChange({ ...source, text: e.target.value })}
          aria-label="JSON text"
          placeholder='[{"a": 1}] or {"data": [...]}'
        />
      )}
      {source.type === 'url' && (
        <div style={{ marginTop: 4 }}>
          <input
            value={source.url}
            onChange={(e) => onChange({ ...source, url: e.target.value })}
            placeholder="https://example.com/data.csv"
            size={44}
            aria-label="Data URL"
          />{' '}
          <select
            value={source.format}
            onChange={(e) => onChange({ ...source, format: e.target.value as typeof source.format })}
            aria-label="URL format"
          >
            <option value="auto">auto</option>
            <option value="csv">csv</option>
            <option value="json">json</option>
          </select>{' '}
          <button
            onClick={() => void onFetch(nodeId, source.url, source.format)}
            disabled={fetching || !source.url.trim()}
          >
            {fetching ? 'Fetching…' : 'Fetch for preview'}
          </button>
        </div>
      )}
      {source.type === 'connector' && (
        <div style={{ marginTop: 4 }}>
          <label>
            Connector id:{' '}
            <input
              value={source.connectorId}
              onChange={(e) => onChange({ ...source, connectorId: e.target.value })}
              size={20}
            />
          </label>{' '}
          <label title="Opaque vault reference — never paste a secret here">
            Credential ref:{' '}
            <input
              value={source.credentialRef}
              onChange={(e) => onChange({ ...source, credentialRef: e.target.value })}
              size={24}
              placeholder="vault://..."
            />
          </label>
          <div style={{ color: '#666', marginTop: 4 }}>
            The recipe stores only the vault reference; the secret is resolved at run time
            through the service credential vault, and scheduled runs execute as the pipeline owner.
          </div>
        </div>
      )}
    </div>
  );
}

function FailurePolicyEditor({
  draft, setDraft,
}: {
  draft: EtlRecipe;
  setDraft: (f: (d: EtlRecipe) => EtlRecipe) => void;
}) {
  const fp = draft.failurePolicy;
  const set = (patch: Partial<typeof fp>): void =>
    setDraft((d) => ({ ...d, failurePolicy: { ...d.failurePolicy, ...patch } }));
  const num = (v: string, fallback: number): number => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  };
  return (
    <div style={{ fontSize: 12 }}>
      <label>
        Max retries:{' '}
        <input type="number" min={0} max={10} value={fp.maxRetries}
          onChange={(e) => set({ maxRetries: Math.max(0, num(e.target.value, 3)) })} style={{ width: 56 }} />
      </label>{' '}
      <label>
        Backoff base (ms):{' '}
        <input type="number" min={0} value={fp.backoffBaseMs}
          onChange={(e) => set({ backoffBaseMs: Math.max(0, num(e.target.value, 500)) })} style={{ width: 72 }} />
      </label>{' '}
      <label>
        Multiplier:{' '}
        <input type="number" min={1} step={0.5} value={fp.backoffMultiplier}
          onChange={(e) => set({ backoffMultiplier: Math.max(1, parseFloat(e.target.value) || 2) })} style={{ width: 56 }} />
      </label>
      <br />
      <label>
        <input type="checkbox" checked={fp.quarantine}
          onChange={(e) => set({ quarantine: e.target.checked })} />{' '}
        Quarantine failing rows (with reasons) instead of failing the step
      </label>
      <br />
      <label>
        Abort if quarantined &gt;{' '}
        <input type="number" min={0} max={100} style={{ width: 56 }}
          value={fp.errorThresholdPct ?? ''}
          placeholder="5"
          onChange={(e) => set({
            errorThresholdPct: e.target.value === '' ? undefined : Math.min(100, Math.max(0, num(e.target.value, 5))),
          })} />{' '}
        % of source rows
      </label>{' '}
      <label>
        or &gt;{' '}
        <input type="number" min={0} style={{ width: 64 }}
          value={fp.maxErrorRows ?? ''}
          placeholder="—"
          onChange={(e) => set({
            maxErrorRows: e.target.value === '' ? undefined : Math.max(0, num(e.target.value, 0)),
          })} />{' '}
        rows
      </label>
      <div style={{ color: '#666', marginTop: 4 }}>
        Transient failures (network, sandbox timeouts) retry with exponential backoff.
        Aborted/failed runs never replace the last good load.
      </div>
      <button
        style={{ marginTop: 6 }}
        onClick={() => setDraft((d) => ({ ...d, failurePolicy: defaultFailurePolicy() }))}
      >
        Reset to defaults
      </button>
    </div>
  );
}
