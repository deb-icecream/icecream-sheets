/**
 * Sheet structural ops through the engine protocol: deleteSheet,
 * renameSheet, duplicateSheet, moveSheet — all through authorize().
 */
import { describe, expect, it } from 'vitest';
import {
  Authorizer,
  EngineHost,
  EngineWorkbook,
  isError,
  scalar,
  type CellRef,
} from '../src/index.js';

const c = (sheet: string, row: number, col: number): CellRef => ({ sheet, row, col });

function twoSheetHost(): EngineHost {
  const host = new EngineHost();
  host.execute({ cmd: 'addSheet', name: 'Data' });
  host.execute({ cmd: 'setCell', ref: c('Data', 0, 0), value: 10 });
  host.execute({ cmd: 'setFormula', ref: c('Data', 0, 1), formula: '=A1*2' });
  host.execute({ cmd: 'setFormula', ref: c('Sheet1', 0, 0), formula: '=Data!B1+1' });
  return host;
}

describe('protocol deleteSheet', () => {
  it('removes the sheet and emits sheetRemoved', () => {
    const host = twoSheetHost();
    const events: string[] = [];
    host.subscribe((e) => events.push(e.type));
    expect(host.execute({ cmd: 'deleteSheet', name: 'Data' })).toEqual({ ok: true });
    expect(host.snapshot().sheets.map((s) => s.name)).toEqual(['Sheet1']);
    expect(events).toContain('sheetRemoved');
    host.dispose();
  });

  it('turns cross-sheet references into #REF!', () => {
    const host = twoSheetHost();
    host.execute({ cmd: 'deleteSheet', name: 'Data' });
    const v = host.readCell(c('Sheet1', 0, 0));
    expect(isError(v)).toBe(true);
    if (isError(v)) expect(v.code).toBe('#REF!');
    host.dispose();
  });

  it('refuses to delete the only sheet', () => {
    const host = new EngineHost();
    const res = host.execute({ cmd: 'deleteSheet', name: 'Sheet1' });
    expect(res.ok).toBe(false);
    expect(host.snapshot().sheets.map((s) => s.name)).toEqual(['Sheet1']);
    host.dispose();
  });

  it('errors on an unknown sheet', () => {
    const host = new EngineHost();
    expect(host.execute({ cmd: 'deleteSheet', name: 'Nope' }).ok).toBe(false);
    host.dispose();
  });

  it('is denied by policy through authorize()', () => {
    const host = new EngineHost(undefined, new Authorizer((action) => action !== 'sheet.delete'));
    host.execute({ cmd: 'addSheet', name: 'Data' });
    const res = host.execute({ cmd: 'deleteSheet', name: 'Data' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('sheet.delete');
    // Denied: the sheet is still there.
    expect(host.snapshot().sheets.map((s) => s.name)).toContain('Data');
    host.dispose();
  });
});

describe('protocol renameSheet', () => {
  it('renames and keeps formulas working', () => {
    const host = twoSheetHost();
    expect(host.execute({ cmd: 'renameSheet', name: 'Data', newName: 'Inputs' }).ok).toBe(true);
    expect(host.snapshot().sheets.map((s) => s.name).sort()).toEqual(['Inputs', 'Sheet1']);
    // The cross-sheet formula followed the rename (same sheet id).
    expect(host.readCell(c('Sheet1', 0, 0))).toEqual(scalar(21));
    expect(host.readCell(c('Inputs', 0, 1))).toEqual(scalar(20));
    host.dispose();
  });

  it('rejects empty and duplicate names', () => {
    const host = twoSheetHost();
    expect(host.execute({ cmd: 'renameSheet', name: 'Data', newName: '  ' }).ok).toBe(false);
    expect(host.execute({ cmd: 'renameSheet', name: 'Data', newName: 'Sheet1' }).ok).toBe(false);
    expect(host.snapshot().sheets.map((s) => s.name)).toContain('Data');
    host.dispose();
  });

  it('is denied by policy through authorize()', () => {
    const host = new EngineHost(undefined, new Authorizer(() => false));
    const res = host.execute({ cmd: 'renameSheet', name: 'Sheet1', newName: 'S' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('sheet.rename');
    host.dispose();
  });
});

describe('protocol duplicateSheet', () => {
  it('copies values and formulas with an Excel-style name', () => {
    const host = twoSheetHost();
    const res = host.execute({ cmd: 'duplicateSheet', name: 'Data' });
    expect(res.ok).toBe(true);
    const newName = res.ok && (res.data as { name: string }).name;
    expect(newName).toBe('Data (2)');
    expect(host.snapshot().sheets.map((s) => s.name)).toContain('Data (2)');
    // Values copied; formulas re-scoped to the new sheet and live.
    expect(host.readCell(c('Data (2)', 0, 0))).toEqual(scalar(10));
    expect(host.readCell(c('Data (2)', 0, 1))).toEqual(scalar(20));
    host.execute({ cmd: 'setCell', ref: c('Data (2)', 0, 0), value: 5 });
    expect(host.readCell(c('Data (2)', 0, 1))).toEqual(scalar(10));
    // The source is untouched.
    expect(host.readCell(c('Data', 0, 1))).toEqual(scalar(20));
    host.dispose();
  });

  it('honors an explicit new name and rejects collisions', () => {
    const host = twoSheetHost();
    expect(host.execute({ cmd: 'duplicateSheet', name: 'Data', newName: 'Copy' }).ok).toBe(true);
    expect(host.execute({ cmd: 'duplicateSheet', name: 'Data', newName: 'Copy' }).ok).toBe(false);
    host.dispose();
  });

  it('bumps the copy number when the default is taken', () => {
    const wb = new EngineWorkbook();
    expect(wb.duplicateSheet('Sheet1')).toBe('Sheet1 (2)');
    expect(wb.duplicateSheet('Sheet1')).toBe('Sheet1 (3)');
  });

  it('is denied by policy through authorize()', () => {
    const host = new EngineHost(undefined, new Authorizer(() => false));
    const res = host.execute({ cmd: 'duplicateSheet', name: 'Sheet1' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('sheet.duplicate');
    host.dispose();
  });
});

describe('protocol moveSheet', () => {
  it('reorders tabs and keeps cross-sheet formulas working', () => {
    const host = new EngineHost();
    host.execute({ cmd: 'addSheet', name: 'B' });
    host.execute({ cmd: 'addSheet', name: 'C' });
    host.execute({ cmd: 'setCell', ref: c('C', 0, 0), value: 7 });
    host.execute({ cmd: 'setFormula', ref: c('Sheet1', 0, 0), formula: '=C!A1*3' });
    const res = host.execute({ cmd: 'moveSheet', name: 'C', toIndex: 0 });
    expect(res.ok).toBe(true);
    expect(host.snapshot().sheets.map((s) => s.name)).toEqual(['C', 'Sheet1', 'B']);
    // Formula survived the rebuild and still computes.
    expect(host.readCell(c('Sheet1', 0, 0))).toEqual(scalar(21));
    expect(host.readCell(c('C', 0, 0))).toEqual(scalar(7));
    host.dispose();
  });

  it('clamps out-of-range targets and rejects unknown sheets', () => {
    const host = new EngineHost();
    host.execute({ cmd: 'addSheet', name: 'B' });
    expect(host.execute({ cmd: 'moveSheet', name: 'B', toIndex: 99 }).ok).toBe(true);
    expect(host.snapshot().sheets.map((s) => s.name)).toEqual(['Sheet1', 'B']);
    expect(host.execute({ cmd: 'moveSheet', name: 'Nope', toIndex: 0 }).ok).toBe(false);
    host.dispose();
  });

  it('preserves defined names across the rebuild', () => {
    const host = new EngineHost();
    host.execute({ cmd: 'addSheet', name: 'B' });
    host.execute({ cmd: 'setCell', ref: c('B', 0, 0), value: 42 });
    host.execute({ cmd: 'defineName', name: 'Answer', refersTo: 'B!$A$1' });
    host.execute({ cmd: 'moveSheet', name: 'B', toIndex: 0 });
    expect(host.snapshot().sheets.map((s) => s.name)).toEqual(['B', 'Sheet1']);
    // The named expression still resolves after the rebuild.
    host.execute({ cmd: 'setFormula', ref: c('Sheet1', 0, 0), formula: '=Answer+1' });
    expect(host.readCell(c('Sheet1', 0, 0))).toEqual(scalar(43));
    host.dispose();
  });

  it('is denied by policy through authorize()', () => {
    const host = new EngineHost(undefined, new Authorizer(() => false));
    const res = host.execute({ cmd: 'moveSheet', name: 'Sheet1', toIndex: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('sheet.move');
    host.dispose();
  });

  it('records the sheet.* actions in the authorize audit log', () => {
    const authz = new Authorizer();
    const host = new EngineHost(undefined, authz);
    host.execute({ cmd: 'addSheet', name: 'X', auth: { principal: 'ai-agent' } });
    host.execute({ cmd: 'renameSheet', name: 'X', newName: 'Y', auth: { principal: 'ai-agent' } });
    host.execute({ cmd: 'duplicateSheet', name: 'Y', auth: { principal: 'ai-agent' } });
    host.execute({ cmd: 'deleteSheet', name: 'Y (2)', auth: { principal: 'ai-agent' } });
    const actions = authz.auditLog().map((e) => e.action);
    expect(actions).toEqual(['sheet.add', 'sheet.rename', 'sheet.duplicate', 'sheet.delete']);
    host.dispose();
  });
});

describe('protocol deleteRows', () => {
  /** A1:A5 = 1..5; B1 points at the row to delete; C1 sums the range; D1 points below it. */
  function valuesHost(authorizer?: Authorizer): EngineHost {
    const host = new EngineHost(undefined, authorizer);
    for (let r = 0; r < 5; r++) {
      host.execute({ cmd: 'setCell', ref: c('Sheet1', r, 0), value: r + 1 });
    }
    host.execute({ cmd: 'setFormula', ref: c('Sheet1', 0, 1), formula: '=A3' });
    host.execute({ cmd: 'setFormula', ref: c('Sheet1', 0, 2), formula: '=SUM(A1:A5)' });
    host.execute({ cmd: 'setFormula', ref: c('Sheet1', 0, 3), formula: '=A5' });
    return host;
  }

  it('shifts cells up and re-points the dependency graph', () => {
    const host = valuesHost();
    expect(host.execute({ cmd: 'deleteRows', sheet: 'Sheet1', row: 2 })).toEqual({ ok: true });
    expect(host.readCell(c('Sheet1', 0, 0))).toEqual(scalar(1));
    expect(host.readCell(c('Sheet1', 1, 0))).toEqual(scalar(2));
    expect(host.readCell(c('Sheet1', 2, 0))).toEqual(scalar(4));
    expect(host.readCell(c('Sheet1', 3, 0))).toEqual(scalar(5));
    // The range formula shrank with the deletion.
    expect(host.readCell(c('Sheet1', 0, 2))).toEqual(scalar(12));
    // =A5 re-pointed to =A4: still the old A5's value.
    expect(host.readCell(c('Sheet1', 0, 3))).toEqual(scalar(5));
    host.dispose();
  });

  it('turns references into the deleted rows into #REF!', () => {
    const host = valuesHost();
    host.execute({ cmd: 'deleteRows', sheet: 'Sheet1', row: 2 });
    const v = host.readCell(c('Sheet1', 0, 1)); // was =A3
    expect(isError(v)).toBe(true);
    if (isError(v)) expect(v.code).toBe('#REF!');
    host.dispose();
  });

  it('deletes multiple rows with count', () => {
    const host = valuesHost();
    expect(host.execute({ cmd: 'deleteRows', sheet: 'Sheet1', row: 1, count: 2 })).toEqual({ ok: true });
    expect(host.readCell(c('Sheet1', 0, 0))).toEqual(scalar(1));
    expect(host.readCell(c('Sheet1', 1, 0))).toEqual(scalar(4));
    expect(host.readCell(c('Sheet1', 2, 0))).toEqual(scalar(5));
    expect(host.readCell(c('Sheet1', 0, 2))).toEqual(scalar(10)); // SUM(A1:A3) = 1+4+5
    host.dispose();
  });

  it('is denied by policy through authorize()', () => {
    const host = valuesHost(new Authorizer((action) => action !== 'sheet.structure'));
    const res = host.execute({ cmd: 'deleteRows', sheet: 'Sheet1', row: 2 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('sheet.structure');
    // Denied: nothing moved.
    expect(host.readCell(c('Sheet1', 2, 0))).toEqual(scalar(3));
    expect(host.readCell(c('Sheet1', 0, 2))).toEqual(scalar(15));
    host.dispose();
  });

  it('audits the structural decision (allow and deny)', () => {
    const host = valuesHost();
    host.execute({ cmd: 'deleteRows', sheet: 'Sheet1', row: 2 });
    const allowed = host.getAuthorizer().auditLog().filter((e) => e.action === 'sheet.structure');
    expect(allowed).toHaveLength(1);
    expect(allowed[0]).toMatchObject({ principal: 'user', target: 'Sheet1', allowed: true });
    host.dispose();

    const deniedHost = valuesHost(new Authorizer((action) => action !== 'sheet.structure'));
    deniedHost.execute({ cmd: 'deleteRows', sheet: 'Sheet1', row: 2 });
    const denied = deniedHost.getAuthorizer().auditLog().filter((e) => e.action === 'sheet.structure');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ principal: 'user', target: 'Sheet1', allowed: false });
    deniedHost.dispose();
  });

  it('errors on an unknown sheet', () => {
    const host = valuesHost();
    expect(host.execute({ cmd: 'deleteRows', sheet: 'Nope', row: 0 }).ok).toBe(false);
    host.dispose();
  });
});

describe('protocol deleteCols', () => {
  /**
   * Row 1: A1=1, B1=2, C1=3, D1=4. Row 2 holds formulas in columns that
   * survive the deletion: A2 points INTO the deleted column, E2 sums the
   * full row, F2 points right of the deletion.
   */
  function valuesHost(authorizer?: Authorizer): EngineHost {
    const host = new EngineHost(undefined, authorizer);
    for (let col = 0; col < 4; col++) {
      host.execute({ cmd: 'setCell', ref: c('Sheet1', 0, col), value: col + 1 });
    }
    host.execute({ cmd: 'setFormula', ref: c('Sheet1', 1, 0), formula: '=B1' });
    host.execute({ cmd: 'setFormula', ref: c('Sheet1', 1, 4), formula: '=SUM(A1:D1)' });
    host.execute({ cmd: 'setFormula', ref: c('Sheet1', 1, 5), formula: '=D1' });
    return host;
  }

  it('shifts cells left and re-points the dependency graph', () => {
    const host = valuesHost();
    expect(host.execute({ cmd: 'deleteCols', sheet: 'Sheet1', col: 1 })).toEqual({ ok: true });
    expect(host.readCell(c('Sheet1', 0, 0))).toEqual(scalar(1));
    expect(host.readCell(c('Sheet1', 0, 1))).toEqual(scalar(3));
    expect(host.readCell(c('Sheet1', 0, 2))).toEqual(scalar(4));
    // =SUM(A1:D1) shrank to =SUM(A1:C1) = 1+3+4; it shifted left with the columns.
    expect(host.readCell(c('Sheet1', 1, 3))).toEqual(scalar(8));
    // =D1 re-pointed to =C1: still the old D1's value.
    expect(host.readCell(c('Sheet1', 1, 4))).toEqual(scalar(4));
    host.dispose();
  });

  it('turns references into the deleted columns into #REF!', () => {
    const host = valuesHost();
    host.execute({ cmd: 'deleteCols', sheet: 'Sheet1', col: 1 });
    const v = host.readCell(c('Sheet1', 1, 0)); // was =B1
    expect(isError(v)).toBe(true);
    if (isError(v)) expect(v.code).toBe('#REF!');
    host.dispose();
  });

  it('is denied by policy through authorize()', () => {
    const host = valuesHost(new Authorizer((action) => action !== 'sheet.structure'));
    const res = host.execute({ cmd: 'deleteCols', sheet: 'Sheet1', col: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('sheet.structure');
    // Denied: nothing moved.
    expect(host.readCell(c('Sheet1', 0, 1))).toEqual(scalar(2));
    expect(host.readCell(c('Sheet1', 1, 4))).toEqual(scalar(10));
    host.dispose();
  });
});
