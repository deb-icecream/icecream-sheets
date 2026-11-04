/**
 * Sort dialog for the Data tab: pick a column and a direction.
 */
import { useState } from 'react';
import A11yDialog from './A11yDialog';

export interface SortColumn {
  index: number;
  label: string;
}

interface SortDialogProps {
  columns: SortColumn[];
  onClose: () => void;
  onSort: (col: number, dir: 'asc' | 'desc') => void;
}

export default function SortDialog({ columns, onClose, onSort }: SortDialogProps) {
  const [col, setCol] = useState<number>(columns[0]?.index ?? 0);
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');

  const submit = (): void => {
    onSort(col, dir);
    onClose();
  };

  return (
    <A11yDialog title={<>Sort</>} onClose={onClose}>
        <label className="dialog-row">
          <span>Column:</span>
          <select value={col} onChange={(e) => setCol(Number(e.target.value))}>
            {columns.map((c) => (
              <option key={c.index} value={c.index}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <div className="dialog-row" role="radiogroup" aria-label="Sort direction">
          <label>
            <input
              type="radio"
              name="sort-dir"
              checked={dir === 'asc'}
              onChange={() => setDir('asc')}
            />
            Ascending
          </label>
          <label>
            <input
              type="radio"
              name="sort-dir"
              checked={dir === 'desc'}
              onChange={() => setDir('desc')}
            />
            Descending
          </label>
        </div>
        <div className="dialog-actions">
          <button onClick={submit} disabled={columns.length === 0}>
            OK
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}
