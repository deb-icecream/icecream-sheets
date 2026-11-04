/**
 * Production add-on signature enforcement (add-on-model.md RESOLVED 2026-10-18).
 *
 * The production bootstrap (createProductionAddonService) must initialize
 * signing once at startup and configure the install-time verifier so that
 * unsigned manifests fail closed. The product-owned seed catalog carries
 * real Ed25519 signatures verifiable against the baked-in product key.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import {
  AddonCatalog,
  AddonService,
  addonSignatureEnforcementRequired,
  createMemoryAddonService,
  createProductionAddonService,
  createProductionVerifier,
  createSeedCatalog,
  initSigning,
  loadTrustedAddonKeys,
  generateEd25519Keypair,
  signAddon,
  PRODUCT_CATALOG_PUBLIC_KEY,
  validateManifest,
  type AddonManifest,
} from '../src/addons/index.js';

beforeAll(async () => {
  await initSigning();
});

const SAVED_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED_ENV };
});

const CODE = `function main(args) { return 42; }`;

function manifest(over: Partial<AddonManifest> = {}): AddonManifest {
  const v = validateManifest({
    id: 'com.example.prod',
    name: 'Prod Addon',
    version: '1.0.0',
    capabilities: [{ kind: 'read' }],
    entrypoint: 'main',
    publisher: 'Example Inc',
    ...over,
  });
  if (!v.ok) throw new Error(`bad fixture manifest: ${v.errors.join('; ')}`);
  return v.manifest;
}

function catalogWith(m: AddonManifest, code: string): AddonCatalog {
  const catalog = new AddonCatalog();
  catalog.addListing({ manifest: m, publisher: 'Example Inc', code, listedAt: '2026-10-18T00:00:00Z' });
  return catalog;
}

describe('createProductionAddonService', () => {
  it('initializes signing and installs the signed seed catalog add-ons', async () => {
    const svc = await createProductionAddonService();
    const installed = svc.installFromCatalog('com.icecream.sample-sum-reporter');
    expect(installed.manifest.id).toBe('com.icecream.sample-sum-reporter');
    const installed2 = svc.installFromCatalog('com.icecream.sample-cell-stamper');
    expect(installed2.manifest.id).toBe('com.icecream.sample-cell-stamper');
  });

  it('rejects an unsigned catalog listing (fail closed)', async () => {
    const svc = new AddonService({
      catalog: catalogWith(manifest(), CODE),
      verifySignature: createProductionVerifier(),
    });
    expect(() => svc.installFromCatalog('com.example.prod')).toThrow(/signature verification failed/);
  });

  it('rejects a listing whose signature was tampered with', async () => {
    const seed = createSeedCatalog();
    const listing = seed.get('com.icecream.sample-sum-reporter', '1.0.0');
    if (!listing?.manifest.signature) throw new Error('seed listing/signature missing');
    // Flip one base64 char in the MIDDLE of the signature. (Tampering with
    // trailing '=' padding is a byte-level no-op — Node's decoder stops at
    // the first padding char — so the flip must land inside the payload.)
    const sig = listing.manifest.signature;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const i = 20;
    const cur = sig[i];
    const curIdx = alphabet.indexOf(cur);
    if (curIdx < 0) throw new Error('unexpected signature alphabet');
    const tamperedSig = sig.slice(0, i) + alphabet[(curIdx + 1) % alphabet.length] + sig.slice(i + 1);
    const tampered = catalogWith({ ...listing.manifest, signature: tamperedSig }, listing.code);
    const svc = new AddonService({ catalog: tampered, verifySignature: createProductionVerifier() });
    expect(() => svc.installFromCatalog('com.icecream.sample-sum-reporter')).toThrow(
      /signature verification failed/,
    );
  });

  it('rejects a signature made by an untrusted key', async () => {
    const svc = new AddonService({
      catalog: catalogWith(manifest({ signature: 'ed25519:' + 'A'.repeat(86) }), CODE),
      verifySignature: createProductionVerifier(),
    });
    expect(() => svc.installFromCatalog('com.example.prod')).toThrow(/signature verification failed/);
  });

  it('still allows unsigned installs on the memory (dev) service', () => {
    const svc = createMemoryAddonService({ catalog: catalogWith(manifest(), CODE) });
    expect(svc.installFromCatalog('com.example.prod').manifest.id).toBe('com.example.prod');
  });

  it('accepts extra trusted keys for operator-signed add-ons', async () => {
    const keys = await generateEd25519Keypair();
    const m = manifest();
    const sig = await signAddon(m, CODE, keys.privateKeyPem);
    const svc = await createProductionAddonService({
      catalog: catalogWith({ ...m, signature: sig }, CODE),
      extraTrustedKeys: [keys.publicKeyPem],
    });
    expect(svc.installFromCatalog('com.example.prod').manifest.id).toBe('com.example.prod');
  });
});

describe('loadTrustedAddonKeys', () => {
  it('reads PEM keys from ICECREAM_ADDON_TRUSTED_KEYS JSON', () => {
    process.env.ICECREAM_ADDON_TRUSTED_KEYS = JSON.stringify([PRODUCT_CATALOG_PUBLIC_KEY]);
    expect(loadTrustedAddonKeys()).toEqual([PRODUCT_CATALOG_PUBLIC_KEY]);
  });

  it('reads PEM blocks from ICECREAM_ADDON_TRUSTED_KEYS_FILE', () => {
    const dir = mkdtempSync(join(tmpdir(), 'icecream-keys-'));
    try {
      const file = join(dir, 'keys.pem');
      writeFileSync(file, `${PRODUCT_CATALOG_PUBLIC_KEY}\n${PRODUCT_CATALOG_PUBLIC_KEY}`);
      process.env.ICECREAM_ADDON_TRUSTED_KEYS_FILE = file;
      expect(loadTrustedAddonKeys()).toEqual([PRODUCT_CATALOG_PUBLIC_KEY, PRODUCT_CATALOG_PUBLIC_KEY]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] when nothing is configured', () => {
    delete process.env.ICECREAM_ADDON_TRUSTED_KEYS;
    delete process.env.ICECREAM_ADDON_TRUSTED_KEYS_FILE;
    expect(loadTrustedAddonKeys()).toEqual([]);
  });

  it('throws on malformed JSON (fail closed)', () => {
    process.env.ICECREAM_ADDON_TRUSTED_KEYS = 'not-json';
    expect(() => loadTrustedAddonKeys()).toThrow(/not valid JSON/);
  });

  it('throws on non-array JSON (fail closed)', () => {
    process.env.ICECREAM_ADDON_TRUSTED_KEYS = JSON.stringify({ key: 'x' });
    expect(() => loadTrustedAddonKeys()).toThrow(/JSON array/);
  });

  it('throws on a missing keys file (fail closed)', () => {
    process.env.ICECREAM_ADDON_TRUSTED_KEYS_FILE = '/nonexistent/keys.pem';
    expect(() => loadTrustedAddonKeys()).toThrow(/cannot read/);
  });
});

describe('addonSignatureEnforcementRequired', () => {
  it('is required in production', () => {
    expect(addonSignatureEnforcementRequired({ NODE_ENV: 'production' })).toBe(true);
  });

  it('is required when explicitly opted in', () => {
    expect(addonSignatureEnforcementRequired({ ICECREAM_ADDON_REQUIRE_SIGNATURES: '1' })).toBe(true);
  });

  it('is not required by default in dev/test', () => {
    expect(addonSignatureEnforcementRequired({ NODE_ENV: 'test' })).toBe(false);
    expect(addonSignatureEnforcementRequired({})).toBe(false);
  });
});
