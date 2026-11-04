#!/usr/bin/env bash
# create-trigger-scheduler.sh — ROLLOUT STEP for the triggers program
# (Scope update 2, user-approved 2026-10-22): create the ONE Cloud
# Scheduler job that wakes the trigger tick, plus everything it
# needs. This is NOT part of the first deploy (deploy.sh) — run it
# once the five services are deployed and healthy. Idempotent: safe
# to re-run (creates what is missing, updates what exists).
#
# What it does:
#   1. Creates the dedicated scheduler service account
#      (icecream-trigger-tick@<project>) if missing.
#   2. Grants it roles/run.invoker on icecream-sheet-service ONLY
#      (the tick endpoint additionally verifies the OIDC token's
#      audience + this exact identity in-process — fail closed).
#   3. Sets the service's tick env: TRIGGER_TICK_AUDIENCE = the tick
#      URL (the audience Scheduler mints into the OIDC token) and
#      TRIGGER_TICK_SA_EMAIL. (These depend on the service's own URL,
#      which is why they are set here and not in deploy/services/
#      service.yaml.)
#   4. Creates (or updates) the job:
#        icecream-sheet-trigger-tick — every 1 minute — POST
#        https://<service-url>/api/automation/tick with an OIDC
#        token (audience = the tick URL itself).
#      The tick scans the trigger store for due timed triggers;
#      persisted lastFiredAt is the fire marker, so Scheduler's
#      at-least-once delivery can never double-fire a trigger.
#
# Usage:  ./create-trigger-scheduler.sh
#         GCP_PROJECT defaults to dreamscapes-zero, REGION to us-central1.
#         DRY_RUN=1 prints the gcloud commands without running them.
set -euo pipefail

GCLOUD="${GCLOUD:-$HOME/workspace/tools/google-cloud-sdk/bin/gcloud}"
GCP_PROJECT="${GCP_PROJECT:-dreamscapes-zero}"
REGION="${REGION:-us-central1}"
SERVICE="icecream-sheet-service"
JOB="icecream-sheet-trigger-tick"
SA_NAME="icecream-trigger-tick"
SA_EMAIL="${SA_NAME}@${GCP_PROJECT}.iam.gserviceaccount.com"

run() {
  if [ "${DRY_RUN:-0}" = "1" ]; then
    printf '[dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

SERVICE_URL="$("$GCLOUD" run services describe "$SERVICE" \
  --region="$REGION" --project="$GCP_PROJECT" \
  --format='value(status.url)')"
TICK_URL="${SERVICE_URL}/api/automation/tick"
echo "tick endpoint: ${TICK_URL}"
echo "scheduler SA:  ${SA_EMAIL}"

# 1. Scheduler service account (idempotent).
if ! "$GCLOUD" iam service-accounts describe "$SA_EMAIL" \
    --project="$GCP_PROJECT" >/dev/null 2>&1; then
  run "$GCLOUD" iam service-accounts create "$SA_NAME" \
    --project="$GCP_PROJECT" \
    --display-name="Icecream Sheets trigger tick (Cloud Scheduler)"
else
  echo "service account exists: ${SA_EMAIL}"
fi

# 2. Invoker on the service ONLY (the platform half of the auth; the
#    endpoint's in-process OIDC check is the application half).
run "$GCLOUD" run services add-iam-policy-binding "$SERVICE" \
  --region="$REGION" --project="$GCP_PROJECT" \
  --member="serviceAccount:${SA_EMAIL}" --role="roles/run.invoker"

# 3. Tick env on the service.
run "$GCLOUD" run services update "$SERVICE" \
  --region="$REGION" --project="$GCP_PROJECT" \
  --update-env-vars="TRIGGER_TICK_AUDIENCE=${TICK_URL},TRIGGER_TICK_SA_EMAIL=${SA_EMAIL}"

# 4. The job: every minute, OIDC-authenticated POST to the tick.
if "$GCLOUD" scheduler jobs describe "$JOB" \
    --location="$REGION" --project="$GCP_PROJECT" >/dev/null 2>&1; then
  run "$GCLOUD" scheduler jobs update http "$JOB" \
    --location="$REGION" --project="$GCP_PROJECT" \
    --schedule="* * * * *" --time-zone="Etc/UTC" \
    --uri="$TICK_URL" --http-method=POST \
    --oidc-service-account-email="$SA_EMAIL" \
    --oidc-token-audience="$TICK_URL"
else
  run "$GCLOUD" scheduler jobs create http "$JOB" \
    --location="$REGION" --project="$GCP_PROJECT" \
    --schedule="* * * * *" --time-zone="Etc/UTC" \
    --uri="$TICK_URL" --http-method=POST \
    --oidc-service-account-email="$SA_EMAIL" \
    --oidc-token-audience="$TICK_URL" \
    --description="Icecream Sheets: wake the trigger tick (due timed workbook triggers fire through self-opened sessions; see packages/gateway/src/services/tickAuth.ts)"
fi

echo "== trigger scheduler ready: ${JOB} -> ${TICK_URL} (every 1 minute) =="
