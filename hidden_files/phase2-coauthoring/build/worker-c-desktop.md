# Worker C — DESKTOP LOGGED-IN PARITY (Phase 2 co-authoring)

Verdict: **the packaged desktop app joins and co-authors a live server
session exactly like a web client — PROVEN end-to-end** (join, SSE
deltas both directions, presence both ways, server-sequenced edit from
the desktop, server-reported Saved status), and the same AppImage's
logged-out local mode is untouched. Two shared-web-code fixes were
required and are flagged in §3 — without them the packaged renderer
could not reach the gateway flow at all, and no signed-mode client
(web included) could read a joined session. The §10 matrix leg (b) as
a whole remains the coordinator's gate; this is the smoke proof +
packaged build it runs on.

All artifacts: `hidden_files/phase2-coauthoring/build/desktop-smoke/`.

---

## 1. Packaged build — how it was produced

**Deliverable:** `apps/desktop/dist/IcecreamSheets-0.1.0.AppImage`
(142,469,570 B, sha256
`cfded7e463a69b5b5bb4db61f620e10c5bd21392d2fccd3ccee9c1cb506fa36a`)
plus `apps/desktop/dist/linux-unpacked/` (the binary the smoke drove:
`linux-unpacked/icecream-sheets-desktop`). It REPLACES the Phase 1
AppImage in that dir (Phase 1 sha256 `e7052fc8…` recorded in
`desktop-smoke/phase1-appimage-sha256-before.txt`).

**Staging approach (apps/web/dist never touched):**
1. The shipped `apps/web/dist` has NO gateway env baked
   (`import.meta.env` is `{}` in the bundle — verified by inspection),
   so per tasking a desktop-specific web bundle was built into staging
   only:
   `cd apps/web && VITE_GATEWAY_URL=http://localhost:8100
   VITE_ENGINE_ACCESS_MODE=signed npx vite build --outDir
   hidden_files/phase2-coauthoring/build/desktop-stage/web/dist`.
   Verified in the output bundle: `VITE_GATEWAY_URL:"http://localhost:8100"`,
   `VITE_ENGINE_ACCESS_MODE:"signed"`, and in the final app.asar
   (5× `http://localhost:8100`).
2. Desktop package staged at `…/build/desktop-stage/desktop/`: copied
   `package.json`, `tsconfig.json`, `build/`, and the already-compiled
   `dist/*.js` from `apps/desktop`; `node_modules` symlinked to the
   real `apps/desktop/node_modules`. electron-builder's config
   (`files: [{from: "../web/dist", to: "web/dist"}]`) then resolves to
   the STAGED web bundle — the real `apps/web/dist` was never copied
   over, rebuilt, or moved (its files still carry their pre-task
   timestamps; the :4173 preview served it uninterrupted).
3. `electron-builder --linux AppImage` run from the staging dir
   (electron-builder 26.15.3 from the workspace root, TMPDIR pointed
   at staging per the desktop README's tmpfs warning). Output copied
   to `apps/desktop/dist/` (AppImage + linux-unpacked).

**Gateway CORS: NO CHANGE NEEDED.** The permitted gateway change was
not used: `packages/gateway/src/httpUtils.ts` already answers
`Access-Control-Allow-Origin: *` on the gateway AND the engine
service, and every call from the `file://` asar renderer (gateway
`/auth`, `/api/engine/open`, `/api/engine/access`; direct engine
`/read`, `/sheets`, `/snapshot`, `/ops`, `/presence`, SSE `/deltas`)
succeeded from that origin (see the request log in
`desktop-smoke/results.json`). No gateway code was edited, no gateway
tests needed re-running, and **no stack service was restarted at any
point** (gateway/engine PIDs identical at start and finish; final
health: 8100/8101/4173 all 200).

## 2. Auth replication (exact keys)

- Carol's gateway JWT was obtained exactly as the web UI does locally:
  `POST http://localhost:8100/auth/login {userId:'carol'}`
  (the local-dev login `GatewayClient.login()` uses).
- It was injected via a CDP init script (runs before any app script on
  the join navigation) into **localStorage key
  `icecream-sheets.gateway-token`** — the exact slot
  `GatewayClient.setToken()` writes (`TOKEN_KEY` in
  `apps/web/src/services/gatewayClient.ts`) and the constructor reads
  back. No other storage keys were set by the driver; the app itself
  wrote `icecream.clientId` + `icecream.collab.<fileId>` (transport).
- Join navigation: the packaged page URL
  `file://…/app.asar/web/dist/index.html?phase2=join#file=<fileId>`
  (query added only to force a full reload; the app reads `#file=`
  via `readFileIdFromHash()` at startup).

## 3. Code changes (shared web code — flagged prominently)

Two blockers made the contracted flow impossible as shipped. Both
fixes are in shared web code (contract: "fixed in shared web code
where possible"), are additive/gated, and are covered by the related
suites (below). No `apps/desktop` main-process code changed; no
`packages/*` code changed.

**Fix 1 — logged-in desktop could never select the gateway host**
(`apps/web/src/engine.ts`). `createInitialHost()` returned
`IpcEngineHost` for ANY desktop renderer before ever looking at the
gateway client, and `connectGatewayHost()` explicitly nulled the
gateway client on desktop — so a packaged renderer was structurally
incapable of §11 logged-in mode, gateway build or not. Now:
a gateway client WITH a stored JWT wins first (desktop and web
alike — that renderer is logged in and joins the service); a desktop
renderer WITHOUT a JWT falls through to `IpcEngineHost` exactly as
before (logged-out mode byte-for-byte the same path). On construction
failure, desktop no longer clears the token and falls back to the IPC
host instead of the in-process engine.

**Fix 2 — signed-mode grants were never scoped to the joined session**
(`apps/web/src/services/collabTransport.ts`,
`signedEngineTransport.ts`, `remoteEngine.ts`). The Phase 2 join
handshake returns the sessionId, but nothing told the host's
`SignedEngineTransport`, whose grants are minted via
`POST /api/engine/access` — with no session scope the gateway mints a
grant for a FRESH random session and the engine refuses every read
with `401 wrong-session` (probed live, §5). This broke join-by-link
reads for ANY signed-mode client, web included — Worker B's flagged
"thinnest part" (§3 of worker-b-webclient.md) is exactly this seam.
Fix: `CollabTransport` gains an `onOpen` callback (deps + setter,
fired on every connect/reconnect — endpoints are leased, §9);
`RemoteEngineHost.attachCollabTransport` registers it to call the new
`SignedEngineTransport.bindSession(sessionId)`, which scopes future
grants to the opened session and drops a cached grant scoped
elsewhere. Session-scoped grants were probe-verified reusable
(8/8 reads 200, `api-probe-grant-reuse.mjs`).

Tests: `npx tsc --noEmit` clean; related vitest suites green after
the changes — collabTransport (10), remoteEngine (12),
signedEngineTransport (6), routedEdit (18), collab (11),
sessionLifecycle (9), saveInterlock (10), engineTransport (2),
grid + grid-lock-badge (8): **86 passed / 0 failed** across the two
runs. No new tests were added for the bind seam (the coordinator may
want one; the live proof is §4).

## 4. Smoke proof — per-assertion results

Setup (`desktop-smoke/api-setup.mjs`): alice login → `POST
/api/engine/open {name:'phase2-desktop-smoke'}` → claim, fileId
`file-b58f686c-c90a-4e34-98b9-95f38dd46bfa`, sessionId
`sess_b7af9bee-8809-4e9d-8a5b-6448a3771629` → direct engine `/load` of
a tiny workbook (Sheet1: A1=10, B1=20, B2 `=A1+B1`) → `/ops` setCell
A1=42 → revision 1, read-back A1=42, B2=62. NOTE: the engine still
held Worker A's live session, so the first claim 409'd
("engine already owns a different file"); I released Worker A's
leftover through the normal API lifecycle
(`api-release-leftover.mjs`: join + `POST /session/release`,
checkpointed at revision 3) — the same handover I did for my own
session at the end (§6).

Driver: `desktop-smoke/desktop-smoke.mjs` (xvfb-run,
`--remote-debugging-port=9222`, playwright-core `connectOverCDP`,
fresh `--user-data-dir` profile). Full record:
`desktop-smoke/results.json`.

| # | Assertion | Result | Evidence |
|---|---|---|---|
| 1 | Alice re-open JOINS (not creates) | ✅ `joined:true`, same sessionId, revision 1 | results.json `aliceReopen` |
| 2 | Carol's packaged app joins alice's session | ✅ grid shows A1=42, B1=20, B2=62; header chip `🔗 file-b58f…` matches; status bar user "carol", "✓ Saved" (server-reported) | `01-carol-joined.png`, results.json `joined` |
| 3 | Registry names the same session/owner | ✅ record: sessionId match, ownerInstance `engine-1`, epoch 1 | `registry-record.json` |
| 4 | Alice `/presence` (Sheet1 r4 c2) → visible in carol's app | ✅ header avatar `{title:'user:alice', text:'AL'}`; red selection flag + "alice" name tag rendered at C5 in the grid | `02-presence-alice-avatar.png`, `03b-after-sse-delta.png` (flag visible), `presenceAliceInCarolApp` |
| 5 | Alice API edit B1=100 (rev 2) → carol's grid updates via SSE delta | ✅ B1=100 and recalculated B2=142 appear without any reload/poll; SSE capture (alice's own subscription) shows the rev-2 delta carrying both cells incl. formula | `03a-before-sse-delta.png` / `03b-after-sse-delta.png`, `sseDeltaApplied`, SSE log in results.json |
| 6 | Carol presence → engine/other client | ✅ after carol clicks C3, the SSE presence event lists `user:carol` at Sheet1 row 2 col 2 (color #16a34a) alongside alice; `POST /presence` from the app ×3 recorded | `presenceCarolInSse`, `04-presence-both-ways.png` |
| 7 | Carol edits A3=777 in the packaged app → lands on the server with a server revision | ✅ read as alice: A3 `{kind:'number', value:777}`; session revision 2 → 4 (see flag F2); `/session/status` participants = alice + carol, both editor; SSE delta origin principal `user:carol` | `05-carol-edit.png`, `carolEditLanded` |
| 8 | SSE is the only push channel (no /events polling) | ✅ app request log: 1× `/api/engine/open`, 1× `/deltas` EventSource (+3 `/deltas/ack`, 2 `/ops`, `/presence`), **0 `/events` requests** | results.json `requests` |
| 9 | Logged-out mode untouched (SAME AppImage, fresh profile, no token) | ✅ local fixture opened via argv on the local engine: A1=10, B1=20, B2=30 (local recalc), localStorage gateway token = null, no fileId chip, identity "You" | `desktop-loggedout.mjs`, `loggedout-results.json`, `06-loggedout-local-file.png`. Open+read only per tasking; full save proof remains Phase 1 evidence (`hidden_files/direct-save-pass/desktop-packaged.json`) — NOT re-run |

## 5. Conflicts / blockers found (flagged, not hidden)

- **F1 — the two structural blockers of §3** (desktop host selection;
  unscoped signed grants). Both contradict the CONTRACT's assumption
  that "the app must reach the gateway open flow (the renderer's
  gatewayClient)" with no code changes; the contract's own escape
  hatch (fix in shared web code) was used. The coordinator should
  re-check the WEB leg under signed mode with Fix 2 in place — the
  :4173 dist predates it.
- **F2 — one desktop grid edit produced TWO server ops.** Carol's
  single A3 commit appears in the SSE log as revision 3 AND revision
  4 — same transport clientId, clientSeq 1 and 2, identical cell +
  value (777). Convergence is unaffected (same-cell LWW, same value),
  but every grid edit appears to be submitted twice through
  `submitCommand` (two distinct envelopes, so server idempotency
  cannot collapse them). This is the bridge-vs-host double-path
  tension Worker B documented (their decision #1); the dedup flag
  covers the bridge BROADCAST path, so the second submission likely
  enters via a second host execute of the same UI commit. Not
  desktop-specific (same code path as web) and not caused by §3's
  fixes (they don't touch submission). Evidence: SSE deltas in
  results.json. Owner: coordinator / Worker B code.
- **F3 — a second, never-bound engine client inside the app 401s for
  the whole session.** Diagnostic run (`desktop-diag401.mjs`,
  `diag401-trace.json`, tokens recorded as hashes only): after the
  bound transport is working (token hash `2528bccb` → 200s), another
  stream of `/sheets` + `/read` calls keeps reusing ONE cached
  unscoped grant (hash `cec5ea44`) and gets `401 wrong-session` on
  every call, plus a pre-join burst of one-shot unscoped grants.
  Main-run totals: 325 `/api/engine/access`, 622 `/read`, 630 console
  401s — functionally transparent (the bound host serves the grid)
  but noisy and wasteful; the failing instance never recovers because
  its cached grant matches its own (random) session scope. Likely a
  second RemoteEngineHost/SignedEngineTransport created somewhere
  outside the App transport effect (the attach/bind only reaches the
  App's host). Fix 2 gives the coordinator the mechanism
  (`bindSession`); the instance hunt is theirs.
- **F4 — auxiliary-service 502s (pre-existing stack state, not a
  desktop defect):** the app probes `/api/addons/catalog|installed|
  grants` at boot and the gateway 502s because the addons service
  (:8107) is not running — only gateway/engine/preview were up per
  tasking, before and after my work. 3 console errors per boot.
- **F5 — remote-selection flag DOM probe:** my scripted probe for the
  flag's text node found nothing (wrong selector assumption), but the
  flag + name tag are plainly rendered in `03b`/`05` screenshots —
  recorded as visually confirmed, DOM-probe missed.
- **F6 — handleNew interaction (noted, not exercised):** in gateway
  mode the New-workbook flow resets first and only then runs the join
  handshake; with Fix 2 the host transport rebinds to the file session
  on that open. Whether the engine's claim accepts the post-reset
  state in all orders is a coordinator integration question — the
  smoke never presses New.

## 6. Stack handover state

- gateway :8100, engine :8101, preview :4173 all RUNNING, never
  restarted, default `start-stack.sh` env (PIDs unchanged).
- My smoke session was released via `POST /session/release`
  (checkpointed, revision 4, checksum `159fedab…`,
  `api-release-smoke.mjs`) so the single-session engine does not 409
  the matrix worker's first claim — the file remains rehydratable
  under the same fileId/sessionId.
- No desktop processes remain; ports 9222/8106 free.
  `apps/web/dist` untouched. No git push; no progress/TODO/perf edits.

## 7. NOT done (stated plainly)

- The full §10 matrix leg (b) scenario set (same-cell conflict,
  structural rebase, disconnect/reconnect, owner kill, etc. with
  desktop + browser) — coordinator's gate; this report is the
  packaged build + logged-in smoke proof it builds on.
- Signed-URL **download** from the desktop (§11(g)) and desktop
  **force-save** of a service file: not exercised — the smoke proves
  join/deltas/presence/edit/autosave-status only.
- macOS/Windows packages: not built (tasking = Linux AppImage).
- New unit tests for the `bindSession` seam: not added (related
  suites re-run green, §3); the live evidence is §4.
- `desktop-smoke/session.json` contains local-dev tokens from the
  runs (engine access tokens are 600 s TTL and long expired; kept so
  the evidence scripts remain re-runnable/auditable).
