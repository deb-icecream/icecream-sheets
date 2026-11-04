/**
 * Partition planner for parallel recalculation (Cycle 10: chain partitioning).
 *
 * Multithreading is an EXECUTION strategy, not a routing tier: this module
 * only decides how a large recalculation executes on whichever engine host
 * runs it. Whether a recalculation is routed locally or to the server is a
 * separate, two-tier decision owned elsewhere.
 *
 * Partitions the workbook's dependency graph by INDEPENDENT CALC CHAINS
 * (Excel-style): formula cells are levelised by topological depth over the
 * dependency graph (depth 0 = depends on literals/inputs only). Cells at
 * the same depth have NO dependencies on each other, so they are split
 * across workers — that is where parallelism comes from. Dependents live
 * in later stages, so dependent chains serialize in topological order.
 * Cells caught in (or downstream of) a dependency cycle — legal under
 * iterative calculation — are merged into a single partition evaluated
 * together.
 *
 * Boundary: for every owned formula cell, direct precedents NOT owned by
 * its own partition are collected (tracked cells only — empty cells are
 * empty in the worker too, so they need no stub) so the orchestrator can
 * inject them as computed literals into the worker's sheets, exactly as
 * staged upstream values.
 *
 * Honest limitations (documented, not silent):
 * - getPrecedents() expands range precedents capped at 10k cells: a range
 *   precedent larger than that may miss formula precedents, which could
 *   under-estimate a cell's depth. Formula-heavy huge-range workbooks
 *   should be differentially tested (see tests).
 * - Provider-backed functions (PY/COPILOT/WEBSERVICE/STOCKHISTORY/RTD) use
 *   host-configured providers that do not cross the worker boundary, so any
 *   workbook using them falls back to serial (flagged in the plan).
 * - INDIRECT()/OFFSET() are not tracked by HyperFormula's graph
 *   (see getPrecedents note in workbook.ts) — formulas using them stay in
 *   the plan on their literal/depth basis, which is the serial behavior.
 * - Volatile functions (RAND/NOW/...) evaluate independently per worker;
 *   their values may differ from a serial run. Both are "correct" — the
 *   functions are volatile by definition. Exact-equality tests avoid them.
 */
import type { EngineWorkbook } from '../workbook.js';
import type { CellRef } from '../types.js';
import type { PartitionPlan, RecalcPartition } from './types.js';

/** Functions whose providers live on the host and don't cross workers. */
const PROVIDER_BACKED_FN = /\b(PY|COPILOT|WEBSERVICE|STOCKHISTORY|RTD)\s*\(/;

function refKey(ref: CellRef): string {
  return `${ref.sheet}\u0000${ref.row}\u0000${ref.col}`;
}

function compareRefs(a: CellRef, b: CellRef): number {
  if (a.sheet !== b.sheet) return a.sheet < b.sheet ? -1 : 1;
  if (a.row !== b.row) return a.row - b.row;
  return a.col - b.col;
}

// ---------------------------------------------------------------------------
// Named-expression target expansion.
//
// HyperFormula's public getCellPrecedents() does NOT surface the cells a
// formula reaches through a named expression (the name vertex is hidden),
// yet a worker partition evaluating `=Rate*2` still needs Rate's target
// cells present — as boundary stubs and, when a target is itself a
// formula, as a real dependency edge (its value must be computed in an
// earlier stage). The old sheet-granular planner masked this by shipping
// whole sheets to workers; chain partitioning must expand names itself.
//
// Expansion is deliberately TOLERANT (regex over the name's formula text):
// a false positive only adds an unnecessary boundary stub or ordering
// edge (conservative — values stay exact), while a missed target would
// produce a wrong value. Ranges expand capped at 10k cells, matching
// getPrecedents()' convention. String literals are stripped first.
// ---------------------------------------------------------------------------

function colLettersToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const MAX_NAME_EXPANSION_CELLS = 10000;

function extractCellRefsFromFormulaText(
  text: string,
  defaultSheet: string | undefined,
  sheetNames: string[],
): CellRef[] {
  const byLower = new Map(sheetNames.map((s) => [s.toLowerCase(), s]));
  const out = new Map<string, CellRef>();
  const pushRange = (
    sheet: string,
    c1: string,
    r1: string,
    c2: string | undefined,
    r2: string | undefined,
  ): void => {
    const colA = colLettersToIndex(c1);
    const rowA = Number(r1) - 1;
    const colB = c2 !== undefined ? colLettersToIndex(c2) : colA;
    const rowB = r2 !== undefined ? Number(r2) - 1 : rowA;
    let count = 0;
    for (
      let r = Math.min(rowA, rowB);
      r <= Math.max(rowA, rowB) && count < MAX_NAME_EXPANSION_CELLS;
      r++
    ) {
      for (
        let c = Math.min(colA, colB);
        c <= Math.max(colA, colB) && count < MAX_NAME_EXPANSION_CELLS;
        c++
      ) {
        const ref: CellRef = { sheet, row: r, col: c };
        out.set(refKey(ref), ref);
        count++;
      }
    }
  };
  // Strip double-quoted string literals ("" = escaped quote inside).
  const noStrings = text.replace(/"(?:[^"]|"")*"/g, '""');
  // 1. Sheet-qualified refs: Sheet!A1, 'My Sheet'!$A$1:B2, Sheet!A1:B2.
  const qualified =
    /(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_.]*))!\$?([A-Za-z]{1,3})\$?(\d{1,7})(?::\$?([A-Za-z]{1,3})\$?(\d{1,7}))?/g;
  const consumed: Array<[number, number]> = [];
  for (const m of noStrings.matchAll(qualified)) {
    const sheetRaw = (m[1] ?? m[2] ?? '').replace(/''/g, "'");
    const sheet = byLower.get(sheetRaw.toLowerCase());
    if (!sheet) continue; // e.g. external-workbook [1]Sheet! refs — not local cells
    consumed.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    pushRange(sheet, m[3]!, m[4]!, m[5], m[6]);
  }
  // 2. Unqualified refs (default sheet), skipping qualified spans and
  //    function names like LOG10(.
  if (defaultSheet) {
    const unqualified = /\$?([A-Za-z]{1,3})\$?(\d{1,7})(?::\$?([A-Za-z]{1,3})\$?(\d{1,7}))?/g;
    for (const m of noStrings.matchAll(unqualified)) {
      const idx = m.index ?? 0;
      if (consumed.some(([a, b]) => idx >= a && idx < b)) continue;
      const prev = idx > 0 ? noStrings[idx - 1]! : '';
      if (/[A-Za-z0-9_.!]/.test(prev)) continue; // part of an identifier / qualified ref
      const next = noStrings[idx + m[0].length] ?? '';
      if (next === '(') continue; // function name, not a cell ref
      pushRange(defaultSheet, m[1]!, m[2]!, m[3], m[4]);
    }
  }
  return [...out.values()];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `name` appears as a token in the formula text. */
function formulaMentionsName(text: string, name: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_.])${escapeRegExp(name)}(?![A-Za-z0-9_.])`, 'i').test(text);
}

export interface PlanPartitionsOptions {
  /**
   * Target partitions per stage: stage cells are chunked into at most
   * this many independent partitions. Pass the pool's worker count so
   * parallelism matches hardware. Defaults to 4.
   */
  workerCount?: number;
  /**
   * Early degenerate-plan exit (Cycle 10 closure, defect 6 residual):
   * while levelising, once more than `stageFloor` stages are complete,
   * the planner continuously bounds the BEST average stage width any
   * completion of the remaining graph could still reach (remaining
   * cells packed as favorably as the chunking rule allows). When that
   * bound falls below `minAvgWidth`, the finished plan is PROVABLY
   * degenerate — a chain-dominated plan whose staged evaluation the
   * orchestrator would reject anyway — so planning stops and the
   * returned plan carries `degenerateEarlyExit` with empty stages
   * instead of paying the whole-workbook walk (measured at 18.7 s on
   * the P95 workbook, vs a ~0.5 s serial recalc of the same edit).
   * Callers that need a complete plan omit this; the orchestrator
   * passes its guard constants so the proof uses the same thresholds
   * as the guard it replaces.
   */
  earlyExit?: { stageFloor: number; minAvgWidth: number };
}

// ---------------------------------------------------------------------------
// Plan cache (Cycle 10 closure, defect 6 residual).
//
// A partition plan is a pure function of the workbook's dependency-graph
// shape: formula cells, their formula precedents, named-expression
// target edges, and the tracked-cell set (for boundaries). None of that
// changes on a pure VALUE edit. Plans are therefore cached per workbook
// keyed by (graphVersion, workerCount, early-exit parameters) — the
// graph version is EngineWorkbook's own signal, the same one the
// calc-chain measurement cache uses: it bumps only on formula /
// structural changes and on tracked-set membership changes (see
// trackCellInput in workbook.ts), never on value→value edits. A stale
// plan could misroute boundary stubs, so the key is conservative by
// construction: any graph doubt already bumped the version upstream.
//
// Cached plan objects are treated as immutable: the orchestrator only
// reads stages/boundaries, and makePartition's arrays are never mutated
// after construction.
// ---------------------------------------------------------------------------

interface PlanCacheSlot {
  version: number;
  plans: Map<string, PartitionPlan>;
}

const planCache = new WeakMap<EngineWorkbook, PlanCacheSlot>();

function planCacheLookup(
  wb: EngineWorkbook,
  target: number,
  earlyExit: PlanPartitionsOptions['earlyExit'],
): PartitionPlan | undefined {
  const slot = planCache.get(wb);
  if (!slot || slot.version !== wb.getGraphVersion()) return undefined;
  // A complete plan serves any request (the orchestrator applies its
  // guards to the full statistics); an early-exit verdict serves only
  // the identical early-exit request.
  return (
    slot.plans.get(`full|${target}`) ??
    (earlyExit
      ? slot.plans.get(`early|${target}|${earlyExit.stageFloor}|${earlyExit.minAvgWidth}`)
      : undefined)
  );
}

/** Partitions a stage of `cellCount` cells yields under the chunking rule. */
function partitionsForStage(cellCount: number, target: number): number {
  if (cellCount <= 0) return 0;
  const chunk = Math.max(1, Math.ceil(cellCount / target));
  return Math.ceil(cellCount / chunk);
}

/**
 * Upper bound on the average stage width of the FINISHED plan, given
 * `partitionsDone` partitions across `stagesDone` completed stages and
 * `remaining` unprocessed formula cells. A completion adds A stages
 * (1 ≤ A ≤ remaining) holding Q new partitions with Q ≤ min(remaining,
 * target·A) (a stage yields at most `target` partitions and at most one
 * per cell). The ratio (P+Q)/(S+A) is monotonic in A on each side of
 * A₀ = remaining/target (rising while Q = target·A can still grow,
 * falling once Q is capped by `remaining`), so its maximum over all
 * feasible completions is attained at A ∈ {1, ⌊A₀⌋, ⌈A₀⌉} — evaluating
 * those candidates gives an exact upper bound, not an estimate.
 */
function maxPossibleAvgWidth(
  partitionsDone: number,
  stagesDone: number,
  remaining: number,
  target: number,
): number {
  if (remaining <= 0) return partitionsDone / Math.max(1, stagesDone);
  const a0 = remaining / target;
  let best = 0;
  for (const a of new Set([1, Math.max(1, Math.floor(a0)), Math.max(1, Math.ceil(a0))])) {
    if (a > remaining) continue;
    const q = Math.min(remaining, target * a);
    best = Math.max(best, (partitionsDone + q) / (stagesDone + a));
  }
  return best;
}

export function planPartitions(
  wb: EngineWorkbook,
  opts: PlanPartitionsOptions = {},
): PartitionPlan {
  const target = Math.max(1, Math.floor(opts.workerCount ?? 4) || 4);
  // Cache (see note above). Workbooks without a graph version (foreign
  // doubles in tests) simply never hit or store.
  const versioned = typeof wb.getGraphVersion === 'function';
  if (versioned) {
    const hit = planCacheLookup(wb, target, opts.earlyExit);
    if (hit) return hit;
  }
  const plan = computePlan(wb, target, opts.earlyExit);
  if (versioned) {
    const slotVersion = wb.getGraphVersion();
    let slot = planCache.get(wb);
    if (!slot || slot.version !== slotVersion) {
      slot = { version: slotVersion, plans: new Map() };
      planCache.set(wb, slot);
    }
    if (plan.degenerateEarlyExit && opts.earlyExit) {
      slot.plans.set(
        `early|${target}|${opts.earlyExit.stageFloor}|${opts.earlyExit.minAvgWidth}`,
        plan,
      );
    } else if (!plan.degenerateEarlyExit) {
      slot.plans.set(`full|${target}`, plan);
    }
  }
  return plan;
}

function computePlan(
  wb: EngineWorkbook,
  target: number,
  earlyExit: PlanPartitionsOptions['earlyExit'],
): PartitionPlan {
  // Suspension-safe: tracked inputs work in manual (suspended) mode, where
  // toSnapshot() cannot be used (HyperFormula guards evaluation APIs).
  const tracked = wb.getTrackedCells();
  const totalCellCount = tracked.length;

  // Numeric cell keys ((sheetIndex · 2^20 + row) · 2^14 + col): the
  // planner builds maps over EVERY formula cell and precedent edge, and
  // string keys over a 1.8M-cell workbook measurably dominated the walk.
  // Sheet indices come from wb.sheetNames() order; rows/cols are within
  // HyperFormula's Excel limits (2^20 rows, 2^14 cols), so keys are
  // exact integers well below 2^53.
  const sheetIndex = new Map<string, number>();
  wb.sheetNames().forEach((n, i) => sheetIndex.set(n, i));
  const keyOf = (ref: CellRef): number =>
    ((sheetIndex.get(ref.sheet) ?? 0) * 1048576 + ref.row) * 16384 + ref.col;

  const formulaCells: Array<{ ref: CellRef; text: string; key: number }> = [];
  let usesProviderBackedFunctions = false;
  for (const { ref, input } of tracked) {
    if (typeof input !== 'string' || !input.startsWith('=')) continue;
    formulaCells.push({ ref, text: input, key: keyOf(ref) });
    if (PROVIDER_BACKED_FN.test(input)) usesProviderBackedFunctions = true;
  }

  const byKey = new Map<number, CellRef>();
  for (const { ref, key } of formulaCells) byKey.set(key, ref);

  // FORMULA precedents per formula cell (for depth). ALL precedents are
  // deliberately NOT retained: boundary construction (phase B) recomputes
  // them per owned cell, and only for plans that actually execute —
  // retaining 1M+ precedent refs for a plan the degenerate guard then
  // rejects was a large share of the original whole-workbook walk cost.
  const formulaPrecedents = new Map<number, number[]>();
  for (const { ref, key } of formulaCells) {
    let precedents: CellRef[] = [];
    try {
      precedents = wb.getPrecedents(ref);
    } catch {
      precedents = [];
    }
    const fp: number[] = [];
    for (const p of precedents) {
      const pk = keyOf(p);
      if (byKey.has(pk)) fp.push(pk);
    }
    formulaPrecedents.set(key, fp);
  }

  // Merge named-expression targets into the precedent map (see the
  // expansion note above). Targets of names referenced by a formula —
  // directly or through other names — are precedents of that formula.
  // This runs BEFORE Kahn below consumes the map. The expanded targets
  // are also retained per cell (namedBoundaryExtras) so phase B's
  // boundary construction can include them without recomputing the
  // expansion.
  const namedBoundaryExtras = new Map<number, CellRef[]>();
  try {
    const namedExprs = wb.getTrackedNamedExpressions();
    if (namedExprs.length > 0) {
      const allSheetNames = wb.sheetNames();
      const byName = new Map<string, { name: string; formula: string; sheetIndex?: number }>();
      for (const ne of namedExprs) byName.set(ne.name.toLowerCase(), ne);
      const expanded = new Map<string, CellRef[]>();
      const expandName = (lower: string, seen: Set<string>): CellRef[] => {
        const hit = expanded.get(lower);
        if (hit) return hit;
        if (seen.has(lower)) return [];
        seen.add(lower);
        const ne = byName.get(lower);
        if (!ne) return [];
        const scopeSheet =
          ne.sheetIndex !== undefined ? allSheetNames[ne.sheetIndex] : undefined;
        const cells = new Map<string, CellRef>();
        for (const ref of extractCellRefsFromFormulaText(ne.formula, scopeSheet, allSheetNames)) {
          cells.set(refKey(ref), ref);
        }
        // Names can reference other names: expand transitively.
        for (const other of byName.keys()) {
          if (other !== lower && formulaMentionsName(ne.formula, other)) {
            for (const ref of expandName(other, seen)) cells.set(refKey(ref), ref);
          }
        }
        const outCells = [...cells.values()];
        expanded.set(lower, outCells);
        return outCells;
      };
      for (const { ref, text, key } of formulaCells) {
        const extras: CellRef[] = [];
        for (const lower of byName.keys()) {
          if (formulaMentionsName(text, lower)) {
            extras.push(...expandName(lower, new Set()));
          }
        }
        if (extras.length === 0) continue;
        namedBoundaryExtras.set(key, extras);
        const fp = formulaPrecedents.get(key) ?? [];
        const seenFp = new Set(fp);
        for (const e of extras) {
          const ek = keyOf(e);
          if (byKey.has(ek) && !seenFp.has(ek)) {
            fp.push(ek);
            seenFp.add(ek);
          }
        }
        formulaPrecedents.set(key, fp);
      }
    }
  } catch {
    // Named-expression introspection unavailable: partitioning proceeds
    // on graph precedents alone (previous behavior for such workbooks).
  }

  // Kahn's algorithm over FORMULA cells: depth = 1 + max depth of formula
  // precedents; literals-only formulas land at depth 0. Deterministic
  // (sorted) processing order for reproducible plans. Each Kahn iteration
  // completes exactly one depth level, which is what makes the
  // early-exit proof below possible: after every level, the finished
  // plan's average stage width can be bounded exactly.
  const keys = [...byKey.keys()].sort((a, b) => a - b);
  const indegree = new Map<number, number>();
  const dependents = new Map<number, number[]>();
  for (const k of keys) {
    indegree.set(k, 0);
    dependents.set(k, []);
  }
  for (const k of keys) {
    for (const p of formulaPrecedents.get(k) ?? []) {
      indegree.set(k, (indegree.get(k) ?? 0) + 1);
      dependents.get(p)!.push(k);
    }
  }
  const depth = new Map<number, number>();
  let ready = keys.filter((k) => (indegree.get(k) ?? 0) === 0).sort((a, b) => a - b);
  let stagesCompleted = 0;
  let partitionsCompleted = 0;
  let processedCells = 0;
  for (;;) {
    if (ready.length === 0) break;
    const next: number[] = [];
    for (const k of ready) {
      let d = 0;
      for (const p of formulaPrecedents.get(k) ?? []) {
        d = Math.max(d, (depth.get(p) ?? 0) + 1);
      }
      depth.set(k, d);
      for (const dep of dependents.get(k) ?? []) {
        const nd = (indegree.get(dep) ?? 1) - 1;
        indegree.set(dep, nd);
        if (nd === 0) next.push(dep);
      }
    }
    stagesCompleted++;
    partitionsCompleted += partitionsForStage(ready.length, target);
    processedCells += ready.length;
    ready = next.sort((a, b) => a - b);
    // Early degenerate exit: only a PROOF aborts planning — the bound
    // must show that no completion of the remaining graph can lift the
    // finished plan's average stage width to the caller's floor.
    if (earlyExit && stagesCompleted > earlyExit.stageFloor) {
      const remaining = formulaCells.length - processedCells;
      const bound = maxPossibleAvgWidth(partitionsCompleted, stagesCompleted, remaining, target);
      if (bound < earlyExit.minAvgWidth) {
        return {
          stages: [],
          formulaCellCount: formulaCells.length,
          totalCellCount,
          usesProviderBackedFunctions,
          degenerateEarlyExit: {
            stagesCompleted,
            partitionsCompleted,
            maxPossibleAvgWidth: bound,
            unprocessedFormulaCells: remaining,
          },
        };
      }
    }
  }
  // Leftovers: cycles, or cells downstream of cycles (they cannot stage
  // until the cycle resolves). Merged into one partition, like iterative
  // calculation does.
  const cyclic = keys.filter((k) => !depth.has(k)).sort((a, b) => a - b);

  // Phase B: stage cells by depth and build partitions (boundaries
  // recomputed per owned cell — see the phase-A note). Within a stage
  // every cell is mutually independent — safe to split into balanced,
  // worker-sized chunks.
  const trackedSet = new Set<number>();
  for (const { ref } of tracked) trackedSet.add(keyOf(ref));
  const byDepth = new Map<number, CellRef[]>();
  for (const k of keys) {
    const d = depth.get(k);
    if (d === undefined) continue; // cyclic: handled below
    let arr = byDepth.get(d);
    if (!arr) {
      arr = [];
      byDepth.set(d, arr);
    }
    arr.push(byKey.get(k)!);
  }
  const sortedDepths = [...byDepth.keys()].sort((a, b) => a - b);

  const stages: RecalcPartition[][] = [];
  for (const d of sortedDepths) {
    const cells = (byDepth.get(d) ?? []).sort(compareRefs);
    const chunk = Math.max(1, Math.ceil(cells.length / target));
    const parts: RecalcPartition[] = [];
    for (let i = 0; i < cells.length; i += chunk) {
      parts.push(makePartition(wb, cells.slice(i, i + chunk), namedBoundaryExtras, trackedSet, keyOf));
    }
    stages.push(parts);
  }
  if (cyclic.length > 0) {
    const cells = cyclic.map((k) => byKey.get(k)!).sort(compareRefs);
    stages.push([makePartition(wb, cells, namedBoundaryExtras, trackedSet, keyOf)]);
  }

  return {
    stages,
    formulaCellCount: formulaCells.length,
    totalCellCount,
    usesProviderBackedFunctions,
  };
}

/** One partition: disjoint owned cells + their tracked non-owned precedents. */
function makePartition(
  wb: EngineWorkbook,
  cells: CellRef[],
  namedBoundaryExtras: Map<number, CellRef[]>,
  trackedSet: Set<number>,
  keyOf: (ref: CellRef) => number,
): RecalcPartition {
  const owned = new Set(cells.map(keyOf));
  const boundary = new Map<number, CellRef>();
  const consider = (p: CellRef): void => {
    const pk = keyOf(p);
    if (owned.has(pk)) return;
    // Only tracked cells need a stub: untracked (empty) cells are
    // empty in the worker too — identical behavior, no stub needed.
    if (!trackedSet.has(pk)) return;
    boundary.set(pk, p);
  };
  for (const ref of cells) {
    let precedents: CellRef[] = [];
    try {
      precedents = wb.getPrecedents(ref);
    } catch {
      precedents = [];
    }
    for (const p of precedents) consider(p);
    for (const p of namedBoundaryExtras.get(keyOf(ref)) ?? []) consider(p);
  }
  const sheetSet = new Set<string>();
  for (const ref of cells) sheetSet.add(ref.sheet);
  return {
    cells: [...cells].sort(compareRefs),
    sheets: [...sheetSet].sort(),
    boundary: [...boundary.values()].sort(compareRefs),
  };
}
