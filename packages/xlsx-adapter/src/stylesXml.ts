/**
 * Native XLSX cell-style round-trip (fonts, fills, borders, alignment —
 * the parts of xl/styles.xml SheetJS CE neither writes nor fully reads).
 *
 * Defect D4 (Cycle 10 closure): ribbon-applied formatting lived only in
 * the web UI's FormatStore and never reached the file — SheetJS CE drops
 * cell fonts/fills/borders on write entirely, and the app never handed
 * even number formats to the save path. This module is the adapter half
 * of the fix, following the protectionXml.ts pattern (direct OOXML
 * surgery on the package with fflate):
 *
 * - read (`applyNativeStyles`): parse xl/styles.xml (fonts, fills,
 *   borders, cellXfs, numFmts) and each worksheet's `<c s="…">` indices
 *   (with row/column style fallback, exactly like protectionXml) into
 *   `SheetData.styles` — sparse per-cell CellStyle records. xf 0 (the
 *   default style) yields no entry; a component is recorded only when it
 *   differs from the workbook default, so unstyled files gain nothing.
 * - write (`injectCellStyles`): given per-sheet CellStyle targets, clone
 *   each target cell's current xf (preserving its number format and
 *   `<protection>` child unless the style overrides them), build/dedupe
 *   the font/fill/border/numFmt entries the style needs, append new xfs,
 *   and point each `<c>` at its xf (materializing empty styled `<c>`
 *   elements for formatted empty cells, as Excel does — never a phantom
 *   value cell).
 *
 * Both directions are best-effort: a styles hint must never break an
 * open or a save, so failures return the input untouched.
 */

import { unzipSync } from 'fflate';
import { zipSyncStable } from './zipStable.js';
import { decodeRef, sheetPartPaths } from './formulaRecovery.js';
import { builtinFormatTable, parseStyleFormatCodes } from './fastSheetParse.js';
import { GENERAL_FORMAT_CODE } from './numfmt.js';
import type {
  CellBorderSide,
  CellBordersData,
  CellStyle,
  SheetData,
} from '@icecream-sheets/engine';

// ---------------------------------------------------------------------------
// Small XML helpers (same conventions as protectionXml.ts)
// ---------------------------------------------------------------------------

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return m ? unescapeXml(m[1] as string) : null;
}

/** Split a block's inner XML into top-level elements named `tag`. */
function splitElements(inner: string, tag: string): string[] {
  const out: string[] = [];
  const open = `<${tag}`;
  let i = 0;
  while (true) {
    const start = inner.indexOf(open, i);
    if (start < 0) break;
    const after = inner[start + open.length] ?? '';
    if (after !== '' && !/[\s/>]/.test(after)) {
      i = start + open.length;
      continue;
    }
    // Find the end of the opening tag (quote-aware).
    let j = start + open.length;
    let quote: string | null = null;
    let openEnd = -1;
    for (; j < inner.length; j++) {
      const ch = inner[j] as string;
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        openEnd = j;
        break;
      }
    }
    if (openEnd < 0) break;
    if (inner[openEnd - 1] === '/') {
      out.push(inner.slice(start, openEnd + 1));
      i = openEnd + 1;
    } else {
      const closeTag = `</${tag}>`;
      const close = inner.indexOf(closeTag, openEnd + 1);
      if (close < 0) break;
      out.push(inner.slice(start, close + closeTag.length));
      i = close + closeTag.length;
    }
  }
  return out;
}

/** Extract a `<tag …>inner</tag>` block's inner XML + span, or null. */
function blockInner(
  xml: string,
  tag: string,
): { inner: string; start: number; end: number; openTag: string } | null {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  if (!m) return null;
  const openEnd = xml.indexOf('>', m.index) + 1;
  return { inner: m[1] as string, start: m.index, end: m.index + m[0].length, openTag: xml.slice(m.index, openEnd) };
}

// ---------------------------------------------------------------------------
// Colors: CSS hex <-> OOXML ARGB
// ---------------------------------------------------------------------------

/** '#RGB' / '#RRGGBB' -> 'FFRRGGBB' (opaque ARGB). Null when not a hex color. */
export function cssColorToArgb(css: string): string | null {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(css.trim());
  if (!m) return null;
  let hex = m[1] as string;
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  return `FF${hex.toUpperCase()}`;
}

/** OOXML color element attrs -> CSS '#RRGGBB'. Theme/indexed colors have no exact CSS value: null. */
function colorElementToCss(el: string | null): string | null {
  if (!el) return null;
  const rgb = attr(el, 'rgb');
  if (rgb && /^[0-9a-fA-F]{8}$/.test(rgb)) return `#${rgb.slice(2).toUpperCase()}`;
  if (rgb && /^[0-9a-fA-F]{6}$/.test(rgb)) return `#${rgb.toUpperCase()}`;
  return null;
}

/** The `<color …>` child element text of a fragment, or null. */
function childColor(fragment: string): string | null {
  const m = /<color\b[^>]*\/?>/.exec(fragment);
  return m ? m[0] : null;
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

export interface FontProps {
  name?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean | 'double';
  strikethrough?: boolean;
  color?: string;
}

/**
 * OOXML boolean property (CT_BooleanProperty — `<b/>`, `<i/>`, …): the
 * element's presence means true unless it carries val="0"/"false".
 * Producers differ in spelling: Excel writes the bare `<b/>`, SheetJS
 * writes the explicit `<b val="1"/>`. Returns undefined when absent.
 */
function boolProp(xml: string, tag: string): boolean | undefined {
  const m = new RegExp(`<${tag}\\b[^>]*>`).exec(xml);
  if (!m) return undefined;
  const v = attr(m[0], 'val');
  return v !== '0' && v !== 'false';
}

/** Parse one `<font>` element into props (only fields actually present). */
export function parseFont(fontXml: string): FontProps {
  const p: FontProps = {};
  const bold = boolProp(fontXml, 'b');
  if (bold !== undefined) p.bold = bold;
  const italic = boolProp(fontXml, 'i');
  if (italic !== undefined) p.italic = italic;
  const u = /<u\b([^>]*?)\/?>/.exec(fontXml);
  if (u) {
    const v = attr(u[0], 'val');
    p.underline = v === 'double' ? 'double' : true;
  }
  const strike = boolProp(fontXml, 'strike');
  if (strike !== undefined) p.strikethrough = strike;
  const sz = /<sz\b([^>]*?)\/?>/.exec(fontXml);
  if (sz) {
    const v = Number(attr(sz[0], 'val'));
    if (Number.isFinite(v) && v > 0) p.size = v;
  }
  const nm = /<name\b([^>]*?)\/?>/.exec(fontXml);
  if (nm) {
    const v = attr(nm[0], 'val');
    if (v) p.name = v;
  }
  const color = colorElementToCss(childColor(fontXml));
  if (color) p.color = color;
  return p;
}

/** Serialize font props to a `<font>` element (CT_Font child order). */
export function fontToXml(p: FontProps): string {
  const parts: string[] = [];
  if (p.name) parts.push(`<name val="${escapeXml(p.name)}"/>`);
  parts.push('<family val="2"/>');
  if (p.bold) parts.push('<b/>');
  if (p.italic) parts.push('<i/>');
  if (p.strikethrough) parts.push('<strike/>');
  if (p.color) {
    const argb = cssColorToArgb(p.color);
    if (argb) parts.push(`<color rgb="${argb}"/>`);
  }
  if (p.underline === 'double') parts.push('<u val="double"/>');
  else if (p.underline) parts.push('<u/>');
  if (p.size !== undefined) parts.push(`<sz val="${p.size}"/>`);
  parts.push('<scheme val="minor"/>');
  return `<font>${parts.join('')}</font>`;
}

// ---------------------------------------------------------------------------
// Fills / borders / alignment
// ---------------------------------------------------------------------------

/** Solid-fill foreground color of one `<fill>` element, or null. */
export function parseFill(fillXml: string): string | null {
  const pf = /<patternFill\b([^>]*)>([\s\S]*?)<\/patternFill>/.exec(fillXml);
  if (!pf) return null;
  if (attr(`<patternFill${pf[1]}>`, 'patternType') !== 'solid') return null;
  const fg = /<fgColor\b[^>]*\/?>/.exec(pf[2] as string);
  return fg ? colorElementToCss(fg[0]) : null;
}

export function fillToXml(cssColor: string): string | null {
  const argb = cssColorToArgb(cssColor);
  if (!argb) return null;
  return `<fill><patternFill patternType="solid"><fgColor rgb="${argb}"/><bgColor rgb="${argb}"/></patternFill></fill>`;
}

const BORDER_STYLE_TO_OOXML: Record<string, string> = {
  thin: 'thin',
  medium: 'medium',
  thick: 'thick',
  dashed: 'dashed',
  dotted: 'dotted',
  double: 'double',
};

/** Parse one `<border>` element into sides (only sides carrying a style). */
export function parseBorder(borderXml: string): CellBordersData | undefined {
  const out: CellBordersData = {};
  let any = false;
  for (const side of ['left', 'right', 'top', 'bottom'] as const) {
    const m = new RegExp(`<${side}\\b([^>]*)>([\\s\\S]*?)</${side}>`).exec(borderXml);
    const selfClosed = new RegExp(`<${side}\\b([^>]*?)\\/>`).exec(borderXml);
    const el = m ? `<${side}${m[1]}>` : selfClosed ? `<${side}${selfClosed[1]}/>` : null;
    if (!el) continue;
    const style = attr(el, 'style');
    if (!style || style === 'none') continue;
    const key = side === 'left' ? 'left' : side === 'right' ? 'right' : side === 'top' ? 'top' : 'bottom';
    const color = m ? colorElementToCss(childColor(m[2] as string)) : null;
    out[key] = { style: style as CellBorderSide['style'], color: color ?? '#000000' };
    any = true;
  }
  return any ? out : undefined;
}

export function borderToXml(b: CellBordersData): string {
  const side = (s: CellBorderSide | undefined): string => {
    if (!s || s.style === 'none') return '';
    const style = BORDER_STYLE_TO_OOXML[s.style] ?? 'thin';
    const argb = cssColorToArgb(s.color);
    const color = argb ? `<color rgb="${argb}"/>` : '<color auto="1"/>';
    return `<TEMP style="${style}">${color}</TEMP>`;
  };
  const l = side(b.left).replace(/TEMP/g, 'left');
  const r = side(b.right).replace(/TEMP/g, 'right');
  const t = side(b.top).replace(/TEMP/g, 'top');
  const bo = side(b.bottom).replace(/TEMP/g, 'bottom');
  const empty = (tag: string): string => `<${tag}/>`;
  return `<border>${l || empty('left')}${r || empty('right')}${t || empty('top')}${bo || empty('bottom')}<diagonal/></border>`;
}

export interface AlignmentProps {
  hAlign?: 'left' | 'center' | 'right';
  vAlign?: 'top' | 'middle' | 'bottom';
  wrapText?: boolean;
  indent?: number;
  orientation?: number;
  verticalText?: boolean;
}

/** Parse an `<alignment>` element (from an xf) into UI alignment props. */
export function parseAlignment(xfXml: string): AlignmentProps {
  const m = /<alignment\b([^>]*?)\/?>/.exec(xfXml);
  if (!m) return {};
  const tag = m[0];
  const out: AlignmentProps = {};
  const h = attr(tag, 'horizontal');
  if (h === 'left' || h === 'center' || h === 'right') out.hAlign = h;
  const v = attr(tag, 'vertical');
  if (v === 'top') out.vAlign = 'top';
  else if (v === 'center') out.vAlign = 'middle';
  else if (v === 'bottom') out.vAlign = 'bottom';
  const wrap = attr(tag, 'wrapText');
  if (wrap === '1' || wrap === 'true') out.wrapText = true;
  const indent = attr(tag, 'indent');
  if (indent !== null) {
    const n = Number(indent);
    if (Number.isFinite(n) && n > 0) out.indent = n;
  }
  const rot = attr(tag, 'textRotation');
  if (rot !== null) {
    const n = Number(rot);
    if (Number.isFinite(n)) {
      if (n === 255) out.verticalText = true;
      else if (n >= 0 && n <= 90 && n !== 0) out.orientation = n;
      else if (n > 90 && n <= 180) out.orientation = n - 180;
    }
  }
  return out;
}

/** Serialize alignment props to an `<alignment>` element, or '' when empty. */
export function alignmentToXml(a: AlignmentProps): string {
  const attrs: string[] = [];
  if (a.hAlign) attrs.push(`horizontal="${a.hAlign}"`);
  if (a.vAlign) attrs.push(`vertical="${a.vAlign === 'middle' ? 'center' : a.vAlign}"`);
  if (a.wrapText) attrs.push('wrapText="1"');
  if (a.indent !== undefined && a.indent > 0) attrs.push(`indent="${a.indent}"`);
  if (a.verticalText) attrs.push('textRotation="255"');
  else if (a.orientation !== undefined && a.orientation !== 0) {
    attrs.push(`textRotation="${a.orientation > 0 ? a.orientation : 180 + a.orientation}"`);
  }
  return attrs.length > 0 ? `<alignment ${attrs.join(' ')}/>` : '';
}

// ---------------------------------------------------------------------------
// cellXfs
// ---------------------------------------------------------------------------

export interface XfProps {
  numFmtId: number;
  fontId: number;
  fillId: number;
  borderId: number;
  xfId: number;
  alignment: string; // raw <alignment> element or ''
  protection: string; // raw <protection> element or ''
  raw: string;
}

export function parseXf(xfXml: string): XfProps {
  const gt = xfXml.indexOf('>');
  const open = gt >= 0 ? xfXml.slice(0, gt + 1) : xfXml;
  const num = (name: string): number => {
    const v = attr(open, name);
    const n = v === null ? NaN : Number(v);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  };
  const align = /<alignment\b[^>]*\/?>/.exec(xfXml);
  const prot = /<protection\b[^>]*\/?>/.exec(xfXml) ?? /<protection\b[^>]*>[\s\S]*?<\/protection>/.exec(xfXml);
  return {
    numFmtId: num('numFmtId'),
    fontId: num('fontId'),
    fillId: num('fillId'),
    borderId: num('borderId'),
    xfId: num('xfId'),
    alignment: align ? align[0] : '',
    protection: prot ? prot[0] : '',
    raw: xfXml,
  };
}

function xfToXml(x: Omit<XfProps, 'raw'>): string {
  const attrs = [
    `numFmtId="${x.numFmtId}"`,
    `fontId="${x.fontId}"`,
    `fillId="${x.fillId}"`,
    `borderId="${x.borderId}"`,
    `xfId="${x.xfId}"`,
  ];
  if (x.numFmtId !== 0) attrs.push('applyNumberFormat="1"');
  if (x.fontId !== 0) attrs.push('applyFont="1"');
  if (x.fillId !== 0) attrs.push('applyFill="1"');
  if (x.borderId !== 0) attrs.push('applyBorder="1"');
  if (x.alignment) attrs.push('applyAlignment="1"');
  const children = `${x.alignment}${x.protection}`;
  return children
    ? `<xf ${attrs.join(' ')}>${children}</xf>`
    : `<xf ${attrs.join(' ')}/>`;
}

// ---------------------------------------------------------------------------
// Read: styles.xml + worksheet <c s="…"> -> SheetData.styles
// ---------------------------------------------------------------------------

interface StylesModel {
  fonts: FontProps[];
  fills: Array<string | null>; // solid fg color per fill index
  borders: Array<CellBordersData | undefined>;
  xfs: XfProps[];
  codes: string[]; // format code per xf index
}

function parseStylesModel(stylesXml: string): StylesModel | null {
  const fontsBlock = blockInner(stylesXml, 'fonts');
  const fillsBlock = blockInner(stylesXml, 'fills');
  const bordersBlock = blockInner(stylesXml, 'borders');
  const xfsBlock = blockInner(stylesXml, 'cellXfs');
  if (!xfsBlock) return null;
  return {
    fonts: fontsBlock ? splitElements(fontsBlock.inner, 'font').map(parseFont) : [],
    fills: fillsBlock ? splitElements(fillsBlock.inner, 'fill').map(parseFill) : [],
    borders: bordersBlock ? splitElements(bordersBlock.inner, 'border').map(parseBorder) : [],
    xfs: splitElements(xfsBlock.inner, 'xf').map(parseXf),
    codes: parseStyleFormatCodes(stylesXml, builtinFormatTable()),
  };
}

/** Compose the CellStyle one xf represents, or null for the default style. */
function styleFromXf(model: StylesModel, xfIdx: number): CellStyle | null {
  if (xfIdx <= 0 || xfIdx >= model.xfs.length) return null;
  const xf = model.xfs[xfIdx] as XfProps;
  const out: CellStyle = {};
  const code = model.codes[xfIdx];
  // "GENERAL" (ClosedXML spelling) is the same default as "General".
  if (code && code.toLowerCase() !== 'general' && code !== GENERAL_FORMAT_CODE) out.numberFormatCode = code;
  // Font: record fields that differ from the default font (index 0), so a
  // bold-only variant does not suddenly claim the default's name/size.
  const font = model.fonts[xf.fontId];
  if (font) {
    const dflt = model.fonts[0] ?? {};
    if (xf.fontId !== 0 || font.bold || font.italic || font.underline || font.strikethrough) {
      if (font.bold !== undefined && font.bold !== dflt.bold) out.bold = font.bold;
      if (font.italic !== undefined && font.italic !== dflt.italic) out.italic = font.italic;
      if (font.underline !== undefined) out.underline = font.underline;
      if (font.strikethrough) out.strikethrough = true;
      if (font.name !== undefined && font.name !== dflt.name) out.fontName = font.name;
      if (font.size !== undefined && font.size !== dflt.size) out.fontSize = font.size;
      if (font.color !== undefined && font.color !== dflt.color) out.fontColor = font.color;
    }
  }
  const fill = model.fills[xf.fillId];
  if (fill) out.fillColor = fill;
  const border = model.borders[xf.borderId];
  if (border) out.borders = border;
  const align = parseAlignment(xf.raw);
  if (align.hAlign !== undefined) out.hAlign = align.hAlign;
  if (align.vAlign !== undefined) out.vAlign = align.vAlign;
  if (align.wrapText !== undefined) out.wrapText = align.wrapText;
  if (align.indent !== undefined) out.indent = align.indent;
  if (align.orientation !== undefined) out.orientation = align.orientation;
  if (align.verticalText !== undefined) out.verticalText = align.verticalText;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Parse native cell styles from the package into each sheet's `styles`
 * map. Mirrors protectionXml.applyNativeProtection's worksheet scan
 * (own `s` → row `s` → column `s` fallback). Never throws.
 */
export function applyNativeStyles(
  sheets: SheetData[],
  preunzipped?: Record<string, Uint8Array>,
  packageBytes?: Uint8Array,
): void {
  try {
    const files = preunzipped ?? (packageBytes ? unzipSync(packageBytes.slice()) : undefined);
    if (!files) return;
    const stylesRaw = files['xl/styles.xml'];
    if (!stylesRaw) return;
    const decoder = new TextDecoder();
    const model = parseStylesModel(decoder.decode(stylesRaw));
    if (!model || model.xfs.length <= 1) return;
    const parts = sheetPartPaths(files as unknown as Record<string, Uint8Array>);
    if (parts.size === 0) return;
    for (const sheet of sheets) {
      const path = parts.get(sheet.name);
      const raw = path ? files[path] : undefined;
      if (!path || !raw) continue;
      const xml = decoder.decode(raw);
      const colStyles: Array<{ min: number; max: number; s: number }> = [];
      for (const tag of xml.match(/<col\b[^>]*>/g) ?? []) {
        const s = attr(tag, 'style') ?? attr(tag, 's');
        if (s === null || !/^\d+$/.test(s)) continue;
        const min = parseInt(attr(tag, 'min') ?? '', 10);
        const max = parseInt(attr(tag, 'max') ?? '', 10);
        if (Number.isInteger(min) && Number.isInteger(max)) colStyles.push({ min, max, s: parseInt(s, 10) });
      }
      const rowStyles = new Map<number, number>();
      for (const tag of xml.match(/<row\b[^>]*>/g) ?? []) {
        const s = attr(tag, 's');
        const r = attr(tag, 'r');
        if (s === null || r === null || !/^\d+$/.test(s) || !/^\d+$/.test(r)) continue;
        rowStyles.set(parseInt(r, 10), parseInt(s, 10));
      }
      const styles: Record<string, CellStyle> = {};
      for (const tag of xml.match(/<c\b[^>]*>/g) ?? []) {
        const ref = attr(tag, 'r');
        if (!ref) continue;
        const rc = decodeRef(ref);
        if (!rc) continue;
        let sIdx = 0;
        const sAttr = attr(tag, 's');
        if (sAttr !== null && /^\d+$/.test(sAttr)) {
          sIdx = parseInt(sAttr, 10);
        } else {
          const rs = rowStyles.get(rc.r + 1);
          if (rs !== undefined) sIdx = rs;
          else {
            const col = colStyles.find((cs) => rc.c + 1 >= cs.min && rc.c + 1 <= cs.max);
            if (col) sIdx = col.s;
          }
        }
        const style = styleFromXf(model, sIdx);
        if (style) styles[`${rc.r}:${rc.c}`] = style;
      }
      if (Object.keys(styles).length > 0) sheet.styles = styles;
    }
  } catch {
    // Best-effort: styles must never break the open.
  }
}

// ---------------------------------------------------------------------------
// Write: CellStyle targets -> styles.xml + worksheet s attributes
// ---------------------------------------------------------------------------

/** Built-in numFmtId for a format code (reverse of the SSF table), if any. */
function builtinIdForCode(code: string): number | null {
  const table = builtinFormatTable();
  for (const [id, c] of Object.entries(table)) {
    if (c === code) return Number(id);
  }
  // Codes SheetJS's table spells differently but Excel treats as built-in.
  const known: Record<string, number> = { 'm/d/yyyy': 14, 'mm/dd/yyyy': 14 };
  return known[code] ?? null;
}

interface CTagSpan {
  start: number;
  end: number;
  r: number;
  c: number;
  s: number | null;
}

/**
 * Inject per-cell styles into a serialized package: build/dedupe fonts,
 * fills, borders and custom numFmts in xl/styles.xml, append the needed
 * cellXfs, and point each target `<c>` at its xf — materializing empty
 * styled `<c>` elements for formatted cells that carry no value (the same
 * thing Excel does; never a phantom value). Existing xf children
 * (`<protection>`, and `<alignment>` when the style doesn't override it)
 * are preserved. Never throws: on any failure the input bytes are
 * returned unchanged.
 */
export function injectCellStyles(
  packageBytes: Uint8Array,
  targets: Map<string, Record<string, CellStyle>>,
): Uint8Array {
  if (targets.size === 0) return packageBytes;
  try {
    const files = unzipSync(packageBytes.slice());
    const parts = sheetPartPaths(files as unknown as Record<string, Uint8Array>);
    const stylesRaw = files['xl/styles.xml'];
    if (!stylesRaw || parts.size === 0) return packageBytes;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let stylesXml = decoder.decode(stylesRaw);

    // -- Parse the style tables (create empty models when a block is absent).
    const fontsBlock = blockInner(stylesXml, 'fonts');
    const fillsBlock = blockInner(stylesXml, 'fills');
    const bordersBlock = blockInner(stylesXml, 'borders');
    const numFmtsBlock = blockInner(stylesXml, 'numFmts');
    const xfsBlock = blockInner(stylesXml, 'cellXfs');
    if (!xfsBlock) return packageBytes;
    const fontEls = fontsBlock ? splitElements(fontsBlock.inner, 'font') : [];
    const fillEls = fillsBlock ? splitElements(fillsBlock.inner, 'fill') : [];
    const borderEls = bordersBlock ? splitElements(bordersBlock.inner, 'border') : [];
    const xfEls = splitElements(xfsBlock.inner, 'xf');
    if (xfEls.length === 0) return packageBytes;
    const fontProps = fontEls.map(parseFont);
    const xfs = xfEls.map(parseXf);

    const fontIndexByXml = new Map<string, number>(fontEls.map((x, i) => [x, i]));
    const fillIndexByXml = new Map<string, number>(fillEls.map((x, i) => [x, i]));
    const borderIndexByXml = new Map<string, number>(borderEls.map((x, i) => [x, i]));
    const xfIndexByXml = new Map<string, number>(xfEls.map((x, i) => [x, i]));

    // numFmt ids: existing custom entries + allocation counter.
    const customIdByCode = new Map<string, number>();
    let nextCustomId = 164;
    if (numFmtsBlock) {
      for (const el of splitElements(numFmtsBlock.inner, 'numFmt')) {
        const id = attr(el, 'numFmtId');
        const code = attr(el, 'formatCode');
        if (id !== null && code !== null) {
          customIdByCode.set(code, Number(id));
          nextCustomId = Math.max(nextCustomId, Number(id) + 1);
        }
      }
    }
    const newNumFmts: Array<{ id: number; code: string }> = [];
    const numFmtIdFor = (code: string): number => {
      const builtin = builtinIdForCode(code);
      if (builtin !== null) return builtin;
      const existing = customIdByCode.get(code);
      if (existing !== undefined) return existing;
      const id = nextCustomId++;
      customIdByCode.set(code, id);
      newNumFmts.push({ id, code });
      return id;
    };

    const ensureFont = (xml: string): number => {
      let idx = fontIndexByXml.get(xml);
      if (idx === undefined) {
        idx = fontEls.length;
        fontEls.push(xml);
        fontProps.push(parseFont(xml));
        fontIndexByXml.set(xml, idx);
      }
      return idx;
    };
    const ensureFill = (xml: string): number => {
      let idx = fillIndexByXml.get(xml);
      if (idx === undefined) {
        idx = fillEls.length;
        fillEls.push(xml);
        fillIndexByXml.set(xml, idx);
      }
      return idx;
    };
    const ensureBorder = (xml: string): number => {
      let idx = borderIndexByXml.get(xml);
      if (idx === undefined) {
        idx = borderEls.length;
        borderEls.push(xml);
        borderIndexByXml.set(xml, idx);
      }
      return idx;
    };
    const ensureXf = (x: Omit<XfProps, 'raw'>): number => {
      const xml = xfToXml(x);
      let idx = xfIndexByXml.get(xml);
      if (idx === undefined) {
        idx = xfEls.length;
        xfEls.push(xml);
        xfs.push({ ...x, raw: xml });
        xfIndexByXml.set(xml, idx);
      }
      return idx;
    };

    /** Resolve the xf index a target cell should carry, from its base xf. */
    const resolveXf = (baseIdx: number, style: CellStyle): number => {
      const base: XfProps =
        baseIdx >= 0 && baseIdx < xfs.length
          ? (xfs[baseIdx] as XfProps)
          : { numFmtId: 0, fontId: 0, fillId: 0, borderId: 0, xfId: 0, alignment: '', protection: '', raw: '' };
      let { numFmtId, fontId, fillId, borderId } = base;
      if (style.numberFormatCode !== undefined) {
        numFmtId = style.numberFormatCode.toLowerCase() === 'general' ? 0 : numFmtIdFor(style.numberFormatCode);
      }
      const hasFontField =
        style.fontName !== undefined || style.fontSize !== undefined || style.bold !== undefined ||
        style.italic !== undefined || style.underline !== undefined || style.strikethrough !== undefined ||
        style.fontColor !== undefined;
      if (hasFontField) {
        const baseProps: FontProps = fontProps[base.fontId] ?? {};
        const bp: FontProps = { ...baseProps };
        if (style.fontName !== undefined) bp.name = style.fontName;
        if (style.fontSize !== undefined) bp.size = style.fontSize;
        if (style.bold !== undefined) bp.bold = style.bold;
        if (style.italic !== undefined) bp.italic = style.italic;
        if (style.underline !== undefined) bp.underline = style.underline;
        if (style.strikethrough !== undefined) bp.strikethrough = style.strikethrough;
        if (style.fontColor !== undefined) bp.color = style.fontColor;
        // Fixed-point guard (byte-idempotent re-saves): when the merged
        // props are exactly the base font's props — e.g. a style that
        // only restates the size the base font already has — reuse the
        // base font instead of minting a duplicate <font> whose
        // serialization differs from the producer's own.
        const sameFont =
          bp.name === baseProps.name && bp.size === baseProps.size &&
          bp.bold === baseProps.bold && bp.italic === baseProps.italic &&
          bp.underline === baseProps.underline &&
          bp.strikethrough === baseProps.strikethrough && bp.color === baseProps.color;
        fontId = sameFont ? base.fontId : ensureFont(fontToXml(bp));
      }
      if (style.fillColor !== undefined) {
        const xml = fillToXml(style.fillColor);
        if (xml) fillId = ensureFill(xml);
      }
      if (style.borders !== undefined) {
        borderId = ensureBorder(borderToXml(style.borders));
      }
      let alignment = base.alignment;
      const hasAlignField =
        style.hAlign !== undefined || style.vAlign !== undefined || style.wrapText !== undefined ||
        style.indent !== undefined || style.orientation !== undefined || style.verticalText !== undefined;
      if (hasAlignField) {
        alignment = alignmentToXml({
          hAlign: style.hAlign,
          vAlign: style.vAlign,
          wrapText: style.wrapText,
          indent: style.indent,
          orientation: style.orientation,
          verticalText: style.verticalText,
        });
      }
      return ensureXf({
        numFmtId,
        fontId,
        fillId,
        borderId,
        xfId: base.xfId,
        alignment,
        protection: base.protection,
      });
    };

    let touchedAnySheet = false;
    for (const [sheetName, cellStyles] of targets) {
      const entries = Object.entries(cellStyles);
      if (entries.length === 0) continue;
      const path = parts.get(sheetName);
      const raw = path ? files[path] : undefined;
      if (!path || !raw) continue;
      let xml = decoder.decode(raw);

      // Index existing <c> tags + row/col style fallbacks (base xf source).
      const ctags: CTagSpan[] = [];
      const cRe = /<c\b[^>]*>/g;
      let cm: RegExpExecArray | null;
      while ((cm = cRe.exec(xml)) !== null) {
        const ref = attr(cm[0], 'r');
        if (!ref) continue;
        const rc = decodeRef(ref);
        if (!rc) continue;
        const sAttr = attr(cm[0], 's');
        ctags.push({
          start: cm.index,
          end: cm.index + cm[0].length,
          r: rc.r,
          c: rc.c,
          s: sAttr !== null && /^\d+$/.test(sAttr) ? parseInt(sAttr, 10) : null,
        });
      }
      const ctagByCell = new Map<string, CTagSpan>(ctags.map((t) => [`${t.r}:${t.c}`, t]));
      const rowStyles = new Map<number, number>();
      for (const tag of xml.match(/<row\b[^>]*>/g) ?? []) {
        const s = attr(tag, 's');
        const r = attr(tag, 'r');
        if (s !== null && r !== null && /^\d+$/.test(s) && /^\d+$/.test(r)) rowStyles.set(parseInt(r, 10), parseInt(s, 10));
      }
      const colStyles: Array<{ min: number; max: number; s: number }> = [];
      for (const tag of xml.match(/<col\b[^>]*>/g) ?? []) {
        const s = attr(tag, 'style') ?? attr(tag, 's');
        if (s === null || !/^\d+$/.test(s)) continue;
        const min = parseInt(attr(tag, 'min') ?? '', 10);
        const max = parseInt(attr(tag, 'max') ?? '', 10);
        if (Number.isInteger(min) && Number.isInteger(max)) colStyles.push({ min, max, s: parseInt(s, 10) });
      }
      const baseStyleFor = (r: number, c: number, ownS: number | null): number => {
        if (ownS !== null && ownS >= 0) return ownS;
        const rs = rowStyles.get(r + 1);
        if (rs !== undefined) return rs;
        const col = colStyles.find((cs) => c + 1 >= cs.min && c + 1 <= cs.max);
        return col ? col.s : 0;
      };

      const edits: Array<{ index: number; del: number; ins: string }> = [];
      const newCellsByRow = new Map<number, Array<{ r: number; c: number; xfIdx: number }>>();
      for (const [key, style] of entries) {
        const mm = /^(\d+):(\d+)$/.exec(key);
        if (!mm) continue;
        const r = Number(mm[1]);
        const c = Number(mm[2]);
        const existing = ctagByCell.get(`${r}:${c}`);
        const xfIdx = resolveXf(baseStyleFor(r, c, existing?.s ?? null), style);
        if (existing) {
          if (existing.s === xfIdx) continue;
          const tag = xml.slice(existing.start, existing.end);
          const sRe = /\ss="\d+"/;
          if (sRe.test(tag)) {
            const sm = sRe.exec(tag) as RegExpExecArray;
            edits.push({ index: existing.start + sm.index, del: sm[0].length, ins: ` s="${xfIdx}"` });
          } else {
            const closeAt = tag.endsWith('/>') ? existing.end - 2 : existing.end - 1;
            edits.push({ index: closeAt, del: 0, ins: ` s="${xfIdx}"` });
          }
          touchedAnySheet = true;
        } else {
          let arr = newCellsByRow.get(r);
          if (!arr) {
            arr = [];
            newCellsByRow.set(r, arr);
          }
          arr.push({ r, c, xfIdx });
          touchedAnySheet = true;
        }
      }

      // Materialize empty styled cells, grouped by row (protection pattern).
      for (const [r, cells] of [...newCellsByRow.entries()].sort((a, b) => a[0] - b[0])) {
        const row1 = r + 1;
        const sorted = [...cells].sort((a, b) => a.c - b.c);
        const cXml = sorted.map((t) => `<c r="${toA1CellRef(t.r, t.c)}" s="${t.xfIdx}"/>`).join('');
        const rowRe = new RegExp(`<row\\b[^>]*\\br\\s*=\\s*"${row1}"[^>]*>`, 'g');
        const rowMatch = rowRe.exec(xml);
        if (rowMatch) {
          const rowTag = rowMatch[0];
          const rowStart = rowMatch.index;
          const rowOpenEnd = rowStart + rowTag.length;
          if (rowTag.endsWith('/>')) {
            edits.push({ index: rowOpenEnd, del: 0, ins: `${cXml}</row>` });
            edits.push({ index: rowOpenEnd - 2, del: 2, ins: '>' });
          } else {
            const rowCells = ctags.filter((t) => t.r === r).sort((a, b) => a.c - b.c);
            let insertAt = xml.indexOf('</row>', rowOpenEnd);
            if (insertAt < 0) insertAt = rowOpenEnd;
            for (const nc of sorted) {
              const after = rowCells.find((t) => t.c > nc.c);
              if (after) {
                insertAt = after.start;
                break;
              }
            }
            edits.push({ index: insertAt, del: 0, ins: cXml });
          }
        } else {
          const newRow = `<row r="${row1}">${cXml}</row>`;
          let insertAt = -1;
          const allRows = [...xml.matchAll(/<row\b[^>]*\br\s*=\s*"(\d+)"[^>]*>/g)];
          for (const ar of allRows) {
            if (Number(ar[1]) > row1) {
              insertAt = ar.index ?? -1;
              break;
            }
          }
          if (insertAt < 0) {
            insertAt = xml.indexOf('</sheetData>');
            if (insertAt < 0) continue;
          }
          edits.push({ index: insertAt, del: 0, ins: newRow });
        }
      }

      edits.sort((a, b) => b.index - a.index);
      for (const e of edits) {
        xml = xml.slice(0, e.index) + e.ins + xml.slice(e.index + e.del);
      }
      files[path] = encoder.encode(xml);
    }

    if (!touchedAnySheet) return packageBytes;

    // -- Rewrite the style tables with updated counts.
    stylesXml = replaceBlock(stylesXml, 'fonts', fontEls);
    stylesXml = replaceBlock(stylesXml, 'fills', fillEls);
    stylesXml = replaceBlock(stylesXml, 'borders', borderEls);
    stylesXml = replaceBlock(stylesXml, 'cellXfs', xfEls);
    if (newNumFmts.length > 0) {
      const existing = numFmtsBlock ? splitElements(numFmtsBlock.inner, 'numFmt') : [];
      const all = [...existing, ...newNumFmts.map((n) => `<numFmt numFmtId="${n.id}" formatCode="${escapeXml(n.code)}"/>`)];
      if (numFmtsBlock) {
        stylesXml = replaceBlock(stylesXml, 'numFmts', all);
      } else {
        // Schema order: <numFmts> is the first child of <styleSheet>.
        const openEnd = stylesXml.indexOf('>', stylesXml.indexOf('<styleSheet')) + 1;
        stylesXml = `${stylesXml.slice(0, openEnd)}<numFmts count="${all.length}">${all.join('')}</numFmts>${stylesXml.slice(openEnd)}`;
      }
    }
    files['xl/styles.xml'] = encoder.encode(stylesXml);
    return zipSyncStable(files);
  } catch {
    return packageBytes;
  }
}

/** Replace a `<tag count="…">…</tag>` block's contents + count. */
function replaceBlock(xml: string, tag: string, elements: string[]): string {
  const block = blockInner(xml, tag);
  if (!block) return xml;
  const open = /\scount\s*=/.test(block.openTag)
    ? block.openTag.replace(/\scount\s*=\s*"[^"]*"/, ` count="${elements.length}"`)
    : block.openTag.replace(/>$/, ` count="${elements.length}">`);
  return xml.slice(0, block.start) + open + elements.join('') + `</${tag}>` + xml.slice(block.end);
}

// ---------------------------------------------------------------------------
// Streaming save (W21): append-only styles resolver
// ---------------------------------------------------------------------------

/**
 * Append-only styles resolver for the streaming save writer
 * (streamingSave.ts). Holds the SOURCE workbook's style tables and mints
 * new fonts/fills/borders/numFmts/cellXfs ONLY by appending — original
 * entries keep their indices, so worksheet parts copied byte-for-byte
 * (which reference shared strings / xf indices of the source package)
 * stay valid against the rewritten styles.xml.
 *
 * `xfFor(style, formatCode)` resolves the xf index a re-serialized cell
 * must carry: the number format comes from `style.numberFormatCode`
 * when present, else the explicit `formatCode`; font/fill/border/
 * alignment come from the CellStyle (fields absent = workbook default).
 * Resolution is deduped (same input → same xf, appended at most once).
 * When nothing was ever appended, `dirty` is false and `toXml()`
 * returns the source styles.xml unchanged (the caller then copies the
 * source part verbatim instead).
 */
export interface StreamingStylesResolver {
  xfFor(style: CellStyle | undefined, formatCode: string | undefined): number;
  readonly dirty: boolean;
  readonly appendedXfs: number;
  toXml(): string;
}

export function createStreamingStyles(stylesXml: string): StreamingStylesResolver {
  const fontsBlock = blockInner(stylesXml, 'fonts');
  const fillsBlock = blockInner(stylesXml, 'fills');
  const bordersBlock = blockInner(stylesXml, 'borders');
  const numFmtsBlock = blockInner(stylesXml, 'numFmts');
  const xfsBlock = blockInner(stylesXml, 'cellXfs');
  if (!xfsBlock) throw new Error('createStreamingStyles: styles.xml has no <cellXfs>');
  const fontEls = fontsBlock ? splitElements(fontsBlock.inner, 'font') : [];
  const fillEls = fillsBlock ? splitElements(fillsBlock.inner, 'fill') : [];
  const borderEls = bordersBlock ? splitElements(bordersBlock.inner, 'border') : [];
  const xfEls = splitElements(xfsBlock.inner, 'xf');
  if (xfEls.length === 0) throw new Error('createStreamingStyles: empty <cellXfs>');
  const fontProps = fontEls.map(parseFont);
  const fontIndexByXml = new Map<string, number>(fontEls.map((x, i) => [x, i]));
  const fillIndexByXml = new Map<string, number>(fillEls.map((x, i) => [x, i]));
  const borderIndexByXml = new Map<string, number>(borderEls.map((x, i) => [x, i]));
  const xfIndexByXml = new Map<string, number>(xfEls.map((x, i) => [x, i]));
  const customIdByCode = new Map<string, number>();
  let nextCustomId = 164;
  if (numFmtsBlock) {
    for (const el of splitElements(numFmtsBlock.inner, 'numFmt')) {
      const id = attr(el, 'numFmtId');
      const code = attr(el, 'formatCode');
      if (id !== null && code !== null) {
        customIdByCode.set(code, Number(id));
        nextCustomId = Math.max(nextCustomId, Number(id) + 1);
      }
    }
  }
  const newNumFmts: Array<{ id: number; code: string }> = [];
  let dirty = false;
  const numFmtIdFor = (code: string): number => {
    const builtin = builtinIdForCode(code);
    if (builtin !== null) return builtin;
    const existing = customIdByCode.get(code);
    if (existing !== undefined) return existing;
    const id = nextCustomId++;
    customIdByCode.set(code, id);
    newNumFmts.push({ id, code });
    dirty = true;
    return id;
  };
  const ensureFont = (xml: string): number => {
    let idx = fontIndexByXml.get(xml);
    if (idx === undefined) {
      idx = fontEls.length;
      fontEls.push(xml);
      fontProps.push(parseFont(xml));
      fontIndexByXml.set(xml, idx);
      dirty = true;
    }
    return idx;
  };
  const ensureFill = (xml: string): number => {
    let idx = fillIndexByXml.get(xml);
    if (idx === undefined) {
      idx = fillEls.length;
      fillEls.push(xml);
      fillIndexByXml.set(xml, idx);
      dirty = true;
    }
    return idx;
  };
  const ensureBorder = (xml: string): number => {
    let idx = borderIndexByXml.get(xml);
    if (idx === undefined) {
      idx = borderEls.length;
      borderEls.push(xml);
      borderIndexByXml.set(xml, idx);
      dirty = true;
    }
    return idx;
  };
  const ensureXf = (x: Omit<XfProps, 'raw'>): number => {
    const xml = xfToXml(x);
    let idx = xfIndexByXml.get(xml);
    if (idx === undefined) {
      idx = xfEls.length;
      xfEls.push(xml);
      xfIndexByXml.set(xml, idx);
      dirty = true;
    }
    return idx;
  };
  const cache = new Map<string, number>();
  const baseXfCount = xfEls.length;
  return {
    get dirty() {
      return dirty;
    },
    get appendedXfs() {
      return xfEls.length - baseXfCount;
    },
    xfFor(style: CellStyle | undefined, formatCode: string | undefined): number {
      const code = style?.numberFormatCode ?? formatCode;
      const key = JSON.stringify([style ?? null, code ?? null]);
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      let numFmtId = 0;
      if (code !== undefined && code !== '' && code.toLowerCase() !== 'general') {
        numFmtId = numFmtIdFor(code);
      }
      let fontId = 0;
      const hasFontField =
        style !== undefined &&
        (style.fontName !== undefined || style.fontSize !== undefined || style.bold !== undefined ||
          style.italic !== undefined || style.underline !== undefined ||
          style.strikethrough !== undefined || style.fontColor !== undefined);
      if (style && hasFontField) {
        const bp: FontProps = { ...(fontProps[0] ?? {}) };
        if (style.fontName !== undefined) bp.name = style.fontName;
        if (style.fontSize !== undefined) bp.size = style.fontSize;
        if (style.bold !== undefined) bp.bold = style.bold;
        if (style.italic !== undefined) bp.italic = style.italic;
        if (style.underline !== undefined) bp.underline = style.underline;
        if (style.strikethrough !== undefined) bp.strikethrough = style.strikethrough;
        if (style.fontColor !== undefined) bp.color = style.fontColor;
        fontId = ensureFont(fontToXml(bp));
      }
      let fillId = 0;
      if (style?.fillColor !== undefined) {
        const xml = fillToXml(style.fillColor);
        if (xml) fillId = ensureFill(xml);
      }
      let borderId = 0;
      if (style?.borders !== undefined) borderId = ensureBorder(borderToXml(style.borders));
      let alignment = '';
      if (
        style &&
        (style.hAlign !== undefined || style.vAlign !== undefined || style.wrapText !== undefined ||
          style.indent !== undefined || style.orientation !== undefined || style.verticalText !== undefined)
      ) {
        alignment = alignmentToXml({
          hAlign: style.hAlign,
          vAlign: style.vAlign,
          wrapText: style.wrapText,
          indent: style.indent,
          orientation: style.orientation,
          verticalText: style.verticalText,
        });
      }
      // The all-defaults resolution IS xf 0 — never append a duplicate
      // of the workbook default (SheetJS's own serialization of xf 0
      // carries extra attributes, so an xml-dedupe would miss it).
      const idx =
        numFmtId === 0 && fontId === 0 && fillId === 0 && borderId === 0 && alignment === ''
          ? 0
          : ensureXf({ numFmtId, fontId, fillId, borderId, xfId: 0, alignment, protection: '' });
      cache.set(key, idx);
      return idx;
    },
    toXml(): string {
      if (!dirty) return stylesXml;
      if ((fontEls.length > 0 && !fontsBlock) || (fillEls.length > 0 && !fillsBlock) || (borderEls.length > 0 && !bordersBlock)) {
        throw new Error('createStreamingStyles: styles.xml is missing a table block an appended entry needs');
      }
      let out = stylesXml;
      if (fontsBlock) out = replaceBlock(out, 'fonts', fontEls);
      if (fillsBlock) out = replaceBlock(out, 'fills', fillEls);
      if (bordersBlock) out = replaceBlock(out, 'borders', borderEls);
      out = replaceBlock(out, 'cellXfs', xfEls);
      if (newNumFmts.length > 0) {
        const existing = numFmtsBlock ? splitElements(numFmtsBlock.inner, 'numFmt') : [];
        const all = [
          ...existing,
          ...newNumFmts.map((n) => `<numFmt numFmtId="${n.id}" formatCode="${escapeXml(n.code)}"/>`),
        ];
        if (numFmtsBlock) {
          out = replaceBlock(out, 'numFmts', all);
        } else {
          const openEnd = out.indexOf('>', out.indexOf('<styleSheet')) + 1;
          out = `${out.slice(0, openEnd)}<numFmts count="${all.length}">${all.join('')}</numFmts>${out.slice(openEnd)}`;
        }
      }
      return out;
    },
  };
}

/** 0-based (r, c) -> A1 ref. */
function toA1CellRef(r: number, c: number): string {
  let letters = '';
  let cc = c;
  do {
    letters = String.fromCharCode(65 + (cc % 26)) + letters;
    cc = Math.floor(cc / 26) - 1;
  } while (cc >= 0);
  return `${letters}${r + 1}`;
}
