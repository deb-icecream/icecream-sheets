/**
 * Smart chips UI: insert dialog and detail card, mirroring the
 * stock/geography DataTypes.tsx pattern (chip button in the grid,
 * popover card with clickable field values).
 */
import { useState } from 'react';
import {
  resolveSmartChip,
  chipOptions,
  chipEmoji,
  chipKindLabel,
  SMART_CHIP_KINDS,
  type SmartChipValue,
  type SmartChipKind,
} from '../features/smartChips';
import A11yDialog from './A11yDialog';

interface SmartChipDialogProps {
  onClose: () => void;
  onInsert: (value: SmartChipValue) => void;
}

export function SmartChipDialog({ onClose, onInsert }: SmartChipDialogProps) {
  const [kind, setKind] = useState<SmartChipKind>('person');
  const [query, setQuery] = useState('');
  const options = chipOptions(kind);
  const filtered = options.filter((o) => o.toLowerCase().includes(query.toLowerCase()));

  const insert = (key: string): void => {
    const v = resolveSmartChip(kind, key);
    if (v) { onInsert(v); onClose(); }
  };

  return (
    <A11yDialog title={<>Smart Chips</>} width={420} onClose={onClose}>
        <div className="dialog-row" role="tablist" aria-label="Smart chip kind">
          {SMART_CHIP_KINDS.map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={kind === k}
              className={kind === k ? 'tab-active' : ''}
              onClick={() => { setKind(k); setQuery(''); }}
              style={{ marginRight: 6 }}
            >
              {chipEmoji(k)} {chipKindLabel(k)}
            </button>
          ))}
        </div>
        <div className="dialog-row">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${chipKindLabel(kind).toLowerCase()}s…`}
            style={{ width: '100%' }}
            aria-label="Search smart chips"
          />
        </div>
        <div className="dialog-row" style={{ maxHeight: 220, overflow: 'auto' }}>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, width: '100%' }}>
            {filtered.map((o) => (
              <li key={o}>
                <button
                  onClick={() => insert(o)}
                  style={{ width: '100%', textAlign: 'left', padding: '6px 8px' }}
                >
                  {chipEmoji(kind)} {o}
                </button>
              </li>
            ))}
            {filtered.length === 0 && <li style={{ color: '#888' }}>No matches</li>}
          </ul>
        </div>
        <div className="dialog-row" style={{ fontSize: 11, color: '#888' }}>
          Tip: type <code>=CHIP("{kind}","…")</code> in a cell to insert by formula.
        </div>
        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}

interface SmartChipCardProps {
  value: SmartChipValue;
  onClose: () => void;
  onExtractField: (label: string, fieldValue: string) => void;
}

/** Popover card showing all fields of a smart chip value. */
export function SmartChipCard({ value, onClose, onExtractField }: SmartChipCardProps) {
  return (
    <div
      className="dialog"
      style={{ position: 'absolute', zIndex: 60, width: 260, padding: 12 }}
      role="dialog"
      aria-label={`${chipKindLabel(value.kind)} details for ${value.display}`}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong>{value.emoji} {value.display}</strong>
        <button onClick={onClose} aria-label="Close details">×</button>
      </div>
      <table style={{ fontSize: 13, width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {value.fields.map((f) => (
            <tr key={f.label}>
              <td style={{ color: '#666', padding: '3px 6px 3px 0' }}>{f.label}</td>
              <td style={{ padding: '3px 0' }}>
                <button
                  onClick={() => onExtractField(f.label, f.value)}
                  title={`Insert ${f.label} into the cell below`}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, font: 'inherit', textAlign: 'left' }}
                >
                  {f.value}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 11, color: '#888', marginTop: 8 }}>
        Sample data · click a value to insert it below
      </div>
    </div>
  );
}
