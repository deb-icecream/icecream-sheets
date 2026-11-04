# Library-Entry Open (engineLibraryBytes) in Signed Mode — Fix Report

Worker: focused-fix subagent (dispatched 2026-10-22 ~02:20 PDT)
Brief: hidden_files/library-bytes-fix/BRIEF.md
Predecessor: hidden_files/library-save-fix/REPORT.md (same defect family,
Ctrl+S library save — fixed via directLibrarySaveProvider +
CollabTransport.librarySave).

## Status log (appended after each landed piece)

- STARTED 2026-10-22: brief + library-save-fix REPORT.md read.
  Defect per brief: `GatewayClient.engineLibraryBytes(id)` fetches a
  saved library entry's bytes through the gateway-proxied lane; in
  signed mode the gateway forwards the gateway JWT verbatim and the
  signed engine rejects it (401) — opening a workbook from the library
  fails. Sibling to disposition: `engineBindLibrary` (same lane).
- COMPLETE 2026-10-22: root cause confirmed in code; fix landed
  (direct provider lanes for BOTH the bytes fetch and the session
  bind); 15 new unit tests; live tour 37/37 + parse-back ALL PASS on
  an isolated signed stack; full web suite 1852/1852. Named remaining:
  the no-session sub-case (by design; engine-side
  load-by-library-reference is the designed resolution, out of this
  brief's scope). Full record in the sections below.

## Root cause (CONFIRMED in code, 2026-10-22)

- `App.tsx` `handleLibraryOpenEntry` (App.tsx:8011) opens gateway-stored
  entries via `gateway.engineLibraryBytes(entry.id)` →
  `openRemoteBuffer(bytes, entry.name)` → then fire-and-forget
  `gateway.engineBindLibrary(entry.id, entry.name)`.
- `GatewayClient.engineLibraryBytes` (gatewayClient.ts:514)
  unconditionally fetches `{gateway}/api/engine/library/{id}` with the
  GATEWAY JWT. The gateway's generic engine proxy forwards that JWT
  verbatim; a signed-mode engine rejects it at its token gate
  (`verifyEngineAccessToken` fails → 401 "engine access denied:
  malformed") — curl-proven by the library-save worker on their live
  stack (proxied GET → 401; direct engine GET with a session access
  token → 200).
- The engine endpoint itself is sound and PRINCIPAL-scoped:
  `GET /library/:id` (engineSvc.ts:5369) serves the stored bytes when
  the entry belongs to the token's principal; it is NOT file-scoped.
- The signed-mode session-scope gate (engineSvc.ts:3944-3951) adds two
  hard constraints any direct lane must respect: (a) the token's sid
  must equal the engine's CURRENT live session id; (b) with NO live
  session on the engine, every non-session-introducing route 401s
  ("wrong-session") even with a valid token. A direct fetch riding the
  tab's opened collab session satisfies both by construction.
- NO-SESSION SUB-CASE (named up front): in a fresh tab with no collab
  session opened yet, there is no session token to ride and the engine
  gate refuses library reads outright — a bytes fetch cannot precede
  the §9 handshake by design. The provider therefore returns null in
  that posture and the proxied fallback remains (works in proxy/legacy
  mode; still 401 in signed mode). The designed resolution is an
  engine-side load-by-library-reference (handshake first, engine loads
  its own library bytes — the /load/storage-ref shape), which is
  engine work beyond this brief's client-plumbing scope. Named in
  Remaining with this root cause; the live tour will demonstrate the
  boundary explicitly rather than paper over it.

## engineBindLibrary disposition: FIX (same lane, same shape)

- Reachable + consequential in signed mode: it runs after EVERY
  gateway library open (App.tsx:8027, fire-and-forget). Proxied, it
  401s at the same token gate, silently (`.catch(() => undefined)`),
  so the bind never happens: server autosave checkpoints for a
  library-opened workbook then commit only to the session-internal
  `autosave_<sessionId>` entry, never into the user's library entry
  (engineSvc.ts:646-652, commit site :2846).
- The handler (engineSvc.ts:4070) binds the engine's CURRENT live
  session to a library entry owned by the caller's principal — so a
  direct call over the transport AFTER openRemoteBuffer (when the
  transport holds exactly that live session) is semantically exact,
  arguably more correct than the proxied call. It is NOT legacy-only.
  → Fix mirrors the save fix: directBindLibraryProvider on
  GatewayClient + CollabTransport.bindLibrary via
  fetchOpenedWithRefresh; proxied fallback on null.

## Fix (LANDED in code)

Mirrors the library-save fix exactly (direct provider lane, 3 files,
open plumbing only):

1. `apps/web/src/services/collabTransport.ts`: new `libraryBytes(id)`
   — gates on `opened` only, GETs `/library/<id>` DIRECTLY on the
   claimed engine via fetchOpenedWithRefresh (stale-token 401 → §9
   refresh → retry once, the D2 lesson); returns the Blob, or null on
   no-session / engine error / JSON answer (an error class, never
   workbook bytes). New `bindLibrary(id, name?)` — same lane, POSTs
   `/session-bind-library`, returns `{ok, boundLibraryId}` or null.
2. `apps/web/src/services/gatewayClient.ts`: `directLibraryBytesProvider`
   + `setDirectLibraryBytesProvider` and `directBindLibraryProvider` +
   `setDirectBindLibraryProvider` beside the library-save provider.
   `engineLibraryBytes` consults the bytes provider FIRST (non-null
   wins); the proxied fetch is byte-for-byte the old call on null.
   `engineBindLibrary` is now async and provider-first with the same
   proxied fallback (its only caller is fire-and-forget, so the
   signature change is safe).
3. `apps/web/src/App.tsx`: both providers registered beside the
   library-save provider in the collab-transport effect; both cleared
   in the same cleanup. No routing changes.

Why the direct lane passes the engine's signed gate: the engine's
/library/:id is principal-scoped (the caller's own entries only) and
the session-scope check (token sid === the engine's live session) is
satisfied by construction — the transport's opened session IS the
live session whose token it presents.

## Validation

- **Unit**: collabTransport **51/51** (43 prior + 8 new: libraryBytes
  no-session null + zero engine calls, direct GET with the session
  token, 404 → null, JSON answer → null, stale-token 401 → §9 refresh
  + retry on the fresh session; bindLibrary no-session null, direct
  POST {id, name} → `{ok, boundLibraryId}`, engine error → null);
  gatewayClient **16/16** (9 prior + 7 new: engineLibraryBytes
  provider-first / null-fallback / no-provider / cleared-provider;
  engineBindLibrary provider-first / null-fallback / no-provider).
  Web `tsc --noEmit` clean. Full web suite: see the final line of
  this section (run as the last gate).
- **Live tour (real app, isolated signed stack — gateway 8710 /
  engine 8711 / web 6074, data /tmp/libbytes-data-v1, dist from
  `npm run build:local-stack` with the start script's byte-length
  port rewrite 8100 → 8710; harness in `harness/`, screenshots in
  `shots/`) — 37/37 PASS** (final run; entry
  `wb_mvjcyaaq_9ltxzw`, file `file-011cbd8c-5056-4246-a0e0-3a58e0c53a22`):
  - Phase 1: sign-in → Workspace upload → deep-link open (A1=41,
    B1 `=A1+1` → 42) → grid edits A1→50 (B1 recalcs 51),
    D1='libbytes-probe', all engine-read-back → library save via the
    direct lane (predecessor's fix), entry listed.
  - Phase 2 (the fix): entry opened FROM THE LIBRARY dialog with the
    session live → **GET engine:8711/library/<id> 200 DIRECT, ZERO
    proxied /api/engine/library calls, ZERO 401s on the library
    lanes** → grid shows the workbook (screenshot `lb-04`, inspected:
    A1=50 selected, B1=51, D1='libbytes-…', Data tab, '✓ Saved') →
    new session minted, engine read-backs A1=50 / B1=51 (formula
    intact) / D1='libbytes-probe' → **bind: POST
    engine:8711/session-bind-library 200 DIRECT,
    boundLibraryId == entry id, ZERO proxied binds** → behavioural
    bind proof: edit E1='bind-probe' in the reopened workbook →
    server checkpoint committed it INTO THE ENTRY's stored bytes
    (polled via direct engine fetch).
  - **Parse-back ALL PASS** (`harness/parse-back.mjs` on the entry
    bytes fetched after the bind checkpoint, 6,705 B, saved as
    `shots/libbytes-parseback.xlsx`): PK magic; A1=50; B1 formula
    `A1+1` cached 51; D1='libbytes-probe'; E1='bind-probe';
    A2='shell tour fixture' untouched.
  - Phase 3 (fresh tab, same profile): boots signed-in, NO session →
    boundary demonstrated (below) → deep-link JOINS tab 1's live
    session (grid A1=50, read-back joined revision 1) → entry opened
    from the library → **bytes DIRECT 200 again, ZERO proxied, ZERO
    library-lane 401s** → entry state read back via the session
    (A1=50, E1='bind-probe').
  - Local (unsigned) mode: unchanged by construction — the providers
    register only inside the gateway-mode collab effect, and with no
    provider `engineLibraryBytes`/`engineBindLibrary` execute the
    byte-for-byte old proxied calls (unit-pinned). No separate
    local-mode tour, stated plainly (the predecessor's evidence rule).
- Full web suite: **145/145 files, 1852/1852 tests PASS** (1837
  baseline + the 15 new tests above; zero regressions). Final gate
  complete 2026-10-22.

## Remaining / NOT RUN

1. **NAMED REMAINING — the no-session sub-case (by design, not a tour
   failure).** Proven live in phase 3: in a tab with NO collab session
   opened, there is no session token to ride and the engine's signed
   gate refuses library reads without one, so the provider returns
   null and the proxied fallback 401s
   (`engine access denied: malformed`) — a library entry cannot be
   opened from that posture. In the shipped shell flow the posture is
   effectively unreachable for the dialog (reaching the grid mints or
   joins a session first; the phase-3 boundary was demonstrated with
   a raw fetch replicating the old lane). The designed resolution is
   an engine-side **load-by-library-reference** (run the §9 handshake
   first; the engine loads its own library bytes — the
   /load/storage-ref shape). That is engine work beyond this brief's
   client-plumbing scope; NOT built here.
2. **Observation (pre-existing, not this fix): the load path's
   stale-token race.** Each library open's window contained 1–2
   `GET {engine}/sheets` 401s (the superseded session's token racing
   the refresh) — self-healed (grid + read-backs complete). Same
   D2/item-L family; the /sheets fetch is not one of this fix's lanes.
3. **Observation (pre-existing, item-L family):** the fresh tab's
   window contained one PROXIED `POST /api/engine/session-extras`
   401 — `postSessionExtras` is one of the no-refresh paths item L
   already names; untouched here.
4. **Observation (pre-existing one-session design):** two tabs
   claiming DIFFERENT files race the engine's release/claim fencing
   (tour run 2 + probe evidence: 409s, the second tab's session never
   forms, and the provider then CORRECTLY falls back to the proxied
   lane, which 401s). Joining the SAME file (phase 3 final shape)
   works. Not this defect; recorded so the behaviour is not
   misattributed to the library lanes.
5. NOT RUN per brief: progress.md edits, git push (parent's lanes).
