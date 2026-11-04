# Leg 6 — SSE/streaming disconnect reaping (engine)

Started: 2026-10-22 11:06 PDT — COMPLETED 2026-10-22 ~11:35 PDT
Status: DONE — code + regression tests only. Nothing deployed, no git push (per brief; coordinator redeploys).
TMPDIR used: ~/workspace/tmp-leg6

## Findings (code read 2026-10-22)
- Post-mortem (hidden_files/deploy-run/REPORT.md line 119 + FINAL STATE): Cloud Run platform 429s; engine-standard (containerConcurrency=1, maxScale=3) pinned by never-ending SSE/stream responses whose curl clients were killed; handlers did not reap on disconnect / no heartbeat timeout.
- `/deltas` (engineSvc.ts): DID register `res.on('close', removeSubscriber)` and a 15s heartbeat — BUT `sseSend` wrote with NO write callback (async write failures on dead/half-open sockets are invisible to try/catch), the heartbeat had NO reap timeout, and `removeSubscriber` never ended the response. A subscriber whose 'close' is never delivered (proxied/half-open case) stayed subscribed forever with the response open → request slot pinned.
- `/load/stream`: had a `clientGone` guard on res 'close' — BUT the awaited `data-done` write (`res.write(chunk, () => resolve())`) had NO timeout and no close race: on a dead socket the callback may never fire, parking the handler (and the W20 build gate) forever. Reproduced pre-fix: the new regression test's /load/stream leg timed out at 60s on the unfixed code. Writes also carried no error callbacks and there was no res 'error' listener.
- Client protocol tolerance (checked): collabTransport.ts consumes /deltas via native EventSource with named listeners — SSE comment frames (`: heartbeat`) are ignored by spec (already the existing heartbeat format). /load/stream consumers (collabTransport.ts, signedEngineTransport.ts, gatewayClient.ts) split NDJSON by line, skip blank lines, and drop unparseable lines with a warn — NO new wire frames were added anywhere.

## Files changed
1. `packages/gateway/src/services/engineSvc.ts`
   - `SseSubscriber` gains `lastFlushAt` + `reaped`.
   - New `sseWrite()` (every SSE event + heartbeat goes through it, WITH flush callback), `reapSubscriber()` (remove + clear interval + `res.end()`, idempotent); `sseSend` routes through them.
   - /deltas: heartbeat interval is env-driven, checks the reap window BEFORE writing; res 'close' AND 'error' reap.
   - /load/stream: `send()` carries flush callbacks (error → client-gone; success → lastFlushAt); res 'error' marks gone; disconnect watchdog ends+destroys the response as soon as the client is gone (or no flush within STREAM_WRITE_TIMEOUT_MS before data-done); the awaited data-done flush races write-callback vs res 'close' vs STREAM_WRITE_TIMEOUT_MS (on timeout: mark gone + destroy response + tail proceeds); watchdog cleared in the handler's finally next to `endLoadBuild`.
   - Tunables resolved once per listener from deployEnv.
2. `packages/gateway/src/deploy/engineAccess.ts` — three env parsers in the house pattern: `sseHeartbeatMs` (SSE_HEARTBEAT_MS, default 15000 = previous hardcoded cadence), `sseReapTimeoutMs` (SSE_REAP_TIMEOUT_MS, default 45000), `streamWriteTimeoutMs` (STREAM_WRITE_TIMEOUT_MS, default 30000). Production defaults need NO deploy-yaml changes; the env vars are optional overrides (tests use them to shrink windows).
3. `packages/gateway/tests/engineSvcStreamReap.test.ts` — NEW regression suite (5 tests, below).

## The reaping mechanism (5 lines)
1. Every streaming write (SSE events, SSE heartbeats, /load/stream chunks) now carries a flush callback: success refreshes `lastFlushAt`; an error reaps immediately.
2. /deltas reap = subscription removed from `state.sseSubscribers` + heartbeat interval cleared + `res.end()` — triggered by res 'close', res 'error', any failed flush, or the heartbeat tick finding no successful flush within SSE_REAP_TIMEOUT_MS (45s default).
3. Healthy clients are untouched: heartbeats flush every 15s (default), so `lastFlushAt` keeps refreshing and the reaper never fires; wire frames are byte-identical.
4. /load/stream: a watchdog ends+destroys the response the moment the client is gone (freeing the Cloud Run slot even while a parse finishes in the background; the tail then runs on guarded no-op sends and still settles the W20 build gate in its finally).
5. /load/stream's one awaited flush (data-done, before the sync build) is bounded by STREAM_WRITE_TIMEOUT_MS (30s default) raced against res 'close' — it can no longer park the handler on a dead socket.

## Regression test + results
Test file: `packages/gateway/tests/engineSvcStreamReap.test.ts` — wraps the real listener in its own HTTP server and spies on the REAL ServerResponse's write()/end() for the streaming routes (`endCalls > 0` = server-side handler ENDED the response; frozen write count after a broadcast = subscription removed). Legs:
1. /deltas: client destroys socket mid-stream → handler ends response ≤3s, connections drain to 0, later /presence broadcast attempts zero writes on it.
2. /deltas: flush callbacks start reporting EPIPE (dead socket, no close event) → subscriber reaped, no further write attempts.
3. /deltas: flushes blackholed (no success, no error, no close — the half-open case) → heartbeat-timeout reaper ends the response (SSE_REAP_TIMEOUT_MS=600 in test env; reaped in 738ms).
4. /deltas: two healthy clients are NOT reaped across several heartbeat periods, heartbeats arrive (`: heartbeat`), broadcasts reach both; after one disconnects the other keeps receiving.
5. /load/stream (P75 fixture, 13 sheets): client destroys socket right after the meta chunk → handler completes (response ended/destroyed), build finishes behind the dead stream, /sheets serves the new 13-sheet workbook and /read returns 200 (build gate settled).

Verification (exact counts):
- Pre-fix: all 5 tests FAILED (SSE legs never reaped/ended; /load/stream leg hit the 60s test timeout — the production hang reproduced).
- Post-fix: `engineSvcStreamReap.test.ts` — **5/5 passed** (5.3s).
- Related suites — **7 files, 94/94 passed**: engineSvc.test.ts 36, phase2Collab.test.ts 15, deployAccess.test.ts 22, engineSvcReadDuringBuild.test.ts 7, engineSvcStream.test.ts 7, gatewayEngineTimeout.test.ts 6, serverEngineGuards.test.ts 1.
- `tsc -p packages/gateway/tsconfig.json --noEmit` — **clean (exit 0)**, re-run on the final tree.

## Client-side change needed?
NO. Wire protocol is byte-identical for healthy clients: same SSE events, same `: heartbeat` comment frame at the same default 15s cadence, same NDJSON chunks on /load/stream, no new frame types. Only server-side lifecycle changed (plus optional env overrides with production-identical defaults).

## What could NOT land / caveats
- `parseWorkbookFast` has no abort API, so a /load/stream parse already in flight when the client dies runs to completion in the background (bounded by parse duration; its writes are no-ops and the response slot is freed immediately by the watchdog). Cancelling the parse workers on disconnect would need a new cancellation seam in parallelParse — flagged, not built (out of the brief's handler-reaping scope).
- A truly blackholed /load/stream AFTER data-done (during the sync build) is bounded by the build itself + the final end(); the pre-data-done window and the awaited flush — the two places the handler actually waits on the socket — are the ones with hard timeouts.
- Not deployed and not pushed, per brief — the coordinator redeploys. Suggest the redeploy validation include one killed-SSE-client check against a deployed engine-standard instance (connect /deltas, kill the client, confirm /health keeps returning 200 on all instances).
