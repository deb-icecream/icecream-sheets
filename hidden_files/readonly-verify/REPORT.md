# Read-Only Enforcement Verification (issue #51)

Governing doc: design-docs/read-only-enforcement.md
Ports claimed: 9160-9169 (this run's local production-topology stack)
Started: 2026-10-23 (worker session)
TMPDIR: ~/workspace/tmp-readonly-verify

## Checkpoint log
- [start] Record created; ports 9160-9169 claimed. Next: read design doc + F-9 fix record + current engine/gateway route gates.

## Findings / holes
- (none yet)

## Acceptance matrix results (doc section 3)
- (pending)

## Verdict per path
- (pending)

## !!! HOLE FOUND (flagged 2026-10-23, before empirical run) !!!
The F-9 engine gate enforces the role carried in the caller's engine
access token — but the token's role is NOT server-authoritative:
- POST /api/engine/open (gateway.ts) takes `role` from the REQUEST BODY
  (`requestedRole = b.role ?? 'editor'`) and, on the JOIN path, mints the
  token with that asserted role and records it in the registry via
  noteParticipant — no grant/ACL check anywhere in the handler.
- The shipped web client (collabTransport.ts:439) never passes a role at
  open, so EVERY joiner of a live session receives an EDITOR token by
  default.
- The product's grants (ShareDialog -> SharingService/AccessTable) are
  BROWSER-LOCAL (useNameServices.ts: localStorage persistence) and never
  reach the server, so "shared as Viewer" is enforced nowhere on the
  live-session path.
- Second door, same hole: the CLAIM path with an existing record replies
  role 'editor' unconditionally while preserving the original
  creatorPrincipal — a non-creator rehydrating an expired session also
  gets editor.
Consequence: a user the owner shared a file with as Viewer can write
freely (UI ops, structural ops, direct engine ops, and the agent path,
whose resolver trusts the same recorded role). F-9's gate + tests pin
behavior only for tokens that happen to carry 'viewer'.
FIX PLAN (server-side, at the gateway): owner-recorded grants in the
file registry (new creator-only POST /api/engine/share); open resolves
the effective role as creator -> editor, else grant on record, else
recorded participant role, else the requested role as a self-lowering
only — a grant can never be raised by the request. Claim-with-record
resolves the same way. noteParticipant records the EFFECTIVE role.
RESIDUAL (for the parent/owner to rule on): a principal with NO grant
record can still join as editor (the shipped Phase-2 co-authoring
model, pinned by phase2Collab.test.ts — fileId + authentication acts
as co-editor entitlement until the owner records a grant). Changing
that default would redesign the sharing model; flagged, not silently
changed.

## Phase A — PRE-FIX REPRODUCTION (evidence: phaseA-prefix.json)
- alice opens ro-prefix.xlsx (creator, editor, sess_87c2ffec), writes A1 OK.
- bob joins the SAME session exactly as the shipped client does (no role
  in the open body): joined=true, SAME sessionId, role = **editor**.
- bob POST /ops setCell B2 "VIEWER-HACK" -> HTTP 200, ok, revision 2;
  alice reads B2 back = "VIEWER-HACK". **WRITE LANDED.**
- Registry record: creatorPrincipal user:alice, participants
  { user:bob: "editor" } (self-asserted role recorded verbatim).
- Agent leg: bob asks the agent to write C3 -> agent replies success
  (9.1 s); alice reads C3 = "AGENT-PWN". **AGENT WRITE LANDED.**
Verdict pre-fix: HOLE on the UI/op path AND the agent path.
