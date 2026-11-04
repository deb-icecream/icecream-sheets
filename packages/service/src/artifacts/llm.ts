/**
 * LLM-backed freeform React generation for chat artifacts.
 *
 * USER SPEC (2026-10-18): the app generator's freeform React path needs an
 * LLM, with an explicit, safe mode switch:
 *
 * - TEST MODE: the LLM prompt is captured and diverted to the assistant's
 *   own LLM. TestCodeGenBackend records every prompt it receives
 *   (observable via `capturedPrompts`) and returns a canned-but-sensible
 *   React app. Test mode NEVER touches the network.
 * - PRODUCTION MODE: the REAL LLM — Vertex AI on GCP, defaulting to a
 *   cheap Gemini model (VERTEX_DEFAULT_MODEL; user ruling 2026-10-21:
 *   all LLM calls on Vertex AI, cheap models — the stronger
 *   gemini-2.5-pro remains available as a per-deployment override).
 *   Credentials come from the credential vault via
 *   the injected getAccessToken callback — never hardcoded. When
 *   credentials are absent the backend fails with a clear error.
 *
 * Mode safety is structural: the mode is whichever CodeGenBackend you
 * construct. TestCodeGenBackend has no fetch, no URL, no credentials — it
 * cannot call Vertex AI. VertexAiCodeGenBackend always calls Vertex AI and
 * never diverts. There is no flag to get wrong at call time.
 *
 * LlmAppGenerator implements the same AppGenerator interface as
 * TemplateAppGenerator (generator.ts), so generateAndSaveArtifact accepts
 * it with no rework: pass it as deps.generator.
 */

import type { AppGenerationInput, AppGenerationOutput, AppGenerator } from './generator.js';

/** Smallest surface an LLM needs for code generation (not agent planning). */
export interface CodeGenBackend {
  readonly name: string;
  generateCode(prompt: string): Promise<string>;
  /**
   * Raw model text for non-code calls (e.g. app naming). Optional: a backend
   * without it simply skips naming and the caller falls back. Never validated
   * as code — no fence extraction, no function App() check.
   */
  generateText?(prompt: string): Promise<string>;
}

/** Explicit mode selection — the constructed backend IS the mode. */
export type LlmMode = 'test' | 'vertex';

/**
 * Default Gemini model on Vertex AI. User ruling 2026-10-21: ALL LLM
 * calls run on Vertex AI with CHEAP Gemini models; asked to verify the
 * cheapest, he chose the absolute floor — gemini-2.5-flash-lite
 * ($0.10 in / $0.40 out per 1M tokens, vs $0.30/$2.50 for 2.5-flash and
 * $1.25/$10 for 2.5-pro) — over the newer gemini-3.1-flash-lite
 * ($0.25/$1.50), knowing pricing trackers report the 2.5 family near
 * its retirement window. If/when 2.5-flash-lite is shut down, bump this
 * one constant (3.1-flash-lite is the successor pick).
 * Override per deployment via VertexAiCodeGenOptions.model.
 *
 * 2026-10-22: Google retired gemini-2.5-flash-lite for the dreamscapes-zero
 * project (404 "publisher model not found" in us-central1 AND global) —
 * the standing user ruling fires: bumped to gemini-3.1-flash-lite
 * ($0.25 in / $1.50 out per 1M tokens).
 */
export const VERTEX_DEFAULT_MODEL = 'gemini-3.1-flash-lite';

/**
 * Default Vertex AI location: 'global'. The shipped default model
 * (gemini-3.1-flash-lite) serves ONLY on the global endpoint for
 * dreamscapes-zero — direct-probed 2026-10-22 (deploy-followup leg 7):
 * us-central1 returns 404 publisher-model-not-found, global returns 200.
 * Per-deployment location overrides still work for regional models.
 */
export const VERTEX_DEFAULT_LOCATION = 'global';

/**
 * Output budget for full React app generation (both backends). Dashboard
 * apps (chart + bars + KPI cards + table) exceed 8k tokens — at 8192 the
 * model is cut mid-string and the artifact fails to start with
 * "Unterminated string constant". Matches the planner budget
 * (PLANNER_MAX_OUTPUT_TOKENS); naming calls keep their small 128 budget.
 */
export const CODEGEN_MAX_OUTPUT_TOKENS = 16_384;

/**
 * Vertex AI host for a location. The 'global' endpoint is served from the
 * bare aiplatform.googleapis.com host — there is no
 * global-aiplatform.googleapis.com — while every regional location uses
 * '{location}-aiplatform.googleapis.com'. The resource path is unaffected:
 * it always carries locations/{location}.
 */
export function vertexAiHost(location: string): string {
  return location === 'global'
    ? 'aiplatform.googleapis.com'
    : `${location}-aiplatform.googleapis.com`;
}

export interface VertexAiCodeGenOptions {
  /** GCP project id. */
  project: string;
  /** Vertex AI location. Defaults to VERTEX_DEFAULT_LOCATION ('global'). */
  location?: string;
  /** Model id. Defaults to VERTEX_DEFAULT_MODEL (cheap Gemini default). */
  model?: string;
  /**
   * Resolve a GCP OAuth2 access token. The service boundary wires this to
   * the credential vault (vault.ts) — the secret lives in the vault, the
   * recipe/config holds only the reference. Throw (or return null) when
   * credentials are absent; the backend converts that into the documented
   * clear error.
   */
  getAccessToken: () => Promise<string | null>;
  /** fetch implementation (defaults to globalThis.fetch). */
  fetchImpl?: typeof fetch;
}

/**
 * Production backend: Google Cloud Vertex AI generateContent.
 * Calls https://{vertexAiHost(location)}/v1/... (the global location is
 * served from the bare aiplatform.googleapis.com host) — the service
 * runs behind the product's service boundary; the gateway routes service
 * traffic, MCP keeps its own direct ingress (user architecture decision).
 */
export class VertexAiCodeGenBackend implements CodeGenBackend {
  readonly name = 'vertex-ai';
  private readonly project: string;
  private readonly location: string;
  private readonly model: string;
  private readonly getAccessToken: () => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: VertexAiCodeGenOptions) {
    if (!opts.project || opts.project.trim() === '') {
      throw new Error('VertexAiCodeGenBackend requires a GCP project id.');
    }
    this.project = opts.project;
    this.location = opts.location ?? VERTEX_DEFAULT_LOCATION;
    this.model = opts.model ?? VERTEX_DEFAULT_MODEL;
    this.getAccessToken = opts.getAccessToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get modelId(): string {
    return this.model;
  }

  /**
   * Raw model text for one prompt. Shared by generateCode (code path) and
   * generateText (naming path); only the caller's maxOutputTokens differs,
   * and only generateCode validates the text as code afterwards.
   */
  private async request(prompt: string, maxOutputTokens: number): Promise<string> {
    const token = await this.getAccessToken().catch(() => null);
    if (!token) {
      throw new Error(
        'Vertex AI credentials are not configured: no GCP access token is available. ' +
          'Store one in the credential vault and wire getAccessToken to the vault ' +
          '(design-docs/etl-pipeline.md §6: credentials live in the service vault). ' +
          'Production code generation is unavailable until then.',
      );
    }
    const url =
      `https://${vertexAiHost(this.location)}/v1/` +
      `projects/${this.project}/locations/${this.location}/` +
      `publishers/google/models/${this.model}:generateContent`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens },
        }),
      });
    } catch (e) {
      throw new Error(`Vertex AI request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Vertex AI error ${res.status}: ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    return json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  }

  async generateCode(prompt: string): Promise<string> {
    const text = await this.request(prompt, CODEGEN_MAX_OUTPUT_TOKENS);
    const code = extractCode(text);
    if (!code.includes('function App(') && !code.includes('function App (')) {
      throw new Error(
        'Vertex AI did not return a React app: the response has no function App(). ' +
          'Raw head: ' + text.slice(0, 200),
      );
    }
    return code;
  }

  /** Raw model text for naming: a short reply needs only a small budget. */
  async generateText(prompt: string): Promise<string> {
    return (await this.request(prompt, 128)).trim();
  }
}

export interface OpenAiCompatibleCodeGenOptions {
  /** OpenAI-compatible endpoint base URL, e.g. https://api.groq.com/openai/v1. */
  baseUrl: string;
  /** Model id. Defaults to the backend default when omitted. */
  model?: string;
  /** Resolve the API key at call time — never stored, never logged. */
  getApiKey: () => Promise<string>;
  /** fetch implementation (defaults to globalThis.fetch). */
  fetchImpl?: typeof fetch;
}

/**
 * #137: OpenAI-compatible code generation backend (local test model,
 * e.g. Groq). Same contract as VertexAiCodeGenBackend — prompt in,
 * React source with function App() out — over POST {baseUrl}/chat/
 * completions. The key travels only in the Authorization header for
 * one request, exactly like the chat planner backend.
 */
export class OpenAiCompatibleCodeGenBackend implements CodeGenBackend {
  readonly name = 'openai-compatible-codegen';
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly getApiKey: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAiCompatibleCodeGenOptions) {
    if (!opts.baseUrl || !/^https?:\/\//i.test(opts.baseUrl)) {
      throw new Error('OpenAiCompatibleCodeGenBackend requires a valid http(s) baseUrl.');
    }
    if (typeof opts.getApiKey !== 'function') {
      throw new Error('OpenAiCompatibleCodeGenBackend requires getApiKey.');
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.model = opts.model || 'gpt-4o-mini';
    this.getApiKey = opts.getApiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Raw model text for one prompt. Shared by generateCode (code path) and
   * generateText (naming path); only generateCode validates the text as code.
   */
  private async complete(system: string, prompt: string, maxTokens: number): Promise<string> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error(
        'OpenAI-compatible code generation has no API key available: set AGENT_MODEL_API_KEY for the agent service.',
      );
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
          temperature: 0.2,
          max_tokens: maxTokens,
        }),
      });
    } catch (e) {
      throw new Error(
        `OpenAI-compatible code generation request failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI-compatible code generation error ${res.status}: ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return json.choices?.[0]?.message?.content ?? '';
  }

  async generateCode(prompt: string): Promise<string> {
    const text = await this.complete(
      'You generate React apps as plain JavaScript defining exactly function App(). Return ONLY the JavaScript source.',
      prompt,
      CODEGEN_MAX_OUTPUT_TOKENS,
    );
    const code = extractCode(text);
    if (!code.includes('function App(') && !code.includes('function App (')) {
      throw new Error(
        'The model did not return a React app: the response has no function App(). ' +
          'Raw head: ' + text.slice(0, 200),
      );
    }
    return code;
  }

  /** Raw model text for naming: a short reply needs only a small budget. */
  async generateText(prompt: string): Promise<string> {
    return (
      await this.complete('Return only the requested text, nothing else.', prompt, 128)
    ).trim();
  }
}

/**
 * Environment-configured codegen backend (#137, local test model).
 * Same env as the chat planner backend: AGENT_MODEL_BASE_URL (required,
 * http(s) only), AGENT_MODEL_API_KEY (required, read fresh from
 * process.env on every call — never logged, never persisted),
 * AGENT_MODEL_ID (optional). Returns null when base URL or key is
 * absent: the caller falls through to the Vertex path (which fails
 * closed with its own clear error when GCP credentials are absent).
 */
export function createEnvCodeGenBackend(deps: { fetchImpl?: typeof fetch } = {}): CodeGenBackend | null {
  const baseUrl = process.env.AGENT_MODEL_BASE_URL;
  const key = process.env.AGENT_MODEL_API_KEY;
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl) || !key) return null;
  const model = process.env.AGENT_MODEL_ID;
  return new OpenAiCompatibleCodeGenBackend({
    baseUrl,
    ...(model ? { model } : {}),
    getApiKey: async () => process.env.AGENT_MODEL_API_KEY ?? '',
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
}

/** Pull ```js fences out of a model response; fall back to raw text. */
export function extractCode(text: string): string {
  const fence = /```(?:javascript|js|jsx)?\s*\n([\s\S]*?)```/.exec(text);
  if (fence && fence[1]) return fence[1].trim();
  return text.trim();
}

/**
 * Test-mode backend (user spec: "in test mode it diverts to you").
 * Captures every prompt (tests assert on capturedPrompts) and returns a
 * canned-but-sensible React app. No network, no credentials, no fetch —
 * structurally incapable of calling Vertex AI.
 */
export class TestCodeGenBackend implements CodeGenBackend {
  readonly name = 'test-divert';
  readonly capturedPrompts: string[] = [];
  /** Naming prompts, kept apart from capturedPrompts (existing tests assert
   * that array's length after a generation — a naming call must not disturb it). */
  readonly capturedNamePrompts: string[] = [];

  async generateCode(prompt: string): Promise<string> {
    this.capturedPrompts.push(prompt);
    return CANNED_TEST_APP;
  }

  async generateText(prompt: string): Promise<string> {
    this.capturedNamePrompts.push(prompt);
    return 'Test App';
  }
}

/**
 * The canned app the test backend returns: a real, working data-table app
 * (sort + filter + MCP-only reads), plain JS with function App(), using
 * only the (React, h, useState, useEffect, useRef, mcp) surface the
 * artifact iframe provides.
 */
export const CANNED_TEST_APP = [
  'function App() {',
  '  var st = useState({ header: [], rows: [] });',
  '  var data = st[0], setData = st[1];',
  '  useEffect(function () {',
  '    mcp.call(\'read_cells\', { sheet: BINDING.sheet,',
  '      startRow: BINDING.startRow, startCol: BINDING.startCol,',
  '      endRow: BINDING.endRow, endCol: BINDING.endCol })',
  '      .then(function (res) {',
  '        var cells = (res && res.cells) || [];',
  '        setData({ header: cells[0] || [], rows: cells.slice(1) });',
  '      });',
  '  }, []);',
  '  var head = data.header.map(function (c, i) {',
  '    return h(\'th\', { key: i, className: \'border border-base-300\' }, String(c));',
  '  });',
  '  var body = data.rows.map(function (row, r) {',
  '    return h(\'tr\', { key: r }, data.header.map(function (_, c) {',
  '      return h(\'td\', { key: c, className: \'border border-base-300\' }, String(row[c]));',
  '    }));',
  '  });',
  '  return h(\'div\', { className: \'p-3 text-sm text-base-content\' },',
  '    h(\'h3\', { className: \'mb-2 text-lg font-bold\' }, \'Test-mode generated app\'),',
  '    h(\'table\', { className: \'table w-full\' },',
  '      h(\'thead\', null, h(\'tr\', null, head)),',
  '      h(\'tbody\', null, body)));',
  '}',
].join('\n');

export const CANNED_CHART_APP = [
  'function App() {',
  '  var data = [',
  "    { label: '2012', value: 102007 },",
  "    { label: '2013', value: 118086 },",
  "    { label: '2021', value: 183416 },",
  '  ];',
  "  return h('div', { className: 'card bg-base-100 shadow-sm' },",
  "    h('div', { className: 'card-body' },",
  "      h('h2', { className: 'card-title' }, 'Revenue by Year'),",
  "      h(AppChart, { data: data, title: 'Revenue by Year' })));",
  '}',
].join('\n');

export interface LlmAppGeneratorOptions {
  backend: CodeGenBackend;
  /** Freeform prompts that still match a template keep the deterministic path. */
  fallbackToTemplates?: boolean;
}

/**
 * Host-context contract (supersedes the #144 frame-contract fix): the
 * renderer provides React, h, useState, useEffect, useRef and mcp as
 * scope names, and App takes NO parameters. A model that both declares
 * App parameters and destructures from React redeclares a name and the
 * app crashes on mount before rendering (#147: `const { useState,
 * useEffect } = React` inside `function App(React, h, useState, ...)`).
 * The prompt contract now forbids both shapes; this sanitizer is the
 * defense-in-depth layer for already-stored specs: strip every bare
 * narrow-API name (h, useState, useEffect, useRef, mcp, AppChart) from React
 * destructures, so the bare scope names survive. Only bare names are
 * stripped; renamed bindings (`h: x`) and destructures from other
 * objects are left alone.
 */
const NARROW_API_NAMES = new Set(['h', 'useState', 'useEffect', 'useRef', 'mcp', 'AppChart']);

export function sanitizeReactDestructure(source: string): string {
  return source.replace(
    /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*React\s*;?/g,
    (_m, inner: string) => {
      const kept = inner
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p !== '' && !NARROW_API_NAMES.has(p));
      if (kept.length === 0) return '';
      return `const { ${kept.join(', ')} } = React;`;
    },
  );
}

/**
 * Render-time normalization for a generated app source, applied by the
 * host renderer to every spec (including already-stored ones) before
 * compile: drop App's parameter list (the contract is `function App()`
 * with NO parameters; parameters would shadow the scope names and, with
 * a destructure, redeclare them — the #147 crash class) and strip
 * narrow-API React destructures (see sanitizeReactDestructure). A source
 * that follows the contract passes through unchanged.
 */
export function normalizeAppSource(source: string): string {
  const noParams = source.replace(/function\s+App\s*\([^)]*\)/g, 'function App()');
  return sanitizeReactDestructure(noParams);
}

/**
 * Freeform React generation through a CodeGenBackend. The LLM prompt
 * carries the user prompt plus the inferred data schema (columns, types,
 * binding) and the hard contract: JSX (or plain JS with h() calls),
 * function App() with NO parameters, bare scope names only (never
 * destructure from React), data ONLY through mcp.call / mcp.subscribe,
 * never "</script".
 */
/**
 * #154: render the bound sheet's actual values for the code-gen prompt.
 * Rows are 0-based, matching the read_cells indices the generated app uses,
 * so the model can see exactly which row holds which measure and which
 * columns hold years. Capped (100 rows x 30 cols) so a huge sheet cannot
 * blow up the code-gen call; truncation is stated in the output itself.
 * Returns null when there are no values to show (callers omit the section).
 */
export const DATA_VALUES_MAX_ROWS = 100;
export const DATA_VALUES_MAX_COLS = 30;

export function formatDataValues(values: unknown[][] | undefined): string | null {
  if (!values || values.length === 0) return null;
  const rows = values.slice(0, DATA_VALUES_MAX_ROWS);
  const lines = rows.map((row, r) => {
    const cells = (Array.isArray(row) ? row : []).slice(0, DATA_VALUES_MAX_COLS);
    return `  row ${r}: ${cells.map((v) => (v === null || v === undefined ? '' : JSON.stringify(v))).join(' | ')}`;
  });
  const truncated =
    values.length > DATA_VALUES_MAX_ROWS ||
    values.some((row) => Array.isArray(row) && row.length > DATA_VALUES_MAX_COLS);
  if (truncated) {
    lines.push(
      `  (truncated to the first ${DATA_VALUES_MAX_ROWS} rows / ${DATA_VALUES_MAX_COLS} columns; read the rest live via mcp at render time)`,
    );
  }
  return lines.join('\n');
}

/**
 * #156: the DaisyUI component classes a generated app must demonstrably
 * use. Utilities (flex, p-3, bg-base-100, ...) do NOT count — an app of
 * bare divs plus utilities is exactly the "plain white card" failure.
 * This set mirrors the buildPrompt Components vocabulary (minus pure
 * utilities like rounded/border/bg/shadow, which are not components);
 * the Phase-1 design-system test pins the prompt vocabulary to the
 * compiled stylesheet, and the enforcement test pins this set to the
 * prompt vocabulary, so the three cannot drift apart silently.
 */
export const DESIGN_SYSTEM_COMPONENT_CLASSES: readonly string[] = [
  'card',
  'card-body',
  'card-title',
  'stats',
  'stat',
  'stat-title',
  'stat-value',
  'table',
  'table-zebra',
  'btn',
  'btn-primary',
  'btn-ghost',
  'btn-sm',
  'input',
  'select',
  'badge',
  'badge-primary',
  'badge-ghost',
  'alert',
  'alert-error',
  'alert-info',
];


/** Native controls that must carry their DaisyUI component class (#156):
 * a bare <select>/<button>/<input> renders as a native browser control
 * even inside an otherwise styled app. */
const DESIGN_SYSTEM_CONTROL_CLASSES: Readonly<Record<string, string>> = {
  select: 'select',
  button: 'btn',
  input: 'input',
};

export interface DesignSystemValidation {
  ok: boolean;
  errors: string[];
  componentClasses: string[];
}

/** Extract every class token from className attributes (JSX
 * className="..." and h() className: '...' forms) — including the forms
 * toggle buttons require (#160): className={...} expressions, where the
 * class names live inside quoted string literals in the branches
 * (className={active ? 'btn btn-primary' : 'btn'}), backtick template
 * literals, and plain class="..." attributes. The old extractor matched
 * only a quote immediately after : or =, so every toggle button read as
 * a bare <button> even when it carried btn in every branch — a 100%
 * rejection wall for button-bearing apps, not model disobedience. */
function extractClassTokens(source: string): Set<string> {
  const tokens = new Set<string>();
  const add = (text: string | undefined) => {
    if (!text) return;
    for (const t of text.split(/\s+/)) if (t) tokens.add(t);
  };
  // Static string literals: className="..." / className: '...' / class="...".
  for (const m of source.matchAll(/class(?:Name)?\s*[:=]\s*['"]([^'"]*)['"]/g)) {
    add(m[1]);
  }
  // Backtick literals: className={`...`} / className: `...` — tokenize the
  // static segments (split on ${...} interpolations).
  for (const m of source.matchAll(/class(?:Name)?\s*[:=]\s*`([^`]*)`/g)) {
    for (const seg of (m[1] ?? '').split(/\$\{[^}]*\}/)) add(seg);
  }
  // Dynamic expressions: className={...} (JSX) and className: <expr> (h()
  // object form, where the value is a bare expression like a ternary).
  // Tokenize every quoted literal — and every backtick template segment —
  // inside the expression.
  for (const m of source.matchAll(/className\s*[:=]\s*/g)) {
    const start = m.index + m[0].length;
    const first = source[start];
    if (first === '"' || first === "'" || first === '`') continue; // static passes above
    let expr: string | null = null;
    if (first === '{') expr = scanBraced(source, start);
    else if (first !== undefined) expr = scanExpression(source, start);
    if (expr === null) continue;
    for (const lit of expr.matchAll(/['"]([^'"]*)['"]/g)) add(lit[1]);
    for (const tpl of expr.matchAll(/`([^`]*)`/g)) {
      for (const seg of (tpl[1] ?? '').split(/\$\{[^}]*\}/)) add(seg);
    }
  }
  return tokens;
}

/** Text of a bare className expression starting at `start` (exclusive of
 * the `className:` prefix): up to the first top-level `,`, `}`, `)`, or
 * `;` — string-aware, paren/bracket/brace depth counted, so commas
 * inside calls or literals don't cut the expression short. */
function scanExpression(source: string, start: number): string {
  let quote: string | null = null;
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i]!;
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return source.slice(start, i);
      depth--;
    } else if (depth === 0 && (ch === ',' || ch === ';')) {
      return source.slice(start, i);
    }
  }
  return source.slice(start);
}

/** Text inside the brace at `openIdx` (exclusive), or null if unbalanced.
 * String-aware: quotes and backticks suspend brace counting, and backslash
 * escapes skip the next character. */
function scanBraced(source: string, openIdx: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i]!;
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(openIdx + 1, i);
    }
  }
  return null;
}

/**
 * #156 enforcement, pure and testable: a generated app passes iff it
 * uses at least one DaisyUI component class AND no bare native control
 * (select/button/input) appears without its component class. This is
 * what the DESIGN SYSTEM prompt block could never do alone — the model
 * could ignore it and nothing caught it.
 */
export function validateDesignSystem(source: string): DesignSystemValidation {
  const errors: string[] = [];
  const tokens = extractClassTokens(source);
  const found = DESIGN_SYSTEM_COMPONENT_CLASSES.filter((c) => tokens.has(c));
  if (found.length === 0) {
    errors.push(
      'uses no DaisyUI component class (card, stats, table, btn, select, input, badge, alert, ...) — a plain unstyled app',
    );
  }
  for (const [tag, cls] of Object.entries(DESIGN_SYSTEM_CONTROL_CLASSES)) {
    const hasElement =
      new RegExp(`<${tag}[\\s>/]`).test(source) ||
      new RegExp(`h\\(\\s*['"]${tag}['"]`).test(source);
    if (hasElement && !tokens.has(cls)) {
      errors.push(`bare <${tag}> without its DaisyUI '${cls}' class renders as a native control`);
    }
  }
  return { ok: errors.length === 0, errors, componentClasses: found };
}

/**
 * App-chart requirement (option A, 2026-10-26): when the user asks for
 * a chart, the app MUST render the host's AppChart component. Before
 * this, the prompt never mentioned charts, so the model improvised
 * year labels as plain text and called it a chart — a chart-shaped
 * lie nothing caught. The check mirrors validateDesignSystem: pure,
 * testable, and enforced in generate() with one named repair attempt.
 *
 * Chart-request detection is deliberately a keyword heuristic on the
 * user prompt (chart/graph/plot/visualization): a request that says
 * the word is a request for a chart; a request that never mentions
 * one is not held to the rule (an app may still render AppChart
 * unasked — that is harmless, still real data).
 */
export const CHART_REQUEST_RE = /\b(chart|graph|plot|visualis(?:ation|ation))\b/i;

export function wantsChart(prompt: string): boolean {
  return CHART_REQUEST_RE.test(prompt ?? '');
}

/** True when the source renders the host AppChart component, in JSX
 * (<AppChart ... />) or h() (h(AppChart, ...)) form. */
export function hasAppChartComponent(source: string): boolean {
  return /<AppChart[\s>/]/.test(source) || /h\(\s*AppChart[\s,)]/.test(source);
}

export interface ChartValidation {
  ok: boolean;
  errors: string[];
}

export function validateChartRequirement(
  source: string,
  prompt: string,
): ChartValidation {
  if (!wantsChart(prompt)) return { ok: true, errors: [] };
  if (hasAppChartComponent(source)) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: [
      'the request asks for a chart but the app renders no AppChart component — year labels as plain text are not a chart',
    ],
  };
}

export interface ControlWiringValidation {
  ok: boolean;
  errors: string[];
}

/** A useState selection: [state, setter] declared together. */
interface SelectionControl {
  state: string;
  setter: string;
}

/** True when the setter is called inside an onClick/onChange handler. */
function setterInHandler(source: string, setter: string): boolean {
  const call = new RegExp(`\\b${setter}\\s*\\(`);
  for (const attr of ['onClick', 'onChange']) {
    let idx = source.indexOf(`${attr}={`);
    while (idx !== -1) {
      const open = source.indexOf('{', idx);
      const body = open !== -1 ? scanBraced(source, open) : null;
      if (body !== null && call.test(body)) return true;
      idx = source.indexOf(`${attr}={`, idx + 1);
    }
  }
  // h() form: onClick: () => setter(...) — allow the arrow parameter
  // list, then a short body run up to a statement/brace boundary.
  if (new RegExp(`onClick\\s*:\\s*(?:\\([^)]*\\)\\s*=>\\s*)?[^;{}]{0,200}?\\b${setter}\\s*\\(`).test(source)) return true;
  if (new RegExp(`onChange\\s*:\\s*(?:\\([^)]*\\)\\s*=>\\s*)?[^;{}]{0,200}?\\b${setter}\\s*\\(`).test(source)) return true;
  return false;
}

function findSelectionControls(source: string): SelectionControl[] {
  const out: SelectionControl[] = [];
  const decl = /(?:const|let)\s*\[\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\]\s*=\s*useState\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(source)) !== null) {
    const state = m[1]!;
    const setter = m[2]!;
    if (setterInHandler(source, setter)) out.push({ state, setter });
  }
  return out;
}

/** Names derived from the seeds through const/let/var declarations, to fixpoint. */
function derivedNames(source: string, seeds: string[]): Set<string> {
  const known = new Set(seeds);
  let grew = true;
  while (grew) {
    grew = false;
    const decl = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
    let m: RegExpExecArray | null;
    while ((m = decl.exec(source)) !== null) {
      const name = m[1]!;
      if (known.has(name)) continue;
      const semi = source.indexOf(';', m.index + m[0].length);
      const rhs = source.slice(m.index + m[0].length, semi === -1 ? source.length : semi);
      if ([...known].some((k) => new RegExp(`\\b${k}\\b`).test(rhs))) {
        known.add(name);
        grew = true;
      }
    }
  }
  return known;
}

/** Every AppChart data expression found, JSX data={...} and h() data: forms. */
function appChartDataExpressions(source: string): string[] {
  const out: string[] = [];
  let idx = source.indexOf('<AppChart');
  while (idx !== -1) {
    const tagEnd = source.indexOf('>', idx);
    const dataIdx = source.indexOf('data={', idx);
    if (dataIdx !== -1 && (tagEnd === -1 || dataIdx < tagEnd)) {
      const open = source.indexOf('{', dataIdx);
      const expr = open !== -1 ? scanBraced(source, open) : null;
      if (expr !== null) out.push(expr);
    }
    idx = source.indexOf('<AppChart', idx + 1);
  }
  idx = source.indexOf('h(AppChart');
  while (idx !== -1) {
    const open = source.indexOf('{', idx);
    const props = open !== -1 ? scanBraced(source, open) : null;
    if (props !== null) {
      const dm = /data\s*:\s*/.exec(props);
      if (dm) {
        const start = dm.index + dm[0].length;
        let depth = 0;
        let quote: string | null = null;
        let end = props.length;
        for (let i = start; i < props.length; i++) {
          const ch = props[i]!;
          if (quote) {
            if (ch === '\\') i++;
            else if (ch === quote) quote = null;
            continue;
          }
          if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
          if (ch === '(' || ch === '[' || ch === '{') depth++;
          else if (ch === ')' || ch === ']' || ch === '}') {
            if (depth === 0) { end = i; break; }
            depth--;
          } else if (ch === ',' && depth === 0) { end = i; break; }
        }
        out.push(props.slice(start, end));
      }
    }
    idx = source.indexOf('h(AppChart', idx + 1);
  }
  return out;
}

/**
 * Strip control chrome from the source so what remains mentioning a
 * selection/derived name is overwhelmingly visible output: the
 * useState declarations, the derivation statements themselves, JSX
 * attribute braces for className/onClick/onChange/value/checked/
 * selected (active classes, handlers, select value), h() props
 * objects of button/select/input elements, and AppChart props (the
 * chart leg covers data binding separately; without this a
 * chart-only-bound app would pass the figure leg through its own data
 * expression). Spans are cut from the end backwards so earlier
 * indices stay valid.
 */
function stripControlChrome(source: string, controls: SelectionControl[], derived: Set<string>): string {
  const spans: [number, number][] = [];
  for (const c of controls) {
    const re = new RegExp(
      `(?:const|let)\\s*\\[\\s*${c.state}\\s*,\\s*${c.setter}\\s*\\]\\s*=\\s*useState\\s*\\([^;]*\\);?`,
      'g',
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) spans.push([m.index, m.index + m[0].length]);
  }
  const seeds = new Set(controls.map((c) => c.state));
  for (const name of derived) {
    if (seeds.has(name)) continue;
    const re = new RegExp(`(?:const|let|var)\\s+${name}\\b\\s*=[^;]*;?`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) spans.push([m.index, m.index + m[0].length]);
  }
  for (const attr of ['className', 'onClick', 'onChange', 'value', 'checked', 'selected']) {
    let idx = source.indexOf(`${attr}={`);
    while (idx !== -1) {
      const open = source.indexOf('{', idx);
      const inner = open !== -1 ? scanBraced(source, open) : null;
      if (inner !== null) spans.push([idx, open + inner.length + 2]);
      idx = source.indexOf(`${attr}={`, idx + 1);
    }
  }
  for (const tag of ['button', 'select', 'input']) {
    const re = new RegExp(`h\\(['"]${tag}['"]\\s*,\\s*\\{`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const open = m.index + m[0].length - 1;
      const inner = scanBraced(source, open);
      if (inner !== null) spans.push([m.index, open + inner.length + 2]);
    }
  }
  // AppChart props must not count as "displayed content" for the
  // figure leg: the chart leg already covers data binding, and
  // otherwise a chart-only-bound app would pass the figure leg
  // vacuously through its own data expression. JSX: strip data=/title=
  // braces inside the AppChart tag (tag end found brace-aware, so a
  // '>' inside an expression cannot cut the tag short). h(): strip
  // the whole props object.
  let tagIdx = source.indexOf('<AppChart');
  while (tagIdx !== -1) {
    let depth = 0;
    let quote: string | null = null;
    let tagEnd = source.length;
    for (let i = tagIdx; i < source.length; i++) {
      const ch = source[i]!;
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) { tagEnd = i; break; }
    }
    for (const attr of ['data', 'title']) {
      let aIdx = source.indexOf(`${attr}={`, tagIdx);
      while (aIdx !== -1 && aIdx < tagEnd) {
        const open = source.indexOf('{', aIdx);
        const inner = open !== -1 ? scanBraced(source, open) : null;
        if (inner !== null) spans.push([aIdx, open + inner.length + 2]);
        aIdx = source.indexOf(`${attr}={`, aIdx + 1);
      }
    }
    tagIdx = source.indexOf('<AppChart', tagIdx + 1);
  }
  {
    const re = /h\(AppChart\s*,\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const open = m.index + m[0].length - 1;
      const inner = scanBraced(source, open);
      if (inner !== null) spans.push([m.index, open + inner.length + 2]);
    }
  }
  spans.sort((a, b) => b[0] - a[0]);
  let out = source;
  for (const [s, e] of spans) out = out.slice(0, s) + out.slice(e);
  return out;
}

/**
 * Control-wiring requirement (round-5 leg C): a switching control set
 * whose state nothing reads is a defect, not an interaction. Round-4
 * leg C proved it: buttons + dropdown + real chart + exact totals all
 * rendered, but switching changed NOTHING displayed — the controls
 * synced state with each other (active class + select value moved)
 * while no figure and no chart data read the state. Presence checks
 * (btn/select/AppChart) cannot catch this: the state IS mentioned,
 * just never by any visible output. So: when the source holds a
 * selection control set (a useState whose setter runs in a control
 * handler), the selection — or a value derived from it — must appear
 * in visible output, AND, when an AppChart is present, in the chart's
 * data. No control set means the rule does not apply (ok). This is a
 * static floor, not a proof of figure-ness: a heading naming the
 * selection would pass the figure leg, so the prompt still requires a
 * featured FIGURE. Pure and testable; enforced in generate() with one
 * named repair attempt like the DS/chart checks.
 */
export function validateControlWiring(source: string): ControlWiringValidation {
  const errors: string[] = [];
  const controls = findSelectionControls(source);
  if (controls.length === 0) return { ok: true, errors: [] };
  const derived = derivedNames(source, controls.map((c) => c.state));
  const hasDerived = (expr: string): boolean =>
    [...derived].some((n) => new RegExp(`\\b${n}\\b`).test(expr));
  const stripped = stripControlChrome(source, controls, derived);
  if (!hasDerived(stripped)) {
    errors.push(
      'the app has switching controls but no displayed content reads the selection (the controls change state nothing shows — add a featured-figure display computed from the selection state)',
    );
  }
  if (hasAppChartComponent(source)) {
    const exprs = appChartDataExpressions(source);
    if (!exprs.some(hasDerived)) {
      errors.push(
        'the chart data does not depend on the selection (AppChart data never changes on switch — compute it from the selection state)',
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

export interface InitialSelectionValidation {
  ok: boolean;
  errors: string[];
}

/** Split an object-literal body on top-level commas (string- and nesting-aware). */
function splitTopLevelEntries(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  out.push(inner.slice(start));
  return out;
}

/** The key of one top-level object entry, or null when it is not a static key. */
function objectEntryKey(entry: string): string | null {
  const m = /^\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([A-Za-z_$][\w$]*))\s*:/.exec(entry);
  if (!m) return null;
  const key = m[1] ?? m[2] ?? m[3] ?? m[4]!;
  if (key.includes('${')) return null;
  return key;
}

/** The initial useState string literal for one control, or null when non-literal. */
function initialSelectionLiteral(source: string, state: string, setter: string): string | null {
  const decl = new RegExp(`\\[\\s*${state}\\s*,\\s*${setter}\\s*\\]\\s*=\\s*useState\\s*\\(`);
  const m = decl.exec(source);
  if (!m) return null;
  let i = m.index + m[0].length;
  while (i < source.length && /\s/.test(source[i]!)) i++;
  const quote = source[i];
  if (quote !== '"' && quote !== "'") return null;
  let out = '';
  i++;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\\' && i + 1 < source.length) {
      out += source[i + 1]!;
      i += 2;
      continue;
    }
    if (ch === quote) return out;
    out += ch;
    i++;
  }
  return null;
}

/** Keys of every object literal indexed by this state (union; empty when none is static). */
function lookupKeysFor(source: string, state: string): Set<string> {
  const keys = new Set<string>();
  const decl = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(source)) !== null) {
    const name = m[1]!;
    const open = m.index + m[0].length - 1;
    if (!new RegExp(`\\b${name}\\s*\\[\\s*${state}\\s*\\]`).test(source)) continue;
    const inner = scanBraced(source, open);
    if (inner === null) continue;
    for (const entry of splitTopLevelEntries(inner)) {
      const key = objectEntryKey(entry);
      if (key !== null) keys.add(key);
    }
  }
  return keys;
}

/**
 * Initial-selection requirement (#166): the mount must resolve, not
 * just the switches. The v4 recording's app proved the hole in the
 * round-5 wiring check: buttons + dropdown + featured figure + chart
 * all read the selection, so both wiring legs pass — but the initial
 * useState value was a SHORT display label ("Revenue") while the
 * lookup keys were FULL labels ("Total Revenue", ...), so the mount
 * lookup missed and the fallback rendered 0.00 + an empty chart until
 * a button set a full key. Time alone never fixed it: the initial
 * state was born wrong, not slow. So: when a selection control's
 * featured/chart derivation is a lookup over a static object literal
 * indexed by that state, the initial useState string literal MUST be
 * one of the lookup's keys. Fail-open everywhere else: no control
 * set, a non-literal initial, a findRow-style derivation, or a
 * dynamically built lookup table is not judged — only a literal
 * initial against literal keys can be wrong in a way this check can
 * prove. Union across indexed lookups (a floor, like the wiring
 * check: it proves the mount resolves, not that every leg resolves).
 * Pure and testable; enforced in generate() with one named repair
 * attempt like the DS/chart/wiring checks.
 */
export function validateInitialSelection(source: string): InitialSelectionValidation {
  const errors: string[] = [];
  for (const control of findSelectionControls(source)) {
    const initial = initialSelectionLiteral(source, control.state, control.setter);
    if (initial === null) continue;
    const keys = lookupKeysFor(source, control.state);
    if (keys.size === 0) continue;
    if (!keys.has(initial)) {
      errors.push(
        `the initial selection "${initial}" is not a key the featured/chart lookup uses (keys: ${[...keys].map((k) => `"${k}"`).join(', ')}) — the app mounts with no data (0.00 + empty chart) until a control is switched; set the initial useState value to one of those keys, the same full key string a button or dropdown sets, never a shortened display label`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

export interface NamedValueCoverageValidation {
  ok: boolean;
  errors: string[];
}

/** Tolerance mirror of the runtime's numEq (0.01 absolute + rel 1e-9). */
function namedValueEq(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.01 + Math.abs(b) * 1e-9;
}

/** Column letters for a 0-based column index (A, B, …, Z, AA, …). */
function colLetters(col: number): string {
  let n = col + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function namedValueA1(row: number, col: number): string {
  return `${colLetters(col)}${row + 1}`;
}

/**
 * Numbers the request names as figures: large magnitudes only (a KPI
 * total, not a year, a count, or a small literal), with year integers
 * excluded even when a range hyphen makes one negative ("2012-2021"
 * must not produce a phantom -2021).
 */
function promptNamedNumbers(prompt: string): number[] {
  const out: number[] = [];
  for (const m of prompt.matchAll(/-?\d[\d,]*(\.\d+)?/g)) {
    const v = Number(m[0].replace(/,/g, ''));
    if (!Number.isFinite(v) || Math.abs(v) < 1000) continue;
    if (Number.isInteger(v) && Math.abs(v) >= 1900 && Math.abs(v) <= 2100) continue;
    out.push(v);
  }
  return out;
}

/** Numeric literals in code, with string contents removed first so a
 *  figure mentioned only in prose or a label does not count as shown. */
function sourceNumericLiterals(source: string): number[] {
  const stripped = source
    .replace(/'(?:[^'\\]|\\.)*'/g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"/g, ' ')
    .replace(/`(?:[^`\\]|\\.)*`/g, ' ');
  const out: number[] = [];
  for (const m of stripped.matchAll(/-?\d[\d,]*(\.\d+)?/g)) {
    const v = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

interface ParsedRead {
  sheet: string | null;
  startRow: number | null;
  startCol: number | null;
  endRow: number | null;
  endCol: number | null;
}

function parseReadArgs(args: string): ParsedRead {
  const num = (key: string): number | null => {
    const m = new RegExp(`\\b${key}\\s*:\\s*(-?\\d+)`).exec(args);
    return m ? Number(m[1]) : null;
  };
  const sm = /['"]?sheet['"]?\s*:\s*['"]([^'"]+)['"]/.exec(args);
  return {
    sheet: sm ? sm[1]! : null,
    startRow: num('startRow'),
    startCol: num('startCol'),
    endRow: num('endRow'),
    endCol: num('endCol'),
  };
}

/**
 * Named-value coverage (leg-C "not in sheet" follow-up): the app
 * showed "not in sheet" for figures the data plainly held, because
 * its live read covered rows 5-15 while the named totals sat at
 * B2:D2, and its lookup labels carried leading spaces no row could
 * exactly match. The #154 contract already demands real numbers, but
 * nothing checked reachability: a read that excludes the named
 * figure's cell, or a label search over a different range, sailed
 * through. So: every figure the request names (large magnitude, not
 * a year) that matches a DATA VALUES cell MUST be reachable — as a
 * numeric literal in the source, or via a read_cells range on the
 * bound sheet covering that cell (get_results on the bound sheet
 * covers all). Fail-open everywhere else: no named values, no
 * matching cell, no values matrix, or a read whose bounds are not
 * static literals is not judged — only a provable miss fails.
 * Pure and testable; enforced in generate() with one named repair
 * attempt like the DS/chart/wiring/initial checks.
 */
export function validateNamedValueCoverage(
  source: string,
  input: Pick<AppGenerationInput, 'prompt' | 'sheet' | 'binding' | 'values'>,
): NamedValueCoverageValidation {
  const errors: string[] = [];
  const values = input.values;
  if (!values || values.length === 0) return { ok: true, errors };
  // Locate every named figure's cells in the DATA VALUES matrix
  // (matrix origin = the binding origin; inferSchema hardcodes 0,0).
  const namedCells = new Map<number, { row: number; col: number }[]>();
  for (const v of promptNamedNumbers(input.prompt)) {
    const cells: { row: number; col: number }[] = [];
    for (let r = 0; r < values.length; r++) {
      const row = values[r];
      if (!Array.isArray(row)) continue;
      for (let c = 0; c < row.length; c++) {
        if (typeof row[c] === 'number' && namedValueEq(row[c] as number, v)) {
          cells.push({ row: input.binding.startRow + r, col: input.binding.startCol + c });
        }
      }
    }
    if (cells.length > 0) namedCells.set(v, cells);
  }
  if (namedCells.size === 0) return { ok: true, errors };
  // Reads: get_results on the bound sheet covers everything;
  // read_cells ranges cover their rectangles. A read whose bounds are
  // not static literals cannot be judged — fail open, not false-fail.
  const wholeSheets = new Set<string>();
  const ranges: ParsedRead[] = [];
  let unparseableRead = false;
  const readRe = /read_cells["'],\s*\{([\s\S]*?)\}/g;
  let m: RegExpExecArray | null;
  while ((m = readRe.exec(source)) !== null) {
    const parsed = parseReadArgs(m[1]!);
    if (
      parsed.sheet === null ||
      parsed.startRow === null ||
      parsed.startCol === null ||
      parsed.endRow === null ||
      parsed.endCol === null
    ) {
      unparseableRead = true;
    } else {
      ranges.push(parsed);
    }
  }
  const resultsRe = /get_results["'],\s*\{([\s\S]*?)\}/g;
  while ((m = resultsRe.exec(source)) !== null) {
    const sm = /['"]?sheet['"]?\s*:\s*['"]([^'"]+)['"]/.exec(m[1]!);
    if (sm) wholeSheets.add(sm[1]!);
    else unparseableRead = true;
  }
  if (unparseableRead) return { ok: true, errors };
  const literals = sourceNumericLiterals(source);
  for (const [value, cells] of namedCells) {
    const literalHit = literals.some((lit) => namedValueEq(lit, value));
    const readHit =
      wholeSheets.has(input.sheet) ||
      cells.some(({ row, col }) =>
        ranges.some(
          (r) =>
            r.sheet === input.sheet &&
            row >= r.startRow! &&
            row <= r.endRow! &&
            col >= r.startCol! &&
            col <= r.endCol!,
        ),
      );
    if (!literalHit && !readHit) {
      const addrs = cells
        .map(({ row, col }) => `${input.sheet}!${namedValueA1(row, col)}`)
        .join(', ');
      errors.push(
        `the app must display the named figure ${value} but no read covers its cell (${addrs}) and no literal matches it — read exactly that cell (live mcp read_cells on the bound sheet) and display it, or use the literal; do not re-derive it by label search over a different range`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

export class LlmAppGenerator implements AppGenerator {
  readonly name: string;
  private readonly backend: CodeGenBackend;

  constructor(opts: LlmAppGeneratorOptions) {
    this.backend = opts.backend;
    this.name = `llm-${opts.backend.name}`;
  }

  /** The backend in use — the mode is explicit in the construction. */
  get mode(): LlmMode {
    return this.backend instanceof TestCodeGenBackend ? 'test' : 'vertex';
  }

  /** Exposed for tests: what the last generation asked the model. */
  get testBackend(): TestCodeGenBackend | null {
    return this.backend instanceof TestCodeGenBackend ? this.backend : null;
  }

  buildPrompt(input: AppGenerationInput): string {
    const cols = input.columns
      .map((c) => `  - ${c.name} (${c.type}, column ${c.index})`)
      .join('\n');
    // #154: the actual values — without these the model had to guess every
    // figure it displayed (name-only schema, wrong header row for
    // horizontal year layouts). Rows are 0-based, matching read_cells.
    const dataValues = formatDataValues(input.values);
    const dataSection = dataValues
      ? [
          '',
          'DATA VALUES (the bound sheet range above, rows 0-based exactly as read_cells returns them — read the layout off these rows: the label column names each measure row, and a row of years across columns means one measure per row with one value per year):',
          dataValues,
        ]
      : [];
    return [
      'You generate a React app that runs embedded inside the Icecream Sheets chat artifact panel.',
      '',
      'USER REQUEST:',
      input.prompt,
      '',
      'DATA SCHEMA (bound sheet range):',
      `  sheet: ${input.sheet}`,
      `  range rows ${input.binding.startRow}-${input.binding.endRow}, cols ${input.binding.startCol}-${input.binding.endCol}, header row: ${input.binding.hasHeaderRow}`,
      '  columns:',
      cols,
      ...dataSection,
      '',
      'HARD CONTRACT (the app will be rejected if violated):',
      '1. JSX allowed. Define exactly `function App()` with NO parameters, and write the UI as JSX (plain JavaScript with h() calls is also accepted). Do NOT write TypeScript: no type annotations, no interfaces, no `as` casts — JSX only. No imports, no build step on your side: the host transforms the JSX for you.',
      '2. NEVER declare parameters on App and NEVER destructure anything from React. Use the bare names from scope directly: `h` (= React.createElement), `useState`, `useEffect`, `useRef`, `mcp`, `AppChart` (the host bar-chart component, see CHARTS below), and `React` itself. Declaring `function App(React, h, useState, ...)` or writing `const { useState } = React` redeclares a name that already exists in scope and crashes the app on mount before anything renders.',
      '3. Data access ONLY through `mcp.call(tool, args)` and `mcp.subscribe(events, sheet, handler)`.',
      '   Available tools: read_cells {sheet,startRow,startCol,endRow,endCol},',
      '   write_cells {cells:[{sheet,row,col,value}]}, get_results {sheet}.',
      '   read_cells/get_results resolve to {cells} where cells is a 2D array of',
      '   plain values (string | number | boolean | null), header row first.',
      '   A global BINDING = {sheet,startRow,startCol,endRow,endCol,columns} is pre-defined; use it.',
      '   mcp.subscribe events MUST be exactly one or more of: "cells_changed",',
      '   "recalc_complete", "sheet_added", "sheet_removed" (other names are',
      '   rejected and the subscription silently never fires). subscribe returns',
      '   the unsubscribe function: return it from useEffect, or keep it and call',
      '   its .unsubscribe() method in the effect cleanup.',
      '4. The source must NEVER contain the substring "</script".',
      '5. Keep it self-contained and readable; no external URLs. The host already sets the system font, so do not set fontFamily.',
      '6. NUMBERS MUST BE REAL (#154 — a displayed figure that matches no cell is a defect, not a placeholder): every number the app shows MUST come from the DATA VALUES above or from a live mcp read of the same cells. NEVER invent, round-guess, or hardcode a figure that is not in the data.',
      '7. A "total" is the SUM across the year/value columns for that measure row, computed in code from the live-read cells. NEVER present a single column\'s value (e.g. the first year) as a total, and NEVER take a label-matched row\'s first value as its total.',
      '8. Match measures by their EXACT row label in the data (e.g. "Revenue", "Gross Profit", "Net Earnings" — note: "Net Earnings" is NOT "Net Income", and "Revenue" is NOT "Total Revenue"). If the requested label has no row in the data, show visible "not in sheet" text for it — NEVER show 0.',
      '9. Compute aggregates in code from the live-read matrix (rule 7), never as hardcoded literal totals, so sheet edits propagate to the app.',
      '10. NAMED FIGURES MUST BE REACHABLE (an app that shows "not in sheet" for a figure the data plainly holds is rejected): if the request names exact figures (e.g. "Use the values 1501837.91, 945097.33, and 301572.03"), the app MUST display those figures — read the exact cells holding them in the DATA VALUES above (match by value, never by re-searching a different range or different labels) and display those cells, or use them as literals. NEVER re-derive a named figure by label search over a different range: a read that excludes the named figure\'s cell, or a lookup label that matches no row, shows "not in sheet" for a figure the data holds, and the app is rejected.',
      '',
      'DESIGN SYSTEM (the host provides the Icecream design stylesheet — Tailwind + DaisyUI, light/dark themed — so these classes ARE available; use them for all chrome and structure):',
      'Use ONLY the classes listed here. Any other class name is not in the host stylesheet and renders unstyled. Use inline style ONLY for values computed from data (e.g. a bar width from a cell).',
      'Layout: flex, flex-col, items-center, justify-between, gap-2, gap-3, gap-4, w-full, max-w-60, overflow-x-auto, p-2, p-3, p-4, mb-1, mb-2, mb-3, mb-2.5, mt-2.',
      'Text: text-xs, text-sm, text-base, text-lg, text-xl, font-bold, font-semibold, text-left, text-center, text-base-content, opacity-60, opacity-70.',
      'Components: card, card-body, card-title, stats, stat, stat-title, stat-value, table, table-zebra, btn, btn-primary, btn-ghost, btn-sm, input, select, badge, badge-primary, badge-ghost, alert, alert-error, alert-info, rounded, rounded-box, border, border-base-300, bg-base-100, bg-base-200, shadow-sm.',
      'Dropdowns MUST use the select class and actions MUST use btn: a bare <select>/<button>/<input> renders as a native control and the app is rejected, even if the rest is styled.',
      'Buttons that switch state keep btn in every branch: className={active ? "btn btn-primary" : "btn"} — a conditional className counts, and the validator reads the class names inside it. Never drop a requested button to dodge this rule.',
      'Muted text: text-base-content plus opacity-60 or opacity-70 (do NOT use text-base-content/70 — the opacity suffix has no effect on theme colors).',
      'Example: h(\'div\', { className: \'card bg-base-100 shadow-sm\' }, h(\'div\', { className: \'card-body\' }, h(\'h2\', { className: \'card-title\' }, \'Title\'), h(\'table\', { className: \'table w-full\' }, h(\'thead\', null, h(\'tr\', null, h(\'th\', { className: \'border border-base-300\' }, \'Col\')))))).',
      'JSX example (same classes): <div className="card bg-base-100 shadow-sm"><div className="card-body"><h2 className="card-title">Title</h2><table className="table w-full"><thead><tr><th className="border border-base-300">Col</th></tr></thead></table></div></div>.',
      '',
      'CHARTS (the host provides a real chart component — use it, never fake one):',
      'AppChart is a bare scope name, like h and useState: <AppChart data={points} title="Revenue by Year" /> (JSX) or h(AppChart, { data: points, title: "Revenue by Year" }) (h() form).',
      'Props: data = an array of { label, value } — label is the category name as a string (e.g. a year like "2012"), value is the number to plot. title = an optional chart title string. That is the whole API: no other props, no other chart component.',
      'REQUIRED: whenever the user asks for a chart, graph, plot, or visualization, the app MUST render AppChart with data computed in code from the live-read cells (rules 6-9 apply to chart data exactly as to figures: every value from the DATA VALUES above or a live mcp read, totals as sums across year/value columns, exact label match, never 0 for a missing label).',
      'NEVER render year labels (or any categories) as plain text and call it a chart. NEVER draw a fake chart from divs, bars made of styled divs, or a table dressed up as a chart. If there is no data to plot, render AppChart with an empty array — it shows "No data to chart" visibly — never a text-only substitute.',
      'Example: const points = years.map((y, i) => ({ label: String(y), value: revenueRow[i] })); return <div className="card bg-base-100 shadow-sm"><div className="card-body"><AppChart data={points} title="Revenue by Year" /></div></div>;',
      '',
      'CONTROLS MUST DRIVE VISIBLE OUTPUT (a switch that changes nothing is a defect — the app will be rejected if its controls drive nothing):',
      'Whenever the app has buttons, a dropdown, or any control that switches a selection (a useState value set by onClick/onChange), TWO things MUST be bound to that selection state, so switching visibly changes the app:',
      '1. A FEATURED FIGURE display: a big number + label showing the SELECTED measure\'s total, computed in code from the selection. Static KPI cards showing every measure at once do NOT satisfy this, because switching changes none of them.',
      '2. The CHART data: AppChart\'s data prop MUST be computed from the selection, so the chart re-renders with the selected measure\'s series on every switch.',
      'Never render controls whose state nothing reads: if a button or dropdown sets state, that state MUST appear in a displayed figure AND in the chart data.',
      'Example (totals/points computed in code from the live-read cells per rules 6-9, shown here as variables): const MEASURES = { Revenue: { total: revenueTotal, points: revenuePoints }, "Gross Profit": { total: grossTotal, points: grossPoints } }; const [measure, setMeasure] = useState("Revenue"); const featured = MEASURES[measure]; return <div className="card bg-base-100 shadow-sm"><div className="card-body"><div><button className={measure === "Revenue" ? "btn btn-primary" : "btn"} onClick={() => setMeasure("Revenue")}>Revenue</button></div><div className="stat-value">{featured.total}</div><AppChart data={featured.points} title={measure + " by Year"} /></div></div>;',
      'INITIAL STATE MUST RESOLVE (an app that mounts empty until the first switch is a defect — the app will be rejected if its initial selection resolves to nothing):',
      'The initial useState value MUST be exactly one of the keys the featured-figure/chart lookup uses — the SAME full key string a button or dropdown sets. NEVER initialize with a shortened display label, a button label, or any other vocabulary than the lookup keys.',
      'BROKEN: const measures = { "Total Revenue": {...}, "Gross Profit": {...} }; const [measure, setMeasure] = useState("Revenue"); — "Revenue" is not a key, so the mount lookup misses and shows 0.00 + an empty chart until a button sets "Total Revenue".',
      'FIXED: const [measure, setMeasure] = useState("Total Revenue"); — the initial value is a lookup key, so the mount shows the exact total + chart with no interaction. Buttons may DISPLAY short labels ("Revenue") as their text, but the value they SET must be the full key ("Total Revenue").',
      'If a lookup ever misses, show visible "not in sheet" text — NEVER a silent 0 total or an empty chart (rule 8).',
      '',
      'Return ONLY the JSX source, no prose, no markdown fences if avoidable.',
    ].join('\n');
  }

  /**
   * Naming prompt for the dedicated post-generation naming call: the model
   * names the app from the same request + schema the code was built from.
   * The caller (generateAndSaveArtifact) cleans the raw reply; this prompt
   * only asks for a short plain-text name, nothing else.
   */
  buildNamePrompt(input: AppGenerationInput): string {
    const cols = input.columns
      .map((c) => `  - ${c.name} (${c.type}, column ${c.index})`)
      .join('\n');
    return [
      'Give a short name for an app built from this request.',
      '',
      'USER REQUEST:',
      input.prompt,
      '',
      'DATA (bound sheet):',
      `  sheet: ${input.sheet}`,
      '  columns:',
      cols,
      '',
      'RULES: at most 6 words; plain text only; no quotes, no markdown, no trailing punctuation.',
      'Return ONLY the name, nothing else.',
    ].join('\n');
  }

  async generate(input: AppGenerationInput): Promise<AppGenerationOutput> {
    const prompt = this.buildPrompt(input);
    const raw = await this.backend.generateCode(prompt);
    // Host-context contract: normalize at generation (strip App params
    // and narrow-API React destructures) so the #147 crash class cannot
    // reach the panel even if the model ignores the prompt contract.
    const source = normalizeAppSource(extractCode(raw));
    if (source.includes('</script')) {
      throw new Error('LLM-generated source contains "</script" and was rejected.');
    }
    if (!/function App\s*\(/.test(source)) {
      throw new Error('LLM-generated source does not define function App() and was rejected.');
    }
    // #156: the DESIGN SYSTEM block is advisory prose — a model that
    // ignored it used to ship a plain app nobody caught. Validate, and
    // on failure make ONE repair attempt with the rejection named
    // (models repair well when told exactly what was missing); a second
    // failure throws visibly instead of saving a plain app.
    let finalSource = source;
    const ds = validateDesignSystem(source);
    if (!ds.ok) {
      const repairPrompt =
        `${prompt}\n\nREPAIR — the previous source was rejected: ${ds.errors.join('; ')}. ` +
        'Regenerate the same app, but its chrome MUST use DaisyUI component classes: ' +
        'panels as card + card-body, key figures as stats + stat, actions as btn btn-primary, ' +
        'dropdowns as select, tables as table. Toggle buttons keep btn in every branch: ' +
        'className={active ? "btn btn-primary" : "btn"}. A source with no DaisyUI component class, or a ' +
        'bare <select>/<button>/<input> without its component class, is rejected again.';
      const repaired = normalizeAppSource(extractCode(await this.backend.generateCode(repairPrompt)));
      if (repaired.includes('</script')) {
        throw new Error('LLM-generated source contains "</script" and was rejected.');
      }
      if (!/function App\s*\(/.test(repaired)) {
        throw new Error('LLM-generated source does not define function App() and was rejected.');
      }
      const ds2 = validateDesignSystem(repaired);
      if (!ds2.ok) {
        throw new Error(
          `LLM-generated source does not use the design system and was rejected after one repair attempt: ${ds2.errors.join('; ')}.`,
        );
      }
      finalSource = repaired;
    }
    // App-chart requirement (option A): same pattern as the DS check —
    // a chart request with no AppChart renders a text-only fake, so
    // validate, and on failure make ONE repair attempt naming the miss;
    // a second failure throws visibly instead of saving a chart-less
    // app. The repaired source must pass BOTH checks (a chart repair
    // must not regress the design system).
    const chart = validateChartRequirement(finalSource, input.prompt);
    if (!chart.ok) {
      // Round-4 (leg C): the old repair regenerated from scratch
      // WITHOUT the previous source in context, so the model had to
      // reconstruct buttons + dropdown + chart from the prompt alone
      // and traded controls off under complexity (combined proof: a
      // real chart + working dropdown, zero toggle buttons despite an
      // explicit button request). The repair now carries the previous
      // source and demands a MINIMAL edit: keep every control, toggle
      // button, dropdown, figure, and layout exactly, only ADD the
      // chart — with the control classes restated so the edit cannot
      // silently drop them either.
      const repairPrompt =
        `${prompt}\n\nPREVIOUS SOURCE — keep it, do not regenerate from scratch:\n${finalSource}\n\nREPAIR — the previous source was rejected: ${chart.errors.join('; ')}. ` +
        'Make a MINIMAL edit to the previous source: keep every control, toggle button, dropdown, figure, and layout in it EXACTLY as-is; only ADD the chart. ' +
        'Toggle buttons keep btn in every branch: className={active ? "btn btn-primary" : "btn"}; dropdowns keep the select class. ' +
        'Whenever the request asks for a chart it MUST render the host ' +
        'AppChart component: <AppChart data={points} title="..." /> (JSX) or h(AppChart, { data: points, title: "..." }) ' +
        '(h() form), where points is an array of { label, value } computed in code from the live-read cells. ' +
        'Year labels as plain text are not a chart, and a chart made of styled divs is not a chart. ' +
        'A source with no AppChart component for a chart request is rejected again.';
      const repaired = normalizeAppSource(extractCode(await this.backend.generateCode(repairPrompt)));
      if (repaired.includes('</script')) {
        throw new Error('LLM-generated source contains "</script" and was rejected.');
      }
      if (!/function App\s*\(/.test(repaired)) {
        throw new Error('LLM-generated source does not define function App() and was rejected.');
      }
      const ds3 = validateDesignSystem(repaired);
      const chart2 = validateChartRequirement(repaired, input.prompt);
      if (!ds3.ok || !chart2.ok) {
        throw new Error(
          `LLM-generated source does not satisfy the chart requirement and was rejected after one repair attempt: ${[...ds3.errors, ...chart2.errors].join('; ')}.`,
        );
      }
      finalSource = repaired;
    }
    const wiring = validateControlWiring(finalSource);
    if (!wiring.ok) {
      // Round-5 (leg C): the chart repair fixed presence but not
      // wiring — buttons + dropdown + chart + exact totals rendered
      // while switching changed NOTHING displayed, because the
      // selection state was read only by active classes and the select
      // value. Same pattern as the chart repair: one MINIMAL edit on
      // the previous source, naming the miss, and the repaired source
      // must pass ALL THREE checks (a wiring repair must not regress
      // the design system or the chart).
      const repairPrompt =
        `${prompt}\n\nPREVIOUS SOURCE — keep it, do not regenerate from scratch:\n${finalSource}\n\nREPAIR — the previous source was rejected: ${wiring.errors.join('; ')}. ` +
        'Make a MINIMAL edit to the previous source: keep every control, toggle button, dropdown, figure, and layout in it EXACTLY as-is; only WIRE the selection: ' +
        'add a featured-figure display computed from the selection state (a big number + label showing the selected measure\'s total) and compute AppChart\'s data from the selection state, so switching changes BOTH the displayed figure AND the chart. ' +
        'Toggle buttons keep btn in every branch: className={active ? "btn btn-primary" : "btn"}; dropdowns keep the select class. ' +
        'A source whose controls set state nothing reads is rejected again.';
      const repaired = normalizeAppSource(extractCode(await this.backend.generateCode(repairPrompt)));
      if (repaired.includes('</script')) {
        throw new Error('LLM-generated source contains "</script" and was rejected.');
      }
      if (!/function App\s*\(/.test(repaired)) {
        throw new Error('LLM-generated source does not define function App() and was rejected.');
      }
      const ds4 = validateDesignSystem(repaired);
      const chart3 = validateChartRequirement(repaired, input.prompt);
      const wiring2 = validateControlWiring(repaired);
      if (!ds4.ok || !chart3.ok || !wiring2.ok) {
        throw new Error(
          `LLM-generated source does not satisfy the control-wiring requirement and was rejected after one repair attempt: ${[...ds4.errors, ...chart3.errors, ...wiring2.errors].join('; ')}.`,
        );
      }
      finalSource = repaired;
    }
    const initial = validateInitialSelection(finalSource);
    if (!initial.ok) {
      // #166: the wiring check proves switches drive output, but it
      // cannot prove the MOUNT resolves — the v4 app passed wiring
      // while mounting 0.00 + an empty chart, because its initial
      // state was a short display label no lookup key matched. Same
      // pattern as the wiring repair: one MINIMAL edit on the
      // previous source, naming the miss, and the repaired source
      // must pass ALL FOUR checks (an initial-value repair must not
      // regress the design system, the chart, or the wiring).
      const repairPrompt =
        `${prompt}\n\nPREVIOUS SOURCE — keep it, do not regenerate from scratch:\n${finalSource}\n\nREPAIR — the previous source was rejected: ${initial.errors.join('; ')}. ` +
        'Make a MINIMAL edit to the previous source: keep every control, toggle button, dropdown, figure, and layout in it EXACTLY as-is; only FIX the initial selection: ' +
        'change the initial useState value to one of the lookup keys — the same full key string a button or dropdown sets, never a shortened display label — so the app mounts with the exact total + chart and no interaction is needed. ' +
        'Toggle buttons keep btn in every branch: className={active ? "btn btn-primary" : "btn"}; dropdowns keep the select class. ' +
        'A source whose initial selection resolves to nothing is rejected again.';
      const repaired = normalizeAppSource(extractCode(await this.backend.generateCode(repairPrompt)));
      if (repaired.includes('</script')) {
        throw new Error('LLM-generated source contains "</script" and was rejected.');
      }
      if (!/function App\s*\(/.test(repaired)) {
        throw new Error('LLM-generated source does not define function App() and was rejected.');
      }
      const ds5 = validateDesignSystem(repaired);
      const chart4 = validateChartRequirement(repaired, input.prompt);
      const wiring3 = validateControlWiring(repaired);
      const initial2 = validateInitialSelection(repaired);
      if (!ds5.ok || !chart4.ok || !wiring3.ok || !initial2.ok) {
        throw new Error(
          `LLM-generated source does not satisfy the initial-selection requirement and was rejected after one repair attempt: ${[...ds5.errors, ...chart4.errors, ...wiring3.errors, ...initial2.errors].join('; ')}.`,
        );
      }
      finalSource = repaired;
    }
    const coverage = validateNamedValueCoverage(finalSource, input);
    if (!coverage.ok) {
      // Leg-C "not in sheet" follow-up: the v4-style app passed DS,
      // chart, wiring, and initial checks while showing "not in sheet"
      // for figures the data plainly held — its live read covered
      // rows 5-15 while the named totals sat at B2:D2, and its lookup
      // labels carried leading spaces no row could exactly match.
      // Same pattern as the initial repair: one MINIMAL edit on the
      // previous source, naming the miss, and the repaired source
      // must pass ALL FIVE checks (a coverage repair must not regress
      // the design system, the chart, the wiring, or the initial).
      const repairPrompt =
        `${prompt}\n\nPREVIOUS SOURCE — keep it, do not regenerate from scratch:\n${finalSource}\n\nREPAIR — the previous source was rejected: ${coverage.errors.join('; ')}. ` +
        'Make a MINIMAL edit to the previous source: keep every control, toggle button, dropdown, figure, and layout in it EXACTLY as-is; only FIX the data reads: ' +
        'read the exact cells named in the rejection (live mcp read_cells on the bound sheet) and display THOSE cells as the KPI figures — do not look them up by label search over a different range, and do not change the labels. ' +
        'If the app has a chart, compute its points from the live-read yearly series (the year row + measure row from a live read of the source sheet), never from a label lookup that misses. ' +
        'Toggle buttons keep btn in every branch: className={active ? "btn btn-primary" : "btn"}; dropdowns keep the select class. ' +
        'A source whose named figures are still unreachable is rejected again.';
      const repaired = normalizeAppSource(extractCode(await this.backend.generateCode(repairPrompt)));
      if (repaired.includes('</script')) {
        throw new Error('LLM-generated source contains "</script" and was rejected.');
      }
      if (!/function App\s*\(/.test(repaired)) {
        throw new Error('LLM-generated source does not define function App() and was rejected.');
      }
      const ds6 = validateDesignSystem(repaired);
      const chart5 = validateChartRequirement(repaired, input.prompt);
      const wiring4 = validateControlWiring(repaired);
      const initial3 = validateInitialSelection(repaired);
      const coverage2 = validateNamedValueCoverage(repaired, input);
      if (!ds6.ok || !chart5.ok || !wiring4.ok || !initial3.ok || !coverage2.ok) {
        throw new Error(
          `LLM-generated source does not satisfy the named-value coverage requirement and was rejected after one repair attempt: ${[...ds6.errors, ...chart5.errors, ...wiring4.errors, ...initial3.errors, ...coverage2.errors].join('; ')}.`,
        );
      }
      finalSource = repaired;
    }
    // App naming (dedicated call, after code): the displayed name must be a
    // proper short name from the model, not the user's prompt text. Naming
    // NEVER fails generation — on any absence, error, or empty reply the
    // name is omitted and generateAndSaveArtifact falls back to the
    // prompt-derived name.
    let name: string | undefined;
    try {
      if (this.backend.generateText) {
        const rawName = await this.backend.generateText(this.buildNamePrompt(input));
        if (rawName && rawName.trim() !== '') name = rawName;
      }
    } catch {
      name = undefined;
    }
    return {
      source: finalSource,
      template: 'custom' as AppGenerationOutput['template'],
      ...(name ? { name } : {}),
    };
  }
}

/**
 * Resolve which generator to use. Explicit and auditable: 'test' always
 * builds the divert backend, 'vertex' always builds the Vertex AI backend
 * (which throws clearly without credentials).
 */
export function resolveAppGenerator(
  mode: LlmMode,
  vertex: Omit<VertexAiCodeGenOptions, 'getAccessToken'> & {
    getAccessToken?: () => Promise<string | null>;
  },
): AppGenerator {
  if (mode === 'test') return new LlmAppGenerator({ backend: new TestCodeGenBackend() });
  return new LlmAppGenerator({
    backend: new VertexAiCodeGenBackend({
      ...vertex,
      getAccessToken: vertex.getAccessToken ?? (async () => null),
    }),
  });
}
