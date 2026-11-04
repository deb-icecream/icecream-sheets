import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryAddonService } from '@icecream-sheets/service';
import { createAddonListener } from '../src/services/addonSvc.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const ALICE = { 'x-principal': 'user:alice' };
const SUM_REPORTER = 'com.icecream.sample-sum-reporter';
const STAMPER = 'com.icecream.sample-cell-stamper';

describe('add-on service', () => {
  let svc: Started | null = null;
  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });
  async function setup() {
    svc = await startServer(createAddonListener({ service: createMemoryAddonService() }));
  }
  const get = (path: string, headers: Record<string, string> = ALICE) =>
    httpJson('GET', `${svc!.url}${path}`, { headers });
  const post = (path: string, body: unknown, headers: Record<string, string> = ALICE) =>
    httpJson('POST', `${svc!.url}${path}`, { headers, body });

  it('health reports the add-on service', async () => {
    await setup();
    const r = await get('/health');
    expect(r.status).toBe(200);
    expect((r.json as { service: string }).service).toBe('addons');
  });

  it('catalog lists the product-owned catalog (code stripped)', async () => {
    await setup();
    const r = await get('/catalog');
    expect(r.status).toBe(200);
    const listings = (r.json as { listings: unknown[] }).listings;
    expect(listings).toHaveLength(2);
    const ids = listings.map((l) => (l as { manifest: { id: string } }).manifest.id);
    expect(ids).toContain(SUM_REPORTER);
    expect(ids).toContain(STAMPER);
    // Code stays server-side; signatures ship so clients can show provenance.
    for (const l of listings) {
      const rec = l as Record<string, unknown>;
      expect('code' in rec).toBe(false);
      expect((rec.manifest as { signature: string }).signature.startsWith('ed25519:')).toBe(true);
    }
  });

  it('install → enable/disable → uninstall lifecycle', async () => {
    await setup();
    const inst = await post('/install', { id: SUM_REPORTER });
    expect(inst.status).toBe(200);
    expect(((inst.json as { addon: { enabled: boolean } }).addon.enabled)).toBe(true);

    const installed = await get('/installed');
    const addons = (installed.json as { installed: { manifest: { id: string } }[] }).installed;
    expect(addons.map((a) => a.manifest.id)).toContain(SUM_REPORTER);

    const dis = await post('/disable', { id: SUM_REPORTER });
    expect(dis.status).toBe(200);
    expect((dis.json as { addon: { enabled: boolean } }).addon.enabled).toBe(false);
    const en = await post('/enable', { id: SUM_REPORTER });
    expect((en.json as { addon: { enabled: boolean } }).addon.enabled).toBe(true);

    const un = await post('/uninstall', { id: SUM_REPORTER });
    expect(un.status).toBe(200);
    expect((un.json as { removed: boolean }).removed).toBe(true);
    const again = await get('/installed');
    expect((again.json as { installed: unknown[] }).installed).toHaveLength(0);
  });

  it('install rejects unknown ids and bad bodies', async () => {
    await setup();
    expect((await post('/install', { id: 'com.example.nope' })).status).toBe(400);
    expect((await post('/install', {})).status).toBe(400);
    expect((await post('/enable', { id: SUM_REPORTER })).status).toBe(400);
  });

  it('grant flow: request → approve, attributed to the x-principal', async () => {
    await setup();
    await post('/install', { id: SUM_REPORTER });
    const req = await post('/grants/request', {
      addonId: SUM_REPORTER,
      documentId: 'doc1',
      capabilities: [{ kind: 'read' }],
    });
    expect(req.status).toBe(200);
    const grant = (req.json as { grant: Record<string, unknown> }).grant;
    expect(grant.status).toBe('pending');
    expect(grant.requestedBy).toBe('user:alice');

    const approve = await post('/grants/approve', { id: grant.id });
    expect(approve.status).toBe(200);
    const approved = (approve.json as { grant: Record<string, unknown> }).grant;
    expect(approved.status).toBe('active');
    expect(approved.decidedBy).toBe('user:alice');

    // /grants lists with filters.
    const all = (await get('/grants')).json as { grants: { id: string }[] };
    expect(all.grants.map((g) => g.id)).toContain(grant.id);
    const filtered = (await get(`/grants?addonId=${SUM_REPORTER}&documentId=other`)).json as {
      grants: unknown[];
    };
    expect(filtered.grants).toHaveLength(0);
  });

  it('grant flow: deny, narrow, revoke', async () => {
    await setup();
    await post('/install', { id: STAMPER });
    const req1 = (await post('/grants/request', {
      addonId: STAMPER,
      documentId: 'doc1',
      capabilities: [{ kind: 'read' }, { kind: 'write' }],
    })).json as { grant: { id: string } };
    const denied = (await post('/grants/deny', { id: req1.grant.id })).json as {
      grant: { status: string };
    };
    expect(denied.grant.status).toBe('denied');

    const req2 = (await post('/grants/request', {
      addonId: STAMPER,
      documentId: 'doc1',
      capabilities: [{ kind: 'read' }, { kind: 'write' }],
    })).json as { grant: { id: string } };
    await post('/grants/approve', { id: req2.grant.id });
    const narrowed = (await post('/grants/narrow', {
      id: req2.grant.id,
      capabilities: [{ kind: 'read' }],
    })).json as { grant: { capabilities: { kind: string }[] } };
    expect(narrowed.grant.capabilities).toHaveLength(1);
    const revoked = (await post('/grants/revoke', { id: req2.grant.id })).json as {
      grant: { status: string };
    };
    expect(revoked.grant.status).toBe('revoked');
  });

  it('grant requests validate capabilities and bodies', async () => {
    await setup();
    await post('/install', { id: SUM_REPORTER });
    expect(
      (await post('/grants/request', {
        addonId: SUM_REPORTER,
        documentId: 'doc1',
        capabilities: [{ kind: 'teleport' }],
      })).status,
    ).toBe(400);
    expect(
      (await post('/grants/request', { addonId: SUM_REPORTER, documentId: 'doc1' })).status,
    ).toBe(400);
    // Requesting for a non-installed add-on fails closed.
    expect(
      (await post('/grants/request', {
        addonId: 'com.example.nope',
        documentId: 'doc1',
        capabilities: [{ kind: 'read' }],
      })).status,
    ).toBe(400);
  });

  it('run executes the add-on against a seeded binding and returns its value', async () => {
    await setup();
    await post('/install', { id: SUM_REPORTER });
    const g = (await post('/grants/request', {
      addonId: SUM_REPORTER,
      documentId: 'doc1',
      capabilities: [{ kind: 'read' }],
    })).json as { grant: { id: string } };
    await post('/grants/approve', { id: g.grant.id });

    const r = await post('/run', {
      addonId: SUM_REPORTER,
      documentId: 'doc1',
      args: { ref: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 2, endCol: 0 } },
      sheets: { Sheet1: [[1], [2], [3]] },
    });
    expect(r.status).toBe(200);
    expect((r.json as { value: unknown }).value).toEqual({ sum: 6, count: 3 });
  });

  it('run fails closed: no grant → 403, disabled add-on → 400', async () => {
    await setup();
    await post('/install', { id: SUM_REPORTER });
    // No grant: the grant gate denies.
    const noGrant = await post('/run', {
      addonId: SUM_REPORTER,
      documentId: 'doc1',
      sheets: { Sheet1: [[1]] },
    });
    expect(noGrant.status).toBe(403);
    expect((noGrant.json as { code: string }).code).toBe('auth');

    // Grant exists but the add-on is disabled.
    const g = (await post('/grants/request', {
      addonId: SUM_REPORTER,
      documentId: 'doc1',
      capabilities: [{ kind: 'read' }],
    })).json as { grant: { id: string } };
    await post('/grants/approve', { id: g.grant.id });
    await post('/disable', { id: SUM_REPORTER });
    const disabled = await post('/run', { addonId: SUM_REPORTER, documentId: 'doc1' });
    expect(disabled.status).toBe(400);

    // Not installed at all.
    const missing = await post('/run', { addonId: 'com.example.nope', documentId: 'doc1' });
    expect(missing.status).toBe(400);
  });

  it('write capability is enforced: write op without the capability fails the run', async () => {
    await setup();
    await post('/install', { id: STAMPER });
    // Grant read only; the stamper needs write.
    const g = (await post('/grants/request', {
      addonId: STAMPER,
      documentId: 'doc1',
      capabilities: [{ kind: 'read' }],
    })).json as { grant: { id: string } };
    await post('/grants/approve', { id: g.grant.id });
    const r = await post('/run', {
      addonId: STAMPER,
      documentId: 'doc1',
      args: { ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 'x' },
      sheets: { Sheet1: [[null]] },
    });
    expect(r.status).toBe(403);
    expect((r.json as { code: string }).code).toBe('auth');
    expect((r.json as { error: string }).error).toMatch(/write/i);
  });

  it('uninstall purges the add-on’s grants (add-on-model.md §4)', async () => {
    await setup();
    await post('/install', { id: SUM_REPORTER });
    const g = (await post('/grants/request', {
      addonId: SUM_REPORTER,
      documentId: 'doc1',
      capabilities: [{ kind: 'read' }],
    })).json as { grant: { id: string } };
    await post('/grants/approve', { id: g.grant.id });
    const un = await post('/uninstall', { id: SUM_REPORTER });
    expect((un.json as { grantsPurged: number }).grantsPurged).toBe(1);
    const grants = (await get('/grants')).json as { grants: unknown[] };
    expect(grants.grants).toHaveLength(0);
  });

  it('production listener: signed seed-catalog installs pass the production verifier', async () => {
    // Default deps → createProductionAddonService() with the Ed25519
    // install-time verifier always configured (fail closed on unsigned).
    svc = await startServer(createAddonListener());
    const post = (path: string, body: unknown) =>
      httpJson('POST', `${svc!.url}${path}`, { headers: ALICE, body });
    const inst = await post('/install', { id: SUM_REPORTER });
    expect(inst.status).toBe(200);
    const health = await httpJson('GET', `${svc!.url}/health`, { headers: ALICE });
    expect(health.status).toBe(200);
  });
});
