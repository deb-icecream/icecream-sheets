/**
 * Icecream Sheets Workspace (workspace-redesign brief, 2026-10-22):
 * the post-login home, modeled on OneDrive / SharePoint — a header
 * bar (product identity left; settings gear + user identity right),
 * a command bar (+ New / Upload), and the files in a LIST VIEW.
 *
 * The grid opens FROM here, via each file's deep link — file names
 * are REAL anchors (`<a href={buildFileUrl(id)}>`) so copy-link /
 * open-in-new-tab / history work without any JS. List order is the
 * API's order: recents-first (most recently used first).
 *
 * Settings live on their OWN PAGE (SettingsPage) reached from the
 * gear icon — never a panel inside the file list.
 *
 * All data flows through the injected ProductApi. Server cap errors
 * (upload too large, file limit reached) surface VERBATIM in an alert
 * region — the server's wording names the limit and the Pro path, and
 * the UI never paraphrases it away.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import './product.css';
import type { FileListResult, ProductApi, UserFileRecord } from './productApi';
import { buildFileUrl, buildHomeUrl } from './deepLink';
import { SettingsPage, type FirebaseDeleteOutcome } from './SettingsPage';

export interface WorkspaceProps {
  api: ProductApi;
  /**
   * Optional custom open handler. When supplied, file-anchor clicks are
   * intercepted (preventDefault) and routed here, and a successful
   * create opens through it too. When absent, anchors navigate natively
   * and create falls back to `window.location.assign(buildFileUrl(id))`.
   */
  onOpenFile?: (fileId: string) => void;
  /**
   * The generated-apps gallery, supplied by the app shell (built by
   * the app-gallery coordinator: apps with bound sheet + preview,
   * Reopen/Duplicate/Share). The Workspace provides only the frame —
   * an "Apps" section rendered last — the gallery component and its
   * actions are the gallery's own. Absent → no Apps section at all.
   */
  appsSlot?: React.ReactNode;
  /**
   * The shell's account control (sign-in identity + sign out),
   * rendered at the right of the header bar next to the settings
   * gear. Absent → header carries brand + tier only.
   */
  accountSlot?: React.ReactNode;
  /**
   * Workspace settings wiring (workspace-settings brief): the shell
   * supplies the sign-in provider profile (display-name default +
   * read-only email), the Firebase leg of account deletion, and the
   * sign-out finisher. Absent → no gear/avatar: the settings surface
   * needs an account behind it.
   */
  settings?: {
    profileEmail: string | null;
    profileName: string | null;
    onFirebaseDelete: () => Promise<FirebaseDeleteOutcome>;
    onSignedOut: () => void;
  };
}

export function formatBytes(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return '—';
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  if (sizeBytes < 1024 * 1024 * 1024) return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * #105: the list's Size cell. '—' means "no stored size known": a
 * record with sizeBytes 0 AND no stored reference (no upload
 * storageRef AND no libraryEntryId) — a created file never saved.
 * It must never show '0 B' for that case ('0 B' asserts
 * stored-but-empty). Any record with a known size shows it: uploads
 * (size from complete-upload), created files after a checkpoint or
 * library save (size relayed by the client from engine-reported
 * stored sizes). A serialized workbook is never 0 bytes, so a
 * nonzero sizeBytes is always a real stored size. Pre-fix saved
 * files (bytes exist in the engine but the catalog was never linked)
 * show '—' until their next save/checkpoint heals the link —
 * documented, not hidden.
 */
export function displaySize(file: {
  sizeBytes: number;
  storageRef: { bucket: string; object: string } | null;
  libraryEntryId: string | null;
}): string {
  if (file.sizeBytes === 0 && file.storageRef === null && file.libraryEntryId === null) return '—';
  return formatBytes(file.sizeBytes);
}

export function formatRelativeTime(epochMs: number): string {
  const diffMs = Date.now() - epochMs;
  if (!Number.isFinite(diffMs)) return '—';
  if (diffMs < 60_000) return 'just now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(epochMs).toLocaleDateString();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Origin tag label — received share copies list like any other entry. */
export function originLabel(origin: UserFileRecord['origin']): string {
  if (origin === 'upload') return 'Uploaded';
  if (origin === 'shared') return 'Shared';
  return 'Created';
}

/** Initials for the header avatar: first letters of the first + last word. */
export function initialsFor(name: string | null, email: string | null): string {
  const source = (name ?? '').trim() || (email ?? '').trim();
  if (!source) return '?';
  const words = source.replace('@', ' ').split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase();
  return (words[0].slice(0, 1) + words[words.length - 1].slice(0, 1)).toUpperCase();
}

function GearIcon() {
  const teeth = Array.from({ length: 8 }, (_, i) => i * 45);
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <g fill="currentColor">
        {teeth.map((deg) => (
          <rect
            key={deg}
            x="11"
            y="2.4"
            width="2"
            height="4.8"
            rx="0.9"
            transform={`rotate(${deg} 12 12)`}
          />
        ))}
        <path
          fillRule="evenodd"
          d="M12 5.4a6.6 6.6 0 1 0 .001 0 Z M12 9.1a2.9 2.9 0 1 1-.001 0 Z"
        />
      </g>
    </svg>
  );
}

function DotsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <g fill="currentColor">
        <circle cx="12" cy="5" r="1.9" />
        <circle cx="12" cy="12" r="1.9" />
        <circle cx="12" cy="19" r="1.9" />
      </g>
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="17"
      height="17"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 16V5" />
      <path d="m6.5 10.5 5.5-5.5 5.5 5.5" />
      <path d="M4.5 20h15" />
    </svg>
  );
}

/** File-type glyph: a grid sheet for workbooks, a data page for CSV. */
export function FileTypeIcon({ format }: { format: UserFileRecord['sourceFormat'] }) {
  if (format === 'csv') {
    return (
      <svg
        viewBox="0 0 24 24"
        width="22"
        height="22"
        className="ics-file-icon"
        aria-hidden="true"
        focusable="false"
      >
        <rect x="4.5" y="3" width="15" height="18" rx="2" fill="none" stroke="#8a6d1f" strokeWidth="1.6" />
        <text
          x="12"
          y="14.4"
          textAnchor="middle"
          fontSize="5.4"
          fontWeight="700"
          fill="#8a6d1f"
          fontFamily="inherit"
        >
          CSV
        </text>
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      className="ics-file-icon"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3.5" y="4" width="17" height="16" rx="2" fill="#0e7c6b" />
      <g stroke="#ffffff" strokeWidth="1.3" opacity="0.85">
        <path d="M9.2 4v16M14.8 4v16M3.5 9.3h17M3.5 14.6h17" />
      </g>
    </svg>
  );
}

export function Workspace({ api, onOpenFile, appsSlot, accountSlot, settings }: WorkspaceProps) {
  const [view, setView] = useState<'files' | 'settings'>('files');
  const [data, setData] = useState<FileListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const identityLoadedRef = useRef(false);

  // The header avatar shows the user's SAVED display name (the
  // settings record — the same name presence uses) once it loads;
  // until then it falls back to the shell's profile props. Loaded once
  // per mount, and only when the settings wiring exists (the avatar
  // renders only then). Failures just keep the fallback. NOTE: the
  // shell passes `settings` as a fresh object on every render, so this
  // must NOT cancel on effect cleanup — a mounted ref guards the
  // setState instead.
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );
  useEffect(() => {
    if (!settings || identityLoadedRef.current) return;
    identityLoadedRef.current = true;
    api
      .getSettings()
      .then((view) => {
        if (mountedRef.current) setSavedName(view.displayName);
      })
      .catch(() => undefined);
  }, [api, settings]);

  const refresh = useCallback(async () => {
    try {
      const result = await api.listFiles();
      setData(result);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Row menu: one open at a time; Escape or a click anywhere outside
  // the menu closes it (OneDrive/SharePoint behavior).
  useEffect(() => {
    if (!openMenuId) return;
    const onDocClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.ics-row-menu-wrap')) setOpenMenuId(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMenuId(null);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenuId]);

  const openFile = useCallback(
    (fileId: string) => {
      if (onOpenFile) onOpenFile(fileId);
      else window.location.assign(buildFileUrl(fileId));
    },
    [onOpenFile],
  );

  /** Anchors stay real links; only a custom handler intercepts them. */
  const handleAnchorClick = (event: React.MouseEvent, fileId: string) => {
    if (onOpenFile) {
      event.preventDefault();
      onOpenFile(fileId);
    }
  };

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const lowerName = file.name.toLowerCase();
    if (
      !lowerName.endsWith('.xlsx') &&
      !lowerName.endsWith('.csv') &&
      !lowerName.endsWith('.xls')
    ) {
      setActionError('Only .xlsx, .xls and .csv files can be uploaded.');
      return;
    }
    setUploading(true);
    setActionError(null);
    try {
      await api.uploadFile(file);
      await refresh();
    } catch (err) {
      // ProductApiError.message is the server's error string verbatim.
      setActionError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  /** "+ New": create a spreadsheet and open it (SharePoint pattern). */
  const handleNew = async () => {
    setCreating(true);
    setActionError(null);
    try {
      const record = await api.createFile('Untitled spreadsheet');
      openFile(record.fileId);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const handleDownload = async (file: UserFileRecord) => {
    setOpenMenuId(null);
    setActionError(null);
    try {
      const url = await api.downloadGrant(file.fileId);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const startRename = (file: UserFileRecord) => {
    setOpenMenuId(null);
    setEditingId(file.fileId);
    setEditName(file.name);
  };

  const handleRename = async (event: React.FormEvent, file: UserFileRecord) => {
    event.preventDefault();
    const name = editName.trim();
    if (!name) return;
    setActionError(null);
    try {
      await api.renameFile(file.fileId, name);
      setEditingId(null);
      await refresh();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const handleDelete = async (file: UserFileRecord) => {
    setOpenMenuId(null);
    if (!window.confirm(`Delete "${file.name}"? This cannot be undone.`)) return;
    setActionError(null);
    try {
      await api.deleteFile(file.fileId);
      await refresh();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const isEmpty = data !== null && data.files.length === 0;
  const identity = settings
    ? savedName ?? settings.profileName ?? settings.profileEmail
    : null;

  return (
    <div className="ics-workspace">
      <header className="ics-ws-header">
        <div className="ics-ws-brand">
          <a className="ics-wordmark-link" href={buildHomeUrl()} aria-label="Icecream Sheets — home">
            <span className="ics-wordmark">
              Icecream <span className="ics-wordmark-accent">Sheets</span>
            </span>
          </a>
          {data && (
            <span className="ics-tier-badge">{data.tier === 'pro' ? 'Pro' : 'Default'}</span>
          )}
          {data && data.tier === 'default' && (
            <span className="ics-meter">
              {data.count} of {data.limits.fileLimit ?? 10} files
            </span>
          )}
          {data && data.tier === 'pro' && <span className="ics-meter">Unlimited files</span>}
        </div>
        <div className="ics-ws-header-actions">
          {settings && (
            <button
              type="button"
              className="ics-icon-btn ics-gear-btn"
              aria-label="Settings"
              title="Settings"
              aria-current={view === 'settings' ? 'page' : undefined}
              onClick={() => setView('settings')}
            >
              <GearIcon />
            </button>
          )}
          {settings && (
            <span
              className="ics-avatar"
              title={identity ?? undefined}
              aria-label={identity ? `Signed in as ${identity}` : 'Signed in'}
            >
              {initialsFor(savedName ?? settings.profileName, settings.profileEmail)}
            </span>
          )}
          {accountSlot}
        </div>
      </header>

      {view === 'settings' && settings ? (
        <main className="ics-ws-main">
          <SettingsPage
            api={api}
            profileEmail={settings.profileEmail}
            profileName={settings.profileName}
            onFirebaseDelete={settings.onFirebaseDelete}
            onSignedOut={settings.onSignedOut}
            onBack={() => setView('files')}
          />
        </main>
      ) : (
        <>
          <div className="ics-ws-commandbar">
            <button
              type="button"
              className="ics-btn ics-btn-primary ics-cmd-btn"
              disabled={creating}
              onClick={() => void handleNew()}
            >
              <span aria-hidden="true" className="ics-cmd-plus">
                +
              </span>
              {creating ? 'Creating…' : 'New'}
            </button>
            <label className="ics-btn ics-cmd-btn" htmlFor="ics-upload-input">
              <UploadIcon />
              {uploading ? 'Uploading…' : 'Upload'}
            </label>
            <input
              ref={fileInputRef}
              id="ics-upload-input"
              className="ics-visually-hidden"
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(event) => void handleUpload(event)}
            />
          </div>

          <main className="ics-ws-main">
            <h1 className="ics-ws-page-title">My files</h1>

            {actionError && (
              <div className="ics-alert" role="alert">
                {actionError}
              </div>
            )}
            {loadError && !data && (
              <div className="ics-alert" role="alert">
                Couldn&rsquo;t load your files: {loadError}{' '}
                <button
                  type="button"
                  className="ics-btn ics-btn-small"
                  onClick={() => void refresh()}
                >
                  Try again
                </button>
              </div>
            )}

            {loading && (
              <p className="ics-loading" aria-busy="true">
                Loading your files…
              </p>
            )}

            {isEmpty && (
              <div className="ics-empty">
                <div className="ics-empty-icon" aria-hidden="true">
                  <FileTypeIcon format="xlsx" />
                </div>
                <h2 className="ics-empty-title">Your workspace is empty</h2>
                <p>
                  Create a spreadsheet, or upload an .xlsx, .xls or .csv file from your computer to
                  get started.
                </p>
                <div className="ics-empty-actions">
                  <button
                    type="button"
                    className="ics-btn ics-btn-primary"
                    disabled={creating}
                    onClick={() => void handleNew()}
                  >
                    + New spreadsheet
                  </button>
                  <button
                    type="button"
                    className="ics-btn"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    Upload a file
                  </button>
                </div>
              </div>
            )}

            {data && !isEmpty && (
              <section aria-label="Files">
                <div className="ics-table-wrap">
                  <table className="ics-table">
                    <thead>
                      <tr>
                        <th scope="col">Name</th>
                        <th scope="col">Modified</th>
                        <th scope="col">Size</th>
                        <th scope="col">
                          <span className="ics-visually-hidden">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.files.map((file) => (
                        <tr key={file.fileId} className="ics-file-row">
                          <td className="ics-file-name-cell">
                            <FileTypeIcon format={file.sourceFormat} />
                            {editingId === file.fileId ? (
                              <form
                                className="ics-rename-form"
                                onSubmit={(event) => void handleRename(event, file)}
                              >
                                <input
                                  className="ics-input"
                                  type="text"
                                  aria-label={`Rename ${file.name}`}
                                  value={editName}
                                  autoFocus
                                  onChange={(event) => setEditName(event.target.value)}
                                />
                                <button type="submit" className="ics-btn ics-btn-small">
                                  Save
                                </button>
                                <button
                                  type="button"
                                  className="ics-btn ics-btn-small"
                                  onClick={() => setEditingId(null)}
                                >
                                  Cancel
                                </button>
                              </form>
                            ) : (
                              <>
                                <a
                                  className="ics-file-link"
                                  href={buildFileUrl(file.fileId)}
                                  onClick={(event) => handleAnchorClick(event, file.fileId)}
                                >
                                  {file.name}
                                </a>
                                <span className="ics-origin-tag">{originLabel(file.origin)}</span>
                                {file.sourceFormat === 'csv' ? (
                                  <span className="ics-source-format-tag">
                                    Imported from CSV
                                  </span>
                                ) : null}
                              </>
                            )}
                          </td>
                          <td className="ics-file-meta">
                            <span title={new Date(file.updatedAt).toLocaleString()}>
                              {formatRelativeTime(file.updatedAt)}
                            </span>
                          </td>
                          <td className="ics-file-meta">{displaySize(file)}</td>
                          <td className="ics-file-menu-cell">
                            <div className="ics-row-menu-wrap">
                              <button
                                type="button"
                                className="ics-icon-btn"
                                aria-haspopup="menu"
                                aria-expanded={openMenuId === file.fileId}
                                aria-label={`Actions for ${file.name}`}
                                onClick={() =>
                                  setOpenMenuId(
                                    openMenuId === file.fileId ? null : file.fileId,
                                  )
                                }
                              >
                                <DotsIcon />
                              </button>
                              {openMenuId === file.fileId && (
                                <div className="ics-row-menu" role="menu">
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => void handleDownload(file)}
                                  >
                                    Download
                                  </button>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => startRename(file)}
                                  >
                                    Rename
                                  </button>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="ics-menu-danger"
                                    onClick={() => void handleDelete(file)}
                                  >
                                    Delete
                                  </button>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="ics-list-footer">
                  {data.count} {data.count === 1 ? 'file' : 'files'}
                  {data.tier === 'default'
                    ? ` · ${data.limits.fileLimit ?? 10} files on the Default plan`
                    : ' · Pro plan'}
                </p>
              </section>
            )}

            {appsSlot != null && (
              <section className="ics-apps" aria-labelledby="ics-apps-title">
                <h2 className="ics-section-title ics-apps-title" id="ics-apps-title">
                  Apps
                </h2>
                {appsSlot}
              </section>
            )}
          </main>
        </>
      )}
    </div>
  );
}
