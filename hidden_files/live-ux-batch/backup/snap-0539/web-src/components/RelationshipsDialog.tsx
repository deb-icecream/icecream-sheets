/**
 * Relationships dialog + data-model manager (Data > Data Tools >
 * Relationships, Manage Data Model).
 *
 * The engine has no multi-table data model (tables are independent
 * sheets), so this dialog manages the lightweight relationship registry
 * from features/relationships.ts: table pairs joined on key columns,
 * with validation, a RELATED()-style lookup tester, and XLOOKUP formula
 * generation that realizes the join in the grid. The parent supplies
 * table definitions (sheet names + headers + rows) and persists the
 * registry via onChange.
 */
import { useState } from 'react';
import A11yDialog from './A11yDialog';
import {
  createRelationship,
  loadRelationships,
  relatedLookup,
  relationshipFormula,
  saveRelationships,
  type Relationship,
  type TableDef,
} from '../features/relationships';

interface RelationshipsDialogProps {
  tables: TableDef[];
  onClose: () => void;
  onChange?: (rels: Relationship[]) => void;
}

export default function RelationshipsDialog({ tables, onClose, onChange }: RelationshipsDialogProps) {
  const [rels, setRels] = useState<Relationship[]>(() => loadRelationships());
  const [fromTable, setFromTable] = useState(tables[0]?.name ?? '');
  const [fromColumn, setFromColumn] = useState('');
  const [toTable, setToTable] = useState(tables[1]?.name ?? tables[0]?.name ?? '');
  const [toColumn, setToColumn] = useState('');
  const [testRelId, setTestRelId] = useState('');
  const [testKey, setTestKey] = useState('');
  const [testColumn, setTestColumn] = useState('');
  const [testResult, setTestResult] = useState<string[]>([]);
  const [formula, setFormula] = useState('');
  const [error, setError] = useState('');

  const persist = (next: Relationship[]): void => {
    setRels(next);
    saveRelationships(next);
    onChange?.(next);
  };

  const columnsOf = (name: string): string[] => tables.find((t) => t.name === name)?.headers ?? [];

  const add = (): void => {
    setError('');
    try {
      const rel = createRelationship({ fromTable, fromColumn, toTable, toColumn }, tables);
      persist([...rels, rel]);
      setFromColumn('');
      setToColumn('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create relationship.');
    }
  };

  const remove = (id: string): void => {
    const next = rels.filter((r) => r.id !== id);
    persist(next);
    if (testRelId === id) { setTestRelId(''); setTestResult([]); setFormula(''); }
  };

  const runTest = (): void => {
    setError('');
    try {
      const rel = rels.find((r) => r.id === testRelId);
      if (!rel) throw new Error('Pick a relationship to test.');
      if (!testKey) throw new Error('Enter a key value to look up.');
      if (!testColumn) throw new Error('Pick a return column.');
      setTestResult(relatedLookup(rel, tables, testKey, testColumn));
      setFormula(relationshipFormula(rel, tables, 'A2', testColumn).replace('A2', '<from-cell>'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lookup failed.');
    }
  };

  const testRel = rels.find((r) => r.id === testRelId);

  return (
    <A11yDialog title={<>Manage Relationships</>} width={560} onClose={onClose}>

        <strong>Relationships ({rels.length})</strong>
        {rels.length === 0 && <p style={{ color: '#888', fontSize: 13 }}>No relationships yet. Add one below.</p>}
        <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0' }}>
          {rels.map((r) => (
            <li key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', borderBottom: '1px solid var(--line-soft)', fontSize: 13 }}>
              <span style={{ flex: 1 }}>
                <strong>{r.fromTable}</strong>.{r.fromColumn} → <strong>{r.toTable}</strong>.{r.toColumn}
              </span>
              <button onClick={() => remove(r.id)}>Delete</button>
            </li>
          ))}
        </ul>

        <strong>New relationship</strong>
        <div className="dialog-row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label>From table<br />
            <select value={fromTable} onChange={(e) => { setFromTable(e.target.value); setFromColumn(''); }}>
              {tables.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
            </select>
          </label>
          <label>Column<br />
            <select value={fromColumn} onChange={(e) => setFromColumn(e.target.value)}>
              <option value="">—</option>
              {columnsOf(fromTable).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label>To table<br />
            <select value={toTable} onChange={(e) => { setToTable(e.target.value); setToColumn(''); }}>
              {tables.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
            </select>
          </label>
          <label>Column<br />
            <select value={toColumn} onChange={(e) => setToColumn(e.target.value)}>
              <option value="">—</option>
              {columnsOf(toTable).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <button onClick={add}>Add</button>
        </div>

        <strong>Test lookup (RELATED)</strong>
        <div className="dialog-row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label>Relationship<br />
            <select value={testRelId} onChange={(e) => setTestRelId(e.target.value)}>
              <option value="">—</option>
              {rels.map((r) => <option key={r.id} value={r.id}>{r.fromTable} → {r.toTable}</option>)}
            </select>
          </label>
          <label>Key value<br />
            <input value={testKey} onChange={(e) => setTestKey(e.target.value)} size={10} placeholder="e.g. C1" />
          </label>
          <label>Return column<br />
            <select value={testColumn} onChange={(e) => setTestColumn(e.target.value)}>
              <option value="">—</option>
              {testRel && columnsOf(testRel.toTable).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <button onClick={runTest}>Look up</button>
        </div>
        {testResult.length > 0 && (
          <div style={{ fontSize: 13, marginTop: 4 }}>
            Result: <strong>{testResult.join(', ')}</strong>
            {formula && <div style={{ fontFamily: 'monospace', fontSize: 12, marginTop: 4 }}>Grid formula: {formula}</div>}
          </div>
        )}

        {error && <div style={{ color: 'red', fontSize: 13 }}>{error}</div>}
        <div className="dialog-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </A11yDialog>
  );
}
