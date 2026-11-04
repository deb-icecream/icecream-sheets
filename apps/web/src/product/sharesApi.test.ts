/**
 * SharesApi tests: the /api/shares* surface over a faked GatewayClient,
 * link building/parsing, and error normalization (server message
 * verbatim via ProductApiError).
 */
import { describe, expect, it } from 'vitest';
import type { AppSharePackage } from '@icecream-sheets/service';
import type { GatewayClient } from '../services/gatewayClient';
import { SharesApi, buildShareLink, shareIdFromSearch, type AppShareSummary } from './sharesApi';
import { ProductApiError } from './productApi';

type CallRecord = { path: string; init?: RequestInit; body?: unknown };
type Handler = (path: string, init?: RequestInit, body?: unknown) => unknown;

class FakeGatewayClient {
  readonly calls: CallRecord[] = [];
  constructor(private readonly handler: Handler) {}
  async call<T>(path: string, init?: RequestInit, body?: unknown): Promise<T> {
    this.calls.push({ path, init, body });
    return this.handler(path, init, body) as T;
  }
}

function makeApi(handler: Handler) {
  const fake = new FakeGatewayClient(handler);
  return { api: new SharesApi(fake as unknown as GatewayClient), fake };
}

const SUMMARY: AppShareSummary = {
  shareId: 'share-abc',
  ownerPrincipal: 'user:alice',
  appName: 'Score viewer',
  sourceSheet: 'Scores',
  rowCount: 3,
  colCount: 2,
  createdAt: 1000,
  revokedAt: null,
};

const PKG = { v: 2, app: { name: 'Score viewer' } } as unknown as AppSharePackage;

describe('SharesApi', () => {
  it('createShare posts the package and returns the summary', async () => {
    const { api, fake } = makeApi(() => ({ ok: true, share: SUMMARY }));
    const out = await api.createShare(PKG);
    expect(out).toEqual(SUMMARY);
    expect(fake.calls[0].path).toBe('/api/shares');
    expect(fake.calls[0].init?.method).toBe('POST');
    expect((fake.calls[0].body as { package: unknown }).package).toBe(PKG);
  });

  it('listMyShares / getShare / revokeShare hit the right routes', async () => {
    const { api, fake } = makeApi((path) => {
      if (path === '/api/shares') return { ok: true, shares: [SUMMARY] };
      if (path === '/api/shares/share-abc') return { ok: true, share: SUMMARY, package: PKG };
      return { ok: true };
    });
    expect(await api.listMyShares()).toEqual([SUMMARY]);
    const fetched = await api.getShare('share-abc');
    expect(fetched.share).toEqual(SUMMARY);
    expect(fetched.pkg).toBe(PKG);
    await api.revokeShare('share-abc');
    expect(fake.calls.map((c) => `${c.init?.method} ${c.path}`)).toEqual([
      'GET /api/shares',
      'GET /api/shares/share-abc',
      'DELETE /api/shares/share-abc',
    ]);
  });

  it('a revoked/missing share surfaces the server 404 verbatim', async () => {
    const { api } = makeApi(() => {
      throw new Error('gateway 404: {"ok":false,"error":"share not found"}');
    });
    await expect(api.getShare('share-gone')).rejects.toBeInstanceOf(ProductApiError);
    await expect(api.getShare('share-gone')).rejects.toMatchObject({
      status: 404,
      message: 'share not found',
    });
  });
});

describe('share links', () => {
  it('builds ?share= links and parses them back', () => {
    const link = buildShareLink('https://sheets.example.test/?file=file-1#frag', 'share-abc');
    expect(link).toContain('share=share-abc');
    expect(link).not.toContain('#frag');
    expect(shareIdFromSearch('?file=file-1&share=share-abc')).toBe('share-abc');
    expect(shareIdFromSearch('?file=file-1')).toBeNull();
    expect(shareIdFromSearch('')).toBeNull();
  });
});
