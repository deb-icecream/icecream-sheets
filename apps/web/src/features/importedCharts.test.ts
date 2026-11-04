import { describe, expect, it } from 'vitest';
import type { ImportedChart } from '@icecream-sheets/xlsx-adapter';
import { makeChartSpec } from '@icecream-sheets/service';
import {
  CHART_SPECS_METADATA_KEY,
  type ChartNameResolutionContext,
  importedChartsFromMetadata,
  importedChartToSpec,
  importedPivotChartToSpec,
  importedTrendlineToSpec,
  ooxmlKindToChartKind,
  parseRangeFormula,
  pivotChartSpecsFromMetadata,
  pivotChartSpecsToMetadata,
  resolveSeriesFormula,
} from './importedCharts';

describe('ooxmlKindToChartKind', () => {
  it('maps real combo charts (bar + line) to the combo kinds', () => {
    expect(ooxmlKindToChartKind('barChart', 'col', undefined, ['barChart', 'lineChart'], true)).toBe(
      'combo-column-line-2axis',
    );
    expect(ooxmlKindToChartKind('barChart', 'col', undefined, ['barChart', 'lineChart'], false)).toBe(
      'combo-column-line',
    );
    // No combo info: the old single-kind contract holds.
    expect(ooxmlKindToChartKind('barChart', 'col', undefined, ['barChart'], false)).toBe(
      'column-clustered',
    );
    expect(ooxmlKindToChartKind('barChart', 'col')).toBe('column-clustered');
  });

  it('maps an imported combo chart to combo-column-line-2axis', () => {
    const chart = importedChart({
      kind: 'barChart',
      barDir: 'col',
      plotTypes: ['barChart', 'lineChart'],
      secondaryAxis: true,
    });
    const spec = importedChartToSpec(chart, 9)!;
    expect(spec.kind).toBe('combo-column-line-2axis');
  });

  it('falls back to the single-kind contract without combo info', () => {
    const chart = importedChart({ kind: 'barChart', barDir: 'col' });
    // plotTypes/secondaryAxis absent (metadata written before they existed).
    delete (chart as Partial<ImportedChart>).plotTypes;
    delete (chart as Partial<ImportedChart>).secondaryAxis;
    expect(importedChartToSpec(chart, 9)!.kind).toBe('column-clustered');
  });

  const cases: Array<[string, string | undefined, string | undefined, string]> = [
    ['barChart', 'col', undefined, 'column-clustered'],
    ['barChart', 'bar', undefined, 'bar-clustered'],
    ['barChart', undefined, undefined, 'column-clustered'],
    ['bar3DChart', 'col', undefined, 'column-3d-clustered'],
    ['bar3DChart', 'bar', undefined, 'bar-3d-clustered'],
    ['lineChart', undefined, undefined, 'line'],
    ['line3DChart', undefined, undefined, 'line-3d'],
    ['pieChart', undefined, undefined, 'pie'],
    ['pie3DChart', undefined, undefined, 'pie-3d'],
    ['areaChart', undefined, undefined, 'area'],
    ['area3DChart', undefined, undefined, 'area-3d'],
    ['scatterChart', undefined, undefined, 'scatter'],
    ['doughnutChart', undefined, undefined, 'doughnut'],
    ['radarChart', undefined, undefined, 'radar'],
    ['bubbleChart', undefined, undefined, 'bubble'],
    ['stockChart', undefined, undefined, 'stock-ohlc'],
    ['surfaceChart', undefined, undefined, 'surface-3d'],
    ['surface3DChart', undefined, undefined, 'surface-3d'],
    ['ofPieChart', undefined, 'bar', 'bar-of-pie'],
    ['ofPieChart', undefined, 'pie', 'pie-of-pie'],
    ['ofPieChart', undefined, undefined, 'pie'],
    // Unknown future kinds: closest fallback, never a skip.
    ['funnelChart', undefined, undefined, 'column-clustered'],
    ['somethingElseChart', undefined, undefined, 'column-clustered'],
  ];
  for (const [kind, barDir, ofPieType, want] of cases) {
    it(`maps ${kind} (barDir=${barDir ?? '-'}, ofPieType=${ofPieType ?? '-'}) → ${want}`, () => {
      expect(ooxmlKindToChartKind(kind, barDir, ofPieType)).toBe(want);
    });
  }
});

describe('parseRangeFormula', () => {
  it('parses plain and quoted sheet formulas', () => {
    expect(parseRangeFormula('Data!$B$2:$B$13')).toEqual({
      sheet: 'Data',
      startRow: 1,
      startCol: 1,
      endRow: 12,
      endCol: 1,
    });
    expect(parseRangeFormula(`'INCOME STATEMENT'!$C$6:$I$6`)).toEqual({
      sheet: 'INCOME STATEMENT',
      startRow: 5,
      startCol: 2,
      endRow: 5,
      endCol: 8,
    });
    expect(parseRangeFormula(`'Bob''s Sheet'!$A$1:$C$3`)).toEqual({
      sheet: `Bob's Sheet`,
      startRow: 0,
      startCol: 0,
      endRow: 2,
      endCol: 2,
    });
    // Without $ anchors.
    expect(parseRangeFormula('Sheet1!A1:B2')).toEqual({
      sheet: 'Sheet1',
      startRow: 0,
      startCol: 0,
      endRow: 1,
      endCol: 1,
    });
  });

  it('rejects non-range formulas', () => {
    expect(parseRangeFormula('')).toBeNull();
    expect(parseRangeFormula('Data!$B$2')).toBeNull();
    expect(parseRangeFormula('SUM(A1:A2)')).toBeNull();
    expect(parseRangeFormula('Data!$B$5:$B$2')).toBeNull();
  });
});

function importedChart(overrides: Partial<ImportedChart> = {}): ImportedChart {
  const kind = overrides.kind ?? 'barChart';
  return {
    sheetIndex: 0,
    sheetName: 'Data',
    kind,
    barDir: 'col',
    title: 'Revenue',
    plotTypes: [kind],
    secondaryAxis: false,
    series: [
      { name: 'Q1', catFormula: 'Data!$A$2:$A$5', valFormula: 'Data!$B$2:$B$5', trendlines: [] },
      { name: 'Q2', catFormula: '', valFormula: 'Data!$C$2:$C$5', trendlines: [] },
    ],
    anchor: { fromCol: 1, fromRow: 2, toCol: 5, toRow: 10 },
    ...overrides,
  };
}

describe('importedChartToSpec', () => {
  it('builds a full spec from an imported chart', () => {
    const spec = importedChartToSpec(importedChart(), 42)!;
    expect(spec).not.toBeNull();
    expect(spec.id).toBe(42);
    expect(spec.kind).toBe('column-clustered');
    expect(spec.title).toBe('Revenue');
    // Compat union covers the value ranges only (no cat folding).
    expect(spec.range).toEqual({
      sheet: 'Data',
      startRow: 1,
      startCol: 1,
      endRow: 4,
      endCol: 2,
    });
    // Per-series ranges are kept verbatim — no unioning.
    expect(spec.seriesRanges).toHaveLength(2);
    expect(spec.seriesRanges![0]).toEqual({
      name: 'Q1',
      cat: { sheet: 'Data', startRow: 1, startCol: 0, endRow: 4, endCol: 0 },
      val: { sheet: 'Data', startRow: 1, startCol: 1, endRow: 4, endCol: 1 },
    });
    expect(spec.seriesRanges![1].val).toEqual({
      sheet: 'Data',
      startRow: 1,
      startCol: 2,
      endRow: 4,
      endCol: 2,
    });
    expect(spec.seriesRanges![1].cat).toBeNull();
    expect(spec.x).toBe(64);
    expect(spec.y).toBe(40);
    expect(spec.w).toBe(256);
    expect(spec.h).toBe(180); // max(180, 8*20=160)
    expect(spec.version).toBe(2);
  });

  it('returns null only when no series has any parseable range', () => {
    expect(
      importedChartToSpec(
        importedChart({ series: [{ name: 'x', catFormula: '', valFormula: 'bogus', trendlines: [] }] }),
        1,
      ),
    ).toBeNull();
  });

  it('uses the anchor sheet for placement (dashboards bind to other sheets)', () => {
    const spec = importedChartToSpec(
      importedChart({ series: [{ name: 'x', catFormula: '', valFormula: 'Other!$A$1:$A$5', trendlines: [] }] }),
      7,
      ['Data', 'Other'],
    )!;
    expect(spec).not.toBeNull();
    // The overlay renders on the chart's anchor sheet; the per-series data
    // sheet is kept verbatim in seriesRanges.
    expect(spec.range.sheet).toBe('Data');
    expect(spec.seriesRanges![0].val.sheet).toBe('Other');
    expect(spec.range).toMatchObject({ startRow: 0, startCol: 0, endRow: 4, endCol: 0 });
  });

  it('carries the drawingML anchor cells on the spec', () => {
    const spec = importedChartToSpec(importedChart(), 42)!;
    expect(spec.anchorCells).toEqual({ fromCol: 1, fromRow: 2, toCol: 5, toRow: 10 });
  });

  it('maps 3D and ofPie kinds through', () => {
    expect(importedChartToSpec(importedChart({ kind: 'line3DChart' }), 1)!.kind).toBe('line-3d');
    expect(
      importedChartToSpec(importedChart({ kind: 'ofPieChart', ofPieType: 'bar' }), 1)!.kind,
    ).toBe('bar-of-pie');
  });
});

describe('importedChartsFromMetadata', () => {
  it('parses and validates the metadata JSON', () => {
    const charts = [importedChart()];
    expect(importedChartsFromMetadata(JSON.stringify(charts))).toHaveLength(1);
    expect(importedChartsFromMetadata(undefined)).toEqual([]);
    expect(importedChartsFromMetadata('')).toEqual([]);
    expect(importedChartsFromMetadata('not json')).toEqual([]);
    expect(importedChartsFromMetadata(JSON.stringify({ a: 1 }))).toEqual([]);
    expect(importedChartsFromMetadata(JSON.stringify([{ kind: 42 }]))).toEqual([]);
  });
});

describe('importedPivotChartToSpec', () => {
  const pivot = {
    id: 77,
    title: 'pvtEarnings',
    sourceSheet: 'Summaries',
    sourceRange: { sheet: 'Summaries', startRow: 0, startCol: 0, endRow: 10, endCol: 5 },
  };
  const pivotChart = (overrides: Partial<ImportedChart> = {}): ImportedChart =>
    importedChart({ kind: 'barChart', barDir: 'col', title: 'Earnings', pivotSource: 'pvtEarnings', series: [], ...overrides });

  it('binds the chart to the pivot id instead of baking in series', () => {
    const spec = importedPivotChartToSpec(pivotChart(), pivot, 101);
    expect(spec.pivot).toEqual({ pivotId: 77, valueIndex: 0 });
    expect(spec.seriesRanges).toBeUndefined();
    expect(spec.kind).toBe('column-clustered');
    expect(spec.title).toBe('Earnings');
    expect(spec.anchorCells).toEqual({ fromCol: 1, fromRow: 2, toCol: 5, toRow: 10 });
  });

  it('maps the OOXML kind and falls back the title to the pivot name', () => {
    const spec = importedPivotChartToSpec(
      pivotChart({ kind: 'pieChart', barDir: undefined, title: '' }),
      pivot,
      102,
    );
    expect(spec.kind).toBe('pie');
    expect(spec.title).toBe('PivotChart of pvtEarnings');
  });

  it('places the compat range on the chart anchor sheet, not the pivot sheet', () => {
    const spec = importedPivotChartToSpec(pivotChart(), pivot, 103);
    // The drawing lives on the chart's sheet (often a Dashboard); the
    // overlay layer filters charts by range.sheet, so this must be the
    // anchor sheet for the chart to appear on the right tab.
    expect(spec.range.sheet).toBe('Data');
  });

  it('bakes the chart series formulas as a fallback for pivots without data', () => {
    const chart = pivotChart({
      series: [
        { name: 'S1', catFormula: 'Summaries!$A$7:$A$16', valFormula: 'Summaries!$B$7:$B$16', trendlines: [] },
      ],
    });
    const spec = importedPivotChartToSpec(chart, pivot, 104, ['Data', 'Summaries']);
    // Live pivot binding is kept (wins when the pivot has data)...
    expect(spec.pivot).toEqual({ pivotId: 77, valueIndex: 0 });
    // ...but the cached series formulas are baked so the chart still
    // renders when the pivot cache was saved without records.
    expect(spec.seriesRanges).toHaveLength(1);
    expect(spec.seriesRanges![0].val).toMatchObject({
      sheet: 'Summaries',
      startRow: 6,
      startCol: 1,
      endRow: 15,
      endCol: 1,
    });
    expect(spec.seriesRanges![0].cat).toMatchObject({
      sheet: 'Summaries',
      startRow: 6,
      startCol: 0,
      endRow: 15,
      endCol: 0,
    });
  });
});

describe('pivot chart save round-trip (icecream.chartspecs)', () => {
  const charts = [
    makeChartSpec({
      id: 1,
      kind: 'column-clustered',
      range: { sheet: 'S', startRow: 0, startCol: 0, endRow: 5, endCol: 3 },
      title: 'PivotChart of Sum of Sales',
      pivot: { pivotId: 7, valueIndex: 0 },
    }),
    makeChartSpec({
      id: 2,
      kind: 'line',
      range: { sheet: 'S', startRow: 0, startCol: 0, endRow: 5, endCol: 3 },
      title: 'Plain chart',
    }),
  ];
  const nameOf = (id: number): string | undefined => (id === 7 ? 'PivotTable1' : undefined);
  const idOf = (name: string): number | undefined => (name === 'PivotTable1' ? 42 : undefined);

  it('stores the pivot binding by name and restores it to the new session id', () => {
    const json = pivotChartSpecsToMetadata(charts, nameOf);
    // The raw JSON must carry the NAME, never the session-local id.
    expect(json).toContain('PivotTable1');
    expect(json).not.toContain('"pivotId":7');
    const restored = pivotChartSpecsFromMetadata(json, idOf);
    expect(restored).toHaveLength(2);
    expect(restored[0].pivot).toEqual({ pivotId: 42, valueIndex: 0 });
    expect(restored[0].title).toBe('PivotChart of Sum of Sales');
    expect(restored[1].pivot).toBeUndefined();
  });

  it('keeps the chart (binding dropped) when the pivot is gone on open', () => {
    const json = pivotChartSpecsToMetadata(charts, nameOf);
    const restored = pivotChartSpecsFromMetadata(json, () => undefined);
    expect(restored).toHaveLength(2);
    expect(restored[0].pivot).toBeUndefined();
    expect(restored[0].title).toBe('PivotChart of Sum of Sales');
  });

  it('returns [] for missing/corrupt metadata', () => {
    expect(pivotChartSpecsFromMetadata(undefined, idOf)).toEqual([]);
    expect(pivotChartSpecsFromMetadata('', idOf)).toEqual([]);
    expect(pivotChartSpecsFromMetadata('nope', idOf)).toEqual([]);
    expect(pivotChartSpecsFromMetadata(JSON.stringify({}), idOf)).toEqual([]);
    expect(pivotChartSpecsFromMetadata(JSON.stringify([{ nope: 1 }]), idOf)).toEqual([]);
  });

  it('uses the icecream.* app-meta key so the adapter persists it', () => {
    expect(CHART_SPECS_METADATA_KEY.startsWith('icecream.')).toBe(true);
  });

  it('nativePart specs are excluded from the metadata channel (FIX-G)', () => {
    const native = makeChartSpec({
      id: 3,
      kind: 'column-clustered',
      range: { sheet: 'S', startRow: 0, startCol: 0, endRow: 5, endCol: 3 },
      title: 'Native Chart',
      nativePart: true,
    });
    expect(native.nativePart).toBe(true);
    const json = pivotChartSpecsToMetadata([...charts, native], nameOf);
    expect(json).not.toContain('Native Chart');
    const restored = pivotChartSpecsFromMetadata(json, idOf);
    expect(restored.map((c) => c.id)).toEqual([1, 2]);
    // Imported specs carry the flag from conversion.
    expect(importedChartToSpec(importedChart(), 42)!.nativePart).toBe(true);
  });
});

describe('importedTrendlineToSpec', () => {
  it('maps an imported trendline onto the right dataset', () => {
    const chart = importedChart({
      series: [
        { name: 'Q1', catFormula: 'Data!$A$2:$A$5', valFormula: 'Data!$B$2:$B$5', trendlines: [] },
        {
          name: 'Q2',
          catFormula: '',
          valFormula: 'Data!$C$2:$C$5',
          trendlines: [
            {
              name: 'CTR Trend',
              type: 'polynomial',
              order: 2,
              forward: 2,
              displayEquation: true,
              displayRSquared: true,
            },
          ],
        },
      ],
    });
    const spec = importedChartToSpec(chart, 7)!;
    expect(spec.trendlines).toHaveLength(1);
    expect(spec.trendlines![0]).toEqual({
      type: 'polynomial',
      seriesIndex: 1,
      label: 'CTR Trend',
      order: 2,
      forward: 2,
      displayEquation: true,
      displayRSquared: true,
    });
  });

  it('leaves trendlines undefined when the file has none', () => {
    const spec = importedChartToSpec(importedChart(), 7)!;
    expect(spec.trendlines).toBeUndefined();
  });

  it('importedTrendlineToSpec rejects unknown types', () => {
    expect(
      importedTrendlineToSpec({ name: '', type: 'bogus' as never }, 0),
    ).toBeNull();
    expect(
      importedTrendlineToSpec({ name: 'MA', type: 'movingAverage', period: 3 }, 2),
    ).toEqual({ type: 'movingAverage', seriesIndex: 2, label: 'MA', period: 3 });
  });
});

describe('resolveSeriesFormula (defined-name series refs)', () => {
  // Mirrors the real trendline.xlsx fixture: dynamic OFFSET/COUNTA names.
  const fixtureCtx: ChartNameResolutionContext = {
    definedNames: [
      {
        name: 'ALL_IMP',
        ref: 'OFFSET(ClickThroughRateSheet!$C$3,0,0,COUNTA(ClickThroughRateSheet!$C:$C)-1)',
        sheet: 0,
      },
      {
        name: 'All_CTR',
        ref: 'OFFSET(ClickThroughRateSheet!$D$3,0,0,COUNTA(ClickThroughRateSheet!$D:$D)-1)',
        sheet: 0,
      },
    ],
    sheetNames: ['ClickThroughRateSheet', 'Sheet2'],
    // Header + 12 data rows, like the fixture.
    countNonEmpty: (_sheet, _col) => 13,
  };

  it('resolves plain A1 formulas without a context', () => {
    expect(resolveSeriesFormula('Data!$B$2:$B$5')).toEqual({
      sheet: 'Data',
      startRow: 1,
      startCol: 1,
      endRow: 4,
      endCol: 1,
    });
  });

  it('resolves an OFFSET/COUNTA dynamic name (fixture shape)', () => {
    expect(resolveSeriesFormula('ClickThroughRateSheet!All_CTR', fixtureCtx)).toEqual({
      sheet: 'ClickThroughRateSheet',
      startRow: 2,
      startCol: 3,
      endRow: 13,
      endCol: 3,
    });
    expect(resolveSeriesFormula('ClickThroughRateSheet!ALL_IMP', fixtureCtx)).toEqual({
      sheet: 'ClickThroughRateSheet',
      startRow: 2,
      startCol: 2,
      endRow: 13,
      endCol: 2,
    });
  });

  it('matches names case-insensitively', () => {
    expect(resolveSeriesFormula('ClickThroughRateSheet!all_ctr', fixtureCtx)).toEqual({
      sheet: 'ClickThroughRateSheet',
      startRow: 2,
      startCol: 3,
      endRow: 13,
      endCol: 3,
    });
  });

  it('resolves a plain A1 defined name', () => {
    const ctx: ChartNameResolutionContext = {
      definedNames: [{ name: 'Sales', ref: 'Data!$B$2:$B$5' }],
      sheetNames: ['Data'],
      countNonEmpty: () => 0,
    };
    expect(resolveSeriesFormula('Data!Sales', ctx)).toEqual({
      sheet: 'Data',
      startRow: 1,
      startCol: 1,
      endRow: 4,
      endCol: 1,
    });
  });

  it('prefers a sheet-scoped name over a workbook-scoped one', () => {
    const ctx: ChartNameResolutionContext = {
      definedNames: [
        { name: 'Vals', ref: 'Data!$B$1:$B$3' },
        { name: 'Vals', ref: 'Other!$C$1:$C$9', sheet: 1 },
      ],
      sheetNames: ['Data', 'Other'],
      countNonEmpty: () => 0,
    };
    expect(resolveSeriesFormula('Other!Vals', ctx)).toEqual({
      sheet: 'Other',
      startRow: 0,
      startCol: 2,
      endRow: 8,
      endCol: 2,
    });
    expect(resolveSeriesFormula('Data!Vals', ctx)).toEqual({
      sheet: 'Data',
      startRow: 0,
      startCol: 1,
      endRow: 2,
      endCol: 1,
    });
  });

  it('returns null for unknown names and unresolvable formulas', () => {
    expect(resolveSeriesFormula('Data!Nope', fixtureCtx)).toBeNull();
    expect(resolveSeriesFormula('Data!All_CTR', fixtureCtx)).toBeNull(); // wrong sheet
    expect(resolveSeriesFormula('SUM(A1:A2)', fixtureCtx)).toBeNull();
    expect(resolveSeriesFormula('bogus', fixtureCtx)).toBeNull();
    // Without a context, name refs cannot resolve.
    expect(resolveSeriesFormula('Data!Sales')).toBeNull();
  });

  it('importedChartToSpec keeps charts whose series use defined names', () => {
    const chart = importedChart({
      sheetName: 'ClickThroughRateSheet',
      title: 'Sample Click Performance',
      series: [
        {
          name: 'Impressions',
          catFormula: '',
          valFormula: 'ClickThroughRateSheet!ALL_IMP',
          trendlines: [],
        },
        {
          name: 'CTR',
          catFormula: '',
          valFormula: 'ClickThroughRateSheet!All_CTR',
          trendlines: [{ name: 'CTR Trend', type: 'polynomial', order: 2 }],
        },
      ],
    });
    // Without name resolution the chart is dropped (the old behavior).
    expect(importedChartToSpec(chart, 1, ['ClickThroughRateSheet'])).toBeNull();
    const spec = importedChartToSpec(chart, 1, ['ClickThroughRateSheet'], fixtureCtx)!;
    expect(spec).not.toBeNull();
    expect(spec.title).toBe('Sample Click Performance');
    expect(spec.seriesRanges).toHaveLength(2);
    expect(spec.seriesRanges![0].val).toEqual({
      sheet: 'ClickThroughRateSheet',
      startRow: 2,
      startCol: 2,
      endRow: 13,
      endCol: 2,
    });
    expect(spec.seriesRanges![1].val).toEqual({
      sheet: 'ClickThroughRateSheet',
      startRow: 2,
      startCol: 3,
      endRow: 13,
      endCol: 3,
    });
    // The trendline survives onto the resolved dataset.
    expect(spec.trendlines).toHaveLength(1);
    expect(spec.trendlines![0]).toEqual({
      type: 'polynomial',
      seriesIndex: 1,
      label: 'CTR Trend',
      order: 2,
    });
  });
});
