/**
 * Find/replace dialog (Ctrl+F).
 */
import { useState } from 'react';
import type { FindOptions } from '../features/findReplace';
import A11yDialog from './A11yDialog';

interface FindDialogProps {
  onClose: () => void;
  onFind: (query: string, opts: FindOptions) => void;
  onFindNext: () => void;
  onReplaceAll: (query: string, replacement: string, opts: FindOptions) => void;
  matchCount: number;
}

export default function FindDialog({ onClose, onFind, onFindNext, onReplaceAll, matchCount }: FindDialogProps) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeCell, setWholeCell] = useState(false);

  const opts = (): FindOptions => ({ matchCase, wholeCell });

  return (
    <A11yDialog title={<>Find and Replace</>} onClose={onClose}>
        <label className="dialog-row">
          <span>Find:</span>
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              onFind(e.target.value, opts());
            }}
            placeholder="Search text or value"
          />
        </label>
        <label className="dialog-row">
          <span>Replace:</span>
          <input
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            placeholder="Replacement text"
          />
        </label>
        <div className="dialog-row">
          <label>
            <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} />
            Match case
          </label>
          <label>
            <input type="checkbox" checked={wholeCell} onChange={(e) => setWholeCell(e.target.checked)} />
            Whole cell
          </label>
        </div>
        {query && <div className="dialog-hint">{matchCount} match{matchCount === 1 ? '' : 'es'}</div>}
        <div className="dialog-actions">
          <button onClick={onFindNext}>Find Next</button>
          <button
            onClick={() => onReplaceAll(query, replacement, opts())}
            disabled={!query}
          >
            Replace All
          </button>
          <button onClick={onClose}>Close</button>
        </div>
      </A11yDialog>
  );
}
