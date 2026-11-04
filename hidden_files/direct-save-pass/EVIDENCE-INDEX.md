# Direct-streaming save pass — evidence index (2026-10-21)

Design authority: design-docs/revision-model-save-and-coauthoring.md (§§1–11).
Summary record: perf-evaluation.md "Direct-streaming save addendum (2026-10-21)".

## Worker reports
- worker-a-core.md — shared serializer (packages/service/src/save/directSave.ts)
- worker-b-gateway.md — engine-service integration, Addenda 2/3/5/6, client contract
- worker-c-desktop.md — desktop direct save (main-process, shared serializer)
- worker-d-desktop-addenda.md — desktop batch autosave, pin wiring, status poll

## API-level validation (real gateway stack, production topology)
- validation-api-P50.json / validation-api-P75.json / validation-api-P95.json
  (validate-api.mjs; probes: probe-p95-save.mjs, probe-torn-p95.mjs)
- P95 parse-back EXACT (raw-XML): 1,320,031 value + 480,005 formula,
  unedited AND edited, per-sheet identical.
- Torn state (probe-torn-p95.mjs): pin rev=1, stashedCells=60002, committed
  file at pinned revision only, live=2 / storage=1 after commit.
- No-op force saves: P50 8 ms / P75 13 ms / P95 19 ms, all skipped:true.
- Engine RSS peak during P95 validation: 3,884,564 KB (plateau ~3.7 GB).

## Browser tours (gateway web dist)
- tour-p50/ — save ok 1,742 ms; parse-back exact (1,539 + 2,403)
- tour-p75/ — save ok 2,109 ms; parse-back exact (2,202 + 761)
- tour-p95/ — COMPLETED PASS: load wall 54.7 s, TTFP 4.92 s, save ok in
  104,290 ms (contended host), downloads/p95ds-saved.xlsx = 13,524,008 B,
  parse-back identical to source per sheet (raw-XML, both counting
  conventions). Screenshots self-inspected (real Ledger/Sales data).
  Two earlier attempts failed under contention that included a zombie
  duplicate tour process from an aborted invocation racing the same
  stack + output dir; the completed run is the verdict. Clean API
  best remains 36.3 s.

## Packaged desktop (AppImage rebuilt 2026-10-21, no-gateway dist)
- desktop-packaged.json — P75 open→edit (FMTs D7=424242)→Ctrl+S in 774 ms,
  "✓ Saved"; lock badge: unlocked C9 selected → 0 markers, locked A1
  selected → exactly 1 marker at cell-0-0; forced mid-write fault →
  original sha unchanged, error surfaced, session stays "Unsaved changes".
- desktop-p75-saved.xlsx — parse-back EXACT vs source (2,202 + 761, per-sheet).
- desktop-p75-after-save.png / desktop-lock-badge-b.png /
  desktop-forced-failure.png — self-inspected.

## Lock badge (web)
- lock-badge-shots/ — (a) unlocked selected → 0 markers; (b) locked selected
  → exactly 1 marker at cell-0-0. Shapes (c) row / (d) column / (e) select-all
  DO NOT EXIST in the product's selection model — NOT RUN, stated plainly.
- Regression: apps/web/src/grid-lock-badge.test.ts (with grid-a11y + grid:
  16/16).

## Suites (post-perf, consolidated)
engine 995 · xlsx-adapter 243 · service 1,453 (+1 skipped) · mcp-server 117
(+1 skipped) · gateway 184 · desktop 153 · web 1,601 — total 4,746 passed,
0 failed (baseline 4,742). Two gateway assertions updated for the deliberate
FNV→SHA-256 checksum change (format only; equality semantics unchanged).
