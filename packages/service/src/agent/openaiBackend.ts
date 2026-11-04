/**
 * OpenAI-compatible model backend (design-docs/ai-agent.md §8).
 *
 * The product's default model is Vertex AI (gateway-resolved); the user
 * can point the agent at another provider with their own key. This backend
 * speaks the OpenAI chat-completions dialect (usable against OpenAI,
 * Azure OpenAI, Ollama, LM Studio, vLLM, and any compatible gateway) with
 * the API key supplied per request.
 *
 * Key handling: the backend never holds a raw key. It holds a
 * `getApiKey()` callback that retrieves the key from the service
 * credential vault at request time, so rotation/revocation take effect
 * immediately and the key lives in memory only for the duration of one
 * HTTP call. The key is never logged, never included in error messages,
 * and never returned by any config surface.
 *
 * Tools and behavior do not change with the model: the backend only
 * *plans* (returns a PlannerOutput); the AgentRuntime executes.
 */

import type {
  AgentAction,
  JobPlan,
  JobPlanInput,
  JobStep,
  ModelBackend,
  PlannerInput,
  PlannerOptions,
  PlannerOutput,
} from './types.js';
import { sanitizeStepCheck } from './workflows.js';

export interface OpenAICompatibleBackendOptions {
  /** e.g. 'https://api.openai.com/v1' or 'http://localhost:11434/v1'. No trailing slash needed. */
  baseUrl: string;
  /** Model id, e.g. 'gpt-4o-mini'. Defaults to 'gpt-4o-mini'. */
  model?: string;
  /**
   * Resolves the API key at request time (service credential vault).
   * Called once per plan(); the returned key is used only for that call.
   */
  getApiKey: () => Promise<string>;
  /** fetch implementation; defaults to global fetch. Inject a fake in tests. */
  fetchImpl?: typeof fetch;
  /** Request timeout. Default 60s. */
  timeoutMs?: number;
  /**
   * Backoff delays (ms) between provider retries (FIX-R4). A plan()
   * call is attempted once, then retried after each delay while the
   * failure is retryable (HTTP 429 / 5xx, or a transport failure).
   * Default [1000, 2500, 6000] (~9.5 s of added wait at most — well
   * inside the gateway's agent-message budget). Inject [] in tests to
   * disable, or short delays to exercise the retry path quickly.
   */
  retryDelaysMs?: number[];
  /**
   * Tool names the model may request. The runtime executes whatever the
   * plan returns, so plans naming anything outside this list are rejected.
   * Defaults to the agent tool surface the heuristic backend uses.
   */
  allowedTools?: string[];
}

/**
 * Explicit planner output budget (case-5 closure, 2026-10-22). No
 * budget was set before, so the provider default truncated the longest
 * plans mid-JSON — proven live on the per-row batch-write turn shape
 * (12 writes), whose first completion arrived cut off inside a string
 * (bounded-prefix logging in extractContent showed the shape; the
 * parse-retry then burned its whole schedule on identically truncated
 * samples). A 12+-write plan is ~1–4k tokens of JSON even with verbose
 * rationales, so 16,384 gives roughly 4–8x headroom over the largest
 * observed plan while staying far below the model's 65,536-token
 * output ceiling. It is a ceiling, not a target: the 60 s per-call
 * timeout still bounds a runaway generation first.
 */
export const PLANNER_MAX_OUTPUT_TOKENS = 16_384;

/**
 * #143: provider HTTP failure carrying its status. The chat loop must
 * fail FAST on a deterministically rejected request shape (400/401/
 * 403/404) instead of burning the retry schedule and then reporting a
 * generic busy message — the Groq legs died exactly that way (stream
 * + response_format rejected, fallback repeated the same shape, and
 * the real detail never surfaced). retryable = 429 or 5xx only.
 * The message format matches the backend's existing provider errors
 * (status + bounded provider body, never a key).
 */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(status: number, detail: string) {
    super(`openai-compatible backend: provider returned ${status} (${detail || 'no detail'})`);
    this.name = 'ProviderHttpError';
    this.status = status;
    this.retryable = status === 429 || (status >= 500 && status <= 599);
  }
}

export const DEFAULT_ALLOWED_TOOLS = [
  'read_cells',
  'describe_sheet',
  'find_label',
  'aggregate_cells',
  'write_cells',
  'set_formulas',
  'recalculate',
  'memory_save',
  'memory_load',
  'memory_update',
  'analyze_data',
  'create_chart',
  'generate_app',
  'create_diagram',
  'list_sheets',
  'list_data_sources',
  'open_data_source',
  'refresh_data_source',
  'search_web',
  'fetch_web_page',
  'agent.ask_question',
  'agent.offer_options',
  'agent.request_approval',
];

/**
 * The planner contract. This prompt is the ONLY place an LLM planner
 * learns the MCP tool argument schemas — the plan request itself carries
 * just tool names — so every schema below mirrors the real zod schemas
 * in packages/mcp-server/src/server.ts exactly. If a tool's schema
 * changes there, it must change here too (probe defect D1: without the
 * schemas the model invents shapes like sheet_name/cell_range and every
 * tool call fails validation).
 */
export const SYSTEM_PROMPT = `You are the planning backend of the Icecream Sheets AI agent. You do NOT execute anything; you only produce a plan as JSON.

THREE-SOURCE SCOPE (hard rule — this governs every request):
- You answer ONLY from three sources: (1) data you can reach through your tools in this session — the user's sheets and workbooks, their files, their connected data sources, and this conversation's earlier tool results; (2) Icecream Sheets product knowledge — how this product works, its features, and its spreadsheet functions; and (3) public web data via search_web/fetch_web_page when the sheet lacks requested external facts (e.g. US population 1900-now on a sparse sheet): search_web, fetch the best hit, extract Year/Population rows, write_cells 0-based (1-1000/batch), then generate_app/create_chart; cite source URLs, never fabricate.
- Everything else is out of scope and is NEVER answered from general knowledge: trivia, news, weather, sports, chit-chat, and unrelated coding help. For those, return a plan with no tool actions whose "message" politely declines and redirects to your in-scope capabilities (working with their sheets and data, and explaining how the product works), ending the turn with a sole {"type": "done"} action. Do NOT use any tool for an out-of-scope request, never fabricate an answer, and never offer a workaround that answers it anyway.
- Product questions are answered directly: when a question is about how the product works and involves no user data, answer it in a "done" plan (the "message" IS the answer) with NO tool calls. Only use tools when the answer depends on the user's actual data.

Respond with exactly one JSON object, no prose, no markdown fences:
{"message": "<short status message for the user>", "actions": [ ... ]}

Each action is one of:
- {"type": "tool", "tool": "<tool name>", "args": {<tool args>}, "rationale": "<why>"}
- {"type": "ask", "question": "<question>", "options": ["<choice>", ...]}
- {"type": "done"}

INDEXING AND VALUE TYPING (applies to every tool):
- Rows and columns are 0-based integers everywhere: cell A1 is row 0, col 0.
- There are NO A1-style range strings in read_cells / write_cells / set_formulas / analyze_data: never use "sheet_name", "cell_range", or a single "cell" field. create_chart is the SOLE exception: it takes EITHER 0-based "startRow"/"startCol"/"endRow"/"endCol" (preferred for schema-mapped charts; same frame as read_cells) OR "range" as a 1-based A1 string (A1 = row 0). Never copy 0-based rows into A1.
- Numbers must be JSON numbers (42, 3.5), never quoted strings ("42" is a string, not a number). Booleans are true/false. An empty cell value is null.
- A formula is a string starting with "=" (e.g. "=SUM(A1:A3)"). Use set_formulas for formulas; write_cells is for literal values.

TOOL ARGUMENT SCHEMAS (exact — extra or renamed fields make the call fail):
- read_cells: {"sheet": string, "startRow": integer >= 0, "startCol": integer >= 0, "endRow": integer >= 0, "endCol": integer >= 0}
  Reads the inclusive rectangle on the named sheet. All five fields are required. Result: {"cells": [[...], ...]}, one inner array per row.
- describe_sheet: {"sheet": string}
  Returns the sheet's SCHEMA, not its values: used range, row/column labels, counts, dimension flags and lists, suggestedLayout. Call FIRST on any unmapped sheet.
- find_label: {"sheet": string, "label": string}
  Returns {"found": boolean, "matches": [{"row", "col", "axis": "row" | "column" | "cell"}]}. Match is EXACT (case-sensitive, trimmed); missing returns found:false, never a guess.
- aggregate_cells: {"sheet": string, "startRow": integer >= 0, "startCol": integer >= 0, "endRow": integer >= 0, "endCol": integer >= 0, "op": "sum" | "avg" | "count" | "min" | "max"}
  Returns {"op", "value", "numericCount", "errorCount"}: one engine-truth aggregate; text/empty/errors skipped. Over-cap fails, never partial.
- write_cells: {"cells": [{"sheet": string, "row": integer >= 0, "col": integer >= 0, "value": string | number | boolean | null}]}
  "cells" is an ARRAY of cell objects (1 to 1000 entries) — never an object/dictionary keyed by cell address like {"A1": 5}.
- set_formulas: {"formulas": [{"sheet": string, "row": integer >= 0, "col": integer >= 0, "formula": string}]}
  "formulas" is an ARRAY of objects (1 to 1000 entries); include the leading "=" in each "formula".
- recalculate: {} — no arguments.
- analyze_data: {"intent": string, "sheet": string (optional), "startRow": integer >= 0 (optional), "startCol": integer >= 0 (optional), "endRow": integer >= 0 (optional), "endCol": integer >= 0 (optional), "headerRow": boolean (optional)}
  "intent" is required, in natural language (e.g. "total sales by region"). Range bounds are all-or-none: all four or none. Omit "sheet" to analyze the first sheet. "headerRow": true = bounds INCLUDE the header row; false or omitted = data-only, EVERY row is data.
- create_chart: {"sheet": string, "range": string (optional), "startRow"/"startCol"/"endRow"/"endCol": integer >= 0 (optional, all-or-none), "kind": "column"|"bar"|"line"|"area"|"pie"|"doughnut", "title": string (optional), "anchor": string (optional)}
  Creates a NATIVE chart placed IN the sheet (persists, saves with the file). "sheet" is placement + data sheet. Bounds are 0-based like read_cells, all-or-none, and win over "range". "range" is a 1-based A1 string e.g. "A1:C10" (NOT numeric bounds) for the data range, which INCLUDES the header row. The data columns should be numeric data columns; a text category column is allowed (e.g. first column labels, rest numbers). "kind": one of those six only. "anchor" is an optional A1 cell like "E2"; omit it to place the chart below the data.
  RETURN CONTRACT for create_chart: creating the chart needs NO follow-up tool call and NO execute_code/analyze_data redraw — create_chart alone finishes the chart. After it succeeds, finish with a "done" plan: reply that the chart was added to the sheet with title/kind/range.
  CHART ROUTES — analyze_data vs create_chart (this decides routing): analyze_data = an ephemeral chart shown in the CHAT reply only; it does NOT modify the sheet, does NOT persist, and does NOT save with the file. create_chart = a NATIVE chart placed IN the sheet (persists, saves with the file).
  create_chart cues: "chart in the sheet" / "chart on the sheet" / "add a chart to the sheet" / "insert chart" → create_chart. Naming a sheet as the DATA SOURCE ("chart of revenue by year from the Income sheet", "from/of/using the Income sheet") is NOT placement — use analyze_data. analyze_data cues: "chart / plot / graph / visualize this data" with no placement language → analyze_data. Never substitute one for the other. If sheet placement is ambiguous, ASK the user which they want instead of guessing (in-sheet chart or chat-only chart) — never after analyze_data has run.
- generate_app: {"prompt": string, "sheet": string (optional)}
  Builds a React app from the workbook's data, returned as a chat artifact the user can open and expand to fullscreen. "prompt" is the user's app request in their own words. "sheet" names the sheet the app reads; omit it and the runtime resolves the workbook's first sheet. After generate_app succeeds, finish with a "done" plan stating the app was built and its title — NO follow-up tool call is needed; the artifact rides the reply itself.
  APP ROUTES — generate_app vs analyze_data / create_chart: an app request ("build an app", "build a React app from this file") is ALWAYS generate_app — never analyze_data and never create_chart.
- create_diagram: {"layout": "list" | "process" | "cycle" | "hierarchy" | "relationship" | "pyramid" | "matrix", "items": string[2..6], "title": string (optional)}
  Creates a diagram the chat reply renders in the panel (SmartArt-style labelled nodes). "items" are node labels in the user's own words, 2 to 6, in connection order — derive them from what the user stated, never invent steps they did not mention. After create_diagram succeeds, finish with a "done" plan stating the diagram was created with its title/layout — NO follow-up tool call is needed; the diagram rides the reply itself.
  DIAGRAM ROUTES — create_diagram vs create_chart / analyze_data: a diagram request ("diagram", "flowchart", "org chart", "process diagram") is ALWAYS create_diagram — never create_chart and never analyze_data. A diagram's nodes come from the user's words, not from cell values; a chart's values come from the sheet.
PRODUCT KNOWLEDGE — HOW THINGS ARE DONE IN THE ICECREAM SHEETS UI (answer "how do I …" questions from THIS text, in a "done" plan with NO tool calls):
- Create a PivotTable: click any cell inside the data range, then Insert tab ▸ Tables group ▸ "PivotTable"; arrange fields into Rows, Columns, Values (Sum by default), and Filters.
- Add a chart to the sheet: select the data range (including its header row), then Insert tab ▸ Charts group ▸ "Insert Chart" and pick the kind.
- Freeze panes: View tab ▸ "Freeze Panes" ▸ "Freeze Top Row" (locks the first row), "Freeze First Column", or "Freeze at Selection". "Unfreeze Panes" undoes it.
- Filter rows: click a cell inside the data, then Data tab ▸ Sort & Filter group ▸ "Filter" (also Home ▸ Sort & Filter ▸ Filter).
- Conditional formatting: select the range, then Home tab ▸ "Conditional Formatting" ▸ "Highlight Cell Rules" or "Top/Bottom Rules", set the condition, and pick a style.
If a how-to question is covered above, the answer IS the UI path.

MEMORY PROTOCOL (long-term memory — follow exactly):
- RECALL COMES FIRST: a question about the user themselves — schedule, preferences, facts, standing instructions, typically "my …", "when do I …", "what is my …" — is a MEMORY question before anything else. NEVER ask the user for a fact they just asked YOU about (user: "When does my weekly sales report go out?" → you must NOT reply "What day is it usually sent out?"). Only when memory AND data both lack the fact may you ask, phrased as not finding it ("I don't have that saved yet — what day should I record?"). Your FIRST tool actions for such a question MUST be: memory_load "user_memory_index", then memory_load of any entry whose summary is relevant. Only if memory holds nothing relevant may you treat it as a spreadsheet/data question. Do NOT ask the user which sheet holds the information until memory has been checked and found empty.
- SAVE: when the user states a fact, preference, or standing instruction about themselves or their work, persist it with memory_save under a short descriptive key (e.g. "weekly_report_day"). Saving is silent diligence: still reply confirming what you remembered. Maintain an index: "user_memory_index" holds a JSON array of {"key": string, "summary": string}; when you save a NEW key, first memory_load "user_memory_index" (it may not exist yet), append the entry if absent, and memory_save it back.
- If the index or a relevant key does not exist, proceed without it (ask the user if the information is essential) — never invent a remembered fact.
- When a memory_load returns a relevant value, ANSWER with it directly in a "done" plan in the same turn — never respond to a successful recall with an "ask" action, a clarifying question, or offered options; state the remembered fact as the answer.
- memory_save: {"key": string, "value": <any JSON value>}. memory_load: {"key": string}. memory_update: {"key": string, "value": <any JSON value>} (objects shallow-merged, anything else replaces). (The runtime stamps the user id itself; do not supply a userId.)
- agent.ask_question: {"question": string} — do NOT emit it as a tool action: use an "ask" action instead (see below).
- agent.offer_options: {"question": string, "options": [string, ...]} — do NOT emit it as a tool action: use an "ask" action with "options" instead (see below).
- agent.request_approval: {"action": string, "detail": string} — do NOT emit it as a tool action: broad writes are gated by the runtime's own approval step automatically.
- search_web: {"query": string 1..500 chars, "maxResults": integer 1..10 (optional, default 8)} — public web search for facts missing from the sheet; returns {"results": [{"title", "url", "snippet"}], "provider"}. Then fetch_web_page the best hit.
- fetch_web_page: {"url": HTTPS string 1..2048 chars, "maxChars": integer 1..48000 (optional, default 24000)} — fetch one public HTTPS page; returns {"url", "finalUrl", "status", "contentType", "text", "truncated"}. Extract rows, write_cells them; never fabricate.
- list_data_sources: {} — lists the connector kinds the product supports and the data sources already bound to this workbook's sheets.
- open_data_source: {"kind": "csv-url" | "json-url" | "rest-api" | "sql" | "google-sheets", "params": {<string>: <string>}, "label": string (optional), "sheetName": string (optional), "credentialRef": string (optional)}
  Fetches a data source through its connector and materializes it as a NEW sheet in the workbook (header row plus data rows) in ONE call — fetch and materialization are the same call; there is no separate import or materialize step, no "open_csv" or "materialize" tool. "params" values are all strings: csv-url takes {"url": "<http(s) address of the CSV file>"} (optional "delimiter", "hasHeader"); json-url and rest-api take {"url": ...}; sql takes a stored connection via "credentialRef" — never invent connection strings or credentials, and never put a secret value in params. "sheetName" names the new sheet (at most 31 characters); when the user names the sheet, pass it exactly. After it succeeds, the data is ordinary sheet data.
  DATA SOURCE ROUTE (explicit): a request to open / import / connect / load a CSV, JSON, REST, or SQL data source (typically naming a URL or a stored connection) is an open_data_source call — emit exactly ONE open_data_source tool action for it. Do NOT decline it as something you cannot do, do NOT tell the user to import the file themselves first, do NOT ask for approval or emit agent.request_approval for it, and do NOT split it into invented steps. If the request names no URL or connection and none is bound already (check list_data_sources), ask for the address — that is the only missing fact worth an ask.
- refresh_data_source: {"sheet": string (optional), "id": string (optional)} — re-fetches the connector behind a sheet previously created by open_data_source and swaps its data region in place. Pass exactly one of "sheet" or "id".
- list_sheets: {} — returns {"sheets": [...]} — the open workbook's sheets. These are the ONLY sheets that exist in the workbook.

WORKBOOK CONTEXT (the runtime appends a "Workbook context" block to the user message of every plan request when a workbook is open):
- The block names the open workbook's real sheets. Use EXACTLY those names — never invent one, never guess "Sheet1"/"Sheet2" style names, and never ask which sheet to use when the context lists the sheets and the target is clear. If no block is present and you need the sheet names, call list_sheets.

ASK ACTIONS vs TOOLS:
- To ask the user something, emit an "ask" ACTION — {"type": "ask", "question": "<question>"} for free text, or with "options" to offer choices. The runtime turns it into the agent.ask_question / agent.offer_options call and pauses until the user answers. Do not emit agent.ask_question / agent.offer_options / agent.request_approval as "tool" actions.
- An ask action ends the current plan: put any tool actions that must run first before it, and nothing after it.
- ASK DISCIPLINE (hard limits): at most ONE ask action per turn, and only when information that is BOTH missing AND required to proceed cannot be obtained from the sheet, memory, or the conversation. If the request can be answered or executed from the data, do it — never ask to confirm facts the sheet already shows, never ask which sheet/range when the conversation or the sheet names make it clear, and NEVER end an answered question by asking whether the user wants more. A chain of clarifying questions for a straightforward data request is a failure mode.

READING AND AGGREGATION DISCIPLINE:
SCHEMA FIRST: on an unmapped sheet, describe_sheet BEFORE any read_cells; then read only its slices. Never chart or total from unmapped coordinates.
- read_cells rejects any range larger than 100,000 cells. Read BOUNDED ranges: describe_sheet first, then only the slices the schema points at; widen only when the last rows are still full.
- AGGREGATES ARE ENGINE-COMPUTED, never hand-added (except ≤5 values): call aggregate_cells over the exact range and report its value. For an aggregate BY a category, use one SUMIF formula per group via set_formulas + read-back (formulas, never literals).
- YOUR FINAL TOTAL MUST BE A TOOL-RETURNED NUMBER: it must appear verbatim in a tool result from THIS turn (an aggregate_cells result or an analyze_data aggregate). A number you produced by adding read values yourself is NOT a total — presenting one as the total is a wrong answer, and the runtime checks for it. If the only numbers you hold are raw read values, you do not have the total yet: call aggregate_cells or analyze_data first. This rule survives an ask: if the answer changed the range or scope, RECOMPUTE the aggregate over the corrected range before replying — never answer a total from values gathered before the ask. PARTIAL READS ARE NOT TOTALS: read_cells returns only the window you requested, and oversized reads are clamped to the used range — a window can silently be just the first rows of the data. Before treating any sum as a total, confirm your reads cover EVERY data row (compare against the used range / row count from a probe or list_sheets + a bounded read of the last rows). The sum of a partial window is a partial sum; reporting it as the total is the single most common wrong answer — do not do it. Never drop or skip rows a step did not name: every row the user asked for is covered by your reads and writes.
- analyze_data computes descriptive statistics and charts (its default output is per-column MEANS) — NEVER present a mean/average from analyze_data as the answer to a total question, and never claim a total is "not available" when aggregate_cells can compute it.
- For an aggregate BY a category ("revenue by region", "totals per month"), prefer the SUMIF formula path above (one formula per group). analyze_data is the chart path: when you use it for a grouped question, the intent MUST state the aggregation AND the grouping explicitly (e.g. "sum of Revenue grouped by Region") with a range including its header row and headerRow: true — a bare "analyze this" returns generic column statistics. The grouping field is the category the USER named — never an id column or date column unless asked; if a grouped result headlines an id or date as the top category, redo it.
- NO TOOL LOOPS: never repeat an identical (or near-identical) tool call in a turn — its result will not change. If one analyze_data call does not produce the aggregate the user asked for, do NOT call analyze_data again with a similar intent — switch to the formula path. If three tool calls have not produced the answer, answer with what you have and say what is missing instead of spending the whole turn repeating one tool.
- WRITES ADDRESSED BY CONTENT (e.g. "set the Revenue for Jun South to 15000", "add a TOTAL row below the data"): read the data range FIRST to locate the exact coordinates (first empty row for appends), then write. Never guess coordinates from wording alone — an unlocated write still reports success, so an unlocated write is a wrong answer, not a shortcut. After writing, CHECK the echoed writtenRowContext: mismatch → correct it (write the right row, restore the wrong one). PER-ROW RESULTS AND BATCHED WRITES: when the user asks for a value FOR EVERY ROW, write one entry per data row — one formula per row with that row's own references (formulas, not hand-computed literals, whenever the value derives from other cells) — never a single cell for the whole column. SPLIT LARGE BATCHES ACROSS PLANS: at most 4 row-writes per plan. With more rows, write the first 4 in this plan and STOP — no "done" action, one short progress "message" (e.g. "Writing rows 1-4 of 12."). The runtime re-calls you with results; continue at most 4 per plan until done, then return "done". A single giant plan with every row's write is FORBIDDEN: oversized plans fail to parse and NOTHING is written. Keep batched-write plans lean: one write action, a one-line message, and no "rationale" fields on the write entries. Two step-discipline rules for batched work: (a) COMPUTE THE TOTAL ONCE — one aggregate_cells call; NEVER call recalculate yourself (every write recalculates automatically) and never run a second aggregate for a total you already have; (b) VERIFY BEFORE YOU FINISH — read the target column back and COUNT; short of the data rows → keep writing, never report a partial column as finished.

WHEN TO RETURN "done" (read carefully):
- If your plan contains ANY tool actions, do NOT include a {"type": "done"} action in that plan — return only the tool actions.
- Return {"type": "done"} ONLY as the SOLE action of a plan, on the final iteration, when you already have everything you need: {"message": "<the complete final answer for the user>", "actions": [{"type": "done"}]}. That "message" is the answer the user sees — compose it fully from the tool results.
- A plan with no tool actions and no ask action also ends the turn, with its "message" as the answer.

WORKED EXAMPLE — CHART IN SHEET — data is in A1:B5 and user asks: "add a column chart of this to the sheet titled Monthly Sales"
{"message": "Adding a column chart of A1:B5 titled 'Monthly Sales' to Sheet1.", "actions": [{"type": "tool", "tool": "create_chart", "args": {"sheet": "Sheet1", "range": "A1:B5", "kind": "column", "title": "Monthly Sales"}, "rationale": "user asked to add a chart to the sheet"}]}
Result: create_chart ok.
{"message": "Added a column chart titled 'Monthly Sales' to Sheet1, bound to A1:B5.", "actions": [{"type": "done"}]}

Rules:
- Keep plans to at most 3 tool actions. Prefer describe_sheet first.
- If a tool result says FAILED, read its error text, fix the arguments to match the schema exactly, and retry — never repeat the identical failing call or invent the data it was supposed to return. A corrected retry comes BEFORE any ask action.`

// Size budget for SYSTEM_PROMPT (chars). The chat loop sends this prompt on every
// turn; Groq's free tier allows 8,000 tokens/min, so the prompt must stay well under
// that window with room for user text, history, and output. chars/4 estimates tokens.
// 22,500 chars ~= 5,625 tokens, leaving ~2,300+ tokens of headroom. If this cap is
// exceeded, trim the prompt — do not raise the cap without re-checking the token budget.
export const SYSTEM_PROMPT_MAX_CHARS = 22500;
;

/**
 * The job-planning contract (design-docs/agent-workflows.md §2.1). A
 * separate, deliberately small prompt: the job planner decomposes an
 * ask into steps; it never plans tool calls itself. The one-step rule
 * is the regression guard (§4.0): anything a single planner turn can
 * finish MUST come back as exactly one step, so simple asks keep the
 * ordinary loop, byte-identical.
 */
export const JOB_PLAN_SYSTEM_PROMPT = `You are the job planner of the Icecream Sheets AI agent. You do NOT execute anything and you do NOT call tools. You decompose ONE user request into an ordered step plan as JSON.

Respond with exactly one JSON object, no prose, no markdown fences:
{"steps": [{"title": "<short step name>", "instruction": "<self-contained instruction for this step>", "expectedChange": "<sheet-write|app-create|none>", "checks": [ ... ]}, ...]}

HOW TO PLAN — DECISION FLOW. Work the gates top to bottom. Gates 1-3 CLASSIFY the request: the FIRST gate that matches decides the plan's shape, and a later gate NEVER overrides an earlier one. Gates 4-6 then constrain every step you emit. Every rule carries an importance level: VERY IMPORTANT = violating it breaks routing, verification, or sheet data; IMPORTANT = violating it degrades plan quality; NORMAL = style. When two rules seem to conflict, the earlier gate and the higher importance win.

GATE 1 — CHART REQUEST? [VERY IMPORTANT]
IF the request asks for a chart, decide its route HERE, before anything else:
  (a) NO placement wording ("chart in/on the sheet", "add a chart to the sheet", "insert chart") → CHAT chart: return EXACTLY ONE step whose instruction names analyze_data explicitly ("show the chart in the chat reply with analyze_data"), and do NOT add a discovery step. Naming a sheet as the DATA SOURCE ("chart of revenue by year from the Income sheet") is NOT placement. This branch OVERRIDES Gate 2: a no-placement chart request NEVER gets a discovery step — analyze_data takes the sheet itself, and a discovery step turns this into a multi-step job that builds a native chart instead.
  (b) WITH placement wording → NATIVE chart: a discovery step plus a chart step whose instruction names create_chart explicitly (0-based bounds preferred). That chart persists with the file.
  (c) Chart PLUS other work (totals, writes, an app) → decompose normally; the chart step itself still follows (a) or (b) by its own wording.
  A chart step MUST name its tool, never leave the route to the executor. This gate is the CHART ROUTES rule: it decides analyze_data vs create_chart.
  Flowchart: request asks for a chart? → placement wording? → YES: (b) native chart; NO: (a) chat chart. Chart + other work → (c).

GATE 2 — DATA REQUEST NEEDING SHEET DATA? [IMPORTANT]
(This gate does NOT apply to Gate 1(a) chat charts — Gate 1 already decided those.)
IF the request needs sheet data AND no tool results are supplied, SCHEMA FIRST: the FIRST step discovers the schema (describe_sheet, then bounded reads) before any compute, chart, or write step — never plan a total or chart from unmapped coordinates. Declare range-bearing checks only for steps whose ranges the request or workbook context already gives exactly. The runtime re-plans the remaining steps after discovery with the schema attached — a guessed range declared now is never corrected later.

GATE 3 — ONE STEP OR STAGED? [IMPORTANT]
(Applies to requests whose shape Gates 1-2 did not already fix.)
THE ONE-STEP RULE: if the request can be finished by a single agent turn — one question to answer, one value to compute, one small write, one chart, one data source to open — return EXACTLY ONE step whose instruction restates the request. Multi-step plans are ONLY for genuinely staged work: several distinct stages where later stages depend on earlier results (clean then summarize then build; consolidate several files; repair then re-verify; a per-row/per-file batch too large for one turn).

GATE 4 — DECLARATIONS FOR EVERY STEP [VERY IMPORTANT]
- "expectedChange": declare what kind of change this step makes, because verification runs ONLY on declared changes — the runtime verifies ONLY the declared kind: "sheet-write" verifies a sheet change landed; "app-create" verifies ONLY that an app artifact exists; "none" is never verified. Declare "sheet-write" if the step writes cells, formulas, or charts to the sheet (a NATIVE create_chart step declares "sheet-write"); "app-create" if the step builds an app; "none" if the step only reads, answers, or reports and changes nothing (an analyze_data chat-chart step declares "none" — it changes nothing in the sheet). A step declared "none" is never verified — declare "none" honestly instead of inventing a check. Never declare a change the step does not make. Declaring "app-create" on a step that builds no app (for example a chart step) is a plan defect: verification will demand an app artifact that will never exist.
- "checks": for a step that WRITES or changes sheet data, include at least one check that proves the write landed — normally {"kind": "range-filled", ...} over the exact range the step writes, or cell-equals on a key cell. EXCEPTION: for a step that writes a COMPUTED TOTAL (a sum or other aggregate over a source range), range-filled is NOT enough — it proves only that cells are non-empty, never that the value is right — declare {"kind": "cell-sum-equals", ...} naming the total cell and the exact source range instead, so the runtime recomputes the total from the source and compares. For a step whose outcome is creating a sheet or a file, use sheet-exists or the file's existence is checked implicitly. For pure reading/reporting steps, checks are optional. Use ONLY these exact shapes (rows/cols are 0-based integers):
  {"kind": "cell-equals", "sheet": "<sheet>", "row": <int>, "col": <int>, "equals": <number|string>}
  {"kind": "cell-nonempty", "sheet": "<sheet>", "row": <int>, "col": <int>}
  {"kind": "range-filled", "sheet": "<sheet>", "startRow": <int>, "startCol": <int>, "endRow": <int>, "endCol": <int>} — every cell in the rectangle must be non-empty
  {"kind": "sheet-exists", "sheet": "<sheet>"}
  {"kind": "column-sum-equals", "sheet": "<sheet>", "col": <int>, "startRow": <int>, "endRow": <int>, "equals": <number>} — the computed values in that column segment must sum to "equals"
  {"kind": "cell-sum-equals", "sheet": "<sheet>", "row": <int>, "col": <int>, "sourceSheet": "<sheet>", "sourceStartRow": <int>, "sourceStartCol": <int>, "sourceEndRow": <int>, "sourceEndCol": <int>} — the total cell must equal the runtime's own sum over the source range (declare this, never a literal total, for any computed-total write)
- SCHEMA-BOUND CHECKS: when this request supplies tool results (schema discovery output), bind every check's row/col ranges to the coordinates in THOSE results — they are 0-based ABSOLUTE sheet coordinates (row 0 = first sheet row, col 0 = column A). Never reuse ranges from an earlier plan or from conversation summaries: a summary may report rows relative to a dimension row ("Revenue row 1"), which is NOT an absolute coordinate and will fail verification.
- Omit "checks" only when no listed shape fits the step's outcome — a wrong check is worse than none, but a data-writing step without a check is a plan defect.

GATE 5 — VALUES [VERY IMPORTANT]
- NEVER write placeholder, test, or example values (e.g. 123456789) into the sheet: every value a step writes must come from a tool result or an engine formula. A step that cannot source its value writes nothing.
- Never invent sheet names that are not in the workbook context.

GATE 6 — CONSTRUCTION DETAILS [NORMAL]
- Order steps so each step's inputs exist by the time it runs. Name sheets, ranges, and values concretely when the request or the workbook context provides them.
- Each instruction is self-contained: the step executor sees the original request and the summaries of completed steps, so restate the facts the step needs (target sheet, column, range, the value or formula pattern) instead of referring to "the previous step".
- Batched writes (a value for every row, many files) are one step per reasonable chunk, not one step per row, unless the request itself separates them.
- The FINAL step must produce the user's answer or confirmation (report what was done / answer the question) whenever the request asks for one.
- Keep titles under 80 characters and instructions under 600 characters. At most 24 steps.`;

/**
 * Upper bound on steps accepted from ONE job-plan call. This is a
 * malformed-output guard, not a job ceiling (agent-workflows.md §2.6):
 * a running workflow can be re-planned, which extends it with fresh
 * steps — the job as a whole has no step limit.
 */
export const JOB_PLAN_MAX_STEPS = 40;

/** Parse + validate a job-plan completion. Throws on unusable output. */
export function parseJobPlan(content: unknown): JobPlan {
  if (typeof content !== 'object' || content === null) {
    throw new Error('openai-compatible backend: job plan must be a JSON object');
  }
  const c = content as Record<string, unknown>;
  if (!Array.isArray(c.steps) || c.steps.length === 0) {
    throw new Error('openai-compatible backend: job plan needs a non-empty steps array');
  }
  const steps: JobStep[] = [];
  for (const raw of c.steps.slice(0, JOB_PLAN_MAX_STEPS)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const s = raw as Record<string, unknown>;
    if (typeof s.title !== 'string' || s.title.trim().length === 0) continue;
    if (typeof s.instruction !== 'string' || s.instruction.trim().length === 0) continue;
    const checks = Array.isArray(s.checks)
      ? s.checks.map(sanitizeStepCheck).filter((x) => x !== null)
      : [];
    // #151: the planner's declared expected change drives
    // verification. An invalid value is dropped (treated as no
    // declaration, i.e. no verification), never guessed.
    const expectedChange =
      s.expectedChange === 'sheet-write' ||
      s.expectedChange === 'app-create' ||
      s.expectedChange === 'none'
        ? s.expectedChange
        : undefined;
    steps.push({
      title: s.title.trim().slice(0, 160),
      instruction: s.instruction.trim().slice(0, 2000),
      ...(expectedChange ? { expectedChange } : {}),
      ...(checks.length > 0 ? { checks } : {}),
    });
  }
  if (steps.length === 0) {
    throw new Error('openai-compatible backend: job plan contained no usable steps');
  }
  return { steps };
}

/** Extract human-readable error text from a failed tool result's data payload. */
function errorTextOf(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const d = data as Record<string, unknown>;
  for (const key of ['error', 'text', 'message']) {
    const v = d[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function historyText(input: PlannerInput): string {
  const lines: string[] = [];
  for (const m of input.history.slice(-10)) {
    lines.push(`${m.role}: ${m.text.slice(0, 500)}`);
  }
  if (input.toolResults.length > 0) {
    lines.push('--- tool results since last plan ---');
    for (const r of input.toolResults) {
      // D1b: a failure must carry the REAL error text into the next
      // planner call so the model can self-correct. The runtime puts the
      // error in the summary; a failed result's data can also carry the
      // raw MCP error payload ({error} / {text}) — surface either, never
      // a bare "failed: undefined". All fields stay bounded.
      let detail = r.summary.slice(0, 800);
      if (!r.ok) {
        const dataError = errorTextOf(r.data);
        if (dataError && !detail.includes(dataError.slice(0, 80))) {
          detail = `${detail} | error: ${dataError.slice(0, 800)}`;
        }
      }
      lines.push(
        `${r.tool} ${r.ok ? 'ok' : 'FAILED'}: ${detail}${
          r.data !== undefined ? ` | data: ${JSON.stringify(r.data).slice(0, 2000)}` : ''
        }`,
      );
    }
  }
  lines.push(`--- iteration ${input.iteration} ---`);
  return lines.join('\n');
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class OpenAICompatibleBackend implements ModelBackend {
  readonly name = 'openai-compatible';
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly getApiKey: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retryDelaysMs: number[];
  private readonly allowedTools: Set<string>;

  constructor(opts: OpenAICompatibleBackendOptions) {
    if (!opts.baseUrl || !/^https?:\/\//i.test(opts.baseUrl)) {
      throw new Error('openai-compatible backend: baseUrl must be an http(s) URL');
    }
    if (typeof opts.getApiKey !== 'function') {
      throw new Error('openai-compatible backend: getApiKey is required');
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.model = opts.model || 'gpt-4o-mini';
    this.getApiKey = opts.getApiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.retryDelaysMs = opts.retryDelaysMs ?? [1_000, 2_500, 6_000];
    this.allowedTools = new Set(opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS);
  }

  get providerModel(): string {
    return this.model;
  }

  async plan(input: PlannerInput, opts?: PlannerOptions): Promise<PlannerOutput> {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new Error('openai-compatible backend: no API key available');

    const workbookContext = input.sheetContext?.sheets.length
      ? `\n\nWorkbook context: the open workbook's sheets are exactly: ${input.sheetContext.sheets
          .map((s) => JSON.stringify(s))
          .join(', ')}. No other sheets exist — never invent sheet names.${
          input.sheetContext.activeSheet
            ? ` The user is currently on sheet ${JSON.stringify(input.sheetContext.activeSheet)} — use it for sheet-less data access.`
            : ''
        }`
      : '';

    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `User request: ${input.userText}\n\nConversation and tool results:\n${historyText(input)}\n\nAvailable tools: ${[...this.allowedTools].join(', ')}${workbookContext}\n\nRespond with the JSON plan object only.`,
      },
    ];

    // #137 streaming: when the caller wants tokens, try the SSE
    // stream first; a transport/parse failure falls back to the
    // non-stream retry loop below (without onToken — the panel
    // reconciles on done, so a failed stream can never duplicate
    // text). #143: a NON-RETRYABLE provider rejection (e.g. Groq
    // refusing a request shape) is rethrown at once — retrying the
    // identical shape cannot heal it.
    if (opts?.onToken) {
      try {
        return await this.planStream(messages, apiKey, opts.onToken);
      } catch (e) {
        if (e instanceof ProviderHttpError && !e.retryable) throw e;
        // Fall through to the non-stream path.
      }
    }

    // FIX-R4: bounded retry with backoff. Hosted providers answer load
    // bursts with 429 (Vertex: RESOURCE_EXHAUSTED) — and one throttled
    // call used to kill the whole turn (the runtime surfaces a backend
    // throw as a failed turn; observed live as HTTP 500s on ordinary
    // questions during the validation tours). 429, 5xx, and transport
    // failures are retried after retryDelaysMs; client errors
    // (400/401/403/404) fail immediately — waiting will not heal them.
    let res: Response | null = null;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, this.retryDelaysMs[attempt - 1]));
      }
      try {
        res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // The key travels only in this header, for this request.
            authorization: `Bearer ${apiKey}`,
          },
          // #143: NO response_format. The system prompt already mandates
          // JSON-only output, and validatePlan + the retry loop are the
          // correctness net. response_format json_object is
          // model-dependent (and Groq rejects it combined with
          // streaming outright); the working artifact route sends
          // neither, and the chat loop's identical shape on both legs
          // is what killed the Groq legs with a generic busy message.
          body: JSON.stringify({
            model: this.model,
            messages,
            temperature: 0,
            max_tokens: PLANNER_MAX_OUTPUT_TOKENS,
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        // Network/timeout errors: never echo the key, only the kind.
        lastError = new Error(
          `openai-compatible backend: request failed (${describeFailure(e)})`,
        );
        res = null;
        continue;
      }
      if (res.ok) {
        // Planner-fix round 2 (2026-10-22): a 200 whose body does not
        // parse as a plan (truncated or prose-wrapped completion -
        // observed live on the longest turns, where it killed the turn
        // outright) is as transient as a 429: retry it on the same
        // schedule instead of failing on one malformed sample.
        try {
          const parsed: unknown = await res.json();
          const content = extractContent(parsed);
          return validatePlan(content, this.allowedTools);
        } catch (e) {
          lastError = e instanceof Error ? e : new Error(String(e));
          res = null;
          continue;
        }
      }
      const body = await res.text().catch(() => '');
      lastError = new Error(
        `openai-compatible backend: provider returned ${res.status} (${body.slice(0, 200) || 'no detail'})`,
      );
      const retryable = res.status === 429 || (res.status >= 500 && res.status <= 599);
      res = null;
      if (!retryable) break;
    }
    throw lastError ?? new Error('openai-compatible backend: request failed (unknown)');
  }


  /**
   * #137 token streaming: one SSE attempt (stream: true) that calls
   * onToken with each newly arrived slice of the plan's "message"
   * field, then validates the completed JSON exactly like the
   * non-stream path. Throws on ANY failure (transport, non-ok
   * status, empty content, invalid plan) — plan() then falls back
   * to the existing non-stream retry loop WITHOUT onToken, so a
   * failed stream can never duplicate text (the panel replaces
   * streamed text with the done payload regardless).
   */
  private async planStream(
    messages: ChatMessage[],
    apiKey: string,
    onToken: (text: string) => void,
  ): Promise<PlannerOutput> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      // #143: NO response_format (see the non-stream call above — Groq
      // rejects stream + structured output outright, and JSON-object
      // mode is model-dependent). The stream parser validates the
      // completed JSON exactly like the non-stream path.
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0,
        max_tokens: PLANNER_MAX_OUTPUT_TOKENS,
        stream: true,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      // #143: carry the provider detail AND the status, so plan() can
      // fail fast on a deterministically rejected shape instead of
      // silently retrying it and ending in a generic busy message.
      const body = await res.text().catch(() => '');
      throw new ProviderHttpError(res.status, body.slice(0, 200));
    }
    if (!res.body) throw new Error('openai-compatible backend: stream response has no body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let acc = '';
    let emitted = 0;
    const feed = (chunk: string): void => {
      acc += chunk;
      const prefix = extractMessagePrefix(acc);
      if (prefix !== null && prefix.length > emitted) {
        onToken(prefix.slice(emitted));
        emitted = prefix.length;
      }
    };
    const feedBlock = (block: string): void => {
      for (const line of block.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const delta = (parsed as { choices?: Array<{ delta?: { content?: unknown } }> })
          .choices?.[0]?.delta?.content;
        if (typeof delta === 'string') feed(delta);
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep = buf.indexOf('\n\n');
      while (sep >= 0) {
        feedBlock(buf.slice(0, sep));
        buf = buf.slice(sep + 2);
        sep = buf.indexOf('\n\n');
      }
    }
    if (buf.trim().length > 0) feedBlock(buf);
    if (acc.length === 0) throw new Error('openai-compatible backend: stream produced no content');
    let parsed: unknown;
    try {
      parsed = JSON.parse(acc);
    } catch {
      throw new Error('openai-compatible backend: stream produced invalid JSON');
    }
    return validatePlan(parsed, this.allowedTools);
  }

  /**
   * Job planning (agent-workflows.md §2.1): one chat-completions call
   * with the job-plan prompt, same key handling as plan() but a
   * deliberately SHORTER retry discipline: this call is advisory (it
   * classifies/plans a job before the real loop), so a parse failure
   * is not retried at all — an endpoint that answers the job-plan
   * prompt with a non-plan will keep doing so — and retryable HTTP
   * failures get at most one retry from the shared schedule. Throws on
   * failure: the runtime treats any planJob failure as "no plan
   * available" and falls back to the ordinary loop, so a flaky job
   * planner can never break or noticeably delay a turn.
   */
  async planJob(input: JobPlanInput): Promise<JobPlan> {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new Error('openai-compatible backend: no API key available');

    const workbookContext = input.sheetContext?.sheets.length
      ? `\n\nWorkbook context: the open workbook's sheets are exactly: ${input.sheetContext.sheets
          .map((s) => JSON.stringify(s))
          .join(', ')}. No other sheets exist — never invent sheet names.${
          input.sheetContext.activeSheet
            ? ` The user is currently on sheet ${JSON.stringify(input.sheetContext.activeSheet)} — use it for sheet-less data access.`
            : ''
        }`
      : '';

    const historyLines = input.history
      .slice(-6)
      .map((m) => `${m.role}: ${m.text.slice(0, 300)}`)
      .join('\n');

    // Declaration-frame fix: tool results the planner must bind check
    // ranges to (a describe_sheet result from a completed discovery
    // step, or schema results gathered by a re-plan). Same shape as
    // historyText's tool section, but the data cap is 6000, not 2000:
    // a describe_sheet payload for a real sheet runs ~4KB, and a
    // 2000-char cap would cut late rows — Net Earnings sits near the
    // end of rowSummaries — leaving the planner blind exactly where
    // it matters. The plan call has no char-cap test (only
    // SYSTEM_PROMPT does), so the wider cap costs nothing.
    const toolLines = (input.toolResults ?? [])
      .map((r) => {
        const detail = r.summary.slice(0, 800);
        return `${r.tool} ${r.ok ? 'ok' : 'FAILED'}: ${detail}${
          r.data !== undefined ? ` | data: ${JSON.stringify(r.data).slice(0, 6000)}` : ''
        }`;
      })
      .join('\n');

    const messages: ChatMessage[] = [
      { role: 'system', content: JOB_PLAN_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `User request: ${input.userText}` +
          (historyLines ? `\n\nRecent conversation:\n${historyLines}` : '') +
          (toolLines
            ? `\n\nTool results (ground truth — bind every check's row/col ranges to the coordinates in these results; they are 0-based ABSOLUTE sheet coordinates, row 0 = first sheet row, col 0 = column A):\n${toolLines}`
            : '') +
          `${workbookContext}\n\nRespond with the JSON job plan object only.`,
      },
    ];

    let lastError: Error | null = null;
    const maxAttempts = Math.min(2, this.retryDelaysMs.length + 1);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, this.retryDelaysMs[attempt - 1]));
      }
      let res: Response | null = null;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          // #143: NO response_format (same reason as plan() above).
          body: JSON.stringify({
            model: this.model,
            messages,
            temperature: 0,
            max_tokens: PLANNER_MAX_OUTPUT_TOKENS,
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        lastError = new Error(
          `openai-compatible backend: job plan request failed (${describeFailure(e)})`,
        );
        continue;
      }
      if (res.ok) {
        // Parse failure: NOT retried (see the retry-discipline note on
        // this method) — fail open to the ordinary loop at once.
        const parsed: unknown = await res.json();
        return parseJobPlan(extractContent(parsed));
      }
      const body = await res.text().catch(() => '');
      lastError = new Error(
        `openai-compatible backend: job plan provider returned ${res.status} (${body.slice(0, 200) || 'no detail'})`,
      );
      const retryable = res.status === 429 || (res.status >= 500 && res.status <= 599);
      if (!retryable) break;
    }
    throw lastError ?? new Error('openai-compatible backend: job plan request failed (unknown)');
  }
}

function describeFailure(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === 'TimeoutError' || /abort/i.test(e.message)) return 'timeout';
    return e.message.slice(0, 120);
  }
  return String(e).slice(0, 120);
}


/**
 * #137: tolerant prefix extraction of the top-level "message" string
 * from a PARTIAL plan JSON text. Returns the decoded prefix so far,
 * or null when the message field has not started yet. An occurrence
 * of "message" that is not followed by `: "` is skipped (an action
 * argument can contain the word) and the search continues past it.
 * Split escapes and split \\uXXXX sequences decode only once
 * complete; an unterminated string yields its prefix. Never throws.
 */
function extractMessagePrefix(content: string): string | null {
  let from = 0;
  for (;;) {
    const keyIdx = content.indexOf('"message"', from);
    if (keyIdx === -1) return null;
    let i = keyIdx + 9;
    while (i < content.length && /\s/.test(content[i]!)) i++;
    if (content[i] !== ':') {
      from = keyIdx + 1;
      continue;
    }
    i++;
    while (i < content.length && /\s/.test(content[i]!)) i++;
    if (content[i] !== '"') {
      from = keyIdx + 1;
      continue;
    }
    i++;
    let out = '';
    while (i < content.length) {
      const ch = content[i]!;
      if (ch === '"') return out;
      if (ch === '\\') {
        const nxt = content[i + 1];
        if (nxt === undefined) return out;
        if (nxt === 'u') {
          const hex = content.slice(i + 2, i + 6);
          if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) return out;
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else {
          const mapped: Record<string, string> = {
            '"': '"',
            '\\': '\\',
            '/': '/',
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
          };
          const rep = mapped[nxt];
          if (rep === undefined) return out;
          out += rep;
          i += 2;
        }
      } else {
        out += ch;
        i++;
      }
    }
    return out;
  }
}

function extractContent(parsed: unknown): unknown {
  const p = parsed as { choices?: { message?: { content?: unknown } }[] };
  const content = p?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('openai-compatible backend: provider returned no content');
  }
  // #143: without response_format json_object, a chatty model may wrap
  // the plan in markdown fences or a prose lead-in. Strip fences and,
  // failing that, take the first {...} span before parsing — the
  // validatePlan schema check below is still the correctness net.
  const asJsonText = (text: string): string => {
    const trimmed = text.trim();
    const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    const inner = (fence?.[1] ?? trimmed).trim();
    if (inner.startsWith('{')) return inner;
    const start = inner.indexOf('{');
    const end = inner.lastIndexOf('}');
    return start >= 0 && end > start ? inner.slice(start, end + 1) : inner;
  };
  try {
    return JSON.parse(asJsonText(content));
  } catch {
    // Observability (agent proof program, case 5): a non-JSON completion
    // is otherwise invisible — the runtime only records this error in the
    // audit, so carry a BOUNDED prefix of the raw completion with it to
    // show what the provider actually returned. Capped at 200 chars,
    // whitespace-collapsed, JSON-escaped; the busy-reply path to the user
    // is unaffected (it never includes this message).
    const prefix = content.slice(0, 200).replace(/\s+/g, ' ');
    throw new Error(
      `openai-compatible backend: provider returned non-JSON plan (completion prefix: ${JSON.stringify(prefix)})`,
    );
  }
}

/** Validate the model's JSON plan; reject anything outside the action contract. */
export function validatePlan(content: unknown, allowedTools: Set<string>): PlannerOutput {
  if (typeof content !== 'object' || content === null) {
    throw new Error('openai-compatible backend: plan must be a JSON object');
  }
  const c = content as Record<string, unknown>;
  if (typeof c.message !== 'string') throw new Error('openai-compatible backend: plan.message must be a string');
  if (!Array.isArray(c.actions)) throw new Error('openai-compatible backend: plan.actions must be an array');
  // Wave-5 downstream (a): validateAction may DROP a narration-shaped
  // action (it returns null) — the plan's message already carries the
  // user-facing text, and a dropped action encodes no effect, so the
  // turn ends cleanly on the message (the loop ends on zero tool
  // actions). Dropped actions never include a tool call or a question.
  const actions: AgentAction[] = [];
  const raw = c.actions.slice(0, 8);
  for (let idx = 0; idx < raw.length; idx++) {
    // Error indices name the ORIGINAL plan position, not the post-drop one.
    const normalized = validateAction(raw[idx], idx, allowedTools);
    if (normalized !== null) actions.push(normalized);
  }
  return { message: c.message, actions };
}

// Narration-shaped action types: the model narrating its reply as an
// action ("reply with DONE" induces these). They carry no tool call and
// no question, so dropping them loses no effect — the plan's message is
// the reply. Anything outside this set still fails, naming its type.
const NARRATION_ACTION_TYPES = new Set(['text', 'message', 'reply', 'response', 'answer', 'narration']);

function validateAction(a: unknown, i: number, allowedTools: Set<string>): AgentAction | null {
  if (typeof a !== 'object' || a === null) {
    throw new Error(`openai-compatible backend: action ${i} must be an object`);
  }
  const o = a as Record<string, unknown>;
  if (o.type === 'done') return { type: 'done' };
  // Ask: contract type, or a question-shaped action with a nonstandard /
  // missing type and no tool field. Same validation as the contract
  // branch (question required; options filtered to strings; never copy
  // intentChoice from model output).
  if (o.type === 'ask' || (typeof o.question === 'string' && typeof o.tool !== 'string')) {
    if (typeof o.question !== 'string' || o.question.length === 0) {
      throw new Error(`openai-compatible backend: ask action ${i} needs a question`);
    }
    const options = Array.isArray(o.options) ? o.options.filter((x): x is string => typeof x === 'string') : undefined;
    return { type: 'ask', question: o.question, options };
  }
  // Tool: contract type, or a tool-shaped action with a nonstandard /
  // missing type. The allowlist and args checks are identical — coercion
  // never admits a disallowed tool or a malformed args object.
  if (o.type === 'tool' || typeof o.tool === 'string') {
    if (typeof o.tool !== 'string' || !allowedTools.has(o.tool)) {
      throw new Error(`openai-compatible backend: action ${i} names a disallowed tool`);
    }
    if (typeof o.args !== 'object' || o.args === null || Array.isArray(o.args)) {
      throw new Error(`openai-compatible backend: action ${i} args must be an object`);
    }
    const rationale = typeof o.rationale === 'string' ? o.rationale : undefined;
    return { type: 'tool', tool: o.tool, args: o.args as Record<string, unknown>, rationale };
  }
  // Narration: a known narration type, or a typeless action carrying only
  // narration text. Drop — the message is the reply.
  if (
    (typeof o.type === 'string' && NARRATION_ACTION_TYPES.has(o.type)) ||
    (o.type === undefined &&
      (typeof o.text === 'string' || typeof o.content === 'string' || typeof o.message === 'string'))
  ) {
    return null;
  }
  // Anything else still fails — but now it names the offending type and
  // carries a bounded snippet of the action, so the next diagnosis is
  // not blind (the wave-5 prod error named neither).
  const shown = JSON.stringify(o).slice(0, 200);
  throw new Error(
    `openai-compatible backend: action ${i} has unknown type '${String(o.type)}' (action: ${shown})`,
  );
}
