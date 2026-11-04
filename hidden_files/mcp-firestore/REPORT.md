# MCP Firestore Persistence Adapter — Report

**Date:** 2026-10-21 ~22:00 PDT · **Worker:** third on this task (two
predecessors died in daemon restarts during the study phase, landing
nothing — parent-verified, and re-verified here: no adapter code exists,
`deploy/services/mcp.yaml` has no `MCP_STORE`, no prior report).

## VERDICT: STOPPED AT THE SEAM — the synchronous `Persistence` seam
## genuinely blocks a Firestore adapter. No code was written.
## The minimal seam change is specified below for a parent decision.

This is the outcome the brief explicitly provides for ("If the seam's
shape genuinely blocks a Firestore implementation, STOP and report the
exact constraint + the minimal seam change you propose — do not
improvise a parallel store"). The constraint is real, narrow, and
already documented in the codebase's own words; the way through it is
equally clear and is a small, sanctioned migration — but it changes a
cross-package seam, so it is the parent's call, not this worker's.

---

## 1. The exact constraint

The seam the MCP stores consume is **synchronous**
(`packages/service/src/metadataStore.ts:37`):

```ts
export interface Persistence {
  load(key: string): string | null;
  save(key: string, value: string): void;
  clear(key: string): void;
}
```

Every consumer relies on same-tick semantics:

- `MetadataStore.all()/saveAll()` (metadataStore.ts) — loads lazily via
  `persistence.load(key)`, caches, and persists whole serialized blobs
  synchronously. Seven of the MCP server's stores are `MetadataStore`s
  (charts, pivots, reports, apps, analysis, data sources, artifacts).
- `MemoryStore` (`packages/mcp-server/src/memory.ts`) — `persist()` is a
  synchronous read-modify-write merge: `persistence.load(MEMORY_KEY)` →
  merge → `persistence.save(...)`. FIX-J built that merge precisely so
  coexisting instances sharing one store do not clobber each other; it is
  only correct if `load()` returns the latest committed blob.
- `KeyManager` (`packages/service/src/secureStore.ts`) — constructed
  over the same sync seam in `packages/mcp-server/src/server.ts`
  (server.ts:188, 274, 300, 320, 1060, 1233, 1392, 1820 wire the one
  injected `Persistence` into every store).

Firestore has **no synchronous API**. Every operation of the official
client is a network round trip returning a Promise. A `load(key)` that
must return `string | null` in the same tick cannot be backed by
Firestore. The fix round reached the same conclusion and pinned it in a
test (`packages/mcp-server/tests/runner-config.test.ts:83`:
"MCP_STORE='prod' throws fail-closed (no Firestore adapter for the sync
Persistence seam)"), and `runner-config.ts`'s error message states it
verbatim.

### Why the apparent workarounds are not honest adapters

- **Write-through/read-through cache** (hydrate at startup, serve sync
  reads from RAM, flush saves asynchronously): `save()` would return
  before the value is durable. The brief's key proof — memory_save →
  SIGKILL → restart → memory_load HIT — then depends on flush timing,
  i.e. the store can silently lose the exact writes this feature exists
  to keep. It also silently breaks `MemoryStore.persist()`'s merge
  contract (a stale cache `load()` clobbers other instances' committed
  keys — the failure FIX-J fixed) in the multi-instance topology Cloud
  Run actually runs. This is a parallel store with weaker semantics
  wearing the seam's clothes — the brief forbids improvising it.
- **Blocking bridge** (worker thread + `Atomics.wait`, or a child
  process per op doing REST/SDK calls): no precedent anywhere in the
  codebase (the only `Atomics.wait` in the tree is the share-store lock
  spin in `packages/gateway/src/deploy/shareStore.ts`, not I/O), it
  needs its own auth/token machinery inside the worker, and it
  deadlocks or hangs the whole server if the worker dies. Not the
  gateway pattern; not a small increment.

### Why the gateway pattern cannot simply be copied

The gateway's prod adapters (`FirestoreSessionStores`,
`packages/gateway/src/deploy/sessionStore.ts:410ff`) work because the
gateway's store interfaces are **async end-to-end**
(`register(): Promise<void>`, `lookup(): Promise<…>`), its factories
are async (`createSessionStores(): Promise<SessionStores>`), and its
adapters are written against a narrow structural `FirestoreLike`
(sessionStore.ts:377-390) with the real client loaded by dynamic import
and a fail-closed self-check (sessionStore.ts:563ff, `wrapFirestore`
at :616). Two further direction facts:

- `FirestoreLike`/`wrapFirestore` live in the **gateway** package;
  gateway depends on mcp-server, so mcp-server cannot import them
  (the same circularity runner-config.ts already documents for the
  file adapter). An MCP adapter must define its own narrow copy.
- `@google-cloud/firestore` is **not installed** in this workspace
  (no `@google-cloud` in any package.json or node_modules) — the
  gateway handles this by dynamic import + fail-closed error, and any
  MCP prod path must do the same.

---

## 2. The minimal seam change (proposed; grounded in existing code)

The codebase already sanctions the direction: an async counterpart
seam **already exists** — `AsyncPersistence`
(`packages/service/src/secureStore.ts:132`, with `memoryAsyncPersistence()`
and the `toAsyncPersistence(p)` bridge) — and the credential vault
already runs on it. The migration is therefore "extend the existing
async seam to the metadata stores", not a new invention:

1. **Service package:** add an async metadata-store variant mirroring
   `MetadataStore` over `AsyncPersistence` (same key names, same pure
   serialize/deserialize functions — they are shared and storage-free).
   The sync `MetadataStore` stays untouched: the web host's
   localStorage adapter is inherently synchronous and must keep it.
2. **MCP server:** migrate its store consumers to the async variants —
   `MemoryStore` (its `load/save/update/clearUser` become async; its
   call sites are MCP tool handlers, already async), the seven
   `MetadataStore`-based stores in `server.ts`, and `KeyManager`'s
   async path (secureStore already demonstrates one). `ServerOptions.
   persistence` becomes `AsyncPersistence`; the local file adapter is
   reused unchanged via the existing `toAsyncPersistence()` bridge, so
   `MCP_STORE=local` behavior is byte-identical.
3. **Runner:** `resolveRunnerConfig` becomes async (the bin already
   resolves config before listening; `await` is a two-line change) and
   gains the `prod` branch: validate `GCP_PROJECT_ID` (fail closed when
   missing, mirroring `prodSessionConfig`), dynamic-import
   `@google-cloud/firestore` (fail closed when absent, mirroring
   `loadProdClients`), build the adapter.
4. **The adapter itself** (the easy part, once 1-3 exist):
   `createFirestorePersistence(db: FirestoreLike): AsyncPersistence` —
   one document per seam key in a collection named `icecream_mcp_metadata`
   (following the `icecream_sessions` naming), doc id = sha256 of the
   key, the value stored as a single string field. Unit-testable against
   an in-memory fake `FirestoreLike`, exactly like
   `FirestoreSessionStores`' tests.
   **Known limit to accept explicitly:** Firestore documents cap at
   1 MiB; seam values are whole blobs (the agent-memory blob grows with
   users × keys) and the file adapter has no such cap. The adapter
   must reject an over-limit value loudly, never truncate.
5. **Deploy wiring (with the migration, not before):** set
   `MCP_STORE: prod` + `GCP_PROJECT_ID` in `deploy/services/mcp.yaml`.
   Doing the yaml change alone today would only convert the deployed
   posture from "local store" to "refuses to start".
6. **Tests/validation then owed:** runner-config tests updated (prod
   succeeds with complete config + fake; still fails closed on missing
   project/SDK/bogus value); adapter unit tests vs the fake; the
   brief's SIGKILL → wipe-local-dir → restart → HIT proof against the
   fake-backed bin (locally, "the store" = the fake FirestoreLike
   standing in per the codebase's local-adapter pattern — stated
   honestly: no real Firestore is reachable from this workspace).

Estimated surface: service (one new store variant), mcp-server
(memory.ts, server.ts store wiring, http.ts options type,
runner-config.ts, bin/http.ts await, tests), deploy (mcp.yaml,
CONFIG.md, Dockerfile.mcp). No web changes, no gateway changes, no
engine changes.

---

## 3. Implementation plan that was checkpointed before the stop

Per the anti-restart protocol, the plan formed during study was:
(1) adapter + fake-based unit tests → (2) runner wiring → (3) yaml +
doc reconciliation → (4) shipped-bin SIGKILL proof. Step (1) is where
the seam constraint bites: there is no type the adapter can implement
that the runner can hand to `startMcpHttp` today — `RunnerConfig.
persistence` is the sync `Persistence`, and every store behind it
calls it synchronously. The stop therefore happens before any code,
which is why this report contains the finding instead of partial work.

## 4. Not done (named plainly, all downstream of the stop)

- **No adapter code, no wiring** — see §1-2.
- **`deploy/services/mcp.yaml` unchanged** — no `MCP_STORE` added (see
  §2.5 for why adding it now would be wrong).
- **`deploy/CONFIG.md:245` still stale** (not edited; brief bundles it
  with the adapter pass): the MCP table row still reads
  `| ENGINE_URL | Engine the MCP tools act on | ENV (deploy.sh fills) |
  **reserved** (tool wiring) |` — but the fix round removed `ENGINE_URL`
  from mcp.yaml and no MCP code reads it. (CONFIG.md:189-190 are the
  gateway's own ENGINE_URL rows and are correct.)
- **`deploy/Dockerfile.mcp:23-27` still stale** (not edited, same
  reason): the "KNOWN CODE GAP (W17b)" comment claims the bin does not
  override startMcpHttp's host default — the bin does (`src/bin/http.ts`
  reads `HOST`, mcp.yaml sets `HOST=0.0.0.0`), and the requireAuth
  precondition the comment names is enforced by `resolveRunnerConfig`.
- **Suite state:** untouched — nothing was built, so the baseline
  (142 passed + 1 skipped, tsc clean, per the fix-round report) stands
  as-is.

## 5. What the parent decides

Approve the §2 seam migration as a task (it is the only honest route
to `MCP_STORE=prod`), or explicitly accept `MCP_STORE=local` as the
first-deploy posture knowing instance replacement resets agent memory
(the user already ruled "proceed with durable" on 2026-10-21 21:41
PDT, which points at the migration). Either way, the fail-closed
behavior in the shipped bin today is correct and should stay until
the migration lands.
