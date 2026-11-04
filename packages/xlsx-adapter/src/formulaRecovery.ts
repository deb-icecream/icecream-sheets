/**
 * Formula recovery from raw worksheet XML.
 *
 * Two gaps SheetJS community edition leaves behind, both of which silently
 * drop cell content on read:
 *
 * 1. Stale `<dimension>`: some writers (excelize, xlsx-populate, …) emit a
 *    `<dimension ref="…">` that is smaller than the actual `<c>` content.
 *    SheetJS trusts it for `ws['!ref']`, and the adapter used to size its
 *    row arrays from `!ref` alone — every parsed cell outside the dimension
 *    was dropped.
 *
 * 2. Formula cells without a cached `<v>`: SheetJS CE drops `<c>` elements
 *    whose `<f>` has no cached value (writers are not required to cache).
 *    This also covers shared formulas (`t="shared"`): slaves (`<f
 *    t="shared" si="N"/>`) carry no text at all, so they are always dropped,
 *    and masters without cached values go with them.
 *
 * This module re-reads the worksheet XML directly (regex-based, browser-safe
 * — the same approach as pageBreaksXml.ts/tables.ts) and recovers:
 *  - the true used range: union of `<dimension>` and every `<c r="…">`,
 *  - formula text for cells SheetJS dropped, translating shared-formula
 *    slaves from their master's text with proper relative-reference
 *    shifting (OOXML §18.3.1.40: the stored text is relative to the master
 *    cell; each slave shifts relative refs by its offset from the master).
 *
 * Everything is best-effort: any parse failure yields "no recovery" and the
 * SheetJS-only behavior is kept. Recovery never overwrites a cell SheetJS
 * already parsed — it only fills gaps.
 */

export interface ZipLike {
  [path: string]: Uint8Array;
}

/** Minimal XML entity unescape for element text / attribute values. */
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

/**
 * Map workbook sheet names to worksheet part paths via xl/workbook.xml and
 * xl/_rels/workbook.xml.rels. (Same approach as pageBreaksXml.ts.)
 */
export function sheetPartPaths(files: ZipLike): Map<string, string> {
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
      // Targets are relative to xl/ ("worksheets/sheet1.xml"), but
      // some producers emit absolute part URIs ("/xl/worksheets/
      // sheet1.xml") — normalize both to the package path.
      const t = target.replace(/^\/+/, '');
      targetByRid.set(id, t.startsWith('xl/') ? t : `xl/${t}`);
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

export interface RecoveredFormulas {
  /** ref (e.g. "H11") -> formula text WITHOUT leading '='. */
  formulas: Map<string, string>;
  /** 0-based inclusive max row/col seen across <dimension> and all <c r>. */
  maxRow: number;
  maxCol: number;
}

/** Decode an A1 ref like "BC23" into 0-based {r, c}; null when malformed. */
export function decodeRef(ref: string): { r: number; c: number } | null {
  const m = /^([A-Za-z]{1,3})(\d+)$/.exec(ref.trim());
  if (!m) return null;
  const letters = (m[1] as string).toUpperCase();
  let c = 0;
  for (const ch of letters) c = c * 26 + (ch.charCodeAt(0) - 64);
  c -= 1;
  const r = parseInt(m[2] as string, 10) - 1;
  if (c < 0 || c > 16383 || r < 0 || r > 1048575) return null;
  return { r, c };
}

function colToLetters(c1: number): string {
  // c1 is 1-based.
  let s = '';
  let c = c1;
  while (c > 0) {
    const m = (c - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    c = Math.floor((c - 1) / 26);
  }
  return s;
}

// Sticky matcher for an A1 cell reference, optionally sheet-qualified
// (including 3D `Sheet1:Sheet3!A1`). Groups: 1: sheet name, 2: second sheet
// name (3D), 3: col '$', 4: col letters, 5: row '$', 6: row digits.
const A1_REF =
  /(?:('(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)(?::('(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*))?\s*!)?(\$?)([A-Za-z]{1,3})(\$?)(\d+)/y;

/**
 * Shift every relative reference in a master shared-formula's text by
 * (dRow, dCol) to produce the slave's formula. Absolute axes (`$`) do not
 * move; a reference shifted out of the grid becomes `#REF!` (Excel behavior).
 * String literals are copied verbatim; matches that are really function
 * names (followed by `(`), defined names glued to identifiers, or `#REF!`
 * are left alone.
 */
export function translateSharedFormula(formula: string, dRow: number, dCol: number): string {
  if (dRow === 0 && dCol === 0) return formula;
  let out = '';
  let i = 0;
  const n = formula.length;
  while (i < n) {
    const ch = formula[i] as string;
    // String literal: copy verbatim ("" is an escaped quote).
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (formula[j] === '"') {
          if (formula[j + 1] === '"') {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      out += formula.slice(i, j);
      i = j;
      continue;
    }
    A1_REF.lastIndex = i;
    const m = A1_REF.exec(formula);
    if (m) {
      const prev = i > 0 ? (formula[i - 1] as string) : '';
      const next = formula[A1_REF.lastIndex] as string | undefined;
      const glued = /[A-Za-z0-9_.$)]/.test(prev) || next === '(';
      if (glued) {
        // Not a standalone reference (e.g. LOG10(, X.A1) — copy one char.
        out += ch;
        i += 1;
        continue;
      }
      const sheet1 = m[1] as string | undefined;
      const sheet2 = m[2] as string | undefined;
      const sheetPart = sheet1 ? `${sheet1}${sheet2 ? `:${sheet2}` : ''}!` : '';
      const colAbs = (m[3] as string) === '$';
      const rowAbs = (m[5] as string) === '$';
      const colLetters = (m[4] as string).toUpperCase();
      let c = 0;
      for (const l of colLetters) c = c * 26 + (l.charCodeAt(0) - 64);
      const r = parseInt(m[6] as string, 10);
      const nc = colAbs ? c : c + dCol;
      const nr = rowAbs ? r : r + dRow;
      if (nc < 1 || nc > 16384 || nr < 1 || nr > 1048576) {
        out += '#REF!';
      } else {
        out += `${sheetPart}${colAbs ? '$' : ''}${colToLetters(nc)}${rowAbs ? '$' : ''}${nr}`;
      }
      i = A1_REF.lastIndex;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

interface MasterFormula {
  row: number;
  col: number;
  text: string;
}

/**
 * Recover dropped formulas + true used range from one worksheet's XML.
 * `hasCell(ref)` reports whether the adapter already produced a non-empty
 * value for the ref — recovered formulas only fill gaps, never overwrite.
 */
export function recoverSheetFormulas(
  sheetXml: string,
  hasCell: (ref: string) => boolean,
): RecoveredFormulas {
  const formulas = new Map<string, string>();
  let maxRow = -1;
  let maxCol = -1;

  const dim = /<dimension\b[^>]*\bref\s*=\s*"([^"]*)"/.exec(sheetXml);
  if (dim) {
    const parts = (dim[1] as string).split(':');
    for (const p of parts) {
      const rc = decodeRef(p);
      if (rc) {
        if (rc.r > maxRow) maxRow = rc.r;
        if (rc.c > maxCol) maxCol = rc.c;
      }
    }
  }

  // First pass: collect shared-formula masters (si -> master cell + text).
  // Cells are matched open-tag by open-tag; self-closing <c/> cells are
  // empty and skipped, and paired cells slice exactly to their own </c> so
  // matches can never span across elements.
  const masters = new Map<string, MasterFormula>();
  const cellOpenRe = /<c\b((?:"[^"]*"|[^">])*)>/g;
  interface PendingSlave {
    ref: string;
    si: string;
  }
  const slaves: PendingSlave[] = [];
  const withFormula: Array<{ ref: string; text: string }> = [];

  let cm: RegExpExecArray | null;
  while ((cm = cellOpenRe.exec(sheetXml)) !== null) {
    const attrPart = cm[1] as string;
    let body = '';
    if (/\/\s*$/.test(attrPart)) continue; // self-closing <c/>: empty cell
    const closeIdx = sheetXml.indexOf('</c>', cellOpenRe.lastIndex);
    if (closeIdx === -1) continue;
    body = sheetXml.slice(cellOpenRe.lastIndex, closeIdx);
    cellOpenRe.lastIndex = closeIdx + 4;
    const ref = attr(attrPart, 'r');
    if (!ref) continue;
    const rc = decodeRef(ref);
    if (rc) {
      if (rc.r > maxRow) maxRow = rc.r;
      if (rc.c > maxCol) maxCol = rc.c;
    }
    const alreadyHas = hasCell(ref);
    // <f>...</f> with text, or self-closing <f .../> (shared slaves).
    let fAttrs: string | null = null;
    let fText = '';
    const fOpen = /<f\b((?:"[^"]*"|[^">])*)>/.exec(body);
    if (fOpen) {
      const fAttrPart = fOpen[1] as string;
      if (!/\/\s*$/.test(fAttrPart)) {
        const fClose = body.indexOf('</f>', fOpen.index + fOpen[0].length);
        if (fClose !== -1) {
          fAttrs = fAttrPart;
          fText = unescapeXml(body.slice(fOpen.index + fOpen[0].length, fClose).trim());
        }
      } else {
        fAttrs = fAttrPart; // self-closing <f/>: no text
      }
    }
    if (fAttrs === null) continue;
    const fType = attr(fAttrs, 't') ?? '';
    const si = attr(fAttrs, 'si');
    // Always collect shared-formula masters, even when SheetJS already
    // parsed the cell: slaves (which SheetJS drops) need the master text.
    // (With cellStyles:true, SheetJS parses masters but leaves slaves as
    // stubs, so skipping masters here would orphan the slaves.)
    if (fText !== '' && fType === 'shared' && si !== null && rc && !masters.has(si)) {
      masters.set(si, { row: rc.r, col: rc.c, text: fText });
    }
    if (alreadyHas) continue; // SheetJS already parsed this cell: keep it.
    if (fText !== '') {
      withFormula.push({ ref, text: fText });
    } else if (fType === 'shared' && si !== null) {
      // Shared slave (self-closing or empty <f>): resolve from the master.
      slaves.push({ ref, si });
    }
    // Other empty <f> (e.g. dataTable with cached <v> handled by SheetJS):
    // nothing to recover.
  }

  for (const { ref, text } of withFormula) formulas.set(ref, text);
  for (const { ref, si } of slaves) {
    const master = masters.get(si);
    const rc = decodeRef(ref);
    if (!master || !rc || formulas.has(ref)) continue;
    formulas.set(ref, translateSharedFormula(master.text, rc.r - master.row, rc.c - master.col));
  }
  return { formulas, maxRow, maxCol };
}
