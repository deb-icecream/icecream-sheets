# Leg 2 — Wire USER_STORE=prod for the gateway — FINAL REPORT

Status: COMPLETE (code + config + tests only; NO deploy, NO git push —
the coordinator redeploys and runs the promotion).
Date: 2026-10-22. TMPDIR for all runs: ~/workspace/tmp-leg2.

## Problem (from the deploy-run final report)
`deploy/services/gateway.yaml` never set `USER_STORE`, so the deployed
gateway's tier store + file catalog were instance-local JSON, and
`bin/set-tier.ts` (which selects its store via
`createUserTierStore(process.env)`) could never reach the deployed
store — the deploy test user could not be promoted to Pro.

## Files changed (4 modified + 1 new test file)

1. `packages/gateway/src/deploy/userStore.ts`
   - Import: `wrapFirestore` value import added alongside the existing
     `FirestoreLike` type import, both from `./sessionStore.js`
     (gateway-local module — see "Import safety" below).
   - NEW prod-construction section (end of file), mirroring
     shareStore.ts's `prodShareConfig` + `createProdAppShareStore`:
     - `prodUserConfig(env): ProdUserConfig` — `USER_STORE=prod`
       requires `GCP_PROJECT_ID` (trimmed, non-empty); throws
       fail-closed BEFORE any client work when missing;
       `FIRESTORE_DATABASE_ID` optional pass-through.
     - `createProdUserStores(env): Promise<ProdUserStores>` —
       validates config, loads `@google-cloud/firestore` via
       non-literal dynamic import (missing package = fail-closed
       error, never a local fallback), wraps it with `wrapFirestore`,
       and returns `{ userTierStore, userFileCatalog,
       userSettingsStore }` — ALL THREE family stores over ONE client
       (the settings store shares the USER_STORE family switch, so
       wiring only tier+catalog would have left settings throwing in
       prod and taken the product block down with it).
     - `createProdUserTierStore(env): Promise<UserTierStore>` — same
       validation + client load, tier store only (set-tier's target).
   - The pre-existing Firestore adapters and sync factories were NOT
     changed: `FirestoreUserTierStore` (`icecream_user_tiers`),
     `FirestoreUserFileCatalog` (`icecream_user_files`),
     `FirestoreUserSettingsStore` (`icecream_user_settings`); sync
     factories still fail closed in prod without an injected client.

2. `packages/gateway/src/bin/gateway.ts`
   - Header doc: USER_STORE=prod posture documented.
   - Before the product-layer block: when
     `userStoreProvider() === 'prod'`, `prodUserStores = await
     createProdUserStores(process.env)` (top-level await, same posture
     as the existing share-store injection below it) and logs
     `[gateway] user store: prod (Firestore — tier store, file
     catalog, settings)`. On failure it logs the clear error and
     leaves `prodUserStores` unset.
   - Product-layer construction now uses
     `prodUserStores?.userTierStore ?? createUserTierStore(process.env)`
     (and the same for settings + catalog). Consequences:
     - prod + success → Firestore stores injected.
     - prod + failure → the sync factory throws (fail closed) →
       productOpts stays empty → createGateway's own retry also fails
       → product endpoints serve 503 while every other route stays up
       (verified by smoke test below). NEVER a silent local fallback.
     - USER_STORE unset/local → the `??` branch is the exact previous
       code path; local/memory behavior unchanged.

3. `packages/gateway/src/bin/set-tier.ts`
   - Store construction branches on `userStoreProvider(process.env)`:
     prod → `await createProdUserTierStore(process.env)`; otherwise
     the previous sync `createUserTierStore(process.env)`. Errors in
     either branch keep the existing behavior (message on stderr,
     exit 1).
   - Header doc now documents the prod invocation explicitly.

4. `deploy/services/gateway.yaml` — see "YAML diff" below.

5. NEW `packages/gateway/tests/userStoreProd.test.ts` — see "Tests".

## F-5 analysis — the USER_STORE Firestore adapter's write shape for tier records (EXPLICIT)

`FirestoreUserTierStore` (userStore.ts) is **read-check-set and
NON-transactional** — I verified every mutating method:

- `resolveTier`: `getRecord()` (doc `get`) → if the record exists and
  the email differs, `doc.set(full record)`; if no record,
  `getPendingByEmail()` (doc `get`) → pending doc `delete()` →
  `doc(userId).set(full new record)`.
- `setTierByEmail`: `collection.queryEq('email', email)` (read) →
  normalized-email match found in memory → `doc(match.userId).set(full
  updated record)`; no match → `doc('pending:<email>').set({pendingEmail, tier})`.
- `setTierByUserId`: `getRecord()` → `doc.set(full record)`.
- `deleteRecord`: `getRecord()` → doc `delete()` + pending doc `delete()`.

No transaction is used anywhere — the narrow `FirestoreLike` surface
(sessionStore.ts) does not even expose one (only doc get/set/delete,
`queryEq`, `listAll`). Each individual Firestore `set` is atomic at
the single-document level, so a reader never observes a torn record;
what is NOT atomic is the read→decide→write sequence across calls.

**Why that shape is acceptable for tiers (and would not be for the
registry):** the file registry's `claim` (fileRegistry.ts, the F-5
concern) protects an EXCLUSIVITY invariant — one live owner per file,
fenced by `ownershipEpoch`; two concurrent claim winners = split-brain
authoritative models (§9), so its Firestore adapter does epoch
compare-and-set plus a post-write re-read verification, and
`FILE_REGISTRY_STORE=prod` was **NOT wired anywhere in this change**
(the yaml sets no `FILE_REGISTRY_STORE`; the code touches no registry
path). A tier record has no ownership, no epoch, and no exclusivity
invariant: it is one document keyed by userId (pending promotions keyed
`pending:<normalized email>`) whose payload is a scalar entitlement
(`default|pro`) plus email/timestamps, and every write is a full-record
idempotent set. Worst-case races are benign and recoverable:
(1) two concurrent operator writes → last-writer-wins, which is the
intended operator semantics, and re-running set-tier converges;
(2) a first-login `resolveTier` racing an operator promotion → at worst
a transiently stale tier until the operator re-applies — never a torn
record, never a second authoritative store; (3) two userIds sharing one
email both consuming one pending promotion → both land at the promoted
tier for that same email, the promotion's intent. **Finding: the
non-transactional read-check-set shape is ACCEPTABLE for tier records.**
(The catalog and settings Firestore adapters use the same per-document
get→set shape keyed by fileId/userId and are acceptable for the same
reason: no cross-document or exclusivity invariant travels those paths —
the gateway checks catalog ownership by principal before mutating.)

## How set-tier targets prod
```
USER_STORE=prod GCP_PROJECT_ID=<project> \
  node dist/bin/set-tier.js --email <e> --tier pro     # or --user <uid>, or --show
```
Credentials resolve through the Firestore client's ADC discovery, so
the coordinator runs it with deployer credentials
(GOOGLE_APPLICATION_CREDENTIALS / gcloud ADC) against the deployed
project's Firestore — the same `icecream_user_tiers` collection the
redeployed gateway reads. `USER_STORE=prod` without `GCP_PROJECT_ID`
exits 1 with: "user store: USER_STORE=prod requires GCP_PROJECT_ID to
be set — refusing to start with a half-configured production user
store (fail closed)" (verified against the built bin, below).

## YAML diff (deploy/services/gateway.yaml)
`GCP_PROJECT_ID` already existed with value `${GCP_PROJECT}` (the
existing substitution style); its comment was extended. Added,
immediately after the existing SHARE_STORE entry:
```yaml
            - name: USER_STORE
              value: "prod"             # per-user tier store + file catalog (+ settings) persist in Firestore (deploy/userStore.ts prod adapters; bin/gateway.ts builds them at startup, fail closed). NOTE: this is the USER store only — it does NOT enable the file-registry/session-ownership store, which is deliberately not wired here (F-5)
            - name: GCP_PROJECT_ID
              value: ${GCP_PROJECT}     # Firestore project for the prod share store (SHARE_STORE=prod) and the prod user store (USER_STORE=prod)
```
No other env entries changed. deploy.sh needs no change: for the
gateway it only envsubst-renders this yaml (`render_and_replace
gateway.yaml`); there is no separate gateway env list to mirror into.
F-5 honored: the literal string `FILE_REGISTRY_STORE` appears
NOWHERE in gateway.yaml, gateway.ts, set-tier.ts, or the userStore.ts
changes (verified by grep after landing — the yaml comment above was
worded to avoid even mentioning it).

## Import safety (the firestore-node barrel trap)
Not applicable here, and checked: userStore.ts lives IN the gateway
package; its only new import is `wrapFirestore` from the gateway-local
`./sessionStore.js` (which it already imported `FirestoreLike` /
`sessionDataDir` from). Nothing imports `@icecream-sheets/service` or
its firestore-node subpath for this wiring, and the real
`@google-cloud/firestore` client is reached ONLY through a non-literal
dynamic import inside the prod constructors (shareStore/sessionStore
posture) — no static Node-only import enters any shared/web bundle.

## Tests + verification (exact counts)
- `tsc -p tsconfig.json` for packages/gateway (`npm run build
  --workspace=@icecream-sheets/gateway`): PASS, no errors.
- New suite `tests/userStoreProd.test.ts`: 8 tests — provider
  selection (unset/local vs prod/firestore); local default unchanged
  (Local instances + persistence via USER_STORE_DIR); sync factories
  fail closed in prod without a client (all three stores);
  `prodUserConfig` requires GCP_PROJECT_ID (+ databaseId pass-through);
  `createProdUserStores` / `createProdUserTierStore` reject without
  GCP_PROJECT_ID before client load; injected-fake prod construction
  returns the Firestore adapters; and the shared-store test — two
  store instances over the same fake Firestore (gateway + operator)
  see each other's writes: promotion by email lands pro on the
  gateway's next resolveTier, a pending promotion is consumed at first
  login, catalog writes list back from a second instance.
- Related suites run together: userStoreProd (8) + firestoreProdAdapters
  (9) + productLayer (38) + userSettings (14) + appShares (3) = **5 test
  files, 72 tests passed, 0 failed**. (CORRECTION 2026-10-22: an earlier
  draft of this report said 101 tests / 7 new-suite tests — wrong; the
  terminal vitest summary for that run is 5 files / 72 tests, and the
  parent agent was sent a correction.)
- Full gateway suite (all 46 files, 439.65s): **44 files passed, 2
  failed; 439 tests passed, 6 failed (445 total)**. Both failing files
  are OUTSIDE this change's import graph and were re-run standalone:
  `tests/engineSvcStreamReap.test.ts` (a 60s test timeout under the
  parallel load of the full run) PASSED standalone;
  `tests/services.test.ts` (agent-service human-in-the-loop test)
  failed standalone too (1 failed / 20 passed) with the pending-asks
  count GROWING between runs (17 in the full run, 18 standalone) —
  accumulated shared agent-store state in this environment, not this
  diff: services.test.ts imports only the vault/meta/etl/agent
  service listeners and @icecream-sheets/service; it imports neither
  userStore.ts, src/gateway.ts, nor either changed bin. Reported
  here honestly as a pre-existing/environmental failure; the suites
  this change touches (user store, product layer, settings, shares,
  Firestore adapters) are all green above.
- Built-bin smoke checks (dist from the tsc build above,
  TMPDIR=~/workspace/tmp-leg2):
  - set-tier LOCAL: `USER_STORE_DIR=<tmp>` `--email … --tier pro`
    printed `{"pending":"…","tier":"pro"}` (exit 0); `--show` read it
    back; `user-tiers.json` on disk contains the pending entry.
  - set-tier PROD without project: `USER_STORE=prod` (no
    GCP_PROJECT_ID) → exit 1, fail-closed GCP_PROJECT_ID message
    above. (No live-Firestore attempt was made from this VM.)
  - gateway LOCAL (no USER_STORE): starts, log `product layer:
    enabled`, /health 200.
  - gateway USER_STORE=prod WITHOUT GCP_PROJECT_ID: starts, logs the
    fail-closed construction errors, /health 200, dev-login 200, and
    GET /api/files → **503** (product fail-closed, other routes up).
  - gateway USER_STORE=prod WITH GCP_PROJECT_ID=leg2-fake-project:
    logs `[gateway] user store: prod (Firestore — tier store, file
    catalog, settings)` + `product layer: enabled`, /health 200.
    (Client construction only — credentials/network are exercised by
    the coordinator's post-deploy promotion, not from this VM.)

## Not landed / notes
- No deploy, no git push (per brief) — the coordinator redeploys the
  gateway from the updated yaml and runs the set-tier promotion.
- The live-Firestore round trip is NOT proven here (no Firestore
  reachable from this VM, same posture as firestoreProdAdapters.test.ts):
  proof is fake-based + built-bin fail-closed/startup smokes. The
  post-deploy promotion IS the live proof.
- No package.json change: `@google-cloud/firestore` is loaded
  dynamically exactly as the already-deployed SHARE_STORE=prod path
  does (the package is present in the workspace install via
  @icecream-sheets/mcp-server's dependency); adding it as a direct
  gateway dependency was deliberately NOT done to keep this diff
  identical in posture to the share-store wiring — flagging it in case
  the coordinator prefers an explicit dependency later.
- `progress.md` was not touched.
