# @icecream-sheets/mcp-server

Phase 3 of Icecream Sheets: an MCP server driving
`@icecream-sheets/engine`, plus synchronous JavaScript/Python sandboxes and a
HyperFormula plugin exposing `ICEEVAL(code, ...args)` to formulas.

## Transports

The server runs over BOTH transports — same tool registry, same
`createServer`:

- **stdio** (`src/index.ts`): `npm run build && node dist/index.js`
  (speaks MCP over stdio).
- **Streamable HTTP** (`src/bin/http.ts`): the production runner.
  `npm run build && node dist/bin/http.js` — MCP endpoint at `/mcp`,
  health probe at `/health`; listens on `PORT` (default 8106) and
  `HOST` (default `127.0.0.1`).

## Production runner posture

The shipped HTTP runner (`src/bin/http.ts`) is MCP's own direct
ingress — it is never behind the API gateway (the gateway never sees
MCP traffic and never validates MCP users):

- **Auth always enforced, fail-closed.** The bin always starts the
  HTTP layer with `requireAuth: true`; Bearer JWTs are verified
  in-process with `MCP_AUTH_SECRET`. If `MCP_AUTH_SECRET` is missing,
  empty, or whitespace, the runner refuses to start (error to stderr,
  exit 1, before listening). There is no anonymous escape hatch in the
  shipped runner; for local dev, set any throwaway value.
- **Durable persistence, selected by `MCP_STORE`.** Unset or `local`
  → a file-backed store (one file per key, atomic writes) under the
  data directory: `MCP_DATA_DIR` if set, else
  `$ICECREAM_DATA_DIR/mcp`, else `~/.icecream-sheets/data/mcp` — agent
  memory, specs, and data-source bindings survive restarts. `prod`
  fails closed: the deployed metadata store is Firestore, but there is
  no Firestore adapter for the synchronous `Persistence` seam yet, so
  the runner refuses to start rather than silently losing agent
  memory on restart. Any other `MCP_STORE` value is rejected.
- **Own rate-limit tier:** 6000 requests / 60 s per principal,
  independent of the gateway's limiter.

## Tools

Every tool response is `{ protocolVersion: 1, ok: true, ... }` on success, or
`{ protocolVersion: 1, ok: false, error }` with `isError: true` on failure.
Handlers never throw.

Generated from the live tool registry — regenerate after building with: node scripts/list-tools.mjs

| Tool | What it does |
|---|---|
| `agent.answer_pending` | Deliver the human's answer to a pending ask, unblocking the paused agent.* tool call. Principal-scoped (ai-agent.md §3): only the principal the ask was created for can answer it — anyone else gets an authorization error. |
| `agent.ask_question` | Human-in-the-loop: ask the user a free-text question. The tool call PAUSES the agent until the user answers via agent.answer_pending (or the wait times out — it never hangs forever). There is no path around MCP. |
| `agent.list_pending` | List the caller's pending human-in-the-loop asks (ai-agent.md §12) — what the paused agent is waiting for. Principal-scoped: only the caller's own asks are returned. |
| `agent.offer_options` | Human-in-the-loop: ask the user to choose one of the offered options. The tool call PAUSES the agent until the user answers via agent.answer_pending (or the wait times out). There is no path around MCP. |
| `agent.request_approval` | Human-in-the-loop: request the user's approval before a broad or destructive action (ai-agent.md §7). The tool call PAUSES the agent until the user approves or denies via agent.answer_pending (or the wait times out). Ambiguous answers are treated as denied with the text kept as a note — the agent must never guess. There is no path around MCP. |
| `analyze_data` | Run the data-analysis pipeline on a sheet range: extracts the data schema, classifies the analytical intent ("analyze the data and show me a diagram", "pivot this", "forecast next quarter", ...), generates a versioned Python script, executes it deterministically in the sandbox, and returns the analysis summary plus a Chart.js spec. The script is persisted as a versioned, re-runnable analysis artifact. Reads go through authorize(): denied cells are excluded, never leaked. |
| `appbuilder_create_spec` | Create a no-code app spec (versioned, serializable) in the service metadata store. The spec is validated; invalid specs are rejected with the validation errors. Requires the app manage right. |
| `appbuilder_delete_spec` | Delete a stored app spec by id. Requires the app manage right. |
| `appbuilder_get_spec` | Fetch a stored app spec by id. |
| `appbuilder_list_specs` | List stored app specs (id, name, version, views, actions). |
| `appbuilder_update_spec` | Replace a stored app spec (full replacement after validation; older versions are migrated). The spec id must match. Requires the app manage right. |
| `create_chart` | Create a NATIVE chart in the sheet, bound to sheet data: the chart is inserted into the workbook itself, is visible in the grid, persists, and saves with the file. "range" is an A1 string (e.g. "A1:C10") that INCLUDES the header row; the first column holds category labels and each remaining numeric column becomes a series. "kind" is one of column\|bar\|line\|area\|pie\|doughnut (fail-closed: any other kind is rejected). "anchor" is an optional A1 cell for the chart's top-left placement; default is below the data range. This is NOT analyze_data (which only shows an ephemeral chart in chat). |
| `create_pivot` | Build a PivotTable over a rectangular range (first row is the header). Stores a versioned pivot spec in the service metadata and returns a summary. |
| `execute_code` | Run code in the Icecream Sheets sandbox. JavaScript: the script completion value is the result and `args` holds the inputs. Python: `args` is a dict and the program must assign `result`. |
| `get_pivot_data` | Return the full rendered matrix of a stored PivotTable. |
| `get_results` | Read the full used-range values of a sheet. Goes through authorize(): cells the principal cannot read come back as #PERM! errors. |
| `list_analyses` | List stored analysis artifacts (newest first): id, intent, intent kind, range, script version, creation time. The full Python source is NOT returned here; fetch it via rerun_analysis semantics or the artifact store. |
| `list_data_sources` | List the registered connector kinds and the data sources currently bound to this workbook's sheets. Connected data lives in the engine, so read_cells sees it like any other sheet. |
| `list_subscriptions` | List active event subscriptions. |
| `memory_load` | Load a value from the agent long-term memory (per-user service metadata). |
| `memory_save` | Save a value to the agent long-term memory (per-user service metadata). Overwrites any existing value. |
| `memory_update` | Patch a value in the agent long-term memory. When both stored and new values are objects, shallow-merge; otherwise replace. |
| `open_data_source` | Fetch a data source through a connector and materialize it as a new sheet in the typed computational view. The connector spec is stored as a source binding for later refresh_data_source calls. Secrets are never accepted here: authenticate with a vault credentialRef, not a secret value. |
| `poll_events` | Drain buffered events for a subscription (oldest first). The MCP stdio transport is request/response, so clients poll; this is what the AI Agent proactivity loop uses. |
| `read_cells` | Read a rectangular range of computed cell values. Reads go through authorize(): cells the principal cannot read come back as #PERM! errors, never leaked values. |
| `recalculate` | Force a full recalculation of the workbook. |
| `refresh_data_source` | Re-fetch the connector behind a bound sheet and atomically swap its data region (writes then stale-tail clears, in one pass). Cells outside the previously materialized region are never touched. |
| `refresh_pivot` | Recompute a stored PivotTable against the current source range values. |
| `report_create_spec` | Create a native report spec (versioned, serializable) in the service metadata store. The spec is migrated forward and validated; invalid specs are rejected with the validation errors. Requires the report manage right. |
| `report_delete_spec` | Delete a stored report spec by id. Requires the report manage right. |
| `report_get_spec` | Fetch a stored report spec by id. Requires the report read right. |
| `report_list_specs` | List stored report specs (id, name, version, bindings, visuals, refresh mode). Requires the report read right. |
| `report_update_spec` | Replace a stored report spec (full replacement after migration + validation; older versions migrate forward). The spec id must match. Requires the report manage right. |
| `rerun_analysis` | Deterministically re-execute a stored analysis artifact: re-reads the same range, re-runs the exact persisted Python script in the sandbox, and reports whether the input data changed since the original run. The stored artifact is immutable (auditability); the fresh result is returned, not persisted over it. |
| `rtd_publish` | Publish a real-time data value to an RTD topic. Cells using RTD(progId, server, topic, ...) update on the next recalculation, which this tool triggers automatically. |
| `set_formulas` | Set formulas on cells. Formulas may omit the leading "=" (it is added automatically). |
| `subscribe` | Subscribe to engine events. Events are buffered per subscription; drain them with poll_events. |
| `unsubscribe` | Remove an event subscription. Buffered events are discarded. |
| `write_cells` | Write literal values to cells. A string value starting with "=" is treated as a formula by the engine. Writes go through authorize(): locked cells and read-only principals are rejected per cell. |

Example session: `write_cells` A1:A3 = 1,2,3 → `set_formulas` A4 `=SUM(A1:A3)` →
`read_cells` returns `6` in A4.

## `ICEEVAL` formula function

`=ICEEVAL("arg1 * 2", 21)` → `42`. The first argument is JavaScript source;
remaining scalar arguments are exposed as `arg1`, `arg2`, … (and via `args`).
Runs synchronously inside recalculation with a 1s CPU budget. Sandbox
failures surface as `#VALUE!` cell errors — a bad script can never crash
recalculation. Only finite numbers, strings, booleans and null are returned;
anything else becomes `#VALUE!`.

Importing `@icecream-sheets/mcp-server` (or `./engine-plugin.js` directly)
registers the function globally with HyperFormula — import it before creating
engine instances.

## Sandbox security model (honest)

**JavaScript** (`node:vm`):
- Fresh vm context per call. Only `args` crosses the boundary, serialized
  through JSON *inside* the guest, so guest code cannot reach host
  intrinsics via constructor chains. Guest sees `args`, bare bindings for
  identifier-safe arg keys, and the guest realm's own `Math`/`JSON`.
- No `require`, `process`, `console`, `Buffer`, timers, `fetch`, `URL`, I/O.
- CPU bounded by the vm timeout (default 2000ms).

**Python** (`python3` child process, argv/stdin — never a shell):
- `builtins` replaced with a safe subset (no `open`, `eval`, `exec`,
  `compile`, `input`, `globals`, …).
- `__import__` hook allowlists only `math`, `json`, `re`, `itertools`,
  `functools`, `datetime`, `statistics`; everything else (`os`, `sys`,
  `subprocess`, `socket`, …) raises `ImportError`.
- Program must assign `result`; it is printed as JSON and parsed back.
- Wall-clock bounded by child timeout (default 2000ms, kills the child).
- Linux-only best-effort address-space cap (256MB) via `resource.setrlimit`.

**Limits, stated plainly:**
- Neither sandbox is a hard security boundary. `node:vm` is explicitly not
  one per the Node.js docs, and Python's object model remains reachable, so a
  determined attacker may escape. Treat these as protection against accidents
  and casual probing — never run truly hostile code, and never grant the MCP
  server process ambient authority you wouldn't grant the code it runs.
- `datetime` is allowlisted, so `datetime.datetime.now()` exposes wall-clock
  time. `random` is not allowlisted.
- Requires a `python3` binary on PATH for the Python sandbox.

## HyperFormula plugin notes (API friction found)

1. **Translations are mandatory, not optional.** Registering the plugin class
   alone is insufficient: the interpreter's `getFunction()` also requires
   `translationPackage.isFunctionTranslated(id)`, otherwise formulas fail
   with `#NAME?` even though `getFunctionPlugin()` reports the plugin
   registered. We register `enGB` (this build's default language; `enUS` is
   *not* registered and would be silently skipped by `loadTranslations`).
2. **Dual builds, one registry.** HyperFormula ships `commonjs` (`main`) and
   `es` (`module`) builds with no `exports` map. Plain Node ESM resolves
   `main` for everyone (production is consistent), but Vite prefers `module`,
   loading a second copy with a second, empty function registry. The
   `vitest.config.ts` aliases `hyperformula` to the `commonjs` build so tests
   exercise the production-consistent wiring.
3. **Deep type imports need `.js` suffixes.** Under `moduleResolution:
   NodeNext`, `hyperformula/typings/parser/Ast` does not resolve, but
   `hyperformula/typings/parser/Ast.js` maps to the `.d.ts`. Used for
   `ProcedureAst`/`InterpreterState`/`InterpreterValue`, which are not
   re-exported from the package root.
