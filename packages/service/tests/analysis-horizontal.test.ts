/**
 * Tests for horizontal-layout recognition (analysis/horizontal.ts):
 * a dimension laid out across a ROW (a year row with measure rows below)
 * must be analyzable by the column-oriented pipeline.
 *
 * Fixture mirrors the real Income-sheet layout (bxl3way): 'Year' label
 * above the run's start, years 2012-2021 across one row, one measure per
 * row below. Revenue figures are the file's exact values.
 */
import { describe, expect, it } from 'vitest';
import {
  categoricalColumns,
  classifyAnalysisIntent,
  detectHorizontalYearLayout,
  extractDataSchema,
  forceTextColumn,
  numericColumns,
  resolvePlan,
  transposeHorizontalYearGrid,
  type CellInput,
} from '../src/analysis/index.js';

const YEARS = [2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021];
const REVENUE = [
  102007, 118086, 131345, 142341, 150772, 158310.6, 165434.577,
  172051.96008, 178073.77868279998, 183415.99204328397,
];
const COGS = [
  39023, 48004, 49123, 53253.99999999999, 57309.99999999999, 58574.922,
  61210.79349, 61938.705628799995, 64106.560325807994, 64195.597215149384,
];
const GROSS = [
  62984, 70082, 82222, 89087, 93462, 99735.67800000001, 104223.78351,
  110113.25445119999, 113967.21835699199, 119220.3948281346,
];

function pad(row: CellInput[], width: number): CellInput[] {
  const out = [...row];
  while (out.length < width) out.push(null);
  return out;
}

// 11 columns (A = row label, B..K = years), mirroring the file's block.
const INCOME_GRID: CellInput[][] = [
  pad(['Income Statement'], 11),
  pad(['', 'Year'], 11),
  pad(['Income Statement', ...YEARS], 11),
  pad(['Revenue', ...REVENUE], 11),
  pad(['Less Cost of Goods Sold', ...COGS], 11),
  pad(['Gross Profit', ...GROSS], 11),
];

describe('detectHorizontalYearLayout', () => {
  it('finds the year row, its run, the Year name, and the measure rows', () => {
    const layout = detectHorizontalYearLayout(INCOME_GRID);
    expect(layout).not.toBeNull();
    expect(layout!.dimensionRow).toBe(2);
    expect(layout!.runStart).toBe(1);
    expect(layout!.runEnd).toBe(10);
    expect(layout!.dimensionName).toBe('Year');
    expect(layout!.measureRows.map((m) => m.label)).toEqual([
      'Revenue',
      'Less Cost of Goods Sold',
      'Gross Profit',
    ]);
  });

  it('falls back to Category when no cell above the run names the dimension', () => {
    const grid: CellInput[][] = [
      ['Sales', 2012, 2013, 2014],
      ['North', 1, 2, 3],
    ];
    const layout = detectHorizontalYearLayout(grid);
    expect(layout).not.toBeNull();
    expect(layout!.dimensionName).toBe('Category');
  });

  it('returns null for a normal vertical layout', () => {
    const grid: CellInput[][] = [
      ['Region', 'Sales'],
      ['North', 100],
      ['South', 200],
    ];
    expect(detectHorizontalYearLayout(grid)).toBeNull();
  });

  it('returns null for a 2-year run, a non-consecutive run, and a run with no measure rows', () => {
    expect(
      detectHorizontalYearLayout([
        ['X', 2012, 2013],
        ['A', 1, 2],
      ]),
    ).toBeNull();
    expect(
      detectHorizontalYearLayout([
        ['X', 2012, 2014, 2016],
        ['A', 1, 2, 3],
      ]),
    ).toBeNull();
    expect(
      detectHorizontalYearLayout([
        ['', 'Year'],
        ['X', 2012, 2013, 2014],
        ['No numbers here', 'a', 'b', 'c'],
      ]),
    ).toBeNull();
  });
});

describe('transposeHorizontalYearGrid', () => {
  it('produces a column-oriented view: Year strings + one column per measure', () => {
    const view = transposeHorizontalYearGrid(INCOME_GRID);
    expect(view).not.toBeNull();
    expect(view![0]).toEqual([
      'Year',
      'Revenue',
      'Less Cost of Goods Sold',
      'Gross Profit',
    ]);
    expect(view!).toHaveLength(11);
    expect(view![1]).toEqual(['2012', 102007, 39023, 62984]);
    expect(view![10]).toEqual([
      '2021',
      183415.99204328397,
      64195.597215149384,
      119220.3948281346,
    ]);
    // Years are strings in the transposed view (the values are strings;
    // their inferred TYPE is numeric — see the forceTextColumn test below).
    for (const row of view!.slice(1)) expect(typeof row[0]).toBe('string');
  });

  it('returns null when no horizontal year layout exists', () => {
    expect(
      transposeHorizontalYearGrid([
        ['Region', 'Sales'],
        ['North', 100],
      ]),
    ).toBeNull();
  });
});

describe('horizontal view through schema + plan resolution', () => {
  it('resolves revenue-by-year to Year x Revenue on the transposed view', async () => {
    const view = transposeHorizontalYearGrid(INCOME_GRID)!;
    const schema = await extractDataSchema(async () => view, {
      sheet: 'Income',
      startRow: 0,
      startCol: 0,
      endRow: view.length - 1,
      endCol: view[0]!.length - 1,
    });
    expect(schema.hasHeaderRow).toBe(true);
    expect(schema.columns.map((c) => c.name)).toEqual([
      'Year',
      'Revenue',
      'Less Cost of Goods Sold',
      'Gross Profit',
    ]);
    // Year strings infer as numeric (numeric strings count as numbers),
    // so the group comes from the exact-hint fallback, not the category pool.
    expect(numericColumns(schema).map((c) => c.name)).toContain('Revenue');

    const plan = classifyAnalysisIntent(
      'Create a small chart of revenue by year from the Income sheet, using the real numbers from the file.',
    );
    expect(plan.intentKind).toBe('aggregate');
    const resolved = resolvePlan(schema, plan);
    expect(resolved.roles['group']).toBe('Year');
    expect(resolved.roles['value']).toBe('Revenue');
  });

  it('forceTextColumn: a transposed dimension with no name match still resolves via the category pool (#152 remaining scope)', async () => {
    // Round-4 leg A: bounds starting at the years row exclude the
    // 'Year' label, so the transposed dimension falls back to
    // 'Category'. Its values are year strings, which infer as NUMERIC
    // — so without forcing, the schema has zero categorical columns
    // and resolvePlan throws 'group-by needs a category column'
    // (hinted fails on an empty pool, exactHinted cannot match
    // 'Category' to 'year'). Forcing the dimension column to text
    // makes the group resolve via cats[0], with no name coincidence.
    const grid: CellInput[][] = [
      ['Income Statement', ...YEARS],
      ['Revenue', ...REVENUE],
    ];
    const view = transposeHorizontalYearGrid(grid)!;
    expect(view[0]![0]).toBe('Category');
    const schema = await extractDataSchema(async () => view, {
      sheet: 'Income',
      startRow: 0,
      startCol: 0,
      endRow: view.length - 1,
      endCol: view[0]!.length - 1,
    });
    expect(schema.hasHeaderRow).toBe(true);
    // The gap, pinned: pre-force the dimension column is numeric.
    expect(schema.columns[0]!.inferredType).toBe('numeric');
    expect(categoricalColumns(schema)).toHaveLength(0);
    const plan = classifyAnalysisIntent(
      'Create a small chart of revenue by year from the Income sheet, using the real numbers from the file.',
    );
    expect(plan.intentKind).toBe('aggregate');
    expect(() => resolvePlan(schema, plan)).toThrow('group-by needs a category column');
    // The fix: force the dimension column categorical, then the group
    // resolves via the category pool with no name match involved.
    const dimValues = view.slice(1).map((row) => row[0]!);
    const forced = forceTextColumn(schema, 0, dimValues);
    expect(forced.columns[0]!.inferredType).toBe('text');
    expect(categoricalColumns(forced).map((c) => c.name)).toEqual(['Category']);
    const resolved = resolvePlan(forced, plan);
    expect(resolved.roles['group']).toBe('Category');
    expect(resolved.roles['value']).toBe('Revenue');
  });

  it('exact-hint fallback: a user-named numeric column still wins the group role', async () => {
    // Vertical layout where years are numbers in a column: without the
    // fallback the plan would group by the unrelated Region column.
    const grid: CellInput[][] = [
      ['Region', 'Year', 'Revenue'],
      ['North', 2012, 100],
      ['North', 2013, 150],
      ['South', 2012, 200],
    ];
    const schema = await extractDataSchema(async () => grid, {
      sheet: 'Sheet1',
      startRow: 0,
      startCol: 0,
      endRow: 3,
      endCol: 2,
    });
    expect(categoricalColumns(schema).map((c) => c.name)).toEqual(['Region']);
    const plan = classifyAnalysisIntent('revenue by year');
    expect(plan.intentKind).toBe('aggregate');
    const resolved = resolvePlan(schema, plan);
    expect(resolved.roles['group']).toBe('Year');
    expect(resolved.roles['value']).toBe('Revenue');
  });
});
