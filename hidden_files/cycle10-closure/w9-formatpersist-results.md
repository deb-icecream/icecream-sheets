# Cycle 10 Closure — W9: Defect D4 Fix (ribbon formatting never persists)

Date: 2026-10-20 (worker run). Scope: format chain only (ribbon/format
commands, FormatStore, save serialization) per assignment; W8's undo/save
-gating areas untouched except re-reading shared regions of App.tsx
immediately before each edit. No desktop repackage (revalidation worker
does that). No git push. perf-evaluation.md / progress.md / TODO.md
untouched.

## 1. Repro verdict per mode — D4 is a SHARED-PATH defect, not desktop-only

Reproduced at unit level against the exact production code paths (the
subagent cannot drive a live browser; the repro composes the identical
functions App.tsx composes, in the identical order):

- **Web local mode — CONFIRMED BROKEN (pre-fix).** Scratch vitest (since
  deleted, assertions preserved in §3's regression tests): engine with
  C10 = 0.1667; `setFormat` Bold + Percentage into the FormatStore
  (exactly `handleFormat`); then `snapshotToWorkbookData(host.snapshot())`
  → `XlsxAdapter.write` (exactly `buildDownloadBytes`). Parse-back:
  `formats: undefined`, `styles: undefined`, styles.xml contained no
  `<b/>` — both formats dropped, matching D4's desktop evidence
  (`number_format "General"`, `bold false`) byte-for-byte in behavior.
- **Web gateway mode — CONFIRMED BROKEN (pre-fix), worse.** The gateway's
  server-side save (`engineSvc.ts` `snapshotToWorkbookData`, a verbatim
  copy of the web one) also drops formats, the client extras
  (`buildServerSaveExtras`) had no channel to send session formats at
  all, AND the server save did not even re-attach the loaded file's own
  imported formats/styles (only dims + metadata were re-attached) — so
  in gateway mode an *unedited* formatted file lost its number formats
  on save too.
- **Desktop — BROKEN as reported (W6).** Desktop save funnels through
  the same renderer `buildDownloadBytes`, so the shared-path verdict
  covers it; the desktop open side additionally never carried full
  styles across IPC (only number-format codes), so imported bold could
  not even render/seed on desktop.
- **Control:** the XLSX adapter *could* already write number formats
  when handed `SheetData.formats` (repro: direct `write` with
  `formats: {'0:2': '0.00%'}` read back `0.00%`). The break was upstream
  of the adapter for number formats, and total (no channel existed) for
  fonts/fills/borders.

## 2. Root-cause chain (every break, file:line at fix time)

1. **Dirty-marking break — `apps/web/src/App.tsx` `handleFormat`
   (pre-fix ~2157).** Ribbon Bold / format-select → `handleFormat` →
   `setFormats(...)` + automation record, and nothing else. No
   `setSaveState('dirty')` (contrast `commitCell`, which does mark
   dirty). Same omission in `handleCellStyle`, `handleClearFormat`,
   `handleFormatAsTable`, the format-painter apply, and `handleClearAll`.
   → Format-only sessions never dirtied → autosave never fired
   (D4 evidence (a)).
2. **Serialization break (local + desktop) — `apps/web/src/io.ts:85`
   `snapshotToWorkbookData` + `App.tsx` `buildDownloadBytes`.** The
   WorkbookData was built from the engine snapshot alone (values/formulas
   only). The FormatStore — where applied formats live *by design*
   (formatting.ts header: presentation metadata, never engine state) —
   was never consulted, so `SheetData.formats`/`styles` were never
   populated on save (D4 evidence (b)).
3. **No carrier for font styling — `packages/engine/src/storage.ts`
   `SheetData` (pre-fix) + SheetJS CE.** `SheetData` had `formats`
   (number codes only) and no styles field; SheetJS CE writes `cell.z`
   number formats but drops fonts/fills/borders entirely (its generated
   styles.xml contains exactly one default font). Even a perfect
   FormatStore→WorkbookData conversion had nowhere to put Bold.
4. **Gateway breaks — `packages/gateway/src/services/engineSvc.ts`.**
   (i) Server `snapshotToWorkbookData` (line 244) is the same
   formats-blind conversion; (ii) `SaveExtras`/`buildSaveWorkbookData`
   had no `sheetStyles` channel and re-attached only source dims +
   metadata, not source formats/styles; (iii) `/load`'s response
   (`loadResponse`) shipped number formats but not styles, so the
   client's format store was never seeded with imported fonts in
   gateway mode.
5. **Desktop open break — `packages/engine/src/protocol.ts`
   `EngineLoadSheetSummary` + `apps/desktop/src/engine-load.ts`
   `summarizeSheet`.** Only `formats` crossed IPC; imported full styles
   never reached the renderer, so a saved bold cell could not render
   bold after relaunch even once saving worked (the second half of
   D4 evidence (b)).

Cell data model rule kept: no format field was added to any cell,
snapshot, or engine protocol command. Formats still live only in the
web FormatStore (cascade cell/range/column); the fix teaches the *save
serialization* to resolve that store into the storage layer's existing
"pure UI hint" channel (`SheetData.formats`, sibling to `colWidths` /
`rowHeights`, which the engine already ignores) plus its new full-style
sibling `SheetData.styles`.

## 3. Changes per file

**Engine (storage model)**
- `packages/engine/src/storage.ts` — new `CellStyle` (number format
  code, font name/size/bold/italic/underline/strikethrough/colors, solid
  fill, borders, alignment, wrap, indent, orientation) + border types;
  `SheetData.styles?: Record<"row:col", CellStyle>` documented as a pure
  presentation hint the engine never reads.
- `packages/engine/src/index.ts` — export the new types.
- `packages/engine/src/protocol.ts` — `EngineLoadSheetSummary.styles?`.

**XLSX adapter (the OOXML carrier)**
- `packages/xlsx-adapter/src/stylesXml.ts` — NEW. `applyNativeStyles`
  (read: parse fonts/fills/borders/cellXfs/numFmts + per-`<c>` style
  indices with row/column fallback, mirroring protectionXml; sparse —
  xf 0 and default-equal components yield nothing) and
  `injectCellStyles` (write: clone each target cell's current xf —
  preserving its numFmt and `<protection>` child — build/dedupe
  font/fill/border/custom-numFmt entries, append cellXfs, repoint
  `<c s="…">`, materialize EMPTY styled `<c>` for formatted empty cells,
  never a phantom value). Both best-effort, never throw.
- `packages/xlsx-adapter/src/adapter.ts` — read: `applyNativeStyles`
  runs in `assembleFromParsedSheets` (covers SheetJS + fast-parse
  paths); write: `injectCellStyles` runs after protection injection;
  `rowsToWorksheet` no longer creates SheetJS's `{v:0}` placeholder for
  a formats-entry cell the styles injector owns.
- `packages/xlsx-adapter/src/numfmt.ts` — `cellFormatCode` treats
  `GENERAL` (ClosedXML spelling) as the default, not a custom code.
- `packages/xlsx-adapter/src/fastSheetParse.ts` — same `GENERAL`
  case-insensitivity in the fast path's format extraction.
- `packages/xlsx-adapter/src/index.ts` — export the styles module.
- Idempotence fixed along the way: `GENERAL` codes, and a merged-font
  props-equality guard in `injectCellStyles` (restating the base font's
  own props reuses the base font instead of minting a duplicate) —
  `read → write → read → write` on closedxml-xlsx-formats.xlsx is
  byte-identical again (pageSetupXml idempotence test).

**Web app**
- `apps/web/src/features/formatting.ts` — `numberFormatToCode`
  (CellFormat → Excel code, mirroring the renderer's precedence:
  category wins over imported code; Percentage defaults to `0.00%`, the
  exact D4 rendering) and `expandFormatStore` (cascade resolution for
  save: cell > range > column, columns expanded over the data extent,
  explicit entries beyond it kept).
- `apps/web/src/io.ts` — `cellFormatToStyle` / `styleToCellFormat`,
  `formatStoreToSheetData` (single source shared by in-tab + gateway
  saves), `applyFormatStoreToWorkbookData`; `importedFormatsToStore`
  now also seeds from `SheetData.styles` (imported bold/fill/etc.
  render on open and survive re-save).
- `apps/web/src/App.tsx` — (i) `markFormatDirty` funnels dirty-marking
  for `handleFormat`, `handleCellStyle`, `handleClearFormat`,
  `handleFormatAsTable`, format-painter apply, `handleClearAll`;
  (ii) `buildDownloadBytes` calls `applyFormatStoreToWorkbookData`
  (covers local Save/Save As/autosave/download/encrypted/email and the
  identical desktop paths); (iii) `buildServerSaveExtras` additionally
  returns `sheetStyles` for EVERY sheet (empty record included — the
  server treats a reported sheet as authoritative, so clears clear);
  (iv) desktop-open WorkbookData reconstruction carries `s.styles`;
  (v) ribbon-parity ctx receives `onFormatStoreMutated: markFormatDirty`.
- `apps/web/src/ribbonParity.tsx` — optional `onFormatStoreMutated` ctx
  callback, invoked by the one direct setFormats site (a11y
  fix-contrast). All other ribbon format ops already funnel through
  `handleFormat`.
- `apps/web/src/services/gatewayClient.ts` — `sheetStyles` on
  `engineDownload` / `engineDownloadXlsx` / `engineLibrarySave`
  payloads (library save = gateway autosave target, same builder).
- `apps/web/src/services/engineTransport.ts` — `EngineLoadedSheet.styles?`.
- `apps/web/src/features/localMirror.ts` — `workbookDataFromLoadResult`
  carries styles into hydration.

**Gateway**
- `packages/gateway/src/services/engineSvc.ts` — state gains
  `sourceSheetFormats`/`sourceSheetStyles` (populated per /load,
  cleared per /reset); `loadResponse` ships `styles`; `SaveExtras`
  gains `sheetStyles` + exported `sanitizeSheetStyles` validator;
  `buildSaveWorkbookData` applies, per sheet: session styles when the
  sheet is reported (number-format map derived from the styles so the
  two channels cannot disagree), else the loaded file's own
  formats/styles. Shared by /download and /library/save.

**Desktop**
- `apps/desktop/src/engine-load.ts` — `summarizeSheet` copies
  `sheet.styles` into the IPC summary.

## 4. Parse-back proof per path

- **Adapter (serializer used by every path)** — new
  `packages/xlsx-adapter/tests/styles-xml.test.ts` (6 tests): bold +
  `0.00%` round-trip (raw styles.xml contains `<b/>`; read-back
  `styles {'0:0': {bold, '0.00%'}}`, `formats '0.00%'`); full field set
  (italic/underline/fontSize/fontName/fontColor/fill/alignment/borders)
  round-trips exactly; styled EMPTY cell materializes with no phantom
  value; formats-only and styles cells coexist; imported styles survive
  a second save; a hand-built foreign package's styles import.
  Independent check with openpyxl on adapter output:
  `C2 value 0.1667 | number_format 0.00% | bold True | italic True |
  fill FFFFFF00`.
- **Web local (+ desktop, same builder)** —
  `apps/web/src/io.test.ts` "format persistence (defect D4)": the exact
  D4 scenario through `snapshotToWorkbookData` +
  `applyFormatStoreToWorkbookData` + `XlsxAdapter.write` → parse-back
  `formats['9:2'] = '0.00%'`, `styles['9:2'] = {bold, '0.00%'}`,
  re-opened FormatStore seeds `{bold: true, formatCode: '0.00%'}` (so
  relaunch renders bold + %); italic/underline/size/fill/font-color set
  round-trips; unformatted saves gain no formats/styles noise.
- **Gateway (server-side download)** — REAL HTTP against the built
  engine service (scratch instance, dist): /load plain file → POST
  /download with `sheetStyles` extras as the fixed client sends →
  openpyxl on the returned bytes: `C2 value 0.1667 |
  number_format 0.00% | bold True`. Plus vitest HTTP tests
  (`engineSvc.test.ts`, +3): session styles carried; /load ships
  styles and a bare GET /download preserves the file's own styles
  (source fallback); a reported-but-empty sheet clears its formats.
  Explicitly: **in gateway mode session formats DO reach the server
  model — as per-save `sheetStyles` extras merged by
  `buildSaveWorkbookData` — because the format store is client UI state
  by design and the engine service never holds it; both gateway save
  routes (/download, /library/save incl. autosave) share that builder.**
- **Desktop open** — `apps/desktop/tests/engine-load.test.ts` (+1):
  `buildWorkbookFromBytes` summary carries `styles['0:0'] = {bold,
  '0.00%'}` + `formats '0.00%'` for the renderer to seed from.

**Dirty-marking proof:** by construction + inspection — every
format-mutating handler in App.tsx now calls `markFormatDirty()`
(`setSaveState('dirty')` unless read-only), which is the exact signal
the 2 s-debounce autosave effect keys on (`saveState !== 'dirty'`
returns early). A format-only session therefore dirties and autosaves;
the saved bytes carry the formats per the proofs above. (No App-level
React test harness exists for saveState; the behavior is pinned at the
handler level and in the autosave effect's existing contract.)

## 5. Suite counts (all run after the fix, this worker)

- `packages/xlsx-adapter`: **233/233** (30 files; incl. 6 new styles
  tests; the one initial failure — pageSetupXml byte-idempotence —
  was diagnosed to the `GENERAL`/font-dedupe fixed-point breakers
  above and fixed, suite re-run fully green).
- `packages/gateway`: **131/131** (13 files; incl. 3 new D4 tests).
- `packages/engine`: **980/980** (42 files).
- `apps/web`: **1570/1570** (121 files; incl. new formatting/io D4
  tests). `tsc --noEmit` clean.
- `apps/desktop`: **98/98** (14 files; incl. 1 new D4 test). `tsc -b`
  clean.
- `packages/service`: **1444 passed, 1 skipped** (75 files) —
  WorkbookData consumers unaffected.

## 6. Residuals / notes for the coordinator

- The running stack (gateway :8100 etc.) predates this fix; the
  gateway service and web bundle must be rebuilt/restarted to pick it
  up, and the desktop app must be repackaged (per assignment, the
  revalidation worker's job) before D4 can be re-swept on the packaged
  app. Gateway dist was rebuilt (`tsc -b`) as part of validation.
- Non-XLSX save formats (csv/tsv/ods/xlsb/html) ignore `styles`, as
  they did `formats` before — CSV-class formats carry no styling.
  Named-range downloads keep their existing no-extras semantics
  (formats not carried into the rebased subset, either path).
- Gateway mode: column-level formats expand over the client's known
  used range for that sheet (the server workbook's extent is not
  shipped to the client); cell/range formats — including everything
  the ribbon applies to a selection — are exact in all modes.
- Same-shape gap noticed but OUTSIDE the format chain (not fixed):
  other client-owned save extras (theme, pictures, charts…) also only
  persist when something else dirties the workbook — their setters
  don't mark dirty either. Flagging for a separate decision; D4's
  chain (all cell-format operations) is fully covered.
- Font colors stored as theme/indexed colors in foreign files have no
  exact CSS value and are not seeded (number formats, names, sizes and
  flags are); solid RGB fills/fonts round-trip exactly.
