/**
 * Excel number-format import + rendering.
 *
 * Read path: SheetJS is asked for number-format strings (`cellNF: true`),
 * which makes it resolve every cell's style index through xl/styles.xml —
 * built-in numFmtIds 0-163 per the OOXML spec plus custom <numFmt> entries
 * mapped via <cellXfs> — into `cell.z` (the format code string). Reading
 * `cell.z` therefore IS the styles.xml → numFmtId → formatCode mapping,
 * done by the same parser that reads the values, so the two can never
 * disagree (no parallel hand-rolled copy of the 164 built-in codes).
 *
 * Render path: `formatWithCode` interprets an Excel format code through
 * SheetJS's SSF formatter — a real, complete interpreter for the format
 * language: positive;negative;zero;text sections, escaped (`\(`, `\-`) and
 * quoted ("...") literals, `_x` padding and `*x` fill, `%` scaling,
 * thousands separators, decimal placeholders, `# ?/?` fractions,
 * scientific notation, and date/time codes over Excel serials.
 */
import * as XLSX from 'xlsx';

/** Excel's default format: numbers render with ~10 significant digits. */
export const GENERAL_FORMAT_CODE = 'General';

interface SsfApi {
  format(fmt: string, value: number, opts?: { date1904?: boolean }): string;
}

/**
 * Resolve SheetJS's SSF formatter. `import * as XLSX` interop differs by
 * runtime: under Node ESM the CJS named-export lexer does not see SSF on the
 * namespace (it lives on the default export), while bundlers (Vite/rollup)
 * expose it directly. Resolve once at module load; undefined only when the
 * xlsx module itself is broken (in which case read() already failed).
 */
function resolveSsf(): SsfApi | undefined {
  const ns = XLSX as unknown as { SSF?: SsfApi; default?: { SSF?: SsfApi } };
  return ns.SSF ?? ns.default?.SSF;
}

const SSF = resolveSsf();

/**
 * The number format code for a SheetJS cell object (`cell.z`), or undefined
 * when the cell has no explicit format (General — the default rendering).
 */
export function cellFormatCode(cell: { z?: unknown } | undefined | null): string | undefined {
  const z = cell?.z;
  // Some producers (ClosedXML) spell the default format "GENERAL"; it is
  // the same default and must not enter the formats map as a custom code.
  if (typeof z !== 'string' || z === '' || z.toLowerCase() === 'general') return undefined;
  return z;
}

/**
 * Render a numeric value through an Excel number format code.
 *
 * `formatCode` undefined/empty means General: Excel shows up to 10
 * significant digits and switches to scientific notation for very
 * large/small magnitudes (e.g. 2082088.1744066 -> "2082088.174").
 *
 * `*x` fill sequences are stripped before formatting: fill pads to the
 * cell width, which a value-to-string renderer has no notion of (Excel's
 * TEXT() behaves the same way). `_x` padding renders as a space, exactly
 * like Excel.
 *
 * Unknown or unparseable codes fall back to plain String(value).
 * Never throws, never returns a non-string.
 */
export function formatWithCode(value: number, formatCode?: string): string {
  if (!Number.isFinite(value)) return String(value);
  let code = formatCode && formatCode.length > 0 ? formatCode : GENERAL_FORMAT_CODE;
  // Strip fill (`*` + char) unless the `*` itself is backslash-escaped.
  if (code.includes('*')) code = code.replace(/(?<!\\)\*./g, '');
  try {
    // SSF may be unreachable only when the xlsx module failed to load, in
    // which case read() already threw; still, never break rendering.
    const out: unknown = SSF ? SSF.format(code, value, { date1904: false }) : String(value);
    return typeof out === 'string' ? out : String(value);
  } catch {
    // A corrupt format code must never break rendering.
    return String(value);
  }
}
