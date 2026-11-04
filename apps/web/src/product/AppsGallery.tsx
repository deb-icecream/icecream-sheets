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
  duplicateArtifact,
  inferSchema,
  type ArtifactSpec,
  type McpCallFn,
  type MetadataStore,
} from '@icecream-sheets/service';
import { HostArtifactFrame } from '../components/HostArtifactFrame';
import { AppShareDialog } from './AppShareDialog';
import type { AppShareSummary, SharesApi } from './sharesApi';

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
  /**
   * List variant (owner design 2026-10-25, #145 redesign): 'panel' is the
   * chat panel's Apps tab — each item shows its name + a ⋯ menu only,
   * tapping the item opens the app, actions live in the menu. 'workspace'
   * (default) keeps the Workspace Apps section's button row unchanged.
   */
  variant?: 'panel' | 'workspace';
}

type Notice = { kind: 'info' | 'error'; text: string } | null;

const btn: React.CSSProperties = { padding: '4px 10px', fontSize: 12 };
const btnSmall: React.CSSProperties = { padding: '4px 8px', fontSize: 12 };
const menuItem: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '8px 12px',
  fontSize: 13,
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
};

export function AppsGallery({
  store,
  mcpCall,
  onOpen,
  sheets = [],
  sharesApi = null,
  shareLinkBase,
  onStoreChange,
  variant = 'workspace',
}: AppsGalleryProps) {
  const [artifacts, setArtifacts] = useState<ArtifactSpec[]>(() => store.all());
  const [notice, setNotice] = useState<Notice>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [dupId, setDupId] = useState<string | null>(null);
  const [dupTarget, setDupTarget] = useState('');
  const [dupBusy, setDupBusy] = useState(false);
  const [shareSpec, setShareSpec] = useState<ArtifactSpec | null>(null);
  const [myShares, setMyShares] = useState<AppShareSummary[] | null>(null);
  /** Open ⋯ menu (panel variant only); null = no menu open. */
  const [menuId, setMenuId] = useState<string | null>(null);
  /** Viewport position of the open panel menu (see openMenu). */
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  /* Escape closes any open ⋯ menu regardless of focus: after opening a
     menu with the mouse, focus stays on the ⋯ button (outside the menu
     div), so a handler on the menu alone never fires. */
  useEffect(() => {
    if (menuId === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuId]);

  /* A panel menu must not drift from its button: close on any scroll
     or resize while one is open. */
  useEffect(() => {
    if (menuId === null) return;
    const close = (): void => {
      setMenuId(null);
      setMenuPos(null);
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menuId]);

  /**
   * Open a panel ⋯ menu at FIXED viewport coordinates. The gallery lives
   * inside an overflow:auto scroll region, and an absolute menu opening
   * downward from a bottom row is clipped by it (the #145-revoke
   * follow-up proved a share menu rendering only its top 8px). Fixed
   * positioning escapes every ancestor clip; the menu flips above the
   * button when it would overflow the viewport bottom.
   */
  const openMenu = (id: string, itemCount: number, btn: HTMLElement): void => {
    const r = btn.getBoundingClientRect();
    const width = 160;
    const height = itemCount * 31 + 8;
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    const below = r.bottom + 2;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, r.top - height - 2) : below;
    setMenuId(id);
    setMenuPos({ top, left });
  };

  const closeMenu = (): void => {
    setMenuId(null);
    setMenuPos(null);
  };

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

  const revoke = async (shareId: string): Promise<void> => {
    if (!sharesApi) return;
    try {
      await sharesApi.revokeShare(shareId);
      void loadShares();
    } catch (e) {
      setNotice({ kind: 'error', text: `Could not revoke: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  /** Active shares for one app. AppShareSummary carries no artifact id,
      so the match is by app name — the only key the share metadata has. */
  const activeSharesFor = (appName: string): AppShareSummary[] =>
    (myShares ?? []).filter((s) => s.appName === appName && s.revokedAt === null);

  /** Per-app revoke from the item ⋯ menu: revoke every active link for
      that app name, then reload the shared list. */
  const revokeAppShares = async (appName: string): Promise<void> => {
    if (!sharesApi) return;
    try {
      for (const s of activeSharesFor(appName)) {
        await sharesApi.revokeShare(s.shareId);
      }
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
          {variant === 'panel' ? (
            /* #145 redesign: name + ⋯ menu only. Tapping the item opens
               the app; every action lives in the menu. No buttons sit
               below the app name. */
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}>
              <div
                role="button"
                tabIndex={0}
                data-panel-app-item={a.id}
                aria-label={`Open ${a.name}`}
                style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
                onClick={() => onOpen(a.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpen(a.id);
                  }
                }}
              >
                <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {a.name}
                </div>
                <div style={{ fontSize: 11, color: '#888' }}>
                  {a.template} · bound to {a.binding.sheet} · {new Date(a.updatedAt).toLocaleDateString()}
                </div>
              </div>
              <button
                type="button"
                style={{ ...btnSmall, fontSize: 16, lineHeight: 1 }}
                aria-label={`Options for ${a.name}`}
                aria-haspopup="menu"
                aria-expanded={menuId === a.id}
                onClick={(e) => {
                  e.stopPropagation();
                  if (menuId === a.id) {
                    closeMenu();
                  } else {
                    openMenu(
                      a.id,
                      4 + (activeSharesFor(a.name).length > 0 ? 1 : 0),
                      e.currentTarget,
                    );
                  }
                }}
              >
                ⋯
              </button>
              {menuId === a.id && (
                <>
                  <div
                    style={{ position: 'fixed', inset: 0, zIndex: 40 }}
                    aria-hidden="true"
                    onClick={() => closeMenu()}
                  />
                  <div
                    role="menu"
                    aria-label={`Options for ${a.name}`}
                    style={{
                      position: 'fixed',
                      left: menuPos?.left ?? 0,
                      top: menuPos?.top ?? 0,
                      zIndex: 50,
                      background: '#fff',
                      border: '1px solid #ddd',
                      borderRadius: 6,
                      boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
                      padding: 4,
                      minWidth: 160,
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') closeMenu();
                    }}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      style={menuItem}
                      onClick={() => {
                        closeMenu();
                        setShareSpec(a);
                      }}
                    >
                      Share
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      style={menuItem}
                      onClick={() => {
                        closeMenu();
                        setDupId(dupId === a.id ? null : a.id);
                        setDupTarget('');
                      }}
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      style={menuItem}
                      onClick={() => {
                        closeMenu();
                        setPreviewId(previewId === a.id ? null : a.id);
                      }}
                    >
                      Preview
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      style={menuItem}
                      onClick={() => {
                        closeMenu();
                        removeArtifact(a);
                      }}
                    >
                      Delete
                    </button>
                    {activeSharesFor(a.name).length > 0 && (
                      <button
                        type="button"
                        role="menuitem"
                        style={menuItem}
                        onClick={() => {
                          closeMenu();
                          void revokeAppShares(a.name);
                        }}
                      >
                        Revoke share
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          ) : (
            /* Workspace variant (unchanged): the button row. #145 wrap
               fix lives here — the title keeps a 220px basis and the
               buttons flow onto the next line when space is tight. */
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 220px', minWidth: 0 }}>
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
              <button type="button" style={btnSmall} onClick={() => setShareSpec(a)}>
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
          )}

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
                <HostArtifactFrame spec={a} mcpCall={mcpCall} />
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
            <div
              key={s.shareId}
              style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', position: 'relative' }}
            >
              <div style={{ flex: 1, minWidth: 0, fontSize: 12 }}>
                {s.appName} — data from {s.sourceSheet} ({s.rowCount} rows)
                {s.revokedAt !== null && <span style={{ color: '#a00' }}> · revoked</span>}
              </div>
              {s.revokedAt === null &&
                (variant === 'panel' ? (
                  /* #145 revoke: per-app revoke lives in the ⋯ menu, not
                     as a standalone button below the shared entry. */
                  <>
                    <button
                      type="button"
                      style={{ ...btnSmall, fontSize: 16, lineHeight: 1 }}
                      aria-label={`Options for shared app ${s.appName}`}
                      aria-haspopup="menu"
                      aria-expanded={menuId === `share:${s.shareId}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (menuId === `share:${s.shareId}`) {
                          closeMenu();
                        } else {
                          openMenu(`share:${s.shareId}`, 1, e.currentTarget);
                        }
                      }}
                    >
                      ⋯
                    </button>
                    {menuId === `share:${s.shareId}` && (
                      <>
                        <div
                          style={{ position: 'fixed', inset: 0, zIndex: 40 }}
                          aria-hidden="true"
                          onClick={() => closeMenu()}
                        />
                        <div
                          role="menu"
                          aria-label={`Options for shared app ${s.appName}`}
                          style={{
                            position: 'fixed',
                            left: menuPos?.left ?? 0,
                            top: menuPos?.top ?? 0,
                            zIndex: 50,
                            background: '#fff',
                            border: '1px solid #ddd',
                            borderRadius: 6,
                            boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
                            padding: 4,
                            minWidth: 160,
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') closeMenu();
                          }}
                        >
                          <button
                            type="button"
                            role="menuitem"
                            style={menuItem}
                            onClick={() => {
                              closeMenu();
                              void revoke(s.shareId);
                            }}
                          >
                            Revoke share
                          </button>
                        </div>
                      </>
                    )}
                  </>
                ) : (
                  <button type="button" style={btnSmall} onClick={() => void revoke(s.shareId)}>
                    Revoke
                  </button>
                ))}
            </div>
          ))}
        </div>
      )}

      {shareSpec && (
        <AppShareDialog
          spec={shareSpec}
          mcpCall={mcpCall}
          sharesApi={sharesApi}
          shareLinkBase={shareLinkBase}
          onClose={() => {
            setShareSpec(null);
            void loadShares();
          }}
        />
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
      <HostArtifactFrame spec={spec} mcpCall={mcpCall} />
    </div>
  );
}

/** The package type is re-exported for shell wiring convenience. */
export type { AppSharePackage } from '@icecream-sheets/service';
