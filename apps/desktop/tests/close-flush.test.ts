/**
 * Close-flush tests (Item E — Phase 1 residual (q); revision-model
 * §§5, 7, 11).
 *
 * The defect: main's `before-quit` disposed the engine host
 * synchronously and never flushed the checkpoint batch, so an edit
 * followed by an immediate quit (inside the 1500 ms settle window, the
 * timer being unref'd) lost the edit — the on-disk file kept its
 * pre-edit bytes.
 *
 * Pins:
 *  - edit → quit INSIDE the settle window → the checkpoint is flushed
 *    through the real temp → verify → atomic-rename sequence and the
 *    destination parses back with the edit; teardown runs only AFTER
 *    the flush, quit is re-issued exactly once, and the re-issued
 *    before-quit passes through untouched;
 *  - a second before-quit arriving mid-flush is held (preventDefault)
 *    but starts no second flush / teardown / quit;
 *  - never-saved workbook (no destination): quit proceeds immediately,
 *    teardown + quit still run, nothing is written anywhere;
 *  - caught-up workbook: quit flush is a strict no-op (no writes);
 *  - the flush is BOUNDED: a flush that never settles times out, and
 *    teardown + re-issued quit still happen;
 *  - a throwing flush / teardown cannot break the quit path;
 *  - installCloseFlush registers on 'before-quit';
 *  - main.ts is actually wired (source pin: imports + installs the
 *    controller, and no bare synchronous before-quit teardown remains).
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineHost, EngineWorkbook, type EngineHost as EngineHostType } from '@icecream-sheets/engine';
import {
  createQuitFlushController,
  flushBeforeQuit,
  installCloseFlush,
  QUIT_FLUSH_TIMEOUT_MS,
  type BeforeQuitEventLike,
} from '../src/close-flush.js';
import {
  clearDesktopSaveOps,
  configureDesktopCheckpoints,
  flushDesktopCheckpoint,
  getSaveStatus,
  noteDesktopSaveOp,
  recordAutosaveTarget,
  resetDesktopCheckpointState,
} from '../src/direct-save.js';
import { resetDesktopSaveBase } from '../src/engine-load.js';

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'icecream-close-flush-test-'));
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

function fakeEvent(): BeforeQuitEventLike & { prevented: number } {
  const ev = {
    prevented: 0,
    preventDefault() {
      ev.prevented++;
    },
  };
  return ev;
}

const OP = { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 } };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('close-flush (Item E)', () => {
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

  it(
    'edit → quit inside the settle window: checkpoint flushed, destination parses back with the edit',
    { timeout: 60_000 },
    async () => {
      const host = new EngineHost(new EngineWorkbook({ Sheet1: [[7]] }));
      // Settle window far longer than the test: WITHOUT the quit flush
      // nothing would ever write before "quit".
      configureDesktopCheckpoints({ getHost: () => host, settleMs: 60_000 });
      const dest = join(t.dir, 'book.xlsx');
      writeFileSync(dest, 'PRE-EDIT BYTES');
      recordAutosaveTarget(dest);

      // The edit, journaled exactly as engine-ipc journals it.
      const exec = host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 99 });
      expect(exec.ok).toBe(true);
      noteDesktopSaveOp(OP);
      expect(getSaveStatus().pendingOps).toBe(1);

      const order: string[] = [];
      const controller = createQuitFlushController({
        // Generous bound for this correctness test (the real serializer
        // under CI load can exceed the production 10 s bound, which is
        // pinned separately by the timeout test + constant assertion).
        timeoutMs: 55_000,
        flush: async (reason) => {
          const res = await flushDesktopCheckpoint(reason);
          order.push('flush-settled');
          return res;
        },
        teardown: () => {
          order.push('teardown');
        },
        quit: () => {
          order.push('quit');
        },
        log: () => undefined,
      });

      const ev = fakeEvent();
      const outcomePromise = controller.handleBeforeQuit(ev);
      expect(ev.prevented).toBe(1); // quit held open synchronously
      expect(controller.phase).toBe('flushing');
      const outcome = await outcomePromise;

      expect(outcome?.status).toBe('flushed');
      expect(outcome?.flushedOps).toBe(1);
      expect(outcome?.lastResult?.caughtUp).toBe(true);
      // Teardown strictly AFTER the flush settled; quit re-issued once.
      expect(order).toEqual(['flush-settled', 'teardown', 'quit']);
      expect(controller.phase).toBe('done');
      expect(getSaveStatus().pendingOps).toBe(0);

      // The destination was replaced atomically (no temp left behind)
      // and parses back with the edit — the pre-edit bytes are gone.
      expect(readdirSync(t.dir).filter((n) => n.includes('.icecream-tmp-'))).toEqual([]);
      const { XlsxAdapter } = await import('@icecream-sheets/xlsx-adapter');
      const data = new XlsxAdapter().read(new Uint8Array(readFileSync(dest)));
      expect(data.sheets[0]!.rows[0]![0]).toBe(99);

      // The re-issued quit's before-quit passes through untouched:
      // no preventDefault, no second flush/teardown/quit.
      const ev2 = fakeEvent();
      expect(controller.handleBeforeQuit(ev2)).toBeUndefined();
      expect(ev2.prevented).toBe(0);
      expect(order).toEqual(['flush-settled', 'teardown', 'quit']);
    },
  );

  it('a second before-quit during the flush is held but starts no second flush', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const flush = vi.fn(async () => {
      await gate;
      return { storageRevision: 1, liveRevision: 1, caughtUp: true, flushedOps: 1 };
    });
    const teardown = vi.fn();
    const quit = vi.fn();
    const controller = createQuitFlushController({ flush, teardown, quit, log: () => undefined });

    const ev1 = fakeEvent();
    const p = controller.handleBeforeQuit(ev1);
    const ev2 = fakeEvent();
    expect(controller.handleBeforeQuit(ev2)).toBeUndefined();
    expect(ev1.prevented).toBe(1);
    expect(ev2.prevented).toBe(1); // held — quit must not slip through mid-flush
    release();
    const outcome = await p;
    expect(outcome?.status).toBe('flushed');
    expect(flush).toHaveBeenCalledTimes(1);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('never-saved workbook (no destination): quit proceeds immediately, nothing written', { timeout: 60_000 }, async () => {
    const host = new EngineHost(new EngineWorkbook({ Sheet1: [[1]] }));
    configureDesktopCheckpoints({ getHost: () => host, settleMs: 60_000 });
    // No recordAutosaveTarget: no destination exists.
    const exec = host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 5 });
    expect(exec.ok).toBe(true);
    noteDesktopSaveOp(OP);

    const teardown = vi.fn();
    const quit = vi.fn();
    const controller = createQuitFlushController({
      flush: (reason) => flushDesktopCheckpoint(reason),
      teardown,
      quit,
      log: () => undefined,
    });
    const outcome = await controller.handleBeforeQuit(fakeEvent());
    // No destination → the batch cannot be covered; the quit must NOT
    // be held or spun on — teardown + re-issued quit still run.
    expect(outcome?.status).toBe('failed');
    expect(outcome?.flushedOps).toBe(0);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(controller.phase).toBe('done');
    expect(readdirSync(t.dir)).toEqual([]);
  });

  it('caught-up workbook: quit flush is a strict no-op (destination bytes untouched)', async () => {
    const dest = join(t.dir, 'book.xlsx');
    writeFileSync(dest, 'ALREADY CURRENT');
    configureDesktopCheckpoints({ getHost: () => ({}) as EngineHostType, settleMs: 60_000 });
    recordAutosaveTarget(dest);
    const outcome = await flushBeforeQuit({
      flush: (reason) => flushDesktopCheckpoint(reason),
      log: () => undefined,
    });
    expect(outcome.status).toBe('noop');
    expect(outcome.flushedOps).toBe(0);
    expect(readFileSync(dest, 'utf8')).toBe('ALREADY CURRENT');
    expect(existsSync(dest)).toBe(true);
  });

  it('flush that coalesces onto an earlier cut loops until storage catches up', async () => {
    const results = [
      { storageRevision: 1, liveRevision: 2, caughtUp: false, flushedOps: 1 },
      { storageRevision: 2, liveRevision: 2, caughtUp: true, flushedOps: 1 },
    ];
    const flush = vi.fn(async () => results.shift()!);
    const outcome = await flushBeforeQuit({ flush, log: () => undefined });
    expect(outcome.status).toBe('flushed');
    expect(outcome.flushedOps).toBe(2);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenCalledWith('app-quit');
  });

  it('bounded: a flush that never settles times out and quit still proceeds', async () => {
    const teardown = vi.fn();
    const quit = vi.fn();
    const controller = createQuitFlushController({
      flush: () => new Promise(() => undefined), // never settles
      timeoutMs: 60,
      teardown,
      quit,
      log: () => undefined,
    });
    const started = Date.now();
    const outcome = await controller.handleBeforeQuit(fakeEvent());
    const elapsed = Date.now() - started;
    expect(outcome?.status).toBe('timeout');
    expect(elapsed).toBeLessThan(5_000);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(controller.phase).toBe('done');
    expect(QUIT_FLUSH_TIMEOUT_MS).toBe(10_000);
  });

  it('a throwing flush and a throwing teardown cannot break the quit path', async () => {
    const quit = vi.fn();
    const controller = createQuitFlushController({
      flush: async () => {
        throw new Error('flush exploded');
      },
      teardown: () => {
        throw new Error('teardown exploded');
      },
      quit,
      log: () => undefined,
    });
    const outcome = await controller.handleBeforeQuit(fakeEvent());
    expect(outcome?.status).toBe('failed');
    expect(quit).toHaveBeenCalledTimes(1);
    expect(controller.phase).toBe('done');
  });

  it('installCloseFlush registers the controller on before-quit', async () => {
    const handlers = new Map<string, (e: BeforeQuitEventLike) => void>();
    const appLike = {
      on: (channel: 'before-quit', listener: (e: BeforeQuitEventLike) => void) => {
        handlers.set(channel, listener);
      },
    };
    const quit = vi.fn();
    const controller = installCloseFlush(appLike, {
      flush: async () => ({ storageRevision: 0, liveRevision: 0, caughtUp: true, flushedOps: 0 }),
      teardown: vi.fn(),
      quit,
      log: () => undefined,
    });
    expect(handlers.has('before-quit')).toBe(true);
    const ev = fakeEvent();
    handlers.get('before-quit')!(ev);
    expect(ev.prevented).toBe(1);
    await sleep(20);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(controller.phase).toBe('done');
  });

  it('main.ts wiring pin: close-flush installed, no bare synchronous before-quit remains', () => {
    const mainPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts');
    const src = readFileSync(mainPath, 'utf8');
    expect(src).toContain('installCloseFlush');
    expect(src).toContain("from './close-flush'");
    expect(src).toContain('installCloseFlush(app, {');
    expect(src).toContain('flush: (reason) => flushDesktopCheckpoint(reason)');
    expect(src).toContain('quit: () => app.quit()');
    // The old defect shape — a direct app.on('before-quit', …) handler
    // disposing the host — must not exist alongside the controller.
    expect(src).not.toContain("app.on('before-quit'");
    // window-all-closed → quit on non-macOS is preserved (it funnels
    // through before-quit, so the flush covers it).
    expect(src).toContain("app.on('window-all-closed'");
    expect(src).toContain("if (process.platform !== 'darwin')");
  });

  it('main.ts wiring pin (issue #57): window-close guard + native confirm + destroy-before-teardown', () => {
    const mainPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts');
    const src = readFileSync(mainPath, 'utf8');
    // The window's close event is intercepted in main and routed
    // through the guard — never straight to the renderer's veto.
    expect(src).toContain("mainWindow.on('close'");
    expect(src).toContain('guardMainWindowClose');
    expect(src).toContain('controller.requestQuit()');
    expect(src).toContain("controller.flushOnly('window-close')");
    // The confirm + force-close are wired into the controller.
    expect(src).toContain('confirmUncovered: (outcome) => confirmQuitWithUncoveredWork(outcome)');
    expect(src).toContain('destroyWindows: () => {');
    expect(src).toContain('dialog.showMessageBox');
    // Issue #48 band-aid: the raised V8 ceiling is present and labeled.
    expect(src).toContain("--max-old-space-size=8192");
    expect(src).toContain('BAND-AID');
  });
});

describe('close-flush — issue #57 (confirm gate, abort, requestQuit, flushOnly)', () => {
  const uncovered = { storageRevision: 0, liveRevision: 1, caughtUp: false, flushedOps: 0 };

  it('uncovered work + user stays: quit aborts, nothing torn down, quit can be retried', async () => {
    const flush = vi.fn(async () => uncovered);
    const teardown = vi.fn();
    const quit = vi.fn();
    const destroyWindows = vi.fn();
    let answer = false;
    const controller = createQuitFlushController({
      flush,
      teardown,
      quit,
      destroyWindows,
      confirmUncovered: async () => answer,
      log: () => undefined,
    });
    const outcome = await controller.handleBeforeQuit(fakeEvent());
    expect(outcome?.status).toBe('failed');
    expect(teardown).not.toHaveBeenCalled();
    expect(destroyWindows).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    expect(controller.phase).toBe('idle');
    // Retry after the user saves (here: changes their answer): the
    // full flow runs — destroy BEFORE teardown BEFORE quit.
    answer = true;
    const order: string[] = [];
    destroyWindows.mockImplementation(() => void order.push('destroy'));
    teardown.mockImplementation(() => void order.push('teardown'));
    quit.mockImplementation(() => void order.push('quit'));
    const outcome2 = await controller.handleBeforeQuit(fakeEvent());
    expect(outcome2?.status).toBe('failed');
    expect(order).toEqual(['destroy', 'teardown', 'quit']);
    expect(controller.phase).toBe('done');
  });

  it('covered work never asks: flush → destroy → teardown → quit', async () => {
    const confirmUncovered = vi.fn(async () => false);
    const order: string[] = [];
    const controller = createQuitFlushController({
      flush: async () => {
        order.push('flush');
        return { storageRevision: 1, liveRevision: 1, caughtUp: true, flushedOps: 1 };
      },
      confirmUncovered,
      destroyWindows: () => void order.push('destroy'),
      teardown: () => void order.push('teardown'),
      quit: () => void order.push('quit'),
      log: () => undefined,
    });
    const outcome = await controller.handleBeforeQuit(fakeEvent());
    expect(outcome?.status).toBe('flushed');
    expect(confirmUncovered).not.toHaveBeenCalled();
    expect(order).toEqual(['flush', 'destroy', 'teardown', 'quit']);
  });

  it('a throwing confirm aborts the quit (fail closed)', async () => {
    const teardown = vi.fn();
    const quit = vi.fn();
    const controller = createQuitFlushController({
      flush: async () => uncovered,
      confirmUncovered: async () => {
        throw new Error('dialog exploded');
      },
      teardown,
      quit,
      log: () => undefined,
    });
    const outcome = await controller.handleBeforeQuit(fakeEvent());
    expect(outcome?.status).toBe('failed');
    expect(teardown).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    expect(controller.phase).toBe('idle');
  });

  it('requestQuit runs the guarded flow without a before-quit event', async () => {
    const teardown = vi.fn();
    const quit = vi.fn();
    const controller = createQuitFlushController({
      flush: async () => ({ storageRevision: 0, liveRevision: 0, caughtUp: true, flushedOps: 0 }),
      teardown,
      quit,
      log: () => undefined,
    });
    const outcome = await controller.requestQuit();
    expect(outcome?.status).toBe('noop');
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(controller.phase).toBe('done');
    // A second requestQuit just re-issues quit (no second flow).
    expect(controller.requestQuit()).toBeUndefined();
    expect(quit).toHaveBeenCalledTimes(2);
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('flushOnly runs the flush with its reason and touches nothing else', async () => {
    const flush = vi.fn(
      async (reason: string) => {
        expect(reason).toBe('window-close');
        return { storageRevision: 2, liveRevision: 2, caughtUp: true, flushedOps: 2 };
      },
    );
    const teardown = vi.fn();
    const quit = vi.fn();
    const controller = createQuitFlushController({ flush, teardown, quit, log: () => undefined });
    const outcome = await controller.flushOnly('window-close');
    expect(outcome.status).toBe('flushed');
    expect(outcome.flushedOps).toBe(2);
    expect(teardown).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    expect(controller.phase).toBe('idle');
  });

  it('outcomeLeavesWorkUncovered: only the failed status counts', async () => {
    const { outcomeLeavesWorkUncovered } = await import('../src/close-flush.js');
    expect(outcomeLeavesWorkUncovered({ status: 'failed', flushedOps: 0 })).toBe(true);
    expect(outcomeLeavesWorkUncovered({ status: 'flushed', flushedOps: 3 })).toBe(false);
    expect(outcomeLeavesWorkUncovered({ status: 'noop', flushedOps: 0 })).toBe(false);
    // Timeout is the accepted bounded tradeoff, not "uncovered".
    expect(outcomeLeavesWorkUncovered({ status: 'timeout', flushedOps: 1 })).toBe(false);
  });
});
