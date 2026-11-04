/**
 * Icecream Sheets MCP server (Phase 3).
 *
 * Owns a single EngineHost and exposes it over stdio as MCP tools. Every
 * tool response embeds `protocolVersion` (currently 1, matching
 * ENGINE_PROTOCOL_VERSION from @icecream-sheets/engine). Tool handlers never
 * throw: all failures are returned as structured `isError` results.
 *
 * Importing `./engine-plugin.js` registers the ICEEVAL() formula function
 * globally with HyperFormula before any engine instance is created.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// NOTE: StdioServerTransport (node-only) is imported dynamically inside
// runServer so browser bundlers can include this module.
import { z } from 'zod';
import {
  ENGINE_PROTOCOL_VERSION,
  Authorizer,
  EngineHost,
  TypedView,
  publishRtdTopic,
  type CellRef,
  type RangeRef,
  type TypedValue,
} from '@icecream-sheets/engine';
import {
  APP_SPEC_VERSION,
  createAppStore,
  createAsyncAppStore,
  createDataSourceStore,
  createAsyncDataSourceStore,
  createPivot,
  createReportStore,
  createAsyncReportStore,
  pivotToMatrix,
  recordsFromGrid,
  MetadataStore,
  memoryPersistence,
  createEncryptedPendingAskStore,
  parseApprovalAnswer,
  toPendingAskView,
  DEFAULT_HITL_TIMEOUT_MS,
  KeyManager,
  AsyncMetadataStore,
  PendingAskStore,
  migrateAppSpec,
  migrateReportSpec,
  validateAppSpec,
  TemplatePythonGenerator,
  a1Ref,
  a1RangeString,
  classifyAnalysisIntent,
  createAnalysisPort,
  createAnalysisStore,
  createAsyncAnalysisStore,
  executeAnalysis,
  extractDataSchema,
  hashInput,
  makeArtifact,
  makeChartSpec,
  analysisSummary,
  parseA1Range,
  registerIntentPorts,
  type AnalysisArtifact,
  type AnalysisInput,
  type AnalysisPlan,
  type AnalysisValue,
  type AppSpec,
  toAsyncPersistence,
  type AsyncPersistence,
  type ChartSpec,
  type ChartRange,
  type Persistence,
  type PivotAggregation,
  type PivotResult,
  type PivotSpec,
  type PythonRunner,
  type ReportSpec,
  type CellInput as AnalysisCellInput,
  type RangeRef as AnalysisRangeRef,
  forceTextColumn,
  transposeHorizontalYearGrid,
  validateReportSpec,
} from '@icecream-sheets/service';
import {
  applyRefreshPlanToHost,
  bindingForOpen,
  CONNECTOR_SPEC_VERSION,
  createConnectorRegistry,
  planSheetRefresh,
  sanitizeSheetName,
  uniqueSheetName,
  writeTableToNewSheet,
  type ConnectorDeps,
  type ConnectorKind,
  type ConnectorSpec,
  type CredentialResolver,
  type FetchText,
  type SqlDriver,
} from '@icecream-sheets/service/connectors';
import './engine-plugin.js';
// NOTE: sandbox modules (node:vm / node:child_process) are imported
// dynamically inside the execute_code handler so browser bundlers (vite)
// never see node builtins in the static import graph. The stdio production
// path is unaffected.
import { SubscriptionManager, isSubscriptionEventType } from './subscriptions.js';
import { MemoryStore } from './memory.js';
import { manifestOf, packsFromEnv, resolveSkillPacks } from './packs/index.js';
import type { PackContext } from './packs/types.js';

export const SERVER_NAME = 'icecream-sheets';
export const SERVER_VERSION = '0.1.0';

/**
 * Fallback principal for UNBOUND servers (no verified session
 * identity): anonymous stdio/local use, always audit-logged as such.
 * Bound servers (ServerOptions.defaultPrincipal) never reach this
 * fallback — the verified session identity is authoritative there and
 * a `principal` tool argument may only match it (F-10).
 */
const MCP_PRINCIPAL = 'mcp-client';

/** Optional per-tool identity (permission-model.md §5: JWT carries identity). */
const principalSchema = z.string().min(1).max(200).optional();

/** Hard cap on cells returned by read_cells (abuse guard). */
const MAX_READ_CELLS = 100_000;

const jsonValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const cellRefSchema = z.object({
  sheet: z.string().min(1),
  row: z.number().int().min(0),
  col: z.number().int().min(0),
});

type ToolText = { type: 'text'; text: string };
type ToolResult = { content: ToolText[]; isError?: boolean };

function okResult(payload: Record<string, unknown>): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ protocolVersion: ENGINE_PROTOCOL_VERSION, ok: true, ...payload }),
      },
    ],
  };
}

function errorResult(message: string): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          protocolVersion: ENGINE_PROTOCOL_VERSION,
          ok: false,
          error: message,
        }),
      },
    ],
    isError: true,
  };
}

function toJsonMatrix(values: TypedValue[][]): unknown[][] {
  return values.map((row) => row.map((v) => TypedView.toJson(v)));
}

export interface DataSourceServerOptions {
  /**
   * Fetch URL text for url-based connectors. Defaults to globalThis.fetch
   * (node 20+). Inject a fake in tests.
   */
  fetchText?: FetchText;
  /**
   * Resolves spec credentialRef → secret (service vault seam). When absent,
   * specs carrying a credentialRef fail closed with a clear error.
   */
  resolveCredential?: CredentialResolver;
  /** SQL driver for the 'sql' connector kind (no driver ships by default). */
  sqlDriver?: SqlDriver;
  /** Safety cap on materialized rows per fetch. Defaults to 100_000. */
  maxRows?: number;
}

/**
 * FIX-G chart sink seam (trace §4.1a), mirroring the DataSource
 * sqlDriver pattern: an optional injected capability that delivers a
 * built ChartSpec to the workbook SESSION (the engine service's
 * POST /charts). The MCP server itself owns no session — when no sink
 * is wired, create_chart fails closed with an honest error.
 */
export interface ChartSink {
  addChart(spec: ChartSpec, principal: string): Promise<{ id: number | string; revision: number }>;
}

export interface ServerOptions {
  /** Native-chart creation sink (FIX-G). Absent → create_chart fails closed. */
  charts?: ChartSink;
  /** Persistence for service metadata (pivot specs, agent memory, pending asks). Defaults to in-memory. */
  persistence?: Persistence;
  /**
   * Native async persistence for service metadata (durable-store migration).
   * When provided it is used directly for every metadata store; otherwise
   * `persistence` is bridged via toAsyncPersistence. The Firestore-backed
   * adapter (FirestoreMetadataPersistence) is injected here in prod.
   */
  asyncPersistence?: AsyncPersistence;
  /**
   * Shared human-in-the-loop pending-ask store (ai-agent.md §12). Inject
   * one to share pauses across server instances in a process; otherwise a
   * store is created over `persistence`.
   */
  pendingAsks?: PendingAskStore;
  /**
   * KeyManager for the at-rest encryption of the default pending-ask
   * store. When absent, one is created over `persistence` (key records
   * live in the same metadata store, so two servers over one persistence
   * share keys and pending asks survive restarts). Ignored when
   * `pendingAsks` is injected.
   */
  keys?: KeyManager;
  /**
   * How long agent.ask_question / agent.offer_options /
   * agent.request_approval wait for the human's answer before returning a
   * timeout error. Defaults to DEFAULT_HITL_TIMEOUT_MS (10 minutes).
   * Never hangs forever. MCP clients calling these tools must use a
   * request timeout larger than this (the SDK defaults to 60s).
   */
  hitlTimeoutMs?: number;
  /** Wiring for the connected-data-source tools. Defaults to anonymous fetch. */
  dataSources?: DataSourceServerOptions;
  /**
   * Skill packs to install, by pack id (e.g. 'data-cleaning',
   * 'financial-modeling', 'survey-analysis'). Undefined → every
   * bundled pack is installed. Unknown ids throw at construction
   * (fail closed). See src/packs/ and packs/README.md (install guide).
   */
  packs?: string[];
  /**
   * The session's BOUND identity (F-10): set by the embedding layer from
   * a VERIFIED identity — the Streamable-HTTP layer from the session's
   * Bearer <redacted>, the agent service from the authenticated caller.
   * When set, it is AUTHORITATIVE: a tool call's `principal` argument
   * must MATCH it (or be absent, in which case the bound identity
   * applies); a mismatching argument is refused, because a caller-
   * asserted principal must never widen beyond the verified session
   * identity. When unset (stdio / local embedding, where the process
   * itself is the trust boundary), callers assert their principal per
   * call and the fallback is 'mcp-client'.
   */
  defaultPrincipal?: string;
  /**
   * Trusted local embeddings only: allow a tool call's `principal`
   * argument to override even a bound `defaultPrincipal`. The HTTP
   * layer sets this ONLY for anonymous local-dev sessions
   * (requireAuth=false); authenticated sessions never get it. Default
   * false.
   */
  allowPrincipalAssertion?: boolean;
  /**
   * Web research provider (Tavily/Brave) — service-boundary only.
   * When absent, search_web/fetch_web_page fail closed with a config
   * message (never ambient fetch).
   */
  webResearch?: {
    provider: {
      name: string;
      search(req: { query: string; maxResults?: number }): Promise<{
        results: { title: string; url: string; snippet: string; score?: number }[];
        provider: string;
      }>;
      fetchPage(req: { url: string; maxChars?: number }): Promise<{
        url: string;
        finalUrl: string;
        status: number;
        contentType: string;
        text: string;
        truncated: boolean;
      }>;
    } | null;
  } | null;
}

/**
 * Default KeyManagers, one per persistence adapter. Two servers over the
 * same persistence MUST share key records: each KeyManager.save() writes a
 * full snapshot of its in-memory records, so two managers generating the
 * service-scope key concurrently would clobber each other's records and
 * render the other's ciphertext undecryptable. WeakMap so adapters can be
 * garbage-collected with their servers.
 */
const defaultKeyManagers = new WeakMap<Persistence, KeyManager>();

function defaultKeyManager(persistence: Persistence): KeyManager {
  let km = defaultKeyManagers.get(persistence);
  if (!km) {
    km = new KeyManager(persistence);
    defaultKeyManagers.set(persistence, km);
  }
  return km;
}

export function createServer(host?: EngineHost, options?: ServerOptions): McpServer {
  const engine = host ?? new EngineHost();
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  /**
   * Resolve the acting principal for a tool call (F-10 identity model).
   * A bound session identity (options.defaultPrincipal, set from a
   * VERIFIED identity by the embedding layer) is authoritative: an
   * absent argument acts as the bound identity, a matching argument is
   * accepted, and a MISMATCHING argument throws — a caller-asserted
   * principal may never substitute for (widen beyond) the session
   * identity. Only a trusted local embedding that explicitly sets
   * allowPrincipalAssertion, or an UNBOUND server (stdio/local, where
   * the process is the trust boundary), honors asserted principals.
   */
  const boundPrincipal = options?.defaultPrincipal?.trim() || undefined;
  const allowPrincipalAssertion = options?.allowPrincipalAssertion === true;
  function principalOf(args: { principal?: string }): { principal: string } {
    const asserted = args.principal;
    if (boundPrincipal !== undefined && !allowPrincipalAssertion) {
      if (asserted !== undefined && asserted !== boundPrincipal) {
        throw new Error(
          `principal mismatch: the tool argument principal "${asserted}" does not match the session identity "${boundPrincipal}" — the verified session identity is authoritative`,
        );
      }
      return { principal: boundPrincipal };
    }
    return { principal: asserted ?? boundPrincipal ?? MCP_PRINCIPAL };
  }

  /**
   * Sheet-ensuring for the write tools (#63): writing to a sheet that
   * does not exist yet CREATES it — the behavior the table/data-source
   * writes have always had (writeTableToNewSheet runs addSheet first).
   * The addSheet command goes through execute() with the caller's own
   * auth, so authorize() decides exactly as it does for the writes
   * themselves: a principal denied 'sheet.add' gets that denial back as
   * the per-sheet error below, and every cell write still passes its own
   * 'cell.write' authorization. Returns sheet name -> error for sheets
   * that could not be ensured (a sheet absent from the map exists and
   * its writes may proceed).
   */
  async function ensureSheetsExist(
    refs: readonly CellRef[],
    auth: { principal: string },
  ): Promise<Map<string, string>> {
    const failures = new Map<string, string>();
    const wanted = [...new Set(refs.map((r) => r.sheet))];
    if (wanted.length === 0) return failures;
    const existing = new Set((await engine.snapshot()).sheets.map((s) => s.name));
    for (const name of wanted) {
      if (existing.has(name)) continue;
      const added = await engine.execute({ cmd: 'addSheet', name, auth });
      if (!added.ok) failures.set(name, added.error);
    }
    return failures;
  }

  /**
   * PivotTable store (native reports design): versioned, serializable specs
   * plus their source bindings. Specs live in the SERVICE METADATA STORE —
   * the single metadata authority — not in server-local state. The pivot
   * component itself only ever sees plain records read through the typed
   * view. Computed results are cached in memory; specs+bindings persist.
   */
  interface PivotBinding {
    name: string;
    spec: PivotSpec;
    source: { sheet: string; startRow: number; startCol: number; endRow: number; endCol: number };
  }
  interface PivotEntry extends PivotBinding {
    result: PivotResult;
  }
  /**
   * Single async persistence for ALL service metadata stores (durable-store
   * migration). A natively-async adapter (e.g. Firestore) injected via
   * options.asyncPersistence is used directly; otherwise the sync
   * options.persistence is bridged. Every store below shares this so a
   * prod deployment has exactly one durability story.
   */
  const metadataAsyncPersistence: AsyncPersistence =
    options?.asyncPersistence ?? toAsyncPersistence(options?.persistence ?? memoryPersistence());
  const pivotStore = new AsyncMetadataStore<PivotBinding>(
    'icecream-sheets.mcp.pivots.v1',
    metadataAsyncPersistence,
    (items) => JSON.stringify({ version: 1, pivots: items }),
    (json) => {
      try {
        const p = JSON.parse(json) as { pivots?: PivotBinding[] };
        return Array.isArray(p.pivots) ? p.pivots : [];
      } catch {
        return [];
      }
    },
  );
  /** Name -> computed result cache (recomputed on refresh / on demand). */
  const pivotResults = new Map<string, PivotResult>();
  let pivotSeq = 1;
  const getPivotBinding = async (name: string): Promise<PivotBinding | undefined> =>
    (await pivotStore.all()).find((p) => p.name === name);

  /**
   * Event subscriptions (track 28): engine events buffered per subscription,
   * drained via poll_events. This is what the AI Agent's proactive
   * subscriptions ride on (ai-agent.md §6).
   */
  const subscriptions = new SubscriptionManager();
  subscriptions.attach(engine);

  /** Agent long-term memory (ai-agent.md §12): per-user, service metadata store. */
  const memory = new MemoryStore(metadataAsyncPersistence);

  /**
   * Human-in-the-loop (ai-agent.md §12): when the agent needs the user it
   * calls a tool — asking a question, offering options, or requesting
   * approval. The tool call PAUSES the agent: the handler blocks until
   * agent.answer_pending delivers the human's answer (or the wait times
   * out — it never hangs forever). JSON-RPC allows delayed tool
   * responses, so this does not deadlock the server. Pauses live in the
   * single shared PendingAskStore (service metadata store backed,
   * principal-scoped); the agent runtime reaches the same store only
   * through these versioned tools — there is no parallel implementation.
   */
  /**
   * Human-in-the-loop store, encrypted at rest (§3). The store build is
   * async (WebCrypto key generation) but createServer stays synchronous:
   * every HITL handler awaits this promise before touching the store. An
   * injected store is used as-is. The default KeyManager is shared per
   * persistence adapter (see defaultKeyManager).
   */
  const storePersistence: Persistence = options?.persistence ?? memoryPersistence();
  const pendingAsksReady: Promise<PendingAskStore> = options?.pendingAsks
    ? Promise.resolve(options.pendingAsks)
    : createEncryptedPendingAskStore(
        storePersistence,
        options?.keys ?? defaultKeyManager(storePersistence),
      );
  const hitlTimeoutMs =
    options?.hitlTimeoutMs && options.hitlTimeoutMs > 0
      ? options.hitlTimeoutMs
      : DEFAULT_HITL_TIMEOUT_MS;

  const PIVOT_VERSION = 1 as const;
  const aggregationSchema = z.enum([
    'sum', 'count', 'average', 'max', 'min', 'product', 'countnums', 'stdev', 'var',
  ]);

  function readPivotRecords(
    source: PivotEntry['source'],
    auth: { principal: string },
  ): {
    headers: string[];
    records: Record<string, unknown>[];
  } {
    // Authorized read: hidden/denied cells surface as #PERM! and are
    // excluded from pivot records (values never leak into aggregations).
    const grid: unknown[][] = engine
      .readRange(source, auth)
      .map((row) =>
        row.map((v) => {
          if (v.kind === 'error' && v.code === '#PERM!') return null;
          return TypedView.toJson(v);
        }),
      );
    while (grid.length > 0 && grid[grid.length - 1]?.every((v) => v === null)) grid.pop();
    if (grid.length < 2) {
      throw new Error('pivot source needs a header row and at least one data row');
    }
    const headers = (grid[0] ?? []).map((h, i) =>
      h === null || h === undefined || h === '' ? `Column ${i + 1}` : String(h),
    );
    const records = recordsFromGrid(headers, grid.slice(1)).map((rec) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rec)) {
        out[k] = typeof v === 'object' && v !== null && 'error' in v
          ? String((v as { error: string }).error)
          : v;
      }
      return out;
    });
    return { headers, records };
  }

  function pivotSummary(entry: PivotEntry): Record<string, unknown> {
    return {
      name: entry.name,
      rows: entry.result.rowKeys.length,
      columns: entry.result.colKeys.length,
      valueLabels: entry.result.valueLabels,
      sourceRows: entry.result.sourceRowCount,
      filteredRows: entry.result.filteredRowCount,
      grandTotals: entry.result.grandTotals,
    };
  }

  server.tool(
    'read_cells',
    'Read a rectangular range of computed cell values. Reads go through authorize(): cells the principal cannot read come back as #PERM! errors, never leaked values.',
    {
      sheet: z.string().min(1),
      startRow: z.number().int().min(0),
      startCol: z.number().int().min(0),
      endRow: z.number().int().min(0),
      endCol: z.number().int().min(0),
      principal: principalSchema,
    },
    async (args): Promise<ToolResult> => {
      try {
        if (args.endRow < args.startRow || args.endCol < args.startCol) {
          return errorResult('endRow/endCol must be >= startRow/startCol');
        }
        const count = (args.endRow - args.startRow + 1) * (args.endCol - args.startCol + 1);
        if (count > MAX_READ_CELLS) {
          // FIX-R4: an over-large request almost always means "read the
          // data" — the planner guessed the whole grid (the observed
          // failure was a 1,002,001-cell request for a 39-cell sheet,
          // whose hard failure derailed the whole turn). Clamp to the
          // sheet's used range and return the real data with the
          // effective range, so the caller's intent is served and the
          // turn survives. Only when the used range itself exceeds the
          // cap does the call fail — with the used bounds named, so a
          // chunked retry can be planned exactly.
          // getUsedRange is synchronous on the local host and async on
          // forwarding hosts — the try/await covers both, and any
          // failure (e.g. unknown sheet) degrades to the plain error.
          let used: { startRow: number; startCol: number; endRow: number; endCol: number } | null =
            null;
          try {
            used = await engine.getUsedRange(args.sheet);
          } catch {
            used = null;
          }
          if (used) {
            const clamped = {
              sheet: args.sheet,
              startRow: Math.max(args.startRow, used.startRow),
              startCol: Math.max(args.startCol, used.startCol),
              endRow: Math.min(args.endRow, used.endRow),
              endCol: Math.min(args.endCol, used.endCol),
            };
            const clampedCount =
              (clamped.endRow - clamped.startRow + 1) * (clamped.endCol - clamped.startCol + 1);
            if (
              clamped.endRow >= clamped.startRow &&
              clamped.endCol >= clamped.startCol &&
              clampedCount <= MAX_READ_CELLS
            ) {
              const values = await engine.readRange(clamped, principalOf(args));
              return okResult({
                cells: toJsonMatrix(values),
                clampedToUsedRange: true,
                effectiveRange: clamped,
              });
            }
            return errorResult(
              `range too large: ${count} cells (max ${MAX_READ_CELLS}); the sheet's used range is rows ${used.startRow}..${used.endRow}, cols ${used.startCol}..${used.endCol} — read it in chunks of at most ${MAX_READ_CELLS} cells`,
            );
          }
          return errorResult(`range too large: ${count} cells (max ${MAX_READ_CELLS})`);
        }
        // Awaited: the host may be an IPC-forwarding host (desktop MCP
        // parity) whose reads resolve asynchronously.
        const values = await engine.readRange(
          {
            sheet: args.sheet,
            startRow: args.startRow,
            startCol: args.startCol,
            endRow: args.endRow,
            endCol: args.endCol,
          },
          principalOf(args),
        );
        return okResult({ cells: toJsonMatrix(values) });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // FIX-G (trace §4.1a): native chart creation. The tool validates the
  // range against the bound host, builds the ChartSpec, and delivers
  // it through the injected ChartSink (ServerOptions.charts). Absent
  // sink → FAIL CLOSED: this server owns no workbook session, so there
  // is nowhere honest to put a native chart.
  let chartSeq = 0;
  const CHART_KIND_MAP = {
    column: 'column-clustered',
    bar: 'bar-clustered',
    line: 'line',
    area: 'area',
    pie: 'pie',
    doughnut: 'doughnut',
  } as const;
  server.tool(
    'create_chart',
    'Create a NATIVE chart in the sheet, bound to sheet data: the chart is inserted into the workbook itself, is visible in the grid, persists, and saves with the file. For schema-mapped charts prefer the 0-based bounds "startRow"/"startCol"/"endRow"/"endCol" (all-or-none, SAME 0-based absolute frame as describe_sheet/read_cells). "range" is kept for backward compatibility: a 1-based A1 string (A1 = row 0) that INCLUDES the header row; never copy 0-based row numbers into it. When both are given, the bounds win. The first column holds category labels and each remaining numeric column becomes a series. HORIZONTAL layouts are supported too: when the range\'s first row holds a year sequence (e.g. 2012-2021 across columns) with measure rows below, the year cells become the categories and each measure row becomes a series — pass the dimension row plus the measure rows (e.g. bounds startRow 5, endRow 6 for years row 5 + Revenue row 6, or "A6:K7" in 1-based A1). "kind" is one of column|bar|line|area|pie|doughnut (fail-closed: any other kind is rejected). "anchor" is an optional A1 cell for the chart\'s top-left placement; default is below the data range. This is NOT analyze_data (which only shows an ephemeral chart in chat).',
    {
      sheet: z.string().min(1),
      range: z.string().min(1).max(50).optional(),
      startRow: z.number().int().min(0).optional(),
      startCol: z.number().int().min(0).optional(),
      endRow: z.number().int().min(0).optional(),
      endCol: z.number().int().min(0).optional(),
      kind: z.enum(['column', 'bar', 'line', 'area', 'pie', 'doughnut']),
      title: z.string().min(1).max(200).optional(),
      anchor: z.string().min(1).max(20).optional(),
      principal: principalSchema,
    },
    async (args): Promise<ToolResult> => {
      try {
        // Round-4 tool-args capture: every create_chart invocation is
        // logged (stderr -> the service log in-process, Cloud Logging
        // in the deployed MCP service) so a proof worker can recover
        // the EXACT input form of any chart that lands — the
        // combined-proof leg-B bypass was never recovered because no
        // args were logged anywhere. One line per call, before any
        // validation, so refusals are captured too; the audit order
        // correlates each line with its tool result.
        console.error(
          `[mcp:create_chart] ${JSON.stringify({
            sheet: args.sheet,
            range: args.range ?? null,
            bounds:
              args.startRow !== undefined
                ? {
                    startRow: args.startRow,
                    startCol: args.startCol,
                    endRow: args.endRow,
                    endCol: args.endCol,
                  }
                : null,
            kind: args.kind,
            title: args.title ?? null,
            anchor: args.anchor ?? null,
          })}`,
        );
        const { principal } = principalOf(args);
        const sink = options?.charts;
        if (!sink) {
          return errorResult('chart creation is not available in this session');
        }
        // Chart-range frame (2026-10-26): the planner reasons in 0-based
        // absolute rows (describe_sheet coordinateFrame), but A1 is
        // 1-based — reproof 3 emitted 0-based rows 5/6 as "A5:K6" and
        // charted years as values. Bounds below let the planner pass
        // the SAME 0-based numbers it already has; no +1 conversion
        // is ever required of the model. A1 stays for compatibility
        // and keeps its 1-based meaning (old inputs are NOT reinterpreted).
        const boundsComplete =
          args.startRow !== undefined &&
          args.startCol !== undefined &&
          args.endRow !== undefined &&
          args.endCol !== undefined;
        let range: ChartRange | null = null;
        let effectiveRange: string;
        if (boundsComplete) {
          if (args.endRow! < args.startRow! || args.endCol! < args.startCol!) {
            return errorResult(
              `invalid 0-based chart bounds startRow ${args.startRow} startCol ${args.startCol} endRow ${args.endRow} endCol ${args.endCol} (end must not precede start)`,
            );
          }
          range = {
            sheet: args.sheet,
            startRow: args.startRow!,
            startCol: args.startCol!,
            endRow: args.endRow!,
            endCol: args.endCol!,
          };
          effectiveRange = a1RangeString(range);
        } else if (args.range !== undefined) {
          range = parseA1Range(args.range, args.sheet);
          if (!range) return errorResult(`invalid A1 range "${args.range}"`);
          effectiveRange = args.range;
        } else {
          return errorResult(
            'create_chart needs either "range" (A1) or all four 0-based bounds startRow/startCol/endRow/endCol',
          );
        }
        // W1 (first-turn sheet-context failure): a forwarding host
        // (the gateway's NodeRemoteEngineHost) serves the SYNC
        // sheetNames() from a cache that starts EMPTY on a fresh
        // session binding and warms only via a background fetch —
        // awaiting that sync [] made the FIRST create_chart of every
        // fresh session report `unknown sheet "…"` for a sheet the
        // session provably held (and a warmed cache likewise misses
        // grid-side renames/adds). Such hosts expose sheetNamesAsync()
        // — an awaited, fresh read of the engine's sheet list. Prefer
        // it whenever the bound host offers it, and treat its result
        // as authoritative; plain local hosts keep the sync list.
        const asyncNames = (engine as { sheetNamesAsync?: unknown }).sheetNamesAsync;
        const sheetNames =
          typeof asyncNames === 'function'
            ? await (asyncNames as () => Promise<string[]>).call(engine)
            : await engine.sheetNames();
        if (!sheetNames.includes(args.sheet)) {
          return errorResult(`unknown sheet "${args.sheet}"`);
        }
        // Validation reads go through authorize() exactly like
        // read_cells: #PERM! cells are excluded, never leaked, and
        // never count as chartable data.
        const values = await engine.readRange(range, { principal });
        if (values.length < 2) {
          return errorResult('range must include a header row and at least one data row');
        }
        const isPerm = (v: TypedValue | undefined): boolean =>
          !!v && v.kind === 'error' && v.code === '#PERM!';
        const header = values[0] ?? [];
        const dataRows = values.slice(1);
        // Horizontal-layout support (follow-up 2026-10-26): when the
        // range's first row holds a year sequence — strict rule
        // mirrored from analysis/horizontal.ts (>=3 adjacent
        // consecutive +1 integers in 1900..2100, numbers or integer
        // strings) — and at least one row below holds numerics under
        // that run, the range is horizontal: the year cells are the
        // categories and each measure row below is a series
        // (transposed internally). Horizontal takes precedence over
        // the vertical reading: reading a year row as the header
        // would make each year-column a series — the #157
        // years-as-values mode. The horizontal.ts label requirement
        // is NOT reused here: chart ranges often start at the
        // dimension row itself, so a missing row label falls back to
        // "Series N" instead of failing detection. Fail-closed is
        // preserved: a year row with no numeric measure row refuses.
        const yearOfCell = (v: TypedValue | undefined): number | null => {
          if (!v || isPerm(v)) return null;
          if (
            v.kind === 'number' &&
            typeof v.value === 'number' &&
            Number.isInteger(v.value) &&
            v.value >= 1900 &&
            v.value <= 2100
          ) {
            return v.value;
          }
          if (v.kind === 'string' && typeof v.value === 'string') {
            const t = v.value.trim();
            if (/^-?\d+$/.test(t)) {
              const n = parseInt(t, 10);
              if (n >= 1900 && n <= 2100) return n;
            }
          }
          return null;
        };
        // Strict year-sequence scan (shared by the horizontal branch
        // and the round-2 trap guard): >=3 adjacent consecutive +1
        // integers in 1900..2100, numbers or integer strings.
        const findYearRun = (row: (TypedValue | undefined)[]): { start: number; end: number } | null => {
          let best: { start: number; end: number } | null = null;
          let runStart: number | null = null;
          let prev: number | null = null;
          for (let i = 0; i <= row.length; i++) {
            const y = i < row.length ? yearOfCell(row[i]) : null;
            if (y !== null && prev !== null && y === prev + 1) {
              // Run continues.
            } else {
              if (runStart !== null && prev !== null) {
                const end = i - 1;
                if (
                  end - runStart + 1 >= 3 &&
                  (best === null || end - runStart > best.end - best.start)
                ) {
                  best = { start: runStart, end };
                }
              }
              runStart = y !== null ? i : null;
            }
            prev = y;
          }
          return best;
        };
        const yearRun = findYearRun(header);
        // Round-2 trap guard, round-4 hardened: a year sequence
        // sitting in a NON-first row of the range would be plotted as
        // VALUES by the vertical fallback below (the #157 / leg-B
        // trap: "A5:K6" and "B5:K6" are a label row + the years row,
        // so the years render as ~2,012-tall bars). A legitimate
        // horizontal chart always puts the year row FIRST (handled
        // above); a year run below the first row is a frame error,
        // refused here with the correction instead of landing a wrong
        // chart. Round-4: the original guard only scanned data rows
        // when the first row carried a label in the range's columns —
        // and that condition WAS the combined-proof bypass. A range
        // whose first row has no labels in its columns (C5:K6 drops
        // the 'Year' label column; A5:K6 over a label-less seed has
        // an empty first row) skipped the guard and fell to vertical,
        // plotting the years row as single-value 'Series N' series.
        // The label condition is therefore gone: a year run in a
        // non-first row can never be correct categories (horizontal
        // needs it first; vertical needs years in a COLUMN, not a row
        // run), so the guard fires unconditionally. The only shape
        // lost is the empty-header window the old parsing test
        // blessed — itself the trap shape. Values-based, so it covers
        // both the A1 string and the bounds path, and it cannot fire
        // on vertical layouts (years in a column are not a horizontal
        // run across a row).
        if (!yearRun) {
          for (let ri = 0; ri < dataRows.length; ri++) {
            const trap = findYearRun(dataRows[ri]!);
            if (trap) {
              const absRow = range.startRow + 1 + ri;
              const firstYear = yearOfCell(dataRows[ri]![trap.start]);
              const lastYear = yearOfCell(dataRows[ri]![trap.end]);
              // Fix (A) (leg B): name the corrected call VERBATIM in
              // the refusal, computed from the FAILED args (never
              // hardcoded): shift the range so its first row is the
              // year row and its first column is the label column
              // (col 0), preserving the row span and the last column
              // — e.g. failed B5:K6 -> A6:K7 + bounds {5,0,6,10}.
              // The old refusal gave only relative recipes and
              // reproduced the failed call's own row tokens, so the
              // model repeated the refused range (leg-r5-b: 29x
              // B5:K6 + 1x F5:O6) instead of issuing the corrected
              // one. The refusal stays a refusal: the corrected call
              // is text only, never issued here.
              const corrStartRow = absRow;
              const corrEndRow = absRow + (range.endRow - range.startRow);
              const corrRange = {
                sheet: range.sheet,
                startRow: corrStartRow,
                startCol: 0,
                endRow: corrEndRow,
                endCol: range.endCol,
              };
              return errorResult(
                `refusing to chart range ${effectiveRange}: row ${absRow} (1-based row ${absRow + 1}) holds a year sequence ${firstYear}-${lastYear} but is not the range's first row, so those years would be plotted as values; use range ${a1RangeString(corrRange)} instead (0-based bounds startRow ${corrStartRow}, startCol 0, endRow ${corrEndRow}, endCol ${range.endCol})`,
              );
            }
          }
        }
        const seriesRanges: ChartSpec['seriesRanges'] = [];
        if (yearRun) {
          const catStartCol = range.startCol + yearRun.start;
          const catEndCol = range.startCol + yearRun.end;
          for (let i = 0; i < dataRows.length; i++) {
            const row = dataRows[i]!;
            let hasNumeric = false;
            for (let ci = yearRun.start; ci <= yearRun.end; ci++) {
              const v = row[ci];
              if (!!v && !isPerm(v) && v.kind === 'number') {
                hasNumeric = true;
                break;
              }
            }
            if (!hasNumeric) continue;
            const labelCell = row[0];
            const labelJson =
              labelCell && !isPerm(labelCell) ? TypedView.toJson(labelCell) : null;
            const name =
              typeof labelJson === 'string' && labelJson.trim() !== ''
                ? labelJson
                : `Series ${seriesRanges.length + 1}`;
            seriesRanges.push({
              name,
              cat: {
                sheet: args.sheet,
                startRow: range.startRow,
                startCol: catStartCol,
                endRow: range.startRow,
                endCol: catEndCol,
              },
              val: {
                sheet: args.sheet,
                startRow: range.startRow + 1 + i,
                startCol: catStartCol,
                endRow: range.startRow + 1 + i,
                endCol: catEndCol,
              },
            });
          }
          if (seriesRanges.length === 0) {
            return errorResult(
              `range ${effectiveRange} has a year row but no numeric measure row to chart (refusing to invent a chart over empty data)`,
            );
          }
        } else {
          for (let c = range.startCol + 1; c <= range.endCol; c++) {
            const colIdx = c - range.startCol;
            const hasNumeric = dataRows.some((row) => {
              const v = row[colIdx];
              return !!v && !isPerm(v) && v.kind === 'number';
            });
            if (!hasNumeric) continue;
            const headerCell = header[colIdx];
            const headerJson = headerCell && !isPerm(headerCell) ? TypedView.toJson(headerCell) : null;
            const name =
              typeof headerJson === 'string' && headerJson.trim() !== ''
                ? headerJson
                : `Series ${seriesRanges.length + 1}`;
            seriesRanges.push({
              name,
              cat: {
                sheet: args.sheet,
                startRow: range.startRow + 1,
                startCol: range.startCol,
                endRow: range.endRow,
                endCol: range.startCol,
              },
              val: {
                sheet: args.sheet,
                startRow: range.startRow + 1,
                startCol: c,
                endRow: range.endRow,
                endCol: c,
              },
            });
          }
        }
        if (seriesRanges.length === 0) {
          return errorResult(
            `range ${effectiveRange} has no numeric data column to chart (refusing to invent a chart over empty data)`,
          );
        }
        // Anchor: explicit A1 cell, else below the data range; the
        // authored size is fixed at 8 cols × 15 rows (trace §4.1a).
        let fromCol = range.startCol;
        let fromRow = range.endRow + 2;
        if (args.anchor) {
          const anchorRange = parseA1Range(args.anchor, args.sheet);
          if (!anchorRange) return errorResult(`invalid anchor cell "${args.anchor}"`);
          fromCol = anchorRange.startCol;
          fromRow = anchorRange.startRow;
        }
        const spec = makeChartSpec({
          id: Date.now() * 1000 + chartSeq++,
          kind: CHART_KIND_MAP[args.kind],
          title: args.title,
          range,
          seriesRanges,
          anchorCells: { fromCol, fromRow, toCol: fromCol + 8, toRow: fromRow + 15 },
          x: fromCol * 64,
          y: fromRow * 20,
          w: 512,
          h: 300,
          nativePart: true,
        });
        const out = await sink.addChart(spec, principal);
        return okResult({
          chartId: out.id,
          revision: out.revision,
          kind: spec.kind,
          title: spec.title,
          sheet: args.sheet,
          range: effectiveRange,
        });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // Planner-fix round 2 (2026-10-22): far-write guard. Observed live:
  // asked to append a TOTAL row "directly below the data" of a 13-row
  // sheet, the planner wrote it at row 100000 (anchored on its own
  // oversized read request, not the clamped effective range). The write
  // reported success, landed nowhere near the data, and EXTENDED the
  // sheet's used range to row 100000 — which then broke the read clamp
  // for every later turn (the used range itself exceeded the read cap).
  // A write more than FAR_WRITE_SLACK rows/cols beyond the used range
  // is rejected with the used bounds (and the append row) named, so the
  // caller can correct mechanically. Legitimate staging within the
  // slack is unaffected; human grid edits do not pass through here.
  const FAR_WRITE_SLACK = 1024;
  const farWriteError = async (
    targets: readonly { sheet: string; row: number; col: number }[],
  ): Promise<string | null> => {
    const sheets = new Map<string, { row: number; col: number }[]>();
    for (const t of targets) {
      const arr = sheets.get(t.sheet) ?? [];
      arr.push(t);
      sheets.set(t.sheet, arr);
    }
    for (const [sheet, cells] of sheets) {
      let used: { startRow: number; startCol: number; endRow: number; endCol: number } | null =
        null;
      try {
        used = await engine.getUsedRange(sheet);
      } catch {
        used = null;
      }
      if (!used) continue;
      for (const c of cells) {
        if (c.row > used.endRow + FAR_WRITE_SLACK || c.col > used.endCol + FAR_WRITE_SLACK) {
          return (
            `write target ${sheet}!R${c.row}C${c.col} is far outside the sheet's used range ` +
            `(rows ${used.startRow}..${used.endRow}, cols ${used.startCol}..${used.endCol}); ` +
            `writing there would strand the value away from the data. To append directly below ` +
            `the data, write at row ${used.endRow + 1}; otherwise locate the exact target cell ` +
            `with read_cells first.`
          );
        }
      }
    }
    return null;
  };

  // Planner-fix round 2: post-write row-context echo. Observed live:
  // the planner wrote a content-addressed value ("Jun South") to the
  // WRONG row inside the used range (row 3, twice, deterministically)
  // and reported success — nothing in the result contradicted it.
  // Echoing the full contents of each written row lets the caller
  // verify the placement against the request ("does this row's label
  // match the row I was asked to change?") and correct it in-turn.
  const rowContext = async (
    refs: readonly CellRef[],
  ): Promise<{ sheet: string; row: number; values: unknown[] }[]> => {
    const out: { sheet: string; row: number; values: unknown[] }[] = [];
    const seen = new Set<string>();
    const usedBySheet = new Map<string, { endCol: number } | null>();
    for (const ref of refs) {
      const key = `${ref.sheet}!${ref.row}`;
      if (seen.has(key) || out.length >= 5) continue;
      seen.add(key);
      try {
        if (!usedBySheet.has(ref.sheet)) {
          usedBySheet.set(ref.sheet, await engine.getUsedRange(ref.sheet));
        }
        const used = usedBySheet.get(ref.sheet);
        if (!used) continue;
        const values = await engine.readRange(
          { sheet: ref.sheet, startRow: ref.row, startCol: 0, endRow: ref.row, endCol: used.endCol },
          principalOf({}),
        );
        out.push({ sheet: ref.sheet, row: ref.row, values: toJsonMatrix(values)[0] ?? [] });
      } catch {
        // The echo is best-effort: a failed read-back never fails the write.
      }
    }
    return out;
  };

  server.tool(
    'write_cells',
    'Write literal values to cells. A string value starting with "=" is treated as a formula by the engine. Writes go through authorize(): locked cells and read-only principals are rejected per cell. A target sheet that does not exist yet is created first (sheet creation goes through authorize() with the same principal).',
    {
      cells: z
        .array(
          cellRefSchema.extend({
            value: jsonValueSchema,
          }),
        )
        .min(1)
        .max(1000),
      principal: principalSchema,
    },
    async (args): Promise<ToolResult> => {
      try {
        const farError = await farWriteError(args.cells);
        if (farError) return errorResult(farError);
        const errors: string[] = [];
        let written = 0;
        const auth = principalOf(args);
        const writtenRefs: CellRef[] = [];
        // #63: a write to a sheet that does not exist creates it first
        // (through authorize(), with this same auth). Sheets that could
        // not be ensured fail their cells with the ensure error.
        const ensureFailures = await ensureSheetsExist(args.cells, auth);
        for (const cell of args.cells) {
          const ref: CellRef = { sheet: cell.sheet, row: cell.row, col: cell.col };
          const ensureError = ensureFailures.get(cell.sheet);
          if (ensureError) {
            errors.push(`${cell.sheet}!R${cell.row}C${cell.col}: ${ensureError}`);
            continue;
          }
          // Awaited: the host may be an IPC-forwarding host (desktop MCP
          // parity) whose execute() resolves asynchronously.
          const result = await engine.execute({
            cmd: 'setCell',
            ref,
            value: cell.value,
            auth,
          });
          if (result.ok) {
            written += 1;
            writtenRefs.push(ref);
          } else {
            errors.push(`${cell.sheet}!R${cell.row}C${cell.col}: ${result.error}`);
          }
        }
        if (errors.length > 0 && written === 0) {
          return errorResult(`all writes failed: ${errors.join('; ')}`);
        }
        return okResult({ written, errors, writtenRowContext: await rowContext(writtenRefs) });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'set_formulas',
    'Set formulas on cells. Formulas may omit the leading "=" (it is added automatically). A target sheet that does not exist yet is created first (sheet creation goes through authorize() with the same principal).',
    {
      formulas: z
        .array(
          cellRefSchema.extend({
            formula: z.string().min(1).max(100_000),
          }),
        )
        .min(1)
        .max(1000),
      principal: principalSchema,
    },
    async (args): Promise<ToolResult> => {
      try {
        const farError = await farWriteError(args.formulas);
        if (farError) return errorResult(farError);
        const errors: string[] = [];
        let written = 0;
        const auth = principalOf(args);
        const writtenRefs: CellRef[] = [];
        // #63: a formula set on a sheet that does not exist creates it
        // first (through authorize(), with this same auth). Sheets that
        // could not be ensured fail their cells with the ensure error.
        const ensureFailures = await ensureSheetsExist(args.formulas, auth);
        for (const f of args.formulas) {
          const ref: CellRef = { sheet: f.sheet, row: f.row, col: f.col };
          const ensureError = ensureFailures.get(f.sheet);
          if (ensureError) {
            errors.push(`${f.sheet}!R${f.row}C${f.col}: ${ensureError}`);
            continue;
          }
          // Awaited: the host may be an IPC-forwarding host (desktop MCP
          // parity) whose execute() resolves asynchronously.
          const result = await engine.execute({
            cmd: 'setFormula',
            ref,
            formula: f.formula,
            auth,
          });
          if (result.ok) {
            written += 1;
            writtenRefs.push(ref);
          } else {
            errors.push(`${f.sheet}!R${f.row}C${f.col}: ${result.error}`);
          }
        }
        if (errors.length > 0 && written === 0) {
          return errorResult(`all writes failed: ${errors.join('; ')}`);
        }
        return okResult({ written, errors, writtenRowContext: await rowContext(writtenRefs) });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'recalculate',
    'Force a full recalculation of the workbook.',
    { principal: principalSchema },
    async (args): Promise<ToolResult> => {
      try {
        // Awaited: the host may be an IPC-forwarding host (desktop MCP
        // parity) whose execute() resolves asynchronously.
        const result = await engine.execute({ cmd: 'recalculate', auth: principalOf(args) });
        if (!result.ok) {
          return errorResult(result.error);
        }
        return okResult({});
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'get_results',
    'Read the full used-range values of a sheet. Goes through authorize(): cells the principal cannot read come back as #PERM! errors.',
    { sheet: z.string().min(1), principal: principalSchema },
    async (args): Promise<ToolResult> => {
      try {
        // Awaited: the host may be an IPC-forwarding host (desktop MCP
        // parity) whose reads resolve asynchronously.
        const values = await engine.readSheet(args.sheet, principalOf(args));
        return okResult({ cells: toJsonMatrix(values) });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'list_sheets',
    "List the open workbook's sheets, in tab order. These are the ONLY sheets that exist — ground every sheet reference (and any which-sheet choice) on this list instead of inventing names.",
    { principal: principalSchema },
    async (): Promise<ToolResult> => {
      try {
        const asyncNames = (engine as { sheetNamesAsync?: unknown }).sheetNamesAsync;
        const sheets =
          typeof asyncNames === 'function'
            ? await (asyncNames as () => Promise<string[]>).call(engine)
            : await engine.sheetNames();
        return okResult({ sheets });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // SCHEMA-FIRST tools (owner design 2026-10-26): the agent maps a sheet
  // BEFORE it reads values, and aggregates through the engine instead of
  // hand-adding. describe_sheet returns labels and shapes only — never
  // the value matrix — so the agent never needs the whole data.
  // find_label is exact-only (no fuzzy match, ever). aggregate_cells
  // replaces the scratch-formula dance (write a SUM formula, read it
  // back, clear it) with one engine-truth call.
  function displayLabel(v: TypedValue | undefined): string | null {
    if (!v) return null;
    if (v.kind === 'string' && typeof v.value === 'string') return v.value;
    if (v.kind === 'number' && typeof v.value === 'number' && Number.isFinite(v.value)) return String(v.value);
    if (v.kind === 'boolean' && typeof v.value === 'boolean') return v.value ? 'true' : 'false';
    return null;
  }

  function hasYearRun(values: (number | null)[]): boolean {
    // Strict year-sequence rule (mirrors analysis/horizontal.ts): three
    // adjacent cells holding consecutive +1 integers, the first in
    // 1900..2100. Years differ ~0.5% from each other, so a year row
    // plotted as values looks like equal bars — this flag is what stops
    // the agent mistaking the dimension row for a measure row.
    for (let i = 0; i + 2 < values.length; i++) {
      const a = values[i];
      const b = values[i + 1];
      const c = values[i + 2];
      if (
        a !== null &&
        b !== null &&
        c !== null &&
        Number.isInteger(a) &&
        a >= 1900 &&
        a <= 2100 &&
        b === a + 1 &&
        c === a + 2
      ) {
        return true;
      }
    }
    return false;
  }

  // Coordinate-frame label (follow-up 2026-10-26): the re-proof agent
  // read describe_sheet rows as BLOCK-RELATIVE (Revenue "row 1" = absolute
  // row 6 minus the years-row origin 5) and used them as absolute in
  // aggregate_cells and verification declarations. Every coordinate the
  // schema tools return is absolute, and the response now says so
  // explicitly — first in the payload, so no reading can miss it.
  const COORDINATE_FRAME =
    'All row and col numbers in this response are 0-based ABSOLUTE sheet coordinates: ' +
    'row 0 is the first row of the sheet and col 0 is column A (so B=1, C=2, ...). ' +
    'They are NOT offsets from usedRange.startRow/startCol, NOT positions inside the ' +
    'rowSummaries/colSummaries arrays, and NOT offsets from the dimension row — the ' +
    'dimension row\'s own number IS its absolute row. Pass these exact numbers to ' +
    'read_cells, aggregate_cells, find_label, and verification declarations; do not ' +
    'subtract anything from them.';
  server.tool(
    'describe_sheet',
    "Describe a sheet's SCHEMA without returning its values: the used range, one label plus numeric/text counts per row and per column, and which rows/columns look like dimensions (a row/column holding a year sequence). Call this FIRST on any sheet you have not mapped yet, before read_cells — it tells you which row/column is which and the data range, so you never need the whole data. It returns labels and counts only, never the value matrix. Every row/col number it returns is a 0-based ABSOLUTE sheet coordinate (row 0 = the first row of the sheet, col 0 = column A) — never a position in the returned arrays, never an offset from the used range or the dimension row; use the numbers exactly as returned.",
    {
      sheet: z.string().min(1),
      principal: principalSchema,
    },
    async (args): Promise<ToolResult> => {
      try {
        let used: RangeRef | null = null;
        try {
          used = await engine.getUsedRange(args.sheet);
        } catch {
          used = null;
        }
        if (!used) {
          return errorResult(`sheet "${args.sheet}" has no used range (empty or unknown)`);
        }
        const usedRange = {
          sheet: args.sheet,
          startRow: used.startRow,
          startCol: used.startCol,
          endRow: used.endRow,
          endCol: used.endCol,
        };
        const cellCount =
          (used.endRow - used.startRow + 1) * (used.endCol - used.startCol + 1);
        if (cellCount > MAX_READ_CELLS) {
          return okResult({
            coordinateFrame: COORDINATE_FRAME,
            sheet: args.sheet,
            usedRange,
            scanned: false,
            note: `used range holds ${cellCount} cells (max ${MAX_READ_CELLS}); read bounded slices with read_cells instead of a full scan`,
          });
        }
        const grid = await engine.readRange(usedRange, principalOf(args));
        const rowCount = used.endRow - used.startRow + 1;
        const colCount = used.endCol - used.startCol + 1;
        const at = (r: number, c: number): TypedValue | undefined =>
          grid[r - used.startRow]?.[c - used.startCol];
        const rowSummaries = [];
        const dimensionRows: number[] = [];
        for (let r = used.startRow; r <= used.endRow; r++) {
          let numericCount = 0;
          let textCount = 0;
          const numerics: (number | null)[] = [];
          for (let c = used.startCol; c <= used.endCol; c++) {
            const v = at(r, c);
            if (v?.kind === 'number' && typeof v.value === 'number' && Number.isFinite(v.value)) {
              numericCount++;
              numerics.push(v.value);
            } else {
              numerics.push(null);
              if (v?.kind === 'string') textCount++;
            }
          }
          const dimensionLike = hasYearRun(numerics);
          if (dimensionLike) dimensionRows.push(r);
          rowSummaries.push({
            row: r,
            label: displayLabel(at(r, used.startCol)),
            numericCount,
            textCount,
            dimensionLike,
          });
        }
        const colSummaries = [];
        const dimensionCols: number[] = [];
        for (let c = used.startCol; c <= used.endCol; c++) {
          let numericCount = 0;
          let textCount = 0;
          const numerics: (number | null)[] = [];
          for (let r = used.startRow; r <= used.endRow; r++) {
            const v = at(r, c);
            if (v?.kind === 'number' && typeof v.value === 'number' && Number.isFinite(v.value)) {
              numericCount++;
              numerics.push(v.value);
            } else {
              numerics.push(null);
              if (v?.kind === 'string') textCount++;
            }
          }
          const dimensionLike = hasYearRun(numerics);
          if (dimensionLike) dimensionCols.push(c);
          colSummaries.push({
            col: c,
            label: displayLabel(at(used.startRow, c)),
            numericCount,
            textCount,
            dimensionLike,
          });
        }
        const suggestedLayout =
          dimensionRows.length > 0 && dimensionCols.length === 0
            ? 'horizontal'
            : dimensionCols.length > 0 && dimensionRows.length === 0
              ? 'vertical'
              : 'unknown';
        return okResult({
          coordinateFrame: COORDINATE_FRAME,
          sheet: args.sheet,
          usedRange,
          scanned: true,
          rowCount,
          colCount,
          rowSummaries,
          colSummaries,
          dimensionRows,
          dimensionCols,
          suggestedLayout,
        });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'find_label',
    'Find the exact coordinates of a row or column label on a sheet. The match is EXACT (string equality after trimming, case-sensitive) — there is no fuzzy match and no "closest" suggestion: a missing label returns found:false, never a guess. Search covers the row-label column and header row first, then the whole used range (borders only when the used range exceeds the read cap). Use it instead of guessing coordinates from wording, and after describe_sheet when you need one label\'s row or column. Returned row/col numbers are 0-based ABSOLUTE sheet coordinates (row 0 = first sheet row, col 0 = column A) — use them exactly as returned.',
    {
      sheet: z.string().min(1),
      label: z.string().min(1).max(200),
      principal: principalSchema,
    },
    async (args): Promise<ToolResult> => {
      try {
        const want = args.label.trim();
        let used: RangeRef | null = null;
        try {
          used = await engine.getUsedRange(args.sheet);
        } catch {
          used = null;
        }
        if (!used) {
          return errorResult(`sheet "${args.sheet}" has no used range (empty or unknown)`);
        }
        const cellCount =
          (used.endRow - used.startRow + 1) * (used.endCol - used.startCol + 1);
        const isMatch = (v: TypedValue | undefined): boolean =>
          !!v && v.kind === 'string' && typeof v.value === 'string' && v.value.trim() === want;
        const matches: { row: number; col: number; axis: string }[] = [];
        const seen = new Set<string>();
        const push = (row: number, col: number, axis: string): void => {
          const key = `${row}:${col}`;
          if (!seen.has(key)) {
            seen.add(key);
            matches.push({ row, col, axis });
          }
        };
        if (cellCount <= MAX_READ_CELLS) {
          const grid = await engine.readRange(
            {
              sheet: args.sheet,
              startRow: used.startRow,
              startCol: used.startCol,
              endRow: used.endRow,
              endCol: used.endCol,
            },
            principalOf(args),
          );
          const at = (r: number, c: number): TypedValue | undefined =>
            grid[r - used.startRow]?.[c - used.startCol];
          for (let r = used.startRow; r <= used.endRow; r++) {
            if (isMatch(at(r, used.startCol))) push(r, used.startCol, 'row');
          }
          for (let c = used.startCol; c <= used.endCol; c++) {
            if (isMatch(at(used.startRow, c))) push(used.startRow, c, 'column');
          }
          for (let r = used.startRow; r <= used.endRow; r++) {
            for (let c = used.startCol; c <= used.endCol; c++) {
              if (isMatch(at(r, c))) push(r, c, 'cell');
            }
          }
          return okResult({
            coordinateFrame: COORDINATE_FRAME,
            sheet: args.sheet,
            label: args.label,
            found: matches.length > 0,
            matches,
            searched: 'full-range',
          });
        }
        const colStrip = await engine.readRange(
          {
            sheet: args.sheet,
            startRow: used.startRow,
            startCol: used.startCol,
            endRow: used.endRow,
            endCol: used.startCol,
          },
          principalOf(args),
        );
        for (let r = used.startRow; r <= used.endRow; r++) {
          if (isMatch(colStrip[r - used.startRow]?.[0])) push(r, used.startCol, 'row');
        }
        const rowStrip = await engine.readRange(
          {
            sheet: args.sheet,
            startRow: used.startRow,
            startCol: used.startCol,
            endRow: used.startRow,
            endCol: used.endCol,
          },
          principalOf(args),
        );
        for (let c = used.startCol; c <= used.endCol; c++) {
          if (isMatch(rowStrip[0]?.[c - used.startCol])) push(used.startRow, c, 'column');
        }
        return okResult({
          coordinateFrame: COORDINATE_FRAME,
          sheet: args.sheet,
          label: args.label,
          found: matches.length > 0,
          matches,
          searched: 'borders-only',
        });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'aggregate_cells',
    "Compute ONE engine-truth aggregate over a rectangular range in a single call: sum, avg, count, min, or max of the range's numeric cells. Values are the engine's computed values; text, empty cells, and errors (including #PERM!) are skipped — errorCount reports how many were skipped, never their values. Use this for every total instead of hand-adding read values and instead of the scratch-formula dance (write a SUM formula, read it back, clear it). A range larger than the read cap FAILS with the used bounds named — never silently aggregate a partial window.",
    {
      sheet: z.string().min(1),
      startRow: z.number().int().min(0),
      startCol: z.number().int().min(0),
      endRow: z.number().int().min(0),
      endCol: z.number().int().min(0),
      op: z.enum(['sum', 'avg', 'count', 'min', 'max']),
      principal: principalSchema,
    },
    async (args): Promise<ToolResult> => {
      try {
        if (args.endRow < args.startRow || args.endCol < args.startCol) {
          return errorResult('endRow/endCol must be >= startRow/startCol');
        }
        const count = (args.endRow - args.startRow + 1) * (args.endCol - args.startCol + 1);
        const range = {
          sheet: args.sheet,
          startRow: args.startRow,
          startCol: args.startCol,
          endRow: args.endRow,
          endCol: args.endCol,
        };
        if (count > MAX_READ_CELLS) {
          let used: RangeRef | null = null;
          try {
            used = await engine.getUsedRange(args.sheet);
          } catch {
            used = null;
          }
          const hint = used
            ? ` the sheet's used range is rows ${used.startRow}..${used.endRow}, cols ${used.startCol}..${used.endCol}`
            : '';
          return errorResult(
            `range too large: ${count} cells (max ${MAX_READ_CELLS});${hint} — aggregate a narrower range`,
          );
        }
        const grid = await engine.readRange(range, principalOf(args));
        let sum = 0;
        let numericCount = 0;
        let errorCount = 0;
        let min = Infinity;
        let max = -Infinity;
        for (const row of grid) {
          for (const v of row) {
            if (v?.kind === 'number' && typeof v.value === 'number' && Number.isFinite(v.value)) {
              sum += v.value;
              numericCount++;
              if (v.value < min) min = v.value;
              if (v.value > max) max = v.value;
            } else if (v?.kind === 'error') {
              errorCount++;
            }
          }
        }
        if (args.op === 'count') {
          return okResult({
            sheet: args.sheet,
            op: args.op,
            value: numericCount,
            numericCount,
            errorCount,
            range,
          });
        }
        if (numericCount === 0) {
          return errorResult(`aggregate ${args.op}: no numeric values in range`);
        }
        const value =
          args.op === 'sum'
            ? sum
            : args.op === 'avg'
              ? sum / numericCount
              : args.op === 'min'
                ? min
                : max;
        return okResult({
          sheet: args.sheet,
          op: args.op,
          value,
          numericCount,
          errorCount,
          range,
        });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'create_pivot',
    'Build a PivotTable over a rectangular range (first row is the header). Stores a versioned pivot spec in the service metadata and returns a summary.',
    {
      sheet: z.string().min(1),
      startRow: z.number().int().min(0),
      startCol: z.number().int().min(0),
      endRow: z.number().int().min(0),
      endCol: z.number().int().min(0),
      rows: z.array(z.string().min(1)).max(20),
      columns: z.array(z.string().min(1)).max(20),
      values: z
        .array(
          z.object({
            field: z.string().min(1),
            aggregation: aggregationSchema,
            label: z.string().optional(),
          }),
        )
        .min(1)
        .max(20),
      filters: z
        .array(z.object({ field: z.string().min(1), selected: z.array(z.string()) }))
        .optional(),
      name: z.string().min(1).max(100).optional(),
      principal: principalSchema,
    },
    async (args): Promise<ToolResult> => {
      try {
        if (args.endRow < args.startRow || args.endCol < args.startCol) {
          return errorResult('endRow/endCol must be >= startRow/startCol');
        }
        const source = {
          sheet: args.sheet,
          startRow: args.startRow,
          startCol: args.startCol,
          endRow: args.endRow,
          endCol: args.endCol,
        };
        const { records } = readPivotRecords(source, principalOf(args));
        const spec: PivotSpec = {
          version: PIVOT_VERSION,
          rows: args.rows,
          columns: args.columns,
          values: args.values.map((v) => ({
            field: v.field,
            aggregation: v.aggregation as PivotAggregation,
            ...(v.label ? { label: v.label } : {}),
          })),
          filters: args.filters ?? [],
        };
        const result = createPivot(records, spec);
        const name = args.name ?? `PivotTable${pivotSeq++}`;
        if (await getPivotBinding(name)) {
          return errorResult(`a PivotTable named "${name}" already exists`);
        }
        const entry: PivotEntry = { name, spec, source, result };
        await pivotStore.add({ name, spec, source });
        pivotResults.set(name, result);
        return okResult({ pivot: pivotSummary(entry) });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'refresh_pivot',
    'Recompute a stored PivotTable against the current source range values.',
    { name: z.string().min(1), principal: principalSchema },
    async (args): Promise<ToolResult> => {
      try {
        const binding = await getPivotBinding(args.name);
        if (!binding) return errorResult(`unknown PivotTable "${args.name}"`);
        const { records } = readPivotRecords(binding.source, principalOf(args));
        const result = createPivot(records, binding.spec);
        pivotResults.set(args.name, result);
        return okResult({ pivot: pivotSummary({ ...binding, result }) });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'get_pivot_data',
    'Return the full rendered matrix of a stored PivotTable.',
    { name: z.string().min(1), principal: principalSchema },
    async (args): Promise<ToolResult> => {
      try {
        const binding = await getPivotBinding(args.name);
        if (!binding) return errorResult(`unknown PivotTable "${args.name}"`);
        // Recompute on demand if the result cache missed (e.g. after a
        // restart with persisted specs) — always through authorized reads.
        let result = pivotResults.get(args.name);
        if (!result) {
          const { records } = readPivotRecords(binding.source, principalOf(args));
          result = createPivot(records, binding.spec);
          pivotResults.set(args.name, result);
        }
        const entry: PivotEntry = { ...binding, result };
        return okResult({
          pivot: pivotSummary(entry),
          matrix: pivotToMatrix(entry.result),
        });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  const subscriptionEventSchema = z.enum([
    'cells_changed',
    'recalc_complete',
    'sheet_added',
    'sheet_removed',
  ]);

  const jsonSchema: z.ZodTypeAny = z.lazy(() =>
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(jsonSchema),
      z.record(z.string(), jsonSchema),
    ]),
  );

  server.tool(
    'subscribe',
    'Subscribe to engine events. Events are buffered per subscription; drain them with poll_events.',
    {
      events: z.array(subscriptionEventSchema).min(1).max(4),
      sheet: z.string().min(1).optional(),
      principal: z.string().min(1).max(200).optional(),
    },
    (args): ToolResult => {
      try {
        const types = args.events.filter(isSubscriptionEventType);
        if (types.length === 0) return errorResult('no valid event types');
        const id = subscriptions.subscribe(
          types,
          args.sheet ? { sheet: args.sheet } : {},
          principalOf(args).principal,
        );
        return okResult({ subscriptionId: id });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'unsubscribe',
    'Remove an event subscription. Buffered events are discarded.',
    { subscriptionId: z.string().min(1) },
    (args): ToolResult => {
      try {
        const removed = subscriptions.unsubscribe(args.subscriptionId);
        if (!removed) return errorResult(`unknown subscription "${args.subscriptionId}"`);
        return okResult({ removed: true });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'list_subscriptions',
    'List active event subscriptions.',
    {},
    (): ToolResult => {
      try {
        return okResult({ subscriptions: subscriptions.list() });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'poll_events',
    'Drain buffered events for a subscription (oldest first). The MCP stdio transport is request/response, so clients poll; this is what the AI Agent proactivity loop uses.',
    {
      subscriptionId: z.string().min(1),
      maxEvents: z.number().int().min(1).max(500).optional(),
    },
    (args): ToolResult => {
      try {
        const events = subscriptions.poll(args.subscriptionId, args.maxEvents ?? 100);
        if (events === null) return errorResult(`unknown subscription "${args.subscriptionId}"`);
        return okResult({ events });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'memory_load',
    'Load a value from the agent long-term memory (per-user service metadata).',
    { userId: z.string().min(1), key: z.string().min(1).max(200) },
    async (args): Promise<ToolResult> => {
      try {
        const { found, value } = await memory.load(args.userId, args.key);
        return okResult({ found, value: found ? value : null });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'memory_save',
    'Save a value to the agent long-term memory (per-user service metadata). Overwrites any existing value.',
    { userId: z.string().min(1), key: z.string().min(1).max(200), value: jsonSchema },
    async (args): Promise<ToolResult> => {
      try {
        await memory.save(args.userId, args.key, args.value);
        return okResult({ saved: true });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'memory_update',
    'Patch a value in the agent long-term memory. When both stored and new values are objects, shallow-merge; otherwise replace.',
    { userId: z.string().min(1), key: z.string().min(1).max(200), value: jsonSchema },
    async (args): Promise<ToolResult> => {
      try {
        const value = await memory.update(args.userId, args.key, args.value);
        return okResult({ value });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'agent.ask_question',
    'Human-in-the-loop: ask the user a free-text question. The tool call PAUSES the agent until the user answers via agent.answer_pending (or the wait times out — it never hangs forever). There is no path around MCP.',
    {
      question: z.string().min(1).max(4000),
      principal: principalSchema,
    },
    async (args): Promise<ToolResult> => {
      try {
        const pendingAsks = await pendingAsksReady;
        const { principal } = principalOf(args);
        const ask = await pendingAsks.create({ kind: 'question', principal, question: args.question });
        try {
          const answered = await pendingAsks.waitForAnswer(ask.id, hitlTimeoutMs);
          return okResult({ askId: ask.id, answer: answered.answer ?? '' });
        } catch (e) {
          return errorResult(`agent.ask_question: ${e instanceof Error ? e.message : String(e)}`);
        }
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'agent.offer_options',
    'Human-in-the-loop: ask the user to choose one of the offered options. The tool call PAUSES the agent until the user answers via agent.answer_pending (or the wait times out). There is no path around MCP.',
    {
      question: z.string().min(1).max(4000),
      options: z.array(z.string().min(1).max(200)).min(2).max(20),
      principal: principalSchema,
    },
    async (args): Promise<ToolResult> => {
      try {
        const pendingAsks = await pendingAsksReady;
        const { principal } = principalOf(args);
        const ask = await pendingAsks.create({
          kind: 'options',
          principal,
          question: args.question,
          options: args.options,
        });
        try {
          const answered = await pendingAsks.waitForAnswer(ask.id, hitlTimeoutMs);
          return okResult({ askId: ask.id, selected: answered.answer ?? '' });
        } catch (e) {
          return errorResult(`agent.offer_options: ${e instanceof Error ? e.message : String(e)}`);
        }
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'agent.request_approval',
    'Human-in-the-loop: request the user\'s approval before a broad or destructive action (ai-agent.md §7). The tool call PAUSES the agent until the user approves or denies via agent.answer_pending (or the wait times out). Ambiguous answers are treated as denied with the text kept as a note — the agent must never guess. There is no path around MCP.',
    {
      action: z.string().min(1).max(200),
      detail: z.string().min(1).max(4000),
      principal: principalSchema,
    },
    async (args): Promise<ToolResult> => {
      try {
        const pendingAsks = await pendingAsksReady;
        const { principal } = principalOf(args);
        const ask = await pendingAsks.create({
          kind: 'approval',
          principal,
          action: args.action,
          detail: args.detail,
        });
        try {
          const answered = await pendingAsks.waitForAnswer(ask.id, hitlTimeoutMs);
          const verdict = parseApprovalAnswer(answered.answer ?? '');
          return okResult({
            askId: ask.id,
            approved: verdict.approved,
            ...(answered.note !== undefined || verdict.note !== undefined
              ? { note: answered.note ?? verdict.note }
              : {}),
          });
        } catch (e) {
          return errorResult(
            `agent.request_approval: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'agent.answer_pending',
    "Deliver the human's answer to a pending ask, unblocking the paused agent.* tool call. Principal-scoped (ai-agent.md §3): only the principal the ask was created for can answer it — anyone else gets an authorization error.",
    {
      askId: z.string().min(1),
      answer: z.string().max(4000),
      note: z.string().max(4000).optional(),
      principal: principalSchema,
    },
    async (args): Promise<ToolResult> => {
      try {
        const pendingAsks = await pendingAsksReady;
        const { principal } = principalOf(args);
        const ask = await pendingAsks.answer(args.askId, args.answer, principal, args.note);
        return okResult({ askId: ask.id, kind: ask.kind, answered: true });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return errorResult(
          msg.startsWith('not authorized') ? `authorization denied: ${msg}` : msg,
        );
      }
    },
  );

  server.tool(
    'agent.list_pending',
    "List the caller's pending human-in-the-loop asks (ai-agent.md §12) — what the paused agent is waiting for. Principal-scoped: only the caller's own asks are returned.",
    {
      principal: principalSchema,
    },
    async (args): Promise<ToolResult> => {
      try {
        const pendingAsks = await pendingAsksReady;
        const { principal } = principalOf(args);
        return okResult({ asks: (await pendingAsks.listFor(principal)).map(toPendingAskView) });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'agent.withdraw_pending',
    "Withdraw one of the caller's pending human-in-the-loop asks (ai-agent.md §12). Principal-scoped: only the principal the ask was created for can withdraw it. Used when an ask must never be answered — e.g. the runtime suppressed a planner ask at its grounding/ask-budget gate, so any twin of that question still sitting in the store is a zombie: withdrawing consumes it, and a late answer to it is then a clean no-op instead of a turn on another runtime. Withdrawing an unknown or already-consumed ask is a no-op success.",
    {
      askId: z.string().min(1),
      principal: principalSchema,
    },
    async (args): Promise<ToolResult> => {
      try {
        const pendingAsks = await pendingAsksReady;
        const { principal } = principalOf(args);
        await pendingAsks.remove(args.askId, principal);
        return okResult({ askId: args.askId, withdrawn: true });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return errorResult(
          msg.startsWith('not authorized') ? `authorization denied: ${msg}` : msg,
        );
      }
    },
  );

  // --- Web research tools (service-boundary only) --------------------------------
  // Never ambient fetch — fail closed without provider.
  server.tool(
    'search_web',
    'Search the public web for information. Use when the user asks for external data not in the sheet (e.g. "US population 1900-present"). Returns public URLs with snippets.',
    {
      principal: principalSchema,
      query: z.string().min(1).max(500),
      maxResults: z.number().int().min(1).max(10).optional(),
    },
    async (args): Promise<ToolResult> => {
      try {
        const provider = options?.webResearch?.provider;
        if (!provider) {
          return errorResult(
            'Internet search is not configured — set TAVILY_API_KEY or BRAVE_SEARCH_API_KEY on the service',
          );
        }
        const query = args.query.trim();
        if (query.length === 0) return errorResult('query must be non-empty');
        if (query.length > 500) return errorResult('query must be at most 500 characters');
        const maxResults =
          typeof args.maxResults === 'number'
            ? Math.min(10, Math.max(1, Math.floor(args.maxResults)))
            : 8;
        const result = await provider.search({ query, maxResults });
        return okResult(result);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'fetch_web_page',
    'Fetch a public web page by HTTPS URL. Use after search_web to read the best result. Returns cleaned text content.',
    {
      principal: principalSchema,
      url: z
        .string()
        .min(1)
        .max(2048)
        .refine((u) => u.startsWith('https://'), { message: 'url must use HTTPS' }),
      maxChars: z.number().int().min(1).max(48000).optional(),
    },
    async (args): Promise<ToolResult> => {
      try {
        const provider = options?.webResearch?.provider;
        if (!provider) {
          return errorResult(
            'Internet search is not configured — set TAVILY_API_KEY or BRAVE_SEARCH_API_KEY on the service',
          );
        }
        const url = args.url.trim();
        if (!url.startsWith('https://')) return errorResult('url must use HTTPS');
        if (url.length > 2048) return errorResult('url must be at most 2048 characters');
        const maxChars =
          typeof args.maxChars === 'number'
            ? Math.min(48000, Math.max(1, Math.floor(args.maxChars)))
            : 24000;
        // Validate URL is public HTTPS and not private
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== 'https:') return errorResult('url must use HTTPS');
          if (parsed.username || parsed.password)
            return errorResult('URL must not contain credentials');
          const host = parsed.hostname.toLowerCase();
          if (
            host === 'localhost' ||
            host === '127.0.0.1' ||
            host === '0.0.0.0' ||
            host.startsWith('10.') ||
            host.startsWith('192.168.') ||
            host.startsWith('172.') ||
            host.endsWith('.internal') ||
            host.endsWith('.local')
          ) {
            return errorResult(`URL host is private or blocked: ${host}`);
          }
        } catch {
          return errorResult(`invalid URL: ${url}`);
        }
        const result = await provider.fetchPage({ url, maxChars });
        return okResult(result);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  /**
   * No-code app builder (design-docs/no-code-app-builder.md §2-§3, §7).
   * Versioned app specs in the service metadata store. The AI Agent
   * generates and edits specs through these tools, acting as the user
   * under the shared permission model (ai-agent.md §2-§3): the manage
   * right is required to create/update/delete a spec, every call carries
   * the caller's principal through authorize(), and denials are errors.
   *
   * v1 seam: the engine ships a default-allow policy (permissions.ts); when
   * the permission-model.md object tree lands, this Authorizer is replaced
   * with the tree policy — the tool surface does not change.
   */
  const appStore = createAsyncAppStore(
    metadataAsyncPersistence,
  );
  const appAuthorizer = new Authorizer();
  let appSeq = 1;

  function checkAppAuth(
    principal: string,
    action: 'app.manage' | 'app.read',
    target: string,
  ): string | null {
    try {
      if (!appAuthorizer.authorize(action, target, { principal })) {
        return `denied: ${principal} may not ${action} ${target}`;
      }
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  function appSummary(spec: AppSpec): Record<string, unknown> {
    return {
      id: spec.id,
      name: spec.name,
      version: spec.version,
      views: spec.views.map((v) => ({ id: v.id, kind: v.kind, title: v.title })),
      actions: spec.actions.map((a) => ({ id: a.id, kind: a.kind, label: a.label })),
      initialViewId: spec.navigation.initialViewId,
    };
  }

  function prepareSpec(raw: unknown, fallbackId: string): AppSpec {
    const withId =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? {
            ...(raw as Record<string, unknown>),
            id:
              typeof (raw as Record<string, unknown>)['id'] === 'string' &&
              ((raw as Record<string, unknown>)['id'] as string).trim() !== ''
                ? (raw as Record<string, unknown>)['id']
                : fallbackId,
          }
        : raw;
    // Migrate older versions forward, then validate. Invalid specs are
    // rejected with the validation errors.
    let candidate: unknown = withId;
    const direct = validateAppSpec(candidate);
    if (direct.ok) return direct.spec;
    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as { version?: unknown }).version !== APP_SPEC_VERSION
    ) {
      candidate = migrateAppSpec(candidate);
    }
    const validated = validateAppSpec(candidate);
    if (!validated.ok) {
      throw new Error(`invalid app spec: ${validated.errors.join('; ')}`);
    }
    return validated.spec;
  }

  server.tool(
    'appbuilder_create_spec',
    'Create a no-code app spec (versioned, serializable) in the service metadata store. The spec is validated; invalid specs are rejected with the validation errors. Requires the app manage right.',
    { spec: jsonSchema, principal: principalSchema },
    async (args): Promise<ToolResult> => {
      try {
        const { principal } = principalOf(args);
        const id = `app_${appSeq++}`;
        const spec = prepareSpec(args.spec, id);
        const denied = checkAppAuth(principal, 'app.manage', `app:${spec.id}`);
        if (denied) return errorResult(denied);
        if ((await appStore.all()).some((a) => a.id === spec.id)) {
          return errorResult(`an app spec with id "${spec.id}" already exists`);
        }
        await appStore.add(spec);
        return okResult({ app: appSummary(spec) });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'appbuilder_update_spec',
    'Replace a stored app spec (full replacement after validation; older versions are migrated). The spec id must match. Requires the app manage right.',
    { id: z.string().min(1), spec: jsonSchema, principal: principalSchema },
    async (args): Promise<ToolResult> => {
      try {
        const { principal } = principalOf(args);
        const denied = checkAppAuth(principal, 'app.manage', `app:${args.id}`);
        if (denied) return errorResult(denied);
        const existing = (await appStore.all()).find((a) => a.id === args.id);
        if (!existing) return errorResult(`unknown app spec "${args.id}"`);
        const spec = prepareSpec(args.spec, args.id);
        if (spec.id !== args.id) {
          return errorResult(`spec id "${spec.id}" does not match "${args.id}"`);
        }
        await appStore.saveAll((await appStore.all()).map((a) => (a.id === args.id ? spec : a)));
        return okResult({ app: appSummary(spec) });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'appbuilder_get_spec',
    'Fetch a stored app spec by id.',
    { id: z.string().min(1), principal: principalSchema },
    async (args): Promise<ToolResult> => {
      try {
        const { principal } = principalOf(args);
        const denied = checkAppAuth(principal, 'app.read', `app:${args.id}`);
        if (denied) return errorResult(denied);
        const spec = (await appStore.all()).find((a) => a.id === args.id);
        if (!spec) return errorResult(`unknown app spec "${args.id}"`);
        return okResult({ app: spec });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'appbuilder_list_specs',
    'List stored app specs (id, name, version, views, actions).',
    { principal: principalSchema },
    async (args): Promise<ToolResult> => {
      try {
        const { principal } = principalOf(args);
        const denied = checkAppAuth(principal, 'app.read', 'app:*');
        if (denied) return errorResult(denied);
        return okResult({ apps: (await appStore.all()).map(appSummary) });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'appbuilder_delete_spec',
    'Delete a stored app spec by id. Requires the app manage right.',
    { id: z.string().min(1), principal: principalSchema },
    async (args): Promise<ToolResult> => {
      try {
        const { principal } = principalOf(args);
        const denied = checkAppAuth(principal, 'app.manage', `app:${args.id}`);
        if (denied) return errorResult(denied);
        const removed = await appStore.remove((a) => a.id === args.id);
        if (removed === 0) return errorResult(`unknown app spec "${args.id}"`);
        return okResult({ removed: true });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  /**
   * Native reports (design-docs/native-reports-and-dashboards.md §2, §7;
   * design-docs/report-duplicates-preserved.md: "The AI Agent can generate
   * report specs through MCP tools"). Versioned report specs in the service
   * metadata store, following the appbuilder_* pattern: the spec is
   * migrated forward and validated on create/update, every call carries
   * the caller's principal through authorize(), and the manage right is
   * required to create/update/delete. Per-subject data filtering at render
   * time is handled by reports/reportPermissions.ts (§7); the tools gate
   * spec-level access here.
   *
   * v1 seam: the engine ships a default-allow policy (permissions.ts); when
   * the permission-model.md object tree lands, this Authorizer is replaced
   * with the tree policy — the tool surface does not change.
   */
  const reportStore = createAsyncReportStore(
    metadataAsyncPersistence,
  );
  const reportAuthorizer = new Authorizer();
  let reportSeq = 1;

  function checkReportAuth(
    principal: string,
    action: 'report.manage' | 'report.read',
    target: string,
  ): string | null {
    try {
      if (!reportAuthorizer.authorize(action, target, { principal })) {
        return `denied: ${principal} may not ${action} ${target}`;
      }
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  function reportSummary(spec: ReportSpec): Record<string, unknown> {
    return {
      id: spec.id,
      name: spec.name,
      version: spec.version,
      bindings: spec.bindings.length,
      visuals: spec.visuals.map((v) => ({ id: v.id, kind: v.kind })),
      refreshMode: spec.refresh.mode,
      dataAsOf: spec.dataAsOf,
    };
  }

  function prepareReportSpec(raw: unknown, fallbackId: string): ReportSpec {
    const withId =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? {
            ...(raw as Record<string, unknown>),
            id:
              typeof (raw as Record<string, unknown>)['id'] === 'string' &&
              ((raw as Record<string, unknown>)['id'] as string).trim() !== ''
                ? (raw as Record<string, unknown>)['id']
                : fallbackId,
          }
        : raw;
    // Migrate older versions forward, then validate. Invalid specs are
    // rejected with the validation errors.
    const candidate = migrateReportSpec(withId);
    const errors = validateReportSpec(candidate);
    if (errors.length > 0) {
      throw new Error(`invalid report spec: ${errors.join('; ')}`);
    }
    return candidate;
  }

  server.tool(
    'report_create_spec',
    'Create a native report spec (versioned, serializable) in the service metadata store. The spec is migrated forward and validated; invalid specs are rejected with the validation errors. Requires the report manage right.',
    { spec: jsonSchema, principal: principalSchema },
    async (args): Promise<ToolResult> => {
      try {
        const { principal } = principalOf(args);
        const id = `report_${reportSeq++}`;
        const spec = prepareReportSpec(args.spec, id);
        const denied = checkReportAuth(principal, 'report.manage', `report:${spec.id}`);
        if (denied) return errorResult(denied);
        if ((await reportStore.all()).some((r) => r.id === spec.id)) {
          return errorResult(`a report spec with id "${spec.id}" already exists`);
        }
        await reportStore.add(spec);
        return okResult({ report: reportSummary(spec) });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'report_update_spec',
    'Replace a stored report spec (full replacement after migration + validation; older versions migrate forward). The spec id must match. Requires the report manage right.',
    { id: z.string().min(1), spec: jsonSchema, principal: principalSchema },
    async (args): Promise<ToolResult> => {
      try {
        const { principal } = principalOf(args);
        const denied = checkReportAuth(principal, 'report.manage', `report:${args.id}`);
        if (denied) return errorResult(denied);
        const existing = (await reportStore.all()).find((r) => r.id === args.id);
        if (!existing) return errorResult(`unknown report spec "${args.id}"`);
        const spec = prepareReportSpec(args.spec, args.id);
        if (spec.id !== args.id) {
          return errorResult(`spec id "${spec.id}" does not match "${args.id}"`);
        }
        await reportStore.saveAll((await reportStore.all()).map((r) => (r.id === args.id ? spec : r)));
        return okResult({ report: reportSummary(spec) });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'report_get_spec',
    'Fetch a stored report spec by id. Requires the report read right.',
    { id: z.string().min(1), principal: principalSchema },
    async (args): Promise<ToolResult> => {
      try {
        const { principal } = principalOf(args);
        const denied = checkReportAuth(principal, 'report.read', `report:${args.id}`);
        if (denied) return errorResult(denied);
        const spec = (await reportStore.all()).find((r) => r.id === args.id);
        if (!spec) return errorResult(`unknown report spec "${args.id}"`);
        return okResult({ report: spec });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'report_list_specs',
    'List stored report specs (id, name, version, bindings, visuals, refresh mode). Requires the report read right.',
    { principal: principalSchema },
    async (args): Promise<ToolResult> => {
      try {
        const { principal } = principalOf(args);
        const denied = checkReportAuth(principal, 'report.read', 'report:*');
        if (denied) return errorResult(denied);
        return okResult({ reports: (await reportStore.all()).map(reportSummary) });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'report_delete_spec',
    'Delete a stored report spec by id. Requires the report manage right.',
    { id: z.string().min(1), principal: principalSchema },
    async (args): Promise<ToolResult> => {
      try {
        const { principal } = principalOf(args);
        const denied = checkReportAuth(principal, 'report.manage', `report:${args.id}`);
        if (denied) return errorResult(denied);
        const removed = await reportStore.remove((r) => r.id === args.id);
        if (removed === 0) return errorResult(`unknown report spec "${args.id}"`);
        return okResult({ removed: true });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  /**
   * Data-analysis + visualization pipeline (design-docs: data-analysis
   * component). The AI Agent acts only through these tools (§2): the agent
   * (or any MCP client) sends an analytical *intent* in natural language;
   * the component extracts the data schema, classifies the intent,
   * generates a versioned Python script, executes it deterministically in
   * the sandbox, and persists the script as a versioned, re-runnable tool
   * (analysis artifact) in the service metadata store.
   */
  const analysisStore = createAsyncAnalysisStore(
    metadataAsyncPersistence,
  );
  let analysisSeq = 1;

  /** Server host binding: the real sandboxed runner (node-only, like execute_code). */
  const analysisPythonRunner: PythonRunner = async (code, input, opts) => {
    if (typeof process === 'undefined' || !process.versions?.node) {
      return { error: 'analysis sandbox is not available in the browser build' };
    }
    // Variable specifier + @vite-ignore: bundlers cannot analyze this
    // import, so node:child_process is never bundled (execute_code pattern).
    const pyMod = './sandbox/python.js';
    const mod = (await import(/* @vite-ignore */ pyMod)) as {
      runPython: (
        code: string,
        args: Record<string, unknown>,
        opts?: { timeoutMs?: number },
      ) => { value: unknown } | { error: string };
    };
    return mod.runPython(code, { columns: input.columns, rows: input.rows }, { timeoutMs: opts.timeoutMs });
  };

  /** Max data rows fed to a generated script (abuse guard; schema keeps the full count). */
  const MAX_ANALYSIS_ROWS = 20_000;

  async function analysisSheetName(explicit: string | undefined): Promise<string> {
    if (explicit && explicit.trim() !== '') return explicit.trim();
    // Awaited: the host may be an IPC-forwarding host (desktop MCP parity).
    const first = (await engine.snapshot()).sheets[0];
    if (!first) throw new Error('workbook has no sheets');
    return first.name;
  }

  async function resolveAnalysisRange(
    sheet: string,
    bounds:
      | { startRow: number; startCol: number; endRow: number; endCol: number }
      | undefined,
  ): Promise<AnalysisRangeRef> {
    if (bounds) {
      if (bounds.endRow < bounds.startRow || bounds.endCol < bounds.startCol) {
        throw new Error('endRow/endCol must be >= startRow/startCol');
      }
      return { sheet, ...bounds };
    }
    // getUsedRange() is the protocol-level accessor: getView() cannot cross
    // an IPC-forwarding host (desktop MCP parity), so it is never used here.
    const used = await engine.getUsedRange(sheet);
    if (!used) throw new Error(`sheet "${sheet}" is empty`);
    return {
      sheet,
      startRow: used.startRow,
      startCol: used.startCol,
      endRow: used.endRow,
      endCol: used.endCol,
    };
  }

  /** TypedValue -> analysis scalar. #PERM! and image markers never enter analysis data. */
  function toAnalysisValue(v: unknown): AnalysisValue {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
    return null;
  }

  interface AnalysisRead {
    range: AnalysisRangeRef;
    grid: AnalysisCellInput[][];
  }

  async function readAnalysisGrid(range: AnalysisRangeRef, principal: string): Promise<AnalysisRead> {
    const count = (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1);
    if (count > MAX_READ_CELLS) {
      throw new Error(`range too large: ${count} cells (max ${MAX_READ_CELLS})`);
    }
    const auth = { principal };
    // Awaited: the host may be an IPC-forwarding host (desktop MCP parity).
    const typed = await engine.readRange(range, auth);
    const grid: AnalysisCellInput[][] = typed.map((row) =>
      row.map((v) => {
        // Authorized read: hidden/denied cells surface as #PERM! and are
        // excluded from schema statistics (values never leak).
        if (v.kind === 'error' && v.code === '#PERM!') return { error: '#PERM!' };
        const json = TypedView.toJson(v);
        if (typeof json === 'object' && json !== null) return null;
        return toAnalysisValue(json);
      }),
    );
    return { range, grid };
  }

  /** One-line human summary of an analysis result (chat + audit trail). */
  function summarizeAnalysis(
    plan: AnalysisPlan,
    analysis: Record<string, unknown>,
    rangeRef: string,
  ): string {
    const fmtN = (n: unknown): string =>
      typeof n === 'number' ? (Number.isInteger(n) ? String(n) : n.toFixed(3)) : '?';
    const base = `${plan.summary} over ${rangeRef}`;
    switch (plan.intentKind) {
      case 'aggregate': {
        const groups = analysis.groups as Record<string, number> | undefined;
        const top = groups
          ? Object.entries(groups)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([k, v]) => `${k}: ${fmtN(v)}`)
              .join(', ')
          : '';
        return `Sum of ${analysis.measure} by ${analysis.groupBy} over ${rangeRef}: ${analysis.groupCount} groups, total ${fmtN(analysis.grandTotal)}. Top: ${top}`;
      }
      case 'trend': {
        const fore = Array.isArray(analysis.forecast) ? (analysis.forecast as number[]) : [];
        return `${base}: slope ${fmtN(analysis.slope)} over ${analysis.points} points; next ${fore.length}: ${fore.map(fmtN).join(', ')}`;
      }
      case 'distribution': {
        const d = analysis.describe as { count?: number; mean?: number; stdev?: number } | undefined;
        return `${base}: ${d?.count ?? 0} values, mean ${fmtN(d?.mean)}, stdev ${fmtN(d?.stdev)} across ${analysis.bins} bins`;
      }
      case 'correlation': {
        const s = analysis.strongest as { x?: string; y?: string; r?: number } | null | undefined;
        return s ? `${base}: strongest ${s.x} vs ${s.y} (r=${fmtN(s.r)}) across ${analysis.pairs} paired rows` : `${base}: no numeric pairs`;
      }
      case 'compare': {
        const measures = Array.isArray(analysis.measures) ? (analysis.measures as string[]).join(', ') : '';
        return `${base}: comparing ${measures} by ${analysis.category}`;
      }
      case 'top-n': {
        const ranking = Array.isArray(analysis.ranking)
          ? (analysis.ranking as { label: string; value: number }[])
              .slice(0, 5)
              .map((r) => `${r.label}: ${fmtN(r.value)}`)
              .join(', ')
          : '';
        return `${base}: ${ranking}`;
      }
      case 'summarize':
      default: {
        const cols = analysis.columns as Record<string, { mean?: number; count?: number }> | undefined;
        const bits = cols
          ? Object.entries(cols)
              .slice(0, 5)
              .map(([k, v]) => `${k} mean ${fmtN(v.mean)} (n=${v.count})`)
              .join('; ')
          : '';
        return `${base} (${analysis.rowCount} rows): ${bits}`;
      }
    }
  }

  /**
   * Run the full pipeline for one analytical request. Returns the stored
   * artifact plus the render-ready pieces (summary + chartSpec).
   */
  async function runAnalysisPipeline(opts: {
    intent: string;
    sheet?: string;
    bounds?: { startRow: number; startCol: number; endRow: number; endCol: number };
    /** Declared header semantics for the range's first row (see analyze_data). */
    headerRow?: boolean;
    principal: string;
    timeoutMs?: number;
  }): Promise<{ artifact: AnalysisArtifact; summary: string }> {
    const sheet = await analysisSheetName(opts.sheet);
    const range = await resolveAnalysisRange(sheet, opts.bounds);
    const { grid } = await readAnalysisGrid(range, opts.principal);
    // Horizontal-layout recognition (analysis/horizontal.ts): when the
    // dimension runs across a row (a year row with measure rows below),
    // analyze the TRANSPOSED view instead — the column-oriented pipeline
    // cannot group by a row. Detection is a pure function of the grid, so
    // rerun_analysis re-derives the same view from freshly-read data.
    // The schema is extracted against a synthetic range matching the
    // transposed shape (extractDataSchema sizes columns from the range),
    // then rangeRef is restored to the SOURCE range so rerun reads the
    // right cells and the summary names the range the user asked about.
    const transposed = transposeHorizontalYearGrid(grid);
    const viewGrid = transposed ?? grid;
    const viewRange =
      transposed !== null
        ? {
            sheet: range.sheet,
            startRow: 0,
            startCol: 0,
            endRow: viewGrid.length - 1,
            endCol: viewGrid[0]!.length - 1,
          }
        : range;
    const extracted = await extractDataSchema(async () => viewGrid, viewRange, {
      headerRow: opts.headerRow,
    });
    let schema =
      transposed !== null ? { ...extracted, rangeRef: a1Ref(range) } : extracted;
    if (transposed !== null) {
      // #152 remaining scope: the transposed dimension column holds
      // year labels as strings, which infer as NUMERIC (numeric
      // strings count as numbers) — without this the schema has zero
      // categorical columns and aggregate plans fail with 'group-by
      // needs a category column' unless the dimension name happens to
      // match a hint exactly. That is the round-4 leg-A failure:
      // bounds starting at the years row exclude the 'Year' label, so
      // the dimension falls back to 'Category' and nothing matches.
      // The dimension is categorical by construction (labels, not
      // measures), so force column 0 to text with recomputed stats.
      const dimValues = (extracted.hasHeaderRow ? viewGrid.slice(1) : viewGrid).map(
        (row) => (row.length > 0 ? row[0]! : null),
      );
      schema = forceTextColumn(schema, 0, dimValues);
    }
    const plan = classifyAnalysisIntent(opts.intent);
    const source = new TemplatePythonGenerator().generate(schema, plan);

    const colCount = schema.columns.length;
    // Slice off exactly what the schema consumed as the header row — a
    // data-only range feeds EVERY row to the script (schema.hasHeaderRow
    // is the single decision point; never re-assume a header here).
    const dataRows = (schema.hasHeaderRow ? viewGrid.slice(1) : viewGrid).map((row) => {
      const out: AnalysisValue[] = [];
      for (let c = 0; c < colCount; c++) out.push(toAnalysisValue(c < row.length ? row[c] : null));
      return out;
    });
    const truncated = dataRows.length > MAX_ANALYSIS_ROWS;
    const input: AnalysisInput = {
      columns: schema.columns.map((c) => c.name),
      rows: truncated ? dataRows.slice(0, MAX_ANALYSIS_ROWS) : dataRows,
    };

    const result = await executeAnalysis(analysisPythonRunner, source, input, {
      timeoutMs: opts.timeoutMs,
    });
    if (!result.ok) throw new Error(result.error);

    const inputHash = hashInput(JSON.stringify(input));
    const artifact = makeArtifact({
      id: `analysis_${analysisSeq++}`,
      intent: opts.intent,
      plan,
      schemaSnapshot: schema,
      inputHash,
      pythonSource: source,
      scriptVersion: result.scriptVersion,
      result: result.analysis,
      chartSpec: result.chartSpec,
      principal: opts.principal,
    });
    await analysisStore.add(artifact);
    const summary = summarizeAnalysis(plan, result.analysis, schema.rangeRef);
    return {
      artifact,
      summary: truncated ? `${summary} (input truncated to ${MAX_ANALYSIS_ROWS} rows)` : summary,
    };
  }

  /**
   * Parse a "Sheet1!A1:D20" (or bare "A1:D20") range string from an
   * AnalysisPort request into sheet + bounds.
   */
  function parseRangeString(text: string): { sheet?: string; bounds?: { startRow: number; startCol: number; endRow: number; endCol: number } } {
    const t = text.trim();
    if (!t) return {};
    const bang = t.lastIndexOf('!');
    const sheet = bang >= 0 ? t.slice(0, bang).trim() || undefined : undefined;
    const parsed = parseA1Range(bang >= 0 ? t.slice(bang + 1) : t, sheet ?? '');
    if (!parsed) throw new Error(`cannot parse range "${text}"`);
    return {
      sheet,
      bounds: {
        startRow: parsed.startRow,
        startCol: parsed.startCol,
        endRow: parsed.endRow,
        endCol: parsed.endCol,
      },
    };
  }

  // Register this lane's port with the chat intent router
  // (agent/intentRouter.ts): dispatchIntent's 'analysis' route runs the
  // same deterministic pipeline as the analyze_data MCP tool above.
  registerIntentPorts({
    analysis: createAnalysisPort({
      runAnalysis: async ({ prompt, range, sheet }) => {
        const parsed = range ? parseRangeString(range) : {};
        const { artifact, summary } = await runAnalysisPipeline({
          intent: prompt,
          // #135: the client's active sheet wins; then the sheet
          // named in the range; then runAnalysisPipeline falls back
          // to the workbook's first sheet (never a hardcoded name).
          sheet: sheet ?? parsed.sheet,
          bounds: parsed.bounds,
          principal: boundPrincipal ?? MCP_PRINCIPAL,
        });
        return { summary, chartSpec: artifact.chartSpec };
      },
    }),
  });

  function artifactRangeOf(artifact: AnalysisArtifact): AnalysisRangeRef {    const ref = artifact.schemaSnapshot.rangeRef;
    const bang = ref.lastIndexOf('!');
    if (bang < 0) throw new Error(`stored artifact has an unparseable range "${ref}"`);
    const sheet = ref.slice(0, bang);
    const parsed = parseA1Range(ref.slice(bang + 1), sheet);
    if (!parsed) throw new Error(`stored artifact has an unparseable range "${ref}"`);
    return { sheet: parsed.sheet, startRow: parsed.startRow, startCol: parsed.startCol, endRow: parsed.endRow, endCol: parsed.endCol };
  }

  const analysisBoundsSchema = {
    startRow: z.number().int().min(0).optional(),
    startCol: z.number().int().min(0).optional(),
    endRow: z.number().int().min(0).optional(),
    endCol: z.number().int().min(0).optional(),
  };

  server.tool(
    'analyze_data',
    'Run the data-analysis pipeline on a sheet range: extracts the data schema, classifies the analytical intent ("analyze the data and show me a diagram", "pivot this", "forecast next quarter", ...), generates a versioned Python script, executes it deterministically in the sandbox, and returns the analysis summary plus a Chart.js spec. The script is persisted as a versioned, re-runnable analysis artifact. Reads go through authorize(): denied cells are excluded, never leaked. Header contract: headerRow=true DECLARES that the range INCLUDES the sheet\'s header row (it names the columns and is not itself data); headerRow=false DECLARES a data-only range — EVERY row in it is data and is aggregated, the first row is never dropped. When headerRow is omitted, a text header row over numeric columns is auto-detected; a data-only range is always aggregated in full.',
    {
      intent: z.string().min(1).max(2000),
      sheet: z.string().min(1).optional(),
      ...analysisBoundsSchema,
      headerRow: z.boolean().optional(),
      timeoutMs: z.number().int().positive().max(30_000).optional(),
      principal: principalSchema,
    },
    async (args): Promise<ToolResult> => {
      try {
        const { principal } = principalOf(args);
        const hasBounds =
          args.startRow !== undefined ||
          args.startCol !== undefined ||
          args.endRow !== undefined ||
          args.endCol !== undefined;
        if (hasBounds && (args.startRow === undefined || args.startCol === undefined || args.endRow === undefined || args.endCol === undefined)) {
          return errorResult('startRow/startCol/endRow/endCol must be given together');
        }
        const { artifact, summary } = await runAnalysisPipeline({
          intent: args.intent,
          sheet: args.sheet,
          bounds: hasBounds
            ? { startRow: args.startRow!, startCol: args.startCol!, endRow: args.endRow!, endCol: args.endCol! }
            : undefined,
          headerRow: args.headerRow,
          principal,
          timeoutMs: args.timeoutMs,
        });
        return okResult({
          artifactId: artifact.id,
          summary,
          intentKind: artifact.plan.intentKind,
          rangeRef: artifact.schemaSnapshot.rangeRef,
          analysis: artifact.result,
          chartSpec: artifact.chartSpec,
          scriptVersion: artifact.scriptVersion,
        });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'rerun_analysis',
    'Deterministically re-execute a stored analysis artifact: re-reads the same range, re-runs the exact persisted Python script in the sandbox, and reports whether the input data changed since the original run. The stored artifact is immutable (auditability); the fresh result is returned, not persisted over it.',
    {
      artifactId: z.string().min(1),
      timeoutMs: z.number().int().positive().max(30_000).optional(),
      principal: principalSchema,
    },
    async (args): Promise<ToolResult> => {
      try {
        const { principal } = principalOf(args);
        const artifact = (await analysisStore.all()).find((a) => a.id === args.artifactId);
        if (!artifact) return errorResult(`unknown analysis "${args.artifactId}"`);
        const range = artifactRangeOf(artifact);
        const { grid } = await readAnalysisGrid(range, principal);
        const colCount = artifact.schemaSnapshot.columns.length;
        // Reproduce the ORIGINAL run's input: slice iff the stored schema
        // consumed a header row (migrated snapshots always carry the flag;
        // pre-contract artifacts carry true, matching their original run).
        // Horizontal layouts are re-derived deterministically from the
        // freshly-read grid, exactly as the original run derived them —
        // otherwise a transposed script would receive raw rows.
        const viewGrid = transposeHorizontalYearGrid(grid) ?? grid;
        const dataRows = (artifact.schemaSnapshot.hasHeaderRow ? viewGrid.slice(1) : viewGrid).map((row) => {
          const out: AnalysisValue[] = [];
          for (let c = 0; c < colCount; c++) out.push(toAnalysisValue(c < row.length ? row[c] : null));
          return out;
        });
        const input: AnalysisInput = {
          columns: artifact.schemaSnapshot.columns.map((c) => c.name),
          rows: dataRows.slice(0, MAX_ANALYSIS_ROWS),
        };
        const inputHash = hashInput(JSON.stringify(input));
        const result = await executeAnalysis(analysisPythonRunner, artifact.pythonSource, input, {
          timeoutMs: args.timeoutMs,
        });
        if (!result.ok) return errorResult(result.error);
        return okResult({
          artifactId: artifact.id,
          summary: summarizeAnalysis(artifact.plan, result.analysis, artifact.schemaSnapshot.rangeRef),
          analysis: result.analysis,
          chartSpec: result.chartSpec,
          inputChanged: inputHash !== artifact.inputHash,
          inputHash,
          previousInputHash: artifact.inputHash,
        });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'list_analyses',
    'List stored analysis artifacts (newest first): id, intent, intent kind, range, script version, creation time. The full Python source is NOT returned here; fetch it via rerun_analysis semantics or the artifact store.',
    { principal: principalSchema },
    async (args): Promise<ToolResult> => {
      try {
        void principalOf(args);
        const analyses = (await analysisStore.all())
          .slice()
          .reverse()
          .map(analysisSummary);
        return okResult({ analyses });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'execute_code',
    'Run code in the Icecream Sheets sandbox. JavaScript: the script completion value is the result and `args` holds the inputs. Python: `args` is a dict and the program must assign `result`.',
    {
      language: z.enum(['javascript', 'python']),
      code: z.string().min(1).max(100_000),
      args: z.record(z.string(), z.unknown()).optional(),
      timeoutMs: z.number().int().positive().max(30_000).optional(),
      principal: principalSchema,
    },
    async (args): Promise<ToolResult> => {
      try {
        // The node:vm / node:child_process sandboxes cannot run in a
        // browser bundle. Fail cleanly instead of a cryptic fetch error.
        if (typeof process === 'undefined' || !process.versions?.node) {
          return errorResult('code execution sandbox is not available in the browser build');
        }
        const sandboxArgs: Record<string, unknown> = { ...(args.args ?? {}) };
        // Variable specifier + @vite-ignore: bundlers cannot analyze this
        // import, so node:vm / node:child_process are never bundled.
        const jsMod = './sandbox/javascript.js';
        const pyMod = './sandbox/python.js';
        const outcome =
          args.language === 'javascript'
            ? (await import(/* @vite-ignore */ jsMod)).runJavaScript(args.code, sandboxArgs, {
                timeoutMs: args.timeoutMs,
              })
            : (await import(/* @vite-ignore */ pyMod)).runPython(args.code, sandboxArgs, {
                timeoutMs: args.timeoutMs,
              });
        if ('error' in outcome) {
          return errorResult(outcome.error);
        }
        // Round-trip so only JSON-transportable values leave the sandbox.
        let value: unknown = outcome.value;
        try {
          value = JSON.parse(JSON.stringify(value)) as unknown;
        } catch {
          return errorResult('sandbox result is not JSON-serializable');
        }
        return okResult({ value });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  /**
   * Connected data sources (core architecture: the spreadsheet is a VIEW
   * over any data source). Connectors fetch and normalize to TableData,
   * which is materialized as a sheet in the engine's typed computational
   * view — read_cells and every other view consumer see it unchanged.
   * Bindings (spec + sheet + last refresh) live in the service metadata
   * store. Specs never carry secrets: credentialRef resolves through the
   * vault seam in ServerOptions.dataSources.
   */
  const dataSourceRegistry = createConnectorRegistry();
  const dataSourceStore = createAsyncDataSourceStore(
    metadataAsyncPersistence,
  );
  const dataSourceDeps: ConnectorDeps = {
    fetchText: options?.dataSources?.fetchText,
    resolveCredential: options?.dataSources?.resolveCredential,
    sqlDriver: options?.dataSources?.sqlDriver,
    maxRows: options?.dataSources?.maxRows,
  };

  function dataSourceSummary(binding: {
    id: string;
    sheetName: string;
    spec: ConnectorSpec;
    lastRefresh: string | null;
    rowCount: number;
    colCount: number;
  }): Record<string, unknown> {
    return {
      id: binding.id,
      sheet: binding.sheetName,
      label: binding.spec.label,
      kind: binding.spec.kind,
      lastRefresh: binding.lastRefresh,
      // Uniform rows semantics: tool outputs report DATA rows (excluding
      // the header row) — open_data_source/refresh_data_source return
      // table.rows.length. binding.rowCount is the service connector
      // layer's materialized SHEET-row count including the header
      // (bindingForOpen in packages/service/src/connectors/engine.ts:
      // rowCount = table.rows.length + 1; refresh planning depends on
      // that count), so data rows = rowCount - 1.
      rows: binding.rowCount - 1,
      columns: binding.colCount,
    };
  }

  server.tool(
    'list_data_sources',
    'List the registered connector kinds and the data sources currently bound to this workbook\'s sheets. Connected data lives in the engine, so read_cells sees it like any other sheet.',
    { principal: principalSchema },
    async (): Promise<ToolResult> => {
      try {
        return okResult({
          kinds: dataSourceRegistry.kinds().map((kind) => {
            const c = dataSourceRegistry.get(kind);
            return { kind, displayName: c.displayName, paramHelp: c.paramHelp };
          }),
          sources: (await dataSourceStore.all()).map(dataSourceSummary),
        });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  const connectorKindSchema = z.enum(['csv-url', 'json-url', 'rest-api', 'sql', 'google-sheets']);

  server.tool(
    'open_data_source',
    'Fetch a data source through a connector and materialize it as a new sheet in the typed computational view. The connector spec is stored as a source binding for later refresh_data_source calls. Secrets are never accepted here: authenticate with a vault credentialRef, not a secret value.',
    {
      kind: connectorKindSchema,
      label: z.string().min(1).max(120).optional(),
      params: z.record(z.string(), z.string()),
      credentialRef: z.string().min(1).max(200).optional(),
      sheetName: z.string().min(1).max(31).optional(),
      principal: principalSchema,
    },
    async (args): Promise<ToolResult> => {
      try {
        const { principal } = principalOf(args);
        const kind = args.kind as ConnectorKind;
        const spec: ConnectorSpec = {
          version: CONNECTOR_SPEC_VERSION,
          kind,
          label: args.label?.trim() || dataSourceRegistry.get(kind).displayName,
          params: args.params,
          ...(args.credentialRef ? { credentialRef: args.credentialRef } : {}),
        };
        const table = await dataSourceRegistry.fetch(spec, dataSourceDeps);
        // Awaited: the host may be an IPC-forwarding host (desktop MCP
        // parity) whose reads/writes resolve asynchronously.
        const existing = (await engine.snapshot()).sheets.map((s) => s.name);
        const name = args.sheetName
          ? uniqueSheetName(existing, sanitizeSheetName(args.sheetName))
          : uniqueSheetName(existing, spec.label);
        await writeTableToNewSheet(engine, name, table, principal);
        const binding = bindingForOpen(name, spec, table);
        await dataSourceStore.remove((b) => b.sheetName === name);
        await dataSourceStore.add(binding);
        return okResult({
          sheet: name,
          rows: table.rows.length,
          columns: table.columns,
          label: spec.label,
        });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'refresh_data_source',
    'Re-fetch the connector behind a bound sheet and atomically swap its data region (writes then stale-tail clears, in one pass). Cells outside the previously materialized region are never touched.',
    {
      sheet: z.string().min(1).optional(),
      id: z.string().min(1).optional(),
      principal: principalSchema,
    },
    async (args): Promise<ToolResult> => {
      try {
        const { principal } = principalOf(args);
        if (!args.sheet && !args.id) {
          return errorResult('pass "sheet" or "id" to select the bound source');
        }
        const binding = (await dataSourceStore.all())
          .find((b) => (args.sheet ? b.sheetName === args.sheet : b.id === args.id));
        if (!binding) {
          return errorResult(
            `no connected data source bound to ${args.sheet ? `sheet "${args.sheet}"` : `id "${args.id}"`}`,
          );
        }
        const table = await dataSourceRegistry.fetch(binding.spec, dataSourceDeps);
        const plan = planSheetRefresh(binding.rowCount, binding.colCount, table);
        // Awaited: the host may be an IPC-forwarding host (desktop MCP
        // parity) whose execute() resolves asynchronously.
        await applyRefreshPlanToHost(engine, binding.sheetName, plan, principal);
        const updated = {
          ...binding,
          lastRefresh: new Date().toISOString(),
          rowCount: plan.rowCount,
          colCount: plan.colCount,
        };
        await dataSourceStore.remove((b) => b.sheetName === binding.sheetName);
        await dataSourceStore.add(updated);
        return okResult({
          sheet: binding.sheetName,
          rows: table.rows.length,
          columns: table.columns,
          refreshedAt: updated.lastRefresh,
        });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    'rtd_publish',
    'Publish a real-time data value to an RTD topic. Cells using RTD(progId, server, topic, ...) update on the next recalculation, which this tool triggers automatically.',
    {
      progId: z.string().min(1),
      server: z.string().min(1),
      topics: z.array(z.string().min(1)).min(1),
      value: z.union([z.number(), z.string(), z.boolean()]),
      principal: principalSchema,
    },
    async (args): Promise<ToolResult> => {
      try {
        const { principal } = principalOf(args);
        // RTD is a real-time feed; publishing requires write on the workbook.
        // The topic namespace is global per server instance.
        publishRtdTopic(args.progId, args.server, args.topics, args.value);
        // Trigger recalculation so RTD() formulas pick up the new value.
        // Awaited: the host may be an IPC-forwarding host (desktop MCP
        // parity) whose execute() resolves asynchronously.
        const recalc = await engine.execute({ cmd: 'recalculate', auth: { principal } });
        if (!recalc.ok) {
          return errorResult(`published but recalc failed: ${recalc.error}`);
        }
        return okResult({
          topic: [args.progId, args.server, ...args.topics].join('|'),
          value: args.value,
        });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // Skill packs (src/packs/): installable tool bundles registered
  // through the same server.tool path as the core tools above. The
  // PackContext is built from the same closures (engine, principalOf,
  // ok/error envelopes), so pack tools are indistinguishable from core
  // tools on the wire and every engine access stays authorized.
  const installedPacks = resolveSkillPacks(options?.packs);
  const packCtx = {
    tool: (
      name: string,
      description: string,
      schema: Record<string, z.ZodTypeAny>,
      handler: (args: Record<string, unknown>) => Promise<ToolResult>,
    ) => {
      server.tool(name, description, schema, handler);
    },
    prompt: (name: string, description: string, text: string) => {
      server.prompt(name, description, () => ({
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }],
      }));
    },
    engine,
    authOf: principalOf,
    principalSchema,
    ok: okResult,
    error: errorResult,
    toJson: toJsonMatrix,
    charts: options?.charts,
  } as unknown as PackContext;
  for (const pack of installedPacks) {
    pack.register(packCtx);
  }

  server.tool(
    'list_skill_packs',
    'List the skill packs installed in this server: id, name, version, description, the tools each pack provides, and its example prompts. Packs are selected at server construction (ServerOptions.packs / MCP_PACKS); see packs/README.md.',
    { principal: principalSchema },
    async (): Promise<ToolResult> => okResult({ packs: installedPacks.map(manifestOf) }),
  );

  return server;
}

/** Run the server on stdio (the production entrypoint). */
export async function runServer(): Promise<void> {
  const server = createServer(undefined, { packs: packsFromEnv(process.env.MCP_PACKS) });
  // Variable specifier + @vite-ignore: bundlers cannot analyze this import,
  // so the node-only transport is never bundled for the browser.
  const stdioMod = '@modelcontextprotocol/sdk/server/stdio.js';
  const { StdioServerTransport } = await import(/* @vite-ignore */ stdioMod);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
