/**
 * Engine service: the calculation engine behind HTTP.
 *
 * Wraps EngineHost exactly the way the web app does:
 *   new Authorizer(protection.protectionPolicy(allowAllPolicy()))
 * + host.setHiddenCheck((ref, principal) =>
 *     protection.isHiddenFrom(ref.sheet, ref.row, ref.col, principal))
 * with `user:owner` exempt from cell hiding (the service's owner principal).
 *
 * The principal comes from the gateway-verified `x-principal` header
 * (fallback 'user' mirrors the single-user desktop default). The gateway
 * is the auth point; this service is the enforcement point for its data:
 * - /snapshot is permission-filtered per principal (cells the principal
 *   cannot read are dropped, never faked).
 * - command auth is stamped from x-principal before execute().
 *
 * Endpoints:
 * - GET  /health
 * - POST /execute              { cmd: EngineCommand } → CommandResult.
 *                              With `ackChecksum: true` on a setCell/
 *                              setFormula edit, a successful response
 *                              also carries `ack: { revision,
 *                              changedCellCount, checksum }` — the
 *                              checksum ack of HYBRID-CONSISTENCY.md §2
 *                              (serialization: engine ack-checksum.ts).
 * - POST /read                 { kind:'cell', ref } → { value, formula? }
 *                              { kind:'range', range } → { values, formulas }
 *                              { kind:'sheet', sheet } → { values }
 *                              { kind:'usedrange', sheet } → { range|null }
 *                              READ-DURING-BUILD (W20): while a /load or
 *                              /load/stream build is in flight, a read
 *                              PENDS on the build gate (bounded by
 *                              BUILD_WAIT_TIMEOUT_MS, the load route's
 *                              600 s class) and is then served from the
 *                              NEW workbook — never answered from the
 *                              previous/blank workbook (which threw
 *                              `Unknown sheet` → 500, or silently served
 *                              stale values when the sheet name existed
 *                              in both files). If the build FAILED, the
 *                              waiting read — and every read until the
 *                              next successful load or /reset — surfaces
 *                              the build's error instead.
 * - GET  /snapshot             → permission-filtered WorkbookSnapshot
 * - GET|POST /download         → SAVE/DOWNLOAD SEPARATION (2026-10-21):
 *                              for whole-workbook xlsx, this is a SAVE —
 *                              the live workbook is serialized server-side
 *                              (direct streaming pass over the permission-
 *                              filtered live model) and COMMITTED into
 *                              the library store as a fresh `dl_` entry;
 *                              the response is JSON metadata ONLY
 *                              ({ ok, entryId, revision, bytes, mode,
 *                              serializeMs, totalMs }) — no file bytes.
 *                              The client then fetches the bytes via
 *                              GET /storage/:entryId with a gateway-signed
 *                              URL. POST may carry small session extras
 *                              the server cannot know (client UI metadata,
 *                              session defined names, active-sheet dims);
 *                              GET uses server state only. Other formats
 *                              (xlsx namedRange scope, xlsb/csv/tsv/ods/
 *                              html) keep the older proxied byte response:
 *                              adapters over the permission-filtered
 *                              snapshot, streamed back with content-
 *                              disposition (Cycle 10 defect 2c / closure).
 * - GET  /storage/:entryId?st= → stream an ALREADY-COMMITTED library-store
 *                              file directly to the browser (no gateway
 *                              proxying of bytes). `st` is a gateway-issued
 *                              storage token (HMAC over { entryId,
 *                              principal, exp } with ENGINE_ACCESS_SECRET;
 *                              deploy/engineAccess.ts); invalid/missing/
 *                              expired/mismatched → 401. No serialization
 *                              happens on this route.
 * - POST /library-save         → serialize the live workbook to .xlsx
 *                              server-side (same path as /download) and
 *                              store the bytes in the server-side library
 *                              store for the requesting principal — the tab
 *                              never receives or re-uploads the bytes
 *                              (gateway-mode library save / autosave).
 *                              SAVE = SIGNAL ONLY: request and response
 *                              carry metadata only; the response includes
 *                              `revision`, the pinned revision saved.
 * - GET  /library              → { entries } of the principal's server
 *                              library store.
 * - GET  /library/:id          → the stored .xlsx bytes for that entry
 *                              (gateway-mode library open).
 * - GET  /events?since=n       → { events: [{ seq, event }] } (ring buffer,
 *                              last 1000 engine events)
 * - POST /load                 { format:'xlsx', data: base64 } → open a file
 *                              (web "Open file" flow against the remote engine).
 *                              Responds with the full non-row payload a local
 *                              open hydrates from (sheet names, per-cell number
 *                              formats, adapter metadata, defined names,
 *                              per-column non-empty counts) so the browser
 *                              never pulls a snapshot just to open a file.
 *                              Parse is parallel (parallelParse.ts) and the
 *                              response carries a `timings` breakdown.
 * - POST /load/stream          Same body as /load, but responds as an
 *                              NDJSON stream (progressive open, spec §B):
 *                              a `meta` chunk first (sheet names, defined
 *                              names, zip-level metadata, progress totals),
 *                              then per-sheet `rows` chunks in sheet order
 *                              (cached display values + pendingCalc marks),
 *                              a `sheet-complete` per sheet, a `data-done`
 *                              marker (all cell data emitted; engine build
 *                              still running = "Calculating…"), and finally
 *                              a `built` chunk carrying the exact /load
 *                              response. The engine build proceeds behind
 *                              the stream; mutation stays gated on `built`.
 *                              DISCONNECT REAPING (leg 6): /load/stream
 *                              and the /deltas SSE channel reap on
 *                              client disconnect — write-flush
 *                              callbacks, bounded awaited flushes
 *                              (STREAM_WRITE_TIMEOUT_MS) and a
 *                              no-successful-flush heartbeat reaper
 *                              (SSE_REAP_TIMEOUT_MS) end the response
 *                              and release per-stream state, so a dead
 *                              client can never pin an instance.
 * - POST /load/storage-ref     { bucket?, object, format?:'xlsx',
 *                              sessionId? } → open a workbook by storage
 *                              reference (product layer): bytes resolve
 *                              via the injected upload-object reader
 *                              (prod, bin/engine.ts) or the local upload
 *                              store dir (UPLOAD_STORE_DIR, default
 *                              <sessionDataDir>/uploads); then the exact
 *                              /load post-bytes tail runs and the /load
 *                              response gains `storageRef: { bucket,
 *                              object }`.
 * - GET  /sheets               → { sheets: string[] } (names only, cheap)
 * - POST /language             { locale } → switch the engine's formula
 *                              language (no engine command exists for it)
 * - POST /reset                → blank workbook (web "New workbook" flow)
 * - POST /protection/hide      { sheet, ranges } (testing)
 * - POST /protection/protect   { sheet, lockedRanges?, unlockedRanges? }
 *                              (testing)
 * - GET  /session/status       → the current session's lifecycle state
 *                              (deployment-architecture.md extensions 1–3)
 * - POST /session/heartbeat    { sessionId } → activity ping; refreshes
 *                              the last-activity timestamp the idle rule
 *                              and the server backstop sweeper read.
 * - POST /session/release      { sessionId, reason? } → checkpoint
 *                              (snapshot + journal flush) then EVICT the
 *                              workbook from memory; the session record
 *                              (registry) survives as 'released'.
 * - POST /session/rehydrate    { sessionId } → rebuild from snapshot +
 *                              journal replay, VERIFY the rebuilt state's
 *                              checksum against the checkpoint's recorded
 *                              checksum before reporting success; a
 *                              mismatch is a hard 409, never a silent
 *                              unlock (HYBRID-CONSISTENCY: server state
 *                              is the only confirmed state).
 *
 * SESSION MODEL (honest mapping): today this service process holds ONE
 * workbook, so one process = one live session. /load (and /reset)
 * introduce the sessionId (returned in the load response); every later
 * lifecycle call and — in signed mode — every access token is scoped to
 * it. Multi-session-per-instance routing is the registry's job in
 * production (extension 1); the registry/journal/snapshot seams below
 * are provider-backed (../deploy/sessionStore.ts) so that mapping can
 * grow without changing this surface.
 *
 * SIGNED MODE (ENGINE_ACCESS_MODE=signed, ../deploy/engineAccess.ts):
 * EVERY route except /health requires a valid gateway-issued token —
 * Authorization: Bearer, or ?access_token= for the sendBeacon release
 * (beacons cannot set headers). The verified claims REPLACE x-principal
 * as the identity (a direct caller could spoof x-principal; it cannot
 * forge the HMAC). The token's session scope is enforced per route:
 * /load requires body.sessionId === token.sid; every other route
 * requires token.sid === the live (or released) session id. A
 * per-session rate cap (ENGINE_SESSION_RATE_*) is enforced here, after
 * connect, in the spirit of MCP's own tier. In the default proxy mode
 * none of this runs: the gateway authenticates and x-principal rules,
 * exactly as before.
 */

import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import {
  allowAllPolicy,
  Authorizer,
  EngineHost,
  EngineWorkbook,
  HtmlAdapter,
  ProtectionManager,
  SavePinOverflowError,
  computeAckChecksum,
  serializeAckInput,
  serializeAckValue,
  deriveMirrorMode,
  queryOlapPivot,
  resolveParallelCellThreshold,
  transform,
  unregisterCube,
  unregisterPivot,
  type CellInput,
  type CellRef,
  type CollabOp,
  type DefinedName,
  type EditAck,
  type EngineCommand,
  type EngineEvent,
  type OlapPivotMatrix,
  type RangeRef,
  type SheetData,
  type StorageAdapter,
  type TypedValue,
  type WorkbookData,
  type WorkbookSnapshot,
} from '@icecream-sheets/engine';
import { CsvAdapter, TsvAdapter } from '@icecream-sheets/csv-adapter';
import { OdsAdapter } from '@icecream-sheets/ods-adapter';
import { XlsbAdapter } from '@icecream-sheets/xlsb-adapter';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatewayDataDir } from '../filePersistence.js';
import {
  CONNECTIONS_METADATA_KEY,
  PIVOT_TABLES_METADATA_KEY,
  XlsxAdapter,
  decodeFormatsWire,
  isAuthorableChartKind,
  CHARTS_METADATA_KEY,
  NATIVE_CHART_ANCHORS_METADATA_KEY,
  diffMovedNativeCharts,
  encodeFormatsRecord,
  encodeMetadataForJson,
  externalLinksFromMetadata,
  type FormatsWire,
  type SheetRowChunk,
  type TableDef,
  type TableSheetFields,
} from '@icecream-sheets/xlsx-adapter';
import { parseWorkbookFast, type LoadParseEvents } from './parallelParse.js';
import {
  buildDataModel,
  importedPivotsFromMetadata,
  registerDataModelCubes,
  registerImportedPivotsForEngine,
  wireGoogleFormulaSeams,
  type ChartSpec,
  type DataModelBuild,
  type RegisteredImportedPivot,
} from '@icecream-sheets/service';
import {
  applyCors,
  bearerToken,
  handlePreflight,
  readBody,
  requestPrincipal,
  sendError,
  sendJson,
} from '../httpUtils.js';
import {
  EngineAccessError,
  engineAccessMode,
  engineAccessSecret,
  engineSessionRateLimit,
  idleTimeoutMs,
  isSessionId,
  autosaveCheckpointSettleMs,
  journalSegmentMaxOps,
  newSessionId,
  sessionLifecycleEnabled,
  sessionSweeperMs,
  snapshotEveryMs,
  snapshotEveryOps,
  sseHeartbeatMs,
  sseReapTimeoutMs,
  streamWriteTimeoutMs,
  verifyEngineAccessToken,
  verifyStorageToken,
  type EngineAccessClaims,
} from '../deploy/engineAccess.js';
import {
  createLocalSessionStores,
  sessionDataDir,
  type JournalEntry,
  type SessionStores,
} from '../deploy/sessionStore.js';
import {
  aclRoleFor,
  createFileRegistry,
  ownershipHeartbeatMs,
  type FileRegistry,
  type FileRegistryRecord,
} from '../deploy/fileRegistry.js';
import { createRateLimiter } from '../rateLimit.js';
import {
  serializeLiveWorkbook,
  verifyXlsxPackage,
  type DirectSaveParsedSheet,
  type DirectSaveSheetMeta,
} from '@icecream-sheets/service/save-node';

/** The service's owner principal: exempt from cell hiding (face e). */
export const OWNER_PRINCIPAL = 'user:owner';

/** Last-N engine events kept for /events polling. */
const EVENT_BUFFER_SIZE = 1000;

interface SequencedEvent {
  seq: number;
  event: EngineEvent;
}

// ---------------------------------------------------------------------------
// Phase 2 co-authoring types + pure helpers (design doc §§7–9)
// ---------------------------------------------------------------------------

/** One changed cell in a revision delta (value/formula are the
 *  post-recalc owner-view state; filtering is per recipient). */
export interface DeltaCell {
  sheet: string;
  row: number;
  col: number;
  value: TypedValue;
  formula?: string;
  /** Set ONLY in per-recipient filtered copies: the cell is hidden
   *  from that principal — no value/formula ever rides along. */
  hidden?: boolean;
}

export interface DeltaOrigin {
  clientId: string | null;
  clientSeq: number | null;
  principal: string;
}

export interface DeltaLogEntry {
  revision: number;
  origin: DeltaOrigin;
  /** The APPLIED engine command (post-rebase for /ops). */
  op: unknown;
  cells: DeltaCell[];
  /** CollabOp mapping of `op`, for rebasing later ops against it. */
  collab: CollabOp | null;
}

export interface PresenceEntry {
  principal: string;
  /**
   * Display name (workspace-settings brief): the participant's
   * settings display name (provider name as fallback), supplied by
   * the client on its presence posts. Ephemeral like the rest of
   * presence — never journaled, never a revision.
   */
  name?: string;
  color: string;
  sheet: string;
  row: number;
  col: number;
  editing: boolean;
  updatedAt: number;
}

export interface SseSubscriber {
  res: ServerResponse;
  principal: string;
  role: 'editor' | 'viewer';
  heartbeat: ReturnType<typeof setInterval> | null;
  /**
   * Last SUCCESSFUL write flush (write-callback) — the heartbeat
   * reaper's input (leg 6): a subscriber with no successful flush for
   * SSE_REAP_TIMEOUT_MS is on a dead/half-open socket and is reaped.
   */
  lastFlushAt: number;
  /** Set once the subscriber has been reaped (idempotence guard). */
  reaped: boolean;
}

/** Presence palette — identical to apps/web/src/collab.ts. */
export const PRESENCE_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2'];

/** Deterministic per-principal presence color (same hash as web collab.ts). */
export function presenceColorFor(principal: string): string {
  let h = 0;
  for (const ch of principal) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return PRESENCE_COLORS[Math.abs(h) % PRESENCE_COLORS.length] as string;
}

/** Presence heartbeat TTL (§8 / engine CollabSession semantics): 30 s. */
export const PRESENCE_TTL_MS = 30_000;
/** How long an ack keeps a client "attached" for retention (§1). */
export const ATTACHED_ACK_WINDOW_MS = 5 * 60_000;
/** In-memory delta-log cap (older entries fall under retention rules). */
export const DELTA_LOG_CAP = 5000;

/**
 * Retention rule (§1, EXACTLY): a journal segment ending at
 * `segmentToRevision` may be pruned only when ALL of these hold:
 *   (a) segmentToRevision ≤ storedRevision;
 *   (b) segmentToRevision ≤ every attached client's applied revision
 *       (`minAppliedRev` — Infinity when no client is attached);
 *   (c) a checkpoint/snapshot exists at ≥ segmentToRevision
 *       (`checkpointRevision` non-null and ≥ segmentToRevision).
 * Returns the highest revision prunable under the rule (0 = none).
 */
export function retentionPruneUpto(args: {
  storedRevision: number;
  minAppliedRev: number;
  checkpointRevision: number | null;
}): number {
  if (args.checkpointRevision === null) return 0;
  return Math.max(
    0,
    Math.min(args.storedRevision, args.minAppliedRev, args.checkpointRevision),
  );
}

/** True when one segment may be pruned under the §1 rule. */
export function segmentPrunable(
  segmentToRevision: number,
  args: { storedRevision: number; minAppliedRev: number; checkpointRevision: number | null },
): boolean {
  return segmentToRevision > 0 && segmentToRevision <= retentionPruneUpto(args);
}

/**
 * Map an engine command to its CollabOp for OT rebase (§7). Only the
 * structural commands and cell set/clear have mappings; any other
 * command returns null (no transform applies — it is applied as-is).
 */
export function cmdToCollabOp(
  cmd: EngineCommand,
  clientId: string,
  baseRevision: number,
): CollabOp | null {
  const id = `${clientId}:${baseRevision}`;
  switch (cmd.cmd) {
    case 'setCell': {
      if (cmd.value === null || cmd.value === undefined) {
        return { id, type: 'cell.clear', baseRevision, params: { sheet: cmd.ref.sheet, row: cmd.ref.row, col: cmd.ref.col } };
      }
      return { id, type: 'cell.set', baseRevision, params: { sheet: cmd.ref.sheet, row: cmd.ref.row, col: cmd.ref.col, value: cmd.value } };
    }
    case 'setFormula':
      return { id, type: 'cell.set', baseRevision, params: { sheet: cmd.ref.sheet, row: cmd.ref.row, col: cmd.ref.col, value: cmd.formula } };
    case 'insertRows':
      return { id, type: 'rows.insert', baseRevision, params: { sheet: cmd.sheet, at: cmd.row, count: cmd.count ?? 1 } };
    case 'deleteRows':
      return { id, type: 'rows.delete', baseRevision, params: { sheet: cmd.sheet, at: cmd.row, count: cmd.count ?? 1 } };
    case 'insertCols':
      return { id, type: 'cols.insert', baseRevision, params: { sheet: cmd.sheet, at: cmd.col, count: cmd.count ?? 1 } };
    case 'deleteCols':
      return { id, type: 'cols.delete', baseRevision, params: { sheet: cmd.sheet, at: cmd.col, count: cmd.count ?? 1 } };
    case 'addSheet':
      return { id, type: 'sheet.add', baseRevision, params: { name: cmd.name } };
    case 'deleteSheet':
      return { id, type: 'sheet.delete', baseRevision, params: { name: cmd.name } };
    case 'renameSheet':
      return { id, type: 'sheet.rename', baseRevision, params: { from: cmd.name, to: cmd.newName } };
    default:
      return null;
  }
}

/** Map a (possibly rebased) CollabOp back to an engine command. */
export function collabOpToCmd(op: CollabOp): EngineCommand | null {
  const p = op.params;
  const ref = () => ({ sheet: p['sheet'] as string, row: p['row'] as number, col: p['col'] as number });
  switch (op.type) {
    case 'cell.set': {
      const value = p['value'];
      if (typeof value === 'string' && value.startsWith('=')) {
        return { cmd: 'setFormula', ref: ref(), formula: value };
      }
      return { cmd: 'setCell', ref: ref(), value: value as CellInput };
    }
    case 'cell.clear':
      return { cmd: 'setCell', ref: ref(), value: null };
    case 'rows.insert':
      return { cmd: 'insertRows', sheet: p['sheet'] as string, row: p['at'] as number, count: p['count'] as number };
    case 'rows.delete':
      return { cmd: 'deleteRows', sheet: p['sheet'] as string, row: p['at'] as number, count: p['count'] as number };
    case 'cols.insert':
      return { cmd: 'insertCols', sheet: p['sheet'] as string, col: p['at'] as number, count: p['count'] as number };
    case 'cols.delete':
      return { cmd: 'deleteCols', sheet: p['sheet'] as string, col: p['at'] as number, count: p['count'] as number };
    case 'sheet.add':
      return { cmd: 'addSheet', name: p['name'] as string };
    case 'sheet.delete':
      return { cmd: 'deleteSheet', name: p['name'] as string };
    case 'sheet.rename':
      return { cmd: 'renameSheet', name: p['from'] as string, newName: p['to'] as string };
    default:
      return null;
  }
}

/**
 * Route-level contract check for the execute routes (/ops, /execute):
 * the envelope's `cmd` must be an EngineCommand — an object carrying a
 * non-empty string `cmd` field. A CollabOp wire shape ({ type, params })
 * or a flattened op ({ type: 'sheet.add', name }) is NOT a command: the
 * engine's execute() can only answer it with the default-branch
 * "Unknown command" failure at HTTP 200, a phantom rejection clients
 * that read only the status code mistake for success (agent-rerun
 * case 7, 2026-10-22). Such a cmd can never succeed, so the routes
 * reject it up front with a 400 naming the contract — before the
 * sequencer, so nothing is journaled and no idempotency record is kept.
 */
export function isEngineCommandShape(cmd: unknown): cmd is EngineCommand {
  if (typeof cmd !== 'object' || cmd === null) return false;
  const c = (cmd as { cmd?: unknown }).cmd;
  return typeof c === 'string' && c.length > 0;
}

/**
 * A live engine session as exposed to co-located automation hosting
 * (triggers program, design-docs/automation-lane.md §3): the session's
 * own EngineHost plus a sequenced submit function.
 */
export interface EngineSessionHandle {
  sessionId: string;
  fileId: string | null;
  host: EngineHost;
  /**
   * Apply one command as a sequenced session op — the /ops
   * composition (FIFO sequencer + execute + journal + revision) —
   * stamped with the given principal (`automation:<name>` for trigger
   * writes). Resolves with the op outcome; an engine-level rejection
   * resolves { ok: false } rather than throwing.
   */
  submitOp: (
    cmd: EngineCommand,
    principal: string,
  ) => Promise<{ ok: boolean; error?: string; revision: number }>;
}

/** Session lifecycle notifications for co-located automation hosting. */
export interface EngineSessionHooks {
  onSessionReady?: (handle: EngineSessionHandle) => void;
  onSessionClosed?: (sessionId: string) => void;
}

export interface EngineServiceDeps {
  /** Override for tests. */
  ownerPrincipal?: string;
  /**
   * Resolve the Google connector credential from the vault
   * (design-docs/connector-vs-component.md: "OAuth2 / API key via vault
   * credentialRef"). When provided, the service-layer host wiring
   * (wireGoogleFormulaSeams) puts the resolved credential into the engine's
   * TRANSLATE/DETECTLANGUAGE/IMPORTRANGE seams, so the deployed engine uses
   * the real Google APIs. When omitted — or when the vault holds no Google
   * credential — the engine's honest built-in fallbacks stay active
   * (bundled phrasebook / heuristic / #N/A with an explanatory message).
   */
  resolveGoogleCredential?: (ref: string) => Promise<string | null>;
  /** Override for the server-side library store directory (tests). */
  libraryDir?: string;
  /**
   * Session stores (registry / journal / snapshots) for the deployment
   * lifecycle. Default: the local filesystem provider under
   * SESSION_DATA_DIR. Production passes the Firestore/GCS-backed stores
   * built by createSessionStores() (SESSION_STORE=prod).
   */
  sessionStores?: SessionStores;
  /** Env override for the deploy config (tests); default process.env. */
  deployEnv?: NodeJS.ProcessEnv;
  /** This instance's registry identity. Default `engine-<pid>`. */
  instanceId?: string;
  /**
   * Phase 2 ownership registry (§9): the SAME registry the gateway
   * claims through. Default: createFileRegistry(deployEnv) (local FS
   * adapter under FILE_REGISTRY_DIR). Pass null to disable ownership
   * heartbeats (in-process unit tests of unrelated surfaces).
   */
  fileRegistry?: FileRegistry | null;
  /**
   * Automation trigger hosting (triggers program): when provided, the
   * engine reports session lifecycle (ready with host + submitOp,
   * closed on release/fence/replacement) so a co-located
   * TriggerSupervisor attaches the trigger runtime to the session's
   * OWN EngineHost — scripts run synchronously against the live model
   * and their writes land as ordinary sequenced, journaled ops.
   * Optional and additive: absent hooks change nothing.
   */
  sessionHooks?: EngineSessionHooks;
  /**
   * Product layer: reader for uploaded workbook objects, used by
   * POST /load/storage-ref. Production (bin/engine.ts, UPLOAD_STORE=prod)
   * injects a Cloud Storage reader and fails closed at startup when it
   * cannot be constructed; when omitted, /load/storage-ref reads the
   * local upload store dir (UPLOAD_STORE_DIR, default
   * <sessionDataDir>/uploads — the gateway upload store's default).
   * `bucket` names the configured upload bucket this reader serves
   * (the bucket a request may name; env UPLOAD_BUCKET wins when set).
   */
  uploadObjects?: { bucket: string; get(object: string): Promise<Uint8Array | null> };
}

/** All mutable per-process engine state; rebuilt by /load and /reset. */
interface EngineState {
  host: EngineHost;
  protection: ProtectionManager;
  events: SequencedEvent[];
  nextSeq: number;
  /**
   * Workbook revision (HYBRID-CONSISTENCY.md §1): one integer per
   * accepted edit op, assigned ONLY here. Reset with each fresh
   * workbook (wireFresh); carried by the checksum ack (see /execute).
   */
  revision: number;
  unsubscribe: (() => void) | null;
  /**
   * Engine-global registrations made for the currently loaded file
   * (data-model cubes + imported pivots/cubes). The engine's pivot/cube
   * registries are process-global, so a new load must drop the previous
   * file's entries before registering its own — exactly like the web
   * app's local open flow does.
   */
  registeredPivots: RegisteredImportedPivot[];
  registeredCubes: string[];
  /**
   * Fidelity state for the server-side /download (defect 2c): what the
   * last /load parsed — its adapter metadata (pivot/SmartArt raw parts,
   * external links, native page setup, …), its defined names, and each
   * sheet's column/row dims. The client's in-tab save re-attached these
   * from its own copies; the server save re-attaches them from here, so
   * moving serialization server-side loses nothing the load carried.
   * Replaced by every buildFromData; cleared by /reset.
   */
  sourceMetadata: Record<string, unknown>;
  sourceDefinedNames: DefinedName[] | undefined;
  sourceSheetDims: Map<string, Pick<SheetData, 'colWidths' | 'rowHeights' | 'hiddenCols' | 'hiddenRows'>>;
  /**
   * Snapshot-join slicer fix (#69 Piece A): the loaded file's
   * per-sheet table definitions, retained at load like the dims
   * above. The live engine host holds cells only, so without this
   * retention the snapshot path has no tables to carry — and a
   * joining client can never resolve a table-bound imported slicer.
   * Replaced by every buildFromData (rehydrate re-parses the
   * checkpoint bytes, so it self-heals); cleared by release/reset.
   */
  sourceSheetTables: Map<string, TableDef[]>;
  /**
   * Live OLAP data model (#114, Piece 2): built ONCE at load from the
   * file's retained tables + imported pivot definitions, reading
   * computed values through the host. Null for files without a
   * resolvable model (every other file takes the exact same code path
   * as today). Freed on release/reset with the rest of the fidelity
   * state; /session/olap-query answers from it.
   */
  olapModel: DataModelBuild | null;
  /**
   * The loaded file's per-sheet number formats + full cell styles
   * (defect D4): what a server-side save re-attaches for any sheet the
   * client's session extras do not cover. Before D4 the server save
   * dropped even the file's OWN imported formats; session-applied
   * formats now arrive per save as `sheetStyles` extras and win.
   */
  /**
   * W16: held in run-length wire form, decoded back to the per-cell
   * record only when a save actually re-attaches it — the flat record
   * for a P99-class file is ~1.65 M `"row:col"` string keys (~120 MB)
   * retained for the whole session otherwise.
   */
  sourceSheetFormats: Map<string, FormatsWire>;
  sourceSheetStyles: Map<string, Record<string, import('@icecream-sheets/engine').CellStyle>>;
  // -- deployment session lifecycle (extensions 1–3) ----------------------
  /** The live session's id (introduced at /load or /reset); null pre-load. */
  sessionId: string | null;
  /** Principal that owns the live session. */
  sessionPrincipal: string | null;
  /** 'none' (no load yet) | 'active' (workbook in memory) | 'released' (evicted). */
  sessionStatus: 'none' | 'active' | 'released';
  /**
   * #88D: true once this session incarnation has built a workbook from
   * parsed data (buildFromData) — via /load, /load/stream, rehydrate,
   * or library recovery — or been bound after one (bindLoadedSession,
   * for the load path where registration follows the build). A
   * claim-minted blank pending session is false until one of those
   * runs. The checkpoint guard uses it: a session that never built a
   * workbook and never executed an op holds NOTHING, and checkpointing
   * it would persist a blank workbook as the file's durable state,
   * shadowing the file's real stored bytes for every later open.
   */
  workbookBuilt: boolean;
  /** Last client activity (heartbeat / any request) for the idle rule. */
  lastActivityMs: number;
  /** Revision at the moment of eviction (state.revision dies with wireFresh). */
  releasedRevision: number;
  /** Checksum recorded at the latest checkpoint, for rehydrate verify. */
  checkpointChecksum: string | null;
  /** Journaled ops / time since the latest snapshot (periodic cadence). */
  opsSinceSnapshot: number;
  lastSnapshotMs: number;
  /**
   * Op-journal segment buffer (user's free-quota constraint): executed
   * ops accumulate here in memory and persist as ONE segment write at
   * flush (checkpoint triggers, or JOURNAL_SEGMENT_MAX_OPS). Ops in
   * this buffer are the durability window — memory-only until flushed.
   */
  journalBuffer: JournalEntry[];
  /** Revision through which the journal is persisted (segments/snapshot). */
  journalBaseRevision: number;
  // -- AutoSave batched checkpointing (M365 sync model, single-author) ----
  /**
   * Revision of the last COMMITTED checkpoint — i.e. the revision cut
   * the session's stored copy (the `autosave_<sessionId>` library entry
   * + the deployment snapshot) currently holds. Tracked separately
   * from the live `revision`: live may run ahead while a batch is
   * pending or a checkpoint is in flight. Batch N in storage = exactly
   * the edits with revision ≤ N's pinned cut.
   */
  storageRevision: number;
  /**
   * #105: byte length of the last committed checkpoint's serialized
   * snapshot (0 until the first checkpoint). Surfaced in the SSE
   * status payload and /session-save-status so the client can record
   * the file's true stored size in the workspace catalog — the catalog
   * otherwise never learns a created file's size (it is born 0 and no
   * save path ever updated it). In-memory only; a rehydrated session
   * reports 0 until its next checkpoint, and clients must never
   * overwrite a known catalog size with 0.
   */
  lastCheckpointBytes: number;
  /** Executed mutating ops not yet covered by a committed checkpoint. */
  pendingCheckpointOps: number;
  /** Command names of the pending ops (adapter-fallback why-class). */
  pendingCheckpointOpCmds: string[];
  /** True once this session's autosave library entry has been committed. */
  autosaveCommitted: boolean;
  /** Mode of the last committed checkpoint's serialization. */
  storageMode: 'verbatim' | 'adapter-fallback' | null;
  // -- Addendum 6: autosave ownership, no-op rule, extras sync -----------
  /**
   * Latest session extras pushed via POST /session-extras (client
   * presentation state: styles/dims/names/metadata). Replace-per-key:
   * each top-level key present in a push replaces the stored one.
   * Merged UNDER any per-request extras in runDirectSave (explicit
   * saves/downloads win), so continuous sync never overrides an
   * explicit save's payload.
   */
  pendingExtras: {
    sheetStyles?: unknown;
    sheetDims?: unknown;
    definedNames?: unknown;
    extraMetadata?: unknown;
  };
  /**
   * FIX-G native charts authored this session (trace §4.1c), in
   * creation order. Package-layer state ONLY: charts are parts, not
   * engine cells, so the workbook model never sees them. Lifecycle:
   * cleared by registerSession; appended by POST /charts (sequenced,
   * journaled as the additive `chart.add` kind); rebuilt by
   * rehydrateSession's replay branch for chart.add entries past the
   * snapshot (charts inside the snapshot bytes are preserved verbatim
   * by the save path and correctly NOT re-seeded here); consumed by
   * runDirectSave as DirectSaveInput.charts.
   */
  sessionCharts: ChartSpec[];
  /**
   * True when pendingExtras differ from what the last committed
   * checkpoint consumed. A resend of identical extras must NOT dirty
   * (hash-compared). Extras are flushable content on their own: a
   * flush with extrasDirty && no cell revisions still materializes.
   */
  extrasDirty: boolean;
  /** Canonical-JSON hash of pendingExtras, for the resend compare. */
  extrasHash: string;
  /**
   * Autosave instrumentation (Addendum 6 no-op rule): flushes =
   * committed batch materializations; noopSkips = flush CHECKS
   * (scheduler ticks + force saves) that found storageRevision ==
   * liveRevision && !extrasDirty and therefore wrote NOTHING;
   * forcedFlushes = flushes driven by an explicit client force save /
   * download flush (as opposed to the server scheduler).
   */
  autosaveStats: { flushes: number; noopSkips: number; forcedFlushes: number };
  /**
   * The user's library entry this session was opened from (or last
   * force-saved to), bound via POST /session-bind-library or an
   * id-carrying /library-save. When bound, every committed checkpoint
   * ALSO commits its verified temp file to this entry — the AutoSave
   * stored copy and the user's file are the same file (M365 model),
   * not a session-internal entry the user never sees. Null = the
   * workbook has no library home (uploads); checkpoints then commit
   * only the session's `autosave_<sessionId>` entry.
   */
  boundLibraryId: string | null;
  boundLibraryName: string | null;
  // -- Phase 2 co-authoring (§§7–9) ---------------------------------------
  /** The file this session owns (bound by /session/claim or a token's fid). */
  fileId: string | null;
  /** File/session a /session/claim bound before the first /load filled it. */
  pendingFileId: string | null;
  pendingSessionId: string | null;
  /** Session participants: principal → role (multi-principal sessions). */
  participants: Map<string, 'editor' | 'viewer'>;
  /**
   * Attached CLIENT INSTANCES (addendum 2, owner 2026-10-23): one
   * entry per attached app instance (a tab), NOT per user — the same
   * user in two tabs is two instances. The session copy is released
   * only when this set empties via explicit detach (or the idle
   * sweeper fires for clients that vanished without detaching).
   * Deliberately separate from presence (§8, ephemeral) and from
   * participants (principals/roles): this is the attach refcount.
   */
  attachedClients: Set<string>;
  /**
   * Owner of each attached client instance: clientInstanceId →
   * principal (per-user open cap, §9A). Recorded wherever an instance
   * attaches — the token presented at claim / attach / heartbeat /
   * rehydrate names the instance's user, so the mapping is exact.
   * Deliberately separate from participants (a principal may hold a
   * token without an attached instance) and from presence (§8).
   */
  attachedClientOwners: Map<string, string>;
  /**
   * Per-principal last ACTIVITY on this session (unix ms), the LRU
   * input for the per-user open cap (§9A): stamped on attach and on
   * the activity signals the session receives — an accepted op, an
   * activity-driven heartbeat, a presence post whose selection
   * actually changed. NOT stamped by timers or unchanged re-sends.
   */
  participantActivity: Map<string, number>;
  /**
   * Client instances detached by a cap eviction (POST
   * /session/detach-user, §9A): a tombstoned instance's heartbeat is
   * refused and does NOT re-attach (a heartbeat in flight during the
   * eviction must not resurrect the refcount entry after the user's
   * view has closed). A gateway /session/attach — the sanctioned
   * rejoin on a later open — clears the instance's tombstone.
   */
  detachedClientInstances: Set<string>;
  /** Per-client applied revision + last ack time (retention input, §1). */
  appliedRev: Map<string, { appliedRev: number; lastAckAt: number }>;
  /** Live SSE subscribers on GET /deltas. */
  sseSubscribers: Set<SseSubscriber>;
  /** Revision delta log: one entry per assigned revision (delta cells
   *  UNFILTERED; per-recipient filtering happens at serve time). */
  deltaLog: DeltaLogEntry[];
  /** Idempotency store for /ops: `${clientId}:${clientSeq}` → response. */
  seenOps: Map<string, { status: number; payload: Record<string, unknown> }>;
  /** Presence (§8): in-memory only — never journaled, never a revision. */
  presenceMap: Map<string, PresenceEntry>;
  /** Highest revision whose journal/deltas have been pruned (retention). */
  retentionFloor: number;
  /** Revision of the latest checkpoint snapshot (retention condition c). */
  lastCheckpointRevision: number | null;
  /** Fencing (§9): true once a higher ownership epoch is observed. */
  fenced: boolean;
  /** The ownership epoch this instance believes it holds, if known. */
  ownershipEpoch: number | null;
  /**
   * #107: engine-claim grace deadline (Date.now ms). Set by
   * /session/claim on every 200 path; a heartbeat tick inside the
   * window whose record still names this session+instance on a
   * RELEASED record (leaseExpiry 0) is skipped — the gateway's
   * registry CAS has not landed yet, and heartbeating against the
   * released record would fence the just-claimed session. 0 =
   * no grace. Bounded: past the deadline, fencing resumes, so a
   * gateway crash between engine claim and CAS leaves an orphan
   * that fences rather than serving forever.
   */
  claimGraceUntilMs: number;
  // -- direct streaming save (save serialization invariant) --------------
  /**
   * The retained source bytes of the last successful /load (or the
   * checkpoint snapshot bytes after a rehydrate): the direct streaming
   * serializer copies UNTOUCHED parts of this package byte-for-byte
   * and regenerates only changed sheets from the live model. Null for
   * a blank (never-loaded) workbook — every part is then synthesized.
   */
  sourceBytes: Uint8Array | null;
  /**
   * Executed-op journal FOR SAVES: every accepted mutating command
   * since the source bytes were loaded, in execution order (the
   * client's original command objects). Separate from the durability
   * journal above (which is segmented/truncated at checkpoints and
   * only ever held cell edits). The direct save does NOT replay this
   * journal — it reads the LIVE model — but it derives the
   * changed-sheet set from it, so the journal must be COMPLETE for a
   * verbatim copy of an untouched sheet part to be sound. Capped
   * (SAVE_OPS_CAP): past the cap the journal is dropped and
   * `saveWorkerEligible` flips false; the direct path then forces
   * EVERY sheet changed (see runDirectSave / directSaveOps) instead
   * of trusting an under-reporting journal. (Field name kept from
   * the W21 worker era: it now means "save journal intact", nothing
   * worker-related.)
   */
  saveOps: Array<{ op: EngineCommand }>;
  saveWorkerEligible: boolean;
  /**
   * Bounded structural summary of the save journal (item C fix):
   * the DISTINCT cmds from SAVE_STRUCTURAL_CMDS seen since the
   * source bytes were loaded. Unlike the cell-op history, this
   * summary is NEVER dropped at SAVE_OPS_CAP — it is a subset of a
   * six-element cmd set, so it cannot grow. It exists because the
   * serializer's planning depends on the ops list for exactly one
   * correctness-critical signal the live bulk cannot supply: whether
   * an unhandled structural op (sheet-set change, setCalculationMode)
   * occurred since load. Dropping that signal with the journal made
   * at-cap saves take the verbatim path for a changed sheet set —
   * silently losing an added sheet / resurrecting a deleted one.
   * directSaveOps re-attaches these cmds to the at-cap marker ops so
   * at-cap saves plan exactly like pre-cap saves.
   */
  saveStructuralCmds: Set<string>;
}

/**
 * Op classes for the checkpoint fallback why-class (mirrors the shared
 * serializer's planner classes in service/save/directSave.ts): cell ops
 * touch contents only; name ops touch the defined-names table; anything
 * else is structural and legitimately forces a from-scratch save.
 */
/**
 * AutoSave batch cap: pending un-checkpointed ops force an immediate
 * checkpoint at this count — the journal segment model's 200 (the
 * default JOURNAL_SEGMENT_MAX_OPS), kept as its own constant on
 * purpose (see the /execute accounting comment).
 */
const AUTOSAVE_BATCH_OPS_CAP = 200;

const CHECKPOINT_CELL_OPS: ReadonlySet<string> = new Set(['setCell', 'setFormula']);
const CHECKPOINT_NAME_OPS: ReadonlySet<string> = new Set([
  'defineName',
  'deleteName',
  'renameName',
  'updateNameRefersTo',
  'defineFunction',
  'updateFunction',
  'rollbackFunction',
  'deleteFunction',
]);

/** Mutating engine commands the save journal captures (for worker replay). */
const SAVE_MUTATING_OPS: ReadonlySet<string> = new Set([
  'setCell',
  'setFormula',
  'addSheet',
  'deleteSheet',
  'renameSheet',
  'duplicateSheet',
  'moveSheet',
  'defineName',
  'deleteName',
  'renameName',
  'updateNameRefersTo',
  'defineFunction',
  'updateFunction',
  'rollbackFunction',
  'deleteFunction',
  'insertRows',
  'deleteRows',
  'insertCols',
  'deleteCols',
  'setCalculationMode',
]);

/**
 * Save-journal cap: beyond this many ops the save journal is dropped
 * (and the direct save forces every sheet changed — see
 * directSaveOps). There is NO per-save worker rebuild anymore (the
 * W21 design was retired by the Phase 1 direct-streaming save); the
 * cap bounds the memory of a journal that exists only to derive the
 * serializer's changed-sheet set / planning class from.
 */
export const SAVE_OPS_CAP = 200_000;

/**
 * Mutating cmds the direct serializer's planner cannot handle on the
 * verbatim path (packages/service/src/save/directSave.ts: not cell
 * ops, not name ops, not row/col ops). Their mere OCCURRENCE since
 * load — not their arguments or order — decides that a save must
 * take the adapter fallback, because the gateway builds the
 * serializer's parsedSheets from LIVE sheet names, so the sheet-set
 * comparison there cannot see a sheet-set change: these ops are the
 * only signal. The set is finite (six cmds), so a Set of the ones
 * seen is a bounded summary that survives the SAVE_OPS_CAP journal
 * drop (item C).
 */
export const SAVE_STRUCTURAL_CMDS: ReadonlySet<string> = new Set([
  'addSheet',
  'deleteSheet',
  'renameSheet',
  'duplicateSheet',
  'moveSheet',
  'setCalculationMode',
]);

/** The save-journal slice of EngineState the helpers below operate on. */
export interface SaveJournalState {
  saveOps: Array<{ op: EngineCommand }>;
  saveWorkerEligible: boolean;
  saveStructuralCmds: Set<string>;
}

/**
 * Record one accepted mutating op in the save journal. The bounded
 * structural summary is updated for EVERY op (it must reflect ops
 * that predate the cap as well as ops recorded after it); the op
 * list itself follows the cap rule: at SAVE_OPS_CAP entries the
 * journal is dropped and marked incomplete, and the op that crossed
 * the cap is not retained (the at-cap save regenerates every sheet
 * from the live bulk, so no cell history is needed from it).
 */
export function recordSaveJournalOp(
  journal: SaveJournalState,
  cmd: string,
  rawCmd: EngineCommand,
): void {
  if (SAVE_STRUCTURAL_CMDS.has(cmd)) journal.saveStructuralCmds.add(cmd);
  if (journal.saveOps.length >= SAVE_OPS_CAP) {
    journal.saveWorkerEligible = false;
    journal.saveOps = [];
  } else {
    journal.saveOps.push({ op: rawCmd });
  }
}

/**
 * Reset the save journal for a fresh base (load / reset / rehydrate):
 * the retained source bytes are the new replay base, so the journal
 * restarts from exactly the ops replayed on top of them (rehydrate)
 * or empty (fresh load). The structural summary is rebuilt from the
 * same ops.
 */
export function resetSaveJournal(
  journal: SaveJournalState,
  ops: Array<{ op: EngineCommand }> = [],
): void {
  journal.saveOps = ops;
  journal.saveWorkerEligible = true;
  journal.saveStructuralCmds = new Set(
    ops
      .map((e) => (e.op as { cmd?: unknown }).cmd)
      .filter((c): c is string => typeof c === 'string' && SAVE_STRUCTURAL_CMDS.has(c)),
  );
}

/**
 * The ops list a direct save hands the serializer. Journal intact:
 * the recorded ops, reduced to { cmd, ref }. Journal dropped at the
 * cap: a per-sheet setCell marker for EVERY sheet (forces full
 * regeneration from the live bulk — cell, name and row/col history
 * is fully carried by the live model / the separately-merged
 * defined-names table) PLUS one bare { cmd } entry per structural
 * cmd in the bounded summary, so the serializer's planning class at
 * the cap is identical to the pre-cap plan for the same history
 * (adapter fallback for a changed sheet set / setCalculationMode).
 */
export function directSaveOps(
  journal: SaveJournalState,
  sheetNames: readonly string[],
): Array<{ cmd: string; ref?: CellRef }> {
  if (journal.saveWorkerEligible) {
    return journal.saveOps.map((e) => {
      const raw = e.op as { cmd: string; ref?: CellRef };
      return raw.ref ? { cmd: raw.cmd, ref: raw.ref } : { cmd: raw.cmd };
    });
  }
  return [
    ...sheetNames.map((name) => ({ cmd: 'setCell', ref: { sheet: name, row: 0, col: 0 } })),
    ...[...journal.saveStructuralCmds].map((cmd) => ({ cmd })),
  ];
}

/** Max body for /load: whole files arrive base64-encoded (256MB cap). */
const LOAD_MAX_BODY_BYTES = 256 * 1024 * 1024;

/**
 * Best-effort GC point (W16): a no-op unless the service was started
 * with --expose-gc (the packaged start scripts do). Used at load
 * boundaries where a multi-GB parse peak has just been released, so
 * V8 returns the pages instead of holding them as heap headroom the
 * kernel then counts against the machine's RAM ceiling.
 */
function maybeGc(): void {
  const gc = (globalThis as { gc?: unknown }).gc;
  if (typeof gc === 'function') (gc as () => void)();
}

/**
 * GC point for LARGE reads only (W16 correction): the first cut called
 * maybeGc() on EVERY /read (before send + on finish) — a full-heap GC
 * on a multi-GB built workbook costs seconds, and it put those seconds
 * on every small viewport read (measured: ordinary reads at 3–10 s
 * after a P99 build). Only reads above this many cells carry the
 * transient bulk the GC point exists to release.
 */
const LARGE_READ_GC_CELLS = 250_000;
function maybeGcLarge(cells: number): void {
  if (cells >= LARGE_READ_GC_CELLS) maybeGc();
}

/**
 * How long a /read may pend on an in-flight workbook build before the
 * wait itself fails (W20). Aligned with the engine routes' timeout
 * class: the gateway gives every /api/engine route a 600 s upstream
 * timeout (ENGINE_UPSTREAM_TIMEOUT_MS in gateway.ts, Item D) precisely
 * so a pended read is never cut short by the proxy; a build that has
 * not finished inside the load budget is a failed load by that same
 * budget, so the wait expiring is a real error.
 */
export const BUILD_WAIT_TIMEOUT_MS = 600_000;

/**
 * Max body for /download POST: only small session extras ride along
 * (client UI metadata + defined names) — never workbook cell data.
 * 32MB is generous headroom for picture/chart metadata.
 */
const DOWNLOAD_MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Convert an engine WorkbookSnapshot (sparse cell list) into adapter
 * WorkbookData (dense row-major grids) — the exact conversion the web
 * client's save performs in-tab (apps/web/src/io.ts
 * snapshotToWorkbookData), executed here server-side for /download.
 */
export function snapshotToWorkbookData(
  snap: WorkbookSnapshot,
  extraMetadata: Record<string, unknown> = {},
  definedNames?: DefinedName[],
): WorkbookData {
  const sheets: SheetData[] = snap.sheets.map((sheet) => {
    let maxRow = -1;
    let maxCol = -1;
    for (const cell of sheet.cells) {
      if (cell.ref.row > maxRow) maxRow = cell.ref.row;
      if (cell.ref.col > maxCol) maxCol = cell.ref.col;
    }
    const rows: CellInput[][] = [];
    for (let r = 0; r <= maxRow; r++) {
      const row: CellInput[] = [];
      for (let c = 0; c <= maxCol; c++) row.push(null);
      rows.push(row);
    }
    for (const cell of sheet.cells) {
      const target = rows[cell.ref.row];
      if (target) target[cell.ref.col] = cell.input;
    }
    return { name: sheet.name, rows };
  });
  // Defect E1: default to the snapshot's defined names when the caller
  // passes no explicit list (mirrors apps/web/src/io.ts).
  return { sheets, metadata: { ...extraMetadata }, definedNames: definedNames ?? snap.definedNames };
}

/**
 * Merge defined-name lists for a save (defect E1; mirrors
 * apps/web/src/io.ts mergeDefinedNames): keyed by scope (sheet index;
 * undefined = workbook) + case-insensitive name, earlier lists win,
 * later lists contribute only names the earlier ones lack. The engine's
 * live snapshot names are primary; client session extras (Name-Manager
 * store definitions the engine never held) are secondary. Before E1 the
 * extras list REPLACED the server list whenever it was an array — and
 * the client's store is never populated on open, so it sent [], zeroing
 * every gateway save's defined-names table.
 */
export function mergeDefinedNames(
  ...lists: Array<readonly DefinedName[] | undefined>
): DefinedName[] {
  const out: DefinedName[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const dn of list ?? []) {
      if (!dn || typeof dn.name !== 'string' || typeof dn.ref !== 'string') continue;
      const key = `${dn.sheet ?? ''}\0${dn.name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(dn.sheet !== undefined ? { name: dn.name, ref: dn.ref, sheet: dn.sheet } : { name: dn.name, ref: dn.ref });
    }
  }
  return out;
}

/**
 * Validate a client-supplied `sheetStyles` save extra (defect D4) into
 * per-sheet CellStyle records. Anything malformed is dropped entry by
 * entry — a corrupt style hint must never fail the save, and the XLSX
 * adapter's injector re-validates every field it consumes. Returns null
 * when the extra is absent or not an object at all (sheets then fall
 * back to the loaded file's own styles).
 */
export function sanitizeSheetStyles(
  raw: unknown,
): Record<string, Record<string, import('@icecream-sheets/engine').CellStyle>> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, Record<string, import('@icecream-sheets/engine').CellStyle>> = {};
  for (const [sheet, perCell] of Object.entries(raw as Record<string, unknown>)) {
    if (!perCell || typeof perCell !== 'object' || Array.isArray(perCell)) continue;
    const styles: Record<string, import('@icecream-sheets/engine').CellStyle> = {};
    for (const [key, style] of Object.entries(perCell as Record<string, unknown>)) {
      if (!/^\d+:\d+$/.test(key)) continue;
      if (!style || typeof style !== 'object' || Array.isArray(style)) continue;
      styles[key] = style as import('@icecream-sheets/engine').CellStyle;
    }
    out[sheet] = styles;
  }
  return out;
}

/**
 * Derive an Excel-valid sheet name from a CSV file name: strip the
 * extension, replace every Excel-invalid sheet-name character
 * (`: \ / ? * [ ]`) with '_', trim, and cap at 31 characters.
 * Returns '' when nothing usable remains (callers fall back to
 * the CsvAdapter's default 'Sheet1').
 */
export function sheetNameFromCsvFileName(name: string): string {
  if (typeof name !== 'string') return '';
  const trimmed = name.trim();
  if (trimmed === '') return '';
  const dot = trimmed.lastIndexOf('.');
  const stem = dot > 0 ? trimmed.slice(0, dot) : dot === 0 ? '' : trimmed;
  return stem.replace(/[:\\/?*[\]]/g, '_').trim().slice(0, 31).trim();
}

/** Sanitize a requested download filename to a bare .xlsx name. */
export function downloadFilename(raw: unknown): string {
  return downloadFilenameForFormat(raw, 'xlsx');
}

/** Every save format the web app offers (apps/web/src/adapters.ts SAVE_FORMATS). */
export type ServerSaveFormat = 'xlsx' | 'xlsb' | 'csv' | 'tsv' | 'ods' | 'html';

export const SERVER_SAVE_FORMATS: Record<
  ServerSaveFormat,
  { ext: string; mime: string; make: () => StorageAdapter }
> = {
  xlsx: {
    ext: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    make: () => new XlsxAdapter(),
  },
  xlsb: {
    ext: 'xlsb',
    mime: 'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
    make: () => new XlsbAdapter(),
  },
  csv: { ext: 'csv', mime: 'text/csv', make: () => new CsvAdapter() },
  tsv: { ext: 'tsv', mime: 'text/tab-separated-values', make: () => new TsvAdapter() },
  ods: {
    ext: 'ods',
    mime: 'application/vnd.oasis.opendocument.spreadsheet',
    make: () => new OdsAdapter(),
  },
  html: { ext: 'html', mime: 'text/html', make: () => new HtmlAdapter() },
};

export function isServerSaveFormat(x: unknown): x is ServerSaveFormat {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(SERVER_SAVE_FORMATS, x);
}

/** Sanitize a requested download filename to a bare name in `format`'s extension. */
export function downloadFilenameForFormat(raw: unknown, format: ServerSaveFormat): string {
  const { ext } = SERVER_SAVE_FORMATS[format];
  if (typeof raw !== 'string') return `workbook.${ext}`;
  const base = raw.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/["\r\n]/g, '').trim();
  if (clean.length === 0) return `workbook.${ext}`;
  if (clean.toLowerCase().endsWith(`.${ext}`)) return clean;
  // Replace a different known save extension, else append.
  const stem = clean.replace(/\.(xlsx|xlsb|csv|tsv|ods|html?)$/i, '');
  return `${stem}.${ext}`;
}

// ---------------------------------------------------------------------------
// Named-range subset (port of apps/web/src/io.ts namedRangeToWorkbookData —
// the gateway cannot import the web app, so the exact semantics are mirrored
// here and pinned by the engineSvc tests): a NEW single-sheet workbook whose
// sheet is named after the defined name, cells rebased so the range's
// top-left lands on A1, the defined name carried along rebased to the new
// sheet. Workbook-scoped extras are deliberately NOT carried (they are keyed
// to the source sheet layout and would mis-map after rebasing). The snapshot
// fed in is already permission-filtered, so unreadable cells are absent —
// dropped, never leaked as blanks.
// ---------------------------------------------------------------------------

export interface ServerNamedRangeRef {
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/**
 * FIX-G (trace §4.1c): manual ChartSpec shape validation for
 * POST /charts, in the isServerNamedRangeRef style. The kind must be
 * in the adapter's fail-closed authorable subset; the range (and any
 * per-series ranges) must be well-formed A1 ranges. Sheet EXISTENCE is
 * checked separately against the live host by the route.
 */
export function isValidChartSpec(x: unknown): x is ChartSpec {
  if (typeof x !== 'object' || x === null) return false;
  const s = x as Record<string, unknown>;
  if (typeof s.kind !== 'string' || !isAuthorableChartKind(s.kind)) return false;
  if (!isServerNamedRangeRef(s.range)) return false;
  if (s.title !== undefined && typeof s.title !== 'string') return false;
  if (s.id !== undefined && typeof s.id !== 'number' && typeof s.id !== 'string') return false;
  if (s.seriesRanges !== undefined) {
    if (!Array.isArray(s.seriesRanges)) return false;
    for (const sr of s.seriesRanges) {
      if (typeof sr !== 'object' || sr === null) return false;
      const r = sr as Record<string, unknown>;
      if (typeof r.name !== 'string') return false;
      if (!isServerNamedRangeRef(r.val)) return false;
      if (r.cat !== null && r.cat !== undefined && !isServerNamedRangeRef(r.cat)) return false;
    }
  }
  if (s.anchorCells !== undefined) {
    if (typeof s.anchorCells !== 'object' || s.anchorCells === null) return false;
    const a = s.anchorCells as Record<string, unknown>;
    for (const k of ['fromCol', 'fromRow', 'toCol', 'toRow']) {
      if (!Number.isInteger(a[k]) || (a[k] as number) < 0) return false;
    }
  }
  return true;
}

export function isServerNamedRangeRef(x: unknown): x is ServerNamedRangeRef {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.sheet === 'string' &&
    r.sheet.length > 0 &&
    Number.isInteger(r.startRow) &&
    Number.isInteger(r.startCol) &&
    Number.isInteger(r.endRow) &&
    Number.isInteger(r.endCol) &&
    (r.startRow as number) >= 0 &&
    (r.startCol as number) >= 0 &&
    (r.endRow as number) >= (r.startRow as number) &&
    (r.endCol as number) >= (r.startCol as number)
  );
}

function sanitizeServerSheetName(name: string, fallback: string): string {
  const cleaned = name.replace(/[[\]:*?/\\]/g, '').trim().slice(0, 31);
  return cleaned === '' ? fallback : cleaned;
}

function serverColLabel(c: number): string {
  let n = c + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function serverAbsA1Range(startRow: number, startCol: number, endRow: number, endCol: number): string {
  const tl = `$${serverColLabel(startCol)}$${startRow + 1}`;
  const br = `$${serverColLabel(endCol)}$${endRow + 1}`;
  return startRow === endRow && startCol === endCol ? tl : `${tl}:${br}`;
}

function quoteServerSheetName(name: string): string {
  if (name.includes(' ') || name.includes("'")) return `'${name.replace(/'/g, "''")}'`;
  return name;
}

export function namedRangeToWorkbookData(
  snap: WorkbookSnapshot,
  def: { name: string; ref: ServerNamedRangeRef },
): WorkbookData {
  const { sheet, startRow, startCol, endRow, endCol } = def.ref;
  const sheetName = sanitizeServerSheetName(def.name, sheet);
  let maxRow = -1;
  let maxCol = -1;
  const placed: { row: number; col: number; input: WorkbookSnapshot['sheets'][number]['cells'][number]['input'] }[] = [];
  const src = snap.sheets.find((s) => s.name === sheet);
  if (src) {
    for (const cell of src.cells) {
      const { row, col } = cell.ref;
      if (row < startRow || row > endRow || col < startCol || col > endCol) continue;
      const r = row - startRow;
      const c = col - startCol;
      if (r > maxRow) maxRow = r;
      if (c > maxCol) maxCol = c;
      placed.push({ row: r, col: c, input: cell.input });
    }
  }
  const rows: WorkbookData['sheets'][number]['rows'] = [];
  for (let r = 0; r <= maxRow; r++) {
    const row: WorkbookData['sheets'][number]['rows'][number] = [];
    for (let c = 0; c <= maxCol; c++) row.push(null);
    rows.push(row);
  }
  for (const p of placed) rows[p.row]![p.col] = p.input;
  const definedNames: DefinedName[] = [
    {
      name: def.name,
      ref: `${quoteServerSheetName(sheetName)}!${serverAbsA1Range(0, 0, endRow - startRow, endCol - startCol)}`,
    },
  ];
  return { sheets: [{ name: sheetName, rows }], metadata: {}, definedNames };
}

// ---------------------------------------------------------------------------
// Server-side library store (gateway-mode library save/autosave): the bytes
// the engine service serializes are stored HERE, per principal, on disk
// under the gateway data dir — they never round-trip the browser tab. One
// index file (entries) + one .xlsx file per entry, hashed by principal+id
// so tenants can never address each other's workbooks.
// ---------------------------------------------------------------------------

export interface ServerLibraryEntry {
  id: string;
  name: string;
  owner: string;
  createdAt: number;
  modifiedAt: number;
  sizeBytes: number;
  backend: 'gateway';
}

interface LibraryIndex {
  version: 1;
  entries: Array<ServerLibraryEntry & { principal: string }>;
}

const LIBRARY_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function isLibraryId(x: unknown): x is string {
  return typeof x === 'string' && LIBRARY_ID_RE.test(x);
}

function libraryFileFor(dir: string, principal: string, id: string): string {
  const hash = createHash('sha256').update(`${principal}\n${id}`, 'utf8').digest('hex').slice(0, 24);
  return join(dir, `wb.${hash}.xlsx`);
}

function readLibraryIndex(dir: string): LibraryIndex {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as LibraryIndex;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) return parsed;
  } catch {
    // Missing/corrupt index = empty store (bytes without an entry are unreachable).
  }
  return { version: 1, entries: [] };
}

function writeLibraryIndex(dir: string, index: LibraryIndex): void {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, 'index.json');
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(index), 'utf8');
  renameSync(tmp, target);
}

/**
 * ONE FLAG, TWO CONSEQUENCES — always together (user's final rule,
 * Cycle 10; canonical wording in packages/engine/src/parallel/types.ts
 * shouldEnableParallelRecalc + calc-chain.ts MirrorMode):
 *
 *   Flag ON (workbook total cell count > threshold, default 5000):
 *     (1) The client gets NO local mirror — values only, no formulas —
 *         so the client cannot recalc anything and EVERY edit routes to
 *         the server unconditionally (no local routing rule is even
 *         evaluated).
 *     (2) The server enables multithreaded recalc — independent chains
 *         in parallel Excel-style, dependent chains serialize.
 *   Flag OFF: the inverse holds together — a full mirror ships at open
 *         (every cell's formula + cached value + data type), the client
 *         builds a local engine and the local routing rules apply;
 *         server multithreading stays off.
 *
 * The mirror-shipping decision below is that single flag acting as a
 * unit — evaluated once, at open, from the workbook's total cell count
 * via the engine's deriveMirrorMode() — NOT a separate mechanism from
 * the server's multithreading decision (same flag, same count).
 */

/** One mirrored cell: formula (input), cached value, data type (in kind). */
export interface MirrorCell {
  row: number;
  col: number;
  input: CellInput;
  value: TypedValue;
}

/** Local-mirror payload: the complete engine-build inputs for a workbook. */
export interface WorkbookMirror {
  sheets: Array<{ name: string; cells: MirrorCell[] }>;
  /** Rebuild parity: the server's own build options, mirrored to the client. */
  definedNames?: WorkbookData['definedNames'];
}

/**
 * The /load response: everything a local open hydrates from, minus the
 * rows (those stay server-side; the browser reads viewports lazily).
 * `file.sheets[i].formats` is the run-length wire encoding from the
 * xlsx-adapter; `file.metadata` is binary-safe JSON (see metadataJson).
 */
export interface EngineLoadResponse {
  ok: true;
  sheets: string[];
  file: {
    sheets: Array<{
      name: string;
      formats: FormatsWire;
      /** Full per-cell styles (defect D4), plain JSON records keyed "row:col". */
      styles?: Record<string, import('@icecream-sheets/engine').CellStyle>;
      colWidths?: Record<string, number>;
      rowHeights?: Record<string, number>;
      hiddenCols?: number[];
      hiddenRows?: number[];
      /**
       * Adapter table definitions (Phase E whitelist fix): without
       * this, hosted opens dropped `data.sheets[].tables` and every
       * table-bound imported slicer resolved to `unresolved` in the
       * client mapper, even though the adapter had parsed the tables.
       */
      tables?: TableDef[];
    }>;
    metadata: Record<string, unknown>;
    definedNames?: WorkbookData['definedNames'];
  };
  /** Per-sheet non-empty cell counts by column (chart defined-name math). */
  columnCounts: Record<string, number[]>;
  /**
   * The complete local mirror, present iff the auto-flag is OFF (see the
   * ONE FLAG rule above): every cell's formula, cached value and data
   * type, for the client to build a local engine with. When the flag is
   * ON there is no mirror at all: the client receives values only (via
   * viewport reads) and every edit routes to the server.
   */
  mirror?: WorkbookMirror;
  /** Server-side stage breakdown for this load (Cycle 10 Phase 4). */
  timings?: Record<string, number | string | null>;
  /**
   * The deployment session id this load introduced (extension 1): the
   * client scopes its engine-access tokens and lifecycle calls to it.
   */
  sessionId?: string;
  /** Set to 'csv' when this session was imported from CSV bytes. */
  sourceFormat?: 'csv';
}

function loadResponse(data: WorkbookData): EngineLoadResponse {
  const columnCounts: Record<string, number[]> = {};
  for (const sheet of data.sheets) {
    const counts: number[] = [];
    for (const row of sheet.rows) {
      for (let c = 0; c < row.length; c++) {
        const v = row[c];
        if (v !== null && v !== undefined && v !== '') counts[c] = (counts[c] ?? 0) + 1;
      }
    }
    columnCounts[sheet.name] = counts;
  }
  return {
    ok: true,
    sheets: data.sheets.map((s) => s.name),
    file: {
      sheets: data.sheets.map((s) => {
        // Adapter attaches tables in assembleFromParsedSheets (both
        // classic and fast paths); the engine WorkbookData type does
        // not carry the field, hence the TableSheetFields cast.
        const tables = (s as SheetData & TableSheetFields).tables;
        return {
          name: s.name,
          formats: encodeFormatsRecord(s.formats),
          ...(s.styles && Object.keys(s.styles).length > 0 ? { styles: s.styles } : {}),
          ...(s.colWidths ? { colWidths: s.colWidths } : {}),
          ...(s.rowHeights ? { rowHeights: s.rowHeights } : {}),
          ...(s.hiddenCols ? { hiddenCols: s.hiddenCols } : {}),
          ...(s.hiddenRows ? { hiddenRows: s.hiddenRows } : {}),
          ...(tables && tables.length > 0 ? { tables } : {}),
        };
      }),
      metadata: encodeMetadataForJson(data.metadata),
      ...(data.definedNames ? { definedNames: data.definedNames } : {}),
    },
    columnCounts,
  };
}

export function createEngineListener(deps: EngineServiceDeps = {}): RequestListener {
  const ownerPrincipal = deps.ownerPrincipal ?? OWNER_PRINCIPAL;
  const state: EngineState = {
    host: null as unknown as EngineHost,
    protection: null as unknown as ProtectionManager,
    events: [],
    nextSeq: 1,
    revision: 0,
    unsubscribe: null,
    registeredPivots: [],
    registeredCubes: [],
    sourceMetadata: {},
    sourceDefinedNames: undefined,
    sourceSheetDims: new Map(),
    sourceSheetTables: new Map(),
    olapModel: null,
    sourceSheetFormats: new Map(),
    sourceSheetStyles: new Map(),
    sessionId: null,
    sessionPrincipal: null,
    sessionStatus: 'none',
    workbookBuilt: false,
    lastActivityMs: Date.now(),
    releasedRevision: 0,
    checkpointChecksum: null,
    opsSinceSnapshot: 0,
    lastSnapshotMs: 0,
    journalBuffer: [],
    journalBaseRevision: 0,
    storageRevision: 0,
    lastCheckpointBytes: 0,
    pendingCheckpointOps: 0,
    pendingCheckpointOpCmds: [],
    autosaveCommitted: false,
    storageMode: null,
    pendingExtras: {},
    extrasDirty: false,
    extrasHash: '',
    sessionCharts: [],
    autosaveStats: { flushes: 0, noopSkips: 0, forcedFlushes: 0 },
    boundLibraryId: null,
    boundLibraryName: null,
    fileId: null,
    pendingFileId: null,
    pendingSessionId: null,
    participants: new Map(),
    attachedClients: new Set(),
    attachedClientOwners: new Map(),
    participantActivity: new Map(),
    detachedClientInstances: new Set(),
    appliedRev: new Map(),
    sseSubscribers: new Set(),
    deltaLog: [],
    seenOps: new Map(),
    presenceMap: new Map(),
    retentionFloor: 0,
    lastCheckpointRevision: null,
    fenced: false,
    ownershipEpoch: null,
    claimGraceUntilMs: 0,
    sourceBytes: null,
    saveOps: [],
    saveWorkerEligible: true,
    saveStructuralCmds: new Set<string>(),
  };

  // -- deployment config (all behind env; defaults = today's topology) ---
  const deployEnv = deps.deployEnv ?? process.env;
  const accessMode = engineAccessMode(deployEnv);
  const accessSecret = engineAccessSecret(deployEnv);
  const stores: SessionStores =
    deps.sessionStores ?? createLocalSessionStores(sessionDataDir(deployEnv));
  // ENGINE_INSTANCE_ID (contract): the registry identity this engine
  // claims ownership under; default 'engine-1' (the local topology's
  // single engine). deps.instanceId wins for tests.
  const instanceId =
    deps.instanceId ??
    ((deployEnv.ENGINE_INSTANCE_ID ?? '').trim() !== ''
      ? (deployEnv.ENGINE_INSTANCE_ID as string).trim()
      : 'engine-1');
  const sessionRateLimiter =
    accessMode === 'signed' ? createRateLimiter(engineSessionRateLimit(deployEnv)) : null;
  const idleTimeout = idleTimeoutMs(deployEnv);
  // Streaming disconnect reaping (leg 6): SSE heartbeat cadence, the
  // no-successful-flush reap window for /deltas, and the bounded-flush
  // window for /load/stream.
  const sseHeartbeatIntervalMs = sseHeartbeatMs(deployEnv);
  const sseReapAfterMs = sseReapTimeoutMs(deployEnv);
  const streamWriteTimeout = streamWriteTimeoutMs(deployEnv);
  const everyOps = snapshotEveryOps(deployEnv);
  const everyMs = snapshotEveryMs(deployEnv);
  const segmentMaxOps = journalSegmentMaxOps(deployEnv);
  // -- product layer: upload-object resolution for /load/storage-ref ---
  // The configured upload bucket: env UPLOAD_BUCKET when set, else the
  // injected reader's bucket, else the contract default. A request that
  // names any other bucket is refused (400) — objects are only ever
  // pulled from the one bucket this deployment uploads into.
  const envUploadBucket = (deployEnv.UPLOAD_BUCKET ?? '').trim();
  const configuredUploadBucket =
    envUploadBucket !== '' ? envUploadBucket : (deps.uploadObjects?.bucket ?? 'icecream-uploads');
  // Local upload-object root: UPLOAD_STORE_DIR, else the SAME default
  // the gateway's upload store uses (<sessionDataDir>/uploads), so one
  // env configures both sides of the local stack.
  const uploadStoreDir =
    (deployEnv.UPLOAD_STORE_DIR ?? '').trim() !== ''
      ? (deployEnv.UPLOAD_STORE_DIR as string).trim()
      : join(sessionDataDir(deployEnv), 'uploads');

  /**
   * Resolve an upload object's bytes: the injected prod reader when
   * present, else the local upload store dir. `object` has already been
   * sanitized by the caller (relative key, no '..', no backslashes).
   * Returns null when the object does not exist (→ 404).
   */
  async function resolveUploadObjectBytes(object: string): Promise<Uint8Array | null> {
    if (deps.uploadObjects) {
      const bytes = await deps.uploadObjects.get(object);
      return bytes ?? null;
    }
    try {
      return new Uint8Array(readFileSync(join(uploadStoreDir, object)));
    } catch {
      return null; // missing/unreadable object → 404 at the route
    }
  }

  /** Drop the previous file's engine-global registrations (cube/pivot). */
  function clearRegistrations(): void {
    for (const { key } of state.registeredPivots) {
      try {
        unregisterPivot(key);
      } catch {
        // Registry hygiene must never break the open.
      }
    }
    for (const name of state.registeredCubes) {
      try {
        unregisterCube(name);
      } catch {
        // Registry hygiene must never break the open.
      }
    }
    state.registeredPivots = [];
    state.registeredCubes = [];
    state.olapModel = null;
  }

  /** (Re)build host + protection exactly like the web app does. */
  function wireFresh(workbook?: EngineWorkbook): void {
    state.unsubscribe?.();
    const protection = new ProtectionManager();
    protection.setHiddenExemptPrincipals([ownerPrincipal]);
    const authorizer = new Authorizer(protection.protectionPolicy(allowAllPolicy()));
    const host = workbook ? new EngineHost(workbook, authorizer) : new EngineHost(undefined, authorizer);
    host.setHiddenCheck((ref, principal) =>
      protection.isHiddenFrom(ref.sheet, ref.row, ref.col, principal),
    );
    // Server MT pool (Cycle 10 Phase 3 — the threading half of the ONE
    // FLAG): the pool is ENABLED on the server host; whether any given
    // multi-chain recalc actually parallelizes is decided per edit by
    // the routing contract (flag ON = workbook cell count above the
    // threshold) and belt-and-braced inside ParallelRecalculator
    // (shouldEnableParallelRecalc gate + no-independent-chains serial
    // fallback). Canonical env: ICECREAM_MT_CELL_COUNT_THRESHOLD.
    try {
      host.execute({
        cmd: 'setParallelRecalcOptions',
        options: {
          enabled: true,
          workerCount: 4,
          cellCountThreshold: resolveParallelCellThreshold(process.env),
        },
      });
    } catch {
      // Pool enablement must never break the service; serial remains.
    }
    state.host = host;
    state.protection = protection;
    state.events = [];
    state.nextSeq = 1;
    state.revision = 0;
    state.unsubscribe = host.subscribe((event) => {
      state.events.push({ seq: state.nextSeq++, event });
      if (state.events.length > EVENT_BUFFER_SIZE) {
        state.events.splice(0, state.events.length - EVENT_BUFFER_SIZE);
      }
    });
  }

  // -- automation session hooks (triggers program) ---------------------
  let submitSeq = 0;
  let lastHookNotified: {
    sessionId: string;
    fileId: string | null;
    host: EngineHost;
  } | null = null;

  async function submitSessionOp(
    cmd: EngineCommand,
    principal: string,
  ): Promise<{ ok: boolean; error?: string; revision: number }> {
    if (state.sessionStatus !== 'active' || !state.sessionId || state.fenced) {
      return { ok: false, error: 'no active session', revision: state.revision };
    }
    try {
      const out = await enqueueSequenced(async () =>
        runExecuteInternal({
          rawCmd: cmd,
          principal,
          ackChecksum: false,
          envelope: { clientId: 'automation-supervisor', clientSeq: ++submitSeq },
        }),
      );
      return {
        ok: out.ok,
        ...(out.ok
          ? {}
          : {
              error:
                typeof out.payload.error === 'string'
                  ? out.payload.error
                  : 'op rejected by the engine',
            }),
        revision: out.revision,
      };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        revision: state.revision,
      };
    }
  }

  /**
   * Report the current session to deps.sessionHooks, deduplicated by
   * (sessionId, fileId, host identity): fires onSessionReady whenever
   * any of the three changes, onSessionClosed when the live session
   * goes away (release, fence, replacement). Never throws.
   */
  function notifySessionHooks(): void {
    const hooks = deps.sessionHooks;
    if (!hooks) return;
    try {
      if (state.sessionStatus === 'active' && state.sessionId && !state.fenced) {
        if (
          lastHookNotified &&
          lastHookNotified.sessionId === state.sessionId &&
          lastHookNotified.fileId === state.fileId &&
          lastHookNotified.host === state.host
        ) {
          return;
        }
        lastHookNotified = {
          sessionId: state.sessionId,
          fileId: state.fileId,
          host: state.host,
        };
        hooks.onSessionReady?.({
          sessionId: state.sessionId,
          fileId: state.fileId,
          host: state.host,
          submitOp: submitSessionOp,
        });
      } else if (lastHookNotified) {
        const sid = lastHookNotified.sessionId;
        lastHookNotified = null;
        hooks.onSessionClosed?.(sid);
      }
    } catch {
      // Hook failures must never break the engine.
    }
  }

  wireFresh();

  /**
   * Save pins currently active on the host (Addendum 4): incremented
   * around runDirectSave's pinned read phase. The /execute route's
   * overflow queue polls this counter — when it reaches zero, no pin
   * can make an execute throw SavePinOverflowError anymore.
   */
  let activeSavePins = 0;

  // -- Phase 2 co-authoring machinery (§§7–9) ------------------------------
  // Ownership registry (the same one the gateway claims through):
  // resolved lazily; prod-mode construction failure leaves it null and
  // disables heartbeats (the gateway's own claim path fails closed).
  let fileRegistryCache: FileRegistry | null | undefined;
  function getFileRegistry(): FileRegistry | null {
    if (deps.fileRegistry !== undefined) return deps.fileRegistry;
    if (fileRegistryCache !== undefined) return fileRegistryCache;
    try {
      fileRegistryCache = createFileRegistry(deployEnv);
    } catch (e) {
      console.log(
        `[engine] file registry unavailable: ${e instanceof Error ? e.message : String(e)} — ownership heartbeat disabled`,
      );
      fileRegistryCache = null;
    }
    return fileRegistryCache;
  }

  /**
   * Issue #51 (design doc read-only-enforcement sections 4-5): the
   * caller's CURRENT role for the session's file, re-derived from
   * the file registry's grant record on EVERY request — never frozen
   * at join. Creator -> 'editor'; a recorded grant -> that role; a
   * principal with NO grant -> null (no access at all: mutating
   * routes and reads alike are refused). This is what makes ACL
   * changes immediate on live sessions: an owner demoting an editor
   * to viewer fails that editor's NEXT write, and a revocation cuts
   * their next read, with the token they already hold. Falls back to
   * the token / participant resolution when there is no registry or
   * no record for the file (standalone engine, desktop local mode,
   * engine-only tests): grants live in the registry, so no record
   * means no grants to enforce. A registry READ failure falls back
   * too — the gateway stays fail-closed at open time; the engine
   * does not lock legitimate users out on a store blip.
   */
  async function currentRoleFor(
    p: string,
    claims: EngineAccessClaims | null,
  ): Promise<'editor' | 'viewer' | null> {
    const registry = getFileRegistry();
    if (registry && state.fileId) {
      let rec: FileRegistryRecord | null = null;
      try {
        rec = await registry.lookup(state.fileId);
      } catch {
        // #104 fail closed: when the grant record cannot be READ, the
        // call cannot be verified as authorized — refuse. (A missing
        // record — null, not an error — is different: the claim→load
        // window has no record yet and local sessions have none; those
        // keep the token-role fallback below.)
        return null;
      }
      if (rec) {
        // The one authoritative verdict (deploy/fileRegistry.ts,
        // aclRoleFor — design doc section 8), mapped onto the
        // engine's two token roles.
        const acl = aclRoleFor(rec, p);
        if (!acl) return null;
        return acl === 'owner' ? 'editor' : acl;
      }
    }
    return claims?.role ?? state.participants.get(p) ?? 'editor';
  }

  /**
   * Write one SSE frame WITH a flush callback (disconnect reaping,
   * leg 6). The callback is the only reliable dead-socket signal on a
   * half-open connection: a bare res.write() buffers silently and its
   * failure surfaces asynchronously, never via try/catch — which is
   * how killed clients left never-ending /deltas responses pinning
   * every Cloud Run engine instance in the 2026-10-22 outage. A
   * successful flush refreshes `lastFlushAt` (the heartbeat reaper's
   * input); an error reaps the subscriber immediately.
   */
  function sseWrite(sub: SseSubscriber, payload: string): void {
    if (sub.reaped || sub.res.writableEnded || sub.res.destroyed) {
      reapSubscriber(sub);
      return;
    }
    try {
      sub.res.write(payload, (err?: Error | null) => {
        if (err) {
          reapSubscriber(sub);
          return;
        }
        sub.lastFlushAt = Date.now();
      });
    } catch {
      reapSubscriber(sub);
    }
  }

  function sseSend(sub: SseSubscriber, event: string, data: unknown): void {
    let payload: string;
    try {
      payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    } catch {
      reapSubscriber(sub);
      return;
    }
    sseWrite(sub, payload);
  }

  function removeSubscriber(sub: SseSubscriber): void {
    if (sub.heartbeat) {
      clearInterval(sub.heartbeat);
      sub.heartbeat = null;
    }
    state.sseSubscribers.delete(sub);
  }

  /**
   * Reap a subscriber (leg 6): remove it from the subscriber set,
   * stop its heartbeat, and END the response. Ending is the point —
   * a /deltas response that is merely forgotten keeps its Cloud Run
   * request slot (containerConcurrency=1) forever. Idempotent:
   * 'close', 'error', write failures and the heartbeat reaper can all
   * race here.
   */
  function reapSubscriber(sub: SseSubscriber): void {
    if (sub.reaped) return;
    sub.reaped = true;
    removeSubscriber(sub);
    if (!sub.res.writableEnded) {
      try {
        // Safe even on a destroyed response (a no-op finish; any
        // async 'error' lands on the reap listener attached at
        // subscribe time) — and required when the socket is merely
        // half-open, where end() is what actually closes the request.
        sub.res.end();
      } catch {
        // Already gone.
      }
    }
  }

  function closeAllSubscribers(kind: string): void {
    for (const sub of [...state.sseSubscribers]) {
      sseSend(sub, 'session', { kind });
      try {
        sub.res.end();
      } catch {
        // Already gone.
      }
      removeSubscriber(sub);
    }
  }

  /**
   * Per-recipient permission filtering of a delta (five-faces, face
   * e): a cell hidden from the recipient is sent as a bare ref +
   * { hidden: true } — its value and formula NEVER cross.
   */
  function filterDeltaCells(cells: DeltaCell[], principal: string): DeltaCell[] {
    if (principal === ownerPrincipal) return cells;
    return cells.map((cell) => {
      let hidden = false;
      try {
        hidden = state.protection.isHiddenFrom(cell.sheet, cell.row, cell.col, principal);
      } catch {
        hidden = false;
      }
      if (!hidden) {
        // Taint check: a cell the recipient may not READ (#PERM! —
        // hidden itself, or a formula over hidden cells) must not
        // leak the owner-view value stored in the delta either.
        try {
          const v = state.host.readCell(
            { sheet: cell.sheet, row: cell.row, col: cell.col },
            { principal },
          );
          hidden = v.kind === 'error' && v.code === '#PERM!';
        } catch {
          hidden = false;
        }
      }
      if (!hidden) return cell;
      // Strip value/formula entirely: only the bare ref + flag cross.
      return { sheet: cell.sheet, row: cell.row, col: cell.col, hidden: true } as unknown as DeltaCell;
    });
  }

  function broadcastDelta(revision: number, origin: DeltaOrigin, cells: DeltaCell[]): void {
    for (const sub of [...state.sseSubscribers]) {
      sseSend(sub, 'delta', { revision, origin, cells: filterDeltaCells(cells, sub.principal) });
    }
  }

  function broadcastStatus(): void {
    const data = {
      revision: state.revision,
      storedRevision: state.storageRevision,
      saving:
        state.storageRevision < state.revision || state.pendingCheckpointOps > 0 || state.extrasDirty,
      storedBytes: state.lastCheckpointBytes,
    };
    for (const sub of [...state.sseSubscribers]) sseSend(sub, 'status', data);
  }

  function broadcastSession(data: Record<string, unknown>): void {
    for (const sub of [...state.sseSubscribers]) sseSend(sub, 'session', data);
  }

  // -- per-user open cap bookkeeping (§9A) --------------------------------
  /**
   * Record an instance attach (refcount + owner + activity): the
   * instance joins attachedClients, its owner is the principal whose
   * token was presented, and the principal's activity on this session
   * is stamped (an open stamps the file, §9A). A sanctioned attach
   * clears any cap-eviction tombstone for the instance.
   */
  function noteInstanceAttach(clientInstanceId: string, principal: string): void {
    state.attachedClients.add(clientInstanceId);
    state.attachedClientOwners.set(clientInstanceId, principal);
    state.detachedClientInstances.delete(clientInstanceId);
    notePrincipalActivity(principal);
  }

  /** Stamp a principal's last-activity time on this session (§9A). */
  function notePrincipalActivity(principal: string): void {
    state.participantActivity.set(principal, Date.now());
  }

  /**
   * The attachment truth the gateway's cap derivation consumes
   * (GET /session/status): principal → their attached instances on
   * this session + their last activity here. Derived from the
   * refcount maps — never stored separately, so it cannot drift.
   */
  function attachedClientsByPrincipal(): Record<
    string,
    { instances: string[]; lastActivityAt: number }
  > {
    const out: Record<string, { instances: string[]; lastActivityAt: number }> = {};
    for (const [instanceId, principal] of state.attachedClientOwners) {
      if (!state.attachedClients.has(instanceId)) continue;
      const entry = (out[principal] ??= { instances: [], lastActivityAt: 0 });
      entry.instances.push(instanceId);
    }
    for (const principal of Object.keys(out)) {
      out[principal]!.lastActivityAt = state.participantActivity.get(principal) ?? 0;
    }
    return out;
  }

  function livePresence(): PresenceEntry[] {
    const now = Date.now();
    const out: PresenceEntry[] = [];
    for (const [principal, p] of state.presenceMap) {
      if (now - p.updatedAt > PRESENCE_TTL_MS) {
        state.presenceMap.delete(principal);
        continue;
      }
      out.push(p);
    }
    return out;
  }

  function broadcastPresence(): void {
    const participants = livePresence().map((p) => ({
      principal: p.principal,
      ...(p.name ? { name: p.name } : {}),
      color: p.color,
      sheet: p.sheet,
      row: p.row,
      col: p.col,
      editing: p.editing,
    }));
    for (const sub of [...state.sseSubscribers]) sseSend(sub, 'presence', { participants });
  }

  /** Minimum applied revision across ATTACHED clients (§1): a client
   *  is attached with a live SSE subscription or an ack within 5 min.
   *  Infinity when no client is attached (condition vacuously true). */
  function minAppliedAcrossAttached(): number {
    const now = Date.now();
    const livePrincipals = new Set([...state.sseSubscribers].map((s) => s.principal));
    let min = Number.POSITIVE_INFINITY;
    for (const [principal, rec] of state.appliedRev) {
      if (livePrincipals.has(principal) || now - rec.lastAckAt <= ATTACHED_ACK_WINDOW_MS) {
        min = Math.min(min, rec.appliedRev);
      }
    }
    return min;
  }

  function pruneDeltaLog(upto: number): void {
    if (upto <= 0) return;
    state.deltaLog = state.deltaLog.filter((e) => e.revision > upto);
    if (upto > state.retentionFloor) state.retentionFloor = upto;
  }

  /** Retention pruning (§1): drop whole journal segments + delta-log
   *  entries up to the rule's bound. Never past the slowest attached
   *  client, never past the stored revision, never without a
   *  checkpoint at/beyond. */
  async function pruneRetention(reason: string): Promise<void> {
    if (!state.sessionId || state.sessionStatus !== 'active') return;
    const upto = retentionPruneUpto({
      storedRevision: state.storageRevision,
      minAppliedRev: minAppliedAcrossAttached(),
      checkpointRevision: state.lastCheckpointRevision,
    });
    if (upto <= state.retentionFloor) return;
    await stores.journal.truncate(state.sessionId, upto);
    pruneDeltaLog(upto);
    console.log(`[engine] retention prune (${reason}) upto=${upto} session=${state.sessionId}`);
  }

  /** Fencing (§9): a stale owner that sees a higher epoch — or cannot
   *  confirm its own — fences itself immediately: ops/deltas/load
   *  refuse 409, live SSE subscribers get session{fenced} and close. */
  function fenceSession(reason: string): void {
    if (state.fenced) return;
    state.fenced = true;
    console.log(`[engine] FENCED session=${state.sessionId} file=${state.fileId}: ${reason}`);
    closeAllSubscribers('fenced');
    notifySessionHooks();
  }

  // Presence TTL sweep: expired heartbeats drop out and peers see the
  // departure. Presence is memory-only — nothing here is journaled.
  const presenceSweeper = setInterval(() => {
    if (state.presenceMap.size === 0) return;
    const before = state.presenceMap.size;
    livePresence();
    if (state.presenceMap.size !== before) broadcastPresence();
  }, 5_000);
  presenceSweeper.unref?.();

  // Retention sweep (the checkpoint path prunes too; this covers a
  // session whose clients advance their applied revisions by ack
  // without any new checkpoint).
  const retentionSweeper = setInterval(() => {
    void pruneRetention('sweep').catch((e) => {
      console.log(`[engine] retention prune failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  }, 30_000);
  retentionSweeper.unref?.();

  /**
   * #107: bounded claim-grace window (ms). Covers the gateway's
   * engine-claim → registry-CAS latency (production: ~1 RTT +
   * Firestore write, milliseconds; pathological: seconds) with
   * headroom, while bounding the account-deletion/supervisor holes
   * to deletions landing within the window of a claim. Past it,
   * fencing resumes — fail-closed, never serve an orphan forever.
   */
  const CLAIM_GRACE_MS = 30_000;
  // Ownership heartbeat (§9): lease/3 cadence; refreshes the registry
  // lease + revision counters. A heartbeat that returns false (epoch
  // no longer current) — or a registry record naming another owner —
  // fences this instance immediately.
  const ownershipHeartbeat = setInterval(() => {
    void (async () => {
      if (!state.fileId || !state.sessionId || state.sessionStatus !== 'active' || state.fenced) return;
      const registry = getFileRegistry();
      if (!registry) return;
      let rec: Awaited<ReturnType<FileRegistry['lookup']>>;
      try {
        rec = await registry.lookup(state.fileId);
      } catch {
        // The owner must stop serving if it cannot confirm its epoch.
        if (state.ownershipEpoch !== null) fenceSession('registry-unreachable');
        return;
      }
      if (!rec) return; // gateway has not CAS-claimed yet — grace window
      if (rec.sessionId !== state.sessionId || rec.ownerInstance !== instanceId) {
        if (state.ownershipEpoch !== null || rec.ownershipEpoch > (state.ownershipEpoch ?? 0)) {
          fenceSession('ownership moved to another instance');
        }
        return;
      }
      // #107: bounded claim grace. The gateway claims the engine
      // FIRST and CAS-claims the registry SECOND; a tick inside
      // that window looks up the still-RELEASED record (leaseExpiry
      // 0) for this session+instance. Without grace the tick adopts
      // the stale epoch and its heartbeat is refused by the released
      // record's guard — fencing the just-claimed session before
      // the CAS lands. Skipping the tick entirely (no adoption, no
      // heartbeat) is exactly the missing-record grace above, and
      // only for a record naming THIS session+instance: a takeover
      // record still fences via the moved check above, and past the
      // deadline fencing resumes (a gateway crash between engine
      // claim and CAS must leave an orphan that fences, and an
      // account-deletion tombstone outside the window still fences
      // on the next tick).
      if (
        rec.leaseExpiry === 0 &&
        Date.now() < state.claimGraceUntilMs
      ) {
        return;
      }
      if (state.ownershipEpoch !== null && rec.ownershipEpoch !== state.ownershipEpoch) {
        // #107 complement (rejoin-after-release): the same session on
        // the same instance with a HIGHER record epoch is the gateway
        // re-adopting this live session (rejoin CAS) — adopt it, do
        // not fence. A takeover changes the session or the instance
        // and fences via the moved check above; a LOWER epoch (a
        // stale record) still fences below.
        if (rec.ownershipEpoch > state.ownershipEpoch) {
          state.ownershipEpoch = rec.ownershipEpoch;
        } else {
          fenceSession(`epoch changed ${state.ownershipEpoch} → ${rec.ownershipEpoch}`);
          return;
        }
      }
      state.ownershipEpoch = rec.ownershipEpoch;
      // The session may have been released WHILE this tick was in
      // flight (the lookup above awaited): a heartbeat written now
      // would re-extend a record the release just zeroed. The
      // registry refuses to revive a released record as well; this
      // re-check keeps the tick from even attempting it — and from
      // fencing a state our own teardown already reset.
      const tickFileId = state.fileId;
      const tickSessionId = state.sessionId;
      if (state.sessionStatus !== 'active' || state.fenced) return;
      let ok: boolean;
      try {
        ok = await registry.heartbeat(
          tickFileId,
          tickSessionId,
          rec.ownershipEpoch,
          state.revision,
          state.storageRevision,
        );
      } catch {
        if (state.sessionId === tickSessionId && state.sessionStatus === 'active') {
          fenceSession('registry heartbeat failed');
        }
        return;
      }
      if (!ok && state.sessionId === tickSessionId && state.sessionStatus === 'active') {
        fenceSession('heartbeat rejected (epoch no longer current)');
      }
    })();
  }, ownershipHeartbeatMs(deployEnv));
  ownershipHeartbeat.unref?.();

  // -- single sequencer (§7) ----------------------------------------------
  // ALL mutating executes (POST /ops envelopes AND legacy /execute)
  // run through this one FIFO promise chain: one op at a time, applied
  // completely (input + full recalc) before the next starts. The
  // revision stamp assigned inside IS the total order.
  let opChain: Promise<void> = Promise.resolve();
  function enqueueSequenced<T>(fn: () => Promise<T>): Promise<T> {
    const run = opChain.then(fn);
    opChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * FIX-G (trace §4.1c): accept one native chart into the session,
   * INSIDE the sequencer FIFO. Mirrors a mutating execute's accounting
   * — revision++, durability journal, AutoSave batch — but the
   * journaled op is the additive `chart.add` kind (NOT an
   * EngineCommand; the engine never sees charts), with `delta: []`;
   * rehydrateSession replays it through one explicit branch. Clients
   * learn about it via the SSE `session {kind:'charts'}` broadcast.
   * Save-pin interaction: none (trace §4.1c) — a chart accepted while
   * a save is pinned carries revision > pinnedRev and is excluded
   * from that save by runDirectSave's at-cut snapshot of this list.
   */
  async function acceptChart(specIn: ChartSpec, principal: string): Promise<{ id: number | string; revision: number }> {
    const spec: ChartSpec = { ...specIn, nativePart: true };
    state.sessionCharts.push(spec);
    state.revision++;
    const newRevision = state.revision;
    const origin: DeltaOrigin = { clientId: null, clientSeq: null, principal };
    const journalOp = { cmd: 'chart.add', spec } as unknown as EngineCommand;
    state.deltaLog.push({ revision: newRevision, origin, op: journalOp, cells: [], collab: null });
    if (state.deltaLog.length > DELTA_LOG_CAP) {
      const evicted = state.deltaLog.splice(0, state.deltaLog.length - DELTA_LOG_CAP);
      const last = evicted[evicted.length - 1];
      if (last && last.revision > state.retentionFloor) state.retentionFloor = last.revision;
    }
    if (state.sessionId && state.sessionStatus === 'active') {
      try {
        state.journalBuffer.push({
          revision: newRevision,
          op: journalOp,
          at: Date.now(),
          delta: [],
          origin,
        });
        state.opsSinceSnapshot++;
        if (state.journalBuffer.length >= segmentMaxOps) {
          await flushJournalSegment();
        }
      } catch (e) {
        console.log(
          `[engine] JOURNAL FLUSH FAILED (chart.add) session=${state.sessionId} revision=${newRevision}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    state.pendingCheckpointOps++;
    state.pendingCheckpointOpCmds.push('chart.add');
    if (state.pendingCheckpointOps >= AUTOSAVE_BATCH_OPS_CAP) {
      void checkpointSession('segment-cap').catch((e) => {
        console.log(
          `[engine] segment-cap checkpoint failed session=${state.sessionId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    } else {
      armAutosaveCheckpoint();
    }
    broadcastSession({ kind: 'charts', revision: newRevision, charts: state.sessionCharts });
    broadcastStatus();
    return { id: spec.id, revision: newRevision };
  }

  // -- load/build gate (W20: read-during-build) ---------------------------
  // While a /load or /load/stream is between "body accepted" and "built",
  // state.host still holds the PREVIOUS workbook (or the blank boot
  // workbook): the parse runs async in workers with the event loop free,
  // so /read requests ARE processed in that window and used to hit the
  // stale host — `Unknown sheet: <new sheet>` → outer-catch 500 (fast,
  // 1–28 ms; 81–120 per large open in the W18 gate), or stale values
  // when the sheet name existed in the old file too. Reads that arrive
  // during the later SYNCHRONOUS build block in the socket queue and
  // are served from the new workbook when the loop frees — the gate
  // extends that same pend semantics to the whole load window.
  //
  // Contract: a read arriving while a gate is open WAITS for the build
  // (bounded by BUILD_WAIT_TIMEOUT_MS), then serves the new workbook.
  // A failed build settles the gate with the build's error: waiting
  // reads surface it, and it stays sticky (lastBuildError) so reads
  // after the failure surface it too, until the next successful load,
  // a /reset, or a session (re)install (registerSession /
  // rehydrateSession — issue #26) clears it. The gate promise never
  // rejects (the error rides on the gate object) so a build with no
  // waiting reads can never produce an unhandled rejection.
  interface LoadBuildGate {
    settled: boolean;
    error: unknown;
    promise: Promise<void>;
    settle: (error?: unknown) => void;
  }
  let loadBuildGate: LoadBuildGate | null = null;
  let lastBuildError: unknown = null;

  function asError(e: unknown): Error {
    return e instanceof Error ? e : new Error(String(e));
  }

  function beginLoadBuild(): LoadBuildGate {
    let resolveGate!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    const gate: LoadBuildGate = {
      settled: false,
      error: null,
      promise,
      settle: () => undefined, // replaced below (needs `gate` in scope)
    };
    gate.settle = (error?: unknown) => {
      if (gate.settled) return;
      gate.settled = true;
      gate.error = error ?? null;
      lastBuildError = error ?? null;
      resolveGate();
    };
    loadBuildGate = gate;
    lastBuildError = null;
    return gate;
  }

  function endLoadBuild(gate: LoadBuildGate, error?: unknown): void {
    gate.settle(error);
    if (loadBuildGate === gate) loadBuildGate = null;
  }

  /**
   * Returns true when this caller actually PENDED on an in-flight build
   * (a gate was open on arrival). Item H: the /read handler needs that
   * signal — a read that waited out a load was necessarily issued
   * against the PREVIOUS workbook (or the boot workbook) whenever it
   * raced the open, so if its sheet does not exist in the workbook that
   * just replaced it, the read is SUPERSEDED, not an engine fault.
   */
  async function waitForLoadBuild(): Promise<boolean> {
    const gate = loadBuildGate;
    if (gate) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          gate.promise,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `timed out after ${BUILD_WAIT_TIMEOUT_MS}ms waiting for the workbook build to finish`,
                  ),
                ),
              BUILD_WAIT_TIMEOUT_MS,
            );
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (gate.error !== null && gate.error !== undefined) throw asError(gate.error);
      return true;
    }
    if (lastBuildError !== null && lastBuildError !== undefined) throw asError(lastBuildError);
    return false;
  }

  // Google-connector formula seams (Cycle-3 GAP-1): the engine exposes the
  // seams, this host wires the vault-resolved credential into them. The
  // seams are process-global engine state, so this runs once per process —
  // not per wireFresh() (workbook rebuilds don't change the credential).
  // Fire-and-forget: resolution is async, and the honest fallbacks stay
  // active until (and unless) a credential resolves.
  wireGoogleFormulaSeams({
    resolveCredential: deps.resolveGoogleCredential,
    logger: (m) => console.log(`[engine] ${m}`),
  }).catch((e) => {
    console.log(`[engine] google seams wiring failed: ${e instanceof Error ? e.message : String(e)}`);
  });

  function principalOf(req: IncomingMessage): string {
    return requestPrincipal(req, 'user');
  }

  /** Permission-filtered snapshot: drop cells the principal cannot read. */
  function filteredSnapshot(principal: string): WorkbookSnapshot {
    const full = state.host.snapshot();
    const auth = { principal };
    return {
      protocolVersion: full.protocolVersion,
      sheets: full.sheets.map((sheet) => {
        // Snapshot-join slicer fix (#69 Piece A): carry the retained
        // per-sheet tables in the mapper's narrow shape. Tables are
        // structural metadata, carried unfiltered like the /load
        // response's tables (loadResponse) — the per-cell filter above
        // still governs every cell value. snapshotToWorkbookData and
        // namedRangeToWorkbookData build {name, rows} sheets and ignore
        // this field, so save serialization is untouched.
        const tables = state.sourceSheetTables.get(sheet.name);
        return {
          name: sheet.name,
          cells: sheet.cells.filter((cell) => {
            const v = state.host.readCell(cell.ref, auth);
            return !(v.kind === 'error' && v.code === '#PERM!');
          }),
          ...(tables && tables.length > 0
            ? {
                tables: tables.map((t) => ({
                  id: t.id,
                  sheet: t.sheet,
                  startCol: t.startCol,
                  columns: t.columns,
                })),
              }
            : {}),
        };
      }),
      // Defect E1: the filtered snapshot feeds /snapshot AND every
      // server-side save — it must carry the defined names through.
      ...(full.definedNames ? { definedNames: full.definedNames } : {}),
    };
  }

  /**
   * The workbook metadata a /snapshot response carries (File-2 D1
   * follow-up): the loaded file's adapter metadata merged UNDER the
   * session's client extras — the same later-wins order the save path
   * uses (buildSaveData) — JSON-encoded exactly like the /load payload's
   * `file.metadata`, so a joining/rehydrating client hydrates its
   * metadata-driven overlays (imported pictures, text boxes, chart
   * specs…) from the snapshot exactly as the first opener hydrates them
   * from the load result. Overlay metadata is presentation state, not
   * cell content, so — like the load payload — it is not
   * permission-filtered per principal.
   */
  function snapshotMetadata(): Record<string, unknown> {
    const metadata: Record<string, unknown> = { ...state.sourceMetadata };
    const extra = state.pendingExtras.extraMetadata;
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
      Object.assign(metadata, extra as Record<string, unknown>);
    }
    return encodeMetadataForJson(metadata);
  }

  /**
   * The session's resolved per-sheet styles + number-format codes for
   * the /snapshot response (#134). Resolution mirrors the save path's
   * resolved-presentation rule EXACTLY (serializeLiveWorkbook): a
   * sheet the session's client extras report resolves to that map
   * (even an empty one — a genuine clear-all is authoritative); any
   * other sheet resolves to the loaded file's own styles/formats held
   * in state. A joining client seeds its format store from these, so
   * its first extras push carries the full map instead of an empty
   * one that would wipe the file's imported styles on the next
   * serialization. Like snapshotMetadata, this is presentation state,
   * not cell content, so it is not permission-filtered per principal.
   * Sheets with neither styles nor formats are omitted (an empty
   * record would seed nothing either way).
   */
  function snapshotSheetStyles(): {
    sheetStyles: Record<string, Record<string, import('@icecream-sheets/engine').CellStyle>>;
    sheetFormats: Record<string, Record<string, string>>;
  } {
    const client = sanitizeSheetStyles(state.pendingExtras.sheetStyles);
    const sheetStyles: Record<string, Record<string, import('@icecream-sheets/engine').CellStyle>> = {};
    const sheetFormats: Record<string, Record<string, string>> = {};
    for (const name of state.host.sheetNames()) {
      if (client && Object.prototype.hasOwnProperty.call(client, name)) {
        const map = client[name] ?? {};
        if (Object.keys(map).length > 0) sheetStyles[name] = map;
        const fmts: Record<string, string> = {};
        for (const [key, style] of Object.entries(map)) {
          if (style.numberFormatCode) fmts[key] = style.numberFormatCode;
        }
        if (Object.keys(fmts).length > 0) sheetFormats[name] = fmts;
      } else {
        const parsed = state.sourceSheetStyles.get(name);
        if (parsed && Object.keys(parsed).length > 0) sheetStyles[name] = parsed;
        const formats = decodeFormatsWire(state.sourceSheetFormats.get(name));
        if (formats && Object.keys(formats).length > 0) sheetFormats[name] = formats;
      }
    }
    if (process.env.ENGINE_DIAG_STYLES === '1') {
      console.log(
        `[engine] snapshotSheetStyles session=${state.sessionId} ` +
          `pendingKeys=${Object.keys((state.pendingExtras.sheetStyles as Record<string, unknown> | undefined) ?? {}).join(',') || '(none)'} ` +
          `sourceSizes=${[...state.sourceSheetStyles.entries()].map(([n, m]) => `${n}=${Object.keys(m).length}`).join(',') || '(empty)'} ` +
          `served=${Object.keys(sheetStyles).join(',') || '(none)'}`,
      );
    }
    return { sheetStyles, sheetFormats };
  }

  /** Session extras a save may carry (see /download header). */
  interface SaveExtras {
    format?: unknown;
    filename?: unknown;
    extraMetadata?: unknown;
    definedNames?: unknown;
    sheetDims?: unknown;
    /**
     * Session cell styles (defect D4): the client's resolved format
     * store, per sheet, keyed "row:col" — the ONLY channel by which
     * ribbon-applied formats can reach this server-side serialization,
     * since formats are UI presentation state the engine never holds.
     * A sheet PRESENT here (even with an empty record) is authoritative
     * for that sheet; absent sheets fall back to the loaded file's own
     * formats/styles held in state.
     */
    sheetStyles?: unknown;
    scope?: unknown;
    namedRange?: unknown;
  }

  /**
   * Build the WorkbookData a server-side save serializes, for either the
   * whole workbook (metadata merge + dims, exactly the defect-2c path) or
   * one named-range subset. The snapshot is permission-filtered for the
   * requesting principal in both scopes (protection §6).
   */
  function buildSaveWorkbookData(
    extras: SaveExtras,
    principal: string,
  ): { ok: true; wbData: WorkbookData } | { ok: false; status: number; error: string } {
    if (extras.scope !== undefined && extras.scope !== 'workbook' && extras.scope !== 'namedRange') {
      return { ok: false, status: 400, error: "scope must be 'workbook' or 'namedRange'" };
    }
    if (extras.scope === 'namedRange') {
      const nr = extras.namedRange as { name?: unknown; ref?: unknown } | undefined;
      if (!nr || typeof nr.name !== 'string' || nr.name.length === 0) {
        return { ok: false, status: 400, error: "namedRange scope needs namedRange: { name: string, ref: {...} }" };
      }
      if (nr.ref === null || nr.ref === undefined) {
        return {
          ok: false,
          status: 400,
          error: `Cannot download "${nr.name}": it no longer refers to any cells (#REF!).`,
        };
      }
      if (!isServerNamedRangeRef(nr.ref)) {
        return { ok: false, status: 400, error: 'namedRange.ref must be { sheet, startRow, startCol, endRow, endCol }' };
      }
      return {
        ok: true,
        wbData: namedRangeToWorkbookData(filteredSnapshot(principal), { name: nr.name, ref: nr.ref }),
      };
    }
    // Metadata merge (later wins): the loaded file's own adapter
    // metadata → the live protection state → the client's session
    // extras (UI-only state the server never held: chart specs,
    // pictures, page-setup dialog edits, …).
    const metadata: Record<string, unknown> = { ...state.sourceMetadata };
    try {
      Object.assign(metadata, state.protection.toMetadata());
    } catch {
      // Protection metadata is a hint channel; never fail a save on it.
    }
    if (
      extras.extraMetadata &&
      typeof extras.extraMetadata === 'object' &&
      !Array.isArray(extras.extraMetadata)
    ) {
      Object.assign(metadata, extras.extraMetadata as Record<string, unknown>);
    }
    // Defect E1: defined names = the LIVE engine names (via the filtered
    // snapshot — imported names, runtime definitions, LAMBDA functions,
    // and HF-unbindable names preserved from load) merged UNDER the
    // client's session extras (Name-Manager store definitions). The old
    // rule — any extras array, even [], replaces everything — zeroed
    // the table on every real client save, because the client's store
    // is never populated on open. (state.sourceDefinedNames is NOT a
    // fallback anymore: the snapshot's live list already includes the
    // load-time names, and resurrecting source names would undo a
    // legitimate in-session deletion.)
    const snap = filteredSnapshot(principal);
    const definedNames = mergeDefinedNames(
      snap.definedNames,
      Array.isArray(extras.definedNames) ? (extras.definedNames as DefinedName[]) : undefined,
    );
    const wbData = snapshotToWorkbookData(snap, metadata, definedNames);
    // Sheet dims: the loaded file's dims for every sheet, overlaid
    // with the client's session dims for the sheets it reports
    // (its active-sheet grid sizes are the freshest).
    const clientDims =
      extras.sheetDims && typeof extras.sheetDims === 'object' && !Array.isArray(extras.sheetDims)
        ? (extras.sheetDims as Record<string, Record<string, unknown>>)
        : {};
    for (const sheet of wbData.sheets) {
      const dims = { ...(state.sourceSheetDims.get(sheet.name) ?? {}) };
      const over = clientDims[sheet.name];
      if (over && typeof over === 'object') {
        if (over.colWidths && typeof over.colWidths === 'object') {
          dims.colWidths = over.colWidths as Record<string, number>;
        }
        if (over.rowHeights && typeof over.rowHeights === 'object') {
          dims.rowHeights = over.rowHeights as Record<string, number>;
        }
        if (Array.isArray(over.hiddenCols)) dims.hiddenCols = over.hiddenCols as number[];
        if (Array.isArray(over.hiddenRows)) dims.hiddenRows = over.hiddenRows as number[];
      }
      if (dims.colWidths && Object.keys(dims.colWidths).length > 0) sheet.colWidths = dims.colWidths;
      if (dims.rowHeights && Object.keys(dims.rowHeights).length > 0) sheet.rowHeights = dims.rowHeights;
      if (dims.hiddenCols && dims.hiddenCols.length > 0) sheet.hiddenCols = dims.hiddenCols;
      if (dims.hiddenRows && dims.hiddenRows.length > 0) sheet.hiddenRows = dims.hiddenRows;
    }
    // Cell formats + styles (defect D4): for each sheet, the client's
    // session styles (when the sheet is present in the extras) are the
    // authoritative resolved format store — the number-format map is
    // derived from the styles' codes so the two channels can never
    // disagree. Sheets the client did not report keep the loaded file's
    // own formats/styles (previously dropped entirely by this path).
    const clientStyles = sanitizeSheetStyles(extras.sheetStyles);
    for (const sheet of wbData.sheets) {
      if (clientStyles && Object.prototype.hasOwnProperty.call(clientStyles, sheet.name)) {
        const styles = clientStyles[sheet.name] as Record<string, import('@icecream-sheets/engine').CellStyle>;
        if (Object.keys(styles).length > 0) {
          sheet.styles = styles;
          const formats: Record<string, string> = {};
          for (const [key, style] of Object.entries(styles)) {
            if (style.numberFormatCode) formats[key] = style.numberFormatCode;
          }
          if (Object.keys(formats).length > 0) sheet.formats = formats;
        }
        continue;
      }
      const srcStyles = state.sourceSheetStyles.get(sheet.name);
      if (srcStyles && Object.keys(srcStyles).length > 0) sheet.styles = srcStyles;
      const srcFormats = decodeFormatsWire(state.sourceSheetFormats.get(sheet.name));
      if (srcFormats && Object.keys(srcFormats).length > 0) sheet.formats = srcFormats;
    }
    return { ok: true, wbData };
  }

  // -- direct streaming save (SAVE SERIALIZATION INVARIANT) --------------
  // Whole-workbook .xlsx serialization is a DIRECT one-pass streaming
  // pass over the LIVE engine model (serializeLiveWorkbook in
  // @icecream-sheets/service/save-node): untouched package parts are
  // copied byte-for-byte from the retained source bytes, changed
  // sheets are generated row-by-row from a single bulk readback of the
  // live model. There is NO per-save worker rebuild (the W21 design)
  // and NO snapshot→dense→SheetJS materialization: the server model is
  // always hydrated and is the source of truth, so a rebuild could
  // only ever reproduce — or diverge from — the state already here.
  //
  // EXCEL SAVE SEQUENCE (user directive, 2026-10-21) — every caller of
  // runDirectSave follows it: (1) finish all pending recalc first, so
  // the pinned revision is a fully-calculated state; (2) serialize to
  // a TEMPORARY file, never over the original and never streamed
  // half-built; (3) VERIFY the finished package; only then does the
  // caller replace/stream it (library-save: tmp+rename in the library
  // dir; checkpoint: bytes into the snapshot store; /download: the
  // verified temp file is streamed). Any failure before that point
  // leaves the original byte-identical, surfaces a save error, and
  // keeps the session usable.

  /**
   * Step (1) of the Excel save sequence: let any pending recalculation
   * finish before the save pins its revision.
   *
   * What exists today (verified by grep over packages/engine/src for
   * recalcPool/drain/settle/whenIdle/pending): EngineHost exposes NO
   * drain/settle/whenIdle API and the parallel pool (RecalcWorkerPool)
   * exposes no settle handle either — the only async recalc surface is
   * the executeAsync('recalculateParallel') TRIGGER, and /execute
   * already awaits it before responding whenever an edit routes
   * parallel (see the wantsParallel branch), so no parallel work is
   * ever in flight when a save request arrives. Ordinary recalc needs
   * no draining at all: /execute recalc is SYNCHRONOUS — HyperFormula
   * evaluates inside execute() itself, so at pin time the live state
   * is fully calculated by construction, never provisional. On the
   * client side, the save interlock (awaitEditsSettled in the web app)
   * covers in-flight routed edits: a save request is only issued once
   * the client's outstanding edit round-trips have settled.
   *
   * This helper still PROBES for a settle/drain handle so that if the
   * engine grows one, every save path picks it up here — in exactly
   * one place, before the pin.
   */
  async function settlePendingRecalc(): Promise<void> {
    const host = state.host as unknown as {
      whenIdle?: () => Promise<void> | void;
      drainRecalc?: () => Promise<void> | void;
      settleRecalc?: () => Promise<void> | void;
    };
    if (typeof host.whenIdle === 'function') await host.whenIdle();
    else if (typeof host.drainRecalc === 'function') await host.drainRecalc();
    else if (typeof host.settleRecalc === 'function') await host.settleRecalc();
    // No probe handle exists today: nothing further to await.
  }

  /**
   * Step (3a): verify the finished temp package before any caller may
   * stream, store, or replace with it. verifyXlsxPackage is coded
   * against defensively: a throw, a `false`, or an `{ ok: false }` /
   * `{ valid: false }` result are all verification failures.
   */
  async function verifyDirectSavePackage(outPath: string): Promise<void> {
    const verdict: unknown = await (verifyXlsxPackage as (p: string) => unknown)(outPath);
    if (verdict === false) {
      throw new Error(`direct save verification failed for ${outPath}: package rejected`);
    }
    if (
      verdict !== null &&
      typeof verdict === 'object' &&
      ((verdict as { ok?: unknown }).ok === false || (verdict as { valid?: unknown }).valid === false)
    ) {
      const detail = (verdict as { errors?: unknown; error?: unknown }).errors ??
        (verdict as { error?: unknown }).error;
      throw new Error(
        `direct save verification failed for ${outPath}: ${detail ? JSON.stringify(detail).slice(0, 300) : 'package rejected'}`,
      );
    }
  }

  /**
   * Run one whole-workbook .xlsx save as a direct streaming pass over
   * the live model, writing a verified TEMP file. Returns
   * { outPath, result, cleanup } — the caller owns the file until it
   * calls cleanup() (after streaming/copying it out).
   *
   * PINNED REVISION GUARANTEE (Addendum 4 — pin + copy-on-write
   * stash, superseding the original no-await interleave design):
   * after the recalc settle, the save assembly (metadata / names /
   * metas / ops) runs synchronously at `pinnedRev = state.revision`;
   * the host then pins that cut (beginSavePin) and the bulk is read
   * SHEET BY SHEET via bulkReadbackSheetPinned, yielding between
   * sheets so edits genuinely process during the read. The host
   * stashes every mid-read edit's pre-state into the pin, so the
   * assembled bulk is a frozen, consistent copy of exactly the pinned
   * revision; the pin is released as soon as the bulk is assembled
   * and serialization runs from the frozen copy. Ops that cannot be
   * stashed throw SavePinOverflowError in /execute, whose route
   * queues and retries them (see there).
   */
  async function runDirectSave(extrasIn: SaveExtras, principal: string) {
    // Addendum 6 extras channel: the session's continuously-synced
    // pendingExtras form the base layer; the per-request extras win
    // per top-level key (an explicit save/download payload is never
    // overridden by the background channel).
    const extras: SaveExtras = {
      sheetStyles: extrasIn.sheetStyles ?? state.pendingExtras.sheetStyles,
      sheetDims: extrasIn.sheetDims ?? state.pendingExtras.sheetDims,
      definedNames: extrasIn.definedNames ?? state.pendingExtras.definedNames,
      extraMetadata: extrasIn.extraMetadata ?? state.pendingExtras.extraMetadata,
      format: extrasIn.format,
      filename: extrasIn.filename,
      scope: extrasIn.scope,
    };
    // Excel sequence step (1): finish pending recalc BEFORE the pin.
    await settlePendingRecalc();

    // The service revision at the save's cut. The assembly below
    // (metadata / names / metas / parsed sheets / ops) is fully
    // synchronous — atomic on the event loop — so the save pin taken
    // right after it pins exactly this revision's state (asserted
    // below). Consistency during the (yielding) read phase comes from
    // the pin's copy-on-write stash, not from freezing the world:
    // edits keep applying to the live model, pinned reads keep
    // observing this cut.
    const pinnedRev = state.revision;
    // FIX-G: the session charts at THIS cut (trace §4.1c save-pin
    // rule): a chart accepted after the pin carries a higher revision
    // and belongs to the next save, not this one. This snapshot is
    // taken in the same synchronous assembly section as pinnedRev.
    const chartsAtCut = state.sessionCharts.slice();

    // Merged metadata, exactly the buildSaveHandoff merge order:
    // the loaded file's adapter metadata → the live protection state
    // → the client's session extras.
    const metadata: Record<string, unknown> = { ...state.sourceMetadata };
    try {
      Object.assign(metadata, state.protection.toMetadata());
    } catch {
      // Protection metadata is a hint channel; never fail a save on it.
    }
    if (
      extras.extraMetadata &&
      typeof extras.extraMetadata === 'object' &&
      !Array.isArray(extras.extraMetadata)
    ) {
      Object.assign(metadata, extras.extraMetadata as Record<string, unknown>);
    }
    // #125 moved-native-chart re-anchor: the client's current native
    // anchors (save-extras carrier, px) diffed against the source
    // package's originals (icecream.charts, EMU). The pairs ride into
    // the serializer, which rewrites the matching drawing anchors.
    // Empty when the client sends no carrier (old clients, no moves).
    const movedNativeCharts = diffMovedNativeCharts(
      state.sourceMetadata[CHARTS_METADATA_KEY],
      (metadata as Record<string, unknown>)[NATIVE_CHART_ANCHORS_METADATA_KEY],
    );
    // Defined names (E1 rule, unchanged): the host's live names list
    // (the O(names) accessor — a full snapshot() here unparses all
    // ~480k formula cells at P95) merged UNDER the client's session
    // extras.
    const definedNames = mergeDefinedNames(
      state.host.getDefinedNames(),
      Array.isArray(extras.definedNames) ? (extras.definedNames as DefinedName[]) : undefined,
    );
    // Per-sheet metas: the same client-styles / client-dims forwarding
    // loop buildSaveHandoff used (sanitizeSheetStyles + extras.sheetDims).
    // Only the client's reported state is forwarded; the serializer
    // compares it against parsedSheets (the source's own records) and
    // decides per sheet whether anything actually changed.
    const clientDims =
      extras.sheetDims && typeof extras.sheetDims === 'object' && !Array.isArray(extras.sheetDims)
        ? (extras.sheetDims as Record<string, Record<string, unknown>>)
        : {};
    const clientStyles = sanitizeSheetStyles(extras.sheetStyles);
    const sheetNames = state.host.sheetNames();
    const sheets: DirectSaveSheetMeta[] = [];
    for (const name of sheetNames) {
      const meta: DirectSaveSheetMeta = { name, clientStyles: false, clientDims: false };
      if (clientStyles && Object.prototype.hasOwnProperty.call(clientStyles, name)) {
        meta.clientStyles = true;
        const styles = clientStyles[name] as Record<string, import('@icecream-sheets/engine').CellStyle>;
        if (Object.keys(styles).length > 0) meta.styles = styles;
      }
      const over = clientDims[name];
      if (over && typeof over === 'object') {
        meta.clientDims = true;
        const dims: NonNullable<DirectSaveSheetMeta['dims']> = {};
        if (over.colWidths && typeof over.colWidths === 'object') {
          dims.colWidths = over.colWidths as Record<string, number>;
        }
        if (over.rowHeights && typeof over.rowHeights === 'object') {
          dims.rowHeights = over.rowHeights as Record<string, number>;
        }
        if (Array.isArray(over.hiddenCols)) dims.hiddenCols = over.hiddenCols as number[];
        if (Array.isArray(over.hiddenRows)) dims.hiddenRows = over.hiddenRows as number[];
        meta.dims = dims;
      }
      sheets.push(meta);
    }
    // The source's own per-sheet presentation records, from state:
    // styles + number formats + dims as parsed at /load. The
    // serializer resolves each sheet's effective presentation from
    // these vs the client-forwarded metas above.
    const parsedSheets = new Map<string, DirectSaveParsedSheet>();
    for (const name of sheetNames) {
      const parsed: DirectSaveParsedSheet = {};
      const styles = state.sourceSheetStyles.get(name);
      if (styles && Object.keys(styles).length > 0) parsed.styles = styles;
      const formats = decodeFormatsWire(state.sourceSheetFormats.get(name));
      if (formats && Object.keys(formats).length > 0) parsed.formats = formats;
      const dims = state.sourceSheetDims.get(name);
      if (dims) {
        if (dims.colWidths && Object.keys(dims.colWidths).length > 0) parsed.colWidths = dims.colWidths;
        if (dims.rowHeights && Object.keys(dims.rowHeights).length > 0) parsed.rowHeights = dims.rowHeights;
        if (dims.hiddenCols && dims.hiddenCols.length > 0) parsed.hiddenCols = dims.hiddenCols;
        if (dims.hiddenRows && dims.hiddenRows.length > 0) parsed.hiddenRows = dims.hiddenRows;
      }
      parsedSheets.set(name, parsed);
    }
    // Changed-set ops: the save journal's ops, reduced to the
    // { cmd, ref } shape the serializer consumes (directSaveOps).
    // The direct path does NOT depend on journal completeness for
    // STATE (it reads the live model) — but the changed-sheet set is
    // derived from these ops, and past SAVE_OPS_CAP the journal was
    // dropped, so it would UNDER-report changed sheets and a
    // verbatim copy could ship a stale part for an edited sheet the
    // journal lost. Honest handling: when the journal is no longer
    // intact (!saveWorkerEligible), force EVERY sheet changed with a
    // per-sheet setCell marker op. The serializer then regenerates
    // every sheet from the live bulk (still one streaming pass — the
    // per-sheet marker form is chosen precisely so the save stays on
    // the streaming path rather than degrading to adapter-fallback).
    // Item C: the marker form alone silently changed PLANNING for
    // structural history — the ops list is the serializer's only
    // signal that the sheet set changed or setCalculationMode ran
    // (parsedSheets above is keyed by LIVE sheet names), so a dropped
    // journal made an added sheet vanish from workbook.xml and a
    // deleted sheet resurrect from its verbatim part. directSaveOps
    // therefore re-attaches the bounded structural summary
    // (state.saveStructuralCmds, never dropped at the cap) to the
    // markers, keeping the at-cap planning class identical to the
    // pre-cap plan for the same history.
    const ops: Array<{ cmd: string; ref?: CellRef }> = directSaveOps(state, sheetNames);
    // READ PHASE (Addendum 4 — pin + copy-on-write stash): pin the
    // current revision on the host, then assemble the serializer bulk
    // SHEET BY SHEET through bulkReadbackSheetPinned, yielding to the
    // event loop between sheets so in-flight /execute requests
    // actually process during the read. Edits landing mid-read apply
    // to the live model; the host stashes their pre-state into the
    // pin, so every pinned read still observes exactly the pinned
    // cut — the assembled bulk is a frozen, consistent copy. (Two
    // revision domains, one cut: pin.rev is the ENGINE HOST's
    // mutating-op count; pinnedRev is THIS SERVICE's edit revision.
    // They are taken at the same atomic instant — the assert below —
    // and the service domain is what saves report/commit, since it is
    // the domain storageRevision and the client ack sequence use.)
    const pin = state.host.beginSavePin();
    if (state.revision !== pinnedRev) {
      state.host.releaseSavePin(pin);
      throw new Error(
        `direct save aborted: revision moved during save assembly (pinned ${pinnedRev}, now ${state.revision}) — no file emitted`,
      );
    }
    // Issue #67: the volatile-taint set for the state checksum below,
    // derived in this SAME atomic section — it must describe exactly
    // the pinned cut the bulk is frozen from. The read phase yields
    // and mid-read edits advance the live model; deriving the set
    // there could taint (or untaint) cells against a bulk that no
    // longer matches the live graph, producing a checksum no rebuild
    // can reproduce.
    const volatileKeys = volatileValueKeySet();
    activeSavePins++;
    let bulk: ReturnType<EngineHost['bulkReadback']>;
    try {
      bulk = [];
      for (const name of sheetNames) {
        // Permission-filtered for the REQUESTING principal (the pinned
        // read applies readCell's exact authorization per principal):
        // cells the principal cannot read arrive as #PERM! and are
        // dropped by the serializer — never leaked (face e).
        // NB: no spread into push() — a P95 sheet's readback is
        // ~600k entries and spreading it into call arguments exceeds
        // V8's argument-count limit (RangeError: Maximum call stack
        // size exceeded). Append iteratively.
        for (const entry of state.host.bulkReadbackSheetPinned(pin, name, { principal })) {
          bulk.push(entry);
        }
        await new Promise((r) => setImmediate(r));
      }
      console.log(
        `[engine] save pin rev=${pinnedRev} stashedCells=${state.host.savePinStashCells(pin)}`,
      );
    } finally {
      // Release as soon as the bulk is assembled: the bulk is the
      // frozen copy; serialization below runs from it, pin-free, so
      // queued edits (the /execute overflow queue) unblock at once.
      state.host.releaseSavePin(pin);
      activeSavePins--;
    }
    // Excel sequence step (2): serialize to a TEMPORARY file. Nothing
    // streams, stores, or replaces from a half-built file: callers
    // only ever see the completed, verified temp file below.
    const dir = mkdtempSync(join(tmpdir(), 'icecream-direct-save-'));
    const outPath = join(dir, 'out.xlsx');
    const cleanup = (): void => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Temp cleanup must never fail a save that already completed.
      }
    };
    let result: ReturnType<typeof serializeLiveWorkbook>;
    try {
      result = serializeLiveWorkbook({
        bulk,
        sheetNames,
        definedNames,
        metadata,
        sourceBytes: state.sourceBytes,
        parsedSheets,
        sheets,
        ops,
        charts: chartsAtCut,
        movedNativeCharts,
        outPath,
        log: (m: string) => console.log(`[engine] ${m}`),
      });
      // No revision check here (superseded by the pin, Addendum 4):
      // the live revision may legitimately have ADVANCED past
      // pinnedRev during the read phase — stashed edits applied
      // live — while `bulk` stayed frozen at the cut. The serializer
      // consumes only the frozen bulk, so the file is exactly the
      // pinned revision regardless.
    } catch (e) {
      cleanup();
      throw e;
    }
    // -- end of the pinned synchronous section --
    // Excel sequence step (3a): VERIFY the finished temp package
    // before returning it. A verification failure cleans the temp and
    // fails the save; the original (library file / snapshot / client)
    // is untouched because no caller has seen the path yet.
    try {
      await verifyDirectSavePackage(outPath);
    } catch (e) {
      cleanup();
      throw e;
    }
    // Full-state checksum over the assembled bulk (the frozen pinned
    // state the file was serialized from) — checkpoint callers store
    // it for rehydrate verification instead of paying a second
    // whole-workbook pass. Volatile-tainted cells (set derived at the
    // pin, above) are covered by input, not value (issue #67).
    const stateChecksum = checksumFromBulk(bulk, volatileKeys);
    return { outPath, result, cleanup, pinnedRev, stateChecksum };
  }

  /** The library store directory for this service instance. */
  function libraryDir(): string {
    return deps.libraryDir ?? join(gatewayDataDir(), 'library');
  }

  /**
   * Commit a VERIFIED temp .xlsx into the principal's library store
   * (Excel sequence, final step — the atomic replace): copy to a tmp
   * name in the library dir, RENAME over the entry's file, then update
   * the index. The pre-existing entry file is never touched before the
   * rename, so a failure anywhere earlier leaves stored bytes
   * byte-identical. Shared by /library-save (a save) and /download
   * (save-then-fetch separation: a download IS a save into a fresh
   * entry, fetched later via the signed /storage URL).
   */
  function commitLibraryEntry(
    principal: string,
    id: string,
    name: string,
    outPath: string,
    sizeBytes: number,
  ): ServerLibraryEntry {
    const dir = libraryDir();
    mkdirSync(dir, { recursive: true });
    const file = libraryFileFor(dir, principal, id);
    const tmp = `${file}.${process.pid}.tmp`;
    copyFileSync(outPath, tmp);
    renameSync(tmp, file);
    const index = readLibraryIndex(dir);
    const now = Date.now();
    const existing = index.entries.find((e) => e.principal === principal && e.id === id);
    const entry: ServerLibraryEntry = {
      id,
      name,
      owner: principal,
      createdAt: existing?.createdAt ?? now,
      modifiedAt: now,
      sizeBytes,
      backend: 'gateway',
    };
    if (existing) Object.assign(existing, entry);
    else index.entries.push({ ...entry, principal });
    writeLibraryIndex(dir, index);
    return entry;
  }

  // -- deployment session lifecycle (extensions 1–3) -----------------------
  // The checksum machinery is the engine's ack checksum
  // (packages/engine/src/ack-checksum.ts) applied to the WHOLE workbook
  // state: refs = every cell of the owner-filtered snapshot, values =
  // the typed view's values. Same serialization both sides of a
  // checkpoint/rehydrate pair, so equality means the rebuilt workbook's
  // values are exactly the checkpointed ones — the reconnect unlock
  // condition (deployment doc §Idle rule 4, HYBRID-CONSISTENCY §6).
  // Issue #67 exception: VOLATILE-TAINTED cells (volatile formulas,
  // volatile defined-name references, and their transitive dependents —
  // EngineWorkbook.getVolatileValueCells) are covered by their INPUT
  // instead of their value. Their values are a function of wall-clock
  // time / randomness, so a value comparison can never hold across a
  // rebuild; their inputs are deterministic and round-trip verbatim
  // through the snapshot bytes, so the integrity coverage is preserved
  // (a tampered volatile formula is still caught). Workbooks with no
  // volatile cells hash bit-identically to the legacy all-values form.

  /** Key of one cell in a volatile-taint set: sheet ␁ row ␁ col. */
  function volatileCellKey(ref: CellRef): string {
    return `${ref.sheet}\u0001${ref.row}\u0001${ref.col}`;
  }

  /**
   * The volatile-taint key set of the CURRENT live workbook. Callers
   * must derive it from the same state the bulk describes: synchronously
   * alongside a live bulk (fullStateChecksum), or inside the save pin's
   * atomic section for the pinned bulk (runDirectSave) — never across
   * an await from the bulk it will be applied to. Derivation failure
   * degrades to the legacy all-values checksum, which fails CLOSED at
   * rehydrate for volatile workbooks (the pre-#67 behavior), never open.
   */
  function volatileValueKeySet(): Set<string> {
    const out = new Set<string>();
    try {
      for (const ref of state.host.getVolatileValueCells()) out.add(volatileCellKey(ref));
    } catch (e) {
      console.warn(
        `[engine] volatile taint derivation failed; checksum uses values only: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return out;
  }

  /**
   * Full-state checksum over a bulk readback (value equality contract):
   * SHA-256 streamed over the ack-checksum line format
   * (sheet ␁ row ␁ col ␂ serialized-value, ␃-separated) in canonical
   * (sheet-name, row, col) order. Computed from the SAME bulk the
   * serializer consumes — the previous implementation took a second
   * full pass (filteredSnapshot + per-cell readCell + a joined-string
   * FNV) that cost ~41 s at P95 scale on top of the save's own bulk
   * assembly, and was itself a whole-workbook snapshot inside the
   * save path (design doc §2). Phantom empties are NOT state:
   * structural ops materialize explicit null-input, null-value cells
   * for the inserted band in the live model, but no file round-trip
   * preserves them, so they are excluded on BOTH sides (checkpoint
   * and rehydrate verification use this one function). Entries whose
   * key is in `volatileKeys` hash their serialized INPUT in place of
   * the value (issue #67 — see the lifecycle note above).
   */
  function checksumFromBulk(
    bulk: ReadonlyArray<{ ref: CellRef; input: unknown; value: TypedValue }>,
    volatileKeys?: ReadonlySet<string>,
  ): string {
    const hash = createHash('sha256');
    const bySheet = new Map<string, Array<{ ref: CellRef; input: unknown; value: TypedValue }>>();
    for (const e of bulk) {
      const arr = bySheet.get(e.ref.sheet);
      if (arr) arr.push(e);
      else bySheet.set(e.ref.sheet, [e]);
    }
    for (const sheet of [...bySheet.keys()].sort()) {
      for (const e of bySheet.get(sheet)!) {
        if ((e.input === null || e.input === undefined) && e.value.kind === 'null') continue;
        const covered =
          volatileKeys !== undefined && volatileKeys.has(volatileCellKey(e.ref))
            ? serializeAckInput(e.input as CellInput)
            : serializeAckValue(e.value);
        hash.update(`${sheet}\u0001${e.ref.row}\u0001${e.ref.col}\u0002${covered}\u0003`, 'utf8');
      }
    }
    return hash.digest('hex');
  }

  function fullStateChecksum(): string {
    // Bulk + taint set are derived from the same live host in one
    // synchronous pass — no edit can interleave between them.
    return checksumFromBulk(
      state.host.bulkReadback({ principal: ownerPrincipal }),
      volatileValueKeySet(),
    );
  }

  /**
   * Flush the pending journal segment: ONE store write carrying every
   * buffered op since journalBaseRevision (the free-quota segment
   * model). The registry's revision advances HERE (and at checkpoint),
   * never per op — so registry revision == persisted journal head
   * whenever the process is at rest, which is what makes the rehydrate
   * torn-journal check exact.
   */
  async function flushJournalSegment(): Promise<void> {
    if (!state.sessionId || state.journalBuffer.length === 0) return;
    const ops = state.journalBuffer;
    const toRevision = ops[ops.length - 1]!.revision;
    await stores.journal.appendSegment({
      sessionId: state.sessionId,
      fromRevision: state.journalBaseRevision,
      toRevision,
      ops,
      at: Date.now(),
    });
    // Measurement (consolidated brief): journal bytes per flushed
    // segment, so journal overhead per 1000 ops is reportable at P95.
    // WRITE-AHEAD ORDERING: this persist happens BEFORE any batch
    // materialization that covers these ops (checkpointSession flushes
    // first) — storage never holds a batch the journal can't replay.
    console.log(
      `[engine] journal segment flushed session=${state.sessionId} ops=${ops.length} journalBytes=${Buffer.byteLength(JSON.stringify(ops), 'utf8')} toRevision=${toRevision}`,
    );
    state.journalBuffer = [];
    state.journalBaseRevision = toRevision;
    await stores.registry.update(state.sessionId, { revision: toRevision });
  }

  /**
   * Claim serialization (placement fix, 2026-10-23): /session/claim
   * handlers run one at a time per process. The handler awaits store
   * I/O between reading the session binding and writing it, so two
   * concurrent claims for DIFFERENT files could interleave — the
   * second slipped through the not-yet-bound window and clobbered the
   * first session (both opens answered 200 on one instance, only one
   * session actually held). Opens are rare; a promise chain is the
   * whole lock.
   */
  let claimTurn: Promise<void> = Promise.resolve();

  /** Introduce a session for the workbook just built (registry: ext. 1). */
  async function registerSession(sessionId: string, principal: string): Promise<void> {
    const now = Date.now();
    state.sessionId = sessionId;
    // Issue #26: installing a session identity is a fresh start for
    // reads — a PREVIOUS session's failed load must not keep failing
    // this session's reads through the build gate's sticky error (the
    // /reset handler clears it for the same reason). On the /load
    // success path this is a no-op: endLoadBuild settles that gate
    // clean immediately after registration.
    lastBuildError = null;
    state.sessionPrincipal = principal;
    state.sessionStatus = 'active';
    state.lastActivityMs = now;
    // #88D: a freshly registered session holds no workbook until a
    // build follows (load path) — the checkpoint guard relies on this
    // being false here; bindLoadedSession re-sets it after a load.
    state.workbookBuilt = false;
    state.releasedRevision = 0;
    state.checkpointChecksum = null;
    state.opsSinceSnapshot = 0;
    state.lastSnapshotMs = now;
    state.journalBuffer = [];
    state.journalBaseRevision = 0;
    // AutoSave state starts clean: nothing stored for this session yet.
    state.storageRevision = 0;
    // #105: the stored-size report must reset with everything else —
    // without this, a new session on this (single-session) engine
    // process inherits the PREVIOUS session's checkpoint size and its
    // first status event relays a foreign file's size into the new
    // file's catalog record (proven live in the #105 browser proof:
    // an untouched file listed the previous file's 3013 bytes).
    state.lastCheckpointBytes = 0;
    state.pendingCheckpointOps = 0;
    state.pendingCheckpointOpCmds = [];
    state.autosaveCommitted = false;
    state.storageMode = null;
    state.pendingExtras = {};
    state.extrasDirty = false;
    state.extrasHash = '';
    state.sessionCharts = [];
    state.autosaveStats = { flushes: 0, noopSkips: 0, forcedFlushes: 0 };
    state.boundLibraryId = null;
    state.boundLibraryName = null;
    // Phase 2: a fresh session starts with no participants, no delta
    // log, no presence, and no fence. The file binding is NOT cleared
    // here: /session/claim records it in pendingFileId and the /load
    // that fills this session re-binds it (bindLoadedSession).
    state.fileId = null;
    state.participants = new Map();
    state.attachedClients = new Set();
    state.attachedClientOwners = new Map();
    state.participantActivity = new Map();
    state.detachedClientInstances = new Set();
    state.appliedRev = new Map();
    state.deltaLog = [];
    state.seenOps = new Map();
    state.presenceMap = new Map();
    state.retentionFloor = 0;
    state.lastCheckpointRevision = null;
    state.fenced = false;
    state.ownershipEpoch = null;
    state.claimGraceUntilMs = 0;
    if (autosaveTimer) {
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
    }
    // A fresh workbook (load/reset) starts a fresh save journal: the
    // retained source bytes (set by the caller) are its replay base.
    resetSaveJournal(state);
    await stores.registry.register({
      sessionId,
      instanceId,
      principal,
      status: 'active',
      revision: state.revision,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    });
    notifySessionHooks();
  }

  /**
   * Phase 2: after registerSession (via /load, /load/stream, /reset),
   * bind the session's file: the token's fid wins; otherwise the file
   * a preceding /session/claim bound to this session id. Also enrolls
   * the loading principal as a participant with its token role.
   */
  function bindLoadedSession(principal: string, claims: EngineAccessClaims | null): void {
    if (claims?.fid) {
      state.fileId = claims.fid;
    } else if (state.pendingSessionId === state.sessionId && state.pendingFileId) {
      state.fileId = state.pendingFileId;
    }
    state.participants.set(principal, claims?.role ?? state.participants.get(principal) ?? 'editor');
    // #88D: the load path builds BEFORE registering (loadBytesIntoSession
    // calls buildFromData, then registerSession which clears the flag) —
    // binding after a load re-marks this incarnation as built.
    state.workbookBuilt = true;
    notifySessionHooks();
  }

  // -- AutoSave batched checkpoint scheduler (M365 sync model) ----------
  // Persistence is continuous small-batch checkpointing, not discrete
  // big saves: executed ops accumulate as a pending batch; a settle
  // timer (AUTOSAVE_CHECKPOINT_SETTLE_MS, default 1500 ms, re-armed by
  // every op) fires the batch's checkpoint, and reaching the journal
  // segment cap (200 ops) forces one immediately. A checkpoint is the
  // deployment checkpoint below (direct streaming serialize at the
  // pinned revision → verify → commit BOTH the deployment snapshot and
  // the session's user-visible stored copy, the `autosave_<sessionId>`
  // library entry). Ops arriving while a checkpoint runs belong to the
  // NEXT batch — with the synchronous serializer they physically apply
  // after the checkpoint's pinned pass; no interleave, no loss.
  const autosaveSettleMs = autosaveCheckpointSettleMs(deployEnv);
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  let activeCheckpoint: Promise<CheckpointOutcome | null> | null = null;

  interface CheckpointOutcome {
    checksum: string;
    revision: number;
    mode: 'verbatim' | 'adapter-fallback';
    serializeMs: number;
    ops: number;
    changedSheets: string[];
  }

  /** (Re)arm the settle timer; called after every executed mutating op. */
  function armAutosaveCheckpoint(): void {
    if (autosaveSettleMs <= 0) return;
    if (state.sessionStatus !== 'active' || !state.sessionId) return;
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      if (state.sessionStatus !== 'active' || !state.sessionId) return;
      // STRICT NO-OP RULE (Addendum 6): a flush check with storage
      // fully caught up and no dirty extras writes NOTHING — no
      // journal write, no temp file, no materialization, no storage
      // write. It is only counted.
      if (
        state.pendingCheckpointOps <= 0 &&
        state.autosaveCommitted &&
        !state.extrasDirty &&
        state.storageRevision === state.revision
      ) {
        state.autosaveStats.noopSkips += 1;
        broadcastStatus();
        return;
      }
      void checkpointSession('autosave-settle').catch((e) => {
        console.log(
          `[engine] autosave checkpoint failed session=${state.sessionId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    }, autosaveSettleMs);
    autosaveTimer.unref?.();
  }

  /**
   * Checkpoint entry point with in-flight dedupe: a second caller
   * while one checkpoint runs JOINS it (its batch cut is already
   * pinned; ops arriving meanwhile belong to the next batch either
   * way) instead of overlapping a second serialization.
   */
  function checkpointSession(
    reason: string,
    extras: SaveExtras = {},
  ): Promise<CheckpointOutcome | null> {
    if (activeCheckpoint) return activeCheckpoint;
    activeCheckpoint = (async () => {
      try {
        return await checkpointSessionInner(reason, extras);
      } finally {
        activeCheckpoint = null;
        // Ops that arrived during the checkpoint form the next batch:
        // re-arm the settle timer for them.
        if (state.pendingCheckpointOps > 0) armAutosaveCheckpoint();
      }
    })();
    return activeCheckpoint;
  }

  /**
   * Checkpoint (extension 3 + AutoSave model): serialize the live
   * workbook server-side (the direct streaming save), store the
   * snapshot + the full-state checksum at the PINNED revision, commit
   * the session's autosave library entry from the same verified temp
   * file, then truncate the journal to that revision (extension 2:
   * post-snapshot ops only). `storageRevision` advances to the pinned
   * cut — storage holds exactly the edits with revision ≤ the cut.
   */
  async function checkpointSessionInner(
    reason: string,
    extras: SaveExtras,
  ): Promise<CheckpointOutcome | null> {
    if (state.sessionStatus !== 'active' || !state.sessionId) return null;
    const sessionId = state.sessionId;
    const tStart = performance.now();
    // #88D: NEVER persist a session that never built a workbook and
    // never executed an op. Such a session is a claim-minted blank:
    // its "workbook" is the default empty Sheet1, and serializing it
    // into the snapshot + library stores would SHADOW the file's real
    // stored bytes — every later claim would rehydrate blank forever
    // (proven: early-kill + reconnect-claim + page-unload release, the
    // blank then checkpointed by both autosave-settle and page-unload).
    // Skipping is loss-free: there is no content to persist, and the
    // release/teardown proceeds regardless (evictSession and
    // flushSessionSave both tolerate a null outcome). A session that
    // built a workbook (even at rev 0) or executed any op (rev > 0)
    // checkpoints normally — including a deliberately-emptied file and
    // a File > New session after its first edit.
    if (!state.workbookBuilt && state.revision === 0) {
      console.log(
        `[engine] checkpoint skipped: session ${sessionId} never built a workbook (blank pending session)`,
      );
      return null;
    }
    // The batch being checkpointed: ops pending at entry. Ops arriving
    // during the awaits below increment the counters afresh and belong
    // to the NEXT batch (accounting subtracts only this batch, and
    // only on success).
    const batchOps = state.pendingCheckpointOps;
    const batchCmds = state.pendingCheckpointOpCmds;
    state.pendingCheckpointOpCmds = [];
    // The extras generation this checkpoint consumes (Addendum 6): a
    // /session-extras push DURING the checkpoint changes the hash, and
    // its dirty flag must survive this flush (it belongs to the next).
    const consumedExtrasHash = state.extrasHash;
    try {
      // Flush FIRST: the snapshot is taken at the pinned revision, and
      // the truncate below removes whole segments — flushing here
      // guarantees no segment straddles the snapshot revision.
      await flushJournalSegment();
      // Snapshot bytes via the direct streaming save (Excel sequence:
      // recalc settled inside runDirectSave → temp file → verified →
      // only then committed here; a failed save leaves BOTH stores
      // untouched).
      const tDirect = performance.now();
      const direct = await runDirectSave(extras, ownerPrincipal);
      const directMs = Math.round(performance.now() - tDirect);
      const revision = direct.pinnedRev;
      try {
        const bytes = readFileSync(direct.outPath);
        const checksum = direct.stateChecksum;
        console.log(
          `[engine] checkpoint phases directMs=${directMs} serializeMs=${direct.result.serializeMs} changedSheets=${direct.result.changedSheets.length}`,
        );
        await stores.snapshots.put(sessionId, { bytes, checksum, revision, at: Date.now() });
        // The user-visible stored copy: the session's autosave library
        // entry, committed from the same verified temp (atomic rename
        // inside commitLibraryEntry), owned by the session principal.
        if (state.sessionPrincipal) {
          commitLibraryEntry(
            state.sessionPrincipal,
            `autosave_${sessionId}`,
            'workbook.xlsx',
            direct.outPath,
            direct.result.bytes,
          );
          state.autosaveCommitted = true;
          // Bound library entry (the file the user opened / saved to):
          // the SAME verified temp commits there too — a file copy
          // inside commitLibraryEntry, never a second serialization.
          if (state.boundLibraryId) {
            commitLibraryEntry(
              state.sessionPrincipal,
              state.boundLibraryId,
              state.boundLibraryName ?? 'workbook.xlsx',
              direct.outPath,
              direct.result.bytes,
            );
          }
          // Issue #36: FILE-keyed stored copy. A session bound to a
          // catalog file (state.fileId) keeps a stored copy under the
          // FILE's id too — not only under `autosave_<sessionId>`.
          // Before this, a created (never-uploaded) file's bytes were
          // keyed solely by session in the engine's local stores: if
          // the session snapshot was lost (engine instance churn —
          // the production data dir is per-instance tmpfs), the next
          // claim found no snapshot and minted a blank session, and
          // the file opened empty with no recovery source. The
          // file-keyed entry is the claim path's recovery source
          // (see recoverSessionFromLibrary in /session/claim).
          if (state.fileId && state.boundLibraryId !== state.fileId && isLibraryId(state.fileId)) {
            commitLibraryEntry(
              state.sessionPrincipal,
              state.fileId,
              state.boundLibraryName ?? 'workbook.xlsx',
              direct.outPath,
              direct.result.bytes,
            );
          }
        }
        // Retention (§1): the checkpoint just stored a snapshot at
        // `revision`, satisfying condition (c) up to that revision —
        // but segments may be pruned only up to the SLOWEST attached
        // client's applied revision and the stored revision too.
        // With no attached clients the applied bound is vacuous and
        // the journal truncates to the checkpoint revision exactly as
        // before (Phase 1 behavior).
        {
          const upto = retentionPruneUpto({
            storedRevision: revision,
            minAppliedRev: minAppliedAcrossAttached(),
            checkpointRevision: revision,
          });
          if (upto > 0) {
            await stores.journal.truncate(sessionId, upto);
            pruneDeltaLog(upto);
          }
        }
        state.lastCheckpointRevision = revision;
        await stores.registry.update(sessionId, {
          revision,
          snapshotChecksum: checksum,
          snapshotRevision: revision,
          lastActivityAt: state.lastActivityMs,
        });
        state.checkpointChecksum = checksum;
        state.opsSinceSnapshot = 0;
        state.lastSnapshotMs = Date.now();
        state.journalBaseRevision = revision;
        state.storageRevision = revision;
        state.lastCheckpointBytes = bytes.length;
        state.storageMode = direct.result.mode;
        state.pendingCheckpointOps = Math.max(0, state.pendingCheckpointOps - batchOps);
        // Addendum 6 instrumentation + extras consumption: this
        // committed checkpoint is one batch flush; the extras it
        // serialized (pendingExtras merged inside runDirectSave) are
        // now in storage, so the extras channel is clean again.
        state.autosaveStats.flushes += 1;
        if (state.extrasHash === consumedExtrasHash) state.extrasDirty = false;
        const ms = Math.round(performance.now() - tStart);
        // Why-class for a from-scratch save: adapter-fallback should
        // happen at most at first save / after structural ops — say so.
        let fallbackNote = '';
        if (direct.result.mode === 'adapter-fallback') {
          // The serializer's own reason wins (Addendum 5 per-type
          // table): 'sheet-set-changed', 'structural-op:<cmd>', or
          // 'verbatim-failed'. The batch-class guess remains only as
          // a fallback for a serializer that reports none — the log
          // must never be silent about a from-scratch save.
          const structural = batchCmds.some(
            (c) => !CHECKPOINT_CELL_OPS.has(c) && !CHECKPOINT_NAME_OPS.has(c),
          );
          fallbackNote = ` fallbackReason=${direct.result.fallbackReason ?? (structural ? 'structural-op' : 'verbatim-planning')}`;
        }
        console.log(
          `[engine] checkpoint rev=${revision} ops=${batchOps} mode=${direct.result.mode} ms=${ms}${fallbackNote}`,
        );
        console.log(
          `[engine] checkpoint session=${sessionId} reason=${reason} revision=${revision} bytes=${bytes.length} checksum=${checksum}`,
        );
        // §8 status: the flush commit moved storedRevision — every
        // attached client re-renders Saving…/Saved from server truth.
        broadcastStatus();
        return {
          checksum,
          revision,
          mode: direct.result.mode,
          serializeMs: direct.result.serializeMs,
          ops: batchOps,
          changedSheets: direct.result.changedSheets,
        };
      } finally {
        direct.cleanup();
      }
    } catch (e) {
      // The batch stays pending (accounting untouched, cmds restored):
      // a failed checkpoint loses nothing — the next trigger retries it.
      state.pendingCheckpointOpCmds = [...batchCmds, ...state.pendingCheckpointOpCmds];
      throw e;
    }
  }

  /**
   * True when the workbook carries any cell-hiding ranges (face e).
   * The autosave stored copy is serialized from the owner view (it is
   * the file of record, like the checkpoint snapshot); a principal
   * whose view has hidden cells must never receive it as their
   * download — such downloads stay on the per-principal filtered
   * `dl_` path in /download.
   */
  function sessionHasHiddenRanges(): boolean {
    try {
      const meta = state.protection.toMetadata();
      return Object.entries(meta).some(
        ([k, v]) =>
          k.startsWith('icecream.protection.hidden.') &&
          v !== null &&
          typeof v === 'object' &&
          Array.isArray((v as { ranges?: unknown }).ranges) &&
          ((v as { ranges: unknown[] }).ranges.length ?? 0) > 0,
      );
    } catch {
      return false;
    }
  }

  /** Look up one of the session principal's library entries by id. */
  function lookupLibraryEntry(principal: string, id: string): ServerLibraryEntry | null {
    const index = readLibraryIndex(libraryDir());
    const found = index.entries.find((e) => e.principal === principal && e.id === id);
    if (!found) return null;
    const { principal: _p, ...rest } = found;
    return rest as ServerLibraryEntry;
  }

  /**
   * SAVE CLICK = FLUSH CONFIRMATION (AutoSave model): bring the
   * session's stored copy up to the live revision. Returns null when
   * the flush model does not apply (no active session, or the caller
   * is not the session's principal — single-author model; such callers
   * keep the direct per-principal save path). When storage is already
   * caught up AND the autosave entry exists, this performs NO
   * serialization (skipped: true). Otherwise it runs one checkpoint
   * synchronously (the pending batch) and reports whether storage
   * caught up (ops arriving during the checkpoint's awaits belong to
   * the next batch, so caughtUp is read honestly afterwards).
   */
  async function flushSessionSave(
    extras: SaveExtras,
    principal: string,
  ): Promise<{
    entry: ServerLibraryEntry;
    entryId: string;
    revision: number;
    storageRevision: number;
    caughtUp: boolean;
    flushedOps: number;
    skipped: boolean;
    mode: 'verbatim' | 'adapter-fallback' | null;
    serializeMs: number;
    changedSheets: string[];
  } | null> {
    if (state.sessionStatus !== 'active' || !state.sessionId) return null;
    if (state.sessionPrincipal !== principal) return null;
    const entryId = `autosave_${state.sessionId}`;
    // A request carrying save EXTRAS (session defined names, metadata,
    // styles, dims) is not a pure flush: those extras are content of
    // the save and skipping would silently drop them (the E1 defect
    // shape). Such a request always serializes — via a checkpoint
    // carrying the extras. An extras-free flush may skip.
    const extrasEmpty =
      (!extras.extraMetadata ||
        (typeof extras.extraMetadata === 'object' &&
          !Array.isArray(extras.extraMetadata) &&
          Object.keys(extras.extraMetadata as object).length === 0)) &&
      (!Array.isArray(extras.definedNames) || extras.definedNames.length === 0) &&
      (!extras.sheetDims ||
        (typeof extras.sheetDims === 'object' && Object.keys(extras.sheetDims as object).length === 0)) &&
      (!extras.sheetStyles ||
        (typeof extras.sheetStyles === 'object' && Object.keys(extras.sheetStyles as object).length === 0));
    const needsCheckpoint =
      state.pendingCheckpointOps > 0 ||
      state.storageRevision !== state.revision ||
      !state.autosaveCommitted ||
      state.extrasDirty ||
      !extrasEmpty;
    if (!needsCheckpoint) {
      // STRICT NO-OP (Addendum 6): storageRevision == liveRevision and
      // no dirty extras → confirm instantly, write NOTHING.
      state.autosaveStats.noopSkips += 1;
      broadcastStatus();
      const entry = lookupLibraryEntry(principal, entryId);
      if (entry) {
        return {
          entry,
          entryId,
          revision: state.storageRevision,
          storageRevision: state.storageRevision,
          caughtUp: state.storageRevision === state.revision,
          flushedOps: 0,
          skipped: true,
          mode: state.storageMode,
          serializeMs: 0,
          changedSheets: [],
        };
      }
    }
    state.autosaveStats.forcedFlushes += 1;
    const outcome = await checkpointSession('flush', extras);
    if (!outcome) return null;
    const entry = lookupLibraryEntry(principal, entryId);
    if (!entry) return null;
    return {
      entry,
      entryId,
      revision: outcome.revision,
      storageRevision: state.storageRevision,
      caughtUp: state.storageRevision === state.revision,
      flushedOps: outcome.ops,
      skipped: false,
      mode: outcome.mode,
      serializeMs: outcome.serializeMs,
      changedSheets: outcome.changedSheets,
    };
  }

  /** Checkpoint + EVICT: the workbook leaves memory; the record survives. */
  async function evictSession(reason: string): Promise<void> {
    if (state.sessionStatus !== 'active' || !state.sessionId) return;
    const sessionId = state.sessionId;
    try {
      await checkpointSession(reason);
    } catch (e) {
      // A failed checkpoint must not strand a half-torn-down
      // session (the cap's detach path has ALREADY removed the
      // user's instances and closed their streams by the time it
      // invokes this release; a throw here once left the copy
      // active with zero clients, unclaimable and unreleasable).
      // Teardown may proceed ONLY when storage provably holds
      // every sequenced op — storageRevision has reached the live
      // revision (the detach gate's confirmed checkpoint, or an
      // autosave's) — because the journal + snapshot then carry
      // the full state and nothing is lost. Storage behind →
      // refuse: the session stays intact for its callers to see
      // the failure, exactly as before.
      if (state.storageRevision < state.revision) throw e;
      console.log(
        `[engine] evict checkpoint failed but storage is current (rev ${state.revision}); proceeding with ${reason}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // Phase 2: attached clients are told the session is released and
    // the ownership lease is cleared in the file registry (the record
    // + epoch survive so the next open CAS-claims against them).
    closeAllSubscribers('release');
    if (state.fileId) {
      try {
        // The epoch this instance adopted via its ownership
        // heartbeat; a session released BEFORE the first heartbeat
        // tick (the adoption window right after a claim) has none
        // yet — resolving it from the record that positively names
        // THIS session on THIS instance keeps the release from being
        // skipped, which would leave the record looking live until
        // lease expiry and route re-opens into a JOIN onto this
        // released session (the §9A cap's re-open leg hits exactly
        // that window). A record naming another session/instance —
        // a takeover already landed — is never released by us.
        let releaseEpoch = state.ownershipEpoch;
        const registry = getFileRegistry();
        if (releaseEpoch === null && registry) {
          const rec = await registry.lookup(state.fileId).catch(() => null);
          if (rec && rec.sessionId === sessionId && rec.ownerInstance === instanceId) {
            releaseEpoch = rec.ownershipEpoch;
          }
        }
        if (releaseEpoch !== null) {
          await registry?.release(state.fileId, sessionId, releaseEpoch);
        }
      } catch {
        // Registry release is best-effort here: the lease expires on
        // its own; the session checkpoint above is the durable act.
      }
    }
    state.releasedRevision = state.revision;
    state.attachedClients = new Set();
    state.attachedClientOwners = new Map();
    state.participantActivity = new Map();
    state.detachedClientInstances = new Set();
    clearRegistrations();
    wireFresh();
    state.sourceMetadata = {};
    state.sourceDefinedNames = undefined;
    state.sourceSheetDims = new Map();
    state.sourceSheetTables = new Map();
    state.olapModel = null;
    state.sourceSheetFormats = new Map();
    state.sourceSheetStyles = new Map();
    state.sourceBytes = null;
    resetSaveJournal(state);
    state.sessionStatus = 'released';
    // #88D: a released session holds no workbook; a later incarnation
    // re-registers (which also clears this) before any build.
    state.workbookBuilt = false;
    // #109: the fence guarded the session just torn down, and only
    // that session. A released engine holds nothing stale, so
    // keeping it fenced would wedge it permanently: the claim
    // handler 409s 'fenced' before it ever reaches the
    // no-live-session path, so a fleet eviction that frees a
    // fenced engine's service still 503s on the retry claim
    // ("freed but retry found no free instance"). Clearing here
    // makes a released engine claimable again, exactly like an
    // unfenced released engine today; the next claim
    // re-establishes grace and epoch adoption from the registry.
    state.fenced = false;
    await stores.registry.update(sessionId, { releaseReason: reason });
    await stores.registry.release(sessionId);
    console.log(`[engine] session released session=${sessionId} reason=${reason} revision=${state.releasedRevision}`);
    notifySessionHooks();
  }

  /** Raised when a rebuilt workbook's checksum ≠ the checkpoint's. */
  class SessionChecksumError extends Error {}

  /** Raised when the journal is torn: replay head < registry revision. */
  class SessionJournalError extends Error {}

  /**
   * Rehydrate (extensions 2+3): load the snapshot, build, VERIFY the
   * built state's checksum against the snapshot's recorded checksum,
   * then replay journal ops past the snapshot revision. Any failure
   * leaves the session RELEASED with a blank in-memory workbook — the
   * client is never silently unlocked onto unverified state.
   */
  /**
   * Issue #36: claim-time recovery from the library's stored copy.
   * When a session's snapshot is gone (engine instance churn — the
   * production session stores live on per-instance tmpfs) the claim
   * path used to mint a BLANK session and the file opened empty, even
   * though the checkpoint machinery had committed the workbook bytes
   * to the principal's library (the file-keyed entry every checkpoint
   * of a file-bound session maintains, or the session's autosave
   * entry). Recovery: build the workbook from those bytes and
   * finalize state exactly like a rehydrate at revision 0 — storage
   * is caught up by definition (the library holds precisely these
   * bytes), and future checkpoints bind to the file-keyed entry so
   * the copy stays maintained. Returns null when no usable entry
   * exists (caller falls through to a blank pending session).
   */
  async function recoverSessionFromLibrary(
    sessionId: string,
    fileId: string,
    principal: string,
  ): Promise<{ revision: number; entryId: string } | null> {
    const dir = libraryDir();
    for (const entryId of [fileId, `autosave_${sessionId}`]) {
      const entry = lookupLibraryEntry(principal, entryId);
      if (!entry) continue;
      let bytes: Buffer;
      try {
        bytes = readFileSync(libraryFileFor(dir, principal, entryId));
      } catch {
        continue;
      }
      let data: WorkbookData;
      try {
        data = new XlsxAdapter().read(bytes);
      } catch {
        continue; // unreadable entry: try the next source, then blank
      }
      await registerSession(sessionId, principal);
      buildFromData(data, principal);
      const checksum = fullStateChecksum();
      state.revision = 0;
      state.journalBuffer = [];
      state.journalBaseRevision = 0;
      state.deltaLog = [];
      state.retentionFloor = 0;
      state.lastCheckpointRevision = 0;
      state.sourceBytes = bytes;
      resetSaveJournal(state, []);
      state.storageRevision = 0;
      state.pendingCheckpointOps = 0;
      state.pendingCheckpointOpCmds = [];
      state.autosaveCommitted = true;
      state.storageMode = null;
      state.pendingExtras = {};
      state.extrasDirty = false;
      state.extrasHash = '';
      state.checkpointChecksum = checksum;
      state.opsSinceSnapshot = 0;
      state.lastSnapshotMs = Date.now();
      // Keep the file-keyed copy maintained by later checkpoints.
      if (isLibraryId(fileId)) {
        state.boundLibraryId = fileId;
        state.boundLibraryName = entry.name;
      }
      await stores.registry.update(sessionId, {
        status: 'active',
        instanceId,
        revision: 0,
        lastActivityAt: state.lastActivityMs,
      });
      console.log(
        `[engine] session recovered from library entry=${entryId} session=${sessionId} checksum=${checksum}`,
      );
      return { revision: 0, entryId };
    }
    return null;
  }

  async function rehydrateSession(
    sessionId: string,
    principal: string,
  ): Promise<{ revision: number; checksum: string; replayedOps: number }> {
    const snap = await stores.snapshots.get(sessionId);
    if (!snap) throw new Error(`no snapshot stored for session ${sessionId}`);
    let data: WorkbookData;
    try {
      data = new XlsxAdapter().read(snap.bytes);
    } catch (e) {
      throw new Error(`snapshot for session ${sessionId} is unreadable: ${e instanceof Error ? e.message : String(e)}`);
    }
    buildFromData(data, principal);
    const rebuilt = fullStateChecksum();
    if (rebuilt !== snap.checksum) {
      // Hard error: drop the unverified build, stay released.
      clearRegistrations();
      wireFresh();
      state.sessionStatus = 'released';
      throw new SessionChecksumError(
        `rehydrate checksum mismatch for session ${sessionId}: rebuilt ${rebuilt} != checkpoint ${snap.checksum}`,
      );
    }
    // Replay reads SEGMENTS in order and flattens them (readFrom is
    // the segment-derived op stream past the snapshot revision).
    const entries = await stores.journal.readFrom(sessionId, snap.revision);
    let revision = snap.revision;
    // FIX-G: session charts restart empty at the snapshot (charts the
    // snapshot bytes already carry are preserved verbatim by saves);
    // chart.add journal entries past the snapshot re-append below.
    state.sessionCharts = [];
    for (const entry of entries) {
      // FIX-G replay branch (trace §4.1c): `chart.add` is a journaled
      // package-layer op, NOT an EngineCommand — the host would reject
      // it. Re-append the spec to sessionCharts and skip host execute.
      const rawOp = entry.op as { cmd?: unknown; spec?: unknown } | null;
      if (rawOp && rawOp.cmd === 'chart.add') {
        if (isValidChartSpec(rawOp.spec)) {
          state.sessionCharts.push({ ...rawOp.spec, nativePart: true });
        }
        revision = entry.revision;
        continue;
      }
      const op = entry.op as EngineCommand;
      const result = state.host.execute({ ...op, auth: { principal } } as EngineCommand);
      if (!result.ok) {
        clearRegistrations();
        wireFresh();
        state.sessionStatus = 'released';
        throw new Error(
          `journal replay failed at revision ${entry.revision} for session ${sessionId}: ${JSON.stringify(result)}`,
        );
      }
      revision = entry.revision;
    }
    // TORN-JOURNAL FAIL-CLOSED (the durability window's other half):
    // the registry's revision is the last PERSISTED head (advanced
    // only at segment flush / checkpoint). If replay reached FEWER
    // revisions than that, a segment write was lost — the journal is
    // torn and the rebuilt state is NOT the confirmed state. Refuse:
    // stay released, surface a hard error, never silently unlock.
    // (Replay reaching PAST the registry is fine — the journal is the
    // op truth; the registry is an index that lagged a flush.)
    const record = await stores.registry.lookup(sessionId);
    if (record && revision < record.revision) {
      clearRegistrations();
      wireFresh();
      state.sessionStatus = 'released';
      throw new SessionJournalError(
        `journal torn for session ${sessionId}: replay reached revision ${revision}, registry records ${record.revision} — refusing to unlock onto unverified state`,
      );
    }
    state.revision = revision;
    state.journalBuffer = [];
    state.journalBaseRevision = revision;
    // Phase 2: rebuild the delta log from the replayed journal (its
    // entries carry delta + origin when written by the sequencer;
    // pre-Phase-2 entries rebuild with empty cells). Revisions at or
    // below the snapshot are inside the checkpoint, not the journal —
    // they are the retention floor for /revisions catch-up.
    state.deltaLog = entries.map((entry) => ({
      revision: entry.revision,
      origin: entry.origin ?? { clientId: null, clientSeq: null, principal },
      op: entry.op,
      cells: (entry.delta ?? []) as DeltaCell[],
      collab: cmdToCollabOp(entry.op as EngineCommand, 'rehydrate', entry.revision - 1),
    }));
    state.retentionFloor = snap.revision;
    state.lastCheckpointRevision = snap.revision;
    state.participants = new Map([[principal, 'editor' as const]]);
    state.appliedRev = new Map();
    state.presenceMap = new Map();
    state.seenOps = new Map();
    state.fenced = false;
    state.ownershipEpoch = null;
    // Direct-save base after a rehydrate: the checkpoint snapshot
    // bytes (verbatim-copy source) + exactly the journal ops replayed
    // on top of them (the changed-set derivation for later saves).
    state.sourceBytes = snap.bytes;
    // chart.add entries are NOT save ops: the serializer's op planner
    // would read the unknown cmd as an unhandled structural op and
    // force the adapter fallback on every later save. Chart
    // changed-sheet derivation comes from sessionCharts itself.
    resetSaveJournal(
      state,
      entries
        .filter((entry) => (entry.op as { cmd?: unknown } | null)?.cmd !== 'chart.add')
        .map((entry) => ({ op: entry.op as EngineCommand })),
    );
    // AutoSave: the snapshot store holds the workbook at `revision`,
    // so storage is caught up by definition — but no autosave LIBRARY
    // entry exists for this session yet, so the first flush commits
    // one (flushSessionSave's needs-check covers that).
    state.storageRevision = revision;
    state.pendingCheckpointOps = 0;
    state.pendingCheckpointOpCmds = [];
    state.autosaveCommitted = false;
    state.storageMode = null;
    state.pendingExtras = {};
    state.extrasDirty = false;
    state.extrasHash = '';
    state.sessionId = sessionId;
    // Issue #26: same fresh-start rule as registerSession — the
    // rehydrated session must not inherit a dead session's failed
    // build error (the F-3 restore: the corrupt file's parse error
    // failed every read against the restored workbook, forever).
    lastBuildError = null;
    state.sessionPrincipal = principal;
    state.sessionStatus = 'active';
    state.lastActivityMs = Date.now();
    state.checkpointChecksum = snap.checksum;
    state.opsSinceSnapshot = 0;
    state.lastSnapshotMs = Date.now();
    await stores.registry.update(sessionId, {
      status: 'active',
      instanceId,
      revision,
      lastActivityAt: state.lastActivityMs,
    });
    console.log(
      `[engine] session rehydrated session=${sessionId} revision=${revision} replayedOps=${entries.length} checksum=${snap.checksum}`,
    );
    return { revision, checksum: snap.checksum, replayedOps: entries.length };
  }

  // Server backstop (doc §Idle rule 6): a client that vanished without
  // its beacon is still evicted — checkpoint first, exactly like a
  // client-driven release. Gated by SESSION_LIFECYCLE=on (see
  // engineAccess.ts) so the default local topology never sweeps.
  if (sessionLifecycleEnabled(deployEnv)) {
    const sweeper = setInterval(() => {
      if (state.sessionStatus === 'active' && Date.now() - state.lastActivityMs > idleTimeout) {
        void evictSession('idle-sweeper').catch((e) => {
          console.log(`[engine] idle sweep eviction failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      }
    }, sessionSweeperMs(deployEnv));
    sweeper.unref?.();
  }

  /**
   * Build the engine workbook from parsed data and produce the /load
   * response. Shared by /load and /load/stream (the stream runs this
   * AFTER its data chunks — the graph build is never a prerequisite for
   * first paint). HyperFormula graph construction is single-threaded
   * shared state: buildMs is measured and reported separately, never
   * fake-parallelized. Throws on build failure (registrations for the
   * previous file are already cleared, exactly as the old /load did).
   */
  function buildFromData(
    data: WorkbookData,
    principal: string,
  ): { response: EngineLoadResponse; buildMs: number; mirrorMs: number } {
    const auth = { principal };
    // Build the engine workbook EXACTLY like the web app's local open
    // (io.workbookFromData): defined names, external links and imported
    // pivot layouts ride into the workbook so formulas resolve —
    // dropping them was the fidelity gap. Data-model cubes register
    // BEFORE the build (the engine caches evaluated cells, so a cube
    // registered after the first read would leave CUBE* errors stuck);
    // imported pivots register AFTER, mirroring App.tsx's open flow.
    clearRegistrations();
    state.registeredCubes = registerDataModelCubes(data);
    // W16 (P99 build memory): everything derived from the parsed rows is
    // computed BEFORE the engine build, while the rows are still the
    // only big structure alive: the /load response (column counts +
    // format wire) and the mirror-flag cell count. The build then takes
    // the parsed row arrays DIRECTLY (no per-row copy — the workbook
    // constructor only reads them), and the rows are released the
    // moment the build returns, so the parsed grids and the engine
    // graph never coexist a second longer than the build itself.
    // Pre-W16 the peak was parsed rows + a full copy + the graph, and
    // the built service held ~5.1 GB RSS at P99 and died at this VM's
    // RAM ceiling in 3 of 4 attempts (perf-evaluation.md §7 defect 5).
    const response = loadResponse(data);
    let cellCount = 0;
    for (const s of data.sheets) {
      for (const row of s.rows) {
        for (const c of row) if (c !== null && c !== undefined) cellCount++;
      }
    }
    let workbook: EngineWorkbook;
    const tBuild = performance.now();
    try {
      const initial: Record<string, CellInput[][]> = {};
      for (const sheet of data.sheets) {
        initial[sheet.name] = sheet.rows;
      }
      workbook = new EngineWorkbook(initial, {
        definedNames: data.definedNames,
        externalLinks: externalLinksFromMetadata(data.metadata),
        importedPivots: importedPivotsFromMetadata(data.metadata[PIVOT_TABLES_METADATA_KEY]),
      });
    } catch (e) {
      throw new Error(`failed to build workbook: ${e instanceof Error ? e.message : String(e)}`);
    }
    const buildMs = performance.now() - tBuild;
    // Release the parsed grids (the engine graph now holds the data);
    // formats/dims/metadata are separate, small-enough fields that the
    // save-fidelity state below still reads. A GC point here (when the
    // host runs with --expose-gc) returns the parse peak's pages before
    // the mirror tail runs.
    for (const sheet of data.sheets) sheet.rows = [];
    maybeGc();
    // Fresh start: new host + fresh protection wired exactly like boot,
    // then the file's protection flags (design §5: hints round-trip).
    wireFresh(workbook);
    // /download fidelity state (see EngineState): this load's adapter
    // metadata, defined names and per-sheet dims are what a later
    // server-side save re-attaches, exactly as the client save did.
    state.sourceMetadata = data.metadata ?? {};
    state.sourceDefinedNames = data.definedNames;
    state.sourceSheetDims = new Map(
      data.sheets.map((s) => [
        s.name,
        {
          ...(s.colWidths ? { colWidths: s.colWidths } : {}),
          ...(s.rowHeights ? { rowHeights: s.rowHeights } : {}),
          ...(s.hiddenCols ? { hiddenCols: s.hiddenCols } : {}),
          ...(s.hiddenRows ? { hiddenRows: s.hiddenRows } : {}),
        },
      ]),
    );
    // Snapshot-join slicer fix (#69 Piece A): retain the adapter's
    // per-sheet tables exactly like the dims above — the same
    // TableSheetFields cast loadResponse uses, since the engine
    // WorkbookData type does not carry the field.
    state.sourceSheetTables = new Map(
      data.sheets
        .map((s) => [s.name, (s as SheetData & TableSheetFields).tables ?? []] as const)
        .filter(([, tables]) => tables.length > 0),
    );
    // Defect D4: the file's own formats/styles are save fidelity state
    // too — a server-side save re-attaches them for sheets the client's
    // session extras do not cover.
    state.sourceSheetFormats = new Map(
      data.sheets.filter((s) => s.formats).map((s) => [s.name, encodeFormatsRecord(s.formats)]),
    );
    state.sourceSheetStyles = new Map(
      data.sheets.filter((s) => s.styles).map((s) => [s.name, { ...(s.styles as Record<string, import('@icecream-sheets/engine').CellStyle>) }]),
    );
    if (process.env.ENGINE_DIAG_STYLES === '1') {
      console.log(
        `[engine] buildFromData source styles: ${[...state.sourceSheetStyles.entries()].map(([n, m]) => `${n}=${Object.keys(m).length}`).join(',') || '(empty)'} ` +
          `formats: ${[...state.sourceSheetFormats.keys()].join(',') || '(empty)'}`,
      );
    }
    state.registeredPivots = registerImportedPivotsForEngine(
      importedPivotsFromMetadata(data.metadata[PIVOT_TABLES_METADATA_KEY]),
    );
    state.registeredCubes.push(...state.registeredPivots.map((p) => p.cubeName));
    // OLAP data-model build (#114, Piece 2): built ONCE at load,
    // server-side, from the retained tables + imported pivot
    // definitions, reading COMPUTED values through the fresh host
    // (table cells are formulas — the parsed rows were released above
    // and hold raw inputs anyway). Gated: only files carrying
    // connection metadata or imported pivots pay for it; every other
    // file keeps olapModel null and takes the exact same code path as
    // today. Best-effort: a failed build never breaks the open.
    try {
      const imported = importedPivotsFromMetadata(data.metadata[PIVOT_TABLES_METADATA_KEY]);
      const connectionsMeta = data.metadata?.[CONNECTIONS_METADATA_KEY];
      let connections: import('@icecream-sheets/xlsx-adapter').ImportedConnection[] = [];
      if (typeof connectionsMeta === 'string' && connectionsMeta.length > 0) {
        try {
          const parsed: unknown = JSON.parse(connectionsMeta);
          if (Array.isArray(parsed)) connections = parsed as typeof connections;
        } catch {
          connections = [];
        }
      }
      if ((connections.length > 0 || imported.length > 0) && state.sourceSheetTables.size > 0) {
        const tables = [...state.sourceSheetTables.values()].flat();
        const readRange = (
          sheet: string,
          startRow: number,
          startCol: number,
          endRow: number,
          endCol: number,
        ): unknown[][] => {
          const out: unknown[][] = [];
          for (let r = startRow; r <= endRow; r++) {
            const row: unknown[] = [];
            for (let c = startCol; c <= endCol; c++) {
              try {
                const v = state.host.readCell({ sheet, row: r, col: c }, { principal });
                row.push(
                  v.kind === 'number' || v.kind === 'string' || v.kind === 'boolean' ? v.value : null,
                );
              } catch {
                row.push(null);
              }
            }
            out.push(row);
          }
          return out;
        };
        state.olapModel = buildDataModel({
          tables,
          connections,
          pivots: imported,
          readRange,
        });
      } else {
        state.olapModel = null;
      }
    } catch {
      state.olapModel = null;
    }
    try {
      state.protection.fromMetadata(data.metadata);
    } catch {
      // Protection hydration must never break the open.
    }
    // Local mirror (ONE FLAG rule, see above): evaluated once from
    // the workbook's total cell count via deriveMirrorMode() — the
    // same flag that enables server-side multithreaded recalc. Flag
    // OFF → the client gets a COMPLETE engine-build payload (every
    // cell's formula/input, cached value, and data type) and builds
    // a local engine; flag ON → no mirror ships. The mirror is
    // permission-filtered for the requesting principal, like /snapshot.
    // (cellCount + response were computed pre-build, above — W16.)
    const tMirror = performance.now();
    if (deriveMirrorMode(cellCount) === 'mirror') {
      // Bulk readback (Cycle 10 closure): ONE pass over the workbook's
      // cell storage (host.bulkReadback — snapshot input + readCell-exact
      // authorized value per cell) instead of the previous sequence —
      // filteredSnapshot (a full snapshot plus a per-cell readCell) and
      // then a SECOND per-cell readCell for the mirror values — which
      // re-serialized every formula through HyperFormula on each pass
      // and cost ~1.3 s (P50) / ~2.8 s (P75) of the server /load wall in
      // the Phase 4 measurements. The mirror contract is unchanged:
      // every sheet (empty ones included), cells row-major, each cell's
      // formula/input + cached value + data type (in the value's kind),
      // and cells the principal cannot read (#PERM!) are dropped,
      // exactly as the filtered snapshot dropped them.
      const bulk = state.host.bulkReadback(auth);
      const bySheet = new Map<string, MirrorCell[]>();
      for (const name of state.host.sheetNames()) bySheet.set(name, []);
      for (const cell of bulk) {
        if (cell.value.kind === 'error' && cell.value.code === '#PERM!') continue;
        bySheet.get(cell.ref.sheet)?.push({
          row: cell.ref.row,
          col: cell.ref.col,
          input: cell.input,
          value: cell.value,
        });
      }
      response.mirror = {
        sheets: [...bySheet.entries()].map(([name, cells]) => ({ name, cells })),
        ...(data.definedNames ? { definedNames: data.definedNames } : {}),
      };
    }
    const mirrorMs = performance.now() - tMirror;
    // #88D: this incarnation now holds a built workbook (see the
    // checkpoint guard in checkpointSessionInner).
    state.workbookBuilt = true;
    return { response, buildMs: Math.round(buildMs), mirrorMs: Math.round(mirrorMs) };
  }

  // -- sequencer core (§7) -------------------------------------------------
  // One mutating execute, run INSIDE the FIFO chain (enqueueSequenced).
  // This is the Phase 1 /execute body with its response-writing
  // replaced by an outcome value, so POST /ops and legacy /execute
  // share exactly one application path: structural barrier,
  // save-pin overflow queue, save journal, AutoSave batch
  // accounting, revision stamp, durability
  // journal, checksum ack — plus Phase 2 delta capture + broadcast.
  interface ExecOutcome {
    status: number;
    payload: Record<string, unknown>;
    ok: boolean;
    revision: number;
    cells: DeltaCell[];
    origin: DeltaOrigin;
  }

  async function runExecuteInternal(args: {
    /** The command to apply (client's original for /execute; the
     *  REBASED command for /ops). No auth — stamped here. */
    rawCmd: EngineCommand;
    principal: string;
    ackChecksum?: boolean;
    envelope?: { clientId: string; clientSeq: number } | null;
  }): Promise<ExecOutcome> {
    const principal = args.principal;
    const origin: DeltaOrigin = {
      clientId: args.envelope?.clientId ?? null,
      clientSeq: args.envelope?.clientSeq ?? null,
      principal,
    };
    const fail = (status: number, payload: Record<string, unknown>): ExecOutcome => ({
      status,
      payload,
      ok: false,
      revision: state.revision,
      cells: [],
      origin,
    });
    // Stamp the gateway-verified principal; a client-supplied auth
    // context is never trusted.
    const cmd: EngineCommand = { ...args.rawCmd, auth: { principal } } as EngineCommand;
    // STRUCTURAL-OP BARRIER (Addendum 5): a structural op must never
    // share a batch with pending cell edits. Flush the pending batch
    // FIRST, then apply the structural op in a fresh batch.
    if (
      SAVE_MUTATING_OPS.has(cmd.cmd) &&
      !CHECKPOINT_CELL_OPS.has(cmd.cmd) &&
      !CHECKPOINT_NAME_OPS.has(cmd.cmd) &&
      state.pendingCheckpointOps > 0 &&
      state.sessionStatus === 'active' &&
      state.sessionId
    ) {
      let outcome: Awaited<ReturnType<typeof checkpointSession>>;
      try {
        outcome = await checkpointSession('structural-barrier');
      } catch (e) {
        return fail(
          500,
          {
            ok: false,
            error: `structural barrier checkpoint failed; ${cmd.cmd} not applied: ${e instanceof Error ? e.message : String(e)}`,
          },
        );
      }
      if (outcome) {
        console.log(`[engine] structural barrier: flushed rev<=${outcome.revision} before ${cmd.cmd}`);
      }
    }
    // Recalc is SERIAL-ONLY on the gateway (issue #60, owner decision
    // 2026-10-23): the edit's own serial evaluation inside
    // host.execute() is the one and only evaluation pass — the former
    // parallel recalculateParallel follow-up was removed because the
    // serial values were already complete (it recomputed the same
    // chains for identical results). True parallel recalc returns as
    // separate future work once the engine gains a merge-finalize
    // primitive (see WEB-DOUBLECALC-FIX-REPORT.md §5 Option A). The
    // only pre-execute measurement left is the ack-checksum affected
    // set, whose semantics are unchanged.
    let ackAffected: CellRef[] | null = null;
    if ((cmd.cmd === 'setCell' || cmd.cmd === 'setFormula') && args.ackChecksum === true) {
      try {
        const full = state.host.measureCalcChain(cmd.ref);
        ackAffected = [cmd.ref, ...full.cells];
      } catch {
        ackAffected = null;
      }
    }
    // Delta collector (Phase 2): capture the cellsChanged refs the
    // host emits DURING this op's execute. The
    // sequencer serializes mutating executes, so a per-op collector
    // can never capture another op's cells.
    const collected = new Map<string, CellRef>();
    const structuralEvents: string[] = [];
    const unsubscribeCollector = state.host.subscribe((event) => {
      if (event.type === 'cellsChanged') {
        for (const ref of event.refs) collected.set(`${ref.sheet}:${ref.row}:${ref.col}`, ref);
      } else if (event.type === 'sheetAdded' || event.type === 'sheetRemoved') {
        structuralEvents.push(event.type);
      }
    });
    // SAVE-PIN OVERFLOW QUEUE (Addendum 4): identical semantics to the
    // Phase 1 route — wait for the pin to release (bounded, logged),
    // retry ONCE; a timeout is a retryable 503, never a dropped edit.
    let result: ReturnType<EngineHost['execute']>;
    try {
      result = state.host.execute(cmd);
    } catch (e) {
      if (!(e instanceof SavePinOverflowError)) {
        unsubscribeCollector();
        throw e;
      }
      console.log(`[engine] execute queued behind save pin (${cmd.cmd})`);
      const deadline = Date.now() + 30_000;
      let released = false;
      while (Date.now() < deadline) {
        if (activeSavePins === 0) {
          released = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      if (!released) {
        unsubscribeCollector();
        return fail(503, {
          ok: false,
          error: `save in progress: ${cmd.cmd} could not be applied within 30s (save-pin queue timeout) — retry the edit`,
        });
      }
      try {
        result = state.host.execute(cmd);
      } catch (e2) {
        unsubscribeCollector();
        if (e2 instanceof SavePinOverflowError) {
          return fail(503, {
            ok: false,
            error: `save in progress: ${cmd.cmd} still cannot be applied (save-pin overflow) — retry the edit`,
          });
        }
        throw e2;
      }
    }
    if (result.ok && SAVE_MUTATING_OPS.has(cmd.cmd)) {
      // Save journal (direct save): the applied command, in execution
      // order. Past the cap the journal is dropped and marked
      // incomplete (see EngineState.saveOps) — but the bounded
      // structural summary inside recordSaveJournalOp is never
      // dropped, so at-cap saves keep the pre-cap planning class.
      recordSaveJournalOp(state, cmd.cmd, args.rawCmd);
      // AutoSave batch accounting (Phase 1 semantics unchanged).
      state.pendingCheckpointOps++;
      state.pendingCheckpointOpCmds.push(cmd.cmd);
      if (state.pendingCheckpointOps >= AUTOSAVE_BATCH_OPS_CAP) {
        void checkpointSession('segment-cap').catch((e) => {
          console.log(
            `[engine] segment-cap checkpoint failed session=${state.sessionId}: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
      } else {
        armAutosaveCheckpoint();
      }
    }
    unsubscribeCollector();
    if (!result.ok) {
      return { status: 200, payload: result as Record<string, unknown>, ok: false, revision: state.revision, cells: [], origin };
    }
    if (!SAVE_MUTATING_OPS.has(cmd.cmd)) {
      // Non-mutating executes (recalculate, name reads, …) get no
      // revision, no journal entry, no delta — exactly as Phase 1.
      return { status: 200, payload: result as Record<string, unknown>, ok: true, revision: state.revision, cells: [], origin };
    }
    // §7: the revision stamp IS the order — one per accepted mutating
    // op (Phase 1 assigned revisions to cell edits; the design doc §1
    // assigns one to EVERY accepted edit op, structural included).
    state.revision++;
    const newRevision = state.revision;
    // Delta cells: the refs changed during the execute, read back
    // AFTER recalc (owner view — filtering is per recipient).
    const cells: DeltaCell[] = [];
    for (const ref of collected.values()) {
      try {
        const value = state.host.readCell(ref, { principal: ownerPrincipal });
        if (value.kind === 'error' && value.code === '#PERM!') continue;
        const cell: DeltaCell = { sheet: ref.sheet, row: ref.row, col: ref.col, value };
        const formula = state.host.getView().readCell(ref).formula;
        if (formula !== undefined) cell.formula = formula;
        cells.push(cell);
      } catch {
        // The cell's sheet vanished under a structural op in the same
        // execute — there is no post-state to report for it.
      }
    }
    const collab = cmdToCollabOp(args.rawCmd, origin.clientId ?? 'legacy', newRevision - 1);
    state.deltaLog.push({ revision: newRevision, origin, op: args.rawCmd, cells, collab });
    if (state.deltaLog.length > DELTA_LOG_CAP) {
      const evicted = state.deltaLog.splice(0, state.deltaLog.length - DELTA_LOG_CAP);
      const last = evicted[evicted.length - 1];
      if (last && last.revision > state.retentionFloor) state.retentionFloor = last.revision;
    }
    // Durability journal (extension 2, segmented): the op is BUFFERED
    // with its delta + origin and persists as ONE segment write at
    // flush (Phase 1 semantics; the buffer is the durability window).
    if (state.sessionId && state.sessionStatus === 'active') {
      try {
        state.journalBuffer.push({
          revision: newRevision,
          op: args.rawCmd,
          at: Date.now(),
          delta: cells as JournalEntry['delta'],
          origin,
        });
        state.opsSinceSnapshot++;
        if (state.journalBuffer.length >= segmentMaxOps) {
          await flushJournalSegment();
        }
        if (
          (everyOps > 0 && state.opsSinceSnapshot >= everyOps) ||
          (everyMs > 0 && Date.now() - state.lastSnapshotMs >= everyMs)
        ) {
          await checkpointSession('periodic');
        }
      } catch (e) {
        console.log(
          `[engine] JOURNAL FLUSH FAILED session=${state.sessionId} revision=${newRevision}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    // Checksum ack: legacy ackChecksum requests keep the Phase 1
    // affected-set semantics; /ops envelopes get an ack over the
    // delta cells when no affected set was measured.
    let ack: EditAck | null = null;
    if (ackAffected !== null) {
      try {
        const view = state.host.getView();
        const values = new Map<string, TypedValue>();
        for (const ref of ackAffected) {
          values.set(`${ref.sheet}:${ref.row}:${ref.col}`, view.readCell(ref).value);
        }
        ack = {
          revision: newRevision,
          changedCellCount: ackAffected.length,
          checksum: computeAckChecksum(ackAffected, values),
        };
      } catch {
        ack = null; // Ack computation must never fail the edit.
      }
    }
    if (args.envelope && !ack) {
      const refs = cells.map((c) => ({ sheet: c.sheet, row: c.row, col: c.col }));
      const values = new Map<string, TypedValue>();
      for (const c of cells) values.set(`${c.sheet}:${c.row}:${c.col}`, c.value);
      ack = {
        revision: newRevision,
        changedCellCount: cells.length,
        checksum: computeAckChecksum(refs, values),
      };
    }
    // §8 broadcast: updated cells only, to ALL attached clients
    // including the originator (its own delta resolves provisional
    // values), then the status event (Saving…/Saved inputs).
    broadcastDelta(newRevision, origin, cells);
    if (structuralEvents.length > 0) {
      broadcastSession({ kind: 'structure', revision: newRevision, events: structuralEvents });
    }
    broadcastStatus();
    if (args.envelope) {
      return {
        status: 200,
        payload: { ok: true, revision: newRevision, ack },
        ok: true,
        revision: newRevision,
        cells,
        origin,
      };
    }
    if (ack) {
      return {
        status: 200,
        payload: {
          ...result,
          ack,
          liveRevision: newRevision,
          storageRevision: state.storageRevision,
        },
        ok: true,
        revision: newRevision,
        cells,
        origin,
      };
    }
    return { status: 200, payload: result as Record<string, unknown>, ok: true, revision: newRevision, cells, origin };
  }

  /**
   * The /load POST-BYTES TAIL, shared verbatim by POST /load and
   * POST /load/storage-ref (product layer): everything that happens
   * once the workbook bytes are in hand, in the original order —
   *   1. the W20 build gate opens (beginLoadBuild) so reads pend on
   *      the build instead of hitting the previous workbook;
   *   2. parseWorkbookFast (async parse) — failure settles the gate
   *      with the error and answers 400 `failed to parse xlsx: …`;
   *   3. buildFromData (engine build + mirror) — failure likewise;
   *   4. timings merged onto the response (parse timings + buildMs +
   *      mirrorMs + totalMs);
   *   5. session introduction: sessionId = the body's valid sessionId
   *      or a fresh newSessionId(); the source bytes are retained as
   *      state.sourceBytes (direct-save verbatim-copy base);
   *      registerSession → bindLoadedSession →
   *      broadcastSession({ kind: 'load', sessionId });
   *   6. response.sessionId is set, `extraResponseFields` (storage-ref's
   *      `storageRef`) are merged, the timings line is logged, the
   *      gate closes clean, and the /load response JSON is sent (200).
   * Unexpected errors settle the gate with the error and rethrow —
   * exactly /load's outer-catch behavior before the extraction.
   */
  async function loadBytesIntoSession(args: {
    res: ServerResponse;
    bytes: Uint8Array;
    sessionIdRaw: unknown;
    principal: string;
    accessClaims: EngineAccessClaims | null;
    logLabel: string;
    extraResponseFields?: Record<string, unknown>;
    format?: 'xlsx' | 'csv' | 'xls';
    sourceName?: string;
  }): Promise<void> {
    const { res, bytes } = args;
    const format = args.format ?? 'xlsx';
    // W20: the build gate opens BEFORE the (async, event-loop-free)
    // parse, so reads arriving anywhere in the load window pend on
    // it instead of hitting the previous workbook's host.
    const buildGate = beginLoadBuild();
    try {
      const tLoadStart = performance.now();
      let data: WorkbookData;
      let parseTimings: Record<string, number | string | null>;
      try {
        if (format === 'csv') {
          const tParse = performance.now();
          data = new CsvAdapter().read(bytes);
          const sheetName = args.sourceName ? sheetNameFromCsvFileName(args.sourceName) : '';
          if (sheetName && data.sheets.length > 0 && data.sheets[0]) {
            data = {
              ...data,
              sheets: data.sheets.map((s, i) => (i === 0 ? { ...s, name: sheetName } : s)),
            };
          }
          const parseMs = Math.round(performance.now() - tParse);
          parseTimings = { parseMs, sheetParseMs: parseMs, totalMs: parseMs, path: 'csv' };
        } else if (format === 'xls') {
          // Legacy BIFF (sweep finding F-2): the fast parser is
          // ZIP-only, so .xls parses through the SheetJS adapter read —
          // the same parser the local/desktop open uses; values,
          // formulas and stored number formats all ride its
          // WorkbookData.
          const tParse = performance.now();
          data = new XlsxAdapter().read(bytes);
          const parseMs = Math.round(performance.now() - tParse);
          parseTimings = { parseMs, sheetParseMs: parseMs, totalMs: parseMs, path: 'xls' };
        } else {
          const outcome = await parseWorkbookFast(bytes);
          data = outcome.data;
          parseTimings = { ...outcome.timings };
        }
      } catch (e) {
        const msg = `failed to parse ${format}: ${e instanceof Error ? e.message : String(e)}`;
        endLoadBuild(buildGate, new Error(msg));
        return sendError(res, 400, msg);
      }
      let built: ReturnType<typeof buildFromData>;
      try {
        built = buildFromData(data, args.principal);
      } catch (e) {
        endLoadBuild(buildGate, e);
        return sendError(res, 400, e instanceof Error ? e.message : String(e));
      }
      built.response.timings = {
        ...parseTimings,
        buildMs: built.buildMs,
        mirrorMs: built.mirrorMs,
        totalMs: Math.round(performance.now() - tLoadStart),
      };
      // Introduce the deployment session for this workbook (ext. 1).
      const sessionId = isSessionId(args.sessionIdRaw) ? args.sessionIdRaw : newSessionId();
      // Direct save: retain the source bytes as the verbatim-copy base.
      // CSV and XLS sessions carry null: neither byte form is an xlsx
      // package, so the first save must serialize the converted
      // workbook in full (directSave treats null as a blank base).
      state.sourceBytes = format === 'csv' || format === 'xls' ? null : bytes.slice();
      await registerSession(sessionId, args.principal);
      bindLoadedSession(args.principal, args.accessClaims);
      broadcastSession({ kind: 'load', sessionId });
      built.response.sessionId = sessionId;
      if (format === 'csv') built.response.sourceFormat = 'csv';
      if (args.extraResponseFields) Object.assign(built.response, args.extraResponseFields);
      console.log(`[engine] ${args.logLabel} timings ${JSON.stringify(built.response.timings)}`);
      endLoadBuild(buildGate);
      return sendJson(res, 200, built.response);
    } catch (e) {
      endLoadBuild(buildGate, e);
      throw e;
    }
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (handlePreflight(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://engine');
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    // -- storage fetch (save/download separation) -------------------------
    // GET /storage/:entryId?st=<token> serves an ALREADY-COMMITTED
    // library-store file (a /library-save entry or a /download `dl_`
    // entry) directly to the browser — bytes flow client←engine, the
    // gateway never proxies them. This route performs NO serialization
    // and NO snapshot: it validates the gateway-issued storage token
    // FIRST (HMAC over { entryId, principal, exp } with the engine
    // signing secret, ENGINE_ACCESS_SECRET — the deploy/engineAccess.ts
    // scheme) and re-checks the library index entry's owner against
    // the token's principal, so a token is bound to one entry of one
    // tenant. Missing/invalid/expired/mismatched token → 401, fail
    // closed (no secret configured → nothing validates). It is served
    // before the signed-session gate and the session-release gate on
    // purpose: the storage token IS this route's authorization, and a
    // committed file must stay fetchable across an idle-release.
    if (path.startsWith('/storage/') && method === 'GET') {
      const entryId = decodeURIComponent(path.slice('/storage/'.length));
      const st = url.searchParams.get('st');
      if (!isLibraryId(entryId) || !st || !accessSecret) {
        return sendError(res, 401, 'storage access denied');
      }
      let claims: ReturnType<typeof verifyStorageToken>;
      try {
        claims = verifyStorageToken(st, accessSecret, { entryId });
      } catch (e) {
        return sendError(
          res,
          401,
          `storage access denied: ${e instanceof EngineAccessError ? e.reason : 'invalid token'}`,
        );
      }
      const dir = libraryDir();
      const index = readLibraryIndex(dir);
      const stored = index.entries.find((e) => e.id === entryId);
      if (!stored || stored.principal !== claims.principal) {
        return sendError(res, 401, 'storage access denied: wrong-principal');
      }
      const file = libraryFileFor(dir, stored.principal, entryId);
      let size: number;
      try {
        size = statSync(file).size;
      } catch {
        return sendError(res, 404, `storage bytes missing for entry: ${entryId}`);
      }
      const safeName = stored.name.replace(/["\r\n]/g, '') || 'workbook.xlsx';
      applyCors(res);
      res.writeHead(200, {
        'content-type': SERVER_SAVE_FORMATS.xlsx.mime,
        'content-disposition': `attachment; filename="${safeName}"`,
        'content-length': String(size),
        'cache-control': 'no-store',
      });
      const rs = createReadStream(file, { highWaterMark: 256 * 1024 });
      rs.on('error', () => {
        try {
          res.end();
        } catch {
          // Response already gone.
        }
      });
      rs.pipe(res);
      return;
    }

    // -- signed-mode gate (ENGINE_ACCESS_MODE=signed) ----------------------
    // The engine validates the gateway-issued token ITSELF and refuses
    // everything else (deployment doc §Engine access pattern 3). The
    // verified principal replaces x-principal: a direct caller can
    // spoof a header, it cannot forge the HMAC. Per-route session scope
    // is checked below + at /load (the token must name the session it
    // touches). In proxy mode this whole block is inert.
    let accessClaims: EngineAccessClaims | null = null;
    let principal = principalOf(req);
    if (accessMode === 'signed' && path !== '/health') {
      if (!accessSecret) {
        return sendError(
          res,
          500,
          'engine access: ENGINE_ACCESS_MODE=signed but ENGINE_ACCESS_SECRET is not set (fail closed)',
        );
      }
      const token = bearerToken(req) ?? url.searchParams.get('access_token');
      if (!token) return sendError(res, 401, 'engine access token required');
      try {
        accessClaims = verifyEngineAccessToken(token, accessSecret);
      } catch (e) {
        return sendError(
          res,
          401,
          `engine access denied: ${e instanceof EngineAccessError ? e.reason : 'invalid token'}`,
        );
      }
      principal = accessClaims.sub;
      // Per-session rate cap after connect (doc §Engine access pattern 5).
      if (sessionRateLimiter) {
        const rl = sessionRateLimiter.take(accessClaims.sid);
        if (!rl.allowed) {
          applyCors(res);
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil(rl.retryAfterMs / 1000))));
          return sendError(res, 429, 'engine session rate limit exceeded');
        }
      }
      // Session scope: the token names exactly one session. Routes that
      // INTRODUCE a session (/load checks its body scope itself; /reset
      // adopts the token's session) and /session/rehydrate (its body
      // names the released session) are exempt from the live check.
      const introducesSession =
        path === '/load' ||
        path === '/load/stream' ||
        path === '/load/storage-ref' ||
        path === '/reset' ||
        path === '/session/rehydrate' ||
        path === '/session/claim';
      if (!introducesSession && state.sessionId !== null && accessClaims.sid !== state.sessionId) {
        return sendError(res, 401, 'engine access denied: wrong-session');
      }
      if (!introducesSession && state.sessionId === null && path !== '/session/status') {
        return sendError(res, 401, 'engine access denied: wrong-session');
      }
    }
    const auth = { principal };

    // -- Phase 2 gates (§9): file scope + fencing + participants -------
    // Legacy tokens (fid='') verify ONLY for the pre-Phase-2
    // session-scoped routes; on a file-owned session they are refused
    // for /ops and /deltas (CONTRACT.md). A token naming a DIFFERENT
    // file than the one this session owns is refused outright.
    const fileScopedRoute =
      path === '/ops' ||
      path === '/deltas' ||
      path === '/deltas/ack' ||
      path === '/revisions' ||
      path === '/presence' ||
      path === '/presence/leave';
    if (accessClaims && state.fileId && fileScopedRoute) {
      if (!accessClaims.fid) {
        return sendJson(res, 403, {
          ok: false,
          error: 'legacy session token (no file scope) is not valid for this route',
        });
      }
      if (accessClaims.fid !== state.fileId) {
        return sendError(res, 401, 'engine access denied: wrong-file');
      }
    }
    // #104 general file-scope rule: a token that names a file may only
    // touch the session owning that file. Legacy tokens (no fid) are
    // NOT refused here — the web read/load path runs on gateway
    // /access grants, which carry no fid; only a positively mismatched
    // fid is refused. Exempt: /session/claim (checks the body fileId
    // itself, plus its own legacy refusal below); /session/status
    // (the gateway's cap fan-out probes OTHER sessions with the
    // opener's file scope — sid-bound introspection, token-signed);
    // /library* (principal-scoped) and /storage* (entry-scoped), which
    // are not session data. Introducing routes whose file is not yet
    // in state.fileId check their own scope in-handler (/load family:
    // pendingFileId; /session/rehydrate: the registry record).
    const fileScopeExempt =
      path === '/session/claim' ||
      path === '/session/status' ||
      path === '/library' ||
      path.startsWith('/library/') ||
      path.startsWith('/storage/');
    if (
      accessClaims &&
      accessClaims.fid &&
      state.fileId &&
      !fileScopeExempt &&
      accessClaims.fid !== state.fileId
    ) {
      return sendError(res, 401, 'engine access denied: wrong-file');
    }
    // Fleet-eviction tokens (interim fleet-5 rule, spec §2.3) are
    // single-purpose: they authorize exactly one act — the
    // /session/release eviction below — and are refused on every
    // other route, so a fleet token can never be replayed as a
    // general editor token for the session.
    if (accessClaims?.fleetEvict === true && path !== '/session/release') {
      return sendJson(res, 403, {
        ok: false,
        error: 'fleet token valid only for /session/release',
      });
    }
    // Fencing: a fenced owner refuses ops, delta subscriptions and
    // loads — even though it still holds the model in memory.
    if (
      state.fenced &&
      (path === '/ops' ||
        path === '/execute' ||
        path === '/deltas' ||
        path === '/load' ||
        path === '/load/stream' ||
        path === '/load/storage-ref')
    ) {
      return sendJson(res, 409, { ok: false, error: 'fenced' });
    }
    // Participant registration: any principal holding a valid token
    // for (sid, fid) joins the session's participant set with its
    // token role (the single-principal model is gone). Proxy-mode
    // callers (gateway-authenticated x-principal) default to editor.
    // ONE exemption (§9A open cap): GET /session/status is pure
    // introspection — the gateway fans it out to every live session
    // on each open to derive the opener's open set, and registering
    // the probe's principal as a participant of sessions they never
    // opened would corrupt the participant record. Every actual
    // attach path (claim / attach / subscribe / ops / heartbeat)
    // still registers.
    if (
      state.sessionStatus === 'active' &&
      state.sessionId &&
      !(path === '/session/status' && method === 'GET')
    ) {
      if (accessClaims && accessClaims.sid === state.sessionId) {
        state.participants.set(principal, accessClaims.role);
      } else if (!accessClaims) {
        if (!state.participants.has(principal)) state.participants.set(principal, 'editor');
      }
    }

    try {
      if (path === '/health' && method === 'GET') {
        // Exact Phase 1 shape (pinned by engineSvc.test.ts); the
        // instanceId is reported on /session/status + /session/claim.
        return sendJson(res, 200, { ok: true, service: 'engine' });
      }

      // -- session lifecycle (extensions 1–3; see header) ------------------
      if (path === '/session/status' && method === 'GET') {
        if (accessClaims && state.sessionId !== null && accessClaims.sid !== state.sessionId) {
          return sendError(res, 401, 'engine access denied: wrong-session');
        }
        const record = state.sessionId ? await stores.registry.lookup(state.sessionId) : null;
        return sendJson(res, 200, {
          ok: true,
          sessionId: state.sessionId,
          fileId: state.fileId,
          fenced: state.fenced,
          ownershipEpoch: state.ownershipEpoch,
          participants: [...state.participants.entries()].map(([p, role]) => ({ principal: p, role })),
          attachedClientInstances: [...state.attachedClients],
          attachedClientCount: state.attachedClients.size,
          // Per-user open cap (§9A): the attachment truth the gateway
          // derives the opener's live open set from — principal →
          // their instances here + their last activity here.
          attachedClientsByPrincipal: attachedClientsByPrincipal(),
          status: state.sessionStatus,
          revision: state.sessionStatus === 'released' ? state.releasedRevision : state.revision,
          storageRevision: state.storageRevision,
          pendingCheckpointOps: state.pendingCheckpointOps,
          extrasDirty: state.extrasDirty,
          autosaveStats: state.autosaveStats,
          lastActivityAt: state.lastActivityMs,
          idleTimeoutMs: idleTimeout,
          instanceId,
          snapshotChecksum: state.checkpointChecksum ?? record?.snapshotChecksum ?? null,
        });
      }
      if (path === '/session/attach' && method === 'POST') {
        // Client-instance attach (addendum 2): a joiner whose open was
        // a registry JOIN never passed through this engine's claim, so
        // the gateway (or the client itself) attaches its instance id
        // here. Idempotent. The refcount this feeds is what
        // /session/release consults before evicting.
        const body = (await readBody(req)) as { sessionId?: unknown; clientInstanceId?: unknown } | undefined;
        if (!isSessionId(body?.sessionId)) return sendError(res, 400, '{ sessionId } required');
        if (body.sessionId !== state.sessionId) return sendError(res, 404, `unknown session: ${body.sessionId}`);
        if (typeof body?.clientInstanceId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.clientInstanceId)) {
          return sendError(res, 400, '{ clientInstanceId } required');
        }
        if (state.sessionStatus === 'released') {
          return sendError(res, 409, 'session is released (idle) — rehydrate to resume');
        }
        // Records the refcount entry AND its owner (the principal
        // whose token the gateway presented — the instance's user),
        // stamps the user's activity, and clears any cap-eviction
        // tombstone: this route is gateway-only, i.e. a sanctioned
        // (re)join on a fresh open.
        noteInstanceAttach(body.clientInstanceId, principal);
        state.lastActivityMs = Date.now();
        // #109 follow-up: a join must move the file to most-recent in
        // the REGISTRY too, not just in engine memory — otherwise any
        // registry-ranked view (and every diagnostic reading it) still
        // sorts the just-reopened file as stale. Same touch the
        // heartbeat does; best-effort but never silent on failure.
        try {
          await stores.registry.update(body.sessionId, { lastActivityAt: state.lastActivityMs });
        } catch (e) {
          console.log(
            `[engine] attach registry touch failed session=${body.sessionId}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        console.log(
          `[engine] attach session=${body.sessionId} instance=${body.clientInstanceId} lastActivityAt=${state.lastActivityMs}`,
        );
        return sendJson(res, 200, {
          ok: true,
          sessionId: body.sessionId,
          attachedClientCount: state.attachedClients.size,
        });
      }
      if (path === '/session/heartbeat' && method === 'POST') {
        const body = (await readBody(req)) as { sessionId?: unknown; clientInstanceId?: unknown } | undefined;
        if (!isSessionId(body?.sessionId)) return sendError(res, 400, '{ sessionId } required');
        if (body.sessionId !== state.sessionId) return sendError(res, 404, `unknown session: ${body.sessionId}`);
        if (state.sessionStatus === 'released') {
          return sendError(res, 409, 'session is released (idle) — rehydrate to resume');
        }
        // A heartbeat from an instance id (re-)attaches it: this is
        // the self-healing path if an attach call was lost. CAP
        // TOMBSTONE (§9A): an instance detached by a cap eviction is
        // refused — its view is closed, and a heartbeat that was in
        // flight during the eviction must not resurrect the refcount
        // entry. Only a gateway /session/attach (a fresh sanctioned
        // open) clears the tombstone.
        const heartbeatInstance =
          typeof body?.clientInstanceId === 'string' &&
          /^[A-Za-z0-9._:-]{1,128}$/.test(body.clientInstanceId)
            ? body.clientInstanceId
            : null;
        if (heartbeatInstance && state.detachedClientInstances.has(heartbeatInstance)) {
          return sendError(res, 409, 'detached');
        }
        if (heartbeatInstance) noteInstanceAttach(heartbeatInstance, principal);
        else notePrincipalActivity(principal);
        state.lastActivityMs = Date.now();
        await stores.registry.update(body.sessionId, { lastActivityAt: state.lastActivityMs });
        return sendJson(res, 200, {
          ok: true,
          sessionId: body.sessionId,
          lastActivityAt: state.lastActivityMs,
          idleTimeoutMs: idleTimeout,
          attachedClientCount: state.attachedClients.size,
          // Addendum 6: the heartbeat the client already polls also
          // carries live-vs-stored revisions for the Saved indicator.
          liveRevision: state.revision,
          storageRevision: state.storageRevision,
          extrasDirty: state.extrasDirty,
        });
      }
      if (path === '/session-save-status' && method === 'GET') {
        // #104: status is session data — a revoked principal gets
        // nothing, same rule as /read.
        if ((await currentRoleFor(principal, accessClaims)) === null) {
          return sendJson(res, 403, { ok: false, rejected: true, reason: 'no-access-grant' });
        }
        // Addendum 6 status surface: live-vs-stored revisions, the
        // extras-dirty flag, and the autosave counters (flushes /
        // noopSkips / forcedFlushes) — the client's ONLY autosave
        // inputs. There is deliberately no client-callable flush here
        // other than force save (/library-save).
        return sendJson(res, 200, {
          ok: true,
          sessionId: state.sessionId,
          liveRevision: state.revision,
          storageRevision: state.storageRevision,
          storedBytes: state.lastCheckpointBytes,
          extrasDirty: state.extrasDirty,
          pendingCheckpointOps: state.pendingCheckpointOps,
          autosaveStats: state.autosaveStats,
        });
      }
      if (path === '/session-bind-library' && method === 'POST') {
        // Bind this session to the user's library entry it was opened
        // from (coordinator integration): committed checkpoints then
        // also land in that entry, so the AutoSave stored copy IS the
        // user's file. The entry must exist in the caller's library.
        if (state.sessionStatus !== 'active' || !state.sessionId) {
          return sendError(res, 409, 'no active session to bind');
        }
        // Role gate exactly as /ops: the token's role wins; proxy-mode
        // callers fall back to the participant record. Binding redirects
        // where committed checkpoints land — an editor action. (F-9)
        const role = await currentRoleFor(principal, accessClaims);
        if (role !== 'editor') {
          return sendJson(res, 403, {
            ok: false,
            rejected: true,
            reason: role === 'viewer' ? 'viewer-role' : 'no-access-grant',
          });
        }
        const body = (await readBody(req)) as { id?: unknown; name?: unknown } | undefined;
        if (!body || !isLibraryId(body.id)) {
          return sendError(res, 400, 'id must match [A-Za-z0-9._-]{1,128}');
        }
        const index = readLibraryIndex(libraryDir());
        const rec = index.entries.find((e) => e.principal === principal && e.id === body.id);
        if (!rec) return sendError(res, 404, `no library entry: ${body.id as string}`);
        state.boundLibraryId = body.id as string;
        state.boundLibraryName =
          typeof body.name === 'string' && body.name.trim().length > 0 ? body.name.trim() : rec.name;
        return sendJson(res, 200, { ok: true, boundLibraryId: state.boundLibraryId });
      }
      if (path === '/session-extras' && method === 'POST') {
        // Addendum 6 extras continuous sync: the client pushes its
        // presentation-state extras (same shapes as save extras);
        // they become flushable content for the SERVER scheduler —
        // no client save call is involved. Replace-per-key; a resend
        // of identical extras must NOT dirty (hash compare).
        if (state.sessionStatus !== 'active' || !state.sessionId) {
          return sendError(res, 409, 'no active session for extras sync');
        }
        // Role gate exactly as /ops: the token's role wins; proxy-mode
        // callers fall back to the participant record. Extras become
        // flushable stored content — a viewer must not write them. (F-9)
        const role = await currentRoleFor(principal, accessClaims);
        if (role !== 'editor') {
          return sendJson(res, 403, {
            ok: false,
            rejected: true,
            reason: role === 'viewer' ? 'viewer-role' : 'no-access-grant',
          });
        }
        // The extras shapes are the save-extras shapes (see the header
        // comment): they carry presentation metadata wholesale, including
        // imported picture data URLs — a media-bearing workbook's extras
        // legitimately exceed readBody's 1 MiB default (File-2: 23
        // imported pictures ≈ 1.3 MiB of base64, rejected 3×). Use the
        // same cap the save/download extras routes already use.
        const body = (await readBody(req, DOWNLOAD_MAX_BODY_BYTES)) as
          | { sheetStyles?: unknown; sheetDims?: unknown; definedNames?: unknown; extraMetadata?: unknown }
          | undefined;
        const next = { ...state.pendingExtras };
        if (body && 'sheetStyles' in body) next.sheetStyles = body.sheetStyles;
        if (body && 'sheetDims' in body) next.sheetDims = body.sheetDims;
        if (body && 'definedNames' in body) next.definedNames = body.definedNames;
        if (body && 'extraMetadata' in body) next.extraMetadata = body.extraMetadata;
        // Canonical serialization with a fixed key order so the
        // compare is shape-stable.
        const canonical = JSON.stringify({
          sheetStyles: next.sheetStyles ?? null,
          sheetDims: next.sheetDims ?? null,
          definedNames: next.definedNames ?? null,
          extraMetadata: next.extraMetadata ?? null,
        });
        const hash = createHash('sha256').update(canonical).digest('hex');
        state.pendingExtras = next;
        if (hash !== state.extrasHash) {
          state.extrasHash = hash;
          state.extrasDirty = true;
          // Extras are flushable content: arm the same settle timer
          // the op path uses — the server flushes on its own.
          armAutosaveCheckpoint();
        }
        return sendJson(res, 200, { ok: true, extrasDirty: state.extrasDirty });
      }
      if (path === '/session/olap-query' && method === 'POST') {
        // Live OLAP pivot query (#114, Piece 1+2): the client passes
        // the bound pivot (name + sheetId, sheet-qualified so
        // same-named pivots on different sheets never collide) and
        // the slicer selection; the server answers from the model
        // built at load. Auth is the standard preamble above (signed
        // token, sid match, file scope); a released session, a file
        // without a model, or an unresolvable pivot all refuse
        // honestly — the client keeps the cached values, never wrong
        // ones.
        const body = (await readBody(req)) as {
          sessionId?: unknown;
          pivotName?: unknown;
          sheetId?: unknown;
          selected?: unknown;
        } | undefined;
        if (!isSessionId(body?.sessionId)) return sendError(res, 400, '{ sessionId } required');
        if (body.sessionId !== state.sessionId) return sendError(res, 404, `unknown session: ${body.sessionId}`);
        if (state.sessionStatus === 'released') {
          return sendError(res, 409, 'session is released (idle) — rehydrate to resume');
        }
        if (!state.olapModel) {
          return sendJson(res, 404, { ok: false, error: 'no data model for this file' });
        }
        const pivotName = typeof body.pivotName === 'string' ? body.pivotName : '';
        const sheetId = typeof body.sheetId === 'number' ? body.sheetId : undefined;
        const pivot =
          state.olapModel.pivots.find((p) => p.name === pivotName && sheetId !== undefined && p.sheetId === sheetId) ??
          state.olapModel.pivots.find((p) => p.name === pivotName);
        if (!pivot) {
          return sendJson(res, 404, { ok: false, error: 'pivot not in data model' });
        }
        const selected = Array.isArray(body.selected)
          ? body.selected.filter((s): s is string => typeof s === 'string')
          : [];
        let matrix: OlapPivotMatrix;
        try {
          matrix = queryOlapPivot(state.olapModel.model, pivot, selected.length > 0 ? selected : null);
        } catch {
          return sendJson(res, 502, { ok: false, error: 'pivot query failed' });
        }
        return sendJson(res, 200, {
          ok: true,
          pivotName: pivot.name,
          sheetName: pivot.sheetName,
          anchor: pivot.anchor,
          valueLabels: pivot.valueLabels,
          rowKeys: matrix.rowKeys,
          data: matrix.data,
        });
      }
      if (path === '/session/release' && method === 'POST') {
        const body = (await readBody(req)) as
          | { sessionId?: unknown; reason?: unknown; clientInstanceId?: unknown; force?: unknown }
          | undefined;
        // Role gate (F-8, folded into F-9): a release that EVICTS the
        // shared session is an editor action — a viewer must not evict
        // it out from under its co-clients. Refcount exception
        // (addendum 2): a release carrying a clientInstanceId that is
        // currently attached, without force, is a DETACH-ONLY request
        // — it can remove just that one instance and physically
        // cannot evict while any other instance remains attached, so
        // any role may make it (a viewer leaving must be able to
        // detach itself, or its instance would pin the copy forever).
        const detachOnly =
          typeof body?.clientInstanceId === 'string' &&
          state.attachedClients.has(body.clientInstanceId) &&
          body.force !== true;
        // Fleet eviction (interim fleet-5 rule, spec §2.3): the
        // gateway, as fleet manager, evicts the globally LRU file
        // when the pool is full. The authority rides INSIDE the
        // signed token (fleetEvict claim) — unforgeable without the
        // engine-access secret, and scoped by the token's own sid+fid
        // to exactly this session — so a stranger's plain editor
        // token still 403s below via the ACL gate. The token's
        // principal (the triggering opener) is kept for audit: the
        // release reason 'fleet-eviction' names the act, the
        // principal names who triggered it. The single-purpose guard
        // in the preamble already confined this token to this route.
        const fleetEvict = accessClaims?.fleetEvict === true;
        if (!detachOnly && !fleetEvict) {
          const role = await currentRoleFor(principal, accessClaims);
          if (role !== 'editor') {
            return sendJson(res, 403, {
              ok: false,
              rejected: true,
              reason: role === 'viewer' ? 'viewer-role' : 'no-access-grant',
            });
          }
        }
        if (!isSessionId(body?.sessionId)) return sendError(res, 400, '{ sessionId } required');
        if (body.sessionId !== state.sessionId) return sendError(res, 404, `unknown session: ${body.sessionId}`);
        if (state.sessionStatus === 'released') {
          return sendJson(res, 200, {
            ok: true,
            sessionId: body.sessionId,
            alreadyReleased: true,
            revision: state.releasedRevision,
            checksum: state.checkpointChecksum,
          });
        }
        if (state.sessionStatus !== 'active') return sendError(res, 409, 'no active session to release');
        const reason = typeof body.reason === 'string' && body.reason.length > 0 ? body.reason : 'client';
        // CLIENT-INSTANCE REFCOUNT (addendum 2, owner 2026-10-23): a
        // release carrying a clientInstanceId detaches ONLY that
        // instance; the copy is evicted when the count reaches zero —
        // one client leaving never tears the session down under the
        // clients still in it. A release with NO instance id keeps the
        // legacy behavior (immediate evict) for callers that predate
        // instance ids (internal lanes, older clients); `force: true`
        // (gateway claim compensation) evicts outright even when the
        // claim attached an instance. The idle sweeper remains the
        // fallback for instances that vanish without detaching.
        const instanceId =
          typeof body.clientInstanceId === 'string' &&
          /^[A-Za-z0-9._:-]{1,128}$/.test(body.clientInstanceId)
            ? body.clientInstanceId
            : null;
        if (instanceId && body.force !== true) {
          state.attachedClients.delete(instanceId);
          state.attachedClientOwners.delete(instanceId);
          if (state.attachedClients.size > 0) {
            return sendJson(res, 200, {
              ok: true,
              sessionId: body.sessionId,
              detached: true,
              released: false,
              attachedClientCount: state.attachedClients.size,
              revision: state.revision,
              checksum: state.checkpointChecksum,
            });
          }
        }
        await evictSession(reason);
        return sendJson(res, 200, {
          ok: true,
          sessionId: body.sessionId,
          released: true,
          attachedClientCount: 0,
          revision: state.releasedRevision,
          checksum: state.checkpointChecksum,
        });
      }
      if (path === '/session/detach-user' && method === 'POST') {
        // PER-USER OPEN CAP eviction (§9A, owner ruling 2026-10-23):
        // detach EVERY client instance of ONE user from this session
        // — never the session itself, never another user. This is
        // mechanism B of §9A; the release-at-zero rule (mechanism A)
        // is only INVOKED, via evictSession below, when this detach
        // happens to empty the refcount.
        //
        // Authorization: the body's principal must be the caller's
        // own authenticated identity (token sub / x-principal) — a
        // caller can only detach-user as itself. In practice the only
        // caller is the gateway, minting the token for the evicted
        // user during that user's own cap-crossing open (the same
        // minting pattern as /session/attach). No role gate: leaving
        // is always safe.
        const body = (await readBody(req)) as
          | { sessionId?: unknown; principal?: unknown }
          | undefined;
        if (!isSessionId(body?.sessionId)) return sendError(res, 400, '{ sessionId } required');
        if (body.sessionId !== state.sessionId) return sendError(res, 404, `unknown session: ${body.sessionId}`);
        if (typeof body?.principal !== 'string' || body.principal.length === 0) {
          return sendError(res, 400, '{ principal } required');
        }
        const target = body.principal;
        if (target !== principal) {
          return sendJson(res, 403, {
            ok: false,
            rejected: true,
            reason: 'detach-user principal must be the caller',
          });
        }
        if (state.sessionStatus === 'released') {
          // The copy is already gone; the user holds nothing here.
          return sendJson(res, 200, {
            ok: true,
            sessionId: body.sessionId,
            principal: target,
            detachedInstances: 0,
            closedSubscribers: 0,
            released: true,
            alreadyReleased: true,
            revision: state.releasedRevision,
            checksum: state.checkpointChecksum,
          });
        }
        if (state.sessionStatus !== 'active') return sendError(res, 409, 'no active session to detach from');
        // CHECKPOINT GATE (§9A, hard): the session's checkpoint must
        // be CONFIRMED CURRENT before any detach completes — storage
        // must hold every op sequenced up to the revision observed
        // now (later ops are journal-durable at execution and belong
        // to the next batch either way). Unconfirmed → 500 and
        // NOTHING is detached, no event is sent: an evicted user
        // never loses work.
        const revAtStart = state.revision;
        let checkpointOutcome: CheckpointOutcome | null = null;
        try {
          checkpointOutcome = await checkpointSession('cap-eviction');
        } catch {
          checkpointOutcome = null;
        }
        if (!checkpointOutcome || state.storageRevision < revAtStart) {
          return sendJson(res, 500, {
            ok: false,
            error: 'checkpoint not confirmed — eviction skipped, nothing detached',
          });
        }
        // SILENT close signal (§9A: no prompt, no notice, no text):
        // the target's own SSE subscribers get a bare session event
        // and their streams end; the client closes that file's view
        // quietly and must not auto-reconnect (its transport treats
        // 'detached' as intentional). Co-users' subscribers are not
        // touched — nothing about this is visible to them beyond the
        // ordinary presence update below (a participant leaving).
        let closedSubscribers = 0;
        for (const sub of [...state.sseSubscribers]) {
          if (sub.principal !== target) continue;
          sseSend(sub, 'session', { kind: 'detached', fileId: state.fileId, sessionId: body.sessionId });
          try {
            sub.res.end();
          } catch {
            // Already gone.
          }
          removeSubscriber(sub);
          closedSubscribers += 1;
        }
        // Detach ALL of the target's instances (refcount decreases
        // by exactly their count) and tombstone each one, so a
        // heartbeat already in flight cannot re-attach it.
        let detachedInstances = 0;
        for (const instanceId of [...state.attachedClients]) {
          if (state.attachedClientOwners.get(instanceId) !== target) continue;
          state.attachedClients.delete(instanceId);
          state.attachedClientOwners.delete(instanceId);
          state.detachedClientInstances.add(instanceId);
          detachedInstances += 1;
        }
        state.participantActivity.delete(target);
        state.participants.delete(target);
        if (state.presenceMap.delete(target)) broadcastPresence();
        state.lastActivityMs = Date.now();
        // Mechanism A, invoked as-is: the copy is released only when
        // the TOTAL attached count reaches zero.
        let released = false;
        if (state.attachedClients.size === 0) {
          await evictSession('cap-eviction');
          released = true;
        }
        return sendJson(res, 200, {
          ok: true,
          sessionId: body.sessionId,
          principal: target,
          detachedInstances,
          closedSubscribers,
          released,
          revision: released ? state.releasedRevision : state.revision,
          checksum: state.checkpointChecksum,
        });
      }
      if (path === '/session/rehydrate' && method === 'POST') {
        const body = (await readBody(req)) as { sessionId?: unknown; clientInstanceId?: unknown } | undefined;
        const rehydrateClientInstance =
          typeof body?.clientInstanceId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(body.clientInstanceId)
            ? body.clientInstanceId
            : null;
        if (!isSessionId(body?.sessionId)) return sendError(res, 400, '{ sessionId } required');
        const sessionId = body.sessionId;
        if (accessClaims && accessClaims.sid !== sessionId) {
          return sendError(res, 401, 'engine access denied: wrong-session');
        }
        if (state.sessionStatus === 'active' && state.sessionId === sessionId) {
          if (rehydrateClientInstance) noteInstanceAttach(rehydrateClientInstance, principal);
          return sendJson(res, 200, {
            ok: true,
            sessionId,
            revision: state.revision,
            checksum: state.checkpointChecksum,
            checksumVerified: state.checkpointChecksum !== null,
            replayedOps: 0,
            alreadyActive: true,
            sheets: state.host.sheetNames(),
          });
        }
        // The session must be ours: either the released session this
        // process still names, or a registry record (instance-loss
        // path: a fresh process rehydrates from the durable stores).
        const record = await stores.registry.lookup(sessionId);
        if (state.sessionId !== sessionId && !record) {
          return sendError(res, 404, `unknown session: ${sessionId}`);
        }
        // #104: a file-scoped token may only rehydrate the session of
        // its own file. The session record carries no fileId, so the
        // check goes through the file registry: the record for the
        // token's file must name this session. (No record — claim→
        // rehydrate window, or no registry configured — keeps the
        // existing behavior; a registry read failure fails closed.
        // Legacy tokens — no fid — keep working: the web client
        // rehydrates with gateway /access grants. The active-session
        // early return above is already covered by the preamble's
        // general file-scope check, since state.fileId is set there.)
        if (accessClaims?.fid) {
          const fileRegistry = getFileRegistry();
          if (fileRegistry) {
            let fileRec: FileRegistryRecord | null = null;
            try {
              fileRec = await fileRegistry.lookup(accessClaims.fid);
            } catch {
              return sendError(res, 503, 'file registry unavailable — rehydrate refused');
            }
            if (fileRec && fileRec.sessionId !== sessionId) {
              return sendError(res, 401, 'engine access denied: wrong-file');
            }
          }
        }
        if (
          record &&
          record.principal !== principal &&
          !state.participants.has(principal) &&
          !(accessClaims && accessClaims.fid)
        ) {
          return sendError(res, 403, 'session belongs to a different principal');
        }
        try {
          const out = await rehydrateSession(sessionId, principal);
          if (rehydrateClientInstance) noteInstanceAttach(rehydrateClientInstance, principal);
          notifySessionHooks();
          return sendJson(res, 200, {
            ok: true,
            sessionId,
            revision: out.revision,
            checksum: out.checksum,
            checksumVerified: true,
            replayedOps: out.replayedOps,
            sheets: state.host.sheetNames(),
          });
        } catch (e) {
          if (e instanceof SessionChecksumError || e instanceof SessionJournalError) {
            return sendJson(res, 409, { ok: false, error: e.message, checksumVerified: false });
          }
          throw e;
        }
      }

      // -- session claim (Phase 2, §9): the gateway's claim path asks
      //    the chosen instance to create-or-rehydrate the session for
      //    a fileId BEFORE it CAS-claims the registry record. --------
      if (path === '/session/claim' && method === 'POST') {
        // Claim lock (see claimTurn above): wait for any in-flight
        // claim to finish binding before evaluating this one.
        const prevClaimTurn = claimTurn;
        let releaseClaimTurn: () => void = () => undefined;
        claimTurn = new Promise<void>((resolve) => {
          releaseClaimTurn = resolve;
        });
        await prevClaimTurn;
        try {
        const body = (await readBody(req)) as { fileId?: unknown; sessionId?: unknown } | undefined;
        if (typeof body?.fileId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.fileId)) {
          return sendError(res, 400, '{ fileId } required');
        }
        const fileId = body.fileId as string;
        // #104: a claim names the file it claims — a legacy token
        // (no file scope) must not claim an arbitrary file on an idle
        // engine. Every production claim caller (gateway open flow,
        // trigger supervisor) presents a file-scoped token; proxy-mode
        // callers have no accessClaims and are unaffected.
        if (accessClaims && !accessClaims.fid) {
          return sendJson(res, 403, {
            ok: false,
            error: 'legacy session token (no file scope) is not valid for /session/claim',
          });
        }
        if (accessClaims && accessClaims.fid && accessClaims.fid !== fileId) {
          return sendError(res, 401, 'engine access denied: wrong-file');
        }
        if (state.fenced) return sendJson(res, 409, { ok: false, error: 'fenced' });
        const claimerRole = accessClaims?.role ?? 'editor';
        // Client-instance attach (addendum 2): the gateway forwards
        // the opener's instance id with the claim; every successful
        // claim outcome below attaches it to the (possibly rejoined)
        // session's refcount.
        const claimClientInstance =
          typeof (body as { clientInstanceId?: unknown })?.clientInstanceId === 'string' &&
          /^[A-Za-z0-9._:-]{1,128}$/.test((body as { clientInstanceId: string }).clientInstanceId)
            ? ((body as { clientInstanceId: string }).clientInstanceId as string)
            : null;
        const attachClaimInstance = (): void => {
          if (claimClientInstance) noteInstanceAttach(claimClientInstance, principal);
        };
        // #107: open the bounded claim grace for every successful
        // claim outcome below (rejoin, rehydrate, library recovery,
        // pending). The gateway's registry CAS lands AFTER this
        // response; ticks inside the window must not fence the
        // just-claimed session on the still-RELEASED record.
        const openClaimGrace = (): void => {
          state.claimGraceUntilMs = Date.now() + CLAIM_GRACE_MS;
        };
        // Set when the held session is evicted below as registry-
        // contradicted: its id must not be recycled as this claim's
        // candidate (its snapshot/journal belong to the previous file).
        let evictedSessionId: string | null = null;
        if (state.sessionStatus === 'active' && state.sessionId) {
          // One process = one session: a live session for a DIFFERENT
          // file is a hard refusal — this instance must never hydrate
          // a second copy (§9 routing enforcement).
          if (state.fileId && state.fileId !== fileId) {
            // Registry-contradiction exception (batch-2 live wedge):
            // when the file registry POSITIVELY names a DIFFERENT
            // session as the held file's owner, this session is a
            // stale leftover (a takeover landed elsewhere) — holding
            // the 409 would wedge every other file behind a session
            // that owns nothing. Evict it (checkpoint first, exactly
            // like a release) and let the claim proceed. A MISSING
            // record proves nothing (the gateway's CAS may be in
            // flight, or the registry is not in use) and a registry
            // READ failure must never evict (fail closed): both keep
            // the hard refusal.
            const registry = getFileRegistry();
            let contradicted = false;
            if (registry) {
              try {
                const heldRec = await registry.lookup(state.fileId);
                contradicted = !!heldRec && heldRec.sessionId !== state.sessionId;
              } catch {
                contradicted = false;
              }
            }
            if (!contradicted) {
              return sendJson(res, 409, {
                ok: false,
                error: `engine already owns a different file: ${state.fileId}`,
                fileId: state.fileId,
              });
            }
            evictedSessionId = state.sessionId;
            await evictSession('ownership-moved');
          }
          if (evictedSessionId === null && !state.fileId) {
            state.fileId = fileId;
            state.pendingFileId = fileId;
            state.pendingSessionId = state.sessionId;
          }
          if (evictedSessionId === null) {
            state.participants.set(principal, claimerRole);
            attachClaimInstance();
            openClaimGrace();
            notifySessionHooks();
            return sendJson(res, 200, {
              ok: true,
              sessionId: state.sessionId,
              fileId,
              revision: state.revision,
              joined: true,
              pending: false,
            });
          }
          // Evicted above: fall through to the no-live-session path.
        }
        // No live session: rehydrate a released session for this file
        // when a checkpoint snapshot exists for it (snapshot + journal
        // + checksum — the existing rehydrate path), else create a
        // blank pending session that the owner's first /load fills.
        let candidate: string | null = isSessionId(body.sessionId) ? body.sessionId : null;
        if (
          !candidate &&
          state.sessionId &&
          state.sessionId !== evictedSessionId &&
          (state.fileId === fileId || !state.fileId)
        ) {
          candidate = state.sessionId;
        }
        if (!candidate) {
          try {
            const rec = await getFileRegistry()?.lookup(fileId);
            if (rec && isSessionId(rec.sessionId)) candidate = rec.sessionId;
          } catch {
            // Registry read failure: fall through to a fresh pending
            // session id; the gateway's CAS claim is the fail-closed
            // arbiter and will refuse if the registry is truly down.
          }
        }
        if (!candidate) candidate = newSessionId();
        let snapExists = false;
        try {
          snapExists = (await stores.snapshots.get(candidate)) !== null;
        } catch {
          snapExists = false;
        }
        if (snapExists) {
          try {
            const out = await rehydrateSession(candidate, principal);
            state.fileId = fileId;
            state.pendingFileId = fileId;
            state.pendingSessionId = candidate;
            state.participants.set(principal, claimerRole);
            attachClaimInstance();
            openClaimGrace();
            notifySessionHooks();
            return sendJson(res, 200, {
              ok: true,
              sessionId: candidate,
              fileId,
              revision: out.revision,
              rehydrated: true,
              pending: false,
            });
          } catch (e) {
            if (e instanceof SessionChecksumError || e instanceof SessionJournalError) {
              return sendJson(res, 409, { ok: false, error: e.message });
            }
            throw e;
          }
        }
        // Issue #36: no snapshot — before minting a blank session,
        // try the library's stored copy (file-keyed entry, else the
        // session's autosave entry). A created file whose engine
        // instance churned used to reopen EMPTY here even though its
        // checkpoints had committed the bytes to the library.
        {
          const recovered = await recoverSessionFromLibrary(candidate, fileId, principal).catch(
            () => null,
          );
          if (recovered) {
            state.fileId = fileId;
            state.pendingFileId = fileId;
            state.pendingSessionId = candidate;
            state.participants.set(principal, claimerRole);
            attachClaimInstance();
            openClaimGrace();
            notifySessionHooks();
            return sendJson(res, 200, {
              ok: true,
              sessionId: candidate,
              fileId,
              revision: recovered.revision,
              rehydrated: true,
              recoveredFromLibrary: true,
              pending: false,
            });
          }
        }
        await registerSession(candidate, principal);
        state.fileId = fileId;
        state.pendingFileId = fileId;
        state.pendingSessionId = candidate;
        state.participants.set(principal, claimerRole);
        attachClaimInstance();
        openClaimGrace();
        notifySessionHooks();
        return sendJson(res, 200, {
          ok: true,
          sessionId: candidate,
          fileId,
          revision: state.revision,
          pending: true,
        });
        } finally {
          releaseClaimTurn();
        }
      }

      // A released session serves nothing but the lifecycle routes
      // above (and a fresh /load, /load/storage-ref or /reset, which
      // start a new session):
      // the workbook is out of memory, and a stale read must never be
      // answered from the blank post-eviction host.
      if (
        state.sessionStatus === 'released' &&
        path !== '/load' &&
        path !== '/load/stream' &&
        path !== '/load/storage-ref' &&
        path !== '/reset'
      ) {
        return sendError(res, 409, 'session is released (idle) — rehydrate to resume');
      }
      // Any served request is client activity for the idle rule.
      if (state.sessionStatus === 'active') state.lastActivityMs = Date.now();

      // -- charts: native chart creation (FIX-G, trace §4.1c) ------------
      if (path === '/charts' && method === 'POST') {
        if (state.sessionStatus !== 'active' || !state.sessionId) {
          return sendError(res, 409, 'no active session for chart creation');
        }
        // Role gate exactly as /ops: the token's role wins; proxy-mode
        // callers fall back to the participant record.
        const role = await currentRoleFor(principal, accessClaims);
        if (role !== 'editor') {
          return sendJson(res, 403, {
            ok: false,
            rejected: true,
            reason: role === 'viewer' ? 'viewer-role' : 'no-access-grant',
          });
        }
        const body = (await readBody(req)) as { spec?: unknown } | undefined;
        if (!body || !isValidChartSpec(body.spec)) {
          return sendError(
            res,
            400,
            'body.spec must be a ChartSpec with an authorable kind (column-clustered, column-stacked, bar-clustered, line, line-markers, area, pie, doughnut) and a valid range',
          );
        }
        const spec = body.spec;
        const sheetNames = state.host.sheetNames();
        const referenced = new Set<string>([spec.range.sheet]);
        for (const sr of spec.seriesRanges ?? []) {
          referenced.add(sr.val.sheet);
          if (sr.cat) referenced.add(sr.cat.sheet);
        }
        for (const name of referenced) {
          if (!sheetNames.includes(name)) {
            return sendError(res, 400, `unknown sheet: ${name}`);
          }
        }
        const outcome = await enqueueSequenced(() => acceptChart(spec, principal));
        return sendJson(res, 200, { ok: true, id: outcome.id, revision: outcome.revision });
      }

      // -- execute (legacy route; Phase 2: same FIFO sequencer as /ops) ----
      if (path === '/execute' && method === 'POST') {
        // Role gate exactly as /ops and /charts (FIX-R3): /execute is a
        // mutation route — every command it carries writes — so a
        // viewer must be refused here too. The token's role wins;
        // proxy-mode callers fall back to the participant record. The
        // add-on document binding writes through this route with a
        // role-scoped token, so without this gate a viewer's add-on
        // could write where the viewer's own agent (via /ops) cannot.
        const role = await currentRoleFor(principal, accessClaims);
        if (role !== 'editor') {
          return sendJson(res, 403, {
            ok: false,
            rejected: true,
            reason: role === 'viewer' ? 'viewer-role' : 'no-access-grant',
          });
        }
        const body = (await readBody(req)) as
          | { cmd?: EngineCommand; ackChecksum?: boolean }
          | undefined;
        if (!body || typeof body.cmd !== 'object' || body.cmd === null) {
          return sendError(res, 400, 'body.cmd must be an engine command object');
        }
        if (!isEngineCommandShape(body.cmd)) {
          return sendError(res, 400, 'body.cmd must be an EngineCommand: an object with a non-empty string "cmd" field (a CollabOp {type, params} shape is not a command)');
        }
        const outcome = await enqueueSequenced(() =>
          runExecuteInternal({
            rawCmd: body.cmd as EngineCommand,
            principal,
            ackChecksum: body.ackChecksum === true,
            envelope: null,
          }),
        );
        return sendJson(res, outcome.status, outcome.payload);
      }

      // -- ops: the Phase 2 co-authoring sequencer endpoint (§7) -----------
      if (path === '/ops' && method === 'POST') {
        const body = (await readBody(req)) as
          | { clientId?: unknown; clientSeq?: unknown; baseRev?: unknown; cmd?: unknown }
          | undefined;
        if (
          !body ||
          typeof body.clientId !== 'string' ||
          body.clientId.length === 0 ||
          !Number.isInteger(body.clientSeq) ||
          (body.clientSeq as number) < 0 ||
          !Number.isInteger(body.baseRev) ||
          (body.baseRev as number) < 0 ||
          typeof body.cmd !== 'object' ||
          body.cmd === null
        ) {
          return sendError(res, 400, 'body must be { clientId: string, clientSeq: int>=0, baseRev: int>=0, cmd: EngineCommand }');
        }
        const clientId = body.clientId as string;
        const clientSeq = body.clientSeq as number;
        const baseRev = body.baseRev as number;
        const incomingCmd = body.cmd as EngineCommand;
        if (!isEngineCommandShape(incomingCmd)) {
          return sendError(res, 400, 'body.cmd must be an EngineCommand: an object with a non-empty string "cmd" field (a CollabOp {type, params} shape is not a command)');
        }
        // Role: the token's role wins; proxy-mode callers fall back to
        // the participant record (gateway-authenticated = editor).
        const role = await currentRoleFor(principal, accessClaims);
        if (role !== 'editor') {
          return sendJson(res, 403, {
            ok: false,
            rejected: true,
            reason: role === 'viewer' ? 'viewer-role' : 'no-access-grant',
          });
        }
        const idemKey = `${clientId}:${clientSeq}`;
        const seen = state.seenOps.get(idemKey);
        if (seen) return sendJson(res, seen.status, seen.payload);
        // §9A activity: an accepted op is user activity on this file
        // (the LRU input for the per-user open cap).
        notePrincipalActivity(principal);
        const outcome = await enqueueSequenced(async () => {
          // Re-check inside the FIFO: a concurrent retry of the same
          // (clientId, clientSeq) must not re-apply.
          const seenInner = state.seenOps.get(idemKey);
          if (seenInner) return seenInner;
          let applied: EngineCommand = incomingCmd;
          // §1 resync rule: a baseRev older than journal retention can
          // no longer be rebased faithfully — the client must
          // re-stream full state (its queued ops then replay on top).
          if (baseRev < state.retentionFloor) {
            return {
              status: 409,
              payload: {
                ok: false,
                rejected: true,
                reason: 'before-retention',
                oldestRevision: state.retentionFloor + 1,
                revision: state.revision,
              },
            };
          }
          // Rebase (§7): baseRev < current → transform the INCOMING op
          // against the CollabOp mappings of the intervening revisions.
          if (baseRev < state.revision) {
            const collab0 = cmdToCollabOp(incomingCmd, clientId, baseRev);
            if (collab0) {
              let cur: CollabOp | null = collab0;
              for (const entry of state.deltaLog) {
                if (!cur) break;
                if (entry.revision <= baseRev) continue;
                if (entry.revision > state.revision) break;
                if (entry.collab) cur = transform(cur, entry.collab);
              }
              if (!cur) {
                // Made obsolete by an intervening op (e.g. its sheet
                // was deleted): VISIBLE rejection, nothing journaled.
                const rejected = {
                  status: 200,
                  payload: { ok: false, rejected: true, reason: 'obsolete', revision: state.revision },
                };
                state.seenOps.set(idemKey, rejected);
                return rejected;
              }
              applied = collabOpToCmd(cur) ?? incomingCmd;
            }
          }
          const out = await runExecuteInternal({
            rawCmd: applied,
            principal,
            ackChecksum: true,
            envelope: { clientId, clientSeq },
          });
          const stored = { status: out.status, payload: out.payload };
          state.seenOps.set(idemKey, stored);
          if (state.seenOps.size > 10_000) {
            const oldest = state.seenOps.keys().next().value as string;
            state.seenOps.delete(oldest);
          }
          return stored;
        });
        return sendJson(res, outcome.status, outcome.payload);
      }

      // -- deltas: SSE push channel (§8, ALWAYS ON) --------------------------
      if (path === '/deltas' && method === 'GET') {
        // Issue #51: the stream is a read — a principal whose grant
        // was revoked (no current role) may not subscribe.
        const subRole = await currentRoleFor(principal, accessClaims);
        if (!subRole) {
          return sendJson(res, 403, { ok: false, rejected: true, reason: 'no-access-grant' });
        }
        applyCors(res);
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.flushHeaders();
        const sub: SseSubscriber = {
          res,
          principal,
          role: subRole,
          heartbeat: null,
          lastFlushAt: Date.now(),
          reaped: false,
        };
        state.sseSubscribers.add(sub);
        // On subscribe the participant's applied revision is the
        // hello revision (retention input, §1).
        state.appliedRev.set(principal, { appliedRev: state.revision, lastAckAt: Date.now() });
        sseSend(sub, 'hello', {
          revision: state.revision,
          storedRevision: state.storageRevision,
          fileId: state.fileId,
        });
        sseSend(sub, 'status', {
          revision: state.revision,
          storedRevision: state.storageRevision,
          saving: state.storageRevision < state.revision || state.pendingCheckpointOps > 0 || state.extrasDirty,
          storedBytes: state.lastCheckpointBytes,
        });
        sseSend(sub, 'presence', {
          participants: livePresence().map((p) => ({
            principal: p.principal,
            ...(p.name ? { name: p.name } : {}),
            color: p.color,
            sheet: p.sheet,
            row: p.row,
            col: p.col,
            editing: p.editing,
          })),
        });
        // FIX-G hello echo (trace §4.1e nice-to-have, landed): a
        // reconnecting client re-syncs the session's native charts
        // immediately instead of waiting for the next chart or a
        // full reload.
        if (state.sessionCharts.length > 0) {
          sseSend(sub, 'session', {
            kind: 'charts',
            revision: state.revision,
            charts: state.sessionCharts,
          });
        }
        sub.heartbeat = setInterval(() => {
          // Heartbeat reaper (leg 6): check BEFORE writing. If no
          // write has flushed successfully within the reap window,
          // the socket is dead or half-open — write callbacks may
          // never fire at all on such a socket, so the passage of
          // time is the only signal. Reap: subscription removed,
          // response ended, Cloud Run request slot freed.
          if (Date.now() - sub.lastFlushAt > sseReapAfterMs) {
            reapSubscriber(sub);
            return;
          }
          // Issue #51 section 5: a revocation cuts a LIVE stream too
          // — re-derive the subscriber's role from the grant record
          // each heartbeat; no grant -> reap (their next REST read is
          // refused as well). A demotion editor->viewer updates the
          // role the delta fan-out filters by.
          void currentRoleFor(sub.principal, null).then((r) => {
            if (!r) reapSubscriber(sub);
            else sub.role = r;
          });
          sseWrite(sub, ': heartbeat\n\n');
        }, sseHeartbeatIntervalMs);
        sub.heartbeat.unref?.();
        // Client disconnect: 'close' (and any response 'error') reaps
        // the subscriber AND ends the response — merely forgetting
        // the subscriber leaves the request open forever.
        res.on('close', () => reapSubscriber(sub));
        res.on('error', () => reapSubscriber(sub));
        return;
      }
      if (path === '/deltas/ack' && method === 'POST') {
        const body = (await readBody(req)) as { revision?: unknown } | undefined;
        if (!body || !Number.isInteger(body.revision) || (body.revision as number) < 0) {
          return sendError(res, 400, '{ revision: int>=0 } required');
        }
        // #104: acking requires a CURRENT grant, like subscribing.
        if ((await currentRoleFor(principal, accessClaims)) === null) {
          return sendJson(res, 403, { ok: false, rejected: true, reason: 'no-access-grant' });
        }
        const prev = state.appliedRev.get(principal);
        state.appliedRev.set(principal, {
          appliedRev: Math.max(prev?.appliedRev ?? 0, body.revision as number),
          lastAckAt: Date.now(),
        });
        return sendJson(res, 200, { ok: true, revision: state.revision });
      }

      // -- revisions: journal catch-up (§8 gap rule) -------------------------
      if (path === '/revisions' && method === 'GET') {
        // Issue #51: journal catch-up is a read — grant required.
        if ((await currentRoleFor(principal, accessClaims)) === null) {
          return sendJson(res, 403, { ok: false, rejected: true, reason: 'no-access-grant' });
        }
        const fromRaw = Number(url.searchParams.get('from') ?? '0');
        const toRaw = Number(url.searchParams.get('to') ?? String(state.revision));
        const from = Number.isFinite(fromRaw) && fromRaw >= 0 ? Math.floor(fromRaw) : 0;
        const to = Number.isFinite(toRaw) && toRaw >= 0 ? Math.floor(toRaw) : state.revision;
        // Oldest revision the retained journal/delta log can serve
        // catch-up FROM (i.e. every revision > availableFrom exists).
        const firstRetained = state.deltaLog.length > 0 ? state.deltaLog[0]!.revision : state.revision + 1;
        const availableFrom = Math.max(state.retentionFloor, firstRetained - 1);
        if (from < availableFrom) {
          return sendJson(res, 409, {
            ok: false,
            error: 'before-retention',
            oldestRevision: availableFrom + 1,
          });
        }
        const revisions = state.deltaLog
          .filter((e) => e.revision > from && e.revision <= to)
          .map((e) => ({
            revision: e.revision,
            origin: e.origin,
            op: e.op,
            cells: filterDeltaCells(e.cells, principal),
          }));
        return sendJson(res, 200, { revisions });
      }

      // -- presence (§8): ephemeral, NEVER journaled, NEVER a revision -------
      if (path === '/presence' && method === 'POST') {
        // #104: presence posts require a CURRENT grant — a revoked
        // principal must not post presence or stamp LRU activity.
        if ((await currentRoleFor(principal, accessClaims)) === null) {
          return sendJson(res, 403, { ok: false, rejected: true, reason: 'no-access-grant' });
        }
        const body = (await readBody(req)) as
          | { sheet?: unknown; row?: unknown; col?: unknown; editing?: unknown; name?: unknown }
          | undefined;
        if (
          !body ||
          typeof body.sheet !== 'string' ||
          !Number.isInteger(body.row) ||
          !Number.isInteger(body.col)
        ) {
          return sendError(res, 400, '{ sheet: string, row: int, col: int, editing?: boolean } required');
        }
        // Display name (workspace-settings brief): the client's
        // settings name rides the presence payload. Validated +
        // capped; a post WITHOUT a name keeps the previous one (a
        // heartbeat must not blank a name another post supplied).
        const postedName =
          typeof body.name === 'string' && body.name.trim().length > 0
            ? body.name.trim().slice(0, 120)
            : undefined;
        const prev = state.presenceMap.get(principal);
        // §9A activity: a presence post whose selection actually
        // CHANGED is user activity (selection changes ride presence);
        // the client's periodic re-send of an unchanged selection is
        // a presence heartbeat, not activity, and does not stamp.
        if (
          !prev ||
          Date.now() - prev.updatedAt > PRESENCE_TTL_MS ||
          prev.sheet !== (body.sheet as string) ||
          prev.row !== (body.row as number) ||
          prev.col !== (body.col as number) ||
          prev.editing !== (body.editing === true)
        ) {
          notePrincipalActivity(principal);
        }
        state.presenceMap.set(principal, {
          principal,
          ...(postedName ?? prev?.name ? { name: postedName ?? prev?.name } : {}),
          color: presenceColorFor(principal),
          sheet: body.sheet as string,
          row: body.row as number,
          col: body.col as number,
          editing: body.editing === true,
          updatedAt: Date.now(),
        });
        broadcastPresence();
        return sendJson(res, 200, { ok: true });
      }
      if (path === '/presence/leave' && method === 'POST') {
        await readBody(req).catch(() => undefined);
        if (state.presenceMap.delete(principal)) broadcastPresence();
        return sendJson(res, 200, { ok: true });
      }

      // -- read ------------------------------------------------------------
      if (path === '/read' && method === 'POST') {
        // Issue #51 sections 4-5: reads require a CURRENT grant —
        // a revoked principal's next read is refused even with the
        // token they already hold.
        if ((await currentRoleFor(principal, accessClaims)) === null) {
          return sendJson(res, 403, { ok: false, rejected: true, reason: 'no-access-grant' });
        }
        // W20: pend on an in-flight load build (see the build gate
        // above) — served from the NEW workbook once built; a failed
        // build's error throws here and surfaces via the outer catch.
        const waitedForBuild = await waitForLoadBuild();
        const body = (await readBody(req)) as
          | { kind?: string; ref?: CellRef; range?: RangeRef; sheet?: string }
          | undefined;
        const kind = body?.kind;
        // Item H (round-trip audit D3): the client legitimately issues
        // reads for the workbook it is LOOKING at while an open is in
        // flight — e.g. the boot workbook's 'Sheet1' viewport + A1
        // reads (2 shapes × 2 consumers = the audit's exactly-4). The
        // sheet they address belongs to the SUPERSEDED workbook, but
        // they execute against the new one — some pend on the gate
        // above; others arrive during the build's synchronous block,
        // sit in the socket queue, and are only PROCESSED after the
        // gate has settled and cleared (browser repro: the pair that
        // lands in the socket-queue window never sees the gate). Either
        // way the outcome was `Unknown sheet` → 500: a server fault for
        // a routine superseded read (and with a colliding sheet name
        // they would silently have answered from the successor state).
        // Contract now: a cell/range read naming a sheet the current
        // workbook does not have is a CLIENT addressing error, never a
        // 500 — 409 SUPERSEDED when the read pended on the load that
        // replaced its workbook (it cannot have been addressed to the
        // new file: the stream's meta chunk only advertises sheets
        // that exist), else 404 with the engine's own `Unknown sheet`
        // message text. (The other read kinds already behave this way:
        // usedrange answers 200 null and sheet reads answer [] for an
        // absent sheet.) Pended reads for sheets that DO exist in the
        // new workbook are still served from it, exactly as W20
        // specifies; the failed-build sticky error still surfaces as
        // before via waitForLoadBuild's throw.
        const sheetAbsent = (sheet: string): boolean => !state.host.sheetNames().includes(sheet);
        const sendUnknownSheet = (sheet: string) => {
          if (waitedForBuild) {
            console.log(
              `[engine] /read superseded by workbook load: sheet "${sheet}" is not in the loaded workbook (409)`,
            );
            return sendError(
              res,
              409,
              `read superseded by a workbook load: sheet "${sheet}" does not exist in the loaded workbook`,
            );
          }
          return sendError(res, 404, `Unknown sheet: ${sheet}`);
        };
        if (kind === 'cell') {
          if (!isCellRef(body?.ref)) return sendError(res, 400, 'cell read needs { ref: { sheet, row, col } }');
          if (sheetAbsent((body.ref as CellRef).sheet)) return sendUnknownSheet((body.ref as CellRef).sheet);
          const value = state.host.readCell(body.ref as CellRef, auth);
          const out: { value: TypedValue; formula?: string } = { value };
          // FormulaBar support: expose formula text only when the cell itself
          // is readable (denied cells stay #PERM! with no formula).
          if (!(value.kind === 'error' && value.code === '#PERM!')) {
            const formula = state.host.getView().readCell(body.ref as CellRef).formula;
            if (formula !== undefined) out.formula = formula;
          }
          return sendJson(res, 200, out);
        }
        if (kind === 'range') {
          if (!isRangeRef(body?.range)) return sendError(res, 400, 'range read needs { range: RangeRef }');
          if (sheetAbsent((body.range as RangeRef).sheet)) return sendUnknownSheet((body.range as RangeRef).sheet);
          const range = body.range as RangeRef;
          const values = state.host.readRange(range, auth);
          const formulas: (string | null)[][] = [];
          for (let r = range.startRow; r <= range.endRow; r++) {
            const row: (string | null)[] = [];
            for (let c = range.startCol; c <= range.endCol; c++) {
              // The values grid came through the same authorized readCell
              // path, so its #PERM! verdict is the one to honor here — a
              // second host.readCell per cell would double the read cost
              // (Cycle 10 defect D3).
              const v = values[r - range.startRow][c - range.startCol];
              row.push(
                v.kind === 'error' && v.code === '#PERM!'
                  ? null
                  : (state.host.getView().readCell({ sheet: range.sheet, row: r, col: c }).formula ?? null),
              );
            }
            formulas.push(row);
          }
          // W16: a large read's transients (per-cell auth/taint walks,
          // formula unparsing) peak here; return those pages before the
          // response grid is serialized, and again once it has flushed,
          // so an exhaustive read pass does not ratchet the service's
          // RSS to its high-water mark. Large reads only — see
          // maybeGcLarge for why small reads must not pay a full GC.
          const readCells =
            (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1);
          maybeGcLarge(readCells);
          res.on('finish', () => maybeGcLarge(readCells));
          return sendJson(res, 200, { values, formulas });
        }
        if (kind === 'sheet') {
          if (typeof body?.sheet !== 'string' || body.sheet.length === 0) {
            return sendError(res, 400, 'sheet read needs { sheet: string }');
          }
          const values = state.host.readSheet(body.sheet, auth);
          maybeGcLarge(values.length * (values[0]?.length ?? 0));
          res.on('finish', () => maybeGcLarge(values.length * (values[0]?.length ?? 0)));
          return sendJson(res, 200, { values });
        }
        if (kind === 'usedrange') {
          if (typeof body?.sheet !== 'string' || body.sheet.length === 0) {
            return sendError(res, 400, 'usedrange read needs { sheet: string }');
          }
          const range = state.host.getView().usedRange(body.sheet);
          return sendJson(res, 200, { range });
        }
        return sendError(res, 400, "kind must be 'cell' | 'range' | 'sheet' | 'usedrange'");
      }

      // -- snapshot (permission-filtered) ----------------------------------
      if (path === '/snapshot' && method === 'GET') {
        // #104: a snapshot is a read — a revoked principal gets
        // nothing, same rule as /read (the per-cell filter alone is
        // not a grant check).
        if ((await currentRoleFor(principal, accessClaims)) === null) {
          return sendJson(res, 403, { ok: false, rejected: true, reason: 'no-access-grant' });
        }
        const snap = filteredSnapshot(principal);
        // File-2 D1 follow-up: additive metadata channel — joiners and
        // rehydrated clients hydrate ONLY from this response, and the
        // bare WorkbookSnapshot carried no workbook metadata, so their
        // imported pictures/text boxes never rendered. Attached here
        // (not inside filteredSnapshot) so save serialization, which
        // merges metadata itself, is untouched.
        const metadata = snapshotMetadata();
        // #134: additive styles channel — same route-only pattern.
        // Joiners hydrate ONLY from this response, and without styles
        // their format store stays empty, their first extras push
        // reports every sheet as authoritatively empty, and the next
        // serialization wipes the file's imported styles (bold loss
        // on reopen). Attached here (not inside filteredSnapshot) so
        // save serialization is untouched.
        const { sheetStyles, sheetFormats } = snapshotSheetStyles();
        const extraFields: Record<string, unknown> = {};
        if (Object.keys(metadata).length > 0) extraFields['metadata'] = metadata;
        if (Object.keys(sheetStyles).length > 0) extraFields['sheetStyles'] = sheetStyles;
        if (Object.keys(sheetFormats).length > 0) extraFields['sheetFormats'] = sheetFormats;
        // Round-3 leg-B join fix (same route-only pattern): the
        // session's live native charts, so a joining client merges
        // them back after its metadata hydration (which carries file
        // metadata only and would otherwise wipe the SSE hello
        // echo's charts). Omitted when empty, like the other
        // channels above.
        if (state.sessionCharts.length > 0) extraFields['charts'] = state.sessionCharts;
        return sendJson(res, 200, { ...snap, ...extraFields });
      }

      // -- events (polling subscription) ------------------------------------
      if (path === '/events' && method === 'GET') {
        // #104: the event log (changed refs + sheet names) is session
        // data — a revoked principal gets nothing, same rule as /read.
        if ((await currentRoleFor(principal, accessClaims)) === null) {
          return sendJson(res, 403, { ok: false, rejected: true, reason: 'no-access-grant' });
        }
        const since = Number(url.searchParams.get('since') ?? '0');
        const from = Number.isFinite(since) && since >= 0 ? Math.floor(since) : 0;
        const events = state.events.filter((e) => e.seq > from);
        return sendJson(res, 200, { events });
      }

      // -- load: open an .xlsx against the remote engine --------------------
      if (path === '/load' && method === 'POST') {
        const body = (await readBody(req, LOAD_MAX_BODY_BYTES)) as
          | { format?: string; data?: string; sessionId?: unknown; name?: unknown }
          | undefined;
        // Signed mode: the token's session IS the session this load
        // introduces — a token minted for another session opens nothing.
        if (accessClaims && (!isSessionId(body?.sessionId) || body.sessionId !== accessClaims.sid)) {
          return sendError(res, 401, 'engine access denied: wrong-session');
        }
        // #104: a file-scoped token may only load into the session
        // claimed for its file. Claim→load window: state.fileId is
        // still null and the claimed file lives in pendingFileId (the
        // preamble's general check covers already-loaded sessions).
        // Legacy tokens (no fid) keep working — the web load path runs
        // on gateway /access grants.
        if (accessClaims?.fid && state.pendingFileId && accessClaims.fid !== state.pendingFileId) {
          return sendError(res, 401, 'engine access denied: wrong-file');
        }
        // Role gate exactly as /ops: the token's role wins; proxy-mode
        // callers fall back to the participant record. A viewer token
        // must never replace the live workbook via load. (F-9)
        const role = await currentRoleFor(principal, accessClaims);
        if (role !== 'editor') {
          return sendJson(res, 403, {
            ok: false,
            rejected: true,
            reason: role === 'viewer' ? 'viewer-role' : 'no-access-grant',
          });
        }
        if (body?.format !== 'xlsx' && body?.format !== 'csv' && body?.format !== 'xls') {
          return sendError(res, 400, "only formats 'xlsx', 'csv' and 'xls' are supported");
        }
        if (typeof body?.data !== 'string' || body.data.length === 0) {
          return sendError(res, 400, 'data must be base64-encoded file bytes');
        }
        let bytes: Uint8Array;
        try {
          bytes = new Uint8Array(Buffer.from(body.data, 'base64'));
        } catch {
          return sendError(res, 400, 'data is not valid base64');
        }
        // Post-bytes tail shared with /load/storage-ref (see
        // loadBytesIntoSession): build gate, parse, build, session
        // introduction, /load response.
        return loadBytesIntoSession({
          res,
          bytes,
          sessionIdRaw: body.sessionId,
          principal,
          accessClaims,
          logLabel: '/load',
          format: body.format as 'xlsx' | 'csv' | 'xls',
          sourceName: typeof body.name === 'string' ? body.name : undefined,
        });
      }

      // -- load by storage reference: open an uploaded workbook by its
      //    storage key (product layer; no bytes through this request) ---
      if (path === '/load/storage-ref' && method === 'POST') {
        const body = (await readBody(req)) as
          | { bucket?: unknown; object?: unknown; format?: unknown; sessionId?: unknown; name?: unknown }
          | undefined;
        // Signed mode: IDENTICAL rule to /load — the token's session
        // IS the session this load introduces.
        if (accessClaims && (!isSessionId(body?.sessionId) || body.sessionId !== accessClaims.sid)) {
          return sendError(res, 401, 'engine access denied: wrong-session');
        }
        // #104: same pendingFileId rule as /load (see there).
        if (accessClaims?.fid && state.pendingFileId && accessClaims.fid !== state.pendingFileId) {
          return sendError(res, 401, 'engine access denied: wrong-file');
        }
        // Role gate exactly as /ops: the token's role wins; proxy-mode
        // callers fall back to the participant record. (F-9)
        const role = await currentRoleFor(principal, accessClaims);
        if (role !== 'editor') {
          return sendJson(res, 403, {
            ok: false,
            rejected: true,
            reason: role === 'viewer' ? 'viewer-role' : 'no-access-grant',
          });
        }
        if (
          body?.format !== undefined &&
          body.format !== 'xlsx' &&
          body.format !== 'csv' &&
          body.format !== 'xls'
        ) {
          return sendError(res, 400, "only formats 'xlsx', 'csv' and 'xls' are supported");
        }
        if (
          body?.bucket !== undefined &&
          (typeof body.bucket !== 'string' || body.bucket !== configuredUploadBucket)
        ) {
          return sendError(
            res,
            400,
            `bucket does not match the configured upload bucket (${configuredUploadBucket})`,
          );
        }
        const bucket = typeof body?.bucket === 'string' ? body.bucket : configuredUploadBucket;
        // The object key is a RELATIVE path under the upload store:
        // reject traversal, absolute paths and backslashes outright.
        const object = body?.object;
        if (
          typeof object !== 'string' ||
          object.length === 0 ||
          object.includes('\\') ||
          object.startsWith('/') ||
          /^[A-Za-z]:/.test(object) ||
          object.split('/').some((seg) => seg === '..')
        ) {
          return sendError(res, 400, 'object must be a relative storage object key');
        }
        const bytes = await resolveUploadObjectBytes(object);
        if (!bytes) return sendError(res, 404, 'storage object not found');
        // The IDENTICAL /load tail, plus the storageRef echo.
        return loadBytesIntoSession({
          res,
          bytes,
          sessionIdRaw: body?.sessionId,
          principal,
          accessClaims,
          logLabel: '/load/storage-ref',
          extraResponseFields: { storageRef: { bucket, object } },
          format:
            body?.format === 'csv' ? 'csv' : body?.format === 'xls' ? 'xls' : 'xlsx',
          sourceName: typeof body?.name === 'string' ? body.name : undefined,
        });
      }

      // -- load/stream: progressive open (NDJSON; see header) -------------
      if (path === '/load/stream' && method === 'POST') {
        const body = (await readBody(req, LOAD_MAX_BODY_BYTES)) as
          | { format?: string; data?: string; sessionId?: unknown }
          | undefined;
        // Signed mode scope check BEFORE the stream head is written —
        // after headers this could only be an in-stream error chunk.
        if (accessClaims && (!isSessionId(body?.sessionId) || body.sessionId !== accessClaims.sid)) {
          return sendError(res, 401, 'engine access denied: wrong-session');
        }
        // #104: same pendingFileId rule as /load (see there).
        if (accessClaims?.fid && state.pendingFileId && accessClaims.fid !== state.pendingFileId) {
          return sendError(res, 401, 'engine access denied: wrong-file');
        }
        // Role gate exactly as /ops: the token's role wins; proxy-mode
        // callers fall back to the participant record. (F-9)
        const role = await currentRoleFor(principal, accessClaims);
        if (role !== 'editor') {
          return sendJson(res, 403, {
            ok: false,
            rejected: true,
            reason: role === 'viewer' ? 'viewer-role' : 'no-access-grant',
          });
        }
        if (body?.format !== 'xlsx') return sendError(res, 400, "only format 'xlsx' is supported");
        if (typeof body?.data !== 'string' || body.data.length === 0) {
          return sendError(res, 400, 'data must be base64-encoded file bytes');
        }
        let bytes: Uint8Array;
        try {
          bytes = new Uint8Array(Buffer.from(body.data, 'base64'));
        } catch {
          return sendError(res, 400, 'data is not valid base64');
        }
        // W20: the build gate opens BEFORE the parse — this is the
        // window the defect lived in (meta chunk out, client reads
        // flowing, engine build not yet started). Settled in the
        // finally around the stream body below: success clears it,
        // any parse/build failure settles it with that error.
        const buildGate = beginLoadBuild();
        let streamError: unknown = null;
        const tStart = performance.now();
        const elapsed = (): number => Math.round(performance.now() - tStart);
        // CORS: the stream head is a hand-rolled success response — it
        // must carry the CORS headers like every other success path in
        // this service (sendJson/sendError/storage//deltas//download all
        // applyCors). Without them a browser refuses the streamed load
        // AFTER the engine has built the workbook, the client silently
        // degrades to the classic /load path, and the session never
        // becomes a direct (Phase 2) session — which in turn leaves
        // downloads with only the gateway-proxied metadata call that a
        // signed-mode engine refuses (401). Round-trip audit finding,
        // 2026-10-22.
        applyCors(res);
        res.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          // Proxies (incl. the gateway) must not buffer the stream.
          'x-accel-buffering': 'no',
        });
        res.flushHeaders();
        let clientGone = false;
        let lastFlushAt = Date.now();
        let dataDoneSent = false;
        const markGone = (): void => {
          clientGone = true;
        };
        res.on('close', markGone);
        res.on('error', markGone);
        const send = (obj: Record<string, unknown>): void => {
          if (clientGone || res.writableEnded || res.destroyed) return;
          try {
            // Flush callback (leg 6): a failed flush marks the client
            // gone so no further writes are attempted on the corpse;
            // a successful one feeds the watchdog's idle window.
            res.write(`${JSON.stringify(obj)}\n`, (err?: Error | null) => {
              if (err) {
                clientGone = true;
                return;
              }
              lastFlushAt = Date.now();
            });
          } catch {
            clientGone = true;
          }
        };
        // Disconnect watchdog (leg 6): once the client is gone — or
        // no write has flushed within STREAM_WRITE_TIMEOUT_MS before
        // data-done (dead/half-open socket: 'close' may never be
        // delivered) — end + destroy the response immediately so the
        // Cloud Run request slot frees. The parse/build tail below
        // then runs out against guarded no-op sends and settles the
        // build gate in its finally, instead of the response
        // lingering until the tail happens to finish. After
        // data-done the remaining tail is bounded server-side work
        // (synchronous build + session register), so only the
        // client-gone case applies there.
        const streamWatchdog = setInterval(
          () => {
            if (res.writableEnded || res.destroyed) {
              clearInterval(streamWatchdog);
              return;
            }
            if (
              clientGone ||
              (!dataDoneSent && Date.now() - lastFlushAt > streamWriteTimeout)
            ) {
              clientGone = true;
              try {
                res.end();
              } catch {
                // Already gone.
              }
              try {
                res.destroy();
              } catch {
                // Already gone.
              }
              clearInterval(streamWatchdog);
            }
          },
          Math.min(1000, Math.max(50, Math.floor(streamWriteTimeout / 4))),
        );
        streamWatchdog.unref?.();

        // Ordered emission: chunks buffer per sheet; the stream emits in
        // sheet order, sheet 1 first, however the workers finish.
        let sheetNames: string[] = [];
        let totalSheets = 0;
        let totalCellsEstimate: number | null = null;
        const chunkQueues = new Map<number, SheetRowChunk[]>();
        const doneSheets = new Set<number>();
        let emitIndex = 0;
        let sheetsDoneCount = 0;
        let cellsDoneCount = 0;
        let metaMs: number | null = null;
        let sheet1RowsMs: number | null = null;

        const pump = (): void => {
          for (;;) {
            const queue = chunkQueues.get(emitIndex);
            while (queue && queue.length > 0) {
              const chunk = queue.shift() as SheetRowChunk;
              cellsDoneCount += chunk.cellCount;
              if (emitIndex === 0 && sheet1RowsMs === null) sheet1RowsMs = elapsed();
              send({
                type: 'rows',
                sheet: sheetNames[emitIndex],
                index: emitIndex,
                startRow: chunk.startRow,
                rows: chunk.rows,
                display: chunk.displayRows,
                formats: encodeFormatsRecord(chunk.formats),
                pendingCalc: chunk.pendingCalc,
                progress: {
                  sheetsDone: sheetsDoneCount,
                  cellsDone: cellsDoneCount,
                  totalSheets,
                  totalCells: totalCellsEstimate,
                },
                elapsedMs: elapsed(),
              });
            }
            if (!doneSheets.has(emitIndex)) return;
            sheetsDoneCount++;
            send({
              type: 'sheet-complete',
              sheet: sheetNames[emitIndex],
              index: emitIndex,
              progress: {
                sheetsDone: sheetsDoneCount,
                cellsDone: cellsDoneCount,
                totalSheets,
                totalCells: totalCellsEstimate,
              },
              elapsedMs: elapsed(),
            });
            emitIndex++;
            if (emitIndex >= totalSheets && totalSheets > 0) return;
            if (totalSheets === 0) return;
          }
        };

        const events: LoadParseEvents = {
          onMeta: (meta) => {
            sheetNames = meta.sheets;
            totalSheets = meta.totalSheets;
            totalCellsEstimate = meta.totalCellsEstimate;
            metaMs = elapsed();
            send({
              type: 'meta',
              sheets: meta.sheets,
              totalSheets: meta.totalSheets,
              totalCells: meta.totalCellsEstimate,
              totalSheetXmlBytes: meta.totalSheetXmlBytes,
              ...(meta.definedNames ? { definedNames: meta.definedNames } : {}),
              metadata: encodeMetadataForJson(meta.metadata),
              progress: {
                sheetsDone: 0,
                cellsDone: 0,
                totalSheets: meta.totalSheets,
                totalCells: meta.totalCellsEstimate,
              },
              elapsedMs: metaMs,
            });
          },
          onSheetChunk: (i, chunk) => {
            const q = chunkQueues.get(i) ?? [];
            q.push(chunk);
            chunkQueues.set(i, q);
            pump();
          },
          onSheetDone: (i) => {
            doneSheets.add(i);
            pump();
          },
        };

        try {
          const outcome = await parseWorkbookFast(bytes, events);
          pump(); // flush anything buffered behind the final sheet
          // DATA COMPLETE, CALCULATING: every cell chunk is out; the
          // engine graph build runs now, behind the stream. The chunk is
          // written with an awaited callback BEFORE the synchronous
          // build+mirror phase (both block the event loop): the write
          // callback fires only once this chunk has been handed to the
          // socket, so the client sees "data done, calculating" before
          // the build starts — an empty write's callback does NOT
          // guarantee that (it can resolve from the userland buffer
          // while the real chunk still sits unsent, which is exactly
          // what a 25s sync build then starves).
          dataDoneSent = true;
          await new Promise<void>((resolve) => {
            // Bounded flush (leg 6): the awaited callback is the
            // flush guarantee (below), but on a dead or half-open
            // socket it may NEVER fire — the pre-fix handler parked
            // here forever, build gate open, request slot pinned.
            // Race it against the response closing and a
            // STREAM_WRITE_TIMEOUT_MS timer; on timeout the client is
            // marked gone and the response is torn down, and the tail
            // proceeds (guarded sends no-op; the gate settles in the
            // finally) instead of waiting on a corpse.
            if (clientGone || res.writableEnded || res.destroyed) {
              resolve();
              return;
            }
            let settled = false;
            const done = (): void => {
              if (settled) return;
              settled = true;
              clearTimeout(flushTimer);
              res.off('close', done);
              resolve();
            };
            const flushTimer = setTimeout(() => {
              clientGone = true;
              try {
                res.destroy();
              } catch {
                // Already gone.
              }
              done();
            }, streamWriteTimeout);
            flushTimer.unref?.();
            res.on('close', done);
            try {
              res.write(`${JSON.stringify({
                type: 'data-done',
                totalCells: outcome.exactTotalCells,
                progress: {
                  sheetsDone: totalSheets,
                  cellsDone: outcome.exactTotalCells,
                  totalSheets,
                  totalCells: outcome.exactTotalCells,
                },
                parseTimings: outcome.timings,
                elapsedMs: elapsed(),
              })}\n`, (err?: Error | null) => {
                if (err) {
                  clientGone = true;
                } else {
                  lastFlushAt = Date.now();
                }
                done();
              });
            } catch {
              clientGone = true;
              done();
            }
            // NB: no res.uncork() here — on Node 24 an uncork() against
            // the response's internally-managed cork state corrupts the
            // chunked framing and the NEXT chunk (the `built` event) is
            // silently lost to the client (verified by bisect probe:
            // with uncork the client receives everything up to
            // data-done and never sees built; without it, all chunks
            // arrive). The awaited write callback above is the flush
            // guarantee; uncork added nothing but the corruption.
          });
          // Yield one macrotask before the synchronous build: the write
          // callback resolves in a microtask chain, and starting a ~25s
          // sync build there would starve the loop's next I/O phase —
          // the flushed bytes must get their delivery turn first.
          await new Promise<void>((resolve) => setImmediate(resolve));
          let built: ReturnType<typeof buildFromData>;
          try {
            built = buildFromData(outcome.data, principal);
          } catch (e) {
            streamError = e;
            send({ type: 'error', error: e instanceof Error ? e.message : String(e), elapsedMs: elapsed() });
            res.end();
            return;
          }
          built.response.timings = {
            ...outcome.timings,
            buildMs: built.buildMs,
            mirrorMs: built.mirrorMs,
            streamMetaMs: metaMs,
            streamSheet1RowsMs: sheet1RowsMs,
            totalMs: elapsed(),
          };
          // Introduce the deployment session (ext. 1) — the built chunk
          // carries its id, like the classic /load response.
          const streamSessionId = isSessionId(body.sessionId) ? body.sessionId : newSessionId();
          // Direct save: retain the source bytes as the verbatim-copy base.
          state.sourceBytes = bytes.slice();
          await registerSession(streamSessionId, principal);
          bindLoadedSession(principal, accessClaims);
          broadcastSession({ kind: 'load', sessionId: streamSessionId });
          built.response.sessionId = streamSessionId;
          console.log(`[engine] /load/stream timings ${JSON.stringify(built.response.timings)}`);
          send({ type: 'built', response: built.response, elapsedMs: elapsed() });
          res.end();
          return;
        } catch (e) {
          streamError = new Error(
            `failed to parse xlsx: ${e instanceof Error ? e.message : String(e)}`,
          );
          send({
            type: 'error',
            error: (streamError as Error).message,
            elapsedMs: elapsed(),
          });
          res.end();
          return;
        } finally {
          clearInterval(streamWatchdog);
          // W20: settle the build gate on EVERY stream exit (built,
          // parse error, build error) so pended reads are released —
          // with the new workbook on success, with the error on failure.
          endLoadBuild(buildGate, streamError ?? undefined);
        }
      }

      // -- sheets: names only (cheap; the browser uses this on open instead
      //    of pulling a full snapshot for names — Phase 2). ----------------
      if (path === '/sheets' && method === 'GET') {
        // #104: sheet names are session data — a revoked principal
        // gets nothing, same rule as /read.
        if ((await currentRoleFor(principal, accessClaims)) === null) {
          return sendJson(res, 403, { ok: false, rejected: true, reason: 'no-access-grant' });
        }
        return sendJson(res, 200, { sheets: state.host.sheetNames() });
      }

      // -- language: formula-language switch (the host method has no
      //    engine command; the browser's switch must reach the server
      //    engine, and its formula-text refresh uses batched reads). ----
      if (path === '/language' && method === 'POST') {
        // Role gate exactly as /ops: the token's role wins; proxy-mode
        // callers fall back to the participant record. (F-9)
        const role = await currentRoleFor(principal, accessClaims);
        if (role !== 'editor') {
          return sendJson(res, 403, {
            ok: false,
            rejected: true,
            reason: role === 'viewer' ? 'viewer-role' : 'no-access-grant',
          });
        }
        const body = (await readBody(req)) as { locale?: string } | undefined;
        if (typeof body?.locale !== 'string' || body.locale.length === 0) {
          return sendError(res, 400, '{ locale: string } required');
        }
        try {
          state.host.setFormulaLanguage(body.locale as never);
        } catch (e) {
          return sendError(res, 400, `bad locale: ${e instanceof Error ? e.message : String(e)}`);
        }
        return sendJson(res, 200, { ok: true });
      }

      // -- download: server-side serialization (defect 2c + closure) -------
      // The workbook is serialized HERE, from the live server workbook,
      // through the same path the in-tab save used (permission-filtered
      // snapshot → WorkbookData → the save format's adapter) — the browser
      // receives only the finished bytes as a streamed response and never
      // materializes a workbook-sized object. Downloads respect
      // permissions (workbook-protection §6): the snapshot is filtered
      // for the requesting principal, so cells the principal cannot read
      // are dropped, never leaked. Formats: every web save format
      // (xlsx/xlsb/csv/tsv/ods/html). Scopes: whole workbook (default) or
      // one named range (client-resolved def; see the header).
      if (path === '/download' && (method === 'GET' || method === 'POST')) {
        // Issue #51: a principal with no current grant gets nothing —
        // not even the permission-filtered serialization.
        if ((await currentRoleFor(principal, accessClaims)) === null) {
          return sendJson(res, 403, { ok: false, rejected: true, reason: 'no-access-grant' });
        }
        let extras: SaveExtras = {};
        if (method === 'POST') {
          const body = (await readBody(req, DOWNLOAD_MAX_BODY_BYTES)) as SaveExtras | undefined;
          if (body && typeof body === 'object') extras = body;
        }
        if (extras.format !== undefined && !isServerSaveFormat(extras.format)) {
          return sendError(
            res,
            400,
            `only formats ${Object.keys(SERVER_SAVE_FORMATS).join('/')} are supported for server download`,
          );
        }
        const format: ServerSaveFormat = isServerSaveFormat(extras.format) ? extras.format : 'xlsx';
        // SAVE/DOWNLOAD SEPARATION (user directive, 2026-10-21): a
        // whole-workbook .xlsx /download is a SAVE FIRST — the full
        // Excel sequence (recalc settled → direct streaming serialize
        // to temp → verify) — whose result is COMMITTED into the
        // library store as a fresh per-download entry (`dl_…`, owned
        // by the requesting principal; the serialized bytes are that
        // principal's permission-filtered view, exactly as before).
        // This route then returns JSON METADATA ONLY — no workbook
        // bytes ever ride this response. The client fetches the bytes
        // afterwards, directly from this service, via a gateway-signed
        // URL for GET /storage/:entryId (see the client contract in
        // hidden_files/direct-save-pass/worker-b-gateway.md). The mode
        // stays visible on every save via the response's `mode` field
        // + the log line — never silent. Named-range subsets and the
        // non-xlsx formats stay on the proxied byte path below (the
        // separation applies to the whole-workbook xlsx save class).
        if (format === 'xlsx' && extras.scope !== 'namedRange') {
          if (extras.scope !== undefined && extras.scope !== 'workbook') {
            return sendError(res, 400, "scope must be 'workbook' or 'namedRange'");
          }
          const tStart = performance.now();
          // AutoSave model: the download's save-first step is the same
          // flush as a save click (usually a no-op — the scheduler has
          // already checkpointed the batch), and the entry returned
          // for the signed-URL fetch is the SESSION'S STORED ENTRY
          // (autosave_<sessionId>). Applies when the caller is the
          // session's own principal (single-author) and the workbook
          // carries no cell-hiding ranges (face e: a filtered view
          // never comes from the owner-view stored copy — those, and
          // session-less calls, use the per-principal `dl_` path
          // below, exactly as Addendum 2 specified).
          if (!sessionHasHiddenRanges()) {
            let flushed: Awaited<ReturnType<typeof flushSessionSave>> = null;
            try {
              flushed = await flushSessionSave(extras, principal);
            } catch (e) {
              return sendError(
                res,
                500,
                `download serialization failed: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
            if (flushed) {
              // A requested filename renames the stored entry
              // (metadata-only; no re-serialization) so the signed-URL
              // fetch serves it under the name the user asked for.
              let entry = flushed.entry;
              if (extras.filename !== undefined) {
                const want = downloadFilenameForFormat(extras.filename, format);
                if (want !== entry.name) {
                  const dir = libraryDir();
                  const index = readLibraryIndex(dir);
                  const rec = index.entries.find(
                    (e) => e.principal === principal && e.id === entry.id,
                  );
                  if (rec) {
                    rec.name = want;
                    writeLibraryIndex(dir, index);
                    entry = { ...entry, name: want };
                  }
                }
              }
              const totalMs = Math.round(performance.now() - tStart);
              console.log(
                `[engine] /download format=xlsx scope=workbook autosave-entry mode=${flushed.mode ?? 'verbatim'} skipped=${flushed.skipped} bytes=${entry.sizeBytes} serializeMs=${flushed.serializeMs} totalMs=${totalMs} revision=${flushed.storageRevision} entry=${flushed.entryId} principal=${principal}`,
              );
              return sendJson(res, 200, {
                ok: true,
                entryId: flushed.entryId,
                revision: flushed.storageRevision,
                bytes: entry.sizeBytes,
                mode: flushed.mode ?? 'verbatim',
                serializeMs: flushed.serializeMs,
                changedSheets: flushed.changedSheets,
                totalMs,
              });
            }
          }
          try {
            const { outPath, result, cleanup, pinnedRev } = await runDirectSave(extras, principal);
            try {
              const entryId = `dl_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
              const name = downloadFilenameForFormat(extras.filename, format);
              commitLibraryEntry(principal, entryId, name, outPath, result.bytes);
              const totalMs = Math.round(performance.now() - tStart);
              console.log(
                `[engine] /download format=xlsx scope=workbook direct mode=${result.mode} changedSheets=${result.changedSheets.length} verbatimParts=${result.verbatimParts} bytes=${result.bytes} serializeMs=${result.serializeMs} totalMs=${totalMs} revision=${pinnedRev} entry=${entryId} principal=${principal}`,
              );
              return sendJson(res, 200, {
                ok: true,
                entryId,
                revision: pinnedRev,
                bytes: result.bytes,
                mode: result.mode,
                serializeMs: result.serializeMs,
                totalMs,
              });
            } finally {
              cleanup();
            }
          } catch (e) {
            return sendError(
              res,
              500,
              `download serialization failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
        const built = buildSaveWorkbookData(extras, principal);
        if (!built.ok) return sendError(res, built.status, built.error);
        const tStart = performance.now();
        let bytes: Uint8Array;
        try {
          bytes = SERVER_SAVE_FORMATS[format].make().write(built.wbData);
        } catch (e) {
          return sendError(res, 500, `download serialization failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        const cellCount = built.wbData.sheets.reduce(
          (n, sh) => n + sh.rows.reduce((m, r) => m + r.filter((c) => c !== null && c !== undefined).length, 0),
          0,
        );
        console.log(
          `[engine] /download format=${format} scope=${extras.scope === 'namedRange' ? 'namedRange' : 'workbook'} cells=${cellCount} bytes=${bytes.length} ms=${Math.round(performance.now() - tStart)} principal=${principal}`,
        );
        applyCors(res);
        res.writeHead(200, {
          'content-type': SERVER_SAVE_FORMATS[format].mime,
          'content-disposition': `attachment; filename="${downloadFilenameForFormat(extras.filename, format)}"`,
          'content-length': String(bytes.length),
          'cache-control': 'no-store',
        });
        // Chunked writes: the response streams out in slices instead of
        // one monolithic end() buffer push (the gateway pipes it through
        // to the browser the same way).
        const CHUNK = 256 * 1024;
        for (let off = 0; off < bytes.length; off += CHUNK) {
          res.write(Buffer.from(bytes.subarray(off, Math.min(off + CHUNK, bytes.length))));
        }
        res.end();
        return;
      }

      // -- library-save: server-side serialize + store (no tab round-trip) -
      // Gateway-mode library save / autosave: the live workbook is
      // serialized to .xlsx here (the exact /download whole-workbook path)
      // and the bytes are stored in the principal's server library store.
      // The response carries only entry metadata — no workbook bytes ever
      // cross into (or back out of) the tab on this flow.
      if (path === '/library-save' && method === 'POST') {
        // Role gate exactly as /ops: the token's role wins; proxy-mode
        // callers fall back to the participant record. (F-9)
        const role = await currentRoleFor(principal, accessClaims);
        if (role !== 'editor') {
          return sendJson(res, 403, {
            ok: false,
            rejected: true,
            reason: role === 'viewer' ? 'viewer-role' : 'no-access-grant',
          });
        }
        const body = (await readBody(req, DOWNLOAD_MAX_BODY_BYTES)) as
          | (SaveExtras & { id?: unknown; name?: unknown })
          | undefined;
        const extras: SaveExtras = body && typeof body === 'object' ? body : {};
        if (extras.format !== undefined && extras.format !== 'xlsx') {
          return sendError(res, 400, "only format 'xlsx' is stored by library-save");
        }
        if (extras.scope !== undefined && extras.scope !== 'workbook') {
          return sendError(res, 400, 'library-save stores the whole workbook only');
        }
        const rawId = (body as { id?: unknown } | undefined)?.id;
        if (rawId !== undefined && !isLibraryId(rawId)) {
          return sendError(res, 400, 'id, when given, must match [A-Za-z0-9._-]{1,128}');
        }
        const id =
          rawId !== undefined
            ? (rawId as string)
            : `wb_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
        const nameRaw = (body as { name?: unknown } | undefined)?.name;
        const name =
          typeof nameRaw === 'string' && nameRaw.trim().length > 0 ? nameRaw.trim() : 'workbook.xlsx';
        // An id-carrying save binds the session to that entry: later
        // autosave checkpoints commit there too (see boundLibraryId).
        if (rawId !== undefined) {
          state.boundLibraryId = id;
          state.boundLibraryName = name;
        }
        // AutoSave flush confirmation (session path): the save click
        // flushes the pending batch into the session's stored copy —
        // or, when storage is already caught up, returns WITHOUT
        // serializing (skipped: true). An explicitly requested id/name
        // is additionally committed from the stored copy's file (a
        // file copy, never a second serialization).
        {
          let flushed: Awaited<ReturnType<typeof flushSessionSave>>;
          try {
            flushed = await flushSessionSave(extras, principal);
          } catch (e) {
            return sendError(
              res,
              500,
              `library-save serialization failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          if (flushed) {
            let entry = flushed.entry;
            if (entry.id !== id && (rawId !== undefined || nameRaw !== undefined)) {
              const dir = libraryDir();
              const storedFile = libraryFileFor(dir, principal, entry.id);
              entry = commitLibraryEntry(principal, id, name, storedFile, entry.sizeBytes);
            }
            console.log(
              `[engine] /library-save id=${entry.id} autosave-flush skipped=${flushed.skipped} flushedOps=${flushed.flushedOps} revision=${flushed.revision} storageRevision=${flushed.storageRevision} caughtUp=${flushed.caughtUp} principal=${principal}`,
            );
            return sendJson(res, 200, {
              ok: true,
              entry,
              revision: flushed.revision,
              storageRevision: flushed.storageRevision,
              caughtUp: flushed.caughtUp,
              flushedOps: flushed.flushedOps,
              skipped: flushed.skipped,
              changedSheets: flushed.changedSheets,
            });
          }
        }
        // SAVE = SIGNAL ONLY (save/download separation): the request
        // carries only session extras + entry id/name — never workbook
        // bytes — and the response is entry metadata only. The save
        // itself runs the full Excel sequence: runDirectSave settles
        // recalc, serializes the live model to a temp file and VERIFIES
        // it; commitLibraryEntry then performs the atomic commit
        // (copy → tmp in the library dir → rename over the entry file),
        // so a failed save leaves the stored bytes byte-identical.
        // `revision` in the response is the pinned revision the save
        // serialized — the client's proof of exactly which state the
        // stored file holds.
        const tStart = performance.now();
        try {
          const { outPath, result, cleanup, pinnedRev } = await runDirectSave(extras, principal);
          try {
            const entry = commitLibraryEntry(principal, id, name, outPath, result.bytes);
            console.log(
              `[engine] /library-save id=${id} direct mode=${result.mode} bytes=${result.bytes} revision=${pinnedRev} ms=${Math.round(performance.now() - tStart)} principal=${principal}`,
            );
            return sendJson(res, 200, { ok: true, entry, revision: pinnedRev });
          } finally {
            cleanup();
          }
        } catch (e) {
          return sendError(
            res,
            500,
            `library-save serialization failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      // -- library: list / fetch the principal's server-stored workbooks ---
      if (path === '/library' && method === 'GET') {
        const index = readLibraryIndex(libraryDir());
        const entries = index.entries
          // AutoSave sync entries (autosave_<sessionId>) are the
          // session's internal stored copy — fetched via /storage or
          // /library/:id, never listed as user library items.
          .filter((e) => e.principal === principal && !e.id.startsWith('autosave_'))
          .map(({ principal: _p, ...rest }) => rest as ServerLibraryEntry)
          .sort((a, b) => b.modifiedAt - a.modifiedAt);
        return sendJson(res, 200, { entries });
      }
      if (path.startsWith('/library/') && method === 'GET') {
        const id = decodeURIComponent(path.slice('/library/'.length));
        if (!isLibraryId(id)) return sendError(res, 400, 'bad library id');
        const dir = libraryDir();
        const index = readLibraryIndex(dir);
        const entry = index.entries.find((e) => e.principal === principal && e.id === id);
        if (!entry) return sendError(res, 404, `no library entry: ${id}`);
        let bytes: Buffer;
        try {
          bytes = readFileSync(libraryFileFor(dir, principal, id));
        } catch {
          return sendError(res, 404, `library bytes missing for: ${id}`);
        }
        applyCors(res);
        res.writeHead(200, {
          'content-type': SERVER_SAVE_FORMATS.xlsx.mime,
          'content-disposition': `attachment; filename="${downloadFilename(entry.name)}"`,
          'content-length': String(bytes.length),
          'cache-control': 'no-store',
        });
        const CHUNK = 256 * 1024;
        for (let off = 0; off < bytes.length; off += CHUNK) {
          res.write(bytes.subarray(off, Math.min(off + CHUNK, bytes.length)));
        }
        res.end();
        return;
      }

      // -- reset: blank workbook --------------------------------------------
      if (path === '/reset' && method === 'POST') {
        // Role gate exactly as /ops: the token's role wins; proxy-mode
        // callers fall back to the participant record. (F-9)
        const role = await currentRoleFor(principal, accessClaims);
        if (role !== 'editor') {
          return sendJson(res, 403, {
            ok: false,
            rejected: true,
            reason: role === 'viewer' ? 'viewer-role' : 'no-access-grant',
          });
        }
        clearRegistrations();
        wireFresh();
        // W20: a reset is a fresh start — a previous load's failed
        // build must not keep failing reads against the blank workbook.
        lastBuildError = null;
        state.sourceMetadata = {};
        state.sourceDefinedNames = undefined;
        state.sourceSheetDims = new Map();
        state.sourceSheetTables = new Map();
        state.olapModel = null;
        state.sourceSheetFormats = new Map();
        state.sourceSheetStyles = new Map();
        // Direct save: a blank workbook has no source bytes; every part
        // of a save is synthesized from the live model.
        state.sourceBytes = null;
        // A reset starts a NEW deployment session for the blank
        // workbook: in signed mode it adopts the token's session (the
        // client obtained the token for exactly this), otherwise a
        // fresh id is minted and returned.
        const resetSessionId = accessClaims ? accessClaims.sid : newSessionId();
        await registerSession(resetSessionId, principal);
        bindLoadedSession(principal, accessClaims);
        broadcastSession({ kind: 'reset', sessionId: resetSessionId });
        return sendJson(res, 200, { ok: true, sessionId: resetSessionId });
      }

      // -- protection (testing hooks) ----------------------------------------
      if (path === '/protection/hide' && method === 'POST') {
        // Role gate exactly as /ops: the token's role wins; proxy-mode
        // callers fall back to the participant record. (F-9)
        const role = await currentRoleFor(principal, accessClaims);
        if (role !== 'editor') {
          return sendJson(res, 403, {
            ok: false,
            rejected: true,
            reason: role === 'viewer' ? 'viewer-role' : 'no-access-grant',
          });
        }
        const body = (await readBody(req)) as { sheet?: string; ranges?: string[] } | undefined;
        if (typeof body?.sheet !== 'string' || !Array.isArray(body?.ranges)) {
          return sendError(res, 400, '{ sheet: string, ranges: string[] } required');
        }
        state.protection.hideRanges(body.sheet, body.ranges, { principal });
        // Hiding changed outside execute(): cached hidden-taint results in
        // the host are stale from this moment and must be dropped.
        state.host.clearHiddenTaintCache();
        return sendJson(res, 200, { ok: true });
      }
      if (path === '/protection/protect' && method === 'POST') {
        // Role gate exactly as /ops: the token's role wins; proxy-mode
        // callers fall back to the participant record. (F-9)
        const role = await currentRoleFor(principal, accessClaims);
        if (role !== 'editor') {
          return sendJson(res, 403, {
            ok: false,
            rejected: true,
            reason: role === 'viewer' ? 'viewer-role' : 'no-access-grant',
          });
        }
        const body = (await readBody(req)) as
          | { sheet?: string; lockedRanges?: string[]; unlockedRanges?: string[] }
          | undefined;
        if (typeof body?.sheet !== 'string') {
          return sendError(res, 400, '{ sheet: string } required');
        }
        state.protection.protectSheet(body.sheet, undefined, {}, { principal });
        if (body.lockedRanges !== undefined || body.unlockedRanges !== undefined) {
          state.protection.setLockedRanges(body.sheet, body.lockedRanges ?? [], body.unlockedRanges ?? []);
        }
        return sendJson(res, 200, { ok: true });
      }

      return sendError(res, 404, `not found: ${path}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Item H: this catch is the service's 500 path for EVERY route —
      // it used to send the error without logging anything, so a 500
      // in a client's network log had no counterpart in the engine log
      // (the round-trip audit's /read 500s were undiagnosable from the
      // service side). Always log method + path + message here.
      console.log(`[engine] request failed ${method} ${path}: ${msg}`);
      return sendError(res, 500, `engine error: ${msg}`);
    }
  };
}

function isCellRef(x: unknown): x is CellRef {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return typeof r.sheet === 'string' && Number.isInteger(r.row) && Number.isInteger(r.col);
}

function isRangeRef(x: unknown): x is RangeRef {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.sheet === 'string' &&
    Number.isInteger(r.startRow) &&
    Number.isInteger(r.startCol) &&
    Number.isInteger(r.endRow) &&
    Number.isInteger(r.endCol)
  );
}
