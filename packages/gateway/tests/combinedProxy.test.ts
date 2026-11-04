/**
 * W19 — combined-service proxy fix, end-to-end through a real gateway:
 *
 * (a) flag OFF + per-bin upstreams (today's local topology): the gateway
 *     strips '/api/<name>' and each separate bin listener answers its
 *     bare paths — behavior exactly as before the fix.
 * (b) flag ON + the ONE combined service-package runner as the upstream
 *     for all five service-family routes: the gateway preserves the
 *     full '/api/<name>' path and the combined dispatcher's prefix
 *     routing lands each call on its own surface — including the
 *     collision pair, etl POST /run vs addons POST /run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createGateway } from '../src/gateway.js';
import { createServicePackageListener } from '../src/services/servicePackage.js';
import { createVaultListener } from '../src/services/vaultSvc.js';
import { createEtlListener } from '../src/services/etlSvc.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const SECRET = 'test-w19-secret';

describe('combined-service proxy (W19)', () => {
  const started: Started[] = [];
  afterEach(async () => {
    while (started.length) await stop(started.pop()!);
  });

  async function boot(listener: Parameters<typeof startServer>[0]): Promise<Started> {
    const s = await startServer(listener);
    started.push(s);
    return s;
  }

  async function gatewayWith(routes: Record<string, string>, serviceCombined: boolean): Promise<{ url: string; auth: Record<string, string> }> {
    const gw = await boot(
      createGateway({
        devLoginEnabled: true,
        authSecret: SECRET,
        routes,
        rateLimit: { points: 1000, perSeconds: 60 },
        serviceCombined,
      }),
    );
    const login = await httpJson('POST', `${gw.url}/auth/login`, { body: { userId: 'w19' } });
    expect(login.status).toBe(200);
    const token = (login.json as { token: string }).token;
    return { url: gw.url, auth: { Authorization: `Bearer ${token}` } };
  }

  it('(a) flag OFF + per-bin upstreams: strip → each bin answers its bare paths', async () => {
    const vault = await boot(createVaultListener());
    const etl = await boot(createEtlListener());
    const gw = await gatewayWith(
      { '/api/vault': vault.url, '/api/etl': etl.url },
      false,
    );

    // Vault bin answers the stripped /store (ref must carry the caller's prefix).
    const store = await httpJson('POST', `${gw.url}/api/vault/store`, {
      headers: gw.auth,
      body: { ref: 'user:w19:w19-off', secret: 's3cr3t' },
    });
    expect(store.status).toBe(200);
    expect(store.json).toMatchObject({ ok: true });
    const refs = await httpJson('GET', `${gw.url}/api/vault/refs`, { headers: gw.auth });
    expect(refs.status).toBe(200);
    expect((refs.json as { refs: string[] }).refs).toContain('user:w19:w19-off');

    // ETL bin answers the stripped /run with its own validation error.
    const run = await httpJson('POST', `${gw.url}/api/etl/run`, {
      headers: gw.auth,
      body: { recipe: null },
    });
    expect(run.status).toBe(400);
    expect((run.json as { error: string }).error).toMatch(/recipe/);
  });

  it('(b) flag ON + combined runner: preserved prefix lands each call on its own surface', async () => {
    const combined = await boot(createServicePackageListener());
    const gw = await gatewayWith(
      {
        '/api/vault': combined.url,
        '/api/meta': combined.url,
        '/api/etl': combined.url,
        '/api/agent': combined.url,
        '/api/addons': combined.url,
      },
      true,
    );

    // Vault surface through the preserved prefix (was a 404 before the fix:
    // the gateway stripped to /store, which the dispatcher rejects).
    const store = await httpJson('POST', `${gw.url}/api/vault/store`, {
      headers: gw.auth,
      body: { ref: 'user:w19:w19-on', secret: 's3cr3t' },
    });
    expect(store.status).toBe(200);
    expect(store.json).toMatchObject({ ok: true });
    const vHealth = await httpJson('GET', `${gw.url}/api/vault/health`, { headers: gw.auth });
    expect(vHealth.status).toBe(200);
    expect((vHealth.json as { service: string }).service).toBe('vault');

    // Meta surface: health + a kv round-trip through the prefix.
    const mHealth = await httpJson('GET', `${gw.url}/api/meta/health`, { headers: gw.auth });
    expect(mHealth.status).toBe(200);
    expect((mHealth.json as { service: string }).service).toBe('meta');
    const put = await httpJson('PUT', `${gw.url}/api/meta/kv/w19-key`, {
      headers: gw.auth,
      body: { value: 'combined' },
    });
    expect(put.status).toBe(200);
    const got = await httpJson('GET', `${gw.url}/api/meta/kv/w19-key`, { headers: gw.auth });
    expect((got.json as { value: string }).value).toBe('combined');

    // THE COLLISION PAIR: both surfaces serve a bare POST /run; under the
    // preserved prefix each reaches its OWN surface, proven by their
    // distinct validation errors.
    const etlRun = await httpJson('POST', `${gw.url}/api/etl/run`, {
      headers: gw.auth,
      body: { recipe: null },
    });
    expect(etlRun.status).toBe(400);
    expect((etlRun.json as { error: string }).error).toMatch(/recipe.*EtlRecipe|EtlRecipe.*required/);

    const addonRun = await httpJson('POST', `${gw.url}/api/addons/run`, {
      headers: gw.auth,
      body: {},
    });
    expect(addonRun.status).toBe(400);
    expect((addonRun.json as { error: string }).error).toMatch(/addonId/);

    // Addons surface also answers its own catalog through the prefix.
    const catalog = await httpJson('GET', `${gw.url}/api/addons/catalog`, { headers: gw.auth });
    expect(catalog.status).toBe(200);
    expect(Array.isArray((catalog.json as { listings: unknown[] }).listings)).toBe(true);

    // Agent surface health through the prefix.
    const aHealth = await httpJson('GET', `${gw.url}/api/agent/health`, { headers: gw.auth });
    expect(aHealth.status).toBe(200);
    expect((aHealth.json as { service: string }).service).toBe('agent');
  });

  it('(b-proof of the defect) flag OFF + combined runner upstream: stripped path 404s at the dispatcher', async () => {
    const combined = await boot(createServicePackageListener());
    const gw = await gatewayWith({ '/api/vault': combined.url }, false);
    // Stripped to bare /store, which the prefix dispatcher 404s — the
    // exact production defect this fix removes when the flag is on.
    const store = await httpJson('POST', `${gw.url}/api/vault/store`, {
      headers: gw.auth,
      body: { ref: 'user:w19:w19-off-combined', secret: 'x' },
    });
    expect(store.status).toBe(404);
  });
});
