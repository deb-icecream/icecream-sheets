# Ribbon Tab Strip Fit — issue #24 residual (REOPENED)

Status: COMPLETE 2026-10-22 ~18:52 PDT — validated, NOT pushed (parent pushes + closes #24)
Ports claimed: 9090-9099 (stack stopped after validation, ports free)
TMPDIR: ~/workspace/tmp-ribbon-strip

## Task
Make the ribbon TAB STRIP fit phone widths (390px, 480px): all 11 tabs + Share fully visible/clickable,
strip scrollWidth == clientWidth, no scrollbar, document never scrolls sideways.
820px/1440px behavior unchanged. No tab hidden; no label ellipsis.

## Verdict: PASS at every width

| width | BEFORE strip sw/cw | BEFORE doc | AFTER strip sw/cw | AFTER doc | verdict |
|---|---|---|---|---|---|
| 1440 | 1440/1440 | 1440 | 1440/1440 | 1440 | PASS — geometry byte-identical to before |
| 820 | 820/820 | 820 | 820/820 | 820 | PASS — geometry byte-identical to before |
| 480 | **625/480** (Extensions, Help, Share clipped) | 480 | 480/480 | 480 | PASS — all 12 controls visible, full labels, Share icon-only |
| 390 | **625/390** (Review, View, Extensions, Help, Share clipped) | **479** | 390/390 | 390 | PASS — all 12 controls visible, Layout/Ext short labels, Share icon-only |

Raw probes: probes-before.json / probes-after.json (this folder). Shots: shots/after-{390,480,820,1440}-ribbon.png,
shots/after-390-full.png, shots/before-*.png. All screenshots self-inspected.

### Click proof (scripts/clicks.mjs)
At 480px AND 390px: all 11 tabs clicked → aria-selected=true (11/11 each width); Share clicked →
share dialog opens. The abbreviated tabs were located by their FULL label text (DOM text never
changes), proving the visible short-form control is the real tab.

### Screenshot inspection notes
- after-390-ribbon.png: File Home Insert Draw **Layout** Formulas Data Review View **Ext** Help + Share
  icon — every label complete and readable, no clipping, no scrollbar.
- after-480-ribbon.png: all full labels incl. "Page Layout" and "Extensions"; Share icon-only, fully on-screen.
- after-1440-ribbon.png: identical to before (brand, full labels, Share icon + "Share" text).
- after-390-full.png: whole page fits; header wrapped (see below); grid + status bar render normally.

## What was wasting the width (the owner's point — he was right)
At the old ≤700px tier the strip spent: 5px×2 padding × 11 tabs = 110px, 1px gaps × 12 = 12px,
strip side padding 8px, Share's icon+text = 71px, 12px font. Pure label text was only ~402px of the 625px.

## Fix (compression ladder, narrowest-first)
ribbon.css, two new tiers appended after the existing ≤700px tier:
- **≤600px:** strip padding 6px **2px** 0, gap **0**, tab padding 6px **2px**, font **11px**;
  Share paints icon-only (`.ribbon-share-label { display:none }`) — title + aria-label keep it a
  labeled control. This tier alone fits 480px with ~19px to spare (full labels everywhere).
- **≤440px:** letter-spacing **-0.3px**; the two longest labels paint short — "Page Layout"→"Layout",
  "Extensions"→"Ext" — via `data-short` + CSS `::after { content: attr(data-short) }` while the
  button's own glyphs are font-size:0. DOM text and accessible name stay the FULL label at every
  width (unit tests + screen readers unaffected); the full label returns automatically above 440px.

Ribbon.tsx (tabstrip markup only — panel fit engine / More / triangles untouched):
- `TAB_SHORT_LABELS` map + `data-short` attribute on the two long tabs.
- Share label wrapped in `<span className="ribbon-share-label"> Share</span>`; button gained
  `aria-label="Share"`.

## Bonus fix (required by the "document never scrolls sideways" acceptance at 390px)
The 390px document overflow (479px) was NOT the strip — element-chain probe (scripts/docwide2.mjs)
proved it was `.app-header`'s sync-status button: the header is an unclipped inline-styled flex
row whose controls total ~491px at 390px wide. Minimal containment in index.css:
`@media (max-width: 600px) { .app-header { flex-wrap: wrap; row-gap: 4px } }` (flex-wrap is not
set by the header's inline styles, so the rule applies cleanly). Every header control stays
visible and clickable — the header wraps to extra rows on phones instead of pushing the page
sideways. Visible in shots/after-390-full.png. The panel fit engine was not touched.

## Tests (testing economy — ribbon-related + tsc only)
- vitest: ribbonIcons 235 + RibbonSaveGating 3 + ribbonParity 3 + clipboard 7 = **248/248 PASS**,
  exit code 0 read un-piped (log: tests.log).
- tsc: clean — `npm run build:local-stack` (tsc && vite build && verify-dist) exit 0 on the final
  tree; validation ran on that dist (runtime-build-final.log).

## Files changed (3)
- apps/web/src/ribbon/ribbon.css — ≤600px and ≤440px tab-strip tiers.
- apps/web/src/ribbon/Ribbon.tsx — TAB_SHORT_LABELS/data-short; Share label span + aria-label.
- apps/web/src/index.css — ≤600px .app-header flex-wrap containment (bonus, see above).

## Progress log
- [x] Read current Ribbon.tsx tabstrip + ribbon.css tiers
- [x] Measure BEFORE at 390/480/820/1440
- [x] Add narrow compression tiers + Share span + data-short
- [x] Rebuild own dist (build:local-stack + verify-dist)
- [x] Validate on local stack, screenshots self-inspected
- [x] Ribbon tests + tsc only
