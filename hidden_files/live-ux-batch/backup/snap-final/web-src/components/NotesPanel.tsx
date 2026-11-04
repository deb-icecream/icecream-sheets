/**
 * Notes pane (Review > Notes).
 *
 * Cell notes are Excel's legacy annotations (author + text + timestamp),
 * distinct from threaded comments (features/comments.ts). The pane lists
 * the current sheet's notes in row-major order with Previous/Next
 * navigation (features/notes.ts), shows the selected note, and offers
 * New / Edit / Delete. Show/Hide is owned by the parent (a visibility
 * flag around this pane); the pane reports navigation so the parent can
 * move the grid selection to the note's cell.
 */
import { useMemo, useState } from 'react';
import {
  deleteNote,
  listNotes,
  nextNote,
  prevNote,
  setNote,
  type NoteEntry,
  type NoteStore,
} from '../features/notes';

interface NotesPanelProps {
  notes: NoteStore;
  sheet: string;
  /** Current grid selection (navigation starts here). */
  sel: { row: number; col: number };
  author?: string;
  onClose: () => void;
  /** Persist a new/edited note. */
  onSaveNote: (row: number, col: number, text: string) => void;
  /** Delete a note. */
  onDeleteNote: (row: number, col: number) => void;
  /** Move the grid selection (Previous/Next/List click). */
  onNavigate: (row: number, col: number) => void;
}

function cellLabel(row: number, col: number): string {
  let n = col;
  let s = '';
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return `${s}${row + 1}`;
}

export default function NotesPanel({
  notes,
  sheet,
  sel,
  author = 'user',
  onClose,
  onSaveNote,
  onDeleteNote,
  onNavigate,
}: NotesPanelProps) {
  const entries = useMemo(() => listNotes(notes, sheet), [notes, sheet]);
  const [editing, setEditing] = useState<{ row: number; col: number; text: string } | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newText, setNewText] = useState('');

  const go = (entry: NoteEntry | undefined): void => {
    if (entry) onNavigate(entry.row, entry.col);
  };

  const saveEdit = (): void => {
    if (!editing) return;
    onSaveNote(editing.row, editing.col, editing.text);
    setEditing(null);
  };

  const saveNew = (): void => {
    if (!newText.trim()) return;
    onSaveNote(sel.row, sel.col, newText.trim());
    setNewText('');
    setNewOpen(false);
  };

  return (
    <div
      role="complementary"
      aria-label="Notes"
      style={{
        position: 'fixed', right: 0, top: 0, bottom: 0, width: 320,
        background: '#fff', borderLeft: '1px solid var(--line-soft)',
        boxShadow: '-4px 0 12px rgba(0,0,0,0.08)', zIndex: 60,
        display: 'flex', flexDirection: 'column',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid var(--line-soft)' }}>
        <strong style={{ flex: 1 }}>Notes ({entries.length})</strong>
        <button onClick={onClose} aria-label="Close notes">×</button>
      </div>
      <div style={{ display: 'flex', gap: 6, padding: '8px 12px', borderBottom: '1px solid var(--line-soft)' }}>
        <button onClick={() => go(prevNote(notes, sheet, sel.row, sel.col))} disabled={entries.length === 0} title="Previous note">← Previous</button>
        <button onClick={() => go(nextNote(notes, sheet, sel.row, sel.col))} disabled={entries.length === 0} title="Next note">Next →</button>
        <button onClick={() => setNewOpen((v) => !v)}>New Note</button>
      </div>

      {newOpen && (
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--line-soft)' }}>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>New note at {cellLabel(sel.row, sel.col)}</div>
          <textarea value={newText} onChange={(e) => setNewText(e.target.value)} rows={3} style={{ width: '100%' }} aria-label="New note text" />
          <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
            <button onClick={saveNew} disabled={!newText.trim()}>Add</button>
            <button onClick={() => setNewOpen(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: '4px 12px' }}>
        {entries.length === 0 && <p style={{ color: '#888', fontSize: 13 }}>No notes on this sheet yet.</p>}
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {entries.map((n) => (
            <li key={`${n.row}:${n.col}`} style={{ padding: '8px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <button
                  onClick={() => onNavigate(n.row, n.col)}
                  title={`Go to ${cellLabel(n.row, n.col)}`}
                  style={{ fontWeight: 'bold' }}
                >
                  {cellLabel(n.row, n.col)}
                </button>
                <span style={{ fontSize: 12, color: '#666' }}>{n.author} · {new Date(n.updatedAt).toLocaleString()}</span>
              </div>
              {editing && editing.row === n.row && editing.col === n.col ? (
                <div style={{ marginTop: 4 }}>
                  <textarea value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} rows={3} style={{ width: '100%' }} aria-label="Edit note" />
                  <div style={{ marginTop: 4, display: 'flex', gap: 6 }}>
                    <button onClick={saveEdit}>Save</button>
                    <button onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 13, marginTop: 4, whiteSpace: 'pre-wrap' }}>{n.text}</div>
              )}
              {!(editing && editing.row === n.row && editing.col === n.col) && (
                <div style={{ marginTop: 4, display: 'flex', gap: 6 }}>
                  <button style={{ fontSize: 12 }} onClick={() => setEditing({ row: n.row, col: n.col, text: n.text })}>Edit</button>
                  <button style={{ fontSize: 12 }} onClick={() => onDeleteNote(n.row, n.col)}>Delete</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
      <div style={{ padding: '6px 12px', fontSize: 11, color: '#888', borderTop: '1px solid var(--line-soft)' }}>
        Notes are cell annotations by {author} — separate from threaded comments.
      </div>
    </div>
  );
}

// Re-export model helpers for parents wiring Review > Notes.
export { deleteNote, setNote };
