import { describe, expect, it } from 'vitest';
import { runJavaScript } from '../src/sandbox/javascript.js';

describe('runJavaScript', () => {
  it('evaluates arithmetic with args', () => {
    expect(runJavaScript('arg1 * 2', { arg1: 21 })).toEqual({ value: 42 });
  });

  it('exposes Math and JSON', () => {
    expect(runJavaScript('Math.floor(arg1) + JSON.parse("[1]")[0]', { arg1: 2.9 })).toEqual({
      value: 3,
    });
  });

  it('normalizes undefined completion to null', () => {
    expect(runJavaScript('let x = 1;', {})).toEqual({ value: null });
  });

  it('times out on an infinite loop', () => {
    const result = runJavaScript('while (true) { /* spin */ }', {}, { timeoutMs: 200 });
    expect(result).toHaveProperty('error');
    if ('error' in result) {
      expect(result.error).toMatch(/timed out/i);
    }
  });

  it('does not expose process', () => {
    const result = runJavaScript('process.exit(1)', {});
    expect(result).toHaveProperty('error');
  });

  it('does not expose require', () => {
    const result = runJavaScript('require("fs")', {});
    expect(result).toHaveProperty('error');
  });

  it('does not expose console or timers', () => {
    expect(runJavaScript('console.log("hi")', {})).toHaveProperty('error');
    expect(runJavaScript('setTimeout(() => 1, 10)', {})).toHaveProperty('error');
  });

  it('does not leak state between runs', () => {
    // args are deep-frozen in the guest; mutation throws, and each run gets
    // a fresh copy regardless.
    runJavaScript('args.x = 999', { x: 1 });
    expect(runJavaScript('args.x', { x: 1 })).toEqual({ value: 1 });
  });

  it('rejects non-JSON-serializable args', () => {
    const result = runJavaScript('1', { n: 10n });
    expect(result).toHaveProperty('error');
  });

  it('rejects a non-object args payload', () => {
    const result = runJavaScript('1', [1, 2, 3] as unknown as Record<string, unknown>);
    expect(result).toHaveProperty('error');
  });

  it('rejects invalid timeouts', () => {
    expect(runJavaScript('1', {}, { timeoutMs: -5 })).toHaveProperty('error');
  });
});
