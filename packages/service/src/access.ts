/**
 * Access table + policy for the service boundary.
 *
 * Per design-docs/permission-model.md:
 * - §1: every addressable object has a stable id (workbook → sheet →
 *   range → cell). Permissions inherit downward; nearest explicit entry
 *   wins; the default at the root is deny; the creator is recorded as Owner
 *   at the root (grantWorkbook).
 * - §2: roles Owner/Manager/Editor/Viewer + a manage bit. Granting or
 *   changing an entry needs the manage right on that node (inheritable).
 *   A Manager can grant/revoke only levels they themselves hold (no
 *   escalation) and cannot touch the owner's grant. Ownership transfer is
 *   owner-only.
 * - §3: the access table lives in the service metadata store as a versioned
 *   system table (icecream-sheets.access.v1); it is sparse (only explicit
 *   entries get rows) and never stored in workbook bytes.
 * - §4: single choke point authorize(). accessPolicy() builds the policy
 *   function the engine's Authorizer consumes; the inheritance walk lives
 *   inside it. Action names match the engine's conventions.
 * - §5: JWT carries identity only — see auth.ts; per-object permissions are
 *   never in token claims.
 * - §6: explicit deny entries are out of scope for v1 (default deny is
 *   enough); there is no 'deny' level here.
 *
 * The policy signature is defined structurally (mirroring the engine's
 * `Policy = (action, target, ctx) => boolean`) so this package keeps no
 * runtime dependency on @icecream-sheets/engine.
 */

import type { Persistence } from './metadataStore.js';
import { KeyManager } from './crypto.js';
import {
  EncryptedPersistence,
  SERVICE_SCOPE_ID,
  type AsyncPersistence,
} from './secureStore.js';

// ---------------------------------------------------------------------------
// Object ids (§1)
// ---------------------------------------------------------------------------

export const ACCESS_STORAGE_KEY = 'icecream-sheets.access.v1';
/**
 * Record format version. v2 adds the pending access-request queue
 * (AccessRequestEntry[]): payloads written at v1 load without requests.
 */
export const ACCESS_RECORD_VERSION = 2;

/** `workbook:<id>` */
export function workbookObjectId(workbookId: string): string {
  assertNonEmpty(workbookId, 'workbookId');
  return `workbook:${workbookId}`;
}

/** `sheet:<workbookId>:<name>` */
export function sheetObjectId(workbookId: string, sheet: string): string {
  assertNonEmpty(workbookId, 'workbookId');
  assertNonEmpty(sheet, 'sheet');
  return `sheet:${workbookId}:${sheet}`;
}

/** `range:<workbookId>:<sheet>:<a1>` (a1 like 'A1:B2') */
export function rangeObjectId(workbookId: string, sheet: string, a1: string): string {
  assertNonEmpty(workbookId, 'workbookId');
  assertNonEmpty(sheet, 'sheet');
  assertNonEmpty(a1, 'a1');
  return `range:${workbookId}:${sheet}:${normalizeA1(a1)}`;
}

/** `cell:<workbookId>:<sheet>!<a1>` (a1 like 'A1') */
export function cellObjectId(workbookId: string, sheet: string, a1: string): string {
  assertNonEmpty(workbookId, 'workbookId');
  assertNonEmpty(sheet, 'sheet');
  assertNonEmpty(a1, 'a1');
  return `cell:${workbookId}:${sheet}!${normalizeA1(a1)}`;
}

/**
 * `namedrange:<workbookId>:<nameId>` — a named range as an object in the
 * permission tree (design-docs/named-ranges-and-named-functions.md §4).
 * The nameId is the range's STABLE id (not its display name). Inherits from
 * the workbook root: a grant on the name overrides for that name only.
 * (v1 enforcement for define/edit stays write-on-the-range; name-scoped
 * access distinct from range permissions is out of scope per §8.)
 */
export function namedRangeObjectId(workbookId: string, nameId: string): string {
  assertNonEmpty(workbookId, 'workbookId');
  assertNonEmpty(nameId, 'nameId');
  return `namedrange:${workbookId}:${nameId}`;
}

// ---------------------------------------------------------------------------
// Roles (§2)
// ---------------------------------------------------------------------------

export type AccessLevel = 'owner' | 'manager' | 'editor' | 'viewer';

const RANK: Record<AccessLevel, number> = { viewer: 1, editor: 2, manager: 3, owner: 4 };

const LEVELS: AccessLevel[] = ['owner', 'manager', 'editor', 'viewer'];

function isLevel(x: unknown): x is AccessLevel {
  return typeof x === 'string' && (LEVELS as string[]).includes(x);
}

// ---------------------------------------------------------------------------
// A1 helpers (for range containment in the inheritance walk)
// ---------------------------------------------------------------------------

interface CellRef {
  row: number; // 1-based
  col: number; // 1-based
}

interface A1Range {
  start: CellRef;
  end: CellRef;
}

function colLettersToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const v = ch.charCodeAt(0) - 64;
    if (v < 1 || v > 26) throw new Error(`access: bad column letters '${letters}'`);
    n = n * 26 + v;
  }
  return n;
}

/** Parse 'A1' / '$B$12' into a 1-based cell ref. */
function parseCellRef(a1: string): CellRef {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(a1.trim());
  if (!m) throw new Error(`access: bad A1 cell ref '${a1}'`);
  return { row: parseInt(m[2], 10), col: colLettersToIndex(m[1]) };
}

/** Parse 'A1' or 'A1:B2' into a normalized range. */
function parseA1Range(a1: string): A1Range {
  const parts = a1.split(':');
  if (parts.length > 2) throw new Error(`access: bad A1 range '${a1}'`);
  const start = parseCellRef(parts[0]);
  const end = parts.length === 2 ? parseCellRef(parts[1]) : start;
  return {
    start: { row: Math.min(start.row, end.row), col: Math.min(start.col, end.col) },
    end: { row: Math.max(start.row, end.row), col: Math.max(start.col, end.col) },
  };
}

function normalizeA1(a1: string): string {
  const r = parseA1Range(a1);
  const cell = (c: CellRef): string => `${colIndexToLetters(c.col)}${c.row}`;
  return r.start.row === r.end.row && r.start.col === r.end.col
    ? cell(r.start)
    : `${cell(r.start)}:${cell(r.end)}`;
}

function colIndexToLetters(n: number): string {
  let s = '';
  let v = n;
  while (v > 0) {
    const r = (v - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    v = Math.floor((v - 1) / 26);
  }
  return s;
}

function inRange(r: A1Range, c: CellRef): boolean {
  return c.row >= r.start.row && c.row <= r.end.row && c.col >= r.start.col && c.col <= r.end.col;
}

function rangeArea(r: A1Range): number {
  return (r.end.row - r.start.row + 1) * (r.end.col - r.start.col + 1);
}

// ---------------------------------------------------------------------------
// Object id parsing
// ---------------------------------------------------------------------------

type ObjectKind = 'workbook' | 'sheet' | 'range' | 'cell' | 'namedrange';

interface ParsedObjectId {
  kind: ObjectKind;
  workbookId: string;
  sheet?: string;
  a1?: string;
  /** For kind 'namedrange': the stable name id. */
  nameId?: string;
}

const A1_TAIL = /^(.*?):([A-Za-z$]{1,3}\d{1,7}(?::[A-Za-z$]{1,3}\d{1,7})?)$/;

/**
 * Parse a canonical object id back into its components. The trailing A1
 * portion is matched with a regex so sheet names containing ':' still parse.
 */
export function parseObjectId(objectId: string): ParsedObjectId | null {
  if (typeof objectId !== 'string') return null;
  const kindEnd = objectId.indexOf(':');
  if (kindEnd < 0) return null;
  const kind = objectId.slice(0, kindEnd);
  const rest = objectId.slice(kindEnd + 1);
  if (kind === 'workbook') {
    return rest.length > 0 ? { kind, workbookId: rest } : null;
  }
  if (kind === 'namedrange') {
    // namedrange:<workbookId>:<nameId> — the nameId is opaque (stable id).
    const i = rest.indexOf(':');
    if (i < 0) return null;
    const workbookId = rest.slice(0, i);
    const nameId = rest.slice(i + 1);
    if (workbookId.length === 0 || nameId.length === 0) return null;
    return { kind, workbookId, nameId };
  }
  if (kind === 'sheet') {
    const i = rest.indexOf(':');
    if (i < 0) return null;
    return { kind, workbookId: rest.slice(0, i), sheet: rest.slice(i + 1) };
  }
  if (kind === 'cell') {
    const bang = rest.indexOf('!');
    if (bang < 0) return null;
    const left = rest.slice(0, bang);
    const i = left.indexOf(':');
    if (i < 0) return null;
    const a1 = rest.slice(bang + 1);
    try {
      parseCellRef(a1);
    } catch {
      return null;
    }
    return { kind, workbookId: left.slice(0, i), sheet: left.slice(i + 1), a1 };
  }
  if (kind === 'range') {
    const m = A1_TAIL.exec(rest);
    if (!m) return null;
    const left = m[1];
    const i = left.indexOf(':');
    if (i < 0) return null;
    try {
      parseA1Range(m[2]);
    } catch {
      return null;
    }
    return { kind, workbookId: left.slice(0, i), sheet: left.slice(i + 1), a1: m[2] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// AccessTable — the system table (§3)
// ---------------------------------------------------------------------------

/** One sparse row: object id, principal, level, granted by, granted at. */
export interface AccessEntry {
  objectId: string;
  principal: string;
  level: AccessLevel;
  grantedBy: string;
  grantedAt: string;
}

/**
 * A pending access request: a principal asked a manager/owner of the object
 * for a grant. Requests live in the same encrypted system table as the
 * entries (design-docs/workbook-protection-and-encryption.md: the UI
 * explains why an action was denied and users can request access through
 * the sharing flow). Approval calls grant(), so the manage-right and
 * no-escalation rules of §2 apply to the approver.
 */
export interface AccessRequestEntry {
  /** Stable request id, e.g. 'req-m4x2k1-7f3a'. */
  id: string;
  objectId: string;
  principal: string;
  /** Level the requester asked for; the approver may grant a different level. */
  requestedLevel: AccessLevel;
  /** Optional free-text note from the requester to the approver. */
  message: string;
  requestedAt: string;
}

export type AccessAuditKind = 'grant' | 'revoke' | 'transfer' | 'access-request' | 'access-approve' | 'access-deny' | 'access-cancel';

export interface AccessAuditEntry {
  kind: AccessAuditKind;
  objectId: string;
  principal: string;
  level?: AccessLevel;
  by: string;
  at: string;
}

interface StoredAccess {
  version: number;
  entries: AccessEntry[];
  /** Persisted audit trail (§8 of the encryption doc) — encrypted at rest
   * like the entries; absent in payloads written before audit persistence. */
  audit?: AccessAuditEntry[];
  /** Pending access requests (record v2; absent in v1 payloads). */
  requests?: AccessRequestEntry[];
}

function entryKey(objectId: string, principal: string): string {
  return `${objectId}\n${principal}`;
}

let requestCounter = 0;

/** Unique-ish request ids: monotonic counter + timestamp + randomness. */
function newRequestId(): string {
  requestCounter += 1;
  const rand = Math.floor(Math.random() * 0xffffff)
    .toString(36)
    .padStart(4, '0');
  return `req-${requestCounter.toString(36)}-${Date.now().toString(36)}-${rand}`;
}

/**
 * The access system table (§3), encrypted at rest.
 *
 * Entries AND the audit trail are kept in memory and persisted through an
 * AsyncPersistence — in production an EncryptedPersistence, so the stored
 * bytes are AES-256-GCM ciphertext (never plaintext). Use the async
 * `AccessTable.create()` factory: the constructor is private because the
 * initial load is async (WebCrypto).
 *
 * Readers (resolveLevel/allEntries/auditLog) stay synchronous — they serve
 * the in-memory table, which is what accessPolicy() needs. Every mutation
 * is async because the encrypted write is async.
 */
export class AccessTable {
  private entries = new Map<string, AccessEntry>();
  private audit: AccessAuditEntry[] = [];
  /** Pending access requests, keyed by request id. */
  private requests = new Map<string, AccessRequestEntry>();

  private constructor(private readonly backend: AsyncPersistence) {}

  /**
   * Build an AccessTable whose storage is encrypted under the KeyManager
   * key for the service scope (§§3, 7). Loads any previously persisted
   * table + audit trail; fail-closed on tampered envelopes.
   */
  static async create(persistence: Persistence, keys: KeyManager): Promise<AccessTable> {
    if (!persistence) throw new Error('access: persistence adapter is required');
    if (!keys) throw new Error('access: KeyManager is required');
    const backend = await EncryptedPersistence.create(persistence, keys, SERVICE_SCOPE_ID);
    const table = new AccessTable(backend);
    await table.load();
    return table;
  }

  // -- grants --------------------------------------------------------------

  /**
   * Record the workbook creator as Owner at the root (§1: "the creator is
   * recorded as Owner at the root"). This is the bootstrap call that needs
   * no prior grant.
   */
  async grantWorkbook(workbookId: string, creatorPrincipal: string): Promise<void> {
    assertPrincipal(creatorPrincipal);
    const objectId = workbookObjectId(workbookId);
    this.upsert({ objectId, principal: creatorPrincipal, level: 'owner', grantedBy: creatorPrincipal });
    this.auditPush({ kind: 'grant', objectId, principal: creatorPrincipal, level: 'owner', by: creatorPrincipal });
    await this.save();
  }

  /**
   * Grant `level` to `principal` on `objectId`. The granter must hold the
   * manage right (owner or manager) on that node — resolved through
   * inheritance — and may only grant levels they themselves hold (no
   * escalation). Nobody but the owner may modify the owner's grant.
   * 'owner' cannot be granted this way; use transferOwnership.
   */
  async grant(objectId: string, principal: string, level: AccessLevel, grantedBy: string): Promise<void> {
    assertObjectId(objectId);
    assertPrincipal(principal);
    assertPrincipal(grantedBy);
    if (!isLevel(level)) throw new Error(`access: invalid level '${String(level)}'`);
    if (level === 'owner') {
      throw new Error('access: grant owner only via transferOwnership (owner-only)');
    }
    const granterLevel = this.resolveLevel(objectId, grantedBy);
    if (granterLevel === null) {
      throw new Error(`access: '${grantedBy}' has no grant on '${objectId}' (default deny)`);
    }
    if (RANK[granterLevel] < RANK.manager) {
      throw new Error(`access: '${grantedBy}' lacks the manage right on '${objectId}'`);
    }
    if (RANK[level] > RANK[granterLevel]) {
      throw new Error(`access: cannot grant '${level}' above granter's own '${granterLevel}' (no escalation)`);
    }
    const existing = this.entries.get(entryKey(objectId, principal));
    if (existing && existing.level === 'owner' && granterLevel !== 'owner') {
      throw new Error("access: only the owner can modify the owner's grant");
    }
    this.upsert({ objectId, principal, level, grantedBy });
    this.auditPush({ kind: 'grant', objectId, principal, level, by: grantedBy });
    await this.save();
  }

  /**
   * Revoke `principal`'s entry on `objectId`. Same manage-right and
   * no-escalation rules as grant. The owner's grant cannot be revoked —
   * use transferOwnership.
   */
  async revoke(objectId: string, principal: string, revokedBy: string): Promise<void> {
    assertObjectId(objectId);
    assertPrincipal(principal);
    assertPrincipal(revokedBy);
    const key = entryKey(objectId, principal);
    const existing = this.entries.get(key);
    if (!existing) return; // idempotent
    const revokerLevel = this.resolveLevel(objectId, revokedBy);
    if (revokerLevel === null || RANK[revokerLevel] < RANK.manager) {
      throw new Error(`access: '${revokedBy}' lacks the manage right on '${objectId}'`);
    }
    if (existing.level === 'owner') {
      throw new Error("access: the owner's grant cannot be revoked (transfer ownership instead)");
    }
    if (RANK[existing.level] > RANK[revokerLevel]) {
      throw new Error(`access: cannot revoke '${existing.level}' above revoker's own '${revokerLevel}'`);
    }
    this.entries.delete(key);
    this.auditPush({ kind: 'revoke', objectId, principal, by: revokedBy });
    await this.save();
  }

  /**
   * Transfer workbook ownership. Owner-only: `fromPrincipal` must currently
   * resolve to owner at the workbook root. The old owner's grant is removed
   * and the new owner recorded.
   */
  async transferOwnership(workbookId: string, fromPrincipal: string, toPrincipal: string): Promise<void> {
    assertPrincipal(fromPrincipal);
    assertPrincipal(toPrincipal);
    const objectId = workbookObjectId(workbookId);
    if (this.resolveLevel(objectId, fromPrincipal) !== 'owner') {
      throw new Error('access: only the current owner can transfer ownership');
    }
    this.entries.delete(entryKey(objectId, fromPrincipal));
    this.upsert({ objectId, principal: toPrincipal, level: 'owner', grantedBy: fromPrincipal });
    this.auditPush({ kind: 'transfer', objectId, principal: toPrincipal, level: 'owner', by: fromPrincipal });
    await this.save();
  }

  // -- access requests --------------------------------------------------------

  /**
   * File an access request on `objectId`: the requester asks a
   * manager/owner of the object for `level` (default 'viewer'). The request
   * lands in the pending queue; approval calls grant() so the §2 manage
   * right and no-escalation rules apply to the approver.
   *
   * Throws when the principal already holds at least the requested level
   * (an upgrade from e.g. viewer → editor is allowed), when they already
   * have a pending request on the object, or when `level` is 'owner'
   * (ownership transfers are never requestable).
   *
   * Returns the stable request id.
   */
  async requestAccess(
    objectId: string,
    principal: string,
    opts?: { level?: AccessLevel; message?: string },
  ): Promise<string> {
    assertObjectId(objectId);
    assertPrincipal(principal);
    const level = opts?.level ?? 'viewer';
    if (!isLevel(level)) throw new Error(`access: invalid requested level '${String(level)}'`);
    if (level === 'owner') {
      throw new Error('access: ownership cannot be requested (transfer only)');
    }
    const current = this.resolveLevel(objectId, principal);
    if (current !== null && RANK[current] >= RANK[level]) {
      throw new Error(
        `access: '${principal}' already has '${current}' on '${objectId}' (no request needed)`,
      );
    }
    for (const r of this.requests.values()) {
      if (r.objectId === objectId && r.principal === principal) {
        throw new Error(`access: '${principal}' already has a pending request on '${objectId}'`);
      }
    }
    const id = newRequestId();
    this.requests.set(id, {
      id,
      objectId,
      principal,
      requestedLevel: level,
      message: typeof opts?.message === 'string' ? opts.message.slice(0, 500) : '',
      requestedAt: new Date().toISOString(),
    });
    this.auditPush({ kind: 'access-request', objectId, principal, level, by: principal });
    await this.save();
    return id;
  }

  /**
   * Pending requests, oldest first. When `objectId` is given, only requests
   * on that exact object are returned.
   */
  pendingRequests(objectId?: string): AccessRequestEntry[] {
    const all = [...this.requests.values()].map((r) => ({ ...r }));
    all.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
    return objectId ? all.filter((r) => r.objectId === objectId) : all;
  }

  /** Fetch one request by id (clone), or null when unknown. */
  getAccessRequest(requestId: string): AccessRequestEntry | null {
    const r = this.requests.get(requestId);
    return r ? { ...r } : null;
  }

  /**
   * Approve a pending request: grants the requester `level` (defaults to
   * the requested level) on the request's object. The approver needs the
   * manage right — enforced inside grant() (§2: no escalation, owner grant
   * untouched). The request is removed from the pending queue.
   */
  async approveAccessRequest(
    requestId: string,
    approvedBy: string,
    level?: AccessLevel,
  ): Promise<void> {
    assertNonEmpty(requestId, 'requestId');
    assertPrincipal(approvedBy);
    const req = this.requests.get(requestId);
    if (!req) throw new Error(`access: unknown access request '${requestId}'`);
    const finalLevel = level ?? req.requestedLevel;
    if (!isLevel(finalLevel) || finalLevel === 'owner') {
      throw new Error(`access: invalid approval level '${String(finalLevel)}'`);
    }
    // grant() enforces the approver's manage right + no escalation; it
    // throws before mutating, so the request survives a failed approval.
    await this.grant(req.objectId, req.principal, finalLevel, approvedBy);
    this.requests.delete(requestId);
    this.auditPush({
      kind: 'access-approve',
      objectId: req.objectId,
      principal: req.principal,
      level: finalLevel,
      by: approvedBy,
    });
    await this.save();
  }

  /**
   * Deny a pending request. The denier needs the manage right on the
   * request's object; the request is removed from the pending queue and the
   * denial is audit-logged.
   */
  async denyAccessRequest(requestId: string, deniedBy: string): Promise<void> {
    assertNonEmpty(requestId, 'requestId');
    assertPrincipal(deniedBy);
    const req = this.requests.get(requestId);
    if (!req) throw new Error(`access: unknown access request '${requestId}'`);
    const denierLevel = this.resolveLevel(req.objectId, deniedBy);
    if (denierLevel === null || RANK[denierLevel] < RANK.manager) {
      throw new Error(`access: '${deniedBy}' lacks the manage right on '${req.objectId}'`);
    }
    this.requests.delete(requestId);
    this.auditPush({
      kind: 'access-deny',
      objectId: req.objectId,
      principal: req.principal,
      by: deniedBy,
    });
    await this.save();
  }

  /**
   * Withdraw a pending request. Only the requester may cancel their own
   * request; the cancellation is audit-logged.
   */
  async cancelAccessRequest(requestId: string, principal: string): Promise<void> {
    assertNonEmpty(requestId, 'requestId');
    assertPrincipal(principal);
    const req = this.requests.get(requestId);
    if (!req) throw new Error(`access: unknown access request '${requestId}'`);
    if (req.principal !== principal) {
      throw new Error(`access: '${principal}' is not the requester of '${requestId}'`);
    }
    this.requests.delete(requestId);
    this.auditPush({
      kind: 'access-cancel',
      objectId: req.objectId,
      principal: req.principal,
      by: principal,
    });
    await this.save();
  }

  // -- resolution ----------------------------------------------------------

  /**
   * Resolve a principal's effective level on an object: walk from the target
   * up to the first node with an explicit entry (§1). For cells, the walk
   * is cell → smallest containing range with an explicit entry → sheet →
   * workbook. Returns null when nothing is explicit (default deny).
   */
  resolveLevel(objectId: string, principal: string): AccessLevel | null {
    const parsed = parseObjectId(objectId);
    if (!parsed || !principal) return null;
    const direct = this.entries.get(entryKey(objectId, principal));
    if (direct) return direct.level;

    if (parsed.kind === 'cell' && parsed.sheet && parsed.a1) {
      const rangeLevel = this.containingRangeLevel(
        parsed.workbookId,
        parsed.sheet,
        parseCellRef(parsed.a1),
        principal,
      );
      if (rangeLevel) return rangeLevel;
    }
    if (parsed.sheet) {
      const sheetLevel = this.entries.get(entryKey(sheetObjectId(parsed.workbookId, parsed.sheet), principal));
      if (sheetLevel) return sheetLevel.level;
    }
    const wbLevel = this.entries.get(entryKey(workbookObjectId(parsed.workbookId), principal));
    return wbLevel ? wbLevel.level : null;
  }

  /** All explicit entries (sparse table contents). */
  allEntries(): AccessEntry[] {
    return [...this.entries.values()].map((e) => ({ ...e }));
  }

  /** In-memory audit trail of protection changes (§8 of the encryption doc).
   * The trail is persisted (encrypted) alongside the entries, so it
   * survives restarts. */
  auditLog(): AccessAuditEntry[] {
    return [...this.audit];
  }

  // -- internals -----------------------------------------------------------

  private containingRangeLevel(
    workbookId: string,
    sheet: string,
    cell: CellRef,
    principal: string,
  ): AccessLevel | null {
    let best: { level: AccessLevel; area: number } | null = null;
    for (const e of this.entries.values()) {
      if (e.principal !== principal) continue;
      const p = parseObjectId(e.objectId);
      if (!p || p.kind !== 'range' || p.workbookId !== workbookId || p.sheet !== sheet || !p.a1) continue;
      const r = parseA1Range(p.a1);
      if (!inRange(r, cell)) continue;
      const area = rangeArea(r);
      if (!best || area < best.area) best = { level: e.level, area };
    }
    return best ? best.level : null;
  }

  private upsert(e: { objectId: string; principal: string; level: AccessLevel; grantedBy: string }): void {
    this.entries.set(entryKey(e.objectId, e.principal), {
      objectId: e.objectId,
      principal: e.principal,
      level: e.level,
      grantedBy: e.grantedBy,
      grantedAt: new Date().toISOString(),
    });
  }

  private auditPush(a: Omit<AccessAuditEntry, 'at'>): void {
    this.audit.push({ ...a, at: new Date().toISOString() });
  }

  private async load(): Promise<void> {
    const raw = await this.backend.load(ACCESS_STORAGE_KEY);
    if (raw === null) return;
    // Encrypted reads fail closed (throw) on tampered envelopes before we
    // get here. A structurally invalid payload starts empty (fail closed —
    // default deny everywhere).
    try {
      const parsed = JSON.parse(raw) as Partial<StoredAccess>;
      if (!Array.isArray(parsed.entries)) return;
      for (const e of parsed.entries) {
        if (isAccessEntry(e)) this.entries.set(entryKey(e.objectId, e.principal), { ...e });
      }
      if (Array.isArray(parsed.audit)) {
        this.audit = (parsed.audit as AccessAuditEntry[]).filter(isAccessAuditEntry);
      }
      if (Array.isArray(parsed.requests)) {
        for (const r of parsed.requests) {
          if (isAccessRequestEntry(r)) this.requests.set(r.id, { ...r });
        }
      }
    } catch {
      // Corrupt table: start empty (fail closed — default deny everywhere).
    }
  }

  private async save(): Promise<void> {
    const stored: StoredAccess = {
      version: ACCESS_RECORD_VERSION,
      entries: this.allEntries(),
      audit: [...this.audit],
      requests: [...this.requests.values()].map((r) => ({ ...r })),
    };
    await this.backend.save(ACCESS_STORAGE_KEY, JSON.stringify(stored));
  }
}

function isAccessRequestEntry(x: unknown): x is AccessRequestEntry {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    e.id.length > 0 &&
    typeof e.objectId === 'string' &&
    parseObjectId(e.objectId) !== null &&
    typeof e.principal === 'string' &&
    isLevel(e.requestedLevel) &&
    typeof e.message === 'string' &&
    typeof e.requestedAt === 'string'
  );
}

function isAccessAuditEntry(x: unknown): x is AccessAuditEntry {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  const kinds: AccessAuditKind[] = [
    'grant',
    'revoke',
    'transfer',
    'access-request',
    'access-approve',
    'access-deny',
    'access-cancel',
  ];
  return (
    typeof e.kind === 'string' &&
    (kinds as string[]).includes(e.kind) &&
    typeof e.objectId === 'string' &&
    typeof e.principal === 'string' &&
    typeof e.by === 'string' &&
    typeof e.at === 'string'
  );
}

function isAccessEntry(x: unknown): x is AccessEntry {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.objectId === 'string' &&
    parseObjectId(e.objectId) !== null &&
    typeof e.principal === 'string' &&
    isLevel(e.level) &&
    typeof e.grantedBy === 'string' &&
    typeof e.grantedAt === 'string'
  );
}

// ---------------------------------------------------------------------------
// Policy — the single choke point (§4)
// ---------------------------------------------------------------------------

/**
 * Structural policy signature, mirroring the engine's
 * `Policy = (action: string, target: string, ctx: AuthContext) => boolean`
 * (engine/src/permissions.ts). Defined locally so this package keeps no
 * runtime dependency on @icecream-sheets/engine.
 */
export type PolicyFn = (action: string, target: string, ctx: { principal: string }) => boolean;

/**
 * Minimum role per action (engine action naming;
 * design-docs/platform-shell.md §3):
 * - viewer: cell.read, range.read, workbook.download
 * - editor: + cell.write, cell.clear, sheet.rename (renaming a sheet needs
 *   write on the sheet)
 * - manager: + sheet.add/delete/duplicate/move/hide (duplicating, hiding and
 *   reordering sheets are structural operations needing the manage right),
 *   calc.setMode, manage/grant/share/protect/unprotect (the manage bit)
 * - owner: everything, incl. workbook.delete and workbook.transfer
 * Unknown actions are denied (default deny).
 */
const ACTION_MIN_LEVEL: Record<string, AccessLevel> = {
  'cell.read': 'viewer',
  'range.read': 'viewer',
  'workbook.download': 'viewer',
  'cell.write': 'editor',
  'cell.clear': 'editor',
  'sheet.rename': 'editor',
  'sheet.add': 'manager',
  'sheet.delete': 'manager',
  'sheet.duplicate': 'manager',
  'sheet.move': 'manager',
  'sheet.hide': 'manager',
  'calc.setMode': 'manager',
  manage: 'manager',
  grant: 'manager',
  share: 'manager',
  protect: 'manager',
  unprotect: 'manager',
  'workbook.delete': 'owner',
  'workbook.transfer': 'owner',
};

/**
 * Build the authorize() policy for one workbook. `target` follows the
 * engine's conventions: 'Sheet!A1' (cell), 'Sheet!A1:B2' (range), 'Sheet'
 * (sheet), or '' (the workbook itself). Workbook-scoped actions
 * ('workbook.*', 'calc.setMode') resolve against the workbook root.
 * Throws on a missing principal (fail closed on identity).
 */
export function accessPolicy(table: AccessTable, workbookId: string): PolicyFn {
  const root = workbookObjectId(workbookId);
  return (action: string, target: string, ctx: { principal: string }) => {
    if (!ctx || typeof ctx.principal !== 'string' || ctx.principal.length === 0) {
      throw new Error('authorize: missing principal (fail closed)');
    }
    const required = ACTION_MIN_LEVEL[action];
    if (!required) return false; // default deny: unknown actions
    const objectId =
      action.startsWith('workbook.') || action === 'calc.setMode'
        ? root
        : targetToObjectId(workbookId, target);
    const level = table.resolveLevel(objectId, ctx.principal);
    return level !== null && RANK[level] >= RANK[required];
  };
}

/** Map an engine-style target to its canonical object id. */
export function targetToObjectId(workbookId: string, target: string): string {
  if (!target) return workbookObjectId(workbookId);
  const bang = target.indexOf('!');
  if (bang < 0) return sheetObjectId(workbookId, unquoteSheet(target));
  const sheet = unquoteSheet(target.slice(0, bang));
  const ref = target.slice(bang + 1);
  return ref.includes(':')
    ? rangeObjectId(workbookId, sheet, ref)
    : cellObjectId(workbookId, sheet, ref);
}

/** Strip Excel-style single quotes around sheet names ('My Sheet'!A1). */
function unquoteSheet(sheet: string): string {
  const t = sheet.trim();
  return t.length >= 2 && t.startsWith("'") && t.endsWith("'") ? t.slice(1, -1).replace(/''/g, "'") : t;
}

// ---------------------------------------------------------------------------
// guards
// ---------------------------------------------------------------------------

function assertNonEmpty(v: string, name: string): void {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`access: ${name} must be a non-empty string`);
}

function assertPrincipal(p: string): void {
  assertNonEmpty(p, 'principal');
}

function assertObjectId(objectId: string): void {
  if (parseObjectId(objectId) === null) throw new Error(`access: malformed object id '${objectId}'`);
}
