/**
 * Tests for the permissioned automation API: typed surface over the engine
 * protocol, authorization enforcement on every call (reads included), no
 * privileged backdoor, and honest 'unsupported' failures for operations the
 * engine protocol v1 cannot execute.
 */
import { describe, expect, it } from 'vitest';
import { Authorizer, EngineHost } from '@icecream-sheets/engine';
import {
  AutomationApi,
  AutomationError,
  AUTOMATION_ACTIONS,
} from '../src/index.js';

function api(principal = 'user', host?: EngineHost): AutomationApi {
  return new AutomationApi(host ?? new EngineHost(), { principal });
}

describe('AutomationApi construction', () => {
  it('requires a non-empty principal (fail closed on identity)', () => {
    expect(() => new AutomationApi(new EngineHost(), { principal: '' })).toThrow(AutomationError);
    // @ts-expect-error - missing options entirely
    expect(() => new AutomationApi(new EngineHost())).toThrow(AutomationError);
  });

  it('exposes its principal', () => {
    expect(api('automation:rollup').getPrincipal()).toBe('automation:rollup');
  });
});

describe('cells', () => {
  it('setCell/getCell round-trip through the engine', () => {
    const a = api();
    a.setCell({ sheet: 'Sheet1', row: 0, col: 0 }, 10);
    a.setCell({ sheet: 'Sheet1', row: 0, col: 1 }, 20);
    expect(a.getCell({ sheet: 'Sheet1', row: 0, col: 0 })).toEqual({ kind: 'number', value: 10 });
    a.setFormula({ sheet: 'Sheet1', row: 0, col: 2 }, '=A1+B1');
    expect(a.getCell({ sheet: 'Sheet1', row: 0, col: 2 })).toEqual({ kind: 'number', value: 30 });
  });

  it('setFormula/getFormula handle the = prefix', () => {
    const a = api();
    a.setFormula({ sheet: 'Sheet1', row: 1, col: 0 }, 'SUM(A1:B1)');
    expect(a.getFormula({ sheet: 'Sheet1', row: 1, col: 0 })).toBe('=SUM(A1:B1)');
  });

  it('setRange/getRange/clearRange work on blocks', () => {
    const a = api();
    const range = { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 1, endCol: 1 };
    a.setRange(range, [
      [1, 2],
      [3, 4],
    ]);
    expect(a.getRange(range)).toEqual([
      [
        { kind: 'number', value: 1 },
        { kind: 'number', value: 2 },
      ],
      [
        { kind: 'number', value: 3 },
        { kind: 'number', value: 4 },
      ],
    ]);
    a.clearRange(range);
    expect(a.getCell({ sheet: 'Sheet1', row: 0, col: 0 })).toEqual({ kind: 'null', value: null });
  });

  it('rejects invalid refs and values with code invalid', () => {
    const a = api();
    expect(() => a.setCell({ sheet: '', row: 0, col: 0 }, 1)).toThrowError(AutomationError);
    expect(() => a.setCell({ sheet: 'Sheet1', row: -1, col: 0 }, 1)).toThrowError(AutomationError);
    try {
      a.getCell({ sheet: 'Sheet1', row: -1, col: 0 });
      expect.unreachable();
    } catch (e) {
      expect((e as AutomationError).code).toBe('invalid');
    }
  });

  it('setRange validates shape', () => {
    const a = api();
    const range = { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 1, endCol: 1 };
    expect(() => a.setRange(range, [[1]])).toThrowError(AutomationError);
  });
});

describe('sheets and calculation', () => {
  it('addSheet/listSheets/getSheetInfo', () => {
    const a = api();
    a.addSheet('Data');
    expect(a.listSheets().map((s) => s.name)).toContain('Data');
    a.setCell({ sheet: 'Data', row: 4, col: 2 }, 'x');
    expect(a.getSheetInfo('Data')).toEqual({ name: 'Data', rowCount: 5, colCount: 3 });
  });

  it('setCalculationMode/recalculate', () => {
    const a = api();
    a.setCalculationMode('manual');
    a.setCell({ sheet: 'Sheet1', row: 0, col: 0 }, 5);
    a.recalculate();
    a.setCalculationMode('automatic');
    expect(() => a.setCalculationMode('bogus' as 'automatic')).toThrowError(AutomationError);
  });
});

describe('authorization enforcement', () => {
  function denyWritesHost(): { host: EngineHost; authorizer: Authorizer } {
    const authorizer = new Authorizer((action) => action !== AUTOMATION_ACTIONS.cellWrite);
    return { host: new EngineHost(undefined, authorizer), authorizer };
  }

  it('denies writes when the policy says no (code denied)', () => {
    const { host } = denyWritesHost();
    const a = new AutomationApi(host, { principal: 'user' });
    try {
      a.setCell({ sheet: 'Sheet1', row: 0, col: 0 }, 1);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AutomationError);
      expect((e as AutomationError).code).toBe('denied');
    }
    // Nothing was applied.
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 0 })).toEqual({
      kind: 'null',
      value: null,
    });
  });

  it('reads are authorized too — no read backdoor', () => {
    const authorizer = new Authorizer((action) => action !== AUTOMATION_ACTIONS.cellRead);
    const a = new AutomationApi(new EngineHost(undefined, authorizer), { principal: 'user' });
    try {
      a.getCell({ sheet: 'Sheet1', row: 0, col: 0 });
      expect.unreachable();
    } catch (e) {
      expect((e as AutomationError).code).toBe('denied');
    }
  });

  it('denials are audit-logged in the engine Authorizer', () => {
    const { host, authorizer } = denyWritesHost();
    const a = new AutomationApi(host, { principal: 'automation:test' });
    expect(() => a.setCell({ sheet: 'Sheet1', row: 0, col: 0 }, 1)).toThrow(AutomationError);
    const logged = authorizer
      .auditLog()
      .find((g) => g.principal === 'automation:test' && g.action === 'cell.write');
    expect(logged).toBeDefined();
    expect(logged!.allowed).toBe(false);
  });

  it('unsupported operations authorize FIRST, then fail honestly', () => {
    const { authorizer } = denyWritesHost();
    const host = new EngineHost(undefined, authorizer);
    const a = new AutomationApi(host, { principal: 'user' });
    const range = { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 0 };
    const attempts: Array<() => void> = [
      () => a.setCellFormat(range, { bold: true }),
      () => a.defineName('Total', 'Sheet1!A1'),
      () => a.getNamedRef('Total'),
      () => a.deleteName('Total'),
      () => a.insertRows('Sheet1', 2, 1),
      () => a.insertColumns('Sheet1', 2, 1),
      () => a.deleteRows('Sheet1', 2, 1),
      () => a.deleteColumns('Sheet1', 2, 1),
      () => a.sortRange(range, [{ col: 0, ascending: true }]),
      () => a.setAutoFilter(range, []),
      () => a.clearAutoFilter('Sheet1'),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
        expect.unreachable();
      } catch (e) {
        // The engine here allows everything, so the failure must be the
        // honest capability error, not a denial.
        expect((e as AutomationError).code).toBe('unsupported');
      }
    }
    // Every one of those calls went through authorize() — the audit log
    // proves there is no privileged path around the check.
    const actions = new Set(authorizer.auditLog().map((g) => g.action));
    for (const expected of [
      'format.write',
      'name.define',
      'name.read',
      'name.delete',
      'row.insert',
      'col.insert',
      'row.delete',
      'col.delete',
      'range.sort',
      'filter.set',
      'filter.clear',
    ]) {
      expect(actions.has(expected)).toBe(true);
    }
  });
});

describe('notifications and grants', () => {
  it('notify() records into the session outbox', () => {
    const a = api();
    a.notify('done');
    expect(a.getNotifications()).toEqual(['done']);
    a.clearNotifications();
    expect(a.getNotifications()).toEqual([]);
  });

  it('records user grants and checks declared permissions', () => {
    const a = api();
    const perms = [{ action: 'cell.write', target: 'Sheet1!0,0' }];
    expect(a.hasGrantsFor('automation:rollup', perms)).toBe(false);
    a.grantPermissions('automation:rollup', perms, 'user');
    expect(a.hasGrantsFor('automation:rollup', perms)).toBe(true);
    expect(a.grantsFor('automation:rollup')).toHaveLength(1);
    expect(a.grantsFor('automation:rollup')[0]!.grantedBy).toBe('user');
  });
});
