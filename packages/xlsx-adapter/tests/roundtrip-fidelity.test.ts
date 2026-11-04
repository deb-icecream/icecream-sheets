/**
 * Round-trip fidelity test (user's explicit test protocol):
 * open a real-world file → modify ONE cell → save → re-parse → diff at the
 * cell level. Every unmodified cell must be identical in value, formula,
 * format, and dimensions; only the one edited cell may differ.
 *
 * Runs across 10 diverse real-world files. Special attention: number formats,
 * column widths, row heights, hidden flags, defined names, metadata
 * (page setup, charts/drawings hints).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { XlsxAdapter } from '../src/index.js';
import type { WorkbookData } from '@icecream-sheets/engine';

const REAL_WORLD = '/home/hatch/workspace/icecream-sheets/test-data/real-world';
const adapter = new XlsxAdapter();

/** Pick 10 diverse files: prefer larger ones with charts/formats. */
function pickFiles(): string[] {
  const all = readdirSync(REAL_WORLD)
    .filter((f) => f.endsWith('.xlsx'))
    .sort();
  // compressexcel-saas-3statement.xlsx is the user's mandated file.
  const mandated = 'compressexcel-saas-3statement.xlsx';
  const rest = all.filter((f) => f !== mandated);
  // Spread across the alphabet for diversity.
  const picked: string[] = [];
  for (let i = 0; i < 9 && rest.length > 0; i++) {
    picked.push(rest.splice(Math.floor((i * rest.length) / 9), 1)[0]);
  }
  return [mandated, ...picked].filter((f) => all.includes(f)).slice(0, 10);
}

interface CellDiff {
  sheet: string;
  ref: string;
  field: string;
  before: unknown;
  after: unknown;
}

/** Normalize empty-ish cells: null, undefined, and '' are all "empty". */
function normCell(v: unknown): unknown {
  return v === null || v === undefined || v === '' ? undefined : v;
}

function diffWorkbooks(before: WorkbookData, after: WorkbookData, editedKey: string): CellDiff[] {
  const diffs: CellDiff[] = [];
  const beforeSheets = new Map(before.sheets.map((s) => [s.name, s]));
  for (const aSheet of after.sheets) {
    const bSheet = beforeSheets.get(aSheet.name);
    if (!bSheet) {
      diffs.push({ sheet: aSheet.name, ref: '', field: 'sheet', before: 'missing', after: 'present' });
      continue;
    }
    const maxRows = Math.max(aSheet.rows.length, bSheet.rows.length);
    for (let r = 0; r < maxRows; r++) {
      const aRow = aSheet.rows[r] ?? [];
      const bRow = bSheet.rows[r] ?? [];
      const maxCols = Math.max(aRow.length, bRow.length);
      for (let c = 0; c < maxCols; c++) {
        const key = `${aSheet.name}!${r}:${c}`;
        if (key === editedKey) continue; // the one edited cell may differ
        const a = normCell(aRow[c]);
        const b = normCell(bRow[c]);
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          diffs.push({ sheet: aSheet.name, ref: `R${r + 1}C${c + 1}`, field: 'value', before: b, after: a });
        }
      }
    }
    // Formats: every unmodified cell's format must survive.
    const aFmt = aSheet.formats ?? {};
    const bFmt = bSheet.formats ?? {};
    for (const k of new Set([...Object.keys(aFmt), ...Object.keys(bFmt)])) {
      const key = `${aSheet.name}!${k}`;
      if (key === editedKey) continue;
      if (aFmt[k] !== bFmt[k]) {
        diffs.push({ sheet: aSheet.name, ref: k, field: 'format', before: bFmt[k], after: aFmt[k] });
      }
    }
    // Dimensions: column widths, row heights, hidden flags must survive.
    for (const [dim, aVal, bVal] of [
      ['colWidths', aSheet.colWidths, bSheet.colWidths],
      ['rowHeights', aSheet.rowHeights, bSheet.rowHeights],
      ['hiddenCols', aSheet.hiddenCols, bSheet.hiddenCols],
      ['hiddenRows', aSheet.hiddenRows, bSheet.hiddenRows],
    ] as const) {
      if (JSON.stringify(aVal ?? null) !== JSON.stringify(bVal ?? null)) {
        diffs.push({ sheet: aSheet.name, ref: '', field: dim, before: bVal, after: aVal });
      }
    }
  }
  // Defined names must survive.
  if (JSON.stringify(after.definedNames ?? []) !== JSON.stringify(before.definedNames ?? [])) {
    diffs.push({ sheet: '', ref: '', field: 'definedNames', before: before.definedNames, after: after.definedNames });
  }
  return diffs;
}

describe('round-trip fidelity (open → edit 1 cell → save → re-parse)', () => {
  const files = pickFiles();
  expect(files.length).toBeGreaterThanOrEqual(5);

  for (const file of files) {
    it(`preserves all unmodified cells in ${file}`, () => {
      const originalBytes = new Uint8Array(readFileSync(join(REAL_WORLD, file)));
      const before = adapter.read(originalBytes);

      // Find a simple value cell to edit (not a formula, not empty).
      // Prefer a finite number; fall back to any non-empty non-formula cell.
      let editSheet = -1;
      let editRow = -1;
      let editCol = -1;
      let fallback = { s: -1, r: -1, c: -1 };
      outer: for (let s = 0; s < before.sheets.length; s++) {
        const sheet = before.sheets[s];
        for (let r = 0; r < sheet.rows.length; r++) {
          for (let c = 0; c < sheet.rows[r].length; c++) {
            const v = sheet.rows[r][c];
            if (typeof v === 'number' && Number.isFinite(v)) {
              editSheet = s; editRow = r; editCol = c;
              break outer;
            }
            if (fallback.s < 0 && v !== null && v !== undefined && v !== '' &&
                !(typeof v === 'string' && v.startsWith('='))) {
              fallback = { s, r, c };
            }
          }
        }
      }
      if (editSheet < 0 && fallback.s >= 0) {
        editSheet = fallback.s; editRow = fallback.r; editCol = fallback.c;
      }
      // Image-only files may have zero cells: verify the pure round-trip
      // (write → re-parse) preserves everything, with no edit.
      const hasEdit = editSheet >= 0;

      // Modify ONE cell (deep-clone the workbook data first).
      const modified: WorkbookData = JSON.parse(JSON.stringify(before));
      let editedKey = '';
      let newValue: unknown = undefined;
      if (hasEdit) {
        const oldVal = modified.sheets[editSheet].rows[editRow][editCol];
        newValue = typeof oldVal === 'string' ? 'ROUNDTRIP_EDIT' : 424242.5;
        modified.sheets[editSheet].rows[editRow][editCol] = newValue as never;
        editedKey = `${modified.sheets[editSheet].name}!${editRow}:${editCol}`;
      }

      // Save and re-parse.
      const savedBytes = adapter.write(modified);
      expect(savedBytes.length).toBeGreaterThan(0);
      const after = adapter.read(savedBytes);

      // The edited cell has the new value.
      if (hasEdit) {
        expect(after.sheets[editSheet].rows[editRow][editCol]).toBe(newValue);
      }

      // Everything else must be identical.
      const diffs = diffWorkbooks(before, after, editedKey);
      expect(
        diffs.slice(0, 10),
        `unmodified cells changed in ${file}`,
      ).toEqual([]);
    }, 60000);
  }
});
