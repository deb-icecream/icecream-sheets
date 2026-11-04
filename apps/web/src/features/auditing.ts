/**
 * Formula auditing (Formulas > Formula Auditing):
 * - Trace Precedents / Trace Dependents over the formula text (the engine
 *   core exposes precedents only through its internal HyperFormula graph,
 *   which the web UI cannot reach without changing the engine — so this
 *   module parses A1 references from formula text instead, covering
 *   cross-sheet and range references honestly).
 * - Remove Arrows (the parent clears the arrow overlay state).
 * - Error Checking: scan the used range for error values.
 * - Evaluate Formula: single-step expression reduction; each step evaluates
 *   the innermost subexpression through a parent-supplied evaluator (the
 *   App implements it against the engine), so intermediate results are real.
 * - Watch Window: the parent keeps the watch list; this module supplies the
 *   value-text formatting.
 */
import type { CellRef } from '@icecream-sheets/engine';

/** Minimal cell access the auditing functions need (App adapts EngineHost). */
export interface AuditCellReader {
  formulaAt(ref: CellRef): string | undefined;
  valueTextAt(ref: CellRef): string;
  isErrorAt(ref: CellRef): boolean;
}

export interface ParsedRef {
  /** Sheet qualifier, or null for the formula's own sheet. */
  sheet: string | null;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface UsedRange {
  sheet: string;
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

// ---------------------------------------------------------------------------
// Reference extraction from formula text
// ---------------------------------------------------------------------------

const CELL = '\\$?[A-Za-z]{1,3}\\$?[0-9]+';
const SHEET_PART = "(?:'((?:[^']|'')+)'|([A-Za-z0-9_.]+))!";
const REF_RE = new RegExp(`(?:${SHEET_PART})?(${CELL})(?::(${CELL}))?`, 'g');

function colLettersToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseCellToken(token: string): { row: number; col: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?([0-9]+)$/.exec(token);
  if (!m) return null;
  const col = colLettersToIndex(m[1]);
  const row = parseInt(m[2], 10) - 1;
  if (row < 0 || row > 1048575 || col < 0 || col > 16383) return null;
  return { row, col };
}

/**
 * Extract A1 cell/range references from a formula, skipping double-quoted
 * string literals. Handles $ absolutes and 'Sheet Name'! qualifiers.
 */
export function extractRefs(formula: string): ParsedRef[] {
  const out: ParsedRef[] = [];
  // Blank out string literals so "A1" inside quotes is not a reference.
  let text = '';
  let inStr = false;
  for (let i = 0; i < formula.length; i++) {
    const ch = formula[i];
    if (ch === '"') {
      if (inStr && formula[i + 1] === '"') {
        text += '  ';
        i++;
        continue;
      }
      inStr = !inStr;
      text += ' ';
      continue;
    }
    text += inStr ? ' ' : ch;
  }
  REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REF_RE.exec(text)) !== null) {
    // Guard against matching function names (SUM() — the '(' right after).
    const after = text[REF_RE.lastIndex];
    if (after === '(') continue;
    // Guard against matching inside a longer identifier (preceded or
    // followed by letter/digit/_/.).
    const before = text[m.index - 1];
    if (before && /[A-Za-z0-9_.]/.test(before)) continue;
    if (after && /[A-Za-z0-9_.]/.test(after)) continue;
    const sheet = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2] !== undefined ? m[2] : null;
    const a = parseCellToken(m[3]);
    if (!a) continue;
    const b = m[4] ? parseCellToken(m[4]) : a;
    if (!b) continue;
    out.push({
      sheet,
      startRow: Math.min(a.row, b.row),
      startCol: Math.min(a.col, b.col),
      endRow: Math.max(a.row, b.row),
      endCol: Math.max(a.col, b.col),
    });
  }
  return out;
}

/** Expand parsed refs to individual cells (caps at 10k per range). */
export function expandRefs(refs: ParsedRef[], defaultSheet: string): CellRef[] {
  const out: CellRef[] = [];
  for (const r of refs) {
    const sheet = r.sheet ?? defaultSheet;
    let count = 0;
    for (let row = r.startRow; row <= r.endRow && count < 10000; row++) {
      for (let col = r.startCol; col <= r.endCol && count < 10000; col++) {
        out.push({ sheet, row, col });
        count++;
      }
    }
  }
  return out;
}

function sameCell(a: CellRef, b: CellRef): boolean {
  return a.sheet === b.sheet && a.row === b.row && a.col === b.col;
}

function refContainsTarget(refs: ParsedRef[], formulaSheet: string, target: CellRef): boolean {
  return refs.some((r) => {
    const sheet = r.sheet ?? formulaSheet;
    return (
      sheet === target.sheet &&
      target.row >= r.startRow &&
      target.row <= r.endRow &&
      target.col >= r.startCol &&
      target.col <= r.endCol
    );
  });
}

// ---------------------------------------------------------------------------
// Trace precedents / dependents
// ---------------------------------------------------------------------------

/** Direct precedents of a cell (from its formula text). */
export function tracePrecedents(reader: AuditCellReader, ref: CellRef): CellRef[] {
  const formula = reader.formulaAt(ref);
  if (!formula) return [];
  return expandRefs(extractRefs(formula), ref.sheet).filter((c) => !sameCell(c, ref));
}

/** Transitive precedents up to maxDepth (BFS, cycle-safe). */
export function tracePrecedentsTransitive(reader: AuditCellReader, ref: CellRef, maxDepth = 10): CellRef[] {
  const seen = new Set<string>([`${ref.sheet}!${ref.row},${ref.col}`]);
  const out: CellRef[] = [];
  let frontier = [ref];
  for (let d = 0; d < maxDepth && frontier.length > 0; d++) {
    const next: CellRef[] = [];
    for (const cur of frontier) {
      for (const p of tracePrecedents(reader, cur)) {
        const key = `${p.sheet}!${p.row},${p.col}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(p);
          next.push(p);
        }
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Direct dependents: every cell in the used ranges whose formula references
 * the target cell. Scans formula text (honest about INDIRECT-style dynamic
 * references, which are not tracked).
 */
export function traceDependents(reader: AuditCellReader, target: CellRef, used: UsedRange[]): CellRef[] {
  const out: CellRef[] = [];
  for (const u of used) {
    for (let r = u.startRow; r <= u.endRow; r++) {
      for (let c = u.startCol; c <= u.endCol; c++) {
        if (u.sheet === target.sheet && r === target.row && c === target.col) continue;
        const ref = { sheet: u.sheet, row: r, col: c };
        const formula = reader.formulaAt(ref);
        if (formula && refContainsTarget(extractRefs(formula), u.sheet, target)) out.push(ref);
      }
    }
  }
  return out;
}

/** Arrow segments for the overlay: { from, to } in cell coordinates. */
export interface AuditArrow {
  from: CellRef;
  to: CellRef;
  kind: 'precedent' | 'dependent';
}

export function precedentArrows(reader: AuditCellReader, ref: CellRef): AuditArrow[] {
  return tracePrecedents(reader, ref).map((p) => ({ from: p, to: ref, kind: 'precedent' as const }));
}

export function dependentArrows(reader: AuditCellReader, ref: CellRef, used: UsedRange[]): AuditArrow[] {
  return traceDependents(reader, ref, used).map((d) => ({ from: ref, to: d, kind: 'dependent' as const }));
}

// ---------------------------------------------------------------------------
// Error checking
// ---------------------------------------------------------------------------

export interface AuditError {
  ref: CellRef;
  formula: string | undefined;
  valueText: string;
}

/** Scan used ranges for cells whose computed value is an error. */
export function findErrors(reader: AuditCellReader, used: UsedRange[]): AuditError[] {
  const out: AuditError[] = [];
  for (const u of used) {
    for (let r = u.startRow; r <= u.endRow; r++) {
      for (let c = u.startCol; c <= u.endCol; c++) {
        const ref = { sheet: u.sheet, row: r, col: c };
        if (reader.isErrorAt(ref)) {
          out.push({ ref, formula: reader.formulaAt(ref), valueText: reader.valueTextAt(ref) });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Evaluate Formula: single-step reduction
// ---------------------------------------------------------------------------

export interface EvalStep {
  /** The subexpression that was evaluated, e.g. "SUM(A1:A3)". */
  expression: string;
  /** Its evaluated result text. */
  result: string;
}

export type EvalResult =
  | { done: false; step: EvalStep; next: string }
  | { done: true; result: string };

/** Find the innermost "(...)" group, including a function name prefix. */
function innermostGroup(text: string): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null;
  let bestDepth = -1;
  const stack: number[] = [];
  // Skip string literals.
  const masked = maskLiterals(text);
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(') {
      stack.push(i);
    } else if (ch === ')') {
      const open = stack.pop();
      if (open !== undefined) {
        const depth = stack.length;
        if (depth > bestDepth) {
          bestDepth = depth;
          best = { start: open, end: i };
        }
      }
    }
  }
  if (!best) return null;
  // Extend left over a function/identifier name.
  let start = best.start;
  while (start > 0 && /[A-Za-z0-9_.]/.test(text[start - 1])) start--;
  return { start, end: best.end };
}

function maskLiterals(text: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inStr && text[i + 1] === '"') {
        out += '  ';
        i++;
        continue;
      }
      inStr = !inStr;
      out += ' ';
      continue;
    }
    out += inStr ? ' ' : ch;
  }
  return out;
}

/** Quote a result for textual substitution when it is not a plain value. */
function quoteResult(result: string): string {
  const t = result.trim();
  if (t === '' || /^#/.test(t)) return t; // errors stay bare
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return t;
  if (/^(TRUE|FALSE)$/i.test(t)) return t.toUpperCase();
  return `"${t.replace(/"/g, '""')}"`;
}

/**
 * Perform one Evaluate-Formula step: evaluate the innermost parenthesized
 * subexpression via evalExpr and substitute the result. When no parens
 * remain, the whole expression is the final result.
 *
 * evalExpr is parent-supplied (the App evaluates against the engine), so
 * every intermediate value shown is a real computed value.
 */
export function nextEvalStep(formula: string, evalExpr: (expr: string) => string): EvalResult {
  const text = formula.startsWith('=') ? formula.slice(1) : formula;
  const group = innermostGroup(text);
  if (!group) {
    return { done: true, result: evalExpr(formula.startsWith('=') ? formula : `=${text}`) };
  }
  const expression = text.slice(group.start, group.end + 1);
  const result = evalExpr(expression.startsWith('=') ? expression : `=${expression}`);
  const next = `${formula.startsWith('=') ? '=' : ''}${text.slice(0, group.start)}${quoteResult(result)}${text.slice(group.end + 1)}`;
  return { done: false, step: { expression, result }, next };
}
