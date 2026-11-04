/**
 * The async engine transport boundary (Cycle 10, Phase 2).
 *
 * The engine PROTOCOL (EngineHost: execute / readCell / readRange / …) is
 * synchronous — it is the API of the in-process engine (web local mode,
 * desktop main-process engine). Every host that drives an engine living
 * in ANOTHER process must cross an asynchronous boundary instead:
 *
 *   web, gateway mode → HTTP through the API gateway
 *     (GatewayEngineTransport below, fetch-based)
 *   desktop renderer  → Electron IPC to the main-process engine
 *     (a future IpcEngineTransport over window.icecream.engine.*,
 *     implemented against THIS interface)
 *   a worker host     → MessagePort postMessage (same shape)
 *
 * Rule: hosts depend on this interface, never on a concrete wire. New
 * hosts implement an adapter ON this pattern; the sync EngineHost surface
 * stays the in-process protocol, and async callers (file open, reset,
 * event polling, language switch) go through the transport.
 *
 * Designed with the consolidated view/mutation rule in mind: VIEW data
 * streams in progressively (sheet names → viewport cells → formats →
 * overlays), while MUTATION (edit / save / autosave / export) is gated
 * until the open completes 100%. The load call below is the gate's hinge:
 * it resolves only when the server has parsed the file, built the engine
 * workbook, and registered every overlay's metadata.
 */
import type {
  CellRef,
  CommandResult,
  DefinedName,
  EngineCommand,
  EngineEvent,
  RangeRef,
  TypedValue,
  WorkbookSnapshot,
} from '@icecream-sheets/engine';
import type { FormatsWire, TableDef } from '@icecream-sheets/xlsx-adapter';
import {
  GatewayClient,
  type EngineRehydrateResult,
  type EngineSessionStatus,
} from './gatewayClient';

export interface EngineCellRead {
  value: TypedValue;
  formula?: string;
}

export interface EngineRangeRead {
  values: TypedValue[][];
  formulas: (string | null)[][];
}

/** One sheet's non-row payload from a server-side open. */
export interface EngineLoadedSheet {
  name: string;
  /** Run-length wire encoding of the per-cell number formats. */
  formats: FormatsWire;
  /** Full per-cell styles keyed "row:col" (defect D4), when the file has any. */
  styles?: Record<string, import('@icecream-sheets/engine').CellStyle>;
  colWidths?: Record<string, number>;
  rowHeights?: Record<string, number>;
  hiddenCols?: number[];
  hiddenRows?: number[];
  /** Adapter table definitions (Phase E whitelist fix) — see engineSvc loadResponse. */
  tables?: TableDef[];
}

/**
 * One mirrored cell: formula (input), cached value, data type (kind).
 */
export interface EngineMirrorCell {
  row: number;
  col: number;
  /** Raw input: literal value, or formula text beginning with '='. */
  input: string | number | boolean | null;
  value: TypedValue;
}

/** Complete engine-build payload for below-flag workbooks. */
export interface EngineWorkbookMirror {
  sheets: Array<{ name: string; cells: EngineMirrorCell[] }>;
  definedNames?: DefinedName[];
}

/**
 * What a server-side open returns: sheet names plus everything a local
 * open hydrates the browser stores from (formats, adapter metadata,
 * defined names) — never the rows themselves (the browser reads
 * viewports lazily afterwards).
 *
 * ONE FLAG, TWO CONSEQUENCES (user's final rule, Cycle 10 — canonical
 * wording in packages/engine/src/parallel/types.ts):
 *   Flag ON (workbook cell count > threshold): NO mirror ships — the
 *     client receives values only (viewport reads), cannot recalc
 *     anything, and EVERY edit routes to the server unconditionally;
 *     the server runs multithreaded recalc (independent chains in
 *     parallel Excel-style, dependent chains serialize).
 *   Flag OFF: the full mirror ships — every cell's formula + cached
 *     value + data type — so the client builds a local engine and the
 *     local routing rules apply; server multithreading stays off.
 * `mirror` is present iff the flag is OFF: the mirror decision and the
 * server-threading decision are the same single flag acting as a unit,
 * never two separate checks. Local-calc routing rules are evaluated
 * ONLY when a mirror is present.
 */
export interface EngineLoadResult {
  ok: boolean;
  sheets: string[];
  file: {
    sheets: EngineLoadedSheet[];
    /** Adapter metadata, binary-safe JSON (decode with the xlsx-adapter). */
    metadata: Record<string, unknown>;
    definedNames?: DefinedName[];
  };
  /** Per-sheet non-empty cell counts by column (chart name resolution). */
  columnCounts: Record<string, number[]>;
  /**
   * The deployment session id this load introduced (gateway package,
   * session registry extension): lifecycle calls and — in signed mode —
   * access tokens are scoped to it. Absent from older servers.
   */
  sessionId?: string;
  /** The local mirror — present iff the auto-flag is OFF. */
  mirror?: EngineWorkbookMirror;
  /**
   * Cell values PUSHED with the load stream so far (accumulated): the
   * file's stored values for painting before/without pull reads. Present
   * only on progressive accumulations; the terminal /load result of a
   * non-streaming server carries none (first paint then uses the bulk
   * pull pipeline instead).
   */
  streamedCells?: Record<string, StreamedSheetCells['cells']>;
}

/**
 * The progressive-open stream (Cycle 10 Phase 4 — time-to-first-page,
 * display-before-graph). The server (engineSvc.ts, POST
 * /api/engine/load/stream) emits NDJSON chunks:
 *   meta           sheet names/order, defined names, zip metadata and
 *                  progress totals — the client renders the app frame +
 *                  sheet tabs from this ALONE, before any cell data.
 *   rows           per-sheet row chunks, sheet order, visible-window-
 *                  first within sheet 1: raw inputs (`rows`), the file's
 *                  CACHED display values (`display`), per-chunk format
 *                  codes (`formats`, FormatsWire), and `pendingCalc`
 *                  "row:col" refs — formula cells saved WITHOUT a cached
 *                  value. First paint consumes `display`: real values,
 *                  never gated on the engine graph build. Pending cells
 *                  paint as LOADING, never as a final blank/0.
 *   sheet-complete one per sheet, in order.
 *   data-done      every cell chunk is out; the engine graph build is
 *                  still running behind the stream → the client shows
 *                  "Calculating…", never a stuck percentage.
 *   built          terminal: carries the exact /load response (mirror
 *                  included when the flag ships one). Mutation (edit /
 *                  save / export) unlocks ONLY here — 100% load.
 *   error          terminal failure.
 * First paint depends ONLY on parsed values + cached formula results;
 * the graph build is never a paint prerequisite (user's hard rule:
 * time-to-first-page ≤ ~3s at EVERY percentile).
 */
/** One sheet's pushed cell payload: the file's own STORED values. */
export interface StreamedSheetCells {
  name: string;
  /**
   * Stored (cached) values from the file itself — every .xlsx stores each
   * formula's last calculated result, so these are REAL data paintable
   * before the engine build finishes. `formula` rides along when the
   * stream carries it (formula bar / editor seeding).
   */
  cells: Array<{
    row: number;
    col: number;
    value: TypedValue;
    formula?: string;
    /**
     * TRUE when this formula cell was saved WITHOUT a cached value
     * (e.g. openpyxl-generated files) — there is nothing real to paint
     * until the engine calc lands. The client renders these as PENDING
     * (loading state), NEVER as a final-looking blank or 0 — Excel
     * behaves the same way, and honest pending beats wrong data.
     */
    pending?: boolean;
  }>;
}

/** Progress counters carried by every stream chunk (server-known). */
export interface StreamProgress {
  sheetsDone: number;
  cellsDone: number;
  totalSheets: number;
  totalCells: number | null;
}

export interface StreamMetaChunk {
  type: 'meta';
  sheets: string[];
  totalSheets: number;
  /** Estimated total non-empty cells (progress denominator). */
  totalCells: number | null;
  totalSheetXmlBytes?: number;
  definedNames?: DefinedName[];
  metadata: Record<string, unknown>;
  progress: StreamProgress;
  elapsedMs?: number;
}

/**
 * One row chunk. `rows` are the raw inputs (formula strings start with
 * '='); `display` are the file's cached display values (formula cells
 * paint their last calculated result; pending formula cells are null);
 * `pendingCalc` holds "row:col" refs (absolute) of formula cells with
 * NO cached value in the file.
 */
export interface StreamRowsChunk {
  type: 'rows';
  sheet: string;
  index: number;
  startRow: number;
  rows: unknown[][];
  display: unknown[][] | null;
  formats: FormatsWire;
  pendingCalc: string[];
  progress: StreamProgress;
  elapsedMs?: number;
}

export interface StreamSheetCompleteChunk {
  type: 'sheet-complete';
  sheet: string;
  index: number;
  progress: StreamProgress;
  elapsedMs?: number;
}

export interface StreamDataDoneChunk {
  type: 'data-done';
  /** Exact total non-empty cells (progress denominator, final). */
  totalCells: number;
  parseTimings?: unknown;
  progress: StreamProgress;
  elapsedMs?: number;
}

export interface StreamBuiltChunk {
  type: 'built';
  /** The exact /load response — the terminal, authoritative payload. */
  response: EngineLoadResult;
  elapsedMs?: number;
}

export interface StreamErrorChunk {
  type: 'error';
  error: string;
  elapsedMs?: number;
}

/** One raw chunk off the wire (POST /api/engine/load/stream). */
export type RawStreamChunk =
  | StreamMetaChunk
  | StreamRowsChunk
  | StreamSheetCompleteChunk
  | StreamDataDoneChunk
  | StreamBuiltChunk
  | StreamErrorChunk;

/**
 * The per-chunk SUMMARY handed to UI consumers alongside the accumulated
 * load result: everything the StatusBar / progress UI needs, derived
 * from the raw chunk (progress = cells processed over total workbook
 * cells when the stream knows the total, else sheets over sheets).
 */
export interface ProgressiveLoadChunk {
  /** Raw chunk type ('meta' | 'rows' | …), or 'fallback' for /load. */
  rawType: string;
  /** 0–100 load progress; at `built` the caller flips to ready. */
  progressPct?: number;
  /**
   * TRUE once `data-done` landed and until `built` arrives: all cell
   * data is in, the engine build (calc) is still running. The StatusBar
   * shows "Calculating…" then — distinctly, never a stuck percentage.
   */
  calculating?: boolean;
  /** Set when the stream sent an `error` chunk (terminal failure). */
  streamError?: string;
  /** The raw chunk itself (hosts seed pushed cells from `rows` chunks). */
  raw?: RawStreamChunk;
}

/** CellInput (adapter domain) → engine TypedValue for painting. */
export function cellInputToTypedValue(input: unknown): TypedValue {
  if (input === null || input === undefined) return { kind: 'null', value: null };
  if (typeof input === 'number') return { kind: 'number', value: input };
  if (typeof input === 'boolean') return { kind: 'boolean', value: input };
  if (typeof input === 'string') return { kind: 'string', value: input };
  if (typeof input === 'object' && 'kind' in (input as Record<string, unknown>)) {
    return input as TypedValue; // already a TypedValue (error/image cells)
  }
  return { kind: 'string', value: String(input) };
}

/**
 * Convert one `rows` chunk into paintable streamed cells: DISPLAY values
 * (the file's cached results) — never the raw inputs — with pending
 * formula cells carried as `pending: true` and NO value (the view must
 * render them as loading, never as a final blank/0). Formula text rides
 * along so the formula bar can show it once the cell is selected.
 */
export function streamedCellsFromChunk(chunk: StreamRowsChunk): StreamedSheetCells {
  const pending = new Set(chunk.pendingCalc ?? []);
  const cells: StreamedSheetCells['cells'] = [];
  const display = chunk.display ?? [];
  for (let r = 0; r < display.length; r++) {
    const absRow = chunk.startRow + r;
    const row = display[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      const key = `${absRow}:${c}`;
      const rawInput = chunk.rows?.[r]?.[c];
      const formula =
        typeof rawInput === 'string' && rawInput.startsWith('=') ? rawInput : undefined;
      if (pending.has(key)) {
        cells.push({
          row: absRow,
          col: c,
          value: { kind: 'null', value: null },
          ...(formula ? { formula } : {}),
          pending: true,
        });
        continue;
      }
      const disp = row[c];
      if (disp === null || disp === undefined) continue;
      cells.push({
        row: absRow,
        col: c,
        value: cellInputToTypedValue(disp),
        ...(formula ? { formula } : {}),
      });
    }
  }
  return { name: chunk.sheet, cells };
}

/** Merge a chunk's format-code runs into a sheet's accumulated FormatsWire. */
function mergeFormatsWireInto(target: FormatsWire, next: FormatsWire): void {
  const remap = new Map<number, number>();
  next.codes.forEach((code, i) => {
    let idx = target.codes.indexOf(code);
    if (idx < 0) {
      idx = target.codes.length;
      target.codes.push(code);
    }
    remap.set(i, idx);
  });
  for (const [col, runs] of Object.entries(next.columns ?? {})) {
    const list = (target.columns[col] ??= []);
    for (const [sr, er, ci] of runs) list.push([sr, er, remap.get(ci) ?? ci]);
    list.sort((a, b) => a[0] - b[0]);
  }
}

/** Percent from a progress block (cells first, sheets as fallback). */
export function streamProgressPct(progress: StreamProgress | undefined): number | undefined {
  if (!progress) return undefined;
  if (progress.totalCells && progress.totalCells > 0) {
    return Math.min(100, Math.round((progress.cellsDone / progress.totalCells) * 100));
  }
  if (progress.totalSheets > 0) {
    return Math.min(100, Math.round((progress.sheetsDone / progress.totalSheets) * 100));
  }
  return undefined;
}

/**
 * Bounded streamed-cell accumulation (Cycle 10 closure W16): the
 * accumulated `streamedCells` record is a SECOND full copy of the
 * workbook in the tab (the host already seeds every chunk's cells into
 * the view cache from the raw chunk itself). Its only consumer is the
 * terminal re-seed in App's open flow — a belt-and-braces pass over
 * cells the host seeded per chunk. Retaining it unboundedly costs
 * >1 GB at P99 scale and kills the renderer during ingest, so once an
 * accumulation would exceed this many cells it is DROPPED (the result
 * simply carries no streamedCells; per-chunk host seeding is
 * unaffected, and post-load navigation re-reads through the engine
 * read path). Below the cap — including all of P95 (1.8 M cells) —
 * accumulation behaves exactly as before.
 */
export const STREAMED_CELLS_RETAIN_LIMIT = 2_000_000;

/** Results whose streamed-cell accumulation was dropped (see above). */
const droppedStreamedCells = new WeakSet<EngineLoadResult>();

function retainedStreamedCount(cells: Record<string, StreamedSheetCells['cells']> | undefined): number {
  if (!cells) return 0;
  let n = 0;
  for (const arr of Object.values(cells)) n += arr.length;
  return n;
}

/** Accumulate raw stream chunks into the current-best load result. */
export function mergeLoadChunks(
  prev: EngineLoadResult | null,
  raw: RawStreamChunk,
): EngineLoadResult {
  if (raw.type === 'built') {
    // The authoritative terminal payload; keep any pushed cells (they
    // are already part of the build, but late `rows` should never
    // clobber the built result's own streamedCells, if any). A dropped
    // accumulation (W16 bound) stays dropped.
    return {
      ...raw.response,
      ...(prev?.streamedCells && !raw.response.streamedCells && !(prev && droppedStreamedCells.has(prev))
        ? { streamedCells: prev.streamedCells }
        : {}),
    };
  }
  if (raw.type === 'error') return prev ?? emptyLoadResult();

  const sheetsByName = new Map<string, EngineLoadedSheet>();
  for (const s of prev?.file.sheets ?? []) sheetsByName.set(s.name, s);
  const names: string[] =
    raw.type === 'meta' ? raw.sheets : prev?.sheets ?? (raw.type === 'rows' ? [raw.sheet] : []);
  for (const n of names) {
    if (!sheetsByName.has(n)) {
      sheetsByName.set(n, { name: n, formats: { codes: [], columns: {} } });
    }
  }

  // Per-chunk format codes accumulate into the sheet's format table so
  // first paint can apply real number formats progressively.
  if (raw.type === 'rows' && raw.formats) {
    const entry = sheetsByName.get(raw.sheet);
    if (entry) mergeFormatsWireInto(entry.formats, raw.formats);
  }

  const streamedCells: Record<string, StreamedSheetCells['cells']> = {
    ...(prev?.streamedCells ?? {}),
  };
  // W16 bound: once dropped (or once this chunk would push the
  // accumulation past the retain limit), stop converting + retaining —
  // the host seeds this chunk from `raw` itself, so nothing is lost.
  let dropStreamed = prev !== null && droppedStreamedCells.has(prev);
  if (raw.type === 'rows' && !dropStreamed) {
    const conv = streamedCellsFromChunk(raw);
    if (retainedStreamedCount(prev?.streamedCells) + conv.cells.length > STREAMED_CELLS_RETAIN_LIMIT) {
      dropStreamed = true;
    } else {
    const prior = streamedCells[conv.name] ?? [];
    // W15 (P95 TTFP/ingest): fast path for the stream's normal shape —
    // per-sheet chunks arrive in row order and are disjoint, so when
    // this chunk starts strictly after the accumulated tail, a plain
    // append replaces the old per-chunk rebuild of a "row:col"-keyed
    // Map over EVERY accumulated cell (O(total) string keys per chunk,
    // O(total²/chunk) over the ingest). Overlapping or out-of-order
    // chunks keep the exact dedupe-by-ref merge below.
    const first = conv.cells[0];
    const lastPrior = prior[prior.length - 1];
    if (
      !lastPrior ||
      (first !== undefined &&
        (first.row > lastPrior.row ||
          (first.row === lastPrior.row && first.col > lastPrior.col)))
    ) {
      streamedCells[conv.name] = [...prior, ...conv.cells];
    } else {
      const byRef = new Map<string, StreamedSheetCells['cells'][number]>();
      for (const cell of prior) byRef.set(`${cell.row}:${cell.col}`, cell);
      for (const cell of conv.cells) byRef.set(`${cell.row}:${cell.col}`, cell);
      streamedCells[conv.name] = [...byRef.values()];
    }
    }
  }

  const result: EngineLoadResult = {
    ok: true,
    sheets: names,
    file: {
      sheets: names
        .map((n) => sheetsByName.get(n))
        .filter((s): s is EngineLoadedSheet => !!s),
      metadata: {
        ...(prev?.file.metadata ?? {}),
        ...(raw.type === 'meta' ? raw.metadata : {}),
      },
      ...(raw.type === 'meta' && raw.definedNames
        ? { definedNames: raw.definedNames }
        : prev?.file.definedNames
          ? { definedNames: prev.file.definedNames }
          : {}),
    },
    columnCounts: prev?.columnCounts ?? {},
    ...(prev?.mirror ? { mirror: prev.mirror } : {}),
    ...(!dropStreamed && Object.keys(streamedCells).length > 0 ? { streamedCells } : {}),
  };
  if (dropStreamed) droppedStreamedCells.add(result);
  return result;
}

/** A zero-state load result (used when a stream errors before meta). */
function emptyLoadResult(): EngineLoadResult {
  return { ok: true, sheets: [], file: { sheets: [], metadata: {} }, columnCounts: {} };
}

/** The wire contract every remote engine host adapter implements. */
export interface AsyncEngineTransport {
  /** Open a file server-side (base64 bytes). Resolves at 100% load. */
  loadXlsx(base64: string): Promise<EngineLoadResult>;
  /**
   * Progressive open (optional): emit chunks as the server builds —
   * `onChunk` fires per chunk with the ACCUMULATED load result and
   * whether it is terminal. Resolves with the terminal result.
   */
  loadXlsxProgressive?(
    base64: string,
    onChunk: (accumulated: EngineLoadResult, done: boolean, chunk: ProgressiveLoadChunk) => void,
  ): Promise<EngineLoadResult>;
  /** Reset to a blank workbook. */
  reset(): Promise<void>;
  /** Sheet names only — never a snapshot pull for names. */
  sheetNames(): Promise<string[]>;
  execute(cmd: EngineCommand, opts?: { ackChecksum?: boolean }): Promise<CommandResult>;
  readCell(ref: CellRef): Promise<EngineCellRead>;
  readRange(range: RangeRef): Promise<EngineRangeRead>;
  readSheet(sheet: string): Promise<TypedValue[][]>;
  usedRange(sheet: string): Promise<RangeRef | null>;
  snapshot(): Promise<WorkbookSnapshot>;
  events(since: number): Promise<Array<{ seq: number; event: EngineEvent }>>;
}

/** The gateway transport: AsyncEngineTransport over fetch/HTTP. */
export class GatewayEngineTransport implements AsyncEngineTransport {
  constructor(private readonly client: GatewayClient) {}

  loadXlsx(base64: string): Promise<EngineLoadResult> {
    return this.client.engineLoadXlsxAsync(base64);
  }

  /**
   * Progressive open over the gateway stream endpoint
   * (POST /api/engine/load/stream, NDJSON chunks in the server's schema —
   * see the stream doc above). Chunks are accumulated with
   * `mergeLoadChunks`; `onChunk` fires per chunk with the accumulated
   * result, a per-chunk summary (progress %, Calculating… state, raw
   * chunk), and `done` only at the terminal `built` chunk. When the
   * stream cannot be opened at all (older server / transport failure
   * before the first chunk), the client falls back to the classic /load
   * and reports it as one synthetic terminal chunk — the consumption
   * contract is identical, painting is simply not early.
   */
  async loadXlsxProgressive(
    base64: string,
    onChunk: (accumulated: EngineLoadResult, done: boolean, chunk: ProgressiveLoadChunk) => void,
  ): Promise<EngineLoadResult> {
    let accumulated: EngineLoadResult | null = null;
    let calculating = false;
    let streamError: string | null = null;
    let sawBuilt = false;
    const emit = (raw: RawStreamChunk): EngineLoadResult => {
      accumulated = mergeLoadChunks(accumulated, raw);
      if (raw.type === 'data-done') calculating = true;
      if (raw.type === 'built') {
        calculating = false;
        sawBuilt = true;
      }
      if (raw.type === 'error') streamError = raw.error;
      const progress =
        raw.type === 'data-done'
          ? { ...raw.progress, totalCells: raw.totalCells }
          : 'progress' in raw
            ? raw.progress
            : undefined;
      onChunk(accumulated, raw.type === 'built', {
        rawType: raw.type,
        progressPct: streamProgressPct(progress),
        calculating,
        ...(streamError ? { streamError } : {}),
        raw,
      });
      return accumulated;
    };
    try {
      const builtResponse = await this.client.engineLoadXlsxStream(base64, (chunk) => {
        try {
          emit(chunk as unknown as RawStreamChunk);
        } catch (e) {
          // A malformed chunk (or a consumer bug) must not break the
          // open; the terminal response carries the authoritative
          // payload. Logged, never silent — a swallowed chunk once hid
          // a host-side seeding failure during Phase 3 verification.
          console.warn('[engine-transport] stream chunk dropped:', e);
        }
      });
      if (streamError) throw new Error(streamError);
      if (builtResponse && !sawBuilt) {
        return emit({ type: 'built', response: builtResponse as EngineLoadResult });
      }
      if (accumulated) return accumulated;
      throw new Error('load/stream ended without a terminal chunk');
    } catch (e) {
      // Issue #18: same rule as the signed transport — an engine-reported
      // load failure (stream error chunk) surfaces as a failure, never
      // as the partial/empty accumulation.
      if (streamError) throw e instanceof Error ? e : new Error(streamError);
      if (accumulated) return accumulated;
      // No usable stream (endpoint absent / transport failure before any
      // chunk): the current /load response is the documented fallback.
      const full = await this.loadXlsx(base64);
      accumulated = mergeLoadChunks(null, { type: 'built', response: full });
      onChunk(accumulated, true, { rawType: 'fallback' });
      return accumulated;
    }
  }

  async reset(): Promise<void> {
    await this.client.engineResetAsync();
  }

  async sheetNames(): Promise<string[]> {
    const r = await this.client.engineSheetNamesAsync();
    return r.sheets;
  }

  execute(cmd: EngineCommand, opts?: { ackChecksum?: boolean }): Promise<CommandResult> {
    return this.client.engineExecuteAsync(cmd, opts);
  }

  readCell(ref: CellRef): Promise<EngineCellRead> {
    return this.client.engineReadAsync('cell', ref) as Promise<EngineCellRead>;
  }

  readRange(range: RangeRef): Promise<EngineRangeRead> {
    return this.client.engineReadAsync('range', range) as Promise<EngineRangeRead>;
  }

  async readSheet(sheet: string): Promise<TypedValue[][]> {
    const r = (await this.client.engineReadAsync('sheet', { sheet })) as { values: TypedValue[][] };
    return r.values;
  }

  async usedRange(sheet: string): Promise<RangeRef | null> {
    const r = (await this.client.engineReadAsync('usedrange', { sheet })) as {
      range: RangeRef | null;
    };
    return r.range ?? null;
  }

  snapshot(): Promise<WorkbookSnapshot> {
    return this.client.engineSnapshotAsync();
  }

  // -- session lifecycle (proxied through the gateway in proxy mode) ----

  sessionStatus(): Promise<EngineSessionStatus> {
    return this.client.engineSessionStatus();
  }

  sessionHeartbeat(sessionId: string): Promise<{ ok: true; lastActivityAt: number }> {
    return this.client.engineSessionHeartbeat(sessionId);
  }

  sessionRelease(
    sessionId: string,
    reason: string,
  ): Promise<{ ok: true; revision: number; checksum: string | null }> {
    return this.client.engineSessionRelease(sessionId, reason);
  }

  async sessionRehydrate(sessionId: string): Promise<EngineRehydrateResult> {
    // The gateway client throws on non-2xx; a checksum mismatch is a
    // 409 whose BODY carries checksumVerified:false — that shape must
    // reach the idle controller (it keeps editing locked), so map the
    // gateway error text back into the result shape when it names one.
    try {
      return await this.client.engineSessionRehydrate(sessionId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('409') || msg.toLowerCase().includes('checksum')) {
        return {
          ok: false,
          sessionId,
          revision: 0,
          checksum: null,
          checksumVerified: false,
          replayedOps: 0,
          error: msg,
        };
      }
      throw e;
    }
  }

  /**
   * Tab-close release in proxy mode: a keepalive fetch through the
   * gateway (sendBeacon cannot carry the Authorization header the
   * gateway requires). Fire-and-forget by design — pagehide cannot
   * await an answer.
   */
  releaseBeacon(sessionId: string, reason: string): boolean {
    return this.client.engineSessionReleaseBeacon(sessionId, reason);
  }

  async events(since: number): Promise<Array<{ seq: number; event: EngineEvent }>> {
    const r = await this.client.engineEventsAsync(since);
    return r as Array<{ seq: number; event: EngineEvent }>;
  }
}
