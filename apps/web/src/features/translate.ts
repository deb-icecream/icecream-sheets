/**
 * Translate (Review > Language > Translate).
 *
 * Translation runs through the ENGINE's TRANSLATE function
 * (packages/engine/src/extended-functions10.ts): the dialog writes
 * =TRANSLATE("text","src","tgt") into a scratch sheet and reads the
 * computed value, so the pluggable TranslatorProvider seam (bundled
 * phrasebook by default, network provider when installed) is honored.
 * This module holds the pure helpers: language list, formula building
 * with Excel string escaping, and result parsing.
 */

import type { TypedValue } from '@icecream-sheets/engine';
import { typedValueText } from './typedText';

export interface TranslateLang {
  code: string;
  name: string;
}

/** Languages the bundled engine phrasebook pivots through (English pivot). */
export const TRANSLATE_LANGS: TranslateLang[] = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
];

/** The scratch sheet TranslateDialog evaluates formulas in. */
export const TRANSLATE_SCRATCH_SHEET = '__translate__';

/** Escape a string for embedding in a formula literal (double the quotes). */
export function escapeFormulaString(text: string): string {
  return text.replace(/"/g, '""');
}

/**
 * Build =TRANSLATE("text","src","tgt"). Pass source=null for
 * auto-detection (DETECTLANGUAGE inside the engine).
 */
export function buildTranslateFormula(text: string, source: string | null, target: string): string {
  const t = `"${escapeFormulaString(text)}"`;
  const s = source ? `,"${escapeFormulaString(source)}"` : '';
  return `=TRANSLATE(${t}${s},"${escapeFormulaString(target)}")`;
}

/** Render the engine's computed value (or error code) as display text. */
export function renderTranslateResult(value: TypedValue): string {
  return typedValueText(value);
}

/** True when the engine returned an error value instead of a translation. */
export function isTranslateError(value: TypedValue): boolean {
  return value.kind === 'error';
}
