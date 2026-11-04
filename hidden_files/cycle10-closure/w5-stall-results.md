# Cycle 10 Closure — W5: P75-open renderer stall (205 ms) — profile, fix, re-measurement

Date: 2026-10-20 (worker run). Target: worst renderer stall during P75 open in the
PACKAGED Linux desktop app < 100 ms (ideally < 50 ms), zero IPC timeouts, P50 open
and IPC edit→recalc still exact. No git push. perf-evaluation.md / progress.md /
TODO.md untouched.

## What the 205 ms actually was (profile evidence)

Harness: `hidden_files/pw2/w5-stall.mjs` (new; reuses desktop-validate.mjs's
method — packaged binary under Xvfb via CDP, P50 via argv, sampler installed,
reset, P75 scratch copy dropped; sampler = 5 ms interval + rAF, identical to
desktop-validate's). Fixtures are scratch copies in /tmp; originals never opened.
Supplementary evidence: CDP CPU profiles at 1 ms sampling, PerformanceObserver
longtasks, and a Web-Worker timer sampler to discriminate main-thread blocking
from renderer-process descheduling.

Baseline on the W1 package (standard mode, 3 runs): **maxTimer 168 / 242 / 186 ms
(max 242, median of maxes 186)**, rAF up to 167 ms — reproducing the recorded
205/167 ms. The worst gap sits ~400 ms after the drop, as one ~170–200 ms
longtask at load start, plus a second burst at load completion.

Two distinct main-thread costs, both in the renderer:

1. **Byte-array IPC transfer at open (~130 ms of the worst task).** CPU profile
   (1 ms sampling) of the drop window: top named renderer function is
   `loadIpc` with ~90 self-samples, plus ~39 in Electron's `invoke`
   serialization. Cause: `IpcEngineHost.loadIpc` did
   `Array.from(bytes)` — an iterator-protocol walk materializing one JS number
   per byte of the 1.3 MB P75 file on the UI thread — and
   `ipcRenderer.invoke('engine:load', {bytes: number[]})` then structured-cloned
   that 1.3M-element array element-by-element. The main-side handler additionally
   validated all 1.3M elements in a JS loop before `new Uint8Array(bytes)`.
   (Prime suspect was "stream-chunk ingest in ipcEngine.ts" — directionally
   right file, wrong mechanism: the desktop host has no load stream; the cost
   was the load call's own byte conversion + clone.)
2. **Fill-notification render burst at load completion (~100–200 ms).** Every
   background fill landing (range / cell / used-range / snapshot) emitted its
   own scoped event immediately, and App.tsx re-renders the whole app on every
   engine event (`host.subscribe(() => setTick(t+1))`). During an open, dozens
   of fills land within a few frames → a queue of ~70–105 ms full-render tasks
   back-to-back (observed longtasks 105 + 94 + 70 ms in one burst); the 5 ms
   sampler timer starves behind consecutive queued tasks, so the measured
   stall ≈ the burst sum (~197 ms in the worst diagnostic run). Worker sampler
   during these bursts: max 22–27 ms — the renderer process was scheduled fine;
   this is main-thread work, not OS contention and not Chromium layout of the
   first paint (layout-only hypotheses are ruled out by the longtask/profile
   attribution to JS render work).

Ruled out by measurement: a 100 µs-sampling profiler run and two later runs
showed multi-second timer gaps with NO longtask and a ~97–99% idle CPU
profile — those were artifacts (profiler overhead + this 2-core VM's
scheduling while the main process parses), not the recorded defect; the
clean-sampler runs above are the comparable series.

## Fixes

**Fix 1 — binary byte transfer end-to-end (no per-byte JS walks).**
- `apps/web/src/services/ipcEngine.ts`: `IpcEngineBridge.load(bytes: Uint8Array)`;
  `loadIpc` passes the typed array through untouched (was `Array.from(bytes)`).
- `apps/desktop/src/preload.ts`: `IcecreamApi.load` takes `Uint8Array`;
  `file.pickOpen` / `file.saveBytes` / `file.onOpenPath` types switched from
  `number[]` to `Uint8Array`; the open-path listener normalizes a legacy
  `number[]` payload at the bridge boundary.
- `apps/desktop/src/engine-ipc.ts`: `engine:load` accepts a `Uint8Array`
  (Electron's structured clone delivers it as a fresh typed array — bytes are
  valid by construction; used directly) and keeps the legacy `number[]`
  branch with its original per-byte validation + size cap.
- `apps/desktop/src/main.ts`: open-path event and `file:pickOpen` now send
  `new Uint8Array(data)` (was `Array.from(data)`); `file:saveBytes` accepts
  `Uint8Array | number[]` via `Buffer.from`.
- `apps/web/src/services/desktopAgent.ts`: bridge types updated;
  `desktopSaveBytes` passes the `Uint8Array` through (was `Array.from(bytes)`);
  `desktopPickOpen` / `onDesktopOpenPath` pass typed arrays through.
- Post-fix profile: `loadIpc` self-samples 90 → 6, `invoke` 39 → 3.

**Fix 2 — frame-coalesced fill notifications in `IpcEngineHost`.**
Fill-originated notifications (cell/range fill `cellsChanged`, used-range and
snapshot repaint `recalcComplete`) now merge into ONE delivery per animation
frame: `cellsChanged` refs union by cell, `recalcComplete` collapses to one
tick. Optimistic-edit emits and main→renderer engine events stay immediate,
and a pending fill batch flushes before any immediate emit (order preserved).
`whenReadsIdle()` flushes synchronously so awaiters/tests observe the same
events a painted frame would deliver. This mirrors the gateway host's accepted
poll-coalescing pattern. New state/methods: `pendingFillRefs`,
`pendingFillRecalc`, `emitFill`, `flushFillEvents`, `cancelFillFlush`.

## Re-measurement (rebuilt package, same sampler)

| Series | Before (W1 package) | After fix 1 only | After fix 1+2 |
|---|---|---|---|
| Standard mode (desktop-validate method), maxTimer ms | 168, 242, 186 (max 242, med 186) | 78, 157, 146 (max 157, med 146) | **60, 75, 78 (max 78, med 75)** |
| Quiet mode (in-page rAF waits, split drop), maxTimer ms | (mode added mid-investigation) | 99, 197 (diagnostic runs) | **59, 55 (max 59)** |
| desktop-validate.mjs's own sampler (full run) | 205 (on record) | — | **79 (rAF 50)** |

Worst stall is now **< 100 ms in every post-fix run** (max 78 standard /
79 in the full validation run), down from 242/205. The residual ~60–80 ms is
a single load-completion render task (the one React commit of the hydrated
workbook + first grid paint) — it no longer stacks with sibling fill renders.
Zero IPC timeouts in every run (all opens completed; no load/edit errors).

## Validation on the rebuilt package (desktop-validate.mjs, full run)

- BOOT: full UI from the packaged asar. ✅
- P50 open: real values (DASHBOARD B1 "Northstar Technologies",
  START HERE B1 "ULTIMATE SaaS 3-STATEMENT FINANCIAL MODEL"). ✅
- MCP :8106 (the app's own ingress) read_cells against the live workbook ✅,
  and post-edit corroboration C9 = 0.25 ✅.
- Edit→recalc over IPC exact: MONTHLY VIEW (LITE) C9 0.0833333 → 0.25;
  C13 ratio 2.9999999992, C14 ratio 2.9999999996 (×3.0000);
  C16 = 181998.8073 vs expected 181998.8074 (≈ $181,999). ✅
- Save gating during P75 load: banner up, ribbon Save buttons disabled
  "Loading…"; after load (13 tabs) Save enabled. ✅
- Stall during that P75 open (harness's own sampler): 79 ms / rAF 50 ms. ✅
- GTK Save-As dialog interaction: still unproven (xhelper absent on this VM;
  same status as the completion pass — not a regression).
- One harness quirk, not an app defect: desktop-validate's `waitLoaded`
  recorded the pre-open blank Sheet1 state as "P50 loaded" (its tabs>0 +
  no-banner heuristic fires before the argv open lands); every subsequent
  phase proves the real P50 workbook was open.

## Tests (related suites only)

- Web: `src/services/ipcEngine.test.ts` 20/20 (incl. 2 new: loadIpc passes the
  SAME Uint8Array instance to the bridge; fill coalescing merges three fills
  into one unioned cellsChanged + immediate-emit ordering), 
  `src/services/saveInterlock.test.ts` 10/10.
- Desktop: full suite 97/97 (was 96; +1 new: engine:load Uint8Array payload
  reaches buildWorkbookFn unconverted; legacy number[] validation tests
  unchanged and green), incl. `mcp-live-workbook.test.ts`.
- tsc clean: apps/web build (both flavors), apps/desktop build.

## Repackage (W1 protocol, flavor order preserved)

1. Desktop flavor: `cd apps/web && env -u VITE_GATEWAY_URL -u VITE_MCP_URL npm run build`
2. `cd apps/desktop && npm run build && npx electron-builder --linux dir AppImage`
   (old linux-unpacked + AppImage deleted first)
3. Gateway flavor restored afterwards:
   `VITE_GATEWAY_URL=http://127.0.0.1:8100 npm run build` in apps/web; web
   preview restarted on :4173 (pid in /tmp/gwlogs/web.pid; verified HTTP 200).
4. Stack MCP (stopped before validation, per protocol) restarted:
   `cd packages/mcp-server && PORT=8106 nohup node dist/bin/http.js`
   (log /tmp/gwlogs/mcp.log; pid in /tmp/gwlogs/mcp.pid; health verified
   `{"ok":true,"service":"mcp-server"}`; gateway :8100 health also verified).

### Artifacts (supersede W1)

| Artifact | Path | Size | sha256 |
|---|---|---|---|
| AppImage | `apps/desktop/dist/IcecreamSheets-0.1.0.AppImage` | 142,375,530 bytes (136 MiB) | `bf32ca93904ea412495d681d874c498f62663f053ae6e11de6eeaebda3377b35` |
| Unpacked | `apps/desktop/dist/linux-unpacked/icecream-sheets-desktop` | — | — |

(W1's AppImage sha was 4a07f35a… — superseded by the above.)

## Honest residuals

- The < 50 ms "ideal" is not met: the floor on this 2-core VM is one
  ~60–80 ms load-completion render task. Further reduction would need
  first-paint work deferral inside App's hydration (out of this task's
  surgical scope) and would still contend with main-process parse on 2 cores.
- Two diagnostic runs during profiling showed multi-second stalls caused by
  profiler overhead (100 µs sampling) — excluded from all reported series;
  the reported series use the un-instrumented sampler only.
- Changed files: apps/web/src/services/ipcEngine.ts (+ test),
  apps/web/src/services/desktopAgent.ts, apps/desktop/src/preload.ts,
  apps/desktop/src/engine-ipc.ts (+ test), apps/desktop/src/main.ts,
  hidden_files/pw2/w5-stall.mjs (harness). Not pushed.
