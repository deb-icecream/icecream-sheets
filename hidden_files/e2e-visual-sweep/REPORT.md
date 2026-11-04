# E2E Visual Sweep — icecream-sheets web app (2026-10-22)

Task: user-requested end-to-end visual validation. Open ONE simple .xls, screenshot + self-inspect
everything, exercise ALL ribbon options, report anything wrong. NO product fixes in this run —
anomalies become numbered findings for the parent to file in the bug tracker.

## Port claim (BEFORE starting any stack)
PORT BLOCK: 9060-9069 (this sweep only)
- gateway: 9060
- engine: 9061
- web (static dist server): 9062
- (spare: 9063-9069)

## Log
- [started] checkpoint created, ports claimed.

## FINDING F-1 (build break, current tree) — 2026-10-22 ~21:5x UTC
- `cd apps/web && npm run build:local-stack` FAILS at the tsc step:
  - `src/App.tsx(1386,21): error TS2448: Block-scoped variable 'productApi' used before its declaration.`
  - `src/App.tsx(1386,21): error TS2454: Variable 'productApi' is used before being assigned.`
- The useEffect fetching the collab file NAME (line ~1369-1386, the in-flight D9 work) lists
  `productApi` in its deps, but `const [productApi] = useState(...)` is declared at line 1543.
  Beyond the type error, the deps array is evaluated during render before the declaration
  executes -> a runtime TDZ ReferenceError on boot. Tree cannot build/boot as-is.
- Context: the hosted-UX fix batch is actively editing App.tsx (mtimes 21:44, 21:56 UTC).
  Per tasking I do NOT fix product code; the sweep proceeds as soon as the tree compiles again.
- Severity: BLOCKER (for any build from the current tree). Expected: tsc clean. Actual: 2 errors above.

## FINDING F-2 — Workspace upload refuses legacy .xls (2026-10-22)
- Action: signed in (dev), set #ics-upload-input to simple.xls (valid BIFF8, 5,632 B).
- ACTUAL: red banner "Only .xlsx and .csv files can be uploaded." — file rejected client-side;
  nothing uploaded (shots/04-after-upload.png). The upload-grant call (issue #10) never fires.
- Source: apps/web/src/product/Workspace.tsx:305 + input accept=".xlsx,.csv" (:460); the
  rejection text is pinned by Workspace.test.tsx:386 — deliberate per the 2026-10-21
  upload-formats ruling (Workspace upload = xlsx+csv). BUT the app otherwise fully supports
  .xls (BIFF adapter; round-trip corpus) and the ribbon's own open input
  (ribbon/Ribbon.tsx:1730) also omits .xls from accept. Net effect: there is NO file-picker
  path that admits a legacy .xls; only drag-drop/API remain.
- EXPECTED (user's e2e request): a simple .xls opens in the app. Severity: MEDIUM
  (design conflict to adjudicate, not a crash).

## CONFIRMATION of known issue #1 (D1) in current tree
- shots/01-workspace.png: after dev sign-in the Workspace header shows tier pill "DEFAULT"
  and "0 of 10 files" (signed-in data) AND a "Sign in with Google" button at top-right —
  the split state, reproduced in the local dev posture of the CURRENT tree (fix batch's
  coherence work is still in flight; recorded as confirmation, not a new finding).

## Environment notes (not product findings)
- /api/addons/* returns 502 in this stack: the addons service (packages/service) is not part
  of the gateway+engine topology used here; catalog calls fail soft in the UI.
- /api/engine/session-extras 401 in signed mode is by design (noted in the D6 record); the
  app swallows it.
- /api/settings 404 fired twice during initial boot (before sign-in completed), then the
  Settings page loaded fine ("Currently showing: Light"). Recorded under console noise;
  will re-check in later phases.

## FINDING F-2 UPGRADED — legacy .xls has NO entry path in web/gateway mode (HIGH)
Proven at three independent layers (code + live behavior):
1. Workspace upload (UI): rejects with "Only .xlsx and .csv files can be uploaded."
   (Workspace.tsx:305; accept=".xlsx,.csv"; shots/04-after-upload.png).
2. Gateway upload-grant: sourceFormatForFileName() returns 'xlsx'|'csv'|null
   (packages/gateway/src/deploy/userStore.ts:529); a .xls name gets HTTP 400
   "unsupported file type: only .xlsx and .csv files can be uploaded" (gateway.ts:1281).
3. Opening from inside the app (ribbon File>Open -> onOpenFile -> collab load): the client
   hardcodes format 'xlsx' (apps/web/src/services/collabTransport.ts:1126,1240) and the
   engine /load accepts ONLY 'xlsx'|'csv' — anything else is HTTP 400 "only formats 'xlsx'
   and 'csv' are supported" (packages/gateway/src/services/engineSvc.ts ~5095). Live result:
   status bar "Could not open a session for the new file — the previous workbook is
   unchanged." (shots/05-grid-open.png, phase 1c run).
Net: the engine's BIFF adapter exists and .xls round-trips in desktop/local flows, but a
user of the WEB app cannot open a legacy .xls by any path. Expected (user's request):
a simple .xls opens. Actual: refused at every door. Severity: HIGH.

## FINDING F-3 — a failed local-file open poisons the live session (HIGH)
Phase 1c sequence: sign in -> +New (healthy blank session; phase 1b proved typing, undo,
redo all work there) -> ribbon open of simple.xls fails (F-2) -> afterwards the STILL-OPEN
blank workbook stops accepting edits: typing into A9 produced nothing, and the network log
shows a persistent 401 storm on /execute and /api/engine/session-save-status for the rest
of the run (dozens of repeats; see results.json network/console arrays, steps 'editing' and
'copy-paste' of the 1c run). Expected: a failed open leaves the previous workbook fully
usable (the status-bar message even promises "the previous workbook is unchanged").
Actual: previous workbook is open but dead. Severity: HIGH.
(Note: this matches the shape of the cross-finding already relayed to the hosted-UX batch —
upload/open flows clearing the stored gateway token, feeding issues #10/#1.)

## Sweep adaptation (recorded per tasking)
The .xls itself cannot be opened by any legitimate web path (F-2). The sweep continues on a
content-identical twin, simple.xlsx (same sheet/cells/formula/date/percent, produced by
LibreOffice conversion and read-back-verified), opened through the sanctioned Workspace
upload path. The sweep's subject — the app's functions on this simple data — is unchanged;
the .xls verdict stands as F-2.

## FINDING F-4 — a failed session join renders a phantom editable grid (MEDIUM-HIGH)
Phase 1d, second run: clicked simple.xlsx in the Workspace. The app navigated to the grid,
header showing "simple.xlsx", ribbon live, cells clickable — but the workbook never loaded
(empty grid, NO sheet tab at all, just "+"). The only signal is red status-bar text:
"Could not join file file-bc8d9f6c-60bc-4f27-9942-28cac6d78ace: gateway 409:
{"ok":false,"error":"engine claim failed: engine already owns a different file:
file-b2599743-7aaa-4ee6-8c8b..." (shots/05-grid-open.png + 06-b4-selected.png, this run).
Typing into the phantom grid silently does nothing. Two defects in one: (a) a failed join
should block editing / show a blocking error state, not a working-looking grid;
(b) the error copy leaks raw internal file UUIDs and gateway JSON to the user surface.
Context: the 409 itself is legitimate one-file-one-owner arbitration — my single local
engine already owned a blank file claimed by an earlier phase; production routes per-file.
The phantom-grid UX on ANY join failure (owner-kill races can produce them too) is the
product defect. Severity: MEDIUM-HIGH.

## Harness note
Single-engine local topology = one owned file at a time. Stack restarted with a wiped
runtime so simple.xlsx is the FIRST (only) file claimed; later phases open only it.

## FINDING F-5 — stored number formats (date, percent) NOT applied on load (HIGH)
Fixture proof: simple.xlsx styles.xml defines numFmt 165 "yyyy-mm-dd" and 166 "0%";
cellXfs[1]->165 (cell B6, value 46317 = 2026-10-22), cellXfs[2]->166 (cell B7, value 0.25).
The app renders B6 as "46317" and B7 as "0.25" (shots/05-grid-open.png, final run; DOM text
agrees). Expected: "2026-10-22" and "25%". Everything else about the load is correct
(labels, numbers, SUM=30, formula bar "=SUM(B2:B3)", sheet name "Data"). A spreadsheet that
shows a date as a raw serial and a percentage as a fraction mis-displays the user's data.
Severity: HIGH.

## Phase 1 verdicts (final stack, simple.xlsx opened via Workspace upload)
- Workspace: PASS (header, +New, Upload, list with NAME/MODIFIED/SIZE, footer counts).
  Known #1 confirmed again: "Sign in with Google" button visible while signed in.
  File name (not raw ID) shown in the grid header — issue #9 NOT reproduced in this tree.
- Settings: PASS (email field readOnly AND disabled; theme radios; display name; delete
  profile section). Email value blank under dev-login (no email on the dev principal);
  the Google-sign-in case is issue #4, in the fix batch.
- Upload .xlsx via UI: PASS (no HTTP errors; row appears "just now, 5.5 KB").
- Grid open: values/formula PASS; number-format display FAIL (= F-5).
- Editing: type+commit PASS, formula-bar edit PASS, recalc PASS, undo PASS, redo PASS,
  Delete PASS. Copy/paste range: unresolved in 1d (suspected headless clipboard
  permission) — focused retry follows.
- Status bar: "Ready", Saved, Calc automatic, user chip — all sane in the healthy state.
- Copy/paste: PASS with clipboard permissions granted (clipboard TSV 'Apples\t10/Oranges\t20'); the 1d miss was headless permission, not the app.

## Phase 2 verdicts — File tab + Home tab
- File tab: renders fully (shots/10-ribbon-file.png). Groups: Workbook (New, Workbooks...),
  File (Open file, Open data source..., Open from URL..., Save .xlsx + Format select, Save
  encrypted, Download as PDF, Email), Preferences (Settings..., Shortcuts...). NOTE: there is
  no Save/Save As/Print/Info/Close button — consistent with the product's server-side
  AutoSave design (status bar shows "Saved") and header Share; recorded as design, not a
  defect. Download opens a complete dialog (Whole workbook / Named range with a plain-
  language explanation; shots/11-file-Download.png): PASS.
- Home tab: full inventory renders (Clipboard/Font/Alignment/Number/Styles/Cells/Editing).
  Bold applies (computed font-weight 700) PASS; Italic applies PASS; Center align PASS
  (text-align=center); Accounting menu opens with currency choices ($ US Dollar, £ British
  Pound — a short list vs Excel; observation only). B7 percent display still FAIL = F-5.
- Sweep residue note: A10 "Apples" visible in grid shots is my own copy/paste residue that
  autosave persisted (also proves autosave persistence works); harmless to later checks.

## Phase 3 verdicts — Insert / Draw / Page Layout / Formulas
- Insert: PivotTable dialog renders completely and reads the data's headers (Item/Amount
  with R/C/V/F assignment + drop zones) PASS. Insert Chart menu opens but lists only
  Column and Line families at top level (observation, LOW). Text Box inserts a real
  floating text box object (visible in shots/27x-fx-NameManager.png). Links/Text/Symbols/
  Reports groups all render (Link, Text Box, Header & Footer, WordArt, Equation, Symbol,
  New Report, My Reports).
- Draw: Pen/Highlighter/Eraser/Ruler/Lasso all clickable; Convert + Canvas groups render.
  (No Pencil tool; Excel has one — parity observation only.)
- Page Layout: Margins menu renders (Normal/Wide/Narrow/Custom Margins...); Orientation/
  Size/Print Area/Themes present per inventory.
- Formulas: Insert Function dialog is real and deep — 572 functions, search, category
  filter (shots/27-fx-Financial.png). AutoSum menu renders (Sum/Average/Count Numbers/
  Max/Min/More Functions...). Name Manager dialog renders completely with add-name form.
  B4 stayed 30 throughout.
- Number formats APPLIED from the ribbon render correctly: Percent Style -> "25.00%"
  (Excel's % style shows 0 decimals, "25%" — minor parity note), Accounting -> "$ 10.00".
  CONTRAST with F-5: app-applied formats display; file-loaded formats do not. This narrows
  F-5 to the load path (stored numFmt dropped/ignored at load, not a rendering gap).
- OPEN QUESTION carried to phase 4: two Ctrl+Z after the format applications did NOT
  revert them (B2 stayed "$ 10.00", B7 stayed "25.00%", formats autosaved). Either format
  ops are not undoable or the keystrokes missed the grid; a focused test follows.

## Phase 4 (partial) verdicts — Data / Review / View / Extensions / Help / Agent
- Data: Sort buttons act immediately (no dialog): rows reordered by the chosen column —
  including the Total row, whose SUM(B2:B3) then re-pointed at the moved rows (10.25).
  Filter opens a real "Filter column B" dialog. Inventories for Data Tools / Review /
  View / Extensions / Help all render completely (see results.json). NOTE: my sort
  scrambled the fixture layout; the save/download leg therefore runs on a pristine
  re-upload after a stack restart (single-engine ownership, see F-4 note).
- Undo-after-format question: the prelude read B6 as EMPTY right after Ctrl+Z, but the
  later screenshot (shots/40-agent-panel.png) shows B6 alive as "4,631,700..."% — the
  empty read was a transient render state, NOT data loss. A clean single-session retest
  is scheduled in the finale; the alarming interpretation is withdrawn unless it confirms.
- Help > About opens a right-side panel that OVERLAYS the grid and the header's right
  edge (Online pill and Share get clipped under it, shots/40-agent-panel.png). The agent
  panel content exists in the DOM with Chat/Apps/Audit tabs and a greeting; a clean
  agent screenshot is taken in the finale (this phase's shot was polluted by the Help
  panel). Known bugs #2/#3 remain "recorded, not diagnosed" per tasking.

## FINDING F-6 — Protect Sheet dialog form layout is broken (LOW)
shots/36-protect-sheet.png: the "Protect \"Data\"" dialog renders, but the password form
is misaligned — "Password (optional)" + input on one line, then the word "Confirm" stranded
at the right end of that line while "password" + its input wrap onto the next line
("Confirm password" split mid-phrase). Fields are usable; the layout is visibly wrong.
Severity: LOW (cosmetic).

## Phase 4b verdicts — Data Tools / Review / View (screenshot-verified)
- Data Validation dialog renders ("Validate B2 — dropdown list", values field, Save/
  Cancel). NOTE: only the dropdown-list validation type is offered (the control's own
  title says so) — Excel's other validation types (whole number, date, length, custom)
  have no equivalent here. Parity observation, LOW.
- New Comment dialog renders ("Comment — A2", textarea, Save/Cancel): PASS.
- Protect Sheet dialog renders (F-6 layout note aside): PASS. Review ribbon also has
  Notes, Allow Edit Ranges, Revision History, Sensitivity label select ("public").
- Accessibility Checker opens a right pane: "No accessibility issues found. Good job!": PASS.
- View: Freeze Panes menu renders (Freeze at Selection / Freeze Top Row); Show toggles
  (Gridlines/Formula Bar/Headings) show active state; Zoom group complete (Zoom..., 100%,
  Zoom to Selection). Data ribbon is rich and real (Custom Sort, Advanced filter, Flash
  Fill, Relationships...). Data sort/filter verified in phase 4.

## FINDING F-7 — undoing a ribbon number-format change leaves the cell PAINTED BLANK (HIGH)
Adjudicated with a dedicated test (phase 5c, single session, B2=10):
Percent Style applied -> grid "1,000.00%", formula bar "10". ONE Ctrl+Z -> for 15 seconds
(10 polls, 1.5s apart) the grid cell reads EMPTY while the formula bar reads "10" the
whole time (shots/44-undo-final-state.png). The value is intact in the engine; the painted
cell text is cleared by the undo delta and never repainted until some later state change
forces one (a redo + navigation restored it in the finale run). Same signature in phase 5b
(B3: 12 polls x 0.5s, all empty). A user who undoes a format change sees their number
VANISH and has no reason to believe it still exists. Undo of a VALUE edit works correctly
(phase 1d), and value-undo/redo are fine — this is specific to format-op undo deltas, and
it is the same display-integrity family as D6 (issue #6). Severity: HIGH.

## FINDING F-8 — name box is display-only; typed-ref navigation does not exist (MEDIUM-LOW)
The name box shows the current ref (verified visually: A1/B3/B4 across shots) but is not an
input: DOM probe finds no ref-valued input at its position (only .formula-input), and
clicking it + typing "C7" + Enter never moves the selection (finale + phase 5b probe).
Excel/Sheets users navigate by typing a ref in the name box; here nothing happens.
Severity: MEDIUM-LOW (parity gap, no data risk).

## FINDING F-9 — Freeze Top Row pins the row but renders it height-clipped (LOW)
View > Freeze Panes > Freeze Top Row works functionally: after scrolling to row 28+,
row 1 ("Item / Amount") stays pinned at the top under a freeze divider
(shots/38b-freeze-scrolled.png). But the pinned row renders in a squashed, partial-height
band (text vertically clipped) and the row-number gutter labels that slot with the
scrolled row number. Severity: LOW (cosmetic; the freeze itself works).

## Finale verdicts
- Save + Download: PASS, fully verified. Fresh open (B4=30) -> type SavedMark in A12 ->
  File > Save .xlsx -> Download dialog -> Download -> downloaded.xlsx parses back with
  B2=10, B3=20, B4={value 30, formula "SUM(B2:B3)"}, A12="SavedMark". The full round trip
  (load, edit, autosave, force-save, signed download, parse-back) is intact.
- Agent panel (current local tree, recorded per tasking — known #2/#3/#5 not diagnosed):
  the panel opens on the right with Chat/Apps/Audit tabs, the greeting renders, and a
  composer IS present locally (input "Ask, e.g. \"sum of A1:A10\" or \"analyze A1…" +
  Send button). The grid viewport narrows to make room (columns beyond M leave view;
  shots/40-agent-panel.png). The hosted state the user reported is the fix batch's scope.
- Themes: PASS both ways. Light is clean throughout; Dark (Settings > Theme > Dark,
  "Currently showing: Dark") renders the whole app — Workspace, grid, ribbon, dialogs
  (shots/42-download-dialog.png is dark), status bar — with no unreadable surface.
  F-5 reproduces identically in dark (B6 "46317", B7 "0.25").
- Freeze: works (F-9 cosmetic note). Name box: F-8.

## Console / network noise (whole sweep, for the record)
549 HTTP>=400 responses logged, dominated by known/environment items: session-save-status
401 x133 (the F-3 storm + post-incident polling), session-extras 401 x56 (by design in
signed mode), /api/addons/* 502 x147 (the addons service is not part of this
gateway+engine topology — environment), /api/settings 404 x70 (recurs at every boot in
this topology; the Settings page still renders and theme/display-name work — flagged
here as an observation for the parent to route: either the gateway-only topology lacks
the settings route, or the client calls a wrong path; the hosted topology has the
service, so this may be env-only).

## Interference note
Mid-finale, a second worker (the parent's finale agent) shared this stack and replaced
the workspace file (catalog ended with its "finale-simple.xlsx"; the engine's single-file
ownership then 409-blocked my legs, see F-4). The save/download leg was re-run on a wiped
stack in a single session and passed cleanly. All other verdicts rest on screenshots of
the same simple workbook content and are unaffected.

## PER-AREA VERDICT TABLE
| Area | Verdict |
|---|---|
| Workspace (header, list, +New, Upload, gear) | PASS — known #1 (Sign in button while signed in) reproduced |
| Settings page | PASS — email readOnly+disabled; theme + display name work |
| Upload .xlsx + open | PASS |
| Upload/open legacy .xls | FAIL — F-2 (no entry path at any layer) |
| Grid values + formulas | PASS (SUM=30, formula bar, sheet name) |
| Grid number formats from file | FAIL — F-5 (date/percent raw) |
| Editing (type/commit/formula bar/undo-value/redo/Delete/copy-paste) | PASS |
| Undo of format change | FAIL — F-7 (cell paints blank, value intact) |
| Name box navigation | FAIL — F-8 (display-only) |
| File tab | PASS (no Save/Print buttons by design; Download dialog complete) |
| Home tab | PASS (bold/italic/align/%/accounting/borders/menus all render+apply) |
| Insert tab | PASS (PivotTable + Insert Function-grade dialogs; chart menu lists Column/Line only — observation) |
| Draw tab | PASS (no Pencil — observation) |
| Page Layout tab | PASS |
| Formulas tab | PASS (572-function dialog, Name Manager complete) |
| Data tab | PASS (sort reorders, filter dialog, validation dialog list-only — observation) |
| Review tab | PASS (comment + protect dialogs render; F-6 cosmetic layout) |
| View tab | PASS (freeze works; F-9 cosmetic clip) |
| Extensions tab | PASS (inventory renders; addons backend env-absent) |
| Help tab | PASS (About/help panel renders) |
| Agent panel | RECORDED (composer present locally; panel takes right-side space) — known #2/#3/#5 |
| Save + Download round trip | PASS (parse-back exact, formula preserved) |
| Dark theme pass | PASS |

## FINDINGS SUMMARY
- F-1 (BLOCKER, resolved same day): App.tsx TDZ build break — fixed by the hosted-UX
  batch mid-sweep; tsc clean + build:local-stack + verify-dist re-verified by me.
- F-2 (HIGH): legacy .xls has no entry path in web/gateway mode (Workspace UI, gateway
  upload-grant, and engine /load all refuse it; the client hardcodes 'xlsx' on load).
- F-3 (HIGH): a failed local-file open poisons the live session (persistent /execute and
  session-save-status 401s; the still-open workbook stops accepting edits). #1/#10 family.
- F-4 (MEDIUM-HIGH): a failed session join renders a phantom editable grid; the only
  signal is status-bar text leaking raw file UUIDs + gateway JSON.
- F-5 (HIGH): stored number formats dropped at load — a date shows "46317", a percent
  shows "0.25"; ribbon-applied formats render fine, so the gap is the load path.
- F-6 (LOW): Protect Sheet dialog password-form layout broken (label split mid-phrase).
- F-7 (HIGH): undoing a ribbon number-format change paints the cell blank indefinitely
  (formula bar proves the value survives) — D6-family display-integrity defect.
- F-8 (MEDIUM-LOW): name box is display-only; typed-ref navigation missing.
- F-9 (LOW): frozen top row renders height-clipped while scrolled.
- Confirmations: known #1 reproduced in every session; known #9 NOT reproduced (grid
  header shows the file name); known #10 not triggered (xlsx upload-grant succeeds;
  the .xls never reaches the grant — F-2 fires first).

## SWEEP COMPLETE — 98 screenshots in shots/, machine-readable record in results.json
(178 deduped checks; raw PASS/FAIL counts include superseded harness attempts — the
narrative verdicts above are the adjudicated read).
