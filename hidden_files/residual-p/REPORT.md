# Residual (p) — exports in signed (gateway) mode: FIX + VALIDATION REPORT

Worker e65a2e93 · 2026-10-21/22 PDT · Status: **FIXED + VALIDATED** (one pre-existing
content-fidelity observation + one sibling build breakage flagged, both out of scope)

## Problem (from Phase-2 leg-a defect 4 follow-up)

Phase 2 fixed whole-workbook XLSX download for signed mode via a direct
`downloadMetadata` call (client → owning engine, session-scoped signed token).
Named-range exports and all non-XLSX exports still took the gateway-PROXIED
byte branch (`POST {gateway}/api/engine/download` with the gateway JWT),
which the signed-mode engine rejects: **401 for every such export in
production posture**.

## Design decision — Option A: direct byte channel (mirrors the Phase-2 fix)

Authority: design-docs/revision-model-save-and-coauthoring.md §4 —
"Workbook bytes are never proxied through the engine or the gateway in the
download path"; §9 / deployment-architecture.md — the gateway returns
connection info only, the client connects DIRECTLY to the owning engine,
and the engine validates the token itself.

Option B (teach the gateway proxy to authenticate) was rejected on the
code: `packages/gateway/src/gateway.ts` `proxy()` forwards the client's
headers verbatim (including the gateway JWT) plus `x-principal`; a
signed-mode engine validates the bearer as its own session-scoped HMAC
access token and refuses the gateway JWT (proven live: proxied request
with gateway JWT → `401 {"ok":false,"error":"engine access denied:
malformed"}`), and the gateway holds no file-session state with which to
mint an engine token. No gateway/engine code was changed.

## Fix — 3 files, all in apps/web (export plumbing only)

1. `apps/web/src/services/collabTransport.ts` — new
   `downloadBytes(extras): Promise<Blob|null>` beside `downloadMetadata`:
   POST `/download` via `engineFetch` (session-scoped token, direct to the
   owning engine); returns null when not opened, on !ok, or on a JSON
   answer (the metadata class is never handed out as file bytes), so the
   caller falls back to the legacy proxied path for non-collab sessions.
2. `apps/web/src/services/gatewayClient.ts` — new
   `directDownloadBytesProvider` + `setDirectDownloadBytesProvider()`;
   `engineDownload`'s byte branch tries the provider FIRST with the exact
   extras the proxied call would send, falling back to the proxied fetch
   on null. Whole-workbook XLSX still takes the metadata → sign → storage
   path first (unchanged Phase-2 behavior).
3. `apps/web/src/App.tsx` — one provider-registration line (+ its cleanup
   line) beside the existing metadata-provider registration (~line 1717).
   Plumbing only; no routing/shell changes.

## Export-path map (signed mode)

| Path | Branch before | Before | Branch after | After |
|---|---|---|---|---|
| Whole-workbook XLSX (dialog/Save/email/save-encrypted source) | metadata → sign → storage (direct) | ✅ worked | unchanged | ✅ works |
| Whole-workbook CSV/TSV/ODS/HTML | proxied byte branch | ❌ 401, no download | **direct byte (new)** | ✅ 200 direct, downloads |
| Whole-workbook XLSB (API-level only; not in the Ribbon Format picker) | proxied byte branch | ❌ 401 proxied | **direct byte (new)** | ✅ 200 direct (1,831 B) |
| Named-range export, any format (dialog scope=namedRange) | proxied byte branch (scope bypasses metadata) | ❌ 401 | **direct byte (new)** | ✅ 200 direct, downloads |
| Email attachment CSV (via fetchServerExportBlob) | proxied byte branch | ❌ 401 | **direct byte (new)** | ✅ same path as workbook CSV |
| Download-as-PDF | client-side only | n/a | unchanged | n/a |
| Workspace stored-file download (`/api/files/:id/download-grant`) | gateway-native signed URL | ✅ worked | unchanged | ✅ works |
| Local/desktop exports | client-side builders | ✅ worked | unchanged | ✅ works (validated) |

## Validation (isolated signed stack: gateway 8410, engine 8411, web 4874)

Fixture: Sheet1 `[[10,20,999],[30,=A1+B1,],[111,,]]`, Sheet2 `[[7,8],[,=A1+B1]]`,
defined name `MyRange = Sheet1!$A$1:$B$2` (999/111 are outside the range —
named-range parse-back must exclude them). Driven through the real
GatewayLogin UI; name defined via Formulas → Define Name UI.

- BEFORE (`captures/before-results.json`, `parseback/before-parseback.json`):
  workbook XLSX direct 200 ✅; csv/tsv/ods/html + namedRange xlsx/csv all
  proxied → **401 "not authenticated"**, no downloads (NOT RUN parse-back —
  nothing to parse); XLSB proxied → 401; XLSB + CSV with the gateway JWT
  sent directly → 401 "engine access denied: malformed" (root cause pinned
  to the credential, not the route).
- AFTER, coherent run (`captures/after2-results.json`, `after2-tour.log`,
  `parseback/after2-parseback.json`): **7/7 UI downloads, every request a
  direct 200 to the owning engine** (`127.0.0.1:8411/download`). Parse-back
  (bytes re-read with the app's own adapters + engine): workbook XLSX PASS,
  ODS PASS, HTML PASS, named-range XLSX PASS (single sheet "MyRange", only
  the 2×2 cells, formula preserved), XLSB PASS (API-level direct, exact
  request shape the fixed client makes; XLSB is not reachable from the
  Ribbon picker UI).
- LOCAL (unsigned) regression (`captures/local-results.json`,
  `parseback/local-parseback.json`): plain dist, app boots to local
  engine; 5/5 downloads (workbook xlsx/csv/ods, named-range xlsx/csv);
  xlsx/ods/namedRange-xlsx parse-back PASS.

## Tests / build

- New/updated unit tests: `collabTransport.test.ts` (+5 `downloadBytes`
  cases; 28 total), NEW `gatewayClient.test.ts` (5 cases: direct-bytes
  routing for csv + named-range xlsx with zero proxied fetch, provider-null
  fallback to proxy, no-provider proxy path, whole-workbook metadata
  regression pin). Related suites re-run post-restart: **59/59 PASS**
  (collabTransport + gatewayClient + io + StatusBar).
- **Full-project `tsc` PASS** (as part of `npm run build:local-stack`),
  production minified dist built + `scripts/verify-dist.mjs --local-stack`
  OK; `downloadBytes` present in the shipped bundle. That dist is what the
  AFTER validation ran against.
- Gateway/engine suites: not run — no gateway or engine code was touched
  ("related suites as touched": web only).

## Observations (not residual-(p) defects; for the parent to route)

1. **Snapshot cached values after load-without-edit** (pre-existing,
   product-wide, byte-identical in local mode): formula cells export with
   no computed cache — XLSX writes `<f>A1+B1</f><v>0</v>`, and CSV/TSV text
   exports emit the formula string `=A1+B1` instead of the computed 30
   (CRLF line endings, which are standard). Proven identical in the LOCAL
   build's own outputs (same bytes, same `<v>0</v>`), i.e. the rerouted
   paths are byte-for-byte the product's existing server semantics; the
   old proxied path never reached serialization in signed mode (rejected
   at auth). Parse-back "FAIL" rows for csv/tsv/namedRangeCsv in
   `parseback/*-parseback.json` record exactly this (my checker expected
   computed values + LF). Any fix belongs to the snapshot/cache
   materialization layer, not the export transport.
2. **DownloadDialog defined-names gap** (pre-existing, all hosts): the
   dialog lists only the client Name-Manager store, which is never
   populated on open, so file-imported defined names (verified present in
   the fixture's workbook.xml) never appear in the dialog. Validation
   defined the name through the real UI instead. (Parent already has this
   classified from the defect-4 work.)
3. **Sibling build breakage (deploy-relevant, NOT mine)**: at 2026-10-22
   06:42 UTC the MCP-Firestore workstream's service rebuild made
   `packages/service/dist/index.js` re-export `firestoreMetadata.js`,
   which imports `createHash` from `node:crypto` — **any fresh web
   bundle build now fails** (`"createHash" is not exported by
   "__vite-browser-external"`). My signed dist (built 06:25 UTC) predates
   it and is valid. My local dist was built with a harness-only shim
   (temp vite config + throwing stub for that server-only module; config
   file deleted after the build, shim never shipped). That workstream
   needs a server-only entry point (or the web bundle breaks for
   everyone, including the deploy build).

## Not run, with reasons

- Full web test suite (1,784): VM was under heavy multi-coordinator
  contention all evening (repeated OOM kills of builds/tsc at exit 137;
  one service restart wiped /tmp). Related suites (59/59), full tsc, the
  production build, and three live end-to-end tours stand in.
- XLSB via UI: not reachable — the Ribbon Format picker offers only
  xlsx/csv/tsv/ods/html. Validated at API level through the exact direct
  request the fixed client issues (200, XLSB MIME, parse-back PASS).
- Email-attachment CSV as a separate UI flow: rides the identical
  `fetchServerExportBlob` → `engineDownload` byte branch validated for
  workbook/named-range CSV; not driven separately in the mail UI.

---

# ADDENDUM — DEFECT D2: Download button 401 for drop-opened sessions (2026-10-22)

Scope addition from the parent (round-trip audit finding D2). Status:
**FIXED + VALIDATED.** Checkpoint: D2-CHECKPOINT.md (same directory).

## Root cause (proven by reproduction, not just code reading)

The escape hatch DID fire — the failure was one layer deeper. The
handshake access token's TTL is `ENGINE_ACCESS_TTL_SECONDS` (600 s
default). A session whose SSE connection never reconnects keeps the
ORIGINAL `opened.accessToken` indefinitely (the EventSource was
established pre-expiry and stays open; presence/extras ride other
routes) — the session looks fully live while the token is stale.
`CollabTransport.downloadMetadata`/`downloadBytes` used raw
`engineFetch` (current token, no refresh), unlike the load family
(`loadXlsxDirect`/`resetDirect`/`loadXlsxProgressiveDirect`), which
uses `fetchOpenedWithRefresh` (401 → fresh gateway lookup → retry
once). So a download attempted after the TTL lapsed got a direct 401,
which the methods swallowed into `null`, and `engineDownload` silently
fell back to the gateway-proxied call → 401 (gateway JWT refused) →
UI "not authenticated (401)".

Repro (isolated signed stack, `ENGINE_ACCESS_TTL_SECONDS=30`, drop-open,
`captures/d2-before-results.json`): control click on a fresh token →
direct POST :8411/download **200**, download fired. Click at +50 s
(SSE still connected) → direct POST **401** → proxied POST
:8410/api/engine/download **401** → UI error, no download. The audit's
own workaround (harvesting the token from the page's /deltas URL and
calling the endpoints manually) is consistent: the session and its
designed path were sound; the client's token was stale.

## Fix (one file: apps/web/src/services/collabTransport.ts)

`downloadMetadata` and `downloadBytes` now call
`fetchOpenedWithRefresh('/download', { method: 'POST', makeBody })`
instead of raw `engineFetch` — a stale-token 401 refreshes the opened
session via the §9 gateway lookup (fresh token, current owner) and
retries exactly once; a second 401 still returns null, preserving the
legacy proxied fallback for sessions without a direct channel. No
App.tsx/gateway/engine changes; the residual-(p) provider wiring is
untouched.

## Validation

- Unit: +3 cases in `collabTransport.test.ts` (metadata refresh+retry
  lands on the fresh session; bytes refresh+retry; double-401 → null
  with exactly 2 openFile calls — no loop). Related suites on final
  source: **62/62** (collabTransport 31 + gatewayClient 5 + io +
  StatusBar 26). Scoped strict tsc clean.
- Live, short-TTL stack, fixed dist built from current source
  (`captures/d2-after-results.json`): control → direct 200, downloaded;
  post-expiry click → direct **401 → refresh → direct retry 200 →
  downloaded, no UI error, ZERO proxied requests**. Parse-back of the
  post-expiry download (`captures/d2pb/dl-workbook-xlsx.xlsx`,
  `parseback/d2pb-parseback.json`): **PASS** (exact values + formulas).
- Regression (`captures/d2reg-results.json`, normal TTL): the full
  residual-(p) exports tour on the fixed build — **7/7 downloads, all
  direct-200**; parse-back profile identical to the (p) after2 run
  (csv/tsv/namedRangeCsv rows carry the pre-existing snapshot
  formula-text semantics documented in Observation 1 of the main
  report — unchanged bytes, not a regression).

## Flagged (same pattern, out of D2 scope)

Other raw-`engineFetch` consumers share the no-refresh exposure:
`postEntry` (/ops), `catchUp` (/revisions), `postSessionExtras`,
`postPresence`, `releaseOpenedSession`, `postDeltaAck`. They are
best-effort or queue/reconnect-managed today; if the parent wants the
whole family hardened, routing them through `fetchOpenedWithRefresh`
is the same one-line-per-call change.

## Build note

The D2 validation dists were built from CURRENT source with the same
harness-only shim config as the (p) local build (temp config, deleted
after): the firestoreMetadata barrel breakage (Observation 3) is
**still live in service source** (`packages/service/src/index.ts`
re-exports it), so a plain `vite build` of the web app still fails for
everyone until that workstream lands its server-entry split. Also
note: the `apps/web/dist` found on disk at D2 start was a shell
worker's plain build (no gateway env baked — boots local with no
login gate), not a controlled artifact; all D2 evidence ran on
purpose-built dists.
