/**
 * Streamable-HTTP transport for the icecream-sheets MCP server.
 *
 * Node-only: uses node:http and the SDK's Node transport wrapper. This
 * module is deliberately NOT exported from index.ts so browser bundles
 * (vite) never see node builtins in the import graph.
 *
 * Mounts the MCP Streamable HTTP endpoint at `/mcp` (POST = client→server
 * messages, GET = standalone SSE stream, DELETE = session teardown) and a
 * plain `GET /health` probe outside the MCP transport.
 *
 * ---------------------------------------------------------------------------
 * TRUST BOUNDARY — READ BEFORE EXPOSING THIS LISTENER
 * ---------------------------------------------------------------------------
 * This listener is MCP's OWN direct ingress: it is deliberately NOT behind
 * the API gateway (user's deployment ruling — the gateway never sees MCP
 * traffic and never validates MCP users). MCP authenticates itself:
 * a Bearer JWT is VERIFIED here with MCP's own secret (McpHttpOptions.authSecret
 * / MCP_AUTH_SECRET). The legacy `x-principal` header is NEVER trusted —
 * it was the gateway's injection mechanism and is now client-controlled.
 * Without a valid Bearer token, the caller is the anonymous local-dev principal
 * (`mcp-client`); production deployments should set requireAuth.
 * MCP enforces its OWN rate-limit tier (default 6000 req/60s — 10x the
 * gateway's), independent of the gateway's limiter.
 * ---------------------------------------------------------------------------
 *
 * Session model: one MCP session = one StreamableHTTPServerTransport + one
 * McpServer created via createServer(). All sessions share the EngineHost
 * (the workbook), so two connections see the same data; per-session state
 * (subscriptions, pivot caches) is isolated per McpServer instance. The
 * principal VERIFIED at session creation is BOUND to the session and is
 * authoritative for every tool call (F-10): a `principal` tool argument
 * must match it or be absent — a mismatching argument is refused. Only
 * ANONYMOUS local-dev sessions (no verified token, requireAuth=false)
 * keep the legacy caller-asserted principal, because there the local
 * process is the trust boundary.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { EngineHost } from '@icecream-sheets/engine';
import type { Persistence, AsyncPersistence } from '@icecream-sheets/service';
import { verifyToken, principalFromToken } from '@icecream-sheets/service';
import {
  createFileRegistry,
  type FileRegistry,
  type RemoteEngineFetch,
} from '@icecream-sheets/gateway/remote';
import { createServer } from './server.js';
import {
  McpFileBindingError,
  resolveMcpFileBinding,
} from './remoteFileBinding.js';

export interface McpHttpOptions {
  /**
   * Engine host shared by every session. Defaults to a fresh EngineHost.
   * Pass your own to share workbook state with other entrypoints (or to
   * inspect the authorizer audit log in tests). File-bound sessions
   * (below) use their OWN bound remote host instead of this one.
   */
  host?: EngineHost;
  /**
   * File registry for file-bound sessions — the SAME registry the
   * gateway reads (Firestore in prod). Default: created lazily from
   * process.env on the first file-bound session creation, so file-less
   * sessions never touch it. Tests inject a MemoryFileRegistry.
   */
  fileRegistry?: FileRegistry;
  /**
   * Fetch override for file-bound engine calls (tests). Default:
   * global fetch. Only used for bound sessions.
   */
  fileEngineFetch?: RemoteEngineFetch;
  /**
   * ENGINE_ACCESS_SECRET override for file-bound sessions (tests).
   * Default: read from the environment at bind time. Production sets
   * ENGINE_ACCESS_SECRET in the deployment (see the mcp.yaml
   * follow-up in the routing report); without it, file-bound session
   * creation fails closed rather than contacting an engine unsigned.
   */
  engineSecret?: string | null;
  /** Persistence for service metadata (pivot specs, agent memory). */
  persistence?: Persistence;
  /**
   * Native async persistence (durable-store migration). Passed through to
   * the server; when present it is used directly instead of bridging
   * `persistence`. The prod runner injects the Firestore adapter here.
   */
  asyncPersistence?: AsyncPersistence;
  /** Path the MCP endpoint is mounted at. Defaults to '/mcp'. */
  mcpPath?: string;
  /**
   * Skill packs to install in every session's server, by pack id.
   * Undefined → every bundled pack. Passed through to createServer;
   * unknown ids fail session creation (the shipped bin validates the
   * MCP_PACKS selection at startup instead — see runner-config.ts).
   */
  packs?: string[];
  /**
   * HMAC secret MCP uses to VERIFY Bearer JWTs itself (it is its own
   * ingress and does not rely on the gateway). Defaults to the
   * MCP_AUTH_SECRET env var, then 'local-dev-secret' (local dev only).
   */
  authSecret?: string | Uint8Array;
  /**
   * Reject requests without a valid Bearer JWT (401). Default false:
   * local-dev anonymous principal (`mcp-client`). Production MUST set true.
   */
  requireAuth?: boolean;
  /**
   * MCP's OWN rate-limit tier — deliberately much higher than the
   * gateway's (AI clients make many rapid tool calls). Default
   * 6000 points per 60s (10x the gateway default of 600/60s).
   */
  rateLimit?: { points: number; perSeconds: number };
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

/** Fallback principal when no identity is presented (matches server.ts). */
const ANONYMOUS_PRINCIPAL = 'mcp-client';

function headerValue(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === 'string' && first.trim() !== '' ? first.trim() : undefined;
}

/**
 * Resolve the session's principal from the request: MCP verifies the
 * Bearer JWT ITSELF with its own secret (it is its own ingress — the
 * gateway never validates MCP users). The legacy `x-principal` header is
 * NEVER trusted: it was the gateway's injection mechanism and is now
 * client-controlled, so honoring it would be a spoofing hole.
 * Returns the anonymous local-dev principal when no (valid) token is
 * presented; callers that need strict auth set requireAuth.
 */
export async function principalFromRequest(
  req: http.IncomingMessage,
  authSecret: string | Uint8Array,
): Promise<{ principal: string; authenticated: boolean }> {
  const m = /^Bearer\s+(.+)$/i.exec(headerValue(req, 'authorization') ?? '');
  if (m) {
    try {
      const claims = await verifyToken(m[1], authSecret);
      return { principal: principalFromToken(claims), authenticated: true };
    } catch {
      // Invalid token → fall through to anonymous (or 401 when requireAuth).
    }
  }
  return { principal: ANONYMOUS_PRINCIPAL, authenticated: false };
}

/**
 * Minimal per-key token-bucket rate limiter (MCP's own tier, independent
 * of the gateway's limiter).
 */
export interface McpRateLimiter {
  /** Returns true when the request is allowed (and consumes a point). */
  take(key: string): boolean;
}

export function createMcpRateLimiter(points: number, perSeconds: number): McpRateLimiter {
  const buckets = new Map<string, { points: number; resetAt: number }>();
  return {
    take(key: string): boolean {
      const now = Date.now();
      let b = buckets.get(key);
      if (!b || now >= b.resetAt) {
        b = { points, resetAt: now + perSeconds * 1000 };
        buckets.set(key, b);
      }
      if (b.points <= 0) return false;
      b.points -= 1;
      // Opportunistic cleanup so the map cannot grow without bound.
      if (buckets.size > 10000) {
        for (const [k, v] of buckets) {
          if (now >= v.resetAt) buckets.delete(k);
          if (buckets.size <= 5000) break;
        }
      }
      return true;
    },
  };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function mcpError(res: http.ServerResponse, status: number, code: number, message: string): void {
  json(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
}

/**
 * Build the request listener: CORS headers, `GET /health`, and the MCP
 * Streamable-HTTP endpoint. The request body is never pre-read here — the
 * SDK transport parses it itself (pre-reading would consume the stream).
 */
export function createMcpHttpListener(opts: McpHttpOptions = {}): http.RequestListener {
  const host = opts.host ?? new EngineHost();
  const persistence = opts.persistence;
  const asyncPersistence = opts.asyncPersistence;
  const mcpPath = opts.mcpPath ?? '/mcp';
  const authSecret = opts.authSecret ?? process.env.MCP_AUTH_SECRET ?? 'local-dev-secret';
  const requireAuth = opts.requireAuth ?? false;
  const rl = opts.rateLimit ?? { points: 6000, perSeconds: 60 };
  const limiter = createMcpRateLimiter(rl.points, rl.perSeconds);
  const sessions = new Map<string, SessionEntry>();

  /**
   * Lazily created file registry (first file-bound session only), so
   * file-less sessions keep exactly today's behavior and cost.
   */
  let fileRegistry: FileRegistry | undefined;
  function getFileRegistry(): FileRegistry {
    if (!fileRegistry) fileRegistry = opts.fileRegistry ?? createFileRegistry(process.env);
    return fileRegistry;
  }

  /**
   * The file a new session wants bound, if any: the
   * `x-icecream-file-id` header first, else the `?file=` query param
   * (the web's convention). A client-supplied fileId is safe: identity
   * comes from the verified Bearer, the file from the client, and
   * permission is resolved server-side from the registry (§9C shape).
   */
  function fileIdFromRequest(req: http.IncomingMessage): string | undefined {
    const header = headerValue(req, 'x-icecream-file-id');
    if (header) return header;
    try {
      const q = new URL(req.url ?? '/', 'http://localhost').searchParams.get('file');
      return q !== null && q.trim() !== '' ? q.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  /** MCP's own auth: verify the Bearer JWT with MCP's secret (never the gateway). */
  async function authPrincipal(
    req: http.IncomingMessage,
  ): Promise<{ principal: string; authenticated: boolean }> {
    const { principal, authenticated } = await principalFromRequest(req, authSecret);
    if (!authenticated && requireAuth) {
      throw Object.assign(new Error('missing or invalid Bearer token'), { status: 401 });
    }
    return { principal, authenticated };
  }

  function rateLimited(res: http.ServerResponse, key: string): boolean {
    if (limiter.take(key)) return false;
    res.setHeader('Retry-After', '60');
    json(res, 429, { ok: false, error: 'mcp rate limit exceeded — slow down' });
    return true;
  }

  async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const sessionId = headerValue(req, 'mcp-session-id');

    if (method === 'POST' && sessionId) {
      const entry = sessions.get(sessionId);
      if (!entry) {
        mcpError(res, 400, -32001, `unknown mcp-session-id: ${sessionId}`);
        return;
      }
      const auth = await authPrincipal(req).catch((e: unknown) => {
        const status = typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : 500;
        mcpError(res, status, -32000, (e as Error).message);
        return null;
      });
      if (auth === null) return;
      if (rateLimited(res, auth.principal)) return;
      await entry.transport.handleRequest(req, res);
      return;
    }

    if (method === 'POST') {
      // New session: MCP verifies the caller's Bearer JWT itself, then binds
      // the verified principal to the session.
      const auth = await authPrincipal(req).catch((e: unknown) => {
        const status = typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : 500;
        mcpError(res, status, -32000, (e as Error).message);
        return null;
      });
      if (auth === null) return;
      if (rateLimited(res, auth.principal)) return;
      // File-bound session (routing spec §4): resolve the file to its
      // owning engine BEFORE creating the session. A binding failure
      // fails session creation outright — never a fallback host, never
      // another file's engine, never a private copy. No fileId →
      // legacy shared local host, unchanged.
      const fileId = fileIdFromRequest(req);
      let sessionHost = host;
      if (fileId !== undefined) {
        try {
          const binding = await resolveMcpFileBinding({
            registry: getFileRegistry(),
            fileId,
            principal: auth.principal,
            ...(opts.engineSecret !== undefined ? { engineSecret: opts.engineSecret } : {}),
            ...(opts.fileEngineFetch ? { fetchFn: opts.fileEngineFetch } : {}),
          });
          sessionHost = binding.host;
        } catch (e) {
          if (e instanceof McpFileBindingError) {
            mcpError(res, e.httpStatus, -32000, e.message);
            return;
          }
          throw e;
        }
      }
      const defaultPrincipal = auth.principal;
      let entry: SessionEntry | undefined;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          if (entry) sessions.set(id, entry);
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        },
      });
      const server = createServer(sessionHost, {
        persistence,
        asyncPersistence,
        defaultPrincipal,
        // F-10: a VERIFIED session identity is authoritative — tool-arg
        // principals must match it. Only an anonymous local-dev session
        // (no token verified; requireAuth=false) keeps caller assertion.
        allowPrincipalAssertion: !auth.authenticated,
        packs: opts.packs,
      });
      entry = { transport, server };
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    if (method === 'GET' || method === 'DELETE') {
      const entry = sessionId ? sessions.get(sessionId) : undefined;
      if (!entry) {
        mcpError(res, 400, -32001, 'missing or unknown mcp-session-id');
        return;
      }
      if (rateLimited(res, `session:${sessionId}`)) return;
      await entry.transport.handleRequest(req, res);
      return;
    }

    mcpError(res, 405, -32000, `method not allowed: ${method}`);
  }

  return (req, res) => {
    // Permissive CORS for local dev (gateway + web app on other origins).
    // PROD MUST lock Access-Control-Allow-Origin to the gateway origin.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

    if ((req.method ?? '').toUpperCase() === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'content-type, accept, mcp-session-id, mcp-protocol-version, authorization',
      );
      res.writeHead(204);
      res.end();
      return;
    }

    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      mcpError(res, 400, -32700, 'malformed request URL');
      return;
    }

    if (pathname === '/health' && (req.method ?? '').toUpperCase() === 'GET') {
      json(res, 200, { ok: true, service: 'mcp-server' });
      return;
    }

    if (pathname !== mcpPath) {
      json(res, 404, { ok: false, error: 'not found' });
      return;
    }

    handleMcp(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        mcpError(res, 500, -32603, err instanceof Error ? err.message : String(err));
      } else {
        res.end();
      }
    });
  };
}

/**
 * Start the listener on a port. Returns the node http.Server (close it to
 * shut down). Binds 127.0.0.1 by default — this is MCP's own direct
 * ingress, NOT behind the API gateway; the bin passes HOST through
 * (Cloud Run sets HOST=0.0.0.0 for its startup probes) — expose wider
 * only with requireAuth + a real secret (MCP_AUTH_SECRET).
 */
export function startMcpHttp(
  port: number,
  opts: McpHttpOptions = {},
  host = '127.0.0.1',
): http.Server {
  const server = http.createServer(createMcpHttpListener(opts));
  server.listen(port, host);
  return server;
}
