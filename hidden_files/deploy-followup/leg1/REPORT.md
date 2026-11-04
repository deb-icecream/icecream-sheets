# Leg 1 — Gateway Google ID-token for service-family proxy — FINAL REPORT

Status: **DONE** (code + tests only; no deploy, no git push; progress.md untouched)
Date: 2026-10-22

## The defect
POST /api/agent/message (and every service-family route) with a valid gateway JWT returned Cloud Run's platform 401 HTML on the deployed stack: deploy.sh grants `roles/run.invoker` on `icecream-sheet-service` ONLY to the gateway SA, but the gateway's proxy attached no Google ID token — Cloud Run rejected the request at the platform layer before the service ever ran. Locally all upstreams are http + unauthenticated, so no local test caught it.

## Files changed
1. **`packages/gateway/src/serviceIdToken.ts` (NEW)** — `createMetadataIdTokenProvider()` + helpers (`idTokenExpiryMs`, `metadataIdentityUrl`, `ServiceIdTokenProvider` type).
2. **`packages/gateway/src/gateway.ts`** — imports the provider; new `GatewayOptions.serviceIdTokenProvider`; token resolution at the single proxy call site; `proxy()` gains `opts.serviceIdToken` and sets the Authorization header. The recent http/https transport-by-`target.protocol` fix in `proxy()` is untouched.
3. **`packages/gateway/src/index.ts`** — re-exports the provider, helpers, and types.
4. **`packages/gateway/tests/serviceIdToken.test.ts` (NEW)** — 8 tests (below).

No bin change needed: `createGateway` defaults `serviceIdTokenProvider` to the metadata provider, so the shipped `bin/gateway.ts` picks the fix up with zero wiring. No deploy YAML changed (see Residuals).

## How the token is fetched / cached
- Fetch: `GET http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=<url>&format=full` with header `Metadata-Flavor: Google`; body is the raw ID-token JWT. 2s abort timeout (mirrors vertexToken.ts posture).
- Audience = `new URL(backend).origin` for the request's actual upstream — the target service's URL.
- Cache: in-memory, per-audience `Map`; expiry taken from the token's own `exp` claim (fallback 1h when undecodable); refreshed once within 5 min of expiry; concurrent lookups for one audience dedup in-flight.
- Fail-soft: any fetch error / non-OK / empty body → `null`, with a 30s negative cache (local dev doesn't pay a dead lookup per request; a transient prod failure retries within 30s instead of pinning). Null → the request is proxied **exactly as before this fix** (gateway JWT forwarded, nothing replaced). Tokens live 1h per Google; nothing is persisted or logged.

## Which upstreams get it
Service-family routes only — `SERVICE_FAMILY_ROUTE_PREFIXES` (gateway.ts): `/api/vault`, `/api/meta`, `/api/etl`, `/api/agent`, `/api/addons`, `/api/connectors`, `/api/automation` — and only while the request is still headed for its **configured** route backend:
- Route env vars (bin/gateway.ts): VAULT_URL, META_URL, ETL_URL, AGENT_URL, ADDONS_URL, CONNECTOR_URL, AUTOMATION_URL. In production (deploy/services/gateway.yaml) VAULT/META/ETL/AGENT/ADDONS_URL all = `${SERVICE_URL}` (the one combined `icecream-sheet-service`), so one audience serves all five; per-bin local topologies would get per-bin audiences from the routes table, and locally the provider returns null anyway.
- **NOT the engine**: `/api/engine` never gets an ID token and the provider is never consulted for it (engines use the signed-URL direct flow + their own token verification; the gateway's engine-adjacent `/session/claim` fetch is likewise untouched).
- **NOT automation owner-routes**: when `/api/automation?fileId=…` is owner-routed to a live ENGINE `ownerEndpoint`, no ID token is attached (a signed-mode engine would parse it as a malformed engine-access token). Pinned by a dedicated test.

## How end-user identity is preserved
- Verified during mapping: every service surface reads identity from **`x-principal`** (`httpUtils.requestPrincipal`; automationSvc fail-closes 401 without it). `proxy()` sets `x-principal` from the gateway-verified JWT principal on every request — unchanged, and set BEFORE the Authorization replacement.
- On service-family requests WITH a token, `Authorization` is REPLACED (the caller's gateway JWT → `Bearer <Google ID token>`), because Cloud Run's platform invoker check consumes exactly that slot — leaving the gateway JWT there IS the 401.
- The one service consumer of the forwarded Authorization, the add-on /run binding resolver, provably does not need it: the production resolver (`createProductionAddonResolveBinding`, addonEngineBinding.ts, FIX-R3) ignores `reqCtx.authorization` and mints its own engine-access token, with the standing comment that the gateway JWT must NEVER be forwarded to a signed-mode engine. Cookies and all other inbound headers pass through untouched.

## Tests — exact counts
- New suite `tests/serviceIdToken.test.ts`: **8/8 passed**. Covers: metadata URL/audience encoding + `Metadata-Flavor` header; per-audience caching (repeat call = 1 fetch; new audience = new fetch); refresh inside the 5-min skew (fake clock); fail-soft null + 30s negative cache + retry; non-OK → null; `exp` decoding; proxy attaches token for `/api/agent` + `/api/meta` (each with its own origin audience) and NOT for `/api/engine` (gateway JWT passes through, provider never called); provider-null leaves service requests byte-identical to pre-fix behavior; automation owner-route to an engine gets NO token while the same route without a live owner DOES.
- Related suites (`combinedProxy`, `gateway`, `servicePackage`, `vertexToken`, `automationSvc`, `agentBinding`): **6 files, 63/63 passed**.
- Full gateway suite: **45/46 files, 444/445 tests passed**. The 1 failure is PRE-EXISTING and unrelated: `tests/services.test.ts > agent service > human-in-the-loop over HTTP: /pending → /answer unblocks the parked turn` (afterEach hook timeout 10s, plus an asks-options assertion; reproduces in isolation, 15/16 in that file). Proof of independence: that test imports only the vault/meta/etl/agent listeners + helpers — its import graph contains none of the files changed here (gateway.ts, index.ts, serviceIdToken.ts all absent). Not fixed here (out of this leg's scope).
- `tsc -p packages/gateway/tsconfig.json --noEmit`: **exit 0, no errors**.

## Residuals / for the coordinator
1. **gateway.yaml still does not set CONNECTOR_URL / AUTOMATION_URL** — in the deployed gateway they fall back to `http://127.0.0.1:8108` inside the gateway container, so `/api/connectors` and non-owner-routed `/api/automation` cannot reach the service even with this token fix. The combined service DOES host both surfaces (servicePackage.ts). One-line-per-var YAML fix (`value: ${SERVICE_URL}` ×2) at redeploy time; left untouched here because this leg was scoped to gateway code + tests and "do not deploy".
2. The Cloud Scheduler automation tick goes DIRECT to the service with its own OIDC (tickAuth.ts) — not via the gateway — and is unaffected by this change.
3. End-to-end proof on the deployed stack (gateway JWT → 200 from the service, not platform 401) can only happen after the coordinator rebuilds + redeploys the gateway image; locally the metadata server does not exist, so the deployed-path behavior is pinned by the fake-metadata + fake-provider tests above.
