/**
 * Add-on package signatures (Ed25519).
 *
 * RESOLVED 2026-10-18: add-on manifests are signed with Ed25519. The
 * registry holds the trusted public keys; install/load verifies the
 * signature over (canonical manifest + code). Unsigned manifests remain
 * installable only via explicit sideload (dev), never from the catalog —
 * catalog listings always carry a signature.
 *
 * Signature format on the manifest: "ed25519:<base64-signature>".
 * The signed payload is the canonical JSON of the manifest with the
 * `signature` field removed, followed by a NUL byte, followed by the
 * UTF-8 add-on code. Canonical JSON = JSON.stringify of the manifest
 * with keys sorted recursively (stable, no whitespace).
 *
 * Node's built-in crypto (node:crypto) is used; the functions are
 * dependency-free. Verification is constant-time (crypto.verify).
 */

import type { AddonManifest } from './manifest.js';
import type { SignatureVerifier } from './registry.js';

export const ADDON_SIGNATURE_PREFIX = 'ed25519:';

/** Recursively sort object keys for canonical JSON. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * The exact bytes covered by the signature: canonical manifest JSON
 * (without the signature field), a NUL separator, then the code bytes.
 */
export function signaturePayload(manifest: AddonManifest, code: string): Buffer {
  const { signature: _dropped, ...rest } = manifest;
  void _dropped;
  const canonical = JSON.stringify(canonicalize(rest));
  return Buffer.concat([Buffer.from(canonical, 'utf8'), Buffer.from([0]), Buffer.from(code, 'utf8')]);
}

/** Parse "ed25519:<base64>" into raw signature bytes. Throws on bad shape. */
export function parseSignature(sig: string): Buffer {
  if (!sig.startsWith(ADDON_SIGNATURE_PREFIX)) {
    throw new Error('signature must start with "ed25519:"');
  }
  const raw = Buffer.from(sig.slice(ADDON_SIGNATURE_PREFIX.length), 'base64');
  if (raw.length !== 64) throw new Error('ed25519 signature must be 64 bytes');
  return raw;
}

export interface Ed25519Keypair {
  /** PEM-encoded PKCS#8 private key. */
  privateKeyPem: string;
  /** PEM-encoded SPKI public key (this is what the registry trusts). */
  publicKeyPem: string;
}

/** Generate a fresh Ed25519 keypair (publisher tooling / tests). */
export async function generateEd25519Keypair(): Promise<Ed25519Keypair> {
  const crypto = await import('node:crypto');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/** Sign (manifest + code) with a PEM private key. Returns "ed25519:<base64>". */
export async function signAddon(
  manifest: AddonManifest,
  code: string,
  privateKeyPem: string,
): Promise<string> {
  const crypto = await import('node:crypto');
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, signaturePayload(manifest, code), key);
  return `${ADDON_SIGNATURE_PREFIX}${sig.toString('base64')}`;
}

/** Verify a raw signature against a PEM public key. */
export async function verifyEd25519(
  manifest: AddonManifest,
  code: string,
  signature: Buffer,
  publicKeyPem: string,
): Promise<boolean> {
  try {
    const crypto = await import('node:crypto');
    const key = crypto.createPublicKey(publicKeyPem);
    return crypto.verify(null, signaturePayload(manifest, code), key, signature);
  } catch {
    return false;
  }
}

/**
 * Build a registry SignatureVerifier from the trusted public keys
 * (PEM strings). A manifest verifies when its signature checks out
 * against ANY trusted key. Manifests without a signature fail closed
 * when a verifier is configured (catalog installs always sign).
 *
 * Synchronous because the registry hook is sync; node:crypto is loaded
 * via createRequire so this works in ESM service builds.
 */
export function createEd25519Verifier(trustedPublicKeys: string[]): SignatureVerifier {
  return (manifest, code) => {
    if (!manifest.signature) return false;
    let sig: Buffer;
    try {
      sig = parseSignature(manifest.signature);
    } catch {
      return false;
    }
    try {
      const crypto = getCryptoSync();
      const payload = signaturePayload(manifest, code);
      return trustedPublicKeys.some((pem) => {
        try {
          const key = crypto.createPublicKey(pem);
          return crypto.verify(null, payload, key, sig);
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  };
}

let cachedCrypto: typeof import('node:crypto') | null = null;

/** Sync node:crypto access for the sync verifier hook (ESM-safe). */
function getCryptoSync(): typeof import('node:crypto') {
  if (cachedCrypto) return cachedCrypto;
  // Dynamic import specifier + @vite-ignore keeps browser bundlers out.
  throw new Error('crypto not initialized: call initSigning() once at service startup');
}

/** Call once at service startup (Node) so the sync verifier can run. */
export async function initSigning(): Promise<void> {
  if (!cachedCrypto) {
    cachedCrypto = await import(/* @vite-ignore */ 'node:crypto');
  }
}
