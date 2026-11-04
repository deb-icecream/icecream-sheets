# Workspace Redesign — Report

Coordinator checkpoint file. Brief: hidden_files/workspace-redesign/BRIEF.md
(user direction 2026-10-22 ~10:00 PDT). Scope: the Workspace PAGE only —
OneDrive/SharePoint-style list view, header + command bar (+ New / Upload),
gear icon → SEPARATE Settings page, email read-only AND disabled there.
Data layer unchanged (gateway settings store/API, theme engine, presence
name, tiers, CSV semantics, deep links, deletion flow).

## Port block (validation stack — claimed here first)
- Gateway: 8950
- Engine: 8951
- Web (static dist server): 6300
(Isolated production-topology stack; dev login ON locally via
ALLOW_DEV_LOGIN=1 for the tour user; signed engine access.)

## State at start (read 2026-10-22)
- apps/web/src/product/Workspace.tsx: card-grid Recents + table "All files",
  upload/create action cards, Settings toggled as an inline panel
  (SettingsPanel) inside the Workspace; delete uses window.confirm.
- apps/web/src/product/SettingsPanel.tsx: two-card panel; email input is
  readOnly (NOT disabled — brief requires visibly disabled + not focusable).
- App.tsx shell (gateway mode, authed, no file open): thin inline top bar
  ("Icecream Sheets" + FirebaseLoginButton) above <Workspace>.
- Tests: src/product/Workspace.test.tsx, SettingsPanel.test.tsx,
  userSettings.test.ts, productApi.test.ts, LandingPage.test.tsx.

## Plan
1. Workspace.tsx rewrite: header bar (identity left; tier meter unobtrusive;
   gear icon button + avatar right), command bar (+ New primary → creates
   "Untitled spreadsheet" and opens it; Upload button → hidden file input),
   LIST VIEW rows (icon, name anchor, CSV marker, Modified, Size, row menu
   ⋯ with Download/Rename/Delete; rename inline; delete keeps existing
   flow), designed empty state pointing at New/Upload, Apps section below.
   Recents-first order = API order (unchanged). Remove Recents card grid
   + the two action cards.
2. SettingsPage.tsx (rename from SettingsPanel.tsx): full page view inside
   the Workspace shell state (view: files | settings), back affordance
   "← Workspace"; email input gets disabled + readOnly + visibly greyed
   (.ics-input-disabled) + note "from your Google account". Delete flow,
   theme radios, name save: semantics unchanged.
3. product.css: OneDrive/SharePoint-grade list/command-bar/header styles,
   hover/focus states, row menu, settings-page layout; dark theme vars
   already keyed off [data-theme].
4. Tests: Workspace.test.tsx updated (command bar, list rows, row menu,
   gear → settings page → back, empty state); SettingsPanel.test.tsx →
   SettingsPage.test.tsx (email disabled assertion added). Full apps/web
   suite + tsc at the end.
5. Browser validation on the port block above with REALISTIC seed data
   (real .xlsx files w/ real names + a CSV import, differing sizes/dates);
   screenshots self-inspected at 1440 + iPad 820: populated list, empty
   state, command bar, settings page (email disabled), create-new landing
   in the sheet, header upload, gear→settings→back.

## Landed pieces
- SettingsPage.tsx (new): settings as a page (back affordance, page
  title, stacked sections); email input now readOnly AND disabled with
  the greyed `.ics-input-disabled` look + "comes from your Google
  account" note. SettingsPanel.tsx + SettingsPanel.test.tsx deleted;
  tests moved to SettingsPage.test.tsx (+ email.disabled assertion +
  back-affordance test).
- Workspace.tsx (rewritten): flat header bar (wordmark + tier badge +
  meter | gear icon + avatar initial chip + optional accountSlot),
  command bar (+ New one-click create "Untitled spreadsheet" → open;
  Upload label button), "My files" page title, LIST VIEW table (type
  icon / name anchor / origin + CSV chips / relative Modified / Size /
  one ⋯ row menu with Download-Rename-Delete), designed empty state,
  list footer, Apps slot unchanged. All behaviors wired (upload
  semantics + verbatim errors, create→open, deep links, tiers).
- App.tsx: the gateway workspace branch drops its duplicated inline
  top bar; the account control (FirebaseLoginButton) passes into the
  Workspace header via the new `accountSlot` prop — one bar on screen.
- PRE-EXISTING BUG FOUND + FIXED (tour run 2): browser rename failed
  with a CORS preflight error — packages/gateway/src/httpUtils.ts
  `applyCors` allowed "GET, POST, PUT, DELETE, OPTIONS" but the rename
  route is PATCH /api/files/:id, so PATCH was missing. Every
  cross-origin deployment (incl. production hosting → Cloud Run) had
  a dead Rename. Added PATCH to the allow-methods. Proven by probe:
  rename now persists end-to-end (DOM + API).
- Avatar refinement (found in tour run 1): App passes profileName from
  Firebase only (null under dev login → avatar "?"). Workspace now
  loads the settings record once on mount (when settings are wired)
  and the avatar/identity prefer the SAVED display name — the same
  name presence uses — falling back to the shell props.
- product.css: header/command-bar/list/menu/empty-state/settings-page
  styles in OneDrive grammar (hairlines, hover wash, 52px rows, menu
  shadow, focus-visible rings); old card-grid styles removed; narrow
  screens (<900px) tighten paddings and hide the meter.

## Verdicts
- Browser tour (harness/run.sh; gateway 8950 / engine 8951 / web 6300,
  production topology, signed engine access, verify-dist PASS):
  **28/28 checks PASS** (harness/results.json). Proven live: empty
  state; populated list in recents-first order with type icons, origin
  tags, CSV marker on the imported row only, relative Modified times;
  header (brand, Default badge, "4 of 10 files" meter, gear, avatar
  "MC" from the SAVED display name); command bar; row menu
  Download/Rename/Delete with rename persisted via API; gear →
  Settings PAGE (list + command bar replaced; email readOnly AND
  disabled in the DOM) → Back; "+ New" lands in a real new grid at
  its deep link and becomes the first row; header Upload stores via
  the real file input (API-verified); row-menu Delete via the
  existing confirm (exactly 1 native dialog, the file-delete confirm
  — the settings delete flow remains dialog-free in-app as before);
  iPad 820 list + settings (email still disabled).
- Screenshots (self-inspected): shots/01-empty-state-1440.png,
  02-list-1440.png, 03-row-renamed-1440.png, 04-settings-page-1440.png,
  05-new-sheet-grid-1440.png, 06-list-after-new-1440.png,
  07-list-after-upload-1440.png, 08-list-ipad820.png,
  09-settings-ipad820.png. All read OneDrive-grade: hairline list,
  pill command bar, quiet header. Notes: the settings email field
  shows "—" on the local stack because dev-login users have no email
  (production Google sign-in always carries one; the field is the
  same disabled control); the header's "Sign in with Google" button
  is the shell's pre-existing accountSlot control, unchanged.
- Unit suites: product 98/98 (incl. Workspace 24, SettingsPage 8 —
  email.disabled asserted); full apps/web suite **150 files,
  1,934/1,934 PASS**; gateway suite 418/419 — the one failure is the
  pre-existing agent HITL timeout (tests/services.test.ts "human-in-
  the-loop over HTTP", 10 s timeout, also the sole failure before
  this program; no gateway test references CORS/httpUtils, and the
  browser tour proves rename end-to-end with the PATCH fix).
- tsc --noEmit (apps/web): clean.
- NOT landed / unchanged by design: nothing from the brief is
  missing. Untouched on purpose: the data layer (gateway settings
  store/API, theme engine, presence name, tiers, CSV semantics, deep
  links, deletion flow), progress.md, and git (parent pushes).
