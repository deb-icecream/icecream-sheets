# W22 — Uploads-ruling documentation results (Cycle 10 closure)

Worker: uploads-ruling documentation (W22). Input: USER RULING
(2026-10-21 00:28 PDT) — gateway-issued signed-URL direct upload to
Cloud Storage is APPROVED as the production load design, resolving the
Cloud Run HTTP/1 32 MiB request-cap discrepancy W17a flagged.

Scope honored: `deploy/` artifacts + docs only. **No product code**
(`packages/*/src`, `apps/web/src` untouched — verified by grep, see §5),
no `perf-evaluation.md` / `progress.md` / `TODO.md` / `design-docs/`
edits, no push, no stack restarts, no loads. `deploy.sh` WAS touched,
so its credential gate + dry-run were re-run (§3). Note: the whole
`deploy/` tree is currently **untracked in git** (`git status` shows
`?? deploy/`), so changes are verified by content + the dry-run/render
checks below, not by `git diff`.

Design in one line: the client uploads file bytes straight to GCS with
a short-lived signed URL issued by the gateway after auth validation;
the engine pulls the file from GCS; no file bytes flow through gateway
or engine request bodies.

## 1. Files changed (6, all under `deploy/`)

| File | Change |
|---|---|
| `deploy/CONFIG.md` | Storage bullet gains the uploads bucket; NEW "Production load path" section (the ruling, the platform-limit resolution, exists-vs-follow-on table); gateway table gains `UPLOAD_BUCKET` + `UPLOAD_SIGNED_URL_TTL_SECONDS` rows; engine table gains `UPLOAD_BUCKET` + `GCP_PROJECT_ID` rows; web section gains the no-new-build-env note |
| `deploy/deploy.sh` | Header gains the load-path paragraph + the optional-TTL line; `BUCKET_UPLOADS` + `UPLOAD_SIGNED_URL_TTL_SECONDS` (default 900) variables; step 3 creates the uploads bucket; step 4 grants the gateway SA its signing/object roles (engine's existing `storage.objectAdmin` noted as already covering the pull); both new vars join `V_COMMON` + exports; `--help` print range widened 2,45 → 2,74 to match the grown header. **Credential gate untouched** (same `require` list — neither new var belongs in it: the TTL has a default, the bucket name is derived from `GCP_PROJECT`) |
| `deploy/services/gateway.yaml` | Header note on upload issuance; env `UPLOAD_BUCKET=${BUCKET_UPLOADS}` + `UPLOAD_SIGNED_URL_TTL_SECONDS=${UPLOAD_SIGNED_URL_TTL_SECONDS}`. W19's `SERVICE_COMBINED="on"` and all five `*_URL=${SERVICE_URL}` entries untouched (render-verified, §3) |
| `deploy/services/engine-standard.yaml` | Header note on load-by-GCS-reference; env `UPLOAD_BUCKET=${BUCKET_UPLOADS}` + `GCP_PROJECT_ID=${GCP_PROJECT}` |
| `deploy/services/engine-xl.yaml` | Same two env entries + a header pointer to engine-standard's note |
| `deploy/README.md` | Billing/storage section gains the load-path bullet pointing at CONFIG.md |

NOT changed: `deploy/services/service.yaml`, `deploy/services/mcp.yaml`
(no upload role — service is stateless/behind the gateway, MCP never
carries loads), `firebase.json` (Hosting only; uploads go browser→GCS,
never through Firebase), all Dockerfiles/entrypoints.

## 2. Exact wording added

### 2a. `deploy/CONFIG.md` — new section (verbatim, inserted after the deployed-inventory section)

> ## Production load path — signed-URL direct upload to Cloud Storage (user ruling, 2026-10-21)
>
> **Design-approved (user ruling, 2026-10-21 00:28 PDT):** in production a
> file load NEVER travels as a request body through the gateway or the
> engine. The production load path is:
>
> 1. The client asks the **gateway** for an upload grant. The gateway runs
>    the **same authentication + rate-limit checks as engine-access
>    issuance** (`POST /api/engine/access`, W17b) and, on success, returns
>    a **short-lived signed URL** for one PUT to Cloud Storage —
>    TTL `UPLOAD_SIGNED_URL_TTL_SECONDS` (default 900 s), **scoped to the
>    authenticated user + the single target object** in the uploads
>    bucket (`UPLOAD_BUCKET`). A leaked URL authorizes one object write,
>    for minutes, and nothing else.
> 2. The client uploads the file bytes **directly to Cloud Storage** with
>    that URL (browser → GCS). No file bytes flow through gateway or
>    engine request bodies.
> 3. The client then opens the workbook by **GCS reference** (bucket +
>    object) through its normal engine-access grant; the **engine pulls
>    the object from GCS via its own service account** (its existing
>    project-level `roles/storage.objectAdmin`, `deploy.sh` step 4,
>    already covers the read) and builds from those bytes.
>
> **Platform-limit resolution (the W17a discrepancy, now closed for
> loads):** Cloud Run caps **HTTP/1 requests at 32 MiB** — the wall W17a
> flagged against the design doc's 256 MB load-body assumption (the P99
> fixture alone is 44 MB). Under this ruling the cap is **moot for
> loads**: load bytes never form a Cloud Run request body at all, so no
> HTTP/2 rework and no chunked-upload protocol are needed for the load
> path. The cap still bounds every remaining HTTP/1 request body
> (edits/control traffic are far below it); the separate HTTP/1
> *response*-cap note for downloads/saves (W17a) is unaffected by this
> ruling.
>
> **What exists today vs the code follow-on (be precise):**
>
> | Piece | State |
> |---|---|
> | Engine-access signed tokens: gateway issuance (`POST /api/engine/access` after JWT auth + rate limiting), engine-side verification, tier selection | ✅ **exists** (W17b, `packages/gateway/src/deploy/engineAccess.ts`; TTL `ENGINE_ACCESS_TTL_SECONDS`, default 600) — the upload grant reuses this issuance posture, it is NOT a second auth path |
> | GCS access from service code: `SnapshotStore` adapter over `@google-cloud/storage` (`FirestoreSessionStores.snapshots` in `packages/gateway/src/deploy/sessionStore.ts`, bucket from `SESSION_SNAPSHOT_BUCKET`, fail-closed prod config) | ✅ **exists** — proves the GCS client pattern + service-account access; it serves session snapshots only, NOT uploads |
> | Uploads bucket provisioning + the `UPLOAD_BUCKET` / `UPLOAD_SIGNED_URL_TTL_SECONDS` deploy surface (this change, W22) | ✅ **exists in `deploy/`** (deploy.sh step 3/4 + gateway/engine YAML env) — scripted-but-gated like every bucket step; no code reads these vars yet |
> | Gateway upload-issuance endpoint (mint the GCS V4 signed PUT URL after the engine-access checks; gateway SA signs via its own identity — `roles/iam.serviceAccountTokenCreator` on itself + `roles/storage.objectCreator` on the uploads bucket, both granted in `deploy.sh` step 4) | 🔴 **code follow-on** — no endpoint, no `getSignedUrl`/signing call exists in product code today |
> | Engine load-by-GCS-reference (open accepts `{ bucket, object }`, engine fetches the bytes itself; today's `/load` + `/load/stream` take `{ format, data: base64 }` bodies capped at `LOAD_MAX_BODY_BYTES` = 256 MB) | 🔴 **code follow-on** |
> | Client upload flow (request grant → PUT bytes to the signed URL → open by GCS reference; today's web client posts the bytes to the engine through the gateway/engine transport) | 🔴 **code follow-on** — needs no new build-time env: issuance rides the existing `VITE_GATEWAY_URL`, the PUT target comes back at runtime |
> | Uploads-bucket CORS for the web origin (browser PUT from the Firebase Hosting origin) + a lifecycle rule expiring un-opened staged objects | 🔴 **deploy follow-on** — belongs with the issuance-endpoint change, once the production web origin is fixed |
>
> The local/dev topology is unchanged: gateway-proxied body loads remain
> the local path; this ruling governs the production (Cloud Run) load
> path only.

CONFIG.md precision note: CONFIG.md previously carried **no**
standalone platform-limit note — the 32 MiB discrepancy lived in W17a's
results (§5). The paragraph above is that note, added to CONFIG.md
with its resolution, per the tasking. The storage bullet in the
inventory section now reads (uploads clause added): "…direct-upload
staging (the production load path, next section) → bucket
`${GCP_PROJECT}-icecream-uploads`. All three are created by `deploy.sh`
step 3…". New per-service rows (gateway: `UPLOAD_BUCKET`,
`UPLOAD_SIGNED_URL_TTL_SECONDS`; engine: `UPLOAD_BUCKET`,
`GCP_PROJECT_ID`) are each marked in the "Read by code?" column as
**design-approved — code follow-on (W22)** (except `GCP_PROJECT_ID`,
which sessionStore's prod config already reads). Web section note:
"The signed-URL upload flow (production load path, above) adds **no**
web build-time config: the client requests the upload grant through
the existing `VITE_GATEWAY_URL` and PUTs to the signed GCS URL returned
at runtime. (The client half of that flow is a code follow-on — W22.)"

### 2b. `deploy/deploy.sh` — added lines (verbatim)

Header (after the billing/storage paragraph):

```
# Production load path (user ruling, 2026-10-21): file bytes are NEVER
# a gateway/engine request body in production. The gateway issues a
# short-lived signed URL (after the same auth + rate-limit checks as
# engine-access issuance), the client uploads the bytes DIRECTLY to the
# uploads bucket in Cloud Storage, and the engine pulls the object from
# GCS via its service account. This makes Cloud Run's 32 MiB HTTP/1
# request cap moot for loads (W17a's flagged discrepancy — resolved).
# Deploy surface here: the uploads bucket (step 3), the gateway SA's
# signing/object grants (step 4), and the UPLOAD_BUCKET /
# UPLOAD_SIGNED_URL_TTL_SECONDS env on gateway + engine definitions.
# The issuance endpoint / engine pull / client flow are product-code
# follow-ons — see deploy/CONFIG.md's load-path section.
```

Optional-env header line:

```
#   UPLOAD_SIGNED_URL_TTL_SECONDS  default 900 (lifetime of the gateway-
#                          issued GCS upload signed URL; user + target
#                          object scoped — see CONFIG.md load-path section)
```

Variables:

```bash
UPLOAD_SIGNED_URL_TTL_SECONDS="${UPLOAD_SIGNED_URL_TTL_SECONDS:-900}"
BUCKET_UPLOADS="${GCP_PROJECT}-icecream-uploads"    # direct-upload staging (production load path, user ruling 2026-10-21)
```

Step 3 (comment extended + third bucket create):

```bash
run "$GCLOUD" storage buckets create "gs://${BUCKET_UPLOADS}" --project="$GCP_PROJECT" \
  --location="$REGION" --uniform-bucket-level-access
```

Step 4 (after the engine's existing `storage.objectAdmin` binding):

```bash
# Upload issuance (production load path, user ruling 2026-10-21): the
# gateway mints V4 signed PUT URLs for the uploads bucket with its own
# service-account identity — it needs the token-creator role ON ITSELF
# (IAM signBlob; Cloud Run has no SA key file) and object-create on the
# uploads bucket (the permission the signed PUT is checked against).
run "$GCLOUD" iam service-accounts add-iam-policy-binding "$GATEWAY_SA" \
  --project="$GCP_PROJECT" \
  --member="serviceAccount:${GATEWAY_SA}" --role="roles/iam.serviceAccountTokenCreator" || true
run "$GCLOUD" storage buckets add-iam-policy-binding "gs://${BUCKET_UPLOADS}" \
  --member="serviceAccount:${GATEWAY_SA}" --role="roles/storage.objectCreator" || true
```

Render plumbing: `${BUCKET_UPLOADS} ${UPLOAD_SIGNED_URL_TTL_SECONDS}`
appended to `V_COMMON` and both names added to the `export` line, so
every service render receives them (only gateway/engine YAMLs consume
them). Step 3's old comment line "the browser never touches them" was
corrected — the browser now DOES touch the uploads bucket, via GCS
signed URL (never Firebase Storage).

### 2c. Service YAML env entries (verbatim)

gateway.yaml (plus a header paragraph stating the same design):

```yaml
            - name: UPLOAD_BUCKET
              value: ${BUCKET_UPLOADS}   # W22: production load path — gateway issues signed PUT URLs into this GCS bucket (code follow-on; see header)
            - name: UPLOAD_SIGNED_URL_TTL_SECONDS
              value: ${UPLOAD_SIGNED_URL_TTL_SECONDS}   # W22: signed upload URL lifetime (deploy.sh default 900 s), user + target-object scoped
```

engine-standard.yaml / engine-xl.yaml:

```yaml
            - name: UPLOAD_BUCKET
              value: ${BUCKET_UPLOADS}   # W22: production load path — engine pulls the opened object from this bucket via its SA (code follow-on)
            - name: GCP_PROJECT_ID
              value: ${GCP_PROJECT}       # W22: project for the engine's GCS clients (upload pull; sessionStore prod config reads the same var)
```

### 2d. `deploy/README.md` — added bullet (verbatim)

> - **Production load path (user ruling, 2026-10-21):** a third bucket,
>   `<project>-icecream-uploads` (also created by `deploy.sh`), stages
>   direct uploads — the gateway issues a short-lived signed PUT URL
>   (same auth + rate-limit checks as engine-access issuance), the client
>   uploads bytes straight to GCS, and the engine pulls the object via
>   its service account. No file bytes flow through gateway/engine
>   request bodies, so Cloud Run's 32 MiB HTTP/1 request cap is moot for
>   loads. Full design + what exists vs code follow-on: `CONFIG.md`,
>   "Production load path" section.

## 3. Re-verification (deploy.sh was touched)

**Syntax:** `bash -n deploy/deploy.sh`, `bash -n deploy/build-web.sh`,
`sh -n` on both entrypoints → ALL OK.

**Credential gate (env cleared, re-run):** exit **78**, "DEPLOY BLOCKED
— credential gate. Nothing was deployed." with the exact same missing
list as W17a/W17c (GCP_PROJECT, REGION, FIREBASE_PROJECT_ID,
FIREBASE_TOKEN, AUTH_SECRET_VALUE, MCP_AUTH_SECRET_VALUE,
ENGINE_SIGNING_SECRET_VALUE, VAULT_KEY_VALUE). Gate behavior unchanged
— not weakened, not expanded (the two new vars correctly stay out of
it: TTL defaulted, bucket name derived).

**Dry-run (dummy env, `--dry-run`):** exit **0**, **58** `[dry-run]`
command lines (W17c baseline 55; delta = exactly +3: uploads bucket
create + 2 IAM bindings), executed nothing. Key lines:

```
[dry-run] … storage buckets create gs://dummy-proj-icecream-files …
[dry-run] … storage buckets create gs://dummy-proj-icecream-snapshots …
[dry-run] … storage buckets create gs://dummy-proj-icecream-uploads --project=dummy-proj --location=us-central1 --uniform-bucket-level-access
[dry-run] … iam service-accounts add-iam-policy-binding icecream-gateway@dummy-proj.iam.gserviceaccount.com … --role=roles/iam.serviceAccountTokenCreator
[dry-run] … storage buckets add-iam-policy-binding gs://dummy-proj-icecream-uploads --member=serviceAccount:icecream-gateway@… --role=roles/storage.objectCreator
```

Exactly **5** `gcloud run services replace` (five-service inventory
preserved); the only Firebase command remains
`firebase deploy --only hosting` — no Firebase Storage step exists.

**YAML parse + envsubst render** (W17c/W19 method: python-yaml parse of
raw + render restricted to the var list deploy.sh passes per file):

```
gateway:         raw-parse OK; render-parse OK; name=gateway;         unsubstituted=[]
   UPLOAD_BUCKET = dummy-proj-icecream-uploads · UPLOAD_SIGNED_URL_TTL_SECONDS = 900 · SERVICE_COMBINED = on
engine-standard: raw-parse OK; render-parse OK; name=engine-standard; unsubstituted=[]
   UPLOAD_BUCKET = dummy-proj-icecream-uploads · GCP_PROJECT_ID = dummy-proj
engine-xl:       raw-parse OK; render-parse OK; name=engine-xl;       unsubstituted=[]
   UPLOAD_BUCKET = dummy-proj-icecream-uploads · GCP_PROJECT_ID = dummy-proj
service:         raw-parse OK; render-parse OK; name=service;         unsubstituted=[]
mcp:             raw-parse OK; render-parse OK; name=mcp;             unsubstituted=[]
ALL OK
```

## 4. Consistency cross-checks (W19 / W17c — not disturbed)

- **W19 `SERVICE_COMBINED`:** gateway.yaml still sets `"on"`, all five
  service-family `*_URL` still render to the single `${SERVICE_URL}`,
  CONFIG.md's W19 row untouched; the render check above re-confirms
  `SERVICE_COMBINED = on`. My gateway.yaml edits are append-only
  (header paragraph + two env entries after the W19 entry).
- **W17c final inventory:** still exactly FIVE Cloud Run services
  (dry-run shows 5 replaces, in the same dependency order); the uploads
  bucket is platform storage, not a sixth service — the same category
  as the files/snapshots buckets and Firestore in W17c §3. Combined
  `service` definition, sizing, and lifetime models untouched.
- **Billing model:** uploads bucket lives in the GCP project on GCP
  credit, like the other two buckets; Firebase remains free-plan
  Hosting + Auth only; no Firebase Storage anywhere.

## 5. Code follow-on list (for the coordinator's report)

Exists today (verified by grep this run — do not re-report as missing):

- W17b engine-access signed tokens end-to-end: issuance
  `POST /api/engine/access` in `packages/gateway/src/gateway.ts` after
  JWT auth + rate limiting, token issue/verify in
  `packages/gateway/src/deploy/engineAccess.ts`
  (`ENGINE_ACCESS_TTL_SECONDS`, default 600), engine-side verification
  in `services/engineSvc.ts`, client `SignedEngineTransport`.
- GCS from service code: `FirestoreSessionStores.snapshots`
  (`SnapshotStore`) in `packages/gateway/src/deploy/sessionStore.ts`
  over the `@google-cloud/storage` structural client, bucket from
  `SESSION_SNAPSHOT_BUCKET`, prod config fail-closed. Snapshots only.

Remains to build (product code — NOT done here, deploy surface only):

1. **Gateway upload-issuance endpoint** — e.g. `POST /api/engine/upload-url`
   beside the engine-access issuance: same JWT auth + per-principal
   rate limiting, then mint a GCS V4 signed PUT URL
   (`UPLOAD_BUCKET`, one target object namespaced to the user,
   `UPLOAD_SIGNED_URL_TTL_SECONDS` TTL). No `getSignedUrl`/signing call
   exists anywhere in product code today (grep-verified: only Sheets
   API "v4" hits). Signing uses the gateway SA identity via IAM
   signBlob (roles granted by deploy.sh step 4 in this change).
2. **Engine load-by-GCS-reference** — `/load` + `/load/stream` (or a
   sibling route) accepting `{ bucket, object }` (reading `UPLOAD_BUCKET`
   as the default/allow-listed bucket) with the engine fetching bytes
   via its SA, instead of today's `{ format, data: base64 }` body
   (`LOAD_MAX_BODY_BYTES` = 256 MB in both `gateway.ts` and
   `engineSvc.ts`). The engine-access token's session scope check
   (`/load` requires `body.sessionId === token.sid`) must carry over.
3. **Client upload flow** — web: request the grant from the gateway,
   PUT the bytes directly to the signed URL, then open by GCS
   reference through the existing engine-access grant. Today's client
   posts bytes through the gateway/engine transport. No new build-time
   env needed.
4. **Deploy follow-ons riding with #1:** uploads-bucket CORS for the
   Firebase Hosting origin (browser PUT preflight) and a bucket
   lifecycle rule expiring staged objects that were never opened.
   Neither is scripted yet — both belong with the endpoint change,
   once the production web origin is fixed.
5. Local/dev keeps the body-load path; the follow-on should gate the
   GCS path on the production config (`UPLOAD_BUCKET` present /
   signed mode), exactly as W17b gated signed engine access, so the
   local topology stays byte-identical by default.

## 6. Design-doc conflict flags — FLAGGED, NOT EDITED

`design-docs/deployment-architecture.md` was read and NOT modified
(the doc is the user's to amend). Two points of friction with the
ruling, plus two confirmations:

- 🔴 **"Compute choice" section:** "Gateway must accept 256 MB bodies
  on the load route; Functions caps payloads at 32 MB." — The ruling
  supersedes the premise: the production gateway accepts **no** load
  body at all. The Functions rejection itself still stands on the
  doc's other two grounds (engine statefulness; streaming/service
  traffic), but this sentence's stated reason is now obsolete and
  should be amended by the user to cite the signed-URL upload design.
- 🔴 **"Engine access pattern" item 2:** "Loads, streams, edits, and
  saves flow client ↔ engine with no gateway in the data path." —
  True for streams/edits/saves; the **load leg** under the ruling is
  client → GCS → engine-pull, not a direct client↔engine transfer.
  The sentence needs a load-path carve-out (gateway-issued upload URL
  + engine pull from GCS) when the user next amends the doc.
- ✅ No conflict — "Storage" section ("Cloud Storage: original file
  bytes + session snapshots"): the uploads bucket is staging for
  original file bytes; the doc does not fix a bucket split.
- ✅ No conflict — engine-access items 1/4/5 (gateway checks before
  issuance; short-lived, scoped URL; gateway rate-limits issuance):
  upload issuance follows this exact pattern, scoped to
  user + target object instead of user + session — a parallel grant
  type, not a contradiction.
