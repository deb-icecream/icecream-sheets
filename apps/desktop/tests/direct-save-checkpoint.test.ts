/**
 * Checkpoint scheduler tests (Addendum 3 — AutoSave sync model):
 * continuous batch checkpointing in the main process, at module level
 * with fake host/serializer injection (the atomic-helper pattern).
 *
 * Pins:
 *  - no known destination → no background writes, flush serializes
 *    nothing;
 *  - flush when caught up performs NO serialization;
 *  - ops landing during an in-flight checkpoint land in the NEXT batch
 *    (the journal splits at the checkpoint's cut);
 *  - the settle timer flushes without an explicit flush call;
 *  - the op cap forces a flush without waiting for the timer;
 *  - recording a destination with pending ops arms checkpointing;
 *  - a checkpoint goes through the Addendum-1 sequence for real
 *    (temp-in-dir → real verifyXlsxPackage → atomic rename), and the
 *    destination parses back with the live values.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineHost, EngineWorkbook, type EngineHost as EngineHostType } from '@icecream-sheets/engine';
import {
  clearDesktopSaveOps,
  configureDesktopCheckpoints,
  flushDesktopCheckpoint,
  getCheckpointStatus,
  getLiveRevision,
  getStorageRevision,
  noteDesktopLoadForAutosave,
  noteDesktopSaveOp,
  recordAutosaveTarget,
  resetDesktopCheckpointState,
  type SerializeLiveWorkbookResult,
} from '../src/direct-save.js';
import { resetDesktopSaveBase } from '../src/engine-load.js';

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'icecream-checkpoint-test-'));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

const fakeResult = (): SerializeLiveWorkbookResult => ({
  mode: 'verbatim',
  bytes: 123,
  changedSheets: ['Sheet1'],
  verbatimParts: 0,
  regeneratedParts: [],
  droppedParts: [],
  serializeMs: 1,
});

/** Fake serializer: writes a REAL minimal xlsx package so the real verifyXlsxPackage passes. */
async function writeRealPackage(outPath: string): Promise<SerializeLiveWorkbookResult> {
  const { XlsxAdapter } = await import('@icecream-sheets/xlsx-adapter');
  const bytes = new XlsxAdapter().write({
    sheets: [{ name: 'Sheet1', rows: [[getLiveRevision()]] }],
    metadata: {},
  });
  writeFileSync(outPath, bytes);
  return fakeResult();
}

const fakeHost = (): EngineHostType => ({}) as EngineHostType;

/** A fake serializeFn with the scheduler's real (host, extras, outPath) signature. */
function makeFakeSerialize() {
  return vi.fn(
    async (_host: unknown, _extras: unknown, outPath: string): Promise<SerializeLiveWorkbookResult> =>
      writeRealPackage(outPath),
  );
}
const OP = { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 } };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('direct-save checkpoints (Addendum 3)', () => {
  let t: ReturnType<typeof makeTempDir>;
  beforeEach(() => {
    t = makeTempDir();
    resetDesktopCheckpointState();
    resetDesktopSaveBase();
    clearDesktopSaveOps();
  });
  afterEach(() => {
    resetDesktopCheckpointState();
    clearDesktopSaveOps();
    t.cleanup();
  });

  it('no known destination: flush serializes nothing and writes nothing', async () => {
    const serializeFn = makeFakeSerialize();
    configureDesktopCheckpoints({ getHost: fakeHost, serializeFn, settleMs: 20 });
    noteDesktopSaveOp(OP);
    noteDesktopSaveOp(OP);
    const res = await flushDesktopCheckpoint('test');
    expect(serializeFn).not.toHaveBeenCalled();
    expect(res).toEqual({ storageRevision: 0, liveRevision: 2, caughtUp: false, flushedOps: 0 });
    expect(readdirSync(t.dir)).toEqual([]);
    // Even after the settle window, nothing was written anywhere.
    await sleep(60);
    expect(serializeFn).not.toHaveBeenCalled();
  });

  it('flush when caught up performs no serialization', async () => {
    const serializeFn = makeFakeSerialize();
    configureDesktopCheckpoints({ getHost: fakeHost, serializeFn, settleMs: 60_000 });
    recordAutosaveTarget(join(t.dir, 'book.xlsx'));
    noteDesktopSaveOp(OP);
    const first = await flushDesktopCheckpoint('test');
    expect(first).toEqual({ storageRevision: 1, liveRevision: 1, caughtUp: true, flushedOps: 1 });
    expect(serializeFn).toHaveBeenCalledTimes(1);
    const second = await flushDesktopCheckpoint('test');
    expect(second).toEqual({ storageRevision: 1, liveRevision: 1, caughtUp: true, flushedOps: 0 });
    expect(serializeFn).toHaveBeenCalledTimes(1);
  });

  it('ops during an in-flight checkpoint land in the next batch (journal split at the cut)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const serializeFn = vi.fn(
      async (_host: unknown, _extras: unknown, outPath: string): Promise<SerializeLiveWorkbookResult> => {
        calls++;
        if (calls === 1) await gate; // hold the first checkpoint open
        return writeRealPackage(outPath);
      },
    );
    configureDesktopCheckpoints({ getHost: fakeHost, serializeFn, settleMs: 60_000 });
    recordAutosaveTarget(join(t.dir, 'book.xlsx'));
    noteDesktopSaveOp(OP);
    noteDesktopSaveOp(OP);
    const inFlight = flushDesktopCheckpoint('test');
    // The checkpoint is in flight with a cut at 2; this op is past it.
    noteDesktopSaveOp(OP);
    expect(getLiveRevision()).toBe(3);
    release();
    const first = await inFlight;
    expect(first.storageRevision).toBe(2);
    expect(first.liveRevision).toBe(3);
    expect(first.caughtUp).toBe(false);
    expect(first.flushedOps).toBe(2);
    // The next flush covers exactly the remaining op.
    const second = await flushDesktopCheckpoint('test');
    expect(second).toEqual({ storageRevision: 3, liveRevision: 3, caughtUp: true, flushedOps: 1 });
    expect(serializeFn).toHaveBeenCalledTimes(2);
  });

  it('settle timer flushes a batch without an explicit flush call', async () => {
    const serializeFn = makeFakeSerialize();
    configureDesktopCheckpoints({ getHost: fakeHost, serializeFn, settleMs: 30 });
    recordAutosaveTarget(join(t.dir, 'book.xlsx'));
    noteDesktopSaveOp(OP);
    await sleep(120);
    expect(serializeFn).toHaveBeenCalledTimes(1);
    expect(getStorageRevision()).toBe(1);
    expect(getCheckpointStatus().caughtUp).toBe(true);
  });

  it('op cap forces a flush without waiting for the settle timer', async () => {
    const serializeFn = makeFakeSerialize();
    configureDesktopCheckpoints({
      getHost: fakeHost,
      serializeFn,
      settleMs: 60_000,
      maxPendingOps: 3,
    });
    recordAutosaveTarget(join(t.dir, 'book.xlsx'));
    noteDesktopSaveOp(OP);
    noteDesktopSaveOp(OP);
    expect(serializeFn).not.toHaveBeenCalled();
    noteDesktopSaveOp(OP); // third pending op hits the cap
    // Coalesce onto the forced in-flight flush.
    const res = await flushDesktopCheckpoint('test');
    expect(res.caughtUp).toBe(true);
    expect(res.flushedOps).toBe(3);
    expect(serializeFn).toHaveBeenCalledTimes(1);
  });

  it('recording a destination with pending ops arms checkpointing', async () => {
    const serializeFn = makeFakeSerialize();
    configureDesktopCheckpoints({ getHost: fakeHost, serializeFn, settleMs: 30 });
    noteDesktopSaveOp(OP);
    await sleep(60);
    expect(serializeFn).not.toHaveBeenCalled(); // no destination yet
    recordAutosaveTarget(join(t.dir, 'book.xlsx'));
    await sleep(120);
    expect(serializeFn).toHaveBeenCalledTimes(1);
    expect(getCheckpointStatus().caughtUp).toBe(true);
  });

  it('load-for-autosave: absolute path becomes the target, bare name clears it', async () => {
    const serializeFn = makeFakeSerialize();
    configureDesktopCheckpoints({ getHost: fakeHost, serializeFn, settleMs: 60_000 });
    noteDesktopLoadForAutosave(join(t.dir, 'opened.xlsx'));
    expect(getCheckpointStatus().targetPath).toBe(join(t.dir, 'opened.xlsx'));
    noteDesktopSaveOp(OP);
    const res = await flushDesktopCheckpoint('test');
    expect(res.flushedOps).toBe(1);
    expect(existsSync(join(t.dir, 'opened.xlsx'))).toBe(true);
    noteDesktopLoadForAutosave('library-entry.xlsx');
    expect(getCheckpointStatus().targetPath).toBeNull();
  });

  it(
    'end-to-end: checkpoint writes a parseable package to the destination via the atomic sequence',
    { timeout: 60_000 },
    async () => {
      const host = new EngineHost(new EngineWorkbook({ Sheet1: [[7]] }));
      configureDesktopCheckpoints({ getHost: () => host, settleMs: 60_000 });
      const dest = join(t.dir, 'book.xlsx');
      writeFileSync(dest, 'PREVIOUS CONTENT');
      recordAutosaveTarget(dest);
      const exec = host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 42 });
      expect(exec.ok).toBe(true);
      noteDesktopSaveOp(OP);
      const res = await flushDesktopCheckpoint('test');
      expect(res.caughtUp).toBe(true);
      // No temp left behind; destination is a real package holding 42.
      expect(readdirSync(t.dir).filter((n) => n.includes('.icecream-tmp-'))).toEqual([]);
      const { XlsxAdapter } = await import('@icecream-sheets/xlsx-adapter');
      const data = new XlsxAdapter().read(new Uint8Array(readFileSync(dest)));
      expect(data.sheets[0]!.rows[0]![0]).toBe(42);
    },
  );

  it('a failing checkpoint keeps the batch pending and the destination intact', async () => {
    const serializeFn = vi.fn(async (): Promise<SerializeLiveWorkbookResult> => {
      throw new Error('serialize exploded');
    });
    configureDesktopCheckpoints({ getHost: fakeHost, serializeFn, settleMs: 60_000 });
    const dest = join(t.dir, 'book.xlsx');
    writeFileSync(dest, 'INTACT');
    recordAutosaveTarget(dest);
    noteDesktopSaveOp(OP);
    const res = await flushDesktopCheckpoint('test');
    expect(res).toEqual({ storageRevision: 0, liveRevision: 1, caughtUp: false, flushedOps: 0 });
    expect(readFileSync(dest, 'utf8')).toBe('INTACT');
  });
});
