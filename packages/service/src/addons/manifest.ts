/**
 * Add-on manifest model.
 *
 * Per design-docs/add-on-model.md §1-2: an add-on is a third-party code
 * package registered in the product-owned catalog. Every add-on declares
 * the capabilities it needs (which objects it reads, whether it writes,
 * whether it reaches the network); capabilities are granted per document
 * binding by the user. Widening capabilities later requires fresh approval.
 *
 * Engine core is unchanged: this module is pure data + validation.
 */

export const ADDON_MANIFEST_VERSION = 1;

/** Capability kinds, per add-on-model.md §2. */
export type CapabilityKind = 'read' | 'write' | 'network';

/**
 * Optional scope narrowing a read/write capability to specific sheets.
 * A capability without a scope covers the whole bound document.
 */
export interface CapabilityScope {
  sheets?: string[];
}

export interface Capability {
  kind: CapabilityKind;
  scope?: CapabilityScope;
}

export interface AddonManifest {
  /** Stable reverse-DNS id, e.g. 'com.example.range-tools'. */
  id: string;
  name: string;
  /** Semver, e.g. '1.2.0'. */
  version: string;
  description?: string;
  publisher?: string;
  /** Declared capabilities. Shown to the user before install (§2). */
  capabilities: Capability[];
  /**
   * Name of the global function the worker invokes per run.
   * Must be a valid JS identifier.
   */
  entrypoint: string;
  /**
   * Publisher signature over (canonical manifest + code).
   * RESOLVED 2026-10-18: Ed25519, format "ed25519:<base64-signature>"
   * (see signing.ts). The registry verifies it against trusted public
   * keys on install/load; unsigned manifests fail closed when a verifier
   * is configured. The catalog UI surfaces the signed/unsigned state.
   */
  signature?: string;
  manifestVersion?: number;
}

const ID_PATTERN = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const IDENT_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const CAPABILITY_KINDS: CapabilityKind[] = ['read', 'write', 'network'];

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

/** Validate one capability entry; returns error strings (empty = valid). */
export function validateCapability(cap: unknown, path: string): string[] {
  const errors: string[] = [];
  if (!isRecord(cap)) return [`${path}: must be an object`];
  if (!CAPABILITY_KINDS.includes(cap.kind as CapabilityKind)) {
    errors.push(`${path}.kind: must be one of ${CAPABILITY_KINDS.join(', ')}`);
  }
  if (cap.scope !== undefined) {
    if (!isRecord(cap.scope)) {
      errors.push(`${path}.scope: must be an object`);
    } else {
      const sheets = (cap.scope as Record<string, unknown>).sheets;
      if (sheets !== undefined) {
        if (
          !Array.isArray(sheets) ||
          sheets.length === 0 ||
          !sheets.every((s) => typeof s === 'string' && s.length > 0)
        ) {
          errors.push(`${path}.scope.sheets: must be a non-empty string array`);
        }
      }
    }
  }
  return errors;
}

export type ManifestValidation =
  | { ok: true; manifest: AddonManifest }
  | { ok: false; errors: string[] };

/** Validate an unknown value as an AddonManifest. Never throws. */
export function validateManifest(input: unknown): ManifestValidation {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ['manifest: must be an object'] };
  const m = input as Record<string, unknown>;

  if (typeof m.id !== 'string' || !ID_PATTERN.test(m.id) || m.id.length > 128) {
    errors.push('id: must be a 1-128 char reverse-DNS style identifier');
  }
  if (typeof m.name !== 'string' || m.name.trim().length === 0 || m.name.length > 200) {
    errors.push('name: must be a non-empty string (max 200 chars)');
  }
  if (typeof m.version !== 'string' || !SEMVER_PATTERN.test(m.version)) {
    errors.push('version: must be semver (x.y.z)');
  }
  if (!Array.isArray(m.capabilities) || m.capabilities.length === 0) {
    errors.push('capabilities: must be a non-empty array');
  } else {
    m.capabilities.forEach((c, i) => errors.push(...validateCapability(c, `capabilities[${i}]`)));
  }
  if (typeof m.entrypoint !== 'string' || !IDENT_PATTERN.test(m.entrypoint)) {
    errors.push('entrypoint: must be a valid JS identifier');
  }
  if (m.description !== undefined && typeof m.description !== 'string') {
    errors.push('description: must be a string');
  }
  if (m.publisher !== undefined && typeof m.publisher !== 'string') {
    errors.push('publisher: must be a string');
  }
  if (m.signature !== undefined && typeof m.signature !== 'string') {
    errors.push('signature: must be a string');
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    manifest: {
      id: m.id as string,
      name: (m.name as string).trim(),
      version: m.version as string,
      description: m.description as string | undefined,
      publisher: m.publisher as string | undefined,
      capabilities: (m.capabilities as Capability[]).map((c) => ({
        kind: c.kind,
        scope: c.scope?.sheets ? { sheets: [...c.scope.sheets] } : undefined,
      })),
      entrypoint: m.entrypoint as string,
      signature: m.signature as string | undefined,
      manifestVersion: ADDON_MANIFEST_VERSION,
    },
  };
}

/**
 * Does a set of granted capabilities cover a required kind on an optional
 * sheet? `write` implies `read`. An unscoped capability covers every sheet;
 * a scoped one covers only its listed sheets.
 */
export function capabilityCovers(
  granted: Capability[],
  need: CapabilityKind,
  sheet?: string,
): boolean {
  return granted.some((c) => {
    const kindOk = c.kind === need || (need === 'read' && c.kind === 'write');
    if (!kindOk) return false;
    if (need === 'network') return true;
    const sheets = c.scope?.sheets;
    if (!sheets) return true;
    return sheet !== undefined && sheets.includes(sheet);
  });
}

/**
 * True when `next` asks for anything `current` does not already cover.
 * Per add-on-model.md §2, widening requires fresh user approval.
 */
export function isWidening(current: Capability[], next: Capability[]): boolean {
  return next.some((n) => {
    if (n.kind === 'network') return !current.some((c) => c.kind === 'network');
    // Covered when some current capability has an equal-or-broader kind and
    // an equal-or-broader scope.
    return !current.some((c) => {
      const kindOk = c.kind === n.kind || (n.kind === 'read' && c.kind === 'write');
      if (!kindOk) return false;
      const cSheets = c.scope?.sheets;
      const nSheets = n.scope?.sheets;
      if (!cSheets) return true; // unscoped current covers any scope
      if (!nSheets) return false; // scoped current cannot cover unscoped next
      return nSheets.every((s) => cSheets.includes(s));
    });
  });
}

/** Human-readable permission footprint for catalog listings (§6). */
export function describeCapabilities(caps: Capability[]): string {
  return caps
    .map((c) => {
      const scope = c.scope?.sheets ? ` (${c.scope.sheets.join(', ')})` : '';
      return `${c.kind}${scope}`;
    })
    .join(', ');
}

/** Compare semver strings: -1 | 0 | 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}
