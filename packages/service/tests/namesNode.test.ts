/**
 * Tests for the Node-only named-function sandbox runtime
 * ('@icecream-sheets/service/names-node'): JS/TS/Python invocation,
 * timeouts, error propagation, and sandbox isolation.
 */
import { describe, expect, it } from 'vitest';
import { invokeNamedFunction, makeInvokeFn } from '../src/names/node.js';

describe('invokeNamedFunction — JavaScript', () => {
  it('binds params and returns the completion value', () => {
    expect(
      invokeNamedFunction({ language: 'javascript', source: 'x * 2', params: ['x'] }, [21]),
    ).toEqual({ value: 42 });
  });

  it('runs statement bodies', () => {
    const r = invokeNamedFunction(
      { language: 'javascript', source: 'const y = x + 1; y * 10;', params: ['x'] },
      [5],
    );
    expect(r).toEqual({ value: 60 });
  });

  it('propagates runtime errors instead of throwing', () => {
    const r = invokeNamedFunction(
      { language: 'javascript', source: 'nope.missing', params: ['x'] },
      [1],
    );
    expect('error' in r).toBe(true);
  });

  it('has no ambient authority (no process/require/fetch)', () => {
    for (const src of [
      'process.exit(1)',
      'require("fs")',
      'typeof fetch',
    ]) {
      const r = invokeNamedFunction({ language: 'javascript', source: src, params: [] }, []);
      // Either a ReferenceError (no such binding) or a harmless value for
      // `typeof fetch` (must be 'undefined', never a function).
      if ('error' in r) {
        expect(r.error).toMatch(/not defined|undefined/i);
      } else {
        expect(r.value).toBe('undefined');
      }
    }
  });

  it('times out infinite loops', () => {
    const r = invokeNamedFunction(
      { language: 'javascript', source: 'while (true) {}', params: [] },
      [],
      { timeoutMs: 200 },
    );
    expect('error' in r).toBe(true);
    expect((r as { error: string }).error).toMatch(/timed out/i);
  });

  it('rejects non-serializable args', () => {
    const r = invokeNamedFunction({ language: 'javascript', source: '1', params: [] }, [
      BigInt(1) as unknown as string,
    ]);
    expect('error' in r).toBe(true);
  });
});

describe('invokeNamedFunction — TypeScript', () => {
  it('strips erasable annotations then runs', () => {
    const r = invokeNamedFunction(
      { language: 'typescript', source: '(x: number): number => x * 3', params: ['x'] },
      [7],
    );
    // Arrow with expression body: the completion value is the function
    // itself (functions are not JSON values) → normalized to null.
    // The point: it compiles and runs without a type error.
    expect('error' in r).toBe(false);
  });

  it('runs a TS statement body', () => {
    const r = invokeNamedFunction(
      {
        language: 'typescript',
        source: 'const y: number = x * 2;\ny + 1;',
        params: ['x'],
      },
      [10],
    );
    expect(r).toEqual({ value: 21 });
  });

  it('rejects non-erasable TS at invoke time', () => {
    const r = invokeNamedFunction(
      { language: 'typescript', source: 'enum E { A }\n1', params: [] },
      [],
    );
    expect('error' in r).toBe(true);
  });
});

describe('invokeNamedFunction — Python', () => {
  it('receives params and returns result', () => {
    const r = invokeNamedFunction(
      { language: 'python', source: 'result = params["x"] * 2', params: ['x'] },
      [21],
    );
    expect(r).toEqual({ value: 42 });
  });

  it('allows allowlisted imports, blocks the rest', () => {
    const ok = invokeNamedFunction(
      { language: 'python', source: 'import math\nresult = math.sqrt(16)', params: [] },
      [],
    );
    expect(ok).toEqual({ value: 4 });
    const bad = invokeNamedFunction(
      { language: 'python', source: 'import os\nresult = 1', params: [] },
      [],
    );
    expect('error' in bad).toBe(true);
    expect((bad as { error: string }).error).toMatch(/not allowed/i);
  });

  it('requires result assignment', () => {
    const r = invokeNamedFunction({ language: 'python', source: 'x = 1', params: [] }, []);
    expect('error' in r).toBe(true);
    expect((r as { error: string }).error).toMatch(/must assign.*result/);
  });

  it('propagates Python exceptions', () => {
    const r = invokeNamedFunction(
      { language: 'python', source: 'result = 1 / 0', params: [] },
      [],
    );
    expect('error' in r).toBe(true);
    expect((r as { error: string }).error).toMatch(/ZeroDivisionError/);
  });
});

describe('makeInvokeFn', () => {
  it('builds the registry hook', () => {
    const invoke = makeInvokeFn();
    const r = invoke({ language: 'javascript', source: 'x + 1', params: ['x'] }, [1]);
    expect(r).toEqual({ value: 2 });
  });
});
