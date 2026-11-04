/**
 * "Open from URL" dialog — fetch an .xlsx/.csv/.tsv/.ods file over HTTP and
 * open it exactly like a local file (same adapter, same format/type/dimension
 * seeding). CORS failures surface a clear error message.
 *
 * A workbook opened from a URL has no save target, so it opens read-only:
 * Save is disabled in the UI and no auto-save runs. The user can still use
 * File > Save As / Download to keep a copy.
 */
import { useState } from 'react';
import A11yDialog from './A11yDialog';

interface OpenFromUrlDialogProps {
  onClose: () => void;
  onOpen: (url: string) => void;
}

export default function OpenFromUrlDialog({ onClose, onOpen }: OpenFromUrlDialogProps) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = url.trim();
    if (!trimmed) {
      setError('Enter a URL.');
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      setError('That does not look like a valid URL.');
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      setError('Only http:// and https:// URLs are supported.');
      return;
    }
    setError(null);
    onOpen(trimmed);
  };

  return (
    <A11yDialog title="Open from URL" width={560} onClose={onClose}>
      <p className="dialog-hint">
        Paste a link to a spreadsheet file (.xlsx, .csv, .tsv, .ods). It opens
        exactly like a local file. The file opens <strong>read-only</strong> —
        use File &gt; Download to keep a copy.
      </p>
      <label className="dialog-field">
        <span>File URL</span>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') onClose();
          }}
          placeholder="https://example.com/workbook.xlsx"
          autoFocus
          style={{ width: '100%' }}
        />
      </label>
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button onClick={onClose}>Cancel</button>
        <button onClick={submit} className="primary">
          Open
        </button>
      </div>
    </A11yDialog>
  );
}
