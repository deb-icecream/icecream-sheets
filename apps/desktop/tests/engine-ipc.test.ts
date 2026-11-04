/**
 * IPC contract tests for the desktop engine bridge (Cycle 10 — engine/view
 * separation): registerEngineIpc against a fake ipcMain, with a REAL
 * EngineHost behind it. Proves the renderer↔engine contract round-trips —
 * load / execute / readCell / readRange / usedRange / snapshot /
 * protocolVersion / protection / new — plus input validation and failure
 * behavior. The renderer never parses or builds a workbook: load goes
 * through the injected buildWorkbookFn exactly like main's engine:load.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ENGINE_PROTOCOL_VERSION,
  EngineHost,
  EngineWorkbook,
  type EngineLoadResult,
} from '@icecream-sheets/engine';
import {
  MAX_LOAD_BYTES,
  registerEngineIpc,
  type EngineIpcDeps,
  type EngineIpcMain,
} from '../src/engine-ipc.js';
import {
  getSaveStatus,
  recordAutosaveTarget,
  resetDesktopCheckpointState,
} from '../src/direct-save.js';
import { resetDesktopSaveBase } from '../src/engine-load.js';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function makeHarness() {
  const handlers = new Map<string, Handler>();
  const ipcMain: EngineIpcMain = {
    handle(channel: string, handler: Handler) {
      handlers.set(channel, handler);
    },
  };
  const host = new EngineHost(
    new EngineWorkbook({ Sheet1: [[1, 2], [3, '=A1+B1']] }),
  );
  const swapWorkbook = vi.fn((wb: EngineWorkbook) => {
    host.replaceWorkbook(wb);
  });
  const resetWorkbook = vi.fn(() => {
    host.replaceWorkbook(new EngineWorkbook());
  });
  const applyProtection = vi.fn((_state: Record<string, unknown>) => undefined);
  const loadResult: EngineLoadResult = {
    sheets: [{ name: 'Data' }],
    metadata: { 'test.meta': 'x' },
  };
  const buildWorkbookFn = vi.fn(async (_bytes: Uint8Array, _filename: string) => ({
    workbook: new EngineWorkbook({ Data: [[42]] }),
    result: loadResult,
  }));
  const deps: EngineIpcDeps = {
    getHost: () => host,
    swapWorkbook,
    resetWorkbook,
    applyProtection,
    buildWorkbookFn,
  };
  registerEngineIpc(ipcMain, deps);
  const call = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const h = handlers.get(channel);
    if (!h) throw new Error(`no handler registered for ${channel}`);
    return h({}, ...args);
  };
  return { handlers, host, swapWorkbook, resetWorkbook, applyProtection, buildWorkbookFn, loadResult, call };
}

describe('registerEngineIpc — registration', () => {
  it('registers the full engine channel set', () => {
    const { handlers } = makeHarness();
    for (const ch of [
      'engine:execute',
      'engine:readCell',
      'engine:readRange',
      'engine:usedRange',
      'engine:snapshot',
      'engine:protocolVersion',
      'engine:load',
      'engine:new',
      'engine:protection',
    ]) {
      expect(handlers.has(ch), ch).toBe(true);
    }
  });
});

describe('registerEngineIpc — execute/read round-trips', () => {
  it('executes setCell and reads the value back', async () => {
    const { call } = makeHarness();
    const res = (await call('engine:execute', {
      cmd: 'setCell',
      ref: { sheet: 'Sheet1', row: 0, col: 0 },
      value: 99,
    })) as { ok: boolean };
    expect(res.ok).toBe(true);
    const cell = (await call('engine:readCell', { sheet: 'Sheet1', row: 0, col: 0 })) as {
      value: { kind: string; value?: unknown };
    };
    expect(cell.value).toEqual({ kind: 'number', value: 99 });
  });

  it('readCell returns the formula alongside the value', async () => {
    const { call } = makeHarness();
    const cell = (await call('engine:readCell', { sheet: 'Sheet1', row: 1, col: 1 })) as {
      value: { kind: string; value?: unknown };
      formula?: string;
    };
    expect(cell.value).toEqual({ kind: 'number', value: 3 });
    expect(cell.formula).toBe('=A1+B1');
  });

  it('rejects unknown/malformed commands without touching the host', async () => {
    const { call } = makeHarness();
    for (const bad of [null, 42, {}, { cmd: 'dropEverything' }, { cmd: 7 }]) {
      const res = (await call('engine:execute', bad)) as { ok: boolean; error?: string };
      expect(res.ok).toBe(false);
      expect(res.error).toContain('unknown or malformed');
    }
  });

  it('accepts the full EngineCommand verb set (structural ops included)', async () => {
    const { call } = makeHarness();
    const res = (await call('engine:execute', { cmd: 'addSheet', name: 'Extra' })) as { ok: boolean };
    expect(res.ok).toBe(true);
    const names = ((await call('engine:snapshot')) as { sheets: { name: string }[] }).sheets.map((s) => s.name);
    expect(names).toContain('Extra');
  });

  it('routes explicit recalculate through the parallel dispatch', async () => {
    const { call } = makeHarness();
    const res = (await call('engine:execute', { cmd: 'recalculate' })) as { ok: boolean };
    expect(res.ok).toBe(true);
  });

  it('readRange returns a 2D value grid; malformed range returns a #VALUE! cell', async () => {
    const { call } = makeHarness();
    const grid = (await call('engine:readRange', {
      sheet: 'Sheet1',
      startRow: 0,
      startCol: 0,
      endRow: 1,
      endCol: 1,
    })) as { kind: string; value?: unknown }[][];
    expect(grid[0]![0]).toEqual({ kind: 'number', value: 1 });
    expect(grid[1]![1]).toEqual({ kind: 'number', value: 3 });
    const bad = (await call('engine:readRange', { sheet: 'Sheet1' })) as { kind: string; code?: string }[][];
    expect(bad[0]![0]).toMatchObject({ kind: 'error', code: '#VALUE!' });
  });

  it('readCell with a malformed ref returns a #VALUE! value (never throws)', async () => {
    const { call } = makeHarness();
    const cell = (await call('engine:readCell', { row: 'x' })) as { value: { kind: string; code?: string } };
    expect(cell.value).toMatchObject({ kind: 'error', code: '#VALUE!' });
  });

  it('usedRange returns the sheet bounds and rejects a bad name', async () => {
    const { call } = makeHarness();
    const used = (await call('engine:usedRange', 'Sheet1')) as { endRow: number; endCol: number } | null;
    expect(used).toMatchObject({ sheet: 'Sheet1', endRow: 1, endCol: 1 });
    await expect(call('engine:usedRange', '')).rejects.toThrow('sheet name');
    await expect(call('engine:usedRange', 42)).rejects.toThrow('sheet name');
  });

  it('snapshot + protocolVersion round-trip', async () => {
    const { call } = makeHarness();
    const snap = (await call('engine:snapshot')) as { protocolVersion: number; sheets: unknown[] };
    expect(snap.protocolVersion).toBe(ENGINE_PROTOCOL_VERSION);
    expect(snap.sheets.length).toBe(1);
    expect(await call('engine:protocolVersion')).toBe(ENGINE_PROTOCOL_VERSION);
  });
});

describe('registerEngineIpc — load/new/protection', () => {
  it('engine:load builds via buildWorkbookFn and swaps the workbook in', async () => {
    const h = makeHarness();
    const res = (await h.call('engine:load', { bytes: [80, 75, 3, 4], filename: 'book.xlsx' })) as EngineLoadResult;
    expect(res).toBe(h.loadResult);
    expect(h.buildWorkbookFn).toHaveBeenCalledTimes(1);
    expect(h.swapWorkbook).toHaveBeenCalledTimes(1);
    // The new workbook is live in the host now.
    const cell = (await h.call('engine:readCell', { sheet: 'Data', row: 0, col: 0 })) as {
      value: { value?: unknown };
    };
    expect(cell.value.value).toBe(42);
  });

  it('engine:load accepts a Uint8Array payload and hands it to buildWorkbookFn unconverted', async () => {
    const h = makeHarness();
    const bytes = new Uint8Array([80, 75, 3, 4]);
    const res = (await h.call('engine:load', { bytes, filename: 'book.xlsx' })) as EngineLoadResult;
    expect(res).toBe(h.loadResult);
    expect(h.buildWorkbookFn).toHaveBeenCalledTimes(1);
    // The binary payload reaches the builder as the same Uint8Array —
    // no per-byte number[] round-trip on either side of the channel.
    const passed = (h.buildWorkbookFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0];
    expect(passed).toBe(bytes);
    expect(h.swapWorkbook).toHaveBeenCalledTimes(1);
    // Oversize typed payloads trip the same size guard.
    await expect(
      h.call('engine:load', { bytes: new Uint8Array(MAX_LOAD_BYTES + 1), filename: 'x.xlsx' }),
    ).rejects.toThrow('too large');
  });

  it('engine:load validates its payload (shape, bytes, size)', async () => {
    const { call, buildWorkbookFn } = makeHarness();
    await expect(call('engine:load', { filename: 'x.xlsx' })).rejects.toThrow('engine:load');
    await expect(call('engine:load', { bytes: [1, 2], filename: '' })).rejects.toThrow('engine:load');
    await expect(call('engine:load', { bytes: [1, 300], filename: 'x.xlsx' })).rejects.toThrow('not a byte');
    // Sparse (holey) array: length alone must trip the size guard.
    await expect(
      call('engine:load', { bytes: new Array(MAX_LOAD_BYTES + 1), filename: 'x.xlsx' }),
    ).rejects.toThrow('too large');
    expect(buildWorkbookFn).not.toHaveBeenCalled();
  });

  it('engine:new resets the workbook', async () => {
    const h = makeHarness();
    await h.call('engine:new');
    expect(h.resetWorkbook).toHaveBeenCalledTimes(1);
  });

  it('engine:protection applies renderer state and rejects non-records', async () => {
    const h = makeHarness();
    const state = { 'icecream.protection': 'x' };
    await h.call('engine:protection', state);
    expect(h.applyProtection).toHaveBeenCalledWith(state);
    await expect(h.call('engine:protection', 'nope')).rejects.toThrow('engine:protection');
  });
});

/**
 * Issue #59: closing a local file must dispose its main-process
 * workbook/engine and clear that file's save/restore state. Both close
 * paths funnel through these channels (File ▸ Open = engine:load swap;
 * File ▸ New / close-to-blank = engine:new), so the disposal contract
 * is pinned at the IPC level: after either, the old file's sheets are
 * unreachable, its journaled ops are gone, and the autosave target no
 * longer names it. (The renderer's reload-reattach is by design and is
 * NOT disposal — it re-reads the CURRENT workbook; the perf program's
 * #50 fix already stopped desktop restoring stale renderer state.)
 */
describe('registerEngineIpc — issue #59 (closing a file disposes its engine state)', () => {
  function makeSequencedHarness() {
    const handlers = new Map<string, Handler>();
    const ipcMain: EngineIpcMain = {
      handle(channel: string, handler: Handler) {
        handlers.set(channel, handler);
      },
    };
    const host = new EngineHost(new EngineWorkbook({ Sheet1: [[0]] }));
    const books: Array<{ name: string; value: number }> = [
      { name: 'Alpha', value: 1 },
      { name: 'Beta', value: 2 },
    ];
    let built = 0;
    const buildWorkbookFn = vi.fn(async (_bytes: Uint8Array, _filename: string) => {
      const spec = books[Math.min(built++, books.length - 1)]!;
      return {
        workbook: new EngineWorkbook({ [spec.name]: [[spec.value]] }),
        result: { sheets: [{ name: spec.name }], metadata: {} } as EngineLoadResult,
      };
    });
    const swapWorkbook = vi.fn((wb: EngineWorkbook) => {
      host.replaceWorkbook(wb);
    });
    const resetWorkbook = vi.fn(() => {
      host.replaceWorkbook(new EngineWorkbook());
    });
    const deps: EngineIpcDeps = {
      getHost: () => host,
      swapWorkbook,
      resetWorkbook,
      applyProtection: vi.fn((_state: Record<string, unknown>) => undefined),
      buildWorkbookFn,
    };
    registerEngineIpc(ipcMain, deps);
    const call = async (channel: string, ...args: unknown[]): Promise<unknown> => {
      const h = handlers.get(channel);
      if (!h) throw new Error(`no handler registered for ${channel}`);
      return h({}, ...args);
    };
    resetDesktopCheckpointState();
    resetDesktopSaveBase();
    return { call, host, swapWorkbook, resetWorkbook };
  }

  const readValue = async (
    call: (channel: string, ...args: unknown[]) => Promise<unknown>,
    sheet: string,
  ): Promise<{ kind: string; value?: unknown; code?: string }> => {
    const cell = (await call('engine:readCell', { sheet, row: 0, col: 0 })) as {
      value: { kind: string; value?: unknown; code?: string };
    };
    return cell.value;
  };

  it('engine:load swap: the previous file is fully disposed (sheets, journal, target)', async () => {
    const h = makeSequencedHarness();
    await h.call('engine:load', { bytes: [1], filename: '/books/alpha.xlsx' });
    expect(await readValue(h.call, 'Alpha')).toEqual({ kind: 'number', value: 1 });
    // An edit on Alpha journals a save op against Alpha's target.
    await h.call('engine:execute', {
      cmd: 'setCell',
      ref: { sheet: 'Alpha', row: 0, col: 0 },
      value: 10,
    });
    expect(getSaveStatus().pendingOps).toBe(1);
    expect(getSaveStatus().targetPath).toBe('/books/alpha.xlsx');

    // Opening Beta IS the close of Alpha: swap + full state reset.
    await h.call('engine:load', { bytes: [2], filename: '/books/beta.xlsx' });
    expect(h.swapWorkbook).toHaveBeenCalledTimes(2);
    // Alpha's workbook is gone from the host (an error value, never 1/10).
    const alpha = await readValue(h.call, 'Alpha');
    expect(alpha.kind).toBe('error');
    expect(await readValue(h.call, 'Beta')).toEqual({ kind: 'number', value: 2 });
    // Alpha's journal and autosave target died with it; the target now
    // names the NEW file (re-scoped by the load), never the closed one.
    expect(getSaveStatus().pendingOps).toBe(0);
    expect(getSaveStatus().targetPath).toBe('/books/beta.xlsx');
  });

  it('engine:new: the loaded file is disposed and its save state cleared', async () => {
    const h = makeSequencedHarness();
    await h.call('engine:load', { bytes: [1], filename: '/books/alpha.xlsx' });
    await h.call('engine:execute', {
      cmd: 'setCell',
      ref: { sheet: 'Alpha', row: 0, col: 0 },
      value: 10,
    });
    recordAutosaveTarget('/books/alpha.xlsx');
    expect(getSaveStatus().pendingOps).toBe(1);

    await h.call('engine:new');
    expect(h.resetWorkbook).toHaveBeenCalledTimes(1);
    // The host holds a blank workbook: Alpha unreachable, Sheet1 blank.
    expect(h.host.sheetNames()).toEqual(['Sheet1']);
    expect((await readValue(h.call, 'Alpha')).kind).toBe('error');
    expect(await readValue(h.call, 'Sheet1')).toEqual({ kind: 'null', value: null });
    // No trace of the closed file in the save machinery.
    expect(getSaveStatus().pendingOps).toBe(0);
    expect(getSaveStatus().targetPath).toBeNull();
  });
});
