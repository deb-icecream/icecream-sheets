# Cycle 10 Closure — W4: Autosave / Save Interlock with In-Flight Routed Edits

Date: 2026-10-20 · Worker: W4 · Repo: ~/workspace/icecream-sheets
perf-evaluation.md / progress.md / TODO.md NOT edited. No GitHub push.

## 1. The gap (as assigned, parent-verified)

App.tsx's autosave effect was gated on `saveState` / `readOnly` /
`workbookLoaded` only. Local-route calc is synchronous, so a timer cannot
interleave mid-calc (safe by construction) — but during a SERVER-routed
edit awaiting its ack (and, on desktop, during an IPC edit awaiting the
main-process reply), autosave or a manual save could fire and serialize
provisional / pre-edit state, then clear the dirty flag on top of it.

## 2. Design — what signal was consumed / added

**Consumed (existing, no new state invented for cell edits):**
`OptimisticEditSession` (apps/web/src/services/routedEdit.ts) already was
the source of truth for in-flight cell edits (`hasPending()`, ops live
from `begin()` until `confirm()`/`reject()`). It was extended ADDITIVELY
only (W3 owns the routing/checksum regions of this file; none were
rewritten):
- `pendingCount` getter
- `subscribePending(listener)` — notified on begin/confirm/reject
- `whenSettled()` — resolves when the pending count reaches zero

**Added (new file, host-agnostic):** `apps/web/src/services/saveInterlock.ts`
- `EditInFlightTracker` — a counting in-flight tracker (`beginEdit()` with
  idempotent end handles, `track()`, `subscribe()`, `whenEditsSettle()`).
  Needed because structural / non-cell commands never enter the session,
  yet are still routed executes whose ack a save must wait for.
- `EditFlightSource` + `editFlightSourceOf(host)` (duck-typed) +
  `hasInFlightEdits(host)` + `waitForEditsToSettle(host)` (loops until a
  genuinely idle moment — an edit beginning while a prior batch settles
  is also awaited) + `serializeWhenSettled(host, serialize)` — the
  deferred-save primitive: serialize runs exactly once, after settle,
  so it always sees post-edit state.

**Host wiring (additive):**
- `RemoteEngineHost` (remoteEngine.ts): a private `EditInFlightTracker`
  wraps EVERY `executeRoutedAsync` (the public method now delegates via
  `editFlight.track(...)` to the unchanged inner implementation), so the
  in-flight window covers transport + ack-value fetch + view seeding —
  including the tail after the session confirms. New public surface:
  `hasInFlightEdits()` (= tracker ∪ session), `editInFlightCount`,
  `subscribeEditFlight()`, `whenEditsSettle()`.
- `IpcEngineHost` (ipcEngine.ts, desktop): a private `EditInFlightTracker`
  counts every `execute()` until its IPC round-trip settles (success,
  denial, or transport failure; a synchronous bridge-missing throw ends
  the count immediately and rethrows, preserving the existing contract).
  Same public surface: `hasInFlightEdits()`, `editInFlightCount`,
  `subscribeEditFlight()`, `whenEditsSettle()`. `executeAsync` rides
  `execute()`, so it is counted exactly once.
- The plain local `EngineHost` is synchronous — no in-flight window
  exists — so it exposes no signal and every wait is a no-op for it
  (proven by test).

**Bug found by the new tests, fixed in this pass:** the first cut of
`RemoteEngineHost.whenEditsSettle()` raced the tracker promise against
the session promise; for a structural edit (tracker busy, session idle)
the session promise is already resolved, so the wait loop spun in
microtasks and OOMed the test worker (~2 GB in ~20 s). Fixed: each loop
iteration awaits ONLY the sources that are actually busy (their settle
promises resolve exclusively at zero), via `Promise.all`. The structural
test in saveInterlock.test.ts is the regression cover for this too.

## 3. Where the deferral lives

### App.tsx (web + desktop branches — one App serves both)
- `awaitEditsSettled()` callback (= `waitForEditsToSettle(host)`),
  defined next to `ensureSaveSnapshot` with the full design comment.
- **Choke point:** `ensureSaveSnapshot()` awaits the interlock FIRST —
  every in-tab serialization path (desktop Save/Save As, local library
  save, named-range download fallback, email fallback, encrypted
  download fallback) funnels through it.
- **Gateway server-serialized paths** (the server serializes its LIVE
  workbook, so the edit's write-through must have landed there first):
  `fetchServerWorkbookBlob`, `fetchServerExportBlob`, and
  `saveWorkbookToServerLibrary` each await the interlock right after
  the existing `workbookLoaded` gate. `saveWorkbookToServerLibrary` is
  both the manual library save AND the gateway autosave path.
- **Manual saves (explicit at the handler, defense-in-depth over the
  choke points):** `handleDesktopSave`, `handleDesktopSaveAs`, and
  `handleLibrarySave` await the interlock before doing anything — the
  click is honored, just after settle, with post-edit bytes. The web
  manual save (Ctrl+S / File ▸ Save → download dialog →
  `handleConfirmDownload`) defers via `fetchServerExportBlob` /
  `ensureSaveSnapshot`.
- **Autosave (web library path AND desktop native-path path):** the 2 s
  debounce timer is unchanged; when it fires it now awaits
  `awaitEditsSettled()` BEFORE flipping to `'saving'` or serializing —
  the save then runs immediately after settle (no second debounce).
  The dirty flag is never touched during the deferral: the workbook
  stays `'dirty'` until the deferred save actually lands, and if
  another edit is in flight when the save completes, the completion
  path re-checks `hostHasInFlightEdits(host)` and stays `'dirty'` so
  the effect re-arms and saves again after that edit settles. Desktop
  autosave (GAP-2 branch, trusted path only) got the identical
  treatment — that is the desktop autosave cover.
- **No existing gate weakened:** `workbookLoaded` save/edit/export
  gating, `readOnly`, GAP-10 trusted-path skipping, the dialog-cancel
  stays-dirty behavior, and the server-wins divergence behavior
  (HYBRID-CONSISTENCY.md §2/§3) are all byte-for-byte untouched; the
  interlock only ADDS a wait in front of serialization.

## 4. Tests

New suite: `apps/web/src/services/saveInterlock.test.ts` (10 tests):
- `tracker: counts edits, settle waiters fire only when the LAST edit ends`
- `tracker: track() holds the count across resolve AND reject`
- `session: pendingCount / subscribePending / whenSettled follow begin→confirm`
- `hosts without an async edit path are no-ops (local host is synchronous)`
- **`AUTOSAVE REGRESSION: a save scheduled during an in-flight
  server-routed edit does NOT serialize until the edit settles — then
  serializes the POST-edit state`** — RemoteEngineHost over a gated
  fake transport backed by a real engine: edit A1 1→5 held in flight;
  save scheduled mid-flight stays un-serialized across ticks (spy
  silent, dirty-equivalent save promise pending); gate released; save
  fires immediately after settle capturing A1 input 5 and dependent
  B1 = 6 (post-edit), exactly once.
- `MANUAL SAVE: a save requested mid-flight defers the same way (not
  dropped, not early)` — same shape, A1 = 9 / B1 = 10.
- `a REJECTED edit still releases the deferred save — serializing the
  confirmed (rolled-back) state` — A1 = 1 / B1 = 2; deferral never
  drops the save even when the edit fails.
- `whenEditsSettle also covers structural commands (never in the session)`
- `no edit in flight → saves proceed immediately (normal path unimpeded)`
- **`AUTOSAVE (desktop): serialization defers while an IPC edit is in
  flight, then runs with the post-edit state`** — IpcEngineHost over a
  gated mock bridge; optimistic value 42 is already displayed
  mid-flight (exactly what a naive save would have persisted), the
  deferred save stays silent, then resolves with the post-edit 42
  after the round-trip settles.

Results:
- Related suites: saveInterlock (10) + routedEdit + remoteEngine +
  ipcEngine + bulkReads = **58/58 green**.
- Full web suite: **119 files / 1549 tests, all green** (includes the
  10 new tests; baseline in MEMORY.md was 1533).
- Desktop suite (apps/desktop): **14 files / 96 tests, all green**.
- `npx tsc --noEmit` in apps/web: clean.

## 5. Runtime validation

- Rebuilt apps/web/dist in the gateway flavor
  (`VITE_GATEWAY_URL=http://127.0.0.1:8100 npm run build` — tsc + vite,
  clean) and restarted the preview on :4173 (new pid written to
  /tmp/gwlogs/web.pid); the served bundle is the new build
  (`index-Dm_Qaq_Y.js`, contains `whenEditsSettle`). Gateway :8100 and
  engine :8101 health OK.
- Light browser sanity (headless Chromium via the repo's playwright
  harness, scripts in hidden_files/pw2/w4-sanity.mjs +
  w4-sanity2.mjs): logged in as the test user `e2e-tester` (per
  e2e-gateway.sh), opened perf-p50.xlsx — 21 sheets, load banner
  cleared at 100% — edited ASSUMPTIONS cell-8-2 (2026 → 424242):
  value committed, status flipped to "Unsaved changes", then Ctrl+S →
  download dialog → server download of workbook.xlsx succeeded, no
  error banner, no page errors. This is the normal no-edit-in-flight
  path: save/autosave behavior is unimpeded when nothing is in flight.
  (Note: a file dropped into the web app has no library entry, so web
  autosave has no target for it — pre-existing behavior, unchanged;
  autosave deferral itself is covered by the unit regression above
  plus the gateway library path in §3.)

## 6. Files changed

- NEW `apps/web/src/services/saveInterlock.ts`
- NEW `apps/web/src/services/saveInterlock.test.ts`
- `apps/web/src/services/routedEdit.ts` — additive session signal only
  (pendingCount / subscribePending / whenSettled + notify calls in
  begin/confirm/reject); no W3 regions rewritten.
- `apps/web/src/services/remoteEngine.ts` — additive tracker field,
  interlock accessors, executeRoutedAsync wrap (inner body unchanged).
- `apps/web/src/services/ipcEngine.ts` — additive tracker field,
  interlock accessors, execute() counting (handlers unchanged).
- `apps/web/src/App.tsx` — `awaitEditsSettled` + interlock awaits in
  ensureSaveSnapshot, the three gateway save fns, both manual-save
  handler groups, and both autosave timer branches (+ post-save
  stay-dirty recheck). No gate removed or loosened.
