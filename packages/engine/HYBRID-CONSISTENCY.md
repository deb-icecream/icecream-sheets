# Hybrid Recalc Consistency Protocol

**Status:** Cycle 10 Phase 3 deliverable — implemented FROM by the async-transport
integration worker. The engine-side primitives this protocol uses live in
`packages/engine/src/calc-chain.ts` (measurement, threshold config, the pure
routing policy) and `EngineWorkbook` (`measureCalcChain`, `routeEditRecalc`,
`hybridRecalcConfig`, `totalCellCount`). Transport is NOT specified here (the
Phase 2 worker owns it); this document specifies the consistency rules any
transport MUST honor. Scope note: this protocol applies to edits made after a
workbook is 100% loaded — edit, save, autosave, and export stay gated until
full load, so routing never runs against partial state.

## 0. The ruling this protocol implements

Editing is HYBRID, governed by the structural routing rule:

**The size flag decides the local mirror.** Workbooks BELOW the cell-count
flag (total cell count ≤ `mtCellCountThreshold`, default 5000) keep a FULL
local engine mirror — local calc paths are always available. Workbooks
ABOVE the flag are server-calc only for everything except rendering,
because the browser holds no mirror.

Below the flag (mirror exists), per edit, from the dependency graph:

1. **Tiny set** — total affected cells ≤ the tiny-set threshold (default
   50) → **local single-thread, regardless of chain count**. Checked
   FIRST, before the shape test.
2. **Single chain** (one dependent sequence) → short (chain length ≤ the
   length threshold, default 200) → **local, single thread**; long →
   **server, single thread** (a lone chain cannot parallelize internally).
3. **Multiple chains** → **server, ALWAYS. No length test.** On the server,
   the multithreading auto-flag decides: ON → independent chains in
   parallel, Excel-style; dependent chains serialize. OFF → single thread.

Above the flag (no mirror): **ALL edits go to the server**; the browser
renders only.

When an edit routes to the server, the typed cell shows the user's input
IMMEDIATELY (optimistic display, §7); downstream results fill in when the
server replies. The **server is the source of truth** for workbook state.
A client engine ("mirror") is a disposable acceleration cache, never a
second truth. Local recalc is ALWAYS single-threaded. The tiny-set
threshold, the length threshold, and the cell-count flag stay
configurable; all are tuned from Phase 4 (gateway-mode perf) measurements.

## 1. Roles and state

- **Server workbook state**: the authoritative cell inputs (formula/value per
  cell), computed values, and a monotonically increasing **revision `rev`**
  (one integer per accepted edit op, per workbook). Only the server assigns
  `rev`.
- **Client mirror**: a full client-side `EngineWorkbook` whose state is
  claimed equal to the server's at some `baseRev`. The mirror additionally
  holds **pending ops** (sent, unacked) and the values they produced
  locally, all marked **provisional** until acked.
- **Op**: one user edit. Every op carries a client-generated `opId`
  (idempotency key), the target cell/range, the new input, the routing
  decision (`route`, `reason`) taken for it, and the mirror's `baseRev` at
  send time.
- **Ack**: the server's response for an op: `{ opId, rev, values? }` where
  `values` (authoritative values for the affected chain cells) is REQUIRED
  for server-routed recalcs and for any op the server applied differently
  than the client's provisional result (see §3).

## 2. Write path: write-through of the op, routed recalc

The **op itself is always written through to the server** — routing decides
only where the dependent recalculation is performed first. There is no mode
in which the server never sees an edit (except offline, §6, which is a queue,
not a mode).

1. User edits a cell. The client applies the new INPUT to the mirror
   immediately (the edited cell shows its input at once — this is
   optimistic display, §7: provisional, never authoritative).
2. The client calls `routeEditRecalc(ref)` (measurement capped at
   `lengthThreshold + 1`, so this is O(threshold), never O(graph)).
   The routing input is:
   `affectedCellCount` (for the tiny-set hatch) → `shape` →
   `chainLength` (single chains only), with `thresholds` from the
   normalized config and `mirrorMode` from the workbook's size flag
   (`mirrorMode()`: cell count vs `mtCellCountThreshold`).
3. **Route `local`** (tiny set, or short single chain): the mirror recalcs
   the affected set single-threaded and shows the results as
   **provisional**. The op is sent to the server. The server applies the
   op, assigns `rev`, recalcs authoritatively (cheap for these sizes), and
   acks with `values` for the affected cells. The client compares ack
   values against its provisional values:
   - Equal → provisional values become **confirmed**; `baseRev = rev`.
   - Different → **server wins** (§3): the client overwrites the mirror's
     values with the ack values, logs a divergence event (opId, rev, cells)
     and NEVER shows the local values as confirmed. A divergence is a bug
     signal (engines are identical), not a normal path.
4. **Route `server`** (long single chain, multiple chains, or no mirror):
   the client does NOT recalc dependents locally. The edited cell shows
   its **typed input optimistically** (§7); dependent cells keep their
   last-confirmed values visually marked **stale/calculating** (never
   silently stale — the UI must be able to tell). The op is sent; the
   server applies it, assigns `rev`, recalcs (single-threaded for a long
   single chain; possibly multithreaded for multiple chains when the MT
   auto-flag is on), and acks with `values` for the affected cells. The
   client applies exactly those values to the mirror, in `rev` order, and
   marks them confirmed. `baseRev = rev`.

Formulas the mirror and server compute identically make step 3's comparison
a cheap safety net, not a merge: there is NO value-level merging anywhere
in this protocol. One side computed, the other side verified or replaced.

### Checksum ack (Cycle 10 closure amendment — comparison encoding only)

Step 3's comparison MAY be carried as a checksum instead of as values.
The server ack for a routed edit then carries
`{ revision, changedCellCount, checksum }`, where the checksum is a
deterministic hash (engine `ack-checksum.ts`: FNV-1a 64 over a
kind-tagged serialization) of the affected cells' post-edit values —
the affected set being [edited ref + `measureCalcChain` cells] measured
on the pre-edit graph, sorted by (sheet, row, col), derived identically
by both sides. The client computes the same checksum over its
provisional values: **match → confirmed, no value fetch**; **mismatch
→ the full value fetch of step 3 runs and the server wins, exactly as
before**. This changes only the comparison's ENCODING, never the
guarantee: any real divergence is still detected and resolved
server-wins, and §8's invariants are untouched. Acks without a checksum
(older servers) use the original value comparison. Server-routed edits
(§2 step 4) still confirm from ack VALUES — the client computed no
local dependents to checksum against.

## 3. Conflict rules — who wins

- **Server wins, always, on any conflict.** There are no exceptions and no
  silent merges (platform-shell.md §7: "Conflicts surface to the user and
  are never silently merged").
- Same-cell concurrent edits from two clients: the server serializes ops
  by `rev`; the later `rev` wins; the losing client's mirror is corrected
  by the broadcast for that `rev` (§4) and the user is notified their cell
  was overwritten.
- Provisional vs confirmed: provisional (local, unacked) values lose to
  ANY confirmed value, including an older-`rev` broadcast arriving late.
- Local-only contexts (desktop offline by design) have no server; this
  protocol does not apply there. The moment a desktop client logs in and
  opens a server-hosted workbook, this protocol applies in full.

## 4. Ordering guarantees

- One ordered op stream per workbook. The server applies ops strictly in
  arrival order and assigns consecutive `rev`s.
- Broadcasts (ops from other clients, acks) are applied by each client
  **strictly in `rev` order**. A gap (received `rev` > `baseRev + 1` with
  no pending op accounting for it) HALTS application: the client marks
  itself out of sync (`mirrorInSync = false`, which routes everything to
  the server per §5) and requests a **resync**: a full snapshot at a known
  `rev` (or a value-delta from `baseRev`), after which `baseRev` is reset
  and local routing re-enables.
- A client NEVER applies its own next op's local recalc on top of
  unconfirmed state from a previous op when that op could change the same
  chain: while an op is in flight, `routeRecalc` receives
  `editInFlight: true` and routes to the server (fail-safe #5). The host
  MAY pipeline independent-cell edits it can prove disjoint (disjoint
  affected sets via `measureCalcChain` with no cap); if in doubt, it must
  not pipeline.
- `rev` never goes backwards. Any message with `rev` ≤ `baseRev` that is
  not an ack for a pending op is ignored (duplicate/late delivery).

## 5. Fail-safe-to-server cases

The routing policy (`routeRecalc` in calc-chain.ts) returns `server` for
each of these; hosts MUST pass the context flags honestly — a host that
cannot evaluate a flag MUST pass the fail-safe value (e.g. unknown sync
state = `mirrorInSync: false`). Order matters (first match wins); the
tiny-set hatch comes after the hard fail-safes but before the shape test.

| # | Case | Reason code |
|---|------|-------------|
| 1 | Structural edit (insert/delete rows/cols, sheet ops, defined-name changes) | `structural-edit` |
| 2 | No local mirror — workbook above the size flag (or mirror mode unknown, fails safe here) | `no-mirror` |
| 3 | No local engine mirror at all (gateway mode before Phase 3 integration) | `no-local-engine` |
| 4 | Mirror out of sync / resync pending | `mirror-out-of-sync` |
| 5 | Another edit in flight | `edit-in-flight` |
| 6 | Affected set contains volatile fns / external refs / provider-backed fns (checked even for tiny sets) | `unreproducible-dependents` |
| 7 | Multiple chains (no length test; `serverThreading` per the MT flag) | `multiple-chains` |
| 8 | Threshold config invalid | `threshold-invalid` |
| 9 | Shape unknown (measurement failed) | `shape-unknown` |
| 10 | Single-chain length unknown | `chain-unknown` |
| 11 | Measurement inexact (truncated lower bound) | `chain-inexact-lower-bound` |
| 12 | Long single chain, offline (recalc deferred to server) | `offline-deferred-long` |
| 13 | Long single chain (server, single-threaded) | `chain-long` |

The LOCAL routes are: `tiny-set-local` (≤ tiny threshold, any shape),
`chain-short` (short single chain), and `offline-provisional-short`
(offline, provisional). Local is always single-threaded; `serverThreading`
is never set for local routes.

Detecting case 6: the host inspects the affected set from
`measureCalcChain` (full, uncapped) — chain cells whose formulas reference
volatile functions, `[N]` external-workbook refs, or connector/provider
functions. When the host cannot perform this inspection, it must either
inspect conservatively (any formula it cannot classify counts as
unreproducible) or accept that case 6 cannot fire and divergence risk is
carried by the §2 step-3 value comparison (server still wins; the cost is a
correct-after-ack flicker, never silent divergence — the comparison is the
backstop that keeps even a misrouted volatile edit from diverging SILENTLY).

## 6. Disconnect mid-edit

Op states on the client: `queued` (created offline / before send),
`sent` (awaiting ack), `acked`. On disconnect:

1. `sent` ops stay `sent`; their provisional values stay provisional and
   are visually distinguishable (or reverted to last-confirmed + stale mark
   — host's choice, but never shown as confirmed).
2. New edits while offline follow §5/`routeRecalc` with `online: false`:
   tiny sets and short single chains recalc locally PROVISIONAL
   (`tiny-set-local` / `offline-provisional-short`, both flagged
   provisional), long single chains are accepted as queued INPUT only
   (dependents marked stale, recalc deferred), and multiple chains queue
   for the server. All offline edits become `queued` ops in order.
3. **On reconnect**, before any new routing: the client sends
   `{ lastAckedRev, pendingOpIds }`. The server replies with its current
   `rev` and which pending opIds it has applied (dedupe by `opId` — ops
   are idempotent; an op the server already applied is acked, not
   re-applied).
4. Missing ops are (re)sent in original order. The server applies them,
   assigning fresh `rev`s, and acks each with authoritative values.
5. Any provisional value whose op was NOT applied by the server (rejected,
   or superseded by another client's intervening `rev` on the same cell)
   is discarded and replaced by server state — server wins, user notified
   when their own input was superseded.
6. Only after all pending ops are acked and `baseRev` equals the server's
   `rev` may `mirrorInSync` become true again and local routing resume.
   If the mirror cannot be brought to the server `rev` by deltas, full
   snapshot resync (§4) is mandatory.

## 7. Optimistic display for server-routed edits

When an edit routes to the server, the typed cell shows the user's input
IMMEDIATELY — before any recalc runs anywhere. This display is
PROVISIONAL: it is the raw input (or its typed interpretation), it carries
no `rev`, it is never authoritative.

Rules the host MUST follow:

1. **Display vs authority are separate.** The provisional input display
   answers "what did the user type"; the server's reply answers "what is
   true". The input display must be visually marked pending (spinner,
   dimmed, badge — host's UX choice) so a user can never mistake it for a
   confirmed value.
2. **Downstream fills in on reply.** Dependent cells keep their
   last-confirmed values marked stale/calculating until the server's ack
   delivers the authoritative values for the affected set; they are
   applied in `rev` order per §4.
3. **Reconciliation on reply.** The ack carries authoritative values for
   the affected set, including the edited cell itself:
   - The ack's value for the edited cell matches the typed input's meaning
     (e.g. the same number, a normalized formula) → the provisional
     display is confirmed and bound to the ack's `rev`.
   - The ack's value for the edited cell differs (server normalized,
     permission rewrote, or a concurrent edit won) → **the ack wins** (§3);
     the provisional display is replaced and the user is notified when
     their input was not applied as typed.
   - The op is REJECTED (permission denied, invalid, conflict) → the
     provisional input display is rolled back to the last confirmed value
     and the user is notified. The rollback is visible, never silent.
4. **Provisional state is never persisted.** Save, autosave, export, share,
   and MCP reads against a server-hosted workbook read SERVER state at a
   confirmed `rev` — never provisional display values (invariant 1 of §8).
5. **Disconnect before the reply** → §6: the op stays `sent`/`queued`;
   the provisional display either stays (marked pending) or reverts to
   last-confirmed + queued badge — host's choice — but is NEVER shown as
   confirmed. On reconnect the handshake replays or discards it per §6.

Structural edits (`structural-edit`) carry no single typed input, so they
get no optimistic display: affected UI regions show stale/calculating
until the server's reply arrives.

## 8. Invariants (no silent divergence)

1. The server's state at `rev` is the ONLY confirmed state. Saves, exports,
   shares, and MCP reads against a server-hosted workbook read SERVER
   state, never mirror-provisional state.
2. Every confirmed client value traces to a server ack or broadcast at a
   specific `rev`. If a value cannot be traced, it is provisional.
3. The mirror is disposable: deleting it and re-syncing from the server at
   any `rev` loses nothing confirmed.
4. Engine/protocol version skew between mirror and server
   (`ENGINE_PROTOCOL_VERSION` mismatch) disables local routing entirely
   (`localEngineAvailable: false`) until resolved.
5. Divergence events (provisional ≠ ack values) are logged with opId/rev/
   cells. They indicate an engine bug or a misrouted unreproducible chain;
   the protocol's correctness must never DEPEND on them not happening —
   the server-wins rule covers them.
6. Measurement is advisory, never authoritative: even if a chain was
   mismeasured short, §2's ack comparison catches wrong values, and §4's
   ordering + §6's resync bound the damage to one op's provisional window.

## 9. What the integration worker implements (checklist)

- [ ] Client mirror lifecycle: create on gateway-mode open (from server
      snapshot at `rev`), `baseRev` tracking, snapshot resync.
- [ ] Op pipeline: opId generation, write-through send, ack handling,
      provisional/confirmed value states in the UI (incl. stale marking
      for server-routed dependents).
- [ ] Routing call site: `routeEditRecalc(ref, context)` per edit with
      honest context flags (§5), incl. structural-edit detection and the
      case-6 chain inspection.
- [ ] Broadcast application in `rev` order + gap → resync (§4).
- [ ] Reconnect handshake + op replay (§6).
- [ ] Server side: op application with `rev` assignment, opId dedupe,
      ack values for the affected chain, broadcast to other clients,
      snapshot-at-rev for resync.
