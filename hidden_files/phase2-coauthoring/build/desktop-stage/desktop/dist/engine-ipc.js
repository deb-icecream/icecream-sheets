"use strict";
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
 *   engine:execute        (EngineCommand) → CommandResult
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_LOAD_BYTES = exports.SAVE_PIN_RETRY_TIMEOUT_MS = exports.SAVE_PIN_RETRY_POLL_MS = void 0;
exports.dispatchDesktopEdit = dispatchDesktopEdit;
exports.dispatchDesktopEditWithSavePinRetry = dispatchDesktopEditWithSavePinRetry;
exports.registerEngineIpc = registerEngineIpc;
const engine_1 = require("@icecream-sheets/engine");
const engine_load_1 = require("./engine-load");
const direct_save_1 = require("./direct-save");
/**
 * Desktop edit dispatch (Cycle 10 Phase 3): funnel one command through
 * the SAME pure routing policy the web gateway flow uses
 * (calc-chain.ts routeRecalc), with the main-process engine in the
 * "server" role:
 *  - The desktop engine is local and always present, so the routing
 *    mirror-mode input is 'mirror' (the engine itself is the authority;
 *    HYBRID-CONSISTENCY.md §3 local-only contexts).
 *  - Edits execute serially on the host first (the engine recalcs only
 *    the affected chains, in topological order).
 *  - When the decision says multiple chains AND the MT auto-flag is ON
 *    (serverThreading 'parallel'), the follow-up full recalc runs
 *    through the worker pool (executeAsync 'recalculateParallel'),
 *    which itself falls back to serial when no stage parallelizes.
 *  - A long SINGLE chain stays single-threaded (it cannot parallelize);
 *    structural edits just execute (the graph shape changes).
 * Returns the command result plus the routing decision (null for
 * non-edit commands) so tests/diagnostics can pin the dispatch.
 */
async function dispatchDesktopEdit(host, command) {
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
    let decision = null;
    try {
        const thresholds = host.hybridRecalcConfig();
        const m = host.measureCalcChain(command.ref, {
            maxNodes: thresholds.chainLengthThreshold + 1,
        });
        decision = (0, engine_1.routeRecalc)({
            affectedCellCount: m.affectedCount,
            shape: m.shape,
            chainLength: m.chainLength,
            thresholds,
            mirrorMode: 'mirror',
            mtEnabled: (0, engine_1.shouldEnableParallelRecalc)(host.totalCellCount(), thresholds.mtCellCountThreshold),
            context: { measurementExact: m.exact, localEngineAvailable: true, mirrorInSync: true },
        });
    }
    catch {
        // Measurement must never block an edit: serial is the safe path.
        decision = null;
    }
    const result = host.execute(command);
    if (result.ok && decision?.route === 'server' && decision.serverThreading === 'parallel') {
        await host.executeAsync({ cmd: 'recalculateParallel' });
    }
    return { result, decision };
}
/** Save-pin overflow retry cadence (Addendum 4): poll every 25 ms, up to 30 s. */
exports.SAVE_PIN_RETRY_POLL_MS = 25;
exports.SAVE_PIN_RETRY_TIMEOUT_MS = 30_000;
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
async function dispatchDesktopEditWithSavePinRetry(host, command, opts = {}) {
    const pollMs = opts.pollMs ?? exports.SAVE_PIN_RETRY_POLL_MS;
    const timeoutMs = opts.timeoutMs ?? exports.SAVE_PIN_RETRY_TIMEOUT_MS;
    const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const now = opts.now ?? (() => Date.now());
    const startedAt = now();
    let logged = false;
    for (;;) {
        try {
            return await dispatchDesktopEdit(host, command);
        }
        catch (error) {
            if (!(0, direct_save_1.isSavePinOverflowError)(error))
                throw error;
            if (now() - startedAt >= timeoutMs)
                throw error;
            if (!logged) {
                logged = true;
                (opts.log ?? ((m) => console.log(m)))(`[engine-ipc] execute ${command.cmd} queued behind an active save pin (SavePinOverflowError) — retrying until the pin releases`);
            }
            await sleep(pollMs);
        }
    }
}
/** Hard cap on one engine:load payload (IPC DoS guard). */
exports.MAX_LOAD_BYTES = 512 * 1024 * 1024;
// ---------------------------------------------------------------------------
// IPC input validation (never trust the renderer blindly)
// ---------------------------------------------------------------------------
/** The full EngineCommand verb set (engine protocol, protocol.ts). */
const KNOWN_COMMANDS = new Set([
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
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function isCellRef(value) {
    return (isRecord(value) &&
        typeof value['sheet'] === 'string' &&
        typeof value['row'] === 'number' &&
        Number.isInteger(value['row']) &&
        typeof value['col'] === 'number' &&
        Number.isInteger(value['col']));
}
function isRangeRef(value) {
    return (isRecord(value) &&
        typeof value['sheet'] === 'string' &&
        typeof value['startRow'] === 'number' &&
        typeof value['startCol'] === 'number' &&
        typeof value['endRow'] === 'number' &&
        typeof value['endCol'] === 'number');
}
function toErrorResult(error) {
    return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
    };
}
function registerEngineIpc(ipcMain, deps) {
    const buildWorkbookFn = deps.buildWorkbookFn ?? engine_load_1.buildWorkbookFromBytes;
    ipcMain.handle('engine:execute', async (_event, command) => {
        if (!isRecord(command) ||
            typeof command['cmd'] !== 'string' ||
            !KNOWN_COMMANDS.has(command['cmd'])) {
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
                await (0, direct_save_1.flushCheckpointBeforeStructuralOp)(command.cmd);
            }
            catch {
                // The barrier is checkpoint scheduling, not edit state.
            }
            // RECALC DISPATCH — the user's final routing rule (Cycle 10),
            // applied with the main-process engine in the "server" role.
            // dispatchDesktopEdit funnels every command through the pure
            // routeRecalc policy: multi-chain edits on flag-ON workbooks
            // follow up through the parallel worker pool; everything else
            // takes the serial path.
            const { result } = await dispatchDesktopEditWithSavePinRetry(host, command);
            if (result.ok) {
                // Direct-save op journal (direct-save pass): every SUCCESSFUL
                // mutating command is journaled for the shared streaming
                // serializer (which sheets changed / verbatim eligibility).
                // Journaling must never fail an edit that already applied.
                try {
                    const mutating = await (0, direct_save_1.loadDirectSaveMutatingOps)();
                    const cmd = command;
                    if (mutating.has(cmd.cmd)) {
                        (0, direct_save_1.noteDesktopSaveOp)(cmd.ref ? { cmd: cmd.cmd, ref: cmd.ref } : { cmd: cmd.cmd });
                    }
                }
                catch {
                    // The journal is save fidelity state, not edit state.
                }
            }
            return result;
        }
        catch (error) {
            return toErrorResult(error);
        }
    });
    ipcMain.handle('engine:readCell', (_event, ref) => {
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
        const formula = value.kind === 'error' && value.code === '#PERM!'
            ? undefined
            : host.getView().readCell(ref).formula;
        return formula === undefined ? { value } : { value, formula };
    });
    ipcMain.handle('engine:readRange', (_event, range) => {
        if (!isRangeRef(range)) {
            return [[{ kind: 'error', code: '#VALUE!', message: 'engine:readRange: expected a range ref' }]];
        }
        return deps.getHost().readRange(range);
    });
    ipcMain.handle('engine:snapshot', () => deps.getHost().snapshot());
    /**
     * The used range of one sheet, or null when empty. Exists so the
     * renderer never has to pull a full snapshot just to size a sheet
     * (the audit's broken pattern — 1.8M cells of JSON to learn bounds).
     */
    ipcMain.handle('engine:usedRange', (_event, sheet) => {
        if (typeof sheet !== 'string' || sheet === '') {
            throw new Error('engine:usedRange: expected a sheet name');
        }
        return deps.getHost().getUsedRange(sheet);
    });
    ipcMain.handle('engine:protocolVersion', () => engine_1.ENGINE_PROTOCOL_VERSION);
    /**
     * Open path: bytes + filename → parse + build in the main process,
     * workbook installed into the host, IPC-safe summary returned. The
     * renderer's UI thread does no parsing, no building, no recalc.
     */
    ipcMain.handle('engine:load', async (_event, args) => {
        if (!isRecord(args) ||
            !(args['bytes'] instanceof Uint8Array || Array.isArray(args['bytes'])) ||
            typeof args['filename'] !== 'string' ||
            args['filename'] === '') {
            throw new Error('engine:load: expected {bytes: Uint8Array, filename: string}');
        }
        const raw = args['bytes'];
        if (raw.length > exports.MAX_LOAD_BYTES) {
            throw new Error(`engine:load: file too large (${raw.length} bytes, max ${exports.MAX_LOAD_BYTES})`);
        }
        let bytes;
        if (raw instanceof Uint8Array) {
            // Binary transfer (Cycle 10 closure): Electron's structured
            // clone delivers the renderer's Uint8Array as a fresh
            // Uint8Array — every element is a byte by construction, and no
            // per-byte JS walk runs on either side of the channel. This
            // replaced the number[] payload whose renderer-side Array.from
            // + element-wise clone was the worst renderer task of an open.
            bytes = raw;
        }
        else {
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
        const { workbook, result } = await buildWorkbookFn(bytes, args['filename']);
        deps.swapWorkbook(workbook);
        // Direct-save state: the load just retained a fresh save base in
        // engine-load (buildWorkbookFromBytes) — the op journal restarts
        // from this workbook, so pre-load ops never replay onto it.
        (0, direct_save_1.clearDesktopSaveOps)();
        // Checkpoint target (Addendum 3): a load filename that is an
        // absolute path IS the opened file's destination (desktop file
        // opens pass the full path); a bare name (library/URL) clears
        // the target so no background writes occur for it.
        (0, direct_save_1.noteDesktopLoadForAutosave)(args['filename']);
        return result;
    });
    /** New-workbook path: reset the main-process host to a blank workbook. */
    ipcMain.handle('engine:new', () => {
        deps.resetWorkbook();
        // Direct-save state: a blank workbook has no source package and no
        // journal — the serializer synthesizes the package from the live
        // model alone.
        (0, engine_load_1.resetDesktopSaveBase)();
        (0, direct_save_1.clearDesktopSaveOps)();
        (0, direct_save_1.clearAutosaveTarget)();
    });
    /** Protection sync: the renderer's ProtectionManager state, as data. */
    ipcMain.handle('engine:protection', (_event, state) => {
        if (!isRecord(state)) {
            throw new Error('engine:protection: expected a protection state record');
        }
        deps.applyProtection(state);
    });
}
//# sourceMappingURL=engine-ipc.js.map