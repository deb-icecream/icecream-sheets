# Shell Integration — Brief (dispatched 2026-10-22 ~00:50 PDT)

## Why now
Residual (p) has landed (hidden_files/residual-p/REPORT.md), which was the
parking condition for this work. The product layer (hidden_files/product-layer/
BRIEF.md + CONTRACT.md, validation transcript 24/24) is built as standalone
modules; what remains is wiring it into the shipped app shell. This is on the
DEPLOY CRITICAL PATH.

## FIRST ACTION (daemon-restart survival — mandatory)
Create hidden_files/shell-integration/REPORT.md FIRST with a skeleton
(scope, plan, empty verdict slots). Append to it after EVERY landed piece.
Verify each landing on disk (files + test output), never from worker claims.
If you die, your successor resumes from REPORT.md.

## Scope — wire the product layer into the app shell
1. **Routing (apps/web/src/main.tsx + App.tsx):** hosted URL routing —
   public landing page at root for logged-out visitors; post-login home =
   "Icecream Sheets Workspace"; deep link `?file=<id>` (logged-out -> login
   -> returned to the file; owner-only); `?share=<id>` recipient flow
   (full-screen app -> Restore button -> working view with own copy).
   Use the EXISTING modules under apps/web/src/product/ (Workspace,
   LandingPage, AppsGallery, sharesApi, productApi, deepLink) — do not
   rebuild them.
2. **Workspace Apps mount:** AppsGallery composes into the Workspace
   appsSlot as delivered by the app-gallery track.
3. **Dist rebuild:** production dist via the controlled path ONLY:
   `npm run build:local-stack` semantics for local validation
   (VITE_GATEWAY_URL + VITE_ENGINE_ACCESS_MODE=signed baked) and
   scripts/verify-dist.mjs must pass. A plain vite build now works (the
   service-barrel node:crypto breakage was fixed 2026-10-22 ~00:47 PDT —
   firestore-node subpath split; do not reintroduce node-only imports into
   the web bundle).
4. **In-app browser validation (the bar):** full flows in a real browser on
   a local production-topology stack, screenshots self-inspected:
   landing (desktop + narrow) -> sign-in gate -> workspace (recents, file
   list, CSV marker) -> upload xlsx AND csv through the integrated UI ->
   open via deep link -> grid -> download; share link opened as a second
   user -> full-screen app -> Restore -> own copy in their workspace;
   logged-out deep link -> login -> lands on the file.
5. **Suites:** related web/gateway/product suites green; full web suite if
   the host allows (contention has blocked it all evening — say NOT RUN
   honestly if so, never claim it).

## Hard constraints
- The open-defects sweep is RUNNING on this tree. Do NOT touch its
  in-flight files: packages/gateway/src/services/engineSvc.ts,
  apps/web/src/components/DownloadDialog.tsx,
  apps/web/src/features/nameServices.ts, apps/web/src/features/useNameServices.ts,
  packages/engine/src/workbook.ts, packages/service/src/save/*,
  packages/xlsx-adapter/src/streamingSave.ts.
  If integration genuinely needs one of these, STOP on that piece, record
  it in REPORT.md as BLOCKED-ON-SWEEP, and continue with the rest.
- Design docs are the authority (AGENT.md §0). No stubs. No progress.md
  edits. No git push (the parent pushes).
- Export plumbing from residual (p) is DONE — do not redo it; the
  App.tsx provider-registration line it added must survive your routing
  work (regression-check the exports tour if you restructure App.tsx
  materially).

## Deliverable
hidden_files/shell-integration/REPORT.md: per-piece verdicts with evidence
paths (screenshots, transcripts, suite counts), an explicit list of what
was NOT run or remains, and the exact dist provenance (env baked +
verify-dist output).
