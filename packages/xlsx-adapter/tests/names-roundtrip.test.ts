/**
 * XLSX defined-names round-trip (design-docs/named-ranges-and-named-functions.md §3):
 * named ranges (workbook + sheet scope, dangling #REF!) and LAMBDA named
 * functions survive a write → read cycle through the SheetJS adapter.
 */
import { describe, expect, it } from 'vitest';
import {
  EngineWorkbook,
  type CellInput,
  type WorkbookData,
} from '@icecream-sheets/engine';
import { XlsxAdapter } from '../src/index.js';

function toWorkbookData(wb: EngineWorkbook): WorkbookData {
  const snap = wb.toSnapshot();
  const sheets = snap.sheets.map((sheet) => {
    let maxRow = -1;
    let maxCol = -1;
    for (const cell of sheet.cells) {
      maxRow = Math.max(maxRow, cell.ref.row);
      maxCol = Math.max(maxCol, cell.ref.col);
    }
    const rows: CellInput[][] = [];
    for (let r = 0; r <= maxRow; r++) rows.push(new Array<CellInput>(maxCol + 1).fill(null));
    for (const cell of sheet.cells) {
      const row = rows[cell.ref.row];
      if (row) row[cell.ref.col] = cell.input;
    }
    return { name: sheet.name, rows };
  });
  return {
    sheets,
    metadata: {},
    definedNames: wb.listNamedRanges().map((d) => ({
      name: d.name,
      ref: d.liveRefersTo,
      // sheet-scoped names carry their 0-based sheet index.
      ...(d.scope === 'workbook' ? {} : { sheet: wb.sheetIndex(d.scope) }),
    })),
  };
}

describe('xlsx defined-names round-trip (§3)', () => {
  it('named ranges survive write → read (workbook + sheet scope)', async () => {
    const wb = new EngineWorkbook({ Sheet1: [[1], [2]], Sheet2: [[10]] });
    wb.defineNamedRange('SalesTotal', 'Sheet1!$A$1:$A$2', 'workbook');
    wb.defineNamedRange('LocalRate', 'Sheet2!$A$1', 'Sheet2');
    wb.setFormula({ sheet: 'Sheet1', row: 0, col: 1 }, '=SUM(SalesTotal)');

    const adapter = new XlsxAdapter();
    const bytes = await adapter.write(toWorkbookData(wb));
    const data = await adapter.read(bytes);

    const names = data.definedNames ?? [];
    expect(names.map((n) => n.name).sort()).toEqual(['LocalRate', 'SalesTotal']);
    const wb2 = new EngineWorkbook(
      { Sheet1: data.sheets[0]!.rows, Sheet2: data.sheets[1]!.rows },
      { definedNames: names },
    );
    // Formulas resolve through the round-tripped names.
    expect(wb2.listNamedRanges()).toHaveLength(2);
    wb2.setFormula({ sheet: 'Sheet1', row: 0, col: 1 }, '=SUM(SalesTotal)');
    expect(wb2.getValue({ sheet: 'Sheet1', row: 0, col: 1 })).toEqual({ kind: 'number', value: 3 });
    const local = wb2.listNamedRanges().find((d) => d.name === 'LocalRate')!;
    expect(local.scope).toBe('Sheet2');
  });

  it('dangling (#REF!) names round-trip and stay dangling', async () => {
    const wb = new EngineWorkbook({ Sheet1: [[5]] });
    wb.defineNamedRange('GoneRef', '#REF!', 'workbook');

    const adapter = new XlsxAdapter();
    const bytes = await adapter.write(toWorkbookData(wb));
    const data = await adapter.read(bytes);

    const gone = (data.definedNames ?? []).find((n) => n.name === 'GoneRef');
    expect(gone).toBeDefined();
    expect(gone!.ref).toContain('#REF!');
    const wb2 = new EngineWorkbook({ Sheet1: [[5]] }, { definedNames: data.definedNames });
    expect(wb2.listNamedRanges().find((d) => d.name === 'GoneRef')!.dangling).toBe(true);
  });

  it('LAMBDA named functions ride along as defined names', async () => {
    const wb = new EngineWorkbook({ Sheet1: [[]] });
    wb.defineNamedFunctionDef({
      name: 'TripleIt',
      signature: { params: [{ name: 'x', type: 'number' }], returns: 'number' },
      language: 'lambda',
      source: '=LAMBDA(x, x*3)',
    });
    const fnDefs = wb.listNamedFunctionDefs();
    const data = toWorkbookData(wb);
    data.definedNames = [
      ...(data.definedNames ?? []),
      ...fnDefs
        .filter((f) => f.language === 'lambda')
        .map((f) => ({ name: f.name, ref: f.source })),
    ];

    const adapter = new XlsxAdapter();
    const bytes = await adapter.write(data);
    const readBack = await adapter.read(bytes);
    const fn = (readBack.definedNames ?? []).find((n) => n.name === 'TripleIt');
    expect(fn).toBeDefined();
    expect(fn!.ref.toUpperCase()).toContain('LAMBDA');

    // And the re-imported function is callable.
    const wb2 = new EngineWorkbook({ Sheet1: [[]] });
    wb2.defineNamedFunctionDef({
      name: fn!.name,
      signature: { params: [{ name: 'x', type: 'number' }], returns: 'number' },
      language: 'lambda',
      source: fn!.ref,
    });
    wb2.setFormula({ sheet: 'Sheet1', row: 0, col: 0 }, '=TRIPLEIT(14)');
    expect(wb2.getValue({ sheet: 'Sheet1', row: 0, col: 0 })).toEqual({ kind: 'number', value: 42 });
  });
});
