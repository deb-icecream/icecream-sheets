/**
 * Session ownership registry (design-docs/revision-model-save-and-
 * coauthoring.md §9) — Phase 2.
 *
 * INVARIANT: at any moment a workbook file has AT MOST ONE live
 * authoritative model, owned by exactly one engine instance. This
 * registry is the arbiter BETWEEN instances: one metadata record per
 * file, claims/transfers are compare-and-set transactions on the
 * record, heartbeats refresh the lease, and every transfer increments
 * `ownershipEpoch` — the fencing token. Lease timestamps only gate
 * WHEN a takeover may be attempted; authorization to own comes from
 * the CAS transaction + epoch, which clocks cannot forge.
 *
 * Record (metadata only — never cell data, never journal contents):
 *   { fileId, sessionId, ownerInstance, ownerEndpoint, leaseExpiry,
 *     ownershipEpoch, currentRevision, storedRevision, updatedAt,
 *     creatorPrincipal }
 *
 * Providers (mirroring sessionStore.ts posture):
 *   local — JSON file under FILE_REGISTRY_DIR (default
 *     <SESSION_DATA_DIR>/file-registry), guarded by a cross-process
 *     lockfile mutex (wx-spin) so two processes cannot interleave a
 *     read-modify-write; writes are atomic tmp+rename. Any IO error
 *     THROWS — callers fail closed (refuse the open) rather than risk
 *     a second copy.
 *   prod — Firestore-shaped structural adapter (same narrow
 *     FirestoreLike surface as sessionStore.ts). Construction via
 *     createFileRegistry() FAILS CLOSED in prod mode without an
 *     injected Firestore client / credentials — there is NO silent
 *     local fallback in prod mode.
 */
import { type FirestoreLike } from './sessionStore.js';
export interface FileRegistryRecord {
    fileId: string;
    sessionId: string;
    ownerInstance: string;
    ownerEndpoint: string;
    /** Unix ms; readers treat an expired lease as claimable. */
    leaseExpiry: number;
    /** Fencing token: incremented inside every successful claim. */
    ownershipEpoch: number;
    currentRevision: number;
    storedRevision: number;
    updatedAt: number;
    creatorPrincipal: string;
}
export interface FileRegistry {
    /** The record for a file, or null when the file was never claimed. */
    lookup(fileId: string): Promise<FileRegistryRecord | null>;
    /**
     * Compare-and-set claim: succeeds only when the stored record's
     * epoch equals `expectedEpoch` (null = no record may exist). The
     * caller supplies the full new record with
     * ownershipEpoch = (expectedEpoch ?? 0) + 1. Returns true when this
     * claim won; exactly one concurrent claimant can win.
     */
    claim(record: FileRegistryRecord, expectedEpoch: number | null): Promise<boolean>;
    /**
     * Refresh the lease + revision counters for the CURRENT owner.
     * Returns false when the caller is fenced: the stored epoch (or
     * session) no longer matches — a higher epoch owns the file now.
     */
    heartbeat(fileId: string, sessionId: string, epoch: number, currentRevision: number, storedRevision: number): Promise<boolean>;
    /**
     * Clear the lease (session released / evicted). The record survives
     * with its epoch so the next claim CASes against it. Returns false
     * when the caller does not hold the current epoch/session.
     */
    release(fileId: string, sessionId: string, epoch: number): Promise<boolean>;
}
/** OWNERSHIP_LEASE_MS: lease TTL for an ownership record. Default 30 s. */
export declare function ownershipLeaseMs(env?: NodeJS.ProcessEnv): number;
/** OWNERSHIP_HEARTBEAT_MS: owner heartbeat cadence. Default lease/3. */
export declare function ownershipHeartbeatMs(env?: NodeJS.ProcessEnv): number;
/** FILE_REGISTRY_DIR: local adapter root (default under SESSION_DATA_DIR). */
export declare function fileRegistryDir(env?: NodeJS.ProcessEnv): string;
/** FILE_REGISTRY_STORE: 'local' (default) | 'prod' (Firestore). */
export declare function fileRegistryProvider(env?: NodeJS.ProcessEnv): 'local' | 'prod';
/** A record is a LIVE owner when its lease has not expired. */
export declare function isLiveOwner(rec: FileRegistryRecord | null, nowMs?: number): boolean;
export declare class LocalFileRegistry implements FileRegistry {
    private readonly dir;
    private readonly file;
    private readonly lockFile;
    private readonly leaseMs;
    constructor(dir: string, opts?: {
        leaseMs?: number;
    });
    /** Acquire the cross-process mutex; throws on timeout / IO error. */
    private acquireLock;
    private releaseLock;
    private withLock;
    /** Read all records. A missing file is an empty registry; any other
     *  IO error or a corrupt file THROWS (fail closed). */
    private readAll;
    private writeAll;
    lookup(fileId: string): Promise<FileRegistryRecord | null>;
    claim(record: FileRegistryRecord, expectedEpoch: number | null): Promise<boolean>;
    heartbeat(fileId: string, sessionId: string, epoch: number, currentRevision: number, storedRevision: number): Promise<boolean>;
    release(fileId: string, sessionId: string, epoch: number): Promise<boolean>;
}
export declare class MemoryFileRegistry implements FileRegistry {
    private readonly leaseMs;
    private readonly records;
    constructor(leaseMs?: number);
    lookup(fileId: string): Promise<FileRegistryRecord | null>;
    claim(record: FileRegistryRecord, expectedEpoch: number | null): Promise<boolean>;
    heartbeat(fileId: string, sessionId: string, epoch: number, currentRevision: number, storedRevision: number): Promise<boolean>;
    release(fileId: string, sessionId: string, epoch: number): Promise<boolean>;
}
/**
 * Firestore-backed registry, written against the same narrow
 * FirestoreLike surface as sessionStore.ts so it unit-tests with
 * fakes. Claims read-then-CAS on ownershipEpoch inside one document
 * write cycle; on real Firestore the gateway/engine run one process
 * per file-owner region and the epoch check is the fencing guard —
 * a lost race observes the winner's epoch on its next read and the
 * claim returns false.
 */
export declare class FirestoreFileRegistry implements FileRegistry {
    private readonly db;
    private readonly leaseMs;
    constructor(db: FirestoreLike, leaseMs?: number);
    private doc;
    lookup(fileId: string): Promise<FileRegistryRecord | null>;
    claim(record: FileRegistryRecord, expectedEpoch: number | null): Promise<boolean>;
    heartbeat(fileId: string, sessionId: string, epoch: number, currentRevision: number, storedRevision: number): Promise<boolean>;
    release(fileId: string, sessionId: string, epoch: number): Promise<boolean>;
}
/**
 * Build the file registry for the configured provider. 'prod' REQUIRES
 * an injected Firestore client (mirroring how createSessionStores
 * loads the official clients in the engine bin): without one this
 * throws — the registry must never silently degrade to a per-process
 * store in production, because a store only one instance can see
 * cannot arbitrate anything (§9).
 */
export declare function createFileRegistry(env?: NodeJS.ProcessEnv, opts?: {
    firestoreDb?: FirestoreLike;
    dir?: string;
    leaseMs?: number;
}): FileRegistry;
/** Synchronous local construction (tests + service defaults). */
export declare function createLocalFileRegistry(dir?: string, leaseMs?: number): LocalFileRegistry;
