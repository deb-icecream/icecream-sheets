/**
 * Product layer (Worker B): POST /load/storage-ref — engine
 * load-by-storage-reference (hidden_files/product-layer/CONTRACT.md
 * §"Engine endpoint").
 *
 * Bytes resolve via the local upload store (UPLOAD_STORE_DIR; a temp
 * dir here, seeded with a real xlsx produced by the repo's XlsxAdapter —
 * the same way engineSvc.test.ts obtains workbook bytes) or via an
 * injected prod upload-object reader. After resolution the route runs
 * the IDENTICAL /load post-bytes tail, so the response is the /load
 * response plus `storageRef: { bucket, object }`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { XlsxAdapter } from '@icecream-sheets/xlsx-adapter';
import type { TypedValue } from '@icecream-sheets/engine';
import { createEngineListener, sheetNameFromCsvFileName } from '../src/services/engineSvc.js';
import { issueEngineAccessToken } from '../src/deploy/engineAccess.js';
import { MemorySessionStores } from '../src/deploy/sessionStore.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const SECRET = 'test-engine-access-secret';
const ALICE = { 'x-principal': 'user:alice' };
const OBJECT = 'uploads/ab12/file-seeded.xlsx';
const CSV_OBJECT = 'uploads/ab12/sales.csv';

/**
 * CSV fixture for the conversion battery: header + text, integer,
 * decimal and TRUE/FALSE cells. The `amount` column sums to exactly
 * 695.64 (19.98 + 179.91 + 472 + 23.75 — exact in JS doubles).
 */
const CSV_TEXT = [
  'item,amount,in_stock',
  'Widget,19.98,TRUE',
  'Gadget,179.91,FALSE',
  'Gizmo,472,TRUE',
  'Doohickey,23.75,TRUE',
  '',
].join('\n');

/** A small real workbook: Data!A1 = 41, Data!B1 = =A1+1 → 42. */
function workbookBytes(): Uint8Array {
  return new XlsxAdapter().write({
    sheets: [{ name: 'Data', rows: [[41, '=A1+1']] }],
    metadata: {},
  });
}

describe('engine service — POST /load/storage-ref (product layer)', () => {
  let svc: Started | null = null;
  let root: string | null = null;
  let storeDir: string | null = null;

  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
    storeDir = null;
  });

  /** Temp layout: <root>/uploads-store is UPLOAD_STORE_DIR; the seeded
   *  workbook lives at <root>/uploads-store/<OBJECT>; a "secret" file
   *  OUTSIDE the store proves traversal is rejected, not resolved. */
  function seedStore(): string {
    root = mkdtempSync(join(tmpdir(), 'upload-store-'));
    storeDir = join(root, 'uploads-store');
    const target = join(storeDir, OBJECT);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, workbookBytes());
    const csvTarget = join(storeDir, CSV_OBJECT);
    mkdirSync(dirname(csvTarget), { recursive: true });
    writeFileSync(csvTarget, CSV_TEXT);
    writeFileSync(join(root, 'secret.xlsx'), workbookBytes());
    return storeDir;
  }

  async function setupLocal(extraEnv: Record<string, string> = {}) {
    const dir = seedStore();
    svc = await startServer(
      createEngineListener({
        sessionStores: new MemorySessionStores(),
        fileRegistry: null,
        libraryDir: join(root!, 'library'),
        deployEnv: { UPLOAD_STORE_DIR: dir, ...extraEnv } as NodeJS.ProcessEnv,
      }),
    );
  }

  function post(path: string, body: unknown, headers: Record<string, string> = ALICE) {
    return httpJson('POST', `${svc!.url}${path}`, { headers, body });
  }

  it('loads a seeded object by reference: /load-shaped response + storageRef echo, follow-up /read serves a known cell', async () => {
    await setupLocal();
    const r = await post('/load/storage-ref', { object: OBJECT });
    expect(r.status).toBe(200);
    const json = r.json as {
      ok: boolean;
      sheets: string[];
      sessionId?: string;
      storageRef?: { bucket: string; object: string };
      file: { sheets: Array<{ name: string }> };
    };
    expect(json.ok).toBe(true);
    expect(json.sheets).toEqual(['Data']);
    expect(json.file.sheets.map((s) => s.name)).toEqual(['Data']);
    expect(json.sessionId).toMatch(/^sess_/);
    // No bucket named → the configured default bucket is echoed.
    expect(json.storageRef).toEqual({ bucket: 'icecream-uploads', object: OBJECT });

    const rd = await post('/read', { kind: 'cell', ref: { sheet: 'Data', row: 0, col: 0 } });
    expect(rd.status).toBe(200);
    expect((rd.json as { value: TypedValue }).value).toEqual({ kind: 'number', value: 41 });
    const f = await post('/read', { kind: 'cell', ref: { sheet: 'Data', row: 0, col: 1 } });
    expect((f.json as { value: TypedValue }).value).toEqual({ kind: 'number', value: 42 });
    expect((f.json as { formula?: string }).formula).toBe('=A1+1');
  });

  it('accepts an explicit bucket equal to the configured bucket', async () => {
    await setupLocal();
    const r = await post('/load/storage-ref', { bucket: 'icecream-uploads', object: OBJECT, format: 'xlsx' });
    expect(r.status).toBe(200);
    expect((r.json as { storageRef?: unknown }).storageRef).toEqual({
      bucket: 'icecream-uploads',
      object: OBJECT,
    });
  });

  it('missing object → 404 storage object not found', async () => {
    await setupLocal();
    const r = await post('/load/storage-ref', { object: 'uploads/nope/missing.xlsx' });
    expect(r.status).toBe(404);
    expect(r.json).toMatchObject({ ok: false, error: 'storage object not found' });
  });

  it('bucket mismatch → 400', async () => {
    await setupLocal();
    const r = await post('/load/storage-ref', { bucket: 'someone-elses-bucket', object: OBJECT });
    expect(r.status).toBe(400);
    expect((r.json as { error: string }).error).toContain('bucket');
  });

  it('path traversal / absolute / backslash object keys → 400 (never resolved)', async () => {
    await setupLocal();
    // '../secret.xlsx' EXISTS just outside the store dir — a traversal
    // bug would load it and answer 200; the route must refuse with 400.
    for (const object of ['../secret.xlsx', 'uploads/../../secret.xlsx', '/secret.xlsx', 'uploads\\..\\secret.xlsx']) {
      const r = await post('/load/storage-ref', { object });
      expect(r.status, `object=${object}`).toBe(400);
    }
  });

  it("unsupported format → 400 on /load/storage-ref and /load (only 'xlsx' and 'csv')", async () => {
    await setupLocal();
    const r = await post('/load/storage-ref', { object: OBJECT, format: 'ods' });
    expect(r.status).toBe(400);
    expect((r.json as { error: string }).error).toContain("only formats 'xlsx' and 'csv'");

    const direct = await post('/load', {
      format: 'ods',
      data: Buffer.from(CSV_TEXT).toString('base64'),
    });
    expect(direct.status).toBe(400);
    expect((direct.json as { error: string }).error).toContain("only formats 'xlsx' and 'csv'");
  });

  it('CSV via storage-ref: converts to a workbook named from the file, sourceFormat echoed, typed reads back', async () => {
    await setupLocal();
    const r = await post('/load/storage-ref', { object: CSV_OBJECT, format: 'csv', name: 'sales.csv' });
    expect(r.status).toBe(200);
    const json = r.json as {
      ok: boolean;
      sheets: string[];
      sessionId?: string;
      sourceFormat?: string;
      storageRef?: { bucket: string; object: string };
      file: { sheets: Array<{ name: string }> };
    };
    expect(json.ok).toBe(true);
    expect(json.sheets).toEqual(['sales']);
    expect(json.file.sheets.map((s) => s.name)).toEqual(['sales']);
    expect(json.sourceFormat).toBe('csv');
    expect(json.sessionId).toMatch(/^sess_/);
    expect(json.storageRef).toEqual({ bucket: 'icecream-uploads', object: CSV_OBJECT });

    const cell = (row: number, col: number) =>
      post('/read', { kind: 'cell', ref: { sheet: 'sales', row, col } });
    // Header row stays strings.
    expect(((await cell(0, 0)).json as { value: TypedValue }).value).toEqual({
      kind: 'string',
      value: 'item',
    });
    // Text cell.
    expect(((await cell(1, 0)).json as { value: TypedValue }).value).toEqual({
      kind: 'string',
      value: 'Widget',
    });
    // Decimal cell.
    expect(((await cell(1, 1)).json as { value: TypedValue }).value).toEqual({
      kind: 'number',
      value: 19.98,
    });
    // Integer cell.
    expect(((await cell(3, 1)).json as { value: TypedValue }).value).toEqual({
      kind: 'number',
      value: 472,
    });
    // TRUE / FALSE cells.
    expect(((await cell(1, 2)).json as { value: TypedValue }).value).toEqual({
      kind: 'boolean',
      value: true,
    });
    expect(((await cell(2, 2)).json as { value: TypedValue }).value).toEqual({
      kind: 'boolean',
      value: false,
    });
  });

  it('CSV conversion calculates: =SUM over the converted numeric column gives the exact total', async () => {
    await setupLocal();
    const r = await post('/load/storage-ref', { object: CSV_OBJECT, format: 'csv', name: 'sales.csv' });
    expect(r.status).toBe(200);

    const ex = await post('/execute', {
      cmd: { cmd: 'setFormula', ref: { sheet: 'sales', row: 5, col: 1 }, formula: '=SUM(B2:B5)' },
    });
    expect(ex.status).toBe(200);
    expect(ex.json).toEqual({ ok: true });

    const rd = await post('/read', { kind: 'cell', ref: { sheet: 'sales', row: 5, col: 1 } });
    expect(rd.status).toBe(200);
    expect((rd.json as { value: TypedValue }).value).toEqual({ kind: 'number', value: 695.64 });
    expect((rd.json as { formula?: string }).formula).toBe('=SUM(B2:B5)');
  });

  it('save after CSV load produces xlsx bytes (PK), not a source-package failure', async () => {
    await setupLocal();
    const r = await post('/load/storage-ref', { object: CSV_OBJECT, format: 'csv', name: 'sales.csv' });
    expect(r.status).toBe(200);

    const save = await post('/library-save', { name: 'sales.xlsx' });
    expect(save.status).toBe(200);
    expect(JSON.stringify(save.json)).not.toContain('source package unreadable');
    const { entry } = save.json as { entry: { id: string; name: string; sizeBytes: number } };
    expect(entry.name).toBe('sales.xlsx');
    expect(entry.sizeBytes).toBeGreaterThan(0);

    const fetched = await fetch(`${svc!.url}/library/${entry.id}`, { headers: ALICE });
    expect(fetched.status).toBe(200);
    const bytes = new Uint8Array(await fetched.arrayBuffer());
    // xlsx is a zip package: magic 'PK'.
    expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe('PK');
    // And it parses back as the converted workbook.
    const back = new XlsxAdapter().read(bytes);
    expect(back.sheets.map((s) => s.name)).toEqual(['sales']);
    expect(back.sheets[0]!.rows[1]![1]).toBe(19.98);
  });

  it('CSV via POST /load (base64): sheet named from the supplied name', async () => {
    await setupLocal();
    const r = await post('/load', {
      format: 'csv',
      name: 'sales.csv',
      data: Buffer.from(CSV_TEXT).toString('base64'),
    });
    expect(r.status).toBe(200);
    const json = r.json as { ok: boolean; sheets: string[]; sourceFormat?: string };
    expect(json.ok).toBe(true);
    expect(json.sheets).toEqual(['sales']);
    expect(json.sourceFormat).toBe('csv');

    const rd = await post('/read', { kind: 'cell', ref: { sheet: 'sales', row: 3, col: 1 } });
    expect((rd.json as { value: TypedValue }).value).toEqual({ kind: 'number', value: 472 });
  });

  it('signed mode: body.sessionId must equal token.sid (identical to /load), then the load proceeds', async () => {
    await setupLocal({ ENGINE_ACCESS_MODE: 'signed', ENGINE_ACCESS_SECRET: SECRET });
    const sid = 'sess_ref';
    const token = issueEngineAccessToken({
      secret: SECRET,
      principal: 'user:alice',
      sessionId: sid,
      tier: 'standard',
      ttlSeconds: 600,
    }).token;
    const auth = { authorization: `Bearer ${token}` };

    const wrong = await post('/load/storage-ref', { object: OBJECT, sessionId: 'sess_elsewhere' }, auth);
    expect(wrong.status).toBe(401);
    expect((wrong.json as { error: string }).error).toContain('wrong-session');

    const missing = await post('/load/storage-ref', { object: OBJECT }, auth);
    expect(missing.status).toBe(401);

    const ok = await post('/load/storage-ref', { object: OBJECT, sessionId: sid }, auth);
    expect(ok.status).toBe(200);
    expect((ok.json as { sessionId?: string }).sessionId).toBe(sid);
    expect((ok.json as { storageRef?: unknown }).storageRef).toEqual({
      bucket: 'icecream-uploads',
      object: OBJECT,
    });

    const rd = await post('/read', { kind: 'cell', ref: { sheet: 'Data', row: 0, col: 0 } }, auth);
    expect((rd.json as { value: TypedValue }).value).toEqual({ kind: 'number', value: 41 });
  });

  it('injected prod reader: bytes come from the dep (nothing on local disk), its bucket is the configured bucket, null → 404', async () => {
    const bytes = workbookBytes();
    svc = await startServer(
      createEngineListener({
        sessionStores: new MemorySessionStores(),
        fileRegistry: null,
        deployEnv: {} as NodeJS.ProcessEnv,
        uploadObjects: {
          bucket: 'prod-uploads-bucket',
          get: async (object: string) => (object === 'injected.xlsx' ? bytes : null),
        },
      }),
    );
    const r = await post('/load/storage-ref', { bucket: 'prod-uploads-bucket', object: 'injected.xlsx' });
    expect(r.status).toBe(200);
    expect((r.json as { sheets: string[] }).sheets).toEqual(['Data']);
    expect((r.json as { storageRef?: unknown }).storageRef).toEqual({
      bucket: 'prod-uploads-bucket',
      object: 'injected.xlsx',
    });

    const wrongBucket = await post('/load/storage-ref', { bucket: 'icecream-uploads', object: 'injected.xlsx' });
    expect(wrongBucket.status).toBe(400);

    const missing = await post('/load/storage-ref', { object: 'absent.xlsx' });
    expect(missing.status).toBe(404);
    expect(missing.json).toMatchObject({ ok: false, error: 'storage object not found' });
  });
});

describe('sheetNameFromCsvFileName', () => {
  it("strips the extension: 'sales.csv' → 'sales'", () => {
    expect(sheetNameFromCsvFileName('sales.csv')).toBe('sales');
  });

  it("replaces Excel-invalid sheet-name characters with '_'", () => {
    expect(sheetNameFromCsvFileName('my:weird/name.csv')).toBe('my_weird_name');
  });

  it('caps the stem at 31 characters', () => {
    const name = sheetNameFromCsvFileName(`${'a'.repeat(40)}.csv`);
    expect(name).toBe('a'.repeat(31));
    expect(name.length).toBe(31);
  });

  it("returns '' for a bare '.csv' (caller falls back to the adapter default)", () => {
    expect(sheetNameFromCsvFileName('.csv')).toBe('');
  });
});
