# Workspace Redesign — Brief (user direction, 2026-10-22 ~10:00 PDT)

## The user's words, distilled
The Workspace page (the post-login home) "looks very very bad — not a
world-class product." Redesign THAT PAGE ONLY (the user scoped this twice:
"just the workspace space"). Model: **OneDrive / SharePoint** — a files
list view with a proper header, create and upload in the header, and
settings behind a gear icon on their OWN page.

## Required shape

### Workspace page
- **Header bar**: product identity on the left; on the right: a **gear
  icon** (settings), and the user's identity/avatar.
- **Command bar** under the header (OneDrive/SharePoint pattern):
  - **"+ New" button** (primary) — creates a new spreadsheet and opens it
    (this product creates spreadsheets; the New action is spreadsheet
    creation).
  - **Upload button** — uploads .xlsx / .csv (existing semantics: CSV
    imports to a native workbook at open; tier caps apply; format
    validation stays).
- **Files in a LIST VIEW** (rows, not cards): columns at minimum —
  Name (with a real file-type icon; CSV-imported files keep their
  "Imported from CSV" marker), Modified (recency), Size. Default order
  stays recents-first (most recently used first — existing product rule).
  Row affordances: click opens (existing deep-link behavior), plus a row
  menu for Download / Rename / Delete (existing operations, unchanged).
- **File-count / tier meter** stays visible (Default: N of 10 files;
  Pro: unrestricted) — placed unobtrusively (header area or list footer).
- **Apps section** (existing product requirement) remains part of the
  Workspace, below the file list, visually subordinate to it.
- **Empty state**: a proper first-run state (no files yet) that points at
  New and Upload — designed, not a bare "no files" line.
- Polish bar: OneDrive/SharePoint-grade spacing, typography, hover and
  focus states, consistent iconography. No test junk, no placeholder text
  anywhere in the shipped surface.

### Settings — a separate PAGE, not a panel
- The gear icon navigates to a **dedicated Settings page** (its own view
  in the shell, with a clear way back to the Workspace). The current
  in-Workspace panel/drawer presentation is REMOVED.
- Contents (existing settings spec, unchanged semantics):
  - **User settings**: display name editable (this is the presence name);
    **email shown as a READ-ONLY and DISABLED field** (visibly greyed,
    not focusable, with a short note that it comes from the Google
    account). The API already rejects email changes (400 EMAIL_READ_ONLY)
    — that stays; the page must now LOOK the way the rule works.
  - **App settings — Icecream Office**: theme Light / Dark / System
    (default System), applied app-wide as today.
  - **Privacy**: "Delete my profile and data" with the existing ONE
    in-app confirmation dialog and the existing server-side deletion
    (dialog stays a dialog; the settings themselves live on the page).

## What does NOT change
- All server behavior: tiers + caps, upload semantics (incl. CSV),
  recents ordering data, deep links (?file=), share import, presence name
  source, theme engine, account deletion flow and its API.
- The grid/sheet app, the landing page, the desktop app surfaces.
- Design authority: design-docs/platform-shell.md (settings = per-user
  profile preferences; shell structure) — read it before building; where
  this brief and the doc differ on presentation, this brief (the user's
  newest word) governs presentation and the doc governs data semantics.

## Validation (required before "done")
- Browser tour on an isolated production-topology stack (own port block,
  stated in REPORT.md first), seeded with REALISTIC content: several
  real files with real names (e.g. the shared-fixtures sales workbook
  saved as a real .xlsx, a CSV import, files of differing sizes/dates) —
  no "test1", no lorem.
- Screenshots SELF-INSPECTED at desktop 1440 and iPad 820 widths:
  Workspace list view (populated + empty state), command bar, settings
  page (email visibly disabled), create-new flow landing in the sheet,
  upload from the header, gear -> settings -> back navigation.
- Existing product/settings test suites updated for the new shape
  (Workspace tests, SettingsPanel->SettingsPage tests, product tours)
  and green; apps/web tsc clean; full apps/web suite run at the end.
- Record: hidden_files/workspace-redesign/REPORT.md with the screenshot
  set + per-check verdicts. Checkpoint the report FIRST and after each
  landed piece (restarts are frequent). TMPDIR under ~/workspace.
  Do NOT touch progress.md. No git push (parent handles it).
