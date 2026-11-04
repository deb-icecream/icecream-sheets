/**
 * Built-app store (W4, hidden_files/wave-c-fixes/BRIEF.md): UI-built
 * apps (no-code app builder, AppSpec) persisted SERVER-SIDE, keyed by
 * owner principal + gateway file id, so an app built in one browser
 * profile is listed and runnable in any profile for the same user +
 * same file. Before W4 the builder wrote only to the creating
 * browser's localStorage (case-12 limitation in
 * hidden_files/agent-rerun/REPORT.md).
 *
 * This is the AppSpec counterpart of the generated-app persistence:
 * generated ArtifactSpecs persist server-side at generation time in
 * the agent service's file-backed artifact store, and shared copies
 * in deploy/shareStore.ts. AppSpec is a different shape (views /
 * actions / range binding, no React source), so it gets its own
 * store, following the shareStore adapter posture exactly:
 *   local — JSON file + lockfile mutex + atomic tmp+rename writes;
 *   memory — interface-level fake for unit tests;
 *   prod — Firestore-shaped structural adapter (collection
 *     `icecream_built_apps`). The factory FAILS CLOSED in prod mode
 *     without an injected Firestore client — never a silent local
 *     fallback.
 *
 * Ownership is part of the key on every operation: a record is only
 * ever visible to / mutable by its owner principal. The file binding
 * is the gateway fileId the app was built against (stamped on the
 * spec as `fileId`); listing by (owner, fileId) is the read path the
 * web client merges over its localStorage cache on file open.
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { sessionDataDir } from './sessionStore.js';
import { migrateAppSpec, validateAppSpec, } from '@icecream-sheets/service';
/** Migrate + validate an unknown value into the spec to store. */
export function normalizeBuiltAppSpec(raw, fileId) {
    let migrated;
    try {
        migrated = migrateAppSpec(raw);
    }
    catch (e) {
        throw new Error(`invalid app spec: ${e instanceof Error ? e.message : String(e)}`);
    }
    const spec = { ...migrated, fileId };
    const check = validateAppSpec(spec);
    if (!check.ok) {
        throw new Error(`invalid app spec: ${check.errors.join('; ')}`);
    }
    return check.spec;
}
function buildRecord(input, existing, now) {
    const spec = normalizeBuiltAppSpec(input.spec, input.fileId);
    return {
        appId: spec.id,
        ownerPrincipal: input.ownerPrincipal,
        fileId: input.fileId,
        spec,
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now,
    };
}
function keyOf(ownerPrincipal, fileId, appId) {
    return `${ownerPrincipal}${fileId}${appId}`;
}
export class MemoryBuiltAppStore {
    records = new Map();
    async upsert(input) {
        const rawId = input.spec?.id;
        const existing = typeof rawId === 'string'
            ? (this.records.get(keyOf(input.ownerPrincipal, input.fileId, rawId)) ??
                null)
            : null;
        const rec = buildRecord(input, existing, Date.now());
        this.records.set(keyOf(rec.ownerPrincipal, rec.fileId, rec.appId), rec);
        return { ...rec, spec: { ...rec.spec } };
    }
    async get(ownerPrincipal, fileId, appId) {
        const rec = this.records.get(keyOf(ownerPrincipal, fileId, appId));
        return rec ? { ...rec } : null;
    }
    async listByOwnerAndFile(ownerPrincipal, fileId) {
        return [...this.records.values()]
            .filter((r) => r.ownerPrincipal === ownerPrincipal && r.fileId === fileId)
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((r) => ({ ...r }));
    }
    async listByOwner(ownerPrincipal) {
        return [...this.records.values()]
            .filter((r) => r.ownerPrincipal === ownerPrincipal)
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((r) => ({ ...r }));
    }
    async remove(ownerPrincipal, fileId, appId) {
        return this.records.delete(keyOf(ownerPrincipal, fileId, appId));
    }
    async removeAllForOwner(ownerPrincipal) {
        let n = 0;
        for (const [k, r] of this.records) {
            if (r.ownerPrincipal === ownerPrincipal) {
                this.records.delete(k);
                n += 1;
            }
        }
        return n;
    }
}
// ---------------------------------------------------------------------------
// Local JSON-file adapter (same lock/atomic posture as shareStore.ts)
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
                    throw new Error(`built-app store: lock timeout after ${LOCK_TIMEOUT_MS}ms (fail closed)`);
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
export class LocalBuiltAppStore {
    file;
    lock;
    constructor(dir) {
        mkdirSync(dir, { recursive: true });
        this.file = join(dir, 'built-apps.json');
        this.lock = makeLock(join(dir, 'built-apps.lock'));
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
            throw new Error('built-app store: corrupt store file (fail closed)');
        }
        return parsed;
    }
    writeAll(all) {
        const tmp = `${this.file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(all), 'utf8');
        renameSync(tmp, this.file);
    }
    async upsert(input) {
        return this.lock.withLock(() => {
            const all = this.readAll();
            const rawId = input.spec?.id;
            const existing = typeof rawId === 'string'
                ? (all[keyOf(input.ownerPrincipal, input.fileId, rawId)] ?? null)
                : null;
            const rec = buildRecord(input, existing, Date.now());
            all[keyOf(rec.ownerPrincipal, rec.fileId, rec.appId)] = rec;
            this.writeAll(all);
            return { ...rec };
        });
    }
    async get(ownerPrincipal, fileId, appId) {
        const rec = this.readAll()[keyOf(ownerPrincipal, fileId, appId)];
        return rec ? { ...rec } : null;
    }
    async listByOwnerAndFile(ownerPrincipal, fileId) {
        return Object.values(this.readAll())
            .filter((r) => r.ownerPrincipal === ownerPrincipal && r.fileId === fileId)
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((r) => ({ ...r }));
    }
    async listByOwner(ownerPrincipal) {
        return Object.values(this.readAll())
            .filter((r) => r.ownerPrincipal === ownerPrincipal)
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((r) => ({ ...r }));
    }
    async remove(ownerPrincipal, fileId, appId) {
        return this.lock.withLock(() => {
            const all = this.readAll();
            const k = keyOf(ownerPrincipal, fileId, appId);
            if (!all[k])
                return false;
            delete all[k];
            this.writeAll(all);
            return true;
        });
    }
    async removeAllForOwner(ownerPrincipal) {
        return this.lock.withLock(() => {
            const all = this.readAll();
            let n = 0;
            for (const [k, r] of Object.entries(all)) {
                if (r.ownerPrincipal === ownerPrincipal) {
                    delete all[k];
                    n += 1;
                }
            }
            if (n > 0)
                this.writeAll(all);
            return n;
        });
    }
}
// ---------------------------------------------------------------------------
// Firestore adapter (prod) — shareStore.ts pattern: narrow structural
// client (FirestoreLike from sessionStore.ts), one document per app in
// `icecream_built_apps`, document id = sha256 hex of the composite
// key. A record over the 1 MiB document cap is REJECTED LOUDLY —
// never silently truncated.
// ---------------------------------------------------------------------------
export const BUILT_APPS_COLLECTION = 'icecream_built_apps';
export const BUILT_APP_DOC_CAP_BYTES = 1048576;
export function builtAppDocId(ownerPrincipal, fileId, appId) {
    return createHash('sha256')
        .update(keyOf(ownerPrincipal, fileId, appId), 'utf8')
        .digest('hex');
}
function asBuiltAppRecord(data) {
    if (!data)
        return null;
    const rec = data;
    if (typeof rec.appId !== 'string' ||
        typeof rec.ownerPrincipal !== 'string' ||
        typeof rec.fileId !== 'string' ||
        !rec.spec ||
        typeof rec.spec !== 'object') {
        return null;
    }
    return rec;
}
export class FirestoreBuiltAppStore {
    db;
    constructor(db) {
        this.db = db;
        if (!db)
            throw new Error('built-app store: Firestore client is required (fail closed)');
    }
    doc(ownerPrincipal, fileId, appId) {
        return this.db
            .collection(BUILT_APPS_COLLECTION)
            .doc(builtAppDocId(ownerPrincipal, fileId, appId));
    }
    async upsert(input) {
        const rawId = input.spec?.id;
        const existing = typeof rawId === 'string'
            ? await this.get(input.ownerPrincipal, input.fileId, rawId)
            : null;
        const rec = buildRecord(input, existing, Date.now());
        const bytes = Buffer.byteLength(JSON.stringify(rec), 'utf8');
        if (bytes > BUILT_APP_DOC_CAP_BYTES) {
            throw new Error(`built-app store: app ${rec.appId} serializes to ${bytes} bytes, ` +
                `exceeding the ${BUILT_APP_DOC_CAP_BYTES}-byte Firestore document cap; ` +
                `refusing to write rather than truncate`);
        }
        await this.doc(rec.ownerPrincipal, rec.fileId, rec.appId).set({
            ...rec,
        });
        return { ...rec };
    }
    async get(ownerPrincipal, fileId, appId) {
        const snap = await this.doc(ownerPrincipal, fileId, appId).get();
        if (!snap.exists)
            return null;
        return asBuiltAppRecord(snap.data());
    }
    async listByOwnerAndFile(ownerPrincipal, fileId) {
        const rows = await this.db
            .collection(BUILT_APPS_COLLECTION)
            .queryEq('ownerPrincipal', ownerPrincipal);
        const out = [];
        for (const row of rows) {
            const rec = asBuiltAppRecord(row.data());
            if (rec && rec.fileId === fileId)
                out.push(rec);
        }
        return out.sort((a, b) => a.createdAt - b.createdAt);
    }
    async listByOwner(ownerPrincipal) {
        const rows = await this.db
            .collection(BUILT_APPS_COLLECTION)
            .queryEq('ownerPrincipal', ownerPrincipal);
        const out = [];
        for (const row of rows) {
            const rec = asBuiltAppRecord(row.data());
            if (rec)
                out.push(rec);
        }
        return out.sort((a, b) => a.createdAt - b.createdAt);
    }
    async remove(ownerPrincipal, fileId, appId) {
        const rec = await this.get(ownerPrincipal, fileId, appId);
        if (!rec)
            return false;
        await this.doc(ownerPrincipal, fileId, appId).delete();
        return true;
    }
    async removeAllForOwner(ownerPrincipal) {
        const mine = await this.listByOwner(ownerPrincipal);
        for (const rec of mine) {
            await this.doc(rec.ownerPrincipal, rec.fileId, rec.appId).delete();
        }
        return mine.length;
    }
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function builtAppStoreProvider(env = process.env) {
    const v = (env.BUILT_APP_STORE ?? '').trim().toLowerCase();
    return v === 'prod' || v === 'firestore' ? 'prod' : 'local';
}
export function builtAppStoreDir(env = process.env) {
    const fromEnv = (env.BUILT_APP_STORE_DIR ?? '').trim();
    return fromEnv !== '' ? fromEnv : join(sessionDataDir(env), 'built-apps');
}
/**
 * Construct the built-app store from env. Prod mode REQUIRES an
 * injected Firestore client — without one this throws rather than
 * silently landing apps on local disk in production (fail closed,
 * the createAppShareStore / createUserTierStore posture).
 */
export function createBuiltAppStore(env = process.env, opts = {}) {
    if (builtAppStoreProvider(env) === 'prod') {
        if (!opts.firestoreDb) {
            throw new Error('built-app store: BUILT_APP_STORE=prod requires a Firestore client (credentials) — refusing to fall back to a local store (fail closed)');
        }
        return new FirestoreBuiltAppStore(opts.firestoreDb);
    }
    return new LocalBuiltAppStore(builtAppStoreDir(env));
}
