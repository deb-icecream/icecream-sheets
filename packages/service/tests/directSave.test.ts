/**
 * Direct streaming save serializer (src/save/directSave.ts): the
 * shared, node-only serializer fed a PROVIDED bulk readback of the
 * live model — no rebuild, no re-parse, no replay, no checksum.
 *
 * Coverage: (1) unedited save is fully verbatim; (2) one setCell op
 * regenerates only that sheet, other parts byte-identical; (3) a
 * #PERM! bulk cell is dropped from the output; (4) per-type
 * structural handling — row/col ops stay verbatim with every sheet
 * regenerated, sheet-set changes and unhandled structural ops take
 * the adapter fallback with a fallbackReason; (5) the batch shape:
 * a pinned bulk carries only final values; (6) the test-only
 * mid-write fault injection throws mid-write and never touches a
 * destination file.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { XlsxAdapter, readCharts } from '@icecream-sheets/xlsx-adapter';
import { makeChartSpec, type ChartSpec } from '../src/chartModel.js';
import type { CellInput, TypedValue, WorkbookData } from '@icecream-sheets/engine';
import {
  DIRECT_SAVE_MUTATING_OPS,
  serializeLiveWorkbook,
  verifyXlsxPackage,
  type DirectSaveCell,
  type DirectSaveInput,
  type DirectSaveParsedSheet,
} from '../src/save/directSave.js';

function smallWorkbookBytes(): Uint8Array {
  return new XlsxAdapter().write({
    sheets: [
      { name: 'Data', rows: [[1, 2], ['=A1+B1', 'x']], formats: { '0:1': '0.00' } },
      { name: 'Other', rows: [['keep', 42]] },
    ],
    metadata: {},
    definedNames: [{ name: 'Cost', ref: 'Data!$A$1' }],
  });
}

function valueOf(input: CellInput): TypedValue {
  if (typeof input === 'number') return { kind: 'number', value: input };
  if (typeof input === 'boolean') return { kind: 'boolean', value: input };
  if (typeof input === 'string') {
    if (input === '=A1+B1') return { kind: 'number', value: 3 }; // the fixture's one formula, evaluated
    return { kind: 'string', value: input };
  }
  return { kind: 'null', value: null };
}

/** Build the bulk readback a live engine would hand the serializer. */
function bulkFromData(data: WorkbookData): DirectSaveCell[] {
  const bulk: DirectSaveCell[] = [];
  for (const sheet of data.sheets) {
    sheet.rows.forEach((row, r) => {
      row.forEach((input, c) => {
        if (input === null || input === undefined || input === '') return;
        bulk.push({ ref: { sheet: sheet.name, row: r, col: c }, input, value: valueOf(input) });
      });
    });
  }
  return bulk;
}

function parsedFromData(data: WorkbookData): Map<string, DirectSaveParsedSheet> {
  const map = new Map<string, DirectSaveParsedSheet>();
  for (const s of data.sheets) {
    map.set(s.name, {
      ...(s.styles ? { styles: s.styles } : {}),
      ...(s.formats ? { formats: s.formats } : {}),
      ...(s.colWidths ? { colWidths: s.colWidths } : {}),
      ...(s.rowHeights ? { rowHeights: s.rowHeights } : {}),
      ...(s.hiddenCols ? { hiddenCols: s.hiddenCols } : {}),
      ...(s.hiddenRows ? { hiddenRows: s.hiddenRows } : {}),
    });
  }
  return map;
}

function nonEmptyCount(data: WorkbookData, sheetName: string): number {
  const sheet = data.sheets.find((s) => s.name === sheetName);
  if (!sheet) return -1;
  let n = 0;
  for (const row of sheet.rows) {
    for (const v of row) if (v !== null && v !== undefined && v !== '') n++;
  }
  return n;
}

describe('serializeLiveWorkbook', () => {
  const tmpdirs: string[] = [];
  afterEach(() => {
    delete process.env.ICECREAM_SAVE_FAULT_INJECT;
    for (const d of tmpdirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeInput(overrides: Partial<DirectSaveInput> = {}): { input: DirectSaveInput; out: string; sourceBytes: Uint8Array; data: WorkbookData } {
    const dir = mkdtempSync(join(tmpdir(), 'direct-save-test-'));
    tmpdirs.push(dir);
    const sourceBytes = smallWorkbookBytes();
    const data = new XlsxAdapter().read(sourceBytes.slice());
    const out = join(dir, 'out.xlsx');
    const input: DirectSaveInput = {
      bulk: bulkFromData(data),
      sheetNames: data.sheets.map((s) => s.name),
      definedNames: data.definedNames ?? [],
      metadata: data.metadata ?? {},
      sourceBytes,
      parsedSheets: parsedFromData(data),
      sheets: data.sheets.map((s) => ({ name: s.name, clientStyles: false, clientDims: false })),
      ops: [],
      outPath: out,
      ...overrides,
    };
    return { input, out, sourceBytes, data };
  }

  it('unedited save: fully verbatim, changedSheets [], parse-back counts equal the source', () => {
    const { input, out, data } = makeInput();
    const result = serializeLiveWorkbook(input);
    expect(result.mode).toBe('verbatim');
    expect(result.changedSheets).toEqual([]);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.serializeMs).toBeGreaterThanOrEqual(0);
    expect(verifyXlsxPackage(out).ok).toBe(true);
    const back = new XlsxAdapter().read(new Uint8Array(readFileSync(out)));
    for (const name of ['Data', 'Other']) {
      expect(nonEmptyCount(back, name)).toBe(nonEmptyCount(data, name));
    }
    expect(back.sheets.find((s) => s.name === 'Data')!.rows[0]).toEqual([1, 2]);
    expect(back.sheets.find((s) => s.name === 'Other')!.rows[0]).toEqual(['keep', 42]);
    expect(back.definedNames).toContainEqual({ name: 'Cost', ref: 'Data!$A$1', sheet: undefined });
  });

  it('one setCell op: only that sheet regenerates; other sheet part is byte-identical', () => {
    const bulk = bulkFromData(new XlsxAdapter().read(smallWorkbookBytes().slice()));
    const edited = bulk.find((c) => c.ref.sheet === 'Data' && c.ref.row === 1 && c.ref.col === 1)!;
    edited.input = 'edited';
    edited.value = { kind: 'string', value: 'edited' };
    const { input, out, data } = makeInput({
      bulk,
      ops: [{ cmd: 'setCell', ref: { sheet: 'Data', row: 1, col: 1 } }],
    });
    const result = serializeLiveWorkbook(input);
    expect(result.mode).toBe('verbatim');
    expect(result.changedSheets).toEqual(['Data']);
    expect(verifyXlsxPackage(out).ok).toBe(true);
    const outBytes = new Uint8Array(readFileSync(out));
    const back = new XlsxAdapter().read(outBytes);
    expect(back.sheets.find((s) => s.name === 'Data')!.rows[1]![1]).toBe('edited');
    expect(back.sheets.find((s) => s.name === 'Data')!.rows[0]).toEqual([1, 2]);
    // The formula cell survives the regeneration exactly as the source read it.
    expect(back.sheets.find((s) => s.name === 'Data')!.rows[1]![0]).toEqual(
      data.sheets.find((s) => s.name === 'Data')!.rows[1]![0],
    );
    // The untouched sheet's part is byte-identical to the source part.
    const srcParts = unzipSync(smallWorkbookBytes().slice()) as Record<string, Uint8Array>;
    const outParts = unzipSync(outBytes.slice()) as Record<string, Uint8Array>;
    const sheet2 = Object.keys(srcParts).find((k) => k.endsWith('sheet2.xml'))!;
    expect(Buffer.from(outParts[sheet2]!)).toEqual(Buffer.from(srcParts[sheet2]!));
  });

  it('a bulk cell with a #PERM! error value is dropped from the output', () => {
    const bulk = bulkFromData(new XlsxAdapter().read(smallWorkbookBytes().slice()));
    bulk.push({
      ref: { sheet: 'Other', row: 5, col: 5 },
      input: 'secret',
      value: { kind: 'error', code: '#PERM!' },
    });
    const { input, out, data } = makeInput({
      bulk,
      // Force 'Other' to regenerate from the grouped bulk.
      ops: [{ cmd: 'setCell', ref: { sheet: 'Other', row: 0, col: 0 } }],
    });
    const result = serializeLiveWorkbook(input);
    expect(result.changedSheets).toContain('Other');
    expect(verifyXlsxPackage(out).ok).toBe(true);
    const back = new XlsxAdapter().read(new Uint8Array(readFileSync(out)));
    const other = back.sheets.find((s) => s.name === 'Other')!;
    expect(nonEmptyCount(back, 'Other')).toBe(nonEmptyCount(data, 'Other'));
    expect(other.rows[5]).toBeUndefined();
    expect(other.rows.flat().includes('secret' as never)).toBe(false);
  });

  it('a row/col structural op (insertRows) stays verbatim with EVERY sheet regenerated', () => {
    // Addendum 5: row/col ops do not take the adapter fallback. The
    // bulk already carries post-shift addresses, so the save stays on
    // the streaming path — but every sheet regenerates (per-cell
    // address reuse is invalid across a shift).
    const { input, out } = makeInput({
      ops: [{ cmd: 'insertRows', ref: { sheet: 'Data', row: 0, col: 0 } }],
    });
    const result = serializeLiveWorkbook(input);
    expect(result.mode).toBe('verbatim');
    expect(result.fallbackReason).toBeUndefined();
    expect(result.changedSheets).toEqual(['Data', 'Other']);
    expect(verifyXlsxPackage(out).ok).toBe(true);
    // Parse-back values match the provided bulk exactly.
    const back = new XlsxAdapter().read(new Uint8Array(readFileSync(out)));
    expect(back.sheets.find((s) => s.name === 'Data')!.rows[0]).toEqual([1, 2]);
    expect(back.sheets.find((s) => s.name === 'Data')!.rows[1]![1]).toBe('x');
    expect(back.sheets.find((s) => s.name === 'Other')!.rows[0]).toEqual(['keep', 42]);
  });

  it('renameSheet (sheet set differs) routes to adapter-fallback with fallbackReason', () => {
    const bulk = bulkFromData(new XlsxAdapter().read(smallWorkbookBytes().slice())).map((c) =>
      c.ref.sheet === 'Data' ? { ...c, ref: { ...c.ref, sheet: 'DataRenamed' } } : c,
    );
    const { input, out } = makeInput({
      bulk,
      sheetNames: ['DataRenamed', 'Other'],
      sheets: [
        { name: 'DataRenamed', clientStyles: false, clientDims: false },
        { name: 'Other', clientStyles: false, clientDims: false },
      ],
      ops: [{ cmd: 'renameSheet' }],
    });
    const result = serializeLiveWorkbook(input);
    expect(result.mode).toBe('adapter-fallback');
    expect(result.fallbackReason).toBe('sheet-set-changed');
    expect(verifyXlsxPackage(out).ok).toBe(true);
    const back = new XlsxAdapter().read(new Uint8Array(readFileSync(out)));
    expect(back.sheets.map((s) => s.name)).toEqual(['DataRenamed', 'Other']);
    expect(back.sheets.find((s) => s.name === 'DataRenamed')!.rows[0]).toEqual([1, 2]);
  });

  it('an unhandled structural op (setCalculationMode) routes to adapter-fallback with its reason', () => {
    const { input, out } = makeInput({ ops: [{ cmd: 'setCalculationMode' }] });
    const result = serializeLiveWorkbook(input);
    expect(result.mode).toBe('adapter-fallback');
    expect(result.fallbackReason).toBe('structural-op:setCalculationMode');
    expect(verifyXlsxPackage(out).ok).toBe(true);
    const back = new XlsxAdapter().read(new Uint8Array(readFileSync(out)));
    expect(back.sheets.find((s) => s.name === 'Data')!.rows[0]).toEqual([1, 2]);
  });

  it('batch shape: the pinned bulk carries only final values; the touched sheet is listed once', () => {
    // Addendum 5 batch shape: Data!A1 was edited 3 times in sequence
    // (111 -> 222 -> 999), Data!B1 once ('once'). The bulk readback
    // the serializer receives is the FINAL state of one revision —
    // intermediates exist nowhere in it — and the journal lists the
    // same sheet four times.
    const bulk = bulkFromData(new XlsxAdapter().read(smallWorkbookBytes().slice()));
    const a1 = bulk.find((c) => c.ref.sheet === 'Data' && c.ref.row === 0 && c.ref.col === 0)!;
    a1.input = 999;
    a1.value = { kind: 'number', value: 999 };
    const b1 = bulk.find((c) => c.ref.sheet === 'Data' && c.ref.row === 0 && c.ref.col === 1)!;
    b1.input = 'once';
    b1.value = { kind: 'string', value: 'once' };
    const ref = { sheet: 'Data', row: 0, col: 0 };
    const { input, out } = makeInput({
      bulk,
      ops: [
        { cmd: 'setCell', ref },
        { cmd: 'setCell', ref },
        { cmd: 'setCell', ref },
        { cmd: 'setCell', ref: { sheet: 'Data', row: 0, col: 1 } },
      ],
    });
    const result = serializeLiveWorkbook(input);
    expect(result.mode).toBe('verbatim');
    // The one touched sheet is listed exactly once.
    expect(result.changedSheets).toEqual(['Data']);
    expect(verifyXlsxPackage(out).ok).toBe(true);
    const back = new XlsxAdapter().read(new Uint8Array(readFileSync(out)));
    expect(back.sheets.find((s) => s.name === 'Data')!.rows[0]).toEqual([999, 'once']);
    // No intermediate value (111 / 222) appears anywhere in the output.
    const allValues = back.sheets.flatMap((s) => s.rows.flat());
    expect(allValues).not.toContain(111);
    expect(allValues).not.toContain(222);
    expect(back.sheets.find((s) => s.name === 'Other')!.rows[0]).toEqual(['keep', 42]);
  });

  it('mid-write fault injection throws mid-write and never touches the destination', () => {
    const bulk = bulkFromData(new XlsxAdapter().read(smallWorkbookBytes().slice()));
    const edited = bulk.find((c) => c.ref.sheet === 'Data' && c.ref.row === 1 && c.ref.col === 1)!;
    edited.input = 'edited';
    edited.value = { kind: 'string', value: 'edited' };
    const { input, out, sourceBytes } = makeInput({
      bulk,
      ops: [{ cmd: 'setCell', ref: { sheet: 'Data', row: 1, col: 1 } }],
    });
    // The destination simulation: a pre-existing file with known bytes
    // elsewhere. Callers only replace it after a successful save, so
    // a mid-write failure must leave it byte-identical.
    const dir = join(out, '..');
    const destination = join(dir, 'destination.xlsx');
    writeFileSync(destination, sourceBytes);
    const before = readFileSync(destination);

    process.env.ICECREAM_SAVE_FAULT_INJECT = 'midwrite';
    try {
      expect(() => serializeLiveWorkbook(input)).toThrow('injected save fault (midwrite)');
    } finally {
      delete process.env.ICECREAM_SAVE_FAULT_INJECT;
    }
    // Proof the throw happened mid-write: the temp output exists but
    // is a partial, structurally invalid package.
    expect(existsSync(out)).toBe(true);
    expect(() => verifyXlsxPackage(out)).toThrow();
    // The destination was never touched.
    expect(readFileSync(destination)).toEqual(before);
    expect(Buffer.from(readFileSync(destination))).toEqual(Buffer.from(sourceBytes));
  });

  it('verifyXlsxPackage rejects a non-package file; mutating-ops set matches the gateway list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'direct-save-verify-'));
    tmpdirs.push(dir);
    const bogus = join(dir, 'bogus.xlsx');
    writeFileSync(bogus, 'not a zip at all');
    expect(() => verifyXlsxPackage(bogus)).toThrow();
    expect(() => verifyXlsxPackage(join(dir, 'missing.xlsx'))).toThrow();
    expect([...DIRECT_SAVE_MUTATING_OPS].sort()).toEqual(
      [
        'addSheet',
        'defineFunction',
        'defineName',
        'deleteCols',
        'deleteFunction',
        'deleteName',
        'deleteRows',
        'deleteSheet',
        'duplicateSheet',
        'insertCols',
        'insertRows',
        'moveSheet',
        'renameName',
        'renameSheet',
        'rollbackFunction',
        'setCalculationMode',
        'setCell',
        'setFormula',
        'updateFunction',
        'updateNameRefersTo',
      ].sort(),
    );
  });
});

describe('serializeLiveWorkbook with session charts (FIX-G)', () => {
  const tmpdirs: string[] = [];
  afterEach(() => {
    for (const d of tmpdirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function chartFixture(): { sourceBytes: Uint8Array; data: WorkbookData; chart: ChartSpec } {
    const sourceBytes = new XlsxAdapter().write({
      sheets: [
        {
          name: 'Data',
          rows: [
            ['Quarter', 'Sales'],
            ['Q1', 10],
            ['Q2', 20],
            ['Q3', 30],
          ],
        },
        { name: 'Other', rows: [['keep', 42]] },
      ],
      metadata: {},
    });
    const data = new XlsxAdapter().read(sourceBytes.slice());
    const chart = makeChartSpec({
      id: 7,
      kind: 'column-clustered',
      title: 'Sales by Quarter',
      range: { sheet: 'Data', startRow: 0, startCol: 0, endRow: 3, endCol: 1 },
      seriesRanges: [
        {
          name: 'Sales',
          cat: { sheet: 'Data', startRow: 1, startCol: 0, endRow: 3, endCol: 0 },
          val: { sheet: 'Data', startRow: 1, startCol: 1, endRow: 3, endCol: 1 },
        },
      ],
      anchorCells: { fromCol: 3, fromRow: 1, toCol: 11, toRow: 16 },
      nativePart: true,
    });
    return { sourceBytes, data, chart };
  }

  function inputFor(
    sourceBytes: Uint8Array,
    data: WorkbookData,
    chart: ChartSpec,
    overrides: Partial<DirectSaveInput> = {},
  ): { input: DirectSaveInput; out: string } {
    const dir = mkdtempSync(join(tmpdir(), 'direct-save-charts-'));
    tmpdirs.push(dir);
    const out = join(dir, 'out.xlsx');
    return {
      out,
      input: {
        bulk: bulkFromData(data),
        sheetNames: data.sheets.map((s) => s.name),
        definedNames: data.definedNames ?? [],
        metadata: data.metadata ?? {},
        sourceBytes,
        parsedSheets: parsedFromData(data),
        sheets: data.sheets.map((s) => ({ name: s.name, clientStyles: false, clientDims: false })),
        ops: [],
        outPath: out,
        charts: [chart],
        ...overrides,
      },
    };
  }

  function chartsOf(path: string) {
    const files: Record<string, Uint8Array> = {};
    for (const [k, v] of Object.entries(unzipSync(new Uint8Array(readFileSync(path))))) {
      files[k] = v as Uint8Array;
    }
    return { files, charts: readCharts(files) };
  }

  it('verbatim path: authors a real chart part; parse-back shows kind/title/series/caches', () => {
    const { sourceBytes, data, chart } = chartFixture();
    const { input, out } = inputFor(sourceBytes, data, chart);
    const result = serializeLiveWorkbook(input);
    expect(result.mode).toBe('verbatim');
    expect(verifyXlsxPackage(out).ok).toBe(true);
    const { files, charts } = chartsOf(out);
    expect(Object.keys(files).some((p) => p === 'xl/charts/chart1.xml')).toBe(true);
    expect(charts.length).toBe(1);
    expect(charts[0]!.kind).toBe('barChart');
    expect(charts[0]!.barDir).toBe('col');
    expect(charts[0]!.title).toBe('Sales by Quarter');
    expect(charts[0]!.series[0]!.valFormula).toBe('Data!$B$2:$B$4');
    expect(charts[0]!.series[0]!.valCache).toEqual([10, 20, 30]);
    expect(charts[0]!.anchor).toEqual({ fromCol: 3, fromRow: 1, toCol: 11, toRow: 16 });
  });

  it('idempotence: saving the authored output again does not duplicate the chart part', () => {
    const { sourceBytes, data, chart } = chartFixture();
    const first = inputFor(sourceBytes, data, chart);
    serializeLiveWorkbook(first.input);
    const onceBytes = new Uint8Array(readFileSync(first.out));
    const data2 = new XlsxAdapter().read(onceBytes.slice());
    const second = inputFor(onceBytes, data2, chart);
    serializeLiveWorkbook(second.input);
    const { files, charts } = chartsOf(second.out);
    expect(charts.length).toBe(1);
    expect(Object.keys(files).filter((p) => /^xl\/charts\/chart\d+\.xml$/.test(p))).toEqual([
      'xl/charts/chart1.xml',
    ]);
  });

  it('adapter-fallback path: injects the chart into the adapter output bytes', () => {
    const { sourceBytes, data, chart } = chartFixture();
    // Sheet-set change forces the adapter fallback.
    const { input, out } = inputFor(sourceBytes, data, chart, {
      sheetNames: [...data.sheets.map((s) => s.name), 'Extra'],
    });
    const result = serializeLiveWorkbook(input);
    expect(result.mode).toBe('adapter-fallback');
    const { charts } = chartsOf(out);
    expect(charts.length).toBe(1);
    expect(charts[0]!.title).toBe('Sales by Quarter');
    expect(charts[0]!.series[0]!.valCache).toEqual([10, 20, 30]);
  });
});
