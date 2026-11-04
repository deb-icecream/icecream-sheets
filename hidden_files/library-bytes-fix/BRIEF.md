# Library-Entry Open (engineLibraryBytes) in Signed Mode — Focused Fix (dispatched 2026-10-22 ~02:20 PDT)

## The defect (found + curl-proven by the library-save fix worker)
`GatewayClient.engineLibraryBytes(id)` (apps/web/src/services/gatewayClient.ts ~514)
— the path that fetches a saved library entry's bytes to OPEN it — uses the
gateway-proxied lane. In signed (production) mode the gateway forwards the
caller's gateway JWT verbatim and the signed engine rejects it: 401. So in
the deployed app, opening a workbook from the library fails the same way
Ctrl+S library save did before its fix. Full evidence:
hidden_files/library-save-fix/REPORT.md (neighborhood audit section).

## The pattern to mirror (just landed, same codebase)
hidden_files/library-save-fix/REPORT.md + the code: gatewayClient gained
`directLibrarySaveProvider`; collabTransport gained `librarySave(payload)`
via fetchOpenedWithRefresh (stale-token 401 -> §9 gateway lookup -> retry
once); residual-(p) did the same for downloads (directDownloadBytesProvider).
Revision-model doc §4: workbook bytes are never proxied; the gateway
returns connection info only; the engine validates the token itself.

## FIRST ACTION (daemon-restart survival — mandatory)
Create hidden_files/library-bytes-fix/REPORT.md FIRST; append after every
landed piece; verify on disk.

## Scope
1. Reproduce on an isolated signed stack: save a library entry (the save
   lane now works), then open it via the library path -> observe the 401.
2. Fix: a direct bytes lane for library-entry open mirroring the save fix
   (provider on GatewayClient consulted first, proxied fallback on null
   for legacy/proxy sessions; collabTransport method via
   fetchOpenedWithRefresh). Keep the design contract: if the open should
   be save-first/signed-URL per §4 for any sub-path, follow the doc.
3. Validate: signed-mode library open succeeds end to end in the real app
   (entry opens into the grid, values/formulas read back from the engine);
   bytes parse-back exact; local mode unchanged; regression tests;
   related suites + full web suite green.
4. Also disposition the other named sibling from the save report:
   `engineBindLibrary` (same proxied lane, fire-and-forget checkpoint
   targeting for the legacy Phase-1 open flow, no direct counterpart) —
   either fix it the same way if it is user-reachable in signed mode, or
   prove it unreachable/legacy-only and say so with evidence in the
   report. Do not leave it unexamined.

## Constraints
No progress.md edits. No git push. No App.tsx routing changes (open
plumbing only; a provider-registration line beside the existing ones is
in scope, mirroring the save fix). Design docs are the authority.
