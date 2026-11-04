# Worker B — Web Client (Phase 2 co-authoring) — build report

Scope honored: `apps/web/**` only. No `packages/*`, no `apps/desktop`,
no progress.md/TODO.md/perf edits, no git push, no stack restarts, no
node processes killed.

## Stack state at build time

Ports :8100 (gateway), :8101 (engine), :4173 (preview) were ALL DOWN
when checked (before and after the build; `curl` → 000). Per tasking I
did not restart anything (the server worker owns restarts) and relied
on unit tests + `tsc` + `vite build`. The §10 multi-browser matrix
against `dist` on :4173 is therefore NOT RUN by this worker — it is
the coordinator's gate once the stack is up.

## Files changed

| File | Change |
|---|---|
| `apps/web/src/services/collabTransport.ts` | NEW — the Phase 2 transport (below) |
| `apps/web/src/services/collabTransport.test.ts` | NEW — 10 tests |
| `apps/web/src/services/gatewayClient.ts` | `openFile()` + `EngineOpenResult` (join handshake) |
| `apps/web/src/services/remoteEngine.ts` | collab attach (polling gate, /ops routing), `applyDeltaCells`, `applySessionEvent`, `resyncToCurrentState`, `startPolling`/`stopPolling` |
| `apps/web/src/services/remoteEngine.test.ts` | +3 Phase 2 tests (polling gate, delta apply/hidden, /ops envelope routing) |
| `apps/web/src/collab.ts` | broadcast/presence wiring, remote-participant merge, `ingestRemoteDelta` |
| `apps/web/src/collab.test.ts` | +3 Phase 2 wiring tests |
| `apps/web/src/Grid.tsx` | `remoteSelections` prop → colored outline + name tag on remote cells |
| `apps/web/src/App.tsx` | transport lifecycle, join handshake in open/New flows, `#file=` plumbing, header avatars + fileId chip, rejected-ops banner, server-status → Saving…/Saved, bridge identity |

## How each contract piece is implemented

### collabTransport.ts (new)
- **Identity**: `clientId` minted once, persisted at localStorage
  `icecream.clientId` (`getOrCreateClientId`). Per-file durable state
  at `icecream.collab.<fileId>`: `{queue:[{clientSeq, cmd, baseRev,
  enqueuedAt}], rejected:[…], clientSeq, lastAppliedRev}`, reloaded on
  every `connect(fileId)` — queue durability across reload is tested
  by constructing a second transport over the same storage.
- **Connect**: `gateway.openFile(fileId?)` → binds
  `{engineUrl, sessionId, accessToken, revision, role, joined}` →
  `EventSource ${engineUrl}/deltas?access_token=<token>`. All engine
  HTTP (`/ops`, `/revisions`, `/presence`, `/deltas/ack`) goes direct
  to that engineUrl with the token as Bearer — the gateway is not in
  the data path.
- **Hello**: no stored rev → adopt hello revision (initial state came
  via the load stream); stored < hello → `catchUp(stored, hello)`;
  stored > hello → full re-stream. After hello: state `connected`,
  presence timers start, durable queue flushes IN ORDER.
- **Catch-up**: `GET /revisions?from&to`, entries applied strictly in
  order (a non-contiguous entry aborts to re-stream rather than
  skipping); HTTP 409 → `resync()` — the host adapter replaces ONLY
  the confirmed layer; the queue is never touched by resync (asserted
  in test: queue length is still 1 at the moment resync runs).
- **Delta apply**: `rev <= lastApplied` ignored; `rev == lastApplied+1`
  applied via `host.applyDeltaCells` (confirmed layer); gap → held +
  catch-up, then held deltas drain in order. Own-origin deltas
  (`origin.clientId == own`, matched by `clientSeq`) ack the queue:
  entry removed, waiter settled, `onAck` fired. POST `/deltas/ack`
  after each applied delta (retention input, best-effort).
- **Status events** → stored + `onStatus` callback (App maps to
  Saving…/Saved, server-reported only, with the same in-flight-edit
  race guard the Phase 1 autosave poll uses).
- **Presence events** → participants store + `onParticipants`.
- **Session events** → `host.applySessionEvent` (same handlers poll
  used); `kind:'fenced'` triggers the drop/reconnect cycle (§9).
- **Reconnect**: EventSource error → `reconnecting`, exponential
  backoff 1s→10s cap; every attempt re-runs `gateway.openFile(fileId)`
  — stale engineUrl/token are never reused (tested: second connect
  lands on engine-2/tok-2); on hello, catch-up runs first, then the
  queue resubmits in order with `baseRev` refreshed to
  `lastAppliedRev` (content never modified — asserted byte-equal cmd).
- **Presence send**: `sendPresence` debounced 250ms → POST `/presence
  {sheet,row,col,editing}`; 10s heartbeat re-send while connected;
  `leavePresence()` via `navigator.sendBeacon` to
  `/presence/leave?access_token=…` on `pagehide`.
- **Ops submission**: `submitCommand(cmd)` assigns
  `clientSeq = ++counter` (persisted), `baseRev = lastAppliedRev`,
  persists the entry BEFORE posting, POSTs `{engineUrl}/ops
  {clientId, clientSeq, baseRev, cmd}`. Resolution paths: /ops ack →
  entry removed, promise resolves with the ack; own delta → same
  (idempotent double-ack); `{rejected:true, reason}` (or 403) → entry
  moved to the retained `rejected` list, `onRejected` fires, promise
  resolves `{ok:false, error: reason}` so routedEdit performs its
  visible rollback; transport failure → entry stays queued, reconnect
  cycle starts, promise settles on the post-reconnect flush.
- **Bridge submit**: `submitBridgeOp(op)` converts a CollabOp to an
  EngineCommand (`collabOpToCommand`: cell.set/clear, sheet.add) and
  submits via /ops — but ONLY when `bridgeSubmitEnabled` is true. When
  the transport is attached to RemoteEngineHost the flag is set false:
  bridge edits execute on the host, whose routed pipeline already
  submits through `submitCommand`, so a second submission would
  double-apply. See "Decisions" below.

### gatewayClient.openFile
`POST /api/engine/open` with `{fileId?, name?, role?, cellCount?}`
(string shorthand accepted), returning the contract's identical
join/create shape (`EngineOpenResult`, incl. `ownershipEpoch`).
Throws on 503 (registry fail-closed) via the existing `call` path.

### RemoteEngineHost
- `attachCollabTransport(t)`: stops the polling interval AND `poll()`
  itself early-returns while a transport is attached — zero `/events`
  requests in gateway+SSE mode (tested with a 5ms poll interval:
  calls freeze at attach, resume at detach). Local in-process mode
  untouched (it never uses this host).
- Routed edits: `executeRoutedAsyncInner`'s `serverExecute` now goes
  through `collabTransport.submitCommand` whenever the transport is
  bound to a file session; otherwise the Phase 1 proxied execute.
  Optimistic display, server-wins ack comparison, and visible rollback
  are unchanged (routedEdit.ts itself needed no changes — its
  `serverExecute` dep was the seam). Undo/redo flow through
  `host.execute` as before, i.e. through the same /ops path; own ops
  only (unchanged behavior).
- `applyDeltaCells(cells, meta)`: seeds the view read cache with
  authoritative values/formulas (the view's optimistic overlay keeps a
  provisional own edit displayed until its ack — §8 layering), mirrors
  value/formula into the local mirror when present + in sync (mirror
  marked out-of-sync on any apply failure), clears the snapshot cache,
  emits `recalcComplete`. `{hidden:true}` cells seed EMPTY — a hidden
  value never lingers in this tab.
- `applySessionEvent`: `structure`/`load` → refresh sheet names +
  clear read caches + repaint; `reset`/`release` → host reset event.
- `resyncToCurrentState`: drops view + snapshot caches, marks the
  mirror out-of-sync, re-pulls the authoritative snapshot + sheet
  names (values re-stream through the bulk read path).

### CollabBridge (collab.ts)
- Constructor `onBroadcast` option + `setBroadcastHandler` — the
  session's broadcast hook delegates to the CURRENT handler.
  **Bug fixed**: `attach()` used to recreate the CollabSession with NO
  options, silently dropping any broadcast wiring on every re-attach;
  it now rebuilds via a factory that preserves the handler (tested).
- `setPresenceSendHandler`: `heartbeatSelf` now also sends presence
  OUT through the transport (the existing App effect on
  selection/sheet change therefore drives POST /presence).
- `setRemoteParticipants` + merged `collaborators()` (remote
  participants from SSE presence; self never duplicated).
- `ingestRemoteDelta(op, principal)`: appends the delta's op to the
  revision log for the changes UI WITHOUT executing it on the host
  (transport already applied the cells) and WITHOUT re-broadcasting
  (ingest guard flag). `applyRemote` (direct op receive + execute) is
  unchanged.

### App.tsx
- One CollabTransport per RemoteEngineHost (gateway mode only),
  created in an effect, attached to the host, wired to the bridge
  both ways; cleanup detaches (polling restores for the next host).
- Bridge identity: clientId = the transport's persisted
  `icecream.clientId`, principal = the gateway JWT principal — op
  envelopes, presence, and the log now name the same client (was a
  per-mount `web-<timestamp>` + 'You').
- Open flow (`openRemoteBuffer`): join handshake
  (`transport.connect(fileId?)`) runs BEFORE the load; on success the
  returned fileId is stored in session state + URL hash `#file=`.
  Handshake failure logs a warning and the Phase 1 load proceeds (the
  server half of /api/engine/open may not be live yet — coordinator
  integration owns the live path). `handleNew` (gateway branch) mints
  a fresh fileId/session the same way after reset.
- `#file=` at startup: the transport effect performs the join
  handshake, pulls the snapshot for sheet names, notifies host
  replacement, and unlocks — instead of waiting for a fresh upload.
- Disconnected UI: transport `reconnecting` drives the EXISTING
  `sessionDisconnected` state (StatusBar "Disconnected" + Reconnect
  button + edit gate); the Reconnect button now prefers
  `transport.reconnectNow()` when the drop was transport-side.
  `connected` clears it.
- Save status: SSE `status` events set Saving…/Saved from
  `{revision, storedRevision, saving}`.
- Presence UI: header avatar row (initials + per-principal color,
  `title=principal`) fed by the presence channel, plus a 🔗 fileId
  chip (the share link target). Grid receives `remoteSelections`
  (all participants except self).
- Rejected ops: banner above the grid listing each retained rejected
  op (reason + command), per-entry dismiss (the only way a retained
  input leaves the list). Rejection also sets the status-bar error.
- NO overwrite notifications were added anywhere (silent ruling).

### Grid.tsx
`remoteSelections` prop: for each participant on the CURRENT sheet, an
absolutely-positioned div inside the grid's scrollable content
(scrolls/clips with the cells, like overlays) — 2px outline in the
participant's color + a small name tag (principal, `✎` when editing).

## Tests

```
cd apps/web && npx vitest run <related>
  src/services/collabTransport.test.ts   10 passed (new)
  src/services/remoteEngine.test.ts      12 passed (9 before + 3 new)
  src/services/routedEdit.test.ts        18 passed (unchanged)
  src/collab.test.ts                     11 passed (8 before + 3 new)
  src/grid.test.ts                        4 passed
  src/grid-lock-badge.test.ts             4 passed
  src/grid-a11y.test.ts                   8 passed
  src/StatusBar.test.tsx                  5 passed
  src/services/sessionLifecycle.test.ts   9 passed
  src/services/saveInterlock.test.ts     10 passed
  src/services/engineTransport.test.ts    2 passed
  src/services/signedEngineTransport.test.ts 6 passed
  TOTAL: 12 files, 99 passed, 0 failed
cd apps/web && npx tsc --noEmit   → clean
cd apps/web && npx vite build     → succeeds (dist rebuilt)
```

Transport test coverage, per tasking: queue durability across
simulated reload (localStorage round trip + resubmission with content
byte-equal and baseRev refreshed); in-order apply + gap catch-up
sequencing with a fake EventSource/fetch (order [6,7] after fetching
from=5&to=6); ack matching clearing the queue + settling the waiter;
rejected-op retention (+ persistence + explicit clear); reconnect
re-lookup (fresh engineUrl/token) + resubmission order [A,B];
409-before-retention resync with queue survival; status/presence/
session event routing; gatewayClient.openFile shape (URL, body,
identical join/create fields).

## Decisions / doc-vs-code notes (flagged, not silently resolved)

1. **Double-submission seam (bridge vs host)**: the contract says both
   "routedEdit's serverExecute is rewired to the transport" AND
   "CollabBridge.onBroadcast → transport submit". In the real App flow
   a bridge edit EXECUTES on the host, which routes through
   serverExecute — wiring onBroadcast to also submit would apply every
   edit twice (different clientSeq namespaces defeat the server's
   idempotency). Resolution implemented: the transport submits bridge
   ops only when it is NOT attached as the host's submitter
   (`bridgeSubmitEnabled`); when attached, bridge ops already flow
   through /ops via the host. Both paths are real and tested. If the
   coordinator prefers the bridge as the sole submitter, the switch is
   this one flag + bypassing bridge→host execute for remote hosts.
2. **Ack channel**: queue entries are removed on EITHER the /ops HTTP
   ack or the op's own SSE delta, whichever lands first (both are
   server acks; removal is idempotent). The contract's delta-ack
   wording is honored — a lost HTTP response still acks via delta
   (tested) — and a missed delta cannot strand an entry forever.
3. **Join-by-link hydration depth**: `#file=` performs the handshake +
   SSE attach + catch-up deltas + snapshot sheet-name pull. It does
   NOT run the full `hydrateOpenedWorkbook` store hydration
   (formats/charts/pivots overlays) because that path is built from a
   `/load` result and the joiner has no file bytes; if the server
   worker's claim/load flow expects the joiner to also POST /load,
   this needs a coordinator ruling. Flagged as the thinnest part of
   this build.
4. **Open-handshake failure posture**: a failed `openFile` during a
   local-file open logs + continues with the Phase 1 load instead of
   hard-failing the open. Rationale: the server half is being built in
   parallel and may 404/503 until it lands; Phase 1 must not regress.
   Once the server contract is live, the coordinator may want this
   fail-closed — one-line change in `openRemoteBuffer`.
5. **Presence payload**: contract's POST /presence body is
   `{sheet,row,col,editing?}`; the bridge's heartbeat has no editing
   flag, so App-driven sends omit `editing` (Grid selection flags use
   the server-echoed value). The transport's `sendPresence` accepts
   and forwards `editing` when a caller supplies it.
6. **Delta→bridge log granularity**: the bridge log records ONE
   `cell.set` op per remote delta (its first cell), since deltas carry
   cells, not CollabOps. The changes UI stays live and ordered; a
   per-cell log would need op payloads in the delta/journal entries
   (the catch-up entries DO carry `op` — the transport currently does
   not forward it to the bridge; noted for the coordinator if the
   changes UI needs full fidelity).
7. Pre-existing issue noticed, NOT fixed (out of scope): the gateway
   autosave status-poll effect and the new SSE status handler both
   write `saveState`; they agree by construction (both are
   server-reported), but once SSE status is live the 2s poll in the
   autosave effect is redundant in gateway mode.

## NOT done (stated plainly)

- §10 multi-browser matrix: NOT RUN (stack down; coordinator's gate).
- No live end-to-end verification of any Phase 2 flow (no server).
- Desktop: untouched per tasking (it consumes the same dist; the
  matrix leg (b) build is the coordinator's).
- `editing:true` presence while a cell editor is open: not wired
  (selection presence only) — see note 5.
- Catch-up `op` payloads are not surfaced to the bridge log — see
  note 6.
