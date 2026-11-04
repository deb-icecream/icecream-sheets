# Firestore Prod Adapters — Report

Started: 2026-10-22 (worker, firestore-prod-adapters)
Task: close the two prod-only gaps ruled blockers-in-principle by the user:
(1) session-resolver listing over the Firestore file/session registry;
(2) share-store Firestore adapter so SHARE_STORE=prod works.

## Gap 1 — Registry listing for agent/add-on session resolvers (Firestore)
Status: DONE (fake-based proof; live Firestore proof rides post-deploy verification)
- sessionStore.ts: FirestoreLike.collection gains listAll() (full-collection scan);
  wrapFirestore implements it over the raw client's col.get().
- fileRegistry.ts: FileRegistry gains listAll(); implemented in Local (lock + readAll),
  Memory, and Firestore (collection scan; malformed docs skipped). Semantics: every
  record, live and dead — the resolvers' shared isLiveOwner filter excludes dead
  leases identically for every source, exactly as for the local registry file today.
- agentSessionResolver.ts: new opts.registry (FileRegistry); loadRecords precedence
  records -> registry.listAll() -> local file (default unchanged).
- Wiring: agentSvc AgentServiceDeps.fileRegistry (+ sessionResolverFor selection used
  by runtimeFor and the chart sink); addonEngineBinding ProductionAddonBindingOptions
  .fileRegistry forwarded to createFileSessionResolver; servicePackage
  ServicePackageDeps.fileRegistry passed to the agent listener + productionAddonDeps.
- Existing typed fakes updated: tests/deployAccess.test.ts (listAll on the fake),
  tests/phase2Collab.test.ts (throwing FileRegistry literal gains listAll).

## Gap 2 — Share-store Firestore adapter (SHARE_STORE=prod)
Status: DONE (fake-based proof; live Firestore proof rides post-deploy verification)
- shareStore.ts: FirestoreAppShareStore over FirestoreLike — collection
  icecream_app_shares, doc id = sha256 hex of the share id, create() rejects
  records over the 1 MiB doc cap LOUDLY (never truncates), malformed docs read
  as missing; create/get/listByOwner (queryEq on ownerPrincipal)/revoke
  semantics identical to the Local/Memory adapters.
- prodShareConfig(env): SHARE_STORE=prod requires GCP_PROJECT_ID (optional
  FIRESTORE_DATABASE_ID), throws fail-closed before any client work.
- createProdAppShareStore(env): async prod constructor — validates config,
  dynamic-imports @google-cloud/firestore (fail closed when not installed),
  wraps via sessionStore.wrapFirestore. createAppShareStore gains the sibling
  factories' injection seam (opts.firestoreDb); prod without a client still
  throws fail-closed (no silent local fallback).
- bin/gateway.ts: when SHARE_STORE=prod, the bin awaits createProdAppShareStore
  and injects it via GatewayOptions.appShareStore (bin/engine.ts posture); a
  construction failure leaves /api/shares at the gateway's 503 fail-closed.
- Deploy config: deploy/services/gateway.yaml sets SHARE_STORE="prod" +
  GCP_PROJECT_ID=${GCP_PROJECT}; deploy/CONFIG.md gateway table gains the
  SHARE_STORE + GCP_PROJECT_ID rows (MCP-row style).

## Tests
Status: ALL GREEN — full gateway suite 33 files / 345 tests PASS (392.68 s under
VM contention), gateway tsc --noEmit clean.
- New: tests/firestoreProdAdapters.test.ts (9 tests) — registry listAll parity
  across Local/Memory/Firestore fakes; dead/released exclusion identical over
  every adapter source; participant binding via the Firestore path (note ->
  resolve, viewer role); wrapFirestore scan; share round trip + sha256 doc id
  + over-cap loud rejection + malformed-doc tolerance; prod fail-closed matrix.
- Affected files re-run green: firestoreProdAdapters + fileRegistry +
  agentBinding + appShares + deployAccess + phase2Collab + servicePackage +
  addonRunBinding = 8 files / 94 tests PASS.

## Live-proof caveat
No live Firestore is reachable from this VM. All proof is fake-based unit tests in the
established style; the live-Firestore proof rides the post-deploy verification.

## Final verdicts
- Gap 1: DONE. Registry listAll() on all three adapters + FirestoreLike scan +
  resolver registry option + wiring through agentSvc / addonEngineBinding /
  servicePackage. Local/Memory default behavior unchanged (proven by the
  unmodified existing suites staying green).
- Gap 2: DONE. FirestoreAppShareStore + prodShareConfig + createProdAppShareStore
  + bin/gateway.ts prod bootstrap + gateway.yaml SHARE_STORE="prod" /
  GCP_PROJECT_ID=${GCP_PROJECT} + CONFIG.md rows. SHARE_STORE=prod now
  constructs the Firestore store when GCP_PROJECT_ID is configured and fails
  closed when it is not.
- Honest caveats: (1) No live Firestore is reachable from this VM — every
  proof above is fake-based unit tests in the established style; the live
  proof (real Firestore round trip for both adapters) rides the post-deploy
  verification, same as the MCP durable store. (2) One pre-existing seam
  remains outside this task's scope: the service-package/agent processes
  receive a FileRegistry only when their assembler supplies one — the
  resolvers now consume it at every construction layer (resolver option,
  agent deps, add-on factory options, service-package deps), but no bin
  yet builds a Firestore-backed registry for those processes (the same
  injection posture all gateway deploy stores share today: createFileRegistry
  fails closed in prod without an injected client). (3) A share package
  whose serialized record exceeds the 1 MiB Firestore document cap now
  fails LOUDLY at create() in prod instead of being silently unwritable —
  deliberate, mirroring the MCP metadata cap.
