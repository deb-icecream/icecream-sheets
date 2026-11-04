/**
 * OLAP cube functions — CUBEVALUE, CUBEMEMBER, CUBESET, CUBERANKEDMEMBER,
 * CUBEKPIMEMBER, CUBEMEMBERPROPERTY, CUBESETCOUNT. All real implementations
 * (no-stub policy, 2026-10-18).
 *
 * The pivot engine is the local OLAP cube (per TODO.md PART 7): hosts adapt
 * a service PivotResult into the engine-local OlapCube shape (see
 * cubeFromPivot()) and register it under a connection name. The cube
 * functions then resolve member tuples against the cube's aggregations.
 *
 * Member expressions use MDX-style bracket syntax:
 *   [Measures].[Sum of Amount]   — a measure. Measures are members of the
 *                                  Measures dimension, so CUBEMEMBER accepts
 *                                  them too (Excel does the same).
 *   [Region].[West]              — a dimension member
 *   [Region].[Geo].&[West]       — a member by key: the middle hierarchy
 *                                  segment is accepted and ignored, the key
 *                                  is matched against member labels
 *   [Region].[Geo].[All]         — the All member: grand total over the
 *                                  dimension (never stored explicitly)
 *   ([Region].[West],[Product].[Bikes]) — a tuple (CUBEVALUE/CUBEMEMBER)
 *   [Region]                     — a dimension (not a valid member reference)
 *   West                         — a plain label, resolved against every
 *                                  dimension (must be unambiguous)
 *
 * CUBEMEMBER returns the canonical "[Dim].[Member]" string (or
 * "([D1].[M1],[D2].[M2])" for tuples), which CUBEVALUE and friends accept.
 * CUBESET returns an opaque JSON set handle that CUBERANKEDMEMBER /
 * CUBESETCOUNT accept (inline braced set expressions are also accepted
 * wherever a set is expected).
 *
 * Caption arguments (CUBEMEMBER / CUBERANKEDMEMBER / CUBESET / CUBEKPIMEMBER)
 * are accepted for compatibility but do not change the computed value:
 * Excel displays the caption in the cell while keeping the member identity
 * for downstream CUBE references; the engine likewise returns the canonical
 * member expression so chained references such as CUBEVALUE(conn, $A$1)
 * keep resolving.
 *
 * Graceful degradation — there is no live cube connection in the local
 * engine, so every failure surfaces as a cell error, never a crash and never
 * a silent wrong value:
 * - Unknown connection name → #N/A naming registerCube() (Excel shows #N/A
 *   for a missing connection; #GETTING_DATA is reserved for an async fetch
 *   still in flight, which the local engine never performs).
 * - Unknown member / measure / dimension → #N/A naming the offender.
 * - CUBERANKEDMEMBER: non-numeric rank or rank < 1 → #VALUE!; rank beyond
 *   the set size → #N/A.
 * - CUBESET: sort_order outside 0–6 → #VALUE!; unresolvable member → #N/A.
 * - CUBESETCOUNT: accepts a CUBESET handle or a braced inline set expression
 *   (counted syntactically — no connection needed); anything else → #VALUE!.
 *
 * Unlike batches 8-10 this module does NOT self-register on import: hosts
 * call registerCubeFunctions() explicitly (it is idempotent).
 */
import {
  CellError,
  EmptyValue,
  ErrorType,
  FunctionArgumentType,
  FunctionPlugin,
  HyperFormula,
} from 'hyperformula';
import type { ProcedureAst } from 'hyperformula/typings/parser/Ast.js';
import type { InterpreterState } from 'hyperformula/typings/interpreter/InterpreterState.js';
import type { InterpreterValue } from 'hyperformula/typings/interpreter/InterpreterValue.js';
import type { PivotResultLike } from './extended-functions9.js';

// ---------------------------------------------------------------------------
// Small value helpers (local copies — keep this module dependency-free).
// ---------------------------------------------------------------------------

type Arg = { argumentType: FunctionArgumentType; optionalArg?: boolean };
const S = (optionalArg = false): Arg => ({ argumentType: FunctionArgumentType.SCALAR, optionalArg });

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** "Sum of Amount" -> "amount". */
function stripAgg(label: string): string {
  return label
    .replace(/^(sum|counta?|average|avg|min|max|product|stdev\.?p?|var\.?p?)\s+of\s+/i, '')
    .trim()
    .toLowerCase();
}

function scalarText(v: InterpreterValue): string {
  if (v === EmptyValue) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function asVal(v: unknown): InterpreterValue {
  return v as unknown as InterpreterValue;
}

// ---------------------------------------------------------------------------
// OLAP cube model + registry (engine-local; hosts adapt service data).
// ---------------------------------------------------------------------------

/** KPI components, following Excel's CUBEKPIMEMBER property codes. */
export interface OlapKpi {
  /** 1 = KPIValue */
  value: number | null;
  /** 2 = KPIGoal */
  goal: number | null;
  /** 3 = KPIStatus */
  status: number | null;
  /** 4 = KPITrend */
  trend: number | null;
  /** 5 = KPIWeight */
  weight?: number | null;
  /** 6 = KPICurrentTimeMember — an MDX member expression, e.g. "[Time].[2024]" */
  currentTimeMember?: string | null;
}

/**
 * Minimal OLAP cube shape. Deliberately defined locally — importing
 * @icecream-sheets/service here would create a circular dependency.
 * Hosts adapt the service PivotResult via cubeFromPivot().
 */
export interface OlapCube {
  /** Connection name used as the first argument of the CUBE* functions. */
  name: string;
  /** Measure labels, e.g. ["Sum of Amount"]. */
  measures: string[];
  /** Dimension names, e.g. ["Region", "Product"]. */
  dimensions: string[];
  /** Dimension name -> member labels. */
  members: Record<string, string[]>;
  /** KPI name -> components (optional). */
  kpis?: Record<string, OlapKpi>;
  /**
   * Resolve (measure, dimension->member coords) to an aggregated value.
   * Returns null when the tuple is valid but has no data.
   * Should throw (or return null) for unknown measures — the caller maps
   * null to #N/A.
   */
  getValue(measure: string, coords: Record<string, string>): number | null;
}

const cubeRegistry = new Map<string, OlapCube>();

/** Register (or replace) an OLAP cube under its connection name. */
export function registerCube(cube: OlapCube): void {
  cubeRegistry.set(norm(cube.name), cube);
}

/** Remove a cube from the registry. */
export function unregisterCube(name: string): void {
  cubeRegistry.delete(norm(name));
}

/** Remove all cubes (tests). */
export function clearCubes(): void {
  cubeRegistry.clear();
}

/** List registered connection names. */
export function listCubes(): string[] {
  return [...cubeRegistry.values()].map((c) => c.name);
}

function getCube(name: string): OlapCube | undefined {
  return cubeRegistry.get(norm(name));
}

// ---------------------------------------------------------------------------
// cubeFromPivot — adapt a PivotResultLike into an OlapCube.
// ---------------------------------------------------------------------------

/** Find a key-tuple index where every non-null target matches (case-insensitive). */
function findKeyIndexLocal(keys: string[][], targets: (string | null)[]): number {
  return keys.findIndex(
    (k) =>
      k.length === targets.length &&
      targets.every((t, i) => t === null || norm(k[i] ?? '') === norm(t)),
  );
}

/** Match a measure reference against the pivot's value labels. */
function matchMeasureLocal(pivot: PivotResultLike, name: string): number {
  const want = norm(name);
  let idx = pivot.valueLabels.findIndex((l) => norm(l) === want);
  if (idx >= 0) return idx;
  const stripped = stripAgg(name);
  idx = pivot.valueLabels.findIndex((l) => stripAgg(l) === stripped);
  return idx;
}

/**
 * Adapt a pivot result (the shape GETPIVOTDATA uses) into an OlapCube, so
 * pivot tables act as the local OLAP cube for the CUBE* functions.
 * Row/column fields become dimensions; value fields become measures.
 */
export function cubeFromPivot(pivot: PivotResultLike, name: string): OlapCube {
  const dimensions = [...pivot.rowFieldNames, ...pivot.colFieldNames];
  const members: Record<string, string[]> = {};
  pivot.rowFieldNames.forEach((f, i) => {
    members[f] = [...new Set(pivot.rowKeys.map((k) => k[i] ?? '(blank)'))];
  });
  pivot.colFieldNames.forEach((f, i) => {
    members[f] = [...new Set(pivot.colKeys.map((k) => k[i] ?? '(blank)'))];
  });
  return {
    name,
    measures: [...pivot.valueLabels],
    dimensions,
    members,
    getValue(measure: string, coords: Record<string, string>): number | null {
      const mi = matchMeasureLocal(pivot, measure);
      if (mi < 0) return null;
      for (const dim of Object.keys(coords)) {
        if (!dimensions.some((d) => norm(d) === norm(dim))) return null;
      }
      const rowTargets = pivot.rowFieldNames.map((f) => {
        const hit = Object.keys(coords).find((k) => norm(k) === norm(f));
        return hit === undefined ? null : coords[hit]!;
      });
      const colTargets = pivot.colFieldNames.map((f) => {
        const hit = Object.keys(coords).find((k) => norm(k) === norm(f));
        return hit === undefined ? null : coords[hit]!;
      });
      // NB: a field list may be empty (a pivot with only row fields); the
      // "full" flags require at least one field so vacuous truth on []
      // cannot route an empty side into a key lookup.
      const rowSpec = rowTargets.some((t) => t !== null);
      const colSpec = colTargets.some((t) => t !== null);
      const rowFull = rowTargets.length > 0 && rowTargets.every((t) => t !== null);
      const colFull = colTargets.length > 0 && colTargets.every((t) => t !== null);
      const at = (a: (number | null)[] | undefined, i: number): number | null =>
        a?.[i] ?? null;
      if (rowFull && colFull) {
        const ri = findKeyIndexLocal(pivot.rowKeys, rowTargets);
        const ci = findKeyIndexLocal(pivot.colKeys, colTargets);
        if (ri < 0 || ci < 0) return null;
        return pivot.data[ri]?.[ci]?.[mi] ?? null;
      }
      if (rowFull && !colSpec) {
        const ri = findKeyIndexLocal(pivot.rowKeys, rowTargets);
        if (ri < 0) return null;
        return at(pivot.rowTotals[ri], mi);
      }
      if (colFull && !rowSpec) {
        const ci = findKeyIndexLocal(pivot.colKeys, colTargets);
        if (ci < 0) return null;
        return at(pivot.colTotals[ci], mi);
      }
      if (!rowSpec && !colSpec) {
        return at(pivot.grandTotals, mi);
      }
      // Partial tuple: aggregate over the matching cells (real OLAP drill
      // semantics for a partially-specified coordinate). A missing key axis
      // is a single implicit column/row backed by the totals.
      const cellAt = (ri: number, ci: number): number | null => {
        if (pivot.colKeys.length === 0 && pivot.rowKeys.length === 0) {
          return at(pivot.grandTotals, mi);
        }
        if (pivot.colKeys.length === 0) return at(pivot.rowTotals[ri], mi);
        if (pivot.rowKeys.length === 0) return at(pivot.colTotals[ci], mi);
        return pivot.data[ri]?.[ci]?.[mi] ?? null;
      };
      let sum = 0;
      let found = false;
      const rowCount = Math.max(pivot.rowKeys.length, 1);
      const colCount = Math.max(pivot.colKeys.length, 1);
      for (let ri = 0; ri < rowCount; ri++) {
        if (
          pivot.rowKeys.length > 0 &&
          !rowTargets.every((t, i) => t === null || norm(pivot.rowKeys[ri]![i] ?? '') === norm(t))
        ) {
          continue;
        }
        for (let ci = 0; ci < colCount; ci++) {
          if (
            pivot.colKeys.length > 0 &&
            !colTargets.every(
              (t, i) => t === null || norm(pivot.colKeys[ci]![i] ?? '') === norm(t),
            )
          ) {
            continue;
          }
          const v = cellAt(ri, ci);
          if (typeof v === 'number') {
            sum += v;
            found = true;
          }
        }
      }
      return found ? sum : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Member-expression parsing.
// ---------------------------------------------------------------------------

type ParsedRef =
  | { kind: 'measure'; name: string }
  | { kind: 'member'; dim: string; hier: string | null; member: string; byKey: boolean }
  | { kind: 'dimension'; dim: string }
  | { kind: 'tuple'; refs: ParsedRef[] }
  | { kind: 'plain'; label: string };

const MEASURE_RE = /^\[Measures\]\.\[(.+)\]$/i;
const MEMBER3_RE = /^\[([^\]]+)\]\.\[([^\]]+)\]\.(&?)\[([^\]]+)\]$/;
const MEMBER2_RE = /^\[([^\]]+)\]\.\[([^\]]+)\]$/;
const DIM_RE = /^\[([^\]]+)\]$/;

function parseMemberExpr(text: string): ParsedRef | null {
  const t = text.trim();
  if (t === '') return null;
  // Tuple: "([D1].[M1],[D2].[M2])".
  if (t.startsWith('(') && t.endsWith(')')) {
    const refs: ParsedRef[] = [];
    for (const part of splitTopLevel(t.slice(1, -1))) {
      const p = part.trim();
      if (p === '') return null;
      const r = parseMemberExpr(p);
      if (!r || r.kind === 'tuple' || r.kind === 'dimension') return null;
      refs.push(r);
    }
    if (refs.length === 0) return null;
    return { kind: 'tuple', refs };
  }
  let m = MEASURE_RE.exec(t);
  if (m) return { kind: 'measure', name: m[1]!.trim() };
  // Three-part form "[Dim].[Hier].&[Key]" / "[Dim].[Hier].[Member]" — the
  // hierarchy segment is accepted and ignored; the key/member is matched
  // against the dimension's member labels.
  m = MEMBER3_RE.exec(t);
  if (m) {
    return {
      kind: 'member',
      dim: m[1]!.trim(),
      hier: m[2]!.trim(),
      member: m[4]!.trim(),
      byKey: m[3] === '&',
    };
  }
  m = MEMBER2_RE.exec(t);
  if (m) return { kind: 'member', dim: m[1]!.trim(), hier: null, member: m[2]!.trim(), byKey: false };
  m = DIM_RE.exec(t);
  if (m) return { kind: 'dimension', dim: m[1]!.trim() };
  return { kind: 'plain', label: t };
}

/** Canonical "[Dim].[Member]" form. */
function canonicalMember(dim: string, member: string): string {
  return `[${dim}].[${member}]`;
}

interface ResolvedMember {
  dim: string;
  member: string;
  /** True for measures ("[Measures].[X]" resolved via the measure list). */
  isMeasure?: boolean;
  /** True for the All member — grand total over the dimension. */
  isAll?: boolean;
}

type ResolveResult = ResolvedMember | { tuple: ResolvedMember[] } | { error: string };

function isResolveError(r: ResolveResult): r is { error: string } {
  return 'error' in r;
}

function isTupleResult(r: ResolveResult): r is { tuple: ResolvedMember[] } {
  return 'tuple' in r;
}

function canonicalResolved(m: ResolvedMember): string {
  return canonicalMember(m.dim, m.member);
}

function canonicalTuple(ms: ResolvedMember[]): string {
  return `(${ms.map(canonicalResolved).join(',')})`;
}

/**
 * Resolve a parsed member expression against a cube. Returns the resolved
 * member(s), or an error message. Measures resolve as members of the
 * "Measures" dimension (Excel parity — CUBEMEMBER accepts measures).
 */
function resolveParsed(cube: OlapCube, parsed: ParsedRef, originalText: string): ResolveResult {
  if (parsed.kind === 'measure') {
    const m = resolveMeasure(cube, parsed.name);
    if (typeof m !== 'string') return { error: m.error };
    return { dim: 'Measures', member: m, isMeasure: true };
  }
  if (parsed.kind === 'dimension') {
    return { error: `"${originalText}" is a dimension, not a member.` };
  }
  if (parsed.kind === 'tuple') {
    const out: ResolvedMember[] = [];
    for (const ref of parsed.refs) {
      const r = resolveParsed(cube, ref, originalText);
      if (isResolveError(r)) return r;
      if (isTupleResult(r)) return { error: `Nested tuples are not supported: "${originalText}".` };
      out.push(r);
    }
    return { tuple: out };
  }
  if (parsed.kind === 'member') {
    const dim = cube.dimensions.find((d) => norm(d) === norm(parsed.dim));
    if (!dim) return { error: `Unknown dimension "${parsed.dim}" in cube "${cube.name}".` };
    const member = (cube.members[dim] ?? []).find((x) => norm(x) === norm(parsed.member));
    if (member !== undefined) return { dim, member };
    // The All member is never stored explicitly: it means "grand total over
    // this dimension".
    if (norm(parsed.member) === 'all') return { dim, member: 'All', isAll: true };
    return { error: `Member "${parsed.member}" not found in dimension "${dim}".` };
  }
  // plain label: must resolve against exactly one dimension
  const hits: ResolvedMember[] = [];
  for (const dim of cube.dimensions) {
    const member = (cube.members[dim] ?? []).find((x) => norm(x) === norm(parsed.label));
    if (member !== undefined) hits.push({ dim, member });
  }
  if (hits.length === 0) return { error: `Member "${parsed.label}" not found in cube "${cube.name}".` };
  if (hits.length > 1) {
    return {
      error: `Member "${parsed.label}" is ambiguous — qualify it, e.g. [${hits[0]!.dim}].[${parsed.label}].`,
    };
  }
  return hits[0]!;
}

function resolveMember(cube: OlapCube, text: string): ResolveResult {
  const parsed = parseMemberExpr(text);
  if (!parsed) return { error: `Invalid member expression "${text}".` };
  return resolveParsed(cube, parsed, text);
}

function resolveMeasure(cube: OlapCube, text: string): string | { error: string } {
  const parsed = parseMemberExpr(text);
  const name = parsed && parsed.kind === 'measure' ? parsed.name : text;
  const hit = cube.measures.find((x) => norm(x) === norm(name) || stripAgg(x) === stripAgg(name));
  if (!hit) return { error: `Measure "${text}" not found in cube "${cube.name}".` };
  return hit;
}

// ---------------------------------------------------------------------------
// Set expressions.
// ---------------------------------------------------------------------------

interface CubeSet {
  cube: string;
  /** Each tuple is a list of member-expression strings. */
  tuples: string[][];
}

function isSetHandle(v: string): boolean {
  if (!v.trim().startsWith('{')) return false;
  try {
    const p = JSON.parse(v) as Record<string, unknown>;
    return p['$cubeSet'] === true && Array.isArray(p['tuples']);
  } catch {
    return false;
  }
}

function parseSetHandle(v: string): CubeSet | null {
  try {
    const p = JSON.parse(v) as { $cubeSet?: boolean; cube?: string; tuples?: string[][] };
    if (p.$cubeSet !== true || typeof p.cube !== 'string' || !Array.isArray(p.tuples)) {
      return null;
    }
    return { cube: p.cube, tuples: p.tuples };
  } catch {
    return null;
  }
}

function setHandle(set: CubeSet): string {
  return JSON.stringify({ $cubeSet: true, cube: set.cube, tuples: set.tuples });
}

/** Split on top-level commas (commas inside () or [] don't split). */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depthParen = 0;
  let depthBracket = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depthParen++;
    else if (ch === ')') depthParen--;
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket--;
    if (ch === ',' && depthParen === 0 && depthBracket === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

/**
 * Parse a set expression into tuples of member-expression strings.
 * Accepts "{([R].[East],[P].[Bikes]), ([R].[West],[P].[Bikes])}" or a plain
 * comma list "[R].[East], [R].[West]".
 */
function parseSetExpression(expr: string): string[][] | { error: string } {
  const t = expr.trim();
  const inner = t.startsWith('{') && t.endsWith('}') && !isSetHandle(t) ? t.slice(1, -1) : t;
  const parts = splitTopLevel(inner);
  const tuples: string[][] = [];
  for (const part of parts) {
    const pt = part.trim();
    if (pt === '') continue;
    if (pt.startsWith('(') && pt.endsWith(')')) {
      const members = splitTopLevel(pt.slice(1, -1))
        .map((x) => x.trim())
        .filter((x) => x !== '');
      if (members.length === 0) return { error: `Empty tuple in set expression "${expr}".` };
      tuples.push(members);
    } else {
      tuples.push([pt]);
    }
  }
  if (tuples.length === 0) return { error: `Empty set expression "${expr}".` };
  return tuples;
}

/** Resolve a set argument: either a CUBESET handle or an inline expression. */
function resolveSet(cube: OlapCube, arg: string): CubeSet | { error: string } {
  if (isSetHandle(arg)) {
    const set = parseSetHandle(arg);
    if (!set) return { error: `Invalid set handle.` };
    if (norm(set.cube) !== norm(cube.name)) {
      return { error: `Set belongs to cube "${set.cube}", not "${cube.name}".` };
    }
    return set;
  }
  const tuples = parseSetExpression(arg);
  if (!Array.isArray(tuples)) return tuples;
  return { cube: cube.name, tuples };
}

/**
 * Validate every member of every tuple; returns coords per tuple or error.
 * Measures and All members contribute no coordinate (a measure picks the
 * value column; All means "grand total over that dimension").
 */
function tuplesToCoords(
  cube: OlapCube,
  tuples: string[][],
): Array<Record<string, string>> | { error: string } {
  const out: Array<Record<string, string>> = [];
  for (const tuple of tuples) {
    const coords: Record<string, string> = {};
    for (const expr of tuple) {
      const r = resolveMember(cube, expr);
      if (isResolveError(r)) return r;
      const ms = isTupleResult(r) ? r.tuple : [r];
      for (const m of ms) {
        if (m.isMeasure || m.isAll) continue;
        coords[m.dim] = m.member;
      }
    }
    out.push(coords);
  }
  return out;
}

/** Caption used to sort a set tuple: the first member's label. */
function tupleCaption(cube: OlapCube, tuple: string[]): string {
  const first = tuple[0] ?? '';
  const r = resolveMember(cube, first);
  if (isResolveError(r) || isTupleResult(r)) return first;
  return r.member;
}

/** Natural sort: digit runs compare numerically ("Item2" < "Item10"). */
function naturalCompare(a: string, b: string): number {
  const chunks = (s: string): string[] => s.toLowerCase().match(/\d+|\D+/g) ?? [];
  const ac = chunks(a);
  const bc = chunks(b);
  for (let i = 0; i < Math.max(ac.length, bc.length); i++) {
    const x = ac[i] ?? '';
    const y = bc[i] ?? '';
    if (x === y) continue;
    const nx = /^\d+$/.test(x) ? parseInt(x, 10) : NaN;
    const ny = /^\d+$/.test(y) ? parseInt(y, 10) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) return nx - ny;
    return x < y ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// The plugin.
// ---------------------------------------------------------------------------

export class CubeFunctionsPlugin extends FunctionPlugin {
  public static implementedFunctions: Record<string, { method: string; parameters: Arg[]; repeatLastArgs?: number }> = {
    CUBEVALUE: {
      method: 'cubevalue',
      parameters: [S(), S()],
      repeatLastArgs: 1,
    },
    CUBEMEMBER: { method: 'cubemember', parameters: [S(), S(), S(true)] },
    CUBEMEMBERPROPERTY: {
      method: 'cubememberproperty',
      parameters: [S(), S(), S()],
    },
    CUBERANKEDMEMBER: {
      method: 'cuberankedmember',
      parameters: [S(), S(), S(), S(true)],
    },
    CUBESET: {
      method: 'cubeset',
      parameters: [S(), S(), S(true), S(true), S(true)],
    },
    CUBESETCOUNT: { method: 'cubesetcount', parameters: [S()] },
    CUBEKPIMEMBER: {
      method: 'cubekpimember',
      parameters: [S(), S(), S(), S(true)],
    },
  };

  private withCube(
    connection: InterpreterValue,
    fn: (cube: OlapCube) => InterpreterValue,
  ): InterpreterValue {
    if (connection instanceof CellError) return connection;
    const name = scalarText(connection);
    const cube = getCube(name);
    if (!cube) {
      return new CellError(
        ErrorType.NA,
        `CUBE*: connection "${name}" is not registered. Register an OLAP cube with registerCube() (see cubeFromPivot() to adapt a pivot table).`,
      );
    }
    return fn(cube);
  }

  public cubevalue(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('CUBEVALUE'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [connection, ...memberArgs] = args;
        if (connection instanceof CellError) return connection;
        return this.withCube(connection!, (cube) => {
          let measure = cube.measures[0];
          const coords: Record<string, string> = {};
          for (const a of memberArgs) {
            if (a instanceof CellError) return a;
            if (a === EmptyValue) continue;
            const text = scalarText(a);
            if (text === '') continue;
            const parsed = parseMemberExpr(text);
            if (!parsed) {
              return new CellError(ErrorType.NA, `Invalid member expression "${text}".`);
            }
            if (parsed.kind === 'dimension') {
              return new CellError(ErrorType.NA, `"${text}" is a dimension, not a member.`);
            }
            // Plain labels may name a measure ("Sum of Amount") or a member.
            // Try the measure first, then fall back to member resolution.
            if (parsed.kind === 'plain') {
              const m = resolveMeasure(cube, text);
              if (typeof m === 'string') {
                measure = m;
                continue;
              }
            }
            const r = resolveParsed(cube, parsed, text);
            if (isResolveError(r)) return new CellError(ErrorType.NA, r.error);
            const ms = isTupleResult(r) ? r.tuple : [r];
            for (const m of ms) {
              if (m.isMeasure) {
                measure = m.member;
                continue;
              }
              // The All member means "grand total over this dimension": it
              // contributes no coordinate.
              if (m.isAll) continue;
              coords[m.dim] = m.member;
            }
          }
          if (measure === undefined) {
            return new CellError(ErrorType.NA, `Cube "${cube.name}" has no measures.`);
          }
          const value = cube.getValue(measure, coords);
          if (value === null || value === undefined) {
            return new CellError(ErrorType.NA, 'The tuple has no value in the cube.');
          }
          return value;
        });
      },
    );
  }

  public cubemember(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('CUBEMEMBER'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [connection, memberExpr] = args;
        if (connection instanceof CellError) return connection;
        if (memberExpr instanceof CellError) return memberExpr;
        return this.withCube(connection!, (cube) => {
          const r = resolveMember(cube, scalarText(memberExpr ?? EmptyValue));
          if (isResolveError(r)) return new CellError(ErrorType.NA, r.error);
          // The optional caption argument is accepted for compatibility but
          // does not change the value: the canonical member expression is
          // what downstream CUBEVALUE / CUBEMEMBERPROPERTY references need.
          return isTupleResult(r) ? canonicalTuple(r.tuple) : canonicalResolved(r);
        });
      },
    );
  }

  public cubememberproperty(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('CUBEMEMBERPROPERTY'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [connection, memberExpr, property] = args;
        if (connection instanceof CellError) return connection;
        if (memberExpr instanceof CellError) return memberExpr;
        if (property instanceof CellError) return property;
        return this.withCube(connection!, (cube) => {
          const prop = norm(scalarText(property ?? EmptyValue));
          const text = scalarText(memberExpr ?? EmptyValue);
          const r = resolveMember(cube, text);
          if (isResolveError(r)) return new CellError(ErrorType.NA, r.error);
          if (isTupleResult(r)) {
            return new CellError(
              ErrorType.NA,
              `"${text}" is a tuple; member properties apply to single members.`,
            );
          }
          const m = r;
          if (m.isMeasure) {
            switch (prop) {
              case 'caption':
              case 'member_caption':
              case 'name':
              case 'member_name':
                return m.member;
              case 'unique_name':
              case 'member_unique_name':
                return canonicalResolved(m);
              case 'dimension':
              case 'dimension_unique_name':
                return 'Measures';
              default:
                return new CellError(ErrorType.NA, `Unknown member property "${prop}".`);
            }
          }
          switch (prop) {
            case 'caption':
            case 'member_caption':
            case 'name':
            case 'member_name':
              return m.member;
            case 'unique_name':
            case 'member_unique_name':
              return canonicalResolved(m);
            case 'dimension':
            case 'dimension_unique_name':
              return m.dim;
            case 'level_number':
              // The local cube is flat: every member sits at level 0.
              return 0;
            case 'level_name':
              return m.dim;
            case 'children_count':
              return 0;
            default:
              return new CellError(
                ErrorType.NA,
                `Unknown member property "${prop}" (supported: caption, unique_name, name, dimension, dimension_unique_name, level_number, level_name, children_count).`,
              );
          }
        });
      },
    );
  }

  public cuberankedmember(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('CUBERANKEDMEMBER'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [connection, setExpr, rank] = args;
        if (connection instanceof CellError) return connection;
        if (setExpr instanceof CellError) return setExpr;
        if (rank instanceof CellError) return rank;
        return this.withCube(connection!, (cube) => {
          const set = resolveSet(cube, scalarText(setExpr ?? EmptyValue));
          if ('error' in set) return new CellError(ErrorType.NA, set.error);
          // Excel: non-numeric rank or rank < 1 → #VALUE!; rank beyond the
          // set size → #N/A. Non-integer ranks truncate toward zero.
          if (typeof rank !== 'number' || !Number.isFinite(rank)) {
            return new CellError(
              ErrorType.VALUE,
              `Rank must be a number (got "${scalarText(rank ?? EmptyValue)}").`,
            );
          }
          const n = Math.trunc(rank);
          if (n < 1) {
            return new CellError(ErrorType.VALUE, `Rank ${n} is out of range (ranks start at 1).`);
          }
          if (n > set.tuples.length) {
            return new CellError(
              ErrorType.NA,
              `Rank ${n} exceeds the set size (${set.tuples.length}).`,
            );
          }
          const tuple = set.tuples[n - 1]!;
          return tuple.length === 1 ? tuple[0]! : `(${tuple.join(',')})`;
        });
      },
    );
  }

  public cubeset(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('CUBESET'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [connection, setExpr, , sortOrder, sortBy] = args;
        if (connection instanceof CellError) return connection;
        if (setExpr instanceof CellError) return setExpr;
        return this.withCube(connection!, (cube) => {
          const set = resolveSet(cube, scalarText(setExpr ?? EmptyValue));
          if ('error' in set) return new CellError(ErrorType.NA, set.error);
          // Validate members eagerly so a bad set fails here, not later.
          const coords = tuplesToCoords(cube, set.tuples);
          if (!Array.isArray(coords)) return new CellError(ErrorType.NA, coords.error);
          // sort_order: 0 = none, 1 = ascending, 2 = descending,
          // 3 = alpha ascending, 4 = alpha descending, 5 = natural ascending,
          // 6 = natural descending. ("asc"/"desc" also accepted.)
          const soRaw = sortOrder === undefined || sortOrder === EmptyValue ? 0 : sortOrder;
          let soNum: number;
          if (typeof soRaw === 'number') {
            soNum = Math.trunc(soRaw);
          } else if (typeof soRaw === 'string') {
            const s = soRaw.trim().toLowerCase();
            if (s === 'asc') soNum = 1;
            else if (s === 'desc') soNum = 2;
            else if (/^-?\d+$/.test(s)) soNum = parseInt(s, 10);
            else {
              return new CellError(ErrorType.VALUE, `Invalid sort_order "${soRaw}" (use 0-6).`);
            }
          } else {
            return new CellError(ErrorType.VALUE, `Invalid sort_order (use 0-6).`);
          }
          if (soNum < 0 || soNum > 6) {
            return new CellError(ErrorType.VALUE, `Invalid sort_order ${soNum} (use 0-6).`);
          }
          let order = set.tuples.map((t, i) => i);
          if (soNum >= 1) {
            let sortMeasure: string | null = null;
            const wantMeasure =
              (soNum === 1 || soNum === 2) &&
              sortBy !== undefined &&
              sortBy !== EmptyValue &&
              !(sortBy instanceof CellError);
            if (wantMeasure) {
              const mm = resolveMeasure(cube, scalarText(sortBy));
              if (typeof mm !== 'string') return new CellError(ErrorType.NA, mm.error);
              sortMeasure = mm;
            }
            const keys = set.tuples.map((tuple, i) => ({
              i,
              num:
                sortMeasure !== null
                  ? (() => {
                      const v = cube.getValue(sortMeasure, coords[i]!);
                      return typeof v === 'number' ? v : Number.NEGATIVE_INFINITY;
                    })()
                  : Number.NaN,
              caption: tupleCaption(cube, tuple),
            }));
            const descending = soNum === 2 || soNum === 4 || soNum === 6;
            keys.sort((a, b) => {
              let c: number;
              if (sortMeasure !== null) {
                c = a.num - b.num;
              } else if (soNum === 5 || soNum === 6) {
                c = naturalCompare(a.caption, b.caption);
              } else {
                const al = a.caption.toLowerCase();
                const bl = b.caption.toLowerCase();
                c = al < bl ? -1 : al > bl ? 1 : 0;
              }
              return c;
            });
            if (descending) keys.reverse();
            order = keys.map((k) => k.i);
          }
          const sorted: CubeSet = {
            cube: cube.name,
            tuples: order.map((i) => set.tuples[i]!),
          };
          return setHandle(sorted);
        });
      },
    );
  }

  public cubesetcount(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('CUBESETCOUNT'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [setArg] = args;
        if (setArg instanceof CellError) return setArg;
        const text = scalarText(setArg ?? EmptyValue).trim();
        if (text === '') {
          return new CellError(
            ErrorType.VALUE,
            'CUBESETCOUNT expects a set returned by CUBESET or a braced set expression like "{[Region].[East]}".',
          );
        }
        if (isSetHandle(text)) {
          const set = parseSetHandle(text);
          if (!set) return new CellError(ErrorType.VALUE, 'Invalid set handle.');
          return set.tuples.length;
        }
        if (text.startsWith('{')) {
          // A JSON-looking object that is not a valid handle is a malformed
          // handle, not an MDX set.
          let parsedJson: unknown = null;
          let isJson = true;
          try {
            parsedJson = JSON.parse(text);
          } catch {
            isJson = false;
          }
          if (isJson && parsedJson !== null && typeof parsedJson === 'object') {
            return new CellError(ErrorType.VALUE, 'Invalid set handle.');
          }
          // Inline braced MDX set: counted syntactically, no connection
          // needed (graceful without a live cube).
          const tuples = parseSetExpression(text);
          if (!Array.isArray(tuples)) return new CellError(ErrorType.VALUE, tuples.error);
          for (const tuple of tuples) {
            for (const expr of tuple) {
              if (!parseMemberExpr(expr) || expr.includes('{') || expr.includes('}')) {
                return new CellError(
                  ErrorType.VALUE,
                  `Invalid member expression "${expr}" in set expression.`,
                );
              }
            }
          }
          return tuples.length;
        }
        return new CellError(
          ErrorType.VALUE,
          'CUBESETCOUNT expects a set returned by CUBESET or a braced set expression like "{[Region].[East]}".',
        );
      },
    );
  }

  public cubekpimember(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('CUBEKPIMEMBER'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [connection, kpiName, kpiProperty] = args;
        if (connection instanceof CellError) return connection;
        if (kpiName instanceof CellError) return kpiName;
        if (kpiProperty instanceof CellError) return kpiProperty;
        return this.withCube(connection!, (cube) => {
          const name = scalarText(kpiName ?? EmptyValue);
          const kpi = Object.entries(cube.kpis ?? {}).find(([k]) => norm(k) === norm(name))?.[1];
          if (!kpi) {
            return new CellError(ErrorType.NA, `KPI "${name}" not found in cube "${cube.name}".`);
          }
          const propRaw = kpiProperty ?? EmptyValue;
          const propText = norm(scalarText(propRaw));
          const propNum = typeof propRaw === 'number' ? Math.trunc(propRaw) : 0;
          let numVal: number | null | undefined;
          let strVal: string | null | undefined;
          if (propNum === 1 || propText === 'value' || propText === 'kpivalue') numVal = kpi.value;
          else if (propNum === 2 || propText === 'goal' || propText === 'kpigoal') numVal = kpi.goal;
          else if (propNum === 3 || propText === 'status' || propText === 'kpistatus')
            numVal = kpi.status;
          else if (propNum === 4 || propText === 'trend' || propText === 'kpitrend')
            numVal = kpi.trend;
          else if (propNum === 5 || propText === 'weight' || propText === 'kpiweight')
            numVal = kpi.weight ?? null;
          else if (
            propNum === 6 ||
            propText === 'currenttimemember' ||
            propText === 'kpicurrenttimemember'
          )
            strVal = kpi.currentTimeMember ?? null;
          else {
            return new CellError(
              ErrorType.NA,
              `Unknown KPI property "${scalarText(propRaw)}" (use 1=value, 2=goal, 3=status, 4=trend, 5=weight, 6=current time member).`,
            );
          }
          if (strVal !== undefined) {
            if (strVal === null) {
              return new CellError(ErrorType.NA, `KPI "${name}" has no current time member.`);
            }
            return strVal;
          }
          if (numVal === null || numVal === undefined) {
            return new CellError(
              ErrorType.NA,
              `KPI "${name}" has no ${propText || propNum} value.`,
            );
          }
          return numVal;
        });
      },
    );
  }
}

let registered = false;

/** Register the 7 cube functions. Idempotent. */
export function registerCubeFunctions(): void {
  if (registered || HyperFormula.getFunctionPlugin('CUBEVALUE') !== undefined) {
    registered = true;
    return;
  }
  const names = {
    CUBEVALUE: 'CUBEVALUE',
    CUBEMEMBER: 'CUBEMEMBER',
    CUBEMEMBERPROPERTY: 'CUBEMEMBERPROPERTY',
    CUBERANKEDMEMBER: 'CUBERANKEDMEMBER',
    CUBESET: 'CUBESET',
    CUBESETCOUNT: 'CUBESETCOUNT',
    CUBEKPIMEMBER: 'CUBEKPIMEMBER',
  };
  HyperFormula.registerFunctionPlugin(CubeFunctionsPlugin, { enGB: names, enUS: names });
  registered = true;
}
