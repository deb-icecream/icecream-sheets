/**
 * Sensitivity labels (service metadata).
 *
 * Labels are document METADATA — they live in the service metadata store
 * (next to chart/pivot specs in metadataStore.ts), not in the engine and
 * not in the workbook bytes.
 *
 * Relationship to the protection model (user clarification, 2026-10-18):
 * protection has distinct faces and they must not be conflated:
 *  (a) password-to-open / (b) password-on-download  → ENCRYPTION, handled by
 *      the workbook-protection design (password derives the key). Sensitivity
 *      labels do NOT encrypt anything.
 *  (c) service-boundary access control (NOT encryption) → this is what
 *      canShare()/canDownload() implement: authorize()-style allow/deny
 *      decisions over principals, recorded in an audit log.
 *  (d) cell/range locking → the engine ProtectionManager, not labels.
 *  (e) cell hiding → hidden values must be COMPLETELY unreadable to
 *      unauthorized subjects: applyHiddenView() produces per-subject
 *      filtered views (no encryption, just never sending the bytes).
 *
 * So: protection ≠ encryption except where passwords are involved. Labels
 * are an access-control and marking layer on top.
 */

import type { Persistence } from './metadataStore.js';
import { KeyManager } from './crypto.js';
import {
  EncryptedPersistence,
  SERVICE_SCOPE_ID,
  type AsyncPersistence,
} from './secureStore.js';

export type SensitivityLabel = 'public' | 'internal' | 'confidential';

export const SENSITIVITY_LABELS: SensitivityLabel[] = ['public', 'internal', 'confidential'];

export function isSensitivityLabel(v: unknown): v is SensitivityLabel {
  return v === 'public' || v === 'internal' || v === 'confidential';
}

/** Ordering for comparisons: public < internal < confidential. */
export function labelRank(label: SensitivityLabel): number {
  return SENSITIVITY_LABELS.indexOf(label);
}

export interface LabelAuditEntry {
  at: string;
  principal: string;
  action: 'set-label' | 'share-allowed' | 'share-denied' | 'download-allowed' | 'download-denied';
  label: SensitivityLabel;
  detail?: string;
}

interface StoredSensitivity {
  version: 1;
  label: SensitivityLabel;
  /** Principals treated as owners (full rights incl. confidential). */
  owners: string[];
  updatedBy: string;
  updatedAt: string;
  audit: LabelAuditEntry[];
}

const SENSITIVITY_KEY = 'icecream-sheets.sensitivity.v1';
const DEFAULT_OWNER = 'user';

function defaultStored(): StoredSensitivity {
  return {
    version: 1,
    label: 'public',
    owners: [DEFAULT_OWNER],
    updatedBy: 'system',
    updatedAt: new Date().toISOString(),
    audit: [],
  };
}

function sanitize(raw: string | null): StoredSensitivity {
  if (raw === null) return defaultStored();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultStored();
  }
  if (typeof parsed !== 'object' || parsed === null) return defaultStored();
  const p = parsed as Partial<StoredSensitivity>;
  const label = isSensitivityLabel(p.label) ? p.label : 'public';
  const owners = Array.isArray(p.owners) && p.owners.every((o) => typeof o === 'string' && o.length > 0)
    ? (p.owners as string[])
    : [DEFAULT_OWNER];
  const audit = Array.isArray(p.audit) ? (p.audit as LabelAuditEntry[]) : [];
  return {
    version: 1,
    label,
    owners,
    updatedBy: typeof p.updatedBy === 'string' ? p.updatedBy : 'system',
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : new Date().toISOString(),
    audit,
  };
}

/**
 * Sensitivity label store for one workbook, encrypted at rest.
 *
 * The label, owner allowlist and the full audit trail live in the service
 * metadata store as AES-256-GCM ciphertext (never plaintext) under the
 * service key scope. Use the async `SensitivityStore.create()` factory —
 * the constructor is private because the initial load is async (WebCrypto).
 *
 * Readers (getLabel/owners/applyHiddenView/auditLog) stay synchronous —
 * they serve the in-memory state loaded at create(). Every mutation is
 * async because the encrypted write is async.
 *
 * Backed by the injected Persistence adapter (localStorage on web,
 * in-memory/file on server), exactly like the chart/pivot metadata stores.
 */
export class SensitivityStore {
  private cache: StoredSensitivity | null = null;

  private constructor(private readonly backend: AsyncPersistence) {}

  /**
   * Build a store whose storage is encrypted under the KeyManager key for
   * the service scope (§§3, 7). Loads any previously persisted label state;
   * fail-closed on tampered envelopes.
   */
  static async create(persistence: Persistence, keys: KeyManager): Promise<SensitivityStore> {
    if (!persistence) throw new Error('sensitivity: persistence adapter is required');
    if (!keys) throw new Error('sensitivity: KeyManager is required');
    const backend = await EncryptedPersistence.create(persistence, keys, SERVICE_SCOPE_ID);
    const store = new SensitivityStore(backend);
    await store.initialLoad();
    return store;
  }

  private async initialLoad(): Promise<void> {
    const raw = await this.backend.load(SENSITIVITY_KEY);
    this.cache = sanitize(raw);
  }

  private read(): StoredSensitivity {
    if (this.cache === null) this.cache = defaultStored();
    return this.cache;
  }

  private async write(next: StoredSensitivity): Promise<void> {
    this.cache = next;
    await this.backend.save(SENSITIVITY_KEY, JSON.stringify(next));
  }

  private async log(action: LabelAuditEntry['action'], principal: string, detail?: string): Promise<void> {
    const s = this.read();
    await this.write({
      ...s,
      audit: [...s.audit, { at: new Date().toISOString(), principal, action, label: s.label, detail }],
    });
  }

  getLabel(): SensitivityLabel {
    return this.read().label;
  }

  owners(): string[] {
    return [...this.read().owners];
  }

  /** Change the label (audited). Owners list is preserved. */
  async setLabel(label: SensitivityLabel, principal: string): Promise<void> {
    const s = this.read();
    await this.write({ ...s, label, updatedBy: principal, updatedAt: new Date().toISOString() });
    await this.log('set-label', principal, `label → ${label}`);
  }

  /** Replace the owner allowlist (audited). */
  async setOwners(owners: string[], principal: string): Promise<void> {
    const clean = owners.filter((o) => o.length > 0);
    const s = this.read();
    await this.write({ ...s, owners: clean.length > 0 ? clean : [DEFAULT_OWNER] });
    await this.log('set-label', principal, `owners → ${clean.join(',') || DEFAULT_OWNER}`);
  }

  /**
   * canShare — face (c): service-boundary access control, NOT encryption.
   * Decides whether `principal` may share (re-share) the workbook outward.
   * - public: anyone may share.
   * - internal: any authenticated (non-empty) principal may share.
   * - confidential: owners only.
   * Every decision is audited.
   */
  async canShare(label: SensitivityLabel, principal: string): Promise<boolean> {
    const authed = principal.length > 0;
    const allowed =
      label === 'public' ? authed
      : label === 'internal' ? authed
      : this.read().owners.includes(principal);
    await this.log(allowed ? 'share-allowed' : 'share-denied', principal || '(anonymous)', `share under ${label}`);
    return allowed;
  }

  /**
   * canDownload — face (c): service-boundary access control, NOT encryption.
   * - public / internal: any authenticated principal may download.
   * - confidential: owners only.
   * Password-on-download encryption (face b) is a separate, additional
   * layer handled by the protection/encryption pipeline.
   */
  async canDownload(label: SensitivityLabel, principal: string): Promise<boolean> {
    const authed = principal.length > 0;
    const allowed =
      label === 'confidential' ? this.read().owners.includes(principal) : authed;
    await this.log(allowed ? 'download-allowed' : 'download-denied', principal || '(anonymous)', `download under ${label}`);
    return allowed;
  }

  /**
   * applyHiddenView — face (e): cell hiding. When the label is
   * confidential and the subject is not an owner, hidden cell values are
   * COMPLETELY removed from the view (not masked, not encrypted — the
   * values simply never reach the unauthorized subject). Owners always
   * see everything.
   */
  applyHiddenView(
    label: SensitivityLabel,
    values: Map<string, string>,
    hiddenKeys: Set<string>,
    principal: string,
  ): Map<string, string> {
    if (label !== 'confidential' || this.read().owners.includes(principal)) {
      return new Map(values);
    }
    const out = new Map<string, string>();
    for (const [k, v] of values) {
      if (!hiddenKeys.has(k)) out.set(k, v);
    }
    return out;
  }

  auditLog(): LabelAuditEntry[] {
    return [...this.read().audit];
  }

  clear(): Promise<void> {
    this.cache = null;
    return this.backend.clear(SENSITIVITY_KEY);
  }
}

/** Create a sensitivity store bound to a persistence adapter, encrypted at rest. */
export function createSensitivityStore(persistence: Persistence, keys: KeyManager): Promise<SensitivityStore> {
  return SensitivityStore.create(persistence, keys);
}
