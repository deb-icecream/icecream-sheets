#!/usr/bin/env bash
# =============================================================================
# Build the web app for Firebase Hosting.
#
# VITE_GATEWAY_URL is REQUIRED and is a build-time env (Vite inlines it):
# the bundle runs in gateway mode against that gateway — ALL engine/service
# traffic goes through it with JWT auth (apps/web/src/services/
# gatewayClient.ts). Rebuild + redeploy hosting whenever the gateway URL
# changes. Firebase web config (VITE_FIREBASE_*) is likewise build-time;
# supply it via env or apps/web/.env.local (see apps/web/.env.example).
#
# Usage:  VITE_GATEWAY_URL=https://gateway-….run.app deploy/build-web.sh
# Output: apps/web/dist  (firebase.json hosting.public)
# =============================================================================
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ -z "${VITE_GATEWAY_URL:-}" ]; then
  echo "BUILD BLOCKED: VITE_GATEWAY_URL is unset." >&2
  echo "It must be the deployed gateway's Cloud Run URL (deploy.sh sets it" >&2
  echo "automatically). A bundle built without it silently runs in the" >&2
  echo "rejected browser-local mode — refusing to build." >&2
  exit 78
fi
export VITE_GATEWAY_URL
# Signed engine access is REQUIRED for hosted bundles (2026-10-25, #133
# display-path failure, proven locally on a prod-like stack): the deployed
# engines run ENGINE_ACCESS_MODE=signed and refuse the gateway JWT the
# proxy transport forwards, so a proxy-mode bundle's every engine data
# call (snapshot, reads) 401s and the UI renders an empty workbook with
# no error. Signed mode (gateway-issued token, direct engine
# connection) is the production pattern (engine.ts remoteHostFor).
export VITE_ENGINE_ACCESS_MODE=signed
echo "building apps/web with VITE_GATEWAY_URL=${VITE_GATEWAY_URL} VITE_ENGINE_ACCESS_MODE=signed"
# --workspace build = `tsc && vite build` for @icecream-sheets/web,
# but its workspace deps must be built first (root build order).
npm run build --workspace=@icecream-sheets/engine
npm run build --workspace=@icecream-sheets/csv-adapter
npm run build --workspace=@icecream-sheets/ods-adapter
npm run build --workspace=@icecream-sheets/xlsb-adapter
npm run build --workspace=@icecream-sheets/xlsx-adapter
npm run build --workspace=@icecream-sheets/service
npm run build --workspace=@icecream-sheets/mcp-server
npm run build --workspace=@icecream-sheets/web
echo "built: apps/web/dist (gateway: ${VITE_GATEWAY_URL})"
