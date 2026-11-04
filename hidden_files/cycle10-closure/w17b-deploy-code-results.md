# W17B — Deployment-prep code results (Cycle 10 closure)

Implements the production access + session-lifecycle code from
`design-docs/deployment-architecture.md` ("Engine access pattern",
"Idle rule", "Engine extensions 1–3"), all behind config so the
default local topology (proxy mode) is byte-identical in behavior.
Validated LOCALLY on an isolated stack (gateway :8200 / engine :8201 /
web preview :42173 signed, :42174 proxy); the shared stack
(:8100/:8101/:4173) was never restarted or load-tested. No P95/P99
loads were run (P50 fixture only).

Consistency basis: `packages/engine/HYBRID-CONSISTENCY.md` — nothing
here weakens server-wins/checksum semantics; the journal + rehydrate
path rebuilds SERVER state at a revision and verifies it, it never
merges client state.

## 1. Signed-URL engine access (ENGINE_ACCESS_MODE=proxy|signed, default proxy)

Code: `packages/gateway/src/deploy/engineAccess.ts` (token + config +
tier selection), gateway issuance in `packages/gateway/src/gateway.ts`,
engine enforcement in `packages/gateway/src/services/engineSvc.ts`,
client in `apps/web/src/services/signedEngineTransport.ts` +
`gatewayClient.engineAccess()`; `apps/web/src/engine.ts` picks the
transport from `VITE_ENGINE_ACCESS_MODE`.

- Token format (documented in engineAccess.ts): 
  `base64url({v:1, sub:principal, sid:sessionId, tier, iat, exp}) + "." +
  base64url(HMAC-SHA256(ENGINE_ACCESS_SECRET, payload))`. Short-lived:
  `ENGINE_ACCESS_TTL_SECONDS`, default 600 (10 min), clamped 30–3600.
  Secret from env (Secret Manager in prod — just env locally).
- Gateway: `POST /api/engine/access` runs AFTER the gateway's existing
  JWT auth + per-principal rate limiting (it sits in the /api pipeline
  before proxy routing), takes `{sessionId?, cellCount?}`, mints a
  session id when none is named, and returns `{accessToken, engineUrl,
  sessionId, tier, expiresAt, expiresInSeconds}`. 501 when signed mode
  is not enabled (fail closed, never an unverifiable token).
- Engine (signed mode): EVERY route except /health requires a valid
  token — `Authorization: Bearer` (the form the client uses for all
  calls, NDJSON stream included: fetch carries headers) or
  `?access_token=` (the sendBeacon form; beacons cannot set headers).
  Verified: signature (constant-time), expiry, and per-route session
  scope (/load requires body.sessionId === token.sid; other routes
  require token.sid === the live/released session id; /reset adopts the
  token's session; /session/rehydrate names its session). The verified
  principal REPLACES x-principal (a direct caller could spoof the
  header; it cannot forge the HMAC). Everything else → 401 with a
  machine-readable reason. Per-session rate cap after connect:
  `ENGINE_SESSION_RATE_POINTS`/`_WINDOW` (default 5000/60s), enforced
  in the engine with the gateway's token-bucket limiter — the MCP-tier
  pattern.
- Client: SignedEngineTransport implements the same
  AsyncEngineTransport contract as the proxy transport. It obtains the
  grant through the gateway, then talks DIRECTLY to the grant's engine
  URL for load (classic + NDJSON stream), reads, executes, snapshot,
  events, reset and the lifecycle calls. Grant cached until 30s before
  expiry; on 401 it re-issues via the gateway ONCE and retries once; a
  second 401 surfaces. Proxy path untouched when the mode is off (the
  closure-pass gate runs in proxy mode).
- Session identity mapping (honest): the engine process holds ONE
  workbook, so one process = one live session. /load (and /reset)
  introduce the sessionId — returned in the load response
  (`EngineLoadResponse.sessionId`) — and register it. Multi-session per
  instance is the registry's production job (extension 1); the seams
  are provider-backed so that mapping can grow without changing this
  surface.
- Tier routing seam (item 5): issuance returns the tier URL by cell
  count vs the EXISTING MT threshold (`resolveParallelCellThreshold`,
  ICECREAM_MT_CELL_COUNT_THRESHOLD): > threshold → `ENGINE_URL_XL`,
  else `ENGINE_URL_STANDARD` (both default to the single engine route;
  locally both = :8201). Same code both tiers; size is a per-service
  setting (user's service inventory: engine standard 4 vCPU/16 GiB, XL
  8 vCPU/32 GiB). Unknown cell count → standard; the engine's own MT
  flag (same threshold) governs recalc regardless.

## 2. Idle lifecycle (§Idle rule; defaults IDLE_TIMEOUT_MS=600000, heartbeat 30s)

Client: `apps/web/src/services/sessionLifecycle.ts`
(ActivityTracker + IdleSessionController), wired in `App.tsx`,
surfaced in `StatusBar.tsx`.

- Activity: mousemove/mousedown/keydown/scroll/wheel/touchstart/
  pointerdown on window (capture) reset the idle clock — scrolling,
  mouse, keyboard and cell navigation all count. Heartbeat
  (VITE_HEARTBEAT_MS, default 30s) posts /session/heartbeat; the
  controller also adopts the session id from /session/status until the
  load response's id is known.
- At the timeout the controller calls /session/release: the engine
  checkpoints (see §3) and EVICTS (workbook dropped from memory;
  workbook routes then answer 409, never from the blank post-eviction
  host). Client enters DISCONNECTED: `sessionDisconnectedRef` joins
  the workbookLoaded gate family — commitCell rejects edits,
  buildDownloadBytes + the three gateway save funnels throw, autosave
  defers, the ribbon goes readOnly, file.save disables — plus a
  visible "⚠ Disconnected — idle" StatusBar segment with a Reconnect
  button (and the error text when reconnect is blocked).
- Reconnect (next activity — the tracker's activity callback — or the
  Reconnect button): /session/rehydrate rebuilds from snapshot +
  journal segments and the engine verifies the rebuilt state's
  checksum against the checkpoint's recorded checksum (the engine's
  ack-checksum FNV-1a machinery over the full owner-visible state)
  BEFORE answering ok. The controller unlocks ONLY on
  `ok && checksumVerified === true`; a mismatch is the 'error' state —
  editing stays locked, the reason is surfaced, never a silent unlock.
- Tab close: pagehide → beacon release, immediate. Signed mode:
  sendBeacon to the direct engine URL with ?access_token= and a
  text/plain Blob (CORS-safelisted — an application/json Blob forces a
  preflight that unload drops). Proxy mode: keepalive fetch through
  the gateway with the JWT (beacons can't carry Authorization).
- Server backstop: the engine stamps last-activity on every served
  request; with SESSION_LIFECYCLE=on a sweeper (SESSION_SWEEPER_MS,
  default 30s) checkpoints+evicts sessions idle past the timeout even
  when the client vanished. Default OFF locally so a long server-side
  build on the shared stack is never evicted from under anyone.
- Desktop seam: the controller is created only when
  `shouldRunSessionLifecycle({configEnabled, gatewayMode})` — i.e. the
  app drives a RemoteEngineHost. Desktop-local runs the IPC host
  (gatewayMode false), so the lifecycle STRUCTURALLY never engages
  there — verified by the shouldRunSessionLifecycle unit tests and by
  code path (engine.ts/App.tsx). Desktop in a gateway/remote mode gets
  the lifecycle like any web client. Master switch:
  VITE_SESSION_LIFECYCLE=on (default off — a shared local stack must
  never idle-evict mid-perf-run), VITE_IDLE_TIMEOUT_MS,
  VITE_HEARTBEAT_MS.

## 3. Registry + journal + snapshots (extensions 1–3)

Code: `packages/gateway/src/deploy/sessionStore.ts`; wired in
engineSvc (journal buffer/flush, checkpoint, rehydrate).

Interfaces: `SessionRegistry` (register/lookup/update/release),
`OpJournal` (segment API, below), `SnapshotStore` (put/get bytes +
checksum + revision).

SEGMENTED JOURNAL (user's billing addendum, 2026-10-20 23:04 —
binding): production Firestore is on FREE quotas (1 GiB stored, 50k
reads/day, **20k writes/day**, 10 GiB/mo egress), so one write per op
would blow the daily quota in one editing session. Design:
- The engine BUFFERS executed ops in memory with their revision
  sequence (`state.journalBuffer`), and persists ONE write per
  SEGMENT `{sessionId, fromRevision, toRevision, ops[]}` — flushed at
  every checkpoint trigger (idle release, tab-close release, periodic
  SNAPSHOT_EVERY_OPS/MS cadence) and when the buffer reaches
  `JOURNAL_SEGMENT_MAX_OPS` (default 200).
- The registry's revision advances ONLY at segment flush / checkpoint
  (never per op), so at rest registry revision == persisted journal
  head — which makes the torn-journal check exact.
- Replay reads segments in order and flattens them past the snapshot
  revision. Checkpoint flushes FIRST, then snapshots, then truncates —
  so truncate removes WHOLE segments with toRevision <= snapshot
  revision and no segment ever straddles it.
- DURABILITY WINDOW (honest): ops since the last segment flush are
  memory-only. A crash loses at most that tail (≤ segment cap, or
  since the last checkpoint trigger). REHYDRATE FAILS CLOSED on a torn
  journal: if the replayed head revision is behind the registry's
  recorded revision, a segment write was lost — rehydrate answers 409
  with checksumVerified:false and the session stays released. (Replay
  reaching PAST the registry is accepted: the journal is the op truth,
  the registry is an index that lagged a flush.)
- Every journaled op is the client's original command as executed on
  the /execute path that assigns revisions (setCell/setFormula);
  replay re-stamps the rehydrating principal.

Providers (SESSION_STORE=local|prod, default local):
- LOCAL: filesystem under SESSION_DATA_DIR (default
  `<gateway data dir>/sessions`) — registry.json, ONE FILE PER SEGMENT
  (`segment.<hash>.<from>-<to>.json`), one snapshot .xlsx + meta per
  session; atomic tmp+rename writes (the W2 library-store pattern).
  Fully real; all local validation ran against it (via the in-memory
  twin in unit tests + the real local adapter in the browser run).
- PRODUCTION: Firestore (registry + journal segment docs — one doc
  per segment) and Cloud Storage (snapshot bytes + checksum metadata)
  — the STORAGE SPLIT from the addendum: file bytes + snapshots → GCS
  (GCP project, on credit); metadata/registry/journal → Firestore;
  Firebase Cloud Storage is NOT used (Blaze-gated; the Firebase
  project is free-plan: Hosting + Auth only). The adapters are full
  method implementations against narrow structural client interfaces
  (FirestoreLike/StorageLike), with the real clients loaded by dynamic
  import and wrapped (wrapFirestore) when SESSION_STORE=prod;
  `prodSessionConfig` + construction FAIL CLOSED with a clear message
  when GCP_PROJECT_ID / SESSION_SNAPSHOT_BUCKET or the client
  libraries are absent — never a silent local fallback. Unit-tested at
  the interface level with in-memory fakes; they cannot integration-
  run here (no GCP project — credential gate, see Remaining).

Wiring: /execute buffers each accepted edit op with its revision;
checkpoints happen on release (idle/tab-close/sweeper), and on the
periodic cadence when configured; snapshots store XLSX bytes from the
exact server-side /download serialization path + the full-state
ack checksum at that revision; rehydrate = parse snapshot → build →
checksum-verify snapshot state → replay segments → torn check →
unlock.

## 4. HOST env for Cloud Run (W17a addition) + combined service runner

- Every gateway-package bin (gateway, engine, vault, meta, etl, agent,
  addons) and the MCP http bin now read `HOST` (default 127.0.0.1 —
  local behavior byte-identical); Cloud Run sets HOST=0.0.0.0 (its
  startup probes require 0.0.0.0:$PORT). PORT handling unchanged.
  MCP: the bin passes HOST through startMcpHttp's existing host param.
  Boot-verified on isolated ports: HOST=0.0.0.0 → `0.0.0.0:18201`
  (engine), default → `127.0.0.1:18202` (vault), MCP → `0.0.0.0:18206`.
  NOTHING in these changes gives a stateless service persistent state
  (lifetime model: gateway + service package stay stateless; only the
  two engine services hold sessions, subject to the idle release).
- COMBINED SERVICE-PACKAGE RUNNER (user's service inventory: the
  service package is ONE stateless Cloud Run service):
  `packages/gateway/src/bin/service.ts` +
  `src/services/servicePackage.ts` mount all five surfaces (vault,
  meta, etl, agent, addons) in ONE process on ONE PORT (default 8108)
  behind a prefix dispatcher accepting `/api/<name>/...` and the
  `/<name>/...` form the gateway's '/api' route delivers. Prefix
  dispatch is REQUIRED: etl and addons both serve a bare POST /run
  (every surface serves /health; identical semantics). No genuine
  conflict under prefixes — verified against all five route tables,
  and the five listeners already coexist in-process under
  startAllLocal. The dispatcher adds no state. Local multi-process
  topology untouched. Production gateway wiring for the deploy YAMLs:
  a single '/api' route → the combined service (longest-prefix still
  sends /api/engine/* to the engines), or per-prefix routes with the
  full path preserved — the dispatcher accepts both forms.
  (Coordinator note absorbed: IAM ID-token minting for a restricted
  service family is deploy-time, out of scope here.)

## 5. Config inventory

Gateway/engine env: ENGINE_ACCESS_MODE (proxy), ENGINE_ACCESS_SECRET,
ENGINE_ACCESS_TTL_SECONDS (600), ENGINE_SESSION_RATE_POINTS (5000),
ENGINE_SESSION_RATE_WINDOW (60), ENGINE_URL_STANDARD, ENGINE_URL_XL,
IDLE_TIMEOUT_MS (600000), SESSION_LIFECYCLE (off), SESSION_SWEEPER_MS
(30000), SESSION_STORE (local), SESSION_DATA_DIR, JOURNAL_SEGMENT_MAX_OPS
(200), SNAPSHOT_EVERY_OPS (0), SNAPSHOT_EVERY_MS (0), HOST (127.0.0.1),
GCP_PROJECT_ID, FIRESTORE_DATABASE_ID, SESSION_SNAPSHOT_BUCKET.
Web build env: VITE_ENGINE_ACCESS_MODE, VITE_SESSION_LIFECYCLE,
VITE_IDLE_TIMEOUT_MS (600000), VITE_HEARTBEAT_MS (30000),
VITE_GATEWAY_URL (existing).

## 6. Validation evidence

### Unit / integration suites
- gateway: NEW tests/deployAccess.test.ts (token issue/verify/expiry/
  scope/tamper, tier selection, store contracts incl. segment
  round-trip across multiple segments + whole-segment truncate,
  Firestore/GCS adapters vs in-memory fakes, prod config fail-closed,
  gateway issuance 200/401/501, engine signed mode refusals + scope +
  query-param form + per-session rate cap, lifecycle
  load→edit→release→rehydrate, segment-cap flush, torn-journal
  fail-closed, checksum-mismatch 409, beacon-form release, sweeper
  eviction) + NEW tests/servicePackage.test.ts (combined runner).
  One legacy assertion updated: engineSvc /reset now also returns the
  new sessionId (contract evolution, test's purpose unchanged).
- web: NEW sessionLifecycle.test.ts (tracker, idle release, reconnect
  unlock on verify, mismatch never unlocks, pagehide beacon, config +
  desktop-seam decision) + signedEngineTransport.test.ts (issuance,
  direct URL + bearer, 401 re-issue-once, load session introduction,
  rehydrate mismatch shape, beacon URL form).
- Full counts: gateway **159 passed** (15 files, incl. the 25 new
  deployment tests), engine **987 passed**, web **1597 passed** (the
  post-tweak affected files re-run green: 31/31), mcp-server **117
  passed + 1 skipped** (pre-existing skip). All suites run AFTER the
  final code state except the web full run, which preceded only the
  beacon content-type tweak (covered by the targeted re-run).

### Browser validation (isolated stack, perf-p50, headless Chromium)
Script: `hidden_files/cycle10-closure/w17b-browser-validate.mjs`
(pw2 pattern: playwright-core + puppeteer Chromium). Signed stack:
engine :8201 (ENGINE_ACCESS_MODE=signed, SESSION_LIFECYCLE=on,
IDLE_TIMEOUT_MS=20000, SESSION_DATA_DIR=/tmp/w17b-sessions), gateway
:8200 (signed issuance on), web build with VITE_ENGINE_ACCESS_MODE=
signed + VITE_SESSION_LIFECYCLE=on + VITE_IDLE_TIMEOUT_MS=20000 on
:42173. As test user e2e-tester:
- Login → drop perf-p50.xlsx → load completed in ~7.0s.
- **47 requests went DIRECTLY to the engine :8201; 0 engine data
  requests were proxied** through /api/engine/*; 21 issuance requests
  hit POST /api/engine/access (per-host-instance grants, see §7 note).
  An unsigned direct call to the engine returns 401 (verified by curl
  before the run).
- Edit: the fixture's cover sheet is protected (edits there are
  correctly rejected — "Cell A1 is locked"); on HISTORICAL INPUTS the
  A1 edit to 424242 landed and read back through a script-side direct
  token read: `{kind:'number', value:424242}`.
- Idle: **"Disconnected — idle" appeared at 20,078 ms** (the 20s test
  timeout). A rapid edit attempt while disconnected showed the gate's
  error text ("Disconnected (idle) — reconnect to resume editing.")
  and the cell value was unchanged (424242) after settle.
- Reconnect: mouse activity triggered rehydrate; the banner cleared,
  the engine log shows `session rehydrated … revision=2 replayedOps=0
  checksum=b107165653daba7a` — identical to the checkpoint's recorded
  checksum — and A1 still read 424242 (values intact, checksum-
  verified unlock).
- Tab close (page.close with runBeforeUnload): the session registry
  on disk flipped to `status:'released'` with
  **`releaseReason:'tab-close'`** — the beacon release, observed
  server-side, distinct from the sweeper's releases (also seen in the
  engine log with reason 'idle-sweeper' when the page later sat idle).

### Proxy-mode regression (isolated stack)
Same script, MODE=proxy: plain engine :8201 + gateway :8200 +
default web build (no signed/lifecycle env) on :42174. Login → P50
load ~7.1s → **0 direct engine requests, 14 proxied engine data
requests**, edit landed end-to-end (424242 read back through the
gateway). The default path is unbroken. The combined service bin and
the HOST boot checks (§4) were likewise verified by curl on isolated
ports (18208/18206/18201/18202) and torn down after.

## 7. What remains (credential-gated / deploy-time)

- Firestore + Cloud Storage adapters: code-complete and fake-tested;
  integration requires a GCP project + credentials (SESSION_STORE=prod
  fails closed until then) — the user's deploy step (service accounts
  in the Secure Vault), per the design doc's "Still required from the
  user".
- Deploy YAMLs / gateway route reconciliation for the 5-service
  inventory (coordinator/W17a): gateway routes for the combined
  service package + the two engine tiers; IAM ID-token minting for
  restricted services is deploy-time (noted by W17a, out of scope).
- Multi-session-per-engine-instance routing (registry-driven) is the
  production scaling step the registry seam enables; locally the
  honest mapping is one live session per engine process.
- Observation (no action taken): the web app issues a classic /load
  AND a /load/stream per open (both modes — pre-existing app behavior),
  and each RemoteEngineHost instance holds its own access grant, so
  issuance requests per open are in the teens. Harmless (issuance is
  the designed, rate-limited handshake) but worth knowing.
