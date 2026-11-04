/**
 * External links manager (track 20): list `[n]Sheet!Cell` sources found in
 * formulas, add sample sources, set values, break links.
 */
import { useState } from 'react';
import type { ExternalLinkRegistry } from '../features/externalLinks';
import A11yDialog from './A11yDialog';

interface ExternalLinksDialogProps {
  registry: ExternalLinkRegistry;
  /** All formulas in the workbook (for scanning). */
  formulas: { sheet: string; cell: string; formula: string }[];
  onClose: () => void;
  onChanged: () => void;
}

export default function ExternalLinksDialog({ registry, formulas, onClose, onChanged }: ExternalLinksDialogProps) {
  const [newName, setNewName] = useState('');
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editSheet, setEditSheet] = useState('Sheet1');
  const [editCell, setEditCell] = useState('A1');
  const [editValue, setEditValue] = useState('');

  const sources = registry.listSources();
  const usedIndexes = new Set<number>();
  for (const f of formulas) {
    for (const m of f.formula.matchAll(/\[(\d+)\]/g)) usedIndexes.add(Number(m[1]));
  }

  const add = (): void => {
    if (!newName.trim()) return;
    registry.addSource(newName.trim());
    setNewName('');
    onChanged();
  };

  const saveValue = (): void => {
    if (editIdx === null) return;
    try {
      registry.setValue(editIdx, editSheet, editCell, editValue);
      setEditIdx(null);
      setEditValue('');
      onChanged();
    } catch {
      // unknown source — ignore
    }
  };

  return (
    <A11yDialog title={<>External Links</>} width={560} onClose={onClose}>
        <p style={{ fontSize: 13, color: '#555' }}>
          Formulas can reference other workbooks as <code>[1]Sheet1!A1</code>.
          Register a source to resolve those references, or break a link to keep current values.
        </p>

        {sources.length === 0 && <p style={{ fontSize: 13, color: '#888' }}>No external sources registered.</p>}
        {sources.map((s) => (
          <div key={s.index} style={{ border: '1px solid var(--line-soft)', borderRadius: 4, padding: 8, marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>[{s.index}] {s.name}</strong>
              <span style={{ fontSize: 12, color: '#666' }}>
                {s.values.size} values · {usedIndexes.has(s.index) ? 'used in formulas' : 'unused'}
              </span>
            </div>
            {editIdx === s.index ? (
              <div style={{ marginTop: 8, fontSize: 13, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <input value={editSheet} onChange={(e) => setEditSheet(e.target.value)} size={10} aria-label="Sheet name" placeholder="Sheet1" />
                <input value={editCell} onChange={(e) => setEditCell(e.target.value)} size={6} aria-label="Cell" placeholder="A1" />
                <input value={editValue} onChange={(e) => setEditValue(e.target.value)} size={12} aria-label="Value" placeholder="value" />
                <button onClick={saveValue}>Set</button>
                <button onClick={() => setEditIdx(null)}>Cancel</button>
              </div>
            ) : (
              <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
                <button onClick={() => setEditIdx(s.index)} style={{ fontSize: 12 }}>Set value…</button>
                <button
                  onClick={() => { registry.removeSource(s.index); onChanged(); }}
                  style={{ fontSize: 12 }}
                  title="Remove the source; formulas referencing it will show #REF!"
                >
                  Break link
                </button>
              </div>
            )}
          </div>
        ))}

        <div className="dialog-row" style={{ marginTop: 8 }}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New source name, e.g. Budget 2025.xlsx"
            style={{ flex: 1, marginRight: 8 }}
            aria-label="New external source name"
          />
          <button onClick={add}>Add source</button>
        </div>
        <div className="dialog-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </A11yDialog>
  );
}
