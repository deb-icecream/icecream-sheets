# Worker B — Engine load-by-storage-reference — Report

Product layer, per BRIEF.md §2 + CONTRACT.md §"Engine endpoint". Status: **DONE**, all specified suites green. No git push (per instructions). Only the three assigned files were touched.

## What was built

### 1. `POST /load/storage-ref` — `packages/gateway/src/services/engineSvc.ts`

Body `{ bucket?, object, format?, sessionId? }`, validation in /load's order:

- **Signed-mode session rule identical to /load**: when `accessClaims` are present, `body.sessionId` must be a valid session id equal to `token.sid`, else 401 `engine access denied: wrong-session`. (Also added the route to the three route-class lists so it behaves exactly like /load: signed gate's `introducesSession`, the fenced-owner refusal list, and the released-session exemption.)
- `format`, when given, must be `'xlsx'` → else 400 `only format 'xlsx' is supported`.
- `bucket`, when given, must equal the configured upload bucket → else 400 `bucket does not match the configured upload bucket (<name>)`. Configured bucket resolution: env `UPLOAD_BUCKET` (from `deployEnv`) when set, else the injected dep's `bucket`, else the contract default `'icecream-uploads'`.
- `object` is a relative key: missing/non-string/empty, any `..` path segment, a leading `/`, a Windows drive prefix, or any backslash → 400 `object must be a relative storage object key`.
- Byte resolution (`resolveUploadObjectBytes`): the injected `uploadObjects` dep when present; otherwise the local reader over `UPLOAD_STORE_DIR`, defaulting to `join(sessionDataDir(deployEnv), 'uploads')` — the same defaulting as the gateway's upload store (reuses the already-imported `sessionDataDir()` from `deploy/sessionStore.ts`). Missing/unreadable object (or dep returning null) → 404 `storage object not found`.
- On success it runs the shared tail (below) and the response is the exact /load response JSON plus `storageRef: { bucket, object }` (bucket = the named bucket, or the configured one when unnamed).

New dep on `EngineServiceDeps` (analogous to `libraryDir`): `uploadObjects?: { bucket: string; get(object: string): Promise<Uint8Array | null> }`.

### 2. The shared-tail refactor (boundary, exactly)

Extracted closure `loadBytesIntoSession({ res, bytes, sessionIdRaw, principal, accessClaims, logLabel, extraResponseFields? })`, defined in `createEngineListener` just before the request listener. It covers **everything /load did after its bytes were decoded**, in the original order:

1. `beginLoadBuild()` (W20 build gate) before the parse;
2. `parseWorkbookFast(bytes)` — failure settles the gate with the error and answers 400 `failed to parse xlsx: …`;
3. `buildFromData(data, principal)` — failure likewise (gate + 400);
4. `built.response.timings` merge (parse timings + `buildMs` + `mirrorMs` + `totalMs`);
5. session introduction: `sessionId = valid body.sessionId or newSessionId()`; `state.sourceBytes = bytes.slice()`; `registerSession(sessionId, principal)`; `bindLoadedSession(principal, accessClaims)`; `broadcastSession({ kind: 'load', sessionId })`;
6. `built.response.sessionId = sessionId`; optional `extraResponseFields` merged (storage-ref's `storageRef`); timings `console.log` (`[engine] <logLabel> timings …` — `/load`'s line is byte-identical); `endLoadBuild(buildGate)`; 200 JSON response. Unexpected errors settle the gate and rethrow, exactly /load's old outer catch.

/load's handler is now only: read body → signed session check → format check → base64 decode → `loadBytesIntoSession(...)`. /load/stream was **not** routed through the closure (its tail interleaves with NDJSON emission) and is unchanged. /load's observable behavior is unchanged — guarded by the existing suites below.

### 3. Prod reader construction — `packages/gateway/src/bin/engine.ts`

When `UPLOAD_STORE=prod`: `createProdUploadObjects()` builds `{ bucket, get }` — bucket from `UPLOAD_BUCKET` (default `icecream-uploads`); the `@google-cloud/storage` client is loaded by dynamic import (non-literal specifier, sessionStore `loadProdClients` precedent, since the package is an optional prod-only dependency) with project from `GCP_PROJECT_ID`/`FIREBASE_PROJECT_ID`; `get(object)` downloads from that bucket, any error → `null` (→ route 404, the snapshot store's get posture). **Fail closed at startup**: missing project id or missing package throws before listen (non-zero exit). The reader is injected into `createEngineListener` alongside the existing session-stores dep; any other `UPLOAD_STORE` value leaves the local reader in place.

Verified live against the compiled dist: `UPLOAD_STORE=prod node dist/bin/engine.js` (no project configured) exits 1 with `UPLOAD_STORE=prod requires GCP_PROJECT_ID to be set — refusing to start with a half-configured production upload store (fail closed)`.

### 4. Tests — `packages/gateway/tests/productLoadRef.test.ts` (NEW, 8 tests)

Temp `UPLOAD_STORE_DIR` seeded with a real small xlsx generated via the repo's `XlsxAdapter` (the `engineSvc.test.ts` pattern; sheet `Data`, A1=41, B1=`=A1+1`), plus a decoy `secret.xlsx` placed *outside* the store dir:

1. Happy path → 200, `ok`, `sheets: ['Data']`, `sessionId` matches `/^sess_/`, `storageRef: { bucket: 'icecream-uploads', object }` echo; follow-up `/read` returns A1=41 and B1=42 with formula `=A1+1`.
2. Explicit bucket equal to the configured bucket (+ explicit `format:'xlsx'`) → 200 with echo.
3. Missing object → 404 `storage object not found`.
4. Bucket mismatch → 400.
5. Traversal/absolute/backslash keys (`../secret.xlsx`, `uploads/../../secret.xlsx`, `/secret.xlsx`, `uploads\..\secret.xlsx`) → all 400 (the decoy outside the store is never loaded).
6. `format: 'csv'` → 400.
7. Signed mode (pattern from `deployAccess.test.ts`): wrong `sessionId` → 401 `wrong-session`; missing `sessionId` → 401; correct `sessionId` → 200 with that session id, and a token-scoped follow-up `/read` returns 41.
8. Injected prod reader: bytes served from the dep with nothing on local disk; the dep's bucket is the configured bucket (naming the default bucket instead → 400); dep returning null → 404.

## Test results

After `npx tsc -p tsconfig.json` in `packages/gateway` (clean, no errors):

```
npx vitest run tests/engineSvc.test.ts tests/engineSvcStream.test.ts \
  tests/engineSvcReadDuringBuild.test.ts tests/directSave.test.ts \
  tests/productLoadRef.test.ts
→ Test Files 5 passed (5) · Tests 64 passed (64) · 0 failed
  (engineSvc 36 · engineSvcStream 7 · engineSvcReadDuringBuild 5 ·
   directSave 8 · productLoadRef 8)
```

No /load or /load/stream regression: their existing suites pass unchanged.

## Deviations / notes (flagged, none silent)

- **Configured-bucket precedence**: env `UPLOAD_BUCKET` wins when set; when unset, the injected dep's `bucket` defines the configured bucket; fallback `'icecream-uploads'`. The task text named env as the source; the dep carries a `bucket` field precisely so prod/test construction can name it, and in `bin/engine.ts` the dep's bucket is itself derived from the same env, so both readings coincide in production.
- **Gate-list additions beyond the handler**: `/load/storage-ref` was added to the signed gate's `introducesSession` list, the fenced refusal list, and the released-session exemption. Without these it could not introduce a session in signed mode (401 before the handler), would serve on a fenced owner, and could not reopen after an idle release — all contrary to "signed-mode session rule identical to /load" / "the /load path EXACTLY". This is inside the assigned file and changes no other route's behavior.
- **Prod `get` error mapping**: any GCS download error (not just not-found) maps to `null` → 404, mirroring `FirestoreSessionStores.snapshots.get` in sessionStore.ts. A credentials/permission failure in prod would therefore surface as 404s at load time rather than a distinct error — startup construction itself still fails closed.
- The instructed `npx tsc` run regenerated `packages/gateway/dist/` build output as a byproduct (tsconfig `outDir`); no dist files were hand-edited.
- NOT DONE: nothing in scope. The gateway-side upload issuance/store (Worker A) and any end-to-end gateway→engine storage-ref call are other workers' surfaces; at the time of this build no `uploadStore` existed in the gateway tree yet, so the engine's local default (`<sessionDataDir>/uploads`, env `UPLOAD_STORE_DIR`) was implemented from the contract text to match it.
