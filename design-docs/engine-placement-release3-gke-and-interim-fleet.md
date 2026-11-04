# Engine placement: Release 3 GKE target + interim Release 1 fleet rule

Owner decisions, 2026-10-24 ~02:08 PDT. This doc is the governing spec for both
parts below. Status is split on purpose: the Release 3 target is DESIGN ONLY
(not to be built now); the interim rule is BUILD NOW.

Related law (unchanged by this doc): the revision-model design doc
(`revision-model-save-and-coauthoring.md`) §9 (one file, one server copy;
registry in the database; join handshake), §9A (attach/refcount, instant
release, activity heartbeat, per-user open cap 4 with silent LRU eviction),
§9B (agent routing: open-time signed direct link), §9C (identity: fileId from
client, user from JWT, everything the engine needs inside the signed token).

## Part 1 — Release 3 target: engines move from Cloud Run to GKE (DESIGN ONLY)

Why: the engine is stateful, not stateless, and that is the decisive point.
Cloud Run is built for stateless services: it cannot address a specific
running copy inside a service, its session affinity is best-effort only, and
its instances are ephemeral. Every workaround in the current architecture
(one-copy rule + epoch fencing, checkpoint + rehydrate, fleet-as-services,
affinity) exists because the platform assumes statelessness. The fleet model
(one service per file) and the multiplex model on Cloud Run (many files per
Cloud Run copy) are both rejected; the fleet rejection stands, the multiplex
rejection is superseded ONLY as stated in Part 1.4 below.

### 1.1 Platform

- Engines run on **GKE Autopilot as StatefulSets**. This is the closest
  public-cloud shape to how Google Docs (Borg) and Excel for the web (Azure)
  host live documents: long-lived, addressable session servers, sharded by
  document.
- Each copy gets a **stable identity and a stable address** (per-pod DNS).
  The registry stores the copy's address — routing is to the INSTANCE, not
  to the service. That is the problem this move exists to solve.
- The platform still scales: the Horizontal Pod Autoscaler grows and shrinks
  copy count on load (CPU, memory, or a custom signal such as sessions per
  copy). It does not scale to zero per request the way Cloud Run does;
  copies are long-lived and idle copies cost their reserved resources while
  they run.

### 1.2 What stays the same

- TypeScript + HyperFormula. No language rewrite. The engine runs in a
  container; a container runs the same on GKE as on Cloud Run.
- The whole ownership model: one file, one server copy; registry claims as
  database transactions; leases; epoch fencing; checkpoints; rehydration.
  Only the address format changes (service URL → copy address).
- The gateway and the AI service are stateless and may stay on Cloud Run.
  The gateway then needs VPC access into the cluster to reach copy
  addresses (the same VPC work as the service-internal discussion; it is not
  wasted either way). Whether the gateway also moves into the cluster is an
  open decision, not assumed here.

### 1.3 What changes

- **Browser path needs a router.** Copies live inside the cluster and are
  not reachable from the internet, so the browser can no longer connect
  directly to a copy. A router sits in front: either the gateway becomes
  the data-path router (browser → gateway → copy, using the registry), or
  a dedicated lightweight router runs in the cluster doing the same. The
  engine still verifies the signed token itself, so the security model
  survives — but the direct-link shape of §9 changes, and the router is a
  component the project owns. Router shape is an open decision.
- **Pods are sized to real memory.** The design sizes (16 GiB / 32 GiB for
  the larger tier) become actually provisionable as pod resource requests,
  instead of the 4 GiB Cloud Run placeholder the copies run with today.
  Memory hygiene still matters: JS + HyperFormula costs several times the
  memory per document of a native-code engine, and a leaking copy dies on
  GKE just like on Cloud Run (#48 bounding work: keep the graph, shrink the
  inputs ledger to exceptions, bound the values cache).

### 1.4 Multiplexing: APPROVED for the GKE target (supersedes the old rejection)

- One engine process MAY hold multiple files open at once. Condition set by
  the owner (HyperFormula must support it) is met: HyperFormula is
  instance-based by design — each build call returns an independent engine
  with its own sheets, graph, and values; one per file, no cross-talk, and
  a formula in one file cannot leak into another.
- Consequences, stated honestly:
  - The engine service layer must change from a single session to a map of
    sessions: per-session journal, revision counter, subscribers, and
    fencing epoch, all isolated inside one process. Today the engine
    refuses a second file by construction; that refusal is what gets
    removed.
  - One thread: multiple HyperFormula instances in one process share
    Node's single thread. They take turns — a heavy recalculation on one
    file briefly stalls the others. Multiplexing buys density, not
    parallelism. True parallel recalculation remains the separate,
    parked #62 item.
  - Memory adds up: N files in one process cost N files' worth of JS
    memory in one heap. Pod sizing and #48 bounding are what make that
    survivable.
- The fleet model (one service per file) REMAINS rejected. Multiplexing on
  addressable copies is the approved density mechanism, not a return to
  fleet sprawl.

### 1.5 Open decisions for Release 3 (NOT decided, do not assume)

- Router shape: gateway-as-router vs dedicated in-cluster router.
- Gateway placement: stays on Cloud Run with VPC access vs moves into the
  cluster.
- Pod sizing policy and autoscaling signals (CPU/memory vs sessions-per-copy).
- Scale-to-zero story for idle copies (reaping, or KEDA-style tooling).

## Part 2 — Interim Release 1 rule: BUILD NOW (registry + Cloud Run continue)

Until Release 3, the current architecture stays: registry + Cloud Run.
One change lands now, to kill the #109 capacity wall without waiting for GKE.

### 2.1 Fleet: exactly five standard services, XL deleted

- The fleet is **five standard engine services** (the existing two plus
  three identical new ones). XL services (engine-xl, engine-xl-2) are
  **deleted**: today they are same-size placeholders as standard
  (2 vCPU / 4 GiB), so deleting them loses no per-file memory headroom.
  What changes is pool sharing: big files now share the five-service pool
  with small files instead of having two dedicated same-size services.
- **Tier routing collapses to one pool.** Size-based XL routing is
  suspended while XL is gone: ALL files, of any size, route to the
  standard pool of five. The gateway fleet configuration and the deploy
  yamls must reflect exactly five standard services and zero XL services.

### 2.2 Placement: rotation

- The gateway claims services in **rotation order** for new files. A service
  holding a live file is skipped. This is claim-first-free in rotation
  order, not round-robin onto occupied services (one file per copy is
  still the rule on Cloud Run).

### 2.3 Fleet capacity: five live files, then global LRU eviction

- Fleet capacity is **five live files total** (across all users).
- On an open that would be the sixth live file, the gateway does NOT 503.
  Instead it evicts the **globally least recently used live file** and the
  new file claims the freed service. The new file's opener sees zero
  impact: the open succeeds immediately, no error, no retry.
- LRU ranking: by last activity across all live files, using the same
  activity definition as the per-user cap (edits + selection changes;
  opening stamps it).
- Eviction semantics (same principle as the per-user cap, at fleet scope):
  - **Checkpoint confirmed BEFORE detach.** Never lose the evicted file's
    work; re-open rehydrates exactly.
  - **Whole-file release.** The file's session is released: ALL attached
    instances are detached, not just one user's. This is forceful by
    design — the file must free its service.
  - **Fleet-evict token (mechanism, implemented for fleet-5).** A
    stranger's plain editor token cannot release another user's file —
    that is #104 working as designed (the engine resolves role from the
    registry ACL, not the token role, whenever a record exists). Fleet
    eviction therefore uses a gateway-minted token with `fleetEvict:
    true`, scoped by its own sid+fid to exactly one session+file,
    single-purpose: the engine preamble refuses it on every route except
    `/session/release`, so it cannot be replayed as a general editor
    token. It bypasses only the ACL role gate on release; session/fid/
    status checks still enforced; the triggering opener stays the
    principal for audit. Rejected alternatives: minting detach-user
    tokens as each attached user, or as the file's creator — both
    impersonation-shaped with dishonest audit trails.
  - **Silent.** No prompt, no modal, no notice to anyone. The evicted
    file quietly closes for its users; their data is safe (checkpointed)
    and the file rehydrates on reopen.
  - **Never 503 for capacity.** Eviction always makes room. (Other 503
    causes — e.g. registry unreachable — still fail closed per §9.)

### 2.4 Interaction with the per-user cap of 4

- The per-user cap runs FIRST for the opening user: opening a fifth file
  of their own evicts THEIR least recently used file (existing §9A rule).
- Fleet eviction only engages when the fleet is full across users. A
  single user can never trigger fleet eviction alone (4 < 5).
- Cross-user consequence, stated plainly: fleet eviction MAY close a file
  belonging to another user, if that file is the global LRU. That user's
  data is safe and the file rehydrates on reopen, but the close itself is
  silent and is visible to them as their file closing. If the owner wants
  fleet eviction scoped to the opener's own files instead, this section
  must be corrected before build — it is recorded as whole-file eviction
  because the owner said "the least recently used FILE will be evicted."

### 2.5 Acceptance (for the implementing worker; parent verifies)

- Local production-topology validation only. NO live deploy, NO live
  service deletion in the implementation task — the live XL deletion +
  redeploy returns to the owner for a go.
- Legs: (a) fleet config lists exactly five standard services, zero XL;
  (b) all files, including over-p75 files, route to the standard pool;
  (c) five concurrent live files open cleanly; (d) a sixth open evicts
  the global LRU and succeeds with no 503, checkpoint-before-detach
  proven (evicted file's content exact on reopen); (e) per-user cap-4
  still behaves as specified; (f) co-user close behavior proven
  (evicted file's other attached users detached silently, data intact);
  (g) gateway suite + related tests pass (failed + related only, per
  testing economy).
- This change addresses #109's interim gap (grow the fleet + evict-first
  fallback, combined). #109 itself is closed by the parent on evidence,
  not by the worker.
