/**
 * View Macros dialog (View > Macros > View Macros).
 *
 * Lists the saved macro library (features/macros.ts) with Run, Edit
 * (rename + script source editing), and Delete. "Use Relative
 * References" is the persisted toggle: when on, newly recorded macros
 * are rewritten with cell refs relative to the anchor cell that was
 * active when recording started (applyRelativeRefs); the parent's
 * replay applier resolves them against the run-time active cell via
 * resolveRelativeRef.
 *
 * INTEGRATION (parent):
 * - Record flow: MacroRecorderDialog's Stop handler should call
 *   finalizeRecordedMacro(log, anchorCell) below before saving, so the
 *   toggle takes effect at record time.
 * - Run: onRun(entry) — the parent replays entry.log through the
 *   service replayActionLog with its automation applier; for
 *   relativeRefs macros it resolves refs against the active cell first.
 */
import { useState } from 'react';
import type { ActionLog } from '@icecream-sheets/service';
import A11yDialog from './A11yDialog';
import {
  applyRelativeRefs,
  deleteMacro,
  getUseRelativeReferences,
  loadMacros,
  renameMacro,
  saveMacro,
  setUseRelativeReferences,
  type MacroEntry,
} from '../features/macros';

interface MacroListDialogProps {
  onClose: () => void;
  /** Run a macro (parent replays entry.log via the automation applier). */
  onRun: (entry: MacroEntry) => void;
  /** Hint to open the recorder (parent opens MacroRecorderDialog). */
  onRecordNew?: () => void;
}

/**
 * Apply the Use-Relative-References toggle to a just-recorded log.
 * Call this in the recorder's Stop handler before saving the macro.
 */
export function finalizeRecordedMacro(
  log: ActionLog,
  anchor: { sheet: string; row: number; col: number },
): { log: ActionLog; relativeRefs: boolean } {
  const relativeRefs = getUseRelativeReferences();
  return { log: relativeRefs ? applyRelativeRefs(log, anchor) : log, relativeRefs };
}

export default function MacroListDialog({ onClose, onRun, onRecordNew }: MacroListDialogProps) {
  const [macros, setMacros] = useState<MacroEntry[]>(() => loadMacros());
  const [relative, setRelative] = useState(() => getUseRelativeReferences());
  const [editing, setEditing] = useState<{ id: string; name: string; script: string } | null>(null);
  const [running, setRunning] = useState<string | null>(null);

  const toggleRelative = (): void => {
    const next = !relative;
    setRelative(next);
    setUseRelativeReferences(next);
  };

  const remove = (id: string): void => {
    if (!window.confirm('Delete this macro?')) return;
    setMacros(deleteMacro(id));
  };

  const saveEdit = (): void => {
    if (!editing) return;
    const target = macros.find((m) => m.id === editing.id);
    if (!target) return;
    let next = renameMacro(editing.id, editing.name);
    next = saveMacro({
      id: editing.id,
      name: editing.name,
      script: editing.script,
      log: target.log,
      relativeRefs: target.relativeRefs,
    });
    setMacros(next);
    setEditing(null);
  };

  const run = (entry: MacroEntry): void => {
    setRunning(entry.id);
    try {
      onRun(entry);
    } finally {
      setRunning(null);
    }
  };

  return (
    <A11yDialog title={<>Macros</>} width={560} onClose={onClose}>

        <div className="dialog-row" style={{ alignItems: 'center' }}>
          <label title="Record new macros with cell references relative to the active cell">
            <input type="checkbox" checked={relative} onChange={toggleRelative} /> Use Relative References
          </label>
          {onRecordNew && (
            <button style={{ marginLeft: 'auto' }} onClick={onRecordNew}>Record New Macro…</button>
          )}
        </div>

        {macros.length === 0 && (
          <p style={{ color: '#888', fontSize: 13 }}>No saved macros yet. Record one to get started.</p>
        )}
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {macros.map((m) => (
            <li key={m.id} style={{ border: '1px solid var(--line-soft)', borderRadius: 6, padding: 8, marginBottom: 8 }}>
              {editing?.id === m.id ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} aria-label="Macro name" />
                  <textarea
                    value={editing.script}
                    onChange={(e) => setEditing({ ...editing, script: e.target.value })}
                    rows={10}
                    style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
                    aria-label="Macro script"
                    spellCheck={false}
                  />
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={saveEdit}>Save</button>
                    <button onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <strong style={{ flex: 1 }}>{m.name}</strong>
                    {m.relativeRefs && <span style={{ fontSize: 11, color: '#666' }} title="Recorded with relative references">relative refs</span>}
                    <span style={{ fontSize: 11, color: '#888' }}>{m.log.actions.length} actions</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#888', margin: '2px 0 6px' }}>
                    Saved {new Date(m.updatedAt).toLocaleString()}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => run(m)} disabled={running === m.id}>
                      {running === m.id ? 'Running…' : 'Run'}
                    </button>
                    <button onClick={() => setEditing({ id: m.id, name: m.name, script: m.script })}>Edit</button>
                    <button onClick={() => remove(m.id)}>Delete</button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>

        <div className="dialog-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </A11yDialog>
  );
}
