# MCP Server — Local End-to-End Validation Report

**Date:** 2026-10-21/22 (run ~19:48–20:00 PDT) · **Scope:** `packages/mcp-server`, local, real processes, real HTTP wire traffic — no mocks.
**Deploy-gate context:** the gate requires every service validated locally in production topology. Gateway + engine are covered by the Phase 2 program; service package + Vertex by the agent-features program. This run closes the MCP gap.

## How the servers were started (Check 1 setup)

Two real server processes ran side by side:

- **Server A — the shipped production runner, exactly as deployed:**
  `MCP_AUTH_SECRET=<validation-secret> PORT=18206 node packages/mcp-server/dist/bin/http.js`
  (the same bin `deploy/Dockerfile.mcp` runs; `deploy/services/mcp.yaml` runs it with `MCP_AUTH_SECRET` from Secret Manager). Log: `evidence/serverA-bin.log`.
- **Server B — the composed production posture** (`launcher.mjs`): the workbook was loaded exactly the way the gateway's engine service loads it (`packages/gateway/src/services/engineSvc.ts`: `XlsxAdapter.read` → `new EngineWorkbook(initial, {definedNames})` → `new EngineHost(workbook)`), persistence was the product's own file-backed adapter (`packages/gateway/src/filePersistence.ts`), and the HTTP layer was started via the package's own `startMcpHttp(port, { host, persistence, requireAuth: true, authSecret })` on port 18207. Log: `evidence/serverB-launcher.log`.

Both were driven by a raw-HTTP MCP client (`mcp-client.mjs`) that records the actual wire traffic to JSONL transcripts. All runs used the throwaway validation-only secret `mcp-validation-secret` and a test token minted with the service package's own `issueToken` (HS256, userId `deb-validation`).

## Per-check verdicts

### 1. Startup on its own ingress — ✅ PASS
Both processes came up standalone on their own ports (no gateway involved), `/health` → `{"ok":true,"service":"mcp-server"}`, MCP endpoint at `/mcp`. Server B loaded the real fixture workbook (Sheet1, Sheet2) host-side at startup.

### 2. Tool discovery vs design — ✅ PASS with drift notes
`tools/list` returned **39 tools**, identical on both servers (`evidence/tool-list-A.json`, `tool-list-B.json`):
`agent.answer_pending, agent.ask_question, agent.list_pending, agent.offer_options, agent.request_approval, analyze_data, appbuilder_create_spec/delete_spec/get_spec/list_specs/update_spec, create_chart, create_pivot, execute_code, get_pivot_data, get_results, list_analyses, list_data_sources, list_subscriptions, memory_load, memory_save, memory_update, open_data_source, poll_events, read_cells, recalculate, refresh_data_source, refresh_pivot, report_create_spec/delete_spec/get_spec/list_specs/update_spec, rerun_analysis, rtd_publish, set_formulas, subscribe, unsubscribe, write_cells`.

Against the design authority (`design-docs/ai-agent.md`): every capability the doc assigns to MCP tools is present — reads/writes/formula edits/recalculation/code execution (§2), long-term memory as versioned tool calls named load/save/update (§12 → `memory_load/save/update`), human-in-the-loop as tool calls (ask question / offer options / request approval, plus answer/list pending), and connected data sources visible through the same tools (§2 + `connector-vs-component.md`). **Drift, precisely:**
- The package **README's tool table is stale**: it documents only 6 tools (read_cells, write_cells, set_formulas, recalculate, get_results, execute_code) and describes the server as stdio-only. All 6 documented tools exist and behave as documented; the other 33 tools and the HTTP runner are undocumented there.
- **No tool returns a cell's formula text, and there are no load/save-workbook tools.** Formulas can be written (`set_formulas`) and their effects read (`read_cells` values), but formula text is not readable through the surface, and the workbook lifecycle (load/save) is host-side by design — the agent works on the session workbook the host loaded. Checks 3's formula proof below is built accordingly.

### 3. Tool-only round trip on a real xlsx — ✅ PASS
Fixture: `test-data/real-world/closedxml-xlsx-bug-fixes.xlsx` (5,795 B, 2 sheets), loaded host-side by Server B. All edits through MCP tools over HTTP (`evidence/phase3-roundtrip.jsonl`):
- Baseline `read_cells` Sheet1 A1:D5 matched the file (A2 = 1).
- `set_formulas` C2 `=A2*2` → `read_cells` C2 = **2**.
- `write_cells` A2: 1 → **41**, D3 ← `"mcp-edit-marker"` → read-back: A2 = 41, **C2 = 82** (the formula recomputed from the edited precedent — the formula is live in the engine), D3 = marker.
- `recalculate` ok; `get_results` ok (5 rows).
- Host-side save on shutdown (snapshot → `XlsxAdapter.write`, the adapter path — the production direct-streaming save is the engine service's and is covered by its own program), then **independent parse-back with SheetJS** (no engine code) of `evidence/phase3-saved.xlsx`: **ALL PASS** — A2 = 41, D3 = marker, C2 carries the formula `A2*2` (cached value 0 is the adapter's documented placeholder for formula cells; the computed 82 was proven by the tool read-back), Sheet2 and untouched cells preserved.
- Bonus probe (`evidence/phase6b-probes.jsonl`): a second, separate MCP session saw the first session's edit — the shared-EngineHost session model in `src/http.ts` holds on the wire.

**Observation (not a defect):** the fixture's Sheet2 C1 `=averageif(A2:B2)` is not valid Excel AVERAGEIF syntax (criteria argument is required); the engine returns `#N/A` where the file's stale cached value says 29. Cached fixture values are not authoritative.

### 4. Long-term memory tools — ✅ PASS on the composed server; ❌ FAIL on the shipped bin (Defect 2)
Server B (file-backed persistence injected, as the design intends — memory in the service metadata store):
- Fresh process: `memory_load` → `found:false`; `memory_save` `{name:'XLOOKUP', since:2026}` → ok; `memory_load` → value round-trips.
- **Process killed and restarted fresh:** `memory_load` in the new process/session returned the saved value — **durability across restart proven**. `memory_update` with `{since:2027, verified:true}` shallow-merged to `{name:'XLOOKUP', since:2027, verified:true}`.
- **Second restart:** merged value still there; a different userId sees nothing (per-user scoping holds). The persisted blob is on disk in evidence-adjacent work dir (`icecream-sheets.mcp.agent-memory.v1.*.json`). Transcripts: `evidence/phase4-memory-{save,verify-update,verify-final}.jsonl`.

### 5. Auth + rate limit — ⚠️ MIXED: mechanism ✅ PASS where enabled; shipped posture ❌ FAIL (Defect 1). Rate limit ✅ PASS exact.
Server B (`requireAuth: true`) — `evidence/phase5-auth.jsonl`:
- No token → **401**; wrong-secret token → **401**; garbage token → **401**; expired token → **401**; valid token → **200** + session. MCP verifies the Bearer JWT itself with its own secret, exactly as designed.

Server A (shipped bin, `MCP_AUTH_SECRET` set as in `mcp.yaml`):
- No token → **200 + session issued** (anonymous `mcp-client` principal, full tool access).
- Wrong-secret token → **200 + session issued** (invalid credential silently falls back to anonymous instead of being rejected).

Rate limit (Server A, shipped defaults, after a >60 s quiet window so the bucket was pristine) — `evidence/phase5-ratelimit.jsonl`: initialize + notification + **5,998** `tools/list` = exactly **6,000 requests allowed**, then **HTTP 429** with `Retry-After: 60` and body `{"ok":false,"error":"mcp rate limit exceeded — slow down"}` — the designed tier (6000/60 s per principal, `src/http.ts`) to the point.

### 6. Connected data source through the tools — ✅ PASS
A CSV (`work/products.csv`: header + 4 product rows) served over real HTTP (`python3 -m http.server`, port 18208); Server B's `csv-url` connector fetched it (`evidence/phase6-datasource.jsonl`):
- `list_data_sources` listed 7 connector kinds (csv-url, json-url, rest-api, sql, marketdata, mail, google-sheets) with paramHelp; no sources bound initially.
- `open_data_source` (kind `csv-url`, `params.url`) → new sheet **"Validation Products"**, 4 data rows, columns name/price/qty.
- `list_data_sources` then showed the binding; `read_cells` returned the exact grid with typed values (numbers as numbers); `refresh_data_source` ok.
- Minor inconsistency (observation): `open_data_source` reports `rows: 4` (data rows) while the binding summary in `list_data_sources` reports `rows: 5` (grid rows incl. header) — two meanings of "rows" in adjacent outputs.
- Bonus probe: `create_chart` on a server with no ChartSink wired fails closed with the honest error `"chart creation is not available in this session"` — no fake success (the sink is wired in the gateway-composed agent topology, covered by the agent-features program).

## Defects found (not fixed — flagged per tasking)

**DEFECT 1 — The shipped MCP runner never enforces auth (high).**
`packages/mcp-server/src/bin/http.ts` starts the server with `startMcpHttp(port, {}, host)` — `requireAuth` is never set and there is **no env var or config path to set it**, so it takes the `src/http.ts` default `false`. Consequence, proven on the wire: with `MCP_AUTH_SECRET` set exactly as `deploy/services/mcp.yaml` sets it, an unauthenticated caller — or one presenting a token signed with the wrong secret — is silently given the anonymous `mcp-client` principal with full access to all 39 tools. This contradicts `deploy/services/mcp.yaml`'s stated posture ("ALL auth enforced in-process… authentication enforced by the process itself") and `src/http.ts`'s own trust-boundary note ("production deployments should set requireAuth"). The verification mechanism itself is correct (Server B results above); the production entrypoint just never turns it on. Fix shape (for the owner): have the bin set `requireAuth: true` whenever `MCP_AUTH_SECRET` is present (or unconditionally), or read an `MCP_REQUIRE_AUTH` env.

**DEFECT 2 — The shipped MCP runner wires no persistence; agent long-term memory (and the other metadata stores) do not survive restart (high).**
The same bin passes no `persistence`, so `createServer` defaults every metadata store to in-memory (`packages/mcp-server/src/server.ts`: `new MemoryStore(options?.persistence)`; data-source store likewise). Proven on the wire (`evidence/phase4-memory-bin-save.jsonl`, `phase4-memory-bin-verify.jsonl`): `memory_save` in bin process #1 → restart the bin → `memory_load` returns `found:false`. The design (`design-docs/ai-agent.md`) places long-term memory in the service metadata store precisely so it survives; the composed topology in this very run (Server B with the file-backed adapter) proves the seam works — the standalone Cloud Run MCP service, which runs this bin, would lose memory (and pivot/app/report specs and data-source bindings) on every restart, scale-to-zero cycle, or instance swap. Fix shape: the bin should construct a durable `Persistence` (Firestore-backed in GCP, file-backed locally) from env, the way the gateway does.

**OBSERVATION — dead deploy config:** `deploy/services/mcp.yaml` sets `ENGINE_URL` with the comment "MCP tools act on engine sessions", but nothing in `packages/mcp-server` reads `ENGINE_URL`; the server always uses its own in-process `EngineHost`. Either the yaml comment describes an unbuilt wiring or the env is vestigial — the deploy config and the code disagree about the topology and one of them should be corrected. (The gateway's own `ENGINE_URL` in `gateway.yaml` is separate and is used.)

## Not run, with reasons
- **Formula text read-back through tools** — impossible: no tool returns formula text (see Check 2 drift). Proven instead by recompute-on-precedent-edit through tools + formula text in the independent parse-back.
- **Workbook load/save as MCP tools** — no such tools exist by design; exercised host-side exactly as the product composes it. The production direct-streaming save path belongs to the engine service and is validated by its own program; this run's save used `XlsxAdapter.write` over the live snapshot, which is sufficient for the persistence claim and is labeled as such wherever cited.
- **stdio transport end-to-end** — not exercised; the deployment topology (and `Dockerfile.mcp`) is the HTTP runner, and both transports share `createServer`. The stdio entrypoint (`src/index.ts`/`runServer`) was not separately driven.
- **Rate limit under the requireAuth posture** — the limiter is the same code path in the shared listener (`createMcpHttpListener`) for both postures; the shipped-default numbers were proven on Server A. Not re-run on Server B.
- **SQL / REST / Google Sheets data sources through tools** — only the CSV-URL connector was driven end-to-end (the task's example); the other kinds are listed by `list_data_sources` but their live fetches were not part of this run (SQL is additionally covered by the agent-features program's seeded-DB case).

## Evidence index (`hidden_files/mcp-validation/`)
- Harness: `launcher.mjs`, `mcp-client.mjs`, `start-b.sh`, `phase2-discovery.mjs`, `phase3-roundtrip.mjs`, `phase3-parseback.mjs`, `phase4-memory.mjs`, `phase5-auth.mjs`, `phase5-ratelimit.mjs`, `phase6-datasource.mjs`, `phase6b-probes.mjs`
- Server logs: `evidence/serverA-bin.log`, `evidence/serverB-launcher.log`, `evidence/csv-http-server.log`
- Wire transcripts: `evidence/phase2-discovery-{A,B}.jsonl`, `evidence/phase3-roundtrip.jsonl`, `evidence/phase4-memory-{save,verify-update,verify-final,bin-save,bin-verify}.jsonl`, `evidence/phase5-auth.jsonl`, `evidence/phase5-ratelimit.jsonl`, `evidence/phase6-datasource.jsonl`, `evidence/phase6b-probes.jsonl`
- Tool lists: `evidence/tool-list-A.json`, `evidence/tool-list-B.json` · Saved workbook: `evidence/phase3-saved.xlsx` · Test fixture CSV: `work/products.csv`
- `evidence/test-token.txt` holds the validation token (signed with the throwaway validation-only secret, long expired) for transcript reproducibility.
