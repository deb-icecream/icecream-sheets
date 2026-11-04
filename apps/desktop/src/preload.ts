/**
 * Icecream Sheets — preload script.
 *
 * Runs in the isolated preload context. Its only job is to expose the
 * validated engine IPC surface as `window.icecream` (the user's workbook
 * lives in the main-process engine; Cycle 10 engine/view separation) and
 * the desktop shell API as `window.icecreamDesktop` via contextBridge.
 * No Node APIs leak into the renderer.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  CellRef,
  CommandResult,
  EngineCommand,
  EngineEvent,
  EngineLoadResult,
  RangeRef,
  TypedValue,
  WorkbookSnapshot,
} from '@icecream-sheets/engine';
import type { TriggerSpecInit } from '@icecream-sheets/service';
import type { TriggerListResult, TriggerStatus } from './triggers';

/**
 * The engine:execute reply: the bare CommandResult, plus — for cell
 * edits — the post-edit values of the edited cell and its dependents
 * (issue #58: one roundtrip per edit; the renderer seeds its caches
 * from these and never re-fetches after an edit). Structurally mirrors
 * DesktopEditReplyValue in ./engine-ipc.
 */
export interface EngineExecuteReplyValue {
  ref: CellRef;
  value: TypedValue;
  formulaKnown?: boolean;
  formula?: string;
}
export type EngineExecuteReply = CommandResult & {
  values?: EngineExecuteReplyValue[];
};

/** Renderer-facing engine API. Mirrors the main-process IPC handlers 1:1. */
export interface IcecreamApi {
  execute(command: EngineCommand): Promise<EngineExecuteReply>;
  /**
   * One cell's value through authorize() (permission-model.md §4), with
   * its formula when readable — the gateway's cell-read shape, so the
   * formula bar and editor seeding stream over the same channel.
   */
  readCell(ref: CellRef): Promise<{ value: TypedValue; formula?: string }>;
  readRange(range: RangeRef): Promise<TypedValue[][]>;
  usedRange(sheet: string): Promise<RangeRef | null>;
  snapshot(): Promise<WorkbookSnapshot>;
  protocolVersion(): Promise<number>;
  /**
   * Open a workbook INTO the main-process engine (Cycle 10 engine/view
   * separation): the main process parses (storage adapter) + builds
   * (EngineWorkbook); the renderer only receives sheet summaries +
   * adapter metadata — cell grids never cross IPC, and no parse/build/
   * recalc work ever runs on the renderer's UI thread.
   */
  load(bytes: Uint8Array, filename: string): Promise<EngineLoadResult>;
  /** Reset the main-process engine to a blank workbook (desktop New). */
  newWorkbook(): Promise<void>;
  /**
   * Push the renderer's ProtectionManager state (toMetadata) to the
   * main-process host so it enforces the same protection policy (locked
   * cells, structure flags, hidden cells) — including for MCP clients.
   */
  setProtection(state: Record<string, unknown>): Promise<void>;
  /**
   * Subscribe to engine events from the MAIN-process host (cellsChanged /
   * recalcComplete / sheetAdded / sheetRemoved). Events originate in the
   * main-process engine now; this is the live-update feed the grid
   * renders from. Returns an unsubscribe function.
   */
  onEngineEvent(cb: (event: EngineEvent) => void): () => void;
}

const icecreamApi: IcecreamApi = {
  execute: (command: EngineCommand): Promise<EngineExecuteReply> =>
    ipcRenderer.invoke('engine:execute', command) as Promise<EngineExecuteReply>,
  readCell: (ref: CellRef): Promise<{ value: TypedValue; formula?: string }> =>
    ipcRenderer.invoke('engine:readCell', ref) as Promise<{ value: TypedValue; formula?: string }>,
  readRange: (range: RangeRef): Promise<TypedValue[][]> =>
    ipcRenderer.invoke('engine:readRange', range) as Promise<TypedValue[][]>,
  usedRange: (sheet: string): Promise<RangeRef | null> =>
    ipcRenderer.invoke('engine:usedRange', sheet) as Promise<RangeRef | null>,
  snapshot: (): Promise<WorkbookSnapshot> =>
    ipcRenderer.invoke('engine:snapshot') as Promise<WorkbookSnapshot>,
  protocolVersion: (): Promise<number> =>
    ipcRenderer.invoke('engine:protocolVersion') as Promise<number>,
  load: (bytes: Uint8Array, filename: string): Promise<EngineLoadResult> =>
    ipcRenderer.invoke('engine:load', { bytes, filename }) as Promise<EngineLoadResult>,
  newWorkbook: (): Promise<void> =>
    ipcRenderer.invoke('engine:new') as Promise<void>,
  setProtection: (state: Record<string, unknown>): Promise<void> =>
    ipcRenderer.invoke('engine:protection', state) as Promise<void>,
  onEngineEvent: (cb: (event: EngineEvent) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: unknown) =>
      cb(payload as EngineEvent);
    ipcRenderer.on('icecream:engine-event', listener);
    return () => ipcRenderer.removeListener('icecream:engine-event', listener);
  },
};

contextBridge.exposeInMainWorld('icecream', icecreamApi);

// ---------------------------------------------------------------------------
// Desktop remote services (spec d): login-gated gateway access.
// The JWT lives in the main process (safeStorage); the renderer only gets
// status + proxied service calls. Local engine features work logged out.
// ---------------------------------------------------------------------------

/** Renderer-facing desktop API. Separate from the web app's gateway client (spec e). */
export interface AuthSnapshot {
  phase: 'logged-out' | 'logging-in' | 'logged-in';
  principal: string | null;
  error: string | null;
}

/**
 * Session extras for a direct streaming save (the web app's
 * buildServerSaveExtras shape): client-owned metadata / defined-name /
 * dims / styles state the main-process serializer merges over its live
 * model. No cell data ever rides in here.
 */
export interface DesktopSaveExtras {
  extraMetadata?: Record<string, unknown>;
  definedNames?: unknown;
  sheetDims?: Record<string, unknown>;
  sheetStyles?: Record<string, Record<string, unknown>>;
}

/** Result of a direct streaming save (engine:saveXlsxDirect). */
export interface DesktopSaveXlsxDirectResult {
  /** Final path, or null when the Save dialog was cancelled. */
  path: string | null;
  /**
   * Serializer mode, present on a completed save ('checkpoint-current'
   * when continuous checkpointing already covered the destination and
   * the save was skipped — see `skipped`).
   */
  mode?: 'verbatim' | 'adapter-fallback' | 'checkpoint-current';
  /** Serialized package size in bytes, present on a completed save. */
  bytes?: number;
  /** Sheets the serializer regenerated, present on a completed save. */
  changedSheets?: string[];
  /** True when the save was skipped as already checkpoint-current. */
  skipped?: boolean;
}

/** Save status snapshot (engine:saveStatus, Addendum 6). */
export interface DesktopSaveStatusResult {
  /** Total journaled ops applied to the live model. */
  liveRevision: number;
  /** Journal cut covered by the local file. */
  storageRevision: number;
  /** Synced session extras changed since the last successful serialize. */
  extrasDirty: boolean;
  /** Successful main-process checkpoint writes so far. */
  flushes: number;
  /** Strict no-op save checks so far (zero writes each). */
  noopSkips: number;
}

/** Result of an autosave flush (engine:autosaveFlush, Addendum 3). */
export interface DesktopAutosaveFlushResult {
  /** Journal cut covered by the local file after the flush. */
  storageRevision: number;
  /** Total journaled ops applied to the live model. */
  liveRevision: number;
  /** True when the local file holds every live op. */
  caughtUp: boolean;
  /** Ops this flush wrote (0 when already caught up). */
  flushedOps: number;
}

/**
 * Trigger management bridge (desktop local mode): mirrors the gateway
 * automation contract minus fileId — the main process's
 * TriggerHostManager is already scoped to the currently open file.
 * list() returns the events this topology can fire plus the triggers.
 */
export interface DesktopTriggersApi {
  list(): Promise<TriggerListResult>;
  create(spec: TriggerSpecInit): Promise<TriggerStatus>;
  remove(id: string): Promise<boolean>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  grant(id: string): Promise<void>;
}

export interface IcecreamDesktopApi {
  triggers: DesktopTriggersApi;
  auth: {
    login(userId: string): Promise<{ loggedIn: boolean; principal: string | null; error?: string }>;
    /**
     * Cycle 9: complete Google sign-in. The login window hands the Firebase
     * ID token to the main process, which exchanges it for the gateway JWT
     * (stored in safeStorage — the renderer never sees it).
     */
    loginWithFirebase(
      idToken: string,
    ): Promise<{ loggedIn: boolean; principal: string | null; error?: string }>;
    /**
     * Report that the user abandoned the Google popup (closed/cancelled)
     * so the main process fails the in-flight login back to logged-out
     * (#80) instead of leaving it stuck at 'logging-in'.
     */
    loginCancelled(): Promise<void>;
    logout(): Promise<void>;
    status(): Promise<{ loggedIn: boolean; principal: string | null }>;
    openLoginWindow(): Promise<void>;
    /** Subscribe to auth state-machine transitions (no polling needed). */
    onAuthChanged(cb: (snapshot: AuthSnapshot) => void): () => void;
  };
  svc: {
    call(
      service: 'agent' | 'etl' | 'vault' | 'meta' | 'mcp' | 'engine',
      path: string,
      method: string,
      body?: unknown,
    ): Promise<unknown>;
  };
  mcp: {
    /**
     * URL of the desktop's own MCP direct ingress (platform-shell.md §8),
     * e.g. http://127.0.0.1:8106 — third-party MCP clients connect here
     * directly, never via the API gateway.
     */
    url(): Promise<string>;
  };
  file: {
    pickOpen(): Promise<{ path: string; bytes: Uint8Array } | null>;
    saveBytes(
      bytes: Uint8Array,
      suggestedPath?: string,
      suggestedName?: string,
    ): Promise<{ path: string | null }>;
    /**
     * Direct streaming save (direct-save pass): the MAIN process
     * serializes its LIVE engine model through the shared streaming
     * serializer (temp file in the destination dir → verify → atomic
     * rename) — no workbook bytes cross this bridge at all, in either
     * direction. With suggestedPath the save writes in place (same
     * GAP-10 trust rules as saveBytes); without it the native Save
     * dialog shows. A rejected promise is a save error: the previous
     * destination file is untouched.
     */
    saveXlsxDirect(
      extras: DesktopSaveExtras,
      suggestedPath?: string,
      suggestedName?: string,
    ): Promise<DesktopSaveXlsxDirectResult>;
    /**
     * Autosave flush confirmation (Addendum 3): force any pending
     * main-process checkpoint batch to the workbook's recorded
     * destination now (or report already caught up). No workbook bytes
     * cross the bridge — only the optional session extras ride along
     * (they become the checkpoint's freshest client state).
     */
    autosaveFlush(extras?: DesktopSaveExtras): Promise<DesktopAutosaveFlushResult>;
    /**
     * Save status (Addendum 6): main owns autosave entirely; the
     * renderer only POLLS this (cheap, no side effects, no writes) to
     * display Saving…/Saved — it never initiates a checkpoint.
     */
    saveStatus(): Promise<DesktopSaveStatusResult>;
    /**
     * Session-extras sync (Addendum 6): push the renderer's current
     * session extras (styles/dims/name extras/metadata) to main as
     * they change. State sync only — main decides when to flush;
     * checkpoints consume the pending extras.
     * #103: the renderer also reports whether the open workbook is
     * server-hosted, so main's quit flush never treats a server file's
     * extras as uncovered local work.
     */
    syncSessionExtras(
      extras: DesktopSaveExtras,
      serverHosted?: boolean,
    ): Promise<{ extrasDirty: boolean }>;
    /** Fired when the native File menu's Open item is clicked. */
    onMenuOpen(cb: () => void): () => void;
    /** Fired when the native File menu's Save item is clicked. */
    onMenuSave(cb: () => void): () => void;
    /**
     * Fired when the native File menu's Save As item is clicked (GAP-7).
     * The renderer answers with desktopSaveBytes(bytes) and NO suggested
     * path, so the main process shows the Save dialog.
     */
    onMenuSaveAs(cb: () => void): () => void;
    /**
     * Fired when File → New Workbook is picked (GAP-6 dirty guard): the
     * renderer answers whether discarding the current workbook is OK.
     */
    onConfirmNew(cb: () => Promise<boolean>): () => void;
    /**
     * Fired when the OS opens a workbook for the app (double-click /
     * open-with, GAP-4). Bytes travel with the event so the renderer
     * never needs fs access.
     */
    onOpenPath(cb: (info: { path: string; bytes: Uint8Array }) => void): () => void;
  };
  menu: {
    /**
     * Fired when Preferences (Cmd+,) is picked (GAP-7): the renderer
     * opens SettingsDialog (platform-shell.md §4).
     */
    onPreferences(cb: () => void): () => void;
    /**
     * Fired when the Help menu's help item is picked (GAP-7): the
     * renderer opens HelpPane (platform-shell.md §5).
     */
    onHelp(cb: () => void): () => void;
  };
  /**
   * Tell the main process the renderer has attached its main→renderer
   * event listeners (GAP-9): queued menu clicks / OS file opens are
   * flushed in response.
   */
  signalReady(): void;
}

/** Typed subscribe-to-channel helper for the new main→renderer events. */
function listen(channel: string, cb: (payload: unknown) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: unknown) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const desktopApi: IcecreamDesktopApi = {
  triggers: {
    list: () => ipcRenderer.invoke('triggers:list') as Promise<TriggerListResult>,
    create: (spec: TriggerSpecInit) =>
      ipcRenderer.invoke('triggers:create', spec) as Promise<TriggerStatus>,
    remove: (id: string) => ipcRenderer.invoke('triggers:remove', id) as Promise<boolean>,
    setEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke('triggers:setEnabled', id, enabled) as Promise<void>,
    grant: (id: string) => ipcRenderer.invoke('triggers:grant', id) as Promise<void>,
  },
  auth: {
    login: (userId: string) =>
      ipcRenderer.invoke('auth:login', userId) as Promise<{
        loggedIn: boolean;
        principal: string | null;
        error?: string;
      }>,
    logout: (): Promise<void> => ipcRenderer.invoke('auth:logout') as Promise<void>,
    status: () =>
      ipcRenderer.invoke('auth:status') as Promise<{ loggedIn: boolean; principal: string | null }>,
    loginWithFirebase: (idToken: string) =>
      ipcRenderer.invoke('auth:loginWithFirebase', idToken) as Promise<{
        loggedIn: boolean;
        principal: string | null;
        error?: string;
      }>,
    loginCancelled: (): Promise<void> =>
      ipcRenderer.invoke('auth:loginCancelled') as Promise<void>,
    openLoginWindow: (): Promise<void> =>
      ipcRenderer.invoke('auth:openLoginWindow') as Promise<void>,
    onAuthChanged: (cb: (snapshot: AuthSnapshot) => void): (() => void) =>
      listen('auth:changed', (payload) => cb(payload as AuthSnapshot)),
  },
  svc: {
    call: (service, path, method, body) =>
      ipcRenderer.invoke('svc:call', { service, path, method, body }) as Promise<unknown>,
  },
  mcp: {
    url: () => ipcRenderer.invoke('mcp:url') as Promise<string>,
  },
  file: {
    pickOpen: () =>
      ipcRenderer.invoke('file:pickOpen') as Promise<{ path: string; bytes: Uint8Array } | null>,
    saveBytes: (bytes, suggestedPath, suggestedName) =>
      // GAP-3: suggestedName pre-fills the Save dialog (export filename);
      // undefined keeps main's "workbook.xlsx" default.
      ipcRenderer.invoke('file:saveBytes', { bytes, suggestedPath, suggestedName }) as Promise<{
        path: string | null;
      }>,
    saveXlsxDirect: (extras, suggestedPath, suggestedName) =>
      ipcRenderer.invoke('engine:saveXlsxDirect', {
        extras,
        suggestedPath,
        suggestedName,
      }) as Promise<DesktopSaveXlsxDirectResult>,
    autosaveFlush: (extras) =>
      ipcRenderer.invoke('engine:autosaveFlush', { extras }) as Promise<DesktopAutosaveFlushResult>,
    saveStatus: () =>
      ipcRenderer.invoke('engine:saveStatus') as Promise<DesktopSaveStatusResult>,
    syncSessionExtras: (extras, serverHosted) =>
      ipcRenderer.invoke('engine:sessionExtras', { extras, serverHosted }) as Promise<{
        extrasDirty: boolean;
      }>,
    onMenuOpen: (cb) => {
      const listener = () => cb();
      ipcRenderer.on('icecream:menu-open', listener);
      return () => ipcRenderer.removeListener('icecream:menu-open', listener);
    },
    onMenuSave: (cb) => {
      const listener = () => cb();
      ipcRenderer.on('icecream:menu-save', listener);
      return () => ipcRenderer.removeListener('icecream:menu-save', listener);
    },
    onMenuSaveAs: (cb) => listen('icecream:menu-save-as', () => cb()),
    /**
     * Fired when File → New Workbook is picked (GAP-6 dirty guard). The
     * callback answers whether the current workbook may be discarded:
     * true when nothing is unsaved, otherwise the user's confirm answer.
     * The answer is sent back on 'icecream:confirm-new:reply'.
     */
    onConfirmNew: (cb) => {
      const listener = async () => {
        const ok = await cb();
        ipcRenderer.send('icecream:confirm-new:reply', ok);
      };
      ipcRenderer.on('icecream:confirm-new', listener);
      return () => ipcRenderer.removeListener('icecream:confirm-new', listener);
    },
    onOpenPath: (cb) =>
      listen('icecream:open-path', (payload) => {
        const info = payload as { path: string; bytes: Uint8Array | number[] };
        if (
          info &&
          typeof info.path === 'string' &&
          (info.bytes instanceof Uint8Array || Array.isArray(info.bytes))
        ) {
          // Normalize the legacy number[] shape at the bridge boundary;
          // main now sends a Uint8Array (binary clone, no per-byte walk).
          cb({
            path: info.path,
            bytes: info.bytes instanceof Uint8Array ? info.bytes : new Uint8Array(info.bytes),
          });
        }
      }),
  },
  menu: {
    onPreferences: (cb) => listen('icecream:menu-preferences', () => cb()),
    onHelp: (cb) => listen('icecream:menu-help', () => cb()),
  },
  signalReady: (): void => {
    ipcRenderer.send('renderer:ready');
  },
};

contextBridge.exposeInMainWorld('icecreamDesktop', desktopApi);
