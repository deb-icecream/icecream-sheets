/**
 * Engine IPC wiring (Cycle 10 — desktop engine/view separation).
 *
 * Registers the validated engine:* IPC channels against an injected
 * ipcMain-like object so the wiring is unit-testable without booting
 * Electron (same pattern as ./auth-ipc).
 *
 * The user's workbook lives in the MAIN process's EngineHost; the
 * renderer is a pure consumer over this bridge (window.icecream). The
 * renderer NEVER parses or builds a workbook: opens go through
 * `engine:load`, which parses (storage adapter) + builds (EngineWorkbook)
 * in the main process via ./engine-load and installs the workbook into
 * the host. ipcRenderer.sendSync is forbidden by design — every channel
 * here is Promise-based invoke/handle, so no engine call can block the
 * renderer's UI thread.
 *
 * Channels:
 *   engine:execute        (EngineCommand) → CommandResult (+ post-edit
 *                         values for cell edits — see DesktopEditReplyValue)
 *   engine:readCell       (CellRef) → TypedValue
 *   engine:readRange      (RangeRef) → TypedValue[][]
 *   engine:usedRange      (sheet name) → RangeRef | null
 *   engine:snapshot       () → WorkbookSnapshot
 *   engine:protocolVersion () → number
 *   engine:load           ({bytes: Uint8Array, filename}) → EngineLoadResult
 *                         (a legacy number[] payload is still accepted
 *                         and validated per byte — see the handler)
 *   engine:new            () → void — reset the host to a blank workbook
 *   engine:protection     (Record<string, unknown>) → void — the renderer
 *                         pushes its ProtectionManager state (toMetadata)
 *                         so the main-process host enforces the same
 *                         policy: cell locking, structure flags, hidden
 *                         cells (protection faces c/d/e) — including for
 *                         MCP clients, who now hit this host directly.
 *
 * ---------------------------------------------------------------------------
 * DISPLAY IS PROGRESSIVE; MUTATION IS GATED (user's design line, Cycle 10)
 * ---------------------------------------------------------------------------
 * This protocol is built for progressive rendering: the renderer requests
 * viewport-first data (readRange on the visible region first) and streams
 * the rest; a region it has not received yet is UNLOADED — the renderer
 * shows a loading state and never presents stale/empty data as final.
 * Engine events (pushed main→renderer) mark what changed; cached values
 * for changed refs are invalidated, not trusted. Mutation stays gated at
 * 100% load: edit/save/autosave/export are disabled by the app until the
 * workbook is fully loaded (engine:load resolved + hydration done), so no
 * half-built model can ever be edited or serialized back empty.
 */

import {
  ENGINE_PROTOCOL_VERSION,
  routeRecalc,
  shouldEnableParallelRecalc,
  type CellRef,
  type CommandResult,
  type EngineHost,
  type EngineCommand,
  type EngineLoadResult,
  type EngineWorkbook,
  type RecalcRouteDecision,
  type TypedValue,
  type WorkbookSnapshot,
} from '@icecream-sheets/engine';
import { buildWorkbookFromBytes, resetDesktopSaveBase } from './engine-load';
import {
  clearAutosaveTarget,
  clearDesktopSaveOps,
  flushCheckpointBeforeStructuralOp,
  isSavePinOverflowError,
  loadDirectSaveMutatingOps,
  noteDesktopLoadForAutosave,
  noteDesktopSaveOp,
} from './direct-save';

/**
 * One cell's post-edit state riding an execute reply (issue #58: the
 * desktop twin of the gateway's ack pattern). The renderer seeds its
 * value/formula caches from these entries instead of re-fetching the
 * edited cell and its dependents over IPC after every edit.
 */
export interface DesktopEditReplyValue {
  ref: CellRef;
  /** The cell's computed value after the edit's evaluation. */
  value: TypedValue;
  /**
   * Only on the EDITED cell's entry: its post-edit formula state was
   * read back authoritatively from the host. `formula` is present when
   * the cell holds a formula (normalized text, '='-prefixed); absent
   * with formulaKnown set means the cell holds a literal.
   */
  formulaKnown?: boolean;
  formula?: string;
}

/**
 * Reply-values cap: beyond this many changed cells the dispatch omits
 * `values` and the renderer falls back to the event/fill path (the same
 * behavior the reply had before issue #58). Whole-workbook-scale edits
 * are cheaper to stream than to inline.
 */
export const MAX_REPLY_VALUE_CELLS = 10_000;

function replyValueKey(ref: CellRef): string {
  return `${ref.sheet}!${ref.row},${ref.col}`;
}

/**
 * Desktop edit dispatch (Cycle 10 Phase 3): funnel one command through
 * the SAME pure routing policy the web gateway flow uses
 * (calc-chain.ts routeRecalc), with the main-process engine in the
 * "server" role:
 *  - The desktop engine is local and always present, so the routing
 *    mirror-mode input is 'mirror' (the engine itself is the authority;
 *    HYBRID-CONSISTENCY.md §3 local-only contexts).
 *  - SERIAL ONLY (owner ruling, 2026-10-23): every edit executes
 *    exactly once and HyperFormula's inline recalc of the affected
 *    chains is the edit's ONLY evaluation — there is NO parallel
 *    follow-up in this dispatch anymore. The route is still measured
 *    and the decision returned (the routing policy surface is intact
 *    for diagnostics and for the day parallel recalc returns), but no
 *    decision triggers a second pass.
 *  - Structural edits just execute (the graph shape changes).
 *  - On success the reply carries the post-edit values of the edited
 *    cell and every dependent the engine reported changed (capped at
 *    MAX_REPLY_VALUE_CELLS) so the edit completes in ONE roundtrip.
 *
 * ISSUE #58 — why parallel recalc is NOT composed here (the measured
 * record behind the owner's serial-only ruling): the suspended-apply
 * composition (suspendEvaluation → apply → recalculateParallel as the
 * only evaluation) was implemented and reverted on probe evidence
 * (this program's desktop probe + the #60 worker's gateway probes,
 * WEB-DOUBLECALC-FIX-REPORT.md §3):
 *  (1) Leaving the hold outstanding after the merge breaks reads:
 *      HyperFormula throws "Computations are suspended" from guarded
 *      APIs — on the desktop host, after ONE parallel edit with the
 *      hold outstanding, readCell of an empty untracked cell,
 *      readRange spanning empty cells, snapshot(), and bulkReadback()
 *      (the checkpoint path) ALL threw; only tracked-cell reads serve
 *      the cache. The grid reads ranges spanning empties constantly,
 *      so the app cannot sit in the held state.
 *  (2) Closing the hold per edit re-creates the second evaluation:
 *      resumeEvaluation() after a parallel merge RE-DERIVES the whole
 *      dirty closure serially (desktop probe: a 61-ref wave for a
 *      60-dependent closure; #60's dist probe: 2,101 refs, ~103 ms).
 *      HyperFormula exposes no API to adopt externally computed values
 *      or clear its dirty set.
 * True parallel recalc is future work (tracked by its own issue): it
 * needs an ENGINE merge-finalize primitive that adopts the parallel
 * merge's values into HyperFormula and clears its dirtiness (the #60
 * report's Option A), after which a suspended apply can end with
 * neither re-derivation nor a held state. Explicit recalculate /
 * recalculateParallel COMMANDS (a user-requested full recalc) still
 * run through the pool path above — they are not edit follow-ups.
 * Returns the command result plus the routing decision (null for
 * non-edit commands) so tests/diagnostics can pin the dispatch.
 */
export async function dispatchDesktopEdit(
  host: EngineHost,
  command: EngineCommand,
): Promise<{
  result: CommandResult;
  decision: RecalcRouteDecision | null;
  values?: DesktopEditReplyValue[];
}> {
  if (command.cmd === 'recalculate' || command.cmd === 'recalculateParallel') {
    const res = await host.executeAsync({ cmd: 'recalculateParallel' });
    return {
      result: res.ok && 'stats' in res ? { ok: true, data: res.stats } : res,
      decision: null,
    };
  }
  if (command.cmd !== 'setCell' && command.cmd !== 'setFormula') {
    return { result: host.execute(command), decision: null };
  }
  let decision: RecalcRouteDecision | null = null;
  let measuredCells: readonly CellRef[] = [];
  try {
    const thresholds = host.hybridRecalcConfig();
    const m = host.measureCalcChain(command.ref, {
      maxNodes: thresholds.chainLengthThreshold + 1,
    });
    measuredCells = m.cells;
    decision = routeRecalc({
      affectedCellCount: m.affectedCount,
      shape: m.shape,
      chainLength: m.chainLength,
      thresholds,
      mirrorMode: 'mirror',
      mtEnabled: shouldEnableParallelRecalc(host.totalCellCount(), thresholds.mtCellCountThreshold),
      context: { measurementExact: m.exact, localEngineAvailable: true, mirrorInSync: true },
    });
  } catch {
    // Measurement must never block an edit: serial is the safe path.
    decision = null;
  }

  // Collect every ref this edit changes — the edited cell, the measured
  // dependents, and every ref the engine reports while the dispatch
  // runs (the single inline recalc) — so their fresh values can ride
  // the reply (one roundtrip per edit).
  const changed = new Map<string, CellRef>();
  const noteRef = (ref: CellRef): void => {
    changed.set(replyValueKey(ref), ref);
  };
  noteRef(command.ref);
  for (const ref of measuredCells) noteRef(ref);
  const unsubscribe = host.subscribe((event) => {
    if (event.type === 'cellsChanged') {
      for (const ref of event.refs) noteRef(ref);
    }
  });

  let result: CommandResult;
  try {
    // SERIAL ONLY (owner ruling, 2026-10-23): one execute, one inline
    // evaluation. No parallel follow-up is issued for ANY decision —
    // see the issue-#58 note above for the measured reasons and the
    // merge-finalize primitive that unblocks true parallel recalc.
    result = host.execute(command);
  } finally {
    unsubscribe();
  }

  let values: DesktopEditReplyValue[] | undefined;
  if (result.ok && changed.size <= MAX_REPLY_VALUE_CELLS) {
    values = [];
    for (const ref of changed.values()) {
      const entry: DesktopEditReplyValue = { ref, value: host.readCell(ref) };
      if (replyValueKey(ref) === replyValueKey(command.ref)) {
        entry.formulaKnown = true;
        const formula = host.getView().readCell(ref).formula;
        if (formula !== undefined) entry.formula = formula;
      }
      values.push(entry);
    }
  }
  return { result, decision, values };
}

/** Save-pin overflow retry cadence (Addendum 4): poll every 25 ms, up to 30 s. */
export const SAVE_PIN_RETRY_POLL_MS = 25;
export const SAVE_PIN_RETRY_TIMEOUT_MS = 30_000;

export interface SavePinRetryOptions {
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (m: string) => void;
}

/**
 * Execute with save-pin overflow queueing (Addendum 4, mirroring the
 * gateway): while a save pin is active, the engine throws
 * SavePinOverflowError for un-stashable/structural ops and the op is
 * NOT applied — so the execute is retried after the pin releases
 * (poll 25 ms, up to 30 s, queueing logged once). The op is never lost
 * silently: after the timeout the overflow error propagates and the
 * handler surfaces it as a failed command result. Non-overflow errors
 * propagate immediately.
 */
export async function dispatchDesktopEditWithSavePinRetry(
  host: EngineHost,
  command: EngineCommand,
  opts: SavePinRetryOptions = {},
): Promise<{
  result: CommandResult;
  decision: RecalcRouteDecision | null;
  values?: DesktopEditReplyValue[];
}> {
  const pollMs = opts.pollMs ?? SAVE_PIN_RETRY_POLL_MS;
  const timeoutMs = opts.timeoutMs ?? SAVE_PIN_RETRY_TIMEOUT_MS;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  let logged = false;
  for (;;) {
    try {
      return await dispatchDesktopEdit(host, command);
    } catch (error) {
      if (!isSavePinOverflowError(error)) throw error;
      if (now() - startedAt >= timeoutMs) throw error;
      if (!logged) {
        logged = true;
        (opts.log ?? ((m: string) => console.log(m)))(
          `[engine-ipc] execute ${command.cmd} queued behind an active save pin (SavePinOverflowError) — retrying until the pin releases`,
        );
      }
      await sleep(pollMs);
    }
  }
}

export interface EngineIpcMain {
  handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void;
}

export interface EngineIpcDeps {
  /** The current main-process engine host (stable instance). */
  getHost: () => EngineHost;  /**
   * Install a freshly built workbook into the host (open path): tears
   * down the old workbook's worker pool, replaceWorkbook(), re-enables
   * the parallel-recalc pool on the new workbook. main.ts implements.
   */
  swapWorkbook: (workbook: EngineWorkbook) => void;
  /** Reset the host to a blank workbook (New path). main.ts implements. */
  resetWorkbook: () => void;
  /**
   * Apply the renderer-pushed protection state (ProtectionManager
   * toMetadata) to the host's authorizer + hidden-cell check.
   * main.ts implements.
   */
  applyProtection: (state: Record<string, unknown>) => void;
  /**
   * Called when a new workbook becomes current: with the filename the
   * load carried (desktop file opens carry the ABSOLUTE path) after
   * engine:load installs it, and with null after engine:new. main.ts
   * re-scopes the trigger host from this (triggers.ts setScope).
   */
  onWorkbookCurrent?: (filename: string | null) => void;
  /** Injected for tests. */
  buildWorkbookFn?: typeof buildWorkbookFromBytes;
}

/** Hard cap on one engine:load payload (IPC DoS guard). */
export const MAX_LOAD_BYTES = 512 * 1024 * 1024;

// ---------------------------------------------------------------------------
// IPC input validation (never trust the renderer blindly)
// ---------------------------------------------------------------------------

/** The full EngineCommand verb set (engine protocol, protocol.ts). */
const KNOWN_COMMANDS: ReadonlySet<string> = new Set([
  'setCell',
  'setFormula',
  'addSheet',
  'deleteSheet',
  'renameSheet',
  'duplicateSheet',
  'moveSheet',
  'setCalculationMode',
  'recalculate',
  'setParallelRecalcOptions',
  'recalculateParallel',
  'defineName',
  'deleteName',
  'renameName',
  'updateNameRefersTo',
  'defineFunction',
  'updateFunction',
  'rollbackFunction',
  'deleteFunction',
  'insertRows',
  'deleteRows',
  'insertCols',
  'deleteCols',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCellRef(value: unknown): value is { sheet: string; row: number; col: number } {
  return (
    isRecord(value) &&
    typeof value['sheet'] === 'string' &&
    typeof value['row'] === 'number' &&
    Number.isInteger(value['row']) &&
    typeof value['col'] === 'number' &&
    Number.isInteger(value['col'])
  );
}

function isRangeRef(value: unknown): value is {
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
} {
  return (
    isRecord(value) &&
    typeof value['sheet'] === 'string' &&
    typeof value['startRow'] === 'number' &&
    typeof value['startCol'] === 'number' &&
    typeof value['endRow'] === 'number' &&
    typeof value['endCol'] === 'number'
  );
}

function toErrorResult(error: unknown): CommandResult {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

export function registerEngineIpc(ipcMain: EngineIpcMain, deps: EngineIpcDeps): void {
  const buildWorkbookFn = deps.buildWorkbookFn ?? buildWorkbookFromBytes;

  ipcMain.handle(
    'engine:execute',
    async (
      _event: unknown,
      command: unknown,
    ): Promise<CommandResult & { values?: DesktopEditReplyValue[] }> => {
      if (
        !isRecord(command) ||
        typeof command['cmd'] !== 'string' ||
        !KNOWN_COMMANDS.has(command['cmd'])
      ) {
        return { ok: false, error: 'engine:execute: unknown or malformed command' };
      }
      try {
        const host = deps.getHost();
        // STRUCTURAL-OP BARRIER (Addendum 5): a structural op (not a
        // cell op, not name-family) flushes any pending checkpoint
        // batch BEFORE it is applied, so the structural op starts a
        // fresh batch. Best-effort by design (no destination / failed
        // checkpoint → the op still applies, the batch stays pending);
        // never let barrier bookkeeping fail an edit.
        try {
          await flushCheckpointBeforeStructuralOp(
            (command as { cmd: string }).cmd,
          );
        } catch {
          // The barrier is checkpoint scheduling, not edit state.
        }
        // RECALC DISPATCH — the user's final routing rule (Cycle 10),
        // applied with the main-process engine in the "server" role.
        // dispatchDesktopEdit funnels every command through the pure
        // routeRecalc policy: multi-chain edits on flag-ON workbooks
        // follow up through the parallel worker pool; everything else
        // takes the serial path.
        const { result, values } = await dispatchDesktopEditWithSavePinRetry(
          host,
          command as EngineCommand,
        );
        if (result.ok) {
          // Direct-save op journal (direct-save pass): every SUCCESSFUL
          // mutating command is journaled for the shared streaming
          // serializer (which sheets changed / verbatim eligibility).
          // Journaling must never fail an edit that already applied.
          try {
            const mutating = await loadDirectSaveMutatingOps();
            const cmd = command as { cmd: string; ref?: { sheet: string; row: number; col: number } };
            if (mutating.has(cmd.cmd)) {
              noteDesktopSaveOp(cmd.ref ? { cmd: cmd.cmd, ref: cmd.ref } : { cmd: cmd.cmd });
            }
          } catch {
            // The journal is save fidelity state, not edit state.
          }
        }
        // Issue #58: the edited cell's and its dependents' fresh values
        // ride the reply — the renderer seeds its caches from them and
        // the edit completes in one roundtrip (no readCell re-fetch).
        return values ? { ...result, values } : result;
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  ipcMain.handle(
    'engine:readCell',
    (_event: unknown, ref: unknown): { value: TypedValue; formula?: string } => {
      if (!isCellRef(ref)) {
        return {
          value: { kind: 'error', code: '#VALUE!', message: 'engine:readCell: expected {sheet,row,col}' },
        };
      }
      const host = deps.getHost();
      const value = host.readCell(ref);
      // The formula rides along like the gateway's cell read — but never
      // past authorization: a #PERM! read withholds the formula too (the
      // formula text of a readable cell is readable; of a denied cell it
      // would leak what the denial hides).
      const formula =
        value.kind === 'error' && value.code === '#PERM!'
          ? undefined
          : host.getView().readCell(ref).formula;
      return formula === undefined ? { value } : { value, formula };
    },
  );

  ipcMain.handle('engine:readRange', (_event: unknown, range: unknown): TypedValue[][] => {
    if (!isRangeRef(range)) {
      return [[{ kind: 'error', code: '#VALUE!', message: 'engine:readRange: expected a range ref' }]];
    }
    return deps.getHost().readRange(range);
  });

  ipcMain.handle('engine:snapshot', (): WorkbookSnapshot => deps.getHost().snapshot());

  /**
   * The used range of one sheet, or null when empty. Exists so the
   * renderer never has to pull a full snapshot just to size a sheet
   * (the audit's broken pattern — 1.8M cells of JSON to learn bounds).
   */
  ipcMain.handle(
    'engine:usedRange',
    (_event: unknown, sheet: unknown): { sheet: string; startRow: number; startCol: number; endRow: number; endCol: number } | null => {
      if (typeof sheet !== 'string' || sheet === '') {
        throw new Error('engine:usedRange: expected a sheet name');
      }
      return deps.getHost().getUsedRange(sheet);
    },
  );

  ipcMain.handle('engine:protocolVersion', (): number => ENGINE_PROTOCOL_VERSION);

  /**
   * Open path: bytes + filename → parse + build in the main process,
   * workbook installed into the host, IPC-safe summary returned. The
   * renderer's UI thread does no parsing, no building, no recalc.
   */
  ipcMain.handle(
    'engine:load',
    async (_event: unknown, args: unknown): Promise<EngineLoadResult> => {
      if (
        !isRecord(args) ||
        !(args['bytes'] instanceof Uint8Array || Array.isArray(args['bytes'])) ||
        typeof args['filename'] !== 'string' ||
        args['filename'] === ''
      ) {
        throw new Error('engine:load: expected {bytes: Uint8Array, filename: string}');
      }
      const raw = args['bytes'] as Uint8Array | number[];
      if (raw.length > MAX_LOAD_BYTES) {
        throw new Error(`engine:load: file too large (${raw.length} bytes, max ${MAX_LOAD_BYTES})`);
      }
      let bytes: Uint8Array;
      if (raw instanceof Uint8Array) {
        // Binary transfer (Cycle 10 closure): Electron's structured
        // clone delivers the renderer's Uint8Array as a fresh
        // Uint8Array — every element is a byte by construction, and no
        // per-byte JS walk runs on either side of the channel. This
        // replaced the number[] payload whose renderer-side Array.from
        // + element-wise clone was the worst renderer task of an open.
        bytes = raw;
      } else {
        // Legacy number[] payload: validate byte-valued before
        // conversion, exactly as before.
        for (let i = 0; i < raw.length; i++) {
          const b = raw[i];
          if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255) {
            throw new Error(`engine:load: bytes[${i}] is not a byte value`);
          }
        }
        bytes = new Uint8Array(raw);
      }
      const { workbook, result } = await buildWorkbookFn(
        bytes,
        args['filename'] as string,
      );
      deps.swapWorkbook(workbook);
      // Direct-save state: the load just retained a fresh save base in
      // engine-load (buildWorkbookFromBytes) — the op journal restarts
      // from this workbook, so pre-load ops never replay onto it.
      clearDesktopSaveOps();
      // Checkpoint target (Addendum 3): a load filename that is an
      // absolute path IS the opened file's destination (desktop file
      // opens pass the full path); a bare name (library/URL) clears
      // the target so no background writes occur for it.
      noteDesktopLoadForAutosave(args['filename'] as string);
      // The new workbook is current now: dependents that scope to the
      // workbook identity (the trigger host) re-scope to the path this
      // load carried and fire their onOpen against the new workbook.
      deps.onWorkbookCurrent?.(args['filename'] as string);
      return result;
    },
  );

  /** New-workbook path: reset the main-process host to a blank workbook. */
  ipcMain.handle('engine:new', (): void => {
    deps.resetWorkbook();
    // Direct-save state: a blank workbook has no source package and no
    // journal — the serializer synthesizes the package from the live
    // model alone.
    resetDesktopSaveBase();
    clearDesktopSaveOps();
    clearAutosaveTarget();
    // A blank workbook has no file path: workbook-scoped dependents
    // (the trigger host) fall back to the untitled scope.
    deps.onWorkbookCurrent?.(null);
  });

  /** Protection sync: the renderer's ProtectionManager state, as data. */
  ipcMain.handle('engine:protection', (_event: unknown, state: unknown): void => {
    if (!isRecord(state)) {
      throw new Error('engine:protection: expected a protection state record');
    }
    deps.applyProtection(state);
  });
}
