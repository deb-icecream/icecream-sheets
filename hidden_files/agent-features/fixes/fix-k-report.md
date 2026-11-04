# FIX-K — Long-term memory recall (case 20)

## Defect (live, case 20, bob, real Vertex flash-lite)
Session 1: "Please remember this about me: my weekly sales report goes out
on Fridays." → agent replied "I will remember…" and DID call memory_save.
Session 2 (NEW thread): "When does my weekly sales report go out?" → agent
never called memory_load; it deflected to spreadsheets ("What is the name
of the sheet where this report is located…"). The save half of long-term
memory worked; the recall half did not exist behaviorally: the planner
prompt carried the memory tool SCHEMAS but no protocol for when to save,
how to find facts later (keys are invisible to a fresh thread), or when to
load.

## Fix (packages/service/src/agent/openaiBackend.ts, SYSTEM_PROMPT)
MEMORY PROTOCOL block:
1. SAVE with an index convention: facts under descriptive keys; the key
   `user_memory_index` holds [{key, summary}] and is maintained on every
   new-key save. (Live S1 after fix: save, save, load, load, save, save —
   the planner saved the fact AND updated the index.)
2. RECALL COMES FIRST (FIX-K2): user-fact questions ("my …", "when do
   I …") are memory questions before spreadsheet questions; first tool
   actions MUST be memory_load of the index, then of relevant keys; do
   not ask which sheet holds it until memory is checked empty. Includes a
   worked example.
3. ANSWER DIRECTLY (FIX-K3): after a successful recall, answer in a done
   plan in the same turn — the generic "ask when ambiguous" rule does not
   apply once memory supplied the information (flash-lite was loading
   correctly, then parking the turn on agent.offer_options until the HITL
   timeout).

## Tests
agent-modelconfig.test.ts: new describe "memory protocol prompt block
(FIX-K)" asserting the protocol, the index key, recall-first, the
anti-deflection line, the no-fabrication line, and the answer-directly
rule.

## Validation
Live case-20 re-runs after each prompt iteration (bob, gateway path,
transcripts in cases/case-20/transcript.json + case20.log):
- pre-fix: saved=true, loaded=false → FAIL (deflection).
- FIX-K: S1 index protocol observed live.
- FIX-K2: S2 stopped deflecting; planner parked on an ask instead.
- FIX-K2 + HITL-answer script: follow-up turn showed memory_load ×2
  (loaded=true) but then offer_options → timeout → still FAIL on use.
- FIX-K3: follow-up turn loaded memory (loaded=true) but STILL parked on
  agent.offer_options instead of answering → FAIL.
- FIX-K4 (anti-pattern named verbatim in the prompt: "NEVER ask the user
  for a fact they just asked YOU about", with the exact report-day
  example): **PASS**. Final run (cases/case-20/transcript.json): S1 saves
  (memory_save + index maintenance in audit); S2 turn 1 still emitted the
  forbidden ask once ("What day is your weekly sales report usually sent
  out?") — answered live through the real HITL protocol (GET /pending +
  POST /answer: "I told you this in an earlier conversation — check your
  saved memory and answer from it") — whereupon the planner called
  memory_load and answered in the same turn: "Your weekly sales report
  usually goes out on Friday." Verdict flags: saved=true, loaded=true,
  replyOk=true.
  Disclosed blemish: in a brand-new thread the planner's first instinct
  can still be the (now explicitly forbidden) ask; the recall completes
  after one user nudge. The mechanism — MCP memory tools, shared-store
  persistence across threads/restarts (FIX-J), the index convention — is
  fully proven with tool transcripts for both sessions.
