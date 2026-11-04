import { describe, expect, it } from 'vitest';
import {
  addTrendlinesToConfig,
  fitTrendline,
  forecastTrendline,
  pivotResultToSeries,
  createPivot,
  trendlineDatasets,
  trendlineEquation,
  trendlineRSquared,
  type PivotResult,
  type PivotValueField,
} from '../src/index.js';

function mkPivot(): PivotResult {
  const records = [
    { Region: 'East', Product: 'A', Amount: 10 },
    { Region: 'East', Product: 'B', Amount: 20 },
    { Region: 'West', Product: 'A', Amount: 30 },
    { Region: 'West', Product: 'B', Amount: 40 },
  ];
  const values: PivotValueField[] = [{ field: 'Amount', aggregation: 'sum' }];
  return createPivot(records, { version: 1, rows: ['Region'], columns: ['Product'], values });
}

describe('fitTrendline', () => {
  it('fits a linear trendline exactly through linear data', () => {
    const out = fitTrendline([2, 4, 6, 8], { type: 'linear' });
    out.forEach((v, i) => expect(v).toBeCloseTo(2 * (i + 1), 6));
  });

  it('returns nulls when fewer than two numeric points exist', () => {
    expect(fitTrendline([5, null, null], { type: 'linear' })).toEqual([null, null, null]);
  });

  it('computes a moving average with the given period', () => {
    const out = fitTrendline([1, 2, 3, 4], { type: 'movingAverage', period: 2 });
    expect(out[0]).toBeCloseTo(1, 6); // window [1]
    expect(out[1]).toBeCloseTo(1.5, 6); // window [1,2]
    expect(out[3]).toBeCloseTo(3.5, 6); // window [3,4]
  });

  it('fits exponential growth', () => {
    const out = fitTrendline([1, 2, 4, 8], { type: 'exponential' });
    out.forEach((v, i) => expect(v).toBeCloseTo(Math.pow(2, i), 4));
  });

  it('refuses exponential on non-positive values', () => {
    expect(fitTrendline([1, 0, 4], { type: 'exponential' })).toEqual([null, null, null]);
  });

  it('fits a quadratic polynomial', () => {
    const out = fitTrendline([1, 4, 9, 16], { type: 'polynomial', order: 2 });
    out.forEach((v, i) => expect(v).toBeCloseTo((i + 1) * (i + 1), 3));
  });

  it('skips null gaps when fitting', () => {
    const out = fitTrendline([2, null, 6], { type: 'linear' });
    expect(out[0]).toBeCloseTo(2, 6);
    expect(out[2]).toBeCloseTo(6, 6);
  });
});

describe('pivotResultToSeries', () => {
  it('maps row keys to labels and column keys to datasets', () => {
    const s = pivotResultToSeries(mkPivot(), 0);
    expect(s.labels).toEqual(['East', 'West']);
    expect(s.datasets.map((d) => d.label)).toEqual(['A', 'B']);
    expect(s.datasets[0].data).toEqual([10, 30]);
    expect(s.datasets[1].data).toEqual([20, 40]);
  });

  it('transposes when requested', () => {
    const s = pivotResultToSeries(mkPivot(), 0, 'columnsAsLabels');
    expect(s.labels).toEqual(['A', 'B']);
    expect(s.datasets.map((d) => d.label)).toEqual(['East', 'West']);
    expect(s.datasets[0].data).toEqual([10, 20]);
  });

  it('clamps out-of-range value indexes', () => {
    const s = pivotResultToSeries(mkPivot(), 99);
    expect(s.datasets[0].data).toEqual([10, 30]);
  });
});

describe('trendline gaps (Excel parity)', () => {
  it('fits a power trendline y = x^2', () => {
    const out = fitTrendline([1, 4, 9, 16], { type: 'power' });
    out.forEach((v, i) => expect(v).toBeCloseTo(Math.pow(i + 1, 2), 3));
    expect(trendlineEquation([1, 4, 9, 16], { type: 'power' })).toBe('y = 1x^{2}');
  });

  it('refuses power on non-positive values', () => {
    expect(fitTrendline([1, 0, 4], { type: 'power' })).toEqual([null, null, null]);
  });

  it('fits logarithmic data (1-based x, matching Excel)', () => {
    const ys = [1, 2, 3, 4].map((x) => 2 * Math.log(x) + 1);
    const out = fitTrendline(ys, { type: 'logarithmic' });
    out.forEach((v, i) => expect(v).toBeCloseTo(ys[i], 6));
    expect(trendlineEquation(ys, { type: 'logarithmic' })).toBe('y = 2ln(x) + 1');
  });

  it('reports Excel-style equations', () => {
    expect(trendlineEquation([2, 4, 6, 8], { type: 'linear' })).toBe('y = 2x');
    expect(trendlineEquation([3, 5, 7], { type: 'linear' })).toBe('y = 2x + 1');
    expect(trendlineEquation([1, 4, 9, 16], { type: 'polynomial', order: 2 })).toBe('y = x^{2}');
    expect(trendlineEquation([1, 2, 4, 8], { type: 'exponential' })).toMatch(/^y = [\d.]+e\^/);
    expect(trendlineEquation([1, 2, 3], { type: 'movingAverage' })).toBeNull();
  });

  it('computes R-squared ~1 for exact fits and null for moving average', () => {
    expect(trendlineRSquared([2, 4, 6, 8], { type: 'linear' })).toBeCloseTo(1, 6);
    expect(trendlineRSquared([1, 4, 9, 16], { type: 'polynomial', order: 2 })).toBeCloseTo(1, 6);
    const noisy = [2.1, 3.9, 6.2, 7.8];
    const r2 = trendlineRSquared(noisy, { type: 'linear' })!;
    expect(r2).toBeGreaterThan(0.99);
    expect(r2).toBeLessThan(1);
    expect(trendlineRSquared([1, 2, 3], { type: 'movingAverage' })).toBeNull();
  });

  it('forecasts forward and backward periods', () => {
    const { data, offset } = forecastTrendline([2, 4, 6, 8], {
      type: 'linear',
      forward: 2,
      backward: 1,
    });
    expect(offset).toBe(1);
    expect(data).toHaveLength(7);
    // backward: y(0) = 0; base: 2,4,6,8; forward: y(5)=10, y(6)=12
    expect(data[0]).toBeCloseTo(0, 6);
    expect(data[1]).toBeCloseTo(2, 6);
    expect(data[4]).toBeCloseTo(8, 6);
    expect(data[5]).toBeCloseTo(10, 6);
    expect(data[6]).toBeCloseTo(12, 6);
  });

  it('extends moving-average forecasts flat', () => {
    const { data, offset } = forecastTrendline([1, 2, 3, 4], {
      type: 'movingAverage',
      period: 2,
      forward: 2,
      backward: 1,
    });
    expect(offset).toBe(1);
    // base = [1, 1.5, 2.5, 3.5]; backward flat from first, forward flat from last
    expect(data[0]).toBeCloseTo(1, 6);
    expect(data[1]).toBeCloseTo(1, 6);
    expect(data[5]).toBeCloseTo(3.5, 6);
    expect(data[6]).toBeCloseTo(3.5, 6);
  });

  it('honours a custom intercept (Set Intercept)', () => {
    // y = 2x + 0 forced through the origin on data y = 2x + 0.5-ish
    const out = fitTrendline([2.5, 4.5, 6.5], { type: 'linear', intercept: 0 });
    // slope = Σx(y-0)/Σx² = (1*2.5 + 2*4.5 + 3*6.5) / 14 = 31/14
    out.forEach((v, i) => expect(v).toBeCloseTo(((31 / 14) * (i + 1)), 6));
    expect(trendlineEquation([2.5, 4.5, 6.5], { type: 'linear', intercept: 0 })).toMatch(
      /^y = 2\.2143x$/,
    );
  });

  it('appends equation and R² to the dataset label when requested', () => {
    const series = {
      labels: ['a', 'b', 'c', 'd'],
      datasets: [{ label: 'Sales', data: [2, 4, 6, 8] }],
    };
    const out = trendlineDatasets(series as never, [
      { type: 'linear', displayEquation: true, displayRSquared: true },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].equation).toBe('y = 2x');
    expect(out[0].rSquared).toBeCloseTo(1, 6);
    expect(out[0].label).toContain('y = 2x');
    expect(out[0].label).toContain('R²');
  });

  it('addTrendlinesToConfig extends labels and pads datasets for forecasts', () => {
    const built = {
      svg: null,
      config: {
        data: {
          labels: ['a', 'b'],
          datasets: [{ label: 'S', data: [2, 4] }],
        },
      },
    };
    addTrendlinesToConfig(built as never, { labels: [], datasets: [{ label: 'S', data: [2, 4] }] } as never, {
      kind: 'line',
      trendlines: [{ type: 'linear', forward: 1, backward: 1 }],
    } as never);
    const data = (built.config.data as { labels: string[]; datasets: { data: (number | null)[] }[] });
    expect(data.labels).toEqual(['', 'a', 'b', '']);
    expect(data.datasets).toHaveLength(2);
    expect(data.datasets[0].data).toEqual([null, 2, 4, null]);
    // trendline y = 2x: backward y(0)=0, base 2,4, forward y(3)=6
    expect(data.datasets[1].data).toEqual([0, 2, 4, 6]);
  });

  it('addTrendlinesToConfig still skips pies and 100% stacked charts', () => {
    const built = {
      svg: null,
      config: { data: { labels: ['a'], datasets: [{ label: 'S', data: [1] }] } },
    };
    addTrendlinesToConfig(built as never, { labels: [], datasets: [{ label: 'S', data: [1] }] } as never, {
      kind: 'pie',
      trendlines: [{ type: 'linear' }],
    } as never);
    expect((built.config.data as { datasets: unknown[] }).datasets).toHaveLength(1);
  });

  it('addTrendlinesToConfig puts the overlay on the fitted dataset\'s axis', () => {
    const built = {
      svg: null,
      config: {
        data: {
          labels: ['a', 'b', 'c'],
          datasets: [
            { label: 'Bars', data: [10, 20, 30] },
            { label: 'Line', data: [0.1, 0.2, 0.15], yAxisID: 'y1' },
          ],
        },
      },
    };
    addTrendlinesToConfig(
      built as never,
      { labels: [], datasets: [{ label: 'Bars', data: [10, 20, 30] }, { label: 'Line', data: [0.1, 0.2, 0.15] }] } as never,
      {
        kind: 'combo-column-line-2axis',
        trendlines: [{ type: 'linear', seriesIndex: 1 }],
      } as never,
    );
    const data = built.config.data as { datasets: { yAxisID?: string }[] };
    expect(data.datasets).toHaveLength(3);
    // The trendline was fitted on the y1 dataset, so it must render on y1
    // (otherwise it would be flattened onto the primary axis).
    expect(data.datasets[2].yAxisID).toBe('y1');
  });

  it('addTrendlinesToConfig leaves the axis alone on single-axis charts', () => {
    const built = {
      svg: null,
      config: { data: { labels: ['a', 'b'], datasets: [{ label: 'S', data: [2, 4] }] } },
    };
    addTrendlinesToConfig(built as never, { labels: [], datasets: [{ label: 'S', data: [2, 4] }] } as never, {
      kind: 'line',
      trendlines: [{ type: 'linear' }],
    } as never);
    const data = built.config.data as { datasets: { yAxisID?: string }[] };
    expect(data.datasets).toHaveLength(2);
    expect(data.datasets[1].yAxisID).toBeUndefined();
  });
});
