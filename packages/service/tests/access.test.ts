/**
 * Tests for the access table + policy (access.ts):
 * nearest-explicit-wins, default deny, the role→action matrix, inheritance
 * workbook → sheet → range → cell, and the owner transfer rule.
 */
import { describe, expect, it } from 'vitest';
import {
  AccessTable,
  accessPolicy,
  cellObjectId,
  KeyManager,
  memoryPersistence,
  rangeObjectId,
  sheetObjectId,
  workbookObjectId,
  type AccessLevel,
} from '../src/index.js';

const OWNER = 'user:owner';
const MGR = 'user:mgr';
const ED = 'user:ed';
const VIEW = 'user:view';
const NOBODY = 'user:nobody';

async function tableWithOwner(wb = 'wb1'): Promise<AccessTable> {
  const t = await AccessTable.create(memoryPersistence(), new KeyManager(memoryPersistence()));
  await t.grantWorkbook(wb, OWNER);
  return t;
}

describe('grantWorkbook', () => {
  it('records the creator as owner at the root', async () => {
    const t = await tableWithOwner();
    expect(t.resolveLevel(workbookObjectId('wb1'), OWNER)).toBe('owner');
    expect(t.allEntries()).toHaveLength(1);
  });
});

describe('inheritance walk', () => {
  it('grants inherit workbook -> sheet -> cell', async () => {
    const t = await tableWithOwner();
    await t.grant(workbookObjectId('wb1'), ED, 'editor', OWNER);
    const policy = accessPolicy(t, 'wb1');
    expect(policy('cell.write', 'Sheet1!A1', { principal: ED })).toBe(true);
    expect(policy('cell.write', 'Other!Z99', { principal: ED })).toBe(true);
  });

  it('nearest explicit entry wins (sheet override narrows workbook grant)', async () => {
    const t = await tableWithOwner();
    await t.grant(workbookObjectId('wb1'), ED, 'editor', OWNER);
    await t.grant(sheetObjectId('wb1', 'Locked'), ED, 'viewer', OWNER);
    const policy = accessPolicy(t, 'wb1');
    expect(policy('cell.write', 'Sheet1!A1', { principal: ED })).toBe(true);
    expect(policy('cell.write', 'Locked!A1', { principal: ED })).toBe(false);
    expect(policy('cell.read', 'Locked!A1', { principal: ED })).toBe(true);
  });

  it('a more specific grant widens again (cell override over sheet)', async () => {
    const t = await tableWithOwner();
    await t.grant(sheetObjectId('wb1', 'Sheet1'), ED, 'viewer', OWNER);
    await t.grant(cellObjectId('wb1', 'Sheet1', 'B2'), ED, 'editor', OWNER);
    const policy = accessPolicy(t, 'wb1');
    expect(policy('cell.write', 'Sheet1!B2', { principal: ED })).toBe(true);
    expect(policy('cell.write', 'Sheet1!B3', { principal: ED })).toBe(false);
  });

  it('range entries cover their cells; smallest containing range wins', async () => {
    const t = await tableWithOwner();
    await t.grant(workbookObjectId('wb1'), ED, 'viewer', OWNER);
    await t.grant(rangeObjectId('wb1', 'Sheet1', 'A1:B2'), ED, 'editor', OWNER);
    await t.grant(rangeObjectId('wb1', 'Sheet1', 'A1:A1'), ED, 'manager', OWNER);
    const policy = accessPolicy(t, 'wb1');
    // A1: smallest containing range is A1:A1 (manager) -> sheet.add allowed
    expect(policy('sheet.add', 'Sheet1', { principal: ED })).toBe(false); // sheet target, not the cell
    expect(policy('cell.write', 'Sheet1!A1', { principal: ED })).toBe(true);
    // B2: only A1:B2 applies -> editor -> cell.write yes, manage no
    expect(policy('cell.write', 'Sheet1!B2', { principal: ED })).toBe(true);
    // C3: workbook viewer only
    expect(policy('cell.write', 'Sheet1!C3', { principal: ED })).toBe(false);
    expect(policy('cell.read', 'Sheet1!C3', { principal: ED })).toBe(true);
  });
});

describe('default deny', () => {
  it('unknown principals get nothing', async () => {
    const t = await tableWithOwner();
    await t.grant(workbookObjectId('wb1'), ED, 'editor', OWNER);
    const policy = accessPolicy(t, 'wb1');
    for (const action of ['cell.read', 'cell.write', 'sheet.add', 'workbook.delete', 'workbook.download']) {
      expect(policy(action, 'Sheet1!A1', { principal: NOBODY })).toBe(false);
    }
  });

  it('unknown actions are denied even for the owner', async () => {
    const t = await tableWithOwner();
    const policy = accessPolicy(t, 'wb1');
    expect(policy('nuke.everything', 'Sheet1!A1', { principal: OWNER })).toBe(false);
  });

  it('missing principal throws (fail closed)', async () => {
    const t = await tableWithOwner();
    const policy = accessPolicy(t, 'wb1');
    expect(() => policy('cell.read', 'Sheet1!A1', { principal: '' })).toThrow(/missing principal/);
  });
});

describe('role -> action matrix', () => {
  async function policyFor(level: AccessLevel) {
    const t = await tableWithOwner();
    const p = level === 'owner' ? OWNER : `user:${level}`;
    if (level !== 'owner') await t.grant(workbookObjectId('wb1'), p, level, OWNER);
    return accessPolicy(t, 'wb1');
  }
  const cell = 'Sheet1!A1';
  const sheet = 'Sheet1';

  const matrix: Array<[string, Record<AccessLevel, boolean>]> = [
    ['cell.read', { viewer: true, editor: true, manager: true, owner: true }],
    ['range.read', { viewer: true, editor: true, manager: true, owner: true }],
    ['workbook.download', { viewer: true, editor: true, manager: true, owner: true }],
    ['cell.write', { viewer: false, editor: true, manager: true, owner: true }],
    ['cell.clear', { viewer: false, editor: true, manager: true, owner: true }],
    ['sheet.add', { viewer: false, editor: false, manager: true, owner: true }],
    ['sheet.delete', { viewer: false, editor: false, manager: true, owner: true }],
    ['sheet.duplicate', { viewer: false, editor: false, manager: true, owner: true }],
    ['sheet.move', { viewer: false, editor: false, manager: true, owner: true }],
    ['sheet.rename', { viewer: false, editor: true, manager: true, owner: true }],
    ['sheet.hide', { viewer: false, editor: false, manager: true, owner: true }],
    ['calc.setMode', { viewer: false, editor: false, manager: true, owner: true }],
    ['unprotect', { viewer: false, editor: false, manager: true, owner: true }],
    ['grant', { viewer: false, editor: false, manager: true, owner: true }],
    ['workbook.delete', { viewer: false, editor: false, manager: false, owner: true }],
    ['workbook.transfer', { viewer: false, editor: false, manager: false, owner: true }],
  ];

  for (const [action, expected] of matrix) {
    it(`'${action}'`, async () => {
      const levels: AccessLevel[] = ['viewer', 'editor', 'manager', 'owner'];
      for (const level of levels) {
        const target = action.startsWith('workbook.') || action === 'calc.setMode' ? '' : action.startsWith('sheet.') || action === 'grant' || action === 'unprotect' ? sheet : cell;
        expect(
          (await policyFor(level))(action, target, { principal: level === 'owner' ? OWNER : `user:${level}` }),
          `${action} as ${level}`,
        ).toBe(expected[level]);
      }
    });
  }
});

describe('platform-shell §3 structural permissions', () => {
  async function policyFor(level: AccessLevel) {
    const t = await tableWithOwner();
    const p = level === 'owner' ? OWNER : `user:${level}`;
    if (level !== 'owner') await t.grant(workbookObjectId('wb1'), p, level, OWNER);
    return accessPolicy(t, 'wb1');
  }
  const as = (level: AccessLevel) => (level === 'owner' ? OWNER : `user:${level}`);

  it('renaming a sheet needs write on the sheet: editor can, viewer cannot', async () => {
    expect((await policyFor('editor'))('sheet.rename', 'Sheet1', { principal: as('editor') })).toBe(true);
    expect((await policyFor('viewer'))('sheet.rename', 'Sheet1', { principal: as('viewer') })).toBe(false);
  });

  it('reordering sheets needs the manage right: manager can, editor cannot', async () => {
    expect((await policyFor('manager'))('sheet.move', 'Sheet1', { principal: as('manager') })).toBe(true);
    expect((await policyFor('editor'))('sheet.move', 'Sheet1', { principal: as('editor') })).toBe(false);
    expect((await policyFor('viewer'))('sheet.move', 'Sheet1', { principal: as('viewer') })).toBe(false);
  });

  it('duplicating sheets needs the manage right: manager can, editor cannot', async () => {
    expect((await policyFor('manager'))('sheet.duplicate', 'Sheet1', { principal: as('manager') })).toBe(true);
    expect((await policyFor('editor'))('sheet.duplicate', 'Sheet1', { principal: as('editor') })).toBe(false);
  });
});

describe('grant/revoke rules (§2)', () => {
  it('manager can grant only levels they hold (no escalation)', async () => {
    const t = await tableWithOwner();
    await t.grant(workbookObjectId('wb1'), MGR, 'manager', OWNER);
    await t.grant(workbookObjectId('wb1'), ED, 'editor', MGR); // ok
    await expect(t.grant(workbookObjectId('wb1'), ED, 'owner', MGR)).rejects.toThrow(/transferOwnership/);
    await expect(t.grant(workbookObjectId('wb1'), VIEW, 'manager', ED)).rejects.toThrow(/manage right/);
  });

  it('editor cannot grant at all', async () => {
    const t = await tableWithOwner();
    await t.grant(workbookObjectId('wb1'), ED, 'editor', OWNER);
    await expect(t.grant(workbookObjectId('wb1'), VIEW, 'viewer', ED)).rejects.toThrow(/manage right/);
  });

  it("manager cannot modify the owner's grant", async () => {
    const t = await tableWithOwner();
    await t.grant(workbookObjectId('wb1'), MGR, 'manager', OWNER);
    await expect(t.revoke(workbookObjectId('wb1'), OWNER, MGR)).rejects.toThrow(/transfer/);
  });

  it('revoke removes the entry (inheritance falls back)', async () => {
    const t = await tableWithOwner();
    await t.grant(workbookObjectId('wb1'), ED, 'editor', OWNER);
    await t.grant(sheetObjectId('wb1', 'Sheet1'), ED, 'viewer', OWNER);
    const policy = accessPolicy(t, 'wb1');
    expect(policy('cell.write', 'Sheet1!A1', { principal: ED })).toBe(false);
    await t.revoke(sheetObjectId('wb1', 'Sheet1'), ED, OWNER);
    expect(policy('cell.write', 'Sheet1!A1', { principal: ED })).toBe(true);
  });
});

describe('owner transfer rule', () => {
  it('transferOwnership is owner-only', async () => {
    const t = await tableWithOwner();
    await t.grant(workbookObjectId('wb1'), MGR, 'manager', OWNER);
    await expect(t.transferOwnership('wb1', MGR, ED)).rejects.toThrow(/only the current owner/);
  });

  it('transfer moves the owner grant', async () => {
    const t = await tableWithOwner();
    const policy = accessPolicy(t, 'wb1');
    await t.transferOwnership('wb1', OWNER, ED);
    expect(t.resolveLevel(workbookObjectId('wb1'), ED)).toBe('owner');
    expect(t.resolveLevel(workbookObjectId('wb1'), OWNER)).toBeNull();
    expect(policy('workbook.delete', '', { principal: ED })).toBe(true);
    expect(policy('workbook.delete', '', { principal: OWNER })).toBe(false);
    expect(t.auditLog().some((a) => a.kind === 'transfer')).toBe(true);
  });
});

describe('persistence', () => {
  it('entries and audit trail survive reload via encrypted storage', async () => {
    const p = memoryPersistence();
    const keys = new KeyManager(memoryPersistence());
    const t1 = await AccessTable.create(p, keys);
    await t1.grantWorkbook('wb1', OWNER);
    await t1.grant(sheetObjectId('wb1', 'S'), ED, 'editor', OWNER);
    const t2 = await AccessTable.create(p, keys);
    expect(t2.resolveLevel(workbookObjectId('wb1'), OWNER)).toBe('owner');
    expect(t2.resolveLevel(sheetObjectId('wb1', 'S'), ED)).toBe('editor');
    // The audit trail is persisted too (encrypted).
    expect(t2.auditLog().some((a) => a.kind === 'grant' && a.principal === ED)).toBe(true);
  });

  it('stored bytes are ciphertext, not plaintext', async () => {
    const p = memoryPersistence();
    const keys = new KeyManager(memoryPersistence());
    const t = await AccessTable.create(p, keys);
    await t.grantWorkbook('wb1', OWNER);
    await t.grant(sheetObjectId('wb1', 'S'), ED, 'editor', OWNER);
    const raw = p.load('icecream-sheets.secure.v1/__service__/icecream-sheets.access.v1');
    expect(raw).not.toBeNull();
    // No principal, object id, or level leaks into the stored bytes.
    for (const secret of [OWNER, ED, 'workbook:wb1', 'sheet:wb1:S', 'editor', 'owner']) {
      expect(raw as string).not.toContain(secret);
    }
    const env = JSON.parse(raw as string) as Record<string, unknown>;
    expect(env.version).toBe(1);
    expect(typeof env.keyId).toBe('string');
    expect(typeof env.iv).toBe('string');
    expect(typeof env.ciphertext).toBe('string');
  });

  it('tampered ciphertext fails closed', async () => {
    const p = memoryPersistence();
    const keys = new KeyManager(memoryPersistence());
    const t = await AccessTable.create(p, keys);
    await t.grantWorkbook('wb1', OWNER);
    const key = 'icecream-sheets.secure.v1/__service__/icecream-sheets.access.v1';
    const env = JSON.parse(p.load(key) as string) as Record<string, unknown>;
    env.ciphertext = (env.ciphertext as string).slice(0, -4) + 'AAAA';
    p.save(key, JSON.stringify(env));
    await expect(AccessTable.create(p, keys)).rejects.toThrow(/cannot decrypt|tampered/i);
  });
});

describe('access requests', () => {
  it('request → pending → approve → access granted', async () => {
    const t = await tableWithOwner();
    const root = workbookObjectId('wb1');
    const id = await t.requestAccess(root, NOBODY, { level: 'editor', message: 'need to edit Q1' });
    expect(typeof id).toBe('string');

    const pending = t.pendingRequests(root);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id,
      objectId: root,
      principal: NOBODY,
      requestedLevel: 'editor',
      message: 'need to edit Q1',
    });

    // Not granted yet: still default-deny.
    expect(t.resolveLevel(root, NOBODY)).toBeNull();

    await t.approveAccessRequest(id, OWNER);
    expect(t.resolveLevel(root, NOBODY)).toBe('editor');
    expect(t.pendingRequests(root)).toHaveLength(0);
    const policy = accessPolicy(t, 'wb1');
    expect(policy('cell.write', 'Sheet1!A1', { principal: NOBODY })).toBe(true);

    const kinds = t.auditLog().map((a) => a.kind);
    expect(kinds).toContain('access-request');
    expect(kinds).toContain('access-approve');
  });

  it('approve can override the requested level', async () => {
    const t = await tableWithOwner();
    const id = await t.requestAccess(workbookObjectId('wb1'), NOBODY, { level: 'viewer' });
    await t.approveAccessRequest(id, OWNER, 'manager');
    expect(t.resolveLevel(workbookObjectId('wb1'), NOBODY)).toBe('manager');
  });

  it('deny leaves the requester denied and removes the request', async () => {
    const t = await tableWithOwner();
    const root = workbookObjectId('wb1');
    const id = await t.requestAccess(root, NOBODY);
    await t.denyAccessRequest(id, OWNER);
    expect(t.resolveLevel(root, NOBODY)).toBeNull();
    expect(t.pendingRequests(root)).toHaveLength(0);
    const policy = accessPolicy(t, 'wb1');
    expect(policy('cell.read', 'Sheet1!A1', { principal: NOBODY })).toBe(false);
    expect(t.auditLog().map((a) => a.kind)).toContain('access-deny');
  });

  it('requesting a level already held throws; upgrades are allowed', async () => {
    const t = await tableWithOwner();
    const root = workbookObjectId('wb1');
    await t.grant(root, ED, 'viewer', OWNER);
    await expect(t.requestAccess(root, ED, { level: 'viewer' })).rejects.toThrow(/already has/);
    // viewer → editor is a legitimate upgrade request.
    const id = await t.requestAccess(root, ED, { level: 'editor' });
    expect(t.getAccessRequest(id)).not.toBeNull();
  });

  it('duplicate pending requests and ownership requests are rejected', async () => {
    const t = await tableWithOwner();
    const root = workbookObjectId('wb1');
    await t.requestAccess(root, NOBODY);
    await expect(t.requestAccess(root, NOBODY)).rejects.toThrow(/already has a pending request/);
    await expect(t.requestAccess(root, ED, { level: 'owner' })).rejects.toThrow(/ownership cannot be requested/);
  });

  it('a failed approval keeps the request pending', async () => {
    const t = await tableWithOwner();
    const root = workbookObjectId('wb1');
    await t.grant(root, MGR, 'manager', OWNER);
    await t.grant(root, VIEW, 'viewer', OWNER);
    const id = await t.requestAccess(root, NOBODY, { level: 'viewer' });
    // A viewer has no manage right — approval must fail and the request
    // must survive so a real manager can still decide.
    await expect(t.approveAccessRequest(id, VIEW)).rejects.toThrow(/manage right/);
    expect(t.pendingRequests(root)).toHaveLength(1);
    // A manager can also only approve within their own level (no escalation).
    await expect(t.approveAccessRequest(id, MGR, 'owner')).rejects.toThrow(/invalid approval level/);
    expect(t.pendingRequests(root)).toHaveLength(1);
    await t.approveAccessRequest(id, MGR, 'editor');
    expect(t.resolveLevel(root, NOBODY)).toBe('editor');
  });

  it('deny needs the manage right', async () => {
    const t = await tableWithOwner();
    const id = await t.requestAccess(workbookObjectId('wb1'), NOBODY);
    await expect(t.denyAccessRequest(id, ED)).rejects.toThrow(/manage right/);
    expect(t.pendingRequests()).toHaveLength(1);
  });

  it('the requester can cancel; others cannot', async () => {
    const t = await tableWithOwner();
    const id = await t.requestAccess(workbookObjectId('wb1'), NOBODY);
    await expect(t.cancelAccessRequest(id, ED)).rejects.toThrow(/not the requester/);
    await t.cancelAccessRequest(id, NOBODY);
    expect(t.pendingRequests()).toHaveLength(0);
    expect(t.auditLog().map((a) => a.kind).filter((k) => k === 'access-cancel')).toHaveLength(1);
  });

  it('unknown request ids throw', async () => {
    const t = await tableWithOwner();
    await expect(t.approveAccessRequest('req-nope', OWNER)).rejects.toThrow(/unknown access request/);
    await expect(t.denyAccessRequest('req-nope', OWNER)).rejects.toThrow(/unknown access request/);
    await expect(t.cancelAccessRequest('req-nope', NOBODY)).rejects.toThrow(/unknown access request/);
  });

  it('pending requests survive an encrypted round-trip', async () => {
    const p = memoryPersistence();
    const keys = new KeyManager(memoryPersistence());
    const t = await AccessTable.create(p, keys);
    await t.grantWorkbook('wb1', OWNER);
    const id = await t.requestAccess(workbookObjectId('wb1'), NOBODY, {
      level: 'editor',
      message: 'round trip',
    });
    const reloaded = await AccessTable.create(p, keys);
    const pending = reloaded.pendingRequests(workbookObjectId('wb1'));
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id, principal: NOBODY, requestedLevel: 'editor', message: 'round trip' });
    await reloaded.approveAccessRequest(id, OWNER);
    expect(reloaded.resolveLevel(workbookObjectId('wb1'), NOBODY)).toBe('editor');
  });
});
