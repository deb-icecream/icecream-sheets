/**
 * Sheet parse worker (node:worker_threads) — Cycle 10 Phase 4.
 *
 * One task = one worksheet part. The worker receives the sheet's raw XML
 * bytes (transferred) plus the workbook's shared inputs — the shared
 * -string table and the style→format-code table, parsed ONCE on the main
 * thread and shared with every worker (structured clone), never
 * re-parsed per sheet. It runs the exact same `parseWorksheetXml` the
 * main thread runs for a single-sheet workbook (fastSheetParse.ts in
 * @icecream-sheets/xlsx-adapter), so worker and inline results are
 * identical by construction.
 *
 * Protocol (main → worker): {
 *   sheetIndex, xmlBytes: Uint8Array (transferred),
 *   sharedStrings: string[], styleFormatCodes: string[],
 *   display: boolean, streamChunks: boolean }
 * Protocol (worker → main):
 *   { type: 'chunk', sheetIndex, chunk: SheetRowChunk }
 *   { type: 'done',  sheetIndex, result: WorkerSheetResult }
 *   { type: 'error', sheetIndex, error: string }
 * When streamChunks is on and chunking did not break, `result.rows` is
 * null — the rows already travelled as chunks and the main thread
 * assembles from those; on chunkingBroken the full rows ride the done
 * message instead.
 */
import { parentPort } from 'node:worker_threads';
import {
  parseWorksheetXml,
  type FastSheetResult,
  type SheetRowChunk,
} from '@icecream-sheets/xlsx-adapter';

export interface SheetParseTask {
  sheetIndex: number;
  xmlBytes: Uint8Array;
  sharedStrings: string[];
  styleFormatCodes: string[];
  display: boolean;
  streamChunks: boolean;
}

export type WorkerSheetResult = Omit<FastSheetResult, 'rows' | 'displayRows'> & {
  rows: FastSheetResult['rows'] | null;
  displayRows: FastSheetResult['displayRows'];
};

if (!parentPort) throw new Error('sheetParseWorker must run as a worker thread');
const port = parentPort;

port.on('message', (task: SheetParseTask) => {
  const { sheetIndex } = task;
  try {
    const xml = new TextDecoder().decode(task.xmlBytes);
    const chunks: SheetRowChunk[] = [];
    const result = parseWorksheetXml(xml, task.sharedStrings, task.styleFormatCodes, {
      display: task.display,
      onChunk: task.streamChunks
        ? (chunk) => {
            port.postMessage({ type: 'chunk', sheetIndex, chunk });
          }
        : undefined,
    });
    void chunks;
    const streamed = task.streamChunks && !result.chunkingBroken;
    const out: WorkerSheetResult = {
      ...result,
      rows: streamed ? null : result.rows,
      displayRows: streamed ? null : result.displayRows,
    };
    port.postMessage({ type: 'done', sheetIndex, result: out });
  } catch (e) {
    port.postMessage({
      type: 'error',
      sheetIndex,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});
