/**
 * Share dialog: who can open this file, and (for the owner) changing it.
 *
 * Backed by the server's share contract (issue #71; design-docs/
 * read-only-enforcement.md sections 5/6/8): the gateway's registry
 * record is the only authority — GET /api/engine/share returns the
 * owner, the caller's own server-derived role, and the recorded
 * grants; POST /api/engine/share grants, re-roles, and revokes
 * (owner-only on the server, which stays the enforcer no matter what
 * this dialog shows). Exactly three roles exist: Owner, Editor,
 * Viewer. The owner's own entry can never be changed or removed.
 *
 * Local-only files (no server file) cannot be shared: the dialog says
 * so plainly instead of recording a share nobody else could ever use.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import A11yDialog from './A11yDialog';
import {
  displayId,
  fetchFileShareState,
  resolvePrincipalByEmail,
  setFileGrant,
  setLinkShare,
  toFileShareError,
  toPrincipal,
  transferOwnership,
  type FileGrantRole,
  type FileShareState,
} from '../services/fileSharing';

interface ShareDialogProps {
  /** Registry fileId of the open file; null when the file is local-only. */
  fileId: string | null;
  workbookName: string;
  /** The signed-in user's gateway principal (`user:<id>`), or null. */
  principal: string | null;
  onClose: () => void;
}

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  editor: 'Editor',
  viewer: 'Viewer',
};

const GRANT_LEVELS: Array<{ value: FileGrantRole; label: string; hint: string }> = [
  { value: 'viewer', label: 'Viewer', hint: 'can look, but not change anything' },
  { value: 'editor', label: 'Editor', hint: 'can change the file' },
];

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; state: FileShareState }
  | { kind: 'error'; message: string };

export default function ShareDialog({ fileId, workbookName, principal, onClose }: ShareDialogProps) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [inviteInput, setInviteInput] = useState('');
  const [inviteLevel, setInviteLevel] = useState<FileGrantRole>('viewer');
  const [transferInput, setTransferInput] = useState('');
  const [transferConfirm, setTransferConfirm] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!fileId) return;
    try {
      const state = await fetchFileShareState(fileId);
      if (aliveRef.current) setLoad({ kind: 'ready', state });
    } catch (e) {
      if (aliveRef.current) setLoad({ kind: 'error', message: toFileShareError(e).message });
    }
  }, [fileId]);

  useEffect(() => {
    aliveRef.current = true;
    if (fileId) {
      setLoad({ kind: 'loading' });
      void refresh();
    }
    return () => {
      aliveRef.current = false;
    };
  }, [fileId, refresh]);

  const runMutation = async (key: string, action: () => Promise<string>) => {
    setBusy(key);
    setError('');
    setNote('');
    try {
      const success = await action();
      await refresh();
      if (aliveRef.current) setNote(success);
    } catch (e) {
      if (aliveRef.current) {
        setError(toFileShareError(e).message);
        // Resync to the server's truth so a failed change never
        // leaves the dialog showing something that didn't happen.
        await refresh();
      }
    } finally {
      if (aliveRef.current) setBusy(null);
    }
  };

  /** Resolve an invite entry: an email goes through the directory
   * (issue #84a — only people who have signed in once resolve), an
   * account ID normalizes as before. Returns null with the error
   * already shown when the entry cannot be used. */
  const resolveInviteTarget = async (input: string): Promise<string | null> => {
    const trimmed = input.trim();
    if (!trimmed) {
      setError('Enter the account ID or email address of the person you want to share with.');
      return null;
    }
    if (trimmed.includes('@')) {
      if (!fileId) return null;
      try {
        const resolved = await resolvePrincipalByEmail(fileId, trimmed);
        return resolved.principal;
      } catch (e) {
        setError(toFileShareError(e).message);
        return null;
      }
    }
    return toPrincipal(trimmed);
  };

  const handleInvite = async () => {
    if (!fileId) return;
    const target = await resolveInviteTarget(inviteInput);
    if (!target) return;
    if (load.kind === 'ready' && target === load.state.owner) {
      setError('That’s the owner of this file — they already have full access.');
      return;
    }
    const already = load.kind === 'ready' && load.state.grants.some((g) => g.principal === target);
    const shown = inviteInput.trim().includes('@') ? inviteInput.trim() : displayId(target);
    await runMutation('invite', async () => {
      await setFileGrant(fileId, target, inviteLevel);
      setInviteInput('');
      return already
        ? `${shown} is now ${inviteLevel === 'editor' ? 'an editor' : 'a viewer'} on this file.`
        : `${shown} can now ${inviteLevel === 'editor' ? 'edit' : 'view'} this file.`;
    });
  };

  const handleLinkChange = async (value: string) => {
    if (!fileId) return;
    const role = value === 'off' ? null : (value as FileGrantRole);
    await runMutation('link', async () => {
      await setLinkShare(fileId, role);
      return role === null
        ? 'Link sharing is off — only people you’ve shared with directly can open this file.'
        : `Anyone with the link can now ${role === 'editor' ? 'edit' : 'view'} this file.`;
    });
  };

  const handleCopyLink = async () => {
    if (!fileId) return;
    const link = `${window.location.origin}${window.location.pathname}?file=${encodeURIComponent(fileId)}`;
    try {
      await navigator.clipboard.writeText(link);
      setLinkCopied(true);
    } catch {
      setError('Couldn’t copy the link automatically — copy it from the address bar instead.');
    }
  };

  const handleTransfer = async () => {
    if (!fileId) return;
    const target = await resolveInviteTarget(transferInput);
    if (!target) return;
    if (load.kind === 'ready') {
      if (target === load.state.owner) {
        setError('You already own this file.');
        return;
      }
      if (!load.state.grants.some((g) => g.principal === target)) {
        setError(
          'That person doesn’t have access to this file yet — share it with them first, then transfer.',
        );
        return;
      }
    }
    await runMutation('transfer', async () => {
      const result = await transferOwnership(fileId, target);
      setTransferInput('');
      setTransferConfirm(false);
      return result.catalogTransferred
        ? `${displayId(target)} is now the owner of this file. You keep editor access.`
        : `${displayId(target)} is now the owner of this file. You keep editor access, but the workspace listing didn’t update — the new owner can still open the file from its link.`;
    });
  };

  const handleRoleChange = async (target: string, role: FileGrantRole) => {
    if (!fileId) return;
    await runMutation(`role:${target}`, async () => {
      await setFileGrant(fileId, target, role);
      return `${displayId(target)} is now ${role === 'editor' ? 'an editor' : 'a viewer'} on this file.`;
    });
  };

  const handleRevoke = async (target: string) => {
    if (!fileId) return;
    await runMutation(`revoke:${target}`, async () => {
      await setFileGrant(fileId, target, null);
      return `${displayId(target)} no longer has access to this file.`;
    });
  };

  const title = <>Share “{workbookName}”</>;

  if (!fileId) {
    return (
      <A11yDialog title={title} onClose={onClose}>
        <div className="dialog-title">People with access</div>
        <div className="dialog-hint">
          This file is only on this device right now, so it can’t be shared. Save it to your
          workspace, and you’ll be able to choose who can see and edit it.
        </div>
        <div className="dialog-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </A11yDialog>
    );
  }

  if (load.kind === 'loading') {
    return (
      <A11yDialog title={title} onClose={onClose}>
        <div className="dialog-hint">Loading who has access…</div>
        <div className="dialog-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </A11yDialog>
    );
  }

  if (load.kind === 'error') {
    return (
      <A11yDialog title={title} onClose={onClose}>
        <div className="dialog-error">{load.message}</div>
        <div className="dialog-actions">
          <button
            onClick={() => {
              setLoad({ kind: 'loading' });
              void refresh();
            }}
          >
            Try again
          </button>
          <button onClick={onClose}>Close</button>
        </div>
      </A11yDialog>
    );
  }

  const { state } = load;
  const isOwner = state.role === 'owner';

  return (
    <A11yDialog title={title} onClose={onClose}>
      <div className="dialog-title">People with access</div>
      <table className="name-table">
        <thead>
          <tr>
            <th>Person</th>
            <th>Access</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr key={state.owner}>
            <td>
              {displayId(state.owner)}
              {state.owner === principal ? ' (you)' : ''}
            </td>
            <td>Owner</td>
            <td></td>
          </tr>
          {state.grants.map((g) => (
            <tr key={g.principal}>
              <td>
                {displayId(g.principal)}
                {g.principal === principal ? ' (you)' : ''}
              </td>
              <td>
                {isOwner ? (
                  <select
                    value={g.role}
                    disabled={busy !== null}
                    aria-label={`Access level for ${displayId(g.principal)}`}
                    onChange={(e) => void handleRoleChange(g.principal, e.target.value as FileGrantRole)}
                  >
                    {GRANT_LEVELS.map((l) => (
                      <option key={l.value} value={l.value}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  ROLE_LABEL[g.role]
                )}
              </td>
              <td>
                {isOwner && (
                  <button
                    disabled={busy !== null}
                    onClick={() => void handleRevoke(g.principal)}
                  >
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {note && (
        <div className="dialog-hint" role="status">
          {note}
        </div>
      )}
      {error && <div className="dialog-error">{error}</div>}

      {isOwner ? (
        <>
          <div className="dialog-title" style={{ marginTop: 12 }}>
            Share with someone
          </div>
          <label className="dialog-row">
            <span>Account ID or email:</span>
            <input
              value={inviteInput}
              onChange={(e) => setInviteInput(e.target.value)}
              placeholder="account ID or email address"
              aria-label="Account ID or email address of the person to share with"
            />
          </label>
          <label className="dialog-row">
            <span>Access:</span>
            <select
              value={inviteLevel}
              onChange={(e) => setInviteLevel(e.target.value as FileGrantRole)}
              aria-label="Access level for the new share"
            >
              {GRANT_LEVELS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label} — {l.hint}
                </option>
              ))}
            </select>
          </label>
          <div className="dialog-actions">
            <button disabled={busy !== null} onClick={() => void handleInvite()}>
              Share
            </button>
            <button onClick={onClose}>Close</button>
          </div>
          <div className="dialog-title" style={{ marginTop: 12 }}>
            Anyone with the link
          </div>
          <div className="dialog-hint">
            When link sharing is on, anyone signed in who opens this file from its link gets
            the role below — no direct share needed. Turn it off to go back to direct shares only.
          </div>
          <label className="dialog-row">
            <span>Link sharing:</span>
            <select
              value={state.linkShare?.role ?? 'off'}
              disabled={busy !== null}
              aria-label="Link sharing role"
              onChange={(e) => void handleLinkChange(e.target.value)}
            >
              <option value="off">Off</option>
              <option value="viewer">Viewer — anyone with the link can look, but not change anything</option>
              <option value="editor">Editor — anyone with the link can change the file</option>
            </select>
          </label>
          {state.linkShare && (
            <div className="dialog-actions">
              <button disabled={busy !== null} onClick={() => void handleCopyLink()}>
                Copy link
              </button>
              {linkCopied && (
                <span className="dialog-hint" role="status">
                  Link copied.
                </span>
              )}
            </div>
          )}
          <div className="dialog-title" style={{ marginTop: 12 }}>
            Transfer ownership
          </div>
          <div className="dialog-hint">
            The new owner must already have access to this file. You’ll keep editor access, but
            the new owner will be able to change that later.
          </div>
          <label className="dialog-row">
            <span>New owner:</span>
            <input
              value={transferInput}
              onChange={(e) => setTransferInput(e.target.value)}
              placeholder="account ID or email address"
              aria-label="Account ID or email address of the new owner"
            />
          </label>
          {!transferConfirm ? (
            <div className="dialog-actions">
              <button disabled={busy !== null || transferInput.trim() === ''} onClick={() => setTransferConfirm(true)}>
                Transfer ownership…
              </button>
            </div>
          ) : (
            <>
              <div className="dialog-error">
                Transfer ownership of this file to {transferInput.trim()}? You will stop being
                the owner and become an editor.
              </div>
              <div className="dialog-actions">
                <button disabled={busy !== null} onClick={() => void handleTransfer()}>
                  Yes, transfer ownership
                </button>
                <button disabled={busy !== null} onClick={() => setTransferConfirm(false)}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          {state.linkShare && (
            <div className="dialog-hint" style={{ marginTop: 12 }}>
              Link sharing is on: anyone with the link can{' '}
              {state.linkShare.role === 'editor' ? 'edit' : 'view'} this file.
            </div>
          )}
          <div className="dialog-hint" style={{ marginTop: 12 }}>
            Only the owner can change who has access to this file.
          </div>
          <div className="dialog-actions">
            <button onClick={onClose}>Close</button>
          </div>
        </>
      )}
    </A11yDialog>
  );
}
