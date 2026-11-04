# Workspace Upload — Excel + CSV — Report

Coordinator report for `hidden_files/workspace-upload/BRIEF.md` (user directive
2026-10-21 ~21:15 PDT). **Verdict: BUILT and VALIDATED end to end.** A user can
now upload `.xlsx` and `.csv` files in the Icecream Sheets Workspace and open
them; a CSV converts to a native workbook on the server at first open (Google
Sheets import model) via the existing `packages/csv-adapter` — no new parser,
no new type inference anywhere.

Process note: the build survived three daemon restarts that killed five
worker runs. Every slice's final state was verified on disk by the coordinator
(greps + test runs), not taken from worker claims.

## What was built, per layer

### Gateway — catalog + upload path (`packages/gateway`)
- `src/deploy/userStore.ts`: `UserFileRecord` gains
  `sourceFormat: 'xlsx' | 'csv'` (exported as `SourceFormat`). Catalog `create`
  accepts it optionally, default `'xlsx'`; `UserFilePatch` deliberately does
  NOT include it (a rename can never change a file's format). New exported
  helper `sourceFormatForFileName(name)` — case-insensitive extension check,
  `.xlsx`→`'xlsx'`, `.csv`→`'csv'`, anything else→`null`. All three store
  adapters (memory, local, Firestore) normalize a missing/invalid persisted
  field to `'xlsx'` on read, so pre-existing records keep loading.
- `src/deploy/uploadStore.ts`: `uploadObjectKey(owner, fileId, format =
  'xlsx')` → `uploads/<sha256(owner)[0:16]>/<fileId>.<format>`. The 2-arg form
  is byte-identical to before (`.xlsx`).
- `src/gateway.ts`: `POST /api/files/upload-grant` derives the format from the
  requested name server-side BEFORE the cap checks; unsupported → **400
  `unsupported file type: only .xlsx and .csv files can be uploaded`**. Object
  key built with the derived format. `POST /api/files/:fileId/complete-upload`
  derives/validates the same way, stats the correctly-suffixed object, and
  creates the record with `sourceFormat` set. Tier rules untouched — the
  Default per-file byte cap (1,285,214 B) and 10-file cap operate on size/count
  only and therefore apply to CSV bytes exactly as to xlsx (proven below).

### Engine service — CSV → workbook at open (`packages/gateway/src/services/engineSvc.ts`)
- `loadBytesIntoSession` (the shared tail of `/load` and `/load/storage-ref`)
  accepts `format?: 'xlsx' | 'csv'` + `sourceName?: string`. CSV branch:
  `new CsvAdapter().read(bytes)` (the existing adapter — delimiter detection,
  RFC-4180 quoting, BOM stripping, and its `stringToCell` inference of
  numbers/booleans/strings), then the single sheet is renamed from `'Sheet1'`
  via the new exported helper `sheetNameFromCsvFileName` (strip extension,
  Excel-invalid chars `: \ / ? * [ ]` → `_`, trim, 31-char cap, `''` → caller
  keeps `'Sheet1'`). The load response carries `sourceFormat: 'csv'`.
- **Save semantics:** a CSV session sets `state.sourceBytes = null`, so the
  first save serializes the converted model in full to xlsx (directSave treats
  null as a blank base) instead of trying to unzip CSV bytes as a package.
  From the first save on, the stored state is the workbook (xlsx), exactly as
  the brief specifies.
- Routes: `/load/storage-ref` accepts format `'xlsx' | 'csv' | undefined`
  (undefined = xlsx, unchanged) and an optional `name`; `/load` accepts
  `'xlsx' | 'csv'`; any other value → 400 `only formats 'xlsx' and 'csv' are
  supported`. `/load/stream` remains xlsx-only (out of scope).

### Web — Workspace UI (`apps/web/src/product`)
- `Workspace.tsx`: file input `accept=".xlsx,.csv"` (the input is the only
  upload path — there is no drag-drop path in the component). Client guard in
  `handleUpload`: a name not ending `.xlsx`/`.csv` (case-insensitive) never
  reaches the API and sets the alert **"Only .xlsx and .csv files can be
  uploaded."** CSV-import indicator: records with `sourceFormat === 'csv'`
  show **"· Imported from CSV"** in BOTH the Recents cards and the All-files
  table.
- `productApi.ts`: `UserFileRecord` mirror gains `sourceFormat`; rendering
  tolerates its absence as `'xlsx'`. Upload flow (grant → direct PUT →
  complete) is name-driven and unchanged.

## Validation evidence (all under `validation/`)

Local production-topology stack (gateway :19100 + engine :19101, signed
engine access, scratch stores), built from the current dist.

### API tour — `tour.mjs`, transcript `transcript.md`: **44 passed / 0 failed**
- Upload `sales.csv` (1,081 B, 24 rows): grant object ends `.csv`; PUT 200;
  complete 201; record `sourceFormat: 'csv'`, name `sales.csv`,
  `sizeBytes: 1081`, storageRef object ends `.csv`; list shows it first in
  recents with `sourceFormat: 'csv'`.
- Rejections: `notes.txt` grant → 400 naming `.xlsx` and `.csv`; oversized
  `big.csv` (1,285,215 B) on Default tier → **413 `UPLOAD_TOO_LARGE`,
  limit 1285214** — identical shape to the xlsx cap.
- Open handshake → `POST /load/storage-ref {format:'csv', name:'sales.csv'}`
  → 200, sheets `['sales']`, `sourceFormat: 'csv'` echoed.
- Typed reads: A2 = number 1001; B2 = string `'2026-01-01'` (adapter does not
  infer dates); C2 = `'North'`; G1 = `'revenue'`; G2 = 19.98; G25 = 90.25.
- `=SUM(G2:G25)` via `/execute` → **4027.86** — the fixture's independently
  verified ground truth, exact.
- Save (`/library-save`) → entry created (3,298 B xlsx); record PATCHed with
  the library entry; download-grant → GET → bytes start `PK`.
- Session released via `/session/release` (one live session per engine —
  switching files requires release, by design) and the cycle repeated for the
  fidelity file and the xlsx regression.

### Parse-back — `parse-back.py` on the downloaded xlsx: **ALL PASS**
Independent openpyxl read of `validation/downloaded.xlsx`: exactly one sheet
named `sales`; **all 175 fixture cells match** with adapter-equivalent
inference; G26 holds the formula `=SUM(G2:G25)` with cached value 4027.86.

### Parser fidelity — `fidelity-compare.mjs`: **ALL PASS (16/16 cells)**
`validation/tricky.csv` (UTF-8 BOM, CRLF, quoted commas, escaped quotes, an
embedded CRLF inside a quoted field, leading/trailing spaces, empty trailing
field, TRUE/FALSE/decimal fodder) opened through the same upload→open path;
the engine's cell values are **identical to the csv-adapter's own parse**,
cell for cell (diff, not eyeballing).

### Regression — xlsx tour inside the same API tour: **PASS**
`real.xlsx` upload → record `sourceFormat: 'xlsx'`, object ends `.xlsx`;
open → `/load/storage-ref` with format omitted → sheets `['Data']`; B1
(`=A1+1`) reads **42**. The pre-existing product-layer xlsx behavior is
unchanged.

### Browser UI tour — `ui-tour.mjs`, transcript `ui-transcript.md`: **7 passed / 0 failed**
Real Chrome (headless shell) against the standalone Workspace preview build,
seeded Default user, gateway on the same stack:
- Upload `sales.csv` via the real file input → appears in Recents and the
  table with size **1.1 KB** (1,081 B via the app's `formatBytes`) and the
  **"Imported from CSV"** marker in both — screenshot `shots/ui-2-csv-uploaded.png`
  (self-inspected).
- Upload `notes.txt` → alert **"Only .xlsx and .csv files can be uploaded."**,
  no file created — `shots/ui-3-txt-rejected.png` (self-inspected).
- Upload `real.xlsx` → listed first in Recents (MRU order), **no** CSV marker
  on its row in either list — `shots/ui-4-xlsx-uploaded.png` (self-inspected).

### Grid visual — `shots/grid-converted-sales.png` (self-inspected)
The converted, saved workbook (`downloaded.xlsx`) opened in the real web app:
sheet tab **sales**, all 24 rows rendered with correct values, and the SUM
result **4027.86** visible at G26; status bar "✓ Saved / Ready".

### Suites
- Gateway product files: `productLayer.test.ts` **37/37**, `productLoadRef.test.ts`
  **16/16** (53/53 together) — includes the new CSV battery: storage-ref
  conversion + sheet naming + `sourceFormat` echo, typed reads, SUM over
  converted data, save-after-CSV (no `source package unreadable`, PK bytes),
  `/load` base64 CSV, `ods` → 400 on both endpoints, `sheetNameFromCsvFileName`
  unit tests, legacy-record normalization, CSV grant/complete/cap tests.
- Full gateway suite: 315/320 in a contended run; **all 5 failures**
  (agentArtifacts ×2, agentThreadPersistence ×2, agentBinding ×1 — 30–72 s
  durations, agent track's files, untouched by this change) **re-ran solo:
  25/25 passed**. Effective: 320/320.
- Web product suite: **61/61** (Workspace 19, productApi 13, gallery 8,
  landing 6, deepLink 11, sharesApi 4).
- Service suite (package untouched by this feature): 1515 passed / 2 failed /
  1 skipped in the contended run; both failures (`secureStore.test.ts`
  EncryptedPersistence, 17–26 s durations) **re-ran solo: 33/33 passed**.
- TypeScript: gateway `tsc` clean; web `tsc --noEmit` clean (exit 0).

## Named deviations / notes
1. **Complete-upload ordering:** format derivation/400 runs before the
   idempotent existing-record return. A complete-upload *retry* carrying an
   unsupported name would 400 instead of returning the existing record. The
   real client always sends the same valid name, so this is theoretical;
   recorded here rather than silently accepted.
2. **Download before first open:** download-grant on a never-opened CSV file
   serves the user's original uploaded CSV bytes (their own file, unchanged).
   After the first open + save — the path validated above — download returns
   the converted workbook (xlsx). No silent flattening occurs anywhere: the
   workbook is never re-serialized as CSV.
3. **One engine = one live session** (existing design): opening a second
   workspace file while a session is live returns 409 until the client
   releases (`/session/release {sessionId}` checkpoints + evicts). The tour
   exercises this explicitly; in production each session is routed to its own
   engine instance.
4. **Harness files:** `validation/` holds the tours, checkers, transcripts,
   raw responses, screenshots, `downloaded.xlsx`, `tricky.csv`, and a kept
   `preview-dist/` (same pattern as the product-layer validation). The
   throwaway preview entry files temporarily added under `apps/web/src/product`
   were deleted after the build; the tree contains no harness residue.
5. **Out of scope, untouched** (per brief): App.tsx/main.tsx routing and the
   Workspace→grid in-app click-through (shell integration), `.xls`, CSV
   export changes, progress.md, git pushes (the parent pushes).

## Files changed
- `packages/gateway/src/deploy/userStore.ts`
- `packages/gateway/src/deploy/uploadStore.ts`
- `packages/gateway/src/gateway.ts`
- `packages/gateway/src/services/engineSvc.ts`
- `packages/gateway/tests/productLayer.test.ts`
- `packages/gateway/tests/productLoadRef.test.ts`
- `apps/web/src/product/Workspace.tsx`
- `apps/web/src/product/productApi.ts`
- `apps/web/src/product/Workspace.test.tsx`
- `apps/web/src/product/productApi.test.ts`
