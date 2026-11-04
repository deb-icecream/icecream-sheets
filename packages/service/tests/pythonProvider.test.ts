/**
 * Tests for the pinned-environment PythonProvider
 * (packages/service/src/python/provider.ts). Uses a fake run function —
 * no interpreter needed.
 */
import { describe, expect, it } from 'vitest';
import type { PythonResult } from '@icecream-sheets/engine';
import { PythonResultCache } from '../src/python/cache.js';
import { createPinnedPythonProvider, type PinnedPythonRun } from '../src/python/provider.js';

function fakeRun(impl: (code: string, args: unknown[]) => PythonResult): PinnedPythonRun {
  let calls = 0;
  const fn = ((code: string, args: unknown[]): PythonResult => {
    calls++;
    return impl(code, args);
  }) as PinnedPythonRun;
  fn.fingerprint = 'test-env-fingerprint';
  (fn as unknown as { calls: () => number }).calls = () => calls;
  return fn;
}

const callsOf = (run: PinnedPythonRun): number =>
  (run as unknown as { calls: () => number }).calls();

describe('createPinnedPythonProvider', () => {
  it('caches value results: identical (code, args) runs once', () => {
    const run = fakeRun(() => ({ value: 42 }));
    const provider = createPinnedPythonProvider(run, new PythonResultCache());
    expect(provider.run('result = 6*7', [])).toEqual({ value: 42 });
    expect(provider.run('result = 6*7', [])).toEqual({ value: 42 });
    expect(callsOf(run)).toBe(1);
  });

  it('misses the cache when code or args differ', () => {
    const run = fakeRun((code, args) => ({ value: `${code}:${JSON.stringify(args)}` }));
    const provider = createPinnedPythonProvider(run, new PythonResultCache());
    provider.run('result = 1', []);
    provider.run('result = 2', []);
    provider.run('result = 1', [9]);
    expect(callsOf(run)).toBe(3);
  });

  it('never caches errors', () => {
    let fail = true;
    const run = fakeRun(() => (fail ? { error: 'boom' } : { value: 7 }));
    const provider = createPinnedPythonProvider(run, new PythonResultCache());
    expect(provider.run('result = x', [])).toEqual({ error: 'boom' });
    fail = false;
    expect(provider.run('result = x', [])).toEqual({ value: 7 });
    expect(callsOf(run)).toBe(2);
  });

  it('passes plots through and caches them', () => {
    const run = fakeRun(() => ({ value: 1, plot: 'iVBORw0KGgoAAA' }));
    const provider = createPinnedPythonProvider(run, new PythonResultCache());
    const first = provider.run('result = 1', []);
    expect(first).toEqual({ value: 1, plot: 'iVBORw0KGgoAAA' });
    expect(provider.run('result = 1', [])).toEqual({ value: 1, plot: 'iVBORw0KGgoAAA' });
    expect(callsOf(run)).toBe(1);
  });

  it('executes but does not cache oversized plots', () => {
    const big = 'iVBORw0KGgo' + 'A'.repeat(300_000);
    const run = fakeRun(() => ({ value: 1, plot: big }));
    const provider = createPinnedPythonProvider(run, new PythonResultCache());
    expect(provider.run('result = 1', [])).toEqual({ value: 1, plot: big });
    expect(provider.run('result = 1', [])).toEqual({ value: 1, plot: big });
    expect(callsOf(run)).toBe(2);
  });

  it('reports non-serializable args as an error without running', () => {
    const run = fakeRun(() => ({ value: 1 }));
    const provider = createPinnedPythonProvider(run, new PythonResultCache());
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const r = provider.run('result = 1', [circular]);
    expect('error' in r).toBe(true);
    expect(callsOf(run)).toBe(0);
  });

  it('shares the cache across provider instances (warm host cache)', () => {
    const run = fakeRun(() => ({ value: 'v' }));
    const cache = new PythonResultCache();
    createPinnedPythonProvider(run, cache).run('result = 1', []);
    createPinnedPythonProvider(run, cache).run('result = 1', []);
    expect(callsOf(run)).toBe(1);
  });
});
