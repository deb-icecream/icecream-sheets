/**
 * Sheet protection dialog: protect/unprotect the active sheet with an
 * optional password, per design-docs/workbook-protection-and-encryption.md.
 */
import { useState } from 'react';
import A11yDialog from './A11yDialog';

interface ProtectionDialogProps {
  sheetName: string;
  isProtected: boolean;
  onClose: () => void;
  onProtect: (password: string | undefined) => void;
  onUnprotect: (password: string | undefined) => boolean;
}

export function ProtectionDialog({
  sheetName,
  isProtected,
  onClose,
  onProtect,
  onUnprotect,
}: ProtectionDialogProps) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');

  const handleProtect = () => {
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    onProtect(password === '' ? undefined : password);
    onClose();
  };

  const handleUnprotect = () => {
    const ok = onUnprotect(password === '' ? undefined : password);
    if (!ok) setError('Incorrect password.');
    else onClose();
  };

  return (
    <A11yDialog title={<>{isProtected ? `Unprotect "${sheetName}"` : `Protect "${sheetName}"`}</>} onClose={onClose}>
        <p className="dialog-hint">
          {isProtected
            ? 'Enter the password to remove protection.'
            : 'Locked cells cannot be edited while the sheet is protected. Leave the password blank for protection without a password.'}
        </p>
        <label className="dialog-field">
          Password (optional)
          <input
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError('');
            }}
            autoFocus
          />
        </label>
        {!isProtected && (
          <label className="dialog-field">
            Confirm password
            <input
              type="password"
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value);
                setError('');
              }}
            />
          </label>
        )}
        {error && <div className="dialog-error">{error}</div>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          {isProtected ? (
            <button type="button" className="primary" onClick={handleUnprotect}>
              Unprotect
            </button>
          ) : (
            <button type="button" className="primary" onClick={handleProtect}>
              Protect
            </button>
          )}
        </div>
      </A11yDialog>
  );
}
