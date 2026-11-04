/**
 * BIFF12 part builders/parsers for the .xlsb adapter.
 *
 * Parts: xl/workbook.bin (sheet directory), xl/sharedStrings.bin (SST),
 * xl/worksheets/sheetN.bin (cell data), xl/styles.bin (number formats).
 *
 * Empirical notes (see biff12.ts):
 * - String cells are record 0x0007 with a u32 SST index (what Excel writes;
 *   pyxlsb-verified). Record 0x0006 is read leniently as an SST index too.
 * - BrtBundleSh sheet entries are iTabId(u32) + sheetId(u32) + relId + name.
 * - Cell records carry col/style/value; the row comes from BrtRowHdr.
 */

import { RT, Reader, Writer, record, parseRecords, decodeRk, errorText, errorCode } from './biff12.js';
import { compileFormula, decompileFormula, XlsbFormulaError } from './ptg.js';

// ---------------------------------------------------------------------------
// Shared value model
// ---------------------------------------------------------------------------

export type CachedValue =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'err'; value: string };

export type WsCellValue =
  | { kind: 'blank' }
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'err'; value: string }
  | { kind: 'fmla'; formula: string; cached: CachedValue };

export interface WsCell {
  row: number;
  col: number;
  style: number;
  value: WsCellValue;
}

export interface WsDim { r1: number; c1: number; r2: number; c2: number; }

// ---------------------------------------------------------------------------
// Workbook part
// ---------------------------------------------------------------------------

export function buildWorkbook(sheetNames: string[]): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(record(RT.BeginBook, new Uint8Array(0)));
  const shs = new Writer();
  const shsPayload = shs.build();
  void shsPayload;
  parts.push(record(RT.BeginBundleShs, new Uint8Array(0)));
  sheetNames.forEach((name, i) => {
    const w = new Writer();
    w.u32(i + 1); // iTabId
    w.u32(i + 1); // sheet id (mirrors pyxlsb's observed layout)
    w.str(`rId${i + 1}`);
    w.str(name);
    parts.push(record(RT.BundleSh, w.build()));
  });
  parts.push(record(RT.EndBundleShs, new Uint8Array(0)));
  parts.push(record(RT.EndBook, new Uint8Array(0)));
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export interface ParsedSheet { name: string; relId: string; }

export function parseWorkbook(buf: Uint8Array): ParsedSheet[] {
  const sheets: ParsedSheet[] = [];
  for (const rec of parseRecords(buf)) {
    if (rec.type === RT.BundleSh) {
      const r = new Reader(rec.payload);
      r.skip(4); // iTabId
      r.skip(4); // sheet id (see empirical note above)
      const relId = r.str();
      const name = r.str();
      sheets.push({ name, relId });
    }
  }
  return sheets;
}

// ---------------------------------------------------------------------------
// Shared strings part
// ---------------------------------------------------------------------------

export function buildSst(strings: string[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const begin = new Writer().u32(strings.length).u32(strings.length).build();
  parts.push(record(RT.BeginSst, begin));
  for (const s of strings) {
    const w = new Writer();
    // flags: 0x00 = plain string (no rich-text runs, no extended data).
    // 0x01 would mean "rich text follows" and misalign strict readers.
    w.u8(0x00);
    w.str(s);
    parts.push(record(RT.SstItem, w.build()));
  }
  parts.push(record(RT.EndSst, new Uint8Array(0)));
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function parseSst(buf: Uint8Array): string[] {
  const strings: string[] = [];
  for (const rec of parseRecords(buf)) {
    if (rec.type === RT.SstItem) {
      const r = new Reader(rec.payload);
      r.skip(1); // flags
      strings.push(r.str());
    }
  }
  return strings;
}

// ---------------------------------------------------------------------------
// Worksheet part
// ---------------------------------------------------------------------------

function writeCellValue(w: Writer, cell: WsCell, sstIndex: Map<string, number>): void {
  const v = cell.value;
  switch (v.kind) {
    case 'blank':
      // Sparse: blank cells are simply not written.
      break;
    case 'num':
      w.bytes(record(RT.CellReal, new Writer().u32(cell.col).u32(cell.style).f64(v.value).build()));
      break;
    case 'str': {
      let idx = sstIndex.get(v.value);
      if (idx === undefined) throw new Error('xlsb: string missing from SST');
      w.bytes(record(RT.CellIsst, new Writer().u32(cell.col).u32(cell.style).u32(idx).build()));
      break;
    }
    case 'bool':
      w.bytes(record(RT.CellBool, new Writer().u32(cell.col).u32(cell.style).u8(v.value ? 1 : 0).build()));
      break;
    case 'err':
      w.bytes(record(RT.CellError, new Writer().u32(cell.col).u32(cell.style).u8(errorCode(v.value)).build()));
      break;
    case 'fmla': {
      const tokens = compileFormula(v.formula);
      const cw = new Writer().u32(cell.col).u32(cell.style);
      let rt: number;
      switch (v.cached.kind) {
        case 'num': rt = RT.FmlaNum; cw.f64(v.cached.value); break;
        case 'str': rt = RT.FmlaString; cw.str(v.cached.value); break;
        case 'bool': rt = RT.FmlaBool; cw.u8(v.cached.value ? 1 : 0); break;
        case 'err': rt = RT.FmlaError; cw.u8(errorCode(v.cached.value)); break;
      }
      cw.u32(tokens.length).bytes(tokens);
      w.bytes(record(rt!, cw.build()));
      break;
    }
  }
}

export function buildWorksheet(
  cells: WsCell[],
  dim: WsDim | null,
  sstIndex: Map<string, number>,
): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(record(RT.BeginSheet, new Uint8Array(0)));
  if (dim) {
    // BrtWsDim field order is Ref8: rwFirst, rwLast, colFirst, colLast
    // (verified against pyxlsb's DimensionHandler).
    parts.push(record(RT.WsDim, new Writer().u32(dim.r1).u32(dim.r2).u32(dim.c1).u32(dim.c2).build()));
  }
  parts.push(record(RT.BeginSheetData, new Uint8Array(0)));
  // Group cells by row. String indexes come from the workbook-global SST map
  // (callers must intern every referenced string first via collectStrings).
  const byRow = new Map<number, WsCell[]>();
  for (const c of cells) {
    if (c.value.kind === 'blank') continue;
    const arr = byRow.get(c.row);
    if (arr) arr.push(c);
    else byRow.set(c.row, [c]);
  }
  const rows = [...byRow.keys()].sort((a, b) => a - b);
  for (const row of rows) {
    parts.push(record(RT.RowHdr, new Writer().u32(row).build()));
    const w = new Writer();
    const rowCells = byRow.get(row)!.sort((a, b) => a.col - b.col);
    for (const cell of rowCells) writeCellValue(w, cell, sstIndex);
    parts.push(w.build());
  }
  parts.push(record(RT.EndSheetData, new Uint8Array(0)));
  parts.push(record(RT.EndSheet, new Uint8Array(0)));
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Strings referenced by a worksheet's cells (for building the SST first). */
export function collectStrings(cells: WsCell[]): string[] {
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (const c of cells) {
    const v = c.value;
    const s = v.kind === 'str' ? v.value : v.kind === 'fmla' && v.cached.kind === 'str' ? v.cached.value : null;
    if (s !== null && !seen.has(s)) {
      seen.set(s, out.length);
      out.push(s);
    }
  }
  return out;
}

export function parseWorksheet(buf: Uint8Array, sst: string[]): { dim: WsDim | null; cells: WsCell[] } {
  let dim: WsDim | null = null;
  const cells: WsCell[] = [];
  let row = -1;
  for (const rec of parseRecords(buf)) {
    const r = new Reader(rec.payload);
    switch (rec.type) {
      case RT.WsDim: {
        // Ref8 order: rwFirst, rwLast, colFirst, colLast.
        const r1 = r.u32(); const r2 = r.u32(); const c1 = r.u32(); const c2 = r.u32();
        dim = { r1, c1, r2, c2 };
        break;
      }
      case RT.RowHdr:
        row = r.u32();
        break;
      case RT.CellBlank:
        cells.push({ row, col: r.u32(), style: r.u32(), value: { kind: 'blank' } });
        break;
      case RT.CellRk: {
        const col = r.u32();
        const style = r.u32();
        cells.push({ row, col, style, value: { kind: 'num', value: decodeRk(r.u32()) } });
        break;
      }
      case RT.CellReal: {
        const col = r.u32();
        const style = r.u32();
        cells.push({ row, col, style, value: { kind: 'num', value: r.f64() } });
        break;
      }
      case RT.CellBool: {
        const col = r.u32();
        const style = r.u32();
        cells.push({ row, col, style, value: { kind: 'bool', value: r.u8() !== 0 } });
        break;
      }
      case RT.CellError: {
        const col = r.u32();
        const style = r.u32();
        cells.push({ row, col, style, value: { kind: 'err', value: errorText(r.u8()) } });
        break;
      }
      case RT.CellIsst: {
        // 0x0007: shared-string table index (what Excel writes).
        const col = r.u32();
        const style = r.u32();
        const idx = r.u32();
        if (idx < 0 || idx >= sst.length) {
          throw new Error(`xlsb: SST index ${idx} out of range (${sst.length} strings)`);
        }
        cells.push({ row, col, style, value: { kind: 'str', value: sst[idx] } });
        break;
      }
      case RT.CellSt: {
        // 0x0006: inline string (cch + UTF-16LE), preserved as a string value.
        const col = r.u32();
        const style = r.u32();
        cells.push({ row, col, style, value: { kind: 'str', value: r.str() } });
        break;
      }
      case RT.FmlaNum:
      case RT.FmlaString:
      case RT.FmlaBool:
      case RT.FmlaError: {
        const col = r.u32();
        const style = r.u32();
        let cached: CachedValue;
        if (rec.type === RT.FmlaNum) cached = { kind: 'num', value: r.f64() };
        else if (rec.type === RT.FmlaString) cached = { kind: 'str', value: r.str() };
        else if (rec.type === RT.FmlaBool) cached = { kind: 'bool', value: r.u8() !== 0 };
        else cached = { kind: 'err', value: errorText(r.u8()) };
        const cce = r.u32();
        const tokens = new Uint8Array(cce);
        for (let i = 0; i < cce; i++) tokens[i] = r.u8();
        let formula: string;
        try {
          formula = decompileFormula(tokens);
        } catch (e) {
          throw new Error(`xlsb: cannot decompile formula at R${row + 1}C${col + 1}: ${(e as Error).message}`);
        }
        cells.push({ row, col, style, value: { kind: 'fmla', formula, cached } });
        break;
      }
      default:
        break; // ignore unknown records (tolerant reader)
    }
  }
  return { dim, cells };
}

// ---------------------------------------------------------------------------
// Styles part (minimal but structurally valid: fonts/fills/borders/xfs).
// Number formats are NOT preserved: the BrtNumFmt record ids are
// undocumented by every independent xlsb implementation checked
// (pyxlsb, pyxlsb2), so emitting them would risk file corruption.
// ---------------------------------------------------------------------------

export interface XlsbStyles {
  /** cellXfs index -> numFmtId. */
  xfNumFmts: number[];
}

export function buildStyles(styles: XlsbStyles): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(record(RT.BeginStyleSheet, new Uint8Array(0)));
  // Fonts (one default).
  parts.push(record(RT.BeginFonts, new Uint8Array(0)));
  parts.push(record(RT.Font, new Uint8Array(0)));
  parts.push(record(RT.EndFonts, new Uint8Array(0)));
  // Fills (two required: none + gray125).
  parts.push(record(RT.BeginFills, new Uint8Array(0)));
  parts.push(record(RT.Fill, new Uint8Array(0)));
  parts.push(record(RT.Fill, new Uint8Array(0)));
  parts.push(record(RT.EndFills, new Uint8Array(0)));
  // Borders (one default).
  parts.push(record(RT.BeginBorders, new Uint8Array(0)));
  parts.push(record(RT.Border, new Uint8Array(0)));
  parts.push(record(RT.EndBorders, new Uint8Array(0)));
  // cellStyleXfs (one).
  parts.push(record(RT.BeginCellStyleXfs, new Uint8Array(0)));
  parts.push(record(RT.Xf, new Writer().u32(0).u32(0).u32(0).u32(0).u32(0).build()));
  parts.push(record(RT.EndCellStyleXfs, new Uint8Array(0)));
  // cellXfs.
  parts.push(record(RT.BeginCellXfs, new Uint8Array(0)));
  const xfCount = Math.max(1, styles.xfNumFmts.length);
  for (let i = 0; i < xfCount; i++) {
    const numFmtId = styles.xfNumFmts[i] ?? 0;
    parts.push(record(RT.Xf, new Writer().u32(numFmtId).u32(0).u32(0).u32(0).u32(0).build()));
  }
  parts.push(record(RT.EndCellXfs, new Uint8Array(0)));
  // cellStyles (one "Normal").
  parts.push(record(RT.BeginCellStyles, new Uint8Array(0)));
  parts.push(record(RT.CellStyle, new Writer().u32(0).str('Normal').build()));
  parts.push(record(RT.EndCellStyles, new Uint8Array(0)));
  parts.push(record(RT.EndStyleSheet, new Uint8Array(0)));
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function parseStyles(buf: Uint8Array): XlsbStyles {
  const xfNumFmts: number[] = [];
  let inXfs = false;
  for (const rec of parseRecords(buf)) {
    if (rec.type === RT.BeginCellXfs) { inXfs = true; continue; }
    if (rec.type === RT.EndCellXfs) { inXfs = false; continue; }
    if (rec.type === RT.Xf && inXfs) {
      const r = new Reader(rec.payload);
      xfNumFmts.push(r.u32());
    }
  }
  return { xfNumFmts };
}

export { XlsbFormulaError };
