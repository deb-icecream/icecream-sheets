/**
 * Login-server extension tests (Issue #78): URL-selected page variants
 * and the exact-match JSON routes that carry the system-browser
 * sign-in's return path. The base server behavior (page on the
 * localhost origin, 404s, idempotent close) is pinned in
 * login-server.test.ts; this file pins only what #78 added.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  asRecord,
  readRequestJson,
  startLoginServer,
  type LoginServer,
} from '../src/login-server.js';

describe('startLoginServer — #78 extensions', () => {
  let server: LoginServer | null = null;
  afterEach(async () => {
    if (server) await server.close();
    server = null;
  });

  it('serves the page variant selected by the request URL (flow nonce → browser page)', async () => {
    server = await startLoginServer((url) =>
      url.searchParams.get('flow') === 'nonce-123' ? 'BROWSER PAGE' : 'EMBEDDED PAGE',
    );
    const base = server.url.replace(/\/login$/, '');
    expect(await (await fetch(`${base}/login`)).text()).toBe('EMBEDDED PAGE');
    expect(await (await fetch(`${base}/login?flow=nonce-123`)).text()).toBe('BROWSER PAGE');
    expect(await (await fetch(`${base}/login?flow=other`)).text()).toBe('EMBEDDED PAGE');
  });

  it('a plain string page is served unchanged, query or not', async () => {
    server = await startLoginServer('<html>fixed</html>');
    const res = await fetch(`${server.url}?flow=whatever`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>fixed</html>');
  });

  it('dispatches exact "METHOD /path" routes with JSON in/out', async () => {
    const seen: unknown[] = [];
    server = await startLoginServer('<html></html>', {
      routes: {
        'POST /auth/complete': async (req, respond) => {
          const body = asRecord(await readRequestJson(req));
          seen.push(body);
          respond(200, { ok: true, echo: body['idToken'] ?? null });
        },
      },
    });
    const base = server.url.replace(/\/login$/, '');
    const res = await fetch(`${base}/auth/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flow: 'n', idToken: 'a.b.c' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, echo: 'a.b.c' });
    expect(seen).toEqual([{ flow: 'n', idToken: 'a.b.c' }]);

    // Wrong method and unknown paths still 404.
    expect((await fetch(`${base}/auth/complete`)).status).toBe(404);
    expect((await fetch(`${base}/auth/nope`, { method: 'POST' })).status).toBe(404);
  });

  it('a throwing route answers 500 JSON instead of hanging the request', async () => {
    server = await startLoginServer('<html></html>', {
      routes: {
        'POST /boom': () => {
          throw new Error('kaboom');
        },
      },
    });
    const base = server.url.replace(/\/login$/, '');
    const res = await fetch(`${base}/boom`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'internal error' });
  });

  it('readRequestJson rejects a malformed body; asRecord narrows non-objects to {}', async () => {
    server = await startLoginServer('<html></html>', {
      routes: {
        'POST /echo': async (req, respond) => {
          try {
            respond(200, asRecord(await readRequestJson(req)));
          } catch {
            respond(400, { ok: false });
          }
        },
      },
    });
    const base = server.url.replace(/\/login$/, '');
    const bad = await fetch(`${base}/echo`, { method: 'POST', body: 'not json' });
    expect(bad.status).toBe(400);
    const arr = await fetch(`${base}/echo`, { method: 'POST', body: '[1,2]' });
    expect(await arr.json()).toEqual({});
  });
});
