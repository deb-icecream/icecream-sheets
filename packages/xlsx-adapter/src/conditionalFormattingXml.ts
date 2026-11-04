/**
 * Native conditional-formatting round-trip (`<conditionalFormatting>`
 * worksheet rules + `<dxfs>` differential formats in xl/styles.xml;
 * ISO/IEC 29500 §18.3.1.18 / §18.3.1.10 / §18.8; audit §§5.1, 5.2).
 *
 * Model (on SheetData): `conditionalFormatting` — one entry per
 * `<conditionalFormatting sqref>` block, each holding its `<cfRule>`
 * list in document order. Every base ST_CfType is modeled: cellIs,
 * expression, colorScale, dataBar, iconSet, top10, aboveAverage,
 * duplicateValues, uniqueValues, containsText, notContainsText,
 * beginsWith, endsWith, containsBlanks, notContainsBlanks,
 * containsErrors, notContainsErrors, timePeriod.
 *
 * The rule's differential format travels as a parsed `dxf` payload
 * (font/fill/border/numFmt, reusing the stylesXml.ts component parsers
 * where the shapes match), resolved from styles.xml `<dxfs>` by the
 * rule's `dxfId` on parse; on write the orchestrator
 * (nativeSheetFeatures.ts) allocates dxfIds through `allocateDxfs`,
 * which appends/dedupes `<dxf>` entries. Dxf children this module does
 * not model structurally (e.g. `<alignment>`, `<protection>` inside a
 * dxf) are preserved verbatim in `dxf.extraXml`. Rule-level children
 * that are not modeled (an `<extLst>` on a rule) are likewise preserved
 * in `extraXml`.
 *
 * Formulas (`<formula>` children, dataValidation-style) are carried
 * BARE: storage `_xlfn.` prefixes are stripped on parse and re-applied
 * on write via futureFunctions.ts.
 */
import {
  boolAttrValue,
  elementBody,
  escapeXmlAttr,
  escapeXmlText,
  findBlock,
  findBlocks,
  normalizeSqref,
  numAttrValue,
  parseAttrRecord,
  splitTopElements,
} from './nativeXmlUtil.js';
import { prefixFutureFunctions, stripFuturePrefixes } from './futureFunctions.js';
import { parseBorder, borderToXml, parseFont, fontToXml, type FontProps } from './stylesXml.js';
import type { CellBordersData } from '@icecream-sheets/engine';

/* ------------------------------------------------------------------ */
/* Colors                                                              */
/* ------------------------------------------------------------------ */

/** An OOXML `<color>` element's attributes, verbatim. */
export interface CfColor {
  rgb?: string;
  theme?: number;
  tint?: number;
  indexed?: number;
  auto?: boolean;
}

export function parseColorElement(el: string): CfColor {
  const a = parseAttrRecord(el);
  const out: CfColor = {};
  if (a.rgb !== undefined) out.rgb = a.rgb;
  const theme = numAttrValue(a.theme);
  if (theme !== undefined) out.theme = theme;
  const tint = numAttrValue(a.tint);
  if (tint !== undefined) out.tint = tint;
  const indexed = numAttrValue(a.indexed);
  if (indexed !== undefined) out.indexed = indexed;
  if (a.auto !== undefined) out.auto = boolAttrValue(a.auto, false);
  return out;
}

export function colorToXml(c: CfColor): string {
  const attrs: string[] = [];
  if (c.auto !== undefined) attrs.push(`auto="${c.auto ? '1' : '0'}"`);
  if (c.rgb !== undefined) attrs.push(`rgb="${escapeXmlAttr(c.rgb)}"`);
  if (c.theme !== undefined) attrs.push(`theme="${c.theme}"`);
  if (c.tint !== undefined) attrs.push(`tint="${c.tint}"`);
  if (c.indexed !== undefined) attrs.push(`indexed="${c.indexed}"`);
  return `<color${attrs.length ? ' ' + attrs.join(' ') : ''}/>`;
}

function findColor(parentXml: string, tag: string): CfColor | undefined {
  const block = findBlock(parentXml, tag);
  if (block) return parseColorElement(block.whole);
  const self = new RegExp(`<${tag}\\b[^>]*?/>`).exec(parentXml);
  return self ? parseColorElement(self[0]) : undefined;
}

/* ------------------------------------------------------------------ */
/* Differential formats (dxf)                                          */
/* ------------------------------------------------------------------ */

export interface DxfFill {
  patternType?: string;
  fgColor?: CfColor;
  bgColor?: CfColor;
  /** Raw `<patternFill>` inner XML when it is not a plain color fill. */
  rawInner?: string;
}

export interface DxfFormat {
  font?: FontProps & { colorRaw?: CfColor };
  fill?: DxfFill;
  border?: CellBordersData;
  numFmt?: { numFmtId: number; formatCode: string };
  /** Unmodeled dxf children (alignment/protection/…), verbatim. */
  extraXml?: string[];
}

function parseDxfFill(dxfInner: string): DxfFill | undefined {
  const block = findBlock(dxfInner, 'patternFill');
  const self = /<patternFill\b([^>]*?)\/>/.exec(dxfInner);
  if (!block && !self) return undefined;
  const fill: DxfFill = {};
  const openAttrs = block ? block.attrs : parseAttrRecord(self?.[1] ?? '');
  if (openAttrs.patternType !== undefined) fill.patternType = openAttrs.patternType;
  if (block) {
    const fg = findColor(block.inner, 'fgColor');
    if (fg) fill.fgColor = fg;
    const bg = findColor(block.inner, 'bgColor');
    if (bg) fill.bgColor = bg;
    // Gradient fills and other exotic pattern content: keep verbatim.
    if (/<gradientFill\b/.test(block.inner) || (fill.fgColor === undefined && fill.bgColor === undefined && block.inner.trim() !== '')) {
      fill.rawInner = block.inner;
    }
  }
  return fill;
}

export function parseDxf(dxfElementXml: string): DxfFormat {
  const inner = findBlock(`<root>${dxfElementXml}</root>`, 'dxf')?.inner ?? '';
  const out: DxfFormat = {};
  const fontBlock = findBlock(inner, 'font');
  if (fontBlock) {
    const props = parseFont(fontBlock.whole);
    const colorBlock = findBlock(fontBlock.inner, 'color') ?? null;
    const selfColor = /<color\b[^>]*?\/>/.exec(fontBlock.inner);
    const font: DxfFormat['font'] = { ...props };
    const raw = colorBlock ? parseColorElement(colorBlock.whole) : selfColor ? parseColorElement(selfColor[0]) : undefined;
    if (raw && (raw.theme !== undefined || raw.indexed !== undefined || raw.tint !== undefined)) font.colorRaw = raw;
    out.font = font;
  }
  const fill = parseDxfFill(inner);
  if (fill) out.fill = fill;
  const borderBlock = findBlock(inner, 'border');
  if (borderBlock) {
    const border = parseBorder(borderBlock.whole);
    if (border) out.border = border;
  }
  const numFmtSelf = /<numFmt\b([^>]*?)\/>/.exec(inner);
  if (numFmtSelf) {
    const a = parseAttrRecord(numFmtSelf[1] as string);
    const id = numAttrValue(a.numFmtId);
    if (id !== undefined && a.formatCode !== undefined) out.numFmt = { numFmtId: id, formatCode: a.formatCode };
  }
  const extras: string[] = [];
  for (const tag of ['alignment', 'protection']) {
    for (const el of splitTopElements(inner, tag)) extras.push(el);
  }
  if (extras.length > 0) out.extraXml = extras;
  return out;
}

export function dxfToXml(dxf: DxfFormat): string {
  const kids: string[] = [];
  if (dxf.numFmt) kids.push(`<numFmt numFmtId="${dxf.numFmt.numFmtId}" formatCode="${escapeXmlAttr(dxf.numFmt.formatCode)}"/>`);
  if (dxf.font) {
    let fontXml = fontToXml({
      name: dxf.font.name,
      size: dxf.font.size,
      bold: dxf.font.bold,
      italic: dxf.font.italic,
      underline: dxf.font.underline,
      strikethrough: dxf.font.strikethrough,
      color: dxf.font.colorRaw ? undefined : dxf.font.color,
    });
    if (dxf.font.colorRaw) {
      // Theme/indexed colors have no CSS form: splice the raw <color>
      // in at its CT_Font sequence position (after strike, before
      // <u>/<sz>/<scheme>), where fontToXml puts an rgb color.
      const colorXml = colorToXml(dxf.font.colorRaw);
      const at = ['<u ', '<u/>', '<sz ', '<scheme'].map((m) => fontXml.indexOf(m)).filter((i) => i >= 0);
      const pos = at.length > 0 ? Math.min(...at) : fontXml.indexOf('</font>');
      fontXml = fontXml.slice(0, pos) + colorXml + fontXml.slice(pos);
    }
    kids.push(fontXml);
  }
  if (dxf.fill) {
    const f = dxf.fill;
    if (f.rawInner !== undefined) {
      const pt = f.patternType !== undefined ? ` patternType="${escapeXmlAttr(f.patternType)}"` : '';
      kids.push(`<fill><patternFill${pt}>${f.rawInner}</patternFill></fill>`);
    } else {
      const pt = f.patternType !== undefined ? ` patternType="${escapeXmlAttr(f.patternType)}"` : '';
      const inner =
        (f.fgColor ? colorToXml(f.fgColor).replace('<color', '<fgColor').replace('/>', '/>') : '') +
        (f.bgColor ? colorToXml(f.bgColor).replace('<color', '<bgColor').replace('/>', '/>') : '');
      kids.push(`<fill><patternFill${pt}>${inner}</patternFill></fill>`);
    }
  }
  if (dxf.border) kids.push(borderToXml(dxf.border));
  if (dxf.extraXml) kids.push(...dxf.extraXml);
  return `<dxf>${kids.join('')}</dxf>`;
}

/** Parse the `<dxfs>` table of a styles.xml string ([] when absent). */
export function parseDxfs(stylesXml: string): DxfFormat[] {
  const block = findBlock(stylesXml, 'dxfs');
  if (!block) return [];
  return splitTopElements(block.inner, 'dxf').map(parseDxf);
}

/**
 * Ensure every dxf in `wanted` exists in `stylesXml`'s `<dxfs>`,
 * appending (deduped by serialized XML) as needed. Returns the rewritten
 * styles.xml and the dxfId for each wanted entry, in order. A styles.xml
 * without a `<dxfs>` block gains one in schema position (after
 * `<tableStyles>`, or at the end of `<styleSheet>` as a fallback — Excel
 * writes dxfs just before `</styleSheet>` when tableStyles is absent in
 * practice via the appended position used by SheetJS output).
 */
export function allocateDxfs(
  stylesXml: string,
  wanted: readonly DxfFormat[],
): { stylesXml: string; dxfIds: number[] } {
  if (wanted.length === 0) return { stylesXml, dxfIds: [] };
  const existingBlock = findBlock(stylesXml, 'dxfs');
  const existing = existingBlock ? splitTopElements(existingBlock.inner, 'dxf') : [];
  const byXml = new Map<string, number>();
  existing.forEach((el, i) => {
    if (!byXml.has(el)) byXml.set(el, i);
  });
  const els = [...existing];
  const dxfIds: number[] = [];
  for (const dxf of wanted) {
    const xml = dxfToXml(dxf);
    let id = byXml.get(xml);
    if (id === undefined) {
      id = els.length;
      els.push(xml);
      byXml.set(xml, id);
    }
    dxfIds.push(id);
  }
  const blockXml = `<dxfs count="${els.length}">${els.join('')}</dxfs>`;
  let out: string;
  if (existingBlock) {
    out = stylesXml.slice(0, existingBlock.start) + blockXml + stylesXml.slice(existingBlock.end);
  } else {
    const close = stylesXml.lastIndexOf('</styleSheet>');
    out = close >= 0 ? stylesXml.slice(0, close) + blockXml + stylesXml.slice(close) : stylesXml + blockXml;
  }
  return { stylesXml: out, dxfIds };
}

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

export interface Cfvo {
  /** ST_CfvoType: min|max|num|percent|percentile|formula|autoMin|autoMax. */
  type: string;
  val?: string;
  gte?: boolean;
}

export interface CfColorScale {
  cfvos: Cfvo[];
  colors: CfColor[];
}

export interface CfDataBar {
  minLength?: number;
  maxLength?: number;
  showValue?: boolean;
  cfvos: Cfvo[];
  color?: CfColor;
}

export interface CfIconSet {
  iconSet: string;
  reverse?: boolean;
  showValue?: boolean;
  percent?: boolean;
  cfvos: Cfvo[];
  icons?: Array<{ iconSet: string; iconId: number }>;
}

export interface CfRule {
  /** ST_CfType value, e.g. 'cellIs', 'colorScale', 'top10'. */
  type: string;
  priority: number;
  operator?: string;
  formulas?: string[];
  text?: string;
  dxf?: DxfFormat;
  /** The source dxfId, kept for reference; write re-allocates. */
  dxfId?: number;
  stopIfTrue?: boolean;
  rank?: number;
  percent?: boolean;
  bottom?: boolean;
  aboveAverage?: boolean;
  equalAverage?: boolean;
  stdDev?: number;
  timePeriod?: string;
  colorScale?: CfColorScale;
  dataBar?: CfDataBar;
  iconSet?: CfIconSet;
  /** Unmodeled rule children (e.g. `<extLst>`), verbatim. */
  extraXml?: string[];
}

export interface NativeConditionalFormatting {
  sqref: string;
  rules: CfRule[];
}

function parseCfvo(el: string): Cfvo {
  const a = parseAttrRecord(el);
  const out: Cfvo = { type: a.type ?? 'num' };
  if (a.val !== undefined) out.val = a.val;
  if (a.gte !== undefined) out.gte = boolAttrValue(a.gte, true);
  return out;
}

function cfvoToXml(v: Cfvo): string {
  const attrs = [`type="${escapeXmlAttr(v.type)}"`];
  if (v.val !== undefined) attrs.push(`val="${escapeXmlAttr(v.val)}"`);
  // Emitted whenever the model carries the field (even at the schema
  // default) so parse -> write -> parse is model-stable.
  if (v.gte !== undefined) attrs.push(`gte="${v.gte ? '1' : '0'}"`);
  return `<cfvo ${attrs.join(' ')}/>`;
}

/** Parse every `<conditionalFormatting>` block of a worksheet. */
export function parseConditionalFormatting(sheetXml: string, dxfs: readonly DxfFormat[]): NativeConditionalFormatting[] {
  const out: NativeConditionalFormatting[] = [];
  for (const block of findBlocks(sheetXml, 'conditionalFormatting')) {
    const sqref = block.attrs.sqref;
    if (!sqref) continue;
    const entry: NativeConditionalFormatting = { sqref: normalizeSqref(sqref), rules: [] };
    for (const ruleEl of splitTopElements(block.inner, 'cfRule')) {
      const openTag = /^<cfRule\b[^>]*>/.exec(ruleEl)?.[0] ?? (ruleEl.endsWith('/>') ? ruleEl : '');
      const a = parseAttrRecord(openTag);
      if (!a.type) continue;
      const priority = numAttrValue(a.priority);
      const rule: CfRule = { type: a.type, priority: priority ?? 0 };
      if (a.operator !== undefined) rule.operator = a.operator;
      if (a.text !== undefined) rule.text = a.text;
      if (a.dxfId !== undefined) {
        const id = numAttrValue(a.dxfId);
        if (id !== undefined) {
          rule.dxfId = id;
          const dxf = dxfs[id];
          if (dxf) rule.dxf = dxf;
        }
      }
      if (a.stopIfTrue !== undefined && boolAttrValue(a.stopIfTrue, false)) rule.stopIfTrue = true;
      const rank = numAttrValue(a.rank);
      if (rank !== undefined) rule.rank = rank;
      if (a.percent !== undefined && boolAttrValue(a.percent, false)) rule.percent = true;
      if (a.bottom !== undefined && boolAttrValue(a.bottom, false)) rule.bottom = true;
      if (a.aboveAverage !== undefined) rule.aboveAverage = boolAttrValue(a.aboveAverage, true);
      if (a.equalAverage !== undefined && boolAttrValue(a.equalAverage, false)) rule.equalAverage = true;
      const sd = numAttrValue(a.stdDev);
      if (sd !== undefined) rule.stdDev = sd;
      if (a.timePeriod !== undefined) rule.timePeriod = a.timePeriod;

      const formulas: string[] = [];
      for (const f of splitTopElements(ruleEl, 'formula')) {
        formulas.push(stripFuturePrefixes(elementBody(f).trim()));
      }
      if (formulas.length > 0) rule.formulas = formulas;

      const csBlock = findBlock(ruleEl, 'colorScale');
      if (csBlock) {
        const scale: CfColorScale = { cfvos: [], colors: [] };
        for (const v of splitTopElements(csBlock.inner, 'cfvo')) scale.cfvos.push(parseCfvo(v));
        for (const c of splitTopElements(csBlock.inner, 'color')) scale.colors.push(parseColorElement(c));
        rule.colorScale = scale;
      }
      const dbBlock = findBlock(ruleEl, 'dataBar');
      if (dbBlock) {
        const bar: CfDataBar = { cfvos: [] };
        const minL = numAttrValue(dbBlock.attrs.minLength);
        if (minL !== undefined) bar.minLength = minL;
        const maxL = numAttrValue(dbBlock.attrs.maxLength);
        if (maxL !== undefined) bar.maxLength = maxL;
        if (dbBlock.attrs.showValue !== undefined) bar.showValue = boolAttrValue(dbBlock.attrs.showValue, true);
        for (const v of splitTopElements(dbBlock.inner, 'cfvo')) bar.cfvos.push(parseCfvo(v));
        const color = findColor(dbBlock.inner, 'color');
        if (color) bar.color = color;
        rule.dataBar = bar;
      }
      const isBlock = findBlock(ruleEl, 'iconSet');
      if (isBlock) {
        const set: CfIconSet = { iconSet: isBlock.attrs.iconSet ?? '3TrafficLights1', cfvos: [] };
        if (isBlock.attrs.reverse !== undefined) set.reverse = boolAttrValue(isBlock.attrs.reverse, false);
        if (isBlock.attrs.showValue !== undefined) set.showValue = boolAttrValue(isBlock.attrs.showValue, true);
        if (isBlock.attrs.percent !== undefined) set.percent = boolAttrValue(isBlock.attrs.percent, true);
        for (const v of splitTopElements(isBlock.inner, 'cfvo')) set.cfvos.push(parseCfvo(v));
        const icons: NonNullable<CfIconSet['icons']> = [];
        for (const ic of splitTopElements(isBlock.inner, 'cfIcon')) {
          const ia = parseAttrRecord(ic);
          const id = numAttrValue(ia.iconId);
          if (ia.iconSet !== undefined && id !== undefined) icons.push({ iconSet: ia.iconSet, iconId: id });
        }
        if (icons.length > 0) set.icons = icons;
        rule.iconSet = set;
      }
      const extras: string[] = [];
      for (const el of splitTopElements(ruleEl, 'extLst')) extras.push(el);
      if (extras.length > 0) rule.extraXml = extras;
      entry.rules.push(rule);
    }
    out.push(entry);
  }
  return out;
}

/** Serialize one `<cfRule>`; `dxfId` is the allocated styles.xml index. */
export function cfRuleToXml(rule: CfRule, dxfId: number | undefined): string {
  const attrs = [`type="${escapeXmlAttr(rule.type)}"`, `priority="${rule.priority}"`];
  if (dxfId !== undefined) attrs.push(`dxfId="${dxfId}"`);
  if (rule.operator !== undefined) attrs.push(`operator="${escapeXmlAttr(rule.operator)}"`);
  if (rule.text !== undefined) attrs.push(`text="${escapeXmlAttr(rule.text)}"`);
  if (rule.stopIfTrue) attrs.push('stopIfTrue="1"');
  if (rule.rank !== undefined) attrs.push(`rank="${rule.rank}"`);
  if (rule.percent) attrs.push('percent="1"');
  if (rule.bottom) attrs.push('bottom="1"');
  if (rule.aboveAverage !== undefined) attrs.push(`aboveAverage="${rule.aboveAverage ? '1' : '0'}"`);
  if (rule.equalAverage) attrs.push('equalAverage="1"');
  if (rule.stdDev !== undefined) attrs.push(`stdDev="${rule.stdDev}"`);
  if (rule.timePeriod !== undefined) attrs.push(`timePeriod="${escapeXmlAttr(rule.timePeriod)}"`);
  const kids: string[] = [];
  if (rule.colorScale) {
    kids.push(
      `<colorScale>${rule.colorScale.cfvos.map(cfvoToXml).join('')}${rule.colorScale.colors.map(colorToXml).join('')}</colorScale>`,
    );
  }
  if (rule.dataBar) {
    const da: string[] = [];
    if (rule.dataBar.minLength !== undefined) da.push(`minLength="${rule.dataBar.minLength}"`);
    if (rule.dataBar.maxLength !== undefined) da.push(`maxLength="${rule.dataBar.maxLength}"`);
    if (rule.dataBar.showValue !== undefined) da.push(`showValue="${rule.dataBar.showValue ? '1' : '0'}"`);
    const inner =
      rule.dataBar.cfvos.map(cfvoToXml).join('') +
      (rule.dataBar.color ? colorToXml(rule.dataBar.color) : '');
    kids.push(`<dataBar${da.length ? ' ' + da.join(' ') : ''}>${inner}</dataBar>`);
  }
  if (rule.iconSet) {
    const ia = [`iconSet="${escapeXmlAttr(rule.iconSet.iconSet)}"`];
    if (rule.iconSet.reverse !== undefined) ia.push(`reverse="${rule.iconSet.reverse ? '1' : '0'}"`);
    if (rule.iconSet.showValue !== undefined) ia.push(`showValue="${rule.iconSet.showValue ? '1' : '0'}"`);
    if (rule.iconSet.percent !== undefined) ia.push(`percent="${rule.iconSet.percent ? '1' : '0'}"`);
    const inner =
      rule.iconSet.cfvos.map(cfvoToXml).join('') +
      (rule.iconSet.icons ?? []).map((i) => `<cfIcon iconSet="${escapeXmlAttr(i.iconSet)}" iconId="${i.iconId}"/>`).join('');
    kids.push(`<iconSet ${ia.join(' ')}>${inner}</iconSet>`);
  }
  for (const f of rule.formulas ?? []) {
    kids.push(`<formula>${escapeXmlText(prefixFutureFunctions(f))}</formula>`);
  }
  if (rule.extraXml) kids.push(...rule.extraXml);
  return kids.length === 0
    ? `<cfRule ${attrs.join(' ')}/>`
    : `<cfRule ${attrs.join(' ')}>${kids.join('')}</cfRule>`;
}

/**
 * Serialize one `<conditionalFormatting>` block. `dxfIdFor` maps a rule
 * to its allocated dxf index (undefined = the rule carries no dxf).
 */
export function conditionalFormattingToXml(
  cf: NativeConditionalFormatting,
  dxfIdFor: (rule: CfRule) => number | undefined,
): string {
  const rules = cf.rules.map((r) => cfRuleToXml(r, dxfIdFor(r))).join('');
  return `<conditionalFormatting sqref="${escapeXmlAttr(normalizeSqref(cf.sqref))}">${rules}</conditionalFormatting>`;
}
