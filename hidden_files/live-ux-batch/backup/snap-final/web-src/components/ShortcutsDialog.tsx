/**
 * Keyboard-shortcuts dialog (Ctrl+/).
 *
 * Searchable reference of every command in the AppCommand registry,
 * grouped by category with shortcut chips. Read-only: this is the
 * discoverability surface, not a remapping UI (remapping is v2 per
 * platform-shell.md; FEATURES.md documents that direction).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { matchesQuery, type AppCommand } from '../commands';
import A11yDialog from './A11yDialog';

interface ShortcutsDialogProps {
  commands: AppCommand[];
  onClose: () => void;
}

export default function ShortcutsDialog({ commands, onClose }: ShortcutsDialogProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const groups = useMemo(() => {
    const filtered = commands.filter((c) => matchesQuery(c, query));
    const byCat = new Map<string, AppCommand[]>();
    for (const c of filtered) {
      const list = byCat.get(c.category) ?? [];
      list.push(c);
      byCat.set(c.category, list);
    }
    return [...byCat.entries()];
  }, [commands, query]);

  return (
    <A11yDialog title="Keyboard shortcuts" width={620} onClose={onClose}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search shortcuts…"
          aria-label="Search shortcuts"
          style={{ padding: '8px 10px', fontSize: 14, marginBottom: 12, width: '100%', boxSizing: 'border-box' }}
        />
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {groups.length === 0 && (
            <p style={{ fontSize: 13, color: '#64748b' }}>No shortcuts match “{query}”.</p>
          )}
          {groups.map(([category, cmds]) => (
            <div key={category} style={{ marginBottom: 12 }}>
              <h3 style={{ fontSize: 12, textTransform: 'uppercase', color: '#64748b', margin: '0 0 6px' }}>
                {category}
              </h3>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <tbody>
                  {cmds.map((c) => (
                    <tr key={c.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td style={{ padding: '5px 4px' }}>
                        {c.label}
                        {c.description && (
                          <div style={{ fontSize: 11, color: '#94a3b8' }}>{c.description}</div>
                        )}
                      </td>
                      <td style={{ padding: '5px 4px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {c.shortcut ? (
                          <kbd
                            style={{
                              background: '#f1f5f9',
                              border: '1px solid #cbd5e1',
                              borderRadius: 4,
                              padding: '2px 6px',
                              fontSize: 11,
                              fontFamily: 'inherit',
                            }}
                          >
                            {c.shortcut}
                          </kbd>
                        ) : (
                          <span style={{ fontSize: 11, color: '#94a3b8' }}>—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {/* Screen-reader section: not commands, so it is not searchable —
              it documents how assistive technology experiences the app. */}
          <div style={{ marginBottom: 12 }}>
            <h3 style={{ fontSize: 12, textTransform: 'uppercase', color: '#64748b', margin: '0 0 6px' }}>
              Screen reader
            </h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <tbody>
                {[
                  ['Skip links', 'Tab from the address bar: “Skip to grid” jumps straight to the cell grid, “Skip to ribbon” to the ribbon tab strip.'],
                  ['Grid navigation', 'Arrow keys move the active cell; each cell announces “column letter, row number, value” (e.g. “B3: 42”). Enter edits, Escape cancels.'],
                  ['Live announcements', 'Cell edits, formula results, structural changes and import progress are announced through a polite live region — you never need to re-read the grid to confirm an action.'],
                  ['Headers', 'Column headers announce “Column A”, “Column B”, … and row headers “Row 1”, “Row 2”, …; the active cell is exposed via aria-activedescendant.'],
                  ['Dialogs', 'Every dialog traps focus, closes with Escape, and returns focus to the control that opened it.'],
                ].map(([title, text]) => (
                  <tr key={title} style={{ borderBottom: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '5px 4px', fontWeight: 600, whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                      {title}
                    </td>
                    <td style={{ padding: '5px 4px', color: '#475569' }}>{text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
    </A11yDialog>
  );
}
