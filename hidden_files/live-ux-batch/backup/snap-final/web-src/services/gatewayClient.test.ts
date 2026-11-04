/**
 * GatewayClient.engineDownload routing (residual (p) regression):
 * in signed mode the gateway-proxied /api/engine/download forwards
 * the gateway JWT, which the engine refuses (401). Whole-workbook
 * .xlsx already routes direct (metadata provider + signed storage
 * URL — the Phase 2 defect-4 fix); named-range subsets and non-xlsx
 * formats must route direct too (bytes provider), falling back to
 * the proxied fetch only when no direct channel is live.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayAuthError, GatewayClient } from './gatewayClient';

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

function fakeResponse(opts: {
  status?: number;
  json?: unknown;
  blobText?: string;
  contentType?: string;
}): Response {
  const status = opts.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (n: string) => (n.toLowerCase() === 'content-type' ? (opts.contentType ?? null) : null),
    },
    json: async () => opts.json,
    text: async () =>
      opts.blobText ?? (opts.json !== undefined ? JSON.stringify(opts.json) : ''),
    blob: async () => new Blob([opts.blobText ?? ''], { type: opts.contentType ?? '' }),
  } as unknown as Response;
}

function stubFetch(handler: (call: FetchCall) => Response) {
  const calls: FetchCall[] = [];
  const fetchFn = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const call: FetchCall = {
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(init.body) as unknown) : null,
    };
    calls.push(call);
    return handler(call);
  });
  vi.stubGlobal('fetch', fetchFn);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('engineDownload byte classes (named-range / non-xlsx)', () => {
  it('routes a CSV export through the direct bytes provider — no proxied call', async () => {
    const calls = stubFetch(() => {
      throw new Error('fetch must not be called when the bytes provider answers');
    });
    const client = new GatewayClient('http://gw');
    const seen: unknown[] = [];
    client.setDirectDownloadBytesProvider(async (extras) => {
      seen.push(extras);
      return new Blob(['a,b\n10,20\n'], { type: 'text/csv' });
    });
    const blob = await client.engineDownload({ format: 'csv', filename: 'workbook.csv' });
    expect(await blob.text()).toBe('a,b\n10,20\n');
    expect(seen).toEqual([{ format: 'csv', filename: 'workbook.csv' }]);
    expect(calls).toHaveLength(0);
  });

  it('routes a named-range .xlsx export through the bytes provider, never the metadata branch', async () => {
    stubFetch(() => {
      throw new Error('fetch must not be called when the bytes provider answers');
    });
    const client = new GatewayClient('http://gw');
    const metadataProvider = vi.fn(async () => ({
      ok: true,
      entryId: 'dl_should_not_be_used',
      revision: 1,
      bytes: 1,
      mode: 'direct',
      serializeMs: 0,
      totalMs: 0,
    }));
    client.setDirectDownloadMetadataProvider(
      metadataProvider as never,
    );
    const namedRange = {
      name: 'MyRange',
      ref: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
    };
    const seen: unknown[] = [];
    client.setDirectDownloadBytesProvider(async (extras) => {
      seen.push(extras);
      return new Blob(['PK subset'], { type: 'application/octet-stream' });
    });
    const blob = await client.engineDownload({
      format: 'xlsx',
      filename: 'MyRange.xlsx',
      scope: 'namedRange',
      namedRange,
    });
    expect(await blob.text()).toBe('PK subset');
    expect(seen).toEqual([
      { format: 'xlsx', filename: 'MyRange.xlsx', scope: 'namedRange', namedRange },
    ]);
    expect(metadataProvider).not.toHaveBeenCalled();
  });

  it('falls back to the proxied fetch when the bytes provider returns null (no live session)', async () => {
    const calls = stubFetch((call) => {
      if (call.url === 'http://gw/api/engine/download') {
        return fakeResponse({ blobText: 'proxied-ods', contentType: 'application/vnd.oasis.opendocument.spreadsheet' });
      }
      throw new Error(`unexpected fetch: ${call.url}`);
    });
    const client = new GatewayClient('http://gw');
    client.setDirectDownloadBytesProvider(async () => null);
    const blob = await client.engineDownload({ format: 'ods', filename: 'workbook.ods' });
    expect(await blob.text()).toBe('proxied-ods');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ format: 'ods', filename: 'workbook.ods' });
  });

  it('uses the proxied fetch when no bytes provider is registered (legacy sessions)', async () => {
    const calls = stubFetch((call) => {
      if (call.url === 'http://gw/api/engine/download') {
        return fakeResponse({ blobText: 'legacy-tsv', contentType: 'text/tab-separated-values' });
      }
      throw new Error(`unexpected fetch: ${call.url}`);
    });
    const client = new GatewayClient('http://gw');
    const blob = await client.engineDownload({ format: 'tsv', filename: 'workbook.tsv' });
    expect(await blob.text()).toBe('legacy-tsv');
    expect(calls).toHaveLength(1);
  });
});

describe('engineDownload whole-workbook xlsx (Phase 2 defect-4 fix — no regression)', () => {
  it('still goes metadata → gateway-signed URL → direct storage fetch', async () => {
    const calls = stubFetch((call) => {
      if (call.url === 'http://gw/api/storage/sign') {
        return fakeResponse({
          json: { ok: true, url: 'http://engine-1/storage/dl_9?st=tok', expiresAt: 1 },
          contentType: 'application/json',
        });
      }
      if (call.url === 'http://engine-1/storage/dl_9?st=tok') {
        return fakeResponse({ blobText: 'PK whole workbook' });
      }
      throw new Error(`unexpected fetch: ${call.url}`);
    });
    const client = new GatewayClient('http://gw');
    client.setDirectDownloadMetadataProvider((async () => ({
      ok: true,
      entryId: 'dl_9',
      revision: 3,
      bytes: 15,
      mode: 'direct',
      serializeMs: 1,
      totalMs: 2,
    })) as never);
    const bytesProvider = vi.fn(async () => new Blob(['wrong channel']));
    client.setDirectDownloadBytesProvider(bytesProvider);
    const blob = await client.engineDownload({ format: 'xlsx', filename: 'workbook.xlsx' });
    expect(await blob.text()).toBe('PK whole workbook');
    expect(bytesProvider).not.toHaveBeenCalled();
    expect(calls.map((c) => c.url)).toEqual([
      'http://gw/api/storage/sign',
      'http://engine-1/storage/dl_9?st=tok',
    ]);
  });
});

describe('engineLibrarySave routing (direct lane for Phase 2 file sessions)', () => {
  const ENTRY = {
    id: 'wb_9',
    name: 'Budget 2026',
    owner: 'user:alice',
    createdAt: 11,
    modifiedAt: 42,
    sizeBytes: 3068,
    backend: 'gateway',
  } as const;

  it('routes through the direct library-save provider — no proxied call', async () => {
    const calls = stubFetch(() => {
      throw new Error('fetch must not be called when the library-save provider answers');
    });
    const client = new GatewayClient('http://gw');
    const seen: unknown[] = [];
    client.setDirectLibrarySaveProvider(async (payload) => {
      seen.push(payload);
      return { ok: true, entry: { ...ENTRY } };
    });
    const res = await client.engineLibrarySave({
      id: 'wb_9',
      name: 'Budget 2026',
      extraMetadata: { 'icecream.theme': { name: 'Office' } },
    });
    expect(res).toEqual({ ok: true, entry: ENTRY });
    expect(seen).toEqual([
      { format: 'xlsx', id: 'wb_9', name: 'Budget 2026', extraMetadata: { 'icecream.theme': { name: 'Office' } } },
    ]);
    expect(calls).toHaveLength(0);
  });

  it('falls back to the proxied call when the provider returns null (no live session)', async () => {
    const calls = stubFetch((call) => {
      if (call.url === 'http://gw/api/engine/library-save') {
        return fakeResponse({ json: { ok: true, entry: ENTRY } });
      }
      throw new Error(`unexpected fetch: ${call.url}`);
    });
    const client = new GatewayClient('http://gw');
    client.setDirectLibrarySaveProvider(async () => null);
    const res = await client.engineLibrarySave({ id: 'wb_9', name: 'Budget 2026' });
    expect(res).toEqual({ ok: true, entry: ENTRY });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ format: 'xlsx', id: 'wb_9', name: 'Budget 2026' });
  });

  it('uses the proxied call when no provider is registered (legacy sessions)', async () => {
    const calls = stubFetch((call) => {
      if (call.url === 'http://gw/api/engine/library-save') {
        return fakeResponse({ json: { ok: true, entry: { ...ENTRY, id: 'wb_new' } } });
      }
      throw new Error(`unexpected fetch: ${call.url}`);
    });
    const client = new GatewayClient('http://gw');
    const res = await client.engineLibrarySave({ name: 'Budget 2026' });
    expect(res.entry.id).toBe('wb_new');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ format: 'xlsx', name: 'Budget 2026' });
  });

  it('a cleared provider (session teardown) restores the proxied call', async () => {
    const calls = stubFetch((call) => {
      if (call.url === 'http://gw/api/engine/library-save') {
        return fakeResponse({ json: { ok: true, entry: ENTRY } });
      }
      throw new Error(`unexpected fetch: ${call.url}`);
    });
    const client = new GatewayClient('http://gw');
    client.setDirectLibrarySaveProvider(async () => ({ ok: true, entry: { ...ENTRY } }));
    client.setDirectLibrarySaveProvider(null);
    const res = await client.engineLibrarySave({ name: 'Budget 2026' });
    expect(res).toEqual({ ok: true, entry: ENTRY });
    expect(calls).toHaveLength(1);
  });
});

describe('engineLibraryBytes routing (direct lane for Phase 2 file sessions)', () => {
  const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  it('routes through the direct library-bytes provider — no proxied fetch', async () => {
    const calls = stubFetch(() => {
      throw new Error('fetch must not be called when the library-bytes provider answers');
    });
    const client = new GatewayClient('http://gw');
    const seen: string[] = [];
    client.setDirectLibraryBytesProvider(async (id) => {
      seen.push(id);
      return new Blob(['PK direct bytes'], { type: XLSX_TYPE });
    });
    const blob = await client.engineLibraryBytes('wb_9');
    expect(await blob.text()).toBe('PK direct bytes');
    expect(seen).toEqual(['wb_9']);
    expect(calls).toHaveLength(0);
  });

  it('falls back to the proxied GET when the provider returns null (no live session)', async () => {
    const calls = stubFetch((call) => {
      if (call.url === 'http://gw/api/engine/library/wb_9') {
        return fakeResponse({ blobText: 'PK proxied bytes', contentType: XLSX_TYPE });
      }
      throw new Error(`unexpected fetch: ${call.url}`);
    });
    const client = new GatewayClient('http://gw');
    client.setDirectLibraryBytesProvider(async () => null);
    const blob = await client.engineLibraryBytes('wb_9');
    expect(await blob.text()).toBe('PK proxied bytes');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
  });

  it('uses the proxied GET when no provider is registered (legacy sessions)', async () => {
    const calls = stubFetch((call) => {
      if (call.url === 'http://gw/api/engine/library/wb_9') {
        return fakeResponse({ blobText: 'PK proxied bytes', contentType: XLSX_TYPE });
      }
      throw new Error(`unexpected fetch: ${call.url}`);
    });
    const client = new GatewayClient('http://gw');
    const blob = await client.engineLibraryBytes('wb_9');
    expect(await blob.text()).toBe('PK proxied bytes');
    expect(calls).toHaveLength(1);
  });

  it('a cleared provider (session teardown) restores the proxied GET', async () => {
    const calls = stubFetch((call) => {
      if (call.url === 'http://gw/api/engine/library/wb_9') {
        return fakeResponse({ blobText: 'PK proxied bytes', contentType: XLSX_TYPE });
      }
      throw new Error(`unexpected fetch: ${call.url}`);
    });
    const client = new GatewayClient('http://gw');
    client.setDirectLibraryBytesProvider(async () => new Blob(['PK direct bytes']));
    client.setDirectLibraryBytesProvider(null);
    const blob = await client.engineLibraryBytes('wb_9');
    expect(await blob.text()).toBe('PK proxied bytes');
    expect(calls).toHaveLength(1);
  });
});

describe('engineBindLibrary routing (direct lane for Phase 2 file sessions)', () => {
  it('routes through the direct bind provider — no proxied call', async () => {
    const calls = stubFetch(() => {
      throw new Error('fetch must not be called when the bind provider answers');
    });
    const client = new GatewayClient('http://gw');
    const seen: Array<{ id: string; name?: string }> = [];
    client.setDirectBindLibraryProvider(async (id, name) => {
      seen.push({ id, name });
      return { ok: true, boundLibraryId: id };
    });
    const res = await client.engineBindLibrary('wb_9', 'Budget 2026');
    expect(res).toEqual({ ok: true, boundLibraryId: 'wb_9' });
    expect(seen).toEqual([{ id: 'wb_9', name: 'Budget 2026' }]);
    expect(calls).toHaveLength(0);
  });

  it('falls back to the proxied call when the provider returns null (no live session)', async () => {
    const calls = stubFetch((call) => {
      if (call.url === 'http://gw/api/engine/session-bind-library') {
        return fakeResponse({ json: { ok: true, boundLibraryId: 'wb_9' } });
      }
      throw new Error(`unexpected fetch: ${call.url}`);
    });
    const client = new GatewayClient('http://gw');
    client.setDirectBindLibraryProvider(async () => null);
    const res = await client.engineBindLibrary('wb_9', 'Budget 2026');
    expect(res).toEqual({ ok: true, boundLibraryId: 'wb_9' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ id: 'wb_9', name: 'Budget 2026' });
  });

  it('uses the proxied call when no provider is registered (legacy sessions)', async () => {
    const calls = stubFetch((call) => {
      if (call.url === 'http://gw/api/engine/session-bind-library') {
        return fakeResponse({ json: { ok: true, boundLibraryId: 'wb_9' } });
      }
      throw new Error(`unexpected fetch: ${call.url}`);
    });
    const client = new GatewayClient('http://gw');
    const res = await client.engineBindLibrary('wb_9');
    expect(res).toEqual({ ok: true, boundLibraryId: 'wb_9' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ id: 'wb_9' });
  });
});

describe('auth coherence: 401 → one silent re-exchange + retry (withReauth)', () => {
  interface HCall {
    url: string;
    auth: string | null;
    method: string;
  }

  function stubFetchH(handler: (call: HCall) => Response) {
    const calls: HCall[] = [];
    const fetchFn = vi.fn(
      async (
        url: string,
        init?: { method?: string; headers?: Record<string, string>; body?: string },
      ) => {
        const call: HCall = {
          url,
          auth: init?.headers?.['authorization'] ?? null,
          method: init?.method ?? 'GET',
        };
        calls.push(call);
        return handler(call);
      },
    );
    vi.stubGlobal('fetch', fetchFn);
    return calls;
  }

  it('a 401 re-exchanges once and retries with the fresh token', async () => {
    let firebaseCalls = 0;
    const calls = stubFetchH((call) => {
      if (call.url === 'http://gw/auth/firebase') {
        firebaseCalls++;
        return fakeResponse({ json: { token: `tok-${firebaseCalls}` } });
      }
      if (call.url === 'http://gw/api/files') {
        return call.auth === 'Bearer tok-2'
          ? fakeResponse({ json: { ok: true, files: [] } })
          : fakeResponse({ status: 401, json: { ok: false } });
      }
      throw new Error(`unexpected fetch: ${call.url}`);
    });
    const client = new GatewayClient('http://gw');
    await client.loginWithFirebaseIdToken('id-token'); // stores tok-1
    // The provider performs the same silent re-exchange the
    // FirebaseAuthService does in production.
    const provider = vi.fn(async () => {
      await client.loginWithFirebaseIdToken('id-token');
      return true;
    });
    client.setReauthProvider(provider);

    const res = await client.call<{ ok: boolean }>('/api/files', { method: 'GET' });

    expect(res).toEqual({ ok: true, files: [] });
    expect(provider).toHaveBeenCalledTimes(1);
    const apiCalls = calls.filter((c) => c.url === 'http://gw/api/files');
    expect(apiCalls.map((c) => c.auth)).toEqual(['Bearer tok-1', 'Bearer tok-2']);
  });

  it('provider declines (no live session) → the 401 surfaces, no retry', async () => {
    const calls = stubFetchH((call) => {
      if (call.url === 'http://gw/api/files') return fakeResponse({ status: 401, json: { ok: false } });
      throw new Error(`unexpected fetch: ${call.url}`);
    });
    const client = new GatewayClient('http://gw');
    const provider = vi.fn(async () => false);
    client.setReauthProvider(provider);
    await expect(client.call('/api/files', { method: 'GET' })).rejects.toBeInstanceOf(
      GatewayAuthError,
    );
    expect(provider).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it('a second 401 after the retry is final (exactly one retry)', async () => {
    const calls = stubFetchH((call) => {
      if (call.url === 'http://gw/api/files') return fakeResponse({ status: 401, json: { ok: false } });
      throw new Error(`unexpected fetch: ${call.url}`);
    });
    const client = new GatewayClient('http://gw');
    const provider = vi.fn(async () => true);
    client.setReauthProvider(provider);
    await expect(client.call('/api/files', { method: 'GET' })).rejects.toBeInstanceOf(
      GatewayAuthError,
    );
    expect(provider).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
  });

  it('no provider registered → the 401 throws immediately (legacy behavior)', async () => {
    const calls = stubFetchH((call) => {
      if (call.url === 'http://gw/api/files') return fakeResponse({ status: 401, json: { ok: false } });
      throw new Error(`unexpected fetch: ${call.url}`);
    });
    const client = new GatewayClient('http://gw');
    await expect(client.call('/api/files', { method: 'GET' })).rejects.toBeInstanceOf(
      GatewayAuthError,
    );
    expect(calls).toHaveLength(1);
  });

  it('error bodies ride on the thrown error as gatewayBody, past the 200-char message cap', async () => {
    const body = {
      ok: false,
      error: 'no settings saved yet',
      code: 'SETTINGS_NOT_FOUND',
      user: { email: 'ada@example.com', googleName: 'Ada Lovelace' },
      pad: 'x'.repeat(300),
    };
    stubFetchH(() => fakeResponse({ status: 404, json: body }));
    const client = new GatewayClient('http://gw');
    const err = (await client
      .call('/api/settings', { method: 'GET' })
      .catch((e: unknown) => e)) as Error & {
      gatewayBody?: { user?: { email?: string; googleName?: string } };
    };
    expect(err).toBeInstanceOf(Error);
    expect(err.message.startsWith('gateway 404: ')).toBe(true);
    expect(err.gatewayBody?.user?.email).toBe('ada@example.com');
    expect(err.gatewayBody?.user?.googleName).toBe('Ada Lovelace');
  });
});

describe('principal canonical form (D8)', () => {
  const jwt = (sub: string) => {
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, attrs: {}, iat: 1, exp: 9999999999 })}.sig`;
  };

  it('returns user:<sub> for a bare-sub token (matches server principalFromToken)', async () => {
    stubFetch(() => fakeResponse({ json: { token: jwt('2G7rqK3GIPQwAdffZfnp8cv3Uy2') } }));
    const client = new GatewayClient('http://gw');
    await client.login('whoever');
    expect(client.principal).toBe('user:2G7rqK3GIPQwAdffZfnp8cv3Uy2');
  });

  it('does not double-prefix an already-canonical sub', async () => {
    stubFetch(() => fakeResponse({ json: { token: jwt('user:alice') } }));
    const client = new GatewayClient('http://gw');
    await client.login('alice');
    expect(client.principal).toBe('user:alice');
  });
});
