# Cycle 10 Closure — W11: Defect E1 — Saving Drops All Defined Names (FIXED)

Date: 2026-10-20 · Worker: W11 · Repo: ~/workspace/icecream-sheets
`perf-evaluation.md` / `progress.md` / `TODO.md` untouched. No GitHub push.
Desktop app NOT repackaged (per instructions — packaged revalidation is a
later worker's job). Original fixtures never modified (all work on copies /
in-memory parses of `test-data/perf-fixtures/perf-p50.xlsx`).

## 1. Root cause (three breaks in one chain, all proven by reproduction)

Reproduction before the fix (adapter read of P50 → EngineWorkbook →
snapshot → save composition with the name list the app actually sent →
adapter write → parse-back → reopen):

- adapter read: **38 defined names**; engine evaluates clean
  (MONTHLY C13 = 132942.88335317458, OPERATING MODEL E8 = 1595314.6002380955)
- snapshot keys: `['protocolVersion','sheets']` — **no names**
- saved file: **0 defined names**, **21 formulas still referencing
  `DividendsPctNI`** → reopen C13/E8 = `#NAME?` (engine-level, matching
  W10's R1b-2 evidence exactly)

The three breaks:

1. **The engine snapshot carried no defined names.**
   `EngineWorkbook.toSnapshot()` (`packages/engine/src/workbook.ts`)
   returned only `{ protocolVersion, sheets }`; the `WorkbookSnapshot`
   type (`packages/engine/src/types.ts`) had no names field at all.
   Every save path on every host (local, desktop IPC, gateway) composes
   from this snapshot, so names were structurally absent from saves.
   (The engine HAS the names: the XLSX adapter returns them in
   `WorkbookData.definedNames`, the EngineWorkbook constructor registers
   them as HyperFormula named expressions, and `/load` returns them —
   they were only missing from the snapshot/save side.)

2. **The client save composed names from the wrong source — a store
   that is never populated on open.**
   `apps/web/src/App.tsx` `buildDownloadBytes` took the save's defined
   names SOLELY from `nameServices.exportToDefinedNames(sheetNames)` —
   the service-layer `NamedRangeStore` (§3 metadata store). Nothing in
   the app ever imports an opened file's names into that store:
   `importFromDefinedNames` / `bindToEngine` exist in
   `apps/web/src/features/useNameServices.ts` but have **zero call sites**
   in `App.tsx`, and `hydrateOpenedWorkbook` never calls them. For every
   imported file the store export is therefore `[]`, and
   `snapshotToWorkbookData(snap, …, [])` emitted that empty list
   verbatim. Desktop autosave uses the same `buildDownloadBytes`, so it
   corrupted files identically.

3. **The gateway path had the same bug with the opposite fallback.**
   `packages/gateway/src/services/engineSvc.ts` `buildSaveWorkbookData`:
   `Array.isArray(extras.definedNames) ? extras.definedNames :
   state.sourceDefinedNames` — the client's (empty) array always won
   over the server's correct load-time list. The task's claim "the
   gateway /download path re-attaches defined names from server state"
   is therefore **FALSE for the real client flow** (POST with extras):
   it only held for a bare GET with no extras. The gateway's
   `filteredSnapshot` also rebuilt the snapshot as
   `{ protocolVersion, sheets }`, stripping names even after break 1
   was fixed. **In scope and fixed** (see §2).

### The 6 rewritten formulas — NOT a save-side rewrite

W10's diff (6 formulas rewritten to direct refs, e.g. `NewEquityY1` →
`ASSUMPTIONS!$C$62`) happens at **import**, in the XLSX adapter:
`packages/xlsx-adapter/src/adapter.ts` `assembleFromParsedSheets` calls
`rewriteDefinedNames` (`packages/xlsx-adapter/src/names.ts`) for names
HyperFormula cannot bind. HF's named-expression validity heuristic
rejects any name matching `/^[A-Za-z]+[0-9]+$/` — `NewEquityY1` and
`NewBorrowingY1` both match (letters, then a trailing digit). Exactly
their 6 usages are rewritten to direct refs in the parsed `WorkbookData`
rows (verified in the adapter output: BALANCE SHEET `=D37+ASSUMPTIONS!$C$62`,
CASH FLOW `=ASSUMPTIONS!$C$62`, DEBT SCHEDULE `=ASSUMPTIONS!$C$55`,
SCENARIO ANALYSIS ×3) — before the engine or any serializer sees them.
All other names (incl. `DividendsPctNI`, 21 usages) stay as name refs.
This import-side expansion is forced by HyperFormula (the names cannot
be registered as named expressions at all) and is pre-existing designed
behavior; the save side now adds **zero** further rewriting, and the two
unbindable NAMES themselves are preserved verbatim in the saved file's
defined-names table (see §2.1), so the file's name table round-trips
38 → 38 even though those 6 formulas stay direct-ref (stable across
reopen: the adapter rewrites them again to the identical text).

## 2. The fix

Design basis: `design-docs/named-ranges-and-named-functions.md` §3 —
the XLSX adapter mirrors definitions into the file's defined-names table
on save; the engine's live refers-to (structural-edit tracking) is what
persists. The fix makes the ENGINE's live names the primary save source
on every path and demotes the client name store to a secondary
contribution (it is the only home of Name-Manager-defined names, which
the engine may not hold).

### 2.1 Engine (`packages/engine`)

- `src/types.ts:99` — `WorkbookSnapshot.definedNames?` added (optional:
  older snapshot producers stay valid).
- `src/workbook.ts:1847` — new `EngineWorkbook.getLiveDefinedNames()`:
  (a) live names from HyperFormula `getAllNamedExpressionsSerialized()`
  — current refers-to, sheet scope mapped HF sheet-id → 0-based sheet
  index; covers constructor names, runtime `defineNamedRange` /
  named-expression edits, constant names, and LAMBDA named functions
  (§7); the synthetic `TRUE`/`FALSE` boolean-literal expressions the
  constructor registers are excluded (not file defined names);
  (b) merged UNDER (a): construction-time names HF could not bind
  (the unbindable pair above, dangling/invalid entries), preserved
  verbatim from `this.definedNames`. Live entries win key collisions
  (scope + case-insensitive name).
- `src/workbook.ts:2482` — `toSnapshot()` now returns
  `definedNames: this.getLiveDefinedNames()`.
- `src/workbook.ts:2485` — `fromSnapshot()` rebuilt to construct through
  the EngineWorkbook constructor (the `withSheetOrder` pattern): the
  snapshot's names register BEFORE any cell is parsed (formulas
  referencing names previously restored as #NAME? here too) and
  sheet-scoped indices resolve against the snapshot's sheet order.

### 2.2 Web client (`apps/web`)

- `src/io.ts:98` — new `mergeDefinedNames(primary, secondary)`:
  scope + case-insensitive-name keyed, primary wins, secondary adds
  only missing names, malformed entries dropped.
- `src/io.ts:149` — `snapshotToWorkbookData` defaults its defined-names
  argument to `snap.definedNames` when the caller passes none.
- `src/io.ts:170` — `snapshotFiltered` (the permission filter feeding
  every client save) preserves `definedNames`.
- `src/App.tsx:5848` — `buildDownloadBytes` now composes
  `mergeDefinedNames(snap.definedNames, nameServices.exportToDefinedNames(…))`
  (engine primary, store secondary). This one function backs desktop
  Save/Save-As/autosave, web local downloads, encrypted download, and
  email in local/desktop mode — all fixed by the same composition.
- `src/App.tsx` `buildServerSaveExtras` — now documents that its
  `definedNames` is only the store contribution; the server merges it
  under its live names (2.3).

### 2.3 Gateway engine service (`packages/gateway`)

- `src/services/engineSvc.ts:270` — its `snapshotToWorkbookData` mirror
  gets the same snapshot default.
- `src/services/engineSvc.ts:284` — `mergeDefinedNames` port (same
  semantics as web io.ts, pinned by tests on both sides).
- `filteredSnapshot` — preserves `full.definedNames` (also fixes
  `GET /snapshot` responses, hence the remote host's pulled snapshots).
- `buildSaveWorkbookData` (~:836) — defined names are now
  `mergeDefinedNames(filteredSnapshot.definedNames /* live engine */,
  extras.definedNames /* client store */)`. The load-time
  `state.sourceDefinedNames` is deliberately no longer a fallback: the
  live snapshot list already includes the load-time names (via 2.1b),
  and resurrecting source names would undo a legitimate in-session
  deletion. `/download` (GET + POST, all formats) and `/library-save`
  share this builder — both fixed.

## 3. Validation

### 3.1 New tests

| Suite | Test | Proves |
|---|---|---|
| engine `tests/defined-names-snapshot.test.ts` (new, 4 tests) | live list (workbook + sheet-scoped + constant + unbindable, no TRUE/FALSE leak); snapshot→fromSnapshot round-trip evaluates identically and is stable; runtime define appears / delete disappears; live refs track `insertRows` (`Data!$A$1` → `Data!$A$2`) | engine source of truth |
| web `src/io.test.ts` (+4 tests, `defined names on save (defect E1)`) | merge semantics (primary wins, scope-aware, empty secondary loses nothing); snapshot default + filter preservation; synthetic round-trip through real XlsxAdapter bytes (workbook name used by many formulas, sheet-scoped name, `RateY1` unbindable) — 4 names out with exact refs/scope, formulas still `=BaseAmt*TaxRate` text, reopen values 25/50/50/21; **real P50 fixture**: 38 → 38 names, 21 `DividendsPctNI` refs intact, reopen spot values identical | client composition |
| gateway `tests/engineSvc.test.ts` (+3 tests, `defect E1` block) | POST /download with the real client's `definedNames: []` → all 4 names out (incl. sheet-scoped + unbindable `RateY1`), formula text intact; GET /download + /snapshot carry names; extras add store-only names, live ref wins a collision; **library-save with `definedNames: []`** → stored bytes parse back with all 4 names | gateway + library paths |
| desktop `tests/engine-load.test.ts` (+1 test) | P50 via `buildWorkbookFromBytes` (the packaged app's main-process open): IPC result carries 38 names AND the main-process host snapshot — exactly what the renderer's `ensureSaveSnapshot` pulls before a desktop save — carries 38; MONTHLY C13 evaluates to 132942.88335317458 in main | desktop IPC path |

### 3.2 Round-trip proof numbers (P50, the W10 failure shape)

| Metric | Before fix | After fix |
|---|---|---|
| Defined names: original → saved | 38 → **0** | 38 → **38** |
| Formulas referencing `DividendsPctNI` in saved file | 21 (all dangling) | 21 (all resolve) |
| Dangling name refs after save | 21 | **0** |
| Reopen MONTHLY VIEW (LITE) C13 (`=C9*'OPERATING MODEL'!$E$8`) | `#NAME?` | **132942.88335317458** (= pre-save value) |
| Reopen OPERATING MODEL E8 | `#NAME?` | **1595314.6002380955** (= pre-save value) |
| Save-side formula rewriting | — | none (snapshot formulas byte-identical name refs; the only direct-ref formulas are the 6 import-side HF-unbindable expansions, unchanged from the opened workbook) |

Proven three independent ways: the io.test.ts P50 test (composition
level + adapter parse-back), the desktop engine-load test (main-process
snapshot level), and live HTTP (§3.3).

### 3.3 Live gateway proof (isolated instance of the current dists)

The shared stack (:8100/:8101) was still running pre-fix builds, so the
proof ran on an isolated instance of the same topology built from the
fixed dists (gateway :8200, engine :8201; killed afterwards; shared
stack left untouched and healthy). Login as test user `e2e-user` via
`POST /auth/login`, then through the gateway:

- `POST /api/engine/load` (P50) → 200, 21 sheets, `file.definedNames` = 38
- `POST /api/engine/download` with the real client extras shape
  (`definedNames: []`) → 200, 92,043 B; parse-back: **38 names**,
  `DividendsPctNI = ASSUMPTIONS!$C$63`, **21 refs intact**, reopen
  C13 = 132942.88335317458, E8 = 1595314.6002380955
- `GET /api/engine/download` (no extras) → identical result (38 names)

### 3.4 Suite counts (final source, full runs)

| Package | Result | Baseline (W10) |
|---|---|---|
| packages/engine | **984 passed** (43 files) | 980 (+4 new) |
| packages/xlsx-adapter | **233 passed** (30 files) | 233 (untouched) |
| packages/gateway | **134 passed** (13 files) | 131 (+3 new) |
| apps/web | **1579 passed** (122 files) | 1570 (+4 new here; rest = concurrent W12 additions) |
| apps/desktop | **100 passed** (14 files) | 98 (+1 new here; +1 concurrent) |

tsc clean: engine, gateway, web (`--noEmit`), desktop.

## 4. Neighboring serializers — checked, with verdicts

| Path | Verdict |
|---|---|
| Named-range download subset, client (`io.ts namedRangeToWorkbookData`) | ✅ Correct already — builds its own single rebased `DefinedName` explicitly; unchanged by E1 and by this fix. |
| Named-range download subset, server (`engineSvc namedRangeToWorkbookData`) | ✅ Correct; **re-verified live** (§3.3 flow): subset for `DividendsPctNI` (ASSUMPTIONS!$C$63) → single sheet `DividendsPctNI`, defined name carried rebased as `DividendsPctNI!$A$1`, value 0.1. |
| Library save, server (`POST /library-save`) | ❌→✅ Was hit by the same extras-[] bug (shares `buildSaveWorkbookData`); fixed with it; new test proves stored bytes carry all names. |
| Library save / autosave, local + desktop | ❌→✅ Funnels through `buildDownloadBytes`; fixed by the App composition change. |
| Desktop IPC save / autosave | ❌→✅ Renderer pulls the main-process host snapshot via `engine:snapshot` IPC (`apps/desktop/src/engine-ipc.ts` → `host.snapshot()`); that snapshot now carries names (§3.1 desktop test). Desktop main itself never serializes saves (verified: no adapter write in `apps/desktop/src`). |
| Encrypted download (face b) + email attachment, local/desktop | ❌→✅ Both serialize via `buildDownloadBytes('xlsx')`; gateway mode via the fixed server download. |
| Non-xlsx exports (csv/tsv/ods/xlsb/html), client + server | ✅ Unaffected class: defined names are an xlsx/ods-table concept; both paths now receive the same corrected `WorkbookData.definedNames` and each adapter consumes what it supports. |
| `EngineWorkbook.fromSnapshot` (snapshot restore) | ❌→✅ Was in the same loss class (names never restored; name formulas restored as #NAME?); fixed in §2.1 and covered by the engine round-trip test. |
| Local mirror (`apps/web/src/features/localMirror.ts`) | ✅ Carries `mirror.definedNames` / load-result names into the client engine build; the mirror workbook's own snapshots now carry live names via §2.1. |

## 5. Known residuals (not E1; flagged, not fixed here)

- The client **Name Manager still does not list an opened file's names**:
  `hydrateOpenedWorkbook` never calls `importFromDefinedNames`, and the
  service store's `importDefinedNames` would anyway skip non-plain-range
  names (constants, OFFSET/dynamic, LAMBDA). Save fidelity no longer
  depends on the store, but the UI visibility gap remains — worth its
  own item.
- Deleting a name in the Name Manager deletes only the store entry; a
  name that also lives in the engine will still be saved (engine is
  primary). Pre-existing dual-model behavior, unchanged by this fix.
- `getDefinedNames()` (constructor list) is still what the parallel-
  recalc worker bootstrap reads (`parallel-recalc.ts`); runtime-defined
  names reach workers via the tracked-named-expressions channel instead.
  Untouched — out of E1's scope.
