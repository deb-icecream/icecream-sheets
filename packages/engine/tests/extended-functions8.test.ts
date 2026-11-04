/**
 * Tests for extended-functions8 (batch 8): FORECAST.ETS family, FREQUENCY,
 * MODE.MULT, LENB, TRIMRANGE, T.
 *
 * NOTE: this file imports ONLY the batch-8 module (plus vitest and
 * hyperformula itself). The batch-8 plugin is registered via
 * registerExtendedFunctions8() and applies to subsequently built instances.
 */
import { describe, expect, it } from 'vitest';
import { CellError, EmptyValue, ErrorType, HyperFormula } from 'hyperformula';
import {
  ExtendedPlugin8,
  detectSeasonality,
  etsForecast,
  fitEtsAAA,
  registerExtendedFunctions8,
  spill,
  to2DArray,
  type ArrayResult,
} from '../src/extended-functions8.js';
import type { InterpreterValue } from 'hyperformula';

registerExtendedFunctions8();

/** Build a workbook whose A1 holds the given formula; return A1's value. */
function evalA1(formula: string, sheet: (string | number | boolean | null)[][] = []): unknown {
  const grid = sheet.map((row) => [...row]);
  if (grid.length === 0) grid.push([]);
  grid[0]![0] = formula;
  const hf = HyperFormula.buildFromSheets({ Sheet1: grid }, { licenseKey: 'gpl-v3' });
  return hf.getCellValue({ sheet: 0, row: 0, col: 0 });
}

function errType(v: unknown): string | null {
  // getCellValue surfaces errors as DetailedCellError (not CellError),
  // which still carries the ErrorType string in `.type`.
  if (v instanceof CellError) return v.type;
  if (v !== null && typeof v === 'object' && 'type' in v) {
    const t = (v as { type: unknown }).type;
    return typeof t === 'string' ? t : null;
  }
  return null;
}

describe('FORECAST.ETS', () => {
  it('forecasts the continuation of a linear series', () => {
    // values 10,20,30,40 on timeline 1..4; next step (t=5) should be ~50.
    const v = evalA1('=FORECAST.ETS(5,{10,20,30,40},{1,2,3,4},0)');
    expect(typeof v).toBe('number');
    expect(Math.abs((v as number) - 50)).toBeLessThan(3);
  });

  it('forecasts multiple steps ahead', () => {
    // t=6 is two steps past the end of {1,2,3,4}: expect ~60.
    const v = evalA1('=FORECAST.ETS(6,{10,20,30,40},{1,2,3,4},0)');
    expect(typeof v).toBe('number');
    expect(Math.abs((v as number) - 60)).toBeLessThan(5);
  });

  it('returns #N/A when the timeline is too short', () => {
    expect(errType(evalA1('=FORECAST.ETS(3,{10,20},{1,2},0)'))).toBe(ErrorType.NA);
  });

  it('returns #NUM! for invalid seasonality', () => {
    expect(errType(evalA1('=FORECAST.ETS(5,{10,20,30,40},{1,2,3,4},-1)'))).toBe(ErrorType.NUM);
    expect(errType(evalA1('=FORECAST.ETS(5,{10,20,30,40},{1,2,3,4},2.5)'))).toBe(ErrorType.NUM);
  });

  it('returns #NUM! when target_date is before the end of the timeline', () => {
    expect(errType(evalA1('=FORECAST.ETS(2,{10,20,30,40},{1,2,3,4},0)'))).toBe(ErrorType.NUM);
  });

  it('forecasts seasonal data with explicit seasonality', () => {
    // 36 monthly points: 100 + 10*sin(2*pi*i/12). Next month (t=37) has
    // the same phase as t=1: 100 + 10*sin(0) = 100.
    const vals: number[] = [];
    const tl: number[] = [];
    for (let i = 0; i < 36; i++) {
      vals.push(100 + 10 * Math.sin((2 * Math.PI * i) / 12));
      tl.push(i + 1);
    }
    const v = evalA1(`=FORECAST.ETS(37,{${vals.join(',')}},{${tl.join(',')}},12)`);
    expect(typeof v).toBe('number');
    expect(Math.abs((v as number) - 100)).toBeLessThan(10);
  });
});

describe('FORECAST.ETS.CONFINT', () => {
  it('returns a positive half-width for noisy data', () => {
    const v = evalA1('=FORECAST.ETS.CONFINT(5,{10,21,29,42},{1,2,3,4},0.95,0)');
    expect(typeof v).toBe('number');
    expect(v as number).toBeGreaterThan(0);
  });

  it('grows with the forecast horizon', () => {
    const near = evalA1('=FORECAST.ETS.CONFINT(5,{10,21,29,42},{1,2,3,4},0.95,0)') as number;
    const far = evalA1('=FORECAST.ETS.CONFINT(9,{10,21,29,42},{1,2,3,4},0.95,0)') as number;
    expect(far).toBeGreaterThan(near);
  });

  it('returns #NUM! for confidence_level outside (0,1)', () => {
    expect(errType(evalA1('=FORECAST.ETS.CONFINT(5,{10,20,30,40},{1,2,3,4},1.5,0)'))).toBe(
      ErrorType.NUM,
    );
  });
});

describe('FORECAST.ETS.SEASONALITY', () => {
  it('detects period 12 in monthly seasonal data', () => {
    const vals: number[] = [];
    const tl: number[] = [];
    for (let i = 0; i < 36; i++) {
      vals.push(50 + 8 * Math.sin((2 * Math.PI * i) / 12));
      tl.push(i + 1);
    }
    expect(evalA1(`=FORECAST.ETS.SEASONALITY({${vals.join(',')}},{${tl.join(',')}})`)).toBe(12);
  });

  it('returns 0 when there is no seasonal pattern', () => {
    // Too few points to detect anything -> 0.
    expect(evalA1('=FORECAST.ETS.SEASONALITY({10,20,30,40},{1,2,3,4})')).toBe(0);
  });

  it('detects period 4 in quarterly data', () => {
    const vals: number[] = [];
    const tl: number[] = [];
    for (let i = 0; i < 24; i++) {
      vals.push(20 + 5 * Math.sin((2 * Math.PI * i) / 4));
      tl.push(i + 1);
    }
    expect(evalA1(`=FORECAST.ETS.SEASONALITY({${vals.join(',')}},{${tl.join(',')}})`)).toBe(4);
  });
});

describe('FORECAST.ETS.STAT', () => {
  it('returns smoothing params in (0,1)', () => {
    const alpha = evalA1('=FORECAST.ETS.STAT({10,21,29,42},{1,2,3,4},1,0)') as number;
    const beta = evalA1('=FORECAST.ETS.STAT({10,21,29,42},{1,2,3,4},2,0)') as number;
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThan(1);
    expect(beta).toBeGreaterThan(0);
    expect(beta).toBeLessThan(1);
  });

  it('returns positive error metrics', () => {
    const mae = evalA1('=FORECAST.ETS.STAT({10,21,29,42},{1,2,3,4},6,0)') as number;
    const rmse = evalA1('=FORECAST.ETS.STAT({10,21,29,42},{1,2,3,4},7,0)') as number;
    const mase = evalA1('=FORECAST.ETS.STAT({10,21,29,42},{1,2,3,4},4,0)') as number;
    const smape = evalA1('=FORECAST.ETS.STAT({10,21,29,42},{1,2,3,4},5,0)') as number;
    expect(mae).toBeGreaterThan(0);
    expect(rmse).toBeGreaterThan(0);
    expect(rmse).toBeGreaterThanOrEqual(mae); // RMSE >= MAE always
    expect(mase).toBeGreaterThan(0);
    expect(smape).toBeGreaterThan(0);
  });

  it('returns #NUM! for an invalid statistic_type', () => {
    expect(errType(evalA1('=FORECAST.ETS.STAT({10,20,30,40},{1,2,3,4},8,0)'))).toBe(ErrorType.NUM);
  });
});

describe('FREQUENCY', () => {
  it('bins data into ascending bins plus an overflow bin', () => {
    // {1,2,3,4} with bins {2,3}: <=2 -> 2; (2,3] -> 1; >3 -> 1.
    const v = evalA1('=FREQUENCY({1,2,3,4},{2,3})');
    expect(v).toEqual([[2], [1], [1]]);
  });

  it('returns a single overflow bin when bins_array is empty', () => {
    // B2 is an empty cell -> no bins -> one overflow bin with all 3 values.
    const v = evalA1('=FREQUENCY({1,2,3},B2)');
    expect(v).toEqual([[3]]);
  });

  it('rejects non-ascending bins with #VALUE!', () => {
    expect(errType(evalA1('=FREQUENCY({1,2,3},{3,2})'))).toBe(ErrorType.VALUE);
  });

  it('spills through the spill() helper', () => {
    const values: ArrayResult = [[2], [1], [1]];
    const written = new Map<string, InterpreterValue>();
    const result = spill(
      0,
      0,
      values,
      (r, c, val) => {
        written.set(`${r},${c}`, val);
      },
      () => EmptyValue,
    );
    expect(result).toBe('ok');
    expect(written.get('0,0')).toBeUndefined(); // anchor keeps the formula
    expect(written.get('1,0')).toBe(1);
    expect(written.get('2,0')).toBe(1);
  });
});

describe('MODE.MULT', () => {
  it('returns all modes as a spilling vertical array', () => {
    // 2 and 3 both occur twice -> {2;3}.
    const v = evalA1('=MODE.MULT({1,2,2,3,3,4})');
    expect(v).toEqual([[2], [3]]);
  });

  it('returns #N/A when no value repeats', () => {
    expect(errType(evalA1('=MODE.MULT({1,2,3,4})'))).toBe(ErrorType.NA);
  });

  it('returns a single mode as a scalar (Excel implicit intersection)', () => {
    // Single mode returns the scalar directly so scalar-context references
    // (e.g. =ROUND(A2,12)) intersect correctly; the grid display is identical.
    const v = evalA1('=MODE.MULT({5,5,5,1,2})');
    expect(v).toEqual(5);
  });

  it('scalar-context reference to a single-mode MODE.MULT cell works', () => {
    // A2 holds =MODE.MULT(...); A3 =ROUND(A2,12) must intersect to the scalar.
    const hf = HyperFormula.buildFromSheets(
      { Sheet1: [[2, 1.5, 2], ['=MODE.MULT(A1:C1)'], ['=ROUND(A2,12)']] },
      { licenseKey: 'gpl-v3' },
    );
    expect(hf.getCellValue({ sheet: 0, row: 2, col: 0 })).toEqual(2);
  });
});

describe('LENB', () => {
  it('counts single-byte chars as 1', () => {
    expect(evalA1('=LENB("hello")')).toBe(5);
  });

  it('counts double-byte chars as 2', () => {
    expect(evalA1('=LENB("日本語")')).toBe(6);
  });

  it('mixes single and double-byte chars', () => {
    expect(evalA1('=LENB("a日b")')).toBe(4);
  });
});

describe('TRIMRANGE', () => {
  it('trims trailing empty rows and columns', () => {
    // 3x3 grid with only A1:B2 filled -> 2x2 result.
    const sheet = [
      [1, 2, null],
      [3, 4, null],
      [null, null, null],
    ];
    const hf = HyperFormula.buildFromSheets({ Sheet1: sheet }, { licenseKey: 'gpl-v3' });
    hf.setCellContents({ sheet: 0, row: 0, col: 5 }, '=TRIMRANGE(A1:C3)');
    expect(hf.getCellValue({ sheet: 0, row: 0, col: 5 })).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('leaves a fully-filled range unchanged', () => {
    const v = evalA1('=TRIMRANGE({1,2;3,4})');
    expect(v).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('returns #VALUE! for an entirely empty range', () => {
    const sheet = [
      [null, null],
      [null, null],
    ];
    const hf = HyperFormula.buildFromSheets({ Sheet1: sheet }, { licenseKey: 'gpl-v3' });
    hf.setCellContents({ sheet: 0, row: 0, col: 5 }, '=TRIMRANGE(A1:B2)');
    const v = hf.getCellValue({ sheet: 0, row: 0, col: 5 });
    expect(errType(v)).toBe(ErrorType.VALUE);
  });

  it('spills through the spill() helper', () => {
    const values: ArrayResult = [
      [1, 2],
      [3, 4],
    ];
    const written = new Map<string, InterpreterValue>();
    const result = spill(
      2,
      3,
      values,
      (r, c, val) => {
        written.set(`${r},${c}`, val);
      },
      () => EmptyValue,
    );
    expect(result).toBe('ok');
    expect(written.get('2,4')).toBe(2);
    expect(written.get('3,3')).toBe(3);
    expect(written.get('3,4')).toBe(4);
  });
});

describe('T', () => {
  it('returns text unchanged', () => {
    expect(evalA1('=T("abc")')).toBe('abc');
  });

  it('returns "" for numbers', () => {
    expect(evalA1('=T(123)')).toBe('');
  });

  it('returns "" for booleans', () => {
    expect(evalA1('=T(TRUE())')).toBe('');
  });
});

describe('ETS internals (exported pure helpers)', () => {
  it('detectSeasonality finds period 12 in seasonal data', () => {
    const vals: number[] = [];
    for (let i = 0; i < 36; i++) vals.push(50 + 8 * Math.sin((2 * Math.PI * i) / 12));
    expect(detectSeasonality(vals)).toBe(12);
  });

  it('fitEtsAAA + etsForecast continues a linear trend', () => {
    const fit = fitEtsAAA([10, 20, 30, 40], 1);
    expect(fit.alpha).toBeGreaterThan(0);
    expect(fit.alpha).toBeLessThan(1);
    expect(Math.abs(etsForecast(fit, 1) - 50)).toBeLessThan(3);
  });

  it('to2DArray normalizes scalars and ranges', () => {
    expect(to2DArray(5 as InterpreterValue)).toEqual([[5]]);
    expect(to2DArray([[1, 2]] as unknown as InterpreterValue)).toEqual([[1, 2]]);
  });

  it('plugin class is registered and implements its functions', () => {
    const fns = Object.keys(ExtendedPlugin8.implementedFunctions);
    expect(fns).toContain('FORECAST.ETS');
    expect(fns).toContain('FREQUENCY');
    // T() is a HyperFormula built-in, intentionally not re-registered here.
    expect(HyperFormula.getFunctionPlugin('T')).toBeDefined();
    expect(HyperFormula.getFunctionPlugin('FORECAST.ETS')).toBeDefined();
  });
});
