import { describe, expect, it } from 'vitest';
import {
  isValidName,
  quoteSheet,
  a1Range,
  parseA1Ref,
  substituteNames,
  type NamedRange,
} from './names';

function named(name: string, sheet = 'Sheet1'): NamedRange {
  return { name, sheet, startRow: 0, startCol: 0, endRow: 9, endCol: 0 };
}

// ---------------------------------------------------------------------------
// isValidName
// ---------------------------------------------------------------------------

describe('isValidName', () => {
  it('accepts plain names', () => {
    expect(isValidName('Sales')).toBe(true);
    expect(isValidName('sales_2024')).toBe(true);
    expect(isValidName('_total')).toBe(true);
    expect(isValidName('My.Name')).toBe(true);
  });

  it('rejects names starting with a digit or containing bad characters', () => {
    expect(isValidName('1Sales')).toBe(false);
    expect(isValidName('Sales Total')).toBe(false);
    expect(isValidName('Sales!')).toBe(false);
    expect(isValidName('')).toBe(false);
    expect(isValidName('-x')).toBe(false);
  });

  it('rejects A1-style cell references', () => {
    expect(isValidName('A1')).toBe(false);
    expect(isValidName('a1')).toBe(false);
    expect(isValidName('x1')).toBe(false);
    expect(isValidName('XFD1048576')).toBe(false);
    expect(isValidName('Z99')).toBe(false);
  });

  it('rejects R1C1-style references', () => {
    expect(isValidName('R1C1')).toBe(false);
    expect(isValidName('r12c5')).toBe(false);
  });

  it('accepts names that merely start like refs but are not refs', () => {
    expect(isValidName('A1B')).toBe(true);
    expect(isValidName('R1C')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// quoteSheet / a1Range
// ---------------------------------------------------------------------------

describe('quoteSheet', () => {
  it('leaves plain sheet names unquoted', () => {
    expect(quoteSheet('Sheet1')).toBe('Sheet1');
  });

  it('quotes sheet names with spaces', () => {
    expect(quoteSheet('My Sheet')).toBe("'My Sheet'");
  });

  it('doubles embedded single quotes', () => {
    expect(quoteSheet("O'Brien")).toBe("'O''Brien'");
  });
});

describe('a1Range', () => {
  it('builds a sheet-qualified range', () => {
    expect(a1Range(named('Sales'))).toBe('Sheet1!A1:A10');
  });

  it('renders a single cell without a colon', () => {
    const n: NamedRange = { name: 'X', sheet: 'S', startRow: 2, startCol: 1, endRow: 2, endCol: 1 };
    expect(a1Range(n)).toBe('S!B3');
  });

  it('quotes sheets with spaces', () => {
    expect(a1Range(named('Sales', 'My Sheet'))).toBe("'My Sheet'!A1:A10");
  });
});

// ---------------------------------------------------------------------------
// parseA1Ref
// ---------------------------------------------------------------------------

describe('parseA1Ref', () => {
  it('parses a single cell', () => {
    expect(parseA1Ref('A1')).toEqual({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
    expect(parseA1Ref('C5')).toEqual({ startRow: 4, startCol: 2, endRow: 4, endCol: 2 });
  });

  it('parses a range', () => {
    expect(parseA1Ref('A1:B10')).toEqual({ startRow: 0, startCol: 0, endRow: 9, endCol: 1 });
  });

  it('ignores $ absolute markers and whitespace', () => {
    expect(parseA1Ref(' $A$1 : $B$10 ')).toEqual({ startRow: 0, startCol: 0, endRow: 9, endCol: 1 });
  });

  it('is case-insensitive on column letters', () => {
    expect(parseA1Ref('a1:b2')).toEqual({ startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
  });

  it('handles multi-letter columns', () => {
    // AA = column 26 (0-based)
    expect(parseA1Ref('AA1')).toEqual({ startRow: 0, startCol: 26, endRow: 0, endCol: 26 });
  });

  it('normalizes inverted ranges', () => {
    expect(parseA1Ref('B10:A1')).toEqual({ startRow: 0, startCol: 0, endRow: 9, endCol: 1 });
  });

  it('rejects invalid syntax', () => {
    expect(parseA1Ref('')).toBeNull();
    expect(parseA1Ref('A')).toBeNull();
    expect(parseA1Ref('1A')).toBeNull();
    expect(parseA1Ref('A0')).toBeNull();
    expect(parseA1Ref('A1:B')).toBeNull();
    expect(parseA1Ref('Sheet1!A1')).toBeNull();
    expect(parseA1Ref('A1:B2:C3')).toBeNull();
  });

  it('rejects out-of-grid coordinates', () => {
    expect(parseA1Ref('A1048577')).toBeNull();
    expect(parseA1Ref('XFE1')).toBeNull(); // column 16384, one past XFD
  });
});

// ---------------------------------------------------------------------------
// substituteNames
// ---------------------------------------------------------------------------

describe('substituteNames', () => {
  it('replaces a name with its sheet-qualified ref', () => {
    expect(substituteNames('=SUM(Sales)', [named('Sales')])).toBe('=SUM(Sheet1!A1:A10)');
  });

  it('replaces multiple names', () => {
    const names = [named('Sales'), { ...named('Costs'), startCol: 1, endCol: 1 }];
    expect(substituteNames('=Sales-Costs', names)).toBe('=Sheet1!A1:A10-Sheet1!B1:B10');
  });

  it('only replaces whole-word occurrences', () => {
    expect(substituteNames('=SUM(SalesTotal)', [named('Sales')])).toBe('=SUM(SalesTotal)');
    expect(substituteNames('=Sales2+Sales', [named('Sales')])).toBe('=Sales2+Sheet1!A1:A10');
  });

  it('does not cascade substitutions', () => {
    // "B1" is not a valid name, so the substituted ref is left alone.
    expect(substituteNames('=Sales', [named('Sales'), named('B1')])).toBe('=Sheet1!A1:A10');
  });

  it('prefers the longest name on overlap', () => {
    const names = [named('Sales'), { ...named('SalesTotal'), startCol: 2, endCol: 2 }];
    expect(substituteNames('=SalesTotal+Sales', names)).toBe('=Sheet1!C1:C10+Sheet1!A1:A10');
  });

  it('quotes sheets with spaces in the substituted ref', () => {
    expect(substituteNames('=Sales', [named('Sales', 'My Sheet')])).toBe("='My Sheet'!A1:A10");
  });

  it('returns the formula unchanged when there are no names', () => {
    expect(substituteNames('=A1+B2', [])).toBe('=A1+B2');
  });

  it('skips invalid names', () => {
    expect(substituteNames('=A1', [{ ...named('A1') }])).toBe('=A1');
  });
});
