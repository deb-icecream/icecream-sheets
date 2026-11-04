/**
 * Download dialog (File > Download, Cycle 7 per-name download filtering).
 *
 * Scope options:
 * - "Whole workbook" — the existing behavior: every sheet, permission-
 *   filtered (design-docs/workbook-protection-and-encryption.md §6).
 * - "Named range" — a dropdown of the workbook's defined names; the
 *   download is a NEW single-sheet workbook containing only that range's
 *   data, rebased to A1, on a sheet named after the defined name. Dangling
 *   names (#REF!) are listed but not selectable.
 *
 * Permissions (fail closed): the parent resolves the chosen name through
 * the name store's resolveForSubject() before building bytes — a denied
 * name blocks the download entirely, and cells hidden from the subject are
 * dropped from the file (never leaked as blanks).
 */
import { useState } from 'react';
import A11yDialog from './A11yDialog';

/** Download scope chosen in the dialog. */
export type DownloadScope = { kind: 'workbook' } | { kind: 'namedRange'; nameId: string };

/** One defined name as shown in the scope dropdown. */
export interface DownloadNameOption {
  /** Stable name-store id. */
  id: string;
  /** Display name as typed by the user. */
  name: string;
  /** 'Workbook' or 'Sheet: <sheet>'. */
  scopeLabel: string;
  /** 'Sheet1!A1:B10' — or '#REF!' when dangling. */
  refLabel: string;
  /** True when the name no longer refers to any cells (#REF!). */
  dangling: boolean;
}

export interface DownloadDialogProps {
  names: DownloadNameOption[];
  /** Current save format extension for the hint text, e.g. 'xlsx'. */
  formatExt: string;
  onDownload: (scope: DownloadScope) => void;
  onClose: () => void;
}

export function DownloadDialog({ names, formatExt, onDownload, onClose }: DownloadDialogProps) {
  const usable = names.filter((n) => !n.dangling);
  const [scope, setScope] = useState<'workbook' | 'namedRange'>('workbook');
  const [nameId, setNameId] = useState<string>(usable[0]?.id ?? '');

  const namedSelected = scope === 'namedRange';
  const canDownloadNamed = namedSelected && nameId !== '' && usable.some((n) => n.id === nameId);

  const download = () => {
    if (namedSelected) {
      if (!canDownloadNamed) return;
      onDownload({ kind: 'namedRange', nameId });
    } else {
      onDownload({ kind: 'workbook' });
    }
  };

  return (
    <A11yDialog title={<>Download</>} width={460} onClose={onClose}>
      <div style={{ padding: 14, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div role="radiogroup" aria-label="Download scope" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
            <input
              type="radio"
              name="download-scope"
              checked={scope === 'workbook'}
              onChange={() => setScope('workbook')}
            />
            <span>
              <strong>Whole workbook</strong>
              <div style={{ color: '#666', fontSize: 12 }}>
                Every sheet, as a .{formatExt} file. Cells you can&apos;t read are left out.
              </div>
            </span>
          </label>
          <label
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'flex-start',
              cursor: names.length === 0 ? 'not-allowed' : 'pointer',
              opacity: names.length === 0 ? 0.55 : 1,
            }}
          >
            <input
              type="radio"
              name="download-scope"
              checked={scope === 'namedRange'}
              disabled={names.length === 0}
              onChange={() => setScope('namedRange')}
            />
            <span style={{ flex: 1 }}>
              <strong>Named range</strong>
              <div style={{ color: '#666', fontSize: 12 }}>
                {names.length === 0
                  ? 'No defined names in this workbook yet (Formulas > Define Name…).'
                  : `A new single-sheet .${formatExt} file with only this range's data, starting at A1.`}
              </div>
              {names.length > 0 && (
                <select
                  aria-label="Defined name"
                  value={nameId}
                  disabled={scope !== 'namedRange'}
                  onChange={(e) => setNameId(e.target.value)}
                  style={{ marginTop: 6, width: '100%', padding: '4px 6px' }}
                >
                  {names.map((n) => (
                    <option key={n.id} value={n.id} disabled={n.dangling}>
                      {n.name} — {n.scopeLabel} · {n.refLabel}
                      {n.dangling ? ' (#REF!, unavailable)' : ''}
                    </option>
                  ))}
                </select>
              )}
            </span>
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={download} disabled={namedSelected && !canDownloadNamed} autoFocus>
            Download
          </button>
        </div>
      </div>
    </A11yDialog>
  );
}
