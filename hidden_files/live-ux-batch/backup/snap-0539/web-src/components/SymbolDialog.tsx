/**
 * Symbol picker (Insert > Symbols > Symbol).
 *
 * Unicode symbol grid by category (Greek, Math, Arrows, Currency,
 * Miscellaneous) with search. Picking a symbol hands it to the parent,
 * which inserts it into the active cell or the equation editor.
 */
import { useMemo, useState } from 'react';
import { searchSymbols, SYMBOL_CATEGORIES } from '../features/symbols';
import A11yDialog from './A11yDialog';

export interface SymbolDialogProps {
  onClose: () => void;
  onPick: (symbol: string) => void;
}

export function SymbolDialog({ onClose, onPick }: SymbolDialogProps) {
  const [category, setCategory] = useState<string>('greek');
  const [query, setQuery] = useState('');

  const results = useMemo(() => {
    if (query.trim() === '') {
      const cat = SYMBOL_CATEGORIES.find((c) => c.id === category);
      return (cat?.symbols ?? []).map((symbol) => ({ symbol, category: cat?.label ?? '' }));
    }
    return searchSymbols(query);
  }, [category, query]);

  return (
    <A11yDialog title={<>Symbol</>} width={520} onClose={onClose}>

        <div className="dialog-row" style={{ gap: 8 }}>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search symbols…"
            style={{ flex: 1 }}
            aria-label="Search symbols"
          />
        </div>

        {query.trim() === '' && (
          <div className="dialog-row" style={{ gap: 4, flexWrap: 'wrap' }} role="tablist" aria-label="Categories">
            {SYMBOL_CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={category === c.id}
                onClick={() => setCategory(c.id)}
                style={{
                  padding: '4px 10px',
                  border: '1px solid #ccc',
                  background: category === c.id ? '#e8f0fe' : '#fff',
                  fontWeight: category === c.id ? 600 : undefined,
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(10, 1fr)',
            gap: 4,
            maxHeight: 300,
            overflowY: 'auto',
            border: '1px solid #ddd',
            padding: 8,
            marginBottom: 8,
          }}
        >
          {results.map(({ symbol }, i) => (
            <button
              key={`${symbol}-${i}`}
              type="button"
              title={symbol}
              onClick={() => {
                onPick(symbol);
                onClose();
              }}
              style={{
                fontSize: 20,
                padding: '6px 0',
                border: '1px solid #eee',
                background: '#fff',
                cursor: 'pointer',
              }}
            >
              {symbol}
            </button>
          ))}
          {results.length === 0 && (
            <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: '#888', fontSize: 12, padding: 16 }}>
              No symbols match “{query}”.
            </div>
          )}
        </div>

        <div className="dialog-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </A11yDialog>
  );
}
