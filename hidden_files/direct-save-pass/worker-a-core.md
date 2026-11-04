# Worker A — core serializer extraction (direct-streaming save fix)

## Files changed

| File | Change |
|---|---|
| `packages/service/src/save/directSave.ts` | **NEW** — the shared, node-only serializer module (see API below). |
| `packages/service/package.json` | Added export subpath `"./save-node": "./dist/save/directSave.js"` (follows the `./automation-node` pattern). `src/index.ts` NOT touched (node-only module, uses `node:fs`). |
| `packages/gateway/src/services/saveWorkerCore.ts` | Rewired: rebuild (phase 1) + checksum verify (phase 2) unchanged; serialize phase now calls `serializeLiveWorkbook` from `@icecream-sheets/service/save-node`, feeding the rebuilt requester-principal bulk, `parsedByName` as `parsedSheets`, `job.ops`, `job.definedNames`, `job.metadata`, `sourceBytes`, `job.sheets`. Deleted the duplicated `serializeVerbatim` / `serializeViaAdapter` / grouping / resolved-presentation code (`clientStylesDiffer`, `dimsEqual`, `canonicalStyleJson`, `ResolvedSheet`, `ParsedSheetMeta`, `fileChunks`, `CELL_OPS`/`NAME_OPS` locals). |
| `packages/gateway/tests/saveWorker.test.ts` | Updated the HTTP describe block only (see "Deviations" — the /download→spawned-worker shape it asserted no longer exists). In-process core tests unchanged and passing. |
| `packages/service/tests/directSave.test.ts` | **NEW** — 6 tests (brief's 4 + addendum fault-injection + verify/ops-list pin). |

Not touched (per brief): `engineSvc.ts`, desktop, `App.tsx`, `perf-evaluation.md`, `progress.md`. No git push.

## API as implemented (`packages/service/src/save/directSave.ts`)

Exactly the brief's signatures, verified against the built dist
(`Object.keys` of `@icecream-sheets/service/save-node` =
`DIRECT_SAVE_MUTATING_OPS, serializeLiveWorkbook, verifyXlsxPackage`):

```ts
export interface DirectSaveSheetMeta { name: string; clientStyles: boolean; styles?: Record<string, CellStyle>; clientDims: boolean; dims?: { colWidths?: Record<string, number>; rowHeights?: Record<string, number>; hiddenCols?: number[]; hiddenRows?: number[] } }
export interface DirectSaveParsedSheet { styles?: Record<string, CellStyle>; formats?: Record<string, string>; colWidths?: Record<string, number>; rowHeights?: Record<string, number>; hiddenCols?: number[]; hiddenRows?: number[] }
export interface DirectSaveCell { ref: CellRef; input: CellInput; value: TypedValue }
export interface DirectSaveResult { mode: 'verbatim' | 'adapter-fallback'; bytes: number; changedSheets: string[]; verbatimParts: number; regeneratedParts: string[]; droppedParts: string[]; serializeMs: number }
export interface DirectSaveInput { bulk: DirectSaveCell[]; sheetNames: string[]; definedNames: DefinedName[]; metadata: Record<string, unknown>; sourceBytes: Uint8Array | null; parsedSheets: Map<string, DirectSaveParsedSheet>; sheets: DirectSaveSheetMeta[]; ops: Array<{ cmd: string; ref?: CellRef }>; outPath: string; log?: (m: string) => void }
export function serializeLiveWorkbook(input: DirectSaveInput): DirectSaveResult
export const DIRECT_SAVE_MUTATING_OPS: ReadonlySet<string>  // 20 ops, identical to gateway SAVE_MUTATING_OPS (engineSvc.ts): setCell, setFormula, addSheet, deleteSheet, renameSheet, duplicateSheet, moveSheet, defineName, deleteName, renameName, updateNameRefersTo, defineFunction, updateFunction, rollbackFunction, deleteFunction, insertRows, deleteRows, insertCols, deleteCols, setCalculationMode
```

Logic ported faithfully from `saveWorkerCore.ts` phase 3: bulk grouping by
sheet (dropping `#PERM!` error cells) → resolved presentation
(`clientStylesDiffer`/`dimsEqual`/`ResolvedSheet`) → verbatim-vs-adapter
decision (structural = any op not in `CELL_OPS {setCell,setFormula}` and not
in `NAME_OPS`; or live sheet-name set differs from the source set, taken from
`parsedSheets` keys) → write to `input.outPath` → result with `bytes` via
`statSync` and `serializeMs` measured inside. Verbatim path keeps the
original memory discipline (changed sheets generated to `mkdtempSync` temp
files, 1 MiB verbatim slices, streaming zip). The adapter fallback uses a
small local `groupedToWorkbookData` converter (dense row arrays sized by
max row/col from the grouped cells — equivalent to
`engineSvc.snapshotToWorkbookData`), clearly labeled **ADAPTER FALLBACK
ONLY**, then `XlsxAdapter.write` with styles/dims re-attached from the
resolved sheets (mirrors the original re-attach code). All xlsx-adapter
helpers reused as briefed (`sheetXmlChunks`, `streamZipToSink`,
`verbatimChunks`, `textChunks`, `createStreamingStyles`, `definedNamesEqual`,
`regenerateWorkbookXml`, `synthesizeWorkbookXml`, `mergeCustomPropsXml`,
`removeContentTypeOverride`, `ensureContentTypeOverride`,
`synthesizeContentTypes`, `synthesizeRootRels`, `synthesizeWorkbookRels`,
`MINIMAL_STYLES_XML`, `unzipPackage`, `formulaRecoverySheetPartPaths`,
`XlsxAdapter`). No rebuild, no re-parse of the source beyond the one unzip
for verbatim part copy, no replay, no checksum.

## Addendum 1 (Excel save sequence) — implemented

- **Mid-write fault injection (test-only):** env
  `ICECREAM_SAVE_FAULT_INJECT === 'midwrite'`, read at call time, documented
  in the module header. Verbatim path: the first regenerated sheet entry fed
  to the zip throws `Error('injected save fault (midwrite)')` after its
  chunks (via `throwAfterChunks`), genuinely mid-write into `outPath`; the
  throw is re-raised past the verbatim→adapter retry so it surfaces as a
  save failure, not a fallback. Adapter path: partial write, then the same
  throw. Default off, zero behavior change otherwise. Unit test proves: throws,
  temp `outPath` exists but is partial (`verifyXlsxPackage` rejects it), and a
  pre-created destination file elsewhere stays byte-identical (replace logic
  is the callers'; not implemented here).
- **`verifyXlsxPackage(path): { ok: true; parts: number }`:** exported from
  `directSave.ts`; reads the file, runs `unzipPackage`, asserts
  `[Content_Types].xml` + `xl/workbook.xml` + ≥1 `xl/worksheets/*.xml` part,
  throws on any failure. Used inside the directSave tests on every output.

## Addendum 2 (save/download separation, ops-during-save) — no core changes

Confirmed on finishing: **the core module needed no addendum-2 changes.**
Callers pass a pinned bulk readback of one revision into
`serializeLiveWorkbook`; the function is synchronous and consumes only that
input, which is exactly what makes the gateway/desktop ops-during-save
guarantee hold on top of it.

## Test results (exact counts)

- Builds: `packages/service` `npm run build` — clean (tsc, no errors);
  `packages/gateway` `npm run build` — clean. (xlsx-adapter not modified;
  its existing dist was used.)
- `packages/service` — `npx vitest run tests/directSave.test.ts`:
  **1 file passed, 6 tests passed, 0 failed.**
  (1) unedited → `mode 'verbatim'`, `changedSheets []`, parse-back
  per-sheet non-empty counts equal source; (2) one `setCell` →
  `changedSheets ['Data']`, new value + formula parse back, untouched
  sheet part byte-identical to source; (3) `#PERM!` bulk cell dropped
  (parse-back count equals source, no row 5, no leaked value);
  (4) `insertRows` → `mode 'adapter-fallback'`, parse-back exact;
  (5) fault injection → throws mid-write, temp output invalid,
  destination untouched; (6) `verifyXlsxPackage` rejects non-package/
  missing files + `DIRECT_SAVE_MUTATING_OPS` exact-list pin.
  Every successful output also passed `verifyXlsxPackage`.
- `packages/gateway` — `npx vitest run tests/saveWorker.test.ts`:
  **1 file passed, 4 tests passed, 0 failed** — checksum-mismatch abort
  (no file emitted); in-process verbatim save via the rewired worker
  (edited sheet reflects op, untouched part byte-identical, checksum
  round-trips); HTTP direct download parse-back exact; HTTP mid-save
  fault → 500, engine alive, edit/read round-trip + retry save 200.
- `packages/xlsx-adapter` — `npm test` (full suite):
  **31 files passed, 243 tests passed, 0 failed** (148 s).

Only related tests were run, per brief.

## Addendum 5 — per-type structural handling (follow-up, same day)

Changed the verbatim-eligibility rule in `directSave.ts` from one
adapter-fallback bucket to per-type handling:

- **Row/col structural ops** (`ROWCOL_OPS` = insertRows, deleteRows,
  insertCols, deleteCols; sheet set unchanged): no longer take the
  adapter fallback. The save stays verbatim/streaming, with
  `serializeVerbatim` receiving `forceAllChanged` so EVERY sheet
  regenerates from the provided bulk (an address shift invalidates
  per-cell reuse/address collapsing); non-sheet parts still copy
  verbatim. A distinct log line records the case
  (`row/col structural op -> verbatim, all sheets regenerated ...`).
- **Adapter fallback remains only for:** a changed sheet-name set
  (sheet add/delete/rename/move) → `fallbackReason: 'sheet-set-changed'`,
  or another structural op the verbatim planner cannot handle (not a
  cell op, not a name op, not a row/col op — e.g. setCalculationMode)
  → `fallbackReason: 'structural-op:<cmd>'` (first such op). Name ops
  behave exactly as before. The verbatim-planning-failure catch now
  also reports `fallbackReason: 'verbatim-failed'`. Sheet-set reason
  takes precedence when both fire (e.g. renameSheet).
- **API:** `DirectSaveResult` gained additive optional
  `fallbackReason?: string` (absent on the verbatim path). Nothing
  else in the API changed. Gateway pass-through is additive only:
  `SaveWorkerResult` (saveWorkerSpawn.ts) gained optional
  `fallbackReason?: string`, and `saveWorkerCore.ts` forwards it when
  the serializer sets it.
- **Tests** (`packages/service/tests/directSave.test.ts`, now 9):
  the old "insertRows → adapter-fallback" test was rewritten to the
  new rule — (1) insertRows → `mode 'verbatim'`, `fallbackReason`
  undefined, `changedSheets` = every sheet, parse-back values match
  the provided bulk; (2) renameSheet (bulk/sheetNames renamed,
  parsedSheets still source) → `mode 'adapter-fallback'`,
  `fallbackReason 'sheet-set-changed'`, renamed sheet parse-backs;
  plus setCalculationMode → `fallbackReason
  'structural-op:setCalculationMode'`; (3) batch shape — Data!A1
  edited 3× in sequence (bulk carries only the final 999), Data!B1
  edited once ('once'), journal lists Data 4× → output row is exactly
  `[999, 'once']`, intermediates 111/222 appear nowhere,
  `changedSheets` is exactly `['Data']` (listed once).
- **Results:** service build clean, directSave tests **9/9 passed**;
  gateway build clean, saveWorker tests **4/4 passed**. No other
  packages touched; no git push.

## Deviations from the brief

1. **Gateway HTTP tests updated beyond an import/shape tweak (necessary).**
   The two spawned-worker HTTP tests asserted /download behavior
   (`x-save-worker` header; worker kill-switch → 500) that no longer exists
   in the tree: the parallel engineSvc rewire (not mine — `engineSvc.ts`
   untouched by me, per brief) made /download an *unconditional direct*
   pass (`runDirectSave` → `serializeLiveWorkbook`; `spawnSaveWorker` now
   has zero callers in gateway src). Those tests failed against engineSvc
   regardless of the worker core (download log line proves the direct path
   served them). Per the brief's "must stay green / shape genuinely
   changed" clause, I rewrote that describe block to pin the current
   topology (direct download parse-back exact; mid-save fault via
   `ICECREAM_SAVE_FAULT_INJECT` → 500 + session usable). The in-process
   core tests — the surface my rewire actually changes — are unmodified
   and pass. **Coordinator should confirm worker B owns the equivalent
   direct-path coverage expectations.**
2. **Adapter-fallback `regeneratedParts` label:** `'(whole package via
   XlsxAdapter fallback)'` instead of the worker's original
   `'(whole package via XlsxAdapter in worker)'` — the module is shared,
   so the worker-specific wording would be wrong for live callers. No test
   asserted the old string.
3. **`workerGc()` calls dropped** inside the serializer (brief: "GC not
   required"); the worker keeps its own phase-boundary GC in
   `saveWorkerCore.ts`.
4. **Source sheet-name set** for the verbatim-vs-adapter decision comes
   from `parsedSheets` keys (the brief's input shape has no separate
   source-names field; the worker's `parsedByName` carries one entry per
   source sheet, so behavior is identical for both current callers).
