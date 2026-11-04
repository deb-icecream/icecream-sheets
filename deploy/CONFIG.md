# CONFIG.md — production configuration inventory (icecream-sheets)

Every env var / secret each production service needs, cross-checked against
the code's actual env reads on 2026-10-20 (`grep -rn "process.env"` over
`packages/*/src`, `apps/web/src`, plus the bin files). "Read by code?" says
whether the current code consumes the variable today; variables marked
**reserved** are wired in the deploy definitions for design-doc features
whose product code is still landing (W17b) — they are set so the deploy
doesn't need a second pass, and are harmless if unread.

Source key: **SM** = Secret Manager (referenced by name in the service
YAML, value never in the repo) · **ENV** = plain env in the service YAML /
deploy script · **FB** = Firebase build-time config (inlined by Vite).

## Deployed inventory + billing/storage model (2026-10-20 rulings)

**EIGHT Cloud Run services total** — `icecream-sheet-gateway`, FIVE `icecream-sheet-engine-standard*` services
(`-standard`, `-standard-2`, `-standard-3`, `-standard-4`, `-standard-5`; XL retired by the interim fleet-5 rule 2026-10-24),
`icecream-sheet-mcp`, and `icecream-sheet-service` (the service package as ONE combined
service; see the `service` section below). Everything else is platform
storage/config, not a service.

- **GCP project (funded by the user's GCP credit):** the 5 Cloud Run
  services, Cloud Storage, Firestore, Secret Manager, Artifact Registry,
  Cloud Build. Scale-to-zero (min-instances 0) everywhere keeps the
  credit burn minimal.
- **Cloud Storage (GCP, NOT Firebase Storage):** workbook file bytes →
  bucket `${GCP_PROJECT}-icecream-files`; session snapshots → bucket
  `${GCP_PROJECT}-icecream-snapshots`; direct-upload staging (the
  production load path, next section) → bucket
  `${GCP_PROJECT}-icecream-uploads`. All three are created by
  `deploy.sh` step 3 via `gcloud storage` in the GCP project; services
  write via their GCP service accounts; the browser never touches
  Firebase Storage. **No Firebase Storage bucket is provisioned
  anywhere** — `deploy.sh` contains no Firebase Storage step and the
  Firebase deploy is `--only hosting`.
- **Firestore (free quotas):** metadata store, session registry, op
  journal. Free-plan quotas: **1 GiB stored, 50k reads/day, 20k
  writes/day, 10 GiB/mo egress**. The 20k writes/day quota is why the
  engine's op journal batches: it buffers ops in memory and persists
  ONE write per segment (`JOURNAL_SEGMENT_MAX_OPS`, default 200;
  flushed at checkpoints) — already the code's model in
  `packages/gateway/src/deploy/sessionStore.ts` (W17b), not a deploy
  workaround.
- **Firebase project (FREE plan): Hosting + Auth ONLY.** It hosts the
  web build and provides Google sign-in; it holds no file bytes, no
  snapshots, and no storage bucket.

## Auth flow — Firebase Auth → gateway JWT (agreed with user, 2026-10-21 11:59–12:00 PDT)

The identity chain for the deployed product, end to end:

1. **Hosting + login live in the separate Firebase project** (different account from GCP — see the Firebase rows in the gate table). The web app is served by Firebase Hosting; users sign in via **Firebase Authentication: Google provider ONLY for now**; the Email/Password provider may be enabled later in the same Auth user pool (no migration — same users).
2. **A login returns a Firebase ID token — itself a JWT** signed by Google for the Firebase project, carrying the user's identity (uid, email, name).
3. **The GCP side verifies it at the gateway**: the web app presents the token to `POST /auth/firebase` (implemented in the gateway), which verifies the signature against Google's public keys and the issuer/audience against `FIREBASE_PROJECT_ID`. This is **configuration, not a role or enablement** — token verification needs no IAM grant in either project.
4. **The gateway issues our own JWT** (signed with `AUTH_SECRET`) carrying the same identity as the principal; all GCP services (engine, service, MCP) trust that JWT, so every service sees exactly the user who logged into the hosted web app.
5. **Permissions/tiers ride as JWT claims** — not implemented yet beyond roles; the seam is live (engine access tokens already carry `role`: editor/viewer — a viewer gets 403 on writes). Later tiers are added as claims (gateway-minted, or Firebase custom claims flowing through) with no login rework.
6. **User MANAGEMENT is the only part needing more**: disabling accounts, stamping custom claims, listing users → Firebase Admin SDK → requires `roles/firebase.admin` granted to the deployer SA **in the Firebase project** (or the user does it in the Firebase Console). Login verification does NOT need it.

**What authenticates the operator (this machine) to Firebase**: the deployer service account (`icecream-deployer@dreamscapes-zero.iam.gserviceaccount.com`) holds `roles/firebase.admin` IN the Firebase project `icecream-sheets` (granted by the user 2026-10-21; verified live — deployer access token → Firebase Hosting API sites list HTTP 200). NO CI token: the `firebase login:ci` token route was abandoned after two distinct refresh tokens returned `invalid_grant` under the provably-correct, current-version CLI client. Operator auth = the GCP deployer key (already vaulted at `~/.config/gcp/deployer-key.json`) via `GOOGLE_APPLICATION_CREDENTIALS`/gcloud, or direct REST calls with a deployer access token — plus `FIREBASE_PROJECT_ID` and the web config (`VITE_FIREBASE_*`: apiKey/authDomain/projectId/appId — public identifiers that ship in the web bundle, not secrets). Google sign-in provider verified ENABLED via the Identity Toolkit API (defaultSupportedIdpConfigs/google.com, enabled: true).

**Process once the user shares the Firebase details**: (1) store the token locked down beside the GCP key (0600, outside the repo); (2) INVENTORY the project first (`firebase hosting:sites:list` + what the existing site serves) — the pre-existing deployment is never overwritten; (3) create a DEDICATED Hosting site for icecream-sheets and target `firebase deploy --only hosting:<that site>`; (4) Google provider enabled in Authentication (user's Console toggle, or API if the Firebase Admin grant exists); (5) build the web app with `VITE_GATEWAY_URL` + `VITE_FIREBASE_*`, deploy to the dedicated site only, then re-verify the pre-existing site is untouched; (6) gateway deployed with `FIREBASE_PROJECT_ID` set → end-to-end login test (hosted app sign-in → gateway exchange → own JWT → engine access).

## First-deploy sizing — free-tier-first (user ruling, 2026-10-21)

The user ruled: the first deployment uses the SMALLEST Cloud Run sizes
and scale-to-zero everywhere — he is not paying for the larger tiers yet;
tier raises come later, on his say-so, as config-only changes (edit the
YAML, redeploy — no code change). The service YAMLs in `deploy/services/`
currently carry the first-deploy sizes:

| Service | First-deploy size | Design (scale-up) size |
|---|---|---|
| gateway | 1 vCPU / 512 Mi | 1 vCPU / 512 Mi (unchanged — already minimal) |
| icecream-sheet-engine-standard | 2 vCPU / 4 Gi, heap 3072 | 4 vCPU / 16 Gi, heap 12288 |
| icecream-sheet-engine-xl | RETIRED 2026-10-24 (interim fleet-5 rule; yamls deleted, live deletion awaits owner GO) | 8 vCPU / 32 Gi, heap 24576 (design size; returns with Release 3 GKE pods) |
| mcp | 1 vCPU / 2 Gi | 2 vCPU / 4 Gi |
| service | 1 vCPU / 2 Gi | 2 vCPU / 4 Gi |

Known consequence, accepted by the ruling: at 4 Gi the engine handles
small/medium workbooks; P95/P99-class files (local load plateau ≈3.7 GB
before save headroom) need the design sizes — that is what the tier
raise is for. Cloud Run billing is per-use with monthly free quotas
(180k vCPU-s / 360k GiB-s / 2M requests); with min-instances 0 and the
10-minute idle rule, idle cost is $0. One cost lever NOT yet decided:
the engine YAMLs set `cpu-throttling: "false"` (CPU always allocated
while an instance lives — the design's choice so recalc/journal work
proceeds between requests); request-based CPU would be cheaper still
but changes that behavior — left as the design has it until the user
rules otherwise.

**GCP project: `dreamscapes-zero`** (provided by the user 2026-10-21).
Region: `us-central1` unless the user directs otherwise.

## Production load path — signed-URL direct upload to Cloud Storage (user ruling, 2026-10-21)

**Design-approved (user ruling, 2026-10-21 00:28 PDT):** in production a
file load NEVER travels as a request body through the gateway or the
engine. The production load path is:

1. The client asks the **gateway** for an upload grant. The gateway runs
   the **same authentication + rate-limit checks as engine-access
   issuance** (`POST /api/engine/access`, W17b) and, on success, returns
   a **short-lived signed URL** for one PUT to Cloud Storage —
   TTL `UPLOAD_SIGNED_URL_TTL_SECONDS` (default 900 s), **scoped to the
   authenticated user + the single target object** in the uploads
   bucket (`UPLOAD_BUCKET`). A leaked URL authorizes one object write,
   for minutes, and nothing else.
2. The client uploads the file bytes **directly to Cloud Storage** with
   that URL (browser → GCS). No file bytes flow through gateway or
   engine request bodies.
3. The client then opens the workbook by **GCS reference** (bucket +
   object) through its normal engine-access grant; the **engine pulls
   the object from GCS via its own service account** (its existing
   project-level `roles/storage.objectAdmin`, `deploy.sh` step 4,
   already covers the read) and builds from those bytes.

**Platform-limit resolution (the W17a discrepancy, now closed for
loads):** Cloud Run caps **HTTP/1 requests at 32 MiB** — the wall W17a
flagged against the design doc's 256 MB load-body assumption (the P99
fixture alone is 44 MB). Under this ruling the cap is **moot for
loads**: load bytes never form a Cloud Run request body at all, so no
HTTP/2 rework and no chunked-upload protocol are needed for the load
path. The cap still bounds every remaining HTTP/1 request body
(edits/control traffic are far below it); the separate HTTP/1
*response*-cap note for downloads/saves (W17a) is unaffected by this
ruling.

**What exists today vs the code follow-on (be precise):**

| Piece | State |
|---|---|
| Engine-access signed tokens: gateway issuance (`POST /api/engine/access` after JWT auth + rate limiting), engine-side verification, tier selection | ✅ **exists** (W17b, `packages/gateway/src/deploy/engineAccess.ts`; TTL `ENGINE_ACCESS_TTL_SECONDS`, default 600) — the upload grant reuses this issuance posture, it is NOT a second auth path |
| GCS access from service code: `SnapshotStore` adapter over `@google-cloud/storage` (`FirestoreSessionStores.snapshots` in `packages/gateway/src/deploy/sessionStore.ts`, bucket from `SESSION_SNAPSHOT_BUCKET`, fail-closed prod config) | ✅ **exists** — proves the GCS client pattern + service-account access; it serves session snapshots only, NOT uploads |
| Uploads bucket provisioning + the `UPLOAD_BUCKET` / `UPLOAD_SIGNED_URL_TTL_SECONDS` deploy surface (this change, W22) | ✅ **exists in `deploy/`** (deploy.sh step 3/4 + gateway/engine YAML env) — scripted-but-gated like every bucket step; no code reads these vars yet |
| Gateway upload-issuance endpoint (mint the GCS V4 signed PUT URL after the engine-access checks; gateway SA signs via its own identity — `roles/iam.serviceAccountTokenCreator` on itself + `roles/storage.objectCreator` on the uploads bucket, both granted in `deploy.sh` step 4) | 🔴 **code follow-on** — no endpoint, no `getSignedUrl`/signing call exists in product code today |
| Engine load-by-GCS-reference (open accepts `{ bucket, object }`, engine fetches the bytes itself; today's `/load` + `/load/stream` take `{ format, data: base64 }` bodies capped at `LOAD_MAX_BODY_BYTES` = 256 MB) | 🔴 **code follow-on** |
| Client upload flow (request grant → PUT bytes to the signed URL → open by GCS reference; today's web client posts the bytes to the engine through the gateway/engine transport) | 🔴 **code follow-on** — needs no new build-time env: issuance rides the existing `VITE_GATEWAY_URL`, the PUT target comes back at runtime |
| Uploads-bucket CORS for the web origin (browser PUT from the Firebase Hosting origin) + a lifecycle rule expiring un-opened staged objects | ✅ **done 2026-10-23 (#96 reopen)** — `deploy/uploads-bucket-cors.json` (origins office.deb0.com + icecream-sheets.web.app, PUT/GET, Content-Type, 3600 s) applied via `gcloud storage buckets update` and scripted in deploy.sh step 3; preflight-verified for both origins + live signed-PUT proof. The lifecycle rule for un-opened staged objects remains open. |

The local/dev topology is unchanged: gateway-proxied body loads remain
the local path; this ruling governs the production (Cloud Run) load
path only.

## Operator-provided at deploy time (the credential gate — deploy.sh stops without them)

| Name | Purpose | Source |
|---|---|---|
| `GCP_PROJECT` | GCP project for all 5 Cloud Run services, Artifact Registry, Cloud Storage, Firestore, Secret Manager (funded by GCP credit) | operator env |
| `REGION` | Cloud Run / storage / Firestore region (e.g. `us-central1`) | operator env |
| `FIREBASE_PROJECT_ID` | Firebase project — **FREE plan, Hosting + Auth only** (web hosting + Google sign-in; NO Firebase Storage). **SEPARATE ACCOUNT AND SEPARATE PROJECT from the GCP side** (user clarification, 2026-10-21 — NOT `dreamscapes-zero`, do not confuse them). ⚠️ **Something is already deployed on that Firebase project and MUST NOT be overwritten**: before any `firebase deploy`, inventory the project's existing Hosting sites, deploy icecream-sheets to its OWN Hosting site/target, and verify the pre-existing deployment is untouched afterwards | operator env → ENV on gateway, FB for web |
| Firebase operator auth | Deployer SA holds `roles/firebase.admin` in the Firebase project (granted 2026-10-21, verified live) — NO CI token (route abandoned) | GCP IAM on the Firebase project |
| `AUTH_SECRET_VALUE` | First version of the `AUTH_SECRET` secret (gateway JWT HMAC) | operator env → SM |
| `MCP_AUTH_SECRET_VALUE` | First version of the `MCP_AUTH_SECRET` secret | operator env → SM |
| `ENGINE_SIGNING_SECRET_VALUE` | First version of the engine signed-URL secret (gateway signs, engine verifies) | operator env → SM |
| `VAULT_KEY_VALUE` | First version of the vault master-key secret | operator env → SM |
| `ADDON_TRUSTED_KEYS_VALUE` | *(optional)* First version of the add-on trusted-keys secret | operator env → SM |
| GCP service-account credentials | How `gcloud` authenticates (key file / `gcloud auth`) — arranged by the operator from the Secure Vault; deploy.sh never logs in | operator |
| Billing enabled on `GCP_PROJECT` | Design-doc prerequisite; Cloud Run/Build bill against it | operator |

**Deployer service-account roles (RESTRICTED set — user ruling 2026-10-21: least privilege, NOT Owner).** Bootstrap sequence (user decision, 2026-10-21 11:48 PDT): the SA was briefly granted Owner for convenience, but the key is created only AFTER the user restricts the account in the Console (IAM page: remove Owner, add the 11 roles below) — the handed-over key is therefore born restricted and never held Owner. On receipt, verify with `projects get-iam-policy` before any deploy step (`deploy/restrict-deployer.sh` remains the fallback if a swap is ever done from this side). Derived line-by-line from the gcloud calls in deploy.sh. Grant the deployer SA exactly these project roles:

| deploy.sh operation | Role |
|---|---|
| `services enable` | Service Usage Admin (`roles/serviceusage.serviceUsageAdmin`) |
| `artifacts repositories create` | Artifact Registry Administrator (`roles/artifactregistry.admin`) |
| `storage buckets create` + bucket IAM bindings | Storage Admin (`roles/storage.admin`) |
| `firestore databases create` | Datastore Owner (`roles/datastore.owner`) — database creation requires this role; it is scoped to Datastore/Firestore only |
| `iam service-accounts create` + SA IAM bindings | Service Account Admin (`roles/iam.serviceAccountAdmin`) |
| deploy/run as the runtime service accounts | Service Account User (`roles/iam.serviceAccountUser`) |
| `projects add-iam-policy-binding` (granting runtime roles) | Project IAM Admin (`roles/resourcemanager.projectIamAdmin`) |
| `secrets create` / `versions add` / IAM bindings | Secret Manager Admin (`roles/secretmanager.admin`) |
| `builds submit` | Cloud Build Editor (`roles/cloudbuild.builds.editor`) |
| `run services replace/describe/update` + service IAM bindings | Cloud Run Admin (`roles/run.admin`) |
| Smoke-test the Vertex AI backend after deploy (user ask, 2026-10-21) — VALIDATION only: the deployed service's own Vertex access is granted to the SERVICE runtime SA by deploy.sh itself (`roles/aiplatform.user`, step 4) | Vertex AI User (`roles/aiplatform.user`) |
| — Firebase Admin: NOT granted on this GCP project (a role here would govern nothing in the Firebase project). **Grant it IN the Firebase project when the user shares it** (user authorization, 2026-10-21 11:53 PDT — he asked for the Google-login configuration role to be added to the list): in that project's IAM, add principal `icecream-deployer@dreamscapes-zero.iam.gserviceaccount.com` with `roles/firebase.admin` — that lets the deployer configure/verify Firebase Authentication (Google provider) there via API. Alternative: the user enables the Google provider in the Firebase Console directly (no grant needed) | `roles/firebase.admin` — *in the Firebase project, not this one* |

If a deploy step ever fails on a missing permission, the fix is to name and add that one role — never to escalate the SA to Owner as insurance.

**Deployer lifecycle (user decision, 2026-10-21 — "Option B"):** the 11 roles stay in place until deploy day. The FINAL step of a successful deployment is to park the deployer: run `deploy/park-deployer.sh` with `DELETE_KEY=1` — it removes all 11 roles, verifies zero roles from the live policy, and deletes the bootstrap key. A deployment report is not complete until the park is verified; the running services never use this account (they run as their own attached SAs).

## gateway (Cloud Run service `gateway`, image `Dockerfile.gateway`)

| Name | Purpose | Source | Read by code? |
|---|---|---|---|
| `PORT` | Listen port (Cloud Run injects 8080) | platform | ✅ `bin/gateway.ts` (default 8100) |
| `HOST` | Listen host; YAML sets `0.0.0.0` (Cloud Run probes require it) | ENV | ✅ `bin/gateway.ts` (default `127.0.0.1`, W17b) |
| `AUTH_SECRET` | HMAC secret for gateway JWTs. **Default `local-dev-secret` + warning if unset — production MUST set it** | SM `icecream-auth-secret` | ✅ `bin/gateway.ts` |
| `FIREBASE_PROJECT_ID` | Enables `POST /auth/firebase` (verifies Firebase ID tokens for this project); endpoint 503s without it | ENV | ✅ `bin/gateway.ts` |
| `ENGINE_URL` | Engine route target for `/api/engine` (proxy path) | ENV (deploy.sh fills from icecream-sheet-engine-standard URL) | ✅ `bin/gateway.ts` |
| `ENGINE_URL_STANDARD` / `ENGINE_URL_XL` | Tier URLs for signed-URL issuance (`engineAccess.ts` tier selection by cell count) | ENV (deploy.sh fills from both engine URLs) | ✅ `deploy/engineAccess.ts` (W17b) |
| `ENGINE_INSTANCES` | **Placement pool (ONE pool; interim fleet-5 rule 2026-10-24)**: JSON map `instanceId → engine service URL`. The fleet is FIVE SEPARATE Cloud Run services (owner decision 2026-10-23: a service's instances cannot be addressed individually) — `icecream-sheet-engine-standard` (`engine-standard-1`) through `icecream-sheet-engine-standard-5` (`engine-standard-5`). The gateway claim path tries members in ROTATION order; a busy member's §9 refusal moves to the next; the winner is recorded in the registry as ownerInstance/ownerEndpoint. All members busy → the globally LRU live file is evicted (checkpoint first, silent, whole-file release) and the claim retries; 503 `no free engine instance` only when no eviction frees a service (capacity = fleet size = 5) | ENV (deploy.sh builds from the deployed fleet services' URLs) | ✅ `bin/gateway.ts` via `createGateway` (`parseEngineInstances`) |
| `ENGINE_INSTANCES_XL` | RETIRED 2026-10-24 (interim fleet-5 rule): still parsed by `createGateway` for backward compatibility but NEVER a placement pool — all tiers claim from `ENGINE_INSTANCES`. deploy.sh no longer sets it | ENV (deploy.sh) | ✅ `createGateway` (`parseEngineInstances`) |
| `ENGINE_INSTANCE_ID` (engine services) | Each fleet service's own identity; the registry's ownerInstance for its sessions MUST equal it or the ownership heartbeat fences the instance's own sessions. Set per service in `deploy/services/engine-*.yaml` | ENV (service YAML) | ✅ `bin/engine.ts` / `engineSvc.ts` |
| `ENGINE_INSTANCE_ID` (gateway) | The gateway's instance id (identity + single-URL fallback); must be a key of `ENGINE_INSTANCES` (`engine-standard-1`). Claims use rotation order — no home preference since the interim fleet-5 rule | ENV (gateway.yaml) | ✅ `createGateway` |
| `MAX_OPEN_FILES_PER_USER` | **§9A per-user open cap** (owner 2026-10-23): max DISTINCT files one user may hold open at once (default 4). Opening one more silently evicts the user from their least recently used open file (by that user's own activity) — detach of that user's instances only, after a confirmed checkpoint; co-users unaffected; the cap never refuses an open | ENV (`deploy/services/gateway.yaml` sets `"4"`) | ✅ `createGateway` via `deploy/userOpenCap.ts` (`maxOpenFilesPerUser`) |
| `VAULT_URL` / `META_URL` / `ETL_URL` / `AGENT_URL` / `ADDONS_URL` | Backend route table for `/api/{vault,meta,etl,agent,addons}` — **all five are set to the ONE combined `service` service URL** (W17b §4 wiring: the combined runner's prefix dispatcher accepts `/api/<name>/...`) | ENV (deploy.sh fills all five from the single `service` URL) | ✅ `bin/gateway.ts` |
| `SERVICE_COMBINED` | Combined-service proxy mode (W19): `on` in the deployed gateway YAML — service-family routes (`/api/{vault,meta,etl,agent,addons}`) are proxied with the **full path preserved** so the combined runner's prefix dispatcher can route them (etl and addons both serve a bare `POST /run`, so bare-path dispatch would be ambiguous). Unset/off (local default) = the prefix is stripped exactly as before, for the per-bin topology. Non-service-family routes (e.g. `/api/engine`) strip in both modes | ENV (`deploy/services/gateway.yaml` sets `"on"`) | ✅ `bin/gateway.ts` via `serviceCombinedEnabled()` → `gateway.ts` (`GatewayOptions.serviceCombined`) |
| `RATE_LIMIT_POINTS` | Rate-limit points per window (default 600) | ENV (optional) | ✅ `bin/gateway.ts` |
| `RATE_LIMIT_WINDOW` | Rate-limit window seconds (default 60) | ENV (optional) | ✅ `bin/gateway.ts` |
| `UPLOAD_BUCKET` | Uploads bucket for the production load path (see the load-path section above): the gateway issues signed PUT URLs into it. Value `${GCP_PROJECT}-icecream-uploads`, derived in `deploy.sh` and shared verbatim with the engine definitions | ENV (deploy.sh fills; `deploy/services/gateway.yaml`) | **design-approved — code follow-on (W22)**: no product code reads it yet; the upload-issuance endpoint is the follow-on |
| `UPLOAD_SIGNED_URL_TTL_SECONDS` | Lifetime of a gateway-issued upload signed URL (scoped to user + target object). Deploy default 900; operator-overridable via the `deploy.sh` env of the same name | ENV (`deploy/services/gateway.yaml` ← deploy.sh default) | **design-approved — code follow-on (W22)**: no product code reads it yet; the follow-on issuance code clamps it like `ENGINE_ACCESS_TTL_SECONDS` |
| `SHARE_STORE` | App-share store selector: `local` (file-backed) or `prod` (Firestore, collection `icecream_app_shares`, sha256-hex doc ids, 1 MiB doc cap rejects loudly) | ENV (`deploy/services/gateway.yaml` sets `"prod"`) | ✅ `deploy/shareStore.ts` `createProdAppShareStore` / `createAppShareStore` (fail-closed) |
| `FILE_REGISTRY_STORE` | File-registry / session-ownership store selector: `local` (file-backed) or `prod` (Firestore, transactional claim + ownershipEpoch fencing). **OWNER RULING 2026-10-23: ALWAYS `prod` for hosted — the hosted posture REQUIRES this store; it is not optional.** Fail-closed without a Firestore client | ENV (`deploy/services/gateway.yaml` sets `"prod"`) | ✅ `deploy/fileRegistry.ts` |
| `GCP_PROJECT_ID` | Firestore project for the prod share store (`SHARE_STORE=prod`) | ENV (`deploy/services/gateway.yaml`, `${GCP_PROJECT}`) | ✅ `deploy/shareStore.ts` `prodShareConfig` (fail-closed) |
| `TRIGGER_STORE` | Trigger store selector for the trigger supervisor: unset/`local` (file-backed) or `prod` (Firestore write-through, collection `icecream_trigger_metadata`, sha256-hex doc ids, 1 MiB doc cap rejects loudly; specs + grant records). Set on BOTH the service (`deploy/services/service.yaml`, detached CRUD) and the engine services (`deploy/services/engine-*.yaml`, the session-hosting supervisor in bin/engine) | ENV | ✅ service `automation/hostFirestore.ts` `createProdTriggerScopePersistence` / `prodTriggerConfig` (fail-closed, no local fallback) + gateway `services/triggerSupervisor.ts` |
| `TRIGGER_TICK_AUDIENCE` / `TRIGGER_TICK_SA_EMAIL` | Scheduler tick auth for `POST /api/automation/tick` on the service package: the OIDC token's audience (= the tick URL, i.e. this service's own URL + `/api/automation/tick`) and the scheduler service account's email. Set by the rollout script `deploy/create-trigger-scheduler.sh` (they depend on the deployed service URL), NOT in service.yaml. Unset = the tick endpoint answers 503 (fail closed) | ENV (set by the rollout script) | ✅ gateway `services/tickAuth.ts` `tickAuthConfig` / `verifySchedulerOidc` |
| Scheduler job `icecream-sheet-trigger-tick` | THE Cloud Scheduler waker for timed triggers: every 1 minute, OIDC POST to the service's `/api/automation/tick` (SA `icecream-trigger-tick@<project>`, granted `roles/run.invoker` on the service only). The tick self-opens closed files with due timed triggers on an engine (registry CAS + creator engine-access token; the service therefore also carries `ENGINE_ACCESS_SECRET` from SM `icecream-engine-signing-secret`). Persisted `lastFiredAt` is the fire marker — at-least-once delivery never double-fires. Job creation is a ROLLOUT step (`deploy/create-trigger-scheduler.sh`), NOT part of deploy.sh's first deploy | Cloud Scheduler | ✅ gateway `services/triggerSupervisor.ts` `tick()` + `services/automationSvc.ts` `/tick` route |


## engine (Cloud Run services `icecream-sheet-engine-standard` × 5 — XL retired 2026-10-24, image `Dockerfile.engine`)

| Name | Purpose | Source | Read by code? |
|---|---|---|---|
| `PORT` | Listen port (Cloud Run injects 8080) | platform | ✅ `bin/engine.ts` (default 8101) |
| `HOST` | Listen host; YAMLs set `0.0.0.0` (Cloud Run probes require it) | ENV | ✅ `bin/engine.ts` (default `127.0.0.1`, W17b) |
| `ENGINE_HEAP_MB` | `--max-old-space-size` via `deploy/engine-entrypoint.sh` (12288 std / 24576 xl; default 6144 = local stack) | ENV per tier | ✅ entrypoint |
| `ENGINE_TIER` | `standard` / `xl` label for logs/routing diagnostics | ENV | **reserved** |
| `ENGINE_ACCESS_MODE` | `signed` in both engine YAMLs: the engine self-verifies gateway-issued signed tokens on every route and refuses anything else (design doc); proxy mode (raw `x-principal` identity) is local-dev only (F-2) | ENV (`deploy/services/engine-*.yaml`) | ✅ `deploy/engineAccess.ts` `engineAccessMode` |
| `ENGINE_ACCESS_SECRET` | HMAC secret the signed tokens are verified with (the gateway signs/issues with the same secret); the service package also carries it so the scheduler tick can mint creator tokens for self-opened sessions | SM `icecream-engine-signing-secret` | ✅ `deploy/engineAccess.ts` `engineAccessSecret` |
| `ICECREAM_DATA_DIR` | Local file-persistence dir (`filePersistence.ts`). On Cloud Run this is **in-memory tmpfs**: counts against the instance memory limit and is lost with the instance — durable backing (Cloud Storage + Firestore journal) is the design-doc target | ENV (`/tmp/icecream-data`) | ✅ `filePersistence.ts` |
| `ICECREAM_MT_CELL_COUNT_THRESHOLD` | The ONE flag's threshold: workbook cell count above it → full-mirror off / server MT recalc on (default in code: 5000) | ENV | ✅ `engineSvc.ts` via `resolveParallelCellThreshold` |
| `ICECREAM_PARSE_WORKERS` | Parallel XLSX parse worker count override | ENV (optional) | ✅ `parallelParse.ts` |
| `ICECREAM_WORKER_LOADER` | Worker-loader override for the parse pool | ENV (optional) | ✅ `parallelParse.ts` |
| `UPLOAD_BUCKET` | Uploads bucket for the production load path (see the load-path section above): the engine pulls the opened object from this bucket via its service account (the project-level `roles/storage.objectAdmin` from `deploy.sh` step 4 already covers the read). Same value as the gateway's `UPLOAD_BUCKET` | ENV (deploy.sh fills; both engine YAMLs) | **design-approved — code follow-on (W22)**: no product code reads it yet; load-by-GCS-reference is the follow-on |
| `GCP_PROJECT_ID` | GCP project for the engine's Google Cloud clients (the upload pull; the session store's prod config reads the same var) | ENV (both engine YAMLs, `${GCP_PROJECT}`) | ✅ `deploy/sessionStore.ts` `prodSessionConfig` (prod provider) · **follow-on** for the upload pull |
| `SESSION_STORE` | Session store selector: `local` (file-backed) or `prod` (Firestore registry/journal + GCS snapshots). **OWNER RULING 2026-10-23: ALWAYS `prod` for hosted — the hosted posture REQUIRES this store; it is not optional.** Fail-closed: `prod` without `GCP_PROJECT_ID` + `SESSION_SNAPSHOT_BUCKET` refuses to start | ENV (both engine YAMLs set `"prod"`) | ✅ `deploy/sessionStore.ts` `prodSessionConfig` |
| `SESSION_SNAPSHOT_BUCKET` | GCS bucket for session snapshots (`${GCP_PROJECT}-icecream-snapshots`) | ENV (both engine YAMLs, `${BUCKET_SNAPSHOTS}`) | ✅ `deploy/sessionStore.ts` `FirestoreSessionStores.snapshots` |

## service (Cloud Run service `service` — the service package as ONE service, image `Dockerfile.service`)

One stateless service (min-instances 0, nothing persists between
requests) running the combined runner `packages/gateway/dist/bin/service.js`
(W17b): vault, meta, etl, agent and addons surfaces in one process behind
`/api/<name>` prefixes. Sizing: W17a's service-family medium tier —
2 vCPU / 4 GiB, concurrency 20 (`deploy/services/service.yaml`). The five
per-bin deployments (`service-{vault,meta,etl,agent,addons}`) no longer
exist.

| Name | Purpose | Source | Read by code? |
|---|---|---|---|
| `SERVICE_BIN` | Which bin the service image runs: **`service`** (the combined runner) in the deployed definition. `vault`\|`meta`\|`etl`\|`agent`\|`addons` remain selectable for local debugging only (entrypoint fails closed otherwise) | ENV (`deploy/services/service.yaml`) | ✅ entrypoint |
| `PORT` | Listen port (Cloud Run injects 8080) | platform | ✅ `bin/service.ts` (default 8108) |
| `HOST` | Listen host; YAML sets `0.0.0.0` (Cloud Run probes require it) | ENV | ✅ `bin/service.ts` (default `127.0.0.1`, W17b) |
| `ENGINE_SERVICE_URL` | *(addons surface)* Engine base URL for document-binding resolution | ENV (deploy.sh fills from icecream-sheet-engine-standard URL) | ✅ `services/servicePackage.ts` (default `http://127.0.0.1:8101`) |
| `VAULT_MASTER_KEY` | *(vault surface)* Vault master key material — design doc: "Secret Manager: vault keys" | SM `icecream-vault-master-key` | **reserved** (vault surface currently takes no env beyond PORT/HOST; key delivery is the seam) |
| `ICECREAM_ADDON_TRUSTED_KEYS` | *(addons surface)* JSON array of trusted PEM public keys for add-on signature verification | SM `icecream-addon-trusted-keys` (optional) | ✅ `packages/service/src/addons/production.ts` |
| `ICECREAM_ADDON_TRUSTED_KEYS_FILE` | *(addons surface, alternative)* Path variant of the above | ENV (optional) | ✅ `production.ts` |
| `ICECREAM_ADDON_REQUIRE_SIGNATURES` | Force add-on signature enforcement outside `NODE_ENV=production` | ENV (optional) | ✅ `production.ts` |
| `NODE_ENV` | `production` in every image (also turns on add-on signature enforcement) | image ENV | ✅ `production.ts` |
| `GCP_PROJECT_ID` | *(agent surface)* GCP project for the Vertex AI production backend (`VERTEX_DEFAULT_MODEL = gemini-2.5-flash-lite` — user ruling 2026-10-21: cheap Gemini models for all LLM calls, absolute cheapest after a pricing check; `gemini-2.5-pro` remains a per-deployment override; location default `us-central1`) | ENV | **reserved** (Vertex backend takes project via constructor today; LLM credentials flow through the credential vault, not env) |
| `XDG_CACHE_HOME` | Python sandbox venv cache root (defaults to `~/.cache`); on Cloud Run = tmpfs, reprovisioned per instance | platform default | ✅ `packages/service/src/python/env.ts` |

## mcp (Cloud Run service `mcp`, image `Dockerfile.mcp`)

| Name | Purpose | Source | Read by code? |
|---|---|---|---|
| `PORT` | Listen port (Cloud Run injects 8080); bin validates it and exits on garbage | platform | ✅ `bin/http.ts` (default 8106) |
| `HOST` | Listen host; YAML sets `0.0.0.0` (Cloud Run probes require it) | ENV | ✅ `bin/http.ts` → `startMcpHttp` host param (default `127.0.0.1`, W17b) |
| `MCP_AUTH_SECRET` | MCP's own bearer-token HMAC secret (self-authentication, own ingress). **Default `local-dev-secret` if unset — production MUST set it** | SM `icecream-mcp-auth-secret` | ✅ `packages/mcp-server/src/http.ts` |
| `ENGINE_URL` | REMOVED — MCP runs on the in-process engine (AGENT.md S2); no remote-engine HTTP in any design doc | — | ❌ removed from `mcp.yaml` (MCP fix round) |
| `MCP_STORE` | Metadata store selector: `local` (file-backed) or `prod` (Firestore). First deploy uses `prod` (user ruling 2026-10-21: proceed with durable) | ENV (`mcp.yaml`) | ✅ `bin/runner-config.ts` (async) |
| `GCP_PROJECT_ID` | Firestore project for the MCP metadata store (`MCP_STORE=prod`) | ENV (`mcp.yaml` = `dreamscapes-zero`) | ✅ `bin/runner-config.ts` `prodMcpConfig` (fail-closed) |
| `FIRESTORE_DATABASE_ID` | Firestore database ID (optional; defaults to `(default)`) | ENV | ✅ `bin/runner-config.ts` `prodMcpConfig` |
| `PATH` | Sandbox spawns `python3` from PATH (images install python3) | image | ✅ `sandbox/python.ts` |

## web (Firebase Hosting, build-time — changing any of these requires a rebuild)

| Name | Purpose | Source |
|---|---|---|
| `VITE_GATEWAY_URL` | Gateway base URL; bundle runs in gateway mode when set. deploy.sh/build-web.sh refuse to build without it (no silent browser-local bundle) | build env (deploy.sh fills from the deployed gateway) |
| `VITE_FIREBASE_API_KEY` | Firebase web API key | FB (apps/web/.env.local or build env; see apps/web/.env.example) |
| `VITE_FIREBASE_AUTH_DOMAIN` | e.g. `<project>.firebaseapp.com` | FB |
| `VITE_FIREBASE_PROJECT_ID` | Same project as `FIREBASE_PROJECT_ID` | FB |
| `VITE_FIREBASE_APP_ID` | Firebase web app id (`1:…:web:…`) | FB |
| `VITE_FIREBASE_MEASUREMENT_ID` | *(optional)* Analytics measurement id | FB |

The signed-URL upload flow (production load path, above) adds **no**
web build-time config: the client requests the upload grant through the
existing `VITE_GATEWAY_URL` and PUTs to the signed GCS URL returned at
runtime. (The client half of that flow is a code follow-on — W22.)

## Explicitly NOT production-cloud config

`ICECREAM_GATEWAY_URL`, `ICECREAM_DESKTOP_MCP_PORT`, `ICECREAM_MCP_PORT`,
`MCP_REQUIRE_AUTH` are read only by `apps/desktop` (local engine / desktop
MCP) — desktop is a separate, local-engine topology and takes none of the
Cloud Run configuration above.
