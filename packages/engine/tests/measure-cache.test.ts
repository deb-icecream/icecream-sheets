/**
 * Cycle 10 closure — edit-path optimization:
 *  (a) measureCalcChain measurement cache in EngineWorkbook, keyed by a
 *      graph version that bumps ONLY on formula/structural changes.
 *  (b) ack checksum primitives (ack-checksum.ts): deterministic
 *      serialization + FNV-1a 64 over the affected set.
 */
import { describe, expect, it } from 'vitest';
import {
  EngineWorkbook,
  computeAckChecksum,
  serializeAckValue,
  type CellRef,
  type TypedValue,
} from '../src/index.js';

const A1: CellRef = { sheet: 'Sheet1', row: 0, col: 0 };
const B1: CellRef = { sheet: 'Sheet1', row: 0, col: 1 };
const C1: CellRef = { sheet: 'Sheet1', row: 0, col: 2 };

function chainWb(): EngineWorkbook {
  // A1 input → B1 =A1+1 → C1 =B1+1 (single chain of length 2)
  return new EngineWorkbook({ Sheet1: [[1, '=A1+1', '=B1+1']] });
}

describe('measureCalcChain cache (a)', () => {
  it('repeat measurement of the same ref is a cache hit with identical results', () => {
    const wb = chainWb();
    const m1 = wb.measureCalcChain(A1, { maxNodes: 201 });
    const s1 = wb.calcChainCacheStats();
    expect(s1.misses).toBe(1);
    expect(s1.hits).toBe(0);
    const m2 = wb.measureCalcChain(A1, { maxNodes: 201 });
    const s2 = wb.calcChainCacheStats();
    expect(s2.hits).toBe(1);
    expect(s2.misses).toBe(1);
    expect(m2).toEqual(m1);
    expect(m2.shape).toBe('single-chain');
    expect(m2.chainLength).toBe(2);
  });

  it('a pure VALUE edit does NOT invalidate the cache', () => {
    const wb = chainWb();
    wb.measureCalcChain(A1, { maxNodes: 201 });
    const v0 = wb.calcChainCacheStats().graphVersion;
    wb.setCell(A1, 42); // value → value: graph unchanged
    expect(wb.calcChainCacheStats().graphVersion).toBe(v0);
    wb.measureCalcChain(A1, { maxNodes: 201 });
    expect(wb.calcChainCacheStats().hits).toBe(1);
  });

  it('a FORMULA change invalidates (setFormula on a dependent)', () => {
    const wb = chainWb();
    wb.measureCalcChain(A1, { maxNodes: 201 });
    const v0 = wb.calcChainCacheStats().graphVersion;
    wb.setFormula(B1, '=A1+10');
    expect(wb.calcChainCacheStats().graphVersion).toBeGreaterThan(v0);
    const hitsBefore = wb.calcChainCacheStats().hits;
    const m = wb.measureCalcChain(A1, { maxNodes: 201 });
    expect(wb.calcChainCacheStats().hits).toBe(hitsBefore); // miss, not hit
    expect(m.affectedCount).toBe(2);
  });

  it('overwriting a formula with a value invalidates; setCell with a formula string invalidates', () => {
    const wb = chainWb();
    wb.measureCalcChain(A1, { maxNodes: 201 });
    const v0 = wb.calcChainCacheStats().graphVersion;
    wb.setCell(B1, 7); // formula → value
    expect(wb.calcChainCacheStats().graphVersion).toBeGreaterThan(v0);
    const v1 = wb.calcChainCacheStats().graphVersion;
    wb.setCell(B1, '=A1+3'); // value → formula via setCell
    expect(wb.calcChainCacheStats().graphVersion).toBeGreaterThan(v1);
    // And the new graph is what gets measured + cached afterwards.
    const m = wb.measureCalcChain(A1, { maxNodes: 201 });
    expect(m.cells.map((r) => `${r.sheet}:${r.row}:${r.col}`)).toContain('Sheet1:0:1');
    wb.measureCalcChain(A1, { maxNodes: 201 });
    expect(wb.calcChainCacheStats().hits).toBeGreaterThan(0);
  });

  it('structural edits and defined-name changes invalidate', () => {
    const wb = chainWb();
    wb.measureCalcChain(A1, { maxNodes: 201 });
    let v = wb.calcChainCacheStats().graphVersion;
    wb.insertRows('Sheet1', 0, 1);
    expect(wb.calcChainCacheStats().graphVersion).toBeGreaterThan(v);
    v = wb.calcChainCacheStats().graphVersion;
    wb.deleteRows('Sheet1', 0, 1);
    expect(wb.calcChainCacheStats().graphVersion).toBeGreaterThan(v);
    v = wb.calcChainCacheStats().graphVersion;
    wb.addNamedExpression('MyConst', '=1');
    expect(wb.calcChainCacheStats().graphVersion).toBeGreaterThan(v);
    v = wb.calcChainCacheStats().graphVersion;
    wb.changeNamedExpression('MyConst', '=2');
    expect(wb.calcChainCacheStats().graphVersion).toBeGreaterThan(v);
    v = wb.calcChainCacheStats().graphVersion;
    wb.removeNamedExpression('MyConst');
    expect(wb.calcChainCacheStats().graphVersion).toBeGreaterThan(v);
    v = wb.calcChainCacheStats().graphVersion;
    wb.addSheet('Extra');
    expect(wb.calcChainCacheStats().graphVersion).toBeGreaterThan(v);
  });

  it('different maxNodes are different cache entries', () => {
    const wb = chainWb();
    wb.measureCalcChain(A1, { maxNodes: 201 });
    wb.measureCalcChain(A1); // uncapped: separate entry, a miss
    const s = wb.calcChainCacheStats();
    expect(s.misses).toBe(2);
    expect(s.entries).toBe(2);
  });
});

describe('ack checksum (b)', () => {
  const vals = (entries: Array<[CellRef, TypedValue]>): Map<string, TypedValue> =>
    new Map(entries.map(([r, v]) => [`${r.sheet}:${r.row}:${r.col}`, v]));
  const num = (n: number): TypedValue => ({ kind: 'number', value: n });

  it('is deterministic and order-independent over the affected set', () => {
    const a = computeAckChecksum([A1, B1, C1], vals([[A1, num(1)], [B1, num(2)], [C1, num(3)]]));
    const b = computeAckChecksum([C1, A1, B1], vals([[C1, num(3)], [B1, num(2)], [A1, num(1)]]));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('any value divergence changes the checksum', () => {
    const base = computeAckChecksum([A1, B1], vals([[A1, num(1)], [B1, num(2)]]));
    expect(computeAckChecksum([A1, B1], vals([[A1, num(1)], [B1, num(99)]]))).not.toBe(base);
    expect(computeAckChecksum([A1, B1], vals([[A1, num(1)], [B1, { kind: 'string', value: '2' }]]))).not.toBe(base);
    expect(computeAckChecksum([A1, B1], vals([[A1, num(1)], [B1, { kind: 'error', code: '#DIV/0!' }]]))).not.toBe(base);
    // A missing value serializes as empty — different from any real value.
    expect(computeAckChecksum([A1, B1], vals([[A1, num(1)]]))).not.toBe(base);
  });

  it('serializes kinds distinctly and length-prefixes strings', () => {
    expect(serializeAckValue(num(2))).toBe('n:2');
    expect(serializeAckValue({ kind: 'string', value: '2' })).toBe('s:1:2');
    expect(serializeAckValue({ kind: 'boolean', value: true })).toBe('b:1');
    expect(serializeAckValue({ kind: 'null', value: null })).toBe('z:');
    expect(serializeAckValue({ kind: 'error', code: '#N/A' })).toBe('e:#N/A');
    expect(serializeAckValue(undefined)).toBe('z:');
    // Separator bytes inside a string cannot alias another cell's line.
    const tricky: TypedValue = { kind: 'string', value: 'x\u0001y\u0002z' };
    expect(serializeAckValue(tricky)).toBe(`s:${'x\u0001y\u0002z'.length}:x\u0001y\u0002z`);
  });
});
