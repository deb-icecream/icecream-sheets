/**
 * Defined-name (named range) rewriting.
 *
 * HyperFormula's addNamedExpression rejects names that look like cell
 * references (e.g. "Global1", "X1") — but these are perfectly valid Excel
 * defined names. Instead of registering named expressions, the adapter
 * rewrites name references in formulas to their A1 equivalents before the
 * formulas reach the engine.
 *
 * Example: =SUM(Global3) with Global3 -> Sheet1!$A$1:$A$4
 * becomes: =SUM(Sheet1!$A$1:$A$4)
 */

export interface DefinedNameInfo {
  name: string;
  ref: string;
  /** 0-based sheet index for sheet-scoped names; undefined = workbook scope. */
  sheet?: number;
}

// HyperFormula's named-expression validity rule (see NamedExpressions.js
// isNameValid): a name is rejected when it matches the A1 heuristic
// ([A-Za-z]+[0-9]+ — ANY letters+digits, not just real cell refs) or the
// R1C1 heuristic. Excel allows such names (e.g. "Global1"), so the adapter
// can only bind the rest as true named expressions.
const HF_A1_HEURISTIC = /^[A-Za-z]+[0-9]+$/;
const HF_R1C1_HEURISTIC = /^[rR][0-9]*[cC][0-9]*$/;
const HF_NAME_SHAPE = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/**
 * True when HyperFormula can register this name as a named expression.
 * Names failing this (Excel-valid, HF-rejected like "Global1") are
 * rewritten to A1 at import — the narrow fallback that keeps those files'
 * formulas computing.
 */
export function isEngineBindableName(name: string): boolean {
  if (!HF_NAME_SHAPE.test(name)) return false;
  if (HF_A1_HEURISTIC.test(name) || HF_R1C1_HEURISTIC.test(name)) return false;
  return true;
}

/**
 * Rewrite defined-name references in a formula to A1 ranges.
 * `sheetName`/`sheetIndex` identify the sheet holding the formula (for
 * sheet-scoped name resolution). `sheetNames` maps scope indices to names.
 */
export function rewriteDefinedNames(
  formula: string,
  sheetName: string,
  sheetIndex: number,
  sheetNames: string[],
  names: DefinedNameInfo[],
): string {
  if (!names.length) return formula;
  // Build scope-resolved map: sheet-scoped names shadow workbook names.
  const scoped = new Map<string, string>();
  const global = new Map<string, string>();
  for (const n of names) {
    const key = n.name.toLowerCase();
    const ref = resolveRef(n.ref, sheetNames);
    if (ref === null) continue;
    if (n.sheet === undefined) {
      if (!global.has(key)) global.set(key, ref);
    } else if (n.sheet === sheetIndex) {
      if (!scoped.has(key)) scoped.set(key, ref);
    }
  }
  if (scoped.size === 0 && global.size === 0) return formula;
  // Longer names first to avoid prefix shadowing (e.g. "MyName" vs "MyName2").
  const all = [...scoped.entries(), ...[...global.entries()].filter(([k]) => !scoped.has(k))];
  all.sort((a, b) => b[0].length - a[0].length);
  // Resolve chained names (name -> name) up to a fixed depth.
  const resolved = new Map<string, string>();
  for (const [key, ref] of all) {
    resolved.set(key, resolveChain(ref, all, 5));
  }
  // Replace occurrences outside string literals. Scan with an inString
  // flag so "" escapes (a literal quote inside a string) keep the string
  // open — a naive formula.split('"') would treat the text between two
  // escaped quotes as code and clobber a name inside it.
  const segments = splitCodeAndStrings(formula);
  for (const seg of segments) {
    if (seg.inString) continue;
    let t = seg.text;
    for (const [key, ref] of resolved) {
      // \b doesn't work well with names containing _ or digits at edges;
      // use explicit boundary checks: not preceded/followed by [A-Za-z0-9_.!].
      const re = new RegExp(`(?<![A-Za-z0-9_.!])${escapeReg(key)}(?![A-Za-z0-9_])`, 'gi');
      t = t.replace(re, ref);
    }
    seg.text = t;
  }
  return segments.map((s) => s.text).join('');
}

/**
 * Split a formula into string-literal and code segments. Two consecutive
 * quotes inside a string are an escaped quote (the string stays open).
 */
function splitCodeAndStrings(formula: string): { text: string; inString: boolean }[] {
  const segments: { text: string; inString: boolean }[] = [];
  let cur = '';
  let inString = false;
  const flush = () => {
    if (cur) segments.push({ text: cur, inString });
    cur = '';
  };
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i]!;
    if (inString) {
      cur += ch;
      if (ch === '"') {
        if (formula[i + 1] === '"') {
          // Escaped quote: consume both, stay inside the string.
          cur += '"';
          i += 2;
          continue;
        }
        flush();
        inString = false;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      flush();
      cur += ch;
      inString = true;
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  flush();
  return segments;
}

/** Convert a defined-name ref to an A1 expression. Returns null if unusable. */
function resolveRef(ref: string, sheetNames: string[]): string | null {
  const r = ref.trim();
  if (!r || /#REF!/.test(r)) return null;
  if (r.startsWith('=')) return resolveRef(r.slice(1), sheetNames);
  // Array constant: {1,2,3}
  if (r.startsWith('{')) return r;
  // Already A1 (may be sheet-qualified): Sheet1!$A$1
  if (/^('[^']+'|[A-Za-z_][A-Za-z0-9_.]*)?!?\$?[A-Z]+\$?\d+/i.test(r) || /^\$?[A-Z]+\$?\d+(:\$?[A-Z]+\$?\d+)?$/i.test(r)) {
    return r;
  }
  // Bare name reference (name -> name): return as-is for chain resolution.
  if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(r)) return r;
  return null;
}

/** Resolve name->name chains. */
function resolveChain(
  ref: string,
  all: [string, string][],
  depth: number,
): string {
  if (depth <= 0) return ref;
  if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(ref) && !/^\$?[A-Z]+\$?\d+$/i.test(ref)) {
    const key = ref.toLowerCase();
    const target = all.find(([k]) => k === key)?.[1];
    if (target && target.toLowerCase() !== key) return resolveChain(target, all, depth - 1);
  }
  return ref;
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
