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
 *      triggers:list | triggers:create | triggers:remove | triggers:setEnabled | triggers:grant
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

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
} from 'electron';
import type {
  IpcMainInvokeEvent,
  MenuItemConstructorOptions,
} from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';

// Issue #44: the app name is the product name ("Icecream Sheets", via
// package.json's top-level productName), so the macOS app menu, About
// and Quit items — all built from app.name — no longer leak the
// internal package name "icecream-sheets-desktop". Electron derives
// the DEFAULT userData directory from the app name, though, and
// existing installs already hold per-user state there (gateway token,
// triggers, firebase config). Pin userData to the legacy name-derived
// directory so the rename orphans none of it. This must run before
// anything reads app.getPath('userData').
app.setPath('userData', path.join(app.getPath('appData'), 'icecream-sheets-desktop'));

/**
 * Accessibility (design-docs/accessibility.md §3): force Chromium's
 * renderer accessibility tree ON, even when no assistive technology is
 * attached at launch. Without this, the platform tree (macOS
 * NSAccessibility / Windows UI Automation) is only built lazily when an
 * AT client attaches, which breaks programmatic inspection and some AT
 * attach flows. This switch does NOT disable anything — there is no
 * --disable-renderer-accessibility anywhere in this codebase by policy.
 */
app.commandLine.appendSwitch('force-renderer-accessibility');

/**
 * Issue #48 BAND-AID (labeled, not the fix): raise the main process's
 * V8 old-space ceiling from its ~4 GB default to 8 GB. The perf program
 * root-caused the ≥1.8M-cell OOM as per-cell storage triplication in
 * the engine (~490 B/cell across the HyperFormula graph + cellInputs +
 * the seeded valueCache): p95's engine core alone is ~1.1 GB before
 * Electron, the parallel pool, and per-checkpoint transients
 * (~+0.5 GB) land — the default ceiling, not the machine's 16 GB, is
 * what aborts it. 8 GB makes p95-class workbooks comfortable and buys
 * p99 time; p99's core rivals even this ceiling, so the real fix
 * remains the documented storage redesign — this switch only stops the
 * default ceiling from converting headroom the machine HAS into an
 * abort. Must be set before the app is ready (top-level, like the
 * accessibility switch above).
 */
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192');
import {
  ENGINE_PROTOCOL_VERSION,
  EngineHost,
  EngineWorkbook,
  ProtectionManager,
  allowAllPolicy,
} from '@icecream-sheets/engine';
import type {
  EngineEvent,
} from '@icecream-sheets/engine';
import { registerEngineIpc } from './engine-ipc';
import { TriggerHostManager } from './triggers';
import { registerTriggersIpc } from './triggers-ipc';
import { resetDesktopSaveBase } from './engine-load';
import {
  clearAutosaveTarget,
  clearDesktopSaveOps,
  configureDesktopCheckpoints,
  consumeSerializedSessionExtras,
  flushDesktopCheckpoint,
  getLiveRevision,
  getSaveStatus,
  isSessionExtrasDirty,
  markStorageCovered,
  noteCheckpointNoopSkip,
  recordAutosaveTarget,
  resolveAutosaveSettleMs,
  setPendingSessionExtras,
  setServerHostedWorkbook,
  shouldSkipCheckpointCurrentSave,
  type DesktopSaveStatus,
  saveToDestinationAtomically,
  serializeDesktopWorkbook,
  setLastSaveExtras,
  type DesktopSaveExtras,
} from './direct-save';
import {
  installCloseFlush,
  outcomeLeavesWorkUncovered,
  type QuitFlushController,
  type QuitFlushOutcome,
} from './close-flush';
import { getFallbackHtml } from './fallback';
import { findLaunchFilePath, resolveRendererIndex } from './paths';
import { resolveSaveTarget, trustedDirOf } from './save-paths';
import { resolveDesktopMtThreshold, resolveParallelWorkerCount } from './parallel-config';
import {
  logout,
  status,
  serviceCall,
  setSessionLostHandler,
  gatewayUrl,
  type RemoteService,
} from './services';
import { registerAuthIpc, completeFirebaseLogin, performLogout, type AuthIpc } from './auth-ipc';
import { resolveLoginWindowClosed } from './login-window-state';
import { DesktopAuthState } from './auth-state';
import { loadFirebaseConfig, type FirebaseWebConfig } from './firebase-config';
import { buildLoginPage } from './firebase-login-page';
import {
  startLoginServer,
  readRequestJson,
  asRecord,
  type LoginServer,
  type LoginServerRoute,
} from './login-server';
import { BrowserLoginFlow, browserCompleteErrorMessage } from './browser-login';
import {
  closeLocalMcpClient,
  desktopMcpUrl,
  startDesktopMcpIngress,
  type DesktopMcpIngress,
} from './mcp';
import type { AddonService } from '@icecream-sheets/service';

// ---------------------------------------------------------------------------
// GAP-4: OS file-association opens (double-click / "Open with" / dock drop)
//
// One instance only: a second launch forwards its workbook path to the
// already-running primary instance instead of opening a second window
// (multi-window is explicitly out of scope for v1 — platform-shell.md §9).
// ---------------------------------------------------------------------------

const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const win = mainWindow;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    const filePath = findLaunchFilePath(argv);
    if (filePath) openPathFromOs(filePath);
  });
}

// macOS: Finder delivers double-clicked documents through `open-file`,
// which can fire before `whenReady` — openPathFromOs queues the event via
// sendToRenderer (GAP-9) so nothing is lost before the renderer listens.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  openPathFromOs(filePath);
});

let mainWindow: BrowserWindow | null = null;

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
let engineHost: EngineHost = new EngineHost();

/**
 * The quit-flush controller (installed at the bottom of this module —
 * see installCloseFlush). Held here so the main window's close guard
 * (issue #57) can route window closes through the same guarded flow.
 * Module evaluation completes before any window exists, so this is
 * always set by the time a close can happen.
 */
let quitFlushController: QuitFlushController | null = null;

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
const protectionManager = new ProtectionManager();
protectionManager.setHiddenExemptPrincipals(['user']);

function wireEngineProtection(): void {
  engineHost.getAuthorizer().setPolicy(
    protectionManager.protectionPolicy(allowAllPolicy()),
  );
  engineHost.setHiddenCheck((ref, principal) =>
    protectionManager.isHiddenFrom(ref.sheet, ref.row, ref.col, principal),
  );
}

function applyRendererProtection(state: Record<string, unknown>): void {
  protectionManager.fromMetadata(state);
  wireEngineProtection();
}

// ---------------------------------------------------------------------------
// Trigger hosting (desktop local mode)
//
// A TriggerHostManager hosts a SessionTriggerHost against the SAME
// singleton engineHost, scoped to the currently open file's path (or
// 'untitled'). It is constructed in registerIpc() (the app data dir is
// only known after app-ready) with its persistence under
// <userData>/triggers, and re-scoped whenever a new workbook becomes
// current: engine:load / engine:new report through registerEngineIpc's
// onWorkbookCurrent hook, and the menu New Workbook path calls
// rescopeTriggers(null) directly.
// ---------------------------------------------------------------------------

let triggerManager: TriggerHostManager | null = null;

/** Re-scope trigger hosting to a newly current workbook (null = untitled). */
function rescopeTriggers(filename: string | null): void {
  if (!triggerManager) return;
  try {
    triggerManager.setScope(filename);
  } catch (err) {
    // Trigger hosting must never break an open/new that already landed.
    console.error(
      '[triggers] failed to re-scope the trigger host:',
      err instanceof Error ? err.message : err,
    );
  }
}

// ---------------------------------------------------------------------------
// Main → renderer messaging (GAP-9)
//
// Menu clicks (Cmd+O/Cmd+S immediately after launch) and OS-triggered file
// opens can arrive before the renderer has subscribed to them. Guarding on
// mainWindow alone is not enough — the window can exist while its listeners
// are not yet attached — so messages are queued and flushed when the
// renderer signals ready via `renderer:ready` (see the preload API).
// ---------------------------------------------------------------------------

interface PendingRendererMessage {
  channel: string;
  args: unknown[];
}

let pendingRendererMessages: PendingRendererMessage[] = [];
let rendererReady = false;

/** Send to the renderer, queueing when it cannot receive yet (GAP-9). */
function sendToRenderer(channel: string, ...args: unknown[]): void {
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
function flushPendingRendererMessages(): void {
  rendererReady = true;
  const queued = pendingRendererMessages;
  pendingRendererMessages = [];
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
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
function sendEngineEvent(event: EngineEvent): void {
  const win = mainWindow;
  if (!rendererReady || !win || win.isDestroyed()) return;
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
function attachEngineEventForwarding(): void {
  engineHost.subscribe((event: EngineEvent) => {
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

let trustedDir: string | null = null;

/** Open a workbook the OS handed to the app (double-click / open-with). */
function openPathFromOs(filePath: string): void {
  let data: Buffer;
  try {
    data = fs.readFileSync(filePath);
  } catch (err) {
    console.error(
      `[open-path] could not read "${filePath}":`,
      err instanceof Error ? err.message : err,
    );
    return;
  }
  trustedDir = trustedDirOf(filePath);
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

const PARALLEL_WORKER_COUNT = resolveParallelWorkerCount();

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
function configureParallelRecalc(host: EngineHost): void {
  const res = host.execute({
    cmd: 'setParallelRecalcOptions',
    options: {
      enabled: true,
      workerCount: PARALLEL_WORKER_COUNT,
      cellCountThreshold: resolveDesktopMtThreshold(process.env),
    },
  });
  if (!res.ok) {
    // The local host's allow-all policy always permits this; log loudly if
    // that ever changes so a silently-serial shell is never a mystery.
    console.error('[parallel] failed to enable parallel recalculation:', res.error);
  } else {
    console.log(
      `[parallel] worker pool enabled (${PARALLEL_WORKER_COUNT} workers, ` +
        'node:worker_threads backend)',
    );
  }
}

// ---------------------------------------------------------------------------
// IPC input validation (never trust the renderer blindly)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
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
function noteSaveBytesDestination(savedPath: string, suggestedName: string | undefined): void {
  if (suggestedName !== undefined) return;
  const ext = path.extname(savedPath).slice(1).toLowerCase();
  if (ext !== 'xlsx' && ext !== 'xlsm' && ext !== 'xltx' && ext !== 'xltm') return;
  recordAutosaveTarget(savedPath);
  markStorageCovered(getLiveRevision());
}

function registerIpc(): void {
  // Continuous checkpointing (Addendum 3): journaled ops batch in the
  // main process and flush to the recorded autosave target on the
  // settle cadence (direct-save.ts scheduler; defaults 1500 ms /
  // 200 pending ops). Checkpoints reuse the last session extras a
  // save/flush carried; values/formulas always come from the live host.
  configureDesktopCheckpoints({
    getHost: () => engineHost,
    // Settle cadence override (Addendum 3): ICECREAM_AUTOSAVE_SETTLE_MS,
    // default 1500 ms — see resolveAutosaveSettleMs in direct-save.ts.
    settleMs: resolveAutosaveSettleMs(process.env),
    log: (m) => console.log(m),
  });
  // Trigger hosting (desktop local mode): the manager hosts a
  // SessionTriggerHost against the singleton engine host, persisted
  // under the app data dir's `triggers` subdir, starting in the
  // untitled scope; engine loads/news re-scope it below.
  triggerManager = new TriggerHostManager({
    host: engineHost,
    dir: path.join(app.getPath('userData'), 'triggers'),
  });
  registerTriggersIpc(ipcMain, triggerManager);

  // Engine protocol (Cycle 10): the renderer's workbook lives in the
  // main-process host; the channel registration lives in ./engine-ipc
  // (unit-testable without booting Electron). swapWorkbook installs an
  // opened workbook atomically; resetWorkbook serves engine:new.
  registerEngineIpc(ipcMain, {
    getHost: () => engineHost,
    onWorkbookCurrent: (filename) => rescopeTriggers(filename),
    swapWorkbook: (workbook) => {
      // Tear down the old workbook's worker pool first: worker threads
      // keep the process alive and would otherwise leak one pool per open.
      engineHost.disposeParallelWorkers();
      engineHost.replaceWorkbook(workbook);
      configureParallelRecalc(engineHost);
    },
    resetWorkbook: () => {
      engineHost.disposeParallelWorkers();
      engineHost.replaceWorkbook(new EngineWorkbook());
      configureParallelRecalc(engineHost);
      // Direct-save state dies with the workbook (engine-ipc's
      // engine:new also clears it; both are idempotent).
      resetDesktopSaveBase();
      clearDesktopSaveOps();
      clearAutosaveTarget();
      // Drop stale MCP sessions on New (mirrors the menu New Workbook).
      if (mcpIngress) {
        void (async () => {
          await closeLocalMcpClient();
          await mcpIngress?.restart(engineHost);
        })().catch((err: unknown) => {
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
  const authIpc: AuthIpc = registerAuthIpc(ipcMain, {
    rebuildMenu: () => Menu.setApplicationMenu(buildMenu()),
    notifyRenderer: (channel, snapshot) => sendToRenderer(channel, snapshot),
    openLoginWindow: () => void openLoginWindow(),
  });
  authState = authIpc.authState;
  // A completed Google sign-in closes the login window (the page itself
  // shows "Signed in" first; the window is auxiliary UI).
  authState.onChange((s) => {
    if (s.phase === 'logged-in') closeLoginWindow();
  });
  // #101/#102: a gateway 401 that kills the stored token must move the
  // whole session to signed-out (machine + menu + renderer snapshot),
  // never just the file — otherwise the app desyncs into a dead session
  // whose sign-in button cannot open a window. The renderer learns via
  // the authState.onChange subscription registered above.
  setSessionLostHandler(() => {
    authState?.logout();
    Menu.setApplicationMenu(buildMenu());
  });

  // -- Desktop file Open/Save ------------------------------------------------
  // The renderer owns the storage adapters (real implementations, shared
  // with web); the main process only shows native dialogs and reads/writes
  // bytes, keeping Node fs APIs out of the renderer.
  ipcMain.handle(
    'file:pickOpen',
    async (): Promise<{ path: string; bytes: Uint8Array } | null> => {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return null;
      const res = await dialog.showOpenDialog(win, {
        title: 'Open workbook',
        properties: ['openFile'],
        filters: [
          { name: 'Spreadsheets', extensions: ['xlsx', 'csv', 'tsv', 'ods'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      if (res.canceled || res.filePaths.length === 0) return null;
      const filePath = res.filePaths[0];
      const data = fs.readFileSync(filePath);
      // GAP-10: the user explicitly picked this file — its directory
      // becomes the trusted dir for suggestedPath validation.
      trustedDir = trustedDirOf(filePath);
      return { path: filePath, bytes: new Uint8Array(data) };
    },
  );

  ipcMain.handle(
    'file:saveBytes',
    async (
      _event: IpcMainInvokeEvent,
      args: unknown,
    ): Promise<{ path: string | null }> => {
      if (!isRecord(args) || !(args['bytes'] instanceof Uint8Array || Array.isArray(args['bytes']))) {
        throw new Error('file:saveBytes: expected {bytes: Uint8Array, suggestedPath?}');
      }
      // Uint8Array is the current shape (binary clone); number[] is the
      // legacy shape and still accepted.
      const data = Buffer.from(args['bytes'] as Uint8Array);
      const suggested = typeof args['suggestedPath'] === 'string' ? args['suggestedPath'] : undefined;
      // GAP-3: the renderer may pass a suggestedName (e.g. an export
      // filename like "Sheet1.pdf") so the Save dialog pre-fills it
      // instead of the generic "workbook.xlsx".
      const suggestedName = typeof args['suggestedName'] === 'string' ? args['suggestedName'] : undefined;
      // GAP-10: a suggested path is honored only inside the directory of
      // the last user-picked/saved file — anything else (or no trusted
      // dir yet) falls back to the native Save dialog below.
      const target = resolveSaveTarget(suggested, trustedDir);
      if (target.mode === 'direct') {
        fs.writeFileSync(target.path, data);
        trustedDir = trustedDirOf(target.path);
        noteSaveBytesDestination(target.path, suggestedName);
        return { path: target.path };
      }
      const win = mainWindow;
      if (!win || win.isDestroyed()) return { path: null };
      const res = await dialog.showSaveDialog(win, {
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
      if (res.canceled || !res.filePath) return { path: null };
      fs.writeFileSync(res.filePath, data);
      // GAP-10: a dialog-confirmed save also establishes the trusted dir.
      trustedDir = trustedDirOf(res.filePath);
      noteSaveBytesDestination(res.filePath, suggestedName);
      return { path: res.filePath };
    },
  );

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
  ipcMain.handle(
    'engine:saveXlsxDirect',
    async (
      _event: IpcMainInvokeEvent,
      args: unknown,
    ): Promise<{
      path: string | null;
      mode?: 'verbatim' | 'adapter-fallback' | 'checkpoint-current';
      bytes?: number;
      changedSheets?: string[];
      skipped?: boolean;
    }> => {
      if (!isRecord(args)) {
        throw new Error('engine:saveXlsxDirect: expected {extras, suggestedPath?, suggestedName?}');
      }
      const extras = (isRecord(args['extras']) ? args['extras'] : {}) as DesktopSaveExtras;
      const suggested = typeof args['suggestedPath'] === 'string' ? args['suggestedPath'] : undefined;
      const suggestedName = typeof args['suggestedName'] === 'string' ? args['suggestedName'] : undefined;
      // These extras are the freshest the renderer has: background
      // checkpoints (Addendum 3) reuse them until a newer save/flush.
      setLastSaveExtras(extras);
      // (2) Destination first — same trust decision as file:saveBytes.
      const target = resolveSaveTarget(suggested, trustedDir);
      let destPath: string;
      if (target.mode === 'direct') {
        destPath = target.path;
      } else {
        const win = mainWindow;
        if (!win || win.isDestroyed()) return { path: null };
        const res = await dialog.showSaveDialog(win, {
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
        if (res.canceled || !res.filePath) return { path: null };
        destPath = res.filePath;
      }
      // Checkpoint-current skip (Addendum 3): continuous checkpointing
      // may already have this exact destination covered through the
      // live revision — a Save to the recorded autosave target with
      // nothing pending is then already durable, and re-serializing
      // would only rewrite identical state. The destination file must
      // still exist (an external delete defeats the skip).
      if (
        shouldSkipCheckpointCurrentSave({
          suggestedPath: suggested,
          destPath,
          destExists: fs.existsSync(destPath),
        })
      ) {
        noteCheckpointNoopSkip();
        console.log(
          `[direct-save] save skipped: checkpoint already current for ${destPath} (revision ${getLiveRevision()})`,
        );
        trustedDir = trustedDirOf(destPath);
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
      const cut = getLiveRevision();
      const result = await saveToDestinationAtomically(
        (tempPath) =>
          serializeDesktopWorkbook(engineHost, extras, tempPath, (m) =>
            console.log(`[direct-save] ${m}`),
          ),
        destPath,
      );
      // GAP-10: a completed save (trusted direct or dialog-confirmed)
      // establishes the trusted dir, exactly like file:saveBytes.
      trustedDir = trustedDirOf(destPath);
      // Addendum 3: this destination is now the autosave target, and
      // storage covers the captured cut.
      recordAutosaveTarget(destPath);
      markStorageCovered(cut);
      // Addendum 6: the save serialized the current session extras —
      // they are consumed (a change landing during the save keeps the
      // dirty flag for the next checkpoint).
      consumeSerializedSessionExtras();
      return {
        path: destPath,
        mode: result.mode,
        bytes: result.bytes,
        changedSheets: result.changedSheets,
      };
    },
  );

  // -- Autosave flush confirmation (Addendum 3) ---------------------------
  // The renderer's autosave no longer ships bytes: it asks main to force
  // any pending checkpoint batch NOW (through the same temp → verify →
  // atomic-rename sequence, reusing these extras as the freshest client
  // state) and reports the storage/live revisions back. caughtUp ===
  // (storageRevision === liveRevision): the local file holds every op
  // the live model has applied.
  ipcMain.handle(
    'engine:autosaveFlush',
    async (
      _event: IpcMainInvokeEvent,
      args: unknown,
    ): Promise<{
      storageRevision: number;
      liveRevision: number;
      caughtUp: boolean;
      flushedOps: number;
    }> => {
      if (isRecord(args) && isRecord(args['extras'])) {
        setLastSaveExtras(args['extras'] as DesktopSaveExtras);
      }
      return flushDesktopCheckpoint('renderer-flush');
    },
  );

  // -- Save status + session-extras sync (Addendum 6) ---------------------
  // Autosave ownership lives entirely in main: the renderer never
  // initiates a checkpoint on a timer any more. It (a) syncs its
  // session extras here as they change (state sync, not a save
  // trigger — main's scheduler decides when to flush, and the extras
  // are consumed by the next checkpoint/manual save), and (b) polls
  // the save status to display Saving…/Saved. Both channels are cheap:
  // no serialization, no file I/O.
  ipcMain.handle(
    'engine:sessionExtras',
    (_event: IpcMainInvokeEvent, args: unknown): { extrasDirty: boolean } => {
      if (!isRecord(args) || !isRecord(args['extras'])) {
        throw new Error('engine:sessionExtras: expected {extras}');
      }
      // #103: the renderer reports whether the open workbook is
      // server-hosted (remote session) or local. Main's journal is not
      // the durability authority for server files (server autosave +
      // the renderer's durable collab queue own them), so the quit
      // flush must not treat their extras as uncovered local work.
      if (typeof args['serverHosted'] === 'boolean') {
        setServerHostedWorkbook(args['serverHosted']);
      }
      setPendingSessionExtras(args['extras'] as DesktopSaveExtras);
      return { extrasDirty: isSessionExtrasDirty() };
    },
  );

  ipcMain.handle('engine:saveStatus', (): DesktopSaveStatus => getSaveStatus());

  ipcMain.handle(
    'svc:call',
    async (_event: IpcMainInvokeEvent, args: unknown): Promise<unknown> => {
      if (!isRecord(args) || typeof args['service'] !== 'string' || typeof args['path'] !== 'string') {
        throw new Error('svc:call: expected {service, path, method?, body?}');
      }
      const service = args['service'] as RemoteService;
      if (!['agent', 'etl', 'vault', 'meta', 'mcp', 'engine', 'gateway'].includes(service)) {
        throw new Error(`svc:call: unknown service "${service}"`);
      }
      return serviceCall(
        service,
        String(args['path']),
        typeof args['method'] === 'string' ? String(args['method']) : 'POST',
        args['body'],
      );
    },
  );

  // MCP direct-ingress discovery (platform-shell.md §8): the renderer's
  // diagnostics can show third-party clients where the desktop's own MCP
  // endpoint lives. The ingress itself is MCP's own direct ingress — it is
  // never behind the API gateway.
  ipcMain.handle('mcp:url', (): string => desktopMcpUrl());

  // Renderer readiness (GAP-9): the preload bridge calls `signalReady()`
  // once the renderer has attached its main→renderer event listeners.
  // Queued menu clicks / OS file opens are flushed here. Engine events
  // are not queued (they drop until ready — see sendEngineEvent).
  ipcMain.on('renderer:ready', () => {
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
//
// Issue #78: the SAME page is also opened in the user's default browser
// (shell.openExternal) — the embedded window's fresh context has no Google
// session, so Google serves its email-first form there, while the browser
// holds the user's session and shows the ACCOUNT CHOOSER. The browser page
// returns its ID token through the login server's /auth/complete route,
// bound to the attempt by a single-use flow nonce (browser-login.ts), and
// lands in the SAME completeFirebaseLogin() routine as the embedded
// page's IPC — one completion path. The embedded window remains the
// fallback (no browser / no session anywhere) and the flow's visible
// home: its close cancels the browser attempt, and the attempt's bounded
// wait frees it if the user never returns.
// ---------------------------------------------------------------------------

/** The shared auth state machine (created in registerIpc, post-app-ready). */
let authState: DesktopAuthState | null = null;

let loginWindow: BrowserWindow | null = null;
let loginServer: LoginServer | null = null;
/** The in-flight system-browser sign-in attempt (#78), if any. */
let browserLoginFlow: BrowserLoginFlow | null = null;

/**
 * Cancel + forget the browser sign-in attempt, if one is armed. The
 * flow's cancel() fails any in-flight login via the state machine and
 * is a no-op once the attempt has settled — so calling this on the
 * success path (the window closes BECAUSE sign-in completed) can never
 * knock out the session it just created.
 */
function cancelBrowserLogin(message: string): void {
  const flow = browserLoginFlow;
  browserLoginFlow = null;
  flow?.cancel(message);
}

/** Close the login window and tear down its loopback server, if any. */
function closeLoginWindow(): void {
  const win = loginWindow;
  loginWindow = null;
  if (win && !win.isDestroyed()) win.close();
  const srv = loginServer;
  loginServer = null;
  if (srv) void srv.close().catch(() => undefined);
  cancelBrowserLogin('Sign-in was cancelled before completing.');
}

async function openLoginWindow(): Promise<void> {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return;
  }
  const st = authState;
  if (st && st.snapshot().phase === 'logged-in') return; // nothing to do
  // THIS call is the single owner of the begin transition for the window
  // flow (#83): the completion handler in auth-ipc joins this in-flight
  // flow instead of beginning again. beginOrJoinLogin also covers the
  // rare race of a login in flight without a window — it joins silently
  // and the window opens so the user can complete it, never an error.
  st?.beginOrJoinLogin();

  // Config seam: missing config → the page renders the clear
  // not-configured error INSTEAD of a sign-in button (fail closed, no
  // silent dead button).
  let config: FirebaseWebConfig | null = null;
  let configError: string | undefined;
  try {
    config = loadFirebaseConfig({ userDataPath: app.getPath('userData') });
  } catch (err) {
    configError = err instanceof Error ? err.message : String(err);
    console.error('[auth] Firebase config missing:', configError);
  }
  if (!config) {
    // Record the failure on the machine so the UI can surface it; the
    // page shows the same message.
    st?.failLogin(configError ?? 'Firebase Auth is not configured.');
  }

  // Issue #78: arm the system-browser handoff. Skipped entirely when
  // there is no Firebase config (the fail-closed path above already ran;
  // a browser tab showing "not configured" helps nobody) or if the auth
  // state machine is somehow not up yet — the embedded window remains a
  // complete sign-in path on its own either way.
  let flow: BrowserLoginFlow | null = null;
  if (config && st) {
    flow = new BrowserLoginFlow({
      authState: st,
      completeLogin: (idToken) =>
        completeFirebaseLogin(st, idToken, {
          rebuildMenu: () => Menu.setApplicationMenu(buildMenu()),
        }),
    });
    flow.start();
    browserLoginFlow = flow;
  }
  const embeddedPage = buildLoginPage({ config, configError });
  let pageFor: (url: URL) => string = () => embeddedPage;
  let browserRoutes: Record<string, LoginServerRoute> | undefined;
  if (flow) {
    const activeFlow = flow;
    const browserPage = buildLoginPage({ config, browserFlow: activeFlow.pendingFlow ?? '' });
    // The login server picks the page variant per request: the browser's
    // URL carries the flow nonce (and ONLY that variant contains it);
    // the embedded window loads the plain URL and gets the IPC page.
    pageFor = (url: URL): string =>
      url.searchParams.get('flow') === activeFlow.pendingFlow ? browserPage : embeddedPage;
    browserRoutes = {
      'POST /auth/complete': async (req, respond) => {
        try {
          const body = asRecord(await readRequestJson(req));
          const outcome = await activeFlow.handleComplete({
            flow: body['flow'],
            idToken: body['idToken'],
          });
          if (outcome.ok) {
            respond(200, { ok: true, principal: outcome.principal });
            return;
          }
          const statusCode =
            outcome.reason === 'no-flow' ? 409 : outcome.reason === 'bad-nonce' ? 403 : 502;
          respond(statusCode, { ok: false, error: outcome.error });
        } catch (err) {
          respond(500, { ok: false, error: browserCompleteErrorMessage(err) });
        }
      },
      'POST /auth/cancel': async (req, respond) => {
        try {
          const body = asRecord(await readRequestJson(req));
          activeFlow.handleCancel({ flow: body['flow'] });
        } catch {
          // A malformed cancel can never break the flow: the bounded
          // wait and the window-close path still free the attempt.
        }
        respond(200, { ok: true });
      },
    };
  }

  let server: LoginServer;
  try {
    server = await startLoginServer(pageFor, browserRoutes ? { routes: browserRoutes } : {});
  } catch (err) {
    cancelBrowserLogin('Sign-in was cancelled before completing.');
    st?.failLogin(err instanceof Error ? err.message : String(err));
    return;
  }
  loginServer = server;

  loginWindow = new BrowserWindow({
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
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return { action: 'deny' };
    }
    const allowed =
      host.endsWith('.firebaseapp.com') ||
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
  } catch (err) {
    st?.failLogin(err instanceof Error ? err.message : String(err));
    closeLoginWindow();
    return;
  }

  // Issue #78: hand the same login page to the user's default browser,
  // where their Google session makes the account chooser appear. The
  // URL carries the flow nonce; the browser page returns the credential
  // through the server routes wired above. Fire-and-forget: a machine
  // with no usable default browser must fall back to the embedded
  // window, never fail the sign-in.
  if (flow) {
    const origin = server.url.replace(/\/login$/, '');
    void shell.openExternal(flow.browserUrl(origin)).catch((err: unknown) => {
      console.warn(
        '[auth] could not open the system browser for sign-in; the embedded sign-in window remains available:',
        err,
      );
    });
  }

  // #102: capture THIS window's refs for the 'closed' handler. The event
  // fires asynchronously after close(), so a retry can create a new
  // window/server/flow before this handler runs — clearing the module
  // refs unconditionally would nuke the retry's server + flow and fail
  // a login that belongs to the retry, not to this window. The
  // resolution clears only refs this window still owns, and fails the
  // login only when its attempt is fully intact.
  const closedWin = loginWindow;
  const closedSrv = loginServer;
  const closedFlow = browserLoginFlow;
  loginWindow.on('closed', () => {
    const r = resolveLoginWindowClosed(
      { win: loginWindow, srv: loginServer, flow: browserLoginFlow },
      { win: closedWin, srv: closedSrv, flow: closedFlow },
    );
    loginWindow = r.next.win;
    loginServer = r.next.srv;
    browserLoginFlow = r.next.flow;
    if (r.closeServer && closedSrv) void closedSrv.close().catch(() => undefined);
    // The browser attempt dies with its window (#78): a user who closed
    // the sign-in window abandoned every surface of the flow. No-op if
    // the attempt already settled (e.g. this close IS the success path —
    // authState.onChange closed the window because sign-in completed).
    if (r.cancelFlow && closedFlow) closedFlow.cancel('Sign-in was cancelled before completing.');
    // Window dismissed while the exchange was still in flight → the login
    // is cancelled, back to logged-out (no-op when already logged-in).
    // The Google popup is the other abandonable window in this flow: its
    // abandonment reaches failLogin via the page's auth:loginCancelled
    // report (auth-ipc.ts) — the page's signInWithPopup rejection is the
    // exact signal; a raw popup 'closed' event also fires when the SDK
    // closes the popup itself on success, so it is never wired directly.
    if (r.failLogin) st?.failLogin('Sign-in was cancelled before completing.');
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
function requestNewWorkbookConfirm(): Promise<boolean> {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return Promise.resolve(true);
  sendToRenderer('icecream:confirm-new');
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 60_000);
    ipcMain.once('icecream:confirm-new:reply', (_event, ok: unknown) => {
      clearTimeout(timer);
      resolve(ok === true);
    });
  });
}

async function newWorkbook(): Promise<void> {
  if (!(await requestNewWorkbookConfirm())) return;
  // Tear down the old workbook's worker pool first: worker threads keep
  // the process alive and would otherwise leak one pool per New Workbook.
  // The host instance stays (Cycle 10): only the workbook is swapped, so
  // the MCP ingress and the engine-event forwarder keep serving the live
  // workbook; the ingress restarts only to drop stale MCP sessions.
  engineHost.disposeParallelWorkers();
  engineHost.replaceWorkbook(new EngineWorkbook());
  configureParallelRecalc(engineHost);
  // Direct-save state dies with the workbook (blank base, empty journal).
  resetDesktopSaveBase();
  clearDesktopSaveOps();
  clearAutosaveTarget();
  // The blank workbook has no file path: triggers re-scope to untitled.
  rescopeTriggers(null);
  if (mcpIngress) {
    void (async () => {
      await closeLocalMcpClient();
      await mcpIngress?.restart(engineHost);
    })().catch((err: unknown) => {
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
let mcpIngress: DesktopMcpIngress | null = null;

/**
 * The desktop's local add-on service (add-on-model.md): initialized once at
 * Node service startup via createProductionAddonService(), which calls
 * initSigning() and configures the Ed25519 install-time verifier. Unsigned
 * manifests fail closed at install. Null when initialization failed — in
 * which case add-on installs are disabled entirely (also fail closed).
 */
let addonService: AddonService | null = null;

export function getAddonService(): AddonService | null {
  return addonService;
}

/** Start the desktop-local services: MCP ingress + production add-on service. */
async function startLocalServices(): Promise<void> {
  try {
    // The ingress serves the main-process host directly (Cycle 10): the
    // user's workbook lives here, protected by the same synced policy.
    mcpIngress = await startDesktopMcpIngress(engineHost);
  } catch (err) {
    // Never brick the app over the auxiliary MCP ingress: log loudly and
    // continue without it. Third-party MCP clients get no endpoint, and
    // built-in mcp calls fail with a clear "cannot reach" error.
    console.error(
      '[mcp] FAILED to start the desktop MCP direct ingress — third-party MCP is unavailable:',
      err instanceof Error ? err.message : err,
    );
    mcpIngress = null;
  }
  try {
    // @icecream-sheets/service ships as ESM; the Electron main process
    // compiles to CJS, so import it dynamically.
    const { createProductionAddonService } = (await import(
      '@icecream-sheets/service'
    )) as typeof import('@icecream-sheets/service');
    addonService = await createProductionAddonService();
    console.log('[addons] production add-on service ready: Ed25519 install verifier active');
  } catch (err) {
    console.error(
      '[addons] FAILED to initialize the production add-on service — add-on installs are disabled:',
      err instanceof Error ? err.message : err,
    );
    addonService = null;
  }
}

// ---------------------------------------------------------------------------
// Window + menu
// ---------------------------------------------------------------------------

/**
 * Issue #57 — the native quit-confirmation for uncovered work: the
 * quit flush could not write some changes (a never-saved workbook has
 * no destination; or the checkpoint failed). Ask BEFORE discarding
 * them. This is the designed unsaved-changes surface — the renderer's
 * beforeunload veto cannot be it (Electron renders no prompt for a
 * veto; it just cancels, silently — the swallowed-quit defect).
 * Resolves true = "Quit Anyway" (discard), false = stay.
 */
async function confirmQuitWithUncoveredWork(outcome: QuitFlushOutcome): Promise<boolean> {
  const last = outcome.lastResult;
  const detail = last
    ? `Storage holds revision ${last.storageRevision} of ${last.liveRevision} — the rest could not be written (the workbook may never have been saved to a file, or its last checkpoint failed). Quitting now will discard those changes.`
    : 'The pending changes could not be written to disk. Quitting now will discard them.';
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const res = parent
    ? await dialog.showMessageBox(parent, {
        type: 'warning',
        buttons: ['Quit Anyway', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Unsaved changes could not be saved',
        message: 'Some changes have not been saved.',
        detail,
      })
    : await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Quit Anyway', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Unsaved changes could not be saved',
        message: 'Some changes have not been saved.',
        detail,
      });
  return res.response === 0;
}

/**
 * Issue #57 — the main window's close guard. Root cause of the
 * swallowed quit/close: quitting only ever reached the app through
 * before-quit (guarded) — a WINDOW close (the red button, Alt+F4)
 * went straight to the renderer, whose desktop beforeunload handler
 * vetoes every close while the workbook is dirty, with NO prompt
 * (Electron shows nothing for a veto): the close simply never
 * happened, and for app.quit() the same veto fired when Electron
 * closed the window during quit — after the close-flush teardown had
 * already disposed the engine — leaving an immortal, engine-less app.
 * Now every window close routes through main first:
 *  - Once the guarded quit flow has completed ('done'), closes pass:
 *    the approved quit destroys the windows itself before re-issuing.
 *  - Non-macOS: closing the window IS quitting — intercept and run
 *    the one guarded quit flow (flush → confirm if uncovered →
 *    teardown → quit), identical to before-quit.
 *  - macOS: the app outlives its window, but pending work must not be
 *    stranded in a windowless app or vanish silently — intercept,
 *    run the bounded flush; if it leaves work uncovered, ask (the
 *    same native confirm) before destroying the window; a "stay"
 *    answer keeps the window and the session exactly as they were.
 */
function guardMainWindowClose(event: { preventDefault(): void }): void {
  const controller = quitFlushController;
  const win = mainWindow;
  if (!controller || !win || controller.phase === 'done') return;
  event.preventDefault();
  if (process.platform !== 'darwin') {
    controller.requestQuit();
    return;
  }
  void (async () => {
    const outcome = await controller.flushOnly('window-close');
    if (outcomeLeavesWorkUncovered(outcome)) {
      const proceed = await confirmQuitWithUncoveredWork(outcome).catch(() => false);
      if (!proceed) {
        console.log(
          '[close-flush] window close cancelled: unsaved changes could not be written and the user chose to stay',
        );
        return;
      }
    }
    if (!win.isDestroyed()) win.destroy();
  })();
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Issue #57: window closes route through the guarded quit/close
  // flow in main (see guardMainWindowClose) — never straight to the
  // renderer's silent beforeunload veto.
  mainWindow.on('close', (event) => {
    guardMainWindowClose(event);
  });

  const indexHtml = resolveRendererIndex({
    distDir: __dirname,
    resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
  });

  if (indexHtml !== null) {
    void mainWindow.loadFile(indexHtml);
  } else {
    const html = getFallbackHtml(ENGINE_PROTOCOL_VERSION);
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

function buildMenu(): Menu {
  const isMac = process.platform === 'darwin';
  const quitItem: MenuItemConstructorOptions = { role: 'quit' };

  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [{ role: 'about' }, { type: 'separator' }, quitItem],
    });
  }

  template.push(
    {
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
    },
    {
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
    },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }],
    },
    {
      // Spec d: remote services (AI agent, ETL, vault) require login.
      // Logged out = local engine only. The menu reflects live status.
      label: 'Account',
      submenu: (() => {
        const st = status();
        const items: MenuItemConstructorOptions[] = [
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
              // #102: the FULL logout (token + machine + menu + renderer
              // snapshot) — the old token-only logout left the machine
              // 'logged-in' and wedged every later sign-in attempt.
              const s = authState;
              if (s) {
                performLogout(s, {
                  rebuildMenu: () => Menu.setApplicationMenu(buildMenu()),
                  notifyRenderer: (channel, snapshot) => sendToRenderer(channel, snapshot),
                });
              } else {
                logout();
                Menu.setApplicationMenu(buildMenu());
              }
            },
          });
        } else {
          items.push({
            label: 'Sign in…',
            click: () => openLoginWindow(),
          });
        }
        items.push({ type: 'separator' });
        items.push({
          label: `Gateway: ${gatewayUrl()}`,
          enabled: false,
        });
        return items;
      })(),
    },
    {
      // GAP-7: Help opens product-owned docs (platform-shell.md §5) in the
      // renderer's HelpPane — no external service dependency.
      label: 'Help',
      submenu: [
        {
          label: 'Icecream Sheets Help',
          click: () => sendToRenderer('icecream:menu-help'),
        },
      ],
    },
  );

  return Menu.buildFromTemplate(template);
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

void app.whenReady().then(async () => {
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
  const launchPath = findLaunchFilePath(process.argv);
  if (launchPath) openPathFromOs(launchPath);

  Menu.setApplicationMenu(buildMenu());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Close-flush (Item E — revision-model §§5, 7, 11): the FIRST
// before-quit is intercepted by the close-flush controller, which
// flushes the pending checkpoint batch to the workbook's destination
// (bounded by QUIT_FLUSH_TIMEOUT_MS) BEFORE the teardown below runs —
// disposing the host first would destroy the live model the flush
// serializes, and the unref'd 1500 ms settle timer alone loses an edit
// followed by an immediate quit. The controller then runs this
// teardown exactly once and re-issues app.quit(), whose before-quit
// passes through untouched. This also covers the non-macOS
// window-all-closed → app.quit() path above: it funnels through the
// same before-quit event.
// Issue #57 completes the shape: when the flush leaves work UNCOVERED
// (a never-saved workbook has no destination; a failed checkpoint), the
// user is asked natively (confirmUncovered) and a "stay" answer aborts
// the quit with nothing torn down; on the proceed path the windows are
// force-closed (destroyWindows) BEFORE teardown, so the renderer's
// silent beforeunload veto can no longer swallow an approved quit
// after the engine is gone. Window closes route through the same
// machinery via guardMainWindowClose (wired in createWindow).
quitFlushController = installCloseFlush(app, {
  flush: (reason) => flushDesktopCheckpoint(reason),
  log: (m) => console.log(m),
  confirmUncovered: (outcome) => confirmQuitWithUncoveredWork(outcome),
  destroyWindows: () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.destroy();
    }
  },
  teardown: () => {
    // Detach the trigger runtime from the engine host before teardown.
    triggerManager?.dispose();
    triggerManager = null;
    if (mcpIngress) {
      void mcpIngress.close().catch(() => undefined);
      mcpIngress = null;
    }
    void closeLocalMcpClient();
    // Terminate the parallel-recalculation workers before tearing down the
    // host: worker threads keep the process alive, and a clean shutdown
    // must not wait on (or leak) them.
    engineHost.disposeParallelWorkers();
    engineHost.dispose();
  },
  quit: () => app.quit(),
});
