# Product Layer — shared CONTRACT (all workers build to this)

Companion to BRIEF.md (same directory). Where they disagree, BRIEF.md
wins; flag it. Conventions: gateway error JSON is
`{ ok:false, error, ...extra }` (httpUtils.sendError supports extra).
All /api/files* routes run INSIDE the gateway's existing auth +
per-principal rate-limit pipeline (Bearer gateway JWT → principal
`user:<userId>`).

## Tiers
- Tier = `'default' | 'pro'`. Constants (gateway):
  `DEFAULT_UPLOAD_MAX_BYTES = 1_285_214` (env `TIER_DEFAULT_UPLOAD_MAX_BYTES`),
  `DEFAULT_FILE_LIMIT = 10` (env `TIER_DEFAULT_FILE_LIMIT`).
- UserTierStore record: `{ userId, email?, tier, createdAt, updatedAt }`
  + pending promotions by email (email→tier, consumed at first record
  creation). `resolveTier({userId, email?})` → tier, creating/updating
  the record (backfill email). `setTierByEmail(email, tier)`,
  `setTierByUserId(userId, tier)`, `getRecord(userId)`.
- Adapters: Local (JSON file + lockfile mutex, LocalFileRegistry
  pattern), Memory, Firestore-shaped (collection `icecream_user_tiers`,
  structural FirestoreLike from deploy/sessionStore.ts). Factory
  `createUserTierStore(env, {firestoreDb?})` fails CLOSED in prod
  (`USER_STORE=prod`) without an injected client. Env: `USER_STORE`,
  `USER_STORE_DIR` (default `<sessionDataDir>/user-store`).
- Stamp: POST /auth/firebase AND POST /auth/login resolve the tier and
  put it in the JWT attrs as `tier`, and in the JSON response as `tier`.

## File catalog
UserFileRecord:
```
{ fileId, ownerPrincipal, name, origin: 'upload'|'created',
  sizeBytes, storageRef: { bucket, object } | null,
  libraryEntryId: string | null, hasStoredState: boolean,
  createdAt, updatedAt, lastOpenedAt }
```
UserFileCatalog: create/get/listByOwner (lastOpenedAt DESC)/
update(patch)/remove/countByOwner/touchOpened. Same adapter posture
as the tier store (Local/Memory/Firestore-shaped collection
`icecream_user_files`; factory `createUserFileCatalog`, same env/dir
family, file `user-files.json`).
fileId mint: `file-<randomUUID()>` (same shape as /api/engine/open).

## Upload object store
UploadObjectStore (bytes only):
```
{ bucket, put(object, bytes), get(object) -> bytes|null,
  stat(object) -> { size } | null, delete(object),
  putUrl(object, { principal, maxBytes, ttlSeconds }) -> { url, expiresAt },
  getUrl(object, { principal, ttlSeconds }) -> { url, expiresAt } }
```
- Local adapter: root `UPLOAD_STORE_DIR` (default
  `<sessionDataDir>/uploads`); bucket from `UPLOAD_BUCKET` (default
  `icecream-uploads`). putUrl/getUrl return GATEWAY STAGING URLs:
  `<publicBase>/uploads/stage/<encodeURIComponent(object)>?ut=<token>`
  — publicBase injected at construction (GatewayOptions /
  bin sets from GATEWAY_PUBLIC_URL or `http://127.0.0.1:<PORT>`).
- Upload tokens (deploy/uploadTokens.ts or inside uploadStore.ts):
  same HMAC scheme as engineAccess storage tokens.
  Payload `{ v:1, op:'put'|'get', object, principal, maxBytes?, exp }`,
  secret = ENGINE_ACCESS_SECRET (gateway storageSign secret path);
  `issueUploadToken` / `verifyUploadToken` (throws EngineAccessError).
- GCS adapter: structural StorageLike (sessionStore.ts precedent),
  dynamic-imported real client ONLY in bins when `UPLOAD_STORE=prod`;
  putUrl = GCS v4 signed URL with maxBytes enforced via
  content-length-range condition if the client supports it, else the
  complete-step actual-size check is the enforcement (it always runs).
  Factory `createUploadObjectStore(env, opts)` fails closed in prod
  without an injected client.
- Object key for an upload: `uploads/<sha256(ownerPrincipal).hex[0:16]>/<fileId>.xlsx`.

## Gateway endpoints (Worker A)
- `GET /api/files` → `{ ok:true, tier, limits:{ uploadMaxBytes:number|null, fileLimit:number|null }, count, files:[UserFileRecord] }` (limits null for pro).
- `POST /api/files` `{ name }` → create origin 'created' (count check
  for Default: count >= limit → 409 sendError extra
  `{ code:'FILE_LIMIT_REACHED', limit, count, tier:'default' }` and a
  message naming the limit + Pro). 201 `{ ok:true, file }`.
- `GET /api/files/:fileId` → `{ ok:true, file }`; missing OR not owner → 404.
- `PATCH /api/files/:fileId` `{ name?, hasStoredState?, libraryEntryId? }` → updated record. Owner-only (404 otherwise).
- `DELETE /api/files/:fileId` → delete record + staged object (if storageRef). `{ ok:true }`.
- `POST /api/files/upload-grant` `{ name, size }`:
  - size must be a positive integer ≤ 256 MiB sanity bound.
  - Default tier: `size > DEFAULT_UPLOAD_MAX_BYTES` → 413
    `{ code:'UPLOAD_TOO_LARGE', limit, size, tier:'default' }`, message:
    names the limit in bytes, the file's size, and that Pro is
    unrestricted. Count check → 409 FILE_LIMIT_REACHED (same shape).
  - Success: mint fileId + object key, `putUrl`, respond
    `{ ok:true, fileId, object, upload:{ url, expiresAt, method:'PUT' } }`.
    NO catalog record yet.
- `POST /api/files/:fileId/complete-upload` `{ name }`:
  - stat object → missing: 404 `{ code:'UPLOAD_NOT_FOUND' }`.
  - ACTUAL size re-check vs tier cap → violation: DELETE object, 413
    UPLOAD_TOO_LARGE (same shape). Count re-check → 409 (object kept
    out of the catalog; delete object too — no orphans).
  - Create record (origin 'upload', sizeBytes = actual,
    storageRef = { bucket, object }). Idempotent: existing record for
    this fileId+owner → return it. 201 `{ ok:true, file }`.
- `POST /api/files/:fileId/download-grant`:
  - If `libraryEntryId` → `{ ok:true, url }` = engine storage URL via
    issueStorageToken + engine origin (same origin resolution as
    /api/storage/sign).
  - Else if `storageRef` → store.getUrl(object) `{ ok:true, url }`.
  - Else (created, never stored) → 409 `{ code:'NO_STORED_BYTES' }`.
- Staging routes (top level, NOT under /api; token IS the auth):
  - `PUT /uploads/stage/<enc-object>?ut=<token>` — verify token
    (op 'put', object match, exp); stream-count bytes; exceeding
    token maxBytes → abort, delete partial, 413. Store put → 200
    `{ ok:true, object, size }`.
  - `GET /uploads/stage/<enc-object>?ut=<token>` — verify (op 'get');
    serve bytes, `content-type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
    `content-disposition: attachment`.
  - No/invalid token → 401. These routes bypass the JWT pipeline
    (they sit beside /auth/* handling, before the /api 404 fallthrough).
- `/api/engine/open` addition: catalog lookup by fileId — record
  exists && ownerPrincipal !== principal → 404 'file not found' (no
  existence leak); record exists && owner → touchOpened(fileId) then
  proceed unchanged. No record → unchanged Phase 2 behavior.
- GatewayOptions gains optional: `userTierStore`, `userFileCatalog`,
  `uploadStore`, `uploadTokenSecret`, `uploadPublicBaseUrl`.
  Defaults construct from env (local adapters); prod construction
  failure → product endpoints 503 fail-closed (mirror fileRegistry
  posture), other routes unaffected.
- `bin/set-tier.ts`: `--email <e>|--user <uid> --tier default|pro`
  (+ optional `--show`); uses createUserTierStore(process.env); prints
  the resulting record/pending entry as JSON; exit 0/1/2. Add
  `"set-tier": "node dist/bin/set-tier.js"` to gateway package.json.
  bin/gateway.ts: construct stores, pass into createGateway; log a
  one-line product-layer status (like the engineAccess log lines).

## Engine endpoint (Worker B)
- `POST /load/storage-ref` in engineSvc, body
  `{ bucket?, object, format?: 'xlsx', sessionId? }`:
  - Signed-mode session rule IDENTICAL to /load (body.sessionId ===
    token.sid when accessClaims present).
  - bucket, when given, must equal the configured upload bucket
    (env UPLOAD_BUCKET, default 'icecream-uploads') → else 400.
  - Resolve bytes via an engine-side upload-object reader: local —
    read `UPLOAD_STORE_DIR` (default `<sessionDataDir>/uploads`, same
    defaulting as the gateway's store so one env configures both);
    missing → 404 'storage object not found'. Prod — injected
    StorageLike reader constructed in bin/engine.ts when
    UPLOAD_STORE=prod, fail closed at startup (session-store
    precedent); engineSvc dep: `uploadObjects?: { bucket, get(object) }`.
  - Then the /load path EXACTLY: build gate, parseWorkbookFast,
    buildFromData, state.sourceBytes, registerSession,
    bindLoadedSession, broadcast, response JSON (= /load response)
    plus `storageRef: { bucket, object }` echo.
  - Refactor minimally: extract /load's post-bytes tail into a closure
    both handlers call; do not change /load or /load/stream behavior.

## Web (Worker C) — new files only under apps/web/src/product/
- `productApi.ts`: ProductApi over GatewayClient (constructor takes a
  GatewayClient). Types mirror the contract. Methods: `me()`,
  `listFiles()`, `createFile(name)`, `renameFile(id, name)`,
  `deleteFile(id)`, `markOpened(id, patch)` (PATCH),
  `uploadGrant(name, size)`, `completeUpload(fileId, name)`,
  `downloadGrant(fileId)`, `uploadFile(file: File): Promise<UserFileRecord>`
  (grant → PUT bytes to upload.url (fetch, no gateway auth header —
  the URL is the grant) → complete). `ProductApiError extends Error`
  carrying `status`, `code`, and the server's `error` message VERBATIM.
- `deepLink.ts`: `fileIdFromSearch(search)`, `fileIdFromHash(hash)`
  (legacy), `fileIdFromUrl(loc)`, `buildFileUrl(fileId)` (origin +
  pathname + `?file=`), `stashReturnFile(id)`, `takeReturnFile()`
  (sessionStorage key `icecream-sheets.return-file`, read-once).
- `LandingPage.tsx`: props `{ loggedIn: boolean, onSignIn(): void,
  onOpenWorkspace(): void }`. Rich + visual; sections: top nav
  (wordmark, Sign in / Open workspace), hero (plain-English headline
  on the two pillars, hero image `/product/hero-dashboard.png`, CTA),
  AI-native section (image `/product/collab.png`), data-native
  section (image `/product/pivotchart.png`), capabilities strip
  (inline SVG icons + one-liners), **Default vs Pro** section (labels
  EXACTLY "Default" and "Pro"; never the word "free" as a tier name —
  avoid the word in the tiers section entirely), footer. Semantic,
  accessible markup (headings order, alt text).
- `Workspace.tsx`: props `{ api: ProductApi, onOpenFile?: (fileId) => void }`
  (default onOpenFile: `window.location.assign(buildFileUrl(fileId))`).
  Real anchor `<a href={buildFileUrl(f.fileId)}>` for file names
  (click ALSO calls onOpenFile via preventDefault only when a custom
  handler is supplied). Sections: header ("Icecream Sheets Workspace",
  tier badge, Default count meter "N of 10 files"), Recents (first 5
  by lastOpenedAt), All files table (name link, size formatted,
  modified relative time, origin tag "Uploaded"/"Created", actions:
  Download (downloadGrant → open URL), Rename (inline prompt-style
  editor), Delete (confirm)), Upload control (hidden file input;
  errors shown VERBATIM from ProductApiError in an alert region),
  "New spreadsheet" button (name prompt → createFile → onOpenFile),
  empty state (no files: upload/create CTAs). Upload success → refresh
  list. All data via api; loading + error states rendered.
- `product.css`: scoped styles, every selector prefixed `.ics-`;
  Landing + Workspace import it themselves. No global resets.
- Images: copy into `apps/web/public/product/`:
  hero-dashboard.png ← hidden_files/direct-save-pass/tour-p75/p75ds-sheet-12-Dashboard.png;
  pivotchart.png ← hidden_files/cycle10-completion-shots/pivotchart-loaded.png;
  collab.png ← hidden_files/phase2-coauthoring/leg-a/shots/s02-alice-converged.png.
- Tests (web vitest patterns — see components/FirebaseLoginButton.test.tsx
  + services tests): deepLink.test.ts; productApi.test.ts (stub
  GatewayClient); LandingPage.test.tsx (renders pillars, CTA, tier
  labels exactly Default/Pro); Workspace.test.tsx (recents order,
  anchor hrefs carry ?file=, cap error shown verbatim, meter text).
  Tests live alongside in product/ (vitest config includes src).

## Apps slot (Workspace shell — user directive 2026-10-21 16:20 PDT)
The Workspace hosts an **Apps** section: the generated-apps gallery
(built by the app-gallery coordinator: real generated apps with bound
sheet + preview, Reopen/Duplicate/Share — sharing is done from the
gallery). The Workspace frame is the product layer's; the gallery
component and its actions are the gallery coordinator's.
- `Workspace` accepts `appsSlot?: React.ReactNode`. When provided, the
  shell renders `<section className="ics-apps" aria-labelledby=
  "ics-apps-title"><h2 className="ics-section-title" id="ics-apps-
  title">Apps</h2>{appsSlot}</section>` as the LAST section of the
  workspace (after All files; also rendered when the file list is
  empty). When `appsSlot` is absent the section does not render at
  all (no empty placeholder).
- Integration (app shell, post-Phase-2): construct the gallery
  coordinator's component and pass it as `appsSlot`. The gallery
  brings its own data/actions; the shell provides only the frame,
  the heading, and the shared `.ics-` styling context. Bound-sheet
  navigation from the gallery uses the same deep link
  (`buildFileUrl(fileId)`) as the file list.
- Tier-claim note (voice command palette is a Pro feature, separate
  coordinator): the tier is readable by feature code from the
  gateway JWT `attrs.tier`, from both login responses' `tier` field,
  and from `ProductApi.me()` — no additional surface is needed.

## Received share copies + shared app links (user design 2026-10-21 16:25 PDT)
- Accepting a share (gallery coordinator's mechanics) places a COPY
  (app + data) in the signed-in recipient's workspace. The data copy
  is a normal catalog entry owned by the recipient with
  `origin: 'shared'` — the union is widened in the catalog
  (userStore.ts), the web types (productApi.ts), and the Workspace
  renders it with a "Shared" tag in Recents + the All-files table,
  deep-linked like any other entry. Received APP copies list in the
  Apps section (the gallery component's own rendering via the slot).
- OPEN POLICY QUESTION (not decided by the product layer): whether
  received copies count toward the recipient's Default 10-file cap.
  Mechanically they do if catalog-created (count = records per
  owner); the accept flow bypassing or honoring the cap is the
  gallery flow's / user's call — flagged to the parent.
- Shared APP links open the app FULL SCREEN with a restore action
  returning to the working view (grid + app in the chat area) —
  gallery/app-shell behavior. INTEGRATION NOTE for the parked
  App.tsx routing step: the app shell must route the gallery's
  app/share link form (their `sharesApi.buildShareLink`) to the
  full-screen app view BEFORE falling through to the `?file=` /
  workspace defaults, and the restore action returns to the
  working view.

## Validation hooks (coordinator runs later; workers enable it)
- Local stack on ALTERNATE ports (18100 gateway / 18101 engine) with
  scratch SESSION_DATA_DIR so Phase 2's stack/dirs are untouched.
- Two /auth/login users (default + set-tier-promoted pro) drive the
  caps transcript; firebase exchange path covered by unit tests with
  the firebaseTestKeys pattern.
