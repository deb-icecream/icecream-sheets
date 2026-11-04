/**
 * Production document binding for /run (add-on-model.md §5):
 * install add-on → grant → run against the engine service's OPEN workbook
 * → the add-on reads REAL cell values (not a seeded grid), writes land in
 * the real workbook, and per-principal permission checks (hidden cells)
 * are enforced through authorize().
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryAddonService } from '@icecream-sheets/service';
import { XlsxAdapter } from '@icecream-sheets/xlsx-adapter';
import { createAddonListener } from '../src/services/addonSvc.js';
import { createEngineListener } from '../src/services/engineSvc.js';
import {
  createDelegatingAddonAuthorizer,
  createEngineServiceBinding,
  createProductionAddonResolveBinding,
} from '../src/services/addonEngineBinding.js';
import { issueEngineAccessToken } from '../src/deploy/engineAccess.js';
import {
  MemoryFileRegistry,
  type FileRegistryRecord,
} from '../src/deploy/fileRegistry.js';
import { MemorySessionStores } from '../src/deploy/sessionStore.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const ALICE = { 'x-principal': 'user:alice' };
const SUM_REPORTER = 'com.icecream.sample-sum-reporter';
const STAMPER = 'com.icecream.sample-cell-stamper';
const DOC = 'workbook-1';

describe('add-on /run production document binding', () => {
  let engine: Started | null = null;
  let addons: Started | null = null;
  afterEach(async () => {
    if (addons) await stop(addons);
    if (engine) await stop(engine);
    engine = addons = null;
  });

  async function setup() {
    engine = await startServer(createEngineListener());
    addons = await startServer(
      createAddonListener({
        service: createMemoryAddonService(),
        authorizer: createDelegatingAddonAuthorizer(),
        // Production wiring: resolve every /run against the engine
        // service's open workbook (add-on-model.md §5).
        resolveBinding: (documentId, reqCtx) =>
          createEngineServiceBinding({
            engineBaseUrl: engine!.url,
            documentId,
            principal: reqCtx.principal,
            authorization: reqCtx.authorization,
          }),
      }),
    );
  }

  const engPost = (path: string, body: unknown, headers: Record<string, string> = ALICE) =>
    httpJson('POST', `${engine!.url}${path}`, { headers, body });
  const post = (path: string, body: unknown, headers: Record<string, string> = ALICE) =>
    httpJson('POST', `${addons!.url}${path}`, { headers, body });

  /** Write values into the engine's open workbook (Sheet1 A1, A2, ...). */
  async function seedEngine(values: (string | number | boolean | null)[]) {
    for (let i = 0; i < values.length; i++) {
      const r = await engPost('/execute', {
        cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: i, col: 0 }, value: values[i] },
      });
      expect(r.status).toBe(200);
      expect((r.json as { ok: boolean }).ok).toBe(true);
    }
  }

  async function engineCell(row: number, col = 0): Promise<unknown> {
    const r = await engPost('/read', {
      kind: 'cell',
      ref: { sheet: 'Sheet1', row, col },
    });
    expect(r.status).toBe(200);
    const v = (r.json as { value: { kind: string; value?: unknown } }).value;
    return v.kind === 'error' ? { error: (v as { code: string }).code } : v.value;
  }

  /** Install + request + approve a grant for (addon, DOC). */
  async function installAndGrant(addonId: string, capabilities: { kind: string }[]) {
    expect((await post('/install', { id: addonId })).status).toBe(200);
    const req = await post('/grants/request', {
      addonId,
      documentId: DOC,
      capabilities,
    });
    expect(req.status).toBe(200);
    const grantId = (req.json as { grant: { id: string } }).grant.id;
    const appr = await post('/grants/approve', { id: grantId });
    expect(appr.status).toBe(200);
  }

  it('runs the add-on against real workbook data (not a seeded grid)', async () => {
    await setup();
    // Real data in the engine's open workbook: A1=10, A2=20, A3=30.
    await seedEngine([10, 20, 30]);
    await installAndGrant(SUM_REPORTER, [{ kind: 'read' }]);

    const run = await post('/run', {
      addonId: SUM_REPORTER,
      documentId: DOC,
      args: { ref: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 2, endCol: 0 } },
    });
    expect(run.status).toBe(200);
    // The seeded-grid default would have been 0/0; real data sums to 60.
    expect(run.json).toEqual({ ok: true, value: { sum: 60, count: 3 } });
  });

  it('writes land in the real workbook through authorize()', async () => {
    await setup();
    await seedEngine(['before']);
    await installAndGrant(STAMPER, [{ kind: 'read' }, { kind: 'write' }]);

    const run = await post('/run', {
      addonId: STAMPER,
      documentId: DOC,
      args: { ref: { sheet: 'Sheet1', row: 1, col: 0 }, value: 'stamped' },
    });
    expect(run.status).toBe(200);
    expect((run.json as { value: { before: unknown } }).value.before).toBe(null);

    // The write hit the engine's open workbook, not a scratch grid.
    expect(await engineCell(1)).toBe('stamped');
  });

  it('hidden cells are unreadable to the add-on (permission face e)', async () => {
    await setup();
    await seedEngine([10, 20, 30]);
    // Hide A2 from everyone except the owner principal.
    const hide = await engPost('/protection/hide', { sheet: 'Sheet1', ranges: ['A2'] });
    expect(hide.status).toBe(200);
    await installAndGrant(SUM_REPORTER, [{ kind: 'read' }]);

    const run = await post('/run', {
      addonId: SUM_REPORTER,
      documentId: DOC,
      args: { ref: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 2, endCol: 0 } },
    });
    expect(run.status).toBe(200);
    // A2 (20) is hidden from user:alice → #PERM! → coerced to null → skipped.
    expect(run.json).toEqual({ ok: true, value: { sum: 40, count: 2 } });
  });

  it('run fails closed without an active grant', async () => {
    await setup();
    await seedEngine([10]);
    expect((await post('/install', { id: SUM_REPORTER })).status).toBe(200);

    const run = await post('/run', { addonId: SUM_REPORTER, documentId: DOC });
    expect(run.status).toBe(403);
    expect((run.json as { code: string }).code).toBe('auth');
  });

  it('run fails closed when the document binding is unavailable', async () => {
    // A resolver that throws must not silently fall back to the seed grid.
    const broken = await startServer(
      createAddonListener({
        service: createMemoryAddonService(),
        resolveBinding: () => {
          throw new Error('engine down');
        },
      }),
    );
    try {
      const inst = await httpJson('POST', `${broken.url}/install`, {
        headers: ALICE,
        body: { id: SUM_REPORTER },
      });
      expect(inst.status).toBe(200);
      const run = await httpJson('POST', `${broken.url}/run`, {
        headers: ALICE,
        body: { addonId: SUM_REPORTER, documentId: DOC },
      });
      expect(run.status).toBe(502);
    } finally {
      await stop(broken);
    }
  });

  it('the delegating authorizer audit-logs every op with both identities', async () => {
    // Own authorizer instance so the test can read its audit log directly.
    const authorizer = createDelegatingAddonAuthorizer();
    engine = await startServer(createEngineListener());
    addons = await startServer(
      createAddonListener({
        service: createMemoryAddonService(),
        authorizer,
        resolveBinding: (documentId, reqCtx) =>
          createEngineServiceBinding({
            engineBaseUrl: engine!.url,
            documentId,
            principal: reqCtx.principal,
          }),
      }),
    );
    await seedEngine([10, 20, 30]);
    await installAndGrant(SUM_REPORTER, [{ kind: 'read' }]);
    const run = await post('/run', {
      addonId: SUM_REPORTER,
      documentId: DOC,
      args: { ref: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 0 } },
    });
    expect(run.status).toBe(200);
    expect(run.json).toEqual({ ok: true, value: { sum: 10, count: 1 } });
    const log = authorizer.auditLog();
    expect(log.length).toBeGreaterThan(0);
    for (const entry of log) {
      expect(entry.principal).toBe('user:alice');
      expect(entry.addonId).toBe(SUM_REPORTER);
      expect(entry.allowed).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// FIX-R3: signed engine. The pre-fix wiring forwarded the caller's
// gateway JWT (3-part) to the engine, which verifies bearer tokens as
// engine-access tokens (2-part) and rejects it as "malformed" — the
// original case-11 live failure. The production resolver now mints a
// session-scoped engine-access token carrying the user's OWN role.
// ---------------------------------------------------------------------------

describe('add-on /run against a signed engine (FIX-R3)', () => {
  const SECRET = 'addon-signed-test-secret';
  const FILE_ID = 'file-addon-1';
  const SESSION_ID = 'sess_addon_1';
  // Stands in for the browser's gateway JWT: a 3-part token that is NOT
  // an engine-access token. The /run request carries it, exactly like
  // the real client; the binding must never forward it to the engine.
  const GATEWAY_JWT = 'aaa.bbb.ccc';
  const ALICE_JWT = { 'x-principal': 'user:alice', authorization: `Bearer ${GATEWAY_JWT}` };
  const BOB_JWT = { 'x-principal': 'user:bob', authorization: `Bearer ${GATEWAY_JWT}` };

  let engine: Started | null = null;
  let addons: Started | null = null;
  afterEach(async () => {
    if (addons) await stop(addons);
    if (engine) await stop(engine);
    engine = addons = null;
  });

  function engineToken(principal: string, role: 'editor' | 'viewer'): string {
    return issueEngineAccessToken({
      secret: SECRET,
      principal,
      sessionId: SESSION_ID,
      fid: FILE_ID,
      role,
      tier: 'standard',
    }).token;
  }

  async function setupSigned() {
    engine = await startServer(
      createEngineListener({
        sessionStores: new MemorySessionStores(),
        fileRegistry: new MemoryFileRegistry(),
        deployEnv: {
          ENGINE_ACCESS_MODE: 'signed',
          ENGINE_ACCESS_SECRET: SECRET,
          AUTOSAVE_CHECKPOINT_SETTLE_MS: '0',
        } as NodeJS.ProcessEnv,
      }),
    );
    // Claim the session and load Sheet1 A1:A3 = 10/20/30 (alice, editor).
    const aliceTok = engineToken('user:alice', 'editor');
    const claim = await httpJson('POST', `${engine.url}/session/claim`, {
      headers: { authorization: `Bearer ${aliceTok}` },
      body: { fileId: FILE_ID, sessionId: SESSION_ID },
    });
    expect(claim.status).toBe(200);
    const bytes = new XlsxAdapter().write({
      sheets: [{ name: 'Sheet1', rows: [[10], [20], [30]] }],
      metadata: {},
    } as never);
    const load = await httpJson('POST', `${engine.url}/load`, {
      headers: { authorization: `Bearer ${aliceTok}` },
      body: {
        format: 'xlsx',
        data: Buffer.from(bytes).toString('base64'),
        sessionId: SESSION_ID,
      },
    });
    expect(load.status).toBe(200);

    // The registry record the production resolver reads: alice created
    // the session on this engine; bob is a recorded viewer participant.
    const record: FileRegistryRecord = {
      fileId: FILE_ID,
      sessionId: SESSION_ID,
      ownerInstance: 'engine-1',
      ownerEndpoint: engine.url,
      leaseExpiry: Date.now() + 120_000,
      ownershipEpoch: 1,
      currentRevision: 0,
      storedRevision: 0,
      updatedAt: Date.now(),
      creatorPrincipal: 'user:alice',
      participants: { 'user:bob': 'viewer' },
      // Production share records carry grants + participants as a
      // mirror (gateway.ts share flow); grants are the AUTHORITATIVE
      // role source (aclRoleFor reads grants only). A participants-only
      // record matches no principal — that stale shape is what used
      // to 502 this test.
      grants: { 'user:bob': 'viewer' },
    };
    addons = await startServer(
      createAddonListener({
        service: createMemoryAddonService(),
        authorizer: createDelegatingAddonAuthorizer(),
        resolveBinding: createProductionAddonResolveBinding(engine.url, {
          records: [record],
          env: { ENGINE_ACCESS_SECRET: SECRET } as NodeJS.ProcessEnv,
        }),
      }),
    );
  }

  const post = (path: string, body: unknown, headers: Record<string, string>) =>
    httpJson('POST', `${addons!.url}${path}`, { headers, body });

  async function installAndGrant(
    addonId: string,
    capabilities: { kind: string }[],
    headers: Record<string, string>,
    documentId: string = FILE_ID,
  ) {
    expect((await post('/install', { id: addonId }, headers)).status).toBe(200);
    const req = await post(
      '/grants/request',
      { addonId, documentId, capabilities },
      headers,
    );
    expect(req.status).toBe(200);
    const grantId = (req.json as { grant: { id: string } }).grant.id;
    expect((await post('/grants/approve', { id: grantId }, headers)).status).toBe(200);
  }

  async function engineCellAsAlice(row: number, col = 0): Promise<unknown> {
    const r = await httpJson('POST', `${engine!.url}/read`, {
      headers: { authorization: `Bearer ${engineToken('user:alice', 'editor')}` },
      body: { kind: 'cell', ref: { sheet: 'Sheet1', row, col } },
    });
    expect(r.status).toBe(200);
    const v = (r.json as { value: { kind: string; value?: unknown } }).value;
    return v.kind === 'error' ? { error: (v as { code: string }).code } : v.value;
  }

  it('run succeeds although the /run request carries a gateway JWT (minted token, never forwarded)', async () => {
    await setupSigned();
    await installAndGrant(SUM_REPORTER, [{ kind: 'read' }], ALICE_JWT);
    const run = await post(
      '/run',
      {
        addonId: SUM_REPORTER,
        documentId: FILE_ID,
        args: { ref: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 2, endCol: 0 } },
      },
      ALICE_JWT,
    );
    expect(run.status).toBe(200);
    expect(run.json).toEqual({ ok: true, value: { sum: 60, count: 3 } });
  });

  it('negative control: the pre-FIX-R3 wiring (forwarding the gateway JWT) is refused as malformed', async () => {
    await setupSigned();
    const legacyBinding = createEngineServiceBinding({
      engineBaseUrl: engine!.url,
      documentId: FILE_ID,
      principal: 'user:alice',
      authorization: `Bearer ${GATEWAY_JWT}`,
    });
    await expect(
      legacyBinding.readCell({ sheet: 'Sheet1', row: 0, col: 0 }),
    ).rejects.toThrow(/malformed/);
  });

  it('viewer participant: add-on reads work, writes are refused by the engine, cell unchanged', async () => {
    await setupSigned();
    await installAndGrant(SUM_REPORTER, [{ kind: 'read' }], BOB_JWT);
    const read = await post(
      '/run',
      {
        addonId: SUM_REPORTER,
        documentId: FILE_ID,
        args: { ref: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 2, endCol: 0 } },
      },
      BOB_JWT,
    );
    expect(read.status).toBe(200);
    expect(read.json).toEqual({ ok: true, value: { sum: 60, count: 3 } });

    await installAndGrant(STAMPER, [{ kind: 'read' }, { kind: 'write' }], BOB_JWT);
    const write = await post(
      '/run',
      {
        addonId: STAMPER,
        documentId: FILE_ID,
        args: { ref: { sheet: 'Sheet1', row: 1, col: 0 }, value: 'stamped' },
      },
      BOB_JWT,
    );
    // The run fails visibly (the engine's /execute viewer gate refuses
    // the write) and A2 keeps its seeded value.
    expect(write.status).toBeGreaterThanOrEqual(400);
    expect(await engineCellAsAlice(1)).toBe(20);
  });

  it('editor creator: add-on writes land (control for the viewer refusal)', async () => {
    await setupSigned();
    await installAndGrant(STAMPER, [{ kind: 'read' }, { kind: 'write' }], ALICE_JWT);
    const write = await post(
      '/run',
      {
        addonId: STAMPER,
        documentId: FILE_ID,
        args: { ref: { sheet: 'Sheet1', row: 1, col: 0 }, value: 'stamped' },
      },
      ALICE_JWT,
    );
    expect(write.status).toBe(200);
    expect(await engineCellAsAlice(1)).toBe('stamped');
  });

  it('run fails closed (502) when the document has no live session', async () => {
    await setupSigned();
    await installAndGrant(SUM_REPORTER, [{ kind: 'read' }], ALICE_JWT, 'file-not-open');
    const run = await post(
      '/run',
      { addonId: SUM_REPORTER, documentId: 'file-not-open' },
      ALICE_JWT,
    );
    expect(run.status).toBe(502);
  });
});
