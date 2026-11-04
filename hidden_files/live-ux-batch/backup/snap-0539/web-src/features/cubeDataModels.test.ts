/**
 * Headless tests for the web app's OLAP data-model cube wiring
 * (features/cubeDataModels.ts), mirroring what App.tsx's open flow does:
 * adapter.read -> registerDataModelCubes -> workbookFromData -> evaluate.
 *
 * Fixture: test-data/real-world/closedxml-Cubes-CubeFromRange-Input.xlsx
 * (ClosedXML CubeFromRange). The Cube sheet's CUBEVALUE/CUBEMEMBER
 * formulas reference the "ThisWorkbookDataModel" connection; the
 * expected values are Excel's cached <v> values:
 *
 *   Baclava: Price=14 Amount=3 | Cake: Price=7 Amount=27
 *   Pie: Price=12 Amount=35   | Grand total: Price=33 Amount=65
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearCubes,
  listCubes,
  unregisterCube,
  type CellRef,
  type WorkbookData,
} from '@icecream-sheets/engine';
import { XlsxAdapter } from '@icecream-sheets/xlsx-adapter';
import { workbookFromData } from '../io';
import {
  buildCubeFromRange,
  connectionsFromMetadata,
  cubeConnectionNamesFromSheets,
  dimensionHintsFromSheets,
  parseConnectionRangeRef,
  registerDataModelCubes,
} from '@icecream-sheets/service';
import { CONNECTIONS_METADATA_KEY } from '@icecream-sheets/xlsx-adapter';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL = join(HERE, '..', '..', '..', '..', 'test-data', 'real-world');
const FILE = 'closedxml-Cubes-CubeFromRange-Input.xlsx';

function loadData(): WorkbookData {
  const bytes = new Uint8Array(readFileSync(join(REAL, FILE)));
  return new XlsxAdapter().read(bytes);
}

const c = (sheet: string, row: number, col: number): CellRef => ({ sheet, row, col });

function num(data: WorkbookData, sheet: string, row: number, col: number): number {
  const wb = workbookFromData(data);
  const v = wb.getValue(c(sheet, row, col)) as { kind: string; value?: unknown };
  expect(v.kind, `${sheet}!${row},${col}`).toBe('number');
  return v.value as number;
}

function text(data: WorkbookData, sheet: string, row: number, col: number): string {
  const wb = workbookFromData(data);
  const v = wb.getValue(c(sheet, row, col)) as { kind: string; value?: unknown };
  expect(v.kind, `${sheet}!${row},${col}`).toBe('string');
  return v.value as string;
}

describe('cube data-model wiring (web open flow)', () => {
  beforeEach(() => {
    clearCubes();
  });

  it('finds the CUBE connection name in the workbook formulas', () => {
    const data = loadData();
    expect(cubeConnectionNamesFromSheets(data.sheets)).toEqual([
      'ThisWorkbookDataModel',
    ]);
  });

  it('reads dimension hints from the MDX member expressions', () => {
    const data = loadData();
    const hints = dimensionHintsFromSheets(data.sheets);
    expect(hints).toEqual([{ dim: 'Range', hier: 'Pastry' }]);
  });

  it('parses the source range ref', () => {
    expect(parseConnectionRangeRef('Data!$A$1:$C$4')).toEqual({
      sheet: 'Data',
      startRow: 0,
      startCol: 0,
      endRow: 3,
      endCol: 2,
    });
    expect(parseConnectionRangeRef("'My Sheet'!$B$2:$D$10")?.sheet).toBe('My Sheet');
    expect(parseConnectionRangeRef('bogus')).toBeNull();
  });

  it('registers the cube and resolves every CUBEVALUE (Excel cached values)', () => {
    const data = loadData();
    const registered = registerDataModelCubes(data);
    expect(registered).toEqual(['ThisWorkbookDataModel']);
    expect(listCubes()).toContain('ThisWorkbookDataModel');

    expect(num(data, 'Cube', 3, 1)).toBe(14); // Baclava / Price
    expect(num(data, 'Cube', 3, 2)).toBe(3); // Baclava / Amount
    expect(num(data, 'Cube', 4, 1)).toBe(7); // Cake / Price
    expect(num(data, 'Cube', 4, 2)).toBe(27); // Cake / Amount
    expect(num(data, 'Cube', 5, 1)).toBe(12); // Pie / Price
    expect(num(data, 'Cube', 5, 2)).toBe(35); // Pie / Amount
    expect(num(data, 'Cube', 6, 1)).toBe(33); // Grand total / Price
    expect(num(data, 'Cube', 6, 2)).toBe(65); // Grand total / Amount
  });

  it('resolves the CUBEMEMBER canonical member expressions', () => {
    const data = loadData();
    registerDataModelCubes(data);
    expect(text(data, 'Cube', 2, 1)).toBe('[Measures].[Sum of Price]');
    expect(text(data, 'Cube', 2, 2)).toBe('[Measures].[Sum of Amount]');
    expect(text(data, 'Cube', 3, 0)).toBe('[Range].[Baclava]');
    expect(text(data, 'Cube', 6, 0)).toBe('[Range].[All]');
  });

  it('is idempotent: already-registered connections are skipped', () => {
    const data = loadData();
    expect(registerDataModelCubes(data)).toEqual(['ThisWorkbookDataModel']);
    // Second call: the connection is already registered -> nothing new.
    expect(registerDataModelCubes(data)).toEqual([]);
    expect(num(data, 'Cube', 3, 1)).toBe(14);
  });

  it('registers before the workbook is built (App.tsx open order)', () => {
    // openXlsxBuffer registers the cubes BEFORE workbookFromData: the
    // engine caches evaluated cells, so a cube registered after the first
    // read would leave the errors stuck.
    const data = loadData();
    const registered = registerDataModelCubes(data);
    expect(registered).toEqual(['ThisWorkbookDataModel']);
    const wb = workbookFromData(data);
    const v = wb.getValue(c('Cube', 3, 1)) as { kind: string; value?: unknown };
    expect(v.kind).toBe('number');
    expect(v.value).toBe(14);
  });

  it('unregistering restores the unregistered-connection error (open cleanup)', () => {
    const data = loadData();
    const registered = registerDataModelCubes(data);
    for (const key of registered) unregisterCube(key);
    const wb = workbookFromData(data);
    const v = wb.getValue(c('Cube', 3, 1)) as { kind: string; code?: string };
    expect(v.kind).toBe('error');
    expect(v.code).toBe('#N/A');
  });

  it('does nothing when the workbook has no connections metadata', () => {
    const data = loadData();
    delete data.metadata[CONNECTIONS_METADATA_KEY];
    expect(registerDataModelCubes(data)).toEqual([]);
    expect(listCubes()).toEqual([]);
  });

  it('buildCubeFromRange returns null for an unresolvable range', () => {
    const data = loadData();
    expect(buildCubeFromRange(data.sheets, 'Nope!$A$1:$C$4', 'X')).toBeNull();
    expect(buildCubeFromRange(data.sheets, 'bogus', 'X')).toBeNull();
  });

  it('connectionsFromMetadata rejects corrupt metadata without throwing', () => {
    expect(connectionsFromMetadata(undefined)).toEqual([]);
    expect(connectionsFromMetadata('not json')).toEqual([]);
    expect(connectionsFromMetadata(JSON.stringify([{ nope: 1 }]))).toEqual([]);
  });
});
