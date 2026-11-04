# App Artifact Gallery — BRIEF (Idea idea_526f72593de041b9bae33222bec467d3)

User accepted 2026-10-21. Build inside the icecream-sheets codebase,
in/alongside the chat surface, on the existing artifacts system
(packages/service/src/artifacts, apps/web ArtifactHost).

## Outcome
A gallery in the chat surface listing EVERY app the chat actually
generated — name, bound sheet/workbook, working live preview — with
three one-step actions per entry: Reopen, Duplicate, Share.

## Requirements
- Entries come ONLY from the real artifact store (apps the chat
  generated). Nothing fabricated, nothing pre-seeded. An empty store
  shows an honest empty state.
- Reopen: opens the app in the chat surface (embedded, as generated
  apps already run — ArtifactHost), bound to its sheet, two-way live
  sync intact.
- Duplicate: asks which table/sheet to bind the copy to, then creates
  a working copy bound to that target with two-way sync preserved
  (an edit in the copy writes to the NEW target, never the original).
- Share (USER-CONFIRMED DESIGN, 2026-10-21 16:25–16:29 PDT — replaces
  the original app-only share): sharing an app shares it WITH ITS
  DATA; app-only/code-only sharing does not exist. The share dialog
  NOTIFIES the sharer that the data source is shared too, naming the
  specific sheet/source + row count, with an explicit confirm. The
  recipient (signed in) opens the link to the app FULL SCREEN; a
  restore button returns it to the working view — data loaded as a
  spreadsheet in the grid, the app in the chat area, the grid taking
  the rest of the screen. Mechanics: the recipient receives their OWN
  COPY (app + data snapshot) in their workspace, bound together with
  two-way sync; the owner's original is never exposed to recipient
  edits. Credentials NEVER travel — connector-backed sources share
  materialized data only. A "shared by you" list supports per-link
  revoke. The gallery's home is the Workspace "Apps" section
  (Amendment 1); no standalone deployment.
- To validate, at least one app must be genuinely generated through
  the chat (real generation path — the Vertex-backed generator). The
  agent-features coordinator is validating that live path in parallel;
  coordinate with it (its generated artifacts are legitimate gallery
  entries). If no real generated app can be produced, report BLOCKED
  with the reason — do not seed a fake entry.

## Validation
- Browser proof with screenshots: gallery lists the generated app(s)
  with bound sheet + rendered preview (non-empty, inspected).
- Duplicate proof: duplicate against a different table; edit in the
  copy lands in the new table; original untouched.
- Share proof: the link opens a working preview without exposing the
  source sheet's data; a fork binds the recipient-side table.
- Related suites green (artifacts, appbuilder).

## Coordination
Other coordinators are active; one browser process per output dir;
never rebuild apps/web/dist mid-tour of another coordinator. NO git
push — the parent pushes and byte-verifies. Final report: what was
built, per-action proof with evidence paths, privacy check result,
and anything NOT done stated plainly.
