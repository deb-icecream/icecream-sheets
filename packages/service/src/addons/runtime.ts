/**
 * AddonService: the service-layer facade for the add-on component.
 *
 * Per design-docs/add-on-model.md, this wires together:
 * - the product-owned catalog + registry (install/enable/disable/uninstall),
 * - the per-document capability grant store (user-approved grants),
 * - the worker-isolated runtime (sandboxed execution with CPU/memory limits),
 * - document bindings where every op carries the granting user's identity
 *   through authorize() — there is no privileged path.
 *
 * Engine core is unchanged: the authorizer is accepted as a structural
 * interface (see bindings.ts AuthorizerLike).
 */

import { memoryPersistence, type Persistence } from '../metadataStore.js';
import { AddonCatalog, createSeedCatalog, type AddonListing } from './catalog.js';
import {
  AddonRegistry,
  createAddonStore,
  type SignatureVerifier,
  type StoredAddon,
} from './registry.js';
import {
  GrantStore,
  createGrantStore,
  type CapabilityGrant,
} from './grants.js';
import {
  executeOp,
  type AuthorizerLike,
  type DocumentBinding,
  type InvocationContext,
} from './bindings.js';
import type { Capability } from './manifest.js';
import {
  runAddonInWorker,
  type AddonInvocation,
  type AddonLimits,
  type AddonRunResult,
} from './worker.js';

export class AddonServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddonServiceError';
  }
}

export interface AddonServiceOptions {
  /** Persistence for the registry + grant stores. Defaults to in-memory. */
  persistence?: Persistence;
  /** Product-owned catalog. Defaults to the seeded v1 catalog. */
  catalog?: AddonCatalog;
  /** Optional manifest signature verifier (see registry.ts). */
  verifySignature?: SignatureVerifier;
  /** Default per-invocation limits (see worker.ts). */
  defaultLimits?: AddonLimits;
  /** Host fetch implementation for the capability-gated net.fetch op. */
  fetchImpl?: typeof fetch;
  /** Where add-on log() lines go. Defaults to console.debug. */
  onLog?: (addonId: string, values: unknown[]) => void;
}

export interface AddonRunOptions {
  addonId: string;
  /** The document binding; resolved by the host through the adapter's metadata. */
  binding: DocumentBinding;
  args?: unknown;
  /** Override the manifest's entrypoint. */
  entry?: string;
  limits?: AddonLimits;
}

export class AddonService {
  readonly catalog: AddonCatalog;
  readonly registry: AddonRegistry;
  readonly grants: GrantStore;
  private readonly defaultLimits?: AddonLimits;
  private readonly fetchImpl?: typeof fetch;
  private readonly onLog: (addonId: string, values: unknown[]) => void;

  constructor(opts?: AddonServiceOptions) {
    const persistence = opts?.persistence ?? memoryPersistence();
    this.catalog = opts?.catalog ?? createSeedCatalog();
    this.registry = new AddonRegistry(createAddonStore(persistence), this.catalog, {
      verifySignature: opts?.verifySignature,
    });
    this.grants = new GrantStore(createGrantStore(persistence));
    this.defaultLimits = opts?.defaultLimits;
    this.fetchImpl = opts?.fetchImpl;
    this.onLog = opts?.onLog ?? ((addonId, values) => console.debug(`[addon:${addonId}]`, ...values));
  }

  // -- catalog -----------------------------------------------------------

  /** Product-owned catalog listings (latest version per add-on). */
  listCatalog(): AddonListing[] {
    return this.catalog.list();
  }

  // -- lifecycle ---------------------------------------------------------

  installFromCatalog(id: string, version?: string): StoredAddon {
    return this.registry.installFromCatalog(id, version);
  }

  enableAddon(id: string): StoredAddon {
    return this.registry.enable(id);
  }

  disableAddon(id: string): StoredAddon {
    return this.registry.disable(id);
  }

  /**
   * Uninstall: removes the add-on and purges all of its grants
   * (add-on-model.md §4: uninstalling removes the grant and the document
   * binding; bindings are per-invocation so nothing else persists).
   */
  uninstallAddon(id: string): { removed: boolean; grantsPurged: number } {
    const removed = this.registry.uninstall(id);
    const grantsPurged = this.grants.revokeAllForAddon(id);
    return { removed, grantsPurged };
  }

  listInstalled(): StoredAddon[] {
    return this.registry.list();
  }

  // -- grants ------------------------------------------------------------

  /**
   * Request capabilities for (add-on, document). Returns a pending grant;
   * nothing is effective until a user approves it.
   */
  requestGrant(
    addonId: string,
    documentId: string,
    capabilities: Capability[],
    requestedBy: string,
  ): CapabilityGrant {
    const addon = this.registry.get(addonId);
    if (!addon) throw new AddonServiceError(`not installed: ${addonId}`);
    return this.grants.request(
      addonId,
      documentId,
      capabilities,
      requestedBy,
      addon.manifest.version,
    );
  }

  approveGrant(id: string, decidedBy: string): CapabilityGrant {
    return this.grants.approve(id, decidedBy);
  }

  denyGrant(id: string, decidedBy: string): CapabilityGrant {
    return this.grants.deny(id, decidedBy);
  }

  revokeGrant(id: string, decidedBy: string): CapabilityGrant {
    return this.grants.revoke(id, decidedBy);
  }

  narrowGrant(id: string, capabilities: Capability[], decidedBy: string): CapabilityGrant {
    return this.grants.narrow(id, capabilities, decidedBy);
  }

  // -- invocation --------------------------------------------------------

  /**
   * Run an installed, enabled add-on against a document binding.
   *
   * Preconditions (all fail closed):
   * - the add-on is installed and enabled,
   * - an active grant exists for (add-on, document, manifest version),
   * - the requester supplies the granting user's principal + authorizer.
   *
   * Every op the add-on performs goes through the capability gate and then
   * authorize() with the granting user's principal and the add-on identity
   * (`addon:<id>`) in the auth context.
   */
  async run(
    runOpts: AddonRunOptions,
    auth: { principal: string; authorizer: AuthorizerLike },
  ): Promise<AddonRunResult> {
    const addon = this.registry.get(runOpts.addonId);
    if (!addon) {
      return { ok: false, error: `not installed: ${runOpts.addonId}`, code: 'runtime' };
    }
    if (!addon.enabled) {
      return { ok: false, error: `add-on is disabled: ${runOpts.addonId}`, code: 'runtime' };
    }
    if (!auth.principal) {
      return { ok: false, error: 'missing principal (fail closed)', code: 'auth' };
    }
    const capabilities = this.grants.effective(
      addon.manifest.id,
      runOpts.binding.documentId,
      addon.manifest.version,
    );
    if (capabilities.length === 0) {
      return {
        ok: false,
        error: `no active grant for ${addon.manifest.id} on document ${runOpts.binding.documentId}`,
        code: 'auth',
      };
    }

    const invocation: AddonInvocation = {
      addonId: addon.manifest.id,
      documentId: runOpts.binding.documentId,
      principal: auth.principal,
    };
    const ctx: InvocationContext = {
      addonId: addon.manifest.id,
      documentId: runOpts.binding.documentId,
      principal: auth.principal,
      capabilities,
      authorizer: auth.authorizer,
      binding: runOpts.binding,
      fetchImpl: this.fetchImpl,
    };

    return runAddonInWorker({
      code: addon.code,
      entrypoint: runOpts.entry ?? addon.manifest.entrypoint,
      invocation,
      args: runOpts.args,
      limits: { ...this.defaultLimits, ...runOpts.limits },
      onOp: (op, args) => executeOp(ctx, op, args),
      onLog: (values) => this.onLog(addon.manifest.id, values),
    });
  }
}

/** Convenience: a fully in-memory service for tests and headless hosts. */
export function createMemoryAddonService(opts?: Omit<AddonServiceOptions, 'persistence'>): AddonService {
  return new AddonService({ ...opts, persistence: memoryPersistence() });
}
