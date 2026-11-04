/**
 * Add-on registry: install / enable / disable / uninstall lifecycle.
 *
 * Per design-docs/add-on-model.md §1, §4 and §6. The registry is the
 * product-owned catalog's installed set. Persistence follows the
 * packages/service/src/metadataStore.ts patterns: a versioned
 * MetadataStore<T> over an injected Persistence adapter (in-memory on the
 * server, localStorage on web). Add-on code never persists inside workbook
 * bytes (§4) — it lives here, in the service metadata store.
 */

import {
  MetadataStore,
  type Persistence,
} from '../metadataStore.js';
import {
  compareVersions,
  validateManifest,
  type AddonManifest,
} from './manifest.js';
import type { AddonCatalog } from './catalog.js';

export const ADDON_STORE_VERSION = 1;
const ADDON_STORE_KEY = 'icecream-sheets.addons.v1';

export interface StoredAddon {
  manifest: AddonManifest;
  code: string;
  enabled: boolean;
  installedAt: string;
  installedFromCatalog: boolean;
}

interface StoredAddonFile {
  version: number;
  addons: StoredAddon[];
}

export function serializeAddons(addons: StoredAddon[]): string {
  const file: StoredAddonFile = { version: ADDON_STORE_VERSION, addons };
  return JSON.stringify(file);
}

/** Deserialize; returns [] for corrupt payloads (metadataStore.ts pattern). */
export function deserializeAddons(json: string): StoredAddon[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const file = parsed as Partial<StoredAddonFile>;
  if (!Array.isArray(file.addons)) return [];
  return file.addons.filter(
    (a): a is StoredAddon =>
      typeof a === 'object' &&
      a !== null &&
      validateManifest((a as StoredAddon).manifest).ok &&
      typeof (a as StoredAddon).code === 'string' &&
      typeof (a as StoredAddon).enabled === 'boolean',
  );
}

/** Create the add-on metadata store bound to a persistence adapter. */
export function createAddonStore(persistence: Persistence): MetadataStore<StoredAddon> {
  return new MetadataStore<StoredAddon>(
    ADDON_STORE_KEY,
    persistence,
    serializeAddons,
    deserializeAddons,
  );
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

/**
 * Hook a host can provide to verify manifest signatures. v1: the field is
 * recorded on the manifest; verification is host-defined. Returning false
 * (or throwing) blocks the install.
 */
export type SignatureVerifier = (manifest: AddonManifest, code: string) => boolean;

export interface InstallOptions {
  /**
   * Bypass the product-owned catalog. Default false: per add-on-model.md
   * §6 there is no sideloading outside the catalog in v1. Tests and dev
   * tooling pass true explicitly.
   */
  allowSideload?: boolean;
}

export class AddonRegistry {
  private readonly store: MetadataStore<StoredAddon>;
  private readonly catalog: AddonCatalog;
  private readonly verifySignature?: SignatureVerifier;

  constructor(
    store: MetadataStore<StoredAddon>,
    catalog: AddonCatalog,
    opts?: { verifySignature?: SignatureVerifier },
  ) {
    this.store = store;
    this.catalog = catalog;
    this.verifySignature = opts?.verifySignature;
  }

  /** All installed add-ons. */
  list(): StoredAddon[] {
    return this.store.all();
  }

  get(id: string): StoredAddon | undefined {
    return this.store.all().find((a) => a.manifest.id === id);
  }

  isEnabled(id: string): boolean {
    return this.get(id)?.enabled === true;
  }

  /**
   * Install (or upgrade) an add-on. Without `allowSideload`, the exact
   * manifest id@version must exist in the product-owned catalog (§6).
   * Upgrades require a strictly higher semver; downgrades are rejected.
   */
  install(manifest: AddonManifest, code: string, opts?: InstallOptions): StoredAddon {
    const v = validateManifest(manifest);
    if (!v.ok) throw new RegistryError(`invalid manifest: ${v.errors.join('; ')}`);
    const m = v.manifest;
    if (typeof code !== 'string' || code.length === 0) {
      throw new RegistryError('add-on code must be a non-empty string');
    }
    const fromCatalog = this.catalog.has(m.id, m.version);
    if (!fromCatalog && opts?.allowSideload !== true) {
      throw new RegistryError(
        `no sideloading outside the catalog in v1: ${m.id}@${m.version} is not listed`,
      );
    }
    // RESOLVED 2026-10-18 (Ed25519): when a verifier is configured, every
    // install must carry a valid signature — unsigned manifests fail
    // closed. Without a verifier (dev/test), signatures are not checked.
    if (this.verifySignature) {
      let ok = false;
      try {
        ok = m.signature !== undefined && this.verifySignature(m, code);
      } catch {
        ok = false;
      }
      if (!ok) throw new RegistryError(`signature verification failed for ${m.id}@${m.version}`);
    }

    const existing = this.get(m.id);
    if (existing) {
      const cmp = compareVersions(m.version, existing.manifest.version);
      if (cmp === 0) throw new RegistryError(`${m.id}@${m.version} is already installed`);
      if (cmp < 0) {
        throw new RegistryError(
          `downgrade rejected: installed ${existing.manifest.version}, got ${m.version}`,
        );
      }
    }

    const stored: StoredAddon = {
      manifest: m,
      code,
      enabled: true,
      installedAt: new Date().toISOString(),
      installedFromCatalog: fromCatalog,
    };
    const rest = this.store.all().filter((a) => a.manifest.id !== m.id);
    this.store.saveAll([...rest, stored]);
    return stored;
  }

  /** Install the catalog's listing for id@version (latest when omitted). */
  installFromCatalog(id: string, version?: string): StoredAddon {
    const listing = this.catalog.get(id, version);
    if (!listing) {
      throw new RegistryError(
        `not in catalog: ${id}${version ? `@${version}` : ''}`,
      );
    }
    return this.install(listing.manifest, listing.code);
  }

  enable(id: string): StoredAddon {
    return this.setEnabled(id, true);
  }

  disable(id: string): StoredAddon {
    return this.setEnabled(id, false);
  }

  private setEnabled(id: string, enabled: boolean): StoredAddon {
    const current = this.get(id);
    if (!current) throw new RegistryError(`not installed: ${id}`);
    const updated: StoredAddon = { ...current, enabled };
    const rest = this.store.all().filter((a) => a.manifest.id !== id);
    this.store.saveAll([...rest, updated]);
    return updated;
  }

  /**
   * Uninstall. Per §4 the grant and the document binding are removed too —
   * the caller (AddonService) purges grants; bindings are per-invocation.
   * Returns true when something was removed.
   */
  uninstall(id: string): boolean {
    return this.store.remove((a) => a.manifest.id === id) > 0;
  }
}
