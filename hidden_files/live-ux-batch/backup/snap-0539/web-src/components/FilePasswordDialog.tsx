/**
 * File password dialog (protection faces a & b).
 *
 * Mode "open": prompts for the password that decrypts an encrypted workbook
 * file. Mode "download": sets a password to encrypt the downloaded file.
 * The password is used only to derive the encryption key (PBKDF2) and is
 * never stored anywhere.
 */
import { useState } from 'react';
import A11yDialog from './A11yDialog';

interface FilePasswordDialogProps {
  mode: 'open' | 'download';
  filename?: string;
  onSubmit: (password: string) => void;
  onClose: () => void;
  error?: string | null;
  busy?: boolean;
}

export function FilePasswordDialog({
  mode,
  filename,
  onSubmit,
  onClose,
  error,
  busy,
}: FilePasswordDialogProps) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localError, setLocalError] = useState('');

  const submit = () => {
    if (!password) {
      setLocalError('Enter a password.');
      return;
    }
    if (mode === 'download' && password !== confirm) {
      setLocalError('Passwords do not match.');
      return;
    }
    onSubmit(password);
  };

  return (
    <A11yDialog title={<>{mode === 'open'
            ? `Open encrypted workbook${filename ? ` “${filename}”` : ''}`
            : 'Encrypt download with a password'}</>} onClose={onClose}>
        <p className="dialog-hint">
          {mode === 'open'
            ? 'This file is password-protected. The password derives the decryption key — it is never stored.'
            : 'The downloaded file will be encrypted. The password derives the encryption key — it is never stored.'}
        </p>
        <label className="dialog-field">
          Password
          <input
            type="password"
            value={password}
            autoFocus
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') onClose();
            }}
          />
        </label>
        {mode === 'download' && (
          <label className="dialog-field">
            Confirm password
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
                if (e.key === 'Escape') onClose();
              }}
            />
          </label>
        )}
        {(localError || error) && <p className="dialog-error">{localError || error}</p>}
        <div className="dialog-actions">
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button onClick={submit} disabled={busy || !password} className="primary">
            {busy ? 'Working…' : mode === 'open' ? 'Decrypt & open' : 'Download encrypted'}
          </button>
        </div>
      </A11yDialog>
  );
}
