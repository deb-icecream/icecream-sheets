import { afterEach, describe, expect, it } from 'vitest';
import { issueToken, verifyToken } from '@icecream-sheets/service';
import {
  createGateway,
  serviceCombinedEnabled,
  type GatewayListener,
} from '../src/gateway.js';
import { httpJson, startEchoBackend, startServer, stop, type EchoBackend, type Started } from './helpers.js';

const SECRET = 'test-gateway-secret';

describe('gateway auth', () => {
  let gateway: Started | null = null;
  let backend: EchoBackend | null = null;
  let listener: GatewayListener | null = null;

  async function setup(rateLimit = { points: 1000, perSeconds: 60 }) {
    backend = await startEchoBackend();
    listener = createGateway({
      devLoginEnabled: true,
      authSecret: SECRET,
      routes: { '/api/echo': backend.url },
      rateLimit,
    });
    gateway = await startServer(listener);
  }

  afterEach(async () => {
    if (gateway) await stop(gateway);
    if (backend) await stop(backend);
    gateway = null;
    backend = null;
    listener = null;
  });

  async function login(userId = 'alice'): Promise<string> {
    const r = await httpJson('POST', `${gateway!.url}/auth/login`, { body: { userId } });
    expect(r.status).toBe(200);
    const json = r.json as { token: string };
    expect(typeof json.token).toBe('string');
    return json.token;
  }

  it('POST /auth/login issues a JWT verifiable with the gateway secret', async () => {
    await setup();
    const token = await login('alice');
    const claims = await verifyToken(token, SECRET);
    expect(claims.userId).toBe('alice');
    expect(claims.exp).toBeGreaterThan(claims.iat);
  });

  it('rejects empty / illegal userIds on login', async () => {
    await setup();
    for (const bad of ['', 'a:b', 'a b']) {
      const r = await httpJson('POST', `${gateway!.url}/auth/login`, { body: { userId: bad } });
      expect(r.status).toBe(400);
    }
  });

  it('GET /auth/me returns the verified claims', async () => {
    await setup();
    const token = await login('bob');
    const r = await httpJson('GET', `${gateway!.url}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(200);
    const json = r.json as { userId: string; principal: string };
    expect(json.userId).toBe('bob');
    expect(json.principal).toBe('user:bob');
  });

  it('401 without a token', async () => {
    await setup();
    const r = await httpJson('GET', `${gateway!.url}/api/echo/health`);
    expect(r.status).toBe(401);
  });

  it('401 with a malformed token', async () => {
    await setup();
    const r = await httpJson('GET', `${gateway!.url}/api/echo/health`, {
      headers: { Authorization: 'Bearer not.a.token' },
    });
    expect(r.status).toBe(401);
  });

  it('401 with a token signed by a different secret', async () => {
    await setup();
    const forged = await issueToken({ userId: 'mallory', secret: 'wrong-secret', ttlSeconds: 3600 });
    const r = await httpJson('GET', `${gateway!.url}/api/echo/health`, {
      headers: { Authorization: `Bearer ${forged}` },
    });
    expect(r.status).toBe(401);
  });

  it('proxies with x-principal forwarded and the /api/<name> prefix stripped', async () => {
    await setup();
    const token = await login('carol');
    const r = await httpJson('POST', `${gateway!.url}/api/echo/some/path?q=1`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { hello: 'world' },
    });
    expect(r.status).toBe(200);
    expect(backend!.last).not.toBeNull();
    expect(backend!.last!.url).toBe('/some/path?q=1'); // prefix stripped, query kept
    expect(backend!.last!.method).toBe('POST');
    expect(backend!.last!.headers['x-principal']).toBe('user:carol');
    // The original Authorization header is passed through too.
    expect(backend!.last!.headers['authorization']).toBe(`Bearer ${token}`);
    expect(JSON.parse(backend!.last!.body)).toEqual({ hello: 'world' });
  });

  it('429 with Retry-After when the per-principal limit is exceeded', async () => {
    await setup({ points: 2, perSeconds: 60 });
    const token = await login('dave');
    const headers = { Authorization: `Bearer ${token}` };
    expect((await httpJson('GET', `${gateway!.url}/api/echo/a`, { headers })).status).toBe(200);
    expect((await httpJson('GET', `${gateway!.url}/api/echo/a`, { headers })).status).toBe(200);
    const r = await httpJson('GET', `${gateway!.url}/api/echo/a`, { headers });
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBeDefined();
    // A different principal still has budget (per-principal isolation).
    const other = await login('erin');
    const ok = await httpJson('GET', `${gateway!.url}/api/echo/a`, {
      headers: { Authorization: `Bearer ${other}` },
    });
    expect(ok.status).toBe(200);
  });

  it('records an audit entry per request', async () => {
    await setup();
    const token = await login('frank');
    await httpJson('GET', `${gateway!.url}/api/echo/x`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const entries = listener!.auditLog;
    const last = entries[entries.length - 1];
    expect(last.method).toBe('GET');
    expect(last.path).toBe('/api/echo/x');
    expect(last.principal).toBe('user:frank');
    expect(last.status).toBe(200);
    expect(typeof last.durationMs).toBe('number');
  });
});

describe('gateway proxy failures', () => {
  it('502 when the backend is down', async () => {
    // Reserve a port, then close it so nothing listens there.
    const doomed = await startServer((_req, res) => res.end());
    const deadPort = doomed.port;
    await stop(doomed);

    const listener = createGateway({
      devLoginEnabled: true,
      authSecret: SECRET,
      routes: { '/api/gone': `http://127.0.0.1:${deadPort}` },
      rateLimit: { points: 1000, perSeconds: 60 },
    });
    const gateway = await startServer(listener);
    try {
      const login = await httpJson('POST', `${gateway.url}/auth/login`, { body: { userId: 'gail' } });
      const token = (login.json as { token: string }).token;
      const r = await httpJson('GET', `${gateway.url}/api/gone/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(r.status).toBe(502);
      expect((r.json as { error: string }).error).toMatch(/backend unavailable/);
    } finally {
      await stop(gateway);
    }
  });

  it('404 when no route matches', async () => {
    const listener = createGateway({
      devLoginEnabled: true,
      authSecret: SECRET,
      routes: {},
      rateLimit: { points: 1000, perSeconds: 60 },
    });
    const gateway = await startServer(listener);
    try {
      const login = await httpJson('POST', `${gateway.url}/auth/login`, { body: { userId: 'henry' } });
      const token = (login.json as { token: string }).token;
      const r = await httpJson('GET', `${gateway.url}/api/nope`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(r.status).toBe(404);
    } finally {
      await stop(gateway);
    }
  });
});

describe('gateway engine-load body cap (Cycle 10, Phase 2)', () => {
  it('forwards >1MB bodies only on /api/engine/load; other routes stay fail-closed at 1MB', async () => {
    const backend = await startEchoBackend();
    const listener = createGateway({
      devLoginEnabled: true,
      authSecret: SECRET,
      routes: { '/api/engine': backend.url, '/api/echo': backend.url },
      rateLimit: { points: 1000, perSeconds: 60 },
    });
    const gateway = await startServer(listener);
    try {
      const login = await httpJson('POST', `${gateway.url}/auth/login`, { body: { userId: 'ivy' } });
      const token = (login.json as { token: string }).token;
      const auth = { Authorization: `Bearer ${token}` };
      // 1.7MB base64 payload — the P75 fixture's /load body shape.
      const big = { format: 'xlsx', data: 'A'.repeat(1_700_000) };
      const load = await httpJson('POST', `${gateway.url}/api/engine/load`, { headers: auth, body: big });
      expect(load.status).toBe(200); // reached the backend (echo), not 413
      expect((backend.last?.body ?? '').length).toBeGreaterThan(1_700_000);
      // Same size on a non-load route: the 1MB cap still fails closed.
      const other = await httpJson('POST', `${gateway.url}/api/echo`, { headers: auth, body: big });
      expect(other.status).toBe(413);
    } finally {
      await stop(gateway);
      await stop(backend);
    }
  });

  it('addons route proxies /api/addons/* with auth + principal (closure item 6)', async () => {
    const backend = await startEchoBackend();
    const listener = createGateway({
      devLoginEnabled: true,
      authSecret: SECRET,
      // Mirrors the route table in src/bin/gateway.ts (and startAllLocal).
      routes: { '/api/addons': backend.url },
      rateLimit: { points: 1000, perSeconds: 60 },
    });
    const gateway = await startServer(listener);
    try {
      // Unauthenticated catalog calls fail closed at the gateway.
      const anon = await httpJson('GET', `${gateway.url}/api/addons/catalog`);
      expect(anon.status).toBe(401);
      const login = await httpJson('POST', `${gateway.url}/auth/login`, { body: { userId: 'kate' } });
      const token = (login.json as { token: string }).token;
      const auth = { Authorization: `Bearer ${token}` };
      const cat = await httpJson('GET', `${gateway.url}/api/addons/catalog`, { headers: auth });
      expect(cat.status).toBe(200); // reached the backend, not gateway 404
      expect(backend.last!.url).toBe('/catalog'); // prefix stripped
      expect(backend.last!.headers['x-principal']).toBe('user:kate');
      // Sibling addons routes ride the same prefix.
      const inst = await httpJson('POST', `${gateway.url}/api/addons/install`, {
        headers: auth,
        body: { id: 'demo' },
      });
      expect(inst.status).toBe(200);
      expect(backend.last!.url).toBe('/install');
    } finally {
      await stop(gateway);
      await stop(backend);
    }
  });

  it('engine download route accepts >1MB session-extras bodies (defect 2c)', async () => {
    const backend = await startEchoBackend();
    const listener = createGateway({
      devLoginEnabled: true,
      authSecret: SECRET,
      routes: { '/api/engine': backend.url },
      rateLimit: { points: 1000, perSeconds: 60 },
    });
    const gateway = await startServer(listener);
    try {
      const login = await httpJson('POST', `${gateway.url}/auth/login`, { body: { userId: 'judy' } });
      const token = (login.json as { token: string }).token;
      const auth = { Authorization: `Bearer ${token}` };
      const big = { format: 'xlsx', extraMetadata: { blob: 'A'.repeat(1_700_000) } };
      const dl = await httpJson('POST', `${gateway.url}/api/engine/download`, { headers: auth, body: big });
      expect(dl.status).toBe(200); // reached the backend (echo), not 413
      expect((backend.last?.body ?? '').length).toBeGreaterThan(1_700_000);
    } finally {
      await stop(gateway);
      await stop(backend);
    }
  });
});

describe('gateway SERVICE_COMBINED proxy mode (W19)', () => {
  const FAMILY_ROUTES = {
    '/api/vault': '',
    '/api/meta': '',
    '/api/etl': '',
    '/api/agent': '',
    '/api/addons': '',
    '/api/engine': '',
    '/api/echo': '',
  };

  async function setup(serviceCombined: boolean | undefined) {
    const backend = await startEchoBackend();
    const routes: Record<string, string> = {};
    for (const p of Object.keys(FAMILY_ROUTES)) routes[p] = backend.url;
    const listener = createGateway({
      devLoginEnabled: true,
      authSecret: SECRET,
      routes,
      rateLimit: { points: 1000, perSeconds: 60 },
      ...(serviceCombined === undefined ? {} : { serviceCombined }),
    });
    const gateway = await startServer(listener);
    const login = await httpJson('POST', `${gateway.url}/auth/login`, { body: { userId: 'w19' } });
    const token = (login.json as { token: string }).token;
    return { backend, gateway, auth: { Authorization: `Bearer ${token}` } };
  }

  it('default (flag absent): service-family prefixes are stripped, exactly as before', async () => {
    const { backend, gateway, auth } = await setup(undefined);
    try {
      for (const [call, forwarded] of [
        ['/api/vault/store', '/store'],
        ['/api/meta/kv/k1', '/kv/k1'],
        ['/api/etl/run', '/run'],
        ['/api/agent/threads', '/threads'],
        ['/api/addons/run', '/run'],
      ] as const) {
        const r = await httpJson('POST', `${gateway.url}${call}`, { headers: auth, body: {} });
        expect(r.status, call).toBe(200);
        expect(backend.last!.url, call).toBe(forwarded);
      }
    } finally {
      await stop(gateway);
      await stop(backend);
    }
  });

  it('explicit false: same strip behavior as the default', async () => {
    const { backend, gateway, auth } = await setup(false);
    try {
      const r = await httpJson('POST', `${gateway.url}/api/vault/store`, { headers: auth, body: {} });
      expect(r.status).toBe(200);
      expect(backend.last!.url).toBe('/store');
    } finally {
      await stop(gateway);
      await stop(backend);
    }
  });

  it('flag ON: full /api/<name> path (and query) preserved for all five service-family routes', async () => {
    const { backend, gateway, auth } = await setup(true);
    try {
      for (const call of [
        '/api/vault/store?q=1',
        '/api/meta/kv/k1',
        // The collision pair: etl and addons both serve a bare POST /run —
        // only the preserved prefix can tell the combined runner apart.
        '/api/etl/run',
        '/api/addons/run',
        '/api/agent/threads',
      ]) {
        const r = await httpJson('POST', `${gateway.url}${call}`, { headers: auth, body: {} });
        expect(r.status, call).toBe(200);
        expect(backend.last!.url, call).toBe(call);
        expect(backend.last!.headers['x-principal']).toBe('user:w19');
      }
    } finally {
      await stop(gateway);
      await stop(backend);
    }
  });

  it('flag ON: non-service-family routes still strip (engine + arbitrary routes untouched)', async () => {
    const { backend, gateway, auth } = await setup(true);
    try {
      const eng = await httpJson('POST', `${gateway.url}/api/engine/load`, { headers: auth, body: {} });
      expect(eng.status).toBe(200);
      expect(backend.last!.url).toBe('/load');
      const echo = await httpJson('GET', `${gateway.url}/api/echo/some/path`, { headers: auth });
      expect(echo.status).toBe(200);
      expect(backend.last!.url).toBe('/some/path');
    } finally {
      await stop(gateway);
      await stop(backend);
    }
  });

  it('serviceCombinedEnabled: on/true/1 enable; unset/off/anything else is OFF', () => {
    expect(serviceCombinedEnabled({ SERVICE_COMBINED: 'on' })).toBe(true);
    expect(serviceCombinedEnabled({ SERVICE_COMBINED: ' ON ' })).toBe(true);
    expect(serviceCombinedEnabled({ SERVICE_COMBINED: 'true' })).toBe(true);
    expect(serviceCombinedEnabled({ SERVICE_COMBINED: '1' })).toBe(true);
    expect(serviceCombinedEnabled({})).toBe(false);
    expect(serviceCombinedEnabled({ SERVICE_COMBINED: 'off' })).toBe(false);
    expect(serviceCombinedEnabled({ SERVICE_COMBINED: 'yes' })).toBe(false);
    expect(serviceCombinedEnabled({ SERVICE_COMBINED: '' })).toBe(false);
  });
});
