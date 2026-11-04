/**
 * Defined Names dialogs (Formulas > Defined Names):
 * - DefineNameDialog: Define Name… — name, scope, refers-to with validation
 * - ApplyNamesDialog: Apply Names… — pick names; the parent rewrites the
 *   formulas in the used range via applyNamesToFormula()
 * - CreateFromSelectionDialog: Create from Selection — top row / left
 *   column / both; the parent supplies header labels + data ranges
 * - UseInFormulaMenu: Use in Formula — menu inserting names at the cursor
 */
import { useState } from 'react';
import {
  parseRefersTo,
  validateDefineName,
  type DefineNameInput,
} from '../features/definedNames';
import A11yDialog from './A11yDialog';

/** Minimal named-range shape for the define/apply dialogs (UI layer). */
export interface DialogNamedRange {
  name: string;
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

// ---------------------------------------------------------------------------
// Define Name…
// ---------------------------------------------------------------------------

export interface DefineNameDialogProps {
  existing: DialogNamedRange[];
  sheets: string[];
  /** Initial refers-to, e.g. the current selection as "=Sheet1!A1:B2". */
  initialRefersTo: string;
  onSave: (name: DialogNamedRange) => void;
  onClose: () => void;
}

export function DefineNameDialog({ existing, sheets, initialRefersTo, onSave, onClose }: DefineNameDialogProps) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState('workbook');
  const [refersTo, setRefersTo] = useState(initialRefersTo);
  const [error, setError] = useState('');

  const parsed = parseRefersTo(refersTo);

  const save = () => {
    const input: DefineNameInput = { name, scope, refersTo };
    const v = validateDefineName(input, existing);
    if (!v.ok) {
      setError(v.error.message);
      return;
    }
    const p = parseRefersTo(refersTo);
    if (!p) {
      setError('Refers to must be a cell or range reference.');
      return;
    }
    onSave({
      name: scope === 'workbook' ? name.trim() : `${scope}!${name.trim()}`,
      sheet: p.sheet ?? sheets[0] ?? 'Sheet1',
      startRow: p.startRow,
      startCol: p.startCol,
      endRow: p.endRow,
      endCol: p.endCol,
    });
    onClose();
  };

  return (
    <A11yDialog title={<>Define Name</>} width={440} onClose={onClose}>
        <div style={{ padding: 14, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label>
            Name
            <input
              value={name}
              autoFocus
              onChange={(e) => { setName(e.target.value); setError(''); }}
              placeholder="e.g. Sales_Total"
              style={{ display: 'block', width: '100%', marginTop: 4, boxSizing: 'border-box' }}
            />
          </label>
          <label>
            Scope
            <select value={scope} onChange={(e) => setScope(e.target.value)} style={{ display: 'block', width: '100%', marginTop: 4 }}>
              <option value="workbook">Workbook</option>
              {sheets.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            Refers to
            <input
              value={refersTo}
              onChange={(e) => { setRefersTo(e.target.value); setError(''); }}
              placeholder="=Sheet1!$A$1:$A$10"
              style={{ display: 'block', width: '100%', marginTop: 4, boxSizing: 'border-box', fontFamily: 'monospace' }}
            />
          </label>
          {parsed ? (
            <p style={{ color: '#2e7d32', margin: 0 }}>
              → {parsed.sheet ?? '(current sheet)'} rows {parsed.startRow + 1}–{parsed.endRow + 1}, cols {parsed.startCol + 1}–{parsed.endCol + 1}
            </p>
          ) : (
            <p style={{ color: '#b00020', margin: 0 }}>Enter a cell or range reference like =Sheet1!$A$1:$A$10.</p>
          )}
          {error && <p style={{ color: '#b00020', margin: 0 }}>{error}</p>}
        </div>
        <div style={{ padding: '10px 14px', borderTop: '1px solid #ddd', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose}>Cancel</button>
          <button onClick={save} disabled={!parsed || !name.trim()} title="Create the defined name">OK</button>
        </div>
      </A11yDialog>
  );
}

// ---------------------------------------------------------------------------
// Apply Names…
// ---------------------------------------------------------------------------

export interface ApplyNamesDialogProps {
  names: DialogNamedRange[];
  /** How many formulas will be rewritten (parent-computed). */
  formulaCount: number;
  onApply: (names: DialogNamedRange[]) => void;
  onClose: () => void;
}

export function ApplyNamesDialog({ names, formulaCount, onApply, onClose }: ApplyNamesDialogProps) {
  const [checked, setChecked] = useState<Set<string>>(new Set(names.map((n) => n.name)));

  const toggle = (name: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <div
      className="dialog-backdrop"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 8, width: 'min(440px, 94vw)', maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid #ddd' }}>
          <strong>Apply Names</strong>
          <button onClick={onClose}>Close</button>
        </div>
        <div style={{ padding: 14, fontSize: 13, overflowY: 'auto' }}>
          <p style={{ marginTop: 0, color: '#666' }}>
            Replace cell references with the selected names in {formulaCount} formula{formulaCount === 1 ? '' : 's'}.
          </p>
          {names.length === 0 && <p>No defined names yet — create one with Define Name… first.</p>}
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {names.map((n) => (
              <li key={n.name}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={checked.has(n.name)} onChange={() => toggle(n.name)} />
                  <span style={{ fontFamily: 'monospace' }}>{n.name}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
        <div style={{ padding: '10px 14px', borderTop: '1px solid #ddd', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose}>Cancel</button>
          <button
            onClick={() => { onApply(names.filter((n) => checked.has(n.name))); onClose(); }}
            disabled={checked.size === 0}
            title="Rewrite references as names"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create from Selection
// ---------------------------------------------------------------------------

export type CreateOrientation = 'topRow' | 'leftColumn' | 'both';

export interface CreateFromSelectionDialogProps {
  onCreate: (orientation: CreateOrientation) => void;
  onClose: () => void;
}

export function CreateFromSelectionDialog({ onCreate, onClose }: CreateFromSelectionDialogProps) {
  const [orientation, setOrientation] = useState<CreateOrientation>('topRow');
  return (
    <div
      className="dialog-backdrop"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 8, width: 'min(400px, 94vw)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid #ddd' }}>
          <strong>Create Names from Selection</strong>
          <button onClick={onClose}>Close</button>
        </div>
        <div style={{ padding: 14, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ marginTop: 0, color: '#666' }}>Use labels in the selection as names for the adjacent data.</p>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={orientation === 'topRow' || orientation === 'both'} onChange={() => setOrientation(orientation === 'leftColumn' ? 'both' : 'topRow')} />
            Top row (labels name the column below)
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={orientation === 'leftColumn' || orientation === 'both'} onChange={() => setOrientation(orientation === 'topRow' ? 'both' : 'leftColumn')} />
            Left column (labels name the row to the right)
          </label>
        </div>
        <div style={{ padding: '10px 14px', borderTop: '1px solid #ddd', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose}>Cancel</button>
          <button onClick={() => { onCreate(orientation); onClose(); }} title="Create names from the selection's labels">OK</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Use in Formula
// ---------------------------------------------------------------------------

export interface UseInFormulaMenuProps {
  names: DialogNamedRange[];
  onInsert: (name: string) => void;
}

/** Inline menu listing defined names; the parent inserts at the cursor. */
export function UseInFormulaMenu({ names, onInsert }: UseInFormulaMenuProps) {
  if (names.length === 0) return <div style={{ padding: 8, fontSize: 12, color: '#666' }}>No defined names.</div>;
  return (
    <div style={{ maxHeight: 240, overflowY: 'auto', fontSize: 13 }}>
      {names.map((n) => (
        <button
          key={n.name}
          onClick={() => onInsert(n.name.includes('!') ? n.name.split('!').slice(1).join('!') : n.name)}
          title={`Insert ${n.name}`}
          style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'monospace' }}
        >
          {n.name}
        </button>
      ))}
    </div>
  );
}
