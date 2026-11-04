# Open-Defects Sweep — Brief (user directive, 2026-10-21 ~21:15 PDT)

The user asked: every bug found so far — is it fixed, or being fixed? The audit
answer: the validation programs (Phase 2, Cycle 10 closure, perf gate) fixed
their findings in-scope; the MCP defects have a fix implemented with
re-validation in flight (separate coordinator); residual (p) is being fixed
now (separate worker). The items below are NAMED in the project record but
owned by NOBODY. This brief tasks them all to one coordinator.

Standing rules (binding): design docs are the authority (AGENT.md §0); related
tests only during build; every fix ships a regression test; validation =
evidence (commands + outputs + parse-backs), a claim without evidence is NOT
RUN; do NOT edit progress.md; do NOT git push; do NOT touch App.tsx routing /
the product shell (shell integration is a separate program); do NOT touch the
MCP package (separate coordinator) or the exports code paths under residual
(p) (separate worker, in flight).

## Step 0 — re-derive before fixing

Several items were named before Phase 1 (direct-streaming save) and Phase 2
landed, and may already be moot. For EACH item: read the CURRENT code, state
whether the defect still reproduces, and only then fix. A proven-moot verdict
with a pinning test that locks the correct behavior counts as CLOSED.

## Items

A. **`_xlcn.*` connection names `#ERROR!` on names-block regeneration**
   (progress.md Cycle 10 row, TODO §10.8). When a save regenerates the defined
   names block, external-connection names (`_xlcn.*`) degrade to #ERROR!.
   Fix so regenerated saves preserve them; validate with a fixture carrying an
   `_xlcn.*` name: open → save → parse-back shows the name intact and formulas
   referencing connections still evaluate.

B. **Structured-ref expansion on regenerated sheets** (TODO §10.8). Table
   structured references (e.g. `Table1[Amount]`) expand to A1 ranges when a
   sheet is regenerated on save. Preserve structured refs through save;
   parse-back proof on a fixture with a table + structured-ref formulas.

C. **200k-op journal cap → in-engine saves until reload** (TODO §10.8).
   Re-derive against the CURRENT revision-model journal (Phase 1 replaced the
   save path): what happens at the cap today — silent behavior change, error,
   or nothing? Fix any silent degradation; pin with a test.

D. **Gateway ~180 s proxy timeout vs long checkpoints** (Phase 1 residual
   (o)). A checkpoint/save of a large session proxied through the gateway can
   exceed the ~180 s proxy timeout. Reproduce with the largest practical local
   case; fix the path (timeout configuration, streaming, or chunking — per
   the deployment design doc) so legitimately long operations complete through
   the gateway; validate end-to-end through the gateway, not around it.

E. **Desktop close-flush** (Phase 1 residual (q)). Closing the desktop app
   with pending/queued ops must not lose them: flush on close, or persist the
   queue durably so the next launch submits it (revision-model doc §7/§11
   no-loss rules apply to the local engine too). Validate on the packaged
   Linux build: edit → close immediately → relaunch → the edit is present
   (parse-back or grid read-back).

F. **Retired W21 per-save worker files still in tree** (Phase 1 residual
   (r)). Phase 1 retired the W21 worker-isolation save design. Prove the
   worker files are unreferenced (grep across src + tests + build config),
   remove them and any tests that exist only for them, and show the affected
   suites still pass. If anything still references them, STOP and report
   instead of removing.

## Deliverable

`hidden_files/open-defects/REPORT.md`: per item — verdict (FIXED / PROVEN
MOOT / BLOCKED with reason), the evidence (test names + counts, parse-back
results, file lists), and anything newly found en route, named plainly.
