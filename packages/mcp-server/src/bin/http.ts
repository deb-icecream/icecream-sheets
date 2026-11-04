#!/usr/bin/env node
/**
 * Production runner: icecream-sheets MCP over Streamable HTTP.
 *
 * Listens on PORT (default 8106). This is MCP's OWN direct ingress — it is
 * deliberately NOT behind the API gateway (user's deployment ruling): MCP
 * authenticates itself per the MCP spec (Bearer JWT verified with its own
 * secret, see src/http.ts), and enforces its own rate-limit tier, which is
 * much higher than the gateway's. The gateway never sees MCP traffic and
 * never validates MCP users.
 *
 * Posture (enforced by resolveRunnerConfig in ./runner-config.js):
 * auth is ALWAYS enforced — MCP_AUTH_SECRET is required and the runner
 * refuses to start without it — and service metadata persists through a
 * durable Persistence selected by MCP_STORE (local file-backed store by
 * default; 'prod' fails closed until a Firestore adapter for the
 * synchronous Persistence seam exists).
 */
import { startMcpHttp } from '../http.js';
import { resolveRunnerConfig, type RunnerConfig } from './runner-config.js';

const rawPort = process.env.PORT ?? '8106';
const port = Number(rawPort);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`icecream-sheets MCP: invalid PORT "${rawPort}"`);
  process.exit(1);
}

// Resolve (and validate) the runner configuration BEFORE listening:
// on a config error, print the error to stderr and exit 1.
// Top-level await: resolveRunnerConfig is async (the prod branch builds
// the Firestore client); nothing listens until this settles.
let config: RunnerConfig;
try {
  config = await resolveRunnerConfig(process.env);
} catch (err: unknown) {
  console.error(
    `icecream-sheets MCP: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

// HOST env: listen host, default 127.0.0.1 (local dev unchanged).
// Cloud Run sets HOST=0.0.0.0 — its startup probes require listening on
// 0.0.0.0:$PORT. Widening the bind is safe only with MCP's own auth
// (requireAuth + a real MCP_AUTH_SECRET), as startMcpHttp documents.
const host = process.env.HOST ?? '127.0.0.1';
const server = startMcpHttp(
  port,
  {
    requireAuth: config.requireAuth,
    authSecret: config.authSecret,
    persistence: config.persistence,
    asyncPersistence: config.asyncPersistence,
    packs: config.packs,
  },
  host,
);
server.on('listening', () => {
  const addr = server.address();
  const where =
    typeof addr === 'object' && addr !== null ? `${addr.address}:${addr.port}` : String(addr);
  // Log the posture WITHOUT printing the secret.
  console.log(
    `icecream-sheets MCP (streamable HTTP) listening on ${where} — MCP endpoint at /mcp, health at /health — auth: enforced (Bearer, MCP_AUTH_SECRET), store: ${config.store}, dataDir: ${config.dataDir}, packs: ${config.packs ? config.packs.join(',') : 'all bundled'}`,
  );
});
server.on('error', (err: unknown) => {
  console.error('icecream-sheets MCP: server error', err instanceof Error ? err.message : err);
  process.exit(1);
});
