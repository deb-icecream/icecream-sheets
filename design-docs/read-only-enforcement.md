# Read-Only Enforcement — Nobody Writes a Read-Only File

Status: OWNER RULING, 2026-10-23 ~00:04 PDT: "If the file is read only
then nobody should be able to write it." This doc records the rule, the
enforcement points, and the acceptance test. Recording is not proof —
the acceptance below must be RUN, and any hole fixed at the server.

## 1. The rule

Read-only status is absolute for writes. A user whose access to a file
is read-only (viewer role) attaches to the same live working copy as
everyone else — one file, one server copy — and SEES edits live. They
can write NOTHING, through ANY path:

- typing or any UI mutation (edit, paste, structural ops, delete);
- asking the agent to write (the agent acts with the caller's own role,
  through the same gates — no agent bypass);
- direct API calls to the engine's mutating routes;
- any other client (desktop included — same server gates).

Enforcement lives SERVER-SIDE. Hiding or disabling UI controls is
presentation, never enforcement.

## 2. Enforcement points (as designed)

- The engine refuses mutating operations from a viewer-role principal
  (the F-9 fix, issue #13: 403 on all 14 mutating routes).
- Role travels in the caller's verified claims; the MCP/agent path uses
  the bound identity authoritatively (F-10) and reaches the engine
  through the same gated routes.
- The shared session does not widen anyone's rights: joining is a read
  of the session, writing is separately authorized per operation.

## 3. Acceptance (must be run on the local production-topology stack)

Two authenticated clients on ONE file, ONE live session:

1. Owner (editor) opens the file; viewer opens the same file — both
   attached to the same session (registry/session evidence).
2. Viewer attempts, each expected to FAIL with the file unchanged:
   a. type into a cell (UI-level attempt + the resulting op refused);
   b. a structural op (insert row / rename sheet) via API;
   c. a direct write op via the engine API (bypassing the UI);
   d. an agent prompt asking the agent to write a value — the agent
      must not land the write.
3. Control: the editor's write lands and the viewer SEES it live
   (delta received) while still being unable to write.
4. Ground truth: after all attempts, download + parse back the file —
   only the editor's changes are present; none of the viewer's
   attempted values appear anywhere.
5. Regression: editor flows unaffected; the existing security tests
   still pass (related tests only).

Any attempt that lands a write is a defect: fix at the server gate,
re-run the full matrix, and record the hole + fix in the report.

## 4. Owner ruling on access itself (2026-10-23 ~01:10 PDT)

Access to a file comes ONLY from a grant (recorded by the owner,
including when the owner shares a link — the role travels with the
share):

- No grant -> denied entirely; the file cannot even be opened.
- Viewer grant -> can read only; the UI prevents editing AND the
  server rejects API/agent writes regardless.
- Editor grant -> can read and write.

The Phase-2 shortcut — fileId + signed-in treated as co-editor
entitlement until the owner restricts — is REJECTED and does not
survive the #51 fix. Joining a session requires a grant.

## 5. Who may modify the access list (owner ruling discussion, 2026-10-23 ~01:17 PDT)

The owner — and ONLY the owner — modifies a file's access list:
- grant/revoke viewer or editor; change a role; link-sharing on/off
  and its role; transfer ownership; delete the file.
Editors edit CONTENT only. An editor cannot share, re-role, remove
anyone, change link settings, transfer ownership, or delete the file.
The owner's own entry is immovable: nobody can demote or remove the
owner — ownership changes hands only through an explicit transfer BY
the current owner. An editor kicking the owner out is therefore
impossible by construction.
Access-list changes take effect immediately, including on live
sessions: a demoted editor's next write fails; a removed person's
session is cut. Every access-list change is recorded (who, what, when).

## 6. Final role set (owner, 2026-10-23 ~01:18 PDT) — keep it simple

Exactly three roles, nothing else (NO commenter role):
- Owner: everything — writes, changes the access list, and is the
  ONLY role that can delete the file.
- Editor: edits the file's contents. Cannot delete the file, cannot
  touch the access list.
- Viewer: reads only; any write attempt errors.
(Deleting cells/rows/contents is editing; deleting the FILE is
owner-only.)

## 7. Where the enforcement lives (owner question, 2026-10-23 ~01:24 PDT)

Firestore has NO per-document enforcement for server-side access:
security rules bind direct client connections only, and this product
never lets clients connect directly (server SDKs bypass rules by
design). The database's own wall is identity-level: it answers only
to the service accounts holding database roles. Per-file rules —
"only THIS file's owner may change THIS file's list" — are enforced
in the gateway's code: authenticate the caller, load the record,
compare caller to the record's owner, refuse on mismatch. All
user traffic reaches the data only through that checked door.
Mitigations for the application-layer trust: the grant-write path
exists ONLY in the gateway; the owner check is one shared function;
the cross-owner case (the owner of file B attempting to modify file
A's list) is pinned by test; every change is audit-logged.

## 8. Separation of duties (owner, 2026-10-23 ~01:26 PDT)

- The GATEWAY validates the USER: it proves identity (verifies the
  sign-in token) and routes. It does not own file permissions.
- The SERVICE THAT OWNS THE FILE validates ACCESS: it takes the
  verified identity, loads that file's access list, and decides —
  owner -> ACL change allowed; editor -> content writes; viewer ->
  reads; no entry -> denied. The ACL check runs in that service on
  every action (open, write, share), not as a one-time stamp at the
  edge. All consumers (open, ops, agent, share) pass through the same
  check in the file-owning service layer.
