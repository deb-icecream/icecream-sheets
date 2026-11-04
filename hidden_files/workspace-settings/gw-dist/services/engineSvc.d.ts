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
import type { RequestListener, ServerResponse } from 'node:http';
import { type CellInput, type CellRef, type CollabOp, type DefinedName, type EngineCommand, type StorageAdapter, type TypedValue, type WorkbookData, type WorkbookSnapshot } from '@icecream-sheets/engine';
import { type FormatsWire } from '@icecream-sheets/xlsx-adapter';
import { type ChartSpec } from '@icecream-sheets/service';
import { type SessionStores } from '../deploy/sessionStore.js';
import { type FileRegistry } from '../deploy/fileRegistry.js';
/** The service's owner principal: exempt from cell hiding (face e). */
export declare const OWNER_PRINCIPAL = "user:owner";
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
}
/** Presence palette — identical to apps/web/src/collab.ts. */
export declare const PRESENCE_COLORS: string[];
/** Deterministic per-principal presence color (same hash as web collab.ts). */
export declare function presenceColorFor(principal: string): string;
/** Presence heartbeat TTL (§8 / engine CollabSession semantics): 30 s. */
export declare const PRESENCE_TTL_MS = 30000;
/** How long an ack keeps a client "attached" for retention (§1). */
export declare const ATTACHED_ACK_WINDOW_MS: number;
/** In-memory delta-log cap (older entries fall under retention rules). */
export declare const DELTA_LOG_CAP = 5000;
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
export declare function retentionPruneUpto(args: {
    storedRevision: number;
    minAppliedRev: number;
    checkpointRevision: number | null;
}): number;
/** True when one segment may be pruned under the §1 rule. */
export declare function segmentPrunable(segmentToRevision: number, args: {
    storedRevision: number;
    minAppliedRev: number;
    checkpointRevision: number | null;
}): boolean;
/**
 * Map an engine command to its CollabOp for OT rebase (§7). Only the
 * structural commands and cell set/clear have mappings; any other
 * command returns null (no transform applies — it is applied as-is).
 */
export declare function cmdToCollabOp(cmd: EngineCommand, clientId: string, baseRevision: number): CollabOp | null;
/** Map a (possibly rebased) CollabOp back to an engine command. */
export declare function collabOpToCmd(op: CollabOp): EngineCommand | null;
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
     * Product layer: reader for uploaded workbook objects, used by
     * POST /load/storage-ref. Production (bin/engine.ts, UPLOAD_STORE=prod)
     * injects a Cloud Storage reader and fails closed at startup when it
     * cannot be constructed; when omitted, /load/storage-ref reads the
     * local upload store dir (UPLOAD_STORE_DIR, default
     * <sessionDataDir>/uploads — the gateway upload store's default).
     * `bucket` names the configured upload bucket this reader serves
     * (the bucket a request may name; env UPLOAD_BUCKET wins when set).
     */
    uploadObjects?: {
        bucket: string;
        get(object: string): Promise<Uint8Array | null>;
    };
}
/**
 * Save-journal cap: beyond this many ops the save journal is dropped
 * (and the direct save forces every sheet changed — see
 * directSaveOps). There is NO per-save worker rebuild anymore (the
 * W21 design was retired by the Phase 1 direct-streaming save); the
 * cap bounds the memory of a journal that exists only to derive the
 * serializer's changed-sheet set / planning class from.
 */
export declare const SAVE_OPS_CAP = 200000;
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
export declare const SAVE_STRUCTURAL_CMDS: ReadonlySet<string>;
/** The save-journal slice of EngineState the helpers below operate on. */
export interface SaveJournalState {
    saveOps: Array<{
        op: EngineCommand;
    }>;
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
export declare function recordSaveJournalOp(journal: SaveJournalState, cmd: string, rawCmd: EngineCommand): void;
/**
 * Reset the save journal for a fresh base (load / reset / rehydrate):
 * the retained source bytes are the new replay base, so the journal
 * restarts from exactly the ops replayed on top of them (rehydrate)
 * or empty (fresh load). The structural summary is rebuilt from the
 * same ops.
 */
export declare function resetSaveJournal(journal: SaveJournalState, ops?: Array<{
    op: EngineCommand;
}>): void;
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
export declare function directSaveOps(journal: SaveJournalState, sheetNames: readonly string[]): Array<{
    cmd: string;
    ref?: CellRef;
}>;
/**
 * How long a /read may pend on an in-flight workbook build before the
 * wait itself fails (W20). Aligned with the engine routes' timeout
 * class: the gateway gives every /api/engine route a 600 s upstream
 * timeout (ENGINE_UPSTREAM_TIMEOUT_MS in gateway.ts, Item D) precisely
 * so a pended read is never cut short by the proxy; a build that has
 * not finished inside the load budget is a failed load by that same
 * budget, so the wait expiring is a real error.
 */
export declare const BUILD_WAIT_TIMEOUT_MS = 600000;
/**
 * Convert an engine WorkbookSnapshot (sparse cell list) into adapter
 * WorkbookData (dense row-major grids) — the exact conversion the web
 * client's save performs in-tab (apps/web/src/io.ts
 * snapshotToWorkbookData), executed here server-side for /download.
 */
export declare function snapshotToWorkbookData(snap: WorkbookSnapshot, extraMetadata?: Record<string, unknown>, definedNames?: DefinedName[]): WorkbookData;
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
export declare function mergeDefinedNames(...lists: Array<readonly DefinedName[] | undefined>): DefinedName[];
/**
 * Validate a client-supplied `sheetStyles` save extra (defect D4) into
 * per-sheet CellStyle records. Anything malformed is dropped entry by
 * entry — a corrupt style hint must never fail the save, and the XLSX
 * adapter's injector re-validates every field it consumes. Returns null
 * when the extra is absent or not an object at all (sheets then fall
 * back to the loaded file's own styles).
 */
export declare function sanitizeSheetStyles(raw: unknown): Record<string, Record<string, import('@icecream-sheets/engine').CellStyle>> | null;
/**
 * Derive an Excel-valid sheet name from a CSV file name: strip the
 * extension, replace every Excel-invalid sheet-name character
 * (`: \ / ? * [ ]`) with '_', trim, and cap at 31 characters.
 * Returns '' when nothing usable remains (callers fall back to
 * the CsvAdapter's default 'Sheet1').
 */
export declare function sheetNameFromCsvFileName(name: string): string;
/** Sanitize a requested download filename to a bare .xlsx name. */
export declare function downloadFilename(raw: unknown): string;
/** Every save format the web app offers (apps/web/src/adapters.ts SAVE_FORMATS). */
export type ServerSaveFormat = 'xlsx' | 'xlsb' | 'csv' | 'tsv' | 'ods' | 'html';
export declare const SERVER_SAVE_FORMATS: Record<ServerSaveFormat, {
    ext: string;
    mime: string;
    make: () => StorageAdapter;
}>;
export declare function isServerSaveFormat(x: unknown): x is ServerSaveFormat;
/** Sanitize a requested download filename to a bare name in `format`'s extension. */
export declare function downloadFilenameForFormat(raw: unknown, format: ServerSaveFormat): string;
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
export declare function isValidChartSpec(x: unknown): x is ChartSpec;
export declare function isServerNamedRangeRef(x: unknown): x is ServerNamedRangeRef;
export declare function namedRangeToWorkbookData(snap: WorkbookSnapshot, def: {
    name: string;
    ref: ServerNamedRangeRef;
}): WorkbookData;
export interface ServerLibraryEntry {
    id: string;
    name: string;
    owner: string;
    createdAt: number;
    modifiedAt: number;
    sizeBytes: number;
    backend: 'gateway';
}
export declare function isLibraryId(x: unknown): x is string;
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
    sheets: Array<{
        name: string;
        cells: MirrorCell[];
    }>;
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
export declare function createEngineListener(deps?: EngineServiceDeps): RequestListener;
