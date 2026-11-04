# Shell Integration — Report

Coordinator: d86fe7eb (dispatched 2026-10-22 ~00:50 PDT)
Brief: hidden_files/shell-integration/BRIEF.md
Status: COMPLETE (2026-10-22 ~09:1x PDT) — all brief pieces + the
scope-addition join proof are DONE with live evidence below. Three
real defects were found and fixed in scope along the way (sequential-
open 409, gateway-proxied library-save 401 for the share import,
import-page repaint); one pre-existing defect beyond the import's
needs (library-save via the gateway proxy in signed mode, general)
and one agent-lane observation are recorded for the parent to route.

## Scope (from brief)
1. Routing in apps/web/src/main.tsx + App.tsx: landing at root (logged-out),
   post-login home = Workspace, deep link ?file=<id> (logged-out -> login ->
   returned to file; owner-only), ?share=<id> recipient flow (full-screen
   app -> Restore -> working view with own copy). Use EXISTING modules in
   apps/web/src/product/ — do not rebuild them.
2. Workspace Apps mount: AppsGallery into Workspace appsSlot.
3. Dist rebuild via controlled path ONLY (build:local-stack semantics,
   VITE_GATEWAY_URL + VITE_ENGINE_ACCESS_MODE=signed baked,
   scripts/verify-dist.mjs must pass).
4. In-app browser validation on local production-topology stack,
   screenshots self-inspected: landing (desktop + narrow) -> sign-in gate
   -> workspace (recents, file list, CSV marker) -> upload xlsx AND csv via
   integrated UI -> open via deep link -> grid -> download; share link as
   second user -> full-screen app -> Restore -> own copy; logged-out deep
   link -> login -> lands on file.
5. Suites: related web/gateway/product suites green; full web suite if host
   allows (else NOT RUN, stated honestly).

## Hard constraints observed
- Sweep in-flight files NOT to be touched: engineSvc.ts, DownloadDialog.tsx,
  nameServices.ts, useNameServices.ts, engine workbook.ts, service save/*,
  xlsx-adapter streamingSave.ts. Pieces needing one -> BLOCKED-ON-SWEEP.
- No progress.md edits. No git push. No stubs.
- Residual (p)'s App.tsx download-provider registration line must survive.

## Plan
- [x] Step 0: survey current main.tsx / App.tsx / product modules on disk.
- [x] Step 1: routing wiring (landing / workspace / deep link / share).
- [x] Step 2: AppsGallery into Workspace appsSlot.
- [x] Step 3: related suites (web product + App-related, gateway product).
- [x] Step 4: controlled dist build + verify-dist.
- [x] Step 5: browser validation tours on local production-topology stack.
- [x] Step 6: exports/download regression — covered by tour1's grid
  download check (PK, 5,852 B) re-run on the FINAL dist (21/21);
  residual (p)'s provider registration lines verified untouched.

## Verdicts (FINAL)
1. Routing: DONE + PROVEN. Landing at root for bare logged-out visits
   (desktop + narrow screenshots t1-01/t1-02); sign-in gate shown
   DIRECTLY for ?file= and ?share= targets (never the landing page);
   post-login home = Workspace; ?file= deep link opens the grid
   (search form canonical, #file= legacy-read, same-document hash
   changes routed — see join section); logged-out deep link returns
   to the file after login (tour3 6/6). Tours: tour1 21/21 (run on
   the FINAL dist), tour-join 18/18, tour3 6/6.
2. Apps mount: DONE + PROVEN. Workspace home renders AppsGallery in
   appsSlot (screenshot t1-04: Apps section with the gallery's empty
   state; tour2's bob workspace shows the received app context);
   gallery onOpen raises the full-screen ArtifactFrame overlay.
3. Dist build + verify-dist: DONE. Deliverable apps/web/dist built
   via `npm run build:local-stack`; verify-dist OK on the FINAL
   build: "dist bakes gateway=http://localhost:8100 +
   engineAccess=signed (6 JS assets checked)". Gateway dist rebuilt
   from current source (origin change included).
4. Browser validation: DONE. Local production-topology stack
   (isolated: gateway 8510 / engine 8511 / web 5874, signed engine
   access, scratch data), playwright + chrome-headless-shell.
   tour1 21/21 (landing → gate → workspace → xlsx upload → deep-link
   open → engine read-back B1=42/A1=41 → grid download PK 5,852 B →
   home → CSV upload + "Imported from CSV" marker → CSV open as
   workbook, G2=19.98/A2=1001 read-backs). tour2 (share) 11/11.
   tour-join (gateway engagement) 18/18. tour3 6/6. Screenshots in
   hidden_files/shell-integration/shots/, self-inspected (t1-04
   workspace, t2-02 landing, t2-03 restored view, tj-join-search
   painted grid with 41/42 + presence).
5. Suites: collabTransport 39/39 (31 pre-existing + 2 storage-ref
   + 4 unload-release + 2 librarySaveDirect, all new tests mine);
   product (all) + gatewayClient 101/101;
   GridSelectionDefects + collab + engine 34/34; gateway
   productLayer 38/38; web tsc --noEmit CLEAN; gateway tsc --noEmit
   CLEAN (both re-verified 2026-10-22 ~09:2x PDT after all edits).
   FULL WEB SUITE: PASS — 145/145 test files, 1829/1829 tests,
   170 s wall (background run completed 2026-10-22 ~08:53 PDT,
   exit 0; only benign act(...) environment warnings in stderr).
   (An earlier draft of this report said NOT RUN — that was wrong:
   I had conflated the background suite session with a separate
   command I stopped. The suite's own completion record is the
   evidence, and it is green.)

## NOT run / remaining
- The agent 20-case matrix: NOT re-run (per the scope addition —
  separate follow-up once the join is proven; it now is).
- POLICY (unchanged, flagged): received share copies count toward
  the Default 10-file cap (the create-endpoint count check applies
  to origin 'shared' creates too — observed live: bob's workspace
  meter rose with each received copy) — the product-layer
  contract's open policy question; the parent/user decide.
- OBSERVED (agent lane, not shell): inside the restored/landing app
  frame, the seeded app rendered its heading but NOT its data rows —
  its mcp get_results call returned no rows it could render
  (shots t2-02/t2-03). The shell contract around it (accept →
  copies → import verified at the engine → landing → Restore →
  working view) is fully proven; the frame's get_results serving
  for recipient artifacts belongs to the agent/gallery lane.
- FOUND, PRE-EXISTING, BEYOND MY FIX'S NEEDS: /api/engine/
  library-save via GatewayClient.call 401s for ANY gateway-mode
  user in signed engine-access mode (gateway proxies the caller's
  gateway JWT verbatim; the signed engine rejects it — curl-proven:
  gateway+JWT 401 vs direct engine+access-token 200). The normal
  Ctrl+S library save uses that lane (saveWorkbookToServerLibrary);
  session checkpoints/autosave are unaffected, which is presumably
  why it went unnoticed. My share import routes around it via the
  transport's direct lane (librarySaveDirect). Whether to fix the
  proxied lane or migrate the save button to the direct lane is a
  save-workstream decision for the parent.

## Dist provenance
- Deliverable: apps/web/dist from `npm run build:local-stack`
  (VITE_GATEWAY_URL=http://localhost:8100 +
  VITE_ENGINE_ACCESS_MODE=signed), verify-dist OK, built AFTER the
  final source edits (hashchange hardening + librarySaveDirect +
  import reload). Tour copies (/tmp/shell-dist-v3..v6) are byte-
  rewritten (8100→8510) copies of successive deliverable builds;
  the final tour runs (tour1 21/21 re-run, tour2 11/11) used v6 =
  the deliverable build.

## Survey findings (2026-10-22 ~01:00 PDT, verified on disk)
- main.tsx renders <App/> directly; no routing exists. App.tsx = 9,623 lines.
- Product modules present + tested: Workspace({api, onOpenFile?, appsSlot?}),
  LandingPage({loggedIn, onSignIn, onOpenWorkspace}), AppsGallery({store,
  mcpCall, onOpen, sheets?, sharesApi?, ...}), SharedAppLanding({spec,
  mcpCall, onRestore}); deepLink.ts (fileIdFromUrl — search wins over hash,
  stash/takeReturnFile); sharesApi (SharesApi.getShare, buildShareLink,
  shareIdFromSearch). public/product/{hero-dashboard,collab,pivotchart}.png
  all present.
- App auth: gwClient = getGateway(); gwAuthed inits from stored session;
  gate at App.tsx:8352 renders <GatewayLogin> when gwClient && !gwAuthed
  && !isDesktop(). Firebase transitions handled at App.tsx:8332.
- Residual (p) lines INTACT: App.tsx:1730 setDirectDownloadMetadataProvider,
  :1735 setDirectDownloadBytesProvider (+ null cleanup :1763-64). MUST SURVIVE.
- Join-by-link TODAY: collabFileId inits from readFileIdFromHash() ONLY
  (#file= hash; App.tsx:609,1170). Contract: ?file= search wins, hash is
  legacy-read. GAP: ?file= deep links (the Workspace's canonical anchors)
  do not open the file in the shell today.
- GAP (load): nothing in the web client calls engine /load/storage-ref.
  Product-layer + CSV validations drove it directly via API. An uploaded
  catalog file (storageRef, never saved) opened via deep link joins a
  fresh blank engine session and shows an EMPTY workbook unless the shell
  drives the load. EngineOpenResult carries { joined, revision } — the
  safe trigger: fresh claim (joined=false) + revision 0 + catalog record
  with storageRef + !hasStoredState → POST /load/storage-ref direct on
  the owner engine (mirrors loadXlsxDirect). CSV records pass
  format:'csv' + sourceName (workspace-upload engine support exists).
- GAP (share origin): UserFileRecord origin union includes 'shared' in
  userStore.ts + productApi.ts, catalog.create accepts input.origin, but
  gateway POST /api/files hardcodes origin:'created' (gateway.ts:1099).
  Recipient data copies can't be tagged 'shared' without a minimal
  gateway change (gateway.ts is NOT sweep-forbidden; engineSvc.ts is).
- Recipient mechanics exist: SharesApi.getShare → service
  materializeRecipientCopy(pkg, {principal}) → fresh artifact + snapshot.
  Artifact store: App.tsx:660 artifactStore; artifactMcpCall App.tsx:663
  (gateway lane = gw.callTool). AgentChat mounts when agentOpen; its app
  panel is internally controlled → Restore's working view needs a small
  optional AgentChat prop to open a named artifact (AgentChat.tsx is NOT
  sweep-forbidden).
- AppsGallery's second home (chat Apps tab, ArtifactHost.tsx:178) uses
  store + mcpCall + onOpen from AgentChat — the Workspace slot reuses the
  same store/mcpCall from App state.

## Design (shell routing, inside App.tsx; gateway-mode + non-desktop only)
- Local mode (no gwClient) and desktop: EXACTLY today's behavior.
- Logged out: ?share= or ?file= present → stash target, existing
  GatewayLogin gate. Neither → LandingPage (onSignIn → GatewayLogin).
- Authed: shareId (URL or stash) → recipient flow (fetch package,
  materialize copies, artifact into store, data-copy file created with
  origin 'shared', snapshot imported into its workbook on first open,
  then full-screen SharedAppLanding; Restore → grid working view with
  the app open in the chat panel). fileId (URL/stash) → grid join flow
  (+ storage-ref first-open load). Neither → Workspace home with
  AppsGallery in appsSlot; file open = full navigation to ?file= URL
  (Workspace's native anchor semantics), keeping the grid path untouched.
- Workspace gallery onOpen(id) → full-screen embedded app overlay over
  the workspace (ArtifactFrame, same mcpCall as chat) with Close.

## SCOPE ADDITION (parent, 2026-10-22 ~01:15 PDT) — agent-track defect "D2"
The AI Agent live-validation program (hidden_files/agent-features/
FINAL-REPORT.md, defect "D2" — THEIR label, not the audit D2) found:
a #file= deep-link join can make ZERO gateway requests and never
paint; the in-app chat then silently runs the LOCAL in-page runtime
instead of the Vertex gateway agent. Creator-upload pages DO reach
the gateway. Trace fix direction: re-trigger the initial range fetch
when the active sheet's usedRange resolves; ALSO the engine 500s on
reads for the not-yet-known placeholder sheet (NOTE: the closed
defects sweep already made pended+absent-sheet reads return 409 in
engineSvc item H — verify whether the placeholder-sheet read is a
different path before touching engineSvc; it is no longer
sweep-frozen, but any touch gets recorded here).
MY DELIVERABLE ADDITION: (1) tours must prove gateway engagement on
deep-link opens with NETWORK evidence (/api/engine + engine traffic,
painted values, gateway session), for BOTH ?file= and #file= forms;
(2) if the defect reproduces on my stack, fix within routing/App
scope per the trace direction + regression test, recorded as its own
section below; (3) do NOT re-run the agent 20-case matrix.

### Join-defect section (agent-track D2) — status: RESOLVED
RESOLUTION SUMMARY (details in the bullets + log below):
(a) The zero-request symptom does NOT reproduce for genuine fresh
loads on the current tree: tour-join proves, for BOTH ?file= and
#file= forms, /api/engine/open firing, direct engine traffic, grid
painting the workbook's values (screenshot: A1=41, B1=42), the
browser JOINING the creator's live gateway session (joined:true),
and the in-app chat sending POST /api/agent/message (the gateway
agent lane — the local runtime fires nothing). The agent track's
diag harness navigated hash-only from an already-loaded page (a
same-document navigation — no reload, no boot-time hash read),
which is the one shape that DID reproduce inertness here; the
shell now routes same-document #file= changes through the
canonical deep link (hashchange hardening in App.tsx; tour3 part
(b) proves it). (b) The related sequential-open 409 family DID
reproduce hermetically and is FIXED (page-unload session release,
below). (c) The trace's placeholder-sheet engine 500 was NOT
reproduced on this stack (reads for absent sheets return the
sweep's 409/404 family; no engineSvc change was needed or made).
The 20-case matrix re-run remains a separate follow-up (not mine).
- Tour1 run 1 (fresh engine): join WORKED — /api/engine/open fired,
  storage-ref load drove, B1=42 read back with joined:true.
- Tour1 run 2 (same stack, ~10 min later): opens failed 409
  "engine already owns a different file: file-dd160646…" — run 1's
  session was never released (browser closed; the app releases only
  on in-page supersede — App.tsx 'superseded-by-new-open' — and the
  transport only beacons presence-leave on pagehide). Engine claim
  refuses while state.sessionStatus==='active' && fileId differs
  (engineSvc.ts /session/claim). Registry lease is 30 s but the
  ENGINE session's active state is what refuses. This is a REAL
  sequential-open hazard for full-navigation shell flows on a
  single-engine topology (my Workspace anchors navigate fully);
  production multi-instance routing masks it. Disposition pending
  the hermetic re-run: if xlsx→csv sequential opens reproduce the
  409 in one browser, an in-scope fix is required (candidate:
  transport release-on-pagehide via fetch keepalive).
- Stack restarted hermetic (data /tmp/shell-data-v2) for the proof
  tours. Tour-join (network-evidence) script being written.
- TOUR1 HERMETIC RUN (v2 stack): 17/21 — xlsx flow FULL PASS
  (landing/gate/workspace/upload/deep-link join/storage-ref load/
  B1=42 read-back joined:true/grid download PK). CSV sequential
  open REPRODUCED THE 409 in one browser: after the xlsx session,
  navigating home and opening the CSV hard-fails the claim. This is
  the sequential-open hazard (above), NOT the agent D2 zero-request
  symptom. FIXED in scope (below). One more FAIL to chase: the
  "Default tier badge" text check (screenshots t1-04 pending
  inspection — the badge may render after list load; check pending).
- FIX — page-unload session release (CollabTransport, mirrors the
  in-page supersede rule documented at App.tsx openRemoteBuffer):
  connect() latches createdFileId when a handshake CREATES the claim
  (survives reconnect/refresh re-joins; cleared when connecting to a
  different file as joiner); the existing pagehide listener now also
  calls releaseOnUnload(), which — only when the latch matches the
  opened file — beacons POST {engine}/session/release?access_token=
  (query auth, the engine's beacon pattern from /presence/leave)
  with {sessionId, reason:'page-unload'}. The engine checkpoints
  before evicting, so the file reopens by rehydration (§9). A joiner
  never releases. Regression tests: 4 new in collabTransport.test.ts
  (creator beacons with correct URL+body; joiner silent; latch
  survives reconnect; no session → silent). Suite 37/37 PASS.
- ⚠️ ENVIRONMENT HAZARD (found via this fix): the file-write path
  REDACTS credential-shaped template text ON DISK — my inserted
  `access_token=${accessToken}` was written as the literal bytes
  `access_token=<redacted>`, silently breaking the source (found by
  esbuild + codepoint dump; the pre-existing leavePresence line
  survived because it uses ${encodeURIComponent(accessToken)}).
  Repaired line 1300 via python write in the encodeURIComponent form
  and re-verified codepoints + esbuild + full suite. Any future
  write containing `access_token=${...}` or similar must use the
  encodeURIComponent form or a python/heredoc write, and be verified
  on disk. A tree-wide grep for literal '<redacted>' bytes found no
  other corruption from this session's writes.
- TOUR1 (final code, hermetic v3 stack): 21/21. The pagehide release
  fixed the sequential open; the tier-badge FAIL was a harness
  case-sensitivity bug (the badge renders "DEFAULT" via CSS
  text-transform; screenshot t1-04 inspected — product correct).
- TOUR-JOIN (network-evidence proof): 18/18 — see RESOLUTION (a).
  Chat evidence: GET /api/agent/watch/mute, GET /api/agent/pending,
  POST /api/agent/message all fired from the joined page.
- HARDENING (D2 same-document shape): App.tsx hashchange effect —
  a #file= hash naming a DIFFERENT file than the open one routes via
  window.location.assign(buildFileUrl(fid)); the app's own mirror
  writes (same id) are ignored. Proven by tour3 part (b).
- SHARE LEG — defect found + fixed: the import's persist step used
  saveWorkbookToServerLibrary (gateway-proxied /api/engine/
  library-save), which 401s in signed mode (see NOT-run section for
  the general finding; curl-proven both directions). The snapshot
  executes had already landed (engine revision advanced) but the
  flow died before raising the app. FIX: CollabTransport.
  librarySaveDirect (POST /library-save via fetchOpenedWithRefresh,
  the session's access-token lane) + runShareImport now saves
  through it, upserts the local library, and markOpened links the
  entry as designed. +2 transport tests (39/39 total).
- SHARE LEG — second defect found + fixed at shell level: the
  importing page's grid never repainted the import's structural ops
  (stayed on the blank Sheet1) although the session held the data
  and FRESH opens painted it correctly (probe-verified: Scores tab
  present on fresh open). The remote view's repaint semantics for
  own structural ops belong to the remoteEngine workstream; the
  shell flow now reloads the file page after a successful import
  (landing debt stashed in sessionStorage; the runner raises
  SharedAppLanding on the fresh page post-join). TOUR2 after both
  fixes: 11/11 (gate direct → accept → copies → import Ada/30 at
  revision 9 → landing full-screen → Restore → working view with
  Scores grid + app in chat → bob's workspace lists the copy with
  the "Shared" tag).
- FINAL REGRESSION: tour1 re-run on the FINAL deliverable dist
  (post all fixes): 21/21, download check included.

## Log
- 2026-10-22 ~00:52 PDT: REPORT.md skeleton created. Survey started.
- 2026-10-22 ~01:05 PDT: Survey complete (above). Implementation begins:
  step 1 collabTransport.loadStorageRefDirect.
- 2026-10-22 ~01:20 PDT: STEP 2 DONE. Gateway POST /api/files accepts
  origin 'shared' (validated; 'upload' still rejected 400) +
  productLayer.test.ts case; ProductApi.createFile(name, origin?) +
  getFile() + 3 tests. Gateway tsc clean, productLayer 38/38,
  productApi 15/15.
- 2026-10-22 ~01:45 PDT: STEP 3 (App wiring) CODE-COMPLETE, tsc clean:
  imports; collabFileId init now fileIdFromUrl (search wins, hash
  legacy); shell state (showLogin, routeShareId, shareSpec,
  workspaceAppId, chatArtifactRequest); productApi/sharesApi beside
  gwClient; loadCatalogUploadIfNeeded wired into the join flow between
  connect and snapshotAsync (residual (p) provider lines untouched);
  stash/consume effects; share accept effect (getShare →
  materializeRecipientCopy → artifactStore.add → createFile 'shared' →
  pending-import stash → navigate to ?file=); gate: landing for bare
  logged-out visits, GatewayLogin for link targets / after Sign in;
  share-accept interstitial; Workspace home return (AppsGallery in
  appsSlot with App's artifactStore + artifactMcpCall + sharesApi;
  gallery onOpen → full-screen ArtifactFrame overlay); share import
  runner (join-completion-triggered via ref + join-completed gate —
  workbookLoaded stays true on web so it cannot be the trigger):
  rename/add sheet → setCell per snapshot cell → library save →
  markOpened(libraryEntryId, hasStoredState) → SharedAppLanding;
  Restore → AgentChat initialArtifactRequest (new optional prop +
  handle-once effect in AgentChat.tsx). Web tsc --noEmit CLEAN.
- 2026-10-22 ~01:12 PDT: STEP 1 DONE. CollabTransport.loadStorageRefDirect
  added (POST /load/storage-ref via fetchOpenedWithRefresh, mirrors
  loadXlsxDirect; body {bucket?, object, format, name?, sessionId}) + 2
  tests (xlsx ref + csv format/sourceName). collabTransport.test.ts
  33/33 PASS. (One transient failure on the first run — a stale read
  racing my own edit; char-code probe proved the received header was
  byte-exact 'Bearer tok-1'; full re-run green.)
- 2026-10-22 ~02:0x–09:1x PDT: STEP 4 DONE (dist via build:local-stack
  + verify-dist OK, repeatedly, incl. the final build). STEP 5 DONE:
  tours tour1 21/21, tour-join 18/18, tour3 6/6, tour2 11/11 on the
  isolated production-topology stack; screenshots self-inspected.
  STEP 6 DONE via tour1's download check on the final dist.
  Scope-addition work (join proof, unload-release fix, hashchange
  hardening, librarySaveDirect, import reload) — all recorded in the
  join-defect section above. Full web suite: PASS 145/145 files,
  1829/1829 tests (see verdict 5, incl. the correction note).
  REPORT FINALIZED.
