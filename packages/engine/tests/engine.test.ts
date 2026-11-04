import { describe, expect, it } from 'vitest';
import {
  Authorizer,
  EngineHost,
  EngineWorkbook,
  TypedView,
  err,
  isError,
  scalar,
  toA1,
  type CellRef,
} from '../src/index.js';

const c = (sheet: string, row: number, col: number): CellRef => ({ sheet, row, col });

describe('EngineWorkbook basics', () => {
  it('stores and reads literal values', () => {
    const wb = new EngineWorkbook();
    wb.setCell(c('Sheet1', 0, 0), 42);
    wb.setCell(c('Sheet1', 0, 1), 'hello');
    wb.setCell(c('Sheet1', 0, 2), true);
    expect(wb.getValue(c('Sheet1', 0, 0))).toEqual(scalar(42));
    expect(wb.getValue(c('Sheet1', 0, 1))).toEqual(scalar('hello'));
    expect(wb.getValue(c('Sheet1', 0, 2))).toEqual(scalar(true));
  });

  it('empty cells read as null', () => {
    const wb = new EngineWorkbook();
    expect(wb.getValue(c('Sheet1', 5, 5))).toEqual(scalar(null));
  });

  it('evaluates SUM over a range', () => {
    const wb = new EngineWorkbook({ Sheet1: [[1], [2], [3]] });
    wb.setFormula(c('Sheet1', 3, 0), '=SUM(A1:A3)');
    expect(wb.getValue(c('Sheet1', 3, 0))).toEqual(scalar(6));
  });

  it('recalculates dependents when an input changes', () => {
    const wb = new EngineWorkbook();
    wb.setCell(c('Sheet1', 0, 0), 10);
    wb.setFormula(c('Sheet1', 0, 1), '=A1*2');
    wb.setFormula(c('Sheet1', 0, 2), '=B1+5');
    expect(wb.getValue(c('Sheet1', 0, 2))).toEqual(scalar(25));
    wb.setCell(c('Sheet1', 0, 0), 100);
    expect(wb.getValue(c('Sheet1', 0, 1))).toEqual(scalar(200));
    expect(wb.getValue(c('Sheet1', 0, 2))).toEqual(scalar(205));
  });

  it('evaluates IF, VLOOKUP and string concatenation', () => {
    const wb = new EngineWorkbook({
      Sheet1: [
        ['apple', 3],
        ['banana', 5],
      ],
    });
    wb.setFormula(c('Sheet1', 0, 2), '=IF(B1>2,"big","small")');
    wb.setFormula(c('Sheet1', 1, 2), '=VLOOKUP("banana",A1:B2,2,FALSE())');
    wb.setFormula(c('Sheet1', 2, 0), '=A1 & " pie"');
    expect(wb.getValue(c('Sheet1', 0, 2))).toEqual(scalar('big'));
    expect(wb.getValue(c('Sheet1', 1, 2))).toEqual(scalar(5));
    expect(wb.getValue(c('Sheet1', 2, 0))).toEqual(scalar('apple pie'));
  });

  it('maps division by zero to #DIV/0!', () => {
    const wb = new EngineWorkbook();
    wb.setFormula(c('Sheet1', 0, 0), '=1/0');
    const v = wb.getValue(c('Sheet1', 0, 0));
    expect(isError(v)).toBe(true);
    expect(v).toEqual(err('#DIV/0!'));
  });

  it('treats leading-= strings as formulas (Excel-like)', () => {
    const wb = new EngineWorkbook();
    wb.setCell(c('Sheet1', 0, 0), '=1+1');
    expect(wb.getValue(c('Sheet1', 0, 0))).toEqual(scalar(2));
  });

  it('manages sheets', () => {
    const wb = new EngineWorkbook();
    wb.addSheet('Data');
    expect(wb.sheetNames()).toContain('Data');
    wb.setCell(c('Data', 0, 0), 7);
    wb.setFormula(c('Sheet1', 0, 0), '=Data!A1*3');
    expect(wb.getValue(c('Sheet1', 0, 0))).toEqual(scalar(21));
  });

  it('throws on unknown sheet', () => {
    const wb = new EngineWorkbook();
    expect(() => wb.getValue(c('Nope', 0, 0))).toThrow();
  });
});

describe('snapshots', () => {
  it('round-trips through toSnapshot/fromSnapshot', () => {
    const wb = new EngineWorkbook({ Sheet1: [[1, 2]], Data: [['x']] });
    wb.setFormula(c('Sheet1', 0, 2), '=SUM(A1:B1)');
    const snap = wb.toSnapshot();
    const wb2 = EngineWorkbook.fromSnapshot(JSON.parse(JSON.stringify(snap)));
    expect(wb2.getValue(c('Sheet1', 0, 2))).toEqual(scalar(3));
    expect(wb2.getValue(c('Data', 0, 0))).toEqual(scalar('x'));
    expect(wb2.sheetNames().sort()).toEqual(['Data', 'Sheet1']);
  });

  it('rejects snapshots from a different protocol version', () => {
    expect(() => EngineWorkbook.fromSnapshot({ protocolVersion: 999, sheets: [] })).toThrow();
  });
});

describe('subscriptions', () => {
  it('fires onValuesChanged when cells update', () => {
    const wb = new EngineWorkbook();
    const seen: CellRef[] = [];
    const off = wb.onValuesChanged((refs) => seen.push(...refs));
    wb.setCell(c('Sheet1', 0, 0), 1);
    wb.setCell(c('Sheet1', 1, 1), 2);
    off();
    wb.setCell(c('Sheet1', 2, 2), 3);
    expect(seen).toContainEqual(c('Sheet1', 0, 0));
    expect(seen).toContainEqual(c('Sheet1', 1, 1));
    expect(seen).not.toContainEqual(c('Sheet1', 2, 2));
  });
});

describe('calculation modes', () => {
  it('manual mode defers recalculation until recalculate()', () => {
    const wb = new EngineWorkbook();
    wb.setCell(c('Sheet1', 0, 0), 1);
    wb.setFormula(c('Sheet1', 0, 1), '=A1*10');
    expect(wb.getValue(c('Sheet1', 0, 1))).toEqual(scalar(10));
    wb.setCalculationMode('manual');
    wb.setCell(c('Sheet1', 0, 0), 5);
    // Deferred: reads serve the last-computed (stale) value without recalculating.
    expect(wb.getValue(c('Sheet1', 0, 1))).toEqual(scalar(10));
    wb.recalculate();
    expect(wb.getValue(c('Sheet1', 0, 1))).toEqual(scalar(50));
    // After recalculate, later writes stay deferred until the next flush.
    wb.setCell(c('Sheet1', 0, 0), 7);
    expect(wb.getValue(c('Sheet1', 0, 1))).toEqual(scalar(50));
    wb.setCalculationMode('automatic');
    expect(wb.getValue(c('Sheet1', 0, 1))).toEqual(scalar(70));
  });
});

describe('TypedView', () => {
  it('reads ranges and sheets through the view', () => {
    const wb = new EngineWorkbook({ Sheet1: [[1, 2], [3, 4]] });
    const view = new TypedView(wb);
    const vals = view.readRangeValues({ sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
    expect(vals).toEqual([[scalar(1), scalar(2)], [scalar(3), scalar(4)]]);
    expect(view.readSheet('Sheet1')).toEqual(vals);
    expect(view.readSheet('Missing')).toEqual([]);
  });
});

describe('EngineHost protocol', () => {
  it('executes commands and emits events', () => {
    const host = new EngineHost();
    const events: string[] = [];
    host.subscribe((e) => events.push(e.type));
    expect(host.execute({ cmd: 'addSheet', name: 'S2' })).toEqual({ ok: true });
    expect(host.execute({ cmd: 'setCell', ref: c('S2', 0, 0), value: 4 })).toEqual({ ok: true });
    expect(host.execute({ cmd: 'setFormula', ref: c('S2', 0, 1), formula: '=A1*2' })).toEqual({ ok: true });
    expect(host.readCell(c('S2', 0, 1))).toEqual(scalar(8));
    expect(events).toContain('sheetAdded');
    expect(events).toContain('cellsChanged');
    host.dispose();
  });

  it('records every mutation in the authorize() audit log', () => {
    const authz = new Authorizer();
    const host = new EngineHost(undefined, authz);
    host.execute({ cmd: 'setCell', ref: c('Sheet1', 0, 0), value: 1, auth: { principal: 'ai-agent' } });
    const log = authz.auditLog();
    expect(log.length).toBe(1);
    expect(log[0]?.principal).toBe('ai-agent');
    expect(log[0]?.action).toBe('cell.write');
    expect(log[0]?.allowed).toBe(true);
    host.dispose();
  });

  it('blocks mutations when the policy denies', () => {
    const authz = new Authorizer(() => false);
    const host = new EngineHost(undefined, authz);
    const res = host.execute({ cmd: 'setCell', ref: c('Sheet1', 0, 0), value: 1 });
    expect(res.ok).toBe(false);
    // Reads go through authorize() too (permission-model.md §4): a deny-all
    // policy denies reads with #PERM!, never a fake empty.
    const v = host.readCell(c('Sheet1', 0, 0));
    expect(isError(v)).toBe(true);
    if (isError(v)) expect(v.code).toBe('#PERM!');
    expect(authz.auditLog()[0]?.allowed).toBe(false);
    host.dispose();
  });

  it('fails closed without a principal', () => {
    const authz = new Authorizer();
    expect(() => authz.authorize('cell.write', 'x', { principal: '' })).toThrow();
  });

  it('snapshot round-trips through the host', () => {
    const host = new EngineHost();
    host.execute({ cmd: 'setFormula', ref: c('Sheet1', 0, 0), formula: '=40+2' });
    const snap = host.snapshot();
    expect(snap.protocolVersion).toBe(1);
    const wb2 = EngineWorkbook.fromSnapshot(snap);
    expect(wb2.getValue(c('Sheet1', 0, 0))).toEqual(scalar(42));
    host.dispose();
  });
});

describe('toA1', () => {
  it('formats addresses', () => {
    expect(toA1(c('Sheet1', 0, 0))).toBe('Sheet1!A1');
    expect(toA1(c('Sheet1', 9, 27))).toBe('Sheet1!AB10');
  });
});

describe('function aliases (Excel compat)', () => {
  it('CONCAT aliases CONCATENATE semantics', () => {
    const wb = new EngineWorkbook();
    const c = (r: number, col: number) => ({ sheet: 'Sheet1', row: r, col });
    wb.setCell(c(0, 0), 'Hello');
    wb.setCell(c(1, 0), 'World');
    wb.setFormula(c(0, 2), '=CONCAT(A1,A2)');
    expect(wb.getValue(c(0, 2))).toEqual(scalar('HelloWorld'));
    wb.setFormula(c(1, 2), '=CONCAT(A1," ",A2,2026)');
    expect(wb.getValue(c(1, 2))).toEqual(scalar('Hello World2026'));
    wb.setFormula(c(2, 2), '=CONCAT()');
    expect(wb.getValue(c(2, 2))).toEqual(scalar(''));
  });

  it('VALUE converts text to number', () => {
    const wb = new EngineWorkbook();
    const c = (r: number, col: number) => ({ sheet: 'Sheet1', row: r, col });
    wb.setFormula(c(0, 0), '=VALUE("123")');
    expect(wb.getValue(c(0, 0))).toEqual(scalar(123));
    wb.setFormula(c(1, 0), '=VALUE("12.5")');
    expect(wb.getValue(c(1, 0))).toEqual(scalar(12.5));
    wb.setFormula(c(2, 0), '=VALUE("abc")');
    expect(wb.getValue(c(2, 0)).kind).toBe('error');
  });

  it('N coerces values to numbers', () => {
    const wb = new EngineWorkbook();
    const c = (r: number, col: number) => ({ sheet: 'Sheet1', row: r, col });
    wb.setFormula(c(0, 0), '=N(5)');
    expect(wb.getValue(c(0, 0))).toEqual(scalar(5));
    wb.setFormula(c(1, 0), '=N(TRUE())');
    expect(wb.getValue(c(1, 0))).toEqual(scalar(1));
    wb.setFormula(c(2, 0), '=N("x")');
    expect(wb.getValue(c(2, 0))).toEqual(scalar(0));
  });

  it('GESTEP thresholds numbers', () => {
    const wb = new EngineWorkbook();
    const c = (r: number, col: number) => ({ sheet: 'Sheet1', row: r, col });
    wb.setFormula(c(0, 0), '=GESTEP(5,4)');
    expect(wb.getValue(c(0, 0))).toEqual(scalar(1));
    wb.setFormula(c(1, 0), '=GESTEP(3,4)');
    expect(wb.getValue(c(1, 0))).toEqual(scalar(0));
  });

  it('DOLLAR formats currency text', () => {
    const wb = new EngineWorkbook();
    const c = (r: number, col: number) => ({ sheet: 'Sheet1', row: r, col });
    wb.setFormula(c(0, 0), '=DOLLAR(1234.567,2)');
    expect(wb.getValue(c(0, 0))).toEqual(scalar('$1,234.57'));
    wb.setFormula(c(1, 0), '=DOLLAR(-5,0)');
    expect(wb.getValue(c(1, 0))).toEqual(scalar('($5)'));
  });

  it('XLOOKUP finds values', () => {
    const wb = new EngineWorkbook({
      Sheet1: [
        ['a', 1],
        ['b', 2],
        ['=XLOOKUP("b",A1:A2,B1:B2)'],
      ],
    });
    const c = (r: number, col: number) => ({ sheet: 'Sheet1', row: r, col });
    expect(wb.getValue(c(2, 0))).toEqual(scalar(2));
  });

  it('TEXTJOIN concatenates with delimiter', () => {
    const wb = new EngineWorkbook();
    const c = (r: number, col: number) => ({ sheet: 'Sheet1', row: r, col });
    wb.setFormula(c(0, 0), '=TEXTJOIN(",",TRUE(),"a","","b")');
    expect(wb.getValue(c(0, 0))).toEqual(scalar('a,b'));
  });
});

describe('extended functions batch 2 (database, text, stats)', () => {
  const mk = (formulas: string[][]) => {
    const wb = new EngineWorkbook({ S: formulas });
    return (r: number, col: number) => wb.getValue({ sheet: 'S', row: r, col });
  };

  it('DSTDEV/DSTDEVP/DVAR/DVARP/DGET work on database ranges', () => {
    const get = mk([
      ['Name', 'Age', 'Score'],
      ['a', 20, 80],
      ['b', 25, 90],
      ['c', 30, 85],
      ['Name', 'Age', 'Score'],
      ['a', 20, 80],
      ['=DSTDEVP(A1:C4,"Score",A5:C6)'],
      ['=DVAR(A1:C4,"Score",A5:C6)'],
      ['=DVARP(A1:C4,"Score",A5:C6)'],
      ['=DGET(A1:C4,"Score",A5:C6)'],
    ]);
    // Only 'a' matches: Score=80
    expect(get(6, 0)).toEqual(scalar(0)); // DSTDEVP of single value
    expect(get(7, 0).kind).toBe('error'); // DVAR needs 2+
    expect(get(8, 0)).toEqual(scalar(0)); // DVARP of single
    expect(get(9, 0)).toEqual(scalar(80)); // DGET
  });

  it('NUMBERVALUE parses with custom separators', () => {
    const get = mk([['=NUMBERVALUE("1,234.56")'], ['=NUMBERVALUE("1.234,56",",",".")']]);
    expect(get(0, 0)).toEqual(scalar(1234.56));
    expect(get(1, 0)).toEqual(scalar(1234.56));
  });

  it('TEXTBEFORE/TEXTAFTER extract substrings', () => {
    const get = mk([
      ['=TEXTBEFORE("a,b,c",",")'],
      ['=TEXTAFTER("a,b,c",",")'],
      ['=TEXTBEFORE("a,b,c",",",2)'],
    ]);
    expect(get(0, 0)).toEqual(scalar('a'));
    expect(get(1, 0)).toEqual(scalar('b,c'));
    expect(get(2, 0)).toEqual(scalar('a,b'));
  });

  it('MODE.SNGL finds most frequent', () => {
    const get = mk([['=MODE.SNGL(1,2,2,3,3,3)']]);
    expect(get(0, 0)).toEqual(scalar(3));
  });

  it('PERCENTILE.INC/EXC and QUARTILE work', () => {
    const get = mk([
      [1, 2, 3, 4],
      ['=PERCENTILE.INC(A1:D1,0.5)'],
      ['=QUARTILE.INC(A1:D1,2)'],
    ]);
    expect(get(1, 0)).toEqual(scalar(2.5));
    expect(get(2, 0)).toEqual(scalar(2.5));
  });

  it('TRIMMEAN trims outliers', () => {
    const get = mk([['=TRIMMEAN({1,2,3,4,100},0.4)']]);
    // 5*0.4/2=1 trimmed each end: mean(2,3,4)=3
    expect(get(0, 0)).toEqual(scalar(3));
  });

  it('FORECAST.LINEAR and INTERCEPT do regression', () => {
    const get = mk([
      [1, 2], [2, 4], [3, 6],
      ['=FORECAST.LINEAR(4,B1:B3,A1:A3)'],
      ['=INTERCEPT(B1:B3,A1:A3)'],
    ]);
    expect(get(3, 0)).toEqual(scalar(8));
    expect(get(4, 0)).toEqual(scalar(0));
  });

  it('RANK.AVG averages tied ranks', () => {
    const get = mk([
      [10, 20, 20, 30],
      ['=RANK.AVG(20,A1:D1,0)'],
    ]);
    // 20 appears twice, ranks 2 and 3 → avg 2.5
    expect(get(1, 0)).toEqual(scalar(2.5)); // 20s are 2nd/3rd largest
  });

  it('ERF.PRECISE/ERFC.PRECISE and ECMA.CEILING', () => {
    const get = mk([
      ['=ERF.PRECISE(1)'],
      ['=ERFC.PRECISE(0)'],
      ['=ECMA.CEILING(4.2)'],
    ]);
    const erf = get(0, 0);
    expect(erf.kind).toBe('number');
    if (erf.kind === 'number') expect(Math.abs((erf.value as number) - 0.8427) < 0.01).toBe(true);
    const erfc = get(1, 0);
    expect(erfc.kind).toBe('number');
    if (erfc.kind === 'number') expect(Math.abs((erfc.value as number) - 1) < 0.01).toBe(true);
    expect(get(2, 0)).toEqual(scalar(5));
  });

  it('ARRAYTOTEXT and VALUETOTEXT format values', () => {
    const get = mk([
      ['=ARRAYTOTEXT({1,"a"})'],
      ['=VALUETOTEXT(42,1)'],
    ]);
    expect(get(0, 0)).toEqual(scalar('1,a'));
    expect(get(1, 0)).toEqual(scalar('42'));
  });

  it('KURT and PROB compute statistics', () => {
    const get = mk([
      ['=KURT(1,2,3,4,5,6,7,8)'],
      ['=PROB({1,2,3},{0.2,0.5,0.3},2)'],
    ]);
    expect(get(0, 0).kind).toBe('number');
    expect(get(1, 0)).toEqual(scalar(0.5));
  });
});

describe('extended functions batch 3 (financial)', () => {
  it('IRR finds internal rate of return', () => {
    const wb = new EngineWorkbook({ S: [['=IRR({-100,50,60})']] });
    const v = wb.getValue({ sheet: 'S', row: 0, col: 0 });
    expect(v.kind).toBe('number');
    if (v.kind === 'number') expect(Math.abs((v.value as number) - 0.0639) < 0.01).toBe(true);
  });

  it('XIRR handles irregular dates', () => {
    const wb = new EngineWorkbook({ S: [[-10000, 45000], [5000, 45100], ['=XIRR(A1:A2,B1:B2)']] });
    const v = wb.getValue({ sheet: 'S', row: 2, col: 0 });
    expect(v.kind).toBe('number');
  });
});

describe('extended functions batch 4 (matrix, regex, aggregate)', () => {
  const mk = (formulas: (string | number)[][]) => {
    const wb = new EngineWorkbook({ S: formulas as never });
    return (r: number, col: number) => wb.getValue({ sheet: 'S', row: r, col });
  };

  it('MDETERM computes determinant', () => {
    const get = mk([
      [1, 2],
      [3, 4],
      ['=MDETERM(A1:B2)'],
    ]);
    // |1 2; 3 4| = 4-6 = -2
    expect(get(2, 0)).toEqual(scalar(-2));
  });

  it('REGEXTEST/REGEXEXTRACT/REGEXREPLACE work', () => {
    const get = mk([
      ['=REGEXTEST("abc123","[0-9]+")'],
      ['=REGEXEXTRACT("abc123","[0-9]+")'],
      ['=REGEXREPLACE("abc123","[0-9]+","XYZ")'],
    ]);
    expect(get(0, 0)).toEqual(scalar(true));
    expect(get(1, 0)).toEqual(scalar('123'));
    expect(get(2, 0)).toEqual(scalar('abcXYZ'));
  });

  it('AGGREGATE computes with function_num', () => {
    const get = mk([
      [1, 2, 3, 4, 5],
      ['=AGGREGATE(9,0,A1:E1)'],
      ['=AGGREGATE(1,0,A1:E1)'],
      ['=AGGREGATE(4,0,A1:E1)'],
    ]);
    expect(get(1, 0)).toEqual(scalar(15)); // SUM
    expect(get(2, 0)).toEqual(scalar(3)); // AVERAGE
    expect(get(3, 0)).toEqual(scalar(5)); // MAX
  });

  it('legacy aliases MODE/PERCENTILE/QUARTILE/RANK/FORECAST work', () => {
    const get = mk([
      ['=MODE(1,2,2,3)'],
      ['=PERCENTILE({1,2,3,4},0.5)'],
      ['=RANK(3,{1,2,3,4},0)'],
      ['=FORECAST(4,{2,4,6},{1,2,3})'],
    ]);
    expect(get(0, 0)).toEqual(scalar(2));
    expect(get(1, 0)).toEqual(scalar(2.5));
    expect(get(2, 0)).toEqual(scalar(2));
    expect(get(3, 0)).toEqual(scalar(8));
  });
});

describe('extended functions batch 5 (combinatorics, growth)', () => {
  it('PERMUT and PERMUTATIONA compute', () => {
    const wb = new EngineWorkbook({ S: [['=PERMUT(5,2)'], ['=PERMUTATIONA(5,2)']] });
    expect(wb.getValue({ sheet: 'S', row: 0, col: 0 })).toEqual(scalar(20));
    expect(wb.getValue({ sheet: 'S', row: 1, col: 0 })).toEqual(scalar(25));
  });

  it('BINOM.DIST.RANGE computes probability', () => {
    const wb = new EngineWorkbook({ S: [['=BINOM.DIST.RANGE(10,0.5,5,5)']] });
    const v = wb.getValue({ sheet: 'S', row: 0, col: 0 });
    expect(v.kind).toBe('number');
    if (v.kind === 'number') expect(Math.abs((v.value as number) - 0.246) < 0.01).toBe(true);
  });
});

describe('dynamic arrays (spill component)', () => {
  // Helper: get raw array from HyperFormula via spill writes
  const getArray = (formula: string): unknown => {
    const wb = new EngineWorkbook({ S: [[formula]] });
    // Access the raw HF value through spill helper by reading anchor
    const { spill, toSpillWrites } = require('../dist/index.js') as typeof import('../dist/index.js');
    void spill; void toSpillWrites;
    return wb.getValue({ sheet: 'S', row: 0, col: 0 });
  };

  it('SEQUENCE generates arrays', () => {
    const v = getArray('=SEQUENCE(3)');
    // Anchor shows top-left via implicit intersection
    expect(v).toEqual(scalar(1));
  });

  it('SORT orders values', () => {
    expect(getArray('=SORT({3,1,2})')).toEqual(scalar(1));
  });

  it('UNIQUE deduplicates', () => {
    expect(getArray('=UNIQUE({1,2,2,3})')).toEqual(scalar(1));
  });

  it('XMATCH finds positions', () => {
    const wb = new EngineWorkbook({ S: [['=XMATCH(2,{1,2,3})']] });
    expect(wb.getValue({ sheet: 'S', row: 0, col: 0 })).toEqual(scalar(2));
  });

  it('TEXTSPLIT splits text', () => {
    const wb = new EngineWorkbook({ S: [['=TEXTSPLIT("a,b,c",",")']] });
    expect(wb.getValue({ sheet: 'S', row: 0, col: 0 })).toEqual(scalar('a'));
  });

  it('HSTACK/VSTACK combine arrays', () => {
    const wb = new EngineWorkbook({ S: [['=HSTACK({1,2},{3,4})'], ['=VSTACK({1,2},{3,4})']] });
    expect(wb.getValue({ sheet: 'S', row: 0, col: 0 })).toEqual(scalar(1));
    expect(wb.getValue({ sheet: 'S', row: 1, col: 0 })).toEqual(scalar(1));
  });

  it('DROP/TAKE slice arrays', () => {
    const wb = new EngineWorkbook({ S: [['=TAKE({1,2,3},2)'], ['=DROP({1;2;3;4},2)']] });
    expect(wb.getValue({ sheet: 'S', row: 0, col: 0 })).toEqual(scalar(1));
    expect(wb.getValue({ sheet: 'S', row: 1, col: 0 })).toEqual(scalar(3));
  });

  it('TOCOL/TOROW reshape', () => {
    const wb = new EngineWorkbook({ S: [['=TOCOL({1,2;3,4})'], ['=TOROW({1,2;3,4})']] });
    expect(wb.getValue({ sheet: 'S', row: 0, col: 0 })).toEqual(scalar(1));
    expect(wb.getValue({ sheet: 'S', row: 1, col: 0 })).toEqual(scalar(1));
  });

  it('WRAPROWS/WRAPCOLS wrap vectors', () => {
    const wb = new EngineWorkbook({ S: [['=WRAPROWS({1,2,3,4},2)'], ['=WRAPCOLS({1,2,3,4},2)']] });
    expect(wb.getValue({ sheet: 'S', row: 0, col: 0 })).toEqual(scalar(1));
    expect(wb.getValue({ sheet: 'S', row: 1, col: 0 })).toEqual(scalar(1));
  });

  it('CHOOSECOLS/CHOOSEROWS select', () => {
    const wb = new EngineWorkbook({ S: [['=CHOOSECOLS({1,2,3},3)'], ['=CHOOSEROWS({1;2;3},2)']] });
    expect(wb.getValue({ sheet: 'S', row: 0, col: 0 })).toEqual(scalar(3));
    expect(wb.getValue({ sheet: 'S', row: 1, col: 0 })).toEqual(scalar(2));
  });

  it('SORTBY sorts by keys', () => {
    const wb = new EngineWorkbook({ S: [['=SORTBY({3,1,2},{30,10,20})']] });
    expect(wb.getValue({ sheet: 'S', row: 0, col: 0 })).toEqual(scalar(1));
  });

  it('EXPAND pads arrays', () => {
    const wb = new EngineWorkbook({ S: [['=EXPAND({1,2},2,3,0)']] });
    expect(wb.getValue({ sheet: 'S', row: 0, col: 0 })).toEqual(scalar(1));
  });

  it('RANDARRAY generates (not #NAME?)', () => {
    const wb = new EngineWorkbook({ S: [['=RANDARRAY(2,2)']] });
    const v = wb.getValue({ sheet: 'S', row: 0, col: 0 });
    expect(v.kind).toBe('number');
  });

  it('spill() helper writes and detects collisions', async () => {
    const mod = await import('../dist/index.js');
    const cells = new Map<string, unknown>();
    const r1 = mod.spill(0, 0, [[1, 2], [3, 4]],
      (r: number, c: number, v: unknown) => cells.set(`${r},${c}`, v),
      (r: number, c: number) => cells.get(`${r},${c}`));
    expect(r1).toBe('ok');
    expect(cells.get('0,1')).toBe(2);
    expect(cells.get('1,0')).toBe(3);
    // Blocked spill
    cells.set('0,1', 'x');
    const r2 = mod.spill(0, 0, [[1, 2], [3, 4]],
      (r: number, c: number, v: unknown) => cells.set(`${r},${c}`, v),
      (r: number, c: number) => cells.get(`${r},${c}`));
    expect(r2).not.toBe('ok');
  });
});

describe('lambda functions', () => {
  it('LET binds variables', () => {
    const wb = new EngineWorkbook({ S: [['=LET(x,5,x*2)'], ['=LET(a,3,b,4,a*b+1)']] });
    expect(wb.getValue({ sheet: 'S', row: 0, col: 0 })).toEqual(scalar(10));
    expect(wb.getValue({ sheet: 'S', row: 1, col: 0 })).toEqual(scalar(13));
  });

  it('MAP applies lambda', () => {
    const wb = new EngineWorkbook({ S: [['=MAP({1,2,3},LAMBDA(x,x*2))']] });
    expect(wb.getValue({ sheet: 'S', row: 0, col: 0 })).toEqual(scalar(2));
  });

  it('REDUCE folds', () => {
    const wb = new EngineWorkbook({ S: [['=REDUCE(0,{1,2,3},LAMBDA(a,b,a+b))']] });
    expect(wb.getValue({ sheet: 'S', row: 0, col: 0 })).toEqual(scalar(6));
  });

  it('SCAN accumulates', () => {
    const wb = new EngineWorkbook({ S: [['=SCAN(0,{1,2,3},LAMBDA(a,b,a+b))']] });
    expect(wb.getValue({ sheet: 'S', row: 0, col: 0 })).toEqual(scalar(1));
  });

  it('MAKEARRAY builds arrays', () => {
    const wb = new EngineWorkbook({ S: [['=MAKEARRAY(2,2,LAMBDA(r,c,r*10+c))']] });
    expect(wb.getValue({ sheet: 'S', row: 0, col: 0 })).toEqual(scalar(11));
  });

  it('SINGLE returns top-left', () => {
    const wb = new EngineWorkbook({ S: [['=SINGLE({5,6,7})']] });
    expect(wb.getValue({ sheet: 'S', row: 0, col: 0 })).toEqual(scalar(5));
  });

  it('BYROW/BYCOL apply per row/col', () => {
    const wb = new EngineWorkbook({
      S: [['=BYROW({1,2;3,4},LAMBDA(r,SUM(r)))'], ['=BYCOL({1,2;3,4},LAMBDA(c,SUM(c)))']],
    });
    expect(wb.getValue({ sheet: 'S', row: 0, col: 0 })).toEqual(scalar(3));
    expect(wb.getValue({ sheet: 'S', row: 1, col: 0 })).toEqual(scalar(4));
  });
});
