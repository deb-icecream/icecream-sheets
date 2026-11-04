/**
 * Headless tests for snapshot <-> WorkbookData conversion used by
 * Open .xlsx / Download .xlsx. No browser needed.
 */
import { describe, expect, it } from 'vitest';
import { EngineHost, EngineWorkbook } from '@icecream-sheets/engine';
import type { WorkbookData, WorkbookSnapshot } from '@icecream-sheets/engine';
import {
  createHostFromWorkbookData,
  importedFormatsToStore,
  mergeDefinedNames,
  snapshotFiltered,
  snapshotToWorkbookData,
  workbookDataToInitial,
  workbookFromData,
} from './io';
import { getFormat } from './features/formatting';

function sampleSnapshot(): WorkbookSnapshot {
  const host = new EngineHost();
  const r1 = host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 10 });
  const r2 = host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 0 }, value: 20 });
  const r3 = host.execute({ cmd: 'setFormula', ref: { sheet: 'Sheet1', row: 2, col: 0 }, formula: '=SUM(A1:A2)' });
  const r4 = host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 2 }, value: 'hi' });
  const r5 = host.execute({ cmd: 'addSheet', name: 'Second' });
  const r6 = host.execute({ cmd: 'setCell', ref: { sheet: 'Second', row: 0, col: 0 }, value: true });
  for (const r of [r1, r2, r3, r4, r5, r6]) expect(r.ok).toBe(true);
  return host.snapshot();
}

describe('snapshotToWorkbookData', () => {
  it('produces dense row-major grids from a sparse snapshot', () => {
    const data = snapshotToWorkbookData(sampleSnapshot());
    expect(data.sheets.map((s) => s.name).sort()).toEqual(['Second', 'Sheet1']);

    const s1 = data.sheets.find((s) => s.name === 'Sheet1');
    expect(s1).toBeDefined();
    // A1=10, A2=20, A3==SUM(A1:A2), C1='hi' -> 3 rows x 3 cols
    expect(s1!.rows).toEqual([
      [10, null, 'hi'],
      [20, null, null],
      ['=SUM(A1:A2)', null, null],
    ]);

    const s2 = data.sheets.find((s) => s.name === 'Second');
    expect(s2!.rows).toEqual([[true]]);
  });

  it('handles an empty workbook', () => {
    const data = snapshotToWorkbookData(new EngineHost().snapshot());
    expect(data.sheets).toHaveLength(1);
    expect(data.sheets[0]!.rows).toEqual([]);
  });
});

describe('workbookDataToInitial / workbookFromData', () => {
  it('round-trips snapshot -> WorkbookData -> workbook with live formulas', () => {
    const data: WorkbookData = snapshotToWorkbookData(sampleSnapshot());
    const host = createHostFromWorkbookData(data);

    // Values survive the round trip, including a computed formula.
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 0 })).toEqual({
      kind: 'number',
      value: 10,
    });
    expect(host.readCell({ sheet: 'Sheet1', row: 2, col: 0 })).toEqual({
      kind: 'number',
      value: 30,
    });
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 2 })).toEqual({
      kind: 'string',
      value: 'hi',
    });
    expect(host.readCell({ sheet: 'Second', row: 0, col: 0 })).toEqual({
      kind: 'boolean',
      value: true,
    });
  });

  it('workbookDataToInitial copies grids without aliasing', () => {
    const data: WorkbookData = { sheets: [{ name: 'S', rows: [[1, 2]] }], metadata: {} };
    const initial = workbookDataToInitial(data);
    expect(initial['S']).toEqual([[1, 2]]);
    expect(initial['S']).not.toBe(data.sheets[0]!.rows);
    expect(initial['S']![0]).not.toBe(data.sheets[0]!.rows[0]);
  });

  it('workbookFromData builds a working EngineWorkbook', () => {
    const wb: EngineWorkbook = workbookFromData({
      sheets: [{ name: 'Data', rows: [[5], [6]] }],
      metadata: {},
    });
    const host = new EngineHost(wb);
    expect(host.readCell({ sheet: 'Data', row: 1, col: 0 })).toEqual({
      kind: 'number',
      value: 6,
    });
  });
});

describe('protection-aware io (faces c/e)', () => {
  it('snapshotToWorkbookData carries protection metadata (design §5 hints)', async () => {
    const { ProtectionManager } = await import('@icecream-sheets/engine');
    const protection = new ProtectionManager();
    protection.protectSheet('Sheet1', undefined, {}, { principal: 'user' });
    protection.hideRanges('Sheet1', ['A1'], { principal: 'user' });
    const data = snapshotToWorkbookData(sampleSnapshot(), protection.toMetadata());
    expect(data.metadata['icecream.protection.sheet.Sheet1']).toBeDefined();
    expect(data.metadata['icecream.protection.hidden.Sheet1']).toBeDefined();
    // …and it restores through fromMetadata.
    const p2 = new ProtectionManager();
    p2.fromMetadata(data.metadata as Record<string, unknown>);
    expect(p2.isSheetProtected('Sheet1')).toBe(true);
    expect(p2.isCellHidden('Sheet1', 0, 0)).toBe(true);
  });

  it('snapshotFiltered drops denied cells (design §6: downloads respect permissions)', () => {
    const snap = sampleSnapshot();
    const before = snap.sheets.find((s) => s.name === 'Sheet1')!.cells.length;
    const filtered = snapshotFiltered(
      snap,
      (ref) => ref.sheet === 'Sheet1' && ref.row === 0 && ref.col === 0,
    );
    const s1 = filtered.sheets.find((s) => s.name === 'Sheet1');
    expect(s1).toBeDefined();
    // Sheet1!A1 dropped; everything else survives.
    expect(s1!.cells.some((c) => c.ref.row === 0 && c.ref.col === 0)).toBe(false);
    expect(s1!.cells).toHaveLength(before - 1);
    expect(s1!.cells.some((c) => c.ref.row === 1 && c.ref.col === 0)).toBe(true);
    // Untouched sheets pass through unfiltered.
    const secondBefore = snap.sheets.find((s) => s.name === 'Second')!.cells.length;
    expect(filtered.sheets.find((s) => s.name === 'Second')!.cells).toHaveLength(secondBefore);
  });
});

describe('defined names on save (defect E1)', () => {
  it('mergeDefinedNames: primary wins, secondary only adds, scope-aware, case-insensitive', () => {
    const merged = mergeDefinedNames(
      [
        { name: 'TaxRate', ref: 'Data!$A$1' },
        { name: 'Local', ref: 'Data!$A$2', sheet: 0 },
      ],
      [
        { name: 'taxrate', ref: 'WRONG!$Z$9' }, // collision: primary wins
        { name: 'Local', ref: 'Data!$A$2' }, // workbook scope ≠ sheet scope: kept
        { name: 'StoreOnly', ref: 'Data!$A$3' },
      ],
    );
    expect(merged).toEqual([
      { name: 'TaxRate', ref: 'Data!$A$1' },
      { name: 'Local', ref: 'Data!$A$2', sheet: 0 },
      { name: 'Local', ref: 'Data!$A$2' },
      { name: 'StoreOnly', ref: 'Data!$A$3' },
    ]);
    // The E1 shape: an EMPTY secondary (unpopulated name store) loses nothing.
    expect(mergeDefinedNames([{ name: 'A', ref: 'S!$A$1' }], [])).toHaveLength(1);
    expect(mergeDefinedNames(undefined, undefined)).toEqual([]);
  });

  it('snapshotToWorkbookData defaults to the snapshot names; snapshotFiltered preserves them', () => {
    const host = new EngineHost(
      workbookFromData({
        sheets: [{ name: 'Data', rows: [[0.25], ['=TaxRate*100']] }],
        metadata: {},
        definedNames: [{ name: 'TaxRate', ref: 'Data!$A$1' }],
      }),
    );
    const snap = host.snapshot();
    expect(snap.definedNames).toContainEqual({ name: 'TaxRate', ref: 'Data!$A$1' });
    // No explicit list (the old call passed the store's []): names survive.
    expect(snapshotToWorkbookData(snap, {}, undefined).definedNames).toContainEqual({
      name: 'TaxRate',
      ref: 'Data!$A$1',
    });
    const filtered = snapshotFiltered(snap, () => false);
    expect(filtered.definedNames).toContainEqual({ name: 'TaxRate', ref: 'Data!$A$1' });
    expect(snapshotToWorkbookData(filtered).definedNames).toContainEqual({
      name: 'TaxRate',
      ref: 'Data!$A$1',
    });
  });

  it('save composition round-trips names: bytes carry them, formulas keep them, reopen evaluates', async () => {
    const { XlsxAdapter } = await import('@icecream-sheets/xlsx-adapter');
    // Synthetic name-using workbook: workbook-scoped name used by MANY
    // formulas (the DividendsPctNI shape), a sheet-scoped name, and an
    // HF-unbindable name (RateY1) whose formulas the adapter rewrote to
    // a direct ref at import — the name itself must still round-trip.
    const host = createHostFromWorkbookData({
      sheets: [
        {
          name: 'Data',
          rows: [
            [0.25, 100],
            [null, '=BaseAmt*TaxRate'],
            [null, '=BaseAmt*TaxRate*2'],
            [null, '=SUM(BaseAmt*TaxRate,BaseAmt*TaxRate)'],
          ],
        },
        { name: 'Other', rows: [[7, '=LocalRate*3']] },
      ],
      metadata: {},
      definedNames: [
        { name: 'TaxRate', ref: 'Data!$A$1' },
        { name: 'BaseAmt', ref: 'Data!$B$1' },
        { name: 'LocalRate', ref: 'Other!$A$1', sheet: 1 },
        { name: 'RateY1', ref: 'Data!$A$1' },
      ],
    });
    expect(host.readCell({ sheet: 'Data', row: 1, col: 1 })).toEqual({ kind: 'number', value: 25 });

    // Exactly the fixed buildDownloadBytes composition: snapshot names
    // PRIMARY, name-store exports SECONDARY — here an empty store list,
    // which is what the real app sent for every imported file (E1).
    const snap = snapshotFiltered(host.snapshot(), () => false);
    const wbData = snapshotToWorkbookData(
      snap,
      {},
      mergeDefinedNames(snap.definedNames, []),
    );
    const bytes = new XlsxAdapter().write(wbData);
    const back = new XlsxAdapter().read(bytes);

    // All four names present with correct refs + scope.
    expect(back.definedNames).toHaveLength(4);
    expect(back.definedNames).toContainEqual({ name: 'TaxRate', ref: 'Data!$A$1' });
    expect(back.definedNames).toContainEqual({ name: 'BaseAmt', ref: 'Data!$B$1' });
    expect(back.definedNames).toContainEqual({ name: 'LocalRate', ref: 'Other!$A$1', sheet: 1 });
    expect(back.definedNames).toContainEqual({ name: 'RateY1', ref: 'Data!$A$1' });
    // Formulas still reference the names — no save-side rewriting.
    const dataSheet = back.sheets.find((s) => s.name === 'Data')!;
    expect(dataSheet.rows[1]![1]).toBe('=BaseAmt*TaxRate');
    expect(dataSheet.rows[3]![1]).toBe('=SUM(BaseAmt*TaxRate,BaseAmt*TaxRate)');

    // Reopen: evaluates identically, no #NAME?.
    const host2 = createHostFromWorkbookData(back);
    expect(host2.readCell({ sheet: 'Data', row: 1, col: 1 })).toEqual({ kind: 'number', value: 25 });
    expect(host2.readCell({ sheet: 'Data', row: 2, col: 1 })).toEqual({ kind: 'number', value: 50 });
    expect(host2.readCell({ sheet: 'Data', row: 3, col: 1 })).toEqual({ kind: 'number', value: 50 });
    expect(host2.readCell({ sheet: 'Other', row: 0, col: 1 })).toEqual({ kind: 'number', value: 21 });
  });

  it('perf-p50 fixture: 38 names survive the save composition and reopen evaluates (E1 regression)', async () => {
    const { XlsxAdapter } = await import('@icecream-sheets/xlsx-adapter');
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const fixture = join(here, '..', '..', '..', 'test-data', 'perf-fixtures', 'perf-p50.xlsx');
    const original = new XlsxAdapter().read(new Uint8Array(readFileSync(fixture)));
    expect(original.definedNames).toHaveLength(38);

    const host = createHostFromWorkbookData(original);
    const c13 = { sheet: 'MONTHLY VIEW (LITE)', row: 12, col: 2 };
    const e8 = { sheet: 'OPERATING MODEL', row: 7, col: 4 };
    const before13 = host.readCell(c13);
    const before8 = host.readCell(e8);
    expect(before13).toEqual({ kind: 'number', value: 132942.88335317458 });

    const snap = snapshotFiltered(host.snapshot(), () => false);
    const wbData = snapshotToWorkbookData(snap, {}, mergeDefinedNames(snap.definedNames, []));
    const back = new XlsxAdapter().read(new XlsxAdapter().write(wbData));

    // Names: 38 before → 38 after, DividendsPctNI intact.
    expect(back.definedNames).toHaveLength(38);
    expect(back.definedNames).toContainEqual({ name: 'DividendsPctNI', ref: 'ASSUMPTIONS!$C$63' });
    expect(back.definedNames).toContainEqual({ name: 'NewEquityY1', ref: 'ASSUMPTIONS!$C$62' });
    // The 21 formulas referencing DividendsPctNI still reference it.
    let refs = 0;
    for (const s of back.sheets) {
      for (const row of s.rows) {
        for (const v of row) {
          if (typeof v === 'string' && v.includes('DividendsPctNI')) refs++;
        }
      }
    }
    expect(refs).toBe(21);

    // Reopen evaluates identically — the E1 #NAME? poison is gone.
    const host2 = createHostFromWorkbookData(back);
    expect(host2.readCell(c13)).toEqual(before13);
    expect(host2.readCell(e8)).toEqual(before8);
  }, 120_000);
});

describe('importedFormatsToStore', () => {
  it('converts per-cell format codes into FormatStore entries', () => {
    const data: WorkbookData = {
      sheets: [
        {
          name: 'DASHBOARD',
          rows: [[null, 0.0689]],
          formats: { '0:1': '0.0%;\\(0.0%\\);\\-', '3:0': '#,##0' },
        },
        { name: 'Plain', rows: [[1]] },
      ],
      metadata: {},
    };
    const store = importedFormatsToStore(data);
    expect(getFormat(store, 'DASHBOARD', 0, 1)).toEqual({ formatCode: '0.0%;\\(0.0%\\);\\-' });
    expect(getFormat(store, 'DASHBOARD', 3, 0)).toEqual({ formatCode: '#,##0' });
    expect(getFormat(store, 'Plain', 0, 0)).toBeUndefined();
    expect(store.cells.size).toBe(2);
  });
  it('skips malformed keys and non-string codes', () => {
    const data: WorkbookData = {
      sheets: [
        {
          name: 'S',
          rows: [],
          formats: {
            'nope': '0.0%',
            '1': '0.0%',
            '-1:0': '0.0%',
            '0:-2': '0.0%',
            'a:b': '0.0%',
            '0:0': '',
            '0:1': 42 as unknown as string,
            '2:3': '0.00',
          },
        },
      ],
      metadata: {},
    };
    const store = importedFormatsToStore(data);
    expect(store.cells.size).toBe(1);
    expect(getFormat(store, 'S', 2, 3)).toEqual({ formatCode: '0.00' });
  });
  it('returns an empty store when no sheet has formats', () => {
    const data: WorkbookData = { sheets: [{ name: 'S', rows: [[1]] }], metadata: {} };
    expect(importedFormatsToStore(data).cells.size).toBe(0);
  });
});

describe('format persistence (defect D4)', () => {
  it('ribbon bold + Percentage survive snapshot -> WorkbookData -> xlsx bytes -> parse-back', async () => {
    const { XlsxAdapter } = await import('@icecream-sheets/xlsx-adapter');
    const { unzipSync } = await import('fflate');
    const { createFormatStore, setFormat } = await import('./features/formatting');
    const { applyFormatStoreToWorkbookData } = await import('./io');

    const host = new EngineHost();
    host.execute({ cmd: 'addSheet', name: 'MONTHLY VIEW (LITE)' });
    host.execute({
      cmd: 'setCell',
      ref: { sheet: 'MONTHLY VIEW (LITE)', row: 9, col: 2 },
      value: 0.1667,
    });
    // Exactly what handleFormat does for Bold + the Percentage select.
    let formats = createFormatStore();
    formats = setFormat(formats, 'MONTHLY VIEW (LITE)', 9, 2, { bold: true });
    formats = setFormat(formats, 'MONTHLY VIEW (LITE)', 9, 2, { numberFormat: 'Percentage' });

    // Exactly what buildDownloadBytes does now.
    const wbData = snapshotToWorkbookData(host.snapshot(), {}, undefined);
    applyFormatStoreToWorkbookData(wbData, formats);
    const bytes = new XlsxAdapter().write(wbData);

    // Raw styles proof: a bold font is in the package.
    const files = unzipSync(bytes.slice());
    expect(new TextDecoder().decode(files['xl/styles.xml']!)).toContain('<b/>');
    // Adapter parse-back: the D4 evidence checks, now passing.
    const back = new XlsxAdapter().read(bytes);
    const sheet = back.sheets.find((s) => s.name === 'MONTHLY VIEW (LITE)')!;
    expect(sheet.rows[9]![2]).toBe(0.1667);
    expect(sheet.formats?.['9:2']).toBe('0.00%');
    expect(sheet.styles?.['9:2']).toEqual({ bold: true, numberFormatCode: '0.00%' });
    // And the re-opened store renders it (bold + formatCode seeded).
    const store = importedFormatsToStore(back);
    expect(getFormat(store, 'MONTHLY VIEW (LITE)', 9, 2)).toEqual({ bold: true, formatCode: '0.00%' });
  });

  it('italic/underline/font size/fill/font color ride the same path', async () => {
    const { XlsxAdapter } = await import('@icecream-sheets/xlsx-adapter');
    const { createFormatStore, setFormat } = await import('./features/formatting');
    const { applyFormatStoreToWorkbookData } = await import('./io');
    const host = new EngineHost();
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 'x' });
    let formats = createFormatStore();
    formats = setFormat(formats, 'Sheet1', 0, 0, {
      italic: true,
      underline: true,
      fontSize: 14,
      fillColor: '#FFFF00',
      fontColor: '#FF0000',
    });
    const wbData = snapshotToWorkbookData(host.snapshot(), {}, undefined);
    applyFormatStoreToWorkbookData(wbData, formats);
    const back = new XlsxAdapter().read(new XlsxAdapter().write(wbData));
    expect(back.sheets[0]!.styles?.['0:0']).toEqual({
      italic: true,
      underline: true,
      fontSize: 14,
      fillColor: '#FFFF00',
      fontColor: '#FF0000',
    });
  });

  it('imported styles seed the format store (open path)', () => {
    const data: WorkbookData = {
      sheets: [
        {
          name: 'S',
          rows: [[1]],
          formats: { '0:0': '0.00%' },
          styles: { '0:0': { bold: true, numberFormatCode: '0.00%', fillColor: '#C6EFCE' } },
        },
      ],
      metadata: {},
    };
    const store = importedFormatsToStore(data);
    expect(getFormat(store, 'S', 0, 0)).toEqual({
      formatCode: '0.00%',
      bold: true,
      fillColor: '#C6EFCE',
    });
  });

  it('an unformatted save gains no formats/styles (no noise)', async () => {
    const { applyFormatStoreToWorkbookData } = await import('./io');
    const { createFormatStore } = await import('./features/formatting');
    const wbData = snapshotToWorkbookData(sampleSnapshot(), {}, undefined);
    applyFormatStoreToWorkbookData(wbData, createFormatStore());
    for (const s of wbData.sheets) {
      expect(s.formats).toBeUndefined();
      expect(s.styles).toBeUndefined();
    }
  });
});
