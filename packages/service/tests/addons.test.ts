/**
 * Add-on component tests (design-docs/add-on-model.md, v1 MUST):
 * - registry lifecycle (catalog-only install, upgrade/downgrade, enable/disable, uninstall)
 * - capability grant flow (request/approve/deny/revoke, widening, narrowing)
 * - sandbox enforcement (blocked globals, CPU timeout, memory cap)
 * - authorize() identity propagation (granting user's principal + add-on identity)
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AddonAuthError,
  AddonServiceError,
  capabilityCovers,
  createEngineDocumentBinding,
  createMemoryAddonService,
  createMemoryBinding,
  describeCapabilities,
  deserializeAddons,
  deserializeGrants,
  executeOp,
  isWidening,
  runAddonInWorker,
  validateManifest,
  type AddonAuthContext,
  type AddonManifest,
  type AuthorizerLike,
  type Capability,
  type InvocationContext,
} from '../src/addons/index.js';
// The real engine Authorizer: proves the structural AuthorizerLike contract
// holds without changing the engine core.
import { Authorizer } from '../../engine/src/permissions.js';
import { EngineHost } from '../../engine/src/protocol.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const READ: Capability = { kind: 'read' };
const WRITE: Capability = { kind: 'write' };

function manifest(over: Partial<AddonManifest> = {}): AddonManifest {
  return {
    id: 'com.example.test-addon',
    name: 'Test Addon',
    version: '1.0.0',
    publisher: 'Example',
    capabilities: [READ],
    entrypoint: 'main',
    ...over,
  };
}

const SUM_CODE = `function main(args) {
  var ref = args && args.ref ? args.ref : { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 1, endCol: 1 };
  var values = addon.sheets.getRange(ref);
  var sum = 0;
  for (var i = 0; i < values.length; i++)
    for (var j = 0; j < values[i].length; j++)
      if (typeof values[i][j] === 'number') sum += values[i][j];
  return { sum: sum };
}`;

class TestAuthorizer implements AuthorizerLike {
  log: { action: string; target: string; principal: string; grants?: string[] }[] = [];
  constructor(private policy: (action: string, target: string) => boolean = () => true) {}
  authorize(action: string, target: string, ctx: AddonAuthContext): boolean {
    if (!ctx || !ctx.principal) throw new Error('authorize: missing principal (fail closed)');
    const allowed = this.policy(action, target);
    this.log.push({ action, target, principal: ctx.principal, grants: ctx.grants });
    return allowed;
  }
}

/** Install the seed sum-reporter and approve a grant; returns wired pieces. */
function wiredService(opts?: {
  capabilities?: Capability[];
  policy?: (action: string, target: string) => boolean;
  documentId?: string;
  principal?: string;
}) {
  const svc = createMemoryAddonService();
  const addon = svc.installFromCatalog('com.icecream.sample-sum-reporter');
  const documentId = opts?.documentId ?? 'doc-1';
  const principal = opts?.principal ?? 'user-1';
  const grant = svc.requestGrant(addon.manifest.id, documentId, opts?.capabilities ?? [READ], principal);
  svc.approveGrant(grant.id, principal);
  const binding = createMemoryBinding(documentId, {
    Sheet1: [
      [1, 2],
      [3, 4],
    ],
  });
  const authorizer = new TestAuthorizer(opts?.policy);
  return { svc, addon, binding, authorizer, principal, documentId };
}

// ---------------------------------------------------------------------------
// Manifest validation + capability helpers
// ---------------------------------------------------------------------------

describe('manifest', () => {
  it('validates a good manifest', () => {
    const v = validateManifest(manifest());
    expect(v.ok).toBe(true);
  });

  it('rejects bad id, version, entrypoint and capabilities', () => {
    expect(validateManifest({ ...manifest(), id: 'bad id!' }).ok).toBe(false);
    expect(validateManifest({ ...manifest(), version: '1.0' }).ok).toBe(false);
    expect(validateManifest({ ...manifest(), entrypoint: 'not-an-ident!' }).ok).toBe(false);
    expect(validateManifest({ ...manifest(), capabilities: [{ kind: 'fly' }] as unknown as Capability[] }).ok).toBe(false);
    expect(validateManifest({ ...manifest(), capabilities: [] }).ok).toBe(false);
  });

  it('write implies read; scopes narrow coverage', () => {
    expect(capabilityCovers([WRITE], 'read')).toBe(true);
    expect(capabilityCovers([READ], 'write')).toBe(false);
    expect(capabilityCovers([{ kind: 'read', scope: { sheets: ['A'] } }], 'read', 'A')).toBe(true);
    expect(capabilityCovers([{ kind: 'read', scope: { sheets: ['A'] } }], 'read', 'B')).toBe(false);
    expect(capabilityCovers([READ], 'read', 'B')).toBe(true);
  });

  it('detects widening', () => {
    expect(isWidening([READ], [READ, WRITE])).toBe(true);
    expect(isWidening([READ, WRITE], [READ])).toBe(false);
    expect(isWidening([READ], [{ kind: 'read', scope: { sheets: ['A'] } }])).toBe(false); // narrowing
    expect(isWidening([{ kind: 'read', scope: { sheets: ['A'] } }], [READ])).toBe(true);
    expect(isWidening([READ], [{ kind: 'network' }])).toBe(true);
  });

  it('describes the permission footprint', () => {
    expect(describeCapabilities([READ, { kind: 'write', scope: { sheets: ['A'] } }])).toBe(
      'read, write (A)',
    );
  });
});

// ---------------------------------------------------------------------------
// Registry lifecycle
// ---------------------------------------------------------------------------

describe('registry lifecycle', () => {
  it('installs from the product-owned catalog', () => {
    const svc = createMemoryAddonService();
    expect(svc.listCatalog().length).toBeGreaterThan(0);
    const installed = svc.installFromCatalog('com.icecream.sample-sum-reporter');
    expect(installed.manifest.id).toBe('com.icecream.sample-sum-reporter');
    expect(installed.enabled).toBe(true);
    expect(svc.listInstalled()).toHaveLength(1);
  });

  it('refuses sideloading outside the catalog in v1', () => {
    const svc = createMemoryAddonService();
    expect(() => svc.registry.install(manifest(), SUM_CODE)).toThrow(/catalog/);
    // ...unless the caller explicitly opts in (tests/dev)
    const sideloaded = svc.registry.install(manifest(), SUM_CODE, { allowSideload: true });
    expect(sideloaded.installedFromCatalog).toBe(false);
  });

  it('rejects invalid manifests and empty code', () => {
    const svc = createMemoryAddonService();
    expect(() => svc.registry.install({ ...manifest(), version: 'nope' }, SUM_CODE, { allowSideload: true })).toThrow(
      /invalid manifest/,
    );
    expect(() => svc.registry.install(manifest(), '', { allowSideload: true })).toThrow(/non-empty/);
  });

  it('upgrades to a higher version and rejects downgrades/reinstalls', () => {
    const svc = createMemoryAddonService();
    svc.registry.install(manifest({ version: '1.0.0' }), SUM_CODE, { allowSideload: true });
    const up = svc.registry.install(manifest({ version: '1.1.0' }), SUM_CODE, { allowSideload: true });
    expect(up.manifest.version).toBe('1.1.0');
    expect(() => svc.registry.install(manifest({ version: '1.0.0' }), SUM_CODE, { allowSideload: true })).toThrow(
      /downgrade/,
    );
    expect(() => svc.registry.install(manifest({ version: '1.1.0' }), SUM_CODE, { allowSideload: true })).toThrow(
      /already installed/,
    );
  });

  it('enable/disable toggles the add-on', () => {
    const svc = createMemoryAddonService();
    svc.registry.install(manifest(), SUM_CODE, { allowSideload: true });
    expect(svc.registry.isEnabled(manifest().id)).toBe(true);
    svc.disableAddon(manifest().id);
    expect(svc.registry.isEnabled(manifest().id)).toBe(false);
    svc.enableAddon(manifest().id);
    expect(svc.registry.isEnabled(manifest().id)).toBe(true);
  });

  it('uninstall removes the add-on and purges its grants', () => {
    const svc = createMemoryAddonService();
    const installed = svc.installFromCatalog('com.icecream.sample-sum-reporter');
    const g = svc.requestGrant(installed.manifest.id, 'doc-1', [READ], 'user-1');
    svc.approveGrant(g.id, 'user-1');
    const res = svc.uninstallAddon(installed.manifest.id);
    expect(res.removed).toBe(true);
    expect(res.grantsPurged).toBe(1);
    expect(svc.registry.get(installed.manifest.id)).toBeUndefined();
    expect(svc.grants.effective(installed.manifest.id, 'doc-1', '1.0.0')).toEqual([]);
  });

  it('signature verifier hook can block installs', () => {
    const svc = createMemoryAddonService({ verifySignature: () => false });
    expect(() =>
      svc.registry.install(manifest({ signature: 'sig-123' }), SUM_CODE, { allowSideload: true }),
    ).toThrow(/signature/);
  });

  it('corrupt persisted payloads deserialize to empty, not exceptions', () => {
    expect(deserializeAddons('not json')).toEqual([]);
    expect(deserializeAddons('{"addons":"nope"}')).toEqual([]);
    expect(deserializeGrants('not json')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Capability grant flow
// ---------------------------------------------------------------------------

describe('capability grant flow', () => {
  it('request starts pending; nothing is effective until approval', () => {
    const svc = createMemoryAddonService();
    const installed = svc.installFromCatalog('com.icecream.sample-sum-reporter');
    const g = svc.requestGrant(installed.manifest.id, 'doc-1', [READ], 'user-1');
    expect(g.status).toBe('pending');
    expect(svc.grants.effective(installed.manifest.id, 'doc-1', '1.0.0')).toEqual([]);
  });

  it('approve activates the grant; deny leaves it ineffective', () => {
    const svc = createMemoryAddonService();
    const installed = svc.installFromCatalog('com.icecream.sample-sum-reporter');
    const g1 = svc.requestGrant(installed.manifest.id, 'doc-1', [READ], 'user-1');
    svc.approveGrant(g1.id, 'user-1');
    expect(svc.grants.get(g1.id)?.status).toBe('active');
    expect(svc.grants.effective(installed.manifest.id, 'doc-1', '1.0.0')).toEqual([READ]);

    const g2 = svc.requestGrant(installed.manifest.id, 'doc-2', [READ], 'user-1');
    svc.denyGrant(g2.id, 'user-1');
    expect(svc.grants.get(g2.id)?.status).toBe('denied');
    expect(svc.grants.effective(installed.manifest.id, 'doc-2', '1.0.0')).toEqual([]);
  });

  it('revoke takes effect immediately (next invocation sees no grant)', () => {
    const svc = createMemoryAddonService();
    const installed = svc.installFromCatalog('com.icecream.sample-sum-reporter');
    const g = svc.requestGrant(installed.manifest.id, 'doc-1', [READ], 'user-1');
    svc.approveGrant(g.id, 'user-1');
    svc.revokeGrant(g.id, 'user-1');
    expect(svc.grants.effective(installed.manifest.id, 'doc-1', '1.0.0')).toEqual([]);
  });

  it('widening requires fresh approval; the old grant stays until then', () => {
    const svc = createMemoryAddonService();
    const installed = svc.installFromCatalog('com.icecream.sample-sum-reporter');
    const g1 = svc.requestGrant(installed.manifest.id, 'doc-1', [READ], 'user-1');
    svc.approveGrant(g1.id, 'user-1');
    const g2 = svc.requestGrant(installed.manifest.id, 'doc-1', [READ, WRITE], 'user-1');
    expect(g2.status).toBe('pending');
    // old footprint still in force while the widening request is pending
    expect(svc.grants.effective(installed.manifest.id, 'doc-1', '1.0.0')).toEqual([READ]);
    svc.approveGrant(g2.id, 'user-1');
    expect(svc.grants.effective(installed.manifest.id, 'doc-1', '1.0.0')).toEqual([READ, WRITE]);
    expect(svc.grants.get(g1.id)?.status).toBe('revoked'); // superseded
  });

  it('narrowing works without re-approval; widening via narrow throws', () => {
    const svc = createMemoryAddonService();
    const installed = svc.installFromCatalog('com.icecream.sample-sum-reporter');
    const g = svc.requestGrant(installed.manifest.id, 'doc-1', [READ, WRITE], 'user-1');
    svc.approveGrant(g.id, 'user-1');
    const narrowed = svc.narrowGrant(g.id, [READ], 'user-1');
    expect(narrowed.capabilities).toEqual([READ]);
    expect(() => svc.narrowGrant(g.id, [READ, WRITE, { kind: 'network' }], 'user-1')).toThrow(
      /fresh approval/,
    );
  });

  it('grants are version-bound: upgrade needs a new grant', () => {
    const svc = createMemoryAddonService();
    svc.registry.install(manifest({ version: '1.0.0' }), SUM_CODE, { allowSideload: true });
    const g = svc.requestGrant(manifest().id, 'doc-1', [READ], 'user-1');
    svc.approveGrant(g.id, 'user-1');
    svc.registry.install(manifest({ version: '2.0.0' }), SUM_CODE, { allowSideload: true });
    expect(svc.grants.effective(manifest().id, 'doc-1', '2.0.0')).toEqual([]);
    expect(svc.grants.effective(manifest().id, 'doc-1', '1.0.0')).toEqual([READ]);
  });

  it('identical repeat request short-circuits to the active grant', () => {
    const svc = createMemoryAddonService();
    const installed = svc.installFromCatalog('com.icecream.sample-sum-reporter');
    const g1 = svc.requestGrant(installed.manifest.id, 'doc-1', [READ], 'user-1');
    svc.approveGrant(g1.id, 'user-1');
    const g2 = svc.requestGrant(installed.manifest.id, 'doc-1', [READ], 'user-1');
    expect(g2.id).toBe(g1.id);
    expect(svc.grants.list()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Sandbox enforcement
// ---------------------------------------------------------------------------

describe('worker sandbox', () => {
  it('runs add-on code end-to-end and returns the value', async () => {
    const { svc, binding, authorizer, principal } = wiredService();
    const res = await svc.run(
      { addonId: 'com.icecream.sample-sum-reporter', binding, args: { ref: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 1, endCol: 1 } } },
      { principal, authorizer },
    );
    expect(res.ok).toBe(true);
    expect(res).toEqual({ ok: true, value: { sum: 10, count: 4 } });
  });

  it('blocks ambient globals: process, require, fetch, timers, console, eval, Function', async () => {
    const code = `function main() {
      var out = {
        process: typeof process, require: typeof require, fetch: typeof fetch,
        setTimeout: typeof setTimeout, console: typeof console, parentPort: typeof parentPort
      };
      try { eval('1'); out.evalErr = null; } catch (e) { out.evalErr = String(e); }
      try { new Function('return 1'); out.fnErr = null; } catch (e) { out.fnErr = String(e); }
      return out;
    }`;
    const res = await runAddonInWorker({
      code,
      entrypoint: 'main',
      invocation: { addonId: 'probe', documentId: 'doc-1', principal: 'user-1' },
      onOp: () => null,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const v = res.value as Record<string, string>;
      expect(v.process).toBe('undefined');
      expect(v.require).toBe('undefined');
      expect(v.fetch).toBe('undefined');
      expect(v.setTimeout).toBe('undefined');
      expect(v.console).toBe('undefined');
      expect(v.parentPort).toBe('undefined');
      expect(v.evalErr).toMatch(/not a function|undefined/);
      expect(v.fnErr).toMatch(/not a function|undefined|not a constructor/);
    }
  });

  it('terminates an infinite loop with a timeout', async () => {
    const res = await runAddonInWorker({
      code: 'function main() { while (true) {} }',
      entrypoint: 'main',
      invocation: { addonId: 'looper', documentId: 'doc-1', principal: 'user-1' },
      limits: { cpuMs: 300, wallMs: 8000 },
      onOp: () => null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('timeout');
  }, 15000);

  it('terminates a memory hog at the cap; the host survives', async () => {
    const res = await runAddonInWorker({
      code: 'function main() { var a = []; while (true) { a.push(new Array(1000000).fill(0)); } return 1; }',
      entrypoint: 'main',
      invocation: { addonId: 'hog', documentId: 'doc-1', principal: 'user-1' },
      limits: { cpuMs: 20000, wallMs: 30000, maxOldMb: 64, maxYoungMb: 16 },
      onOp: () => null,
    });
    expect(res.ok).toBe(false); // host process is still alive to assert this
    if (!res.ok) expect(['memory-limit', 'crashed']).toContain(res.code);
  }, 45000);

  it('rejects async entrypoints in v1', async () => {
    const res = await runAddonInWorker({
      code: 'async function main() { return 1; }',
      entrypoint: 'main',
      invocation: { addonId: 'async-add', documentId: 'doc-1', principal: 'user-1' },
      onOp: () => null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/async/i);
  });

  it('rejects a missing entrypoint', async () => {
    const res = await runAddonInWorker({
      code: 'function other() { return 1; }',
      entrypoint: 'main',
      invocation: { addonId: 'noentry', documentId: 'doc-1', principal: 'user-1' },
      onOp: () => null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/entrypoint not found/);
  });

  it('routes addon.log to the host onLog', async () => {
    const seen: unknown[][] = [];
    const res = await runAddonInWorker({
      code: 'function main() { addon.log("hello", 42); return 1; }',
      entrypoint: 'main',
      invocation: { addonId: 'logger', documentId: 'doc-1', principal: 'user-1' },
      onOp: () => null,
      onLog: (values) => seen.push(values),
    });
    expect(res.ok).toBe(true);
    expect(seen).toEqual([['hello', 42]]);
  });
});

// ---------------------------------------------------------------------------
// authorize() identity propagation
// ---------------------------------------------------------------------------

describe('authorize() propagation', () => {
  it('carries the granting user principal through authorize()', async () => {
    const { svc, binding, authorizer, principal } = wiredService();
    const res = await svc.run(
      { addonId: 'com.icecream.sample-sum-reporter', binding },
      { principal, authorizer },
    );
    expect(res.ok).toBe(true);
    expect(authorizer.log.length).toBeGreaterThan(0);
    for (const entry of authorizer.log) {
      expect(entry.principal).toBe('user-1'); // granting user, not the add-on
      expect(entry.grants).toEqual(['addon:com.icecream.sample-sum-reporter']); // add-on identity
    }
  });

  it('write without the write capability fails closed', async () => {
    const svc = createMemoryAddonService();
    const installed = svc.installFromCatalog('com.icecream.sample-cell-stamper');
    const g = svc.requestGrant(installed.manifest.id, 'doc-1', [READ], 'user-1'); // read only!
    svc.approveGrant(g.id, 'user-1');
    const binding = createMemoryBinding('doc-1', { Sheet1: [['a']] });
    const authorizer = new TestAuthorizer();
    const res = await svc.run(
      { addonId: installed.manifest.id, binding, args: { ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 'x' } },
      { principal: 'user-1', authorizer },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('auth');
      expect(res.error).toMatch(/lacks 'write' capability/);
    }
    expect(binding.readCell({ sheet: 'Sheet1', row: 0, col: 0 })).toBe('a'); // untouched
  });

  it('write with capability but denying policy is rejected and audit-logged', async () => {
    const svc = createMemoryAddonService();
    const installed = svc.installFromCatalog('com.icecream.sample-cell-stamper');
    const g = svc.requestGrant(installed.manifest.id, 'doc-1', [READ, WRITE], 'user-1');
    svc.approveGrant(g.id, 'user-1');
    const binding = createMemoryBinding('doc-1', { Sheet1: [['a']] });
    const authorizer = new TestAuthorizer((action) => !action.includes('write')); // user lost write
    const res = await svc.run(
      { addonId: installed.manifest.id, binding, args: { ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 'x' } },
      { principal: 'user-1', authorizer },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('auth');
      expect(res.error).toMatch(/denied by policy/);
    }
    const denied = authorizer.log.find((e) => e.action === 'addon.cell.write');
    expect(denied?.principal).toBe('user-1');
    expect(binding.readCell({ sheet: 'Sheet1', row: 0, col: 0 })).toBe('a');
  });

  it('scoped capabilities confine the add-on to the granted sheets', async () => {
    const { authorizer, principal } = wiredService({
      capabilities: [{ kind: 'read', scope: { sheets: ['Sheet1'] } }],
    });
    const binding = createMemoryBinding('doc-1', { Sheet1: [[1]], Secret: [[999]] });
    const ctx: InvocationContext = {
      addonId: 'com.icecream.sample-sum-reporter',
      documentId: 'doc-1',
      principal,
      capabilities: [{ kind: 'read', scope: { sheets: ['Sheet1'] } }],
      authorizer,
      binding,
    };
    await expect(
      executeOp(ctx, 'sheets.getRange', { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 0 }),
    ).resolves.toEqual([[1]]);
    await expect(
      executeOp(ctx, 'sheets.getRange', { sheet: 'Secret', startRow: 0, startCol: 0, endRow: 0, endCol: 0 }),
    ).rejects.toThrow(AddonAuthError);
  });

  it('refuses to run with no active grant', async () => {
    const svc = createMemoryAddonService();
    svc.installFromCatalog('com.icecream.sample-sum-reporter');
    const binding = createMemoryBinding('doc-1');
    const res = await svc.run(
      { addonId: 'com.icecream.sample-sum-reporter', binding },
      { principal: 'user-1', authorizer: new TestAuthorizer() },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('auth');
      expect(res.error).toMatch(/no active grant/);
    }
  });

  it('refuses to run a disabled add-on', async () => {
    const { svc, binding, authorizer, principal } = wiredService();
    svc.disableAddon('com.icecream.sample-sum-reporter');
    const res = await svc.run(
      { addonId: 'com.icecream.sample-sum-reporter', binding },
      { principal, authorizer },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/disabled/);
  });

  it('fails closed with no principal', async () => {
    const { svc, binding, authorizer } = wiredService();
    const res = await svc.run(
      { addonId: 'com.icecream.sample-sum-reporter', binding },
      { principal: '', authorizer },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('auth');
  });

  it('every op is audit-logged with both identities', async () => {
    const { svc, binding, authorizer, principal } = wiredService();
    await svc.run(
      {
        addonId: 'com.icecream.sample-sum-reporter',
        binding,
        args: { ref: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 0 } },
      },
      { principal, authorizer },
    );
    const reads = authorizer.log.filter((e) => e.action === 'addon.range.read');
    expect(reads.length).toBe(1);
    expect(reads[0].principal).toBe('user-1');
    expect(reads[0].grants).toEqual(['addon:com.icecream.sample-sum-reporter']);
    expect(reads[0].target).toBe('doc:doc-1/sheet:Sheet1/range:R0C0:R0C0');
  });

  it('works with the real engine Authorizer (structural contract)', async () => {
    const svc = createMemoryAddonService();
    const installed = svc.installFromCatalog('com.icecream.sample-sum-reporter');
    const g = svc.requestGrant(installed.manifest.id, 'doc-1', [READ], 'user-1');
    svc.approveGrant(g.id, 'user-1');
    const binding = createMemoryBinding('doc-1', { Sheet1: [[5]] });
    const engineAuthorizer = new Authorizer(); // default allow-all policy, records audit
    const res = await svc.run(
      { addonId: installed.manifest.id, binding },
      { principal: 'user-1', authorizer: engineAuthorizer },
    );
    expect(res.ok).toBe(true);
    const audit = engineAuthorizer.auditLog();
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0].principal).toBe('user-1');
  });

  it('net.fetch needs the network capability; without it the add-on cannot exfiltrate', async () => {
    const { svc, binding, authorizer, principal } = wiredService(); // read-only grant
    const ctx: InvocationContext = {
      addonId: 'com.icecream.sample-sum-reporter',
      documentId: 'doc-1',
      principal,
      capabilities: [READ],
      authorizer,
      binding,
    };
    await expect(executeOp(ctx, 'net.fetch', { url: 'https://example.com' })).rejects.toThrow(
      /lacks 'network' capability/,
    );
  });

  it('net.fetch with the capability goes through the host proxy and authorize()', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      headers: { forEach: (cb: (v: string, k: string) => void) => cb('text/plain', 'content-type') },
      arrayBuffer: async () => new TextEncoder().encode('ok-body').buffer,
    })) as unknown as typeof fetch;
    const ctx: InvocationContext = {
      addonId: 'probe',
      documentId: 'doc-1',
      principal: 'user-1',
      capabilities: [{ kind: 'network' }],
      authorizer: new TestAuthorizer(),
      binding: createMemoryBinding('doc-1'),
      fetchImpl,
    };
    const res = (await executeOp(ctx, 'net.fetch', { url: 'https://example.com/x' })) as {
      status: number;
      body: string;
    };
    expect(res.status).toBe(200);
    expect(res.body).toBe('ok-body');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(executeOp(ctx, 'net.fetch', { url: 'ftp://example.com/x' })).rejects.toThrow(
      /http\(s\)/,
    );
  });

  it('rejects unknown ops and oversized ranges', async () => {
    const ctx: InvocationContext = {
      addonId: 'probe',
      documentId: 'doc-1',
      principal: 'user-1',
      capabilities: [READ, WRITE],
      authorizer: new TestAuthorizer(),
      binding: createMemoryBinding('doc-1'),
    };
    await expect(executeOp(ctx, 'nope.evil' as never, null)).rejects.toThrow(AddonAuthError);
    await expect(
      executeOp(ctx, 'sheets.getRange', { sheet: 'S', startRow: 0, startCol: 0, endRow: 999, endCol: 999 }),
    ).rejects.toThrow(/exceeds/);
    await expect(
      executeOp(ctx, 'sheets.setCell', { ref: { sheet: 'S', row: 0, col: 0 }, value: {} }),
    ).rejects.toThrow(/string\|number\|boolean\|null/);
  });

  it('run() surfaces a throwing authorizer as auth failure, never a leak', async () => {
    const svc = createMemoryAddonService();
    const installed = svc.installFromCatalog('com.icecream.sample-sum-reporter');
    const g = svc.requestGrant(installed.manifest.id, 'doc-1', [READ], 'user-1');
    svc.approveGrant(g.id, 'user-1');
    const exploding: AuthorizerLike = {
      authorize: () => {
        throw new Error('authorize: missing principal (fail closed)');
      },
    };
    const res = await svc.run(
      { addonId: installed.manifest.id, binding: createMemoryBinding('doc-1') },
      { principal: 'user-1', authorizer: exploding },
    );
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Service-level validation
// ---------------------------------------------------------------------------

describe('addon service', () => {
  it('requestGrant for an unknown add-on throws AddonServiceError', () => {
    const svc = createMemoryAddonService();
    expect(() => svc.requestGrant('nope', 'doc-1', [READ], 'user-1')).toThrow(AddonServiceError);
  });

  it('addon.log from the worker reaches the service onLog', async () => {
    const lines: { addonId: string; values: unknown[] }[] = [];
    const svc = createMemoryAddonService({
      onLog: (addonId, values) => lines.push({ addonId, values }),
    });
    svc.registry.install(
      manifest({ id: 'com.example.logger', capabilities: [READ] }),
      'function main() { addon.log("ping"); return 1; }',
      { allowSideload: true },
    );
    const g = svc.requestGrant('com.example.logger', 'doc-1', [READ], 'user-1');
    svc.approveGrant(g.id, 'user-1');
    const res = await svc.run(
      { addonId: 'com.example.logger', binding: createMemoryBinding('doc-1') },
      { principal: 'user-1', authorizer: new TestAuthorizer() },
    );
    expect(res.ok).toBe(true);
    expect(lines).toEqual([{ addonId: 'com.example.logger', values: ['ping'] }]);
  });
});

describe('engine document binding (add-on-model.md §5 production binding)', () => {
  function openWorkbook(): EngineHost {
    const host = new EngineHost();
    expect(
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 10 }),
    ).toMatchObject({ ok: true });
    expect(
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 1, col: 0 }, value: 20 }),
    ).toMatchObject({ ok: true });
    expect(
      host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 1 }, value: 'hi' }),
    ).toMatchObject({ ok: true });
    return host;
  }

  it('reads real workbook values through the typed view', () => {
    const host = openWorkbook();
    const binding = createEngineDocumentBinding('doc-1', host, {
      principal: 'user:alice',
      addonId: 'com.example.sum',
    });
    expect(binding.documentId).toBe('doc-1');
    expect(binding.listSheets()).toContain('Sheet1');
    expect(binding.readCell({ sheet: 'Sheet1', row: 0, col: 0 })).toBe(10);
    expect(binding.readCell({ sheet: 'Sheet1', row: 0, col: 1 })).toBe('hi');
    expect(binding.readCell({ sheet: 'Sheet1', row: 9, col: 9 })).toBe(null);
    expect(
      binding.readRange({ sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 1, endCol: 1 }),
    ).toEqual([
      [10, 'hi'],
      [20, null],
    ]);
  });

  it('hidden cells read as null (never leak through the binding)', () => {
    const host = openWorkbook();
    // Row 1 is hidden from user:alice; the host's hidden check feeds the
    // typed view's #PERM! path, which the binding coerces to null.
    host.setHiddenCheck((ref, principal) => principal === 'user:alice' && ref.row === 1);
    const binding = createEngineDocumentBinding('doc-1', host, {
      principal: 'user:alice',
      addonId: 'com.example.sum',
    });
    expect(binding.readCell({ sheet: 'Sheet1', row: 0, col: 0 })).toBe(10);
    expect(binding.readCell({ sheet: 'Sheet1', row: 1, col: 0 })).toBe(null);
  });

  it('writes land in the real workbook', () => {
    const host = openWorkbook();
    const binding = createEngineDocumentBinding('doc-1', host, {
      principal: 'user:alice',
      addonId: 'com.example.stamper',
    });
    binding.writeCell({ sheet: 'Sheet1', row: 2, col: 0 }, 'stamped');
    binding.writeRange(
      { sheet: 'Sheet1', startRow: 3, startCol: 0, endRow: 3, endCol: 1 },
      [['a', 'b']],
    );
    expect(host.readCell({ sheet: 'Sheet1', row: 2, col: 0 })).toMatchObject({
      kind: 'string',
      value: 'stamped',
    });
    expect(binding.readCell({ sheet: 'Sheet1', row: 3, col: 1 })).toBe('b');
  });

  it('install → grant → run executes against the open workbook (not seeded data)', async () => {
    const host = openWorkbook();
    const svc = createMemoryAddonService();
    svc.registry.install(
      manifest({ id: 'com.example.sum', capabilities: [READ] }),
      `function main(args) {
         const ref = args.ref;
         const values = addon.sheets.getRange(ref);
         let sum = 0, count = 0;
         for (const row of values) for (const v of row) {
           if (typeof v === 'number') { sum += v; count++; }
         }
         return { sum, count };
       }`,
      { allowSideload: true },
    );
    const g = svc.requestGrant('com.example.sum', 'doc-1', [READ], 'user:alice');
    svc.approveGrant(g.id, 'user:alice');

    // The real host authorizer (not a test stub): the add-on's ops go
    // through authorize() with the granting user's principal.
    const binding = createEngineDocumentBinding('doc-1', host, {
      principal: 'user:alice',
      addonId: 'com.example.sum',
    });
    const res = await svc.run(
      {
        addonId: 'com.example.sum',
        binding,
        args: { ref: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 1, endCol: 0 } },
      },
      { principal: 'user:alice', authorizer: host.getAuthorizer() },
    );
    expect(res).toEqual({ ok: true, value: { sum: 30, count: 2 } });
  });

  it('requires a non-empty principal (fail closed)', () => {
    const host = new EngineHost();
    expect(() =>
      createEngineDocumentBinding('doc-1', host, { principal: '', addonId: 'x' }),
    ).toThrow(AddonAuthError);
  });
});
