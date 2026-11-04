/**
 * Tests for the chart component core (chartModel) and the service metadata
 * store (chartStore). Pure logic — no DOM, no engine.
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_KINDS,
  CHART_GROUPS,
  CHART_SPEC_VERSION,
  a1RangeString,
  boxPlotStats,
  buildChartConfig,
  colIndexToLetters,
  colLettersToIndex,
  extractSeries,
  extractSeriesFromRanges,
  groupLabelForKind,
  histogramBins,
  isSvgKind,
  kindLabel,
  makeChartSpec,
  numericValues,
  paretoTransform,
  parseA1Range,
  sturgesBinCount,
  toPercentStacked,
  waterfallSegments,
  deserializeCharts,
  migrateChart,
  serializeCharts,
  type CellReader,
  type ChartRange,
  type ChartSeriesRange,
  type SheetCellReader,
} from '../src/index.js';


/** Build a CellReader from a 2D string grid. */
function readerFrom(grid: string[][]): CellReader {
  return (r, c) => {
    const text = grid[r]?.[c] ?? '';
    const t = text.trim();
    const num = t !== '' && !Number.isNaN(Number(t)) ? Number(t) : null;
    return { text, num };
  };
}

const range: ChartRange = { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 3, endCol: 2 };

describe('extractSeries', () => {
  it('detects header row + label column (Excel layout)', () => {
    const read = readerFrom([
      ['', 'Q1', 'Q2'],
      ['Apples', '10', '20'],
      ['Oranges', '30', '40'],
    ]);
    const s = extractSeries(read, { ...range, endRow: 2 });
    expect(s.labels).toEqual(['Apples', 'Oranges']);
    expect(s.datasets.map((d) => d.label)).toEqual(['Q1', 'Q2']);
    expect(s.datasets[0].data).toEqual([10, 30]);
    expect(s.datasets[1].data).toEqual([20, 40]);
  });

  it('falls back to Series N / Category N without headers', () => {
    const read = readerFrom([
      ['10', '20'],
      ['30', '40'],
    ]);
    const s = extractSeries(read, { ...range, endRow: 1, endCol: 1 });
    expect(s.datasets[0].label).toBe('Series 1');
    expect(s.labels).toEqual(['Category 1', 'Category 2']);
  });

  it('skips entirely-empty columns', () => {
    const read = readerFrom([
      ['', 'Q1', ''],
      ['A', '10', ''],
      ['B', '20', ''],
    ]);
    const s = extractSeries(read, { ...range, endRow: 2 });
    expect(s.datasets).toHaveLength(1);
  });

  it('keeps null gaps for non-numeric body cells', () => {
    const read = readerFrom([
      ['', 'Q1'],
      ['A', '10'],
      ['B', 'n/a'],
    ]);
    const s = extractSeries(read, { ...range, endRow: 2, endCol: 1 });
    expect(s.datasets[0].data).toEqual([10, null]);
  });

  it('returns empty for an empty range', () => {
    const s = extractSeries(readerFrom([]), range);
    expect(s.datasets).toEqual([]);
  });
});

describe('extractSeriesFromRanges', () => {
  /** Sheet-aware reader over a map of sheet -> grid. */
  function sheetsReader(sheets: Record<string, string[][]>): SheetCellReader {
    return (sheet, r, c) => {
      const text = sheets[sheet]?.[r]?.[c] ?? '';
      const t = text.trim();
      const num = t !== '' && !Number.isNaN(Number(t)) ? Number(t) : null;
      return { text, num };
    };
  }
  const R = (sheet: string, sr: number, sc: number, er: number, ec: number): ChartRange => ({
    sheet,
    startRow: sr,
    startCol: sc,
    endRow: er,
    endCol: ec,
  });

  it('builds row-oriented series with category labels from a single-row cat range', () => {
    const read = sheetsReader({
      'INCOME STATEMENT': [
        ['FY', '', 'FY2024A', 'FY2025E', 'FY2026E'], // row 0
        ['', 'Revenue', '76695', '144047', '120597'], // row 1
      ],
    });
    const ranges: ChartSeriesRange[] = [
      {
        name: '',
        cat: R('INCOME STATEMENT', 0, 2, 0, 4),
        val: R('INCOME STATEMENT', 1, 2, 1, 4),
      },
    ];
    const s = extractSeriesFromRanges(read, ranges);
    expect(s.labels).toEqual(['FY2024A', 'FY2025E', 'FY2026E']);
    // Empty series name falls back to the header cell left of the val range (B9).
    expect(s.datasets[0].label).toBe('Revenue');
    expect(s.datasets[0].data).toEqual([76695, 144047, 120597]);
  });

  it('builds column-oriented series with labels from a single-column cat range', () => {
    const read = sheetsReader({
      Data: [
        ['', 'Q1', 'Q2'],
        ['Apples', '10', '20'],
        ['Oranges', '30', '40'],
      ],
    });
    const ranges: ChartSeriesRange[] = [
      { name: 'Q1', cat: R('Data', 1, 0, 2, 0), val: R('Data', 1, 1, 2, 1) },
      { name: 'Q2', cat: R('Data', 1, 0, 2, 0), val: R('Data', 1, 2, 2, 2) },
    ];
    const s = extractSeriesFromRanges(read, ranges);
    expect(s.labels).toEqual(['Apples', 'Oranges']);
    expect(s.datasets.map((d) => d.label)).toEqual(['Q1', 'Q2']);
    expect(s.datasets[0].data).toEqual([10, 30]);
    expect(s.datasets[1].data).toEqual([20, 40]);
  });

  it('keeps every series on its own sheet (no unioning)', () => {
    const read = sheetsReader({
      A: [['x', '1'], ['y', '2']],
      B: [['z', '3'], ['w', '4']],
    });
    const ranges: ChartSeriesRange[] = [
      { name: 'a', cat: null, val: R('A', 0, 1, 1, 1) },
      { name: 'b', cat: null, val: R('B', 0, 1, 1, 1) },
    ];
    const s = extractSeriesFromRanges(read, ranges);
    expect(s.datasets[0].data).toEqual([1, 2]);
    expect(s.datasets[1].data).toEqual([3, 4]);
    expect(s.labels).toEqual(['Category 1', 'Category 2']);
  });

  it('uses null gaps for non-numeric values and Series N fallback labels', () => {
    const read = sheetsReader({ S: [['10'], ['n/a']] });
    const ranges: ChartSeriesRange[] = [{ name: '', cat: null, val: R('S', 0, 0, 1, 0) }];
    const s = extractSeriesFromRanges(read, ranges);
    expect(s.datasets[0].label).toBe('Series 1');
    expect(s.datasets[0].data).toEqual([10, null]);
  });

  it('falls back to the cell above a single-column val range for the label', () => {
    const read = sheetsReader({ S: [['Units'], ['10'], ['20']] });
    const ranges: ChartSeriesRange[] = [{ name: '', cat: null, val: R('S', 1, 0, 2, 0) }];
    const s = extractSeriesFromRanges(read, ranges);
    expect(s.datasets[0].label).toBe('Units');
    expect(s.datasets[0].data).toEqual([10, 20]);
  });
});

describe('numericValues', () => {
  it('flattens numeric body values, skipping the header row', () => {
    const read = readerFrom([
      ['', 'Q1'],
      ['A', '10'],
      ['B', '20'],
    ]);
    expect(numericValues(read, { ...range, endRow: 2, endCol: 1 })).toEqual([10, 20]);
  });
});

describe('histogramBins', () => {
  it('bins values into equal-width bins', () => {
    const h = histogramBins([1, 2, 3, 4, 5, 6, 7, 8], 4);
    expect(h.counts).toEqual([2, 2, 2, 2]);
    expect(h.labels).toHaveLength(4);
  });

  it('handles a single repeated value', () => {
    const h = histogramBins([5, 5, 5]);
    expect(h.counts).toEqual([3]);
  });

  it('returns empty for no values', () => {
    expect(histogramBins([])).toEqual({ labels: [], counts: [] });
  });

  it('sturges rule grows slowly', () => {
    expect(sturgesBinCount(8)).toBe(4);
    expect(sturgesBinCount(1000)).toBeLessThanOrEqual(11);
    expect(sturgesBinCount(0)).toBe(1);
  });
});

describe('paretoTransform', () => {
  it('sorts descending with cumulative %', () => {
    const p = paretoTransform(['a', 'b', 'c'], [10, 30, 60]);
    expect(p.labels).toEqual(['c', 'b', 'a']);
    expect(p.values).toEqual([60, 30, 10]);
    expect(p.cumulativePct).toEqual([60, 90, 100]);
  });
});

describe('waterfallSegments', () => {
  it('floats each bar from the running total and appends Total', () => {
    const w = waterfallSegments(['a', 'b'], [10, -4]);
    expect(w.floats).toEqual([
      [0, 10],
      [6, 10],
      [0, 6],
    ]);
    expect(w.kinds).toEqual(['up', 'down', 'total']);
    expect(w.labels).toEqual(['a', 'b', 'Total']);
  });
});

describe('boxPlotStats', () => {
  it('computes the five-number summary', () => {
    const s = boxPlotStats([1, 2, 3, 4, 5]);
    expect(s).toMatchObject({ min: 1, median: 3, max: 5 });
    expect(s!.q1).toBeCloseTo(2);
    expect(s!.q3).toBeCloseTo(4);
  });

  it('returns null for no data', () => {
    expect(boxPlotStats([])).toBeNull();
  });
});

describe('toPercentStacked', () => {
  it('normalizes each category to 100', () => {
    const out = toPercentStacked([
      { label: 'a', data: [1, 3] },
      { label: 'b', data: [3, 1] },
    ]);
    expect(out[0].data).toEqual([25, 75]);
    expect(out[1].data).toEqual([75, 25]);
  });
});

describe('A1 range helpers', () => {
  it('parses A1:D10', () => {
    expect(parseA1Range('A1:D10', 'S')).toEqual({
      sheet: 'S',
      startRow: 0,
      startCol: 0,
      endRow: 9,
      endCol: 3,
    });
  });

  it('parses a single cell', () => {
    expect(parseA1Range('B2', 'S')?.startRow).toBe(1);
  });

  it('rejects garbage', () => {
    expect(parseA1Range('hello', 'S')).toBeNull();
    expect(parseA1Range('', 'S')).toBeNull();
  });

  it('round-trips through a1RangeString', () => {
    const r = parseA1Range('C3:F9', 'S')!;
    expect(a1RangeString(r)).toBe('C3:F9');
  });

  it('converts column letters both ways', () => {
    expect(colLettersToIndex('A')).toBe(0);
    expect(colLettersToIndex('Z')).toBe(25);
    expect(colLettersToIndex('AA')).toBe(26);
    expect(colIndexToLetters(27)).toBe('AB');
  });
});

describe('chart kinds', () => {
  it('covers all 61 Excel kinds with labels and groups', () => {
    expect(ALL_KINDS.length).toBe(61);
    for (const k of ALL_KINDS) {
      expect(kindLabel(k)).not.toBe(k);
      expect(groupLabelForKind(k)).not.toBe('');
    }
  });

  it('flags treemap/sunburst as SVG kinds', () => {
    expect(isSvgKind('treemap')).toBe(true);
    expect(isSvgKind('sunburst')).toBe(true);
    expect(isSvgKind('pie')).toBe(false);
    expect(isSvgKind('column-clustered')).toBe(false);
  });

  it('has 12 Excel galleries', () => {
    expect(CHART_GROUPS).toHaveLength(12);
    expect(CHART_GROUPS.map((g) => g.label)).toContain('Statistical');
    expect(CHART_GROUPS.map((g) => g.label)).toContain('Stock');
    expect(CHART_GROUPS.map((g) => g.label)).toContain('Surface');
    expect(CHART_GROUPS.map((g) => g.label)).toContain('Map');
  });
});

describe('makeChartSpec', () => {
  it('fills defaults and stamps the version', () => {
    const spec = makeChartSpec({ kind: 'pie', range });
    expect(spec.version).toBe(CHART_SPEC_VERSION);
    expect(spec.title).toBe('Pie');
    expect(spec.legend).toBe('bottom');
    expect(spec.w).toBe(480);
  });
});

describe('buildChartConfig', () => {
  const series = {
    labels: ['A', 'B'],
    datasets: [
      { label: 'S1', data: [10, 20] },
      { label: 'S2', data: [30, 40] },
    ],
  };
  const base = makeChartSpec({ kind: 'column-clustered', range, title: 'T' });

  it('builds a clustered column config', () => {
    const { config, svg } = buildChartConfig(base, series);
    expect(svg).toBeNull();
    expect(config.type).toBe('bar');
    expect(config.data?.labels).toEqual(['A', 'B']);
    expect(config.data?.datasets).toHaveLength(2);
  });

  it('stacks bars for stacked kinds', () => {
    const { config } = buildChartConfig({ ...base, kind: 'column-stacked' }, series);
    const scales = (config.options as { scales: { x: { stacked: boolean } } }).scales;
    expect(scales.x.stacked).toBe(true);
  });

  it('normalizes to 100% for stacked100', () => {
    const { config } = buildChartConfig({ ...base, kind: 'column-stacked100' }, series);
    const data = (config.data?.datasets?.[0]?.data ?? []) as number[];
    expect(data).toEqual([25, 33.33]);
  });

  it('uses a horizontal index axis for bar kinds', () => {
    const { config } = buildChartConfig({ ...base, kind: 'bar-clustered' }, series);
    expect((config.options as { indexAxis: string }).indexAxis).toBe('y');
  });

  it('builds pie from the first dataset', () => {
    const { config } = buildChartConfig({ ...base, kind: 'pie' }, series);
    expect(config.type).toBe('pie');
    expect(config.data?.datasets?.[0]?.data).toEqual([10, 20]);
  });

  it('builds scatter points from x/y columns', () => {
    const { config } = buildChartConfig({ ...base, kind: 'scatter' }, series);
    expect(config.type).toBe('scatter');
    const pts = (config.data?.datasets?.[0]?.data ?? []) as { x: number; y: number }[];
    expect(pts[0]).toEqual({ x: 10, y: 30 });
  });

  it('builds a pareto with a secondary % axis', () => {
    const { config } = buildChartConfig({ ...base, kind: 'pareto' }, series);
    const scales = (config.options as { scales: Record<string, unknown> }).scales;
    expect(scales['y1']).toBeDefined();
    expect(config.data?.datasets).toHaveLength(2);
  });

  it('builds waterfall floating bars', () => {
    const { config } = buildChartConfig({ ...base, kind: 'waterfall' }, series);
    const data = (config.data?.datasets?.[0]?.data ?? []) as [number, number][];
    expect(data[data.length - 1]).toEqual([0, 30]);
  });

  it('builds boxplot floating boxes with the whisker plugin', () => {
    const { config, svg } = buildChartConfig({ ...base, kind: 'boxplot' }, series);
    expect(svg).toBeNull();
    expect(config.plugins).toContainEqual(expect.objectContaining({ id: 'icecream-box-whisker' }));
  });

  it('routes treemap/sunburst to SVG', () => {
    expect(buildChartConfig({ ...base, kind: 'treemap' }, series).svg).toBe('treemap');
    expect(buildChartConfig({ ...base, kind: 'sunburst' }, series).svg).toBe('sunburst');
  });

  it('builds combo with a line dataset', () => {
    const { config } = buildChartConfig({ ...base, kind: 'combo-column-line-2axis' }, series);
    const sets = config.data?.datasets as { type: string; yAxisID?: string }[];
    expect(sets[1].type).toBe('line');
    expect(sets[1].yAxisID).toBe('y1');
  });

  it('adds the data-labels plugin when enabled', () => {
    const { config } = buildChartConfig({ ...base, dataLabels: true }, series);
    expect(config.plugins).toContainEqual(expect.objectContaining({ id: 'icecream-data-labels' }));
  });

  it('hides the legend when set to none', () => {
    const { config } = buildChartConfig({ ...base, legend: 'none' }, series);
    const legend = (config.options as { plugins: { legend: { display: boolean } } }).plugins.legend;
    expect(legend.display).toBe(false);
  });
});

describe('chartStore', () => {
  it('round-trips specs through serialize/deserialize', () => {
    const specs = [makeChartSpec({ kind: 'line-markers', range, id: 7, title: 'Hi' })];
    const back = deserializeCharts(serializeCharts(specs));
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ id: 7, kind: 'line-markers', title: 'Hi' });
  });

  it('returns [] for corrupt payloads', () => {
    expect(deserializeCharts('not json')).toEqual([]);
    expect(deserializeCharts('{"charts": 42}')).toEqual([]);
  });

  it('migrates legacy specs with defaults', () => {
    const m = migrateChart({ kind: 'pie' } as Partial<import('../src/index.js').ChartSpec>);
    expect(m.version).toBe(CHART_SPEC_VERSION);
    expect(m.legend).toBe('bottom');
    expect(m.range.sheet).toBe('Sheet1');
  });

  it('preserves the pivot binding through migration (localStorage round trip)', () => {
    const m = migrateChart({
      kind: 'column-clustered',
      pivot: { pivotId: 7, valueIndex: 1 },
    } as Partial<import('../src/index.js').ChartSpec>);
    expect(m.pivot).toEqual({ pivotId: 7, valueIndex: 1 });
  });

  it('drops a corrupt pivot binding instead of crashing', () => {
    const m = migrateChart({
      kind: 'column-clustered',
      pivot: { pivotId: 'x' },
    } as unknown as Partial<import('../src/index.js').ChartSpec>);
    // pivotId falls back to -1 (matches no pivot -> honest "unavailable" error).
    expect(m.pivot).toEqual({ pivotId: -1, valueIndex: 0 });
    const plain = migrateChart({ kind: 'line' } as Partial<import('../src/index.js').ChartSpec>);
    expect(plain.pivot).toBeUndefined();
  });
});

describe('buildChartConfig exhaustive', () => {
  const series = {
    labels: ['A', 'B', 'C'],
    datasets: [
      { label: 'S1', data: [10, -5, 20] },
      { label: 'S2', data: [30, 15, 40] },
      { label: 'S3', data: [5, 8, 12] },
    ],
  };

  it('builds a config for every one of the 61 kinds without throwing', () => {
    for (const kind of ALL_KINDS) {
      const spec = makeChartSpec({ kind, range, title: 'T', dataLabels: true });
      expect(() => buildChartConfig(spec, series), `kind ${kind}`).not.toThrow();
      const { config, svg } = buildChartConfig(spec, series);
      if (svg) {
        expect(['treemap', 'sunburst', 'contour', 'surface', 'map']).toContain(svg);
      } else {
        expect(config.type).toBeTruthy();
        expect(config.data).toBeDefined();
      }
    }
  });

  it('builds a config for an empty series without throwing', () => {
    const empty = { labels: [], datasets: [] };
    for (const kind of ALL_KINDS) {
      if (kind === 'map-filled') continue; // out of scope for rendering
      const spec = makeChartSpec({ kind, range });
      expect(() => buildChartConfig(spec, empty), `kind ${kind}`).not.toThrow();
    }
  });
});
