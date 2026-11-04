/**
 * Unit tests for increase/decrease decimal places.
 */
import { describe, expect, it } from 'vitest';
import {
  canDecreaseDecimals,
  canIncreaseDecimals,
  currentDecimals,
  decreaseDecimals,
  defaultDecimalsFor,
  increaseDecimals,
  MAX_DECIMALS,
} from './decimals';
import type { CellFormat } from './formatting';

describe('currentDecimals', () => {
  it('returns 0 for undefined', () => {
    expect(currentDecimals(undefined)).toBe(0);
  });

  it('returns 2 for Number without an explicit count', () => {
    expect(currentDecimals({ numberFormat: 'Number' })).toBe(2);
  });

  it('returns 0 for General without an explicit count', () => {
    expect(currentDecimals({ numberFormat: 'General' })).toBe(0);
  });

  it('prefers the explicit decimals field', () => {
    expect(currentDecimals({ numberFormat: 'Number', decimals: 5 })).toBe(5);
  });

  it('clamps explicit decimals into range', () => {
    expect(currentDecimals({ decimals: 99 })).toBe(MAX_DECIMALS);
    expect(currentDecimals({ decimals: -4 })).toBe(0);
  });
});

describe('defaultDecimalsFor', () => {
  it('is 2 for decimal-capable formats', () => {
    for (const f of ['Number', 'Currency', 'Accounting', 'Percentage', 'Scientific'] as const) {
      expect(defaultDecimalsFor(f)).toBe(2);
    }
  });

  it('is 0 for General, Text, Date, Fraction', () => {
    for (const f of ['General', 'Text', 'Date', 'Time', 'Fraction'] as const) {
      expect(defaultDecimalsFor(f)).toBe(0);
    }
  });
});

describe('increaseDecimals', () => {
  it('adds one decimal to a Number format', () => {
    expect(increaseDecimals({ numberFormat: 'Number' })).toMatchObject({
      numberFormat: 'Number',
      decimals: 3,
    });
  });

  it('promotes General to Number with 1 decimal', () => {
    expect(increaseDecimals({ numberFormat: 'General' })).toMatchObject({
      numberFormat: 'Number',
      decimals: 1,
    });
  });

  it('promotes an unformatted cell to Number with 1 decimal', () => {
    expect(increaseDecimals(undefined)).toMatchObject({ numberFormat: 'Number', decimals: 1 });
  });

  it('caps at 30 decimals', () => {
    expect(increaseDecimals({ numberFormat: 'Number', decimals: 30 }).decimals).toBe(30);
  });

  it('preserves unrelated format fields', () => {
    const out = increaseDecimals({ bold: true, numberFormat: 'Percentage' });
    expect(out.bold).toBe(true);
    expect(out.numberFormat).toBe('Percentage');
    expect(out.decimals).toBe(3);
  });
});

describe('decreaseDecimals', () => {
  it('removes one decimal from a Number format', () => {
    expect(decreaseDecimals({ numberFormat: 'Number' })).toMatchObject({
      numberFormat: 'Number',
      decimals: 1,
    });
  });

  it('floors at 0 decimals', () => {
    expect(decreaseDecimals({ numberFormat: 'Number', decimals: 0 }).decimals).toBe(0);
    expect(decreaseDecimals(undefined).decimals).toBe(0);
  });

  it('keeps the format category on decrease', () => {
    const out = decreaseDecimals({ numberFormat: 'Currency', decimals: 2 });
    expect(out.numberFormat).toBe('Currency');
    expect(out.decimals).toBe(1);
  });
});

describe('canIncreaseDecimals / canDecreaseDecimals', () => {
  it('disables increase at the cap', () => {
    expect(canIncreaseDecimals({ decimals: 30 })).toBe(false);
    expect(canIncreaseDecimals({ decimals: 29 })).toBe(true);
  });

  it('disables decrease at zero', () => {
    expect(canDecreaseDecimals({ decimals: 0 })).toBe(false);
    expect(canDecreaseDecimals(undefined)).toBe(false);
    expect(canDecreaseDecimals({ decimals: 1 })).toBe(true);
  });
});

describe('round-trip', () => {
  it('increase then decrease restores the original count', () => {
    const start: CellFormat = { numberFormat: 'Number', decimals: 4 };
    expect(decreaseDecimals(increaseDecimals(start))).toMatchObject({ decimals: 4 });
  });
});
