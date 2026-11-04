# W17C — Deploy reconciliation results (Cycle 10 closure)

Worker: deploy-reconciliation (W17c). Inputs read first:
`hidden_files/cycle10-closure/w17b-deploy-code-results.md` (§4 = combined
runner + gateway wiring), `hidden_files/cycle10-closure/w17a-deploy-infra-results.md`,
and the full `deploy/` tree. Reconciles W17a's 9-service deploy layer to
the two coordinator inputs that landed after it: (1) the user's service
inventory — **FIVE Cloud Run services total**; (2) the billing/storage
addendum — files+snapshots in **GCP Cloud Storage** (not Firebase
Storage; Firebase project is free-plan, Hosting + Auth only), Firestore
on free quotas with the op journal already segment-batched in code.

Scope honored: only `deploy/` changed (plus this file). No product
source, no `perf-evaluation.md` / `progress.md` / `TODO.md`, no push, no
stack restarts or loads (one isolated boot of the combined runner on
:18299 for entrypoint verification, torn down after).

## 1. What changed, file by file

### `deploy/services/service.yaml` — NEW (the collapse)
Single service-package definition replacing the five per-bin ones.
- `metadata.name: service`; image `${IMAGE_SERVICE}`; `SERVICE_BIN=service`
  → the combined runner (`packages/gateway/dist/bin/service.ts` +
  `services/servicePackage.ts`, W17b).
- Sizing (W17a service-family medium): **2 vCPU / 4 GiB** — the tier W17a
  assigned to the family's heavy surfaces (etl, agent); the combined
  process must fit its heaviest surface, so the 1 vCPU/1 GiB small-surface
  sizing no longer applies. **Concurrency 20** (W17a's agent value:
  above etl's 10, below the light surfaces' 80), maxScale 10 (every W17a
  family definition's guardrail), timeout 3600 s.
- Lifetime model: **stateless** — minScale `"0"` (scale-to-zero),
  `cpu-throttling: "true"` (request-allocated CPU), no session affinity;
  header states nothing persists between requests in the process.
- Merged env from the five deleted definitions: `HOST=0.0.0.0` (W17b),
  `ENGINE_SERVICE_URL=${ENGINE_STANDARD_URL}` (addons surface, read by
  `servicePackage.ts`), `GCP_PROJECT_ID=${GCP_PROJECT}` (agent/Vertex),
  `VAULT_MASTER_KEY` ← SM `${SECRET_VAULT_KEY}` (vault surface),
  `ICECREAM_ADDON_TRUSTED_KEYS` ← SM `${SECRET_ADDON_KEYS}` (addons surface).
- Ingress posture unchanged from W17a family: ingress all, NOT
  unauthenticated; deploy.sh grants `run.invoker` only to the gateway SA.

### Deleted: `deploy/services/service-{vault,meta,etl,agent,addons}.yaml`
Removed via recoverable trash (trash_ids `20261021-061814-4f5f503dfe5c4e0b…`
vault, `…38ad7cbc…` meta, `…8386cea5…` etl, `…bf69698b…` agent,
`…efc84a5c…` addons; expire 2026-11-20). Their only remaining mentions
in `deploy/` are historical ("replaces the five per-bin definitions…").

### `deploy/service-entrypoint.sh`
`service` added to the accepted `SERVICE_BIN` values → execs
`packages/gateway/dist/bin/service.js`. Per-bin values
(`vault|meta|etl|agent|addons`) kept selectable for local debugging;
fails closed (exit 64) on unset/unknown, as before. Header rewritten:
deployed form = combined runner, per-bin = local debugging only.

### `deploy/Dockerfile.service`
Header/docs only (build stages unchanged): image now documented as the
ONE `service` Cloud Run service running the combined runner via
`SERVICE_BIN=service`; the stale W17a "⚠ known code gap: bins bind
127.0.0.1" note removed (W17b landed `HOST`; `service.yaml` sets
`HOST=0.0.0.0`); tmpfs venv note tied to the stateless lifetime model.

### `deploy/services/gateway.yaml` (W17b §4 wiring)
- `VAULT_URL`, `META_URL`, `ETL_URL`, `AGENT_URL`, `ADDONS_URL` **all now
  `value: ${SERVICE_URL}`** — the gateway's service-family upstreams point
  at the single combined service, whose prefix dispatcher accepts the
  `/api/<name>/...` form (W17b §4). `/api/engine/*` routing untouched
  (longest-prefix still wins for the engines).
- Added `ENGINE_URL_STANDARD=${ENGINE_STANDARD_URL}` and
  `ENGINE_URL_XL=${ENGINE_XL_URL}` (W17b `engineAccess.ts` tier selection
  for signed-URL issuance; previously both fell back to the standard URL).
- Added `HOST=0.0.0.0` (W17b: bin reads `HOST`, default 127.0.0.1 local).

### `deploy/services/engine-standard.yaml`, `engine-xl.yaml`, `mcp.yaml`
Added `HOST=0.0.0.0` env (same W17b Cloud Run requirement; the YAMLs
predated the code landing it). Nothing else changed in these three.

### `deploy/deploy.sh`
- Header: five-service topology + the billing/storage model paragraph
  (GCP credit funds 5 Cloud Runs + GCS + Firestore + Secret Manager;
  Firebase free-plan = Hosting + Auth only; **no Firebase Storage bucket
  provisioned**; Firestore free quotas + segment-batched journal note).
- Step 3 comments: buckets are `gcloud storage` buckets **in GCP_PROJECT**,
  services write via GCP service accounts, browser never touches Firebase
  Storage; Firestore line now carries the free quotas (1 GiB, 50k reads/day,
  20k writes/day, 10 GiB/mo egress) and the journal batching note.
  **Checked: deploy.sh never created a Firebase Storage bucket** — storage
  steps were already GCS-only and `firebase deploy` was already
  `--only hosting`; nothing to remove, comments now say so explicitly.
- Step 4 comment: "Agent service → Vertex" → agent surface of the
  combined service (SA/IAM lines themselves unchanged — one `SERVICE_SA`
  already covered the family).
- §7b rewritten: the five-iteration `for svc in vault meta etl agent
  addons` loop (5 renders + 5 IAM bindings + 5 URL captures) replaced by
  ONE `render_and_replace service.yaml`, ONE `run.invoker` binding for
  `service`, ONE capture `SERVICE_URL`. Deploy order unchanged
  (engines → service → mcp → gateway).
- §7d: gateway render vars now `${V_COMMON} ${ENGINE_STANDARD_URL}
  ${ENGINE_XL_URL} ${SERVICE_URL}` (was the five per-service URLs).
- Final summary line now also prints the `service` URL.
- **Credential gate untouched**: same `require` list, same missing-list
  output, exit 78; dry-run still prints-only via `run`/`run_capture`.

### `deploy/CONFIG.md`
- New top section "Deployed inventory + billing/storage model": the five
  services; GCS buckets (`<project>-icecream-files` / `-snapshots`) in the
  GCP project on credit, services write via the GCP SA, browser never
  touches Firebase Storage, **no Firebase Storage bucket provisioned
  anywhere**; Firestore free quotas stated verbatim (1 GiB stored, 50k
  reads/day, 20k writes/day, 10 GiB/mo egress) with the journal-segment
  batching note (`JOURNAL_SEGMENT_MAX_OPS` default 200, W17b
  `sessionStore.ts` — already the code's model); Firebase = free plan,
  Hosting + Auth only.
- Operator table: `GCP_PROJECT` / `FIREBASE_PROJECT_ID` rows updated to
  the same model.
- Gateway section: `HOST` row added; `ENGINE_URL_STANDARD`/`_XL` row
  added; the five `*_URL` row now states all five are filled from the
  single `service` URL.
- "service family (service-{…})" section replaced by a `service` section:
  combined runner, `SERVICE_BIN=service` deployed (per-bin = local debug
  only), sizing 2 vCPU/4 GiB concurrency 20, per-surface env rows
  re-attributed (addons/vault/agent surfaces), `HOST` row added.
  Engine + MCP sections each gained a `HOST` row.

### `deploy/README.md`
- Layout table: entrypoint/YAML rows updated to the five-service form.
- Image↔bin table: gateway package now **eight** bins incl. the combined
  runner; `Dockerfile.service` row = `dist/bin/service.js` →
  **`service` (ONE service)**, per-bin values local-debug only; new
  paragraph documenting the gateway wiring (all five upstreams → single
  service URL) and a new "Billing / storage model" section mirroring
  CONFIG.md.

## 2. Verification outputs

**YAML parse + envsubst render** (python yaml + envsubst-equivalent render
restricted to exactly the var list deploy.sh passes per file; identifier
placeholders only — the literal `${...}` in gateway.yaml's header comment
is prose, not a placeholder):

```
engine-standard.yaml: raw-parse OK; render-parse OK; service-name=engine-standard; unsubstituted=[]
engine-xl.yaml:       raw-parse OK; render-parse OK; service-name=engine-xl;       unsubstituted=[]
gateway.yaml:         raw-parse OK; render-parse OK; service-name=gateway;         unsubstituted=[]
mcp.yaml:             raw-parse OK; render-parse OK; service-name=mcp;             unsubstituted=[]
service.yaml:         raw-parse OK; render-parse OK; service-name=service;         unsubstituted=[]
ALL OK
```

Rendered gateway env (spot check): `VAULT_URL` = `META_URL` = `ETL_URL` =
`AGENT_URL` = `ADDONS_URL` = the single service URL;
`ENGINE_URL_STANDARD`/`ENGINE_URL_XL` = their tier URLs.
Rendered service env: `SERVICE_BIN=service`, `HOST=0.0.0.0`, cpu `"2"`,
memory `4Gi`, concurrency 20, minScale `"0"`.

**Syntax:** `bash -n deploy/deploy.sh`, `bash -n deploy/build-web.sh`,
`sh -n deploy/service-entrypoint.sh`, `sh -n deploy/engine-entrypoint.sh`
→ ALL OK.

**Credential gate (re-tested, env unset):** exit **78**, "DEPLOY BLOCKED —
credential gate. Nothing was deployed." with the exact missing list
(GCP_PROJECT, REGION, FIREBASE_PROJECT_ID, FIREBASE_TOKEN,
AUTH_SECRET_VALUE, MCP_AUTH_SECRET_VALUE, ENGINE_SIGNING_SECRET_VALUE,
VAULT_KEY_VALUE) — identical behavior to W17a.

**Dry-run (re-tested, dummy env, `--dry-run`):** exit **0**, 55 `[dry-run]`
command lines, executed nothing. Key lines:
- Exactly **5** `gcloud run services replace` (engine-standard,
  engine-xl, **service**, mcp, gateway — dependency order preserved).
- Exactly **1** invoker binding for the combined service:
  `run services add-iam-policy-binding service … --member=serviceAccount:icecream-gateway@… --role=roles/run.invoker`; **zero**
  references to `service-vault|service-meta|service-etl|service-agent|service-addons`
  anywhere in the dry-run output.
- Gateway render vars end `… ${ENGINE_STANDARD_URL} ${ENGINE_XL_URL} ${SERVICE_URL}`.
- Storage: two `gcloud storage buckets create gs://<proj>-icecream-files`
  / `-icecream-snapshots` (GCP project) + `firestore databases create`;
  the only Firebase command is `firebase deploy --only hosting` —
  **no Firebase Storage step exists**.

**Entrypoint / combined runner (isolated, :18299, torn down after):**
- `SERVICE_BIN=bogus` → exit 64 with the fail-closed message listing
  `service vault meta etl agent addons`; unset → exit 64.
- `SERVICE_BIN=service PORT=18299 sh deploy/service-entrypoint.sh` →
  `[service-package] listening on 127.0.0.1:18299 (vault, meta, etl,
  agent, addons)`; `GET /health` →
  `{"ok":true,"service":"service-package","services":["vault","meta","etl","agent","addons"]}`;
  `GET /api/vault/health` → `{"ok":true,"service":"vault"}`;
  `GET /meta/health` → `{"ok":true,"service":"meta"}` (both dispatcher
  path forms answer). Port confirmed closed after kill.

## 3. Final five-service inventory

| # | Cloud Run service | Image | Bin / entrypoint | Sizing | Lifetime |
|---|---|---|---|---|---|
| 1 | `gateway` | `Dockerfile.gateway` | `dist/bin/gateway.js` | 1 vCPU / 512 MiB, conc 80 | stateless, min 0 |
| 2 | `engine-standard` | `Dockerfile.engine` | `dist/bin/engine.js` (heap 12288) | 4 vCPU / 16 GiB, conc 1 | stateful (sessions), min 0 |
| 3 | `engine-xl` | `Dockerfile.engine` | `dist/bin/engine.js` (heap 24576) | 8 vCPU / 32 GiB, conc 1 | stateful (sessions), min 0 |
| 4 | `mcp` | `Dockerfile.mcp` | `packages/mcp-server/dist/bin/http.js` | 2 vCPU / 4 GiB, conc 80 | stateless per request, min 0, own ingress |
| 5 | `service` | `Dockerfile.service` | `dist/bin/service.js` via `SERVICE_BIN=service` (combined runner: vault+meta+etl+agent+addons) | 2 vCPU / 4 GiB, conc 20 | stateless, min 0, nothing persists between requests |

Plus (not services): Firebase Hosting (web build, free-plan Firebase
project, Hosting + Auth only), GCS buckets + Firestore (free quotas) +
Secret Manager + Artifact Registry in the GCP project.

## 4. Residual flagged for the coordinator (not fixed — product source, out of W17c scope)

W17b §4 describes the per-prefix gateway option as "per-prefix routes
**with the full path preserved**". The current gateway does not preserve
it: `packages/gateway/src/gateway.ts` strips the matched route prefix
(`upstreamPath = path.slice(routePrefix.length)`), so a proxied
`/api/vault/store` reaches the combined service as bare `/store` — a
form its prefix dispatcher 404s (it accepts `/api/<name>/...` and
`/<name>/...` only, both verified live above). The deploy-side wiring
requested for W17c (all five gateway upstreams → the single service URL)
is in place exactly as specified; making proxied service-family traffic
land end-to-end needs a gateway-side step (e.g. a single `/api` route to
the combined service so the slice yields `/vault/store`, or the
dispatcher accepting bare surface paths) — a product-code decision for
the coordinator/W17b owner, not a deploy-YAML change. Direct
(invoker-authenticated) calls to the service in either documented path
form work today.
