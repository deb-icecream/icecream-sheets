import { describe, expect, it } from 'vitest';
import {
  REPORT_SPEC_VERSION,
  makeReportSpec,
  migrateReportSpec,
  validateReportSpec,
  serializeReports,
  deserializeReports,
  isRefreshDue,
  createReportStore,
  memoryPersistence,
  KPI_SPEC_VERSION,
  makeKpiSpec,
  validateKpiSpec,
  computeKpi,
  makeReportSlicer,
  toggleSlicerValue,
  clearReportSlicer,
  slicerPasses,
  slicerLabelOf,
  distinctFieldValues,
  applySlicers,
  applyReportFilters,
  applyFiltersAndSlicers,
  validateReportFilter,
  type ReportBinding,
  type ReportSpec,
  type PivotRecord,
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
  fields: ['Region', 'Quarter', 'Sales', 'Units'],
};

const records: PivotRecord[] = [
  { Region: 'East', Quarter: 'Q1', Sales: 100, Units: 10 },
  { Region: 'East', Quarter: 'Q2', Sales: 200, Units: 20 },
  { Region: 'West', Quarter: 'Q1', Sales: 150, Units: 15 },
  { Region: 'West', Quarter: 'Q2', Sales: 250, Units: 25 },
  { Region: 'East', Quarter: 'Q1', Sales: 50, Units: 5 },
];

function validSpec(): ReportSpec {
  return makeReportSpec({
    name: 'Q1 Report',
    bindings: [binding],
    visuals: [
      {
        id: 'v-kpi',
        title: 'Total Sales',
        bindingId: 'b1',
        kind: 'kpi',
        kpi: makeKpiSpec({ field: 'Sales', aggregation: 'sum', label: 'Total Sales', target: 700 }),
      },
      {
        id: 'v-pivot',
        title: 'By Region',
        bindingId: 'b1',
        kind: 'pivot',
        pivot: { version: 1, rows: ['Region'], columns: [], values: [{ field: 'Sales', aggregation: 'sum' }] },
      },
    ],
    slicers: [{ id: 's1', field: 'Region', selected: [] }],
    filters: [],
    refresh: { mode: 'manual', schedule: null },
  });
}

describe('report spec migration', () => {
  it('fills defaults for an empty payload', () => {
    const spec = migrateReportSpec({});
    expect(spec.version).toBe(REPORT_SPEC_VERSION);
    expect(spec.name).toBe('Untitled report');
    expect(spec.bindings).toEqual([]);
    expect(spec.visuals).toEqual([]);
    expect(spec.refresh.mode).toBe('manual');
    expect(spec.dataAsOf).toBeNull();
  });

  it('auto-places visuals that have no layout cell', () => {
    const spec = migrateReportSpec({ visuals: [{ kind: 'table', id: 't1', bindingId: 'b1', fields: ['Region'] }] });
    expect(spec.layout.cells).toHaveLength(1);
    expect(spec.layout.cells[0].visualId).toBe('t1');
  });

  it('normalizes a scheduled refresh spec', () => {
    const spec = migrateReportSpec({ refresh: { mode: 'scheduled', schedule: { kind: 'daily', time: '08:30' } } });
    expect(spec.refresh.mode).toBe('scheduled');
    expect(spec.refresh.schedule?.kind).toBe('daily');
    expect(spec.refresh.schedule?.time).toBe('08:30');
  });

  it('drops an invalid schedule time', () => {
    const spec = migrateReportSpec({ refresh: { mode: 'scheduled', schedule: { kind: 'daily', time: 'nope' } } });
    expect(spec.refresh.schedule?.time).toBeUndefined();
  });

  it('migrates a chart visual through migrateChart defaults', () => {
    const spec = migrateReportSpec({
      visuals: [{ kind: 'chart', id: 'c1', bindingId: 'b1', chart: { kind: 'pie' } }],
    });
    const v = spec.visuals[0];
    expect(v.kind).toBe('chart');
    if (v.kind === 'chart') {
      expect(v.chart.kind).toBe('pie');
      expect(v.chart.legend).toBe('bottom');
    }
  });
});

describe('report spec validation', () => {
  it('accepts a well-formed spec', () => {
    expect(validateReportSpec(validSpec())).toEqual([]);
  });

  it('rejects a non-object', () => {
    expect(validateReportSpec(null)).toHaveLength(1);
  });

  it('rejects a wrong version', () => {
    const spec = validSpec() as unknown as Record<string, unknown>;
    expect(validateReportSpec({ ...spec, version: 99 })).toHaveLength(1);
  });

  it('rejects an empty name', () => {
    const spec = validSpec();
    spec.name = '  ';
    expect(validateReportSpec(spec).some((e) => e.includes('name'))).toBe(true);
  });

  it('rejects a visual with an unknown binding', () => {
    const spec = validSpec();
    spec.visuals[0].bindingId = 'nope';
    expect(validateReportSpec(spec).some((e) => e.includes('bindingId'))).toBe(true);
  });

  it('rejects duplicate visual ids', () => {
    const spec = validSpec();
    spec.visuals.push({ ...spec.visuals[0] });
    spec.layout.cells.push({ visualId: spec.visuals[0].id, row: 5, col: 0, rowSpan: 1, colSpan: 1 });
    expect(validateReportSpec(spec).some((e) => e.includes('duplicate visual'))).toBe(true);
  });

  it('rejects overlapping layout cells', () => {
    const spec = validSpec();
    spec.layout.cells = [
      { visualId: 'v-kpi', row: 0, col: 0, rowSpan: 1, colSpan: 2 },
      { visualId: 'v-pivot', row: 0, col: 1, rowSpan: 1, colSpan: 1 },
    ];
    expect(validateReportSpec(spec).some((e) => e.includes('overlap'))).toBe(true);
  });

  it('rejects a visual with no layout cell', () => {
    const spec = validSpec();
    spec.layout.cells = spec.layout.cells.slice(0, 1);
    expect(validateReportSpec(spec).some((e) => e.includes('no cell'))).toBe(true);
  });

  it('rejects a slicer on a field in no binding', () => {
    const spec = validSpec();
    spec.slicers = [{ id: 's2', field: 'Nope', selected: [] }];
    expect(validateReportSpec(spec).some((e) => e.includes('slicers[0]'))).toBe(true);
  });

  it('rejects a scheduled refresh without a schedule', () => {
    const spec = validSpec();
    spec.refresh = { mode: 'scheduled', schedule: null };
    expect(validateReportSpec(spec).some((e) => e.includes('schedule'))).toBe(true);
  });

  it('rejects a kpi visual whose field is not in the binding', () => {
    const spec = validSpec();
    const v = spec.visuals[0];
    if (v.kind === 'kpi') v.kpi = makeKpiSpec({ field: 'Missing', aggregation: 'sum' });
    expect(validateReportSpec(spec).some((e) => e.includes('kpi field'))).toBe(true);
  });

  it('rejects a table visual with an unknown field', () => {
    const spec = validSpec();
    spec.visuals = [
      { id: 'v-t', title: 'T', bindingId: 'b1', kind: 'table', fields: ['Nope'], maxRows: 10 },
    ];
    spec.layout = {
      columns: 2,
      cells: [{ visualId: 'v-t', row: 0, col: 0, rowSpan: 1, colSpan: 1 }],
    };
    expect(validateReportSpec(spec).some((e) => e.includes('table field'))).toBe(true);
  });

  it('rejects a malformed dataAsOf', () => {
    const spec = validSpec();
    spec.dataAsOf = 'not-a-date';
    expect(validateReportSpec(spec).some((e) => e.includes('dataAsOf'))).toBe(true);
  });

  it('validateKpiSpec checks aggregation and thresholds', () => {
    const bad = { ...makeKpiSpec({ field: 'Sales' }), aggregation: 'median' as never };
    expect(validateKpiSpec(bad)).toHaveLength(1);
    const badT = makeKpiSpec({ field: 'Sales', thresholds: [{ value: 10, status: 'great' as never }] });
    expect(validateKpiSpec(badT).some((e) => e.includes('threshold'))).toBe(true);
    expect(validateKpiSpec(makeKpiSpec({ field: 'Sales' }))).toEqual([]);
  });
});

describe('report serialization + store', () => {
  it('round-trips through serialize/deserialize', () => {
    const spec = validSpec();
    const back = deserializeReports(serializeReports([spec]));
    expect(back).toHaveLength(1);
    expect(back[0].name).toBe('Q1 Report');
    expect(validateReportSpec(back[0])).toEqual([]);
  });

  it('returns [] for corrupt payloads', () => {
    expect(deserializeReports('nope')).toEqual([]);
    expect(deserializeReports('{"reports": 42}')).toEqual([]);
  });

  it('persists through the metadata store', () => {
    const store = createReportStore(memoryPersistence());
    const spec = validSpec();
    store.add(spec);
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0].id).toBe(spec.id);
    store.remove((r) => r.id === spec.id);
    expect(store.all()).toHaveLength(0);
  });

  it('isRefreshDue honors the schedule kind', () => {
    const spec = validSpec();
    spec.refresh = { mode: 'scheduled', schedule: { kind: 'hourly' } };
    spec.dataAsOf = null;
    expect(isRefreshDue(spec)).toBe(true);
    spec.dataAsOf = new Date().toISOString();
    expect(isRefreshDue(spec)).toBe(false);
    spec.dataAsOf = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(isRefreshDue(spec)).toBe(true);
    spec.refresh.mode = 'manual';
    expect(isRefreshDue(spec)).toBe(false);
  });
});

describe('KPI computation', () => {
  it('sums the field', () => {
    const r = computeKpi(records, makeKpiSpec({ field: 'Sales', aggregation: 'sum', label: 'Sales' }));
    expect(r.value).toBe(750);
    expect(r.formatted).toBe('750');
  });

  it('averages the field', () => {
    const r = computeKpi(records, makeKpiSpec({ field: 'Sales', aggregation: 'average' }));
    expect(r.value).toBe(150);
  });

  it('counts non-blank and numeric values', () => {
    const withBlank: PivotRecord[] = [...records, { Region: 'East', Quarter: 'Q3', Sales: null, Units: 0 }];
    expect(computeKpi(withBlank, makeKpiSpec({ field: 'Sales', aggregation: 'count' })).value).toBe(5);
    expect(computeKpi(withBlank, makeKpiSpec({ field: 'Sales', aggregation: 'countnums' })).value).toBe(5);
  });

  it('computes delta vs target and delta percent', () => {
    const r = computeKpi(records, makeKpiSpec({ field: 'Sales', aggregation: 'sum', target: 700 }));
    expect(r.delta).toBe(50);
    expect(r.deltaPct).toBeCloseTo(7.142857, 4);
    expect(r.deltaFormatted).toBe('+50');
  });

  it('handles a zero target (deltaPct null)', () => {
    const r = computeKpi(records, makeKpiSpec({ field: 'Sales', aggregation: 'sum', target: 0 }));
    expect(r.delta).toBe(750);
    expect(r.deltaPct).toBeNull();
  });

  it('colors by thresholds (first match from the top wins)', () => {
    const spec = makeKpiSpec({
      field: 'Sales',
      aggregation: 'sum',
      thresholds: [
        { value: 800, status: 'good' },
        { value: 600, status: 'warn' },
        { value: 0, status: 'bad' },
      ],
    });
    expect(computeKpi(records, spec).status).toBe('warn'); // 750 >= 600
  });

  it('is neutral when no threshold matches', () => {
    const r = computeKpi(records, makeKpiSpec({ field: 'Sales', aggregation: 'sum', thresholds: [{ value: 1000, status: 'good' }] }));
    expect(r.status).toBe('neutral');
  });

  it('returns null value and em-dash when there is no data', () => {
    const r = computeKpi([], makeKpiSpec({ field: 'Sales', aggregation: 'sum' }));
    expect(r.value).toBeNull();
    expect(r.formatted).toBe('—');
    expect(r.status).toBe('neutral');
  });

  it('formats currency and percent', () => {
    const c = computeKpi(records, makeKpiSpec({ field: 'Sales', aggregation: 'sum', format: 'currency' }));
    expect(c.formatted).toBe('$750.00');
    const p = computeKpi([{ x: 0.25 }], makeKpiSpec({ field: 'x', aggregation: 'average', format: 'percent' }));
    expect(p.formatted).toBe('25.0%');
  });

  it('rejects an invalid spec', () => {
    expect(() => computeKpi(records, { version: 99 } as never)).toThrow();
  });

  it('KPI_SPEC_VERSION is 1', () => {
    expect(KPI_SPEC_VERSION).toBe(1);
  });
});

describe('report slicers', () => {
  it('makeReportSlicer defaults to select-all', () => {
    const s = makeReportSlicer({ field: 'Region' });
    expect(s.selected).toEqual([]);
    expect(s.field).toBe('Region');
  });

  it('toggleSlicerValue toggles and collapses back to all', () => {
    const all = ['East', 'West'];
    let s = makeReportSlicer({ field: 'Region' });
    // From select-all, toggling deselects.
    s = toggleSlicerValue(s, 'East', all);
    expect(s.selected).toEqual(['West']);
    // Deselecting the last one is the same as selecting all again.
    s = toggleSlicerValue(s, 'West', all);
    expect(s.selected).toEqual([]);
    // Toggle on then off returns to select-all.
    s = toggleSlicerValue(s, 'East', all);
    s = toggleSlicerValue(s, 'East', all);
    expect(s.selected).toEqual([]);
  });

  it('clearReportSlicer selects all', () => {
    const s = clearReportSlicer({ id: 's', field: 'Region', selected: ['East'] });
    expect(s.selected).toEqual([]);
  });

  it('slicerPasses honors the selection', () => {
    const s = { id: 's', field: 'Region', selected: ['East'] };
    expect(slicerPasses(s, 'East')).toBe(true);
    expect(slicerPasses(s, 'West')).toBe(false);
    expect(slicerPasses({ ...s, selected: [] }, 'West')).toBe(true);
  });

  it('slicerLabelOf uses pivot conventions', () => {
    expect(slicerLabelOf(null)).toBe('(blank)');
    expect(slicerLabelOf('')).toBe('(blank)');
    expect(slicerLabelOf(true)).toBe('TRUE');
    expect(slicerLabelOf(42)).toBe('42');
  });

  it('distinctFieldValues lists sorted labels', () => {
    expect(distinctFieldValues(records, 'Region')).toEqual(['East', 'West']);
    expect(distinctFieldValues(records, 'Sales')).toEqual(['100', '150', '200', '250', '50']);
  });

  it('applySlicers filters only bindings that include the field', () => {
    const slicer = { id: 's', field: 'Region', selected: ['East'] };
    const out = applySlicers(records, binding, [slicer]);
    expect(out).toHaveLength(3);
    expect(out.every((r) => r.Region === 'East')).toBe(true);

    const otherBinding: ReportBinding = { ...binding, id: 'b2', fields: ['Quarter', 'Sales'] };
    expect(applySlicers(records, otherBinding, [slicer])).toHaveLength(5);
  });

  it('applySlicers with no active slicers returns records untouched', () => {
    expect(applySlicers(records, binding, [{ id: 's', field: 'Region', selected: [] }])).toBe(records);
  });

  it('applyReportFilters supports typed ops', () => {
    expect(applyReportFilters(records, [{ id: 'f', field: 'Sales', op: '>', value: 150 }])).toHaveLength(2);
    expect(applyReportFilters(records, [{ id: 'f', field: 'Region', op: '=', value: 'East' }])).toHaveLength(3);
    expect(applyReportFilters(records, [{ id: 'f', field: 'Region', op: '!=', value: 'East' }])).toHaveLength(2);
    expect(applyReportFilters(records, [{ id: 'f', field: 'Quarter', op: 'contains', value: 'q1' }])).toHaveLength(3);
    expect(applyReportFilters(records, [{ id: 'f', field: 'Sales', op: '<=', value: 100 }])).toHaveLength(2);
  });

  it('applyFiltersAndSlicers scopes filters by binding fields', () => {
    const otherBinding: ReportBinding = { ...binding, id: 'b2', fields: ['Quarter', 'Sales'] };
    const out = applyFiltersAndSlicers(
      records,
      otherBinding,
      [{ id: 's', field: 'Region', selected: ['East'] }],
      [{ id: 'f', field: 'Sales', op: '>', value: 150 }],
    );
    // Region slicer does not apply to b2; Sales filter does.
    expect(out).toHaveLength(2);
  });

  it('validateReportFilter rejects bad ops', () => {
    expect(validateReportFilter({ id: 'f', field: 'Sales', op: '≈', value: 1 })).toHaveLength(1);
    expect(validateReportFilter({ id: 'f', field: 'Sales', op: '=', value: 1 })).toEqual([]);
  });
});
