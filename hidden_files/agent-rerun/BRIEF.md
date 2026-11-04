# AI Agent Validation — Re-run + Residual Fixes (dispatched 2026-10-22 ~01:57 PDT)

## Context
The 20-case live validation completed with FINAL-REPORT.md at
hidden_files/agent-features/FINAL-REPORT.md: PASS live = cases 8, 10, 20;
FAIL = case 11; FAIL-GAP = case 9 (product decision pending with the user —
do NOT build triggers); NOT RUN live = cases 1-7, 12, 18, 19 (blocked by the
deep-link join defect) and 13-17 (unit-proven only). The join defect is now
FIXED and PROVEN by the shell-integration program
(hidden_files/shell-integration/REPORT.md: gateway engagement proven with
network evidence for fresh loads; same-document #file= hardened;
sequential-open 409 fixed via releaseOnUnload). The tours are unblocked.

## FIRST ACTION (daemon-restart survival — mandatory)
Create hidden_files/agent-rerun/REPORT.md FIRST with a skeleton and append
after every landed piece. Verify landings on disk. Prose claims without
artifacts do not count — the predecessor's standard: PASS = live evidence
on disk (transcripts, screenshots, read-backs).

## Scope
1. **Case 11 fix:** the web add-on host must pass the open gateway file's id
   (today add-ons bind to 'local-workbook' while a gateway file is open).
   Fix, then validate live: install + grant + run an add-on against an open
   gateway file and prove it acted on THAT file (read-back).
2. **FIX-B residuals (3)+(4):** non-creator participants must bind to the
   agent runtime for a shared session, and minted agent tokens must be
   role-scoped (a viewer-joiner's agent must NOT be able to write — prove
   the write is refused). These gate co-authoring.
3. **Re-run the NOT RUN cases live** on a production-topology local stack
   with the real Vertex gemini-2.5-flash-lite backend, using the staged
   harness + fixtures (hidden_files/agent-features/cases/tour-core.mjs,
   w3a.mjs, w3b-work/, hidden_files/shared-fixtures/ — SUM revenue ground
   truth 4027.86): cases 1, 2, 3a, 3b, 4 (incl. save->reopen with the
   native chart), 5, 6, 7 (CSV + SQL), 12, 13 (over-cap live), 14
   (RE-TEST the worker claim that weather was answered — if it reproduces,
   root-cause the live path vs the deterministic classifier), 15, 16, 17
   (note the no-product-docs-corpus caveat in the verdict), 18, 19.
4. Case 20's disclosed blemish (planner asks before recalling) — re-check;
   if the K4 prompt protocol holds, say so with the transcript.
5. Case 9: leave FAIL-GAP; do not build triggers (user decision pending).

## Constraints
Design docs authority (ai-agent.md: agent acts ONLY through MCP tools;
two-source scope; LangGraph NOT used). No stubs. No progress.md edits. No
git push. Do not touch: the shell-integration deliverable dist provenance
(rebuild via build:local-stack if you need a dist), residual-(p) export
paths, MCP package internals beyond the binding fixes in scope.

## Deliverable
hidden_files/agent-rerun/REPORT.md: per-case verdicts with evidence paths,
the case-11 and FIX-B fix records with tests, and an explicit NOT RUN list
with reasons if anything remains.
