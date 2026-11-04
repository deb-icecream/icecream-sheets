# Cycle 10 Closure — W2: gateway save paths + add-ons catalog (Part B items 1 + 6)

Date: 2026-10-20 · Worker: W2 · Repo: ~/workspace/icecream-sheets
perf-evaluation.md / progress.md NOT edited (coordinator's files). No GitHub push.

## 1. Defect 2c verdict — the FIX text is true; the §7 table cell is stale

Established from current source (line numbers = current working tree):

- **Engine endpoint exists**: `packages/gateway/src/services/engineSvc.ts` —
  the `/download` handler (`if (path === '/download' …)`, line 1324 after this
  pass; line 948 before it) serializes the LIVE workbook server-side:
  permission-filtered snapshot (`filteredSnapshot`, line 666) →
  `snapshotToWorkbookData` (line 235) → adapter `write`, streamed back in
  256 KB chunks with content-disposition. Before this pass it was xlsx-only
  (`extras.format !== 'xlsx'` → 400).
- **Gateway proxy route + timeout exists**: `packages/gateway/src/gateway.ts`
  line 286 `isEngineDownload = path === '/api/engine/download'` → 32 MB body
  cap (line ~295) and the 600 s `LOAD_UPSTREAM_TIMEOUT_MS` (line ~318).
- **Web client uses it**: `apps/web/src/App.tsx` `fetchServerWorkbookBlob`
  (line 5813) → `gateway.engineDownloadXlsx({ filename: 'workbook.xlsx',
  ...buildServerSaveExtras() })` (line 5821); used by the plain download
  dialog path and by the password-encrypted download (line 6143 area,
  `handleFilePasswordSubmit`). Zero /snapshot requests during those saves.

**Verdict: 2c is FIXED in source. The §7 metrics table cell "defect 2c, OPEN"
is the stale text; the defect-2 body text ("FIXED (server-side streaming
download)") is the accurate one.** (Coordinator: the table cell is yours to fix.)

Re-proven at runtime this pass (see §3): P95 xlsx through the new handler =
77,656,582 bytes, parse-back exact.

## 2. What landed

### Engine service (`packages/gateway/src/services/engineSvc.ts`)
- `/download` generalized (handler line 1324; shared builder
  `buildSaveWorkbookData`, line 698):
  - `format`: **xlsx | xlsb | csv | tsv | ods | html** via `SERVER_SAVE_FORMATS`
    (line 270) — the same adapters the in-tab save used (XlsxAdapter,
    XlsbAdapter, CsvAdapter/TsvAdapter, OdsAdapter, engine HtmlAdapter).
    Unsupported format → 400. Filename/content-type follow the format
    (`downloadFilenameForFormat`).
  - `scope: 'namedRange'` + `namedRange: { name, ref }`: server-side subset
    via `namedRangeToWorkbookData` (line 375), a faithful port of
    `apps/web/src/io.ts`'s function (single sheet named after the name,
    rebased to A1, rebased defined name carried, no workbook extras).
    Dangling (ref null) → 400, mirroring the client. The snapshot is
    permission-filtered for the requesting principal again server-side, so
    hidden cells are dropped even in the subset.
  - Whole-workbook path unchanged in semantics: source metadata → live
    protection metadata → client session extras; defined names; per-sheet
    dims (source overlaid with client dims).
- **Library store (new)**: `POST /library-save` (line 1378) serializes the
  live workbook to xlsx through the same whole-workbook builder and stores
  the bytes server-side per principal under
  `gatewayDataDir()/library` (one hashed file per entry + index.json;
  `EngineServiceDeps.libraryDir` overrides for tests). Response = entry
  metadata only — **no workbook bytes round-trip the tab**.
  `GET /library` (line 1437) lists the principal's entries;
  `GET /library/:id` streams the stored bytes back (library open);
  cross-principal fetch → 404 (tested).
- Gateway deps added: `@icecream-sheets/csv-adapter`, `ods-adapter`,
  `xlsb-adapter` in `packages/gateway/package.json`.

### Gateway (`packages/gateway/src/gateway.ts`, `src/bin/gateway.ts`)
- Proxy: `/api/engine/library-save` gets the download-class treatment
  (32 MB extras cap + 600 s timeout); `/api/engine/library*` gets the 600 s
  timeout (long streamed responses).
- **Item 6 root cause found**: the add-on service and its gateway route
  already existed in `startAllLocal` (`packages/gateway/src/index.ts:131`)
  and the service runs on :8107 (`src/bin/addons.ts`,
  `src/services/addonSvc.ts` `/catalog`), but the **standalone gateway
  runner's route table omitted `/api/addons`** — hence "gateway 404: no
  backend route for /api/addons/catalog" in every gateway-mode screenshot.
  Fixed: `packages/gateway/src/bin/gateway.ts:41`
  `'/api/addons': process.env.ADDONS_URL ?? 'http://127.0.0.1:8107'`.
  All sibling client calls (catalog, installed, install, enable, disable,
  uninstall, grants*, run — `gatewayClient.ts`) ride the same prefix.
  Note: `hidden_files/start-stack-finisher.sh` still does not START the
  addons bin; I started it manually on the shared stack (:8107) for this
  validation. The finisher script should gain an addons line (coordinator).

### Web (`apps/web`)
- `services/gatewayClient.ts`: generalized `engineDownload(...)` (line 216;
  format/scope/namedRange), `engineDownloadXlsx` kept as wrapper;
  `engineLibrarySave` (line 263), `engineLibraryBytes` (line 285).
- `App.tsx`:
  - `fetchServerExportBlob` (line 5835) + `saveWorkbookToServerLibrary`
    (line 5874) helpers (gateway-only, loaded-gated, download-gated;
    local/desktop fall back to the previous paths untouched).
  - Download dialog: whole-workbook in **any** format now goes server-side
    (line 6201); named-range scope resolves via the client name store's
    `resolveForSubject` (unchanged fail-closed checks) then builds the
    subset **server-side** from the resolved def (line 6238).
  - Email (`handleSendEmail`, line ~5976): attachment bytes are fetched
    from the server serialization (xlsx for workbook mode; csv for sheet
    mode — the CsvAdapter's first-sheet semantics, identical to the old
    `buildDownloadBytes('csv')`) instead of a snapshot build; the mail
    connector still runs client-side with the user's credential, so only
    the finished attachment bytes cross into the tab.
  - Library save (`handleLibrarySave`) and library autosave now call
    `saveWorkbookToServerLibrary`; the local `WorkbookLibrary` mirrors
    only metadata via new `upsertRemote` (`apps/web/src/library.ts`,
    backend `'gateway'`, no local bytes). Library open of a gateway entry
    fetches the stored bytes from the engine service and opens through
    `openRemoteBuffer`.
- Web dist rebuilt in gateway flavor:
  `VITE_GATEWAY_URL=http://127.0.0.1:8100 npx vite build` (apps/web/dist).

### Per-flow before/after
| Flow | Before (gateway mode) | After |
|---|---|---|
| Named-range download | full snapshot pull → client subset build | resolved def → server subset from filtered snapshot; no snapshot pull |
| Non-xlsx exports (csv/tsv/ods/xlsb/html) | full snapshot pull → client adapter | server adapter over filtered snapshot; bytes streamed back |
| Email attachment | snapshot pull → client build → attach | server serialization fetched as blob → attach (connector unchanged) |
| Library save / autosave | snapshot pull → client xlsx bytes → IndexedDB | server serializes + stores; tab gets entry metadata only |
| Add-ons catalog | gateway 404 (no route in bin/gateway.ts) | 200 via /api/addons → addons service :8107 |

Local-mode and desktop save paths are untouched (all new helpers return
null outside non-desktop gateway mode and callers fall through).

## 3. API validation (login = local-dev test user `e2e-user` via /auth/login)

Method note: the shared stack (:8100/:8101) is raced by sibling workers
(their browser validation replaces the shared engine's workbook and their
P95 work OOMs this 7.9 GB VM — the engine died with exit 137 three times
mid-download with free RAM measured at 117–700 MB during sibling P95 work).
Final validation therefore ran on an **isolated instance of the same
topology** (gateway :8200, engine :8201, addons :8207, same dist builds),
plus direct-engine and shared-stack checks noted per item.

- **Add-ons (shared stack, :8100)**: `GET /api/addons/catalog` → **200**,
  2 listings (first `com.icecream.sample-sum-reporter`); `/installed` → 200.
  Gateway health now lists `/api/addons` among routes. (Before the fix this
  was the 404 in every screenshot.)
- **P95 load via gateway (isolated)**: `/api/engine/load/stream` → built in
  33.7–48.0 s across runs, sheets [Sales, Inventory, Ledger].
- **P95 full xlsx (new handler, direct engine — gateway is a proven
  transparent pipe, see P75 run)**: 200, **77,656,582 bytes**,
  1,800,036 cells (engine log). Parse-back with the repo XlsxAdapter:
  **1,320,031 value + 480,005 formula cells, 3 sheets — exact parity**
  with the source fixture (source parsed independently: 1,320,031 +
  480,005). Engine healthy after.
- **P75 full gateway flow (isolated, every path)**: load/stream built
  1.34 s; all downloads 200 — xlsx 95,314 B; named-range xlsx 16,083 B;
  named-range csv 90 B; csv 5,204 B; tsv 5,204 B; ods 23,484 B; html
  167,121 B; library-save 200 (entry 95,314 B) → list 200 → fetch 200
  (95,314 B). Parse-backs with repo adapters:
  - source P75: 2,191 value + 766 formula, 13 sheets.
  - full.xlsx: **2,191 + 766, 13 sheets — exact**.
  - library.xlsx: **2,191 + 766 — exact** (bytes identical size to download).
  - full.ods (OdsAdapter): **2,191 + 766, 13 sheets — exact**.
  - named-range.xlsx (Constants A1:F2): single sheet `FirstBlock`,
    rows [[“Model Constants”], [HYPERLINK formula]] (1 value + 1 formula —
    the only non-empty cells in that range), defined name carried rebased
    `FirstBlock!$A$1:$F$2`.
  - full.csv: 135 lines (= first sheet FMTs row count in ODS parse), first
    line `Formats,,,,,,,,,,,`; named-range.csv: the same 2 rows, quoted
    formula — matching the adapters' in-tab output semantics.
  - full.html: real HTML document (`<!DOCTYPE html>…`).
  - **xlsb: 500 with the XlsbAdapter's own error** — “cross-sheet
    references are not supported in .xlsb formulas”. This is pre-existing
    adapter behavior (the in-tab `adapterForSaveFormat('xlsb')` throws the
    same on this workbook); the server surfaces it as a clean 500 instead
    of a snapshot crash. Not a regression; fixing the adapter's cross-sheet
    support is out of this item's scope.
- **Email flow**: the App now fetches exactly the two server serializations
  validated above (workbook=xlsx 200, sheet=csv 200). Actually sending mail
  needs a user OAuth token and was not exercised (unchanged connector).
- **P95 through the gateway for the remaining formats**: attempted three
  times; the engine was OOM-killed (exit 137) during the first (xlsx)
  serialization each time while sibling workers ran concurrent P95-scale
  browser/engine work on this 7.9 GB VM (free RAM 117 MB–3.5 GB during
  attempts; the same documented host-RAM constraint as perf §7 defect 5).
  On a quieter machine the finisher already proved the gateway xlsx path
  at P95 (108.9 s); this pass proves the generalized handler at P95
  (engine level, exact parity) and every flow end-to-end through the
  gateway at P75. **Residual: re-run the P95 gateway sequence on a quiet
  host to close this last validation gap.**

## 4. Tests

- Gateway package: **126/126 green** (`npx vitest run` in packages/gateway),
  including new tests:
  - engineSvc: non-xlsx downloads (csv/tsv/ods/html parse-backs),
    named-range subset + rebased defined name + dangling 400,
    named-range permission filtering, library-save/list/fetch with
    per-principal isolation. (The old “csv → 400” assertion was updated to
    an unsupported format, `pdf`, since csv is now supported.)
  - gateway: `/api/addons/*` proxies with auth + x-principal (401 anon),
    mirroring the bin route table.
- Web: targeted suites 40/40 (library incl. new `upsertRemote` test,
  remoteEngine, adapters, io, email). Full web suite on a clean re-run:
  **118/118 files, 1539/1539 tests green** (an earlier run taken amid
  concurrent sibling edits showed 18 failures in 2 files; the clean
  re-run is all green). `tsc --noEmit` clean for web and gateway.
- packages/service was not modified; its suites were not re-run.
- Dists rebuilt: packages/gateway (tsc), apps/web (vite, gateway flavor
  above). Shared stack restarted on the new builds (engine :8101,
  gateway :8100 now listing `/api/addons`, addons :8107 started).
