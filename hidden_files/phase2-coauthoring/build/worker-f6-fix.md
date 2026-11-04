# Phase 2 F6 follow-up fix — worker report

Worker (F6 fix), 2026-10-21. Scope: Worker C's F6 — `App.tsx` `handleNew`
(File → New, gateway mode) reset via the LEGACY transport first (minting a
fresh anonymous session via `/api/engine/access` and resetting that),
stranding the new file's gateway/engine claim (409, one process = one live
session for a different file). Fix: release/claim-then-reset ON THE CLAIMED
session, mirroring Fix 1's direct-load pattern (§9 step 4) and
`openRemoteBuffer`'s file-switch logic. NOT pushed (per tasking).

## Files changed (5)

### 1. `apps/web/src/services/collabTransport.ts` — `resetDirect()` added

Immediately after `loadXlsxDirect`, before `loadXlsxProgressiveDirect`,
with a doc comment in the fix-pass style (direct reset on the claimed
session with the handshake token, §9 pattern mirroring `loadXlsxDirect`;
the legacy transport reset must NOT serve a handshake-opened session
because it mints a fresh anonymous session and resets that instead,
stranding the new file's claim — Worker C's F6). Exact new code:

```ts
  async resetDirect(): Promise<void> {
    const res = await this.fetchOpenedWithRefresh('/reset', { method: 'POST' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`engine ${res.status}: reset failed: ${text.slice(0, 200)}`);
    }
  }
```

No body — it rides the existing private `fetchOpenedWithRefresh` helper
(one 401 → gateway re-lookup + one retry); the engine's `/reset` scopes by
token (adopts `accessClaims.sid`, binds `state.fileId` from
`accessClaims.fid`).

### 2. `apps/web/src/services/remoteEngine.ts` — `resetRemoteAsync()` prefers collab direct reset

Everything else in the method unchanged (`sheetNameCache=['Sheet1']`,
mirror null, `markSessionBound`, `emitRemote reset`). Exact new block:

```ts
      // Phase 2 (§9 step 4): a session the join handshake opened resets
      // DIRECTLY on the owner engine with the handshake token via the
      // collab transport — never through the legacy transport reset
      // (it mints a fresh anonymous session and resets that instead,
      // stranding the claimed session: Worker C's F6). The legacy
      // reset serves only sessions no handshake opened.
      const collab = this.collabTransport;
      if (collab && collab.sessionId) {
        await collab.resetDirect();
      } else {
        await this.transport.reset();
      }
```

### 3. `apps/web/src/App.tsx` — `handleNew` gateway branch reordered to claim-then-reset

`setWorkbookLoaded(false)` → release/disconnect the previous session
(creator releases via `releaseOpenedSession('superseded-by-new-workbook')`,
joiner disconnects locally only; `setCollabFile(null)`, `releasedPrev=true`)
→ `transport.connect()` mint for the NEW file → on mint failure with a
released previous session, re-join it by id and throw
`'Could not open a session for the new workbook — the current workbook is unchanged.'`
(surfaced by the existing outer catch via `setLastError` +
`setWorkbookLoaded(true)`); on mint failure with NO previous session, the
Phase 1 warn-and-continue posture is kept → `await remote.resetRemoteAsync()`
(now landing on the claimed session) → existing
`notifyHostReplaced()` / `setReadOnly(false)` / `setSaveState('saved')` /
page-setup clears / `setWorkbookLoaded(true)` unchanged. Comments added in
the surrounding style covering: claim-then-reset (F6), the creator-releases /
joiner-never-tears-down switch rule, abort-on-mint-failure mirroring
`openRemoteBuffer`'s narrowed rule, and no-previous-session warn-and-continue.

### 4. `apps/web/src/services/collabTransport.test.ts` — +2 tests

Inside `describe 'direct load + claim hygiene (Phase 2 fix)'`, reusing
`recordingFetch` + `makeTransport` + `connectAndHello`:

- `'resetDirect posts to the owner engine /reset with the handshake token'` —
  exactly 1 call: `http://engine-1/reset`, `POST`, `Bearer tok-1`.
- `'resetDirect refreshes the handshake token once on a 401 and retries'` —
  first `/reset` → 401 fake, second → ok; `gw.gateway.openFile` called 2
  times total; retry went to `http://engine-2/reset` with `Bearer tok-2`.

### 5. `apps/web/src/services/remoteEngine.test.ts` — +2 tests (+1 one-token fix, see Conflict)

Inside `describe 'RemoteEngineHost — Phase 2 fix: read gate, direct collab load, failure breaker'`:

- `'resets through the collab transport DIRECTLY once a handshake session is opened (never the legacy transport reset)'` —
  legacy `transport.reset` NOT called; a fetch to `http://engine-1/reset`
  happened; `h.isSessionBound === true`.
- `'resetRemoteAsync falls back to the legacy transport reset when no handshake session is opened'` —
  `transport.reset` called once.

## Validation (observed, this run)

From `~/workspace/icecream-sheets/apps/web`:

- `npx tsc --noEmit` — **exit 0, no errors** (run twice: after the
  production changes, and again after all test edits).
- `npx vitest run src/services/collabTransport.test.ts src/services/remoteEngine.test.ts` —
  **exit 0: Test Files 2 passed (2); Tests 36 passed (36)**
  (collabTransport 19 tests, remoteEngine 17 tests), duration 6.90 s.
- Filtered spot-runs beforehand also passed: remoteEngine `-t "reset"`
  (3 passed | 14 skipped — both new tests + the W16 terminal-reset test).

## Conflict found (important — read this)

**The prescribed full vitest run initially could not complete at all:
every full-file run of `remoteEngine.test.ts` spun a worker at ~80–95 %
CPU indefinitely** (three runs killed by timeout/SIGTERM, including the
coordinator's own `--no-file-parallelism` diagnostic run; in verbose order
the stall sits after the fix-pass tests that precede it in the file).
Bisecting test-by-test pinpointed the fix pass's OWN test
`'loads through the collab transport DIRECTLY once a handshake session is opened'`
(pre-existing, not one of mine): its `/load/stream` fake reader is

```ts
let i = 0;
read: async () => i < 1 ? { done: false, value: bytes } : { done: true, value: undefined },
```

`i` is never incremented, so `read()` returns the same NDJSON bytes
forever and `loadXlsxProgressiveDirect`'s reader loop never sees `done` —
an infinite loop in the test fake, NOT in production code (the sibling
fake in `collabTransport.test.ts` increments correctly: `chunks[i++]`).
This test was written during the freeze fix pass and, per fix-report.md,
was never run before.

**Minimal correction applied** (one token, in the same file/describe I was
tasked to extend; flagged here rather than silent): `i < 1` → `i++ < 1`,
so the reader yields the bytes once then reports done, exactly as the
fake's shape intends. After this correction the full prescribed run
passes 36/36 in 6.90 s (above). No production code was changed for this.
If the coordinator prefers to own this fix, it is a single-token revert/
reapply at the `/load/stream` fake reader in
`remoteEngine.test.ts` (direct-load test).

No other fallout from my changes: all 15 pre-existing remoteEngine tests
and all 17 pre-existing collabTransport tests pass unchanged.

## Not done / notes

- No git push (per tasking).
- Working tree carries extensive unrelated modifications from parallel
  workers/coordinators; my changes are confined to the 5 files above.
