/**
 * Global menu search (Alt+/): a command palette over the AppCommand
 * registry (platform-shell.md §6). Type to filter, ↑/↓ to move, Enter to
 * run the highlighted command, Esc to dismiss.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { matchesQuery, rankCommand, type AppCommand } from '../commands';
import A11yDialog from './A11yDialog';

interface MenuSearchDialogProps {
  commands: AppCommand[];
  onClose: () => void;
}

export default function MenuSearchDialog({ commands, onClose }: MenuSearchDialogProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return commands
      .filter((c) => matchesQuery(c, query))
      .map((c) => ({ cmd: c, rank: rankCommand(c, q) }))
      .sort((a, b) => a.rank - b.rank || a.cmd.label.localeCompare(b.cmd.label))
      .map((r) => r.cmd)
      .slice(0, 25);
  }, [commands, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

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

  const runAt = (index: number) => {
    const cmd = results[index];
    if (!cmd) return;
    if (cmd.enabled && !cmd.enabled()) return;
    onClose();
    cmd.run();
  };

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(results.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runAt(active);
    }
  };

  return (
    <A11yDialog title="Menu search" width={560} onClose={onClose}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKey}
          placeholder="Type a command… (Enter to run, Esc to close)"
          aria-label="Search menu commands"
          style={{ padding: '10px 12px', fontSize: 15, marginBottom: 8, width: '100%', boxSizing: 'border-box' }}
        />
        <div style={{ overflowY: 'auto', flex: 1 }} role="listbox" aria-label="Matching commands">
          {results.length === 0 && (
            <p style={{ fontSize: 13, color: '#64748b' }}>No commands match “{query}”.</p>
          )}
          {results.map((c, i) => {
            const disabled = c.enabled ? !c.enabled() : false;
            return (
              <div
                key={c.id}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => runAt(i)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 10px',
                  borderRadius: 6,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  background: i === active ? '#e0f2fe' : 'transparent',
                  opacity: disabled ? 0.45 : 1,
                }}
              >
                <span style={{ fontSize: 11, color: '#94a3b8', minWidth: 64 }}>{c.category}</span>
                <span style={{ fontSize: 13, flex: 1 }}>{c.label}</span>
                {c.shortcut && (
                  <kbd
                    style={{
                      background: '#f1f5f9',
                      border: '1px solid #cbd5e1',
                      borderRadius: 4,
                      padding: '1px 5px',
                      fontSize: 10,
                      fontFamily: 'inherit',
                    }}
                  >
                    {c.shortcut}
                  </kbd>
                )}
              </div>
            );
          })}
        </div>
    </A11yDialog>
  );
}
