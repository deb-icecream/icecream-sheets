# Vertex wiring fix — REPORT (checkpointed; append after each landed piece)

Task: production Vertex wiring so the deployed AI features reach
gemini-3.1-flash-lite by default through the service's own GCP identity.
Port block claimed: **9020-9029** (no stack expected to be needed; unit-level work).
Started 2026-10-22 (parent tasking; leg-7 record in hidden_files/deploy-followup/REPORT.md).

## Confirmed facts (read from records + tree before starting)
- Exact OpenAI-compat baseUrl (leg-7 smoke, LIVE-proven 2026-10-22):
  `https://aiplatform.googleapis.com/v1/projects/dreamscapes-zero/locations/global/endpoints/openapi`
  with model `google/gemini-3.1-flash-lite` (publisher-qualified; bare id -> 400
  "Malformed publisher model"). Backend appends `/chat/completions`
  (openaiBackend.ts:324). Sources: deploy-followup/REPORT.md LEG 7 section;
  ~/workspace/tmp-deploy/leg7-smoke.mjs, vertex-oai-probe.mjs, leg7-control.mjs.
- gemini-3.1-flash-lite: us-central1 -> 404 (direct-probed); global -> 200.
- Native URL template `https://{location}-aiplatform.googleapis.com/...`
  cannot address the global host (global-aiplatform.googleapis.com = generic
  Google 404). Resource path keeps `locations/{location}`.
- agentSvc consumers of the constants: app generator passes
  location: VERTEX_DEFAULT_LOCATION explicitly (agentSvc.ts:324);
  dictation constructs VertexTranscriber without a location (:579-587) so the
  constant default applies. Both heal automatically when the constant changes.
- OpenAICompatibleBackend is exported from the service barrel (index.ts:539);
  its plan() calls getApiKey() on EVERY plan call (openaiBackend.ts:293).
- createGcpAccessTokenProvider already imported at agentSvc.ts:91; the lazy
  singleton agentAppTokenProvider() (:313) wraps it for the app generator.
  It fails soft (null) and caches until shortly before expiry — the backend
  never holds a static key; each plan() re-invokes the provider.
- config.ts: defaultAgentSettings() = provider 'heuristic';
  createModelBackend returns HeuristicModelBackend for it. 'heuristic' in a
  stored config means "the shipped default" (no separate explicit-heuristic
  state exists in the config store).

## Plan
A — native paths (packages/service):
  1. llm.ts: add shared `vertexAiHost(location)` helper ('global' ->
     'aiplatform.googleapis.com'; else '{location}-aiplatform.googleapis.com');
     VERTEX_DEFAULT_LOCATION 'us-central1' -> 'global'; generateCode uses the
     helper; doc comments updated (class doc + options doc + retirement note).
  2. transcribe.ts: URL build uses vertexAiHost (imported from './llm.js');
     options doc updated.
  3. artifacts/index.ts: re-export vertexAiHost.
  4. Tests: artifactTranscribe.test.ts — default URL pin -> global form;
     + new explicit-regional (us-central1) pin. artifactLlm.test.ts —
     VERTEX_DEFAULT_LOCATION pinned 'global'; + default-location URL test
     (global host form); existing europe-west1 test stays as the regional pin.
B — planner production default (packages/gateway/src/services/agentSvc.ts):
  1. Import OpenAICompatibleBackend from the service barrel.
  2. `vertexPlannerBaseUrl(project)` (exported): the confirmed global
     OpenAI-compat base URL form.
  3. `createVertexDefaultBackend(deps)` (exported, injectable project /
     tokenProvider / fetchImpl): null when no project id in env
     (GCP_PROJECT_ID / GOOGLE_CLOUD_PROJECT); else OpenAICompatibleBackend
     with model 'google/' + VERTEX_DEFAULT_MODEL and getApiKey that invokes
     the service token provider on every call and throws a clear error if it
     yields null.
  4. `selectBackend(principal, config, vault, vertexDefault)` (exported):
     explicit (non-heuristic) config -> createModelBackend unchanged;
     heuristic default -> vertexDefault when non-null, else createModelBackend
     (heuristic). resolveBackend rewired through it.
  5. New gateway test file: factory URL/model/token-per-call proof (rotating
     fake tokens + fake fetch through plan()); factory null without project;
     selectBackend: explicit config untouched, heuristic+vertex -> vertex,
     heuristic+null -> heuristic.
End: full packages/service + packages/gateway suites + tsc in both packages.
No push, no redeploy (parent coordinates one final deploy pass).

## Log
- (pending)

## A — LANDED (2026-10-22)
- llm.ts: `vertexAiHost(location)` added ('global' -> 'aiplatform.googleapis.com',
  else '{location}-aiplatform.googleapis.com'); VERTEX_DEFAULT_LOCATION now
  'global' with the leg-7 probe rationale in the comment; generateCode builds
  its URL via the helper (path keeps locations/{location}); class + options
  doc comments updated.
- transcribe.ts: URL build uses vertexAiHost (imported from './llm.js');
  options doc updated.
- artifacts/index.ts: vertexAiHost re-exported (flows to the package barrel).
- agentSvc wiring verified: app generator passes VERTEX_DEFAULT_LOCATION
  explicitly (agentSvc.ts:324) and dictation takes the constant default —
  both now resolve to the global host with no code change there.
- Tests (related, run during build): artifactLlm.test.ts 18/18 (new:
  default-location pin incl. vertexAiHost host forms; default-location
  request URL = exact global form; the pre-existing europe-west1 test
  remains the explicit-regional pin), artifactTranscribe.test.ts 8/8
  (default URL pin updated to the exact global form; new explicit
  us-central1 regional-host pin). 26/26 combined.

## B — LANDED (2026-10-22)
- agentSvc.ts: imports OpenAICompatibleBackend + AgentServiceSettings type
  from the service barrel. New exported units:
  - vertexPlannerBaseUrl(project) — the leg-7-proven global OpenAI-compat
    base URL form.
  - createVertexDefaultBackend(deps) — null when no project id (env
    GCP_PROJECT_ID / GOOGLE_CLOUD_PROJECT); else OpenAICompatibleBackend
    { baseUrl: vertexPlannerBaseUrl(project), model: 'google/' +
    VERTEX_DEFAULT_MODEL, getApiKey: invokes the service token provider
    (agentAppTokenProvider -> createGcpAccessTokenProvider) on EVERY call
    and throws a clear error if it yields null; fetchImpl injectable }.
  - selectBackend(principal, config, vault, vertexDefault) — explicit
    (non-heuristic) config -> createModelBackend unchanged; heuristic
    default -> vertexDefault when non-null, else createModelBackend.
  resolveBackend now routes through selectBackend + createVertexDefaultBackend().
- New tests packages/gateway/tests/agentVertexDefault.test.ts: 8/8 —
  baseUrl exact form; factory plan() x2 with rotating fake tokens proves
  URL (…/endpoints/openapi/chat/completions), body model
  google/gemini-3.1-flash-lite, and Bearer tok-1 -> tok-2 (fresh token per
  call, nothing stored); null-token failure message; env project pickup;
  null without GCP identity; selectBackend explicit-wins (user model
  untouched), heuristic+vertex identity, heuristic+null -> heuristic-v1.
- DIST FINDING (local/test surface only): packages/service/dist was STALE —
  it still carried gemini-2.5-flash-lite + us-central1, and the gateway
  resolves @icecream-sheets/service through dist, so the first test run
  saw the retired model. Rebuilt packages/service dist from current src
  (tsc); dist/artifacts/llm.js now carries 3.1-flash-lite + 'global' +
  vertexAiHost. Production images build from src in Docker, so this was
  not a deployed-state issue; recorded so the parent's final pass builds
  gateway AFTER service.

## Final validation (2026-10-22)
- packages/service: tsc clean. Full suite run 1: 1634 passed / 1 skipped /
  1 failed (the failing test's identity was lost to tail truncation).
  Run 2 with output redirected to a file and read back from disk
  (~/workspace/tmp-vw/service-suite.log): 1635 passed / 1 skipped /
  0 failed, exit 0. The run-1 failure did not reproduce and is recorded
  as an unreproduced intermittent, not a pass I can name.
- packages/gateway: tsc clean. Full suite (log at
  ~/workspace/tmp-vw/gateway-suite.log): 47 files, 454 tests —
  453 passed / 1 failed. The one failure is the documented pre-existing
  one: tests/services.test.ts "human-in-the-loop over HTTP: /pending ->
  /answer unblocks the parked turn" (hook timed out in 10000ms under
  load; the same sole failure recorded by the workspace-redesign,
  account-delete-tier, and deploy-followup leg-1 runs today). This
  change does not touch the HITL path: in the test environment (no GCP
  project env) resolveBackend returns the heuristic backend exactly as
  before. New file tests/agentVertexDefault.test.ts: 8/8 inside the run.
- Source sweep: the '{location}-aiplatform' template now exists ONLY
  inside vertexAiHost (llm.ts:77); the planner baseUrl is the single
  constant in vertexPlannerBaseUrl (agentSvc.ts).

## Verdicts
- A (native paths): DONE. Shared vertexAiHost helper used by llm.ts +
  transcribe.ts; VERTEX_DEFAULT_LOCATION = 'global'; app generator and
  dictation inherit it through the constants (verified in code). Pinned
  by tests: exact global URL forms for both native paths + explicit
  regional pins (europe-west1 for codegen, us-central1 for STT).
- B (planner production default): DONE. Heuristic-default users in a
  GCP-identity deployment now get an OpenAICompatibleBackend on the
  leg-7-proven Vertex global OpenAI-compat endpoint with model
  google/gemini-3.1-flash-lite and a per-call fresh service token;
  explicit user configs win unchanged; no GCP identity -> heuristic.
  Proven by unit tests incl. token rotation across two plan() calls.
- NOT done here (by tasking): no push, no redeploy. The live proof of B
  (and of the native global paths) rides the parent's final deploy pass;
  the leg-7 deployed config already proved the endpoint/model pair live,
  and this change makes that pair the code default instead of a
  hand-posted per-user config.
