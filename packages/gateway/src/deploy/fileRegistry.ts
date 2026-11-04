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

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { sessionDataDir, stripUndefinedDeep, type FirestoreLike } from './sessionStore.js';

// ---------------------------------------------------------------------------
// Record + interface
// ---------------------------------------------------------------------------

/** A session participant's co-authoring role (mirrors EngineAccessRole). */
export type RegistryRole = 'editor' | 'viewer';

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
  /**
   * Joiners recorded at /api/engine/open time: principal → the role
   * the gateway minted that principal's join token with. Optional:
   * records written before this field existed (or by a bare claim)
   * simply have no participants. The creator is NOT listed here —
   * creatorPrincipal already names them (always an editor).
   */
  participants?: Record<string, RegistryRole>;
  /**
   * Owner-recorded access grants: principal → role, written ONLY by
   * the file's creator through POST /api/engine/share (noteGrant).
   * Unlike participants (join-time, advisory), grants are the
   * AUTHORITATIVE role source at /api/engine/open: the effective role
   * minted for a non-creator is their grant when one is on record, and
   * a join request can never raise a principal above their grant
   * (issue #51 — read-only enforcement). Grants SURVIVE claims: the
   * gateway carries them into each new claim record, as it does
   * creatorPrincipal. The creator is NOT listed here either.
   */
  grants?: Record<string, RegistryRole>;
  /**
   * Access-list audit trail (issue #51, design doc section 5): every
   * grant change appends { at, by, principal, role } (role null = the
   * grant was revoked). `by` is the owner principal who made the
   * change. Capped at the most recent 50 entries. Like grants, the
   * log survives claims (adapters preserve the stored log at CAS
   * time) and lives ONLY in this record — never in workbook bytes.
   */
  aclLog?: Array<{ at: number; by: string; principal: string; role: RegistryRole | null; transfer?: { from: string; to: string } }>;
  /**
   * Link sharing (issue #84, design doc section 5): when set, ANY
   * signed-in principal with no explicit grant opens with this role
   * — "anyone with the link". Null/absent = link sharing off, and
   * ungranted principals are denied outright (section 4). Written
   * ONLY by the file's creator through POST /api/engine/share/link
   * (noteLinkShare). Like grants, it SURVIVES claims (adapters
   * preserve the stored value at CAS time).
   */
  linkShare?: { role: RegistryRole } | null;
}

/**
 * THE authoritative access check (issue #51, design doc
 * read-only-enforcement section 8). The file-owning layer — this
 * registry and the session/engine services built on it — owns
 * file-permission logic; the gateway's HTTP handlers only verify
 * identity and enforce this verdict. Every consumer (engine open,
 * per-request op/read gating, agent session resolution, trigger
 * supervisor, the share endpoint) resolves roles through here, on
 * the CURRENT record, never from a role stamped at the edge.
 *
 * Roles (section 6 — exactly three): 'owner' (the record's
 * creatorPrincipal: content writes + ACL changes + file deletion),
 * 'editor' (an owner-recorded grant: content writes only), 'viewer'
 * (a grant: reads only). No grant -> null -> denied entirely.
 * A null record means no ACL exists yet — the principal creating
 * the file is its owner.
 */
export type AclRole = 'owner' | 'editor' | 'viewer';

export function aclRoleFor(rec: FileRegistryRecord | null, principal: string): AclRole | null {
  if (!rec) return 'owner';
  if (principal === rec.creatorPrincipal) return 'owner';
  const grant = rec.grants?.[principal];
  if (grant === 'editor' || grant === 'viewer') return grant;
  // Link sharing (issue #84): an ungranted principal opens with the
  // link role while link sharing is on. Every consumer resolves
  // through here — the catalog guard, open role resolution, agent
  // binding — so link users flow exactly like grantees of that role,
  // and 'acl' actions stay owner-only (aclAllows checks role).
  const linkRole = rec.linkShare?.role;
  return linkRole === 'editor' || linkRole === 'viewer' ? linkRole : null;
}

/** Action-level verdict on top of aclRoleFor. */
export function aclAllows(
  rec: FileRegistryRecord | null,
  principal: string,
  action: 'open' | 'read' | 'write' | 'acl',
): boolean {
  const role = aclRoleFor(rec, principal);
  if (!role) return false;
  if (action === 'acl') return role === 'owner';
  if (action === 'write') return role === 'owner' || role === 'editor';
  return true; // 'open' | 'read': any recorded role may
}

export interface FileRegistry {
  /** The record for a file, or null when the file was never claimed. */
  lookup(fileId: string): Promise<FileRegistryRecord | null>;
  /**
   * EVERY record in the registry, live and dead alike (copies). This
   * is the enumeration the agent / add-on session resolvers consume
   * (agentSessionResolver.ts): they apply the SAME liveness and
   * principal filters (isLiveOwner, creator/participant match) to a
   * listing from any adapter, so dead-lease records are excluded
   * identically no matter which store backs the registry — exactly
   * as records read from the local registry file are today.
   */
  listAll(): Promise<FileRegistryRecord[]>;
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
  heartbeat(
    fileId: string,
    sessionId: string,
    epoch: number,
    currentRevision: number,
    storedRevision: number,
  ): Promise<boolean>;
  /**
   * Clear the lease (session released / evicted). The record survives
   * with its epoch so the next claim CASes against it. Returns false
   * when the caller does not hold the current epoch/session.
   */
  release(fileId: string, sessionId: string, epoch: number): Promise<boolean>;
  /**
   * Record (or refresh) a JOINER on the live record: participants[
   * principal] = role. Applies ONLY when the stored record matches
   * (sessionId, epoch) and its lease is still live — a note against a
   * dead or replaced record is meaningless and returns false. Never
   * touches ownership fields, revision counters, or updatedAt (the
   * owner's heartbeats own those); participants are advisory metadata
   * for the agent session resolver.
   */
  noteParticipant(
    fileId: string,
    sessionId: string,
    epoch: number,
    principal: string,
    role: RegistryRole,
  ): Promise<boolean>;
  /**
   * Record (or revoke, role = null) an OWNER grant for a principal:
   * grants[principal] = role, mirrored into participants so the agent
   * session resolver sees the same role immediately. Applies whenever
   * a record exists for the file, live session or not — an owner can
   * share a file before anyone opens it. Returns false when no record
   * exists. Authorization (creator-only) is the gateway's job; this
   * method only persists. Never touches ownership fields or counters.
   */
  noteGrant(
    fileId: string,
    principal: string,
    role: RegistryRole | null,
    by: string,
  ): Promise<boolean>;
  /**
   * Record (or switch off, role = null) the file's LINK-sharing role:
   * linkShare = { role } or null. Applies whenever a record exists
   * for the file, live session or not. Returns false when no record
   * exists. Authorization (creator-only) is the gateway's job; this
   * method only persists. Never touches ownership fields or counters.
   */
  noteLinkShare(fileId: string, role: RegistryRole | null, by: string): Promise<boolean>;
  /**
   * Transfer ownership of the file to a principal who ALREADY holds a
   * grant on it (the gateway enforces that precondition — a transfer
   * to a never-seen principal would orphan the file): creatorPrincipal
   * becomes the new owner, the new owner's grant is removed (the owner
   * is never in grants), and the previous owner becomes an editor
   * grant. Applies whenever a record exists for the file. Returns
   * false when no record exists. Authorization (current-owner-only)
   * is the gateway's job; this method only persists.
   */
  transferOwnership(fileId: string, newOwner: string, by: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Env config
// ---------------------------------------------------------------------------

/** OWNERSHIP_LEASE_MS: lease TTL for an ownership record. Default 30 s. */
export function ownershipLeaseMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.OWNERSHIP_LEASE_MS ?? '30000');
  return Number.isFinite(n) && n >= 250 ? Math.floor(n) : 30_000;
}

/** OWNERSHIP_HEARTBEAT_MS: owner heartbeat cadence. Default lease/3. */
export function ownershipHeartbeatMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.OWNERSHIP_HEARTBEAT_MS ?? '');
  if (Number.isFinite(n) && n >= 50) return Math.floor(n);
  return Math.max(50, Math.floor(ownershipLeaseMs(env) / 3));
}

/** FILE_REGISTRY_DIR: local adapter root (default under SESSION_DATA_DIR). */
export function fileRegistryDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = (env.FILE_REGISTRY_DIR ?? '').trim();
  return fromEnv !== '' ? fromEnv : join(sessionDataDir(env), 'file-registry');
}

/** FILE_REGISTRY_STORE: 'local' (default) | 'prod' (Firestore). */
export function fileRegistryProvider(env: NodeJS.ProcessEnv = process.env): 'local' | 'prod' {
  const v = (env.FILE_REGISTRY_STORE ?? '').trim().toLowerCase();
  if (v === 'prod' || v === 'firestore') return 'prod';
  if (v === 'local') return 'local';
  // Deployments running the prod session store get the prod registry
  // too — the registry must live in the same shared database (§9).
  return (env.SESSION_STORE ?? '').trim().toLowerCase() === 'prod' ? 'prod' : 'local';
}

/** A record is a LIVE owner when its lease has not expired. */
export function isLiveOwner(rec: FileRegistryRecord | null, nowMs = Date.now()): boolean {
  return rec !== null && typeof rec.leaseExpiry === 'number' && rec.leaseExpiry > nowMs;
}

// ---------------------------------------------------------------------------
// Local (filesystem) adapter — cross-process lockfile mutex + atomic rename
// ---------------------------------------------------------------------------

const LOCK_SPIN_MS = 5;
const LOCK_TIMEOUT_MS = 10_000;
/** A lock older than this is treated as abandoned (holder crashed). */
const LOCK_STALE_MS = 30_000;

function sleepSync(ms: number): void {
  // Synchronous spin-wait for the mutex: the critical sections below
  // are fully synchronous, so a blocked event loop here can only be
  // for the (tiny) duration of another holder's JSON rewrite.
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

/**
 * The pure grant mutation shared by all three adapters: apply a
 * grant/revoke to a record's grants + participants mirror and append
 * the section-5 audit entry (capped at the most recent 50).
 */
function applyGrant(
  cur: FileRegistryRecord,
  principal: string,
  role: RegistryRole | null,
  by: string,
): Pick<FileRegistryRecord, 'grants' | 'participants' | 'aclLog'> {
  const grants = { ...(cur.grants ?? {}) };
  const participants = { ...(cur.participants ?? {}) };
  if (role === null) {
    delete grants[principal];
    delete participants[principal];
  } else {
    grants[principal] = role;
    participants[principal] = role;
  }
  const aclLog = [...(cur.aclLog ?? []), { at: Date.now(), by, principal, role }].slice(-50);
  return { grants, participants, aclLog };
}

/**
 * The pure link-share mutation shared by all three adapters: set or
 * clear linkShare and append the section-5 audit entry (principal
 * 'link' — it is a file-wide setting, not a person's grant — capped
 * at the most recent 50 entries with the rest of the log).
 */
function applyLinkShare(
  cur: FileRegistryRecord,
  role: RegistryRole | null,
  by: string,
): Pick<FileRegistryRecord, 'linkShare' | 'aclLog'> {
  const aclLog = [...(cur.aclLog ?? []), { at: Date.now(), by, principal: 'link', role }].slice(-50);
  return { linkShare: role === null ? null : { role }, aclLog };
}

/**
 * The pure ownership-transfer mutation shared by all three adapters:
 * the previous owner becomes an editor grant (they keep access until
 * the new owner changes it), the new owner's grant is removed, the
 * participants mirror follows, and one transfer-marked audit entry
 * records who handed what to whom (role null + the transfer marker
 * disambiguates it from a plain revoke).
 */
function applyTransfer(
  cur: FileRegistryRecord,
  newOwner: string,
  by: string,
): Pick<FileRegistryRecord, 'creatorPrincipal' | 'grants' | 'participants' | 'aclLog'> {
  const previousOwner = cur.creatorPrincipal;
  const grants = { ...(cur.grants ?? {}) };
  const participants = { ...(cur.participants ?? {}) };
  delete grants[newOwner];
  delete participants[newOwner];
  grants[previousOwner] = 'editor';
  participants[previousOwner] = 'editor';
  const aclLog = [
    ...(cur.aclLog ?? []),
    { at: Date.now(), by, principal: newOwner, role: null, transfer: { from: previousOwner, to: newOwner } },
  ].slice(-50);
  return { creatorPrincipal: newOwner, grants, participants, aclLog };
}

export class LocalFileRegistry implements FileRegistry {
  private readonly file: string;
  private readonly lockFile: string;
  private readonly leaseMs: number;

  constructor(
    private readonly dir: string,
    opts: { leaseMs?: number } = {},
  ) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'file-registry.json');
    this.lockFile = join(dir, 'file-registry.lock');
    this.leaseMs = opts.leaseMs ?? ownershipLeaseMs();
  }

  /** Acquire the cross-process mutex; throws on timeout / IO error. */
  private acquireLock(): void {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = openSync(this.lockFile, 'wx');
        writeFileSync(fd, `${process.pid} ${Date.now()}`);
        closeSync(fd);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
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
        } catch {
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

  private releaseLock(): void {
    try {
      unlinkSync(this.lockFile);
    } catch {
      // Already gone (stale-recovered by a peer); nothing to do.
    }
  }

  private withLock<T>(fn: () => T): T {
    this.acquireLock();
    try {
      return fn();
    } finally {
      this.releaseLock();
    }
  }

  /** Read all records. A missing file is an empty registry; any other
   *  IO error or a corrupt file THROWS (fail closed). */
  private readAll(): Record<string, FileRegistryRecord> {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
      throw e;
    }
    const parsed = JSON.parse(text) as Record<string, FileRegistryRecord>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('file registry: corrupt registry file (fail closed)');
    }
    return parsed;
  }

  private writeAll(all: Record<string, FileRegistryRecord>): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all), 'utf8');
    renameSync(tmp, this.file);
  }

  async lookup(fileId: string): Promise<FileRegistryRecord | null> {
    return this.withLock(() => {
      const rec = this.readAll()[fileId];
      return rec ? { ...rec } : null;
    });
  }

  async listAll(): Promise<FileRegistryRecord[]> {
    return this.withLock(() => Object.values(this.readAll()).map((rec) => ({ ...rec })));
  }

  async claim(record: FileRegistryRecord, expectedEpoch: number | null): Promise<boolean> {
    return this.withLock(() => {
      const all = this.readAll();
      const cur = all[record.fileId];
      if (expectedEpoch === null) {
        if (cur) return false;
        if (record.ownershipEpoch !== 1) return false;
      } else {
        if (!cur || cur.ownershipEpoch !== expectedEpoch) return false;
        if (record.ownershipEpoch !== expectedEpoch + 1) return false;
      }
      // Grants are mutated ONLY by noteGrant (owner-checked): the
      // STORED grants at CAS time are authoritative, so a grant that
      // landed after the caller's lookup survives the claim (issue
      // #51 storage discipline — grant writes and claims serialize
      // under the same lock and never overwrite each other).
      all[record.fileId] = { ...record, creatorPrincipal: cur?.creatorPrincipal ?? record.creatorPrincipal, grants: cur?.grants, aclLog: cur?.aclLog, linkShare: cur?.linkShare, updatedAt: Date.now() };
      this.writeAll(all);
      return true;
    });
  }

  // A heartbeat may NEVER revive a released record (leaseExpiry 0):
  // release is terminal for a record until a fresh CAS claim writes
  // a whole new one. Without the lease check, an ownership heartbeat
  // already in flight when its session is released (idle sweep, cap
  // eviction, leave) re-extends the dead lease and the record looks
  // live again — re-opens then JOIN a dead session until it lapses.
  // (Same guard in all three adapters' heartbeat.)
  async heartbeat(
    fileId: string,
    sessionId: string,
    epoch: number,
    currentRevision: number,
    storedRevision: number,
  ): Promise<boolean> {
    return this.withLock(() => {
      const all = this.readAll();
      const cur = all[fileId];
      if (!cur || cur.leaseExpiry === 0 || cur.sessionId !== sessionId || cur.ownershipEpoch !== epoch) return false;
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

  async release(fileId: string, sessionId: string, epoch: number): Promise<boolean> {
    return this.withLock(() => {
      const all = this.readAll();
      const cur = all[fileId];
      if (!cur || cur.sessionId !== sessionId || cur.ownershipEpoch !== epoch) return false;
      all[fileId] = { ...cur, leaseExpiry: 0, updatedAt: Date.now() };
      this.writeAll(all);
      return true;
    });
  }

  async noteParticipant(
    fileId: string,
    sessionId: string,
    epoch: number,
    principal: string,
    role: RegistryRole,
  ): Promise<boolean> {
    return this.withLock(() => {
      const all = this.readAll();
      const cur = all[fileId];
      if (!cur || cur.sessionId !== sessionId || cur.ownershipEpoch !== epoch) return false;
      if (!(cur.leaseExpiry > Date.now())) return false; // dead lease: no live session to join
      all[fileId] = {
        ...cur,
        participants: { ...(cur.participants ?? {}), [principal]: role },
      };
      this.writeAll(all);
      return true;
    });
  }

  async noteGrant(
    fileId: string,
    principal: string,
    role: RegistryRole | null,
    by: string,
  ): Promise<boolean> {
    return this.withLock(() => {
      const all = this.readAll();
      const cur = all[fileId];
      if (!cur) return false;
      all[fileId] = { ...cur, ...applyGrant(cur, principal, role, by) };
      this.writeAll(all);
      return true;
    });
  }

  async noteLinkShare(fileId: string, role: RegistryRole | null, by: string): Promise<boolean> {
    return this.withLock(() => {
      const all = this.readAll();
      const cur = all[fileId];
      if (!cur) return false;
      all[fileId] = { ...cur, ...applyLinkShare(cur, role, by) };
      this.writeAll(all);
      return true;
    });
  }

  async transferOwnership(fileId: string, newOwner: string, by: string): Promise<boolean> {
    return this.withLock(() => {
      const all = this.readAll();
      const cur = all[fileId];
      if (!cur) return false;
      all[fileId] = { ...cur, ...applyTransfer(cur, newOwner, by) };
      this.writeAll(all);
      return true;
    });
  }
}

// ---------------------------------------------------------------------------
// In-memory adapter — interface-level fake for unit tests.
// ---------------------------------------------------------------------------

export class MemoryFileRegistry implements FileRegistry {
  private readonly records = new Map<string, FileRegistryRecord>();
  constructor(private readonly leaseMs: number = 30_000) {}

  async lookup(fileId: string): Promise<FileRegistryRecord | null> {
    const rec = this.records.get(fileId);
    return rec ? { ...rec } : null;
  }

  async listAll(): Promise<FileRegistryRecord[]> {
    return [...this.records.values()].map((rec) => ({ ...rec }));
  }

  async claim(record: FileRegistryRecord, expectedEpoch: number | null): Promise<boolean> {
    const cur = this.records.get(record.fileId);
    if (expectedEpoch === null) {
      if (cur || record.ownershipEpoch !== 1) return false;
    } else {
      if (!cur || cur.ownershipEpoch !== expectedEpoch) return false;
      if (record.ownershipEpoch !== expectedEpoch + 1) return false;
    }
    // Stored grants are authoritative at claim time (see the Local
    // adapter's note): a concurrent noteGrant is never overwritten.
    this.records.set(record.fileId, { ...record, creatorPrincipal: cur?.creatorPrincipal ?? record.creatorPrincipal, grants: cur?.grants, aclLog: cur?.aclLog, linkShare: cur?.linkShare, updatedAt: Date.now() });
    return true;
  }

  async heartbeat(
    fileId: string,
    sessionId: string,
    epoch: number,
    currentRevision: number,
    storedRevision: number,
  ): Promise<boolean> {
    const cur = this.records.get(fileId);
    if (!cur || cur.leaseExpiry === 0 || cur.sessionId !== sessionId || cur.ownershipEpoch !== epoch) return false;
    this.records.set(fileId, {
      ...cur,
      leaseExpiry: Date.now() + this.leaseMs,
      currentRevision,
      storedRevision,
      updatedAt: Date.now(),
    });
    return true;
  }

  async release(fileId: string, sessionId: string, epoch: number): Promise<boolean> {
    const cur = this.records.get(fileId);
    if (!cur || cur.sessionId !== sessionId || cur.ownershipEpoch !== epoch) return false;
    this.records.set(fileId, { ...cur, leaseExpiry: 0, updatedAt: Date.now() });
    return true;
  }

  async noteParticipant(
    fileId: string,
    sessionId: string,
    epoch: number,
    principal: string,
    role: RegistryRole,
  ): Promise<boolean> {
    const cur = this.records.get(fileId);
    if (!cur || cur.sessionId !== sessionId || cur.ownershipEpoch !== epoch) return false;
    if (!(cur.leaseExpiry > Date.now())) return false;
    this.records.set(fileId, {
      ...cur,
      participants: { ...(cur.participants ?? {}), [principal]: role },
    });
    return true;
  }

  async noteGrant(
    fileId: string,
    principal: string,
    role: RegistryRole | null,
    by: string,
  ): Promise<boolean> {
    const cur = this.records.get(fileId);
    if (!cur) return false;
    this.records.set(fileId, { ...cur, ...applyGrant(cur, principal, role, by) });
    return true;
  }

  async noteLinkShare(fileId: string, role: RegistryRole | null, by: string): Promise<boolean> {
    const cur = this.records.get(fileId);
    if (!cur) return false;
    this.records.set(fileId, { ...cur, ...applyLinkShare(cur, role, by) });
    return true;
  }

  async transferOwnership(fileId: string, newOwner: string, by: string): Promise<boolean> {
    const cur = this.records.get(fileId);
    if (!cur) return false;
    this.records.set(fileId, { ...cur, ...applyTransfer(cur, newOwner, by) });
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
export class FirestoreFileRegistry implements FileRegistry {
  constructor(
    private readonly db: FirestoreLike,
    private readonly leaseMs: number = 30_000,
  ) {}

  private doc(fileId: string) {
    return this.db.collection(FILE_REGISTRY_COLLECTION).doc(fileId);
  }

  async lookup(fileId: string): Promise<FileRegistryRecord | null> {
    const snap = await this.doc(fileId).get();
    if (!snap.exists) return null;
    const data = snap.data();
    return data ? (data as unknown as FileRegistryRecord) : null;
  }

  async listAll(): Promise<FileRegistryRecord[]> {
    const rows = await this.db.collection(FILE_REGISTRY_COLLECTION).listAll();
    const out: FileRegistryRecord[] = [];
    for (const row of rows) {
      const data = row.data();
      // A malformed document is skipped, never surfaced as a record:
      // the resolvers trust a listing the way they trust the registry
      // file, and a doc without the record's identity fields is not a
      // session anyone may bind to.
      if (
        data &&
        typeof (data as { fileId?: unknown }).fileId === 'string' &&
        typeof (data as { sessionId?: unknown }).sessionId === 'string'
      ) {
        out.push({ ...(data as unknown as FileRegistryRecord) });
      }
    }
    return out;
  }

  /**
   * F-5: claim/heartbeat/release/noteParticipant run inside ONE
   * Firestore transaction each — the epoch/session fencing check and
   * the write are atomic. The previous read→check→set→re-read shape
   * let two racing claimants both pass the check (two live owners) and
   * let a stale owner's release land after a takeover (TOCTOU evicting
   * the current owner). Firestore serializes conflicting transactions,
   * so exactly one racer commits and the other observes the winner's
   * record and reports false.
   */
  async claim(record: FileRegistryRecord, expectedEpoch: number | null): Promise<boolean> {
    const ref = this.doc(record.fileId);
    return this.db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      const cur = snap.exists ? (snap.data() as unknown as FileRegistryRecord | undefined) : undefined;
      if (expectedEpoch === null) {
        if (cur || record.ownershipEpoch !== 1) return false;
      } else {
        if (!cur || cur.ownershipEpoch !== expectedEpoch) return false;
        if (record.ownershipEpoch !== expectedEpoch + 1) return false;
      }
      // Stored grants are authoritative at claim time (see the Local
      // adapter's note): read inside this transaction, a concurrent
      // noteGrant either commits first (and is preserved here) or
      // retries against the claimed record. stripUndefinedDeep: for a
      // NEW file cur is undefined, so grants/aclLog are undefined —
      // and the real Firestore client rejects undefined document
      // values outright (the batch-2 live-proof 503; the test fakes
      // accepted them silently).
      txn.set(
        ref,
        stripUndefinedDeep({
          ...record,
          creatorPrincipal: cur?.creatorPrincipal ?? record.creatorPrincipal,
          grants: cur?.grants,
          aclLog: cur?.aclLog,
          linkShare: cur?.linkShare,
          updatedAt: Date.now(),
        }) as unknown as Record<string, unknown>,
      );
      return true;
    });
  }

  async heartbeat(
    fileId: string,
    sessionId: string,
    epoch: number,
    currentRevision: number,
    storedRevision: number,
  ): Promise<boolean> {
    const ref = this.doc(fileId);
    return this.db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      const cur = snap.exists ? (snap.data() as unknown as FileRegistryRecord | undefined) : undefined;
      if (!cur || cur.leaseExpiry === 0 || cur.sessionId !== sessionId || cur.ownershipEpoch !== epoch) return false;
      txn.set(
        ref,
        {
          leaseExpiry: Date.now() + this.leaseMs,
          currentRevision,
          storedRevision,
          updatedAt: Date.now(),
        } as unknown as Record<string, unknown>,
        { merge: true },
      );
      return true;
    });
  }

  async release(fileId: string, sessionId: string, epoch: number): Promise<boolean> {
    const ref = this.doc(fileId);
    return this.db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      const cur = snap.exists ? (snap.data() as unknown as FileRegistryRecord | undefined) : undefined;
      // The fencing check is INSIDE the transaction: a release from a
      // stale epoch can never zero the CURRENT owner's lease.
      if (!cur || cur.sessionId !== sessionId || cur.ownershipEpoch !== epoch) return false;
      txn.set(
        ref,
        { leaseExpiry: 0, updatedAt: Date.now() } as unknown as Record<string, unknown>,
        { merge: true },
      );
      return true;
    });
  }

  async noteParticipant(
    fileId: string,
    sessionId: string,
    epoch: number,
    principal: string,
    role: RegistryRole,
  ): Promise<boolean> {
    const ref = this.doc(fileId);
    return this.db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      const cur = snap.exists ? (snap.data() as unknown as FileRegistryRecord | undefined) : undefined;
      if (!cur || cur.sessionId !== sessionId || cur.ownershipEpoch !== epoch) return false;
      if (!(cur.leaseExpiry > Date.now())) return false;
      // The read-modify-write of the advisory map is atomic now (it
      // previously raced simultaneous joiners and could drop an entry).
      txn.set(
        ref,
        {
          participants: { ...(cur.participants ?? {}), [principal]: role },
        } as unknown as Record<string, unknown>,
        { merge: true },
      );
      return true;
    });
  }

  async noteGrant(
    fileId: string,
    principal: string,
    role: RegistryRole | null,
    by: string,
  ): Promise<boolean> {
    const ref = this.doc(fileId);
    return this.db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      const cur = snap.exists ? (snap.data() as unknown as FileRegistryRecord | undefined) : undefined;
      if (!cur) return false;
      txn.set(
        ref,
        applyGrant(cur, principal, role, by) as unknown as Record<string, unknown>,
        { merge: true },
      );
      return true;
    });
  }

  async noteLinkShare(fileId: string, role: RegistryRole | null, by: string): Promise<boolean> {
    const ref = this.doc(fileId);
    return this.db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      const cur = snap.exists ? (snap.data() as unknown as FileRegistryRecord | undefined) : undefined;
      if (!cur) return false;
      txn.set(
        ref,
        applyLinkShare(cur, role, by) as unknown as Record<string, unknown>,
        { merge: true },
      );
      return true;
    });
  }

  async transferOwnership(fileId: string, newOwner: string, by: string): Promise<boolean> {
    const ref = this.doc(fileId);
    return this.db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      const cur = snap.exists ? (snap.data() as unknown as FileRegistryRecord | undefined) : undefined;
      if (!cur) return false;
      txn.set(
        ref,
        applyTransfer(cur, newOwner, by) as unknown as Record<string, unknown>,
        { merge: true },
      );
      return true;
    });
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
export function createFileRegistry(
  env: NodeJS.ProcessEnv = process.env,
  opts: { firestoreDb?: FirestoreLike; dir?: string; leaseMs?: number } = {},
): FileRegistry {
  if (fileRegistryProvider(env) === 'prod') {
    if (!opts.firestoreDb) {
      throw new Error(
        'file registry: FILE_REGISTRY_STORE=prod requires a Firestore client (credentials) — refusing to fall back to a local store (fail closed)',
      );
    }
    return new FirestoreFileRegistry(opts.firestoreDb, opts.leaseMs ?? ownershipLeaseMs(env));
  }
  return new LocalFileRegistry(opts.dir ?? fileRegistryDir(env), {
    leaseMs: opts.leaseMs ?? ownershipLeaseMs(env),
  });
}

/** Synchronous local construction (tests + service defaults). */
export function createLocalFileRegistry(dir?: string, leaseMs?: number): LocalFileRegistry {
  return new LocalFileRegistry(dir ?? fileRegistryDir(), leaseMs !== undefined ? { leaseMs } : {});
}
