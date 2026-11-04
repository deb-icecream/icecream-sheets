# Security Highs fix program — checkpoint record

Started: 2026-10-22 (worker session 9555daa2)
Port block claimed (if a stack is needed): 9050-9059
Scope: F-5, F-9, F-10, F-17 from hidden_files/security-pass/REPORT.md.
Constraints: do NOT push; do NOT wire FILE_REGISTRY_STORE=prod anywhere.

## Status log
- [x] F-5 — Firestore registry claim transactional (fileRegistry.ts) — DONE
- [x] F-9 — viewer-role gate on every mutating engine route (engineSvc.ts) — DONE
- [x] F-10 — MCP caller-asserted principal must match/narrow session identity (mcp-server server.ts + agent runtime.ts) — DONE
- [x] F-17 — SheetJS 0.18.5 CVEs off the server parse path (upgrade >=0.20.2 via CDN tarball OR finish fastSheetParse migration) — DONE (upgrade route)

## Findings log
(checkpoint entries appended as work lands)

### Final suite tallies (2026-10-22, this worker)

- xlsx-adapter: tsc build clean; suite 33 files / 372 tests PASS.
- gateway: tsc clean; suite 462 passed / 1 failed — the failure is
  services.test.ts "human-in-the-loop over HTTP" (expected 1 pending
  ask, saw 24): PRE-EXISTING cross-run pollution of the shared
  file-backed pending-ask store on this VM (the recorded pre-existing
  failure for this test). Proven not-F-10: the same test passes in
  381 ms with a fresh ICECREAM_DATA_DIR under the fixed code.
- mcp-server: tsc clean; suite 178 passed / 3 failed on first full
  run. Of the 3: http.test.ts "explicit principal arg override"
  pinned the F-10 vulnerability itself — updated to the new contract
  (refusal + zero writes in the authorizer audit log) and re-run
  10/10 green. packs-registry.test.ts ×2 (tool-count 55 vs 53,
  48 vs 46) are PRE-EXISTING: A/B-verified by restoring the pre-F-10
  principalOf — identical failures; the count drift comes from tools
  added by parallel work, not this fix (this fix adds zero tools).
- service: tsc clean; suite 1636 passed / 1 skipped / 0 failed.

Nothing pushed. FILE_REGISTRY_STORE=prod not wired anywhere.

### F-5 — Firestore registry transactions (DONE)

Fix: `FirestoreLike` gains `runTransaction<T>(fn)` + a
`FirestoreTxnLike` surface ({ get(ref), set(ref, data, opts?) }) in
sessionStore.ts; `wrapFirestore` implements it over the real client's
runTransaction (doc refs pass through by identity, so refs work
directly). `FirestoreFileRegistry.claim/heartbeat/release/
noteParticipant` now each run read→fence-check→write inside ONE
transaction; the claim's old post-write re-read is gone (the
transaction IS the atomicity). FILE_REGISTRY_STORE remains unwired
everywhere (per instructions) — this fixes the adapter the prod
wiring will use.

Fakes: the five FirestoreLike test fakes (firestoreProdAdapters,
userSettings, builtApps, userStoreProd, deployAccess) gained a
serializing runTransaction (async-mutex chain, buffered writes commit
on callback success, refs keyed via WeakMap) — matching Firestore's
conflict-serialization semantics.

Tests: new `packages/gateway/tests/firestoreRegistryTxn.test.ts`
(5 tests) over a YIELDING fake (setImmediate in doc get/set so
unsynchronized interleavings are real): two concurrent first-claims →
exactly one owner and the stored record is the winner's; stale owner's
release after an epoch takeover → false and the current owner's
leaseExpiry byte-identical, current owner heartbeat/release still
work; concurrent takeover claims on one expected epoch → exactly one
wins; heartbeat fenced by session+epoch inside the transaction;
concurrent noteParticipant keeps both entries. Honest note: the fake
models Firestore's serialization guarantee — it pins the fixed
contract rather than deterministically reproducing the old
latency-dependent race. Suites: firestoreRegistryTxn 5/5,
firestoreProdAdapters + fileRegistry 17/17, deployAccess +
userSettings + builtApps + userStoreProd 53/53; gateway tsc clean.

### F-10 — MCP principal authority (DONE)

Identity model (interpretation of the brief's "narrow or match",
recorded per instructions): a deliberately BOUND identity
(ServerOptions.defaultPrincipal, set only from a VERIFIED identity)
is authoritative — a tool-arg principal may never substitute for it,
not even a "narrower" one, because the MCP layer has no principal
hierarchy to prove narrowing against; absent arg → bound identity,
matching arg → accepted, mismatching arg → thrown refusal
("principal mismatch: … the verified session identity is
authoritative"), which surfaces as an isError tool result with no
data returned. Skill packs resolve through the same principalOf
(PackContext.authOf), so all ~37 call sites + packs are covered by
the one change.

Changes:
- mcp-server/src/server.ts: principalOf enforces the model; new
  ServerOptions.allowPrincipalAssertion (trusted local embeddings
  only); defaultPrincipal doc rewritten; the analysis intent port now
  uses boundPrincipal ?? MCP_PRINCIPAL.
- mcp-server/src/http.ts: sessions created from a VERIFIED token bind
  with assertion OFF; anonymous local-dev sessions (requireAuth=false)
  pass allowPrincipalAssertion — local process = trust boundary.
  Header trust-boundary doc updated.
- gateway/src/services/agentSvc.ts: the no-session createServer
  branch now also binds defaultPrincipal: principal (the session
  branch already did).
- service/src/agent/runtime.ts: stampUser (the single funnel for both
  the public callTool and planner executeTools) neutralizes any
  foreign `principal` argument to the runtime's own identity —
  planner-emitted args can no longer widen the agent's authority;
  the runtime's deliberate agent.* HITL stamps already matched.

Tests: new packages/mcp-server/tests/principalBinding.test.ts (6):
bound session + spoofed 'owner' arg → refused, hidden cell NOT read;
spoofed write refused + cell unchanged; absent arg → bound identity
(#PERM! on the hidden cell, public cell readable); matching arg →
accepted; unbound server keeps legacy assertion (stdio posture);
allowPrincipalAssertion hatch works. Existing principals.test.ts
(5 tests, unbound posture) still green. New
packages/service/tests/agent-principal-binding.test.ts (1): a scripted
planner emitting principal 'mallory' against an agentSvc-style bound
server executes successfully AS the runtime user (value returned,
no mismatch refusal) — agent path unaffected, spoof neutralized.
mcp-server, service, gateway tsc all clean.

### F-9 — viewer gate on all mutating engine routes (DONE)

Census of engineSvc.ts POST routes. ALREADY gated before this fix:
`/charts`, `/execute`, `/ops`. NEWLY GATED (identical guard block:
`const role = accessClaims?.role ?? state.participants.get(principal) ?? 'editor'`
→ 403 `{ ok:false, rejected:true, reason:'viewer-role' }`):
`/session-bind-library`, `/session-extras`, `/session/release`,
`/load`, `/load/storage-ref`, `/load/stream`, `/language`,
`/library-save`, `/reset`, `/protection/hide`, `/protection/protect`.
Placement mirrors `/charts` (after the session-active check where one
exists); `/load*` gates sit after the signed-mode wrong-session check
and before any load begins (`/load/stream`: before the stream head).

Deliberately NOT gated, with reasons:
- `/session/claim`, `/session/heartbeat` — session join/keepalive
  protocol, not workbook mutations; the claimer's role comes from the
  signed token and viewers must be able to join (§10 matrix has viewer
  participants). Heartbeat guards the OWNER's lease and is
  sessionId-checked.
- `/session/rehydrate` — load-family, but it carries its own deliberate
  Phase 2 participant/session check and restores the checkpointed
  session (the design's recovery path), not a caller-content write.
- `/presence`, `/presence/leave` — ephemeral presence only (never
  persisted, journaled, or revisioned by design); viewers legitimately
  appear in presence.
- `/deltas/ack` — advances only the CALLER's own consumption
  watermark; cannot touch shared state.
- `/download` (GET|POST) — a read (bytes out), permission-filtered per
  cell/layer exactly like `/read`; persists nothing.
- Pure reads stay open to viewers by design: `/read`, `/snapshot`,
  `/sheets`, `/revisions`, GET `/deltas`, `/events`, `/session/status`,
  `/session-save-status`, GET `/library`, `/health`.

Tests: `packages/gateway/tests/viewerRoleGates.test.ts` (new, 3 tests):
viewer token → 403 viewer-role on ALL 11 newly gated routes (release
attempt carries a valid sessionId so role is the only refusal reason);
side-effect pins (session still active, workbook content unchanged
after viewer /load with a 999 marker); viewer read surface intact
(/read, /sheets, /session/status 200); editor happy path on the same
routes 200. Gateway tsc clean. Result: 3/3 pass.

### F-17 — SheetJS CVEs (DONE, upgrade route)

Choice: UPGRADE (option a). Rationale: SheetJS is not a mere fallback —
`XLSX.read` sits in the adapter's main load path (adapter.ts:321) and
the in-house fast parser depends on the SheetJS SSF table
(numfmt.ts:19). The migration route could not be proven without
replacing both; the upgrade is direct and verifiable.

Change: `packages/xlsx-adapter/package.json` dep `xlsx: ^0.18.5` →
`https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz`; `npm install`
rewrote `package-lock.json` (node_modules/xlsx 0.20.2, resolved=CDN
URL, integrity sha512-+nKZ39…FXZA== — matches the tarball's computed
sha512) and removed the 7 now-bundled 0.18.5 sub-deps. Fixes
CVE-2023-30533 (prototype pollution, fixed 0.19.3) and CVE-2024-22363
(ReDoS, fixed 0.20.2). No stray imports of the removed sub-dep
packages anywhere in src trees; `XLSX.SSF` still exported.

Evidence: xlsx-adapter build (tsc) clean; full adapter suite
33 files / 372 tests PASS; real-file tour
(`~/workspace/tmp-sec-highs/f17-tour.mjs`): formulas-sample.xlsx
(8 sheets), gold/functions.xlsx (13 sheets, 452 cells), real-world
bxl3way (13 sheets, 2957 cells), ExternalLinks, PivotTable-AllSources
— all parse; a workbook with a sheet named `__proto__` parses with
Object.prototype unpolluted.
