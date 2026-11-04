/**
 * Gateway service client (web app).
 *
 * Used when the app is built with VITE_GATEWAY_URL: ALL engine and service
 * traffic goes through the API gateway (rate limiting + JWT auth enforced
 * there). Kept SEPARATE from the desktop's service client (spec e):
 * desktop is local-first with a login-gated remote path via Electron IPC.
 *
 * Transport note (Cycle 10, Phase 3): ALL traffic goes through the
 * async fetch path (`call`). The Phase 2 sync-XHR transitional bridge is
 * REMOVED — render-time reads are served by the async read-through cache
 * in remoteEngine.ts (bulk-coalesced viewport reads, bulkReads.ts) and
 * edits by the routed async pipeline (routedEdit.ts). There is no
 * synchronous network call anywhere in this client.
 */
/// <reference types="vite/client" />
import type {
  CellRef,
  CommandResult,
  EngineCommand,
  RangeRef,
  TypedValue,
  WorkbookSnapshot,
} from '@icecream-sheets/engine';
import { clientInstanceId } from './clientInstance';
import { desktopGatewayCall, isDesktop } from './desktopAgent';

const TOKEN_KEY = 'icecream-sheets.gateway-token';

/** A signed engine-access grant from POST /api/engine/access. */
export interface EngineAccessGrant {
  ok: true;
  /** HMAC-signed token scoped to { principal, sessionId, expiry }. */
  accessToken: string;
  /** DIRECT engine base URL for the session's tier (no gateway in path). */
  engineUrl: string;
  sessionId: string;
  tier: 'standard' | 'xl';
  /** Expiry as epoch milliseconds. */
  expiresAt: number;
  expiresInSeconds: number;
}

/**
 * Join-handshake result (Phase 2, revision-model doc §9): POST
 * /api/engine/open returns connection information ONLY — the owner
 * instance's DIRECT engine endpoint, the session id, a short-lived
 * signed token scoped { user, file, session, role }, and the session's
 * current revision. The shape is IDENTICAL for join vs create; `joined`
 * says which happened. Engine endpoints are LEASED information: never
 * cache an engineUrl/token beyond its session — re-run openFile() on
 * every reconnect.
 */
export interface EngineOpenResult {
  ok: true;
  fileId: string;
  sessionId: string;
  engineUrl: string;
  accessToken: string;
  role: 'editor' | 'viewer';
  revision: number;
  joined: boolean;
  /** True when the claimed session already holds the workbook
   * (snapshot rehydrate or issue-#36 library recovery) — the client
   * must not load upload bytes over it. */
  rehydrated?: boolean;
  ownershipEpoch: number;
}

/** The engine session's lifecycle state (GET /session/status). */
export interface EngineSessionStatus {
  ok: true;
  sessionId: string | null;
  status: 'none' | 'active' | 'released';
  revision: number;
  lastActivityAt: number;
  idleTimeoutMs: number;
  snapshotChecksum: string | null;
}

/** Rehydrate outcome: editing may unlock ONLY when checksumVerified. */
export interface EngineRehydrateResult {
  ok: boolean;
  sessionId: string;
  revision: number;
  checksum: string | null;
  checksumVerified: boolean;
  replayedOps: number;
  sheets?: string[];
  error?: string;
}

export class GatewayAuthError extends Error {}
export class GatewayRateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

function decodeSub(token: string): string | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1] ?? '')) as { sub?: string };
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/** Payload of a server-side library save (see engineLibrarySave). */
export interface EngineLibrarySavePayload {
  id?: string;
  name: string;
  extraMetadata?: Record<string, unknown>;
  definedNames?: unknown;
  sheetDims?: Record<string, unknown>;
  sheetStyles?: Record<string, Record<string, unknown>>;
}

/** Result of a server-side library save: entry metadata only (§4). */
export interface EngineLibrarySaveResult {
  ok: true;
  entry: {
    id: string;
    name: string;
    owner: string;
    createdAt: number;
    modifiedAt: number;
    sizeBytes: number;
    backend: 'gateway';
  };
}

export class GatewayClient {
  readonly baseUrl: string;
  private token: string | null = null;
  /**
   * Phase 2 direct-download hooks (set by App when a collab file
   * session is live): supply the /download METADATA response
   * (whole-workbook .xlsx) resp. the /download BYTE response
   * (named-range subsets + non-xlsx formats, residual (p)) by calling
   * the owning engine directly with the session-scoped token. The
   * proxied /api/engine/download forwards this client's gateway
   * JWT, which a signed-mode engine refuses as a malformed access
   * token — downloads 401 for every Phase 2 file session (validation
   * finding; same family as defect F3). Returning null falls back to
   * the proxied call (legacy/proxy sessions).
   */
  private directDownloadMetadataProvider: ((extras: Record<string, unknown>) => Promise<Record<string, unknown> | null>) | null = null;
  private directDownloadBytesProvider: ((extras: Record<string, unknown>) => Promise<Blob | null>) | null = null;

  setDirectDownloadMetadataProvider(
    fn: ((extras: Record<string, unknown>) => Promise<Record<string, unknown> | null>) | null,
  ): void {
    this.directDownloadMetadataProvider = fn;
  }

  setDirectDownloadBytesProvider(
    fn: ((extras: Record<string, unknown>) => Promise<Blob | null>) | null,
  ): void {
    this.directDownloadBytesProvider = fn;
  }

  /**
   * Direct library-save hook (set by App when a collab file session is
   * live): supplies the /library-save result by calling the owning
   * engine directly with the session-scoped token. The proxied
   * /api/engine/library-save forwards this client's gateway JWT, which
   * a signed-mode engine refuses as a malformed access token — the
   * normal Ctrl+S library save (and the gateway autosave path) 401'd
   * for every Phase 2 file session (shell-integration finding, same
   * family as defect F3). Returning null falls back to the proxied
   * call (legacy/proxy sessions, where that lane is accepted). The
   * provider receives the full wire payload ({ format: 'xlsx', ... })
   * the proxied call would have sent.
   */
  private directLibrarySaveProvider: ((
    payload: { format: 'xlsx' } & EngineLibrarySavePayload,
  ) => Promise<EngineLibrarySaveResult | null>) | null = null;

  setDirectLibrarySaveProvider(
    fn: ((
      payload: { format: 'xlsx' } & EngineLibrarySavePayload,
    ) => Promise<EngineLibrarySaveResult | null>) | null,
  ): void {
    this.directLibrarySaveProvider = fn;
  }

  /**
   * Direct library-bytes hook (set by App when a collab file session
   * is live): supplies a server-library entry's stored .xlsx bytes by
   * calling the owning engine directly with the session-scoped token.
   * The proxied GET /api/engine/library/:id forwards this client's
   * gateway JWT, which a signed-mode engine refuses as a malformed
   * access token — opening a workbook from the library 401'd for
   * every Phase 2 file session (the open sibling of the library-save
   * defect above). Returning null falls back to the proxied call
   * (legacy/proxy sessions, where that lane is accepted).
   */
  private directLibraryBytesProvider: ((id: string) => Promise<Blob | null>) | null = null;

  setDirectLibraryBytesProvider(fn: ((id: string) => Promise<Blob | null>) | null): void {
    this.directLibraryBytesProvider = fn;
  }

  /**
   * Direct session-bind hook (set by App when a collab file session is
   * live): binds the live session to the library entry it was opened
   * from by calling the owning engine directly with the
   * session-scoped token. The proxied /api/engine/session-bind-library
   * forwards this client's gateway JWT, which a signed-mode engine
   * refuses — the bind is fire-and-forget, so it silently never
   * happened and AutoSave checkpoints for a library-opened workbook
   * never committed into the user's entry. Returning null falls back
   * to the proxied call (legacy/proxy sessions).
   */
  private directBindLibraryProvider: ((
    id: string,
    name?: string,
  ) => Promise<{ ok: true; boundLibraryId: string } | null>) | null = null;

  setDirectBindLibraryProvider(
    fn: ((
      id: string,
      name?: string,
    ) => Promise<{ ok: true; boundLibraryId: string } | null>) | null,
  ): void {
    this.directBindLibraryProvider = fn;
  }

  /**
   * Auth-coherence reauth provider (user ruling, 2026-10-22: sign-in
   * state and gateway token are ONE state, never split). App wires this
   * to FirebaseAuthService.reauthenticateGateway: when the gateway
   * rejects the stored token (401) but a live Firebase session exists,
   * the provider silently re-exchanges for a fresh gateway JWT and
   * resolves true; when there is no session it clears the orphan token
   * (and converges the auth state) and resolves false. See withReauth().
   */
  private reauthProvider: (() => Promise<boolean>) | null = null;

  setReauthProvider(fn: (() => Promise<boolean>) | null): void {
    this.reauthProvider = fn;
  }

  /**
   * Run a gateway-JWT fetch; on a 401, ask the reauth provider for ONE
   * silent re-exchange and retry the fetch exactly once with the fresh
   * token. The closure MUST build its Authorization header from
   * this.token at invocation time so the retry presents the new token.
   * A second 401 (or no provider / provider declines) returns the
   * original 401 response — callers keep their existing handling.
   * Deliberately NOT applied to the GCS signed-URL fetch (its
   * credential is the URL itself) or the keepalive release beacon
   * (fire-and-forget by design).
   */
  private async withReauth(doFetch: () => Promise<Response>): Promise<Response> {
    const res = await doFetch();
    if (res.status !== 401 || !this.reauthProvider) return res;
    let refreshed = false;
    try {
      refreshed = await this.reauthProvider();
    } catch {
      refreshed = false;
    }
    if (!refreshed) return res;
    return doFetch();
  }

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    try {
      this.token = localStorage.getItem(TOKEN_KEY);
    } catch {
      this.token = null;
    }
  }

  get loggedIn(): boolean {
    return this.token !== null;
  }

  /** The stored JWT, if the user has logged in (engine.ts checks this). */
  getToken(): string | null {
    return this.token;
  }

  /** Drop the stored JWT (engine.ts clears stale tokens). */
  clearToken(): void {
    this.setToken(null);
  }

  /**
   * Principal from the JWT `sub` claim (gateway is the verifier), in
   * the canonical server form `user:<sub>` (the service's
   * principalFromToken). The token's sub is the BARE user id; every
   * server-side identity (presence participants, op attribution) uses
   * the prefixed form, so client-side comparisons against them must
   * use it too — returning the bare sub made the grid's self-presence
   * filter compare 'user:<uid>' against '<uid>' and never match, so a
   * user saw their own presence flag labeled with the raw UID (D8).
   */
  get principal(): string | null {
    if (!this.token) return null;
    const sub = decodeSub(this.token);
    if (!sub) return null;
    return sub.startsWith('user:') ? sub : `user:${sub}`;
  }

  /** Local-dev login: the gateway's /auth/login mints a JWT (prod uses the real IdP). */
  async login(userId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    if (!res.ok) throw new GatewayAuthError(`login failed: ${res.status}`);
    const body = (await res.json()) as { token?: string };
    if (!body.token) throw new GatewayAuthError('login returned no token');
    this.setToken(body.token);
  }

  /**
   * Firebase Google sign-in (Cycle 9): exchange a verified Firebase ID
   * token for the gateway JWT. The gateway verifies the Firebase token's
   * RS256 signature itself (aud = its FIREBASE_PROJECT_ID) and mints a
   * gateway JWT for the `user:<uid>` principal — the client is never
   * trusted to name its own identity.
   */
  async loginWithFirebaseIdToken(idToken: string): Promise<void> {
    if (!idToken) throw new GatewayAuthError('missing Firebase ID token');
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/auth/firebase`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });
    } catch (e) {
      throw new GatewayAuthError(
        `firebase login: cannot reach the gateway (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    if (res.status === 503) {
      throw new GatewayAuthError(
        'firebase login is not configured on the gateway (FIREBASE_PROJECT_ID is not set)',
      );
    }
    if (res.status === 401) {
      const text = await res.text().catch(() => '');
      throw new GatewayAuthError(
        `firebase login rejected the ID token${text ? `: ${text.slice(0, 160)}` : ''}`,
      );
    }
    if (!res.ok) throw new GatewayAuthError(`firebase login failed: ${res.status}`);
    const body = (await res.json().catch(() => null)) as { token?: string } | null;
    if (!body?.token) throw new GatewayAuthError('firebase login returned no token');
    this.setToken(body.token);
  }

  logout(): void {
    this.setToken(null);
  }

  private setToken(token: string | null): void {
    this.token = token;
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      // Storage unavailable — token lives in memory only.
    }
  }

  /**
   * Desktop bridge transport (stream 1, Workspace-in-desktop): inside the
   * Electron shell the renderer NEVER holds a gateway JWT — main keeps it
   * in safeStorage and proxies authenticated calls (svc 'gateway'). When
   * this client has no local token and the bridge is present, route the
   * call through it and reproduce the fetch path's outcomes exactly:
   * 401 → GatewayAuthError, 429 → GatewayRateLimitError, other failures →
   * `gateway <status>: <body>` with the parsed body attached (the
   * Workspace surfaces server errors verbatim from that shape). Returns
   * { handled: false } off-desktop so web behavior is untouched.
   */
  private async callViaDesktopBridge<T>(
    path: string,
    init?: RequestInit,
    body?: unknown,
  ): Promise<{ handled: true; value: T } | { handled: false }> {
    if (this.token || !isDesktop()) return { handled: false };
    const envelope = await desktopGatewayCall(path, init?.method ?? 'GET', body);
    if (!envelope) return { handled: false };
    const { status, body: resBody } = envelope;
    if (status === 401) throw new GatewayAuthError('not authenticated (401)');
    if (status === 429) throw new GatewayRateLimitError('rate limited (429)', 1000);
    if (status < 200 || status >= 300) {
      const text = typeof resBody === 'string' ? resBody : (JSON.stringify(resBody) ?? '');
      const err = new Error(`gateway ${status}: ${text.slice(0, 200)}`) as Error & {
        gatewayBody?: unknown;
      };
      err.gatewayBody = resBody;
      throw err;
    }
    return { handled: true, value: resBody as T };
  }

  /** Async JSON call through the gateway (services, agent, etl, vault, meta). */
  async call<T>(path: string, init?: RequestInit, body?: unknown): Promise<T> {
    const bridged = await this.callViaDesktopBridge<T>(path, init, body);
    if (bridged.handled) return bridged.value;
    const attempt = (): Promise<Response> => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.token) headers['authorization'] = `Bearer ${this.token}`;
      return fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    };
    const res = await this.withReauth(attempt);
    if (res.status === 401) throw new GatewayAuthError('not authenticated (401)');
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '1') * 1000;
      throw new GatewayRateLimitError('rate limited (429)', retryAfter);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`gateway ${res.status}: ${text.slice(0, 200)}`) as Error & {
        gatewayBody?: unknown;
      };
      // Structured extras (e.g. the settings 404's caller-identity echo)
      // ride on the error object: the message form truncates the body
      // at 200 chars, which could clip the JSON mid-way.
      try {
        err.gatewayBody = JSON.parse(text) as unknown;
      } catch {
        /* not JSON — message form only */
      }
      throw err;
    }
    return (await res.json()) as T;
  }

  /**
   * Streaming POST (#40): same auth/reauth/error discipline as call(),
   * but returns the raw Response so the caller can read a
   * text/event-stream body incrementally. Aborts via the caller's
   * AbortSignal (the agent Stop control).
   */
  async callStream(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const attempt = (): Promise<Response> => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.token) headers['authorization'] = `Bearer ${this.token}`;
      return fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    };
    const res = await this.withReauth(attempt);
    if (res.status === 401) throw new GatewayAuthError('not authenticated (401)');
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '1') * 1000;
      throw new GatewayRateLimitError('rate limited (429)', retryAfter);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`gateway ${res.status}: ${text.slice(0, 200)}`);
    }
    return res;
  }

  // -- engine (async: the transport boundary — engineTransport.ts) ---------

  /** Shared request-body shape for /api/engine/read. */
  private engineReadBody(
    kind: 'cell' | 'range' | 'sheet' | 'usedrange',
    arg: CellRef | RangeRef | { sheet: string },
  ): Record<string, unknown> {
    // Engine-service contract: { kind:'cell', ref } | { kind:'range', range }
    // | { kind:'sheet'|'usedrange', sheet }.
    return kind === 'cell'
      ? { kind, ref: arg }
      : kind === 'range'
        ? { kind, range: arg }
        : { kind, sheet: (arg as { sheet: string }).sheet };
  }
  /** Async counterparts of the sync engine methods, over fetch. */
  engineExecuteAsync(cmd: EngineCommand, opts?: { ackChecksum?: boolean }): Promise<CommandResult> {
    // The routed-edit layer asks for the checksum ack on LOCAL-route
    // cell edits only (HYBRID-CONSISTENCY.md §2): the response then
    // carries { revision, changedCellCount, checksum } alongside the
    // CommandResult, and the client can confirm its local calc without
    // fetching ack values. Server-routed edits don't ask — they confirm
    // from ack values, and the server skips the checksum work. Older
    // servers ignore the flag; the client falls back to the value fetch.
    return this.call<CommandResult>(
      '/api/engine/execute',
      { method: 'POST' },
      opts?.ackChecksum ? { cmd, ackChecksum: true } : { cmd },
    );
  }

  engineReadAsync(
    kind: 'cell' | 'range' | 'sheet' | 'usedrange',
    arg: CellRef | RangeRef | { sheet: string },
  ): Promise<unknown> {
    return this.call('/api/engine/read', { method: 'POST' }, this.engineReadBody(kind, arg));
  }

  engineSnapshotAsync(): Promise<WorkbookSnapshot> {
    return this.call<WorkbookSnapshot>('/api/engine/snapshot', { method: 'GET' });
  }

  /**
   * Server-side download (Cycle 10 defect 2c + closure): the engine
   * service serializes the live workbook and streams the bytes back;
   * the browser receives them as a Blob and never ingests a
   * workbook-sized snapshot object. `extras` carries only small session
   * state the server cannot know (client UI metadata, session defined
   * names, active-sheet dims) — never cell data. `format` is any web
   * save format (xlsx/xlsb/csv/tsv/ods/html); `scope:'namedRange'` with
   * a client-resolved `namedRange` def asks for the rebased subset.
   * In signed mode every branch reaches the engine DIRECTLY (metadata
   * provider for whole-workbook xlsx, bytes provider for the rest)
   * whenever a collab file session is live — the gateway-proxied
   * variant 401s there (residual (p)).
   */
  async engineDownload(extras?: {
    format?: string;
    filename?: string;
    scope?: 'workbook' | 'namedRange';
    namedRange?: {
      name: string;
      ref: { sheet: string; startRow: number; startCol: number; endRow: number; endCol: number } | null;
    };
    extraMetadata?: Record<string, unknown>;
    definedNames?: unknown;
    sheetDims?: Record<string, unknown>;
    /** Session cell styles per sheet (defect D4), keyed "row:col". */
    sheetStyles?: Record<string, Record<string, unknown>>;
  }): Promise<Blob> {
    // Save/download separation (revision-model doc §4): a whole-
    // workbook .xlsx download is SAVE FIRST, THEN FETCH — the engine
    // runs the save sequence and commits the pinned revision to file
    // storage, this call returns metadata only, and the bytes are
    // fetched DIRECTLY from storage via a gateway-issued signed URL
    // (never proxied through the gateway or the engine's save path).
    const format = extras?.format ?? 'xlsx';
    if (format === 'xlsx' && extras?.scope !== 'namedRange') {
      type DownloadMeta = {
        ok: true;
        entryId: string;
        revision: number;
        bytes: number;
        mode: string;
        serializeMs: number;
        totalMs: number;
      };
      const directMeta = this.directDownloadMetadataProvider
        ? ((await this.directDownloadMetadataProvider({ format: 'xlsx', ...(extras ?? {}) })) as DownloadMeta | null)
        : null;
      const meta = directMeta ?? (await this.call<DownloadMeta>(
        '/api/engine/download', { method: 'POST' }, { format: 'xlsx', ...(extras ?? {}) },
      ));
      const { url } = await this.engineStorageSignUrl(meta.entryId);
      const res = await fetch(url);
      if (res.status === 401) throw new GatewayAuthError('storage fetch not authorized (401)');
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`storage fetch ${res.status}: ${text.slice(0, 200)}`);
      }
      return res.blob();
    }
    // Byte-response classes (residual (p)): named-range subsets and
    // non-xlsx formats are serialized by the engine and returned in
    // the /download response body. With a live Phase 2 file session
    // they go DIRECT to the owning engine through the bytes provider
    // (the same engine-validated signed access as the metadata call
    // above — revision-model doc §4/§9); the proxied fetch below
    // remains only for sessions without a direct channel (legacy /
    // proxy sessions), where the gateway JWT is accepted.
    const directBytes = this.directDownloadBytesProvider
      ? await this.directDownloadBytesProvider({ format: 'xlsx', ...(extras ?? {}) })
      : null;
    if (directBytes) return directBytes;
    const res = await this.withReauth(() => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.token) headers['authorization'] = `Bearer ${this.token}`;
      return fetch(`${this.baseUrl}/api/engine/download`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ format: 'xlsx', ...(extras ?? {}) }),
      });
    });
    if (res.status === 401) throw new GatewayAuthError('not authenticated (401)');
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '1') * 1000;
      throw new GatewayRateLimitError('rate limited (429)', retryAfter);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`gateway ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.blob();
  }

  /**
   * Gateway-issued signed URL for a committed storage entry
   * (save/download separation): the gateway validates + signs; the
   * bytes themselves are fetched from the returned URL directly.
   * 120 s lifetime, scoped to this principal + entry. Fails closed
   * (501) when no signing secret is configured server-side.
   */
  engineStorageSignUrl(entryId: string): Promise<{ ok: true; url: string; expiresAt: number }> {
    return this.call('/api/storage/sign', { method: 'POST' }, { entryId });
  }

  /**
   * AutoSave status surface (Addendum 6): the server's live-vs-stored
   * revisions + extras flag + flush counters. The client's ONLY
   * autosave input — the client never initiates autosave; it displays
   * Saving… ⇔ storageRevision < liveRevision || extrasDirty.
   */
  engineSaveStatus(): Promise<{
    ok: true;
    sessionId: string | null;
    liveRevision: number;
    storageRevision: number;
    /** #105: last checkpoint's serialized size (absent on older engines). */
    storedBytes?: number;
    extrasDirty: boolean;
    pendingCheckpointOps: number;
    autosaveStats: { flushes: number; noopSkips: number; forcedFlushes: number };
  }> {
    return this.call('/api/engine/session-save-status', { method: 'GET' });
  }

  /**
   * Session-extras continuous sync (Addendum 6): push the client's
   * presentation extras as they change; the server folds them into
   * its next autosave flush. Identical resends are free server-side.
   */
  engineSessionExtras(extras: {
    sheetStyles?: Record<string, Record<string, unknown>>;
    sheetDims?: Record<string, unknown>;
    definedNames?: unknown;
    extraMetadata?: Record<string, unknown>;
  }): Promise<{ ok: true; extrasDirty: boolean }> {
    return this.call('/api/engine/session-extras', { method: 'POST' }, extras);
  }

  /**
   * Bind the live session to the library entry it was opened from, so
   * server autosave checkpoints commit into the user's file itself.
   */
  async engineBindLibrary(
    id: string,
    name?: string,
  ): Promise<{ ok: true; boundLibraryId: string }> {
    // Direct lane first (see setDirectBindLibraryProvider): with a
    // live Phase 2 file session the bind goes straight to the owning
    // engine with the session-scoped token — it binds exactly the
    // session the checkpoints belong to. The proxied call below
    // remains only for sessions without a direct channel
    // (legacy/proxy sessions), where the gateway JWT is accepted.
    const direct = this.directBindLibraryProvider
      ? await this.directBindLibraryProvider(id, name)
      : null;
    if (direct) return direct;
    return this.call('/api/engine/session-bind-library', { method: 'POST' }, { id, name });
  }

  /** The original xlsx-only download call, kept as a thin wrapper. */
  async engineDownloadXlsx(extras?: {
    filename?: string;
    extraMetadata?: Record<string, unknown>;
    definedNames?: unknown;
    sheetDims?: Record<string, unknown>;
    sheetStyles?: Record<string, Record<string, unknown>>;
  }): Promise<Blob> {
    return this.engineDownload({ format: 'xlsx', ...(extras ?? {}) });
  }

  /**
   * Server-side library save (Cycle 10 closure): the engine service
   * serializes its live workbook to .xlsx and stores the bytes in the
   * principal's server library store. Only entry metadata returns —
   * the workbook bytes never round-trip the tab.
   */
  async engineLibrarySave(payload: EngineLibrarySavePayload): Promise<EngineLibrarySaveResult> {
    // Direct lane first (see setDirectLibrarySaveProvider): with a live
    // Phase 2 file session the save goes straight to the owning engine
    // with the session-scoped token; the proxied call below remains
    // only for sessions without a direct channel (legacy/proxy
    // sessions), where the gateway JWT is accepted.
    const direct = this.directLibrarySaveProvider
      ? await this.directLibrarySaveProvider({ format: 'xlsx', ...payload })
      : null;
    if (direct) return direct;
    return this.call('/api/engine/library-save', { method: 'POST' }, { format: 'xlsx', ...payload });
  }

  /** Fetch a server-library entry's stored .xlsx bytes (library open). */
  async engineLibraryBytes(id: string): Promise<Blob> {
    // Direct lane first (see setDirectLibraryBytesProvider): with a
    // live Phase 2 file session the bytes come straight from the
    // owning engine with the session-scoped token; the proxied fetch
    // below remains only for sessions without a direct channel
    // (legacy/proxy sessions), where the gateway JWT is accepted.
    const direct = this.directLibraryBytesProvider
      ? await this.directLibraryBytesProvider(id)
      : null;
    if (direct) return direct;
    const res = await this.withReauth(() => {
      const headers: Record<string, string> = {};
      if (this.token) headers['authorization'] = `Bearer ${this.token}`;
      return fetch(`${this.baseUrl}/api/engine/library/${encodeURIComponent(id)}`, {
        method: 'GET',
        headers,
      });
    });
    if (res.status === 401) throw new GatewayAuthError('not authenticated (401)');
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '1') * 1000;
      throw new GatewayRateLimitError('rate limited (429)', retryAfter);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`gateway ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.blob();
  }

  // -- signed engine access (deployment-architecture.md §Engine access
  //    pattern) ---------------------------------------------------------

  /**
   * Ask the gateway for a signed engine-access token (POST
   * /api/engine/access). The gateway runs its auth + rate limiting;
   * on success it returns the token + the DIRECT engine base URL for
   * the session's tier. Used by SignedEngineTransport — in proxy mode
   * (the default) nothing calls this and all traffic stays proxied.
   */
  engineAccess(opts?: {
    sessionId?: string;
    cellCount?: number;
  }): Promise<EngineAccessGrant> {
    return this.call<EngineAccessGrant>('/api/engine/access', { method: 'POST' }, opts ?? {});
  }

  // -- Phase 2 join handshake (revision-model doc §9) ----------------------

  /**
   * Ask the gateway to open a file (POST /api/engine/open): the gateway
   * authenticates, checks permission + rate limits, reads the session
   * registry, and returns connection info only (see EngineOpenResult).
   * With no fileId the gateway mints a new one (a fresh file/session);
   * with one, a live owner is JOINED and a dead/absent owner is claimed
   * — the response shape is identical either way. A registry failure is
   * fail-closed server-side (503) and surfaces here as a thrown error.
   */
  openFile(
    fileIdOrOpts?:
      | string
      | { fileId?: string; name?: string; role?: 'editor' | 'viewer'; cellCount?: number },
  ): Promise<EngineOpenResult> {
    const opts = typeof fileIdOrOpts === 'string' ? { fileId: fileIdOrOpts } : (fileIdOrOpts ?? {});
    // Placement addendum 2: every open carries this tab's client
    // instance id so the engine can refcount attached instances.
    return this.call<EngineOpenResult>('/api/engine/open', { method: 'POST' }, { clientInstanceId: clientInstanceId(), ...opts });
  }

  // -- engine session lifecycle (deployment doc extensions 1–3 + Idle
  //    rule), proxied through the gateway in proxy mode ---------------

  engineSessionStatus(): Promise<EngineSessionStatus> {
    return this.call<EngineSessionStatus>('/api/engine/session/status', { method: 'GET' });
  }

  engineSessionHeartbeat(sessionId: string): Promise<{ ok: true; lastActivityAt: number }> {
    return this.call('/api/engine/session/heartbeat', { method: 'POST' }, { sessionId, clientInstanceId: clientInstanceId() });
  }

  engineSessionRelease(
    sessionId: string,
    reason: string,
  ): Promise<{ ok: true; revision: number; checksum: string | null }> {
    return this.call('/api/engine/session/release', { method: 'POST' }, { sessionId, reason, clientInstanceId: clientInstanceId() });
  }

  /**
   * Tab-close release through the gateway: fetch with keepalive (the
   * request outlives the page) — sendBeacon cannot carry the
   * Authorization header the gateway requires, so proxied mode uses
   * this form; signed mode beacons direct to the engine instead.
   * Fire-and-forget: returns whether the request was dispatched.
   */
  engineSessionReleaseBeacon(sessionId: string, reason: string): boolean {
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.token) headers['authorization'] = `Bearer ${this.token}`;
      void fetch(`${this.baseUrl}/api/engine/session/release`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sessionId, reason, clientInstanceId: clientInstanceId() }),
        keepalive: true,
      }).catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  }

  engineSessionRehydrate(sessionId: string): Promise<EngineRehydrateResult> {
    return this.call<EngineRehydrateResult>('/api/engine/session/rehydrate', {
      method: 'POST',
    }, { sessionId });
  }

  engineEventsAsync(since: number): Promise<{ seq: number; event: unknown }[]> {
    return this.call<{ events: { seq: number; event: unknown }[] }>(
      `/api/engine/events?since=${since}`,
      { method: 'GET' },
    ).then((r) => r.events);
  }

  engineResetAsync(): Promise<void> {
    return this.call('/api/engine/reset', { method: 'POST' }, {}).then(() => undefined);
  }

  /** Sheet names only — the open path never pulls a snapshot for names. */
  engineSheetNamesAsync(): Promise<{ sheets: string[] }> {
    return this.call<{ sheets: string[] }>('/api/engine/sheets', { method: 'GET' });
  }

  /**
   * Open a file server-side (Cycle 10, Phase 2). Returns the full
   * non-row payload a local open hydrates from; resolves only at 100%
   * server-side load, and the tab stays responsive while waiting.
   */
  engineLoadXlsxAsync(base64: string): Promise<import('./engineTransport').EngineLoadResult> {
    return this.call('/api/engine/load', { method: 'POST' }, { format: 'xlsx', data: base64 });
  }

  /** Switch the server engine's formula language. */
  engineSetLanguageAsync(locale: string): Promise<void> {
    return this.call('/api/engine/language', { method: 'POST' }, { locale }).then(() => undefined);
  }

  /**
   * Progressive load stream (Cycle 10 Phase 4): POST
   * /api/engine/load/stream and deliver each newline-delimited JSON chunk
   * to `onChunk` as it arrives. Chunk schema is the server's (engineSvc.ts
   * header): `meta` first (sheets, totals), then per-sheet `rows` chunks
   * (cached display values + pendingCalc marks, visible-window-first),
   * `sheet-complete` per sheet, a `data-done` marker (all cell data out;
   * engine build still running = "Calculating…"), then a terminal `built`
   * chunk carrying the exact /load response. Resolves with the built
   * response when one arrived (null otherwise). Throws on 401/429/4xx
   * before the first chunk so the caller can fall back to classic /load;
   * a mid-stream failure simply ends delivery (accumulated chunks stand).
   */
  async engineLoadXlsxStream(
    base64: string,
    onChunk: (chunk: Record<string, unknown>) => void,
  ): Promise<unknown | null> {
    const res = await this.withReauth(() => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.token) headers['authorization'] = `Bearer ${this.token}`;
      return fetch(`${this.baseUrl}/api/engine/load/stream`, {
        method: 'POST',
        headers,
        // W15 (P95 TTFP): Blob body, not a bare string. A 17 MB base64 JSON
        // string body is copied out of the renderer as UTF-16 and re-encoded
        // by the network service (measured +0.3–0.5 s on the request →
        // headers leg vs the same payload as a Blob on this 2-core VM);
        // the Blob form streams the already-encoded bytes. The wire payload
        // is byte-identical JSON — gateway/engine handling is unchanged.
        body: new Blob([JSON.stringify({ format: 'xlsx', data: base64 })], {
          type: 'application/json',
        }),
      });
    });
    if (res.status === 401) throw new GatewayAuthError('not authenticated (401)');
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '1') * 1000;
      throw new GatewayRateLimitError('rate limited (429)', retryAfter);
    }
    if (!res.ok || !res.body) {
      throw new Error(`gateway ${res.status}: load/stream unavailable`);
    }
    let built: unknown | null = null;
    const deliver = (line: string): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return; // trailing garbage: ignore
      }
      if (parsed && typeof parsed === 'object') {
        const chunk = parsed as Record<string, unknown>;
        if (chunk.type === 'built') built = chunk.response ?? null;
        onChunk(chunk);
      }
    };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let delivered = 0;
    // W15 (P95 TTFP): time-sliced delivery. One network read can carry
    // several NDJSON lines (meta + multiple 4096-row chunks ≈ 1 MB
    // each); delivering them in one synchronous run keeps the main
    // thread from painting sheet 1 (and from stamping the first-page
    // mark) until EVERY line in the batch is parsed/merged/seeded.
    // Yield to the event loop whenever a batch has consumed ~40 ms of
    // synchronous delivery so first paint interleaves with ingest;
    // later chunks keep filling progressively behind it.
    const SLICE_MS = 40;
    const yieldSlice = (): Promise<void> =>
      new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    // W16 (P99 ingest): BYTE-level line splitting. String assembly was
    // measured (CDP profile, tour of perf-p99) at ~83% of main-thread
    // time in fetch/(program): concatenating a growing text buffer
    // forces V8 to flatten/copy megabytes on every indexOf/slice, and
    // the tab ingested at ~5–20k cells/s. Lines are located by scanning
    // the raw bytes for 0x0A (native memchr via Uint8Array.indexOf);
    // a line is decoded only once complete — safe because 0x0A is
    // ASCII and can never appear inside a UTF-8 multibyte sequence, so
    // line boundaries are also code-point boundaries. A partial line is
    // carried as byte parts and assembled once, when its newline
    // arrives. Total copying is O(stream), exactly once per byte.
    // Delivery order, chunk semantics and the time-slicing are
    // unchanged.
    let parts: Uint8Array[] = [];
    let partsLen = 0;
    const deliverBytes = (lineBytes: Uint8Array): void => {
      const line = decoder.decode(lineBytes);
      if (!line.trim()) return;
      delivered++;
      deliver(line);
    };
    try {
      let sliceStart = performance.now();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        let start = 0;
        for (;;) {
          const nl = value.indexOf(10, start);
          if (nl < 0) break;
          if (partsLen === 0) {
            if (nl > start) deliverBytes(value.subarray(start, nl));
          } else {
            const lineBytes = new Uint8Array(partsLen + (nl - start));
            let off = 0;
            for (const p of parts) {
              lineBytes.set(p, off);
              off += p.length;
            }
            lineBytes.set(value.subarray(start, nl), off);
            parts = [];
            partsLen = 0;
            deliverBytes(lineBytes);
          }
          start = nl + 1;
          if (performance.now() - sliceStart >= SLICE_MS) {
            await yieldSlice();
            sliceStart = performance.now();
          }
        }
        if (start < value.length) {
          const rest = value.slice(start);
          parts.push(rest);
          partsLen += rest.length;
        }
      }
      if (partsLen > 0) {
        const tailBytes = new Uint8Array(partsLen);
        let off = 0;
        for (const p of parts) {
          tailBytes.set(p, off);
          off += p.length;
        }
        deliverBytes(tailBytes);
      }
    } catch (e) {
      if (delivered === 0) throw e;
      return built; // partial stream: the accumulated chunks stand
    }
    return built;
  }

  // -- services ----------------------------------------------------------
  agentMessage(threadId: string | undefined, text: string): Promise<unknown> {
    return this.call('/api/agent/message', { method: 'POST' }, { threadId, text });
  }

  /**
   * FIX-E: generated-app creation through the agent service (the LLM
   * generator runs server-side on Vertex AI; the browser holds no GCP
   * credentials). Resolves to { result: GenerateArtifactResult }.
   */
  generateApp(prompt: string, sheet?: string, fileId?: string): Promise<unknown> {
    return this.call(
      '/api/agent/artifacts/generate',
      { method: 'POST' },
      fileId ? { prompt, sheet, fileId } : { prompt, sheet },
    );
  }

  /**
   * FIX-E: an MCP tool call for a generated app, through the gateway.
   * The agent service enforces the bridge allowlist server-side;
   * resolves to the tool's parsed data.
   */
  /**
   * #150: when the open file is known, carry its fileId so the gateway
   * attaches the signed session binding and the bridge reads the LIVE
   * engine. Without it the bridge resolves to the private scratch host
   * in prod (app reads return null, app generation reads an empty
   * scratch 'Sheet1'). Absent fileId keeps today's behavior.
   */
  async callTool(
    tool: string,
    args: Record<string, unknown>,
    fileId?: string,
  ): Promise<unknown> {
    const res = (await this.call(
      '/api/agent/tools/call',
      { method: 'POST' },
      fileId ? { tool, args, fileId } : { tool, args },
    )) as {
      data?: unknown;
    } | null;
    return res?.data;
  }

  etlRun(recipe: unknown): Promise<unknown> {
    return this.call('/api/etl/run', { method: 'POST' }, { recipe });
  }

  vaultStore(ref: string, secret: string): Promise<unknown> {
    return this.call('/api/vault/store', { method: 'POST' }, { ref, secret });
  }

  vaultRetrieve(ref: string): Promise<{ secret: string }> {
    return this.call('/api/vault/retrieve', { method: 'POST' }, { ref });
  }

  // -- connectors (Open Data Source Gallery): secrets are sent exactly
  //    once to the connectors service, which stores them in the vault
  //    under a principal-derived ref; only the ref comes back. --------
  connectorsStoreCredential(
    name: string,
    secret: string,
    kind: 'rest' | 'sql' = 'rest',
  ): Promise<{ ok: true; ref: string }> {
    return this.call('/api/connectors/credential/store', { method: 'POST' }, { name, secret, kind });
  }

  connectorsStoreSqlConnection(
    connection: string,
    connectionString: string,
  ): Promise<{ ok: true; ref: string }> {
    return this.call(
      '/api/connectors/sql/store-connection',
      { method: 'POST' },
      { connection, connectionString },
    );
  }

  connectorsSqlTables(
    connection: string,
  ): Promise<{ ok: true; tables: { name: string; type: string }[] }> {
    return this.call('/api/connectors/sql/tables', { method: 'POST' }, { connection });
  }

  connectorsSqlSchema(
    connection: string,
    table: string,
  ): Promise<{
    ok: true;
    table: string;
    columns: { name: string; type: string; notnull: boolean; pk: boolean }[];
    rowCount: number;
  }> {
    return this.call('/api/connectors/sql/schema', { method: 'POST' }, { connection, table });
  }

  connectorsSqlQuery(
    connection: string,
    query: string,
    params?: unknown[],
  ): Promise<{
    ok: true;
    columns: string[];
    rows: Record<string, string | number | boolean | null>[];
    truncated: boolean;
  }> {
    return this.call(
      '/api/connectors/sql/query',
      { method: 'POST' },
      { connection, query, params: params ?? [] },
    );
  }

  metaGet(key: string): Promise<{ value: string | null }> {
    return this.call(`/api/meta/kv/${encodeURIComponent(key)}`, { method: 'GET' });
  }

  metaPut(key: string, value: string): Promise<unknown> {
    return this.call(`/api/meta/kv/${encodeURIComponent(key)}`, { method: 'PUT' }, { value });
  }

  // -- add-ons (add-on-model.md §5/§6: catalog, grants, and /run against the
  //    open workbook's typed view through the gateway's add-on service) ----
  addonsCatalog(): Promise<{ listings: unknown[] }> {
    return this.call('/api/addons/catalog', { method: 'GET' });
  }

  addonsInstalled(): Promise<{ installed: unknown[] }> {
    return this.call('/api/addons/installed', { method: 'GET' });
  }

  addonsInstall(id: string, version?: string): Promise<unknown> {
    return this.call('/api/addons/install', { method: 'POST' }, { id, version });
  }

  addonsEnable(id: string): Promise<unknown> {
    return this.call('/api/addons/enable', { method: 'POST' }, { id });
  }

  addonsDisable(id: string): Promise<unknown> {
    return this.call('/api/addons/disable', { method: 'POST' }, { id });
  }

  addonsUninstall(id: string): Promise<unknown> {
    return this.call('/api/addons/uninstall', { method: 'POST' }, { id });
  }

  addonsGrants(addonId?: string, documentId?: string): Promise<{ grants: unknown[] }> {
    const q = new URLSearchParams();
    if (addonId) q.set('addonId', addonId);
    if (documentId) q.set('documentId', documentId);
    const qs = q.toString();
    return this.call(`/api/addons/grants${qs ? `?${qs}` : ''}`, { method: 'GET' });
  }

  addonsRequestGrant(addonId: string, documentId: string, capabilities: unknown): Promise<unknown> {
    return this.call(
      '/api/addons/grants/request',
      { method: 'POST' },
      { addonId, documentId, capabilities },
    );
  }

  addonsApproveGrant(id: string): Promise<unknown> {
    return this.call('/api/addons/grants/approve', { method: 'POST' }, { id });
  }

  addonsDenyGrant(id: string): Promise<unknown> {
    return this.call('/api/addons/grants/deny', { method: 'POST' }, { id });
  }

  addonsRevokeGrant(id: string): Promise<unknown> {
    return this.call('/api/addons/grants/revoke', { method: 'POST' }, { id });
  }

  /**
   * Run an installed add-on against the open workbook. The gateway's add-on
   * service resolves the document binding to the engine service's workbook
   * (§5) and returns the worker result envelope — it never throws for a
   * failed invocation, only for transport/auth failures.
   */
  async addonsRun(
    addonId: string,
    documentId: string,
    args?: unknown,
    entry?: string,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: string; code?: string }> {
    const res = await this.withReauth(() => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.token) headers['authorization'] = `Bearer ${this.token}`;
      return fetch(`${this.baseUrl}/api/addons/run`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ addonId, documentId, args, entry }),
      });
    });
    if (res.status === 401) throw new GatewayAuthError('not authenticated (401)');
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '1') * 1000;
      throw new GatewayRateLimitError('rate limited (429)', retryAfter);
    }
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      value?: unknown;
      error?: string;
      code?: string;
    } | null;
    if (res.ok && body?.ok) return { ok: true, value: body.value };
    return {
      ok: false,
      error: typeof body?.error === 'string' ? body.error : `request failed: ${res.status}`,
      code: body?.code,
    };
  }
}

/** Singleton for the app (created when VITE_GATEWAY_URL is set). */
let shared: GatewayClient | null = null;

export function getGatewayClient(): GatewayClient | null {
  // import.meta.env is typed via vite/client when the Vite build provides it;
  // fall back to an untyped read so `tsc` stays clean without those types.
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const url = env?.['VITE_GATEWAY_URL'];
  if (!url) return null;
  if (!shared) shared = new GatewayClient(url);
  return shared;
}

export { isDesktop };
