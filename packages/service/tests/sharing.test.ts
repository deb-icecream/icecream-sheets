/**
 * Tests for SharingService (permission-model.md §2 grant/revoke flows):
 * levels, no-escalation, owner protection, transfer, and grant rows.
 */
import { describe, expect, it } from 'vitest';
import {
  SharingService,
  NameError,
  AccessTable,
  KeyManager,
  memoryPersistence,
} from '../src/index.js';

const OWNER = 'user:owner';
const MGR = 'user:mgr';
const ED = 'user:ed';
const WB = 'wb-share-test';

async function service() {
  const table = await AccessTable.create(memoryPersistence(), new KeyManager(memoryPersistence()));
  const svc = new SharingService({ table, workbookId: WB });
  await svc.ensureOwner(OWNER);
  return { table, svc };
}

describe('SharingService', () => {
  it('ensureOwner is idempotent and grants() lists the owner first', async () => {
    const { svc } = await service();
    await svc.ensureOwner(OWNER);
    const grants = svc.grants();
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ principal: OWNER, level: 'owner', isOwner: true });
    expect(grants[0]!.scope).toBe('Workbook');
  });

  it('grant/revoke Viewer/Editor/Manager with the manage right', async () => {
    const { svc } = await service();
    await svc.grant('user:a', 'viewer', OWNER);
    await svc.grant('user:b', 'editor', OWNER);
    await svc.grant(MGR, 'manager', OWNER);
    expect(svc.effectiveLevel('user:a')).toBe('viewer');
    expect(svc.effectiveLevel('user:b')).toBe('editor');
    expect(svc.canManage(MGR)).toBe(true);
    expect(svc.canManage('user:b')).toBe(false);
    await svc.revoke('user:a', OWNER);
    expect(svc.effectiveLevel('user:a')).toBeNull();
    expect(svc.grants().map((g) => g.principal).sort()).toEqual(['user:b', MGR, OWNER]);
  });

  it('a manager cannot escalate above their own level', async () => {
    const { svc } = await service();
    await svc.grant(MGR, 'manager', OWNER);
    await expect(svc.grant('user:x', 'manager', MGR)).resolves.not.toThrow();
    // Granting owner is not a share level at all.
    await expect(svc.grant('user:x', 'owner' as never, MGR)).rejects.toThrowError(NameError);
    // An editor cannot grant.
    await svc.grant(ED, 'editor', OWNER);
    await expect(svc.grant('user:y', 'viewer', ED)).rejects.toThrowError(NameError);
  });

  it("the owner's grant cannot be revoked by a manager", async () => {
    const { svc } = await service();
    await svc.grant(MGR, 'manager', OWNER);
    await expect(svc.revoke(OWNER, MGR)).rejects.toThrowError(NameError);
    expect(svc.effectiveLevel(OWNER)).toBe('owner');
  });

  it('transferOwnership is owner-only and moves the grant', async () => {
    const { svc } = await service();
    await expect(svc.transferOwnership(MGR, 'user:new')).rejects.toThrowError(NameError);
    await svc.transferOwnership(OWNER, 'user:new');
    expect(svc.effectiveLevel('user:new')).toBe('owner');
    expect(svc.effectiveLevel(OWNER)).toBeNull();
  });

  it('rejects blank principals', async () => {
    const { svc } = await service();
    await expect(svc.grant('', 'viewer', OWNER)).rejects.toThrowError(NameError);
    await expect(svc.grant('user:a', 'viewer', '')).rejects.toThrowError(NameError);
  });

  it('level labels describe each role', async () => {
    expect(SharingService.levelLabel('viewer')).toMatch(/read only/);
    expect(SharingService.levelLabel('manager')).toMatch(/share/);
    expect(SharingService.levelLabel('owner')).toMatch(/transfer/);
  });
});

describe('SharingService access requests', () => {
  it('request → pending → approve → access granted', async () => {
    const { svc } = await service();
    const requester = 'user:requester';
    const id = await svc.requestAccess(requester, { level: 'editor', message: 'Q1 close' });
    expect(typeof id).toBe('string');

    const pending = svc.pendingRequests();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id,
      principal: requester,
      requestedLevel: 'editor',
      message: 'Q1 close',
      scope: 'Workbook',
    });
    expect(svc.effectiveLevel(requester)).toBeNull();

    await svc.approveRequest(id, OWNER);
    expect(svc.effectiveLevel(requester)).toBe('editor');
    expect(svc.pendingRequests()).toHaveLength(0);
  });

  it('approve can grant a different level than requested', async () => {
    const { svc } = await service();
    const id = await svc.requestAccess('user:r', { level: 'viewer' });
    await svc.approveRequest(id, OWNER, 'manager');
    expect(svc.effectiveLevel('user:r')).toBe('manager');
  });

  it('deny removes the request without granting', async () => {
    const { svc } = await service();
    const id = await svc.requestAccess('user:r');
    await svc.denyRequest(id, OWNER);
    expect(svc.effectiveLevel('user:r')).toBeNull();
    expect(svc.pendingRequests()).toHaveLength(0);
  });

  it('a viewer may file an upgrade request', async () => {
    const { svc } = await service();
    await svc.grant('user:v', 'viewer', OWNER);
    await expect(svc.requestAccess('user:v', { level: 'viewer' })).rejects.toThrowError(NameError);
    const id = await svc.requestAccess('user:v', { level: 'editor' });
    await svc.approveRequest(id, OWNER);
    expect(svc.effectiveLevel('user:v')).toBe('editor');
  });

  it('non-managers cannot approve or deny', async () => {
    const { svc } = await service();
    const id = await svc.requestAccess('user:r');
    await expect(svc.approveRequest(id, ED)).rejects.toThrowError(NameError);
    await expect(svc.denyRequest(id, ED)).rejects.toThrowError(NameError);
    expect(svc.pendingRequests()).toHaveLength(1);
  });

  it('a manager approves within their own level only', async () => {
    const { svc } = await service();
    await svc.grant(MGR, 'manager', OWNER);
    const id = await svc.requestAccess('user:r', { level: 'editor' });
    await svc.approveRequest(id, MGR);
    expect(svc.effectiveLevel('user:r')).toBe('editor');
  });

  it('duplicate and invalid requests are rejected', async () => {
    const { svc } = await service();
    await svc.requestAccess('user:r');
    await expect(svc.requestAccess('user:r')).rejects.toThrowError(NameError);
    await expect(svc.requestAccess('', { level: 'viewer' })).rejects.toThrowError(NameError);
    await expect(svc.requestAccess('user:x', { level: 'owner' as never })).rejects.toThrowError(NameError);
    await expect(svc.approveRequest('req-missing', OWNER)).rejects.toThrowError(NameError);
  });

  it('the requester can cancel their own request', async () => {
    const { svc } = await service();
    const id = await svc.requestAccess('user:r');
    await expect(svc.cancelRequest(id, 'user:other')).rejects.toThrowError(NameError);
    await svc.cancelRequest(id, 'user:r');
    expect(svc.pendingRequests()).toHaveLength(0);
  });
});
