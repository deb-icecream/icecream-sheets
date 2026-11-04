# Workspace Settings — Brief

**Decision (user, 2026-10-22 ~04:51 PDT):** The Workspace (the post-login
home) gets a **Settings** surface. There are two kinds of settings, and
BOTH are persisted server-side in the database:

1. **User settings** — the user's own profile settings.
2. **App settings** — scoped to **Icecream Office** (the suite), NOT to
   Icecream Sheets alone, because Icecream Presentations and Icecream
   Documents will join the same Workspace later and share them.

**Record:** `hidden_files/workspace-settings/REPORT.md` — create it FIRST
(skeleton), append after each landed piece. Daemon restarts are frequent;
nothing counts until it is on disk. Do NOT touch progress.md. Do NOT git
push (the parent does both).

## Design authority

- `design-docs/platform-shell.md` §4: "Settings are per-user preferences in
  the user profile, never in workbook bytes. A workbook opened by another
  user never carries the owner's preferences with it." Settings never go
  into files, never into the grid's own state.
- The product layer (`hidden_files/product-layer/CONTRACT.md`): the
  Workspace is the post-login home; the gateway owns per-user state
  (tiers, file catalog) behind JWT-verified, ownership-checked handlers.

## Placement

- A **Settings button in the Workspace** (the logged-in home), opening the
  settings surface within the Workspace shell.
- **NOT in the sheet grid.** No new settings surface inside the workbook
  app. (The pre-product in-grid SettingsDialog from the platform-shell
  batch is a different, local thing — leave it alone; do not confuse the
  two.)
- Two sections in one surface: **User settings** and **App settings**
  (labeled as Icecream Office settings — the suite scope is the point).

## Persistence (database, both sections)

- A per-user settings record on the GATEWAY, following the established
  deploy-store posture of `packages/gateway/src/deploy/userStore.ts` /
  `fileRegistry.ts`: local JSON adapter (local topology), memory adapter
  (tests), prod Firestore-shaped adapter that FAILS CLOSED without an
  injected client (collection name in the family style, e.g.
  `icecream_user_settings`). No silent local fallback in prod.
- API: read/update the caller's OWN settings only — principal from the
  verified JWT, the product layer's ownership pattern. There is no way to
  read or write another user's settings.
- The record keeps the two scopes distinct and product-agnostic:
  a `user` part (profile) and an `office` part (app settings). No
  sheets-specific keys in the `office` part — a future Icecream
  Presentations/Documents client must be able to read/write the same
  `office` settings against the same record.
- Settings are fetched at login and applied before the Workspace paints
  where feasible; state honestly in the report how close to no-flash the
  implementation gets.

## User settings

- **Display name — editable.** Default: the name Google provides at
  sign-in (Firebase profile). A saved value overrides the default.
  - **This name is the presence name.** Co-authoring presence must show
    the settings display name. Find where presence gets its name today
    (client Firebase profile → session join → presence payload) and make
    the settings value the single source, with the Google name as the
    fallback when no override exists. A name change takes effect for new
    sessions/joins; state in the report whether live sessions update.
- **Email — shown, READ-ONLY.** It comes from Google sign-in and can
  never be edited here: no edit affordance in the UI, and the settings
  API must not accept an email change (it is identity, owned by the
  identity provider).
- Nothing else in this section for now (the user: "for now I think that's
  it").

## App settings (Icecream Office)

- **Theme: `light` | `dark` | `system`.** Default: `system`.
  - `system` follows the OS/browser preference and updates live if the
    OS preference flips while the app is open.
  - Applies **app-wide**: the Workspace AND the sheet app (chrome and
    grid — a dark theme with a white grid is a failure). Implement via a
    top-level theme attribute + CSS variables/design tokens, not
    per-component one-offs. Canvas-rendered surfaces (grid) must take
    their colors from the same theme source.
  - Both themes are first-class: legible contrast, WCAG 2.2 AA like the
    rest of the app.
- Architecture note: the theme lives in the `office` scope of the record
  (§Persistence) so sibling Office products inherit the same choice.

## Privacy — delete profile and data (inside User settings)

- A clearly marked danger action: **Delete my profile and data**.
- Confirmation is the app's **own confirmation dialog** (modal component,
  consistent with the app's other dialogs). **Never** `window.confirm`,
  `window.alert`, or any browser-native dialog. Exactly **ONE**
  confirmation — no multi-step rituals, no type-to-confirm (the user was
  explicit: one confirmation, then it happens).
- The dialog copy states plainly what will be deleted and that it cannot
  be undone.
- On confirm, ONE action does all of it:
  1. **Server-side deletion** (authenticated endpoint, own account only):
     the user profile/settings record, the tier record, the file catalog
     entries AND their stored bytes (local objects / GCS), app shares
     the user owns. Enumerate every per-user store this codebase keys by
     principal (gateway stores; service/MCP per-user stores reachable
     from this deployment's wiring — agent threads/memory, saved apps,
     data sources) and delete what is the user's; the REPORT must list
     the coverage store-by-store and name anything deliberately out of
     scope with the reason.
  2. **Firebase Auth account**: attempt deletion of the sign-in account
     itself via the web SDK (`deleteUser`) in the same confirmed flow.
     If the SDK requires recent login, re-authenticate inline (same
     dialog flow) and retry once. The report states the final behavior
     exactly; dialog copy must not promise what the flow doesn't do.
  3. **Logout**: sign out, clear local session state, land on the public
     landing page, logged out.
  - After deletion, our side holds nothing for that principal: signing in
    again creates a FRESH, empty account (default tier, default
    settings, no files). Already-issued JWTs expiring naturally is
    acceptable; say so in the report if true.
- Cancel/close on the dialog = nothing deleted, still logged in, settings
  untouched.

## Validation (required — the user's word)

Isolated production-topology stack, your own ports (never the shared
8100 stack, never a dist another track serves; TMPDIR under
~/workspace; web dist via `npm run build:local-stack` + verify-dist when
the dist is involved). Browser tour, screenshots self-inspected:

1. Settings button present in the Workspace; the grid gains NO settings
   surface.
2. Theme: set Dark → Workspace dark AND an opened sheet dark
   (screenshots). Reload → still dark. **Fresh browser context → log in
   → dark is applied from the server record** (this proves database
   persistence, not localStorage). Set System with OS-dark emulated →
   dark; OS-light emulated → light. Set Light → light everywhere.
3. Name: change the display name → save → a SECOND user opens the same
   file → presence shows the NEW name (screenshot from the second user's
   view). Name persists across logout/login. Email field visibly
   read-only.
4. Delete: register a native-dialog handler in the tour and prove ZERO
   native dialogs fire in the whole delete flow. Cancel first → nothing
   changes. Confirm → API reads show the user record and files gone
   (404s), stored bytes gone, client lands logged-out on the landing
   page. Log in again → empty workspace, default settings.
5. Unit tests: settings store adapters; API ownership (another user's
   settings unreadable/unwritable; email change rejected); theme
   resolution (light/dark/system + default); deletion endpoint
   coverage. Gateway + web suites green; tsc clean.

Desktop note: the Workspace shell is the gateway-mode surface; desktop
local mode has no account and is out of scope for the settings UI in
this pass — but the shared web build must not break desktop (theme
attribute defaults sanely without a settings record). State it in the
report.

## Constraints

- Do not disturb: the running deploy, the shared 8100 stack, other
  tracks' isolated stacks/dists, or files they have in flight (notably
  the planner-fix and security-fix work in gateway/engine sources —
  coordinate by landing atomically and re-checking before edits).
- No stubs: every control in the surface must work end-to-end.
