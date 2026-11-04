/**
 * Queries & Connections side pane (Data > Queries & Connections).
 *
 * Lists saved queries (features/queries.ts) with per-query Refresh,
 * Edit (re-opens the import prefilled in QuickImport via onEditQuery),
 * Properties (spec dialog) and Delete; plus the Existing Connections
 * tab showing data-source bindings (features/dataSources) with
 * last-refresh info. Refresh re-fetches web queries and rewrites the
 * target sheet through the host; text queries are static.
 */
import { useEffect, useState } from 'react';
import type { EngineHost } from '@icecream-sheets/engine';
import { typedValueText } from '../features/typedText';
import A11yDialog from './A11yDialog';
import {
  deleteQuery,
  loadQueries,
  touchQuery,
  type QueryEntry,
} from '../features/queries';
import { parseCSV, parseJSONRecords } from '../features/powerQuery';
import { parseDelimited } from '../features/delimited';
import {
  bindingForSheet,
  restoreDataSourceBindings,
  timeAgo,
  type SourceBinding,
} from '../features/dataSources';

interface QueriesPaneProps {
  host: EngineHost;
  onClose: () => void;
  /** Open the query for editing (parent renders QuickImport prefilled). */
  onEditQuery: (query: QueryEntry) => void;
}

type Tab = 'queries' | 'connections';

export default function QueriesPane({ host, onClose, onEditQuery }: QueriesPaneProps) {
  const [tab, setTab] = useState<Tab>('queries');
  const [queries, setQueries] = useState<QueryEntry[]>([]);
  const [bindings, setBindings] = useState<SourceBinding[]>([]);
  const [propsFor, setPropsFor] = useState<QueryEntry | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState('');

  const reload = (): void => {
    setQueries(loadQueries());
    setBindings(restoreDataSourceBindings());
  };

  useEffect(() => { reload(); }, []);

  const writeGridToSheet = (sheetName: string, grid: string[][]): void => {
    // Ensure the sheet exists.
    host.execute({ cmd: 'addSheet', name: sheetName });
    grid.forEach((row, r) => {
      row.forEach((value, c) => {
        host.execute({ cmd: 'setCell', ref: { sheet: sheetName, row: r, col: c }, value });
      });
    });
    host.execute({ cmd: 'recalculate' });
  };

  const parsePayload = (q: QueryEntry, text: string): string[][] => {
    if (q.kind === 'web') {
      const t = text.trim().startsWith('{') || text.trim().startsWith('[')
        ? parseJSONRecords(text) : parseCSV(text);
      return [t.headers, ...t.rows];
    }
    const t = parseDelimited(text, q.delimiter || ',');
    return [t.headers, ...t.rows];
  };

  const refreshQuery = async (q: QueryEntry): Promise<void> => {
    setRefreshing(q.id);
    setStatusMsg('');
    try {
      if (q.kind === 'web' && q.url) {
        const res = await fetch(q.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const grid = parsePayload(q, text);
        writeGridToSheet(q.sheetName, grid);
        setQueries(touchQuery(q.id, {
          refreshedAt: new Date().toISOString(),
          rowCount: Math.max(0, grid.length - 1),
          status: 'ok',
        }));
        setStatusMsg(`Refreshed "${q.name}".`);
      } else {
        setStatusMsg(`"${q.name}" is a static import — nothing to refresh. Edit it to change the data.`);
        setQueries(touchQuery(q.id, { refreshedAt: q.refreshedAt ?? new Date().toISOString(), status: 'stale' }));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Refresh failed';
      setQueries(touchQuery(q.id, { refreshedAt: new Date().toISOString(), status: 'error', error: msg }));
      setStatusMsg(`Refresh failed: ${msg}`);
    } finally {
      setRefreshing(null);
    }
  };

  const statusColor = (s: QueryEntry['status']): string =>
    s === 'ok' ? '#1a7f37' : s === 'error' ? '#c00' : '#92600a';

  return (
    <div
      role="complementary"
      aria-label="Queries and connections"
      style={{
        position: 'fixed', right: 0, top: 0, bottom: 0, width: 340,
        background: '#fff', borderLeft: '1px solid var(--line-soft)',
        boxShadow: '-4px 0 12px rgba(0,0,0,0.08)', zIndex: 60,
        display: 'flex', flexDirection: 'column',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid var(--line-soft)' }}>
        <strong style={{ flex: 1 }}>Queries &amp; Connections</strong>
        <button onClick={onClose} aria-label="Close pane">×</button>
      </div>
      <div style={{ display: 'flex', gap: 6, padding: '8px 12px', borderBottom: '1px solid var(--line-soft)' }} role="tablist">
        {([['queries', 'Queries'], ['connections', 'Connections']] as [Tab, string][]).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'tab-active' : ''} onClick={() => setTab(k)}>
            {label} ({k === 'queries' ? queries.length : bindings.length})
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '8px 12px' }}>
        {tab === 'queries' && queries.length === 0 && (
          <p style={{ color: '#888', fontSize: 13 }}>No queries yet. Import data with <em>From Text/CSV</em> or <em>From Web</em> to create one.</p>
        )}
        {tab === 'queries' && queries.map((q) => (
          <div key={q.id} style={{ border: '1px solid var(--line-soft)', borderRadius: 6, padding: 8, marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <strong style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={q.name}>{q.name}</strong>
              <span style={{ fontSize: 11, color: statusColor(q.status) }}>● {q.status}</span>
            </div>
            <div style={{ fontSize: 12, color: '#666', margin: '4px 0' }}>
              {q.kind === 'web' ? 'Web' : 'Text'} → {q.sheetName} · {q.rowCount} rows · refreshed {timeAgo(q.refreshedAt)}
              {q.error && <div style={{ color: '#c00' }}>{q.error}</div>}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button disabled={refreshing === q.id} onClick={() => void refreshQuery(q)}>
                {refreshing === q.id ? 'Refreshing…' : 'Refresh'}
              </button>
              <button onClick={() => onEditQuery(q)}>Edit</button>
              <button onClick={() => setPropsFor(q)}>Properties</button>
              <button onClick={() => { setQueries(deleteQuery(q.id)); }}>Delete</button>
            </div>
          </div>
        ))}

        {tab === 'connections' && bindings.length === 0 && (
          <p style={{ color: '#888', fontSize: 13 }}>No connections. Use <em>Get Data (Power Query)</em> to connect a data source.</p>
        )}
        {tab === 'connections' && bindings.map((b) => (
          <div key={b.id ?? b.sheetName} style={{ border: '1px solid var(--line-soft)', borderRadius: 6, padding: 8, marginBottom: 8 }}>
            <div><strong>{b.sheetName}</strong></div>
            <div style={{ fontSize: 12, color: '#666' }}>
              {(b.spec?.kind ?? 'connection')} · last refresh {timeAgo(b.lastRefresh ?? null)}
            </div>
          </div>
        ))}
      </div>

      {statusMsg && <div style={{ padding: '8px 12px', fontSize: 12, borderTop: '1px solid var(--line-soft)' }}>{statusMsg}</div>}

      {propsFor && (
        <A11yDialog title={<>Query Properties</>} width={420} onClose={() => setPropsFor(null)}>
            <dl style={{ fontSize: 13, display: 'grid', gridTemplateColumns: '110px 1fr', gap: 4 }}>
              <dt>Name</dt><dd>{propsFor.name}</dd>
              <dt>Kind</dt><dd>{propsFor.kind}</dd>
              <dt>Sheet</dt><dd>{propsFor.sheetName}</dd>
              {propsFor.url && <><dt>URL</dt><dd style={{ overflowWrap: 'anywhere' }}>{propsFor.url}</dd></>}
              {propsFor.delimiter && <><dt>Delimiter</dt><dd>{JSON.stringify(propsFor.delimiter)}</dd></>}
              <dt>Created</dt><dd>{propsFor.createdAt}</dd>
              <dt>Refreshed</dt><dd>{propsFor.refreshedAt ?? 'never'}</dd>
              <dt>Rows</dt><dd>{propsFor.rowCount}</dd>
            </dl>
            <div className="dialog-actions">
              <button onClick={() => setPropsFor(null)}>Close</button>
            </div>
          </A11yDialog>
      )}
    </div>
  );
}

/** Helper the parent can use to show which sheet a binding feeds. */
export function bindingSheetName(bindings: SourceBinding[], sheet: string): string | undefined {
  return bindingForSheet(bindings, sheet)?.sheetName;
}

/** Read a cell's display text (used by parents wiring the pane). */
export function readCellText(host: EngineHost, sheet: string, row: number, col: number): string {
  return typedValueText(host.getView().readCell({ sheet, row, col }).value);
}
