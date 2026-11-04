/**
 * Capability grant store: which add-on may do what, on which document.
 *
 * Per design-docs/add-on-model.md §2 and §4:
 * - Capabilities are declared in the manifest and granted per document
 *   binding by the user at install time, shown before install.
 * - Widening capabilities later requires fresh user approval.
 * - Permissions can be narrowed or revoked at any time; revocation takes
 *   effect on the next invocation (grants are read fresh per run).
 * - Uninstalling removes the grant and the document binding.
 *
 * Grant lifecycle: pending -> active (-> revoked | denied). A newer pending
 * request for the same (addon, document) supersedes the older active grant
 * when approved. Narrowing an active grant is allowed without re-approval;
 * anything wider needs a fresh approval.
 */

import {
  MetadataStore,
  type Persistence,
} from '../metadataStore.js';
import {
  isWidening,
  validateCapability,
  type Capability,
} from './manifest.js';

export const GRANT_STORE_VERSION = 1;
const GRANT_STORE_KEY = 'icecream-sheets.addon-grants.v1';

export type GrantStatus = 'pending' | 'active' | 'revoked' | 'denied';

export interface CapabilityGrant {
  id: string;
  addonId: string;
  documentId: string;
  /** Manifest version the grant was approved against. */
  manifestVersion: string;
  capabilities: Capability[];
  status: GrantStatus;
  requestedBy: string;
  requestedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  /** Id of the grant this one superseded, if any. */
  supersedes?: string;
}

interface StoredGrantFile {
  version: number;
  grants: CapabilityGrant[];
}

export function serializeGrants(grants: CapabilityGrant[]): string {
  const file: StoredGrantFile = { version: GRANT_STORE_VERSION, grants };
  return JSON.stringify(file);
}

/** Deserialize; returns [] for corrupt payloads (metadataStore.ts pattern). */
export function deserializeGrants(json: string): CapabilityGrant[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const file = parsed as Partial<StoredGrantFile>;
  if (!Array.isArray(file.grants)) return [];
  const STATUSES: GrantStatus[] = ['pending', 'active', 'revoked', 'denied'];
  return file.grants.filter((g): g is CapabilityGrant => {
    if (typeof g !== 'object' || g === null) return false;
    const grant = g as Partial<CapabilityGrant>;
    return (
      typeof grant.id === 'string' &&
      typeof grant.addonId === 'string' &&
      typeof grant.documentId === 'string' &&
      typeof grant.manifestVersion === 'string' &&
      Array.isArray(grant.capabilities) &&
      grant.capabilities.every((c) => validateCapability(c, 'capabilities').length === 0) &&
      STATUSES.includes(grant.status as GrantStatus) &&
      typeof grant.requestedBy === 'string' &&
      typeof grant.requestedAt === 'string'
    );
  });
}

/** Create the grant metadata store bound to a persistence adapter. */
export function createGrantStore(persistence: Persistence): MetadataStore<CapabilityGrant> {
  return new MetadataStore<CapabilityGrant>(
    GRANT_STORE_KEY,
    persistence,
    serializeGrants,
    deserializeGrants,
  );
}

export class GrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrantError';
  }
}

let grantSeq = 0;
function newGrantId(): string {
  grantSeq += 1;
  return `grant-${Date.now().toString(36)}-${grantSeq.toString(36)}`;
}

function cloneCaps(caps: Capability[]): Capability[] {
  return caps.map((c) => ({
    kind: c.kind,
    scope: c.scope?.sheets ? { sheets: [...c.scope.sheets] } : undefined,
  }));
}

export class GrantStore {
  private readonly store: MetadataStore<CapabilityGrant>;

  constructor(store: MetadataStore<CapabilityGrant>) {
    this.store = store;
  }

  list(): CapabilityGrant[] {
    return this.store.all();
  }

  get(id: string): CapabilityGrant | undefined {
    return this.store.all().find((g) => g.id === id);
  }

  /** Grants for one add-on on one document, newest first. */
  forBinding(addonId: string, documentId: string): CapabilityGrant[] {
    return this.store
      .all()
      .filter((g) => g.addonId === addonId && g.documentId === documentId)
      .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
  }

  /**
   * Request a grant. Starts `pending`: nothing is effective until a user
   * approves. An identical active grant short-circuits (returns it); a
   * different one creates a new pending request that supersedes on approval.
   */
  request(
    addonId: string,
    documentId: string,
    capabilities: Capability[],
    requestedBy: string,
    manifestVersion: string,
  ): CapabilityGrant {
    if (!addonId || !documentId || !requestedBy || !manifestVersion) {
      throw new GrantError('addonId, documentId, requestedBy and manifestVersion are required');
    }
    if (!Array.isArray(capabilities) || capabilities.length === 0) {
      throw new GrantError('capabilities must be a non-empty array');
    }
    const bad = capabilities.flatMap((c, i) => validateCapability(c, `capabilities[${i}]`));
    if (bad.length > 0) throw new GrantError(`invalid capabilities: ${bad.join('; ')}`);

    const active = this.forBinding(addonId, documentId).find(
      (g) => g.status === 'active' && g.manifestVersion === manifestVersion,
    );
    if (
      active &&
      !isWidening(active.capabilities, capabilities) &&
      !isWidening(capabilities, active.capabilities)
    ) {
      return active; // identical footprint: nothing new to approve
    }

    const grant: CapabilityGrant = {
      id: newGrantId(),
      addonId,
      documentId,
      manifestVersion,
      capabilities: cloneCaps(capabilities),
      status: 'pending',
      requestedBy,
      requestedAt: new Date().toISOString(),
      supersedes: active?.id,
    };
    this.store.add(grant);
    return grant;
  }

  /** Approve a pending grant. Supersedes the older active grant, if any. */
  approve(id: string, decidedBy: string): CapabilityGrant {
    return this.decide(id, decidedBy, 'active');
  }

  /** Deny a pending grant. */
  deny(id: string, decidedBy: string): CapabilityGrant {
    return this.decide(id, decidedBy, 'denied');
  }

  /** Revoke an active grant. Takes effect on the next invocation (§4). */
  revoke(id: string, decidedBy: string): CapabilityGrant {
    const grant = this.get(id);
    if (!grant) throw new GrantError(`unknown grant: ${id}`);
    if (grant.status !== 'active') throw new GrantError(`cannot revoke grant in status ${grant.status}`);
    return this.update(grant, { status: 'revoked', decidedBy, decidedAt: new Date().toISOString() });
  }

  /**
   * Narrow an active grant's capabilities. Allowed without fresh approval
   * only when the new set is not a widening of the old (§2, §4).
   */
  narrow(id: string, capabilities: Capability[], decidedBy: string): CapabilityGrant {
    const grant = this.get(id);
    if (!grant) throw new GrantError(`unknown grant: ${id}`);
    if (grant.status !== 'active') throw new GrantError(`cannot narrow grant in status ${grant.status}`);
    if (!Array.isArray(capabilities) || capabilities.length === 0) {
      throw new GrantError('capabilities must be a non-empty array');
    }
    if (isWidening(grant.capabilities, capabilities)) {
      throw new GrantError('narrowing to a wider set requires fresh approval: file a new request');
    }
    return this.update(grant, {
      capabilities: cloneCaps(capabilities),
      decidedBy,
      decidedAt: new Date().toISOString(),
    });
  }

  private decide(id: string, decidedBy: string, status: 'active' | 'denied'): CapabilityGrant {
    const grant = this.get(id);
    if (!grant) throw new GrantError(`unknown grant: ${id}`);
    if (grant.status !== 'pending') {
      throw new GrantError(`cannot decide grant in status ${grant.status}`);
    }
    const decided = this.update(grant, {
      status,
      decidedBy,
      decidedAt: new Date().toISOString(),
    });
    if (status === 'active' && grant.supersedes) {
      const older = this.get(grant.supersedes);
      if (older && older.status === 'active') {
        this.update(older, {
          status: 'revoked',
          decidedBy,
          decidedAt: new Date().toISOString(),
        });
      }
    }
    return decided;
  }

  private update(grant: CapabilityGrant, patch: Partial<CapabilityGrant>): CapabilityGrant {
    const updated: CapabilityGrant = { ...grant, ...patch };
    const rest = this.store.all().filter((g) => g.id !== grant.id);
    this.store.saveAll([...rest, updated]);
    return updated;
  }

  /**
   * Capabilities currently in force for (addon, document, manifestVersion).
   * Empty when there is no active grant — the add-on may not run.
   */
  effective(addonId: string, documentId: string, manifestVersion: string): Capability[] {
    const active = this.forBinding(addonId, documentId).find(
      (g) => g.status === 'active' && g.manifestVersion === manifestVersion,
    );
    return active ? cloneCaps(active.capabilities) : [];
  }

  /**
   * Remove every grant for an add-on. Called on uninstall (§4: uninstalling
   * removes the grant and the document binding). Returns removed count.
   */
  revokeAllForAddon(addonId: string): number {
    return this.store.remove((g) => g.addonId === addonId);
  }
}
