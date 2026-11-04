/**
 * Request-access dialog: the requester side of the access-request flow.
 *
 * A user who hits a permission wall (a protected workbook, or #PERM! on
 * cells — design-docs/workbook-protection-and-encryption.md: "the UI
 * explains why an action was denied ... users can request access through
 * the sharing flow") picks the level they need, adds an optional note for
 * the owner, and files the request. Owners/managers see the pending queue
 * in ShareDialog and approve or deny from there.
 *
 * If the requester already has a pending request they can withdraw it.
 */
import { useState } from 'react';
import type { SharingService, ShareLevel, AccessRequestRow } from '@icecream-sheets/service';
import A11yDialog from './A11yDialog';

interface RequestAccessDialogProps {
  sharing: SharingService;
  workbookName: string;
  principal: string;
  onClose: () => void;
}

const LEVELS: Array<{ value: ShareLevel; label: string; hint: string }> = [
  { value: 'viewer', label: 'Viewer', hint: 'Read the workbook — read-only' },
  { value: 'editor', label: 'Editor', hint: 'Read and edit cells' },
  { value: 'manager', label: 'Manager', hint: 'Edit and share with others' },
];

export default function RequestAccessDialog({
  sharing,
  workbookName,
  principal,
  onClose,
}: RequestAccessDialogProps) {
  const currentLevel = sharing.effectiveLevel(principal);
  const [mine, setMine] = useState<AccessRequestRow[]>(
    () => sharing.pendingRequests().filter((r) => r.principal === principal),
  );
  const [level, setLevel] = useState<ShareLevel>('viewer');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const refreshMine = () =>
    setMine(sharing.pendingRequests().filter((r) => r.principal === principal));

  const handleSubmit = async () => {
    try {
      await sharing.requestAccess(principal, { level, message: message.trim() });
      setError('');
      setSent(true);
      refreshMine();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleWithdraw = async (id: string) => {
    try {
      await sharing.cancelRequest(id, principal);
      setError('');
      refreshMine();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <A11yDialog title={<>Request access to “{workbookName}”</>} onClose={onClose}>
      {currentLevel && (
        <div className="dialog-hint">
          Your current access: <strong style={{ textTransform: 'capitalize' }}>{currentLevel}</strong>.
          You can request a higher level below.
        </div>
      )}

      {sent && (
        <div className="dialog-hint">
          Request sent — the workbook owner will review it. You’ll see the new access level here once it’s approved.
        </div>
      )}

      {mine.length > 0 && (
        <>
          <div className="dialog-title">Your pending requests</div>
          <table className="name-table">
            <thead>
              <tr>
                <th>Requested</th>
                <th>Since</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {mine.map((r) => (
                <tr key={r.id}>
                  <td style={{ textTransform: 'capitalize' }}>{r.requestedLevel}</td>
                  <td>{new Date(r.requestedAt).toLocaleString()}</td>
                  <td>
                    <button onClick={() => handleWithdraw(r.id)}>Withdraw</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {!sent && (
        <>
          <div className="dialog-title" style={{ marginTop: 12 }}>New request</div>
          <label className="dialog-row">
            <span>Access level:</span>
            <select value={level} onChange={(e) => setLevel(e.target.value as ShareLevel)}>
              {LEVELS.map((l) => (
                <option key={l.value} value={l.value}>{l.label} — {l.hint}</option>
              ))}
            </select>
          </label>
          <label className="dialog-row">
            <span>Note to owner:</span>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Why do you need access?"
              rows={3}
            />
          </label>
          {error && <div className="dialog-error">{error}</div>}
          <div className="dialog-actions">
            <button onClick={handleSubmit}>Send request</button>
          </div>
        </>
      )}

      <div className="dialog-actions" style={{ marginTop: 12 }}>
        <button onClick={onClose}>Close</button>
      </div>
    </A11yDialog>
  );
}
