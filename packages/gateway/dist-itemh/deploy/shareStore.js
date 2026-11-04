/**
 * App-share store (idea-app-gallery, user-confirmed share design
 * 2026-10-21): a share is an app PLUS a materialized snapshot of its
 * bound data (AppSharePackage, packages/service artifacts/gallery.ts).
 * The gateway stores the package opaquely per share link; recipients
 * (signed in) fetch it and materialize their OWN bound copies — the
 * owner's records are never mutated by a recipient.
 *
 * Adapter posture mirrors userStore.ts: local JSON file + lockfile
 * mutex + atomic writes for the local stack; memory adapter for tests;
 * the factory FAILS CLOSED in prod mode (SHARE_STORE=prod) — no
 * Firestore adapter exists yet, so prod construction throws rather
 * than silently falling back to local disk.
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, } from 'node:fs';
import { join } from 'node:path';
import { sessionDataDir } from './sessionStore.js';
export function shareSummary(rec) {
    const { pkg: _pkg, ...rest } = rec;
    return rest;
}
function buildRecord(input, now) {
    return {
        shareId: input.shareId,
        ownerPrincipal: input.ownerPrincipal,
        appName: input.pkg.app.name,
        sourceSheet: input.pkg.snapshot.sheet,
        rowCount: input.pkg.rowCount,
        colCount: input.pkg.colCount,
        createdAt: now,
        revokedAt: null,
        pkg: input.pkg,
    };
}
export class MemoryAppShareStore {
    records = new Map();
    async create(input) {
        const rec = buildRecord(input, Date.now());
        this.records.set(rec.shareId, rec);
        return { ...rec };
    }
    async get(shareId) {
        const rec = this.records.get(shareId);
        return rec ? { ...rec } : null;
    }
    async listByOwner(ownerPrincipal) {
        return [...this.records.values()]
            .filter((r) => r.ownerPrincipal === ownerPrincipal)
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((r) => ({ ...r }));
    }
    async revoke(shareId, ownerPrincipal) {
        const rec = this.records.get(shareId);
        if (!rec || rec.ownerPrincipal !== ownerPrincipal)
            return false;
        if (rec.revokedAt === null) {
            this.records.set(shareId, { ...rec, revokedAt: Date.now() });
        }
        return true;
    }
}
// ---------------------------------------------------------------------------
// Local JSON-file adapter (same lock/atomic posture as userStore.ts)
// ---------------------------------------------------------------------------
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const LOCK_SPIN_MS = 10;
function sleepSync(ms) {
    const buf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buf, 0, 0, ms);
}
function makeLock(lockFile) {
    function acquireLock() {
        const deadline = Date.now() + LOCK_TIMEOUT_MS;
        for (;;) {
            try {
                const fd = openSync(lockFile, 'wx');
                writeFileSync(fd, `${process.pid} ${Date.now()}`);
                closeSync(fd);
                return;
            }
            catch (e) {
                if (e?.code !== 'EEXIST')
                    throw e;
                try {
                    const content = readFileSync(lockFile, 'utf8');
                    const ts = Number(content.trim().split(/\s+/)[1] ?? '0');
                    if (ts > 0 && Date.now() - ts > LOCK_STALE_MS) {
                        unlinkSync(lockFile);
                        continue;
                    }
                }
                catch {
                    continue;
                }
                if (Date.now() > deadline) {
                    throw new Error(`share store: lock timeout after ${LOCK_TIMEOUT_MS}ms (fail closed)`);
                }
                sleepSync(LOCK_SPIN_MS);
            }
        }
    }
    return {
        withLock(fn) {
            acquireLock();
            try {
                return fn();
            }
            finally {
                try {
                    unlinkSync(lockFile);
                }
                catch {
                    // Already gone (stale-recovered by a peer).
                }
            }
        },
    };
}
export class LocalAppShareStore {
    file;
    lock;
    constructor(dir) {
        mkdirSync(dir, { recursive: true });
        this.file = join(dir, 'app-shares.json');
        this.lock = makeLock(join(dir, 'app-shares.lock'));
    }
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
            throw new Error('share store: corrupt store file (fail closed)');
        }
        return parsed;
    }
    writeAll(all) {
        const tmp = `${this.file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(all), 'utf8');
        renameSync(tmp, this.file);
    }
    async create(input) {
        return this.lock.withLock(() => {
            const all = this.readAll();
            const rec = buildRecord(input, Date.now());
            all[rec.shareId] = rec;
            this.writeAll(all);
            return { ...rec };
        });
    }
    async get(shareId) {
        const rec = this.readAll()[shareId];
        return rec ? { ...rec } : null;
    }
    async listByOwner(ownerPrincipal) {
        return Object.values(this.readAll())
            .filter((r) => r.ownerPrincipal === ownerPrincipal)
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((r) => ({ ...r }));
    }
    async revoke(shareId, ownerPrincipal) {
        return this.lock.withLock(() => {
            const all = this.readAll();
            const rec = all[shareId];
            if (!rec || rec.ownerPrincipal !== ownerPrincipal)
                return false;
            if (rec.revokedAt === null) {
                all[shareId] = { ...rec, revokedAt: Date.now() };
                this.writeAll(all);
            }
            return true;
        });
    }
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function shareStoreProvider(env = process.env) {
    return env['SHARE_STORE'] === 'prod' ? 'prod' : 'local';
}
export function shareStoreDir(env = process.env) {
    return env['SHARE_STORE_DIR'] ?? join(sessionDataDir(env), 'app-shares');
}
/**
 * Construct the share store from env. FAILS CLOSED in prod mode: no
 * durable prod adapter exists yet, and a share store must never
 * silently land on local disk in production.
 */
export function createAppShareStore(env = process.env) {
    if (shareStoreProvider(env) === 'prod') {
        throw new Error('share store: SHARE_STORE=prod has no adapter yet (fail closed)');
    }
    return new LocalAppShareStore(shareStoreDir(env));
}
