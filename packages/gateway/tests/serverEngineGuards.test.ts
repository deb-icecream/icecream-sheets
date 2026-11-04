/**
 * F-11 regression tests (security pass, 2026-10-22, Critical).
 *
 * Batch-11 formula functions reach out of the workbook through host
 * provider seams whose ENGINE defaults are live executors: PY() spawns
 * python3 with file-supplied code, WEBSERVICE()/IMPORT* spawn curl to
 * a formula-supplied URL, STOCKHISTORY/GOOGLEFINANCE spawn curl for
 * live market data. The server engine host (bin/engine.ts) installs
 * denying providers via installServerEngineGuards(); these tests prove
 * the guarded posture end-to-end through the real engine listener:
 * a crafted workbook's PY payload (which would write a sentinel file
 * and return 42 under the default provider) evaluates to the disabled
 * error, spawns nothing, and ordinary formulas still compute.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XlsxAdapter } from '@icecream-sheets/xlsx-adapter';
import { createEngineListener } from '../src/services/engineSvc.js';
import {
  MARKET_FETCH_DISABLED_ON_SERVER,
  PY_DISABLED_ON_SERVER,
  WEBSERVICE_DISABLED_ON_SERVER,
  installServerEngineGuards,
} from '../src/services/serverEngineGuards.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const ALICE = { 'x-principal': 'user:alice' };
const SENTINEL = join(tmpdir(), `secfix-f11-py-sentinel-${process.pid}.txt`);

describe('F-11: server engine guards deny batch-11 code-exec / network functions', () => {
  let svc: Started | null = null;

  beforeAll(() => {
    installServerEngineGuards();
    rmSync(SENTINEL, { force: true });
  });

  afterAll(async () => {
    if (svc) await stop(svc);
    svc = null;
    rmSync(SENTINEL, { force: true });
  });

  function post(path: string, body: unknown) {
    return httpJson('POST', `${svc!.url}${path}`, { headers: ALICE, body });
  }

  async function readCell(col: number): Promise<{ status: number; json: unknown }> {
    return post('/read', { kind: 'cell', ref: { sheet: 'Data', row: 0, col } });
  }

  it('PY / WEBSERVICE / STOCKHISTORY cells evaluate to the disabled errors and spawn nothing', async () => {
    svc = await startServer(createEngineListener());
    const pyCode =
      `import io; f = io.open('${SENTINEL}', 'w'); f.write('pwned'); f.close(); result = 42`;
    const bytes = new XlsxAdapter().write({
      sheets: [
        {
          name: 'Data',
          rows: [
            [
              `=PY("${pyCode}")`,
              '=WEBSERVICE("http://127.0.0.1:9/secfix-probe")',
              '=STOCKHISTORY("AAPL", "2024-01-01", "2024-01-10")',
              '=1+1',
            ],
          ],
        },
      ],
      metadata: {},
    });
    const load = await post('/load', {
      format: 'xlsx',
      data: Buffer.from(bytes).toString('base64'),
    });
    expect(load.status).toBe(200);
    expect(load.json).toMatchObject({ ok: true, sheets: ['Data'] });

    const py = await readCell(0);
    expect(py.status).toBe(200);
    expect((py.json as { value: { kind: string } }).value.kind).toBe('error');
    expect(JSON.stringify(py.json)).toContain(PY_DISABLED_ON_SERVER);
    expect(JSON.stringify(py.json)).not.toContain('"value":42');
    // The payload never ran: no python3 process wrote the sentinel.
    expect(existsSync(SENTINEL)).toBe(false);

    const ws = await readCell(1);
    expect((ws.json as { value: { kind: string } }).value.kind).toBe('error');
    expect(JSON.stringify(ws.json)).toContain(WEBSERVICE_DISABLED_ON_SERVER);

    const sh = await readCell(2);
    expect((sh.json as { value: { kind: string } }).value.kind).toBe('error');
    expect(JSON.stringify(sh.json)).toContain(MARKET_FETCH_DISABLED_ON_SERVER);

    // Ordinary formulas are unaffected by the guards.
    const plain = await readCell(3);
    expect((plain.json as { value: unknown }).value).toEqual({ kind: 'number', value: 2 });
  });
});
