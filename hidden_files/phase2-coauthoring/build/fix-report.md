# Phase 2 FIX pass — coordinator report (INTERIM: parked at the VM write freeze)

Fix coordinator, 2026-10-21 (~21:15 UTC). User directive: implement ALL
prescribed fixes from the build coordinator's interim report and
validate them. **All four fixes are IMPLEMENTED in code (via host-side
file tools). NO validation has run yet** — the VM exec-write freeze
(EPERM on every write() from exec'd processes, in effect since
~19:42 UTC) makes builds, tests, browsers and stack restarts
impossible right now. Gateway :8100 is DOWN; engine :8101 (401 =
alive, signed mode) and preview :4173 still answer. This report parks
the pass at that exact boundary with a resume note (§6). Nothing below
claims a test result that was not observed.

## Root cause (verified in code this pass)

The local stack's engine runs in SIGNED mode: every route requires a
gateway-issued engine access token scoped to the session
(engineSvc.ts: `/load` requires body.sessionId === token.sid; other
routes require token.sid === the live session id). The gateway PROXY
forwards the client's headers as-is — i.e. the gateway JWT, not an
engine token — so every proxied `/api/engine/load`, `/load/stream`,
`/read`, `/sheets` call 401s. Worker A's curl proof showed the same
`/load` with the handshake token DIRECT returns 200. The Phase 2 join
handshake token is the correct credential; the client's load path was
wrong, exactly as the interim report prescribed. The boot storm is
the same shape: the web host fired /sheets + /read from construction,
before any session existed (8,195 requests / ~65 s in the leg-a
trace — 401s + gateway 429s).

## Fix 1 — direct post-handshake load (§9 step 4) — IMPLEMENTED

- `apps/web/src/services/collabTransport.ts`
  - `loadXlsxProgressiveDirect(base64, onChunk)`: POST
    `{engineUrl}/load/stream` with the handshake token, body
    `{format, data, sessionId: <claimed sessionId>}`; NDJSON
    accumulation identical to the other transports (mergeLoadChunks,
    same ProgressiveLoadChunk shape, so the host's seeding/progress/
    Calculating handling is unchanged). 401 before the first chunk →
    re-run the gateway lookup once (fresh token/owner) and retry once.
    Stream unusable before any chunk → falls back to `loadXlsxDirect`
    with one synthetic terminal chunk.
  - `loadXlsxDirect(base64)`: POST `{engineUrl}/load` direct; the body
    is built per attempt (a 401-refresh retry carries the FRESH
    session id, never the stale pair).
  - `fetchOpenedWithRefresh` + `refreshOpened` helpers (one refresh +
    one retry, never a loop).
- `apps/web/src/services/remoteEngine.ts` — `loadXlsxAsync` extracts
  its chunk handler (unchanged behavior) and prefers
  `collab.loadXlsxProgressiveDirect` whenever a collab transport is
  attached AND a handshake session is opened (`collab.sessionId`).
  The gateway-proxied load endpoints are therefore never used for a
  handshake-opened session, in EITHER build mode (proxy or signed).
  Sessions no handshake opened keep the Phase 1 transports byte-for-
  byte (the collab branch is strictly additive).
- `apps/web/src/App.tsx` — `openRemoteBuffer` now mints a FRESH
  file/session for uploaded bytes (`transport.connect()` with no
  fileId). It previously passed the CURRENT collab fileId, i.e. a
  second upload would have joined the previous file's session and —
  with the load fixed — loaded the new bytes into the WRONG file's
  session. Joining remains exclusively the `#file=` startup path
  (which never loads). Flagged as an in-scope correction: it is the
  same defect class (load must land in the session created for THIS
  file).

## Fix 2 — claim hygiene — IMPLEMENTED

- `collabTransport.ts`: `releaseOpenedSession(reason)` — POST
  `{engineUrl}/session/release {sessionId, reason}` direct with the
  handshake token (the engine checkpoints + clears its registry
  lease), then disconnects and forgets the session locally. Plus a
  `wasJoined` getter (guest vs creator distinction).
- `App.tsx` `openRemoteBuffer`:
  - Tracks whether THIS open created the session (`joined === false`).
    If the load then fails → `releaseOpenedSession('load-failed')` +
    `setCollabFile(null)` (chip + URL hash cleared — `setCollabFile`
    now clears `#file=` when passed null, via `clearFileIdFromHash`).
    A JOINED session is never released by a guest.
  - File switch in the same tab (the local engine hosts ONE session;
    a live previous session 409s the new claim): if this tab CREATED
    the current session → release it first
    (`'superseded-by-new-open'`; co-clients re-claim/rehydrate per
    §9); if this tab JOINED it → local disconnect only. If the mint
    then fails, the previous session is re-joined by id and the open
    ABORTS with a visible error (never loads new bytes into the
    restored session).

## Fix 3 — request storm (F3 completion, incl. residual (a)) — IMPLEMENTED

Coordinator ruling taken (Worker F left this as "a coordinator
ruling, not taken here"): host reads are gated on bind, WITH the
Phase 1 reads-during-build preserved.

- `remoteEngine.ts` `RemoteEngineHost`:
  - `sessionBound` state + `readsAllowed()` = bound OR a load in
    flight OR a reset in flight. Bound is set by: collab handshake
    open (attach onOpen / already-opened at attach), load completion,
    reset completion, resync, and `markSessionBound()` (public; the
    App calls it from the idle-lifecycle 'connected' transition —
    checksum-verified rehydrate).
  - Gated while unbound: `RemoteView` fetches (batcher + used-range),
    `refreshSheetNames()`, and the `/events` poll — ZERO network
    calls pre-bind (was: constructor refresh + 1.5 s poll + every
    render read).
- `RemoteView` global failure breaker: any view-fetch failure
  suppresses ALL view fetches for an exponential window (500 ms
  doubling, 15 s cap); success or gate-lift resets it, as does a load
  start. Per-key 2 s backoff retained. This bounds every OTHER
  unbound/unloaded failure mode (e.g. engine death mid-session) to
  ~1 batch per window.
- Unit proofs written (not yet run): gate test asserts ZERO transport
  calls pre-bind and flow post-bind; breaker test asserts 30 fresh-key
  reads after a failure add ZERO transport calls inside the window.

## Fix 4 — dist-baking guard — IMPLEMENTED (guard); proof re-run PENDING (freeze)

- `apps/web/package.json`: `build:local-stack` =
  `tsc && VITE_GATEWAY_URL=http://localhost:8100
  VITE_ENGINE_ACCESS_MODE=signed vite build && node
  scripts/verify-dist.mjs --local-stack`; `verify:dist` standalone.
  (The local stack needs BOTH values: URL-only bakes proxy mode,
  whose calls all 401 against the signed-mode engine — the leg-a
  dist had exactly that defect on top of the load bug.)
- `apps/web/scripts/verify-dist.mjs` (new): fails loudly (exit 1,
  naming the missing bake + the correct command) unless the dist JS
  contains the baked gateway URL and `VITE_ENGINE_ACCESS_MODE:
  "signed"`.
- `apps/web/src/services/buildInfo.ts` (new) + `main.tsx`: boot-time
  stamp — console banner + `data-icecream-gateway` /
  `data-icecream-engine-access` attributes on <html>, so a harness
  can assert the build BEFORE running scenarios.
- Worker F's live one-op proof re-run against a correctly baked dist:
  NOT RUN (needs stack + browser; first item in the resume note).

## Tests written (NOT RUN — freeze)

- `collabTransport.test.ts` +5 (describe 'direct load + claim
  hygiene'): direct stream load hits `{engineUrl}/load/stream` with
  Bearer handshake token and body sessionId === claimed id, chunk
  order meta→rows→built; stream-404 fallback to direct /load with a
  'fallback' chunk; 401 → gateway re-lookup (engine-2/tok-2) → retry
  succeeds; `loadXlsxDirect` body; `releaseOpenedSession` posts
  {sessionId, reason} and forgets the session.
- `remoteEngine.test.ts` +3 (gate zero-network proof; breaker bound
  proof; collab-direct load preference — legacy transport load never
  called) and the Phase 2 polling test ADAPTED: it asserted /events
  polling before any load (the storm behavior itself); it now asserts
  zero polling pre-bind, polling after the binding load, silence while
  the collab transport is attached, resumption after detach.
- Existing-suite impact reviewed by inspection: saveInterlock.test
  loads before reading (unaffected); the /ops-routing test loads
  before attaching (legacy branch, unaffected); W16 test uses the
  transport progressive fake without a collab transport (unaffected).

## Doc-vs-code conflicts / residuals flagged

1. **handleNew (Worker C's F6) — still open, deliberately untouched.**
   `resetRemoteAsync` uses the legacy transport reset: in a signed
   build it mints a NEW anonymous session via /api/engine/access,
   after which the gateway's file claim can 409 against it (engine
   claim rule: live session for a different file). Not in the S1 path
   and not in the prescribed fix scope; the fix pass did not silently
   expand into it. Recommended follow-up: order New as
   release/claim-then-reset on the CLAIMED session (direct /reset
   with the handshake token), mirroring Fix 1's pattern.
2. Worker B decision #4 (handshake failure → continue with Phase 1
   load) is PRESERVED for the no-previous-session case (Phase 1
   compat) and narrowed everywhere else: with a previous session the
   open aborts rather than risk loading into the wrong session
   (above). With a successful handshake the proxied load is
   unreachable (host preference is by opened-session presence).

## §6 RESUME NOTE — validation program, in order (run when exec writes recover)

1. Probe: `echo x > /tmp/wp.txt` must succeed. If still EPERM, stop —
   do not improvise validation.
2. Related unit suites:
   `cd apps/web && npx tsc --noEmit && npx vitest run
   src/services/collabTransport.test.ts src/services/remoteEngine.test.ts
   src/services/signedEngineTransport.test.ts src/services/routedEdit.test.ts
   src/collab.test.ts src/grid-commit-once.test.ts
   src/services/sessionLifecycle.test.ts src/services/saveInterlock.test.ts`
   Fix any fallout from the gate (other suites that read pre-load are
   the risk — grep for `new RemoteEngineHost` found only
   remoteEngine.test + saveInterlock.test, both handled).
3. Rebuild dist correctly: `cd apps/web && npm run build:local-stack`
   (tsc + baked build + verify-dist must print OK).
4. Restart the default stack:
   `bash hidden_files/direct-save-pass/start-stack.sh` (kill stale
   node dist/bin + vite preview first; confirm 8100/8101/4173 = 200,
   ONE stack). Engine must be signed mode (start-stack env already
   sets ENGINE_ACCESS_SECRET).
5. **Scenario 1 re-run** via leg-a harness (real GatewayLogin UI +
   real xlsx upload, browser 1; join via #file= in browser 2),
   asserting FIRST the boot stamp (`data-icecream-engine-access=
   signed`) and capturing the request log: REQUIRED observations —
   `POST /api/engine/open` 200; load goes to
   `{engineUrl}/load/stream` DIRECT (zero `/api/engine/load*` calls);
   workbook renders; total /api/engine/* proxied read/sheets calls
   from boot ≈ 0; bob joins the SAME sessionId (registry read-back).
   Also re-run Worker F's `build/worker-f/repro.mjs` (one-op proof)
   against this dist.
6. Leg (a) scenarios 2–11 with the on-disk harnesses (s03–s07 exist;
   s08–s11 + regression sanity still to be written, per leg-a
   results.md), evidence per the BRIEF (screenshots per browser,
   registry reads, traffic captures, parse-back diffs).
7. Leg (b): rebuild the desktop staging bundle/AppImage FROM THE
   FIXED DIST (Worker C's staging pattern; the old AppImage predates
   Fixes 1–3 and Worker F's fixes are in the same dist), then the
   packaged-desktop + browser run.
8. Perf gate (Phase 1 numbers must not regress: TTFP P50 0.305 s /
   P75 0.348 s / P95 2.93 s; tour saves P50 1,742 ms / P75 2,109 ms).
9. Consolidated suites last (baseline 4,746 passed / 0 failed +
   Phase 2's new tests). Update progress.md / TODO.md /
   perf-evaluation.md addendum; parent pushes (coordinators never
   push).

## Per-item verdicts

| Item | Implemented | Validated |
|---|---|---|
| Fix 1 direct post-handshake load | YES (collabTransport + remoteEngine + App mint-fresh) | NOT RUN (freeze) |
| Fix 2 claim hygiene | YES (releaseOpenedSession + App release/switch/abort) | NOT RUN (freeze) |
| Fix 3 storm gate + breaker | YES (host gate + view breaker) | Unit proofs WRITTEN, NOT RUN |
| Fix 4 dist guard | YES (script + verify + runtime stamp) | Proof re-run NOT RUN (freeze) |
| §10 leg (a) S1 re-run, S2–11 | — | NOT RUN (freeze) |
| §10 leg (b), perf gate, consolidated suites | — | NOT RUN (freeze) |
