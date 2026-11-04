/**
 * Deterministic inference — permission gating (design-docs/deterministic-inference.md §8).
 *
 * Inference reads only what the user can read; proposals that would write
 * to denied cells are not generated. Applying a proposal goes through
 * authorize() again (see applyProposalEdits in types.ts), so these are
 * pre-generation filters, not the enforcement point.
 */

import { a1Cell, type InferenceAuthorize } from './ports.js';
import type { CellCoord, ProposedEdit } from './types.js';

/** 'Sheet!A1'-style target for a coordinate. */
export function cellTarget(at: CellCoord): string {
  return a1Cell(at);
}

/** True when the principal may write this cell. */
export function canWriteCell(authorize: InferenceAuthorize, at: CellCoord): boolean {
  try {
    return authorize('cell.write', cellTarget(at));
  } catch {
    return false; // fail closed (e.g. missing principal throws)
  }
}

/** True when the principal may read this cell. */
export function canReadCell(authorize: InferenceAuthorize, at: CellCoord): boolean {
  try {
    return authorize('cell.read', cellTarget(at));
  } catch {
    return false;
  }
}

/**
 * Drop edits targeting cells the principal may not write. Returns the
 * allowed edits plus the count dropped, so the caller can note the
 * omission in the proposal description.
 */
export function filterEditsByPermission(
  authorize: InferenceAuthorize,
  edits: ProposedEdit[],
): { allowed: ProposedEdit[]; deniedCount: number } {
  const allowed: ProposedEdit[] = [];
  let deniedCount = 0;
  for (const edit of edits) {
    if (canWriteCell(authorize, edit.at)) allowed.push(edit);
    else deniedCount += 1;
  }
  return { allowed, deniedCount };
}
