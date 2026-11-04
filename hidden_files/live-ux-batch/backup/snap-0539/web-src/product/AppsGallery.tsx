/**
 * Generated-apps gallery (idea-app-gallery).
 *
 * ONE gallery component, two homes: the Workspace "Apps" section (its
 * primary home — the app shell passes it as the Workspace's appsSlot)
 * and the chat surface's Apps tab (ArtifactLibrary renders it under
 * the generate box). Entries come ONLY from the real artifact store —
 * apps the chat actually generated; an empty store is an honest empty
 * state, nothing is seeded.
 *
 * Per entry: name, bound sheet, a working LIVE PREVIEW (the app itself
 * running in its sandboxed frame, scaled into the card), and three
 * one-step actions:
 * - Reopen: opens the app embedded, bound to its sheet, two-way sync.
 * - Duplicate: pick the sheet to bind the copy to; the copy's reads
 *   and writes go to the NEW sheet only — the original is untouched.
 * - Share (user-confirmed design 2026-10-21): sharing shares the app
 *   WITH its data. The dialog names the specific sheet and its size
 *   and requires an explicit confirm; the recipient (signed in) gets
 *   their own bound copies. Credentials never travel — the share
 *   package is app + materialized cell data only, validated
 *   server-side. "Shared by you" below lists the caller's links with
 *   per-link revoke.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  createAppSharePackage,
  duplicateArtifact,
  inferSchema,
  type AppSharePackage,
  type ArtifactSpec,
  type McpCallFn,
  type MetadataStore,
} from '@icecream-sheets/service';
import { ArtifactFrame } from '../components/ArtifactHost';
import { buildShareLink, type AppShareSummary, type SharesApi } from './sharesApi';

export interface AppsGalleryProps {
  store: MetadataStore<ArtifactSpec>;
  mcpCall: McpCallFn | null;
  onOpen: (id: string) => void;
  /** Known sheet names for the duplicate picker (datalist). */
  sheets?: string[];
  /** Share backend; absent → Share explains that sign-in is required. */
  sharesApi?: SharesApi | null;
  /** Base URL share links are built on. Default: this app's URL. */
  shareLinkBase?: string;
  /** Called after the gallery itself adds/removes a store entry. */
  onStoreChange?: () => void;
}

type Notice = { kind: 'info' | 'error'; text: string } | null;

interface ShareDraft {
  spec: ArtifactSpec;
  rows: number;
  cols: number;
  cells: unknown[][] | null;
  link: string | null;
  busy: boolean;
}

const btn: React.CSSProperties = { padding: '4px 10px', fontSize: 12 };
const btnSmall: React.CSSProperties = { padding: '4px 8px', fontSize: 12 };

export function AppsGallery({
  store,
  mcpCall,
  onOpen,
  sheets = [],
  sharesApi = null,
  shareLinkBase,
  onStoreChange,
}: AppsGalleryProps) {
  const [artifacts, setArtifacts] = useState<ArtifactSpec[]>(() => store.all());
  const [notice, setNotice] = useState<Notice>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [dupId, setDupId] = useState<string | null>(null);
  const [dupTarget, setDupTarget] = useState('');
  const [dupBusy, setDupBusy] = useState(false);
  const [shareDraft, setShareDraft] = useState<ShareDraft | null>(null);
  const [myShares, setMyShares] = useState<AppShareSummary[] | null>(null);

  const refresh = useCallback((): void => setArtifacts(store.all()), [store]);

  const loadShares = useCallback(async (): Promise<void> => {
    if (!sharesApi) return;
    try {
      setMyShares(await sharesApi.listMyShares());
    } catch {
      setMyShares([]);
    }
  }, [sharesApi]);

  useEffect(() => {
    void loadShares();
  }, [loadShares]);

  const linkBase =
    shareLinkBase ??
    (typeof window !== 'undefined' ? window.location.origin + window.location.pathname : '');

  const removeArtifact = (a: ArtifactSpec): void => {
    if (!window.confirm(`Delete the app "${a.name}"? This cannot be undone.`)) return;
    store.remove((x) => x.id === a.id);
    refresh();
    onStoreChange?.();
  };

  const runDuplicate = async (a: ArtifactSpec): Promise<void> => {
    const target = dupTarget.trim();
    if (!target || dupBusy) return;
    if (!mcpCall) {
      setNotice({ kind: 'error', text: 'Duplicate needs the local engine to read the target sheet.' });
      return;
    }
    setDupBusy(true);
    setNotice(null);
    try {
      const res = (await mcpCall('get_results', { sheet: target })) as { cells?: unknown[][] };
      const cells = Array.isArray(res?.cells) ? res.cells : [];
      if (cells.length === 0) {
        setNotice({
          kind: 'error',
          text: `Sheet "${target}" is empty or does not exist — there is nothing to bind the copy to.`,
        });
        return;
      }
      const schema = inferSchema(cells);
      const copy = duplicateArtifact(a, {
        sheet: target,
        ...schema.binding,
        columns: schema.columns,
      });
      store.add(copy);
      refresh();
      onStoreChange?.();
      setDupId(null);
      setDupTarget('');
      setNotice({ kind: 'info', text: `Created "${copy.name}", bound to ${target}.` });
    } catch (e) {
      setNotice({ kind: 'error', text: `Could not duplicate: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setDupBusy(false);
    }
  };

  const openShare = async (a: ArtifactSpec): Promise<void> => {
    setNotice(null);
    let cells: unknown[][] | null = null;
    if (mcpCall) {
      try {
        const res = (await mcpCall('get_results', { sheet: a.binding.sheet })) as {
          cells?: unknown[][];
        };
        cells = Array.isArray(res?.cells) ? res.cells : null;
      } catch {
        cells = null;
      }
    }
    const rows = cells
      ? a.binding.hasHeaderRow
        ? Math.max(0, cells.length - 1)
        : cells.length
      : a.binding.endRow - a.binding.startRow + (a.binding.hasHeaderRow ? 0 : 1);
    const cols = cells
      ? cells.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0)
      : a.binding.columns.length;
    setShareDraft({ spec: a, rows, cols, cells, link: null, busy: false });
  };

  const confirmShare = async (): Promise<void> => {
    if (!shareDraft || shareDraft.busy || !sharesApi) return;
    if (!shareDraft.cells) {
      setNotice({ kind: 'error', text: 'Could not read the sheet data to share — try again with the workbook open.' });
      return;
    }
    setShareDraft({ ...shareDraft, busy: true });
    try {
      const pkg: AppSharePackage = createAppSharePackage(shareDraft.spec, shareDraft.cells);
      const created = await sharesApi.createShare(pkg);
      setShareDraft({ ...shareDraft, busy: false, link: buildShareLink(linkBase, created.shareId) });
      void loadShares();
    } catch (e) {
      setShareDraft({ ...shareDraft, busy: false });
      setNotice({ kind: 'error', text: `Could not share: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const revoke = async (shareId: string): Promise<void> => {
    if (!sharesApi) return;
    try {
      await sharesApi.revokeShare(shareId);
      void loadShares();
    } catch (e) {
      setNotice({ kind: 'error', text: `Could not revoke: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  return (
    <div className="apps-gallery" aria-label="Generated apps gallery">
      {notice && (
        <div
          role="status"
          style={{
            margin: '8px 10px',
            padding: 8,
            borderRadius: 4,
            fontSize: 12,
            background: notice.kind === 'error' ? '#fee' : '#eef4ff',
            color: notice.kind === 'error' ? '#a00' : '#244',
            border: `1px solid ${notice.kind === 'error' ? '#eaa' : '#bcd'}`,
          }}
        >
          {notice.text}
        </div>
      )}

      {artifacts.length === 0 && (
        <div style={{ padding: '0 10px 12px', fontSize: 12, color: '#888' }}>
          No apps yet. Apps the chat generates are saved here and in your workspace, re-openable
          any time.
        </div>
      )}

      {artifacts.map((a) => (
        <div key={a.id} style={{ borderTop: '1px solid #f0f0f0', padding: '8px 10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {a.name}
              </div>
              <div style={{ fontSize: 11, color: '#888' }}>
                {a.template} · bound to {a.binding.sheet} · {new Date(a.updatedAt).toLocaleDateString()}
              </div>
            </div>
            <button type="button" style={btn} onClick={() => onOpen(a.id)}>
              Reopen
            </button>
            <button
              type="button"
              style={btnSmall}
              aria-expanded={previewId === a.id}
              onClick={() => setPreviewId(previewId === a.id ? null : a.id)}
            >
              Preview
            </button>
            <button
              type="button"
              style={btnSmall}
              onClick={() => {
                setDupId(dupId === a.id ? null : a.id);
                setDupTarget('');
              }}
            >
              Duplicate
            </button>
            <button type="button" style={btnSmall} onClick={() => void openShare(a)}>
              Share
            </button>
            <button
              type="button"
              style={btnSmall}
              onClick={() => removeArtifact(a)}
              title="Delete app"
              aria-label={`Delete ${a.name}`}
            >
              ✕
            </button>
          </div>

          {previewId === a.id && (
            <div
              data-gallery-preview={a.id}
              style={{
                height: 180,
                overflow: 'hidden',
                border: '1px solid #e0e0e0',
                borderRadius: 4,
                marginTop: 8,
                background: '#fff',
              }}
            >
              <div
                style={{
                  width: '200%',
                  height: 360,
                  transform: 'scale(0.5)',
                  transformOrigin: 'top left',
                  pointerEvents: 'none',
                }}
              >
                <ArtifactFrame spec={a} mcpCall={mcpCall} />
              </div>
            </div>
          )}

          {dupId === a.id && (
            <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
              <input
                value={dupTarget}
                onChange={(e) => setDupTarget(e.target.value)}
                placeholder="Bind the copy to which sheet?"
                aria-label={`Sheet to bind the copy of ${a.name} to`}
                list="apps-gallery-sheets"
                style={{ flex: 1, padding: '6px 8px', border: '1px solid #ccc', borderRadius: 4, fontSize: 13 }}
              />
              <datalist id="apps-gallery-sheets">
                {sheets.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
              <button
                type="button"
                style={btn}
                disabled={dupBusy || !dupTarget.trim()}
                onClick={() => void runDuplicate(a)}
              >
                {dupBusy ? '…' : 'Create copy'}
              </button>
            </div>
          )}
        </div>
      ))}

      {sharesApi && myShares !== null && myShares.length > 0 && (
        <div style={{ borderTop: '1px solid #e0e0e0', padding: '8px 10px' }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Shared by you</div>
          {myShares.map((s) => (
            <div key={s.shareId} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
              <div style={{ flex: 1, minWidth: 0, fontSize: 12 }}>
                {s.appName} — data from {s.sourceSheet} ({s.rowCount} rows)
                {s.revokedAt !== null && <span style={{ color: '#a00' }}> · revoked</span>}
              </div>
              {s.revokedAt === null && (
                <button type="button" style={btnSmall} onClick={() => void revoke(s.shareId)}>
                  Revoke
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {shareDraft && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Share ${shareDraft.spec.name}`}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 300,
          }}
        >
          <div style={{ background: '#fff', borderRadius: 8, padding: 16, width: 420, maxWidth: '92vw' }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
              Share “{shareDraft.spec.name}”
            </div>
            {!sharesApi ? (
              <div style={{ fontSize: 13, color: '#444' }}>
                <p style={{ margin: '0 0 8px' }}>
                  Sharing this app also shares its data source: the sheet{' '}
                  <strong>{shareDraft.spec.binding.sheet}</strong> ({shareDraft.rows} rows ×{' '}
                  {shareDraft.cols} columns) will be copied to anyone signed in who opens the link,
                  together with the app. They get their own copies — your original app and data are
                  never exposed to their edits. Connection details and credentials are never
                  shared.
                </p>
                <p style={{ margin: 0 }}>
                  Sharing needs you to be signed in to the workspace — share links are created
                  under your account so you can revoke them later.
                </p>
              </div>
            ) : shareDraft.link ? (
              <div>
                <div style={{ fontSize: 13, color: '#444', marginBottom: 8 }}>
                  Link created. Anyone signed in who opens it gets their own copy of the app and
                  its data — your original stays yours.
                </div>
                <input
                  readOnly
                  value={shareDraft.link}
                  aria-label="Share link"
                  style={{ width: '100%', padding: '6px 8px', border: '1px solid #ccc', borderRadius: 4, fontSize: 12 }}
                  onFocus={(e) => e.target.select()}
                />
              </div>
            ) : (
              <div style={{ fontSize: 13, color: '#444' }}>
                Sharing this app also shares its data source: the sheet{' '}
                <strong>{shareDraft.spec.binding.sheet}</strong> ({shareDraft.rows} rows ×{' '}
                {shareDraft.cols} columns) will be copied to anyone signed in who opens the link,
                together with the app. They get their own copies — your original app and data are
                never exposed to their edits. Connection details and credentials are never shared.
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
              <button type="button" style={btn} onClick={() => setShareDraft(null)}>
                {shareDraft.link ? 'Done' : 'Cancel'}
              </button>
              {sharesApi && !shareDraft.link && (
                <button
                  type="button"
                  style={{ ...btn, background: '#2b6cb0', color: '#fff', border: '1px solid #2b6cb0', borderRadius: 4 }}
                  disabled={shareDraft.busy}
                  onClick={() => void confirmShare()}
                >
                  {shareDraft.busy ? '…' : 'Share app + data'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Recipient landing: full-screen app, Restore → working view          */
/* ------------------------------------------------------------------ */

export interface SharedAppLandingProps {
  /** The recipient's own materialized app copy (bound to their data copy). */
  spec: ArtifactSpec;
  mcpCall: McpCallFn | null;
  /**
   * Restore: leave the full-screen view for the working view — the data
   * copy as a spreadsheet in the grid, this app in the chat area, the
   * grid taking the rest of the screen (the shell owns that layout).
   */
  onRestore: () => void;
}

export function SharedAppLanding({ spec, mcpCall, onRestore }: SharedAppLandingProps) {
  return (
    <div
      data-shared-app-landing={spec.id}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 250,
        background: '#fff',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderBottom: '1px solid #e0e0e0',
          background: '#f7f9fc',
        }}
      >
        <div style={{ flex: 1, fontSize: 13 }}>
          <strong>{spec.name}</strong>{' '}
          <span style={{ color: '#666' }}>— shared with you, running on your own copy of the data</span>
        </div>
        <button type="button" style={btn} onClick={onRestore} aria-label="Restore to working view">
          ⤢ Restore
        </button>
      </div>
      <ArtifactFrame spec={spec} mcpCall={mcpCall} />
    </div>
  );
}

/** The package type is re-exported for shell wiring convenience. */
export type { AppSharePackage };
