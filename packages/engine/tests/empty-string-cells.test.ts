/**
 * Item G regression tests — literal empty-string cells must survive save.
 *
 * Round-trip audit defect D4: the engine model (HyperFormula) holds a
 * literal '' cell distinctly from a blank cell (getValue ->
 * {kind:'string', value:''} vs null), but every save readback dropped it:
 * trackCellInput deleted '' from the tracked-input map, getBulkReadback
 * and getPinnedCellState skipped '' inputs, and toSnapshot omitted them.
 * A real file lost 85 '' cells on one save (see the File-2 test below).
 *
 * Contract pinned here:
 *  - '' is a REAL literal (Excel: ISBLANK("") is FALSE). It is tracked,
 *    appears in bulk readbacks / snapshots / pinned states with its
 *    empty-string value, and round-trips through the real save path
 *    (snapshot -> XlsxAdapter.write) to an independent parse-back.
 *  - null is the ONLY "clear / no input" signal (protocol clearCell and
 *    every clear/delete caller use null, never '').
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { XlsxAdapter } from '@icecream-sheets/xlsx-adapter';
import {
  EngineHost,
  EngineWorkbook,
  scalar,
  type CellInput,
  type CellRef,
  type WorkbookData,
  type WorkbookSnapshot,
} from '../src/index.js';

const c = (sheet: string, row: number, col: number): CellRef => ({ sheet, row, col });

function find<T extends { ref: CellRef }>(rows: T[], sheet: string, row: number, col: number): T | undefined {
  return rows.find((e) => e.ref.sheet === sheet && e.ref.row === row && e.ref.col === col);
}

/** Snapshot (sparse) -> dense WorkbookData, the conversion every save host performs. */
function snapshotToWorkbookData(snap: WorkbookSnapshot): WorkbookData {
  const sheets = snap.sheets.map((sheet) => {
    let maxRow = -1;
    let maxCol = -1;
    for (const cell of sheet.cells) {
      maxRow = Math.max(maxRow, cell.ref.row);
      maxCol = Math.max(maxCol, cell.ref.col);
    }
    const rows: CellInput[][] = [];
    for (let r = 0; r <= maxRow; r++) rows.push(new Array<CellInput>(maxCol + 1).fill(null));
    for (const cell of sheet.cells) {
      const row = rows[cell.ref.row];
      if (row) row[cell.ref.col] = cell.input;
    }
    return { name: sheet.name, rows };
  });
  return { sheets, metadata: {}, definedNames: snap.definedNames };
}

/** '' addresses per sheet from dense grids, as "Sheet!A1" strings. */
function emptyStringAddresses(data: WorkbookData): string[] {
  const out: string[] = [];
  for (const sheet of data.sheets) {
    sheet.rows.forEach((row, r) => {
      row.forEach((v, col) => {
        if (v === '') out.push(`${sheet.name}!${XLSX.utils.encode_cell({ r, c: col })}`);
      });
    });
  }
  return out.sort();
}

describe('Item G: literal empty-string cells', () => {
  it('load path: ctor-stored \'\' cells appear in tracked cells, bulk readback, snapshot and pinned state; null cells do not', () => {
    const wb = new EngineWorkbook({ Sheet1: [['', 'x'], [null, 42]] });

    // The model distinction itself: '' is a string value, blank is null.
    expect(wb.getValue(c('Sheet1', 0, 0))).toEqual(scalar(''));
    expect(wb.getValue(c('Sheet1', 1, 0))).toEqual(scalar(null));
    expect(wb.getSerialized(c('Sheet1', 0, 0))).toBe('');
    expect(wb.getSerialized(c('Sheet1', 1, 0))).toBeNull();

    const tracked = wb.getTrackedCells();
    expect(find(tracked, 'Sheet1', 0, 0)?.input).toBe('');
    expect(find(tracked, 'Sheet1', 1, 0)).toBeUndefined();

    const bulk = wb.getBulkReadback();
    expect(find(bulk, 'Sheet1', 0, 0)?.input).toBe('');
    expect(find(bulk, 'Sheet1', 0, 0)?.value).toEqual(scalar(''));
    expect(find(bulk, 'Sheet1', 0, 0)?.isFormula).toBe(false);
    expect(find(bulk, 'Sheet1', 1, 0)).toBeUndefined();

    const snap = wb.toSnapshot();
    const sheet = snap.sheets.find((s) => s.name === 'Sheet1')!;
    expect(sheet.cells.find((e) => e.ref.row === 0 && e.ref.col === 0)?.input).toBe('');
    expect(sheet.cells.find((e) => e.ref.row === 1 && e.ref.col === 0)).toBeUndefined();

    expect(wb.getPinnedCellState(c('Sheet1', 0, 0))).toEqual({ input: '', value: scalar('') });
    expect(wb.getPinnedCellState(c('Sheet1', 1, 0))).toBeUndefined();
  });

  it('setCell(\'\') and setCellRaw(\'\') store a literal empty string; setCell(null) is the only clear', () => {
    const wb = new EngineWorkbook({ Sheet1: [['a', 'b']] });

    wb.setCell(c('Sheet1', 0, 1), '');
    expect(find(wb.getBulkReadback(), 'Sheet1', 0, 1)?.input).toBe('');
    expect(wb.getValue(c('Sheet1', 0, 1))).toEqual(scalar(''));

    wb.setCellRaw(c('Sheet1', 0, 0), '');
    expect(find(wb.getBulkReadback(), 'Sheet1', 0, 0)?.input).toBe('');

    // Clearing is null: the cell leaves every readback and reads as blank.
    wb.setCell(c('Sheet1', 0, 1), null);
    expect(find(wb.getBulkReadback(), 'Sheet1', 0, 1)).toBeUndefined();
    expect(wb.getValue(c('Sheet1', 0, 1))).toEqual(scalar(null));
    expect(wb.getSerialized(c('Sheet1', 0, 1))).toBeNull();
  });

  it('EngineHost bulk readback and save-pin pinned readback carry \'\' cells', () => {
    const wb = new EngineWorkbook({ Sheet1: [['', 7]] });
    const host = new EngineHost(wb);
    const bulk = host.bulkReadback();
    expect(find(bulk, 'Sheet1', 0, 0)?.input).toBe('');
    expect(find(bulk, 'Sheet1', 0, 0)?.value).toEqual(scalar(''));

    const pin = host.beginSavePin();
    // Edit the '' cell away AFTER the pin: the pinned read must still
    // freeze the pin-time '' state (pins feed the save serializer).
    host.execute({ cmd: 'setCell', ref: c('Sheet1', 0, 0), value: 'changed' });
    const pinned = host.bulkReadbackSheetPinned(pin, 'Sheet1');
    expect(find(pinned, 'Sheet1', 0, 0)?.input).toBe('');
    expect(find(pinned, 'Sheet1', 0, 0)?.value).toEqual(scalar(''));
    host.releaseSavePin(pin);
  });

  it('snapshot round-trip: fromSnapshot(toSnapshot) preserves \'\' cells', () => {
    const wb = new EngineWorkbook({ Sheet1: [['', 'x'], ['y', '']] });
    const wb2 = EngineWorkbook.fromSnapshot(wb.toSnapshot());
    const bulk = wb2.getBulkReadback();
    expect(find(bulk, 'Sheet1', 0, 0)?.input).toBe('');
    expect(find(bulk, 'Sheet1', 1, 1)?.input).toBe('');
    expect(wb2.getValue(c('Sheet1', 0, 0))).toEqual(scalar(''));
  });

  it('duplicateSheet copies \'\' cells', () => {
    const wb = new EngineWorkbook({ Sheet1: [['', 'x']] });
    const copy = wb.duplicateSheet('Sheet1');
    const bulk = wb.getBulkReadback();
    expect(find(bulk, copy, 0, 0)?.input).toBe('');
    expect(find(bulk, copy, 0, 1)?.input).toBe('x');
  });

  it('save round-trip: \'\' cells stored via the empty shared string survive load -> save -> independent parse-back', () => {
    const adapter = new XlsxAdapter();
    // Build the source file through the adapter writer: '' inputs are
    // written as empty shared-string cells ({t:'s', v:''}).
    const source: WorkbookData = {
      sheets: [
        { name: 'Data', rows: [['', 'x', ''], ['a', null, '']] },
        { name: 'Only', rows: [['']] },
      ],
      metadata: {},
      definedNames: [],
    };
    const sourceBytes = adapter.write(source);

    // Independent confirmation the source really stores '' as shared
    // strings (SheetJS raw parse, not the code under test).
    const rawSource = XLSX.read(sourceBytes, { type: 'array' });
    expect(rawSource.Sheets['Data']!['A1']).toMatchObject({ t: 's', v: '' });
    expect(rawSource.Sheets['Data']!['C2']).toMatchObject({ t: 's', v: '' });
    expect(rawSource.Sheets['Only']!['A1']).toMatchObject({ t: 's', v: '' });

    // Load: adapter parse -> engine model.
    const loaded = adapter.read(sourceBytes.slice());
    expect(emptyStringAddresses(loaded)).toEqual(['Data!A1', 'Data!C1', 'Data!C2', 'Only!A1']);
    const initial: Record<string, CellInput[][]> = {};
    for (const s of loaded.sheets) initial[s.name] = s.rows.map((r) => [...r]);
    const wb = new EngineWorkbook(initial);
    expect(wb.getBulkReadback().filter((e) => e.input === '')).toHaveLength(4);

    // Save via the real snapshot save path, then parse back independently
    // (SheetJS raw + the adapter parser — neither is the code under test).
    const savedBytes = adapter.write(snapshotToWorkbookData(wb.toSnapshot()));
    const rawSaved = XLSX.read(savedBytes, { type: 'array' });
    for (const [sheet, addr] of [['Data', 'A1'], ['Data', 'C1'], ['Data', 'C2'], ['Only', 'A1']] as const) {
      expect(rawSaved.Sheets[sheet]![addr], `${sheet}!${addr}`).toMatchObject({ t: 's', v: '' });
    }
    // The blank cell stays blank — present '' cells must not be invented.
    expect(rawSaved.Sheets['Data']!['B2']).toBeUndefined();
    const back = adapter.read(savedBytes.slice());
    expect(emptyStringAddresses(back)).toEqual(['Data!A1', 'Data!C1', 'Data!C2', 'Only!A1']);
  });

  it('File-2 regression: the audit fixture\'s 85 \'\' cells survive load -> save -> parse-back', () => {
    const adapter = new XlsxAdapter();
    const bytes = new Uint8Array(
      readFileSync('../../test-data/real-world/closedxml-TryToLoad-DrawingSizeInPx.xlsx'),
    );
    const loaded = adapter.read(bytes.slice());
    const expected = emptyStringAddresses(loaded);
    // The audit's count for this file (draw-orig.json): 85 literal ''
    // cells — Dropdown Lists 70, Data Definitions 12, AttributePTDMAP 3.
    expect(expected).toHaveLength(85);

    const initial: Record<string, CellInput[][]> = {};
    for (const s of loaded.sheets) initial[s.name] = s.rows.map((r) => [...r]);
    const wb = new EngineWorkbook(initial, { definedNames: loaded.definedNames });

    // Every '' cell is in the save readbacks (bulk + snapshot).
    expect(wb.getBulkReadback().filter((e) => e.input === '')).toHaveLength(85);
    const snap = wb.toSnapshot();
    expect(snap.sheets.flatMap((s) => s.cells).filter((e) => e.input === '')).toHaveLength(85);

    // Full save + independent parse-back: the '' address set is identical.
    const savedBytes = adapter.write(snapshotToWorkbookData(snap));
    const back = adapter.read(savedBytes.slice());
    expect(emptyStringAddresses(back)).toEqual(expected);
  }, 180_000);
});
