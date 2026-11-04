/**
 * Loopback login-page server tests (Cycle 9: desktop login).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startLoginServer, type LoginServer } from '../src/login-server.js';

describe('startLoginServer', () => {
  let server: LoginServer | null = null;
  afterEach(async () => {
    if (server) await server.close();
    server = null;
  });

  it('serves the page on the localhost origin (issue #53; socket stays loopback)', async () => {
    server = await startLoginServer('<html><body>login</body></html>');
    // Firebase's Authorized domains contains localhost, not 127.0.0.1:
    // the page's ORIGIN must be localhost even though the socket binds
    // 127.0.0.1 (localhost resolves to the same loopback socket).
    expect(server.url).toMatch(/^http:\/\/localhost:\d+\/login$/);
    const res = await fetch(server.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('login');
    // Security headers: never framed, never cached.
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('404s everything else', async () => {
    server = await startLoginServer('<html></html>');
    const base = server.url.replace(/\/login$/, '');
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });

  it('close() is idempotent', async () => {
    server = await startLoginServer('<html></html>');
    await server.close();
    await server.close();
  });
});
