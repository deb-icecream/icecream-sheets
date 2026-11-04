#!/bin/sh
# Engine container entrypoint — heap discipline.
#
# The local stack starts the engine as (packages/gateway/package.json):
#   node --expose-gc --max-old-space-size=6144 dist/bin/engine.js
# On Cloud Run the heap must scale with the tier (design doc:
# engine-standard 4 vCPU / 16 GiB, engine-xl 8 vCPU / 32 GiB), so the size
# comes from ENGINE_HEAP_MB, set per service in deploy/services/*.yaml:
#   engine-standard → 12288  (75% of 16 GiB; rest: OS, worker threads,
#                             parse workers, in-memory tmpfs headroom)
#   engine-xl       → 24576  (75% of 32 GiB)
# Default 6144 preserves exact local-stack behavior when the env is unset.
set -eu
HEAP_MB="${ENGINE_HEAP_MB:-6144}"
case "$HEAP_MB" in
  ''|*[!0-9]*) echo "[engine-entrypoint] ENGINE_HEAP_MB must be a positive integer, got: $HEAP_MB" >&2; exit 64 ;;
esac
echo "[engine-entrypoint] node --expose-gc --max-old-space-size=${HEAP_MB} dist/bin/engine.js (PORT=${PORT:-unset})"
exec node --expose-gc --max-old-space-size="${HEAP_MB}" packages/gateway/dist/bin/engine.js
