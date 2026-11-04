/**
 * Shared grid helpers for skill-pack tools.
 *
 * Every helper goes through the shared EngineHost with the caller's
 * auth, exactly like the core tools: reads use readRange (denied cells
 * surface as #PERM! errors and are converted to null here, mirroring
 * the pivot reader in server.ts — denied values never leak into pack
 * computations), writes use execute({cmd:'setCell'|'setFormula'}).
 */
import { TypedView, type EngineHost, type TypedValue } from '@icecream-sheets/engine';

export interface Auth {
  principal: string;
}

/** Hard cap on cells a single pack operation reads or writes. */
export const MAX_PACK_CELLS = 100_000;

/** A rectangular table read from a sheet: header row + data rows as JSON values. */
export interface TableData {
  sheet: string;
  /** Header labels (blank headers become `Column N`, like the pivot reader). */
  headers: string[];
  /** Data rows (header excluded), as plain JSON values. */
  rows: unknown[][];
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** Convert one TypedValue to a JSON value; #PERM! (denied) becomes null. */
export function cellToJson(v: TypedValue): unknown {
  if (v.kind === 'error' && v.code === '#PERM!') return null;
  return TypedView.toJson(v);
}

/** Read a sheet's used range as a table (first row = header). */
export async function readTable(
  engine: EngineHost,
  sheet: string,
  auth: Auth,
): Promise<TableData> {
  const used = await engine.getUsedRange(sheet);
  if (!used) {
    throw new Error(`sheet "${sheet}" is empty (no used range)`);
  }
  const count = (used.endRow - used.startRow + 1) * (used.endCol - used.startCol + 1);
  if (count > MAX_PACK_CELLS) {
    throw new Error(
      `sheet "${sheet}" used range is ${count} cells (max ${MAX_PACK_CELLS}) — narrow the data first`,
    );
  }
  const values = await engine.readRange(
    { sheet, startRow: used.startRow, startCol: used.startCol, endRow: used.endRow, endCol: used.endCol },
    auth,
  );
  const grid = values.map((row) => row.map(cellToJson));
  // Drop fully-empty trailing rows (sparse writes can extend the used range).
  while (grid.length > 0 && grid[grid.length - 1]?.every((v) => v === null || v === '')) grid.pop();
  if (grid.length < 1) {
    throw new Error(`sheet "${sheet}" has no header row`);
  }
  const headers = (grid[0] ?? []).map((h, i) =>
    h === null || h === undefined || h === '' ? `Column ${i + 1}` : String(h),
  );
  return {
    sheet,
    headers,
    rows: grid.slice(1),
    startRow: used.startRow,
    startCol: used.startCol,
    endRow: used.startRow + grid.length - 1,
    endCol: used.endCol,
  };
}

/** Resolve a column by header name (case-insensitive, trimmed). Throws listing the headers. */
export function columnIndex(table: TableData, name: string): number {
  const wanted = name.trim().toLowerCase();
  const idx = table.headers.findIndex((h) => h.trim().toLowerCase() === wanted);
  if (idx < 0) {
    throw new Error(
      `unknown column "${name}" — sheet "${table.sheet}" has columns: ${table.headers.join(', ')}`,
    );
  }
  return idx;
}

/** Resolve several columns at once. */
export function columnIndexes(table: TableData, names: string[]): number[] {
  return names.map((n) => columnIndex(table, n));
}

/** Sheet names, async-host aware (mirrors the create_chart resolution in server.ts). */
export async function sheetNames(engine: EngineHost): Promise<string[]> {
  const asyncNames = (engine as { sheetNamesAsync?: unknown }).sheetNamesAsync;
  if (typeof asyncNames === 'function') {
    return (await (asyncNames as () => Promise<string[]>).call(engine)) as string[];
  }
  return engine.sheetNames();
}

/** Create the sheet when it does not exist yet (idempotent). */
export async function ensureSheet(engine: EngineHost, name: string, auth: Auth): Promise<void> {
  const names = await sheetNames(engine);
  if (!names.includes(name)) {
    const result = await engine.execute({ cmd: 'addSheet', name, auth });
    if (!result.ok) throw new Error(`could not create sheet "${name}": ${result.error}`);
  }
}

/** Write one literal value (null clears the cell). Throws on engine refusal. */
export async function setCell(
  engine: EngineHost,
  sheet: string,
  row: number,
  col: number,
  value: string | number | boolean | null,
  auth: Auth,
): Promise<void> {
  const result = await engine.execute({ cmd: 'setCell', ref: { sheet, row, col }, value, auth });
  if (!result.ok) {
    throw new Error(`write to ${sheet}!R${row}C${col} failed: ${result.error}`);
  }
}

/** Write one formula (leading "=" optional). Throws on engine refusal. */
export async function setFormula(
  engine: EngineHost,
  sheet: string,
  row: number,
  col: number,
  formula: string,
  auth: Auth,
): Promise<void> {
  const result = await engine.execute({ cmd: 'setFormula', ref: { sheet, row, col }, formula, auth });
  if (!result.ok) {
    throw new Error(`formula at ${sheet}!R${row}C${col} failed: ${result.error}`);
  }
}

/** Write a matrix of literal values starting at (startRow, startCol). Returns cells written. */
export async function writeMatrix(
  engine: EngineHost,
  sheet: string,
  startRow: number,
  startCol: number,
  matrix: unknown[][],
  auth: Auth,
): Promise<number> {
  let count = 0;
  for (const row of matrix) count += row.length;
  if (count > MAX_PACK_CELLS) {
    throw new Error(`refusing to write ${count} cells (max ${MAX_PACK_CELLS})`);
  }
  let written = 0;
  for (let r = 0; r < matrix.length; r++) {
    const row = matrix[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      const value =
        typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null
          ? (v as string | number | boolean | null)
          : v === undefined
            ? null
            : String(v);
      await setCell(engine, sheet, startRow + r, startCol + c, value, auth);
      written++;
    }
  }
  return written;
}

/**
 * Replace a sheet's contents with a table (header + rows) written at
 * A1. Creates the sheet when missing; clears any stale cells left over
 * from a previously larger table on that sheet. Returns cells written.
 */
export async function writeTable(
  engine: EngineHost,
  sheet: string,
  headers: string[],
  rows: unknown[][],
  auth: Auth,
): Promise<number> {
  await ensureSheet(engine, sheet, auth);
  let prior: { endRow: number; endCol: number } | null = null;
  try {
    prior = await engine.getUsedRange(sheet);
  } catch {
    prior = null;
  }
  const matrix: unknown[][] = [headers, ...rows];
  const written = await writeMatrix(engine, sheet, 0, 0, matrix, auth);
  if (prior) {
    // Clear the stale tail: rows below the new table and columns right
    // of it, within the previously used rectangle.
    for (let r = matrix.length; r <= prior.endRow; r++) {
      for (let c = 0; c <= prior.endCol; c++) {
        await setCell(engine, sheet, r, c, null, auth);
      }
    }
    const newEndCol = Math.max(...matrix.map((row) => row.length)) - 1;
    for (let r = 0; r < matrix.length; r++) {
      for (let c = newEndCol + 1; c <= prior.endCol; c++) {
        await setCell(engine, sheet, r, c, null, auth);
      }
    }
  }
  return written;
}

/** A1 column letters for a 0-based column index. */
export function colLetters(col: number): string {
  let n = col + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** A1 reference for a 0-based (row, col). */
export function a1(row: number, col: number): string {
  return `${colLetters(col)}${row + 1}`;
}

/** A1 range for a 0-based rectangle. */
export function a1Range(startRow: number, startCol: number, endRow: number, endCol: number): string {
  return `${a1(startRow, startCol)}:${a1(endRow, endCol)}`;
}
