/**
 * Localhost login-page server (Cycle 9: Firebase Google login — desktop).
 *
 * The dedicated login BrowserWindow needs a REAL origin for Firebase's
 * Google sign-in popup flow (the auth handler postMessages the credential
 * back to the opener; opaque origins like data:/file: break that handshake).
 * This module serves the generated login page on a loopback socket with
 * an ephemeral port — loopback only, never exposed to the network, torn
 * down the moment the login window closes.
 *
 * No firewall prompt: binding 127.0.0.1 never leaves the machine.
 *
 * Issue #53: the page is SERVED under the `localhost` origin
 * (http://localhost:<port>/login) while the socket stays bound to
 * 127.0.0.1. Firebase treats the page's origin as the sign-in domain,
 * and the production project's Authorized domains list contains
 * `localhost` (Firebase's own default) but NOT `127.0.0.1` — serving the
 * page as 127.0.0.1 made every clean-install sign-in fail with
 * auth/unauthorized-domain. `localhost` resolves to the same loopback
 * socket; only the origin the page (and Firebase) sees changes.
 *
 * Issue #78: the same server is the RETURN PATH for the system-browser
 * sign-in flow (the account-chooser flow). Two surgical extensions,
 * both opt-in and back-compatible:
 *  - the page may be a function of the request URL, so /login carrying
 *    the flow nonce serves the browser-mode page variant while plain
 *    /login serves the embedded-window variant;
 *  - exact "METHOD /path" routes (JSON in/out) carry the browser page's
 *    /auth/complete and /auth/cancel posts to the flow owner in main.
 * No CORS headers are ever emitted: the only legitimate caller of the
 * routes is the page this server itself served, same-origin.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface LoginServer {
  /** e.g. "http://localhost:51234/login". */
  url: string;
  /** Stop the server. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * An extra exact-match route, keyed "METHOD /path" (e.g.
 * "POST /auth/complete"). Receives the request and a JSON responder.
 * Routes are matched BEFORE the 404 fallthrough; the login page itself
 * (GET /login, GET /) always wins over a route key that collides with it.
 */
export type LoginServerRoute = (
  req: http.IncomingMessage,
  respond: (status: number, body: unknown) => void,
) => void | Promise<void>;

export interface LoginServerOptions {
  routes?: Record<string, LoginServerRoute>;
}

/** Read a request body (bounded) and parse it as JSON. Throws on either failure. */
export function readRequestJson(req: http.IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch (err) {
        reject(err instanceof Error ? err : new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrow an unknown JSON body to a plain record ({} for anything else). */
export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * Serve the login page at /login on localhost:<ephemeral> (socket bound
 * to 127.0.0.1). `html` is either the page itself or a function of the
 * request URL returning the variant to serve (#78: embedded vs browser
 * mode). Everything else 404s, except the opt-in routes.
 */
export function startLoginServer(
  html: string | ((url: URL) => string),
  options: LoginServerOptions = {},
): Promise<LoginServer> {
  const routes = options.routes ?? {};
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://localhost');
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('bad request');
        return;
      }
      if (url.pathname === '/login' || url.pathname === '/') {
        const page = typeof html === 'function' ? html(url) : html;
        const body = Buffer.from(page, 'utf8');
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': body.length,
          // The page must not be framed or cached: it carries a login flow.
          'x-frame-options': 'DENY',
          'cache-control': 'no-store',
        });
        res.end(body);
        return;
      }
      const route = routes[`${req.method ?? 'GET'} ${url.pathname}`];
      if (route) {
        const respond = (status: number, body: unknown): void => {
          if (res.writableEnded) return;
          const payload = Buffer.from(JSON.stringify(body ?? {}), 'utf8');
          res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': payload.length,
            'cache-control': 'no-store',
          });
          res.end(payload);
        };
        // Invoke via a promise chain so a SYNCHRONOUS throw from the
        // route lands in the same catch as an async rejection — either
        // way the request is answered, never left hanging.
        void Promise.resolve()
          .then(() => route(req, respond))
          .catch(() => {
            respond(500, { ok: false, error: 'internal error' });
          });
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    });
    server.on('error', reject);
    // Bind 127.0.0.1 only — never 0.0.0.0. The ORIGIN is localhost
    // (issue #53): localhost resolves to this same loopback socket,
    // and it is the host Firebase's Authorized domains contains.
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr || typeof addr.port !== 'number') {
        reject(new Error('login server: could not determine bound port'));
        return;
      }
      let closed = false;
      resolve({
        url: `http://localhost:${addr.port}/login`,
        close: () =>
          new Promise<void>((resClose) => {
            if (closed) {
              resClose();
              return;
            }
            closed = true;
            server.close(() => resClose());
          }),
      });
    });
  });
}
