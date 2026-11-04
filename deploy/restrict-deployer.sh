#!/usr/bin/env bash
# restrict-deployer.sh — swaps the deployer service account's temporary
# Owner role for the restricted 11-role set (deploy/CONFIG.md), then
# verifies the result by reading the project IAM policy back.
#
# User decision, 2026-10-21: the deployer SA is granted Owner ONLY as a
# bootstrap; this script is the FIRST thing run with its key, before any
# deployment step. The whole deployment then runs on the restricted set,
# which also proves the set is sufficient.
#
# Usage:  KEY_FILE=/path/to/key.json ./restrict-deployer.sh
#         GCP_PROJECT defaults to dreamscapes-zero.
set -euo pipefail

GCLOUD="${GCLOUD:-$HOME/workspace/tools/google-cloud-sdk/bin/gcloud}"
GCP_PROJECT="${GCP_PROJECT:-dreamscapes-zero}"
KEY_FILE="${KEY_FILE:?KEY_FILE must point at the deployer service-account JSON key}"

ROLES=(
  roles/run.admin
  roles/iam.serviceAccountAdmin
  roles/iam.serviceAccountUser
  roles/resourcemanager.projectIamAdmin
  roles/storage.admin
  roles/secretmanager.admin
  roles/artifactregistry.admin
  roles/cloudbuild.builds.editor
  roles/serviceusage.serviceUsageAdmin
  roles/datastore.owner
  roles/aiplatform.user
)

"$GCLOUD" auth activate-service-account --key-file="$KEY_FILE"
"$GCLOUD" config set project "$GCP_PROJECT" >/dev/null

SA_EMAIL="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["client_email"])' "$KEY_FILE")"
echo "Deployer SA: $SA_EMAIL  (project: $GCP_PROJECT)"

BEFORE="$("$GCLOUD" projects get-iam-policy "$GCP_PROJECT" --format=json \
  | python3 -c 'import json,sys; p=json.load(sys.stdin); [print(b["role"]) for b in p.get("bindings",[]) if "serviceAccount:'"$SA_EMAIL"'" in b.get("members",[])]')"
echo "--- Roles BEFORE:"
echo "$BEFORE" | sed 's/^/  /'

# NOTE: this project's policy contains conditional bindings, so every
# binding change needs --condition=None in non-interactive mode.
if echo "$BEFORE" | grep -qx "roles/owner"; then
  echo "--- Removing roles/owner ..."
  "$GCLOUD" projects remove-iam-policy-binding "$GCP_PROJECT" \
    --member="serviceAccount:${SA_EMAIL}" --role=roles/owner --condition=None >/dev/null
else
  echo "--- roles/owner already absent — skipping removal"
fi

for role in "${ROLES[@]}"; do
  echo "--- Adding ${role} ..."
  "$GCLOUD" projects add-iam-policy-binding "$GCP_PROJECT" \
    --member="serviceAccount:${SA_EMAIL}" --role="$role" --condition=None --quiet >/dev/null
done

echo "--- Roles AFTER (read back from the live policy):"
AFTER="$("$GCLOUD" projects get-iam-policy "$GCP_PROJECT" --format=json \
  | python3 -c 'import json,sys; p=json.load(sys.stdin); [print(b["role"]) for b in p.get("bindings",[]) if "serviceAccount:'"$SA_EMAIL"'" in b.get("members",[])]')"
echo "$AFTER" | sed 's/^/  /'

FAIL=0
if echo "$AFTER" | grep -qx "roles/owner"; then echo "FAIL: roles/owner still present"; FAIL=1; fi
for role in "${ROLES[@]}"; do
  echo "$AFTER" | grep -qx "$role" || { echo "FAIL: missing $role"; FAIL=1; }
done
[ "$FAIL" -eq 0 ] && echo "OK: deployer restricted to the 11-role set; Owner removed."
exit "$FAIL"
