# ITEM A — `_xlcn.*` connection names degrade to #ERROR! on names-block regeneration

Status: IN PROGRESS (checkpointed 2026-10-21, resume worker)

## Step 0 — re-derived facts (from current code, read this session)

- Original fixture `test-data/perf-fixtures/perf-p75.xlsx`, `xl/workbook.xml`:
  9 `_xlcn.*` defined names, all `hidden="1"`, refs are STRUCTURED TABLE REFS,
  e.g. `<definedName name="_xlcn.WorksheetConnection_BXL3WayAnorexic.xlsxtblBS1" hidden="1">tblBS[]</definedName>`
  (also tblPAA[], tblPFS[], tblCal[], tblCF[], tblDebt[], tblDep[], tblIS[], tblWCS[]).
  `xl/connections.xml` range connections reference these names via
  `<x15:rangePr sourceName="_xlcn.…"/>` (connections.ts parses this on import).
- Audit-saved files (`hidden_files/roundtrip-audit/p75/p75fin-saved.xlsx`,
  `p75rt-checkpoint.xlsx`): all 9 names present but ref literally `#ERROR!`.
- Import: adapter.ts keeps every non-`_xlnm.` name in `data.definedNames`
  (incl. `_xlcn.*`, ref `tblBS[]`); fastSheetParse.parseDefinedNames same.
  NOTE: `DefinedName` (engine storage.ts) has NO hidden/comment fields —
  only {name, ref, sheet}.
- Engine construction (engine workbook.ts, READ-ONLY context — out of my
  edit scope): NamedRangeRegistry.define() → HyperFormula
  addNamedExpression(name, `=tblBS[]`). Structured-ref syntax is not HF-
  parseable → the named expression holds a parse error.
  getLiveDefinedNames(): the LIVE HF-serialized entry WINS over the
  construction-time verbatim copy (seen-key dedupe), so the persisted
  desired table carries ref `#ERROR!` for exactly these 9 names.
- Save (current path): service directSave.ts calls
  streamingSave.definedNamesEqual(wbXml, desired) → mismatch (#ERROR! vs
  tblBS[]) → regenerateWorkbookXml(wbXml, desired), which preserves ONLY
  `_xlnm.*` elements verbatim from the source block and re-emits every
  other name from `desired` (with NO hidden attribute) — writing #ERROR!
  into the saved workbook.xml. Classic adapter.write() mirrors
  data.definedNames via SheetJS (Workbook.Names) — same desired table,
  same exposure when the caller hands it the live names.
- names.ts isEngineBindableName: `_xlcn.…` fails HF_NAME_SHAPE? No — it
  passes the shape/A1/R1C1 checks, so it IS treated as bindable; the ref
  shape (table structured ref) is what HF cannot parse.

## Fix direction (within assigned scope: xlsx-adapter names/connections + streamingSave surgical)

`_xlcn.*` names are connection bookkeeping (like `_xlnm.*` print names),
not formula names: preserve their source elements VERBATIM (name, ref,
hidden flag, all attrs) on names-block regeneration, and exclude them
from the regenerated desired table (in definedNamesBlock/normalizeNames
equality) so they are never re-emitted as #ERROR! / duplicates. This also
locks classic-write parity if feasible in scope.

## Repro / validation

PENDING — see below as filled.

## Resume worker progress (2026-10-21 ~21:58 PDT)

- STEP 1 CORE FIX DONE (streamingSave.ts, surgical):
  - Added exported `isVerbatimPreservedDefinedName(name)` — case-insensitive
    `_xlnm.` OR `_xlcn.` prefix check.
  - `normalizeNames()` now filters via that helper (was `_xlnm.`-only), so
    `definedNamesEqual()` ignores `_xlcn.*` on BOTH sides (a degraded
    `#ERROR!` live ref alone no longer forces regeneration) and
    `definedNamesBlock()` never re-emits them.
  - `regenerateWorkbookXml()` now preserves `_xlcn.*` source elements
    verbatim (all attrs incl. `hidden="1"`, original ref) exactly like
    `_xlnm.*`; renamed internal `preservedXlnm` param to
    `preservedVerbatim`. Header comment updated.
  - `synthesizeWorkbookXml()` inherits the exclusion via
    `definedNamesBlock`/`normalizeNames` (no source = nothing verbatim
    to preserve; `_xlcn.*` without its source connections part is not
    re-emitted degraded).
- STEP 2 regression test: DONE — new file
  `packages/xlsx-adapter/tests/itemA-xlcn-names.test.ts` (4 tests):
  minimal synthetic (degraded-only equality = true; forced regen
  preserves both `_xlcn` elements byte-verbatim incl. hidden="1",
  no #ERROR!, Cost edit + _xlnm preservation still land) and real
  perf-p75.xlsx (desired = source names with _xlcn→#ERROR! + DPY edit
  → exact directSave branch → parse-back: 9 _xlcn with original refs,
  all raw elements hidden="1", zero #ERROR!, total name count
  unchanged, DPY edit present; degraded-only table compares equal).
- STEP 3 suite run: NEARLY COMPLETE — full-suite run was killed by a
  runtime restart ~11.5 min in; partial log (~/tmp-itemA/full-suite.log)
  shows every completed file PASSING up to the kill point (incl.
  nativeSheetFeatures 19, drawings 14, threadedComments 15, charts 35,
  pivotTables 14, adapter-import-bugfixes 18, tables-native/restore,
  smartart 10, protection 8, pageSetup 10, audit-v2-smoke, streamingSave
  7, externalLinks 13, formulaRecovery 22, adapter 9, styles-xml 6,
  itemA-xlcn-names 5, fastSheetParse 4; zz-cycle5 audit 276s pass).
  Chunk 1 (~/tmp-itemA/chunk1.log): connections 4, names-rewrite 10,
  names-roundtrip 3, futureFunctions 13, metadataJson 6, pageBreaksXml
  7, error-cells 4 = 47/47 PASS.
  Chunk 2b (~/tmp-itemA/chunk2b.log): numfmt 18, macroProject 7,
  cube-functions-fixture 3, offset-and-tables 5 PASS; roundtrip-fidelity
  1 failure in that concurrent run (all 10 diffs = item B's
  structured-ref restoration pattern on the Imports sheet, zero
  defined-name diffs) — SOLO RE-RUN (chunk3.log): roundtrip-fidelity
  10/10 PASS, so that failure was concurrent-run interference while
  item B code was landing mid-run, not this fix.
  Chunk 3 (~/tmp-itemA/chunk3.log): roundtrip-fidelity 10/10,
  zz-itemA-repro 4/4, zz-itemA-engine 1/1 PASS. The repro on FIXED code:
  `definedNamesEqual(src, live-degraded)` = true (was false pre-fix)
  and forced regen emits all 9 `_xlcn` elements verbatim incl.
  hidden="1" with original tbl*[] refs (was #ERROR! flagless pre-fix).
  tsc --noEmit: CLEAN (exit 0).
  Chunk 4 = audit-v2-full, real-world-audit, real-world-detail (long
  corpus audits): attempted twice, killed BOTH times by runtime
  restarts before the first file completed (~/tmp-itemA/chunk4.log,
  chunk4b.log) — NOT RUN to completion. Mitigating evidence: their
  sibling audit-v2-smoke PASSED and the heaviest corpus audit
  (zz-cycle5, 99 files, 276s) PASSED post-fix in the full-suite run.
  zz-aprobe/zz-bisect/zz-repro/zz-itemb-repro are other items' scratch
  files, not run by this worker.

## FINAL VERDICT (resume worker, 2026-10-21): FIXED

- Streaming save path (the production path, directSave): `_xlcn.*`
  names can no longer degrade — degraded-only tables compare EQUAL
  (verbatim part copy, no regeneration), and forced regeneration
  preserves all `_xlcn.*` source elements verbatim (name, ref,
  hidden="1", all attrs) exactly once, with zero `#ERROR!`. Proven by
  new regression file (5/5) and by the pre-existing scratch repro
  flipping from `#ERROR!`/flagless (pre-fix) to verbatim+hidden
  (post-fix) on the real perf-p75.xlsx.
- Classic adapter.write parity (feasible subset): verbatim `_xlcn.*`
  kept with `hidden="1"` restored; degraded `#ERROR!` `_xlcn.*`
  entries omitted instead of written (no source package exists in
  that path to restore the original ref from — documented in code).
- Files changed (all inside packages/xlsx-adapter):
  src/streamingSave.ts (core fix + restoreXlcnHiddenFlags helper),
  src/adapter.ts (classic parity: mirror filter + inject pass),
  src/index.ts (2 new exports), tests/itemA-xlcn-names.test.ts (new).
  No progress.md edits, no push, no out-of-scope files touched.
- Validation: tsc clean; every xlsx-adapter suite file that completed
  a run passed (only exception: one concurrent-run roundtrip-fidelity
  failure proven to be item-B interference, solo re-run 10/10 PASS).
  Not run to completion: audit-v2-full / real-world-audit /
  real-world-detail (killed twice by runtime restarts, see above).
- STEP 3 (targeted) DONE —
  `tests/itemA-xlcn-names.test.ts` 4/4 PASS + `tests/streamingSave.test.ts`
  7/7 PASS (run with TMPDIR=~/tmp-itemA: /tmp tmpfs is 100% full from
  other workers' files and vitest dies ENOSPC with the default TMPDIR;
  first attempt failed exactly that way, re-run passed).
  Pre-fix scratch repro (zz-itemA-repro, background run) confirmed the
  mechanism on unpatched code: regen with degraded desired wrote all 9
  `_xlcn` as `#ERROR!` with NO hidden attr; engine scratch
  (zz-itemA-engine) confirmed live table = `#ERROR!` for `_xlcn.*`.
- STEP 4 classic-write parity: DONE (feasible subset) —
  `adapter.write` has no source package, so verbatim restoration of a
  degraded ref is impossible there by construction; instead:
  (a) the SheetJS Names mirror now OMITS `_xlcn.*` entries whose ref
  degraded to `#ERROR!` (never writes #ERROR!; classic path drops
  connections.xml anyway, so the degraded bookkeeping entry carries no
  usable info), and (b) new `restoreXlcnHiddenFlags()` in
  streamingSave.ts + `injectXlcnHiddenFlags()` bytes pass in
  adapter.write restores `hidden="1"` on verbatim `_xlcn.*` elements
  SheetJS emits flagless. Also exported both new streamingSave helpers
  from index.ts. Regression file now 5 tests incl. classic parity —
  ALL PASS (with streamingSave.test.ts 7/7 in same run).
