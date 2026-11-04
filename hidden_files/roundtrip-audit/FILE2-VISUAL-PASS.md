# File 2 — Browser-reopen VISUAL pass (round-trip data-loss audit, owed piece)

File: test-data/real-world/closedxml-TryToLoad-DrawingSizeInPx.xlsx (981,840 B, 16 sheets, 23 embedded images)
Stack: isolated signed stack — gateway 8810 / engine 8811 / web 6174 (shared 8100 stack untouched). Web dist: the standing `apps/web/dist` (verify-dist OK: gateway 8100 + signed baked), served from a byte-rewritten copy (8100→8810) — `apps/web/dist` itself untouched, nothing to restore.
Method: sign in (local-dev user f2visual) → upload via the Workspace product path → deep-link open → visit EVERY sheet tab → screenshot → self-inspect every screenshot. DOM probes + engine API read-backs as supporting evidence.
Harness/engine-level loss-free proof already exists (item-G fix: 85/85 literal empty-string cells survive both save paths). This pass is the VISUAL reopen check only.

## Overall: FAIL — on the drawings leg

- **Cell data + formulas: PASS, 16/16 sheets.** Every sheet's cell content renders correctly in a settled session; the file's only formulas (8, on 'International Settings') display computed values that match the file's cached values exactly; zero error values and zero error banners in any valid run.
- **Drawings/pictures/shapes: FAIL.** This file is a drawing-size test fixture (23 embedded images across 3 drawing parts) and **none of them render** — not the 22 pictures on 'Images', not the icon on 'icons', not the shape on 'International URLs'. Zero `<img>` elements, zero `<canvas>`, zero CSS background images, zero media requests in the client; zoomed clips of the exact anchor regions show empty grid (01b-icons-clip.png, 06b-Images-clip.png). The data is not lost (the round-trip audit proved the parts survive save); this is a display-layer gap: on reopen, embedded pictures/shapes are dropped from view.
- **Second defect (timing):** a sheet first switched to while the post-open checkpoint is in flight (status bar "Saving…") can stay blank for the entire visit — its data never arrives and no retry was observed over 10+ idle seconds; leaving and re-entering the sheet once settled paints it fully. Reproduced twice (details below). Server-side data is intact throughout (API read-backs 200).

Formula evidence (engine read-backs through the signed lane): 'International Settings' A12 `=A9&"beta/"` → `http://g-ecx.images-amazon.com/images/G/01/rainier/help/ff/beta/` (== cached); A21 (defined-name IF chain) → `…/ff/IntMiscData.txt` (== cached). 'Valid Values' A1 → "Product Type"; 'Browse Data' A1 → "Browse Node"; 'AttributePTDMAP' A1 → `""` (one of the item-G literal empty-string cells, present and correct).

## Per-sheet verdicts

- [x] 01 'icons' — DATA: correct (source has 0 cells; grid empty). DRAWINGS: **FAIL** — the sheet's only content, one picture (14×16 px, anchored M2), does not render; clip of the M2 region is empty grid. Screenshots: 01-icons.png, 01b-icons-clip.png
- [x] 02 'International URLs' — DATA: PASS (Language/Contact URL table from row 13, https URLs, ENDSECTION, second MWS URL table). DRAWINGS: **FAIL** — one shape 1152×155 px anchored A2 (drawing2) not rendered; VML comments not rendered. Screenshot: 02-International-URLs.png
- [x] 03 'International Settings' — PASS. Settings table renders; all 8 formulas show computed URL strings (rows 9–14 concatenations, rows 21–23 defined-name IF chains); A1 FALSE flag renders; no error values. Screenshot: 03-International-Settings.png
- [x] 04 'DropdownSizer' — PASS. Grid empty, CORRECT: the source sheet contains zero cells (it only carries column widths). Screenshot: 04-DropdownSizer.png
- [x] 05 'Instructions' — PASS. Instruction text renders down column A. Screenshot: 05-Instructions.png
- [x] 06 'Images' — DATA: PASS (labels 'Image Standards', 'Image Size', naming rules render). DRAWINGS: **FAIL** — the sheet's 22 pictures + shapes (drawing3, anchored in column B beside the labels) do not render; column B is completely empty in both the full shot and the clip. Screenshots: 06-Images.png, 06b-Images-clip.png
- [x] 07 'International Translations' — PASS. Translation key/value table renders (767 values in source). Screenshot: 07-International-Translations.png
- [x] 08 'Data Validation' — PASS. Header row renders (Required Column / Validate… / Error Text / Height); the remaining ~23,649 rows are validation rules with no cell values in the source, so an otherwise empty grid is correct. Screenshot: 08-Data-Validation.png
- [x] 09 'International Data' — PASS. Data table renders (REVDATE serial, TABLETYPE, codepage/locale rows, toolbar rows). Screenshot: 09-International-Data.png
- [x] 10 'Example' — PASS. Wide example product table renders (SKUs, titles, UPCs in scientific notation as stored, brands, bullet points; 221 non-empty cells in the visible window). Screenshot: 10-Example.png
- [x] 11 'Data Definitions' — PASS. Field-definition table renders (Field Name / Definition / Accepted / Example / Required?). Screenshot: 11-Data-Definitions.png
- [x] 12 'Template' — PASS. Header rows render (TemplateType=fptcustom in A1, Product Title/Seller SKU/Title/… column headers, feed_product_type/item_sku/item_name field row). Note: tour 1's renderer crashed switching to this sheet; it did NOT reproduce in two later fresh sessions — treated as part of the tour-1 infra event, not a sheet defect. Screenshot: 12-Template.png
- [x] 13 'Browse Data' — PASS. Exactly its 4 source cells render: 'Browse Node' / 'Browse Path' / 'tax-preparation-software' / 'Software, Tax Preparation' (verified against the sheet XML). Screenshot: 13-Browse-Data.png
- [x] 14 'Valid Values' — PASS (settled visit). Dense valid-value matrix renders (Product Type header; GTIN/EAN/ISBN/UPC/ASIN; OS and format value lists; 402 non-empty cells in the visible window). Screenshot: 14-Valid-Values.png (tour-4 settled capture)
- [x] 15 'Dropdown Lists' — PASS (settled visit). Dense lists render (418 non-empty in window); row 1 is blank CORRECTLY — A1/B1 are literal empty-string cells in the source ('' per sheet XML), data starts at A2 'software'. Screenshot: 15-Dropdown-Lists.png
- [x] 16 'AttributePTDMAP' — PASS (settled visit). Attribute map renders (A1 is a literal '' cell — correctly blank; B1 'software'; attribute names + '1' flags). Screenshot: 16-AttributePTDMAP.png (tour-4 settled capture)

## Defect 2 — sheet switched during the post-open checkpoint window stays blank for the visit

- Tour 3 (fresh upload, sheets visited in quick succession right after open, status bar "Saving…" throughout): 'Template' painted; the next four sheets visited ('Browse Data', 'Valid Values', 'Dropdown Lists', 'AttributePTDMAP') all stayed blank, with exactly four `/read` 404 responses in the window.
- Tour 5 (deliberate reproduction): switched to 'Dropdown Lists' the moment the tab strip appeared; still 0 rendered cells at +2 s and at +12 s (status back to "✓ Saved", no re-fetch issued); diag-selfheal-2s.png / diag-selfheal-12s.png show the blank sheet. Re-entering the same sheet settled painted 418 cells.
- Tour 4 (settled session): the same sheets paint in <1.8 s (Valid Values 402 cells, AttributePTDMAP 58, Example 221); its read log shows the only 404s are in the open phase — a range read for the placeholder name "Sheet1" and the initial 'icons' range read (rows 0–29) — i.e. reads issued before the workbook build settles get the item-H "absent" 404 instead of a pending/retry outcome, and a sheet whose first read lands in that window is never retried during the visit.
- Relation to known items: same family as sweep item H (stale-sheet reads racing the load through the build gate) — the 404 contract is deliberate for genuinely absent sheets, but here it also fires for existing sheets during the build/checkpoint window and the client does not recover within the visit. Data-loss risk: none observed (server state intact; display-only).

## Console / page errors

- Valid runs: zero page errors; per-sheet DOM probes found no error banners and no error cell values on any sheet.
- Console (tour 3 capture): 1× 401 `POST /api/engine/session-extras` — the known item-L stale-token family, self-healing, also observed in earlier tours; 4× 404 `/read` — see Defect 2 (tour 4's log attributes the open-phase pair: "Sheet1" placeholder probe + initial 'icons' range read).
- Tour 1's renderer crashed once switching to sheet 12 ('Template') and its raw console capture was lost; the crash did not reproduce in tours 3–5.

## Run / infra notes

- Five tours across two stack lifetimes. Tour 1 covered sheets 1–11, then its renderer crashed; minutes later the engine process died silently (log ends 11:01 UTC mid-autosave-checkpoint, no error lines; VM has 7.9 GB RAM and no swap — consistent with memory pressure or the evening's daemon-restart bursts). Tour 2 therefore hit "gateway 502: engine claim failed: fetch failed" and its five screenshots are INVALID (failed-join page) and were discarded/overwritten. The stack was restarted fresh (new data dir, file re-uploaded) for tours 3–5.
- Engine checkpoints of the unmodified workbook are byte-stable across sessions (identical checksum 2bb42321c1647ab… in every autosave-settle checkpoint), consistent with the harness-level loss-free verdict.
- Screenshots: hidden_files/roundtrip-audit/file2-visual/ (16 canonical + 01b/06b clips + diag-* diagnostics). Tour scripts + results: hidden_files/roundtrip-audit/file2-visual-run/ (tour.mjs…tour5.mjs, results*.json, start_stack.py).
- No product code was modified. progress.md untouched. Nothing pushed.
