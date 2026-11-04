# Triggers Build — Brief

**Decision (user, 2026-10-22 ~04:42 PDT):** Build the triggers, as Icecream
suggested and the user approved — BOTH kinds, sequenced:
**Phase 1: edit/change triggers first** (with onOpen, same wiring), hosted and
with a product UI. **Phase 2: schedule triggers second** (interval + one-shot),
on the SAME runtime and the SAME UI. One runtime, one surface — not two systems.

**Record:** `hidden_files/triggers/REPORT.md` — create it FIRST (skeleton with
per-phase verdict sections), then append after each landed piece. Daemon
restarts are frequent: nothing counts until it is on disk. Do NOT touch
progress.md (the parent maintains it). Do NOT git push (the parent pushes).

## Why this exists

Agent validation case 9 (automation) is FAIL-GAP
(`hidden_files/agent-features/FINAL-REPORT.md`): the manual script leg works
live, but **no trigger surface exists anywhere in the product UI**
(`triggerUiFound:false`) and **the TriggerRuntime is hosted nowhere**. The
automation claim of the product is incomplete until a user can create a
trigger in the product and watch it fire.

## Design authority (read before building — AGENT.md §0)

`design-docs/automation-lane.md` is binding:
- §3 Event runtime: workbook/sheet events (on open, on edit, on selection
  change, timed triggers) fire inside the sandbox; handlers receive a frozen
  event object and mutate only through the automation API.
- §1 Permissioned automation API: every read/mutation goes through
  `authorize()`; scripts declare permissions; the user grants them once and
  the grant is recorded. No privileged scripting path.
- §5 Persistence: automation state persists through storage adapters;
  single-writer serialized execution where transactions are unavailable.
- §7 Agent boundary: the AI Agent acts through MCP tools, NEVER through the
  automation lane. Do not connect the agent to this runtime; do not let
  triggers invoke the agent.

## What already exists (verified by the parent in code, 2026-10-22)

- `packages/service/src/automation/triggerSpecs.ts` — `TriggerSpec` (events:
  `onOpen | onEdit | onSelectionChange | onInterval | onAtTime`; optional
  workbook/sheet/range scope; `intervalMs >= 1000`; `atTimeIso`; declared
  `permissions[]`; `lastFiredAt`), validation, migration, and
  `createTriggerStore()` over the service metadata store
  (key `icecream-sheets.triggers.v1`) — "the same rule that governs chart and
  pivot specs."
- `packages/service/src/automation/runtime.ts` — `TriggerRuntime` is BUILT:
  subscribes to the engine host's `cellsChanged` event and fires matching
  onEdit triggers; grant discipline (scripts run as principal
  `automation:<trigger-name>`; a run is REFUSED unless every declared
  permission has been granted via `grantTriggerPermissions()`); re-entrancy
  guard (`firingDepth` — a trigger's own writes do not re-fire triggers, the
  Excel `Application.EnableEvents=false` semantics; the writes still land);
  synchronous single-writer execution; `addTrigger/list/get/remove`,
  polling for timed triggers.
- The manual script leg (user scripts through the same automation API) works
  live — case 9 evidence.

**Do not rebuild the runtime.** The work is hosting + UI + validation, plus
whatever small gaps the hosting honestly exposes.

## The gaps to close

### Gap 1 — Hosting (Phase 1 and 2 share this)

No production host constructs a `TriggerRuntime` against a LIVE engine
session. Determine the correct host point from the design docs and the
existing patterns (the gateway's agent/add-on bindings wrap the live engine
session — `NodeRemoteEngineHost`, `agentSessionResolver`,
`addonEngineBinding` — study how they obtain a host for a session, and how
the desktop local mode hosts its engine in the main process):

- Host the runtime wherever the live session's engine events are observable,
  for BOTH topologies the product ships: gateway/service mode (the deployed
  topology) and desktop local mode. If one topology genuinely cannot be
  hosted in this pass, say so explicitly in the report with the reason —
  never fake it.
- One runtime instance per live session/workbook; dispose it with the
  session (subscription + polling timer). Trigger fires must observe the
  same op stream the revision model sequences (op application order), so an
  edit by ANY client of the session fires the trigger, not just the
  trigger owner's client.
- Persistence: trigger specs live in the metadata store per
  triggerSpecs.ts. State the prod persistence story explicitly in the
  report: which store backs `createTriggerStore` at the host point, and
  whether specs survive a Cloud Run instance restart. If the honest answer
  needs the async/Firestore seam (as MCP did), wire it or file it as a
  named follow-up with the exact seam — do not silently ship in-memory-only
  persistence for the deployed topology.
- Event coverage honesty: `onEdit` and `onOpen` must genuinely fire in the
  hosted topology. `onSelectionChange` is client-side state — in gateway
  mode selection lives in the browser and never reaches the engine event
  stream; wire it only where a real event source exists (local/desktop),
  and document the topology difference in the report and the UI (the UI
  must not offer an event the current topology cannot fire). Timed triggers
  (Phase 2) need a clock owner while a session is live; state what happens
  to a schedule trigger when no session is open (fires on next open?
  missed — with `lastFiredAt` making the behavior auditable). Pick the
  behavior the design doc supports and document it.

### Gap 2 — Product UI (the case-9 surface)

A Triggers surface in the web app (and therefore desktop, which loads the
same build), reachable from the open workbook:

- List the open workbook's triggers: name, event, scope (sheet/range),
  enabled state, last fired, last run outcome.
- Create: name, event (only events the current topology can fire — see
  Gap 1), optional sheet/range scope, script (JS or Python per spec),
  declared permissions.
- Enable/disable, delete.
- Permission grant flow: the runtime refuses ungranted triggers — the UI
  must surface that state and offer the grant (recorded per §1). A trigger
  that cannot run must say why, in plain language.
- Follow the existing Automation UI patterns in the app (script editor /
  automation panels) — reuse components; do not invent a parallel UX.
- Accessibility: WCAG 2.2 AA like the rest of the app (labels, focus,
  keyboard).

## Phase order

1. **Phase 1:** hosting for `onEdit` + `onOpen`, UI create/list/enable/
   disable/delete + grant flow, live proof (below). This closes the case-9
   claim.
2. **Phase 2:** timed triggers (`onInterval`, `onAtTime`) hosted on the same
   runtime + same UI. Motivating jobs to prove live: (a) refresh a live
   data source on an interval; (b) a periodic report/summary write at a
   scheduled time (short interval/one-shot for the proof).

## Validation bar (both phases)

- Unit/integration tests for the hosting wiring and the UI, in the
  established styles; affected suites green; tsc clean. No stubs.
- LIVE end-to-end on an isolated local stack (production topology; your own
  ports — never the shared 8100 stack, never any dist another track is
  serving; TMPDIR under ~/workspace):
  - Create an onEdit trigger IN THE UI → edit a cell in the browser → the
    trigger fires → the script's write is read back from the engine and
    visible in the grid. Screenshot each step; inspect them yourself.
  - A second browser/client's edit also fires it (session-level, not
    client-level).
  - Disable → edit → no fire. Re-enable → fires again.
  - Ungranted trigger → run refused, UI says why; grant → fires.
  - Self-write loop safety: a trigger that writes its own trigger range
    does not recurse (firingDepth guard) — the write lands, no runaway.
  - Phase 2: an interval trigger (seconds-scale for the proof) fires on
    schedule and lands its write; a one-shot atTime trigger fires once.
- Update the case-9 verdict in the report (the parent updates progress.md).

## Constraints

- Do not disturb: the running deploy, the shared 8100 stack, other tracks'
  isolated stacks or dists. Land files atomically — a deploy coordinator
  builds images from this tree in parallel.
- The automation lane's rules are not negotiable: no privileged path, all
  mutations through the permissioned API + `authorize()`, grants recorded,
  agent boundary (§7) intact.
- Build order inside the work: related tests during the build; screenshot
  validation after; full affected suites before declaring done.

## Scope update (user, 2026-10-22 ~05:39 PDT) — prod Firestore trigger store is IN SCOPE

The hosting design's persistence story named a follow-up: on Cloud Run
the supervisor's disk is instance-local, so trigger specs + grant
records would survive only for an instance's lifetime. The user has
ruled that a documented-only follow-up is NOT sufficient — **the
Firestore-backed trigger store must be BUILT as part of this program**
(the same standing ruling as the other prod adapters: a feature broken
in production is a blocker in principle). Concretely:

- Build the async trigger store at the seam the design already named:
  `AsyncMetadataStore<TriggerSpec>` (packages/service/src/secureStore.ts)
  over `FirestoreMetadataPersistence`
  (@icecream-sheets/service/firestore-node), its own collection in the
  family naming style; grant records persisted the same way.
- The runtime consumes a synchronous MetadataStore today: bridge
  honestly — either widen the runtime's store interface to the async
  seam, or hydrate a write-through cache at attach (reads local,
  writes through to Firestore, failures loud). State the chosen
  mechanism and its consistency story in the report. No silent
  in-memory-only prod path; no silent local fallback (fail closed,
  like the other prod stores, when the project/client is missing).
- The supervisor's prod wiring selects the Firestore store when
  configured (env posture mirroring MCP_STORE=prod / SHARE_STORE=prod)
  and the file-backed store otherwise; deploy config rows (service
  yaml + CONFIG.md) if the supervisor's service needs them.
- Tests: fake-based in the established style (round trip; grant
  persistence across a simulated instance restart — a new host over
  the same store; cap/failure loudness). The live-Firestore proof
  rides the post-deploy verification, like every other prod adapter.
- Sequencing: lands with the hosting work, before this program's final
  sign-off. The local/desktop file-backed path is unchanged.


## Scope update 2 — Cloud Scheduler waker for time triggers (USER APPROVED 2026-10-22 ~06:46 PDT)

The user asked whether GCP has its own scheduling mechanism and approved adopting it: **Cloud Scheduler wakes the service so time triggers fire AT their time, even with the file closed.** This extends (does not replace) the scale-to-zero posture ruling: the service still scales to zero; Scheduler is the alarm clock. Phase 2 scope is now:

1. **One scheduler job, not one per trigger.** A single job named `icecream-sheet-trigger-tick` ticks every 1 minute and calls an authenticated tick endpoint on the service package. Per-user/per-file jobs are explicitly rejected (they multiply against project quotas and duplicate the trigger store's job).
2. **Tick endpoint.** On the service package (same family as `/api/automation`); accepts ONLY Cloud Scheduler's OIDC-authenticated call (verify the token's audience + the scheduler service account identity; fail closed otherwise — an unauthenticated tick endpoint is a finding, not a feature). Fast no-op when nothing is due (one store scan).
3. **Due-scan + firing.** The supervisor scans the trigger store for due timed triggers (`onInterval` due, `onAtTime` reached), with the existing `lastFiredAt` discipline: fire ONCE per due time. Scheduler delivery is at-least-once — firing must be idempotent (the fired marker is persisted as part of the run record, the same discipline as the persisted onOpen-fired map); a duplicate tick must never double-fire.
4. **Self-session firing.** If the file has a live session, fire through the attached runtime as today. If NOT, the service opens its own programmatic session (registry claim + engine load via the same NodeRemoteEngineHost path the supervisor already uses; transport token minted for the file's creator; scripts still execute as `automation:<name>` under the grant ledger — Scheduler changes WHO WAKES the runtime, never the permission model), runs the trigger, lets the normal checkpoint/save persist, and releases the session cleanly. A failed self-open or run is recorded on the trigger's lastRun like any other failure.
5. **Catch-up semantics remain** as the fallback for any gap (service unavailable past a due time): fire once on next attach/tick, never once per missed interval.
6. **Deploy artifacts.** The job definition + creation step are documented/scripted in `deploy/` alongside the other one-time resources. The in-flight FIRST deploy does NOT create the job (trigger hosting is not in that build); job creation is a named rollout step of THIS program and must be listed in REPORT.md as such.
7. **Local validation required:** on the local stack with short intervals — an `onAtTime` trigger ~1 minute out fires with NO client connected and its effect is in the saved file (parse-back proof); an `onInterval` trigger fires on schedule while closed; a duplicate tick does not double-fire; an unauthenticated tick call is refused. Record evidence in REPORT.md.
