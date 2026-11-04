# DEPLOY FOLLOW-UP — icecream-sheets (2026-10-22)

Coordinator record for the six-leg follow-up program (brief:
hidden_files/deploy-followup/BRIEF.md). Source context:
hidden_files/deploy-run/REPORT.md FINAL STATE section (~11:00 PDT):
first deploy LIVE + core verified; legs (c) parse-back, (d)/(f) MCP,
(e) Vertex/service-family, Pro promotion, final hosting bundle +
browser legs left open; deployer NOT parked (11 roles + key kept).

## Deployed state at program start (from deploy-run FINAL REPORT)
- gateway: https://icecream-sheet-gateway-7uydfzbt2a-uc.a.run.app — gateway@sha256:1d68ed50…; /health 200.
- engine-standard: https://icecream-sheet-engine-standard-7uydfzbt2a-uc.a.run.app — engine@sha256:e616c7b1…, rev 00007-s7n (DEPLOY_EPOCH bump), signed mode, UPLOAD_STORE=prod, TRIGGER_STORE=prod.
- engine-xl: same engine digest.
- service: https://icecream-sheet-service-7uydfzbt2a-uc.a.run.app — service@sha256:2179b194… (Node 24); invoker = gateway SA only.
- mcp: https://icecream-sheet-mcp-7uydfzbt2a-uc.a.run.app — mcp@sha256:1157d580…, MCP_STORE=prod.
- Hosting: DEFAULT site icecream-sheets, release 1792686480587000 (2026-10-22T16:28:00Z) — validated landing + Google-only gate; PREDATES direct-signin fix + workspace redesign.
- Test user: icecream-deploy-test@example.com, uid fh5FTJ3fylMZ3GbGwiiWVVUcUSk2.
- Registry wiring: NO FILE_REGISTRY_STORE / SESSION_STORE / USER_STORE anywhere (local stores). FILE_REGISTRY_STORE=prod stays UNWIRED (F-5).
- Temporary roles/logging.viewer on deployer: REMOVED (11 baseline roles confirmed by first run).

## Leg status
- [x] Leg 1 — service-family ID token (gateway proxy) + gateway redeploy + Vertex/meta re-smoke: PASS (see LEG 1 section below).
- [x] Leg 2 — USER_STORE=prod wiring + gateway redeploy + Pro promotion proof: PASS (with a deployed IAM root-cause fix — see Leg 2 verdict detail at file end).
- [x] Leg 3 — MCP legs: unauth 401, authed tools/list, live-Firestore durable (save -> read back): PASS (see LEG 3 section below).
- [ ] Leg 4 — download parse-back via REAL browser client flow (open, edit, autosave, download, parse-back): NOT RUN — requires an eligible live-browser delegation (see 2026-10-22 post-compaction checkpoint below).
- [ ] Leg 5 — final hosting bundle + browser legs: BUNDLE BUILT + HOSTING REDEPLOYED (release 1792698603538000, from the pre-fix tree); browser legs NOT COMPLETED — requires an eligible live-browser delegation; hosting rebuild/redeploy ON HOLD per parent (2026-10-22 13:13 PDT) until the hosted-UX fix batch lands in the tree + is pushed (see Successor final state).
- [x] Leg 6 — SSE disconnect reaping tree fix (/deltas, /load/stream) + regression test + engine redeploys: PASS on the brief's criteria (tree fix + 5/5 new regression suite + 94/94 related + both engine services on engine:followup1). The worker's optional post-deploy killed-client spot-check was not run; it was a suggestion in leg6/REPORT.md, not a brief requirement.
- [x] Leg 7 — Vertex model bump redeploy (service:followup1, rev 00005-z6m): PASS on its stated criteria (rebuild + redeploy + /api/agent/message smoke on gemini-3.1-flash-lite via the global-endpoint deployed config, with control); us-central1 confirmed 404 for the model; native app-gen/STT location residual recorded (see LEG 7 section).
- [ ] PARK — NOT DONE: legs 4 and 5 incomplete. Deployer still holds 11 baseline roles + temporary roles/logging.viewer; key still exists.

## Log
- 2026-10-22 ~11:0x PDT: program started; brief + deploy-run FINAL REPORT read; this checkpoint written FIRST per restart-survival protocol.
- Leg 3 preliminary probe (coordinator, ~11:1x PDT): deployed MCP /health -> 200 {"ok":true,"service":"mcp-server"}. Unauthenticated POST /mcp (initialize) -> TIMED OUT after 30 s with 0 bytes received (reproduces the first run's observation: NOT a clean 401). Diagnosis owed in leg 3: why an unauthenticated initialize hangs instead of 401ing (runner-config requireAuth path vs streamable transport behavior). Authenticated leg still needs the icecream-mcp-auth-secret read (approval card).
- Workers dispatched in parallel: leg 6 (SSE reaping, faf4a0e7), leg 1 (gateway ID token, 5f8e8ec2), leg 2 (USER_STORE=prod, c4a54194) — code + tests only; coordinator rebuilds/redeploys.
- Leg 5 dependency check: direct-signin REPORT records "Validation (a) — PRODUCTION flavor: PASS" with a screenshot sequence (one click -> Google popup, no dialog). Workspace-redesign REPORT records suites green + tsc clean + browser tour. Both UI programs LANDED -> leg 5 unblocked (final verdict lines to be re-verified at leg-5 time).
- Leg 5 update (parent, ~11:58 PDT): Workspace redesign LANDED (tour 28/28, web suite 1,934/1,934, pushed 734a1580). Leg 5 now waits ONLY on the direct-signin fix. Side finding from the redesign tour: a production CORS bug (gateway applyCors lacked PATCH, breaking browser rename cross-origin) was found + fixed + pushed — it rides this program's gateway rebuild (legs 1+2) automatically.
- Leg 3 diagnosis step: roles/logging.viewer TEMPORARILY re-granted to the deployer SA (etag BwZecnDTtm4=) to read MCP request/container logs — MUST be removed before the park step (park-deployer.sh strips only the 11 listed roles). First log read at +45 s still PERMISSION_DENIED (IAM propagation); retry pending.
- Leg 3 log access: roles/logging.viewer grant applied at project level, but gcloud logging read still PERMISSION_DENIED at +3 min (propagation or log-view scoping); retry later. Interim diagnosis (evidence-based): deployed MCP answers GET instantly on a warm instance while EVERY POST (even POST /nope, a 3-line synchronous 404 path in src/http.ts) hangs >60 s with 0 bytes — impossible for the current tree's listener code. The mcp:firstdeploy-sec image was built ~05:4x PDT from a snapshot taken while parallel workers were mid-edit in packages/mcp-server (the gateway build that morning failed for exactly that reason). Working hypothesis: stale/half-edited image vintage. ACTION: rebuild mcp:followup1 from the current tree + redeploy; if POSTs answer, leg 3 proceeds (local HTTP auth matrix already proven against this code).
- Gateway yaml: coordinator added CONNECTOR_URL + AUTOMATION_URL (= ${SERVICE_URL}) closing leg 1's residual (they previously fell back to 127.0.0.1:8108 in-container).
- Builds launched: gateway:followup1 + engine:followup1 from a refreshed snapshot (leg1+leg2+leg6 code + CORS PATCH fix verified present in the snapshot).
- **LEG 3 DIAGNOSIS CLOSED — the deployed MCP was never broken.** Cloud Run REQUEST logs (logging.viewer now propagating) show my POST /nope recorded as 404 completed in 0.0018 s at the platform. Re-probed with Node fetch through the same egress proxy (curl was the broken probe path — its POSTs to this host stall in the sandbox proxy; the first run recorded the same artifact as "timed out at transport level"):
  - POST /nope -> HTTP 404 in 1.6 s {"ok":false,"error":"not found"}.
  - **POST /mcp unauthenticated initialize -> HTTP 401 in 452 ms, body {"jsonrpc":"2.0","error":{"code":-32000,"message":"missing or invalid Bearer <redacted>"},"id":null} — LEG 3 UNAUTH SUB-LEG: PASS (deployed, live).**
  - Control: POST gateway /auth/login -> 404 in 11.8 s (cold start) as expected.
  The mcp:followup1 rebuild (launched on the stale-vintage hypothesis) is NOT needed for this leg; it still earns its redeploy on currency (the deployed image predates the MCP skill packs + later fixes).
  Remaining leg 3: authenticated tools/list + live-Firestore durable leg (save via deployed MCP -> redeploy mcp:followup1 -> read back in a fresh session = durability across instances).
- Leg 3 authenticated sub-legs (deployed MCP, current image): initialize with a minted Bearer JWT (HS256, sub=deploy-followup, secret from Secret Manager, in-memory only) -> 200, serverInfo icecream-sheets 0.1.0; tools/list -> 200, 39 tools (list_skill_packs ABSENT — confirms the deployed image predates the skill packs); memory_save {key: deploy-followup-leg3, value: {marker, 4027.86}} -> 200 {"ok":true,"saved":true}. The durable proof completes AFTER the mcp:followup1 redeploy: fresh-session memory_load must HIT (Firestore persistence across instances) and tools/list should gain the packs tool.

## LEG 1 — service-family identity: PASS (2026-10-22 ~12:1x PDT)
- Tree fix (worker 5f8e8ec2): packages/gateway/src/serviceIdToken.ts (metadata-server ID-token provider, per-audience cache, fail-soft null locally) wired into gateway.ts proxy() for the service-family prefixes only (/api/vault|meta|etl|agent|addons|connectors|automation); engines never receive it; automation owner-routes to engines explicitly excluded; end-user identity preserved via x-principal (Authorization is replaced ONLY in the platform slot). Tests: serviceIdToken 8/8, related 63/63, tsc clean (full gateway suite 444/445 with one pre-existing unrelated HITL failure).
- Coordinator deploy-config fix: gateway.yaml gained CONNECTOR_URL + AUTOMATION_URL = ${SERVICE_URL} (leg-1 residual).
- DEPLOYED PROOF (gateway rev 00005-bx9, image gateway:followup1 sha256:b7e6f7a0…):
  - POST /api/agent/message with a fresh user's gateway JWT -> HTTP 200 with service JSON (threadId, audit with the correct principal) — the Cloud Run platform 401 is GONE.
  - Second/third family probes -> service-generated JSON: GET /api/agent/config 200; GET /api/etl and /api/vault bare -> service JSON 404s (reachable; bare prefix is not a route).
  - VERTEX SMOKE: per-user config posted exactly as the product settings flow does (provider openai-compatible, apiKey in the vault) -> POST /api/agent/message -> 200 in 1049 ms with a genuine model answer ("The SUM function adds up all the numbers in a specified range of cells.").
  - MODEL FINDING (important): gemini-2.5-flash-lite is NO LONGER SERVED to this project — native + OpenAI-compat calls 404 "publisher model not found" in us-central1 AND global (it answered this morning; Google's reported 2.5-family retirement has landed for dreamscapes-zero). gemini-3.1-flash-lite answers 200 via the GLOBAL endpoint (used for the smoke above); gemini-2.5-flash also answers in us-central1. FOLLOW-UP FOR THE PARENT/TREE OWNERS: bump VERTEX_DEFAULT_MODEL (packages/service/src/artifacts/llm.ts — the user's pre-authorized fallback) from gemini-2.5-flash-lite to gemini-3.1-flash-lite (global location), and audit the other 2.5-flash-lite call sites (STT default VERTEX_STT_MODEL usage in agentSvc; app-generation backend) — the deployed agent/app-gen/STT defaults still name the retired model.
  - Design note (not a leg failure): the agent per-user model config + vault in agentSvc are in-memory per service instance (configPersistence/vault use memoryPersistence); on a multi-instance service a config posted to one instance is invisible to another. The smoke passed first-attempt, but this is the same family of deployed-posture gap as USER_STORE and should get the durable-store treatment as a follow-up.

## LEG 3 — MCP legs: PASS (2026-10-22 ~12:0x PDT)
- Unauthenticated POST /mcp initialize -> HTTP 401 with the JSON-RPC error body (deployed, live). The first run's "transport timeout" and my initial curl probes were a PROBE artifact (curl POSTs stall in this sandbox's egress proxy; platform request logs show the service answering 404 in 0.0018 s, and Node fetch through the same proxy gets instant responses). The deployed MCP was never broken.
- Authenticated (minted HS256 Bearer, sub=deploy-followup): initialize -> 200 (icecream-sheets 0.1.0); tools/list -> 200, 39 core tools.
- LIVE-FIRESTORE DURABLE LEG: memory_save {deploy-followup-leg3: {marker, 4027.86}} on the OLD image -> mcp redeployed to followup1 (rev 00004-f7q, new instances) -> fresh-session memory_load -> HIT, exact value returned. MCP_STORE=prod durability across instances PROVEN.


## Leg 2 — verdict detail (coordinator, 2026-10-22 ~13:0x PDT)
- Code (worker c4a54194; record leg2/REPORT.md): USER_STORE=prod fail-closed
  wiring in bin/gateway.ts + prod tier/file-catalog/settings stores over one
  Firestore client (createProdUserStores in deploy/userStore.ts); set-tier
  CLI gained a prod branch; deploy/services/gateway.yaml gains USER_STORE=prod
  (GCP_PROJECT_ID already present). F-5 scope-explicit: the tier adapter IS
  non-transactional read-check-set — ACCEPTABLE for tiers (no ownership
  invariant; atomic per-doc sets; benign last-writer-wins); FILE_REGISTRY_STORE
  untouched.
- PROMOTION EXECUTED against the deployed store:
  set-tier --email icecream-deploy-test@example.com --tier pro wrote
  icecream_user_tiers/pending:icecream-deploy-test@example.com {tier:"pro"}
  (verified by direct Firestore REST read, createTime 2026-10-22T19:32:15Z).
- FIRST PROOF ATTEMPT FAILED — and it was a REAL production defect: a
  controlled fresh user (pending written BEFORE first exchange) exchanged
  and got tier "default"; no record written; pending not consumed.
  ROOT CAUSE: gateway runtime SA icecream-gateway@dreamscapes-zero was the
  ONLY icecream runtime SA without roles/datastore.user on the project
  (engine/mcp/service/compute-default all hold it). Every gateway Firestore
  op threw PERMISSION_DENIED; resolveTierFor's catch degrades to 'default'.
  Deploy #1 had granted this SA bucket objectAdmin but never the datastore
  role. CONSEQUENCE WINDOW: from the followup1 gateway redeploy (19:17Z)
  until the grant, ALL production gateway Firestore stores (tier, catalog,
  settings, shares) were failing for real users.
- FIX: roles/datastore.user granted to icecream-gateway@ via the deployer's
  projectIamAdmin role (mirrors deploy #1's bucket-grant pattern).
- REPROOF (after IAM propagation): controlled user exchange -> JWT
  attrs.tier="pro"; pending doc consumed (re-read 404); record persisted;
  GET /api/files -> 200 {tier:"pro", fileLimit:null} on the Firestore
  catalog. The test user's pending pro promotion sits verified in the
  deployed store and is consumed at their next genuine sign-in; the literal
  same-user exchange is impossible from this environment (password
  unrecoverable: identitytoolkit accounts:update -> INSUFFICIENT_PERMISSION
  for the deployer SA; deployer-signed custom token -> CREDENTIAL_MISMATCH —
  the same wall deploy #1 recorded). LEG 2: PASS.

## Post-compaction checkpoint — 2026-10-22 ~13:0x PDT
- Live Cloud Run state re-verified after context compaction: gateway `icecream-sheet-gateway-00005-bx9` on `gateway:followup1` (100% traffic); engine-standard `icecream-sheet-engine-standard-00008-4xq` and engine-xl `icecream-sheet-engine-xl-00006-92j`, both on `engine:followup1` (100%); MCP `icecream-sheet-mcp-00004-f7q` on `mcp:followup1` (100%); service unchanged on the Node 24 image.
- Leg 5 bundle/hosting portion completed: the production bundle was rebuilt from the current tree with the production gateway URL and the final landing + Workspace redesign + direct-signin changes, then deployed to the DEFAULT Firebase Hosting site. Firebase Hosting API now lists latest release `sites/icecream-sheets/releases/1792698603538000`, releaseTime `2026-10-22T19:50:03.538Z`, version `sites/icecream-sheets/versions/63cb6818891d4566`.
- Public text fetches of both https://icecream-sheets.web.app and https://office.deb0.com return the new landing content. That verifies hosting reachability/content only; it is NOT a browser-leg pass (no click, popup, sign-in, Workspace, Settings, or download evidence).
- A pre-compaction local headless attempt produced a blank screenshot / empty DOM and timed out waiting for the “Sign in with Google” text. That is recorded as an environment/harness failure, not a product verdict. The coordinator subagent cannot operate a live browser; legs 4 and the interactive portions of leg 5 must be completed by an eligible parent/root browser delegation under the exact conditions in the final coordinator report.
- PARK NOT DONE: legs 4 and 5 are incomplete. The deployer still has its 11 baseline roles PLUS temporary `roles/logging.viewer` (12 roles total in the live policy), and the deployer key still exists. Do not park until every leg passes; remove `roles/logging.viewer` before running `deploy/park-deployer.sh` if/when the program reaches that point.


## Successor coordinator checkpoint — 2026-10-22 ~13:1x PDT
- Successor coordinator (the previous coordinator agent is gone) taking over legs 4, 5 (browser portions), 7, and the park decision. State inherited from this report, verified against the file: legs 1, 2, 3, 6 PASS; leg 5 bundle built + hosting redeployed (release 1792698603538000) but its browser legs NOT completed; leg 4 NOT RUN. Both leg 4 and the interactive portions of leg 5 require driving a live signed-in browser — a generic subagent cannot operate the live browser, so those legs will be returned to the parent with exact verification conditions rather than claimed. Leg 7 (Vertex model bump redeploy) is API/CLI work and proceeds now.
- PARK precondition re-checked: park is FORBIDDEN until legs 4, 5, and 7 all PASS. Legs 4/5 cannot pass from this agent; expect NO park this run unless the parent completes the browser legs first. Deployer currently holds 11 baseline roles + temporary roles/logging.viewer; key still exists.

- 2026-10-22 ~13:1x PDT (successor): parent instruction — leg 5 hosting rebuild/redeploy is ON HOLD (the user live-tested the hosted app and reported four defects: grid shows a sign-in button after sign-in, agent chat composer unusable + chat ignores themes, Settings email blank after login; a fix worker is landing corrections — record hidden_files/hosted-ux-fixes/REPORT.md). When the parent confirms the fix batch is in the tree + pushed, leg 5 = rebuild hosting from the refreshed tree + run the leg-5 browser legs as acceptance proof. Legs 4 and 7 proceed now.
- LEG 7 location question ANSWERED by direct Vertex probe with the deployer SA token (Node fetch; curl through the sandbox proxy returns a spurious 401): gemini-3.1-flash-lite in **us-central1 -> HTTP 404** "Publisher model ... was not found or your project does not have access to it"; on the **global endpoint (aiplatform.googleapis.com) -> HTTP 200** with a real completion. So the model serves ONLY globally for dreamscapes-zero. Also probed: the code's URL template `https://{location}-aiplatform.googleapis.com/...` with location=global hits global-aiplatform.googleapis.com, which returns a generic Google 404 HTML page — the template cannot address the global endpoint. Code audit: VERTEX_DEFAULT_LOCATION is a compiled constant ('us-central1', llm.ts:57) consumed at agentSvc.ts:324 (app generator) and as the transcribe.ts default; there is NO env-var location override anywhere in the tree (the only Vertex env seam is VERTEX_STT_MODEL for the STT model id). Consequence recorded for the parent: the chat-agent path CAN be pointed at the global endpoint through the deployed per-user model config (baseUrl + model — the same deployed-config mechanism leg 1's accepted smoke used, and what the leg-7 smoke below uses); the NATIVE Vertex paths (app generation via VertexAiCodeGenBackend, dictation via VertexTranscriber) remain pinned to us-central1 and will 404 on 3.1-flash-lite until a tree fix lands (special-case the global host in the URL builders + a location env seam). Tree default NOT changed, per instructions.
- LEG 7 build: deploy-snapshot refreshed from the current tree (packages/, deploy/, root package files; node_modules excluded) and the refreshed snapshot verified to carry VERTEX_DEFAULT_MODEL = 'gemini-3.1-flash-lite' (llm.ts:56) and VERTEX_STT_MODEL = 'gemini-3.1-flash-lite' (transcribe.ts:26). Cloud Build submitted for service:followup1 (build id 5a937901-f33b-4fa1-af84-5b777ce6e432) from the snapshot context with deploy/Dockerfile.service.

## LEG 7 — Vertex model bump redeploy: PASS on its stated criteria (2026-10-22 ~13:2x PDT), with a named native-path residual
- BUILD: Cloud Build 5a937901-f33b-4fa1-af84-5b777ce6e432 SUCCESS — service:followup1 from deploy/Dockerfile.service over the refreshed snapshot (constants verified in the build inputs: VERTEX_DEFAULT_MODEL and VERTEX_STT_MODEL both 'gemini-3.1-flash-lite').
- REDEPLOY: `gcloud run services update --image` (image-only; env/SA/scaling preserved byte-for-byte against the pre-update revision capture). New revision icecream-sheet-service-00005-z6m serving 100%, image service@sha256:d421ceecc3ccea290aa1144d02ca2bd4bfa7571132eaf9f6f571c004ab417275 (was sha256:2179b194…).
- LOCATION VERDICT (explicit, direct-probed): gemini-3.1-flash-lite does NOT serve in us-central1 for dreamscapes-zero (HTTP 404 publisher-model-not-found); it serves on the GLOBAL endpoint (HTTP 200). The global location override was applied in the deployed config — the agent's per-user model config (provider openai-compatible; baseUrl https://aiplatform.googleapis.com/v1/projects/dreamscapes-zero/locations/global/endpoints/openapi; model google/gemini-3.1-flash-lite — the endpoint requires the publisher-qualified form; the bare id returns 400 "Malformed publisher model"). Tree default NOT changed.
- VERTEX SMOKE (the leg's criterion — POST /api/agent/message with a fresh gateway JWT, through the redeployed service): fresh Firebase user (signUp -> /auth/firebase -> gateway JWT) -> config POST 200 (describe confirms provider/baseUrl/model, hasKey true) -> message "What does the SUM function do?" -> HTTP 200 in 1101 ms with a genuine model answer: "The SUM function adds all the numbers in a range of cells. For example, =SUM(A1:A5) calculates the total of the values in cells A1 through A5." Audit shows a clean user_message -> agent_message pair.
- CONTROL (same user, same instance): model set to google/gemini-does-not-exist-xyz -> reply degrades to the busy message and the audit logs "planner call failed (openai-compatible backend...)"; model restored to google/gemini-3.1-flash-lite -> genuine answer again, no failure entries. The turn is provably served by the configured model, not the heuristic fallback.
- NATIVE-PATH RESIDUAL (behaviorally confirmed, for the parent/tree owners): POST /api/agent/transcribe through the deployed stack -> HTTP 502 "Vertex AI error 404: Publisher model `projects/dreamscapes-zero/locations/us-central1/publishers/google/models/gemini-3.1-flash-lite` was not found". Two facts in one probe: (a) the redeployed image IS live on the native path — the error names gemini-3.1-flash-lite, where the old image named 2.5-flash-lite; (b) the native Vertex paths (dictation via VertexTranscriber, app generation via VertexAiCodeGenBackend at agentSvc.ts:324) are pinned to the compiled-in us-central1 location and will keep 404ing until a tree fix lands (env location seam + special-casing the global host, since the `https://{location}-aiplatform.googleapis.com` template cannot address aiplatform.googleapis.com). NOT fixed here: the instructions for this leg forbid changing the tree default and scope the remedy to the deployed config, which has no location seam for these paths.

## Successor final state — 2026-10-22 ~13:2x PDT
- Legs 1, 2, 3, 6: PASS (unchanged). Leg 7: PASS per above (native-path location residual recorded).
- Leg 4: NOT RUN. It requires driving the hosted app in a real signed-in browser (open -> edit -> autosave -> download -> parse-back). A generic subagent cannot operate the live browser; the exact delegation conditions are in the successor's final message to the parent. The predecessor's local headless attempt failed on the environment (blank DOM) and is not evidence either way.
- Leg 5: hosting bundle built + redeployed earlier (release 1792698603538000) from the pre-fix tree; interactive browser legs NOT COMPLETED; and per the parent's 13:13 PDT instruction the hosting rebuild/redeploy is now ON HOLD until the hosted-UX fix batch (hidden_files/hosted-ux-fixes/) is confirmed in the tree + pushed — then leg 5 = rebuild from the refreshed tree + the browser legs as acceptance proof (which will also cover the four user-reported defects: post-sign-in grid login button / session-restore race, agent chat composer + theming, Settings email display).
- PARK: NOT DONE — correctly. Legs 4 and 5 are incomplete, so the park precondition (all legs PASS) is not met. Live state: the deployer SA still holds its 11 baseline roles PLUS temporary roles/logging.viewer (12 total), and the deployer key still exists. When the program eventually reaches the park: remove roles/logging.viewer first (park-deployer.sh strips only the 11 baseline roles), then run park-deployer.sh with DELETE_KEY=1 and verify zero roles from the live policy.
