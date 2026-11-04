# W1 Probe Report — Vertex wiring, backend-in-path toggle, agent↔engine binding

Run: 2026-10-21 ~16:27–16:55 PDT, local stack (gateway :8100, engine :8101, agent via gateway).
Scripts: `probe.mjs` (run 1), `probe2.mjs` (corrections/separation), `probe3.mjs` (502 diagnosis + binding via session join).
Raw evidence: `results.json`, `results2.json`, `results3.json`, transcripts in `transcripts/`.
Credential hygiene: the GCP access token was minted in-process only (`gcloud auth print-access-token`),
passed only to the Vertex Authorization header and to `POST /api/agent/config` (the vault seam).
Verified afterwards: no GCP access-token value and no JWT value exists anywhere in this probe directory.

## 1. Vertex endpoint / model verdict — WORKS

Direct smoke test against the Vertex OpenAI-compatible endpoint
`https://us-central1-aiplatform.googleapis.com/v1/projects/dreamscapes-zero/locations/us-central1/endpoints/openapi/chat/completions`:

| Model id tried | Status | Latency | Response snippet |
|---|---|---|---|
| `google/gemini-2.5-flash-lite` | **200** | 1,250 ms | `pong` (as requested) |
| `gemini-2.5-flash-lite` | not tried — first id worked, no 404 | — | — |

**Verdict: use model id `google/gemini-2.5-flash-lite`.** Evidence: `transcripts/step1-vertex-smoke.json`.

### Step 1 addendum (coordinator follow-up, ~16:36 PDT — explicit status/headers, both model ids)

Coordinator's parallel smoke: token mint works; the **native** `generateContent` endpoint for
`gemini-2.5-flash-lite` works (artifacts codegen Vertex access proven); their curl to this
OpenAI-compat endpoint printed an **empty body with status uncaptured**. Re-ran from this VM with
status + full response headers captured, generous (180 s) timeout, both ids, plus a repeat
(`probe-step1b.mjs`, evidence `transcripts/step1b-vertex-headers.json`):

| Model id | Status | Latency | Body |
|---|---|---|---|
| `google/gemini-2.5-flash-lite` | **200 OK** | 2,296 ms | Full chat.completion JSON, content `pong`, `usage: prompt 5 / completion 1 / total 6` tokens |
| `google/gemini-2.5-flash-lite` (repeat) | **200 OK** | 555 ms | Same, content `pong` |
| `gemini-2.5-flash-lite` | **400** | 429 ms | Error JSON: `Malformed publisher model ('gemini-2.5-flash-lite') for the 'openapi' request endpoint ID; expected '<publisher>/<model>'.` (`INVALID_ARGUMENT`) — the bare id is rejected, not silently |

Response headers (200 call): `content-type: application/json`, `server: scaffolding on HTTPServer2`,
`transfer-encoding: chunked`, `content-encoding: gzip`, `x-content-type-options: nosniff`,
`x-frame-options: SAMEORIGIN`.

**Reconciliation:** the empty-body result could NOT be reproduced from this VM — the endpoint
returns 200 with a complete body for `google/gemini-2.5-flash-lite` on repeated calls, and a
well-formed 400 error body (not empty) for the bare id. The coordinator's empty body is most
consistent with their curl/egress-proxy path dropping the (gzip/chunked) body with the status
uncaptured; the endpoint itself is healthy for this project. The OpenAI-compat path therefore
stands as the planner wiring (steps 2–5 proceeded on it); no alternative wiring was improvised.

## 2. Agent model config through the product seam — WORKS

`POST /api/agent/config` (alice JWT, provider `openai-compatible`, baseUrl = Vertex openapi base above,
model `google/gemini-2.5-flash-lite`, apiKey = minted token) → 200 in 57 ms.
`GET /api/agent/config` → 200 in 16 ms, describe output (identical on POST return and GET):

```json
{"provider":"openai-compatible",
 "baseUrl":"https://us-central1-aiplatform.googleapis.com/v1/projects/dreamscapes-zero/locations/us-central1/endpoints/openapi",
 "model":"google/gemini-2.5-flash-lite",
 "hasKey":true}
```

Key never returned, only `hasKey:true`. Evidence: `transcripts/step2-config.json`.

## 3. Live chat proof (task prompts, one thread `probe-w1-…`) — FAILED as specified; root causes isolated below

| Step | Prompt | HTTP | Latency | Agent reply (verbatim) | Audit |
|---|---|---|---|---|---|
| 3a | "Set A1 to 111, A2 to 222, and A3 to 333 on Sheet1." | 200 | 1,982 ms | "Setting cells A1, A2, and A3 on Sheet1." | `write_cells` args `{"sheet_name":"Sheet1","cells":{"A1":"111","A2":"222","A3":"333"}}` → **ok:false, "write_cells failed: undefined"** |
| 3b | "What is the sum of A1:A3 on Sheet1?" | 200 | 654 ms | "Reading cells A1:A3 from Sheet1 to calculate their sum." | `read_cells` args `{"sheet_name":"Sheet1","cell_range":"A1:A3"}` → **ok:false** |
| 3c | "Read Sheet1 A1:A3 and tell me which of the values is the largest, and what you get if you double it." | 200 | 723 ms | "Reading cells A1:A3 from Sheet1 to find the largest value and double it." | `read_cells` args `{"sheet_name":"Sheet1","range":"A1:A3"}` → **ok:false** |

**The expected outcomes did NOT occur**: no 666 answer, no 333/666 composition, no cells were written.
The replies are the model's first-plan *status messages*, returned as the final answer.
Evidence: `transcripts/step3a-write.json`, `step3b-sum.json`, `step3c-largest-double.json`.

### Why — two compounding defects (code-verified)

- **D1 — the OpenAI backend never tells the model the MCP tool arg schemas.**
  `packages/service/src/agent/openaiBackend.ts` `SYSTEM_PROMPT` lists no argument shapes;
  the plan request only appends tool *names*. Gemini therefore guesses a plausible-but-wrong
  schema on every call (`sheet_name` + `cell_range`/`range`, a `cells` *dict*, `{cell, value}`),
  while the real MCP schema (`packages/mcp-server/src/server.ts`) is
  `read_cells {sheet, startRow, startCol, endRow, endCol}` and
  `write_cells {cells: [{sheet, row, col, value}]}` — the shapes the *heuristic* backend
  hard-codes in `backends.ts`. Every guessed call fails MCP zod validation, and the runtime's
  `parseToolResult` loses the validation message, surfacing literally `failed: undefined`.
- **D2 — a plan containing `done` ends the turn after its tools run.**
  `runtime.ts` `runLoop`: `done = plan.actions.some(a => a.type === 'done') || …` → returns
  `plan.message` immediately. The backend's system prompt instructs the model to
  *"End every plan with {"type": "done"}"*, so read-then-answer composition normally never
  reaches iteration 2 — the first plan's status sentence is the reply.

### Separation test — with the schema supplied in the prompt, the loop itself works

Same live backend/config, prompts that dictate the exact arg JSON (transcripts `step3-hint-*.json`):

- Hint-write: 200, 1,442 ms — `write_cells` **ok:true** (111/222/333 written into the agent's host).
- Hint-largest: 200, 1,428 ms — `read_cells` **ok:true** with the exact args (reply was still the
  plan status message — D2 bit again on this turn).
- Hint-sum: **gateway 502 at 30,063 ms** — server-side the model parked the turn on
  `agent.offer_options` ("What is the sum of the values read?", options `["111","222","333","666"]`)
  instead of answering; see D4. (The model did surface 666 — as a multiple-choice option, never as an answer.)
- Composition proof that iteration-2 *can* happen: in the binding re-run (§5) the agent answered
  from a successful read with a fully composed sentence (model omitted `done` in plan 1 that turn).

## 4. Backend-in-path toggle proof — PROVEN (with a gateway-timeout caveat)

- Config re-POSTed with `apiKey:'invalid-token-for-proof'` (same provider/baseUrl/model), then one chat →
  **HTTP 500 in 72 ms**: `agent error: openai-compatible backend: provider returned 401 (… "Request had
  invalid authentication credentials. Expected OAuth 2 access token…")`. The live Gemini/Vertex path is
  genuinely in the planning path — a bad key fails at the provider, not locally.
  Evidence: `transcripts/step4-invalid-key.json`.
- Config re-POSTed with a **fresh** minted token → describe back to `hasKey:true`. Subsequent chats:
  the plain question "What is in Sheet1 A1?" returned **gateway 502 at ~30 s on 4 consecutive attempts**
  (run 1: 30,068 ms; probe2 retries: 30,095 / 30,116 / 30,037 ms) — **but this is D4, not an auth failure**:
  `GET /api/agent/pending` afterwards listed the parked HITL asks those turns created
  (3× "Please specify the sheet name, start row, start column, end row, and end column.", unanswered).
  With the restored key, schema-hinted chats succeeded through the gateway
  (hint-write 200/1,442 ms `write_cells ok`; hint-largest 200/1,428 ms `read_cells ok`; binding read
  200/2,874 ms composed answer) — **restored success is proven**; the 502s are the parking/timeout defect.
  Evidence: `transcripts/step4-restored-key.json`, `step4-restored-retry.json`, `step4-pending-asks.json`.

- **D4 — HITL parking vs gateway proxy timeout.** When the model chooses an `ask`/`agent.*` action,
  `/message` blocks waiting for a human (agent-side HITL timeout is 4 min), but the gateway proxy
  gives up at ~30 s and returns `502 {"ok":false,"error":"backend unavailable"}`. Any API-only (or
  slow-to-answer) interaction with such a turn looks like a backend outage. Reproduced 5× total.

## 5. Binding probe — VERDICT: NOT BOUND. The gateway-mode agent acts on a PRIVATE workbook.

Fixture loaded into the **engine service** via `POST /api/engine/open` + engine `/load`
(Sheet1: A1=7001, A2=7002, A3=7003, B1='GRIDWORKBOOK'), session
`sess_fc497fdb-c706-490e-88ad-bfc33f51b28e`, file `file-960d6f76-2494-4fc7-91dc-965ad347821b`.
(Run 1 joined/loaded it; the engine's one-owner rule — a second `apiSetupSession` got
`409 engine already owns a different file` — forced probe3 to *join* that same session, which it did:
`joined:true, revision:0`. Run 1's own engine read-back attempt was invalid — `apiReadCell` called
without the explicit accessToken → 401; probe3 redoes it correctly.)

Engine-service reads of the fixture session (probe3, all HTTP 200):
`A1={kind:number,value:7001}`, `A2=7002`, `A3=7003`, `B1={kind:string,value:"GRIDWORKBOOK"}`, `C1=null`.

Agent, new thread, asked for A1:A3 + B1 — plain prompt in run 1 failed at D1 (both `read_cells` ok:false,
reply was a status sentence). Schema-hinted re-ask in probe3 (read ok:true) — **reply verbatim**:

> "The values in A1:A3 are 111, 222, and 333. B1 is null."

Those are the values written earlier into the **agent's own host** (§3 separation test) — the agent has
never seen 7001/7002/7003/'GRIDWORKBOOK'. Its A1:A3 view after step 3 was 111/222/333, not the fixture's.

Agent then wrote C1=424242 (schema-hinted): audit `write_cells ok:true`, reply
"Writing 424242 to Sheet1, row 0, col 2." (718 ms). **Engine-service read-back immediately after:
C1 still `null`, A1 still 7001.** The write landed only in the agent's private host.

**Conclusion (evidence only): in gateway mode the agent does NOT see or act on the workbook the
engine service hosts.** It reads/writes a separate per-principal in-process `EngineHost` inside the
agent service (`createServer(undefined)` in `agentSvc.ts`), exactly the risk flagged in
COORDINATION.md. Nothing syncs the two. Evidence: `transcripts/step5-binding-read.json`,
`step5-binding-write.json` (run 1), `step5c-binding-read.json`, `step5c-binding-write.json`,
`results3.json` (engine sanity + after-reads).

## Latency summary

Vertex direct 1,250 ms · config POST 57 ms / GET 16 ms · plain chats 654–1,982 ms (fail-fast on bad
tool args) · hinted chats 718–2,874 ms · one binding read 14,256 ms (run 1, Vertex slow tail) ·
parked turns: gateway 502 at 30,037–30,116 ms (proxy timeout) ×5.

## State left behind

Alice's agent config remains `openai-compatible` + Vertex baseUrl + `google/gemini-2.5-flash-lite`
with a valid minted token in the vault (expires ~1 h from mint; re-mint + re-POST config to renew).
The fixture engine session was left open (owned by alice's session above). No stack restart, no dist
rebuild, no git push were performed.

## Bottom line for the gate

Vertex wiring and the config seam are **real and working**; live Gemini is **provably in the planning
path** (401 toggle). But the live chat loop is **not usable as shipped**: D1 (no tool schemas in the
planner prompt → every natural prompt's tool calls fail), D2 (done-in-plan ends turns before
composition), D4 (HITL parking surfaces as gateway 502), and above all **D3: the agent is bound to a
private workbook, not the user's engine session** — the central defect from COORDINATION.md is
confirmed with direct evidence.
