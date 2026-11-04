# W15 — P95 browser TTFP finisher (Cycle 10 closure pass, worker B3)

**Verdict: PASS (marginal, contention-bound).** P95 browser time-to-first-page
median **2.93 s** across 8 settled runs (2.28 / 2.45 / 2.67 / 2.73 / 3.12 /
3.15 / 3.21 / 3.22 s) vs the §7 finisher median **3.10 s** (2.95 / 3.10 /
3.71 s) — under the ≤ 3 s target, all runs reported, none cherry-picked.
P50 / P75 TTFP not regressed (medians 305 ms / 348 ms vs §7's 340 / 350 ms).
P95 fully-loaded wall not regressed (median ≈ 47.8 s across the settled
batches vs §7's 49.9 s). Web full suite green: **1579/1579 (122 files)**;
related stream/remote suites green (67/67, see below). All changes are
client-side; no engine/gateway code was touched.

Method: same harness family as §7 (`hidden_files/pw2/tour.mjs` pattern —
login as `e2e-tester`, drag-drop the fixture, TTFP = the app's own
`window.__icecreamFirstPage.timeToFirstPageMs`), via the new probe harness
`hidden_files/pw2/w15-profile.mjs`. Settled runs (`--wait-loaded`) wait for
the load banner to clear before the next run, exactly like the tour, so a
run never competes with the previous run's still-running server build.
(Early back-to-back runs that cut at first page were contaminated by the
prior build and are excluded from the headline set; they are listed in the
appendix for honesty.)

---

## 1. Client-side profile decomposition (measured, old build)

Instrumentation: in-page wrappers on `fetch` (load/stream request +
response-header timestamps), on `ReadableStream.getReader().read()`
(per-read resolve time, bytes, and the resolve→next-call gap = main-thread
processing of that batch), on `JSON.parse` (per-line size/duration), a
`longtask` observer, and the app's own first-page marks. One CDP CPU-profile
run was taken and discarded for timing (the profiler itself inflated TTFP
to 8.07 s; its function attribution was still consistent with the below).

Two clean old-build runs (ms, relative to `fileSelectedAt`):

| segment | run A | run B | what it is |
|---|---|---|---|
| selected → stream request | 186 | 219 | `uint8ToBase64` (FileReader) + `JSON.stringify` of the 17.7 MB body |
| request → response headers (meta) | 2,773 | 2,821 | upload + gateway body buffer + engine JSON parse + unzip + meta flush |
| headers → first values | 669 | 1,284 | server meta→first-rows gap + client processing of meta/first-rows |
| first values → painted mark | ~0 | ~0 | microtask after the seed tick (existing mark semantics) |
| **TTFP** | **3,628** | **4,324** | |

Key findings (evidence, not guesses):

1. **First-chunk processing is ~free.** The first Sales rows line is
   34,521 chars; `JSON.parse` costs 0.4 ms for it; the reader gap before
   its processing is 27 ms; `mergeLoadChunks` + `streamedCellsFromChunk`
   + `RemoteView.seedStreamed` for a 128-row chunk are all sub-ms–few-ms.
   The §7 hypothesis of "~1.4 s client ingest + paint" does **not** live
   in per-chunk parsing/seeding of the first chunk.
2. **The browser's request→headers leg was ~0.9–1.0 s slower than a Node
   client on the same box** (Node via gateway: headers 1.84 s, first rows
   2.10–2.24 s; server `elapsedMs` stamps: meta 1,158 ms, first rows
   1,828 ms from engine handler start; parse timings: unzip 1,139 ms).
   A controlled in-browser raw-fetch experiment with identical payloads
   isolated it to the body form: **string body 2.53 s → headers /
   Blob body 2.03 s** (uint8 body worse, 2.78 s). Chrome copies a 17 MB
   string body out of the renderer as UTF-16 and re-encodes it in the
   network service; a Blob body streams the already-encoded bytes.
3. **Meta→first-rows window carried 0.25–0.9 s of main-thread work**:
   on the meta chunk the App ran `notifyHostReplaced()` **plus the full
   `hydrateOpenedWorkbook`** (~20 store updates: formats, pivots, charts,
   SmartArt, page setup, protection, …) synchronously inside the stream
   delivery path, producing a fan-out of full-App renders (longtasks of
   50–165 ms each in the window) that (a) queued the reader's processing
   of the arriving rows behind renders and (b) stole the shared 2 cores
   from the engine's parse worker. At meta time that hydration is almost
   entirely wasted for first paint: sheet formats only accumulate from
   `rows` chunks, and dims/column counts only exist in the terminal
   payload — the meta-time hydrate seeded an empty format store.
4. **`mergeLoadChunks` was O(total²/chunk) over the whole ingest**: for
   every `rows` chunk it rebuilt a `"row:col"`-keyed `Map` over *all*
   accumulated cells of the sheet (plus in `RemoteEngineHost`, a second
   full conversion of the same chunk). Not a first-chunk cost, but a
   real ingest/longtask cost at 1.8 M cells, and it delays first paint
   whenever several lines arrive in one network batch (the delivery loop
   processed a whole batch synchronously before any paint could occur).

## 2. Changes (client only; 3 files)

### `apps/web/src/services/gatewayClient.ts` — `engineLoadXlsxStream`
- **Blob request body**: `body: new Blob([JSON.stringify({format:'xlsx',
  data: base64})], {type:'application/json'})` instead of a bare string.
  Byte-identical JSON on the wire; gateway/engine handling unchanged.
- **Time-sliced delivery**: the NDJSON line loop now yields to the event
  loop (`setTimeout 0`) whenever a single network batch has consumed
  ~40 ms of synchronous delivery, so a batch carrying meta + several
  4096-row chunks can no longer postpone the first-paint mark/render
  behind the whole batch; later chunks keep filling between slices.

### `apps/web/src/App.tsx` — `openRemoteBuffer` (+ one ref)
- **Frame/full-hydrate split.** First chunk now does the FRAME step only:
  `notifyHostReplaced()` (sheet names, active sheet, per-workbook UI
  reset — everything first paint needs; values come from the host's
  pushed-cell cache).
- **Deferred full hydration**: `hydrateOpenedWorkbook` (formats, data
  types, dims, protection, pictures, pivots, charts, SmartArt, page
  setup, breaks, header/footer, ink, theme) is scheduled from the first
  `rows` chunk — the host seeds that chunk (stamping first-values)
  *before* the App callback runs — via `requestAnimationFrame` +
  `setTimeout 0`, so it fires after the first-page mark and the values
  render, still seconds before `built` on big files (progressive view
  preserved: overlays/formats fill in right behind first paint).
  It hydrates from the **latest** accumulation at fire time (so it
  includes sheet-1 formats that arrived with the first chunks — strictly
  more than the old meta-time hydrate had). Guarded by an open-generation
  counter (`remoteOpenSeqRef`) and a `streamSettled` flag: the terminal
  path (and the failure path) cancel it, and the terminal hydration with
  the complete payload still runs authoritatively, exactly as before.
  Hydration result is therefore identical; only its timing moved.
  Mutation/save gating is untouched (`workbookLoaded` still flips only
  at the terminal chunk; protection state is terminal-hydrated before
  un-gating, as today).
- First scheduling attempt (defer from *meta* via rAF) put the hydrate
  back inside the meta→rows window and was corrected to the rows-chunk
  trigger above; both variants were measured (batches 1 and 2 below) —
  no significant difference under this VM's contention, but the
  rows-trigger is strictly safer scheduling and is what ships.

### `apps/web/src/services/engineTransport.ts` — `mergeLoadChunks`
- **Append fast path**: per-sheet stream chunks arrive in row order and
  are disjoint; when a chunk starts strictly after the accumulated tail,
  accumulation is now `[...prior, ...conv]` instead of rebuilding the
  full `"row:col"` Map (O(total) string keys per chunk). Overlapping or
  out-of-order chunks keep the exact dedupe-by-ref merge.

Not changed: `remoteEngine.ts`, `firstPagePerf.ts` (mark semantics
unchanged — the painted mark still fires on the host tick after first
values; if anything it is now *closer* to the real paint because the
delivery task that precedes it is short), engine, gateway.

## 3. Re-measurement (all runs, settled method)

### P95 TTFP (target ≤ 3.0 s)
Before (§7 finisher, same method): **2.95 / 3.10 / 3.71 → median 3.10 s**.

After, batch 1: **2.45 / 3.12 / 2.73** (walls 55.4 / 48.3 / 47.8 s)
After, batch 2: **3.22 / 3.21 / 2.67** (walls 50.0 / 47.3 / 47.1 s)
After, post-VM-restart confirmation: **3.15 / 2.28** (walls 65.3 / 44.5 s)

Pooled (8 runs): sorted 2.28, 2.45, 2.67, 2.73, 3.12, 3.15, 3.21, 3.22 →
**median 2.93 s ✅**. Variance is contention: during batch 2 the VM load
average was 3.1–3.3 on 2 cores (other stack tenants); the tour run on a
fresh idle engine recorded TTFP **1.72 s** (see §4), showing the client's
own remaining share when the server is uncontended.

After-split (typical, ms from `fileSelectedAt`): selected→request
~200 (unchanged, FileReader base64 + stringify); request→headers
1,354–2,097 (was 2,773–2,821 in the same-session before-runs — the Blob
body closed the browser-vs-Node gap; the leg now sits at the Node floor:
~0.3 s upload/gateway/engine-body + ~1.14 s server unzip + meta);
headers→first-values 652–1,558 (server meta→first-rows emission is
~0.67 s by the engine's own `elapsedMs`; the rest is shared-core
contention — the client's own processing of the first chunk measures
1–7 ms of reader gap and 0.4 ms of JSON parse).

### P50 / P75 TTFP (must not regress: §7 = 0.34 / 0.35 s)
- P50 after: **383 / 300 / 305 ms → median 305 ms ✅** (walls 1.92 / 1.73 /
  1.73 s, vs §7 wall 3.73 s). Post-restart confirmation: 344 ms.
- P75 after: **331 / 348 / 455 ms → median 348 ms ✅** (walls 2.23 / 1.87 /
  2.26 s, vs §7 wall 5.45 s).

### P95 fully-loaded wall (must not regress materially vs 49.9 s)
Settled batches: 55.4 / 48.3 / 47.8 / 50.0 / 47.3 / 47.1 s → **median
≈ 47.8 s ✅** (tour-measured wall on the final build: 47.5 s).

## 4. End-to-end validation on the final build (tours, screenshots inspected)

- **P75 tour** (`tour.mjs`, shots in `w15-shots/w15b-p75-*`): all 13
  sheets visited, **0 formula-error cells on every sheet**, charts on the
  Dashboard render in-frame (Earnings / Cash Flow / YoY Revenue Growth /
  COGS % of Revenue — screenshot read and verified), **save/download OK
  in 1.78 s** (server-side download path, the exact flow the deferred
  hydrate could have threatened — it did not).
- **P95 tour** (shots in `w15-shots/w15-p95-*`): TTFP 1.72 s on the fresh
  engine, wall 47.5 s, Sales/Inventory/Ledger all render real values
  with **0 error cells**; loaded screenshot verified — Sales row 2
  LineTotal 78,250.4…, percentages formatted (3.07% / 15.16%…), status
  bar Ready/✓ Saved. Heap after load 452 MB.
- **P95 save could not be re-validated this session — host capacity, not
  a code failure.** Twice, the engine process was kernel-killed with a
  P95 workbook resident (7.9 GB VM; §7 defect 5 documents this ceiling),
  and a third attempt was cut short when **the VM itself restarted**
  under the load (uptime reset to 0; the whole stack was restored from
  `hidden_files/start-stack-finisher.sh` and is left running, all ports
  200). The save code path (gatewayClient download method, App save
  flow, engine `/download`) is **untouched by this task's diff**, was
  validated end-to-end at P95 in §7, and its P75 instance re-validated
  OK above on the final build.

## 5. Suites

- Web full suite: **1579/1579 tests, 122/122 files** (`npx vitest run`
  in `apps/web`), `tsc --noEmit` clean.
- Related suites (subset of the above, run separately first):
  remoteEngine 8, routedEdit 18, bulkReads 5, saveInterlock 10,
  localMirror 6, io, desktopOpenFormats 2 — **67/67 green**. The stream
  consumption test (real `/load/stream` schema: meta → rows → data-done
  → built) passes against the time-sliced Blob-body client.
- No engine/gateway code changed, so no engine/gateway suites were
  re-run for this task.

## Appendix — excluded contaminated runs (reported for honesty)

- Old build, back-to-back first-page cuts (next run vs previous build):
  3.63 / 4.32 s (used only for the §1 decomposition).
- New build, same contaminated method (first batch): 2.29 / 3.93 /
  4.45 s — demonstrates the contamination effect; superseded by the
  settled batches above.
- One old-build run under the CDP CPU profiler: 8.07 s (profiler
  overhead; used for attribution only).

## Remaining floor (for the coordinator)

Client-side TTFP is now at the transport floor of this topology on this
VM: ~0.2 s encode+stringify, ~1.5–2.0 s request→meta (gateway body
buffer + engine JSON/base64 decode + 1.14 s unzip), ~0.7 s meta→first
rows (single parse worker), plus contention. Further material cuts are
server/wire-side, not client: e.g. a raw-octet upload for `/load/stream`
(skips base64 inflation + two 17 MB JSON parses), or earlier meta flush
before unzip completes. Not attempted — out of this task's client-side
scope.
