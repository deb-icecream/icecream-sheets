import { describe, expect, it } from 'vitest';
import { buildForecastSheetSpec, extendTimeline, forecastSheetName } from './forecast';

describe('extendTimeline', () => {
  it('extends daily dates by whole days', () => {
    const out = extendTimeline(['2026-01-01', '2026-01-02', '2026-01-03'], 2);
    expect(out.slice(3)).toEqual(['2026-01-04', '2026-01-05']);
  });
  it('extends monthly dates by ~30 days', () => {
    const out = extendTimeline(['2026-01-01', '2026-02-01', '2026-03-01'], 1);
    expect(out[3]).toBe('2026-04-01'); // median step (31d) from Mar 1
  });
  it('extends numeric timelines by the median step', () => {
    expect(extendTimeline([1, 2, 3], 2).slice(3)).toEqual([4, 5]);
  });
  it('handles zero periods', () => {
    expect(extendTimeline([1, 2], 0)).toEqual([1, 2]);
  });
});

describe('buildForecastSheetSpec', () => {
  const input = {
    timeline: ['2026-01-01', '2026-02-01', '2026-03-01'],
    values: [10, 20, 30],
    periods: 2,
  };
  it('builds timeline + actuals + formulas', () => {
    const spec = buildForecastSheetSpec(input, 'Forecast_Sheet1');
    expect(spec.timeline.length).toBe(5);
    expect(spec.actuals).toEqual([10, 20, 30, '', '']);
    expect(spec.formulas.length).toBe(2);
  });
  it('references the history block with FORECAST.ETS', () => {
    const spec = buildForecastSheetSpec(input, 'F');
    expect(spec.formulas[0].forecast).toBe('=FORECAST.ETS($A$5,$B$2:$B$4,$A$2:$A$4)');
    expect(spec.formulas[0].lower).toContain('FORECAST.ETS.CONFINT($A$5,$B$2:$B$4,$A$2:$A$4,0.95)');
    expect(spec.formulas[0].upper).toContain('+');
  });
  it('passes manual seasonality through', () => {
    const spec = buildForecastSheetSpec({ ...input, seasonality: 12 }, 'F');
    expect(spec.formulas[0].forecast).toContain(',12)');
  });
  it('validates inputs', () => {
    expect(() => buildForecastSheetSpec({ ...input, values: [1, 2] }, 'F')).toThrow();
    expect(() => buildForecastSheetSpec({ ...input, periods: 0 }, 'F')).toThrow();
    expect(() => buildForecastSheetSpec({ ...input, confidence: 2 }, 'F')).toThrow();
    expect(() => buildForecastSheetSpec({ timeline: ['a', 'b'], values: [1, 2], periods: 1 }, 'F')).toThrow();
  });
});

describe('forecastSheetName', () => {
  it('uniques against existing sheets', () => {
    expect(forecastSheetName('S', [])).toBe('Forecast_S');
    expect(forecastSheetName('S', ['Forecast_S'])).toBe('Forecast_S_2');
  });
});
