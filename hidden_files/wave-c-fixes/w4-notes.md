# W4 — UI-built apps persist server-side — notes
Status: DONE — W4 PASS (live tour 8/8 on isolated stack; see Validation)

## Diagnosis
- (pending)

## Fix
- (pending)

## Validation
- (pending)

## Migration
- (pending)

## Diagnosis (landed 2026-10-22 ~05:40 PDT)
- Builder persistence: App.tsx module-level `appStore = createAppStore(appPersistence)` (App.tsx:588-611), appPersistence wraps localStorage, key `icecream-sheets.apps.v1` (service metadataStore.ts:271). AppSpec (service appbuilder/spec.ts): {id, version, name, dataSource{kind:'range',binding{sheet,startRow,startCol,endRow,endCol,headerRow?,tableId?},columns?}, views[], actions[], navigation, options?} — NO fileId/user field: local store is global, not bound to any file.
- Create path: handleCreateApp (App.tsx:4517) = appStore.add(spec) + setApps + auto-open runner. Spec changes: handleAppSpecChange (4525) = appStore.saveAll(map). My Apps menu (Ribbon.tsx:1170) lists `apps` state; NO delete-app affordance exists anywhere for builder apps.
- Generated apps are a DIFFERENT shape: ArtifactSpec (React source + ArtifactBinding) via createArtifactStore — ALSO localStorage in the web client (App.tsx:810). Server-side persistence for generated apps exists only as (a) agentSvc's file-backed artifact store used at generation time (gateway agentSvc.ts:303-310, agentThreadPersistence = filePersistence(gatewayDataDir())) and (b) the app-share store (gateway deploy/shareStore.ts, /api/shares) for shared copies. There is NO per-user+file CRUD endpoint for either app shape — so W4 requires a NEW server store for AppSpec following the shareStore/userStore adapter patterns (local JSON+lock / memory / Firestore fail-closed), keyed by ownerPrincipal + fileId, with gateway routes under /api/files/:fileId/apps and a web client following sharesApi/productApi patterns. localStorage stays as cache; local/desktop mode untouched.
- AppSpec gains optional `fileId?: string` (stamped at create in gateway mode; preserved by migrateAppSpec) so records are bound to their file.
- Migration: legacy local records carry no fileId, so their owning file cannot be proven from the record. Implemented heuristic (disclosed): on sync for an open gateway file, an unbound legacy app uploads bound to that file ONLY when its bound sheet name exists in the open workbook; stamped apps upload regardless. Deduped by app id against the server list.

## Fix — server side LANDED (2026-10-22 ~05:45 PDT)
- service appbuilder/spec.ts: AppSpec gains optional `fileId?: string`; migrateAppSpec preserves it. Service tsc CLEAN.
- NEW packages/gateway/src/deploy/builtAppStore.ts: BuiltAppStore keyed (ownerPrincipal, fileId, appId); Memory/Local(JSON+lock, built-apps.json)/Firestore(icecream_built_apps, sha256 doc ids, 1MiB loud cap) adapters; factory fails closed in prod without injected Firestore client. Specs migrated+validated server-side (normalizeBuiltAppSpec), route fileId re-stamped.
- gateway.ts: GatewayOptions.builtAppStore + resolution (503 fail-closed posture); routes GET/POST /api/built-apps, PUT/DELETE /api/built-apps/:appId (owner from verified claims only); DELETE /api/account now also purges built apps (deleted.builtApps). index.ts exports the store.
- Gateway tsc CLEAN; NEW tests/builtApps.test.ts: 8/8 PASS (store contract x3 adapters, fail-closed factory, HTTP CRUD + owner isolation + invalid-spec 400 + account purge).

## Fix — web side LANDED (2026-10-22 ~05:50 PDT)
- NEW apps/web/src/product/builtAppsApi.ts: BuiltAppsApi over GatewayClient (listApps/createApp/updateApp/deleteApp), sharesApi-style error normalization.
- NEW apps/web/src/product/builtAppSync.ts: pure planBuiltAppSync — server authoritative per id, upload-on-open deduped, legacy sheet-match migration heuristic, other-file apps untouched.
- NEW tests builtAppsApi.test.ts: 8/8 PASS (API routes + sync plan incl. fresh-profile merge, dedupe, legacy gating).
- App.tsx wiring (surgical): BuiltAppsApi beside sharesApi; handleCreateApp stamps fileId (gateway+file only) + POSTs server-side (failure -> local stands, re-uploaded at next sync); handleAppSpecChange PUTs mutations for the open file's apps; sync effect once per (file, loaded, sheet-set): GET server list -> plan -> uploads -> appStore.saveAll(merged) + setApps. Local/desktop untouched (builtAppsApi null / isDesktop guard).
- tsc: service CLEAN, gateway CLEAN. Web tsc has 6 errors, ALL pre-existing from concurrent programs (App.tsx:2046 hydrateOpenedWorkbook — another worker's region; AgentChat.tsx intent-router — W3 in flight); grep confirms ZERO errors in W4 files/regions.

## Live tour run 1 (isolated stack 18100/14173) — A+API PASS, B/C FAIL -> root cause found + fixed
- Profile A: builder UI built "W4 Sales App", runner rendered data PASS. API: GET /api/built-apps shows exactly that record (app_mvjklmao_3, fileId-bound, spec intact); other-file and other-user lists empty PASS.
- Fresh profiles B/B2/C: GET /api/built-apps fired (200, body contains the app — debug-b.mjs network capture) but localStorage stayed null, My Apps "No apps yet"; migration upload never landed.
- ROOT CAUSE (mine, in App.tsx sync effect): sheetNames is a fresh array every render -> effect cleanup fired constantly and CANCELLED the in-flight run after its GET resolved, while builtAppSyncKeyRef stayed consumed -> every later run early-returned. The merge commit never executed.
- FIX: a run is never cancelled by cleanup; the sync key stays consumed only when a run COMPLETES; cleanup of an incomplete run frees the key so the next invocation retries. Rebuild + tour re-run next.

## Validation — LIVE TOUR PASS (run 2, 2026-10-22 ~06:43 PDT, isolated stack GW 18100 / web 14173, own data dir + own web dist)
- Evidence dir: hidden_files/wave-c-fixes/w4-live/ (tour-w4.mjs, result.json, tour.log, screenshots a1-a4/b1-b3; run 1 preserved as result-run1.json/tour-run1.log).
- 8/8 assertions PASS (result.json pass=true, file file-71225c9a-d110-4e4d-a2cd-a4954517b4d2, user w4carol):
  1. A: app "W4 Sales App" built via builder UI, runner auto-opened with data.
  2. API: GET /api/built-apps returns exactly that record, spec.fileId == file id.
  3. API: other file id -> empty. 4. API: other user, same file -> empty.
  5. B (FRESH profile): My Apps lists "W4 Sales App" (screenshot b1).
  6. B: runner opens and renders all 12 fixture rows (screenshot b2, self-inspected: Jan North 12000 ... Jun South 14200, exact).
  7. Migration: profile C seeded with a pre-W4 localStorage record (no fileId) -> on open it uploaded (server list = both apps, legacy stamped with the file id).
  8. B2 (another fresh profile): both apps listed (screenshot b3, self-inspected).
- Server on-disk proof: isolated data dir built-apps/built-apps.json holds records keyed "user:w4carol | <fileId> | <appId>" for both tour runs incl. app_legacy_w4.
- Suites so far: gateway builtApps 8/8; web builtAppsApi+sync 8/8; service appbuilder/metadata 60/60. Full gateway suite + web product tests: pending below.

## Validation — suites final (2026-10-22 ~07:00 PDT)
- Gateway full suite: 376 passed / 3 failed (38 files). All 3 failures proven NOT W4:
  (1) userSettings DELETE /api/account tier assertion — fails IDENTICALLY with my purge block temporarily removed (post-delete GET /api/files re-creates the tier record via resolveTier; pre-existing in the working tree).
  (2) servicePackage health — triggers program added an "automation" service; the test's expected services list is stale (theirs).
  (3) services.test HITL — agent pending-ask store pollution (7 leftover asks vs expected 1; the agent-rerun report noted the shared persisted ask store); no W4 code path involved; fails in isolation too.
- Web product tests (apps/web/src/product): 90/90 PASS (9 files, incl. builtAppsApi 8/8, productApi, sharesApi, AppsGallery, Workspace, SettingsPanel).
- Service appbuilder/metadata: 60/60 PASS. Gateway builtApps.test.ts: 8/8 PASS.
- tsc: service CLEAN, gateway CLEAN; web 6 errors all pre-existing/concurrent (AgentChat intent-router = W3 in flight; App.tsx:2046 hydrateOpenedWorkbook = another worker's region), ZERO in W4 files.
- Local/desktop mode: untouched paths — builtAppsApi is null without a gateway client and every server call is gated on !isDesktop(); the localStorage store remains the store there (code-reviewed; local mode has no gateway to validate against in the tour).

## Delete behavior (honesty)
- There is NO delete-app affordance for builder apps in the UI today (pre-existing; My Apps only opens). Implemented anyway, consistent-or-better vs generated apps (whose gallery delete is local-store only): DELETE /api/built-apps/:appId (owner-scoped, tested) + BuiltAppsApi.deleteApp (tested) + account deletion purges server copies (tested). No UI surface calls delete yet — wiring a delete affordance is a product decision, flagged here rather than silently added to the ribbon.

## Migration (final statement)
- IMPLEMENTED and live-proven (tour leg C/B2): stamped apps upload on create and on open; legacy pre-W4 records (no fileId — their owning file is unprovable from the record) upload on open of a file whose workbook contains their bound sheet name, stamped with that file. Disclosed heuristic; deduped by id. Residual risk: a legacy app whose sheet name also exists in an unrelated file opened first would bind there — accepted and disclosed, since the record itself carries no stronger signal.

## Files changed
- packages/service/src/appbuilder/spec.ts (AppSpec.fileId + migrate preservation)
- packages/gateway/src/deploy/builtAppStore.ts (NEW) + tests/builtApps.test.ts (NEW)
- packages/gateway/src/gateway.ts (option, resolution, /api/built-apps routes, account purge) + src/index.ts (exports)
- apps/web/src/product/builtAppsApi.ts (NEW) + builtAppSync.ts (NEW) + builtAppsApi.test.ts (NEW)
- apps/web/src/App.tsx (BuiltAppsApi wiring, create/change server persistence, open-file sync effect)
- Dists rebuilt in place (service, gateway; web built to ~/workspace/tmp-w4/web-dist only — shared web dist untouched). NOT pushed (per brief).
- Isolated stack (18100-18108/14173) shut down after validation; shared 8100 stack never touched.
