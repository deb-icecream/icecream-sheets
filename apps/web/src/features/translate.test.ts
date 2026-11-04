import { describe, expect, it } from 'vitest';
import { scalar } from '@icecream-sheets/engine';
import {
  buildTranslateFormula,
  escapeFormulaString,
  isTranslateError,
  renderTranslateResult,
  TRANSLATE_LANGS,
} from './translate';

describe('translate helpers', () => {
  it('escapes embedded quotes', () => {
    expect(escapeFormulaString('say "hi"')).toBe('say ""hi""');
  });
  it('builds TRANSLATE with explicit source', () => {
    expect(buildTranslateFormula('hello', 'en', 'es')).toBe('=TRANSLATE("hello","en","es")');
  });
  it('builds TRANSLATE with auto-detect (no source arg)', () => {
    expect(buildTranslateFormula('hello', null, 'fr')).toBe('=TRANSLATE("hello","fr")');
  });
  it('escapes quotes inside the formula', () => {
    expect(buildTranslateFormula('say "hi"', 'en', 'es')).toBe('=TRANSLATE("say ""hi""","en","es")');
  });
  it('renders scalar results', () => {
    expect(renderTranslateResult(scalar('hola'))).toBe('hola');
    expect(renderTranslateResult(scalar(42))).toBe('42');
  });
  it('detects error values', () => {
    expect(isTranslateError({ kind: 'error', code: '#VALUE!' })).toBe(true);
    expect(isTranslateError(scalar('hola'))).toBe(false);
  });
  it('lists the phrasebook languages', () => {
    expect(TRANSLATE_LANGS.map((l) => l.code)).toEqual(['en', 'es', 'fr', 'de', 'it', 'pt']);
  });
});
