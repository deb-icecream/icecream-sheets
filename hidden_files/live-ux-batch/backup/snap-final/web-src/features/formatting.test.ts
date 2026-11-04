/**
 * Tests for the cell formatting model v2 (formatting.ts): format cascade
 * (cell > range > column) and data-type metadata.
 * Pure functions — no engine needed.
 */
import { describe, expect, it } from 'vitest';
import {
  formatKey, columnKey, createFormatStore,
  getFormat, setFormat, setRangeFormat, setColumnFormat,
  clearFormat, clearRangeFormat, clearColumnFormat, clearSheetFormats,
  createDataTypeStore, setColumnDataTypes, getDataType, dataTypeToDefaultFormat,
  dataTypesToMetadata, dataTypesFromMetadata, DATATYPES_METADATA_KEY,
  formatNumber, formatToCSS,
  CELL_STYLE_PRESETS, CELL_STYLE_NAMES, BORDER_PRESETS,
  type FormatStore, type CellFormat,
} from './formatting';

describe('formatKey / columnKey', () => {
  it('builds unique keys', () => {
    expect(formatKey('Sheet1', 0, 0)).toBe('Sheet1:0:0');
    expect(formatKey('Sheet1', 1, 2)).not.toBe(formatKey('Sheet1', 2, 1));
    expect(columnKey('Sheet1', 3)).toBe('Sheet1:3');
    expect(columnKey('Sheet1', 3)).not.toBe(columnKey('Sheet2', 3));
  });
});

describe('cascade: getFormat resolution order', () => {
  it('returns undefined for unformatted cells', () => {
    const store = createFormatStore();
    expect(getFormat(store, 'S', 0, 0)).toBeUndefined();
  });

  it('cell beats range beats column', () => {
    let store = createFormatStore();
    store = setColumnFormat(store, 'S', 1, { numberFormat: 'Currency' });
    store = setRangeFormat(store, 'S', 0, 0, 5, 5, { numberFormat: 'Percentage' });
    store = setFormat(store, 'S', 2, 1, { numberFormat: 'Date' });
    // Cell-level wins
    expect(getFormat(store, 'S', 2, 1)?.numberFormat).toBe('Date');
    // Range-level wins over column (row 3, col 1 is in range + column)
    expect(getFormat(store, 'S', 3, 1)?.numberFormat).toBe('Percentage');
    // Column-level applies outside any range
    expect(getFormat(store, 'S', 9, 1)?.numberFormat).toBe('Currency');
    // No format outside all levels
    expect(getFormat(store, 'S', 9, 2)).toBeUndefined();
  });

  it('merges fields across levels (CSS-like)', () => {
    let store = createFormatStore();
    store = setColumnFormat(store, 'S', 1, { numberFormat: 'Currency' });
    store = setFormat(store, 'S', 0, 1, { bold: true });
    // Bold cell in a Currency column renders bold+Currency.
    expect(getFormat(store, 'S', 0, 1)).toEqual({ numberFormat: 'Currency', bold: true });
  });

  it('clearing a cell field falls through to range/column', () => {
    let store = createFormatStore();
    store = setColumnFormat(store, 'S', 1, { numberFormat: 'Currency', bold: true });
    store = setFormat(store, 'S', 0, 1, { numberFormat: 'Date' });
    expect(getFormat(store, 'S', 0, 1)?.numberFormat).toBe('Date');
    store = setFormat(store, 'S', 0, 1, { numberFormat: undefined });
    // numberFormat falls through to column; bold was never overridden.
    expect(getFormat(store, 'S', 0, 1)).toEqual({ numberFormat: 'Currency', bold: true });
  });

  it('later range entries win on overlap', () => {
    let store = createFormatStore();
    store = setRangeFormat(store, 'S', 0, 0, 10, 10, { numberFormat: 'Currency' });
    store = setRangeFormat(store, 'S', 5, 5, 15, 15, { numberFormat: 'Percentage' });
    expect(getFormat(store, 'S', 7, 7)?.numberFormat).toBe('Percentage');
    expect(getFormat(store, 'S', 2, 2)?.numberFormat).toBe('Currency');
  });
});

describe('setFormat (cell level)', () => {
  it('sets and merges partial formats', () => {
    let store = createFormatStore();
    store = setFormat(store, 'S', 0, 0, { bold: true });
    store = setFormat(store, 'S', 0, 0, { italic: true });
    expect(getFormat(store, 'S', 0, 0)).toEqual({ bold: true, italic: true });
  });

  it('removes the cell entry when the format becomes empty', () => {
    let store = createFormatStore();
    store = setFormat(store, 'S', 0, 0, { bold: true });
    store = setFormat(store, 'S', 0, 0, { bold: undefined });
    expect(store.cells.has(formatKey('S', 0, 0))).toBe(false);
    expect(getFormat(store, 'S', 0, 0)).toBeUndefined();
  });

  it('does not mutate the input store', () => {
    const store = createFormatStore();
    const next = setFormat(store, 'S', 0, 0, { bold: true });
    expect(store.cells.size).toBe(0);
    expect(next.cells.size).toBe(1);
  });
});

describe('setRangeFormat (range level, not exploded)', () => {
  it('stores ONE range entry, not per-cell entries', () => {
    let store = createFormatStore();
    store = setRangeFormat(store, 'S', 0, 0, 1, 2, { bold: true });
    expect(store.ranges).toHaveLength(1);
    expect(store.cells.size).toBe(0);
    expect(getFormat(store, 'S', 1, 2)).toEqual({ bold: true });
    expect(getFormat(store, 'S', 2, 2)).toBeUndefined();
  });

  it('merges into an existing entry for the exact same range', () => {
    let store = createFormatStore();
    store = setRangeFormat(store, 'S', 0, 0, 1, 1, { bold: true });
    store = setRangeFormat(store, 'S', 0, 0, 1, 1, { italic: true });
    expect(store.ranges).toHaveLength(1);
    expect(getFormat(store, 'S', 0, 0)).toEqual({ bold: true, italic: true });
  });

  it('cell overrides merge over the range', () => {
    let store = createFormatStore();
    store = setRangeFormat(store, 'S', 0, 0, 0, 1, { bold: true });
    store = setFormat(store, 'S', 0, 0, { italic: true });
    expect(getFormat(store, 'S', 0, 0)).toEqual({ bold: true, italic: true });
    expect(getFormat(store, 'S', 0, 1)).toEqual({ bold: true });
  });
});

describe('setColumnFormat', () => {
  it('stores ONE entry per column', () => {
    let store = createFormatStore();
    store = setColumnFormat(store, 'S', 3, { numberFormat: 'Currency' });
    expect(store.columns.size).toBe(1);
    expect(getFormat(store, 'S', 0, 3)?.numberFormat).toBe('Currency');
    expect(getFormat(store, 'S', 999, 3)?.numberFormat).toBe('Currency');
    expect(getFormat(store, 'S', 0, 4)).toBeUndefined();
  });

  it('merges with existing column format', () => {
    let store = createFormatStore();
    store = setColumnFormat(store, 'S', 3, { numberFormat: 'Currency' });
    store = setColumnFormat(store, 'S', 3, { bold: true });
    expect(getFormat(store, 'S', 0, 3)).toEqual({ numberFormat: 'Currency', bold: true });
  });

  it('clearColumnFormat removes the column entry', () => {
    let store = createFormatStore();
    store = setColumnFormat(store, 'S', 3, { numberFormat: 'Currency' });
    store = clearColumnFormat(store, 'S', 3);
    expect(getFormat(store, 'S', 0, 3)).toBeUndefined();
  });
});

describe('clear operations', () => {
  it('clearFormat removes only the cell level (range/column still apply)', () => {
    let store = createFormatStore();
    store = setColumnFormat(store, 'S', 1, { numberFormat: 'Currency' });
    store = setFormat(store, 'S', 0, 1, { bold: true });
    store = clearFormat(store, 'S', 0, 1);
    expect(getFormat(store, 'S', 0, 1)).toEqual({ numberFormat: 'Currency' });
  });

  it('clearRangeFormat removes overlapping ranges and cell entries, keeps columns', () => {
    let store = createFormatStore();
    store = setColumnFormat(store, 'S', 1, { numberFormat: 'Currency' });
    store = setRangeFormat(store, 'S', 0, 0, 5, 5, { bold: true });
    store = setRangeFormat(store, 'S', 10, 10, 12, 12, { italic: true });
    store = setFormat(store, 'S', 1, 1, { underline: true });
    store = clearRangeFormat(store, 'S', 0, 0, 6, 6);
    // Overlapping range entry removed; disjoint one kept.
    expect(store.ranges).toHaveLength(1);
    // Cell entry inside cleared.
    expect(getFormat(store, 'S', 1, 1)).toEqual({ numberFormat: 'Currency' });
    // Column format survives.
    expect(getFormat(store, 'S', 0, 1)).toEqual({ numberFormat: 'Currency' });
  });

  it('clearSheetFormats removes all three levels for the sheet only', () => {
    let store = createFormatStore();
    store = setFormat(store, 'S1', 0, 0, { bold: true });
    store = setRangeFormat(store, 'S1', 0, 0, 2, 2, { italic: true });
    store = setColumnFormat(store, 'S1', 1, { numberFormat: 'Currency' });
    store = setFormat(store, 'S2', 0, 0, { bold: true });
    store = setColumnFormat(store, 'S2', 1, { numberFormat: 'Currency' });
    store = clearSheetFormats(store, 'S1');
    expect(getFormat(store, 'S1', 0, 0)).toBeUndefined();
    expect(getFormat(store, 'S1', 0, 1)).toBeUndefined();
    expect(store.ranges).toHaveLength(0);
    expect(getFormat(store, 'S2', 0, 0)).toEqual({ bold: true });
    expect(getFormat(store, 'S2', 0, 1)?.numberFormat).toBe('Currency');
  });
});

describe('data type metadata', () => {
  it('seeds column types and resolves them', () => {
    let store = createDataTypeStore();
    store = setColumnDataTypes(store, 'S', ['text', 'number', 'date']);
    expect(getDataType(store, 'S', 0, 0)).toBe('text');
    expect(getDataType(store, 'S', 5, 1)).toBe('number');
    expect(getDataType(store, 'S', 99, 2)).toBe('date');
    expect(getDataType(store, 'S', 0, 3)).toBe('unknown');
  });

  it('maps types to default formats', () => {
    expect(dataTypeToDefaultFormat('date')).toBe('Date');
    expect(dataTypeToDefaultFormat('currency')).toBe('Currency');
    expect(dataTypeToDefaultFormat('number')).toBeUndefined();
    expect(dataTypeToDefaultFormat('text')).toBeUndefined();
    expect(dataTypeToDefaultFormat('unknown')).toBeUndefined();
  });

  it('round-trips through metadata (save/reopen)', () => {
    let store = createDataTypeStore();
    store = setColumnDataTypes(store, 'Sheet1', ['currency', 'date', 'text']);
    store = {
      columns: store.columns,
      ranges: [...store.ranges, { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 5, endCol: 0, type: 'number' }],
    };
    const meta = dataTypesToMetadata(store);
    expect(meta).toBeDefined();
    const restored = dataTypesFromMetadata(meta);
    expect(getDataType(restored, 'Sheet1', 0, 0)).toBe('number'); // range wins
    expect(getDataType(restored, 'Sheet1', 9, 0)).toBe('currency'); // column
    expect(getDataType(restored, 'Sheet1', 0, 1)).toBe('date');
    expect(getDataType(restored, 'Sheet1', 0, 2)).toBe('text');
  });

  it('returns empty store for corrupt metadata', () => {
    expect(getDataType(dataTypesFromMetadata(null), 'S', 0, 0)).toBe('unknown');
    expect(getDataType(dataTypesFromMetadata({ columns: { 'S:0': 'bogus' } }), 'S', 0, 0)).toBe('unknown');
    expect(getDataType(dataTypesFromMetadata({ ranges: [{ sheet: 'S' }] }), 'S', 0, 0)).toBe('unknown');
  });

  it('serializes to undefined when empty', () => {
    expect(dataTypesToMetadata(createDataTypeStore())).toBeUndefined();
  });
});

describe('formatNumber', () => {
  it('formats General as plain string', () => {
    expect(formatNumber(1234.5, 'General')).toBe('1234.5');
  });

  it('formats Number with commas and decimals', () => {
    expect(formatNumber(1234567.891, 'Number')).toBe('1,234,567.89');
  });

  it('formats Currency with $', () => {
    expect(formatNumber(1234.5, 'Currency')).toBe('$1,234.50');
  });

  it('formats Accounting with parens for negatives', () => {
    // Excel Accounting: symbol left-aligned (space), negatives in parens.
    expect(formatNumber(-1234.5, 'Accounting')).toBe('($ 1,234.50)');
    expect(formatNumber(1234.5, 'Accounting')).toBe('$ 1,234.50');
  });

  it('formats Percentage', () => {
    expect(formatNumber(0.1234, 'Percentage')).toBe('12.34%');
  });

  it('formats Scientific', () => {
    expect(formatNumber(12345, 'Scientific')).toBe('1.23e+4');
  });

  it('formats Date variants (Excel built-ins)', () => {
    // 2026-10-18 = serial 46313
    expect(formatNumber(46313, 'Date', 2, { dateVariant: 'mdyyyy' })).toBe('10/18/2026');
    expect(formatNumber(46313, 'Date', 2, { dateVariant: 'dmmmyy' })).toBe('18-Oct-26');
    expect(formatNumber(46313, 'Date', 2, { dateVariant: 'dmmm' })).toBe('18-Oct');
    expect(formatNumber(46313, 'Date', 2, { dateVariant: 'mmmyy' })).toBe('Oct-26');
    expect(formatNumber(46313.5, 'Date', 2, { dateVariant: 'mdyyyyhm' })).toBe('10/18/2026 12:00');
    // 45: mm:ss (minutes/seconds within the hour); 46: [h]:mm:ss (elapsed hours)
    expect(formatNumber(1 / 48, 'Date', 2, { dateVariant: 'mmss' })).toBe('30:00');
    expect(formatNumber(0.5, 'Date', 2, { dateVariant: 'hmmss' })).toBe('12:00:00');
    expect(formatNumber(1.5, 'Date', 2, { dateVariant: 'hmmss' })).toBe('36:00:00');
  });

  it('formats Time variants (Excel built-ins)', () => {
    expect(formatNumber(0.5, 'Time', 2, { timeVariant: 'hmmAMPM' })).toBe('12:00 PM');
    expect(formatNumber(0.5, 'Time', 2, { timeVariant: 'hmmssAMPM' })).toBe('12:00:00 PM');
    expect(formatNumber(0.5, 'Time', 2, { timeVariant: 'hmm' })).toBe('12:00');
    expect(formatNumber(0.5, 'Time', 2, { timeVariant: 'hmmss' })).toBe('12:00:00');
    expect(formatNumber(0.75, 'Time', 2, { timeVariant: 'hmmAMPM' })).toBe('6:00 PM');
  });

  it('formats Date default variant', () => {
    expect(formatNumber(46313, 'Date')).toBe('10/18/2026');
  });

  it('formats Fraction', () => {
    expect(formatNumber(0.5, 'Fraction')).toBe('1/2');
    expect(formatNumber(1.5, 'Fraction')).toBe('1 1/2');
  });

  it('formats Date from Excel serial', () => {
    // 44927 = 2023-01-01; locale-aware pads to mm/dd/yyyy
    expect(formatNumber(44927, 'Date')).toBe('01/01/2023');
  });

  it('formats Time from fractional day', () => {
    expect(formatNumber(0.5, 'Time')).toBe('12:00 PM');
    expect(formatNumber(0.25, 'Time')).toBe('6:00 AM');
  });

  it('handles booleans and empty', () => {
    expect(formatNumber(true, 'Number')).toBe('TRUE');
    expect(formatNumber('', 'Currency')).toBe('');
    expect(formatNumber(null, 'Currency')).toBe('');
  });

  it('respects custom decimals', () => {
    expect(formatNumber(0.0689037, 'Percentage', 1)).toBe('6.9%');
    expect(formatNumber(0.0689037, 'Percentage', 0)).toBe('7%');
    expect(formatNumber(1234.5678, 'Number', 3)).toBe('1,234.568');
  });
});

describe('formatToCSS', () => {
  it('returns empty object for undefined', () => {
    expect(formatToCSS(undefined)).toEqual({});
  });

  it('converts font fields', () => {
    const css = formatToCSS({ fontName: 'Arial', fontSize: 14, bold: true, italic: true });
    expect(css.fontFamily).toBe('Arial');
    expect(css.fontSize).toBe(14);
    expect(css.fontWeight).toBe('700');
    expect(css.fontStyle).toBe('italic');
  });

  it('combines underline and strikethrough', () => {
    const css = formatToCSS({ underline: true, strikethrough: true });
    expect(css.textDecoration).toContain('underline');
    expect(css.textDecoration).toContain('line-through');
  });

  it('converts colors and borders', () => {
    const css = formatToCSS({
      fontColor: '#ff0000',
      fillColor: '#00ff00',
      borders: { top: { style: 'thin', color: '#000' }, bottom: { style: 'double', color: '#111' } },
    });
    expect(css.color).toBe('#ff0000');
    expect(css.backgroundColor).toBe('#00ff00');
    expect(css.borderTop).toBe('1px solid #000');
    expect(css.borderBottom).toBe('3px double #111');
    expect(css.borderLeft).toBeUndefined();
  });

  it('converts alignment, wrap and indent', () => {
    const css = formatToCSS({ hAlign: 'center', vAlign: 'middle', wrapText: true, indent: 2 });
    expect(css.textAlign).toBe('center');
    expect(css.verticalAlign).toBe('middle');
    expect(css.whiteSpace).toBe('normal');
    expect(css.paddingLeft).toBe(28);
  });
});

describe('cell style presets', () => {
  it('has all expected style names', () => {
    for (const name of ['Normal', 'Good', 'Bad', 'Neutral', 'Heading 1', 'Title', 'Currency', 'Percent']) {
      expect(CELL_STYLE_NAMES).toContain(name);
    }
  });

  it('Good/Bad presets carry colors', () => {
    expect(CELL_STYLE_PRESETS['Good'].fontColor).toBeTruthy();
    expect(CELL_STYLE_PRESETS['Good'].fillColor).toBeTruthy();
    expect(CELL_STYLE_PRESETS['Bad'].fontColor).toBeTruthy();
  });

  it('currency preset sets number format', () => {
    expect(CELL_STYLE_PRESETS['Currency'].numberFormat).toBe('Currency');
    expect(CELL_STYLE_PRESETS['Percent'].numberFormat).toBe('Percentage');
  });
});

describe('border presets', () => {
  it('has 13 border options', () => {
    expect(BORDER_PRESETS).toHaveLength(13);
  });

  it('No Border clears borders', () => {
    expect(BORDER_PRESETS[0].apply).toEqual({});
  });

  it('All Borders sets four sides', () => {
    const b = BORDER_PRESETS.find((p) => p.name === 'All Borders')!.apply;
    expect(b.top).toBeTruthy();
    expect(b.bottom).toBeTruthy();
    expect(b.left).toBeTruthy();
    expect(b.right).toBeTruthy();
  });
});

describe('locale-aware formatting', () => {
  it('formats Currency per locale (USD vs EUR)', async () => {
    const { getLocalePreset } = await import('./locale');
    const us = getLocalePreset('en-US');
    const de = getLocalePreset('de-DE');
    expect(formatNumber(1234.5, 'Currency', 2, { locale: us })).toBe('$1,234.50');
    expect(formatNumber(1234.5, 'Currency', 2, { locale: de })).toBe('1.234,50 €');
  });

  it('formats Number separators per locale', async () => {
    const { getLocalePreset } = await import('./locale');
    const us = getLocalePreset('en-US');
    const de = getLocalePreset('de-DE');
    expect(formatNumber(1234567.891, 'Number', 2, { locale: us })).toBe('1,234,567.89');
    expect(formatNumber(1234567.891, 'Number', 2, { locale: de })).toBe('1.234.567,89');
  });

  it('formats Date order per locale (US vs EU vs ISO)', async () => {
    const { getLocalePreset } = await import('./locale');
    const us = getLocalePreset('en-US');
    const de = getLocalePreset('de-DE');
    const iso = getLocalePreset('iso');
    // 44927 = 2023-01-01
    expect(formatNumber(44927, 'Date', 2, { locale: us })).toBe('01/01/2023');
    expect(formatNumber(44927, 'Date', 2, { locale: de })).toBe('01.01.2023');
    expect(formatNumber(44927, 'Date', 2, { locale: iso })).toBe('2023-01-01');
  });

  it('explicit currency symbol overrides locale default', async () => {
    const { getLocalePreset } = await import('./locale');
    const de = getLocalePreset('de-DE');
    expect(formatNumber(1234.5, 'Currency', 2, { locale: de, currencySymbol: '£' })).toBe('1.234,50 £');
  });

  it('formats Percentage per locale', async () => {
    const { getLocalePreset } = await import('./locale');
    const de = getLocalePreset('de-DE');
    expect(formatNumber(0.1234, 'Percentage', 2, { locale: de })).toBe('12,34%');
  });
});

describe('Special formats', () => {
  it('formats Zip Code', () => {
    expect(formatNumber(90210, 'Special', 2, { specialKind: 'zip' })).toBe('90210');
    expect(formatNumber(123, 'Special', 2, { specialKind: 'zip' })).toBe('00123');
  });

  it('formats Zip+4', () => {
    expect(formatNumber(902101234, 'Special', 2, { specialKind: 'zip4' })).toBe('90210-1234');
  });

  it('formats Phone Number', () => {
    expect(formatNumber(5551234567, 'Special', 2, { specialKind: 'phone' })).toBe('(555) 123-4567');
  });

  it('formats SSN', () => {
    expect(formatNumber(123456789, 'Special', 2, { specialKind: 'ssn' })).toBe('123-45-6789');
  });
});

describe('negative styles', () => {
  it('formats negatives with parens', () => {
    expect(formatNumber(-1234.5, 'Number', 2, { negativeStyle: 'parens' })).toBe('(1,234.50)');
    expect(formatNumber(-1234.5, 'Currency', 2, { negativeStyle: 'parens' })).toBe('($1,234.50)');
  });

  it('formats negatives with minus by default', () => {
    expect(formatNumber(-1234.5, 'Number', 2)).toBe('-1,234.50');
  });
});

describe('numberFormatToCode (D4 save path)', () => {
  it('maps Percentage with default 2 decimals to 0.00% (the D4 case)', async () => {
    const { numberFormatToCode } = await import('./formatting');
    expect(numberFormatToCode({ numberFormat: 'Percentage' })).toBe('0.00%');
    expect(numberFormatToCode({ numberFormat: 'Percentage', decimals: 0 })).toBe('0%');
    expect(numberFormatToCode({ numberFormat: 'Percentage', decimals: 1 })).toBe('0.0%');
  });
  it('maps the other categories', async () => {
    const { numberFormatToCode } = await import('./formatting');
    expect(numberFormatToCode({ numberFormat: 'Number' })).toBe('#,##0.00');
    expect(numberFormatToCode({ numberFormat: 'Number', decimals: 0 })).toBe('#,##0');
    expect(numberFormatToCode({ numberFormat: 'Currency' })).toBe('"$"#,##0.00');
    expect(numberFormatToCode({ numberFormat: 'Currency', currencySymbol: '€' })).toBe('"€"#,##0.00');
    expect(numberFormatToCode({ numberFormat: 'Scientific' })).toBe('0.00E+00');
    expect(numberFormatToCode({ numberFormat: 'Text' })).toBe('@');
    expect(numberFormatToCode({ numberFormat: 'Date' })).toBe('m/d/yyyy');
    expect(numberFormatToCode({ numberFormat: 'General' })).toBeUndefined();
  });
  it('category wins over an imported formatCode; bare code passes through', async () => {
    const { numberFormatToCode } = await import('./formatting');
    expect(numberFormatToCode({ formatCode: '#,##0' })).toBe('#,##0');
    expect(numberFormatToCode({ formatCode: '#,##0', numberFormat: 'Percentage' })).toBe('0.00%');
    expect(numberFormatToCode({ bold: true })).toBeUndefined();
  });
});

describe('expandFormatStore (D4 save path)', () => {
  it('resolves cell > range > column into per-cell formats', async () => {
    const { expandFormatStore } = await import('./formatting');
    let store = createFormatStore();
    store = setColumnFormat(store, 'S', 1, { numberFormat: 'Currency' });
    store = setRangeFormat(store, 'S', 0, 0, 1, 1, { italic: true });
    store = setFormat(store, 'S', 0, 1, { bold: true });
    const out = expandFormatStore(store, 'S', 2);
    // (0,1): column + range + cell merged.
    expect(out.get('S:0:1')).toEqual({ numberFormat: 'Currency', italic: true, bold: true });
    // (2,1): column only, expanded to endRow.
    expect(out.get('S:2:1')).toEqual({ numberFormat: 'Currency' });
    // (0,0): range only.
    expect(out.get('S:0:0')).toEqual({ italic: true });
    // Untouched cell absent.
    expect(out.get('S:2:2')).toBeUndefined();
    // Other sheets untouched.
    expect(expandFormatStore(store, 'Other', 2).size).toBe(0);
  });
  it('includes explicit entries beyond endRow (formatted empty cells)', async () => {
    const { expandFormatStore } = await import('./formatting');
    let store = createFormatStore();
    store = setFormat(store, 'S', 40, 0, { bold: true });
    const out = expandFormatStore(store, 'S', 3);
    expect(out.get('S:40:0')).toEqual({ bold: true });
  });
});
