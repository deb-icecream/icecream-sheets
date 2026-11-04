import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import * as XLSX from 'xlsx';
import { EngineWorkbook, err, isError, scalar, type CellRef } from '@icecream-sheets/engine';
import { XlsxAdapter } from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const c = (sheet: string, row: number, col: number): CellRef => ({ sheet, row, col });

/**
 * Build an .xlsx buffer whose sheet carries literal error cells, the way a
 * real producer writes them: <c t="e"><v>#REF!</v></c>. SheetJS's writer
 * takes the numeric BIFF error code in v and serializes the display string.
 */
function errorWorkbookBytes(): Uint8Array {
  const wb = XLSX.utils.book_new();
  const ws: XLSX.WorkSheet = {
    A1: { t: 'e', v: 0x17 }, // #REF!
    B1: { t: 'e', v: 0x07 }, // #DIV/0!
    C1: { t: 'e', v: 0x2a }, // #N/A
    D1: { t: 'e', v: 0x1d }, // #NAME?
    E1: { t: 'e', v: 0x0f }, // #VALUE!
    F1: { t: 'e', v: 0x24 }, // #NUM!
    G1: { t: 'e', v: 0x00 }, // #NULL!
    A2: { t: 'n', v: 42 },
    B2: { t: 's', v: 'plain' },
    '!ref': 'A1:G2',
  };
  XLSX.utils.book_append_sheet(wb, ws, 'Errors');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

function sheetXml(bytes: Uint8Array): string {
  const files = unzipSync(bytes);
  return strFromU8(files['xl/worksheets/sheet1.xml']!);
}

describe('literal Excel error cells (t="e")', () => {
  it('survive import as error strings instead of blank', () => {
    const adapter = new XlsxAdapter();
    const data = adapter.read(errorWorkbookBytes());
    expect(data.sheets).toHaveLength(1);
    const rows = data.sheets[0]!.rows;
    expect(rows[0]).toEqual([
      '#REF!',
      '#DIV/0!',
      '#N/A',
      '#NAME?',
      '#VALUE!',
      '#NUM!',
      '#NULL!',
    ]);
    expect(rows[1]).toEqual([42, 'plain', null, null, null, null, null]);
  });

  it('load into the engine as real error values that display like formula errors', () => {
    const adapter = new XlsxAdapter();
    const data = adapter.read(errorWorkbookBytes());
    const grids: Record<string, (string | number | boolean | null)[][]> = {};
    for (const sheet of data.sheets) grids[sheet.name] = sheet.rows;
    const wb = new EngineWorkbook(grids);
    // Literal errors evaluate to the same error TypedValues as formula errors.
    expect(wb.getValue(c('Errors', 0, 0))).toEqual(err('#REF!'));
    expect(wb.getValue(c('Errors', 0, 1))).toEqual(err('#DIV/0!'));
    expect(wb.getValue(c('Errors', 0, 2))).toEqual(err('#N/A'));
    expect(isError(wb.getValue(c('Errors', 0, 3)))).toBe(true);
    expect(wb.getValue(c('Errors', 0, 4))).toEqual(err('#VALUE!'));
    expect(wb.getValue(c('Errors', 0, 5))).toEqual(err('#NUM!'));
    // #NULL!: the engine's locale registration adds the NULL error mapping
    // (localization.ts), so it is a real error cell too.
    expect(wb.getValue(c('Errors', 0, 6))).toEqual(err('#NULL!'));
    // Neighbors unaffected.
    expect(wb.getValue(c('Errors', 1, 0))).toEqual(scalar(42));
    expect(wb.getValue(c('Errors', 1, 1))).toEqual(scalar('plain'));
  });

  it('round-trip through write -> read as t="e" error cells', () => {
    const adapter = new XlsxAdapter();
    const data = adapter.read(errorWorkbookBytes());
    const bytes = adapter.write(data);
    // The serialized sheet XML must carry t="e" with the error literal.
    const xml = sheetXml(bytes);
    expect(xml).toContain('<c r="A1" t="e"><v>#REF!</v></c>');
    expect(xml).toContain('<c r="G1" t="e"><v>#NULL!</v></c>');
    const back = adapter.read(bytes);
    const rows = back.sheets[0]!.rows;
    expect(rows[0]).toEqual([
      '#REF!',
      '#DIV/0!',
      '#N/A',
      '#NAME?',
      '#VALUE!',
      '#NUM!',
      '#NULL!',
    ]);
  });

  it('preserves the literal #REF! cells of the real-world ClosedXML DataTableFormula file', () => {
    // Regression: the coverage sweep found literal #REF! cells here (t="e"
    // with no <f>) that used to import as blank (null).
    const file = join(
      HERE,
      '../../../test-data/real-world/closedxml-Formulas-DataTableFormula-Excel-Input.xlsx',
    );
    const buf = new Uint8Array(fs.readFileSync(file));
    const adapter = new XlsxAdapter();
    const data = adapter.read(buf);
    const expected: Record<string, string[]> = {
      '1D Row - Deleted Input': ['C3', 'C4', 'C5'],
      '1D Column - Deleted Input': ['B4', 'C4', 'D4', 'E4', 'F4'],
      '2D - Input1 Deleted': ['D4', 'E4', 'D5', 'E5', 'D6', 'E6'],
      '2D - Input2 Deleted': ['C3', 'D3', 'C4', 'D4', 'C5', 'D5'],
      '2D - Input 1&2 Deleted': ['C2', 'D2', 'C3', 'D3', 'C4', 'D4'],
    };
    const byName = new Map(data.sheets.map((s) => [s.name, s.rows]));
    let count = 0;
    for (const [sheet, refs] of Object.entries(expected)) {
      const rows = byName.get(sheet);
      expect(rows, `sheet ${sheet} present`).toBeDefined();
      for (const ref of refs) {
        const { c: col, r: row } = XLSX.utils.decode_cell(ref);
        expect(rows![row]![col], `${sheet}!${ref}`).toBe('#REF!');
        count++;
      }
    }
    expect(count).toBe(26);
  });
});
