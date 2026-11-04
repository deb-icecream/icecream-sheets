import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngineListener } from '../src/services/engineSvc.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';
import { XlsxAdapter } from '@icecream-sheets/xlsx-adapter';

const BXL_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'test-data',
  'real-world',
  'beyond-excel-bxl3way.xlsx',
);

const ALICE = { 'x-principal': 'user:alice' };

describe('engine /session/olap-query (#114, Pieces 1+2)', () => {
  let svc: Started | null = null;

  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });

  async function loadBxl(): Promise<string> {
    svc = await startServer(createEngineListener());
    const bytes = readFileSync(BXL_PATH);
    const load = await httpJson('POST', `${svc.url}/load`, {
      headers: ALICE,
      body: { format: 'xlsx', data: bytes.toString('base64') },
    });
    expect(load.status).toBe(200);
    const status = await httpJson('GET', `${svc.url}/session/status`, { headers: ALICE });
    expect(status.status).toBe(200);
    const sid = (status.json as { sessionId: string }).sessionId;
    expect(typeof sid).toBe('string');
    return sid;
  }

  it('answers a filtered pivot query from the model built at load', async () => {
    const sid = await loadBxl();
    // pvtEarnings lives on Summaries (sheetId 16) — the sheet-qualified
    // lookup must NOT resolve the Cash Flow pvtCF or any other pivot.
    const q = await httpJson('POST', `${svc!.url}/session/olap-query`, {
      headers: ALICE,
      body: { sessionId: sid, pivotName: 'pvtEarnings', sheetId: 16, selected: ['2012', '2013'] },
    });
    expect(q.status).toBe(200);
    const body = q.json as {
      pivotName: string;
      sheetName: string;
      anchor: { startRow: number; startCol: number };
      valueLabels: string[];
      rowKeys: string[];
      data: number[][];
    };
    expect(body.pivotName).toBe('pvtEarnings');
    expect(body.sheetName).toBe('Summaries');
    expect(body.rowKeys).toEqual(['2012', '2013']);
    // Cached-oracle values from the file bytes (Summaries A6:D16):
    // 2012 Revenue/Gross Profit/EBT, 2013 same. Labels carry the
    // pivot definition's leading spaces verbatim.
    expect(body.data[0]).toEqual([102007, 62984, 3594]);
    expect(body.data[1]).toEqual([118086, 70082, 16649]);
    expect(body.valueLabels).toEqual([' Revenue', ' Gross Profit', ' Earnings Before Taxes']);
    // Anchor: Summaries A6:D16 -> 0-based (5, 0).
    expect(body.anchor.startRow).toBe(5);
    expect(body.anchor.startCol).toBe(0);
  });

  it('unfiltered query reproduces all ten cached years exactly', async () => {
    const sid = await loadBxl();
    const q = await httpJson('POST', `${svc!.url}/session/olap-query`, {
      headers: ALICE,
      body: { sessionId: sid, pivotName: 'pvtEarnings', sheetId: 16 },
    });
    expect(q.status).toBe(200);
    const body = q.json as { rowKeys: string[]; data: number[][] };
    expect(body.rowKeys).toEqual([
      '2012', '2013', '2014', '2015', '2016',
      '2017', '2018', '2019', '2020', '2021',
    ]);
    expect(body.data).toHaveLength(10);
    // 2021 cached row (float sums: close, not bitwise, tolerance).
    expect(body.data[9]![0]).toBeCloseTo(183415.99204328397, 6);
    expect(body.data[9]![1]).toBeCloseTo(119220.3948281346, 6);
    expect(body.data[9]![2]).toBeCloseTo(69239.30359613459, 6);
  });

  it('resolves the Summaries pvtCF (sheetId 16), not the Cash Flow one (sheetId 5)', async () => {
    const sid = await loadBxl();
    const q = await httpJson('POST', `${svc!.url}/session/olap-query`, {
      headers: ALICE,
      body: { sessionId: sid, pivotName: 'pvtCF', sheetId: 16, selected: ['2012'] },
    });
    expect(q.status).toBe(200);
    const body = q.json as { sheetName: string; valueLabels: string[]; data: number[][] };
    expect(body.sheetName).toBe('Summaries');
    // Summaries pvtCF value order: Cash from Operations, invested Cash
    // (sign-flipped: cached -15000 vs raw +15000), Cash from
    // Financing, Closing Cash Balance. Cached 2012 row, F6:J16.
    expect(body.valueLabels).toEqual([
      ' Cash from Operations',
      'invested Cash',
      'Cash from Financing',
      ' Closing Cash Balance',
    ]);
    expect(body.data[0]![0]).toBeCloseTo(12971.1792, 6);
    expect(body.data[0]![1]).toEqual(-15000);
    expect(body.data[0]![2]).toEqual(170000);
    expect(body.data[0]![3]).toBeCloseTo(167971.1792, 6);
  });

  it('refuses honestly: unknown pivot 404, model-less file 404, wrong session 404', async () => {
    const sid = await loadBxl();
    const unknown = await httpJson('POST', `${svc!.url}/session/olap-query`, {
      headers: ALICE,
      body: { sessionId: sid, pivotName: 'pvtNope' },
    });
    expect(unknown.status).toBe(404);
    const wrong = await httpJson('POST', `${svc!.url}/session/olap-query`, {
      headers: ALICE,
      body: { sessionId: 'sess_deadbeefdeadbeef', pivotName: 'pvtEarnings' },
    });
    expect(wrong.status).toBe(404);

    // Model-less file: plain workbook, no connections, no pivots.
    await stop(svc!);
    svc = await startServer(createEngineListener());
    const bytes = new XlsxAdapter().write({
      sheets: [{ name: 'Data', rows: [[1, 2]] }],
      metadata: {},
    });
    const load = await httpJson('POST', `${svc.url}/load`, {
      headers: ALICE,
      body: { format: 'xlsx', data: Buffer.from(bytes).toString('base64') },
    });
    expect(load.status).toBe(200);
    const status = await httpJson('GET', `${svc.url}/session/status`, { headers: ALICE });
    const sid2 = (status.json as { sessionId: string }).sessionId;
    const noModel = await httpJson('POST', `${svc.url}/session/olap-query`, {
      headers: ALICE,
      body: { sessionId: sid2, pivotName: 'pvtEarnings' },
    });
    expect(noModel.status).toBe(404);
  });
});
