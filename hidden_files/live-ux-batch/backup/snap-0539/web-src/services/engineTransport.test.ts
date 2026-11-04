/**
 * engineTransport tests (Cycle 10 closure W16): the bounded
 * streamed-cell accumulation in mergeLoadChunks. Below the retain
 * limit the accumulated result carries every pushed cell exactly as
 * before; past it the accumulation is dropped (the host seeds each
 * chunk from the raw chunk itself, so no cell is lost to the view)
 * and a later `built` chunk does not resurrect it.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  mergeLoadChunks,
  STREAMED_CELLS_RETAIN_LIMIT,
  type EngineLoadResult,
  type RawStreamChunk,
} from './engineTransport';

const META: RawStreamChunk = {
  type: 'meta',
  sheets: ['Big'],
  totalSheets: 1,
  totalCells: null,
  metadata: {},
  progress: { sheetsDone: 0, cellsDone: 0, totalSheets: 1, totalCells: null },
};

function rowsChunk(startRow: number, rows: number, cols: number): RawStreamChunk {
  const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 1));
  return {
    type: 'rows',
    sheet: 'Big',
    index: 0,
    startRow,
    rows: grid,
    display: grid,
    formats: { codes: [], columns: {} },
    pendingCalc: [],
    progress: { sheetsDone: 0, cellsDone: 0, totalSheets: 1, totalCells: null },
  };
}

describe('mergeLoadChunks streamed-cell bound (W16)', () => {
  it('retains accumulation below the limit', () => {
    let acc: EngineLoadResult | null = mergeLoadChunks(null, META);
    acc = mergeLoadChunks(acc, rowsChunk(0, 10, 10));
    acc = mergeLoadChunks(acc, rowsChunk(10, 10, 10));
    expect(acc.streamedCells?.['Big']).toHaveLength(200);
  });

  it('drops the accumulation past the limit and never resurrects it', () => {
    const per = 100_000; // 100 rows x 1000 cols per chunk
    const chunksNeeded = Math.floor(STREAMED_CELLS_RETAIN_LIMIT / per) + 1;
    let acc: EngineLoadResult | null = mergeLoadChunks(null, META);
    for (let i = 0; i < chunksNeeded; i++) {
      acc = mergeLoadChunks(acc, rowsChunk(i * 100, 100, 1000));
    }
    expect(acc.streamedCells).toBeUndefined();
    // Later chunks keep it dropped (no re-accumulation).
    acc = mergeLoadChunks(acc, rowsChunk(999_900, 10, 10));
    expect(acc.streamedCells).toBeUndefined();
    // The terminal built payload does not resurrect the accumulation.
    const built = mergeLoadChunks(acc, {
      type: 'built',
      response: {
        ok: true,
        sheets: ['Big'],
        file: { sheets: [{ name: 'Big', formats: { codes: [], columns: {} } }], metadata: {} },
        columnCounts: { Big: [1] },
      },
    });
    expect(built.streamedCells).toBeUndefined();
    expect(built.sheets).toEqual(['Big']);
  });
});

// ---------------------------------------------------------------------------
// Issue #18: the gateway-proxied progressive loader shares the signed
// transport's rule — an engine-reported stream error must surface as a
// load failure, never as the partial/empty accumulation.
// ---------------------------------------------------------------------------
import { GatewayEngineTransport } from './engineTransport';
import { GatewayClient } from './gatewayClient';

describe('EngineTransport progressive load failure (issue #18)', () => {
  it('an error chunk after a meta chunk REJECTS instead of returning the accumulation', async () => {
    const client = new GatewayClient('http://127.0.0.1:8200');
    vi.spyOn(client, 'engineLoadXlsxStream').mockImplementation(async (_b64, onChunk) => {
      onChunk(META as unknown as Record<string, unknown>);
      onChunk({ type: 'error', error: 'failed to parse xlsx: not a readable spreadsheet package' });
      return null;
    });
    const transport = new GatewayEngineTransport(client);
    await expect(transport.loadXlsxProgressive('AAAA', () => {})).rejects.toThrowError(
      /failed to parse xlsx/,
    );
  });
});
