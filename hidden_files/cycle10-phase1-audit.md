# Cycle 10 — Phase 1 Audit: gateway-mode open path (where each stage runs TODAY)

## Design requirement
platform-shell.md §1: "The web client hosts the engine as a service. Desktop and mobile package the identical core for local execution."

## Host selection (apps/web/src/engine.ts)
- `RemoteEngineHost` iff built with `VITE_GATEWAY_URL` AND a stored JWT (logged in).
- Otherwise local in-process `EngineHost` (browser). Desktop always local.
- Gateway proxies `/api/engine/*` → engine service on 127.0.0.1:8101.
- **Transport: synchronous XHR for ALL engine calls.** remoteEngine.ts header: "This is the local-dev/e2e transport … Do not use for production web traffic patterns."

## Open flow, gateway mode (App.tsx handleOpenFile → openRemoteBuffer → RemoteEngineHost.loadXlsxRemote)

| # | Stage | Where | Status |
|---|---|---|---|
| 1 | `File.arrayBuffer()` → bytes | Browser | OK |
| 2 | chunked base64 + `btoa` | Browser, sync main thread | OK (~100ms for 12MB) |
| 3 | `POST /api/engine/load` (sync XHR) | **Browser BLOCKED ~40s (P95)** while service works | BROKEN: freeze is sync *waiting*, not parsing |
| 4 | `XlsxAdapter().read(bytes)` | Server ✓ | OK |
| 5 | `new EngineWorkbook(initial)` | Server ✓ | OK — but ONLY `data.sheets` rows; **all metadata dropped** (see below) |
| 6 | Service returns `{ok, sheets[]}` | Server | OK |
| 7 | `notifyHostReplaced` → `h.snapshot()` (App.tsx:1257) | **Browser: FULL snapshot pull via sync XHR** | BROKEN: 1.8M cells as JSON for P95 — just to get sheet names. `RemoteEngineHost.sheetNames()` cache is null after reset. |
| 8 | Grid viewport `readRange` | Browser: sync XHR per render | BLOCKING round-trips per frame |
| 9 | Formula-language switch (App.tsx:2615): `snapshot()` + per-cell `readCell` | Browser | CATASTROPHIC in gateway mode: per-cell sync XHR round-trips |

## Metadata fidelity gap (gateway mode)
`engineSvc.ts` `/load` runs `new XlsxAdapter().read(bytes)` but uses only `data.sheets` → rows.
**Silently dropped:** number formats (FormatStore seed), charts, pivot tables, SmartArt,
page setup, print titles, defined names, external links, protection flags, data-model cubes,
ink/drawing canvases, themes, header/footer. Local mode (`openXlsxBuffer`) hydrates all of these.
Gateway-mode open loses them.

## Edit flow, gateway mode
- Every edit → `engineExecute` via sync XHR. No chain-length routing exists.
- **No local engine in gateway mode at all** (`RemoteEngineHost` has no workbook).
- Engine events polled every 1500ms (`/api/engine/events`).

## Save flow, gateway mode
- `buildDownloadBytes` (App.tsx:5223): `host.snapshot()` full pull + local
  `snapshotToWorkbookData` + adapter xlsx write **in the browser**.
  P95: 1.8M-cell JSON pull + ~43s write on the main thread.

## User's Cycle 10 rulings (from parent brief)
1. File open ALWAYS server-side for web. (Parse+build already are — transport, snapshot-pull, and metadata are what's broken.)
2. Editing HYBRID: client engine for short recalc chains; longer than configurable threshold → server. Server is source of truth.
3. Testing runs through the real gateway path with a logged-in test user.

## Gaps for Phase 2 (server-side open)
1. Sync XHR → async transport (fetch). The gateway-mode freeze is synchronous waiting.
2. No full-snapshot pull on open — use `/load`'s `sheets[]`; viewport-lazy reads only.
3. Metadata preservation — formats, charts, pivots, SmartArt, page setup, defined names, external links, protection must survive a gateway-mode open.
4. Progress UI during open; editing locked until open completes (user's rule).
5. Noted (out of scope unless cheap): save path also pulls full snapshot + writes xlsx in browser.

## Gaps for Phase 3 (chain-length routing) — FINAL RULE per user: SHAPE-based
- No chain-measurement utility exists. Engine exposes HyperFormula `dependencyGraph`
  (see `hyperformula-internals.d.ts`) — build on it.
- The routing decision is a STRUCTURAL test on the affected set's shape:
  1. **Affected set = a single chain** (one dependent sequence):
     - short (length ≤ configurable length threshold) → browser/local, single thread
     - long (> threshold) → server, single thread (a lone chain cannot parallelize internally)
  2. **Affected set = multiple chains** → server, ALWAYS. No length test.
     - On the server: MT auto-flag ON (workbook cell count above threshold) → independent
       chains in parallel (Excel-style), dependent chains serialize. Flag OFF → single thread.
  Single-chain uses the length threshold; multi-chain skips the threshold and goes straight
  to the server, where the flag decides threading. Document this rule verbatim in code
  comments and in perf-evaluation.md (Phase 4).
- **Refinements (user-approved):** (1) Tiny-set escape hatch — total affected set ≤50 cells
  (tunable) → local calc regardless of chain count, checked FIRST. (2) The size flag decides
  the local mirror: below flag → full local mirror kept, local calc always available; above
  flag → NO mirror, server-calc only (browser renders). (3) Optimistic display: server-routed
  edits show typed input immediately; downstream fills in on reply; server owns true values.
- **SAVE GATING (user's rule):** manual Save, AUTOSAVE, and export/save-a-copy are ALL blocked
  until the workbook is 100% loaded. Disabled "Loading…" save state with the reason. No
  partial-save path exists — unloaded sheets would serialize back empty (data loss).
- **DIVIDING LINE (user, confirmed):** Display is progressive; mutation is gated. The whole
  view layer (cells, formats, charts, pivots, SmartArt, images) renders progressively as data
  streams in; charts may render first from the chart parts' own cached series data
  (numCache/strCache), then re-render with live values when calc completes; unloaded regions
  show a loading state — never wrong data presented as final. Re-rendering is SCOPED: only
  visuals affected by arriving data repaint. Mutation (edit, save, autosave,
  export) stays gated at 100% load.
- **CONSOLIDATED SPEC A–H (user 2026-10-19 21:11 PDT — supersedes all prior directives):**
  recorded verbatim in TODO.md §10.8. Final report enumerates A–H with implementing files.
- No local engine in gateway mode — hybrid needs one (mirror) or server-side chain
  measurement. Hard constraints: server is source of truth, fail safe to server,
  no main-thread freeze, short chains must feel instant.

---

# Addendum — Desktop engine/view separation audit (user directive, Cycle 10)

platform-shell.md §1: desktop packages the identical core for local execution.
User's ruling (CORRECTED): engine stays local, but must run INDEPENDENTLY of the view —
never on the renderer's UI thread. THREAD separation only — same Node.js process, NO new
process (no utilityProcess/child_process). Sanctioned path: main-process side via the
existing IPC bridge; heavy work may optionally use a worker thread inside the main side,
but the hard requirement is the renderer's UI thread never blocks on engine work.

## Current desktop wiring (apps/desktop + apps/web engine.ts)

| Piece | Where | Status |
|---|---|---|
| Real workbook `EngineHost` | **Renderer** (`createInitialHost()`: `isDesktop()` → `new EngineHost()` in-process) | BROKEN: HyperFormula parse+build+calc on the UI thread — same freeze as web local mode |
| File open | Renderer: `XlsxAdapter.read` + `EngineWorkbook` build in-process | BROKEN: UI thread |
| Main-process `EngineHost` | Main (`main.ts:138`, empty workbook) + parallel-recalc pool (`configureParallelRecalc`, node:worker_threads, cores−1) | Exists but holds NO user workbook |
| IPC engine bridge | Main handlers `engine:execute/readCell/readRange/snapshot/protocolVersion` → preload `window.icecream.engine.*` (Promise-based) | Exists — **renderer never uses it for its workbook** |
| MCP :8106 | Main `IpcForwardingEngineHost` forwards ops INTO the renderer (workbook lives there) | Works (Cycle 8 GAP-1) but direction is a symptom of the wrong placement |
| Renderer MCP handler | `apps/web/src/services/desktopAgent.ts` `registerEngineForwardHandler` | Serves forwards against the renderer's host |

## What's missing for separation
1. No `engine:load` IPC channel — main cannot parse/build a file into its host.
2. No IPC-backed async `EngineHost` adapter for the renderer (analogous to
   `RemoteEngineHost` but over `window.icecream`). `ipcRenderer.sendSync` is
   NOT acceptable (blocks the renderer — same freeze).
3. Engine events must flow main→renderer over IPC (today events originate in
   the renderer; MCP forwarding pushes them renderer→main).
4. Once the engine is in main, MCP :8106 should serve the main-process host
   directly; `IpcForwardingEngineHost` becomes unnecessary (retire or invert).
5. Parallel-recalc pool already lives in main (`parallel-config.ts`) — correct
   side already; it just needs the real workbook to recalc.

## Constraints
- Desktop stays OFFLINE-capable: engine is local (main process), no services.
- Logged-in desktop remote services (login-gated client) unchanged.
- Renderer must stay responsive during open + recalc: verify with P50/P75 on
  the desktop build.
- Existing desktop suite (82 tests, Cycle 9) must stay green; add IPC contract
  tests (renderer↔engine) + responsiveness checks.

