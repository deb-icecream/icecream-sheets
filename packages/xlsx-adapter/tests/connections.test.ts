/**
 * Workbook connections (xl/connections.xml) extraction.
 *
 * Uses test-data/real-world/closedxml-Cubes-CubeFromRange-Input.xlsx:
 * its connections.xml names the "ThisWorkbookDataModel" data-model
 * connection (the CUBE* formulas' first argument) and the
 * "WorksheetConnection_Sheet1!$A$1:$C$4" range connection whose hidden
 * _xlcn.* defined name resolves to "Data!$A$1:$C$4".
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XlsxAdapter } from '../src/index.js';
import {
  CONNECTIONS_METADATA_KEY,
  readConnections,
  type ImportedConnection,
} from '../src/connections.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL = join(HERE, '..', '..', '..', 'test-data', 'real-world');
const FILE = 'closedxml-Cubes-CubeFromRange-Input.xlsx';

const bytes = (): Uint8Array => new Uint8Array(readFileSync(join(REAL, FILE)));

describe('readConnections', () => {
  it('extracts the data-model and range connections from the fixture', () => {
    const conns = readConnections(bytes());
    const model = conns.find((c) => c.name === 'ThisWorkbookDataModel');
    expect(model).toBeDefined();
    expect(model!.isDataModel).toBe(true);
    const range = conns.find((c) => c.name === 'WorksheetConnection_Sheet1!$A$1:$C$4');
    expect(range).toBeDefined();
    expect(range!.isDataModel).toBe(false);
    expect(range!.rangeRef).toBe('Data!$A$1:$C$4');
  });

  it('returns [] for a package without connections.xml', () => {
    expect(readConnections(new Uint8Array([1, 2, 3]))).toEqual([]);
  });
});

describe('XlsxAdapter.read connection metadata', () => {
  it('stashes connections under xlsx.connections', () => {
    const data = new XlsxAdapter().read(bytes());
    const raw = data.metadata[CONNECTIONS_METADATA_KEY];
    expect(typeof raw).toBe('string');
    const conns = JSON.parse(raw as string) as ImportedConnection[];
    expect(conns.some((c) => c.name === 'ThisWorkbookDataModel' && c.isDataModel)).toBe(
      true,
    );
    expect(
      conns.some((c) => c.rangeRef === 'Data!$A$1:$C$4' && !c.isDataModel),
    ).toBe(true);
  });

  it('resolves the cycle5 OLAP fixture data model to its source range', () => {
    // test-data/cycle5-fixtures/olap-cube-closedxml.xlsx: ClosedXML writes
    // <x:definedName>, so prefix-tolerant parsing is required for the range
    // connection's sourceName to resolve.
    const C5 = join(
      HERE,
      '..',
      '..',
      '..',
      'test-data',
      'cycle5-fixtures',
      'olap-cube-closedxml.xlsx',
    );
    const conns = readConnections(new Uint8Array(readFileSync(C5)));
    expect(conns.some((c) => c.name === 'ThisWorkbookDataModel' && c.isDataModel)).toBe(
      true,
    );
    const range = conns.find((c) => !c.isDataModel && c.rangeRef);
    expect(range?.rangeRef).toBe('Data!$A$1:$C$4');
  });
});
