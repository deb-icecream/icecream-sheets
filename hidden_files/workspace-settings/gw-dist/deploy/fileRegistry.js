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
 *     creatorPrincipal, participants? }
 *
 * `participants` (FIX-B residuals 3+4, 2026-10-22): an optional
 * principal → role map recorded by the gateway at /api/engine/open
 * JOIN time (see noteParticipant). It is ADVISORY data for the agent
 * session resolver (agentSessionResolver.ts): it lets a non-creator
 * participant's AI agent bind to the shared session with the SAME role
 * the participant joined with, so the engine's own role gate refuses a
 * viewer-participant's agent writes. It plays NO part in ownership:
 * claims replace the record wholesale (participants reset), heartbeats
 * and releases preserve it untouched.
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
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, } from 'node:fs';
import { join } from 'node:path';
import { sessionDataDir } from './sessionStore.js';
// ---------------------------------------------------------------------------
// Env config
// ---------------------------------------------------------------------------
/** OWNERSHIP_LEASE_MS: lease TTL for an ownership record. Default 30 s. */
export function ownershipLeaseMs(env = process.env) {
    const n = Number(env.OWNERSHIP_LEASE_MS ?? '30000');
    return Number.isFinite(n) && n >= 250 ? Math.floor(n) : 30_000;
}
/** OWNERSHIP_HEARTBEAT_MS: owner heartbeat cadence. Default lease/3. */
export function ownershipHeartbeatMs(env = process.env) {
    const n = Number(env.OWNERSHIP_HEARTBEAT_MS ?? '');
    if (Number.isFinite(n) && n >= 50)
        return Math.floor(n);
    return Math.max(50, Math.floor(ownershipLeaseMs(env) / 3));
}
/** FILE_REGISTRY_DIR: local adapter root (default under SESSION_DATA_DIR). */
export function fileRegistryDir(env = process.env) {
    const fromEnv = (env.FILE_REGISTRY_DIR ?? '').trim();
    return fromEnv !== '' ? fromEnv : join(sessionDataDir(env), 'file-registry');
}
/** FILE_REGISTRY_STORE: 'local' (default) | 'prod' (Firestore). */
export function fileRegistryProvider(env = process.env) {
    const v = (env.FILE_REGISTRY_STORE ?? '').trim().toLowerCase();
    if (v === 'prod' || v === 'firestore')
        return 'prod';
    if (v === 'local')
        return 'local';
    // Deployments running the prod session store get the prod registry
    // too — the registry must live in the same shared database (§9).
    return (env.SESSION_STORE ?? '').trim().toLowerCase() === 'prod' ? 'prod' : 'local';
}
/** A record is a LIVE owner when its lease has not expired. */
export function isLiveOwner(rec, nowMs = Date.now()) {
    return rec !== null && typeof rec.leaseExpiry === 'number' && rec.leaseExpiry > nowMs;
}
// ---------------------------------------------------------------------------
// Local (filesystem) adapter — cross-process lockfile mutex + atomic rename
// ---------------------------------------------------------------------------
const LOCK_SPIN_MS = 5;
const LOCK_TIMEOUT_MS = 10_000;
/** A lock older than this is treated as abandoned (holder crashed). */
const LOCK_STALE_MS = 30_000;
function sleepSync(ms) {
    // Synchronous spin-wait for the mutex: the critical sections below
    // are fully synchronous, so a blocked event loop here can only be
    // for the (tiny) duration of another holder's JSON rewrite.
    const buf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buf, 0, 0, ms);
}
export class LocalFileRegistry {
    dir;
    file;
    lockFile;
    leaseMs;
    constructor(dir, opts = {}) {
        this.dir = dir;
        mkdirSync(dir, { recursive: true });
        this.file = join(dir, 'file-registry.json');
        this.lockFile = join(dir, 'file-registry.lock');
        this.leaseMs = opts.leaseMs ?? ownershipLeaseMs();
    }
    /** Acquire the cross-process mutex; throws on timeout / IO error. */
    acquireLock() {
        const deadline = Date.now() + LOCK_TIMEOUT_MS;
        for (;;) {
            try {
                const fd = openSync(this.lockFile, 'wx');
                writeFileSync(fd, `${process.pid} ${Date.now()}`);
                closeSync(fd);
                return;
            }
            catch (e) {
                if (e?.code !== 'EEXIST')
                    throw e;
                // Stale-lock recovery: a holder that died mid-section must not
                // wedge the registry forever (fail-closed refers to IO errors
                // and ambiguous state, not to a provably abandoned lockfile).
                try {
                    const content = readFileSync(this.lockFile, 'utf8');
                    const ts = Number(content.trim().split(/\s+/)[1] ?? '0');
                    if (ts > 0 && Date.now() - ts > LOCK_STALE_MS) {
                        unlinkSync(this.lockFile);
                        continue;
                    }
                }
                catch {
                    // Lock vanished between checks — retry the create.
                    continue;
                }
                if (Date.now() > deadline) {
                    throw new Error(`file registry: lock timeout after ${LOCK_TIMEOUT_MS}ms (fail closed)`);
                }
                sleepSync(LOCK_SPIN_MS);
            }
        }
    }
    releaseLock() {
        try {
            unlinkSync(this.lockFile);
        }
        catch {
            // Already gone (stale-recovered by a peer); nothing to do.
        }
    }
    withLock(fn) {
        this.acquireLock();
        try {
            return fn();
        }
        finally {
            this.releaseLock();
        }
    }
    /** Read all records. A missing file is an empty registry; any other
     *  IO error or a corrupt file THROWS (fail closed). */
    readAll() {
        let text;
        try {
            text = readFileSync(this.file, 'utf8');
        }
        catch (e) {
            if (e?.code === 'ENOENT')
                return {};
            throw e;
        }
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('file registry: corrupt registry file (fail closed)');
        }
        return parsed;
    }
    writeAll(all) {
        const tmp = `${this.file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(all), 'utf8');
        renameSync(tmp, this.file);
    }
    async lookup(fileId) {
        return this.withLock(() => {
            const rec = this.readAll()[fileId];
            return rec ? { ...rec } : null;
        });
    }
    async listAll() {
        return this.withLock(() => Object.values(this.readAll()).map((rec) => ({ ...rec })));
    }
    async claim(record, expectedEpoch) {
        return this.withLock(() => {
            const all = this.readAll();
            const cur = all[record.fileId];
            if (expectedEpoch === null) {
                if (cur)
                    return false;
                if (record.ownershipEpoch !== 1)
                    return false;
            }
            else {
                if (!cur || cur.ownershipEpoch !== expectedEpoch)
                    return false;
                if (record.ownershipEpoch !== expectedEpoch + 1)
                    return false;
            }
            all[record.fileId] = { ...record, updatedAt: Date.now() };
            this.writeAll(all);
            return true;
        });
    }
    async heartbeat(fileId, sessionId, epoch, currentRevision, storedRevision) {
        return this.withLock(() => {
            const all = this.readAll();
            const cur = all[fileId];
            if (!cur || cur.sessionId !== sessionId || cur.ownershipEpoch !== epoch)
                return false;
            all[fileId] = {
                ...cur,
                leaseExpiry: Date.now() + this.leaseMs,
                currentRevision,
                storedRevision,
                updatedAt: Date.now(),
            };
            this.writeAll(all);
            return true;
        });
    }
    async release(fileId, sessionId, epoch) {
        return this.withLock(() => {
            const all = this.readAll();
            const cur = all[fileId];
            if (!cur || cur.sessionId !== sessionId || cur.ownershipEpoch !== epoch)
                return false;
            all[fileId] = { ...cur, leaseExpiry: 0, updatedAt: Date.now() };
            this.writeAll(all);
            return true;
        });
    }
    async noteParticipant(fileId, sessionId, epoch, principal, role) {
        return this.withLock(() => {
            const all = this.readAll();
            const cur = all[fileId];
            if (!cur || cur.sessionId !== sessionId || cur.ownershipEpoch !== epoch)
                return false;
            if (!(cur.leaseExpiry > Date.now()))
                return false; // dead lease: no live session to join
            all[fileId] = {
                ...cur,
                participants: { ...(cur.participants ?? {}), [principal]: role },
            };
            this.writeAll(all);
            return true;
        });
    }
}
// ---------------------------------------------------------------------------
// In-memory adapter — interface-level fake for unit tests.
// ---------------------------------------------------------------------------
export class MemoryFileRegistry {
    leaseMs;
    records = new Map();
    constructor(leaseMs = 30_000) {
        this.leaseMs = leaseMs;
    }
    async lookup(fileId) {
        const rec = this.records.get(fileId);
        return rec ? { ...rec } : null;
    }
    async listAll() {
        return [...this.records.values()].map((rec) => ({ ...rec }));
    }
    async claim(record, expectedEpoch) {
        const cur = this.records.get(record.fileId);
        if (expectedEpoch === null) {
            if (cur || record.ownershipEpoch !== 1)
                return false;
        }
        else {
            if (!cur || cur.ownershipEpoch !== expectedEpoch)
                return false;
            if (record.ownershipEpoch !== expectedEpoch + 1)
                return false;
        }
        this.records.set(record.fileId, { ...record, updatedAt: Date.now() });
        return true;
    }
    async heartbeat(fileId, sessionId, epoch, currentRevision, storedRevision) {
        const cur = this.records.get(fileId);
        if (!cur || cur.sessionId !== sessionId || cur.ownershipEpoch !== epoch)
            return false;
        this.records.set(fileId, {
            ...cur,
            leaseExpiry: Date.now() + this.leaseMs,
            currentRevision,
            storedRevision,
            updatedAt: Date.now(),
        });
        return true;
    }
    async release(fileId, sessionId, epoch) {
        const cur = this.records.get(fileId);
        if (!cur || cur.sessionId !== sessionId || cur.ownershipEpoch !== epoch)
            return false;
        this.records.set(fileId, { ...cur, leaseExpiry: 0, updatedAt: Date.now() });
        return true;
    }
    async noteParticipant(fileId, sessionId, epoch, principal, role) {
        const cur = this.records.get(fileId);
        if (!cur || cur.sessionId !== sessionId || cur.ownershipEpoch !== epoch)
            return false;
        if (!(cur.leaseExpiry > Date.now()))
            return false;
        this.records.set(fileId, {
            ...cur,
            participants: { ...(cur.participants ?? {}), [principal]: role },
        });
        return true;
    }
}
// ---------------------------------------------------------------------------
// Production adapter (Firestore) — structural interface, fail closed
// ---------------------------------------------------------------------------
const FILE_REGISTRY_COLLECTION = 'icecream_file_registry';
/**
 * Firestore-backed registry, written against the same narrow
 * FirestoreLike surface as sessionStore.ts so it unit-tests with
 * fakes. Claims read-then-CAS on ownershipEpoch inside one document
 * write cycle; on real Firestore the gateway/engine run one process
 * per file-owner region and the epoch check is the fencing guard —
 * a lost race observes the winner's epoch on its next read and the
 * claim returns false.
 */
export class FirestoreFileRegistry {
    db;
    leaseMs;
    constructor(db, leaseMs = 30_000) {
        this.db = db;
        this.leaseMs = leaseMs;
    }
    doc(fileId) {
        return this.db.collection(FILE_REGISTRY_COLLECTION).doc(fileId);
    }
    async lookup(fileId) {
        const snap = await this.doc(fileId).get();
        if (!snap.exists)
            return null;
        const data = snap.data();
        return data ? data : null;
    }
    async listAll() {
        const rows = await this.db.collection(FILE_REGISTRY_COLLECTION).listAll();
        const out = [];
        for (const row of rows) {
            const data = row.data();
            // A malformed document is skipped, never surfaced as a record:
            // the resolvers trust a listing the way they trust the registry
            // file, and a doc without the record's identity fields is not a
            // session anyone may bind to.
            if (data &&
                typeof data.fileId === 'string' &&
                typeof data.sessionId === 'string') {
                out.push({ ...data });
            }
        }
        return out;
    }
    async claim(record, expectedEpoch) {
        const cur = await this.lookup(record.fileId);
        if (expectedEpoch === null) {
            if (cur || record.ownershipEpoch !== 1)
                return false;
        }
        else {
            if (!cur || cur.ownershipEpoch !== expectedEpoch)
                return false;
            if (record.ownershipEpoch !== expectedEpoch + 1)
                return false;
        }
        await this.doc(record.fileId).set({ ...record, updatedAt: Date.now() });
        // Re-read: if a concurrent claim landed after ours with a higher
        // epoch, we lost — report false so the caller re-reads and JOINs.
        const after = await this.lookup(record.fileId);
        return (after !== null &&
            after.sessionId === record.sessionId &&
            after.ownershipEpoch === record.ownershipEpoch);
    }
    async heartbeat(fileId, sessionId, epoch, currentRevision, storedRevision) {
        const cur = await this.lookup(fileId);
        if (!cur || cur.sessionId !== sessionId || cur.ownershipEpoch !== epoch)
            return false;
        await this.doc(fileId).set({
            leaseExpiry: Date.now() + this.leaseMs,
            currentRevision,
            storedRevision,
            updatedAt: Date.now(),
        }, { merge: true });
        return true;
    }
    async release(fileId, sessionId, epoch) {
        const cur = await this.lookup(fileId);
        if (!cur || cur.sessionId !== sessionId || cur.ownershipEpoch !== epoch)
            return false;
        await this.doc(fileId).set({ leaseExpiry: 0, updatedAt: Date.now() }, { merge: true });
        return true;
    }
    async noteParticipant(fileId, sessionId, epoch, principal, role) {
        const cur = await this.lookup(fileId);
        if (!cur || cur.sessionId !== sessionId || cur.ownershipEpoch !== epoch)
            return false;
        if (!(cur.leaseExpiry > Date.now()))
            return false;
        // Read-modify-write of the advisory map: two simultaneous joiners
        // could race and one entry be lost — acceptable here (the loser
        // re-notes on their next open/reconnect, and the resolver falls
        // back safely); ownership data never travels this path.
        await this.doc(fileId).set({
            participants: { ...(cur.participants ?? {}), [principal]: role },
        }, { merge: true });
        return true;
    }
}
// ---------------------------------------------------------------------------
// Provider selection (fails closed in prod without credentials)
// ---------------------------------------------------------------------------
/**
 * Build the file registry for the configured provider. 'prod' REQUIRES
 * an injected Firestore client (mirroring how createSessionStores
 * loads the official clients in the engine bin): without one this
 * throws — the registry must never silently degrade to a per-process
 * store in production, because a store only one instance can see
 * cannot arbitrate anything (§9).
 */
export function createFileRegistry(env = process.env, opts = {}) {
    if (fileRegistryProvider(env) === 'prod') {
        if (!opts.firestoreDb) {
            throw new Error('file registry: FILE_REGISTRY_STORE=prod requires a Firestore client (credentials) — refusing to fall back to a local store (fail closed)');
        }
        return new FirestoreFileRegistry(opts.firestoreDb, opts.leaseMs ?? ownershipLeaseMs(env));
    }
    return new LocalFileRegistry(opts.dir ?? fileRegistryDir(env), {
        leaseMs: opts.leaseMs ?? ownershipLeaseMs(env),
    });
}
/** Synchronous local construction (tests + service defaults). */
export function createLocalFileRegistry(dir, leaseMs) {
    return new LocalFileRegistry(dir ?? fileRegistryDir(), leaseMs !== undefined ? { leaseMs } : {});
}
