# FIX-B Report — F1 agent↔workbook binding + D4 gateway agent proxy timeout

Worker: FIX-B. Date: 2026-10-21 (evening PDT). Scope honored: source edits +
tests only in `packages/gateway`; NO dist rebuild, NO stack restart, NO git
push. Typecheck `tsc -p tsconfig.json --noEmit` clean.

**Verdict: F1 IMPLEMENTED + D4 IMPLEMENTED, both test-proven at the service
level. Live re-validation against the running stack still requires the
coordinated dist-rebuild/restart window (agent + gateway dists).**

---

## 1. Trace (file:line, code read before editing)

### 1.1 The EngineHost surface createServer's tools use
- `packages/engine/src/protocol.ts:249` — `class EngineHost`. Surface:
  `execute(command)` :650, `executeAsync` :842, `readCell(ref, auth)` :891,
  `bulkReadback` :926, `readRange` :1235, `readSheet` :1252, `snapshot()`
  :1258, `getUsedRange(sheet)` :1269 (protocol-level, via getView),
  `subscribe(listener)` :1273, `sheetNames()` :366, `getView()` :310,
  `getAuthorizer()` :380, `setHiddenCheck()` :1122, `currentRevision()` :437.
- `packages/mcp-server/src/server.ts:227` — `createServer(host?, options?)`;
  :228 the defect: `host ?? new EngineHost()` (fresh private workbook).
  Tools `await` the host (async-host convention, comments at :392/:432):
  `readRange` (:392, read_cells), `execute` (:432 write_cells, :477
  set_formulas, :507 recalculate), `readSheet` (:526, get_results),
  `snapshot()` (:1280 analysis sheet name, :1754 open_data_source),
  `getUsedRange` (:1299, analysis range). `subscriptions.attach(engine)`
  uses `host.subscribe` (packages/mcp-server/src/subscriptions.ts:88).
  Service connector helpers (`writeTableToNewSheet`,
  `applyRefreshPlanToHost`, packages/service/src/connectors/engine.ts:44/:84)
  use only `host.execute`. NO tool uses getView() directly (comment
  server.ts:1297) — the view is a secondary surface.

### 1.2 The web client's remote discipline
- `apps/web/src/services/remoteEngine.ts:570` — `RemoteEngineHost extends
  EngineHost`: sync signatures, Promise runtime; sheet-name cache +
  `snapshot()` cache pattern (:1318/:1358); stub authorizer (enforcement is
  server-side) :601.
- `apps/web/src/services/signedEngineTransport.ts` — grant/token lifecycle:
  mint via gateway, `Authorization: Bearer` on every direct call, on 401
  re-issue ONCE and retry (:185 `direct()`), refresh skew 30 s (:69).
- `apps/web/src/services/collabTransport.ts:692` — `submitCommand`: ops go
  through POST /ops with envelope `{clientId, clientSeq: ++seq, baseRev:
  lastAppliedRev}` (:729–731); baseRev is NEVER refreshed on resubmission
  (the S6 rebase lesson, :714–722); rejections are visible, idempotency key
  is `clientId:clientSeq`.

### 1.3 The engine service HTTP API (packages/gateway/src/services/engineSvc.ts)
- Signed gate :3598–3645: in `ENGINE_ACCESS_MODE=signed` every route except
  /health requires a Bearer token verified by `verifyEngineAccessToken`;
  claims REPLACE x-principal; token sid must equal the live session id.
  File-scoped routes (/ops, /deltas, …) additionally require `fid` :3648.
- `POST /execute` :4014 — `{cmd}` → CommandResult (+ optional ackChecksum);
  stamps `auth={principal}` itself (:3154), never trusts client auth.
- `POST /ops` :4033 — envelope `{clientId, clientSeq≥0, baseRev≥0, cmd}`;
  viewer role → 403 `{ok:false, rejected:true, reason:'viewer-role'}`;
  idempotent on `clientId:clientSeq`; `baseRev < retentionFloor` → 409
  `{ok:false, rejected:true, reason:'before-retention', revision}`;
  success → `{ok:true, revision, ack}` (runExecuteInternal :3410-ish).
- `POST /read` :4250 — `{kind:'cell',ref}→{value, formula?}`,
  `{kind:'range',range}→{values, formulas}`, `{kind:'sheet'}→{values}`,
  `{kind:'usedrange'}→{range|null}`.
- `GET /session/status` :3698 — `{sessionId, fileId, participants,
  status, revision, storageRevision, ownershipEpoch, …}`.
- `GET /snapshot` :4324 (permission-filtered), `GET /sheets` :4650,
  `GET /events?since=` :4329 (ring buffer — the pre-SSE poll channel),
  `GET /deltas` :4127 (SSE; not used by this fix — see §5 risks).

### 1.4 The session registry
- Record type: `packages/gateway/src/deploy/fileRegistry.ts:49–62` —
  `{fileId, sessionId, ownerInstance, ownerEndpoint, leaseExpiry,
  ownershipEpoch, currentRevision, storedRevision, updatedAt,
  creatorPrincipal}`. **No participants field is written to the registry**
  (participants live in the engine's in-memory session state, engineSvc.ts
  :649) — the resolver therefore matches on creatorPrincipal and ALSO
  honors a participants list/map if a record ever carries one.
- Local storage: ONE JSON file `file-registry.json` (a fileId→record map)
  under `fileRegistryDir()` (fileRegistry.ts:115) = `FILE_REGISTRY_DIR` or
  `<SESSION_DATA_DIR>/file-registry`; `sessionDataDir()`
  (deploy/sessionStore.ts:525) defaults to `~/.icecream-sheets/data/
  sessions` — i.e. the brief's `~/.icecream-sheets/data/sessions/
  file-registry/file-registry.json` (verified live: records for
  `user:alice` with ownerEndpoint `http://127.0.0.1:8101`).
- Liveness: `isLiveOwner(rec, now)` (fileRegistry.ts) = leaseExpiry > now.
  The `FileRegistry` interface is point-lookup only (`lookup(fileId)`) —
  there is NO list operation, so enumeration for "a principal's sessions"
  belongs in the resolver (reads the local file; prod/Firestore listing is
  an injectable seam — see §5).

### 1.5 Engine access tokens + agent process env
- Signer: `packages/gateway/src/deploy/engineAccess.ts` —
  `engineAccessSecret()` :67 (env `ENGINE_ACCESS_SECRET`),
  `issueEngineAccessToken({secret, principal, sessionId, fid, role, tier,
  ttlSeconds})`, claims `{v:1, sub, sid, fid, role, tier, iat, exp}`.
- Env flow VERIFIED: `packages/gateway/src/bin/agent.ts` and
  `services/servicePackage.ts` set NO env themselves — the agent process
  inherits its launcher's environment. The RUNNING agent process
  (`/proc/<pid>/environ`, values not reproduced here) carries
  `ENGINE_ACCESS_SECRET` (present) and `ENGINE_PUBLIC_URL=
  http://localhost:8101`; the running engine carries
  `ENGINE_ACCESS_MODE=signed`. So in the real stack the default minter
  below can sign and the engine will verify.

---

## 2. Design decisions + why

1. **Placement: `packages/gateway/src/services/`** (new files
   `remoteEngineHost.ts`, `agentSessionResolver.ts`). The engine package is
   the protocol layer and must not learn HTTP/token signing; mcp-server
   cannot import the gateway (gateway depends on IT — a cycle); the gateway
   package already owns engineSvc, the registry, and the signer. agentSvc
   hands the host to `createServer(host)` exactly like the web app hands
   its host to its createServer.
2. **Ops discipline mirrors the web collab transport**: mutating commands
   (the engine service's SAVE_MUTATING_OPS set, mirrored as
   `REMOTE_MUTATING_OPS` and pinned by tests) go via POST /ops with
   `{clientId: 'agent:<principal>', clientSeq, baseRev}`; baseRev is the
   last revision SEEN (registry `currentRevision` seed →
   /session/status lazy seed → advanced by every /ops response, acks and
   rejections alike) and is never refreshed mid-flight (sequencer rebases,
   §7). Non-mutating commands go via POST /execute (assigns no revision).
   Command `auth` is stripped — identity comes from the token (signed) or
   x-principal (proxy), and the engine stamps it itself.
3. **Tokens**: the host's `getAccessToken` callback is invoked on EVERY
   request (re-mint per need), 401 → re-mint + retry exactly once (the
   signed transport's discipline). agentSvc's default minter uses
   `issueEngineAccessToken` with role `editor`, ttl 120 s, fid/sid scoped
   to the resolved session. If no secret is configured the minter returns
   null and binding stays OFF (private-host fallback) — an unsigned host
   cannot authenticate to a signed-mode engine, so binding without a
   signer would only convert today's working private behavior into 401s.
4. **Resolver**: fresh read of the registry file per resolve (no cache —
   a session opened a second ago must be visible; opens are rare next to
   chat turns, and the file is small metadata). Live lease + creator/
   participant match + `updatedAt` desc (epoch tiebreak). Resolver errors
   (e.g. corrupt registry) → agentSvc logs and falls back to the private
   host for CHAT (fail-soft); opens remain fail-closed at the registry,
   which is where a second copy would be created.
5. **Runtime cache**: keyed principal + sessionId (null = private).
   Session change → drop the principal's watcher, `await rt.close()`,
   build a new runtime. Config/vault/thread-persistence wiring untouched
   (backend still re-resolves per plan; thread store is shared), so a
   swap loses no threads or settings. The bound MCP server additionally
   gets `defaultPrincipal: principal` so tools that omit an explicit
   principal act as the user on their workbook (§3) instead of the
   anonymous `mcp-client` fallback; the fallback path is byte-identical
   to before.
6. **subscribe()**: polls GET /events (the engine's ring buffer, the
   web host's legacy channel) at 1.5 s while listeners exist, unref'd,
   errors swallowed. This delivers grid-side edits to MCP subscriptions
   too, without taking on SSE client machinery in this fix.
7. **getView()**: cache-only view seeded by the host's awaited reads
   (web RemoteView semantics — misses return the null value and queue a
   deduped background fill). The MCP tools never use the view; this is
   for secondary consumers (automation-style `getView().readCell().formula`
   after a real read has seeded the cache).
8. **D4**: per-route timeout following the existing pattern in gateway.ts
   (the `isEngineFileLoad`/`isEngineRead` booleans + the proxy call's
   timeout ternary): `POST /api/agent/message` → exported constant
   `AGENT_MESSAGE_UPSTREAM_TIMEOUT_MS = 270_000`. Only /message gets it —
   the other agent routes are quick calls and keep failing fast at 30 s.
   bin/gateway.ts's server requestTimeout (660 s) already sits above it.

---

## 3. What changed

| File | Change |
|---|---|
| `packages/gateway/src/services/agentSessionResolver.ts` | NEW. `ResolvedAgentSession`, `pickActiveSession` (pure), `readLocalRegistryRecords`, `createAgentSessionResolver` (injectable record source/env/clock), participant-shape normalization. |
| `packages/gateway/src/services/remoteEngineHost.ts` | NEW. `NodeRemoteEngineHost extends EngineHost`: injectable fetch + `getAccessToken`; /ops envelope with clientSeq/baseRev tracking; /execute for non-mutating; /read mappings (cell/range/sheet/usedrange); /snapshot; /sheets; /session/status revision seeding; 401 re-mint retry-once; /events-poll subscribe; cache-only view; `REMOTE_MUTATING_OPS`. |
| `packages/gateway/src/services/agentSvc.ts` | `runtimeFor` is now async + session-aware (resolver + minter probe, principal+sessionId cache, close-old-on-change, watcher invalidation); `watcherFor` async; ALL listener call sites await + pass deps; `AgentServiceDeps` gains `resolveSession` / `mintEngineToken` / `engineFetch` test seams; bound server gets `defaultPrincipal`. Fallback (`createServer(undefined)`) unchanged when no session. Header behavior for config/vault/threads untouched. |
| `packages/gateway/src/gateway.ts` | D4: `AGENT_MESSAGE_UPSTREAM_TIMEOUT_MS = 270_000` (exported) + `isAgentMessage` route flag in the proxy timeout selection. |
| `packages/gateway/src/index.ts` | Additive exports for the two new modules. |
| `packages/gateway/tests/agentBinding.test.ts` | NEW — 17 tests (below). |

No changes to packages/engine or packages/mcp-server were needed:
createServer already accepts any EngineHost and awaits it.

---

## 4. Tests

New file `tests/agentBinding.test.ts` — **17/17 pass** (solo run 73 s,
incl. the 32 s D4 test):
- Resolver (6): creator's live session; null for other principal / expired
  lease / released (leaseExpiry 0); participants in array-of-objects,
  string-array, and map shapes; most-recently-updated wins (newer DEAD
  session correctly skipped); ENGINE_PUBLIC_URL fallback when
  ownerEndpoint is empty; on-disk file source (missing → null, present →
  resolves, corrupt → throws).
- Remote host (6, mock fetch): range-read mapping + Bearer header +
  exact request body; /ops envelope with clientSeq 1→2 and baseRev 5→6→7
  tracking and **auth stripped** from the wire cmd; baseRev seeded from
  /session/status (9) when unknown; recalculate routed via /execute with
  no envelope and no revision change; 401 → re-mint (tok-1→tok-2) +
  retry-once succeeds; visible rejection `{ok:false, reason:'viewer-role'}`
  surfaced as a CommandResult failure and its revision (12) adopted.
- agentSvc e2e (3): listener on an ephemeral port + FAKE engine HTTP
  server (verifies every request's Bearer token with the REAL
  `verifyEngineAccessToken` — fid, role 'editor', sid, principal) +
  fixture resolver. Prompt `set C1 to 424242` → audit write_cells ok,
  fake engine received exactly one /ops `{clientId:'agent:user:carol',
  clientSeq:1, baseRev:0, cmd:{setCell Sheet1!C1=424242}}` and its cell
  map holds 424242. Prompt `sum of A1:A3` → reply "The sum of A1:A3 is
  21006." (7001+7002+7003 — values only the fake engine holds; proven
  through its /read). Resolver → null → `recalculate now` succeeds on the
  private host and the fake engine sees NO new traffic (fallback intact).
- D4 (2): constant is 270_000; through a real gateway, a backend that
  parks /api/agent/message for 32 s now returns **200 after ~32.2 s**
  (gateway log line) instead of the old 502 at ~30 s.

### Suite counts (packages/gateway, `npx vitest run`)
- **Baseline (before any FIX-B edit)**: Test Files 4 failed | 16 passed
  (20); Tests **4 failed | 560 passed (564)**. Failures: phase2Collab ×1,
  productLayer ×2, productLoadRef ×1.
- **After**: Test Files 1 failed | 27 passed (28); Tests **1 failed |
  276 passed (277)**. Sole failure: `directSave.test.ts` "ops during a
  save (Addendum 4 pin)" — `storageRevision` expected 1, got 2.
- Caveats the coordinator must know: (a) the two runs are NOT same-shape —
  sibling coordinators were actively adding/editing test files in this
  tree during the window (20 files counted at baseline, 28 after; several
  test files in git status are untracked-new), so totals are not directly
  comparable; (b) the after-run took 870 s under extreme contention (a
  sibling restarted the whole stack and ran builds + another vitest run
  concurrently). The directSave failure is in a subsystem FIX-B never
  touched (no shared code path: save-pin checkpoint accounting inside
  engineSvc), and **the same file passes 8/8 on a solo re-run** (107 s),
  including the exact failing test — contention flake, not a FIX-B
  regression. All four baseline failures passed in the after-run, and
  every agent/gateway/services test passed in both runs.
- `tsc --noEmit` on the gateway package: clean.

---

## 5. Residual risks / open items

1. **Runtime rebuild vs parked HITL turns** (the named risk): if the
   resolved session changes while a /message turn is parked on an
   agent.* ask, the next runtimeFor call closes the old runtime; the
   parked turn can fail and its pending ask (held in the OLD MCP
   server's store) is invisible to the new runtime's /pending. Threads
   and config survive (shared persistence); only the in-flight park is
   lost. Swaps require a genuine session change (open/release/different
   file), never happen for a stable session. A gentler drain (defer
   close until no turn is parked) needs a parked-turn signal AgentRuntime
   does not expose today.
2. **Registry enumeration is local-file only.** The FileRegistry
   interface has no list operation; in prod (Firestore) mode the default
   resolver reads a local file that will not exist → resolves null →
   private-host fallback (today's behavior, no regression). Prod binding
   needs a listing adapter behind the resolver's `records` seam (e.g.
   a Firestore collection scan or a gateway-maintained per-principal
   index).
3. **Registry participants**: opens today record only creatorPrincipal;
   a non-creator participant's agent will NOT bind (their resolver finds
   no record naming them) and falls back to a private workbook — a
   silent-behavior gap for shared sessions until opens record
   participants (or the resolver can consult the engine's
   /session/status participants). Creators — the validated case — bind.
4. **Role is always 'editor'** in minted tokens: a user who joined as a
   viewer would get an agent that can write (their token at open said
   viewer; the agent's says editor). The engine would apply the agent's
   ops. Restricting this needs the join role recorded — same registry
   gap as (3).
5. **Sessions opened without /api/engine/open** (legacy direct /load via
   the gateway proxy) have no registry record → no binding → fallback.
   This matches the brief's registry-based design.
6. **/ops transport failure mid-op**: if the HTTP call itself fails after
   the engine may have applied the op, the host throws (tool surfaces an
   error); the clientSeq is NOT reused by later ops, so a manual retry
   is a new op (the web transport's durable queue + delta-ack dedupe is
   richer — porting it is a follow-up, not part of F1's bar).
7. **subscribe() polls /events** (1.5 s) rather than consuming the SSE
   /deltas channel; events are the engine's last-1000 ring buffer, so a
   very bursty session could drop subscription events between polls.
   SSE consumption is the upgrade path if proactive watches prove lossy
   in the live tours.
8. **Live proof still owed** (coordinated window): rebuild gateway dist,
   restart agent + gateway, re-run probe step 5 — agent must read
   7001/7002/7003/'GRIDWORKBOOK' from the engine session and its C1 write
   must read back there. Everything above is service-level proof with a
   fake engine + the real signer/verifier.

---

## Addendum (post-delivery, baseline-count correction)

After this report was delivered, the RAW final output of the baseline
run (proc_6988644995f4) arrived late and conflicts with the summary the
runtime had delivered for that same session earlier (which is what §4
quoted: 560 passed / 4 failed / 20 files). The raw output shows:
start 23:45:46, duration 754 s, **Test Files 27 passed (27), Tests 260
passed (260), zero failures**. The two cannot both describe the same
run; with sibling coordinators running gateway suites concurrently in
the same tree all evening, the earlier summary is most consistent with
a concurrent sibling run's result being delivered into this session's
context. Safest reading for the coordinator: suite-level counts from
that window (baseline AND after) are unreliable in both directions —
the tree and the test corpus were changing mid-run. The scoped evidence
is unaffected and stands on its own: agentBinding 17/17 solo; the
after-run's only failure (directSave Addendum-4 pin) passing 8/8 solo;
services/gateway/agent tests passing in the after-run.
