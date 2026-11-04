/**
 * Tests for the CSV/TSV adapter: RFC 4180 parsing, delimiter detection,
 * and WorkbookData round-trips.
 */
import { describe, expect, it } from 'vitest';
import {
  CsvAdapter,
  TsvAdapter,
  detectDelimiter,
  parseCsv,
  stringifyCsv,
} from '../src/index.js';

describe('detectDelimiter', () => {
  it('detects comma', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
  });
  it('detects tab', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
  });
  it('detects semicolon', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
  });
  it('ignores delimiters inside quotes', () => {
    expect(detectDelimiter('"a,b",c\n1,2')).toBe(',');
  });
  it('falls back to comma for single-column data', () => {
    expect(detectDelimiter('hello\nworld')).toBe(',');
  });
});

describe('parseCsv', () => {
  it('parses simple rows', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });
  it('handles quoted fields with commas', () => {
    expect(parseCsv('"a,b",c')).toEqual([['a,b', 'c']]);
  });
  it('handles escaped quotes', () => {
    expect(parseCsv('"say ""hi""",ok')).toEqual([['say "hi"', 'ok']]);
  });
  it('handles embedded newlines in quotes', () => {
    expect(parseCsv('"line1\nline2",b')).toEqual([['line1\nline2', 'b']]);
  });
  it('handles CRLF line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
  it('strips BOM', () => {
    expect(parseCsv('\uFEFFa,b')).toEqual([['a', 'b']]);
  });
  it('handles empty fields', () => {
    expect(parseCsv('a,,c')).toEqual([['a', '', 'c']]);
  });
});

describe('stringifyCsv', () => {
  it('quotes fields containing the delimiter', () => {
    expect(stringifyCsv([['a,b', 'c']])).toBe('"a,b",c\r\n');
  });
  it('escapes quotes', () => {
    expect(stringifyCsv([['say "hi"']])).toBe('"say ""hi"""\r\n');
  });
  it('round-trips through parse', () => {
    const rows = [
      ['a', 'b,c', 'd"e', 'f\ng'],
      ['1', '2', '3', '4'],
    ];
    expect(parseCsv(stringifyCsv(rows))).toEqual(rows);
  });
});

describe('CsvAdapter', () => {
  const adapter = new CsvAdapter();

  it('reads CSV into WorkbookData', () => {
    const data = adapter.read(new TextEncoder().encode('name,age\nAlice,30\nBob,25\n'));
    expect(data.sheets).toHaveLength(1);
    expect(data.sheets[0].name).toBe('Sheet1');
    expect(data.sheets[0].rows).toEqual([
      ['name', 'age'],
      ['Alice', 30],
      ['Bob', 25],
    ]);
  });

  it('auto-detects TSV', () => {
    const data = adapter.read(new TextEncoder().encode('a\tb\n1\t2\n'));
    expect(data.sheets[0].rows).toEqual([
      ['a', 'b'],
      [1, 2],
    ]);
    expect(data.metadata['csv.delimiter']).toBe('\t');
  });

  it('writes WorkbookData to CSV', () => {
    const bytes = adapter.write({
      sheets: [{ name: 'S', rows: [['a', 'b'], [1, true]] }],
      metadata: {},
    });
    expect(new TextDecoder().decode(bytes)).toBe('a,b\r\n1,TRUE\r\n');
  });

  it('round-trips read -> write -> read', () => {
    const original = 'a,b,c\n1,2.5,TRUE\nx,,FALSE\n';
    const data = adapter.read(new TextEncoder().encode(original));
    const bytes = adapter.write(data);
    const data2 = adapter.read(bytes);
    expect(data2.sheets[0].rows).toEqual(data.sheets[0].rows);
  });

  it('respects explicit delimiter option', () => {
    const semi = new CsvAdapter({ delimiter: ';' });
    const data = semi.read(new TextEncoder().encode('a;b\n1;2\n'));
    expect(data.sheets[0].rows).toEqual([
      ['a', 'b'],
      [1, 2],
    ]);
  });

  it('has correct capabilities', () => {
    expect(adapter.capabilities.readable).toBe(true);
    expect(adapter.capabilities.writable).toBe(true);
    expect(adapter.capabilities.supportsEncryption).toBe(false);
  });
});

describe('TsvAdapter', () => {
  it('forces tab delimiter', () => {
    const tsv = new TsvAdapter();
    expect(tsv.name).toBe('tsv');
    const data = tsv.read(new TextEncoder().encode('a\tb\n1\t2'));
    expect(data.sheets[0].rows).toEqual([
      ['a', 'b'],
      [1, 2],
    ]);
  });
});
