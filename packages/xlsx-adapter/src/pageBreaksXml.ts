/**
 * Native XLSX page-break round-trip (`<rowBreaks>` / `<colBreaks>`).
 *
 * SheetJS community edition neither parses nor writes worksheet page
 * breaks, so this module does it directly on the OOXML package with fflate
 * (the same unzip/modify/re-zip pattern as macroProject.ts):
 *
 * - read:  for every worksheet part, extract manual `<brk man="1">` entries
 *          from `<rowBreaks>` / `<colBreaks>` and convert to the
 *          `icecream.pagebreaks.<sheet>` model (0-based "break after" index).
 * - write: inject `<rowBreaks>` / `<colBreaks>` XML before `</worksheet>`
 *          for every sheet that has manual breaks.
 *
 * Break-id semantics (verified against openpyxl/LibreOffice output):
 * a row `<brk id="K" man="1"/>` starts a new page at 1-based row K, i.e. the
 * break runs AFTER 0-based row K-2. Column breaks are analogous
 * (max="1048575"). Only manual breaks (man="1") are modeled; automatic
 * breaks Excel may add are layout, not setup.
 */

import { unzipSync } from 'fflate';
import { zipSyncStable } from './zipStable.js';

export interface SheetPageBreaks {
  /** 0-based row indices: break AFTER each of these rows. */
  rows: number[];
  /** 0-based column indices: break AFTER each of these columns. */
  cols: number[];
}

/** Workbook-metadata key prefix (contract shared with the web app). */
export const PAGE_BREAKS_META_PREFIX = 'icecream.pagebreaks.';

const MAX_COL_1BASED = 16384; // XFD
const MAX_ROW_1BASED = 1048576;

function sortedUnique(values: number[]): number[] {
  return [...new Set(values)].filter((v) => Number.isInteger(v) && v >= 0).sort((a, b) => a - b);
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
  const m = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return m ? unescapeXml(m[1]) : null;
}

/**
 * Map workbook sheet names to their worksheet part paths, via
 * xl/workbook.xml (sheet name → r:id) and xl/_rels/workbook.xml.rels
 * (r:id → part target).
 */
function sheetPartPaths(files: Record<string, Uint8Array>): Map<string, string> {
  const out = new Map<string, string>();
  const wbXml = files['xl/workbook.xml'];
  const relsXml = files['xl/_rels/workbook.xml.rels'];
  if (!wbXml || !relsXml) return out;
  const decoder = new TextDecoder();
  const wb = decoder.decode(wbXml);
  const rels = decoder.decode(relsXml);

  const targetByRid = new Map<string, string>();
  for (const tag of rels.match(/<Relationship\b[^>]*>/g) ?? []) {
    const id = attr(tag, 'Id');
    const target = attr(tag, 'Target');
    const type = attr(tag, 'Type') ?? '';
    if (id && target && /worksheet$/.test(type)) {
      // Target is relative to xl/ (e.g. "worksheets/sheet1.xml").
      targetByRid.set(id, target.startsWith('xl/') ? target : `xl/${target}`);
    }
  }
  for (const tag of wb.match(/<sheet\b[^>]*>/g) ?? []) {
    const name = attr(tag, 'name');
    const rid = attr(tag, 'r:id');
    if (name && rid && targetByRid.has(rid)) {
      out.set(name, targetByRid.get(rid) as string);
    }
  }
  return out;
}

/** Extract manual break ids from one `<rowBreaks>` / `<colBreaks>` element. */
function manualBreakIds(elementXml: string): number[] {
  const ids: number[] = [];
  for (const tag of elementXml.match(/<brk\b[^>]*>/g) ?? []) {
    // OOXML booleans serialize as "1" (Excel) or "true" (LibreOffice);
    // automatic breaks (no man attribute) are layout, not setup.
    const man = attr(tag, 'man');
    if (man !== '1' && man !== 'true') continue;
    const id = attr(tag, 'id');
    if (id === null) continue;
    const n = parseInt(id, 10);
    if (Number.isInteger(n) && n >= 2) ids.push(n - 2); // id K → break after 0-based K-2
  }
  return sortedUnique(ids);
}

function section(xml: string, name: 'rowBreaks' | 'colBreaks'): string {
  const m = new RegExp(`<${name}[\\s>][\\s\\S]*?</${name}>`).exec(xml);
  return m ? m[0] : '';
}

/**
 * Read manual page breaks from every worksheet in the package.
 * Never throws: unparseable parts are skipped (a corrupt hint must not
 * break the open).
 */
export function readSheetPageBreaks(
  packageBytes: Uint8Array,
  preunzipped?: Record<string, Uint8Array>,
): Map<string, SheetPageBreaks> {
  const out = new Map<string, SheetPageBreaks>();
  try {
    const files = preunzipped ?? unzipSync(packageBytes.slice());
    const parts = sheetPartPaths(files);
    if (parts.size === 0) return out;
    const decoder = new TextDecoder();
    for (const [name, path] of parts) {
      const raw = files[path];
      if (!raw) continue;
      const xml = decoder.decode(raw);
      const rows = manualBreakIds(section(xml, 'rowBreaks'));
      const cols = manualBreakIds(section(xml, 'colBreaks'));
      if (rows.length > 0 || cols.length > 0) out.set(name, { rows, cols });
    }
  } catch {
    // Best-effort: page breaks must never break the open.
  }
  return out;
}

function breaksElement(kind: 'row' | 'col', after: number[], max: number): string {
  if (after.length === 0) return '';
  const tag = kind === 'row' ? 'rowBreaks' : 'colBreaks';
  const brks = after.map((i) => `<brk id="${i + 2}" max="${max}" man="1"/>`).join('');
  return `<${tag} count="${after.length}" manualBreakCount="${after.length}">${brks}</${tag}>`;
}

/**
 * Inject native `<rowBreaks>` / `<colBreaks>` into the worksheet XML of each
 * named sheet. Sheets without an entry (or with empty breaks) are left
 * untouched. Never throws: injection failures return the input unchanged.
 */
export function injectSheetPageBreaks(
  packageBytes: Uint8Array,
  breaks: Map<string, SheetPageBreaks>,
): Uint8Array {
  if (breaks.size === 0) return packageBytes;
  try {
    const files = unzipSync(packageBytes.slice());
    const parts = sheetPartPaths(files);
    if (parts.size === 0) return packageBytes;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let touched = false;
    for (const [name, wanted] of breaks) {
      const rows = sortedUnique(wanted.rows).filter((r) => r < MAX_ROW_1BASED - 1);
      const cols = sortedUnique(wanted.cols).filter((c) => c < MAX_COL_1BASED - 1);
      if (rows.length === 0 && cols.length === 0) continue;
      const path = parts.get(name);
      const raw = path ? files[path] : undefined;
      if (!path || !raw) continue;
      let xml = decoder.decode(raw);
      if (!xml.includes('</worksheet>')) continue;
      // Remove any breaks a previous injection (or SheetJS) left behind so
      // repeated saves stay idempotent.
      xml = xml.replace(/<rowBreaks[\s>][\s\S]*?<\/rowBreaks>/g, '');
      xml = xml.replace(/<colBreaks[\s>][\s\S]*?<\/colBreaks>/g, '');
      const injection =
        breaksElement('row', rows, MAX_COL_1BASED - 1) + breaksElement('col', cols, MAX_ROW_1BASED - 1);
      if (!injection) continue;
      xml = xml.replace('</worksheet>', `${injection}</worksheet>`);
      files[path] = encoder.encode(xml);
      touched = true;
    }
    return touched ? zipSyncStable(files) : packageBytes;
  } catch {
    return packageBytes;
  }
}
