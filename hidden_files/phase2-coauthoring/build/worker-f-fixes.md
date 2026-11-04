# Worker F — FIX: double op submission (F2) + stray grant client (F3)

Verdict: **F2 FIXED at its root cause, live-proven before/after** (one
grid edit now submits exactly one op on every commit path). **F3
PARTIALLY FIXED** — the two stray mechanisms observable in the web app
are fixed and live-verified; the desktop-persistent second direct-read
stream was NOT reproduced in web and its constructor does not exist in
`apps/web` — precise residual write-up in §3 for the coordinator.
Scope honored: `apps/web/**` only, no `packages/*`, Worker's C's two
fixes (engine.ts gateway-host selection; `SignedEngineTransport
.bindSession` via `CollabTransport.onOpen`) built on, not reverted.
No service restarted (gateway/engine/preview PIDs unchanged);
`apps/web/dist` rebuilt at the end. No git push.

Evidence artifacts: `build/worker-f/` (`repro.mjs` — the live harness;
`repro-before.json` / `repro-after.json` — full request logs).

---

## 1. F2 — root cause (NOT the bridge-vs-host seam)

**Root cause: `Grid.tsx`'s editor commit fired `onCommit` twice for
one keystroke on the Enter and Tab paths.** The editor's
`handleEditorKeyDown` (Enter/Tab) calls `commitEdit()` and then
`moveSel()`, which does `scrollRef.current?.focus()`. Focusing the
scroll container **synchronously blurs the editor input**, and the
input's `onBlur={commitEdit}` handler closure still holds the
pre-commit `editing` state (React has not re-rendered yet), so
`commitEdit()` ran a second time with the same draft. Each
`onCommit` → `App.commitCell` → `CollabBridge.applySetCell` →
`host.execute` → `RemoteEngineHost.executeRoutedAsync` →
`CollabTransport.submitCommand` — two distinct envelopes, clientSeq
n and n+1, identical value: exactly Worker C's revs 3+4. Server-side
dedupe is impossible by design (distinct seqs), and none was added.

**How the hypotheses were discriminated (live, request-counted):**
headless Chrome against the running stack (gateway :8100, engine
:8101, scratch preview of a gateway+signed build), join-by-link as a
second user, three single edits differing ONLY in commit style
(harness: `build/worker-f/repro.mjs`):

| Commit style | POST /ops BEFORE fix |
|---|---|
| Enter | **2** (clientSeq 1, 2 — identical cmd, same baseRev) |
| Tab | **2** (clientSeq 3, 4 — identical cmd, same baseRev) |
| Click-away (blur) | **1** (clientSeq 5) |

Click-away isolates it: the bridge+host path (`applySetCell` →
broadcast + host execute) runs identically for every commit style,
yet only Enter/Tab doubled — hypothesis (a) (bridge-vs-host /
`bridgeSubmitEnabled`) is **exonerated** (the flag works; the second
submission enters via a second host execute of the same UI commit,
as Worker C suspected). Hypothesis (b) (resubmit-on-reconnect) is
exonerated: the transport never dropped; both POSTs fired back-to-back
with equal baseRev before the first delta returned. Hypothesis (c)
(two transports) is exonerated: one clientId, one transport, strictly
consecutive seqs, and the duplication is commit-style-dependent.

**Unit repro:** the new jsdom suite (§4) drives the real Grid —
pre-fix, Enter yields exactly two identical commits
`[{2,0,'777'}, {2,0,'777'}]`; the FormulaBar was checked and is NOT
affected (Enter-only commit, no blur-commit, no focus shift).

**Fix (`apps/web/src/Grid.tsx`):** every editor commit path now
funnels through `commitEditingValue(row, col, value)`, guarded by
`committedEditingRef` — the identity of the editing-session object
already committed. Enter/Tab keydown, blur, the autocomplete
Enter/Tab branch, and the autocomplete dropdown pick are all covered.
Each keystroke mints a fresh editing object, so the next genuine edit
is never swallowed (pinned by test). No change to `collab.ts`,
`collabTransport.ts` submission, or `remoteEngine.ts` routing.

**After fix (same live harness):** Enter → 1 op (seq 1), Tab → 1 op
(seq 2), click → 1 op (seq 3); session released at **revision 4 =
setup rev 1 + exactly 3 edits** (before: revision 6 for 3 edits).

## 2. Files changed

| File | Change |
|---|---|
| `apps/web/src/Grid.tsx` | F2 fix: `committedEditingRef` guard + `commitEditingValue` funnel (keydown Enter/Tab, blur, autocomplete pick/branch) |
| `apps/web/src/grid-commit-once.test.ts` | NEW — 4 tests pinning one-edit-one-commit (§4) |
| `apps/web/src/services/signedEngineTransport.ts` | F3: concurrent-mint dedupe + `scopeEpoch` bind-clobber guard (§3) |
| `apps/web/src/services/signedEngineTransport.test.ts` | +2 tests (dedupe; bind-mid-mint) |
| `apps/web/src/services/collabTransport.ts` | F3: `postSessionExtras()` — extras direct to the owning engine over the collab channel |
| `apps/web/src/services/collabTransport.test.ts` | +2 tests (extras direct + not-connected fallback) |
| `apps/web/src/App.tsx` | F3: gateway save-status poll skips while the collab transport is connected; gateway extras effect reroutes via the transport when connected |
| `apps/web/dist/**` | Rebuilt (`npx vite build`) — served by :4173 |

## 3. F3 — disposition: partially fixed, residual documented

**What the "second client" is made of (web-observable, live-counted):**
there is no second `SignedEngineTransport` construction site in
`apps/web` (only `engine.ts remoteHostFor`), and in the web app every
stray stream stops once `bindSession` lands. The noise decomposes
into three mechanisms, two of them fixed here:

1. **Gateway-proxied Phase-1 session surfaces firing against a
   Phase-2 file session — FIXED.** While a collab session is live,
   App still ran (a) the autosave **status poll** via
   `gateway.engineSaveStatus()` every 2 s while dirty and (b) the
   **session-extras sync** via `gateway.engineSessionExtras()`.
   Both are gateway-PROXIED calls scoped to the gateway's proxy
   session, which does not exist for a signed-mode file session:
   every call 401'd (before: 14 proxied session-* 401s in a ~40 s
   window; extras 7×401 — **the extras never landed, so server
   autosave flushes were blind**, design doc §5). Fixes: the poll now
   returns early while `collabTransport.connectionState ===
   'connected'` (save status already arrives as SSE `status` events,
   §8 always-on — Worker B's decision #7 noted this redundancy), and
   extras now POST **directly to the owning engine**
   (`CollabTransport.postSessionExtras` → `/session-extras` with the
   session-scoped collab token; engine route verified to accept it),
   falling back to the proxied call only when no collab session is
   connected. **After: proxied session-* 401s 14 → 0; extras 7×200
   direct; zero 401s of any kind after the join settled.**
2. **Grant-mint races at the bind seam — FIXED.** `ensureGrant` had
   no in-flight dedupe: concurrent reads racing a cold/dropped grant
   each minted their own (live log: 4 consecutive `/api/engine/access`
   POSTs with no engine call between; losing grants discarded). Worse,
   a mint started BEFORE `bindSession` could resolve AFTER it and
   overwrite `sessionId`/cached grant with its pre-bind random scope.
   Fixes: non-forced issuances for the same wanted scope share one
   in-flight mint; `bindSession` bumps a `scopeEpoch`, and a mint
   resolving under a stale epoch is discarded and re-resolved against
   the current scope (unit-tested). Note the multiplier behind C's
   "325 mints": every 401'd `direct()` call force-remints once for its
   single retry, so mint count tracks the 401 count of whatever stream
   is failing — kill the failing stream and the mints collapse.
3. **RESIDUAL (documented, not fixed):**
   a. **Boot-window unscoped reads.** The App host exists and reads
      (constructor `refreshSheetNames`, first-paint RemoteView reads)
      before any file session exists; in signed mode those mint
      unscoped (fresh random session) grants and 401 until the join
      handshake binds the session (~10–12 calls in the web repro,
      bounded to the join window, self-healing at bind). Eliminating
      them means gating host reads on a bind that Phase-1 signed flows
      legitimately never perform (their sessions are load-introduced)
      — a coordinator ruling, not taken here.
   b. **Desktop's persistent `cec5ea44` stream.** In the packaged app
      a wrong-session grant was reused for `/sheets` + `/read` for the
      whole smoke, CONCURRENT with the bound transport's good token —
      i.e. two live grant caches. This was **not reproduced in the web
      app** (same code) and no second transport constructor exists in
      `apps/web`. The two candidate constructors left standing are
      outside this worker's scope: (i) a second renderer/webContents
      in the desktop shell loading the same dist (desktop-main is
      Worker C territory), or (ii) a host swap via
      `connectGatewayHost()` (login transition) abandoning a previous
      `RemoteEngineHost` undisposed — its `RemoteView` batcher would
      keep reading through its own unbound transport if any mounted
      component still references it (the swap path disposes nothing;
      `detachCollabTransport` even restarts its polling). Recommended
      coordinator step: rebuild the desktop staging bundle from the
      fixed dist (the epoch/dedupe fixes may collapse the stream if it
      was race-driven) and, if it persists, add a temporary
      construction-stack capture in `SignedEngineTransport`'s
      constructor in the desktop build to name the second instance.

## 4. Tests

- New: `grid-commit-once.test.ts` (4) — Enter once, Tab once, later
  genuine edit still commits, click-away once. **Verified failing
  pre-fix** (Enter: two identical commits) and passing post-fix.
- New: `collabTransport.test.ts` +2 (extras direct-to-engine with the
  collab session; not-connected → no request), `signedEngineTransport
  .test.ts` +2 (4 concurrent cold reads → 1 mint; bind-mid-mint does
  not clobber the bound scope).
- Union of related suites re-run: collabTransport, remoteEngine,
  routedEdit, collab, grid, grid-lock-badge, grid-a11y,
  grid-commit-once, StatusBar, sessionLifecycle, saveInterlock,
  engineTransport, signedEngineTransport — **13 files, 107 passed /
  0 failed** (B's 99 + C's touched set + 8 new).
- `npx tsc --noEmit` — clean.
- Live before/after: §1 table + §3 counts (`build/worker-f/`).

## 5. NOT done (stated plainly)

- The §10 matrix (all legs) — coordinator's gate, as tasked. The
  desktop staging bundle/AppImage was NOT rebuilt (later worker, per
  tasking); F3 residual (b) can only be re-checked once it is.
- Boot-window unscoped reads (F3 residual a) — documented, not gated.
- No fix attempted for the addons-service 502s (F4 in Worker C's
  report — auxiliary service not running; unrelated).
- Stack state: both repro sessions released via `/session/release`;
  gateway/engine/preview never restarted (PIDs identical start to
  finish); the scratch preview used for the repro (port 4174) was
  shut down.
