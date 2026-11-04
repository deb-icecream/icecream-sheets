/**
 * Desktop close-flush (Item E — Phase 1 residual (q); revision-model
 * design doc §§5, 7, 11).
 *
 * THE DEFECT THIS MODULE EXISTS TO KILL: before this module, the main
 * process's `before-quit` handler disposed the engine host
 * SYNCHRONOUSLY and never flushed the checkpoint batch. Pending ops
 * lived only in main-process memory (the direct-save journal in
 * direct-save.ts) plus a settle timer (default 1500 ms, unref'd) — so
 * an edit followed by an immediate quit (inside the settle window, or
 * while a checkpoint for an earlier cut was still in flight) was lost:
 * the on-disk file kept its pre-edit bytes. §5 names "session close"
 * as a flush point and §11 applies the whole revision model to the
 * logged-out local engine; §7's no-loss rule (typed inputs are never
 * lost by the machinery) applies to the local engine's queue exactly
 * as it does to a collab client's outbound queue.
 *
 * THE FIX: intercept the FIRST `before-quit`, hold the quit open
 * (event.preventDefault()), flush the pending checkpoint batch to the
 * workbook's known destination through the SAME temp → verify →
 * atomic-rename sequence every other checkpoint uses
 * (flushDesktopCheckpoint, direct-save.ts), and only then run the
 * synchronous teardown (MCP close, worker-pool + host dispose) and
 * re-issue the quit. The flush is BOUNDED by QUIT_FLUSH_TIMEOUT_MS:
 * a hung serializer can delay quit by at most the timeout, never
 * forever — and because the checkpoint write is atomic, abandoning a
 * timed-out flush still leaves the destination byte-identical to its
 * last good state rather than half-written.
 *
 * Scope notes:
 *  - The flush runs entirely in the main process: the live model, the
 *    op journal, and the synced session extras all live there, so the
 *    flush works even when the renderer window has already closed
 *    (window-all-closed → app.quit() on non-macOS) — the case a
 *    renderer-side flush could never cover.
 *  - With NO known destination (a never-saved new workbook) there is
 *    nowhere durable to flush to without asking the user for a path;
 *    flushDesktopCheckpoint then cannot cover the batch and the outcome
 *    is 'failed' (work uncovered). WHAT HAPPENS THEN is issue #57's
 *    fix: when the wiring provides a `confirmUncovered` callback, the
 *    user is asked (native dialog in main) and a "stay" answer ABORTS
 *    the quit — the controller returns to 'idle' with nothing torn
 *    down, so quit can be retried after saving. (The renderer's
 *    beforeunload veto cannot serve as this guard: Electron shows no
 *    prompt for it — it silently CANCELLED the window close, which is
 *    exactly how the swallowed quit happened: flush ran, teardown
 *    disposed the engine, the re-issued app.quit() reached the window
 *    close, the renderer's dirty veto killed it without a word, and
 *    the app stayed alive with its engine already gone.) On the
 *    proceed path the wiring's `destroyWindows` force-closes the
 *    windows (destroy() skips unload handlers by design) so the veto
 *    cannot swallow an approved quit either.
 *  - Logged-in (service) mode needs nothing here: the outbound queue
 *    is the renderer's collabTransport queue, persisted per-file in
 *    localStorage until server-acked (design doc §7), and service
 *    files are autosaved server-side (§5/§11) — the main process holds
 *    no unacked service ops at quit time.
 *
 * This module is Electron-free (the quit event is structural) so the
 * whole quit path is unit-testable without booting Electron — same
 * pattern as ./engine-ipc and ./auth-ipc.
 */

/** One checkpoint-flush attempt's result (flushDesktopCheckpoint's shape). */
export interface QuitFlushResult {
  storageRevision: number;
  liveRevision: number;
  caughtUp: boolean;
  flushedOps: number;
}

/**
 * Hard bound on the quit flush. Desktop saves at P75 scale measure
 * ~2 s end-to-end; 10 s is generous headroom for a final checkpoint
 * while guaranteeing quit can never hang forever on a stuck write.
 */
export const QUIT_FLUSH_TIMEOUT_MS = 10_000;

/** Outcome of one bounded quit-flush run. */
export interface QuitFlushOutcome {
  status: 'flushed' | 'noop' | 'failed' | 'timeout';
  /** Total ops written across the run's flush passes. */
  flushedOps: number;
  /** The last flush result seen, when any pass completed. */
  lastResult?: QuitFlushResult;
  /** Failure detail for 'failed' (flush threw synchronously per pass). */
  error?: string;
}

export interface FlushBeforeQuitDeps {
  /** The checkpoint flush primitive (flushDesktopCheckpoint in main). */
  flush: (reason: string) => Promise<QuitFlushResult>;
  /** Overall bound for the whole run (default QUIT_FLUSH_TIMEOUT_MS). */
  timeoutMs?: number;
  log?: (m: string) => void;
  /** Reason passed to the flush primitive (default 'app-quit'). */
  reason?: string;
}

/**
 * True when a completed flush run leaves user work UNCOVERED: a pass
 * wrote nothing while storage was still behind (no destination, or the
 * checkpoint failed), or the flush threw. 'flushed'/'noop' mean storage
 * covers the live revision; 'timeout' is the pre-existing accepted
 * tradeoff (a hung serializer must not hold quit hostage — the
 * destination keeps its last atomically-written state), so it does NOT
 * count as uncovered here.
 */
export function outcomeLeavesWorkUncovered(outcome: QuitFlushOutcome): boolean {
  return outcome.status === 'failed';
}

/**
 * Flush pending checkpoint work before quit, bounded. Never throws.
 *
 * Loops the flush primitive until storage is caught up: a first pass
 * can coalesce onto an already in-flight checkpoint whose cut predates
 * the latest ops, so one pass is not proof of durability — the next
 * pass covers the remainder. The loop stops when a pass reports
 * caughtUp, when a pass writes nothing while still uncaught (no
 * destination / failed checkpoint — retrying inside the quit path
 * would only burn the bound), or when the timeout fires.
 */
export async function flushBeforeQuit(
  deps: FlushBeforeQuitDeps,
): Promise<QuitFlushOutcome> {
  const timeoutMs = deps.timeoutMs ?? QUIT_FLUSH_TIMEOUT_MS;
  const log = deps.log ?? (() => undefined);
  let flushedOps = 0;
  let lastResult: QuitFlushResult | undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    // The bound must never, by itself, keep a quitting process alive.
    (timer as { unref?: () => void }).unref?.();
  });
  // Set when the timeout wins: the abandoned run stops at its next pass
  // boundary instead of looping flushes in a process that is quitting.
  let abandoned = false;
  const run = (async (): Promise<QuitFlushOutcome> => {
    for (;;) {
      if (abandoned) {
        return { status: 'timeout', flushedOps, lastResult };
      }
      const res = await deps.flush(deps.reason ?? 'app-quit');
      lastResult = res;
      flushedOps += res.flushedOps;
      if (res.caughtUp) {
        return { status: flushedOps > 0 ? 'flushed' : 'noop', flushedOps, lastResult };
      }
      if (res.flushedOps === 0) {
        // Uncaught but a pass wrote nothing: no destination, or the
        // checkpoint failed and left the batch pending (the flush
        // primitive already logged it). Do not spin inside quit.
        return { status: 'failed', flushedOps, lastResult };
      }
      // Wrote ops but still behind (coalesced onto an earlier cut):
      // loop for the next pass; the outer timeout bounds the total.
    }
  })();
  // If the timeout wins, a later rejection of the abandoned flush run
  // must not surface as an unhandled rejection during process exit.
  void run.catch(() => undefined);
  try {
    const winner = await Promise.race([
      run.then((outcome) => ({ kind: 'done' as const, outcome })),
      timeout.then(() => ({ kind: 'timeout' as const })),
    ]);
    if (winner.kind === 'timeout') {
      abandoned = true;
      log(
        `[close-flush] quit flush did not finish within ${timeoutMs} ms — proceeding with quit; ` +
          'the destination keeps its last atomically-written state',
      );
      return { status: 'timeout', flushedOps, lastResult };
    }
    const outcome = winner.outcome;
    if (outcome.status === 'flushed') {
      log(
        `[close-flush] quit flush wrote ${outcome.flushedOps} op(s); storage caught up at revision ${outcome.lastResult?.storageRevision ?? '?'}`,
      );
    } else if (outcome.status === 'failed') {
      log(
        '[close-flush] quit flush could not cover the pending batch (no destination or checkpoint failed) — proceeding with quit',
      );
    }
    return outcome;
  } catch (e) {
    // flushDesktopCheckpoint never throws by contract, but the quit
    // path must survive a flush primitive that does.
    log(
      `[close-flush] quit flush threw (${e instanceof Error ? e.message : String(e)}) — proceeding with quit`,
    );
    return {
      status: 'failed',
      flushedOps,
      lastResult,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// before-quit controller (the Electron-facing state machine)
// ---------------------------------------------------------------------------

/** The structural slice of Electron's BeforeQuitEvent this needs. */
export interface BeforeQuitEventLike {
  preventDefault(): void;
}

export interface QuitFlushControllerDeps extends FlushBeforeQuitDeps {
  /**
   * Synchronous teardown that must run ONLY after the flush settles:
   * MCP ingress close, parallel-worker dispose, engine-host dispose.
   * Disposing the host before the flush would destroy the live model
   * the flush serializes — that ordering was the original defect.
   */
  teardown: () => void;
  /** Re-issue the quit once the flush + teardown have run (app.quit). */
  quit: () => void;
  /**
   * Issue #57: asked when the flush leaves user work UNCOVERED
   * (outcomeLeavesWorkUncovered) — e.g. a never-saved workbook or a
   * failed checkpoint. Resolve true to quit anyway (the uncovered work
   * is discarded), false to ABORT the quit: nothing is torn down, the
   * controller returns to 'idle', and the user can save and quit
   * again. When absent, uncovered work never blocks the quit (the
   * pre-#57 behavior).
   */
  confirmUncovered?: (outcome: QuitFlushOutcome) => Promise<boolean>;
  /**
   * Issue #57: force-close the app's windows on the proceed path,
   * BEFORE teardown. window.destroy() skips the renderer's unload
   * handlers by design — the renderer's beforeunload dirty veto
   * (which shows no prompt in Electron) otherwise cancels the window
   * close and silently swallows the whole quit AFTER teardown has
   * already disposed the engine.
   */
  destroyWindows?: () => void;
}

export interface QuitFlushController {
  /**
   * Handle one `before-quit` event. The FIRST event is intercepted
   * (preventDefault) and starts the bounded flush; events arriving
   * while the flush runs are also intercepted (the quit must not slip
   * through mid-flush) without starting a second flush; the event
   * fired by the controller's own re-issued quit — after the flush has
   * settled and teardown has run — is allowed through untouched.
   * Returns the flush outcome promise on the intercepting call
   * (Electron ignores it; tests await it). When the confirm gate
   * aborts the quit, the promise still resolves with the outcome and
   * the phase returns to 'idle'.
   */
  handleBeforeQuit: (
    event: BeforeQuitEventLike,
  ) => Promise<QuitFlushOutcome> | undefined;
  /**
   * Start the guarded quit flow WITHOUT a before-quit event (issue
   * #57: the non-macOS window-close path — closing the window IS
   * quitting there, and the close event is intercepted in main and
   * routed here). No-op while a flow is already running; re-issues
   * quit() directly once the flow has completed ('done').
   */
  requestQuit: () => Promise<QuitFlushOutcome> | undefined;
  /**
   * Run ONLY the bounded flush (no teardown, no quit, no confirm
   * gate) — the macOS window-close path: the app outlives its window
   * there, but pending work must be flushed (and, per the wiring,
   * confirmed) before the window is allowed to go away.
   */
  flushOnly: (reason: string) => Promise<QuitFlushOutcome>;
  /** 'idle' → 'flushing' → 'done' (done = re-issued quit may proceed). */
  readonly phase: 'idle' | 'flushing' | 'done';
}

export function createQuitFlushController(
  deps: QuitFlushControllerDeps,
): QuitFlushController {
  let phase: 'idle' | 'flushing' | 'done' = 'idle';

  /** The one guarded-quit flow (flush → confirm gate → proceed). */
  async function runGuardedQuit(): Promise<QuitFlushOutcome> {
    let outcome: QuitFlushOutcome;
    try {
      outcome = await flushBeforeQuit(deps);
    } catch (e) {
      // flushBeforeQuit never throws by contract; the quit path
      // must survive even if that contract is ever broken.
      outcome = {
        status: 'failed',
        flushedOps: 0,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    // Issue #57 confirm gate: uncovered work asks before it is
    // discarded. A "stay" answer aborts cleanly — NO teardown has run,
    // the engine and window are untouched, and quit can be retried.
    if (outcomeLeavesWorkUncovered(outcome) && deps.confirmUncovered) {
      let proceed = false;
      try {
        proceed = await deps.confirmUncovered(outcome);
      } catch (e) {
        deps.log?.(
          `[close-flush] quit confirmation failed (${e instanceof Error ? e.message : String(e)}) — quit aborted`,
        );
        proceed = false;
      }
      if (!proceed) {
        deps.log?.(
          '[close-flush] quit aborted: unsaved changes could not be written and the user chose to stay',
        );
        phase = 'idle';
        return outcome;
      }
    }
    // Proceed: force-close the windows FIRST (issue #57 — destroy()
    // skips the renderer's beforeunload veto, which otherwise silently
    // swallows the quit here, after teardown), then teardown AFTER the
    // flush settles, exactly once, then re-issue the quit. The
    // re-issued quit re-enters handleBeforeQuit with phase 'done' and
    // passes through. Errors are logged, never thrown: a dying host
    // must not turn the quit path into an unhandled rejection.
    if (deps.destroyWindows) {
      try {
        deps.destroyWindows();
      } catch (e) {
        deps.log?.(
          `[close-flush] window destroy threw (${e instanceof Error ? e.message : String(e)}) — proceeding with quit`,
        );
      }
    }
    try {
      deps.teardown();
    } catch (e) {
      deps.log?.(
        `[close-flush] teardown threw (${e instanceof Error ? e.message : String(e)}) — proceeding with quit`,
      );
    }
    phase = 'done';
    try {
      deps.quit();
    } catch (e) {
      deps.log?.(
        `[close-flush] re-issued quit threw (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    return outcome;
  }

  return {
    get phase() {
      return phase;
    },
    handleBeforeQuit(event: BeforeQuitEventLike) {
      if (phase === 'done') return undefined; // our re-issued quit: let it through
      event.preventDefault();
      if (phase === 'flushing') return undefined; // one flush only
      phase = 'flushing';
      return runGuardedQuit();
    },
    requestQuit() {
      if (phase === 'done') {
        // The guarded flow already ran; a fresh quit request just
        // re-issues (its before-quit passes through by phase).
        try {
          deps.quit();
        } catch {
          // Same never-throw rule as the flow's own re-issue.
        }
        return undefined;
      }
      if (phase === 'flushing') return undefined; // one flush only
      phase = 'flushing';
      return runGuardedQuit();
    },
    flushOnly(reason: string) {
      return flushBeforeQuit({ ...deps, reason });
    },
  };
}

/** The structural slice of Electron's App this module registers on. */
export interface AppLike {
  on(
    channel: 'before-quit',
    listener: (event: BeforeQuitEventLike) => void,
  ): unknown;
}

/**
 * Register the quit-flush controller on the app's `before-quit` event
 * (the main.ts wiring). Returns the controller so callers/tests can
 * inspect its phase. Electron ignores the handler's return value; the
 * controller's promise is caught here as a last line of defence so the
 * quit path can never surface an unhandled rejection.
 */
export function installCloseFlush(
  appLike: AppLike,
  deps: QuitFlushControllerDeps,
): QuitFlushController {
  const controller = createQuitFlushController(deps);
  appLike.on('before-quit', (event) => {
    void controller.handleBeforeQuit(event)?.catch(() => undefined);
  });
  return controller;
}
