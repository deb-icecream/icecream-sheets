/**
 * OFFSET with dynamic arguments.
 *
 * HyperFormula's built-in OFFSET requires the rows/cols arguments to be
 * static numbers at parse time ("Second argument to OFFSET is not a static
 * number"). Excel allows cell references (e.g. =OFFSET(N43,$E$9,0)).
 *
 * This module rewrites OFFSET formulas whose row/col arguments are simple
 * cell references to literal numbers, substituting the referenced cell's
 * literal value at load time. Only applies when the referenced cell contains
 * a plain numeric literal (not a formula) — otherwise the formula is left
 * as-is and HyperFormula will report the parse error.
 *
 * Limitation: the substituted value is baked in at load; if the referenced
 * cell later changes, the OFFSET won't update. This matches the file-load
 * use case (assumption cells like $E$9 are constants).
 */

/**
 * Rewrite OFFSET formulas with cell-ref args to literal args.
 * `getCell` returns the raw CellInput at (row, col) on the given sheet.
 */
export function rewriteOffsetLiterals(
  formula: string,
  getCell: (row: number, col: number) => unknown,
): string {
  if (!/OFFSET\s*\(/i.test(formula)) return formula;
  // Match OFFSET( ref , arg2 , arg3 [, height [, width]] ) — rewrite only
  // arg2/arg3 when they're cell refs to numeric literals.
  return formula.replace(
    /OFFSET\s*\(\s*([^,()]+)\s*,\s*([^,()]+)\s*,\s*([^,()]+)/gi,
    (match, ref, arg2, arg3) => {
      const r2 = tryResolveArg(String(arg2).trim(), getCell);
      const r3 = tryResolveArg(String(arg3).trim(), getCell);
      if (r2 === null || r3 === null) return match;
      return `OFFSET(${ref},${r2},${r3}`;
    },
  );
}

/** If arg is a cell ref to a numeric literal, return the number. Else null. */
function tryResolveArg(arg: string, getCell: (row: number, col: number) => unknown): number | null {
  // Already a number (possibly negative/decimal).
  if (/^-?\d+(\.\d+)?$/.test(arg)) return parseFloat(arg);
  // Simple cell ref: $E$9, E9, $E9, E$9 (no sheet prefix, no range).
  const m = arg.match(/^\$?([A-Z]+)\$?(\d+)$/i);
  if (!m) return null;
  const col = colToIndex(m[1]!);
  const row = parseInt(m[2]!, 10) - 1;
  const v = getCell(row, col);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

function colToIndex(col: string): number {
  let n = 0;
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
