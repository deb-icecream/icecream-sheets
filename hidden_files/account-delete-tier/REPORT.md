# Account deletion leaves tier record behind — fix report

Task dispatched 2026-10-22. Defect source: triggers program full gateway suite run (hidden_files/triggers/REPORT.md, final correction section): tests/userSettings.test.ts DELETE /api/account case fails — a tier record for the deleted user survives account deletion.

## Step log
- [x] 1. Reproduce (isolated test file run)
- [x] 2. Root-cause in code
- [x] 3. Fix at proven layer
- [x] 4. Validate (isolated ✓ 14/14 + tsc ✓ clean; full gateway suite ✓ — see final)
- [x] 5. Final report

## Findings

### 1. Reproduction — FAILS IN ISOLATION (not ordering/shared-state)
`npx vitest run tests/userSettings.test.ts` in packages/gateway: 13 passed, 1 failed —
`DELETE /api/account > deletes settings, tier, files + bytes, shares; releases own leases; spares others`
at tests/userSettings.test.ts:411: `expect(await r0.tiers.getRecord('ada')).toBeNull()` received
`{ userId: 'ada', tier: 'default', createdAt: 1792687174507, updatedAt: 1792687174507 }`.
All assertions before it pass, including `deleted['tierRecord'] === true` (line 402) — the
delete DID remove the seeded 'pro' record from the SAME store instance the route holds.
The surviving record is a FRESH 'default' record (createdAt === updatedAt), i.e. it was
re-created after the delete, by an assertion-intervening request.

### 2. Root cause — enforcement read performs a get-or-create write
- The DELETE route is correct: src/gateway.ts:1778-1779 awaits
  `userSettingsStore.remove(userId)` and `userTierStore.deleteRecord(userId)` on the
  injected store; all three adapters implement deleteRecord (userStore.ts:284/388/489)
  and it works (line 402 proves it).
- Between the DELETE and the read-back, the test issues `GET /api/files/file-ada-1`
  with Ada's still-valid JWT (expects 404).
- EVERY `/api/files*` request runs src/gateway.ts:1139 `const tier = await tierForPrincipal(principal)`
  BEFORE any routing/ownership check. tierForPrincipal (gateway.ts:486-489) delegates to
  resolveTierFor → `userTierStore.resolveTier({ userId })`.
- `resolveTier` is GET-OR-CREATE in all adapters (e.g. MemoryUserTierStore,
  userStore.ts:225-259): no record → INSERT `{ tier: 'default', createdAt: now, updatedAt: now }`.
  That is the correct semantics for the login exchange (its only other callers are
  /auth/login gateway.ts:583 and /auth/firebase gateway.ts:638, both resolveTierFor
  directly) — but on an enforcement read it resurrects a just-deleted record.
- Production meaning: any authenticated /api/files request by a deleted user (JWT
  valid until expiry) re-creates their tier record. Violates the settings brief's
  "delete the tier record / re-register = fresh account" contract at the record level.

### 3. Fix layer (decided)
gateway.ts `tierForPrincipal`: use a NON-CREATING read — `userTierStore.getRecord(userId)`
(pure read in all three adapters: userStore.ts:252/345/414), tier = record?.tier ?? 'default',
'default' on no-store/error (same fail-soft posture as resolveTierFor). Nothing else changes:
login exchanges still create records via resolveTier (record exists before any files
request can be authenticated); mid-session promotions still apply because the record is
read live; tierForPrincipal passes no email, so resolveTier's email-sync and
pending-promotion branches never fired on this path anyway — the only lost behavior is
the record-creation side effect, which is the defect.

Wiring check (test vs production): identical posture. The test injects one
MemoryUserTierStore into createGateway and reads the same instance back;
production bin/gateway.ts:142 passes `createUserTierStore(process.env)` —
one shared instance; the route's deleteRecord call on it is awaited
(gateway.ts:1779). Neither wiring nor the adapters were at fault.

### Fix applied
src/gateway.ts `tierForPrincipal` (was lines 485-489): no longer delegates to
resolveTierFor/resolveTier. Now a non-creating read —
`userTierStore.getRecord(userId)` → `rec?.tier ?? 'default'`, 'default' when
no store is wired or the read throws (same fail-soft posture as before).
Comment at the site records the resurrection mechanism.

### Validation so far
- Isolated: `npx vitest run tests/userSettings.test.ts` → 14/14 PASS (was 13/14).
- `npx tsc --noEmit -p tsconfig.json` in packages/gateway → clean (exit 0).
- Full gateway suite: 41/42 files passed, **413/414 tests passed**. The ONE failure is
  `tests/services.test.ts > agent service > human-in-the-loop over HTTP: /pending → /answer
  unblocks the parked turn` (asks length 14 vs 1 + 10 s hook timeout) — the pre-existing
  agent HITL timeout the triggers report documented for the other track. It is in the
  agent service path, untouched by this fix (which only changes tierForPrincipal on the
  /api/files path), and is recorded here as that known failure, NOT chased.
  userSettings.test.ts passes within the full suite as well.

## FINAL
- Reproduction: failed in isolation (deterministic, not ordering): 13/14, failing
  assertion tests/userSettings.test.ts:411 — fresh 'default' tier record present after
  DELETE /api/account despite `deleted.tierRecord === true`.
- Root cause: gateway.ts:1139 runs tierForPrincipal on every /api/files* request;
  tierForPrincipal delegated to resolveTier, whose get-or-create semantics (correct for
  the /auth login exchanges) re-created the deleted record. Route, adapters, and wiring
  (test and production identical) were all correct.
- Fix: src/gateway.ts tierForPrincipal now reads via getRecord (pure read in all
  adapters); no record → 'default', nothing persisted. One function changed.
- After: isolated userSettings 14/14; full gateway suite 413/414 (sole failure =
  pre-existing services.test.ts agent HITL timeout, other track); gateway tsc clean.
