# Worker A (SERVER) — Phase 2 co-authoring build report

Scope: `packages/gateway/**` only. No edits to `apps/*`, no engine-package
changes (the existing `transform`/`CollabOp` exports sufficed), no git push,
no progress/TODO/perf edits.

## Files changed

| File | Change |
|---|---|
| `src/deploy/fileRegistry.ts` | NEW. §9 ownership registry (below). |
| `src/deploy/engineAccess.ts` | Claims gain `fid` + `role` ('editor'\|'viewer'); legacy tokens (no fid/role) verify normalized to `fid:''`, `role:'editor'`. |
| `src/deploy/sessionStore.ts` | `JournalEntry` gains optional `delta` + `origin` (one write per segment preserved). |
| `src/gateway.ts` | `POST /api/engine/open` join-or-claim handshake; `GatewayOptions.fileRegistry/engineInstances/engineInstanceId/ownershipLeaseMs`; `parseEngineInstances` helper. |
| `src/services/engineSvc.ts` | `/session/claim`, participant model, single FIFO sequencer + `/ops`, delta capture/broadcast, `GET /deltas` SSE, `/deltas/ack`, `GET /revisions`, `/presence` + `/presence/leave`, §1 retention pruning, ownership heartbeat + fencing, status broadcasts. `/execute` refactored onto the same sequencer core (`runExecuteInternal`). |
| `src/index.ts` | Exports for fileRegistry, `EngineAccessRole`, and the new engineSvc helpers/types. |
| `tests/fileRegistry.test.ts` | NEW (7 tests). |
| `tests/phase2Collab.test.ts` | NEW (15 tests). |
| `dist/` | Rebuilt with `tsc`; live stack restarted from dist (gateway :8100 + engine :8101 only, signed mode, env per `hidden_files/direct-save-pass/start-stack.sh`). |

## What was implemented

1. **fileRegistry.ts (§9)** — Record exactly per contract (incl.
   `creatorPrincipal`). `LocalFileRegistry`: single JSON file under
   `FILE_REGISTRY_DIR` (default `<SESSION_DATA_DIR>/file-registry`),
   cross-process lockfile mutex (`wx` create + spin + stale-lock recovery),
   atomic tmp+rename writes, **any IO/parse error throws** (fail-closed).
   `claim(record, expectedEpoch|null)` is a true CAS: null = no record may
   exist and epoch must be 1; otherwise stored epoch must equal
   `expectedEpoch` and the new epoch must be `expectedEpoch+1` — concurrent
   first claims produce exactly one winner (tested 8-way). `heartbeat`
   refreshes lease (registry-configured `OWNERSHIP_LEASE_MS`, default 30 s)
   + revision counters, returns **false when fenced** (epoch/session
   mismatch). `release` clears the lease, keeps the epoch for the next CAS.
   `MemoryFileRegistry` for tests. `FirestoreFileRegistry` against the same
   narrow `FirestoreLike` surface as `sessionStore.ts`;
   `createFileRegistry()` in prod mode (`FILE_REGISTRY_STORE=prod` or
   `SESSION_STORE=prod`) **throws without an injected Firestore client** —
   no silent local fallback.
2. **engineAccess.ts** — `issueEngineAccessToken` accepts `fid`/`role`;
   `verifyEngineAccessToken` validates them when present and normalizes
   legacy tokens to `fid:''`/`role:'editor'`.
3. **Gateway `POST /api/engine/open`** — JWT + rate limit run first (existing
   pipeline). fileId minted `file-<uuid>` when omitted. Live owner → JOIN.
   No/expired record → CLAIM: instance picked from `ENGINE_INSTANCES`
   (instanceId→baseUrl; default = configured tier URL under
   `ENGINE_INSTANCE_ID`, default `engine-1`); gateway mints the sessionId
   (reusing an expired record's sessionId so the engine rehydrates the
   released session), issues a creator token, calls
   `POST {engine}/session/claim {fileId, sessionId}`, then CAS-claims
   (epoch = prev+1 or 1). CAS loser re-reads and JOINs. Registry throw at
   any point → **503 `{error:'session registry unavailable'}`, no session
   created**. Response shape identical join vs create:
   `{ok, fileId, sessionId, engineUrl, accessToken, role, revision, joined,
   ownershipEpoch}`; creator is always `editor`, joiner gets requested role
   (default `editor`).
4. **engineSvc.ts**
   - **`/session/claim {fileId, sessionId?}`** — live session for a
     different fileId → 409 (never hydrates a second copy); same file →
     join; released session for the file with a checkpoint snapshot →
     rehydrate via the existing snapshot+journal+checksum path
     (checksum/journal failures → 409); otherwise a blank pending session
     bound to the fileId that the owner's first `/load` fills
     (`bindLoadedSession`: token `fid` wins, else the claim's binding).
   - **Participants replace the single-principal model**: session gains
     `fileId`, `participants` (principal→role from the token),
     `appliedRev` map, SSE subscriber set, delta log, presence map.
     Reads stay permission-filtered per principal; the `/session/rehydrate`
     403 now accepts creator OR enrolled participant OR file-scoped token
     holder. Legacy tokens (`fid:''`) are refused 403 on `/ops`, `/deltas`,
     `/deltas/ack`, `/revisions`, `/presence` when the session is
     file-owned; a token naming a different file → 401 `wrong-file`.
   - **Sequencer**: one FIFO promise chain (`enqueueSequenced`) wraps ALL
     mutating executes. `runExecuteInternal` is the Phase 1 `/execute`
     body (structural barrier, routing dispatch, save-pin overflow queue,
     save journal, AutoSave accounting, parallel follow-up, journal
     buffering) returning an outcome instead of writing the response —
     `/execute` and `/ops` share it exactly. Per doc §1 ("every accepted
     edit op receives the next revision") revisions are now assigned to
     **all** successful mutating commands (Phase 1 assigned them only to
     setCell/setFormula — see Conflicts).
   - **`POST /ops`** — envelope validated; viewer → 403
     `{ok:false, rejected:true, reason:'viewer-role'}`; idempotent on
     `(clientId, clientSeq)` (stored ack returned, checked again inside
     the FIFO); `baseRev < retentionFloor` → 409 `before-retention`
     (decision, see below); `baseRev < current` → rebase via
     `cmdToCollabOp` + engine `transform()` against the delta log's
     CollabOp mappings of intervening revisions (rows/cols insert/delete,
     sheet add/delete/rename, cell.set/clear); transform null → 200
     `{ok:false, rejected:true, reason:'obsolete', revision}`, nothing
     journaled. Applied via `host.execute` with the principal stamped.
     Journal entry carries `delta` + `origin`. Response is the EditAck
     shape `{ok:true, revision, ack:{revision, changedCellCount, checksum}}`
     (checksum over the pre-edit affected set for cell edits, as Phase 1;
     over the delta cells otherwise).
   - **Delta computation** — a per-op `host.subscribe` collector gathers
     `cellsChanged` refs during the op's execute (+ parallel follow-up);
     values/formulas read back after recalc (owner view). Broadcast and
     `/revisions` serving filter **per recipient**: hidden cells — and
     cells whose authorized read is `#PERM!` (e.g. formulas over hidden
     cells, taint-checked via `readCell`) — cross as bare ref +
     `{hidden:true}` with **no value/formula keys**.
   - **`GET /deltas` SSE (always on)** — `hello {revision,
     storedRevision, fileId}`, `delta`, `status`, `presence`, `session`
     (structure/load/reset/release/fenced) events; 15 s heartbeat
     comments; subscribe records `appliedRev = hello revision`;
     `POST /deltas/ack {revision}` advances it.
   - **`GET /revisions?from&to`** — served from the delta log (delta cells
     persisted in journal entries for post-rehydrate rebuild);
     `from < availableFrom` → 409 `{error:'before-retention',
     oldestRevision}`.
   - **Presence** — `POST /presence` / `/presence/leave`, in-memory only
     (never journaled/persisted/a revision — verified in tests), 30 s TTL
     with a 5 s sweep, deterministic color using the exact
     `apps/web/src/collab.ts` palette + hash.
   - **Retention (§1, exactly)** — exported pure helpers
     `retentionPruneUpto`/`segmentPrunable`: prune only when
     `toRevision ≤ storedRevision` AND `≤ min appliedRev across attached
     clients` (live SSE sub OR ack within 5 min; vacuous when none) AND
     a checkpoint exists at ≥ toRevision. The checkpoint path now
     truncates through this rule (with no attached clients it truncates
     to the checkpoint revision exactly as Phase 1 did — Phase 1 suites
     green), plus a 30 s sweep for ack-driven unblocking.
   - **Fencing** — ownership heartbeat loop at `OWNERSHIP_HEARTBEAT_MS`
     (default lease/3) adopts the registry epoch for its session,
     heartbeats revision counters; heartbeat false / record naming
     another owner/session / epoch change / registry unreachable once an
     epoch is held → `fenceSession`: `/ops`, `/execute`, `/deltas`,
     `/load`, `/load/stream` refuse 409 `{error:'fenced'}`, SSE
     subscribers get `session{fenced}` and are closed. On release the
     engine clears its registry lease.
   - **Status events** broadcast on every revision change and every
     flush commit/skip (checkpoint success, no-op tick, no-op force
     flush), carrying `{revision, storedRevision, saving}`.
   - **Phase 1 intact** — direct streaming save, pin+stash, batch
     autosave + strict no-op, `/session/release`, idle eviction,
     signed-mode enforcement, five-faces filtering all unchanged in
     behavior; `/health` kept byte-identical (see Conflicts).

## Tests

New: `tests/fileRegistry.test.ts` (7) + `tests/phase2Collab.test.ts` (15) =
**22 new tests, all passing**: CAS race exactly-one-winner, epoch
increments, heartbeat fencing, release semantics, cross-instance local
adapter, corrupt-file fail-closed, prod fail-closed; claim 409/pending/
rehydrate-after-release; two-principal sequencing + EditAck shape;
idempotent retry; legacy `/execute` broadcast; structural rebase shift
(row insert shifts a stale edit 1→2, verified by read-back); obsolete
rejection (deleted sheet, nothing journaled); SSE hello/delta shape;
hidden-cell delta = `{hidden:true}` with no value/formula (and
`/revisions` likewise); presence broadcast + color + **not journaled** +
no revision; retention integration (slow attached client blocks pruning
at a checkpoint, ack unblocks, `from=0` → 409 before-retention);
retention rule pure tests (each condition independently); FIFO
concurrency (5 clients → gapless revisions 1–5); fencing integration
(epoch-2 takeover → `/ops` + `/deltas` 409); legacy-token 403s; gateway
handshake (join = same sessionId, registry record evidence, viewer 403,
registry-down 503 with no session created).

Full gateway package suite: **206 passed / 0 failed (21 files)** —
includes the Phase 1 suites re-run against the refactor: `directSave`,
`engineSvc` (incl. five-faces), `deployAccess`, `gateway`,
`engineSvcStream`, `engineSvcReadDuringBuild`. No engine-package tests
were touched (no engine changes).

## Live curl evidence

Full transcript: `build/worker-a-curl-evidence.txt` (tokens redacted;
they were 600 s local-dev tokens, expired). Against the rebuilt dist
(gateway :8100 + engine :8101, signed mode):

- Logins alice/bob/carol → alice `POST /api/engine/open {name}` → 200,
  `joined:false`, `role:'editor'`, `ownershipEpoch:1`, minted `fileId`.
- Alice `/load` with the returned access token → 200, session bound.
- Bob `POST /api/engine/open {fileId}` → 200, **same sessionId**,
  `joined:true`. Carol with `role:'viewer'` → viewer token, same session.
- Alice `/ops` setCell A1=42 → `{ok:true, revision:1, ack:{…,
  changedCellCount:2}}`; bob `/ops` B1=43 → revision 2; bob's retry
  (same clientSeq) → identical ack, revision still 2.
- Bob's SSE `/deltas` capture: `hello {revision:2, storedRevision:0,
  fileId}` → `status` → `presence` → `delta {revision:3,
  origin:{clientId:'alice-c', clientSeq:2, principal:'user:alice'},
  cells:[{sheet:'Sheet1', row:1, col:0, value:{kind:'number',
  value:7}}]}` → `status`.
- Carol (viewer) `/ops` → **403 `{ok:false, rejected:true,
  reason:'viewer-role'}`**.
- `GET /revisions?from=2&to=3` → revision 3 with origin; `from=0` → 409
  `before-retention` (an autosave checkpoint had pruned ≤ bob's applied
  revision 2 per §1 — expected behavior, asserted in the script).
- `POST /presence` → 200; `/session/status` shows revision 3, the
  fileId, and all three participants with roles.
- On-disk registry record for the file: sessionId, ownerInstance
  `engine-1`, epoch 1, creatorPrincipal `user:alice` (heartbeat carries
  currentRevision on its 10 s cadence).

## Decisions (within contract latitude)

- **`/ops` with `baseRev < retentionFloor` → 409
  `{rejected:true, reason:'before-retention', oldestRevision}`.** The
  contract specifies this shape only for `/revisions`; for ops it is
  the §1-honest outcome (rebase is impossible without the intervening
  ops; the client re-streams and replays its queue). Flagging for the
  coordinator/web worker: the client transport must treat this like
  the `/revisions` 409.
- **Gateway claim order** follows the contract literally (engine claim
  first, then registry CAS). A CAS loser may have created a pending
  session on its chosen engine; that pending session is blank (no
  `/load` ever fills it) and the loser joins the winner — no second
  live copy ever holds data.
- **Firestore registry CAS** is read-check-write + re-read verification
  over the narrow `FirestoreLike` surface (the same structural posture
  as `sessionStore.ts`); a true Firestore `runTransaction` is not
  expressible in that interface. Local adapter (the §10 topology) is a
  real cross-process mutex CAS.
- **Delta `value`** is the engine `TypedValue` object (same shape
  `/read` returns), not a flattened scalar — matches the existing
  EditAck/read contracts on the wire.

## Conflicts / doc-vs-code issues flagged (not silently resolved)

1. **Revision assignment widened (doc §1 vs Phase 1 code).** Phase 1
   assigned revisions only to setCell/setFormula ops; §1 assigns one to
   EVERY accepted edit op. I followed the doc: structural/name ops via
   `/execute` and `/ops` now also consume revisions and journal entries
   (replay handles them — deployAccess/directSave suites green). This
   changes revision numbering for sessions that mix structural ops via
   legacy `/execute`.
2. **`ENGINE_INSTANCE_ID` in `/health`.** The contract asked the engine
   to report its instanceId in `/health` "if not present already".
   Phase 1's `engineSvc.test.ts` pins `/health` to the exact body
   `{ok:true, service:'engine'}` (`toEqual`), and Phase 1 must not
   regress — so `/health` is unchanged and instanceId is reported on
   `/session/status` and `/session/claim` instead.
3. **Checkpoint journal truncation vs §1 retention.** Phase 1's
   checkpoint truncated the whole journal to the snapshot revision
   unconditionally. §1 allows pruning only past the slowest attached
   client. I routed the checkpoint truncate through the §1 rule: with
   no attached clients behavior is byte-identical to Phase 1 (its
   release/rehydrate tests pass), but a checkpoint with a lagging
   attached client now retains segments — rehydrate still works because
   replay reads only past the snapshot revision.
4. **`/session/rehydrate` principal check.** The brief says replace
   "the single-principal 403" — the only such check in the code was in
   `/session/rehydrate`; it now admits creator/participant/file-scoped
   token holders. `flushSessionSave`'s session-principal check was
   deliberately kept: it guards whose library entry a force save
   commits to (single-author stored copy), not session membership.

## NOT done / not run (stated plainly)

- **§10 multi-browser matrix**: not mine (coordinator) and not run.
  Server-side evidence here is unit/integration + live curl only.
- **Owner-kill re-ownership end-to-end** (kill engine → new instance
  claims → rehydrate): the pieces are tested separately (claim
  rehydrate-after-release; fencing on takeover; gateway CAS-loser
  join), but a two-engine-process kill test was not run.
- **Firestore registry against a real Firestore**: structural adapter
  only, unit posture mirrors sessionStore; no live Firestore available.
- The web/desktop workers' surfaces (`collabTransport`, CollabBridge
  wiring) are untouched, per my file ownership.
- Stack state on exit: gateway :8100 + engine :8101 left RUNNING from
  the rebuilt dist (signed mode); the other start-stack services were
  down when I arrived and I did not start them (per instructions to
  restart only gateway+engine).
