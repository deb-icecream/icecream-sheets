/**
 * Native XLSX page-setup round-trip (`<pageSetup>`, `<pageMargins>`,
 * `<headerFooter>`, and the `_xlnm.Print_Area` / `_xlnm.Print_Titles`
 * defined names).
 *
 * SheetJS community edition only surfaces `ws['!pageSetup']` (orientation,
 * paper size, scale, fit-to-page flags) and drops `<pageMargins>`,
 * `<headerFooter>`, and the `_xlnm.*` print defined names entirely — so a
 * file opened and re-saved lost its margins, headers/footers, print areas
 * and print titles. This module does the round-trip directly on the OOXML
 * package with fflate (the same unzip/modify/re-zip pattern as
 * pageBreaksXml.ts and macroProject.ts):
 *
 * - read:  for every worksheet part, extract `<pageSetup>` attributes,
 *          `<pageMargins>` attributes, the `<headerFooter>` children, and
 *          the `_xlnm.Print_Area` / `_xlnm.Print_Titles` defined names from
 *          `xl/workbook.xml` (resolved to sheet names via `localSheetId`).
 * - write: inject `<pageMargins>` / `<pageSetup>` / `<headerFooter>` into
 *          each worksheet part (schema order: before `<rowBreaks>` /
 *          `<colBreaks>` / `</worksheet>`) and add-or-replace the `_xlnm`
 *          defined names in `xl/workbook.xml`.
 *
 * The native model is carried through adapter metadata under
 * `xlsx.pageSetup.<sheet>` (lossless: exact paper-size index, raw
 * header/footer codes, raw defined-name values). It is also mapped to the
 * app-owned dialog model (`icecream.pagesetup.<sheet>` /
 * `icecream.printtitles.<sheet>`, the keys the web app's Page Setup dialog
 * reads/writes) so the dialog shows a real file's settings and dialog
 * edits land back in the native XML on save. Field-level merge: an
 * app-owned value only overrides the native one when it actually differs
 * from what the native settings map to, so untouched native settings
 * (multi-range print areas, distinct even/first headers, unknown paper
 * sizes, …) survive byte-for-byte.
 */

import { unzipSync } from 'fflate';
import { sheetPartPaths, type ZipLike } from './formulaRecovery.js';
import { zipSyncStable } from './zipStable.js';

/** Workbook-metadata key prefixes (contracts shared with the web app). */
export const PAGE_SETUP_APP_META_PREFIX = 'icecream.pagesetup.';
export const PRINT_TITLES_APP_META_PREFIX = 'icecream.printtitles.';

export interface PageMargins {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Distance from the top edge to the header, in inches. */
  header: number;
  /** Distance from the bottom edge to the footer, in inches. */
  footer: number;
}

export interface SheetHeaderFooter {
  differentOddEven: boolean;
  differentFirst: boolean;
  oddHeader: string;
  oddFooter: string;
  evenHeader: string;
  evenFooter: string;
  firstHeader: string;
  firstFooter: string;
}

/**
 * Native page-setup model for one sheet. All lengths in inches, scale in
 * percent, paperSize as the OOXML paper-size index (1=Letter, 5=Legal,
 * 8=A3, 9=A4, …). printArea/printTitleRows/printTitleCols hold the raw
 * defined-name values (e.g. `'Sheet1'!$A$1:$D$20`).
 */
export interface SheetPageSetup {
  orientation: 'portrait' | 'landscape';
  paperSize: number;
  scale: number;
  fitToPage: boolean;
  fitToWidth: number;
  fitToHeight: number;
  pageOrder: 'overThenDown' | 'downThenOver';
  margins: PageMargins;
  headerFooter: SheetHeaderFooter | null;
  printArea: string | null;
  printTitleRows: string | null;
  printTitleCols: string | null;
}

/**
 * The Page Setup dialog's model (apps/web/src/components/PrintLayout.tsx).
 * Declared structurally here so the adapter never imports from the web app.
 */
export interface AppPageSetupModel {
  orientation: 'portrait' | 'landscape';
  paperSize: 'letter' | 'a4' | 'legal' | 'a3';
  margins: { top: number; right: number; bottom: number; left: number; header?: number; footer?: number };
  /** Print scaling percent (10–400). */
  scale: number;
  /** A1-style print area ("A1:D20") or null for the whole used range. */
  printArea: string | null;
  header: string;
  footer: string;
  /** Fit-to-page: carried through the dialog model so native settings round-trip. */
  fitToPage: boolean;
  fitToWidth: number;
  fitToHeight: number;
}

export interface AppPrintTitlesModel {
  /** e.g. "1:3" — rows repeated at the top of every printed page. */
  rows: string;
  /** e.g. "A:C" — columns repeated at the left of every printed page. */
  cols: string;
}

/** Excel's default page margins (inches) — used to detect "has settings". */
const DEFAULT_MARGINS: PageMargins = { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 };

const PAPER_INDEX_TO_APP: Record<number, AppPageSetupModel['paperSize']> = {
  1: 'letter',
  5: 'legal',
  8: 'a3',
  9: 'a4',
};
const APP_TO_PAPER_INDEX: Record<AppPageSetupModel['paperSize'], number> = {
  letter: 1,
  legal: 5,
  a3: 8,
  a4: 9,
};

/** Minimal XML entity escape for attribute values / element text. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Minimal XML entity unescape for attribute values / element text. */
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

function numAttr(tag: string, name: string, fallback: number): number {
  const raw = attr(tag, name);
  if (raw === null) return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function boolAttr(tag: string, name: string): boolean {
  const raw = attr(tag, name);
  return raw === '1' || raw === 'true';
}

function childText(xml: string, name: string): string {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? unescapeXml(m[1]) : '';
}

/** Quote a sheet name for use in a defined-name value. */
function quoteSheetName(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) return name;
  return `'${name.replace(/'/g, "''")}'`;
}

/**
 * Strip the `Sheet1!` / `'My Sheet'!` prefix from a defined-name value,
 * leaving the bare A1 reference (first range only for multi-range values).
 */
function stripSheetPrefix(value: string): string {
  const first = value.split(',')[0] ?? '';
  const bang = first.indexOf('!');
  const ref = bang >= 0 ? first.slice(bang + 1) : first;
  return ref.trim();
}

function withoutDollars(a1: string): string {
  return a1.replace(/\$/g, '');
}

/**
 * Add `$` absolutes to an A1 reference ("A1:D20" → "$A$1:$D$20",
 * "1:3" → "$1:$3", "A:C" → "$A:$C"). Unparseable input passes through
 * unchanged (best-effort: never fail the save over a weird print area).
 */
function withDollars(a1: string): string {
  return a1
    .split(',')
    .map((part) =>
      part
        .split(':')
        .map((bound) => {
          const b = bound.trim().replace(/\$/g, '');
          let m = /^([A-Za-z]{1,3})(\d+)$/.exec(b);
          if (m) return `$${m[1].toUpperCase()}$${m[2]}`;
          m = /^(\d+)$/.exec(b);
          if (m) return `$${m[1]}`;
          m = /^([A-Za-z]{1,3})$/.exec(b);
          if (m) return `$${m[1].toUpperCase()}`;
          return bound;
        })
        .join(':'),
    )
    .join(',');
}

function parseMargins(tag: string | null): PageMargins {
  if (!tag) return { ...DEFAULT_MARGINS };
  return {
    left: numAttr(tag, 'left', DEFAULT_MARGINS.left),
    right: numAttr(tag, 'right', DEFAULT_MARGINS.right),
    top: numAttr(tag, 'top', DEFAULT_MARGINS.top),
    bottom: numAttr(tag, 'bottom', DEFAULT_MARGINS.bottom),
    header: numAttr(tag, 'header', DEFAULT_MARGINS.header),
    footer: numAttr(tag, 'footer', DEFAULT_MARGINS.footer),
  };
}

function parseHeaderFooter(block: string | null): SheetHeaderFooter | null {
  if (!block) return null;
  const openTag = /^<headerFooter\b[^>]*>/.exec(block)?.[0] ?? '';
  const hf: SheetHeaderFooter = {
    differentOddEven: boolAttr(openTag, 'differentOddEven'),
    differentFirst: boolAttr(openTag, 'differentFirst'),
    oddHeader: childText(block, 'oddHeader'),
    oddFooter: childText(block, 'oddFooter'),
    evenHeader: childText(block, 'evenHeader'),
    evenFooter: childText(block, 'evenFooter'),
    firstHeader: childText(block, 'firstHeader'),
    firstFooter: childText(block, 'firstFooter'),
  };
  const hasText =
    hf.oddHeader !== '' ||
    hf.oddFooter !== '' ||
    hf.evenHeader !== '' ||
    hf.evenFooter !== '' ||
    hf.firstHeader !== '' ||
    hf.firstFooter !== '';
  return hasText || hf.differentOddEven || hf.differentFirst ? hf : null;
}

function marginsEqual(a: PageMargins, b: PageMargins): boolean {
  return (
    Math.abs(a.left - b.left) < 1e-9 &&
    Math.abs(a.right - b.right) < 1e-9 &&
    Math.abs(a.top - b.top) < 1e-9 &&
    Math.abs(a.bottom - b.bottom) < 1e-9 &&
    Math.abs(a.header - b.header) < 1e-9 &&
    Math.abs(a.footer - b.footer) < 1e-9
  );
}

/** True when the setup carries anything worth persisting. */
export function hasPageSetupSettings(s: SheetPageSetup): boolean {
  return (
    s.orientation !== 'portrait' ||
    s.paperSize !== 1 ||
    s.scale !== 100 ||
    s.fitToPage ||
    s.fitToWidth !== 0 ||
    s.fitToHeight !== 0 ||
    s.pageOrder !== 'downThenOver' ||
    !marginsEqual(s.margins, DEFAULT_MARGINS) ||
    s.headerFooter !== null ||
    s.printArea !== null ||
    s.printTitleRows !== null ||
    s.printTitleCols !== null
  );
}

/**
 * Sheet names in `xl/workbook.xml` document order (the `localSheetId`
 * of a defined name indexes into this list).
 */
function workbookSheetOrder(wbXml: string): string[] {
  const names: string[] = [];
  for (const tag of wbXml.match(/<sheet\b[^>]*>/g) ?? []) {
    const name = attr(tag, 'name');
    if (name !== null) names.push(name);
  }
  return names;
}

interface PrintDefinedNames {
  printArea: string | null;
  printTitleRows: string | null;
  printTitleCols: string | null;
}

/**
 * Split a `_xlnm.Print_Titles` value like `'S'!$1:$3,'S'!$A:$C` into its
 * row part and column part.
 */
function splitPrintTitles(value: string): { rows: string | null; cols: string | null } {
  let rows: string | null = null;
  let cols: string | null = null;
  for (const part of value.split(',')) {
    const ref = stripSheetPrefix(part).replace(/\$/g, '');
    if (/^\d+:\d+$/.test(ref)) {
      if (rows === null) rows = part.trim();
    } else if (/^[A-Za-z]{1,3}:[A-Za-z]{1,3}$/.test(ref)) {
      if (cols === null) cols = part.trim();
    }
  }
  return { rows, cols };
}

/**
 * Read native page-setup settings from every worksheet in the package.
 * Never throws: unparseable parts are skipped (a corrupt hint must not
 * break the open).
 */
export function readSheetPageSetup(
  packageBytes: Uint8Array,
  preunzipped?: Record<string, Uint8Array>,
): Map<string, SheetPageSetup> {
  const out = new Map<string, SheetPageSetup>();
  try {
    const files = (preunzipped ?? unzipSync(packageBytes.slice())) as ZipLike;
    const parts = sheetPartPaths(files);
    if (parts.size === 0) return out;
    const decoder = new TextDecoder();

    // _xlnm.Print_Area / _xlnm.Print_Titles per sheet (via localSheetId).
    const wbRaw = files['xl/workbook.xml'];
    const sheetOrder = wbRaw ? workbookSheetOrder(decoder.decode(wbRaw)) : [];
    const printNames = new Map<string, PrintDefinedNames>();
    if (wbRaw) {
      const wbXml = decoder.decode(wbRaw);
      for (const m of wbXml.match(/<definedName\b[^>]*>[\s\S]*?<\/definedName>/g) ?? []) {
        const openTag = /^<definedName\b[^>]*>/.exec(m)?.[0] ?? '';
        const name = attr(openTag, 'name');
        if (name !== '_xlnm.Print_Area' && name !== '_xlnm.Print_Titles') continue;
        const localSheetId = attr(openTag, 'localSheetId');
        const idx = localSheetId === null ? -1 : parseInt(localSheetId, 10);
        const sheetName = idx >= 0 && idx < sheetOrder.length ? sheetOrder[idx] : null;
        if (sheetName === null) continue;
        const value = unescapeXml(m.replace(/^<definedName\b[^>]*>/, '').replace(/<\/definedName>$/, '')).trim();
        if (value === '') continue;
        const cur = printNames.get(sheetName) ?? { printArea: null, printTitleRows: null, printTitleCols: null };
        if (name === '_xlnm.Print_Area') {
          cur.printArea = value;
        } else {
          const { rows, cols } = splitPrintTitles(value);
          if (rows) cur.printTitleRows = rows;
          if (cols) cur.printTitleCols = cols;
        }
        printNames.set(sheetName, cur);
      }
    }

    for (const [name, path] of parts) {
      const raw = files[path];
      if (!raw) continue;
      const xml = decoder.decode(raw);
      const psTag = /<pageSetup\b[^>]*\/?>/.exec(xml)?.[0] ?? null;
      const pmTag = /<pageMargins\b[^>]*\/?>/.exec(xml)?.[0] ?? null;
      const hfBlock = /<headerFooter[\s>][\s\S]*?<\/headerFooter>/.exec(xml)?.[0] ?? null;
      const names = printNames.get(name) ?? { printArea: null, printTitleRows: null, printTitleCols: null };
      const setup: SheetPageSetup = {
        orientation: psTag && attr(psTag, 'orientation') === 'landscape' ? 'landscape' : 'portrait',
        paperSize: psTag ? Math.trunc(numAttr(psTag, 'paperSize', 1)) : 1,
        scale: psTag ? Math.trunc(numAttr(psTag, 'scale', 100)) : 100,
        fitToPage: psTag ? boolAttr(psTag, 'fitToPage') : false,
        fitToWidth: psTag ? Math.trunc(numAttr(psTag, 'fitToWidth', 0)) : 0,
        fitToHeight: psTag ? Math.trunc(numAttr(psTag, 'fitToHeight', 0)) : 0,
        pageOrder: psTag && attr(psTag, 'pageOrder') === 'overThenDown' ? 'overThenDown' : 'downThenOver',
        margins: parseMargins(pmTag),
        headerFooter: parseHeaderFooter(hfBlock),
        printArea: names.printArea,
        printTitleRows: names.printTitleRows,
        printTitleCols: names.printTitleCols,
      };
      if (hasPageSetupSettings(setup)) out.set(name, setup);
    }
  } catch {
    // Best-effort: page setup must never break the open.
  }
  return out;
}

/** Map the native model to the Page Setup dialog's app model. */
export function sheetPageSetupToAppModel(s: SheetPageSetup): AppPageSetupModel {
  return {
    orientation: s.orientation,
    paperSize: PAPER_INDEX_TO_APP[s.paperSize] ?? 'letter',
    margins: { top: s.margins.top, right: s.margins.right, bottom: s.margins.bottom, left: s.margins.left, header: s.margins.header, footer: s.margins.footer },
    scale: s.scale,
    printArea: s.printArea === null ? null : withoutDollars(stripSheetPrefix(s.printArea)),
    header: s.headerFooter?.oddHeader ?? '',
    footer: s.headerFooter?.oddFooter ?? '',
    fitToPage: s.fitToPage,
    fitToWidth: s.fitToWidth,
    fitToHeight: s.fitToHeight,
  };
}

/** Map native print titles to the dialog's print-titles model (null when neither is set). */
export function sheetPageSetupToAppTitles(s: SheetPageSetup): AppPrintTitlesModel | null {
  if (s.printTitleRows === null && s.printTitleCols === null) return null;
  return {
    rows: s.printTitleRows === null ? '' : withoutDollars(stripSheetPrefix(s.printTitleRows)),
    cols: s.printTitleCols === null ? '' : withoutDollars(stripSheetPrefix(s.printTitleCols)),
  };
}

/** Loose validation of an `icecream.pagesetup.<sheet>` metadata value. */
function cleanAppModel(value: unknown): AppPageSetupModel | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  if (r.orientation !== 'portrait' && r.orientation !== 'landscape') return null;
  const paperSize =
    r.paperSize === 'letter' || r.paperSize === 'a4' || r.paperSize === 'legal' || r.paperSize === 'a3'
      ? r.paperSize
      : 'letter';
  const m = (typeof r.margins === 'object' && r.margins !== null ? r.margins : {}) as Record<string, unknown>;
  const marginNum = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const hfMargin = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  return {
    orientation: r.orientation,
    paperSize,
    margins: {
      top: marginNum(m.top, DEFAULT_MARGINS.top),
      right: marginNum(m.right, DEFAULT_MARGINS.right),
      bottom: marginNum(m.bottom, DEFAULT_MARGINS.bottom),
      left: marginNum(m.left, DEFAULT_MARGINS.left),
      header: hfMargin(m.header),
      footer: hfMargin(m.footer),
    },
    scale: typeof r.scale === 'number' && Number.isFinite(r.scale) ? Math.trunc(r.scale) : 100,
    printArea: typeof r.printArea === 'string' && r.printArea.trim() !== '' ? r.printArea.trim() : null,
    header: typeof r.header === 'string' ? r.header : '',
    footer: typeof r.footer === 'string' ? r.footer : '',
    fitToPage: r.fitToPage === true,
    fitToWidth:
      typeof r.fitToWidth === 'number' && Number.isFinite(r.fitToWidth) ? Math.max(0, Math.trunc(r.fitToWidth)) : 0,
    fitToHeight:
      typeof r.fitToHeight === 'number' && Number.isFinite(r.fitToHeight) ? Math.max(0, Math.trunc(r.fitToHeight)) : 0,
  };
}

function cleanAppTitles(value: unknown): AppPrintTitlesModel | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.rows !== 'string' || typeof r.cols !== 'string') return null;
  return { rows: r.rows.trim(), cols: r.cols.trim() };
}

/** Validate a `xlsx.pageSetup.<sheet>` metadata value (the native model). */
function cleanNativeSetup(value: unknown): SheetPageSetup | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  const m = (typeof r.margins === 'object' && r.margins !== null ? r.margins : {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const hf = (typeof r.headerFooter === 'object' && r.headerFooter !== null ? r.headerFooter : null) as Record<
    string,
    unknown
  > | null;
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return {
    orientation: r.orientation === 'landscape' ? 'landscape' : 'portrait',
    paperSize: Math.trunc(num(r.paperSize, 1)),
    scale: Math.trunc(num(r.scale, 100)),
    fitToPage: r.fitToPage === true,
    fitToWidth: Math.trunc(num(r.fitToWidth, 0)),
    fitToHeight: Math.trunc(num(r.fitToHeight, 0)),
    pageOrder: r.pageOrder === 'overThenDown' ? 'overThenDown' : 'downThenOver',
    margins: {
      left: num(m.left, DEFAULT_MARGINS.left),
      right: num(m.right, DEFAULT_MARGINS.right),
      top: num(m.top, DEFAULT_MARGINS.top),
      bottom: num(m.bottom, DEFAULT_MARGINS.bottom),
      header: num(m.header, DEFAULT_MARGINS.header),
      footer: num(m.footer, DEFAULT_MARGINS.footer),
    },
    headerFooter:
      hf === null
        ? null
        : {
            differentOddEven: hf.differentOddEven === true,
            differentFirst: hf.differentFirst === true,
            oddHeader: str(hf.oddHeader) ?? '',
            oddFooter: str(hf.oddFooter) ?? '',
            evenHeader: str(hf.evenHeader) ?? '',
            evenFooter: str(hf.evenFooter) ?? '',
            firstHeader: str(hf.firstHeader) ?? '',
            firstFooter: str(hf.firstFooter) ?? '',
          },
    printArea: str(r.printArea),
    printTitleRows: str(r.printTitleRows),
    printTitleCols: str(r.printTitleCols),
  };
}

function appModelsEqual(a: AppPageSetupModel, b: AppPageSetupModel): boolean {
  const hf = (v: number | undefined): number => v ?? DEFAULT_MARGINS.header;
  const ff = (v: number | undefined): number => v ?? DEFAULT_MARGINS.footer;
  return (
    a.orientation === b.orientation &&
    a.paperSize === b.paperSize &&
    Math.abs(a.margins.top - b.margins.top) < 1e-9 &&
    Math.abs(a.margins.right - b.margins.right) < 1e-9 &&
    Math.abs(a.margins.bottom - b.margins.bottom) < 1e-9 &&
    Math.abs(a.margins.left - b.margins.left) < 1e-9 &&
    Math.abs(hf(a.margins.header) - hf(b.margins.header)) < 1e-9 &&
    Math.abs(ff(a.margins.footer) - ff(b.margins.footer)) < 1e-9 &&
    a.scale === b.scale &&
    a.printArea === b.printArea &&
    a.header === b.header &&
    a.footer === b.footer &&
    a.fitToPage === b.fitToPage &&
    a.fitToWidth === b.fitToWidth &&
    a.fitToHeight === b.fitToHeight
  );
}

function titlesEqual(a: AppPrintTitlesModel, b: AppPrintTitlesModel): boolean {
  return a.rows === b.rows && a.cols === b.cols;
}

/**
 * Merge the native settings captured on read with the app-owned Page Setup
 * dialog values for one sheet. Field-level: an app value overrides the
 * native one only when it differs from what the native settings map to —
 * untouched native detail (exact paper index, raw defined-name values,
 * distinct even/first headers, …) is preserved as-is.
 *
 * Returns null when the sheet has no page-setup settings at all.
 */
export function mergeSheetPageSetup(
  nativeRaw: unknown,
  appRaw: unknown,
  titlesRaw: unknown,
  sheetName: string,
): SheetPageSetup | null {
  const native = cleanNativeSetup(nativeRaw);
  const app = cleanAppModel(appRaw);
  const titles = cleanAppTitles(titlesRaw);

  if (!native && !app && !titles) return null;

  // No native baseline: build purely from the app-owned values (dialog
  // edits on a fresh sheet, or the app's save path which only carries the
  // app model).
  if (!native) {
    const a: AppPageSetupModel = app ?? {
      orientation: 'portrait',
      paperSize: 'letter',
      margins: { top: DEFAULT_MARGINS.top, right: DEFAULT_MARGINS.right, bottom: DEFAULT_MARGINS.bottom, left: DEFAULT_MARGINS.left },
      scale: 100,
      printArea: null,
      header: '',
      footer: '',
      fitToPage: false,
      fitToWidth: 0,
      fitToHeight: 0,
    };
    const t: AppPrintTitlesModel = titles ?? { rows: '', cols: '' };
    const setup: SheetPageSetup = {
      orientation: a.orientation,
      paperSize: APP_TO_PAPER_INDEX[a.paperSize],
      scale: a.scale,
      fitToPage: a.fitToPage,
      fitToWidth: a.fitToWidth,
      fitToHeight: a.fitToHeight,
      pageOrder: 'downThenOver',
      margins: {
        left: a.margins.left,
        right: a.margins.right,
        top: a.margins.top,
        bottom: a.margins.bottom,
        header: a.margins.header ?? DEFAULT_MARGINS.header,
        footer: a.margins.footer ?? DEFAULT_MARGINS.footer,
      },
      headerFooter:
        a.header !== '' || a.footer !== ''
          ? {
              differentOddEven: false,
              differentFirst: false,
              oddHeader: a.header,
              oddFooter: a.footer,
              evenHeader: '',
              evenFooter: '',
              firstHeader: '',
              firstFooter: '',
            }
          : null,
      printArea: a.printArea === null ? null : `${quoteSheetName(sheetName)}!${withDollars(a.printArea)}`,
      printTitleRows: t.rows === '' ? null : `${quoteSheetName(sheetName)}!${withDollars(t.rows)}`,
      printTitleCols: t.cols === '' ? null : `${quoteSheetName(sheetName)}!${withDollars(t.cols)}`,
    };
    return hasPageSetupSettings(setup) ? setup : null;
  }

  // Native baseline exists: overlay only the app fields that genuinely
  // differ from the native-mapped model (i.e. real dialog edits).
  const merged: SheetPageSetup = {
    ...native,
    margins: { ...native.margins },
    headerFooter: native.headerFooter ? { ...native.headerFooter } : null,
  };
  if (app && !appModelsEqual(app, sheetPageSetupToAppModel(native))) {
    merged.orientation = app.orientation;
    merged.paperSize = APP_TO_PAPER_INDEX[app.paperSize];
    merged.scale = app.scale;
    merged.fitToPage = app.fitToPage;
    merged.fitToWidth = app.fitToWidth;
    merged.fitToHeight = app.fitToHeight;
    merged.margins = {
      ...merged.margins,
      top: app.margins.top,
      right: app.margins.right,
      bottom: app.margins.bottom,
      left: app.margins.left,
      header: app.margins.header ?? merged.margins.header,
      footer: app.margins.footer ?? merged.margins.footer,
    };
    const nativeArea = native.printArea === null ? null : withoutDollars(stripSheetPrefix(native.printArea));
    merged.printArea =
      app.printArea === nativeArea
        ? native.printArea
        : app.printArea === null
          ? null
          : `${quoteSheetName(sheetName)}!${withDollars(app.printArea)}`;
    // Header/footer: the dialog edits the single header/footer; write to
    // the odd pair, and mirror into the even/first pairs only where they
    // previously mirrored the odd value (distinct even/first headers are
    // left alone).
    const oldHeader = native.headerFooter?.oddHeader ?? '';
    const oldFooter = native.headerFooter?.oddFooter ?? '';
    if (app.header !== oldHeader || app.footer !== oldFooter) {
      const prev = merged.headerFooter ?? {
        differentOddEven: false,
        differentFirst: false,
        oddHeader: '',
        oddFooter: '',
        evenHeader: '',
        evenFooter: '',
        firstHeader: '',
        firstFooter: '',
      };
      merged.headerFooter = {
        ...prev,
        oddHeader: app.header,
        oddFooter: app.footer,
        evenHeader: prev.evenHeader === oldHeader ? app.header : prev.evenHeader,
        evenFooter: prev.evenFooter === oldFooter ? app.footer : prev.evenFooter,
        firstHeader: prev.firstHeader === oldHeader ? app.header : prev.firstHeader,
        firstFooter: prev.firstFooter === oldFooter ? app.footer : prev.firstFooter,
      };
    }
  }
  if (titles) {
    const nativeTitles = sheetPageSetupToAppTitles(native) ?? { rows: '', cols: '' };
    if (!titlesEqual(titles, nativeTitles)) {
      merged.printTitleRows = titles.rows === '' ? null : `${quoteSheetName(sheetName)}!${withDollars(titles.rows)}`;
      merged.printTitleCols = titles.cols === '' ? null : `${quoteSheetName(sheetName)}!${withDollars(titles.cols)}`;
    }
  }
  return hasPageSetupSettings(merged) ? merged : null;
}

function pageSetupElement(s: SheetPageSetup): string {
  // fitToWidth/fitToHeight are emitted whenever nonzero even without
  // fitToPage: writers like ClosedXML set them on their own, and dropping
  // them would break read → write → read fidelity.
  const fit =
    (s.fitToPage ? ' fitToPage="1"' : '') +
    (s.fitToWidth !== 0 ? ` fitToWidth="${s.fitToWidth}"` : '') +
    (s.fitToHeight !== 0 ? ` fitToHeight="${s.fitToHeight}"` : '');
  const order = s.pageOrder === 'overThenDown' ? ' pageOrder="overThenDown"' : '';
  return (
    `<pageMargins left="${s.margins.left}" right="${s.margins.right}"` +
    ` top="${s.margins.top}" bottom="${s.margins.bottom}"` +
    ` header="${s.margins.header}" footer="${s.margins.footer}"/>` +
    `<pageSetup orientation="${s.orientation}" paperSize="${s.paperSize}"` +
    ` scale="${s.scale}"${fit}${order}/>` +
    headerFooterElement(s.headerFooter)
  );
}

function headerFooterElement(hf: SheetHeaderFooter | null): string {
  if (hf === null) return '';
  const kids =
    (hf.oddHeader !== '' ? `<oddHeader>${escapeXml(hf.oddHeader)}</oddHeader>` : '') +
    (hf.oddFooter !== '' ? `<oddFooter>${escapeXml(hf.oddFooter)}</oddFooter>` : '') +
    (hf.evenHeader !== '' ? `<evenHeader>${escapeXml(hf.evenHeader)}</evenHeader>` : '') +
    (hf.evenFooter !== '' ? `<evenFooter>${escapeXml(hf.evenFooter)}</evenFooter>` : '') +
    (hf.firstHeader !== '' ? `<firstHeader>${escapeXml(hf.firstHeader)}</firstHeader>` : '') +
    (hf.firstFooter !== '' ? `<firstFooter>${escapeXml(hf.firstFooter)}</firstFooter>` : '');
  if (kids === '' && !hf.differentOddEven && !hf.differentFirst) return '';
  const flags =
    (hf.differentOddEven ? ' differentOddEven="1"' : '') + (hf.differentFirst ? ' differentFirst="1"' : '');
  return `<headerFooter${flags}>${kids}</headerFooter>`;
}

/**
 * Insert `block` before the earliest of the given markers (schema order:
 * pageMargins/pageSetup/headerFooter precede rowBreaks/colBreaks and the
 * drawing/table parts). Falls back to `</worksheet>`.
 */
function insertWorksheetBlock(xml: string, block: string, markers: string[]): string {
  let at = xml.indexOf('</worksheet>');
  if (at < 0) return xml;
  for (const marker of markers) {
    const i = xml.indexOf(marker);
    if (i >= 0 && i < at) at = i;
  }
  return xml.slice(0, at) + block + xml.slice(at);
}

const SETUP_STRIP_RE =
  /<pageMargins\b[^>]*\/?>|<pageSetup\b[^>]*\/?>|<headerFooter[\s>][\s\S]*?<\/headerFooter>/g;

/**
 * Inject native page-setup XML into the worksheet part of each named sheet.
 * Sheets without an entry (or with no settings) are left untouched — but
 * any page-setup elements a previous injection left behind are stripped
 * first so repeated saves stay idempotent. Never throws: injection
 * failures return the input unchanged.
 *
 * Call this BEFORE injectSheetPageBreaks: breaks are appended before
 * `</worksheet>`, which lands after the setup elements per schema order.
 */
export function injectSheetPageSetup(
  packageBytes: Uint8Array,
  setups: Map<string, SheetPageSetup>,
): Uint8Array {
  if (setups.size === 0) return packageBytes;
  try {
    const files = unzipSync(packageBytes.slice()) as ZipLike;
    const parts = sheetPartPaths(files);
    if (parts.size === 0) return packageBytes;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let touched = false;

    // Sheet name → 0-based index in xl/workbook.xml (for localSheetId).
    const wbPath = 'xl/workbook.xml';
    const wbRaw = files[wbPath];
    const sheetIndex = new Map<string, number>();
    if (wbRaw) {
      workbookSheetOrder(decoder.decode(wbRaw)).forEach((n, i) => {
        if (!sheetIndex.has(n)) sheetIndex.set(n, i);
      });
    }

    for (const [name, setup] of setups) {
      if (!hasPageSetupSettings(setup)) continue;
      const path = parts.get(name);
      const raw = path ? files[path] : undefined;
      if (!path || !raw) continue;
      let xml = decoder.decode(raw);
      if (!xml.includes('</worksheet>')) continue;
      // Strip any setup a previous injection (or a stale element) left
      // behind so the result has exactly one of each element.
      xml = xml.replace(SETUP_STRIP_RE, '');
      xml = insertWorksheetBlock(xml, pageSetupElement(setup), [
        '<rowBreaks',
        '<colBreaks',
        '<drawing',
        '<legacyDrawing',
        '<tableParts',
        '<extLst',
      ]);
      files[path] = encoder.encode(xml);
      touched = true;
    }

    // _xlnm.Print_Area / _xlnm.Print_Titles defined names in xl/workbook.xml.
    if (wbRaw && setups.size > 0) {
      let wbXml = decoder.decode(wbRaw);
      let wbTouched = false;
      for (const [name, setup] of setups) {
        const idx = sheetIndex.get(name);
        if (idx === undefined) continue;
        const area = setup.printArea;
        const titles =
          setup.printTitleRows !== null || setup.printTitleCols !== null
            ? [setup.printTitleRows, setup.printTitleCols].filter((v): v is string => v !== null).join(',')
            : null;
        const before = wbXml;
        wbXml = upsertPrintDefinedName(wbXml, '_xlnm.Print_Area', idx, area);
        wbXml = upsertPrintDefinedName(wbXml, '_xlnm.Print_Titles', idx, titles);
        if (wbXml !== before) wbTouched = true;
      }
      if (wbTouched) {
        files[wbPath] = encoder.encode(wbXml);
        touched = true;
      }
    }

    return touched ? zipSyncStable(files) : packageBytes;
  } catch {
    return packageBytes;
  }
}

/**
 * Add-or-replace one `_xlnm.*` defined name scoped to a sheet
 * (localSheetId). A null value removes any existing entry (e.g. the user
 * cleared the print area).
 */
function upsertPrintDefinedName(
  wbXml: string,
  definedName: '_xlnm.Print_Area' | '_xlnm.Print_Titles',
  localSheetId: number,
  value: string | null,
): string {
  // Strip any existing entry for this name+scope regardless of attribute
  // order (a previous injection or the original file may differ).
  const stripRe = /<definedName\b[^>]*>[\s\S]*?<\/definedName>/g;
  let out = wbXml.replace(stripRe, (m) => {
    const openTag = /^<definedName\b[^>]*>/.exec(m)?.[0] ?? '';
    return attr(openTag, 'name') === definedName && attr(openTag, 'localSheetId') === String(localSheetId)
      ? ''
      : m;
  });
  if (value === null) return out;
  const element =
    `<definedName name="${definedName}" localSheetId="${localSheetId}">` +
    `${escapeXml(value)}</definedName>`;
  const blockRe = /<definedNames\b[^>]*>([\s\S]*?)<\/definedNames>/;
  const block = blockRe.exec(out);
  if (block) {
    // Replacement *function*: the element contains `$1`-style sequences
    // (e.g. `Data!$1:$3`) that String.replace would treat as backreferences.
    out = out.replace(blockRe, () => `<definedNames>${block[1]}${element}</definedNames>`);
  } else {
    // Schema order: <definedNames> sits after <sheets>, before <calcPr>.
    const calcPr = out.indexOf('<calcPr');
    const end = out.indexOf('</workbook>');
    const at = calcPr >= 0 ? calcPr : end;
    if (at < 0) return wbXml; // not a workbook part we understand; bail out
    out = `${out.slice(0, at)}<definedNames>${element}</definedNames>${out.slice(at)}`;
  }
  return out;
}
