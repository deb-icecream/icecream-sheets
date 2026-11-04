/**
 * Per-subject report views (design-docs/native-reports-and-dashboards.md §7).
 *
 * "The report is an object in the permission tree. Viewers see only what
 * their table permissions allow, through per-subject filtered views."
 *
 * Enforcement model:
 * - A report may be *viewed* by a subject only when the subject can read
 *   every binding range the report's visuals draw from (checked through the
 *   existing authorize() choke point — the same policy the engine's
 *   Authorizer consumes, e.g. accessPolicy() from access.ts composed with
 *   the ProtectionManager's protectionPolicy()).
 * - Binding records are then filtered per cell for that subject: any cell
 *   the subject may not read (hidden cells for non-exempt principals, or
 *   ranges withheld by the access table) becomes the #PERM! error value —
 *   the same sentinel the engine uses for denied reads (ICEPERMDENIED).
 * - Locked cells are read-only: report visuals never write through
 *   bindings, and this module exposes the per-cell writability check so
 *   hosts offering report-driven edits can gate them the same way.
 *
 * This module is pure and headless: the caller hands in the raw records
 * (read by a privileged host reader) plus an authorize() implementation.
 * It never touches the engine or storage directly.
 */

import type { ReportBinding, ReportSpec } from './spec.js';
import type { PivotRecord } from '../pivot.js';

/** Structural authorize() port — mirrors the engine's Policy signature. */
export interface AuthorizePort {
  (action: string, target: string, ctx: { principal: string }): boolean;
}

/** The cell value a subject sees when they may not read the cell. */
export const PERM_DENIED_CELL = '#PERM!';

/** "Sheet1!A1" target for a 0-based (row, col). */
export function reportCellTarget(sheet: string, row: number, col: number): string {
  let letters = '';
  let c = col;
  do {
    letters = String.fromCharCode(65 + (c % 26)) + letters;
    c = Math.floor(c / 26) - 1;
  } while (c >= 0);
  return `${sheet}!${letters}${row + 1}`;
}

/** "Sheet1!A1:B2" target for a 0-based inclusive range. */
export function reportRangeTarget(
  sheet: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): string {
  const a1 = reportCellTarget(sheet, startRow, startCol).split('!')[1];
  const b1 = reportCellTarget(sheet, endRow, endCol).split('!')[1];
  return `${sheet}!${a1}:${b1}`;
}

function assertPrincipal(principal: string): void {
  if (typeof principal !== 'string' || principal.length === 0) {
    throw new Error('reportPermissions: missing principal (fail closed)');
  }
}

/** May this subject read this cell? (face e: hidden cells are unreadable.) */
export function canSubjectReadCell(
  authorize: AuthorizePort,
  sheet: string,
  row: number,
  col: number,
  principal: string,
): boolean {
  assertPrincipal(principal);
  try {
    return authorize('cell.read', reportCellTarget(sheet, row, col), { principal });
  } catch {
    return false; // fail closed: a throwing policy denies
  }
}

/** May this subject write this cell? (face d: locked cells can't be written.) */
export function canSubjectWriteCell(
  authorize: AuthorizePort,
  sheet: string,
  row: number,
  col: number,
  principal: string,
): boolean {
  assertPrincipal(principal);
  try {
    return authorize('cell.write', reportCellTarget(sheet, row, col), { principal });
  } catch {
    return false;
  }
}

export interface SubjectCellAccess {
  readable: boolean;
  writable: boolean;
}

/** Read + write access of one cell for one subject. */
export function subjectCellAccess(
  authorize: AuthorizePort,
  sheet: string,
  row: number,
  col: number,
  principal: string,
): SubjectCellAccess {
  return {
    readable: canSubjectReadCell(authorize, sheet, row, col, principal),
    writable: canSubjectWriteCell(authorize, sheet, row, col, principal),
  };
}

/**
 * Filter one binding's records for a subject. Records are projected
 * positionally onto the binding range: record i covers sheet row
 * `headerRow + 1 + i`, field j covers column `startCol + j`. Any cell the
 * subject may not read becomes #PERM!. Returns new record objects; the
 * input is never mutated.
 *
 * The header row itself is part of the report spec (field names), so it is
 * not filtered — only data cells are per-subject filtered.
 */
export function filterBindingRecordsForSubject(
  binding: ReportBinding,
  records: PivotRecord[],
  authorize: AuthorizePort,
  principal: string,
): PivotRecord[] {
  assertPrincipal(principal);
  const dataStartRow = binding.headerRow + 1;
  return records.map((rec, i) => {
    const row = dataStartRow + i;
    let changed = false;
    const out: PivotRecord = { ...rec };
    binding.fields.forEach((field, fi) => {
      if (!(field in out)) return;
      const col = binding.startCol + fi;
      if (!canSubjectReadCell(authorize, binding.sheet, row, col, principal)) {
        out[field] = PERM_DENIED_CELL;
        changed = true;
      }
    });
    return changed ? out : rec;
  });
}

/**
 * Filter a whole report's binding records for a subject. `readBinding`
 * supplies the raw (privileged) records per binding id.
 */
export function filterReportForSubject(
  spec: ReportSpec,
  readBinding: (binding: ReportBinding) => PivotRecord[],
  authorize: AuthorizePort,
  principal: string,
): Map<string, PivotRecord[]> {
  assertPrincipal(principal);
  const out = new Map<string, PivotRecord[]>();
  for (const binding of spec.bindings) {
    out.set(binding.id, filterBindingRecordsForSubject(binding, readBinding(binding), authorize, principal));
  }
  return out;
}

/**
 * May this subject view the report at all? The subject needs read access to
 * every binding range the report draws from. (In v1 the report inherits its
 * visibility from its bindings — the report-as-permission-tree-object; a
 * subject with no read on a binding sees nothing, not even the layout.)
 */
export function canViewReport(spec: ReportSpec, authorize: AuthorizePort, principal: string): boolean {
  assertPrincipal(principal);
  if (spec.bindings.length === 0) return true;
  try {
    return spec.bindings.every((b) =>
      authorize(
        'cell.read',
        reportRangeTarget(b.sheet, b.startRow, b.startCol, b.endRow, b.endCol),
        { principal },
      ),
    );
  } catch {
    return false;
  }
}
