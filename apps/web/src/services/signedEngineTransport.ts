/**
 * Signed-mode engine transport (design-docs/deployment-architecture.md,
 * "Engine access pattern: gateway-issued signed URL, direct connection").
 *
 * Active only when the web build sets VITE_ENGINE_ACCESS_MODE=signed.
 * The default build keeps the proxy transport (GatewayEngineTransport):
 * every engine call flows through the gateway, which validates each one.
 *
 * In signed mode this transport:
 *   1. Obtains a short-lived signed token from the gateway
 *      (POST /api/engine/access — the gateway's auth + rate limiting
 *      run there; that handshake is the ONLY gateway contact).
 *   2. Talks DIRECTLY to the engine base URL from the grant
 *      (ENGINE_URL_STANDARD / ENGINE_URL_XL by tier) with the token as
 *      `Authorization: Bearer <token>` on every call — loads, the NDJSON
 *      stream, reads, edits, saves: no gateway in the data path.
 *   3. On a 401 (expired / stale token), re-issues via the gateway ONCE
 *      and retries; a second 401 is surfaced, never looped.
 *
 * It implements the same AsyncEngineTransport contract as the proxy
 * transport, plus the session-lifecycle surface (heartbeat / release /
 * rehydrate / status) the idle rule needs — in signed mode those calls
 * also go direct; the tab-close release uses navigator.sendBeacon with
 * the token as ?access_token= (beacons cannot set headers; the engine
 * verifies both presentations identically).
 */
/// <reference types="vite/client" />
import type {
  CellRef,
  CommandResult,
  EngineCommand,
  EngineEvent,
  RangeRef,
  TypedValue,
  WorkbookSnapshot,
} from '@icecream-sheets/engine';
import { clientInstanceId } from './clientInstance';
import {
  GatewayAuthError,
  GatewayRateLimitError,
  type EngineAccessGrant,
  type EngineRehydrateResult,
  type EngineSessionStatus,
  type GatewayClient,
} from './gatewayClient';
import {
  mergeLoadChunks,
  streamProgressPct,
  type AsyncEngineTransport,
  type EngineCellRead,
  type EngineLoadResult,
  type EngineRangeRead,
  type ProgressiveLoadChunk,
  type RawStreamChunk,
} from './engineTransport';

/** True when this build runs the production signed-access pattern. */
export function signedEngineAccessEnabled(): boolean {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return (env?.['VITE_ENGINE_ACCESS_MODE'] ?? '').toLowerCase() === 'signed';
}

/** Refresh the token when it has less than this long left. */
const TOKEN_REFRESH_SKEW_MS = 30_000;

export class SignedEngineTransport implements AsyncEngineTransport {
  private grant: EngineAccessGrant | null = null;
  private sessionId: string | null = null;
  /**
   * In-flight grant issuance (Worker F, defect F3): concurrent reads
   * racing a dropped/absent grant (first paint, the bindSession drop at
   * join) used to EACH mint their own grant through the gateway — the
   * losing grants were discarded unused, and when no session was bound
   * yet each mint named a FRESH random session, so the winner's scope
   * was arbitrary. Non-forced issuances for the same wanted session now
   * share one in-flight mint. Forced re-issues (the 401 retry) always
   * mint fresh, exactly as before.
   */
  private grantInFlight: Promise<EngineAccessGrant> | null = null;
  private grantInFlightFor: string | null = null;
  /**
   * Scope epoch: bumped by bindSession(). A grant mint that resolves
   * after the scope moved must NOT adopt its (pre-bind) grant or
   * overwrite the bound sessionId — a late-resolving unscoped mint
   * clobbering the bound scope is one way a transport ends up holding a
   * wrong-session grant it then reuses indefinitely (defect F3).
   */
  private scopeEpoch = 0;
  /**
   * Owner endpoint of the JOINED session (fleet placement fix): a file's
   * ONE session lives on the engine instance the gateway's join
   * handshake claimed it on, which is NOT necessarily the instance the
   * /api/engine/access grant names — the grant carries the TIER's
   * canonical URL (the first service of the tier). Grants are scoped to
   * the session id but were silently addressed to the tier URL, so for
   * any session placed on a non-first instance every read (/read,
   * /sheets, /snapshot) went to an engine that does not hold the
   * session and failed 401 — the grid painted empty and never
   * recovered. When a session is bound WITH its owner URL (the join
   * handshake's engineUrl), grants adopted for that session are
   * re-addressed to the owner. Unbound flows (fresh anonymous sessions,
   * /reset) keep the grant's tier URL: the session is created by the
   * call itself on that engine.
   */
  private boundSessionId: string | null = null;
  private boundEngineUrl: string | null = null;

  constructor(private readonly client: GatewayClient) {}

  /** The session this transport is scoped to (set at load/reset/rehydrate). */
  get currentSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Scope this transport to an externally-opened session (Phase 2 join
   * handshake: gatewayClient.openFile already claimed/joined the file's
   * ONE session and returned its id). Grants minted afterwards carry
   * that session id; a cached grant scoped to any other session is
   * dropped, since the engine refuses wrong-session tokens on every
   * route. Called by RemoteEngineHost when its collab transport opens.
   */
  bindSession(sessionId: string, engineUrl?: string): void {
    if (engineUrl) {
      this.boundSessionId = sessionId;
      this.boundEngineUrl = engineUrl;
      // A grant for this session minted before the bind (or before the
      // owner URL was known) points at the tier URL — re-address it.
      if (this.grant && this.grant.sessionId === sessionId && this.grant.engineUrl !== engineUrl) {
        this.grant = { ...this.grant, engineUrl };
      }
    } else if (this.boundSessionId === sessionId) {
      // Re-bind without a URL for the same session: keep the known owner.
    } else {
      this.boundSessionId = null;
      this.boundEngineUrl = null;
    }
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.scopeEpoch++;
    if (this.grant && this.grant.sessionId !== sessionId) this.grant = null;
  }

  /**
   * Re-address a grant to the bound session's owner engine when the
   * grant is scoped to that session (see boundEngineUrl). The token is
   * unchanged — the engine validates the signature and session scope,
   * not the URL it arrived on.
   */
  private addressedToOwner(grant: EngineAccessGrant): EngineAccessGrant {
    if (
      this.boundEngineUrl &&
      grant.sessionId === this.boundSessionId &&
      grant.engineUrl !== this.boundEngineUrl
    ) {
      return { ...grant, engineUrl: this.boundEngineUrl };
    }
    return grant;
  }

  /**
   * The current grant, re-issuing through the gateway when absent,
   * near expiry, scoped to another session, or `force`d. With
   * `newSession`, any existing session scope is dropped so the gateway
   * mints a fresh session id (the /reset flow).
   */
  async ensureGrant(opts?: {
    sessionId?: string;
    cellCount?: number;
    force?: boolean;
    newSession?: boolean;
  }): Promise<EngineAccessGrant> {
    const wanted = opts?.newSession ? undefined : (opts?.sessionId ?? this.sessionId ?? undefined);
    if (
      !opts?.force &&
      this.grant &&
      this.grant.expiresAt - Date.now() > TOKEN_REFRESH_SKEW_MS &&
      (wanted === undefined || this.grant.sessionId === wanted)
    ) {
      return this.grant;
    }
    // Share one in-flight mint between concurrent non-forced callers
    // asking for the same scope (see grantInFlight note above).
    if (!opts?.force && this.grantInFlight && this.grantInFlightFor === (wanted ?? null)) {
      return this.grantInFlight;
    }
    const epochAtMint = this.scopeEpoch;
    const mint = (async (): Promise<EngineAccessGrant> => {
      const grant = await this.client.engineAccess({
        ...(wanted ? { sessionId: wanted } : {}),
        ...(opts?.cellCount !== undefined ? { cellCount: opts.cellCount } : {}),
      });
      if (this.scopeEpoch !== epochAtMint) {
        // The session scope moved (bindSession) while this mint was in
        // flight: discard the stale-scope grant and re-resolve against
        // the CURRENT scope instead of adopting it.
        return this.ensureGrant(opts);
      }
      this.grant = this.addressedToOwner(grant);
      this.sessionId = grant.sessionId;
      return this.grant;
    })();
    if (!opts?.force) {
      this.grantInFlight = mint;
      this.grantInFlightFor = wanted ?? null;
      void mint.then(
        () => {
          if (this.grantInFlight === mint) {
            this.grantInFlight = null;
            this.grantInFlightFor = null;
          }
        },
        () => {
          if (this.grantInFlight === mint) {
            this.grantInFlight = null;
            this.grantInFlightFor = null;
          }
        },
      );
    }
    return mint;
  }

  /** One direct call; on 401, re-issue once and retry exactly once. */
  private async direct<T>(
    path: string,
    init: { method: string },
    body?: unknown,
    retried = false,
  ): Promise<T> {
    const grant = await this.ensureGrant();
    const res = await fetch(`${grant.engineUrl}${path}`, {
      method: init.method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${grant.accessToken}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && !retried) {
      await this.ensureGrant({ force: true });
      return this.direct<T>(path, init, body, true);
    }
    if (res.status === 401) throw new GatewayAuthError('engine access token rejected (401)');
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '1') * 1000;
      throw new GatewayRateLimitError('engine session rate limited (429)', retryAfter);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`engine ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  // -- AsyncEngineTransport ------------------------------------------------

  async loadXlsx(base64: string): Promise<EngineLoadResult> {
    // The token comes FIRST: its session id is the session the load
    // introduces (the engine enforces body.sessionId === token.sid).
    const grant = await this.ensureGrant();
    const result = await this.direct<EngineLoadResult>('/load', { method: 'POST' }, {
      format: 'xlsx',
      data: base64,
      sessionId: grant.sessionId,
    });
    if (result.sessionId) this.sessionId = result.sessionId;
    return result;
  }

  async loadXlsxProgressive(
    base64: string,
    onChunk: (accumulated: EngineLoadResult, done: boolean, chunk: ProgressiveLoadChunk) => void,
  ): Promise<EngineLoadResult> {
    const grant = await this.ensureGrant();
    let accumulated: EngineLoadResult | null = null;
    let calculating = false;
    let streamError: string | null = null;
    let sawBuilt = false;
    const emit = (raw: RawStreamChunk): EngineLoadResult => {
      accumulated = mergeLoadChunks(accumulated, raw);
      if (raw.type === 'data-done') calculating = true;
      if (raw.type === 'built') {
        calculating = false;
        sawBuilt = true;
        if (raw.response.sessionId) this.sessionId = raw.response.sessionId;
      }
      if (raw.type === 'error') streamError = raw.error;
      const progress =
        raw.type === 'data-done'
          ? { ...raw.progress, totalCells: raw.totalCells }
          : 'progress' in raw
            ? raw.progress
            : undefined;
      onChunk(accumulated, raw.type === 'built', {
        rawType: raw.type,
        progressPct: streamProgressPct(progress),
        calculating,
        ...(streamError ? { streamError } : {}),
        raw,
      });
      return accumulated;
    };
    try {
      const res = await fetch(`${grant.engineUrl}/load/stream`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${grant.accessToken}`,
        },
        body: new Blob([JSON.stringify({ format: 'xlsx', data: base64, sessionId: grant.sessionId })], {
          type: 'application/json',
        }),
      });
      if (res.status === 401) throw new GatewayAuthError('engine access token rejected (401)');
      if (!res.ok || !res.body) throw new Error(`engine ${res.status}: load/stream unavailable`);
      // Byte-level NDJSON line splitting (same approach as the gateway
      // client's stream reader: 0x0A can never appear inside a UTF-8
      // multibyte sequence, so lines assemble exactly once per byte).
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let parts: Uint8Array[] = [];
      let partsLen = 0;
      const deliverBytes = (lineBytes: Uint8Array): void => {
        const line = decoder.decode(lineBytes);
        if (!line.trim()) return;
        try {
          emit(JSON.parse(line) as RawStreamChunk);
        } catch (e) {
          console.warn('[signed-engine-transport] stream chunk dropped:', e);
        }
      };
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
        }
        if (start < value.length) {
          const rest = value.slice(start);
          parts.push(rest);
          partsLen += rest.length;
        }
      }
      if (streamError) throw new Error(streamError);
      if (accumulated) return accumulated;
      throw new Error('load/stream ended without a terminal chunk');
    } catch (e) {
      // Issue #18: a load the engine itself reported as failed (error
      // chunk in the stream) must surface as a FAILURE — never as the
      // partial/empty accumulation. Before this ordering, a corrupt
      // file "opened" as a blank workbook: the error chunk itself
      // merged into an empty result, the catch returned it as success,
      // and the caller never learned the open had failed.
      if (streamError) throw e instanceof Error ? e : new Error(streamError);
      if (accumulated) return accumulated;
      if (e instanceof GatewayAuthError) {
        // One re-issue + retry of the whole progressive load.
        await this.ensureGrant({ force: true });
        return this.loadXlsxProgressive(base64, onChunk);
      }
      const full = await this.loadXlsx(base64);
      accumulated = mergeLoadChunks(null, { type: 'built', response: full });
      onChunk(accumulated, true, { rawType: 'fallback' });
      return accumulated;
    } finally {
      void sawBuilt;
    }
  }

  async reset(): Promise<void> {
    // A reset introduces a NEW session: mint a fresh grant scope, then
    // the engine adopts the token's session id as the blank workbook's.
    const grant = await this.ensureGrant({ newSession: true, force: true });
    const r = await this.direct<{ sessionId?: string }>('/reset', { method: 'POST' }, {});
    if (r.sessionId) this.sessionId = r.sessionId;
    else this.sessionId = grant.sessionId;
  }

  async sheetNames(): Promise<string[]> {
    const r = await this.direct<{ sheets: string[] }>('/sheets', { method: 'GET' });
    return r.sheets;
  }

  execute(cmd: EngineCommand, opts?: { ackChecksum?: boolean }): Promise<CommandResult> {
    return this.direct<CommandResult>(
      '/execute',
      { method: 'POST' },
      opts?.ackChecksum ? { cmd, ackChecksum: true } : { cmd },
    );
  }

  readCell(ref: CellRef): Promise<EngineCellRead> {
    return this.direct<EngineCellRead>('/read', { method: 'POST' }, { kind: 'cell', ref });
  }

  readRange(range: RangeRef): Promise<EngineRangeRead> {
    return this.direct<EngineRangeRead>('/read', { method: 'POST' }, { kind: 'range', range });
  }

  async readSheet(sheet: string): Promise<TypedValue[][]> {
    const r = await this.direct<{ values: TypedValue[][] }>('/read', { method: 'POST' }, {
      kind: 'sheet',
      sheet,
    });
    return r.values;
  }

  async usedRange(sheet: string): Promise<RangeRef | null> {
    const r = await this.direct<{ range: RangeRef | null }>('/read', { method: 'POST' }, {
      kind: 'usedrange',
      sheet,
    });
    return r.range ?? null;
  }

  snapshot(): Promise<WorkbookSnapshot> {
    return this.direct<WorkbookSnapshot>('/snapshot', { method: 'GET' });
  }

  async events(since: number): Promise<Array<{ seq: number; event: EngineEvent }>> {
    const r = await this.direct<{ events: Array<{ seq: number; event: EngineEvent }> }>(
      `/events?since=${since}`,
      { method: 'GET' },
    );
    return r.events;
  }

  // -- session lifecycle (direct in signed mode) ---------------------------

  async sessionStatus(): Promise<EngineSessionStatus> {
    return this.direct<EngineSessionStatus>('/session/status', { method: 'GET' });
  }

  sessionHeartbeat(sessionId: string): Promise<{ ok: true; lastActivityAt: number }> {
    return this.direct('/session/heartbeat', { method: 'POST' }, { sessionId, clientInstanceId: clientInstanceId() });
  }

  sessionRelease(
    sessionId: string,
    reason: string,
  ): Promise<{ ok: true; revision: number; checksum: string | null }> {
    return this.direct('/session/release', { method: 'POST' }, { sessionId, reason, clientInstanceId: clientInstanceId() });
  }

  /**
   * Rehydrate never throws for a checksum mismatch: the engine answers
   * 409 with { ok:false, checksumVerified:false }, and the caller (the
   * idle controller) must see that shape to keep editing locked.
   */
  async sessionRehydrate(sessionId: string): Promise<EngineRehydrateResult> {
    const grant = await this.ensureGrant({ sessionId });
    const res = await fetch(`${grant.engineUrl}/session/rehydrate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${grant.accessToken}`,
      },
      body: JSON.stringify({ sessionId }),
    });
    const body = (await res.json().catch(() => null)) as EngineRehydrateResult | null;
    if (body && typeof body.checksumVerified === 'boolean') {
      if (body.ok) this.sessionId = sessionId;
      return body;
    }
    if (!res.ok) throw new Error(`engine ${res.status}: rehydrate failed`);
    throw new Error('rehydrate: malformed engine response');
  }

  /**
   * Tab-close release (doc §Idle rule 5): sendBeacon with the token as
   * ?access_token= — beacons cannot set headers, and the engine
   * verifies the query presentation identically. Uses the CACHED grant
   * (pagehide cannot await an issuance round-trip).
   */
  releaseBeacon(sessionId: string, reason: string): boolean {
    if (!this.grant) return false;
    try {
      const url = `${this.grant.engineUrl}/session/release?access_token=${encodeURIComponent(this.grant.accessToken)}`;
      // text/plain keeps the beacon CORS-safelisted: an application/json
      // Blob would force a preflight that page unload drops. The
      // engine's body reader parses JSON regardless of content type.
      const payload = new Blob([JSON.stringify({ sessionId, reason, clientInstanceId: clientInstanceId() })], {
        type: 'text/plain;charset=UTF-8',
      });
      return navigator.sendBeacon(url, payload);
    } catch {
      return false;
    }
  }
}
