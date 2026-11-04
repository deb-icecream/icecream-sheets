/**
 * Linked data types UI (track 15): insert stock / geography rich values and
 * show their field cards. Rich values are stored in App state keyed by cell;
 * the grid renders them as chips.
 */
import { useState } from 'react';
import {
  resolveStockLive,
  resolveGeographyLive,
  stockSymbols,
  placeNames,
  type DataTypeValue,
  type DataTypeKind,
} from '../features/dataTypes';
import A11yDialog from './A11yDialog';

interface DataTypeDialogProps {
  onClose: () => void;
  onInsert: (value: DataTypeValue) => void;
}

export function DataTypeDialog({ onClose, onInsert }: DataTypeDialogProps) {
  const [kind, setKind] = useState<DataTypeKind>('stock');
  const [query, setQuery] = useState('');
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState('');
  const options = kind === 'stock' ? stockSymbols() : placeNames();
  const filtered = options.filter((o) => o.toLowerCase().includes(query.toLowerCase()));

  const insert = async (key: string): Promise<void> => {
    setResolving(true);
    setError('');
    try {
      // Live provider first (Stooq / Nominatim); falls back to bundled
      // sample data when offline, so this never rejects.
      const v = kind === 'stock' ? await resolveStockLive(key) : await resolveGeographyLive(key);
      if (v) { onInsert(v); onClose(); }
      else setError(`No ${kind === 'stock' ? 'quote' : 'place'} found for "${key}".`);
    } finally {
      setResolving(false);
    }
  };

  return (
    <A11yDialog title={<>Data Types</>} width={420} onClose={onClose}>
        <div className="dialog-row" role="tablist" aria-label="Data type kind">
          {(['stock', 'geography'] as DataTypeKind[]).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={kind === k}
              className={kind === k ? 'tab-active' : ''}
              onClick={() => { setKind(k); setQuery(''); }}
              style={{ marginRight: 6 }}
            >
              {k === 'stock' ? 'Stocks' : 'Geography'}
            </button>
          ))}
        </div>
        <div className="dialog-row">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${kind === 'stock' ? 'symbols' : 'places'}…`}
            style={{ width: '100%' }}
            aria-label="Search data types"
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
                  {kind === 'stock' ? '📈' : '🌍'} {o}
                </button>
              </li>
            ))}
            {filtered.length === 0 && query.trim() !== '' && (
              <li>
                <button
                  onClick={() => insert(query.trim())}
                  disabled={resolving}
                  style={{ width: '100%', textAlign: 'left', padding: '6px 8px' }}
                >
                  {resolving ? 'Looking up…' : `🔎 Look up "${query.trim()}" live`}
                </button>
              </li>
            )}
            {filtered.length === 0 && query.trim() === '' && <li style={{ color: '#888' }}>No matches</li>}
          </ul>
        </div>
        {error !== '' && <div className="dialog-row" style={{ color: '#a00', fontSize: 13 }}>{error}</div>}
        <div className="dialog-row" style={{ fontSize: 11, color: '#888' }}>
          Live quotes via Stooq · places via OpenStreetMap — falls back to bundled data offline
        </div>
        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}

interface DataTypeCardProps {
  value: DataTypeValue;
  onClose: () => void;
  onExtractField: (label: string, fieldValue: string) => void;
}

/** Popover card showing all fields of a rich value. */
export function DataTypeCard({ value, onClose, onExtractField }: DataTypeCardProps) {
  return (
    <div
      className="dialog"
      style={{ position: 'absolute', zIndex: 60, width: 260, padding: 12 }}
      role="dialog"
      aria-label={`${value.kind} details for ${value.display}`}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong>{value.kind === 'stock' ? '📈' : '🌍'} {value.display}</strong>
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
        {value.provenance === 'live' ? 'Live provider data' : 'Sample provider data'} · click a value to insert it below
      </div>
    </div>
  );
}
