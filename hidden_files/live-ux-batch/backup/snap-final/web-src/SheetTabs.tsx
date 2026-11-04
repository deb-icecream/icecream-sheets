import { useState } from 'react';

interface SheetTabsProps {
  sheets: string[];
  active: string;
  tabColors: Map<string, string>;
  /** Connected-source badges: sheet name → tooltip text (connector + last refresh). */
  sourceBadges?: Map<string, string>;
  onSelect: (name: string) => void;
  onAdd: (name: string) => void;
  onDelete: (name: string) => void;
  onContextMenu: (x: number, y: number, name: string) => void;
}

export default function SheetTabs({ sheets, active, tabColors, sourceBadges, onSelect, onAdd, onDelete, onContextMenu }: SheetTabsProps) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  const commitAdd = () => {
    const trimmed = name.trim();
    if (trimmed && !sheets.includes(trimmed)) {
      onAdd(trimmed);
    }
    setAdding(false);
    setName('');
  };

  return (
    <div className="sheet-tabs">
      {sheets.map((s) => (
        <button
          key={s}
          className={s === active ? 'sheet-tab active' : 'sheet-tab'}
          onClick={() => onSelect(s)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onSelect(s);
            onContextMenu(e.clientX, e.clientY, s);
          }}
          title={sourceBadges?.get(s) ?? s}
          style={tabColors.get(s) ? { borderBottom: `3px solid ${tabColors.get(s)}` } : undefined}
        >
          {sourceBadges?.has(s) && (
            <span role="img" aria-label="Connected data source" style={{ marginRight: 4 }}>
              🔗
            </span>
          )}
          {s}
        </button>
      ))}
      {adding ? (
        <input
          className="sheet-name-input"
          autoFocus
          value={name}
          placeholder="Sheet name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitAdd();
            else if (e.key === 'Escape') {
              setAdding(false);
              setName('');
            }
          }}
          onBlur={commitAdd}
        />
      ) : (
        <button className="sheet-tab add" onClick={() => setAdding(true)} aria-label="Add sheet">
          +
        </button>
      )}
    </div>
  );
}
