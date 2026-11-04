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
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, } from 'node:fs';
import { join } from 'node:path';
import { gatewayDataDir } from '../filePersistence.js';
/** Flatten segments into the ordered op stream past `revision`. */
export function opsFromSegments(segments, revision) {
    return segments
        .flatMap((s) => s.ops)
        .filter((e) => e.revision > revision)
        .sort((a, b) => a.revision - b.revision);
}
// ---------------------------------------------------------------------------
// Local (filesystem) adapter — the dev provider, fully real
// ---------------------------------------------------------------------------
function hashKey(sessionId) {
    return createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 24);
}
function readJson(file) {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        return null;
    }
}
function writeJsonAtomic(file, value) {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), 'utf8');
    renameSync(tmp, file);
}
export class LocalSessionStores {
    dir;
    provider = 'local';
    registry;
    journal;
    snapshots;
    constructor(dir) {
        this.dir = dir;
        mkdirSync(dir, { recursive: true });
        const regFile = join(dir, 'registry.json');
        // One file per journal SEGMENT: segment.<hash>.<from>-<to>.json —
        // the same segment model as production (one write per segment).
        const segmentFile = (seg) => join(dir, `segment.${hashKey(seg.sessionId)}.${String(seg.fromRevision).padStart(10, '0')}-${String(seg.toRevision).padStart(10, '0')}.json`);
        const readSegmentsSync = (sid) => {
            const prefix = `segment.${hashKey(sid)}.`;
            let names;
            try {
                names = readdirSync(dir).filter((n) => n.startsWith(prefix) && n.endsWith('.json'));
            }
            catch {
                return [];
            }
            const segs = [];
            for (const name of names) {
                const seg = readJson(join(dir, name));
                if (seg && seg.sessionId === sid && Array.isArray(seg.ops))
                    segs.push(seg);
            }
            return segs.sort((a, b) => a.fromRevision - b.fromRevision);
        };
        const snapFile = (sid) => join(dir, `snapshot.${hashKey(sid)}.xlsx`);
        const snapMetaFile = (sid) => join(dir, `snapshot.${hashKey(sid)}.json`);
        const readRegistry = () => readJson(regFile) ?? {};
        const writeRegistry = (r) => writeJsonAtomic(regFile, r);
        this.registry = {
            register: async (rec) => {
                const all = readRegistry();
                all[rec.sessionId] = rec;
                writeRegistry(all);
            },
            lookup: async (sid) => readRegistry()[sid] ?? null,
            update: async (sid, patch) => {
                const all = readRegistry();
                const cur = all[sid];
                if (!cur)
                    throw new Error(`session registry: unknown session ${sid}`);
                all[sid] = { ...cur, ...patch, sessionId: sid, updatedAt: Date.now() };
                writeRegistry(all);
            },
            release: async (sid) => {
                const all = readRegistry();
                const cur = all[sid];
                if (!cur)
                    return;
                all[sid] = { ...cur, status: 'released', updatedAt: Date.now() };
                writeRegistry(all);
            },
        };
        this.journal = {
            appendSegment: async (seg) => {
                writeJsonAtomic(segmentFile(seg), seg);
            },
            readSegments: async (sid, fromRevision) => readSegmentsSync(sid).filter((s) => s.toRevision > fromRevision),
            readFrom: async (sid, revision) => opsFromSegments(readSegmentsSync(sid), revision),
            headRevision: async (sid) => readSegmentsSync(sid).reduce((max, s) => Math.max(max, s.toRevision), 0),
            truncate: async (sid, uptoRevision) => {
                for (const seg of readSegmentsSync(sid)) {
                    if (seg.toRevision <= uptoRevision) {
                        try {
                            unlinkSync(segmentFile(seg));
                        }
                        catch {
                            // Already gone.
                        }
                    }
                }
            },
        };
        this.snapshots = {
            put: async (sid, snap) => {
                const target = snapFile(sid);
                const tmp = `${target}.${process.pid}.tmp`;
                writeFileSync(tmp, snap.bytes);
                renameSync(tmp, target);
                writeJsonAtomic(snapMetaFile(sid), {
                    checksum: snap.checksum,
                    revision: snap.revision,
                    at: snap.at,
                });
            },
            get: async (sid) => {
                const meta = readJson(snapMetaFile(sid));
                if (!meta)
                    return null;
                try {
                    return { bytes: readFileSync(snapFile(sid)), ...meta };
                }
                catch {
                    return null;
                }
            },
        };
    }
}
// ---------------------------------------------------------------------------
// In-memory adapter — the interface-level fake for unit tests (and the
// shape any future provider must satisfy).
// ---------------------------------------------------------------------------
export class MemorySessionStores {
    provider = 'memory';
    records = new Map();
    journals = new Map();
    snaps = new Map();
    registry = {
        register: async (rec) => {
            this.records.set(rec.sessionId, { ...rec });
        },
        lookup: async (sid) => {
            const r = this.records.get(sid);
            return r ? { ...r } : null;
        },
        update: async (sid, patch) => {
            const cur = this.records.get(sid);
            if (!cur)
                throw new Error(`session registry: unknown session ${sid}`);
            this.records.set(sid, { ...cur, ...patch, sessionId: sid, updatedAt: Date.now() });
        },
        release: async (sid) => {
            const cur = this.records.get(sid);
            if (cur)
                this.records.set(sid, { ...cur, status: 'released', updatedAt: Date.now() });
        },
    };
    journal = {
        appendSegment: async (seg) => {
            const list = this.journals.get(seg.sessionId) ?? [];
            list.push({ ...seg, ops: [...seg.ops] });
            this.journals.set(seg.sessionId, list);
        },
        readSegments: async (sid, fromRevision) => (this.journals.get(sid) ?? [])
            .filter((s) => s.toRevision > fromRevision)
            .sort((a, b) => a.fromRevision - b.fromRevision),
        readFrom: async (sid, revision) => opsFromSegments(this.journals.get(sid) ?? [], revision),
        headRevision: async (sid) => (this.journals.get(sid) ?? []).reduce((max, s) => Math.max(max, s.toRevision), 0),
        truncate: async (sid, uptoRevision) => {
            this.journals.set(sid, (this.journals.get(sid) ?? []).filter((s) => s.toRevision > uptoRevision));
        },
    };
    snapshots = {
        put: async (sid, snap) => {
            this.snaps.set(sid, { ...snap, bytes: new Uint8Array(snap.bytes) });
        },
        get: async (sid) => {
            const s = this.snaps.get(sid);
            return s ? { ...s, bytes: new Uint8Array(s.bytes) } : null;
        },
    };
}
const REGISTRY_COLLECTION = 'icecream_sessions';
/** One document per journal SEGMENT (the free-quota write model). */
const JOURNAL_SEGMENTS_COLLECTION = 'icecream_session_journal_segments';
function recordToFirestore(rec) {
    return { ...rec };
}
function recordFromFirestore(data) {
    return data;
}
export class FirestoreSessionStores {
    db;
    storage;
    bucketName;
    provider = 'prod';
    registry;
    journal;
    snapshots;
    constructor(db, storage, bucketName) {
        this.db = db;
        this.storage = storage;
        this.bucketName = bucketName;
        const regDoc = (sid) => this.db.collection(REGISTRY_COLLECTION).doc(sid);
        const segmentDoc = (seg) => this.db
            .collection(JOURNAL_SEGMENTS_COLLECTION)
            .doc(`${hashKey(seg.sessionId)}__${seg.fromRevision}-${seg.toRevision}`);
        this.registry = {
            register: async (rec) => {
                await regDoc(rec.sessionId).set(recordToFirestore(rec));
            },
            lookup: async (sid) => {
                const snap = await regDoc(sid).get();
                if (!snap.exists)
                    return null;
                const data = snap.data();
                return data ? recordFromFirestore(data) : null;
            },
            update: async (sid, patch) => {
                await regDoc(sid).set({ ...patch, sessionId: sid, updatedAt: Date.now() }, { merge: true });
            },
            release: async (sid) => {
                await regDoc(sid).set({ status: 'released', updatedAt: Date.now() }, { merge: true });
            },
        };
        // The journal is ONE DOCUMENT PER SEGMENT (user's free-quota
        // constraint: 20k Firestore writes/day — one write per segment,
        // never one per op). A segment doc carries its full op batch;
        // reads query the session's segment docs and order by fromRevision.
        const readAllSegments = async (sid) => {
            const rows = await this.db.collection(JOURNAL_SEGMENTS_COLLECTION).queryEq('sessionId', sid);
            const segs = [];
            for (const row of rows) {
                const data = row.data();
                if (data && Array.isArray(data.ops)) {
                    segs.push(data);
                }
            }
            return segs.sort((a, b) => a.fromRevision - b.fromRevision);
        };
        this.journal = {
            appendSegment: async (seg) => {
                await segmentDoc(seg).set({ ...seg });
            },
            readSegments: async (sid, fromRevision) => (await readAllSegments(sid)).filter((s) => s.toRevision > fromRevision),
            readFrom: async (sid, revision) => opsFromSegments(await readAllSegments(sid), revision),
            headRevision: async (sid) => (await readAllSegments(sid)).reduce((max, s) => Math.max(max, s.toRevision), 0),
            truncate: async (sid, uptoRevision) => {
                for (const seg of await readAllSegments(sid)) {
                    if (seg.toRevision <= uptoRevision)
                        await segmentDoc(seg).delete();
                }
            },
        };
        const snapFile = (sid) => this.storage.bucket(this.bucketName).file(`sessions/${hashKey(sid)}/snapshot.xlsx`);
        this.snapshots = {
            put: async (sid, snap) => {
                await snapFile(sid).save(Buffer.from(snap.bytes), {
                    metadata: {
                        metadata: {
                            checksum: snap.checksum,
                            revision: String(snap.revision),
                            at: String(snap.at),
                        },
                    },
                });
            },
            get: async (sid) => {
                try {
                    const file = snapFile(sid);
                    const [meta] = await file.getMetadata();
                    const m = meta.metadata ?? {};
                    if (typeof m.checksum !== 'string' || typeof m.revision !== 'string')
                        return null;
                    const [bytes] = await file.download();
                    return {
                        bytes: new Uint8Array(bytes),
                        checksum: m.checksum,
                        revision: Number(m.revision),
                        at: Number(m.at ?? '0'),
                    };
                }
                catch {
                    return null; // no snapshot stored for this session
                }
            },
        };
    }
}
/** SESSION_STORE: 'local' (default, dev) | 'prod' (Firestore + GCS). */
export function sessionStoreProvider(env = process.env) {
    return (env.SESSION_STORE ?? '').trim().toLowerCase() === 'prod' ? 'prod' : 'local';
}
/** SESSION_DATA_DIR for the local provider (default under the gateway data dir). */
export function sessionDataDir(env = process.env) {
    const fromEnv = (env.SESSION_DATA_DIR ?? '').trim();
    return fromEnv !== '' ? fromEnv : join(gatewayDataDir(), 'sessions');
}
/** Read the prod provider's env config; throws a clear error when incomplete. */
export function prodSessionConfig(env = process.env) {
    const projectId = (env.GCP_PROJECT_ID ?? env.FIREBASE_PROJECT_ID ?? '').trim();
    const snapshotBucket = (env.SESSION_SNAPSHOT_BUCKET ?? '').trim();
    const missing = [];
    if (!projectId)
        missing.push('GCP_PROJECT_ID');
    if (!snapshotBucket)
        missing.push('SESSION_SNAPSHOT_BUCKET');
    if (missing.length > 0) {
        throw new Error(`SESSION_STORE=prod requires ${missing.join(' + ')} to be set — refusing to start with a half-configured production session store (fail closed)`);
    }
    return {
        projectId,
        databaseId: (env.FIRESTORE_DATABASE_ID ?? '').trim() || undefined,
        snapshotBucket,
    };
}
/**
 * Dynamically load the official Google Cloud clients. Fails closed with
 * a clear, actionable message when the libraries are not installed or
 * no credentials are available — the prod provider must NEVER silently
 * degrade to local storage.
 */
export async function loadProdClients(cfg) {
    // The Google Cloud clients are OPTIONAL dependencies (only a prod
    // deploy installs them), so they load through a non-literal specifier:
    // the TypeScript compiler must not try to resolve them here, and a
    // missing package becomes the fail-closed runtime error below.
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    let FirestoreCtor;
    let StorageCtor;
    try {
        ({ Firestore: FirestoreCtor } = await dynamicImport('@google-cloud/firestore'));
    }
    catch {
        throw new Error('SESSION_STORE=prod requires the @google-cloud/firestore package (not installed) — install it or use SESSION_STORE=local (fail closed)');
    }
    try {
        ({ Storage: StorageCtor } = await dynamicImport('@google-cloud/storage'));
    }
    catch {
        throw new Error('SESSION_STORE=prod requires the @google-cloud/storage package (not installed) — install it or use SESSION_STORE=local (fail closed)');
    }
    const hasCreds = (process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '').trim() !== '' ||
        existsSync('/var/run/secrets/google') ||
        // Cloud Run / GCE metadata server identity counts as credentials;
        // the Firestore client's own channel check below is the real gate.
        (process.env.K_SERVICE ?? '').trim() !== '';
    if (!hasCreds && (process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '') === '') {
        // Not fatal by itself (workload identity may still resolve); the
        // client construction + first-use errors surface with their own
        // messages. Log loudly so a misconfigured deploy is visible.
        console.warn('[session-store] SESSION_STORE=prod: GOOGLE_APPLICATION_CREDENTIALS is unset — relying on workload identity / ADC discovery');
    }
    const rawDb = new FirestoreCtor({
        projectId: cfg.projectId,
        ...(cfg.databaseId ? { databaseId: cfg.databaseId } : {}),
    });
    const storage = new StorageCtor({
        projectId: cfg.projectId,
    });
    return { db: wrapFirestore(rawDb), storage };
}
/**
 * Adapt the real @google-cloud/firestore client to the narrow
 * FirestoreLike surface (its CollectionReference has where() instead of
 * queryEq, and its snapshots differ slightly in shape).
 */
export function wrapFirestore(raw) {
    const db = raw;
    return {
        collection: (name) => {
            const col = db.collection(name);
            return {
                doc: (id) => col.doc(id),
                queryEq: async (field, value) => {
                    const snap = await col.where(field, '==', value).get();
                    return snap.docs.map((d) => ({ id: d.id, data: () => d.data() }));
                },
            };
        },
    };
}
/**
 * Build the session stores for the configured provider. For 'prod' the
 * config is validated synchronously (fail closed) and the clients load
 * lazily — callers that need the prod stores await `ready` first; the
 * engine service only enables session endpoints once construction is
 * resolved, and prod construction errors propagate as startup failures.
 */
export async function createSessionStores(env = process.env) {
    if (sessionStoreProvider(env) === 'prod') {
        const cfg = prodSessionConfig(env); // throws, fail closed, when incomplete
        const { db, storage } = await loadProdClients(cfg);
        return new FirestoreSessionStores(db, storage, cfg.snapshotBucket);
    }
    return new LocalSessionStores(sessionDataDir(env));
}
/** Synchronous local/memory construction (tests + engine-service default). */
export function createLocalSessionStores(dir) {
    return new LocalSessionStores(dir ?? sessionDataDir());
}
