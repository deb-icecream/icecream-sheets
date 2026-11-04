# MCP Async-Seam Migration + Firestore Adapter — Brief (parent dispatch, 2026-10-21 ~22:08 PDT)

## Authority

- User ruling, 2026-10-21 21:41 PDT: **"Proceed with durable"** — the deployed
  MCP posture is the durable store. This migration is the implementation of
  that ruling (the only honest route to it, per the finding below).
- Finding of record: `hidden_files/mcp-firestore/REPORT.md` (worker 157846bb,
  parent-verified 22:06 PDT): the MCP stores consume the SYNCHRONOUS
  `Persistence` seam (`packages/service/src/metadataStore.ts` —
  `load(key): string | null; save(key, value): void`), and Firestore is
  async-only, so no honest adapter for that seam exists. The write-through-
  cache and blocking-bridge workarounds are rejected (durability becomes
  timing-dependent; stale-cache merges clobber other instances).
- The async counterpart seam already exists and is proven in production code:
  `AsyncPersistence` (`packages/service/src/secureStore.ts:132`) — the
  credential vault runs on it.

## Task (the REPORT.md proposal, adopted as spec)

1. **Async metadata-store variant** in the service package: mirror
   `MetadataStore` over `AsyncPersistence`, reusing the same pure
   serializers. The sync `MetadataStore` STAYS (the web localStorage host
   needs it) — this is an addition, not a replacement.
2. **Migrate the MCP consumers** to the async variants: `MemoryStore`
   (mcp-server/src/memory.ts), the seven MetadataStore-backed stores, and
   `KeyManager` (wiring sites listed in REPORT.md). Their call sites are
   already async tool handlers. **FIX-J semantics must survive**: the memory
   read-modify-write merge correctness may not regress — serialize the
   merge per key within the process, and state the cross-instance semantics
   honestly in code + report (if full cross-instance transactional merging
   is out of reach, say so plainly and make the failure mode loud, never
   silently lossy).
3. **Async runner config**: `resolveRunnerConfig` becomes async; the bin
   awaits it before listening. The prod branch mirrors the gateway's
   `prodSessionConfig`/`loadProdClients` fail-closed pattern (missing
   config = refuse to start, designed message). `local` keeps working
   exactly as the fix round validated it.
4. **The Firestore adapter** itself: one document per seam key in an
   `icecream_mcp_metadata` collection, doc id = sha256 of the key,
   fake-`FirestoreLike` unit tests in the style of the gateway's
   `FirestoreSessionStores`. **Firestore's 1 MiB document cap vs the file
   adapter's uncapped blobs: reject loudly over the cap, never truncate.**
   `@google-cloud/firestore` is not installed anywhere in the workspace —
   follow the gateway's client-loading pattern (its `FirestoreLike`
   abstraction exists precisely to avoid a hard dependency); do not add the
   dependency casually — if it is genuinely required, say so in the report
   before adding it.
5. **Deploy wiring**: only after 1–4 validate, set `MCP_STORE: prod` +
   `GCP_PROJECT_ID` in `deploy/services/mcp.yaml`.
6. **Stale docs** (carried over from the adapter brief, still open):
   `deploy/CONFIG.md:245` (stale `ENGINE_URL` "reserved (tool wiring)" MCP
   row) and `deploy/Dockerfile.mcp:23-27` (stale "KNOWN CODE GAP (W17b)"
   comment) — reconcile both.

## Validation bar

- MCP suite green at or above the fix-round baseline (142 passed + 1
  skipped), tsc clean; service suite green (the async variant is additive —
  no sync consumer may change behavior).
- The durable proof, on the shipped bin with `MCP_STORE=prod` (local
  Firestore stand-in per the codebase's local-adapter pattern — state
  exactly what stood in): memory_save → SIGKILL → **wipe the local data
  dir** → restart → memory_load HIT, per-user scoping intact, update-merge
  still correct across the restart.
- Fail-closed proofs re-run: no secret / bogus store / prod-without-config
  all refuse to start with the designed messages.
- Auth + rate-limit spot legs from the fix round re-run on the migrated bin
  (the runner changed shape; prove the fix round's verdicts still hold).

## Rules

Design docs are the authority. Checkpoint progress into
`hidden_files/mcp-firestore/MIGRATION-REPORT.md` after each landed step
(daemon restarts are frequent tonight — a successor must be able to resume
from disk). Related tests only during build; the full MCP + service suites
are the gate at the end. No git push. Do not edit progress.md. Deliverable:
MIGRATION-REPORT.md with per-step verdicts, the cross-instance semantics
statement, and anything not done, named plainly.
