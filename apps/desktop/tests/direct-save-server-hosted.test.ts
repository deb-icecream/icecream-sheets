/**
 * Server-hosted quit-flush + extras baselining tests (#103).
 *
 * Pins:
 *  - the first extras sync after a load/new baselines (dirty=false) —
 *    the loaded state is not a user change, so a pristine quit must not
 *    fire the guard;
 *  - only a sync DIFFERING from the baseline marks dirt, and returning
 *    exactly to the baseline clears it again;
 *  - a server-hosted workbook's flush is a noop (caughtUp, 0 ops) even
 *    with dirty extras and no local destination — main owns nothing
 *    for it, so the quit guard must never fire on it;
 *  - the same dirty state with serverHosted=false still reports
 *    uncaught (the guard's honest case is preserved).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearDesktopSaveOps,
  flushDesktopCheckpoint,
  isServerHostedWorkbook,
  isSessionExtrasDirty,
  noteDesktopLoadForAutosave,
  resetDesktopCheckpointState,
  setPendingSessionExtras,
  setServerHostedWorkbook,
} from '../src/direct-save.js';

const extrasA = { sheetStyles: { Sheet1: { '0:0': { bold: true } } } };
const extrasB = { sheetStyles: { Sheet1: { '0:0': { bold: true, italic: true } } } };

beforeEach(() => {
  resetDesktopCheckpointState();
  clearDesktopSaveOps();
});

describe('extras baselining', () => {
  it('first sync after load baselines (clean); differing sync marks dirt; return to baseline clears', () => {
    noteDesktopLoadForAutosave('/tmp/never-written.xlsx');
    setPendingSessionExtras(extrasA);
    expect(isSessionExtrasDirty()).toBe(false);
    setPendingSessionExtras(extrasB);
    expect(isSessionExtrasDirty()).toBe(true);
    setPendingSessionExtras(extrasA);
    expect(isSessionExtrasDirty()).toBe(false);
  });

  it('load resets dirt from the previous workbook', () => {
    noteDesktopLoadForAutosave('/tmp/first.xlsx');
    setPendingSessionExtras(extrasA);
    setPendingSessionExtras(extrasB);
    expect(isSessionExtrasDirty()).toBe(true);
    noteDesktopLoadForAutosave('/tmp/second.xlsx');
    expect(isSessionExtrasDirty()).toBe(false);
  });
});

describe('server-hosted flush', () => {
  it('server-hosted flush is a noop even with dirty extras and no destination', async () => {
    noteDesktopLoadForAutosave('server-file');
    setPendingSessionExtras(extrasA);
    setPendingSessionExtras(extrasB);
    expect(isSessionExtrasDirty()).toBe(true);
    setServerHostedWorkbook(true);
    expect(isServerHostedWorkbook()).toBe(true);
    const res = await flushDesktopCheckpoint('test-quit');
    expect(res.caughtUp).toBe(true);
    expect(res.flushedOps).toBe(0);
  });

  it('same dirty state with serverHosted=false still reports uncaught (guard preserved)', async () => {
    noteDesktopLoadForAutosave('server-file');
    setPendingSessionExtras(extrasA);
    setPendingSessionExtras(extrasB);
    expect(isSessionExtrasDirty()).toBe(true);
    setServerHostedWorkbook(false);
    const res = await flushDesktopCheckpoint('test-quit');
    expect(res.caughtUp).toBe(false);
    expect(res.flushedOps).toBe(0);
  });

  it('absolute-path load clears the server-hosted flag (local file)', () => {
    setServerHostedWorkbook(true);
    noteDesktopLoadForAutosave('/tmp/local.xlsx');
    expect(isServerHostedWorkbook()).toBe(false);
  });
});
