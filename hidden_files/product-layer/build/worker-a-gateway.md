# Worker A (gateway product core) — build report

Product layer per `hidden_files/product-layer/BRIEF.md` +
`hidden_files/product-layer/CONTRACT.md`. All paths below are the
real files on disk (contract names). No git operations performed.

## Files written / modified

| Path | What |
|---|---|
| `packages/gateway/src/deploy/userStore.ts` | NEW. `UserTierStore` (record `{userId, email?, tier, createdAt, updatedAt}`; `resolveTier` creates on first sight + backfills email; pending promotions by email consumed once at first creation; `setTierByEmail`/`setTierByUserId`/`getRecord`/`getPendingByEmail`) and `UserFileCatalog` (`create/get/listByOwner` lastOpenedAt-DESC/`update/remove/countByOwner/touchOpened`). Memory + Local (JSON + lockfile mutex, atomic tmp+rename) + Firestore-shaped adapters (`icecream_user_tiers` / `icecream_user_files`). Factories `createUserTierStore` / `createUserFileCatalog` fail closed when `USER_STORE=prod` without an injected Firestore client. Constants `DEFAULT_UPLOAD_MAX_BYTES = 1_285_214` (env `TIER_DEFAULT_UPLOAD_MAX_BYTES`), `DEFAULT_FILE_LIMIT = 10` (env `TIER_DEFAULT_FILE_LIMIT`). |
| `packages/gateway/src/deploy/uploadStore.ts` | NEW. `UploadObjectStore` (Memory / Local / GCS-structural adapters; factory `createUploadObjectStore` fails closed when `UPLOAD_STORE=prod` without an injected client) + upload tokens `issueUploadToken`/`verifyUploadToken` (HMAC scheme mirroring engineAccess storage tokens; payload `{v:1, op, object, principal, maxBytes?, exp}`; throws `EngineAccessError`) + `uploadObjectKey` = `uploads/<sha256(ownerPrincipal).hex[0:16]>/<fileId>.xlsx`. Local root `UPLOAD_STORE_DIR` (default `<sessionDataDir>/uploads`), bucket `UPLOAD_BUCKET` (default `icecream-uploads`); putUrl/getUrl return gateway staging URLs. GCS adapter uses v4 `getSignedUrl` when the client supports it, else staging URL. |
| `packages/gateway/src/gateway.ts` | Surgical additions only: imports; `GatewayOptions` gains `userTierStore`, `userFileCatalog`, `uploadStore`, `uploadTokenSecret`, `uploadPublicBaseUrl` (all optional, env-driven local defaults; prod construction failure → product endpoints 503, other routes unaffected); tier stamp in BOTH `POST /auth/login` and `POST /auth/firebase` (JWT `attrs.tier` + response `tier` field); staging routes `PUT/GET /uploads/stage/<enc-object>?ut=` before the `/api` fallthrough (token is the auth, no JWT; stream-counted PUT aborts past token `maxBytes`, deletes the object, 413); `/api/files*` handlers inside the auth + rate-limit pipeline; `/api/engine/open` catalog ownership check (non-owner → 404 `file not found`; owner → `touchOpened`; no record → unchanged). |
| `packages/gateway/src/bin/gateway.ts` | Constructs the three stores (public base from `GATEWAY_PUBLIC_URL` or `http://127.0.0.1:<PORT>`, token secret from `ENGINE_ACCESS_SECRET` ?? `AUTH_SECRET`), passes them via the new options, logs one product-layer status line. Construction failure leaves the gateway up with product endpoints 503. |
| `packages/gateway/src/bin/set-tier.ts` | NEW operator CLI. `node dist/bin/set-tier.js (--email <e> \| --user <id>) --tier default\|pro [--show]`. Constructs the store directly via `createUserTierStore(process.env)` (no gateway, no HTTP). `--email` → `setTierByEmail`: prints the updated record JSON, or `{"pending": <email>, "tier": <tier>}` when no record exists yet. `--user` → `setTierByUserId`: prints the record JSON. `--show` is read-only: prints `getRecord` JSON (`--user`) or `{"pending": <email>, "tier": <tier\|null>}` (`--email`), exit 0. Invalid args → usage on stderr, exit 2. Store construction failure → exit 1. |
| `packages/gateway/package.json` | Added one script only: `"set-tier": "node dist/bin/set-tier.js"`. |
| `packages/gateway/tests/productLayer.test.ts` | NEW tests (29 — breakdown below). |

Not touched: `services/engineSvc.ts`, web app files, `apps/web/dist`,
`src/index.ts` (the new stores are not re-exported from the package
index — the contract assigns no index change to Worker A).

## Endpoint inventory

Auth (tier-stamped): `POST /auth/login`, `POST /auth/firebase` —
both resolve the tier via `UserTierStore.resolveTier` and stamp
`attrs.tier` in the JWT plus a `tier` field in the JSON response.

Product (`/api/*`, Bearer JWT + per-principal rate limit):
- `GET /api/files` → `{ ok, tier, limits{uploadMaxBytes, fileLimit} (null = pro), count, files[] }`
- `POST /api/files {name}` → 201 created-origin record; Default count cap → 409 `{code:'FILE_LIMIT_REACHED', limit, count, tier:'default'}`, message names the limit + Pro
- `GET /api/files/:fileId` → record; missing or non-owner → 404
- `PATCH /api/files/:fileId {name?, hasStoredState?, libraryEntryId?}` → updated record; non-owner → 404
- `DELETE /api/files/:fileId` → record + staged object deleted; non-owner → 404
- `POST /api/files/upload-grant {name, size}` → size must be a positive integer ≤ 256 MiB (else 400); Default oversize → 413 `{code:'UPLOAD_TOO_LARGE', limit, size, tier:'default'}` (message names limit bytes, actual size, Pro unrestricted); count → 409; success `{fileId, object, upload:{url, expiresAt, method:'PUT'}}`, no catalog record yet; grant token `maxBytes` = declared size
- `POST /api/files/:fileId/complete-upload {name}` → no staged object → 404 `{code:'UPLOAD_NOT_FOUND'}`; ACTUAL size re-checked vs current tier (violation: object deleted, 413); count re-checked (violation: object deleted, 409 — no orphans); creates upload-origin record with actual `sizeBytes` + `storageRef`; idempotent for an existing owner record (201); a fileId owned by someone else → 404
- `POST /api/files/:fileId/download-grant` → `libraryEntryId` → engine storage URL (`issueStorageToken`, origin resolved exactly as `/api/storage/sign`); else `storageRef` → upload-store `getUrl` (staging GET URL); else 409 `{code:'NO_STORED_BYTES'}`

Staging (top level, token-authenticated, bypasses the JWT pipeline):
- `PUT /uploads/stage/<enc-object>?ut=` → verify (op `put`, object match, expiry); stream-counted; past token `maxBytes` → abort + delete object + 413; success 200 `{ok, object, size}`
- `GET /uploads/stage/<enc-object>?ut=` → verify (op `get`); serves bytes as `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` with attachment disposition
- Missing/invalid/expired/wrong-scope token → 401

`POST /api/engine/open` addition: catalog record exists + not owner
→ 404 `file not found`; owner → `touchOpened(fileId)` then the
unchanged Phase 2 join/claim flow; no record → unchanged.

## Verification (real output)

- `npx tsc -p tsconfig.json --noEmit` in `packages/gateway`: exit 0.
- `npx vitest run tests/productLayer.test.ts tests/gateway.test.ts tests/fileRegistry.test.ts tests/firebaseExchange.test.ts tests/deployAccess.test.ts tests/phase2Collab.test.ts`:
  **6 files passed, 99 tests passed, 0 failed.**
  - productLayer.test.ts — 29 (tier store 5 incl. pending-consumed-once + Local persistence; catalog 2 incl. recency/count/update/remove + Local persistence; upload tokens 3; gateway HTTP 15; firebase exchange tier stamp 4)
  - gateway.test.ts — 19 · fileRegistry.test.ts — 7 · firebaseExchange.test.ts — 7 · deployAccess.test.ts — 22 · phase2Collab.test.ts — 15 (no regressions)

Product-layer HTTP coverage includes: login tier claim (response +
decoded JWT `attrs.tier`); grant at exactly 1,285,214 → 200 with a
working staging PUT; grant at 1,285,215 → 413 `UPLOAD_TOO_LARGE`
limit 1285214; 11th file → 409 `FILE_LIMIT_REACHED` at create AND at
upload-grant; complete-upload actual-size re-check (crafted token via
`issueUploadToken` with a larger maxBytes, oversized PUT staged, then
complete → 413 and object deleted) and the grant-as-pro/demote
variant; pro user oversized grant + 11th file both OK; created files
count toward the 10; non-owner GET/PATCH/DELETE/complete-upload/
download-grant → 404; staging wrong-op / wrong-object / tampered /
expired tokens → 401; staging PUT past token maxBytes → 413 + object
gone; download-grant serves the actual bytes back through the staging
GET URL; created-never-saved → 409 `NO_STORED_BYTES`; engine/open
non-owner catalog file → 404, owner → 200 with `lastOpenedAt`
advanced (against a stub claim engine + `MemoryFileRegistry`);
firebase exchange tier stamp with a fresh in-test RSA keypair via
`tests/firebaseTestKeys.ts` (default → `setTierByEmail(email,'pro')`
→ re-exchange stamps pro; pending promotion consumed at first
exchange).

## Contract deviations / notes

- Staging PUT error shape: on `maxBytes` overflow the gateway returns
  413 with `{code:'UPLOAD_TOO_LARGE', limit: maxBytes, tier:'default'}`.
  The `tier` field there describes the grant-cap shape from the
  contract (§Gateway endpoints names that code for the tier caps);
  the staging route itself is tier-agnostic and the limit reported is
  the token's. Flagged, not silent.
- Staging bodies are buffered in memory while stream-counting (the
  store interface is whole-object `put(object, bytes)`); the count
  check runs per chunk and aborts before anything is stored, so no
  partial ever lands. Worst case is one declared-size object in
  memory (≤ 256 MiB sanity bound).
- Gateway staging-token verification accepts the upload store's own
  `tokenSecret` as a fallback when it differs from
  `GatewayOptions.uploadTokenSecret` (an injected store may have been
  constructed with its minting secret before the gateway's was
  known). Both are gateway-side configuration; the token remains the
  only accepted auth on those routes.
- Tier-store problems never fail auth: an unavailable/erroring store
  stamps `default` at login while the product endpoints return 503 —
  mirroring the contract's "prod construction failure → product
  endpoints 503, other routes fine."
- Engine/open catalog read errors are swallowed (open proceeds to
  the Phase 2 registry, which remains the fail-closed authority);
  only a positively-read record owned by someone else produces the
  404.

## NOT done

- `set-tier` compiled-bin execution was not run in this pass: the
  coordinator instruction for the completion pass was `tsc --noEmit`
  only, no dist rebuild. The bin is type-checked and its store calls
  are covered by the tier-store unit tests; running
  `npm run build && npm run set-tier -- --user <id> --show` remains a
  coordinator smoke step.
- Firestore/GCS adapters are structural (unit-shaped like
  sessionStore's) but unexercised against real Google clients —
  same posture as the pre-existing prod adapters; local validation
  uses the Local/Memory adapters.
- No git push (per brief; the parent pushes).
