# Product Layer — Tiers, Workspace, Deep Links, Landing Page — BRIEF

Issued: 2026-10-21. User design + playback confirmed in chat 2026-10-21
15:49–16:00 PDT ("Looks right" + additions accepted). Authority: the
user's confirmed design below; existing design docs still govern their
domains (deployment-architecture.md, revision-model-save-and-coauthoring.md).
Conflicts are flagged, never silently resolved.

## Why this exists

Deployment is imminent and the product must present as a FINISHED
product (Meta hackathon — approved, competing). Today the web app opens
straight into a spreadsheet. There is no account tiering, no per-user
file home, no shareable file link, and no public product page. This
brief builds that layer. It also pulls the previously-queued production
upload path (gateway upload-issuance, engine load-by-reference, client
upload flow) INTO pre-deploy scope: real users need it.

## 1. Tiers — exactly two

- **Default** — every Google sign-in lands here. The word "free" NEVER
  appears in the UI; the tier is named "Default".
  - Upload size cap: **P75 size = 1,285,214 bytes** (the perf-p75
    fixture), a named configurable constant.
  - File count cap: **max 10 files** in the user's workspace. Files
    CREATED in-app count toward the 10; created files have **no size
    cap** (they can grow to anything).
  - Uploading IS allowed within the caps.
- **Pro** — unrestricted (no size cap, no count cap).
- **Enforcement is SERVER-SIDE**, at the gateway (upload issuance) and
  the file registry — never UI-only. A cap hit returns a clear,
  specific error (which limit, what the user has, the Pro path) that
  the UI displays verbatim; silent failures are a defect.
- **Tier plumbing**: a per-user tier record server-side (service DB,
  keyed by uid; default = Default on first sight). At the gateway's
  `POST /auth/firebase` exchange, the tier is read and stamped as a
  claim in OUR JWT. Engine/gateway checks read the claim; the record is
  the source of truth at each login.
- **Promotion**: an operator operation `set-tier` by EMAIL (script or
  service endpoint, admin-authenticated) — used to promote the user's
  own account later and to set the deploy-verification TEST USER to
  Pro at creation. Include it, test it.

## 2. Production upload path (now pre-deploy scope)

- Gateway **upload-issuance endpoint**: authenticated; checks tier caps
  (declared size vs cap; current file count vs cap) BEFORE issuing;
  issues a short-lived signed URL for direct-to-storage upload (GCS in
  production; the local stack uses its local storage adapter with the
  same interface — the deployment-prep seams' pattern).
- Engine **load-by-storage-reference**: opens a workbook from the
  storage reference the gateway hands it (no file bytes through gateway
  or engine request bodies).
- Client **upload flow**: workspace Upload → issuance → direct upload →
  engine open by reference → file appears in the workspace registry.

## 3. Deep links

- A file's canonical URL: the hosted app URL with **`?file=<fileId>`**.
  Opening it (signed in, owner) opens that workbook directly.
- Logged out → login → **returned to the file** after auth.
- Access: owner-only for now (authorize() applies). A link to someone
  else's file yields the same refusal as no permission — no existence
  leak beyond what authorize() already permits.
- **Workspace file entries ARE these links** (real anchors): clicking a
  file in the workspace navigates to its deep-link URL. Copy-link,
  open-in-new-tab, and browser history all work from that alone.

## 4. Workspace — "Icecream Sheets Workspace"

The post-login home. A separate UI from the grid (the grid opens FROM
the workspace, via the deep link).

- **Recents**: most recently USED files first (last-opened order),
  shown as the primary list/section.
- Full file list with name, size, last modified/opened; **upload**
  (with cap messaging), **download** (save-first + signed-URL pattern
  per the revision-model doc), **create new** (blank workbook → opens
  in the grid; counts toward the 10, no size cap), rename, delete.
- **File-count meter** for Default users ("3 of 10 files"); Pro shows
  no cap framing (or "Pro — unlimited", designer's choice, keep plain).
- Empty state for a brand-new user: create/upload calls to action.

## 5. Product home page (public landing)

For logged-out visitors at the site root. Plain English, finished-
product polish (hackathon). Content pillars, user's words made plain:

- **AI-native** — agent-first architecture: an AI agent is a first-class
  user of the spreadsheet, working through the same tools (MCP) a
  person uses — not a chatbot bolted onto a grid.
- **Data-native** — built for data processing and data visualization
  from the ground up: live charts, pivots, and analysis are native
  citizens, and the spreadsheet is a view over data sources, not just a
  file editor.
- Sign in / Open workspace CTA; the existing dashboard screenshot
  (hidden_files/direct-save-pass/tour-p75/p75ds-sheet-12-Dashboard.png)
  as the hero visual; a **Default vs Pro** section (labels exactly
  "Default" and "Pro").
- **RICH, VISUAL page (user addition, 2026-10-21 16:01 PDT)** — not a
  text wall. Use real product imagery: the hero dashboard shot, plus
  other verified screenshots from the existing evidence sets (grid,
  charts/PivotCharts, co-authoring presence) as section visuals, and
  tasteful graphics/iconography for the AI-native and data-native
  pillars. Real product pictures over generic stock — the page must
  LOOK like the finished product it describes. Self-inspect the
  rendered page via screenshots at desktop and narrow widths before
  calling it done.
- Logged-in users going to root land in the Workspace instead.

## Sequencing constraint (parent directive)

The Phase 2 validation coordinator is RUNNING against apps/web (dist
rebuilds, browser tours). Order your work: server-side first (tiers,
registry, upload issuance, engine load-by-reference), then the new UI
as NEW files (workspace, landing, deep-link handling). Touch
`App.tsx` / `main.tsx` routing and rebuild `dist` ONLY after checking
whether the validation coordinator has completed (look for its final
report under hidden_files/phase2-coauthoring/); if it is still running,
build everything else and park the integration step, reporting exactly
that. Never run a second tour/browser process against the same output
dirs.

## Validation (local, full stack, production topology)

- Two users end-to-end: a **Default** user proves the caps (11th file
  refused with the named error; oversized upload refused at issuance;
  a created file grows past the upload cap freely); a **Pro** user
  proves no caps. Evidence: API transcripts + browser screenshots.
- Deep link: cold open in a fresh browser (logged-out → login → lands
  in the file); workspace click-through produces the same URL.
- Workspace: recents order after opening files in known order;
  upload/download round trip parse-back; create-new flow.
- Landing page renders logged-out with CTA + tiers section; screenshot.
- Related unit suites for every touched package; consolidated counts
  reported; perf gate must not regress (Phase 1 numbers).
- Update progress.md with the new workstream rows.

## Rules

- Design docs govern their domains; flag conflicts, don't rescope.
- No stubs: caps, links, recents, and pages are real or the item is
  reported NOT DONE with the reason.
- NO git push — the parent pushes and byte-verifies.
- Final report: per-item verdicts with evidence paths; NOT-RUN items
  stated plainly; explicit statement of what remains before this layer
  is deploy-ready.
