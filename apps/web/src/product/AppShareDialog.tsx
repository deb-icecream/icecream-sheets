/**
 * Share dialog for a generated app (extracted from AppsGallery so the
 * same flow serves both the gallery's ⋯ menu and the opened app's
 * header Share button).
 *
 * User-confirmed design 2026-10-21: sharing shares the app WITH its
 * data. The dialog names the specific sheet and its size and requires
 * an explicit confirm; the recipient (signed in) gets their own bound
 * copies. Credentials never travel — the share package is app +
 * materialized cell data only, validated server-side.
 */
import { useEffect, useState } from 'react';
import {
  createAppSharePackage,
  type ArtifactSpec,
  type McpCallFn,
} from '@icecream-sheets/service';
import { buildShareLink, type SharesApi } from './sharesApi';

const btn: React.CSSProperties = { padding: '4px 10px', fontSize: 12 };

export interface AppShareDialogProps {
  spec: ArtifactSpec;
  mcpCall: McpCallFn | null;
  sharesApi?: SharesApi | null;
  /** Base URL share links are built on. Default: this app's URL. */
  shareLinkBase?: string;
  onClose: () => void;
}

export function AppShareDialog({ spec, mcpCall, sharesApi = null, shareLinkBase, onClose }: AppShareDialogProps) {
  const [cells, setCells] = useState<unknown[][] | null>(null);
  const [cellsTried, setCellsTried] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (!mcpCall) {
      setCellsTried(true);
      return;
    }
    void (async () => {
      try {
        const res = (await mcpCall('get_results', { sheet: spec.binding.sheet })) as {
          cells?: unknown[][];
        };
        if (alive) setCells(Array.isArray(res?.cells) ? res.cells : null);
      } catch {
        if (alive) setCells(null);
      } finally {
        if (alive) setCellsTried(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [mcpCall, spec.binding.sheet]);

  const linkBase =
    shareLinkBase ??
    (typeof window !== 'undefined' ? window.location.origin + window.location.pathname : '');

  const rows = cells
    ? spec.binding.hasHeaderRow
      ? Math.max(0, cells.length - 1)
      : cells.length
    : spec.binding.endRow - spec.binding.startRow + (spec.binding.hasHeaderRow ? 0 : 1);
  const cols = cells
    ? cells.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0)
    : spec.binding.columns.length;

  const confirmShare = async (): Promise<void> => {
    if (busy || !sharesApi) return;
    if (!cells) {
      setError('Could not read the sheet data to share — try again with the workbook open.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const pkg = createAppSharePackage(spec, cells);
      const created = await sharesApi.createShare(pkg);
      setLink(buildShareLink(linkBase, created.shareId));
    } catch (e) {
      setError(`Could not share: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Share ${spec.name}`}
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
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Share “{spec.name}”</div>
        {error && (
          <div
            role="status"
            style={{
              marginBottom: 8,
              padding: 8,
              borderRadius: 4,
              fontSize: 12,
              background: '#fee',
              color: '#a00',
              border: '1px solid #eaa',
            }}
          >
            {error}
          </div>
        )}
        {!sharesApi ? (
          <div style={{ fontSize: 13, color: '#444' }}>
            <p style={{ margin: '0 0 8px' }}>
              Sharing this app also shares its data source: the sheet <strong>{spec.binding.sheet}</strong>{' '}
              ({rows} rows × {cols} columns) will be copied to anyone signed in who opens the link,
              together with the app. They get their own copies — your original app and data are
              never exposed to their edits. Connection details and credentials are never shared.
            </p>
            <p style={{ margin: 0 }}>
              Sharing needs you to be signed in to the workspace — share links are created under
              your account so you can revoke them later.
            </p>
          </div>
        ) : link ? (
          <div>
            <div style={{ fontSize: 13, color: '#444', marginBottom: 8 }}>
              Link created. Anyone signed in who opens it gets their own copy of the app and its
              data — your original stays yours.
            </div>
            <input
              readOnly
              value={link}
              aria-label="Share link"
              style={{ width: '100%', padding: '6px 8px', border: '1px solid #ccc', borderRadius: 4, fontSize: 12 }}
              onFocus={(e) => e.target.select()}
            />
          </div>
        ) : (
          <div style={{ fontSize: 13, color: '#444' }}>
            Sharing this app also shares its data source: the sheet <strong>{spec.binding.sheet}</strong>{' '}
            ({rows} rows × {cols} columns) will be copied to anyone signed in who opens the link,
            together with the app. They get their own copies — your original app and data are
            never exposed to their edits. Connection details and credentials are never shared.
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button type="button" style={btn} onClick={onClose}>
            {link ? 'Done' : 'Cancel'}
          </button>
          {sharesApi && !link && (
            <button
              type="button"
              style={{ ...btn, background: '#2b6cb0', color: '#fff', border: '1px solid #2b6cb0', borderRadius: 4 }}
              disabled={busy || !cellsTried}
              onClick={() => void confirmShare()}
            >
              {busy ? '…' : 'Share app + data'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
