# Deploy Follow-Up — Brief (from the first-deploy final report, 2026-10-22)

Source: hidden_files/deploy-run/REPORT.md (FINAL REPORT section). The
first deploy is LIVE and its core is verified; this program closes the
legs the final report left open. The deployer SA is deliberately NOT
parked — it keeps its 11 roles + key for this work (park only at the
very end of THIS program, and only if every leg below passes).

## Legs
1. **Service-family identity gap (deploy defect, leg (e) FAIL).**
   /api/agent/message with a valid gateway JWT returns Cloud Run's
   platform 401 HTML: the service's invoker is restricted to the
   gateway SA, but the gateway proxy attaches NO Google ID token (no
   identity code exists in the gateway). The whole service family
   (/api/meta, /api/etl, /api/agent, /api/addons, /api/connectors,
   /api/automation) is unreachable through the gateway. FIX: the
   gateway mints + attaches a Google ID token (audience = the target
   service's URL) on service-family upstreams — the same pattern the
   engine signed-URL flow uses for identity, implemented in the
   gateway's proxy path with metadata-server token fetch + caching.
   Rebuild + redeploy the gateway; then RE-RUN: Vertex smoke
   (/api/agent/message answers via gemini-2.5-flash-lite), plus one
   route from another family (e.g. /api/meta) proving the family is
   reachable.
2. **USER_STORE=prod + Pro promotion (leg: NOT DONE).** No yaml sets
   USER_STORE, so the deployed tier store + file catalog are
   instance-local JSON and bin/set-tier.ts cannot reach them. FIX:
   wire USER_STORE=prod with the Firestore injection (the adapters
   exist: packages/gateway/src/deploy/userStore.ts Firestore shapes;
   pattern from FILE_REGISTRY/SHARE wiring) — note F-5: do NOT wire
   FILE_REGISTRY_STORE=prod (non-transactional claim) — USER_STORE is
   a different store; if its Firestore adapter has the same
   read-check-set shape for tier RECORDS, that is acceptable for
   tiers (no ownership fencing) — say so explicitly in the report.
   Redeploy gateway; promote the deploy test user
   (icecream-deploy-test@example.com) to Pro via bin/set-tier.ts
   against the deployed store and PROVE it (fresh /auth/firebase
   exchange shows the pro tier claim).
3. **MCP legs (d) + (f): NOT VERIFIED / NOT RUN.** /health 200 seen;
   the unauthenticated POST /mcp timed out at transport level (no 401
   observed) and the authenticated leg needs the MCP auth secret read
   (approval cards timed out twice in the parent run — retry; the
   parent is live now). PROVE: unauthenticated -> 401; authenticated
   tools/list answers; the live-Firestore durable leg (save -> read
   back through the deployed MCP with MCP_STORE=prod).
4. **Download parse-back (leg (c) sub-leg FAIL).** The API harness's
   download-grant served the ORIGINAL uploaded object after edits —
   because byte materialization follows the client save/download flow
   (save = signal; download = save-first + signed URL) which the
   harness did not reproduce. PROVE with the REAL client flow: drive
   the hosted web app in a browser (signed-in test user): open the
   uploaded file, edit a cell, wait for autosave (storedRevision ==
   liveRevision), download, parse the downloaded bytes back and show
   the edited value present. If the real flow ALSO serves stale
   bytes, that is a product defect — root-cause and fix it in this
   program, then re-prove.
5. **Final hosting bundle + browser legs.** WAIT for both UI fixes to
   land (direct-signin: hidden_files/direct-signin/REPORT.md;
   workspace redesign: hidden_files/workspace-redesign/REPORT.md).
   Then rebuild the web bundle from the final tree, redeploy hosting
   to the DEFAULT site, and run the production-login browser legs on
   BOTH https://icecream-sheets.web.app and https://office.deb0.com:
   landing -> ONE click on "Sign in with Google" -> Google chooser
   directly (screenshot sequence, NO dialog frame), and a signed-in
   Workspace pass showing the redesigned list view + the Settings
   page with the email disabled (screenshots).
6. **SSE reaping finding (from the 429 post-mortem).** Streaming
   handlers (/deltas, /load/stream) do not reap on client disconnect —
   three stuck streams pinned engine-standard into a full outage.
   This is a TREE fix: disconnect cleanup + heartbeat timeout in the
   engine's streaming handlers, with a regression test (kill a client
   mid-stream; the handler must end). Land it, run related suites,
   and include the rebuilt engine in a redeploy of engine-standard +
   engine-xl. (Coordinate: this is also filed under the security
   fast-follow list; this program owns it because it redeploys the
   engines anyway.)

## End state
- Every leg above PASS with evidence in
  hidden_files/deploy-followup/REPORT.md (checkpoint FIRST and after
  each leg; TMPDIR under ~/workspace; do NOT touch progress.md; no
  git push — the parent pushes the tree fixes).
- ONLY THEN: run deploy/park-deployer.sh with DELETE_KEY=1 (strips
  all 11 roles, verifies zero from the live policy, deletes the key;
  confirm roles/logging.viewer is already gone) and record the park
  verification in the report. If any leg fails, do NOT park — report
  exactly which legs remain and why.
