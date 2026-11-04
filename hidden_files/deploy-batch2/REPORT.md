# DEPLOY PASS 2 — batch2 (live-ux #31–#42 + #40, homepage #45, workflows #46) + prod stores ON

Started: 2026-10-23 ~00:05 PDT (worker session)
Scope: WEB only (owner directive). GCP project dreamscapes-zero / us-central1; Firebase project icecream-sheets (Hosting+Auth only).

## Checkpoint log
- [start] Record created. Next: STEP 0 tree gate — read agent-workflows REPORT.md (merge status), deploy/CONFIG.md, deploy-final record.

## Owner ruling carried by this pass
SESSION_STORE=prod on engine-standard + engine-xl; FILE_REGISTRY_STORE=prod on gateway — ALWAYS ON for hosted, recorded in deploy/services/*.yaml.

## STEP 0 — tree gate (2026-10-23 ~07:03 UTC)
- Agent source files stable since 06:30:40 UTC (replay writes finished; no writes for 33+ min at gate time). #46 REPORT.md documents the merge precisely (types/openaiBackend/config/index = workflow supersets restored; runtime.ts = workflow layer + #40 chatStream re-inserted verbatim, all #40 onEvent sites preserved; agentSvc = #40 base + 4 workflow pieces ported; workflows.ts restored new).
- Verified BY ME on the shared tree (stronger than the worker's note):
  - packages/service: `tsc --noEmit` CLEAN.
  - packages/service agent suites: **164/164 PASS** (agent-workflows 13 + runtime, failures-fix, backends, guardrails, modelconfig, principal-binding, proactive, threads, thread-persistence) — the 2 workflow failures from the collision are gone.
  - packages/gateway: tsc + agent suites — RUNNING (see below).
  - apps/web: tsc + related — PENDING.

## Pre-state (live, captured 07:0x UTC before any change)
- Buckets present: dreamscapes-zero-icecream-{files,snapshots,uploads} ✓ (snapshots bucket = SESSION_SNAPSHOT_BUCKET target).
- engine-standard: rev 00010-48g (engine:final1), concurrency 80, NO SESSION_STORE / SESSION_SNAPSHOT_BUCKET (sessions local today). Engine SA holds roles/datastore.user + roles/storage.objectAdmin (deploy.sh step 4) → prod session store is permission-ready.
- gateway: rev 00006-k4j (gateway:final1), SHARE_STORE=prod, USER_STORE=prod, NO FILE_REGISTRY_STORE (registry local today). Gateway SA holds roles/datastore.user ✓.
- Code facts: engine bin reads SESSION_STORE (sessionStore.ts prodSessionConfig, fail-closed: requires GCP_PROJECT_ID ✓ already set + SESSION_SNAPSHOT_BUCKET). Gateway fileRegistry reads FILE_REGISTRY_STORE (falls back to SESSION_STORE when unset; will set explicitly).

## Pre-deploy gate — ALL GREEN (verified by me on the shared tree)
- service: tsc CLEAN; agent suites **164/164 PASS**.
- gateway: tsc CLEAN; agent suites (binding/charts/thread-persistence/transcribe/vertex-default/artifacts) **56/56 PASS**.
- web: tsc CLEAN; related suites (ribbonParity, builtAppsApi, AddonManagerDialog, AppsGallery, VoiceCommandPalette, voiceCommands, LandingPage, deepLink, Markdown, themes) **103/103 PASS**.

## Config — stores recorded in repo definitions
- deploy/services/engine-standard.yaml + engine-xl.yaml: + SESSION_STORE="prod" + SESSION_SNAPSHOT_BUCKET=${BUCKET_SNAPSHOTS}, with the owner-ruling REQUIRES note.
- deploy/services/gateway.yaml: + FILE_REGISTRY_STORE="prod" with the ruling note; stale "deliberately not wired (F-5)" comment removed.
- deploy/deploy.sh: BUCKET_SNAPSHOTS added to the envsubst export list (else the new yaml var would render empty).
- deploy/CONFIG.md: SESSION_STORE / SESSION_SNAPSHOT_BUCKET (engine table) + FILE_REGISTRY_STORE (gateway table) rows with the ruling.

## Push — DONE, head 74aeb48b
- Pre-push remote head was cdbdd0eb (a periodic checkpoint push landed 07:12 UTC mid-gate — it had already captured the replay + late batch work).
- 24 batches via connector push-files (service 225 files, gateway 259, web 431, deploy 23, design-docs 21, records 4; binaries + dist + node_modules + >900k excluded). 22 landed first try; deploy-0 + gateway-5 raced a moving ref ("not a fast forward") and landed on retry (82a70faa, 74aeb48b).
- Verified: remote blob SHAs == local git hash-object for runtime.ts, workflows.ts, agentSvc.ts, engine-standard.yaml, gateway.yaml, deploy.sh.
- NOT pushed (binaries, connector corrupts them): apps/web/public/product/{agent-work.png, agent-work-960.png, connect-source.png, connect-source-960.png} — OWED via git device-auth route. Hosting deploy serves them from the local tree regardless.

## !!! HOLD — #51 read-only gate (parent directive 2026-10-23 ~00:30 PDT) !!!
- The readonly-verify worker found a REAL hole in the current tree: POST /api/engine/open mints join tokens with a role from the request body / default 'editor', no server-side grant check — every joiner of a live session gets editor; sharing grants never reach the server. Reproduced pre-fix on the UI/op path AND the agent path (hidden_files/readonly-verify/REPORT.md, Phase A).
- ACTION TAKEN: image-build script killed before further submits. Exactly ONE image was submitted pre-hold: gateway:batch2 (Cloud Build d47d0d29, 07:29 UTC, from the PRE-FIX tree) — it is STALE and will be REBUILT under the same tag after the fix; it must not be deployed. Engine/service/mcp batch2 builds were never submitted. NOTHING has been deployed this pass: no Cloud Run updates, no Hosting release.
- RESUME CONDITION: readonly-verify REPORT.md shows the gateway fix landed AND its full acceptance matrix green (viewer writes blocked on all four paths + parse-back clean) + parent all-clear. The fix touches gateway.ts → after it lands I must re-run the gateway gate (tsc + related tests) and re-push the changed gateway files before rebuilding images.

## Status
- STEP 0 tree gate: DONE
- Pre-deploy gate: DONE (all green) — gateway leg to be re-run after the #51 fix
- Push: DONE (head 74aeb48b) — gateway fix files will need a top-up push
- Config (repo definitions): DONE — live application rides the service updates below
- Deploy: ON HOLD (#51 gate) — web-dist prep continues
- Smokes: PENDING
