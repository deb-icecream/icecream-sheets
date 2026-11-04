# Library Save in Signed Mode — Fix Report

Worker: focused-fix subagent (dispatched 2026-10-22 ~01:57 PDT)
Brief: hidden_files/library-save-fix/BRIEF.md

## Status log (appended after each landed piece)

- STARTED 2026-10-22: brief read; shell-integration REPORT.md library-save
  sections read (lines ~8-10, ~80, ~109-116, ~293-297, ~341, ~358).
  Defect per brief: gateway-proxied library save 401s in signed mode
  (gateway forwards gateway JWT verbatim; signed engine rejects it).
  Share-import path already fixed via CollabTransport.librarySaveDirect.
  Normal Ctrl+S path (saveWorkbookToServerLibrary) still on proxied lane.

## Root cause (CONFIRMED in code, 2026-10-22)

- `App.tsx` `saveWorkbookToServerLibrary` (the manual library save AND
  the gateway autosave path) calls `gateway.engineLibrarySave({id?,
  name, ...buildServerSaveExtras()})` — its ONLY caller chain.
- `GatewayClient.engineLibrarySave` (gatewayClient.ts:451) unconditionally
  issues `this.call('/api/engine/library-save', POST, {format:'xlsx',
  ...payload})` — the gateway-proxied lane. The gateway forwards the
  caller's gateway JWT verbatim; a signed-mode engine refuses it as a
  malformed access token → 401 (curl-proven by shell integration:
  gateway+JWT 401 vs direct engine+access-token 200).
- The engine endpoint itself is sound: `POST /library-save` on the
  engine service (engineSvc.ts:5258) accepts `SaveExtras & {id?, name?}`,
  validates id shape, binds id-carrying saves to the session, runs the
  §3/§4 sequence (flush or runDirectSave → commitLibraryEntry atomic
  copy→tmp→rename), and returns `{ok, entry, revision}` with entry =
  full ServerLibraryEntry {id,name,owner,createdAt,modifiedAt,
  sizeBytes,backend:'gateway'}.
- The share-import path already bypasses the broken lane via
  `CollabTransport.librarySaveDirect(name)` (collabTransport.ts:1269),
  which POSTs /library-save through `fetchOpenedWithRefresh` with the
  session access token — but it accepts only a name (no id, no extras),
  so the general save (id + buildServerSaveExtras) cannot use it as-is.

## Fix (LANDED in code)

1. `apps/web/src/services/gatewayClient.ts`: exported
   `EngineLibrarySavePayload` / `EngineLibrarySaveResult` (extracted
   from the former inline types); `directLibrarySaveProvider` field +
   `setDirectLibrarySaveProvider` beside the download providers;
   `engineLibrarySave` is now async and consults the provider FIRST
   with the full wire payload `{format:'xlsx', ...payload}` — a
   non-null provider result wins; null falls back to the proxied call.
2. `apps/web/src/services/collabTransport.ts`: new
   `librarySave(payload)` — gates on `opened` only, POSTs /library-save
   via fetchOpenedWithRefresh (refresh+retry once on stale-token 401),
   returns the full entry or null on no-session/engine-error.
   `librarySaveDirect` (share import, name-only, throwing) untouched.
3. `apps/web/src/App.tsx`: provider registered beside the download
   providers in the collab-transport effect (wraps transport.librarySave
   into {ok:true, entry}); cleared in the same cleanup. No routing
   changes. design (mirrors the residual-(p) download pattern exactly)

1. gatewayClient.ts: `directLibrarySaveProvider` + setter beside the two
   download providers. `engineLibrarySave` consults it FIRST with the
   full wire payload `{format:'xlsx', ...payload}`; a non-null result
   wins; null (no live file session / direct attempt failed) falls back
   to the proxied call (legacy/proxy sessions, where that lane works).
2. collabTransport.ts: new `librarySave(payload)` sibling of
   downloadMetadata/downloadBytes — null when no session is opened;
   POSTs /library-save via fetchOpenedWithRefresh (stale-token 401 →
   §9 refresh → retry once, the D2 lesson); returns the full entry or
   null on engine error. `librarySaveDirect` (share import) untouched.
3. App.tsx: register the provider beside the download providers in the
   collab-transport effect; clear it in the same cleanup. Save plumbing
   only — no routing changes.


## Validation

### Lane repro (live stack, pre-tour) — defect reproduced
Isolated signed stack (own ports: gateway 8610 / engine 8611 / web
5974; data /tmp/libsave-data-v1; gateway+engine from packages/gateway/
dist; web dist built from CURRENT source incl. the fix, baked
gateway=8100+signed then byte-rewritten 8100→8610 by the stack script;
verify-dist PASS on the source dist). With a gateway JWT minted via
/auth/login (the exact credential the old client code presents):
- POST {gateway}/api/engine/library-save {format:'xlsx', name} →
  **401 {"ok":false,"error":"engine access denied: malformed"}** — the
  old lane, reproduced.
- POST {engine}/library-save with the same gateway JWT → same 401
  (the engine rejects the JWT itself; the proxy is not the problem —
  the credential class is).

### Browser tour (live stack, fixed dist) — PASS 14/15 + parse-back 6/6
Harness: hidden_files/library-save-fix/harness/ (lib.mjs, tour.mjs,
parse-back.mjs); screenshots in hidden_files/library-save-fix/shots/.
Real app, real grid, production topology, signed mode:
- Sign-in → Workspace → upload /tmp/shell-tour.xlsx → deep-link open;
  engine read-backs: A1=41, B1 formula =A1+1 evaluated 42.
- Grid edits (real cell clicks + typing): A1 41→50 (dependent B1
  recalculated to 51, read back from the engine), D1='libsave-probe'.
- Workbook Library dialog → name 'libsave-tour.xlsx' → "Save current
  to library": the save was answered by the DIRECT lane —
  **POST http://127.0.0.1:8611/library-save → 200**, response entry
  {id 'wb_mvjbnxfm_993qd8', sizeBytes 5870, revision 2,
  storageRevision 2, caughtUp: true}; **ZERO proxied
  POST /api/engine/library-save calls and ZERO 401s in the save
  window** (full network capture in the tour); the saved entry appears
  in the library dialog.
- The one FAIL is the parse-back FETCH inside the tour: it used the
  legacy engineLibraryBytes lane (gateway-proxied), which 401s in
  signed mode — see the corrected audit entry (a named remaining
  sibling on the OPEN path, not this fix's save lane). The bytes were
  then fetched directly from the engine with a session access token
  (HTTP 200, 5,870 bytes = the save's sizeBytes exactly) and parsed:
- **Parse-back (parse-back.mjs) ALL PASS**: PK xlsx; A1=50 (edit);
  B1 formula 'A1+1' intact with cached value 51 (recalced); D1=
  'libsave-probe' (edit); A2='shell tour fixture' (untouched).

### Local (unsigned) mode
Unchanged by construction: saveWorkbookToServerLibrary returns null
before engineLibrarySave is reached when not in gateway mode, and
engineLibrarySave with no provider registered is byte-for-byte the old
proxied call (unit-tested). No separate local-mode browser tour was
run — stated plainly per the evidence rule.

## Neighborhood audit (Save As / named saves) — code-level, complete

Every `/api/engine/*` call in gatewayClient.ts and every save-named
flow in App.tsx was classified:

- **Manual library save (Ctrl+S / save dialog)** — handleLibrarySave →
  saveWorkbookToServerLibrary → engineLibrarySave. THE defect. FIXED.
- **Gateway autosave path** — same function (saveWorkbookToServerLibrary
  is both). FIXED by the same change.
- **Web Save As** — no separate flow exists: saving under a new name is
  the library dialog through handleLibrarySave (no id → new entry).
  FIXED by the same change. Desktop Save As (handleDesktopSaveAs) is
  the native-file lane — no gateway involvement, unaffected.
- **Share-import save** — CollabTransport.librarySaveDirect — already
  direct (shell integration). Untouched.
- **Downloads/exports incl. named-range** ("named" exports) —
  engineDownload routes direct via the Phase 2 metadata provider and
  the residual-(p) bytes provider; proxied only as no-session fallback.
  Already fixed by earlier programs; not regressed (gatewayClient tests
  still green).
- **engineBindLibrary** (`POST /api/engine/session-bind-library`,
  gatewayClient.ts:480) — NAMED AS REMAINING, deliberately not fixed
  here: it is fire-and-forget from handleLibraryOpenEntry (`.catch(() =>
  undefined)`) and binds the gateway's Phase 1 proxy session to its
  library entry so server checkpoints commit into the user's file. It
  rides the same proxied lane and would 401 by the same mechanism in
  signed mode, BUT it is not a save (no serialization, no user-facing
  error; its failure silently degrades checkpoint targeting for the
  legacy open flow) and it has no direct-lane counterpart — a correct
  fix needs a transport bind method + session-identity design, which is
  beyond this focused fix. Recommended follow-up for the save
  workstream.
- **engineLibraryBytes** (GET /api/engine/library/:id, App.tsx:8014)
  — CORRECTED during live validation (my first classification was
  wrong): the gateway has NO special route for it, so the generic
  engine proxy forwards the gateway JWT and a signed engine 401s it
  ("engine access denied: malformed" — curl-proven on the live stack,
  both the proxied GET → 401 and the direct engine GET with a session
  access token → 200). It is the OPEN path for gateway-stored library
  entries (handleLibraryOpenEntry's bytes branch), i.e. the same
  defect FAMILY but not a save — NAMED AS REMAINING per the brief.
  The designed open path for catalog files (Workspace deep link →
  loadStorageRefDirect) is unaffected. A fix would mirror this one:
  a direct library-bytes lane on the transport + provider. Also note
  handleLibraryOpenEntry's follow-up `engineBindLibrary` rides the
  same proxied lane (previous bullet).
- Remaining proxied calls (execute/read/snapshot/load/session-*/
  reset) serve the Phase 1 proxied-session topology by design — those
  transports hold no direct channel. Not saves (load = open).

## Unit tests (LANDED, green)

- collabTransport.test.ts +4 (describe 'librarySave (general library
  save — direct provider lane)'): null with no session (and no engine
  call); full payload (id+name+extras) posted to the claimed engine
  with the access token, full entry returned; engine 500 → null
  (fallback semantics); stale-token 401 → §9 refresh → retry on the
  fresh engine/token succeeds. Suite: 43/43.
- gatewayClient.test.ts +4 (describe 'engineLibrarySave routing'):
  provider answers → no proxied fetch, provider receives the full
  wire payload; provider null → proxied POST /api/engine/library-save
  with {format:'xlsx', ...payload}; no provider → proxied; cleared
  provider → proxied. Suite: 9/9.
- Combined run: 52/52 pass. Web `tsc --noEmit`: clean.

## Remaining / NOT RUN

- **Named remaining (not fixed, per brief instructions):**
  (1) engineBindLibrary proxied lane — fire-and-forget checkpoint
  targeting for the legacy Phase 1 open flow (see audit).
  (2) engineLibraryBytes proxied lane — library-entry OPEN for
  gateway-stored entries 401s in signed mode (see corrected audit);
  fix shape mirrors this fix (direct bytes lane + provider).
- Full web suite (final gate, run on the fixed tree): **145/145 test
  files, 1837/1837 tests PASS** (the shell-integration baseline was
  1829; +8 = this fix's new tests; zero regressions). Web tsc clean.
- No git push performed (parent owns pushes); progress.md untouched.
