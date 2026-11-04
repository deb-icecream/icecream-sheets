/**
 * Combined service-package runner: all five service surfaces answer on
 * ONE port under their /api/<name> prefixes (and the '/<name>' form the
 * gateway's '/api' route delivers), on the same listeners the separate
 * local bins serve.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServicePackageListener } from '../src/services/servicePackage.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

describe('service package (combined runner)', () => {
  let svc: Started | null = null;
  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });

  async function setup(): Promise<void> {
    svc = await startServer(createServicePackageListener());
  }

  it('root health names the combined service + its surfaces', async () => {
    await setup();
    const r = await httpJson('GET', `${svc!.url}/health`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      ok: true,
      service: 'service-package',
      // 'automation' joined the combined package with the triggers
      // program (the trigger supervisor's surface, /api/automation).
      services: ['vault', 'meta', 'etl', 'agent', 'addons', 'connectors', 'automation'],
    });
  });

  it('routes every prefix to its own surface', async () => {
    await setup();
    for (const name of ['vault', 'meta', 'etl', 'agent', 'addons', 'connectors']) {
      const r = await httpJson('GET', `${svc!.url}/api/${name}/health`);
      expect(r.status, name).toBe(200);
      expect((r.json as { service: string }).service).toBe(name === 'addons' ? 'addons' : name);
    }
    // The '/<name>' form (gateway '/api' route shape) routes identically.
    const bare = await httpJson('GET', `${svc!.url}/vault/health`);
    expect(bare.status).toBe(200);
  });

  it('meta kv round-trips through the prefix; etl /run ≠ addons /run', async () => {
    await setup();
    const put = await httpJson('PUT', `${svc!.url}/api/meta/kv/w17b-key`, {
      headers: { 'x-principal': 'user:alice' },
      body: { value: 'combined' },
    });
    expect(put.status).toBe(200);
    const got = await httpJson('GET', `${svc!.url}/api/meta/kv/w17b-key`, {
      headers: { 'x-principal': 'user:alice' },
    });
    expect((got.json as { value: string }).value).toBe('combined');
    // Both /run surfaces exist under their own prefixes and answer as
    // themselves (a bare-path mount would have collided here).
    const etlRun = await httpJson('POST', `${svc!.url}/api/etl/run`, { body: { recipe: null } });
    expect(etlRun.status).not.toBe(404);
    const addonCatalog = await httpJson('GET', `${svc!.url}/api/addons/catalog`);
    expect(addonCatalog.status).toBe(200);
    expect(Array.isArray((addonCatalog.json as { listings: unknown[] }).listings)).toBe(true);
    const vaultRefs = await httpJson('GET', `${svc!.url}/api/vault/refs`, {
      headers: { 'x-principal': 'user:alice' },
    });
    expect(vaultRefs.status).toBe(200);
    // Unknown surface / path → 404 from the dispatcher itself.
    expect((await httpJson('GET', `${svc!.url}/api/nope/health`)).status).toBe(404);
    expect((await httpJson('GET', `${svc!.url}/other`)).status).toBe(404);
  });
});
