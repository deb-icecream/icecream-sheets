#!/usr/bin/env bash
# =============================================================================
# icecream-sheets — production deploy (design-docs/deployment-architecture.md)
#
# Topology (user's service inventory, 2026-10-20; interim fleet-5 rule 2026-10-24): EIGHT Cloud Run services
# total — icecream-sheet-gateway / 5× icecream-sheet-engine-standard / icecream-sheet-mcp / icecream-sheet-service (the
# service package as ONE combined service: vault+meta+etl+agent+addons in
# one process, SERVICE_BIN=service) — plus Firebase Hosting for the web
# app. Scale-to-zero everywhere (min-instances 0). Secrets live in Secret
# Manager; this script only REFERENCES them by name and, on first deploy,
# creates them from operator-supplied env values (never committed, never
# echoed).
#
# Billing/storage model (user's addendum, 2026-10-20): the GCP project is
# funded by GCP credit and hosts the 5 Cloud Runs, Cloud Storage, Firestore
# and Secret Manager. File bytes + session snapshots live in GCP Cloud
# Storage buckets (created in step 3, in THIS project) — NOT Firebase
# Storage: the Firebase project is on the FREE plan and is used for
# Hosting + Auth ONLY; this script provisions NO Firebase Storage bucket
# (firebase deploy below is --only hosting). Firestore runs on the free
# quotas (1 GiB stored, 50k reads/day, 20k writes/day, 10 GiB/mo egress);
# the engine's op journal already batches writes by segment in code
# (W17b sessionStore.ts), so quota burn stays minimal, as does
# scale-to-zero Cloud Run burn.
#
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
#
# NOTHING is deployed unless every required variable below is set — the
# script stops with the exact list of what's missing (the credential gate).
# Authentication itself is the operator's step (Secure Vault → service
# account key / gcloud auth / FIREBASE_TOKEN); this script never logs in.
#
# Usage:
#   deploy/deploy.sh --dry-run     # print every command, execute NOTHING
#   deploy/deploy.sh               # real deploy (requires auth + env below)
#
# Required env (see deploy/CONFIG.md for the full inventory):
#   GCP_PROJECT            GCP project id (services + gateway live here)
#   REGION                 e.g. us-central1
#   FIREBASE_PROJECT_ID    Firebase project id (may differ from GCP_PROJECT —
#                          the design doc keeps the accounts SEPARATE)
#   FIREBASE_TOKEN         Firebase CI token (from the Secure Vault)
#   AUTH_SECRET_VALUE      first-version value for the AUTH_SECRET secret
#   MCP_AUTH_SECRET_VALUE  first-version value for the MCP_AUTH_SECRET secret
#   ENGINE_SIGNING_SECRET_VALUE  first-version value for the signed-URL secret
#   VAULT_KEY_VALUE        first-version value for the vault master key secret
# Optional env:
#   IMAGE_TAG              default: git short SHA or "manual"
#   MT_CELL_COUNT_THRESHOLD  default 5000 (engine MT routing flag threshold)
#   UPLOAD_SIGNED_URL_TTL_SECONDS  default 900 (lifetime of the gateway-
#                          issued GCS upload signed URL; user + target
#                          object scoped — see CONFIG.md load-path section)
#   ADDON_TRUSTED_KEYS_VALUE  first-version value for add-on trust keys
#                          (JSON array of PEM strings; optional — when unset
#                          the service is deployed without the env)
#   SKIP_WEB=1             skip the web build + Firebase Hosting deploy
#   GCLOUD / FIREBASE      tool paths (default: ~/workspace/tools/...)
# =============================================================================
set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,74p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg (only --dry-run is supported)" >&2; exit 64 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

GCLOUD="${GCLOUD:-$HOME/workspace/tools/google-cloud-sdk/bin/gcloud}"
FIREBASE="${FIREBASE:-$HOME/workspace/tools/firebase/node_modules/.bin/firebase}"

# ---------- credential / config gate: fail BEFORE doing anything ----------
missing=()
require() { [ -n "${!1:-}" ] || missing+=("$1"); }
require GCP_PROJECT
require REGION
require FIREBASE_PROJECT_ID
require FIREBASE_TOKEN
require AUTH_SECRET_VALUE
require MCP_AUTH_SECRET_VALUE
require ENGINE_SIGNING_SECRET_VALUE
require VAULT_KEY_VALUE
if [ "${#missing[@]}" -gt 0 ]; then
  cat >&2 <<EOF
================================================================================
DEPLOY BLOCKED — credential gate. Nothing was deployed.
Missing required environment variables:
$(printf '  - %s\n' "${missing[@]}")
Provide them from the Secure Vault at deploy time (never commit them).
See deploy/CONFIG.md for what each one is and where it comes from, and
hidden_files/cycle10-closure/w17a-deploy-infra-results.md for the full
user-provided list. Re-run with --dry-run plus the variables set to preview
every command safely.
================================================================================
EOF
  exit 78
fi

IMAGE_TAG="${IMAGE_TAG:-$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo manual)}"
MT_CELL_COUNT_THRESHOLD="${MT_CELL_COUNT_THRESHOLD:-5000}"
UPLOAD_SIGNED_URL_TTL_SECONDS="${UPLOAD_SIGNED_URL_TTL_SECONDS:-900}"
AR_REPO="icecream"                                   # Artifact Registry repo
REGISTRY="${REGION}-docker.pkg.dev/${GCP_PROJECT}/${AR_REPO}"
IMAGE_GATEWAY="${REGISTRY}/gateway:${IMAGE_TAG}"
IMAGE_ENGINE="${REGISTRY}/engine:${IMAGE_TAG}"
IMAGE_SERVICE="${REGISTRY}/service:${IMAGE_TAG}"
IMAGE_MCP="${REGISTRY}/mcp:${IMAGE_TAG}"
BUCKET_FILES="${GCP_PROJECT}-icecream-files"        # original file bytes
BUCKET_SNAPSHOTS="${GCP_PROJECT}-icecream-snapshots" # session snapshots (encrypted at rest)
BUCKET_UPLOADS="${GCP_PROJECT}-icecream-uploads"    # direct-upload staging (production load path, user ruling 2026-10-21)
GATEWAY_SA="icecream-gateway@${GCP_PROJECT}.iam.gserviceaccount.com"
ENGINE_SA="icecream-engine@${GCP_PROJECT}.iam.gserviceaccount.com"
SERVICE_SA="icecream-service@${GCP_PROJECT}.iam.gserviceaccount.com"
MCP_SA="icecream-mcp@${GCP_PROJECT}.iam.gserviceaccount.com"
SECRET_AUTH="icecream-auth-secret"
SECRET_MCP_AUTH="icecream-mcp-auth-secret"
SECRET_ENGINE_SIGNING="icecream-engine-signing-secret"
SECRET_VAULT_KEY="icecream-vault-master-key"
SECRET_ADDON_KEYS="icecream-addon-trusted-keys"

# run(): the ONLY way commands execute. Dry-run prints, never runs.
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] %s\n' "$*"
  else
    printf '+ %s\n' "$*"
    "$@"
  fi
}
# run_capture(): like run() but captures stdout in real mode; in dry-run it
# echoes a placeholder so downstream steps can be printed coherently.
run_capture() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] %s\n' "$*" >&2
    printf '<dry-run-output>'
  else
    "$@"
  fi
}

echo "== icecream-sheets deploy =="
echo "project=${GCP_PROJECT} region=${REGION} firebase=${FIREBASE_PROJECT_ID} tag=${IMAGE_TAG} dry_run=${DRY_RUN}"
[ -x "$GCLOUD" ]   || { echo "gcloud not found at $GCLOUD (install: see deploy/README.md)" >&2; exit 69; }
[ -x "$FIREBASE" ] || { echo "firebase CLI not found at $FIREBASE (install: see deploy/README.md)" >&2; exit 69; }
run "$GCLOUD" --version
run "$FIREBASE" --version

# ---------- 1. APIs ----------
run "$GCLOUD" services enable run.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com secretmanager.googleapis.com storage.googleapis.com \
  firestore.googleapis.com aiplatform.googleapis.com --project="$GCP_PROJECT"

# ---------- 2. Artifact Registry ----------
run "$GCLOUD" artifacts repositories create "$AR_REPO" --repository-format=docker \
  --location="$REGION" --project="$GCP_PROJECT" --description="icecream-sheets images" || true

# ---------- 3. Storage prerequisites (scripted, gated — created HERE, at
# deploy time, never during deploy-prep) ----------
# GCP Cloud Storage, in the GCP project (funded by GCP credit): original
# file bytes + session snapshots (design doc) + direct-upload staging
# (production load path, user ruling 2026-10-21: the client PUTs file
# bytes straight to the uploads bucket with a gateway-issued signed URL;
# the engine pulls the object via its service account — file bytes never
# transit gateway/engine request bodies, so the 32 MiB HTTP/1 request
# cap is moot for loads). Services reach these via the GCP service
# accounts (step 4).
# NOTE: these are `gcloud storage` buckets in GCP_PROJECT — NOT a Firebase
# Storage bucket. The Firebase project is free-plan (Hosting + Auth only)
# and gets NO storage bucket anywhere in this script.
run "$GCLOUD" storage buckets create "gs://${BUCKET_FILES}" --project="$GCP_PROJECT" \
  --location="$REGION" --uniform-bucket-level-access
run "$GCLOUD" storage buckets create "gs://${BUCKET_SNAPSHOTS}" --project="$GCP_PROJECT" \
  --location="$REGION" --uniform-bucket-level-access
run "$GCLOUD" storage buckets create "gs://${BUCKET_UPLOADS}" --project="$GCP_PROJECT" \
  --location="$REGION" --uniform-bucket-level-access
# Uploads-bucket CORS (#96 reopen, 2026-10-23): browser PUTs go DIRECTLY
# to GCS signed URLs, so the bucket MUST allow PUT from the web origins
# — without this, every hosted browser upload fails CORS preflight and
# fetch() throws "Failed to fetch" (no catalog record, file never lists).
# The JSON lives in deploy/uploads-bucket-cors.json; re-apply on every
# bucket recreate.
run "$GCLOUD" storage buckets update "gs://${BUCKET_UPLOADS}" --project="$GCP_PROJECT" \
  --cors-file="deploy/uploads-bucket-cors.json"
# Firestore (free quotas: 1 GiB stored, 50k reads/day, 20k writes/day,
# 10 GiB/mo egress): metadata store + engine session registry + op
# journal (design doc). The journal batches one write per segment in
# code (W17b sessionStore.ts), sized for the 20k writes/day quota.
run "$GCLOUD" firestore databases create --database="(default)" --location="$REGION" \
  --project="$GCP_PROJECT" || true

# ---------- 4. Service accounts + IAM ----------
for sa in icecream-gateway icecream-engine icecream-service icecream-mcp; do
  run "$GCLOUD" iam service-accounts create "$sa" --project="$GCP_PROJECT" || true
done
# Secret Manager access, per service, only the secrets that service needs.
run "$GCLOUD" secrets add-iam-policy-binding "$SECRET_AUTH" --project="$GCP_PROJECT" \
  --member="serviceAccount:${GATEWAY_SA}" --role="roles/secretmanager.secretAccessor" || true
run "$GCLOUD" secrets add-iam-policy-binding "$SECRET_ENGINE_SIGNING" --project="$GCP_PROJECT" \
  --member="serviceAccount:${ENGINE_SA}" --role="roles/secretmanager.secretAccessor" || true
run "$GCLOUD" secrets add-iam-policy-binding "$SECRET_ENGINE_SIGNING" --project="$GCP_PROJECT" \
  --member="serviceAccount:${GATEWAY_SA}" --role="roles/secretmanager.secretAccessor" || true
run "$GCLOUD" secrets add-iam-policy-binding "$SECRET_ENGINE_SIGNING" --project="$GCP_PROJECT" \
  --member="serviceAccount:${MCP_SA}" --role="roles/secretmanager.secretAccessor" || true
run "$GCLOUD" secrets add-iam-policy-binding "$SECRET_MCP_AUTH" --project="$GCP_PROJECT" \
  --member="serviceAccount:${MCP_SA}" --role="roles/secretmanager.secretAccessor" || true
run "$GCLOUD" secrets add-iam-policy-binding "$SECRET_VAULT_KEY" --project="$GCP_PROJECT" \
  --member="serviceAccount:${SERVICE_SA}" --role="roles/secretmanager.secretAccessor" || true
# Engine durability: snapshots/files in Cloud Storage, registry/journal in Firestore.
# (This project-level storage.objectAdmin ALSO covers the engine pulling
# uploaded objects from the uploads bucket on the production load path.)
run "$GCLOUD" projects add-iam-policy-binding "$GCP_PROJECT" \
  --member="serviceAccount:${ENGINE_SA}" --role="roles/storage.objectAdmin" || true
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
run "$GCLOUD" projects add-iam-policy-binding "$GCP_PROJECT" \
  --member="serviceAccount:${ENGINE_SA}" --role="roles/datastore.user" || true
run "$GCLOUD" projects add-iam-policy-binding "$GCP_PROJECT" \
  --member="serviceAccount:${SERVICE_SA}" --role="roles/datastore.user" || true
# Agent surface (inside the combined service) → Vertex AI (production
# LLM backend lives in the service package's agent surface; credentials
# also flow through the credential vault).
run "$GCLOUD" projects add-iam-policy-binding "$GCP_PROJECT" \
  --member="serviceAccount:${SERVICE_SA}" --role="roles/aiplatform.user" || true

# ---------- 5. Secrets (create if absent; add a version ONLY on first
# creation, from the operator-supplied *_VALUE env — values are piped via
# stdin and never appear on a command line or in this script's output) ----
ensure_secret() { # name value
  local name="$1" value="$2"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] %s secrets describe %s || create + add-version (value from env, via stdin)\n' "$GCLOUD" "$name"
    return 0
  fi
  if ! "$GCLOUD" secrets describe "$name" --project="$GCP_PROJECT" >/dev/null 2>&1; then
    "$GCLOUD" secrets create "$name" --project="$GCP_PROJECT" --replication-policy=automatic
    printf '%s' "$value" | "$GCLOUD" secrets versions add "$name" --project="$GCP_PROJECT" --data-file=-
  else
    echo "secret $name already exists — leaving versions untouched"
  fi
}
ensure_secret "$SECRET_AUTH" "$AUTH_SECRET_VALUE"
ensure_secret "$SECRET_MCP_AUTH" "$MCP_AUTH_SECRET_VALUE"
ensure_secret "$SECRET_ENGINE_SIGNING" "$ENGINE_SIGNING_SECRET_VALUE"
ensure_secret "$SECRET_VAULT_KEY" "$VAULT_KEY_VALUE"
if [ -n "${ADDON_TRUSTED_KEYS_VALUE:-}" ]; then
  ensure_secret "$SECRET_ADDON_KEYS" "$ADDON_TRUSTED_KEYS_VALUE"
fi

# ---------- 6. Build + push images (Cloud Build — no local docker needed) --
build_image() { # dockerfile image
  local cfg
  cfg="$(mktemp -t icecream-cloudbuild-XXXXXX.yaml)"
  cat > "$cfg" <<YAML
steps:
  - name: gcr.io/cloud-builders/docker
    args: ['build', '-f', '$1', '-t', '$2', '.']
images: ['$2']
timeout: 1800s
YAML
  echo "cloudbuild config for $2 (from $1): $cfg"
  run "$GCLOUD" builds submit --project="$GCP_PROJECT" --config="$cfg" .
  [ "$DRY_RUN" -eq 0 ] && rm -f "$cfg" || echo "[dry-run] (temp config kept for inspection: $cfg)"
}
build_image deploy/Dockerfile.gateway "$IMAGE_GATEWAY"
build_image deploy/Dockerfile.engine  "$IMAGE_ENGINE"
build_image deploy/Dockerfile.service "$IMAGE_SERVICE"
build_image deploy/Dockerfile.mcp     "$IMAGE_MCP"

# ---------- 7. Deploy Cloud Run services -----------------------------------
# Order matters: backends first so their URLs exist when dependents deploy.
# envsubst renders deploy/services/*.yaml with ONLY the listed variables.
render_and_replace() { # yamlfile extra_envsubst_vars
  local src="deploy/services/$1" out
  out="$(mktemp -t "icecream-svc-XXXXXX.yaml")"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] envsubst < %s > %s (vars: %s)\n' "$src" "$out" "$2"
    printf '[dry-run] %s run services replace %s --region=%s --project=%s\n' "$GCLOUD" "$out" "$REGION" "$GCP_PROJECT"
  else
    envsubst "$2" < "$src" > "$out"
    run "$GCLOUD" run services replace "$out" --region="$REGION" --project="$GCP_PROJECT"
    rm -f "$out"
  fi
}
service_url() { # name
  run_capture "$GCLOUD" run services describe "$1" --region="$REGION" \
    --project="$GCP_PROJECT" --format='value(status.url)'
}
V_COMMON='${GCP_PROJECT} ${REGION} ${GATEWAY_SA} ${ENGINE_SA} ${SERVICE_SA} ${MCP_SA} ${IMAGE_GATEWAY} ${IMAGE_ENGINE} ${IMAGE_SERVICE} ${IMAGE_MCP} ${SECRET_AUTH} ${SECRET_MCP_AUTH} ${SECRET_ENGINE_SIGNING} ${SECRET_VAULT_KEY} ${SECRET_ADDON_KEYS} ${FIREBASE_PROJECT_ID} ${MT_CELL_COUNT_THRESHOLD} ${BUCKET_UPLOADS} ${BUCKET_SNAPSHOTS} ${UPLOAD_SIGNED_URL_TTL_SECONDS}'
export GCP_PROJECT REGION GATEWAY_SA ENGINE_SA SERVICE_SA MCP_SA IMAGE_GATEWAY IMAGE_ENGINE IMAGE_SERVICE IMAGE_MCP
export SECRET_AUTH SECRET_MCP_AUTH SECRET_ENGINE_SIGNING SECRET_VAULT_KEY SECRET_ADDON_KEYS FIREBASE_PROJECT_ID MT_CELL_COUNT_THRESHOLD BUCKET_UPLOADS BUCKET_SNAPSHOTS UPLOAD_SIGNED_URL_TTL_SECONDS

# 7a. engines (public at platform level; signed-URL auth in-process)
export ENGINE_STANDARD_URL="" ENGINE_URL="" # filled below; service/mcp reference the standard tier
render_and_replace engine-standard.yaml "$V_COMMON"
run "$GCLOUD" run services add-iam-policy-binding icecream-sheet-engine-standard --region="$REGION" --project="$GCP_PROJECT" \
  --member="allUsers" --role="roles/run.invoker"   # --allow-unauthenticated equivalent AT THE PLATFORM LEVEL ONLY: in-process auth is the signed token — the engine YAMLs set ENGINE_ACCESS_MODE=signed + ENGINE_ACCESS_SECRET (F-2), and the engine rejects any request without a valid gateway-issued signed token; a bare x-principal header is NOT trusted
ENGINE_STANDARD_URL="$(service_url icecream-sheet-engine-standard)"
export ENGINE_STANDARD_URL ENGINE_URL="$ENGINE_STANDARD_URL"
# PLACEMENT FLEET (interim fleet-5 rule, 2026-10-24): the fleet is
# FIVE standard services (a service's instances cannot be addressed
# individually; the fleet is how a new file's open reaches a FREE
# engine). Same posture as the first member: platform-open, in-process
# signed-token auth. The XL services are DELETED by this rule (they
# were same-size placeholders): live deletion is a separate, owner-GO
# step (see the fleet-five report's prepared live plan), and the XL
# yamls are removed from this tree so no deploy recreates them.
render_and_replace engine-standard-2.yaml "$V_COMMON"
run "$GCLOUD" run services add-iam-policy-binding icecream-sheet-engine-standard-2 --region="$REGION" --project="$GCP_PROJECT" \
  --member="allUsers" --role="roles/run.invoker"
ENGINE_STANDARD2_URL="$(service_url icecream-sheet-engine-standard-2)"; export ENGINE_STANDARD2_URL
render_and_replace engine-standard-3.yaml "$V_COMMON"
run "$GCLOUD" run services add-iam-policy-binding icecream-sheet-engine-standard-3 --region="$REGION" --project="$GCP_PROJECT" \
  --member="allUsers" --role="roles/run.invoker"
ENGINE_STANDARD3_URL="$(service_url icecream-sheet-engine-standard-3)"; export ENGINE_STANDARD3_URL
render_and_replace engine-standard-4.yaml "$V_COMMON"
run "$GCLOUD" run services add-iam-policy-binding icecream-sheet-engine-standard-4 --region="$REGION" --project="$GCP_PROJECT" \
  --member="allUsers" --role="roles/run.invoker"
ENGINE_STANDARD4_URL="$(service_url icecream-sheet-engine-standard-4)"; export ENGINE_STANDARD4_URL
render_and_replace engine-standard-5.yaml "$V_COMMON"
run "$GCLOUD" run services add-iam-policy-binding icecream-sheet-engine-standard-5 --region="$REGION" --project="$GCP_PROJECT" \
  --member="allUsers" --role="roles/run.invoker"
ENGINE_STANDARD5_URL="$(service_url icecream-sheet-engine-standard-5)"; export ENGINE_STANDARD5_URL
# The gateway's placement pool: instanceId -> service URL (one pool;
# tier routing collapsed by the interim fleet-5 rule).
ENGINE_INSTANCES="{\"engine-standard-1\":\"${ENGINE_STANDARD_URL}\",\"engine-standard-2\":\"${ENGINE_STANDARD2_URL}\",\"engine-standard-3\":\"${ENGINE_STANDARD3_URL}\",\"engine-standard-4\":\"${ENGINE_STANDARD4_URL}\",\"engine-standard-5\":\"${ENGINE_STANDARD5_URL}\"}"
export ENGINE_INSTANCES

# 7b. service — the service package as ONE service (invoker restricted to
# the gateway service account). service.yaml also references
# ${ENGINE_STANDARD_URL} (ENGINE_SERVICE_URL, for the addons surface).
V_WITH_ENGINE="${V_COMMON} \${ENGINE_STANDARD_URL}"
render_and_replace service.yaml "$V_WITH_ENGINE"
run "$GCLOUD" run services add-iam-policy-binding icecream-sheet-service --region="$REGION" --project="$GCP_PROJECT" \
  --member="serviceAccount:${GATEWAY_SA}" --role="roles/run.invoker"
SERVICE_URL="$(service_url icecream-sheet-service)"; export SERVICE_URL

# 7c. mcp (own direct ingress; self-authenticates — never behind gateway)
# mcp.yaml also references ${ENGINE_STANDARD_URL} (ENGINE_URL).
render_and_replace mcp.yaml "$V_WITH_ENGINE"
run "$GCLOUD" run services add-iam-policy-binding icecream-sheet-mcp --region="$REGION" --project="$GCP_PROJECT" \
  --member="allUsers" --role="roles/run.invoker"   # platform-open; MCP_AUTH_SECRET auth is in-process

# 7d. gateway last — it needs every backend URL. Its service-family
# upstreams (VAULT_URL/META_URL/ETL_URL/AGENT_URL/ADDONS_URL in
# gateway.yaml) ALL resolve from the single ${SERVICE_URL} (W17b §4:
# the combined service's prefix dispatcher accepts /api/<name>/...).
V_GATEWAY="${V_COMMON} \${ENGINE_STANDARD_URL} \${SERVICE_URL} \${ENGINE_INSTANCES}"
render_and_replace gateway.yaml "$V_GATEWAY"
run "$GCLOUD" run services add-iam-policy-binding icecream-sheet-gateway --region="$REGION" --project="$GCP_PROJECT" \
  --member="allUsers" --role="roles/run.invoker"   # the gateway IS the public auth point
GATEWAY_URL="$(service_url icecream-sheet-gateway)"; export GATEWAY_URL
echo "gateway URL: ${GATEWAY_URL}"

# 7e. engine session affinity (best-effort): sticky routing helps the
# session registry; harmless if the flag is unavailable in the region.
for svc in icecream-sheet-engine-standard icecream-sheet-engine-standard-2 icecream-sheet-engine-standard-3 icecream-sheet-engine-standard-4 icecream-sheet-engine-standard-5; do
  run "$GCLOUD" run services update "$svc" --region="$REGION" --project="$GCP_PROJECT" --session-affinity || true
done

# ---------- 8. Web build + Firebase Hosting --------------------------------
if [ "${SKIP_WEB:-0}" != "1" ]; then
  # VITE_GATEWAY_URL is a BUILD-TIME env: the web bundle is rebuilt against
  # the just-deployed gateway URL, then hosted on Firebase (separate
  # account, FIREBASE_TOKEN from the Vault).
  VITE_GATEWAY_URL="$GATEWAY_URL" run deploy/build-web.sh
  run "$FIREBASE" deploy --only hosting --project "$FIREBASE_PROJECT_ID" --token "$FIREBASE_TOKEN"
else
  echo "SKIP_WEB=1 — web build + Firebase Hosting deploy skipped"
fi

echo "== deploy complete (dry_run=${DRY_RUN}) =="
echo "gateway: ${GATEWAY_URL}  engine-standard: ${ENGINE_STANDARD_URL}  engine-standard-2..5: ${ENGINE_STANDARD2_URL} ${ENGINE_STANDARD3_URL} ${ENGINE_STANDARD4_URL} ${ENGINE_STANDARD5_URL}  service: ${SERVICE_URL}  mcp: (deployed in 7c)"
