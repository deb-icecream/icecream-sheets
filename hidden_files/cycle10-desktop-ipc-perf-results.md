# Cycle 10 — Desktop IPC responsiveness measurements

**Method (honest scope):** IPC-path measurement in Node, NOT a GUI
measurement. The full Electron app cannot run meaningfully on this Linux
VM (headless, root-sandbox restrictions, no display; Electron refuses to
launch as root without --no-sandbox and there is no usable display
session), so no frame times are claimed.

Setup (`hidden_files/cycle10-desktop-ipc-perf.mjs` +
`cycle10-desktop-ipc-renderer.mjs`):
- "Main process": the REAL desktop code — `registerEngineIpc` handlers +
  `engine:load` (apps/desktop/dist/engine-ipc.js, engine-load.js) over a
  real `EngineHost`, parallel-recalc pool configured exactly as main.ts
  does (cores−1 workers, `resolveParallelCellThreshold`).
- "Renderer": a separate `node:worker_threads` thread that ONLY performs
  IPC invokes (postMessage structured clone, like Electron IPC) and runs
  a 5 ms interval timer. Timer slippage on that thread is the
  responsiveness signal: the renderer contains no engine code, so any
  stall there is IPC serialization or OS scheduling — never engine work.
- Machine: this VM (2 CPUs, shared/contended — absolute numbers are
  indicative, not a desktop-class benchmark).

## Results (single run, 2026-10-19 VM)

| Metric | perf-p50.xlsx | perf-p75.xlsx |
|---|---|---|
| engine:load wall time (parse+build in main) | 1,486 ms | 1,702 ms |
| **Renderer max timer delay DURING load** | **23 ms** | **124 ms** |
| readCell round-trip avg / P95 | 0.08 / 0.28 ms | 0.07 / 0.21 ms |
| readRange viewport (40×16) avg / P95 | 3.4 / 8.1 ms | 3.0 / 7.2 ms |
| execute (setCell) avg / P95 | 0.18 / 1.0 ms | 0.15 / 1.0 ms |
| Event delivery (execute → cellsChanged) | 0.27 ms | 0.13 ms |
| Explicit recalculate (main side) | 68 ms | 53 ms |
| Renderer max timer delay during recalc | 2.8 ms | 2.0 ms |
| engine:snapshot round-trip | 39 ms | 48 ms |
| Renderer max timer delay during snapshot | 1.1 ms | 3.6 ms |

## Reading

- The old architecture blocked the renderer's UI thread for the ENTIRE
  parse+build (the full ~1.5–1.7 s here; far worse at P95 scale) plus
  every recalc. Now the renderer thread's worst observed stall during a
  load is the structured-clone of the byte payload crossing IPC
  (23 ms / 124 ms on this contended 2-CPU VM) — the load itself happens
  entirely on the main side while the renderer stays free to paint
  (progressive display: sheet summaries arrive with the load reply;
  values stream via viewport reads).
- During recalc the renderer is effectively untouched (≤ 3.6 ms worst
  timer delay): the pool runs on the main side.
- Round-trips are sub-millisecond for cells, ~3–8 ms for a 640-cell
  viewport — comfortably inside a frame budget for progressive paint.

## Caveats

- postMessage cloning ≠ Electron's V8-serialization IPC; absolute
  numbers differ on a real desktop. The architectural claim (no engine
  work on the renderer thread) is what these numbers demonstrate.
- Byte payloads cross IPC as `number[]` (the existing preload
  convention); a transferable-bytes optimization is possible later.
- GUI verification (real window, real paint) remains a NEEDS-DEVICE item
  for the Mac mini install, like the other Cycle 8/9 desktop items.
