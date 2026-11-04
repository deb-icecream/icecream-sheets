/**
 * Extended Excel-compatibility functions, batch 11 — the FINAL 14.
 *
 * STOCKHISTORY, WEBSERVICE, RTD, COPILOT, PY, CALL, REGISTER.ID — all real
 * implementations (no-stub policy, 2026-10-18). After this module, zero
 * #N/A stubs remain in the codebase.
 *
 * Architecture (the engine is synchronous and browser-safe):
 * - Each function reads through an engine-local provider/registry seam.
 *   Hosts inject their service-backed providers (market-data connector,
 *   Fetch component, MCP subscription bus, AI Agent host, sandboxes).
 * - Where a REAL synchronous default exists under Node (curl, python3 via
 *   child_process), the default uses it — so the functions work with zero
 *   wiring in the MCP server, the desktop shell, and Node tests. The Node
 *   access goes through `globalThis.process.getBuiltinModule` (no static
 *   node: imports), so browser bundles are unaffected; in a browser without
 *   a wired provider the function reports #N/A naming the setter the host
 *   must call. That is honest capability reporting, not a stub: the
 *   function is fully implemented wherever its host service exists.
 *
 * Unlike batches 8-10 this module does NOT self-register on import: hosts
 * call registerExtendedFunctions11() explicitly (it is idempotent).
 */
import {
  CellError,
  EmptyValue,
  ErrorType,
  FunctionArgumentType,
  FunctionPlugin,
  HyperFormula,
  SimpleRangeValue,
} from 'hyperformula';
import type { ProcedureAst } from 'hyperformula/typings/parser/Ast.js';
import type { InterpreterState } from 'hyperformula/typings/interpreter/InterpreterState.js';
import type { InterpreterValue } from 'hyperformula/typings/interpreter/InterpreterValue.js';
import { to2DArray, type ArrayResult } from './dynamic-arrays.js';

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

type Arg = { argumentType: FunctionArgumentType; optionalArg?: boolean };
const S = (optionalArg = false): Arg => ({ argumentType: FunctionArgumentType.SCALAR, optionalArg });
const A = (optionalArg = false): Arg => ({ argumentType: FunctionArgumentType.ANY, optionalArg });

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function scalarText(v: InterpreterValue): string {
  if (v === EmptyValue) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function asVal(v: unknown): InterpreterValue {
  return v as unknown as InterpreterValue;
}

/**
 * Synchronous child_process.execFileSync access WITHOUT a static node:
 * import (which would break browser bundling). Uses
 * process.getBuiltinModule (Node 22+) via globalThis so bundlers never see
 * a node: specifier. Returns null outside Node.
 */
type ExecFileSync = (file: string, args: string[], opts: Record<string, unknown>) => unknown;
let cachedExec: ExecFileSync | null | undefined;
function nodeExecFileSync(): ExecFileSync | null {
  if (cachedExec !== undefined) return cachedExec;
  try {
    const proc = (globalThis as Record<string, unknown>)['process'];
    if (!proc || typeof proc !== 'object') {
      cachedExec = null;
      return null;
    }
    const gbm = (proc as { getBuiltinModule?: unknown })['getBuiltinModule'];
    if (typeof gbm !== 'function') {
      cachedExec = null;
      return null;
    }
    const cp = (gbm as (id: string) => { execFileSync: ExecFileSync })('child_process');
    cachedExec = cp.execFileSync;
    return cachedExec;
  } catch {
    cachedExec = null;
    return null;
  }
}

/** Synchronous HTTPS(S) GET via curl. Throws when unavailable or on HTTP error. */
function curlText(url: string, timeoutSecs = 15): string {
  const exec = nodeExecFileSync();
  if (!exec) throw new Error('no Node.js runtime available for synchronous fetch');
  const out = exec(
    'curl',
    ['-sS', '-L', '--fail', '--max-time', String(timeoutSecs), url],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  return String(out);
}

/** Map a plain JSON-ish value to an InterpreterValue (scalars only). */
function scalarToInterpreter(v: unknown): InterpreterValue {
  if (v === null || v === undefined) return EmptyValue;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return new CellError(ErrorType.NUM, 'Non-finite number.');
    return v;
  }
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// STOCKHISTORY — market data (provider seam + Stooq default).
// ---------------------------------------------------------------------------

export interface MarketBar {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type MarketInterval = 'd' | 'w' | 'm';

export interface MarketDataProvider {
  getHistory(symbol: string, start: string, end: string, interval: MarketInterval): MarketBar[];
}

const marketCache = new Map<string, MarketBar[]>();

function marketCacheKey(symbol: string, start: string, end: string, interval: MarketInterval): string {
  return `${norm(symbol)}|${start}|${end}|${interval}`;
}

/**
 * Publish market history into the engine (e.g. after the host fetched it
 * through the service market-data connector). STOCKHISTORY reads the cache
 * first, so hosts can pre-feed data asynchronously.
 */
export function publishMarketHistory(symbol: string, bars: MarketBar[]): void {
  if (bars.length === 0) return;
  const dates = bars.map((b) => b.date).sort();
  const key = marketCacheKey(symbol, dates[0]!, dates[dates.length - 1]!, 'd');
  marketCache.set(key, bars);
  // Also index under weekly/monthly keys so interval variants hit.
  marketCache.set(marketCacheKey(symbol, dates[0]!, dates[dates.length - 1]!, 'w'), bars);
  marketCache.set(marketCacheKey(symbol, dates[0]!, dates[dates.length - 1]!, 'm'), bars);
}

/** Clear published market data (tests). */
export function clearMarketHistory(): void {
  marketCache.clear();
}

/**
 * Convert connector TableData ([Date,Open,High,Low,Close,Volume] headers)
 * into MarketBars for publishMarketHistory().
 */
export function marketTableToBars(headers: string[], rows: unknown[][]): MarketBar[] {
  const idx = (name: string): number =>
    headers.findIndex((h) => norm(String(h)) === name);
  const di = idx('date');
  const oi = idx('open');
  const hi = idx('high');
  const li = idx('low');
  const ci = idx('close');
  const vi = idx('volume');
  const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
    return Number.isFinite(n) ? n : 0;
  };
  const out: MarketBar[] = [];
  for (const row of rows) {
    const date = String(row[di] ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    out.push({
      date,
      open: num(row[oi]),
      high: num(row[hi]),
      low: num(row[li]),
      close: num(row[ci]),
      volume: num(row[vi]),
    });
  }
  return out;
}

let marketDataProvider: MarketDataProvider | null = null;

/** Host override for market data (e.g. a licensed feed). */
export function setMarketDataProvider(p: MarketDataProvider): void {
  marketDataProvider = p;
}

/** Restore the default provider (tests). */
export function resetMarketDataProvider(): void {
  marketDataProvider = null;
}

/**
 * Fetch bars through the market-data provider seam (published cache first,
 * then the Stooq default over synchronous curl). Exported so GOOGLEFINANCE
 * (google-functions.ts) shares the exact same data source as STOCKHISTORY.
 */
export function getMarketBars(
  symbol: string,
  start: string,
  end: string,
  interval: MarketInterval,
): MarketBar[] {
  return (marketDataProvider ?? defaultMarketDataProvider).getHistory(symbol, start, end, interval);
}

function stooqSymbol(symbol: string): string {
  const s = symbol.trim().toLowerCase();
  return s.includes('.') ? s : `${s}.us`;
}

function stooqUrl(symbol: string, start: string, end: string, interval: MarketInterval): string {
  const d1 = start.replace(/-/g, '');
  const d2 = end.replace(/-/g, '');
  return `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol(symbol))}&d1=${d1}&d2=${d2}&i=${interval}`;
}

/** Parse a Stooq daily CSV (Date,Open,High,Low,Close,Volume). Exported for tests. */
export function parseStooqCsv(csv: string): MarketBar[] {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const bars: MarketBar[] = [];
  for (const line of lines.slice(1)) {
    const [date, open, high, low, close, volume] = line.split(',');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const num = (v: string | undefined): number => {
      const n = parseFloat(v ?? '');
      return Number.isFinite(n) ? n : 0;
    };
    // Stooq marks missing data as "N/D".
    if (open === 'N/D' || close === 'N/D') continue;
    bars.push({
      date,
      open: num(open),
      high: num(high),
      low: num(low),
      close: num(close),
      volume: num(volume),
    });
  }
  return bars;
}

/**
 * Default market-data provider: published cache first, then Stooq
 * (free, no API key) over synchronous curl under Node.
 */
const defaultMarketDataProvider: MarketDataProvider = {
  getHistory(symbol: string, start: string, end: string, interval: MarketInterval): MarketBar[] {
    const key = marketCacheKey(symbol, start, end, interval);
    const cached = marketCache.get(key);
    if (cached) return cached.filter((b) => b.date >= start && b.date <= end);
    let text: string;
    try {
      text = curlText(stooqUrl(symbol, start, end, interval));
    } catch (e) {
      throw new Error(
        `STOCKHISTORY: no cached data for "${symbol}" and live fetch failed (${e instanceof Error ? e.message : String(e)}). ` +
          `Hosts can pre-feed data with publishMarketHistory() or wire a provider via setMarketDataProvider().`,
      );
    }
    const bars = parseStooqCsv(text).filter((b) => b.date >= start && b.date <= end);
    marketCache.set(key, bars);
    return bars;
  },
};

/** Excel serial (1900 system) or date string -> YYYY-MM-DD. */
function toIsoDate(v: InterpreterValue): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  if (typeof v === 'string') {
    const d = new Date(v.trim());
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  return null;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseInterval(v: InterpreterValue): MarketInterval | null {
  if (typeof v === 'number') {
    if (v === 0) return 'd';
    if (v === 1) return 'w';
    if (v === 2) return 'm';
    return null;
  }
  const t = norm(scalarText(v));
  if (t === 'd' || t === 'daily') return 'd';
  if (t === 'w' || t === 'weekly') return 'w';
  if (t === 'm' || t === 'monthly') return 'm';
  if (t === '') return 'd';
  return null;
}

// ---------------------------------------------------------------------------
// WEBSERVICE — Fetch component seam.
// ---------------------------------------------------------------------------

export type WebFetchProvider = (url: string) => string;

let webFetchProvider: WebFetchProvider | null = null;

/**
 * Host override for WEBSERVICE (the Fetch component in the adapter layer,
 * per design-docs/connector-vs-component.md, calls this).
 */
export function setWebFetchProvider(p: WebFetchProvider): void {
  webFetchProvider = p;
}

/** Restore the default provider (tests). */
export function resetWebFetchProvider(): void {
  webFetchProvider = null;
}

const MAX_WEBSERVICE_CHARS = 32767; // Excel's cell-text limit.

/**
 * Fetch URL text through the injected provider (setWebFetchProvider) or the
 * synchronous curl default in Node. Only http/https URLs reach curl.
 * Exported so the IMPORT* functions (import-functions.ts) share the same
 * WebFetchProvider seam as WEBSERVICE.
 */
export function fetchUrlText(url: string, maxChars = MAX_WEBSERVICE_CHARS): string {
  if (webFetchProvider) return webFetchProvider(url).slice(0, maxChars);
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`unsupported URL "${url}" (only http/https).`);
  }
  try {
    return curlText(url).slice(0, maxChars);
  } catch (e) {
    throw new Error(
      `fetch failed for "${url}" (${e instanceof Error ? e.message : String(e)}). ` +
        `Hosts can wire a fetch implementation via setWebFetchProvider().`,
    );
  }
}

function defaultWebFetch(url: string): string {
  try {
    return fetchUrlText(url, MAX_WEBSERVICE_CHARS);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(msg.startsWith('WEBSERVICE') ? msg : `WEBSERVICE: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// RTD — real-time data bus (fed by the MCP event-subscription substrate).
// ---------------------------------------------------------------------------

const rtdBus = new Map<string, InterpreterValue>();

/** Canonical topic key. Exported so hosts publish to the same key RTD reads. */
export function rtdTopicKey(progId: string, server: string, topics: string[]): string {
  return [norm(progId), norm(server), ...topics.map((t) => norm(t))].join('|');
}

/**
 * Publish a live value to an RTD topic. Hosts call this when the underlying
 * subscription fires (e.g. the MCP server maps subscription events onto RTD
 * topics), then trigger a recalculation so dependent cells pick it up —
 * the same callback contract as Excel's IRtdServer.
 */
export function publishRtdTopic(
  progId: string,
  server: string,
  topics: string[],
  value: unknown,
): void {
  rtdBus.set(rtdTopicKey(progId, server, topics), scalarToInterpreter(value));
}

/** Clear all RTD topics (tests). */
export function clearRtdTopics(): void {
  rtdBus.clear();
}

// ---------------------------------------------------------------------------
// COPILOT — product AI analyst (default deterministic analyst; host can
// wire the full AI Agent host via setCopilotProvider()).
// ---------------------------------------------------------------------------

export interface CopilotProvider {
  /** Answer a natural-language question over an optional context grid. */
  ask(prompt: string, context: ArrayResult | null): InterpreterValue;
}

let copilotProvider: CopilotProvider | null = null;

/**
 * Host override: route COPILOT prompts to the product's AI Agent host
 * (packages/service/src/agent/). The default below is a real deterministic
 * analyst, so COPILOT works with zero wiring.
 */
export function setCopilotProvider(p: CopilotProvider): void {
  copilotProvider = p;
}

/** Restore the default analyst (tests). */
export function resetCopilotProvider(): void {
  copilotProvider = null;
}

function flattenNumbers(data: ArrayResult): number[] {
  const out: number[] = [];
  for (const row of data) {
    for (const v of row) {
      if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
    }
  }
  return out;
}

function countNonEmpty(data: ArrayResult): number {
  let n = 0;
  for (const row of data) {
    for (const v of row) {
      if (v !== EmptyValue && v !== null && v !== '' && !(v instanceof CellError)) n++;
    }
  }
  return n;
}

const COPILOT_USAGE =
  'COPILOT(prompt, context): pass a range, e.g. =COPILOT("summarize", A1:A10). ' +
  'Supported intents: sum, average, count, min, max, summarize.';

/**
 * Default COPILOT analyst: a deterministic intent router over the context
 * grid (no LLM dependency, real computation — a spreadsheet-function
 * helper, unrelated to the agent's model backend). Aggregation intents
 * return numbers so they
 * compose inside larger formulas; "summarize" returns a readable string.
 * Exported for tests.
 */
export function analyzeCopilot(prompt: string, context: ArrayResult | null): InterpreterValue {
  const p = norm(prompt);
  if (!context || context.length === 0) {
    return new CellError(ErrorType.VALUE, COPILOT_USAGE);
  }
  const nums = flattenNumbers(context);
  const has = (words: string[]): boolean => words.some((w) => p.includes(w));
  const nonEmpty = countNonEmpty(context);
  if (has(['summar', 'descri', 'overview', 'statistic'])) {
    if (nums.length === 0) {
      return `${nonEmpty} non-empty cells, no numbers.`;
    }
    const sum = nums.reduce((a, b) => a + b, 0);
    const avg = sum / nums.length;
    const lo = Math.min(...nums);
    const hi = Math.max(...nums);
    return `${nums.length} numbers: sum ${sum}, average ${avg}, min ${lo}, max ${hi}.`;
  }
  if (has(['average', 'avg', 'mean'])) {
    if (nums.length === 0) return new CellError(ErrorType.DIV_BY_ZERO, 'COPILOT: no numbers to average.');
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  }
  if (has(['sum', 'total'])) {
    return nums.reduce((a, b) => a + b, 0);
  }
  if (has(['how many', 'count'])) {
    return nums.length > 0 ? nums.length : nonEmpty;
  }
  if (has(['max', 'largest', 'highest', 'biggest'])) {
    if (nums.length === 0) return new CellError(ErrorType.VALUE, 'COPILOT: no numbers found.');
    return Math.max(...nums);
  }
  if (has(['min', 'smallest', 'lowest', 'least'])) {
    if (nums.length === 0) return new CellError(ErrorType.VALUE, 'COPILOT: no numbers found.');
    return Math.min(...nums);
  }
  return new CellError(
    ErrorType.VALUE,
    'COPILOT: could not determine the analysis. ' + COPILOT_USAGE,
  );
}

// ---------------------------------------------------------------------------
// PY — sandboxed Python (provider seam + Node default).
// ---------------------------------------------------------------------------

export type PythonPlotResult = { value: unknown; plot?: string };
/** Result of one sandboxed Python run: a JSON value, an optional PNG plot, or an error. */
export type PythonResult = PythonPlotResult | { error: string };

export interface PythonProvider {
  run(code: string, args: unknown[]): PythonResult;
}

let pythonProvider: PythonProvider | null = null;

/**
 * Host override for PY (e.g. a remote Python service). The default below
 * runs python3 in a restricted subprocess under Node.
 */
export function setPythonProvider(p: PythonProvider): void {
  pythonProvider = p;
}

/** Restore the default provider (tests). */
export function resetPythonProvider(): void {
  pythonProvider = null;
}

/** Read the active provider (default included) — for named Python functions. */
export function getPythonProvider(): PythonProvider {
  return pythonProvider ?? defaultPythonProvider;
}

/**
 * Restricted Python prelude (adapted from the MCP server sandbox):
 * safe builtins only, import allowlist, args as JSON in argv[1], program
 * on stdin, `result` printed as JSON. Not a kernel sandbox — same honest
 * limits as packages/mcp-server/src/sandbox/python.ts.
 *
 * Plots-in-cells: after `result` is serialized, the prelude captures a
 * plot when one was produced —
 *   1. an explicit `plot` variable holding a base64 PNG string (or a dict
 *      with a 'png' key), or
 *   2. best-effort matplotlib auto-capture: when matplotlib.pyplot has a
 *      current figure with axes, it is rendered with the Agg backend to a
 *      base64 PNG.
 * The envelope then carries `__sandbox_plot__` alongside
 * `__sandbox_value__`; PY() turns it into the typed in-cell ImageValue
 * (the same typed drawing result the IMAGE function produces), which the
 * grid renders as an <img>. When a plot is present it wins the cell —
 * Excel semantics: the cell contains the image object.
 *
 * Exported so service-layer pinned environments reuse the exact same
 * sandbox contract as the engine default provider.
 */
export const PY_PRELUDE = String.raw`
import sys as _sys, json as _json, builtins as _builtins
_real_import = _builtins.__import__
_ALLOWED = frozenset(['math', 'json', 're', 'itertools', 'functools', 'datetime',
                      'statistics', 'io', 'base64', 'pandas', 'numpy', 'matplotlib'])
def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    if str(name).split('.')[0] not in _ALLOWED:
        raise ImportError("import of '%s' is not allowed" % name)
    return _real_import(name, globals, locals, fromlist, level)
_SAFE = {
    'abs': abs, 'all': all, 'any': any, 'bool': bool, 'chr': chr,
    'dict': dict, 'divmod': divmod, 'enumerate': enumerate, 'float': float,
    'int': int, 'isinstance': isinstance, 'len': len, 'list': list,
    'map': map, 'max': max, 'min': min, 'pow': pow, 'range': range,
    'repr': repr, 'reversed': reversed, 'round': round, 'set': set,
    'sorted': sorted, 'str': str, 'sum': sum, 'tuple': tuple,
    'zip': zip, 'True': True, 'False': False, 'None': None,
    '__import__': _safe_import, '__build_class__': __build_class__,
}
_user_code = _sys.stdin.read()
_args = _json.loads(_sys.argv[1])
_g = {'__builtins__': _SAFE, 'args': _args}
try:
    exec(_user_code, _g)
except Exception as _e:
    print(_json.dumps({'__sandbox_error__': '%s: %s' % (type(_e).__name__, _e)}))
    raise SystemExit(0)
if 'result' not in _g:
    print(_json.dumps({'__sandbox_error__': "program must assign a variable named 'result'"}))
    raise SystemExit(0)
_envelope = {}
try:
    _envelope['__sandbox_value__'] = _g['result']
except Exception as _e:
    print(_json.dumps({'__sandbox_error__': 'result is not JSON-serializable: %s' % _e}))
    raise SystemExit(0)
# --- plot capture (plots-in-cells) ---
_plot_b64 = None
if 'plot' in _g:
    _p = _g['plot']
    if isinstance(_p, str):
        _plot_b64 = _p
    elif isinstance(_p, dict) and isinstance(_p.get('png'), str):
        _plot_b64 = _p['png']
if _plot_b64 is None:
    # Auto-capture only probes matplotlib when the user's program already
    # imported it: a cold "import matplotlib" costs seconds of interpreter
    # startup (font-manager scan; ~9s on a loaded 2-CPU VM), and without a
    # user-side import no figure can exist to capture. When matplotlib is
    # already in sys.modules the import below is a cached no-op, so programs
    # that drew with matplotlib still auto-capture exactly as before.
    if 'matplotlib' in _sys.modules:
        try:
            import matplotlib as _mpl
            _mpl.use('Agg')
            import matplotlib.pyplot as _plt
            _fig = _plt.gcf()
            if _fig.get_axes():
                import io as _io, base64 as _b64
                _buf = _io.BytesIO()
                _fig.savefig(_buf, format='png')
                _plot_b64 = _b64.b64encode(_buf.getvalue()).decode('ascii')
        except Exception:
            _plot_b64 = None
if _plot_b64 is not None:
    _envelope['__sandbox_plot__'] = _plot_b64
try:
    print(_json.dumps(_envelope))
except Exception as _e:
    print(_json.dumps({'__sandbox_error__': 'result is not JSON-serializable: %s' % _e}))
    raise SystemExit(0)
`;

/**
 * Default sandbox subprocess timeout. 30s leaves headroom for the worst
 * real-world per-run cost: python3 startup plus a matplotlib import inside
 * user code (~9s on a loaded 2-CPU VM) and the Agg render. Hosts can tune it
 * with setPythonTimeoutMs() or the ICECREAM_PY_TIMEOUT_MS env var (ms).
 */
export const PY_TIMEOUT_DEFAULT_MS = 30_000;

let pyTimeoutOverrideMs: number | null = null;

/**
 * Override the PY sandbox subprocess timeout for this host (ms, > 0).
 * Host-scoped config, like setPythonProvider() — not reset by
 * resetPythonProvider().
 */
export function setPythonTimeoutMs(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error('Python timeout must be a positive number of milliseconds.');
  }
  pyTimeoutOverrideMs = ms;
}

/**
 * Current PY sandbox subprocess timeout in ms: explicit override, then
 * ICECREAM_PY_TIMEOUT_MS (read via globalThis so browser bundling is
 * unaffected), then the default.
 */
export function getPythonTimeoutMs(): number {
  if (pyTimeoutOverrideMs !== null) return pyTimeoutOverrideMs;
  try {
    const proc = (globalThis as Record<string, unknown>)['process'];
    const env =
      proc && typeof proc === 'object'
        ? (proc as { env?: Record<string, string | undefined> })['env']
        : undefined;
    const raw = env?.['ICECREAM_PY_TIMEOUT_MS'];
    if (raw !== undefined && raw.trim() !== '') {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {
    // Non-Node host: fall through to the default.
  }
  return PY_TIMEOUT_DEFAULT_MS;
}
const PY_MAX_CELLS = 10000;
/**
 * Cap on an in-cell plot payload: 1_500_000 base64 chars (~1.1 MiB PNG).
 * Larger plots are rejected with #VALUE! instead of being truncated.
 */
export const PY_PLOT_MAX_B64_CHARS = 1_500_000;

/**
 * Parse one sandboxed-Python stdout envelope into a PythonResult.
 * Shared by the default provider and service-layer pinned environments so
 * every host honors the same contract (value + optional plot).
 */
export function parsePythonEnvelope(stdout: string): PythonResult {
  const line = stdout.trim().split('\n').pop() ?? '';
  let envelope: {
    __sandbox_value__?: unknown;
    __sandbox_error?: string;
    __sandbox_plot__?: unknown;
  };
  try {
    envelope = JSON.parse(line) as typeof envelope;
  } catch {
    return { error: `PY: could not parse Python output: ${line.slice(0, 200)}` };
  }
  if (typeof envelope.__sandbox_error === 'string') {
    return { error: `PY: ${envelope.__sandbox_error}` };
  }
  if (!('__sandbox_value__' in envelope)) {
    return { error: 'PY: no result returned by the Python program.' };
  }
  const result: PythonPlotResult = { value: envelope.__sandbox_value__ };
  if (typeof envelope.__sandbox_plot__ === 'string' && envelope.__sandbox_plot__.length > 0) {
    result.plot = envelope.__sandbox_plot__;
  }
  return result;
}

const B64_RE = /^[A-Za-z0-9+/=\r\n]+$/;

/**
 * Turn a captured plot (base64 PNG) into the typed in-cell ImageValue —
 * the same typed drawing result the IMAGE function produces. Returns a
 * CellError when the payload is not a plausible PNG.
 */
export function pyPlotToImageValue(plotB64: string): InterpreterValue {
  const clean = plotB64.replace(/\s+/g, '');
  // PNG magic bytes 89 50 4E 47 0D 0A 1A 0A always encode to this prefix.
  if (
    clean.length < 64 ||
    clean.length > PY_PLOT_MAX_B64_CHARS ||
    !B64_RE.test(clean) ||
    !clean.startsWith('iVBORw0KGgo')
  ) {
    return new CellError(
      ErrorType.VALUE,
      'PY plot is not a valid base64 PNG (or exceeds the 1.5M-char plot cap).',
    );
  }
  return asVal({
    kind: 'image',
    src: `data:image/png;base64,${clean}`,
    alt: 'Python plot',
    sizing: 0,
  });
}

const defaultPythonProvider: PythonProvider = {
  run(code: string, args: unknown[]): PythonResult {
    const exec = nodeExecFileSync();
    if (!exec) {
      return {
        error:
          'PY is not available in this host (needs Node.js + python3). ' +
          'Hosts can wire a Python backend via setPythonProvider().',
      };
    }
    let argsJson: string;
    try {
      argsJson = JSON.stringify(args ?? []);
    } catch {
      return { error: 'PY arguments are not JSON-serializable.' };
    }
    let stdout: string;
    try {
      const out = exec('python3', ['-c', PY_PRELUDE, argsJson], {
        input: code,
        encoding: 'utf8',
        timeout: getPythonTimeoutMs(),
        maxBuffer: 4 * 1024 * 1024,
      });
      stdout = String(out ?? '');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/ENOENT/.test(msg)) {
        return { error: 'PY: python3 executable not found on this host.' };
      }
      return { error: `PY execution failed: ${msg}` };
    }
    return parsePythonEnvelope(stdout);
  },
};

/** Map a JSON value from Python onto grid values (spills). */
function jsonToInterpreter(value: unknown, budget: { cells: number }): InterpreterValue {
  if (value === null || value === undefined) return EmptyValue;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return new CellError(ErrorType.NUM, 'PY returned a non-finite number.');
    return value;
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return EmptyValue;
    const rows: InterpreterValue[][] = [];
    for (const el of value) {
      if (Array.isArray(el)) {
        rows.push(el.map((x) => jsonToInterpreter(x, budget)));
      } else if (el !== null && typeof el === 'object') {
        rows.push([asVal(JSON.stringify(el))]);
      } else {
        // 1-D list spills as a single column (pandas-Series convention).
        rows.push([jsonToInterpreter(el, budget)]);
      }
      budget.cells += rows[rows.length - 1]!.length;
      if (budget.cells > PY_MAX_CELLS || rows.length > 1000) {
        return new CellError(ErrorType.VALUE, `PY result exceeds the ${PY_MAX_CELLS}-cell spill cap.`);
      }
    }
    return asVal(rows);
  }
  if (typeof value === 'object') {
    // dict -> two-column [key, value] table.
    const rows = Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      asVal(k),
      jsonToInterpreter(v, budget),
    ]);
    return asVal(rows);
  }
  return asVal(String(value));
}

// ---------------------------------------------------------------------------
// CALL / REGISTER.ID — sandboxed JS function registry (the designed
// replacement for DLL entry points, which cannot load in a browser or
// Electron renderer).
// ---------------------------------------------------------------------------

export type ExternalFunction = (...args: Array<string | number | boolean | null>) => unknown;

interface ExternalFunctionEntry {
  id: string;
  name: string;
  fn: ExternalFunction;
}

const extFunctions = new Map<string, ExternalFunctionEntry>();
const extFunctionsById = new Map<string, ExternalFunctionEntry>();
let extSeq = 0;

/**
 * Register a JavaScript function callable from formulas via CALL /
 * REGISTER.ID. Returns the function's ID (e.g. "XLL.1").
 *
 * SECURITY: the host is responsible for sandboxing. In Node, wrap `fn`
 * with the node:vm sandbox (see packages/mcp-server/src/sandbox/
 * javascript.ts). Never register untrusted code with ambient authority.
 */
export function registerExternalFunction(name: string, fn: ExternalFunction): string {
  const key = norm(name);
  const existing = extFunctions.get(key);
  if (existing) {
    existing.fn = fn;
    return existing.id;
  }
  extSeq += 1;
  const entry: ExternalFunctionEntry = { id: `XLL.${extSeq}`, name: name.trim(), fn };
  extFunctions.set(key, entry);
  extFunctionsById.set(entry.id.toLowerCase(), entry);
  return entry.id;
}

/** Remove a registered external function (tests). */
export function unregisterExternalFunction(nameOrId: string): boolean {
  const key = norm(nameOrId);
  const byName = extFunctions.get(key);
  if (byName) {
    extFunctions.delete(key);
    extFunctionsById.delete(byName.id.toLowerCase());
    return true;
  }
  const byId = extFunctionsById.get(key);
  if (byId) {
    extFunctionsById.delete(key);
    extFunctions.delete(norm(byId.name));
    return true;
  }
  return false;
}

/** Clear the registry (tests). */
export function clearExternalFunctions(): void {
  extFunctions.clear();
  extFunctionsById.clear();
  extSeq = 0;
}

/** List registered external functions. */
export function listExternalFunctions(): Array<{ id: string; name: string }> {
  return [...extFunctions.values()].map((e) => ({ id: e.id, name: e.name }));
}

function lookupExternalFunction(ref: string): ExternalFunctionEntry | null {
  const key = norm(ref);
  return extFunctions.get(key) ?? extFunctionsById.get(key) ?? null;
}

// ---------------------------------------------------------------------------
// The plugin.
// ---------------------------------------------------------------------------

export class ExtendedFunctions11Plugin extends FunctionPlugin {
  public static implementedFunctions: Record<
    string,
    { method: string; parameters: Arg[]; repeatLastArgs?: number }
  > = {
    STOCKHISTORY: {
      method: 'stockhistory',
      parameters: [S(), S(true), S(true), S(true), S(true), S(true)],
    },
    WEBSERVICE: { method: 'webservice', parameters: [S()] },
    RTD: { method: 'rtd', parameters: [S(), S(), S()], repeatLastArgs: 1 },
    COPILOT: { method: 'copilot', parameters: [S(), A(true)] },
    PY: { method: 'py', parameters: [S(), A(true)], repeatLastArgs: 1 },
    CALL: { method: 'call', parameters: [S(), A(true)], repeatLastArgs: 1 },
    'REGISTER.ID': { method: 'registerId', parameters: [S(true), S(true), S(true)] },
  };

  public stockhistory(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('STOCKHISTORY'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [symbolArg, startArg, endArg, intervalArg, headersArg, propertiesArg] = args;
        if (symbolArg instanceof CellError) return symbolArg;
        const symbol = scalarText(symbolArg ?? EmptyValue).trim();
        if (symbol === '') {
          return new CellError(ErrorType.VALUE, 'STOCKHISTORY requires a stock symbol.');
        }
        const end = toIsoDate(endArg ?? EmptyValue) ?? todayIso();
        const start = toIsoDate(startArg ?? EmptyValue) ?? addDaysIso(end, -90);
        if (start > end) {
          return new CellError(ErrorType.VALUE, 'STOCKHISTORY: start date is after end date.');
        }
        const interval = parseInterval(intervalArg ?? EmptyValue);
        if (!interval) {
          return new CellError(ErrorType.VALUE, 'STOCKHISTORY: interval must be 0 (daily), 1 (weekly) or 2 (monthly).');
        }
        const headersOpt =
          typeof headersArg === 'number' ? Math.trunc(headersArg) : norm(scalarText(headersArg ?? EmptyValue)) === '0' ? 0 : 1;
        const propsOpt =
          typeof propertiesArg === 'number'
            ? Math.trunc(propertiesArg)
            : { '1': 1, '2': 2 }[norm(scalarText(propertiesArg ?? EmptyValue))] ?? 0;
        let bars: MarketBar[];
        try {
          bars = (marketDataProvider ?? defaultMarketDataProvider).getHistory(symbol, start, end, interval);
        } catch (e) {
          return new CellError(ErrorType.NA, e instanceof Error ? e.message : String(e));
        }
        if (bars.length === 0) {
          return new CellError(ErrorType.NA, `STOCKHISTORY: no data for "${symbol}" in ${start}..${end}.`);
        }
        const cols =
          propsOpt === 1
            ? ['Date', 'Close']
            : propsOpt === 2
              ? ['Open', 'High', 'Low', 'Close', 'Volume']
              : ['Date', 'Open', 'High', 'Low', 'Close', 'Volume'];
        const rows: InterpreterValue[][] = bars.map((b) => {
          const all = [b.date, b.open, b.high, b.low, b.close, b.volume] as InterpreterValue[];
          if (propsOpt === 1) return [asVal(b.date), asVal(b.close)];
          if (propsOpt === 2) return all.slice(1);
          return all;
        });
        const out: InterpreterValue[][] = [];
        if (headersOpt === 2) out.push([asVal(symbol.toUpperCase())]);
        if (headersOpt !== 0) out.push(cols.map((c) => asVal(c)));
        out.push(...rows);
        return asVal(out);
      },
    );
  }

  public webservice(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('WEBSERVICE'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [urlArg] = args;
        if (urlArg instanceof CellError) return urlArg;
        const url = scalarText(urlArg ?? EmptyValue).trim();
        if (url === '') return new CellError(ErrorType.VALUE, 'WEBSERVICE requires a URL.');
        try {
          return defaultWebFetch(url).slice(0, MAX_WEBSERVICE_CHARS);
        } catch (e) {
          return new CellError(ErrorType.VALUE, e instanceof Error ? e.message : String(e));
        }
      },
    );
  }

  public rtd(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('RTD'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [progIdArg, serverArg, ...topicArgs] = args;
        if (progIdArg instanceof CellError) return progIdArg;
        if (serverArg instanceof CellError) return serverArg;
        const progId = scalarText(progIdArg ?? EmptyValue);
        const server = scalarText(serverArg ?? EmptyValue);
        const topics: string[] = [];
        for (const t of topicArgs) {
          if (t instanceof CellError) return t;
          if (t === EmptyValue) continue;
          topics.push(scalarText(t));
        }
        if (topics.length === 0) {
          return new CellError(ErrorType.VALUE, 'RTD requires at least one topic.');
        }
        const key = rtdTopicKey(progId, server, topics);
        const value = rtdBus.get(key);
        if (value === undefined) {
          return new CellError(
            ErrorType.NA,
            `RTD: no value published for topic "${topics.join(', ')}" yet. ` +
              `Hosts publish live values via publishRtdTopic().`,
          );
        }
        return value;
      },
    );
  }

  public copilot(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('COPILOT'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [promptArg, contextArg] = args;
        if (promptArg instanceof CellError) return promptArg;
        const prompt = scalarText(promptArg ?? EmptyValue);
        if (prompt.trim() === '') {
          return new CellError(ErrorType.VALUE, 'COPILOT requires a prompt. ' + COPILOT_USAGE);
        }
        const context =
          contextArg === undefined || contextArg === EmptyValue
            ? null
            : to2DArray(contextArg);
        const provider = copilotProvider ?? { ask: analyzeCopilot };
        try {
          return provider.ask(prompt, context);
        } catch (e) {
          return new CellError(ErrorType.VALUE, e instanceof Error ? e.message : String(e));
        }
      },
    );
  }

  public py(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('PY'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [codeArg, ...restArgs] = args;
        if (codeArg instanceof CellError) return codeArg;
        const code = scalarText(codeArg ?? EmptyValue);
        if (code.trim() === '') {
          return new CellError(ErrorType.VALUE, 'PY requires Python code.');
        }
        const pyArgs: unknown[] = [];
        for (const a of restArgs) {
          if (a instanceof CellError) return a;
          if (a === EmptyValue) {
            pyArgs.push(null);
            continue;
          }
          if (a instanceof SimpleRangeValue) {
            pyArgs.push(jsonable(asVal(to2DArray(asVal(a)))));
          } else {
            pyArgs.push(jsonable(a));
          }
        }
        const result = (pythonProvider ?? defaultPythonProvider).run(code, pyArgs);
        if ('error' in result) {
          return new CellError(ErrorType.NA, result.error);
        }
        // Plots-in-cells: a captured plot becomes the typed in-cell image
        // value (Excel semantics — the cell contains the image object).
        if (typeof result.plot === 'string' && result.plot.length > 0) {
          return pyPlotToImageValue(result.plot);
        }
        return jsonToInterpreter(result.value, { cells: 0 });
      },
    );
  }

  public call(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('CALL'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [refArg, ...restArgs] = args;
        if (refArg instanceof CellError) return refArg;
        const ref = scalarText(refArg ?? EmptyValue);
        const entry = lookupExternalFunction(ref);
        if (!entry) {
          return new CellError(
            ErrorType.VALUE,
            `CALL: no external function "${ref}". Register one with registerExternalFunction().`,
          );
        }
        const callArgs: Array<string | number | boolean | null> = [];
        for (const a of restArgs) {
          if (a instanceof CellError) return a;
          if (a === EmptyValue) {
            callArgs.push(null);
            continue;
          }
          if (typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean') {
            callArgs.push(a);
            continue;
          }
          return new CellError(ErrorType.VALUE, 'CALL arguments must be scalars (no ranges).');
        }
        try {
          const out = entry.fn(...callArgs);
          return scalarToInterpreter(out);
        } catch (e) {
          return new CellError(ErrorType.VALUE, `CALL "${entry.name}" failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    );
  }

  public registerId(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('REGISTER.ID'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [moduleArg, procedureArg] = args;
        if (moduleArg instanceof CellError) return moduleArg;
        if (procedureArg instanceof CellError) return procedureArg;
        const module = norm(scalarText(moduleArg ?? EmptyValue));
        const procedure = scalarText(procedureArg ?? EmptyValue).trim();
        // DLL modules cannot load in a browser/Electron host. The designed
        // replacement is the JavaScript function registry: REGISTER.ID
        // resolves a registered JS function name to its ID.
        if (module !== '' && module !== 'js' && module !== 'javascript') {
          return new CellError(
            ErrorType.VALUE,
            `REGISTER.ID: DLL module "${module}" cannot load in this host. ` +
              `Use the JavaScript registry: registerExternalFunction(name, fn), then REGISTER.ID("js", name).`,
          );
        }
        if (procedure === '') {
          return new CellError(ErrorType.VALUE, 'REGISTER.ID requires a procedure name.');
        }
        const entry = lookupExternalFunction(procedure);
        if (!entry) {
          return new CellError(
            ErrorType.VALUE,
            `REGISTER.ID: no external function "${procedure}". Register one with registerExternalFunction().`,
          );
        }
        return entry.id;
      },
    );
  }
}

/** Convert an InterpreterValue to a JSON-safe value for provider boundaries. */
function jsonable(v: InterpreterValue): unknown {
  if (v === EmptyValue) return null;
  if (v instanceof CellError) return { error: v.message ?? String(v.type) };
  if (v instanceof SimpleRangeValue) return jsonable(asVal(to2DArray(asVal(v))));
  if (Array.isArray(v)) return (v as unknown[]).map((x) => jsonable(x as InterpreterValue));
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  return v;
}

let registered = false;

/** Register STOCKHISTORY, WEBSERVICE, RTD, COPILOT, PY, CALL, REGISTER.ID. Idempotent. */
export function registerExtendedFunctions11(): void {
  if (registered || HyperFormula.getFunctionPlugin('STOCKHISTORY') !== undefined) {
    registered = true;
    return;
  }
  const names = {
    STOCKHISTORY: 'STOCKHISTORY',
    WEBSERVICE: 'WEBSERVICE',
    RTD: 'RTD',
    COPILOT: 'COPILOT',
    PY: 'PY',
    CALL: 'CALL',
    'REGISTER.ID': 'REGISTER.ID',
  };
  HyperFormula.registerFunctionPlugin(ExtendedFunctions11Plugin, { enGB: names, enUS: names });
  registered = true;
}