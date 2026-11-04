/**
 * Insert Link… dialog (Insert > Links).
 *
 * Tabs: Web Page (URL), Email Address, Place in This Document (sheet +
 * reference). Shows Recent Items (parent-owned, e.g. localStorage) and a
 * Remove Link action for the selected cell. Validation follows
 * features/links.ts; the parent owns the HyperlinkStore.
 */
import { useState } from 'react';
import {
  linkDestination,
  validateLinkTarget,
  type Hyperlink,
  type LinkTarget,
} from '../features/links';
import A11yDialog from './A11yDialog';

export interface RecentLink {
  target: LinkTarget;
  /** When the link was last used (ms epoch), for display/sorting. */
  usedAt: number;
}

export interface LinkDialogProps {
  /** Sheets for the "Place in This Document" tab. */
  sheets: string[];
  /** Currently active sheet (default place target). */
  sheet: string;
  /** Recent links, newest first (parent persists these). */
  recentLinks: RecentLink[];
  /** Existing hyperlink on the selected cell, if any. */
  existing?: Hyperlink;
  cellLabel: string;
  onClose: () => void;
  /** Insert/replace the hyperlink on the selected cell. */
  onInsert: (link: Hyperlink) => void;
  /** Remove the hyperlink from the selected cell. */
  onRemove: () => void;
  /** User picked a recent item: insert it directly. */
  onPickRecent: (target: LinkTarget) => void;
}

type Tab = 'url' | 'email' | 'place';

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

export function LinkDialog({
  sheets,
  sheet,
  recentLinks,
  existing,
  cellLabel,
  onClose,
  onInsert,
  onRemove,
  onPickRecent,
}: LinkDialogProps) {
  const [tab, setTab] = useState<Tab>('url');
  const [url, setUrl] = useState(
    existing?.target.kind === 'url' ? existing.target.url : 'https://',
  );
  const [email, setEmail] = useState(existing?.target.kind === 'email' ? existing.target.email : '');
  const [subject, setSubject] = useState(existing?.target.kind === 'email' ? (existing.target.subject ?? '') : '');
  const [placeSheet, setPlaceSheet] = useState(
    existing?.target.kind === 'place' ? existing.target.sheet : sheet,
  );
  const [placeRef, setPlaceRef] = useState(existing?.target.kind === 'place' ? existing.target.ref : 'A1');
  const [display, setDisplay] = useState(existing?.display ?? '');
  const [tooltip, setTooltip] = useState(existing?.tooltip ?? '');
  const [error, setError] = useState<string | null>(null);

  const target: LinkTarget =
    tab === 'url'
      ? { kind: 'url', url: url.trim() }
      : tab === 'email'
        ? { kind: 'email', email: email.trim(), subject: subject.trim() || undefined }
        : { kind: 'place', sheet: placeSheet, ref: placeRef.trim() };

  const submit = () => {
    const err = validateLinkTarget(target);
    if (err) {
      setError(err);
      return;
    }
    onInsert({
      target,
      display: display.trim() || undefined,
      tooltip: tooltip.trim() || undefined,
    });
    onClose();
  };

  const tabBtn = (id: Tab, label: string) => (
    <button
      key={id}
      type="button"
      onClick={() => { setTab(id); setError(null); }}
      style={{
        padding: '6px 12px',
        border: '1px solid #ccc',
        borderBottom: tab === id ? '2px solid #2b579a' : '1px solid #ccc',
        background: tab === id ? '#eef3fc' : '#fff',
        cursor: 'pointer',
        fontWeight: tab === id ? 600 : undefined,
      }}
      role="tab"
      aria-selected={tab === id}
    >
      {label}
    </button>
  );

  return (
    <A11yDialog title={<>Insert Hyperlink — {cellLabel}</>} width={480} onClose={onClose}>

        <div style={{ display: 'flex', gap: 4, marginBottom: 12 }} role="tablist">
          {tabBtn('url', 'Web Page')}
          {tabBtn('email', 'Email Address')}
          {tabBtn('place', 'Place in This Document')}
        </div>

        {tab === 'url' && (
          <label className="dialog-row">
            <span>Address:</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com"
              style={{ marginLeft: 8, flex: 1 }}
            />
          </label>
        )}
        {tab === 'email' && (
          <>
            <label className="dialog-row">
              <span>Email address:</span>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                style={{ marginLeft: 8, flex: 1 }}
              />
            </label>
            <label className="dialog-row">
              <span>Subject:</span>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                style={{ marginLeft: 8, flex: 1 }}
              />
            </label>
          </>
        )}
        {tab === 'place' && (
          <>
            <label className="dialog-row">
              <span>Sheet:</span>
              <select value={placeSheet} onChange={(e) => setPlaceSheet(e.target.value)} style={{ marginLeft: 8 }}>
                {sheets.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className="dialog-row">
              <span>Cell reference:</span>
              <input
                value={placeRef}
                onChange={(e) => setPlaceRef(e.target.value)}
                placeholder="A1"
                style={{ marginLeft: 8, width: 100 }}
              />
            </label>
          </>
        )}

        <label className="dialog-row">
          <span>Text to display:</span>
          <input
            value={display}
            onChange={(e) => setDisplay(e.target.value)}
            placeholder="(defaults to the address)"
            style={{ marginLeft: 8, flex: 1 }}
          />
        </label>
        <label className="dialog-row">
          <span>ScreenTip:</span>
          <input
            value={tooltip}
            onChange={(e) => setTooltip(e.target.value)}
            style={{ marginLeft: 8, flex: 1 }}
          />
        </label>

        {error && <div style={{ color: '#b00020', fontSize: 12, marginBottom: 8 }}>{error}</div>}

        {recentLinks.length > 0 && (
          <div style={{ marginTop: 4 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Recent Items</div>
            <div style={{ border: '1px solid #ccc', maxHeight: 110, overflowY: 'auto' }}>
              {recentLinks.slice(0, 10).map((r, i) => (
                <button
                  key={`${linkDestination({ target: r.target })}-${i}`}
                  type="button"
                  onClick={() => { onPickRecent(r.target); onClose(); }}
                  title={`Used ${fmtDate(r.usedAt)}`}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    border: 'none',
                    background: 'none',
                    padding: '4px 8px',
                    cursor: 'pointer',
                    fontSize: 12,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {linkDestination({ target: r.target })}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="dialog-actions">
          <button onClick={submit}>{existing ? 'Update Link' : 'Insert Link'}</button>
          {existing && (
            <button
              onClick={() => { onRemove(); onClose(); }}
              title="Remove the hyperlink from the selected cell"
            >
              Remove Link
            </button>
          )}
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}
