/**
 * Quick Import dialog (Data > Get & Transform Data).
 *
 * Four quick paths that reuse the Power Query import patterns
 * (features/powerQuery.ts + features/delimited.ts):
 *  - From Text/CSV: paste text, pick a delimiter with a live preview,
 *    toggle first-row headers, then load.
 *  - From Web: fetch a URL (CSV or JSON), preview, then load.
 *  - Recent Sources: re-import from the MRU list (features/recentSources).
 *  - Existing Connections: browse data-source bindings
 *    (features/dataSources) with last-refresh info.
 *
 * Every successful import registers a query (features/queries.ts) so it
 * appears in the Queries & Connections pane and can be refreshed/edited.
 */
import { useEffect, useMemo, useState } from 'react';
import { parseCSV, parseJSONRecords, tableToGrid } from '../features/powerQuery';
import { parseDelimited, detectDelimiter, delimitedToGrid, DELIMITER_PRESETS } from '../features/delimited';
import A11yDialog from './A11yDialog';
import {
  addRecentSource,
  loadRecentSources,
  type RecentSource,
} from '../features/recentSources';
import { newQueryId, saveQuery, defaultQueryName, type QueryEntry } from '../features/queries';
import { restoreDataSourceBindings, timeAgo, type SourceBinding } from '../features/dataSources';

export interface QuickImportMeta {
  name: string;
  kind: string;
}

type Tab = 'text' | 'web' | 'recent' | 'connections';

interface QuickImportProps {
  onClose: () => void;
  /** Grid loaded into the sheet by the parent (same contract as PowerQueryDialog). */
  onLoad: (grid: string[][], meta: QuickImportMeta) => void;
  /** Sheet the import loads into (used for the query record). */
  sheetName: string;
  /** Which tab to open on (ribbon entry point). */
  initialTab?: Tab;
  /** Edit an existing query: prefills the form and updates it on load. */
  editQuery?: QueryEntry | null;
}

export default function QuickImport({ onClose, onLoad, sheetName, initialTab, editQuery }: QuickImportProps) {
  const [tab, setTab] = useState<Tab>(initialTab ?? (editQuery?.kind === 'web' ? 'web' : 'text'));
  // Text/CSV state
  const [rawText, setRawText] = useState('Name,Age,City\nAlice,30,NYC\nBob,25,LA');
  const [delimiter, setDelimiter] = useState<string>(',');
  const [customDelim, setCustomDelim] = useState('');
  const [firstRowHeader, setFirstRowHeader] = useState(true);
  // Web state
  const [url, setUrl] = useState('');
  const [webText, setWebText] = useState('');
  const [webKind, setWebKind] = useState<'csv' | 'json'>('csv');
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState('');
  // Lists
  const [recent, setRecent] = useState<RecentSource[]>([]);
  const [connections, setConnections] = useState<SourceBinding[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    setRecent(loadRecentSources());
    setConnections(restoreDataSourceBindings());
  }, []);

  // Prefill when editing an existing query (from QueriesPane > Edit).
  useEffect(() => {
    if (!editQuery) return;
    if (editQuery.kind === 'web') {
      setTab('web');
      setUrl(editQuery.url ?? '');
      setWebText('');
    } else {
      setTab('text');
      setRawText(editQuery.sourceText ?? '');
      if (editQuery.delimiter) setDelimiter(editQuery.delimiter);
    }
  }, [editQuery]);

  const activeDelim = delimiter === 'custom' ? customDelim : delimiter;

  const textTable = useMemo(() => {
    try {
      return parseDelimited(rawText, activeDelim || ',');
    } catch {
      return { headers: [], rows: [] };
    }
  }, [rawText, activeDelim]);

  const webTable = useMemo(() => {
    if (!webText) return { headers: [], rows: [] };
    try {
      return webKind === 'json' ? parseJSONRecords(webText) : parseCSV(webText);
    } catch {
      return { headers: [], rows: [] };
    }
  }, [webText, webKind]);

  const registerQuery = (kind: QueryEntry['kind'], sourceText: string | undefined, urlV: string | undefined, delim: string | undefined, grid: string[][]): void => {
    const now = new Date().toISOString();
    saveQuery({
      id: editQuery?.id ?? newQueryId(),
      name: editQuery?.name ?? defaultQueryName(kind, sourceText, urlV),
      kind,
      sourceText,
      url: urlV,
      delimiter: delim,
      sheetName,
      createdAt: editQuery?.createdAt ?? now,
      refreshedAt: now,
      rowCount: Math.max(0, grid.length - 1),
      status: 'ok',
    });
  };

  const loadText = (): void => {
    setError('');
    if (textTable.headers.length === 0) { setError('Nothing to import — paste some text first.'); return; }
    const grid = delimitedToGrid(textTable, firstRowHeader);
    const label = `Pasted text (${textTable.rows.length} rows)`;
    addRecentSource({ kind: 'text', label, payload: rawText });
    registerQuery('text', rawText, undefined, activeDelim, grid);
    onLoad(grid, { name: label, kind: 'text' });
    onClose();
  };

  const fetchWeb = async (): Promise<void> => {
    if (!url.trim()) return;
    setFetching(true);
    setFetchError('');
    try {
      const res = await fetch(url.trim());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const ct = res.headers.get('content-type') ?? '';
      const isJson = ct.includes('json') || text.trim().startsWith('{') || text.trim().startsWith('[');
      setWebKind(isJson ? 'json' : 'csv');
      setWebText(text);
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : 'Fetch failed');
    } finally {
      setFetching(false);
    }
  };

  const loadWeb = (): void => {
    setError('');
    if (webTable.headers.length === 0) { setError('Nothing to import — fetch a URL first.'); return; }
    const grid = tableToGrid({ headers: webTable.headers, rows: webTable.rows });
    const label = url.trim();
    addRecentSource({ kind: 'web', label, payload: label });
    registerQuery('web', undefined, label, undefined, grid);
    onLoad(grid, { name: label, kind: 'web' });
    onClose();
  };

  const loadRecent = (src: RecentSource): void => {
    setError('');
    try {
      if (src.kind === 'web') {
        setTab('web');
        setUrl(src.payload);
        setWebText('');
        setFetchError('');
      } else {
        const delim = detectDelimiter(src.payload);
        const t = parseDelimited(src.payload, delim);
        if (t.headers.length === 0) { setError('Could not parse the recent source.'); return; }
        const grid = [t.headers, ...t.rows];
        onLoad(grid, { name: src.label, kind: 'text' });
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
    }
  };

  const preview = (headers: string[], rows: string[][]): React.ReactNode => (
    <div style={{ maxHeight: 160, overflow: 'auto', border: '1px solid var(--line-soft)', marginTop: 4 }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
        <thead>
          <tr>{headers.map((h, i) => <th key={i} style={{ border: '1px solid var(--line-soft)', padding: 4, background: '#f3f4f6' }}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.slice(0, 8).map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j} style={{ border: '1px solid var(--line-soft)', padding: 4 }}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <A11yDialog title={<>Import Data</>} width={720} onClose={onClose}>
        <div className="dialog-row" role="tablist" aria-label="Import source">
          {([['text', 'From Text/CSV'], ['web', 'From Web'], ['recent', 'Recent Sources'], ['connections', 'Existing Connections']] as [Tab, string][]).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'tab-active' : ''} onClick={() => setTab(k)} style={{ marginRight: 6 }}>
              {label}
            </button>
          ))}
        </div>

        {tab === 'text' && (
          <>
            <div className="dialog-row">
              <textarea
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                rows={5}
                style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
                aria-label="Text to import"
                placeholder="Paste delimited text here…"
              />
            </div>
            <div className="dialog-row" style={{ gap: 12, alignItems: 'center' }}>
              <label>
                Delimiter:{' '}
                <select value={delimiter} onChange={(e) => setDelimiter(e.target.value)} aria-label="Delimiter">
                  {DELIMITER_PRESETS.map((d) => <option key={d.id} value={d.char}>{d.label}</option>)}
                  <option value="custom">Custom…</option>
                </select>
              </label>
              {delimiter === 'custom' && (
                <input value={customDelim} onChange={(e) => setCustomDelim(e.target.value)} size={3} maxLength={1} aria-label="Custom delimiter" placeholder=";" />
              )}
              <label>
                <input type="checkbox" checked={firstRowHeader} onChange={(e) => setFirstRowHeader(e.target.checked)} /> First row is header
              </label>
              <button onClick={() => setDelimiter(detectDelimiter(rawText))} title="Guess the delimiter from the text">Detect</button>
            </div>
            <strong>Preview</strong>
            {preview(textTable.headers, textTable.rows)}
            <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>{textTable.rows.length} rows × {textTable.headers.length} columns</div>
          </>
        )}

        {tab === 'web' && (
          <>
            <div className="dialog-row">
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/data.csv" style={{ flex: 1, marginRight: 8 }} aria-label="Data URL" />
              <button onClick={() => void fetchWeb()} disabled={fetching}>{fetching ? 'Fetching…' : 'Fetch'}</button>
              {fetchError && <span style={{ color: 'red', marginLeft: 8 }}>{fetchError}</span>}
            </div>
            {webText && (
              <>
                <strong>Preview ({webKind.toUpperCase()})</strong>
                {preview(webTable.headers, webTable.rows)}
                <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>{webTable.rows.length} rows × {webTable.headers.length} columns</div>
              </>
            )}
          </>
        )}

        {tab === 'recent' && (
          <div className="dialog-row">
            {recent.length === 0 && <span style={{ color: '#888' }}>No recent sources yet — import something first.</span>}
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, width: '100%' }}>
              {recent.map((r) => (
                <li key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--line-soft)' }}>
                  <span style={{ fontSize: 12, color: '#666', width: 64 }}>{r.kind === 'web' ? 'Web' : 'Text'}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.payload}>{r.label}</span>
                  <span style={{ fontSize: 12, color: '#888' }}>{timeAgo(r.at)}</span>
                  <button onClick={() => loadRecent(r)}>Import</button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {tab === 'connections' && (
          <div className="dialog-row">
            {connections.length === 0 && <span style={{ color: '#888' }}>No existing connections. Use Get Data (Power Query) to connect a source first.</span>}
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, width: '100%' }}>
              {connections.map((c) => (
                <li key={c.id ?? c.sheetName} style={{ padding: '6px 0', borderBottom: '1px solid var(--line-soft)' }}>
                  <div><strong>{c.sheetName}</strong> <span style={{ fontSize: 12, color: '#666' }}>({c.spec?.kind ?? 'connection'})</span></div>
                  <div style={{ fontSize: 12, color: '#888' }}>Last refresh: {timeAgo(c.lastRefresh ?? null)}</div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && <div style={{ color: 'red', fontSize: 13 }}>{error}</div>}

        <div className="dialog-actions">
          {tab === 'text' && <button onClick={loadText} disabled={textTable.headers.length === 0}>Load to sheet</button>}
          {tab === 'web' && <button onClick={loadWeb} disabled={webTable.headers.length === 0}>Load to sheet</button>}
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}
