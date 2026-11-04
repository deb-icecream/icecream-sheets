/**
 * engine-load tests (Cycle 10 — desktop engine/view separation): the
 * main-process open path parses real files with the storage adapters and
 * builds the EngineWorkbook off the renderer's UI thread. Uses the real
 * perf fixtures (test-data/perf-fixtures) — the same files the
 * responsiveness measurements run against.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adapterForFilename, buildWorkbookFromBytes } from '../src/engine-load.js';

const FIXTURES = resolve(__dirname, '../../../test-data/perf-fixtures');

function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(FIXTURES, name)));
}

describe('engine-load — adapters', () => {
  // Dynamic ESM imports (SheetJS etc.) are slow to load on this VM.
  it('resolves adapters by extension with the xlsx fallback', { timeout: 60_000 }, async () => {
    expect((await adapterForFilename('book.xlsx')).name).toBe('xlsx');
    expect((await adapterForFilename('data.csv')).name).toBe('csv');
    expect((await adapterForFilename('data.tsv')).name).toBe('tsv');
    expect((await adapterForFilename('data.ods')).name).toBe('ods');
    expect((await adapterForFilename('mystery.bin')).name).toBe('xlsx');
  });
});

describe('engine-load — buildWorkbookFromBytes', () => {
  it('parses + builds the P50 fixture in the main process and returns an IPC-safe summary', { timeout: 60_000 }, async () => {
    const { workbook, result } = await buildWorkbookFromBytes(fixtureBytes('perf-p50.xlsx'), 'perf-p50.xlsx');
    expect(result.sheets.length).toBeGreaterThan(0);
    for (const s of result.sheets) {
      expect(typeof s.name).toBe('string');
      expect(s.name.length).toBeGreaterThan(0);
    }
    expect(result.metadata).toBeTypeOf('object');
    // The built workbook holds live values in the main-process engine.
    const first = result.sheets[0]!;
    const v = workbookSnapshotHasValues(workbook.toSnapshot());
    expect(v).toBe(true);
    expect(first.name).toBe(result.sheets[0]!.name);
  });

  it('main-process snapshot carries all 38 P50 defined names (defect E1, desktop save path)', { timeout: 60_000 }, async () => {
    const { workbook, result } = await buildWorkbookFromBytes(fixtureBytes('perf-p50.xlsx'), 'perf-p50.xlsx');
    // The IPC load result carries the file's names to the renderer…
    expect(result.definedNames).toHaveLength(38);
    expect(result.definedNames).toContainEqual({ name: 'DividendsPctNI', ref: 'ASSUMPTIONS!$C$63' });
    // …and the main-process host's snapshot — exactly what the renderer's
    // ensureSaveSnapshot pulls before buildDownloadBytes serializes a
    // desktop save/autosave — carries them too. Before E1 the snapshot
    // carried NO names and the renderer's name store was never populated
    // on open, so a desktop autosave wrote 0 defined names and poisoned
    // the file with #NAME? on relaunch.
    const snap = workbook.toSnapshot();
    expect(snap.definedNames).toHaveLength(38);
    expect(snap.definedNames).toContainEqual({ name: 'DividendsPctNI', ref: 'ASSUMPTIONS!$C$63' });
    expect(snap.definedNames).toContainEqual({ name: 'NewEquityY1', ref: 'ASSUMPTIONS!$C$62' });
    // The name-referencing cells evaluate in main (no #NAME?).
    expect(workbook.getValue({ sheet: 'MONTHLY VIEW (LITE)', row: 12, col: 2 })).toEqual({
      kind: 'number',
      value: 132942.88335317458,
    });
  });

  it('rejects garbage bytes with the adapter error (no silent empty workbook)', { timeout: 30_000 }, async () => {
    const garbage = new TextEncoder().encode('this is not a spreadsheet');
    await expect(buildWorkbookFromBytes(garbage, 'nope.xlsx')).rejects.toThrow();
  });

  it('carries per-cell styles in the IPC summary (defect D4)', { timeout: 60_000 }, async () => {
    const { XlsxAdapter } = await import('@icecream-sheets/xlsx-adapter');
    const bytes = new XlsxAdapter().write({
      sheets: [
        {
          name: 'Data',
          rows: [[0.1667]],
          styles: { '0:0': { bold: true, numberFormatCode: '0.00%' } },
        },
      ],
      metadata: {},
    });
    const { result } = await buildWorkbookFromBytes(bytes, 'styled.xlsx');
    const sheet = result.sheets.find((s) => s.name === 'Data')!;
    // The renderer seeds its format store from these: without them a
    // desktop open rendered imported bold/% plain (and re-saves dropped
    // them), the open-side half of D4.
    expect(sheet.styles?.['0:0']).toEqual({ bold: true, numberFormatCode: '0.00%' });
    expect(sheet.formats?.['0:0']).toBe('0.00%');
  });

  it('carries a formula cell\'s bold + "0.00%" in the summary (defect E2, W10 R1b shape)', { timeout: 60_000 }, async () => {
    const { XlsxAdapter } = await import('@icecream-sheets/xlsx-adapter');
    // W10's evidence file shape: MONTHLY VIEW (LITE) C10 is the check
    // cell =ROUND(SUM(C9:N9)-1,4) whose true value is 0; the saved file
    // carries bold + "0.00%" on it (openpyxl-verified in R1a). The
    // packaged relaunch rendered it fw 400 / plain "0" — the summary
    // half of that path is pinned here; the renderer half (summary →
    // FormatStore, and the App.tsx notify-before-hydrate order that
    // used to wipe the seed) is pinned in apps/web
    // desktopOpenFormats.test.ts.
    const rows: unknown[][] = [];
    const row9: unknown[] = [null, null];
    for (let i = 0; i < 12; i++) row9.push(1 / 12); // C9:N9 sums to 1
    rows[8] = row9;
    rows[9] = [null, null, '=ROUND(SUM(C9:N9)-1,4)'];
    const bytes = new XlsxAdapter().write({
      sheets: [
        {
          name: 'MONTHLY VIEW (LITE)',
          rows: rows as never,
          styles: { '9:2': { bold: true, numberFormatCode: '0.00%' } },
        },
      ],
      metadata: {},
    });
    const { workbook, result } = await buildWorkbookFromBytes(bytes, 'monthly.xlsx');
    const sheet = result.sheets.find((s) => s.name === 'MONTHLY VIEW (LITE)')!;
    expect(sheet.styles?.['9:2']).toEqual({ bold: true, numberFormatCode: '0.00%' });
    expect(sheet.formats?.['9:2']).toBe('0.00%');
    // The main-process engine evaluates the check cell to exactly 0 —
    // so with the format seeded, the grid's "0.00%" is the correct
    // rendering (W10 ground-truth correction).
    const v = workbook.getValue({ sheet: 'MONTHLY VIEW (LITE)', row: 9, col: 2 });
    expect(v).toEqual({ kind: 'number', value: 0 });
  });
});

function workbookSnapshotHasValues(snap: { sheets: { cells: unknown[] }[] }): boolean {
  return snap.sheets.some((s) => s.cells.length > 0);
}
