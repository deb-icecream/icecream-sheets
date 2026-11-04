/**
 * Headless tests for the connected-data-source web feature module.
 * Exercises engine materialization (write/refresh) against a real
 * EngineHost plus the pure sheet-name/binding helpers.
 */
import { describe, expect, it } from 'vitest';
import { EngineHost } from '@icecream-sheets/engine';
import {
  makeTableData,
  planSheetRefresh,
} from '@icecream-sheets/service/connectors';
import {
  applyRefreshPlan,
  bindingForSheet,
  sanitizeSheetName,
  timeAgo,
  uniqueSheetName,
  writeTableToNewSheet,
} from './dataSources';

function cellMap(host: EngineHost, sheet: string): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const s of host.snapshot().sheets) {
    if (s.name !== sheet) continue;
    for (const c of s.cells) m.set(`${c.ref.row}:${c.ref.col}`, c.input);
  }
  return m;
}

describe('sanitizeSheetName', () => {
  it('strips illegal characters', () => {
    expect(sanitizeSheetName('a/b\\c?d*e[f]g:h')).toBe('a b c d e f g h');
  });

  it('truncates to 31 chars and falls back', () => {
    expect(sanitizeSheetName('x'.repeat(40))).toHaveLength(31);
    expect(sanitizeSheetName('   ')).toBe('Data');
    expect(sanitizeSheetName('')).toBe('Data');
  });
});

describe('uniqueSheetName', () => {
  it('returns the base when free and increments on collision', () => {
    expect(uniqueSheetName(['A'], 'Sales')).toBe('Sales');
    expect(uniqueSheetName(['Sales'], 'Sales')).toBe('Sales 2');
    expect(uniqueSheetName(['Sales', 'Sales 2'], 'Sales')).toBe('Sales 3');
  });
});

describe('bindingForSheet / timeAgo', () => {
  it('finds bindings by sheet', () => {
    const bindings = [
      { id: 'a', sheetName: 'S1', spec: {} as never, lastRefresh: null, rowCount: 0, colCount: 0 },
    ];
    expect(bindingForSheet(bindings, 'S1')?.id).toBe('a');
    expect(bindingForSheet(bindings, 'S2')).toBeUndefined();
  });

  it('formats relative times', () => {
    expect(timeAgo(null)).toBe('never');
    expect(timeAgo(new Date(Date.now() - 30_000).toISOString())).toBe('30s ago');
    expect(timeAgo(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5m ago');
    expect(timeAgo(new Date(Date.now() - 3 * 3600_000).toISOString())).toBe('3h ago');
    expect(timeAgo(new Date(Date.now() - 2 * 86400_000).toISOString())).toBe('2d ago');
  });
});

describe('writeTableToNewSheet', () => {
  it('materializes header + data rows as a new sheet', async () => {
    const host = new EngineHost();
    await writeTableToNewSheet(host, 'Sales', makeTableData(['Name', 'Amt'], [['Al', 10], ['Bo', 20]]));
    const cells = cellMap(host, 'Sales');
    expect(cells.get('0:0')).toBe('Name');
    expect(cells.get('0:1')).toBe('Amt');
    expect(cells.get('1:0')).toBe('Al');
    expect(cells.get('1:1')).toBe(10);
    expect(cells.get('2:1')).toBe(20);
    expect(host.snapshot().sheets.map((s) => s.name)).toContain('Sales');
  });

  it('throws when the sheet already exists', async () => {
    const host = new EngineHost();
    await writeTableToNewSheet(host, 'Sales', makeTableData(['a'], [[1]]));
    await expect(writeTableToNewSheet(host, 'Sales', makeTableData(['a'], [[1]]))).rejects.toThrow(
      'already exists',
    );
  });
});

describe('applyRefreshPlan', () => {
  it('swaps data and clears the stale tail', async () => {
    const host = new EngineHost();
    const t1 = makeTableData(['a', 'b'], [[1, 2], [3, 4]]);
    await writeTableToNewSheet(host, 'S', t1);
    const t2 = makeTableData(['a'], [[9]]);
    const plan = planSheetRefresh(3, 2, t2);
    await applyRefreshPlan(host, 'S', plan);
    const cells = cellMap(host, 'S');
    expect(cells.get('0:0')).toBe('a');
    expect(cells.get('1:0')).toBe(9);
    // Cleared cells are dropped from the sparse snapshot entirely.
    expect(cells.get('0:1')).toBeUndefined();
    expect(cells.get('2:0')).toBeUndefined();
  });
});
