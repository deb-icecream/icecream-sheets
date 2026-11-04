# OOXML Corpus Adapter Test Re-Run — Formal Verdicts

Run started: 2026-10-22 ~03:57 PDT (worker ddc01ea9)
Tree: ~/workspace/icecream-sheets (current working tree)
TMPDIR: ~/workspace/tmp-corpus-rerun (avoiding /tmp ENOSPC)

| # | Test file | Verdict | Passed | Failed | Skipped | Wall time |
|---|-----------|---------|--------|--------|---------|-----------|
| 1 | packages/xlsx-adapter/tests/audit-v2-full.test.ts | PASS | 1 | 0 | 0 | 53 s (test 46.4 s) |
| 2 | packages/xlsx-adapter/tests/real-world-audit.test.ts | PASS | 1 | 0 | 0 | 25 s (test 21.0 s) |
| 3 | packages/xlsx-adapter/tests/real-world-detail.test.ts | PASS | 1 | 0 | 0 | 31 s (test 28.1 s) |

Overall verdict: ALL THREE FILES PASS TO COMPLETION on the current tree (3 tests passed, 0 failed, 0 skipped; combined wall ~109 s). The owed formal corpus re-run is now closed.

## Failure details
None — all three files passed; no failure output to preserve.

## Notes
- Run completed: 2026-10-22 ~04:00 PDT. Logs: ~/workspace/tmp-corpus-rerun/run1.log, run2.log, run3.log (all exit 0).
- File 1: single aggregate test ("audits all real-world files") — PASS, exit 0. The run log carries 11 `MISMATCH>` diagnostic lines (the audit logs computed-vs-cached divergences it classifies as tolerable; the test still passes): beyond-excel-bxl3way.xlsx CHKs B7/B8/B9/F8/F9/F10 (6), closedxml-xlsx-functions-excel-2010.xlsx Sheet1 B2/D2/E2 + Sheet2 M44 (4), excelize-CalcChain.xlsx Sheet1 B1 (1). Log: ~/workspace/tmp-corpus-rerun/run1.log
