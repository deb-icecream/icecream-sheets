# Security Audit — Areas 4, 6, 7, 8 (read-only, NO fixes applied)

Worker: security AUDIT subagent. Scope: BRIEF.md areas 4 (Secrets), 6 (Web client),
7 (Transport/config), 8 (Dependencies). Method: repo-wide greps + targeted source
reads. No secret VALUES are printed anywhere below — names/locations only.

=====================================================================
## AREA 4 — Secrets

### 4(a) Vault seam discipline — PASS
- Marker re-run: `grep -rn "TESTSECRET" --exclude-dir=node_modules .` over the
  whole tree. The marker `TESTSECRET-ds-gallery-7f3a` appears ONLY where it is
  DEFINED as the test fixture: `apps/web/src/components/
  OpenDataSourceDialog.test.tsx:24` (const MARKER), `hidden_files/
  idea-datasource-gallery/run/tour.mjs:17`, `tour2.mjs:19`, `tour4.mjs:19`
  (const TOKEN), `hidden_files/shared-fixtures/rest-server.mjs:23`
  (FIXTURE_TOKEN for the local fixture REST server), plus documentation of
  the check in `hidden_files/idea-datasource-gallery/CONTRACT.md:99`,
  `hidden_files/shared-fixtures/README.md:49`, and `progress.md:83`
  (recording "0 hits in localStorage, all service logs, persisted bindings").
  It appears in NO persisted binding, NO localStorage dump, NO service log,
  and NO built dist — the vault-seam discipline the marker tests for holds.
  (Correction: an earlier draft of this section said the string "appears
  nowhere" — wrong; it appears as the fixture definition, never as leaked
  persisted state.)
- Test evidence confirms the intended shape: bindings persisted in tests carry
  `credentialRef: 'ref-1'` only; the secret value itself never appears in any
  persisted artifact (connectorSvc / connectors / OpenDataSourceDialog tests).
- Code: `packages/service/src/artifacts/gallery.ts:176-187` — share packages are
  deep-scanned and REJECTED on any credential-shaped key
  (`/connection|string|password|passwd|secret|token|credential|vault|api[-_]?key|auth/i`).
- `apps/web/src/features/dataSources.ts:69` — the client resolves a credential
  ONLY at runtime via `gateway.vaultRetrieve(ref)`; bindings/localStorage hold refs.
- `packages/service/src/secureStore.ts` (header, lines 1-55) — encrypted-at-rest
  layer (AES-256-GCM envelopes, per-workbook keys, fail-closed on tamper).
- Connection-string-with-password grep: only hits are test fixtures
  (`connectorSvc.test.ts` URL-parser fixtures with dummy `pw`) and a placeholder
  in `e2e-gateway.sh` comments (`postgres://user:password@host`). No real
  credential persisted. PASS.

### 4(b) Secret-shaped material in tree — PASS (one Low note)
- `BEGIN.*PRIVATE KEY`: verified with dist/node_modules-pruned scans of
  `packages/`, `apps/`, `deploy/`, `test-data/`, `samples/`, `specs/` source —
  ZERO hits. (The first whole-tree grep's hits were inside node_modules and
  minified bundle copies under hidden_files/roundtrip-audit — library/test
  material, not repo source.)
- API-key shapes (AIza…, sk-…, ghp_…, AKIA…): ZERO full-pattern matches in the
  same pruned source scans; the single full-pattern match in the wider tree
  is the value of `VITE_FIREBASE_API_KEY` (line 10) in the untracked
  `apps/web/.env.local` — a Firebase API key, public-identifier class, not a
  secret. AIza-prefixed strings otherwise exist only in three
  Firebase-config test files (`apps/desktop/tests/firebase-config.test.ts`,
  `apps/desktop/tests/firebase-login-page.test.ts`,
  `apps/web/src/services/firebaseConfig.test.ts`) — mock/shortened values of
  the public-identifier class, not secrets (per brief).
- `.env` files on disk: `apps/web/.env.local` + `apps/web/.env.example`;
  `git ls-files` shows NO tracked .env file. Variable NAMES in `.env.local`: VITE_FIREBASE_API_KEY,
  VITE_FIREBASE_AUTH_DOMAIN, VITE_FIREBASE_PROJECT_ID, VITE_FIREBASE_APP_ID,
  VITE_FIREBASE_MESSAGING_SENDER_ID, VITE_MCP_URL, VITE_MCP_TOKEN.
- High-entropy assignment grep: only test fixtures / dummy values
  (`password123` in adapter tests, `hunter2` in an agent-sandbox deny test,
  `test-secret` in a test-data YAML sample). Nothing real.
- FINDING 4-b (Low, informational): an unused `VITE_MCP_TOKEN` variable exists
  in `apps/web/.env.local`. It is NOT referenced anywhere in `apps/web/src`,
  `apps/web/scripts`, or `deploy/build-web.sh` (grep: zero hits), so it is not
  baked into the shipped bundle today — but any future `import.meta.env`
  use would embed a VITE_* value into public JS. Remediation: remove the
  variable from the env file; never put bearer tokens in VITE_* vars.

### 4(c) Deploy config + fallback secrets — FINDING (High) + FINDING (Low), rest PASS
PASS parts:
- All deploy secrets come from Secret Manager via `secretKeyRef` — no plaintext
  secret env values in `deploy/services/*.yaml`:
  gateway.yaml (AUTH_SECRET), mcp.yaml (MCP_AUTH_SECRET), service.yaml
  (VAULT_MASTER_KEY, ICECREAM_ADDON_TRUSTED_KEYS), engine-standard.yaml +
  engine-xl.yaml (ENGINE_SIGNING_SECRET). CONFIG.md:152-155 documents the four
  generated secrets as operator-env → Secret Manager.
- Dockerfiles (gateway/mcp/engine/service): no secret ENV/ARG baked in; only
  `ENV NODE_ENV=production`.
- VAULT_KEY: no hardcoded default — `packages/service/src/vault.ts:85-88`
  generates key material via the KeyStore when absent; prod delivery is the
  VAULT_MASTER_KEY Secret Manager ref above.
- ENGINE_SIGNING_SECRET: `engineAccessSecret()` (`packages/gateway/src/deploy/
  engineAccess.ts:67-68`) returns null when unset — no literal fallback.
- MCP shipped runner FAIL-CLOSES: `packages/mcp-server/src/bin/runner-config.ts:
  194-199` throws "refusing to start: MCP_AUTH_SECRET is not set";
  requireAuth is always true in the runner (:208, :218). Dockerfile.mcp CMD
  runs this bin.

- FINDING 4-c1 (High): Gateway ships a hardcoded fallback JWT secret.
  Evidence: `packages/gateway/src/bin/gateway.ts:43`
  `const authSecret = process.env.AUTH_SECRET ?? 'local-dev-secret';`
  lines 44-46 only `console.warn` when unset. This bin IS the production entry:
  `deploy/Dockerfile.gateway:83` `CMD ["node", "packages/gateway/dist/bin/
  gateway.js"]`. Compounding: the engine/storage signing secret falls back to
  this same auth secret when ENGINE_ACCESS_SECRET is unset
  (`packages/gateway/src/gateway.ts:347-348`, `bin/gateway.ts:143`).
  Documented in `deploy/CONFIG.md:187` ("Default `local-dev-secret` + warning
  if unset — production MUST set it"). The deploy YAML does set AUTH_SECRET
  from Secret Manager, so the deployed config is safe TODAY; the binary is
  fail-open if that binding is ever lost/misconfigured.
  Exploit sketch: AUTH_SECRET binding missing in a redeploy → gateway boots
  with the publicly known secret `local-dev-secret` → anyone mints valid
  gateway JWTs for arbitrary userIds (and forges engine signed URLs via the
  fallback chain) → full impersonation of any user.
  Remediation: fail closed in the bin (exit 1 when AUTH_SECRET unset and
  NODE_ENV=production / HOST=0.0.0.0), mirroring the MCP runner pattern.

- FINDING 4-c2 (Low): MCP library-level fallback secret + auth-off default.
  Evidence: `packages/mcp-server/src/http.ts:175`
  `const authSecret = opts.authSecret ?? process.env.MCP_AUTH_SECRET ?? 'local-dev-secret';`
  and :176 `const requireAuth = opts.requireAuth ?? false;`.
  The shipped runner overrides both and fail-closes (see PASS above), so this
  is a footgun for future embeddings of `createMcpHttpListener`, not a live
  prod hole. Remediation: remove the literal fallback from the library too.

### 4(d) Logging of secrets — PASS
- Greps for `console.*(token|password|secret|authorization)`, `req.headers`
  logging, and `authorization` logging across `packages/gateway/src`,
  `packages/mcp-server/src`, `packages/service/src`: ZERO hits. No service
  logs tokens, passwords, or authorization headers.

=====================================================================
## AREA 6 — Web client (apps/web/src)

### 6(a) XSS posture — PASS
dangerouslySetInnerHTML / innerHTML inventory (production code only):
- `components/Overlays.tsx:86` — `def?.svg`: static shape-definition bodies
  from an in-code table (not file/user controlled); fill/stroke go through
  React props.
- `components/Charts.tsx:349` — `buildMapSvg` output; per `Charts.tsx:324`
  the builder emits XML-escaped labels (service/shared chart builder).
- `components/SmartShapes.tsx:122` — static in-code ICONS bodies; user text in
  the same module is escaped (`escapeXml`, SmartShapes.tsx:61-62, used at
  :225/:240/:251/:259/:268/:289).
- `Grid.tsx:1287` — `sparklineSvg(...)`: generated from numeric cell data.
- `components/artifactFrame.ts:89` — innerHTML inside the sandboxed artifact
  document itself, with the error string escaped inline
  (`.replace(/&/g,'&amp;').replace(/</g,'&lt;')`).
- All other innerHTML hits are jsdom test setup (`document.body.innerHTML=''`).
Generated apps/artifacts (the real XSS boundary) are correctly isolated:
- `components/ArtifactHost.tsx:246-251` — `<iframe sandbox="allow-scripts"
  srcDoc={srcDoc}>`: allow-scripts WITHOUT allow-same-origin → opaque origin,
  cannot reach parent DOM/storage. `product/AppsGallery.test.tsx:172` asserts
  the same sandbox value for gallery frames.
- `components/artifactFrame.ts:27-28,118` — `escapeHtml` applied to the frame
  title; the builder throws if app source contains `</script` (second gate
  after the generator).

### 6(b) Deep-link / share-link handling — PASS
- `product/deepLink.ts:14-21` — `?file=` parsed as an opaque fileId; legacy
  `#file=` still read, search wins. `product/sharesApi.ts:129-132` — `?share=`
  parsed as an opaque share id. Both are then fetched through the
  authenticated gateway (server-side authz decides) — a crafted link can
  name an id, it cannot inject content or auto-run anything.
- Post-login return flow (`deepLink.ts` RETURN_FILE_KEY): only a fileId is
  stashed in sessionStorage, read-once after auth, navigation stays inside
  the app (origin + pathname + `?file=`). There is NO URL return/redirect
  parameter anywhere → no open-redirect surface.

### 6(c) Tokens in URLs / storage — FINDING (Medium) + FINDING (Low)
- FINDING 6-c1 (Medium): the gateway session JWT is stored in localStorage.
  Evidence: `apps/web/src/services/gatewayClient.ts:26`
  `TOKEN_KEY = 'icecream-sheets.gateway-token'`; :230 read at startup;
  :313 `localStorage.setItem(TOKEN_KEY, token)`. Token TTL is 12 hours by
  default (`packages/gateway/src/gateway.ts:317`, `loginTtlSeconds ?? 12*3600`).
  Any script executing in the app origin (XSS, compromised dependency,
  malicious extension) can exfiltrate a 12 h bearer token; the missing CSP
  (Finding 7-c) removes a layer of defense-in-depth. Remediation: shorten
  TTL / move to a memory-only token with refresh, or accept explicitly as a
  documented trade-off.
- FINDING 6-c2 (Low): engine access_token travels in query strings.
  Evidence: `apps/web/src/services/collabTransport.ts:490` (SSE
  `/deltas?access_token=…`), :1509/:1522 (release/presence beacons),
  `apps/web/src/services/signedEngineTransport.ts:441` (release beacon).
  Mitigations present in code: token TTL 600 s default
  (`packages/gateway/src/deploy/engineAccess.ts:73-74`), claims scoped
  {sub, sid, fid, role}, per-session rate cap on the engine. Residual
  exposure: URLs land in Cloud Run / proxy access logs and browser history.
  EventSource and sendBeacon cannot set Authorization headers, so no
  in-code alternative exists for these two transports; filed as Low /
  accepted-design with the log-exposure caveat.
- localStorage inventory (rest): settings, library metadata, chart/report/
  data-source stores, macros, queries — data + credential REFS only
  (see 4a). No connector credentials or other long-lived tokens at rest.
  PASS for everything except 6-c1.

### 6(d) Markdown/HTML rendering of agent replies — PASS
- No markdown renderer, no DOMPurify — and none needed: agent replies render
  as React text children (`components/AgentChat.tsx:494-497`, `{m.text}`),
  which React escapes. No raw-HTML path for agent or cell content was found.

=====================================================================
## AREA 7 — Transport/config

### 7(a) CORS — FINDING (Low)
- Gateway + engine surface: `packages/gateway/src/httpUtils.ts:49-53`
  `applyCors` sets `Access-Control-Allow-Origin: *`, methods
  GET/POST/PUT/DELETE/OPTIONS, headers `Content-Type, Authorization,
  x-principal`; used throughout `gateway.ts` and
  `services/engineSvc.ts` (the engine HTTP surface; engine containers run
  `packages/gateway/dist/bin/engine.js` per deploy/engine-entrypoint.sh).
- MCP: `packages/mcp-server/src/http.ts:263` sets
  `Access-Control-Allow-Origin: *` with the in-code comment at :262
  "PROD MUST lock Access-Control-Allow-Origin to the gateway origin" —
  the lock-down was never done.
- Mitigating fact (verified): NO service sets
  `Access-Control-Allow-Credentials`; auth is Bearer-header based, never
  cookies, so a cross-origin site cannot ride a victim's ambient
  credentials — it would need the token, which it cannot read cross-origin.
  Filed Low. Remediation: replace `*` with the explicit web-app origin
  allowlist on gateway/engine/MCP.

### 7(b) Rate limits — PASS (all wired, not just defined)
- Gateway global: limiter created at `gateway.ts:319` from
  `bin/gateway.ts:130-133` defaults (600 points / 60 s, env-overridable),
  enforced per principal on /api routes (`gateway.ts:707` → 429 +
  Retry-After).
- Auth endpoints: stricter per-IP buckets — `/auth/login`
  (`gateway.ts:496-499`) and `/auth/firebase` (`gateway.ts:529-532`).
- Engine per-session: `services/engineSvc.ts:3923-3931` — after token
  verification, `sessionRateLimiter.take(accessClaims.sid)` → 429
  'engine session rate limit exceeded'. Wired.
- MCP 6,000 tier: VERIFIED constant — `packages/mcp-server/src/http.ts:177`
  `opts.rateLimit ?? { points: 6000, perSeconds: 60 }`, limiter built and
  applied to the /mcp route in the same module.

### 7(c) Security headers — FINDING (Medium)
- `firebase.json` hosting headers set ONLY `X-Content-Type-Options: nosniff`
  and `Referrer-Policy: strict-origin-when-cross-origin` (plus cache rules).
- ABSENT everywhere (hosting config + `apps/web/index.html` meta):
  Content-Security-Policy, X-Frame-Options, and frame-ancestors. The hosted
  app is therefore frameable by any origin (clickjacking) and has no CSP
  backstop for the localStorage-token posture in 6-c1.
  Remediation (exact): add a headers block for source "**" in firebase.json:
  `Content-Security-Policy: default-src 'self'; frame-ancestors 'none';
  object-src 'none'; base-uri 'self'` (tuned to the app's Firebase/engine
  connect-src needs) and `X-Frame-Options: DENY`.

### 7(d) Error leakage — FINDING (Low); PASS on stack traces
- No stack traces returned anywhere: grep for `err.stack`/`*.stack` in
  response paths across gateway/mcp/service/engine → zero hits. PASS.
- Internal error MESSAGES are echoed to clients:
  `packages/gateway/src/gateway.ts:1529-1531` catch-all →
  `fail('anonymous', 500, 'gateway error: ' + msg)`;
  `packages/gateway/src/services/engineSvc.ts:5469`
  `sendError(res, 500, 'engine error: ' + msg)` and :5236 (download
  serialization failure incl. err.message);
  `packages/mcp-server/src/http.ts:297` JSON-RPC 500 carries
  `err.message`. Messages can disclose internal paths / upstream details.
  Filed Low. Remediation: generic client message + full detail to logs only.

=====================================================================
## AREA 8 — Dependencies

### npm audit — UNVERIFIED (tooling blocked)
`npm audit --json` at the repo root FAILS in this environment:
`npm warn audit 403 Forbidden - POST https://registry.npmjs.org/-/npm/v1/
security/audits/quick - policy_denied` / "npm error audit endpoint returned
an error". The registry audit endpoint is blocked by the environment proxy,
so no Critical/High counts could be produced. Re-run `npm audit` from a
network that permits the audit endpoint before relying on counts.

### FINDING 8-1 (High, version-based — NOT audit-confirmed)
- `xlsx` (SheetJS) pinned at **0.18.5**: `packages/xlsx-adapter/package.json:25`
  `"xlsx": "^0.18.5"`; package-lock resolves exactly 0.18.5.
- 0.18.5 predates the SheetJS fixes for CVE-2023-30533 (prototype pollution,
  fixed in 0.19.3) and CVE-2024-22363 (ReDoS, fixed in 0.20.2). The adapter
  parses UNTRUSTED uploaded workbooks server-side (engine open path), so
  both flaws are plausibly reachable in our usage.
  Exploit sketch: a user uploads a crafted .xlsx → prototype pollution in
  the engine/gateway process parsing it (or ReDoS stalling parse workers).
  Remediation (filed, NOT applied per orders): move xlsx-adapter to SheetJS
  >= 0.20.2 (distributed via the SheetJS CDN — npm no longer receives
  SheetJS updates) or replace the parser; re-run npm audit afterwards.
  Basis note: this finding rests on version comparison against the known
  CVE fix versions, because the audit endpoint was unreachable (above).

### Typosquat / malicious-name eyeball — PASS
Direct dependencies across root + all workspace package.json files:
fflate, hyperformula, @google-cloud/firestore, @modelcontextprotocol/sdk,
zod, chart.js, firebase, react, react-dom, vite, vitest, electron,
electron-builder, jsdom, axe-core, typescript — all well-known legitimate
packages under their canonical names/scopes. Nothing suspicious.

=====================================================================
## Summary of verdicts
- Area 4: PASS except 4-c1 (High, fail-open AUTH_SECRET fallback in the
  shipped gateway bin), 4-c2 (Low, MCP library fallback), 4-b note (Low).
- Area 6: PASS except 6-c1 (Medium, 12 h gateway JWT in localStorage),
  6-c2 (Low, access_token in SSE/beacon URLs — mitigated, design-bound).
- Area 7: PASS on rate limits + stack traces; 7-a (Low, wildcard CORS,
  no credentials), 7-c (Medium, no CSP / frame protection on Hosting),
  7-d (Low, internal error messages echoed to clients).
- Area 8: audit counts UNVERIFIED (registry 403 policy_denied);
  8-1 (High, xlsx 0.18.5 vs CVE-2023-30533 / CVE-2024-22363, untrusted-
  upload parser); dependency-name eyeball PASS.
No code was changed; nothing was pushed; the shared stack was not touched.
