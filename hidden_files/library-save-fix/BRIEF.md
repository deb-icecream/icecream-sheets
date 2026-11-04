# Library Save in Signed Mode — Focused Fix (dispatched 2026-10-22 ~01:57 PDT)

## The defect (found by shell integration, curl-proven both directions)
In signed (production) mode, the gateway-proxied library save 401s: the
gateway forwards the caller's gateway JWT verbatim and the signed-mode
engine rejects it (gateway+JWT -> 401; direct engine+access-token -> 200).
Shell integration fixed this for the SHARE-IMPORT path via
CollabTransport.librarySaveDirect. The NORMAL Ctrl+S library save
(saveWorkbookToServerLibrary) still uses the broken proxied lane — a
pre-existing signed-mode defect. Checkpoints/autosave are unaffected
(different lane). Full context: hidden_files/shell-integration/REPORT.md
(search "library-save").

## FIRST ACTION (daemon-restart survival — mandatory)
Create hidden_files/library-save-fix/REPORT.md FIRST; append after every
landed piece; verify on disk.

## Scope
1. Reproduce on an isolated signed stack: open a file, edit, Ctrl+S (or the
   saveWorkbookToServerLibrary path) -> observe the 401.
2. Fix by routing the normal library save through the direct signed
   channel, mirroring librarySaveDirect and the residual-(p) download
   pattern (revision-model doc §4: bytes never proxied; download = save
   first then signed-URL fetch; save = signal only where the design says
   so — read the doc section before designing the change).
3. Validate: signed-mode Ctrl+S save succeeds; the saved file downloads
   and parse-backs exactly (values + formulas); local (unsigned) mode save
   unchanged; regression tests added; related suites green.
4. Audit the immediate neighborhood for other user-facing saves still on
   the proxied lane (Save As, named saves) — fix any that share the exact
   defect, or name them explicitly in the report as remaining.

## Constraints
No progress.md edits. No git push. No App.tsx routing changes (the shell
is integrated; save plumbing only). Design docs are the authority.
