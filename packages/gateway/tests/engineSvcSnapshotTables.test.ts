import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngineListener } from '../src/services/engineSvc.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

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

describe('engine /snapshot carries per-sheet tables (snapshot-join slicer fix, #69 Piece A)', () => {
  let svc: Started | null = null;

  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });

  it('snapshot sheets carry the adapter tables the /load response carries', async () => {
    svc = await startServer(createEngineListener());
    const bytes = readFileSync(BXL_PATH);
    const load = await httpJson('POST', `${svc.url}/load`, {
      headers: ALICE,
      body: { format: 'xlsx', data: bytes.toString('base64') },
    });
    expect(load.status).toBe(200);

    const snap = await httpJson('GET', `${svc.url}/snapshot`, { headers: ALICE });
    expect(snap.status).toBe(200);
    const sheets = (snap.json as { sheets: Array<{ name: string; tables?: Array<{ id?: number; sheet: string; startCol: number; columns: string[] }> }> }).sheets;
    const toc = sheets.find((s) => s.name === 'TOC');
    expect(toc).toBeDefined();
    // Adapter ground truth for this file: TOC tblTOC id 16, startCol 0,
    // columns [Name, Type, Title, Description] (table slicer cache
    // tableId 16, column 2 -> Title at startCol + 2).
    expect(toc!.tables).toEqual([
      { id: 16, sheet: 'TOC', startCol: 0, columns: ['Name', 'Type', 'Title', 'Description'] },
    ]);
    // A table-less sheet carries no tables key (not an empty list).
    const dashboard = sheets.find((s) => s.name === 'Dashboard');
    expect(dashboard).toBeDefined();
    expect(dashboard!.tables).toBeUndefined();
  });
});
