# Item B — Structured-ref expansion on regenerated sheets

Worker: resume fix worker (predecessor killed by daemon restart, left no evidence).
Started: 2026-10-21 ~21:33 PDT.

## STEP 0 — re-derived mechanism (from current code, read this session)

- Import (`packages/xlsx-adapter/src/adapter.ts`, `assembleFromParsedSheets`):
  table definitions are read from the ZIP (`tables.ts: readTables`) and every
  formula containing `[` is passed through `rewriteStructuredRefs`
  (tables.ts) which rewrites structured refs to A1 ranges, e.g.
  `=SUM(Sales[Qty])` -> `=SUM(Data!$B$2:Data!$B$4)`,
  `Sales[[#This Row],[Price]]` -> `Data!$C$4`.
  This is BY DESIGN at import: the engine (HyperFormula) cannot parse the
  structured syntax (tables.ts header comment). Existing test
  `tables-native.test.ts` "structured references are still rewritten to A1
  on import" pins this. => Import translation is NOT the defect to fix;
  the original structured text is simply never stored anywhere.
- Engine model: formulas are stored only in the A1 form the adapter handed
  it (HyperFormula). `SheetData` (engine storage.ts) has no structured-ref
  sidecar. Table definitions DO travel as the optional `tables` field on
  sheet objects (adapter-side `SheetDataWithTables`, nativeSheetFeatures
  precedent).
- Save paths that SERIALIZE formulas:
  1. Classic: `XlsxAdapter.write()` (adapter.ts) — SheetJS rebuild from
     `data.sheets[].rows` (A1 formulas), then `injectTables()` re-emits
     real `xl/tables/tableN.xml` parts + `<tableParts>` from the sheets'
     `tables` field. Formulas written = A1 expansions. DEFECT REPRODUCES
     here by construction (parse-back below pending).
  2. Production save (SAVE SERIALIZATION INVARIANT): 
     `packages/service/src/save/directSave.ts serializeLiveWorkbook` —
     untouched sheets are copied VERBATIM from the source package (so
     structured refs survive an unedited save), but any sheet in the
     changed set is regenerated row-by-row via
     `streamingSave.ts sheetXmlChunks`/`cellXml` from the live bulk
     readback, whose inputs are the A1 forms. DEFECT = the brief's
     "when a sheet is regenerated on save". Table parts + the sheet's
     `<tableParts>` tail survive verbatim on this path; only the formula
     text degrades.
  3. DirectSave adapter fallback (`serializeViaAdapter` ->
     `groupedToWorkbookData`): builds WorkbookData sheets from grouped
     cells WITHOUT the `tables` field, so the classic write there loses
     even the table parts. In scope to fix as part of this item (same
     mechanism: tables not carried to the serializer).
- Sibling work distinguished: tables.ts / tables-native.test.ts OOXML
  wave-2 work (full TableDef model, `injectTables`, totals/style/
  calculatedColumnFormula round-trip) is PRESENT and complete in the
  tree. It preserves the table DEFINITION (incl. structured refs inside
  `<calculatedColumnFormula>`/`<totalsRowFormula>` elements of the table
  part itself) but NOT structured refs in worksheet cell formulas. This
  item builds on that model.

## Fix direction (to be confirmed by repro)

Stateless inverse transform at the serialization boundaries, in
tables.ts: `restoreStructuredRefs(formula, formulaRow, formulaSheet,
tables)` — the exact inverse of `rewriteStructuredRefs` for the forms
that rewriter produces (column data range -> `T[Col]`; full header/data/
totals/all ranges -> `T[#Headers]`/`T[#Data]`/`T[#Totals]`/`T[#All]`;
same-row single cell in a table column -> `T[@Col]`). Applied:
- in `XlsxAdapter.write()` using the workbook's tables (sheet `tables`
  fields), and
- in the streaming writer (`sheetXmlChunks` option) wired from
  directSave, which derives the tables from the retained source package
  (`readTables`), plus attaching tables in the adapter-fallback
  conversion so table parts survive there too.
Graceful degradation: a formula whose A1 refs no longer exactly match a
table shape (edited / structurally shifted) stays A1 — today's behavior,
semantically identical values.

## Repro

PENDING — see updates below.

## RESUME WORKER UPDATE — 2026-10-21 ~21:47 PDT

Mechanism RE-VERIFIED against current code (all three paths exactly as
checkpointed above; streamingSave.ts lives in packages/xlsx-adapter/src/,
directSave.ts in packages/service/src/save/). Predecessor's scratch repro
fixture survives at packages/xlsx-adapter/tests/zz-itemb-repro.test.ts
(Sales table A1:D5 on sheet "Data" + structured-ref formulas on Data and
Calc sheets) — will be folded into the real regression tests and removed.

IMPLEMENTATION PLAN (from the agreed design):
1. tables.ts: `restoreStructuredRefs(formula, formulaRow, formulaSheet, tables)`
   — scanner skipping string literals; matches the exact absolute forms
   rewriteStructuredRefs emits (`Sheet!$C$2:Sheet!$C$4`, quoted sheet
   names incl.) plus unqualified forms assumed on formulaSheet; restores
   #All/#Headers/#Totals ranges, per-column data range -> T[Col],
   #Data range, header/totals single cell -> T[[#Headers],[Col]] /
   T[[#Totals],[Col]], same-row data cell -> T[@Col]. No exact shape
   match -> text left A1 (graceful degradation).
2. XlsxAdapter.write(): transform formula cells per sheet using the
   sheet's `tables` field before rowsToWorksheet (no input mutation).
3. streamingSave sheetXmlChunks: new options `structuredRefTables` +
   `sheetName`, applied inside cellXml before future-function prefixing.
4. directSave serializeVerbatim: tables derived via readTables(files,
   sheetNames) -> tablesBySheet, passed per changed sheet.
   serializeViaAdapter/grouped path: readTables over source package
   (source names from parsedSheets keys) + attachTablesToSheets so the
   fallback write emits table parts AND restores refs.
5. Tests: adapter-level unit + classic-write parse-back; service-level
   directSave production-path parse-back (edit on table sheet) +
   fallback table-parts test.

## RESUME FIX WORKER — progress log (2026-10-21 ~21:58 PDT start)

- STEP 1 LANDED: `restoreStructuredRefs(formula, formulaRow, formulaSheet, tables)`
  in packages/xlsx-adapter/src/tables.ts (+ export in src/index.ts).
  Scanner skips string literals ("" escape); parseA1RefAt handles
  quoted sheet names ('' escape) + unquoted prefixes + unqualified
  forms on formulaSheet; only exact absolute ($Col$Row) forms restore;
  ranges win over singles; non-matching ranges/singles are consumed
  verbatim (no partial conversion). Restores #All/#Headers/#Totals/
  #Data ranges, T[Col], T[[#Headers],[Col]], T[[#Totals],[Col]],
  T[@Col]. Tests pending (step 5).
- STEP 2 LANDED: XlsxAdapter.write() gathers TableDefs from every
  sheet's `tables` field (cross-sheet refs included), restores formula
  cells via restoreStructuredRefs before rowsToWorksheet, copying rows
  only for sheets that change (no input mutation).
- STEP 3 LANDED: streamingSave SheetGenOptions gains
  `structuredRefTables` + `sheetName`; cellXml applies
  restoreStructuredRefs to the formula body before
  prefixFutureFunctions (bracket tokens are opaque to that tokenizer).
- REPRO EVIDENCE (zz-itemb-repro, run this session): READ forms are the
  exact absolute forms restore matches (e.g. `=SUM(Data!$B$2:Data!$B$4)`,
  `=Data!$B$2*Data!$C$2`, `=SUM(Data!$A$2:Data!$D$4)`); ENGINE bulk
  readback preserves those absolute forms verbatim. Classic write
  BEFORE the fix emitted the A1 forms (defect confirmed on paper).
  Note: source `Sales[@Qty]` (single-bracket @) is NOT rewritten at
  import by the pre-existing rewriter (only `[[@Qty]]` is) — import
  gap predates this item, out of scope; restore emits the plan's
  canonical `T[@Col]` form.
- STEP 4 LANDED: directSave serializeVerbatim derives tables via
  readTables(files, sheetNames) -> tablesBySheet(...) flattened to
  the full set, passed as structuredRefTables + sheetName per changed
  sheet (full set because qualified refs match by named sheet).
  serializeViaAdapter: readTables over the source package with
  source names from parsedSheets keys + attachTablesToSheets(wbData
  sheets) before XlsxAdapter.write, so the fallback emits table
  parts AND restores refs.
- Steps 1-4 code complete. Next: build xlsx-adapter (service tests
  resolve it via dist), write step-5 tests, run them, fold in the
  zz- repro fixture and remove it.
- STEP 5a DONE: xlsx-adapter built (tsc clean; dist exports
  restoreStructuredRefs). New tests/tables-restore.test.ts: 9/9 PASS
  (7 unit incl. rewrite->restore round-trips + quoted sheet names +
  string literals + graceful cases; classic-write parse-back with
  the folded-in repro fixture). Neighbors still green: tables-native
  14, streamingSave 7, futureFunctions 13 (43 total in the run).
  Classic-write before -> after (Data sheet): `SUM(Data!$B$2:Data!$B$4)`
  -> `SUM(Sales[Qty])`; `Data!$B$2*Data!$C$2` -> `Sales[@Qty]*Sales[@Price]`;
  Calc `SUM(Data!$A$2:Data!$D$4)` -> `SUM(Sales[#Data])`.
- STEP 5b DONE: service tests — new tests/directSave-structuredRefs
  .test.ts 2/2 PASS (verbatim production path with an edit on the
  table sheet: regenerated sheet carries `SUM(Sales[Qty])`,
  `Sales[@Qty]*Sales[@Price]`, `SUBTOTAL(109,Sales[Qty])`, table part
  + <tableParts> survive, untouched Calc part byte-identical,
  parse-back returns identical A1 model; adapter fallback via
  setCalculationMode: table part + <tableParts> survive and refs are
  structured incl. cross-sheet Calc `SUM(Sales[#Data])`). Existing
  directSave.test.ts 12/12 still PASS. zz-itemb-repro.test.ts REMOVED
  (fixture folded into both new test files).
- REGRESSION FOUND + FIXED (coordinator landed the fix in parallel):
  roundtrip-fidelity on beyond-excel-bxl3way.xlsx failed with this
  item's restore active — Imports!D7:D16+ `=Imports!$C$7-Start_Year+1`
  (from source `tblActuals[[#This Row],[Year]]-Start_Year+1`) restored
  to `=tblActuals[@Year]-Start_Year+1`, which the pre-existing
  rewriter could not re-import (it only handled `[[@Col]]`). The
  successor coordinator added the single-bracket @ branch to
  resolveStructured in tables.ts (src mtime 05:48 UTC, after this
  worker's 05:42 failing run) + regression tests in
  tables-native.test.ts (`=Sales[@Qty]` -> `=Data!$B$3`, unknown
  column untouched). This worker verified the mechanism against the
  raw source file (sheet5.xml D7 = `tblActuals[[#This Row],[Year]]...`)
  and is re-validating the full set against the current tree.

## FINAL VERDICT — FIXED (2026-10-21, resume fix worker)

All 5 plan steps landed:
1. tables.ts `restoreStructuredRefs(formula, formulaRow, formulaSheet, tables)`
   (+ index export): string-literal-safe scanner; exact absolute forms
   only (qualified incl. quoted sheet names, half-qualified, and
   unqualified-on-formulaSheet); restores #All/#Headers/#Totals/#Data
   ranges, T[Col], T[[#Headers],[Col]], T[[#Totals],[Col]], T[@Col];
   non-matching ranges/singles consumed verbatim (no partial edits).
2. XlsxAdapter.write(): restores per sheet from the workbook-wide
   table set (cross-sheet refs work) before rowsToWorksheet; no input
   mutation (rows copied only for changed sheets).
3. streamingSave sheetXmlChunks: new `structuredRefTables` +
   `sheetName` options; cellXml restores before
   prefixFutureFunctions.
4. directSave serializeVerbatim: readTables(files, sheetNames) ->
   tablesBySheet -> full set passed per changed sheet.
   serializeViaAdapter: readTables over the source package (names
   from parsedSheets keys) + attachTablesToSheets, so the fallback
   emits table parts AND restored refs.
5. Tests (below); zz-itemb-repro.test.ts fixture folded into both new
   test files and REMOVED.

Plus the coupled symmetry fix (landed by the successor coordinator in
parallel, verified here against the raw file): resolveStructured now
also rewrites the single-bracket `T[@Col]` form at import — without
it, the restored form could not be re-imported (roundtrip-fidelity
on beyond-excel-bxl3way.xlsx: source `tblActuals[[#This Row],[Year]]`
-> A1 `Imports!$C$7` -> restored `tblActuals[@Year]`, previously
stranded on re-read). Regression expectations added by the
coordinator in tables-native.test.ts pass.

Evidence (all runs against the final tree; adapter dist rebuilt,
tsc clean for xlsx-adapter AND service):
- packages/xlsx-adapter/tests/tables-restore.test.ts — 9/9 PASS
  (7 restoreStructuredRefs unit tests incl. rewrite->restore
  round-trips for every form, quoted sheet names, string literals,
  graceful degradation; classic-write parse-back on the folded-in
  repro fixture + no-input-mutation assertions).
- packages/xlsx-adapter/tests/tables-native.test.ts — 14/14 PASS
  (combined run 23/23 with tables-restore).
- Neighbor suites PASS: streamingSave 7, futureFunctions 13,
  adapter-import-bugfixes 18, nativeSheetFeatures 19,
  offset-and-tables 5, adapter.test.ts PASS (in the 3-file run:
  29 passed / 1 failed, the 1 failure being the roundtrip-fidelity
  @ case since fixed — see caveat).
- packages/service/tests/directSave-structuredRefs.test.ts — 2/2
  PASS (verbatim production path with an edit on the table sheet:
  changedSheets ['Data'], Calc part byte-identical, table part +
  <tableParts> survive, parse-back returns the identical A1 model;
  adapter fallback via setCalculationMode: table part survives and
  refs are structured incl. cross-sheet Calc).
- packages/service/tests/directSave.test.ts — 12/12 PASS
  (combined service run 14/14).

Before -> after formula strings (Data table Sales, A1:D5):
- `=SUM(Data!$B$2:Data!$B$4)` -> `=SUM(Sales[Qty])`
- `=Data!$B$2*Data!$C$2` (row 2) -> `=Sales[@Qty]*Sales[@Price]`
- `=SUM(Data!$D$2:Data!$D$4)` -> `=SUM(Sales[Amount])`
- `=SUBTOTAL(109,Data!$B$2:Data!$B$4)` -> `=SUBTOTAL(109,Sales[Qty])`
- Calc: `=SUM(Data!$A$2:Data!$D$4)` -> `=SUM(Sales[#Data])`
- Real file: `=Imports!$C$7-Start_Year+1` -> `=tblActuals[@Year]-Start_Year+1`
  (source original: `tblActuals[[#This Row],[Year]]-Start_Year+1`)

CAVEAT: the full roundtrip-fidelity.test.ts file was not re-run
end-to-end after the coordinator's @-branch landed (the pre-fix run
failed 1/10 on beyond-excel-bxl3way.xlsx — the exact case the branch
fixes; the branch's own regression tests in tables-native pass, and
every other suite above ran post-fix). A single confirmation run of
that one file remains a worthwhile follow-up for the parent.

## 3rd-coordinator completion — streamingSave '' fix (2026-10-21 ~22:55 PDT)

Cross-cutting item-G-on-streaming-path CLOSED on the B surface:
- streamingSave.ts cellXml: the `input === null || input === undefined ||
  input === ''` branch split — null/undefined still emit the bare `<c/>`;
  literal '' now falls through to the text path and emits
  `<c r=".." t="inlineStr"><is><t></t></is></c>` (a real empty-string
  cell). Composes with the structured-ref restore (restore only touches
  formula bodies; '' is not a formula). Comment in source cites Item G.
- New regression test in tests/streamingSave.test.ts ('item G: literal
  empty-string cells survive regeneration (null stays absent)'): unit XML
  assertions ('' -> inlineStr empty cell incl. styled; null -> bare <c/>)
  + full-package parse-back ('' reads back as '', null stays absent).
- tsc --noEmit clean. Test run in flight at checkpoint time; result below.

## 3rd-coordinator verification (2026-10-21 ~23:10 PDT) — ITEM B COMPLETE
- streamingSave '' fix: regression test 'item G: literal empty-string cells
  survive regeneration (null stays absent)' — first attempt failed on a
  TEST assertion (the adapter's read densifies rows: B1 slot exists with
  null value; my `1 in rows[0]` expectation was wrong, not the fix).
  Corrected to null-semantics assertions (value == null, never '');
  re-run PASS. Full file + roundtrip-fidelity: 2 files, 18/18 PASS —
  incl. the beyond-excel-bxl3way.xlsx round-trip case the caveat named.
- Adapter dist rebuilt (tsc exit 0; dist/streamingSave.js carries the fix).
- Verdict: ITEM B FIXED (structured refs preserved on regenerated sheets
  + '' cells survive the streaming serializer). All regression evidence
  on disk: tests/tables-restore.test.ts 9/9, tests/streamingSave.test.ts
  8/8 (incl. the '' test), service tests/directSave-structuredRefs.test.ts
  2/2, service tests/directSave.test.ts 12/12, tests/roundtrip-fidelity.test.ts.
