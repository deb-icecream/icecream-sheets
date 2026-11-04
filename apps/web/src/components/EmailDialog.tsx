/**
 * Email dialog (File > Email).
 *
 * Collects recipients, subject and body plus the OAuth2 credential for the
 * Mail connector (design-docs/connector-vs-component.md): either paste an
 * access token (kept in memory only, never stored) or name a vault
 * credentialRef (resolved through the gateway vault when the app runs
 * against deployed services). The parent supplies onSend, which attaches
 * the workbook bytes and calls features/email.ts.
 */
import { useState } from 'react';
import A11yDialog from './A11yDialog';
import { parseRecipients } from '../features/email';
import type { WorkbookEmail } from '../features/email';

interface EmailDialogProps {
  /** Suggested attachment filename, e.g. "workbook.xlsx". */
  filename: string;
  defaultFrom: string;
  onClose: () => void;
  onSend: (
    email: WorkbookEmail,
    credential: { accessToken?: string; credentialRef?: string },
  ) => Promise<string>;
}

export default function EmailDialog({ filename, defaultFrom, onClose, onSend }: EmailDialogProps) {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [credMode, setCredMode] = useState<'token' | 'vault'>('token');
  const [token, setToken] = useState('');
  const [credentialRef, setCredentialRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sentId, setSentId] = useState('');

  const send = async (): Promise<void> => {
    setError('');
    setSentId('');
    try {
      const recipients = parseRecipients(to);
      if (recipients.length === 0) throw new Error('Add at least one recipient.');
      if (from.trim() === '') throw new Error('The sender address is required.');
      const credential =
        credMode === 'token'
          ? { accessToken: token.trim() }
          : { credentialRef: credentialRef.trim() };
      if (credMode === 'token' && !credential.accessToken) {
        throw new Error('Paste an OAuth2 access token for the sender mailbox.');
      }
      if (credMode === 'vault' && !credential.credentialRef) {
        throw new Error('Name the vault credentialRef holding the OAuth2 token.');
      }
      setBusy(true);
      const id = await onSend(
        { from: from.trim(), to: recipients, cc: parseRecipients(cc), subject, body },
        credential,
      );
      setSentId(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <A11yDialog title="Email Workbook" onClose={onClose} width={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <p style={{ margin: 0 }}>
          Sends <strong>{filename}</strong> as an attachment through the Mail connector
          (OAuth2 — the token is used once and never stored).
        </p>
        <label>
          From
          <input type="email" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: '100%' }} />
        </label>
        <label>
          To (comma or semicolon separated)
          <input type="text" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: '100%' }} />
        </label>
        <label>
          Cc
          <input type="text" value={cc} onChange={(e) => setCc(e.target.value)} style={{ width: '100%' }} />
        </label>
        <label>
          Subject
          <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} style={{ width: '100%' }} />
        </label>
        <label>
          Message
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} style={{ width: '100%' }} />
        </label>
        <fieldset style={{ border: '1px solid #ccc', padding: 8 }}>
          <legend>OAuth2 credential</legend>
          <label style={{ display: 'block', marginBottom: 4 }}>
            <input
              type="radio"
              checked={credMode === 'token'}
              onChange={() => setCredMode('token')}
            />{' '}
            Paste access token (in-memory only)
          </label>
          {credMode === 'token' && (
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="ya29.…"
              style={{ width: '100%' }}
              autoComplete="off"
            />
          )}
          <label style={{ display: 'block', marginTop: 6, marginBottom: 4 }}>
            <input
              type="radio"
              checked={credMode === 'vault'}
              onChange={() => setCredMode('vault')}
            />{' '}
            Vault credentialRef
          </label>
          {credMode === 'vault' && (
            <input
              type="text"
              value={credentialRef}
              onChange={(e) => setCredentialRef(e.target.value)}
              placeholder="gmail-oauth-token"
              style={{ width: '100%' }}
            />
          )}
        </fieldset>
        {error !== '' && <div role="alert" style={{ color: 'var(--error, #c00)' }}>{error}</div>}
        {sentId !== '' && (
          <div role="status" style={{ color: 'var(--success, #080)' }}>
            Sent (message id {sentId}).
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose}>Close</button>
          <button type="button" onClick={() => void send()} disabled={busy}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </A11yDialog>
  );
}
