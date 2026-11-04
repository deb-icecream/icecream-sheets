/**
 * Workbook library dialog (platform-shell.md §2): the "Open" flow lists
 * workbooks (not just files) with owner, created/modified times, size and
 * storage backend. New / Open / Make a copy / Move to trash (+ restore and
 * permanent delete inside the retention window).
 */
import { useEffect, useMemo, useState } from 'react';
import { formatBytes, type LibraryEntry, type WorkbookLibrary } from '../library';
import A11yDialog from './A11yDialog';

interface WorkbookLibraryDialogProps {
  library: WorkbookLibrary;
  /** Currently open workbook id (if it came from the library). */
  currentId: string | null;
  onOpen: (entry: LibraryEntry) => void;
  onNew: () => void;
  onSaveToLibrary: (name: string) => Promise<LibraryEntry | null>;
  onClose: () => void;
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export default function WorkbookLibraryDialog({
  library,
  currentId,
  onOpen,
  onNew,
  onSaveToLibrary,
  onClose,
}: WorkbookLibraryDialogProps) {
  const [view, setView] = useState<'workbooks' | 'trash'>('workbooks');
  const [query, setQuery] = useState('');
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [saveName, setSaveName] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const entries = useMemo(() => {
    void tick;
    const all = view === 'workbooks' ? library.list() : library.trash();
    const q = query.trim().toLowerCase();
    return q ? all.filter((e) => e.name.toLowerCase().includes(q) || e.owner.toLowerCase().includes(q)) : all;
  }, [library, view, query, tick]);

  const refresh = () => setTick((t) => t + 1);

  const doSave = async () => {
    const name = saveName.trim() || 'Untitled workbook';
    setBusy(true);
    try {
      await onSaveToLibrary(name);
      setSaveName('');
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const doCopy = async (id: string) => {
    setBusy(true);
    try {
      await library.copy(id, 'you');
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (id: string) => {
    setBusy(true);
    try {
      await library.deletePermanent(id);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const th: React.CSSProperties = {
    textAlign: 'left',
    fontSize: 11,
    textTransform: 'uppercase',
    color: '#64748b',
    padding: '6px 8px',
    borderBottom: '1px solid #e2e8f0',
  };
  const td: React.CSSProperties = { padding: '7px 8px', fontSize: 13, borderBottom: '1px solid #f1f5f9' };

  return (
    <A11yDialog title={<>Workbooks</>} width={760} onClose={onClose}>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
          <button
            type="button"
            onClick={() => setView('workbooks')}
            style={{ fontWeight: view === 'workbooks' ? 700 : 400 }}
            aria-pressed={view === 'workbooks'}
          >
            Library
          </button>
          <button
            type="button"
            onClick={() => setView('trash')}
            style={{ fontWeight: view === 'trash' ? 700 : 400 }}
            aria-pressed={view === 'trash'}
          >
            Trash
          </button>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search workbooks…"
            aria-label="Search workbooks"
            style={{ padding: '6px 10px', fontSize: 13, marginLeft: 8, flex: 1 }}
          />
          <button type="button" onClick={onNew} title="Start a new blank workbook">
            New
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
          <input
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder="Name for the current workbook…"
            aria-label="Workbook name to save"
            style={{ padding: '6px 10px', fontSize: 13, flex: 1 }}
          />
          <button type="button" onClick={doSave} disabled={busy} title="Save the current workbook into the library">
            {busy ? 'Saving…' : 'Save current to library'}
          </button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          {entries.length === 0 ? (
            <p style={{ fontSize: 13, color: '#64748b' }}>
              {view === 'workbooks'
                ? 'No workbooks yet. Save the current workbook into the library, or start a new one.'
                : 'Trash is empty. Deleted workbooks stay here for 30 days.'}
            </p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>Name</th>
                  <th style={th}>Owner</th>
                  <th style={th}>Modified</th>
                  <th style={th}>Size</th>
                  <th style={th}>Backend</th>
                  <th style={th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td style={td}>
                      {e.name}
                      {e.id === currentId && (
                        <span style={{ fontSize: 11, color: '#2563eb', marginLeft: 6 }}>(open)</span>
                      )}
                    </td>
                    <td style={td}>{e.owner}</td>
                    <td style={td} title={new Date(e.modifiedAt).toLocaleString()}>
                      {timeAgo(e.modifiedAt)}
                    </td>
                    <td style={td}>{formatBytes(e.sizeBytes)}</td>
                    <td style={td}>{e.backend}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      {view === 'workbooks' ? (
                        <>
                          <button type="button" onClick={() => onOpen(e)} title="Open this workbook" style={{ marginRight: 4 }}>
                            Open
                          </button>
                          <button type="button" onClick={() => void doCopy(e.id)} disabled={busy} title="Make a copy" style={{ marginRight: 4 }}>
                            Copy
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              library.trashEntry(e.id);
                              refresh();
                            }}
                            title="Move to trash"
                          >
                            Trash
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              library.restore(e.id);
                              refresh();
                            }}
                            title="Restore from trash"
                            style={{ marginRight: 4 }}
                          >
                            Restore
                          </button>
                          <button type="button" onClick={() => void doDelete(e.id)} disabled={busy} title="Delete permanently">
                            Delete
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </A11yDialog>
  );
}
