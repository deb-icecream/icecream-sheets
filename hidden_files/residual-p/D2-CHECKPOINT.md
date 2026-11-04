# D2 — Download button 401 for drop-opened sessions (signed mode): checkpoint

Worker e65a2e93 · started 2026-10-22 00:01 PDT · scope addition to residual (p).

## Task
Drop-opened sessions in signed mode: session fully live (/load/stream, /deltas,
/presence, /session-extras all 200) yet Download button issues only the
gateway-proxied POST /api/engine/download → 401 (gateway JWT ≠ engine token).
Designed escape hatch (GatewayClient.directDownloadMetadataProvider →
CollabTransport.downloadMetadata, gated on transport.opened) doesn't fire for
this session shape. Fix client wiring (provider / opened lifecycle) so the
Download button works for drop-opened sessions; validate with parse-back to
the same standard as the residual (p) export fixes. Final report must name D2
explicitly alongside the export verdicts (and restate the (p) deliverable).

## Prior state (residual (p), completed)
- Fix: collabTransport.downloadBytes + GatewayClient.directDownloadBytesProvider
  + App.tsx registration beside the metadata provider (~line 1717).
- Validated: after2 run 7/7 direct-200 UI downloads + parse-backs; local 5/5.
- Report: hidden_files/residual-p/REPORT.md.
- NOTE: my earlier tours used LIBRARY-UPLOADED sessions (upload via UI →
  session). The drop-open shape (drag-drop file → session) was used in the
  LOCAL tour only (unsigned). Signed drop-open was never exercised by me —
  consistent with D2 being live there.

## Progress log
- [x] Read roundtrip-audit D2 evidence (progress.md row 85; final-run.mjs
      comment: audit harvested the access token from the page's own /deltas
      URL and completed the download manually with it — so the transport HELD
      a session and credentials; the button still went proxied-only)
- [x] Diagnose opened/provider lifecycle for drop-open in code:
      * GatewayClient is a true singleton; providers registered in the
        transport effect (App.tsx ~1730/1735) on that singleton; drop-open
        (openRemoteBuffer) DOES call transport.connect() → opened set.
      * disconnect() does NOT clear opened. Provider-null is therefore NOT
        the primary suspect.
      * PRIME SUSPECT: downloadMetadata/downloadBytes use raw engineFetch
        (opened.accessToken as-is, NO refresh) while the load family uses
        fetchOpenedWithRefresh (401 → refreshOpened → retry once). Token
        TTL = ENGINE_ACCESS_TTL_SECONDS, default 600s. A session whose SSE
        never reconnects keeps a stale opened.accessToken past expiry →
        direct /download 401 → downloadMetadata swallows (!ok → null) →
        engineDownload silently falls back to proxied → 401 gateway JWT →
        UI "not authenticated (401)". Matches D2's "fully live session"
        symptom set (SSE established pre-expiry stays open; gateway-side
        routes unaffected).
      * FIX DIRECTION: route both download methods through
        fetchOpenedWithRefresh (makeBody factory), preserving null-on-
        failure fallback semantics. Prove by repro first (short-TTL stack).
- [x] Repro on short-TTL signed stack: CONFIRMED (captures/d2-before-results.json
      + d2-before-tour.log). Control (fresh token): direct POST :8411/download
      200, download fired. Test (+50s, TTL=30, SSE still connected): direct
      POST → 401 (stale token, no refresh) → silent null → proxied POST
      :8410/api/engine/download → 401 → UI "not authenticated (401)", no
      download. Provider DID fire — it fails on the stale token and the
      silent fallback masks it. That IS D2.
- [x] Fix: downloadMetadata + downloadBytes via fetchOpenedWithRefresh
      (collabTransport.ts; stale-token 401 → refreshOpened → retry once;
      second 401 → null → proxied fallback preserved)
- [x] Unit tests: +3 D2 cases in collabTransport.test.ts (metadata refresh
      + retry on fresh session; bytes refresh + retry; double-401 → null,
      openFile exactly 2×, no loop). Suites: collabTransport+gatewayClient
      36/36; io+StatusBar 26/26 (62/62 related, final source). Scoped tsc
      clean; full-source tsc passed in the baseline build chain.
- [x] Live validation (TTL=30 stack, fixed dist built from current source):
      control direct 200; test click → direct 401 → refresh → direct
      retry 200 → downloaded, err=null, ZERO proxied requests
      (captures/d2-after-results.json + d2-after-tour.log). Parse-back of
      the post-expiry download: PASS (captures/d2pb, parseback/d2pb).
- [x] Regression: exports tour on fixed build at normal TTL (d2reg):
      7/7 downloads all direct-200; parse-back profile identical to the
      (p) after2 run. Library/drop shapes both covered (the exports tour
      itself drop-opens).
- [x] Final report (restate (p) + D2)

## Notes for the parent
- Baseline dist for D2 was rebuilt by me from CURRENT source: apps/web/dist
  on disk was a shell-worker's plain build (no gateway env baked → boots
  local, no login gate) — not a controlled artifact. Current source still
  cannot be bundled by a plain build: the firestoreMetadata barrel breakage
  flagged in the (p) report is STILL live in service source (src/index.ts
  re-export) — validation builds used the harness shim config (deleted
  after; disclosed).
- Same stale-token pattern remains in other raw-engineFetch consumers
  (postEntry /ops, catchUp /revisions, postSessionExtras, postPresence,
  releaseOpenedSession, postDeltaAck) — best-effort or queue-managed;
  out of D2 scope, flagged only.
