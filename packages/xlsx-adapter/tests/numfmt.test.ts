/**
 * Excel number-format import + render (numfmt.ts).
 *
 * Covers: styles.xml -> numFmtId -> formatCode mapping through SheetJS's
 * cell.z (built-in IDs 0-163 and custom <numFmt> entries), per-cell format
 * extraction on read, and the format-code interpreter used for rendering.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  XlsxAdapter,
  cellFormatCode,
  formatWithCode,
  GENERAL_FORMAT_CODE,
} from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_FILE = join(HERE, '..', '..', '..', 'test-data', 'real-world', 'compressexcel-saas-3statement.xlsx');

describe('cellFormatCode', () => {
  it('returns undefined for General, empty, and missing codes', () => {
    expect(cellFormatCode(undefined)).toBeUndefined();
    expect(cellFormatCode(null)).toBeUndefined();
    expect(cellFormatCode({})).toBeUndefined();
    expect(cellFormatCode({ z: '' })).toBeUndefined();
    expect(cellFormatCode({ z: 'General' })).toBeUndefined();
  });
  it('passes real format codes through', () => {
    expect(cellFormatCode({ z: '0.0%' })).toBe('0.0%');
    expect(cellFormatCode({ z: '#,##0' })).toBe('#,##0');
    expect(cellFormatCode({ z: 'm/d/yyyy' })).toBe('m/d/yyyy');
  });
  it('GENERAL_FORMAT_CODE is "General"', () => {
    expect(GENERAL_FORMAT_CODE).toBe('General');
  });
});

describe('formatWithCode', () => {
  it('renders percent with sections (positive;negative;zero)', () => {
    const code = '0.0%;\\(0.0%\\);\\-';
    expect(formatWithCode(0.0689037, code)).toBe('6.9%');
    expect(formatWithCode(-0.0689037, code)).toBe('(6.9%)');
    expect(formatWithCode(0, code)).toBe('-');
  });
  it('renders currency with sections', () => {
    const code = '\\$#,##0;"($"#,##0\\);\\-';
    expect(formatWithCode(2082088.1744066, code)).toBe('$2,082,088');
    expect(formatWithCode(-2082088.1744066, code)).toBe('($2,082,088)');
    expect(formatWithCode(0, code)).toBe('-');
  });
  it('renders thousands separators and decimals', () => {
    expect(formatWithCode(2082088.1744066, '#,##0')).toBe('2,082,088');
    expect(formatWithCode(2082088.1744066, '#,##0.00')).toBe('2,082,088.17');
    expect(formatWithCode(1234.5, '$#,##0.00')).toBe('$1,234.50');
  });
  it('General matches Excel ~10 significant digits, not float noise', () => {
    expect(formatWithCode(2082088.1744066, undefined)).toBe('2082088.174');
    expect(formatWithCode(2082088.1744066, 'General')).toBe('2082088.174');
    expect(formatWithCode(42, undefined)).toBe('42');
    expect(formatWithCode(3.14, undefined)).toBe('3.14');
    expect(formatWithCode(0.1 + 0.2, undefined)).toBe('0.3');
  });
  it('General switches to scientific for very large/small magnitudes', () => {
    expect(formatWithCode(12345678901234, undefined)).toBe('1.23457E+13');
    expect(formatWithCode(0.000000123456, undefined)).toBe('1.23456E-07');
  });
  it('renders date codes from Excel serials', () => {
    expect(formatWithCode(45292, 'mm/dd/yyyy')).toBe('01/01/2024');
    expect(formatWithCode(45292, 'd-mmm-yy')).toBe('1-Jan-24');
  });
  it('renders fractions', () => {
    expect(formatWithCode(1.5, '# ?/?')).toBe('1 1/2');
  });
  it('renders scientific codes', () => {
    expect(formatWithCode(123456.789, '0.00E+00')).toBe('1.23E+05');
  });
  it('handles escaped literals, quoted literals, _ padding and * fill', () => {
    expect(formatWithCode(5, '0\\x')).toBe('5x');
    expect(formatWithCode(5, '0" units"')).toBe('5 units');
    // Excel renders _x as a space the width of x (alignment padding).
    expect(formatWithCode(5, '_-0_-')).toBe(' 5 ');
    expect(formatWithCode(5, '*-0')).toBe('5');
  });
  it('renders text-section codes without crashing', () => {
    // Text values are not routed through formatWithCode by the grid, but a
    // text placeholder code must still behave sanely on numbers.
    expect(typeof formatWithCode(5, '@')).toBe('string');
  });
  it('falls back to String(value) for unknown codes and non-finite values', () => {
    expect(formatWithCode(1.5, 'not-a-real-format-[[')).toBe('1.5');
    expect(formatWithCode(Infinity, '0.0%')).toBe('Infinity');
    expect(formatWithCode(NaN, '0.0%')).toBe('NaN');
  });
});

describe('XlsxAdapter number format import', () => {
  it('extracts per-cell format codes from the real-world workbook', () => {
    const data = new XlsxAdapter().read(new Uint8Array(readFileSync(REAL_FILE)));
    const dash = data.sheets.find((s) => s.name === 'DASHBOARD');
    expect(dash).toBeDefined();
    const formats = dash!.formats;
    expect(formats).toBeDefined();
    // DASHBOARD!B8 (row 7, col 1): style 49 -> numFmt 166.
    expect(formats!['7:1']).toBe('0.0%;\\(0.0%\\);\\-');
    // DASHBOARD!B7 (row 6, col 1): currency format.
    expect(formats!['6:1']).toBe('\\$#,##0;"($"#,##0\\);\\-');
    // D8 and H8 share the percent format.
    expect(formats!['7:3']).toBe('0.0%;\\(0.0%\\);\\-');
    expect(formats!['7:7']).toBe('0.0%;\\(0.0%\\);\\-');
  });
  it('renders the extracted codes to the expected display text', () => {
    const data = new XlsxAdapter().read(new Uint8Array(readFileSync(REAL_FILE)));
    const dash = data.sheets.find((s) => s.name === 'DASHBOARD')!;
    // Engine-equivalent values for the formula cells (cached literals).
    expect(formatWithCode(0.0689037471245626, dash.formats!['7:1'])).toBe('6.9%');
    expect(formatWithCode(2082088.1744066, dash.formats!['6:1'])).toBe('$2,082,088');
  });
  it('omits General cells and empty cells from the formats map', () => {
    const data = new XlsxAdapter().read(new Uint8Array(readFileSync(REAL_FILE)));
    for (const sheet of data.sheets) {
      for (const [key, code] of Object.entries(sheet.formats ?? {})) {
        expect(code).not.toBe('General');
        expect(code.length).toBeGreaterThan(0);
        const [r, c] = key.split(':').map(Number);
        expect(sheet.rows[r]![c]).not.toBeNull();
      }
    }
  });
  it('leaves formats undefined for workbooks without styled cells', () => {
    // Minimal workbook built by hand: no styles part at all.
    const wb = new XlsxAdapter();
    const bytes = wb.write({
      sheets: [{ name: 'S', rows: [[1, 2], [3, 4]] }],
      metadata: {},
    });
    const back = wb.read(bytes);
    expect(back.sheets[0]!.formats).toBeUndefined();
  });
});
