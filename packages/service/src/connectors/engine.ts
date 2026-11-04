/**
 * Engine materialization — project a connector TableData into the engine's
 * typed computational view.
 *
 * All writes go through host.execute(), i.e. through authorize(), exactly
 * like user edits: there is no privileged path. The synchronous write pass
 * emits change events once, so hosts render a single atomic transition.
 * Cells outside the previously materialized region are never touched by
 * refresh, so user notes beside the data survive.
 */
import { EngineHost } from '@icecream-sheets/engine';
import type { RefreshPlan } from './refresh.js';
import type { ConnectorSpec } from './spec.js';
import type { TableData } from './table.js';

/** Sheet-name-safe label: trimmed, ≤31 chars (Excel limit), non-empty. */
export function sanitizeSheetName(label: string): string {
  const t = label
    .replace(/[\\/?*[\]:]/g, ' ')
    .trim()
    .slice(0, 31)
    .trim();
  return t === '' ? 'Data' : t;
}

/** Unique sheet name: "Sales", "Sales 2", "Sales 3", … */
export function uniqueSheetName(existing: string[], base: string): string {
  const clean = sanitizeSheetName(base);
  if (!existing.includes(clean)) return clean;
  let n = 2;
  while (existing.includes(`${clean} ${n}`)) n++;
  return `${clean} ${n}`;
}

/**
 * Materialize a fetched table as a brand-new sheet (header row + data rows).
 * Throws on the first failed write.
 *
 * Async: host.execute() is awaited because the host may be an
 * IPC-forwarding host (desktop MCP parity, platform-shell.md §8) whose
 * execute() resolves asynchronously. Awaiting a synchronous host is a
 * no-op, so existing callers only add `await`.
 */
export async function writeTableToNewSheet(
  host: EngineHost,
  name: string,
  table: TableData,
  principal = 'user',
): Promise<void> {
  const added = await host.execute({ cmd: 'addSheet', name, auth: { principal } });
  if (!added.ok) throw new Error(added.error);
  for (let col = 0; col < table.columns.length; col++) {
    const res = await host.execute({
      cmd: 'setCell',
      ref: { sheet: name, row: 0, col },
      value: table.columns[col],
      auth: { principal },
    });
    if (!res.ok) throw new Error(res.error);
  }
  for (let r = 0; r < table.rows.length; r++) {
    const row = table.rows[r];
    for (let col = 0; col < row.length; col++) {
      const res = await host.execute({
        cmd: 'setCell',
        ref: { sheet: name, row: r + 1, col },
        value: row[col],
        auth: { principal },
      });
      if (!res.ok) throw new Error(res.error);
    }
  }
}

/**
 * Apply a refresh plan to an existing connected sheet: writes, then clears
 * of the stale tail. Throws on the first failed write.
 *
 * Async: host.execute() is awaited because the host may be an
 * IPC-forwarding host (desktop MCP parity, platform-shell.md §8) whose
 * execute() resolves asynchronously. Awaiting a synchronous host is a
 * no-op, so existing callers only add `await`.
 */
export async function applyRefreshPlanToHost(
  host: EngineHost,
  sheetName: string,
  plan: RefreshPlan,
  principal = 'user',
): Promise<void> {
  for (const w of plan.writes) {
    const res = await host.execute({
      cmd: 'setCell',
      ref: { sheet: sheetName, row: w.row, col: w.col },
      value: w.value,
      auth: { principal },
    });
    if (!res.ok) throw new Error(res.error);
  }
  for (const c of plan.clears) {
    const res = await host.execute({
      cmd: 'setCell',
      ref: { sheet: sheetName, row: c.row, col: c.col },
      value: null,
      auth: { principal },
    });
    if (!res.ok) throw new Error(res.error);
  }
}

/** Build a SourceBinding-like record after a successful open. */
export function bindingForOpen(
  sheetName: string,
  spec: ConnectorSpec,
  table: TableData,
): { id: string; sheetName: string; spec: ConnectorSpec; lastRefresh: string; rowCount: number; colCount: number } {
  return {
    id: sheetName,
    sheetName,
    spec,
    lastRefresh: new Date().toISOString(),
    rowCount: table.rows.length + 1,
    colCount: table.columns.length,
  };
}
