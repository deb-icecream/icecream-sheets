/**
 * Extended conditional formatting rules (top N / bottom N / above average,
 * data bars, color scales, icon sets).
 *
 * This extends the cell-value CFRule model in models.ts without modifying it.
 * Evaluation helpers here are pure: they take plain numeric values and return
 * styling decisions, so the grid can render them without touching the engine.
 */

export type CFKind = 'cell' | 'topN' | 'dataBar' | 'colorScale' | 'iconSet' | 'formula';

export interface ExtCFRule {
  id: number;
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  kind: CFKind;
  /** topN: 'top' | 'bottom' (default 'top'), n (default 10); aboveAverage selects average rule. */
  topBottom?: 'top' | 'bottom';
  n?: number;
  aboveAverage?: boolean;
  /** dataBar: bar fill color; colorScale: color = low, color2 = high. */
  color?: string;
  color2?: string;
  /** iconSet: only 'arrows3' (3 arrows) is supported for now. */
  iconSet?: 'arrows3';
  /**
   * formula: for kind 'formula' — an Excel-style boolean formula written
   * relative to the rule's top-left cell ("Use a formula to determine which
   * cells to format"). Each cell in the range evaluates the formula with
   * references shifted by its offset from the top-left corner.
   */
  formula?: string;
}

let extCFId = 1;

/** Create an extended CF rule with an auto-incremented id. */
export function makeExtCFRule(rule: Omit<ExtCFRule, 'id'>): ExtCFRule {
  return { ...rule, id: extCFId++ };
}

// ---------------------------------------------------------------------------
// Top N / Bottom N / Above Average
// ---------------------------------------------------------------------------

/**
 * For a column/row of numeric values, return a boolean per index indicating
 * whether the cell matches the rule. Ties at the cutoff are all marked
 * (Excel ranks ties equally), so more than n cells may match when values tie.
 * Non-finite values never match. An empty input returns an all-false array.
 */
export function topNMatches(values: number[], rule: ExtCFRule): boolean[] {
  const result = values.map(() => false);
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return result;

  if (rule.aboveAverage) {
    const avg = finite.reduce((a, b) => a + b, 0) / finite.length;
    return values.map((v) => Number.isFinite(v) && v > avg);
  }

  const n = Math.max(1, Math.floor(rule.n ?? 10));
  const sorted = [...finite].sort((a, b) => b - a);
  const cutoffIndex = Math.min(n, sorted.length) - 1;
  const cutoff = sorted[cutoffIndex];
  const top = rule.topBottom !== 'bottom';
  return values.map((v) => Number.isFinite(v) && (top ? v >= cutoff : v <= sorted[sorted.length - 1 - cutoffIndex]));
}

// ---------------------------------------------------------------------------
// Data bars
// ---------------------------------------------------------------------------

/** Bar width as a 0..100 percentage of the [min, max] range, clamped. */
export function dataBarWidth(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) return 0;
  if (max <= min) return 100;
  const pct = ((value - min) / (max - min)) * 100;
  return Math.min(100, Math.max(0, pct));
}

// ---------------------------------------------------------------------------
// Color scales
// ---------------------------------------------------------------------------

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHex(hex: string): Rgb | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const s = /^#([0-9a-fA-F]{3})$/.exec(hex.trim());
  if (s) {
    const [r, g, b] = s[1].split('');
    return {
      r: parseInt(r + r, 16),
      g: parseInt(g + g, 16),
      b: parseInt(b + b, 16),
    };
  }
  return null;
}

function toHex({ r, g, b }: Rgb): string {
  const h = (v: number): string => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toLowerCase();
}

/**
 * Interpolate between lowColor and highColor by the value's position in
 * [min, max]. Returns a lowercase 6-digit hex string. Falls back to lowColor
 * when either color is not a parseable hex color.
 */
export function colorScaleColor(
  value: number,
  min: number,
  max: number,
  lowColor: string,
  highColor: string,
): string {
  const lo = parseHex(lowColor);
  const hi = parseHex(highColor);
  if (!lo || !hi) return lowColor;
  let t = 0;
  if (Number.isFinite(value) && Number.isFinite(min) && Number.isFinite(max) && max > min) {
    t = (value - min) / (max - min);
  }
  t = Math.min(1, Math.max(0, t));
  return toHex({
    r: lo.r + (hi.r - lo.r) * t,
    g: lo.g + (hi.g - lo.g) * t,
    b: lo.b + (hi.b - lo.b) * t,
  });
}

// ---------------------------------------------------------------------------
// Icon sets
// ---------------------------------------------------------------------------

/**
 * Which of the three arrows a value earns, splitting [min, max] into thirds.
 * Degenerate ranges (max <= min) or non-finite values yield 'flat'.
 */
export function iconFor(value: number, min: number, max: number): 'up' | 'flat' | 'down' {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return 'flat';
  }
  const third = (max - min) / 3;
  if (value >= max - third) return 'up';
  if (value <= min + third) return 'down';
  return 'flat';
}

// ---------------------------------------------------------------------------
// Range helpers
// ---------------------------------------------------------------------------

/**
 * Collect finite numeric values over a rule's rectangle. Non-finite values
 * (blanks, text, errors) are skipped; order is row-major.
 */
export function collectNumericValues(
  getValue: (r: number, c: number) => number | null,
  rule: ExtCFRule,
): number[] {
  const out: number[] = [];
  for (let r = rule.startRow; r <= rule.endRow; r++) {
    for (let c = rule.startCol; c <= rule.endCol; c++) {
      const v = getValue(r, c);
      if (v !== null && Number.isFinite(v)) out.push(v);
    }
  }
  return out;
}

/** [min, max] over a rule's rectangle, or null when no numeric values exist. */
export function cfRangeMinMax(
  getValue: (r: number, c: number) => number | null,
  rule: ExtCFRule,
): [number, number] | null {
  const values = collectNumericValues(getValue, rule);
  if (values.length === 0) return null;
  let min = values[0];
  let max = values[0];
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return [min, max];
}

/** True when the rule's kind renders per-cell styling rather than a boolean match. */
export function isVisualCFKind(kind: CFKind): boolean {
  return kind === 'dataBar' || kind === 'colorScale' || kind === 'iconSet';
}
