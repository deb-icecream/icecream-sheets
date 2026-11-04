/**
 * Excel Binary Workbook (.xlsb, BIFF12) storage adapter.
 *
 * A from-scratch BIFF12 reader/writer (no SheetJS — the community edition
 * cannot parse BIFF12). Record layouts follow pyxlsb's empirically
 * validated parsing (see biff12.ts).
 *
 * Honest limitations (also in README.md):
 * - Values: numbers, strings (SST), booleans, blanks round-trip. Error
 *   cells read as null (CellInput cannot represent them).
 * - Formulas: the common subset in ptg.ts (arithmetic, comparisons,
 *   refs/areas, function calls) round-trips as text<->Ptg. Written formulas
 *   carry a placeholder cached value of 0 (like the xlsx adapter) — a
 *   conforming reader (Excel) recalculates on open. Cross-sheet refs,
 *   defined names, and functions outside the Ftab subset throw a clear
 *   XlsbFormulaError on write instead of being silently dropped.
 * - Styles: styles.bin is parsed tolerantly and written as a valid minimal
 *   part, but number formats are NOT preserved (the BrtNumFmt record ids
 *   are undocumented by every independent xlsb implementation, so they are
 *   not emitted). Per-cell fonts/fills are structurally preserved but not
 *   surfaced (CellInput has no style slot — same as the xlsx adapter).
 * - Charts, images, pivot tables, merged cells, and VBA are not supported.
 * - `preservesUnknownParts` is false: the package is rebuilt from the
 *   parsed model on write.
 */
import { unzipSync, zipSync } from 'fflate';
import type {
  AdapterCapabilities,
  CellInput,
  SheetData,
  StorageAdapter,
  WorkbookData,
} from '@icecream-sheets/engine';
import {
  buildSst,
  buildStyles,
  buildWorkbook,
  buildWorksheet,
  collectStrings,
  parseSst,
  parseStyles,
  parseWorkbook,
  parseWorksheet,
  type CachedValue,
  type WsCell,
  type WsCellValue,
  type WsDim,
} from './records.js';
import { XlsbFormulaError } from './ptg.js';

export { XlsbFormulaError };

const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const SHEET_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';

function contentTypes(sheetCount: number): string {
  const overrides = [
    '<Override PartName="/xl/workbook.bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/>',
    '<Override PartName="/xl/sharedStrings.bin" ContentType="application/vnd.ms-excel.sharedStrings"/>',
    '<Override PartName="/xl/styles.bin" ContentType="application/vnd.ms-excel.styles"/>',
  ];
  for (let i = 1; i <= sheetCount; i++) {
    overrides.push(
      `<Override PartName="/xl/worksheets/sheet${i}.bin" ContentType="application/vnd.ms-excel.worksheet"/>`,
    );
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
    overrides.join('\n') +
    '\n</Types>'
  );
}

function packageRels(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<Relationships xmlns="${RELS_NS}">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.bin"/>' +
    '</Relationships>'
  );
}

function workbookRels(sheetCount: number): string {
  const rels = [];
  for (let i = 1; i <= sheetCount; i++) {
    rels.push(`<Relationship Id="rId${i}" Type="${SHEET_REL}" Target="worksheets/sheet${i}.bin"/>`);
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<Relationships xmlns="${RELS_NS}">` +
    rels.join('') +
    '</Relationships>'
  );
}

/** Parse <Relationship> entries from a .rels XML part (regex-based, no DOM). */
function parseRels(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /<Relationship\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const tag = m[0];
    const id = /Id="([^"]*)"/.exec(tag)?.[1];
    const target = /Target="([^"]*)"/.exec(tag)?.[1];
    if (id && target) map.set(id, target);
  }
  return map;
}

const te = new TextEncoder();
const td = new TextDecoder('utf-8');

function cellInputToWs(row: number, col: number, input: CellInput): WsCell | null {
  if (input === null) return null;
  let value: WsCellValue;
  if (typeof input === 'string' && input.startsWith('=')) {
    const formula = input.slice(1);
    // Placeholder cached value (recalculated by Excel on open); the
    // formula text is what round-trips.
    const cached: CachedValue = { kind: 'num', value: 0 };
    value = { kind: 'fmla', formula, cached };
  } else if (typeof input === 'number') {
    value = { kind: 'num', value: input };
  } else if (typeof input === 'boolean') {
    value = { kind: 'bool', value: input };
  } else if (typeof input === 'string') {
    value = { kind: 'str', value: input };
  } else {
    return null;
  }
  return { row, col, style: 0, value };
}

function wsToCellInput(value: WsCellValue): CellInput {
  switch (value.kind) {
    case 'blank': return null;
    case 'num': return value.value;
    case 'str': return value.value;
    case 'bool': return value.value;
    case 'err': return null; // CellInput cannot represent errors (same as xlsx adapter)
    case 'fmla': return `=${value.formula}`;
  }
}

export class XlsbAdapter implements StorageAdapter {
  readonly name = 'xlsb';
  readonly capabilities: AdapterCapabilities = {
    readable: true,
    writable: true,
    transactional: false,
    preservesUnknownParts: false,
    supportsEncryption: false,
  };

  read(buffer: Uint8Array): WorkbookData {
    let zip: Record<string, Uint8Array>;
    try {
      zip = unzipSync(buffer);
    } catch (e) {
      throw new Error(`xlsb: not a zip package (${(e as Error).message})`);
    }
    const wbPart = zip['xl/workbook.bin'];
    if (!wbPart) throw new Error('xlsb: missing xl/workbook.bin');
    const sheets = parseWorkbook(wbPart);
    if (sheets.length === 0) throw new Error('xlsb: no sheets in workbook.bin');

    const relsPart = zip['xl/_rels/workbook.bin.rels'];
    const rels = relsPart ? parseRels(td.decode(relsPart)) : new Map<string, string>();

    let sst: string[] = [];
    if (zip['xl/sharedStrings.bin']) {
      sst = parseSst(zip['xl/sharedStrings.bin']);
    }

    // Parse styles.bin tolerantly (best-effort; number formats not preserved).
    if (zip['xl/styles.bin']) {
      try {
        parseStyles(zip['xl/styles.bin']);
      } catch {
        // Tolerant: styles are best-effort.
      }
    }

    const outSheets: SheetData[] = [];
    for (const sh of sheets) {
      const target = rels.get(sh.relId) ?? `worksheets/sheet${sheets.indexOf(sh) + 1}.bin`;
      const partName = target.startsWith('xl/') ? target : `xl/${target.replace(/^\//, '')}`;
      const sheetPart = zip[partName];
      if (!sheetPart) throw new Error(`xlsb: missing sheet part ${partName} (${sh.name})`);
      const { cells } = parseWorksheet(sheetPart, sst);
      // Row-major grid; sparse rows/cells padded with null.
      let maxRow = -1;
      let maxCol = -1;
      for (const c of cells) {
        if (c.value.kind === 'blank') continue;
        if (c.row > maxRow) maxRow = c.row;
        if (c.col > maxCol) maxCol = c.col;
      }
      const rows: CellInput[][] = [];
      if (maxRow >= 0) {
        const byAddr = new Map<string, CellInput>();
        for (const c of cells) {
          if (c.value.kind === 'blank') continue;
          byAddr.set(`${c.row}:${c.col}`, wsToCellInput(c.value));
        }
        for (let r = 0; r <= maxRow; r++) {
          const rowArr: CellInput[] = [];
          for (let col = 0; col <= maxCol; col++) {
            rowArr.push(byAddr.get(`${r}:${col}`) ?? null);
          }
          rows.push(rowArr);
        }
      }
      outSheets.push({ name: sh.name, rows });
    }

    const metadata: Record<string, unknown> = {};
    return { sheets: outSheets, metadata };
  }

  write(data: WorkbookData, _original?: Uint8Array): Uint8Array {
    void _original; // preservesUnknownParts is false; the package is rebuilt.
    const files: Record<string, Uint8Array> = {};
    files['[Content_Types].xml'] = te.encode(contentTypes(data.sheets.length));
    files['_rels/.rels'] = te.encode(packageRels());
    files['xl/_rels/workbook.bin.rels'] = te.encode(workbookRels(data.sheets.length));
    files['xl/workbook.bin'] = buildWorkbook(data.sheets.map((s) => s.name));

    // Per-sheet cells + shared strings.
    const sheetCells: WsCell[][] = data.sheets.map((sheet) => {
      const cells: WsCell[] = [];
      sheet.rows.forEach((rowArr, r) => {
        rowArr.forEach((input, c) => {
          const cell = cellInputToWs(r, c, input);
          if (cell) cells.push(cell);
        });
      });
      return cells;
    });
    const sst = new Map<string, number>();
    const sstList: string[] = [];
    for (const cells of sheetCells) {
      for (const s of collectStrings(cells)) {
        if (!sst.has(s)) {
          sst.set(s, sstList.length);
          sstList.push(s);
        }
      }
    }
    files['xl/sharedStrings.bin'] = buildSst(sstList);
    sheetCells.forEach((cells, i) => {
      let dim: WsDim | null = null;
      let maxRow = -1;
      let maxCol = -1;
      for (const c of cells) {
        if (c.row > maxRow) maxRow = c.row;
        if (c.col > maxCol) maxCol = c.col;
      }
      if (maxRow >= 0) dim = { r1: 0, c1: 0, r2: maxRow, c2: maxCol };
      files[`xl/worksheets/sheet${i + 1}.bin`] = buildWorksheet(cells, dim, sst);
    });

    // Minimal styles part (valid structure; number formats not preserved).
    files['xl/styles.bin'] = buildStyles({ xfNumFmts: [0] });

    return zipSync(files, { level: 6 });
  }
}
