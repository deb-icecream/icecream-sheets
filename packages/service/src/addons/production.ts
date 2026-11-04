/**
 * Production add-on service bootstrap.
 *
 * Per design-docs/add-on-model.md (RESOLVED 2026-10-18): call initSigning()
 * once at Node service startup, and configure the install-time verifier from
 * the trusted public keys. When a verifier is configured, unsigned manifests
 * fail closed at install — there is no user-facing sideload path in v1.
 *
 * Trust roots:
 * - the product catalog key below (baked in; signs the seed catalog in
 *   catalog.ts — public keys are public, so shipping it is safe), plus
 * - operator keys from ICECREAM_ADDON_TRUSTED_KEYS (JSON array of PEM
 *   strings) or ICECREAM_ADDON_TRUSTED_KEYS_FILE (file with PEM blocks).
 *
 * Fail-closed policy: the product catalog key is always a trust root, so a
 * verifier is ALWAYS configured by createProductionAddonService() and
 * unsigned manifests fail closed at install (registry.ts). Malformed trust
 * configuration (bad JSON, missing keys file) throws instead of being
 * silently ignored. In dev/test, hosts that need unsigned sideloads use
 * createMemoryAddonService() — no verifier, signatures not checked — which
 * matches the registry's documented dev behavior.
 */

import * as fs from 'node:fs';
import { AddonService, AddonServiceError, type AddonServiceOptions } from './runtime.js';
import { createEd25519Verifier, initSigning } from './signing.js';
import type { SignatureVerifier } from './registry.js';

/**
 * Product catalog signing key (Ed25519, SPKI PEM). The matching private key
 * lives in the operator's credential vault / CI secrets — it is NEVER
 * committed. This public key verifies the seed catalog listings in
 * catalog.ts; rotate it by shipping a new key and re-signing the catalog.
 *
 * Generated 2026-10-18.
 */
export const PRODUCT_CATALOG_PUBLIC_KEY =
  '-----BEGIN PUBLIC KEY-----\n' +
  'MCowBQYDK2VwAyEAOq1IRHMbZSuvrByHegHOqOgUkKWTqZQaO5Bd79/tt4o=\n' +
  '-----END PUBLIC KEY-----\n';

function parsePemBlocks(text: string): string[] {
  const blocks = text.match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/g);
  // Normalize to the canonical PEM shape (trailing newline) so blocks read
  // from a file compare equal to keys supplied as JSON strings.
  return (blocks ?? []).map((b) => (b.endsWith('\n') ? b : `${b}\n`));
}

/**
 * Operator-supplied trusted public keys (PEM strings). Reads, in order:
 * 1. ICECREAM_ADDON_TRUSTED_KEYS — JSON array of PEM strings.
 * 2. ICECREAM_ADDON_TRUSTED_KEYS_FILE — path to a file holding PEM blocks.
 * Throws on malformed configuration (fail closed, never silently ignore).
 */
export function loadTrustedAddonKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  const keys: string[] = [];
  const json = env.ICECREAM_ADDON_TRUSTED_KEYS;
  if (json !== undefined && json.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new AddonServiceError('ICECREAM_ADDON_TRUSTED_KEYS is not valid JSON');
    }
    if (!Array.isArray(parsed) || !parsed.every((k) => typeof k === 'string')) {
      throw new AddonServiceError('ICECREAM_ADDON_TRUSTED_KEYS must be a JSON array of PEM strings');
    }
    keys.push(...(parsed as string[]));
  }
  const file = env.ICECREAM_ADDON_TRUSTED_KEYS_FILE;
  if (file !== undefined && file.trim() !== '') {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new AddonServiceError(
        `cannot read ICECREAM_ADDON_TRUSTED_KEYS_FILE "${file}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const blocks = parsePemBlocks(text);
    if (blocks.length === 0) {
      throw new AddonServiceError(
        `ICECREAM_ADDON_TRUSTED_KEYS_FILE "${file}" contains no PEM public-key blocks`,
      );
    }
    keys.push(...blocks);
  }
  return keys;
}

/**
 * Whether signature enforcement is required in this process. Production
 * always; dev/test only when explicitly opted in.
 */
export function addonSignatureEnforcementRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' || env.ICECREAM_ADDON_REQUIRE_SIGNATURES === '1';
}

/**
 * Build the install-time signature verifier from every trust root
 * (product catalog key + operator keys). Exported for hosts that manage
 * their own AddonService construction.
 */
export function createProductionVerifier(env: NodeJS.ProcessEnv = process.env): SignatureVerifier {
  return createEd25519Verifier([PRODUCT_CATALOG_PUBLIC_KEY, ...loadTrustedAddonKeys(env)]);
}

export interface ProductionAddonServiceOptions extends AddonServiceOptions {
  /** Extra trusted public keys (PEM) beyond the product catalog key. */
  extraTrustedKeys?: string[];
}

/**
 * Node service startup entry point for the add-on component:
 * initializes Ed25519 signing exactly once, then builds the AddonService
 * with the production signature verifier. Unsigned manifests are rejected
 * at install (fail closed) — a verifier is always configured here.
 */
export async function createProductionAddonService(
  opts: ProductionAddonServiceOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<AddonService> {
  await initSigning();
  const extra = opts.extraTrustedKeys ?? [];
  // The product catalog key is always a trust root, so a verifier is ALWAYS
  // configured here: unsigned manifests fail closed at install (registry.ts),
  // in every environment. Dev/test hosts that need unsigned sideloads use
  // createMemoryAddonService() instead (no verifier — documented dev behavior).
  const trusted = [PRODUCT_CATALOG_PUBLIC_KEY, ...loadTrustedAddonKeys(env), ...extra];
  const { extraTrustedKeys: _dropped, verifySignature: _ignored, ...rest } = opts;
  void _dropped;
  void _ignored;
  // Note: an explicit verifySignature in opts is deliberately dropped —
  // production must never run with a weaker (or absent) verifier.
  return new AddonService({ ...rest, verifySignature: createEd25519Verifier(trusted) });
}
