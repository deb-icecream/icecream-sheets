# Firestore Prod Adapters — Brief (tracking document)

**Origin:** Dispatched 2026-10-22 ~04:19 PDT to worker
`2a8aa0bb-c15d-4c10-981d-bba75d2b47af`, in parallel with the first deploy.
**This brief was written 2026-10-22 ~04:45 PDT at the user's direction** —
the work was already tasked and in flight; this document formalizes the
tasking so the track is easy to follow. The worker's live record is
`hidden_files/firestore-prod-adapters/REPORT.md` (same folder).

**User ruling behind the work:** features broken in production ARE blockers
in principle. The deploy itself runs without these adapters, but two
features would be broken in the deployed topology until they land. They are
fast-follow fixes: if they miss the first images, they redeploy, and the
affected post-deploy verification legs are reported as failed until they
pass.

## Gap 1 — Session-registry listing over Firestore

`agentSessionResolver` (`pickSessionForFile` / `createFileSessionResolver`
in `packages/gateway/src/services/agentSessionResolver.ts`) finds a file's
live session for a principal by LISTING registry records. The Local and
Memory registry adapters support this; the Firestore adapter of
`packages/gateway/src/deploy/fileRegistry.ts` did not — so in production
the AI Agent's per-file session binding and the add-on engine binding
cannot resolve sessions.

Required:
- A list operation on the Firestore registry adapter with semantics
  identical to Local/Memory: every record returned, and dead-lease /
  expired / released records excluded by the SAME shared liveness filter
  the resolvers already apply (no divergent per-adapter semantics).
- No behavior change for Local/Memory.

## Gap 2 — Share-store Firestore adapter

The app-share store (`packages/gateway/src/deploy/shareStore.ts`) shipped
with Local/Memory adapters only; `SHARE_STORE=prod` fails closed, so app
sharing (idea: app artifact gallery) would be broken in production.

Required:
- A Firestore adapter for the share store following the established
  `packages/service/src/firestoreMetadata.ts` pattern: narrow `DbLike`
  interface for testability, doc id = sha256 hex of the key, loud failure
  (errors propagate; the Firestore 1 MiB doc cap rejects loudly, never
  truncates), malformed docs read as missing.
- `SHARE_STORE=prod` constructs the Firestore adapter when `GCP_PROJECT_ID`
  is configured and fails closed when it is not.
- Deploy config rows in the same style as the MCP Firestore rows:
  `deploy/services/gateway.yaml` + `deploy/CONFIG.md`.

## Validation bar

- Fake-based unit tests in the established style (no live Firestore is
  reachable from this VM — by design; the live proof rides the post-deploy
  verification, alongside the MCP live-Firestore leg).
- Gateway suite green; tsc clean. Land files atomically (the deploy
  coordinator builds images from this tree in parallel).

## Status at brief time (from REPORT.md, parent-read 2026-10-22 ~04:45 PDT)

- Gap 1: source landed (registry `listAll()` on all three adapters +
  `wrapFirestore` scan; resolver takes the registry; wiring through
  agentSvc / addonEngineBinding / servicePackage). Tests pending.
- Gap 2: source landed (`FirestoreAppShareStore`, collection
  `icecream_app_shares`, sha256 doc ids, 1 MiB loud cap; `SHARE_STORE=prod`
  fail-closed wiring in `bin/gateway.ts`; gateway.yaml + CONFIG.md rows).
  New test file `firestoreProdAdapters.test.ts` (9 tests) + 8 affected
  files / 94 tests green; full gateway suite + tsc re-check running.
