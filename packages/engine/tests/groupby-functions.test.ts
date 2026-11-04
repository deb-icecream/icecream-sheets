/**
 * Tests for GROUPBY and PIVOTBY (src/groupby-functions.ts), implemented to
 * the Microsoft Support specifications ("GROUPBY function" / "PIVOTBY
 * function", Microsoft 365, 2024).
 *
 * The worked examples follow the Microsoft pages' own example formulas
 * (total sales by row field with SUM and field_headers=3; PIVOTBY sales by
 * row field x column field with totals; PERCENTOF with relative_to) on
 * scaled-down versions of their example tables, with every expected cell
 * hand-computed from the source data below. Drives HyperFormula directly
 * (like cube-functions.test.ts) so the full spilled array at the anchor
 * cell can be asserted exactly.
 */
import { describe, expect, it } from 'vitest';
import { EmptyValue, HyperFormula } from 'hyperformula';
import { registerGroupByFunctions } from '../src/groupby-functions.js';

registerGroupByFunctions();

type Grid = unknown[][];

/** Normalize a raw HF value into a plain comparable grid. */
function norm(v: unknown): unknown {
  if (v === EmptyValue || v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map((row) => (Array.isArray(row) ? row.map(norm) : norm(row)));
  if (typeof v === 'object') {
    const rec = v as { value?: unknown; type?: unknown; message?: unknown };
    if (typeof rec.type === 'string' && typeof rec.value === 'string') return rec.value; // DetailedCellError
    if (typeof rec.type === 'string' && typeof rec.message === 'string') {
      // Raw CellError inside a spilled array: map HF type to Excel code.
      const codes: Record<string, string> = {
        VALUE: '#VALUE!', NAME: '#NAME?', DIV_BY_ZERO: '#DIV/0!', NA: '#N/A',
        NUM: '#NUM!', REF: '#REF!', SPILL: '#SPILL!',
      };
      return codes[rec.type] ?? `#${rec.type}!`;
    }
    return v;
  }
  if (typeof v === 'number') return Math.round(v * 1e9) / 1e9;
  return v;
}

/**
 * Build a sheet from `data` (top-left at A1), put `formula` in the anchor
 * cell at (0, anchorCol), and return the normalized spilled result.
 */
function run(data: Grid, formula: string, anchorCol = 8): Grid {
  const rows: unknown[][] = data.map((r) => [...r]);
  while (rows[0]!.length <= anchorCol) rows[0]!.push(null);
  rows[0]![anchorCol] = formula;
  const hf = HyperFormula.buildFromArray(rows as never, { licenseKey: 'gpl-v3' });
  const v = hf.getCellValue({ sheet: 0, row: 0, col: anchorCol });
  const g = norm(v) as Grid;
  return Array.isArray(g) && Array.isArray(g[0]) ? g : [[g]];
}

function runErr(data: Grid, formula: string, anchorCol = 8): string {
  const g = run(data, formula, anchorCol);
  const top = g[0]?.[0];
  return typeof top === 'string' ? top : JSON.stringify(g);
}

// ---------------------------------------------------------------------------
// Source data (hand-computed expectations below derive from these rows)
// ---------------------------------------------------------------------------

// Region | Product | Sales   (header row + 5 records)
const SALES: Grid = [
  ['Region', 'Product', 'Sales'],
  ['East', 'Apples', 100],
  ['East', 'Oranges', 150],
  ['West', 'Apples', 200],
  ['West', 'Oranges', 50],
  ['North', 'Apples', 300],
];
// By Region: East 250, North 300, West 250; grand total 800.

// Region | Year | Sales   (header row + 6 records)
const BY_YEAR: Grid = [
  ['Region', 'Year', 'Sales'],
  ['East', 2023, 100],
  ['East', 2024, 150],
  ['West', 2023, 200],
  ['West', 2024, 50],
  ['North', 2023, 300],
  ['North', 2024, 100],
];
// Rows: East 250, North 400, West 250. Cols: 2023 = 600, 2024 = 300. Grand 900.

// Region | Product | Year | Sales   (header row + 5 records, sparse cross)
const SPARSE: Grid = [
  ['Region', 'Product', 'Year', 'Sales'],
  ['East', 'Apples', 2023, 100],
  ['East', 'Apples', 2024, 120],
  ['East', 'Oranges', 2023, 150],
  ['West', 'Apples', 2023, 200],
  ['West', 'Oranges', 2024, 50],
];

// ---------------------------------------------------------------------------
// GROUPBY — Microsoft worked examples
// ---------------------------------------------------------------------------

describe('GROUPBY (Microsoft examples)', () => {
  it('Example: total sales by Region, headers shown, grand total by default', () => {
    // MS example form: =GROUPBY(row_fields, values, SUM, 3)
    const out = run(SALES, '=GROUPBY(A1:A6,C1:C6,SUM,3)', 5);
    expect(out).toEqual([
      ['Region', 'Sales'],
      ['East', 250],
      ['North', 300],
      ['West', 250],
      ['Total', 800],
    ]);
  });

  it('Example: two row fields with grand totals and subtotals (total_depth=2)', () => {
    const out = run(SALES, '=GROUPBY(A1:B6,C1:C6,SUM,3,2)', 5);
    expect(out).toEqual([
      ['Region', 'Product', 'Sales'],
      ['East', 'Apples', 100],
      ['East', 'Oranges', 150],
      ['East', 'Total', 250],
      ['North', 'Apples', 300],
      ['North', 'Total', 300],
      ['West', 'Apples', 200],
      ['West', 'Oranges', 50],
      ['West', 'Total', 250],
      ['Total', null, 800],
    ]);
  });

  it('subtotals and grand total at the top (total_depth=-2)', () => {
    const out = run(SALES, '=GROUPBY(A1:B6,C1:C6,SUM,3,-2)', 5);
    expect(out).toEqual([
      ['Region', 'Product', 'Sales'],
      ['Total', null, 800],
      ['East', 'Total', 250],
      ['East', 'Apples', 100],
      ['East', 'Oranges', 150],
      ['North', 'Total', 300],
      ['North', 'Apples', 300],
      ['West', 'Total', 250],
      ['West', 'Apples', 200],
      ['West', 'Oranges', 50],
    ]);
  });

  it('no headers, no totals (field_headers=0, total_depth=0)', () => {
    const out = run(SALES, '=GROUPBY(A2:A6,C2:C6,SUM,0,0)', 5);
    expect(out).toEqual([
      ['East', 250],
      ['North', 300],
      ['West', 250],
    ]);
  });

  it('automatic header detection: headers stripped, not shown, total shown', () => {
    const out = run(SALES, '=GROUPBY(A1:A6,C1:C6,SUM)', 5);
    expect(out).toEqual([
      ['East', 250],
      ['North', 300],
      ['West', 250],
      ['Total', 800],
    ]);
  });
});

describe('GROUPBY options', () => {
  it('field_headers=1: headers present but not shown', () => {
    const out = run(SALES, '=GROUPBY(A1:A6,C1:C6,SUM,1,0)', 5);
    expect(out).toEqual([
      ['East', 250],
      ['North', 300],
      ['West', 250],
    ]);
  });

  it('field_headers=2: headers generated ("Row Field 1" / "Value 1")', () => {
    const out = run(SALES, '=GROUPBY(A2:A6,C2:C6,SUM,2,0)', 5);
    expect(out).toEqual([
      ['Row Field 1', 'Value 1'],
      ['East', 250],
      ['North', 300],
      ['West', 250],
    ]);
  });

  it('sort_order=-2 sorts by the value column descending', () => {
    const out = run(SALES, '=GROUPBY(A2:A6,C2:C6,SUM,0,0,-2)', 5);
    expect(out).toEqual([
      ['North', 300],
      ['East', 250],
      ['West', 250],
    ]);
  });

  it('sort_order=-1 sorts the field descending', () => {
    const out = run(SALES, '=GROUPBY(A2:A6,C2:C6,SUM,0,0,-1)', 5);
    expect(out).toEqual([
      ['West', 250],
      ['North', 300],
      ['East', 250],
    ]);
  });

  it('sort_order as a vector sorts by multiple field columns', () => {
    // {2,-1}: Product ascending within Region descending.
    const out = run(SALES, '=GROUPBY(A2:B6,C2:C6,SUM,0,0,{2,-1})', 5);
    expect(out).toEqual([
      ['West', 'Apples', 200],
      ['West', 'Oranges', 50],
      ['North', 'Apples', 300],
      ['East', 'Apples', 100],
      ['East', 'Oranges', 150],
    ]);
  });

  it('filter_array (Boolean column) keeps only matching source rows', () => {
    const data: Grid = SALES.map((r, i) => [...r, i === 0 ? 'Keep' : r[0] === 'East']);
    const out = run(data, '=GROUPBY(A2:A6,C2:C6,SUM,0,0,,D2:D6)', 6);
    expect(out).toEqual([['East', 250]]);
  });

  it('filter_array as a logical expression over the source rows', () => {
    const out = run(SALES, '=GROUPBY(A2:A6,C2:C6,SUM,0,0,,A2:A6<>"West")', 5);
    expect(out).toEqual([
      ['East', 250],
      ['North', 300],
    ]);
  });

  it('field_relationship=1 (table) sorts leaf groups flat', () => {
    const out = run(SALES, '=GROUPBY(A2:B6,C2:C6,SUM,0,0,,,1)', 5);
    expect(out).toEqual([
      ['East', 'Apples', 100],
      ['East', 'Oranges', 150],
      ['North', 'Apples', 300],
      ['West', 'Apples', 200],
      ['West', 'Oranges', 50],
    ]);
  });

  it('multiple value columns aggregate side by side', () => {
    const data: Grid = [
      ['Region', 'Units', 'Sales'],
      ['East', 2, 100],
      ['East', 3, 150],
      ['West', 4, 200],
    ];
    const out = run(data, '=GROUPBY(A1:A4,B1:C4,SUM,3,0)', 5);
    expect(out).toEqual([
      ['Region', 'Units', 'Sales'],
      ['East', 5, 250],
      ['West', 4, 200],
    ]);
  });
});

describe('GROUPBY functions argument', () => {
  it('HSTACK(SUM,AVERAGE,COUNT) produces multiple calculations with a label row', () => {
    const out = run(SALES, '=GROUPBY(A2:A6,C2:C6,HSTACK(SUM,AVERAGE,COUNT),0,0)', 5);
    expect(out).toEqual([
      [null, 'SUM', 'AVERAGE', 'COUNT'],
      ['East', 250, 125, 2],
      ['North', 300, 300, 1],
      ['West', 250, 125, 2],
    ]);
  });

  it('VSTACK(SUM,AVERAGE) stacks calculations row-wise', () => {
    const out = run(SALES, '=GROUPBY(A2:A6,C2:C6,VSTACK(SUM,AVERAGE),0,0)', 5);
    expect(out).toEqual([
      ['East', 250],
      [null, 125],
      ['North', 300],
      [null, 300],
      ['West', 250],
      [null, 125],
    ]);
  });

  it('custom labels via VSTACK(HSTACK(...), {...})', () => {
    const out = run(
      SALES,
      '=GROUPBY(A2:A6,C2:C6,VSTACK(HSTACK(SUM,COUNT),{"Total","#"}),0,0)',
      5,
    );
    expect(out).toEqual([
      [null, 'Total', '#'],
      ['East', 250, 2],
      ['North', 300, 1],
      ['West', 250, 2],
    ]);
  });

  it('PERCENTOF gives each group its share of the grand total', () => {
    const out = run(SALES, '=GROUPBY(A2:A6,C2:C6,PERCENTOF,0,0)', 5);
    expect(out).toEqual([
      ['East', 0.3125],
      ['North', 0.375],
      ['West', 0.3125],
    ]);
  });

  it('a custom LAMBDA aggregation (eta-long form)', () => {
    const out = run(SALES, '=GROUPBY(A2:A6,C2:C6,LAMBDA(x,SUM(x)*2),0,0)', 5);
    expect(out).toEqual([
      ['East', 500],
      ['North', 600],
      ['West', 500],
    ]);
  });

  it('a two-argument LAMBDA receives the total set', () => {
    const out = run(
      SALES,
      '=GROUPBY(A2:A6,C2:C6,LAMBDA(subset,total,SUM(subset)/SUM(total)),0,0)',
      5,
    );
    expect(out).toEqual([
      ['East', 0.3125],
      ['North', 0.375],
      ['West', 0.3125],
    ]);
  });

  it('COUNTA / MAX / MIN eta lambdas', () => {
    const out = run(SALES, '=GROUPBY(A2:A6,B2:B6,COUNTA,0,0)', 5);
    expect(out).toEqual([
      ['East', 2],
      ['North', 1],
      ['West', 2],
    ]);
    const outMax = run(SALES, '=GROUPBY(A2:A6,C2:C6,MAX,0,0)', 5);
    expect(outMax).toEqual([
      ['East', 150],
      ['North', 300],
      ['West', 200],
    ]);
  });
});

describe('GROUPBY errors', () => {
  it('subtotals with a single row field return #VALUE!', () => {
    expect(runErr(SALES, '=GROUPBY(A2:A6,C2:C6,SUM,0,2)', 5)).toBe('#VALUE!');
  });

  it('sort_order out of range returns #VALUE!', () => {
    expect(runErr(SALES, '=GROUPBY(A2:A6,C2:C6,SUM,0,0,5)', 5)).toBe('#VALUE!');
  });

  it('field_headers outside 0..3 returns #VALUE!', () => {
    expect(runErr(SALES, '=GROUPBY(A2:A6,C2:C6,SUM,5,0)', 5)).toBe('#VALUE!');
  });

  it('mismatched row counts return #VALUE!', () => {
    expect(runErr(SALES, '=GROUPBY(A2:A6,C2:C5,SUM)', 5)).toBe('#VALUE!');
  });

  it('filter_array of the wrong length returns #VALUE!', () => {
    const data: Grid = SALES.map((r, i) => [...r, i <= 2]);
    expect(runErr(data, '=GROUPBY(A2:A6,C2:C6,SUM,0,0,,D1:D3)', 6)).toBe('#VALUE!');
  });

  it('field_relationship=1 with subtotals returns #VALUE!', () => {
    expect(runErr(SALES, '=GROUPBY(A2:B6,C2:C6,SUM,0,2,,,1)', 5)).toBe('#VALUE!');
  });

  it('an unknown eta function surfaces #NAME? in the value cells', () => {
    const out = run(SALES, '=GROUPBY(A2:A6,C2:C6,NOSUCHFN,0,0)', 5);
    expect(out[0]).toEqual(['East', '#NAME?']);
  });
});

// ---------------------------------------------------------------------------
// PIVOTBY — Microsoft worked examples
// ---------------------------------------------------------------------------

describe('PIVOTBY (Microsoft examples)', () => {
  it('Example: sales by Region (rows) and Year (columns), headers and totals', () => {
    // MS example form: =PIVOTBY(row_fields, col_fields, values, SUM, 3)
    const out = run(BY_YEAR, '=PIVOTBY(A1:A7,B1:B7,C1:C7,SUM,3)', 5);
    expect(out).toEqual([
      ['Year', 2023, 2024, 'Total'],
      ['Region', 'Sales', 'Sales', 'Sales'],
      ['East', 100, 150, 250],
      ['North', 300, 100, 400],
      ['West', 200, 50, 250],
      ['Total', 600, 300, 900],
    ]);
  });

  it('Example: required arguments only, no headers or totals requested', () => {
    const out = run(BY_YEAR, '=PIVOTBY(A2:A7,B2:B7,C2:C7,SUM,0,0,,0)', 5);
    expect(out).toEqual([
      [null, 2023, 2024],
      ['East', 100, 150],
      ['North', 300, 100],
      ['West', 200, 50],
    ]);
  });

  it('multiple row fields with subtotals; missing combinations are blank', () => {
    const out = run(SPARSE, '=PIVOTBY(A2:B6,C2:C6,D2:D6,SUM,0,2,,0)', 6);
    expect(out).toEqual([
      [null, null, 2023, 2024],
      ['East', 'Apples', 100, 120],
      ['East', 'Oranges', 150, null],
      ['East', 'Total', 250, 120],
      ['West', 'Apples', 200, null],
      ['West', 'Oranges', null, 50],
      ['West', 'Total', 200, 50],
      ['Total', null, 450, 170],
    ]);
  });

  it('col_fields may be omitted (behaves like GROUPBY)', () => {
    const out = run(BY_YEAR, '=PIVOTBY(A2:A7,,C2:C7,SUM,0)', 5);
    expect(out).toEqual([
      ['East', 250],
      ['North', 400],
      ['West', 250],
      ['Total', 900],
    ]);
  });
});

describe('PIVOTBY options', () => {
  it('row_sort_order=-2 sorts rows by their totals descending', () => {
    const out = run(BY_YEAR, '=PIVOTBY(A2:A7,B2:B7,C2:C7,SUM,0,1,-2,1)', 5);
    expect(out).toEqual([
      [null, 2023, 2024, 'Total'],
      ['North', 300, 100, 400],
      ['East', 100, 150, 250],
      ['West', 200, 50, 250],
      ['Total', 600, 300, 900],
    ]);
  });

  it('filter_array restricts the source rows before pivoting', () => {
    const data: Grid = BY_YEAR.map((r, i) => [...r, i === 0 ? 'Keep' : r[1] === 2024]);
    const out = run(data, '=PIVOTBY(A2:A7,B2:B7,C2:C7,SUM,0,0,,0,,D2:D7)', 6);
    expect(out).toEqual([
      [null, 2024],
      ['East', 150],
      ['North', 100],
      ['West', 50],
    ]);
  });

  it('HSTACK(SUM,AVERAGE) produces two calculations under each column group', () => {
    const out = run(BY_YEAR, '=PIVOTBY(A2:A7,B2:B7,C2:C7,HSTACK(SUM,AVERAGE),0,0,,0)', 5);
    expect(out).toEqual([
      [null, 2023, null, 2024, null],
      [null, 'SUM', 'AVERAGE', 'SUM', 'AVERAGE'],
      ['East', 100, 100, 150, 150],
      ['North', 300, 300, 100, 100],
      ['West', 200, 200, 50, 50],
    ]);
  });

  it('a custom LAMBDA aggregation', () => {
    const out = run(BY_YEAR, '=PIVOTBY(A2:A7,,C2:C7,LAMBDA(x,MAX(x)-MIN(x)),0,0)', 5);
    expect(out).toEqual([
      ['East', 50],
      ['North', 200],
      ['West', 150],
    ]);
  });
});

describe('PIVOTBY PERCENTOF and relative_to', () => {
  it('relative_to=2 (grand totals): each cell is a share of 900', () => {
    const out = run(BY_YEAR, '=PIVOTBY(A2:A7,B2:B7,C2:C7,PERCENTOF,0,0,,0,,,2)', 5);
    expect(out).toEqual([
      [null, 2023, 2024],
      ['East', 0.111111111, 0.166666667],
      ['North', 0.333333333, 0.111111111],
      ['West', 0.222222222, 0.055555556],
    ]);
  });

  it('relative_to=0 (column totals, the default)', () => {
    const out = run(BY_YEAR, '=PIVOTBY(A2:A7,B2:B7,C2:C7,PERCENTOF,0,0,,0,,,0)', 5);
    expect(out).toEqual([
      [null, 2023, 2024],
      ['East', 0.166666667, 0.5],
      ['North', 0.5, 0.333333333],
      ['West', 0.333333333, 0.166666667],
    ]);
  });

  it('relative_to=1 (row totals)', () => {
    const out = run(BY_YEAR, '=PIVOTBY(A2:A7,B2:B7,C2:C7,PERCENTOF,0,0,,0,,,1)', 5);
    expect(out).toEqual([
      [null, 2023, 2024],
      ['East', 0.4, 0.6],
      ['North', 0.75, 0.25],
      ['West', 0.8, 0.2],
    ]);
  });

  it('a two-argument LAMBDA honours relative_to like PERCENTOF', () => {
    const out = run(
      BY_YEAR,
      '=PIVOTBY(A2:A7,B2:B7,C2:C7,LAMBDA(subset,total,SUM(subset)/SUM(total)),0,0,,0,,,1)',
      5,
    );
    expect(out).toEqual([
      [null, 2023, 2024],
      ['East', 0.4, 0.6],
      ['North', 0.75, 0.25],
      ['West', 0.8, 0.2],
    ]);
  });
});

describe('PIVOTBY errors', () => {
  it('relative_to outside 0..4 returns #VALUE!', () => {
    expect(runErr(BY_YEAR, '=PIVOTBY(A2:A7,B2:B7,C2:C7,SUM,0,0,,0,,,5)', 5)).toBe('#VALUE!');
  });

  it('row subtotals with a single row field return #VALUE!', () => {
    expect(runErr(BY_YEAR, '=PIVOTBY(A2:A7,B2:B7,C2:C7,SUM,0,2,,0)', 5)).toBe('#VALUE!');
  });

  it('mismatched row counts return #VALUE!', () => {
    expect(runErr(BY_YEAR, '=PIVOTBY(A2:A7,B2:B6,C2:C7,SUM)', 5)).toBe('#VALUE!');
  });
});
