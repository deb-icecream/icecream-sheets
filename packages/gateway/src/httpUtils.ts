/**
 * Minimal HTTP helpers for the gateway and services (node:http only).
 *
 * - readBody: buffers the request body with a 1MB cap (fail closed on
 *   oversize bodies — 413).
 * - sendJson: JSON response with CORS headers.
 * - applyCors / handlePreflight: permissive CORS for local dev. Production
 *   (Firebase Hosting) serves the app from the same origin as the gateway
 *   or narrows these origins at the edge.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/** Max JSON request body: 1MB. */
export const MAX_BODY_BYTES = 1024 * 1024;

export interface BodyTooLargeError extends Error {
  code: 'BODY_TOO_LARGE';
}

/**
 * Read and parse a JSON request body. Returns undefined when there is no
 * body. Throws { code: 'BODY_TOO_LARGE' } over the cap, or a SyntaxError
 * on malformed JSON. `maxBytes` overrides the default cap for endpoints
 * whose payloads are whole files (engine-service /load, Cycle 10).
 */
export async function readBody(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf: Buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    total += buf.length;
    if (total > maxBytes) {
      const err = new Error(`request body exceeds ${maxBytes} bytes`) as BodyTooLargeError;
      err.code = 'BODY_TOO_LARGE';
      // Drain the socket so the connection stays usable.
      req.resume();
      throw err;
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim().length === 0) return undefined;
  return JSON.parse(text);
}

export function applyCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-principal');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/** Returns true when the request was an OPTIONS preflight (already answered). */
export function handlePreflight(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === 'OPTIONS') {
    applyCors(res);
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

export function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  applyCors(res);
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** Error envelope used by every service. */
export function sendError(res: ServerResponse, status: number, error: string, extra?: Record<string, unknown>): void {
  sendJson(res, status, { ok: false, error, ...(extra ?? {}) });
}

/** Pull the x-principal header (set by the gateway from the verified JWT). */
export function requestPrincipal(req: IncomingMessage, fallback = 'user'): string {
  const h = req.headers['x-principal'];
  if (typeof h === 'string' && h.length > 0) return h;
  return fallback;
}

/** Bare token from an Authorization header, or null. */
export function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers['authorization'];
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1] : null;
}
