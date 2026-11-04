/**
 * Share (title-bar Share button).
 *
 * Permission model (per packages/engine/src/permissions.ts + the
 * protection faces in MEMORY.md):
 *   - "read": recipient may view; enforced at the service boundary via
 *     authorize() — cell.write is denied for read-only principals
 *     (face c: share read-only → recipient cannot write).
 *   - "write": recipient may edit; mutations still pass authorize().
 *
 * This module is the client-side share record + audit log. Generating a
 * link mints a token and records the grant; actual delivery/enforcement
 * of the link happens at the service boundary (the audit entries here
 * mirror what the service logs via its own GrantRecord trail).
 */

export type SharePermission = 'read' | 'write';

export const SHARE_PERMISSIONS: { id: SharePermission; label: string; detail: string }[] = [
  {
    id: 'read',
    label: 'Can view',
    detail: 'Recipient can open and read the workbook. Writing is denied by the service boundary (authorize()).',
  },
  {
    id: 'write',
    label: 'Can edit',
    detail: 'Recipient can open and edit. Every mutation still passes through authorize().',
  },
];

export interface ShareRecord {
  id: string;
  workbook: string;
  permission: SharePermission;
  /** Recipient emails / names. */
  people: string[];
  link: string;
  createdAt: string;
  createdBy: string;
  revoked: boolean;
}

export type ShareAuditAction = 'share.created' | 'share.revoked' | 'share.copied';

export interface ShareAuditEntry {
  at: string;
  action: ShareAuditAction;
  target: string;
  principal: string;
  detail?: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const RECORDS_KEY = 'icecream.shares.v1';
const AUDIT_KEY = 'icecream.shares.audit.v1';

function defaultStorage(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return {
      getItem: (k) => localStorage.getItem(k),
      setItem: (k, v) => localStorage.setItem(k, v),
    };
  } catch {
    return null;
  }
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => b.toString(36)).join('').replace(/[^a-z0-9]/g, '').slice(0, 24).padEnd(24, 'x');
}

/** Validate a share request; returns error strings. */
export function validateShare(input: { workbook: string; people: string[]; permission: SharePermission }): string[] {
  const errors: string[] = [];
  if (!input.workbook.trim()) errors.push('Workbook name is required.');
  if (input.people.length === 0) errors.push('Add at least one person.');
  for (const p of input.people) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.trim())) errors.push(`"${p}" is not a valid email address.`);
  }
  if (input.permission !== 'read' && input.permission !== 'write') errors.push('Permission must be read or write.');
  return errors;
}

/**
 * Create a share record + audit entry. Throws on invalid input.
 * The link is a capability URL carrying the grant token; the service
 * boundary validates the token and enforces the permission via
 * authorize() on every read/write.
 */
export function createShare(
  input: { workbook: string; people: string[]; permission: SharePermission },
  principal = 'user',
  store?: StorageLike,
): { record: ShareRecord; audit: ShareAuditEntry } {
  const errors = validateShare(input);
  if (errors.length > 0) throw new Error(errors.join(' '));
  const token = randomToken();
  const record: ShareRecord = {
    id: `share_${Date.now().toString(36)}`,
    workbook: input.workbook.trim(),
    permission: input.permission,
    people: input.people.map((p) => p.trim()),
    link: `https://share.icecream-sheets.app/s/${token}`,
    createdAt: new Date().toISOString(),
    createdBy: principal,
    revoked: false,
  };
  const audit: ShareAuditEntry = {
    at: record.createdAt,
    action: 'share.created',
    target: record.id,
    principal,
    detail: `${input.permission} → ${record.people.join(', ')}`,
  };
  const s = store ?? defaultStorage();
  if (s) {
    try {
      const records = loadShareRecords(s);
      s.setItem(RECORDS_KEY, JSON.stringify([...records, record]));
      const log = loadShareAudit(s);
      s.setItem(AUDIT_KEY, JSON.stringify([...log, audit]));
    } catch { /* storage full */ }
  }
  return { record, audit };
}

/** Revoke a share; returns the audit entry. */
export function revokeShare(id: string, principal = 'user', store?: StorageLike): ShareAuditEntry {
  const s = store ?? defaultStorage();
  const audit: ShareAuditEntry = { at: new Date().toISOString(), action: 'share.revoked', target: id, principal };
  if (s) {
    try {
      const records = loadShareRecords(s).map((r) => (r.id === id ? { ...r, revoked: true } : r));
      s.setItem(RECORDS_KEY, JSON.stringify(records));
      s.setItem(AUDIT_KEY, JSON.stringify([...loadShareAudit(s), audit]));
    } catch { /* storage full */ }
  }
  return audit;
}

export function loadShareRecords(store?: StorageLike): ShareRecord[] {
  const s = store ?? defaultStorage();
  if (!s) return [];
  try {
    const raw = s.getItem(RECORDS_KEY);
    const parsed = raw ? (JSON.parse(raw) as ShareRecord[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function loadShareAudit(store?: StorageLike): ShareAuditEntry[] {
  const s = store ?? defaultStorage();
  if (!s) return [];
  try {
    const raw = s.getItem(AUDIT_KEY);
    const parsed = raw ? (JSON.parse(raw) as ShareAuditEntry[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
