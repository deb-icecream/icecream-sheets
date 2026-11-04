/**
 * Native XLSX protection round-trip (`<sheetProtection>`,
 * `<workbookProtection>`, cell-xf locked/hidden flags).
 *
 * SheetJS community edition neither parses nor writes worksheet/workbook
 * protection or xf-level protection flags, so this module does it directly
 * on the OOXML package with fflate (the same unzip/modify/re-zip pattern
 * as pageBreaksXml.ts and macroProject.ts):
 *
 * - read (`applyNativeProtection`): for every worksheet part, parse
 *   `<sheetProtection>` into the `icecream.protection.sheet.<name>`
 *   metadata shape the ProtectionManager consumes; parse
 *   `<workbookProtection>` from xl/workbook.xml; parse cellXfs `<xf>`
 *   protection (child `<protection>` element or transitional locked/hidden
 *   attributes) and record non-default per-cell flags as
 *   `icecream.protection.cellflags.<sheet>`. Cells with locked="0" are
 *   folded into the sheet's unlockedRanges when the sheet is protected
 *   (Excel semantics: everything locked except explicit unlocks).
 *   Native XML wins over the custom-property hint when both are present.
 * - write (`injectNativeProtection`): mirror the metadata back into native
 *   XML — `<sheetProtection>` per protected sheet, `<workbookProtection>`
 *   for the workbook, and locked/hidden xf flags in styles.xml with the
 *   `<c>` style indices updated (unlocked ranges are expanded in full and
 *   empty cells materialize as empty styled `<c>` elements — the same thing
 *   Excel does for formatted empty cells — so the flags survive for real
 *   Excel, not just for us).
 *
 * Passwords are NEVER read or written (design §4): only the protection
 * STATE travels. A password verifier found on read becomes
 * `hasPassword: true`; on write no password attribute is ever emitted.
 *
 * Excel xf "hidden" semantics: the cell's FORMULA is hidden on a protected
 * sheet (the value still displays). This is preserved for styles.xml
 * fidelity only — it is NOT the face-e hidden-cell feature (values
 * unreadable to unauthorized principals), which lives in the
 * ProtectionManager's hidden-ranges state and is never derived from xf
 * flags.
 */

import { unzipSync } from 'fflate';
import { zipSyncStable } from './zipStable.js';
import {
  DEFAULT_SHEET_OPTIONS,
  parseA1RangeRef,
  PROTECTION_CELLFLAGS_META_PREFIX,
  PROTECTION_SHEET_META_PREFIX,
  PROTECTION_WORKBOOK_META_KEY,
  type CellProtectionFlags,
  type SheetProtectionOptions,
  type WorkbookData,
} from '@icecream-sheets/engine';
import { decodeRef, sheetPartPaths } from './formulaRecovery.js';

/** Fail-closed caps: pathological ranges never blow up the package. */
const MAX_RANGE_CELLS = 100000;

/** Native sheet protection parsed from a worksheet part. */
export interface NativeSheetProtection {
  /** A password verifier/hash was present (never the password itself). */
  hasPassword: boolean;
  options: SheetProtectionOptions;
}

/** Native workbook protection parsed from xl/workbook.xml. */
export interface NativeWorkbookProtection {
  structure: boolean;
  windows: boolean;
  hasPassword: boolean;
}

/** One cell's wanted xf protection on write. */
export interface CellProtectionTarget {
  /** 0-based row/col. */
  r: number;
  c: number;
  locked: boolean;
  hidden: boolean;
}

/** Minimal XML entity unescape for attribute values. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return m ? unescapeXml(m[1] as string) : null;
}

/** OOXML boolean: "1"/"true" (Excel/LibreOffice spellings), else default. */
function ooxmlBool(value: string | null, dflt: boolean): boolean {
  if (value === null) return dflt;
  const t = value.trim().toLowerCase();
  return t === '1' || t === 'true';
}

/** 0-based (r, c) -> A1, e.g. (1, 1) -> "B2". */
function toA1Cell(r: number, c: number): string {
  let letters = '';
  let cc = c;
  do {
    letters = String.fromCharCode(65 + (cc % 26)) + letters;
    cc = Math.floor(cc / 26) - 1;
  } while (cc >= 0);
  return `${letters}${r + 1}`;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** [option key, Excel default when the attribute is absent]. */
const SHEET_PROTECTION_ATTRS: Array<[keyof SheetProtectionOptions, boolean]> = [
  ['selectLockedCells', true],
  ['selectUnlockedCells', true],
  ['formatCells', false],
  ['formatColumns', false],
  ['formatRows', false],
  ['insertColumns', false],
  ['insertRows', false],
  ['insertHyperlinks', false],
  ['deleteColumns', false],
  ['deleteRows', false],
  ['sort', false],
  ['autoFilter', false],
  ['pivotTables', false],
  ['objects', true],
  ['scenarios', true],
];

function readSheetProtectionElement(xml: string): NativeSheetProtection | null {
  const m = /<sheetProtection\b([^>]*?)\s*\/?>/.exec(xml);
  if (!m) return null;
  const tag = m[1] as string;
  const options = {} as SheetProtectionOptions;
  for (const [key, dflt] of SHEET_PROTECTION_ATTRS) {
    options[key] = ooxmlBool(attr(tag, key), dflt);
  }
  const hasPassword = ['password', 'hashValue', 'saltValue'].some((a) => {
    const v = attr(tag, a);
    return v !== null && v !== '';
  });
  return { hasPassword, options };
}

function readWorkbookProtectionElement(xml: string): NativeWorkbookProtection | null {
  const m = /<workbookProtection\b([^>]*?)\s*\/?>/.exec(xml);
  if (!m) return null;
  const tag = m[1] as string;
  const structure = ooxmlBool(attr(tag, 'lockStructure'), false);
  const windows = ooxmlBool(attr(tag, 'lockWindows'), false);
  if (!structure && !windows) return null;
  const hasPassword = ['workbookPassword', 'workbookPasswordHash', 'workbookSaltValue'].some((a) => {
    const v = attr(tag, a);
    return v !== null && v !== '';
  });
  return { structure, windows, hasPassword };
}

interface XfProtection {
  locked: boolean;
  hidden: boolean;
}

/**
 * Split the inner XML of `<cellXfs>` into its `<xf>` elements. A small
 * scanner (not a single regex) so `<xf>` elements containing child elements
 * with `/>` (e.g. `<alignment/>`) are not truncated early.
 */
function splitXfElements(inner: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (true) {
    let start = inner.indexOf('<xf', i);
    if (start < 0) break;
    // Word boundary: don't match a hypothetical <xformat>.
    const after = inner[start + 3] ?? '';
    if (after !== '' && after !== ' ' && after !== '\t' && after !== '\n' && after !== '\r' && after !== '/' && after !== '>') {
      i = start + 3;
      continue;
    }
    let j = start + 3;
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
      const close = inner.indexOf('</xf>', openEnd + 1);
      if (close < 0) break;
      out.push(inner.slice(start, close + 5));
      i = close + 5;
    }
  }
  return out;
}

/** Effective protection of one `<xf>` element (Excel defaults applied). */
function xfProtection(xf: string): XfProtection {
  // The strict child <protection> element wins over transitional attributes.
  const child = /<protection\b([^>]*?)\s*\/?>/.exec(xf);
  if (child) {
    return {
      locked: ooxmlBool(attr(child[1] as string, 'locked'), true),
      hidden: ooxmlBool(attr(child[1] as string, 'hidden'), false),
    };
  }
  const openTag = xf.slice(0, xf.indexOf('>') + 1);
  if (!ooxmlBool(attr(openTag, 'applyProtection'), true)) {
    return { locked: true, hidden: false };
  }
  return {
    locked: ooxmlBool(attr(openTag, 'locked'), true),
    hidden: ooxmlBool(attr(openTag, 'hidden'), false),
  };
}

function parseCellXfs(stylesXml: string): XfProtection[] {
  const m = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
  if (!m) return [];
  return splitXfElements(m[1] as string).map(xfProtection);
}

/**
 * Non-default per-cell xf flags for one worksheet, keyed "r:c" (0-based).
 * Resolves each `<c>`'s style index, falling back to row then column styles.
 */
function readWorksheetCellFlags(xml: string, xfs: XfProtection[]): Record<string, CellProtectionFlags> {
  const out: Record<string, CellProtectionFlags> = {};
  if (xfs.length === 0) return out;
  const colStyles: Array<{ min: number; max: number; s: number }> = [];
  for (const tag of xml.match(/<col\b[^>]*>/g) ?? []) {
    const s = attr(tag, 's');
    if (s === null || !/^\d+$/.test(s)) continue;
    const min = parseInt(attr(tag, 'min') ?? '', 10);
    const max = parseInt(attr(tag, 'max') ?? '', 10);
    if (Number.isInteger(min) && Number.isInteger(max)) {
      colStyles.push({ min, max, s: parseInt(s, 10) });
    }
  }
  const rowStyles = new Map<number, number>();
  for (const tag of xml.match(/<row\b[^>]*>/g) ?? []) {
    const s = attr(tag, 's');
    const r = attr(tag, 'r');
    if (s === null || r === null || !/^\d+$/.test(s) || !/^\d+$/.test(r)) continue;
    rowStyles.set(parseInt(r, 10), parseInt(s, 10));
  }
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
      if (rs !== undefined) {
        sIdx = rs;
      } else {
        const col = colStyles.find((cs) => rc.c + 1 >= cs.min && rc.c + 1 <= cs.max);
        if (col) sIdx = col.s;
      }
    }
    const xf = xfs[sIdx];
    if (!xf) continue;
    const entry: CellProtectionFlags = {};
    if (!xf.locked) entry.locked = false;
    if (xf.hidden) entry.hidden = true;
    if (entry.locked !== undefined || entry.hidden !== undefined) {
      out[`${rc.r}:${rc.c}`] = entry;
    }
  }
  return out;
}

/**
 * Merge unlocked cells into maximal rectangles ("B2", "C5:E5") via greedy
 * row-major expansion, so a rectangular unlocked range round-trips back to
 * its original A1 form. Fail-closed: past the cap the ranges are dropped
 * (the sheet stays fully locked) rather than emitting a partial list.
 */
function unlockedCellsToRanges(flags: Record<string, CellProtectionFlags>): string[] {
  const cells = new Set<string>();
  for (const [key, f] of Object.entries(flags)) {
    if (f.locked !== false) continue;
    const parts = key.split(':');
    const r = Number(parts[0]);
    const c = Number(parts[1]);
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0) continue;
    cells.add(`${r}:${c}`);
  }
  if (cells.size > MAX_RANGE_CELLS) return [];
  const sorted = [...cells]
    .map((k) => {
      const [r, c] = k.split(':').map(Number) as [number, number];
      return { r, c };
    })
    .sort((a, b) => a.r - b.r || a.c - b.c);
  const remaining = new Set(sorted.map((p) => `${p.r}:${p.c}`));
  const ranges: string[] = [];
  for (const { r, c } of sorted) {
    const key = `${r}:${c}`;
    if (!remaining.has(key)) continue;
    let c2 = c;
    while (remaining.has(`${r}:${c2 + 1}`)) c2++;
    let r2 = r;
    expand: while (true) {
      for (let cc = c; cc <= c2; cc++) {
        if (!remaining.has(`${r2 + 1}:${cc}`)) break expand;
      }
      r2++;
    }
    for (let rr = r; rr <= r2; rr++) {
      for (let cc = c; cc <= c2; cc++) remaining.delete(`${rr}:${cc}`);
    }
    ranges.push(r === r2 && c === c2 ? toA1Cell(r, c) : `${toA1Cell(r, c)}:${toA1Cell(r2, c2)}`);
  }
  return ranges;
}

/**
 * Parse native protection from the package into workbook metadata. Native
 * XML wins over the custom-property hint when both are present. Never
 * throws: protection hints must never break the open.
 */
export function applyNativeProtection(
  packageBytes: Uint8Array,
  metadata: Record<string, unknown>,
  preunzipped?: Record<string, Uint8Array>,
): void {
  try {
    const files = preunzipped ?? unzipSync(packageBytes.slice());
    const parts = sheetPartPaths(files as unknown as Record<string, Uint8Array>);
    if (parts.size === 0) return;
    const decoder = new TextDecoder();
    const stylesRaw = files['xl/styles.xml'];
    const xfs = stylesRaw ? parseCellXfs(decoder.decode(stylesRaw)) : [];
    const wbRaw = files['xl/workbook.xml'];
    if (wbRaw) {
      const wbp = readWorkbookProtectionElement(decoder.decode(wbRaw));
      if (wbp) {
        metadata[PROTECTION_WORKBOOK_META_KEY] = {
          structure: wbp.structure,
          windows: wbp.windows,
          hasPassword: wbp.hasPassword,
        };
      }
    }
    for (const [name, path] of parts) {
      const raw = files[path];
      if (!raw) continue;
      const xml = decoder.decode(raw);
      const flags = readWorksheetCellFlags(xml, xfs);
      if (Object.keys(flags).length > 0) {
        metadata[`${PROTECTION_CELLFLAGS_META_PREFIX}${name}`] = flags;
      }
      const sp = readSheetProtectionElement(xml);
      if (sp) {
        metadata[`${PROTECTION_SHEET_META_PREFIX}${name}`] = {
          options: sp.options,
          lockedRanges: [],
          unlockedRanges: unlockedCellsToRanges(flags),
          hasPassword: sp.hasPassword,
        };
      }
    }
  } catch {
    // Best-effort: protection hints must never break the open.
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Build the `<sheetProtection>` element from options. Emits only
 * non-default attributes (absent = Excel default). NEVER emits a password
 * attribute — passwords are never stored (design §4).
 */
export function sheetProtectionElement(options: SheetProtectionOptions): string {
  const attrs = ['sheet="1"'];
  if (!options.selectLockedCells) attrs.push('selectLockedCells="0"');
  if (!options.selectUnlockedCells) attrs.push('selectUnlockedCells="0"');
  if (options.formatCells) attrs.push('formatCells="1"');
  if (options.formatColumns) attrs.push('formatColumns="1"');
  if (options.formatRows) attrs.push('formatRows="1"');
  if (options.insertColumns) attrs.push('insertColumns="1"');
  if (options.insertRows) attrs.push('insertRows="1"');
  if (options.insertHyperlinks) attrs.push('insertHyperlinks="1"');
  if (options.deleteColumns) attrs.push('deleteColumns="1"');
  if (options.deleteRows) attrs.push('deleteRows="1"');
  if (options.sort) attrs.push('sort="1"');
  if (options.autoFilter) attrs.push('autoFilter="1"');
  if (options.pivotTables) attrs.push('pivotTables="1"');
  if (!options.objects) attrs.push('objects="0"');
  if (!options.scenarios) attrs.push('scenarios="0"');
  return `<sheetProtection ${attrs.join(' ')}/>`;
}

/**
 * Inject `<sheetProtection>` into each named worksheet (after `</sheetData>`
 * per the CT_Worksheet sequence; before `</worksheet>` as fallback).
 * Previous elements are stripped so repeated saves stay idempotent.
 */
export function injectSheetProtection(
  packageBytes: Uint8Array,
  specs: Map<string, SheetProtectionOptions>,
): Uint8Array {
  if (specs.size === 0) return packageBytes;
  try {
    const files = unzipSync(packageBytes.slice());
    const parts = sheetPartPaths(files as unknown as Record<string, Uint8Array>);
    if (parts.size === 0) return packageBytes;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let touched = false;
    for (const [name, options] of specs) {
      const path = parts.get(name);
      const raw = path ? files[path] : undefined;
      if (!path || !raw) continue;
      let xml = decoder.decode(raw);
      xml = xml
        .replace(/<sheetProtection\b[^>]*\/>/g, '')
        .replace(/<sheetProtection\b[^>]*>[\s\S]*?<\/sheetProtection>/g, '');
      const el = sheetProtectionElement(options);
      if (xml.includes('</sheetData>')) {
        xml = xml.replace('</sheetData>', `</sheetData>${el}`);
      } else if (xml.includes('</worksheet>')) {
        xml = xml.replace('</worksheet>', `${el}</worksheet>`);
      } else {
        continue;
      }
      files[path] = encoder.encode(xml);
      touched = true;
    }
    return touched ? zipSyncStable(files) : packageBytes;
  } catch {
    return packageBytes;
  }
}

/**
 * Inject `<workbookProtection>` into xl/workbook.xml. Previous elements are
 * stripped so repeated saves stay idempotent. No password attributes —
 * passwords are never stored (design §4).
 */
export function injectWorkbookProtection(
  packageBytes: Uint8Array,
  wb: { structure: boolean; windows: boolean } | null,
): Uint8Array {
  if (!wb || (!wb.structure && !wb.windows)) return packageBytes;
  try {
    const files = unzipSync(packageBytes.slice());
    const raw = files['xl/workbook.xml'];
    if (!raw) return packageBytes;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let xml = decoder.decode(raw);
    xml = xml
      .replace(/<workbookProtection\b[^>]*\/>/g, '')
      .replace(/<workbookProtection\b[^>]*>[\s\S]*?<\/workbookProtection>/g, '');
    const attrs: string[] = [];
    if (wb.structure) attrs.push('lockStructure="1"');
    if (wb.windows) attrs.push('lockWindows="1"');
    const el = `<workbookProtection ${attrs.join(' ')}/>`;
    // CT_Workbook order: workbookPr, workbookProtection, bookViews, sheets.
    const pr = /<workbookPr\b[^>]*\/>/.exec(xml) ?? /<workbookPr\b[^>]*>[\s\S]*?<\/workbookPr>/.exec(xml);
    if (pr && pr.index !== undefined) {
      const at = pr.index + pr[0].length;
      xml = xml.slice(0, at) + el + xml.slice(at);
    } else if (xml.includes('<bookViews')) {
      xml = xml.replace('<bookViews', `${el}<bookViews`);
    } else if (xml.includes('<sheets')) {
      xml = xml.replace('<sheets', `${el}<sheets`);
    } else {
      return packageBytes;
    }
    files['xl/workbook.xml'] = encoder.encode(xml);
    return zipSyncStable(files);
  } catch {
    return packageBytes;
  }
}

/** Strip protection from an `<xf>` element (child + transitional attrs). */
function stripXfProtection(xf: string): string {
  let out = xf
    .replace(/<protection\b[^>]*\/>/g, '')
    .replace(/<protection\b[^>]*>[\s\S]*?<\/protection>/g, '');
  const gt = out.indexOf('>');
  if (gt > 0) {
    const open = out
      .slice(0, gt + 1)
      .replace(/\s+locked\s*=\s*"[^"]*"/g, '')
      .replace(/\s+hidden\s*=\s*"[^"]*"/g, '')
      .replace(/\s+applyProtection\s*=\s*"[^"]*"/g, '');
    out = open + out.slice(gt + 1);
  }
  return out;
}

/** Add a `<protection>` child (strict form) to a protection-free `<xf>`. */
function withXfProtection(cleanXf: string, locked: boolean, hidden: boolean): string {
  const gt = cleanXf.indexOf('>');
  let open = cleanXf.slice(0, gt + 1);
  const rest = cleanXf.slice(gt + 1);
  if (/\sapplyProtection\s*=/.test(open)) {
    open = open.replace(/\sapplyProtection\s*=\s*"[^"]*"/, ' applyProtection="1"');
  } else if (open.endsWith('/>')) {
    open = `${open.slice(0, -2)} applyProtection="1"/>`;
  } else {
    open = `${open.slice(0, -1)} applyProtection="1">`;
  }
  const parts: string[] = [];
  if (!locked) parts.push('locked="0"');
  if (hidden) parts.push('hidden="1"');
  const child = `<protection ${parts.join(' ')}/>`;
  if (open.endsWith('/>')) {
    return `${open.slice(0, -2)}>${child}</xf>`;
  }
  return `${open}${child}${rest}`;
}

interface CTagInfo {
  start: number;
  end: number;
  r: number;
  c: number;
  s: number | null;
}

/**
 * Inject per-cell locked/hidden xf flags: append new `<xf>` entries to
 * cellXfs as needed and point each target `<c>` at its xf via the `s`
 * attribute. Cells without a `<c>` element get an empty styled `<c/>`
 * (materialized for the full unlocked range, as Excel does for formatted
 * empty cells); missing rows are created in sorted position. Never throws.
 */
export function injectCellProtection(
  packageBytes: Uint8Array,
  targets: Map<string, CellProtectionTarget[]>,
): Uint8Array {
  if (targets.size === 0) return packageBytes;
  try {
    const files = unzipSync(packageBytes.slice());
    const parts = sheetPartPaths(files as unknown as Record<string, Uint8Array>);
    const stylesRaw = files['xl/styles.xml'];
    if (!stylesRaw) return packageBytes;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const stylesXml = decoder.decode(stylesRaw);
    const xfsMatch = /<cellXfs\b([^>]*)>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
    if (!xfsMatch) return packageBytes;
    const xfEls = splitXfElements(xfsMatch[2] as string);
    if (xfEls.length === 0) return packageBytes;
    const baseKeys = xfEls.map(stripXfProtection);
    const xfIndexByKey = new Map<string, number>();
    baseKeys.forEach((k, i) => {
      if (!xfIndexByKey.has(k)) xfIndexByKey.set(k, i);
    });
    const initialCount = xfEls.length;
    /** Resolve (or create) the xf index for wanted flags. */
    const ensureXf = (baseIdx: number, locked: boolean, hidden: boolean): number => {
      if (locked && !hidden) return baseIdx; // Excel default: reuse the base xf
      const base = baseIdx >= 0 && baseIdx < baseKeys.length ? (baseKeys[baseIdx] as string) : (baseKeys[0] as string);
      const key = `${base}|L${locked ? 1 : 0}H${hidden ? 1 : 0}`;
      let idx = xfIndexByKey.get(key);
      if (idx === undefined) {
        idx = xfEls.length;
        xfEls.push(withXfProtection(base, locked, hidden));
        xfIndexByKey.set(key, idx);
      }
      return idx;
    };

    let touchedAnySheet = false;
    for (const [name, list] of targets) {
      if (list.length === 0) continue;
      const path = parts.get(name);
      const raw = path ? files[path] : undefined;
      if (!path || !raw) continue;
      let xml = decoder.decode(raw);

      // Index existing <c> tags, row styles, and column styles.
      const ctags: CTagInfo[] = [];
      const cRe = /<c\b[^>]*>/g;
      let cm: RegExpExecArray | null;
      while ((cm = cRe.exec(xml)) !== null) {
        const tag = cm[0];
        const ref = attr(tag, 'r');
        if (!ref) continue;
        const rc = decodeRef(ref);
        if (!rc) continue;
        const sAttr = attr(tag, 's');
        ctags.push({
          start: cm.index,
          end: cm.index + tag.length,
          r: rc.r,
          c: rc.c,
          s: sAttr !== null && /^\d+$/.test(sAttr) ? parseInt(sAttr, 10) : null,
        });
      }
      const ctagByCell = new Map<string, CTagInfo>();
      for (const t of ctags) ctagByCell.set(`${t.r}:${t.c}`, t);
      const rowStyles = new Map<number, number>();
      for (const tag of xml.match(/<row\b[^>]*>/g) ?? []) {
        const s = attr(tag, 's');
        const r = attr(tag, 'r');
        if (s !== null && r !== null && /^\d+$/.test(s) && /^\d+$/.test(r)) {
          rowStyles.set(parseInt(r, 10), parseInt(s, 10));
        }
      }
      const colStyles: Array<{ min: number; max: number; s: number }> = [];
      for (const tag of xml.match(/<col\b[^>]*>/g) ?? []) {
        const s = attr(tag, 's');
        if (s === null || !/^\d+$/.test(s)) continue;
        const min = parseInt(attr(tag, 'min') ?? '', 10);
        const max = parseInt(attr(tag, 'max') ?? '', 10);
        if (Number.isInteger(min) && Number.isInteger(max)) {
          colStyles.push({ min, max, s: parseInt(s, 10) });
        }
      }
      const baseStyleFor = (r: number, c: number, ownS: number | null): number => {
        if (ownS !== null && ownS >= 0 && ownS < xfEls.length) return ownS;
        const rs = rowStyles.get(r + 1);
        if (rs !== undefined && rs >= 0 && rs < xfEls.length) return rs;
        const col = colStyles.find((cs) => c + 1 >= cs.min && c + 1 <= cs.max);
        if (col && col.s >= 0 && col.s < xfEls.length) return col.s;
        return 0;
      };

      // Edits as (index, deleteLength, insertText), applied descending.
      const edits: Array<{ index: number; del: number; ins: string }> = [];
      // New cells grouped by row for cells with no <c> element yet, with
      // their resolved xf index carried alongside.
      const newCellsByRow = new Map<number, Array<CellProtectionTarget & { xfIdx: number }>>();

      for (const t of list) {
        const existing = ctagByCell.get(`${t.r}:${t.c}`);
        const baseIdx = baseStyleFor(t.r, t.c, existing?.s ?? null);
        const xfIdx = ensureXf(baseIdx, t.locked, t.hidden);
        if (existing) {
          if (existing.s === xfIdx) continue;
          const tag = xml.slice(existing.start, existing.end);
          const sRe = /\ss="\d+"/;
          if (sRe.test(tag)) {
            const sm = sRe.exec(tag) as RegExpExecArray;
            edits.push({
              index: existing.start + sm.index,
              del: sm[0].length,
              ins: ` s="${xfIdx}"`,
            });
          } else {
            // Insert before the closing ">" (or "/>").
            const closeAt = tag.endsWith('/>') ? existing.end - 2 : existing.end - 1;
            edits.push({ index: closeAt, del: 0, ins: ` s="${xfIdx}"` });
          }
          touchedAnySheet = true;
        } else {
          let arr = newCellsByRow.get(t.r);
          if (!arr) {
            arr = [];
            newCellsByRow.set(t.r, arr);
          }
          arr.push({ ...t, xfIdx });
          touchedAnySheet = true;
        }
      }

      // Materialize new <c> elements (empty styled cells), grouped by row.
      for (const [r, cells] of [...newCellsByRow.entries()].sort((a, b) => a[0] - b[0])) {
        const row1 = r + 1;
        const sorted = [...cells].sort((a, b) => a.c - b.c);
        const cXml = sorted.map((t) => `<c r="${toA1Cell(t.r, t.c)}" s="${t.xfIdx}"/>`).join('');
        const rowRe = new RegExp(`<row\\b[^>]*\\br\\s*=\\s*"${row1}"[^>]*>`, 'g');
        const rowMatch = rowRe.exec(xml);
        if (rowMatch) {
          const rowTag = rowMatch[0];
          const rowStart = rowMatch.index;
          const rowOpenEnd = rowStart + rowTag.length;
          if (rowTag.endsWith('/>')) {
            // Self-closing row: expand to paired and insert cells.
            edits.push({
              index: rowOpenEnd,
              del: 0,
              ins: `${cXml}</row>`,
            });
            edits.push({
              index: rowOpenEnd - 2,
              del: 2,
              ins: '>',
            });
          } else {
            // Insert in column order among the row's existing <c> elements.
            const rowCells = ctags
              .filter((t) => t.r === r)
              .sort((a, b) => a.c - b.c);
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
          // Create the row in sorted position (before the first row with a
          // greater r, else before </sheetData>).
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

      // Apply edits descending so indices stay valid.
      edits.sort((a, b) => b.index - a.index);
      for (const e of edits) {
        xml = xml.slice(0, e.index) + e.ins + xml.slice(e.index + e.del);
      }
      files[path] = encoder.encode(xml);
    }

    if (touchedAnySheet || xfEls.length !== initialCount) {
      // Rewrite cellXfs with the new count.
      const countRe = /<cellXfs\b([^>]*)>/;
      const countMatch = countRe.exec(stylesXml);
      let newOpen: string;
      if (countMatch) {
        const attrsPart = countMatch[1] as string;
        newOpen = /\scount\s*=/.test(attrsPart)
          ? countMatch[0].replace(/\scount\s*=\s*"[^"]*"/, ` count="${xfEls.length}"`)
          : countMatch[0].replace(/>$/, ` count="${xfEls.length}">`);
      } else {
        newOpen = `<cellXfs count="${xfEls.length}">`;
      }
      const rebuilt =
        stylesXml.slice(0, (xfsMatch.index as number)) +
        newOpen +
        xfEls.join('') +
        '</cellXfs>' +
        stylesXml.slice((xfsMatch.index as number) + xfsMatch[0].length);
      files['xl/styles.xml'] = encoder.encode(rebuilt);
    }
    return zipSyncStable(files);
  } catch {
    return packageBytes;
  }
}

/**
 * Mirror workbook metadata protection state into native OOXML:
 * per-cell xf flags, `<sheetProtection>` elements, and
 * `<workbookProtection>`. Passwords are never written (design §4).
 */
export function injectNativeProtection(packageBytes: Uint8Array, data: WorkbookData): Uint8Array {
  let bytes = packageBytes;

  // 1. Per-cell xf flags: unlocked ranges from the sheet-protection state
  //    plus fidelity flags (hidden formulas, ...) from the manager. Ranges
  //    are expanded in full (empty cells materialize as empty styled <c>
  //    elements, as Excel does for formatted empty cells), bounded by
  //    MAX_RANGE_CELLS per range — fail closed past it.
  const targets = new Map<string, CellProtectionTarget[]>();
  for (const sheet of data.sheets) {
    const cellMap = new Map<string, CellProtectionTarget>();
    const put = (r: number, c: number, locked: boolean, hidden: boolean): void => {
      if (r < 0 || c < 0 || r > 1048575 || c > 16383) return;
      const key = `${r}:${c}`;
      const cur = cellMap.get(key) ?? { r, c, locked: true, hidden: false };
      // Unlocked wins over locked; hidden accumulates.
      cur.locked = cur.locked && locked;
      cur.hidden = cur.hidden || hidden;
      cellMap.set(key, cur);
    };
    const spMeta = data.metadata[`${PROTECTION_SHEET_META_PREFIX}${sheet.name}`];
    const unlocked =
      spMeta && typeof spMeta === 'object'
        ? (spMeta as { unlockedRanges?: unknown }).unlockedRanges
        : undefined;
    if (Array.isArray(unlocked)) {
      for (const range of unlocked) {
        if (typeof range !== 'string') continue;
        const parsed = parseA1RangeRef(range, sheet.name);
        if (!parsed) continue;
        const sr = Math.max(0, parsed.startRow);
        const er = Math.min(1048575, parsed.endRow);
        const sc = Math.max(0, parsed.startCol);
        const ec = Math.min(16383, parsed.endCol);
        if (er < sr || ec < sc) continue;
        if ((er - sr + 1) * (ec - sc + 1) > MAX_RANGE_CELLS) continue; // fail closed
        for (let r = sr; r <= er; r++) {
          for (let c = sc; c <= ec; c++) put(r, c, false, false);
        }
      }
    }
    const cfMeta = data.metadata[`${PROTECTION_CELLFLAGS_META_PREFIX}${sheet.name}`];
    if (cfMeta && typeof cfMeta === 'object') {
      for (const [key, v] of Object.entries(cfMeta as Record<string, CellProtectionFlags>)) {
        const mm = /^(\d+):(\d+)$/.exec(key);
        if (!mm || typeof v !== 'object' || v === null) continue;
        put(Number(mm[1]), Number(mm[2]), v.locked !== false, v.hidden === true);
      }
    }
    const final = [...cellMap.values()].filter((t) => !t.locked || t.hidden);
    if (final.length > 0) targets.set(sheet.name, final);
  }
  bytes = injectCellProtection(bytes, targets);

  // 2. <sheetProtection> per protected sheet.
  const specs = new Map<string, SheetProtectionOptions>();
  for (const [key, value] of Object.entries(data.metadata)) {
    if (!key.startsWith(PROTECTION_SHEET_META_PREFIX)) continue;
    if (!value || typeof value !== 'object') continue;
    const v = value as { options?: Partial<SheetProtectionOptions> };
    specs.set(key.slice(PROTECTION_SHEET_META_PREFIX.length), {
      ...DEFAULT_SHEET_OPTIONS,
      ...v.options,
    });
  }
  bytes = injectSheetProtection(bytes, specs);

  // 3. <workbookProtection>.
  const wbMeta = data.metadata[PROTECTION_WORKBOOK_META_KEY];
  const wb =
    wbMeta && typeof wbMeta === 'object'
      ? (wbMeta as { structure?: boolean; windows?: boolean })
      : null;
  bytes = injectWorkbookProtection(
    bytes,
    wb && (wb.structure || wb.windows) ? { structure: !!wb.structure, windows: !!wb.windows } : null,
  );
  return bytes;
}
