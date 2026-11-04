/**
 * MCP file → engine-instance binding (design doc
 * `mcp-and-service-engine-routing.md` §4).
 *
 * The public MCP server must reach the SAME engine instance holding a
 * file as every other caller (grid, agent, AI service) — never a
 * private copy, never another file's engine, never a tier URL.
 *
 * Binding happens ONCE, at MCP session creation, from the SAME registry
 * the gateway reads (Firestore in prod):
 *   1. lookup(fileId) — no record → unbound (honest refusal).
 *   2. ACL check from the record — stranger (no grant, not creator) →
 *      refused BEFORE any engine contact (zero fetches).
 *   3. Liveness probe — the gateway JOIN pattern: GET
 *      {ownerEndpoint}/session/status, `status === 'active'` +
 *      sessionId match. A dead owner is never trusted blindly, even
 *      with a live-looking lease. Probe failure → unbound.
 *   4. Bind a NodeRemoteEngineHost (the agent's established remote host)
 *      to the record's ownerEndpoint + sessionId, with a fresh signed
 *      engine token minted per request (TTL 120, agent parity).
 *
 * Claims stay gateway-owned: this module NEVER claims, rehydrates, or
 * hydrates a private copy. If no live session exists, the caller must
 * open the file via the gateway first, then retry.
 *
 * Permission semantics are grounded in the gateway's fileRegistry.ts
 * (`aclRoleFor`): creatorPrincipal → owner; `grants[principal]` →
 * editor/viewer; linkShare set → its role for anyone ungranted (issue
 * #84c); anything else → null (denied). The gateway index does
 * not export `aclRoleFor`, so the pure functions below are a local copy
 * of that exact semantics — they are the same rule, not a new model.
 * MCP principals are `user:<id>` (service `principalFromToken`), the
 * same format the registry records use, so no mapping is needed.
 *
 * Engine token roles have only editor/viewer (EngineAccessRole), so the
 * registry owner role maps to an 'editor' engine token: the registry ACL
 * is the primary gate (owner = full rights), the engine token is the
 * secondary gate (#104).
 */

import {
  engineAccessSecret,
  isLiveOwner,
  issueEngineAccessToken,
  NodeRemoteEngineHost,
  type FileRegistry,
  type FileRegistryRecord,
  type RemoteEngineFetch,
} from '@icecream-sheets/gateway/remote';

/** Registry roles, exactly as fileRegistry.ts defines them. */
export type McpFileRole = 'owner' | 'editor' | 'viewer';

/**
 * Local copy of gateway fileRegistry.ts `aclRoleFor` (not exported from
 * the gateway index): the creator is the owner; an owner-recorded grant
 * names editor/viewer; a set linkShare names its role for anyone
 * ungranted (issue #84c); anything else is denied (null). A null record
 * means no ACL exists yet — the creating principal is its owner.
 */
export function mcpAclRoleFor(
  rec: FileRegistryRecord | null,
  principal: string,
): McpFileRole | null {
  if (!rec) return 'owner';
  if (principal === rec.creatorPrincipal) return 'owner';
  const grant = rec.grants?.[principal];
  if (grant === 'editor' || grant === 'viewer') return grant;
  const linkRole = rec.linkShare?.role;
  return linkRole === 'editor' || linkRole === 'viewer' ? linkRole : null;
}

/** Local copy of gateway fileRegistry.ts `aclAllows`. */
export function mcpAclAllows(
  rec: FileRegistryRecord | null,
  principal: string,
  action: 'read' | 'write',
): boolean {
  const role = mcpAclRoleFor(rec, principal);
  if (!role) return false;
  if (action === 'write') return role === 'owner' || role === 'editor';
  return true;
}

export type McpBindingErrorKind = 'unbound' | 'refused' | 'config' | 'unavailable';

/** Typed binding failure: the HTTP layer maps kind → status. */
export class McpFileBindingError extends Error {
  constructor(
    public readonly kind: McpBindingErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'McpFileBindingError';
  }

  get httpStatus(): number {
    switch (this.kind) {
      case 'refused':
        return 403;
      case 'config':
        return 500;
      case 'unavailable':
        return 503;
      default:
        return 404;
    }
  }
}

/** A bound file session: the remote host + its provenance. */
export interface McpFileBinding {
  /** The remote host to hand to createServer(). */
  host: NodeRemoteEngineHost;
  /** Registry role of the bound principal (primary gate verdict). */
  role: McpFileRole;
  /** Engine token role actually minted ('editor' for owner/editor). */
  engineRole: 'editor' | 'viewer';
  sessionId: string;
  fileId: string;
  engineUrl: string;
  /**
   * Set by onLinkRefusal when an engine call proves the bound link dead
   * (unreachable / unauthorized / forbidden / not-found). Later calls
   * fail honestly at the engine; the session must be recreated to
   * re-bind (transparent refresh is future work, not built here).
   * A capability refusal is NOT a link refusal: the readOnly host
   * refuses viewer writes without invoking this, so the link stays
   * valid for later reads.
   */
  dead: boolean;
  deadKind?: 'unreachable' | 'unauthorized' | 'forbidden' | 'not-found';
}

export interface ResolveMcpFileBindingOptions {
  registry: FileRegistry;
  fileId: string;
  principal: string;
  /**
   * ENGINE_ACCESS_SECRET override. Default: engineAccessSecret() from
   * the environment. Null/empty → config error (fail closed — a public
   * MCP must never fall back to the unsigned x-principal header).
   */
  engineSecret?: string | null;
  /** Fetch override (tests). Default: global fetch (with 5s probe timeout). */
  fetchFn?: RemoteEngineFetch;
  /** Liveness probe timeout for the global-fetch path. Default 5000 ms. */
  livenessTimeoutMs?: number;
}

/** Engine token TTL, seconds — agent host parity (agentSvc). */
export const MCP_ENGINE_TOKEN_TTL_SECONDS = 120;

/**
 * Liveness probe, gateway JOIN pattern: the recorded owner actually
 * holds THIS session and reports it active. Anything else is not live.
 * With an injected fetchFn (tests) no timeout is applied — the fake
 * controls timing; with global fetch the probe times out.
 */
export async function probeEngineLiveness(opts: {
  engineUrl: string;
  sessionId: string;
  token: string;
  fetchFn?: RemoteEngineFetch;
  timeoutMs?: number;
}): Promise<boolean> {
  const url = `${opts.engineUrl.replace(/\/+$/, '')}/session/status`;
  try {
    let ok = false;
    let body: { status?: unknown; sessionId?: unknown } | null = null;
    if (opts.fetchFn) {
      const res = await opts.fetchFn(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${opts.token}` },
      });
      ok = res.ok;
      if (ok) body = (await res.json()) as { status?: unknown; sessionId?: unknown };
    } else {
      const res = await fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${opts.token}` },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      });
      ok = res.ok;
      if (ok) body = (await res.json()) as { status?: unknown; sessionId?: unknown };
    }
    return ok && body !== null && body.status === 'active' && body.sessionId === opts.sessionId;
  } catch {
    return false;
  }
}

/**
 * Resolve + bind a file for one MCP principal. Throws
 * McpFileBindingError on every failure path — never returns a host for
 * a file the principal may not use, never falls back to another file,
 * never hydrates a private copy.
 */
export async function resolveMcpFileBinding(
  opts: ResolveMcpFileBindingOptions,
): Promise<McpFileBinding> {
  const { registry, fileId, principal } = opts;

  let rec: FileRegistryRecord | null;
  try {
    rec = await registry.lookup(fileId);
  } catch {
    // Registry outage fails closed, like the gateway: never open.
    throw new McpFileBindingError(
      'unavailable',
      'file registry unavailable — refusing rather than routing blind',
    );
  }
  if (!rec) {
    throw new McpFileBindingError(
      'unbound',
      `no live session for file ${fileId} — open it via the gateway first, then retry`,
    );
  }

  // PRIMARY GATE (before ANY engine contact): the record alone decides.
  // A stranger is refused here, with zero fetches — not even a probe.
  const role = mcpAclRoleFor(rec, principal);
  if (!role) {
    throw new McpFileBindingError(
      'refused',
      `principal ${principal} has no access to file ${fileId}`,
    );
  }

  const secret = opts.engineSecret ?? engineAccessSecret();
  if (!secret) {
    throw new McpFileBindingError(
      'config',
      'ENGINE_ACCESS_SECRET is not configured — refusing rather than contacting an engine unsigned',
    );
  }

  const engineRole: 'editor' | 'viewer' = role === 'viewer' ? 'viewer' : 'editor';
  const mint = (): string =>
    issueEngineAccessToken({
      secret,
      principal,
      sessionId: rec!.sessionId,
      fid: fileId,
      role: engineRole,
      tier: 'standard',
      ttlSeconds: MCP_ENGINE_TOKEN_TTL_SECONDS,
    }).token;

  // Liveness, never blind trust — even a live-looking lease is probed
  // (the #100 lesson: a record whose engine copy is gone must not yield
  // a live-looking bind). isLiveOwner only decides whether a FAILED
  // probe is surprising; it never skips the probe.
  void isLiveOwner(rec);
  const live = await probeEngineLiveness({
    engineUrl: rec.ownerEndpoint,
    sessionId: rec.sessionId,
    token: mint(),
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    ...(opts.livenessTimeoutMs !== undefined
      ? { timeoutMs: opts.livenessTimeoutMs }
      : {}),
  });
  if (!live) {
    throw new McpFileBindingError(
      'unbound',
      `the session for file ${fileId} is not live on its recorded engine — reopen it via the gateway, then retry`,
    );
  }

  const binding: McpFileBinding = {
    host: null as unknown as NodeRemoteEngineHost,
    role,
    engineRole,
    sessionId: rec.sessionId,
    fileId,
    engineUrl: rec.ownerEndpoint,
    dead: false,
  };
  binding.host = new NodeRemoteEngineHost({
    engineUrl: rec.ownerEndpoint,
    principal,
    sessionId: rec.sessionId,
    fileId,
    clientId: `mcp:${principal}`,
    initialRevision: rec.currentRevision,
    getAccessToken: () => mint(),
    // PRIMARY GATE, host-enforced: a viewer host refuses every mutating
    // command BEFORE engine contact; the engine's per-call token
    // verification (#104) is the secondary gate behind it.
    readOnly: role === 'viewer',
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    onLinkRefusal: (kind) => {
      binding.dead = true;
      binding.deadKind = kind;
    },
  });
  return binding;
}
