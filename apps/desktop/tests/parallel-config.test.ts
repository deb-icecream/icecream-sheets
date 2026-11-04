/**
 * Unit tests for the desktop parallel-recalculation pool sizing
 * (apps/desktop/src/parallel-config.ts).
 *
 * The pool must never be mis-sized into a broken state: a malformed
 * ICECREAM_PARALLEL_WORKERS override must fall back to the sane default
 * instead of disabling parallelism, and the default must always be >= 1.
 */
import { describe, expect, it } from 'vitest';
import {
  logicalCpuCount,
  resolveParallelWorkerCount,
} from '../src/parallel-config.js';

describe('resolveParallelWorkerCount', () => {
  it('defaults to logical CPUs minus one, minimum 1', () => {
    const n = resolveParallelWorkerCount({});
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBe(Math.max(1, logicalCpuCount() - 1));
  });

  it('honors a valid ICECREAM_PARALLEL_WORKERS override', () => {
    expect(resolveParallelWorkerCount({ ICECREAM_PARALLEL_WORKERS: '8' })).toBe(8);
    expect(resolveParallelWorkerCount({ ICECREAM_PARALLEL_WORKERS: '1' })).toBe(1);
  });

  it('floors fractional overrides', () => {
    expect(resolveParallelWorkerCount({ ICECREAM_PARALLEL_WORKERS: '3.9' })).toBe(3);
  });

  it('falls back to the default on malformed overrides', () => {
    const def = Math.max(1, logicalCpuCount() - 1);
    for (const bad of ['0', '-4', 'abc', '', 'NaN', '1e999']) {
      expect(resolveParallelWorkerCount({ ICECREAM_PARALLEL_WORKERS: bad })).toBe(def);
    }
  });
});

describe('logicalCpuCount', () => {
  it('reports at least 1', () => {
    expect(logicalCpuCount()).toBeGreaterThanOrEqual(1);
  });
});
