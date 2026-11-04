# Item C — The 200k-op save-journal cap (SAVE_OPS_CAP)

Worker: open-defects sweep worker 14224817, item C.
Date: 2026-10-21 (PDT).

## VERDICT: FIXED

The cap was NOT dead code and NOT a benign perf degradation. Past the
cap, saves silently produced wrong files for any session whose history
included a sheet-set/structural change: an added sheet was silently
lost from the saved file and a deleted sheet silently resurrected —
while the save reported success and the package verification passed.
Root cause + fix below; regression test pins the at-cap behavior.

## STEP 0 — re-derivation against the current revision model

Design-doc check (design-docs/revision-model-save-and-coauthoring.md):
§2 forbids workbook rebuild / journal replay in the ordinary save path
— serialization is one streaming pass over the LIVE model. §1 + §5:
the DURABILITY journal is segmented (JOURNAL_SEGMENT_MAX_OPS, default
200) and pruned at checkpoints under the retention rule. The save
journal at issue here is neither of those: it is a memory-only
serializer-planning aid in the gateway engine service. Checkpointing
bounds the durability journal; it does NOT (and cannot) truncate the
save journal, because a checkpoint does not rebase
`state.sourceBytes` — the changed-sheet derivation must cover every
op since the retained source bytes were loaded. The cap + wholesale
drop is the save journal's bound (≤ SAVE_OPS_CAP small op objects).

### Traced call path (all references; file:line at fix time)

`SAVE_OPS_CAP` exists only in
`packages/gateway/src/services/engineSvc.ts` (plus stale `dist/`
build output, regenerated on build):

- Definition: engineSvc.ts:787 (was :763, with a stale comment
  claiming "the worker rebuild is not attempted" — the W21 per-save
  worker rebuild was retired by Phase 1 direct streaming; corrected).
- Recorded: `runExecuteInternal` (the single sequencer path shared by
  POST /execute and POST /ops) — now engineSvc.ts:3566 via the new
  `recordSaveJournalOp`. This is the ONLY write site for the journal.
- Consumed: `runDirectSave` — now engineSvc.ts:2397 via the new
  `directSaveOps(state, sheetNames)`, feeding
  `serializeLiveWorkbook` (packages/service/src/save/directSave.ts:
  serializeLiveWorkbook) as `input.ops`.
- Resets: `registerSession` (engineSvc.ts:2676), `evictSession`
  (:3087), `rehydrateSession` (:3210, rebuilt from the replayed
  journal entries). Initial state: engineSvc.ts state literal.
- The other serializer caller, `saveWorkerCore.ts` (W21 worker,
  item F's territory), is a non-ordinary fallback and does not use
  this journal. Desktop (`apps/desktop/src/direct-save.ts`) keeps its
  own save-op list with NO cap and never drops it mid-session, and
  builds parsedSheets from the SOURCE parse — not affected.

### What actually happened at the cap (pre-fix, proven)

`runExecuteInternal`, per accepted mutating op:

```
if (state.saveOps.length >= SAVE_OPS_CAP) { saveWorkerEligible = false; saveOps = []; }
else saveOps.push({ op: rawCmd });
```

`runDirectSave`, when `!saveWorkerEligible`, replaced the ops list
with per-sheet markers only:

```
sheetNames.map(name => ({ cmd: 'setCell', ref: { sheet: name, row: 0, col: 0 } }))
```

The in-code comment claimed this was sound because "the direct path
does NOT depend on journal completeness for STATE (it reads the live
model)". True for cell VALUES — but the ops list carries a second,
planning-critical signal. In `serializeLiveWorkbook`
(directSave.ts), the adapter fallback fires iff (a) the live sheet
names differ from `parsedSheets` keys, or (b) an op is not a cell op,
not a name op, and not a row/col op ("unhandled structural":
addSheet, deleteSheet, renameSheet, duplicateSheet, moveSheet,
setCalculationMode). On the GATEWAY path (a) is vacuous: runDirectSave
builds `parsedSheets` by iterating the LIVE sheet names
(engineSvc.ts parsedSheets loop), so its keys always equal the live
set. The ops list is therefore the ONLY signal that a sheet-set
change or setCalculationMode happened since load. The markers erased
it. (Row/col ops were safe: markers force every sheet regenerated,
which is exactly what row/col handling does. Name ops were safe:
defined names are merged independently from the live host. Cell ops
were safe: values come from the live bulk.)

Empirical proof (pre-fix harness, scratch vitest since deleted;
replicated the exact gateway at-cap construction — markers +
gateway-shaped parsedSheets — against the real serializer):

- pre-cap addSheet in ops → mode=adapter-fallback
  (structural-op:addSheet), parse-back sheets [Data, Other, NewSheet] ✓
- at-cap addSheet → mode=verbatim, verifyXlsxPackage PASS,
  parse-back sheets **[Data, Other] — NewSheet silently lost**
  (its regenerated part is orphaned: verbatim workbook.xml never
  references it)
- at-cap deleteSheet → mode=verbatim,
  parse-back sheets **[Data, Other] — deleted sheet 'Other'
  silently resurrects** from its verbatim-copied source part
- at-cap cell-only → verbatim, all sheets regenerated, values exact ✓

User-visible behavior at the cap, pre-fix: save/download/autosave
checkpoint all "succeed" (200, valid package) while the stored file
loses an added sheet / regains a deleted one; a checkpoint then makes
the wrong bytes the snapshot + autosave library entry, so the loss
persists across rehydrate. The flag also never reset until
reload/rehydrate, so every later save in the session was exposed.

## FIX (packages/gateway/src/services/engineSvc.ts only)

Keep the cap (it correctly bounds journal memory) and keep the
marker behavior for cell history — but never drop the structural
signal:

1. `SAVE_STRUCTURAL_CMDS` (engineSvc.ts:801): the finite six-cmd set
   matching the serializer's unhandled-structural class.
2. `EngineState.saveStructuralCmds: Set<string>` (:726): the DISTINCT
   structural cmds seen since load. Bounded by construction (≤ 6
   entries no matter how many ops), updated on EVERY recorded op.
3. `recordSaveJournalOp(journal, cmd, rawCmd)` (:826): the extracted,
   production recording branch — summary update + the existing cap
   rule verbatim. `runExecuteInternal` now calls it (:3566).
4. `directSaveOps(journal, sheetNames)` (:871): the extracted
   production save-side derivation. Journal intact → recorded ops
   (unchanged). Journal dropped → per-sheet setCell markers PLUS one
   bare `{ cmd }` per summary entry, so the serializer's planning
   class at the cap is identical to the pre-cap plan for the same
   history. `runDirectSave` now calls it (:2397).
5. `resetSaveJournal(journal, ops?)` (:847): resets list + flag and
   rebuilds the summary from the given ops; used by registerSession,
   evictSession, and rehydrateSession (summary rebuilt from the
   replayed journal entries there).
6. Stale comments corrected: SAVE_OPS_CAP no longer references the
   retired worker rebuild; EngineState.saveOps doc + runDirectSave
   comment describe the structural-summary rule.

No serializer change was needed; no design-doc conflict: the fix
keeps §2's one-pass live-model serialization — the adapter fallback
it can now correctly select at the cap is the serializer's own
designed path for structural history (and was the pre-cap behavior
for the same history all along).

## Regression test

`packages/gateway/tests/saveJournalCap.test.ts` — 8 tests, all pass.
Drives the REAL production helpers (`recordSaveJournalOp` /
`directSaveOps` / `resetSaveJournal`, imported from engineSvc) past
the real 200,000 cap in-process, then feeds the resulting ops into
the real `serializeLiveWorkbook` with gateway-shaped inputs and
parses the output back:

1. journal accounting: cap drops the op list; summary stays bounded
   (≤ SAVE_STRUCTURAL_CMDS.size under hammering).
2. pre-cap parity: intact journal passes ops through unchanged.
3. at-cap addSheet: sheet SURVIVES (adapter-fallback,
   fallbackReason structural-op:addSheet; NewSheet content + edited
   cell exact in parse-back). [the pre-fix data-loss case]
4. at-cap deleteSheet: sheet stays deleted. [the resurrection case]
5. at-cap setCalculationMode: adapter-fallback with its reason;
   values exact.
6. structural op recorded AFTER the cap is retained too.
7. at-cap cell-only history: NO fallback — verbatim, every sheet
   regenerated, values + defined names exact (no over-triggering).
8. resetSaveJournal rebuilds the summary from replayed ops
   (rehydrate shape); fresh reset clears it.

## Test runs (this session)

- `packages/gateway`: `npx tsc -p tsconfig.json --noEmit` — clean.
- NEW `tests/saveJournalCap.test.ts` — **8/8 pass**.
- `tests/directSave.test.ts` SOLO — **8/8 pass** (incl. the Addendum-4
  pin test). NOTE: in a 4-suite parallel run it failed once at
  directSave.test.ts:313 (`storageRevision` 2 vs pinned 1): under
  contention the test took 71 s and the 1.5 s autosave settle
  checkpoint flushed rev 2 before the status poll — a timing flake,
  adjudicated by the solo pass (8.1 s for that test solo).
- `tests/engineSvc.test.ts` — parallel run 35/36: the real-P75-fixture
  load test hit its 30 s timeout under contention (suite "health"
  test alone took 25.8 s in that run); solo re-run with
  `-t "real P75 fixture"` — **1 passed** (35 skipped by filter).
- `tests/phase2Collab.test.ts` SOLO — **15/15 pass**.
- `packages/service` `tests/directSave.test.ts` SOLO — **12/12 pass**
  (serializer untouched; run because the evidence leans on it).
- `tests/saveWorker.test.ts` — NOT RUN to completion: the file was
  untracked and was removed mid-session by the sibling item-F worker
  (W21 dead-file removal); vitest reports "No test files found".
  Recorded here so the gap is explicit, not silent.

## Scope notes

- progress.md untouched; no git push; App.tsx / mcp-server / web
  export paths untouched, per brief.
- SAVE_OPS_CAP was NOT removed (it is live and load-bearing as a
  memory bound); its stale W21 comment was corrected instead, so
  there is nothing to hand to item F from this constant.
