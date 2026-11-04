# Phase 2 — shared API contract (coordinator-fixed; doc governs on any conflict)

Authority: design-docs/revision-model-save-and-coauthoring.md §§1,5–11.
Tasking of record: hidden_files/phase2-coauthoring/BRIEF.md.

## Token claims (deploy/engineAccess.ts)
EngineAccessClaims gains: `fid` (fileId, string, may be '' for legacy
session-scoped tokens) and `role` ('editor' | 'viewer'). issue/verify keep
v=1 shape validation; old tokens without fid/role verify as fid='' +
role='editor' ONLY for the pre-Phase-2 session-scoped routes (load etc.),
never for /ops or /deltas on a file-owned session.

## Gateway join handshake (§9)
POST /api/engine/open  (JWT auth + per-principal rate limit already applied)
  body: { fileId?: string, name?: string, role?: 'editor'|'viewer',
          cellCount?: number }
  - fileId omitted → gateway mints a new fileId (prefix 'file-').
  - Registry lookup by fileId:
    * live owner (lease unexpired, epoch current) → JOIN.
    * no record / expired lease → CLAIM path: gateway picks an engine
      instance (ENGINE_INSTANCES map instanceId→baseUrl; default the
      single configured tier URL), asks it to create-or-rehydrate the
      session for this fileId (POST {engine}/session/claim {fileId,
      sessionId?}), then CAS-claims the registry record (epoch =
      previous+1, or 1). Loser of a CAS race re-reads and JOINs.
    * registry read/write throws → 503 { error: 'session registry
      unavailable' } — FAIL-CLOSED, no session created anywhere.
  response 200 (IDENTICAL shape join vs create):
    { ok: true, fileId, sessionId, engineUrl, accessToken,
      role, revision, joined: boolean, ownershipEpoch }
  The access token is scoped { sub: principal, sid: sessionId, fid:
  fileId, role, exp } with the engine signing secret.
  Role rule: creator (first claim with no prior record) gets 'editor';
  a joiner gets the role it requests, default 'editor'; 'viewer' is
  honored when requested (share-link semantics). Gateway also records
  the file's creator principal in the registry record (extra field
  `creatorPrincipal` allowed; the §9 fields are mandatory).

## Ownership registry (§9) — new module packages/gateway/src/deploy/
## fileRegistry.ts (engine service AND gateway both import it; same
## SESSION_DATA_DIR-style shared dir locally)
Record: { fileId, sessionId, ownerInstance, ownerEndpoint, leaseExpiry,
ownershipEpoch, currentRevision, storedRevision, updatedAt,
creatorPrincipal }.
Interface: lookup(fileId), claim(record, expectedEpoch|null) → boolean
(CAS), heartbeat(fileId, sessionId, epoch, currentRevision,
storedRevision) → boolean (false = fenced: epoch no longer current),
release(fileId, sessionId, epoch).
Local adapter: JSON file + cross-process mutex (lockfile wx-spin) +
atomic tmp+rename; any IO error throws (fail-closed callers).
Prod adapter: Firestore-shaped structural interface mirroring
sessionStore.ts patterns; construction fails closed without credentials
(same posture as FirestoreSessionStores). No silent local fallback in
prod mode.

## Engine service (packages/gateway/src/services/engineSvc.ts)
- Session gains: fileId, participants Map<principal, role>, per-client
  lastAppliedRev tracking (for retention), SSE subscriber set,
  revision delta log (in-memory ring + persisted with journal entries).
- POST /session/claim { fileId, sessionId? }: if a live session for a
  DIFFERENT fileId exists → 409 (one process = one session today).
  If no live session: rehydrate from stores when a released session for
  this fileId exists (existing snapshot+journal+checksum path), else
  create a blank pending session that the owner's first /load fills
  (existing /load flow binds fileId). Registers ownership heartbeat.
- The single-principal 403 ('session belongs to a different principal')
  is REPLACED by participant checks: any principal holding a valid
  token for (sid, fid) may read (permission-filtered per principal),
  subscribe, and — if role=editor — submit ops. Per-op authorize() in
  the host still applies with the op's principal stamped. Viewer op
  submission → 403 { ok:false, rejected:true, reason:'viewer-role' }.
- Sequencer: ALL mutating executes go through one in-service FIFO
  promise-chain. POST /ops { clientId, clientSeq, baseRev, cmd } →
    * idempotency: (clientId, clientSeq) seen → return stored ack,
      no re-apply.
    * baseRev < state.revision → rebase: map incoming cmd to CollabOp,
      transform() against the CollabOp mappings of journaled ops in
      (baseRev, current]; transform null → 200 { ok:false,
      rejected:true, reason:'obsolete', revision } (visible rejection;
      journal stores NOTHING for rejected ops).
    * apply via host.execute (principal stamped) → assign
      revision = ++state.revision (existing counter semantics),
      journal the op (existing journalBuffer mechanism) WITH its delta
      cells + envelope { clientId, clientSeq, principal }.
    * delta = cellsChanged refs emitted during execute + post values:
      [{ sheet, row, col, value, formula? }] — value/formula read back
      from the host AFTER recalc completes, permission-filtered PER
      RECIPIENT at broadcast time (hidden cells omitted for principals
      they are hidden from; the cell appears as { hidden:true } with NO
      value so clients know to clear it — verify against five-faces:
      a hidden cell's value must never cross; a bare ref + hidden flag
      carries no value. If in doubt, omit value AND formula, keep ref).
    * response 200 { ok:true, revision, ack:{ revision,
      changedCellCount, checksum } } (existing EditAck shape).
  Legacy /execute (no envelope) keeps working, routed through the same
  FIFO, stamped with the caller's principal, and ALSO broadcasts its
  delta (SSE is always on) with origin { clientId: null }.
- GET /deltas (SSE, text/event-stream): auth = access token (Bearer or
  ?access_token= for EventSource). Events:
    event: hello    data { revision, storedRevision, fileId }
    event: delta    data { revision, origin:{clientId, clientSeq,
                    principal}, cells:[...] }   (per-recipient filtered)
    event: status   data { revision, storedRevision, saving }  — on
                    every revision + every flush commit/skip change.
    event: presence data { participants: [{ principal, color, sheet,
                    row, col, editing }] }
    event: session  data { kind: 'structure'|'load'|'reset'|'release',
                    ... } — replaces /events polling content.
  Heartbeat comment lines every 15s. On subscribe, server records the
  participant's lastAppliedRev = hello revision; POST /deltas/ack
  { revision } advances it (retention input). Disconnect removes the
  subscriber (participant stays 'attached' for retention until its
  applied-rev stalls prune eligibility — attached = has acked within
  the session or is the owner... coordinator ruling: 'attached clients'
  for §1 retention = clients with a live SSE subscription OR an ack
  within the last 5 minutes).
- GET /revisions?from=r&to=s → { revisions: [{ revision, origin, op,
  cells }] } served from journal entries (delta cells persisted in the
  journal segment entries — extend JournalEntry with optional
  `delta` + `origin` fields; segment format stays one write per
  segment). If `from` < oldest retained revision → 409
  { error:'before-retention', oldestRevision } → client re-streams.
- POST /presence { sheet, row, col, editing? } → upserts presence for
  the token principal (color = deterministic per principal, same
  palette as web collab.ts), broadcasts presence event. Presence TTL
  30s (engine CollabSession semantics), swept periodically. Presence is
  NEVER journaled, NEVER in snapshots, NEVER assigned a revision.
  POST /presence/leave removes.
- Retention pruning (engine service, on checkpoint + periodic):
  prune journal segments ONLY when segment.toRevision ≤
  min(storedRevision, minAppliedRevAcrossAttachedClients) AND a
  checkpoint (snapshot) exists at ≥ segment.toRevision. (§1 rule:
  (a) ≤ storedRevision (b) every attached client applied past (c)
  checkpoint at/beyond.) Never prune when no checkpoint covers.
- Fencing: owner heartbeat loop (lease/3) refreshes registry lease +
  currentRevision/storedRevision; heartbeat returns false or registry
  epoch > own → FENCE: set state.fenced=true; /ops, /deltas(hello),
  /load refuse 409 { error:'fenced' }; SSE subscribers get
  event: session { kind:'fenced' } then close.
- /session/release + idle eviction keep working (Phase 1); on release,
  registry record updated (storedRevision, lease cleared by gateway
  claim path on next open).

## Web client (apps/web/src)
- New module apps/web/src/services/collabTransport.ts implementing the
  above against RemoteEngineHost:
  * identity: clientId persisted in localStorage ('icecream.clientId');
    per-file state keyed by fileId in localStorage: outbound queue
    [{ clientSeq, cmd, baseRev, enqueuedAt }], lastAppliedRev,
    clientSeq counter. Queue entries removed ONLY on ack (or on
    visible rejection → moved to a retained 'rejected' list surfaced
    in UI with the input intact — never silently dropped).
  * open flow (gateway mode): gatewayClient.openFile(fileId?) → set
    engineUrl + token → RemoteEngineHost binds session → EventSource
    `${engineUrl}/deltas?access_token=...` → hello sets
    lastAppliedRev (or catch-up from stored lastAppliedRev via
    /revisions when behind; 409 before-retention → full re-stream via
    existing load/snapshot hydration, queue preserved).
  * delta apply: strictly in order (rev == lastAppliedRev+1 else hold +
    catch-up); apply to CONFIRMED layer only: update mirror/read
    caches via the host's existing remote-change path; a cell with a
    provisional (unacked own) edit keeps showing provisional until the
    delta for its own op arrives (origin.clientId == own clientId →
    ack match → clear provisional + queue entry).
  * status events drive the Saving…/Saved indicator from
    revision vs storedRevision (server-reported), replacing any
    client-side inference.
  * presence events → CollabBridge collaborators + Grid overlay:
    remote selection flag (colored border + name tag) on the cell;
    avatars row in the app header shows live participants.
  * presence send: selection change + 10s heartbeat POST /presence;
    leave on unload (sendBeacon).
  * reconnect: EventSource error → state 'disconnected' (existing UI),
    backoff 1s→10s; re-run gatewayClient.openFile(fileId) (fresh token,
    possibly NEW engineUrl — endpoints are leased, never cached beyond
    the token) → reconnect SSE → catch-up → resubmit queue in order.
  * /events polling: RemoteEngineHost.startPolling must NOT run in
    gateway mode once SSE is live — structure/session events arrive as
    SSE 'session' events and feed the same handlers poll() used.
    Local (in-process) mode unchanged.
- Ops submission: gateway-mode edits go POST {engineUrl}/ops with the
  envelope (baseRev = lastAppliedRev at enqueue). routedEdit's
  serverExecute path is rewired to the transport; optimistic display +
  server-wins + visible rollback semantics (HYBRID-CONSISTENCY §2)
  preserved.
- CollabBridge (apps/web/src/collab.ts): onBroadcast is wired to the
  transport (local ops submitted through the bridge go out via /ops;
  remote deltas come in via applyRemote-equivalent path). Keep the
  bridge's revision log fed from server deltas for the changes UI.

## Desktop (§11 logged-in)
apps/desktop loads the same apps/web/dist. Logged-in = gateway URL
configured (VITE_GATEWAY_URL baked at build, as Phase 1's no-gateway
build inverted). No desktop-main changes expected except: the packaged
build for matrix leg (b) is produced with a gateway-baked dist and the
app must reach the gateway open flow (the renderer's gatewayClient).
Any desktop-only blocker found is fixed in shared web code where
possible; desktop-main changes are allowed but must not alter
logged-out behavior (Phase 1 evidence stands).

## Hard constraints (all workers)
- Phase 1 must not regress: directSave, pin+stash, no-op rule,
  five-faces protection tests, signed-mode enforcement. Baseline
  suites 4,746 passed / 0 failed.
- Tests: related unit tests for everything new (vitest, existing
  patterns). Run ONLY related suites during build.
- Builds: gateway package tsc → dist (bins run from dist); web via
  vite build; stack restart via hidden_files/direct-save-pass/
  start-stack.sh pattern (kill existing node dist/bin + vite preview
  first; ONE stack at a time).
- Evidence + notes: hidden_files/phase2-coauthoring/build/
  worker-<x>-<name>.md per worker (files changed, design decisions,
  test results, conflicts found).
- NO git push. NO progress.md/TODO.md/perf edits (coordinator does).
