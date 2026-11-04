/**
 * Tests for localization, volatile policy, and iterative settings.
 */
import { describe, expect, it } from 'vitest';
import {
  registerLocales,
  localizeFunctionName,
  SUPPORTED_LOCALES,
} from '../src/localization.js';
import {
  VOLATILE_FUNCTIONS,
  isVolatileFormula,
  shouldRecalcVolatile,
} from '../src/volatile.js';
import {
  DEFAULT_ITERATIVE,
  normalizeIterative,
  iterateUntilConverged,
} from '../src/iterative.js';

describe('localization', () => {
  it('supports 7 locales', () => {
    expect(SUPPORTED_LOCALES).toHaveLength(7);
    expect(SUPPORTED_LOCALES.map((l) => l.id)).toContain('jaJP');
    expect(SUPPORTED_LOCALES.map((l) => l.id)).toContain('zhCN');
  });

  it('registerLocales is idempotent', () => {
    registerLocales();
    registerLocales(); // should not throw
  });

  it('english returns unchanged', () => {
    expect(localizeFunctionName('SUM', 'enGB')).toBe('SUM');
    expect(localizeFunctionName('XLOOKUP', 'enUS')).toBe('XLOOKUP');
  });

  it('translates XLOOKUP to Spanish/French/German', () => {
    expect(localizeFunctionName('XLOOKUP', 'esES')).toBe('BUSCARX');
    expect(localizeFunctionName('XLOOKUP', 'frFR')).toBe('RECHERCHEX');
    expect(localizeFunctionName('XLOOKUP', 'deDE')).toBe('XVERWEIS');
  });

  it('translates TEXTJOIN', () => {
    expect(localizeFunctionName('TEXTJOIN', 'esES')).toBe('UNIRTEXTO');
    expect(localizeFunctionName('TEXTJOIN', 'deDE')).toBe('TEXTVERKETTEN');
  });

  it('falls back to English when untranslated', () => {
    expect(localizeFunctionName('SOMEUNKNOWN', 'esES')).toBe('SOMEUNKNOWN');
  });

  it('translates core functions to Japanese/Chinese', () => {
    expect(localizeFunctionName('SUM', 'jaJP')).toBe('合計');
    expect(localizeFunctionName('SUM', 'zhCN')).toBe('求和');
  });
});

describe('volatile policy', () => {
  it('lists volatile functions', () => {
    expect(VOLATILE_FUNCTIONS.has('NOW')).toBe(true);
    expect(VOLATILE_FUNCTIONS.has('RAND')).toBe(true);
    expect(VOLATILE_FUNCTIONS.has('SUM')).toBe(false);
  });

  it('detects volatile formulas', () => {
    expect(isVolatileFormula('=NOW()')).toBe(true);
    expect(isVolatileFormula('=RAND()*10')).toBe(true);
    expect(isVolatileFormula('=TODAY()+7')).toBe(true);
    expect(isVolatileFormula('=SUM(A1:A10)')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isVolatileFormula('=now()')).toBe(true);
  });

  it('automatic mode always recalcs', () => {
    expect(shouldRecalcVolatile('automatic', false)).toBe(true);
  });

  it('manual mode only on explicit', () => {
    expect(shouldRecalcVolatile('manual', false)).toBe(false);
    expect(shouldRecalcVolatile('manual', true)).toBe(true);
  });
});

describe('iterative settings', () => {
  it('has sane defaults', () => {
    expect(DEFAULT_ITERATIVE.enabled).toBe(false);
    expect(DEFAULT_ITERATIVE.maxIterations).toBe(100);
    expect(DEFAULT_ITERATIVE.maxChange).toBe(0.001);
  });

  it('normalizes valid input', () => {
    const s = normalizeIterative({ enabled: true, maxIterations: 50, maxChange: 0.01 });
    expect(s).toEqual({ enabled: true, maxIterations: 50, maxChange: 0.01 });
  });

  it('clamps maxIterations to 1..32767', () => {
    expect(normalizeIterative({ maxIterations: 0 }).maxIterations).toBe(1);
    expect(normalizeIterative({ maxIterations: 99999 }).maxIterations).toBe(32767);
  });

  it('falls back on invalid maxChange', () => {
    expect(normalizeIterative({ maxChange: -1 }).maxChange).toBe(0.001);
    expect(normalizeIterative({ maxChange: NaN }).maxChange).toBe(0.001);
  });

  it('converges on stable function', () => {
    const r = iterateUntilConverged(() => 42, { enabled: true, maxIterations: 100, maxChange: 0.001 });
    expect(r.converged).toBe(true);
    expect(r.value).toBe(42);
    expect(r.iterations).toBe(1);
  });

  it('converges on geometric series', () => {
    let x = 0;
    const r = iterateUntilConverged(
      () => { x = x / 2 + 50; return x; },
      { enabled: true, maxIterations: 100, maxChange: 0.001 },
    );
    expect(r.converged).toBe(true);
    expect(r.value).toBeCloseTo(100, 2);
  });

  it('reports non-convergence', () => {
    let n = 0;
    const r = iterateUntilConverged(
      () => ++n,
      { enabled: true, maxIterations: 5, maxChange: 0.001 },
    );
    expect(r.converged).toBe(false);
    expect(r.iterations).toBe(5);
  });
});
