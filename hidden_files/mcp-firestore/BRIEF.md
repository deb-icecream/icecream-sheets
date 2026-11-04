# MCP Firestore Persistence Adapter — Brief (parent dispatch, 2026-10-21 ~21:32 PDT)

## Why

The MCP fix round (hidden_files/mcp-validation/fix-round/REPORT.md) wired the
shipped MCP runner to durable stores via `MCP_STORE`: `local` = file-backed
(durable across process restarts on the same instance), `prod` = **fails
closed** because no Firestore adapter exists for the persistence seam. On
Cloud Run, instances are replaced routinely (deploys, scale-to-zero cycles),
so `local` would silently reset the AI agent's long-term per-user memory —
against design-docs/ai-agent.md §9/§12 (long-term user memory is durable,
per-user, versioned MCP tool records). Build the missing adapter so the
deployed posture can be `prod`.

## Task

1. Study the existing deployed-adapter patterns first: the gateway's deploy
   stores (`packages/gateway/src/deploy/` — session registry / file registry
   Firestore adapters + their local adapters behind one interface) and the
   service `Persistence` seam the MCP stores consume
   (`packages/mcp-server/src/bin/runner-config.ts` is the selector).
2. Implement the Firestore adapter for that seam, in the package that owns
   the seam (follow the existing dependency direction — the fix-round report
   explains why the file adapter lives in `src/bin/`: gateway depends on
   mcp-server, not the reverse). If the seam's shape genuinely blocks a
   Firestore implementation, STOP and report the exact constraint + the
   minimal seam change you propose — do not improvise a parallel store.
3. Wire `MCP_STORE=prod` to the new adapter (fail-closed behavior stays for
   unconfigured/bogus values). Set `MCP_STORE: prod` in
   `deploy/services/mcp.yaml`.
4. Cleanup in the same pass (both flagged stale by the fix round):
   - `deploy/CONFIG.md` (~line 245): the `ENGINE_URL` "reserved (tool
     wiring)" text — ENGINE_URL was removed from mcp.yaml as dead config;
     reconcile the doc.
   - `deploy/Dockerfile.mcp`: the W17b "KNOWN CODE GAP" comment — its
     precondition is now enforced by the bin; reconcile the comment.

## Validation bar

- Unit tests for the adapter (against a fake/emulator or the local adapter
  implementing the same interface — state which, honestly).
- End-to-end on the shipped bin with `MCP_STORE=prod` (local stand-in for
  Firestore per the codebase's local-adapter pattern): memory_save → SIGKILL
  → wipe the local data dir (simulating instance replacement) → restart →
  memory_load HIT, per-user scoping intact. The durability must provably come
  from the store, not from anything on the local disk.
- MCP suite green (baseline after fix round: 142 passed + 1 skipped), tsc
  clean. No other package's behavior changes.

## Rules

Design docs are the authority. Related tests only. No git push. Do not edit
progress.md. Deliverable: `hidden_files/mcp-firestore/REPORT.md` with the
design choice, the evidence, and anything not done, named plainly.
