/**
 * Deterministic inference — proposal model (design-docs/deterministic-inference.md §3).
 *
 * Every inference output is a *proposal*: a description, the proposed
 * change, and a preview. The user accepts, rejects, or modifies. Nothing
 * is applied without confirmation. Bulk proposals support selective apply
 * (per-item accept/reject) via selectProposalEdits().
 *
 * Proposals are headless data: the UI renders description + preview and
 * collects the accept/reject/modify decision; the host applies accepted
 * edits through its own permissioned write path (EngineHost.execute),
 * which re-runs authorize() at apply time.
 */

export type ProposalKind = 'autocomplete' | 'formula' | 'cleanup' | 'flashfill';

/** 0-based cell coordinate. */
export interface CellCoord {
  sheet: string;
  row: number;
  col: number;
}

/** One atomic, reversible change. All edits address real cells. */
export type ProposedEdit =
  | { kind: 'setValue'; at: CellCoord; text: string }
  | { kind: 'setFormula'; at: CellCoord; formula: string }
  | { kind: 'clear'; at: CellCoord }
  | { kind: 'deleteRow'; at: CellCoord };

/** Before/after preview for one cell touched by an edit. */
export interface ProposalPreviewCell {
  at: CellCoord;
  /** Display string before the change ('' when empty). */
  before: string;
  /** Display string after the change ('(row deleted)' for deleteRow). */
  after: string;
}

export interface Proposal {
  /** Stable within a run: `${kind}:${counter}`. */
  id: string;
  kind: ProposalKind;
  /** Short title for list views, e.g. 'Trim trailing spaces'. */
  title: string;
  /** One-paragraph human-readable description of what and why. */
  description: string;
  /** The proposed changes, in apply order. */
  edits: ProposedEdit[];
  /** Parallel preview of the first edits (capped for large bulks). */
  preview: ProposalPreviewCell[];
  /** Total number of preview rows available (preview may be capped). */
  previewTotal: number;
  /** 0..1 — analyzer confidence in the proposal. */
  confidence: number;
  /** True when every edit can be undone via the host undo stack. */
  reversible: boolean;
  /** True when the UI should offer per-item accept/reject. */
  bulk: boolean;
}

let proposalCounter = 0;

/** Deterministic id factory (counter resets per process; ids are run-scoped). */
export function nextProposalId(kind: ProposalKind): string {
  proposalCounter += 1;
  return `${kind}:${proposalCounter}`;
}

/**
 * Selective apply for bulk proposals: return a copy of the proposal with
 * only the edits (and their previews) at the given indices. Indices refer
 * to proposal.edits order. Out-of-range indices are ignored.
 */
export function selectProposalEdits(proposal: Proposal, indices: number[]): Proposal {
  const keep = new Set(indices.filter((i) => Number.isInteger(i) && i >= 0 && i < proposal.edits.length));
  const edits = proposal.edits.filter((_, i) => keep.has(i));
  const preview = proposal.preview.filter((p) => edits.some((e) => sameCoord(editCoord(e), p.at)));
  return {
    ...proposal,
    id: `${proposal.id}:sel${edits.length}`,
    edits,
    preview,
    previewTotal: edits.length,
    description: `${proposal.description} (${edits.length} of ${proposal.edits.length} items selected)`,
  };
}

function editCoord(edit: ProposedEdit): CellCoord {
  return edit.at;
}

function sameCoord(a: CellCoord, b: CellCoord): boolean {
  return a.sheet === b.sheet && a.row === b.row && a.col === b.col;
}

/** Port the host implements to apply one edit through its permissioned path. */
export type ProposalExecutor = (
  edit: ProposedEdit,
) => { ok: true } | { ok: false; error: string };

export interface ApplyResult {
  edit: ProposedEdit;
  ok: boolean;
  error?: string;
}

/**
 * Apply accepted edits through the host's permissioned write path. The
 * executor (bound to EngineHost.execute) re-runs authorize() per edit, so
 * a permission change between proposal and apply is still enforced.
 * deleteRow edits are applied bottom-up so earlier deletions don't shift
 * later targets.
 */
export function applyProposalEdits(
  edits: readonly ProposedEdit[],
  exec: ProposalExecutor,
): ApplyResult[] {
  const ordered = [...edits].sort((a, b) => {
    const ad = a.kind === 'deleteRow' ? 1 : 0;
    const bd = b.kind === 'deleteRow' ? 1 : 0;
    if (ad !== bd) return ad - bd; // non-deletions first
    if (ad === 1) return b.at.row - a.at.row; // deletions: bottom-up
    return 0; // otherwise keep proposal order (stable sort)
  });
  return ordered.map((edit) => {
    const r = exec(edit);
    return r.ok ? { edit, ok: true } : { edit, ok: false, error: r.error };
  });
}
