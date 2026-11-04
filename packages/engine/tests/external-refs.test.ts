/**
 * External workbook references ([N]Sheet!Ref): parse-time rewrite to the
 * ICEEXTREF dispatcher, evaluation-time resolution through the link table
 * (live provider -> cached values -> #REF!), and transparent unrewrite.
 */
import { describe, expect, it } from 'vitest';
// Plugin errors carry messages; compare the error code only.
const errCode = (v: unknown): string | undefined =>
  typeof v === 'object' && v !== null && (v as { kind?: string }).kind === 'error'
    ? (v as { code?: string }).code
    : undefined;
import {
  EngineWorkbook,
  ExternalWorkbookRegistry,
  defaultExternalRegistry,
  rewriteExternalRefs,
  scalar,
  unrewriteExternalRefs,
  type CellRef,
  type ExternalLink,
} from '../src/index.js';

const c = (sheet: string, row: number, col: number): CellRef => ({ sheet, row, col });

const BOOK1: ExternalLink = {
  index: 1,
  target: 'book1.xlsx',
  targetMode: 'External',
  sheets: ['Sheet1'],
  cachedValues: { 'Sheet1\x00A1': 'hello world' },
};

const DATA: ExternalLink = {
  index: 1,
  target: 'data.xlsx',
  sheets: ['Sheet1', 'Sheet2', 'Sheet3'],
  cachedValues: {
    'Sheet1\x00A1': 'Name',
    'Sheet1\x00A2': 'Andy',
    'Sheet1\x00A3': 'Bruce',
    'Sheet1\x00A4': 'Charlie',
    'Sheet1\x00B2': 42,
    'Sheet1\x00B3': 43,
    'Sheet1\x00B4': 44,
    'Sheet1\x00C1': true,
  },
};

describe('rewriteExternalRefs', () => {
  it('rewrites index-form single-cell refs', () => {
    expect(rewriteExternalRefs('=[1]Sheet1!$A$1')).toBe('=ICEEXTREF(1,"Sheet1","$A$1")');
  });
  it('rewrites quoted sheet names', () => {
    expect(rewriteExternalRefs("=[1]'My Sheet'!A1")).toBe('=ICEEXTREF(1,"My Sheet","A1")');
  });
  it('rewrites filename-form refs', () => {
    expect(rewriteExternalRefs("='[Budget.xlsx]Sheet1'!A1")).toBe(
      '=ICEEXTREF("Budget.xlsx","Sheet1","A1")',
    );
  });
  it('rewrites range refs', () => {
    expect(rewriteExternalRefs('=SUM([1]Sheet1!A1:A3)')).toBe('=SUM(ICEEXTREF(1,"Sheet1","A1:A3"))');
  });
  it('rewrites external defined names', () => {
    expect(rewriteExternalRefs('=[1]!MyName')).toBe('=ICEEXTREF(1,"","MyName")');
  });
  it('rewrites 3D refs', () => {
    expect(rewriteExternalRefs('=[1]Sheet1:Sheet3!A1')).toBe('=ICEEXTREF(1,"Sheet1:Sheet3","A1")');
  });
  it('rewrites multiple refs in one formula', () => {
    expect(rewriteExternalRefs('=[1]Sheet1!$A$1+[2]Data!B2')).toBe(
      '=ICEEXTREF(1,"Sheet1","$A$1")+ICEEXTREF(2,"Data","B2")',
    );
  });
  it('leaves string literals alone', () => {
    expect(rewriteExternalRefs('="[1]Sheet1!A1"')).toBe('="[1]Sheet1!A1"');
  });
  it('leaves ordinary formulas alone', () => {
    expect(rewriteExternalRefs('=SUM(A1:A3)+Sheet2!B2')).toBe('=SUM(A1:A3)+Sheet2!B2');
  });
  it('unparseable external shapes become #REF!, not parse errors', () => {
    expect(rewriteExternalRefs('=[1]Sheet1!')).toBe('=#REF!');
  });
});

describe('unrewriteExternalRefs', () => {
  it('round-trips index form exactly', () => {
    const f = '=[1]Sheet1!$A$1';
    expect(unrewriteExternalRefs(rewriteExternalRefs(f))).toBe(f);
  });
  it('round-trips quoted sheets, ranges, names, 3D, filename form', () => {
    for (const f of [
      "=[1]'My Sheet'!A1",
      '=SUM([1]Sheet1!A1:A3)',
      '=[1]!MyName',
      '=[1]Sheet1:Sheet3!A1',
      "='[Budget.xlsx]Sheet1'!A1",
      '=[1]Sheet1!$A$1+[2]Data!B2',
    ]) {
      expect(unrewriteExternalRefs(rewriteExternalRefs(f))).toBe(f);
    }
  });
  it('quotes sheet names that need quoting', () => {
    expect(unrewriteExternalRefs('=ICEEXTREF(1,"My Sheet","A1")')).toBe("=[1]'My Sheet'!A1");
  });
});

describe('ICEEXTREF evaluation', () => {
  it('resolves cached values for a missing external file', () => {
    const wb = new EngineWorkbook({ Sheet1: [['=[1]Sheet1!$A$1']] }, { externalLinks: [BOOK1] });
    expect(wb.getValue(c('Sheet1', 0, 0))).toEqual(scalar('hello world'));
  });
  it('resolves several cached cells from one link', () => {
    const wb = new EngineWorkbook(
      {
        Sheet1: [
          ['=[1]Sheet1!A1', '=[1]Sheet1!B2', '=[1]Sheet1!C1'],
          ['=[1]Sheet1!A4', '=[1]Sheet1!B4', '=[1]Sheet1!B2:B4'],
        ],
      },
      { externalLinks: [DATA] },
    );
    expect(wb.getValue(c('Sheet1', 0, 0))).toEqual(scalar('Name'));
    expect(wb.getValue(c('Sheet1', 0, 1))).toEqual(scalar(42));
    expect(wb.getValue(c('Sheet1', 0, 2))).toEqual(scalar(true));
    expect(wb.getValue(c('Sheet1', 1, 0))).toEqual(scalar('Charlie'));
    // Range ref: the anchor shows the top-left value, like every
    // array-returning function in the engine (cf. SEQUENCE).
    expect(wb.getValue(c('Sheet1', 1, 2))).toEqual(scalar(42));
  });
  it('matches sheet names case-insensitively', () => {
    const wb = new EngineWorkbook({ S: [['=[1]sheet1!A1']] }, { externalLinks: [DATA] });
    expect(wb.getValue(c('S', 0, 0))).toEqual(scalar('Name'));
  });
  it('returns #REF! for an unknown link index', () => {
    const wb = new EngineWorkbook({ Sheet1: [['=[9]Sheet1!A1']] }, { externalLinks: [BOOK1] });
    expect(errCode(wb.getValue(c('Sheet1', 0, 0)))).toBe('#REF!');
  });
  it('returns #REF! when there is no cached value', () => {
    const wb = new EngineWorkbook({ Sheet1: [['=[1]Sheet1!Z99']] }, { externalLinks: [BOOK1] });
    expect(errCode(wb.getValue(c('Sheet1', 0, 0)))).toBe('#REF!');
  });
  it('returns #REF! for an unknown sheet in the link', () => {
    const wb = new EngineWorkbook({ Sheet1: [['=[1]Nope!A1']] }, { externalLinks: [BOOK1] });
    expect(errCode(wb.getValue(c('Sheet1', 0, 0)))).toBe('#REF!');
  });
  it('returns #REF! when no links are registered at all', () => {
    const wb = new EngineWorkbook({ Sheet1: [['=[1]Sheet1!A1']] });
    expect(errCode(wb.getValue(c('Sheet1', 0, 0)))).toBe('#REF!');
  });
  it('resolves filename-form refs through target matching', () => {
    const wb = new EngineWorkbook(
      { Sheet1: [["='[book1.xlsx]Sheet1'!$A$1"]] },
      { externalLinks: [BOOK1] },
    );
    expect(wb.getValue(c('Sheet1', 0, 0))).toEqual(scalar('hello world'));
  });
  it('resolves external defined names', () => {
    const link: ExternalLink = {
      ...BOOK1,
      definedNames: { MyName: 123 },
    };
    const wb = new EngineWorkbook({ Sheet1: [['=[1]!MyName']] }, { externalLinks: [link] });
    expect(wb.getValue(c('Sheet1', 0, 0))).toEqual(scalar(123));
  });
  it('resolves 3D refs across sheets', () => {
    const link: ExternalLink = {
      index: 1,
      target: 'm.xlsx',
      sheets: ['S1', 'S2', 'S3'],
      cachedValues: { 'S1\x00A1': 1, 'S2\x00A1': 2, 'S3\x00A1': 3 },
    };
    const wb = new EngineWorkbook({ Sheet1: [['=[1]S1:S3!A1']] }, { externalLinks: [link] });
    // 3D ref resolves to one row per sheet; the anchor shows the first
    // sheet's value (SUM over a function-returned array is an engine-wide
    // HyperFormula limitation — SUM(SEQUENCE(3)) behaves the same).
    expect(wb.getValue(c('Sheet1', 0, 0))).toEqual(scalar(1));
  });
  it('keeps the user-visible formula text', () => {
    const wb = new EngineWorkbook({ Sheet1: [['=[1]Sheet1!$A$1']] }, { externalLinks: [BOOK1] });
    expect(wb.getFormula(c('Sheet1', 0, 0))).toBe('=[1]Sheet1!$A$1');
    expect(wb.getSerialized(c('Sheet1', 0, 0))).toBe('=[1]Sheet1!$A$1');
  });
  it('propagates cached error values', () => {
    const link: ExternalLink = {
      index: 1,
      target: 'e.xlsx',
      sheets: ['S'],
      cachedValues: { 'S\x00A1': '#DIV/0!' },
    };
    const wb = new EngineWorkbook({ Sheet1: [['=[1]S!A1']] }, { externalLinks: [link] });
    expect(errCode(wb.getValue(c('Sheet1', 0, 0)))).toBe('#DIV/0!');
  });
  it('survives setFormulaLanguage (web app re-applies the UI language on open)', () => {
    // Regression: the app builds the workbook (default enGB) then calls
    // setFormulaLanguage('enUS') on host replacement. HyperFormula's
    // updateConfig recomputes every formula; the ICEEXTREF dispatcher must
    // see the workbook's external-link table during that recompute, or the
    // cached value degrades to #REF! ("no external links are registered").
    const wb = new EngineWorkbook({ Sheet1: [[null, '=[1]Sheet1!$A$1']] }, { externalLinks: [BOOK1] });
    expect(wb.getValue(c('Sheet1', 0, 1))).toEqual(scalar('hello world'));
    wb.setFormulaLanguage('enUS');
    expect(wb.getValue(c('Sheet1', 0, 1))).toEqual(scalar('hello world'));
    expect(wb.getFormula(c('Sheet1', 0, 1))).toBe('=[1]Sheet1!$A$1');
    // And back again.
    wb.setFormulaLanguage('enGB');
    expect(wb.getValue(c('Sheet1', 0, 1))).toEqual(scalar('hello world'));
  });
});

describe('live external-workbook providers', () => {
  it('a registered provider wins over cached values', () => {
    const registry = new ExternalWorkbookRegistry();
    registry.register('book1.xlsx', {
      getCellValue: (sheet, ref) => (sheet === 'Sheet1' && ref === 'A1' ? 'LIVE' : undefined),
    });
    const wb = new EngineWorkbook(
      { Sheet1: [['=[1]Sheet1!$A$1']] },
      { externalLinks: [BOOK1], externalRegistry: registry },
    );
    expect(wb.getValue(c('Sheet1', 0, 0))).toEqual(scalar('LIVE'));
    expect(wb.usesLiveExternalProviders()).toBe(true);
  });
  it('unregistering falls back to cached values', () => {
    const registry = new ExternalWorkbookRegistry();
    registry.register('book1.xlsx', { getCellValue: () => 'LIVE' });
    const wb = new EngineWorkbook(
      { Sheet1: [['=[1]Sheet1!$A$1']] },
      { externalLinks: [BOOK1], externalRegistry: registry },
    );
    expect(wb.getValue(c('Sheet1', 0, 0))).toEqual(scalar('LIVE'));
    registry.unregister('book1.xlsx');
    // No formula edits needed: the refresh seam re-evaluates every
    // external reference against the now-providerless registry.
    wb.refreshExternalLinks();
    expect(wb.getValue(c('Sheet1', 0, 0))).toEqual(scalar('hello world'));
    expect(wb.usesLiveExternalProviders()).toBe(false);
  });
  it('matches providers by basename', () => {
    const registry = new ExternalWorkbookRegistry();
    registry.register('book1.xlsx', { getCellValue: () => 'BY-BASENAME' });
    const link: ExternalLink = { ...BOOK1, target: '../data/book1.xlsx' };
    const wb = new EngineWorkbook(
      { Sheet1: [['=[1]Sheet1!$A$1']] },
      { externalLinks: [link], externalRegistry: registry },
    );
    expect(wb.getValue(c('Sheet1', 0, 0))).toEqual(scalar('BY-BASENAME'));
  });
  it('the default registry is used when no registry is given', () => {
    defaultExternalRegistry.register('book1.xlsx', { getCellValue: () => 'DEFAULT-REG' });
    try {
      const wb = new EngineWorkbook({ Sheet1: [['=[1]Sheet1!$A$1']] }, { externalLinks: [BOOK1] });
      expect(wb.getValue(c('Sheet1', 0, 0))).toEqual(scalar('DEFAULT-REG'));
    } finally {
      defaultExternalRegistry.unregister('book1.xlsx');
    }
  });
});

describe('ICEEXTREF hygiene', () => {
  it('rejects ICEEXTREF as a user-defined function name', () => {
    const wb = new EngineWorkbook({});
    expect(() => wb.defineNamedFunction('ICEEXTREF', '=LAMBDA(x,x)')).toThrow(/reserved/i);
  });
  it('does not leak the dispatcher into snapshots', () => {
    const wb = new EngineWorkbook({ Sheet1: [['=[1]Sheet1!$A$1']] }, { externalLinks: [BOOK1] });
    const snap = wb.toSnapshot();
    const cell = snap.sheets[0]!.cells[0]!;
    expect(cell.input).toBe('=[1]Sheet1!$A$1');
  });
});
