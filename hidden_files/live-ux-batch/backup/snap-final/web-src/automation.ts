/**
 * Macro recorder wiring for the web UI.
 *
 * A module-singleton ActionRecorder captures representative user actions
 * (cell writes, formulas, sheet adds, recalculation, row/column
 * insert/delete, sorts, formats) as an ActionLog. The Macros dialog
 * renders the log as editable TypeScript via actionLogToScript().
 *
 * Recorded actions replay through the same permissioned automation API as
 * hand-written scripts, so a recording can never do what a script cannot.
 */
import {
  ActionRecorder,
  actionLogToScript,
  type ActionLog,
  type AutomationAction,
  type AutomationCellFormat,
} from '@icecream-sheets/service';
import type { CellFormat } from './features/formatting';

export const macroRecorder = new ActionRecorder();

type RecordingListener = () => void;
const recordingListeners = new Set<RecordingListener>();

function emitRecordingChange(): void {
  for (const listener of [...recordingListeners]) {
    try {
      listener();
    } catch {
      // A failing listener must not break recording.
    }
  }
}

/** Subscribe to recording start/stop; returns an unsubscribe function. */
export function onMacroRecordingChange(listener: RecordingListener): () => void {
  recordingListeners.add(listener);
  return () => {
    recordingListeners.delete(listener);
  };
}

export function isMacroRecording(): boolean {
  return macroRecorder.isRecording();
}

export function startMacroRecording(name?: string): void {
  macroRecorder.start(name ?? 'Recorded macro');
  emitRecordingChange();
}

/** Stop recording and return the finished log (null when not recording). */
export function stopMacroRecording(): ActionLog | null {
  if (!macroRecorder.isRecording()) return null;
  const log = macroRecorder.stop();
  emitRecordingChange();
  return log;
}

export function cancelMacroRecording(): void {
  macroRecorder.cancel();
  emitRecordingChange();
}

/** Record one user action; no-ops when the recorder is idle. */
export function recordAction(action: AutomationAction): void {
  macroRecorder.record(action);
}

/** Render a finished log as editable TypeScript. */
export function renderMacroScript(log: ActionLog): string {
  return actionLogToScript(log);
}

/**
 * Map the web UI's CellFormat to the automation API's format subset.
 * Only fields the API models are carried; the rest are UI-only.
 */
export function toAutomationFormat(format: Partial<CellFormat>): AutomationCellFormat {
  const out: AutomationCellFormat = {};
  if (format.bold !== undefined) out.bold = format.bold;
  if (format.italic !== undefined) out.italic = format.italic;
  if (format.fontSize !== undefined) out.fontSize = format.fontSize;
  if (format.fontColor !== undefined) out.fontColor = format.fontColor;
  if (format.fillColor !== undefined) out.fillColor = format.fillColor;
  if (format.numberFormat !== undefined) out.numberFormat = String(format.numberFormat);
  return out;
}
