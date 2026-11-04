/**
 * Sync status: offline indicator, "N changes pending" counter, manual
 * sync trigger, and the conflict-resolution dialog (keep mine / keep
 * theirs / keep both) for cells changed on both sides of a partition.
 *
 * The offline op queue lives in App (OpLog in @icecream-sheets/engine);
 * this component is the presentation + resolution surface.
 */
import { useState } from 'react';
import type { OpConflict } from '@icecream-sheets/engine';
import A11yDialog from './A11yDialog';

export type ConflictChoice = 'mine' | 'theirs' | 'both';

interface SyncStatusProps {
  online: boolean;
  pending: number;
  conflicts: OpConflict[];
  onSyncNow: () => void;
  onResolve: (conflict: OpConflict, choice: ConflictChoice) => void;
}

function opSummary(op: OpConflict['local']): string {
  const p = op.payload;
  switch (op.kind) {
    case 'setCell':
      return `set to ${JSON.stringify(p['value'] ?? '')}`;
    case 'setFormula':
      return `formula ${String(p['formula'] ?? '')}`;
    case 'clearCell':
      return 'cleared';
    default:
      return op.kind;
  }
}

export function SyncStatus({ online, pending, conflicts, onSyncNow, onResolve }: SyncStatusProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <button
        className="sync-status"
        onClick={() => conflicts.length > 0 && setDialogOpen(true)}
        title={
          online
            ? pending > 0
              ? `${pending} change${pending === 1 ? '' : 's'} pending sync — click to sync`
              : 'Online — all changes synced'
            : `Offline — ${pending} change${pending === 1 ? '' : 's'} queued locally`
        }
        aria-label={online ? 'Sync status: online' : 'Sync status: offline'}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 12,
          padding: '2px 10px',
          borderRadius: 12,
          border: `1px solid ${online ? '#86efac' : '#fcd34d'}`,
          background: online ? '#dcfce7' : '#fef3c7',
          color: online ? '#166534' : '#92400e',
          cursor: conflicts.length > 0 ? 'pointer' : 'default',
          fontWeight: 600,
        }}
      >
        <span aria-hidden="true">{online ? '🟢' : '🟡'}</span>
        {online ? 'Online' : 'Offline'}
        {pending > 0 && <span>· {pending} pending</span>}
        {conflicts.length > 0 && <span>· ⚠️ {conflicts.length} conflict{conflicts.length === 1 ? '' : 's'}</span>}
      </button>
      {online && pending > 0 && (
        <button
          onClick={onSyncNow}
          title="Flush the offline queue"
          style={{ fontSize: 12, marginLeft: 6, cursor: 'pointer' }}
        >
          Sync now
        </button>
      )}
      {dialogOpen && conflicts.length > 0 && (
        <A11yDialog title={<>Resolve sync conflicts</>} width={520} onClose={() => setDialogOpen(false)}>
            <p style={{ fontSize: 12, color: '#475569' }}>
              These cells were changed both locally (while offline) and by a peer.
              Choose which value wins for each cell.
            </p>
            {conflicts.map((c, i) => (
              <div
                key={`${c.target}-${i}`}
                style={{ border: '1px solid #e2e8f0', borderRadius: 6, padding: 8, marginBottom: 8 }}
              >
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{c.target}</div>
                <div style={{ fontSize: 12, marginBottom: 6 }}>
                  <div>Mine ({c.local.principal}): <code>{opSummary(c.local)}</code></div>
                  <div>Theirs ({c.remote.principal}): <code>{opSummary(c.remote)}</code></div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => onResolve(c, 'mine')} title="Keep my value, discard theirs">Keep mine</button>
                  <button onClick={() => onResolve(c, 'theirs')} title="Apply their value, discard mine">Keep theirs</button>
                  <button
                    onClick={() => onResolve(c, 'both')}
                    title="Keep my value and preserve theirs as a cell comment"
                  >
                    Keep both
                  </button>
                </div>
              </div>
            ))}
            <div className="dialog-actions">
              <button onClick={() => setDialogOpen(false)}>Close</button>
            </div>
          </A11yDialog>
      )}
    </>
  );
}
