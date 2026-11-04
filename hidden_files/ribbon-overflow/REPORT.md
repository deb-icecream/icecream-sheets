# Ribbon horizontal-scrollbar fix — REPORT

**Task:** user report 2026-10-22 ~16:58 PDT — ribbon shows a horizontal scrollbar on Home, Insert, Formulas, Data tabs. Fix per user spec (BOTH mechanisms):
1. No scrollbar ever (overflow hidden, no native scroll).
2. Fit as much as possible: compress groups (spacing → labels → group-collapse-to-dropdown, Excel behavior), deterministic order, never hide File tab / account controls.
3. Triangle scroll buttons (left/right) pinned at ribbon content row ends for residual overflow; disabled/hidden at ends; absent when no overflow.

**GitHub issue:** #24 — https://github.com/is-cream/icecream-sheets/issues/24 ("Ribbon shows horizontal scrollbars on Home/Insert/Formulas/Data tabs — replace with fit-compression + triangle scroll buttons")

**Port block claimed: 9090–9099** (local production-topology stack for validation).

**TMPDIR:** ~/workspace/tmp-ribbon

## Progress log
- 2026-10-22: checkpoint created. Exploring ribbon implementation (apps/web/src/ribbon/Ribbon.tsx + ribbon.css).

## Root cause
- `apps/web/src/ribbon/ribbon.css` `.ribbon-panel { overflow-x: auto; }` — the panel is a native
  horizontal scroll container; wide tabs (Home/Insert/Formulas/Data) overflow the viewport, so the
  browser paints a horizontal scrollbar under the group labels. (overflow-y computes to auto too,
  so a vertical scrollbar is equally possible.) Empirically confirmed by the e2e sweep's own shot
  `21-ins-Chart.png`: at 1600px the Insert panel content already runs past the right edge.
- Tab strip has no overflow handling at all (flex, nowrap tabs) — must also never scroll.

## Fix design (planned; implementing after BEFORE screenshots)
- New `RibbonPanel` component in Ribbon.tsx wraps the panel: `.ribbon-panel-wrap` (flex) >
  optional left/right `.ribbon-scroll-btn` triangles + `.ribbon-panel` (overflow: hidden) >
  `.ribbon-panel-content` (the actual flex row; overflow-x: hidden = programmatic scroll only,
  scrollbar-width: none + ::-webkit-scrollbar{display:none} => no scrollbar can ever paint).
- Panel children are all `RibbonGroup` elements (verified); the wrapper extracts them from the
  per-tab fragments and manages them as an ordered item list.
- Fit engine (deterministic, measured with scrollWidth vs clientWidth after each render):
  compression levels L1 tighten spacing/padding → L2 compact (smaller buttons/icons, selects
  narrow) → L3 icon-only small buttons (labels hidden, title tooltips remain; selects keep
  captions hidden) → then collapse whole groups right-to-left into a pinned "More ▾" dropdown
  (groups keep their order and full controls inside the popup; at least one group stays visible)
  → residual overflow only then enables the triangle buttons.
- Triangles: pinned flex children of the wrap (28px), smooth-scroll ~80% of visible width per
  click, disabled at the scrolled-to end, both unmounted when there is no overflow. Resize or
  tab switch resets fit state and re-measures.
- Tab strip: overflow hidden + tighter tab padding under 900px so all 11 tabs + Share stay
  visible without scrolling (File tab and Share are never hidden).

## Validation — FINAL (production-topology stack, ports 9090/9091/9092, dist via build:local-stack + verify-dist OK; harness in scripts/; probes probes-after-{1440,820}.json; shots in shots/)

### Per-tab before/after verdicts
- BEFORE (tour, old build): `.ribbon-panel { overflow-x: auto }` — panel scrollWidth ≫ clientWidth on every wide tab at 1440px (Home 3888, Insert 3883, Formulas 3335, Data 4792); at 820px the TAB STRIP also overflowed (scrollWidth ~1066 vs 820) and the whole document scrolled sideways.
- AFTER 1440px — PASS, all four tabs: panel overflowX/Y hidden, content scrollWidth == clientWidth 1432, NO scrollbar, NO triangles. Home fit-3 with 4 groups visible + More (Styles/Cells/Editing collapsed); Insert 11 groups + More; Formulas and Data fit by compression alone (no More).
- AFTER 820px — PASS, all four tabs: scrollWidth == clientWidth 812, fit-3 + More on all (Home: 2 visible groups; its More holds Alignment/Number/Styles/Cells/Editing = 29 buttons). Tab strip scrollWidth 820 == clientWidth 820; document never scrolls sideways (docScrollWidth == innerWidth at every width tested).
- More menu (1440): popup fully on-screen, right-aligned to the More button; all collapsed groups in original order, every button labeled; clicking a control inside performs its action. Final shot: shots/after-1440-more-menu2.png (self-inspected — clean).

### Triangle buttons — PROVEN at 480px on Formulas (widest first group, Function Library)
Both triangles mount (28px each) only when a single surviving group + More still overflows: left disabled at start, right enabled; content 460 vs visible 416; ▶ click smooth-scrolls 0→44 (exactly the residual), left enables, right disables at the end; ◀ returns to 0. Shots: shots/tri-480-formulas-initial.png / tri-480-formulas-at-end.png (self-inspected). At 480px Home needs no triangles (collapse leaves Clipboard + More, which fits) — by design.

### Menu-popup clipping — a second defect found and fixed in this batch
The clipping panel (overflow:hidden) slices ANY ribbon popup at the panel's bottom edge: per CSS, every overflow-clipping ancestor in the containing-block chain clips absolutely-positioned descendants. Proven by A/B/C/D/E variant tests in a dev build: removing either the panel's or the content row's hidden overflow alone still clipped; the OLD `overflow-x:auto` panel clipped too — the defect is PRE-EXISTING (short menus fit inside the 96px panel; taller ones were silently cut, reachable only by scrolling the panel). It became load-bearing for #24 because collapsed groups' only access path is the More popup. FIX: `RibbonMenu` (RibbonControls.tsx) and `RibbonCollapsedMenu` (Ribbon.tsx) now render popups via createPortal to document.body with position:fixed, anchored to the button's rect (More menu right-aligned), closing on outside click / Escape / any scroll / resize. Paint proof: temporary-red popup paints unbroken to its bottom edge in dev; final prod More-menu screenshot shows all three sections fully painted below the panel. Regular menu probe on the final build: popup 121–235 fully visible vs panel bottom 177.

### React #185 ("Maximum update depth exceeded") — three root causes found & fixed during this batch
1. A ResizeObserver reset fed the fit's own layout changes back in as resets → replaced with a debounced window-resize listener only.
2. A passive reset effect running on MOUNT let computeFit measure an already-collapsed DOM, yielding a poisoned fit → the mount run is skipped (prevResetKeyRef) and computeFit is zero-gated (only runs on commits whose fit is FIT_ZERO).
3. Dispatching a same-value setState from a layout effect is self-sustaining even with an equality guard inside the updater (React must render to discover equality; the render re-runs the no-deps layout effect, which dispatches again) → scrollEnds/setFit now compare via ref mirrors and dispatch only on real change.
Related hazard: ribbon tab content renders in waves (lazy chunks), so a fit measured against a partial DOM is wrong (Formulas first read 796 vs true 3311). A verification pass 200ms after every fit commit re-measures from the content's DIRECT children (open popups cannot inflate it) and re-fits (≤4 attempts per tab, epoch counter forces the pass when a reset is a no-op state change).

### Residual (honest)
At 480px the TAB STRIP's content is 625px > 480px viewport — the strip's right end still clips (11 tabs + Share cannot fit 480px without hiding tabs, which the spec forbids for File/controls; brand text is already hidden ≤700px and two compression tiers apply ≤1150/≤950px). The strip fits at 700/820/1440; the document never scrolls sideways and the ribbon PANEL fits at every width including 480.

### Tests
Ribbon-related only (per testing economy): ribbonIcons 235/235, RibbonSaveGating 3/3, ribbonParity 3/3 — 241/241 PASS. tsc clean (build:local-stack exit 0 on the final tree).

## Files changed (NOT pushed — parent pushes)
- apps/web/src/ribbon/Ribbon.tsx (RibbonPanel fit engine, RibbonCollapsedMenu, strip untouched structurally)
- apps/web/src/ribbon/RibbonControls.tsx (RibbonMenu portal)
- apps/web/src/ribbon/ribbon.css (panel/wrap/content/scroll-btn rules, fit tiers, strip compression tiers, popup portal rules)

