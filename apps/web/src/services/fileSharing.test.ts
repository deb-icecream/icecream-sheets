/**
 * fileSharing service tests (issue #71): the wire shapes of the
 * gateway share contract and the plain-language error mapping — no
 * raw status code or server string may leak into a message the
 * dialog can show.
 */
import { describe, expect, it, vi } from 'vitest';
import { GatewayAuthError } from './gatewayClient';
import {
  FileShareError,
  displayId,
  fetchFileShareState,
  resolvePrincipalByEmail,
  setFileGrant,
  setLinkShare,
  toFileShareError,
  toPrincipal,
  transferOwnership,
  type ShareGateway,
} from './fileSharing';

function gatewayError(status: number, serverError: string): Error {
  const err = new Error(`gateway ${status}: ${JSON.stringify({ error: serverError })}`) as Error & {
    gatewayBody?: unknown;
  };
  err.gatewayBody = { error: serverError };
  return err;
}

function stub(impl: (path: string, init?: RequestInit, body?: unknown) => Promise<unknown>): ShareGateway {
  return { call: vi.fn(impl) as ShareGateway['call'] };
}

describe('fileSharing wire shapes', () => {
  it('fetch reads the share state for the file', async () => {
    const gw = stub(async () => ({
      ok: true,
      fileId: 'file-1',
      owner: 'user:alice',
      role: 'owner',
      grants: [{ principal: 'user:bob', role: 'viewer' }],
    }));
    const state = await fetchFileShareState('file-1', gw);
    expect(gw.call).toHaveBeenCalledWith('/api/engine/share?fileId=file-1', { method: 'GET' });
    expect(state).toEqual({
      fileId: 'file-1',
      owner: 'user:alice',
      role: 'owner',
      grants: [{ principal: 'user:bob', role: 'viewer' }],
      linkShare: null,
    });
  });

  it('grant, re-role, and revoke all post to the share endpoint', async () => {
    const gw = stub(async () => ({ ok: true }));
    await setFileGrant('file-1', 'user:bob', 'editor', gw);
    await setFileGrant('file-1', 'user:bob', 'viewer', gw);
    await setFileGrant('file-1', 'user:bob', null, gw);
    expect(gw.call).toHaveBeenNthCalledWith(1, '/api/engine/share', { method: 'POST' }, {
      fileId: 'file-1',
      principal: 'user:bob',
      role: 'editor',
    });
    expect(gw.call).toHaveBeenNthCalledWith(2, '/api/engine/share', { method: 'POST' }, {
      fileId: 'file-1',
      principal: 'user:bob',
      role: 'viewer',
    });
    expect(gw.call).toHaveBeenNthCalledWith(3, '/api/engine/share', { method: 'POST' }, {
      fileId: 'file-1',
      principal: 'user:bob',
      role: null,
    });
  });

  it('no gateway client (local build) fails as unavailable, in plain words', async () => {
    // No stub gateway and no VITE_GATEWAY_URL in the test env.
    await expect(fetchFileShareState('file-1')).rejects.toMatchObject({ kind: 'unavailable' });
  });
});

describe('fileSharing error mapping (no raw codes in UI copy)', () => {
  const cases: Array<[unknown, string]> = [
    [new GatewayAuthError('not authenticated (401)'), 'signed out'],
    [gatewayError(400, 'cannot change your own role'), 'can’t change your own access'],
    [gatewayError(400, 'principal must be a string of 1..128 chars'), 'wasn’t accepted'],
    [gatewayError(403, 'only the file owner can share this file'), 'Only the owner of this file'],
    [gatewayError(404, 'file not found'), 'isn’t saved in the workspace yet'],
    [gatewayError(503, 'session registry unavailable'), 'unavailable right now'],
    [new TypeError('Failed to fetch'), 'Can’t reach the server'],
    [new Error('something odd'), 'Something went wrong'],
  ];
  for (const [err, fragment] of cases) {
    it(`maps ${String((err as Error).message).slice(0, 48)}…`, () => {
      const mapped = toFileShareError(err);
      expect(mapped).toBeInstanceOf(FileShareError);
      expect(mapped.message).toContain(fragment);
      expect(mapped.message).not.toMatch(/\b(400|401|403|404|429|500|503)\b/);
      expect(mapped.message).not.toContain('gateway');
    });
  }

  it('a FileShareError passes through untouched', () => {
    const e = new FileShareError('forbidden', 'keep me');
    expect(toFileShareError(e)).toBe(e);
  });
});

describe('fileSharing wire shapes (issue #84)', () => {
  it('fetch passes linkShare through; absent linkShare reads as off', async () => {
    const gw = stub(async () => ({
      ok: true,
      fileId: 'file-1',
      owner: 'user:alice',
      role: 'viewer',
      grants: [],
      linkShare: { role: 'viewer' },
    }));
    const state = await fetchFileShareState('file-1', gw);
    expect(state.linkShare).toEqual({ role: 'viewer' });
  });

  it('by-email resolution posts the owner-scoped lookup path', async () => {
    const gw = stub(async () => ({ ok: true, principal: 'user:bob', email: 'bob@example.com' }));
    const res = await resolvePrincipalByEmail('file-1', 'bob@example.com', gw);
    expect(gw.call).toHaveBeenCalledWith(
      '/api/users/by-email?fileId=file-1&email=bob%40example.com',
      { method: 'GET' },
    );
    expect(res).toEqual({ ok: true, principal: 'user:bob', email: 'bob@example.com' });
  });

  it('unknown email maps to no-such-user in plain words', async () => {
    const gw = stub(async () => {
      throw gatewayError(404, 'no account found for that email');
    });
    await expect(resolvePrincipalByEmail('file-1', 'nobody@example.com', gw)).rejects.toMatchObject({
      kind: 'no-such-user',
    });
    await expect(resolvePrincipalByEmail('file-1', 'nobody@example.com', gw)).rejects.toThrow(
      'signed in with that email yet',
    );
  });

  it('link on/off and transfer post their endpoints with the result intact', async () => {
    const gw = stub(async (path) => {
      if (path === '/api/engine/share/transfer') {
        return { ok: true, owner: 'user:bob', previousOwner: 'user:alice', catalogTransferred: false };
      }
      return { ok: true };
    });
    await setLinkShare('file-1', 'viewer', gw);
    await setLinkShare('file-1', null, gw);
    const result = await transferOwnership('file-1', 'user:bob', gw);
    expect(gw.call).toHaveBeenNthCalledWith(1, '/api/engine/share/link', { method: 'POST' }, {
      fileId: 'file-1',
      role: 'viewer',
    });
    expect(gw.call).toHaveBeenNthCalledWith(2, '/api/engine/share/link', { method: 'POST' }, {
      fileId: 'file-1',
      role: null,
    });
    expect(gw.call).toHaveBeenNthCalledWith(3, '/api/engine/share/transfer', { method: 'POST' }, {
      fileId: 'file-1',
      principal: 'user:bob',
    });
    expect(result).toEqual({ owner: 'user:bob', previousOwner: 'user:alice', catalogTransferred: false });
  });

  it('transfer preconditions map to plain words', async () => {
    const gw = stub(async () => {
      throw gatewayError(400, 'transfer target must already have access to this file');
    });
    await expect(transferOwnership('file-1', 'user:carol', gw)).rejects.toThrow(
      'share it with them first',
    );
  });
});

describe('principal normalization', () => {
  it('bare IDs gain the user: prefix; prefixed IDs pass through', () => {
    expect(toPrincipal('bob')).toBe('user:bob');
    expect(toPrincipal('  bob  ')).toBe('user:bob');
    expect(toPrincipal('user:bob')).toBe('user:bob');
    expect(toPrincipal('')).toBe('');
    expect(toPrincipal('   ')).toBe('');
  });

  it('displayId strips the user: prefix only', () => {
    expect(displayId('user:bob')).toBe('bob');
    expect(displayId('bob')).toBe('bob');
  });
});
