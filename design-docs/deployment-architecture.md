# Deployment Architecture — GCP / Firebase (user's rulings, 2026-10-20)

Production topology (standing design): services + gateway on GCP, web app on
Firebase Hosting. Accounts are SEPARATE (GCP account ≠ Firebase account);
each gets its own service account / token, stored in the Secure Vault, used
only for its own deploy.

## Compute choice: Cloud Run everywhere, no Cloud Functions

- **Web app** → Firebase Hosting (static build; `VITE_GATEWAY_URL` points at
  the deployed gateway).
- **Gateway, engine service, service package, MCP** → Cloud Run services.
- Cloud Functions is rejected for every current component:
  - Gateway must accept 256 MB bodies on the load route; Functions caps
    payloads at 32 MB.
  - Engine is stateful (below); function instances are disposable.
  - 600 s-class streaming proxy/load traffic is service work, not event work.
- Stateless one-shot helpers (a future webhook receiver, a scheduled
  cleanup) are the only natural Functions candidates; none exist today.

## Cost posture: scale-to-zero by default

- Cloud Run charges per request-second (CPU $0.000024/vCPU-s, memory
  $0.0000025/GiB-s) with a monthly free tier; idle costs $0.
- Min-instances = 0 at launch for every service. A warm engine min-instance
  (idle rate $0.0000025/vCPU-s and /GiB-s; ≈$65/mo at 2 vCPU / 8 GiB) is a
  later, separately-priced decision if cold starts ever bother real users.
- Stateful ≠ stateless billing risk: the engine's cost scales with actual
  opens/edits, not with wall-clock existence.

## The engine is stateful — by necessity, not preference

A spreadsheet engine cannot be stateless: the dependency graph and the
built workbook live in process memory so an edit recalcs in milliseconds.
Rebuilding per request costs the full build (~30–250 s) per click; pushing
state to the browser was Cycle 9's rejected local mode. Therefore:

- **Gateway and all other services are stateless** — per-request invocation,
  gateway validates each request as it passes, use-and-throw. No special
  access pattern is needed for them (user's ruling, 2026-10-20).
- **Engine is a stateful service with durable backing**, in two size tiers
  routed at open time by cell count: standard (4 vCPU / 16 GiB) and XL
  (8 vCPU / 32 GiB) for P95/P99-class workbooks.
- Engine request timeout: the Cloud Run maximum, 3,600 s (measured worst
  real operations: P99 build ~249 s, P95 save ~109 s, deep-chain edit
  ~19 s). Sessions themselves have NO lifetime cap: a session lives while
  the user is active, across instance replacements (below).

### Engine extension 1 — session registry
On build, the engine registers `session → instance + revision` (Firestore).
Subsequent reads/edits for a session route to the holding instance.
Per-instance session caps are set by a memory budget (total cells).

### Engine extension 2 — op journal (durability core)
Edits already travel as discrete operations with revision numbers and a
checksum ack. In production each op is appended to a journal in storage as
it executes. If an instance dies (deploy, maintenance, scaling — Cloud Run
promises no instance lifetime), a fresh instance loads the stored file
bytes from Cloud Storage, builds, replays the journal to the last
revision, and verifies the checksum before the client resumes.

### Engine extension 3 — snapshots + idle eviction
Every N ops / few minutes the owning instance writes a full workbook
snapshot to Cloud Storage (encrypted at rest) and truncates the journal.
Sessions past the idle threshold (below) are snapshotted and evicted from
memory; return = rehydrate from snapshot + journal.

## Idle rule (user's ruling, 2026-10-20)

1. **Idle = no user activity for 10 minutes**, measured at the client
   (browser or desktop). Scrolling counts as activity; so do mouse,
   keyboard, and cell navigation. The clock runs from the last activity.
2. At 10 minutes idle: checkpoint (snapshot + journal flush), then close
   the session and release it from the engine's memory. Once an instance's
   last session is released, Cloud Run's autoscaler stops the instance —
   "release" is eviction; the platform stops the empty instance itself.
3. On release the client shows a **disconnected** state, and **editing is
   blocked** while disconnected (same gating family as the existing
   loading/read-only gates).
4. The user's next activity reconnects: the session rehydrates from
   snapshot + journal, checksum-verified, and editing unlocks.
5. Tab close releases immediately (unload beacon), no 10-minute wait.
6. Client heartbeats activity to the server; the server's last-request
   timestamp is the backstop for a vanished client.

## Engine access pattern: gateway-issued signed URL, direct connection
(user's ruling, 2026-10-20 — STATEFUL ENGINE ONLY)

Today's local topology proxies all engine traffic through the gateway.
In production, for the engine only:

1. The client asks the **gateway** first. The gateway runs its full checks
   — authentication, rate limiting — and on success returns a **signed
   URL** instead of proxying.
2. The client connects **directly** to the engine Cloud Run with that
   signed URL. Loads, streams, edits, and saves flow client ↔ engine with
   no gateway in the data path (this removes a measured failure class:
   gateway proxy timeouts on long saves, 256 MB bodies buffering through
   the gateway).
3. The engine is not publicly reachable without it: **the engine
   validates the signed URL itself** and refuses anything else — the same
   pattern as MCP's direct ingress with self-authentication.
4. The signed URL is short-lived (minutes) and scoped to user + session;
   refresh goes back through the gateway. A leaked URL is nearly
   worthless.
5. Rate limiting splits accordingly: the gateway rate-limits issuance
   (the handshake); the engine enforces its own per-session limits after
   connect, like MCP's own tier.
6. **Stateless services are exempt** (user's ruling): per-request
   invocation means the ordinary gateway-proxied path validates every
   request anyway; no signed URL, no direct connection needed.

## Storage
- Cloud Storage: original file bytes + session snapshots (encrypted).
- Firestore: metadata store, session registry, op journal.
- Secret Manager: vault keys, LLM credentials, service secrets.

## Still required from the user before first deploy
- Two one-time sign-ins (GCP service account, Firebase CI token) into the
  Secure Vault; billing enabled on the GCP project.
- Firebase project config (`VITE_FIREBASE_*`, `FIREBASE_PROJECT_ID`).
- gcloud SDK + firebase-tools are installed on the Muse VM at deploy-prep
  time; neither exists there yet (checked 2026-10-20).
