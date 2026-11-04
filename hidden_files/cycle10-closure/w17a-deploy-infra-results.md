# W17a — Deployment-prep infrastructure results (2026-10-20)

Worker: deployment-prep INFRASTRUCTURE (W17a). Spec followed exactly:
`design-docs/deployment-architecture.md` (read first, plus AGENT.md §0).
Scope honored: no product source touched (`apps/web/src`, `packages/*/src`
untouched — only new `deploy/`, root `firebase.json`, tooling, this file).
No GitHub push. No authenticated gcloud/firebase command was run.
No perf loads, no browser work. Docker builds: **deferred twice over** —
(a) docker is not installed on this VM, (b) free RAM was 1 GiB free /
3 GiB available at start and fell to ~0.8 GiB available while B5's P99
work ran (rule: defer under 3 GiB free; B5 has RAM priority). Production
image builds are via Cloud Build in `deploy.sh` step 6, so no local
docker is needed at deploy time.

## 1. Tooling — installed, persistent, verified, NOT authenticated

| Tool | Location | Version (verified) |
|---|---|---|
| gcloud SDK | `~/workspace/tools/google-cloud-sdk/bin/gcloud` (official tarball, `--path-update=false`) | **Google Cloud SDK 590.0.0** (core 2026.10.16, gsutil 5.37, bq 2.1.40) |
| firebase-tools | `~/workspace/tools/firebase/node_modules/.bin/firebase` (npm, local prefix `~/workspace/tools/firebase`) | **15.34.0** (633 packages installed) |

Neither tool has been authenticated; no credentials exist yet (the gate).

## 2. Dockerfiles — `deploy/` (build context = repo root for all)

Node version: repo `package.json` engines `>=20` (no `.nvmrc`) → pinned
`node:20-bookworm-slim` in both stages. All images: multi-stage (tsc build
from source → slim runtime), **only production deps** in the final stage
(`npm ci` in build, `npm prune --omit=dev`, runtime copies pruned tree),
**non-root** (`USER node`), `EXPOSE 8080`, Docker `HEALTHCHECK` hitting
`/health` for local use (Cloud Run itself uses the YAML probes).
Per-image `.dockerignore` files sit beside each Dockerfile.

### Image ↔ bin mapping (the decision)

`packages/gateway` ships 7 bins; `packages/mcp-server` 1 HTTP bin.
Four images cover everything:

| Image | Starts | Cloud Run service(s) |
|---|---|---|
| `Dockerfile.gateway` | `packages/gateway/dist/bin/gateway.js` | `gateway` |
| `Dockerfile.engine` | `packages/gateway/dist/bin/engine.js` via `deploy/engine-entrypoint.sh` | `engine-standard`, `engine-xl` (same image) |
| `Dockerfile.service` | one of `dist/bin/{vault,meta,etl,agent,addons}.js`, selected by `SERVICE_BIN` env via `deploy/service-entrypoint.sh` (fails closed, exit 64, on unset/unknown) | `service-vault`, `service-meta`, `service-etl`, `service-agent`, `service-addons` |
| `Dockerfile.mcp` | `packages/mcp-server/dist/bin/http.js` | `mcp` |

Rationale for the service-family mapping: the five bins live in **one
package with one dependency chain**, so one image is the honest unit;
Cloud Run runs exactly one process per container, so the per-service
differentiation is an env selection (`SERVICE_BIN`), sizing, and secrets
in each service's own YAML. Rejected alternative (five near-identical
Dockerfiles) would quintuple build time for zero isolation gain — the
isolation boundary on Cloud Run is the service, not the image.

Engine heap discipline: local stack runs
`node --expose-gc --max-old-space-size=6144 dist/bin/engine.js`
(`packages/gateway/package.json` `start:engine`). The entrypoint keeps
`--expose-gc` and takes the size from `ENGINE_HEAP_MB` (default 6144 =
exact local behavior): **12288** on standard (75% of 16 GiB), **24576**
on XL (75% of 32 GiB) — headroom left for parse worker threads, the MT
recalc pool, and tmpfs.

Extras in runtime images, from the code: `ca-certificates` (gateway
verifies Firebase ID tokens against Google certs), `python3` +
`python3-venv` in service + mcp images (both packages' Python sandboxes
shell out to `python3` and lazily provision a venv).

### PORT verification — ⚠ CODE GAP FOR W17b (not fixed here, per scope)

Every bin **does** read `process.env.PORT` (gateway 8100, engine 8101,
vault 8102, meta 8103, etl 8104, agent 8105, mcp 8106, addons 8107
defaults) — Cloud Run's injected `PORT` will be honored. **But every bin
hardcodes the bind host to `127.0.0.1`:**

- `packages/gateway/src/bin/{gateway,engine,vault,meta,etl,agent,addons}.ts`:
  `server.listen(port, '127.0.0.1', …)`
- `packages/mcp-server/src/bin/http.ts` → `startMcpHttp(port)` whose
  `host` parameter defaults to `'127.0.0.1'` (`packages/mcp-server/src/http.ts:307`)

Cloud Run's container contract requires listening on **0.0.0.0:$PORT**;
loopback-only binding fails the startup probe / receives no traffic.
Fix belongs to W17b: e.g. `HOST` env (default `127.0.0.1` locally,
`0.0.0.0` set in the service YAMLs), or bind `0.0.0.0` when `PORT` is
platform-injected. **This blocks the first real deploy's startup probes**
for all 9 services until landed. (The MCP source comment already
anticipates wider binding "with requireAuth + a real secret" — production
`MCP_AUTH_SECRET` from Secret Manager satisfies that precondition.)

Two further product-side gaps surfaced by the deploy definitions
(flagged, not fixed): (a) engine persistence is still local-disk
(`ICECREAM_DATA_DIR`, `filePersistence.ts`) — on Cloud Run that's
in-memory tmpfs counting against the instance memory limit; the doc's
Cloud Storage + Firestore session-registry/op-journal/snapshot backing
is W17b/product work; (b) the gateway's backend proxy sends no Google
ID token, while the service-family YAMLs restrict `run.invoker` to the
gateway's service account — the gateway needs ID-token minting for
backend calls before the family is reachable in production posture.

## 3. Cloud Run definitions + deploy script — `deploy/`

- `deploy/services/*.yaml` — 9 rendered-by-envsubst service definitions
  (gateway, engine-standard, engine-xl, mcp, service-{vault,meta,etl,
  agent,addons}); **all validated**: every YAML parses, and a full
  envsubst render test left zero unsubstituted placeholders.
- `deploy/deploy.sh` — `set -euo pipefail`; `--dry-run` prints every
  command and executes nothing (**tested: 73 commands printed, exit 0**);
  without the required env it **stops at the credential gate with the
  exact missing list, exit 78, deploying nothing (tested)**.
  Steps: APIs → Artifact Registry → **Cloud Storage buckets (file bytes
  + snapshots) and Firestore creation, scripted-but-gated** (they run
  only inside a real, credentialed deploy) → service accounts + IAM →
  Secret Manager secrets (created on first deploy only, values piped via
  stdin from operator env, never on a command line, never echoed) →
  Cloud Build image builds → services in dependency order
  (engines → service family → mcp → gateway, URLs captured and injected)
  → web build + Firebase Hosting.

### Sizing / concurrency choices (all min-instances 0, scale-to-zero)

| Service | CPU / Mem | Concurrency | Timeout | Why |
|---|---|---|---|---|
| gateway | 1 / 512 MiB | 80 | 3600 s | Stateless auth + proxy only; doc's 600 s-class traffic |
| engine-standard | 4 / 16 GiB | **1** | 3600 s | Doc tier. Concurrency 1 is **correctness today**: `engineSvc.ts` holds ONE session state per process; scale = more instances under the session registry. CPU always-allocated (`cpu-throttling: false`) for background recalc / snapshot / journal work between requests |
| engine-xl | 8 / 32 GiB | **1** | 3600 s | Doc tier — also the platform maximum (see §5) |
| mcp | 2 / 4 GiB | 80 | 3600 s | Own direct ingress, self-authenticates, never behind gateway |
| service-vault / meta | 1 / 1 GiB | 80 | 3600 s | Small stateless services |
| service-etl | 2 / 4 GiB | 10 | 3600 s | Heavy batch-shaped pipelines + Python sandbox |
| service-agent | 2 / 4 GiB | 20 | 3600 s | LLM I/O-bound |
| service-addons | 1 / 2 GiB | 80 | 3600 s | Binding resolution proxies to engine |

Engine maxScale 20 (std) / 10 (xl) as cost guardrails under the default
100-instances/project/region quota. Ingress postures: gateway public
(it is the auth point); engine + mcp platform-open with **in-process**
auth (signed URL / MCP secret) exactly as the doc prescribes; service
family invoker restricted to the gateway service account.

## 4. Firebase Hosting

- `firebase.json` (repo root): hosting serves `apps/web/dist`; immutable
  1-year cache for `/assets/**` and hashed static extensions; `no-cache,
  must-revalidate` for `/index.html`; SPA rewrite `** → /index.html`;
  `nosniff` + referrer-policy headers. JSON validated.
- `deploy/.firebaserc.template`: placeholder project, copy to repo root.
- `deploy/build-web.sh`: requires `VITE_GATEWAY_URL` and **refuses to
  build without it** (a bundle without it would silently run the rejected
  browser-local mode); deploy.sh feeds it the just-deployed gateway URL,
  then `firebase deploy --only hosting` with `FIREBASE_TOKEN`.

## 5. Platform-limit check (official docs, checked 2026-10-20)

Source: Cloud Run Quotas and Limits, `https://cloud.google.com/run/quotas`
(fetched in full), plus the request-timeout doc page.

| Design-doc claim | Platform reality | Verdict |
|---|---|---|
| Engine request timeout = Cloud Run max 3,600 s | Max is 60 min (3,600 s), default 300 s | ✅ matches exactly |
| Engine tiers 4 vCPU/16 GiB and 8 vCPU/32 GiB | Per-instance max = **8 vCPU / 32 GiB**, no increase possible | ✅ fits — but XL sits exactly AT the platform ceiling; no larger tier exists if P99 outgrows it |
| **Gateway must accept 256 MB bodies on the load route; Functions rejected for its 32 MB cap** (code: `LOAD_MAX_BODY_BYTES = 256 MB` in gateway.ts and engineSvc.ts) | **Cloud Run caps HTTP/1 requests at 32 MiB** — the same 32 MB wall used to reject Functions. "No limit if using HTTP/2 server." | 🔴 **DISCREPANCY — FLAGGED, not redesigned.** As built (Node `http`, HTTP/1.1), neither the gateway nor the engine can receive a >32 MiB body on Cloud Run, whichever route loads take. The doc's signed-URL pattern removes the gateway from the data path but the engine is still a Cloud Run HTTP/1 service. Someone must decide: HTTP/2 end-to-end (`--use-http2` + h2-capable server), chunked/streamed upload protocol, or direct-to-Cloud-Storage upload with the engine fetching bytes (mirrors the MCP signed-URL pattern). Recorded here; the design doc was NOT edited |
| Streaming / large responses (600 s-class streaming, workbook downloads; code caps download body at 32 MB) | HTTP/1 **response** cap 32 MiB **unless** `Transfer-Encoding: chunked` or streaming is used | ⚠️ Compatible only if downloads actually stream chunked — the code's own 32 MB download cap suggests the authors already knew; verify the engine `/download` path emits chunked encoding before relying on >32 MiB saves |
| (implicit) local-disk persistence works | Writable FS is in-memory, **counts against the instance memory limit**, max 32 GiB, gone with the instance | ⚠️ See §2 gap (a): doc's GCS/Firestore durability is required, not optional |
| Sessions live while active, instances disposable | Container startup timeout 4 min; instances capped at 100/project/region by default (increa
...[truncated 2543 chars]