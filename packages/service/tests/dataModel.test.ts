/**
 * Data-model build from worksheet ranges (#114, Piece 2), with the
 * bxl3way shapes: tblCal (Period->Year) joined to fact tables on Period,
 * exact sums, a sign-flipped measure, and a ratio measure — all resolved
 * against cached pivot outputs, plus the gating rules.
 */
import { describe, expect, it } from 'vitest';
import { queryOlapPivot } from '@icecream-sheets/engine';
import {
  buildDataModel,
  parseDimensionField,
  parseMeasureBase,
  type DataModelBuildInput,
} from '../src/dataModel.js';
import type {
  ImportedConnection,
  ImportedPivotTable,
  TableDef,
} from '@icecream-sheets/xlsx-adapter';

// Computed-value grids (as an engine view would return them), one per sheet.
const grids = new Map<string, unknown[][]>();
function putGrid(sheet: string, rows: unknown[][]): void {
  grids.set(sheet, rows);
}
putGrid('Calcs', [
  ['Period', 'Year'],
  [1, 2012],
  [2, 2013],
  [3, 2014],
]);
putGrid('Calcs2', [
  ['Period', 'Revenue', 'Cost of Goods Sold'],
  [1, 100, 40],
  [2, 200, 90],
  [3, 300, 90],
]);
putGrid('Calcs3', [
  ['Period', 'Cash from Operations', 'Cash from Investing', 'Cash from Financing', 'Closing Cash Balance'],
  [1, 10, 15, 170, 195],
  [2, 20, 25, 0, 215],
  [3, 30, 10, -20, 225],
]);
putGrid('Calcs4', [
  ['Period', 'Revenue Growth'],
  [1, 0],
  [2, 0.1],
  [3, 0.2],
]);
putGrid('Summaries', [
  ['Year', ' Revenue', ' Gross Profit', ' Earnings Before Taxes'],
  [2012, 100, 60, 10],
  [2013, 200, 110, 20],
  [2014, 300, 210, 30],
]);

// NOTE: the test grids above are laid out as separate sheets for
// simplicity; the builder reads by table bounds, so each table gets its
// own sheet here. The anchor cells live on 'Summaries'.
const tables: TableDef[] = [
  { name: 'tblCal', sheet: 'Calcs', startRow: 0, startCol: 0, endRow: 3, endCol: 1, columns: ['Period', 'Year'], headerRow: true, totalsRow: false },
  { name: 'tblIS', sheet: 'Calcs2', startRow: 0, startCol: 0, endRow: 3, endCol: 2, columns: ['Period', 'Revenue', 'Cost of Goods Sold'], headerRow: true, totalsRow: false },
  { name: 'tblCF', sheet: 'Calcs3', startRow: 0, startCol: 0, endRow: 3, endCol: 4, columns: ['Period', 'Cash from Operations', 'Cash from Investing', 'Cash from Financing', 'Closing Cash Balance'], headerRow: true, totalsRow: false },
  { name: 'tblPAA', sheet: 'Calcs4', startRow: 0, startCol: 0, endRow: 3, endCol: 1, columns: ['Period', 'Revenue Growth'], headerRow: true, totalsRow: false },
];

function pivot(overrides: Partial<ImportedPivotTable>): ImportedPivotTable {
  return {
    name: 'pvtEarnings',
    sheetName: 'Summaries',
    sheetIndex: 0,
    cacheId: 119,
    fieldNames: ['[tblCal].[Year].[Year]', '[Measures].[Sum of Revenue]'],
    records: [],
    hasRecords: false,
    source: { kind: 'external', detail: 'ThisWorkbookDataModel' },
    rows: ['[tblCal].[Year].[Year]'],
    columns: [],
    dataOnRows: false,
    values: [{ field: '[Measures].[Sum of Revenue]', aggregation: 'sum', label: ' Revenue' }],
    filters: [],
    anchor: { row: 0, col: 0, ref: 'A1:B4' },
    styleName: '',
    dataCaption: 'Values',
    rowGrandTotals: true,
    colGrandTotals: true,
    ...overrides,
  };
}

const connections: ImportedConnection[] = [
  { name: 'ThisWorkbookDataModel', isDataModel: true },
];

function readRange(sheet: string, r0: number, c0: number, r1: number, c1: number): unknown[][] {
  const grid = grids.get(sheet) ?? [];
  const out: unknown[][] = [];
  for (let r = r0; r <= r1; r += 1) {
    const row: unknown[] = [];
    for (let c = c0; c <= c1; c += 1) row.push(grid[r]?.[c] ?? null);
    out.push(row);
  }
  return out;
}

function input(overrides: Partial<DataModelBuildInput> = {}): DataModelBuildInput {
  return { tables, connections, pivots: [pivot({})], readRange, ...overrides };
}

describe('parse helpers', () => {
  it('parses dimension and measure fields', () => {
    expect(parseDimensionField('[tblCal].[Year].[Year]')).toEqual({ table: 'tblCal', column: 'Year' });
    expect(parseDimensionField('[tblCal].[Year]')).toEqual({ table: 'tblCal', column: 'Year' });
    expect(parseDimensionField('Year')).toBeNull();
    expect(parseMeasureBase('[Measures].[Sum of Revenue]')).toBe('Revenue');
    expect(parseMeasureBase('[Measures].[Sum of COGS Pct of Rev]')).toBe('COGS Pct of Rev');
    expect(parseMeasureBase('[tblCal].[Year]')).toBeNull();
  });
});

describe('buildDataModel', () => {
  it('returns null without a data-model connection', () => {
    expect(buildDataModel(input({ connections: [] }))).toBeNull();
  });

  it('returns null without tables', () => {
    expect(buildDataModel(input({ tables: [] }))).toBeNull();
  });

  it('resolves an exact-sum pivot and reproduces its cached column', () => {
    const built = buildDataModel(input());
    expect(built).not.toBeNull();
    const p = built!.pivots.find((x) => x.name === 'pvtEarnings')!;
    expect(p).toBeDefined();
    expect(p.dimensionTable).toBe('tblCal');
    expect(p.joinColumn).toBe('Period');
    const m = queryOlapPivot(built!.model, p, null);
    expect(m.rowKeys).toEqual(['2012', '2013', '2014']);
    expect(m.data).toEqual([[100], [200], [300]]);
  });

  it('resolves a sign-flipped measure by calibration', () => {
    const cf = pivot({
      name: 'pvtCF',
      fieldNames: ['[tblCal].[Year].[Year]', '[Measures].[Sum of invested Cash]'],
      values: [{ field: '[Measures].[Sum of invested Cash]', aggregation: 'sum', label: 'invested Cash' }],
      anchor: { row: 0, col: 0, ref: 'A1:B4' },
    });
    // Cached column for the CF pivot lives on a dedicated sheet whose
    // values are the negated investing sums (the calibration target).
    putGrid('SummariesCF', [
      ['Year', 'invested Cash'],
      [2012, -15],
      [2013, -25],
      [2014, -10],
    ]);
    const built = buildDataModel(
      input({ pivots: [{ ...cf, sheetName: 'SummariesCF' }] }),
    );
    expect(built).not.toBeNull();
    const p = built!.pivots.find((x) => x.name === 'pvtCF')!;
    expect(p).toBeDefined();
    expect(p.values[0]).toMatchObject({ kind: 'sum', table: 'tblCF', column: 'Cash from Investing', sign: -1 });
    const m = queryOlapPivot(built!.model, p, ['2013']);
    expect(m.rowKeys).toEqual(['2013']);
    expect(m.data).toEqual([[-25]]);
  });

  it('resolves a ratio measure by calibration', () => {
    putGrid('SummariesCpR', [
      ['Year', 'COGS Pct of Rev'],
      [2012, 0.4],
      [2013, 0.45],
      [2014, 0.3],
    ]);
    const cpr = pivot({
      name: 'pvtCpR',
      fieldNames: ['[tblCal].[Year].[Year]', '[Measures].[Sum of COGS Pct of Rev]'],
      values: [{ field: '[Measures].[Sum of COGS Pct of Rev]', aggregation: 'sum', label: 'COGS Pct of Rev' }],
      anchor: { row: 0, col: 0, ref: 'A1:B4' },
      sheetName: 'SummariesCpR',
    });
    const built = buildDataModel(input({ pivots: [cpr] }));
    expect(built).not.toBeNull();
    const p = built!.pivots.find((x) => x.name === 'pvtCpR')!;
    expect(p.values[0]).toMatchObject({
      kind: 'ratio',
      table: 'tblIS',
      numeratorColumn: 'Cost of Goods Sold',
      denominatorColumn: 'Revenue',
    });
  });

  it('skips pivots with column fields or unresolvable measures (never wrong values)', () => {
    const colPivot = pivot({ name: 'pvtCol', columns: ['[tblCal].[Year].[Year]'] });
    // Cached values no candidate column reproduces (999/888/777 match
    // neither Revenue nor any sign-flip/ratio of the model tables).
    putGrid('SummariesBad', [
      ['Year', 'NoSuchColumn'],
      [2012, 999],
      [2013, 888],
      [2014, 777],
    ]);
    const badMeasure = pivot({
      name: 'pvtBad',
      sheetName: 'SummariesBad',
      values: [{ field: '[Measures].[Sum of NoSuchColumn]', aggregation: 'sum', label: 'NoSuchColumn' }],
    });
    const built = buildDataModel(input({ pivots: [colPivot, badMeasure] }));
    expect(built).toBeNull();
  });
});
