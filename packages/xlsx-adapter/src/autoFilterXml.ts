/**
 * Native AutoFilter + sort-state round-trip (ISO/IEC 29500 §18.3.1.2
 * `<autoFilter>`, §18.3.1.92 `<sortState>`; audit §14.4).
 *
 * Model (on SheetData): `autoFilter` carries the filter ref and every
 * `<filterColumn>` child family — `<filters>` (value list + date groups
 * + blank flag), `<customFilters>` (operator/value pairs), `<top10>`,
 * `<dynamicFilter>`, `<colorFilter>`, `<iconFilter>` — and `sortState`
 * is its own field (a sibling element in the worksheet, not a child of
 * autoFilter). Attribute values are carried verbatim (strings/numbers/
 * booleans as parsed); unknown filterColumn children are preserved as
 * raw XML in `extraXml` so a future Excel extension survives the
 * round-trip instead of being silently dropped.
 */
import {
  boolAttrValue,
  elementBody,
  escapeXmlAttr,
  findBlock,
  normalizeRef,
  numAttrValue,
  splitTopElements,
} from './nativeXmlUtil.js';

export interface NativeDateGroupItem {
  year?: number;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
  second?: number;
  /** ST_DateTimeGrouping: year|month|day|hour|minute|second. */
  dateTimeGrouping: string;
}

export interface NativeFilters {
  /** Match blank cells (`<filters blank="1">`). */
  blank?: boolean;
  /** ST_CalendarType, e.g. 'gregorian'. */
  calendarType?: string;
  /** `<filter val="…"/>` entries, verbatim. */
  values: string[];
  dateGroups: NativeDateGroupItem[];
}

export interface NativeCustomFilter {
  /** ST_FilterOperator: equal|lessThan|lessThanOrEqual|notEqual|greaterThanOrEqual|greaterThan. */
  operator: string;
  val: string;
}

export interface NativeCustomFilters {
  /** True = AND (default), false = OR (`and="0"`). */
  and: boolean;
  filters: NativeCustomFilter[];
}

export interface NativeTop10 {
  top?: boolean;
  percent?: boolean;
  val: number;
  filterVal?: number;
}

export interface NativeDynamicFilter {
  /** ST_DynamicFilterType: today|tomorrow|…|aboveAverage|belowAverage|null. */
  type: string;
  val?: number;
  maxVal?: number;
}

export interface NativeColorFilter {
  dxfId?: number;
  /** True = filter by cell color, false = font color. */
  cellColor?: boolean;
}

export interface NativeIconFilter {
  iconSet: string;
  iconId?: number;
}

export interface NativeFilterColumn {
  colId: number;
  hiddenButton?: boolean;
  showButton?: boolean;
  filters?: NativeFilters;
  customFilters?: NativeCustomFilters;
  top10?: NativeTop10;
  dynamicFilter?: NativeDynamicFilter;
  colorFilter?: NativeColorFilter;
  iconFilter?: NativeIconFilter;
  /** Unrecognized children, preserved verbatim for the write-back. */
  extraXml?: string[];
}

export interface NativeAutoFilter {
  /** The filtered range (canonical A1, e.g. 'A1:D20'). */
  ref: string;
  filterColumns: NativeFilterColumn[];
}

export interface NativeSortCondition {
  ref: string;
  descending?: boolean;
  /** ST_SortBy: value|cellColor|fontColor|icon. */
  sortBy?: string;
  dxfId?: number;
  iconSet?: string;
  iconId?: number;
  customList?: string;
}

export interface NativeSortState {
  ref: string;
  caseSensitive?: boolean;
  columnSort?: boolean;
  /** ST_SortMethod: none|stroke|pinYin. */
  sortMethod?: string;
  conditions: NativeSortCondition[];
}

/* ------------------------------------------------------------------ */
/* Parse                                                               */
/* ------------------------------------------------------------------ */

function parseDateGroupItem(el: string): NativeDateGroupItem {
  const a = (name: string): number | undefined => {
    const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(el);
    return m ? numAttrValue(m[1]) : undefined;
  };
  const g = /\bdateTimeGrouping\s*=\s*"([^"]*)"/.exec(el);
  const out: NativeDateGroupItem = { dateTimeGrouping: g?.[1] ?? 'day' };
  const y = a('year'); if (y !== undefined) out.year = y;
  const mo = a('month'); if (mo !== undefined) out.month = mo;
  const d = a('day'); if (d !== undefined) out.day = d;
  const h = a('hour'); if (h !== undefined) out.hour = h;
  const mi = a('minute'); if (mi !== undefined) out.minute = mi;
  const s = a('second'); if (s !== undefined) out.second = s;
  return out;
}

function parseFilterColumn(el: string): NativeFilterColumn | null {
  const open = /^<filterColumn\b([^>]*)>/.exec(el)?.[1] ?? '';
  const colIdM = /\bcolId\s*=\s*"([^"]*)"/.exec(open);
  if (!colIdM) return null;
  const col: NativeFilterColumn = { colId: Number(colIdM[1]) };
  const hb = /\bhiddenButton\s*=\s*"([^"]*)"/.exec(open);
  if (hb) col.hiddenButton = boolAttrValue(hb[1], false);
  const sb = /\bshowButton\s*=\s*"([^"]*)"/.exec(open);
  if (sb) col.showButton = boolAttrValue(sb[1], true);
  const inner = el.slice(el.indexOf('>') + 1, el.endsWith('</filterColumn>') ? -'</filterColumn>'.length : undefined);
  const known = ['filters', 'customFilters', 'top10', 'dynamicFilter', 'colorFilter', 'iconFilter'];
  for (const childTag of known) {
    for (const child of splitTopElements(inner, childTag)) {
      if (childTag === 'filters') {
        const attrs = /^<filters\b([^>]*)>/.exec(child)?.[1] ?? (child.endsWith('/>') ? child.slice('<filters'.length, -2) : '');
        const f: NativeFilters = { values: [], dateGroups: [] };
        const blank = /\bblank\s*=\s*"([^"]*)"/.exec(attrs);
        if (blank) f.blank = boolAttrValue(blank[1], false);
        const cal = /\bcalendarType\s*=\s*"([^"]*)"/.exec(attrs);
        if (cal) f.calendarType = cal[1];
        for (const fv of splitTopElements(child, 'filter')) {
          const v = /\bval\s*=\s*"([^"]*)"/.exec(fv);
          if (v) f.values.push(elementBody(`<x>${v[1]}</x>`));
        }
        for (const dg of splitTopElements(child, 'dateGroupItem')) f.dateGroups.push(parseDateGroupItem(dg));
        col.filters = f;
      } else if (childTag === 'customFilters') {
        const cf: NativeCustomFilters = { and: true, filters: [] };
        const andM = /\band\s*=\s*"([^"]*)"/.exec(child);
        if (andM) cf.and = boolAttrValue(andM[1], true);
        for (const f of splitTopElements(child, 'customFilter')) {
          const op = /\boperator\s*=\s*"([^"]*)"/.exec(f);
          const val = /\bval\s*=\s*"([^"]*)"/.exec(f);
          cf.filters.push({ operator: op?.[1] ?? 'equal', val: val ? elementBody(`<x>${val[1]}</x>`) : '' });
        }
        col.customFilters = cf;
      } else if (childTag === 'top10') {
        const val = numAttrValue(/\bval\s*=\s*"([^"]*)"/.exec(child)?.[1]);
        if (val === undefined) continue;
        const t: NativeTop10 = { val };
        const top = /\btop\s*=\s*"([^"]*)"/.exec(child);
        if (top) t.top = boolAttrValue(top[1], true);
        const pct = /\bpercent\s*=\s*"([^"]*)"/.exec(child);
        if (pct) t.percent = boolAttrValue(pct[1], false);
        const fv = numAttrValue(/\bfilterVal\s*=\s*"([^"]*)"/.exec(child)?.[1]);
        if (fv !== undefined) t.filterVal = fv;
        col.top10 = t;
      } else if (childTag === 'dynamicFilter') {
        const type = /\btype\s*=\s*"([^"]*)"/.exec(child)?.[1];
        if (!type) continue;
        const d: NativeDynamicFilter = { type };
        const v = numAttrValue(/\bval\s*=\s*"([^"]*)"/.exec(child)?.[1]);
        if (v !== undefined) d.val = v;
        const mv = numAttrValue(/\bmaxVal\s*=\s*"([^"]*)"/.exec(child)?.[1]);
        if (mv !== undefined) d.maxVal = mv;
        col.dynamicFilter = d;
      } else if (childTag === 'colorFilter') {
        const c: NativeColorFilter = {};
        const dxf = numAttrValue(/\bdxfId\s*=\s*"([^"]*)"/.exec(child)?.[1]);
        if (dxf !== undefined) c.dxfId = dxf;
        const cc = /\bcellColor\s*=\s*"([^"]*)"/.exec(child);
        if (cc) c.cellColor = boolAttrValue(cc[1], true);
        col.colorFilter = c;
      } else if (childTag === 'iconFilter') {
        const set = /\biconSet\s*=\s*"([^"]*)"/.exec(child)?.[1];
        if (!set) continue;
        const ic: NativeIconFilter = { iconSet: set };
        const id = numAttrValue(/\biconId\s*=\s*"([^"]*)"/.exec(child)?.[1]);
        if (id !== undefined) ic.iconId = id;
        col.iconFilter = ic;
      }
    }
  }
  // Anything else inside the filterColumn is preserved verbatim.
  const extras: string[] = [];
  for (const tag of ['extLst']) {
    for (const child of splitTopElements(inner, tag)) extras.push(child);
  }
  if (extras.length > 0) col.extraXml = extras;
  return col;
}

export function parseAutoFilter(sheetXml: string): NativeAutoFilter | null {
  const block = findBlock(sheetXml, 'autoFilter');
  if (!block || !block.attrs.ref) return null;
  const out: NativeAutoFilter = { ref: normalizeRef(block.attrs.ref), filterColumns: [] };
  for (const el of splitTopElements(block.inner, 'filterColumn')) {
    const col = parseFilterColumn(el);
    if (col) out.filterColumns.push(col);
  }
  return out;
}

export function parseSortState(sheetXml: string): NativeSortState | null {
  const block = findBlock(sheetXml, 'sortState');
  if (!block || !block.attrs.ref) return null;
  const out: NativeSortState = { ref: normalizeRef(block.attrs.ref), conditions: [] };
  if (block.attrs.caseSensitive !== undefined) out.caseSensitive = boolAttrValue(block.attrs.caseSensitive, false);
  if (block.attrs.columnSort !== undefined) out.columnSort = boolAttrValue(block.attrs.columnSort, false);
  if (block.attrs.sortMethod !== undefined) out.sortMethod = block.attrs.sortMethod;
  for (const el of splitTopElements(block.inner, 'sortCondition')) {
    const a = (name: string): string | undefined => {
      const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(el);
      return m?.[1];
    };
    const ref = a('ref');
    if (!ref) continue;
    const cond: NativeSortCondition = { ref: normalizeRef(ref) };
    const desc = a('descending');
    if (desc !== undefined) cond.descending = boolAttrValue(desc, false);
    const by = a('sortBy');
    if (by !== undefined) cond.sortBy = by;
    const dxf = numAttrValue(a('dxfId'));
    if (dxf !== undefined) cond.dxfId = dxf;
    const set = a('iconSet');
    if (set !== undefined) cond.iconSet = set;
    const iid = numAttrValue(a('iconId'));
    if (iid !== undefined) cond.iconId = iid;
    const cl = a('customList');
    if (cl !== undefined) cond.customList = cl;
    out.conditions.push(cond);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Serialize                                                           */
/* ------------------------------------------------------------------ */

function boolStr(b: boolean): string {
  return b ? '1' : '0';
}

function filterColumnToXml(col: NativeFilterColumn): string {
  const attrs = [`colId="${col.colId}"`];
  if (col.hiddenButton !== undefined) attrs.push(`hiddenButton="${boolStr(col.hiddenButton)}"`);
  if (col.showButton !== undefined) attrs.push(`showButton="${boolStr(col.showButton)}"`);
  const kids: string[] = [];
  if (col.filters) {
    const fa: string[] = [];
    if (col.filters.blank !== undefined) fa.push(`blank="${boolStr(col.filters.blank)}"`);
    if (col.filters.calendarType) fa.push(`calendarType="${escapeXmlAttr(col.filters.calendarType)}"`);
    const inner =
      col.filters.values.map((v) => `<filter val="${escapeXmlAttr(v)}"/>`).join('') +
      col.filters.dateGroups.map((g) => {
        const ga = [`dateTimeGrouping="${escapeXmlAttr(g.dateTimeGrouping)}"`];
        if (g.year !== undefined) ga.push(`year="${g.year}"`);
        if (g.month !== undefined) ga.push(`month="${g.month}"`);
        if (g.day !== undefined) ga.push(`day="${g.day}"`);
        if (g.hour !== undefined) ga.push(`hour="${g.hour}"`);
        if (g.minute !== undefined) ga.push(`minute="${g.minute}"`);
        if (g.second !== undefined) ga.push(`second="${g.second}"`);
        return `<dateGroupItem ${ga.join(' ')}/>`;
      }).join('');
    kids.push(inner === '' && fa.length === 0 ? '<filters/>' : `<filters${fa.length ? ' ' + fa.join(' ') : ''}>${inner}</filters>`);
  }
  if (col.customFilters) {
    const and = col.customFilters.and ? '' : ' and="0"';
    const inner = col.customFilters.filters
      .map((f) => `<customFilter operator="${escapeXmlAttr(f.operator)}" val="${escapeXmlAttr(f.val)}"/>`)
      .join('');
    kids.push(`<customFilters${and}>${inner}</customFilters>`);
  }
  if (col.top10) {
    const ta = [`val="${col.top10.val}"`];
    if (col.top10.top !== undefined) ta.push(`top="${boolStr(col.top10.top)}"`);
    if (col.top10.percent !== undefined) ta.push(`percent="${boolStr(col.top10.percent)}"`);
    if (col.top10.filterVal !== undefined) ta.push(`filterVal="${col.top10.filterVal}"`);
    kids.push(`<top10 ${ta.join(' ')}/>`);
  }
  if (col.dynamicFilter) {
    const da = [`type="${escapeXmlAttr(col.dynamicFilter.type)}"`];
    if (col.dynamicFilter.val !== undefined) da.push(`val="${col.dynamicFilter.val}"`);
    if (col.dynamicFilter.maxVal !== undefined) da.push(`maxVal="${col.dynamicFilter.maxVal}"`);
    kids.push(`<dynamicFilter ${da.join(' ')}/>`);
  }
  if (col.colorFilter) {
    const ca: string[] = [];
    if (col.colorFilter.dxfId !== undefined) ca.push(`dxfId="${col.colorFilter.dxfId}"`);
    if (col.colorFilter.cellColor !== undefined) ca.push(`cellColor="${boolStr(col.colorFilter.cellColor)}"`);
    kids.push(`<colorFilter${ca.length ? ' ' + ca.join(' ') : ''}/>`);
  }
  if (col.iconFilter) {
    const ia = [`iconSet="${escapeXmlAttr(col.iconFilter.iconSet)}"`];
    if (col.iconFilter.iconId !== undefined) ia.push(`iconId="${col.iconFilter.iconId}"`);
    kids.push(`<iconFilter ${ia.join(' ')}/>`);
  }
  if (col.extraXml) kids.push(...col.extraXml);
  if (kids.length === 0) return `<filterColumn ${attrs.join(' ')}/>`;
  return `<filterColumn ${attrs.join(' ')}>${kids.join('')}</filterColumn>`;
}

export function autoFilterToXml(af: NativeAutoFilter): string {
  const cols = af.filterColumns.map(filterColumnToXml).join('');
  const ref = escapeXmlAttr(normalizeRef(af.ref));
  return cols === '' ? `<autoFilter ref="${ref}"/>` : `<autoFilter ref="${ref}">${cols}</autoFilter>`;
}

export function sortStateToXml(ss: NativeSortState): string {
  const attrs = [`ref="${escapeXmlAttr(normalizeRef(ss.ref))}"`];
  if (ss.caseSensitive !== undefined) attrs.push(`caseSensitive="${boolStr(ss.caseSensitive)}"`);
  if (ss.columnSort !== undefined) attrs.push(`columnSort="${boolStr(ss.columnSort)}"`);
  if (ss.sortMethod) attrs.push(`sortMethod="${escapeXmlAttr(ss.sortMethod)}"`);
  const inner = ss.conditions.map((c) => {
    const ca = [`ref="${escapeXmlAttr(normalizeRef(c.ref))}"`];
    if (c.descending !== undefined) ca.push(`descending="${boolStr(c.descending)}"`);
    if (c.sortBy) ca.push(`sortBy="${escapeXmlAttr(c.sortBy)}"`);
    if (c.dxfId !== undefined) ca.push(`dxfId="${c.dxfId}"`);
    if (c.iconSet) ca.push(`iconSet="${escapeXmlAttr(c.iconSet)}"`);
    if (c.iconId !== undefined) ca.push(`iconId="${c.iconId}"`);
    if (c.customList !== undefined) ca.push(`customList="${escapeXmlAttr(c.customList)}"`);
    return `<sortCondition ${ca.join(' ')}/>`;
  }).join('');
  return inner === '' ? `<sortState ${attrs.join(' ')}/>` : `<sortState ${attrs.join(' ')}>${inner}</sortState>`;
}
