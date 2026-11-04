# MCP Server — Fix + Re-Validation Report (fix round)

**Date:** 2026-10-21/22 (run ~20:55–21:20 PDT) · **Scope:** `packages/mcp-server` fixes for the defects in `../REPORT.md`, re-validated against the **fixed shipped bin** (`packages/mcp-server/dist/bin/http.js`) with the original harness (`../mcp-client.mjs`, `../launcher.mjs`) plus fix-round scripts in this directory. All traffic is real HTTP on ports 18216 (fixed bin), 18217 (composed launcher), 18218 (CSV HTTP server).

**Verification discipline:** the coordinator read every changed file first-hand, rebuilt the package (`tsc` clean), and re-ran the package suite personally: **15 files, 142 passed + 1 skipped** (pre-fix baseline 130 passed + 1 skipped — the +12 are the new runner-config tests and the rows pinning test; zero regressions).

## Per-defect fixes

### Defect 1 — shipped runner never enforced auth → FIXED
- **New `packages/mcp-server/src/bin/runner-config.ts`** — `resolveRunnerConfig(env)`: pure, unit-tested config resolution. `requireAuth` is always `true`; `authSecret` comes from `MCP_AUTH_SECRET`; a missing/empty/whitespace secret throws a clear fail-closed error. **No anonymous escape hatch exists in the bin** — no design doc sanctions one for the shipped runner, and desktop does not use this bin (it calls the library `startMcpHttp` directly with its own `MCP_REQUIRE_AUTH`, `apps/desktop/src/mcp.ts:118`). `src/http.ts` library defaults are unchanged.
- **Rewritten `packages/mcp-server/src/bin/http.ts`** — resolves config *before* listening; on error prints to stderr and `process.exit(1)`; passes `{ requireAuth: true, authSecret, persistence }` to `startMcpHttp`; the `listening` log prints the posture (auth enforced, store, dataDir) without the secret.
- Governing design: `design-docs/connector-vs-component.md` — "MCP clients authenticate to the MCP server with MCP's own auth (per the MCP spec), not the gateway's JWT… The gateway never validates MCP users; it routes MCP traffic to its own ingress." + `design-docs/deployment-architecture.md` — MCP's "direct ingress with self-authentication".

### Defect 2 — shipped runner wired no persistence → FIXED
- Same `runner-config.ts`: store selection mirrors the codebase's `SESSION_STORE` / `FILE_REGISTRY_STORE` env-selector pattern via **`MCP_STORE`**:
  - unset / `local` → a real file-backed `Persistence` over the existing `@icecream-sheets/service` seam (`createFilePersistence(dir)` in the same module): one file per key, sanitized name + 16-char sha256 suffix, atomic tmp+rename writes, ENOENT load → null — the gateway adapter's exact semantics (`packages/gateway/src/filePersistence.ts`), implemented inside `src/bin/` because gateway depends on mcp-server (importing it would be circular; stated in a comment). Data dir: `MCP_DATA_DIR` → else `$ICECREAM_DATA_DIR/mcp` → else `~/.icecream-sheets/data/mcp`.
  - `prod` → **fails closed**: the deployed metadata store is Firestore (`deployment-architecture.md`, Storage: "Firestore: metadata store, session registry, op journal"), but the synchronous `Persistence` seam has no Firestore adapter in the codebase (the gateway's prod adapters implement async store interfaces, not this seam), so the bin refuses to start rather than silently losing agent memory on restart. Unknown values also refuse, naming the value.
- **`packages/mcp-server/src/server.ts` (appStore, ~line 1060)** — `createAppStore(memoryPersistence())` → `createAppStore(options?.persistence ?? memoryPersistence())`: it was the one store that ignored injected persistence; now app specs persist like memory/pivot/report/analysis/data-source stores, which already honored the option.
- Design: `design-docs/ai-agent.md` §12 — long-term memory operations are "versioned MCP tool call[s]… scoped per user in the service metadata store. There is no private memory channel."

### Item 3 — ENGINE_URL disagreement → RECONCILED (deploy config corrected to the docs)
Governing design, quoted:
- `AGENT.md` §2 (non-negotiable architecture): "**MCP server on the engine.** The engine exposes a versioned MCP surface."
- `design-docs/platform-shell.md` §8: "Typed cell, range, formula and recalculation operations are exposed through the MCP server on every host, so third-party clients get the same operations as the built-in UI."
- `design-docs/ai-agent.md` §2: the agent acts through the MCP tools on the session workbook; nothing in any design doc has the MCP server calling a remote engine service over HTTP. The code's model — one in-process `EngineHost` shared by all sessions (`src/http.ts` session model) — is the documented one; `deploy/services/mcp.yaml`'s own sizing comment ("MCP drives the engine + Python sandbox") agrees.
- **Change:** `deploy/services/mcp.yaml` — the `ENGINE_URL` env entry removed entirely (0 occurrences remain; every other line untouched). Code and config now agree: no `ENGINE_URL` is set for MCP and none is read. (The gateway's separate `ENGINE_URL` in `gateway.yaml` is read by the gateway and is untouched.)
- ⚠️ **Flagged, out of edit scope:** `deploy/CONFIG.md` line 245 still describes `ENGINE_URL` for mcp as "**reserved** (tool wiring)" — now stale; the parent should reconcile that row. `deploy/Dockerfile.mcp`'s "KNOWN CODE GAP (W17b)" comment is likewise stale (HOST widening has landed, and its stated precondition — requireAuth + a real secret — is now enforced by the bin).

### Item 4 — README drift → FIXED
- **New `packages/mcp-server/scripts/list-tools.mjs`** — boots the built server in-process (library `startMcpHttp`, ephemeral port, requireAuth + throwaway secret, token via the service package's `issueToken`), calls `tools/list`, and prints the `Tool | What it does` Markdown table from the live registry.
- `packages/mcp-server/README.md` — the 6-tool table replaced with the generated **39-tool** table under the note "Generated from the live tool registry — regenerate after building with: `node scripts/list-tools.mjs`"; stdio-only claim corrected (new **Transports** section: stdio + Streamable HTTP production runner); new **Production runner posture** section (auth fail-closed, `MCP_STORE` selection + data dir, own 6000/60s rate-limit tier, never behind the gateway). ICEEVAL/sandbox/plugin sections intact.

### Item 5 — rows count semantics → FIXED + PINNED
- Uniform documented semantics: **tool outputs report DATA rows (header excluded)**. `open_data_source`/`refresh_data_source` already returned `table.rows.length`; `dataSourceSummary` (`src/server.ts`) now returns `rows: binding.rowCount - 1`, with a comment documenting that `binding.rowCount` is the service connector layer's materialized *sheet*-row count including the header (`bindingForOpen`: `rowCount = table.rows.length + 1`; refresh planning depends on it — service package untouched).
- Pinning tests: `tests/data-sources.test.ts` ("rows semantics are uniform…": summary rows === open rows === 2 on the 2-row fixture) + the live wire pin in leg (e) below (4 === 4).

## Re-validation verdicts (all against the fixed shipped bin unless noted)

### (a) Auth — ✅ PASS (`evidence/fix-auth.jsonl`, `evidence/fix-legs-run-output.txt`)
No token → **401**; wrong-secret token → **401**; garbage token → **401**; expired token → **401**; valid secret → **200 + session**; authenticated `tools/list` → **exactly 39 tools**. (Same probes that returned 200 + anonymous sessions before the fix.)

### (b) Memory durability — ✅ PASS (`evidence/fix-memory-{save,verify-update,verify-final}.jsonl`, `evidence/fix-memory-run-output.txt`, `evidence/fix-failclosed.log`)
`memory_save` in bin process #1 → **SIGKILL** → restart → `memory_load` **HIT** (`{name:'XLOOKUP', since:2026}`); `memory_update` shallow-merged to `{name:'XLOOKUP', since:2027, verified:true}` → second restart → still there; a different userId sees `found:false` (per-user scoping intact). The record exists on disk as `icecream-sheets.mcp.agent-memory.v1.*.json` under `MCP_DATA_DIR`. Fail-closed probes in the same run: no `MCP_AUTH_SECRET` → exit 1; `MCP_STORE=prod` → exit 1; `MCP_STORE=bogus` → exit 1, each with its designed stderr message (verbatim in `fix-failclosed.log`).

### (c) Rate limit at shipped defaults — ✅ PASS (`evidence/fix-ratelimit-parallel.jsonl`, `evidence/fix-ratelimit-run-output.txt`)
Parallel variant (see note): 6 sessions' setup consumed 12 points; 6,300 `tools/list` at concurrency 30 → **exactly 5,988 × 200**, then **312 × 429** with `Retry-After: 60` and body `{"ok":false,"error":"mcp rate limit exceeded — slow down"}` — total allowed **exactly 6,000**, whole probe inside one 60 s window (32.6 s), zero unexpected statuses.
*Note:* the original sequential probe (`fix-ratelimit.mjs`, transcript `evidence/fix-ratelimit.jsonl`) was also run first: on this VM (load average ~22 from concurrent validation programs) 7,000 sequential requests took 127 s, so the fixed 60 s bucket window refilled mid-run and no 429 appeared — an environment artifact of the probe, not limiter behavior; the parallel variant proves the same shipped-default bucket exactly, on the wire, against the same bin.

### (d) Tool-only xlsx round trip — ✅ PASS
- **Leg 1, fixed bin** (`evidence/fix-roundtrip-bin.jsonl`): seed `write_cells` A1=10/A2=32 → `set_formulas` C2 `=A2*2` → read C2 = **64** → `write_cells` A2=41 + D3 marker → read-back A2=41, **C2=82** (live recompute), D3 marker; `recalculate` ok; `get_results` ok.
- **Leg 2, composed launcher + independent parse-back** (`evidence/fix-roundtrip-composed.jsonl`, saved file `work/saved.xlsx`): the original Phase 3 sequence on the real fixture `closedxml-xlsx-bug-fixes.xlsx`, unchanged in method — baseline A2=1, C2 computes 2, edits land, C2=82; launcher saved host-side on SIGTERM; **SheetJS parse-back (no engine code): ALL PASS** — A2=41, D3 marker, C2 carries formula `A2*2`, Sheet2 + untouched cells preserved. (The bin has no workbook load/save surface by design — ai-agent.md §2 + original REPORT Check 2 — so the parse-back leg runs on the composed host exactly as in the original validation, while every tool call is additionally exercised against the fixed bin in Leg 1.)

### (e) CSV data source — ✅ PASS (`evidence/fix-datasource.jsonl`)
Against the fixed bin: `list_data_sources` (csv-url registered) → `open_data_source` over real HTTP → sheet "Validation Products", exact typed grid read back, `refresh_data_source` ok. **Item-5 pin on the wire: open rows = 4, binding-summary rows = 4, refresh rows = 4** (before the fix the summary said 5).

## Process notes / not run
- Two early probe attempts timed out at 8–10 s and were initially misread as refusals failing; a direct foreground run proved the bin exits 1 with the designed message in ~7 s (module-graph load on this loaded VM; ~1 s CPU). Harness timeouts were raised to 60–120 s; all final evidence above is from the raised-timeout runs.
- **stdio transport** — not re-driven (unchanged by these fixes; the deployed topology is the HTTP runner, as in the original validation).
- **Deploy decision left for the parent (flagged loudly):** `mcp.yaml` sets no `MCP_STORE`, so as deployed the MCP service will run the **local file-backed** store — durable across process restarts on the same Cloud Run instance, lost on instance replacement. Setting `MCP_STORE=prod` makes it fail closed until a Firestore adapter for the sync `Persistence` seam is built (a named follow-up). Either way it can no longer silently run in-memory or unauthenticated.
- No git push; `progress.md` untouched; no other package modified (the only non-mcp-server edit is the `ENGINE_URL` removal in `deploy/services/mcp.yaml`).

## Evidence index (`hidden_files/mcp-validation/fix-round/`)
- Scripts: `mint-tokens.mjs`, `fix-auth.mjs`, `fix-memory.mjs`, `fix-memory-run.mjs`, `fix-legs-run.mjs`, `fix-ratelimit.mjs` (sequential, window-rolled), `fix-ratelimit-parallel.mjs`, `fix-ratelimit-run.mjs`, `fix-roundtrip-bin.mjs`, `fix-roundtrip-composed.mjs`, `fix-parseback.mjs`, `fix-datasource.mjs`, `fix-composed-run.mjs`, `start-composed.sh`
- Transcripts/logs: `evidence/fix-auth.jsonl`, `evidence/fix-memory-*.jsonl`, `evidence/fix-memory-run-output.txt`, `evidence/fix-failclosed.log`, `evidence/fix-legs-run-output.txt`, `evidence/fix-roundtrip-bin.jsonl`, `evidence/fix-roundtrip-composed.jsonl`, `evidence/fix-datasource.jsonl`, `evidence/fix-ratelimit.jsonl`, `evidence/fix-ratelimit-parallel.jsonl`, `evidence/fix-ratelimit-run-output.txt`, `evidence/fix-composed-run-output.txt`, `evidence/fix-bin*.log`, `evidence/composed-launcher.log`, `evidence/csv-http-server.log`
- Saved workbook: `work/saved.xlsx` · Persisted memory files: `work/data/` · Tokens (throwaway fix-round secret): `work/{valid,wrong,expired}-token.txt`
