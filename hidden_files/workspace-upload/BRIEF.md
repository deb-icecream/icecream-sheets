# Workspace Upload — Excel + CSV — Brief (user directive, 2026-10-21 ~21:15 PDT)

Requirement (user's words): in the Icecream Sheets Workspace, the user must be
able to upload Excel files and CSV files, and then open them.

## Verified current state (parent, 2026-10-21, from code)

- `.xlsx` upload + open: BUILT and validated (product-layer transcript 24/24 —
  upload grant → signed-URL PUT → complete-upload → engine load → download
  round trip sha256-exact).
- CSV: NOT BUILT in the Workspace lifecycle. Three xlsx assumptions block it:
  1. `apps/web/src/product/Workspace.tsx` — the upload input is
     `accept=".xlsx"` (line ~232).
  2. `packages/gateway/src/deploy/uploadStore.ts` — `uploadObjectKey()` 
     hardcodes `<fileId>.xlsx`.
  3. The engine load path (`POST /load/storage-ref`) loads xlsx bytes only;
     `UserFileRecord` (gateway `deploy/userStore.ts`) has no format field.
- The CSV machinery EXISTS and must be reused, not reinvented:
  `packages/csv-adapter` (`CsvAdapter`, `parseCsv`, `detectDelimiter`) is
  already used by the gateway engine service, the service connectors, and the
  web adapters.

## Semantics decision (parent, per the user's document-then-build directive)

CSV converts to a native workbook at open — the Google Sheets import model.
The uploaded CSV bytes are stored as-is; on first open the server converts
CSV → workbook via the csv-adapter and the session runs as a normal workbook
(formulas, edits, co-authoring, autosave all work). From the first save on,
the stored state is the workbook (xlsx), exactly like every other file. The
file record keeps the user's original filename (e.g. `sales.csv`); add a
`sourceFormat` field so the UI can show it was imported from CSV. Download
returns the workbook (xlsx) — do NOT silently flatten to CSV. If the user
wants CSV round-trip later, that is a separate export feature (CSV export
already exists in the grid's export paths).

Type inference and parsing MUST match the existing csv-adapter / CSV
connector behavior exactly (numbers, dates, booleans as the adapter already
infers; quoted fields, escaped quotes, CRLF, UTF-8 BOM, delimiter detection).
Sheet name = filename base, sanitized to Excel rules (≤31 chars, no invalid
characters). One CSV = one sheet.

## Build scope

1. Workspace UI: accept `.xlsx` and `.csv` (input `accept`, plus any
   drag-drop path if present); upload errors for unsupported types name the
   supported formats.
2. Gateway: object key + file record carry the real format (`sourceFormat:
   'xlsx' | 'csv'`); upload grant/complete validate the extension against the
   allowlist server-side (never trust the client); tier rules unchanged —
   the Default-tier per-file byte cap and the 10-file cap apply to CSV bytes
   exactly as to xlsx bytes.
3. Engine/service load: a csv-sourced file opens by converting through the
   csv-adapter into the authoritative model on the server (never client-only),
   so signed/gateway mode, sessions, and the revision journal all see a real
   workbook from revision 0.
4. Tests at each layer (gateway upload/record, service/engine conversion,
   web product) — related tests only during build.

## Validation bar (all required; no evidence = NOT RUN)

Browser tour on a local production-topology stack, Workspace component
exercised the same way the product-layer validation exercised it:
- Upload `hidden_files/shared-fixtures/sales.csv` (24 rows) through the
  Workspace UI → appears in the file list and recents with correct size.
- Open it (deep-link/engine path) → grid shows the data with correct types;
  screenshot self-inspected.
- Add `=SUM(...)` over the revenue column → **4027.86** (the fixture's
  independently verified ground truth).
- Save → download → independent parse-back: the downloaded xlsx contains the
  converted data + the SUM formula/result.
- Parser fidelity case: a CSV with quoted commas, escaped quotes, CRLF line
  endings, and a UTF-8 BOM opens with identical cell values to the
  csv-adapter's own parse (diff, not eyeballing).
- Regression: the xlsx upload tour still passes unchanged; Default-tier cap
  rejects an oversized CSV with the same clear message as xlsx.
- Suites: gateway, service, web product suites green.

## Out of scope

App.tsx/main.tsx routing and the Workspace→grid in-app click-through wiring
(shell integration — separate program, unparks when residual (p) lands; this
brief validates the open through the existing deep-link/engine path, the same
path shell integration will call). `.xls` (no adapter exists). CSV export
changes. progress.md edits (parent reconciles). Git pushes (parent pushes).

## Deliverable

`hidden_files/workspace-upload/REPORT.md`: what was built per layer, the
validation evidence (tour steps, screenshots, parse-back diffs, suite
counts), and anything not done, named plainly.
