# Accessibility

Decided October 18, 2026. Icecream Sheets is usable by everyone: keyboard-only
operators, screen-reader users, and users who need high-contrast or reduced-motion
presentation. Accessibility is a product requirement, not a feature — every UI
surface (web, desktop Mac, desktop Windows) exposes a complete, correct
accessibility tree and is fully operable without a pointer.

This doc is the authority on WHAT accessibility means for the product. It does
not replace the per-surface implementation notes in the platform-shell doc; it
defines the bar every surface must clear.

## 1. Compliance targets

- **Web app:** WCAG 2.2 AA. The browser builds the accessibility tree from the
  DOM; our job is to give it correct semantics (roles, names, states) and
  keyboard operability. Target browsers are the current evergreen set; testing
  runs against headless Chromium.
- **Desktop (Mac + Windows):** the Electron shell must expose the platform
  accessibility tree in full — macOS Accessibility API (NSAccessibility) and
  Windows UI Automation — for every surface: grid, ribbon, formula bar, status
  bar, dialogs, panes. The web content's ARIA maps through Electron/Chromium to
  the native tree; the shell must not disable or degrade that mapping.
- **Document content:** the existing Review > Accessibility checker (content
  issues: missing alt text, merged cells, low-contrast text) is unchanged and
  separate from this doc. This doc covers the *application* chrome.

## 2. Web app requirements

### 2.1 Grid semantics (the big one)

The grid is a virtualized `role="grid"` with `aria-rowcount` / `aria-colcount`
set to the *logical* grid size (up to 1,048,576 × 16,384), not the rendered
window. Each rendered cell is `role="gridcell"` with:

- `aria-rowindex` / `aria-colindex` — the TRUE 1-based indices, not the
  viewport-relative ones. A screen reader on row 500,000 must hear "row
  500000", not "row 12".
- `aria-selected` on the active cell.
- `aria-label` naming the cell: `"<Col><Row>: <value>"`, e.g. `"B2: 42"`.
  Empty cells say `"empty"`. Locked cells add `"(locked)"`.
- `aria-activedescendant` on the grid container points at the active cell's
  `id` (`cell-<row>-<col>`), so selection moves are announced without moving
  DOM focus.

Column headers are `role="columnheader"` with `aria-colindex` and a name that
includes sort/filter state ("Column B, sorted ascending"). Row headers are
`role="rowheader"` with `aria-rowindex`.

### 2.2 Ribbon, formula bar, status bar

- The ribbon tab strip is `role="tablist"`; each tab is `role="tab"` with
  `aria-selected`; tab panels are `role="tabpanel"`. Every ribbon control has
  an accessible name (visible text or `aria-label`); icon-only buttons always
  get `aria-label`. Disabled states use `aria-disabled`, not just grey paint.
- The formula bar input has `aria-label="Formula bar"` and announces the active
  cell address. Its autocomplete listbox is `role="listbox"` with
  `aria-activedescendant`.
- The status bar is `role="contentinfo"`. The error region is
  `role="alert"` (assertive) so recalculation errors are announced. Selection
  and mode changes are announced through a polite live region (`role="status"`).

### 2.3 Dialogs

Every dialog goes through the shared `A11yDialog` component
(`apps/web/src/components/A11yDialog.tsx`), which guarantees:

- `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing at the
  visible title.
- **Focus trap:** Tab/Shift+Tab cycle inside the dialog; focus cannot escape
  to the grid behind it. Escape closes the dialog.
- **Return focus:** when the dialog closes, focus returns to the element that
  opened it (or the grid).
- **Initial focus:** the first focusable control, or the dialog itself
  (`tabIndex={-1}`) when there is none.

No dialog may be closable by pointer only; every dialog has a keyboard path
(Escape, or a Cancel/Close button reachable by Tab).

**Non-modal panels** (e.g. the inference proposal panel) keep `role="dialog"`
without `aria-modal` and must NOT trap focus — the user keeps working in the
grid while the panel is open. They move focus into the panel on open and
return focus to the opener on close.

### 2.4 Keyboard operability

- Every pointer action has a keyboard equivalent: cell navigation (arrows, Tab,
  Enter, F2, Delete, Ctrl+arrows/Home/End), ribbon (Alt+letter keytips or the
  command palette Alt+/), context-menu actions (all in the command registry,
  reachable via palette), dialogs (Tab/Enter/Escape).
- **No keyboard traps.** Focus is always escapable.
- **Skip link:** the first focusable element is "Skip to grid", jumping focus
  to the grid container. A second skip target, "Skip to ribbon", exists for
  ribbon-first users.
- `:focus-visible` indicators on every interactive element: 2px solid outline
  with 3:1 contrast against adjacent colors, never `outline: none` without a
  replacement.

### 2.5 Announcements

- Cell value edits commit → the new value is exposed via the gridcell label.
- Recalculation errors → `role="alert"` in the status bar.
- Selection changes → via `aria-activedescendant` (no extra live region needed).
- Async operations (open/save/import/AI runs) → polite live region with
  start/complete/failure messages.
- Nothing announces more than once per user action (no double live regions).

### 2.6 Visual

- Text contrast ≥ 4.5:1 against its background (3:1 for large text ≥ 18pt).
  The contrast pairs are enumerated in `apps/web/src/a11y-contrast.test.ts`
  and asserted in CI.
- Focus indicators ≥ 3:1 against adjacent colors.
- Content remains usable at 200% browser zoom (the grid virtualizes; panes
  scroll; no fixed-pixel clipping of text).
- `prefers-reduced-motion`: animations and transitions are disabled.

## 3. Desktop requirements (Mac + Windows)

The desktop apps ship the identical web bundle, so all §2 semantics carry
over. The shell's additional obligations:

1. **Never disable the accessibility tree.** `main.ts` must not pass
   `--disable-renderer-accessibility` or any flag that suppresses it. To
   guarantee the tree is exposed even when no assistive technology is
   attached at launch, the shell passes `force-renderer-accessibility` on the
   command line before app ready.
2. **Native tree completeness.** Chromium maps the DOM accessibility tree to
   NSAccessibility (macOS) and UI Automation (Windows) automatically. The
   requirement is that the *whole* app window is exposed: menu bar actions
   (File > Open/Save), the web contents, and any native dialogs (file
   pickers are native and therefore accessible by default). No
   `BrowserWindow` may set `accessibleTitle` incorrectly or hide the window
   from assistive tech.
3. **Keyboard parity with web.** The desktop menu accelerators must not
   conflict with the web app's shortcuts (Ctrl+/ and Alt+/ work in both).
4. **Verification is manual** (see §5): automated tests cannot drive
   VoiceOver/NVDA from CI. The manual checklist is part of every release.

## 4. What is NOT required

- WCAG AAA. (AA is the bar.)
- Screen-reader testing of every one of the 70+ dialogs on every release —
  the shared `A11yDialog` component is tested once; dialogs using it inherit
  the guarantees. The manual checklist samples dialogs per release.
- Custom high-contrast theme in v1 (OS-level forced-colors is respected;
  a product theme is v2).
- Mobile native clients (out of scope per platform-shell §9).

## 5. Testing

### 5.1 Automated (CI, every build)

- `apps/web/src/a11y.test.ts` — axe-core over rendered key surfaces
  (grid shell, ribbon, formula bar, status bar, `A11yDialog`, skip link):
  **zero violations** at WCAG 2.2 AA ruleset.
- `apps/web/src/a11y-contrast.test.ts` — computed contrast ratios for every
  text/background pair used by the chrome: ≥ 4.5:1 (≥ 3:1 large text).
- `apps/web/src/components/A11yDialog.test.ts` — focus trap (Tab cycles),
  Escape closes, focus returns to the opener, `aria-modal` present.
- `apps/web/src/grid-a11y.test.ts` — gridcell `aria-rowindex`/`aria-colindex`
  equal true indices deep in the grid (e.g. row 500000), headers carry
  `columnheader`/`rowheader` roles.

### 5.2 Manual screen-reader checklist (per release)

Web (NVDA + Chrome, VoiceOver + Safari):
- [ ] Tab from address bar: skip link is first, activates and moves focus to grid.
- [ ] Arrow through the grid: each cell announces "column letter, row number, value".
- [ ] Jump to row 500000 (Go To): indices announced are true, not viewport-relative.
- [ ] Open each ribbon tab: tab name announced, controls have names, disabled controls announced as dimmed.
- [ ] Open 5 sampled dialogs: title announced, focus starts inside, Tab never leaves, Escape closes and focus returns.
- [ ] Trigger a formula error: announced via the alert region.
- [ ] 200% zoom: no clipped text, panes scroll.

Desktop Mac (VoiceOver):
- [ ] VoiceOver sees the full window: menu bar, ribbon, grid, formula bar, status bar.
- [ ] Grid navigation announces cells like the web build.

Desktop Windows (NVDA):
- [ ] Same as Mac: full tree, grid navigation, dialogs.

Failures file as P1 bugs against the release.

## 6. MCP surface

No MCP changes. Accessibility is a presentation-layer concern; the engine
protocol is unchanged. (Screen-reader users driving the app through the AI
agent get the same MCP tools as everyone else.)

## 7. Out of scope for v1

Product-provided high-contrast theme. Custom screen-reader verbosity settings.
Mobile native clients.
