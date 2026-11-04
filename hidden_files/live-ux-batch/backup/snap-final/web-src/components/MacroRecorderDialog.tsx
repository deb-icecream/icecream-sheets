/**
 * Macros dialog: record user actions and show the generated script.
 *
 * While recording, the dialog shows a live action count. Stopping the
 * recording renders the ActionLog as editable TypeScript (via the
 * automation lane's script generator) with Copy and Download actions.
 * The script uses only the permissioned automation API and carries its
 * declared permissions, so it can be saved as a trigger or run anywhere
 * scripts run.
 */
import { useEffect, useState } from 'react';
import {
  cancelMacroRecording,
  isMacroRecording,
  macroRecorder,
  renderMacroScript,
  startMacroRecording,
  stopMacroRecording,
} from '../automation';
import A11yDialog from './A11yDialog';
import type { ActionLog } from '@icecream-sheets/service';

interface Props {
  onClose: () => void;
}

export default function MacroRecorderDialog({ onClose }: Props) {
  const [recording, setRecording] = useState(isMacroRecording());
  const [actionCount, setActionCount] = useState(macroRecorder.actionCount());
  const [log, setLog] = useState<ActionLog | null>(null);
  const [copied, setCopied] = useState(false);

  // Live action count while recording.
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setActionCount(macroRecorder.actionCount()), 500);
    return () => clearInterval(timer);
  }, [recording]);

  const start = () => {
    setLog(null);
    setCopied(false);
    startMacroRecording();
    setRecording(true);
    setActionCount(0);
  };

  const stop = () => {
    const finished = stopMacroRecording();
    setRecording(false);
    setLog(finished);
  };

  const cancel = () => {
    cancelMacroRecording();
    setRecording(false);
    setLog(null);
    onClose();
  };

  const script = log ? renderMacroScript(log) : '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(script);
    } catch {
      // Clipboard API unavailable (permissions, non-secure context):
      // fall back to a selection the user can copy manually.
      const ta = document.getElementById('macro-script-text') as HTMLTextAreaElement | null;
      ta?.select();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const download = () => {
    const blob = new Blob([script], { type: 'text/typescript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(log?.name ?? 'macro').replace(/[^a-z0-9-_]+/gi, '-').toLowerCase()}.ts`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <A11yDialog title={<>Macros</>} width={640} onClose={onClose}>
        <p style={{ fontSize: 13, color: '#555', marginTop: 0 }}>
          Record your actions as an editable TypeScript script. The script runs
          through the permissioned automation API — every call is authorized,
          exactly like a hand-written script.
        </p>

        {!recording && !log && (
          <button onClick={start} style={{ marginBottom: 12 }}>
            ● Start recording
          </button>
        )}
        {recording && (
          <div style={{ marginBottom: 12 }}>
            <span style={{ color: '#c00', fontWeight: 'bold' }}>● Recording…</span>{' '}
            <span style={{ fontSize: 13 }}>{actionCount} action{actionCount === 1 ? '' : 's'} captured</span>
            <div style={{ marginTop: 8 }}>
              <button onClick={stop} style={{ marginRight: 8 }}>
                Stop and show script
              </button>
              <button onClick={cancel}>Cancel</button>
            </div>
          </div>
        )}
        {!recording && log && (
          <div>
            <div style={{ fontSize: 13, marginBottom: 8 }}>
              <strong>{log.name}</strong> — {log.actions.length} action
              {log.actions.length === 1 ? '' : 's'} recorded.
            </div>
            <textarea
              id="macro-script-text"
              readOnly
              value={script}
              spellCheck={false}
              style={{
                width: '100%',
                height: 320,
                fontFamily: 'monospace',
                fontSize: 12,
                whiteSpace: 'pre',
              }}
            />
            <div style={{ marginTop: 8 }}>
              <button onClick={copy} style={{ marginRight: 8 }}>
                {copied ? 'Copied!' : 'Copy script'}
              </button>
              <button onClick={download} style={{ marginRight: 8 }}>
                Download .ts
              </button>
              <button onClick={start}>Record again</button>
            </div>
            <p style={{ fontSize: 12, color: '#666' }}>
              Actions the engine cannot execute yet (formatting, row/column
              insert/delete, sort/filter, named ranges) are recorded and
              authorized, but replay reports them as unsupported rather than
              silently skipping them.
            </p>
          </div>
        )}

        <div style={{ marginTop: 16, textAlign: 'right' }}>
          <button onClick={onClose}>Close</button>
        </div>
      </A11yDialog>
  );
}
