#!/usr/bin/env bash
# park-deployer.sh — strips ALL roles from the deployer service account
# (parks it at zero permissions) and verifies from the live IAM policy.
#
# User decision, 2026-10-21 (Option B): the deployer keeps its 11 scoped
# roles until deployment; IMMEDIATELY after a successful deploy this
# script runs — the SA ends with zero roles, and with DELETE_KEY=1 the
# bootstrap key itself is deleted too (the end state: a powerless
# account and no live key; runtime services use their own SAs).
#
# Usage:  KEY_FILE=/path/to/key.json ./park-deployer.sh
#         DELETE_KEY=1 KEY_FILE=... ./park-deployer.sh   # also delete the key
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

sa_roles() {
  "$GCLOUD" projects get-iam-policy "$GCP_PROJECT" --format=json \
    | python3 -c 'import json,sys; p=json.load(sys.stdin); [print(b["role"]) for b in p.get("bindings",[]) if "serviceAccount:'"$SA_EMAIL"'" in b.get("members",[])]'
}

echo "--- Roles BEFORE:"
sa_roles | sed 's/^/  /' || true

# NOTE: this project's policy contains conditional bindings, so every
# binding change needs --condition=None in non-interactive mode.
for role in "${ROLES[@]}"; do
  if sa_roles | grep -qx "$role"; then
    echo "--- Removing ${role} ..."
    "$GCLOUD" projects remove-iam-policy-binding "$GCP_PROJECT" \
      --member="serviceAccount:${SA_EMAIL}" --role="$role" --condition=None >/dev/null
  fi
done

echo "--- Roles AFTER (read back from the live policy):"
AFTER="$(sa_roles)"
if [ -z "$AFTER" ]; then
  echo "  (none)"
  echo "OK: deployer parked at zero roles."
else
  echo "$AFTER" | sed 's/^/  /'
  echo "FAIL: roles remain — see above."
  exit 1
fi

if [ "${DELETE_KEY:-0}" = "1" ]; then
  KEY_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["private_key_id"])' "$KEY_FILE")"
  echo "--- Deleting the bootstrap key itself ..."
  "$GCLOUD" iam service-accounts keys delete "$KEY_ID" \
    --iam-account="${SA_EMAIL}" --project="$GCP_PROJECT" --quiet
  echo "Key deleted. The local key file is now useless — remove it."
fi
