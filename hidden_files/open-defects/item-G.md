# Item G — literal empty-string cells dropped on save (RESUME worker, 2026-10-21)

## VERDICT: FIXED (engine) — File 2 now loss-free for '' cells on both save paths
Engine fix in packages/engine/src/workbook.ts (5 sites) + regression tests
7/7 + full engine suite 1201/1201 + service suite 1527 passed/1 skipped +
xlsx-adapter suite 357/358 (sole failure = a sibling test's own wrong
assertion, detailed below). The streaming-serializer half of the
end-to-end path was fixed concurrently by the Item-B worker in their
assigned scope (streamingSave.ts), so the production save path is now
loss-free for '' cells end-to-end — proven by the File-2 re-run below.
NOT RUN: the browser-stack variant of the audit (final-run.mjs/reopen.mjs)
— it needs the isolated gateway+web stack rebuilt from a tree sibling
workers were actively editing; the headless harness below replays the
same file, the same 5 mods and both real save paths instead, and the
reopen layer was done at engine level (fresh EngineWorkbook load of the
saved bytes, values verified).

## Defect confirmed intact in source (packages/engine/src/workbook.ts)
- L2363 `trackCellInput`: `if (input === null || input === '') this.cellInputs.delete(key);`
- L2513 `getBulkReadback`: `if (input === null || input === '') continue; // snapshot parity`
- L2553 `getPinnedCellState`: `if (input === null || input === '') return undefined;`
- Additional site found by this worker (not in the brief's list):
  `toSnapshot()` (~L2682): `if (input !== null && input !== '') cells.push(...)` — same drop.

## Empirical pre-fix probe (built dist, node, EngineWorkbook directly)
- Ctor load `{Sheet1: [['', 'x'], [null, 42]]}`:
  - `getValue(A1)` = `{kind:'string', value:''}` and `getSerialized(A1)` = `''`
    — HyperFormula (the model) DOES hold '' distinct from null (A-null cell: value null, serialized null).
  - `getTrackedCells()` = only B1 'x' and B2 42 — A1 '' is NOT tracked.
  - `getBulkReadback()` = only those two cells; `toSnapshot()` = only those two; `getPinnedCellState(A1)` = undefined.
- Same result for `setCell(ref,'')` and `setCellRaw(ref,'')`, and for overwriting 'b' with ''.
- Overwriting with `null` gives getValue/getSerialized = null (genuinely empty).

## Key consequence (traced)
`getBulkReadback` iterates `getTrackedCells()` (= the `cellInputs` map), NOT raw
HyperFormula dimensions. So fixing only the L2513 skip is NOT sufficient:
a '' cell never enters the iteration set at all. The tracking site (L2363)
must store '' for the readbacks to ever see it. `toSnapshot` is different —
it iterates HF sheet dimensions and calls `getSerialized`, so its own ''-skip
is independently load-bearing there.

## Setter-contract investigation (COMPLETE)
- Clear semantics in the codebase are `null`, not '': protocol `clearCell` /
  gateway collab mapping returns `setCell … value: null` for clears; web
  clear/delete handlers pass `value: null`; insert/delete-cell helpers pass null.
- No caller was found that relies on `setCell(ref, '')` meaning "clear".
  One web caller writes '' as a *value* (advancedFilter blanking trailing
  rows) — under Excel semantics that IS a literal '' cell, so storing it is
  correct, and it previously survived in HyperFormula anyway (only the
  tracking/readback layer pretended it wasn't there).
- DECISION: '' is storable through every setter (setCell / setCellRaw /
  setFormula funnel = trackCellInput). `null` remains the only clear signal.
  This was REQUIRED, not optional: the load path (adapter -> constructor)
  goes through setCell -> trackCellInput, so leaving the setter deleting ''
  would have kept '' cells out of getTrackedCells() and therefore out of
  getBulkReadback() forever, regardless of the readback-skip fixes.

## FIX APPLIED (packages/engine/src/workbook.ts only, 5 sites)
1. `trackCellInput`: `willBeTracked = input !== null`; store unless null
   (was: delete on ''). Comment records the Excel/ISBLANK rationale + the
   null-only clear contract.
2. `getBulkReadback` (L2513): skip only `input === null` (was null|'').
3. `getPinnedCellState` (L2553): undefined only for null (was null|'').
4. `toSnapshot` (~L2683): push cells when `input !== null` (was also != '').
5. `duplicateSheet` (~L1443): copy when `input !== null` (was also != '') —
   additional ''-skip site found by this worker's sweep.
Other '' comparisons in engine src are formula-function semantics
(criteria/spill/text helpers), not cell-storage readbacks — untouched.
Engine builds clean: `npx tsc -p tsconfig.json` exit 0.

## Post-fix probe (built dist, same script as pre-fix)
- Ctor [['', 'x'],[null,42]]: tracked = '', 'x', 42; bulk = '' with
  value {kind:'string',value:''}, 'x', 42; snapshot includes A1 ''.
  Null cell absent everywhere (unchanged).
- setCell('') and setCellRaw(''): '' tracked + in bulk + in snapshot.
- Overwrite 'b'->'' : '' present. Overwrite ->null: cell gone (clear intact).

## DOWNSTREAM FINDING — RESOLVED BY SIBLING WORKER CONCURRENTLY (2026-10-22 ~06:10 UTC)
The streamingSave '' drop (below) was FIXED in parallel by the Item-B
worker, whose assigned scope includes streamingSave.ts: cellXml now
returns the bare `<c/>` only for null/undefined, and '' falls through to
the text path emitting `<c r=".." t="inlineStr"><is><t></t></is></c>`
(the exact fix shape flagged below), with their own regression test
"item G: literal empty-string cells survive regeneration (null stays
absent)" in packages/xlsx-adapter/tests/streamingSave.test.ts.
In the full xlsx-adapter suite run (06:29-06:40 UTC): Test Files
1 failed | 41 passed (42); Tests 1 failed | 357 passed (358). The sole
failure is that new test's LAST assertion,
`expect(1 in data.rows[0]!).toBe(false)` (streamingSave.test.ts:120):
the adapter's parse-back rows are DENSE arrays, so index 1 (the null B1)
exists holding null — `in` is true. All the '' assertions in that test
PASS ('' emits inlineStr, parses back as '', styled '' too, null emits
bare <c/>). So the serializer behavior is correct; the failing assertion
mis-models the dense-row contract (should assert rows[0][1] === null).
That test file is the sibling's — I did not edit it; flagging to parent
for the sibling to correct their assertion.
=> With the engine fix + this streaming fix, BOTH save paths now carry
'' end-to-end. (Service directSave suite result pending in chain.)

## DOWNSTREAM FINDING (outside my assigned scope — flagged, not fixed here) [superseded by the section above]
`packages/xlsx-adapter/src/streamingSave.ts` `cellXml` (~L238):
`if (input === null || input === undefined || input === '') return <c r=".."/>`
— the streaming serializer (service directSave path) ALSO drops '' once the
bulk reaches it. Proven headlessly (pre-fix bulk hand-fed with '' cells):
serializeLiveWorkbook on a regenerated sheet -> adapter parse-back rows
[[null,'x'],['a',null]] and SheetJS shows no cell objects for the '' cells.
That file is the Item-B worker's active edit surface (their item-B.md plan
step 3 rewrites cellXml for structured refs), and my brief restricts me to
packages/engine + the audit harness, so I did NOT edit it. The one-line fix
needed there: emit an empty-string cell for input '' (e.g.
`<c r=".." t="inlineStr"><is><t></t></is></c>`), distinct from the null
styled-empty branch. NOTE the snapshot/adapter save path does NOT have this
defect: XlsxAdapter.write's inputToCell already maps '' -> {t:'s', v:''}
with a comment stating the same fidelity requirement, and the gateway/web
snapshotToWorkbookData converters place cell.input verbatim.

## Regression tests — PASS (packages/engine/tests/empty-string-cells.test.ts, 7 tests)
Run: `npx vitest run tests/empty-string-cells.test.ts` -> Test Files 1 passed,
Tests 7 passed (duration 230s wall under heavy concurrent load from sibling
suites; the File-2 test alone took 203s of that — workbook construction
under contention). An earlier attempt died with "Worker exited
unexpectedly" at 0 tests under the same load; the re-run passed all 7.
Tests:
1. load path: ctor '' cells in tracked/bulk/snapshot/pinned; null absent.
2. setCell('')/setCellRaw('') store; setCell(null) is the only clear.
3. EngineHost bulkReadback + save-pin pinned readback carry '' (pin taken,
   cell edited away, pinned read still returns pin-time '').
4. fromSnapshot(toSnapshot) preserves ''.
5. duplicateSheet copies ''.
6. Save round-trip: '' stored via the empty shared string (verified raw
   with SheetJS: source cells are {t:'s', v:''}) -> adapter load -> engine
   -> snapshot save (XlsxAdapter.write) -> SheetJS raw parse-back shows
   {t:'s', v:''} at Data!A1, Data!C1, Data!C2, Only!A1; blank B2 stays
   absent; adapter parse-back '' address set identical.
7. File-2 regression: audit fixture adapter-loads with exactly 85 ''
   cells; engine bulk '' = 85; snapshot '' = 85; full save -> adapter
   parse-back '' address set EQUAL to the original set.


## Closure worker — stage 2 (xlsx-adapter FULL suite, 2026-10-22 ~07:00 UTC)
- Re-ran the full adapter suite post item-B's assertion correction
  (streamingSave.test.ts:121 now asserts `rows[0][1] == null` / not ''):
  **Test Files 42 passed (42), Tests 358 passed (358), exit 0**
  (log: open-defects/logs/xlsx-adapter-suite-closure.log, 310 s wall).
  The chain's 06:29-06:40 run had shown 1 failure — the stale-tree
  `1 in data.rows[0]` assertion, since corrected by the item-B worker;
  current tree is green. The MISMATCH> lines in the log are informational
  stdout from the formula-audit smoke test, not failures.
- Note: suite count grew 42->42 files / 357->358 tests vs the chain run
  (the item-G regression test now passes).


## Closure worker — stage 3 (service save suites, 2026-10-22 ~07:01 UTC)
- Re-ran the production save-path suites fresh:
  tests/directSave.test.ts 12/12 + tests/directSave-structuredRefs.test.ts 2/2
  = **14/14 PASS**. Covers unedited verbatim save, mid-write fault
  isolation, structured-ref restore on regeneration, and table-part survival.
- Plus the chain's FULL service suite (06:40-06:44 UTC, post both fixes):
  **Test Files 81 passed (81), Tests 1527 passed | 1 skipped, exit 0**
  (log: open-defects/logs/service-suite.log). No workbook/readback/
  serialization file in the tree is touched by anything that changed
  since, so both results stand.


## Closure worker — stage 4: File-2 audit re-run (2026-10-22 ~07:30 UTC)

### Harness corrections made by this worker (documented, both in itemg-f2.mjs)
1. The harness's first two runs passed `data.definedNames` (the ORIGINAL names)
   into `serializeLiveWorkbook` — a harness artifact: `EngineWorkbook.getDefinedNames()`
   is the stale construction list, while production (gateway engineSvc.ts:2315)
   passes `host.getDefinedNames()`, which delegates to `getLiveDefinedNames()`
   (HyperFormula's live named-expression table, shifted on structural ops).
   Fixed to `host.getDefinedNames()`; stale-names run1 artifacts preserved at
   hidden_files/roundtrip-audit/itemg-f2/run1-stalenames/ for the record.
   (`itemg-f2-pathB-rerun.mjs` documents the focused PATH-B regeneration.)

### PATH B = streaming directSave (the production save path) — FINAL numbers
File: hidden_files/roundtrip-audit/itemg-f2/itemg-f2-saved-streaming.xlsx
(regenerated 07:25 UTC with live names; mode=verbatim, fallback=none).
- **'' cells: ALL 85 survive.** Address-set equality proven both directions
  (orig-minus-saved = ∅, saved-minus-orig = ∅) across Data Definitions (12),
  Dropdown Lists (70), AttributePTDMAP (3). Raw package XML: exactly 85
  `<c t="inlineStr"><is><t></t></is></c>` cells; sharedStrings has NO empty
  entry; null cells remain absent (no spurious '' created).
- **Cell diffs: 45** = 5 intended mods (A9 edit, A36=2.544, C9 new formula,
  A13 clear, insertRows@21) + mechanical consequences only:
  classifier accounts 44 (intended/downstream-of-edit/shift classes incl.
  38 verified formula-text matches at row+1, 0 mismatches; 4 ff→gg downstream
  value updates; 2 shift-additions A39/B39). The 1 "unexplained" (A21) is a
  CLASSIFIER boundary gap, manually closed: saved A22's formula text is
  byte-identical to orig A21's (covered by the 38-match check), its cached
  value correctly recomputed ff→gg; the classifier only matches counterparts
  at the same/shifted address and has no rule for the insert row's own cell
  moving down. NOT a data defect (the original browser-flow audit listed the
  same A21 entry as unexplained for the same reason).
- **Package level: 19 changed / 0 missing / 1 added** — changed =
  [Content_Types].xml, xl/styles.xml, xl/workbook.xml, 16 sheet parts;
  added = docProps/custom.xml (designed serializer class). IDENTICAL to the
  original browser-flow audit's package profile (draw-classify.json).
- **Names: 16 ref-changed, each exactly +1 row on 'International Settings'
  for rows ≥21** (verified programmatically; zero non-conforming shifts).
- **Reopen (engine level)**: 16 sheets load; bulk '' = 85; spot checks —
  A9=gg/ edit, A10 downstream gg/, C9 gamma formula evaluates,
  A13=null cleared, A22 shifted formula evaluates to gg/IntMiscData.txt,
  A37=2.544 number. (itemg-f2/itemg-reopenB.json.)

### PATH A = snapshot → XlsxAdapter.write (fallback path)
- **'' cells: ALL 85 survive**, address sets identical (orig-minus-saved = ∅,
  saved-minus-orig = ∅); 16 nameDiffs all mechanical (+1-row shifts).
- **Package level: 43 parts MISSING** (drawings×3, vmlDrawing×2, media
  images×23, comments×2, externalLinks×2, printerSettings×3, sharedStrings,
  6 sheet rels) + xl/metadata.xml added. This is the PRE-EXISTING behavior of
  the snapshot-regeneration fallback (XlsxAdapter.write rebuilds the package
  from sheets only) — NOT item G, NOT the production path (the browser-flow
  audit profile matches PATH B), and NOT a regression from this fix. Stated
  plainly for the parent: if the snapshot path is ever a user-facing save
  route, this is a separate data-loss defect to file.

### Reopen level — browser screenshots: NOT RUN (subagent limitation)
The audit's reopen flow (reopen.mjs / final-run.mjs) drives a real Chromium
via playwright against the isolated web stack — live-browser work this
subagent cannot perform. Engine-level reopen (above) is done; the
screenshot-per-sheet self-inspection remains for a browser-capable parent
to delegate. Everything else in stage 4 is complete.

## CLOSURE VERDICT: ITEM G — LOSS-FREE (defect D4 fixed on both save paths)
- Engine: full suite 56 files / 1201 tests green (chain, post-fix).
- xlsx-adapter: full suite 42 files / 358 tests green (closure re-run,
  post item-B assertion correction).
- Service: full suite 81 files / 1527 passed·1 skipped green (chain) +
  directSave 12/12 + directSave-structuredRefs 2/2 fresh.
- File-2 re-run: 85/85 '' cells survive BOTH save paths with identical
  address sets; PATH B (production) three-layer diff = intended +
  mechanical consequences only, package profile identical to the original
  browser-flow audit, names shifted correctly, engine reopen clean.
- Residual observations (not item G): (a) snapshot-fallback drops 43
  media/drawing/comment parts — pre-existing, file separately if that path
  is user-facing; (b) classify.mjs has no rule for the insert row's own
  displaced cell (A21 flagged unexplained, manually closed).

## File-2 re-run — status
- Regression test 7 (above) IS a File-2 load->save->parse-back run on the
  real fixture: 85/85 '' cells survive, address set identical. PASS.
- Full mod-replay harness (hidden_files/roundtrip-audit/itemg-f2.mjs:
  adapter load -> EngineHost, the audit plan's 5 mods, then BOTH save
  paths + engine-level reopen + summary JSON): three launch attempts on
  2026-10-21 evening all died silently during EngineWorkbook construction
  with no stderr — box load average 26-34 from sibling workers' suites,
  ~1.8 GB RAM free of 8 GB; consistent with kernel OOM-kill (the audit's
  own engine service ran this file with --max-old-space-size=6144).
  Retrying when load subsides; the browser-stack variant (final-run.mjs)
  was NOT attempted: it requires rebuilding/starting the isolated
  gateway+web stack from a tree sibling workers are actively editing.
- Three-layer diff tooling (dump.mjs/diff.mjs/classify.mjs) will be run
  over the harness outputs once a run completes.

## Stages
- [x] Fix (engine)
- [x] Regression tests (7/7)
- [x] FULL ENGINE SUITE: `npx vitest run` in packages/engine ->
  Test Files 56 passed (56), Tests 1201 passed (1201), exit 0
  (06:21-06:29 UTC, log: open-defects/logs/engine-suite.log).
  Includes the 7 new Item-G tests. No failures to attribute.
- [x] XLSX-ADAPTER SUITE: Test Files 1 failed | 41 passed (42);
  Tests 1 failed | 357 passed (358) (log: logs/xlsx-adapter-suite.log).
  Sole failure = sibling's new streamingSave Item-G test, last assertion
  only — SOLO RE-RUN CONFIRMED deterministic, same assertion
  (streamingSave.test.ts:120, `1 in data.rows[0]` vs the adapter's dense
  fill(null) rows; every '' assertion in that test passes). Not caused
  by my change (no adapter code touched by me).
- [x] SERVICE SUITE: Test Files 81 passed (81); Tests 1527 passed |
  1 skipped (log: logs/service-suite.log). Includes directSave tests.
- [x] File-2 mod-replay harness + three-layer diff — COMPLETED
  2026-10-22 ~06:46 UTC (after earlier OOM-killed attempts, exit=137,
  under sibling load; final run on a quieter box, adapter dist rebuilt
  from current src so Path B includes the sibling's streaming fix):
  Harness: hidden_files/roundtrip-audit/itemg-f2.mjs (adapter load ->
  EngineHost -> the audit plan's exact 5 mods: edit A9, edit A36=2.544,
  formula C9 =A9&"gamma/", clear A13, insertRows at row 21) ->
  bulk '' after load 85, after mods 85; snapshot '' 85.
  * PATH A (snapshot -> XlsxAdapter.write): parse-back '' = 85/85.
  * PATH B (streaming directSave, insertRows forces ALL 16 sheets to
    regenerate from the bulk — the audit's exact loss configuration):
    mode=verbatim, fallback=none, parse-back '' = 85/85.
  * CELL layer (audit dump.mjs/diff.mjs, SheetJS): Path B diff vs the
    original = 45 cellDiffs, of which classify.mjs classes 44 as
    intended / shift / downstream-of-edit / structured-expansion; the 1
    "unexplained" is International Settings!A21 = the inserted blank
    row's cell (saved {f:null,v:null,t:'z'}; the A21 formula is intact
    at A22 — the identical entry appears in the audit's own pre-fix
    draw-diff.json). Removed '' cells: 0 on BOTH paths (was 85).
    Spot checks on saved B: A9 edited, C9 formula + cached
    ".../gg/gamma/", A13 absent (cleared), A37 (shifted A36) = 2.544,
    B22 shifted label intact.
  * PACKAGE layer (Path B): partMissing 0, partAdded 1
    (docProps/custom.xml — designed serializer class), partDiffs 18
    (regenerated sheet/style parts — the designed classes from the
    direct-save evidence), nameDiffs 0 (all 512 defined names intact).
    Path A (adapter fallback) drops non-sheet parts by design of the
    dense fallback (43 parts missing) — pre-existing fallback behavior,
    unrelated to ''; its '' count is still 85/85 with 0 '' removed.
  * REOPEN layer (engine level, itemg-reopenB.mjs on the Path-B saved
    file; JSON: itemg-f2/itemg-reopenB.json): fresh load = 16 sheets,
    bulk '' = 85, A9=".../gg/", A10 (downstream formula) =".../gg/",
    C9=".../gg/gamma/", A13=null (cleared), A22 (shifted formula)
    =".../gg/IntMiscData.txt", A37=2.544. All correct.
  => File 2 is LOSS-FREE for the Item-G defect (and the three-layer
  diff shows no other unexplained cell loss on the production path).
