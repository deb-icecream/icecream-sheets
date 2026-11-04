# deploy/ — icecream-sheets production deployment (GCP / Firebase)

Implements `design-docs/deployment-architecture.md`. Nothing here deploys
without the operator's credentials — see the gate in `deploy.sh` and the
full inventory in `CONFIG.md`.

## Layout

| Path | What |
|---|---|
| `Dockerfile.gateway` / `Dockerfile.engine` / `Dockerfile.service` / `Dockerfile.mcp` | One multi-stage image per deployed unit (Node 20 slim runtime, non-root `node` user, production deps only, `/health` checks) |
| `engine-entrypoint.sh` | Engine heap discipline: `--expose-gc --max-old-space-size=$ENGINE_HEAP_MB` (mirrors the local `start:engine` script, sized per tier) |
| `service-entrypoint.sh` | Selects the service image's bin from `SERVICE_BIN` (`service` = the combined runner in the deployed definition; per-bin values kept for local debugging), fails closed on unknown values |
| `services/*.yaml` | One Cloud Run service definition per deployed service — five files for the five services (the canonical spec; `deploy.sh` renders + applies them) |
| `deploy.sh` | The deploy: gate → APIs → registry/buckets/Firestore → SAs/IAM → secrets → Cloud Build images → services → web. `--dry-run` prints every command and executes nothing |
| `build-web.sh` | Web production build; requires `VITE_GATEWAY_URL`, outputs `apps/web/dist` |
| `CONFIG.md` | Every env var / secret, cross-checked against the code |
| `.firebaserc.template` | Copy to repo root as `.firebaserc`, fill in the Firebase project id |
| `../firebase.json` | Firebase Hosting: serves `apps/web/dist`, immutable caching for hashed assets, `no-cache` for `index.html`, SPA rewrite to `/index.html` |

## Image ↔ bin mapping (the decision)

`packages/gateway` contains **eight** bins (incl. the combined
`service` runner); `packages/mcp-server` one HTTP bin. Four images cover
all of them. The deployed inventory is **FIVE Cloud Run services total**
(user's clarification, 2026-10-20):

| Image | Bin(s) | Cloud Run service(s) |
|---|---|---|
| `Dockerfile.gateway` | `packages/gateway/dist/bin/gateway.js` | `gateway` |
| `Dockerfile.engine` | `packages/gateway/dist/bin/engine.js` (via entrypoint, heap per tier) | `engine-standard` × 5 — same image, five services (XL retired 2026-10-24) |
| `Dockerfile.service` | `packages/gateway/dist/bin/service.js` — the **combined runner** (W17b `servicePackage.ts`: vault, meta, etl, agent, addons in ONE process behind `/api/<name>` prefixes), chosen by `SERVICE_BIN=service` | `service` — ONE service. The per-bin values (`vault`/`meta`/`etl`/`agent`/`addons`) remain selectable via the same entrypoint for local debugging only; no deployed definition uses them |
| `Dockerfile.mcp` | `packages/mcp-server/dist/bin/http.js` | `mcp` |

Gateway wiring for the combined service (W17b §4): the gateway's five
service-family upstreams (`VAULT_URL`, `META_URL`, `ETL_URL`, `AGENT_URL`,
`ADDONS_URL` in `services/gateway.yaml`) all point at the single
`service` URL — the combined dispatcher's accepted `/api/<name>/...`
form — while `/api/engine/*` still routes to the engine tiers
(longest-prefix match).

## Sizing & concurrency (summary — rationale lives in the YAML headers)

- **Everywhere:** min-instances 0 / scale-to-zero (doc mandate), gen2
  execution environment, startup CPU boost, timeout 3600 s where long
  operations flow.
- **Engine:** standard 4 vCPU / 16 GiB, XL 8 vCPU / 32 GiB (the platform
  maximum), CPU **always allocated** (background recalc/snapshots must not
  be throttled between requests), **concurrency 1** — the engine process
  holds one workbook session's state today, so one in-flight request per
  instance is a correctness constraint, not just tuning; scale-out is
  more instances under the session registry.
- **Gateway:** 1 vCPU / 512 MiB, concurrency 80 — stateless validation +
  proxying only; signed-URL issuance moves engine data traffic off it.
- **Service (combined package):** 2 vCPU / 4 GiB, concurrency 20 —
  W17a's service-family medium tier (the size W17a gave the heavy etl /
  agent surfaces; the combined process must fit its heaviest surface).
  Stateless, min-instances 0, nothing persists between requests.
- **MCP:** 2 vCPU / 4 GiB, concurrency 80, own ingress, self-authenticated
  — never behind the gateway.

## Billing / storage model

- **GCP project (GCP credit funds it):** the 5 Cloud Run services,
  Cloud Storage, Firestore, Secret Manager. Scale-to-zero keeps burn
  minimal.
- **Files + snapshots → GCP Cloud Storage** (`<project>-icecream-files`,
  `<project>-icecream-snapshots`, created by `deploy.sh` in the GCP
  project; services write via the GCP service account). **NOT Firebase
  Storage** — no Firebase Storage bucket is provisioned anywhere.
- **Production load path (user ruling, 2026-10-21):** a third bucket,
  `<project>-icecream-uploads` (also created by `deploy.sh`), stages
  direct uploads — the gateway issues a short-lived signed PUT URL
  (same auth + rate-limit checks as engine-access issuance), the client
  uploads bytes straight to GCS, and the engine pulls the object via
  its service account. No file bytes flow through gateway/engine
  request bodies, so Cloud Run's 32 MiB HTTP/1 request cap is moot for
  loads. Full design + what exists vs code follow-on: `CONFIG.md`,
  "Production load path" section.
- **Firestore → free quotas** (1 GiB stored, 50k reads/day, 20k
  writes/day, 10 GiB/mo egress): metadata, session registry, op journal.
  The journal batches one write per segment in code (W17b
  `sessionStore.ts`), sized for the write quota.
- **Firebase project → FREE plan, Hosting + Auth only.**

## Tooling (on the Muse VM, persistent under `~/workspace/tools/`)

```bash
~/workspace/tools/google-cloud-sdk/bin/gcloud --version   # Google Cloud SDK 590.0.0
~/workspace/tools/firebase/node_modules/.bin/firebase --version
```

Installed from the official gcloud tarball and `npm install firebase-tools`
(local prefix) at deploy-prep time. Neither is authenticated — the two
one-time sign-ins (GCP service account, Firebase CI token) go into the
Secure Vault and are supplied as env at deploy time (see `CONFIG.md`).

## Local image builds

Docker is **not installed on the Muse VM** and production builds run
through Cloud Build (`deploy.sh` step 6), so no local build is required.
On a machine with Docker:

```bash
docker build -f deploy/Dockerfile.gateway -t icecream-gateway .   # context = repo root
```
