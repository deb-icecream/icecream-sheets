/**
 * End-to-end tests for formula localization (track 22).
 *
 * Covers: all 7 locales registered with HyperFormula, parsing localized
 * function names (native + custom plugin functions), runtime language
 * switching with display re-localization, and the CJK safety property
 * (switching through jaJP/zhCN must not corrupt formulas — HyperFormula's
 * lexer cannot parse CJK procedure names, so those packs keep English
 * function names).
 */
import { describe, expect, it } from 'vitest';
import { HyperFormula } from 'hyperformula';
import {
  EngineHost,
  EngineWorkbook,
  SUPPORTED_LOCALES,
  registerLocales,
  type CellRef,
} from '../src/index.js';

const c = (sheet: string, row: number, col: number): CellRef => ({ sheet, row, col });

describe('formula localization end-to-end', () => {
  it('registers all 7 locales with HyperFormula', () => {
    registerLocales(); // idempotent
    expect(SUPPORTED_LOCALES).toHaveLength(7);
    for (const { id } of SUPPORTED_LOCALES) {
      expect(() => HyperFormula.getLanguage(id)).not.toThrow();
    }
  });

  it('parses Spanish function names when built with language esES', () => {
    const wb = new EngineWorkbook({ S: [[1], [2], [3]] }, { language: 'esES' });
    wb.setFormula(c('S', 3, 0), '=SUMA(A1:A3)');
    expect(wb.getValue(c('S', 3, 0))).toEqual({ kind: 'number', value: 6 });
    expect(wb.getFormula(c('S', 3, 0))).toBe('=SUMA(A1:A3)');
  });

  it('parses custom plugin functions by their localized name', () => {
    const wb = new EngineWorkbook({ S: [[10], [20], [30]] }, { language: 'esES' });
    // XLOOKUP -> BUSCARX (custom translation overlaid on the esES pack).
    wb.setFormula(c('S', 3, 0), '=BUSCARX(20,A1:A3,A1:A3)');
    expect(wb.getValue(c('S', 3, 0))).toEqual({ kind: 'number', value: 20 });
  });

  it('plugin translations apply under enUS (registered before plugins load)', () => {
    const wb = new EngineWorkbook({ S: [[10], [20]] }, { language: 'enUS' });
    wb.setFormula(c('S', 2, 0), '=XLOOKUP(20,A1:A2,A1:A2)');
    expect(wb.getValue(c('S', 2, 0))).toEqual({ kind: 'number', value: 20 });
  });

  it('setFormulaLanguage re-localizes display and preserves values', () => {
    const wb = new EngineWorkbook({ S: [[1], [2]] });
    wb.setFormula(c('S', 2, 0), '=SUM(A1:A2)');
    expect(wb.getFormulaLanguage()).toBe('enGB');

    wb.setFormulaLanguage('deDE');
    expect(wb.getFormulaLanguage()).toBe('deDE');
    expect(wb.getFormula(c('S', 2, 0))).toBe('=SUMME(A1:A2)');
    expect(wb.getValue(c('S', 2, 0))).toEqual({ kind: 'number', value: 3 });

    wb.setFormulaLanguage('frFR');
    expect(wb.getFormula(c('S', 2, 0))).toBe('=SOMME(A1:A2)');
    expect(wb.getValue(c('S', 2, 0))).toEqual({ kind: 'number', value: 3 });
  });

  it('localized custom functions survive language switches', () => {
    const wb = new EngineWorkbook({ S: [[1], [2], [3]] });
    wb.setFormula(c('S', 3, 0), '=XLOOKUP(2,A1:A3,A1:A3)');
    wb.setFormulaLanguage('esES');
    expect(wb.getFormula(c('S', 3, 0))).toBe('=BUSCARX(2,A1:A3,A1:A3)');
    expect(wb.getValue(c('S', 3, 0))).toEqual({ kind: 'number', value: 2 });
    wb.setFormulaLanguage('enGB');
    expect(wb.getFormula(c('S', 3, 0))).toBe('=XLOOKUP(2,A1:A3,A1:A3)');
    expect(wb.getValue(c('S', 3, 0))).toEqual({ kind: 'number', value: 2 });
  });

  it('switching through jaJP/zhCN does not corrupt formulas', () => {
    const wb = new EngineWorkbook({ S: [[4], [5]] });
    wb.setFormula(c('S', 2, 0), '=SUM(A1:A2)');
    // CJK packs keep English function names: formulas stay parseable.
    wb.setFormulaLanguage('jaJP');
    expect(wb.getFormula(c('S', 2, 0))).toBe('=SUM(A1:A2)');
    expect(wb.getValue(c('S', 2, 0))).toEqual({ kind: 'number', value: 9 });
    wb.setFormulaLanguage('zhCN');
    expect(wb.getValue(c('S', 2, 0))).toEqual({ kind: 'number', value: 9 });
    wb.setFormulaLanguage('esES');
    expect(wb.getFormula(c('S', 2, 0))).toBe('=SUMA(A1:A2)');
    expect(wb.getValue(c('S', 2, 0))).toEqual({ kind: 'number', value: 9 });
  });

  it('new formulas are parsed in the active locale', () => {
    const wb = new EngineWorkbook({ S: [[7], [8]] });
    wb.setFormulaLanguage('deDE');
    wb.setFormula(c('S', 2, 0), '=SUMME(A1:A2)');
    expect(wb.getValue(c('S', 2, 0))).toEqual({ kind: 'number', value: 15 });
  });

  it('EngineHost exposes set/getFormulaLanguage', () => {
    const host = new EngineHost();
    expect(host.getFormulaLanguage()).toBe('enGB');
    let events = 0;
    host.subscribe(() => {
      events++;
    });
    host.setFormulaLanguage('frFR');
    expect(host.getFormulaLanguage()).toBe('frFR');
    // Switching emits so hosts refresh their views.
    expect(events).toBeGreaterThan(0);
  });
});
