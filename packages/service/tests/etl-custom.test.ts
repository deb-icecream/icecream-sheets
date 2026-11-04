/**
 * Custom transform tests (design-docs/etl-pipeline.md §3): the sandboxed
 * table-in/table-out contract, validated with an injected fake runner —
 * the real sandbox binding (nodeRunner) is a server-host concern.
 */
import { describe, expect, it } from 'vitest';
import {
  contractToTable,
  makeTable,
  runCustomTransform,
  TransientCustomError,
  type CustomCodeRunner,
} from '../src/index.js';

const input = makeTable(['a', 'b'], [[1, 'x'], [2, 'y']]);

/** Fake runner: executes a JS function against the input, like the sandbox would. */
function fakeRunner(fn: (input: { columns: string[]; rows: Record<string, unknown>[] }) => unknown): CustomCodeRunner {
  return async (_language, _code, args) => {
    try {
      return { value: fn({ columns: args.columns, rows: args.rows as Record<string, unknown>[] }) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };
}

describe('runCustomTransform', () => {
  it('passes columns/rows in and accepts a valid table out', async () => {
    const seen: { columns: string[] }[] = [];
    const runner = fakeRunner((inp) => {
      seen.push({ columns: inp.columns });
      return {
        columns: ['a', 'doubled'],
        rows: inp.rows.map((r) => ({ a: r['a'], doubled: (r['a'] as number) * 2 })),
      };
    });
    const out = await runCustomTransform(input, { language: 'javascript', code: '/* user code */' }, runner);
    expect(seen[0].columns).toEqual(['a', 'b']);
    expect(out.columns.map((c) => c.name)).toEqual(['a', 'doubled']);
    expect(out.rows[1]['doubled']).toBe(4);
  });

  it('rejects empty code', async () => {
    await expect(
      runCustomTransform(input, { language: 'python', code: '  ' }, fakeRunner(() => ({}))),
    ).rejects.toThrow(/code must not be empty/);
  });

  it('rejects out-of-range timeouts', async () => {
    await expect(
      runCustomTransform(input, { language: 'python', code: 'x', timeoutMs: 999999 }, fakeRunner(() => ({}))),
    ).rejects.toThrow(/timeoutMs/);
  });

  it('surfaces sandbox errors', async () => {
    const runner: CustomCodeRunner = async () => ({ error: 'SyntaxError: bad code' });
    await expect(runCustomTransform(input, { language: 'javascript', code: 'bad' }, runner))
      .rejects.toThrow(/custom transform failed: SyntaxError/);
  });

  it('marks sandbox timeouts as transient (retriable)', async () => {
    const runner: CustomCodeRunner = async () => ({ error: 'Script execution timed out' });
    const err = await runCustomTransform(input, { language: 'javascript', code: 'while(1){}' }, runner)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).cause).toBeInstanceOf(TransientCustomError);
  });
});

describe('contractToTable', () => {
  it('accepts a well-formed result', () => {
    const t = contractToTable({ columns: ['x'], rows: [{ x: 1 }, { x: null }] });
    expect(t.rows).toEqual([{ x: 1 }, { x: null }]);
  });

  it('rejects non-object results', () => {
    expect(() => contractToTable([1, 2])).toThrow(/contract violation/);
    expect(() => contractToTable(null)).toThrow(/contract violation/);
  });

  it('rejects bad columns', () => {
    expect(() => contractToTable({ columns: ['a', 'a'], rows: [] })).toThrow(/unique/);
    expect(() => contractToTable({ columns: [''], rows: [] })).toThrow(/columns/);
    expect(() => contractToTable({ columns: 'a', rows: [] })).toThrow(/columns/);
  });

  it('rejects non-scalar row values', () => {
    expect(() => contractToTable({ columns: ['a'], rows: [{ a: { nested: 1 } }] }))
      .toThrow(/not a scalar/);
    expect(() => contractToTable({ columns: ['a'], rows: [[1]] })).toThrow(/must be an object/);
  });

  it('fills missing columns with null', () => {
    const t = contractToTable({ columns: ['a', 'b'], rows: [{ a: 1 }] });
    expect(t.rows[0]).toEqual({ a: 1, b: null });
  });
});
