/**
 * Product layer (CONTRACT.md): tier store + file catalog units, upload
 * tokens, and the gateway HTTP surface — tier stamps on both auth
 * exchanges, caps at upload-grant AND complete-upload (actual size),
 * catalog ownership (files + engine/open), staging token auth.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyToken } from '@icecream-sheets/service';
import { createGateway, type GatewayListener, type GatewayOptions } from '../src/gateway.js';
import {
  LocalUserFileCatalog,
  LocalUserTierStore,
  MemoryUserFileCatalog,
  MemoryUserTierStore,
  sourceFormatForFileName,
  type UserFileRecord,
} from '../src/deploy/userStore.js';
import {
  MemoryUploadObjectStore,
  issueUploadToken,
  uploadObjectKey,
  verifyUploadToken,
} from '../src/deploy/uploadStore.js';
import { EngineAccessError } from '../src/deploy/engineAccess.js';
import { MemoryFileRegistry } from '../src/deploy/fileRegistry.js';
import { clearFirebaseCertCache } from '../src/firebaseToken.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';
import { makeTestRsaKey, mintFirebaseToken, type TestRsaKey } from './firebaseTestKeys.js';

const SECRET = 'test-product-secret';
const UPLOAD_SECRET = 'test-upload-secret';
const ENGINE_SECRET = 'test-engine-access-secret';
const P75 = 1_285_214;

// ---------------------------------------------------------------------------
// Units: tier store
// ---------------------------------------------------------------------------

describe('UserTierStore (memory)', () => {
  it('resolves default on first sight and creates the record', async () => {
    const store = new MemoryUserTierStore();
    expect(await store.resolveTier({ userId: 'u1', email: 'a@example.com' })).toBe('default');
    const rec = await store.getRecord('u1');
    expect(rec?.tier).toBe('default');
    expect(rec?.email).toBe('a@example.com');
    expect(await store.getRecord('nobody')).toBeNull();
  });

  it('backfills the email on an existing record', async () => {
    const store = new MemoryUserTierStore();
    await store.resolveTier({ userId: 'u2' });
    expect((await store.getRecord('u2'))?.email).toBeUndefined();
    await store.resolveTier({ userId: 'u2', email: 'b@example.com' });
    expect((await store.getRecord('u2'))?.email).toBe('b@example.com');
  });

  it('pending promotion by email is consumed at first login only', async () => {
    const store = new MemoryUserTierStore();
    expect(await store.setTierByEmail('vip@example.com', 'pro')).toBeNull();
    expect(await store.getPendingByEmail('vip@example.com')).toBe('pro');
    expect(await store.resolveTier({ userId: 'u3', email: 'vip@example.com' })).toBe('pro');
    expect((await store.getRecord('u3'))?.tier).toBe('pro');
    expect(await store.getPendingByEmail('vip@example.com')).toBeNull();
    // Consumed: a second user with the same email lands on default.
    expect(await store.resolveTier({ userId: 'u4', email: 'vip@example.com' })).toBe('default');
  });

  it('setTierByEmail updates an existing record; setTierByUserId creates/updates', async () => {
    const store = new MemoryUserTierStore();
    await store.resolveTier({ userId: 'u5', email: 'c@example.com' });
    const updated = await store.setTierByEmail('C@Example.com', 'pro');
    expect(updated?.userId).toBe('u5');
    expect(await store.resolveTier({ userId: 'u5', email: 'c@example.com' })).toBe('pro');
    const made = await store.setTierByUserId('u6', 'pro');
    expect(made.tier).toBe('pro');
    expect(await store.resolveTier({ userId: 'u6' })).toBe('pro');
    await store.setTierByUserId('u6', 'default');
    expect(await store.resolveTier({ userId: 'u6' })).toBe('default');
  });

  it('local adapter persists across instances', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'icecream-user-store-'));
    try {
      const a = new LocalUserTierStore(dir);
      await a.setTierByUserId('persisted', 'pro');
      await a.setTierByEmail('later@example.com', 'pro');
      const b = new LocalUserTierStore(dir);
      expect((await b.getRecord('persisted'))?.tier).toBe('pro');
      expect(await b.resolveTier({ userId: 'new', email: 'later@example.com' })).toBe('pro');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Units: file catalog
// ---------------------------------------------------------------------------

describe('UserFileCatalog (memory)', () => {
  it('count, recents order (lastOpenedAt DESC), touchOpened', async () => {
    const cat = new MemoryUserFileCatalog();
    const mk = (fileId: string, name: string) =>
      cat.create({ fileId, ownerPrincipal: 'user:alice', name, origin: 'created' });
    await mk('file-a', 'A');
    await mk('file-b', 'B');
    await mk('file-c', 'C');
    await cat.create({ fileId: 'file-x', ownerPrincipal: 'user:bob', name: 'X', origin: 'upload' });
    expect(await cat.countByOwner('user:alice')).toBe(3);
    expect(await cat.countByOwner('user:bob')).toBe(1);
    await cat.update('file-a', { lastOpenedAt: 100 });
    await cat.update('file-b', { lastOpenedAt: 300 });
    await cat.update('file-c', { lastOpenedAt: 200 });
    expect((await cat.listByOwner('user:alice')).map((f) => f.fileId)).toEqual([
      'file-b',
      'file-c',
      'file-a',
    ]);
    await cat.touchOpened('file-a');
    expect((await cat.listByOwner('user:alice'))[0]?.fileId).toBe('file-a');
    expect((await cat.get('file-a'))?.lastOpenedAt).toBeGreaterThan(300);
    await cat.remove('file-a');
    expect(await cat.countByOwner('user:alice')).toBe(2);
    expect(await cat.get('file-a')).toBeNull();
  });

  it('local adapter persists records', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'icecream-user-files-'));
    try {
      const a = new LocalUserFileCatalog(dir);
      await a.create({ fileId: 'file-1', ownerPrincipal: 'user:alice', name: 'One', origin: 'created' });
      const b = new LocalUserFileCatalog(dir);
      expect((await b.get('file-1'))?.name).toBe('One');
      expect(await b.countByOwner('user:alice')).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sourceFormat defaults to xlsx and is stored when given csv', async () => {
    const cat = new MemoryUserFileCatalog();
    const created = await cat.create({
      fileId: 'file-def',
      ownerPrincipal: 'user:alice',
      name: 'Blank',
      origin: 'created',
    });
    expect(created.sourceFormat).toBe('xlsx');
    const csv = await cat.create({
      fileId: 'file-csv',
      ownerPrincipal: 'user:alice',
      name: 'data.csv',
      origin: 'upload',
      sourceFormat: 'csv',
    });
    expect(csv.sourceFormat).toBe('csv');
    expect((await cat.get('file-csv'))?.sourceFormat).toBe('csv');
  });

  it('a persisted record JSON without sourceFormat loads as xlsx', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'icecream-user-files-legacy-'));
    try {
      const legacy = {
        fileId: 'file-legacy',
        ownerPrincipal: 'user:alice',
        name: 'Old.xlsx',
        origin: 'upload',
        sizeBytes: 12,
        storageRef: null,
        libraryEntryId: null,
        hasStoredState: false,
        createdAt: 1000,
        updatedAt: 1000,
        lastOpenedAt: 1000,
      };
      writeFileSync(join(dir, 'user-files.json'), JSON.stringify({ 'file-legacy': legacy }), 'utf8');
      const cat = new LocalUserFileCatalog(dir);
      const rec = await cat.get('file-legacy');
      expect(rec?.name).toBe('Old.xlsx');
      expect(rec?.sourceFormat).toBe('xlsx');
      expect((await cat.listByOwner('user:alice'))[0]?.sourceFormat).toBe('xlsx');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sourceFormatForFileName derives from extension, case-insensitive', () => {
    expect(sourceFormatForFileName('book.xlsx')).toBe('xlsx');
    expect(sourceFormatForFileName('book.XLSX')).toBe('xlsx');
    expect(sourceFormatForFileName('data.csv')).toBe('csv');
    expect(sourceFormatForFileName('DATA.CSV')).toBe('csv');
    expect(sourceFormatForFileName('notes.txt')).toBeNull();
    expect(sourceFormatForFileName('no-extension')).toBeNull();
    expect(sourceFormatForFileName('tricky.xlsx.txt')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Units: upload tokens
// ---------------------------------------------------------------------------

describe('upload tokens', () => {
  it('round-trip with op/object/principal/maxBytes scope', () => {
    const { token, claims } = issueUploadToken({
      secret: UPLOAD_SECRET,
      op: 'put',
      object: 'uploads/abc/file-1.xlsx',
      principal: 'user:alice',
      maxBytes: 42,
    });
    expect(claims.maxBytes).toBe(42);
    const verified = verifyUploadToken(token, UPLOAD_SECRET, {
      op: 'put',
      object: 'uploads/abc/file-1.xlsx',
      principal: 'user:alice',
    });
    expect(verified.object).toBe('uploads/abc/file-1.xlsx');
  });

  it('tamper, wrong scope, and expiry all throw EngineAccessError', () => {
    const { token } = issueUploadToken({
      secret: UPLOAD_SECRET,
      op: 'put',
      object: 'uploads/abc/file-1.xlsx',
      principal: 'user:alice',
    });
    const tampered = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(() => verifyUploadToken(tampered, UPLOAD_SECRET)).toThrow(EngineAccessError);
    expect(() => verifyUploadToken(token, 'other-secret')).toThrow(EngineAccessError);
    expect(() => verifyUploadToken(token, UPLOAD_SECRET, { op: 'get' })).toThrow(EngineAccessError);
    expect(() =>
      verifyUploadToken(token, UPLOAD_SECRET, { object: 'uploads/abc/other.xlsx' }),
    ).toThrow(EngineAccessError);
    const old = issueUploadToken({
      secret: UPLOAD_SECRET,
      op: 'get',
      object: 'o',
      principal: 'user:alice',
      ttlSeconds: 30,
      nowMs: 1_000_000,
    });
    expect(() => verifyUploadToken(old.token, UPLOAD_SECRET, { nowMs: 2_000_000 })).toThrow(
      /expired/,
    );
  });

  it('uploadObjectKey is uploads/<sha256(principal)[0:16]>/<fileId>.xlsx', () => {
    const key = uploadObjectKey('user:alice', 'file-9');
    expect(key).toMatch(/^uploads\/[0-9a-f]{16}\/file-9\.xlsx$/);
    expect(uploadObjectKey('user:alice', 'file-9')).toBe(key);
    expect(uploadObjectKey('user:bob', 'file-9')).not.toBe(key);
  });

  it('uploadObjectKey with csv format → .csv key; default → .xlsx', () => {
    expect(uploadObjectKey('user:alice', 'file-9', 'csv')).toMatch(
      /^uploads\/[0-9a-f]{16}\/file-9\.csv$/,
    );
    expect(uploadObjectKey('user:alice', 'file-9', 'xlsx')).toBe(
      uploadObjectKey('user:alice', 'file-9'),
    );
    expect(uploadObjectKey('user:alice', 'file-9', 'csv')).not.toBe(
      uploadObjectKey('user:alice', 'file-9'),
    );
  });
});

// ---------------------------------------------------------------------------
// Gateway HTTP (Memory stores injected)
// ---------------------------------------------------------------------------

interface Rig {
  gateway: Started;
  listener: GatewayListener;
  tierStore: MemoryUserTierStore;
  catalog: MemoryUserFileCatalog;
  uploadStore: MemoryUploadObjectStore;
  claimServer: Started | null;
}

describe('gateway product layer', () => {
  let rig: Rig | null = null;

  async function setup(extra: Partial<GatewayOptions> = {}, withClaimEngine = false) {
    const tierStore = new MemoryUserTierStore();
    const catalog = new MemoryUserFileCatalog();
    const uploadStore = new MemoryUploadObjectStore({
      tokenSecret: UPLOAD_SECRET,
      publicBaseUrl: 'http://127.0.0.1:1',
    });
    let claimServer: Started | null = null;
    let engineUrl = 'http://127.0.0.1:9';
    if (withClaimEngine) {
      claimServer = await startServer((req, res) => {
        let body = '';
        req.on('data', (c: Buffer) => {
          body += c.toString();
        });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ sessionId: 'sess_claim1', revision: 7 }));
        });
      });
      engineUrl = claimServer.url;
    }
    const listener = createGateway({
      devLoginEnabled: true,
      authSecret: SECRET,
      routes: {},
      rateLimit: { points: 1000, perSeconds: 60 },
      userTierStore: tierStore,
      userFileCatalog: catalog,
      uploadStore,
      uploadTokenSecret: UPLOAD_SECRET,
      fileRegistry: new MemoryFileRegistry(),
      engineAccess: {
        secret: ENGINE_SECRET,
        tiers: { standard: engineUrl, xl: engineUrl },
      },
      ...extra,
    });
    const gateway = await startServer(listener);
    uploadStore.publicBaseUrl = gateway.url;
    rig = { gateway, listener, tierStore, catalog, uploadStore, claimServer };
    return rig;
  }

  afterEach(async () => {
    if (rig) {
      await stop(rig.gateway);
      if (rig.claimServer) await stop(rig.claimServer);
    }
    rig = null;
  });

  async function login(userId: string): Promise<{ token: string; tier: string }> {
    const r = await httpJson('POST', `${rig!.gateway.url}/auth/login`, { body: { userId } });
    expect(r.status).toBe(200);
    const json = r.json as { token: string; tier: string };
    return { token: json.token, tier: json.tier };
  }
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  it('login stamps tier default in the response and the JWT attrs', async () => {
    await setup();
    const { token, tier } = await login('alice');
    expect(tier).toBe('default');
    const claims = await verifyToken(token, SECRET);
    expect(claims.attrs['tier']).toBe('default');
  });

  it('store-level promotion → re-login stamps pro', async () => {
    await setup();
    expect((await login('alice')).tier).toBe('default');
    await rig!.tierStore.setTierByUserId('alice', 'pro');
    const again = await login('alice');
    expect(again.tier).toBe('pro');
    const claims = await verifyToken(again.token, SECRET);
    expect(claims.attrs['tier']).toBe('pro');
    const files = await httpJson('GET', `${rig!.gateway.url}/api/files`, {
      headers: auth(again.token),
    });
    const json = files.json as { tier: string; limits: { uploadMaxBytes: number | null } };
    expect(json.tier).toBe('pro');
    expect(json.limits.uploadMaxBytes).toBeNull();
  });

  it('upload-grant: 413 above the Default cap, success exactly at it', async () => {
    await setup();
    const { token } = await login('alice');
    const over = await httpJson('POST', `${rig!.gateway.url}/api/files/upload-grant`, {
      headers: auth(token),
      body: { name: 'big.xlsx', size: P75 + 1 },
    });
    expect(over.status).toBe(413);
    const overJson = over.json as { code: string; limit: number; size: number; tier: string; error: string };
    expect(overJson.code).toBe('UPLOAD_TOO_LARGE');
    expect(overJson.limit).toBe(P75);
    expect(overJson.size).toBe(P75 + 1);
    expect(overJson.tier).toBe('default');
    expect(overJson.error).toMatch(/1285214/);
    expect(overJson.error).toMatch(/Pro/);

    const at = await httpJson('POST', `${rig!.gateway.url}/api/files/upload-grant`, {
      headers: auth(token),
      body: { name: 'edge.xlsx', size: P75 },
    });
    expect(at.status).toBe(200);
    const atJson = at.json as {
      fileId: string;
      object: string;
      upload: { url: string; method: string; expiresAt: number };
    };
    expect(atJson.fileId).toMatch(/^file-/);
    expect(atJson.object).toBe(uploadObjectKey('user:alice', atJson.fileId));
    expect(atJson.upload.method).toBe('PUT');
    expect(atJson.upload.url).toContain('/uploads/stage/');
    // No catalog record yet.
    expect(await rig!.catalog.countByOwner('user:alice')).toBe(0);
  });

  it('upload-grant: csv → 200 with .csv object; uppercase .CSV → 200; .txt → 400 naming formats', async () => {
    await setup();
    const { token } = await login('alice');
    const csv = await httpJson('POST', `${rig!.gateway.url}/api/files/upload-grant`, {
      headers: auth(token),
      body: { name: 'data.csv', size: 10 },
    });
    expect(csv.status).toBe(200);
    const csvJson = csv.json as { fileId: string; object: string };
    expect(csvJson.object.endsWith('.csv')).toBe(true);
    expect(csvJson.object).toBe(uploadObjectKey('user:alice', csvJson.fileId, 'csv'));

    const upper = await httpJson('POST', `${rig!.gateway.url}/api/files/upload-grant`, {
      headers: auth(token),
      body: { name: 'DATA.CSV', size: 10 },
    });
    expect(upper.status).toBe(200);
    expect((upper.json as { object: string }).object.endsWith('.csv')).toBe(true);

    const txt = await httpJson('POST', `${rig!.gateway.url}/api/files/upload-grant`, {
      headers: auth(token),
      body: { name: 'notes.txt', size: 10 },
    });
    expect(txt.status).toBe(400);
    expect((txt.json as { error: string }).error).toContain('.xlsx');
    expect((txt.json as { error: string }).error).toContain('.csv');
    expect((txt.json as { error: string }).error).toBe(
      'unsupported file type: only .xlsx, .xls and .csv files can be uploaded',
    );
  });

  it('upload-grant: oversized CSV on Default tier → 413 UPLOAD_TOO_LARGE', async () => {
    await setup();
    const { token } = await login('alice');
    const over = await httpJson('POST', `${rig!.gateway.url}/api/files/upload-grant`, {
      headers: auth(token),
      body: { name: 'big.csv', size: P75 + 1 },
    });
    expect(over.status).toBe(413);
    const j = over.json as { code: string; limit: number; size: number; tier: string };
    expect(j.code).toBe('UPLOAD_TOO_LARGE');
    expect(j.limit).toBe(P75);
    expect(j.size).toBe(P75 + 1);
    expect(j.tier).toBe('default');
  });

  it('complete-upload: staged CSV → record.sourceFormat csv and .csv storage object', async () => {
    await setup();
    const { token } = await login('alice');
    const bytes = new TextEncoder().encode('a,b\n1,2\n');
    const grant = await httpJson('POST', `${rig!.gateway.url}/api/files/upload-grant`, {
      headers: auth(token),
      body: { name: 'data.csv', size: bytes.length },
    });
    expect(grant.status).toBe(200);
    const g = grant.json as { fileId: string; object: string; upload: { url: string } };
    expect(g.object.endsWith('.csv')).toBe(true);
    const put = await fetch(g.upload.url, { method: 'PUT', body: bytes });
    expect(put.status).toBe(200);
    const complete = await httpJson(
      'POST',
      `${rig!.gateway.url}/api/files/${g.fileId}/complete-upload`,
      { headers: auth(token), body: { name: 'data.csv' } },
    );
    expect(complete.status).toBe(201);
    const file = (complete.json as { file: UserFileRecord }).file;
    expect(file.sourceFormat).toBe('csv');
    expect(file.storageRef?.object.endsWith('.csv')).toBe(true);
    expect(file.storageRef).toEqual({ bucket: rig!.uploadStore.bucket, object: g.object });
  });

  it('upload-grant: binds the format canonical Content-Type per format (#96 reopen)', async () => {
    await setup();
    const { token } = await login('alice');
    const cases = [
      {
        name: 'book.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      { name: 'old.xls', contentType: 'application/vnd.ms-excel' },
      { name: 'data.csv', contentType: 'text/csv' },
    ];
    for (const c of cases) {
      const grant = await httpJson('POST', `${rig!.gateway.url}/api/files/upload-grant`, {
        headers: auth(token),
        body: { name: c.name, size: 10 },
      });
      expect(grant.status).toBe(200);
      const g = grant.json as { upload: { contentType?: string } };
      expect(g.upload.contentType).toBe(c.contentType);
    }
  });

  it('complete-upload: unsupported extension → 400 naming formats', async () => {
    await setup();
    const { token } = await login('alice');
    const r = await httpJson('POST', `${rig!.gateway.url}/api/files/file-ghost/complete-upload`, {
      headers: auth(token),
      body: { name: 'ghost.txt' },
    });
    expect(r.status).toBe(400);
    expect((r.json as { error: string }).error).toBe(
      'unsupported file type: only .xlsx, .xls and .csv files can be uploaded',
    );
  });

  it("create with origin 'shared' tags the record; other origins → 400", async () => {
    await setup();
    const { token } = await login('alice');
    const shared = await httpJson('POST', `${rig!.gateway.url}/api/files`, {
      headers: auth(token),
      body: { name: 'Copy of a shared app', origin: 'shared' },
    });
    expect(shared.status).toBe(201);
    expect((shared.json as { file: { origin: string } }).file.origin).toBe('shared');
    const plain = await httpJson('POST', `${rig!.gateway.url}/api/files`, {
      headers: auth(token),
      body: { name: 'Ordinary sheet' },
    });
    expect(plain.status).toBe(201);
    expect((plain.json as { file: { origin: string } }).file.origin).toBe('created');
    const bogus = await httpJson('POST', `${rig!.gateway.url}/api/files`, {
      headers: auth(token),
      body: { name: 'Nope', origin: 'upload' },
    });
    expect(bogus.status).toBe(400);
    expect((bogus.json as { error: string }).error).toMatch(/origin/);
  });

  it('11th created file → 409 FILE_LIMIT_REACHED; list shows caps', async () => {
    await setup();
    const { token } = await login('alice');
    for (let i = 0; i < 10; i++) {
      const r = await httpJson('POST', `${rig!.gateway.url}/api/files`, {
        headers: auth(token),
        body: { name: `Sheet ${i}` },
      });
      expect(r.status).toBe(201);
    }
    const eleventh = await httpJson('POST', `${rig!.gateway.url}/api/files`, {
      headers: auth(token),
      body: { name: 'Sheet 10' },
    });
    expect(eleventh.status).toBe(409);
    const j = eleventh.json as { code: string; limit: number; count: number; error: string };
    expect(j.code).toBe('FILE_LIMIT_REACHED');
    expect(j.limit).toBe(10);
    expect(j.count).toBe(10);
    expect(j.error).toMatch(/Pro/);
    // Upload-grant is count-checked too.
    const grant = await httpJson('POST', `${rig!.gateway.url}/api/files/upload-grant`, {
      headers: auth(token),
      body: { name: 'x.xlsx', size: 10 },
    });
    expect(grant.status).toBe(409);
    expect((grant.json as { code: string }).code).toBe('FILE_LIMIT_REACHED');

    const list = await httpJson('GET', `${rig!.gateway.url}/api/files`, { headers: auth(token) });
    const lj = list.json as {
      tier: string;
      limits: { uploadMaxBytes: number | null; fileLimit: number | null };
      count: number;
      files: UserFileRecord[];
    };
    expect(lj.tier).toBe('default');
    expect(lj.limits).toEqual({ uploadMaxBytes: P75, fileLimit: 10 });
    expect(lj.count).toBe(10);
    expect(lj.files).toHaveLength(10);
  });

  it('complete-upload happy path: grant → PUT staging → complete → listed', async () => {
    await setup();
    const { token } = await login('alice');
    const bytes = new TextEncoder().encode('fake-xlsx-bytes-0123456789');
    const grant = await httpJson('POST', `${rig!.gateway.url}/api/files/upload-grant`, {
      headers: auth(token),
      body: { name: 'book.xlsx', size: bytes.length },
    });
    expect(grant.status).toBe(200);
    const g = grant.json as { fileId: string; object: string; upload: { url: string } };

    const put = await fetch(g.upload.url, { method: 'PUT', body: bytes });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { size: number }).size).toBe(bytes.length);

    const complete = await httpJson(
      'POST',
      `${rig!.gateway.url}/api/files/${g.fileId}/complete-upload`,
      { headers: auth(token), body: { name: 'book.xlsx' } },
    );
    expect(complete.status).toBe(201);
    const file = (complete.json as { file: UserFileRecord }).file;
    expect(file.origin).toBe('upload');
    expect(file.sourceFormat).toBe('xlsx');
    expect(file.sizeBytes).toBe(bytes.length);
    expect(file.storageRef).toEqual({ bucket: rig!.uploadStore.bucket, object: g.object });

    // Idempotent second complete returns the same record.
    const again = await httpJson(
      'POST',
      `${rig!.gateway.url}/api/files/${g.fileId}/complete-upload`,
      { headers: auth(token), body: { name: 'book.xlsx' } },
    );
    expect(again.status).toBe(201);
    expect((again.json as { file: UserFileRecord }).file.fileId).toBe(g.fileId);

    const list = await httpJson('GET', `${rig!.gateway.url}/api/files`, { headers: auth(token) });
    expect(((list.json as { files: UserFileRecord[] }).files).map((f) => f.fileId)).toContain(
      g.fileId,
    );

    // Download-grant serves the staged bytes back through a get token.
    const dg = await httpJson('POST', `${rig!.gateway.url}/api/files/${g.fileId}/download-grant`, {
      headers: auth(token),
    });
    expect(dg.status).toBe(200);
    const dl = await fetch((dg.json as { url: string }).url);
    expect(dl.status).toBe(200);
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(bytes);
  });

  it('complete-upload re-checks ACTUAL size: grant as pro, demote, complete → 413 + object deleted', async () => {
    await setup();
    await rig!.tierStore.setTierByUserId('victor', 'pro');
    const { token, tier } = await login('victor');
    expect(tier).toBe('pro');
    const size = P75 + 1;
    const grant = await httpJson('POST', `${rig!.gateway.url}/api/files/upload-grant`, {
      headers: auth(token),
      body: { name: 'big.xlsx', size },
    });
    expect(grant.status).toBe(200);
    const g = grant.json as { fileId: string; object: string; upload: { url: string } };
    const put = await fetch(g.upload.url, { method: 'PUT', body: new Uint8Array(size).fill(7) });
    expect(put.status).toBe(200);
    await rig!.tierStore.setTierByUserId('victor', 'default');
    const complete = await httpJson(
      'POST',
      `${rig!.gateway.url}/api/files/${g.fileId}/complete-upload`,
      { headers: auth(token), body: { name: 'big.xlsx' } },
    );
    expect(complete.status).toBe(413);
    expect((complete.json as { code: string }).code).toBe('UPLOAD_TOO_LARGE');
    expect(await rig!.uploadStore.stat(g.object)).toBeNull();
    expect(await rig!.catalog.countByOwner('user:victor')).toBe(0);
  });

  it('complete-upload with no staged bytes → 404 UPLOAD_NOT_FOUND', async () => {
    await setup();
    const { token } = await login('alice');
    const r = await httpJson('POST', `${rig!.gateway.url}/api/files/file-ghost/complete-upload`, {
      headers: auth(token),
      body: { name: 'ghost.xlsx' },
    });
    expect(r.status).toBe(404);
    expect((r.json as { code: string }).code).toBe('UPLOAD_NOT_FOUND');
  });

  it('created file download-grant → 409 NO_STORED_BYTES', async () => {
    await setup();
    const { token } = await login('alice');
    const created = await httpJson('POST', `${rig!.gateway.url}/api/files`, {
      headers: auth(token),
      body: { name: 'Blank' },
    });
    const fileId = (created.json as { file: UserFileRecord }).file.fileId;
    const dg = await httpJson('POST', `${rig!.gateway.url}/api/files/${fileId}/download-grant`, {
      headers: auth(token),
    });
    expect(dg.status).toBe(409);
    expect((dg.json as { code: string }).code).toBe('NO_STORED_BYTES');
  });

  it('PATCH sizeBytes records the stored size; the list reflects it (#105)', async () => {
    await setup();
    const { token } = await login('alice');
    const created = await httpJson('POST', `${rig!.gateway.url}/api/files`, {
      headers: auth(token),
      body: { name: 'Blank' },
    });
    expect(created.status).toBe(201);
    const fileId = (created.json as { file: UserFileRecord }).file.fileId;
    expect((created.json as { file: UserFileRecord }).file.sizeBytes).toBe(0);

    // The client relays the engine-reported stored size after a save.
    const patched = await httpJson('PATCH', `${rig!.gateway.url}/api/files/${fileId}`, {
      headers: auth(token),
      body: { sizeBytes: 12345 },
    });
    expect(patched.status).toBe(200);
    expect((patched.json as { file: UserFileRecord }).file.sizeBytes).toBe(12345);

    const list = await httpJson('GET', `${rig!.gateway.url}/api/files`, { headers: auth(token) });
    const row = ((list.json as { files: UserFileRecord[] }).files).find((f) => f.fileId === fileId);
    expect(row?.sizeBytes).toBe(12345);
  });

  it('PATCH sizeBytes validation: negative / non-integer / string → 400, record unchanged (#105)', async () => {
    await setup();
    const { token } = await login('alice');
    const created = await httpJson('POST', `${rig!.gateway.url}/api/files`, {
      headers: auth(token),
      body: { name: 'Blank' },
    });
    const fileId = (created.json as { file: UserFileRecord }).file.fileId;
    for (const bad of [-1, 1.5, '12345', true, null]) {
      const r = await httpJson('PATCH', `${rig!.gateway.url}/api/files/${fileId}`, {
        headers: auth(token),
        body: { sizeBytes: bad },
      });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    const own = await httpJson('GET', `${rig!.gateway.url}/api/files/${fileId}`, {
      headers: auth(token),
    });
    expect((own.json as { file: UserFileRecord }).file.sizeBytes).toBe(0);
  });

  it('PATCH no-op (same sizeBytes) does not bump updatedAt (#105)', async () => {
    await setup();
    const { token } = await login('alice');
    const created = await httpJson('POST', `${rig!.gateway.url}/api/files`, {
      headers: auth(token),
      body: { name: 'Blank' },
    });
    const fileId = (created.json as { file: UserFileRecord }).file.fileId;
    const first = await httpJson('PATCH', `${rig!.gateway.url}/api/files/${fileId}`, {
      headers: auth(token),
      body: { sizeBytes: 500 },
    });
    expect(first.status).toBe(200);
    const t1 = (first.json as { file: UserFileRecord }).file.updatedAt;
    const noop = await httpJson('PATCH', `${rig!.gateway.url}/api/files/${fileId}`, {
      headers: auth(token),
      body: { sizeBytes: 500 },
    });
    expect(noop.status).toBe(200);
    expect((noop.json as { file: UserFileRecord }).file.sizeBytes).toBe(500);
    expect((noop.json as { file: UserFileRecord }).file.updatedAt).toBe(t1);
  });

  it('non-owner GET/PATCH/DELETE of a file → 404 (no existence leak)', async () => {
    await setup();
    const alice = await login('alice');
    const bob = await login('bob');
    const created = await httpJson('POST', `${rig!.gateway.url}/api/files`, {
      headers: auth(alice.token),
      body: { name: 'Mine' },
    });
    const fileId = (created.json as { file: UserFileRecord }).file.fileId;
    for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
      const r = await httpJson(method, `${rig!.gateway.url}/api/files/${fileId}`, {
        headers: auth(bob.token),
        ...(method === 'PATCH' ? { body: { name: 'Stolen' } } : {}),
      });
      expect(r.status, method).toBe(404);
    }
    const own = await httpJson('GET', `${rig!.gateway.url}/api/files/${fileId}`, {
      headers: auth(alice.token),
    });
    expect(own.status).toBe(200);
    expect((own.json as { file: UserFileRecord }).file.name).toBe('Mine');
  });

  it('non-owner engine/open of a catalogued file → 404; owner opens + touches recency', async () => {
    await setup({}, true);
    const alice = await login('alice');
    const bob = await login('bob');
    await rig!.catalog.create({
      fileId: 'file-owned1',
      ownerPrincipal: 'user:alice',
      name: 'Owned',
      origin: 'created',
    });
    await rig!.catalog.update('file-owned1', { lastOpenedAt: 1000 });
    const bobOpen = await httpJson('POST', `${rig!.gateway.url}/api/engine/open`, {
      headers: auth(bob.token),
      body: { fileId: 'file-owned1' },
    });
    expect(bobOpen.status).toBe(404);
    expect((bobOpen.json as { error: string }).error).toBe('file not found');

    const aliceOpen = await httpJson('POST', `${rig!.gateway.url}/api/engine/open`, {
      headers: auth(alice.token),
      body: { fileId: 'file-owned1' },
    });
    expect(aliceOpen.status).toBe(200);
    expect((aliceOpen.json as { sessionId: string }).sessionId).toBe('sess_claim1');
    expect((await rig!.catalog.get('file-owned1'))?.lastOpenedAt).toBeGreaterThan(1000);
  });

  it('staging PUT without a token → 401; with a bad token → 401', async () => {
    await setup();
    const object = uploadObjectKey('user:alice', 'file-z');
    const noToken = await fetch(
      `${rig!.gateway.url}/uploads/stage/${encodeURIComponent(object)}`,
      { method: 'PUT', body: new Uint8Array([1, 2, 3]) },
    );
    expect(noToken.status).toBe(401);
    const badToken = await fetch(
      `${rig!.gateway.url}/uploads/stage/${encodeURIComponent(object)}?ut=deadbeef.deadbeef`,
      { method: 'PUT', body: new Uint8Array([1, 2, 3]) },
    );
    expect(badToken.status).toBe(401);
  });

  it('staging PUT over the token maxBytes → 413 and nothing is stored', async () => {
    await setup();
    const { token } = await login('alice');
    const grant = await httpJson('POST', `${rig!.gateway.url}/api/files/upload-grant`, {
      headers: auth(token),
      body: { name: 'tiny.xlsx', size: 5 },
    });
    const g = grant.json as { object: string; upload: { url: string } };
    const put = await fetch(g.upload.url, { method: 'PUT', body: new Uint8Array(10).fill(1) });
    expect(put.status).toBe(413);
    expect(((await put.json()) as { code: string }).code).toBe('UPLOAD_TOO_LARGE');
    expect(await rig!.uploadStore.stat(g.object)).toBeNull();
  });

  it('complete-upload actual-size re-check via a crafted big-maxBytes token → 413 + object deleted', async () => {
    await setup();
    const { token } = await login('alice');
    // Grant declares a small file; the grant token would cap the PUT
    // at 16 bytes. Mint a token directly with the test secret and a
    // bigger maxBytes (issueUploadToken) and PUT oversized bytes —
    // staging accepts them (token is the auth), so the COMPLETE step
    // is what must catch the real size against the Default cap.
    const grant = await httpJson('POST', `${rig!.gateway.url}/api/files/upload-grant`, {
      headers: auth(token),
      body: { name: 'sneaky.xlsx', size: 16 },
    });
    expect(grant.status).toBe(200);
    const g = grant.json as { fileId: string; object: string };
    const crafted = issueUploadToken({
      secret: UPLOAD_SECRET,
      op: 'put',
      object: g.object,
      principal: 'user:alice',
      maxBytes: P75 + 100_000,
    });
    const put = await fetch(
      `${rig!.gateway.url}/uploads/stage/${encodeURIComponent(g.object)}?ut=${crafted.token}`,
      { method: 'PUT', body: new Uint8Array(P75 + 1).fill(3) },
    );
    expect(put.status).toBe(200);
    expect(await rig!.uploadStore.stat(g.object)).toEqual({ size: P75 + 1 });
    const complete = await httpJson(
      'POST',
      `${rig!.gateway.url}/api/files/${g.fileId}/complete-upload`,
      { headers: auth(token), body: { name: 'sneaky.xlsx' } },
    );
    expect(complete.status).toBe(413);
    expect((complete.json as { code: string }).code).toBe('UPLOAD_TOO_LARGE');
    expect(await rig!.uploadStore.stat(g.object)).toBeNull();
    expect(await rig!.catalog.countByOwner('user:alice')).toBe(0);
  });

  it('pro user: oversized grant OK and the 11th file is OK', async () => {
    await setup();
    await rig!.tierStore.setTierByUserId('pro-user', 'pro');
    const { token, tier } = await login('pro-user');
    expect(tier).toBe('pro');
    const grant = await httpJson('POST', `${rig!.gateway.url}/api/files/upload-grant`, {
      headers: auth(token),
      body: { name: 'huge.xlsx', size: P75 + 1 },
    });
    expect(grant.status).toBe(200);
    for (let i = 0; i < 11; i++) {
      const r = await httpJson('POST', `${rig!.gateway.url}/api/files`, {
        headers: auth(token),
        body: { name: `Pro Sheet ${i}` },
      });
      expect(r.status, `create ${i}`).toBe(201);
    }
    const list = await httpJson('GET', `${rig!.gateway.url}/api/files`, { headers: auth(token) });
    const lj = list.json as { count: number; limits: { fileLimit: number | null } };
    expect(lj.count).toBe(11);
    expect(lj.limits.fileLimit).toBeNull();
  });

  it('non-owner complete-upload and download-grant → 404', async () => {
    await setup();
    const alice = await login('alice');
    const bob = await login('bob');
    const bytes = new TextEncoder().encode('alice-bytes');
    const grant = await httpJson('POST', `${rig!.gateway.url}/api/files/upload-grant`, {
      headers: auth(alice.token),
      body: { name: 'a.xlsx', size: bytes.length },
    });
    const g = grant.json as { fileId: string; upload: { url: string } };
    expect((await fetch(g.upload.url, { method: 'PUT', body: bytes })).status).toBe(200);
    const bobComplete = await httpJson(
      'POST',
      `${rig!.gateway.url}/api/files/${g.fileId}/complete-upload`,
      { headers: auth(bob.token), body: { name: 'a.xlsx' } },
    );
    expect(bobComplete.status).toBe(404);
    const done = await httpJson('POST', `${rig!.gateway.url}/api/files/${g.fileId}/complete-upload`, {
      headers: auth(alice.token),
      body: { name: 'a.xlsx' },
    });
    expect(done.status).toBe(201);
    const bobDownload = await httpJson(
      'POST',
      `${rig!.gateway.url}/api/files/${g.fileId}/download-grant`,
      { headers: auth(bob.token) },
    );
    expect(bobDownload.status).toBe(404);
  });

  it('staging rejects wrong-op, wrong-object, tampered, and expired tokens with 401', async () => {
    await setup();
    const object = uploadObjectKey('user:alice', 'file-tok');
    const stage = (tok: string, method = 'PUT') =>
      fetch(`${rig!.gateway.url}/uploads/stage/${encodeURIComponent(object)}?ut=${tok}`, {
        method,
        ...(method === 'PUT' ? { body: new Uint8Array([1]) } : {}),
      });
    // Wrong op: a 'get' token presented for a PUT.
    const getTok = issueUploadToken({
      secret: UPLOAD_SECRET,
      op: 'get',
      object,
      principal: 'user:alice',
    });
    expect((await stage(getTok.token)).status).toBe(401);
    // Wrong object: token minted for a different object.
    const otherTok = issueUploadToken({
      secret: UPLOAD_SECRET,
      op: 'put',
      object: uploadObjectKey('user:alice', 'file-other'),
      principal: 'user:alice',
    });
    expect((await stage(otherTok.token)).status).toBe(401);
    // Tampered signature.
    const good = issueUploadToken({
      secret: UPLOAD_SECRET,
      op: 'put',
      object,
      principal: 'user:alice',
    });
    const tampered = `${good.token.slice(0, -2)}${good.token.endsWith('AA') ? 'BB' : 'AA'}`;
    expect((await stage(tampered)).status).toBe(401);
    // Expired.
    const expired = issueUploadToken({
      secret: UPLOAD_SECRET,
      op: 'put',
      object,
      principal: 'user:alice',
      ttlSeconds: 5,
      nowMs: Date.now() - 60_000,
    });
    expect((await stage(expired.token)).status).toBe(401);
    // Sanity: the untampered, in-scope token works.
    expect((await stage(good.token)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Firebase exchange tier stamp
// ---------------------------------------------------------------------------

let fbKey: TestRsaKey | null = null;
async function firebaseKey(): Promise<TestRsaKey> {
  if (!fbKey) fbKey = await makeTestRsaKey('exchange-kid');
  return fbKey;
}

function stubCertFetch(certPem: string): () => void {
  const realFetch = globalThis.fetch;
  const stub = (async (input: unknown, init?: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string }).url ?? input);
    if (url.includes('googleapis.com/robot/v1/metadata/x509')) {
      return new Response(JSON.stringify({ 'exchange-kid': certPem }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'max-age=3600' },
      });
    }
    return (realFetch as typeof fetch)(input as never, init as never);
  }) as typeof fetch;
  vi.stubGlobal('fetch', stub);
  return () => vi.unstubAllGlobals();
}

describe('POST /auth/firebase tier stamp (product layer)', () => {
  let gateway: Started | null = null;
  let tierStore: MemoryUserTierStore | null = null;
  let restoreFetch: (() => void) | null = null;

  beforeEach(async () => {
    const k = await firebaseKey();
    restoreFetch = stubCertFetch(k.certPem);
  });

  afterEach(async () => {
    if (gateway) await stop(gateway);
    gateway = null;
    tierStore = null;
    restoreFetch?.();
    restoreFetch = null;
    clearFirebaseCertCache();
  });

  async function setup() {
    tierStore = new MemoryUserTierStore();
    const listener = createGateway({
      devLoginEnabled: true,
      authSecret: SECRET,
      firebaseProjectId: 'demo-project',
      routes: {},
      rateLimit: { points: 1000, perSeconds: 60 },
      userTierStore: tierStore,
      userFileCatalog: new MemoryUserFileCatalog(),
      uploadStore: new MemoryUploadObjectStore({ tokenSecret: UPLOAD_SECRET }),
      uploadTokenSecret: UPLOAD_SECRET,
    });
    gateway = await startServer(listener);
  }

  it('exchange stamps attrs.tier = default into the gateway JWT', async () => {
    await setup();
    const k = await firebaseKey();
    const idToken = await mintFirebaseToken(k);
    const r = await httpJson('POST', `${gateway!.url}/auth/firebase`, { body: { idToken } });
    expect(r.status).toBe(200);
    const json = r.json as { token: string; tier: string; userId: string };
    expect(json.tier).toBe('default');
    const claims = await verifyToken(json.token, SECRET);
    expect(claims.userId).toBe('firebase-uid-1');
    expect(claims.attrs['tier']).toBe('default');
    expect((await tierStore!.getRecord('firebase-uid-1'))?.email).toBe('user@example.com');
  });

  it('a pending promotion by email is consumed by the firebase exchange', async () => {
    await setup();
    await tierStore!.setTierByEmail('user@example.com', 'pro');
    const k = await firebaseKey();
    const idToken = await mintFirebaseToken(k);
    const r = await httpJson('POST', `${gateway!.url}/auth/firebase`, { body: { idToken } });
    expect(r.status).toBe(200);
    const json = r.json as { token: string; tier: string };
    expect(json.tier).toBe('pro');
    const claims = await verifyToken(json.token, SECRET);
    expect(claims.attrs['tier']).toBe('pro');
  });

  it('setTierByEmail after a first exchange → re-exchange stamps pro', async () => {
    await setup();
    const k = await firebaseKey();
    const idToken = await mintFirebaseToken(k);
    const first = await httpJson('POST', `${gateway!.url}/auth/firebase`, { body: { idToken } });
    expect(first.status).toBe(200);
    expect((first.json as { tier: string }).tier).toBe('default');
    // The first exchange created the record carrying the token's
    // email, so this updates the record (not a pending entry).
    const updated = await tierStore!.setTierByEmail('user@example.com', 'pro');
    expect(updated?.userId).toBe('firebase-uid-1');
    const second = await httpJson('POST', `${gateway!.url}/auth/firebase`, { body: { idToken } });
    expect(second.status).toBe(200);
    const json = second.json as { token: string; tier: string };
    expect(json.tier).toBe('pro');
    const claims = await verifyToken(json.token, SECRET);
    expect(claims.attrs['tier']).toBe('pro');
  });
});
