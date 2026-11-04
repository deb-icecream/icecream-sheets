# Live UX Batch — owner-reported defects (2026-10-22 evening PDT)

Worker record. Checkpoint-first; appended after each landed piece.

## Setup
- **Ports claimed: 9120–9129** (this program only; disjoint from prior blocks).
- TMPDIR: ~/workspace/tmp-liveux
- Validation: local production-topology stack, gateway-mode dist via `npm run build:local-stack` + `scripts/verify-dist.mjs`.
- Priority: #36 (P0) → #37 (P0) → #32 (P1) → #31, #33, #34, #35 (P2).
- Shots dir: hidden_files/live-ux-batch/shots/

## Status log
- (start) Record created; ports 9120–9129 claimed. Beginning #36 reproduction + code diagnosis.
- #37 code pass 1: refresh = `refreshAddons` in apps/web/src/ribbonParity.tsx — fan-out of 3 parallel GatewayClient calls (GET /api/addons/catalog, /installed, /grants), re-fired whenever `addonBackend` identity changes (useMemo deps include render-time `gatewayToken = getGatewayClient()?.getToken()`) and after every add-on mutation. Client throws `GatewayRateLimitError('rate limited (429)')` → status bar "Add-on refresh failed: rate limited (429)". Gateway side: ONE per-principal token bucket (600 pts / 60 s default, bin/gateway.ts; gateway.ts:837 takes on EVERY authenticated /api request) — the addons service itself has no limiter; engine session limiter (5000/60 per session) is not on this path. Open: what exhausts 600/min for one owner — to be settled empirically on the stack (gateway audit-log request counts per route during the owner's exact flows) + checking deploy yaml for a RATE_LIMIT override.
- #38 added by parent (theme changes on its own after open→edit→refresh); priority after #32, ahead of P2 items.

## #36 — BLOCKER: typed content not saved (new file → type ABC → refresh → empty)
- **Reproduction (local stack, gateway mode, prod-default limits):**
  - Plain flow (create → type ABC → wait 6 s → refresh): **PASSES** — engine log shows autosave-settle checkpoint rev=1, page-unload release checkpoint, rehydrate with matching checksum; A1="ABC" after refresh (shots 36-before-3/5).
  - **Churn flow: REPRODUCED (shots/36-churn-after-reopen.png — blank grid, status even shows "✓ Saved").** Kill engine, wipe ONLY engine-owned stores (snapshots, engine session registry, library), keep gateway catalog + file registry (the hosted split: catalog/tiers are Firestore-backed, engine stores are not), restart engine, reopen same ?file= URL → sheet EMPTY, content unrecoverable.
- **Root cause (in code + config):**
  1. A created (never-uploaded) file's bytes live ONLY in the engine instance's local session stores (snapshot + journal + `autosave_<sessionId>` library entry, all under ICECREAM_DATA_DIR). Production engine yaml sets ICECREAM_DATA_DIR=/tmp/icecream-data (tmpfs, per-instance, ephemeral) and SESSION_STORE is never set anywhere in deploy/ → local stores. Uploaded files are immune (bytes in GCS behind storageRef); created files have storageRef=null.
  2. Checkpoints never maintain a FILE-keyed stored copy: `state.boundLibraryId` is set only by an explicit id-carrying /library-save or /session-bind-library, and nothing in the create/open/edit flow ever calls them (the only catalog→library link in the codebase is the share-import flow, App.tsx:7680). Verified in the tour's own data: library/index.json contains ONLY `autosave_sess_<id>`; catalog record has libraryEntryId=null, hasStoredState=false after edits + checkpoints.
  3. `/session/claim` recovery is snapshot-or-blank: snapExists gate → rehydrateSession (which hard-requires a snapshot), else registerSession mints a BLANK pending session; the gateway CAS-claims the registry to it and the client (no storageRef) has nothing to load. Any engine instance loss between edit and reopen (Cloud Run churn: minScale 0, gen2, tmpfs; the deploy itself replaced engine revisions the same evening) silently opens an empty sheet.
- **Fix (engine, packages/gateway/src/services/engineSvc.ts):**
  1. Every committed checkpoint of a file-bound session ALSO commits the verified bytes under the fileId library entry (file-keyed stored copy), in addition to `autosave_<sessionId>` and any bound entry.
  2. `/session/claim`: when no snapshot exists for the candidate session, BEFORE minting a blank session, recover from the file-keyed library entry (or `autosave_<candidate>`): read the entry bytes (principal must own the entry), build the workbook, finalize state exactly like a rehydrate at revision 0 (storage caught up — the library holds these bytes), bind future checkpoints to the fileId entry, respond `rehydrated: true, recoveredFromLibrary: true`.
- **Residual (deploy config, parent/user action — cannot be validated from here):** on hosted, the library shares the same tmpfs as the session stores, so TOTAL instance loss still destroys every copy. The durable fix is enabling the already-built prod stores: SESSION_STORE=prod (Firestore + GCS snapshots) on the engines and FILE_REGISTRY_STORE=prod on the gateway (sessionStore.ts/fileRegistry.ts, fail-closed when half-configured). With those on, snapshot rehydrate alone survives instance loss; the code fix above additionally covers snapshot-store loss/corruption and process-level churn in every topology.
- **Validation (fixed build, fresh stack 'fix1'):**
  - Plain flow: PASS — A1="ABC" after refresh (tour36 'after').
  - Churn flow: **PASS after fix** — engine killed, session stores wiped (library kept), lease lapsed, reopen → engine log `session recovered from library entry=file-c574cbb3-… checksum=931f75111f2b1917926f26a7e022e971e9bec6d3be1614c9f3e8ebe85133b1ff` — the checksum EXACTLY equals the original session's last checkpoint checksum; A1="ABC", status ✓ Saved (truthful now). (Note: a reopen attempted while the 30 s registry lease is still live joins the dead session and shows Offline until the lease lapses — the claim path engages after expiry; that lease window is #27's territory, not #36's.)
  - Existing-file variant: PASS — upload simple.xlsx → B2 10 → edit 42 → refresh → 42 (tour36c).
  - Library evidence: after the fixed build's first checkpoint, library/index.json holds BOTH `autosave_sess_<id>` AND the `file-<uuid>` entry (3020 B each).
  - Tests: gateway tsc clean; related suites rehydrateScope 2/2, phase2Collab 15/15, deployAccess 22/22 (one combined-run flake, clean on re-run and individually). Web tsc clean via build:local-stack + verify-dist OK.

## #37 — Status bar "add on refresh failed" in red (error carries HTTP 429)
- **Refresh call pattern (code):** `refreshAddons` (apps/web/src/ribbonParity.tsx) fans out 3 parallel GETs — /api/addons/catalog, /installed, /grants — fired on mount, whenever `addonBackend` identity changes, and after every add-on mutation.
- **Limiter config (code + deploy):** the gateway takes 1 point per authenticated /api request from ONE per-principal token bucket (gateway.ts:837), 600 points / 60 s (bin/gateway.ts default; deploy/ sets no override). Keying is per-principal (not per-IP), so all of a user's tabs/flows share it. The addons service itself has no limiter; the engine session limiter (5000/60) is not on this path. 600/min is generous for legitimate use — the limiter is NOT the defect.
- **Root cause (client, measured):** the W4 built-app sync effect in App.tsx (~:4778) leaks requests. Its dedupe key is freed by effect cleanup whenever a run hasn't completed; `sheetNames` is a fresh array every render so the effect re-runs constantly; while a listApps GET is in flight, the next render frees the key and fires ANOTHER GET. Measured on the local stack from the gateway audit log: **107 GET /api/built-apps in a ~110 s window** (signin → idle 30 s → one edit → idle 30 s) ≈ 1/s sustained at localhost latency; at production RTT the in-flight window is longer and the rate higher, and every tab multiplies it (same per-principal bucket). The bucket drains; the add-on refresh's 3 calls then 429 (client throws `GatewayRateLimitError('rate limited (429)')`) and the raw error is written straight into the red status slot, re-firing on later renders — a persistent red error caused by a background sync leak, not by add-ons.
- **Fix:**
  1. App.tsx built-app sync: an in-flight ref guards the run — the key is consumed only when a run COMPLETES; cleanup no longer frees it; a failed run retries at most once per settle with a 5 s per-key backoff. Request rate collapses to one listApps per (file, sheet-set) change.
  2. ribbonParity.tsx refreshAddons: in-flight dedupe (one fan-out at a time) + on GatewayRateLimitError, bounded retries honoring Retry-After (1–10 s backoff, 3 retries) before surfacing anything; a still-failing 429 surfaces ONCE in plain language ("too many requests — please try again in a moment"), never the raw "rate limited (429)". Other errors keep the existing message.
- **Validation (fixed build, same tour shape as the measurement):** GET /api/built-apps **107 → 2** calls for the whole tour; addons exactly 2 bounded sets; ZERO 429s in the gateway log; status bar clean (no red) through sign-in → create → idle → edit → idle. Web tsc clean (build:local-stack + verify-dist OK). Related tests: ribbonParity + builtAppsApi + AddonManagerDialog + AppsGallery 23/23 PASS.
- Reasoning on the residual copy: with the leak fixed, a 429 needs genuine over-use (many tabs/flow bursts against one principal) — a transient condition the client now rides out with Retry-After retries; the surfaced message names the situation in plain words and asks for a moment, proportionate to a self-healing state.

## #38 — Theme changes on its own after open → edit → refresh
- Root cause: TBD (suspects: per-view theme sources; async gateway settings fetch landing after first paint; failed settings fetch on refresh → default fallback)
- Fix: TBD
- Validation: TBD

## #39 — Agent panel opens ON TOP of the spreadsheet instead of docking
- Root cause: TBD (check every agent-surface entry point: chat panel, artifact/app panel, voice flows, menus; viewport media queries collapsing the flex row)
- Fix: TBD
- Validation: TBD (geometry probes: grid width shrinks by panel width, overlap = 0, every entry point; close restores)

## #32 — Agent panel does not work for owner live (test through UX, not API)
- Root cause: TBD
- Fix: TBD
- Validation: TBD

## #31 — Brand/logo click → home (signed in → Workspace; signed out → landing)
- Root cause: TBD
- Fix: TBD
- Validation: TBD

## #33 — Agent panel header buttons too small + panel polish
- Root cause: TBD
- Fix: TBD
- Validation: TBD

## #34 — Panel divider: no drag affordance
- Root cause: TBD
- Fix: TBD
- Validation: TBD

## #35 — Voice bubble overlaps open agent panel
- Root cause: TBD
- Fix: TBD
- Validation: TBD

## Residuals
- TBD

## #38 — theme inconsistency (recon notes, fix pending #32 completion)
- TWO theme engines write <html data-theme>:
  (a) apps/web/src/product/userSettings.ts — SERVER record (GET/PUT /api/settings;
      nothing in localStorage by design); applyThemeChoice() always SETS
      dataset.theme to the RESOLVED 'light'|'dark'. Boot: main.tsx initTheme()
      applies 'system' until the record arrives.
  (b) apps/web/src/settings.ts — the spreadsheet's OWN profile in localStorage
      'icecream.settings.v1', DEFAULT theme 'light'; applyTheme() DELETES the
      data-theme attribute for light/system-light, sets it only for dark.
- App.tsx (spreadsheet view) calls settings.ts applyTheme(settings.theme) at
  :1889 (mount) and :6197 (dialog change) — from the LOCAL profile, which is
  only ever written by the spreadsheet's SettingsDialog, NEVER synced with
  the server record the product SettingsPage writes (productApi office.theme).
- Consequence: the winner depends on mount/fetch ordering, which differs
  between first-open (shell fetch lands after App mount -> server choice
  re-paints last -> correct) and refresh-straight-into-sheet (local profile
  or 'system' boot default wins if the settings fetch is late/401/404 ->
  theme "changes on its own"). A failed settings fetch (401 in the #1
  coherence window, or 404) leaves the boot 'system' in place permanently.
- Fix direction: ONE writer — the spreadsheet consumes the session theme
  (userSettings) in gateway mode; settings.ts applyTheme stops owning
  data-theme there. Details + validation after #32.

## #32 — agent panel "does not work" for the owner (P1) — VALIDATED locally; reporting defect FIXED; one hosted-only leg named
### Enablement path (code)
Panel (AgentChat.tsx) -> remoteAgent -> gateway /api/agent/* -> combined service
(packages/gateway agentSvc) -> resolveBackend: per-user config wins; the shipped
default config provider 'heuristic' resolves via selectBackend() to
createVertexDefaultBackend() whenever GCP_PROJECT_ID is set (Vertex OpenAI-compat
endpoint, locations/global, model google/gemini-3.1-flash-lite, token minted per
call by createGcpAccessTokenProvider: SA key file locally, metadata server on
Cloud Run). NO tier gate on agent routes (grep-verified). Turn errors ARE
surfaced in the panel ("Something went wrong: ...", AgentChat.tsx:390).
### Hosted wiring verified from this VM
- deploy/services/service.yaml: SERVICE_BIN=service (same combined bin),
  GCP_PROJECT_ID set. IAM read via deployer: icecream-service@ HAS
  roles/aiplatform.user. Metadata token provider code: standard shape
  (Metadata-Flavor header, 2s timeout, soft-null).
### UX validation (local stack, hosted-equivalent agent env)
Agent restarted with GCP_PROJECT_ID=dreamscapes-zero + deployer ADC key file
(the token provider's documented local path) = same code path, endpoint and
model as hosted, DEFAULT user config. scripts/tour32.mjs through the real UI,
W3a Sales fixture (total 159,400), case-02 standard prompts verbatim:
- "What is the total revenue in the Sales sheet?" -> "The total revenue in the
  Sales sheet is 159,400." (~8s) — CORRECT. Shot: 32-prompt1-reply.png.
- "Set the Revenue for Jun South to 15000 in the Sales sheet." -> reply
  "Updated the Revenue for Jun South to 15000..."; GRID C13 = 15000. Shot:
  32-prompt2-edit.png.
- "Add a TOTAL row directly below the data..." -> reply "...totaling 160,200";
  GRID row 14 = TOTAL / 160200. Shot: 32-prompt3-totalrow.png.
All /api/agent/* 200. => The functional path (panel, gateway, agentSvc,
Vertex default, tools, session) WORKS end to end through the UX.
### Defect found + fixed: the settings dialog misreports the default backend
AgentSettingsDialog.tsx:28 labeled the default "Built-in (default)" with hint
"The shipped deterministic planner — no key needed." — stale since the Vertex
default landed (agentSvc.ts:364: the 'heuristic' config value MEANS "the
product's default model"). GET /api/agent/config returned only the stored
choice, so a user opening the gear dialog sees "deterministic planner, no key"
and reasonably concludes AI is not enabled — matching the owner's report
verbatim in substance. Fix: GET /config now also reports the effective default
backend; the dialog labels it truthfully (details below after implementation).
### Residual — the exact remaining live check (hosted-only)
Two legs cannot be exercised from this VM: (1) metadata-server token minting
inside Cloud Run (code inspected, standard; a null token makes the planner
throw "agent planner: no GCP access token available from the service
identity" — that exact string in a panel error or service log confirms or
clears this leg); (2) the owner's session state during his attempt — he was
simultaneously inside the #27 409 wedge / #36 / #37-429 storm, any of which
fails agent turns with session errors. LIVE CHECK (owner or parent, ~1 min):
hosted app, signed in, a sheet that opens cleanly, panel, send "What is the
total revenue in the Sales sheet?" on a Sales sheet; if it errors, the panel
error text + the gear dialog's backend line distinguish token vs session vs
config in one screenshot.
### #32 fix landed + validated
- packages/gateway/src/services/agentSvc.ts: new describeConfig() — GET and
  POST /api/agent/config now include defaultBackend ('vertex'|'heuristic')
  and defaultModel ('google/gemini-3.1-flash-lite') when the stored choice
  is the default and a Vertex default backend is configured.
- apps/web/src/services/remoteAgent.ts: AgentModelConfigView gains the two
  optional fields.
- apps/web/src/components/AgentSettingsDialog.tsx: the default option is
  labeled from the effective backend — vertex: "Default model (Vertex AI)" /
  "Gemini on Vertex AI (google/gemini-3.1-flash-lite) — served by the app,
  ready to use, no setup needed."; no-GCP local: the original "Built-in
  (default)" / deterministic-planner copy (accurate there).
- Validation: gateway tsc clean; tests — gateway agentBinding+agentTranscribe
  32/32, service agent-modelconfig 33/33, web remoteAgent 8/8. UX re-check on
  the rebuilt dist (tour32b.mjs): gear dialog shows the Vertex line verbatim
  (shot 32-config-dialog-vertex.png); the prompt set had already passed on
  the identical backend path (tour32).
STATUS: #36 DONE, #37 DONE, #32 DONE (modulo the named hosted-only live
check). Next: #38, #39, then #31/#34/#35/#42/#41 (revised priority order).

## #38 — theme changes on its own after refresh — FIXED + VALIDATED
### Root cause (three in-code defects, one visible symptom)
1. TWO writers of <html data-theme> with different semantics: the product
   engine (product/userSettings.ts applyThemeChoice — always SETS the
   resolved value, tracks the choice in module state the canvas reads)
   vs the spreadsheet's settings.ts applyTheme (localStorage profile,
   default 'light', DELETED the attribute for light). The DOM and the
   module state could disagree — half the app in one theme, half in the
   other.
2. The shell's one-shot settings fetch LATCHED BEFORE SUCCESS
   (settingsLoadedForRef set before the await) with a silent catch: one
   failed GET /api/settings on refresh (401 inside the sign-in restore
   window, transient 503) kept the boot/local theme for the WHOLE session
   — the owner's flip.
3. The two stores diverged by design: SettingsPage writes the SERVER
   record; the spreadsheet SettingsDialog wrote only the LOCAL profile —
   a theme set in either surface was invisible to the other and the next
   fetch/mount resurrected the stale one.
### Fix
- settings.ts: applyTheme() delegates to applyThemeChoice() — ONE painter,
  one semantics. New storedProfileTheme() helper.
- main.tsx: boot paints the stored profile's theme (the last-known
  authoritative choice, mirrored) before first paint; 'system' default
  only on a first-ever run — no wrong-theme flash on refresh.
- App.tsx shell effect: latch set ONLY on success; one bounded retry
  (2s) on failure; on success the choice is mirrored into the local
  profile AND the spreadsheet's settings state.
- App.tsx handleSettingsSave: in gateway mode a dialog theme change is
  written through to the server record (productApi.updateSettings) and
  the session view updated.
- SettingsPage handleTheme: mirrors the saved choice into the local
  profile; account deletion resets the mirror to 'system'.
### Validation (tour38/tour38b/tour38d, rebuilt dist, this stack)
- SettingsPage -> Dark: data-theme=dark, body bg rgb(15,23,42), mirror
  'dark'. Open sheet, type, REFRESH: data-theme stays dark, bg dark,
  A1 content present (shot 38-file-menu.png shows the fully dark sheet).
- In-sheet Settings dialog -> Light: data-theme='light' immediately,
  mirror 'light'; REFRESH: still light, bg rgb(244,246,248) (shot
  38-sheet-light-after-refresh.png).
- SettingsPage afterwards: Light radio checked, "Currently showing:
  Light." — proves the dialog change reached the SERVER record.
- Tests: web tsc clean; settings + userSettings + SettingsPage suites
  19/19. #3 chat theming untouched (tokens unchanged; panel shots in #32
  run show correct theming).

## #39 — agent panel opens ON TOP of the spreadsheet — INVESTIGATED; phone-width defect FIXED + all entry points PROVEN docked
### What the code actually does (every entry point)
- Chat panel (.agent-chat): flex child (order 2) of .app-body-row beside
  .app-main-col (D5). Rendered from exactly two setAgentOpen(true) sites:
  the FAB and the share-restore flow — same component, same dock.
- Artifact/app panel (.agent-artifact): flex order 1, docked by default;
  `agent-artifact-expanded` (position:fixed) exists ONLY as the explicit
  user toggle labeled "Fullscreen"/"Side-by-side" in its header.
- No media query converts the panel to fixed/absolute at any width
  (index.css has exactly two @media blocks; neither touches the panel).
  Hosting cache headers are correct (index.html no-cache/must-revalidate;
  only hashed assets immutable) — a stale pre-D5 bundle is not supported
  by the config, though it cannot be excluded for the owner's device.
### Measured (tour39/tour39b, geometry probes)
- 1440px: closed main=1440 -> open main=1100, panel=340, overlap=0;
  close restores 1440. (#5's proof re-confirmed, not regressed.)
- Artifact leg (tour39c, agent app-gen through the UX): grid | artifact |
  chat in three columns, app rendering live data ("Revenue by Region",
  North $89,100.00 / South $71,100.00 = the edited sheet's 160,200);
  Fullscreen toggle applies the expanded class, Side-by-side removes it.
  Shot: 39-artifact-docked.png. (First local geometry proof of this
  panel — the #5 residual is now closed.)
### The real defect (phone widths) — FIXED
At 390px the panel's own sizing math let it swallow the sheet:
clampAgentPanelWidth's max was max(280, 60vw)=280, but the DEFAULT width
returned 340 UNCLAMPED (and any stored width was re-clamped only on
drag), so the grid was crushed to a 50px sliver (shot
39-panel-vp390.png) — visually indistinguishable from the panel covering
the sheet, matching the owner's report from his phone.
Fix (components/AgentChat.tsx): agentPanelMax() = max(200, min(60vw,
vw-150)) — the cap always reserves a visible grid strip; the 340 default
goes through clampAgentPanelWidth; the painted width is render-clamped
(rotating/resizing can never leave an oversized panel); aria min/max/
now report the effective values.
After: 390px -> panel 234, grid 156, overlap 0 (shot
39-panel-vp390-fixed.png); desktop values unchanged (340/1100).
### Residual
If the owner still sees a literal full-width-grid-under-panel after the
next deploy, the remaining suspect is his device's cached pre-D5 bundle;
the live check is the same geometry on his device post-deploy (panel
opens -> grid visibly narrows). No code path in the current tree renders
the chat panel as an overlay.

## #34 — panel divider has no affordance — FIXED + VALIDATED
- index.css .agent-resize-handle: hit area widened 7->9px; an ALWAYS-
  VISIBLE centered grip pill (::after, 4x44px, muted at 45% opacity)
  marks the divider as draggable at rest; hover/focus-visible/dragging
  (body.agent-resizing) brighten the grip to the accent and keep the
  accent-soft track + inset accent line; cursor stays ew-resize.
- AgentChat.tsx: handle gains title="Drag to resize the agent panel
  (arrow keys work too)".
- Validation (tour39b): resting grip visible (shot 34-divider-resting
  .png), hover accent state (shot 34-divider-hover.png), drag +95px
  (340->435, grid 1100->1005), keyboard ArrowRight -16px (435->419),
  close + reopen persists 419 via localStorage
  icecream.agentPanelWidth. Drag/keyboard/persistence all still work.

## #31 — brand/logo click must go home — FIXED + VALIDATED
### Root cause
No brand render was a link at all: the wordmark was a bare <span> in
LandingPage.tsx and Workspace.tsx, and a bare <strong> in the
spreadsheet header (App.tsx). Nothing to click, nowhere to go.
### Fix
- product/deepLink.ts: buildHomeUrl() — the app root with no deep link.
  The shell routes the root by auth state (signed in -> Workspace,
  signed out -> landing), so ONE href is correct everywhere, matching
  the app's real-anchor navigation model (file opens are ?file= links).
- LandingPage + Workspace wordmarks wrapped in
  <a class="ics-wordmark-link" href={buildHomeUrl()}> (product.css:
  inherits color, no underline; hover/focus underlines the wordmark).
  The Workspace header also serves the Settings page (rendered inside
  the Workspace shell), so Settings is covered by the same link.
- Spreadsheet header brand: an anchor to home in gateway mode (title
  "Back to your workspace"); local/desktop-offline mode keeps the
  static brand (no Workspace exists there).
### Validation (tour31.mjs, rebuilt dist)
- Signed out: landing brand click -> landing home (shot
  31-landing-brand.png).
- Workspace brand href = app root; Settings page brand click -> URL
  root + Workspace rendered (shot 31-settings-brand-to-workspace.png).
- Sheet view (?file=...) header brand click -> URL root, ?file= gone,
  Workspace rendered (shot 31-sheet-brand-to-workspace.png).
- Tests: deepLink + Workspace + LandingPage suites 44/44 after one
  drive-by fix: Workspace.test.tsx expected the pre-#16 upload copy
  ("Only .xlsx and .csv..."); the shipped copy includes .xls since the
  F-2 fix — assertion updated to the shipped string.

## #35 — voice bubble overlaps the open agent panel — FIXED + VALIDATED
### Root cause
.voice-fab is position:fixed at the viewport's bottom-right (right:16px)
with no knowledge of the docked panel, so with the panel open it painted
over the panel's composer (visible in the #32/#39 screenshots).
### Fix
- AgentChat publishes its RENDERED docked footprint (chat + artifact
  panel offsetWidths) as the --agent-dock-width CSS var on <html> from
  a layout effect that re-runs every render — including every divider
  drag frame — and removes the var on unmount.
- index.css: .voice-fab right: calc(16px + var(--agent-dock-width, 0px)).
### Validation (tour35.mjs, 1440px)
- Closed: FAB right edge at 1424 (viewport-16), var unset.
- Panel open (340): FAB right edge 1084 = panel left (1100) - 16; var
  "340px". Shot 35-bubble-open.png.
- Divider dragged +105 (panel 445): FAB tracked, gap still exactly 16;
  var "445px". Shot 35-bubble-dragged.png.
- Bubble clickable with panel open: opens the Voice commands palette
  (Pro gate for the default-tier local user — the designed surface).
  Shot 35-palette-from-bubble.png.
- Panel closed: FAB returns to 1424, var cleared.

## #42 — dictation final pass fails with "gateway 413" — FIXED + VALIDATED
### Root cause (measured, scripts/measure42.mjs)
The palette recorded with `new MediaRecorder(stream)` — no bitrate
hint. Measured in the harness browser: audio/webm Opus at ~121 kbps.
The transcribe body is base64 JSON through the gateway's 1 MiB cap:
10 s -> ~202 KiB, so the body crosses 1 MiB at ~51 s — while the
palette's own MAX_DICTATION_MS allows 60 s (~1.16 MiB). Any long
dictation (speech + thinking pauses; silence records at full bitrate)
was GUARANTEED to fail the final pass, and the raw gateway text was
interpolated straight into the user-facing error.
### Fix (client — the side that was wrong; server cap unchanged, justified below)
components/VoiceCommandPalette.tsx:
- Recorder created with audioBitsPerSecond: 32_000 (speech-grade for
  STT; try/catch fallback to a plain recorder). Full 60 s now ~290 KiB.
- MAX_DICTATION_BYTES = 600_000 ceiling checked on the poll tick: a
  browser ignoring the hint stops cleanly at ~800 KiB of base64 JSON
  and the final pass transcribes what exists, with a "done"-tone note
  ("Dictation reached its length limit and stopped — the transcript is
  in the box.").
- Final-pass error copy is plain language; a size rejection maps to
  "That recording was too long to send for a final check — ..." and no
  raw gateway text is ever interpolated.
### Why the 1 MiB gateway cap stays
Legitimate dictation payloads are now <= ~290 KiB at the maximum
allowed duration (3.6x headroom), and <= ~800 KiB in the worst
hint-ignoring case. The cap is not the defect; the unbounded payload
was. No server change.
### Validation
- Palette tests 8/8; web tsc clean.
- Live round trip (tour42.mjs, Pro-promoted local user, fake mic):
  palette -> record 6 s -> interim + final POST /api/agent/transcribe
  both 200; transcript landed in the box ("sum if" — the fake device's
  tone as heard by the real Vertex STT) and the matcher offered SUMIF;
  no error copy anywhere. Shots 42-palette-pro.png / 42-final-pass.png.

---

## #41 — Voice palette matcher: TODAY() for a fill + palette -> agent handoff + visible execution (FIXED + VALIDATED)

**Owner evidence:** verbatim utterance "Okay, uh, to one thing, fill uh, one
to 10. Can you do that?" (transcription correct; intent = fill 1-10) was
matched to TODAY() at 60%; he clicked Run, the UI claimed insertion at A1,
and A1 stayed visually empty.

### Reproduction (exact, pre-fix)
Scratch vitest against the pre-fix resolver: tokens were
`[okay, uh, to, 1, thing, fill, uh1, to, 10, can, you, do, that]` (note
`uh1` — the ref joiner had fused "uh"+"1") and the resolution was TODAY,
score 0.6 (the fuzzy floor), formula `=TODAY()` — the owner's bug
byte-for-byte. Also probed: `fill 1 to 10` -> null, `fill A1 to A10 with
1 to 10` -> null, `um fill the column...` -> SUM (wrong). There was NO
fill grammar in the palette at all (only recalc / write / read /
function-insert).

### Root cause
1. **No fill grammar:** a whole command family (fill a series) did not
   exist, so fill utterances fell through to the fuzzy function matcher.
2. **The fuzzy floor is too permissive for prose:** the alias "to day"
   plus the 0.6 floor let "to ... 1" reach TODAY. Filler stripping only
   handled a small leading set, so discourse ("okay uh ... can you do
   that") polluted every pass.
3. **Tokenizer glued fillers to digits:** the cell-ref joiner fused
   "uh 1" -> "uh1", corrupting the token stream further.
4. Separately (steer, design doc section 7): the palette had NO handoff —
   a non-match was a dead end instead of "ask the agent".

### Fix (apps/web/src/services/voiceCommands.ts, components, App)
- **Tokenizer:** NEVER_JOIN += uh/um/erm/okay/ok — fillers are never
  column letters; "uh 1" stays two tokens.
- **stripDiscourse():** a discourse layer under the function matcher —
  leading runs ("okay uh can you", the "one thing" bigram), trailing
  runs ("...can you do that"), and interior hesitations (uh/um/erm/
  okay/ok) are removed before function matching. It deliberately does
  NOT strip a leading "to" (the "to day" -> TODAY alias is load-bearing;
  regression-pinned).
- **resolveFillCommand():** a real fill grammar, tried after
  write/read and BEFORE the fuzzy function matcher. The verb may be
  preceded by up to five noise tokens (discourse + stray numbers).
  Forms: "fill 1 to 10" / "fill one to ten" / "fill A1 to A10 with 1 to
  10" / "fill 10 down to 1" / "fill the column with one through ten".
  With no range, the series fills DOWN from the target cell; with a
  range it fills the range's cells (column top->bottom, row
  left->right, block row-major; series longer than the range truncates,
  shorter fills from the start). One write_cells call, <=1000 cells.
  No numbers spoken -> a NON-executable "Fill series" resolution with
  guidance ('Say the numbers - e.g. "fill 1 to 10"...'), never a fuzzy
  function. Score 0.95 (0.9 for the guidance form).
- **Palette handoff (owner decision, design doc section 7):**
  VoiceCommandPalette gains `onAskAgent`. The no-match state and any
  match scoring below CONFIDENT_MATCH_SCORE (0.85) offer one obvious
  action, "Ask the agent instead". App wires it: palette closes, the
  panel opens (docked), and AgentChat's new `initialDraft` prop
  (seq-guarded, same pattern as initialArtifactRequest) seeds the
  composer with the utterance and focuses it — the user reviews and
  sends; nothing auto-sends. Confident one-shot matches still execute
  in the palette exactly as before. Also fixed the palette's stale
  "null in hosted gateway sessions" prop comment (the caller executes
  in both modes; the boundary note shows only when mcpCall is null).

### Validation
- Unit: voiceCommands suite incl. a new #41 regression block (owner
  utterance verbatim -> Fill series 0.95, write_cells A1:A10 values
  1..10; six fill variants; descending series exact values; no-numbers
  guidance form; discourse-only -> null; TODAY/SUMIF/SUM preserved).
  Palette suite incl. three new handoff tests (no-match offers + passes
  the words verbatim; weak match MAX 0.80 offers; confident SUM does
  not). voiceCommands + palette: 50/50. Web tsc clean.
- Live (tour41.mjs, Pro user, gateway mode): typed the owner's verbatim
  utterance -> preview "Fill series | match 95% | Fill Sheet1!A1:A10
  with 1 to 10" (shot 41-owner-utterance-match.png) -> Run -> GRID
  A1:A10 = 1,2,...,10 VISIBLE (shot 41-fill-visible-in-grid.png; DOM
  read ["1".."10"]). The palette therefore executes in gateway mode
  (write_cells through the product MCP caller) — the stale "hosted
  sessions cannot execute" note does not hold for this surface.
- Handoff live: "highlight the top three rows" -> no-match + "Ask the
  agent instead" (41-nomatch-handoff-offer.png) -> panel opens DOCKED
  with the words in the composer (shot 41-handoff-panel.png).
- Process note: an earlier tour run against a stale dist (a daemon
  restart interrupted the rebuild) reproduced the OLD TODAY-60%
  behavior live — incidentally confirming the owner's report end to
  end, including that Run did insert =TODAY() (A1 showed the date
  serial 46318 on a fresh sheet). The owner's "A1 stayed visually
  empty" did not reproduce on a fresh sheet even pre-fix; with the
  correct action the visible-result acceptance is proven above.

### Residuals
- The composer mic (the other half of the section-7 merge) is phase 2
  (#40), per the owner's sequencing.
- Dictation of the verbatim utterance was not re-run through a real
  microphone (typed text is the same string the palette resolves; the
  dictation path itself was proven in #42).

**PHASE 1 COMPLETE:** #36, #37, #32, #38, #39, #34, #31, #35, #42, #41
all fixed and validated above (#33 is absorbed into phase 2 / #40 per
the phase-2 brief).

---

## PHASE 2 — #40 Agent chat UX design system + streaming (governed by design-docs/agent-chat-ux-design-system.md; #33 absorbed)

Plan of record (checkpointed 2026-10-22 late PDT):
1. BEFORE metrics (initial bundle + TTFP on the local stack).
2. Streaming investigation: panel -> gateway agentSvc -> service runtime;
   what events exist, what can genuinely stream.
3. Server streaming (SSE) + client consumption: thinking wave, thought
   region (streams, auto-collapses), progressive markdown, atomic
   blocks, Stop, follow-scroll + back-to-latest, in-place errors.
4. Design system: tokens on theme vars + Button/IconButton/Card/Dialog
   components; panel restyle on the system (36px header icon buttons =
   #33); composer harmonized with #25 + composer MIC (section 7 merge).
5. Shared Dialog migration (inventory-driven; honest coverage list).
6. Lazy loading: chat/dialog/markdown/chart code split; AFTER metrics.
7. Validation per doc section 8: both-theme streaming-state screenshot
   series, standard prompt set, dialog spot-checks; no regression to
   #39/#34/#35/#31/#38.

### BEFORE metrics (this tree, pre-redesign)
- Initial JS on first load (local stack, headless): ONE file,
  index-*.js = 4,539,576 bytes transferred; DOMContentLoaded ~1.28 s.
  Chat, dialogs, markdown and chart code are ALL inside that one chunk
  (no lazy split exists today).

### Streaming investigation (panel -> gateway agentSvc -> service runtime)
- Panel today: RemoteAgentBackend.send() -> POST /api/agent/message ->
  ONE JSON reply (threadId, message, audit, chart, needsInput).
- Service: AgentRuntime.chat() runs a planner loop (backend.plan() ->
  {message, actions} per iteration; runtime executes tools between
  iterations; workflow layer checkpoints per step). The backend
  interface returns WHOLE planner outputs — the final answer text is
  a single field of the last plan. There is no token stream anywhere
  in this architecture, and the planner's completions are structured
  (message + actions), so partial text is not renderable mid-plan.
- Gateway proxy STREAMS already (upRes.pipe(res), "never buffered" —
  the engine load/stream NDJSON path proves it). An SSE route on
  agentSvc flows through with no proxy change (only the long
  agent-message timeout must also cover the stream route).
- DESIGN (honest per doc section 2): stream the increments that
  genuinely exist — planner iterations (thinking), intermediate plan
  narration (thought), tool start/end with summaries, workflow steps
  ride the same loop hooks — as SSE from agentSvc. The final ANSWER
  TEXT lands atomically with the done event (the thinking indicator
  covers the wait, exactly the doc's sanctioned fallback); it then
  renders as progressive markdown (tables as tables). NO typewriter
  fakery. Stop = client abort + a cooperative cancel flag the runtime
  checks at iteration/tool boundaries (agentSvc sets it on socket
  close). HITL parks keep the stream open (long timeout route).

### !!! TREE INTEGRITY INCIDENT (2026-10-23 ~05:26-05:31 UTC) !!!
While this batch was mid-#40 (server streaming), six source files were
REVERTED to the git-baseline ("68588c04 baseline") state and at least
one untracked file was deleted. Evidence: file mtimes 05:28 (during the
"Periodic checkpoint push 2026-10-22" commit run 05:20-05:28 UTC —
[xlsx-adapter] x3, [mcp-server]; an [engine] batch ran 05:07), the
files now byte-match HEAD, and a stray stash branch
"other-agent-wip-1950e42f" exists. Prime suspect: the periodic-push
cron's snapshot/restore flow (icecream-sheets-periodic-push) — it must
not run while workers hold uncommitted state, or its restore step is
defective. PARENT: please stop/verify that cron and check other
workers' trees.
DESTROYED (uncommitted work): packages/service/src/agent/runtime.ts
(the ENTIRE agent-workflows W1 layer: runTurn/driveWorkflow/step
verification/workflow store — it was never pushed; newest remote copy
is 52146278, pre-workflow), types.ts (JobPlan/StepCheck/AgentWorkflow
types), config.ts, openaiBackend.ts, packages/service/src/index.ts,
packages/gateway/src/services/agentSvc.ts (incl. this batch's #32
describeConfig fix), and untracked packages/service/src/agent/
workflows.ts (deleted). SURVIVED: backends.ts, intentRouter.ts (still
modified vs HEAD), all apps/web work (this batch's phase 1 intact —
spot-verified), engineSvc (#36), gateway.ts, and the workflow TESTS
(packages/service/tests/agent-workflows.test.ts) + agent-workflows/
REPORT.md + harness/driver.mjs, which together specify the lost layer.
RECOVERY DONE HERE: the six tracked files restored from remote commit
602e3335 (2026-10-23T05:06Z, the last pre-incident push — a consistent
snapshot of main at that time, pre-workflow-layer). This batch's own
edits (#32 describeConfig, #40 stream route + runtime hooks) were then
re-applied from this session's context. NOT restored: the W1 workflow
layer (not this batch's work; its worker/parent should re-land it
from the surviving tests + design-docs/agent-workflows.md + the
program record). agent-workflows.test.ts is expected to fail until
then — recorded below, not hidden. A defensive copy of every file this
batch touches now lives in hidden_files/live-ux-batch/backup/.
- RECOVERY STATE: restored snapshot + this batch's edits re-applied;
  service builds clean, agent-runtime tests 30/32 (the 2 failures are
  both workflow-layer tests — the incident loss), gateway agent tests
  40/40. SSE PROVEN live on the local stack: POST /message/stream ->
  `event: turn {thinking}` -> `event: turn {thought}` -> `event: done`
  with the full /message payload.

### #40 implementation (design-docs/agent-chat-ux-design-system.md)

**Design system (§1).** New apps/web/src/design-system.css: semantic
tokens mapped ONLY onto the theme variables (surface=--panel,
line=--line, text/dim, accent, danger=--error), one spacing scale
(4/8/12/16/24/32), radii anchored on the #25 composer (26px container;
card 16, bubble 18, pill buttons), two elevations, and a deliberate
type scale on the app UI font stack with a mono stack for code.
Components in apps/web/src/components/ui/: Button (primary/secondary/
ghost/danger, S/M), IconButton (36px hit area, tooltip+aria-label),
ThinkingWave, Markdown (below). AgentChat consumes them throughout:
header tabs are ghost buttons, settings/close are 36px IconButtons
(#33 absorbed — the old .agent-chip ⚙/× were ~24px), pending-ask and
disambiguation buttons are system buttons, artifact header likewise.
Bubbles are ds-msg classes from tokens in both themes (the old user
bubble was a hard-coded #2563eb).

**Streaming (§2) — what streams and what does not, honestly.**
INVESTIGATION: the backend interface (ModelBackend.plan) returns
WHOLE planner outputs per iteration ({message, actions}); planner
completions are structured, so partial answer text is not renderable
mid-plan, and no token stream exists anywhere in the pipeline. The
gateway proxy already streams (pipe, never buffered). IMPLEMENTED:
- Service: AgentRuntime.chat() accepts AgentTurnHooks; the loop emits
  {thinking: iteration} at each iteration start, {thought: text} for
  intermediate plan narration, and {tool: start/end, ok, summary}
  around every tool execution; a cooperative isCancelled hook is
  checked at iteration/tool boundaries (throws AgentTurnCancelled ->
  chat() returns an honest "Stopped" reply and keeps the thread
  coherent). AgentRuntime.chatStream wraps it for in-process hosts.
- Gateway service: POST /api/agent/message/stream (SSE) — same
  session resolution as /message; turn events as they happen, then a
  'done' event carrying the exact /message payload; a client
  disconnect sets the cancel hook; failures send an 'error' event in
  plain language. The gateway's long agent-message upstream timeout
  now covers the stream route too (HITL parks stay open).
- Web: GatewayClient.callStream (same auth/reauth/error discipline),
  RemoteAgentBackend.chatStream parses SSE (split-chunk safe),
  AgentChat.runChatTurn renders the in-flight message live and falls
  back to one-shot chat() on backends without streaming (desktop).
- STREAMS: thinking iterations, plan narration, tool activity (the
  thought region). ATOMIC (by architecture, stated plainly): the final
  answer text, which arrives with 'done' — the thinking indicator
  covers the wait, per the doc's sanctioned fallback. NO fabricated
  typewriter effect anywhere. Tables therefore land whole (rendered
  as real tables by the Markdown component) rather than row-by-row;
  row-by-row would require a token-streaming planner, which the
  backend interface does not support.
- PROVEN live (curl): thinking -> thought -> done SSE sequence from
  the local stack's agent service.

**Presentation (§3).** ThinkingWave: three dots in a staggered wave
(reduced-motion -> gentle fade), aria "Thinking…", appears the moment
a prompt is sent, plus a streaming caret on the in-flight bubble.
Thought region: streamed steps (plan narration + tool lines with
✓/✗) in a dim, set-apart region; AUTO-COLLAPSES when the answer
lands to "Thought for N steps" (re-expandable). Markdown answers:
safe subset renderer (React elements only, no innerHTML — headings,
lists, emphasis, code, fenced blocks, GFM tables, quotes, https
links); an unterminated fence renders as a block in progress.
Atomic blocks: chart attachments and app artifacts render only when
complete (unchanged plumbing, now framed by the system). Stop:
composer Stop button aborts the stream (AbortController) and the
service stops the turn at the next step boundary; the bubble shows
"Stopped — the agent ended that request early." Follow-scroll: the
transcript follows only while the user is at the bottom; scrolling
up offers a sticky "Back to latest". Copy action on completed
answers (hover-revealed). Mid-stream errors render IN PLACE in the
message (plain language; received steps stay visible).

**Composer mic (§7 merge).** The composer carries a mic IconButton
(36px) wherever a dictation route exists. Dictation plumbing is
SHARED with the palette: apps/web/src/services/dictation.ts holds the
one recorder configuration (32 kbps, 60s cap, 600 KB ceiling — the
#42 discipline), the helpers, and a useDictation hook the composer
uses (the palette now imports the same constants/helpers). Interim
transcripts show as a "Listening…" caption; the final transcript
lands in the composer as editable text — the user reviews and sends;
dictation never sends by itself. Proven present + functional in the
dark tour (buttons ["Dictate a message","Send"]).

**Dialogs (§5).** The app already had ONE dialog primitive —
A11yDialog (84 consumers, focus trap/Esc/return built in) — so the
migration re-skinned ITS chrome onto the system instead of forking a
second component: .dialog now uses the token surface, 16px radius,
dialog elevation; .dialog-title is the system title size;
.dialog-close is the 36px circular icon button with focus-visible
ring (the duplicated legacy rule was removed). Every A11yDialog
consumer (Find, FormatCells, Sort, agent settings, the voice palette,
Shortcuts, Settings, …) inherits it. The Help PANE (not a dialog)
also had its chrome moved onto the system (token surface — it
hard-coded #fff and broke dark mode — 36px close, ghost tab chips).
Spot-checks: agent settings dialog (radius 16px, close 36x36/50%,
Esc closes), Find and Replace dialog, Help pane — screenshots below.

**Lazy loading (§4).** AgentChat and VoiceCommandPalette are now
React.lazy chunks (with the Markdown renderer and dictation plumbing
split alongside): AgentChat-*.js 25.4 KB, VoiceCommandPalette-*.js
25.4 KB, dictation-*.js 2.7 KB load on first use, not at startup.
BEFORE: initial load = one JS file, 4,539,576 bytes. AFTER: initial
JS 4,477,093 bytes (−62.5 KB, −1.4%); DOMContentLoaded ~1.3 s before
vs ~1.9 s after on this shared host (noisy; the byte figure is the
reliable one). The reduction is small for an architectural reason,
stated honestly: in LOCAL mode the app runs the whole agent runtime
in-process, so the service package (runtime + MCP server) is part of
the app proper and stays in the initial bundle; what split out is
the chat/dialog UI layer the doc names.

**Validation (§8; all local production-topology stack, gateway dist).**
- Standard prompt set through the redesigned panel (tour40/40c):
  total revenue -> 160,200 with streamed steps + collapsed "Thought
  for 3 steps" + Copy (40-streaming-light, 40-answer-collapsed-light,
  40-thoughts-expanded-light); revenue-by-region markdown table
  rendered as a real table — North 89,100 / South 71,100 / Total
  160,200 (40-table-answer-light); chart ask -> clarification ->
  chart attached atomically in chat AND added to the sheet
  (40-chart-answer-light).
- Both themes: panel at rest light + dark (40-panel-rest-light,
  40-panel-rest-dark); streaming mid-wait with wave + Stop in both
  (40-streaming-light, 40-streaming-dark); Stop mid-stream in dark ->
  stopped caption (40-stopped-dark).
- Error in place: agent service killed mid-tour -> "The agent could
  not be reached just now. What you see above is as far as it got —
  please try again." in the message (40-error-in-place).
- Dialogs: settings (40-dialog-settings), Find (40-dialog-find),
  Help pane (40-help-pane).
- No regressions: docking geometry re-measured with the redesigned
  panel (main 1100 / panel 340 / overlap 0 — #39); #34/#35/#31/#38
  surfaces untouched by this phase except AgentChat internals whose
  resize/dock-var code paths are unchanged.
- Tests: service agent suites 99/101 (the 2 failures are the
  workflow-layer tests lost in the TREE INCIDENT above — not this
  phase's doing and not hidden), gateway agent 40/40, web related
  65/65 (incl. new SSE-client and Markdown suites). tsc clean in all
  three packages.

### Phase-2 residuals (explicit)
- Answer TEXT does not token-stream (planner outputs are whole) —
  see the honest accounting above. If a future backend gains a
  streaming completion for final answers, chatStream's 'turn' channel
  can carry text chunks without UI changes.
- Dialog coverage: all A11yDialog consumers (84 files) are on the
  system chrome. A minority of surfaces still hand-roll overlays
  outside A11yDialog (e.g. some shape/picture overlay editors); they
  were not migrated in this pass.
- The workflow-layer loss from the tree incident stands: the tree's
  agent runtime is the restored pre-workflow snapshot + this batch's
  hooks; agent-workflows.test.ts (2 failing tests + the suite file
  itself failing to load on the missing workflows module) needs the
  W1 worker's re-land.
- Bundle: the initial chunk remains ~4.48 MB (the app itself); the
  ≤3 s TTFP rule holds locally (~1.3-1.9 s DCL on this host) but the
  split's win is bounded by the in-process-runtime architecture.
