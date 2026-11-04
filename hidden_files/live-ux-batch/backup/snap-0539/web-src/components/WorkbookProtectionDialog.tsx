/**
 * Workbook Protection dialog (Review > Protect > Protect Workbook,
 * Allow Edit Ranges).
 *
 * Two tabs:
 *  - Protect Workbook: structure protection (prevent add/delete/rename/
 *    hide of sheets) + windows protection, with optional password.
 *    Backed by the engine ProtectionManager
 *    (packages/engine/src/protection.ts): protectWorkbook /
 *    unprotectWorkbook / getWorkbookProtection. Unprotecting requires
 *    the password when one was set.
 *  - Allow Edit Ranges: per-range passwords on the protected sheet
 *    (features/editRanges.ts — salted SHA-256, never plaintext). Ranges
 *    listed here can be edited by anyone who knows the range password;
 *    a successful entry unlocks the range for the session
 *    (unlockRangeForSession). The parent owns enforcement: before
 *    writing to a protected sheet it checks the registry.
 */
import { useState } from 'react';
import type { ProtectionManager } from '@icecream-sheets/engine';
import A11yDialog from './A11yDialog';
import {
  addEditRange,
  createEditRange,
  loadEditRanges,
  removeEditRange,
  verifyEditRangePassword,
  unlockRangeForSession,
  type EditRangeEntry,
} from '../features/editRanges';

interface WorkbookProtectionDialogProps {
  /** The app's ProtectionManager (owns workbook + sheet protection state). */
  protection: ProtectionManager;
  /** Current sheet (Allow Edit Ranges applies here). */
  sheet: string;
  onClose: () => void;
  /** Parent persists/uses the registry for write-time enforcement. */
  onEditRangesChange?: (ranges: EditRangeEntry[]) => void;
  /** Which tab to open on (ribbon entry point). */
  initialTab?: Tab;
}

type Tab = 'workbook' | 'ranges';

export default function WorkbookProtectionDialog({
  protection,
  sheet,
  onClose,
  onEditRangesChange,
  initialTab,
}: WorkbookProtectionDialogProps) {
  const [tab, setTab] = useState<Tab>(initialTab ?? 'workbook');
  // Workbook tab
  const wb = protection.getWorkbookProtection();
  const [isProtected, setIsProtected] = useState(wb.structure || wb.windows);
  const [windows, setWindows] = useState(wb.windows);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [wbError, setWbError] = useState('');
  const [wbMsg, setWbMsg] = useState('');
  // Ranges tab
  const [ranges, setRanges] = useState<EditRangeEntry[]>(() => loadEditRanges());
  const [range, setRange] = useState('');
  const [title, setTitle] = useState('');
  const [rangePw, setRangePw] = useState('');
  const [rangeError, setRangeError] = useState('');
  const [unlockFor, setUnlockFor] = useState('');
  const [unlockPw, setUnlockPw] = useState('');
  const [unlockMsg, setUnlockMsg] = useState('');

  const sheetRanges = ranges.filter((r) => r.sheet === sheet);

  const protect = (): void => {
    setWbError('');
    setWbMsg('');
    if (password !== confirm) { setWbError('Passwords do not match.'); return; }
    protection.protectWorkbook(password || undefined, { windows });
    setIsProtected(true);
    setWbMsg(`Workbook structure${windows ? ' and windows' : ''} protected${password ? ' with a password' : ''}.`);
    setPassword('');
    setConfirm('');
  };

  const unprotect = (): void => {
    setWbError('');
    setWbMsg('');
    const ok = protection.unprotectWorkbook(password || undefined);
    if (!ok) { setWbError('Incorrect password.'); return; }
    setIsProtected(false);
    setWbMsg('Workbook protection removed.');
    setPassword('');
  };

  const addRange = (): void => {
    setRangeError('');
    try {
      const entry = createEditRange(sheet, range, title, rangePw);
      const next = addEditRange(entry);
      setRanges(next);
      onEditRangesChange?.(next);
      setRange('');
      setTitle('');
      setRangePw('');
    } catch (e) {
      setRangeError(e instanceof Error ? e.message : 'Could not add range.');
    }
  };

  const delRange = (id: string): void => {
    const next = removeEditRange(id);
    setRanges(next);
    onEditRangesChange?.(next);
  };

  const tryUnlock = (entry: EditRangeEntry): void => {
    setUnlockMsg('');
    if (verifyEditRangePassword(entry, unlockPw)) {
      unlockRangeForSession(entry.id);
      setUnlockMsg(`Range "${entry.title}" unlocked for this session.`);
      setUnlockFor('');
      setUnlockPw('');
    } else {
      setUnlockMsg('Incorrect password for this range.');
    }
  };

  return (
    <A11yDialog title={<>Protect Workbook</>} width={520} onClose={onClose}>
        <div className="dialog-row" role="tablist" aria-label="Protection">
          {([['workbook', 'Protect Workbook'], ['ranges', 'Allow Edit Ranges']] as [Tab, string][]).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'tab-active' : ''} onClick={() => setTab(k)} style={{ marginRight: 6 }}>
              {label}
            </button>
          ))}
        </div>

        {tab === 'workbook' && (
          <div className="dialog-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
            <div style={{ fontSize: 13 }}>
              Status: <strong>{isProtected ? 'Protected' : 'Not protected'}</strong>
              {isProtected && <span style={{ color: '#666' }}> (structure{warnings(wb)})</span>}
            </div>
            {!isProtected ? (
              <>
                <label>
                  <input type="checkbox" checked readOnly /> Protect structure (prevent adding, deleting, renaming, hiding sheets)
                </label>
                <label>
                  <input type="checkbox" checked={windows} onChange={(e) => setWindows(e.target.checked)} /> Protect windows (desktop window arrangement)
                </label>
                <label>
                  Password (optional)<br />
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: '100%' }} autoComplete="new-password" />
                </label>
                <label>
                  Confirm password<br />
                  <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} style={{ width: '100%' }} autoComplete="new-password" />
                </label>
                {wbError && <div style={{ color: 'red', fontSize: 13 }}>{wbError}</div>}
                {wbMsg && <div style={{ color: '#1a7f37', fontSize: 13 }}>{wbMsg}</div>}
                <div><button onClick={protect}>Protect Workbook</button></div>
              </>
            ) : (
              <>
                <label>
                  Password<br />
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: '100%' }} autoComplete="current-password" placeholder={wb.passwordHash ? 'Required' : 'No password set'} />
                </label>
                {wbError && <div style={{ color: 'red', fontSize: 13 }}>{wbError}</div>}
                {wbMsg && <div style={{ color: '#1a7f37', fontSize: 13 }}>{wbMsg}</div>}
                <div><button onClick={unprotect}>Unprotect Workbook</button></div>
              </>
            )}
          </div>
        )}

        {tab === 'ranges' && (
          <div className="dialog-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
            <p style={{ fontSize: 13, color: '#555', margin: 0 }}>
              Ranges on <strong>{sheet}</strong> that stay editable with their own password
              while the sheet is protected.
            </p>
            {sheetRanges.length === 0 && <span style={{ color: '#888', fontSize: 13 }}>No edit ranges on this sheet yet.</span>}
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {sheetRanges.map((r) => (
                <li key={r.id} style={{ border: '1px solid var(--line-soft)', borderRadius: 6, padding: 8, marginBottom: 8, fontSize: 13 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <strong style={{ flex: 1 }}>{r.title}</strong>
                    <span style={{ color: '#666' }}>{r.range}</span>
                    <button onClick={() => delRange(r.id)}>Delete</button>
                  </div>
                  {unlockFor === r.id ? (
                    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                      <input type="password" value={unlockPw} onChange={(e) => setUnlockPw(e.target.value)} placeholder="Range password" aria-label={`Password for ${r.title}`} />
                      <button onClick={() => tryUnlock(r)}>Unlock</button>
                      <button onClick={() => setUnlockFor('')}>Cancel</button>
                    </div>
                  ) : (
                    <button style={{ marginTop: 6, fontSize: 12 }} onClick={() => { setUnlockFor(r.id); setUnlockPw(''); setUnlockMsg(''); }}>
                      Enter password to unlock for this session
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {unlockMsg && <div style={{ fontSize: 13 }}>{unlockMsg}</div>}
            <strong>New range</strong>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Range title" />
              <input value={range} onChange={(e) => setRange(e.target.value)} placeholder="Range (e.g. B2:D10)" aria-label="Range" spellCheck={false} />
              <input type="password" value={rangePw} onChange={(e) => setRangePw(e.target.value)} placeholder="Password" aria-label="Range password" autoComplete="new-password" />
              <button onClick={addRange}>Add</button>
            </div>
            {rangeError && <div style={{ color: 'red', fontSize: 13 }}>{rangeError}</div>}
          </div>
        )}

        <div className="dialog-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </A11yDialog>
  );
}

function warnings(wb: { windows: boolean }): string {
  return wb.windows ? ' + windows' : '';
}
