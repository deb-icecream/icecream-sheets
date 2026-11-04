/**
 * Add-on Ed25519 signature tests (RESOLVED 2026-10-18):
 * sign/verify round-trip, tamper rejection, wrong-key rejection,
 * unsigned manifests fail closed when a verifier is configured.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import {
  ADDON_SIGNATURE_PREFIX,
  createEd25519Verifier,
  generateEd25519Keypair,
  initSigning,
  parseSignature,
  signAddon,
  signaturePayload,
  verifyEd25519,
  validateManifest,
  createMemoryAddonService,
  type AddonManifest,
} from '../src/addons/index.js';

function manifest(over: Partial<AddonManifest> = {}): AddonManifest {
  const v = validateManifest({
    id: 'com.example.signed',
    name: 'Signed Addon',
    version: '1.0.0',
    capabilities: [{ kind: 'read' }],
    entrypoint: 'main',
    publisher: 'Example Inc',
    ...over,
  });
  if (!v.ok) throw new Error(`bad fixture manifest: ${v.errors.join('; ')}`);
  return v.manifest;
}

const CODE = `function main(args) { return 42; }`;

beforeAll(async () => {
  await initSigning();
});

describe('Ed25519 add-on signatures', () => {
  it('sign/verify round-trips', async () => {
    const keys = await generateEd25519Keypair();
    const m = manifest();
    const sig = await signAddon(m, CODE, keys.privateKeyPem);
    expect(sig.startsWith(ADDON_SIGNATURE_PREFIX)).toBe(true);
    const raw = parseSignature(sig);
    expect(raw.length).toBe(64);
    expect(await verifyEd25519(m, CODE, raw, keys.publicKeyPem)).toBe(true);
  });

  it('rejects tampered code', async () => {
    const keys = await generateEd25519Keypair();
    const m = manifest();
    const sig = await signAddon(m, CODE, keys.privateKeyPem);
    const raw = parseSignature(sig);
    expect(await verifyEd25519(m, CODE + ' ', raw, keys.publicKeyPem)).toBe(false);
  });

  it('rejects tampered manifest fields', async () => {
    const keys = await generateEd25519Keypair();
    const m = manifest();
    const sig = await signAddon(m, CODE, keys.privateKeyPem);
    const raw = parseSignature(sig);
    const tampered = manifest({ version: '1.0.1' });
    expect(await verifyEd25519(tampered, CODE, raw, keys.publicKeyPem)).toBe(false);
  });

  it('rejects the wrong public key', async () => {
    const keys = await generateEd25519Keypair();
    const other = await generateEd25519Keypair();
    const m = manifest();
    const sig = await signAddon(m, CODE, keys.privateKeyPem);
    const raw = parseSignature(sig);
    expect(await verifyEd25519(m, CODE, raw, other.publicKeyPem)).toBe(false);
  });

  it('signature payload covers manifest + code deterministically', () => {
    const m = manifest();
    const p1 = signaturePayload(m, CODE);
    const p2 = signaturePayload(manifest(), CODE);
    expect(p1.equals(p2)).toBe(true);
    // The signature field itself is excluded from the payload.
    const signed = manifest({ signature: 'ed25519:AAAA' });
    expect(signaturePayload(signed, CODE).equals(p1)).toBe(true);
  });

  it('registry verifier accepts a valid catalog signature', async () => {
    const keys = await generateEd25519Keypair();
    const verify = createEd25519Verifier([keys.publicKeyPem]);
    const m = manifest();
    const sig = await signAddon(m, CODE, keys.privateKeyPem);
    expect(verify({ ...m, signature: sig }, CODE)).toBe(true);
  });

  it('registry verifier fails closed on unsigned manifests', async () => {
    const keys = await generateEd25519Keypair();
    const verify = createEd25519Verifier([keys.publicKeyPem]);
    expect(verify(manifest(), CODE)).toBe(false);
  });

  it('registry verifier rejects signatures from untrusted keys', async () => {
    const keys = await generateEd25519Keypair();
    const attacker = await generateEd25519Keypair();
    const verify = createEd25519Verifier([keys.publicKeyPem]);
    const m = manifest();
    const sig = await signAddon(m, CODE, attacker.privateKeyPem);
    expect(verify({ ...m, signature: sig }, CODE)).toBe(false);
  });

  it('registry blocks install when signature verification fails', async () => {
    const keys = await generateEd25519Keypair();
    const svc = createMemoryAddonService({ verifySignature: createEd25519Verifier([keys.publicKeyPem]) });
    const m = manifest();
    // Unsigned → blocked.
    expect(() => svc.registry.install(m, CODE, { allowSideload: true })).toThrow(/signature verification failed/);
    // Valid signature → installs.
    const sig = await signAddon(m, CODE, keys.privateKeyPem);
    const stored = svc.registry.install({ ...m, signature: sig }, CODE, { allowSideload: true });
    expect(stored.manifest.id).toBe('com.example.signed');
  });
});
