/**
 * Desktop remote-service client (spec d).
 *
 * The desktop ships the engine LOCALLY and works fully offline with it.
 * Services that are NOT part of the local engine — AI Agent host, ETL
 * runner, vault-backed connectors, metadata — live behind the API gateway
 * and require the user to LOG IN:
 *   logged in  → desktop talks to the deployed services via the gateway
 *   logged out → local engine features only; remote calls fail closed
 *
 * The JWT is encrypted with Electron safeStorage and kept in the main
 * process; the renderer never sees it (it calls svc:call via IPC).
 */
import { app, safeStorage } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { callLocalMcpTool } from './mcp';
import { loadGatewayUrl } from './gateway-config';

/**
 * Gateway base URL: ICECREAM_GATEWAY_URL env override, else a
 * <userData>/gateway.config.json override, else the bundled
 * PRODUCTION gateway (issue #85 — see ./gateway-config). An override
 * that is set but invalid throws GatewayConfigError (fail closed);
 * there is no localhost fallback, so a packaged build with no
 * overrides reaches the deployed service. Resolved per call, like
 * the env read it replaces.
 */
export function gatewayUrl(): string {
  return loadGatewayUrl({ userDataPath: app.getPath('userData') });
}

function tokenPath(): string {
  return path.join(app.getPath('userData'), 'gateway-token.bin');
}

function decodeSub(token: string): string | null {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64').toString('utf8'),
    ) as { sub?: string };
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/**
 * Load the stored gateway JWT (Cycle 9: shared by the local-dev userId
 * login AND the Firebase Google login — one token, one storage path).
 * Exported for the Firebase exchange in ./firebase-auth.
 */
export function loadToken(): string | null {
  try {
    const p = tokenPath();
    if (!fs.existsSync(p)) return null;
    const encrypted = fs.readFileSync(p);
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(encrypted);
  } catch {
    return null;
  }
}

/** Persist the gateway JWT, encrypted. Exported for ./firebase-auth. */
export function saveToken(token: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('secure storage is not available on this machine');
  }
  fs.writeFileSync(tokenPath(), safeStorage.encryptString(token), { mode: 0o600 });
}

/** Drop the stored gateway JWT. Exported for ./firebase-auth. */
export function clearToken(): void {
  try {
    fs.unlinkSync(tokenPath());
  } catch {
    // Already gone — fine.
  }
}

export interface AuthStatus {
  loggedIn: boolean;
  principal: string | null;
}

/**
 * Session-loss hook (#101/#102: a dead token must never desync the app).
 *
 * serviceCall() clears the stored token when the gateway answers 401 —
 * but the token file is only ONE of the session's truths. Left alone,
 * the auth state machine still says 'logged-in', the native menu still
 * shows 'Signed in as …', and openLoginWindow() early-returns on the
 * still-logged-in phase, so the user can neither use the session nor
 * sign in again. The main process registers a handler here (machine
 * logout + menu rebuild; the renderer learns via the existing
 * auth:changed subscription) so a 401 drives the SAME full signed-out
 * transition as an explicit sign-out. The hook never throws into the
 * call path: a failing handler is logged, never surfaced.
 */
type SessionLostHandler = () => void;
let sessionLostHandler: SessionLostHandler | null = null;

export function setSessionLostHandler(handler: SessionLostHandler | null): void {
  sessionLostHandler = handler;
}

function notifySessionLost(): void {
  if (!sessionLostHandler) return;
  try {
    sessionLostHandler();
  } catch {
    // Session hygiene must never break the caller's error path.
  }
}

/** Log in against the gateway (local-dev /auth/login; prod uses the real IdP). */
export async function login(userId: string): Promise<AuthStatus> {
  const id = userId.trim();
  if (!id) throw new Error('user id is required');
  const res = await fetch(`${gatewayUrl()}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: id }),
  });
  if (!res.ok) throw new Error(`login failed: gateway returned ${res.status}`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error('login returned no token');
  saveToken(body.token);
  return status();
}

/** Log out: drop the stored token. */
export function logout(): void {
  clearToken();
}

/** Current auth status (principal decoded from the JWT; gateway verifies). */
export function status(): AuthStatus {
  const token = loadToken();
  if (!token) return { loggedIn: false, principal: null };
  return { loggedIn: true, principal: decodeSub(token) };
}

export type RemoteService = 'agent' | 'etl' | 'vault' | 'meta' | 'mcp' | 'engine' | 'gateway';

/**
 * Call a remote service.
 *
 * 'mcp' is NOT gateway-routed: the gateway deliberately has no /api/mcp
 * route (user's deployment ruling — MCP is its own direct ingress). MCP
 * calls go straight to the desktop's own MCP ingress at desktopMcpUrl()
 * (design-docs/platform-shell.md §8), sharing the local EngineHost. Like
 * the local engine itself, MCP works offline and never requires login.
 *
 * Every other service lives behind the API gateway and fails closed when
 * logged out (spec d: logged-out desktop = local engine features only).
 */
export async function serviceCall(
  service: RemoteService,
  path: string,
  method: string,
  body?: unknown,
): Promise<unknown> {
  if (service === 'gateway') {
    // Gateway-NATIVE routes (stream 1, Workspace-in-desktop): /api/files,
    // /api/settings, /api/account and the engine handshake live on the
    // gateway itself, not behind a service-family prefix, so the path
    // arrives whole ("/api/files..."). Unlike the service-family calls
    // above, this returns a { status, body } ENVELOPE instead of throwing
    // on HTTP errors: the renderer's GatewayClient reproduces its fetch
    // semantics (401/429/verbatim error bodies — the Workspace surfaces
    // server cap errors verbatim) from the envelope. Only transport
    // failures and a missing login throw, exactly like the other calls.
    const token = loadToken();
    if (!token) {
      throw new Error(
        'Not signed in. Remote services (AI agent, ETL, vault) require login — use Account → Sign in.',
      );
    }
    if (!path.startsWith('/api/')) {
      throw new Error(`gateway: path must start with /api/ (got "${path}")`);
    }
    const res = await fetch(`${gatewayUrl()}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
      // Same session hygiene as the service-family path: a dead token is
      // dropped so status() reports signed-out and the user can re-login.
      // #101/#102: dropping the file alone desyncs the app (machine +
      // menu still claim signed-in, sign-in button dead) — drive the
      // full signed-out transition too.
      clearToken();
      notifySessionLost();
    }
    const text = await res.text().catch(() => '');
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      // Non-JSON body — the envelope carries the raw text.
    }
    return { status: res.status, body: parsed };
  }
  if (service === 'mcp') {
    const m = method.toUpperCase();
    if (m !== 'POST' && m !== 'CALL') {
      throw new Error(
        `mcp: unsupported method "${method}" — pass the tool name as path with method POST`,
      );
    }
    return callLocalMcpTool(path, body);
  }
  const token = loadToken();
  if (!token) {
    throw new Error(
      'Not signed in. Remote services (AI agent, ETL, vault) require login — use Account → Sign in.',
    );
  }
  const clean = path.startsWith('/') ? path : `/${path}`;
  const res = await fetch(`${gatewayUrl()}/api/${service}${clean}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    clearToken();
    // #101/#102: see the gateway-path 401 above — the machine + menu
    // must follow the token, or the app desyncs into a dead session.
    notifySessionLost();
    throw new Error('Session expired — please sign in again (Account → Sign in).');
  }
  if (res.status === 429) throw new Error('Rate limited by the gateway — try again shortly.');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`service ${service} returned ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as unknown;
}
