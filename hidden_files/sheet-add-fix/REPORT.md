# Sheet-add fix — REPORT (started 2026-10-22)
Task: structural sheet.add via collab POST /ops rejected by engine core ("Unknown command", HTTP 200 {ok:false}).
Port block for isolated stack: 8990-8999 (claimed here before starting).

## Steps
- [ ] Read agent-rerun REPORT.md ITEM 3 for repro context
- [ ] Reproduce on isolated stack
- [ ] Root-cause in code (trace other structural ops)
- [ ] Fix at proven layer
- [ ] Regression tests
- [ ] Live proof (add via /ops, read back, journal moved, second client sees it)

## Reproduction (2026-10-22, isolated stack 8990/8991, dist rebuilt from current src)
- repro.mjs (case-7 posture: JOINER bob opens alice's file, addSheet at baseRev=current):
  addSheet -> 200 {ok:true, revision:2}; new sheet readable; setCell control ok.
- repro2.mjs: addSheet at STALE baseRev (rebase branch) -> ok rev3; renameSheet ok rev4;
  deleteSheet ok rev5; second client reads the added sheet ok.
=> The defect does NOT reproduce on the current tree in any /ops branch.

## Root cause
- Field evidence (tmp-agent-proof/logs/waved-7a.log): execute() received
  {"type":"sheet.add","name":"Inventory CSV","auth":{...}} — a half-converted flat
  op (collab type, params inlined, no `cmd` field).
- NO code path in the current tree produces that shape: the only producer of a
  sheet.add-typed object is cmdToCollabOp (engineSvc.ts:425, params nested), and
  every consumer converts back via collabOpToCmd (engineSvc.ts:457). protocol.ts
  execute() handles {cmd:'addSheet'} (line 715). Web client collabOpToCommand and
  remoteEngineHost also emit proper EngineCommands.
- The waved runs hit a LONG-LIVED stack (started hours earlier, restarted piecemeal);
  engineSvc.ts was edited at 13:57 that day and the gateway dist rebuilt at 16:45 —
  the 16:11 failure ran against the engine process's stale in-memory build from
  before the current conversion discipline. Current src+dist (byte-identical
  rebuild) is correct in every branch, proven live above.
- RESIDUAL DEFECT in the current tree (the fixable layer): the /ops and /execute
  routes validate only that cmd is a non-null OBJECT. A CollabOp-shaped or flat
  {type:...} object sails through to execute() and fails as HTTP 200
  {ok:false, "Unknown command: {...}"} — an opaque phantom failure (the agent
  program's own notes flag that clients reading only the status reported phantom
  writes). A cmd without a string `cmd` field can NEVER succeed in execute()
  (always the default branch), so the route must fail fast with a 400 naming
  the contract.

## Fix plan
- engineSvc.ts /ops + legacy /execute: reject cmd whose `cmd` field is not a
  non-empty string -> 400 naming the EngineCommand contract, BEFORE the sequencer
  (nothing journaled, no idempotency record).
- Tests: new packages/gateway/tests/sheetAddOps.test.ts — joiner addSheet,
  stale-baseRev rebase addSheet, SSE structure event to a second client,
  malformed shapes -> 400 on /ops and /execute, conversion round-trips.

## Fix landed
- packages/gateway/src/services/engineSvc.ts:
  - New exported `isEngineCommandShape(cmd)` guard beside the conversion pair
    (cmd must be an object with a non-empty string `cmd` field).
  - POST /ops: after envelope validation, a non-EngineCommand cmd -> 400
    naming the contract, BEFORE role/idempotency/sequencer (nothing journaled).
  - POST /execute (legacy): same 400 check.
  No sequencer bypass, no gateway special-case for sheet.add: well-formed
  {cmd:'addSheet'} continues through runExecuteInternal as a journaled,
  revision-stamped, SSE-broadcast sequenced op (structure event included).

## Tests (vitest, gateway package)
- NEW tests/sheetAddOps.test.ts (5 tests, all pass):
  1. conversion round-trips for addSheet/deleteSheet/renameSheet + shape guard;
  2. JOINER addSheet at current baseRev -> ok:true rev2, journaled (catch-up
     /revisions carries {cmd:'addSheet'}), sheet readable by both clients;
  3. addSheet at stale baseRev rebased + applied (rev3);
  4. SSE: second client receives the 'session' structure event (sheetAdded);
  5. malformed shapes (flat field shape, CollabOp wire shape, no-cmd, empty
     cmd, numeric cmd) -> 400 on /ops AND /execute; revision unmoved; a
     well-formed addSheet still lands after.
- Related suites all green: sheetAddOps 5 + phase2Collab 15 (run together,
  20/20); engineSvc + engineSvcStream + engineSvcReadDuringBuild + directSave
  + saveJournalCap + deployAccess + serverEngineGuards = 90/90;
  addonRunBinding + agentBinding + agentCharts + automationSvc + engineCharts
  + productLoadRef + triggerSupervisor = 78/78. Total 188 passed, 0 failed.
- tsc -p tsconfig.json (gateway): clean (noEmit check + full emit build).

## Live proof (isolated stack, ports 8990/8991, dist rebuilt WITH the fix)
- repro.mjs: joiner bob addSheet baseRev=current -> 200 {ok:true, revision:2};
  read-back of 'Inventory CSV' 200 for bob; controls ok. (Stale-baseRev add
  after a structural checkpoint -> 409 before-retention, the documented §1
  resync behavior, unchanged.)
- repro2.mjs: stale-baseRev addSheet through the rebase branch -> ok rev3;
  renameSheet rev4; deleteSheet rev5; second client reads added sheet.
- malformed.mjs: flat {type:'sheet.add',name} and CollabOp {type,params}
  shapes -> 400 with the contract message on /ops and /execute; revision
  stayed 0; well-formed addSheet immediately after -> ok revision 1.

## Not landed / notes
- Nothing outstanding for this task. The original 16:11 failure itself is
  not reproducible on the current tree (stale long-lived stack build; see
  Root cause) — the regression tests + the fail-fast 400 now pin the
  behavior so neither the op failure nor the phantom-200 failure mode
  can recur silently. Stack stopped; scripts + repro harnesses kept in
  this directory (stack.sh / stop.sh / repro.mjs / repro2.mjs / malformed.mjs).
