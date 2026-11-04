import { describe, expect, it } from 'vitest';
import {
  parseCSV,
  parseJSONRecords,
  applyStep,
  applySteps,
  stepLabel,
  tableToGrid,
  type PQTable,
} from './powerQuery';

const SAMPLE: PQTable = {
  headers: ['Name', 'Age', 'City'],
  rows: [
    ['Alice', '30', 'NYC'],
    ['Bob', '25', 'LA'],
    ['Alice', '30', 'NYC'],
    ['Cara', '35', 'NYC'],
  ],
};

describe('parseCSV', () => {
  it('parses a simple csv', () => {
    const t = parseCSV('a,b,c\n1,2,3\n4,5,6');
    expect(t.headers).toEqual(['a', 'b', 'c']);
    expect(t.rows).toEqual([['1', '2', '3'], ['4', '5', '6']]);
  });
  it('handles quoted commas and escaped quotes', () => {
    const t = parseCSV('name,note\n"Smith, John","said ""hi"""\n');
    expect(t.rows[0]).toEqual(['Smith, John', 'said "hi"']);
  });
  it('skips blank lines and names empty headers', () => {
    const t = parseCSV('\n, b\n1,2\n\n');
    expect(t.headers[0]).toBe('Column1');
    expect(t.rows).toEqual([['1', '2']]);
  });
  it('returns empty table for empty input', () => {
    expect(parseCSV('   \n  ')).toEqual({ headers: [], rows: [] });
  });
});

describe('parseJSONRecords', () => {
  it('parses an array of objects', () => {
    const t = parseJSONRecords('[{"a":1,"b":"x"},{"a":2}]');
    expect(t.headers).toEqual(['a', 'b']);
    expect(t.rows).toEqual([['1', 'x'], ['2', '']]);
  });
  it('unwraps {data:[...]}', () => {
    const t = parseJSONRecords('{"data":[{"x":1}]}');
    expect(t.headers).toEqual(['x']);
  });
  it('throws on invalid json', () => {
    expect(() => parseJSONRecords('nope')).toThrow('Invalid JSON');
  });
});

describe('applyStep', () => {
  it('filters rows', () => {
    const t = applyStep(SAMPLE, { kind: 'filter', column: 'City', op: 'eq', value: 'NYC' });
    expect(t.rows).toHaveLength(3);
  });
  it('filters with contains (case-insensitive)', () => {
    const t = applyStep(SAMPLE, { kind: 'filter', column: 'Name', op: 'contains', value: 'al' });
    expect(t.rows.map((r) => r[0]).sort()).toEqual(['Alice', 'Alice']);
  });
  it('filters numerically with gt', () => {
    const t = applyStep(SAMPLE, { kind: 'filter', column: 'Age', op: 'gt', value: '28' });
    expect(t.rows).toHaveLength(3);
  });
  it('selects columns', () => {
    const t = applyStep(SAMPLE, { kind: 'select', columns: ['City', 'Name'] });
    expect(t.headers).toEqual(['City', 'Name']);
    expect(t.rows[0]).toEqual(['NYC', 'Alice']);
  });
  it('renames a column', () => {
    const t = applyStep(SAMPLE, { kind: 'rename', from: 'City', to: 'Town' });
    expect(t.headers).toContain('Town');
  });
  it('converts type to number', () => {
    const t = applyStep(SAMPLE, { kind: 'setType', column: 'Age', type: 'number' });
    expect(t.rows[0][1]).toBe('30');
  });
  it('removes duplicates', () => {
    const t = applyStep(SAMPLE, { kind: 'removeDuplicates', columns: [] });
    expect(t.rows).toHaveLength(3);
  });
  it('sorts ascending and descending', () => {
    const asc = applyStep(SAMPLE, { kind: 'sort', column: 'Age', dir: 'asc' });
    expect(asc.rows[0][1]).toBe('25');
    const desc = applyStep(SAMPLE, { kind: 'sort', column: 'Age', dir: 'desc' });
    expect(desc.rows[0][1]).toBe('35');
  });
  it('throws on unknown column', () => {
    expect(() => applyStep(SAMPLE, { kind: 'filter', column: 'Nope', op: 'eq', value: 'x' })).toThrow('Unknown column');
  });
});

describe('applySteps + labels', () => {
  it('chains steps', () => {
    const t = applySteps(SAMPLE, [
      { kind: 'removeDuplicates', columns: [] },
      { kind: 'sort', column: 'Name', dir: 'asc' },
    ]);
    expect(t.rows.map((r) => r[0])).toEqual(['Alice', 'Bob', 'Cara']);
  });
  it('labels every step kind', () => {
    expect(stepLabel({ kind: 'filter', column: 'A', op: 'eq', value: '1' })).toContain('Filter');
    expect(stepLabel({ kind: 'select', columns: ['A'] })).toContain('Keep columns');
    expect(stepLabel({ kind: 'rename', from: 'A', to: 'B' })).toContain('Rename');
    expect(stepLabel({ kind: 'setType', column: 'A', type: 'text' })).toContain('Set');
    expect(stepLabel({ kind: 'removeDuplicates', columns: [] })).toContain('Remove duplicates');
    expect(stepLabel({ kind: 'sort', column: 'A', dir: 'desc' })).toContain('Sort');
  });
  it('tableToGrid includes header row', () => {
    expect(tableToGrid(SAMPLE)[0]).toEqual(['Name', 'Age', 'City']);
    expect(tableToGrid(SAMPLE)).toHaveLength(5);
  });
});
