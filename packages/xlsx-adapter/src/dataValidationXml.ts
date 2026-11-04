/**
 * Native data-validation round-trip (`<dataValidations><dataValidation>`,
 * ISO/IEC 29500 §18.3.1.32; audit §6.1).
 *
 * Model (on SheetData): `dataValidations` — one entry per
 * `<dataValidation>` element with the full attribute surface (type,
 * operator, allowBlank, showDropDown, input/error message switches,
 * error style, prompt/error title+text) and `formula1`/`formula2` bodies
 * carried as BARE formulas (storage `_xlfn.` prefixes are stripped on
 * parse and re-applied on write via futureFunctions.ts, matching the
 * cell-formula convention). `sqref` is the normalized space-separated
 * range list — multi-range validations keep every range.
 *
 * Note on `showDropDown`: OOXML's semantics are inverted vs. its name
 * (absent/0 = the in-cell dropdown IS shown; 1 = suppressed). The model
 * carries the raw stored meaning — `showDropDown: false` in the model
 * means the attribute was absent or "0" (dropdown shown). Callers must
 * not "fix" this; it is the file format's own convention.
 */
import {
  boolAttrValue,
  elementBody,
  escapeXmlAttr,
  escapeXmlText,
  findBlock,
  normalizeSqref,
  splitTopElements,
} from './nativeXmlUtil.js';
import { prefixFutureFunctions, stripFuturePrefixes } from './futureFunctions.js';

export type DataValidationType =
  | 'none' | 'whole' | 'decimal' | 'list' | 'date' | 'time' | 'textLength' | 'custom';

export type DataValidationOperator =
  | 'between' | 'notBetween' | 'equal' | 'notEqual'
  | 'lessThan' | 'lessThanOrEqual' | 'greaterThan' | 'greaterThanOrEqual';

export type DataValidationErrorStyle = 'stop' | 'warning' | 'information';

export interface NativeDataValidation {
  type: DataValidationType;
  operator?: DataValidationOperator;
  errorStyle?: DataValidationErrorStyle;
  allowBlank?: boolean;
  /** Raw OOXML meaning (see header): false/absent = dropdown shown. */
  showDropDown?: boolean;
  showErrorMessage?: boolean;
  showInputMessage?: boolean;
  errorTitle?: string;
  error?: string;
  promptTitle?: string;
  prompt?: string;
  /** Bare formula text (a quoted list `"a,b,c"`, a range ref, or an expression). */
  formula1?: string;
  formula2?: string;
  /** Normalized space-separated range list, e.g. 'A1:A5 C1:C5'. */
  sqref: string;
}

const TYPES: ReadonlySet<string> = new Set([
  'none', 'whole', 'decimal', 'list', 'date', 'time', 'textLength', 'custom',
]);
const OPERATORS: ReadonlySet<string> = new Set([
  'between', 'notBetween', 'equal', 'notEqual',
  'lessThan', 'lessThanOrEqual', 'greaterThan', 'greaterThanOrEqual',
]);
const ERROR_STYLES: ReadonlySet<string> = new Set(['stop', 'warning', 'information']);

/** Parse `<dataValidations>` from a worksheet XML string. */
export function parseDataValidations(sheetXml: string): NativeDataValidation[] {
  const block = findBlock(sheetXml, 'dataValidations');
  if (!block) return [];
  const out: NativeDataValidation[] = [];
  for (const el of splitTopElements(block.inner, 'dataValidation')) {
    const openTag = /^<dataValidation\b[^>]*>/.exec(el)?.[0] ?? '';
    const a = (name: string): string | undefined => {
      const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(openTag);
      return m?.[1];
    };
    const type = a('type') ?? 'none';
    if (!TYPES.has(type)) continue;
    const sqref = a('sqref');
    if (!sqref) continue;
    const dv: NativeDataValidation = { type: type as DataValidationType, sqref: normalizeSqref(sqref) };
    const op = a('operator');
    if (op && OPERATORS.has(op)) dv.operator = op as DataValidationOperator;
    const es = a('errorStyle');
    if (es && ERROR_STYLES.has(es)) dv.errorStyle = es as DataValidationErrorStyle;
    const ab = a('allowBlank');
    if (ab !== undefined) dv.allowBlank = boolAttrValue(ab, false);
    const dd = a('showDropDown');
    if (dd !== undefined) dv.showDropDown = boolAttrValue(dd, false);
    const se = a('showErrorMessage');
    if (se !== undefined) dv.showErrorMessage = boolAttrValue(se, false);
    const si = a('showInputMessage');
    if (si !== undefined) dv.showInputMessage = boolAttrValue(si, false);
    const dec = (v: string | undefined): string | undefined =>
      v === undefined ? undefined : elementBody(`<x>${v}</x>`);
    dv.errorTitle = dec(a('errorTitle'));
    dv.error = dec(a('error'));
    dv.promptTitle = dec(a('promptTitle'));
    dv.prompt = dec(a('prompt'));
    if (dv.errorTitle === undefined) delete dv.errorTitle;
    if (dv.error === undefined) delete dv.error;
    if (dv.promptTitle === undefined) delete dv.promptTitle;
    if (dv.prompt === undefined) delete dv.prompt;
    for (const fTag of ['formula1', 'formula2'] as const) {
      const fBlock = findBlock(el, fTag);
      if (fBlock) {
        const text = stripFuturePrefixes(elementBody(fBlock.whole).trim());
        if (text !== '') dv[fTag] = text;
      }
    }
    out.push(dv);
  }
  return out;
}

/** Serialize one `<dataValidation>` element. */
export function dataValidationToXml(dv: NativeDataValidation): string {
  const attrs: string[] = [];
  if (dv.type !== 'none') attrs.push(`type="${dv.type}"`);
  if (dv.errorStyle !== undefined && dv.errorStyle !== 'stop') attrs.push(`errorStyle="${dv.errorStyle}"`);
  if (dv.operator !== undefined) attrs.push(`operator="${dv.operator}"`);
  if (dv.allowBlank) attrs.push('allowBlank="1"');
  if (dv.showDropDown) attrs.push('showDropDown="1"');
  if (dv.showInputMessage) attrs.push('showInputMessage="1"');
  if (dv.showErrorMessage) attrs.push('showErrorMessage="1"');
  if (dv.promptTitle !== undefined) attrs.push(`promptTitle="${escapeXmlAttr(dv.promptTitle)}"`);
  if (dv.prompt !== undefined) attrs.push(`prompt="${escapeXmlAttr(dv.prompt)}"`);
  if (dv.errorTitle !== undefined) attrs.push(`errorTitle="${escapeXmlAttr(dv.errorTitle)}"`);
  if (dv.error !== undefined) attrs.push(`error="${escapeXmlAttr(dv.error)}"`);
  attrs.push(`sqref="${escapeXmlAttr(normalizeSqref(dv.sqref))}"`);
  const kids =
    (dv.formula1 !== undefined ? `<formula1>${escapeXmlText(prefixFutureFunctions(dv.formula1))}</formula1>` : '') +
    (dv.formula2 !== undefined ? `<formula2>${escapeXmlText(prefixFutureFunctions(dv.formula2))}</formula2>` : '');
  return kids === ''
    ? `<dataValidation ${attrs.join(' ')}/>`
    : `<dataValidation ${attrs.join(' ')}>${kids}</dataValidation>`;
}

/** Serialize the whole `<dataValidations>` block ('' when empty). */
export function dataValidationsToXml(dvs: readonly NativeDataValidation[]): string {
  if (dvs.length === 0) return '';
  return `<dataValidations count="${dvs.length}">${dvs.map(dataValidationToXml).join('')}</dataValidations>`;
}
