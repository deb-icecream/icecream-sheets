# FINAL WEB DEPLOY PASS — icecream-sheets (2026-10-22 evening PDT)

Directive: WEB DEPLOYMENT ONLY (user, 2026-10-22 19:53 PDT). Desktop out of scope; issues #28/#29/#30 do NOT gate this pass.
Deployed state: GitHub main head 221a474e (hosted-UX D1-D9 + upload grant, vertex wiring ee210c3f, security Highs 52146278, sweep fixes #16/#19/#20/#22/#23, follow-ups #17/#21, prompt box #25, ribbon #24, rehydrate #26, timelines TZ fix). Engine concurrency 80 already LIVE (engine-standard-00009-962 / engine-xl-00007-rlt) — must not regress.

## Checkpoint log
- (start) REPORT.md created. TMPDIR=~/workspace/tmp-deploy for all work. Next: read deploy/CONFIG.md + hidden_files/deploy-followup/REPORT.md.

## Pre-state (live, captured before any change)
- gateway: rev icecream-sheet-gateway-00005-bx9 (image gateway:followup1), concurrency 80
- engine-standard: rev icecream-sheet-engine-standard-00009-962 (engine:followup1), concurrency 80 (the live concurrency fix — must not regress)
- engine-xl: rev icecream-sheet-engine-xl-00007-rlt (engine:followup1), concurrency 80
- service: rev icecream-sheet-service-00005-z6m (service:followup1), concurrency 20
- mcp: rev icecream-sheet-mcp-00004-f7q (mcp:followup1) — untouched this pass
- Hosting: release 1792698603538000 (2026-10-22T19:50:03Z) — built from the PRE-FIX tree; to be replaced.
- Deployer: 11 baseline roles + temporary roles/logging.viewer (12); key exists.

## Build inputs verified
- Deploy snapshot refreshed from the current tree (~/workspace/deploy-snapshot: packages/, deploy/, root manifests; node_modules/dist excluded).
- Fix markers present in snapshot: llm.ts vertexAiHost (3 hits), agentSvc.ts createVertexDefaultBackend (:395), engineSvc.ts lastBuildError=null at registerSession (:2894) + rehydrateSession (:3497) [#26 fix], App.tsx directSignIn (:9242) in the repo tree for the web build.
- Deploy approach for Cloud Run (leg-7 pattern): build new images, then `gcloud run services update --image` per service — preserves env/SA/scaling/concurrency byte-for-byte. Tree engine YAMLs also carry containerConcurrency: 80 (consistent with live).
- New image tag this pass: `final1`.

## Builds
- NOTE: `gcloud builds submit` exits 1 locally on ALL builds — a log-streaming permission artifact only ("This tool can only stream logs if you are Viewer/Owner of the project"); the builds themselves run server-side and are verified via `gcloud builds describe`.
- service:final1 — Cloud Build a565821a-ba3d-4379-bfa3-b2ac7516e958 — **SUCCESS**.
- engine:final1 — Cloud Build f995d065-bed2-4659-9aac-4748cc9fae63 — **SUCCESS**.
- gateway:final1 — Cloud Build bd1b6aaf-8b38-477c-b18e-5afa54c08527 — (pending at this checkpoint).
- Web bundle — deploy/build-web.sh exit 0; apps/web/dist rebuilt (index-DYcpWeIZ.js), gateway URL https://icecream-sheet-gateway-7uydfzbt2a-uc.a.run.app inlined, "Sign in with Google" present. Dev-login gating verified in source: isDevLoginEnabled = import.meta.env.DEV || isLocalhostGateway(baseUrl) — DEV is statically false in the production build and the baked gateway URL is not localhost, so the dev form cannot render from this bundle.

## Redeploys (image-only updates — env/SA/scaling/concurrency preserved)
- engine-standard: 00009-962 -> **icecream-sheet-engine-standard-00010-48g** (engine:final1), 100% traffic, containerConcurrency **80 preserved**.
- engine-xl: 00007-rlt -> **icecream-sheet-engine-xl-00008-97l** (engine:final1), 100%, concurrency **80 preserved**.
- service: 00005-z6m -> **icecream-sheet-service-00006-2sc** (service:final1), 100%, concurrency 20.
- gateway: 00005-bx9 -> **icecream-sheet-gateway-00006-k4j** (gateway:final1), 100%, concurrency 80.
- mcp: unchanged (00004-f7q), per brief.

## Post-deploy smokes (new revisions)
- gateway /health -> 200 {"ok":true,"service":"gateway", routes incl. /api/agent + /api/automation}.
- engine-standard /health -> 200 {"ok":true,"service":"engine"} (new engine image live).
- gateway /api/agent/config unauth -> 401 (auth enforced through the new gateway + service chain).
- MCP POST /mcp unauthenticated initialize -> **401** {"code":-32000,"message":"missing or invalid Bearer"} — MCP untouched and healthy.
- gateway POST /auth/login -> 404 (production posture: no password/dev login endpoint).

## Hosting
- Deployed via the proven REST path (hidden_files/deploy-run/hosting_deploy.py, deployer token).
- New version sites/icecream-sheets/versions/5190929756516450; **release 1792724955149000** (2026-10-23T03:09:15Z) — supersedes 1792698603538000 (pre-fix bundle).
- Domain check: BOTH https://icecream-sheets.web.app and https://office.deb0.com serve index.html referencing assets/index-DYcpWeIZ.js — byte-identical reference to the just-built dist; asset fetches 200 (4,508,583 bytes) on both.

## Image digests (tag final1)
- gateway: sha256:23cb0048a051587578f9f15a8a42dcc1fa711c644576712c62c715b3dd9eb1eb
- engine: sha256:846e00cf812d818765d7d212d58c19ec4a1040077e2d4a11e05d75eb6affb2fd
- service: sha256:deb15be5658c6560191bf1675fb8d87cb73fe2b473c8a62c9ec027eb14c14500

## LEG 5 — hosting redeploy DONE; browser legs NOT COMPLETED from this VM (environment wall)
- DONE: bundle rebuilt from the current tree (fixes included: directSignIn, hosted-UX batch, ribbon #24, prompt box #25) and deployed — release 1792724955149000; both domains verified serving the new bundle (see Hosting section).
- Browser legs (a)/(b)/(c) NOT run to completion here. Harness evidence (4 configurations, all identical): Chrome Headless Shell on this VM cannot establish a proxied tunnel to the live domains — net::ERR_TUNNEL_CONNECTION_FAILED via the runtime egress proxy (hostname form, credential-split form, resolved-IP form, and via a local preemptive-auth CONNECT forwarder), while curl/Node/Python traverse the same proxy successfully. This is the SAME environment wall the deploy-followup program recorded (its headless attempt: blank DOM / timeout). A generic subagent also cannot operate the parent's live browser.
- (b)/(c) additionally need a completed Google sign-in; the only test account's password is unrecoverable (established in deploy-followup leg 2), so those legs are the owner's retest by design.
- EXACT CONDITIONS FOR THE PARENT'S LIVE-BROWSER DELEGATION (both domains: https://icecream-sheets.web.app and https://office.deb0.com):
  (a) Signed-out: click "Sign in with Google" ONCE -> must go DIRECTLY to Google (accounts.google.com / Firebase auth handler -> Google) with NO intermediate in-app dialog; also confirm NO dev/name-entry form renders anywhere on the gate.
  (b) After the owner signs in: the grid must show NO sign-in button; the agent panel must be present, docked right (grid shrinks), themed in both light and dark; the composer usable.
  (c) Workspace must load signed-in with no split state; Settings must show the account email read-only AND disabled.
  If (a)-(c) pass on both domains, leg 5 PASSES and issue #1 can close.

## LEG 4 — owner-retest-pending (staged)
- Requires a real signed-in browser session as the file owner (same credential wall as leg 5(b)/(c)) — cannot be established from this VM.
- Staged conditions (from deploy-followup): sign in as owner of file file-d163d4af-8620-4c9f-ba85-90d658eb1652, open sheet "DeployVerify", enter a NEW unique marker in an unused cell (e.g. B2), wait until autosave shows storedRevision == liveRevision, use the app's real Download, parse the downloaded file back and prove the marker is present.

## PARK — NOT EXECUTED (deliberate; deployer left intact)
- The brief's park precondition is not honestly met: legs 4 and 5 are part of this deployment's acceptance and both remain open (environment + owner-credential walls, above). Parking is irreversible (key deletion) and the deploy program's standing rule (deploy-followup record, user Option B) is: park only after EVERY leg passes — if the owner's retest surfaces a defect, a redeploy must still be possible.
- DONE instead (the brief's park-step first action, independently mandated): temporary roles/logging.viewer REMOVED from the deployer SA; live policy re-read verifies the deployer now holds EXACTLY the 11 baseline roles. Key NOT deleted; park-deployer.sh NOT run.
- To finish the program after the owner's legs pass: run deploy/park-deployer.sh with DELETE_KEY=1 + KEY_FILE=~/.config/gcp/deployer-key.json, then verify zero roles from the live policy.

## Regression check
- Engine concurrency: 80 on BOTH engine services after redeploy (no regression of the live fix).
- MCP untouched (rev 00004-f7q) and its post-pass smoke passes (unauth 401).
- No other dreamscapes-zero resources touched; all changes scoped to icecream-sheet-* services + the deployer SA's logging.viewer grant.

## Left for the owner / parent
1. Leg 5 browser legs (a)/(b)/(c) on both domains (conditions above) — the owner's own sign-in is the proof path; passing closes issue #1.
2. Leg 4 download parse-back (conditions above).
3. Park the deployer (one command, above) once 1+2 pass.
4. The hosted blank-sheet edit-sequence retest the owner was asked for earlier can ride along with item 1.
