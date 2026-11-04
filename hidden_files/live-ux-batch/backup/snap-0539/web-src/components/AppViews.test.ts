/**
 * End-to-end app-runtime tests: the web RowMutationPort against a real
 * EngineHost. Verifies reads go through the typed view, writes go through
 * the engine protocol with auth, and authorize() denials block mutations.
 */
import { describe, expect, it } from 'vitest';
import { Authorizer, EngineHost } from '@icecream-sheets/engine';
import {
  AuthorizationError,
  ConfirmationRequiredError,
  executeAction,
  generateAppSpec,
  type AppSpec,
  type ColumnSpec,
  type RangeBinding,
} from '@icecream-sheets/service';
import { APP_PRINCIPAL, createWebAppPort } from './AppViews';
import { cellRef } from '../engine';

const BINDING: RangeBinding = {
  sheet: 'Sheet1',
  startRow: 0,
  startCol: 0,
  endRow: 3,
  endCol: 2,
  headerRow: true,
};

const COLUMNS: ColumnSpec[] = [
  { name: 'Name', type: 'text' },
  { name: 'Age', type: 'numeric' },
  { name: 'Hired', type: 'date' },
];

function seedHost(): EngineHost {
  const host = new EngineHost();
  const auth = { principal: APP_PRINCIPAL };
  const rows: (string | number)[][] = [
    ['Name', 'Age', 'Hired'],
    ['Ann', 30, '2020-01-01'],
    ['Bob', 25, '2021-06-01'],
  ];
  rows.forEach((row, r) =>
    row.forEach((v, c) => {
      const res = host.execute({ cmd: 'setCell', ref: cellRef('Sheet1', r, c), value: v, auth });
      expect(res.ok).toBe(true);
    }),
  );
  return host;
}

function makeSpec(): AppSpec {
  return generateAppSpec('People', BINDING, COLUMNS, { id: 'app_e2e' });
}

describe('web app port (real EngineHost)', () => {
  it('reads the bound table through the typed view', () => {
    const host = seedHost();
    const port = createWebAppPort(host, APP_PRINCIPAL);
    const snap = port.readTable(BINDING);
    expect(snap.headers).toEqual(['Name', 'Age', 'Hired']);
    expect(snap.records).toHaveLength(2);
    expect(snap.records[0]!.values).toMatchObject({ Name: 'Ann', Age: 30 });
    expect(port.rowCount(BINDING)).toBe(2);
  });

  it('addRow writes through the engine protocol and formulas keep working', () => {
    const host = seedHost();
    const port = createWebAppPort(host, APP_PRINCIPAL);
    const spec = makeSpec();
    const out = executeAction(port, {
      spec,
      actionId: 'action_add',
      values: { Name: 'Cat', Age: '28', Hired: '2022-03-04' },
    });
    expect(out.rowIndex).toBe(2);
    expect(host.readCell(cellRef('Sheet1', 3, 0))).toMatchObject({ kind: 'string', value: 'Cat' });
    expect(host.readCell(cellRef('Sheet1', 3, 1))).toMatchObject({ kind: 'number', value: 28 });
    // Engine still computes over the extended table.
    host.execute({
      cmd: 'setFormula',
      ref: cellRef('Sheet1', 5, 1),
      formula: '=SUM(B2:B4)',
      auth: { principal: APP_PRINCIPAL },
    });
    expect(host.readCell(cellRef('Sheet1', 5, 1))).toMatchObject({ kind: 'number', value: 83 });
  });

  it('editRow and deleteRow mutate through the protocol', () => {
    const host = seedHost();
    const port = createWebAppPort(host, APP_PRINCIPAL);
    const spec = makeSpec();
    executeAction(port, { spec, actionId: 'action_edit', rowIndex: 0, values: { Age: 31 } });
    expect(host.readCell(cellRef('Sheet1', 1, 1))).toMatchObject({ value: 31 });

    expect(() =>
      executeAction(port, { spec, actionId: 'action_delete', rowIndex: 0 }),
    ).toThrow(ConfirmationRequiredError);
    executeAction(port, { spec, actionId: 'action_delete', rowIndex: 0, confirmed: true });
    // Row shifted up: Bob is now the first data row.
    expect(host.readCell(cellRef('Sheet1', 1, 0))).toMatchObject({ value: 'Bob' });
    expect(port.rowCount(BINDING)).toBe(1);
  });

  it('denied principals cannot read or write through the app', () => {
    const denyAll = new Authorizer(() => false);
    const host = new EngineHost(undefined, denyAll);
    const port = createWebAppPort(host, 'mallory');
    const spec = makeSpec();
    // Reads come back as #PERM! markers, never values.
    const snap = port.readTable(BINDING);
    expect(
      snap.records.every((r) => Object.values(r.values).every((v) => v === null || (typeof v === 'object' && v !== null && 'error' in v))),
    ).toBe(true);
    // Writes are rejected before any mutation.
    expect(() =>
      executeAction(port, { spec, actionId: 'action_add', values: { Name: 'X' } }),
    ).toThrow(AuthorizationError);
  });

  it('authorize() is consulted for app-level actions', () => {
    const seen: string[] = [];
    const spy = new Authorizer((action, target) => {
      seen.push(`${action} ${target}`);
      return true;
    });
    const host = new EngineHost(undefined, spy);
    const port = createWebAppPort(host, APP_PRINCIPAL);
    port.authorize('app.manage', 'app:app_e2e');
    expect(seen).toContain('app.manage app:app_e2e');
  });
});
