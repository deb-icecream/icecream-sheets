/**
 * ICEEVAL() formula-function tests.
 *
 * Importing the plugin module registers it globally with HyperFormula
 * (side-effectful import); the import MUST come before any EngineHost is
 * constructed so the function exists when formulas are parsed.
 */
import '../src/engine-plugin.js';
import { describe, expect, it } from 'vitest';
import { EngineHost } from '@icecream-sheets/engine';

function setFormula(host: EngineHost, row: number, col: number, formula: string): void {
  const result = host.execute({
    cmd: 'setFormula',
    ref: { sheet: 'Sheet1', row, col },
    formula,
    auth: { principal: 'test' },
  });
  expect(result).toEqual({ ok: true });
}

describe('ICEEVAL formula function', () => {
  it('evaluates =ICEEVAL("arg1*2", 21) to 42', () => {
    const host = new EngineHost();
    setFormula(host, 0, 0, '=ICEEVAL("arg1*2", 21)');
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 0 })).toEqual({
      kind: 'number',
      value: 42,
    });
  });

  it('passes multiple args as arg1, arg2, ...', () => {
    const host = new EngineHost();
    setFormula(host, 0, 0, '=ICEEVAL("arg1 + arg2 + arg3", 1, 2, 3)');
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 0 })).toEqual({
      kind: 'number',
      value: 6,
    });
  });

  it('returns strings', () => {
    const host = new EngineHost();
    setFormula(host, 0, 0, `=ICEEVAL("arg1 + '!'", "hi")`);
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 0 })).toEqual({
      kind: 'string',
      value: 'hi!',
    });
  });

  it('can consume other cells as arguments', () => {
    const host = new EngineHost();
    host.execute({
      cmd: 'setCell',
      ref: { sheet: 'Sheet1', row: 0, col: 0 },
      value: 7,
      auth: { principal: 'test' },
    });
    setFormula(host, 1, 0, '=ICEEVAL("arg1 * 10", A1)');
    expect(host.readCell({ sheet: 'Sheet1', row: 1, col: 0 })).toEqual({
      kind: 'number',
      value: 70,
    });
  });

  it('surfaces sandbox errors as cell errors, not crashes', () => {
    const host = new EngineHost();
    setFormula(host, 0, 0, '=ICEEVAL("while(true){}", 1)');
    const value = host.readCell({ sheet: 'Sheet1', row: 0, col: 0 });
    expect(value.kind).toBe('error');
  }, 15000);

  it('surfaces sandbox ReferenceErrors as cell errors', () => {
    const host = new EngineHost();
    setFormula(host, 0, 0, '=ICEEVAL("process.exit(1)", 1)');
    const value = host.readCell({ sheet: 'Sheet1', row: 0, col: 0 });
    expect(value.kind).toBe('error');
  });

  it('rejects non-scalar results as cell errors', () => {
    const host = new EngineHost();
    setFormula(host, 0, 0, '=ICEEVAL("({a: 1})", 1)');
    const value = host.readCell({ sheet: 'Sheet1', row: 0, col: 0 });
    expect(value.kind).toBe('error');
  });
});
