/**
 * Insert Function dialog: searchable, categorized list of all 447 engine
 * functions. Double-click or Insert adds the skeleton to the formula bar.
 */
import { useEffect, useMemo, useState } from 'react';
import { getFunctionsByCategory, searchFunctions, ALL_FUNCTIONS } from '../features/functions';
import A11yDialog from './A11yDialog';

interface InsertFunctionDialogProps {
  onInsert: (skeleton: string) => void;
  onClose: () => void;
  initialCategory?: string;
}

export default function InsertFunctionDialog({ onInsert, onClose, initialCategory }: InsertFunctionDialogProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>(initialCategory ?? 'All');
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const categories = useMemo(() => {
    const cats = [...getFunctionsByCategory().keys()].sort();
    return ['All', ...cats];
  }, []);

  const results = useMemo(() => {
    let list = searchFunctions(query);
    if (category !== 'All') list = list.filter((f) => f.category === category);
    return list;
  }, [query, category]);

  const insert = (name: string) => {
    onInsert(`=${name}()`);
    onClose();
  };

  return (
    <A11yDialog title={<>Insert Function ({ALL_FUNCTIONS.length} functions)</>} width={560} onClose={onClose}>
        <div className="fn-dialog-body">
          <input
            type="search"
            placeholder="Search functions…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
            aria-label="Search functions"
          />
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <div className="fn-list" role="listbox" aria-label="Functions">
            {results.map((f) => (
              <button
                key={f.name}
                type="button"
                className={selected === f.name ? 'fn-item selected' : 'fn-item'}
                role="option"
                aria-selected={selected === f.name}
                onClick={() => setSelected(f.name)}
                onDoubleClick={() => insert(f.name)}
              >
                <strong>{f.name}</strong>
                <span className="fn-cat">{f.category}</span>
              </button>
            ))}
            {results.length === 0 && <div className="fn-item">No functions match.</div>}
          </div>
        </div>
        <div className="fn-dialog-footer">
          <button type="button" className="ribbon-btn small" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ribbon-btn small"
            disabled={!selected}
            onClick={() => selected && insert(selected)}
          >
            Insert
          </button>
        </div>
    </A11yDialog>
  );
}
