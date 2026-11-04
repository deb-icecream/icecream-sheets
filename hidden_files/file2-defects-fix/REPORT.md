# File-2 Visual-Pass Defects — Fix Report

Fixture: `test-data/real-world/closedxml-TryToLoad-DrawingSizeInPx.xlsx` (981,840 B, 16 sheets, 23 pictures + 13 shapes across 3 drawing parts).
Source record: `hidden_files/roundtrip-audit/FILE2-VISUAL-PASS.md` (data+formulas PASS 16/16; drawings FAIL; blank-visit defect).
Isolated stack (this fix): gateway 8810 / engine 8811 / web 6174, data `hidden_files/file2-defects-fix/data`, web dist copy `dist-run` (8100→8810 byte rewrite). Shared 8100 stack untouched throughout.

## Diagnosis

### D1b — the shell (Workspace/deep-link) open never hydrates workbook metadata AT ALL (found during revalidation)

The adapter seeding (D1) is proven end-to-end at the API level: fresh user → upload → `POST /api/engine/open` → direct `POST {engineUrl}/load/storage-ref` returns 200 with `file.metadata` containing BOTH seeded keys (23 pictures; first = the 'icons' logo {x:902, y:23, w:14, h:18, data:image/png;base64,…}); `parseWorkbookFast` in-process likewise. But the browser still showed zero `<img>`: the shell join flow in `App.tsx` (the effect at ~:1989) calls `loadCatalogUploadIfNeeded`, which **discarded** the `loadStorageRefDirect` result, then hydrated from `remote.snapshotAsync()` only — and the engine `WorkbookSnapshot` protocol carries **no metadata field at all** (sheets/cells + optional definedNames only). So on ANY Workspace/deep-link open — creator or joiner — no metadata-driven overlay (imported pictures, text boxes, chart specs, themes…) could ever hydrate. The in-app stream open was unaffected (its terminal hydrate consumes the built /load response). Fix: the creator path now hydrates from the storage-ref load result with the exact terminal-hydrate call the stream flow uses (see Fix D1). The joined/rehydrated case (second user, or a re-open once the record has stored state) still hydrates from the snapshot only — a metadata channel for joiners (e.g. an additive `metadata` field on the snapshot response, built from `state.sourceMetadata` merged under session extras) is the named follow-up, out of this fix's minimal scope.

### D1 — embedded pictures/shapes do not render on reopen: DIAGNOSED (adapter → app display channel missing)

Chain trace, gateway-mode open:

1. **Adapter parses the drawings fine.** `packages/xlsx-adapter/src/drawings.ts` parses every drawing part into `NativePicture` {anchor, mediaBytes (byte-identical), name, altText, contentType} and `NativeShape` {anchor, preset, fill, line, text, name}; `attachNativeDrawings(sheets, sharedZip)` attaches them to the sheet objects in the adapter's shared assembly funnel (`adapter.ts` ~:561), used by BOTH read paths. Probe of the fixture through the adapter confirms: 'icons' 1 picture (Amazon logo PNG, 791 B, anchor M2, 14×18 px by EMU span); 'International URLs' 1 shape (rect/textbox, fill DBEEF4, text "This table determines the localized URLs to which to upload.", anchor A2, 1152×155 px nominal); 'Images' 22 pictures + 12 textbox shapes.
2. **Nothing downstream consumes them.** Grep: zero references to `nativePictures` / `nativeShapes` / `nativeDrawingsRaw` in `apps/web/src` or `packages/engine/src` — only the adapter and its tests use them.
3. **The gateway drops them.** `packages/gateway/src/services/engineSvc.ts:1356 loadResponse()` whitelists per-sheet fields (name/formats/styles/colWidths/rowHeights/hidden*) — native pictures never reach the wire.
4. **The app's only picture channel is never seeded for imports.** The web app renders pictures exclusively from workbook metadata key `icecream.pictures` (`apps/web/src/components/Pictures.tsx:31`; model {id, x, y, w, h px, dataUrl, name, sheet?}; `picturesFromMetadata` requires a `data:image/…` dataUrl). `App.tsx:6145` hydrate does `setPictures(picturesFromMetadata(data.metadata['icecream.pictures']))`. That key is written only for app-authored pictures (session-extras). Reproduced live on the isolated stack (repro.mjs): the client POSTed session-extras with `"icecream.pictures":[]` — hydrate had nothing. Local mode is broken identically (same funnel, same hydrate).
5. **Shapes have no channel at all.** The app has a text-box overlay (`Overlays.tsx` TextBox {id,x,y,w,h,text}) but no metadata key, no hydrate, no sheet scoping — session-only UI state. All 13 native shapes in this file are text boxes (rect preset with text bodies).
6. **Save safety of the fix:** the write path (`injectNativeDrawings`, drawings.ts ~:855) prefers `nativeDrawingsRaw` byte-for-byte preservation; seeding display metadata does not double-author on save (audit's byte-stable checkpoints, checksum 2bb42321c1647ab…).

**Fix layer: the xlsx adapter's read assembly** (the one funnel every open path — gateway classic, gateway stream terminal hydrate, local — consumes exactly once), plus a small web hydrate for text boxes. Geometry: prefix sums over the sheet's own `colWidths`/`rowHeights` (already pixels in the adapter model; the 'International URLs' shape computes to exactly 1152 px wide this way) + EMU offsets at 9525 EMU/px; oneCell anchors use extCx/extCy; degenerate spans (≤0, present in this sloppily-authored fixture) fall back to the image's intrinsic pixel size parsed from its bytes.

### D2 — sheet first visited during the post-open checkpoint stays blank for the whole visit: DIAGNOSED (client failure-breaker latches with no retry)

Engine side is contract-correct (item H, test-pinned): `/read` waits out the load-build gate (`waitForLoadBuild`, engineSvc.ts:1956/:4622); a read for a sheet of a SUPERSEDED workbook build returns **409 "read superseded"** (pended+absent) or **404 `Unknown sheet: X`** (non-pended absent). The build is synchronous, so reads queued during a load are processed after the host swap — the previous workbook's boot reads land as 404s against the new host. Reproduced on the isolated stack: exactly four /read 404s, all 'Sheet1' (the boot workbook's sheet) range reads, matching the visual pass's per-tour 404 family; the checkpoint-window aggravator is identical in kind (reads racing a rebuild/checkpoint window get contract 404/409 "absent" answers while the data is intact server-side).

Client mechanism (`apps/web/src/services/remoteEngine.ts`): RemoteView keeps a per-key failure backoff AND a **global failure breaker** (`noteFetchFailed()` → `downUntil = now + min(500·2^streak, 15 s)`; `transportDown()` gates `readCell`/`readRange`/`usedRange`/`prefetchViewport`). The batcher's rejection handler calls `noteFetchFailed()`, so the open-phase 404s trip the breaker. When the batch settles it notifies — but **nothing re-renders or re-queues when the breaker lifts**: notify fires only when a fetch settles, and no fetch can be queued while the breaker is down. A sheet first rendered inside the breaker window therefore reads EMPTY from every path, **no /read request for it is ever issued** (repro 1: zero /read requests for 'Dropdown Lists' after the switch at ~23.3 s; presence heartbeats — which bypass the view gate — kept firing naming that sheet), and it stays blank for the entire visit (tour 5: blank at +12 s with status "✓ Saved"). Leaving and re-entering re-renders after the breaker has lifted, so it paints. The breaker's own header comment states the intent ("a dead engine mid-session produces ~1 batch per window") — the retry half of that intent was never implemented.

Secondary suspect (not the operative path in repro 1, still fixed): `UsedRangeDeduper` (bulkReads.ts:244) — RemoteView's fetcher resolves `null` when reads are gated/down, and the deduper caches settled results including null, which would pin a sheet's used range to null until invalidation.

**Fix layer: the web client's RemoteView only** (engine contract unchanged — the 404/409s are contract-blessed open-phase noise for a superseded workbook, not transport failures): (1) breaker-lift re-notify — when `noteFetchFailed()` arms the breaker, schedule a one-shot timer at `downUntil` that calls `opts.notify()` so the render path re-runs and re-queues still-missing reads (self-limiting via the existing exponential cap; cleared on success/gate-lift); (2) gated/down used-range fetches REJECT instead of resolving null, so the deduper never caches a non-answer as data (`usedRangeAsync` wraps with catch→null to preserve its contract).

## Fix D1
IMPLEMENTED (adapter read funnel + web text-box hydrate):

- `packages/xlsx-adapter/src/drawings.ts` — new display-model seeding section:
  - `nativeAnchorRectPx(anchor, sheet)`: anchor → absolute px rect on the sheet's own `colWidths`/`rowHeights` (prefix sums) + EMU offsets at 9525 EMU/px; oneCell anchors take size from `extCx/extCy`. Verified against the fixture: the 'International URLs' shape computes to exactly 1152 px wide; the 'icons' picture to x=902, y=23, 14×18 px at M2.
  - `imagePixelSize(bytes)`: PNG/GIF/JPEG header size, used only when an anchor span is degenerate (≤0 — several 'Images' anchors in this fixture).
  - `seedNativeDrawingDisplayModels(sheets, metadata)`: seeds `icecream.pictures` (all native pictures: {id, x, y, w, h, dataUrl (base64 of the byte-identical media), name, sheet}) and `icecream.textboxes` (native shapes WITH text: {id, x, y, w, h, text, sheet}) — each key ONLY when absent, so app-owned values always win. Textless autoshapes are not seeded (no app counterpart); native fill/line are not carried (the app text-box model has no fill field — closest-kind fallback, per the embedded-objects rule).
- `packages/xlsx-adapter/src/adapter.ts` — the assembly funnel calls the seeding right after `attachNativeDrawings` (best-effort try/catch like every zip-level stage). One funnel ⇒ gateway classic load, gateway stream terminal hydrate, local and desktop opens all get the models. No gateway change needed: `loadResponse` already passes `metadata` through `encodeMetadataForJson`, which carries plain arrays as-is.
- `packages/xlsx-adapter/src/index.ts` — exports for the new functions/constants.
- Web text-box channel (pictures needed none — the hydrate already existed): `apps/web/src/components/Overlays.tsx` — `TextBox.sheet?` added, `TEXTBOXES_METADATA_KEY`, `textBoxesFromMetadata`/`textBoxesToMetadata`; `apps/web/src/App.tsx` — hydrate sets text boxes from metadata beside pictures, render filters by active sheet with the same predicate pictures use.
- Shell-flow hydrate (D1b, found in revalidation): `apps/web/src/App.tsx` — `loadCatalogUploadIfNeeded` now RETURNS the `EngineLoadResult` from `loadStorageRefDirect`; the join effect hydrates from it (`workbookDataFromLoadResult` + `hydrateOpenedWorkbook(..., { skipEngineSide: true, colNonEmptyBySheet })`, preceded by `notifyHostReplaced()`) — the identical terminal-hydrate call the stream open flow uses — before the existing snapshot/loaded bookkeeping.

Tests: `packages/xlsx-adapter/tests/drawings.test.ts` +5 (seeded models from the hand-built package with exact geometry; app-owned-wins; anchor rect on custom dims; imagePixelSize PNG/GIF/JPEG; the real File-2 fixture: 23 pictures + 13 text boxes, icon at 902/23 14×18, URLs box w=1152). Drawings suite 19/19; adapter tsc clean. Full adapter suite + full web suite: see Revalidation.

## Fix D2
IMPLEMENTED (web client `RemoteView` only; engine item-H contract untouched):

- `apps/web/src/services/remoteEngine.ts`:
  1. **Breaker-lift re-notify** — new `liftTimer`: `noteFetchFailed()` now also calls `scheduleLiftNotify()`, arming a one-shot timer at `downUntil`; on fire, if the window was extended it re-arms, otherwise it calls `opts.notify()` once so the render path re-runs and re-queues still-missing reads. `noteFetchOk()` (success or gate lift) clears the pending timer. This completes the breaker's documented intent (~1 batch per window): previously the window suppressed fetches but nothing ever retried when it elapsed.
  2. **Gated used-range reads reject instead of resolving null** — the `UsedRangeDeduper` fetcher returns `Promise.reject(...)` while reads are gated or the breaker is down, so the deduper never caches a non-answer as "no used range" (its `get()` caches only on resolve; rejections clear in-flight). `usedRangeAsync` wraps with `.catch(() => null)`, preserving its public contract.
- Tests: `apps/web/src/services/remoteEngine.test.ts` +2 (breaker arming → no reads → lift nudge fires a notification with zero intervening fetches; gated used-range resolves null with no transport call and no cache entry — the post-lift call fetches the real range). remoteEngine + bulkReads suites 24/24; web tsc clean. (Two assertions were corrected during development: a pre-failure legitimate 'Sales' warm call, and 'Sales' being already-cached — the gated subject is the never-warmed 'Ledger'.)

## Fix D1 follow-up (found during revalidation): session-extras 1 MiB cap

With D1 fixed, the client's session state legitimately holds the 23
imported pictures (~964 KB of image bytes ≈ 1.3 MiB base64). The
client syncs presentation extras via POST /session-extras — whose
handler called readBody(req) with NO limit, i.e. the 1 MiB default.
Engine log evidence from the revalidation session (data5):

    [engine] request failed POST /session-extras: request body exceeds 1048576 bytes  (×3)

Pre-fix this never fired (the pictures list was always empty). The
extras shapes are the save-extras shapes, and the save/download
routes carrying them already use DOWNLOAD_MAX_BODY_BYTES (32 MiB).
Fix: the /session-extras handler in engineSvc.ts now passes
DOWNLOAD_MAX_BODY_BYTES to readBody, with a comment naming the case.
Regression test (gateway directSave.test.ts): "session-extras accepts
media-sized extras (File-2 D1 follow-up)" posts a 1.3 MiB picture
dataUrl in extraMetadata and expects 200 + extrasDirty — PASSES;
gateway tsc clean; gateway dist rebuilt. Live re-proof of the extras
push was overtaken by the infrastructure failures catalogued below;
the defect evidence (3 rejections) and the unit proof are on record.

## Revalidation

### Unit / suite validation (final)
- xlsx-adapter: **372/372** (27 files), incl. drawings.test.ts 19/19
  with the real-File-2 assertions (23 pictures + 13 text boxes; icon
  {902,23,14,18}; shape width exactly 1152 px; dataUrl shapes).
  Adapter tsc clean; adapter dist rebuilt.
- web: **1,948/1,948** (193 files) — incl. remoteEngine.test.ts 19/19
  with the two D2 regression tests (breaker-lift re-notify fires with
  NO intervening fetch; gated used-range leaves no poisoned cache
  entry and fetches for real after the lift). NOTE: this full run
  predates the D1b App.tsx edit; after that edit, App.tsx + Overlays
  type-check clean (the only repo-wide web tsc errors are the OTHER
  program's in-flight AgentChat.tsx intent-union errors — see below).
- gateway: directSave.test.ts media-extras test PASS; gateway tsc
  clean; gateway dist rebuilt (the extras-cap fix + everything prior).

### Browser revalidation (isolated signed stack: gateway 8810 / engine 8811 / web 6174, data5)
- **D1: PASS — visually proven by the worker's own inspection.**
  Creator flow (fresh user, Workspace upload → open):
  - 'icons': 1 img in DOM; screenshot `reval/01-icons.png` and zoomed
    clip `reval/01-icons-clip.png` show the Amazon "a" logo at the M2
    anchor (L/M boundary, rows 1–2).
  - 'International URLs': 1 text box; `reval/02-International_URLs.png`
    shows the shape's full three-paragraph text spanning the sheet.
  - 'Images': **22 imgs + 12 text boxes** in DOM;
    `reval/06-Images.png` (self-inspected) shows every product photo
    in its strip and all 12 text boxes ("Image Examples", "Pure white
    background", "No inset images", …) in file-true positions;
    zoomed clip `reval/06-Images-clip.png`.
  All 16 sheets were visited (screenshots reval/01…11 + phase-A pair);
  the renderer crashed on the sheet-12 tab click (VM memory pressure,
  same failure the original pass recorded in its tour 1) — sheets
  12–16 carry no overlays in this file beyond what sheets 1–11 prove,
  and their pre-fix screenshots stand from the visual pass.
- **D2: live re-proof NOT captured — infrastructure.** What stands:
  (1) the pre-fix live repro (this report's repro1: a sheet switched
  to during the window issued ZERO reads for the whole visit);
  (2) unit tests that exercise the exact latched-breaker mechanism
  end-to-end at the RemoteView level — the lift notification cannot
  fire at all on pre-fix code (no such code path), so the tests are
  discriminating; (3) probe3's live observation (pre-fix bundle) of
  the positive pattern — a sheet switched to during "Saving…" whose
  reads flowed painted 52 cells with no re-entry, isolating the
  latch (not the window) as the defect. Five attempts at the fixed-
  bundle tour-5 pattern were defeated by the environment, not by the
  product: engine processes died silently 3× (VM at ~1.6 GB free
  with several other programs' tours running), the gateway and the
  static web server each died once, the renderer crashed twice, and
  the final attempt's Workspace list timed out at 30 s. The one-
  command re-run on a quieter host: start_stack.py (fresh data dir +
  current dists) then reval.mjs (phase A is the tour-5 pattern) or
  reval-d2.mjs (join + park) in this directory.
- **Disclosures.** (a) A gateway restart script of mine briefly bound
  port 8100 for ~1 min (the bin reads PORT, which the script hadn't
  set): the shared 8100 gateway was already down at that moment
  (health 000 verified before the restart) — no live service was
  displaced; I killed the process and relaunched on 8810 with PORT
  set; shared 8100 still read 000 at last check (its owners'
  recovery path, as in the earlier infra incident). The shared stack
  was never otherwise touched: all work ran on 8810/8811/6174.
  (b) Mid-task, repo-wide web tsc picked up 3 errors in
  apps/web/src/components/AgentChat.tsx (intent route 'chart' not in
  the IntentRoute union) from the agent re-run program's concurrent
  in-flight edits; they are not in any file this task touched.

## Verdicts
- **D1 (pictures/shapes don't render): FIXED + PROVEN** at every
  level — adapter unit + real-fixture assertions, API wire proof,
  and self-inspected browser screenshots of all three anchors.
  Root causes: no display model was ever derived from the parsed
  native drawings (consumers: zero), and the shell open flow dropped
  the one payload that carried workbook metadata (engine snapshots
  have no metadata channel — the snapshot-metadata follow-up for
  joiner/rehydrated opens is named in the D1b section and remains
  open by design-minimality).
- **D1 follow-up (session-extras cap): FIXED + unit-proven**; live
  re-proof pending a quieter host (same re-run as D2's).
- **D2 (blank first visit during checkpoint): FIXED at the client
  mechanism level + unit-proven; live browser verdict OPEN** —
  blocked by five infrastructure failures enumerated above, with a
  one-command re-run staged. The engine-side item-H contract is
  unchanged and untouched.
