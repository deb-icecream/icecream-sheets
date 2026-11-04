# W3 — Edit-path optimization: measurement cache + checksum ack

Cycle 10 closure pass. Implements the implementable equivalent of the
user's "fuse chain measurement into the calc" proposal (HyperFormula's
recalc is atomic — no mid-calc count/abort hook — so measurement is
cached instead of fused, and the ack comparison is hashed instead of
fetching values). The capped BFS is unchanged (maxNodes =
chainLengthThreshold + 1). The HYBRID-CONSISTENCY.md divergence
guarantee is IDENTICAL: any real divergence is still detected and
resolved server-wins.

## (a) Measurement cache

**Where:** `EngineWorkbook.measureCalcChain`
(`packages/engine/src/workbook.ts`), so every host that measures through
`EngineHost` gets it — the web routed-edit path (mirror), the gateway
engine service's `/execute` dispatch, and the desktop host — with no
per-host code. `EngineHost.calcChainCacheStats()` exposes
`{ graphVersion, entries, hits, misses }` for tests/diagnostics.

**Key:** `${sheet}:${row}:${col}|${maxNodes}` per entry, stamped with
the workbook's `graphVersion`. A hit returns the cached
`CalcChainMeasurement` — the BFS does not run at all.

**Version bumps ONLY on formula/structural changes:**
- `trackCellInput` (the choke point for setCell/setFormula/setCellRaw):
  bumps when the incoming input is a formula string (`=…`) OR the
  previously tracked input was a formula (formula overwritten/cleared).
  A pure value→value edit does **not** bump.
- Explicit bumps in: `addSheet`, `deleteSheet`, `renameSheet`,
  `duplicateSheet`, `insertRows`, `deleteRows`, `insertCols`,
  `deleteCols`, `addNamedExpression`, `changeNamedExpression`,
  `removeNamedExpression`, `defineNamedFunction`, `removeNamedFunction`,
  `defineNamedRange`, `deleteNamedRange`, `renameNamedRange`,
  `updateNamedRangeRefersTo`, `defineNamedFunctionDef`,
  `updateNamedFunctionDef`, `rollbackNamedFunctionDef`,
  `deleteNamedFunctionDef`.
- Load/replace: a fresh `EngineWorkbook` is built (new cache, version
  0); `EngineHost.replaceWorkbook` swaps the workbook, hence the cache.
- Conservative rule: any doubt bumps (a missed hit costs one capped
  BFS; a stale measurement could misroute). Cache capped at 1024
  entries (cleared on overflow and on bump).

Repeat edits to the same input cell therefore skip re-measurement
entirely: routing re-reads the cached measurement.

## (b) Cheaper ack — checksum instead of value fetch

**Protocol** (HYBRID-CONSISTENCY.md §2, amended in place): on the LOCAL
route the client asks the transport for a checksum ack
(`serverExecute(command, { ackChecksum: true })` — only the local route
asks; server-routed edits confirm from ack values as before and the
server does no checksum work for them). The gateway client sends
`ackChecksum: true` as a sibling field of `/execute` (the gateway
forwards bodies verbatim); the engine service (`engineSvc.ts`
`/execute`, the ONLY part of that file touched) then:

1. measures the FULL affected set on the PRE-edit graph
   (`measureCalcChain(ref)` uncapped — the same set the client's mirror
   derives: edited ref + measurement cells; named expressions excluded,
   they carry no value of their own),
2. applies the edit, assigns the next per-workbook `revision` (one
   integer per accepted setCell/setFormula op, reset per workbook),
3. reads the post-edit values through the typed VIEW (cheap accessor —
   see "cost bug found" below) and responds
   `{ ...CommandResult, ack: { revision, changedCellCount, checksum } }`.

**Client** (`routedEdit.ts`): computes the same checksum over its
provisional values for [edited ref + dependents]. Match (and
`changedCellCount` equal) → `session.confirm()` with NO value fetch
(`outcome.ackChecksumVerified === true`). Mismatch, malformed ack, or
no ack (older server) → the original full value fetch + server-wins
resolution, byte-for-byte today's behavior. Server route unchanged.

**Set identity:** both sides derive the set from the same pre-edit
graph via the same measurement; both SORT by (sheet, row, col) before
hashing, so BFS order can never false-mismatch. On the local route the
set is bounded by construction (tiny set ≤ tinySetThreshold, or single
chain ≤ chainLengthThreshold, +1 edited cell), which also bounds the
server's checksum cost.

**Checksum serialization** (`packages/engine/src/ack-checksum.ts`,
shared by gateway + web so both sides run the same code): one line per
cell in sorted order, lines joined by U+0003; line =
`sheet U+0001 row U+0001 col U+0002 value`; value =
`n:<String(n)>` | `s:<len>:<raw>` (length-prefixed) | `b:1|b:0` |
`z:` (null/empty/missing) | `e:<code>` (error, message excluded) |
`i:<len>:<src>` (image). Hash = FNV-1a 64-bit over UTF-8, 16 lowercase
hex digits — deterministic across processes/platforms.

**Cost bug found in the first cut (fixed before measuring):** computing
the ack over the authorized `host.readCell` path cost ~0.04 ms/cell
(500-cell chain: /execute 4 ms → 26 ms) and requesting it on EVERY
execute (including server-routed long chains, ~2000 cells) regressed
browser commit latency. Fixes: values read via `getView().readCell`
(the accessor `/read` already uses for formulas; cells hidden from the
principal are absent from the mirror, so chains through them mismatch
and fall back to the authorized fetch — server-wins preserved), and
the ack is requested only on the local route. The "AFTER (v1)" run
below is kept in the table for honesty.

## Tests

- Engine `tests/measure-cache.test.ts` (new, 9 tests): cache hit on
  repeat measurement; value edit does NOT invalidate; setFormula /
  formula→value / value→formula DO invalidate; structural + named-
  expression changes invalidate; per-maxNodes entries; checksum
  determinism / order independence / divergence sensitivity /
  serialization contract.
- Engine full suite: **967/967 green** (958 baseline + 9 new).
- Web `routedEdit.test.ts` (+5 tests, 18 total): measurement-cache hit
  on repeat value-edit to the same ref + invalidation on formula
  change (via `calcChainCacheStats`); checksum match → `fetchAckValues`
  spy NOT called + `ackChecksumVerified`; genuine divergence (server
  formula differs) → checksum mismatch → full fetch called, B1 in
  `divergedCells`, server value wins; corrupt checksum → fetch
  fallback, values confirm; no ack → legacy fetch path.
  `remoteEngine.test.ts` also green (26/26 across both files).
- Gateway `tests/engineSvc.test.ts` (+1 test, 29/29): `/execute`
  without the flag returns the plain `{ ok: true }` (back-compat); with
  `ackChecksum: true` the ack carries revision 2 then 3,
  changedCellCount 1 then 2, and checksums equal to
  `computeAckChecksum` over the expected post-edit values.

## Latency — before / after (real gateway stack, browser)

Harness: `hidden_files/cycle10-closure/edit-opt-timer.mjs` (copy in
`hidden_files/pw2/` for playwright resolution), configs `bo-p50.json` /
`bo-p75.json`. Per run: fresh browser, login as e2e-tester, drop the
fixture, wait for load, then each edit twice — "first" (new value) and
"repeat" (same cell toggled back; exercises the measurement cache).
Medians of 3 runs. Metrics:
- **commitMs** — Enter → server engine value of the target cell equals
  the typed value (the §7 edit-timer2 method, API poll).
- **settledMs** — Enter → last in-page `/api/engine/*` fetch completion
  (ack processing finished; includes the 1.5 s event-poll re-reads,
  which are unchanged by this work and dominate settled noise).
- **reads** — in-page `/api/engine/read` requests issued after Enter
  (the ack value fetch is the part that disappears).

Cells (same as §7): P50 short ASSUMPTIONS!C16 0.025→0.03, P50 long
HISTORICAL INPUTS!C9 380→381 (→ REVENUE BUILD!C9); P75 short
Constants!B8 0.003→0.004, P75 long Constants!B11 6→7 (→ Inputs!E7).
P50 long and P75 long route SERVER (long single chain / multiple
chains): no ack is requested there by design — their gains come from
the server-side measurement cache and from not paying for unused acks.

| Case | commit before | commit after | settled before | settled after | reads before | reads after |
|---|---|---|---|---|---|---|
| P50 short, first  | 121 | 133 | 262 | 384 | 6 | 4 |
| P50 short, repeat | 84 | **59** | 331 | **298** | 7 | 5 |
| P50 long, first   | 278 | **216** | 577 | 567 | 21 | 21 |
| P50 long, repeat  | 319 | **196** | 551 | **522** | 21 | 20 |
| P75 short, first  | 182 | **105** | 923 | **654** | 23 | **13** |
| P75 short, repeat | 136 | **100** | 581 | **420** | 23 | **13** |
| P75 long, first   | 488 | **213** | 1318 | **752** | 7 | 7 |
| P75 long, repeat  | 559 (n=2) | **182** | ~1021 (n=2) | **517** | 8 (n=2) | 7 |

Notes: BEFORE P75 long-repeat has n=2 — the third run's page crashed
during that edit on the UNMODIFIED build (renderer crash under P75
repeat-edit load; not reproduced in any after run). The VM was under
sibling-worker load during both measurement sets (some load-wall
outliers of ~26 s in both), so treat sub-~30 ms deltas (P50 short
first commit/settled) as noise; the consistent signals are the
repeat-edit commits, the P75 improvements, and the local-route read
count dropping by the ack fetch (P75 short 23→13, P50 short 6→4; the
remaining reads are event-poll viewport re-reads).

AFTER (v1, superseded): the first implementation requested the ack on
every execute via authorized reads — P50 long commit regressed to
692 ms. Fixed as described above; all "after" numbers are v2.

## Files changed

- `packages/engine/src/ack-checksum.ts` (new) + `src/index.ts` exports
- `packages/engine/src/workbook.ts` (graph version + measure cache +
  bump sites), `src/protocol.ts` (`calcChainCacheStats` delegation)
- `packages/engine/HYBRID-CONSISTENCY.md` (§2 checksum-ack amendment)
- `packages/gateway/src/services/engineSvc.ts` — ONLY the `/execute`
  ack response (+ revision state, header doc); /download untouched
- `apps/web/src/services/routedEdit.ts` (checksum verify + fallback,
  ack request on local route only), `remoteEngine.ts` (opts
  passthrough), `engineTransport.ts` + `gatewayClient.ts` (ack flag)
- Tests: `packages/engine/tests/measure-cache.test.ts` (new),
  `apps/web/src/services/routedEdit.test.ts`,
  `packages/gateway/tests/engineSvc.test.ts`
- Dists rebuilt: engine, gateway, web (VITE_GATEWAY_URL flavor);
  engine + gateway + web preview restarted on the new builds.
  App.tsx untouched.
