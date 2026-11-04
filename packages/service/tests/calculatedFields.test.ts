/**
 * Tests for report calculated fields (native-reports-and-dashboards.md §3):
 * { name, expression } evaluated in the engine's formula language over the
 * bound row, usable everywhere a column-bound field is (table columns, KPI
 * values, chart series via pivots, filters/sorting). Errors surface as
 * proper error values, never crashes.
 */
import { describe, expect, it } from 'vitest';
import {
  CalculatedFieldEvaluator,
  REPORT_SPEC_VERSION,
  applyReportFilters,
  computeKpi,
  createPivot,
  extractFieldReferences,
  makeKpiSpec,
  makeReportSpec,
  materializeCalculatedFields,
  migrateReportSpec,
  normalizeCalculatedExpression,
  validateCalculatedField,
  validateReportSpec,
  type CalculatedField,
  type PivotRecord,
  type ReportBinding,
} from '../src/index.js';

const binding: ReportBinding = {
  id: 'b1',
  name: 'Sales',
  sheet: 'Sheet1',
  startRow: 0,
  startCol: 0,
  endRow: 5,
  endCol: 3,
  headerRow: 0,
  fields: ['Region', 'Quarter', 'Revenue', 'Cost'],
  calculatedFields: [
    { name: 'Profit', expression: '=[Revenue]-[Cost]' },
    { name: 'Net90', expression: '=[Revenue]*0.9' },
  ],
};

const records: PivotRecord[] = [
  { Region: 'East', Quarter: 'Q1', Revenue: 100, Cost: 60 },
  { Region: 'West', Quarter: 'Q1', Revenue: 200, Cost: 150 },
  { Region: 'East', Quarter: 'Q2', Revenue: 50, Cost: 0 },
];

describe('expression helpers', () => {
  it('extracts [Field] references in order', () => {
    expect(extractFieldReferences('=[Revenue]-[Cost]+[Revenue]')).toEqual(['Revenue', 'Cost']);
    expect(extractFieldReferences('=SUM([Qty]*[Price])')).toEqual(['Qty', 'Price']);
    expect(extractFieldReferences('=1+2')).toEqual([]);
  });

  it('normalizes the leading =', () => {
    expect(normalizeCalculatedExpression('[A]+[B]')).toBe('=[A]+[B]');
    expect(normalizeCalculatedExpression('  =[A] ')).toBe('=[A]');
  });
});

describe('CalculatedFieldEvaluator', () => {
  it('computes =[Revenue]-[Cost] over bound rows with the engine evaluator', () => {
    const ev = new CalculatedFieldEvaluator();
    const r = ev.evaluateRow(binding.fields, binding.calculatedFields, records[0]!);
    expect(r['Profit']).toEqual({ ok: true, value: 40 });
    expect(r['Net90']).toEqual({ ok: true, value: 90 });
    const r2 = ev.evaluateRow(binding.fields, binding.calculatedFields, records[1]!);
    expect(r2['Profit']).toEqual({ ok: true, value: 50 });
  });

  it('evaluates the full formula language, not just arithmetic', () => {
    const ev = new CalculatedFieldEvaluator();
    const r = ev.evaluateRow(
      ['Name', 'Score'],
      [{ name: 'Grade', expression: '=IF([Score]>=90,"A",IF([Score]>=70,"B","C"))' }],
      { Name: 'Ann', Score: 85 },
    );
    expect(r['Grade']).toEqual({ ok: true, value: 'B' });
  });

  it('surfaces expression errors as proper error values, not crashes', () => {
    const ev = new CalculatedFieldEvaluator();
    const r = ev.evaluateRow(
      ['Revenue', 'Cost'],
      [
        { name: 'Div', expression: '=[Revenue]/[Cost]' },
        { name: 'Bad', expression: '=NOSUCHFUNC([Revenue])' },
        { name: 'Unknown', expression: '=[Nope]+1' },
      ],
      { Revenue: 100, Cost: 0 },
    );
    expect(r['Div']).toEqual({ ok: false, error: '#DIV/0!' });
    expect(r['Bad']).toEqual({ ok: false, error: '#NAME?' });
    expect(r['Unknown']).toEqual({ ok: false, error: 'unknown field "[Nope]"' });
  });

  it('supports chained calculated fields in declaration order', () => {
    const ev = new CalculatedFieldEvaluator();
    const r = ev.evaluateRow(
      ['Revenue', 'Cost'],
      [
        { name: 'Profit', expression: '=[Revenue]-[Cost]' },
        { name: 'Margin', expression: '=IF([Revenue]=0,0,[Profit]/[Revenue])' },
      ],
      { Revenue: 200, Cost: 50 },
    );
    expect(r['Profit']).toEqual({ ok: true, value: 150 });
    expect(r['Margin']).toEqual({ ok: true, value: 0.75 });
  });

  it('treats bound string values starting with = as literal text', () => {
    const ev = new CalculatedFieldEvaluator();
    const r = ev.evaluateRow(
      ['Code'],
      [{ name: 'Label', expression: '=[Code]&"!"' }],
      { Code: '=1+1' },
    );
    expect(r['Label']).toEqual({ ok: true, value: '=1+1!' });
  });
});

describe('materializeCalculatedFields', () => {
  it('adds calculated values to every row; errors become error codes', () => {
    const out = materializeCalculatedFields(records, binding);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ Profit: 40, Net90: 90 });
    expect(out[1]).toMatchObject({ Profit: 50, Net90: 180 });
    expect(out[2]).toMatchObject({ Profit: 50, Net90: 45 });
    // Originals are untouched.
    expect(records[0]).not.toHaveProperty('Profit');

    const withErr = materializeCalculatedFields(
      [{ Revenue: 10, Cost: 0 }],
      { fields: ['Revenue', 'Cost'], calculatedFields: [{ name: 'D', expression: '=[Revenue]/[Cost]' }] },
    );
    expect(withErr[0]).toMatchObject({ D: '#DIV/0!' });
  });

  it('is a no-op copy when the binding has no calculated fields', () => {
    const out = materializeCalculatedFields(records, { fields: ['Region'], calculatedFields: [] });
    expect(out).toEqual(records);
    expect(out[0]).not.toBe(records[0]);
  });
});

describe('calculated fields everywhere a column field works', () => {
  it('table columns: materialized records expose the calculated field', () => {
    const out = materializeCalculatedFields(records, binding);
    const tableFields = ['Region', 'Profit'];
    const rows = out.map((r) => tableFields.map((f) => r[f]));
    expect(rows).toEqual([
      ['East', 40],
      ['West', 50],
      ['East', 50],
    ]);
  });

  it('KPI values: computeKpi aggregates a calculated field', () => {
    const out = materializeCalculatedFields(records, binding);
    const kpi = makeKpiSpec({ field: 'Profit', aggregation: 'sum', label: 'Total profit' });
    const res = computeKpi(out, kpi);
    expect(res.value).toBe(140);
  });

  it('chart series via pivot: a pivot value field can be a calculated field', () => {
    const out = materializeCalculatedFields(records, binding);
    const pivot = createPivot(out, {
      version: 1,
      rows: ['Region'],
      columns: [],
      values: [{ field: 'Profit', aggregation: 'sum' }],
    });
    const east = pivot.rowKeys.findIndex((k) => k[0] === 'East');
    expect(east).toBeGreaterThanOrEqual(0);
    // Sum of Profit for East = 40 + 50 = 90 (data[row][col][valueField]).
    expect(pivot.data[east]![0]![0]).toBe(90);
  });

  it('filters: report filters match on calculated field values', () => {
    const out = materializeCalculatedFields(records, binding);
    const filtered = applyReportFilters(out, [
      { id: 'f1', field: 'Profit', op: '>', value: 45 },
    ]);
    expect(filtered.map((r) => r['Region'])).toEqual(['West', 'East']);
  });
});

describe('spec validation and migration', () => {
  it('validateCalculatedField rejects bad definitions', () => {
    const cols = ['Revenue', 'Cost'];
    expect(validateCalculatedField({ name: 'P', expression: '=[Revenue]-[Cost]' }, cols, new Set())).toEqual([]);
    expect(
      validateCalculatedField({ name: 'P', expression: '=[Nope]' }, cols, new Set()),
    ).toEqual(['calculated field "P": unknown field reference "[Nope]"']);
    expect(
      validateCalculatedField({ name: 'Revenue', expression: '=[Cost]' }, cols, new Set()),
    ).toEqual(['calculated field "Revenue" collides with a binding column field']);
    expect(
      validateCalculatedField({ name: 'P', expression: '=[Cost]' }, cols, new Set(['P'])),
    ).toEqual(['duplicate calculated field name "P"']);
    expect(validateCalculatedField({ name: 'P', expression: '' }, cols, new Set()).length).toBeGreaterThan(0);
    // Chained reference to a sibling calculated field is allowed.
    expect(
      validateCalculatedField({ name: 'M', expression: '=[P]/[Revenue]' }, cols, new Set(['P'])),
    ).toEqual([]);
  });

  it('a full report spec with calculated fields validates', () => {
    const spec = makeReportSpec({
      name: 'Calc report',
      bindings: [binding],
      visuals: [
        {
          id: 'v-table',
          title: 'T',
          bindingId: 'b1',
          kind: 'table',
          fields: ['Region', 'Profit'],
          maxRows: 10,
        },
        {
          id: 'v-kpi',
          title: 'K',
          bindingId: 'b1',
          kind: 'kpi',
          kpi: makeKpiSpec({ field: 'Profit', aggregation: 'sum', label: 'Profit' }),
        },
      ],
      slicers: [{ id: 's1', field: 'Region', selected: [] }],
      filters: [{ id: 'f1', field: 'Profit', op: '>', value: 10 }],
      refresh: { mode: 'manual', schedule: null },
    });
    expect(validateReportSpec(spec)).toEqual([]);
  });

  it('validation rejects unknown references and unknown visual fields', () => {
    const bad: ReportBinding = {
      ...binding,
      calculatedFields: [{ name: 'Bad', expression: '=[Nope]+1' }],
    };
    const spec = makeReportSpec({
      name: 'Bad report',
      bindings: [bad],
      visuals: [
        { id: 'v-t', title: 'T', bindingId: 'b1', kind: 'table', fields: ['Nope'], maxRows: 5 },
      ],
      slicers: [],
      filters: [],
      refresh: { mode: 'manual', schedule: null },
    });
    const errors = validateReportSpec(spec);
    expect(errors.some((e) => e.includes('unknown field reference "[Nope]"'))).toBe(true);
    expect(errors.some((e) => e.includes('unknown table field "Nope"'))).toBe(true);
  });

  it('migration fills calculatedFields for older specs and bumps the version', () => {
    expect(REPORT_SPEC_VERSION).toBe(2);
    const spec = migrateReportSpec({
      version: 1,
      name: 'Old',
      bindings: [{ id: 'b1', fields: ['A'] }],
    });
    expect(spec.version).toBe(REPORT_SPEC_VERSION);
    expect(spec.bindings[0]!.calculatedFields).toEqual([]);
  });

  it('migration normalizes calculated field entries', () => {
    const b = migrateReportSpec({
      name: 'M',
      bindings: [
        {
          id: 'b1',
          fields: ['Revenue', 'Cost'],
          calculatedFields: [
            { name: 'Profit', expression: '[Revenue]-[Cost]' },
            { name: '  ', expression: '=[Cost]' },
            { name: 'Revenue', expression: '=[Cost]' },
            null,
          ],
        },
      ],
    }).bindings[0]!;
    expect(b.calculatedFields).toEqual([{ name: 'Profit', expression: '=[Revenue]-[Cost]' }]);
  });
});

describe('CalculatedField type shape', () => {
  it('is { name, expression }', () => {
    const cf: CalculatedField = { name: 'X', expression: '=[A]' };
    expect(Object.keys(cf).sort()).toEqual(['expression', 'name']);
  });
});
