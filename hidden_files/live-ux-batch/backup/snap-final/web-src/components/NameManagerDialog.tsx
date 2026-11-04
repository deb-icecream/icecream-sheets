/**
 * Name Manager dialog: list, add, edit, and delete named ranges.
 *
 * Backed by the service-layer NamedRangeStore (design-docs §1–§5):
 * stable IDs, workbook/sheet scope with shadowing, case-insensitive
 * collision rejection, dangling names (#REF!), and permission checks.
 * The store is the source of truth; the dialog refreshes from it.
 */
import { useState } from 'react';
import type { NamedRangeStore, NamedRangeDef, NameScope } from '@icecream-sheets/service';
import A11yDialog from './A11yDialog';

interface NameManagerDialogProps {
  store: NamedRangeStore;
  sheetNames: string[];
  defaultSheet: string;
  principal: string;
  onClose: () => void;
  onChanged: () => void;
  /** Capture a names-only undo entry before each mutation (optional). */
  onBeforeChange?: (label: string) => void;
}

/** Format a NameRangeRef as "Sheet1!$A$1:$B$2". Null for dangling names. */
function formatRef(def: NamedRangeDef): string {
  const r = def.ref;
  if (!r) return '#REF!';
  const tl = `$${colLabel(r.startCol)}$${r.startRow + 1}`;
  const br = `$${colLabel(r.endCol)}$${r.endRow + 1}`;
  const range = r.startRow === r.endRow && r.startCol === r.endCol ? tl : `${tl}:${br}`;
  return `${quoteSheet(r.sheet)}!${range}`;
}

function colLabel(col: number): string {
  let s = '';
  let c = col;
  do {
    s = String.fromCharCode(65 + (c % 26)) + s;
    c = Math.floor(c / 26) - 1;
  } while (c >= 0);
  return s;
}

function quoteSheet(sheet: string): string {
  if (sheet.includes(' ') || sheet.includes("'")) {
    return `'${sheet.replace(/'/g, "''")}'`;
  }
  return sheet;
}

export function NameManagerDialog({
  store,
  sheetNames,
  defaultSheet,
  principal,
  onClose,
  onChanged,
  onBeforeChange,
}: NameManagerDialogProps) {
  const [names, setNames] = useState<NamedRangeDef[]>(() => store.list());
  const [nameText, setNameText] = useState('');
  const [scope, setScope] = useState<string>('workbook');
  const [refText, setRefText] = useState('');
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRef, setEditRef] = useState('');

  const refresh = () => {
    setNames(store.list());
    onChanged();
  };

  const handleAdd = async () => {
    const name = nameText.trim();
    if (!name) {
      setError('Enter a name.');
      return;
    }
    if (!refText.trim()) {
      setError('Enter a reference (e.g. A1:A10).');
      return;
    }
    // Parse "Sheet1!A1:A10" or "A1:A10" (defaults to the scope sheet).
    const refInput = refText.trim();
    const bangIdx = refInput.indexOf('!');
    let sheet = scope === 'workbook' ? defaultSheet : scope;
    let a1 = refInput;
    if (bangIdx >= 0) {
      const sheetPart = refInput.slice(0, bangIdx).replace(/^'(.*)'$/, '$1').replace(/''/g, "'");
      if (sheetPart) sheet = sheetPart;
      a1 = refInput.slice(bangIdx + 1);
    }
    const parsed = parseA1(a1);
    if (!parsed) {
      setError('Invalid reference: use A1 or A1:B10 style (e.g. A1:A10).');
      return;
    }
    const nameScope: NameScope = scope === 'workbook' ? { kind: 'workbook' } : { kind: 'sheet', sheet: scope };
    try {
      onBeforeChange?.(`Define name ${name}`);
      await store.define({
        name,
        scope: nameScope,
        ref: { sheet, ...parsed },
        principal,
      });
      setError('');
      setNameText('');
      setRefText('');
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDelete = async (id: string) => {
    const def = names.find((n) => n.id === id);
    try {
      onBeforeChange?.(`Delete name ${def?.name ?? id}`);
      await store.undefine(id, principal);
      setError('');
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const startEdit = (def: NamedRangeDef) => {
    if (!def.ref) {
      setError('Cannot edit a dangling (#REF!) name.');
      return;
    }
    setEditingId(def.id);
    // Pre-fill with the current A1 (without sheet prefix).
    const r = def.ref;
    const tl = `${colLabel(r.startCol)}${r.startRow + 1}`;
    const br = `${colLabel(r.endCol)}${r.endRow + 1}`;
    setEditRef(r.startRow === r.endRow && r.startCol === r.endCol ? tl : `${tl}:${br}`);
    setError('');
  };

  const handleEditSave = async (def: NamedRangeDef) => {
    if (!def.ref) {
      setError('Cannot edit a dangling (#REF!) name.');
      return;
    }
    const parsed = parseA1(editRef.trim());
    if (!parsed) {
      setError('Invalid reference: use A1 or A1:B10 style.');
      return;
    }
    try {
      onBeforeChange?.(`Edit name ${def.name}`);
      await store.redefine(def.id, { sheet: def.ref.sheet, ...parsed }, principal);
      setError('');
      setEditingId(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <A11yDialog title={<>Name Manager</>} onClose={onClose}>
      {names.length === 0 ? (
        <div className="dialog-hint">No named ranges yet.</div>
      ) : (
        <table className="name-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>ID</th>
              <th>Scope</th>
              <th>Refers to</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {names.map((n) => (
              <tr key={n.id}>
                <td>{n.name}</td>
                <td title={n.id} style={{ fontFamily: 'monospace', fontSize: 11 }}>
                  {n.id.length > 12 ? `${n.id.slice(0, 12)}…` : n.id}
                </td>
                <td>{n.scope.kind === 'workbook' ? 'Workbook' : n.scope.sheet}</td>
                <td>
                  {editingId === n.id ? (
                    <input
                      value={editRef}
                      onChange={(e) => setEditRef(e.target.value)}
                      placeholder="A1:A10"
                      style={{ width: 120 }}
                    />
                  ) : (
                    formatRef(n)
                  )}
                </td>
                <td>{n.ref === null ? '#REF!' : ''}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {editingId === n.id ? (
                    <>
                      <button onClick={() => handleEditSave(n)}>Save</button>{' '}
                      <button onClick={() => setEditingId(null)}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => startEdit(n)}>Edit</button>{' '}
                      <button onClick={() => handleDelete(n.id)}>Delete</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="dialog-title" style={{ marginTop: 12 }}>Add Name</div>
      <label className="dialog-row">
        <span>Name:</span>
        <input
          value={nameText}
          onChange={(e) => setNameText(e.target.value)}
          placeholder="e.g. Sales"
        />
      </label>
      <label className="dialog-row">
        <span>Scope:</span>
        <select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="workbook">Workbook</option>
          {sheetNames.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </label>
      <label className="dialog-row">
        <span>Refers to:</span>
        <input
          value={refText}
          onChange={(e) => setRefText(e.target.value)}
          placeholder="e.g. A1:A10 or Sheet1!A1:A10"
        />
      </label>
      <div className="dialog-hint">
        Names are case-insensitive. A sheet-scoped name shadows a workbook name.
        Collisions are rejected (never renamed). Deleting all cells leaves a
        dangling #REF! name.
      </div>
      {error && <div className="dialog-error">{error}</div>}
      <div className="dialog-actions">
        <button onClick={handleAdd}>Add Name</button>
        <button onClick={onClose}>Close</button>
      </div>
    </A11yDialog>
  );
}

/** Parse "A1", "$A$1", "A1:B10" into 0-based coordinates. Null on invalid. */
function parseA1(text: string): {
  startRow: number; startCol: number; endRow: number; endCol: number;
} | null {
  const clean = text.trim().replace(/\s+/g, '');
  const part = '\\$?([A-Za-z]{1,3})\\$?([0-9]+)';
  const m = new RegExp(`^${part}(?::${part})?$`).exec(clean);
  if (!m) return null;
  const colOf = (letters: string): number => {
    let idx = 0;
    for (const ch of letters.toUpperCase()) idx = idx * 26 + (ch.charCodeAt(0) - 64);
    return idx - 1;
  };
  const sc = colOf(m[1]);
  const sr = Number(m[2]) - 1;
  const ec = m[3] !== undefined ? colOf(m[3]) : sc;
  const er = m[4] !== undefined ? Number(m[4]) - 1 : sr;
  if (sr < 0 || er < 0 || sr > 1048575 || er > 1048575) return null;
  if (sc < 0 || ec < 0 || sc > 16383 || ec > 16383) return null;
  return {
    startRow: Math.min(sr, er), startCol: Math.min(sc, ec),
    endRow: Math.max(sr, er), endCol: Math.max(sc, ec),
  };
}
