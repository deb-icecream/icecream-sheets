/**
 * Deterministic inference — cleanup proposals (design-docs/deterministic-inference.md §7).
 *
 * Detect inconsistent formatting, mixed types, trailing spaces and
 * duplicate rows. Propose standardizations as a batch with per-item
 * accept/reject (bulk proposals; see selectProposalEdits in types.ts).
 *
 * Detectors read through the typed view via the InferenceContext. Denied
 * cells are excluded from statistics and never targeted by edits;
 * duplicates are only reported when every cell in both rows is readable
 * (a denied cell could hide a difference). Edits targeting non-writable
 * cells are filtered out (§8) and noted in the proposal description.
 */

import {
  a1Cell,
  displayValue,
  type InferenceCell,
  type InferenceContext,
  type RangeBounds,
} from './ports.js';
import { filterEditsByPermission } from './permissions.js';
import {
  nextProposalId,
  type CellCoord,
  type Proposal,
  type ProposedEdit,
  type ProposalPreviewCell,
} from './types.js';

export interface CleanupOptions {
  /** Max findings per detector. Default 200. */
  maxFindings?: number;
  /** Rows beyond this are not scanned (deterministic cap). Default 5000. */
  maxRows?: number;
}

interface Finding {
  at: CellCoord;
  before: string;
  after: string;
  edit: ProposedEdit;
  note: string;
}

interface ScanGrid {
  grid: InferenceCell[][];
  bounds: RangeBounds;
  sheet: string;
}

function readSheetGrid(ctx: InferenceContext, sheet: string, opts: CleanupOptions): ScanGrid | null {
  const used = ctx.usedRange(sheet);
  if (!used) return null;
  const bounds: RangeBounds = {
    startRow: used.startRow,
    startCol: used.startCol,
    endRow: Math.min(used.endRow, used.startRow + (opts.maxRows ?? 5000) - 1),
    endCol: used.endCol,
  };
  return { grid: ctx.read(sheet, bounds), bounds, sheet };
}

function coordOf(scan: ScanGrid, r: number, c: number): CellCoord {
  return { sheet: scan.sheet, row: scan.bounds.startRow + r, col: scan.bounds.startCol + c };
}

function cellText(cell: InferenceCell): string {
  return displayValue(cell);
}

/** Cap findings deterministically (sheet order). */
function cap<T>(items: T[], max: number): { items: T[]; capped: boolean } {
  return items.length > max ? { items: items.slice(0, max), capped: true } : { items, capped: false };
}

// ---------------------------------------------------------------------------
// Detector 1: trailing / leading whitespace
// ---------------------------------------------------------------------------

function detectWhitespace(scan: ScanGrid, max: number): Finding[] {
  const findings: Finding[] = [];
  for (let r = 0; r < scan.grid.length; r++) {
    for (let c = 0; c < (scan.grid[r]?.length ?? 0); c++) {
      const cell = scan.grid[r][c];
      if (!cell || cell.denied || typeof cell.value !== 'string') continue;
      if (!!cell.formula) continue; // never rewrite formulas
      const trimmed = cell.value.trim();
      if (trimmed !== cell.value) {
        const at = coordOf(scan, r, c);
        findings.push({
          at,
          before: cell.value,
          after: trimmed,
          edit: { kind: 'setValue', at, text: trimmed },
          note: `${a1Cell(at)}: "${cell.value}" → "${trimmed}"`,
        });
      }
    }
  }
  return cap(findings, max).items;
}

// ---------------------------------------------------------------------------
// Detector 2: mixed types — text that parses as a number in a numeric column
// ---------------------------------------------------------------------------

function looksNumericText(s: string): boolean {
  const t = s.trim().replace(/[$,\s]/g, '');
  return t !== '' && !Number.isNaN(Number(t)) && /[0-9]/.test(t);
}

function detectMixedTypes(scan: ScanGrid, max: number): Finding[] {
  const colCount = Math.max(0, ...scan.grid.map((r) => r.length));
  const findings: Finding[] = [];
  for (let c = 0; c < colCount; c++) {
    let numeric = 0;
    let text = 0;
    const textCells: { r: number; cell: InferenceCell }[] = [];
    for (let r = 0; r < scan.grid.length; r++) {
      const cell = scan.grid[r]?.[c];
      if (!cell || cell.denied) continue;
      const v = cell.value;
      if (typeof v === 'number') numeric++;
      else if (typeof v === 'string' && v !== '') {
        text++;
        if (looksNumericText(v)) textCells.push({ r, cell });
      }
    }
    // Strict majority numeric, and at least 3 numeric values: the text
    // lookalikes are almost certainly mistyped numbers.
    if (numeric >= 3 && numeric > text && textCells.length > 0) {
      for (const { r, cell } of textCells) {
        const raw = cell.value as string;
        const num = Number(raw.trim().replace(/[$,\s]/g, ''));
        const at = coordOf(scan, r, c);
        findings.push({
          at,
          before: raw,
          after: String(num),
          edit: { kind: 'setValue', at, text: String(num) },
          note: `${a1Cell(at)}: text "${raw}" → number ${num}`,
        });
      }
    }
  }
  return cap(findings, max).items;
}

// ---------------------------------------------------------------------------
// Detector 3: inconsistent boolean-ish values
// ---------------------------------------------------------------------------

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0']);

function boolWord(s: string): boolean | null {
  const t = s.trim().toLowerCase();
  if (TRUE_WORDS.has(t)) return true;
  if (FALSE_WORDS.has(t)) return false;
  return null;
}

function detectInconsistentBooleans(scan: ScanGrid, max: number): Finding[] {
  const colCount = Math.max(0, ...scan.grid.map((r) => r.length));
  const findings: Finding[] = [];
  for (let c = 0; c < colCount; c++) {
    // Skip a leading header row: a non-boolean-ish string in row 0 while
    // every other non-empty cell is boolean-ish.
    let startRow = 0;
    const firstCell = scan.grid[0]?.[c];
    if (
      firstCell &&
      !firstCell.denied &&
      !firstCell.formula &&
      typeof firstCell.value === 'string' &&
      firstCell.value !== '' &&
      boolWord(firstCell.value) === null &&
      restAreBooleanish(scan, c)
    ) {
      startRow = 1;
    }
    const trueSpellings = new Map<string, number>();
    const falseSpellings = new Map<string, number>();
    const cells: { r: number; cell: InferenceCell; word: boolean }[] = [];
    let mixed = false;
    for (let r = startRow; r < scan.grid.length; r++) {
      const cell = scan.grid[r]?.[c];
      if (!cell || cell.denied || !!cell.formula) continue;
      const v = cell.value;
      let word: boolean | null = null;
      let spelling: string | null = null;
      if (typeof v === 'boolean') {
        word = v;
        spelling = v ? 'TRUE' : 'FALSE';
      } else if (typeof v === 'string' && v !== '') {
        word = boolWord(v);
        if (word !== null) spelling = v;
      }
      if (word === null || spelling === null) {
        // A non-boolean-ish value breaks the pattern: not a boolean column.
        if (v !== null && v !== undefined && v !== '') {
          mixed = true;
          break;
        }
        continue;
      }
      cells.push({ r, cell, word });
      const map = word ? trueSpellings : falseSpellings;
      map.set(spelling, (map.get(spelling) ?? 0) + 1);
    }
    // Standardize true-words and false-words separately on their own
    // majority spellings; need at least two distinct spellings overall.
    const distinct = new Set([...trueSpellings.keys(), ...falseSpellings.keys()]).size;
    if (mixed || cells.length < 3 || distinct < 2) continue;
    const majority = (m: Map<string, number>): string | null =>
      m.size === 0 ? null : [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
    const stdTrue = majority(trueSpellings);
    const stdFalse = majority(falseSpellings);
    for (const { r, word } of cells) {
      const target = word ? stdTrue : stdFalse;
      if (target === null) continue;
      const at = coordOf(scan, r, c);
      const cur = cellText(scan.grid[r][c]);
      if (cur === target) continue;
      findings.push({
        at,
        before: cur,
        after: target,
        edit: { kind: 'setValue', at, text: target },
        note: `${a1Cell(at)}: "${cur}" → "${target}"`,
      });
    }
  }
  return cap(findings, max).items;
}

// ---------------------------------------------------------------------------
// Detector 4: duplicate rows
// ---------------------------------------------------------------------------

/** True when every non-empty cell below row 0 is boolean-ish (header heuristic). */
function restAreBooleanish(scan: ScanGrid, c: number): boolean {
  let seen = 0;
  for (let r = 1; r < scan.grid.length; r++) {
    const cell = scan.grid[r]?.[c];
    if (!cell || cell.denied || !!cell.formula) continue;
    const v = cell.value;
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'boolean') {
      seen++;
      continue;
    }
    if (typeof v === 'string' && boolWord(v) !== null) {
      seen++;
      continue;
    }
    return false;
  }
  return seen > 0;
}

function rowSignature(scan: ScanGrid, r: number): string | null {
  const row = scan.grid[r];
  if (!row) return null;
  const parts: string[] = [];
  for (let c = 0; c < row.length; c++) {
    const cell = row[c];
    if (!cell) {
      parts.push('');
      continue;
    }
    if (cell.denied) return null; // a hidden cell could hide a difference
    if (!!cell.formula) return null; // formulas: don't touch
    parts.push(cellText(cell));
  }
  // Ignore fully-empty rows.
  if (parts.every((p) => p === '')) return null;
  return parts.join('\u0001');
}

function detectDuplicateRows(scan: ScanGrid, max: number): Finding[] {
  const seen = new Map<string, number>(); // signature -> first row index
  const findings: Finding[] = [];
  for (let r = 0; r < scan.grid.length; r++) {
    const sig = rowSignature(scan, r);
    if (sig === null) continue;
    const first = seen.get(sig);
    if (first === undefined) {
      seen.set(sig, r);
      continue;
    }
    const at = coordOf(scan, r, 0);
    findings.push({
      at: { sheet: at.sheet, row: at.row, col: scan.bounds.startCol },
      before: `row ${at.row + 1}`,
      after: '(row deleted)',
      edit: { kind: 'deleteRow', at: { sheet: at.sheet, row: at.row, col: scan.bounds.startCol } },
      note: `Row ${at.row + 1} duplicates row ${scan.bounds.startRow + first + 1}`,
    });
  }
  return cap(findings, max).items;
}

// ---------------------------------------------------------------------------
// Proposal assembly
// ---------------------------------------------------------------------------

const PREVIEW_CAP = 10;

function findingsToProposal(
  kind: 'cleanup',
  title: string,
  description: string,
  findings: Finding[],
  confidence: number,
  reversible = true,
): Proposal | null {
  if (findings.length === 0) return null;
  const edits = findings.map((f) => f.edit);
  const preview: ProposalPreviewCell[] = findings.slice(0, PREVIEW_CAP).map((f) => ({
    at: f.at,
    before: f.before,
    after: f.after,
  }));
  return {
    id: nextProposalId(kind),
    kind,
    title,
    description,
    edits,
    preview,
    previewTotal: findings.length,
    confidence,
    reversible,
    bulk: true,
  };
}

/**
 * Whitespace-only cleanup proposal for one sheet (Data > Trim Whitespace).
 * Runs the same leading/trailing-whitespace detector as
 * cleanupProposalsForSheet, but returns just that proposal so the UI can
 * wire a one-click "trim everything" action. Returns null when nothing
 * needs trimming. Permission filtering matches the full cleanup path:
 * cells the principal may not write are dropped and counted.
 */
export function whitespaceCleanupProposal(
  ctx: InferenceContext,
  sheet: string,
  opts: CleanupOptions = {},
): Proposal | null {
  const scan = readSheetGrid(ctx, sheet, opts);
  if (!scan) return null;
  const max = opts.maxFindings ?? 200;
  const findings = detectWhitespace(scan, max);
  if (findings.length === 0) return null;
  const { allowed, deniedCount } = filterEditsByPermission(ctx.authorize, findings.map((f) => f.edit));
  if (allowed.length === 0) return null;
  const kept = findings.filter((f) => allowed.includes(f.edit));
  const deniedNote = deniedCount > 0 ? ` ${deniedCount} item(s) skipped: no write permission.` : '';
  const cappedNote = findings.length >= max ? ' (capped)' : '';
  const description =
    `Found ${kept.length} cell${kept.length === 1 ? '' : 's'} with leading or trailing whitespace${cappedNote}. ` +
    `Proposes trimming each value; formulas are never rewritten.` +
    deniedNote;
  return findingsToProposal('cleanup', 'Trim leading/trailing spaces', description, kept, 0.95, true);
}

/**
 * Run all cleanup detectors over one sheet and return bulk proposals —
 * one per detector that found anything. Per-item accept/reject is
 * supported via selectProposalEdits(). Findings on cells the principal
 * may not write are dropped and counted in the description.
 */
export function cleanupProposalsForSheet(
  ctx: InferenceContext,
  sheet: string,
  opts: CleanupOptions = {},
): Proposal[] {
  const scan = readSheetGrid(ctx, sheet, opts);
  if (!scan) return [];
  const max = opts.maxFindings ?? 200;

  const detectors: {
    title: string;
    describe: (n: number, cappedNote: string) => string;
    findings: Finding[];
    confidence: number;
    reversible: boolean;
  }[] = [
    {
      title: 'Trim leading/trailing spaces',
      describe: (n, capped) =>
        `Found ${n} cell${n === 1 ? '' : 's'} with leading or trailing whitespace${capped}. ` +
        `Proposes trimming each value; formulas are never rewritten.`,
      findings: detectWhitespace(scan, max),
      confidence: 0.95,
      reversible: true,
    },
    {
      title: 'Standardize mixed types',
      describe: (n, capped) =>
        `Found ${n} text cell${n === 1 ? '' : 's'} holding numbers inside otherwise numeric columns${capped}. ` +
        `Proposes converting them to numbers so aggregates work.`,
      findings: detectMixedTypes(scan, max),
      confidence: 0.85,
      reversible: true,
    },
    {
      title: 'Standardize boolean values',
      describe: (n, capped) =>
        `Found ${n} cell${n === 1 ? '' : 's'} with inconsistent true/false spellings (e.g. Yes vs TRUE)${capped}. ` +
        `Proposes the majority spelling for the column.`,
      findings: detectInconsistentBooleans(scan, max),
      confidence: 0.8,
      reversible: true,
    },
    {
      title: 'Remove duplicate rows',
      describe: (n, capped) =>
        `Found ${n} duplicate row${n === 1 ? '' : 's'} (identical readable values)${capped}. ` +
        `Proposes deleting the later copies, keeping the first occurrence.`,
      findings: detectDuplicateRows(scan, max),
      confidence: 0.9,
      // Row deletion is structural: not covered by the cell-level Undo
      // manager, so the proposal is honestly marked non-reversible.
      reversible: false,
    },
  ];

  const proposals: Proposal[] = [];
  for (const d of detectors) {
    if (d.findings.length === 0) continue;
    const { allowed, deniedCount } = filterEditsByPermission(ctx.authorize, d.findings.map((f) => f.edit));
    if (allowed.length === 0) continue; // §8: not generated
    const kept = d.findings.filter((f) => allowed.includes(f.edit));
    const deniedNote = deniedCount > 0 ? ` ${deniedCount} item(s) skipped: no write permission.` : '';
    const cappedNote = d.findings.length >= max ? ' (capped)' : '';
    let description = d.describe(kept.length, cappedNote) + deniedNote;
    if (!d.reversible) {
      description += ' Note: deleting rows cannot be undone with Undo — review the preview carefully.';
    }
    const p = findingsToProposal('cleanup', d.title, description, kept, d.confidence, d.reversible);
    if (p) proposals.push(p);
  }
  return proposals;
}
