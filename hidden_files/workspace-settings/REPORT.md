# Workspace Settings — Build Report

Coordinator started: 2026-10-22. Brief: `hidden_files/workspace-settings/BRIEF.md`.
Status legend: PENDING / IN PROGRESS / DONE / BLOCKED.

## Stage log
- 2026-10-22: REPORT skeleton created; exploration started.
- 2026-10-22: Exploration DONE. Key findings + decisions:
  - Gateway patterns: deploy stores in `packages/gateway/src/deploy/userStore.ts`
    (Memory/Local/Firestore adapters, lockfile JSON local, fail-closed prod
    factory keyed on USER_STORE env). Settings store goes in the same file +
    posture; collection `icecream_user_settings`. Routes live in
    `packages/gateway/src/gateway.ts` as `/api/files`-style blocks behind the
    verified-JWT pipeline; bin/gateway.ts injects stores explicitly.
  - JWT carries attrs {tier, name (Google), email} from /auth/firebase —
    GET /api/settings echoes email + Google name from the verified claims;
    the pipeline currently discards claims (keep principal only) → retain
    attrs in a variable.
  - Presence today: engine presence entries keyed by PRINCIPAL only
    (engineSvc.ts PresenceEntry, POST /presence {sheet,row,col,editing});
    broadcast {principal,color,sheet,row,col,editing}; web renders initials
    from the principal string (an opaque Firebase uid — meaningless) +
    title=principal. The display name NEVER reaches presence today.
    Fix chain: client sends `name` in the presence payload → engine stores
    + broadcasts it → clients render name/initials from it. Client name
    source = settings displayName ?? Firebase profile name ?? email.
  - Theme: index.css `:root` already tokenized (--bg/--panel/--line/--text/
    --muted/--accent/--header-bg…); grid + formula bar + sheet tabs are
    fully var-driven (grid is DOM, cells `background: var(--panel)`);
    product.css has a parallel --ics-* family. Dark = `[data-theme="dark"]`
    token overrides for both families + a TS theme module (choice →
    resolved via matchMedia, live system tracking, sets
    documentElement.dataset.theme). App.tsx has scattered hardcoded inline
    colors (app-header etc.) — convert the shell-critical ones to vars.
  - Deletion enumeration (gateway process): settings record (new), tier
    record (needs new UserTierStore.deleteRecord), file catalog records +
    upload-store bytes per storageRef (pattern = existing per-file DELETE),
    owned app shares (needs new AppShareStore.remove — hard delete so no
    package data remains), live registry leases for own files released
    best-effort (registry records themselves are fileId CAS metadata, no
    remove in the interface by design — they persist).
    OUT OF SCOPE (named, with reasons): engine library-entry bytes (engine
    service owns that store; no library-delete endpoint exists — same
    posture as the existing per-file delete; catalog removal makes them
    unreachable); staged-but-never-completed upload objects (no list op on
    UploadObjectStore; names unguessable, access only via HMAC staging
    tokens); service-package per-user stores in OTHER processes (agent
    threads/memory `icecream-sheets.agent-threads.v1.<userId>`, saved-apps
    gallery, data sources, vault credentials, MCP memory) — no per-user
    deletion API exists on those services today; follow-up. Live engine
    sessions evict on the idle rule; deletion does not force-close them.
  - Firebase leg: firebasePort.ts has NO deleteUser today → add
    deleteCurrentUser + reauthenticateCurrentUserWithGoogle to the port,
    FirebaseAuthService.deleteAccount() with requires-recent-login →
    re-auth popup → retry once. Orchestration (App shell): server delete
    FIRST (throws → abort, still logged in), then Firebase attempt, then
    signOut → firebaseAuth subscription flips gwAuthed=false → landing.
    If the Firebase leg fails, the panel shows an honest result message
    (data deleted; sign-in account could not be removed) with a Continue
    button that completes the sign-out — still ONE deletion confirmation.
  - Tour auth: dev-login (ALLOW_DEV_LOGIN=1 on MY gateway instance) mints
    JWTs; harness seeds `icecream-sheets.gateway-token` in localStorage.
    Firebase leg in the tour = not-applicable path (no Firebase session in
    the local topology); the SDK path is unit-tested with a fake port.

## 1. Gateway settings store (deploy-store posture)
DONE — `packages/gateway/src/deploy/userStore.ts` (family posture):
`UserSettingsRecord { userId, user:{displayName|null}, office:{theme},
createdAt, updatedAt }` + `Memory/Local/Firestore UserSettingsStore`
(get/upsert/remove; partial-shape normalization fills defaults) +
`createUserSettingsStore` (USER_STORE family switch; prod fails closed
without an injected client; collection `icecream_user_settings`; local
file `user-settings.json` under USER_STORE_DIR). Supporting additions:
`UserTierStore.deleteRecord` (record + pending promotion for its email)
and `AppShareStore.remove` (hard delete) in all three adapters each.
bin/gateway.ts injects `userSettingsStore` with the other product stores.

## 2. Settings API (own-settings-only, email read-only)
DONE — gateway.ts: `GET /api/settings` (404 SETTINGS_NOT_FOUND when no
record; view echoes email + Google name from the VERIFIED token claims —
the auth pipeline now retains callerAttrs) and `PUT /api/settings`
(partial merge; blank displayName clears the override; >120 chars 400;
invalid theme 400; an `email` key at top level OR nested → 400
EMAIL_READ_ONLY, nothing written). Own-only by construction: the key is
the caller's own userId; no id in the path. Store unavailable → 503.

## 3. Deletion endpoint + store-by-store coverage
DONE (gateway side) — `DELETE /api/account` (503 when a core store is
unavailable; never half-deletes silently). Coverage:
- DELETED: settings record; tier record (+ pending promotion for its
  email); file catalog records (all owner's) + upload-store bytes for
  each storageRef object; owned app shares — HARD delete via new
  `remove()` (record + package data gone, not just revoked); live
  session-registry leases on the caller's own files released
  best-effort (response reports counts per store).
- PERSISTS BY DESIGN: fileRegistry records themselves — fileId CAS /
  epoch metadata with no user content beyond principal ids; the
  interface has no remove (records are the claim history); leases are
  released and expire on TTL regardless.
- OUT OF SCOPE (named): (a) engine-service library-entry bytes for
  created files — the engine owns that store and exposes no
  library-delete endpoint (GET only); catalog removal makes entries
  unreachable from the product — same posture as the pre-existing
  per-file DELETE. (b) staged-but-never-completed upload objects — the
  object store has no list operation; object names are unguessable and
  reachable only via short-lived HMAC staging tokens. (c)
  service-package per-user stores in OTHER processes — agent threads /
  long-term memory (`icecream-sheets.agent-threads.v1.<userId>`), saved
  apps gallery, data sources, vault credential refs, MCP per-user
  memory: no per-user deletion API exists on those services today, so
  the gateway endpoint cannot reach them; follow-up if the user wants
  cross-service erasure. (d) already-issued gateway JWTs expire
  naturally (12 h TTL); live engine sessions evict on the idle rule —
  deletion does not force-close a session another participant is in.

## 4. Web: Settings surface in Workspace (User + App/Office sections)
BUILT — `apps/web/src/product/SettingsPanel.tsx`: two fieldset cards
(User settings / "App settings — Icecream Office"), display-name form
(save → api.updateSettings; note calls out the presence use), email as
a readOnly input with explanatory note, theme as a labelled radio
group (Light/Dark/System; applies immediately, saved to the record),
Privacy danger block. Workspace.tsx: Settings button in the Workspace
header (aria-expanded) rendering the panel inline in the shell — the
grid gains NO settings surface. App.tsx passes the wiring (provider
profile, Firebase delete leg, sign-out finisher).

## 5. Presence name from settings
BUILT — chain: App seeds `product/userSettings.ts` session module at
login (settings fetch) + on save; CollabTransport gained
`presenceDisplayName` dep, read live at every presence post (name
rides POST /presence); engineSvc accepts + validates `name`
(≤120 chars, sticky across nameless posts), stores it on the
PresenceEntry and broadcasts it in BOTH presence mappings (live
broadcast + hello echo); PresenceParticipant gains `name?`; the App
avatar row renders initials + title from `name ?? principal`.
Effective-name precedence (userSettings.effectiveDisplayName):
settings override → provider name → email → principal fallback.
Live-session behavior: a name saved mid-session reaches peers on the
next presence heartbeat (≤10 s) because the name rides every post;
new joins carry it from their first post.

## 6. Theme (light/dark/system, app-wide incl. grid canvas)
BUILT — `product/userSettings.ts` theme engine: choice → resolved via
matchMedia, `data-theme` on <html>, live OS-flip repaint while the
choice is 'system' (explicit choices are sticky). index.css: the
app-wide `--*` tokens (chrome/formula bar/grid/sheet tabs are
var-driven; the grid is DOM — cells paint `var(--panel)`, text
inherits `var(--text)`) gain a `:root[data-theme='dark']` palette;
product.css: matching `--ics-*` dark overrides scoped to the product
roots + alert/danger tints. App shell chrome converted to tokens
(app-header, workspace top bar). main.tsx initTheme() sets the
resolved 'system' attribute before first paint in every host mode.
No-flash statement: initial paint always uses the OS preference
(system resolution); after login the saved choice applies when the
settings fetch returns (one gateway round trip). Anyone whose saved
choice matches their OS sees no repaint; a saved Dark on a light-OS
device repaints once, early (before/at Workspace paint in the common
case, since the fetch races the catalog fetch). NOT localStorage:
persistence is the server record — the fresh-context tour leg proves
it (empty storage, theme still applied).

## 7. Delete flow (in-app dialog, Firebase deleteUser, logout → landing)
BUILT — SettingsPanel owns the ONE confirmation (own modal,
role=alertdialog, focus lands on Cancel; copy names profile +
settings + files + shares + the sign-in account attempt + possible
re-auth prompt; no type-to-confirm). Confirm → api.deleteAccount()
(throw = abort, still signed in) → onFirebaseDelete (App →
FirebaseAuthService.deleteAccount: port.deleteCurrentUser;
auth/requires-recent-login → reauthenticateCurrentUserWithGoogle
popup → retry once; outcomes deleted / failed / not-applicable —
firebasePort gained both port methods, real SDK deleteUser +
reauthenticateWithPopup; unconfigured stub rejects) → onSignedOut
(App: gateway logout, clear session settings, theme back to system,
signOut, gwAuthed=false → landing page, logged out). Firebase-failed
outcome shows an honest in-panel result (data deleted; sign-in
account remains; sign-in again = fresh empty account) with one
Continue button completing the sign-out.

## 8. Unit tests
DONE — Gateway `packages/gateway/tests/userSettings.test.ts` (13 tests,
all passing): settings-store semantics across Memory/Local/
Firestore-fake adapters + prod factory fail-closed; tier
`deleteRecord` (+ pending-promotion clearing, fresh re-login =
default); share `remove` hard delete; API ownership (401
unauthenticated, 404 before save, cross-user unaddressability — Bob
cannot see or touch Ada's record), email rejection (top-level AND
nested, nothing written), blank-clears-name, 120-char cap, theme
validation, full DELETE /api/account coverage (2 files, 1 stored
object, 1 share, 1 released lease, registry record persists with the
lease released, other user untouched), no-op delete, 503 posture.
Web: `product/userSettings.test.ts` (theme resolution matrix, live OS
tracking, sticky explicit choices, name precedence), 
`product/SettingsPanel.test.tsx` (both sections render, email input
readOnly, name save → API + presence source, theme radio → API +
data-theme, delete dialog — window.confirm/alert SPIED and never
called across cancel/confirm/server-failure/Firebase-failure paths),
`services/firebaseAuth.test.ts` deleteAccount block (deleted /
not-applicable ×2 / requires-recent-login → re-auth → retry /
re-auth dismissed → failed / other error → failed, no re-auth),
`product/productApi.test.ts` settings block (404→defaults mapping,
update body shape, email never sent, delete counts). One real bug was
caught by these tests during development: the panel's form onSubmit
initially dropped the event argument (fixed in the component).

## 9. Suites + tsc
DONE — Gateway: full suite **358/358 passed** (345 pre-existing + 13
new), `tsc --noEmit` clean. Web: full suite **149 files / 1912 tests
passed**; `tsc --noEmit` clean (re-verified after the final cosmetic
edits); the six touched-area test files re-run after all edits:
**84/84 passed**. Note: the two FakePort test doubles
(firebaseAuth.test.ts, FirebaseLoginButton.test.tsx) gained the two
new port methods — the only test-file edits outside new tests.

## 10. Browser validation tour (isolated stack, screenshots)
DONE — **34/34 checks passed, 0 native dialogs** (harness/results.json
+ harness/tour.mjs; screenshots in shots/, every one self-inspected).
Stack: production topology, all private — gateway 8930 / engine 8931
/ web 6294 (moved off 8920/8921/6284 mid-run after a foreign process
took 8920 during a VM service restart; secrets verified matching by
hash on the new ports), signed engine access, local stores under
~/workspace/tmp-ws-settings/stack, web dist = the app's own vite
production build (minified; verify-dist OK; private copy byte-rewritten
to the tour gateway port). Two dev-login users (Ada/Bob), fresh user
ids per run. Proven, in order: Settings button in Workspace (01);
panel with both sections + email readOnly in the DOM (02); name saved
→ server record shows displayName "Ada Countess"; dark theme on
Workspace (03) AND the opened sheet (04) — unselected grid cells
rgb(30,41,59) with rgb(226,232,240) text (~12:1), formula input dark
after a fix this tour caught (`.formula-input` had no background and
rendered UA-white; it now paints var(--panel)), no settings surface
in the grid; FRESH browser context + light OS still lands dark (05 —
server record, empty storage); System persisted, resolves light under
light OS (06), tracks a LIVE OS flip without reload (07), resolves
dark under dark OS (08); Light persisted (09); presence — Bob sees
"Ada Countess" (avatar title + AC initials, 10), Ada sees Bob
(principal fallback + his remote selection tag, 11), light-theme
cells white in the shared sheet; delete — ONE in-app dialog (12),
Cancel → settings still 200, Confirm → logged-out landing page (13),
then API evidence: settings 404, file 404, list count 0, the stored
object file gone from the upload dir, Bob untouched; re-login → fresh
empty account, "No files yet", default System theme (14).
Presence was additionally proven at the API level (harness/papi.mjs):
second user's SSE hello carries
`{"principal":"user:carol-…","name":"Carol Danvers",…}`.
Two tour-design facts worth knowing: presence is selection-driven by
design (§8) — a client posts on selection movement, so the tour
clicks a cell after opening, like a real user; and the local
single-instance engine hosts one live file at a time, so the sheet
legs share one fileId (production gives each session its own
instance). The Firebase deleteUser leg exercised the not-applicable
path in this topology (dev-login has no Firebase session); the SDK
path (incl. requires-recent-login re-auth) is unit-tested against a
fake port (§8).

## Desktop note
Desktop local (logged-out) mode has no account and no gateway: App
never fetches settings (the load effect is gateway-mode only),
`initTheme()` still runs at startup so the shell paints the OS-resolved
default ('system'), and nothing breaks without a settings record —
the shared web build treats settings as an optional layer throughout
(panel wiring is an optional Workspace prop; presence falls back to
the provider name/principal). Logged-in desktop uses the identical
web code path and gets the full feature. No desktop-specific code was
needed or added.

## Final verdicts
- Settings store + API (own-settings-only, email read-only, office
  theme scope): BUILT + unit-proven + tour-proven.
- Workspace Settings surface (User + Icecream Office + Privacy):
  BUILT + tour-proven (shots 01–03, 12).
- Presence name from settings: BUILT + proven at API level and from a
  second user's real browser view (shots 10–11).
- Theme light/dark/system, app-wide incl. grid, live OS tracking,
  fresh-context persistence: BUILT + tour-proven (shots 03–09, 14).
- Delete profile + data (one in-app dialog, zero native dialogs,
  server cascade + Firebase attempt + logged-out landing + fresh
  re-login): BUILT + tour-proven (shots 12–14).
- Suites/tsc: gateway 358/358 + clean; web 1912/1912 + clean;
  touched-area re-run 84/84.
- NOT done / out of scope by design (see §3): engine-owned library
  bytes, never-completed staged uploads, service-package per-user
  stores in other processes (no deletion API exists there) — named
  follow-ups, unchanged from the design recorded before building.
- No git push performed; progress.md untouched (both are the parent's).
