/**
 * Native sparkline round-trip — worksheet `<extLst>` →
 * `<x14:sparklineGroups>` ([MS-XLSX] §2.3.2; audit §4.3).
 *
 * Sparklines are entirely an Excel 2010 extension: ISO/IEC 29500
 * SpreadsheetML has no sparkline element. The worksheet carries them as
 * the LAST element of CT_Worksheet, inside `<extLst>`:
 *
 *   <extLst><ext uri="{05A34EAD-0FBD-432F-B84B-A6A1376A73FE}"
 *       xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main">
 *     <x14:sparklineGroups xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">
 *       <x14:sparklineGroup type="line" …>
 *         <x14:colorSeries …/> … <x14:colorLow …/>
 *         [<xm:f>date range</xm:f>]            (date-axis groups only)
 *         <x14:sparklines>
 *           <x14:sparkline><xm:f>data</xm:f><xm:sqref>cell</xm:sqref></x14:sparkline>
 *           …
 *         </x14:sparklines>
 *       </x14:sparklineGroup>
 *       …
 *     </x14:sparklineGroups>
 *   </ext></extLst>
 *
 * Model (on SheetData): `sparklineGroups` — one entry per
 * `<x14:sparklineGroup>` (CT_SparklineGroup), in document order. The
 * full attribute surface Excel writes is modeled:
 *
 *   type (line|column|stacked — "stacked" is Excel's win/loss type),
 *   lineWeight, displayEmptyCellsAs (gap|zero|span, carried verbatim),
 *   the six point/marker switches (markers, high, low, first, last,
 *   negative — grouped under `markers`), the axis switches and scaling
 *   (displayXAxis, minAxisType/maxAxisType of individual|group|custom,
 *   manualMin/manualMax — grouped under `axis`), dateAxis (+ the
 *   group's own `<xm:f>` date range in `dateRef`), displayHidden and
 *   rightToLeft. Colors are child elements (CT_Color — the same
 *   attribute-only color as styles `<color>`: rgb/theme/tint/indexed/
 *   auto) in schema sequence: colorSeries, colorNegative, colorAxis,
 *   colorMarkers, colorFirst, colorLast, colorHigh, colorLow.
 *
 * Each `<x14:sparkline>` (CT_Sparkline, [MS-XLSX] §2.6.9) is a pair of
 * an optional data range and a required single-cell target. Excel
 * writes the pair as `<xm:f>` / `<xm:sqref>` (namespace
 * http://schemas.microsoft.com/office/excel/2006/main); some writers
 * emit them in the x14 namespace instead — the parser accepts xm:,
 * x14: and unprefixed forms, the writer always emits Excel's xm: form.
 * Data refs are carried VERBATIM (they are formulas in the §2.2.2
 * sparkline-formula grammar — sheet prefix + single-row/column area,
 * or a defined name); target refs are normalized like every other ref
 * in this adapter (uppercase, `$` stripped).
 *
 * Attribute presence is significant: an attribute the file did not
 * write is absent from the model (its [MS-XLSX] default applies), and
 * the writer emits exactly the attributes the model carries, so
 * parse → write → parse is model-identical and a file's explicit
 * `markers="0"` survives instead of collapsing into the default.
 */
import {
  boolAttrValue,
  elementBody,
  escapeXmlAttr,
  escapeXmlText,
  findBlock,
  findBlocks,
  normalizeRef,
  numAttrValue,
  parseAttrRecord,
  splitTopElements,
} from './nativeXmlUtil.js';
import { parseColorElement, type CfColor } from './conditionalFormattingXml.js';

/** The x14 extension namespace (Excel 2010 extensions). */
export const X14_NAMESPACE = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
/** The xm namespace Excel uses for `<xm:f>` / `<xm:sqref>` inside sparklines. */
export const XM_NAMESPACE = 'http://schemas.microsoft.com/office/excel/2006/main';
/** The `<ext uri>` that owns `<x14:sparklineGroups>` ([MS-XLSX] §2.3.2). */
export const SPARKLINE_GROUPS_EXT_URI = '{05A34EAD-0FBD-432F-B84B-A6A1376A73FE}';

/** ST_SparklineType: line | column | stacked (win/loss). */
export type SparklineType = 'line' | 'column' | 'stacked';

/**
 * A sparkline color: a CT_Color element's attributes, verbatim — the
 * identical shape to the styles `<color>` type (`CfColor`).
 */
export type SparklineColor = CfColor;

/** The six point/marker switches of CT_SparklineGroup. */
export interface SparklineMarkers {
  /** `markers` — show a marker for every data point (line groups). */
  show?: boolean;
  /** `high` — mark the highest point(s). */
  high?: boolean;
  /** `low` — mark the lowest point(s). */
  low?: boolean;
  /** `first` — mark the first point. */
  first?: boolean;
  /** `last` — mark the last point. */
  last?: boolean;
  /** `negative` — mark negative points (distinct color). */
  negative?: boolean;
}

/** The vertical-axis settings of CT_SparklineGroup. */
export interface SparklineAxis {
  /** `displayXAxis` — draw the horizontal axis. */
  show?: boolean;
  /** `minAxisType`: individual | group | custom. */
  minType?: string;
  /** `maxAxisType`: individual | group | custom. */
  maxType?: string;
  /** `manualMin` — the custom minimum (minType = custom). */
  manualMin?: number;
  /** `manualMax` — the custom maximum (maxType = custom). */
  manualMax?: number;
}

/** One `<x14:sparkline>`: a data range placed in one cell. */
export interface Sparkline {
  /** Data range (the `<xm:f>` body), verbatim; absent when the file omitted it. */
  dataRef?: string;
  /** Target cell (the `<xm:sqref>` body), canonical A1. */
  targetRef: string;
}

/** One `<x14:sparklineGroup>` (CT_SparklineGroup). */
export interface SparklineGroup {
  type: SparklineType;
  /** `lineWeight`, in points (schema default 0.75). */
  lineWeight?: number;
  /** `displayEmptyCellsAs`: gap | zero | span (verbatim). */
  displayEmptyCellsAs?: string;
  markers?: SparklineMarkers;
  axis?: SparklineAxis;
  /** `dateAxis` — the data is plotted on a date axis (see `dateRef`). */
  dateAxis?: boolean;
  /**
   * The group's own `<xm:f>` — the date range for a date-axis group.
   * Only meaningful with `dateAxis`; carried verbatim like a data ref.
   */
  dateRef?: string;
  /** `displayHidden` — plot data in hidden rows/columns. */
  displayHidden?: boolean;
  /** `rightToLeft` — plot the data in reverse order. */
  rightToLeft?: boolean;
  /** `<x14:colorSeries>` — the series (line/bar) color. */
  seriesColor?: SparklineColor;
  /** `<x14:colorNegative>` — the negative-point color. */
  negativeColor?: SparklineColor;
  /** `<x14:colorAxis>` — the horizontal-axis color. */
  axisColor?: SparklineColor;
  /** `<x14:colorMarkers>` — the data-marker color. */
  markersColor?: SparklineColor;
  /** `<x14:colorFirst>` — the first-point color. */
  firstColor?: SparklineColor;
  /** `<x14:colorLast>` — the last-point color. */
  lastColor?: SparklineColor;
  /** `<x14:colorHigh>` — the highest-point color. */
  highColor?: SparklineColor;
  /** `<x14:colorLow>` — the lowest-point color. */
  lowColor?: SparklineColor;
  sparklines: Sparkline[];
}

const SPARKLINE_TYPES: ReadonlySet<string> = new Set(['line', 'column', 'stacked']);

/** Color child elements in CT_SparklineGroup sequence order. */
const COLOR_SLOTS = [
  ['colorSeries', 'seriesColor'],
  ['colorNegative', 'negativeColor'],
  ['colorAxis', 'axisColor'],
  ['colorMarkers', 'markersColor'],
  ['colorFirst', 'firstColor'],
  ['colorLast', 'lastColor'],
  ['colorHigh', 'highColor'],
  ['colorLow', 'lowColor'],
] as const;

/* ------------------------------------------------------------------ */
/* Parse                                                               */
/* ------------------------------------------------------------------ */

/** Body of the first `<prefix:tag>` child of `el`, across writer prefix variants. */
function childBody(el: string, local: string): string | undefined {
  for (const tag of [`xm:${local}`, `x14:${local}`, local]) {
    const block = findBlock(el, tag);
    if (block) {
      const body = elementBody(block.whole).trim();
      return body === '' ? undefined : body;
    }
  }
  return undefined;
}

function parseSparklineGroup(el: string): SparklineGroup {
  const openTag = /^<x14:sparklineGroup\b[^>]*>/.exec(el)?.[0] ?? (el.endsWith('/>') ? el : '');
  const a = parseAttrRecord(openTag);
  const group: SparklineGroup = {
    type: SPARKLINE_TYPES.has(a.type ?? '') ? (a.type as SparklineType) : 'line',
    sparklines: [],
  };
  const lineWeight = numAttrValue(a.lineWeight);
  if (lineWeight !== undefined) group.lineWeight = lineWeight;
  if (a.displayEmptyCellsAs !== undefined) group.displayEmptyCellsAs = a.displayEmptyCellsAs;

  const markers: SparklineMarkers = {};
  let hasMarker = false;
  const markerAttrs = [
    ['markers', 'show'],
    ['high', 'high'],
    ['low', 'low'],
    ['first', 'first'],
    ['last', 'last'],
    ['negative', 'negative'],
  ] as const;
  for (const [attr, key] of markerAttrs) {
    if (a[attr] !== undefined) {
      markers[key] = boolAttrValue(a[attr], false);
      hasMarker = true;
    }
  }
  if (hasMarker) group.markers = markers;

  const axis: SparklineAxis = {};
  let hasAxis = false;
  if (a.displayXAxis !== undefined) { axis.show = boolAttrValue(a.displayXAxis, false); hasAxis = true; }
  if (a.minAxisType !== undefined) { axis.minType = a.minAxisType; hasAxis = true; }
  if (a.maxAxisType !== undefined) { axis.maxType = a.maxAxisType; hasAxis = true; }
  const manualMin = numAttrValue(a.manualMin);
  if (manualMin !== undefined) { axis.manualMin = manualMin; hasAxis = true; }
  const manualMax = numAttrValue(a.manualMax);
  if (manualMax !== undefined) { axis.manualMax = manualMax; hasAxis = true; }
  if (hasAxis) group.axis = axis;

  if (a.dateAxis !== undefined) group.dateAxis = boolAttrValue(a.dateAxis, false);
  if (a.displayHidden !== undefined) group.displayHidden = boolAttrValue(a.displayHidden, false);
  if (a.rightToLeft !== undefined) group.rightToLeft = boolAttrValue(a.rightToLeft, false);

  for (const [tag, key] of COLOR_SLOTS) {
    const block = findBlock(el, `x14:${tag}`);
    if (block) group[key] = parseColorElement(block.whole);
  }

  // The group's own <xm:f> (the date-axis range) is a direct child
  // BEFORE <x14:sparklines>; the per-sparkline <xm:f> elements live
  // inside it, so only the head region is searched here.
  const sparklinesAt = el.indexOf('<x14:sparklines');
  const head = sparklinesAt >= 0 ? el.slice(0, sparklinesAt) : el;
  const dateRef = childBody(head, 'f');
  if (dateRef !== undefined) group.dateRef = dateRef;

  const listBlock = findBlock(el, 'x14:sparklines');
  if (listBlock) {
    for (const spEl of splitTopElements(listBlock.inner, 'x14:sparkline')) {
      const target = childBody(spEl, 'sqref');
      if (target === undefined) continue;
      const sparkline: Sparkline = { targetRef: normalizeRef(target) };
      const data = childBody(spEl, 'f');
      if (data !== undefined) sparkline.dataRef = data;
      group.sparklines.push(sparkline);
    }
  }
  return group;
}

/**
 * Parse every sparkline group of a worksheet part (its `<extLst>`
 * sparkline extension), in document order. [] when the sheet has none.
 */
export function parseSparklineGroups(sheetXml: string): SparklineGroup[] {
  const out: SparklineGroup[] = [];
  for (const block of findBlocks(sheetXml, 'x14:sparklineGroups')) {
    for (const el of splitTopElements(block.inner, 'x14:sparklineGroup')) {
      out.push(parseSparklineGroup(el));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Serialize                                                           */
/* ------------------------------------------------------------------ */

function boolStr(b: boolean): string {
  return b ? '1' : '0';
}

function sparkColorToXml(tag: string, c: SparklineColor): string {
  const attrs: string[] = [];
  if (c.auto !== undefined) attrs.push(`auto="${boolStr(c.auto)}"`);
  if (c.rgb !== undefined) attrs.push(`rgb="${escapeXmlAttr(c.rgb)}"`);
  if (c.theme !== undefined) attrs.push(`theme="${c.theme}"`);
  if (c.tint !== undefined) attrs.push(`tint="${c.tint}"`);
  if (c.indexed !== undefined) attrs.push(`indexed="${c.indexed}"`);
  return `<x14:${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}/>`;
}

/** Serialize one `<x14:sparklineGroup>` element. */
export function sparklineGroupToXml(group: SparklineGroup): string {
  const attrs = [`type="${escapeXmlAttr(group.type)}"`];
  if (group.lineWeight !== undefined) attrs.push(`lineWeight="${group.lineWeight}"`);
  if (group.dateAxis !== undefined) attrs.push(`dateAxis="${boolStr(group.dateAxis)}"`);
  if (group.displayEmptyCellsAs !== undefined) {
    attrs.push(`displayEmptyCellsAs="${escapeXmlAttr(group.displayEmptyCellsAs)}"`);
  }
  const m = group.markers;
  if (m?.show !== undefined) attrs.push(`markers="${boolStr(m.show)}"`);
  if (m?.high !== undefined) attrs.push(`high="${boolStr(m.high)}"`);
  if (m?.low !== undefined) attrs.push(`low="${boolStr(m.low)}"`);
  if (m?.first !== undefined) attrs.push(`first="${boolStr(m.first)}"`);
  if (m?.last !== undefined) attrs.push(`last="${boolStr(m.last)}"`);
  if (m?.negative !== undefined) attrs.push(`negative="${boolStr(m.negative)}"`);
  const ax = group.axis;
  if (ax?.show !== undefined) attrs.push(`displayXAxis="${boolStr(ax.show)}"`);
  if (group.displayHidden !== undefined) attrs.push(`displayHidden="${boolStr(group.displayHidden)}"`);
  if (ax?.minType !== undefined) attrs.push(`minAxisType="${escapeXmlAttr(ax.minType)}"`);
  if (ax?.maxType !== undefined) attrs.push(`maxAxisType="${escapeXmlAttr(ax.maxType)}"`);
  if (ax?.manualMin !== undefined) attrs.push(`manualMin="${ax.manualMin}"`);
  if (ax?.manualMax !== undefined) attrs.push(`manualMax="${ax.manualMax}"`);
  if (group.rightToLeft !== undefined) attrs.push(`rightToLeft="${boolStr(group.rightToLeft)}"`);

  const kids: string[] = [];
  for (const [tag, key] of COLOR_SLOTS) {
    const color = group[key];
    if (color) kids.push(sparkColorToXml(tag, color));
  }
  if (group.dateRef !== undefined) kids.push(`<xm:f>${escapeXmlText(group.dateRef)}</xm:f>`);
  const entries = group.sparklines.map((sp) => {
    const f = sp.dataRef !== undefined ? `<xm:f>${escapeXmlText(sp.dataRef)}</xm:f>` : '';
    return `<x14:sparkline>${f}<xm:sqref>${escapeXmlText(normalizeRef(sp.targetRef))}</xm:sqref></x14:sparkline>`;
  });
  kids.push(
    entries.length === 0 ? '<x14:sparklines/>' : `<x14:sparklines>${entries.join('')}</x14:sparklines>`,
  );
  return `<x14:sparklineGroup ${attrs.join(' ')}>${kids.join('')}</x14:sparklineGroup>`;
}

/** Serialize the `<x14:sparklineGroups>` element ('' when there are no groups). */
export function sparklineGroupsToXml(groups: readonly SparklineGroup[]): string {
  if (groups.length === 0) return '';
  const inner = groups.map(sparklineGroupToXml).join('');
  return `<x14:sparklineGroups xmlns:xm="${XM_NAMESPACE}">${inner}</x14:sparklineGroups>`;
}

/** Serialize the `<ext>` element carrying the groups ('' when empty). */
export function sparklineExtXml(groups: readonly SparklineGroup[]): string {
  const inner = sparklineGroupsToXml(groups);
  if (inner === '') return '';
  return `<ext uri="${SPARKLINE_GROUPS_EXT_URI}" xmlns:x14="${X14_NAMESPACE}">${inner}</ext>`;
}

/** Serialize the complete `<extLst>` wrapper for a sheet whose only extension is sparklines. */
export function sparklineExtLstXml(groups: readonly SparklineGroup[]): string {
  const ext = sparklineExtXml(groups);
  return ext === '' ? '' : `<extLst>${ext}</extLst>`;
}

/* ------------------------------------------------------------------ */
/* Splice into a worksheet part                                        */
/* ------------------------------------------------------------------ */

/**
 * Ensure the worksheet root declares the x14 namespace and lists it in
 * `mc:Ignorable` (the declarations Excel writes on every sheet that
 * uses x14 extensions). No-op when the string carries no `<worksheet>`
 * root (e.g. a streaming tail fragment — there the `<ext>` element's
 * own xmlns:x14 declaration keeps the part valid).
 */
export function ensureSparklineRootDecls(sheetXml: string): string {
  const m = /<worksheet\b[^>]*>/.exec(sheetXml);
  if (!m) return sheetXml;
  let tag = m[0];
  const selfClosing = tag.endsWith('/>');
  const addDecl = (decl: string): void => {
    tag = selfClosing ? `${tag.slice(0, -2)} ${decl}/>` : `${tag.slice(0, -1)} ${decl}>`;
  };
  if (!/\bxmlns:x14\s*=/.test(tag)) addDecl(`xmlns:x14="${X14_NAMESPACE}"`);
  if (!/\bxmlns:mc\s*=/.test(tag)) {
    addDecl('xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"');
  }
  const ignorable = /\bmc:Ignorable\s*=\s*"([^"]*)"/.exec(tag);
  if (ignorable) {
    const tokens = (ignorable[1] ?? '').split(/\s+/).filter((t) => t !== '');
    if (!tokens.includes('x14')) {
      tag = tag.replace(ignorable[0], `mc:Ignorable="${[...tokens, 'x14'].join(' ')}"`);
    }
  } else {
    addDecl('mc:Ignorable="x14"');
  }
  return sheetXml.slice(0, m.index) + tag + sheetXml.slice(m.index + m[0].length);
}

/**
 * Replace a worksheet's sparkline extension with the model's: the old
 * sparkline `<ext>` (identified by its extension URI or its
 * sparklineGroups payload) is removed from `<extLst>` — other
 * extensions are preserved verbatim — and the model's `<ext>` is
 * appended. An empty model removes the extension (and an `<extLst>`
 * left empty). A sheet with no `<extLst>` gains one as the last child
 * of `<worksheet>` (its CT_Worksheet position). `undefined` leaves the
 * sheet untouched. Works on a whole worksheet part or on a streaming
 * tail fragment (everything from `</sheetData>` on).
 */
export function spliceSparklineGroups(
  sheetXml: string,
  groups: readonly SparklineGroup[] | undefined,
): string {
  if (groups === undefined) return sheetXml;
  let xml = sheetXml;
  const newExt = sparklineExtXml(groups);
  const extLst = findBlock(xml, 'extLst');
  if (extLst) {
    const kept: string[] = [];
    for (const ext of findBlocks(extLst.inner, 'ext')) {
      const isSparkline =
        ext.attrs.uri === SPARKLINE_GROUPS_EXT_URI || /<(?:x14:)?sparklineGroups\b/.test(ext.inner);
      if (!isSparkline) kept.push(ext.whole);
    }
    if (newExt !== '') kept.push(newExt);
    const replacement = kept.length === 0 ? '' : `<extLst>${kept.join('')}</extLst>`;
    xml = xml.slice(0, extLst.start) + replacement + xml.slice(extLst.end);
  } else if (newExt !== '') {
    const extLstXml = `<extLst>${newExt}</extLst>`;
    const close = xml.indexOf('</worksheet>');
    xml = close >= 0 ? xml.slice(0, close) + extLstXml + xml.slice(close) : xml + extLstXml;
  }
  return groups.length > 0 ? ensureSparklineRootDecls(xml) : xml;
}
