# Worker E — engine save pin (pin + copy-on-write stash)

Scope: `packages/engine` only (`src/protocol.ts`, `src/workbook.ts`, `src/index.ts`,
`tests/savePin.test.ts`, rebuilt `dist/`). No gateway/desktop/web files touched.
No git push.

## API as implemented (exact signatures — gateway/desktop workers code against these)

Exported from the package index (`@icecream-sheets/engine`):

```ts
export interface SavePin { id: string; rev: number }
export class SavePinOverflowError extends Error {}   // name === 'SavePinOverflowError' (set explicitly)
export const DEFAULT_SAVE_PIN_STASH_CAP_CELLS = 100_000;

// On EngineHost:
beginSavePin(opts?: { stashCapCells?: number }): SavePin
releaseSavePin(pin: SavePin): void
savePinStashCells(pin: SavePin): number
bulkReadbackSheetPinned(pin: SavePin, sheet: string, auth?: AuthContext):
  Array<{ ref: CellRef; input: CellInput; value: TypedValue }>
// Extra (additive, not required by the brief):
currentRevision(): number   // host revision counter; SavePin.rev snapshots it
```

Supporting EngineWorkbook additions (engine-internal, also public on the class):
`onBeforeCellWrite(observer): () => void`, `getPinnedCellState(ref)`,
`formulaNameReadDenial(input, auth?)`.

### Contracts

- **Revision.** EngineWorkbook maintains NO revision counter (checked: only the
  calc-chain `graphVersion`, which bumps on graph shape, not per op). The counter
  therefore lives on EngineHost: `revision` starts at 0 and increments once per
  ACCEPTED mutating `execute()` — result `ok: true` and cmd in the mirrored
  `SAVE_PIN_MUTATING_OPS` set (= `DIRECT_SAVE_MUTATING_OPS` from
  `@icecream-sheets/service/save-node`: setCell, setFormula, addSheet, deleteSheet,
  renameSheet, duplicateSheet, moveSheet, defineName, deleteName, renameName,
  updateNameRefersTo, defineFunction, updateFunction, rollbackFunction,
  deleteFunction, insertRows, deleteRows, insertCols, deleteCols, setCalculationMode;
  mirrored in protocol.ts because the engine cannot import the service package).
  `SavePin.rev` = that counter at pin time. Direct EngineWorkbook writes (bypassing
  `execute()`) do not advance it.
- **releaseSavePin** is idempotent (unknown/already-released = no-op).
- **savePinStashCells** on a released/unknown pin returns **0** (chosen contract,
  asserted in tests).
- **bulkReadbackSheetPinned** on a released/unknown pin (or a rev mismatch)
  **throws** `Error('Unknown or released save pin: …')` — fail closed, so a
  serializer can never silently receive live, possibly torn state in place of
  the pinned revision. Ordinary reads (`bulkReadback`, `readCell`, …) after
  release are live, as always — the stash only ever fed pinned reads.
- `execute()` pin-gate failures throw **SavePinOverflowError as an exception**,
  never `{ ok: false }`: the gate runs before `executeInner`'s error folding.
- `replaceWorkbook()` while ≥1 pin is active also throws SavePinOverflowError
  (a swap would orphan every stash); release pins first.

## Mechanism

### Where the CoW hook lives — two layers

1. **Execute gate** (`EngineHost.savePinGate`, run at the top of `execute()`,
   before authorization and before the op applies; also at the top of
   `executeAsync` for `recalculateParallel`). For `setCell`/`setFormula` it
   computes the changed set and stashes it into every active pin
   (`stashForActivePins` — atomic: every pin's cap is pre-checked before
   anything is stashed or applied, so an overflow leaves workbook AND all
   stashes untouched and the op unapplied).
2. **Workbook write-funnel safety net**: `EngineWorkbook.onBeforeCellWrite`
   observers fire BEFORE any write at the lowest cell-write funnels —
   `setCell`, `setFormula`, `setCellRaw`, plus the direct-HyperFormula writes
   in `refreshExternalLinks` and the cache merge in `applyParallelResults`.
   EngineHost installs one observer while ≥1 pin is active (removed when the
   last pin releases / on dispose). It stashes the write's full pre-write
   changed set; for `execute()` ops the gate already stashed it (no-op), for
   DIRECT EngineWorkbook writes that bypass `execute()` it is the only stash —
   a dedicated test proves a direct `wb.setCell` during a pin stays consistent
   (edited cell + dependent both read pin-time values). A cap overflow from
   the observer throws out of the write, before that write lands.

### How the changed set is enumerated

- Edited cell, plus the **uncapped** `EngineWorkbook.measureCalcChain(ref)`
  walk (`measureCalcChain` in calc-chain.ts with no `maxNodes`) — the same
  dependency-graph walk recalc/routing use: transitive dependents, range
  vertices followed transparently, named-expression vertices traversed to
  their downstream cells. `measurement.cells` is the full affected set.
- **Graph-blind suspects, stashed unconditionally** (stashing an unchanged cell
  is harmless — its pin-time state is its pre-op state): every tracked formula
  for which `isVolatileFormula()` (volatile.ts) holds — INDIRECT, OFFSET,
  RAND, RANDBETWEEN, RANDARRAY, NOW, TODAY, CELL, INFO. HyperFormula does not
  track INDIRECT/OFFSET precedents and volatile cells can recalc on any cycle,
  so no graph walk can enumerate them exactly.
- Edited cell's pre-op **input** is stashed too; dependents' inputs don't
  change but are stashed uniformly (input + value), simplest correct.
- Stash key: `` `${sheet}\0${row}\0${col}` ``; value `{ input, value }` or an
  ABSENT marker for cells that don't exist yet. First write wins — a pin's
  stash entry is never overwritten, which is what makes later ops' stashes
  still describe pin time. Each pin owns an independent stash + cap; pins are
  held in a Map keyed by pin id (`save-pin-<n>`, host-local counter).

Capture is via the new `EngineWorkbook.getPinnedCellState(ref)`: serialized
input (undefined ⇒ ABSENT) + value evaluated with NO auth (see auth choice).

### Pinned read construction (`bulkReadbackSheetPinned`)

Start from the LIVE `bulkReadback(auth)` entries for the sheet — unedited
cells and the whole authorization pipeline come from the exact code path
being matched — then apply the stash: stashed cell ⇒ substitute stashed
input/value; stash ABSENT ⇒ omit (created after pin); stash entry with no
live counterpart ⇒ include from the stash (deleted after pin). Result
sorted by (row, col), bulkReadback's order within a sheet.

### Authorization choice (documented per brief)

**The pin freezes principal-agnostic state; authorization filtering stays
per-requesting-principal at read time.** Stash entries are captured through
`getPinnedCellState()`, which skips getValue's name/function read-denial
pre-check and evaluates with `auth === undefined` (the engine-internal
evaluation posture `withCallContext` already uses), so a frozen value never
encodes the EDITING principal's permissions. At pinned-read time each
substituted/included cell passes through `pinnedValueFor()`, bulkReadback's
exact check order and messages: `authorize('cell.read')` → `#PERM!`
(`permission denied: cell.read …`) → direct hidden check → `#PERM!`
(`hidden cell: …`) → workbook-level name/function denial → formula
hidden-taint → `#PERM!` (`formula references hidden cell: …`). Two necessary
adaptations, both forced by the live cell having moved on:
- the workbook-level denial is computed from the **frozen input** via the new
  `EngineWorkbook.formulaNameReadDenial()` (the same `scanFormulaNames`
  pre-check getValue uses, surfacing as `err('#PERM!', 'No read access to
  "<name>".')`), instead of from the live value, whose denial would describe
  the live formula;
- the hidden-taint string-literal scan (INDIRECT targets) additionally runs
  over the frozen formula text, since the live formula may be edited/gone.
  The graph half of the taint walk necessarily uses the live dependency
  graph (same as bulkReadback itself computes for live cells).
Name/function registries are identical at pin and read time for this
purpose, because name ops throw while a pin is active (below). One
theoretical gap, stated plainly: a denial arising only mid-evaluation
through a PERMITTED named function's body referencing a denied name, for
the single edited cell — the direct-reference pre-check (what bulkReadback's
fast path also surfaces) is fully covered.

### Overflow / structural fallback

- Default cap **100_000 cells per pin**, `beginSavePin({ stashCapCells })`
  overrides (invalid values → default). If stashing an op would exceed ANY
  active pin's cap: the op is **not applied**, revision does not advance,
  `execute()` throws SavePinOverflowError; callers queue + retry after release.
- While ≥1 pin is active, every SAVE_PIN_MUTATING_OPS command other than
  setCell/setFormula throws SavePinOverflowError: structural (addSheet,
  deleteSheet, renameSheet, duplicateSheet, moveSheet, insertRows, deleteRows,
  insertCols, deleteCols — the stash is keyed by (sheet,row,col) and cannot
  represent topology changes) AND **name/function ops** (defineName,
  deleteName, renameName, updateNameRefersTo, defineFunction, updateFunction,
  rollbackFunction, deleteFunction) AND setCalculationMode. **Chosen for name
  ops: the safer overflow error** (not stashing the names table) — a name
  change can rebind ANY formula's value, a changed set no cell enumeration
  can bound; serializers pin only across cell edits, and structural/name ops
  queue behind the save exactly like overflow ops.
- `recalculate` / `recalculateParallel` also throw while pinned (a bare
  recalc can move volatile/manual-mode values with no edited cell to
  enumerate from). `setParallelRecalcOptions` changes no workbook state and
  is allowed.

## Tests

`packages/engine/tests/savePin.test.ts` — **8 tests, all passing**:

- (a) Torn-state: Sheet1!A1=2, Sheet3!A1 `=Sheet1!A1*10` → 20. Pin; edit A1=5
  (live 5/50). Pinned reads show input 2/value 20 on both sheets (mutually
  consistent); stash = 2 cells; release ⇒ `savePinStashCells` = 0 and pinned
  read on the released pin throws (the chosen contracts).
- (b) Cell created after pin omitted from pinned read; cell deleted after pin
  (setCell null) still present with pin-time input/value.
- (c) Overflow at `stashCapCells: 2` with a 4-cell changed set (chain
  A1→B1→C1→D1): throws SavePinOverflowError (instance + `.name` asserted),
  live values and revision unchanged; after release the same op succeeds.
- (d) insertRows / addSheet / renameSheet / defineName during a pin all throw
  SavePinOverflowError and none apply; insertRows succeeds after release.
- Multiple concurrent pins: pin1 at value 1, pin2 at value 2, further edits —
  each pin reads its own revision; releasing pin1 leaves pin2 fully working.
- Pinned-read authorization: Authorizer denying `cell.read` on Sheet1!B1 —
  pinned read returns pin-time value for the permitted cell and `#PERM!`
  (never the pin-time secret) for the denied cell.
- Safety net: direct `EngineWorkbook.setCell` bypassing `execute()` during a
  pin — pinned reads of the edited cell AND its dependent stay at pin time.
- (e) No pin: setCell/insertRows/defineName behave exactly as before.

**Build:** `npm run build` (tsc) in packages/engine — clean; the new API is
present in `dist/protocol.d.ts` / `dist/index.d.ts` and was smoke-tested
against the built `dist/index.js` directly (begin/pin-read/stash/release).

**Full engine suite** (brief warranted it for the core package):
`npx vitest run` — **45 test files passed, 995 tests passed, 0 failed**
(includes the 8 new savePin tests; ~102 s).
