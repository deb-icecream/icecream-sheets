/**
 * Read-path authorization tests (design-docs/permission-model.md §4).
 *
 * Every read goes through authorize(). Denied cells return #PERM! values —
 * never fake empties, never leaked values. Bulk reads enforce per cell.
 */
import { describe, expect, it } from 'vitest';
import { Authorizer } from '../src/permissions.js';
import { EngineHost } from '../src/protocol.js';
import { isError } from '../src/types.js';

function denyCellPolicy() {
  // Deny reads of Sheet1!B2 only; allow everything else.
  return (action: string, target: string, _ctx: { principal: string }) => {
    if (action === 'cell.read' && target === 'Sheet1!B2') return false;
    return true;
  };
}

describe('read authorization', () => {
  it('readCell returns #PERM! for a denied cell', () => {
    const host = new EngineHost(undefined, new Authorizer(denyCellPolicy()));
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 1 }, value: 42 });
    const v = host.readCell({ sheet: 'Sheet1', row: 1, col: 1 });
    expect(isError(v)).toBe(true);
    if (isError(v)) expect(v.code).toBe('#PERM!');
  });

  it('readCell returns the value when allowed', () => {
    const host = new EngineHost();
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 'hi' });
    const v = host.readCell({ sheet: 'Sheet1', row: 0, col: 0 });
    expect(v).toEqual({ kind: 'string', value: 'hi' });
  });

  it('readRange marks denied cells per-cell, permitted cells return', () => {
    const host = new EngineHost(undefined, new Authorizer(denyCellPolicy()));
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 0 }, value: 1 });
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 1 }, value: 2 });
    const rows = host.readRange({ sheet: 'Sheet1', startRow: 1, startCol: 0, endRow: 1, endCol: 1 });
    expect(rows[0]?.[0]).toEqual({ kind: 'number', value: 1 });
    const denied = rows[0]?.[1];
    expect(isError(denied)).toBe(true);
    if (isError(denied)) expect(denied.code).toBe('#PERM!');
  });

  it('readSheet filters per subject', () => {
    const host = new EngineHost(undefined, new Authorizer(denyCellPolicy()));
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 'ok' });
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 1 }, value: 'secret' });
    const rows = host.readSheet('Sheet1');
    expect(rows[0]?.[0]).toEqual({ kind: 'string', value: 'ok' });
    const denied = rows[1]?.[1];
    expect(isError(denied)).toBe(true);
    if (isError(denied)) expect(denied.code).toBe('#PERM!');
  });

  it('denied reads are audit-logged (failed access attempts)', () => {
    const authorizer = new Authorizer(denyCellPolicy());
    const host = new EngineHost(undefined, authorizer);
    host.readCell({ sheet: 'Sheet1', row: 1, col: 1 });
    const denied = authorizer.auditLog().filter((r) => !r.allowed);
    expect(denied.length).toBeGreaterThan(0);
    expect(denied[0]?.action).toBe('cell.read');
  });

  it('authorize throws on missing principal (fail closed)', () => {
    const host = new EngineHost();
    expect(() =>
      host.readCell({ sheet: 'Sheet1', row: 0, col: 0 }, { principal: '' } as never),
    ).toThrow();
  });
});
