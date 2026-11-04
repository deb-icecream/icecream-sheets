/**
 * Routed edit execution — Cycle 10 Phase 3 INTEGRATION of the Phase 3
 * routing library (packages/engine/src/calc-chain.ts) and the hybrid
 * consistency protocol (packages/engine/HYBRID-CONSISTENCY.md) into the
 * web gateway edit flow.
 *
 * One edit, end to end:
 *   1. MEASURE + ROUTE — `routeRecalc` (pure engine policy) decides local
 *      vs server from (affectedCellCount, shape, chainLength, thresholds,
 *      mirrorMode). Mirror mode is derived from the CURRENT (server)
 *      workbook's cell count via `deriveMirrorMode`; the MT flag comes
 *      from the SAME count via `shouldEnableParallelRecalc` — ONE FLAG,
 *      TWO CONSEQUENCES, always as a unit.
 *   2. MIRROR PRECONDITION — local routing is evaluated ONLY when a local
 *      mirror engine is present AND the flag says 'mirror'. When the mode
 *      is 'no-mirror' this module NEVER calls the mirror (not even to
 *      measure): the decision is produced from the pure policy inputs
 *      alone and every edit goes to the server.
 *   3. LOCAL route — the mirror recalcs provisionally; the op is STILL
 *      written through to the server (write-through, protocol §2). The
 *      server's ack is compared against the provisional values: when the
 *      ack carries a checksum (edit-path optimization (b)) the
 *      comparison is checksum-vs-checksum over the same affected set —
 *      match → confirmed with NO value fetch; mismatch → the full ack
 *      VALUES are fetched and compared exactly as before: equal →
 *      confirmed; different → SERVER WINS (divergence logged, ack
 *      values handed back for the view to display). The divergence
 *      guarantee is identical either way (HYBRID-CONSISTENCY.md §2).
 *   4. SERVER route — the typed input is recorded as OPTIMISTIC display
 *      immediately (protocol §7, provisional, never authoritative);
 *      dependents stay last-confirmed and are reported stale. The mirror
 *      is NOT asked to recalc dependents. On ack, authoritative values
 *      confirm the op; on rejection the op rolls back VISIBLY (the
 *      caller restores the previous confirmed value and notifies).
 *   5. FAIL-SAFES — all 16 routeRecalc cases are reachable from here:
 *      structural edits, no-mirror, no-local-engine, mirror-out-of-sync,
 *      edit-in-flight, unreproducible dependents (volatile / external /
 *      provider-backed formulas found by inspecting the affected set),
 *      threshold-invalid, shape/chain unknown, inexact measurement,
 *      offline provisional/deferred — anything uncertain routes server.
 */
import {
  computeAckChecksum,
  deriveMirrorMode,
  hybridRecalcConfigFromEnv,
  normalizeHybridRecalcConfig,
  routeRecalc,
  shouldEnableParallelRecalc,
  type CellRef,
  type CommandResult,
  type EditAck,
  type EngineCommand,
  type EngineHost,
  type HybridRecalcConfig,
  type RecalcRouteDecision,
  type TypedValue,
} from '@icecream-sheets/engine';

// ---------------------------------------------------------------------------
// Threshold resolution (settings + env)
// ---------------------------------------------------------------------------

/**
 * Resolve the hybrid thresholds for a host. The MT cell-count threshold
 * is settings-configurable (Calculation Options, default 5000); the env
 * override ICECREAM_MT_CELL_COUNT_THRESHOLD stays CANONICAL — when it is
 * set to a valid value it wins over the settings field. Tiny-set and
 * chain-length thresholds come from their env vars / engine defaults.
 */
export function resolveHybridThresholds(opts: {
  settingsMtThreshold?: number | null;
  env?: Record<string, string | undefined>;
} = {}): HybridRecalcConfig {
  const fromEnv = opts.env ? hybridRecalcConfigFromEnv(opts.env) : null;
  const envMt = opts.env?.['ICECREAM_MT_CELL_COUNT_THRESHOLD'];
  const envMtValid = envMt !== undefined && envMt !== '' && Number.isFinite(Number(envMt)) && Number(envMt) >= 1;
  return normalizeHybridRecalcConfig({
    tinySetThreshold: fromEnv?.tinySetThreshold,
    chainLengthThreshold: fromEnv?.chainLengthThreshold,
    mtCellCountThreshold: envMtValid
      ? Math.floor(Number(envMt))
      : (opts.settingsMtThreshold ?? fromEnv?.mtCellCountThreshold),
  });
}

// ---------------------------------------------------------------------------
// Command classification + unreproducible-dependent inspection (fail-safe #6)
// ---------------------------------------------------------------------------

const STRUCTURAL_COMMANDS = new Set([
  'addSheet', 'deleteSheet', 'renameSheet', 'duplicateSheet', 'moveSheet',
  'insertRows', 'deleteRows', 'insertCols', 'deleteCols',
  'defineName', 'deleteName', 'renameName', 'updateNameRefersTo',
  'defineFunction', 'updateFunction', 'rollbackFunction', 'deleteFunction',
]);

/** True when the command changes the dependency graph's shape (protocol §5 #1). */
export function isStructuralCommand(command: EngineCommand): boolean {
  return STRUCTURAL_COMMANDS.has(command.cmd);
}

/**
 * Formulas whose values a local mirror cannot reproduce identically to
 * the server: volatile functions, external-workbook refs, and
 * provider-backed functions (fetch/connector/market/python seams).
 */
const UNREPRODUCIBLE_RE =
  /\b(NOW|TODAY|RAND|RANDBETWEEN|OFFSET|INDIRECT|IMPORTDATA|IMPORTFEED|IMPORTHTML|IMPORTXML|IMPORTRANGE|WEBSERVICE|RTD|COPILOT|PY|GOOGLEFINANCE|STOCKHISTORY|IMAGE)\s*\(|\[\d+\]/i;

export function formulaHasUnreproducibleDependents(formula: string | null | undefined): boolean {
  return typeof formula === 'string' && UNREPRODUCIBLE_RE.test(formula);
}

/**
 * Inspect the affected set's formulas on the mirror (protocol §5 case 6).
 * Any inspection failure counts as unreproducible — conservative by
 * design; the §2 ack comparison remains the backstop either way.
 */
export function affectedHasUnreproducibleDependents(
  mirror: EngineHost,
  editedRef: CellRef,
  affected: CellRef[],
  editedFormula?: string,
): boolean {
  try {
    if (formulaHasUnreproducibleDependents(editedFormula)) return true;
    const view = mirror.getView();
    if (formulaHasUnreproducibleDependents(view.readCell(editedRef).formula)) return true;
    for (const ref of affected) {
      if (formulaHasUnreproducibleDependents(view.readCell(ref).formula)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Optimistic display session (protocol §6/§7 state machine)
// ---------------------------------------------------------------------------

export function refKey(ref: CellRef): string {
  return `${ref.sheet}:${ref.row}:${ref.col}`;
}

/** Structural equality for TypedValues (kind + payload + error code). */
export function typedValuesEqual(a: TypedValue | undefined, b: TypedValue | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export type PendingOpState = 'awaiting-server' | 'provisional-local' | 'queued-offline';

export interface PendingOp {
  opId: string;
  ref: CellRef;
  /** What the edited cell displays right now (provisional, §7). */
  displayValue: TypedValue;
  /** The typed formula, when the edit was a formula (formula-bar display). */
  formula?: string;
  /** Dependents whose confirmed values are stale until the ack lands. */
  dependents: CellRef[];
  /** Last confirmed value of the edited cell — the rollback target. */
  previousValue: TypedValue;
  state: PendingOpState;
  /** Provisional values computed locally (local route), keyed by refKey. */
  provisionalValues?: Map<string, TypedValue>;
}

let opSeq = 0;

/**
 * Tracks in-flight ops: optimistic display values, stale dependents,
 * provisional local values, ack confirmation (server wins on any
 * disagreement) and visible rollback on rejection. `baseRev` counts
 * confirmed acks — the client's traceable confirmed revision (invariant:
 * every confirmed value traces to an ack).
 */
export class OptimisticEditSession {
  private readonly pending = new Map<string, PendingOp>();
  private readonly byRef = new Map<string, string>();
  private confirmedAcks = 0;
  // Save-interlock signal (Cycle 10 closure, additive): listeners +
  // settle waiters notified on every pending-count change, so save /
  // autosave paths can DEFER while any op is in flight (see
  // services/saveInterlock.ts). No routing behavior changes.
  private readonly pendingListeners = new Set<() => void>();
  private pendingWaiters: Array<() => void> = [];
  /** Divergence events (provisional ≠ ack) — bug signals, never hidden. */
  readonly divergences: Array<{ opId: string; ref: CellRef; provisional: TypedValue; server: TypedValue }> = [];

  get baseRev(): number {
    return this.confirmedAcks;
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  /** Number of ops currently in flight (save-interlock signal). */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Notify `listener` whenever the pending count changes. */
  subscribePending(listener: () => void): () => void {
    this.pendingListeners.add(listener);
    return () => {
      this.pendingListeners.delete(listener);
    };
  }

  /** Resolves once no op is pending (immediately when already idle). */
  whenSettled(): Promise<void> {
    if (this.pending.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.pendingWaiters.push(resolve);
    });
  }

  private notifyPendingChanged(): void {
    for (const l of [...this.pendingListeners]) {
      try {
        l();
      } catch {
        // A failing listener must not break the edit pipeline.
      }
    }
    if (this.pending.size === 0 && this.pendingWaiters.length > 0) {
      const ready = this.pendingWaiters;
      this.pendingWaiters = [];
      for (const resolve of ready) resolve();
    }
  }

  begin(op: Omit<PendingOp, 'opId'>): PendingOp {
    const withId: PendingOp = { ...op, opId: `op-${++opSeq}` };
    this.pending.set(withId.opId, withId);
    this.byRef.set(refKey(withId.ref), withId.opId);
    this.notifyPendingChanged();
    return withId;
  }

  get(opId: string): PendingOp | undefined {
    return this.pending.get(opId);
  }

  pendingFor(ref: CellRef): PendingOp | undefined {
    const id = this.byRef.get(refKey(ref));
    return id ? this.pending.get(id) : undefined;
  }

  /**
   * The optimistic (provisional) display value for a cell, if pending:
   * the edited cell's own display value, OR — issue #66 — a dependent's
   * locally computed provisional value from a pending local-route op.
   * Without the second lookup the provisionalValues map was write-only:
   * no read path ever consulted it, so dependents could not paint during
   * flight even though the mirror had already computed them.
   */
  optimisticValue(ref: CellRef): TypedValue | undefined {
    const own = this.pendingFor(ref);
    if (own) return own.displayValue;
    const k = refKey(ref);
    for (const op of this.pending.values()) {
      const v = op.provisionalValues?.get(k);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  /** True when `ref` is a dependent of a pending op (stale until ack). */
  isStale(ref: CellRef): boolean {
    const k = refKey(ref);
    for (const op of this.pending.values()) {
      if (op.dependents.some((d) => refKey(d) === k)) return true;
    }
    return false;
  }

  /**
   * Confirm an op with the server's authoritative ack values. Returns the
   * cells where the ack disagreed with what was displayed provisionally —
   * the SERVER value wins for every one of them (protocol §3).
   */
  confirm(
    opId: string,
    ackValues?: Map<string, TypedValue>,
  ): { divergedCells: CellRef[]; ackValues?: Map<string, TypedValue> } {
    const op = this.pending.get(opId);
    if (!op) return { divergedCells: [] };
    const divergedCells: CellRef[] = [];
    if (ackValues) {
      const check = (ref: CellRef, provisional: TypedValue | undefined): void => {
        const server = ackValues.get(refKey(ref));
        if (server !== undefined && provisional !== undefined && !typedValuesEqual(server, provisional)) {
          divergedCells.push(ref);
          this.divergences.push({ opId, ref, provisional, server });
        }
      };
      check(op.ref, op.displayValue);
      if (op.provisionalValues) {
        for (const ref of op.dependents) check(ref, op.provisionalValues.get(refKey(ref)));
      }
    }
    this.pending.delete(opId);
    this.byRef.delete(refKey(op.ref));
    this.confirmedAcks++;
    this.notifyPendingChanged();
    return { divergedCells, ackValues };
  }

  /**
   * Reject/ fail an op: drop the optimistic state and return the op so
   * the caller can VISIBLY roll the cell back to `previousValue`
   * (protocol §7 rule 3 — never silent).
   */
  reject(opId: string): PendingOp | undefined {
    const op = this.pending.get(opId);
    if (op) {
      this.pending.delete(opId);
      this.byRef.delete(refKey(op.ref));
      this.notifyPendingChanged();
    }
    return op;
  }
}

// ---------------------------------------------------------------------------
// The routed edit itself
// ---------------------------------------------------------------------------

export interface RoutedEditDeps {
  /** Local mirror engine, or null (flag ON / not built). */
  mirror: EngineHost | null;
  /**
   * The CURRENT workbook's total cell count (the server workbook's count
   * in gateway mode). Null/unknown fails safe to 'no-mirror'.
   */
  totalCellCount: number | null;
  thresholds: HybridRecalcConfig;
  /**
   * Write-through transport: apply the op on the authoritative engine.
   * The optional `ackChecksum` flag asks the transport to have the
   * server attach its checksum ack (§2) to the result — requested ONLY
   * on the local route, where the client has provisional values to
   * verify; transports that ignore the flag simply return no ack and
   * the value-fetch comparison runs as before.
   */
  serverExecute: (command: EngineCommand, opts?: { ackChecksum?: boolean }) => Promise<CommandResult>;
  /**
   * Fetch the server's authoritative values for refs after an ack (the
   * ack payload of protocol §2). Optional: without it, local provisional
   * values confirm unverified and server-route dependents refresh via
   * the host's normal event/cache path.
   */
  fetchAckValues?: (refs: CellRef[]) => Promise<Map<string, TypedValue>>;
  /** Last confirmed value of the edited cell (rollback + display base). */
  readConfirmedValue?: (ref: CellRef) => TypedValue;
  online?: boolean;
  mirrorInSync?: boolean;
  session?: OptimisticEditSession;
  onRouting?: (decision: RecalcRouteDecision, command: EngineCommand) => void;
}

export interface RoutedEditOutcome {
  decision?: RecalcRouteDecision;
  result: CommandResult;
  opId?: string;
  /** The server's checksum ack, when the transport carried one (§2). */
  ack?: EditAck;
  /**
   * True when the ack checksum matched the local provisional values:
   * the op confirmed with NO ack value fetch (edit-path optimization
   * (b)). False/absent means the value-fetch comparison ran (or no ack
   * was offered and today's fallback applied).
   */
  ackChecksumVerified?: boolean;
  /** Server ack disagreed with provisional display; server values won. */
  divergedCells?: CellRef[];
  /** Authoritative values from the ack (seed the view with these). */
  ackValues?: Map<string, TypedValue>;
  /** The op was rejected/failed; the caller must show `rollbackValue`. */
  rolledBack?: boolean;
  rollbackValue?: TypedValue;
  /** Offline-deferred: accepted as queued input, recalc waits (§6). */
  queued?: boolean;
}

/** The engine's empty-cell value (TypedValue null kind). */
const EMPTY: TypedValue = { kind: 'null', value: null };

/**
 * Extract a well-formed checksum ack from a transport result, or
 * undefined (older server / transport without ack support → the caller
 * falls back to the §2 value-fetch comparison, unchanged).
 */
export function ackFromResult(result: CommandResult): EditAck | undefined {
  const ack = (result as CommandResult & { ack?: unknown }).ack as Partial<EditAck> | undefined;
  if (
    ack &&
    typeof ack.revision === 'number' &&
    typeof ack.changedCellCount === 'number' &&
    typeof ack.checksum === 'string'
  ) {
    return ack as EditAck;
  }
  return undefined;
}

/**
 * True when the server's ack checksum covers exactly the affected set
 * the client computed locally AND matches the client's provisional
 * values. The checksum is computed over the same serialization the
 * server used (engine ack-checksum.ts): [edited ref + dependents],
 * sorted, kind-tagged values. A match proves the local values equal
 * the server's post-edit values — the §2 comparison, encoded as a hash.
 */
export function ackMatchesLocalValues(
  ack: EditAck,
  affected: CellRef[],
  localValues: ReadonlyMap<string, TypedValue>,
): boolean {
  return (
    ack.changedCellCount === affected.length &&
    ack.checksum === computeAckChecksum(affected, localValues)
  );
}

function inputDisplayValue(command: EngineCommand): TypedValue | undefined {
  if (command.cmd === 'setCell') {
    const v = command.value;
    if (typeof v === 'number') return { kind: 'number', value: v } as TypedValue;
    if (typeof v === 'boolean') return { kind: 'boolean', value: v } as TypedValue;
    if (typeof v === 'string') return { kind: 'string', value: v } as TypedValue;
    return EMPTY;
  }
  return undefined;
}

/** Route + execute ONE edit command per HYBRID-CONSISTENCY.md. */
export async function executeRoutedEdit(
  deps: RoutedEditDeps,
  command: EngineCommand,
): Promise<RoutedEditOutcome> {
  // Non-cell edits have no chain to route: structural edits go straight
  // to the authority with the structural decision recorded; other
  // commands (recalculate, calc-mode, …) pass through untouched.
  if (command.cmd !== 'setCell' && command.cmd !== 'setFormula') {
    const result = await deps.serverExecute(command);
    return isStructuralCommand(command)
      ? { decision: { route: 'server', reason: 'structural-edit', optimisticDisplay: false }, result }
      : { result };
  }

  const ref = command.ref;
  const session = deps.session ?? new OptimisticEditSession();
  const thresholds = deps.thresholds;
  const total = deps.totalCellCount;
  const mirrorMode = total === null || total === undefined
    ? 'no-mirror'
    : deriveMirrorMode(total, thresholds.mtCellCountThreshold);
  const mtEnabled = total !== null && total !== undefined
    ? shouldEnableParallelRecalc(total, thresholds.mtCellCountThreshold)
    : false;
  const mirrorUsable = deps.mirror !== null && mirrorMode === 'mirror';
  const previousValue = deps.readConfirmedValue?.(ref)
    ?? (mirrorUsable ? deps.mirror!.getView().readCell(ref).value : EMPTY);

  // -- Route ----------------------------------------------------------------
  let decision: RecalcRouteDecision;
  let dependents: CellRef[] = [];
  if (!mirrorUsable) {
    // MIRROR PRECONDITION: no-mirror (or no mirror built) — the pure
    // policy decides from flags alone; the mirror is never consulted.
    decision = routeRecalc({
      affectedCellCount: null,
      shape: null,
      chainLength: null,
      thresholds,
      mirrorMode,
      mtEnabled,
      context: {
        structuralEdit: false,
        localEngineAvailable: deps.mirror !== null && mirrorMode === 'mirror',
        mirrorInSync: deps.mirrorInSync,
        editInFlight: session.hasPending(),
        online: deps.online,
      },
    });
  } else {
    const mirror = deps.mirror!;
    let affected: number | null = null;
    let shape: 'single-chain' | 'multiple-chains' | null = null;
    let length: number | null = null;
    let exact = false;
    let unreproducible = false;
    try {
      const m = mirror.measureCalcChain(ref, { maxNodes: thresholds.chainLengthThreshold + 1 });
      affected = m.affectedCount;
      shape = m.shape;
      length = m.chainLength;
      exact = m.exact;
      dependents = m.cells;
      unreproducible = affectedHasUnreproducibleDependents(
        mirror,
        ref,
        m.cells,
        command.cmd === 'setFormula' ? command.formula : undefined,
      );
    } catch {
      // Measurement failure → null shape → routeRecalc fails safe to server.
    }
    decision = routeRecalc({
      affectedCellCount: affected,
      shape,
      chainLength: length,
      thresholds,
      mirrorMode,
      mtEnabled,
      context: {
        measurementExact: exact,
        structuralEdit: false,
        localEngineAvailable: true,
        mirrorInSync: deps.mirrorInSync,
        hasUnreproducibleDependents: unreproducible,
        editInFlight: session.hasPending(),
        online: deps.online,
      },
    });
  }
  deps.onRouting?.(decision, command);

  // Offline-deferred long chain: accept the input as queued, no transport.
  if (decision.reason === 'offline-deferred-long') {
    const op = session.begin({
      ref,
      displayValue: inputDisplayValue(command) ?? previousValue,
      formula: command.cmd === 'setFormula' ? command.formula : undefined,
      dependents,
      previousValue,
      state: 'queued-offline',
    });
    return { decision, result: { ok: true, data: { queued: true } }, opId: op.opId, queued: true };
  }

  // -- Local route ------------------------------------------------------------
  if (decision.route === 'local' && mirrorUsable) {
    const mirror = deps.mirror!;
    // Capture the previous input so a server rejection can roll the
    // mirror back too (visible rollback, never a silent fork).
    const prevCell = mirror.getView().readCell(ref);
    const localResult = mirror.execute(command);
    if (!localResult.ok) return { decision, result: localResult };
    const provisionalValues = new Map<string, TypedValue>();
    provisionalValues.set(refKey(ref), mirror.getView().readCell(ref).value);
    for (const d of dependents) provisionalValues.set(refKey(d), mirror.getView().readCell(d).value);
    const op = session.begin({
      ref,
      displayValue: provisionalValues.get(refKey(ref))!,
      formula: command.cmd === 'setFormula' ? command.formula : undefined,
      dependents,
      previousValue,
      state: decision.provisional ? 'queued-offline' : 'provisional-local',
      provisionalValues,
    });
    if (decision.provisional) {
      // Offline: provisional only; the op replays on reconnect (§6).
      return { decision, result: { ok: true, data: { queued: true } }, opId: op.opId, queued: true };
    }
    // Write-through: the server always sees the op (§2). Local route:
    // ask for the checksum ack so the confirm can skip the value fetch.
    let serverResult: CommandResult;
    try {
      serverResult = await deps.serverExecute(command, { ackChecksum: true });
    } catch (e) {
      serverResult = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (!serverResult.ok) {
      rollbackMirror(mirror, ref, prevCell.formula, previousValue);
      session.reject(op.opId);
      return { decision, result: serverResult, opId: op.opId, rolledBack: true, rollbackValue: previousValue };
    }
    // CHEAPER ACK (§2 checksum variant): when the server ack's checksum
    // matches the provisional values over the identical affected set,
    // the op confirms with NO value fetch — the comparison happened,
    // encoded as a hash. Any mismatch (or no ack offered) runs the
    // original full value fetch and server-wins resolution, unchanged.
    const ack = ackFromResult(serverResult);
    if (ack && ackMatchesLocalValues(ack, [ref, ...dependents], provisionalValues)) {
      const { divergedCells } = session.confirm(op.opId);
      return { decision, result: serverResult, opId: op.opId, divergedCells, ack, ackChecksumVerified: true };
    }
    const ackVals = deps.fetchAckValues
      ? await deps.fetchAckValues([ref, ...dependents]).catch(() => undefined)
      : undefined;
    const { divergedCells, ackValues } = session.confirm(op.opId, ackVals);
    return { decision, result: serverResult, opId: op.opId, divergedCells, ackValues, ack };
  }

  // -- Server route -------------------------------------------------------------
  const op = session.begin({
    ref,
    displayValue: inputDisplayValue(command) ?? previousValue,
    formula: command.cmd === 'setFormula' ? command.formula : undefined,
    dependents,
    previousValue,
    state: 'awaiting-server',
  });
  let serverResult: CommandResult;
  try {
    serverResult = await deps.serverExecute(command);
  } catch (e) {
    serverResult = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!serverResult.ok) {
    session.reject(op.opId);
    return { decision, result: serverResult, opId: op.opId, rolledBack: true, rollbackValue: previousValue };
  }
  const ackRefs = [ref, ...dependents];
  const ackVals = deps.fetchAckValues
    ? await deps.fetchAckValues(ackRefs).catch(() => undefined)
    : undefined;
  const { divergedCells, ackValues } = session.confirm(op.opId, ackVals);
  // Server route: dependents were never computed locally, so there is
  // nothing to checksum against — the ack VALUES above are the confirm
  // path (unchanged). The checksum ack rides along for observability.
  return { decision, result: serverResult, opId: op.opId, divergedCells, ackValues, ack: ackFromResult(serverResult) };
}

function rollbackMirror(
  mirror: EngineHost,
  ref: CellRef,
  prevFormula: string | undefined,
  prevValue: TypedValue,
): void {
  try {
    if (prevFormula !== undefined) {
      mirror.execute({ cmd: 'setFormula', ref, formula: prevFormula });
    } else if (prevValue.kind === 'number' || prevValue.kind === 'string' || prevValue.kind === 'boolean') {
      mirror.execute({ cmd: 'setCell', ref, value: (prevValue as { value: unknown }).value as never });
    } else {
      mirror.execute({ cmd: 'setCell', ref, value: null as never });
    }
  } catch {
    // Rollback is best-effort; the session already dropped the op and the
    // caller surfaces the rejection — the mirror resyncs from the server.
  }
}
