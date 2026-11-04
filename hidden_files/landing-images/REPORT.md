# Landing product-image replacement — REPORT

Task: replace defective product screenshots on the icecream-sheets public landing page (user order). Known defect: apps/web/public/product/pivotchart-960.png shows pivot-cache error dialogs + a red "Add-on refresh failed: gateway 404" status-bar error.

## Checkpoint log
- [x] Step 0: checkpoint created.
- [x] Step 1: enumerate all landing images + srcset variants; inspect each; mark defective ones.
- [x] Step 2: produce a real replacement screenshot (populated pivot/PivotChart, no errors) from the actual web app on a local stack.
- [x] Step 3: generate all size variants, swap in.
- [x] Step 4: rebuild dist (build:local-stack + verify-dist), re-shoot affected landing sections at 1440 + 390, self-inspect.
- [x] Step 5: final report.

## Final report

**Defective images (both replaced):** `pivotchart.png` (1600w) and `pivotchart-960.png` (960w) — the same capture of the FMTs sheet in the perf-p75-family workbook, showing a stack of 7 pivot-cache error dialogs ("The pivot cache for 'pvtCF' was saved without records (saveData="0") — refresh the pivot from its source to populate it.") plus a red status-bar error ("Add-on refresh failed: gateway 404: no backend route for /api/addons/catalog"). All other landing images were inspected and are clean: hero-dashboard.png / hero-dashboard-960.png (populated Executive Dashboard, "Ready") and collab.png / collab-960.png (clean, sparse; kept per tasking).

**Replacement source + how the pivot populates:** built live in the real web app (local mode, plain vite build served on my own port 8974) from the project's shared fixture `hidden_files/shared-fixtures/sales.csv` (24 real orders). Opened the CSV → Insert ▸ PivotTable → Rows=region, Columns=product, Values=Sum of revenue → the app's own pivot engine computed the table from the source rows (no cached records involved, so nothing to be "saved without records") → clicked the pivot panel's PivotChart button to insert the bound PivotChart, dragged it right and enlarged it. Capture: 1600×1000, self-inspected at full size — pivot fully readable (East/Gizmo 1,947; North/Widget 539.46; South/Gadget 1199.4; West/Doohickey 342; Grand Total 4027.86 — the fixture's known ground-truth total), chart bars match the table, status bar "Ready"/"✓ Saved", zero console errors across the run. Drivers: ~/workspace/tmp-landing-images/capture3.mjs; accepted frame: ~/workspace/tmp-landing-images/shots6/final-1600.png.
  - Rejected along the way: closedxml-xlsx-column-style-autofilter.xlsx (pivots genuinely populated from stored records, but the app opens a PivotTableView panel for all 17 imported pivots stacked center-grid — not a clean homepage shot); the defective file's own family (caches saved without records — the original defect).

**Variant files written (same filenames + dimensions as before):**
- `apps/web/public/product/pivotchart.png` — 1600×1000, the accepted capture.
- `apps/web/public/product/pivotchart-960.png` — 960×600, PIL LANCZOS downscale; self-inspected, legible, error-free.

**Rebuild + section re-shots:** `npm run build:local-stack` passed (tsc clean; verify-dist OK — gateway localhost:8100 + signed baked); dist copies of both images are byte-identical (md5) to the new public files. Re-shot the Excel-stats landing section from the rebuilt dist (driver ~/workspace/tmp-landing-images/reshoot.mjs):
- `hidden_files/landing-images/shots/landing-pivot-desktop-1440.png` — new image renders in the section frame; pivot + chart readable inside; no errors; zero console errors; browser picked `/product/pivotchart.png`.
- `hidden_files/landing-images/shots/landing-pivot-iphone-390.png` — section renders at phone width with the 960 variant (srcset verified: currentSrc = pivotchart-960.png), no overflow, no errors.
Nothing deployed; progress.md untouched; no git push (parent handles).

## Findings

### Step 2 — setup
- Port block claimed for this program's isolated stack: **gateway 8970 / engine 8971 / web 8974** (8960-8965 are another program's live stack — untouched).
- Fixture scan (zip-level): files whose pivot caches carry real records: closedxml-xlsx-column-style-autofilter.xlsx (5 caches, records up to 933 KB, 17 pivot tables, 0 charts); closedxml-TryToLoad-PivotTableWithMissingReference.xlsx (39 KB records, 1 table); cycle5 pivot-table-closedxml.xlsx (2 KB records). The defective image's source file (cycle6 pivotchart.xlsx = perf-p75 family) has 7 pivot tables + 4 charts but ZERO cache-record parts — caches saved without records, which is exactly why it renders error dialogs. Not reusable as-is.
- Autofilter file TESTED in-app (local mode, own static server on 8974, plain vite build): pivot data IS populated (DesktopUsage Yes 3094 / 96.81%, total 3196; status bar "Ready", no console errors) BUT the app opens a PivotTableView panel for every one of the 17 imported pivots, stacked center-grid — unusable as a clean homepage shot. Rejected as the replacement source.
- DECISION: build the shot in-app from real data — shared-fixtures sales.csv (24 orders; regions East/North/South/West; products Doohickey/Gadget/Gizmo/Widget; revenue total 4027.86 = project ground truth). Flow: open CSV → Insert ▸ PivotTable → Rows=region, Columns=product, Values=Sum of revenue → pivot panel → its "PivotChart" button inserts the bound chart. Matches the landing alt text ("a live chart drawn from a pivot table in the same sheet") exactly, with sales data like the rest of the page.
- Capture iterations (drivers in ~/workspace/tmp-landing-images/capture*.mjs; local-mode dist served on 8974): v1 field-picker matched an ancestor div → pivot built on order_id (rejected). v2 fixed (span.parentElement) → correct pivot + chart, overlapping panels. v3 arranged: chart dragged to (800,330) and resized to 655×425 (PivotTable panel is not header-draggable; its default spot frames well). First v3 frame had browser text-selection highlighting from the drags → cleared selection + neutral cell click.
- **ACCEPTED capture: ~/workspace/tmp-landing-images/shots6/final-1600.png (1600×1000), self-inspected at full size.** Shows: source table (24 sales orders); PivotTable1 panel fully readable — East/Gizmo 1,947; North/Widget 539.46; South/Gadget 1199.4; West/Doohickey 342; Grand Total **4027.86**; footer "24 of 24 source rows · Sum of revenue"; PivotChart panel "PivotChart of Sum of revenue" with matching bars + legend. NO dialogs, NO error values, NO error banner; status bar "Ready", "✓ Saved"; zero console errors during the whole run.

Landing references (LandingPage.tsx srcSet): hero-dashboard (960w + 1600w), pivotchart (960w + 1600w), collab (960w + 1500w). Six files in apps/web/public/product/.
- pivotchart.png (1600w): **DEFECTIVE** — inspected: stack of 7 pivot-cache error dialogs (pvtIS, pvtCF, pvtBS, pvtCpR, pvtYoY, pvtEarnings; "The pivot cache for 'pvtCF' was saved without records (saveData="0") — refresh the pivot from its source to populate it.") over the FMTs sheet, plus red status-bar error "Add-on refresh failed: gateway 404: no backend route for /api/addons/catalog". REPLACE.
- pivotchart-960.png (960w): **DEFECTIVE** — same capture, downscaled (parent-verified + consistent). REPLACE.
- hero-dashboard.png / hero-dashboard-960.png: CLEAN — Executive Dashboard sheet, 4 populated charts (Earnings, Cash Flow, YoY Revenue Growth, COGS % of Revenue), status bar "Ready", no errors. KEEP.
- collab.png / collab-960.png: CLEAN but sparse (3x3 test values, presence chips alice/user, "Ready"). No error shown. KEEP per tasking.
