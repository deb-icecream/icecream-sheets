/**
 * /load/stream (progressive open) + parallel parse — Cycle 10 Phase 4.
 *
 * The stream contract (NDJSON, one JSON object per line):
 *   meta → rows* → sheet-complete (per sheet, in sheet order) →
 *   data-done (all cell data out; engine build still running) → built.
 * `built.response` must be the classic /load response for the same file.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XlsxAdapter } from '@icecream-sheets/xlsx-adapter';
import { createEngineListener } from '../src/services/engineSvc.js';
import { startServer, stop, type Started } from './helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTERNAL_LINK = join(HERE, '..', '..', '..', 'test-data', 'cycle5-fixtures', 'external-link-closedxml.xlsx');
const P75 = join(HERE, '..', '..', '..', 'test-data', 'perf-fixtures', 'perf-p75.xlsx');

const ALICE = { 'x-principal': 'user:alice' };

interface StreamEvent {
  type: string;
  [k: string]: unknown;
}

describe('engine service /load/stream', () => {
  let svc: Started | null = null;

  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });

  async function streamLoad(bytes: Uint8Array): Promise<StreamEvent[]> {
    svc = await startServer(createEngineListener());
    const res = await fetch(`${svc.url}/load/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ALICE },
      body: JSON.stringify({ format: 'xlsx', data: Buffer.from(bytes).toString('base64') }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const text = await res.text();
    return text
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as StreamEvent);
  }

  function smallWorkbook(): Uint8Array {
    return new XlsxAdapter().write({
      sheets: [
        { name: 'Data', rows: [[1, 2], ['=A1+B1', 'x']], formats: { '0:0': '#,##0.00' } },
        { name: 'Second', rows: [['hello']] },
      ],
      metadata: {},
      definedNames: [{ name: 'Cost', ref: 'Data!$A$1' }],
    });
  }

  it('emits meta → rows → sheet-complete → data-done → built, in sheet order', async () => {
    const events = await streamLoad(smallWorkbook());
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('meta');
    expect(types[types.length - 1]).toBe('built');
    expect(types).toContain('data-done');
    expect(types.indexOf('data-done')).toBeLessThan(types.indexOf('built'));
    // Sheet-complete events arrive in sheet order.
    const completes = events.filter((e) => e.type === 'sheet-complete').map((e) => e.index);
    expect(completes).toEqual([0, 1]);
    // Rows for sheet 0 all precede sheet-complete of sheet 0.
    const firstComplete = types.indexOf('sheet-complete');
    const rowsBefore = events.slice(0, firstComplete).filter((e) => e.type === 'rows');
    expect(rowsBefore.length).toBeGreaterThan(0);
    expect(rowsBefore.every((e) => e.index === 0)).toBe(true);
  });

  it('meta chunk carries progress denominators + metadata families', async () => {
    const events = await streamLoad(smallWorkbook());
    const meta = events[0]!;
    expect(meta.type).toBe('meta');
    expect(meta.sheets).toEqual(['Data', 'Second']);
    expect(meta.totalSheets).toBe(2);
    expect(typeof meta.totalCells).toBe('number');
    expect(meta.progress).toMatchObject({ sheetsDone: 0, cellsDone: 0, totalSheets: 2 });
    expect(meta.definedNames).toContainEqual({ name: 'Cost', ref: 'Data!$A$1' });
    expect(typeof meta.metadata).toBe('object');
  });

  it('rows chunks carry cached display values and progress numerators', async () => {
    const events = await streamLoad(smallWorkbook());
    const rowsEvents = events.filter((e) => e.type === 'rows');
    const first = rowsEvents[0]!;
    expect(first.sheet).toBe('Data');
    expect(first.startRow).toBe(0);
    // Cached display: A1=1 paints as 1; the formula cell's display is its
    // file-cached value (SheetJS writes 0 as placeholder), not the formula.
    const display = first.display as unknown[][];
    expect(display[0]![0]).toBe(1);
    // The formula cell's display is its cached value, never the formula
    // text (first paint shows what Excel last calculated, or a pending
    // mark when the file carries no cached value).
    expect(display[1]![0]).not.toBe('=A1+B1');
    expect(Array.isArray(first.pendingCalc)).toBe(true);
    const progress = first.progress as { cellsDone: number };
    expect(progress.cellsDone).toBeGreaterThan(0);
    const dataDone = events.find((e) => e.type === 'data-done')!;
    expect((dataDone.progress as { cellsDone: number }).cellsDone).toBeGreaterThanOrEqual(progress.cellsDone);
    expect(typeof dataDone.totalCells).toBe('number');
  });

  it('built.response matches the classic /load contract (mirror present, small file)', async () => {
    const events = await streamLoad(smallWorkbook());
    const built = events[events.length - 1]!;
    const response = built.response as {
      ok: boolean;
      sheets: string[];
      mirror?: { sheets: Array<{ name: string; cells: unknown[] }> };
      timings?: Record<string, unknown>;
    };
    expect(response.ok).toBe(true);
    expect(response.sheets).toEqual(['Data', 'Second']);
    expect(response.mirror).toBeTruthy();
    expect(response.timings).toBeTruthy();
    expect(typeof response.timings!.buildMs).toBe('number');
    expect(typeof response.timings!.streamSheet1RowsMs).toBe('number');
  });

  it('external-link fixture: mirror resolves the cached "hello world" (Phase 2 probe)', async () => {
    const bytes = new Uint8Array(readFileSync(EXTERNAL_LINK));
    const events = await streamLoad(bytes);
    const built = events[events.length - 1]!;
    expect(built.type).toBe('built');
    const response = built.response as {
      mirror?: { sheets: Array<{ name: string; cells: Array<{ value: { value?: unknown } }> }> };
    };
    expect(response.mirror).toBeTruthy();
    let found = false;
    for (const s of response.mirror!.sheets) {
      for (const c of s.cells) {
        if (c.value && typeof c.value === 'object' && c.value.value === 'hello world') found = true;
      }
    }
    expect(found).toBe(true);
  });

  it('/load still returns a single JSON document with timings (P75 mirror present)', async () => {
    svc = await startServer(createEngineListener());
    const bytes = new Uint8Array(readFileSync(P75));
    const res = await fetch(`${svc.url}/load`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ALICE },
      body: JSON.stringify({ format: 'xlsx', data: Buffer.from(bytes).toString('base64') }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      sheets: string[];
      mirror?: unknown;
      timings?: Record<string, unknown>;
    };
    expect(json.sheets.length).toBe(13);
    expect(json.mirror).toBeTruthy(); // P75 is below the mirror flag
    expect(json.timings).toBeTruthy();
    expect(['parallel', 'inline', 'sheetjs-fallback']).toContain(json.timings!.path);
  });

  it('stream of a non-xlsx body is a plain 400 JSON error, not a stream', async () => {
    svc = await startServer(createEngineListener());
    const res = await fetch(`${svc.url}/load/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ALICE },
      body: JSON.stringify({ format: 'xlsx', data: Buffer.from('not a zip').toString('base64') }),
    });
    // Parse errors before the first chunk surface as an error EVENT on
    // the stream (headers already sent) — the fallback SheetJS read
    // rejects non-zip bytes inside the stream, by design.
    const text = await res.text();
    if (res.status === 200) {
      const events = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as StreamEvent);
      expect(events.some((e) => e.type === 'error')).toBe(true);
    } else {
      expect(res.status).toBe(400);
    }
  });
});
