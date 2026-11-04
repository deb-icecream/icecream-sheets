# Public Formula Benchmark Suite — BRIEF (Idea idea_7410fc10c18844a9aaa0abd626ef3a29)

User accepted 2026-10-21. Publish a public, reproducible benchmark
from the repo's OWN validated golden corpus. GitHub is connected as
is-cream.

## Contents of the package
- The golden formula corpus from test-data/gold/ (functions.xlsx,
  functions-batch2.xlsx, and the gold README documenting the 8 triaged
  gaps) with expected values — copied as benchmark content.
- A scoring harness: ONE command, engine-neutral (an engine adapter
  interface runs the corpus and compares computed vs expected using
  the repo's own tolerance rules, including the documented 1-ulp Excel
  precision cases). Output: per-function pass rates + overall score
  (JSON + human-readable summary).
- A leaderboard page (static, in the benchmark repo) showing
  icecream-sheets' baseline score AS PRODUCED BY THE HARNESS. Only
  engines actually run may show scores — no invented competitor
  numbers; other engines are omitted or marked "not yet run".

## HARD GATE — reproduce before publishing
The harness run against icecream-sheets' own engine MUST reproduce
the repo's recorded validation baselines exactly first: functions.xlsx
413/421 with the same 8 named triaged gaps; functions-batch2.xlsx
44/44. If reproduction does not match, STOP — publish nothing, and
report the discrepancy precisely. (Note: the idea card's "523/523"
figure does NOT match the repo's records — the records govern. If you
find where 523 comes from, report it; never publish a number the
harness did not produce.)

## Publication
- NEW public repo under is-cream named `icecream-sheets-benchmark`,
  containing ONLY benchmark content: corpus, harness, leaderboard,
  README (methodology, tolerance rules, triage notes). NO private repo
  internals, no hidden_files, no credentials, no unrelated code.
- Text files via the GitHub connector push-files route; the .xlsx
  corpus files are binaries — push them via the git device-auth flow
  (see MEMORY.md's standing method) or hand the parent an exact file
  list if that flow stalls.

## Validation
- From a CLEAN clone of the published repo, the one-command harness
  runs and reproduces the baseline (output captured).
- Leaderboard renders and shows exactly the harness-produced score.
- Repo is public; file listing verified after push.
Final report: repo URL, harness reproduction output vs the recorded
baselines (exact figures), what was published, and anything NOT done
stated plainly. NO pushes to icecream-sheets itself — the parent
handles that repo.
