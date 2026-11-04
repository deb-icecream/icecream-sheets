/**
 * Tests for the storage-adapter registry wiring (track 9): the xlsx / csv /
 * tsv / ods adapters are registered in the engine's AdapterRegistry and
 * Open/Save resolve the right adapter by file extension. Includes genuine
 * open -> edit -> save round-trips through the registry path.
 */
import { describe, expect, it } from 'vitest';
import { defaultAdapters, EngineHost } from '@icecream-sheets/engine';
import { XlsxAdapter } from '@icecream-sheets/xlsx-adapter';
import { XlsbAdapter } from '@icecream-sheets/xlsb-adapter';
import { CsvAdapter, TsvAdapter } from '@icecream-sheets/csv-adapter';
import { OdsAdapter } from '@icecream-sheets/ods-adapter';
import {
  adapterForFilename,
  adapterForSaveFormat,
  registerAdapters,
  saveFormatById,
} from './adapters';
import { createHostFromWorkbookData, snapshotToWorkbookData } from './io';

describe('registerAdapters', () => {
  it('registers all six adapters (incl. the HTML download adapter) and is idempotent', () => {
    registerAdapters();
    registerAdapters(); // must not throw (duplicate registration)
    expect(defaultAdapters.names().sort()).toEqual(['csv', 'html', 'ods', 'tsv', 'xlsb', 'xlsx']);
  });

  it('resolves the HTML adapter by extension and save format', () => {
    expect(adapterForFilename('report.html').name).toBe('html');
    expect(adapterForSaveFormat('html').name).toBe('html');
    expect(saveFormatById('html').mime).toBe('text/html');
  });

  it('resolves adapters by file extension', () => {
    expect(adapterForFilename('report.xlsx')).toBeInstanceOf(XlsxAdapter);
    expect(adapterForFilename('report.xlsb')).toBeInstanceOf(XlsbAdapter);
    expect(adapterForFilename('report.csv')).toBeInstanceOf(CsvAdapter);
    expect(adapterForFilename('report.tsv')).toBeInstanceOf(TsvAdapter);
    expect(adapterForFilename('report.ods')).toBeInstanceOf(OdsAdapter);
  });

  it('is case-insensitive and falls back to xlsx for unknown extensions', () => {
    expect(adapterForFilename('DATA.CSV')).toBeInstanceOf(CsvAdapter);
    expect(adapterForFilename('weird.abc')).toBeInstanceOf(XlsxAdapter);
    expect(adapterForFilename('noextension')).toBeInstanceOf(XlsxAdapter);
  });

  it('resolves adapters by save-format id', () => {
    expect(adapterForSaveFormat('xlsx')).toBeInstanceOf(XlsxAdapter);
    expect(adapterForSaveFormat('csv')).toBeInstanceOf(CsvAdapter);
    expect(adapterForSaveFormat('tsv')).toBeInstanceOf(TsvAdapter);
    expect(adapterForSaveFormat('ods')).toBeInstanceOf(OdsAdapter);
  });
});

describe('CSV open -> edit -> save round-trip through the registry', () => {
  it('opens a CSV, edits it, saves it, and reads the values back', () => {
    const csvBytes = new TextEncoder().encode('name,score\namy,10\nbo,20\n');
    // Open.
    const openAdapter = adapterForFilename('scores.csv');
    const data = openAdapter.read(csvBytes);
    expect(data.sheets[0].name).toBe('Sheet1');
    const host = createHostFromWorkbookData(data);
    expect(host.readCell({ sheet: 'Sheet1', row: 1, col: 1 })).toEqual({ kind: 'number', value: 10 });

    // Edit through the engine.
    const res = host.execute({
      cmd: 'setCell',
      ref: { sheet: 'Sheet1', row: 1, col: 1 },
      value: 11,
    });
    expect(res.ok).toBe(true);

    // Save through the registry-resolved adapter and re-open.
    const saveAdapter = adapterForSaveFormat('csv');
    const bytes = saveAdapter.write(snapshotToWorkbookData(host.snapshot()));
    const reopened = adapterForFilename('scores.csv').read(bytes);
    const rows = reopened.sheets[0].rows;
    expect(rows[0]).toEqual(['name', 'score']);
    expect(rows[1]).toEqual(['amy', 11]);
    expect(rows[2]).toEqual(['bo', 20]);
  });
});

describe('ODS round-trip through the registry', () => {
  it('writes and reads back sheet data', () => {
    const host = new EngineHost();
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 'hello' });
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 1 }, value: 42 });
    const bytes = adapterForSaveFormat('ods').write(snapshotToWorkbookData(host.snapshot()));
    const data = adapterForFilename('doc.ods').read(bytes);
    expect(data.sheets[0].rows[0]).toEqual(['hello', 42]);
  });
});

describe('XLSX round-trip through the registry', () => {
  it('writes and reads back formulas', () => {
    const host = new EngineHost();
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 10 });
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 0 }, value: 20 });
    host.execute({ cmd: 'setFormula', ref: { sheet: 'Sheet1', row: 2, col: 0 }, formula: '=SUM(A1:A2)' });
    const bytes = adapterForSaveFormat('xlsx').write(snapshotToWorkbookData(host.snapshot()));
    const data = adapterForFilename('wb.xlsx').read(bytes);
    const rows = data.sheets[0].rows;
    expect(rows[2][0]).toBe('=SUM(A1:A2)');
    // And the engine recalculates the reopened formula.
    const host2 = createHostFromWorkbookData(data);
    expect(host2.readCell({ sheet: 'Sheet1', row: 2, col: 0 })).toEqual({ kind: 'number', value: 30 });
  });
});
