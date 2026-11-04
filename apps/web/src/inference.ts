/**
 * Web binding for deterministic inference (design-docs/deterministic-inference.md).
 *
 * Builds an InferenceContext from the EngineHost's typed view, bound to the
 * session principal. Reads go through host.getView(); denied cells arrive
 * as #PERM! and are marked denied. Authorization checks delegate to the
 * ProtectionManager (hidden = unreadable, locked = unwritable). Applying a
 * proposal goes through host.execute(), which re-runs authorize() per edit.
 */
import type { EngineHost } from '@icecream-sheets/engine';
import {
  applyProposalEdits,
  type InferenceCell,
  type InferenceContext,
  type Proposal,
  type ProposalExecutor,
  type ProposedEdit,
  type RangeBounds,
} from '@icecream-sheets/service';
import { cellRef } from './engine';

interface ProtectionLike {
  isHiddenFrom(sheet: string, row: number, col: number, principal: string): boolean;
  isCellEditable(sheet: string, row: number, col: number): boolean;
}

function parseA1Target(target: string): { sheet: string; row: number; col: number } | null {
  // 'Sheet!A1' or 'Sheet!A1:B2' or 'Sheet' — we only need the first cell.
  const m = target.match(/^(?:'([^']+)'|([^!]+))!(?:\$?([A-Z]{1,3})\$?(\d+))?/);
  if (!m) return null;
  const sheet = m[1] ?? m[2];
  if (!m[3] || !m[4]) return { sheet, row: 0, col: 0 };
  let col = 0;
  for (const ch of m[3]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { sheet, row: parseInt(m[4], 10) - 1, col: col - 1 };
}

/** Build an InferenceContext bound to the host's typed view and principal. */
export function buildInferenceContext(
  host: EngineHost,
  protection: ProtectionLike,
  principal: string,
): InferenceContext {
  const view = host.getView();
  return {
    principal,
    usedRange: (sheet: string): RangeBounds | null => {
      const r = view.usedRange(sheet);
      if (!r) return null;
      return { startRow: r.startRow, startCol: r.startCol, endRow: r.endRow, endCol: r.endCol };
    },
    read: (sheet: string, bounds: RangeBounds): InferenceCell[][] => {
      const rows = view.readRange({
        sheet,
        startRow: bounds.startRow,
        startCol: bounds.startCol,
        endRow: bounds.endRow,
        endCol: bounds.endCol,
      });
      return rows.map((row) =>
        row.map((cell): InferenceCell => {
          const v = cell.value;
          const denied = v.kind === 'error' && v.code === '#PERM!';
          const value: string | number | boolean | null = denied ? null : scalarOf(v);
          return { value, formula: cell.formula, denied };
        }),
      );
    },
    authorize: (action: string, target: string): boolean => {
      const t = parseA1Target(target);
      if (!t) return false;
      try {
        if (action === 'cell.read' || action === 'range.read') {
          return !protection.isHiddenFrom(t.sheet, t.row, t.col, principal);
        }
        if (action === 'cell.write' || action === 'cell.clear') {
          return protection.isCellEditable(t.sheet, t.row, t.col);
        }
        return false;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Apply proposal edits through the host's permissioned write path.
 *
 * `onDeleteRows` is called after each successful deleteRow edit so the
 * app can keep named ranges tracking the structural shift
 * (design-docs/named-ranges-and-named-functions.md §1). Deletions run
 * bottom-up, so each (sheet, row, count) is expressed in current indices.
 */
export function applyProposal(
  host: EngineHost,
  proposal: Proposal,
  indices?: number[],
  onDeleteRows?: (sheet: string, row: number, count: number) => void,
): { ok: number; failed: { edit: ProposedEdit; error?: string }[] } {
  const edits = indices
    ? proposal.edits.filter((_, i) => indices.includes(i))
    : proposal.edits;
  const exec: ProposalExecutor = (edit) => {
    try {
      const ref = cellRef(edit.at.sheet, edit.at.row, edit.at.col);
      if (edit.kind === 'setValue') {
        const r = host.execute({ cmd: 'setCell', ref, value: edit.text });
        return r.ok ? { ok: true } : { ok: false, error: r.error };
      }
      if (edit.kind === 'setFormula') {
        const r = host.execute({ cmd: 'setFormula', ref, formula: edit.formula });
        return r.ok ? { ok: true } : { ok: false, error: r.error };
      }
      if (edit.kind === 'clear') {
        const r = host.execute({ cmd: 'setCell', ref, value: null });
        return r.ok ? { ok: true } : { ok: false, error: r.error };
      }
      // deleteRow: the engine protocol's structural deleteRows command
      // (authorized as 'sheet.structure' on the sheet). applyProposalEdits
      // orders deletions bottom-up so earlier deletions don't shift later
      // targets. Row deletion is structural: it is not covered by the
      // cell-level Undo manager (the proposal is marked reversible:false).
      const r = host.execute({ cmd: 'deleteRows', sheet: edit.at.sheet, row: edit.at.row, count: 1 });
      if (r.ok) onDeleteRows?.(edit.at.sheet, edit.at.row, 1);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
  const results = applyProposalEdits(edits, exec);
  return {
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).map((r) => ({ edit: r.edit, error: r.error })),
  };
}

/** Extract a scalar JS value from a TypedValue; null for errors/images/null. */
function scalarOf(v: { kind: string; value?: unknown; code?: string }): string | number | boolean | null {
  if (v.kind === 'error') return null;
  if (v.kind === 'image') return null;
  const val = (v as { value: unknown }).value;
  return typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean' ? val : null;
}
/** Read one column's display strings (for autocomplete history). */
export function readColumnHistory(
  host: EngineHost,
  sheet: string,
  col: number,
  maxRows = 2000,
): string[] {
  const view = host.getView();
  const used = view.usedRange(sheet);
  if (!used) return [];
  const endRow = Math.min(used.endRow, used.startRow + maxRows - 1);
  if (endRow < used.startRow) return [];
  const rows = view.readRange({ sheet, startRow: used.startRow, startCol: col, endRow, endCol: col });
  const out: string[] = [];
  for (const row of rows) {
    const v = row[0]?.value;
    if (v === undefined) continue;
    // Errors (including #PERM! denials), images and blanks carry no
    // completable history.
    const s = scalarOf(v);
    if (typeof s === 'string' && s !== '') out.push(s);
    else if (typeof s === 'number') out.push(String(s));
    else if (typeof s === 'boolean') out.push(s ? 'TRUE' : 'FALSE');
  }
  return out;
}
