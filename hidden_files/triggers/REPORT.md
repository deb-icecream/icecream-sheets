# Triggers Build — Report

Coordinator started: 2026-10-22 (~04:46 PDT)
User decision: build both trigger kinds, sequenced — Phase 1 edit/change +
onOpen hosting + product UI; Phase 2 schedule triggers (interval + one-shot)
on the SAME runtime and UI.
Design authority: `design-docs/automation-lane.md` (§1 permissioned API +
recorded grants, §3 event runtime, §5 persistence, §7 agent boundary).
Existing (do NOT rebuild): `TriggerRuntime` + `TriggerSpec`/store in
`packages/service/src/automation/` (runtime.ts, triggerSpecs.ts).

## Stage log

- [x] Brief read; report skeleton created.
- [x] Recon complete; HOSTING DESIGN locked (below).

## HOSTING DESIGN (coordinator, 2026-10-22 — from code evidence)

**Why the runtime is NOT hosted in-process in the engine service:** a
trigger's writes must be journaled, sequenced ops (revision-model
invariant). In-process, `AutomationApi` calls `host.execute` directly —
bypassing the sequencer/journal/deltaLog (data-loss class on rehydrate),
or it would need a new synthetic journal op kind (the chart.add precedent
is still awaiting user ratification). The engine's `/execute` route IS
the sequenced+journaled path, and the agent/add-on bindings already run
production reads AND writes over it via `NodeRemoteEngineHost`.

**Gateway/service topology — a trigger SUPERVISOR in the service
package** (`createServicePackageListener` + `bin/service.ts`):
- Watches the session registry (local registry file fresh-read, or
  `FileRegistry.listAll()` in prod — the same sources as
  `agentSessionResolver`), one attached `TriggerRuntime` per live file
  session, built on `NodeRemoteEngineHost` (minted editor token,
  sub = the session's creatorPrincipal; pollMs ~400). Scripts still run
  as `automation:<name>` inside the AutomationApi (cmd.auth principal) —
  the token is transport, the grant ledger is the consent (§1).
- Attach on live record; fire onOpen ONCE per (fileId, sessionId) —
  the fired session id is persisted so a supervisor restart does not
  re-fire onOpen for the same session. Detach/dispose when the record
  dies or the sessionId changes.
- Event order = engine /events seq order = op application order; an
  edit by ANY client of the session fires the trigger.
- Management surface: NEW service-package surface `automation` +
  `/api/automation` added to the gateway's SERVICE_FAMILY_ROUTE_PREFIXES.
  Authorization mirrors the resolver's rules: the file's most recent
  registry record names creatorPrincipal + participants; creator and
  editor participants may mutate; viewer participants read-only; no
  record → 404. Specs are listable/mutable with NO live session (the
  per-file store is supervisor-owned); firing needs a live session.

**Desktop local mode:** Electron main hosts the same `SessionTriggerHost`
against its singleton in-process `EngineHost` (single-user local model:
trigger writes mutate the live model and persist via the normal
direct-save/checkpoint path; engine events forward to the renderer as
usual). Scope = current file path; re-scope + fireOpen on load/new.
Renderer reaches it via new `triggers:*` IPC on `window.icecreamDesktop`
(the `engine:*` pattern).

**Shared core (service package):** `SessionTriggerHost` in
`packages/service/src/automation/host.ts`, exported from
`automation-node`: per-scope store (persistence key prefixed by scope),
PERSISTED GRANT RECORDS re-applied on attach (the runtime's grant ledger
is in-memory per AutomationApi — hosting must persist the §1 consent or
"grant once" breaks across sessions), last-run tracking, management API
(list/create/remove/setEnabled/grant) that works attached or not.
Runtime additions (minimal, additive): `TriggerRuntimeOptions.workbookId`
(the constructor's cellsChanged handler currently calls fireEdit with NO
workbookId, so workbook-scoped specs would never fire from engine
events) and `TriggerRuntimeOptions.onRunReport` (every run outcome,
incl. subscription-driven fires — the UI's last-run state).

**Persistence story (explicit, per brief; UPDATED by the user's
2026-10-22 ~05:39 PDT scope ruling — the Firestore store is IN SCOPE,
no longer a named follow-up):**
- Local topology + desktop: file-backed Persistence on disk
  (gateway: `filePersistence` under the data dir; desktop: app data
  dir) — specs + grants survive restarts. REAL.
- Prod (Cloud Run): **Firestore-backed, built in this program.**
  Mechanism (bridge over the runtime's synchronous store): a
  **write-through cache hydrated at attach**. At attach/CRUD time for
  a scope, `AsyncMetadataStore<TriggerSpec>` and
  `AsyncMetadataStore<TriggerGrantRecord>` over
  `FirestoreMetadataPersistence` (collection
  `icecream_trigger_metadata`, the family naming style; sha256 doc
  ids; the 1 MiB doc cap rejects LOUDLY at save, never truncates)
  hydrate a synchronous `Persistence` facade; the runtime/host read
  the local copy, every save writes through to Firestore on a tracked
  promise chain, and the supervisor awaits `flush()` after CRUD calls
  and before detach so a failed write surfaces at the API boundary —
  never silently. Selection: `TRIGGER_STORE=prod` (env posture
  mirroring MCP_STORE / SHARE_STORE) picks the Firestore provider in
  the supervisor; missing GCP_PROJECT_ID or a missing Firestore
  client FAILS CLOSED (automation surface 503s, no attachment) — no
  silent in-memory or local fallback in prod. Deploy rows ride along
  (service yaml + CONFIG.md). Consistency story: the writer for a
  file's specs/grants is the one supervisor that has that file's live
  session attached (the registry guarantees one live session owner);
  a second service-package instance attaching the same session in a
  scaled-out prod is a NAMED RESIDUAL (supervisor leader election is
  future work — the deployed service is scale-to-zero). Live-Firestore
  proof rides post-deploy verification, like every other prod adapter.

**Event coverage honesty:** onOpen + onEdit genuinely fire in both
hosted topologies. **onSelectionChange is offered NOWHERE in this
pass**: selection is renderer-local in both topologies; the one server
-side trace (engine presence anchors) never leaves the engine service,
so no trigger host can observe it. Named follow-up seam: surface
presence-anchor changes on the engine /events stream (or a renderer→
main IPC on desktop), then offer the event. The UI offers only events
the surface reports as fireable (`events` capability list in the list
response). Timed triggers (Phase 2): the runtime exists only while a
session is live → a schedule that passes with no session open fires
ONCE on next attach (tick() semantics: interval due → fires once, not
per missed interval; one-shot with lastFiredAt unset fires once),
auditable via `lastFiredAt`.

**HTTP contract (gateway mode, via gateway JWT):**
- GET /api/automation/triggers?fileId= → { ok, events: string[],
  triggers: TriggerStatus[] }
- POST /api/automation/triggers { fileId, spec: TriggerSpecInit }
- POST /api/automation/triggers/:id/enabled { fileId, enabled }
- POST /api/automation/triggers/:id/grant { fileId }
- DELETE /api/automation/triggers/:id?fileId=
- TriggerStatus = spec fields + { granted: boolean, lastRun:
  { ok, error?, durationMs } | null }
Desktop bridge mirrors this minus fileId:
window.icecreamDesktop.triggers.{list,create,remove,setEnabled,grant}.

**Script shape (node sandbox):** bare script body with live sync `api`
+ frozen `event` globals (see automationSandbox.test.ts) — NOT the
main(api) shape of the in-page Apps Script runner. UI templates must
use this shape for triggers.

## Phase 1 — Hosting (onEdit + onOpen)

Status: CORE DONE (verified by coordinator on disk: host.ts 9,480 B, test file 17,765 B, runtime workbookId wiring at runtime.ts:49-113, node.ts export at :28). Daemon restarts killed the first gateway + desktop workers (landed nothing, verified) AND the second gateway worker (landed nothing; left a design note) AND the first Firestore worker — which had LANDED ALL ITS CODE first (hostFirestore.ts 10,238 B + tests written, run pending; see the Firestore subsection). As of 2026-10-22 ~06:00 PDT, running: gateway supervisor (3rd attempt, brief carries the per-entry onOpen-fired extraKey design), desktop hosting (2nd attempt), Firestore completion worker (test run + extraKeys addition + final numbers).
- [coordinator] Service dist REBUILT by coordinator after core landed (`tsc -p tsconfig.json` exit 0, 2026-10-22 12:40 UTC): `dist/automation/host.js` exists, `SessionTriggerHost` exported from built `automation-node` — gateway/desktop workers import from dist and were told not to rebuild it.
- [coordinator, 2026-10-22 ~06:11 PDT] After THREE gateway workers died in daemon restarts (two landed nothing, one landed nothing + a design note), the coordinator is implementing the gateway track DIRECTLY in small chunks. LANDED: `packages/gateway/src/services/triggerSupervisor.ts` (15,250 B, written + API-verified against host.ts: create→TriggerStatus, remove→boolean, setEnabled/grant→void, list→TriggerStatus[]): registry watch (local file / FileRegistry.listAll / injected records), per-file entry with ONE SessionTriggerHost, attach over NodeRemoteEngineHost (minted editor token, sub=creatorPrincipal, pollMs 400), per-entry onOpen-fired record under `<fileId>::icecream-sheets.trigger-open-fired.v1` hydrated via the facade extraKeys, detach on death/session change, CRUD delegating to the host with flush awaited after mutations, authorizeFile matrix (creator→editor, participant→recorded role, role-less→viewer, none→null), persistence provider abstraction (file default; TRIGGER_STORE=prod → dynamic import of the Firestore bundle; ANY prod failure → prodBrokenReason, surface 503s, NO fallback).
- [gateway supervisor] SUCCESSOR started clean 2026-10-22 ~05:49 PDT (predecessor landed nothing, verified on disk). Brief + HOSTING DESIGN + host.ts/resolver/agentSvc/remoteHost/servicePackage patterns read. Building: triggerSupervisor.ts → automationSvc.ts → servicePackage + gateway.ts + deploy rows → tests. NOTE: the parallel Firestore bundle's write-through facade only permits its two hydrated keys per scope, so the supervisor-level onOpen-fired map (own key) is exact on the file provider and best-effort (caught + logged) on the prod facade — specs/grants persistence is unaffected.
- [coordinator, 2026-10-22 ~06:20 PDT] Gateway wiring LANDED by coordinator: `automationSvc.ts` (8,006 B — contract surface: x-principal 401, unknown file 404, authorizeFile gate, CRUD routes, validation→400, unknown trigger→404, supervisor null/prod-broken→503); servicePackage.ts ('automation' surface + prefix + supervisor construct/start with deps passthrough + null opt-out); gateway.ts '/api/automation' family prefix; deploy rows (service.yaml TRIGGER_STORE="prod"; CONFIG.md TRIGGER_STORE row). NOTE: the [gateway supervisor] note above describes the superseded global-map idea — the shipped design stores the fired record per entry via the facade extraKeys (see the supervisor checkpoint). Desktop track COMPLETE at code+unit level per the [desktop hosting] notes (7/7 tests, tsc clean). REMAINING: gateway tests (supervisor unit + real-engine integration), gateway tsc + full suite, service dist rebuild, live validation.
Verdict: PASS for the core deliverables — see suite numbers below.
- [desktop hosting] SUCCESSOR started clean (predecessor landed nothing, verified). LANDED + verified on disk: `apps/desktop/src/triggers.ts` (8,397 B) — Electron-free `TriggerHostManager` {host, dir, principal='user'} with a local file-backed Persistence (one file/key, sanitized+sha256-suffix, atomic temp+rename, mirroring gateway filePersistence.ts), scope = file path or 'untitled', setScope detach→create SessionTriggerHost→attach same EngineHost→fireOpen, management passthroughs list()={events:['onOpen','onEdit','onInterval','onAtTime'],triggers}/create/remove/setEnabled/grant(grantedBy=principal), dispose(). Plus `apps/desktop/src/automation-node.d.ts` ambient types for the service automation-node subpath (desktop CJS+node10 resolution cannot read the exports map — same pattern as mcp-server-http.d.ts; static import otherwise fails TS2307, probed).
- [desktop hosting] LANDED + verified: `apps/desktop/src/triggers-ipc.ts` (2,944 B) — `registerTriggersIpc(ipcMain, manager)` for triggers:list/create/remove/setEnabled/grant, channel-prefixed validation errors, manager errors propagate (engine-ipc posture).
- [desktop hosting] WIRING LANDED + verified via grep: engine-ipc.ts — new optional `EngineIpcDeps.onWorkbookCurrent(filename|null)` fired at the exact points a workbook becomes current (engine:load after swap+autosave-note, with the filename the load carried; engine:new with null). main.ts — imports manager+IPC, module-level `triggerManager`/`rescopeTriggers` (failures logged, never break an open), constructed in registerIpc() with dir `<userData>/triggers` (app.getPath('userData') + paths conventions), registerTriggersIpc called, onWorkbookCurrent passed to registerEngineIpc, menu newWorkbook() calls rescopeTriggers(null), close-flush teardown disposes the manager. preload.ts — `triggers:{list,create,remove,setEnabled,grant}` via ipcRenderer.invoke + `DesktopTriggersApi` interface (TriggerSpecInit from service, TriggerListResult/TriggerStatus type-only from ./triggers); renderer.d.ts re-exports DesktopTriggersApi (window.icecreamDesktop typing flows from IcecreamDesktopApi).
- [desktop hosting] TESTS LANDED + PASSING: `apps/desktop/tests/triggers.test.ts` (7 tests, TMPDIR=~/workspace/tmp-triggers-w3, log tmp-triggers-w3/triggers-test.log): untitled scope + events list; granted onEdit → real EngineHost edit → write (42) in model (+ ungranted refusal first, persistence files on disk); grant persists across manager restart (new manager, same dir+scope, no re-grant, fires); setScope path isolation (+ untitled isolated, return restores); re-scope fires onOpen (persisted spec+grant); setEnabled/remove/unknown-grant; registerTriggersIpc channel set + delegation + malformed-input errors. **7/7 passed.**
- [desktop hosting] tsc PASS: `tsc -p apps/desktop/tsconfig.json --noEmit` exit 0 (log tmp-triggers-w3/tsc.log), zero errors — no dist rebuilt (--noEmit honoured).
- [desktop hosting] FULL apps/desktop suite PASS: `vitest run` (TMPDIR=~/workspace/tmp-triggers-w3, log tmp-triggers-w3/full-desktop.log) — **Test Files 19 passed (19), Tests 169 passed (169), exit 0**, incl. triggers.test.ts 7/7 and engine-ipc.test.ts (the onWorkbookCurrent dep is optional, existing harness unaffected). Verdict: PASS for desktop hosting deliverables 1–5. No git push, progress.md untouched, no dist rebuilt, app not packaged, shared 8100 stack untouched. Honest note: the runtime import is a static import of the ESM service subpath from the CJS main build — the same shape the existing dynamic-import code compiles to (require of the ESM package, which the desktop's Node supports) and the pattern the add-on/save-node paths already rely on; a packaged-app launch proof is NOT part of this worker's validation (unit/integration + tsc only).
- [core] runtime.ts: added `TriggerRuntimeOptions.workbookId` (constructor cellsChanged → fireEdit defaults to it; fireOpen/fireEdit/fireSelectionChange default workbookId param to it) + `onRunReport` (invoked from runOne wrapper for every run — runMatching + tick + subscription, incl. refusals; try/catch exception-safe). Verified via grep.
- [core] host.ts: NEW `SessionTriggerHost` — scoped persistence (`${scope}::` prefix) + createTriggerStore(scoped), attach (detach-prev, TriggerRuntime{workbookId:scope, onRunReport:track}, re-apply persisted grants, beginPolling pollMs??1000), detach/attached/fireOpen, durable grant records under `icecream-sheets.trigger-grants.v1` in scoped persistence (grant throws on unknown id, upsert+persist+runtime apply; isGranted reads records only), management list/create (workbookId defaults to scope)/remove (drops grants+lastRun)/setEnabled (runtime when attached else store semantics), last-run tracking from onRunReport. Verified via ls/grep.
- [core] node.ts: exported `SessionTriggerHost`, `TRIGGER_GRANTS_KEY`, `SessionTriggerHostOptions`, `TriggerGrantRecord`, `TriggerLastRun`, `TriggerStatus` from automation/node.ts. Verified via grep.
- [core] tests/automationTriggerHost.test.ts: NEW — runtime workbookId/onRunReport tests (scoped fire via subscription, other-workbook no-fire, fireOpen defaulting, refusal+success observed, tick observed, throwing observer safe) + SessionTriggerHost tests (attach+granted fire, ungranted refusal→lastRun, grant persistence across new host, unknown-grant throw, scope isolation, detached create/list/remove/setEnabled persistence, attached setEnabled toggle, detach stops firing, workbook-scoped regression via host, fireOpen, re-attach detaches previous). Verified via ls.
- [core] Targeted suites PASS: `TMPDIR=~/workspace/tmp-triggers-w1 npx vitest run tests/automationTriggerHost.test.ts tests/automationTriggers.test.ts tests/metadataStore.test.ts` → 3 files, 47 tests passed (17 host + 17 triggers + 13 metadataStore).
- [core] tsc PASS: `npx tsc -p tsconfig.json --noEmit` exit 0 (noEmit used to honour "do not rebuild dist").
- [core] Full-suite attempt 1: hit my own 900s timeout cap at 73/~86 files under heavy parallel-track VM load (log ~/workspace/tmp-triggers-w1/full-suite.log). Green incl. automationTriggerHost (17/17) + automationTriggers (17/17); only failures were 5000ms test-timeouts in unrelated files (addons 3, agent-runtime 4, agent-guardrails 1) — verified nothing in src imports automation/runtime|node (agent/addons cannot be affected by this change). Relaunched detached with no cap (full2.log); isolated re-runs of any failing files to follow.
- [core] FULL SUITE (attempt 2, detached, log ~/workspace/tmp-triggers-w1/full2.log): Test Files 3 failed | 79 passed (82); Tests 3 failed | 1554 passed | 1 skipped (1558); duration 295.29s. automationTriggerHost 17/17 ✓, automationTriggers 17/17 ✓, metadataStore 13/13 ✓ (all post-final-edit). The 3 failures are ALL outside automation and NOT caused by this change: (1) agent-guardrails "over-cap answer()" — 5000ms test timeout (5113ms isolated too); (2) agentThreadPersistence "pending ask survives restart" — deterministic assertion mismatch on agent ask-budget message (agent src files are modified in-tree by the parallel planner-fix track; agent-guardrails.test.ts is untracked/new from that track); (3) sensitivity — isolated re-run PASSES 16/16 (full-run failure was a flake: random base64 ciphertext happened to contain the substring 'bob' asserted absent). Isolated re-run of the 3 files: 2 failed | 37 passed (agent ones persist, sensitivity green).
- [core] tsc re-verified after final edit (explicit `fireEdit(event.refs, this.workbookId)` in the subscription): `npx tsc -p tsconfig.json --noEmit` exit 0.
- [core] Scope hygiene: git status for my paths = only runtime.ts (M), node.ts (M), host.ts (new), automationTriggerHost.test.ts (new). No dist rebuilt by me (dist mtimes 11:54 UTC predate my edits; tsc ran --noEmit). No git push. progress.md untouched.

### Firestore trigger store (prod)

Status: IN PROGRESS (worker w5, 2026-10-22) — checkpoint protocol: notes appended after each landed piece.
- [coordinator, 2026-10-22 ~06:05 PDT] w5 died in a daemon restart AFTER landing all code (below) but BEFORE running tests. Coordinator took over directly (workers are dying within minutes): **extraKeys support LANDED by coordinator** in hostFirestore.ts — createTriggerScopePersistence(deps, scope, opts?: { extraKeys }) + createProdTriggerScopePersistence(env, scope, opts?) pass-through; extra keys hydrate as raw strings (absent = known-but-empty), are added to the known-keys set, and non-hydrated keys still throw. Purpose: the gateway supervisor's per-entry onOpen-fired record (`<fileId>::icecream-sheets.trigger-open-fired.v1`) rides the same facade. Tests APPENDED to tests/firestoreTriggerStore.test.ts (3: round-trip, unhydrated still throws, standard-key collision ignored). Test battery (firestoreTriggerStore + automationTriggerHost + automationTriggers + firestoreMetadata + metadataStore) running under TMPDIR=~/workspace/tmp-triggers-w5.
- [w5] Started: read BRIEF scope update + locked persistence design (write-through cache hydrated at attach, collection `icecream_trigger_metadata`, flush loud) + firestoreMetadata/secureStore/host/triggerSpecs/prod-config postures.
- [w5] Deliverable 1 LANDED: `TRIGGER_STORE_KEY = 'icecream-sheets.triggers.v1'` exported from automation/triggerSpecs.ts and used by createTriggerStore (additive). Also extended FirestoreMetadataPersistence with an optional collection parameter defaulting to MCP_METADATA_COLLECTION (MCP behavior identical) so the trigger store can use its own collection.
- [w5] Deliverable 2 LANDED: NEW automation/hostFirestore.ts — TRIGGER_METADATA_COLLECTION='icecream_trigger_metadata'; createTriggerScopePersistence hydrates AsyncMetadataStore<TriggerSpec> + AsyncMetadataStore<TriggerGrantRecord> (scoped keys, same serializers / JSON-array shape filtering), seeds the sync facade with the exact serialized strings, throws loudly on any unhydrated key, writes through on a tracked chain; flush() rejects with the original error and stays poisoned until a later write to the same key succeeds. prodTriggerConfig (fail-closed on missing GCP_PROJECT_ID) + createProdTriggerScopePersistence (non-literal dynamic import, FirestoreMetadataPersistence over the triggers collection, fail-fast startup probe) mirror prodMcpConfig/prodShareConfig.
- [w5] Deliverable 3 LANDED: packages/service/package.json exports `"./automation-firestore-node": "./dist/automation/hostFirestore.js"` (house subpath pattern; hostFirestore.ts is the subpath target and exports its symbols directly).
- [w5] Deliverable 4 LANDED (tests written, run pending): NEW tests/firestoreTriggerStore.test.ts — round trip (create+grant → flush → brand-new facade+host lists spec AND grant, granted trigger fires on a real EngineHost without re-granting), scope isolation, hydration honesty (unhydrated load/save/clear throw), failure loudness (flush rejects, poisoned second flush, later successful same-key write clears), 1 MiB cap via FirestoreMetadataPersistence with the triggers collection at the persistence layer directly (test names state this), triggers-vs-MCP collection selection, prodTriggerConfig fail-closed matrix + createProd fail-closed.
- [coordinator, 2026-10-22 ~06:27 PDT] TESTS RUN by coordinator: 5-file battery (firestoreTriggerStore incl. the 3 coordinator extraKeys tests + automationTriggerHost + automationTriggers + firestoreMetadata + metadataStore) = **68/69 pass**; the single failure (automationTriggers Python-trigger test) is a LOAD FLAKE — isolated re-run passes **17/17** (Python test 504 ms). Verdict: **Firestore trigger store COMPLETE** (fake-based; live-Firestore proof rides post-deploy verification, as scoped). The local/desktop file-backed path is untouched.

## Phase 1 — Product UI (list/create/enable/disable/delete + grant flow)

Status: IN PROGRESS (worker w4, 2026-10-22)
- [x] `apps/web/src/features/triggers.ts` LANDED (verified on disk): TriggerStatus/TriggerListResult types reusing service TriggerSpec/TriggerEvent/DeclaredPermission; TriggerTransport interface; GatewayTriggerTransport (raw fetch + gateway JWT per contract: GET list w/ ?fileId=, POST create {fileId,spec}, POST :id/enabled {fileId,enabled}, POST :id/grant {fileId}, DELETE :id?fileId=; server `error` strings surfaced verbatim via TriggerTransportError); DesktopTriggerTransport over window.icecreamDesktop.triggers bridge (no fileId); pickTriggerTransport (desktop bridge → gateway when fileId+client → null); parseTriggerRange via engine parseA1RangeRef + rangeToA1; per-event bare-sandbox templates (JS + Python action-collector) using live sync `api` + frozen `event`; default permissions in real vocabulary (cell.write on Sheet1!10,0, ui.notify on workbook).
- [x] `apps/web/src/components/TriggersDialog.tsx` LANDED (verified on disk): A11yDialog shell (role=dialog/aria/Esc via the shared primitive, mirroring ScriptEditor); list rows with name, event label, scope (rangeToA1 / sheet / whole workbook), enabled switch (role=switch), last fired, last-run outcome in plain language, grant state — ungranted shows "Its permissions haven't been granted yet, so it can't run yet" + Grant permissions button; create form (name, event select offering ONLY the list result's `events`, language, optional sheet + A1 range via parseTriggerRange, interval seconds→intervalMs for onInterval, datetime-local→atTimeIso for onAtTime, script textarea prefilled per event/language, permissions editor rows action/target/reason add/remove seeded from defaultTriggerPermissions); enable/disable + delete per row call the transport and refresh; transport errors surface as role=alert plain-language messages; null transport shows the honest "triggers need a hosted session" note.
- [x] Wiring LANDED: Ribbon.tsx — `onOpenTriggers` prop (following onOpenScriptEditor) + "Triggers" RibbonButton in the Extensions > Apps Script group. Dialog state lives in ribbonParity.tsx (where the onOpenScriptEditor pattern actually lives — App.tsx's ScriptEditor wiring is NOT in App.tsx; App passes `documentId: collabFileId` into useRibbonParity, already in place): `triggersOpen` state + `onOpenTriggers` handler + ribbonProps entry + `<TriggersDialog transport={pickTriggerTransport({ gatewayClient: getGatewayClient(), fileId: ctx.documentId })}>` render. Only ribbonParity constructs RibbonProps (verified by grep), so the new required prop breaks no other consumer.
- [x] Tests LANDED + PASSING (TMPDIR=~/workspace/tmp-triggers-w4): features/triggers.test.ts (15 tests — transport selection, gateway method/path/body/header shapes vs stub fetch, server error verbatim, desktop delegation, A1→RangeRef incl. reversed corners + round-trip, template sandbox shape, real-vocabulary defaults) and components/TriggersDialog.test.tsx (6 tests — list render w/ grant state + failed last-run, grant button → granted after refresh, switch → setEnabled + delete → remove, create submits contract payload interval 5s→intervalMs 5000 + event options == capability list, null-transport honesty note, A11yDialog role/Esc). 21/21 pass.
- [x] tsc (apps/web, run 2026-10-22 ~12:23 PDT under heavy parallel load): exit 2 with errors ONLY in the parallel workspace-settings track's files (FirebaseLoginButton.test.tsx / firebaseAuth.test.ts FakePort missing new FirebasePort methods, SettingsPanel.tsx) — ZERO errors in any triggers-track file (features/triggers.ts, features/triggers.test.ts, components/TriggersDialog.tsx/.test.tsx, ribbon/Ribbon.tsx, ribbonParity.tsx). An earlier run raced a service-dist rebuild and showed transient cross-package noise; the clean-resolution run is the one quoted here.
- [x] Full apps/web vitest suite (TMPDIR=~/workspace/tmp-triggers-w4): **147 test files passed, 1892 tests passed, 0 failed** (exit 0, duration 415s under load ~18 — includes the 21 new triggers tests).
Status: COMPLETE (UI deliverables 1–4)
Verdict: PASS — UI built to the REPORT.md HTTP contract exactly; live end-to-end proof remains with the Phase 1 live-validation section (needs the hosting surface live).

## Phase 1 — Live validation

Status: NOT STARTED
Verdict: —

## Phase 2 — Timed triggers (onInterval + onAtTime) hosting + UI

Status: NOT STARTED
Verdict: —

## Phase 2 — Live validation

Status: NOT STARTED
Verdict: —

## Suites / tsc

Status: DONE for the Product UI worker (see "Phase 1 — Product UI" for detail): new tests 21/21; full apps/web suite 147 files / 1892 tests all pass; apps/web tsc has zero errors in triggers-track files (remaining exit-2 errors are the parallel workspace-settings track's in-flight files).

## Case-9 verdict update

Status: CLOSED BY THIS PROGRAM (parent, 2026-10-22 ~09:40 PDT). The agent
validation's case 9 failed as a FAIL-GAP: no trigger surface existed. That
gap is now closed by construction + live proof: triggers are creatable,
grantable, and fireable through the product surface in both phases — the
Phase 1 live tour (26/26) covers create/grant/fire for onOpen + onEdit, and
the Scope-2 live proofs cover timed firing incl. closed-file self-open.
A formal re-run of case 9 through the agent harness was not part of this
program's scope; the capability it found missing is built and live-proven.

## Open items / honest gaps

- Prod trigger store: Firestore write-through bundle DONE (tests 23/23;
  supervisor prod wiring landed; service.yaml TRIGGER_STORE="prod").
  Live-Firestore proof rides post-deploy verification.
- Supervisor singleton consistency (prod, scaled-out service): named
  residual — see the persistence story above.
- onSelectionChange: not fireable in any shipped topology this pass
  (named follow-up seam in the design section).

## PIVOT — hosting point corrected (2026-10-22, coordinator, after gateway tests)

The supervisor + surface + tests were built on NodeRemoteEngineHost and the
first batteries ran: triggerSupervisor.test 5/5, automationSvc.test 4/4
(real-engine integration: granted onEdit fires on another principal's edit,
ungranted refused + visible, grant -> fires, disable -> no fire). BUT
integration probing exposed a semantic break in the remote-host path for
the SYNCHRONOUS AutomationApi the TriggerRuntime is welded to:

1. NodeRemoteEngineHost.execute() returns a pending Promise cast as a
   result; AutomationApi.setCell reads res.ok (undefined) and THROWS on
   every remote write — the write lands async, but the run reports
   failure and MULTI-WRITE SCRIPTS ABORT after the first write.
2. Sync reads on the remote view are cache-only: a cold read returns
   EMPTY silently — scripts compute on wrong data (Phase 2's motivating
   interval summary job would publish wrong numbers, silently).
3. Async write failures (engine authorize denials) are invisible to the
   run report; floating promises reject unhandled at teardown (observed
   as 10 unhandled errors in the surface test run).

The agent/add-on bindings avoid this because they use ASYNC tool
surfaces; nothing in the product runs the sync AutomationApi against a
remote host. Shipping the remote path would sign off on silently-wrong
script semantics — not acceptable.

CORRECTED HOSTING: the runtime attaches to the session's OWN in-process
EngineHost (engineSvc state.host), where events originate and execute is
genuinely synchronous. Design:
- engineSvc gains an ADDITIVE optional session hook in its listener deps:
  on session host (re)assignment it hands out a SessionHandle
  { sessionId, fileId, host, submitOp } where submitOp is the /ops
  composition (execute + journal append + revision) so trigger writes
  are ordinary sequenced, journaled ops broadcast like any client op;
  onSessionClosed on unload/replacement. A thin EngineHost subclass in
  the gateway routes the runtime's execute() through submitOp and
  delegates reads/subscribe/getView to the real host.
- The supervisor keeps: registry-driven CRUD + authorization + the
  persistence providers (file local / Firestore prod, unchanged) +
  fired-once onOpen keys. Its remote-attach machinery (mint/NodeRemote
  construction) is REMOVED; attach is driven by session handles.
  Locally the service-package process hosts engine + automation
  together, so hooks fire in-process. In prod the ENGINE services
  self-host: the engine entrypoint constructs its own supervisor +
  mounts the automation surface; the gateway owner-routes
  /api/automation/* by fileId (registry) to the live owner instance,
  falling back to the service family for files with no live session
  (detached CRUD against the shared store). TRIGGER_STORE rows
  therefore belong on the engine yamls AND stay on service.yaml
  (detached CRUD); single-writer-per-file holds because only the
  session-owning process attaches.
- Desktop unchanged (already in-process).
- New integration assertions required: multi-write script completes
  BOTH writes; a read-dependent script computes the right value;
  granted trigger's lastRun.ok === true.
- Residual (documented, accepted): lastRun is hosting-process memory;
  in prod it resets when an engine instance recycles. Specs, grants and
  fired-once keys are durable in the store.

The remote-path supervisor code + its two test files are superseded by
this design; the surface (automationSvc.ts), store bundle, UI and
desktop work are unaffected.

## PIVOT IMPLEMENTED + PROVEN AT UNIT/INTEGRATION LEVEL (2026-10-22 ~14:07 UTC)

- engineSvc.ts (additive only): EngineSessionHandle/EngineSessionHooks
  exported; EngineServiceDeps.sessionHooks; submitSessionOp = the /ops
  composition (enqueueSequenced + runExecuteInternal, envelope
  clientId 'automation-supervisor'); notifySessionHooks() deduped by
  (sessionId, fileId, host identity), called from registerSession,
  bindLoadedSession, fenceSession, evictSession, all three claim-route
  exits and the rehydrate route. Gateway tsc clean; no route behavior
  changes when hooks are absent.
- NEW packages/gateway/src/services/sessionSubmitHost.ts: EngineHost
  subclass — reads/events delegate to the live host (events filtered
  while an automation submit is applying, preserving the runtime's
  loop guard); execute() enqueues through submitOp stamped with the
  command's automation principal, optimistic sync result; rejected
  submits surface via onLateFailure → SessionTriggerHost
  .noteLateRunFailure (NEW, additive in service host.ts, together with
  refreshFromStore()); drain() for detach. Documented semantic: within
  one run a script reads the workbook as of run start; its writes
  commit in order through the sequencer.
- triggerSupervisor.ts rewritten: remote attach machinery DELETED
  (no NodeRemoteEngineHost, no token minting); noteSessionReady/
  noteSessionClosed drive attach; onOpen fired-once unchanged;
  CRUD/authorization/providers unchanged; attached hosts refresh from
  the store on an interval (cross-process CRUD pickup; the Firestore
  scope persistence gained refresh()).
- Hosting homes: bin/engine.ts constructs the supervisor (registry =
  createFileRegistry) + sessionHooks + mounts the automation surface
  under /api/automation on the engine port. servicePackage keeps its
  CRUD-only supervisor (no engine surface there). Gateway: bin route
  '/api/automation' (AUTOMATION_URL, default the service package) +
  owner-routing in the dispatch — a request naming a file with a live
  owner is proxied to the owner engine instance with the full path;
  the web transport now carries ?fileId= on every call so POSTs route
  too.
- Tests: triggerSupervisor.test.ts REWRITTEN (7/7): authorization,
  CRUD+flush, flush-failure, onOpen once-per-session across a
  supervisor restart + session change + close, REAL-EngineHost onEdit
  with read + multi-write + loop-safety (counter stops at 1) +
  lastRun.ok, file-less handles ignored, prod fail-closed.
  automationSvc.test.ts REWRITTEN (4/4): surface contract as before +
  the full integration over the REAL engine composition — onOpen at
  claim (write read back = 111), Bob's edit fires the granted marker
  (4242, lastRun.ok === true), the read+multi-write doubler computed
  C1=14 and D1=5 from A1=7, ungranted 'second' refused with a
  grant-named lastRun error and no write, grant → fires (777),
  disable → no fire. Engine log shows the trigger writes inside the
  session's journal flush (ops=18) and its autosave checkpoint.

## SUITES AFTER THE PIVOT (2026-10-22 ~14:20 UTC)
- Gateway FULL suite: 69 files / 929 tests ALL PASS (engineSvc hooks,
  supervisor rewrite, gateway owner-routing included).
- Service automation battery: 72/72 (incl. NEW: noteLateRunFailure,
  refreshFromStore cross-host pickup, Firestore refresh() re-hydration).
- Service FULL suite: 1,627 passed / 2 skipped / 3 failed — all three
  dispositioned NOT this track: sensitivity timing + artifacts
  recovery-timing pass 47/47 in isolation (load flakes during
  parallel dist builds); the agent-tools "structured file search"
  failure names a test that does not exist in the current tree (the
  agent/planner track's files are churning in flight).
- Web triggers tests 21/21 (transport URLs updated for ?fileId=);
  desktop triggers 7/7. Gateway + service tsc clean; dists rebuilt.
- Deploy: TRIGGER_STORE="prod" rows added to engine-standard.yaml +
  engine-xl.yaml (the supervisor's hosting home); service.yaml row
  kept (detached CRUD); CONFIG.md row updated to name both.
- LIVE VALIDATION NOTE: apps/web currently does not build —
  src/components/GatewayLogin.tsx has JSX syntax errors (TS1005/
  TS1381), modified 14:16 UTC by a parallel track (workspace
  settings/login); NOT a triggers file and not repaired here. The
  browser leg waits for that tree to build again; the
  production-topology HTTP tour proceeds on this track's own stack
  meanwhile.

## LIVE TOUR — PRODUCTION TOPOLOGY, ALL PASS (2026-10-22 ~14:33 UTC)
Isolated stack from THIS track's dists (gateway 8410, engine 8411,
service package 8412; shared data dirs under tmp-triggers-live;
signed engine access; dev-login JWTs). Script:
~/workspace/tmp-triggers-live/tour.mjs — 26/26 steps PASS:
logins; create file + load (engineUrl = the isolated engine);
release (checkpoint+evict); DETACHED create+grant of the onOpen
greeter through the gateway (served by the service package's
supervisor); re-open + client rehydrate → greeter stamp E1=111
present; live create of the onEdit marker through the gateway
(owner-routed to the engine process); bob joins the SAME session and
his /ops edit fires the marker (B1=4242, ack revision 2) with
lastRun {ok:true} read back through the gateway list; interval
trigger (10 s) stamped F1=555 on schedule; one-shot atTime (+30 s)
did not fire early and fired G1=888 at its time; disable → bob's
edit leaves B1=0; delete removes it.
Two findings fixed on the way: (1) the tour initially skipped the
client /session/rehydrate step after joining a released session —
the designed flow, not a product bug; (2) SUPERVISOR BUG (fixed):
the onOpen fired-marker was written even when no onOpen trigger
existed at attach, burning the greeting for triggers created later
in the same session — the marker is now written only when a run
actually happened; regression test added (gateway suite 930/930).
Suites: gateway FULL 930/930; service automation battery 72/72,
service full 1,627 passed with 3 dispositioned non-track failures;
web FULL 1,895/1,895; desktop triggers 7/7 + tsc clean.

### Scope update 2 — IMPLEMENTED (2026-10-22, post-pivot architecture)

Design mapping to the brief: (1) the tick endpoint is `POST /api/automation/tick` on the
service package's automation surface — `tickAuth.ts` verifies the Scheduler OIDC token
(RS256 against Google JWKS, cached; iss Google; exp; aud == TRIGGER_TICK_AUDIENCE;
email == TRIGGER_TICK_SA_EMAIL + email_verified; unconfigured → 503, bad token → 401 —
fail closed). (2) `TriggerSupervisor.tick()` scans the registry's files, applies the
runtime's exact due math (`dueTimedSpecs`: interval due when intervalMs elapsed since
lastFiredAt, never-fired = due; atTime due once when its time passed and never fired),
skips files with a live session (their attached runtime self-ticks) and self-opens the
rest. (3) Self-open: registry CAS claim (ownerInstance 'trigger-tick', 60 s lease) →
engine-access token minted for the file's CREATOR (engine still runs the script as
`automation:<name>` under the grant ledger — grants are never bypassed) → engine
`/session/claim` (rehydrates the checkpoint snapshot; a `pending` claim = no
checkpointed state → recorded failure + release, catch-up at first real open remains
the path for never-opened files) → the engine-side supervisor attaches via the session
hooks and its runtime fires the trigger → observed through the SHARED STORE's persisted
lastFiredAt (which is also the idempotency marker: a duplicate tick finds nothing due)
→ `/session/release` so the normal checkpoint persists the effects → CAS released.
Failures are recorded on the trigger's lastRun (new `SessionTriggerHost.recordRunFailure`,
creates-or-corrects) and in the tick summary returned to the caller. A concurrent tick
returns `alreadyRunning` instead of overlapping. (4) Catch-up semantics unchanged as
the fallback. (5) Deploy: `deploy/create-trigger-scheduler.sh` (idempotent rollout
script: creates SA icecream-trigger-tick@, grants it run.invoker on the service only,
sets TRIGGER_TICK_AUDIENCE/SA_EMAIL on the service — they depend on the service's own
URL, hence not in service.yaml — and creates/updates job `icecream-sheet-trigger-tick`,
"* * * * *", OIDC audience = the tick URL); service.yaml gains ENGINE_ACCESS_SECRET
(SM icecream-engine-signing-secret) for the tick's token minting; CONFIG.md documents
all three + the job. **JOB CREATION IS A ROLLOUT STEP OF THIS PROGRAM, NOT PART OF THE
IN-FLIGHT FIRST DEPLOY** (run deploy/create-trigger-scheduler.sh after the services are
up; it is listed here and in CONFIG.md as such).

Tests (all run by the coordinator): tickAuth 9/9 (local stand-in IdP: generated RSA
key + JWKS; valid/wrong-aud/wrong-SA/unverified-email/expired/wrong-iss/tampered/
malformed); supervisor tick 6/6 (fake engine: self-open+fire+release with the CAS
released and the store marker persisted, duplicate tick does NOT re-claim or re-fire,
interval on a closed file, live-session skip with zero engine calls, engine-refusal
recorded on lastRun + summary, pending-claim recorded, nothing-due left alone);
automationSvc 8/8 (4 contract + 4 tick endpoint: no token 401 + scan never runs, wrong
token 401, verified token 200 + summary, unconfigured 503); supervisor 8/8; service
host tests 20/20 (incl. the recordRunFailure test). Gateway tsc clean.

### Scope 2 live proof — ROUND 1 + probe refinement (2026-10-22 ~15:47 UTC) — VERIFICATION PARTIALLY OWED

Live tick tour #1 (`~/workspace/tmp-triggers-live/tick-tour.mjs`, isolated stack
relaunched on the rebuilt dists + a local JWKS IdP stand-in on 8420): the auth legs
all passed (no token 401, wrong-key 401, wrong-audience 401) and tick #3 — after the
lease had expired — proved the full self-open chain end-to-end: CAS claim → engine
claim/rehydrate → engine-side runtime fired BOTH counters exactly once (G1=1 interval,
H1=1 one-shot) → release checkpoint → parse-back of the saved library object row0 =
[1,2,null,null,null,null,1,1]. BUT ticks #1/#2 (seconds after the file's release)
reported the file as skippedLive: **a cleanly released session leaves its
file-registry lease standing until expiry** (the engine's release does not clear the
record in this topology — the same 30 s dead-man's-switch the Phase-2 owner-kill
semantics rely on), so lease-liveness alone over-reports for up to 30 s after any
release. With the production 1-minute Scheduler cadence that costs at most one tick
of latency, but the tick can do better safely:

REFINEMENT (implemented + unit-covered, live re-proof OWED): when the lease says
live, the tick probes the recorded owner engine's `GET /session/status` with a
creator-minted token — session proven released/gone → self-open proceeds; proven
active → skip; unreachable/ambiguous → skip (fail-safe), with the registry CAS claim
in selfOpenAndFire remaining the final guard against racing a real (re)open (a lost
CAS is reported as skippedLive, never a steal). A client joining during the seconds-
long self-open window rehydrates into the same sessionId; if the tick's release
lands after their join they see a release and re-rehydrate (the product's designed
flow). New unit tests: probe-released → fires; probe-active → skipped (claim never
called). OWED when work resumes: (a) re-run triggerSupervisor.tick.test.ts (8 tests
expected), gateway tsc, and the full gateway suite; (b) re-run tick-tour.mjs fresh —
expected all-pass with tick #1 firing via the probe path.

FULL GATEWAY SUITE (ran concurrently with the probe edits landing — started before
them): 69 files, 934 tests, 930 passed / 4 FAILED (identities not captured before
the run's output was truncated; the run also hit a provider rate-limit stop flagged
terminal for the attempt, so no re-run was made). The four failures are UNRESOLVED:
they may be mid-edit inconsistencies (the probe edits landed while vitest was
collecting) or real; the parent should re-run the gateway suite before pushing.
Standalone Scope-2 files were green immediately before the probe change (supervisor
8/8, tick 6/6, tickAuth 9/9, surface 8/8, service host 20/20; service automation
battery 72/72 pre-Scope-2; gateway tsc clean pre-probe).

### Supervisor posture — USER-CONFIRMED (2026-10-22 ~06:15 PDT, recorded 2026-10-22 ~15:55 UTC)

The user asked whether the supervisor is an always-running service and, on the
explanation given, explicitly CHOSE the scale-to-zero posture over an always-on
min-instances=1 service. Confirmed spec:
- NO deploy config change, NO min-instances work. All services keep scale-to-zero.
- The supervisor watches while its host service is awake; under scale-to-zero the
  watch sleeps when the service does. Post-pivot hosting topology (unchanged by
  this ruling): the runtime-hosting supervisor rides the ENGINE process (sessions
  live there; it attaches per session), detached trigger CRUD + the Scope-2 tick
  endpoint live on the SERVICE package (icecream-sheet-service). Either way the
  posture the user confirmed is the same: nothing is always-on for triggers.
- Catch-up semantics are the ACCEPTED SPEC for timed triggers (not a defect):
  a schedule whose time passes with no live session fires ONCE on next attach —
  never once per missed interval. (The Cloud Scheduler waker of Scope update 2
  usually fires it earlier via a self-opened session; catch-up is the fallback
  when no tick lands first, e.g. before the rollout creates the job.)
- A trigger sends NO notification: it runs its script as `automation:<name>`;
  writes land through the sequencer; the run outcome (lastRun ok/error/duration,
  lastFiredAt) is what the Triggers dialog shows.

Validation consequence: the Phase 2 live bar includes the exact catch-up case —
a timed trigger whose time passes while the file is closed fires exactly once
when the file is next opened (an interval trigger closed for several intervals
increments its counter by 1, not by the number of missed intervals).

### Scope 2 — VERIFICATION CLOSED (2026-10-22 ~16:20 UTC)

**Fencing defect found by live tour round 1/2 and FIXED.** The tick's original
self-open wrote its registry CAS claim with ownerInstance 'trigger-tick' BEFORE
the engine claim. The engine's ownership heartbeat (engineSvc §9) fences a
session whose record names another owner — it fenced the very session the tick
had just rehydrated (the fire only won the race against the 10 s heartbeat),
and a fenced engine then refuses all claims (409) until recycled. The fix
mirrors the GATEWAY's own claim discipline: (1) engine /session/claim FIRST,
(2) then the registry CAS naming THE ENGINE as owner (instance id + endpoint),
so the engine adopts the new epoch on its next heartbeat and its own release
clears the record at that epoch; a lost CAS releases the just-opened session
and reports skippedLive. (3) The instance id is resolved from the target
engine's /session/status — never trusted from the file's record (a record
poisoned by the old code, ownerInstance 'trigger-tick', fenced round 2 before
this landed). Regression-locked by two unit tests (CAS names the engine;
poisoned record still CASes as the engine via status resolution). Zero FENCED
lines in the engine log across the final full stack lifetime.

**Live proofs (isolated stack, rebuilt dists, local JWKS IdP stand-in):**
- tick-tour.mjs — ALL PASS (21 steps): no-token/wrong-key/wrong-audience ticks
  401; tick #1 self-opens the just-released file (status probe proves the
  session released despite its standing lease) and fires the interval counter
  (G1=1) with the one-shot NOT early; duplicate tick fires nothing; tick at the
  one-shot's time fires it (H1=1) + the interval again (G1=2); a second
  duplicate changes nothing; parse-back of the saved library workbook shows
  row0 = [1,2,null,null,null,null,2,1] — effects persisted by the release
  checkpoint.
- catchup-tour.mjs — ALL PASS (the user-confirmed catch-up spec, validated
  exactly): interval (8 s) + one-shot (+25 s) counters granted, file closed
  for 32 s with NO tick ever sent (~4 missed interval firings); on next open
  both fire exactly ONCE (G1=1, H1=1, identical lastFiredAt); an immediate
  second open re-fires nothing.

**Suites (coordinator-run):** gateway trigger files 34/34 (supervisor 8,
tick 9, tickAuth 9, automationSvc 8); service automation battery 118/118 +
Firestore trigger-store tests 23/23; gateway tsc clean. FULL gateway suite
with a JSON reporter: 940 tests, 938 passed, exactly 2 failed — both OUTSIDE
this track and reproduced in isolation: tests/userSettings.test.ts DELETE
/api/account (a tier record for the deleted user survives — the
workspace-settings track's deletion surface) and tests/services.test.ts agent
human-in-the-loop (10 s timeout — agent track). The earlier "4 failed" counts
were reporting artifacts (truncated logs across two runs). No triggers-track
failures anywhere.

Scope 2 is COMPLETE: endpoint + verifier, supervisor tick with gateway-
discipline self-open, deploy rollout script (job creation remains a ROLLOUT
step, not part of the first deploy), unit + live validation incl. closed-file
firing with parse-back, duplicate-tick idempotency, unauthenticated refusal,
and the catch-up fallback validated as the accepted spec.

### Correction to the full-suite disposition (2026-10-22 ~16:35 UTC)

The JSON-reporter run cited above (940 tests / 2 failed) evidently did not
collect tests/servicePackage.test.ts the same way: on the final source that
file had a third failure — "root health names the combined service + its
surfaces" expected the pre-triggers surface list, while the health endpoint
(correctly) also names 'automation', the surface this program mounted into
the combined service package. A stale expectation caused by THIS track.
Fixed: the expected services list in tests/servicePackage.test.ts now
includes 'automation'; the file passes 3/3. Corrected full-suite disposition:
the only remaining failures are the two other-track ones (userSettings
account-delete tier residual; agent HITL timeout).
