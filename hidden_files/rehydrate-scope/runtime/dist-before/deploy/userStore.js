/**
 * Product layer — per-user tier store + file catalog
 * (hidden_files/product-layer/CONTRACT.md §Tiers, §File catalog).
 *
 * Two small durable stores, both following the fileRegistry.ts /
 * sessionStore.ts adapter posture:
 *   local — JSON file under USER_STORE_DIR (default
 *     <sessionDataDir>/user-store), guarded by a cross-process
 *     lockfile mutex; atomic tmp+rename writes; IO errors THROW.
 *   memory — interface-level fake for unit tests.
 *   prod — Firestore-shaped structural adapter (collections
 *     `icecream_user_tiers` / `icecream_user_files`). Factories FAIL
 *     CLOSED in prod mode (USER_STORE=prod) without an injected
 *     Firestore client — never a silent local fallback.
 *
 * Tiers: exactly 'default' | 'pro'. Default caps come from named,
 * env-configurable constants (CONTRACT §Tiers). Pending promotions by
 * email are consumed at first record creation (resolveTier with that
 * email): an operator can promote an email before the user has ever
 * signed in, and the first login lands at the promoted tier.
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, } from 'node:fs';
import { join } from 'node:path';
import { sessionDataDir, wrapFirestore } from './sessionStore.js';
/** P75 workbook size (bytes) — the Default-tier upload cap default. */
export const DEFAULT_UPLOAD_MAX_BYTES = 1_285_214;
/** Default-tier workspace file-count cap default. */
export const DEFAULT_FILE_LIMIT = 10;
/** TIER_DEFAULT_UPLOAD_MAX_BYTES override. */
export function defaultUploadMaxBytes(env = process.env) {
    const n = Number(env.TIER_DEFAULT_UPLOAD_MAX_BYTES ?? '');
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_UPLOAD_MAX_BYTES;
}
/** TIER_DEFAULT_FILE_LIMIT override. */
export function defaultFileLimit(env = process.env) {
    const n = Number(env.TIER_DEFAULT_FILE_LIMIT ?? '');
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_FILE_LIMIT;
}
/** Limits view for a tier: null = unrestricted (pro). */
export function tierLimits(tier, env = process.env) {
    return tier === 'pro'
        ? { uploadMaxBytes: null, fileLimit: null }
        : { uploadMaxBytes: defaultUploadMaxBytes(env), fileLimit: defaultFileLimit(env) };
}
export function isTier(x) {
    return x === 'default' || x === 'pro';
}
// ---------------------------------------------------------------------------
// Env config (shared by both stores — same env/dir family)
// ---------------------------------------------------------------------------
/** USER_STORE: 'local' (default) | 'prod' (Firestore). */
export function userStoreProvider(env = process.env) {
    const v = (env.USER_STORE ?? '').trim().toLowerCase();
    return v === 'prod' || v === 'firestore' ? 'prod' : 'local';
}
/** USER_STORE_DIR: local adapter root (default <sessionDataDir>/user-store). */
export function userStoreDir(env = process.env) {
    const fromEnv = (env.USER_STORE_DIR ?? '').trim();
    return fromEnv !== '' ? fromEnv : join(sessionDataDir(env), 'user-store');
}
function normalizeEmail(email) {
    return email.trim().toLowerCase();
}
// ---------------------------------------------------------------------------
// Lockfile mutex (LocalFileRegistry pattern)
// ---------------------------------------------------------------------------
const LOCK_SPIN_MS = 5;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
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
                    throw new Error(`user store: lock timeout after ${LOCK_TIMEOUT_MS}ms (fail closed)`);
                }
                sleepSync(LOCK_SPIN_MS);
            }
        }
    }
    function releaseLock() {
        try {
            unlinkSync(lockFile);
        }
        catch {
            // Already gone (stale-recovered by a peer).
        }
    }
    return {
        withLock(fn) {
            acquireLock();
            try {
                return fn();
            }
            finally {
                releaseLock();
            }
        },
    };
}
function readJsonFile(file, empty) {
    let text;
    try {
        text = readFileSync(file, 'utf8');
    }
    catch (e) {
        if (e?.code === 'ENOENT')
            return empty;
        throw e;
    }
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('user store: corrupt store file (fail closed)');
    }
    return parsed;
}
function writeJsonAtomic(file, value) {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), 'utf8');
    renameSync(tmp, file);
}
export class MemoryUserTierStore {
    records = new Map();
    pending = new Map();
    async resolveTier(input) {
        const cur = this.records.get(input.userId);
        if (cur) {
            if (input.email && cur.email !== input.email) {
                const next = { ...cur, email: input.email, updatedAt: Date.now() };
                this.records.set(input.userId, next);
                return next.tier;
            }
            return cur.tier;
        }
        let tier = 'default';
        if (input.email) {
            const key = normalizeEmail(input.email);
            const p = this.pending.get(key);
            if (p) {
                tier = p;
                this.pending.delete(key);
            }
        }
        const now = Date.now();
        this.records.set(input.userId, {
            userId: input.userId,
            ...(input.email ? { email: input.email } : {}),
            tier,
            createdAt: now,
            updatedAt: now,
        });
        return tier;
    }
    async getRecord(userId) {
        const rec = this.records.get(userId);
        return rec ? { ...rec } : null;
    }
    async setTierByEmail(email, tier) {
        const key = normalizeEmail(email);
        for (const rec of this.records.values()) {
            if (rec.email && normalizeEmail(rec.email) === key) {
                const next = { ...rec, tier, updatedAt: Date.now() };
                this.records.set(rec.userId, next);
                return { ...next };
            }
        }
        this.pending.set(key, tier);
        return null;
    }
    async setTierByUserId(userId, tier) {
        const cur = this.records.get(userId);
        const now = Date.now();
        const next = cur
            ? { ...cur, tier, updatedAt: now }
            : { userId, tier, createdAt: now, updatedAt: now };
        this.records.set(userId, next);
        return { ...next };
    }
    async getPendingByEmail(email) {
        return this.pending.get(normalizeEmail(email)) ?? null;
    }
    async deleteRecord(userId) {
        const rec = this.records.get(userId);
        if (!rec)
            return false;
        this.records.delete(userId);
        if (rec.email)
            this.pending.delete(normalizeEmail(rec.email));
        return true;
    }
}
export class LocalUserTierStore {
    file;
    lock;
    constructor(dir) {
        mkdirSync(dir, { recursive: true });
        this.file = join(dir, 'user-tiers.json');
        this.lock = makeLock(join(dir, 'user-tiers.lock'));
    }
    readAll() {
        const parsed = readJsonFile(this.file, {});
        return {
            records: (parsed.records ?? {}),
            pending: (parsed.pending ?? {}),
        };
    }
    async resolveTier(input) {
        return this.lock.withLock(() => {
            const all = this.readAll();
            const cur = all.records[input.userId];
            if (cur) {
                if (input.email && cur.email !== input.email) {
                    all.records[input.userId] = { ...cur, email: input.email, updatedAt: Date.now() };
                    writeJsonAtomic(this.file, all);
                    return all.records[input.userId].tier;
                }
                return cur.tier;
            }
            let tier = 'default';
            if (input.email) {
                const key = normalizeEmail(input.email);
                const p = all.pending[key];
                if (p) {
                    tier = p;
                    delete all.pending[key];
                }
            }
            const now = Date.now();
            all.records[input.userId] = {
                userId: input.userId,
                ...(input.email ? { email: input.email } : {}),
                tier,
                createdAt: now,
                updatedAt: now,
            };
            writeJsonAtomic(this.file, all);
            return tier;
        });
    }
    async getRecord(userId) {
        return this.lock.withLock(() => {
            const rec = this.readAll().records[userId];
            return rec ? { ...rec } : null;
        });
    }
    async setTierByEmail(email, tier) {
        return this.lock.withLock(() => {
            const all = this.readAll();
            const key = normalizeEmail(email);
            for (const rec of Object.values(all.records)) {
                if (rec.email && normalizeEmail(rec.email) === key) {
                    const next = { ...rec, tier, updatedAt: Date.now() };
                    all.records[rec.userId] = next;
                    writeJsonAtomic(this.file, all);
                    return { ...next };
                }
            }
            all.pending[key] = tier;
            writeJsonAtomic(this.file, all);
            return null;
        });
    }
    async setTierByUserId(userId, tier) {
        return this.lock.withLock(() => {
            const all = this.readAll();
            const cur = all.records[userId];
            const now = Date.now();
            const next = cur
                ? { ...cur, tier, updatedAt: now }
                : { userId, tier, createdAt: now, updatedAt: now };
            all.records[userId] = next;
            writeJsonAtomic(this.file, all);
            return { ...next };
        });
    }
    async getPendingByEmail(email) {
        return this.lock.withLock(() => this.readAll().pending[normalizeEmail(email)] ?? null);
    }
    async deleteRecord(userId) {
        return this.lock.withLock(() => {
            const all = this.readAll();
            const rec = all.records[userId];
            if (!rec)
                return false;
            delete all.records[userId];
            if (rec.email)
                delete all.pending[normalizeEmail(rec.email)];
            writeJsonAtomic(this.file, all);
            return true;
        });
    }
}
const USER_TIERS_COLLECTION = 'icecream_user_tiers';
function pendingDocId(normalizedEmail) {
    return `pending:${normalizedEmail}`;
}
export class FirestoreUserTierStore {
    db;
    constructor(db) {
        this.db = db;
    }
    doc(id) {
        return this.db.collection(USER_TIERS_COLLECTION).doc(id);
    }
    async getRecord(userId) {
        const snap = await this.doc(userId).get();
        if (!snap.exists)
            return null;
        const data = snap.data();
        if (!data || data.pendingEmail !== undefined)
            return null;
        return data;
    }
    async getPendingByEmail(email) {
        const snap = await this.doc(pendingDocId(normalizeEmail(email))).get();
        if (!snap.exists)
            return null;
        const data = snap.data();
        const tier = data?.tier;
        return isTier(tier) ? tier : null;
    }
    async resolveTier(input) {
        const cur = await this.getRecord(input.userId);
        if (cur) {
            if (input.email && cur.email !== input.email) {
                const next = { ...cur, email: input.email, updatedAt: Date.now() };
                await this.doc(input.userId).set({ ...next });
                return next.tier;
            }
            return cur.tier;
        }
        let tier = 'default';
        if (input.email) {
            const p = await this.getPendingByEmail(input.email);
            if (p) {
                tier = p;
                await this.doc(pendingDocId(normalizeEmail(input.email))).delete();
            }
        }
        const now = Date.now();
        const rec = {
            userId: input.userId,
            ...(input.email ? { email: input.email } : {}),
            tier,
            createdAt: now,
            updatedAt: now,
        };
        await this.doc(input.userId).set({ ...rec });
        return tier;
    }
    async setTierByEmail(email, tier) {
        const key = normalizeEmail(email);
        const rows = await this.db.collection(USER_TIERS_COLLECTION).queryEq('email', email);
        const match = rows
            .map((r) => r.data())
            .find((d) => !!d && typeof d['email'] === 'string' && normalizeEmail(d['email']) === key);
        if (match) {
            const rec = match;
            const next = { ...rec, tier, updatedAt: Date.now() };
            await this.doc(rec.userId).set({ ...next });
            return { ...next };
        }
        await this.doc(pendingDocId(key)).set({ pendingEmail: key, tier });
        return null;
    }
    async setTierByUserId(userId, tier) {
        const cur = await this.getRecord(userId);
        const now = Date.now();
        const next = cur
            ? { ...cur, tier, updatedAt: now }
            : { userId, tier, createdAt: now, updatedAt: now };
        await this.doc(userId).set({ ...next });
        return { ...next };
    }
    async deleteRecord(userId) {
        const rec = await this.getRecord(userId);
        if (!rec)
            return false;
        await this.doc(userId).delete();
        if (rec.email) {
            await this.doc(pendingDocId(normalizeEmail(rec.email))).delete();
        }
        return true;
    }
}
/**
 * Build the tier store for the configured provider. 'prod' REQUIRES an
 * injected Firestore client — fail closed, never a local fallback.
 */
export function createUserTierStore(env = process.env, opts = {}) {
    if (userStoreProvider(env) === 'prod') {
        if (!opts.firestoreDb) {
            throw new Error('user tier store: USER_STORE=prod requires a Firestore client (credentials) — refusing to fall back to a local store (fail closed)');
        }
        return new FirestoreUserTierStore(opts.firestoreDb);
    }
    return new LocalUserTierStore(opts.dir ?? userStoreDir(env));
}
/**
 * Derive the source format from a filename's extension, case-insensitive.
 * Returns null for anything that is not a supported upload type.
 * ('.xls' = legacy BIFF: the engine parses it through SheetJS — sweep
 * finding F-2; note '.xlsx' must be tested before '.xls' would matter —
 * endsWith('.xls') is false for '.xlsx', so order is safe.)
 */
export function sourceFormatForFileName(name) {
    const lower = name.toLowerCase();
    if (lower.endsWith('.xlsx'))
        return 'xlsx';
    if (lower.endsWith('.csv'))
        return 'csv';
    if (lower.endsWith('.xls'))
        return 'xls';
    return null;
}
function isSourceFormat(x) {
    return x === 'xlsx' || x === 'csv' || x === 'xls';
}
/** Normalize a persisted record: records written before sourceFormat existed load as 'xlsx'. */
function normalizeFileRecord(rec) {
    return isSourceFormat(rec.sourceFormat) ? rec : { ...rec, sourceFormat: 'xlsx' };
}
function buildRecord(input, now) {
    return {
        fileId: input.fileId,
        ownerPrincipal: input.ownerPrincipal,
        name: input.name,
        sourceFormat: input.sourceFormat ?? 'xlsx',
        origin: input.origin,
        sizeBytes: input.sizeBytes ?? 0,
        storageRef: input.storageRef ?? null,
        libraryEntryId: input.libraryEntryId ?? null,
        hasStoredState: input.hasStoredState ?? false,
        createdAt: now,
        updatedAt: now,
        lastOpenedAt: now,
    };
}
function byRecency(a, b) {
    return b.lastOpenedAt - a.lastOpenedAt || b.createdAt - a.createdAt;
}
export class MemoryUserFileCatalog {
    records = new Map();
    async create(input) {
        const rec = buildRecord(input, Date.now());
        this.records.set(rec.fileId, rec);
        return { ...rec };
    }
    async get(fileId) {
        const rec = this.records.get(fileId);
        return rec ? { ...normalizeFileRecord(rec) } : null;
    }
    async listByOwner(ownerPrincipal) {
        return [...this.records.values()]
            .filter((r) => r.ownerPrincipal === ownerPrincipal)
            .sort(byRecency)
            .map((r) => ({ ...normalizeFileRecord(r) }));
    }
    async update(fileId, patch) {
        const cur = this.records.get(fileId);
        if (!cur)
            return null;
        const next = { ...cur, ...patch, fileId, updatedAt: Date.now() };
        this.records.set(fileId, next);
        return { ...next };
    }
    async remove(fileId) {
        return this.records.delete(fileId);
    }
    async countByOwner(ownerPrincipal) {
        let n = 0;
        for (const r of this.records.values())
            if (r.ownerPrincipal === ownerPrincipal)
                n++;
        return n;
    }
    async touchOpened(fileId) {
        const cur = this.records.get(fileId);
        if (!cur)
            return null;
        const now = Date.now();
        const next = { ...cur, lastOpenedAt: now, updatedAt: now };
        this.records.set(fileId, next);
        return { ...next };
    }
}
export class LocalUserFileCatalog {
    file;
    lock;
    constructor(dir) {
        mkdirSync(dir, { recursive: true });
        this.file = join(dir, 'user-files.json');
        this.lock = makeLock(join(dir, 'user-files.lock'));
    }
    readAll() {
        const raw = readJsonFile(this.file, {});
        const out = {};
        for (const [k, v] of Object.entries(raw))
            out[k] = normalizeFileRecord(v);
        return out;
    }
    async create(input) {
        return this.lock.withLock(() => {
            const all = this.readAll();
            const rec = buildRecord(input, Date.now());
            all[rec.fileId] = rec;
            writeJsonAtomic(this.file, all);
            return { ...rec };
        });
    }
    async get(fileId) {
        return this.lock.withLock(() => {
            const rec = this.readAll()[fileId];
            return rec ? { ...rec } : null;
        });
    }
    async listByOwner(ownerPrincipal) {
        return this.lock.withLock(() => Object.values(this.readAll())
            .filter((r) => r.ownerPrincipal === ownerPrincipal)
            .sort(byRecency)
            .map((r) => ({ ...r })));
    }
    async update(fileId, patch) {
        return this.lock.withLock(() => {
            const all = this.readAll();
            const cur = all[fileId];
            if (!cur)
                return null;
            const next = { ...cur, ...patch, fileId, updatedAt: Date.now() };
            all[fileId] = next;
            writeJsonAtomic(this.file, all);
            return { ...next };
        });
    }
    async remove(fileId) {
        return this.lock.withLock(() => {
            const all = this.readAll();
            if (!all[fileId])
                return false;
            delete all[fileId];
            writeJsonAtomic(this.file, all);
            return true;
        });
    }
    async countByOwner(ownerPrincipal) {
        return this.lock.withLock(() => Object.values(this.readAll()).filter((r) => r.ownerPrincipal === ownerPrincipal).length);
    }
    async touchOpened(fileId) {
        return this.lock.withLock(() => {
            const all = this.readAll();
            const cur = all[fileId];
            if (!cur)
                return null;
            const now = Date.now();
            const next = { ...cur, lastOpenedAt: now, updatedAt: now };
            all[fileId] = next;
            writeJsonAtomic(this.file, all);
            return { ...next };
        });
    }
}
const USER_FILES_COLLECTION = 'icecream_user_files';
export class FirestoreUserFileCatalog {
    db;
    constructor(db) {
        this.db = db;
    }
    doc(fileId) {
        return this.db.collection(USER_FILES_COLLECTION).doc(fileId);
    }
    async create(input) {
        const rec = buildRecord(input, Date.now());
        await this.doc(rec.fileId).set({ ...rec });
        return { ...rec };
    }
    async get(fileId) {
        const snap = await this.doc(fileId).get();
        if (!snap.exists)
            return null;
        const data = snap.data();
        return data ? normalizeFileRecord(data) : null;
    }
    async listByOwner(ownerPrincipal) {
        const rows = await this.db.collection(USER_FILES_COLLECTION).queryEq('ownerPrincipal', ownerPrincipal);
        return rows
            .map((r) => r.data())
            .filter((d) => !!d)
            .map((d) => normalizeFileRecord(d))
            .sort(byRecency)
            .map((r) => ({ ...r }));
    }
    async update(fileId, patch) {
        const cur = await this.get(fileId);
        if (!cur)
            return null;
        const next = { ...cur, ...patch, fileId, updatedAt: Date.now() };
        await this.doc(fileId).set({ ...next });
        return { ...next };
    }
    async remove(fileId) {
        const cur = await this.get(fileId);
        if (!cur)
            return false;
        await this.doc(fileId).delete();
        return true;
    }
    async countByOwner(ownerPrincipal) {
        return (await this.listByOwner(ownerPrincipal)).length;
    }
    async touchOpened(fileId) {
        const cur = await this.get(fileId);
        if (!cur)
            return null;
        const now = Date.now();
        const next = { ...cur, lastOpenedAt: now, updatedAt: now };
        await this.doc(fileId).set({ lastOpenedAt: now, updatedAt: now }, { merge: true });
        return next;
    }
}
/**
 * Build the file catalog for the configured provider. 'prod' REQUIRES
 * an injected Firestore client — fail closed, never a local fallback.
 */
export function createUserFileCatalog(env = process.env, opts = {}) {
    if (userStoreProvider(env) === 'prod') {
        if (!opts.firestoreDb) {
            throw new Error('user file catalog: USER_STORE=prod requires a Firestore client (credentials) — refusing to fall back to a local store (fail closed)');
        }
        return new FirestoreUserFileCatalog(opts.firestoreDb);
    }
    return new LocalUserFileCatalog(opts.dir ?? userStoreDir(env));
}
/** App-settings default (brief: theme defaults to System). */
export const DEFAULT_THEME_CHOICE = 'system';
export function isThemeChoice(x) {
    return x === 'light' || x === 'dark' || x === 'system';
}
/** Fill defaults over a possibly-partial persisted shape. */
function normalizeSettingsRecord(raw) {
    const now = Date.now();
    return {
        userId: raw.userId,
        user: {
            displayName: typeof raw.user?.displayName === 'string' ? raw.user.displayName : null,
        },
        office: {
            theme: isThemeChoice(raw.office?.theme) ? raw.office.theme : DEFAULT_THEME_CHOICE,
        },
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
    };
}
function applySettingsPatch(cur, userId, patch) {
    const now = Date.now();
    const base = cur ?? {
        userId,
        user: { displayName: null },
        office: { theme: DEFAULT_THEME_CHOICE },
        createdAt: now,
        updatedAt: now,
    };
    return {
        ...base,
        user: {
            displayName: patch.displayName !== undefined ? patch.displayName : base.user.displayName,
        },
        office: {
            theme: patch.theme !== undefined ? patch.theme : base.office.theme,
        },
        updatedAt: now,
    };
}
export class MemoryUserSettingsStore {
    records = new Map();
    async get(userId) {
        const rec = this.records.get(userId);
        return rec ? structuredClone(rec) : null;
    }
    async upsert(userId, patch) {
        const next = applySettingsPatch(this.records.get(userId) ?? null, userId, patch);
        this.records.set(userId, next);
        return structuredClone(next);
    }
    async remove(userId) {
        return this.records.delete(userId);
    }
}
export class LocalUserSettingsStore {
    file;
    lock;
    constructor(dir) {
        mkdirSync(dir, { recursive: true });
        this.file = join(dir, 'user-settings.json');
        this.lock = makeLock(join(dir, 'user-settings.lock'));
    }
    readAll() {
        const raw = readJsonFile(this.file, {});
        const out = {};
        for (const [k, v] of Object.entries(raw)) {
            out[k] = normalizeSettingsRecord({ ...v, userId: k });
        }
        return out;
    }
    async get(userId) {
        return this.lock.withLock(() => {
            const rec = this.readAll()[userId];
            return rec ? { ...rec } : null;
        });
    }
    async upsert(userId, patch) {
        return this.lock.withLock(() => {
            const all = this.readAll();
            const next = applySettingsPatch(all[userId] ?? null, userId, patch);
            all[userId] = next;
            writeJsonAtomic(this.file, all);
            return { ...next };
        });
    }
    async remove(userId) {
        return this.lock.withLock(() => {
            const all = this.readAll();
            if (!all[userId])
                return false;
            delete all[userId];
            writeJsonAtomic(this.file, all);
            return true;
        });
    }
}
const USER_SETTINGS_COLLECTION = 'icecream_user_settings';
export class FirestoreUserSettingsStore {
    db;
    constructor(db) {
        this.db = db;
    }
    doc(userId) {
        return this.db.collection(USER_SETTINGS_COLLECTION).doc(userId);
    }
    async get(userId) {
        const snap = await this.doc(userId).get();
        if (!snap.exists)
            return null;
        const data = snap.data();
        return data
            ? normalizeSettingsRecord(data)
            : null;
    }
    async upsert(userId, patch) {
        const cur = await this.get(userId);
        const next = applySettingsPatch(cur, userId, patch);
        await this.doc(userId).set({ ...next });
        return { ...next };
    }
    async remove(userId) {
        const cur = await this.get(userId);
        if (!cur)
            return false;
        await this.doc(userId).delete();
        return true;
    }
}
/**
 * Build the settings store for the configured provider (the family
 * switch, USER_STORE). 'prod' REQUIRES an injected Firestore client —
 * fail closed, never a local fallback.
 */
export function createUserSettingsStore(env = process.env, opts = {}) {
    if (userStoreProvider(env) === 'prod') {
        if (!opts.firestoreDb) {
            throw new Error('user settings store: USER_STORE=prod requires a Firestore client (credentials) — refusing to fall back to a local store (fail closed)');
        }
        return new FirestoreUserSettingsStore(opts.firestoreDb);
    }
    return new LocalUserSettingsStore(opts.dir ?? userStoreDir(env));
}
/**
 * USER_STORE=prod requires GCP_PROJECT_ID (FIRESTORE_DATABASE_ID
 * optional). Throws fail-closed BEFORE any client work when the
 * project is not configured — the share-store posture.
 */
export function prodUserConfig(env = process.env) {
    const projectId = (env.GCP_PROJECT_ID ?? '').trim();
    if (!projectId) {
        throw new Error('user store: USER_STORE=prod requires GCP_PROJECT_ID to be set — refusing to start with a half-configured production user store (fail closed)');
    }
    const databaseId = (env.FIRESTORE_DATABASE_ID ?? '').trim();
    return { projectId, ...(databaseId ? { databaseId } : {}) };
}
/** Load the official Firestore client for a validated prod config. */
async function loadProdUserFirestoreDb(cfg) {
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    let FirestoreCtor;
    try {
        ({ Firestore: FirestoreCtor } = await dynamicImport('@google-cloud/firestore'));
    }
    catch {
        throw new Error('user store: USER_STORE=prod requires the @google-cloud/firestore package (not installed) — install it or use USER_STORE=local (fail closed)');
    }
    const rawDb = new FirestoreCtor({
        projectId: cfg.projectId,
        ...(cfg.databaseId ? { databaseId: cfg.databaseId } : {}),
    });
    return wrapFirestore(rawDb);
}
/**
 * Construct the prod (Firestore) user stores: validates config first
 * (fail closed when GCP_PROJECT_ID is missing), then loads the
 * official @google-cloud/firestore client. Credentials resolve through
 * the client's own ADC discovery (the Cloud Run service account in
 * production; the operator's deployer credentials for set-tier).
 */
export async function createProdUserStores(env = process.env) {
    const cfg = prodUserConfig(env); // throws, fail closed, when incomplete
    const db = await loadProdUserFirestoreDb(cfg);
    return {
        userTierStore: new FirestoreUserTierStore(db),
        userFileCatalog: new FirestoreUserFileCatalog(db),
        userSettingsStore: new FirestoreUserSettingsStore(db),
    };
}
/**
 * Construct ONLY the prod tier store (the set-tier operator tool's
 * target): same validation + client load as createProdUserStores.
 */
export async function createProdUserTierStore(env = process.env) {
    const cfg = prodUserConfig(env); // throws, fail closed, when incomplete
    const db = await loadProdUserFirestoreDb(cfg);
    return new FirestoreUserTierStore(db);
}
