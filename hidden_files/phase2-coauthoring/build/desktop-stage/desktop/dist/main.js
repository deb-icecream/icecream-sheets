"use strict";
/**
 * Icecream Sheets — Electron main process.
 *
 * Responsibilities:
 *  - Host exactly ONE EngineHost (the calculation engine) in the main
 *    process — this host holds the USER'S workbook (Cycle 10 engine/view
 *    separation: the engine runs off the renderer's UI thread, in the
 *    same Node.js process — thread separation, not a new process). The
 *    renderer is a pure consumer of the engine over the validated IPC
 *    bridge (`window.icecream`): opens go through `engine:load` (parse +
 *    EngineWorkbook build here, never in the renderer), edits/reads go
 *    through the async protocol ops, and engine events flow main→renderer
 *    over `icecream:engine-event` (the grid's live-update feed).
 *  - Serve the desktop MCP direct ingress (:8106) from the main-process
 *    host itself (platform-shell.md §8) — no forwarding: MCP clients see
 *    the same live workbook as the built-in UI, and the host enforces
 *    the renderer's protection policy (synced over `engine:protection`).
 *  - Expose a small, validated IPC surface to the renderer:
 *      engine:execute | engine:readCell | engine:readRange
 *      engine:snapshot | engine:protocolVersion
 *      engine:load | engine:new | engine:protection | engine:saveXlsxDirect
 *      auth:login | auth:loginWithFirebase | auth:logout | auth:status | auth:openLoginWindow
 *      file:pickOpen | file:saveBytes
 *      svc:call | mcp:url | renderer:ready
 *    and main→renderer event channels (icecream:engine-event,
 *    icecream:menu-open, icecream:menu-save, icecream:menu-save-as,
 *    icecream:menu-preferences, icecream:menu-help, icecream:open-path)
 *    exposed through the preload bridge. Events sent before the renderer
 *    is listening are queued and flushed when it signals ready (GAP-9);
 *    engine events are dropped instead of queued (a fresh renderer reads
 *    current values anyway).
 *  - Show the web UI from apps/web/dist when it exists, otherwise a
 *    fallback page that still proves the engine bridge works.
 *  - Own the native shell: app/window/menu, file dialogs, OS file
 *    association opens, and login-gated remote services (spec d).
 *
 * Security: contextIsolation is on, nodeIntegration is off; the renderer
 * only gets the `window.icecream` and `window.icecreamDesktop` APIs via the
 * preload script. File paths arriving from the renderer are validated
 * (see save-paths.ts) before any fs write.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAddonService = getAddonService;
const electron_1 = require("electron");
const path = __importStar(require("node:path"));
const fs = __importStar(require("node:fs"));
/**
 * Accessibility (design-docs/accessibility.md §3): force Chromium's
 * renderer accessibility tree ON, even when no assistive technology is
 * attached at launch. Without this, the platform tree (macOS
 * NSAccessibility / Windows UI Automation) is only built lazily when an
 * AT client attaches, which breaks programmatic inspection and some AT
 * attach flows. This switch does NOT disable anything — there is no
 * --disable-renderer-accessibility anywhere in this codebase by policy.
 */
electron_1.app.commandLine.appendSwitch('force-renderer-accessibility');
const engine_1 = require("@icecream-sheets/engine");
const engine_ipc_1 = require("./engine-ipc");
const engine_load_1 = require("./engine-load");
const direct_save_1 = require("./direct-save");
const fallback_1 = require("./fallback");
const paths_1 = require("./paths");
const save_paths_1 = require("./save-paths");
const parallel_config_1 = require("./parallel-config");
const services_1 = require("./services");
const auth_ipc_1 = require("./auth-ipc");
const firebase_config_1 = require("./firebase-config");
const firebase_login_page_1 = require("./firebase-login-page");
const login_server_1 = require("./login-server");
const mcp_1 = require("./mcp");
// ---------------------------------------------------------------------------
// GAP-4: OS file-association opens (double-click / "Open with" / dock drop)
//
// One instance only: a second launch forwards its workbook path to the
// already-running primary instance instead of opening a second window
// (multi-window is explicitly out of scope for v1 — platform-shell.md §9).
// ---------------------------------------------------------------------------
const isPrimaryInstance = electron_1.app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
    electron_1.app.quit();
}
else {
    electron_1.app.on('second-instance', (_event, argv) => {
        const win = mainWindow;
        if (win && !win.isDestroyed()) {
            if (win.isMinimized())
                win.restore();
            win.focus();
        }
        const filePath = (0, paths_1.findLaunchFilePath)(argv);
        if (filePath)
            openPathFromOs(filePath);
    });
}
// macOS: Finder delivers double-clicked documents through `open-file`,
// which can fire before `whenReady` — openPathFromOs queues the event via
// sendToRenderer (GAP-9) so nothing is lost before the renderer listens.
electron_1.app.on('open-file', (event, filePath) => {
    event.preventDefault();
    openPathFromOs(filePath);
});
let mainWindow = null;
/**
 * The single engine instance for the app lifetime — and the USER'S
 * workbook (Cycle 10: the workbook moved here from the renderer).
 * Mutations from the renderer arrive only through the validated IPC
 * handlers (./engine-ipc); the local desktop user is the principal
 * (engine default auth: allow-all policy with principal 'user',
 * composed with the synced protection policy below).
 *
 * The instance is stable for the app lifetime: opens and New swap the
 * WORKBOOK (engineHost.replaceWorkbook), never the host — so the MCP
 * ingress and the engine-event forwarder stay attached to the live
 * workbook across opens.
 */
let engineHost = new engine_1.EngineHost();
/**
 * Protection enforcement for the main-process host (protection model:
 * faces c/d/e). The ProtectionManager's state lives in the renderer
 * (per-user app state); the renderer pushes it over `engine:protection`
 * as metadata (toMetadata/fromMetadata) after every open and whenever
 * protection changes, and main wires the composed policy + hidden-cell
 * check onto the host — exactly like the renderer's wireProtection did
 * for its in-process host. The local user ('user') is the workbook
 * owner and exempt from cell hiding, mirroring the renderer's setup.
 */
const protectionManager = new engine_1.ProtectionManager();
protectionManager.setHiddenExemptPrincipals(['user']);
function wireEngineProtection() {
    engineHost.getAuthorizer().setPolicy(protectionManager.protectionPolicy((0, engine_1.allowAllPolicy)()));
    engineHost.setHiddenCheck((ref, principal) => protectionManager.isHiddenFrom(ref.sheet, ref.row, ref.col, principal));
}
function applyRendererProtection(state) {
    protectionManager.fromMetadata(state);
    wireEngineProtection();
}
let pendingRendererMessages = [];
let rendererReady = false;
/** Send to the renderer, queueing when it cannot receive yet (GAP-9). */
function sendToRenderer(channel, ...args) {
    const win = mainWindow;
    // Queue while the renderer has not signaled ready: the window can exist
    // while its preload listeners are not yet attached (e.g. right after
    // launch or reload), and webContents.send() to a not-yet-listening
    // renderer is silently dropped.
    if (!rendererReady || !win || win.isDestroyed()) {
        pendingRendererMessages.push({ channel, args });
        return;
    }
    win.webContents.send(channel, ...args);
}
/** Flush queued messages once the renderer reports it is listening. */
function flushPendingRendererMessages() {
    rendererReady = true;
    const queued = pendingRendererMessages;
    pendingRendererMessages = [];
    const win = mainWindow;
    if (!win || win.isDestroyed())
        return;
    for (const msg of queued) {
        win.webContents.send(msg.channel, ...msg.args);
    }
}
// ---------------------------------------------------------------------------
// Main → renderer engine events (Cycle 10)
//
// Engine events (cellsChanged / recalcComplete / sheetAdded / sheetRemoved)
// originate in the main-process host now. The grid's live updates render
// from this feed (preload's window.icecream.onEngineEvent). Unlike
// sendToRenderer, events are DROPPED while the renderer is not listening:
// a fresh page reads current values on load anyway, and queueing
// per-keystroke cellsChanged across a reload would pile up unboundedly.
// ---------------------------------------------------------------------------
/** Push one engine event to the renderer (drops when it can't receive). */
function sendEngineEvent(event) {
    const win = mainWindow;
    if (!rendererReady || !win || win.isDestroyed())
        return;
    win.webContents.send('icecream:engine-event', event);
}
/**
 * Attach the main→renderer event forwarder to the engine host. The host
 * instance is stable for the app lifetime (opens swap the workbook via
 * replaceWorkbook, which emits recalcComplete), so this is called once —
 * and once more per host only if the host object itself is ever replaced.
 * The MCP SubscriptionManager attaches its own listener to the same host,
 * so third-party clients see live workbook changes via poll_events.
 */
function attachEngineEventForwarding() {
    engineHost.subscribe((event) => {
        sendEngineEvent(event);
    });
}
// ---------------------------------------------------------------------------
// Trusted save directory (GAP-10)
//
// `file:saveBytes` takes a `suggestedPath` from the renderer. A compromised
// renderer must not make the main process write anywhere on disk, so a
// suggested path is only honored inside the directory of the last file the
// user explicitly picked (open dialog / OS open) or saved. Otherwise the
// save flow falls back to the native Save dialog.
// ---------------------------------------------------------------------------
let trustedDir = null;
/** Open a workbook the OS handed to the app (double-click / open-with). */
function openPathFromOs(filePath) {
    let data;
    try {
        data = fs.readFileSync(filePath);
    }
    catch (err) {
        console.error(`[open-path] could not read "${filePath}":`, err instanceof Error ? err.message : err);
        return;
    }
    trustedDir = (0, save_paths_1.trustedDirOf)(filePath);
    // Bytes travel with the event so the renderer never needs fs access.
    // sendToRenderer queues when the renderer is not listening yet (GAP-9).
    // Bytes travel as a Uint8Array (binary structured clone): Array.from
    // would walk every byte into a JS number array on this thread and
    // force the renderer to walk it back (the P75-open stall class).
    sendToRenderer('icecream:open-path', { path: filePath, bytes: new Uint8Array(data) });
}
// ---------------------------------------------------------------------------
// Parallel recalculation (track 13)
//
// The shell's main-process engine host runs explicit recalcs through the
// engine's worker pool (node:worker_threads via the engine's default
// NodeWorkerBackend) instead of the single-threaded serial path. The pool
// is enabled here at startup and torn down on quit; recalculateParallel()
// still falls back to the serial path when parallelism is not applicable
// (single partition, below the formula-cell threshold, provider-backed
// functions) or when a worker errors — so values are fresh either way.
// ---------------------------------------------------------------------------
const PARALLEL_WORKER_COUNT = (0, parallel_config_1.resolveParallelWorkerCount)();
/**
 * Enable the parallel recalculation pool on an engine host. Call for every
 * host the shell creates (initial + File > New replacements), since a fresh
 * host starts with parallel recalc disabled (engine default).
 *
 * The MT auto-flag threshold comes from the desktop options seam
 * (resolveDesktopMtThreshold — engine's resolveParallelCellThreshold;
 * canonical env ICECREAM_MT_CELL_COUNT_THRESHOLD, legacy alias
 * ICECREAM_PARALLEL_CELL_THRESHOLD): recalculateParallel gates on it
 * via shouldEnableParallelRecalc(workbook cell count).
 */
function configureParallelRecalc(host) {
    const res = host.execute({
        cmd: 'setParallelRecalcOptions',
        options: {
            enabled: true,
            workerCount: PARALLEL_WORKER_COUNT,
            cellCountThreshold: (0, parallel_config_1.resolveDesktopMtThreshold)(process.env),
        },
    });
    if (!res.ok) {
        // The local host's allow-all policy always permits this; log loudly if
        // that ever changes so a silently-serial shell is never a mystery.
        console.error('[parallel] failed to enable parallel recalculation:', res.error);
    }
    else {
        console.log(`[parallel] worker pool enabled (${PARALLEL_WORKER_COUNT} workers, ` +
            'node:worker_threads backend)');
    }
}
// ---------------------------------------------------------------------------
// IPC input validation (never trust the renderer blindly)
// ---------------------------------------------------------------------------
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
/**
 * Addendum 3: a `file:saveBytes` write becomes the checkpoint autosave
 * target only when it is the workbook's OWN save — an xlsx-family path
 * with no export suggestedName (exports pass a suggestedName like
 * "Sheet1.pdf"/"data.csv" and must never redirect background
 * checkpoints onto an export file). The renderer's bytes serialize the
 * current live state, so storage covers the current journal cut.
 */
function noteSaveBytesDestination(savedPath, suggestedName) {
    if (suggestedName !== undefined)
        return;
    const ext = path.extname(savedPath).slice(1).toLowerCase();
    if (ext !== 'xlsx' && ext !== 'xlsm' && ext !== 'xltx' && ext !== 'xltm')
        return;
    (0, direct_save_1.recordAutosaveTarget)(savedPath);
    (0, direct_save_1.markStorageCovered)((0, direct_save_1.getLiveRevision)());
}
function registerIpc() {
    // Continuous checkpointing (Addendum 3): journaled ops batch in the
    // main process and flush to the recorded autosave target on the
    // settle cadence (direct-save.ts scheduler; defaults 1500 ms /
    // 200 pending ops). Checkpoints reuse the last session extras a
    // save/flush carried; values/formulas always come from the live host.
    (0, direct_save_1.configureDesktopCheckpoints)({
        getHost: () => engineHost,
        // Settle cadence override (Addendum 3): ICECREAM_AUTOSAVE_SETTLE_MS,
        // default 1500 ms — see resolveAutosaveSettleMs in direct-save.ts.
        settleMs: (0, direct_save_1.resolveAutosaveSettleMs)(process.env),
        log: (m) => console.log(m),
    });
    // Engine protocol (Cycle 10): the renderer's workbook lives in the
    // main-process host; the channel registration lives in ./engine-ipc
    // (unit-testable without booting Electron). swapWorkbook installs an
    // opened workbook atomically; resetWorkbook serves engine:new.
    (0, engine_ipc_1.registerEngineIpc)(electron_1.ipcMain, {
        getHost: () => engineHost,
        swapWorkbook: (workbook) => {
            // Tear down the old workbook's worker pool first: worker threads
            // keep the process alive and would otherwise leak one pool per open.
            engineHost.disposeParallelWorkers();
            engineHost.replaceWorkbook(workbook);
            configureParallelRecalc(engineHost);
        },
        resetWorkbook: () => {
            engineHost.disposeParallelWorkers();
            engineHost.replaceWorkbook(new engine_1.EngineWorkbook());
            configureParallelRecalc(engineHost);
            // Direct-save state dies with the workbook (engine-ipc's
            // engine:new also clears it; both are idempotent).
            (0, engine_load_1.resetDesktopSaveBase)();
            (0, direct_save_1.clearDesktopSaveOps)();
            (0, direct_save_1.clearAutosaveTarget)();
            // Drop stale MCP sessions on New (mirrors the menu New Workbook).
            if (mcpIngress) {
                void (async () => {
                    await (0, mcp_1.closeLocalMcpClient)();
                    await mcpIngress?.restart(engineHost);
                })().catch((err) => {
                    console.error('[mcp] failed to rebind ingress to the new workbook:', err);
                });
            }
        },
        applyProtection: (state) => applyRendererProtection(state),
    });
    // -- Remote services: login-gated gateway access (spec d) ----------------
    // Auth channels live in ./auth-ipc (unit-testable without booting
    // Electron): auth:login (local-dev userId), auth:loginWithFirebase
    // (Cycle 9 Google sign-in exchange), auth:logout, auth:status,
    // auth:openLoginWindow. Every transition runs through the
    // DesktopAuthState machine and notifies the renderer on 'auth:changed'.
    const authIpc = (0, auth_ipc_1.registerAuthIpc)(electron_1.ipcMain, {
        rebuildMenu: () => electron_1.Menu.setApplicationMenu(buildMenu()),
        notifyRenderer: (channel, snapshot) => sendToRenderer(channel, snapshot),
        openLoginWindow: () => void openLoginWindow(),
    });
    authState = authIpc.authState;
    // A completed Google sign-in closes the login window (the page itself
    // shows "Signed in" first; the window is auxiliary UI).
    authState.onChange((s) => {
        if (s.phase === 'logged-in')
            closeLoginWindow();
    });
    // -- Desktop file Open/Save ------------------------------------------------
    // The renderer owns the storage adapters (real implementations, shared
    // with web); the main process only shows native dialogs and reads/writes
    // bytes, keeping Node fs APIs out of the renderer.
    electron_1.ipcMain.handle('file:pickOpen', async () => {
        const win = mainWindow;
        if (!win || win.isDestroyed())
            return null;
        const res = await electron_1.dialog.showOpenDialog(win, {
            title: 'Open workbook',
            properties: ['openFile'],
            filters: [
                { name: 'Spreadsheets', extensions: ['xlsx', 'csv', 'tsv', 'ods'] },
                { name: 'All files', extensions: ['*'] },
            ],
        });
        if (res.canceled || res.filePaths.length === 0)
            return null;
        const filePath = res.filePaths[0];
        const data = fs.readFileSync(filePath);
        // GAP-10: the user explicitly picked this file — its directory
        // becomes the trusted dir for suggestedPath validation.
        trustedDir = (0, save_paths_1.trustedDirOf)(filePath);
        return { path: filePath, bytes: new Uint8Array(data) };
    });
    electron_1.ipcMain.handle('file:saveBytes', async (_event, args) => {
        if (!isRecord(args) || !(args['bytes'] instanceof Uint8Array || Array.isArray(args['bytes']))) {
            throw new Error('file:saveBytes: expected {bytes: Uint8Array, suggestedPath?}');
        }
        // Uint8Array is the current shape (binary clone); number[] is the
        // legacy shape and still accepted.
        const data = Buffer.from(args['bytes']);
        const suggested = typeof args['suggestedPath'] === 'string' ? args['suggestedPath'] : undefined;
        // GAP-3: the renderer may pass a suggestedName (e.g. an export
        // filename like "Sheet1.pdf") so the Save dialog pre-fills it
        // instead of the generic "workbook.xlsx".
        const suggestedName = typeof args['suggestedName'] === 'string' ? args['suggestedName'] : undefined;
        // GAP-10: a suggested path is honored only inside the directory of
        // the last user-picked/saved file — anything else (or no trusted
        // dir yet) falls back to the native Save dialog below.
        const target = (0, save_paths_1.resolveSaveTarget)(suggested, trustedDir);
        if (target.mode === 'direct') {
            fs.writeFileSync(target.path, data);
            trustedDir = (0, save_paths_1.trustedDirOf)(target.path);
            noteSaveBytesDestination(target.path, suggestedName);
            return { path: target.path };
        }
        const win = mainWindow;
        if (!win || win.isDestroyed())
            return { path: null };
        const res = await electron_1.dialog.showSaveDialog(win, {
            title: 'Save workbook',
            // GAP-3: pre-fill the renderer-suggested filename (export target);
            // GAP-2's in-place save never reaches this dialog (trusted path).
            defaultPath: suggestedName || 'workbook.xlsx',
            filters: [
                { name: 'Excel Workbook', extensions: ['xlsx'] },
                { name: 'CSV', extensions: ['csv'] },
                { name: 'TSV', extensions: ['tsv'] },
                { name: 'OpenDocument', extensions: ['ods'] },
                { name: 'All files', extensions: ['*'] },
            ],
        });
        if (res.canceled || !res.filePath)
            return { path: null };
        fs.writeFileSync(res.filePath, data);
        // GAP-10: a dialog-confirmed save also establishes the trusted dir.
        trustedDir = (0, save_paths_1.trustedDirOf)(res.filePath);
        noteSaveBytesDestination(res.filePath, suggestedName);
        return { path: res.filePath };
    });
    // -- Direct streaming save (direct-save pass) ----------------------------
    // Whole-workbook .xlsx saves serialize the MAIN-process host's LIVE
    // model through the shared streaming serializer (service/save-node) —
    // the renderer sends only its session extras; no snapshot and no
    // workbook bytes cross IPC on this path (the old renderer flow —
    // ensureSaveSnapshot → buildDownloadBytes → file:saveBytes — remains
    // only for non-xlsx formats and bridges too old to expose this).
    //
    // EXCEL SAVE SEQUENCE (user directive, 2026-10-21):
    //  (1) RECALC SETTLE — desktop execute/recalc in this process is
    //      synchronous, and the renderer awaits awaitEditsSettled() before
    //      invoking this channel, so the state serialized below is the
    //      fully-calculated post-edit state at a settled revision; no
    //      mid-calc state can be pinned here.
    //  (2) DESTINATION FIRST — the final path is resolved BEFORE anything
    //      is serialized (suggestedPath under the same GAP-10 trust rules
    //      as file:saveBytes via resolveSaveTarget, else the native Save
    //      dialog with the same filters/default as file:saveBytes). A
    //      cancelled dialog writes nothing at all.
    //  (3) TEMP + VERIFY + ATOMIC REPLACE — saveToDestinationAtomically
    //      (direct-save.ts) serializes to a temp file IN THE DESTINATION'S
    //      DIRECTORY, verifies the finished package
    //      (verifyXlsxPackage), and only then renameSync()s it over the
    //      destination. Any failure deletes the temp and leaves a
    //      pre-existing destination byte-identical; the error propagates
    //      to the renderer as a save error and the session stays usable.
    //      Autosave reaches this same handler with a known trusted path,
    //      so it takes the identical sequence silently (no dialog).
    electron_1.ipcMain.handle('engine:saveXlsxDirect', async (_event, args) => {
        if (!isRecord(args)) {
            throw new Error('engine:saveXlsxDirect: expected {extras, suggestedPath?, suggestedName?}');
        }
        const extras = (isRecord(args['extras']) ? args['extras'] : {});
        const suggested = typeof args['suggestedPath'] === 'string' ? args['suggestedPath'] : undefined;
        const suggestedName = typeof args['suggestedName'] === 'string' ? args['suggestedName'] : undefined;
        // These extras are the freshest the renderer has: background
        // checkpoints (Addendum 3) reuse them until a newer save/flush.
        (0, direct_save_1.setLastSaveExtras)(extras);
        // (2) Destination first — same trust decision as file:saveBytes.
        const target = (0, save_paths_1.resolveSaveTarget)(suggested, trustedDir);
        let destPath;
        if (target.mode === 'direct') {
            destPath = target.path;
        }
        else {
            const win = mainWindow;
            if (!win || win.isDestroyed())
                return { path: null };
            const res = await electron_1.dialog.showSaveDialog(win, {
                title: 'Save workbook',
                // Same default + filters as file:saveBytes.
                defaultPath: suggestedName || 'workbook.xlsx',
                filters: [
                    { name: 'Excel Workbook', extensions: ['xlsx'] },
                    { name: 'CSV', extensions: ['csv'] },
                    { name: 'TSV', extensions: ['tsv'] },
                    { name: 'OpenDocument', extensions: ['ods'] },
                    { name: 'All files', extensions: ['*'] },
                ],
            });
            if (res.canceled || !res.filePath)
                return { path: null };
            destPath = res.filePath;
        }
        // Checkpoint-current skip (Addendum 3): continuous checkpointing
        // may already have this exact destination covered through the
        // live revision — a Save to the recorded autosave target with
        // nothing pending is then already durable, and re-serializing
        // would only rewrite identical state. The destination file must
        // still exist (an external delete defeats the skip).
        if ((0, direct_save_1.shouldSkipCheckpointCurrentSave)({
            suggestedPath: suggested,
            destPath,
            destExists: fs.existsSync(destPath),
        })) {
            (0, direct_save_1.noteCheckpointNoopSkip)();
            console.log(`[direct-save] save skipped: checkpoint already current for ${destPath} (revision ${(0, direct_save_1.getLiveRevision)()})`);
            trustedDir = (0, save_paths_1.trustedDirOf)(destPath);
            return {
                path: destPath,
                mode: 'checkpoint-current',
                skipped: true,
                bytes: fs.statSync(destPath).size,
                changedSheets: [],
            };
        }
        // (1)+(3): serialize the live host to a temp sibling, verify, and
        // atomically replace the destination (see the sequence above).
        // The storage cut is captured BEFORE serialization: the file
        // covers at least this journal cut; ops landing during the save
        // stay pending for the checkpoint scheduler.
        const cut = (0, direct_save_1.getLiveRevision)();
        const result = await (0, direct_save_1.saveToDestinationAtomically)((tempPath) => (0, direct_save_1.serializeDesktopWorkbook)(engineHost, extras, tempPath, (m) => console.log(`[direct-save] ${m}`)), destPath);
        // GAP-10: a completed save (trusted direct or dialog-confirmed)
        // establishes the trusted dir, exactly like file:saveBytes.
        trustedDir = (0, save_paths_1.trustedDirOf)(destPath);
        // Addendum 3: this destination is now the autosave target, and
        // storage covers the captured cut.
        (0, direct_save_1.recordAutosaveTarget)(destPath);
        (0, direct_save_1.markStorageCovered)(cut);
        // Addendum 6: the save serialized the current session extras —
        // they are consumed (a change landing during the save keeps the
        // dirty flag for the next checkpoint).
        (0, direct_save_1.consumeSerializedSessionExtras)();
        return {
            path: destPath,
            mode: result.mode,
            bytes: result.bytes,
            changedSheets: result.changedSheets,
        };
    });
    // -- Autosave flush confirmation (Addendum 3) ---------------------------
    // The renderer's autosave no longer ships bytes: it asks main to force
    // any pending checkpoint batch NOW (through the same temp → verify →
    // atomic-rename sequence, reusing these extras as the freshest client
    // state) and reports the storage/live revisions back. caughtUp ===
    // (storageRevision === liveRevision): the local file holds every op
    // the live model has applied.
    electron_1.ipcMain.handle('engine:autosaveFlush', async (_event, args) => {
        if (isRecord(args) && isRecord(args['extras'])) {
            (0, direct_save_1.setLastSaveExtras)(args['extras']);
        }
        return (0, direct_save_1.flushDesktopCheckpoint)('renderer-flush');
    });
    // -- Save status + session-extras sync (Addendum 6) ---------------------
    // Autosave ownership lives entirely in main: the renderer never
    // initiates a checkpoint on a timer any more. It (a) syncs its
    // session extras here as they change (state sync, not a save
    // trigger — main's scheduler decides when to flush, and the extras
    // are consumed by the next checkpoint/manual save), and (b) polls
    // the save status to display Saving…/Saved. Both channels are cheap:
    // no serialization, no file I/O.
    electron_1.ipcMain.handle('engine:sessionExtras', (_event, args) => {
        if (!isRecord(args) || !isRecord(args['extras'])) {
            throw new Error('engine:sessionExtras: expected {extras}');
        }
        (0, direct_save_1.setPendingSessionExtras)(args['extras']);
        return { extrasDirty: (0, direct_save_1.isSessionExtrasDirty)() };
    });
    electron_1.ipcMain.handle('engine:saveStatus', () => (0, direct_save_1.getSaveStatus)());
    electron_1.ipcMain.handle('svc:call', async (_event, args) => {
        if (!isRecord(args) || typeof args['service'] !== 'string' || typeof args['path'] !== 'string') {
            throw new Error('svc:call: expected {service, path, method?, body?}');
        }
        const service = args['service'];
        if (!['agent', 'etl', 'vault', 'meta', 'mcp', 'engine'].includes(service)) {
            throw new Error(`svc:call: unknown service "${service}"`);
        }
        return (0, services_1.serviceCall)(service, String(args['path']), typeof args['method'] === 'string' ? String(args['method']) : 'POST', args['body']);
    });
    // MCP direct-ingress discovery (platform-shell.md §8): the renderer's
    // diagnostics can show third-party clients where the desktop's own MCP
    // endpoint lives. The ingress itself is MCP's own direct ingress — it is
    // never behind the API gateway.
    electron_1.ipcMain.handle('mcp:url', () => (0, mcp_1.desktopMcpUrl)());
    // Renderer readiness (GAP-9): the preload bridge calls `signalReady()`
    // once the renderer has attached its main→renderer event listeners.
    // Queued menu clicks / OS file opens are flushed here. Engine events
    // are not queued (they drop until ready — see sendEngineEvent).
    electron_1.ipcMain.on('renderer:ready', () => {
        flushPendingRendererMessages();
    });
}
// ---------------------------------------------------------------------------
// Login window (spec d + Cycle 9): remote services require login; the local
// engine works fully offline without it.
//
// The window hosts the Firebase Google sign-in page (Google provider ONLY —
// no username/password). The page is served from a loopback HTTP server so
// it has a real origin for Firebase's popup flow, completes Google sign-in
// with the Firebase JS SDK, and hands the Firebase ID token to the main
// process over auth:loginWithFirebase — the main process exchanges it for
// the gateway JWT (stored in safeStorage, never shown to the renderer).
// ---------------------------------------------------------------------------
/** The shared auth state machine (created in registerIpc, post-app-ready). */
let authState = null;
let loginWindow = null;
let loginServer = null;
/** Close the login window and tear down its loopback server, if any. */
function closeLoginWindow() {
    const win = loginWindow;
    loginWindow = null;
    if (win && !win.isDestroyed())
        win.close();
    const srv = loginServer;
    loginServer = null;
    if (srv)
        void srv.close().catch(() => undefined);
}
async function openLoginWindow() {
    if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.focus();
        return;
    }
    const st = authState;
    if (st && st.snapshot().phase === 'logged-in')
        return; // nothing to do
    try {
        st?.beginLogin();
    }
    catch {
        // A login is already in flight without a window (rare race) — open the
        // window so the user can complete it instead of erroring out.
    }
    // Config seam: missing config → the page renders the clear
    // not-configured error INSTEAD of a sign-in button (fail closed, no
    // silent dead button).
    let config = null;
    let configError;
    try {
        config = (0, firebase_config_1.loadFirebaseConfig)({ userDataPath: electron_1.app.getPath('userData') });
    }
    catch (err) {
        configError = err instanceof Error ? err.message : String(err);
        console.error('[auth] Firebase config missing:', configError);
    }
    if (!config) {
        // Record the failure on the machine so the UI can surface it; the
        // page shows the same message.
        st?.failLogin(configError ?? 'Firebase Auth is not configured.');
    }
    let server;
    try {
        server = await (0, login_server_1.startLoginServer)((0, firebase_login_page_1.buildLoginPage)({ config, configError }));
    }
    catch (err) {
        st?.failLogin(err instanceof Error ? err.message : String(err));
        return;
    }
    loginServer = server;
    loginWindow = new electron_1.BrowserWindow({
        width: 420,
        height: 560,
        resizable: false,
        title: 'Sign in to Icecream Sheets',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, 'preload.js'),
        },
    });
    // Google sign-in opens its OAuth page via window.open from the Firebase
    // SDK: allow it as a contained popup, but ONLY for the auth flow hosts —
    // a compromised login page must not get an arbitrary browser window.
    loginWindow.webContents.setWindowOpenHandler(({ url }) => {
        let host;
        try {
            host = new URL(url).hostname.toLowerCase();
        }
        catch {
            return { action: 'deny' };
        }
        const allowed = host.endsWith('.firebaseapp.com') ||
            host.endsWith('.google.com') ||
            host.endsWith('.googleapis.com') ||
            host.endsWith('.gstatic.com') ||
            host === 'localhost' ||
            host === '127.0.0.1';
        if (!allowed) {
            console.warn(`[auth] denied login popup to unexpected host: ${host}`);
            return { action: 'deny' };
        }
        return {
            action: 'allow',
            overrideBrowserWindowOptions: {
                width: 500,
                height: 640,
                webPreferences: { contextIsolation: true, nodeIntegration: false },
            },
        };
    });
    try {
        await loginWindow.loadURL(server.url);
    }
    catch (err) {
        st?.failLogin(err instanceof Error ? err.message : String(err));
        closeLoginWindow();
        return;
    }
    loginWindow.on('closed', () => {
        loginWindow = null;
        const srv = loginServer;
        loginServer = null;
        if (srv)
            void srv.close().catch(() => undefined);
        // Window dismissed while the exchange was still in flight → the login
        // is cancelled, back to logged-out (no-op when already logged-in).
        st?.failLogin('Sign-in was cancelled before completing.');
    });
}
// ---------------------------------------------------------------------------
// Workbook lifecycle
// ---------------------------------------------------------------------------
/**
 * GAP-6 dirty guard: ask the renderer whether discarding the current
 * workbook is acceptable before New Workbook wipes it. The renderer
 * answers true immediately when nothing is unsaved and otherwise shows a
 * confirm; its reply arrives on 'icecream:confirm-new:reply'. Fail
 * closed: a missing or timed-out reply aborts the New, so unsaved work
 * can never be discarded silently. Sent via the GAP-9 queue so the event
 * survives a not-yet-listening renderer.
 */
function requestNewWorkbookConfirm() {
    const win = mainWindow;
    if (!win || win.isDestroyed())
        return Promise.resolve(true);
    sendToRenderer('icecream:confirm-new');
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 60_000);
        electron_1.ipcMain.once('icecream:confirm-new:reply', (_event, ok) => {
            clearTimeout(timer);
            resolve(ok === true);
        });
    });
}
async function newWorkbook() {
    if (!(await requestNewWorkbookConfirm()))
        return;
    // Tear down the old workbook's worker pool first: worker threads keep
    // the process alive and would otherwise leak one pool per New Workbook.
    // The host instance stays (Cycle 10): only the workbook is swapped, so
    // the MCP ingress and the engine-event forwarder keep serving the live
    // workbook; the ingress restarts only to drop stale MCP sessions.
    engineHost.disposeParallelWorkers();
    engineHost.replaceWorkbook(new engine_1.EngineWorkbook());
    configureParallelRecalc(engineHost);
    // Direct-save state dies with the workbook (blank base, empty journal).
    (0, engine_load_1.resetDesktopSaveBase)();
    (0, direct_save_1.clearDesktopSaveOps)();
    (0, direct_save_1.clearAutosaveTarget)();
    if (mcpIngress) {
        void (async () => {
            await (0, mcp_1.closeLocalMcpClient)();
            await mcpIngress?.restart(engineHost);
        })().catch((err) => {
            console.error('[mcp] failed to rebind ingress to the new workbook:', err);
        });
    }
    mainWindow?.reload();
}
/**
 * The desktop's own MCP direct ingress (platform-shell.md §8): third-party
 * MCP clients get the same typed operations as the built-in UI, served
 * from the main-process host's LIVE workbook (Cycle 10: the workbook lives
 * in main, so the ingress serves engineHost directly — no forwarding,
 * never via the API gateway, which deliberately has no /api/mcp route).
 */
let mcpIngress = null;
/**
 * The desktop's local add-on service (add-on-model.md): initialized once at
 * Node service startup via createProductionAddonService(), which calls
 * initSigning() and configures the Ed25519 install-time verifier. Unsigned
 * manifests fail closed at install. Null when initialization failed — in
 * which case add-on installs are disabled entirely (also fail closed).
 */
let addonService = null;
function getAddonService() {
    return addonService;
}
/** Start the desktop-local services: MCP ingress + production add-on service. */
async function startLocalServices() {
    try {
        // The ingress serves the main-process host directly (Cycle 10): the
        // user's workbook lives here, protected by the same synced policy.
        mcpIngress = await (0, mcp_1.startDesktopMcpIngress)(engineHost);
    }
    catch (err) {
        // Never brick the app over the auxiliary MCP ingress: log loudly and
        // continue without it. Third-party MCP clients get no endpoint, and
        // built-in mcp calls fail with a clear "cannot reach" error.
        console.error('[mcp] FAILED to start the desktop MCP direct ingress — third-party MCP is unavailable:', err instanceof Error ? err.message : err);
        mcpIngress = null;
    }
    try {
        // @icecream-sheets/service ships as ESM; the Electron main process
        // compiles to CJS, so import it dynamically.
        const { createProductionAddonService } = (await Promise.resolve().then(() => __importStar(require('@icecream-sheets/service'))));
        addonService = await createProductionAddonService();
        console.log('[addons] production add-on service ready: Ed25519 install verifier active');
    }
    catch (err) {
        console.error('[addons] FAILED to initialize the production add-on service — add-on installs are disabled:', err instanceof Error ? err.message : err);
        addonService = null;
    }
}
// ---------------------------------------------------------------------------
// Window + menu
// ---------------------------------------------------------------------------
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, 'preload.js'),
        },
    });
    const indexHtml = (0, paths_1.resolveRendererIndex)({
        distDir: __dirname,
        resourcesPath: electron_1.app.isPackaged ? process.resourcesPath : undefined,
    });
    if (indexHtml !== null) {
        void mainWindow.loadFile(indexHtml);
    }
    else {
        const html = (0, fallback_1.getFallbackHtml)(engine_1.ENGINE_PROTOCOL_VERSION);
        void mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    }
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
    // GAP-9: a reload (e.g. File > New Workbook) tears down the renderer's
    // listeners — re-arm the readiness gate so menu/OS events queue until
    // the new page signals ready again.
    mainWindow.webContents.on('did-start-loading', () => {
        rendererReady = false;
    });
    // GAP-5: a file dropped on the window must never navigate the
    // webContents (that would wipe app state — data loss). Drops are
    // handled by the renderer's onDrop open flow instead.
    mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
}
function buildMenu() {
    const isMac = process.platform === 'darwin';
    const quitItem = { role: 'quit' };
    const template = [];
    if (isMac) {
        template.push({
            label: electron_1.app.name,
            submenu: [{ role: 'about' }, { type: 'separator' }, quitItem],
        });
    }
    template.push({
        label: 'File',
        submenu: [
            {
                label: 'New Workbook',
                accelerator: 'CmdOrCtrl+N',
                click: () => void newWorkbook(),
            },
            { type: 'separator' },
            // Open/Save are wired through the native file dialogs below.
            // The xlsx/csv/tsv/ods adapters run in the renderer (shared web
            // code, real implementations — not stubs); the main process only
            // shows dialogs and reads/writes bytes. Menu items notify the
            // renderer, which serializes/parses via the adapter registry.
            {
                label: 'Open…',
                accelerator: 'CmdOrCtrl+O',
                click: () => sendToRenderer('icecream:menu-open'),
            },
            {
                label: 'Save',
                accelerator: 'CmdOrCtrl+S',
                click: () => sendToRenderer('icecream:menu-save'),
            },
            {
                label: 'Save As…',
                accelerator: 'Shift+CmdOrCtrl+S',
                // GAP-7: the renderer answers by calling desktopSaveBytes with
                // NO suggested path, so main.ts shows the native Save dialog.
                click: () => sendToRenderer('icecream:menu-save-as'),
            },
            { type: 'separator' },
            {
                label: 'Preferences…',
                accelerator: 'CmdOrCtrl+,',
                // GAP-7: the renderer opens SettingsDialog (platform-shell.md §4:
                // settings are per-user profile preferences, never workbook bytes).
                click: () => sendToRenderer('icecream:menu-preferences'),
            },
            { type: 'separator' },
            ...(isMac ? [] : [quitItem]),
        ],
    }, {
        label: 'Edit',
        submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' },
        ],
    }, {
        label: 'View',
        submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }],
    }, {
        // Spec d: remote services (AI agent, ETL, vault) require login.
        // Logged out = local engine only. The menu reflects live status.
        label: 'Account',
        submenu: (() => {
            const st = (0, services_1.status)();
            const items = [
                {
                    label: st.loggedIn ? `Signed in as ${st.principal ?? 'unknown'}` : 'Not signed in',
                    enabled: false,
                },
                { type: 'separator' },
            ];
            if (st.loggedIn) {
                items.push({
                    label: 'Sign out',
                    click: () => {
                        (0, services_1.logout)();
                        electron_1.Menu.setApplicationMenu(buildMenu());
                    },
                });
            }
            else {
                items.push({
                    label: 'Sign in…',
                    click: () => openLoginWindow(),
                });
            }
            items.push({ type: 'separator' });
            items.push({
                label: `Gateway: ${(0, services_1.gatewayUrl)()}`,
                enabled: false,
            });
            return items;
        })(),
    }, {
        // GAP-7: Help opens product-owned docs (platform-shell.md §5) in the
        // renderer's HelpPane — no external service dependency.
        label: 'Help',
        submenu: [
            {
                label: 'Icecream Sheets Help',
                click: () => sendToRenderer('icecream:menu-help'),
            },
        ],
    });
    return electron_1.Menu.buildFromTemplate(template);
}
// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
void electron_1.app.whenReady().then(async () => {
    registerIpc();
    configureParallelRecalc(engineHost);
    // Wire the default (empty) protection state into the host, then start
    // the main→renderer engine-event feed (the host instance is stable, so
    // the forwarder is attached once and survives opens and New).
    wireEngineProtection();
    attachEngineEventForwarding();
    await startLocalServices();
    createWindow();
    // GAP-4: a Windows Explorer double-click (or `electron . file.xlsx` in
    // dev) passes the workbook on the command line. openPathFromOs reads the
    // bytes and queues the event when the renderer is not listening yet
    // (GAP-9); macOS arrives via `open-file` instead.
    const launchPath = (0, paths_1.findLaunchFilePath)(process.argv);
    if (launchPath)
        openPathFromOs(launchPath);
    electron_1.Menu.setApplicationMenu(buildMenu());
    electron_1.app.on('activate', () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        electron_1.app.quit();
    }
});
electron_1.app.on('before-quit', () => {
    if (mcpIngress) {
        void mcpIngress.close().catch(() => undefined);
        mcpIngress = null;
    }
    void (0, mcp_1.closeLocalMcpClient)();
    // Terminate the parallel-recalculation workers before tearing down the
    // host: worker threads keep the process alive, and a clean shutdown
    // must not wait on (or leak) them.
    engineHost.disposeParallelWorkers();
    engineHost.dispose();
});
//# sourceMappingURL=main.js.map