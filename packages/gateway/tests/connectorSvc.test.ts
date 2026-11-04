/**
 * Connectors service: vault-backed secret storage + read-only sqlite
 * driver over HTTP. The vault is a STUB HTTP server here (in-memory
 * map honoring the vaultSvc ref-prefix rule) so the round-trip
 * store → tables → schema → query exercises the real seams: principal
 * forwarding, server-side ref derivation, and the statement allowlist.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createConnectorListener } from '../src/services/connectorSvc.js';

// See connectorSvc.ts: node:sqlite loads via createRequire (Vite's
// builtin list in this repo predates it).
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import { createVaultListener } from '../src/services/vaultSvc.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const ALICE = { 'x-principal': 'user:alice' };

let vaultSvc: Started | null = null;
let svc: Started | null = null;
let dbPath = '';

function seedDb(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE sales (order_id INTEGER PRIMARY KEY, region TEXT NOT NULL, revenue REAL NOT NULL);
    INSERT INTO sales VALUES (1, 'North', 10.5), (2, 'South', 20.25), (3, 'North', 30);
    CREATE VIEW north_sales AS SELECT * FROM sales WHERE region = 'North';
  `);
  db.close();
}

beforeEach(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'connector-svc-')), 'sales.db');
  seedDb(dbPath);
  vaultSvc = await startServer(createVaultListener());
  svc = await startServer(createConnectorListener({ vaultUrl: vaultSvc.url }));
});

afterEach(async () => {
  if (svc) await stop(svc);
  if (vaultSvc) await stop(vaultSvc);
  svc = null;
  vaultSvc = null;
});

const post = (p: string, body: unknown, headers: Record<string, string> = ALICE) =>
  httpJson('POST', `${svc!.url}${p}`, { headers, body });

async function storeConnection(connection = 'fixture', cs?: string) {
  return post('/sql/store-connection', {
    connection,
    connectionString: cs ?? `sqlite://${dbPath}`,
  });
}

describe('connectors service', () => {
  it('health', async () => {
    const r = await httpJson('GET', `${svc!.url}/health`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, service: 'connectors' });
  });

  it('credential/store derives the ref server-side from the principal', async () => {
    const r = await post('/credential/store', { name: 'api-token', secret: 'shh' });
    expect(r.status).toBe(200);
    expect((r.json as { ref: string }).ref).toBe('user:alice:ds:rest:api-token');
    const sql = await post('/credential/store', { name: 'db', secret: 'x', kind: 'sql' });
    expect((sql.json as { ref: string }).ref).toBe('user:alice:ds:sql:db');
    // The secret landed in the vault under exactly that ref.
    const got = await httpJson('POST', `${vaultSvc!.url}/retrieve`, {
      headers: ALICE,
      body: { ref: 'user:alice:ds:rest:api-token' },
    });
    expect((got.json as { secret: string }).secret).toBe('shh');
  });

  it('store → tables → schema → query round-trip', async () => {
    const stored = await storeConnection();
    expect(stored.status).toBe(200);
    expect((stored.json as { ref: string }).ref).toBe('user:alice:ds:sql:fixture');

    const tables = await post('/sql/tables', { connection: 'fixture' });
    expect(tables.status).toBe(200);
    const names = (tables.json as { tables: { name: string; type: string }[] }).tables;
    expect(names).toContainEqual({ name: 'sales', type: 'table' });
    expect(names).toContainEqual({ name: 'north_sales', type: 'view' });

    const schema = await post('/sql/schema', { connection: 'fixture', table: 'sales' });
    expect(schema.status).toBe(200);
    const s = schema.json as {
      columns: { name: string; type: string; notnull: boolean; pk: boolean }[];
      rowCount: number;
    };
    expect(s.rowCount).toBe(3);
    expect(s.columns).toEqual([
      { name: 'order_id', type: 'INTEGER', notnull: false, pk: true },
      { name: 'region', type: 'TEXT', notnull: true, pk: false },
      { name: 'revenue', type: 'REAL', notnull: true, pk: false },
    ]);

    const q = await post('/sql/query', {
      connection: 'fixture',
      query: 'SELECT region, SUM(revenue) AS total FROM sales GROUP BY region ORDER BY region',
      params: [],
    });
    expect(q.status).toBe(200);
    const res = q.json as { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean };
    expect(res.columns).toEqual(['region', 'total']);
    expect(res.truncated).toBe(false);
    expect(res.rows).toEqual([
      { region: 'North', total: 40.5 },
      { region: 'South', total: 20.25 },
    ]);

    // WITH…SELECT and bound params work too.
    const w = await post('/sql/query', {
      connection: 'fixture',
      query: 'WITH n AS (SELECT * FROM sales WHERE region = ?) SELECT COUNT(*) AS c FROM n',
      params: ['North'],
    });
    expect(w.status).toBe(200);
    expect((w.json as { rows: Record<string, unknown>[] }).rows).toEqual([{ c: 2 }]);
  });

  it('accepts sqlite:, bare absolute path connection forms', async () => {
    expect((await storeConnection('a', `sqlite:${dbPath}`)).status).toBe(200);
    expect((await post('/sql/tables', { connection: 'a' })).status).toBe(200);
    expect((await storeConnection('b', dbPath)).status).toBe(200);
    expect((await post('/sql/tables', { connection: 'b' })).status).toBe(200);
  });

  it('rejects non-sqlite schemes with a clear error', async () => {
    const r = await storeConnection('pg', 'postgres://user@host/db');
    expect(r.status).toBe(400);
    expect((r.json as { error: string }).error).toMatch(/only the sqlite driver ships/);
    const rel = await storeConnection('rel', 'relative/path.db');
    expect(rel.status).toBe(400);
  });

  it('rejects write / multi statements and leaves the data untouched', async () => {
    await storeConnection();
    for (const bad of [
      'INSERT INTO sales VALUES (9, \'X\', 1)',
      'DELETE FROM sales',
      'DROP TABLE sales',
      'UPDATE sales SET revenue = 0',
      'SELECT * FROM sales; DROP TABLE sales',
      'WITH x AS (SELECT 1) DELETE FROM sales',
      'PRAGMA user_version = 3',
    ]) {
      const r = await post('/sql/query', { connection: 'fixture', query: bad, params: [] });
      expect(r.status, bad).toBe(400);
    }
    const q = await post('/sql/query', { connection: 'fixture', query: 'SELECT COUNT(*) AS c FROM sales', params: [] });
    expect((q.json as { rows: Record<string, unknown>[] }).rows).toEqual([{ c: 3 }]);
  });

  it('unknown connection → clear 404; unknown table → 404', async () => {
    const r = await post('/sql/tables', { connection: 'nope' });
    expect(r.status).toBe(404);
    expect((r.json as { error: string }).error).toMatch(/unknown connection "nope"/);
    await storeConnection();
    const s = await post('/sql/schema', { connection: 'fixture', table: 'missing' });
    expect(s.status).toBe(404);
    expect((s.json as { error: string }).error).toMatch(/unknown table "missing"/);
  });

  it("one principal cannot use another principal's connection", async () => {
    await storeConnection();
    const bob = await post('/sql/tables', { connection: 'fixture' }, { 'x-principal': 'user:bob' });
    expect(bob.status).toBe(404);
  });
});
