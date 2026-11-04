/**
 * Deterministic inference — formula suggestions (design-docs/deterministic-inference.md §6).
 *
 * Suggest formulas based on column headers and data patterns. Every
 * suggestion carries the full formula text for review before insertion;
 * the UI shows the proposal and the user accepts/rejects. Nothing is
 * inserted automatically.
 *
 * Rules are deterministic and ordered: header-keyword rules first, then
 * data-pattern rules. Denied (unreadable) cells are excluded from the
 * statistics; suggestions whose target cell is not writable are not
 * generated (§8).
 */

import {
  colToLetters,
  type InferenceContext,
  type RangeBounds,
} from './ports.js';
import { canWriteCell } from './permissions.js';
import {
  nextProposalId,
  type CellCoord,
  type Proposal,
} from './types.js';

export interface ColumnData {
  sheet: string;
  col: number;
  letter: string;
  header: string;
  /** 0-based row of the header. */
  headerRow: number;
  /** Data values below the header, in row order (denied cells excluded). */
  values: (string | number | boolean | null)[];
  /** 0-based first data row. */
  firstDataRow: number;
  /** 0-based last data row. */
  lastDataRow: number;
  /** True when a strict majority of non-empty values are numeric. */
  numeric: boolean;
}

export interface FormulaSuggestion {
  title: string;
  description: string;
  /** Full formula text with leading '=', ready for review. */
  formula: string;
  /** Where the formula would be inserted. */
  target: CellCoord;
  confidence: number;
}

export interface SuggestFormulasOptions {
  maxPerSheet?: number;
  /** Max rows a per-row rule (line total, full name) may propose for. */
  maxRows?: number;
}

// ---------------------------------------------------------------------------
// Column profiling
// ---------------------------------------------------------------------------

function isNumericValue(v: string | number | boolean | null): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Build ColumnData[] for every column with at least one data value. */
export function profileColumns(
  sheet: string,
  grid: { value: string | number | boolean | null; denied: boolean }[][],
  startRow: number,
  startCol: number,
  headerRow = 0,
): ColumnData[] {
  if (grid.length === 0) return [];
  const colCount = Math.max(...grid.map((r) => r.length));
  const out: ColumnData[] = [];
  for (let c = 0; c < colCount; c++) {
    const h = grid[headerRow]?.[c];
    const header = h && !h.denied && typeof h.value === 'string' ? h.value.trim() : '';
    const values: (string | number | boolean | null)[] = [];
    let first = -1;
    let last = -1;
    for (let r = headerRow + 1; r < grid.length; r++) {
      const cell = grid[r]?.[c];
      if (!cell || cell.denied) continue;
      const v = cell.value;
      if (v === null || v === undefined || v === '') continue;
      if (first < 0) first = r;
      last = r;
      values.push(v);
    }
    if (first < 0) continue;
    const numericCount = values.filter(isNumericValue).length;
    out.push({
      sheet,
      col: startCol + c,
      letter: colToLetters(startCol + c),
      header,
      headerRow: startRow + headerRow,
      values,
      firstDataRow: startRow + first,
      lastDataRow: startRow + last,
      numeric: numericCount * 2 > values.length,
    });
  }
  return out;
}

/** A1 range covering the column's data rows, e.g. 'B2:B41'. Unqualified: the
 *  suggestion always targets the same sheet as the column. */
export function columnDataRange(col: ColumnData): string {
  const range = `${col.letter}${col.firstDataRow + 1}:${col.letter}${col.lastDataRow + 1}`;
  return range;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

type Rule = (cols: ColumnData[], grid: GridLike) => FormulaSuggestion[];

interface GridLike {
  rows: number;
  cols: number;
  emptyAt: (row: number, col: number) => boolean;
}

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const HEADER_KEYWORDS: { fn: string; title: string; match: RegExp }[] = [
  { fn: 'SUM', title: 'Sum', match: /\b(total|sum|subtotal|amount)\b/ },
  { fn: 'AVERAGE', title: 'Average', match: /\b(average|avg|mean)\b/ },
  { fn: 'MIN', title: 'Minimum', match: /\b(min|minimum|lowest)\b/ },
  { fn: 'MAX', title: 'Maximum', match: /\b(max|maximum|highest)\b/ },
  { fn: 'MEDIAN', title: 'Median', match: /\bmedian\b/ },
];

/** Header-keyword rule: 'Total' -> =SUM(...), 'Average' -> =AVERAGE(...). */
function headerKeywordRule(cols: ColumnData[], grid: GridLike): FormulaSuggestion[] {
  const out: FormulaSuggestion[] = [];
  for (const col of cols) {
    const norm = normalizeHeader(col.header);
    if (!norm) continue;
    for (const kw of HEADER_KEYWORDS) {
      if (!kw.match.test(norm)) continue;
      if (!col.numeric && (kw.fn === 'SUM' || kw.fn === 'AVERAGE' || kw.fn === 'MEDIAN')) continue;
      const targetRow = col.lastDataRow + 1;
      if (!grid.emptyAt(targetRow, col.col)) continue;
      const range = columnDataRange(col);
      out.push({
        title: `${kw.title} of ${col.header || col.letter}`,
        description:
          `The header "${col.header}" suggests a ${kw.fn.toLowerCase()} aggregate. ` +
          `Proposes =${kw.fn}(${range}) in the first empty cell below the column.`,
        formula: `=${kw.fn}(${range})`,
        target: { sheet: col.sheet, row: targetRow, col: col.col },
        confidence: 0.9,
      });
      break; // one keyword per column
    }
    // Count rule depends on the column's data type.
    if (/\b(count|number of|qty)\b/.test(norm)) {
      const fn = col.numeric ? 'COUNT' : 'COUNTA';
      const targetRow = col.lastDataRow + 1;
      if (!grid.emptyAt(targetRow, col.col)) continue;
      const range = columnDataRange(col);
      out.push({
        title: `Count of ${col.header || col.letter}`,
        description:
          `The header "${col.header}" suggests counting entries. ` +
          `Proposes =${fn}(${range}) in the first empty cell below the column.`,
        formula: `=${fn}(${range})`,
        target: { sheet: col.sheet, row: targetRow, col: col.col },
        confidence: 0.85,
      });
    }
  }
  return out;
}

/**
 * Total-row rule: a numeric column with no keyword header still gets a
 * =SUM proposal in the empty cell directly below its data.
 */
function totalRowRule(cols: ColumnData[], grid: GridLike): FormulaSuggestion[] {
  const out: FormulaSuggestion[] = [];
  for (const col of cols) {
    if (!col.numeric || col.values.length < 2) continue;
    const norm = normalizeHeader(col.header);
    if (HEADER_KEYWORDS.some((kw) => kw.match.test(norm))) continue; // already covered
    if (/\b(count|number of|qty)\b/.test(norm)) continue; // count rule covers this
    const targetRow = col.lastDataRow + 1;
    if (!grid.emptyAt(targetRow, col.col)) continue;
    const range = columnDataRange(col);
    out.push({
      title: `Total of ${col.header || col.letter}`,
      description:
        `Column ${col.letter} holds ${col.values.length} numbers with no total. ` +
          `Proposes =SUM(${range}) in the first empty cell below the data.`,
      formula: `=SUM(${range})`,
      target: { sheet: col.sheet, row: targetRow, col: col.col },
      confidence: 0.7,
    });
  }
  return out;
}

/** Quantity x Price rule: adjacent qty/price columns -> per-row line totals. */
function lineTotalRule(cols: ColumnData[], grid: GridLike, maxRows: number): FormulaSuggestion[] {
  const out: FormulaSuggestion[] = [];
  for (let i = 0; i + 1 < cols.length; i++) {
    const a = cols[i];
    const b = cols[i + 1];
    const na = normalizeHeader(a.header);
    const nb = normalizeHeader(b.header);
    const aIsQty = /\b(qty|quantity|units|count)\b/.test(na);
    const bIsPrice = /\b(price|unit price|rate|cost)\b/.test(nb);
    const bIsQty = /\b(qty|quantity|units|count)\b/.test(nb);
    const aIsPrice = /\b(price|unit price|rate|cost)\b/.test(na);
    let qty: ColumnData | null = null;
    let price: ColumnData | null = null;
    if (aIsQty && bIsPrice) { qty = a; price = b; }
    else if (bIsQty && aIsPrice) { qty = b; price = a; }
    else continue;
    if (!qty.numeric || !price.numeric) continue;
    const targetCol = Math.max(a.col, b.col) + 1;
    const firstRow = Math.max(qty.firstDataRow, price.firstDataRow);
    const lastRow = Math.min(qty.lastDataRow, price.lastDataRow);
    if (lastRow - firstRow + 1 > maxRows) continue;
    const targets: CellCoord[] = [];
    for (let r = firstRow; r <= lastRow; r++) {
      if (grid.emptyAt(r, targetCol)) targets.push({ sheet: a.sheet, row: r, col: targetCol });
    }
    if (targets.length === 0) continue;
    const first = targets[0];
    const formula = `=${qty.letter}${first.row + 1}*${price.letter}${first.row + 1}`;
    out.push({
      title: `Line totals (${qty.header} × ${price.header})`,
      description:
        `Adjacent "${qty.header}" and "${price.header}" columns suggest per-row ` +
          `line totals. Proposes ${formula} (filled down ${targets.length} rows) ` +
          `in column ${colToLetters(targetCol)}.`,
      formula,
      target: first,
      confidence: 0.8,
    });
    // Represent the fill-down as follow-on info in the description; the
    // proposal targets the first cell and the UI fill gesture extends it.
    void targets;
  }
  return out;
}

/** First name + Last name rule: -> ="A2 & " " & B2" full-name column. */
function fullNameRule(cols: ColumnData[], grid: GridLike, maxRows: number): FormulaSuggestion[] {
  const out: FormulaSuggestion[] = [];
  for (let i = 0; i + 1 < cols.length; i++) {
    const a = cols[i];
    const b = cols[i + 1];
    if (a.numeric || b.numeric) continue;
    const na = normalizeHeader(a.header);
    const nb = normalizeHeader(b.header);
    const isFirstLast =
      (/\bfirst\b/.test(na) && /\blast\b/.test(nb)) ||
      (/\bgiven\b/.test(na) && /\b(family|surname)\b/.test(nb));
    if (!isFirstLast) continue;
    const targetCol = b.col + 1;
    const firstRow = Math.max(a.firstDataRow, b.firstDataRow);
    const lastRow = Math.min(a.lastDataRow, b.lastDataRow);
    if (lastRow - firstRow + 1 > maxRows) continue;
    if (!grid.emptyAt(firstRow, targetCol)) continue;
    const formula = `=${a.letter}${firstRow + 1}&" "&${b.letter}${firstRow + 1}`;
    out.push({
      title: `Full name (${a.header} + ${b.header})`,
      description:
        `Adjacent "${a.header}" and "${b.header}" columns suggest a full-name ` +
          `column. Proposes ${formula} in column ${colToLetters(targetCol)}.`,
      formula,
      target: { sheet: a.sheet, row: firstRow, col: targetCol },
      confidence: 0.8,
    });
  }
  return out;
}

const RULES: ((cols: ColumnData[], grid: GridLike, maxRows: number) => FormulaSuggestion[])[] = [
  (c, g) => headerKeywordRule(c, g),
  (c, g) => totalRowRule(c, g),
  (c, g, m) => lineTotalRule(c, g, m),
  (c, g, m) => fullNameRule(c, g, m),
];

// ---------------------------------------------------------------------------
// Sheet-level entry point
// ---------------------------------------------------------------------------

/**
 * Suggest formulas for one sheet. Reads the used range through the typed
 * view (denied cells excluded), runs the deterministic rules, and returns
 * suggestions as inspectable proposals. Suggestions targeting cells the
 * principal may not write are not generated.
 */
export function suggestFormulasForSheet(
  ctx: InferenceContext,
  sheet: string,
  opts: SuggestFormulasOptions = {},
): Proposal[] {
  const maxPerSheet = opts.maxPerSheet ?? 10;
  const maxRows = opts.maxRows ?? 500;
  const used = ctx.usedRange(sheet);
  if (!used) return [];
  const bounds: RangeBounds = {
    startRow: used.startRow,
    startCol: used.startCol,
    endRow: Math.min(used.endRow, used.startRow + 5000),
    endCol: used.endCol,
  };
  const grid = ctx.read(sheet, bounds);
  const cols = profileColumns(sheet, grid, bounds.startRow, bounds.startCol);
  const gridLike: GridLike = {
    rows: grid.length,
    cols: Math.max(...grid.map((r) => r.length), 0),
    emptyAt: (row, col) => {
      const r = row - bounds.startRow;
      const c = col - bounds.startCol;
      if (r < 0 || c < 0 || r >= grid.length) return true;
      const cell = grid[r]?.[c];
      if (!cell || cell.denied) return true;
      return cell.value === null || cell.value === undefined || cell.value === '';
    },
  };
  const suggestions: FormulaSuggestion[] = [];
  for (const rule of RULES) {
    for (const s of rule(cols, gridLike, maxRows)) {
      if (!canWriteCell(ctx.authorize, s.target)) continue; // §8: not generated
      suggestions.push(s);
      if (suggestions.length >= maxPerSheet) break;
    }
    if (suggestions.length >= maxPerSheet) break;
  }
  return suggestions.map((s) => suggestionToProposal(s));
}

function suggestionToProposal(s: FormulaSuggestion): Proposal {
  const before = '';
  return {
    id: nextProposalId('formula'),
    kind: 'formula',
    title: s.title,
    description: `${s.description} Review the full formula before inserting: ${s.formula}`,
    edits: [{ kind: 'setFormula', at: s.target, formula: s.formula }],
    preview: [{ at: s.target, before, after: s.formula }],
    previewTotal: 1,
    confidence: s.confidence,
    reversible: true,
    bulk: false,
  };
}
