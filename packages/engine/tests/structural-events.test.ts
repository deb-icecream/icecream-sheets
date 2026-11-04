import { describe, expect, it } from 'vitest';
import {
  EngineHost,
  EngineWorkbook,
  scalar,
  type CellRef,
  type EngineEvent,
} from '../src/index.js';

const c = (sheet: string, row: number, col: number): CellRef => ({ sheet, row, col });

type CellsChanged = Extract<EngineEvent, { type: 'cellsChanged' }>;
const isCellsChanged = (e: EngineEvent): e is CellsChanged => e.type === 'cellsChanged';

function trackedHost(data?: Record<string, unknown[][]>): { host: EngineHost; events: EngineEvent[] } {
  const host = new EngineHost(data ? new EngineWorkbook(data) : undefined);
  const events: EngineEvent[] = [];
  host.subscribe((e) => events.push(e));
  return { host, events };
}

const key = (r: number, col: number) => `${r}:${col}`;
const refKeys = (e: CellsChanged) => new Set(e.refs.map((r) => key(r.row, r.col)));

describe('D-NEW-1: structural ops emit cellsChanged (local/in-process repaint)', () => {
  it('insertRows emits exactly one cellsChanged covering the shifted range', () => {
    const { host, events } = trackedHost({ Sheet1: [[1], [2], [3]] });
    expect(host.execute({ cmd: 'insertRows', sheet: 'Sheet1', row: 1, count: 1 })).toEqual({ ok: true });
    const changed = events.filter(isCellsChanged);
    expect(changed).toHaveLength(1);
    const have = refKeys(changed[0]!);
    // Post-op used range is rows 0..3: rows 1..3 are the inserted + shifted cells.
    expect(have.has(key(1, 0))).toBe(true);
    expect(have.has(key(2, 0))).toBe(true);
    expect(have.has(key(3, 0))).toBe(true);
    // The shift actually happened (op semantics unchanged).
    expect(host.readCell(c('Sheet1', 0, 0))).toEqual(scalar(1));
    expect(host.readCell(c('Sheet1', 1, 0))).toEqual(scalar(null));
    expect(host.readCell(c('Sheet1', 2, 0))).toEqual(scalar(2));
    expect(host.readCell(c('Sheet1', 3, 0))).toEqual(scalar(3));
    host.dispose();
  });

  it('deleteRows emits cellsChanged covering the removed + shifted range', () => {
    const { host, events } = trackedHost({ Sheet1: [[1], [2], [3]] });
    expect(host.execute({ cmd: 'deleteRows', sheet: 'Sheet1', row: 1, count: 1 })).toEqual({ ok: true });
    const changed = events.filter(isCellsChanged);
    expect(changed).toHaveLength(1);
    const have = refKeys(changed[0]!);
    // Pre-op rows 1..2 must be covered (removed row 1 + shifted row 2),
    // post-op rows 1..1 as well.
    expect(have.has(key(1, 0))).toBe(true);
    expect(have.has(key(2, 0))).toBe(true);
    expect(host.readCell(c('Sheet1', 0, 0))).toEqual(scalar(1));
    expect(host.readCell(c('Sheet1', 1, 0))).toEqual(scalar(3));
    host.dispose();
  });

  it('insertCols emits cellsChanged covering the shifted columns', () => {
    const { host, events } = trackedHost({
      Sheet1: [
        [1, 2],
        [3, 4],
      ],
    });
    expect(host.execute({ cmd: 'insertCols', sheet: 'Sheet1', col: 1, count: 1 })).toEqual({ ok: true });
    const changed = events.filter(isCellsChanged);
    expect(changed).toHaveLength(1);
    const have = refKeys(changed[0]!);
    // Post-op used range is cols 0..2: cols 1..2 on both rows are shifted/inserted.
    expect(have.has(key(0, 1))).toBe(true);
    expect(have.has(key(0, 2))).toBe(true);
    expect(have.has(key(1, 1))).toBe(true);
    expect(have.has(key(1, 2))).toBe(true);
    expect(host.readCell(c('Sheet1', 0, 0))).toEqual(scalar(1));
    expect(host.readCell(c('Sheet1', 0, 1))).toEqual(scalar(null));
    expect(host.readCell(c('Sheet1', 0, 2))).toEqual(scalar(2));
    host.dispose();
  });

  it('deleteCols emits cellsChanged covering the removed + shifted columns', () => {
    const { host, events } = trackedHost({
      Sheet1: [
        [1, 2],
        [3, 4],
      ],
    });
    expect(host.execute({ cmd: 'deleteCols', sheet: 'Sheet1', col: 0, count: 1 })).toEqual({ ok: true });
    const changed = events.filter(isCellsChanged);
    expect(changed).toHaveLength(1);
    const have = refKeys(changed[0]!);
    // Pre-op cols 0..1 must be covered (removed col 0 + shifted col 1).
    expect(have.has(key(0, 0))).toBe(true);
    expect(have.has(key(0, 1))).toBe(true);
    expect(have.has(key(1, 0))).toBe(true);
    expect(have.has(key(1, 1))).toBe(true);
    expect(host.readCell(c('Sheet1', 0, 0))).toEqual(scalar(2));
    expect(host.readCell(c('Sheet1', 1, 0))).toEqual(scalar(4));
    host.dispose();
  });

  it('structural op on an empty sheet still emits cellsChanged (repaint signal)', () => {
    const { host, events } = trackedHost();
    expect(host.execute({ cmd: 'insertRows', sheet: 'Sheet1', row: 0, count: 1 })).toEqual({ ok: true });
    const changed = events.filter(isCellsChanged);
    expect(changed).toHaveLength(1);
    expect(changed[0]!.refs).toEqual([]);
    host.dispose();
  });
});
