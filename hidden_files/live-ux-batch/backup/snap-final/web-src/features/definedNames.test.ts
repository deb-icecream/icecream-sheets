import { describe, expect, it } from 'vitest';
import {
  applyNamesToFormula,
  createNamesFromSelection,
  labelToName,
  parseRefersTo,
  refersToToNamedRange,
  validateDefineName,
  type DefineNameInput,
} from './definedNames';
import type { NamedRange } from './definedNames';

function named(name: string, sheet = 'Sheet1'): NamedRange {
  return { name, sheet, startRow: 0, startCol: 0, endRow: 9, endCol: 0 };
}

describe('validateDefineName', () => {
  it('accepts a valid definition', () => {
    const input: DefineNameInput = { name: 'Sales', scope: 'workbook', refersTo: '=Sheet1!$A$1:$A$10' };
    expect(validateDefineName(input, [])).toEqual({ ok: true });
  });

  it('rejects bad names', () => {
    expect(validateDefineName({ name: 'A1', scope: 'workbook', refersTo: '=A1' }, []).ok).toBe(false);
    expect(validateDefineName({ name: '', scope: 'workbook', refersTo: '=A1' }, []).ok).toBe(false);
    expect(validateDefineName({ name: 'has space', scope: 'workbook', refersTo: '=A1' }, []).ok).toBe(false);
  });

  it('rejects duplicates in the same scope only', () => {
    const existing = [named('Sales')];
    const dup = validateDefineName({ name: 'sales', scope: 'workbook', refersTo: '=A1' }, existing);
    expect(dup.ok).toBe(false);
    const otherScope = validateDefineName({ name: 'sales', scope: 'Sheet2', refersTo: '=A1' }, existing);
    expect(otherScope.ok).toBe(true);
  });

  it('rejects invalid refers-to', () => {
    const r = validateDefineName({ name: 'Sales', scope: 'workbook', refersTo: '=not a ref' }, []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('refersTo');
  });
});

describe('parseRefersTo', () => {
  it('parses sheet-qualified absolute ranges', () => {
    expect(parseRefersTo('=Sheet1!$A$1:$A$10')).toEqual({
      sheet: 'Sheet1',
      startRow: 0,
      startCol: 0,
      endRow: 9,
      endCol: 0,
    });
  });

  it('parses quoted sheet names and bare ranges', () => {
    expect(parseRefersTo("='My Sheet'!B2")).toEqual({ sheet: 'My Sheet', startRow: 1, startCol: 1, endRow: 1, endCol: 1 });
    expect(parseRefersTo('A1:A10')).toEqual({ sheet: null, startRow: 0, startCol: 0, endRow: 9, endCol: 0 });
  });

  it('rejects garbage', () => {
    expect(parseRefersTo('=SUM(A1)')).toBeNull();
    expect(parseRefersTo('')).toBeNull();
  });

  it('builds a NamedRange with the default sheet fallback', () => {
    const n = refersToToNamedRange('Sales', 'workbook', '=A1:A10', 'Sheet2');
    expect(n?.sheet).toBe('Sheet2');
    expect(n?.name).toBe('Sales');
    const scoped = refersToToNamedRange('Sales', 'Sheet2', '=A1', 'Sheet1');
    expect(scoped?.name).toBe('Sheet2!Sales');
  });
});

describe('applyNamesToFormula', () => {
  const names = [named('Sales'), { name: 'Tax_Rate', sheet: 'Sheet1', startRow: 0, startCol: 1, endRow: 0, endCol: 1 }];

  it('replaces A1 references with names', () => {
    expect(applyNamesToFormula('=SUM(A1:A10)*B1', names)).toBe('=SUM(Sales)*Tax_Rate');
  });

  it('replaces absolute and sheet-qualified spellings', () => {
    expect(applyNamesToFormula('=SUM($A$1:$A$10)', names)).toBe('=SUM(Sales)');
    expect(applyNamesToFormula('=SUM(Sheet1!A1:A10)', names)).toBe('=SUM(Sales)');
  });

  it('leaves string literals alone', () => {
    expect(applyNamesToFormula('=IF(SUM(A1:A10)>0,"A1:A10","no")', names)).toBe(
      '=IF(SUM(Sales)>0,"A1:A10","no")',
    );
  });

  it('does not replace partial tokens', () => {
    expect(applyNamesToFormula('=SUM(A1:A100)', names)).toBe('=SUM(A1:A100)');
  });

  it('is a no-op with no names', () => {
    expect(applyNamesToFormula('=A1+1', [])).toBe('=A1+1');
  });
});

describe('createNamesFromSelection', () => {
  it('creates names from header labels', () => {
    const out = createNamesFromSelection('Sheet1', [
      { label: 'Total Sales', startRow: 1, startCol: 0, endRow: 10, endCol: 0 },
      { label: 'Tax Rate', startRow: 1, startCol: 1, endRow: 10, endCol: 1 },
    ]);
    expect(out.map((n) => n.name)).toEqual(['Total_Sales', 'Tax_Rate']);
    expect(out[0].sheet).toBe('Sheet1');
  });

  it('dedupes colliding labels', () => {
    const out = createNamesFromSelection('Sheet1', [
      { label: 'Total', startRow: 1, startCol: 0, endRow: 5, endCol: 0 },
      { label: 'Total', startRow: 1, startCol: 1, endRow: 5, endCol: 1 },
    ]);
    expect(out.map((n) => n.name)).toEqual(['Total', 'Total_2']);
  });

  it('sanitizes labels into legal names', () => {
    expect(labelToName('  Net $ Profit!! ')).toBe('Net_Profit');
    expect(labelToName('2024')).toBe('_2024');
    expect(labelToName('')).toBe('Name');
  });
});
