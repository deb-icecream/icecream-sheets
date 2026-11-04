# Services & Gateway — topology, runbook, prod notes

Local-dev deployment of the icecream-sheets web-service boundary:
one API gateway in front of five backend services (plus a reserved
route for the sibling agent's MCP-over-HTTP service).

## Topology

| Service | Port | Runner | Endpoints |
|---|---|---|---|
| gateway | 8100 | `dist/bin/gateway.js` | `POST /auth/login`, `GET /auth/me`, `GET /auth/__audit`, `/api/*` proxy |
| engine | 8101 | `dist/bin/engine.js` | `GET /health`, `POST /execute`, `POST /read`, `GET /snapshot`, `GET /events`, `POST /load`, `POST /reset`, `POST /protection/hide`, `POST /protection/protect` |
| vault | 8102 | `dist/bin/vault.js` | `GET /health`, `POST /store`, `POST /retrieve`, `POST /revoke`, `GET /refs` |
| meta | 8103 | `dist/bin/meta.js` | `GET /health`, `GET /kv/:key`, `PUT /kv/:key`, `DELETE /kv/:key` |
| etl | 8104 | `dist/bin/etl.js` | `GET /health`, `POST /run` |
| agent | 8105 | `dist/bin/agent.js` | `GET /health`, `POST /message`, `GET /audit?threadId=` |
| mcp | 8106 | (sibling agent) | **Reserved route** — `/api/mcp` proxies here; 502 until the sibling's MCP-over-HTTP service exists. The desktop does NOT use this route: it runs the MCP server's own direct ingress on loopback itself (platform-shell.md §8) and connects straight to it. |

Gateway route table: `/api/engine` → 8101, `/api/vault` → 8102,
`/api/meta` → 8103, `/api/etl` → 8104, `/api/agent` → 8105,
`/api/mcp` → 8106 (reserved; desktop bypasses the gateway for MCP entirely).

## Running (local end-to-end)

Build once from the repo root:

```bash
npm run build --workspace=@icecream-sheets/gateway
```

Then start each process (each honors `PORT`; defaults shown).
From `packages/gateway/`:

```bash
node dist/bin/engine.js   # PORT=8101
node dist/bin/vault.js    # PORT=8102
node dist/bin/meta.js     # PORT=8103
node dist/bin/etl.js      # PORT=8104
node dist/bin/agent.js    # PORT=8105
node dist/bin/gateway.js  # PORT=8100
```

Or start everything in-process (tests / single-terminal dev):

```ts
import { startAllLocal } from '@icecream-sheets/gateway';
const { close } = await startAllLocal(); // all six on 127.0.0.1, defaults above
// … run end-to-end …
await close();
```

`startAllLocal({ ports, authSecret, rateLimit, host })` overrides ports/secret.

Gateway env knobs: `AUTH_SECRET` (JWT HMAC secret), `ENGINE_URL`,
`VAULT_URL`, `META_URL`, `ETL_URL`, `AGENT_URL`, `MCP_URL`,
`RATE_LIMIT_POINTS` (default 600), `RATE_LIMIT_WINDOW` (seconds, default 60).

### Quick smoke test

```bash
# 1. start all six (separate terminals, or startAllLocal)
# 2. mint a dev token
TOKEN=$(curl -s -X POST localhost:8100/auth/login \
  -H 'Content-Type: application/json' -d '{"userId":"alice"}' | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).token")
# 3. write + read a cell through the gateway → engine service
curl -s -X POST localhost:8100/api/engine/execute \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"cmd":{"cmd":"setCell","ref":{"sheet":"Sheet1","row":0,"col":0},"value":42}}'
curl -s -X POST localhost:8100/api/engine/read \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"kind":"cell","ref":{"sheet":"Sheet1","row":0,"col":0}}'
# 4. chat with the agent through the gateway
curl -s -X POST localhost:8100/api/agent/message \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"hello"}'
```

Note: engine `CellRef`/`RangeRef` are **0-based** (`{row:0,col:0}` = A1),
matching the engine protocol.

## Auth model

- The JWT carries **identity only** (`userId` + coarse attrs) — never
  per-object permissions (permission-model.md §5).
- `POST /auth/login` is **LOCAL-DEV ONLY**: it mints a token for any
  `userId`. Production replaces it with the real IdP (Firebase Auth /
  GCP IAM); never accept arbitrary userIds in prod.
- Every `/api/*` request needs `Authorization: Bearer <jwt>` → 401
  missing/malformed/expired/bad-signature (fail closed). The verified
  `user:<userId>` principal is forwarded as `x-principal` (plus the
  original Authorization header).
- Rate limiting is per principal (token bucket); 429 carries
  `Retry-After`.
- Request audit: method, path, principal, status, duration — console +
  in-memory ring buffer (`GET /auth/__audit`, tests via
  `listener.auditLog`).

## Prod notes (GCP)

- **Gateway**: Cloud Run / GKE behind a GCP HTTPS load balancer; TLS at
  the edge; real IdP replaces `/auth/login`; `AUTH_SECRET` (or the IdP
  public keys) from Secret Manager; rate-limit state moves to a shared
  store (Redis/Memorystore) when running >1 gateway replica.
- **Services**: one Cloud Run service per backend (engine, vault, meta,
  etl, agent, mcp), private ingress, gateway as the only caller.
  Service-to-service auth: the gateway's `x-principal` + Authorization
  forwarding is kept; add mTLS/IAM between gateway and backends.
- **Vault**: in-memory today — prod persists ciphertext + key records in
  the service metadata store backend, master key from GCP KMS
  (envelope encryption).
- **Meta**: in-memory today — prod uses the durable service metadata
  store (encrypted at rest, per workbook-protection-and-encryption.md §3).
- **ETL**: prod wires the real connector registry
  (`packages/service/src/connectors/`), the vault service as the
  credential resolver, and `checkPermission` enforcing
  design-docs/etl-pipeline.md §6 (read on credential + write on target).
- **Web app**: Firebase Hosting; desktop ships the engine locally and
  calls the deployed services only after user login (logged-out desktop =
  local engine features only).
- **CORS**: `*` is local-dev only; lock to the Hosting origin in prod.
