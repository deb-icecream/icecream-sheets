/**
 * Desktop AI Agent backend (spec d/e).
 *
 * Separate from the web app's gateway client (spec e): on desktop the
 * renderer reaches remote services through the Electron main process
 * (`window.icecreamDesktop.svc`), which holds the JWT in safeStorage.
 * The local engine is used directly; only the agent (and other remote
 * services) go through the gateway — and only when signed in.
 */
import type { AgentReply, AuditEntry, PendingInput, PendingAskView } from '@icecream-sheets/service';
import type { AgentChatBackend } from './remoteAgent';

/**
 * The auth snapshot as it actually crosses the bridge (issue #89): the
 * main process's DesktopAuthState publishes `{ phase, principal, error }`
 * on 'auth:changed' — there is NO `loggedIn` field on the wire. (The
 * auth:status IPC, by contrast, returns `{ loggedIn, principal }`.)
 * Before this normalization existed, the subscription below was typed
 * as if the STATUS shape arrived on the CHANGE channel: the App read
 * `snapshot.loggedIn`, got `undefined` forever, and the post-login live
 * transition to the Workspace never fired — only a manual Reload (which
 * re-asks via auth:status) recovered it. Both shapes are accepted here
 * so the ingestion point is robust to either publisher.
 */
export interface DesktopAuthWireSnapshot {
  phase?: 'logged-out' | 'logging-in' | 'logged-in';
  loggedIn?: boolean;
  principal: string | null;
  error?: string | null;
}

/** Normalize a wire auth snapshot to the shape subscribers consume. */
export function normalizeDesktopAuthSnapshot(wire: DesktopAuthWireSnapshot): {
  loggedIn: boolean;
  principal: string | null;
} {
  if (typeof wire?.loggedIn === 'boolean') {
    return { loggedIn: wire.loggedIn, principal: wire.principal ?? null };
  }
  return { loggedIn: wire?.phase === 'logged-in', principal: wire?.principal ?? null };
}

interface DesktopApi {
  auth: {
    status(): Promise<{ loggedIn: boolean; principal: string | null }>;
    openLoginWindow(): Promise<void>;
    logout?(): Promise<void>;
    onAuthChanged?(
      cb: (snapshot: DesktopAuthWireSnapshot) => void,
    ): () => void;
  };
  svc: {
    call(
      service: 'agent' | 'etl' | 'vault' | 'meta' | 'mcp' | 'engine' | 'gateway',
      path: string,
      method: string,
      body?: unknown,
    ): Promise<unknown>;
  };
  mcp: {
    /** URL of the desktop's own MCP direct ingress (platform-shell.md §8). */
    url(): Promise<string>;
  };
  file?: {
    /** Renderer-initiated Open: native dialog → {path, bytes} or null. */
    pickOpen(): Promise<{ path: string; bytes: Uint8Array } | null>;
    /**
     * Renderer-initiated Save: writes bytes. With suggestedPath the file is
     * written directly (desktop Save); otherwise a Save dialog is shown.
     * suggestedName (GAP-3) pre-fills the dialog filename for exports
     * (PDF / encrypted / CSV-TSV-ODS) instead of "workbook.xlsx".
     */
    saveBytes(bytes: Uint8Array, suggestedPath?: string, suggestedName?: string): Promise<{ path: string | null }>;
    /**
     * Direct streaming save (direct-save pass): the main process
     * serializes its LIVE engine model through the shared streaming
     * serializer — no bytes cross the bridge. Optional on the interface
     * so older desktop bridges feature-detect as absent.
     */
    saveXlsxDirect?(
      extras: DesktopSaveExtras,
      suggestedPath?: string,
      suggestedName?: string,
    ): Promise<DesktopSaveXlsxDirectResult>;
    /**
     * Autosave flush confirmation (Addendum 3): force any pending
     * main-process checkpoint batch now / report caught-up. Optional
     * on the interface so older bridges feature-detect as absent.
     */
    autosaveFlush?(extras?: DesktopSaveExtras): Promise<DesktopAutosaveFlushResult>;
    /**
     * Save status (Addendum 6): main owns autosave; the renderer polls
     * this to display Saving…/Saved. Optional = older bridges absent.
     */
    saveStatus?(): Promise<DesktopSaveStatusResult>;
    /**
     * Session-extras sync (Addendum 6): push session extras to main as
     * they change (state sync, never a save trigger).
     * #103: serverHosted reports whether the open workbook is
     * server-hosted, so main's quit flush never treats a server file's
     * extras as uncovered local work.
     */
    syncSessionExtras?(extras: DesktopSaveExtras, serverHosted?: boolean): Promise<{ extrasDirty: boolean }>;
    /** Subscribe to the native File menu's Open / Save items. */
    onMenuOpen(cb: () => void): () => void;
    onMenuSave(cb: () => void): () => void;
    /** Subscribe to the native File menu's Save As item (Save dialog flow). */
    onMenuSaveAs?(cb: () => void): () => void;
    /**
     * Subscribe to File → New Workbook's dirty guard (GAP-6): the callback
     * answers whether discarding the current workbook is OK. Main waits
     * for the answer before reloading; no answer in time aborts the New.
     */
    onConfirmNew?(cb: () => Promise<boolean>): () => void;
    /** Subscribe to OS-triggered workbook opens (double-click / open-with). */
    onOpenPath?(cb: (info: { path: string; bytes: Uint8Array }) => void): () => void;
  };
  menu?: {
    /** Subscribe to Preferences (Cmd+,) → SettingsDialog. */
    onPreferences?(cb: () => void): () => void;
    /** Subscribe to the Help menu's help item → HelpPane. */
    onHelp?(cb: () => void): () => void;
  };
  /** Tell main the renderer has attached its listeners (GAP-9 queue flush). */
  signalReady?(): void;
}

function desktop(): DesktopApi | null {
  return (
    (typeof window !== 'undefined'
      ? (window as unknown as { icecreamDesktop?: DesktopApi }).icecreamDesktop
      : undefined) ?? null
  );
}

export function isDesktop(): boolean {
  return desktop() !== null;
}

export async function desktopAuthStatus(): Promise<{
  loggedIn: boolean;
  principal: string | null;
}> {
  const d = desktop();
  if (!d) return { loggedIn: false, principal: null };
  return d.auth.status();
}

export function openDesktopLogin(): void {
  const d = desktop();
  if (d) void d.auth.openLoginWindow();
}

/** Sign out through the desktop shell (drops main's safeStorage JWT). */
export function desktopLogout(): void {
  const d = desktop();
  if (d?.auth.logout) void d.auth.logout();
}

/**
 * Subscribe to desktop auth transitions (the shell pushes 'auth:changed').
 * Returns an unsubscribe function; a no-op subscription off-desktop.
 */
export function onDesktopAuthChanged(
  cb: (snapshot: { loggedIn: boolean; principal: string | null }) => void,
): () => void {
  const d = desktop();
  if (!d?.auth.onAuthChanged) return () => undefined;
  // Issue #89: the bridge delivers the main process's phase-shaped
  // snapshot; normalize at this single ingestion point so every
  // subscriber sees the { loggedIn, principal } shape it expects.
  return d.auth.onAuthChanged((wire) => cb(normalizeDesktopAuthSnapshot(wire)));
}

/**
 * One gateway-NATIVE call through the desktop shell (stream 1,
 * Workspace-in-desktop): main attaches the safeStorage JWT the renderer
 * never sees and returns a { status, body } envelope instead of throwing
 * on HTTP errors, so the renderer's GatewayClient can reproduce its fetch
 * semantics exactly (401/429/verbatim error bodies). Returns null when
 * there is no desktop bridge (web) — callers then use their normal path.
 * Throws only on transport failure or when signed out (from main).
 */
export async function desktopGatewayCall(
  path: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; body: unknown } | null> {
  const d = desktop();
  if (!d) return null;
  const res = (await d.svc.call('gateway', path, method, body)) as {
    status?: unknown;
    body?: unknown;
  } | null;
  if (!res || typeof res.status !== 'number') {
    throw new Error('desktop gateway bridge returned a malformed envelope');
  }
  return { status: res.status, body: res.body };
}

interface AgentMessageResponse {
  threadId: string;
  message: string;
  needsInput?: PendingInput | null;
  audit: AuditEntry[];
}

/** AgentChatBackend over the desktop's login-gated service IPC. */
export class DesktopAgentBackend implements AgentChatBackend {
  private threadId: string | null = null;
  private auditCache: AuditEntry[] = [];

  private async send(text: string, kind: 'chat' | 'answer'): Promise<AgentReply> {
    const d = desktop();
    if (!d) throw new Error('Not running on desktop.');
    let res: AgentMessageResponse;
    try {
      res = (await d.svc.call('agent', '/message', 'POST', {
        threadId: this.threadId ?? undefined,
        text,
        kind,
      })) as AgentMessageResponse;
    } catch (e) {
      // Fail closed with a helpful message when logged out (spec d).
      throw new Error(
        e instanceof Error ? e.message : String(e),
      );
    }
    this.threadId = res.threadId;
    this.auditCache = res.audit ?? [];
    return {
      threadId: res.threadId,
      message: res.message,
      actionsTaken: res.audit ?? [],
      needsInput: res.needsInput ?? undefined,
    };
  }

  chat(threadId: string, text: string): Promise<AgentReply> {
    if (!this.threadId) this.threadId = threadId;
    return this.send(text, 'chat');
  }

  answer(threadId: string, text: string): Promise<AgentReply> {
    if (!this.threadId) this.threadId = threadId;
    return this.send(text, 'answer');
  }

  getAuditLog(): AuditEntry[] {
    return [...this.auditCache];
  }

  async watch(): Promise<string> {
    throw new Error('Proactive watch is not available for remote agents in v1.');
  }

  async unwatch(): Promise<void> {
    // No-op (watch always throws).
  }

  async pollWatch(): Promise<{ seq: number; ts: number; type: string; detail: unknown }[]> {
    return [];
  }

  async close(): Promise<void> {
    this.threadId = null;
    this.auditCache = [];
  }

  /**
   * Human-in-the-loop (ai-agent.md §12) over the desktop's login-gated
   * service IPC: the Electron main process proxies to the same agent
   * service endpoints as the gateway.
   */
  async listPendingAsks(): Promise<PendingAskView[]> {
    const d = desktop();
    if (!d) throw new Error('Not running on desktop.');
    const res = (await d.svc.call('agent', '/pending', 'GET')) as { asks?: PendingAskView[] };
    return res.asks ?? [];
  }

  async answerPendingAsk(askId: string, answer: string, note?: string): Promise<void> {
    const d = desktop();
    if (!d) throw new Error('Not running on desktop.');
    await d.svc.call('agent', '/answer', 'POST', { askId, answer, note });
  }
}

/* ------------------------------------------------------------------ */
/* Desktop file Open/Save (apps/desktop). The xlsx/csv/tsv/ods adapters */
/* run in the renderer (shared web code, real implementations); the    */
/* main process only shows native dialogs and reads/writes bytes.       */
/* ------------------------------------------------------------------ */

/** Session extras for a direct streaming save (buildServerSaveExtras shape). */
export interface DesktopSaveExtras {
  extraMetadata: Record<string, unknown>;
  definedNames: unknown;
  sheetDims: Record<string, unknown>;
  sheetStyles: Record<string, Record<string, unknown>>;
}

/** Result of a direct streaming save; `path: null` = dialog cancelled. */
export interface DesktopSaveXlsxDirectResult {
  path: string | null;
  mode?: 'verbatim' | 'adapter-fallback' | 'checkpoint-current';
  bytes?: number;
  changedSheets?: string[];
  /** True when the save was skipped as already checkpoint-current. */
  skipped?: boolean;
}

/** Save status snapshot (Addendum 6): revisions + extras flag + counters. */
export interface DesktopSaveStatusResult {
  liveRevision: number;
  storageRevision: number;
  extrasDirty: boolean;
  flushes: number;
  noopSkips: number;
}

/** Result of an autosave flush (Addendum 3); caughtUp = file holds every live op. */
export interface DesktopAutosaveFlushResult {
  storageRevision: number;
  liveRevision: number;
  caughtUp: boolean;
  flushedOps: number;
}

export interface DesktopPickedFile {
  path: string;
  bytes: Uint8Array;
}

export function desktopFileApi(): NonNullable<DesktopApi['file']> | null {
  return desktop()?.file ?? null;
}

/** Native Open dialog → file bytes, or null when cancelled. */
export async function desktopPickOpen(): Promise<DesktopPickedFile | null> {
  const f = desktopFileApi();
  if (!f) return null;
  const res = await f.pickOpen();
  if (!res) return null;
  // Bytes arrive as a Uint8Array over the bridge (binary clone); the
  // instanceof branch only normalizes a legacy number[] payload.
  return {
    path: res.path,
    bytes: res.bytes instanceof Uint8Array ? res.bytes : new Uint8Array(res.bytes as unknown as number[]),
  };
}

/**
 * Write bytes via the native Save flow. Returns the final path (null when
 * cancelled). Pass the previously saved path for Save-in-place semantics.
 * suggestedName (GAP-3) pre-fills the Save-dialog filename for exports.
 */
export async function desktopSaveBytes(
  bytes: Uint8Array,
  suggestedPath?: string,
  suggestedName?: string,
): Promise<string | null> {
  const f = desktopFileApi();
  if (!f) return null;
  // Bytes cross as a Uint8Array (binary structured clone) — the old
  // Array.from walked every byte into a JS number on the UI thread and
  // Electron cloned the array element-by-element (the open-stall class).
  const res = await f.saveBytes(bytes, suggestedPath, suggestedName);
  return res.path;
}

/**
 * Direct streaming save (direct-save pass): ask the main process to
 * serialize its LIVE engine model to .xlsx through the shared streaming
 * serializer (temp-in-destination-dir → verify → atomic rename). Only
 * the small session extras cross the bridge — never workbook bytes.
 * Returns null when the bridge does not expose the direct path (older
 * desktop build / not desktop), so callers can fall back to
 * desktopSaveBytes; a { path: null } result means the user cancelled
 * the Save dialog. A save FAILURE rejects (the caller surfaces it; the
 * destination file is untouched by design).
 */
export async function desktopSaveXlsxDirect(
  extras: DesktopSaveExtras,
  suggestedPath?: string,
  suggestedName?: string,
): Promise<DesktopSaveXlsxDirectResult | null> {
  const f = desktopFileApi();
  if (!f?.saveXlsxDirect) return null;
  return f.saveXlsxDirect(extras, suggestedPath, suggestedName);
}

/**
 * Autosave flush confirmation (Addendum 3): ask the main process to
 * force its pending checkpoint batch to the workbook's recorded
 * destination NOW (continuous batch checkpointing runs there on a
 * settle timer regardless) and report whether storage has caught up
 * with the live model. The session extras ride along as the
 * checkpoint's freshest client state; no workbook bytes cross in
 * either direction. Returns null when the bridge lacks the flush
 * channel (older desktop build / not desktop) so callers keep the
 * previous save path.
 */
export async function desktopAutosaveFlush(
  extras?: DesktopSaveExtras,
): Promise<DesktopAutosaveFlushResult | null> {
  const f = desktopFileApi();
  if (!f?.autosaveFlush) return null;
  return f.autosaveFlush(extras);
}

/**
 * Save status (Addendum 6): main owns autosave entirely; the renderer
 * only polls this to render Saving…/Saved. Returns null when the
 * bridge lacks the channel (older desktop build / not desktop).
 */
export async function desktopSaveStatus(): Promise<DesktopSaveStatusResult | null> {
  const f = desktopFileApi();
  if (!f?.saveStatus) return null;
  return f.saveStatus();
}

/**
 * Session-extras sync (Addendum 6): push the renderer's current
 * session extras to main as they change, so main-side checkpoints
 * include them. This is state sync, NOT a save trigger — the flush
 * decision stays in main. Returns false when the bridge lacks the
 * channel (older desktop build / not desktop).
 * #103: serverHosted (when known) tells main whether the open workbook
 * is server-hosted; older bridges ignore the extra argument.
 */
export async function desktopSyncExtras(
  extras: DesktopSaveExtras,
  serverHosted?: boolean,
): Promise<boolean> {
  const f = desktopFileApi();
  if (!f?.syncSessionExtras) return false;
  await f.syncSessionExtras(extras, serverHosted);
  return true;
}

/** Subscribe to the native File menu (main.ts buildMenu). */
export function onDesktopMenuOpen(cb: () => void): () => void {
  return desktopFileApi()?.onMenuOpen(cb) ?? (() => {});
}

export function onDesktopMenuSave(cb: () => void): () => void {
  return desktopFileApi()?.onMenuSave(cb) ?? (() => {});
}

/**
 * Subscribe to File → Save As (GAP-7). The handler should save via
 * desktopSaveBytes(bytes) with NO suggested path so the native Save
 * dialog opens.
 */
export function onDesktopMenuSaveAs(cb: () => void): () => void {
  return desktopFileApi()?.onMenuSaveAs?.(cb) ?? (() => {});
}

/**
 * Subscribe to OS-triggered workbook opens (GAP-4: double-click /
 * open-with). Load the bytes via the existing openXlsxBuffer flow.
 */
export function onDesktopOpenPath(
  cb: (info: { path: string; bytes: Uint8Array }) => void,
): () => void {
  const f = desktopFileApi();
  if (!f?.onOpenPath) return () => {};
  return f.onOpenPath((info) =>
    cb({
      path: info.path,
      bytes: info.bytes instanceof Uint8Array ? info.bytes : new Uint8Array(info.bytes as unknown as number[]),
    }),
  );
}

/**
 * Subscribe to File → New Workbook's dirty guard (GAP-6). The handler
 * answers whether the current workbook may be discarded: true when not
 * dirty, otherwise the user's confirm answer.
 */
export function onDesktopConfirmNew(cb: () => Promise<boolean>): () => void {
  return desktopFileApi()?.onConfirmNew?.(cb) ?? (() => {});
}

/** Subscribe to Preferences (Cmd+,) → open SettingsDialog (GAP-7). */
export function onDesktopMenuPreferences(cb: () => void): () => void {
  return desktop()?.menu?.onPreferences?.(cb) ?? (() => {});
}

/** Subscribe to the Help menu's help item → open HelpPane (GAP-7). */
export function onDesktopMenuHelp(cb: () => void): () => void {
  return desktop()?.menu?.onHelp?.(cb) ?? (() => {});
}

/**
 * Tell the main process the renderer has attached its main→renderer
 * listeners (GAP-9): queued menu clicks / OS file opens flush in response.
 */
export function signalDesktopRendererReady(): void {
  desktop()?.signalReady?.();
}
