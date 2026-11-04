/**
 * Share dialog: grant and revoke workbook access.
 *
 * Backed by the service-layer SharingService + AccessTable (permission
 * model): pick a user (principal), pick a level (Viewer / Editor / Manager),
 * grant or revoke, and see the current grants table. Ownership transfer is
 * supported for managers.
 *
 * Access-request flow (design-docs/workbook-protection-and-encryption.md:
 * "users can request access through the sharing flow"): a principal who
 * lacks the manage right cannot grant — instead they get a "Request access"
 * entry point here. Owners/managers see the pending request queue in this
 * dialog and approve or deny each request.
 *
 * Levels (design-docs/permission-model.md):
 *   - Viewer: read-only; the service boundary denies writes.
 *   - Editor: read + write.
 *   - Manager: editor rights + grant/revoke + transfer ownership.
 */
import { useState } from 'react';
import type {
  SharingService,
  ShareLevel,
  GrantRow,
  AccessRequestRow,
} from '@icecream-sheets/service';
import A11yDialog from './A11yDialog';
import RequestAccessDialog from './RequestAccessDialog';

interface ShareDialogProps {
  sharing: SharingService;
  workbookName: string;
  principal: string;
  onClose: () => void;
}

const LEVELS: Array<{ value: ShareLevel; label: string; hint: string }> = [
  { value: 'viewer', label: 'Viewer', hint: 'Can view — read-only' },
  { value: 'editor', label: 'Editor', hint: 'Can edit — read + write' },
  { value: 'manager', label: 'Manager', hint: 'Can manage — grant/revoke, transfer' },
];

export default function ShareDialog({ sharing, workbookName, principal, onClose }: ShareDialogProps) {
  const [grants, setGrants] = useState<GrantRow[]>(() => sharing.grants());
  const [requests, setRequests] = useState<AccessRequestRow[]>(() => sharing.pendingRequests());
  const [userInput, setUserInput] = useState('');
  const [level, setLevel] = useState<ShareLevel>('viewer');
  const [error, setError] = useState('');
  const [transferTo, setTransferTo] = useState('');
  /** Per-request approval level (defaults to the requested level). */
  const [approveLevels, setApproveLevels] = useState<Record<string, ShareLevel>>({});
  /** Request-access view (shown instead of the share content). */
  const [requestOpen, setRequestOpen] = useState(false);

  const canManage = sharing.canManage(principal);

  const refresh = () => {
    setGrants(sharing.grants());
    setRequests(sharing.pendingRequests());
  };

  const handleGrant = async () => {
    const user = userInput.trim();
    if (!user) {
      setError('Enter a user (email or name).');
      return;
    }
    try {
      await sharing.grant(user, level, principal);
      setError('');
      setUserInput('');
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRevoke = async (user: string) => {
    try {
      await sharing.revoke(user, principal);
      setError('');
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleTransfer = async () => {
    const to = transferTo.trim();
    if (!to) {
      setError('Enter the new owner.');
      return;
    }
    try {
      await sharing.transferOwnership(principal, to);
      setError('');
      setTransferTo('');
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleApprove = async (req: AccessRequestRow) => {
    try {
      await sharing.approveRequest(req.id, principal, approveLevels[req.id]);
      setError('');
      setApproveLevels((prev) => {
        const next = { ...prev };
        delete next[req.id];
        return next;
      });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDeny = async (req: AccessRequestRow) => {
    try {
      await sharing.denyRequest(req.id, principal);
      setError('');
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (requestOpen) {
    return (
      <RequestAccessDialog
        sharing={sharing}
        workbookName={workbookName}
        principal={principal}
        onClose={() => {
          setRequestOpen(false);
          refresh();
        }}
      />
    );
  }

  return (
    <A11yDialog title={<>Share “{workbookName}”</>} onClose={onClose}>
      <div className="dialog-title">People with access</div>
      {grants.length === 0 ? (
        <div className="dialog-hint">No grants yet.</div>
      ) : (
        <table className="name-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Level</th>
              <th>Granted by</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {grants.map((g) => (
              <tr key={g.principal}>
                <td>{g.principal}{g.isOwner ? ' (owner)' : ''}</td>
                <td style={{ textTransform: 'capitalize' }}>{g.level}</td>
                <td>{g.grantedBy}</td>
                <td>
                  {canManage && !g.isOwner && g.principal !== principal && (
                    <button onClick={() => handleRevoke(g.principal)}>Revoke</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canManage && requests.length > 0 && (
        <>
          <div className="dialog-title" style={{ marginTop: 12 }}>
            Access requests ({requests.length} pending)
          </div>
          <table className="name-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Requested</th>
                <th>Note</th>
                <th>Grant as</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td>{r.principal}</td>
                  <td style={{ textTransform: 'capitalize' }}>{r.requestedLevel}</td>
                  <td>{r.message || <span className="dialog-hint">—</span>}</td>
                  <td>
                    <select
                      value={approveLevels[r.id] ?? r.requestedLevel}
                      onChange={(e) =>
                        setApproveLevels((prev) => ({
                          ...prev,
                          [r.id]: e.target.value as ShareLevel,
                        }))
                      }
                      aria-label={`Grant level for ${r.principal}`}
                    >
                      {LEVELS.map((l) => (
                        <option key={l.value} value={l.value}>{l.label}</option>
                      ))}
                    </select>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button onClick={() => handleApprove(r)}>Approve</button>{' '}
                    <button onClick={() => handleDeny(r)}>Deny</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {canManage ? (
        <>
          <div className="dialog-title" style={{ marginTop: 12 }}>Grant access</div>
          <label className="dialog-row">
            <span>User:</span>
            <input
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              placeholder="email or name"
            />
          </label>
          <label className="dialog-row">
            <span>Level:</span>
            <select value={level} onChange={(e) => setLevel(e.target.value as ShareLevel)}>
              {LEVELS.map((l) => (
                <option key={l.value} value={l.value}>{l.label} — {l.hint}</option>
              ))}
            </select>
          </label>
          {error && <div className="dialog-error">{error}</div>}
          <div className="dialog-actions">
            <button onClick={handleGrant}>Grant</button>
          </div>

          <div className="dialog-title" style={{ marginTop: 12 }}>Transfer ownership</div>
          <label className="dialog-row">
            <span>New owner:</span>
            <input
              value={transferTo}
              onChange={(e) => setTransferTo(e.target.value)}
              placeholder="email or name"
            />
          </label>
          <div className="dialog-actions">
            <button onClick={handleTransfer}>Transfer</button>
            <button onClick={onClose}>Close</button>
          </div>
        </>
      ) : (
        <>
          <div className="dialog-title" style={{ marginTop: 12 }}>Request access</div>
          <div className="dialog-hint">
            You can’t change sharing settings for this workbook, but you can ask the owner for access.
          </div>
          {error && <div className="dialog-error">{error}</div>}
          <div className="dialog-actions">
            <button onClick={() => setRequestOpen(true)}>Request access…</button>
            <button onClick={onClose}>Close</button>
          </div>
        </>
      )}
    </A11yDialog>
  );
}
