/**
 * Named ranges + named functions (design-docs/named-ranges-and-named-functions.md §§1–7).
 *
 * Proves: stable ids survive structural edits, shadowing, case-insensitivity,
 * collision rejection, function versioning/rollback, typed signatures, and
 * the permission integration (#PERM! on denied name.read / function.read).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  Authorizer,
  EngineHost,
  EngineWorkbook,
  isError,
  scalar,
  setPythonProvider,
  resetPythonProvider,
  type CellRef,
  type DefineFunctionInput,
} from '../src/index.js';

const c = (sheet: string, row: number, col: number): CellRef => ({ sheet, row, col });

const sig2 = { params: [{ name: 'a', type: 'number' as const }, { name: 'b', type: 'number' as const }], returns: 'number' as const };
const sig1 = { params: [{ name: 'x', type: 'number' as const }], returns: 'number' as const };

function numInput(name: string, language: DefineFunctionInput['language'], source: string): DefineFunctionInput {
  return { name, signature: sig1, language, source };
}

describe('named ranges: stable identity (§1)', () => {
  it('id survives row insertion above the range; liveRefersTo tracks', () => {
    const wb = new EngineWorkbook({ Sheet1: [[1], [2], [3]] });
    const def = wb.defineNamedRange('Sales', 'Sheet1!$A$1:$A$3');
    wb.setFormula(c('Sheet1', 0, 1), '=SUM(Sales)');
    expect(wb.getValue(c('Sheet1', 0, 1))).toEqual(scalar(6));

    wb.insertRows('Sheet1', 0, 2); // two rows above

    const listed = wb.listNamedRanges();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(def.id); // same stable id
    expect(listed[0]!.liveRefersTo).toBe('Sheet1!$A$3:$A$5'); // tracked
    expect(listed[0]!.dangling).toBe(false);
    // The formula still sums the same cells (now at rows 3..5).
    expect(wb.getValue(c('Sheet1', 2, 1))).toEqual(scalar(6));
  });

  it('id survives row deletion and column insert/delete', () => {
    const wb = new EngineWorkbook({ Sheet1: [[1, 10], [2, 20], [3, 30]] });
    const def = wb.defineNamedRange('Block', 'Sheet1!$A$1:$B$3');
    wb.deleteRows('Sheet1', 0, 1); // delete first row
    let live = wb.listNamedRanges()[0]!;
    expect(live.id).toBe(def.id);
    expect(live.liveRefersTo).toBe('Sheet1!$A$1:$B$2');

    wb.insertCols('Sheet1', 0, 1); // column before
    live = wb.listNamedRanges()[0]!;
    expect(live.id).toBe(def.id);
    expect(live.liveRefersTo).toBe('Sheet1!$B$1:$C$2');

    wb.deleteCols('Sheet1', 0, 1); // remove the inserted column
    live = wb.listNamedRanges()[0]!;
    expect(live.id).toBe(def.id);
    expect(live.liveRefersTo).toBe('Sheet1!$A$1:$B$2');
  });

  it('deleting every covered cell makes the name dangling → #REF!', () => {
    const wb = new EngineWorkbook({ Sheet1: [[5], [0]] });
    wb.defineNamedRange('Gone', 'Sheet1!$A$1');
    wb.setFormula(c('Sheet1', 1, 0), '=Gone*2');
    wb.deleteRows('Sheet1', 0, 1); // the named cell's row; formula shifts up
    const live = wb.listNamedRanges()[0]!;
    expect(live.dangling).toBe(true);
    expect(live.liveRefersTo).toContain('#REF!');
    const v = wb.getValue(c('Sheet1', 0, 0)); // formula now at row 0
    expect(isError(v) && v.code).toBe('#REF!');
  });

  it('rename keeps the stable id', () => {
    const wb = new EngineWorkbook({ Sheet1: [[7]] });
    const def = wb.defineNamedRange('Old', 'Sheet1!$A$1');
    const renamed = wb.renameNamedRange(def.id, 'New');
    expect(renamed.id).toBe(def.id);
    expect(renamed.name).toBe('New');
    expect(wb.resolveNamedRange('new')!.id).toBe(def.id); // case-insensitive
    expect(wb.resolveNamedRange('old')).toBeUndefined();
  });

  it('updateRefersTo keeps the id', () => {
    const wb = new EngineWorkbook({ Sheet1: [[1], [2]] });
    const def = wb.defineNamedRange('R', 'Sheet1!$A$1');
    const upd = wb.updateNamedRangeRefersTo(def.id, 'Sheet1!$A$2');
    expect(upd.id).toBe(def.id);
    expect(wb.listNamedRanges()[0]!.liveRefersTo).toBe('Sheet1!$A$2');
  });
});

describe('named ranges: scope and shadowing (§2)', () => {
  it('sheet scope shadows workbook scope within its sheet', () => {
    const wb = new EngineWorkbook({ Sheet1: [[1]], Sheet2: [[2]] });
    wb.defineNamedRange('X', 'Sheet1!$A$1', 'workbook');
    wb.defineNamedRange('X', 'Sheet2!$A$1', 'Sheet2');
    // Sheet-scoped wins when resolving with the sheet scope...
    expect(wb.resolveNamedRange('x', 'Sheet2')!.scope).toBe('Sheet2');
    // ...workbook name is the fallback without a sheet scope.
    expect(wb.resolveNamedRange('X')!.scope).toBe('workbook');
    const all = wb.listNamedRanges();
    expect(all).toHaveLength(2);
    expect(new Set(all.map((d) => d.id)).size).toBe(2); // distinct ids
  });

  it('same name in two different sheet scopes does not collide', () => {
    const wb = new EngineWorkbook({ Sheet1: [[1]], Sheet2: [[2]] });
    wb.defineNamedRange('Y', 'Sheet1!$A$1', 'Sheet1');
    wb.defineNamedRange('Y', 'Sheet2!$A$1', 'Sheet2'); // no throw
    expect(wb.listNamedRanges()).toHaveLength(2);
  });

  it('collisions are rejected, never silently renamed (§2)', () => {
    const wb = new EngineWorkbook({ Sheet1: [[1]] });
    wb.defineNamedRange('Dup', 'Sheet1!$A$1');
    expect(() => wb.defineNamedRange('DUP', 'Sheet1!$A$1')).toThrow();
    expect(() => wb.defineNamedRange('dup', 'Sheet1!$A$1')).toThrow();
    expect(wb.listNamedRanges()).toHaveLength(1);
  });

  it('rejects cell-ref-like names and function names', () => {
    const wb = new EngineWorkbook({ Sheet1: [[1]] });
    expect(() => wb.defineNamedRange('A1', 'Sheet1!$A$1')).toThrow();
    expect(() => wb.defineNamedRange('R1C1', 'Sheet1!$A$1')).toThrow();
    expect(() => wb.defineNamedRange('SUM', 'Sheet1!$A$1')).toThrow(); // function name
    expect(() => wb.defineNamedRange('1abc', 'Sheet1!$A$1')).toThrow();
  });
});

describe('named functions (§§6–7)', () => {
  it('LAMBDA function is callable from formulas', () => {
    const wb = new EngineWorkbook({ Sheet1: [] });
    const def = wb.defineNamedFunctionDef({
      name: 'Double',
      signature: sig1,
      language: 'lambda',
      source: '=LAMBDA(x, x*2)',
    });
    expect(def.id).toMatch(/^nf_/);
    expect(def.version).toBe(1);
    wb.setFormula(c('Sheet1', 0, 0), '=DOUBLE(21)');
    expect(wb.getValue(c('Sheet1', 0, 0))).toEqual(scalar(42));
    // Case-insensitive call.
    wb.setFormula(c('Sheet1', 0, 1), '=double(1)');
    expect(wb.getValue(c('Sheet1', 0, 1))).toEqual(scalar(2));
  });

  it('LAMBDA versioning: update evaluates the new version; rollback restores', () => {
    const wb = new EngineWorkbook({ Sheet1: [] });
    const def = wb.defineNamedFunctionDef({
      name: 'Bump',
      signature: sig1,
      language: 'lambda',
      source: '=LAMBDA(x, x+1)',
    });
    wb.setFormula(c('Sheet1', 0, 0), '=BUMP(10)');
    expect(wb.getValue(c('Sheet1', 0, 0))).toEqual(scalar(11));

    const v2 = wb.updateNamedFunctionDef(def.id, { source: '=LAMBDA(x, x+100)' });
    expect(v2.version).toBe(2);
    expect(v2.history).toHaveLength(1);
    expect(v2.history[0]!.source).toBe('=LAMBDA(x, x+1)');
    // Current version evaluates immediately — no formula edits needed.
    expect(wb.getValue(c('Sheet1', 0, 0))).toEqual(scalar(110));

    const rb = wb.rollbackNamedFunctionDef(def.id, 1);
    expect(rb.version).toBe(3); // rollback is a new version
    expect(wb.getValue(c('Sheet1', 0, 0))).toEqual(scalar(11));
  });

  it('JavaScript function runs and enforces the typed signature', () => {
    const wb = new EngineWorkbook({ Sheet1: [] });
    wb.defineNamedFunctionDef(numInput('Triple', 'javascript', '(x) => x * 3'));
    wb.setFormula(c('Sheet1', 0, 0), '=TRIPLE(14)');
    expect(wb.getValue(c('Sheet1', 0, 0))).toEqual(scalar(42));

    // Wrong arity → #VALUE! with a message.
    wb.setFormula(c('Sheet1', 0, 1), '=TRIPLE(1,2)');
    const v = wb.getValue(c('Sheet1', 0, 1));
    expect(isError(v) && v.code).toBe('#VALUE!');
  });

  it('TypeScript erasable annotations are stripped', () => {
    const wb = new EngineWorkbook({ Sheet1: [] });
    wb.defineNamedFunctionDef(numInput('AddOne', 'typescript', '(x: number): number => x + 1'));
    wb.setFormula(c('Sheet1', 0, 0), '=ADDONE(41)');
    expect(wb.getValue(c('Sheet1', 0, 0))).toEqual(scalar(42));
  });

  it('definition rejects bad signatures at define time', () => {
    const wb = new EngineWorkbook({ Sheet1: [] });
    expect(() =>
      wb.defineNamedFunctionDef({
        name: 'Bad',
        signature: { params: [{ name: 'x', type: 'nope' as never }], returns: 'number' },
        language: 'javascript',
        source: '(x) => x',
      }),
    ).toThrow();
    expect(() =>
      wb.defineNamedFunctionDef({
        name: 'AlsoBad',
        signature: { params: [{ name: 'x', type: 'number' }], returns: 'number' },
        language: 'lambda',
        source: '(x) => x', // not a LAMBDA expression
      }),
    ).toThrow();
  });

  it('Python function runs through the provider seam', () => {
    setPythonProvider({
      run: (code: string, args: unknown[]) => {
        expect(code).toContain('__named_fn');
        return { value: (args[0] as number) * 10 };
      },
    });
    try {
      const wb = new EngineWorkbook({ Sheet1: [] });
      wb.defineNamedFunctionDef(numInput('TimesTen', 'python', 'return x * 10'));
      wb.setFormula(c('Sheet1', 0, 0), '=TIMESTEN(4)');
      expect(wb.getValue(c('Sheet1', 0, 0))).toEqual(scalar(40));
    } finally {
      resetPythonProvider();
    }
  });

  it('deleted function → #NAME?', () => {
    const wb = new EngineWorkbook({ Sheet1: [] });
    const def = wb.defineNamedFunctionDef(numInput('Temp', 'javascript', '(x) => x'));
    wb.setFormula(c('Sheet1', 0, 0), '=TEMP(5)');
    expect(wb.getValue(c('Sheet1', 0, 0))).toEqual(scalar(5));
    wb.deleteNamedFunctionDef(def.id);
    const v = wb.getValue(c('Sheet1', 0, 0));
    expect(isError(v) && v.code).toBe('#NAME?');
  });

  it('ranges and functions share one namespace (§2)', () => {
    const wb = new EngineWorkbook({ Sheet1: [[1]] });
    wb.defineNamedRange('Shared', 'Sheet1!$A$1');
    expect(() => wb.defineNamedFunctionDef(numInput('SHARED', 'javascript', '(x) => x'))).toThrow();
    const wb2 = new EngineWorkbook({ Sheet1: [] });
    wb2.defineNamedFunctionDef(numInput('SharedTwo', 'javascript', '(x) => x'));
    expect(() => wb2.defineNamedRange('sharedtwo', 'Sheet1!$A$1')).toThrow();
  });

  it('legacy named-function names cannot be taken by the registry', () => {
    const wb = new EngineWorkbook({ Sheet1: [] });
    wb.defineNamedFunction('LegacyFn', '=LAMBDA(x, x)');
    expect(() => wb.defineNamedFunctionDef(numInput('legacyfn', 'javascript', '(x) => x'))).toThrow();
    // And the legacy path cannot take a registry name either.
    wb.defineNamedFunctionDef(numInput('NewFn', 'javascript', '(x) => x'));
    expect(() => wb.defineNamedFunction('newfn', '=LAMBDA(x, x)')).toThrow();
  });
});

describe('permissions: names in the permission tree (§§4–5)', () => {
  const denyNames = new Authorizer((action) =>
    action === 'name.read' || action === 'function.read' ? false : true,
  );

  it('denied name.read → #PERM! (never a leak, never a fake empty)', () => {
    const wb = new EngineWorkbook({ Sheet1: [[42]] });
    const host = new EngineHost(wb, denyNames);
    host.execute({ cmd: 'defineName', name: 'Secret', refersTo: 'Sheet1!$A$1' });
    wb.setFormula(c('Sheet1', 0, 1), '=Secret+1');
    const v = host.readCell(c('Sheet1', 0, 1));
    expect(isError(v) && v.code).toBe('#PERM!');
  });

  it('denied function.read → #PERM!', () => {
    const wb = new EngineWorkbook({ Sheet1: [] });
    const host = new EngineHost(wb, denyNames);
    host.execute({
      cmd: 'defineFunction',
      input: numInput('PrivFn', 'javascript', '(x) => x * 2'),
    });
    wb.setFormula(c('Sheet1', 0, 0), '=PRIVFN(21)');
    const v = host.readCell(c('Sheet1', 0, 0));
    expect(isError(v) && v.code).toBe('#PERM!');
  });

  it('allowed principal reads through names normally', () => {
    const wb = new EngineWorkbook({ Sheet1: [[42]] });
    const host = new EngineHost(wb); // default allow-all
    host.execute({ cmd: 'defineName', name: 'Open', refersTo: 'Sheet1!$A$1' });
    wb.setFormula(c('Sheet1', 0, 1), '=Open+1');
    expect(host.readCell(c('Sheet1', 0, 1))).toEqual(scalar(43));
  });

  it('protocol rejects unauthorized defineName', () => {
    const denyDefine = new Authorizer((action) => action !== 'name.define');
    const host = new EngineHost(new EngineWorkbook({ Sheet1: [] }), denyDefine);
    const res = host.execute({ cmd: 'defineName', name: 'Nope', refersTo: 'Sheet1!$A$1' });
    expect(res.ok).toBe(false);
  });
});

describe('protocol: name commands + structural ops', () => {
  it('define/rename/update/delete round-trip through EngineHost with ids', () => {
    const host = new EngineHost(new EngineWorkbook({ Sheet1: [[1], [2]] }));
    const r1 = host.execute({ cmd: 'defineName', name: 'RngA', refersTo: 'Sheet1!$A$1:$A$2' });
    expect(r1.ok).toBe(true);
    const id = (r1 as { ok: true; data: { id: string } }).data.id;
    expect(typeof id).toBe('string');

    const r2 = host.execute({ cmd: 'renameName', id, newName: 'RngB' });
    expect(r2.ok).toBe(true);
    expect((r2 as { ok: true; data: { id: string } }).data.id).toBe(id);

    expect(host.execute({ cmd: 'updateNameRefersTo', id, refersTo: 'Sheet1!$A$1' }).ok).toBe(true);
    expect(host.listNamedRanges()[0]!.name).toBe('RngB');

    expect(host.execute({ cmd: 'deleteName', id }).ok).toBe(true);
    expect(host.listNamedRanges()).toHaveLength(0);
  });

  it('insertRows via protocol keeps name identity (no manual cell shifting)', () => {
    const host = new EngineHost(new EngineWorkbook({ Sheet1: [[10], [20]] }));
    const r = host.execute({ cmd: 'defineName', name: 'Vals', refersTo: 'Sheet1!$A$1:$A$2' });
    const id = (r as { ok: true; data: { id: string } }).data.id;
    expect(host.execute({ cmd: 'insertRows', sheet: 'Sheet1', row: 0, count: 1 }).ok).toBe(true);
    const live = host.listNamedRanges()[0]!;
    expect(live.id).toBe(id);
    expect(live.liveRefersTo).toBe('Sheet1!$A$2:$A$3');
  });

  it('defineFunction via protocol returns the def with id and version', () => {
    const host = new EngineHost(new EngineWorkbook({ Sheet1: [] }));
    const r = host.execute({
      cmd: 'defineFunction',
      input: numInput('Sq', 'javascript', '(x) => x * x'),
    });
    expect(r.ok).toBe(true);
    const def = (r as { ok: true; data: { id: string; version: number } }).data;
    expect(def.id).toMatch(/^nf_/);
    expect(def.version).toBe(1);
    expect(host.listNamedFunctionDefs()).toHaveLength(1);
  });
});

describe('definedNames bootstrap (§3)', () => {
  it('constructor definedNames get stable ids and scopes', () => {
    const wb = new EngineWorkbook(
      { Sheet1: [[3]], Sheet2: [[4]] },
      {
        definedNames: [
          { name: 'Wb', ref: 'Sheet1!$A$1' },
          { name: 'Local', ref: 'Sheet2!$A$1', sheet: 1 },
          { name: 'Dangling', ref: '#REF!' },
        ],
      },
    );
    const all = wb.listNamedRanges();
    expect(all).toHaveLength(3);
    const wbDef = all.find((d) => d.name === 'Wb')!;
    expect(wbDef.scope).toBe('workbook');
    expect(wbDef.id).toMatch(/^nr_/);
    expect(all.find((d) => d.name === 'Local')!.scope).toBe('Sheet2');
    const dang = all.find((d) => d.name === 'Dangling')!;
    expect(dang.dangling).toBe(true);
    wb.setFormula(c('Sheet1', 0, 1), '=Wb*2');
    expect(wb.getValue(c('Sheet1', 0, 1))).toEqual(scalar(6));
  });

  it('near-whole-column named range does not blow up construction (seedCache stays content-bounded)', () => {
    // Regression: real-world workbooks (e.g. ClosedXML's DrawingSizeInPx
    // fixture) define names over ~1M-row ranges (`Template!$B$1:$B$1048575`).
    // Seeding the value cache over the inflated bounding rectangle used to
    // overflow the V8 Map limit (RangeError: Map maximum size exceeded).
    const wb = new EngineWorkbook(
      { Template: [['sku', 'qty'], ['a1', 2], ['a2', 3]] },
      { definedNames: [{ name: 'item_sku', ref: 'Template!$B$1:$B$1048575' }] },
    );
    expect(wb.getValue(c('Template', 1, 1))).toEqual(scalar(2));
    wb.setFormula(c('Template', 0, 2), '=SUM(item_sku)');
    expect(wb.getValue(c('Template', 0, 2))).toEqual(scalar(5));
    // Suspended (manual) reads still serve the seeded formula value.
    wb.setCalculationMode('manual');
    expect(wb.getValue(c('Template', 0, 2))).toEqual(scalar(5));
    wb.setCalculationMode('automatic');
  });
});

describe('name manager data: live validation surface (§7 UI needs)', () => {
  it('list() exposes scope, id, liveRefersTo, dangling for the UI', () => {
    const wb = new EngineWorkbook({ Sheet1: [[1], [2]] });
    wb.defineNamedRange('Alpha', 'Sheet1!$A$1', 'workbook');
    wb.defineNamedRange('Beta', 'Sheet1!$A$2', 'Sheet1');
    const all = wb.listNamedRanges();
    for (const d of all) {
      expect(typeof d.id).toBe('string');
      expect(typeof d.name).toBe('string');
      expect(typeof d.scope).toBe('string');
      expect(typeof d.refersTo).toBe('string');
      expect(typeof d.liveRefersTo).toBe('string');
      expect(typeof d.dangling).toBe('boolean');
    }
    expect(all.find((d) => d.name === 'Beta')!.scope).toBe('Sheet1');
  });
});
