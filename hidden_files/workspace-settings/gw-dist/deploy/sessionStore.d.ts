/**
 * Session registry + op journal + snapshot store
 * (design-docs/deployment-architecture.md, Engine extensions 1–3).
 *
 * The engine is STATEFUL by necessity; these three seams are its
 * durable backing:
 *
 *   SessionRegistry — session → { instanceId, revision, status, … }.
 *     Written at build (register), updated as the revision advances,
 *     and on release (checkpoint + evict). In production this is
 *     Firestore; subsequent requests for a session route to the
 *     holding instance via this record.
 *   OpJournal — SEGMENTED (user's billing constraint, 2026-10-20):
 *     production Firestore runs on FREE quotas (1 GiB stored, 50k
 *     reads/day, 20k WRITES/day, 10 GiB/mo egress), so one write per
 *     edit op would blow the daily write quota in a single active
 *     session. The engine therefore BUFFERS executed ops in memory
 *     (with their revision sequence) and persists ONE write per
 *     SEGMENT — a batch of ops keyed by session + base revision + last
 *     revision — flushed at checkpoint triggers (idle release,
 *     tab-close release, periodic cadence) or when the buffer reaches
 *     JOURNAL_SEGMENT_MAX_OPS. The SAME segment model applies in the
 *     local adapter (one file per segment), so local and production
 *     semantics are identical. Replay reads segments in order.
 *     DURABILITY WINDOW (honest): ops since the last segment flush are
 *     memory-only — a crash loses at most that tail (bounded by the
 *     segment cap). Rehydrate FAILS CLOSED on a torn journal: if the
 *     replayed head revision is behind the registry's recorded
 *     revision, the journal was torn and the session is NOT unlocked.
 *   SnapshotStore — full workbook snapshots (XLSX bytes, encrypted at
 *     rest in production via Cloud Storage) + the checksum of the
 *     workbook state at the snapshot revision. Written on checkpoint
 *     (idle release, tab-close release, periodic cadence); the journal
 *     is then truncated to the snapshot revision.
 *
 * PROVIDER CONFIG: SESSION_STORE=local|prod (default local).
 *   local — filesystem-backed under SESSION_DATA_DIR (default
 *     <gateway data dir>/sessions), following the engine service's W2
 *     library-store pattern (index JSON + one file per blob, atomic
 *     tmp+rename writes). FULLY REAL — this is what local validation
 *     runs against.
 *   prod — Firestore registry/journal + Cloud Storage snapshots, via
 *     the official @google-cloud/firestore / @google-cloud/storage
 *     client libraries. Construction reads env config
 *     (GCP_PROJECT_ID / FIRESTORE_DATABASE_ID / SESSION_SNAPSHOT_BUCKET)
 *     and a startup self-check FAILS CLOSED with a clear message when
 *     the libraries or credentials are absent — it never silently
 *     falls back to local storage in production mode.
 *
 * The prod adapters are written against narrow structural client
 * interfaces (FirestoreLike / StorageLike below) so they are fully
 * unit-testable with in-memory fakes; the real clients are loaded by
 * dynamic import only when the prod provider is selected.
 */
export type SessionStatus = 'active' | 'released';
export interface SessionRecord {
    sessionId: string;
    /** The engine instance holding (or last holding) the session. */
    instanceId: string;
    /** The owning principal ('user:<id>'). */
    principal: string;
    status: SessionStatus;
    /** Last assigned workbook revision (monotonic per session). */
    revision: number;
    /** Checksum of the workbook state at the latest snapshot revision. */
    snapshotChecksum?: string;
    snapshotRevision?: number;
    /** Why the session was last released ('idle', 'tab-close', 'idle-sweeper', …). */
    releaseReason?: string;
    createdAt: number;
    updatedAt: number;
    lastActivityAt: number;
}
export interface SessionRegistry {
    register(rec: SessionRecord): Promise<void>;
    lookup(sessionId: string): Promise<SessionRecord | null>;
    update(sessionId: string, patch: Partial<SessionRecord>): Promise<void>;
    release(sessionId: string): Promise<void>;
}
export interface JournalEntry {
    revision: number;
    /** The executed engine command (JSON-serializable EngineCommand). */
    op: unknown;
    at: number;
    /**
     * Phase 2 (co-authoring): the revision's delta cells (changed inputs
     * + recalculated values, UNFILTERED — permission filtering happens
     * per recipient at serve/broadcast time), persisted with the entry
     * so GET /revisions catch-up can be served from the journal.
     * Optional: pre-Phase-2 entries carry neither field.
     */
    delta?: Array<{
        sheet: string;
        row: number;
        col: number;
        value: unknown;
        formula?: string;
    }>;
    /** Phase 2: who originated the op ({ clientId, clientSeq, principal }). */
    origin?: {
        clientId: string | null;
        clientSeq: number | null;
        principal: string;
    };
}
/**
 * One persisted journal segment: the batch of ops with revisions in
 * (fromRevision, toRevision], in revision order. ONE store write per
 * segment — the Firestore free-quota constraint (see header).
 */
export interface JournalSegment {
    sessionId: string;
    /** Ops in this segment have revision > fromRevision. */
    fromRevision: number;
    /** The last (highest) op revision in this segment. */
    toRevision: number;
    ops: JournalEntry[];
    at: number;
}
export interface OpJournal {
    /** Persist one segment (a single write in every adapter). */
    appendSegment(segment: JournalSegment): Promise<void>;
    /**
     * Segments covering revisions past `fromRevision` (segment.toRevision
     * > fromRevision), ordered by fromRevision.
     */
    readSegments(sessionId: string, fromRevision: number): Promise<JournalSegment[]>;
    /** All journaled ops with revision > `revision`, in revision order. */
    readFrom(sessionId: string, revision: number): Promise<JournalEntry[]>;
    /** Highest journaled revision for the session (0 when none). */
    headRevision(sessionId: string): Promise<number>;
    /**
     * Drop WHOLE segments with toRevision <= `uptoRevision` (called at
     * checkpoint, after the snapshot at that revision is stored — the
     * flush-before-checkpoint order guarantees no segment straddles the
     * snapshot revision).
     */
    truncate(sessionId: string, uptoRevision: number): Promise<void>;
}
/** Flatten segments into the ordered op stream past `revision`. */
export declare function opsFromSegments(segments: JournalSegment[], revision: number): JournalEntry[];
export interface StoredSnapshot {
    bytes: Uint8Array;
    /** Checksum of the workbook state the bytes rebuild. */
    checksum: string;
    revision: number;
    at: number;
}
export interface SnapshotStore {
    put(sessionId: string, snap: StoredSnapshot): Promise<void>;
    get(sessionId: string): Promise<StoredSnapshot | null>;
}
export interface SessionStores {
    registry: SessionRegistry;
    journal: OpJournal;
    snapshots: SnapshotStore;
    provider: 'local' | 'memory' | 'prod';
}
export declare class LocalSessionStores implements SessionStores {
    private readonly dir;
    readonly provider: "local";
    readonly registry: SessionRegistry;
    readonly journal: OpJournal;
    readonly snapshots: SnapshotStore;
    constructor(dir: string);
}
export declare class MemorySessionStores implements SessionStores {
    readonly provider: "memory";
    private readonly records;
    private readonly journals;
    private readonly snaps;
    readonly registry: SessionRegistry;
    readonly journal: OpJournal;
    readonly snapshots: SnapshotStore;
}
/** The slice of the Firestore client the registry/journal use. */
export interface FirestoreDocLike {
    get(): Promise<{
        exists: boolean;
        data(): Record<string, unknown> | undefined;
    }>;
    set(data: Record<string, unknown>, opts?: {
        merge?: boolean;
    }): Promise<unknown>;
    delete(): Promise<unknown>;
}
export interface FirestoreLike {
    collection(name: string): {
        doc(id: string): FirestoreDocLike;
        /** Equality query (the journal reads a session's segment docs). */
        queryEq(field: string, value: string): Promise<Array<{
            id: string;
            data(): Record<string, unknown> | undefined;
        }>>;
        /**
         * Full-collection scan (the file registry's listing: the agent /
         * add-on session resolvers enumerate every ownership record and
         * filter in memory). Collections on this surface are small
         * metadata sets by design — never cell data.
         */
        listAll(): Promise<Array<{
            id: string;
            data(): Record<string, unknown> | undefined;
        }>>;
    };
}
/** The slice of the Cloud Storage client the snapshot store uses. */
export interface StorageFileLike {
    save(data: Buffer, opts?: Record<string, unknown>): Promise<unknown>;
    download(): Promise<[Buffer]>;
    getMetadata(): Promise<[{
        metadata?: Record<string, string>;
    }]>;
}
export interface StorageLike {
    bucket(name: string): {
        file(path: string): StorageFileLike;
    };
}
export declare class FirestoreSessionStores implements SessionStores {
    private readonly db;
    private readonly storage;
    private readonly bucketName;
    readonly provider: "prod";
    readonly registry: SessionRegistry;
    readonly journal: OpJournal;
    readonly snapshots: SnapshotStore;
    constructor(db: FirestoreLike, storage: StorageLike, bucketName: string);
}
export type SessionStoreProvider = 'local' | 'prod';
/** SESSION_STORE: 'local' (default, dev) | 'prod' (Firestore + GCS). */
export declare function sessionStoreProvider(env?: NodeJS.ProcessEnv): SessionStoreProvider;
/** SESSION_DATA_DIR for the local provider (default under the gateway data dir). */
export declare function sessionDataDir(env?: NodeJS.ProcessEnv): string;
export interface ProdSessionConfig {
    projectId: string;
    databaseId?: string;
    snapshotBucket: string;
}
/** Read the prod provider's env config; throws a clear error when incomplete. */
export declare function prodSessionConfig(env?: NodeJS.ProcessEnv): ProdSessionConfig;
/**
 * Dynamically load the official Google Cloud clients. Fails closed with
 * a clear, actionable message when the libraries are not installed or
 * no credentials are available — the prod provider must NEVER silently
 * degrade to local storage.
 */
export declare function loadProdClients(cfg: ProdSessionConfig): Promise<{
    db: FirestoreLike;
    storage: StorageLike;
}>;
/**
 * Adapt the real @google-cloud/firestore client to the narrow
 * FirestoreLike surface (its CollectionReference has where() instead of
 * queryEq, and its snapshots differ slightly in shape).
 */
export declare function wrapFirestore(raw: unknown): FirestoreLike;
/**
 * Build the session stores for the configured provider. For 'prod' the
 * config is validated synchronously (fail closed) and the clients load
 * lazily — callers that need the prod stores await `ready` first; the
 * engine service only enables session endpoints once construction is
 * resolved, and prod construction errors propagate as startup failures.
 */
export declare function createSessionStores(env?: NodeJS.ProcessEnv): Promise<SessionStores>;
/** Synchronous local/memory construction (tests + engine-service default). */
export declare function createLocalSessionStores(dir?: string): LocalSessionStores;
