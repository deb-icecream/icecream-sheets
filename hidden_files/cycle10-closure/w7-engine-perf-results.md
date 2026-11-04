# W7 — Engine perf: deep-chain edit latency (B2) + mirror construction (B4)

Cycle 10 closure pass. Sources: perf-evaluation.md §7 defect 6 residual
(the 18.7 s `planPartitions` pre-walk) and the Phase 4 server-perf note
in progress.md (mirror construction ~1.3 s of P50's / ~2.8 s of P75's
server /load wall at that time; ~0.1–0.2 s in the BEFORE runs below —
the D3 hidden-taint memoization had already landed since).

All service timings are API-level (node fetch against the engine
service on :8101, the stack's real build), per the task's contention
guidance. Sibling workers were rebuilding web/desktop and running
browser work on this 2-core VM throughout: load average was ~1 during
the BEFORE runs and 2.3–3.3 during the AFTER runs, which inflates
absolute service walls (untouched stages too — see the B4 caveat).
Where absolutes are not comparable, the primary evidence is a
controlled in-process A/B (same process, old vs new sequence
alternated, medians of 5).

## ITEM B2 — Deep-chain edit latency (defect 6 residual)

### Before (current build at task start, real engine service)

P95 loaded via `/load` (wall 45.7 s, mirror ABSENT — flag ON, correct),
then `Ledger!E2 → 12345.67` via `/execute` (the §7 edit):

| Measurement | Before |
|---|---|
| /execute edit 1 (fresh load) | **20,830 ms** (cf. §7's 18.7 s) |
| /execute edit 2 (value toggle E2 → 12345.68) | **16,369 ms** |
| Ledger G2 after edit | −36,362.84 (exact, §7) |
| Ledger G30002 after edit | −20,430,013.31 (exact, file ground truth) |

Isolated profile (same build, in-process): serial `setCell` (HF recalc
of the chain) = **462 ms**; `planPartitions` full = **18,744 ms** for
480,005 formula cells / 60,000 stages / 60,010 partitions; raw
`getPrecedents` over all formulas = only 391 ms — the cost was the
planner's own whole-workbook data structures (string-keyed precedent
maps retained for every cell, boundary construction for a plan the
degenerate guard then rejects).

### Design

Two mechanisms, both in `packages/engine/src/parallel/partition.ts`,
plus the guard wiring in `parallel-recalc.ts`:

1. **Plan cache keyed by the workbook's graph version.** A plan is a
   pure function of graph shape (formula cells, formula precedents,
   named-expression target edges, tracked-cell set) — none of which a
   pure value edit changes. `planPartitions` now caches per workbook
   (WeakMap) keyed by `(graphVersion, workerCount, early-exit params)`,
   reusing the sibling-landed `EngineWorkbook.graphVersion` — no second
   version signal was invented (a `getGraphVersion()` accessor was
   added). Invalidation is exactly the version's bump rule, with ONE
   extension in `trackCellInput` (workbook.ts): tracked-set
   **membership** changes (a cell becoming tracked / ceasing to be
   tracked) now also bump, because a new literal precedent changes
   partition boundaries and the total cell count even with no formula
   involved. Value→value edits on tracked cells still never bump.
   Cached plans are never mutated by the orchestrator.
2. **Early degenerate exit (the pre-gate).** The planner was
   restructured into phase A (depth levelisation) and phase B
   (partition/boundary construction). Phase A no longer retains the
   all-precedents map (boundaries are recomputed per owned cell in
   phase B, only for plans that execute; named-expression boundary
   extras are retained per cell from phase A). Kahn's algorithm
   completes exactly one depth level per iteration, so after each
   level beyond the guard's stage floor (64) the planner computes an
   **exact upper bound** on the finished plan's average stage width:
   a completion adds A stages holding Q ≤ min(remaining, target·A)
   partitions, and (P+Q)/(S+A) is monotonic in A on each side of
   A₀ = remaining/target, so the maximum over all completions is
   attained at A ∈ {1, ⌊A₀⌋, ⌈A₀⌉}. When that bound falls below the
   guard's floor (avg width 4), the finished plan is *provably*
   degenerate — planning stops and returns `degenerateEarlyExit`
   (empty stages); `ParallelRecalculator` passes its existing guard
   constants (`DEGENERATE_STAGE_FLOOR`, `MIN_AVG_STAGE_WIDTH`) as the
   early-exit parameters and reports the usual `degenerate plan …`
   serial fallback. Skipping staged evaluation is always
   value-identical (serial is the reference semantics); the proof
   only ensures deep+wide plans are never diverted (see the
   differential test below — a deep+wide plan's bound never drops
   below the floor). Planner keys are numeric
   ((sheetIdx·2²⁰+row)·2¹⁴+col) instead of template strings.

### After (rebuilt engine+gateway dists, engine restarted, same edit)

| Measurement | Before | After |
|---|---|---|
| /execute edit 1 (fresh P95 load) | 20,830 ms | **8,051 ms** (2.6×) |
| /execute edit 2 (value toggle) | 16,369 ms | **722 ms** (23× — cached verdict; ≈ serial recalc alone) |
| Isolated cold plan with early exit | 18,744 ms (full plan) | **3,919 ms** (aborts at stage 65; bound 3.988 < 4; 59,935 formula cells never walked) |
| Isolated warm plan (repeat call) | 18,744 ms | **0 ms** (cache identity) |
| Ledger G2 / G30002 after both edits | exact | exact (−36,362.84 / −36,362.83; −20,430,013.31 / −20,430,013.30) |

The residual cold cost (~3.9 s isolated) is phase A itself: indegree
requires every formula cell's precedent edges before the first 65
levels can be levelised. The named next lever (not attempted) is a
bulk dependency-graph edge dump from HyperFormula instead of 480k
per-cell `getPrecedents` calls. Browser-visible settle was not
re-measured (browser work is a sibling's; the API numbers above are
the contention-safer evidence, and the browser number in §7, 30.6 s,
was dominated by this same server walk).

## ITEM B4 — Mirror construction cost

### Design

`buildFromData` (gateway `engineSvc.ts`) previously built the mirror
as: `filteredSnapshot()` — a full `toSnapshot()` (one HyperFormula
serialization per cell in the used rectangle) **plus** a per-cell
`host.readCell` — and then a **second** per-cell `host.readCell` for
the mirror values: ~3 per-cell passes, each re-serializing formulas.

Now: one bulk pass —

- `EngineWorkbook.getBulkReadback(auth)` (workbook.ts): one pass over
  the workbook's tracked cell storage, sorted (sheet order, row, col)
  = snapshot order, returning per non-empty cell the snapshot input
  (exactly `getSerialized`'s output — each cell serialized ONCE), the
  computed value, and an isFormula flag. Values come from the
  workbook's maintained value cache **only when provably
  auth-independent**: literal cells, and formula cells whose
  serialized text references no names/functions (new
  `scanFormulaNames` helper, split out of `findUnreadableName`).
  Any cell referencing a name/function, any cache miss, and suspended
  mode all take the exact `getValue()` path, so static name denials
  and mid-evaluation `function.read` denials produce identical
  #PERM! outcomes.
- `EngineHost.bulkReadback(auth)` (protocol.ts): applies `readCell`'s
  exact check order per cell — authorize('cell.read') → direct hidden
  check → workbook value → formula hidden-taint check — with the same
  #PERM! values/messages.
- `engineSvc.ts` groups the bulk records by sheet (every sheet ships,
  empty included; cells row-major) and drops #PERM! cells, exactly as
  the filtered snapshot did. **Mirror contract unchanged**: complete
  mirror (input + value + type-in-kind) iff the auto-flag is OFF;
  no mirror when ON.

### Before / after

Before, real engine service (`/load`, n=3, quiet VM):

| Fixture | /load wall median | mirrorMs median | Mirror cells |
|---|---|---|---|
| P50 | 592 ms (943/592/587) | 207 ms (207/192/225) | 3,942 |
| P75 | 751 ms (779/751/713) | 105 ms (105/148/105) | 2,957 |
| P95 | 45,713 ms | 0 (mirror ABSENT ✓) | — |

After, real engine service (n=3, then a second batch n=5; VM load
average 2.3–3.3 from sibling browser/desktop work — absolutes are
contention-inflated and NOT comparable to the before batch: the
untouched build stage inflated identically, P75 buildMs 424–454 ms
before vs 742–952 ms after): mirror present with **identical cell
counts** (P50 3,942; P75 **2,957**, matching the Phase 2 probe), P95
mirror absent ✓, mirrorMs medians 165 ms (P50) / 159 ms (P75) under
that contention.

Post-restart smoke of the other buildFromData consumer, `/load/stream`
for P75: stream completes (meta → rows → data-done → built), the built
response's mirror has 13 sheets / **2,957 cells**, mirrorMs **67 ms**
(single run, under the same contention).

Primary B4 evidence — controlled in-process A/B (same process, old
snapshot+2×readCell sequence vs `bulkReadback`, alternated, medians
of 5), under BOTH host configurations:

| Fixture | Host config | Old sequence | Bulk readback |
|---|---|---|---|
| P50 | plain EngineHost | 149 ms | **68 ms** (2.2×) |
| P75 | plain EngineHost | 65 ms | **37 ms** (1.8×) |
| P50 | service config (protection authorizer + hidden check, as wireFresh) | 297 ms | **130 ms** (2.3×) |
| P75 | service config | 110 ms | **74 ms** (1.5×) |

## Tests

Related suites only, all green:

- Engine: `parallel-recalc.test.ts` 51 + `parallel-degenerate-plan.test.ts`
  3 = **the 54/54 parallel differential suite, unchanged and green**
  (incl. degenerate-plan regressions); `calc-chain.test.ts` 54;
  `measure-cache.test.ts` 9; `hidden-taint-memo` + `engine` 71;
  `five-faces` + `host-routing` 15.
- New `packages/engine/tests/parallel-plan-cache.test.ts` (13):
  plan-cache identity on repeat calls; value edit does NOT invalidate;
  formula edit and tracked-set membership DO; per-workerCount entries;
  early-exit proof on a ledger-shaped workbook (stages > 64, bound < 4,
  full statistics intact) + full plan without earlyExit; verdict cached
  across recalcs; **deep+wide differential** — 8 chains × 150 deep
  (150 stages, avg width exactly 4) is NOT diverted by the pre-gate,
  goes parallel, and staged values equal serial values for all 1,200
  formula cells; bulk readback equals per-cell
  getSerialized/getValue for every tracked cell (incl. a defined-name
  formula added post-build), reflects edits, and host bulkReadback
  equals per-cell readCell including #PERM! for a hidden cell and a
  formula touching it transitively.
- Gateway: `engineSvc` 30/30 (29 + 1 new: mirror matches per-cell
  /read values cell-for-cell across two sheets), `engineSvcStream` 7,
  `gateway` + `parallelParse` — 52/52 across the four related files
  (run before the one test addition; engineSvc re-run 30/30 after).
- `tsc` clean: engine, gateway. Dists rebuilt (engine, gateway);
  engine service restarted only (pid 45990,
  `node --max-old-space-size=6144 dist/bin/engine.js`, health OK);
  gateway and web untouched. No changes to apps/web or apps/desktop.

## Files changed

- `packages/engine/src/workbook.ts` — `getGraphVersion()`;
  membership-aware graph-version bump in `trackCellInput`;
  `scanFormulaNames` split from `findUnreadableName`;
  `getBulkReadback`.
- `packages/engine/src/protocol.ts` — `EngineHost.bulkReadback`.
- `packages/engine/src/parallel/partition.ts` — two-phase planner,
  numeric keys, named-boundary extras, plan cache, early degenerate
  exit (`maxPossibleAvgWidth` bound).
- `packages/engine/src/parallel/types.ts` — `PartitionPlan.degenerateEarlyExit`.
- `packages/engine/src/parallel/parallel-recalc.ts` — passes guard
  constants as early-exit params; handles `degenerateEarlyExit`.
- `packages/gateway/src/services/engineSvc.ts` — mirror via bulk
  readback (contract unchanged).
- Tests: `packages/engine/tests/parallel-plan-cache.test.ts` (new),
  `packages/gateway/tests/engineSvc.test.ts` (+1).

## Honest residuals

- B2 cold first edit on a fresh P95 load is 8.1 s at the service
  (≈3.9 s isolated planner + serial recalc + routing + contention),
  down from 20.8 s; repeat edits are 0.72 s. The remaining cold cost
  is phase A's whole-graph edge scan — bounded and one-per-graph-shape,
  but not zero; a bulk HF edge dump is the next lever.
- A direct full-plan `planPartitions` call (no earlyExit — tests and
  tooling) now recomputes precedents in phase B; its cost is
  unchanged-ish (20.7 s measured under load-avg-3 contention vs
  18.7 s at low contention — not a clean comparison). All production
  recalc paths go through the orchestrator and its early exit/cache.
- B4 service-level after absolutes could not be cleanly re-measured
  due to sibling contention (documented above); the contract
  verification (cell counts, per-cell value equality, both flag
  branches) is exact, and the controlled A/B shows the construction
  cost itself fell 1.5–2.3×.
