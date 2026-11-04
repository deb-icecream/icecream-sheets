# Phase 2 — Co-authoring build + §10 multi-client test matrix — BRIEF

Issued: 2026-10-21. User go-ahead: 2026-10-21 10:43 PDT (option tap +
scope playback confirmed in chat). Playback by first coordinator checked
section-by-section against the design doc by the parent and APPROVED
2026-10-21; build coordinator carries this brief. Authority: AGENT.md §0 —
`design-docs/revision-model-save-and-coauthoring.md` governs; authority
order doc > this brief > existing code; conflicts are flagged, never
silently resolved.

## Why this document exists

So the full tasking — scope, rulings, conditions, evidence bar — is on
disk and cannot be lost across agent restarts or context compaction.
The design doc remains the product authority; this file is the work order.

## Build scope (design doc §§7–9, §11)

1. **Session registry (§9)** — in the DATABASE (local store adapter
   locally, Firestore interface deployed). One metadata record per file:
   {fileId, sessionId, ownerInstance, ownerEndpoint, leaseExpiry,
   ownershipEpoch, currentRevision, storedRevision, updatedAt}; no cell
   data. Claims/transfers are DB transactions (compare-and-set);
   heartbeats refresh the lease; FAIL-CLOSED when the DB is unreachable.
2. **One file = one session = one engine instance.** Second opener JOINS;
   simultaneous first-opens = exactly one winner; non-owners
   refuse/redirect, never hydrate a second copy (split-brain is a
   critical defect).
3. **Join handshake** — gateway authenticates + checks permission +
   rate-limits, returns connection info ONLY (owner endpoint, sessionId,
   short-lived signed token scoped user+file+session+role, current
   revision; identical shape for join vs create) → client connects
   directly to the owner → engine validates the token itself (signature,
   sessionId, fileId) → streams current state → live deltas.
   Multi-principal sessions with roles replace today's single-principal
   403; per-op authorize() still applies.
4. **Single sequencer (§7)** — one FIFO queue on the owning instance;
   each op applied completely (input + full recalc, atomically) before
   the next; revision assigned at dequeue (the stamp IS the order). Ops
   carry clientId + clientSeq + baseRev. baseRev < current → rebase the
   INCOMING op only via CollabSession.transform(); structural ops shift
   coordinates; same-cell = last-writer-wins by sequence position (no
   author privilege). Journal history never rewritten. Undo/redo = new
   inverse ops, own ops only. A paste is one op. No cross-client
   consistent sequencing exists or is to be built.
5. **SSE delta channel (§8)** — UPDATED CELLS ONLY (edited inputs +
   recalculated dependents), strictly in revision order, to all clients
   including the originator. Clients keep CONFIRMED vs PROVISIONAL layers
   strictly separate; a delta touches the confirmed layer only, never the
   input of a pending local edit. On a revision gap: hold, fetch missing
   revisions from the journal catch-up endpoint, apply in order — never
   skip. Replaces the polled, structure-only /events channel.
6. **SSE IS ALWAYS ON (user clarification, 2026-10-21; also in doc §8)**
   — the channel serves EVERY service-connected session from open,
   including a session with exactly one user: the originator's own
   deltas, server-reported revision status (Saving…/Saved), and session
   events all flow over it. Identical for web and logged-in desktop.
   NO polling fallback for single-user sessions. Logged-out desktop has
   no server and is out of scope here (§11).
7. **Presence (§8)** — ephemeral signal through the engine service
   (principal, sheet, selection/editing cell; heartbeat + expiry) →
   avatars + colored selection flags. In-memory only: NEVER journaled,
   NEVER persisted to file, NEVER a revision.
8. **Overwrite notification: NONE** — silent, like Excel (user's decided
   ruling, 2026-10-21). Build literally nothing for it.
9. **Disconnect / resync no-loss (§§1/9)** — durable outbound queue on
   the client (persisted until per-op ack) survives reloads and
   retention pruning; full re-stream past retention replaces ONLY the
   confirmed layer; queued ops rebase onto the current revision and
   submit in the client's own order; typed inputs never lost or
   content-modified (address may shift under structural rebase; computed
   results may differ); queued ops targeting since-deleted structures
   are rejected VISIBLY with input retained locally. Discarding the
   queue on reload is a data-loss defect.
10. **Journal retention (§1)** — segments prunable ONLY when
    (a) ≤ storedRevision AND (b) every attached client has applied past
    them AND (c) a checkpoint exists at/beyond; never prune past the
    slowest attached client. A reconnecting client older than retention
    gets the full state re-stream, not journal catch-up.
11. **Takeover / fencing (§9)** — lease timestamps only gate when a
    takeover may be ATTEMPTED; authority = claim transaction +
    ownershipEpoch (incremented inside the claim transaction). A stale
    owner that sees a higher epoch (or cannot confirm its own) fences
    itself: refuses ops/deltas. On owner death: single claimant
    rehydrates (stored file + journal replay + checksum); clients
    briefly disconnect and reconnect AUTOMATICALLY by re-running the
    gateway lookup (new endpoint + fresh token), catch up from last
    applied revision, submit queued edits. Engine endpoints are leased
    information, never permanent addresses.
12. **Desktop logged-in parity (§11)** — packaged desktop, logged in
    against the local deployment, joins the SAME server session: server
    sequencer/revisions; service-driven AutoSave (desktop never
    initiates it for service files; its Save is a force-save signal;
    status from server-reported revisions); SSE updated-cells-only
    deltas in order with journal catch-up; full co-authoring; presence
    both ways; signed-URL downloads. Logged-out desktop unchanged.

## Known gaps this phase closes (verified in code)

- Engine sessions are single-principal today (second principal → 403).
- Gateway /events is polled and structure-only (no SSE delta channel).
- Web CollabBridge.onBroadcast (apps/web/src/collab.ts) is a NO-OP.
- Registry exists only as deployment-prep seams (local adapter real;
  Firestore/GCS fail-closed without credentials).

## Testing — §10 mandate (the acceptance gate)

End-to-end on the LOCAL DEPLOYMENT (full local stack, production
topology — gateway + engine service, NOT the in-process fallback) with
MULTIPLE REAL BROWSERS as distinct authenticated clients. Unit tests
alone never suffice. All 11 scenarios:

1. Join — both clients on the same sessionId/owner; registry read-back
   as evidence.
2. Convergence — after edits from both, all clients AND the server agree
   cell-for-cell.
3. Same-cell last-writer-wins — correct on BOTH screens.
4. Deltas-only — traffic capture proves only changed cells cross the
   push channel, never whole sheets. **Includes the single-user check
   (user clarification, 2026-10-21): one client alone in a session
   still receives its deltas over SSE — including server-recalculated
   dependent values from a server-routed/long-chain edit — and NO
   /events polling traffic occurs.**
5. Presence — visible both ways; proven ABSENT from the saved file AND
   from the journal.
6. Structural rebase — a row/col insert by one client shifts the other's
   concurrent edit to the correct cell.
7. Disconnect → offline queue → reconnect catch-up + convergence;
   PLUS past-retention variant (zero queued ops lost, all applied on
   top); PLUS queued op on a meanwhile-deleted sheet → visible
   rejection, input retained locally.
8. First-open race — simultaneous opens produce exactly ONE session.
9. Owner kill — single re-owner, journal-consistent state, clients
   reattach via the disconnect → gateway re-lookup → new-owner flow.
10. Registry fail-closed — DB unreachable → open refused, no copy made.
11. Server batch flush during an active session → parse-back exact;
    a no-op tick writes nothing (countable skips).

**Client matrix** — each combination reported SEPARATELY:
(a) browser + browser — full run;
(b) PACKAGED desktop (logged in vs local deployment) + browser — full run;
(c) logged-out desktop standalone — NOT re-run; reported by citing the
Phase 1 evidence explicitly (hidden_files/direct-save-pass/
desktop-packaged.json) labeled "Phase 1 evidence — not re-run in Phase 2"
(parent condition on the approved playback).

**Evidence bar:** screenshots from EACH browser, registry reads, traffic
captures, parse-back diffs, indexed (Phase 1 EVIDENCE-INDEX.md pattern).
A scenario without evidence is NOT RUN — stated plainly, never passed.

**Test order:** related unit tests → multi-browser validation → perf
gate (Phase 1 numbers in perf-evaluation.md must not regress: TTFP
P50 0.305 s / P75 0.348 s / P95 2.93 s; browser-tour saves P50 1,742 ms /
P75 2,109 ms) → consolidated suites last.

## Standing constraints

- Phase 1 must not regress: direct streaming save, pin + CoW stash,
  strict no-op rule, five-faces protection tests; baseline 4,746
  passed / 0 failed.
- One test/tour process per output directory; verify liveness before
  any re-run (Phase 1 zombie-tour lesson).
- Update progress.md and TODO.md; append a Phase 2 addendum to
  perf-evaluation.md if numbers move (never rewrite history).
- NO git push by the coordinator — the parent pushes.
- Final report: per-scenario verdicts with evidence paths, doc-vs-code
  conflicts flagged, NOT-RUN items stated plainly, explicit Phase-1
  regression check.
