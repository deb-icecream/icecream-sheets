# Hosted UX fixes — user-reported defects from live testing (2026-10-22)

## Plan
- D1: session-restore race — FirebaseAuthService.restoreSession() reads
  port.getCurrentUser() synchronously; Firebase SDK restores persisted
  session async -> null -> service stuck logged-out after the full-page
  reload from Workspace file-open (location.assign). Fix: await first
  onAuthStateChanged emission (timeout-guarded), exchange exactly once,
  keep opSeq guards. Unit tests with async-emitting fake port.
- D2+D3: Agent chat composer visibility + theme correctness in gateway
  mode. Fix index.css token defects (--bg-soft undefined, duplicate
  conflicting dark palettes at lines 24/851, hardcoded light colors in
  chat sub-elements). Validate on local production-topology stack with
  light + dark screenshots, self-inspected.
- D4: Settings page email blank for Google users. Trace gateway
  attrs.email (gateway.ts:698) -> GET /api/settings echo (:1701) ->
  SettingsPage view?.email ?? profileEmail (:108) -> field (:263-266).
  Reproduce with a JWT carrying attrs.email; fix the loss point.

## Port block CLAIMED: 9010-9019 (gateway 9010, engine 9011, web 9012)
## TMPDIR: ~/workspace/tmp-hosted-ux

## Status
- [ ] D1
- [ ] D2+D3
- [ ] D4
- [ ] Final: full apps/web + gateway suites + tsc


## Findings (parent diagnosis verified in code, 2026-10-22)

### D1 root cause — CONFIRMED
firebaseAuth.ts restoreSession() reads port.getCurrentUser() once,
synchronously, at boot. The real port's getCurrentUser() reads
auth.currentUser, which is null until the Firebase SDK finishes its
async IndexedDB restore; onAuthStateChanged (firebasePort.ts:141) is
the SDK's "restore settled" signal and the service never subscribes.
So on ANY fresh page load restoreSession silently no-ops and the
service stays logged-out for the page lifetime, while GatewayClient's
localStorage JWT (gatewayClient.ts constructor) keeps the app working.
Fix: restoreSession awaits the first onAuthStateChanged emission
(timeout-guarded, fast path when getCurrentUser() already has the
user), sets logging-in during the wait, exchanges exactly once,
opSeq guards preserved.

### AUTH COHERENCE design (user ruling 2026-10-22 ~13:20 PDT)
Sign-in state and gateway token are ONE state, never split:
1. Boot: restoreSession resolves the Firebase session FIRST, then the
   exchange guarantees a fresh gateway token before 'logged-in' is
   reported (restore always exchanges). No Firebase session ->
   orphan stored token cleared too, but ONLY in the Firebase posture:
   App passes clearOrphanToken = !isDevLoginEnabled(gwClient), because
   local dev-login sessions legitimately hold a token with no Firebase
   session and file-open reloads depend on it. After restore settles,
   App re-syncs gwAuthed from gwClient.loggedIn so a cleared token
   drops the app to the login gate (no half-alive Workspace).
2. Runtime: GatewayClient gains a setter-injected reauth provider
   (same pattern as the direct-* providers). Every gateway-JWT fetch
   path (call(), download bytes, library bytes, load/stream, addons
   run — NOT the GCS signed-URL fetch, whose credential is the URL)
   runs through withReauth(): on 401, ONE provider call -> retry once
   with the fresh token; a second 401 throws as today. The provider is
   FirebaseAuthService.reauthenticateGateway(): single-flight; live
   Firebase user -> silent re-exchange (fresh gateway JWT) -> true;
   no Firebase user -> token cleared via exchange.logout(), service
   goes logged-out if it believed otherwise -> false. opSeq guard: if
   a newer auth op (sign-in/out) superseded us mid-exchange, the fresh
   token is cleared again rather than resurrecting a session.
3. Sign-out already clears both (service signOut -> exchange.logout()
   first, then Firebase signOut) — unchanged.
Unit coverage: both split directions — (a) token present + no Firebase
session at boot -> token cleared, stays logged-out, app gate drops;
(b) signed-in UI + dead token at runtime -> 401 triggers exactly one
re-exchange + retry and the call succeeds; Firebase session dead ->
token cleared + logged-out together, call surfaces the 401.

### D4 root cause — FOUND (two compounding losses)
The gateway side is sound when a settings record EXISTS (attrs.email
stamped at exchange -> callerAttrs -> view echo -> productApi map).
The loss is the NO-RECORD path + D1 compounding:
- GET /api/settings with no record -> 404 SETTINGS_NOT_FOUND whose
  body carries NO identity echo; productApi converts 404 ->
  defaultSettingsView() with email:null, googleName:null.
- SettingsPage falls back to profileEmail, which App derives from
  firebaseAuth.current — null whenever D1's race struck (any fresh
  load). Both sources null -> field renders blank/'-'.
Fix: (1) gateway 404 body gains the caller identity echo
user:{email, googleName} from the VERIFIED claims (status/code
contract unchanged); (2) GatewayClient error path attaches the parsed
JSON body (gatewayBody) to the thrown error before the 200-char
message truncation can clip it; ProductApiError carries it;
productApi's 404 branch fills email/googleName from it. D1's fix
independently repairs the profileEmail fallback.

### D2/D3 findings (static; D2 composer to be diagnosed on the stack)
index.css has TWO :root[data-theme='dark'] blocks (line 24 and line
851) setting the same 10 tokens; 851 wins by source order, 24 is fully
shadowed -> delete 24, 851 is the authoritative palette.
--bg-soft is consumed (.agent-msg-agent, .agent-artifact-placeholder)
but defined NOWHERE -> always light #f3f4f6; in dark theme agent
message text inherits near-white --text on near-white bubble =
unreadable. Define --bg-soft in :root (#f3f4f6, current light look)
and in the dark block (#273549).
Hardcoded light colors in chat: .agent-chip-on (#dbeafe/#93c5fd),
.agent-msg-notice (#fef3c7/#fcd34d), .agent-pending (#eff6ff/#93c5fd,
buttons #fff), .agent-audit-seq/.agent-audit-empty (#767676),
.agent-artifact-placeholder (#555), .agent-input-row input + Send
button (no surface tokens -> UA light in dark), AgentChat.tsx apps-tab
fallback inline color #555. All -> theme tokens (--accent-soft,
--accent, --panel, --muted, new --notice-bg/--notice-line pair).
AgentChat's render tree + App's agentOpen mount are structurally
sound (composer renders when tab==='chat'); composer visibility in
the real gateway-mode grid will be diagnosed empirically on the
validation stack (bounding box + computed style via playwright).

## Progress
- D1 service fix LANDED + tests green (firebaseAuth.test.ts 38/38):
  restoreSession emission-wait + coherence options; reauthenticateGateway
  single-flight repair. New coverage: async-restore race (exactly one
  exchange), null emission, orphan clear on/off by posture, timeout
  fallback, reauth success/single-flight/dead-session-converge/
  no-resurrect-from-logged-out/superseded-by-signOut/transient-failure.
- D5 added (user ruling 2026-10-22 ~13:30 PDT): agent panel DOCKS as a
  flex layout column (grid shrinks), draggable divider 280px..60vw,
  width persisted (localStorage), keyboard-operable separator
  (role="separator", arrow keys); artifact panel docks beside chat,
  fullscreen expand stays overlay. Validation gate: local
  production-topology tour + screenshots BEFORE any deploy.
- Coherence client wiring LANDED: GatewayClient.withReauth wraps call(),
  download bytes, library bytes, load/stream, addons run (headers rebuilt
  per attempt); App wires setReauthProvider + restoreSession
  ({clearOrphanToken: !isDevLoginEnabled}) + post-restore gwAuthed resync.
  Tests: gatewayClient.test.ts 21/21 (reauth retry/decline/second-401/
  no-provider/gatewayBody), productApi.test.ts 21/21.
- D4 LANDED: gateway 404 SETTINGS_NOT_FOUND body now echoes caller
  user:{email, googleName} from verified claims (userSettings.test.ts
  15/15); GatewayClient attaches parsed gatewayBody to thrown errors;
  ProductApiError.body carries it; getSettings 404 branch fills the
  default view's email/googleName. SettingsPage field needs no change
  (view.email now populated; D1 fix also repairs the profileEmail
  fallback).

## D6 — NEW PRIORITY (user live repro 2026-10-22 ~13:42 PDT)
Hosted signed mode: type "uuu" in a cell, commit → the edit DISAPPEARS.
Edit another cell, commit → "uuu" REAPPEARS. The grid display runs one
edit behind (optimistic display vs SSE delta application suspect:
remoteEngineHost / collabTransport / App commit flow — hypothesis to
prove). Work: reproduce on the local stack in a real browser (signed,
SSE on) with screenshots around each commit; root-cause from evidence;
fix; regression test that fails pre-fix; tour evidence. Batch is NOT
complete without D6.

## D1 coherence — self-inflicted regression FOUND + FIXED during D6 stack work
First stack run of the D6 tour went anonymous mid-session: after
GET /api/engine/access 200, every gateway call arrived
principal=anonymous and 401'd; the edits still landed server-side
(engine journal: ops=2, checkpoint rev=2) but nothing displayed.
Root cause chain: POST /api/engine/session-extras 401s BY DESIGN in
signed mode (proxied gateway JWT refused by the engine; its failure is
swallowed by the caller) -> my new withReauth treated it as token
death -> reauthenticateGateway, in the dev-login posture (Firebase
service logged-out by design), CLEARED the healthy dev gateway token
-> all later calls anonymous. Fixes: (1) App wires the reauth provider
ONLY when !isDevLoginEnabled (the token belongs to Firebase only in
that posture); (2) reauthenticateGateway refuses to clear while a
restore/sign-in is in flight ('logging-in' owns convergence).
Regression test added (restore-in-flight repair). NOTE: this also
means the first D6 tour run is INVALID as D6 evidence — re-running
after the fix.

## D6 — RESOLVED (root cause confirmed from production evidence; branch 2)
Production (parent, Cloud Run logs, user's session window 20:07 UTC):
the deployed engine services ran containerConcurrency=1. One session
holds several concurrent connections (load stream + always-on SSE +
ops + save-status polls), so the session's own streams starved its own
requests: 299 platform aborts in one hour, 236x GET
/session-save-status -> 429, 5x POST /execute -> 429, claim/snapshot
429s. The user's edits were refused by the PLATFORM before reaching
the engine; nothing from his session exists in durable storage. Fixed
live by the parent ~14:0x PDT: concurrency 1 -> 80 on
engine-standard (rev 00009-962) + engine-xl (rev 00007-rlt); yamls
corrected + pushed (8bec4d8c). Ownership is arbitrated by registry
CAS + epoch fencing (engineSvc), not request serialization.
LOCAL CONFIRMATION of branch 2: on the local stack (no concurrency
cap) the vanish does NOT reproduce — healthy signed session, blank
file: A1=uuu painted 311 ms after commit, B2=vvv 48 ms; throttled
(~300 ms RTT) healthy leg in tour-d6b (see below). No client delta bug
on the healthy path.

### D6 client-side defect FOUND + FIXED (the no-loss gap behind the symptom)
Rescoped question: when an op submission is refused (429/5xx), does
the client honor the design doc's no-loss rule? NO — proven on the
local stack (tour-d6b, pre-fix): with /ops+/execute answered 429, two
committed edits (C1=keepme1, D3=keepme2) entered the durable queue
(localStorage icecream.collab.<fileId>, queueLen 2) and SURVIVED a
full page reload (queueLen 2 after reload) — but after submissions
healed, they NEVER landed (20 s poll; queue still 2; a second client
joining the session confirmed C1/D3 empty server-side).
Mechanism (code): CollabTransport.postEntry treats an HTTP error
response as "keep queued" and returns silently; flushQueue() is
driven ONLY by handleHello (SSE connect). A transport-level throw
triggers handleDrop -> reconnect -> hello -> flush, but an HTTP 429
leaves the delta stream healthy, so nothing ever re-drives the queue
while the session stays connected. (In production this is exactly how
a refused edit could sit invisible until some later reconnect flushed
it — the "reappears later" half of the user's report.)
FIX (apps/web/src/services/collabTransport.ts, minimal): postEntry's
non-ack HTTP branch now arms scheduleQueueRetry() — an in-order
flushQueue re-drive with bounded backoff (1s doubling, 10s cap,
mirroring the reconnect backoff), reset on ack/hello/drop/disconnect.
Regression test: collabTransport.test.ts "an HTTP-refused op (429)
retries with backoff and lands without a reconnect (D6)" — FAILS
pre-fix (verified by reverting the scheduling call), 64/64 pass with
the fix. Browser proof: tour-d6b re-run post-fix (below).
Also observed (NOT fixed, per scope ruling — filed here): during the
outage the grid shows the pending cells as empty; the typed input is
retained only in the queue + pending count, not painted as an
optimistic value. And the earlier local 409-on-open degradation was a
tour artifact (single-session local engine still owning the previous
run's session), not a product path.

### D6 tour-d6b POST-FIX results (fresh stack, fixed dist)
- Leg 1 throttled (~300 ms RTT): A1=uuu painted 234 ms after commit,
  B2=vvv 48 ms; A1 intact after. (Pre-fix plain-path reference:
  311 ms / 48 ms.)
- Leg 2 outage: refused /ops submissions re-driven by the retry timer;
  queue held both ops (len 2, seq 4) and SURVIVED the mid-outage
  reload (len 2). (Two post-fix tour executions landed with the same
  verdict; figures here are the on-disk results-d6b.json run.)
- Heal: C1=keepme1 painted 998 ms after submissions healed, D3=
  keepme2 124 ms later in the same flush; queue drained to 0.
- Second client joining the session reads C1=keepme1, D3=keepme2,
  A1=uuu — the queued edits LANDED server-side. D6 CLOSED.
Shots: d6b-1..d6b-5 in shots/.

## D8 presence — ROOT CAUSE + FIX (2026-10-22 PM)
Two compounding identity-form defects, both proven in code:
1. **Self-marker**: the JWT `sub` is the BARE user id
   (packages/service/src/auth.ts issueToken: `sub: userId`), while the
   server principal is `user:<id>` (principalFromToken). The client's
   `GatewayClient.principal` returned the bare sub, so EVERY comparison
   against engine participants (`user:<uid>`) failed: App's grid filter
   `p.principal !== gwClient?.principal` never matched self, and the
   echoed self-flag (one round trip stale) rendered on the previous
   cell — the user's "flag on C3 while I'm on C4". FIX:
   GatewayClient.principal returns the canonical `user:<sub>` form
   (no double-prefix). +2 gatewayClient tests (23/23).
2. **Name leak**: Grid's flag tag rendered
   `p.principal.replace(/^user:/,'')` — the raw principal as the label,
   ignoring p.name; the header avatar used `participantInitials(p.name
   ?? p.principal)` → "2G" initials from the UID. (The engine never
   invents a name — it stores only a client-posted one; the user's
   client posted none because D1 left sessionProfile unseeded, which
   D1's fix cures. The renderers must still never fall back to the id.)
   FIXES: CollabTransport filters SELF out of presence events at the
   single ingestion point (all consumers covered); new
   `participantDisplayName(p)` (payload name, with a name equal to the
   principal/bare id treated as no name → neutral 'Guest'); Grid flag
   tag + App avatar title/initials use it; Grid's remoteSelections
   type carries `name`. effectiveDisplayName's last fallback is now
   the email NAME PART (local part) per the ruling (userSettings test
   updated). +3 collabTransport tests (66/66), userSettings 7/7.
   Two-client tour acceptance still owed (below).

## D9 file id in header — FIXED (code)
The `.collab-file-id` chip rendered `🔗 {collabFileId}` (raw id). It
now shows the file's NAME, resolved by an App effect from the owner's
catalog (productApi.listFiles by collabFileId); a joiner who doesn't
own the file gets the neutral 'Shared file' label — the raw id never
renders. Browser confirmation rides the presence/chat tour.

## D7 mobile Workspace crowding — FIXED (CSS, product.css ≤720px)
Diagnosis: header flex row (brand: wordmark+tier pill; actions:
help/gear/account) exceeds ~390px with nowhere to go → actions
overlapped the tier pill; the file-name cell's 260px floor + nowrap
'Created' meta + 52px menu cell exceed the viewport → the name
wrapped into/clipped against 'Created'. Fix (media query only):
header flex-wrap + actions flex:none; name cell min-width 0, link
ellipsizes (flex 1 1 auto, nowrap, ellipsis), tags flex:none.
Before evidence: shots/d7-workspace-mobile-before.png (user symptom
reproduced locally). After screenshot owed in the combined tour.

## D1 acceptance addendum — upload-grant 401 (selection tours linkage)
The selection worker's Tour B5 upload path 401'd after a 200 dev
login. Root cause = the D1 coherence regression I introduced and
already fixed in this batch: their stack was built from the
intermediate tree (401-re-exchange wired WITHOUT the dev-posture
gate), so the by-design proxied session-extras 401 triggered a
re-exchange that CLEARED the healthy dev-login token → upload-grant
(and everything after) went out anonymous. Their "token in the
secure-vault store" reading was the sharing access table
(icecream-sheets.access.v1), not the JWT. On the CURRENT tree the
gate + logging-in guard are in; API-level proof on this stack:
POST /api/files/upload-grant with a dev-login token → 200 + grant.
Still owed as closing proof: (a) the browser upload leg in the
combined tour (sign in → upload a file → file listed, no 401s);
(b) the selection worker's rerun/run-case.sh B5 five cases in upload
mode against the fixed tree.

## Issue tracker (GitHub, is-cream/icecream-sheets)
D1 = #1 · D2 = #2 · D3 = #3 · D4 = #4 · D5 = #5 · D6 = #6 · D7 = #7 ·
D8 = #8 · D9 = #9 · upload-grant coherence = #10. Closures happen
only on parent verification; this report says "ready to close #N"
per defect when its evidence is complete.

## FINAL CONSOLIDATION (2026-10-22 PM) — verdicts per issue

### #1 (D1) session restore + AUTH COHERENCE — ready to close
Root cause: restoreSession read getCurrentUser() synchronously; the
SDK restores async → permanent split state (signed-out UI over a
working stored JWT). Fix: await the first onAuthStateChanged emission
(5s timeout fallback); coherence enforced both directions — boot
restore resolves Firebase first, then ensures a valid gateway token
(exactly one exchange), and clears a stored token when there is no
Firebase session (orphan clear, dev-posture-gated); a gateway 401 with
a live Firebase session triggers ONE silent re-exchange + retry
(GatewayClient.withReauth); with a dead session both halves converge
to signed-out together; sign-out still clears both. My own regression
during this work (ungated reauth clearing healthy dev-login tokens on
the by-design proxied session-extras 401) was caught on the local
stack and fixed (dev-posture gate + restore-in-flight guard) — and is
independently confirmed fixed by the selection B5 re-run below, whose
harness stack had been built mid-batch from the intermediate tree.
Evidence: firebaseAuth 39 tests, gatewayClient 23 tests (incl. both
split directions, single-flight, retry-carries-new-token, gatewayBody
past the 200-char cap); local tours show no non-extras 401s after
login. The live-Firebase fresh-load proof (Workspace AND grid headers)
remains the parent's post-deploy leg — the local stack cannot run
real Firebase; that leg is the acceptance residue for #1, stated
plainly.

### #2 (D2) chat composer — ready to close
No structural defect: the composer renders whenever the panel is
open (tab 'chat'). The user's "nowhere to type" was the overlay
panel + theming collapse (#3/#5). Browser-proven on the local
production-topology stack: composer visible in the docked panel,
message sent, agent reply rendered ("A1: (empty)") in both themes.
Shots: d5-chat-docked-light.png, d3-chat-dark.png.

### #3 (D3) chat theming — ready to close
Two conflicting dark :root blocks (the later slate palette won by
source order; the earlier block deleted), --bg-soft consumed but
undefined (now defined both themes), notice tokens added, all chat
sub-elements (chips, pending ask, artifact placeholder, audit,
composer input + Send) tokenized. Dark browser proof: data-theme=
'dark', agent bubble rgb(39,53,73) on panel rgb(15,23,42), input
rgb(30,41,59) with rgb(226,232,240) text — shot d3-chat-dark.png,
self-inspected.

### #4 (D4) settings email — ready to close
Loss point: no settings record → gateway 404 SETTINGS_NOT_FOUND
whose body carried no identity → default view email null → blank.
Fix: the 404 body now echoes the caller's verified-claims identity
(user:{email, googleName}); productApi fills the default view from
it on the 404 path. Contract (404 + code) unchanged. Evidence:
gateway userSettings 15/15, productApi 21/21, and the browser proof
— minted gateway JWT (attrs email ada@example.com), Settings shows
the address with disabled=true + readOnly=true, no error banner
(shot d4-settings-email.png).

### #5 (D5) agent panel docks — ready to close (one local limit)
Panel is a flex sibling of the grid column (grid 1440→1100 at the
340px default in the tour; overlap 0), divider draggable (drag to
536px) + keyboard-operable (role=separator; 2x ArrowLeft = +32px),
width persisted (localStorage icecream.agentPanelWidth=536 after
drag). Artifact panel docks beside the chat in code; its browser
geometry could NOT be proven locally — the local agent service
answers app-generation with an honest 503 (no GCP project configured
on the local service), recorded here as an environment limit, not a
pass. The mid-drag shot: d5-divider-mid-drag.png.

### #6 (D6) one-edit-behind — ready to close
Production root cause was the deployed engines'
containerConcurrency=1 (parent-fixed live, concurrency 80, pushed
8bec4d8c). Local branch-(2) confirmation: the uncapped local engine
does not reproduce the vanish; throttled (~300ms RTT) commit-to-paint
234ms/48ms. The in-scope client defect found + fixed: an HTTP-refused
op (429) was never re-driven while the delta stream stayed healthy
(flushQueue was hello-driven only) — the durable queue survived a
full reload but never landed after heal. Fix: bounded-backoff
in-order retry in CollabTransport; regression test verified to fail
with the fix reverted; suite 66/66. Tour tour-d6b: queue survived a
mid-outage reload, both refused edits landed after heal (998ms /
+124ms), second client read them back. Filed-not-fixed observation
(user scope ruling): during an outage the grid paints pending cells
empty (input retained in the durable queue + pending count only).

### #7 (D7) mobile Workspace crowding — ready to close
CSS only (product.css, <=720px): header wraps (tier/gear overlap
0px measured; header height 92.9 with actions on their own row);
file table fixed layout (name column absorbs the squeeze and
ellipsizes; Modified 118px / Size 56px / menu 52px; origin tag
hidden at this width) — document scrollWidth == viewport 390 (was
472, table 507). Before/after: d7-workspace-mobile-before.png,
d7-workspace-mobile-after.png (self-inspected: 'Untitled…' +
'16 minutes…' + '0 B', no collisions).

### #8 (D8) presence — ready to close (one residual filed)
Root causes, all proven in code: (1) JWT sub is the BARE user id
while the server principal is user:<id>; GatewayClient.principal
returned the bare sub, so every self-comparison failed and the
stale self-echo rendered. Fixed at the source (canonical
user:<sub>) + CollabTransport filters self at the single presence
ingestion point. (2) Grid's flag tag rendered the raw principal;
avatars initialed it. participantDisplayName (name from the
presence payload; a name equal to the principal/bare id is no
name → 'Guest') now drives the flag tag + avatar title/initials;
effectiveDisplayName's last fallback is the email name part.
(3) REAL render offset: the flag used `top: rowTop(row) - CHH`,
double-compensating — every flag painted exactly one row high
(the user's C3-vs-C4). Fixed; alignment now pixel-exact.
Two-client acceptance (fresh stack, named users): Alice sees
Bob's flag labeled 'Bob B' at {332,391} == D7 cell {332,391};
Bob sees Alice's 'Alice A' == C5 exactly; Bob moves to E9 → flag
follows to {428,439} == E9 exactly; NO self flag/avatar on either
side; avatars 'BB'/'AA' with name titles. Shots: d8-alice-view.png,
d8-bob-view.png, d8-alice-view-moved.png. Catalogued files open
owner-only by product contract (gateway code-documented), so the
two-client session used a non-catalogued file id (Phase-2 join
semantics); same-session join of a catalogued file by a non-owner
is the share-copy flow's territory, not this defect.
RESIDUAL (filed, not fixed): the StatusBar collaborators roster
(bridge CollabSession.collaborators()) still lists participants by
principal text and includes self by design — a different UI element
from the presence markers the rulings targeted; name-threading it
belongs with the bridge's participant model. Parent to rule whether
it joins #8's scope.

### #9 (D9) raw file id in grid header — ready to close
Chip now shows the file NAME (owner: resolved from the catalog,
e.g. '🔗 Untitled spreadsheet' — browser-proven; joiner: neutral
'Shared file'). The raw id never renders. Also independently
re-confirmed by the e2e visual sweep (parent record).

### #10 upload-grant 401 — ready to close
Mechanism: the mid-batch intermediate tree (re-exchange wired
without the dev-posture gate) let the by-design proxied
session-extras 401 clear healthy dev-login tokens; the selection
worker's "vault store" reading was the sharing access table.
Proof on the fixed tree, three ways: (a) API: POST
/api/files/upload-grant → 200 + grant with a dev-login token;
(b) my stack browser leg: sign in → upload probe.csv → grant 200,
zero non-extras 401s, file listed, token still present after;
(c) SELECTION B5 RE-RUN (the owed closing proof): their
rerun/run-case.sh, all five cases in upload mode — B5.row-above,
B5.row-below, B5.col-left, B5.col-right, B5.multi — ALL PASS
(records: selection-model/validation/rerun/tour-b-B5.*.log).
Two harness adaptations I made and disclose: their dist-gw-src was
rebuilt from the current tree (their copy was built mid-batch at
13:57 PDT from the intermediate tree; backup kept at
~/workspace/tmp-hosted-ux/dist-gw-src-backup), and tour-b.mjs's
upload session now CLICKS the uploaded file's row (the current
product contract is upload-adds-to-list; +New opens, Upload does
not auto-open) — annotated in the file. Cross-reference: the
FILE-2 worker's "uploading clears the token" observation and the
e2e sweep's F-3 (failed local-file open → 401 storm) are the same
family by trigger surface; on the current tree the upload path
itself is proven clean above — F-3's local-open trigger is a
distinct path, recorded in the sweep's report for the parent.

### Incidents inside this batch (disclosed)
- My D9 effect's deps array referenced productApi above its
  declaration → TDZ blank-page in production builds (unit tests
  green; caught by the local stack tour, root-caused via sourcemap
  to App.tsx:1386). Fixed by relocating the effect below the
  declaration. Lesson recorded: every batch change now gets a
  production-build boot probe (probe9) before tours.
- Grid.tsx briefly imported the transport module for the name
  helper; the helpers moved to a dependency-free leaf
  (services/presenceNames.ts, re-exported from collabTransport)
  and Grid keeps a local mirror of the 3-line label rule to stay
  out of the services module graph.

### Suites (final, current tree)
- apps/web vitest: 150 files, 1964/1964 PASSED (exit 0).
- packages/gateway vitest: 462/463 — the one failure is
  tests/services.test.ts > agent service > human-in-the-loop over
  HTTP (/pending -> /answer), expecting 1 pending ask and finding
  28 (in-file ask accumulation; reproduced in isolation, three
  runs). It is OUTSIDE this batch's diff — my only gateway source
  change is the settings-404 identity echo (userSettings 15/15) —
  and is recorded here for the parent to route, not fixed in this
  batch.
- tsc: apps/web clean (via build:local-stack, exit 0);
  packages/gateway tsc --noEmit exit 0.
