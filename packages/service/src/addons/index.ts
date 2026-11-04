/**
 * Add-on component (design-docs/add-on-model.md).
 *
 * Service-layer component: the native add-in system for third-party code.
 * Add-ons run worker-isolated and reach the product only through
 * capability-scoped APIs; every op carries the granting user's identity
 * through authorize(). Engine core is unchanged.
 */

export {
  ADDON_MANIFEST_VERSION,
  compareVersions,
  capabilityCovers,
  describeCapabilities,
  isWidening,
  validateCapability,
  validateManifest,
  type AddonManifest,
  type Capability,
  type CapabilityKind,
  type CapabilityScope,
  type ManifestValidation,
} from './manifest.js';

export {
  AddonCatalog,
  CatalogError,
  createSeedCatalog,
  type AddonListing,
} from './catalog.js';

export {
  ADDON_STORE_VERSION,
  AddonRegistry,
  RegistryError,
  createAddonStore,
  deserializeAddons,
  serializeAddons,
  type InstallOptions,
  type SignatureVerifier,
  type StoredAddon,
} from './registry.js';

export {
  GRANT_STORE_VERSION,
  GrantError,
  GrantStore,
  createGrantStore,
  deserializeGrants,
  serializeGrants,
  type CapabilityGrant,
  type GrantStatus,
} from './grants.js';

export {
  ADDON_OPS,
  AddonAuthError,
  FETCH_TIMEOUT_MS,
  MAX_FETCH_BYTES,
  MAX_RANGE_CELLS,
  createMemoryBinding,
  executeOp,
  type AddonAuthContext,
  type AddonOp,
  type AuthorizerLike,
  type CellAddress,
  type CellValue,
  type DocumentBinding,
  type InvocationContext,
  type RangeAddress,
} from './bindings.js';

export {
  runAddonInWorker,
  type AddonInvocation,
  type AddonLimits,
  type AddonRunResult,
  type RunAddonOptions,
} from './worker.js';

export {
  ADDON_SIGNATURE_PREFIX,
  createEd25519Verifier,
  generateEd25519Keypair,
  initSigning,
  parseSignature,
  signAddon,
  signaturePayload,
  verifyEd25519,
  type Ed25519Keypair,
} from './signing.js';

export {
  createEngineDocumentBinding,
  type EngineDocumentBindingOptions,
} from './engineBinding.js';

export {
  AddonService,
  AddonServiceError,
  createMemoryAddonService,
  type AddonRunOptions,
  type AddonServiceOptions,
} from './runtime.js';

export {
  addonSignatureEnforcementRequired,
  createProductionAddonService,
  createProductionVerifier,
  loadTrustedAddonKeys,
  PRODUCT_CATALOG_PUBLIC_KEY,
  type ProductionAddonServiceOptions,
} from './production.js';
