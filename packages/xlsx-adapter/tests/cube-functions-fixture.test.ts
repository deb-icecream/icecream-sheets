/**
 * End-to-end OLAP cube test on the ClosedXML fixture
 * test-data/real-world/closedxml-Cubes-CubeFromRange-Input.xlsx.
 *
 * The file's "Data" sheet holds a pastry sales range; its "Cube" sheet holds
 * CUBEMEMBER / CUBEVALUE formulas against the "ThisWorkbookDataModel"
 * connection (a data model built from that range). The test loads the file
 * through the XLSX adapter, builds the cube from the source range via
 * cubeFromPivot(), registers it under the connection name, evaluates the
 * sheet in the engine, and checks every CUBEVALUE result against Excel's
 * cached <v> values from the raw OOXML:
 *
 *   Baclava: Price=14 Amount=3 | Cake: Price=7 Amount=27
 *   Pie: Price=12 Amount=35   | Grand total: Price=33 Amount=65
 *
 * This exercises the fixture-specific MDX forms: measures inside CUBEMEMBER
 * ("[Measures].[Sum of Price]"), the key form ("[Range].[Pastry].&[Baclava]"),
 * the All member ("[Range].[Pastry].[All]"), the caption argument, and
 * chained CUBEVALUE("conn",$A4,B$3) references.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EngineWorkbook,
  registerCube,
  clearCubes,
  cubeFromPivot,
  type CellRef,
} from '@icecream-sheets/engine';
import { XlsxAdapter } from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL = join(HERE, '..', '..', '..', 'test-data', 'real-world');
const FILE = 'closedxml-Cubes-CubeFromRange-Input.xlsx';
const CONNECTION = 'ThisWorkbookDataModel';

const c = (sheet: string, row: number, col: number): CellRef => ({ sheet, row, col });

function loadWorkbook(): EngineWorkbook {
  const bytes = new Uint8Array(readFileSync(join(REAL, FILE)));
  const data = new XlsxAdapter().read(bytes);
  const dataSheet = data.sheets.find((s) => s.name === 'Data');
  const cubeSheet = data.sheets.find((s) => s.name === 'Cube');
  if (!dataSheet || !cubeSheet) throw new Error('fixture sheets "Data"/"Cube" missing');

  // Build the OLAP cube from the source range (header + body rows).
  const body = dataSheet.rows
    .slice(1)
    .filter((r) => r[0] !== null && r[0] !== undefined && r[0] !== '');
  const prices = body.map((r) => Number(r[1]));
  const amounts = body.map((r) => Number(r[2]));
  const cube = cubeFromPivot(
    {
      rowFieldNames: ['Range'],
      colFieldNames: [],
      valueLabels: ['Sum of Price', 'Sum of Amount'],
      rowKeys: body.map((r) => [String(r[0])]),
      colKeys: [],
      data: body.map((r) => [[Number(r[1]), Number(r[2])]]),
      rowTotals: body.map((r) => [Number(r[1]), Number(r[2])]),
      colTotals: [],
      grandTotals: [
        prices.reduce((a, b) => a + b, 0),
        amounts.reduce((a, b) => a + b, 0),
      ],
    },
    CONNECTION,
  );
  registerCube(cube);

  const initial: Record<string, unknown[][]> = {};
  for (const s of data.sheets) initial[s.name] = s.rows.map((r) => [...r]);
  return new EngineWorkbook(initial as never);
}

function num(wb: EngineWorkbook, sheet: string, row: number, col: number): number {
  const v = wb.getValue(c(sheet, row, col)) as { kind: string; value?: unknown };
  expect(v.kind, `${sheet}!${row},${col}`).toBe('number');
  return v.value as number;
}

function text(wb: EngineWorkbook, sheet: string, row: number, col: number): string {
  const v = wb.getValue(c(sheet, row, col)) as { kind: string; value?: unknown };
  expect(v.kind, `${sheet}!${row},${col}`).toBe('string');
  return v.value as string;
}

/** Load the workbook rows without registering any cube (degradation probe). */
function loadWorkbookNoCube(): EngineWorkbook {
  const bytes = new Uint8Array(readFileSync(join(REAL, FILE)));
  const data = new XlsxAdapter().read(bytes);
  const initial: Record<string, unknown[][]> = {};
  for (const s of data.sheets) initial[s.name] = s.rows.map((r) => [...r]);
  return new EngineWorkbook(initial as never);
}

describe('ClosedXML cube fixture (adapter + engine)', () => {
  let wb: EngineWorkbook;
  beforeEach(() => {
    clearCubes();
    wb = loadWorkbook();
  });

  it('CUBEVALUE resolves every member cell (Excel cached values)', () => {
    // Rows are 0-indexed: B4:C7 -> rows 3..6, cols 1..2.
    expect(num(wb, 'Cube', 3, 1)).toBe(14); // Baclava / Price
    expect(num(wb, 'Cube', 3, 2)).toBe(3); // Baclava / Amount
    expect(num(wb, 'Cube', 4, 1)).toBe(7); // Cake / Price
    expect(num(wb, 'Cube', 4, 2)).toBe(27); // Cake / Amount
    expect(num(wb, 'Cube', 5, 1)).toBe(12); // Pie / Price
    expect(num(wb, 'Cube', 5, 2)).toBe(35); // Pie / Amount
    expect(num(wb, 'Cube', 6, 1)).toBe(33); // Grand total / Price
    expect(num(wb, 'Cube', 6, 2)).toBe(65); // Grand total / Amount
  });

  it('CUBEMEMBER returns canonical member expressions', () => {
    expect(text(wb, 'Cube', 2, 1)).toBe('[Measures].[Sum of Price]');
    expect(text(wb, 'Cube', 2, 2)).toBe('[Measures].[Sum of Amount]');
    expect(text(wb, 'Cube', 3, 0)).toBe('[Range].[Baclava]');
    expect(text(wb, 'Cube', 4, 0)).toBe('[Range].[Cake]');
    expect(text(wb, 'Cube', 5, 0)).toBe('[Range].[Pie]');
    // "[Range].[Pastry].[All]" with the "Grand Total" caption argument: the
    // value stays the canonical member so CUBEVALUE($A7, ...) resolves.
    expect(text(wb, 'Cube', 6, 0)).toBe('[Range].[All]');
  });

  it('without a registered cube the formulas degrade to #N/A, not a crash', () => {
    clearCubes();
    const wb2 = loadWorkbookNoCube();
    const v = wb2.getValue(c('Cube', 3, 1)) as { kind: string; code?: string };
    expect(v.kind).toBe('error');
    expect(v.code).toBe('#N/A');
  });
});
