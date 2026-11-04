/**
 * Dialogs for conditional formatting rules and data validation lists.
 */
import { useState } from 'react';
import type { CFOperator } from '../features/models';
import { a1Short } from '../engine';
import A11yDialog from './A11yDialog';

// ---------------------------------------------------------------------------
// Conditional formatting rule dialog
// ---------------------------------------------------------------------------

interface CFDialogProps {
  cellLabel: string;
  onClose: () => void;
  onAdd: (operator: CFOperator, operands: string[], color: string) => void;
}

const OPERATORS: { id: CFOperator; label: string; operands: number }[] = [
  { id: 'gt', label: 'Greater than', operands: 1 },
  { id: 'lt', label: 'Less than', operands: 1 },
  { id: 'eq', label: 'Equal to', operands: 1 },
  { id: 'between', label: 'Between', operands: 2 },
  { id: 'contains', label: 'Text contains', operands: 1 },
];

const COLORS = [
  { name: 'Red', value: '#ffc7ce' },
  { name: 'Green', value: '#c6efce' },
  { name: 'Yellow', value: '#ffeb9c' },
  { name: 'Blue', value: '#bdd7ee' },
];

export function CFDialog({ cellLabel, onClose, onAdd }: CFDialogProps) {
  const [op, setOp] = useState<CFOperator>('gt');
  const [v1, setV1] = useState('');
  const [v2, setV2] = useState('');
  const [color, setColor] = useState(COLORS[0].value);

  const def = OPERATORS.find((o) => o.id === op) ?? OPERATORS[0];

  return (
    <A11yDialog title={<>Highlight {cellLabel}</>} onClose={onClose}>
        <label className="dialog-row">
          <span>Rule:</span>
          <select value={op} onChange={(e) => setOp(e.target.value as CFOperator)}>
            {OPERATORS.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </label>
        <label className="dialog-row">
          <span>Value:</span>
          <input value={v1} onChange={(e) => setV1(e.target.value)} placeholder="Value" />
        </label>
        {def.operands === 2 && (
          <label className="dialog-row">
            <span>And:</span>
            <input value={v2} onChange={(e) => setV2(e.target.value)} placeholder="Upper value" />
          </label>
        )}
        <label className="dialog-row">
          <span>Color:</span>
          <select value={color} onChange={(e) => setColor(e.target.value)}>
            {COLORS.map((c) => (
              <option key={c.value} value={c.value}>{c.name}</option>
            ))}
          </select>
        </label>
        <div className="dialog-actions">
          <button
            disabled={!v1}
            onClick={() => {
              onAdd(op, def.operands === 2 ? [v1, v2] : [v1], color);
              onClose();
            }}
          >
            Add Rule
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}

// ---------------------------------------------------------------------------
// Data validation dialog
// ---------------------------------------------------------------------------

interface ValidationDialogProps {
  cellLabel: string;
  existing: string[];
  onClose: () => void;
  onSave: (list: string[]) => void;
  onClear: () => void;
}

export function ValidationDialog({ cellLabel, existing, onClose, onSave, onClear }: ValidationDialogProps) {
  const [text, setText] = useState(existing.join(', '));

  return (
    <A11yDialog title={<>Validate {cellLabel} — dropdown list</>} onClose={onClose}>
        <label className="dialog-row">
          <span>Values (comma-separated):</span>
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. Red, Green, Blue"
          />
        </label>
        <div className="dialog-hint">Typing in the cell is restricted to these values.</div>
        <div className="dialog-actions">
          <button
            onClick={() => {
              const list = text.split(',').map((s) => s.trim()).filter((s) => s !== '');
              onSave(list);
              onClose();
            }}
          >
            Save
          </button>
          {existing.length > 0 && (
            <button onClick={() => { onClear(); onClose(); }}>Clear Rule</button>
          )}
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}

// ---------------------------------------------------------------------------
// Filter dialog (per-column value picker)
// ---------------------------------------------------------------------------

interface FilterDialogProps {
  colLabel: string;
  values: string[];
  selected: Set<string>;
  onClose: () => void;
  onApply: (selected: Set<string> | null) => void;
}

export function FilterDialog({ colLabel: label, values, selected, onClose, onApply }: FilterDialogProps) {
  const [sel, setSel] = useState<Set<string>>(new Set(selected));

  const toggle = (v: string) => {
    const next = new Set(sel);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    setSel(next);
  };

  return (
    <A11yDialog title={<>Filter column {label}</>} onClose={onClose}>
        <div className="filter-list">
          {values.map((v) => (
            <label key={v} className="filter-item">
              <input type="checkbox" checked={sel.has(v)} onChange={() => toggle(v)} />
              <span>{v === '' ? '(empty)' : v}</span>
            </label>
          ))}
        </div>
        <div className="dialog-actions">
          <button onClick={() => { onApply(sel); onClose(); }}>Apply</button>
          <button onClick={() => { onApply(null); onClose(); }}>Clear Filter</button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}

export function cellLabelOf(row: number, col: number): string {
  return a1Short(row, col);
}
