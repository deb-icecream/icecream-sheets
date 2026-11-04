# Item F — Retired W21 per-save worker files: verification + removal

**Verdict: FIXED** — all five candidate files proven dead (no live product-code
reference), removed, gateway typecheck clean, gateway suite green (counts in §5).
No file was BLOCKED. One transient typecheck error seen mid-run was a sibling
worker's in-flight edit to `engineSvc.ts` (Item C), not a dangling reference —
see §5 note.

Scope honored: `progress.md` untouched, no git push, no edits to App.tsx /
shell, `packages/mcp-server`, or web export paths. No live file was edited at
all — removal only. Line numbers for `engineSvc.ts` are from the tree as read
during this run; a sibling worker (Item C) is concurrently editing that file
(it gained `saveStructuralCmds` during this run), so its line numbers drift —
the quoted code text is verbatim from this run's reads.

## 1. Method

Repo-wide scans (Python walk + grep, excluding `node_modules`, `.git`, and
`dist*` build output) for: `saveWorker|SaveWorker|SAVE_WORKER|save-worker`,
`saveChecksum|bulkStateChecksum`, `checksumFromBulk`, `spawnSaveWorker`,
`SaveWorkerError`, `resolveSaveWorkerScript`, `runSaveJob`, `SaveChecksumError`,
`W21`, `SAVE_OPS_CAP`, `ICECREAM_SAVE*`, plus targeted reads of
`packages/gateway/src/services/engineSvc.ts` (imports, `runDirectSave`,
SAVE_OPS_CAP site), `packages/gateway/package.json` scripts,
`packages/gateway/tsconfig*.json`, `vitest.config.ts`, `deploy/Dockerfile.gateway`,
`deploy/` configs, and every `package.json` in the repo. Baseline before
removal: `tests/saveWorker.test.ts` passed 4/4 (2 worker-core + 2 HTTP).

## 2. Per-file classification

### 2.1 `packages/gateway/src/bin/saveWorker.ts` (54 lines) — (a) TRULY DEAD → REMOVED

- Imports only candidates: `runSaveJob, SaveChecksumError` from
  `../services/saveWorkerCore.js`; type `SaveWorkerJob` from
  `../services/saveWorkerSpawn.js`.
- Referenced by NOTHING outside the candidate cluster. The only pointer to its
  compiled path is the candidate-string list inside
  `saveWorkerSpawn.ts:128-129` (`../bin/saveWorker.js`,
  `../../dist/bin/saveWorker.js`) — inside another removed file.
- No `package.json` script invokes it: gateway scripts are `start:agent /
  start:engine / start:etl / start:gateway / start:meta / start:vault /
  start:addons / start:connectors / set-tier` — no save-worker entry.
  No Dockerfile or `deploy/` reference (repo-wide config scan: zero hits).

### 2.2 `packages/gateway/src/services/saveWorkerCore.ts` (264 lines) — (a/b) DEAD → REMOVED

- Importers repo-wide: only `src/bin/saveWorker.ts` (removed, §2.1) and
  `tests/saveWorker.test.ts` (removed, §2.5). `runSaveJob` / `SaveChecksumError`
  have no other caller.
- Its own header claimed it "remains as a non-ordinary fallback" — unreachable
  in fact: the only two entry routes were the spawned bin (§2.1, no spawner)
  and `spawnSaveWorker` (§2.3, zero callers). No live path reaches it.

### 2.3 `packages/gateway/src/services/saveWorkerSpawn.ts` (280 lines) — (a/b) DEAD → REMOVED

- `spawnSaveWorker`: **zero callers** anywhere in src/tests/config/deploy
  (its only occurrences are its own definition and internal uses).
- `resolveSaveWorkerScript`, `SaveWorkerError`, `saveWorkerTmpRoot`,
  `saveWorkerScriptDir`: no external callers. The types `SaveWorkerJob /
  SaveWorkerResult / SaveWorkerSheetMeta` were imported only by
  `saveWorkerCore.ts`, `bin/saveWorker.ts`, and `tests/saveWorker.test.ts`
  (all removed).
- It contained the ONLY `child_process` spawn for saves in gateway src
  (grep `child_process|spawn(` over `packages/gateway/src`: sole hits were
  `saveWorkerSpawn.ts:20` and `:176`). After removal there is no per-save
  spawn site left in the gateway at all.

### 2.4 `packages/gateway/src/services/saveChecksum.ts` (63 lines) — (a) DEAD, NOT SHARED → REMOVED

Checked explicitly because it looked shareable. It is not shared with live code:

- Sole importer: `saveWorkerCore.ts:60` (`import { checksumFromBulk } from
  './saveChecksum.js'`). `bulkStateChecksum` has **zero** importers repo-wide.
- Live `engineSvc.ts` does NOT import it. It defines its **own local**
  `checksumFromBulk` (engineSvc.ts, `function checksumFromBulk(` inside
  `createEngineListener`, used for the direct save's `stateChecksum` and for
  checkpoint/rehydrate `fullStateChecksum()`). The two implementations have
  even diverged: the live one skips phantom-empty cells and appends the
  U+0003 separator per line; the removed one did neither. Removing
  `saveChecksum.ts` therefore cannot change live checksum behavior.

### 2.5 `packages/gateway/tests/saveWorker.test.ts` (188 lines) — (b) REMOVED

Mixed file; both halves accounted for:

- `describe('save worker core (in-process)')` — 2 tests (`checksum mismatch
  aborts and emits no file`; `verbatim save: edited sheet reflects the op,
  untouched sheet part is byte-identical`) — exist solely for
  `saveWorkerCore.ts`; removed with it.
- `describe('save over HTTP (direct streaming save)')` — 2 tests pin the
  CURRENT direct-save topology, but they are substantively duplicated by the
  surviving `packages/gateway/tests/directSave.test.ts` (7 tests):
  - `download runs direct over the live model and parse-back is exact`
    ↔ directSave.test.ts `download returns metadata only (mode visible);
    bytes live in the committed entry` (+ parse-back assertions).
  - `a mid-save fault is a save ERROR; the engine stays alive and usable`
    ↔ directSave.test.ts `forced mid-write failure: stored library file
    stays byte-identical, download errors, engine survives`.
  No unique live coverage is lost; directSave.test.ts additionally covers
  recalc-first, ops-during-save, autosave batches, and storage separation.

## 3. The SAVE_OPS_CAP / fallback question (Item C cross-check)

No live code path spawns the worker — at the cap or anywhere:

- `engineSvc.ts` imports (lines ~244–279) pull `serializeLiveWorkbook,
  verifyXlsxPackage` from `@icecream-sheets/service/save-node` and a fixed
  list from `../deploy/engineAccess.js` that does **not** include any
  saveWorker helper. There is no import of `saveWorkerCore.js`,
  `saveWorkerSpawn.js`, or `saveChecksum.js`.
- `runDirectSave` unconditionally calls `serializeLiveWorkbook({...})` over
  the live pinned bulk. Its header comment (engineSvc.ts ~2018): "There is
  NO per-save worker rebuild (the W21 design)".
- At the cap (`state.saveOps.length >= SAVE_OPS_CAP`, SAVE_OPS_CAP = 200_000):
  the journal is dropped, `state.saveWorkerEligible = false`,
  `state.saveOps = []`. Consequence in `runDirectSave`: when
  `!saveWorkerEligible`, the changed-set ops are replaced by a per-sheet
  `setCell` marker for EVERY sheet, so the direct streaming serializer
  regenerates all sheets from the live bulk. No worker is consulted.
- `saveWorkerEligible` itself is a retained field NAME, self-documented in
  engineSvc.ts: "(Field name kept from the W21 worker era: it now means
  "save journal intact", nothing worker-related.)" It is live state, not a
  reference to any removed file, and was not touched.

## 4. What was removed

```
packages/gateway/src/bin/saveWorker.ts
packages/gateway/src/services/saveWorkerCore.ts
packages/gateway/src/services/saveWorkerSpawn.ts
packages/gateway/src/services/saveChecksum.ts
packages/gateway/tests/saveWorker.test.ts
```

(The five were untracked in git — `git status` showed `??` for each before
removal — so removal leaves no git deletion records; `ls` confirms all five
paths gone.)

Post-removal scan for `saveWorkerCore|saveWorkerSpawn|saveChecksum|
bin/saveWorker|spawnSaveWorker|runSaveJob|SaveChecksumError|bulkStateChecksum`
across `packages/`, `apps/`, `deploy/` (excl. node_modules/dist): the only
remaining hits are comment-only mentions (§6) and the stale
`packages/gateway/tsconfig.tsbuildinfo` build-info blob, which tsc
regenerates.

## 5. Validation

- TypeScript: `npx tsc -p tsconfig.json --noEmit --incremental false` in
  `packages/gateway` → **clean, exit 0**. A separate emit build
  (`tsc -p tsconfig.json --outDir /tmp/gateway-build-F`) succeeded and the
  fresh output contains **no** saveWorker/saveChecksum artifacts.
  - Transient note: a first `--noEmit` run reported one error —
    `engineSvc.ts(1267): Property 'saveStructuralCmds' is missing … required
    in type 'EngineState'` — because the Item C sibling worker was mid-edit
    on engineSvc.ts at that moment (its mtime updated during this run; the
    initializer landed seconds later). The error named no removed module,
    and both the emit build and the final non-incremental typecheck pass.
- Gateway suite (full, `npx vitest run` in packages/gateway): first attempt
  died without a summary and a second attempt exited 1 with
  `ENOSPC: no space left on device` — /tmp is a 512 MB tmpfs that was 100%
  full (other workers' browser/test temp), an environment failure, not a
  test result. Re-run with `TMPDIR` pointed at the home filesystem (92 GB
  free): **Test Files 29 passed / 3 failed (32), Tests 314 passed / 4
  failed (318)**. The 4 failures:
  1. `directSave.test.ts` — recalc-first deep chain (11.3 s) and
     ops-during-save (47.9 s): assertion flakes under load (one got a
     session-less `dl_…` entryId instead of `autosave_…`; one revision
     count 2 vs 1).
  2. `engineSvcStream.test.ts` — /load single-JSON test (49.6 s).
  3. `gatewayEngineTimeout.test.ts` — the Item D sibling worker's OWN new
     test file, added to the tree mid-run while its fix was still in
     flight; its failing test parks an upstream for >30 s (92.4 s under
     load average ~20). Outside Item F scope; flagged for the Item D owner.
  - Solo re-run of the two pre-existing files immediately after:
    `tests/directSave.test.ts` **8/8 passed**, `tests/engineSvcStream.test.ts`
    **7/7 passed** (15/15, zero ENOSPC). Failures 1–2 are therefore
    load/concurrency flakes — the same pattern the Phase-2 consolidated
    run recorded ("1 directSave full-run failure = load flake, solo 8/8").
    None of the failing tests imports any removed module (directSave tests
    import `engineSvc.js` + `gateway.js` only), and the removal cannot
    affect entryId prefixes, /load streaming, or proxy timeouts.
  - Note: the run also picked up two test files siblings added mid-run
    (`saveJournalCap.test.ts` 8/8 passed; `gatewayEngineTimeout.test.ts`,
    see above) — the 32-file total includes them.
- service / xlsx-adapter suites: not re-run — nothing in those packages was
  touched and neither imports any removed file (repo-wide scan §1).

## 6. Noted, deliberately NOT edited (separate cleanup can decide)

1. `packages/gateway/src/deploy/engineAccess.ts` — LIVE file (imported by
   engineSvc/gateway/agentSvc/index), but its three exports
   `saveWorkerHeapMb` (:142), `saveWorkerTimeoutMs` (:148),
   `saveWorkerEnabled` (:169) now have **zero callers** (engineSvc's
   engineAccess import list excludes them; repo-wide scan shows definitions
   only). Dead exports in a live file — outside Item F's candidate list, so
   left in place and flagged here.
2. `packages/gateway/src/services/engineSvc.ts` ~line 763 comment on
   SAVE_OPS_CAP — "Save-journal cap: beyond this many ops the worker rebuild
   is not attempted." — now actively misdescribes live behavior (no worker
   rebuild exists; past the cap the direct path forces every sheet changed,
   as correctly documented at the field and in runDirectSave). Comment-only;
   not edited per instructions.
3. Comment-only W21 mentions in live files (left alone): 
   `packages/service/src/save/directSave.ts:31,312,565` ("ported from
   saveWorkerCore.ts phase 3"), `packages/xlsx-adapter/src/streamingSave.ts:2,10`
   (the CURRENT streaming writer — not a removal candidate),
   `packages/xlsx-adapter/src/stylesXml.ts:886`,
   `apps/desktop/src/direct-save.ts:53` (SaveWorkerSheetMeta shape comment;
   desktop defines its own type).
4. Stale compiled copies remain in build output only:
   `packages/gateway/dist/{bin/saveWorker.*,services/saveWorkerCore.*,
   services/saveWorkerSpawn.*,services/saveChecksum.*}` and the audit
   snapshot `packages/gateway/dist-rtaudit/…`. These are build artifacts,
   not source; nothing references them after this removal (the only
   resolver, `resolveSaveWorkerScript`, is gone, and no package.json script
   names them). A clean rebuild into a fresh outDir does not regenerate
   them — proven by the /tmp emit build above. Flagged because
   `deploy/Dockerfile.gateway` COPYs `packages/gateway/` wholesale before
   running tsc, so a stale dist copy would ride into an image build until
   dist is cleaned; recommend purging `packages/gateway/dist` save-worker
   artifacts (or building from a clean tree) in the separate cleanup.
5. Historical records (`hidden_files/cycle10-closure/…`,
   `hidden_files/direct-save-pass/…`, `TODO.md`, `perf-evaluation.md`,
   `progress.md`) mention the worker design — records, not references;
   untouched. The direct-save-pass record (worker-b-gateway.md §"grep
   confirms…") independently corroborates §3: the Phase 1 rewiring already
   removed every engineSvc reference to the worker modules and left the
   files in the tree untouched — which is exactly the residual Item F
   closes.
