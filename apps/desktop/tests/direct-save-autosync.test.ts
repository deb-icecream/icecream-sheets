/**
 * Addendum 3 + 4 + 5 tests (worker D): continuous batch checkpointing,
 * destination learning, flush confirmation, manual-save skip, the save
 * pin (Addendum 4), the SavePinOverflow IPC retry, batch materialization
 * semantics, and the structural-op barrier (Addendum 5).
 *
 * Scheduler tests use injected fakes (serializeFn / verifyFn) exactly
 * like C's direct-save tests; two tests run the REAL shared serializer
 * to pin batch materialization (one regeneration per dirty sheet) and
 * the pinned readback path end to end.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EngineHost,
  EngineWorkbook,
  SavePinOverflowError,
  type EngineCommand,
  type EngineHost as EngineHostType,
} from '@icecream-sheets/engine';
import {
  assembleBulkReadbackPinned,
  checkpointBatchNote,
  clearAutosaveTarget,
  clearDesktopSaveOps,
  configureDesktopCheckpoints,
  flushCheckpointBeforeStructuralOp,
  flushDesktopCheckpoint,
  getAutosaveTarget,
  getDesktopSaveOps,
  getLiveRevision,
  getPendingSaveOps,
  getStorageRevision,
  isSavePinOverflowError,
  isStructuralBarrierOp,
  noteDesktopLoadForAutosave,
  noteDesktopSaveOp,
  getPendingSessionExtras,
  getSaveStatus,
  getSessionExtrasVersion,
  isSessionExtrasDirty,
  recordAutosaveTarget,
  resetDesktopCheckpointState,
  resolveAutosaveSettleMs,
  savePinHostOf,
  serializeDesktopWorkbook,
  setPendingSessionExtras,
  shouldSkipCheckpointCurrentSave,
  type DesktopSaveExtras,
  type SerializeLiveWorkbookResult,
} from '../src/direct-save.js';
import { resetDesktopSaveBase } from '../src/engine-load.js';
import {
  dispatchDesktopEditWithSavePinRetry,
  registerEngineIpc,
  type EngineIpcMain,
} from '../src/engine-ipc.js';

function fakeResult(
  mode: 'verbatim' | 'adapter-fallback' = 'verbatim',
  changedSheets: string[] = [],
): SerializeLiveWorkbookResult {
  return {
    mode,
    bytes: 3,
    changedSheets,
    verbatimParts: 0,
    regeneratedParts: [],
    droppedParts: [],
    serializeMs: 0,
  };
}

interface FakeSerialize {
  fn: (
    host: EngineHostType,
    extras: DesktopSaveExtras,
    outPath: string,
  ) => Promise<SerializeLiveWorkbookResult>;
  calls: Array<{ outPath: string; coveredBefore: number }>;
}

/** A serializeFn fake: writes a marker file so the atomic rename has a temp to move. */
function makeFakeSerialize(
  onCall?: (callIndex: number) => void,
  resultFor?: (coveredBefore: number) => SerializeLiveWorkbookResult,
): FakeSerialize {
  const calls: FakeSerialize['calls'] = [];
  const fn = async (
    _host: EngineHostType,
    _extras: DesktopSaveExtras,
    outPath: string,
  ): Promise<SerializeLiveWorkbookResult> => {
    const coveredBefore = getStorageRevision();
    calls.push({ outPath, coveredBefore });
    onCall?.(calls.length - 1);
    writeFileSync(outPath, `batch-${calls.length}`);
    return resultFor ? resultFor(coveredBefore) : fakeResult();
  };
  return { fn, calls };
}

const stubHost = {} as unknown as EngineHostType;
const okVerify = () => ({ ok: true });

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

let dir = '';
let dest = '';

beforeEach(() => {
  resetDesktopCheckpointState();
  clearDesktopSaveOps();
  resetDesktopSaveBase();
  dir = mkdtempSync(join(tmpdir(), 'icecream-autosync-test-'));
  dest = join(dir, 'book.xlsx');
});

afterEach(() => {
  resetDesktopCheckpointState();
  clearDesktopSaveOps();
  resetDesktopSaveBase();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

function configure(
  serialize: FakeSerialize,
  extra: { settleMs?: number; maxPendingOps?: number; log?: (m: string) => void } = {},
): void {
  configureDesktopCheckpoints({
    getHost: () => stubHost,
    settleMs: extra.settleMs ?? 60_000,
    maxPendingOps: extra.maxPendingOps,
    serializeFn: serialize.fn,
    verifyFn: okVerify,
    log: extra.log,
  });
}

describe('autosync — checkpoint scheduler (Addendum 3)', () => {
  it('splits the journal at the cut: ops journaled during an in-flight checkpoint flush in the NEXT batch', async () => {
    const serialize = makeFakeSerialize((callIndex) => {
      if (callIndex === 0) {
        // An edit lands while checkpoint #1 is serializing: it is past
        // the cut and must NOT be counted as covered by this checkpoint.
        noteDesktopSaveOp({ cmd: 'setCell', ref: { sheet: 'S', row: 2, col: 0 } });
      }
    });
    configure(serialize);
    recordAutosaveTarget(dest);
    noteDesktopSaveOp({ cmd: 'setCell', ref: { sheet: 'S', row: 0, col: 0 } });
    noteDesktopSaveOp({ cmd: 'setCell', ref: { sheet: 'S', row: 1, col: 0 } });

    const first = await flushDesktopCheckpoint('test');
    expect(serialize.calls).toHaveLength(1);
    expect(first.flushedOps).toBe(2);
    expect(first.storageRevision).toBe(2);
    expect(first.liveRevision).toBe(3);
    expect(first.caughtUp).toBe(false);
    expect(getPendingSaveOps()).toBe(1);
    expect(readFileSync(dest, 'utf8')).toBe('batch-1');

    const second = await flushDesktopCheckpoint('test');
    expect(serialize.calls).toHaveLength(2);
    expect(second.flushedOps).toBe(1);
    expect(second.storageRevision).toBe(3);
    expect(second.caughtUp).toBe(true);
    expect(readFileSync(dest, 'utf8')).toBe('batch-2');
  });

  it('flush when caught up performs NO serialization', async () => {
    const serialize = makeFakeSerialize();
    configure(serialize);
    recordAutosaveTarget(dest);
    noteDesktopSaveOp({ cmd: 'setCell' });
    const first = await flushDesktopCheckpoint('test');
    expect(first.caughtUp).toBe(true);
    expect(serialize.calls).toHaveLength(1);
    const again = await flushDesktopCheckpoint('test');
    expect(again).toEqual({
      storageRevision: 1,
      liveRevision: 1,
      caughtUp: true,
      flushedOps: 0,
    });
    expect(serialize.calls).toHaveLength(1);
  });

  it('no known destination → no writes at all (flush + settle timer)', async () => {
    const serialize = makeFakeSerialize();
    configure(serialize, { settleMs: 15 });
    noteDesktopSaveOp({ cmd: 'setCell' });
    noteDesktopSaveOp({ cmd: 'setCell' });
    const res = await flushDesktopCheckpoint('test');
    expect(res.flushedOps).toBe(0);
    expect(res.caughtUp).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(serialize.calls).toHaveLength(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('settle timer batches ops after the last journaled op', async () => {
    const serialize = makeFakeSerialize();
    configure(serialize, { settleMs: 25 });
    recordAutosaveTarget(dest);
    noteDesktopSaveOp({ cmd: 'setCell' });
    noteDesktopSaveOp({ cmd: 'setCell' });
    await waitFor(() => serialize.calls.length === 1);
    expect(getStorageRevision()).toBe(2);
    expect(existsSync(dest)).toBe(true);
  });

  it('op cap forces a flush without waiting for the settle timer', async () => {
    const serialize = makeFakeSerialize();
    configure(serialize, { settleMs: 60_000, maxPendingOps: 3 });
    recordAutosaveTarget(dest);
    noteDesktopSaveOp({ cmd: 'setCell' });
    noteDesktopSaveOp({ cmd: 'setCell' });
    expect(serialize.calls).toHaveLength(0);
    noteDesktopSaveOp({ cmd: 'setCell' });
    // The cap fires the flush synchronously from the journal hook; wait
    // for the checkpoint to actually cover the batch (serialize call
    // alone races the verify/rename microtasks behind it).
    await waitFor(() => getStorageRevision() === 3);
    expect(serialize.calls).toHaveLength(1);
  });
});

describe('autosync — destination learning + settle env (Addendum 3)', () => {
  it('learns the target from absolute load paths, clears it for bare names', () => {
    noteDesktopLoadForAutosave('/Users/deb/Books/ledger.xlsx');
    expect(getAutosaveTarget()).toBe('/Users/deb/Books/ledger.xlsx');
    noteDesktopLoadForAutosave('ledger.xlsx');
    expect(getAutosaveTarget()).toBeNull();
    recordAutosaveTarget(dest);
    expect(getAutosaveTarget()).toBe(dest);
    clearAutosaveTarget();
    expect(getAutosaveTarget()).toBeNull();
  });

  it('resolveAutosaveSettleMs: env override, default, invalid fallbacks', () => {
    expect(resolveAutosaveSettleMs({})).toBe(1500);
    expect(resolveAutosaveSettleMs({ ICECREAM_AUTOSAVE_SETTLE_MS: '250' })).toBe(250);
    expect(resolveAutosaveSettleMs({ ICECREAM_AUTOSAVE_SETTLE_MS: 'abc' })).toBe(1500);
    expect(resolveAutosaveSettleMs({ ICECREAM_AUTOSAVE_SETTLE_MS: '0' })).toBe(1500);
    expect(resolveAutosaveSettleMs({ ICECREAM_AUTOSAVE_SETTLE_MS: '-5' })).toBe(1500);
    expect(resolveAutosaveSettleMs({ ICECREAM_AUTOSAVE_SETTLE_MS: '' })).toBe(1500);
  });
});

describe('autosync — manual-save skip when checkpoint-current (Addendum 3)', () => {
  it('skips only for an in-place save to the caught-up target that still exists', async () => {
    const serialize = makeFakeSerialize();
    configure(serialize);
    recordAutosaveTarget(dest);
    noteDesktopSaveOp({ cmd: 'setCell' });
    await flushDesktopCheckpoint('test');
    expect(existsSync(dest)).toBe(true);

    expect(
      shouldSkipCheckpointCurrentSave({ suggestedPath: dest, destPath: dest, destExists: true }),
    ).toBe(true);
    // A new pending op defeats the skip.
    noteDesktopSaveOp({ cmd: 'setCell' });
    expect(
      shouldSkipCheckpointCurrentSave({ suggestedPath: dest, destPath: dest, destExists: true }),
    ).toBe(false);
    await flushDesktopCheckpoint('test');
    // External delete defeats the skip.
    expect(
      shouldSkipCheckpointCurrentSave({ suggestedPath: dest, destPath: dest, destExists: false }),
    ).toBe(false);
    // Dialog Save As (no suggested path) never skips.
    expect(
      shouldSkipCheckpointCurrentSave({ suggestedPath: undefined, destPath: dest, destExists: true }),
    ).toBe(false);
    // A different destination never skips.
    expect(
      shouldSkipCheckpointCurrentSave({
        suggestedPath: dest,
        destPath: join(dir, 'other.xlsx'),
        destExists: true,
      }),
    ).toBe(false);
  });
});

describe('batch materialization semantics (Addendum 5.1)', () => {
  it('multi-op batch: final value per cell written once, one serialization, journal NOT collapsed', async () => {
    // Fake live state the serializer materializes from at the cut.
    const state = new Map<string, unknown>();
    const changedSheetsSeen: string[][] = [];
    const serialize = makeFakeSerialize(undefined, (coveredBefore) => {
      // The serializer derives dirty sheets from the journal slice —
      // deduplicated: one regeneration per dirty sheet per batch.
      const slice = getDesktopSaveOps().slice(coveredBefore);
      const changed = [...new Set(slice.map((op) => op.ref?.sheet).filter(Boolean))] as string[];
      changedSheetsSeen.push(changed);
      return fakeResult('verbatim', changed);
    });
    // Wrap the fake so each call writes the materialized state snapshot.
    const materializing = async (
      host: EngineHostType,
      extras: DesktopSaveExtras,
      outPath: string,
    ): Promise<SerializeLiveWorkbookResult> => {
      const res = await serialize.fn(host, extras, outPath);
      writeFileSync(outPath, JSON.stringify(Object.fromEntries(state)));
      return res;
    };
    configureDesktopCheckpoints({
      getHost: () => stubHost,
      settleMs: 60_000,
      serializeFn: materializing,
      verifyFn: okVerify,
    });
    recordAutosaveTarget(dest);

    // Three ops touch Sheet1!A1 in one batch (values 1 → 2 → 3), one
    // touches Sheet2.
    const edit = (sheet: string, row: number, col: number, value: unknown) => {
      state.set(`${sheet}!${row}:${col}`, value);
      noteDesktopSaveOp({ cmd: 'setCell', ref: { sheet, row, col } });
    };
    edit('Sheet1', 0, 0, 1);
    edit('Sheet1', 0, 0, 2);
    edit('Sheet1', 0, 0, 3);
    edit('Sheet2', 1, 1, 9);

    const res = await flushDesktopCheckpoint('test');
    expect(res.flushedOps).toBe(4);
    expect(serialize.calls).toHaveLength(1);
    // Sheet1 appears exactly once in the batch's regenerated set.
    expect(changedSheetsSeen).toEqual([['Sheet1', 'Sheet2']]);
    // The materialized file holds the FINAL value per cell, once.
    const written = JSON.parse(readFileSync(dest, 'utf8')) as Record<string, unknown>;
    expect(written).toEqual({ 'Sheet1!0:0': 3, 'Sheet2!1:1': 9 });
    // Only materialization collapses: the journal keeps every op.
    expect(getDesktopSaveOps()).toHaveLength(4);
    expect(getLiveRevision()).toBe(4);
    expect(getStorageRevision()).toBe(4);
  });

  it(
    'REAL serializer: 3 ops on one sheet regenerate that sheet exactly once; file holds final values',
    { timeout: 60_000 },
    async () => {
      const host = new EngineHost(
        new EngineWorkbook({ Sheet1: [[0, 0], [0, 0]] }),
      );
      const set = (row: number, col: number, value: number) => {
        const r = host.execute({
          cmd: 'setCell',
          ref: { sheet: 'Sheet1', row, col },
          value,
        });
        expect(r.ok).toBe(true);
        noteDesktopSaveOp({ cmd: 'setCell', ref: { sheet: 'Sheet1', row, col } });
      };
      set(0, 0, 5);
      set(0, 0, 42);
      set(1, 1, 7);
      const out = join(dir, 'real.xlsx');
      const result = await serializeDesktopWorkbook(host, {}, out);
      expect(result.changedSheets).toEqual(['Sheet1']);
      const { XlsxAdapter } = await import('@icecream-sheets/xlsx-adapter');
      const data = new XlsxAdapter().read(new Uint8Array(readFileSync(out)));
      const sheet = data.sheets.find((s) => s.name === 'Sheet1');
      expect(sheet!.rows[0]![0]).toBe(42);
      expect(sheet!.rows[1]![1]).toBe(7);
    },
  );
});

describe('save pin assembly (Addendum 4)', () => {
  function makePinHost(events: string[], opts: { failOnSheet?: string } = {}) {
    const pin = { id: 'pin-1', rev: 7 };
    const host = {
      sheetNames: () => ['S1', 'S2'],
      getDefinedNames: () => [],
      bulkReadback: () => {
        throw new Error('bulkReadback must not be used when the pin API exists');
      },
      beginSavePin: () => {
        events.push('begin');
        return pin;
      },
      bulkReadbackSheetPinned: (_p: unknown, sheet: string) => {
        events.push(`read:${sheet}`);
        if (opts.failOnSheet === sheet) throw new Error(`read failed on ${sheet}`);
        return [
          {
            ref: { sheet, row: 0, col: 0 },
            input: sheet === 'S1' ? 1 : 2,
            value: { kind: 'number', value: sheet === 'S1' ? 1 : 2 },
          },
        ];
      },
      savePinStashCells: () => 4,
      releaseSavePin: () => {
        events.push('release');
      },
    };
    return host as unknown as EngineHostType;
  }

  it('assembles sheet-by-sheet under the pin, yields between sheets, releases after assembly', async () => {
    const events: string[] = [];
    const host = makePinHost(events);
    expect(savePinHostOf(host)).not.toBeNull();
    // A setImmediate queued BEFORE assembly can only run between sheet
    // reads if assembly yields to the event loop between sheets.
    setImmediate(() => events.push('tick'));
    const assembly = await assembleBulkReadbackPinned(host, ['S1', 'S2']);
    expect(assembly.pinUsed).toBe(true);
    expect(assembly.pinRev).toBe(7);
    expect(assembly.stashCells).toBe(4);
    expect(assembly.bulk.map((c) => c.ref.sheet)).toEqual(['S1', 'S2']);
    expect(events).toEqual(['begin', 'read:S1', 'tick', 'read:S2', 'release']);
  });

  it('releases the pin when a pinned read throws', async () => {
    const events: string[] = [];
    const host = makePinHost(events, { failOnSheet: 'S2' });
    await expect(assembleBulkReadbackPinned(host, ['S1', 'S2'])).rejects.toThrow(
      'read failed on S2',
    );
    expect(events.filter((e) => e === 'release')).toHaveLength(1);
  });

  it('falls back to bulkReadback when the host has no pin API', async () => {
    const cell = {
      ref: { sheet: 'S1', row: 0, col: 0 },
      input: 9,
      value: { kind: 'number', value: 9 },
    };
    const host = { bulkReadback: () => [cell] } as unknown as EngineHostType;
    expect(savePinHostOf(host)).toBeNull();
    const assembly = await assembleBulkReadbackPinned(host, ['S1']);
    expect(assembly.pinUsed).toBe(false);
    expect(assembly.bulk).toEqual([cell]);
  });

  it(
    'serializeDesktopWorkbook reads through the pin when present (bulkReadback never called)',
    { timeout: 60_000 },
    async () => {
      const events: string[] = [];
      const host = makePinHost(events);
      const out = join(dir, 'pinned.xlsx');
      const result = await serializeDesktopWorkbook(host, {}, out);
      expect(result.bytes).toBeGreaterThan(0);
      expect(events).toEqual(['begin', 'read:S1', 'read:S2', 'release']);
      const { XlsxAdapter } = await import('@icecream-sheets/xlsx-adapter');
      const data = new XlsxAdapter().read(new Uint8Array(readFileSync(out)));
      expect(data.sheets.find((s) => s.name === 'S1')!.rows[0]![0]).toBe(1);
      expect(data.sheets.find((s) => s.name === 'S2')!.rows[0]![0]).toBe(2);
    },
  );

  it('isSavePinOverflowError matches by error name only', () => {
    const e = new Error('stash cap exceeded');
    e.name = 'SavePinOverflowError';
    expect(isSavePinOverflowError(e)).toBe(true);
    expect(isSavePinOverflowError(new Error('SavePinOverflowError happened'))).toBe(false);
    expect(isSavePinOverflowError(null)).toBe(false);
    expect(isSavePinOverflowError('SavePinOverflowError')).toBe(false);
  });
});

describe('SavePinOverflow IPC retry (Addendum 4)', () => {
  function overflowError(): Error {
    const e = new Error('op cannot be stashed while a save pin is active');
    e.name = 'SavePinOverflowError';
    return e;
  }

  it('queues behind the pin and retries until the execute succeeds', async () => {
    let attempts = 0;
    const logs: string[] = [];
    const host = {
      execute: () => {
        attempts++;
        if (attempts < 3) throw overflowError();
        return { ok: true };
      },
    } as unknown as EngineHostType;
    const { result } = await dispatchDesktopEditWithSavePinRetry(
      host,
      { cmd: 'addSheet', name: 'X' } as unknown as EngineCommand,
      { pollMs: 1, timeoutMs: 5000, log: (m) => logs.push(m) },
    );
    expect(result.ok).toBe(true);
    expect(attempts).toBe(3);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('queued behind an active save pin');
  });

  it('surfaces the overflow after the 30 s-class timeout instead of losing the op silently', async () => {
    let attempts = 0;
    const host = {
      execute: () => {
        attempts++;
        throw overflowError();
      },
    } as unknown as EngineHostType;
    await expect(
      dispatchDesktopEditWithSavePinRetry(
        host,
        { cmd: 'addSheet', name: 'X' } as unknown as EngineCommand,
        { pollMs: 5, timeoutMs: 40, log: () => undefined },
      ),
    ).rejects.toMatchObject({ name: 'SavePinOverflowError' });
    expect(attempts).toBeGreaterThan(1);
  });

  it('does not retry non-overflow errors', async () => {
    let attempts = 0;
    const host = {
      execute: () => {
        attempts++;
        throw new Error('boom');
      },
    } as unknown as EngineHostType;
    await expect(
      dispatchDesktopEditWithSavePinRetry(
        host,
        { cmd: 'addSheet', name: 'X' } as unknown as EngineCommand,
        { pollMs: 1, timeoutMs: 5000 },
      ),
    ).rejects.toThrow('boom');
    expect(attempts).toBe(1);
  });
});

describe('save pin — REAL engine host (worker E API landed, Addendum 4)', () => {
  it(
    'serializeDesktopWorkbook pins the real host and writes the pinned state',
    { timeout: 60_000 },
    async () => {
      const host = new EngineHost(
        new EngineWorkbook({ Sheet1: [[1, 2], [3, 4]], Data: [[9]] }),
      );
      const logs: string[] = [];
      const out = join(dir, 'real-pin.xlsx');
      const result = await serializeDesktopWorkbook(host, {}, out, (m) => logs.push(m));
      expect(result.bytes).toBeGreaterThan(0);
      // The pin path (not the bulkReadback fallback) actually ran.
      expect(logs.some((l) => l.includes('save pin rev'))).toBe(true);
      const { XlsxAdapter } = await import('@icecream-sheets/xlsx-adapter');
      const data = new XlsxAdapter().read(new Uint8Array(readFileSync(out)));
      expect(data.sheets.find((s) => s.name === 'Sheet1')!.rows[0]).toEqual([1, 2]);
      expect(data.sheets.find((s) => s.name === 'Data')!.rows[0]).toEqual([9]);
    },
  );

  it('CoW stash: a setCell during the pin is stashed; the pinned readback still returns pin-time state', () => {
    const host = new EngineHost(new EngineWorkbook({ Sheet1: [[1]] }));
    const pin = host.beginSavePin();
    try {
      const r = host.execute({
        cmd: 'setCell',
        ref: { sheet: 'Sheet1', row: 0, col: 0 },
        value: 99,
      });
      expect(r.ok).toBe(true);
      expect(host.savePinStashCells(pin)).toBe(1);
      const pinned = host.bulkReadbackSheetPinned(pin, 'Sheet1');
      expect(pinned).toHaveLength(1);
      expect(pinned[0]!.input).toBe(1);
    } finally {
      host.releaseSavePin(pin);
    }
    // The stashed edit is live after release.
    expect(host.bulkReadback()[0]!.input).toBe(99);
  });

  it('structural execute throws the real SavePinOverflowError while pinned (op NOT applied); the IPC retry applies it after release', async () => {
    const host = new EngineHost(new EngineWorkbook({ Sheet1: [[1]] }));
    const pin = host.beginSavePin();
    let thrown: unknown;
    try {
      host.execute({ cmd: 'addSheet', name: 'Nope' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SavePinOverflowError);
    expect(isSavePinOverflowError(thrown)).toBe(true);
    expect(host.sheetNames()).not.toContain('Nope');

    const retrying = dispatchDesktopEditWithSavePinRetry(
      host,
      { cmd: 'addSheet', name: 'Later' } as unknown as EngineCommand,
      { pollMs: 10, timeoutMs: 5000, log: () => undefined },
    );
    await new Promise((r) => setTimeout(r, 40));
    host.releaseSavePin(pin);
    const { result } = await retrying;
    expect(result.ok).toBe(true);
    expect(host.sheetNames()).toContain('Later');
  });
});

describe('autosave ownership + strict no-op + extras sync (Addendum 6)', () => {
  it('strict no-op: a caught-up flush check performs ZERO writes (mtime + bytes unchanged, no temp file, counter moves)', async () => {
    const serialize = makeFakeSerialize();
    configure(serialize);
    recordAutosaveTarget(dest);
    noteDesktopSaveOp({ cmd: 'setCell' });
    await flushDesktopCheckpoint('test');
    expect(getSaveStatus().flushes).toBe(1);
    const before = {
      mtimeMs: statSync(dest).mtimeMs,
      bytes: readFileSync(dest),
    };
    const res = await flushDesktopCheckpoint('settle-timer');
    expect(res.flushedOps).toBe(0);
    expect(res.caughtUp).toBe(true);
    expect(serialize.calls).toHaveLength(1);
    // Destination untouched — same mtime, same bytes — and no temp
    // file was ever created in the destination directory.
    expect(statSync(dest).mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(dest)).toEqual(before.bytes);
    expect(readdirSync(dir)).toEqual(['book.xlsx']);
    const status = getSaveStatus();
    expect(status.noopSkips).toBe(1);
    expect(status.flushes).toBe(1);
    // And again: still a no-op, counter keeps counting checks.
    await flushDesktopCheckpoint('renderer-flush');
    expect(getSaveStatus().noopSkips).toBe(2);
    expect(serialize.calls).toHaveLength(1);
    expect(readdirSync(dir)).toEqual(['book.xlsx']);
  });

  it('extras: dirty only on an actual payload change (key order is not a change)', () => {
    expect(isSessionExtrasDirty()).toBe(false);
    // #103 baselining: the first sync after a reset/load IS the loaded
    // state, not a change — it baselines (clean), so a pristine quit
    // no longer fires the guard on first-sync dirt.
    setPendingSessionExtras({ extraMetadata: { a: 1 }, sheetDims: { S: { colWidths: { '0': 9 } } } });
    expect(isSessionExtrasDirty()).toBe(false);
    const v = getSessionExtrasVersion();
    // Same content, shuffled key order: NOT a change.
    setPendingSessionExtras({ sheetDims: { S: { colWidths: { '0': 9 } } }, extraMetadata: { a: 1 } });
    expect(getSessionExtrasVersion()).toBe(v);
    expect(getPendingSessionExtras()).toEqual({
      extraMetadata: { a: 1 },
      sheetDims: { S: { colWidths: { '0': 9 } } },
    });
    // A real change bumps the version exactly once and marks dirt.
    setPendingSessionExtras({ extraMetadata: { a: 2 } });
    expect(getSessionExtrasVersion()).toBe(v + 1);
    expect(isSessionExtrasDirty()).toBe(true);
  });

  it('extras-dirty forces a write even at equal revisions; the flush consumes the extras and the scheduler passes them through', async () => {
    const seenExtras: DesktopSaveExtras[] = [];
    const serialize = makeFakeSerialize();
    const capturing = async (
      host: EngineHostType,
      extras: DesktopSaveExtras,
      outPath: string,
    ): Promise<SerializeLiveWorkbookResult> => {
      seenExtras.push(extras);
      return serialize.fn(host, extras, outPath);
    };
    configureDesktopCheckpoints({
      getHost: () => stubHost,
      settleMs: 60_000,
      serializeFn: capturing,
      verifyFn: okVerify,
    });
    recordAutosaveTarget(dest);
    noteDesktopSaveOp({ cmd: 'setCell' });
    await flushDesktopCheckpoint('test');
    expect(getSaveStatus()).toMatchObject({ storageRevision: 1, liveRevision: 1, extrasDirty: false });

    // Revisions are caught up, but the extras changed → NOT a no-op.
    setPendingSessionExtras({ extraMetadata: { theme: 'dark' } });
    expect(isSessionExtrasDirty()).toBe(true);
    // The manual-save skip must also refuse while extras are dirty.
    expect(
      shouldSkipCheckpointCurrentSave({ suggestedPath: dest, destPath: dest, destExists: true }),
    ).toBe(false);
    const res = await flushDesktopCheckpoint('test');
    expect(serialize.calls).toHaveLength(2);
    expect(res.caughtUp).toBe(true);
    expect(seenExtras[1]).toEqual({ extraMetadata: { theme: 'dark' } });
    expect(isSessionExtrasDirty()).toBe(false);
    expect(getSaveStatus().flushes).toBe(2);
  });

  it('an extras change arms the settle scheduler on its own (main owns the flush decision)', async () => {
    const serialize = makeFakeSerialize();
    configure(serialize, { settleMs: 25 });
    recordAutosaveTarget(dest);
    noteDesktopSaveOp({ cmd: 'setCell' });
    await waitFor(() => getStorageRevision() === 1);
    expect(serialize.calls).toHaveLength(1);
    setPendingSessionExtras({ sheetStyles: { S: { '0:0': { bold: true } } } });
    await waitFor(() => serialize.calls.length === 2);
    expect(isSessionExtrasDirty()).toBe(false);
  });

  it(
    'serializeDesktopWorkbook consumes the pending extras when the caller passes none',
    { timeout: 60_000 },
    async () => {
      const host = new EngineHost(new EngineWorkbook({ Sheet1: [[1]] }));
      setPendingSessionExtras({
        definedNames: [{ name: 'ExtraName', ref: 'Sheet1!$A$1' }],
      });
      const out = join(dir, 'extras.xlsx');
      const result = await serializeDesktopWorkbook(host, undefined, out);
      expect(result.bytes).toBeGreaterThan(0);
      const { XlsxAdapter } = await import('@icecream-sheets/xlsx-adapter');
      const data = new XlsxAdapter().read(new Uint8Array(readFileSync(out)));
      expect((data.definedNames ?? []).some((d) => d.name === 'ExtraName')).toBe(true);
      // Consumed by the serialize (the manual-save path clears the flag
      // via consumeSerializedSessionExtras after the write verifies).
      expect(getSessionExtrasVersion()).toBe(1);
    },
  );

  it('saveStatus reports revisions, extras flag, and counters together', async () => {
    const serialize = makeFakeSerialize();
    configure(serialize);
    recordAutosaveTarget(dest);
    expect(getSaveStatus()).toEqual({
      liveRevision: 0,
      storageRevision: 0,
      extrasDirty: false,
      flushes: 0,
      noopSkips: 0,
      targetPath: dest,
      pendingOps: 0,
    });
    noteDesktopSaveOp({ cmd: 'setCell' });
    expect(getSaveStatus()).toMatchObject({ liveRevision: 1, storageRevision: 0, pendingOps: 1 });
    await flushDesktopCheckpoint('test');
    expect(getSaveStatus()).toMatchObject({ liveRevision: 1, storageRevision: 1, flushes: 1, pendingOps: 0 });
  });
});

describe('structural-op barrier (Addendum 5.2)', () => {
  it('classifies ops exactly like the gateway (cell / name / structural)', () => {
    for (const cmd of ['addSheet', 'deleteSheet', 'renameSheet', 'duplicateSheet', 'moveSheet', 'insertRows', 'deleteRows', 'insertCols', 'deleteCols', 'setCalculationMode']) {
      expect(isStructuralBarrierOp(cmd), cmd).toBe(true);
    }
    for (const cmd of ['setCell', 'setFormula', 'defineName', 'deleteName', 'renameName', 'updateNameRefersTo', 'defineFunction', 'updateFunction', 'rollbackFunction', 'deleteFunction', 'recalculate', 'bogusOp']) {
      expect(isStructuralBarrierOp(cmd), cmd).toBe(false);
    }
  });

  it('classifies batches: row/col structural keeps verbatim shape; sheet-set / calc-mode carry a fallback reason', () => {
    expect(checkpointBatchNote([{ cmd: 'setCell' }, { cmd: 'defineName' }])).toEqual({
      structural: false,
      rowColStructural: false,
      fallbackReason: null,
    });
    expect(checkpointBatchNote([{ cmd: 'insertRows' }])).toEqual({
      structural: true,
      rowColStructural: true,
      fallbackReason: null,
    });
    expect(checkpointBatchNote([{ cmd: 'addSheet' }]).fallbackReason).toBe('sheet-set-change');
    expect(checkpointBatchNote([{ cmd: 'setCalculationMode' }]).fallbackReason).toBe(
      'calculation-mode-change',
    );
    const mixed = checkpointBatchNote([{ cmd: 'insertCols' }, { cmd: 'renameSheet' }]);
    expect(mixed.rowColStructural).toBe(true);
    expect(mixed.fallbackReason).toBe('sheet-set-change');
  });

  it('flushes the pending batch BEFORE the structural op; the structural op starts a fresh batch', async () => {
    const serialize = makeFakeSerialize();
    configure(serialize);
    recordAutosaveTarget(dest);
    noteDesktopSaveOp({ cmd: 'setCell' });
    noteDesktopSaveOp({ cmd: 'setFormula' });

    const barred = await flushCheckpointBeforeStructuralOp('addSheet');
    expect(barred).toBe(true);
    expect(serialize.calls).toHaveLength(1);
    expect(getStorageRevision()).toBe(2);

    // The structural op itself is journaled into the NEXT batch.
    noteDesktopSaveOp({ cmd: 'addSheet' });
    expect(getPendingSaveOps()).toBe(1);

    // Name-family ops never trigger the barrier.
    expect(await flushCheckpointBeforeStructuralOp('defineName')).toBe(false);
    expect(serialize.calls).toHaveLength(1);
    // Cell ops never trigger it either.
    expect(await flushCheckpointBeforeStructuralOp('setCell')).toBe(false);
    // A structural op DOES flush the batch that now contains addSheet.
    expect(await flushCheckpointBeforeStructuralOp('deleteSheet')).toBe(true);
    expect(serialize.calls).toHaveLength(2);
    expect(getPendingSaveOps()).toBe(0);
    // Nothing pending → no barrier, no serialization.
    expect(await flushCheckpointBeforeStructuralOp('addSheet')).toBe(false);
    expect(serialize.calls).toHaveLength(2);
  });

  it('surfaces the adapter-fallback reason in the checkpoint log for sheet-set and calc-mode batches', async () => {
    const logs: string[] = [];
    // Fake serializer mirroring the shared planner: sheet-set /
    // calc-mode batches materialize via adapter-fallback.
    const serialize = makeFakeSerialize(undefined, (coveredBefore) => {
      const slice = getDesktopSaveOps().slice(coveredBefore);
      const fallback = slice.some(
        (op) => op.cmd === 'addSheet' || op.cmd === 'setCalculationMode',
      );
      return fakeResult(fallback ? 'adapter-fallback' : 'verbatim');
    });
    configure(serialize, { log: (m) => logs.push(m) });
    recordAutosaveTarget(dest);

    noteDesktopSaveOp({ cmd: 'addSheet' });
    await flushDesktopCheckpoint('test');
    expect(logs.some((l) => l.includes('mode=adapter-fallback') && l.includes('fallbackReason=sheet-set-change'))).toBe(true);

    logs.length = 0;
    noteDesktopSaveOp({ cmd: 'setCalculationMode' });
    await flushDesktopCheckpoint('test');
    expect(logs.some((l) => l.includes('mode=adapter-fallback') && l.includes('fallbackReason=calculation-mode-change'))).toBe(true);

    logs.length = 0;
    noteDesktopSaveOp({ cmd: 'insertRows', ref: { sheet: 'S', row: 0, col: 0 } });
    await flushDesktopCheckpoint('test');
    expect(logs.some((l) => l.includes('mode=verbatim') && l.includes('rowColStructural=all-sheets-regen'))).toBe(true);
  });

  it('IPC execute path: the barrier checkpoint runs before the structural op is applied', async () => {
    const order: string[] = [];
    const serialize = makeFakeSerialize(() => order.push('checkpoint'));
    configure(serialize);
    recordAutosaveTarget(dest);
    noteDesktopSaveOp({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 } });

    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
    const ipcMain: EngineIpcMain = {
      handle: (channel, handler) => handlers.set(channel, handler),
    };
    const host = {
      execute: (cmd: EngineCommand) => {
        order.push(`execute:${cmd.cmd}`);
        return { ok: true };
      },
    } as unknown as EngineHostType;
    registerEngineIpc(ipcMain, {
      getHost: () => host,
      swapWorkbook: () => undefined,
      resetWorkbook: () => undefined,
      applyProtection: () => undefined,
    });
    const execute = handlers.get('engine:execute')!;
    const res = (await execute({}, { cmd: 'addSheet', name: 'New' })) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(order).toEqual(['checkpoint', 'execute:addSheet']);

    // A name op does not barrier: it executes directly (the pending
    // addSheet journal entry stays in its batch).
    order.length = 0;
    const res2 = (await execute(
      {},
      { cmd: 'defineName', name: 'X', ref: 'Sheet1!$A$1' },
    )) as { ok: boolean };
    expect(res2.ok).toBe(true);
    expect(order).toEqual(['execute:defineName']);
  });
});
