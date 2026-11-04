#!/bin/sh
# Service-package container entrypoint.
#
# ONE image (deploy/Dockerfile.service) backs the service package. The
# DEPLOYED form is the combined runner (user's service inventory,
# 2026-10-20: the service package is ONE Cloud Run service):
#   service → dist/bin/service.js  (packages/gateway/src/bin/service.ts —
#             vault, meta, etl, agent and addons mounted in ONE process
#             behind /api/<name> prefixes; see deploy/services/service.yaml,
#             which sets SERVICE_BIN=service)
# The per-bin values remain selectable for LOCAL DEBUGGING only (the
# five separate local processes, ports 8102–8107, are unchanged):
#   vault  → dist/bin/vault.js   (credential vault service)
#   meta   → dist/bin/meta.js    (metadata store service)
#   etl    → dist/bin/etl.js     (ETL runner service)
#   agent  → dist/bin/agent.js   (AI agent host service)
#   addons → dist/bin/addons.js  (add-on service)
# All bins live in packages/gateway (src/bin/*.ts). Fails closed on an
# unset/unknown SERVICE_BIN — a misconfigured revision must never silently
# start the wrong service.
set -eu
BIN="${SERVICE_BIN:-}"
case "$BIN" in
  service|vault|meta|etl|agent|addons) ;;
  *) echo "[service-entrypoint] SERVICE_BIN must be one of: service vault meta etl agent addons (got: '${BIN}')" >&2; exit 64 ;;
esac
echo "[service-entrypoint] starting ${BIN} (PORT=${PORT:-unset})"
exec node "packages/gateway/dist/bin/${BIN}.js"
