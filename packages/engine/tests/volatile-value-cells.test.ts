/**
 * Issue #67 — EngineWorkbook.getVolatileValueCells + serializeAckInput.
 *
 * The gateway's checkpoint/rehydrate checksum covers volatile-tainted
 * cells by input instead of value; the taint set must be exactly:
 * volatile-formula cells, cells referencing volatile defined names,
 * and their transitive dependents — nothing more (over-tainting would
 * needlessly drop value coverage; under-tainting reopens #67).
 */
import { describe, expect, it } from 'vitest';
import { EngineWorkbook, serializeAckInput, type CellRef } from '../src/index.js';

const keys = (refs: CellRef[]): string[] =>
  refs.map((r) => `${r.sheet}:${r.row}:${r.col}`).sort();

describe('getVolatileValueCells', () => {
  it('taints volatile cells and their transitive dependents only', () => {
    const wb = new EngineWorkbook({
      Sheet1: [[3, '=A1*2', '=A1+SECOND(NOW())', '=C1+1', '=D1*10', '=RAND()']],
    });
    // C1 (0,2) volatile; D1 (0,3) and E1 (0,4) depend on it transitively;
    // F1 (0,5) is RAND(); B1 (0,1) is a deterministic dependent of A1
    // and must NOT be tainted.
    expect(keys(wb.getVolatileValueCells())).toEqual([
      'Sheet1:0:2',
      'Sheet1:0:3',
      'Sheet1:0:4',
      'Sheet1:0:5',
    ]);
  });

  it('a volatile-free workbook has an empty taint set (legacy checksum identity)', () => {
    const wb = new EngineWorkbook({ Sheet1: [[1, '=A1+1', '=B1*2']] });
    expect(wb.getVolatileValueCells()).toEqual([]);
  });

  it('cells referencing a volatile defined name are tainted, with their dependents', () => {
    const wb = new EngineWorkbook(
      { Sheet1: [[1, '=Stamp+1', '=B1*2']] },
      { definedNames: [{ name: 'Stamp', ref: '=NOW()' }] },
    );
    // B1 references the volatile name; C1 depends on B1.
    expect(keys(wb.getVolatileValueCells())).toEqual(['Sheet1:0:1', 'Sheet1:0:2']);
  });

  it('a non-volatile defined name taints nothing', () => {
    const wb = new EngineWorkbook(
      { Sheet1: [[1, '=Rate*2']] },
      { definedNames: [{ name: 'Rate', ref: 'Sheet1!$A$1' }] },
    );
    expect(wb.getVolatileValueCells()).toEqual([]);
  });
});

describe('serializeAckInput', () => {
  it('serializes every CellInput shape under the IN: tag', () => {
    expect(serializeAckInput('=A1+SECOND(NOW())')).toBe('IN:s:17:=A1+SECOND(NOW())');
    expect(serializeAckInput('plain')).toBe('IN:s:5:plain');
    expect(serializeAckInput(42.5)).toBe('IN:n:42.5');
    expect(serializeAckInput(true)).toBe('IN:b:1');
    expect(serializeAckInput(false)).toBe('IN:b:0');
    expect(serializeAckInput(null)).toBe('IN:z:');
    expect(serializeAckInput(undefined)).toBe('IN:z:');
  });
});
