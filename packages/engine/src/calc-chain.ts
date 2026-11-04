/**
 * Hybrid recalc routing — Cycle 10 Phase 3 (engine side, transport-agnostic).
 *
 * RECALC ROUTING — FINAL RULE (user's directive, Cycle 10; quote verbatim):
 *
 * The size flag decides the local mirror: workbooks BELOW the cell-count
 * flag keep a FULL local engine mirror — local calc paths always
 * available. Workbooks ABOVE the flag are server-calc only for everything
 * except rendering, because the browser holds no mirror.
 *
 * Below the flag (mirror exists), per edit, from the dependency graph:
 *   (a) tiny set — total affected cells ≤ the tiny-set threshold (default
 *       50) → local single-thread, regardless of chain count. Checked
 *       FIRST, before the shape test.
 *   (b) single chain — short (chain length ≤ length threshold) → local
 *       single-thread; long (> threshold) → server, single thread
 *       (a lone chain cannot parallelize internally — no point threading
 *       it).
 *   (c) multiple chains → server, ALWAYS. No length test. On the server,
 *       the multithreading auto-flag decides: ON (workbook cell count
 *       above its threshold) → independent chains in parallel,
 *       Excel-style; dependent chains serialize. OFF → single thread.
 *
 * Above the flag (no mirror): ALL edits go to the server; the browser
 * renders only.
 *
 * Optimistic display: when an edit routes to the server, the typed cell
 * shows the user's input IMMEDIATELY; downstream results fill in when the
 * server replies. The input display is provisional — never authoritative.
 * See HYBRID-CONSISTENCY.md §7.
 *
 * The server is the source of truth for workbook state — no silent
 * client/server divergence (see HYBRID-CONSISTENCY.md in this package).
 *
 * This module is pure and transport-agnostic: it reads the dependency graph
 * through the CalcChainGraphSource seam (implemented by EngineWorkbook from
 * HyperFormula's graph), classifies the affected set's shape, and decides
 * placement through routeRecalc(). Hosts (web gateway mode, desktop IPC,
 * MCP) consume the decision and execute it over their own transports.
 * Nothing here touches process.env, the network, or the DOM — env config
 * arrives as a plain record (see hybridRecalcConfigFromEnv) so browser and
 * Node hosts share the seam.
 *
 * ## Shape classification (the structural test)
 *
 * The affected set is the set of recalc units an edit triggers: distinct
 * formula cells that (transitively) depend on the edited cell, PLUS
 * distinct named-expression vertices on those paths. Edges are EFFECTIVE
 * dependency edges between recalc units (and the edited cell): range
 * vertices from HyperFormula's graph (cell -> range -> formula routing)
 * are transparent connectors, never units — following them finds a node's
 * real dependents (e.g. the SUM cell over a range) without counting range
 * member cells, which do not recalculate.
 *
 * - 'single-chain': the affected set is ONE dependent sequence — every
 *   affected unit has at most one effective precedent (within the affected
 *   set ∪ {edited cell}) and at most one effective dependent (within the
 *   affected set), and no edge leads back into the edited cell or the node
 *   itself. Equivalently: the effective graph over {edited cell} ∪
 *   affected set is a simple path starting at the edited cell.
 * - 'multiple-chains': anything else — a fan-out (one unit feeding two),
 *   a merge (two units feeding one, including a direct edge plus a second
 *   path through a range or a named expression reaching the same unit),
 *   or a cycle among affected units (including self-including ranges such
 *   as SUBTOTAL over its own cell). Conservative by design where the graph
 *   is ambiguous: an affected cell reachable by two distinct effective
 *   paths counts as a merge even when a topological order would still
 *   serialize it — the test is on the graph's shape, kept simple.
 *
 * chainLength is reported ONLY for a single chain (for multiple chains it
 * is null — length is meaningless there; routing skips the length test).
 * affectedCount always reports the total recalc units found (diagnostic).
 *
 * ## How the partitioning worker consumes this (sibling: executePartition audit)
 *
 * measureCalcChain with NO maxNodes returns the FULL affected set:
 * measurement.cells + measurement.namedExpressions. A partitioner that
 * splits INDEPENDENT chains works from this set: restrict each unit's
 * effective dependents to the affected set (EngineWorkbook exposes the
 * graph seam; getCellDependents follows the same range transparency) to
 * get the induced recalc DAG. When shape is 'multiple-chains', weakly
 * connected components of that DAG are the independent chains the server
 * may evaluate in parallel under its MT auto-flag; within a component,
 * dependent chains serialize. When shape is 'single-chain' there is
 * exactly one component and nothing to parallelize — which is why a long
 * single chain goes to the server single-threaded rather than being
 * threaded anywhere. Named expressions are global synchronization points:
 * any chain passing through a named expression joins that expression's
 * component.
 *
 * For ROUTING, always pass maxNodes = lengthThreshold + 1: the walk then
 * costs O(threshold) instead of O(graph). A truncated result
 * (exact === false) means the walk stopped early; shape is then certain
 * only when 'multiple-chains' was already observed (branching/merging is
 * a fact once seen). routeRecalc treats every uncertain case as 'server'.
 */
import type { CellRef } from './types.js';

/** A cell address in the dependency graph (sheet = HyperFormula sheet id). */
export interface GraphCellAddress {
  sheet: number;
  row: number;
  col: number;
}

/**
 * A range vertex in the dependency graph. Unbounded ends (whole-column /
 * whole-row refs) arrive with row/col null at runtime — tolerated here.
 */
export interface GraphCellRange {
  start: GraphCellAddress;
  end: { sheet: number; row: number | null; col: number | null };
}

/** Anything getCellDependents can return for a query target. */
export type GraphDependent = GraphCellAddress | GraphCellRange;
/** A cell, NE pseudo-address, or range vertex we can query dependents of. */
export type GraphTarget = GraphCellAddress | GraphCellRange;

/**
 * Minimal seam between this module and the engine's real dependency graph.
 * EngineWorkbook implements it from HyperFormula; tests implement it with
 * hand-built graphs.
 */
export interface CalcChainGraphSource {
  /**
   * One-hop dependents of a cell address, a named-expression pseudo-address
   * ({ sheet: -1, row: <ne index> }), or a range vertex. Must never throw —
   * return [] when the target is unknown.
   */
  dependentsOf(target: GraphTarget): GraphDependent[];
  /** Sheet name for a sheet id, or undefined when unknown. */
  sheetName(sheetId: number): string | undefined;
  /** Named expression at a HyperFormula NE index, or undefined. */
  namedExpression(index: number): { name: string; scope?: number } | undefined;
}

/** A named-expression vertex on the affected chain, in discovery order. */
export interface NamedExpressionNode {
  /** HyperFormula named-expression index (graph identity). */
  index: number;
  name: string;
  scope?: number;
}

/**
 * The affected set's shape — the structural classification of an edit's
 * blast radius. 'single-chain': one dependent sequence. 'multiple-chains':
 * branches, merges, or cycles (see module header for the exact test).
 */
export type RecalcShape = 'single-chain' | 'multiple-chains';

/**
 * Whether the client holds a full local engine mirror. Decided by the
 * cell-count auto-flag — ONE FLAG, TWO CONSEQUENCES (user's final rule):
 * flag ON (total cells above mtCellCountThreshold) → 'no-mirror': the
 * client holds values only (no formulas), cannot recalc anything, so EVERY
 * edit goes to the server unconditionally (no local routing rule is even
 * evaluated), and the server runs multithreaded recalc. Flag OFF
 * (at or below the threshold) → 'mirror': a full mirror ships at open
 * (formulas + cached values + data types), the client builds a local
 * engine, local routing rules apply, and server multithreading stays off.
 * The mirror decision and the server-threading decision are the same flag
 * acting as a unit — not two independent mechanisms. See deriveMirrorMode.
 */
export type MirrorMode = 'mirror' | 'no-mirror';

/** Result of measuring one edit's affected set. */
export interface CalcChainMeasurement {
  /**
   * Distinct formula cells that would recalculate, BFS discovery order.
   * The edited cell itself is excluded.
   */
  cells: CellRef[];
  /** Distinct named-expression vertices on the chain, discovery order. */
  namedExpressions: NamedExpressionNode[];
  /** The structural classification of the affected set (primary output). */
  shape: RecalcShape;
  /**
   * The chain length — ONLY when shape is 'single-chain' (null for
   * multiple chains: length is meaningless there and routing skips the
   * length test). When exact === false this is a LOWER BOUND.
   */
  chainLength: number | null;
  /** Total recalc units found (cells + named expressions). Diagnostic. */
  affectedCount: number;
  /**
   * False when the walk hit maxNodes: counts are lower bounds and shape
   * is certain only if 'multiple-chains' was already observed.
   */
  exact: boolean;
}

export interface MeasureCalcChainOptions {
  /**
   * Hard cap on counted units (cells + named expressions). The walk stops
   * when one more unit would exceed this; the result has exact === false.
   * Routing should pass lengthThreshold + 1 so measurement itself is
   * O(threshold) and any truncated single chain provably exceeds the
   * threshold.
   */
  maxNodes?: number;
}

function isRange(d: GraphDependent): d is GraphCellRange {
  return (
    typeof d === 'object' &&
    d !== null &&
    'start' in d &&
    'end' in d &&
    typeof (d as GraphCellRange).start === 'object' &&
    typeof (d as GraphCellRange).end === 'object'
  );
}

function cellKey(sheet: number, row: number, col: number): string {
  return `c:${sheet}:${row}:${col}`;
}

function rangeKey(r: GraphCellRange): string {
  const e = r.end;
  const er = e.row === null || e.row === undefined ? '∞' : String(e.row);
  const ec = e.col === null || e.col === undefined ? '∞' : String(e.col);
  return `r:${r.start.sheet}:${r.start.row}:${r.start.col}:${er}:${ec}`;
}

interface UnitNode {
  key: string;
  target: GraphTarget;
  cell?: CellRef;
  neIndex?: number;
}

/**
 * Effective dependents of one graph node: the recalc units (cells and
 * named-expression vertices) reachable in one hop, following range
 * vertices transparently. Deduped by unit key. Unknown-sheet cells are
 * skipped (they cannot recalculate in this workbook).
 */
function effectiveDependents(
  source: CalcChainGraphSource,
  node: GraphTarget,
  rangeGuard: Set<string>,
): UnitNode[] {
  const out: UnitNode[] = [];
  const seen = new Set<string>();
  const push = (u: UnitNode): void => {
    if (seen.has(u.key)) return;
    seen.add(u.key);
    out.push(u);
  };
  const walk = (target: GraphTarget): void => {
    let dependents: GraphDependent[];
    try {
      dependents = source.dependentsOf(target);
    } catch {
      return;
    }
    for (const dep of dependents) {
      if (isRange(dep)) {
        const k = rangeKey(dep);
        if (rangeGuard.has(k)) continue;
        rangeGuard.add(k);
        walk(dep);
        continue;
      }
      if (dep.sheet === -1) {
        push({
          key: `n:${dep.row}`,
          target: { sheet: -1, row: dep.row, col: dep.col },
          neIndex: dep.row,
        });
        continue;
      }
      const name = safeSheetName(source, dep.sheet);
      if (name === undefined) continue;
      push({
        key: cellKey(dep.sheet, dep.row, dep.col),
        target: { sheet: dep.sheet, row: dep.row, col: dep.col },
        cell: { sheet: name, row: dep.row, col: dep.col },
      });
    }
  };
  walk(node);
  return out;
}

/**
 * Measure one edit's affected set: shape (primary), chain length (single
 * chains only), and the affected units. Pure over the source seam; safe
 * on arbitrary graphs (cycles, diamonds, unbounded ranges).
 *
 * @param source the dependency graph to walk.
 * @param start the edited cell (HyperFormula address shape).
 */
export function measureCalcChain(
  source: CalcChainGraphSource,
  start: GraphCellAddress,
  opts: MeasureCalcChainOptions = {},
): CalcChainMeasurement {
  const maxNodes =
    opts.maxNodes === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(1, Math.floor(opts.maxNodes));
  const startKey = cellKey(start.sheet, start.row, start.col);
  const startNode: UnitNode = {
    key: startKey,
    target: { sheet: start.sheet, row: start.row, col: start.col },
  };
  const visited = new Set<string>([startKey]);
  /** First effective precedent of each unit (the edited cell counts). */
  const precedentOf = new Map<string, string>();
  const queue: UnitNode[] = [startNode];
  const cells: CellRef[] = [];
  const namedExpressions: NamedExpressionNode[] = [];
  let multiple = false;
  let truncated = false;

  const count = (): number => cells.length + namedExpressions.length;

  outer: while (queue.length > 0) {
    const node = queue.shift()!;
    const eff = effectiveDependents(source, node.target, new Set<string>());
    // Fan-out: one unit feeding 2+ units is never a single chain.
    if (eff.length > 1) multiple = true;
    for (const unit of eff) {
      // Edges back into the edited cell or the node itself: cycles —
      // including self-including ranges — are not a dependent sequence.
      if (unit.key === startKey || unit.key === node.key) {
        multiple = true;
        continue;
      }
      // Merge: a second, distinct effective precedent reaches this unit.
      const prev = precedentOf.get(unit.key);
      if (prev === undefined) precedentOf.set(unit.key, node.key);
      else if (prev !== node.key) multiple = true;
      if (visited.has(unit.key)) continue;
      if (count() >= maxNodes) {
        truncated = true;
        break outer;
      }
      visited.add(unit.key);
      if (unit.cell !== undefined) {
        cells.push(unit.cell);
      } else if (unit.neIndex !== undefined) {
        const ne = safeNamedExpression(source, unit.neIndex);
        namedExpressions.push(
          ne === undefined
            ? { index: unit.neIndex, name: `#unresolved-ne-${unit.neIndex}` }
            : { index: unit.neIndex, name: ne.name, scope: ne.scope },
        );
      }
      queue.push(unit);
    }
  }

  const shape: RecalcShape = multiple ? 'multiple-chains' : 'single-chain';
  return {
    cells,
    namedExpressions,
    shape,
    chainLength: shape === 'single-chain' ? count() : null,
    affectedCount: count(),
    exact: !truncated,
  };
}

function safeSheetName(
  source: CalcChainGraphSource,
  sheetId: number,
): string | undefined {
  try {
    return source.sheetName(sheetId);
  } catch {
    return undefined;
  }
}

function safeNamedExpression(
  source: CalcChainGraphSource,
  index: number,
): { name: string; scope?: number } | undefined {
  try {
    return source.namedExpression(index);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Hybrid recalc configuration. Follows the codebase's config pattern
 * (ParallelRecalcOptions + normalizeParallelOptions): a plain options
 * struct, documented defaults, and a normalizer that clamps bad input.
 * Hosts may additionally read the documented env vars; the engine itself
 * never touches process.env / import.meta.env (see
 * hybridRecalcConfigFromEnv).
 */
export interface HybridRecalcConfig {
  /**
   * TINY-SET escape hatch: total affected units (cells + named
   * expressions) at or below this route LOCAL single-thread, regardless
   * of chain count. Checked FIRST, before the shape test — trivial work
   * never pays a server round trip.
   */
  tinySetThreshold: number;
  /**
   * Length threshold for the SINGLE-CHAIN case only: a single chain of
   * length <= this recalcs locally (single thread); longer goes to the
   * server (single thread). Multiple chains skip this threshold entirely
   * and always go to the server.
   */
  chainLengthThreshold: number;
  /**
   * The SIZE FLAG: total workbook cells (used range) above this → the
   * client holds NO local mirror (server-calc only, browser renders).
   * At or below → full mirror, full hybrid routing applies. Also drives
   * the server's MT auto-flag (how the server executes multi-chain
   * recalcs) — threading only, never routing.
   */
  mtCellCountThreshold: number;
}

/**
 * Default tiny-set threshold: 50.
 *
 * Rationale: 50 cells recalc locally in well under a millisecond — far
 * below the cost of ANY server round trip (network + serialization +
 * scheduling, milliseconds at best). Even a 50-way fan-out is trivial
 * work; the only thing the threshold skips is the round trip, never
 * correctness (the server still sees the op and still wins any conflict).
 * STARTING POINT, tuned from Phase 4 gateway measurements.
 */
export const DEFAULT_TINY_SET_THRESHOLD = 50;

/**
 * Default single-chain length threshold: 200.
 *
 * Rationale: HyperFormula evaluates a typical formula cell in ~1-50 us, so
 * a 200-cell chain usually recalcs in low single-digit milliseconds — well
 * inside one 16 ms frame and inside the "instant feedback" window for
 * keystroke latency. Past this scale the chain is long enough that the
 * server's warm engine wins and the client's frame budget is at risk.
 * This is a STARTING POINT: Cycle 10 Phase 4 (gateway-mode perf
 * evaluation through the real gateway path) measures actual recalc
 * latency vs chain length and tunes this number. The threshold stays a
 * config value — tuning needs no code change.
 */
export const DEFAULT_CHAIN_LENGTH_THRESHOLD = 200;

/**
 * Default size-flag / MT cell-count threshold: 5000 (user's starting
 * point, P75-scale). Below this a workbook keeps a full local mirror and
 * its recalc stays single-threaded (thread overhead not worth it — Excel
 * behaves this way). Tuned later from Phase 4 measurements.
 */
export const DEFAULT_MT_CELL_COUNT_THRESHOLD = 5000;

/** Env var: tinySetThreshold override (hosts read, engine never does). */
export const ENV_TINY_SET_THRESHOLD = 'ICECREAM_TINY_SET_THRESHOLD';
/** Env var: chainLengthThreshold override (hosts read, engine never does). */
export const ENV_CHAIN_LENGTH_THRESHOLD = 'ICECREAM_CHAIN_LENGTH_THRESHOLD';
/** Env var: mtCellCountThreshold override (hosts read, engine never does). */
export const ENV_MT_CELL_COUNT_THRESHOLD = 'ICECREAM_MT_CELL_COUNT_THRESHOLD';

/** Clamp a candidate threshold to a sane positive integer, or undefined. */
function sanitizeThreshold(v: unknown): number | undefined {
  if (typeof v !== 'number' && typeof v !== 'string') return undefined;
  const n = typeof v === 'string' ? Number(v.trim()) : v;
  if (!Number.isFinite(n)) return undefined;
  const i = Math.floor(n);
  return i >= 1 ? i : undefined;
}

/**
 * Normalize partial config: unknown/invalid values fall back to defaults;
 * values < 1 are rejected (a threshold must be a positive cell count).
 */
export function normalizeHybridRecalcConfig(
  opts: Partial<HybridRecalcConfig> = {},
): HybridRecalcConfig {
  return {
    tinySetThreshold:
      sanitizeThreshold(opts.tinySetThreshold) ?? DEFAULT_TINY_SET_THRESHOLD,
    chainLengthThreshold:
      sanitizeThreshold(opts.chainLengthThreshold) ??
      DEFAULT_CHAIN_LENGTH_THRESHOLD,
    mtCellCountThreshold:
      sanitizeThreshold(opts.mtCellCountThreshold) ??
      DEFAULT_MT_CELL_COUNT_THRESHOLD,
  };
}

/**
 * Build config from an env record (process.env on Node, import.meta.env on
 * web — the caller passes it in; the engine reads no globals). Unknown or
 * invalid values are ignored (defaults apply). Documented env vars:
 * ICECREAM_TINY_SET_THRESHOLD, ICECREAM_CHAIN_LENGTH_THRESHOLD,
 * ICECREAM_MT_CELL_COUNT_THRESHOLD.
 */
export function hybridRecalcConfigFromEnv(
  env: Record<string, string | undefined>,
): HybridRecalcConfig {
  return normalizeHybridRecalcConfig({
    tinySetThreshold: sanitizeThreshold(env[ENV_TINY_SET_THRESHOLD]),
    chainLengthThreshold: sanitizeThreshold(env[ENV_CHAIN_LENGTH_THRESHOLD]),
    mtCellCountThreshold: sanitizeThreshold(env[ENV_MT_CELL_COUNT_THRESHOLD]),
  });
}

/**
 * The MT auto-flag: true when the workbook's total cell count (used range)
 * exceeds the threshold. It decides HOW the server executes a multi-chain
 * recalc (parallel vs single thread) — never where an edit routes.
 * Provided here as the shared, documented seam so the routing layer and
 * the server's parallel layer agree on the predicate.
 */
export function autoMtEnabled(
  totalCellCount: number,
  mtCellCountThreshold: number = DEFAULT_MT_CELL_COUNT_THRESHOLD,
): boolean {
  if (!Number.isFinite(totalCellCount) || totalCellCount < 0) return false;
  const t = sanitizeThreshold(mtCellCountThreshold);
  if (t === undefined) return false;
  return totalCellCount > t;
}

/** Unknown/invalid counts fail safe to 'no-mirror'. */
export function deriveMirrorMode(
  totalCellCount: number,
  mtCellCountThreshold: number = DEFAULT_MT_CELL_COUNT_THRESHOLD,
): MirrorMode {
  if (!Number.isFinite(totalCellCount) || totalCellCount < 0) return 'no-mirror';
  return autoMtEnabled(totalCellCount, mtCellCountThreshold)
    ? 'no-mirror'
    : 'mirror';
}

// ---------------------------------------------------------------------------
// Routing policy
// ---------------------------------------------------------------------------

/** Where an edit's recalculation executes. 'local' is always single-thread. */
export type RecalcRoute = 'local' | 'server';

/**
 * Machine-readable reasons for a routing decision. The integration worker
 * logs these; the protocol doc (packages/engine/HYBRID-CONSISTENCY.md)
 * defines the host behavior for each.
 */
export type RecalcRouteReason =
  | 'tiny-set-local'
  | 'chain-short'
  | 'chain-long'
  | 'multiple-chains'
  | 'no-mirror'
  | 'shape-unknown'
  | 'chain-unknown'
  | 'chain-inexact-lower-bound'
  | 'threshold-invalid'
  | 'structural-edit'
  | 'no-local-engine'
  | 'mirror-out-of-sync'
  | 'unreproducible-dependents'
  | 'edit-in-flight'
  | 'offline-provisional-short'
  | 'offline-deferred-long';

export interface RecalcRouteContext {
  /**
   * False when the single-chain length is a LOWER BOUND (measurement
   * truncated at maxNodes) or the shape was classified from a partial
   * walk. Undefined defaults to true (the caller vouches the measurement
   * is complete).
   */
  measurementExact?: boolean;
  /**
   * The edit changes the graph's SHAPE (insert/delete rows/cols, sheet
   * add/remove/rename, defined-name add/change/remove, formula structural
   * ops). Chain measurement on the pre-edit graph is meaningless for
   * these — always server.
   */
  structuralEdit?: boolean;
  /** False when the client has no local engine mirror at all (gateway mode today). */
  localEngineAvailable?: boolean;
  /**
   * False when the mirror's base revision lags the server (unacked ops
   * outstanding, resync pending, or a broadcast gap was detected).
   */
  mirrorInSync?: boolean;
  /**
   * True when the affected set contains volatile functions (NOW, TODAY,
   * RAND, OFFSET/INDIRECT in volatile position), external-workbook refs,
   * or provider-backed functions (data-source connectors): values the
   * client mirror cannot reproduce identically to the server.
   */
  hasUnreproducibleDependents?: boolean;
  /**
   * True when another edit is already in flight to the server. Edits
   * serialize through the authority — no interleaved mirror application.
   */
  editInFlight?: boolean;
  /** False when the server is unreachable (offline, or serverAvailable false). */
  online?: boolean;
  /** False when the gateway/engine service is known down (implies offline). */
  serverAvailable?: boolean;
}

/**
 * The routing input, as one object: (affectedCellCount, shape,
 * chainLength, thresholds, mirrorMode).
 */
export interface RouteRecalcInput {
  /**
   * Total affected recalc units (cells + named expressions) — the input to
   * the tiny-set escape hatch. Null/unknown skips the hatch.
   */
  affectedCellCount: number | null | undefined;
  /** Structural classification of the affected set (primary routing input). */
  shape: RecalcShape | null | undefined;
  /**
   * Chain length — only meaningful when shape is 'single-chain'. The
   * tiny-set check and the multiple-chains rule both ignore it.
   */
  chainLength: number | null | undefined;
  /** Configured thresholds (see HybridRecalcConfig). */
  thresholds: HybridRecalcConfig;
  /**
   * Whether the client holds a full local mirror (see deriveMirrorMode).
   * Anything other than 'mirror' (including unknown) fails safe to the
   * no-mirror branch: every edit goes to the server.
   */
  mirrorMode: MirrorMode | null | undefined;
  /**
   * The server-side MT auto-flag state. Advisory ONLY: it never changes
   * the route — it is echoed into decision.serverThreading for the
   * multiple-chains case (parallel vs single execution on the server).
   * A test pins this orthogonality.
   */
  mtEnabled?: boolean;
  /** Fail-safe flags; see RecalcRouteContext. */
  context?: RecalcRouteContext;
}

export interface RecalcRouteDecision {
  route: RecalcRoute;
  reason: RecalcRouteReason;
  /**
   * True when the route was taken while offline/unreachable: the local
   * values are PROVISIONAL (op queued for replay, server wins on
   * reconnect). See HYBRID-CONSISTENCY.md §6.
   */
  provisional?: boolean;
  /**
   * When route === 'server': the host shows the user's typed input in the
   * edited cell IMMEDIATELY as provisional display (never authoritative);
   * downstream results fill in on the server reply. False for
   * structural-edit (no typed input) and for local routes. See
   * HYBRID-CONSISTENCY.md §7.
   */
  optimisticDisplay?: boolean;
  /**
   * When route === 'server' AND the route was decided by the structural
   * rule: how the server should execute the recalc. 'parallel' ONLY for
   * multiple chains with the MT auto-flag on; a long SINGLE chain is
   * 'single' even with the flag on (a lone chain cannot parallelize —
   * mtEnabled is irrelevant there). Advisory metadata for the host — the
   * server re-derives threading from its own flag. Absent for non-
   * structural server routes and local routes.
   */
  serverThreading?: 'single' | 'parallel';
}

/**
 * Pure routing policy: (affectedCellCount, shape, chainLength, thresholds,
 * mirrorMode) => 'local' | 'server'.
 *
 * The structural rule (see module header — quote verbatim):
 * - The size flag decides the local mirror: 'no-mirror' → ALL edits go to
 *   the server (the browser renders only); 'mirror' → full routing below.
 * - Tiny set: affectedCellCount ≤ tinySetThreshold → 'local'
 *   single-thread, regardless of chain count. Checked FIRST, before the
 *   shape test.
 * - Single chain: length ≤ lengthThreshold → 'local' (single thread);
 *   length > lengthThreshold → 'server', single-threaded (a lone chain
 *   cannot parallelize internally — mtEnabled does NOT thread it).
 * - Multiple chains → 'server', ALWAYS, no length test. mtEnabled then
 *   decides server-side threading (reported as serverThreading):
 *   ON → 'parallel' (independent chains in parallel, Excel-style;
 *   dependent chains serialize), OFF → 'single'.
 *
 * Fail-safe order (first match wins) — anything uncertain routes 'server':
 *  1. structural edits (graph shape changes; pre-edit measurement is
 *     meaningless).
 *  2. mirror mode is not 'mirror' (no local engine to recalc on).
 *  3. no local engine mirror / mirror out of sync (hard engine facts beat
 *     the policy inputs).
 *  4. edit already in flight (serialize through the authority).
 *  5. unreproducible dependents (volatile/external/provider-backed) —
 *     even tiny sets go to the server when values can't be reproduced.
 *  6. the tiny-set escape hatch.
 *  7. multiple chains (structural rule; skips every length test).
 *  8. invalid threshold config.
 *  9. unknown shape (measurement failed).
 * 10. single-chain length unknown.
 * 11. inexact measurement (partial walk; shape/length not final).
 * 12. offline/unreachable (single chain only): short → 'local' but
 *     PROVISIONAL (op queued; server authoritative on reconnect);
 *     long → 'server' DEFERRED (edit accepted as queued input, recalc
 *     waits for the server). Multiple chains offline stay 'server' via
 *     step 7 — they are never provisionally parallel-recalced locally.
 * 13. the length test itself.
 *
 * Boundary: affectedCellCount === tinySetThreshold takes the hatch;
 * chainLength === lengthThreshold routes local ("at or below").
 */
export function routeRecalc(input: RouteRecalcInput): RecalcRouteDecision {
  const { affectedCellCount, shape, chainLength, thresholds, mirrorMode } =
    input;
  const context = input.context ?? {};

  const server = (
    reason: RecalcRouteReason,
    extra: Partial<RecalcRouteDecision> = {},
  ): RecalcRouteDecision => ({
    route: 'server',
    reason,
    optimisticDisplay: reason !== 'structural-edit',
    ...extra,
  });

  if (context.structuralEdit === true) {
    return server('structural-edit');
  }
  // The size flag decides the local mirror: anything other than 'mirror'
  // (including unknown) fails safe to server-calc-only.
  if (mirrorMode !== 'mirror') {
    return server('no-mirror');
  }
  if (context.localEngineAvailable === false) {
    return server('no-local-engine');
  }
  if (context.mirrorInSync === false) {
    return server('mirror-out-of-sync');
  }
  if (context.editInFlight === true) {
    return server('edit-in-flight');
  }
  if (context.hasUnreproducibleDependents === true) {
    return server('unreproducible-dependents');
  }
  // Tiny-set escape hatch: trivial work never pays a server round trip,
  // regardless of chain count. Checked FIRST, before the shape test.
  const tiny = sanitizeThreshold(thresholds.tinySetThreshold);
  const n =
    typeof affectedCellCount === 'number' && Number.isFinite(affectedCellCount)
      ? Math.floor(affectedCellCount)
      : NaN;
  const reachable =
    context.online !== false && context.serverAvailable !== false;
  if (tiny !== undefined && !Number.isNaN(n) && n >= 0 && n <= tiny) {
    // While offline the local values are provisional like any unacked
    // state (§6); online they confirm via the normal ack comparison (§2).
    return reachable
      ? { route: 'local', reason: 'tiny-set-local' }
      : { route: 'local', reason: 'tiny-set-local', provisional: true };
  }
  if (shape === 'multiple-chains') {
    // Multiple chains → server, ALWAYS. No length test. The MT auto-flag
    // decides threading on the server only.
    return server('multiple-chains', {
      serverThreading: input.mtEnabled === true ? 'parallel' : 'single',
    });
  }
  const lengthThreshold = sanitizeThreshold(thresholds.chainLengthThreshold);
  if (lengthThreshold === undefined) {
    return server('threshold-invalid');
  }
  if (shape !== 'single-chain') {
    return server('shape-unknown');
  }
  const len =
    typeof chainLength === 'number' && Number.isFinite(chainLength)
      ? Math.floor(chainLength)
      : NaN;
  if (Number.isNaN(len) || len < 0) {
    return server('chain-unknown');
  }
  if (context.measurementExact === false) {
    return server('chain-inexact-lower-bound');
  }
  if (!reachable) {
    // Offline: 'server' is unreachable, so the local tier takes the edit
    // ONLY as provisional state (queued op + stale marking); a long single
    // chain stays deferred to the server. See HYBRID-CONSISTENCY.md §6.
    if (len <= lengthThreshold) {
      return {
        route: 'local',
        reason: 'offline-provisional-short',
        provisional: true,
      };
    }
    return server('offline-deferred-long', { serverThreading: 'single' });
  }
  if (len > lengthThreshold) {
    // Long single chain → server, single thread: a lone chain cannot
    // parallelize internally — mtEnabled does NOT thread it.
    return server('chain-long', { serverThreading: 'single' });
  }
  return { route: 'local', reason: 'chain-short' };
}
