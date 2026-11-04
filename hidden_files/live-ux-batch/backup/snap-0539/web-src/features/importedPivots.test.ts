import { describe, expect, it } from 'vitest';
import {
  buildImportedPivotResult,
  importedPivotMatrix,
  importedPivotRecords,
  importedPivotSourceRange,
  importedPivotToSpec,
  importedPivotsFromMetadata,
  pivotPartsFromMetadata,
} from '@icecream-sheets/service';
import type { ImportedPivotTable } from '@icecream-sheets/xlsx-adapter';

function makePivot(overrides: Partial<ImportedPivotTable> = {}): ImportedPivotTable {
  return {
    name: 'SalesPivot',
    sheetName: 'Data',
    sheetIndex: 0,
    cacheId: 0,
    fieldNames: ['Region', 'Amount'],
    records: [
      ['East', 10],
      ['West', 20],
      ['East', 30],
    ],
    hasRecords: true,
    source: { kind: 'worksheet', sheet: 'Data', ref: 'A1:B4' },
    rows: ['Region'],
    columns: [],
    dataOnRows: false,
    values: [{ field: 'Amount', aggregation: 'sum', label: 'Total Amount' }],
    filters: [],
    anchor: { row: 0, col: 3, ref: 'D1:E5' },
    styleName: 'PivotStyleLight16',
    dataCaption: 'Values',
    rowGrandTotals: true,
    colGrandTotals: true,
    ...overrides,
  };
}

describe('importedPivotsFromMetadata', () => {
  it('returns [] for missing/corrupt metadata (never throws)', () => {
    expect(importedPivotsFromMetadata(undefined)).toEqual([]);
    expect(importedPivotsFromMetadata('')).toEqual([]);
    expect(importedPivotsFromMetadata('not json')).toEqual([]);
    expect(importedPivotsFromMetadata('{"a":1}')).toEqual([]);
    expect(importedPivotsFromMetadata(JSON.stringify([{ name: 1 }]))).toEqual([]);
  });

  it('parses and validates the adapter payload', () => {
    const t = makePivot();
    const parsed = importedPivotsFromMetadata(JSON.stringify([t, { bogus: true }]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.name).toBe('SalesPivot');
    expect(parsed[0]?.records).toHaveLength(3);
  });
});

describe('pivotPartsFromMetadata', () => {
  it('validates the raw-parts shape (never throws)', () => {
    expect(pivotPartsFromMetadata(undefined)).toBeUndefined();
    expect(pivotPartsFromMetadata({ tables: [] })).toBeUndefined();
    const good = { tables: [], parts: {}, caches: [] };
    expect(pivotPartsFromMetadata(good)).toBe(good);
  });
});

describe('importedPivotToSpec', () => {
  it('maps the imported shape onto a versioned PivotSpec', () => {
    const spec = importedPivotToSpec(
      makePivot({ filters: [{ field: 'Region', selected: ['East'] }] }),
    );
    expect(spec.version).toBe(1);
    expect(spec.rows).toEqual(['Region']);
    expect(spec.columns).toEqual([]);
    expect(spec.values).toEqual([{ field: 'Amount', aggregation: 'sum', label: 'Total Amount' }]);
    expect(spec.filters).toEqual([{ field: 'Region', selected: ['East'] }]);
  });

  it('omits filters when there are none', () => {
    expect(importedPivotToSpec(makePivot()).filters).toBeUndefined();
  });
});

describe('buildImportedPivotResult', () => {
  it('computes the layout through the service pivot component', () => {
    const result = buildImportedPivotResult(makePivot());
    expect(result).not.toBeNull();
    expect(result?.rowKeys).toEqual([['East'], ['West']]);
    expect(result?.valueLabels).toEqual(['Total Amount']);
    // East = 10 + 30, West = 20.
    expect(result?.data[0]?.[0]?.[0]).toBe(40);
    expect(result?.data[1]?.[0]?.[0]).toBe(20);
    expect(result?.grandTotals).toEqual([60]);
    expect(result?.sourceRowCount).toBe(3);
  });

  it('applies the imported filters', () => {
    const result = buildImportedPivotResult(
      makePivot({ filters: [{ field: 'Region', selected: ['East'] }] }),
    );
    expect(result?.rowKeys).toEqual([['East']]);
    expect(result?.grandTotals).toEqual([40]);
    expect(result?.filteredRowCount).toBe(2);
  });

  it('returns null (never throws) when there is nothing to compute', () => {
    expect(buildImportedPivotResult(makePivot({ hasRecords: false, records: [] }))).toBeNull();
    expect(buildImportedPivotResult(makePivot({ values: [] }))).toBeNull();
    // Unknown field in the spec mapping → createPivot throws → null.
    expect(buildImportedPivotResult(makePivot({ rows: ['Nope'] }))).toBeNull();
  });

  it('exposes records with the cache field names as headers', () => {
    expect(importedPivotRecords(makePivot())).toEqual([
      { Region: 'East', Amount: 10 },
      { Region: 'West', Amount: 20 },
      { Region: 'East', Amount: 30 },
    ]);
  });
});

describe('importedPivotSourceRange', () => {
  it('parses a worksheet source ref into a live-refresh range', () => {
    expect(importedPivotSourceRange(makePivot())).toEqual({
      sheet: 'Data',
      startRow: 0,
      startCol: 0,
      endRow: 3,
      endCol: 1,
    });
  });

  it('returns null for non-range sources', () => {
    expect(
      importedPivotSourceRange(
        makePivot({ source: { kind: 'worksheet', sheet: '', ref: '', name: 'Table1' } }),
      ),
    ).toBeNull();
    expect(importedPivotSourceRange(makePivot({ source: { kind: 'scenario' } }))).toBeNull();
    expect(
      importedPivotSourceRange(
        makePivot({ source: { kind: 'worksheet', sheet: 'Data', ref: 'bogus' } }),
      ),
    ).toBeNull();
  });
});

describe('importedPivotMatrix', () => {
  function twoValuePivot(): ImportedPivotTable {
    return makePivot({
      fieldNames: ['Region', 'Qtr', 'A', 'B'],
      records: [
        ['East', 'Q1', 10, 1],
        ['East', 'Q2', 20, 2],
        ['West', 'Q1', 30, 3],
      ],
      rows: ['Region'],
      columns: ['Qtr'],
      values: [
        { field: 'A', aggregation: 'sum', label: 'Sum of A' },
        { field: 'B', aggregation: 'sum', label: 'Sum of B' },
      ],
    });
  }

  it('uses the standard values-across-columns layout by default', () => {
    const result = buildImportedPivotResult(twoValuePivot())!;
    const matrix = importedPivotMatrix(result, false);
    // Header: corner + row field + (col key × values) + grand totals.
    expect(matrix[0]).toEqual([null, 'Region', 'Q1 — Sum of A', 'Q1 — Sum of B', 'Q2 — Sum of A', 'Q2 — Sum of B', 'Grand Total — Sum of A', 'Grand Total — Sum of B']);
    expect(matrix[1]?.slice(0, 3)).toEqual([null, 'East', 10]);
  });

  it('nests values under row keys when the file puts Values on rows', () => {
    const result = buildImportedPivotResult(twoValuePivot())!;
    const matrix = importedPivotMatrix(result, true);
    // Header: corner + row fields + value-label column + col keys + total.
    expect(matrix[0]).toEqual([null, 'Region', null, 'Q1', 'Q2', 'Grand Total']);
    // East expands to one row per value field.
    expect(matrix[1]).toEqual([null, 'East', 'Sum of A', 10, 20, 30]);
    expect(matrix[2]).toEqual([null, '', 'Sum of B', 1, 2, 3]);
    expect(matrix[3]?.slice(0, 3)).toEqual([null, 'West', 'Sum of A']);
    // Grand total row expands the same way.
    const totalRows = matrix.slice(-2);
    expect(totalRows[0]?.slice(0, 3)).toEqual(['Grand Total', null, 'Sum of A']);
    expect(totalRows[0]?.[5]).toBe(60);
    expect(totalRows[1]?.[5]).toBe(6);
  });

  it('falls back to the standard matrix for single-value pivots', () => {
    const result = buildImportedPivotResult(makePivot())!;
    const matrix = importedPivotMatrix(result, true);
    expect(matrix[0]).toEqual([null, 'Region', 'Total Amount', 'Grand Total']);
  });
});
