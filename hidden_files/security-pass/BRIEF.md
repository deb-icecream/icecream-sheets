# Security Pass — icecream-sheets (user directive 2026-10-22 ~04:19 PDT)

The user ordered a security pass on the code, in parallel with the first deploy
("we can deploy now but security pass on the code is still needed"). This pass
AUDITS, FIXES what is clearly in scope, and FILES the rest with exact evidence.
It does not gate the deploy; Critical/High findings are fixed fast and reported
to the parent the moment they are confirmed.

## Surface to cover (the deployed system)

Five Cloud Run services (gateway, engine-standard, engine-xl, MCP, service)
+ Firebase Hosting web app. Repo: ~/workspace/icecream-sheets.

## Audit areas (each with file:line evidence for every claim)

1. **AuthN** — Firebase ID-token verification at the gateway (`POST /auth/firebase`);
   our JWT issuance/verification (AUTH_SECRET); engine signed-URL tokens
   (issuance, scope: user+file+session+role, TTL, engine-side validation);
   MCP bearer auth (fail-closed — re-verify, don't assume the earlier fix);
   add-on/agent token minting (role-scoped since FIX-R2/R3 — verify).
2. **AuthZ** — the authorize() choke point: route inventory across gateway /
   engine / MCP / service — every route either goes through authorize() or is
   provably public-by-design; ownership checks on files/shares/library entries
   (non-owner = 404 pattern); tier enforcement server-side; viewer-role write
   gates (/ops, /charts, /execute — verify all three).
3. **Session/registry** — claim transactions, ownershipEpoch fencing, join
   token scope, fail-closed behavior when the registry DB is unreachable.
4. **Secrets** — vault seam discipline (connector credentials: refs only,
   never persisted/logged — re-run the marker-style grep); scan built dists
   and the repo tree for secret-shaped material; Secret Manager usage in
   deploy config; the known file-write redaction hazard is NOT a finding
   unless it leaks a real secret.
5. **Input / injection** — upload path (format validation, size/count caps,
   zip handling in adapters — zip-slip / billion-laughs posture); SQL
   connector (read-only, single-statement enforcement); URL data sources
   (SSRF posture: what stops a connector fetching metadata endpoints /
   localhost?); formula/parser surfaces where cheap to check.
6. **Web client** — XSS posture for rendered content (cell text, names,
   generated apps/artifacts: iframe sandboxing + CSP if any); deep-link /
   share-link handling; tokens in URLs (engine access_token in query —
   assess logging exposure); localStorage contents (no credentials).
7. **Transport/config** — CORS policy per service; rate limits (gateway +
   per-session engine + MCP 6,000 tier); security headers on Hosting;
   error responses leaking internals (stack traces, paths).
8. **Dependencies** — npm audit across packages (report Critical/High with
   reachability notes; do not mass-upgrade — file, don't churn).

## Rules

- Evidence or it didn't happen: every finding cites file:line or a live
  request/response against a local stack you start on your own ports.
- Severity: Critical / High / Medium / Low, with a one-line exploit sketch
  for Critical/High (who, what's needed, what they get).
- Fix in scope: Criticals and Highs that are small, local, and clearly
  correct (same standard as the defect sweeps) — each with a regression
  test. Anything architectural, or anything touching the deploy tree's
  behavior, gets FILED with an exact remediation for the parent instead.
- Do NOT disturb: the shared 8100 stack (agent re-run), the deploy run,
  running tours. Your own isolated ports for any live probing.
- Do NOT touch progress.md. Do NOT git push.
- Checkpoint protocol: create hidden_files/security-pass/REPORT.md FIRST
  (skeleton: areas 1–8 PENDING), update after each area, verify writes
  on disk.

## Deliverable

hidden_files/security-pass/REPORT.md — per-area verdicts, a findings table
(severity, location, evidence, status: fixed+test / filed+remediation),
and a final list of what remains open after your fixes.
