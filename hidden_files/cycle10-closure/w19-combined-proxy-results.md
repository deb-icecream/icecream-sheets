# W19 — Combined-service proxy fix results (Cycle 10 closure)

Worker: combined-service proxy fix (W19). Inputs read first:
`hidden_files/cycle10-closure/w17c-deploy-reconcile-results.md` §4
(the residual) and `hidden_files/cycle10-closure/w17b-deploy-code-results.md` §4
(the combined runner). Scope honored: gateway product code + the two
delegated deploy files (`deploy/services/gateway.yaml`,
`deploy/CONFIG.md`) + gateway tests + this file. No
`perf-evaluation.md` / `progress.md` / `TODO.md` edits, no push, no
shared-stack contact (nothing on :8100–:8107/:4173 was restarted or
even curled; all live validation ran on isolated 182xx ports and was
torn down, ports verified closed).

## 1. The defect (as handed over, re-verified live — see §3 counterpart)

The combined runner (`packages/gateway/src/services/servicePackage.ts`)
dispatches by `/api/<name>` prefix (required: etl and addons both serve
a bare `POST /run`). The gateway stripped the matched route prefix
before forwarding, so in the deployed topology (all five `*_URL`
upstreams = the single combined `SERVICE_URL`) a client call to
`/api/vault/store` arrived at the dispatcher as bare `/store` → 404.

## 2. Mechanism chosen + why

**A gateway config flag, `SERVICE_COMBINED`, default OFF.** This was
the expected shape in the task and it is the right one: the gateway is
the only component that knows which topology its upstreams are in, and
the flag keeps the local per-bin topology (each bin serves bare paths)
byte-identical by default while the deployed gateway opts into the
combined form. No dispatcher change (accepting bare paths there would
reintroduce the etl/addons `/run` ambiguity), no route-table change
(a single `/api` route would have altered longest-prefix behavior for
every other route).

Code:

- `packages/gateway/src/gateway.ts`
  - `GatewayOptions.serviceCombined?: boolean` — when true, proxying a
    **service-family** route forwards the FULL path (`path` unchanged,
    query string rides along as before). When false/absent, the
    existing `path.slice(routePrefix.length) || '/'` strip runs for
    every route, untouched.
  - `SERVICE_FAMILY_ROUTE_PREFIXES = ['/api/vault','/api/meta','/api/etl','/api/agent','/api/addons']`
    (exported const; `/api/addons` included — it is a service-family
    route like the other four).
  - `serviceCombinedEnabled(env)` — env parsing in the codebase's
    existing style (cf. `engineAccessMode`): `'on'` / `'true'` / `'1'`
    (trimmed, case-insensitive) enable; unset / anything else is OFF.
  - The ONLY behavioral branch is the `upstreamPath` computation:
    `opts.serviceCombined && SERVICE_FAMILY_ROUTE_SET.has(routePrefix) ? path : strip`.
    Auth, rate limiting, the `/api/engine/access` issuance, and the
    engine special caps/timeouts (load/snapshot/download/library) all
    key off the original client `path`, not `upstreamPath`, and are
    untouched; non-family routes (engine included) strip in both modes.
- `packages/gateway/src/bin/gateway.ts` — reads
  `serviceCombinedEnabled()` from `SERVICE_COMBINED`, passes it into
  `createGateway`, and logs one line at boot when on (seen in the §3
  transcript). Header comment documents the flag.
- `packages/gateway/src/index.ts` — re-exports
  `SERVICE_FAMILY_ROUTE_PREFIXES` / `serviceCombinedEnabled`;
  `startAllLocal` gains an optional `serviceCombined` passthrough
  (default off, so its behavior is unchanged).

Deploy wiring (delegated small deploy edit):

- `deploy/services/gateway.yaml` — new env on the gateway service:
  `SERVICE_COMBINED` = `"on"`, beside the five `*_URL = ${SERVICE_URL}`
  entries; header comment now states the flag is REQUIRED with that
  wiring and why. Render check (W17c's approach: python-yaml parse of
  raw + envsubst-restricted render): raw-parse OK, render-parse OK,
  service-name `gateway`, all five `*_URL` render to the single service
  URL, `SERVICE_COMBINED = on`, no unsubstituted placeholders (the one
  literal `${...}` is header-comment prose, as W17c already noted).
- `deploy/CONFIG.md` — gateway table: new `SERVICE_COMBINED` row
  (purpose, both modes, which routes it affects, read-by-code pointer).

## 3. Both-ways live validation (isolated 182xx only, torn down after)

Built `packages/gateway` (`npm run build`, exit 0), then booted real
bins: combined runner `dist/bin/service.js` on :18210, per-bin vault
:18211 / etl :18212, gateway OFF on :18220 (per-bin upstreams, no
`SERVICE_COMBINED`), gateway ON on :18221 (`SERVICE_COMBINED=on`, all
five `*_URL` → :18210), plus a gateway OFF on :18222 pointed at the
combined runner as the defect counterpart. All calls went through the
gateways with a JWT from `/auth/login` (user `w19live`).

Boot line (gateway ON): `[gateway] SERVICE_COMBINED=on — service-family routes (vault, meta, etl, agent, addons) proxied with full /api/<name> path preserved`

### (a) Flag OFF + per-bin upstreams (gateway :18220) — strip, as today

```
-- POST /api/vault/store {ref:user:w19live:live-off, secret} (strip -> bin /store)
{"ok":true}                                    HTTP 200
-- GET /api/vault/refs (strip -> bin /refs)
{"refs":["user:w19live:live-off"]}             HTTP 200
-- POST /api/etl/run {recipe:null} (strip -> bin /run; etl's own 400)
{"ok":false,"error":"{ recipe: EtlRecipe } required"}   HTTP 400
```

### (b) Flag ON + combined runner upstream (gateway :18221 → :18210) — preserved

```
-- GET /api/vault/health (preserved -> vault surface)
{"ok":true,"service":"vault"}                  HTTP 200
-- POST /api/vault/store {ref:user:w19live:live-on, secret} (preserved -> vault surface)
{"ok":true}                                    HTTP 200
-- GET /api/meta/health (preserved -> meta surface)
{"ok":true,"service":"meta"}                   HTTP 200
-- PUT /api/meta/kv/w19-live {value:combined} then GET it
{"ok":true}                                    HTTP 200
{"value":"combined"}                           HTTP 200
-- POST /api/etl/run {recipe:null} (COLLISION PAIR 1/2 -> etl surface's own 400)
{"ok":false,"error":"{ recipe: EtlRecipe } required"}   HTTP 400
-- POST /api/addons/run {} (COLLISION PAIR 2/2 -> addons surface's own 400, distinct)
{"ok":false,"error":"{ addonId: string } required"}     HTTP 400
-- GET /api/addons/catalog (addons surface)
{"listings":[{"manifest":{"id":"com.icecream.sample-sum-reporter", … (truncated at 300 chars in the capture)
-- GET /api/agent/health (preserved -> agent surface)
{"ok":true,"service":"agent"}                  HTTP 200
```

The collision pair is the proof that matters: the same bare
`POST /run` shape reaches etl through `/api/etl/run` and addons
through `/api/addons/run`, each answering with its own surface's
validation error — impossible under bare-path dispatch.

### Defect counterpart (for the record): flag OFF + combined upstream (gateway :18222)

```
-- POST /api/vault/store (stripped to /store -> dispatcher 404, the pre-fix production defect)
{"ok":false,"error":"not found: /store"}        HTTP 404
```

Teardown: all six ports (18210, 18211, 18212, 18220, 18221, 18222)
verified closed after the run.

## 4. Tests

- NEW `packages/gateway/tests/combinedProxy.test.ts` (3 tests):
  end-to-end through a real gateway — (a) flag OFF + real per-bin
  vault/etl listeners (store + refs round-trip, etl `/run` 400);
  (b) flag ON + the real combined listener for all five routes (vault
  store/health, meta health + kv round-trip, the etl-vs-addons `/run`
  collision pair with distinct errors, addons catalog, agent health);
  (b-counterpart) flag OFF + combined upstream → `/api/vault/store`
  404s, pinning the defect the flag removes.
- `packages/gateway/tests/gateway.test.ts` (+5 tests, new
  `gateway SERVICE_COMBINED proxy mode (W19)` describe, echo backend
  records the exact forwarded path): default (flag absent) strips all
  five family prefixes; explicit `false` strips identically; flag ON
  preserves the full path + query for all five family routes;
  flag ON still strips non-family routes (`/api/engine/load` → `/load`,
  arbitrary route → stripped); `serviceCombinedEnabled` parsing pins
  (on/ON/true/1 on; unset/off/yes/empty off).
- **Full gateway suite: 167 passed, 16 files** (`npx vitest run`) —
  159 baseline + 8 new, zero regressions.
- **tsc clean** for the gateway package: `npx tsc -p tsconfig.json
  --noEmit` exit 0, and `npm run build` exit 0 (the dist build the
  live validation ran from).

## 5. Files changed

| File | Change |
|---|---|
| `packages/gateway/src/gateway.ts` | `serviceCombined` option, family-prefix set, env parser, preserve-vs-strip branch |
| `packages/gateway/src/bin/gateway.ts` | `SERVICE_COMBINED` env → option + boot log + header doc |
| `packages/gateway/src/index.ts` | Re-exports + `startAllLocal` passthrough (default off) |
| `packages/gateway/tests/gateway.test.ts` | +5 mode-pinning tests |
| `packages/gateway/tests/combinedProxy.test.ts` | NEW — 3 end-to-end both-ways tests |
| `deploy/services/gateway.yaml` | `SERVICE_COMBINED: "on"` env + header note |
| `deploy/CONFIG.md` | `SERVICE_COMBINED` row in the gateway table |
| `packages/gateway/dist/…` | Rebuilt by `npm run build` for the live validation |

Nothing else touched. The W17c residual is closed: with the deployed
gateway.yaml as now written (`SERVICE_COMBINED=on` + all five upstreams
at the combined service), proxied service-family traffic lands
end-to-end, and the local per-bin topology is unchanged by default.
