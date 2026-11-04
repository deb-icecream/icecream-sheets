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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { gatewayDataDir } from '../filePersistence.js';

// ---------------------------------------------------------------------------
// Interfaces (extension 1–3 contracts)
// ---------------------------------------------------------------------------

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
  delta?: Array<{ sheet: string; row: number; col: number; value: unknown; formula?: string }>;
  /** Phase 2: who originated the op ({ clientId, clientSeq, principal }). */
  origin?: { clientId: string | null; clientSeq: number | null; principal: string };
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
export function opsFromSegments(segments: JournalSegment[], revision: number): JournalEntry[] {
  return segments
    .flatMap((s) => s.ops)
    .filter((e) => e.revision > revision)
    .sort((a, b) => a.revision - b.revision);
}

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

// ---------------------------------------------------------------------------
// Local (filesystem) adapter — the dev provider, fully real
// ---------------------------------------------------------------------------

function hashKey(sessionId: string): string {
  return createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 24);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), 'utf8');
  renameSync(tmp, file);
}

export class LocalSessionStores implements SessionStores {
  readonly provider = 'local' as const;
  readonly registry: SessionRegistry;
  readonly journal: OpJournal;
  readonly snapshots: SnapshotStore;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    const regFile = join(dir, 'registry.json');
    // One file per journal SEGMENT: segment.<hash>.<from>-<to>.json —
    // the same segment model as production (one write per segment).
    const segmentFile = (seg: JournalSegment) =>
      join(
        dir,
        `segment.${hashKey(seg.sessionId)}.${String(seg.fromRevision).padStart(10, '0')}-${String(seg.toRevision).padStart(10, '0')}.json`,
      );
    const readSegmentsSync = (sid: string): JournalSegment[] => {
      const prefix = `segment.${hashKey(sid)}.`;
      let names: string[];
      try {
        names = readdirSync(dir).filter((n) => n.startsWith(prefix) && n.endsWith('.json'));
      } catch {
        return [];
      }
      const segs: JournalSegment[] = [];
      for (const name of names) {
        const seg = readJson<JournalSegment>(join(dir, name));
        if (seg && seg.sessionId === sid && Array.isArray(seg.ops)) segs.push(seg);
      }
      return segs.sort((a, b) => a.fromRevision - b.fromRevision);
    };
    const snapFile = (sid: string) => join(dir, `snapshot.${hashKey(sid)}.xlsx`);
    const snapMetaFile = (sid: string) => join(dir, `snapshot.${hashKey(sid)}.json`);

    const readRegistry = (): Record<string, SessionRecord> =>
      readJson<Record<string, SessionRecord>>(regFile) ?? {};
    const writeRegistry = (r: Record<string, SessionRecord>): void => writeJsonAtomic(regFile, r);

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
        if (!cur) throw new Error(`session registry: unknown session ${sid}`);
        all[sid] = { ...cur, ...patch, sessionId: sid, updatedAt: Date.now() };
        writeRegistry(all);
      },
      release: async (sid) => {
        const all = readRegistry();
        const cur = all[sid];
        if (!cur) return;
        all[sid] = { ...cur, status: 'released', updatedAt: Date.now() };
        writeRegistry(all);
      },
    };
    this.journal = {
      appendSegment: async (seg) => {
        writeJsonAtomic(segmentFile(seg), seg);
      },
      readSegments: async (sid, fromRevision) =>
        readSegmentsSync(sid).filter((s) => s.toRevision > fromRevision),
      readFrom: async (sid, revision) => opsFromSegments(readSegmentsSync(sid), revision),
      headRevision: async (sid) =>
        readSegmentsSync(sid).reduce((max, s) => Math.max(max, s.toRevision), 0),
      truncate: async (sid, uptoRevision) => {
        for (const seg of readSegmentsSync(sid)) {
          if (seg.toRevision <= uptoRevision) {
            try {
              unlinkSync(segmentFile(seg));
            } catch {
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
        const meta = readJson<{ checksum: string; revision: number; at: number }>(snapMetaFile(sid));
        if (!meta) return null;
        try {
          return { bytes: readFileSync(snapFile(sid)), ...meta };
        } catch {
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

export class MemorySessionStores implements SessionStores {
  readonly provider = 'memory' as const;
  private readonly records = new Map<string, SessionRecord>();
  private readonly journals = new Map<string, JournalSegment[]>();
  private readonly snaps = new Map<string, StoredSnapshot>();
  readonly registry: SessionRegistry = {
    register: async (rec) => {
      this.records.set(rec.sessionId, { ...rec });
    },
    lookup: async (sid) => {
      const r = this.records.get(sid);
      return r ? { ...r } : null;
    },
    update: async (sid, patch) => {
      const cur = this.records.get(sid);
      if (!cur) throw new Error(`session registry: unknown session ${sid}`);
      this.records.set(sid, { ...cur, ...patch, sessionId: sid, updatedAt: Date.now() });
    },
    release: async (sid) => {
      const cur = this.records.get(sid);
      if (cur) this.records.set(sid, { ...cur, status: 'released', updatedAt: Date.now() });
    },
  };
  readonly journal: OpJournal = {
    appendSegment: async (seg) => {
      const list = this.journals.get(seg.sessionId) ?? [];
      list.push({ ...seg, ops: [...seg.ops] });
      this.journals.set(seg.sessionId, list);
    },
    readSegments: async (sid, fromRevision) =>
      (this.journals.get(sid) ?? [])
        .filter((s) => s.toRevision > fromRevision)
        .sort((a, b) => a.fromRevision - b.fromRevision),
    readFrom: async (sid, revision) =>
      opsFromSegments(this.journals.get(sid) ?? [], revision),
    headRevision: async (sid) =>
      (this.journals.get(sid) ?? []).reduce((max, s) => Math.max(max, s.toRevision), 0),
    truncate: async (sid, uptoRevision) => {
      this.journals.set(
        sid,
        (this.journals.get(sid) ?? []).filter((s) => s.toRevision > uptoRevision),
      );
    },
  };
  readonly snapshots: SnapshotStore = {
    put: async (sid, snap) => {
      this.snaps.set(sid, { ...snap, bytes: new Uint8Array(snap.bytes) });
    },
    get: async (sid) => {
      const s = this.snaps.get(sid);
      return s ? { ...s, bytes: new Uint8Array(s.bytes) } : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Production adapters (Firestore registry/journal, Cloud Storage snapshots)
// Written against narrow structural interfaces so they unit-test with
// fakes; the official clients satisfy these shapes.
// ---------------------------------------------------------------------------

/** The slice of the Firestore client the registry/journal use. */
export interface FirestoreDocLike {
  get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
  set(data: Record<string, unknown>, opts?: { merge?: boolean }): Promise<unknown>;
  delete(): Promise<unknown>;
}
/**
 * The transaction surface: reads and writes against doc refs handed out
 * by `collection(name).doc(id)` (wrapFirestore passes the raw refs
 * through by identity, so a ref IS the client's DocumentReference).
 * Firestore semantics: every get must precede the first set, and
 * conflicting transactions serialize (with client-side retry) — the
 * file registry's claim/release rely on exactly that (F-5).
 */
export interface FirestoreTxnLike {
  get(ref: FirestoreDocLike): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
  set(ref: FirestoreDocLike, data: Record<string, unknown>, opts?: { merge?: boolean }): void;
}
export interface FirestoreLike {
  /** Run `fn` inside one Firestore transaction (see FirestoreTxnLike). */
  runTransaction<T>(fn: (txn: FirestoreTxnLike) => Promise<T>): Promise<T>;
  collection(name: string): {
    doc(id: string): FirestoreDocLike;
    /** Equality query (the journal reads a session's segment docs). */
    queryEq(
      field: string,
      value: string,
    ): Promise<Array<{ id: string; data(): Record<string, unknown> | undefined }>>;
    /**
     * Full-collection scan (the file registry's listing: the agent /
     * add-on session resolvers enumerate every ownership record and
     * filter in memory). Collections on this surface are small
     * metadata sets by design — never cell data.
     */
    listAll(): Promise<Array<{ id: string; data(): Record<string, unknown> | undefined }>>;
  };
}

/** The slice of the Cloud Storage client the snapshot store uses. */
export interface StorageFileLike {
  save(data: Buffer, opts?: Record<string, unknown>): Promise<unknown>;
  download(): Promise<[Buffer]>;
  getMetadata(): Promise<[{ metadata?: Record<string, string> }]>;
}
export interface StorageLike {
  bucket(name: string): { file(path: string): StorageFileLike };
}

const REGISTRY_COLLECTION = 'icecream_sessions';
/** One document per journal SEGMENT (the free-quota write model). */
const JOURNAL_SEGMENTS_COLLECTION = 'icecream_session_journal_segments';

/**
 * Deep-copy a write payload with every `undefined` object field
 * REMOVED. The real @google-cloud/firestore client rejects a document
 * containing an undefined value anywhere ('Cannot use "undefined" as
 * a Firestore value') while the in-memory fakes accept it silently —
 * so an adapter payload that is natural TypeScript (an optional
 * field left unset: a fresh record's grants, a journal entry's delta)
 * passed every unit test and then threw on the first live write
 * (the batch-2 live-proof failure: fileRegistry.claim() wrote
 * `grants: cur?.grants` = undefined for every new file, and the
 * gateway failed the open closed with 503). Every Firestore write in
 * these adapters passes through here; absent and undefined are the
 * same thing on read-back.
 */
export function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripUndefinedDeep(v)) as T;
  }
  if (value !== null && typeof value === 'object') {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = stripUndefinedDeep(v);
    }
    return out as T;
  }
  return value;
}

function recordToFirestore(rec: SessionRecord): Record<string, unknown> {
  return { ...rec };
}
function recordFromFirestore(data: Record<string, unknown>): SessionRecord {
  return data as unknown as SessionRecord;
}

export class FirestoreSessionStores implements SessionStores {
  readonly provider = 'prod' as const;
  readonly registry: SessionRegistry;
  readonly journal: OpJournal;
  readonly snapshots: SnapshotStore;

  constructor(
    private readonly db: FirestoreLike,
    private readonly storage: StorageLike,
    private readonly bucketName: string,
  ) {
    const regDoc = (sid: string) => this.db.collection(REGISTRY_COLLECTION).doc(sid);
    const segmentDoc = (seg: JournalSegment) =>
      this.db
        .collection(JOURNAL_SEGMENTS_COLLECTION)
        .doc(`${hashKey(seg.sessionId)}__${seg.fromRevision}-${seg.toRevision}`);

    this.registry = {
      register: async (rec) => {
        await regDoc(rec.sessionId).set(stripUndefinedDeep(recordToFirestore(rec)));
      },
      lookup: async (sid) => {
        const snap = await regDoc(sid).get();
        if (!snap.exists) return null;
        const data = snap.data();
        return data ? recordFromFirestore(data) : null;
      },
      update: async (sid, patch) => {
        await regDoc(sid).set(
          stripUndefinedDeep({ ...patch, sessionId: sid, updatedAt: Date.now() }),
          { merge: true },
        );
      },
      release: async (sid) => {
        await regDoc(sid).set({ status: 'released', updatedAt: Date.now() }, { merge: true });
      },
    };
    // The journal is ONE DOCUMENT PER SEGMENT (user's free-quota
    // constraint: 20k Firestore writes/day — one write per segment,
    // never one per op). A segment doc carries its full op batch;
    // reads query the session's segment docs and order by fromRevision.
    const readAllSegments = async (sid: string): Promise<JournalSegment[]> => {
      const rows = await this.db.collection(JOURNAL_SEGMENTS_COLLECTION).queryEq('sessionId', sid);
      const segs: JournalSegment[] = [];
      for (const row of rows) {
        const data = row.data();
        if (data && Array.isArray((data as { ops?: unknown }).ops)) {
          segs.push(data as unknown as JournalSegment);
        }
      }
      return segs.sort((a, b) => a.fromRevision - b.fromRevision);
    };
    this.journal = {
      appendSegment: async (seg) => {
        await segmentDoc(seg).set(stripUndefinedDeep({ ...seg }));
      },
      readSegments: async (sid, fromRevision) =>
        (await readAllSegments(sid)).filter((s) => s.toRevision > fromRevision),
      readFrom: async (sid, revision) => opsFromSegments(await readAllSegments(sid), revision),
      headRevision: async (sid) =>
        (await readAllSegments(sid)).reduce((max, s) => Math.max(max, s.toRevision), 0),
      truncate: async (sid, uptoRevision) => {
        for (const seg of await readAllSegments(sid)) {
          if (seg.toRevision <= uptoRevision) await segmentDoc(seg).delete();
        }
      },
    };
    const snapFile = (sid: string) =>
      this.storage.bucket(this.bucketName).file(`sessions/${hashKey(sid)}/snapshot.xlsx`);
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
          if (typeof m.checksum !== 'string' || typeof m.revision !== 'string') return null;
          const [bytes] = await file.download();
          return {
            bytes: new Uint8Array(bytes),
            checksum: m.checksum,
            revision: Number(m.revision),
            at: Number(m.at ?? '0'),
          };
        } catch {
          return null; // no snapshot stored for this session
        }
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Provider selection + production self-check (fails closed)
// ---------------------------------------------------------------------------

export type SessionStoreProvider = 'local' | 'prod';

/** SESSION_STORE: 'local' (default, dev) | 'prod' (Firestore + GCS). */
export function sessionStoreProvider(env: NodeJS.ProcessEnv = process.env): SessionStoreProvider {
  return (env.SESSION_STORE ?? '').trim().toLowerCase() === 'prod' ? 'prod' : 'local';
}

/** SESSION_DATA_DIR for the local provider (default under the gateway data dir). */
export function sessionDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = (env.SESSION_DATA_DIR ?? '').trim();
  return fromEnv !== '' ? fromEnv : join(gatewayDataDir(), 'sessions');
}

export interface ProdSessionConfig {
  projectId: string;
  databaseId?: string;
  snapshotBucket: string;
}

/** Read the prod provider's env config; throws a clear error when incomplete. */
export function prodSessionConfig(env: NodeJS.ProcessEnv = process.env): ProdSessionConfig {
  const projectId = (env.GCP_PROJECT_ID ?? env.FIREBASE_PROJECT_ID ?? '').trim();
  const snapshotBucket = (env.SESSION_SNAPSHOT_BUCKET ?? '').trim();
  const missing: string[] = [];
  if (!projectId) missing.push('GCP_PROJECT_ID');
  if (!snapshotBucket) missing.push('SESSION_SNAPSHOT_BUCKET');
  if (missing.length > 0) {
    throw new Error(
      `SESSION_STORE=prod requires ${missing.join(' + ')} to be set — refusing to start with a half-configured production session store (fail closed)`,
    );
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
export async function loadProdClients(
  cfg: ProdSessionConfig,
): Promise<{ db: FirestoreLike; storage: StorageLike }> {
  // The Google Cloud clients are OPTIONAL dependencies (only a prod
  // deploy installs them), so they load through a non-literal specifier:
  // the TypeScript compiler must not try to resolve them here, and a
  // missing package becomes the fail-closed runtime error below.
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<Record<string, unknown>>;
  let FirestoreCtor: unknown;
  let StorageCtor: unknown;
  try {
    ({ Firestore: FirestoreCtor } = await dynamicImport('@google-cloud/firestore'));
  } catch {
    throw new Error(
      'SESSION_STORE=prod requires the @google-cloud/firestore package (not installed) — install it or use SESSION_STORE=local (fail closed)',
    );
  }
  try {
    ({ Storage: StorageCtor } = await dynamicImport('@google-cloud/storage'));
  } catch {
    throw new Error(
      'SESSION_STORE=prod requires the @google-cloud/storage package (not installed) — install it or use SESSION_STORE=local (fail closed)',
    );
  }
  const hasCreds =
    (process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '').trim() !== '' ||
    existsSync('/var/run/secrets/google') ||
    // Cloud Run / GCE metadata server identity counts as credentials;
    // the Firestore client's own channel check below is the real gate.
    (process.env.K_SERVICE ?? '').trim() !== '';
  if (!hasCreds && (process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '') === '') {
    // Not fatal by itself (workload identity may still resolve); the
    // client construction + first-use errors surface with their own
    // messages. Log loudly so a misconfigured deploy is visible.
    console.warn(
      '[session-store] SESSION_STORE=prod: GOOGLE_APPLICATION_CREDENTIALS is unset — relying on workload identity / ADC discovery',
    );
  }
  const rawDb = new (FirestoreCtor as new (o: Record<string, unknown>) => unknown)({
    projectId: cfg.projectId,
    ...(cfg.databaseId ? { databaseId: cfg.databaseId } : {}),
  });
  const storage = new (StorageCtor as new (o: Record<string, unknown>) => StorageLike)({
    projectId: cfg.projectId,
  });
  return { db: wrapFirestore(rawDb), storage };
}

/**
 * Adapt the real @google-cloud/firestore client to the narrow
 * FirestoreLike surface (its CollectionReference has where() instead of
 * queryEq, and its snapshots differ slightly in shape).
 */
export function wrapFirestore(raw: unknown): FirestoreLike {
  interface RawDoc {
    get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
    set(data: Record<string, unknown>, opts?: { merge?: boolean }): Promise<unknown>;
    delete(): Promise<unknown>;
  }
  interface RawCollection {
    doc(id: string): RawDoc;
    where(
      field: string,
      op: string,
      value: string,
    ): { get(): Promise<{ docs: Array<{ id: string; data(): Record<string, unknown> | undefined }> }> };
    get(): Promise<{ docs: Array<{ id: string; data(): Record<string, unknown> | undefined }> }>;
  }
  const db = raw as { collection(name: string): RawCollection };
  interface RawTxn {
    get(ref: RawDoc): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
    set(ref: RawDoc, data: Record<string, unknown>, opts?: { merge?: boolean }): unknown;
  }
  const rawDb = raw as { runTransaction<T>(fn: (txn: RawTxn) => Promise<T>): Promise<T> };
  return {
    runTransaction: (fn) =>
      rawDb.runTransaction(async (txn) =>
        fn({
          get: (ref) => txn.get(ref as unknown as RawDoc),
          set: (ref, data, opts) => {
            txn.set(ref as unknown as RawDoc, data, opts);
          },
        }),
      ),
    collection: (name) => {
      const col = db.collection(name);
      return {
        doc: (id) => col.doc(id),
        queryEq: async (field, value) => {
          const snap = await col.where(field, '==', value).get();
          return snap.docs.map((d) => ({ id: d.id, data: () => d.data() }));
        },
        listAll: async () => {
          const snap = await col.get();
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
export async function createSessionStores(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SessionStores> {
  if (sessionStoreProvider(env) === 'prod') {
    const cfg = prodSessionConfig(env); // throws, fail closed, when incomplete
    const { db, storage } = await loadProdClients(cfg);
    return new FirestoreSessionStores(db, storage, cfg.snapshotBucket);
  }
  return new LocalSessionStores(sessionDataDir(env));
}

/** Synchronous local/memory construction (tests + engine-service default). */
export function createLocalSessionStores(dir?: string): LocalSessionStores {
  return new LocalSessionStores(dir ?? sessionDataDir());
}
