/**
 * Power Query dialog (track 6): import from CSV / JSON / URL, preview,
 * apply shaping steps, and load the result into the sheet.
 */
import { useMemo, useState } from 'react';
import {
  parseCSV,
  parseJSONRecords,
  applySteps,
  stepLabel,
  tableToGrid,
  type PQStep,
  type PQTable,
  EMPTY_TABLE,
} from '../features/powerQuery';
import A11yDialog from './A11yDialog';

interface PowerQueryDialogProps {
  onClose: () => void;
  onLoad: (grid: string[][]) => void;
}

type SourceKind = 'csv' | 'json' | 'url';

export default function PowerQueryDialog({ onClose, onLoad }: PowerQueryDialogProps) {
  const [sourceKind, setSourceKind] = useState<SourceKind>('csv');
  const [rawText, setRawText] = useState('Name,Age,City\nAlice,30,NYC\nBob,25,LA');
  const [url, setUrl] = useState('');
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [steps, setSteps] = useState<PQStep[]>([]);
  // Step builder state
  const [stepKind, setStepKind] = useState<PQStep['kind']>('filter');
  const [sbCol, setSbCol] = useState('');
  const [sbOp, setSbOp] = useState<'eq' | 'neq' | 'contains' | 'gt' | 'lt'>('eq');
  const [sbVal, setSbVal] = useState('');
  const [sbCols, setSbCols] = useState('');
  const [sbType, setSbType] = useState<'text' | 'number' | 'date' | 'boolean'>('number');
  const [sbDir, setSbDir] = useState<'asc' | 'desc'>('asc');
  const [sbRenameTo, setSbRenameTo] = useState('');

  const base: PQTable = useMemo(() => {
    try {
      if (sourceKind === 'csv') return parseCSV(rawText);
      return parseJSONRecords(rawText);
    } catch {
      return EMPTY_TABLE;
    }
  }, [rawText, sourceKind]);

  const result: PQTable = useMemo(() => {
    try {
      return applySteps(base, steps);
    } catch {
      return base;
    }
  }, [base, steps]);

  const fetchUrl = async (): Promise<void> => {
    if (!url.trim()) return;
    setFetching(true);
    setFetchError('');
    try {
      const res = await fetch(url.trim());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      setRawText(text);
      const ct = res.headers.get('content-type') ?? '';
      setSourceKind(ct.includes('json') || text.trim().startsWith('{') || text.trim().startsWith('[') ? 'json' : 'csv');
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : 'Fetch failed');
    } finally {
      setFetching(false);
    }
  };

  const addStep = (): void => {
    const col = sbCol || base.headers[0] || '';
    let step: PQStep | null = null;
    switch (stepKind) {
      case 'filter':
        if (col) step = { kind: 'filter', column: col, op: sbOp, value: sbVal };
        break;
      case 'select': {
        const cols = sbCols.split(',').map((c) => c.trim()).filter(Boolean);
        if (cols.length) step = { kind: 'select', columns: cols };
        break;
      }
      case 'rename':
        if (col && sbRenameTo.trim()) step = { kind: 'rename', from: col, to: sbRenameTo.trim() };
        break;
      case 'setType':
        if (col) step = { kind: 'setType', column: col, type: sbType };
        break;
      case 'removeDuplicates':
        step = { kind: 'removeDuplicates', columns: [] };
        break;
      case 'sort':
        if (col) step = { kind: 'sort', column: col, dir: sbDir };
        break;
    }
    if (step) {
      setSteps((prev) => [...prev, step as PQStep]);
      setSbVal(''); setSbCols(''); setSbRenameTo('');
    }
  };

  const previewRows = result.rows.slice(0, 8);

  return (
    <A11yDialog title={<>Get Data (Power Query)</>} width={720} onClose={onClose}>

        <div className="dialog-row" role="tablist" aria-label="Data source">
          {(['csv', 'json', 'url'] as SourceKind[]).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={sourceKind === k}
              className={sourceKind === k ? 'tab-active' : ''}
              onClick={() => setSourceKind(k)}
              style={{ marginRight: 6 }}
            >
              {k === 'csv' ? 'CSV' : k === 'json' ? 'JSON' : 'Web URL'}
            </button>
          ))}
        </div>

        {sourceKind === 'url' ? (
          <div className="dialog-row">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/data.csv"
              style={{ flex: 1, marginRight: 8 }}
              aria-label="Data URL"
            />
            <button onClick={() => void fetchUrl()} disabled={fetching}>
              {fetching ? 'Fetching…' : 'Fetch'}
            </button>
            {fetchError && <span style={{ color: 'red', marginLeft: 8 }}>{fetchError}</span>}
          </div>
        ) : (
          <div className="dialog-row">
            <textarea
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              rows={5}
              style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
              aria-label={sourceKind === 'csv' ? 'CSV text' : 'JSON text'}
              placeholder={sourceKind === 'csv' ? 'Paste CSV here…' : 'Paste JSON array here…'}
            />
          </div>
        )}

        <div className="dialog-row" style={{ alignItems: 'flex-start', gap: 16 }}>
          <div style={{ flex: 1 }}>
            <strong>Preview</strong>
            <div style={{ maxHeight: 150, overflow: 'auto', border: '1px solid var(--line-soft)', marginTop: 4 }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
                <thead>
                  <tr>{result.headers.map((h) => <th key={h} style={{ border: '1px solid var(--line-soft)', padding: 4, background: '#f3f4f6' }}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {previewRows.map((r, i) => (
                    <tr key={i}>{r.map((c, j) => <td key={j} style={{ border: '1px solid var(--line-soft)', padding: 4 }}>{c}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
              {result.rows.length} rows × {result.headers.length} columns
              {result.rows.length > 8 && ' (showing first 8)'}
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <strong>Applied steps</strong>
            <ul style={{ fontSize: 12, paddingLeft: 18, margin: '4px 0' }}>
              {steps.length === 0 && <li style={{ color: '#888' }}>No steps yet</li>}
              {steps.map((s, i) => (
                <li key={i}>
                  {stepLabel(s)}{' '}
                  <button onClick={() => setSteps((p) => p.filter((_, j) => j !== i))} aria-label={`Remove step ${i + 1}`}>×</button>
                </li>
              ))}
            </ul>
            <div style={{ fontSize: 12, marginTop: 8 }}>
              <select value={stepKind} onChange={(e) => setStepKind(e.target.value as PQStep['kind'])} aria-label="Step type">
                <option value="filter">Filter rows</option>
                <option value="select">Keep columns</option>
                <option value="rename">Rename column</option>
                <option value="setType">Change type</option>
                <option value="removeDuplicates">Remove duplicates</option>
                <option value="sort">Sort</option>
              </select>{' '}
              {stepKind !== 'removeDuplicates' && stepKind !== 'select' && (
                <select value={sbCol} onChange={(e) => setSbCol(e.target.value)} aria-label="Step column">
                  <option value="">— column —</option>
                  {base.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              )}{' '}
              {stepKind === 'filter' && (
                <>
                  <select value={sbOp} onChange={(e) => setSbOp(e.target.value as typeof sbOp)} aria-label="Filter operator">
                    <option value="eq">=</option><option value="neq">≠</option>
                    <option value="contains">contains</option><option value="gt">&gt;</option><option value="lt">&lt;</option>
                  </select>{' '}
                  <input value={sbVal} onChange={(e) => setSbVal(e.target.value)} placeholder="value" size={10} aria-label="Filter value" />
                </>
              )}
              {stepKind === 'select' && (
                <input value={sbCols} onChange={(e) => setSbCols(e.target.value)} placeholder="col1, col2" size={16} aria-label="Columns to keep" />
              )}
              {stepKind === 'rename' && (
                <input value={sbRenameTo} onChange={(e) => setSbRenameTo(e.target.value)} placeholder="new name" size={12} aria-label="New column name" />
              )}
              {stepKind === 'setType' && (
                <select value={sbType} onChange={(e) => setSbType(e.target.value as typeof sbType)} aria-label="Target type">
                  <option value="text">Text</option><option value="number">Number</option>
                  <option value="date">Date</option><option value="boolean">True/False</option>
                </select>
              )}
              {stepKind === 'sort' && (
                <select value={sbDir} onChange={(e) => setSbDir(e.target.value as typeof sbDir)} aria-label="Sort direction">
                  <option value="asc">Ascending</option><option value="desc">Descending</option>
                </select>
              )}{' '}
              <button onClick={addStep}>Add step</button>
            </div>
          </div>
        </div>

        <div className="dialog-actions">
          <button
            onClick={() => { onLoad(tableToGrid(result)); onClose(); }}
            disabled={result.headers.length === 0}
          >
            Load to sheet
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}
