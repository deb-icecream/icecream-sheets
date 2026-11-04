import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XlsxAdapter, decodeFormatsWire, type FormatsWire } from '@icecream-sheets/xlsx-adapter';
import type { TypedValue, WorkbookSnapshot } from '@icecream-sheets/engine';
import { computeAckChecksum, getGoogleApiCredential, setGoogleApiCredential, listCubes, type EditAck } from '@icecream-sheets/engine';
import { createEngineListener } from '../src/services/engineSvc.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const P75_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test-data', 'perf-fixtures', 'perf-p75.xlsx');



const ALICE = { 'x-principal': 'user:alice' };
const OWNER = { 'x-principal': 'user:owner' };
const CELL_A1 = { sheet: 'Sheet1', row: 0, col: 0 }; // 0-based: row 0/col 0 = A1
const CELL_B1 = { sheet: 'Sheet1', row: 0, col: 1 };

describe('engine service', () => {
  let svc: Started | null = null;

  async function setup() {
    svc = await startServer(createEngineListener());
  }

  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });

  function post(path: string, body: unknown, headers: Record<string, string> = ALICE) {
    return httpJson('POST', `${svc!.url}${path}`, { headers, body });
  }

  it('health', async () => {
    await setup();
    const r = await httpJson('GET', `${svc!.url}/health`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, service: 'engine' });
  });

  it('execute → read round-trip', async () => {
    await setup();
    const ex = await post('/execute', {
      cmd: { cmd: 'setCell', ref: CELL_A1, value: 42 },
    });
    expect(ex.status).toBe(200);
    expect(ex.json).toEqual({ ok: true });

    const rd = await post('/read', { kind: 'cell', ref: CELL_A1 });
    expect(rd.status).toBe(200);
    const { value, formula } = rd.json as { value: TypedValue; formula?: string };
    expect(value).toEqual({ kind: 'number', value: 42 });
    expect(formula).toBeUndefined();
  });

  it('read cell exposes formula text when the cell holds one', async () => {
    await setup();
    await post('/execute', { cmd: { cmd: 'setCell', ref: CELL_A1, value: 21 } });
    await post('/execute', {
      cmd: { cmd: 'setFormula', ref: CELL_B1, formula: '=A1*2' },
    });
    const rd = await post('/read', { kind: 'cell', ref: CELL_B1 });
    const { value, formula } = rd.json as { value: TypedValue; formula?: string };
    expect(value).toEqual({ kind: 'number', value: 42 });
    expect(formula).toBe('=A1*2');
  });

  it('read range returns values + parallel formulas array', async () => {
    await setup();
    await post('/execute', { cmd: { cmd: 'setCell', ref: CELL_A1, value: 5 } });
    await post('/execute', {
      cmd: { cmd: 'setFormula', ref: CELL_B1, formula: '=A1+1' },
    });
    const rd = await post('/read', {
      kind: 'range',
      range: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 1 },
    });
    const { values, formulas } = rd.json as { values: TypedValue[][]; formulas: (string | null)[][] };
    expect(values[0][0]).toEqual({ kind: 'number', value: 5 });
    expect(values[0][1]).toEqual({ kind: 'number', value: 6 });
    expect(formulas).toEqual([[null, '=A1+1']]);
  });

  it('read sheet and usedrange', async () => {
    await setup();
    await post('/execute', { cmd: { cmd: 'setCell', ref: CELL_A1, value: 'hi' } });
    const sheet = await post('/read', { kind: 'sheet', sheet: 'Sheet1' });
    const { values } = sheet.json as { values: TypedValue[][] };
    expect(values[0][0]).toEqual({ kind: 'string', value: 'hi' });
    const ur = await post('/read', { kind: 'usedrange', sheet: 'Sheet1' });
    expect(ur.json).toEqual({
      range: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
    });
  });

  it('events polling returns sequenced engine events', async () => {
    await setup();
    await post('/execute', { cmd: { cmd: 'setCell', ref: CELL_A1, value: 1 } });
    await post('/execute', { cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 0 }, value: 2 } });
    const r = await httpJson('GET', `${svc!.url}/events?since=0`, { headers: ALICE });
    expect(r.status).toBe(200);
    const { events } = r.json as { events: { seq: number; event: { type: string } }[] };
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0].seq).toBe(1);
    expect(events[0].event.type).toBe('cellsChanged');
    // Polling with since= filters to newer events only.
    const lastSeq = events[events.length - 1].seq;
    const r2 = await httpJson('GET', `${svc!.url}/events?since=${lastSeq}`, { headers: ALICE });
    expect((r2.json as { events: unknown[] }).events).toEqual([]);
  });

  it('protection: hidden read denied for non-exempt principal, visible to owner', async () => {
    await setup();
    await post('/execute', { cmd: { cmd: 'setCell', ref: CELL_A1, value: 'secret' } });
    const hide = await post('/protection/hide', { sheet: 'Sheet1', ranges: ['A1'] }, OWNER);
    expect(hide.status).toBe(200);

    const denied = await post('/read', { kind: 'cell', ref: CELL_A1 }, ALICE);
    const { value } = denied.json as { value: TypedValue };
    expect(value.kind).toBe('error');
    expect((value as { code: string }).code).toBe('#PERM!');

    const allowed = await post('/read', { kind: 'cell', ref: CELL_A1 }, OWNER);
    expect((allowed.json as { value: TypedValue }).value).toEqual({ kind: 'string', value: 'secret' });
  });

  it('snapshot is permission-filtered per principal', async () => {
    await setup();
    await post('/execute', { cmd: { cmd: 'setCell', ref: CELL_A1, value: 'secret' } });
    await post(
      '/execute',
      { cmd: { cmd: 'setCell', ref: CELL_B1, value: 'public' } },
      OWNER,
    );
    await post('/protection/hide', { sheet: 'Sheet1', ranges: ['A1'] }, OWNER);

    const asAlice = await httpJson('GET', `${svc!.url}/snapshot`, { headers: ALICE });
    const snapAlice = asAlice.json as WorkbookSnapshot;
    const cellsAlice = snapAlice.sheets.find((s) => s.name === 'Sheet1')!.cells;
    expect(cellsAlice.some((c) => c.ref.row === 0 && c.ref.col === 0)).toBe(false); // hidden dropped
    expect(cellsAlice.some((c) => c.ref.row === 0 && c.ref.col === 1)).toBe(true);

    const asOwner = await httpJson('GET', `${svc!.url}/snapshot`, { headers: OWNER });
    const snapOwner = asOwner.json as WorkbookSnapshot;
    const cellsOwner = snapOwner.sheets.find((s) => s.name === 'Sheet1')!.cells;
    expect(cellsOwner.some((c) => c.ref.row === 0 && c.ref.col === 0)).toBe(true); // owner sees all
  });

  it('protection: locked cells reject writes', async () => {
    await setup();
    const p = await post('/protection/protect', { sheet: 'Sheet1', lockedRanges: ['A1'] }, OWNER);
    expect(p.status).toBe(200);
    const denied = await post('/execute', { cmd: { cmd: 'setCell', ref: CELL_A1, value: 1 } }, ALICE);
    expect(denied.json).toEqual({ ok: false, error: expect.stringContaining('Denied by policy') });
  });

  it('load parses an xlsx and replaces the workbook', async () => {
    await setup();
    await post('/execute', { cmd: { cmd: 'setCell', ref: CELL_A1, value: 'old' } });
    const bytes = new XlsxAdapter().write({
      sheets: [{ name: 'Data', rows: [[1, 2], ['=A1+B1', 'x']] }],
      metadata: {},
    });
    const b64 = Buffer.from(bytes).toString('base64');
    const load = await post('/load', { format: 'xlsx', data: b64 });
    expect(load.status).toBe(200);
    expect(load.json).toMatchObject({ ok: true, sheets: ['Data'] });
    const payload = load.json as {
      file: { sheets: Array<{ name: string }> };
      columnCounts: Record<string, number[]>;
    };
    expect(payload.file.sheets.map((s) => s.name)).toEqual(['Data']);
    expect(payload.columnCounts['Data']).toEqual([2, 2]);

    const rd = await post('/read', { kind: 'cell', ref: { sheet: 'Data', row: 0, col: 0 } });
    expect((rd.json as { value: TypedValue }).value).toEqual({ kind: 'number', value: 1 });
    // Formula survived the load.
    const f = await post('/read', { kind: 'cell', ref: { sheet: 'Data', row: 1, col: 0 } });
    expect((f.json as { formula?: string }).formula).toBe('=A1+B1');
  });

  it('load rejects non-xlsx bytes', async () => {
    await setup();
    const bad = await post('/load', { format: 'xlsx', data: Buffer.from('not a zip').toString('base64') });
    expect(bad.status).toBe(400);
  });

  it('load preserves defined names, number formats and metadata (Cycle 10 parity)', async () => {
    await setup();
    const bytes = new XlsxAdapter().write({
      sheets: [
        {
          name: 'Data',
          rows: [[3, '=Cost*2']],
          formats: { '0:0': '#,##0.00' },
        },
      ],
      metadata: { 'icecream.pagesetup.Data': JSON.stringify({ orientation: 'landscape' }) },
      // NB: the name must not collide with an Excel function (RATE, etc.).
      definedNames: [{ name: 'Cost', ref: 'Data!$A$1' }],
    });
    const load = await post('/load', { format: 'xlsx', data: Buffer.from(bytes).toString('base64') });
    expect(load.status).toBe(200);
    const payload = load.json as {
      file: {
        sheets: Array<{ name: string; formats: FormatsWire }>;
        metadata: Record<string, unknown>;
        definedNames?: Array<{ name: string; ref: string }>;
      };
    };
    // The browser hydrates its FormatStore from this payload — formats must
    // survive the round trip through the run-length wire encoding.
    expect(decodeFormatsWire(payload.file.sheets[0]!.formats)).toEqual({ '0:0': '#,##0.00' });
    expect(payload.file.definedNames).toContainEqual({ name: 'Cost', ref: 'Data!$A$1' });
    expect(payload.file.metadata['icecream.pagesetup.Data']).toContain('landscape');
    // The defined name reached the server-side engine workbook: =Cost*2 → 6.
    const rd = await post('/read', { kind: 'cell', ref: { sheet: 'Data', row: 0, col: 1 } });
    expect((rd.json as { value: TypedValue }).value).toEqual({ kind: 'number', value: 6 });
    // Below-flag workbook (2 cells ≤ 5000): a COMPLETE local mirror ships
    // with the open — formula (input), cached value, and data type.
    const mirror = (load.json as { mirror?: unknown }).mirror as
      | { sheets: Array<{ name: string; cells: Array<{ row: number; col: number; input: unknown; value: TypedValue }> }> }
      | undefined;
    expect(mirror).toBeTruthy();
    const mSheet = mirror!.sheets.find((s) => s.name === 'Data')!;
    const formulaCell = mSheet.cells.find((c) => c.row === 0 && c.col === 1)!;
    expect(formulaCell.input).toBe('=Cost*2');
    expect(formulaCell.value).toEqual({ kind: 'number', value: 6 });
    const literalCell = mSheet.cells.find((c) => c.row === 0 && c.col === 0)!;
    expect(literalCell.input).toBe(3);
    expect(literalCell.value).toEqual({ kind: 'number', value: 3 });
  });

  it('load mirror (bulk readback) matches per-cell reads cell-for-cell', async () => {
    await setup();
    const bytes = new XlsxAdapter().write({
      sheets: [
        { name: 'A', rows: [[2, '=A1*3', 'x'], ['=B1+1', 5, null]] },
        { name: 'B', rows: [['=A!B1*2', null, '=SUM(A!A1:A!B2)']] },
      ],
      metadata: {},
    });
    const load = await post('/load', { format: 'xlsx', data: Buffer.from(bytes).toString('base64') });
    expect(load.status).toBe(200);
    const mirror = (load.json as {
      mirror?: { sheets: Array<{ name: string; cells: Array<{ row: number; col: number; input: unknown; value: TypedValue }> }> };
    }).mirror!;
    expect(mirror).toBeTruthy();
    // Every sheet ships (empty-cell-free sheets included), and every
    // mirrored cell's value equals the authorized per-cell read.
    expect(mirror.sheets.map((s) => s.name)).toEqual(['A', 'B']);
    let count = 0;
    for (const sheet of mirror.sheets) {
      for (const cell of sheet.cells) {
        count++;
        const rd = await post('/read', { kind: 'cell', ref: { sheet: sheet.name, row: cell.row, col: cell.col } });
        expect((rd.json as { value: TypedValue }).value).toEqual(cell.value);
      }
    }
    expect(count).toBe(7); // 5 non-empty in A + 2 in B
  });

  it('workbooks above the mirror flag ship NO mirror (server calc only)', async () => {
    await setup();
    // 100 × 60 = 6,000 cells > 5,000 flag.
    const rows: number[][] = [];
    for (let r = 0; r < 100; r++) rows.push(Array.from({ length: 60 }, (_, c) => r * 60 + c));
    const bytes = new XlsxAdapter().write({ sheets: [{ name: 'Big', rows }], metadata: {} });
    const load = await post('/load', { format: 'xlsx', data: Buffer.from(bytes).toString('base64') });
    expect(load.status).toBe(200);
    expect((load.json as { mirror?: unknown }).mirror).toBeUndefined();
    expect((load.json as { sheets: string[] }).sheets).toEqual(['Big']);
  });

  it('GET /sheets returns sheet names without a snapshot', async () => {
    await setup();
    const bytes = new XlsxAdapter().write({
      sheets: [
        { name: 'First', rows: [[1]] },
        { name: 'Second', rows: [[2]] },
      ],
      metadata: {},
    });
    await post('/load', { format: 'xlsx', data: Buffer.from(bytes).toString('base64') });
    const r = await httpJson('GET', `${svc!.url}/sheets`, { headers: ALICE });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ sheets: ['First', 'Second'] });
  });

  it('POST /language switches the server engine formula language', async () => {
    await setup();
    const bytes = new XlsxAdapter().write({
      sheets: [{ name: 'Sheet1', rows: [[1, 2]] }],
      metadata: {},
    });
    await post('/load', { format: 'xlsx', data: Buffer.from(bytes).toString('base64') });
    const lang = await post('/language', { locale: 'frFR' });
    expect(lang.status).toBe(200);
    expect(lang.json).toEqual({ ok: true });
    // Formulas stored afterwards are parsed/rendered in the new locale.
    await post('/execute', {
      cmd: { cmd: 'setFormula', ref: { sheet: 'Sheet1', row: 0, col: 0 }, formula: '=SOMME(B1)' },
    });
    const rd = await post('/read', { kind: 'cell', ref: { sheet: 'Sheet1', row: 0, col: 0 } });
    expect((rd.json as { formula: string }).formula).toContain('SOMME');
    const bad = await post('/language', {});
    expect(bad.status).toBe(400);
  });

  it('load of the real P75 fixture registers pivot cubes and carries raw pivot parts', async () => {
    await setup();
    const bytes = new Uint8Array(readFileSync(P75_PATH));
    expect(bytes.length).toBeGreaterThan(1024 * 1024); // > the old 1MB body cap
    const load = await post('/load', { format: 'xlsx', data: Buffer.from(bytes).toString('base64') });
    expect(load.status).toBe(200);
    const payload = load.json as {
      sheets: string[];
      file: { metadata: Record<string, unknown> };
    };
    expect(payload.sheets.length).toBe(13);
    // Raw pivot parts travel intact (base64 string carriers in adapter
    // metadata): the client decodes them back for the save round-trip.
    const pivotParts = payload.file.metadata['xlsx.pivotParts'] as {
      parts: Record<string, string>;
    };
    expect(pivotParts).toBeTruthy();
    const anyPart = Object.values(pivotParts.parts)[0]!;
    expect(typeof anyPart).toBe('string');
    expect(Buffer.from(anyPart, 'base64').toString('utf8')).toContain('pivotTableDefinition');
    // bxl3way's pivots were all saved with saveData="0" (no cache
    // records): like the local open flow, they surface as notices and
    // register NO cubes — registration is verified with a records-carrying
    // pivot in the next test.
    expect(listCubes().length).toBe(0);
    // The metadata payload also carries the file's defined names (39).
    const withNames = load.json as { file: { definedNames?: unknown[] } };
    expect(withNames.file.definedNames?.length).toBe(39);
  });

  it('load registers imported pivots with cached records in the engine registries', async () => {
    await setup();
    // A real pivot fixture whose cache carries records (unlike bxl3way's
    // saveData="0" pivots, which surface as notices and register nothing —
    // exactly like the web app's local open flow).
    const bytes = new Uint8Array(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test-data', 'real-world', 'closedxml-xlsx-pivottable_bool_field_filter.xlsx'),
      ),
    );
    const load = await post('/load', { format: 'xlsx', data: Buffer.from(bytes).toString('base64') });
    expect(load.status).toBe(200);
    // The pivot is registered as an OLAP cube in the engine process, so
    // CUBE* formulas resolve server-side in gateway mode (mirroring the
    // web app's local open flow, which registers the same cube in the
    // browser engine).
    expect(listCubes()).toContain('PivotTable1');
    // A new load drops the previous file's registrations.
    const blank = new XlsxAdapter().write({ sheets: [{ name: 'S', rows: [[1]] }], metadata: {} });
    await post('/load', { format: 'xlsx', data: Buffer.from(blank).toString('base64') });
    expect(listCubes()).not.toContain('PivotTable1');
  });

  it('download saves server-side and commits the xlsx into the store, metadata only (defect 2c + separation)', async () => {
    await setup();
    const bytes = new XlsxAdapter().write({
      sheets: [{ name: 'Data', rows: [[1, 2], ['=A1+B1', 'x']] }],
      metadata: {},
      definedNames: [{ name: 'Cost', ref: 'Data!$A$1' }],
    });
    await post('/load', { format: 'xlsx', data: Buffer.from(bytes).toString('base64') });
    // A post-load edit must be in the download (it reads the LIVE workbook).
    await post('/execute', { cmd: { cmd: 'setCell', ref: { sheet: 'Data', row: 1, col: 1 }, value: 'edited' } });

    // Save/download separation: /download commits the save into the
    // library store and returns JSON metadata ONLY — no file bytes.
    const res = await fetch(`${svc!.url}/download`, { headers: ALICE });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const dl = (await res.json()) as {
      ok: boolean; entryId: string; revision: number; bytes: number; mode: string;
    };
    expect(dl.ok).toBe(true);
    expect(dl.entryId).toMatch(/^autosave_/);
    expect(dl.bytes).toBeGreaterThan(0);
    expect(typeof dl.revision).toBe('number');
    // The bytes are fetched from the committed store entry.
    const fileRes = await fetch(`${svc!.url}/library/${dl.entryId}`, { headers: ALICE });
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get('content-type')).toContain('spreadsheetml.sheet');
    expect(fileRes.headers.get('content-disposition')).toContain('workbook.xlsx');
    const out = new Uint8Array(await fileRes.arrayBuffer());
    expect(out.length).toBe(dl.bytes);
    const back = new XlsxAdapter().read(out);
    expect(back.sheets.map((s) => s.name)).toEqual(['Data']);
    expect(back.sheets[0]!.rows[0]).toEqual([1, 2]);
    expect(back.sheets[0]!.rows[1]![0]).toBe('=A1+B1');
    expect(back.sheets[0]!.rows[1]![1]).toBe('edited');
    // The loaded file's defined names ride along from server state.
    expect(back.definedNames).toContainEqual({ name: 'Cost', ref: 'Data!$A$1' });
  });

  it('download POST extras: session defined names + filename are honored', async () => {
    await setup();
    await post('/execute', { cmd: { cmd: 'setCell', ref: CELL_A1, value: 9 } });
    const res = await fetch(`${svc!.url}/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ALICE },
      body: JSON.stringify({
        format: 'xlsx',
        filename: 'my report',
        definedNames: [{ name: 'Answer', ref: 'Sheet1!$A$1' }],
        extraMetadata: { 'icecream.pagesetup.Sheet1': JSON.stringify({ orientation: 'landscape' }) },
      }),
    });
    expect(res.status).toBe(200);
    const dl = (await res.json()) as { entryId: string };
    // The committed entry carries the requested filename.
    const fileRes = await fetch(`${svc!.url}/library/${dl.entryId}`, { headers: ALICE });
    expect(fileRes.headers.get('content-disposition')).toContain('my report.xlsx');
    const back = new XlsxAdapter().read(new Uint8Array(await fileRes.arrayBuffer()));
    expect(back.sheets[0]!.rows[0]![0]).toBe(9);
    expect(back.definedNames).toContainEqual({ name: 'Answer', ref: 'Sheet1!$A$1' });
    const bad = await fetch(`${svc!.url}/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ALICE },
      body: JSON.stringify({ format: 'pdf' }),
    });
    expect(bad.status).toBe(400);
  });

  it('download in non-xlsx formats serializes server-side via the save adapters (closure)', async () => {
    await setup();
    // Isolate the library store for this instance's tests.
    const bytes = new XlsxAdapter().write({
      sheets: [{ name: 'Data', rows: [[1, 2], ['=A1+B1', 'x']] }],
      metadata: {},
    });
    await post('/load', { format: 'xlsx', data: Buffer.from(bytes).toString('base64') });

    // CSV: the CsvAdapter serializes the first sheet from the snapshot
    // inputs (formulas as text — the exact in-tab semantics).
    const csv = await fetch(`${svc!.url}/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ALICE },
      body: JSON.stringify({ format: 'csv', filename: 'data.xlsx' }),
    });
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('content-disposition')).toContain('data.csv');
    const csvText = await csv.text();
    expect(csvText).toContain('1,2');
    expect(csvText).toContain('=A1+B1,x');

    // TSV: tab-delimited twin.
    const tsv = await fetch(`${svc!.url}/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ALICE },
      body: JSON.stringify({ format: 'tsv' }),
    });
    expect(tsv.status).toBe(200);
    expect(await tsv.text()).toContain('1\t2');

    // ODS: parses back with the ODS adapter, same cells.
    const { OdsAdapter } = await import('@icecream-sheets/ods-adapter');
    const ods = await fetch(`${svc!.url}/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ALICE },
      body: JSON.stringify({ format: 'ods' }),
    });
    expect(ods.status).toBe(200);
    const back = new OdsAdapter().read(new Uint8Array(await ods.arrayBuffer()));
    expect(back.sheets[0]!.rows[0]).toEqual([1, 2]);

    // HTML: write-only export renders a document.
    const html = await fetch(`${svc!.url}/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ALICE },
      body: JSON.stringify({ format: 'html' }),
    });
    expect(html.status).toBe(200);
    expect(await html.text()).toContain('<html');
  });

  it('download scope=namedRange builds the rebased subset server-side (closure)', async () => {
    await setup();
    const bytes = new XlsxAdapter().write({
      sheets: [{ name: 'Data', rows: [[1, 2, 3], [4, 5, 6], [7, 8, 9]] }],
      metadata: {},
    });
    await post('/load', { format: 'xlsx', data: Buffer.from(bytes).toString('base64') });
    const res = await fetch(`${svc!.url}/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ALICE },
      body: JSON.stringify({
        format: 'xlsx',
        filename: 'Block.xlsx',
        scope: 'namedRange',
        namedRange: {
          name: 'Block',
          ref: { sheet: 'Data', startRow: 0, startCol: 1, endRow: 1, endCol: 2 },
        },
      }),
    });
    expect(res.status).toBe(200);
    const back = new XlsxAdapter().read(new Uint8Array(await res.arrayBuffer()));
    // Single sheet named after the name, rebased to A1, name carried rebased.
    expect(back.sheets.map((s) => s.name)).toEqual(['Block']);
    expect(back.sheets[0]!.rows).toEqual([
      [2, 3],
      [5, 6],
    ]);
    expect(back.definedNames).toContainEqual({ name: 'Block', ref: 'Block!$A$1:$B$2' });
    // Dangling def fails closed like the client path.
    const dangling = await fetch(`${svc!.url}/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ALICE },
      body: JSON.stringify({ scope: 'namedRange', namedRange: { name: 'Gone', ref: null } }),
    });
    expect(dangling.status).toBe(400);
  });

  it('named-range download is permission-filtered (hidden cells dropped)', async () => {
    await setup();
    await post('/execute', { cmd: { cmd: 'setCell', ref: CELL_A1, value: 'secret' } }, OWNER);
    await post('/execute', { cmd: { cmd: 'setCell', ref: CELL_B1, value: 'public' } }, OWNER);
    await post('/protection/hide', { sheet: 'Sheet1', ranges: ['A1'] }, OWNER);
    const res = await fetch(`${svc!.url}/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ALICE },
      body: JSON.stringify({
        scope: 'namedRange',
        namedRange: {
          name: 'Pair',
          ref: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 1 },
        },
      }),
    });
    expect(res.status).toBe(200);
    const back = new XlsxAdapter().read(new Uint8Array(await res.arrayBuffer()));
    expect(back.sheets[0]!.rows[0]![0]).toBeNull();
    expect(back.sheets[0]!.rows[0]![1]).toBe('public');
  });

  it('download is permission-filtered per principal (hidden cells dropped)', async () => {
    await setup();
    await post('/execute', { cmd: { cmd: 'setCell', ref: CELL_A1, value: 'secret' } }, OWNER);
    await post('/execute', { cmd: { cmd: 'setCell', ref: CELL_B1, value: 'public' } }, OWNER);
    await post('/protection/hide', { sheet: 'Sheet1', ranges: ['A1'] }, OWNER);

    // Each principal's download commits THEIR permission-filtered view
    // into a store entry owned by them; fetch that entry to inspect it.
    const dlAlice = (await (await fetch(`${svc!.url}/download`, { headers: ALICE })).json()) as {
      entryId: string;
    };
    const asAlice = new XlsxAdapter().read(
      new Uint8Array(
        await (await fetch(`${svc!.url}/library/${dlAlice.entryId}`, { headers: ALICE })).arrayBuffer(),
      ),
    );
    expect(asAlice.sheets[0]!.rows[0]![0]).toBeNull();
    expect(asAlice.sheets[0]!.rows[0]![1]).toBe('public');

    const dlOwner = (await (await fetch(`${svc!.url}/download`, { headers: OWNER })).json()) as {
      entryId: string;
    };
    const asOwner = new XlsxAdapter().read(
      new Uint8Array(
        await (await fetch(`${svc!.url}/library/${dlOwner.entryId}`, { headers: OWNER })).arrayBuffer(),
      ),
    );
    expect(asOwner.sheets[0]!.rows[0]![0]).toBe('secret');
  });

  it('library-save stores serialized bytes server-side; list + fetch are per-principal (closure)', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: pjoin } = await import('node:path');
    svc = await startServer(createEngineListener({ libraryDir: mkdtempSync(pjoin(tmpdir(), 'lib-')) }));
    await post('/execute', { cmd: { cmd: 'setCell', ref: CELL_A1, value: 42 } });
    const save = await post('/library-save', { name: 'Budget.xlsx' });
    expect(save.status).toBe(200);
    const { entry } = save.json as {
      entry: { id: string; name: string; sizeBytes: number; backend: string };
    };
    expect(entry.name).toBe('Budget.xlsx');
    expect(entry.backend).toBe('gateway');
    expect(entry.sizeBytes).toBeGreaterThan(0);
    // No bytes in the save response — metadata only.
    expect(JSON.stringify(save.json).length).toBeLessThan(entry.sizeBytes);

    const list = await httpJson('GET', `${svc!.url}/library`, { headers: ALICE });
    expect((list.json as { entries: unknown[] }).entries).toHaveLength(1);
    // Another principal sees an empty library and cannot fetch the entry.
    const otherList = await httpJson('GET', `${svc!.url}/library`, {
      headers: { 'x-principal': 'user:mallory' },
    });
    expect((otherList.json as { entries: unknown[] }).entries).toEqual([]);
    const otherFetch = await fetch(`${svc!.url}/library/${entry.id}`, {
      headers: { 'x-principal': 'user:mallory' },
    });
    expect(otherFetch.status).toBe(404);

    // The stored bytes parse back with the repo adapter, live edits included.
    await post('/execute', { cmd: { cmd: 'setCell', ref: CELL_B1, value: 'v2' } });
    const save2 = await post('/library-save', { id: entry.id, name: 'Budget.xlsx' });
    expect(save2.status).toBe(200);
    const fetched = await fetch(`${svc!.url}/library/${entry.id}`, { headers: ALICE });
    expect(fetched.status).toBe(200);
    const back = new XlsxAdapter().read(new Uint8Array(await fetched.arrayBuffer()));
    expect(back.sheets[0]!.rows[0]).toEqual([42, 'v2']);
  });

  it('reset replaces the workbook with a blank one', async () => {
    await setup();
    await post('/execute', { cmd: { cmd: 'setCell', ref: CELL_A1, value: 'old' } });
    const reset = await post('/reset', {});
    // The reset response also introduces the blank workbook's deployment
    // session id (W17B, deployment doc extension 1).
    expect(reset.json).toMatchObject({ ok: true });
    expect((reset.json as { sessionId: string }).sessionId).toMatch(/^sess_/);
    const snap = (await httpJson('GET', `${svc!.url}/snapshot`, { headers: ALICE })).json as WorkbookSnapshot;
    const cells = snap.sheets.flatMap((s) => s.cells);
    expect(cells).toEqual([]);
  });

  it('execute stamps the gateway principal, ignoring client-supplied auth', async () => {
    await setup();
    // A client trying to smuggle a different principal in the command.
    const ex = await post('/execute', {
      cmd: { cmd: 'setCell', ref: CELL_A1, value: 7, auth: { principal: 'user:mallory' } },
    });
    expect(ex.json).toEqual({ ok: true });
    // ...still lands under alice's identity (no cross-principal write here,
    // but the stamp is what the Authorizer sees).
    const rd = await post('/read', { kind: 'cell', ref: CELL_A1 }, ALICE);
    expect((rd.json as { value: TypedValue }).value).toEqual({ kind: 'number', value: 7 });
  });
});

describe('engine service google seams (Cycle-3 GAP-1)', () => {
  let svc: Started | null = null;

  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
    // The seams are process-global engine state: reset for other suites.
    setGoogleApiCredential(null);
  });

  async function waitForCredential(): Promise<{ apiKey?: string; accessToken?: string } | null> {
    const start = Date.now();
    for (;;) {
      const cred = getGoogleApiCredential();
      if (cred) return cred;
      if (Date.now() - start > 8000) throw new Error('google seam was never wired');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it('createEngineListener wires the vault credential into the engine seams', async () => {
    const seen: string[] = [];
    svc = await startServer(
      createEngineListener({
        resolveGoogleCredential: async (ref: string) => {
          seen.push(ref);
          return 'DEPLOYED-VAULT-SECRET';
        },
      }),
    );
    // Health still answers while the async wiring lands.
    expect((await httpJson('GET', `${svc.url}/health`)).status).toBe(200);
    // The deployed bootstrap put the vault-resolved secret into the seam.
    expect(await waitForCredential()).toEqual({ apiKey: 'DEPLOYED-VAULT-SECRET' });
    expect(seen).toEqual(['google']);
  });

  it('without a resolver the seams stay on the honest fallbacks', async () => {
    svc = await startServer(createEngineListener());
    expect((await httpJson('GET', `${svc.url}/health`)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(getGoogleApiCredential()).toBeNull();
  });
});

describe('engine service — checksum ack (Cycle 10 closure (b))', () => {
  let svc: Started | null = null;
  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });
  function post(path: string, body: unknown) {
    return httpJson('POST', `${svc!.url}${path}`, { headers: ALICE, body });
  }

  it('/execute with ackChecksum carries { revision, changedCellCount, checksum } over the affected set', async () => {
    svc = await startServer(createEngineListener());
    // No ack requested → plain CommandResult, no ack field (back-compat).
    const plain = await post('/execute', { cmd: { cmd: 'setCell', ref: CELL_A1, value: 21 } });
    expect(plain.json).toEqual({ ok: true });

    // Formula edit with ack: B1 has no dependents → set = [B1].
    const r1 = await post('/execute', {
      cmd: { cmd: 'setFormula', ref: CELL_B1, formula: '=A1*2' },
      ackChecksum: true,
    });
    const ack1 = (r1.json as { ack?: EditAck }).ack;
    expect(ack1).toBeDefined();
    expect(ack1!.changedCellCount).toBe(1);
    expect(ack1!.revision).toBe(2); // A1 edit was revision 1
    const expect1 = computeAckChecksum(
      [CELL_B1],
      new Map([['Sheet1:0:1', { kind: 'number', value: 42 } as TypedValue]]),
    );
    expect(ack1!.checksum).toBe(expect1);

    // Value edit on A1: affected set = [A1, B1] (pre-edit graph), values post-edit.
    const r2 = await post('/execute', {
      cmd: { cmd: 'setCell', ref: CELL_A1, value: 10 },
      ackChecksum: true,
    });
    const ack2 = (r2.json as { ack?: EditAck }).ack;
    expect(ack2).toBeDefined();
    expect(ack2!.revision).toBe(3);
    expect(ack2!.changedCellCount).toBe(2);
    const expect2 = computeAckChecksum(
      [CELL_A1, CELL_B1],
      new Map<string, TypedValue>([
        ['Sheet1:0:0', { kind: 'number', value: 10 }],
        ['Sheet1:0:1', { kind: 'number', value: 20 }],
      ]),
    );
    expect(ack2!.checksum).toBe(expect2);
  });
});

describe('engine service — format persistence (defect D4)', () => {
  let svc: Started | null = null;
  async function setup() {
    svc = await startServer(createEngineListener());
  }
  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });
  function post(path: string, body: unknown, headers: Record<string, string> = ALICE) {
    return httpJson('POST', `${svc!.url}${path}`, { headers, body });
  }

  it('download carries session sheetStyles from the extras (bold + Percentage)', async () => {
    await setup();
    const bytes = new XlsxAdapter().write({
      sheets: [{ name: 'Data', rows: [[0.1667]] }],
      metadata: {},
    });
    await post('/load', { format: 'xlsx', data: Buffer.from(bytes).toString('base64') });
    // The client sends its resolved format store as sheetStyles extras —
    // the only channel for ribbon-applied formats (the engine holds none).
    const res = await fetch(`${svc!.url}/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ALICE },
      body: JSON.stringify({
        format: 'xlsx',
        sheetStyles: { Data: { '0:0': { bold: true, numberFormatCode: '0.00%' } } },
      }),
    });
    expect(res.status).toBe(200);
    const dl = (await res.json()) as { entryId: string };
    const back = new XlsxAdapter().read(
      new Uint8Array(
        await (await fetch(`${svc!.url}/library/${dl.entryId}`, { headers: ALICE })).arrayBuffer(),
      ),
    );
    expect(back.sheets[0]!.styles?.['0:0']).toEqual({ bold: true, numberFormatCode: '0.00%' });
    expect(back.sheets[0]!.formats?.['0:0']).toBe('0.00%');
  });

  it('download without extras preserves the loaded file styles (source fallback)', async () => {
    await setup();
    const bytes = new XlsxAdapter().write({
      sheets: [
        {
          name: 'Data',
          rows: [[0.5]],
          styles: { '0:0': { bold: true, numberFormatCode: '0.00%' } },
        },
      ],
      metadata: {},
    });
    await post('/load', { format: 'xlsx', data: Buffer.from(bytes).toString('base64') });
    // /load ships the styles to the client for format-store seeding.
    const loadRes = await post('/load', { format: 'xlsx', data: Buffer.from(bytes).toString('base64') });
    const loadJson = loadRes.json as { file: { sheets: Array<{ styles?: unknown }> } };
    expect(loadJson.file.sheets[0]!.styles).toEqual({ '0:0': { bold: true, numberFormatCode: '0.00%' } });
    // A bare GET /download (no session extras) still carries them.
    const res = await fetch(`${svc!.url}/download`, { headers: ALICE });
    expect(res.status).toBe(200);
    const dl = (await res.json()) as { entryId: string };
    const back = new XlsxAdapter().read(
      new Uint8Array(
        await (await fetch(`${svc!.url}/library/${dl.entryId}`, { headers: ALICE })).arrayBuffer(),
      ),
    );
    expect(back.sheets[0]!.styles?.['0:0']).toEqual({ bold: true, numberFormatCode: '0.00%' });
    expect(back.sheets[0]!.formats?.['0:0']).toBe('0.00%');
  });

  it('a reported-but-empty sheet in sheetStyles clears that sheet formats', async () => {
    await setup();
    const bytes = new XlsxAdapter().write({
      sheets: [
        { name: 'Data', rows: [[0.5]], styles: { '0:0': { bold: true } } },
      ],
      metadata: {},
    });
    await post('/load', { format: 'xlsx', data: Buffer.from(bytes).toString('base64') });
    const res = await fetch(`${svc!.url}/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ALICE },
      body: JSON.stringify({ format: 'xlsx', sheetStyles: { Data: {} } }),
    });
    expect(res.status).toBe(200);
    const dl = (await res.json()) as { entryId: string };
    const back = new XlsxAdapter().read(
      new Uint8Array(
        await (await fetch(`${svc!.url}/library/${dl.entryId}`, { headers: ALICE })).arrayBuffer(),
      ),
    );
    expect(back.sheets[0]!.styles?.['0:0']).toBeUndefined();
  });
});

describe('engine service — defined names on save (defect E1)', () => {
  let svc: Started | null = null;
  async function setup() {
    svc = await startServer(createEngineListener());
  }
  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });
  function post(path: string, body: unknown, headers: Record<string, string> = ALICE) {
    return httpJson('POST', `${svc!.url}${path}`, { headers, body });
  }

  const NAMED_BYTES = () =>
    new XlsxAdapter().write({
      sheets: [
        {
          name: 'Data',
          rows: [
            [0.25, 100],
            [null, '=BaseAmt*TaxRate'],
          ],
        },
        { name: 'Other', rows: [[7, '=LocalRate*3']] },
      ],
      metadata: {},
      definedNames: [
        { name: 'TaxRate', ref: 'Data!$A$1' },
        { name: 'BaseAmt', ref: 'Data!$B$1' },
        { name: 'LocalRate', ref: 'Other!$A$1', sheet: 1 },
        // HF-unbindable name: preserved verbatim from load.
        { name: 'RateY1', ref: 'Data!$A$1' },
      ],
    });

  async function loadNamed() {
    await post('/load', { format: 'xlsx', data: Buffer.from(NAMED_BYTES()).toString('base64') });
  }

  it('POST /download with the client\'s EMPTY store list still carries every name (E1 shape)', async () => {
    await setup();
    await loadNamed();
    // The real web client sends definedNames from its name store, which
    // is never populated on open — i.e. []. That must not zero the table.
    const res = await fetch(`${svc!.url}/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ALICE },
      body: JSON.stringify({ format: 'xlsx', filename: 'workbook.xlsx', definedNames: [] }),
    });
    expect(res.status).toBe(200);
    const dl = (await res.json()) as { entryId: string };
    const back = new XlsxAdapter().read(
      new Uint8Array(
        await (await fetch(`${svc!.url}/library/${dl.entryId}`, { headers: ALICE })).arrayBuffer(),
      ),
    );
    expect(back.definedNames).toHaveLength(4);
    expect(back.definedNames).toContainEqual({ name: 'TaxRate', ref: 'Data!$A$1' });
    expect(back.definedNames).toContainEqual({ name: 'BaseAmt', ref: 'Data!$B$1' });
    expect(back.definedNames).toContainEqual({ name: 'LocalRate', ref: 'Other!$A$1', sheet: 1 });
    expect(back.definedNames).toContainEqual({ name: 'RateY1', ref: 'Data!$A$1' });
    // Formulas still reference the names (no save-side rewriting).
    expect(back.sheets[0]!.rows[1]![1]).toBe('=BaseAmt*TaxRate');
  });

  it('GET /download and /snapshot carry the names; extras add store-only names, live wins collisions', async () => {
    await setup();
    await loadNamed();
    const res = await fetch(`${svc!.url}/download`, { headers: ALICE });
    const dl = (await res.json()) as { entryId: string };
    const back = new XlsxAdapter().read(
      new Uint8Array(
        await (await fetch(`${svc!.url}/library/${dl.entryId}`, { headers: ALICE })).arrayBuffer(),
      ),
    );
    expect(back.definedNames).toHaveLength(4);

    const snap = (await httpJson('GET', `${svc!.url}/snapshot`, { headers: ALICE })).json as WorkbookSnapshot;
    expect(snap.definedNames).toHaveLength(4);
    expect(snap.definedNames).toContainEqual({ name: 'LocalRate', ref: 'Other!$A$1', sheet: 1 });

    const res2 = await fetch(`${svc!.url}/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ALICE },
      body: JSON.stringify({
        format: 'xlsx',
        definedNames: [
          { name: 'TaxRate', ref: 'WRONG!$Z$9' }, // collides: live engine ref wins
          { name: 'StoreOnly', ref: 'Data!$A$2' }, // store-only: contributed
        ],
      }),
    });
    const dl2 = (await res2.json()) as { entryId: string };
    const back2 = new XlsxAdapter().read(
      new Uint8Array(
        await (await fetch(`${svc!.url}/library/${dl2.entryId}`, { headers: ALICE })).arrayBuffer(),
      ),
    );
    expect(back2.definedNames).toHaveLength(5);
    expect(back2.definedNames).toContainEqual({ name: 'TaxRate', ref: 'Data!$A$1' });
    expect(back2.definedNames).toContainEqual({ name: 'StoreOnly', ref: 'Data!$A$2' });
  });

  it('GET /snapshot carries workbook metadata for joiners (File-2 D1 follow-up)', async () => {
    await setup();
    // A workbook whose metadata carries the overlay display models —
    // exactly the record the adapter seeds from native drawings at load
    // (File-2 D1: 23 pictures + 13 text boxes for the real fixture; the
    // adapter round-trips the keys verbatim, and drawings.test.ts pins
    // the real-fixture seeding). A client JOINING or REHYDRATING the
    // session hydrates only from /snapshot — before the fix the
    // snapshot carried no metadata field at all, so those overlays
    // could never render for it. (The real fixture is not loaded here:
    // its engine build + filtered snapshot take ~75 s on this host;
    // the two-client browser proof exercises it end-to-end.)
    const sourcePictures = [
      { id: 1, x: 902, y: 23, w: 14, h: 18, dataUrl: 'data:image/png;base64,AA==', name: 'logo', sheet: 'Data' },
    ];
    const sourceBoxes = [
      { id: 2, x: 0, y: 30, w: 1152, h: 155, text: 'note', sheet: 'Data' },
    ];
    const bytes = new XlsxAdapter().write({
      sheets: [{ name: 'Data', rows: [[1]] }],
      metadata: { 'icecream.pictures': sourcePictures, 'icecream.textboxes': sourceBoxes },
    });
    const load = await post('/load', { format: 'xlsx', data: Buffer.from(bytes).toString('base64') });
    expect(load.status).toBe(200);

    const snap = (await httpJson('GET', `${svc!.url}/snapshot`, { headers: ALICE }))
      .json as WorkbookSnapshot;
    expect(snap.metadata?.['icecream.pictures']).toEqual(sourcePictures);
    expect(snap.metadata?.['icecream.textboxes']).toEqual(sourceBoxes);

    // Session extras merge OVER the source metadata (later wins — the
    // same order the save path uses), so a joiner arriving after the
    // opener pushed extras sees the session's CURRENT overlays, while
    // untouched keys still come from the source file.
    const replacement = [
      { id: 99, x: 1, y: 2, w: 3, h: 4, dataUrl: 'data:image/png;base64,BB==', name: 'live', sheet: 'Data' },
    ];
    const push = await post('/session-extras', {
      extraMetadata: { 'icecream.pictures': replacement },
    });
    expect(push.status).toBe(200);
    const snap2 = (await httpJson('GET', `${svc!.url}/snapshot`, { headers: ALICE }))
      .json as WorkbookSnapshot;
    expect(snap2.metadata?.['icecream.pictures']).toEqual(replacement);
    expect(snap2.metadata?.['icecream.textboxes']).toEqual(sourceBoxes);
  });

  it('library-save with empty extras stores bytes that carry the names', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: pjoin } = await import('node:path');
    svc = await startServer(createEngineListener({ libraryDir: mkdtempSync(pjoin(tmpdir(), 'lib-e1-')) }));
    await loadNamed();
    const save = await post('/library-save', { name: 'Named.xlsx', definedNames: [] });
    expect(save.status).toBe(200);
    const { entry } = save.json as { entry: { id: string } };
    const fetched = await fetch(`${svc!.url}/library/${entry.id}`, { headers: ALICE });
    expect(fetched.status).toBe(200);
    const back = new XlsxAdapter().read(new Uint8Array(await fetched.arrayBuffer()));
    expect(back.definedNames).toHaveLength(4);
    expect(back.definedNames).toContainEqual({ name: 'TaxRate', ref: 'Data!$A$1' });
  });
});

describe('engine service snapshot charts (round-3 leg B)', () => {
  let svc2: Started | null = null;
  afterEach(async () => {
    if (svc2) await stop(svc2);
    svc2 = null;
  });
  function post2(path: string, body: unknown, headers: Record<string, string> = ALICE) {
    return httpJson('POST', `${svc2!.url}${path}`, { headers, body });
  }
  it('GET /snapshot carries live session charts for joiners, omits the field when empty', async () => {
    svc2 = await startServer(createEngineListener());
    const bytes = new XlsxAdapter().write({
      sheets: [{ name: 'Data', rows: [['Quarter', 'Sales'], ['Q1', 10], ['Q2', 20]] }],
      metadata: {},
    } as never);
    const load = await post2('/load', { format: 'xlsx', data: Buffer.from(bytes).toString('base64') });
    expect(load.status).toBe(200);
    // No charts yet: the field is omitted (same non-empty-only pattern
    // as metadata/sheetStyles/sheetFormats).
    const snap0 = (await httpJson('GET', `${svc2!.url}/snapshot`, { headers: ALICE }))
      .json as WorkbookSnapshot & { charts?: unknown[] };
    expect(snap0.charts).toBeUndefined();
    // A session-authored chart lands via POST /charts ...
    const chart = await post2('/charts', {
      spec: {
        id: 7,
        kind: 'column-clustered',
        title: 'Sales by Quarter',
        range: { sheet: 'Data', startRow: 0, startCol: 0, endRow: 2, endCol: 1 },
        seriesRanges: [
          {
            name: 'Sales',
            cat: { sheet: 'Data', startRow: 1, startCol: 0, endRow: 2, endCol: 0 },
            val: { sheet: 'Data', startRow: 1, startCol: 1, endRow: 2, endCol: 1 },
          },
        ],
        anchorCells: { fromCol: 3, fromRow: 1, toCol: 11, toRow: 16 },
      },
    });
    expect(chart.status).toBe(200);
    // ... and the snapshot now carries it, so a joining client merges
    // it back after its metadata hydration instead of losing it.
    const snap1 = (await httpJson('GET', `${svc2!.url}/snapshot`, { headers: ALICE }))
      .json as WorkbookSnapshot & { charts?: Array<{ title?: string }> };
    expect(snap1.charts).toHaveLength(1);
    expect(snap1.charts![0]!.title).toBe('Sales by Quarter');
  });
});
