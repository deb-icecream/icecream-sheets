# Round-Trip Data-Loss Audit — Two P75 Files (user directive 2026-10-21 18:51 PDT)

## The user's concern, in his terms
Data loss on save is "a very concerning thing." This audit must prove, for real files
edited and re-saved through the real product, that NOTHING is lost or altered beyond
the changes we deliberately made.

## Existing evidence (build on it, do not re-claim it)
The direct-streaming save pass proved parse-back exactness on the P50/P75/P95 tours
and part-identity for edited and unedited saves (known designed metadata DIFF classes
named there). This audit is the stricter, standalone version the user asked for; where
prior evidence genuinely covers a check, cite the exact file/figure — anything not
covered gets run here.

## The test (both files, end to end, through the real web app in gateway mode)
**Files:** (1) `test-data/perf-fixtures/perf-p75.xlsx`; (2) one real-world file of
P75 class (~0.5–2 MB) from `test-data/real-world/` — name the file in the report.

**Modifications (a defined, recorded set per file — enumerate every one in the report):**
- change a literal value cell; change a formula cell's precedent and confirm the
  formula cell's cached value moves; add one new formula; clear one formula cell's
  contents (Delete semantics); insert one row above a formula-bearing row.
**Then:** save through the app, download the saved bytes (save-first + signed-URL
path), and diff against the ORIGINAL file.

## The diff (all three layers, per file)
1. **Cell level:** every sheet — address, formula text, cached value, data type.
   The resulting diff set must EQUAL the intended-change set (plus the mechanical
   consequences of them: shifted addresses from the row insert, recalculated cached
   values downstream of edited precedents — each class enumerated and explained).
   Any other differing cell = DATA LOSS defect.
2. **Package level:** inventory every part of the xlsx (worksheets, sharedStrings,
   styles, charts + their caches, pivots, defined names, drawings, media, docProps).
   No part may vanish or change except the designed serializer classes already named
   in the direct-save evidence — and any such change must be re-named here, per file.
3. **Reopen level:** open the SAVED file in the web app, screenshot every sheet,
   self-inspect; formulas evaluated, charts/pivots/images present and rendering.

## Rules
- Any unintended difference = a defect: fix it, re-run the whole audit for that file,
  and report the defect + fix + re-proof. Do not footnote anomalies.
- Sequencing: use an isolated stack/port for tours (the shared stack is reserved for
  the Phase 2 validation); never rebuild the shared dist mid-tour elsewhere.
- Report per file: the modification list, the three diff layers' results, screenshots,
  and a final verdict (LOSS-FREE or the defect found). State plainly anything not run.
