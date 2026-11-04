/**
 * SharingService — grant/revoke flows for the permission model.
 *
 * Design-docs/permission-model.md §2: Owner/Manager/Editor/Viewer + the
 * manage bit. A Manager can grant/revoke only levels they themselves hold
 * (no escalation) and cannot touch the owner's grant; transferring
 * ownership is owner-only. All of that is enforced inside AccessTable —
 * this service is the UI-facing façade: workbook-scoped grants, display
 * rows, and level validation.
 *
 * Browser-safe: pure TypeScript over AccessTable.
 */
import {
  AccessTable,
  workbookObjectId,
  type AccessEntry,
  type AccessLevel,
  type AccessRequestEntry,
} from '../access.js';
import { NameError } from './types.js';

/** UI-facing levels: Owner is shown but granted only via transfer. */
export type ShareLevel = 'viewer' | 'editor' | 'manager';

const SHARE_LEVELS: ShareLevel[] = ['viewer', 'editor', 'manager'];

export function isShareLevel(l: unknown): l is ShareLevel {
  return typeof l === 'string' && (SHARE_LEVELS as string[]).includes(l);
}

export interface GrantRow {
  principal: string;
  level: AccessLevel;
  objectId: string;
  /** Human description of the node, e.g. 'Workbook', 'Sheet "Q1"'. */
  scope: string;
  grantedBy: string;
  grantedAt: string;
  isOwner: boolean;
}

/** UI-facing row for a pending access request on this workbook. */
export interface AccessRequestRow {
  id: string;
  principal: string;
  requestedLevel: ShareLevel;
  message: string;
  /** Human description of the node, e.g. 'Workbook', 'Sheet "Q1"'. */
  scope: string;
  requestedAt: string;
}

/** Options for filing an access request. */
export interface AccessRequestOptions {
  /** Level asked for (default 'viewer'). */
  level?: ShareLevel;
  /** Free-text note from the requester to the approver. */
  message?: string;
}

export interface SharingServiceOptions {
  table: AccessTable;
  workbookId: string;
}

export class SharingService {
  private readonly table: AccessTable;
  private readonly workbookId: string;
  private readonly root: string;

  constructor(opts: SharingServiceOptions) {
    this.table = opts.table;
    this.workbookId = opts.workbookId;
    this.root = workbookObjectId(opts.workbookId);
  }

  /**
   * Ensure the workbook has an owner row (call once when the workbook is
   * created locally). Idempotent: does not disturb an existing owner.
   */
  async ensureOwner(principal: string): Promise<void> {
    const existing = this.table
      .allEntries()
      .find((e) => e.objectId === this.root && e.level === 'owner');
    if (!existing) await this.table.grantWorkbook(this.workbookId, principal);
  }

  /** Current explicit grants on this workbook (root node), newest last. */
  grants(): GrantRow[] {
    return this.table
      .allEntries()
      .filter((e) => e.objectId === this.root)
      .map((e) => this.toRow(e))
      .sort((a, b) => {
        if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
        return a.principal.localeCompare(b.principal);
      });
  }

  /** The caller's effective level on the workbook (null = no access). */
  effectiveLevel(principal: string): AccessLevel | null {
    return this.table.resolveLevel(this.root, principal);
  }

  /** True when `principal` may change grants (manage bit on the root). */
  canManage(principal: string): boolean {
    const level = this.effectiveLevel(principal);
    return level === 'owner' || level === 'manager';
  }

  /**
   * Grant Viewer/Editor/Manager on the workbook. The granter needs the
   * manage right and cannot escalate above their own level (enforced in
   * AccessTable.grant).
   */
  async grant(principal: string, level: ShareLevel, grantedBy: string): Promise<void> {
    assertPrincipal(principal, 'principal');
    assertPrincipal(grantedBy, 'grantedBy');
    if (!isShareLevel(level)) {
      throw new NameError('invalid-signature', `Unknown share level '${String(level)}'.`);
    }
    try {
      await this.table.grant(this.root, principal, level, grantedBy);
    } catch (e) {
      throw new NameError('permission', e instanceof Error ? e.message : String(e));
    }
  }

  /** Revoke a principal's grant (owner's grant cannot be revoked). */
  async revoke(principal: string, revokedBy: string): Promise<void> {
    assertPrincipal(principal, 'principal');
    assertPrincipal(revokedBy, 'revokedBy');
    try {
      await this.table.revoke(this.root, principal, revokedBy);
    } catch (e) {
      throw new NameError('permission', e instanceof Error ? e.message : String(e));
    }
  }

  /** Transfer ownership (owner-only). */
  async transferOwnership(fromPrincipal: string, toPrincipal: string): Promise<void> {
    assertPrincipal(toPrincipal, 'new owner');
    try {
      await this.table.transferOwnership(this.workbookId, fromPrincipal, toPrincipal);
    } catch (e) {
      throw new NameError('permission', e instanceof Error ? e.message : String(e));
    }
  }

  // -- access requests ------------------------------------------------------

  /**
   * File an access request on this workbook: the requester asks a
   * manager/owner for `level` (default 'viewer'). An upgrade request
   * (e.g. viewer → editor) is allowed; requesting a level already held
   * (or a duplicate pending request) throws.
   *
   * Returns the stable request id.
   */
  async requestAccess(
    requesterPrincipal: string,
    opts?: AccessRequestOptions,
  ): Promise<string> {
    assertPrincipal(requesterPrincipal, 'requester');
    const level = opts?.level ?? 'viewer';
    if (!isShareLevel(level)) {
      throw new NameError('invalid-signature', `Unknown share level '${String(level)}'.`);
    }
    try {
      return await this.table.requestAccess(this.root, requesterPrincipal, {
        level,
        message: opts?.message,
      });
    } catch (e) {
      throw new NameError('permission', e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Pending access requests on this workbook, oldest first. Anyone may
   * read the queue (it carries no grant), but approval/denial needs the
   * manage right — enforced in AccessTable.
   */
  pendingRequests(): AccessRequestRow[] {
    return this.table
      .pendingRequests(this.root)
      .map((r) => this.toRequestRow(r));
  }

  /**
   * Approve a pending request: grants the requester `level` (defaults to
   * the requested level). The approver needs the manage right and cannot
   * escalate above their own level (enforced in AccessTable.grant).
   */
  async approveRequest(
    requestId: string,
    approverPrincipal: string,
    level?: ShareLevel,
  ): Promise<void> {
    assertPrincipal(approverPrincipal, 'approver');
    if (level !== undefined && !isShareLevel(level)) {
      throw new NameError('invalid-signature', `Unknown share level '${String(level)}'.`);
    }
    try {
      await this.table.approveAccessRequest(requestId, approverPrincipal, level);
    } catch (e) {
      throw new NameError('permission', e instanceof Error ? e.message : String(e));
    }
  }

  /** Deny a pending request (manage right required). */
  async denyRequest(requestId: string, denierPrincipal: string): Promise<void> {
    assertPrincipal(denierPrincipal, 'denier');
    try {
      await this.table.denyAccessRequest(requestId, denierPrincipal);
    } catch (e) {
      throw new NameError('permission', e instanceof Error ? e.message : String(e));
    }
  }

  /** Withdraw a pending request (requester only). */
  async cancelRequest(requestId: string, principal: string): Promise<void> {
    assertPrincipal(principal, 'requester');
    try {
      await this.table.cancelAccessRequest(requestId, principal);
    } catch (e) {
      throw new NameError('permission', e instanceof Error ? e.message : String(e));
    }
  }

  /** Human labels for the share dialog. */
  static levelLabel(level: AccessLevel): string {
    switch (level) {
      case 'owner':
        return 'Owner — full rights, incl. ownership transfer';
      case 'manager':
        return 'Manager — edit + share with others';
      case 'editor':
        return 'Editor — edit cells, cannot share';
      case 'viewer':
        return 'Viewer — read only';
    }
  }

  private toRow(e: AccessEntry): GrantRow {
    return {
      principal: e.principal,
      level: e.level,
      objectId: e.objectId,
      scope: describeObject(e.objectId, this.workbookId),
      grantedBy: e.grantedBy,
      grantedAt: e.grantedAt,
      isOwner: e.level === 'owner',
    };
  }

  private toRequestRow(r: AccessRequestEntry): AccessRequestRow {
    if (r.requestedLevel === 'owner') {
      throw new NameError('invalid-signature', 'Ownership cannot be requested.');
    }
    return {
      id: r.id,
      principal: r.principal,
      requestedLevel: r.requestedLevel as ShareLevel,
      message: r.message,
      scope: describeObject(r.objectId, this.workbookId),
      requestedAt: r.requestedAt,
    };
  }
}

function describeObject(objectId: string, workbookId: string): string {
  const prefix = `workbook:${workbookId}`;
  if (objectId === prefix) return 'Workbook';
  if (objectId.startsWith('sheet:')) return `Sheet "${objectId.slice(`sheet:${workbookId}:`.length)}"`;
  if (objectId.startsWith('range:')) return `Range ${objectId.slice(`range:${workbookId}:`.length)}`;
  if (objectId.startsWith('cell:')) return `Cell ${objectId.slice(`cell:${workbookId}:`.length)}`;
  if (objectId.startsWith('namedrange:')) return `Named range ${objectId.slice(`namedrange:${workbookId}:`.length)}`;
  return objectId;
}

function assertPrincipal(p: string, what: string): void {
  if (typeof p !== 'string' || p.trim().length === 0) {
    throw new NameError('permission', `A ${what} is required.`);
  }
}
