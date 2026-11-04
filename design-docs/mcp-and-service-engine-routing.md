# Caller → engine routing: AI service (IAM-gated) + MCP (public)

Owner directive, 2026-10-24 ~02:30 PDT. Governing alongside the
revision-model design doc §9 (one file, one server copy; registry in the
database; join handshake), §9B (agent routing), §9C (identity), and the
engine per-call authorization rule (#104).

## 1. Service inventory (correction — this governs over any other count)

- The "icecream-sheet-service" and the "AI service" are THE SAME service,
  not two. It runs the agent panel backend (chat, tools, multi-step
  workflows, artifacts), the agent's engine calls, and related AI workflows
  (vault/meta/etl live in the same package).
- The full Cloud Run backend set is FOUR services:
  - **gateway** — front door: auth, registry, claims, proxying.
  - **engine** — stateful: the live session of a file (on Cloud Run, one
    file per copy; on GKE, multiplexing is approved for Release 3).
  - **service = AI service** — agent backend (above).
  - **MCP** — AI-native API backbone.
- Plus, not a backend service: the static web app on Firebase Hosting
  (serves the frontend). Data stores (Firestore registry, GCS
  snapshots/uploads) are not services.
- An earlier count of "MCP, sheet-service, engine, AI service" double-counts
  the service and omits the gateway. The list above is the correct one.

## 2. The invariant (all callers, all paths)

For any file, EVERY caller reaches the SAME engine instance holding that
file: grid, agent panel, AI service, MCP. No caller ever routes to a
different file's engine, a tier URL, or a localhost fallback.

- Resolution is always by fileId from the SAME registry (Firestore in
  prod), the way the gateway does: live owner → that instance; lease and
  epoch respected; dead owners detected by liveness, never trusted blindly.
- Permission check BEFORE routing (primary gate, same as the agent's):
  the caller resolves the principal's access on the file (read-only vs
  read+write); lacking capability → refuse BEFORE the request reaches the
  engine.
- Engine verifies EVERY call (secondary gate, #104): signature, expiry,
  session match, file match, role-permits-action. Token possession alone
  is never authorization.
- Never wrong-file: unbound (no live session and no claim path) → honest
  refusal, never fallback to another file's session. This is the #99
  property, extended to all callers.
- Claims stay gateway-owned. MCP and the AI service NEVER claim directly.
  If no live session exists for a file, they go through the gateway open
  path (the claim authority) or refuse honestly — they never hydrate a
  private copy.

## 3. AI service: internal + gateway passes token + info

- The service is NOT open to the public: Cloud Run requires
  authentication, and roles/run.invoker is granted ONLY to the gateway
  service account; the gateway presents a Google ID token for the
  service URL on every proxied call, and the app-layer signed binding
  (#108) is the second gate. (This SUPERSEDES the leg-3 VPC design —
  see §6, owner decision 2026-10-25. The earlier internal flip broke
  the gateway path and was rolled back; the VPC end state was then
  built and then superseded for the reason §6 records.)
- Path: gateway → service (proxy of /api/agent/*) with the SAME token +
  binding info attached: a SIGNED binding (HMAC, shared secret) carrying
  {user, file, session, role, expiry}. This is #108's fix shape, DECIDED
  by the owner 2026-10-24 ~02:30 PDT: gateway-attached signed binding,
  NOT service-side registry reads. The service verifies the signature and
  uses the endpoint it was given; it never reads the registry for binding.
  Each message carries a fresh binding, so there is no cached link on the
  service side to go stale.
- Because the service is internal, the gateway-attached binding is the
  service's ONLY source of binding info: browsers and clients cannot reach
  it directly to supply anything.
- SUPERSEDED (owner decision 2026-10-25, see §6): the internal-flip
  prerequisites above are no longer the direction. The leg-3 VPC design
  (gateway Direct VPC Egress + service ingress internal) was built,
  then dropped: the egress broke gateway outbound to Google APIs
  (sign-in down) while the gateway needs no non-Google outbound. The
  IAM posture in §6 is the end state; do NOT re-flip to internal
  without re-solving gateway outbound to Google APIs first.

## 4. MCP: public by design + same registry + permission checks

- MCP stays PUBLIC with its own direct ingress and self-authentication.
  It is NEVER moved behind the gateway and NEVER made internal. (Design
  law: MCP never behind the gateway.)
- MCP resolves file → owner engine instance from the SAME registry, the
  same way the gateway does (live owner → that instance; lease/epoch
  respected; stale/dead owners detected, not trusted).
- MCP checks authorization BEFORE routing: read vs write permission for
  its authenticated principal on that file; unauthorized → refuse before
  the engine is contacted. (Primary gate.)
- MCP calls the engine with a signed token the engine verifies per call
  (#104 secondary gate). MCP mints engine tokens with the shared signing
  secret, scoped user+file+session+role — the same pattern as the agent
  host's local minting. The MCP auth spec and the principal→file
  permission mapping are grounded in the repo's MCP spec by the
  implementing worker; no permission model is invented here.
- MCP's engine access is DIRECT (the engine validates the token itself),
  not proxied through the gateway data path — the same shape as the
  grid's direct signed link.

## 5. Validation standard (owner: "validate it properly")

- Local production-topology validation: MCP read + write routing to the
  correct engine instance; viewer-principal write refused before engine
  contact; stranger refused; no-live-session behavior proven;
  wrong-file-never proven (a request for file A never touches file B's
  engine); service binding via gateway-attached signed token proven
  (agent message reaches the correct engine; unsigned/tampered binding
  refused; service makes zero registry reads for binding).
- Tests: failed + related only, per testing economy; new suites for MCP
  routing and service binding.
- Post-deploy live checks (after the authorized deploy sequence): hosted
  MCP call routes to the live engine instance; hosted agent message via
  gateway-attached binding reaches the correct engine; service IAM
  posture verified (external direct hits refused 401/403, gateway path
  200) — see §6.
- NOT claimed without proof: browser legs (MCP/service are API paths, not
  UI); the IAM posture until the external-refusal + gateway-path-200
  checks in §6 are proven live.

## 6. AI service IAM posture (SUPERSEDES §3's leg-3 VPC design — owner decision 2026-10-25 ~01:41 PDT)

- POSTURE (end state): the AI service runs with ingress `all` AND Cloud
  Run authentication required: roles/run.invoker is granted ONLY to the
  gateway's service account (icecream-gateway@). The gateway presents a
  Google-issued ID token for the service URL on every proxied call
  (gateway/src/serviceIdToken.ts: metadata-server minting, cached per
  audience, 1h lifetime, refreshed before expiry). A caller without a
  valid token for that audience gets Cloud Run's own 401 before the
  request ever reaches the service container.
- SECOND GATE (unchanged): the app-layer signed binding (#108). The
  service verifies the gateway-attached signed binding on every agent
  call (user, file, session, role, expiry); a caller holding a valid
  Google token but no binding is still refused. IAM and binding are
  independent gates; neither alone is the whole posture.
- WHY THE VPC DESIGN WAS DROPPED: leg-3 (service ingress internal +
  gateway Direct VPC Egress all-traffic through subnet default) was
  deployed 2026-10-25 and broke gateway outbound to Google APIs: the
  subnet has no Cloud NAT and privateIpGoogleAccess=False, so the
  gateway could not fetch Google's certs and POST /auth/firebase
  returned 401 "invalid firebase id token: fetch failed" — no new
  sign-in could complete. The gateway needs no non-Google outbound
  (verified against gateway source: every outbound call is a Google
  API or a project backend service), so the subnet dependency bought
  nothing the IAM posture does not already provide. Removing the
  gateway's egress annotations restores direct outbound; no PGA, NAT,
  or subnet change is needed, and the shared default subnet is left
  intact (its deletion is NOT part of this switch).
- SWITCH ORDER (enforced 2026-10-25): (1) verify the live invoker grant
  is gateway-SA-only FIRST — it was, exactly one binding; (2) flip the
  service ingress internal → all; (3) remove the gateway's VPC egress
  annotations; verify at each step (agent path 200, sign-in 200,
  external direct hit refused). The reverse order would have broken
  the agent path in the gap.
- INVARIANT — READ BEFORE TOUCHING IAM: the invoker grant MUST stay
  gateway-SA-only. Any future broadening (allUsers,
  allAuthenticatedUsers, any additional account) removes the platform
  gate and is a SECURITY EVENT, not a routine change: it must be
  reported to the owner and justified before it is applied, never
  applied silently during debugging. The network layer is gone by
  design; the IAM grant is now the layer that keeps the service
  non-public.
- MCP is unaffected by this switch: it keeps its own direct ingress,
  self-authentication, and registry-based routing (§4).
