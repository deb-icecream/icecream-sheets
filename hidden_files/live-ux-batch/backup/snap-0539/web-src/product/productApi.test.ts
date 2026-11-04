// @vitest-environment jsdom
/**
 * ProductApi tests (CONTRACT.md §Web). The GatewayClient is faked at
 * its single funnel — `call()` — with stubs that reproduce the real
 * client's behavior, including its flattening of gateway error JSON
 * into `Error("gateway <status>: <body>")`. The staging PUT in
 * uploadFile is the only raw fetch, and is stubbed globally.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductApi, ProductApiError, type UserFileRecord } from './productApi';
import type { GatewayClient } from '../services/gatewayClient';

interface CallRecord {
  path: string;
  init?: RequestInit;
  body?: unknown;
}

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
  return { api: new ProductApi(fake as unknown as GatewayClient), fake };
}

/** How the real GatewayClient.call surfaces a gateway error response. */
function gatewayError(status: number, body: unknown): Error {
  return new Error(`gateway ${status}: ${JSON.stringify(body)}`);
}

function makeRecord(overrides: Partial<UserFileRecord> = {}): UserFileRecord {
  return {
    fileId: 'file-1',
    ownerPrincipal: 'user:u1',
    name: 'Book.xlsx',
    origin: 'upload',
    sourceFormat: 'xlsx',
    sizeBytes: 1234,
    storageRef: { bucket: 'icecream-uploads', object: 'uploads/ab/file-1.xlsx' },
    libraryEntryId: null,
    hasStoredState: false,
    createdAt: 1000,
    updatedAt: 2000,
    lastOpenedAt: 3000,
    ...overrides,
  };
}

const LIST_RESPONSE = {
  ok: true,
  tier: 'default',
  limits: { uploadMaxBytes: 1_285_214, fileLimit: 10 },
  count: 1,
  files: [makeRecord()],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ProductApi reads', () => {
  it('listFiles unwraps the GET /api/files envelope', async () => {
    const { api, fake } = makeApi(() => LIST_RESPONSE);
    const result = await api.listFiles();
    expect(result.tier).toBe('default');
    expect(result.limits).toEqual({ uploadMaxBytes: 1_285_214, fileLimit: 10 });
    expect(result.count).toBe(1);
    expect(result.files).toEqual([makeRecord()]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.path).toBe('/api/files');
    expect(fake.calls[0]!.init?.method).toBe('GET');
  });

  it('a record carrying sourceFormat csv round-trips through the client types', async () => {
    const csvRecord = makeRecord({
      fileId: 'file-csv',
      name: 'sales.csv',
      sourceFormat: 'csv',
      storageRef: { bucket: 'icecream-uploads', object: 'uploads/ab/file-csv.csv' },
    });
    const { api } = makeApi(() => ({ ...LIST_RESPONSE, count: 1, files: [csvRecord] }));
    const result = await api.listFiles();
    expect(result.files).toEqual([csvRecord]);
    expect(result.files[0]!.sourceFormat).toBe('csv');
    expect(result.files[0]!.name).toBe('sales.csv');
  });

  it('me returns tier, limits, and count', async () => {
    const { api } = makeApi(() => LIST_RESPONSE);
    await expect(api.me()).resolves.toEqual({
      tier: 'default',
      limits: { uploadMaxBytes: 1_285_214, fileLimit: 10 },
      count: 1,
    });
  });
});

describe('ProductApi writes', () => {
  it('createFile POSTs the name and returns the record', async () => {
    const created = makeRecord({ fileId: 'file-2', name: 'Plan', origin: 'created' });
    const { api, fake } = makeApi(() => ({ ok: true, file: created }));
    await expect(api.createFile('Plan')).resolves.toEqual(created);
    expect(fake.calls[0]!.path).toBe('/api/files');
    expect(fake.calls[0]!.init?.method).toBe('POST');
    expect(fake.calls[0]!.body).toEqual({ name: 'Plan' });
  });

  it('createFile with origin shared sends the origin (share-accept copies)', async () => {
    const created = makeRecord({ fileId: 'file-3', name: 'Shared app data', origin: 'shared' });
    const { api, fake } = makeApi(() => ({ ok: true, file: created }));
    await expect(api.createFile('Shared app data', 'shared')).resolves.toEqual(created);
    expect(fake.calls[0]!.path).toBe('/api/files');
    expect(fake.calls[0]!.body).toEqual({ name: 'Shared app data', origin: 'shared' });
  });

  it('getFile GETs one record by id', async () => {
    const record = makeRecord({ fileId: 'file-9', name: 'Budget' });
    const { api, fake } = makeApi(() => ({ ok: true, file: record }));
    await expect(api.getFile('file-9')).resolves.toEqual(record);
    expect(fake.calls[0]!.path).toBe('/api/files/file-9');
    expect(fake.calls[0]!.init?.method).toBe('GET');
  });

  it('renameFile PATCHes the name', async () => {
    const renamed = makeRecord({ name: 'New name' });
    const { api, fake } = makeApi(() => ({ ok: true, file: renamed }));
    await expect(api.renameFile('file-1', 'New name')).resolves.toEqual(renamed);
    expect(fake.calls[0]!.path).toBe('/api/files/file-1');
    expect(fake.calls[0]!.init?.method).toBe('PATCH');
    expect(fake.calls[0]!.body).toEqual({ name: 'New name' });
  });

  it('markOpened PATCHes an arbitrary patch', async () => {
    const { api, fake } = makeApi(() => ({ ok: true, file: makeRecord() }));
    await api.markOpened('file-1', { hasStoredState: true });
    expect(fake.calls[0]!.path).toBe('/api/files/file-1');
    expect(fake.calls[0]!.body).toEqual({ hasStoredState: true });
  });

  it('deleteFile issues DELETE', async () => {
    const { api, fake } = makeApi(() => ({ ok: true }));
    await api.deleteFile('file-1');
    expect(fake.calls[0]!.path).toBe('/api/files/file-1');
    expect(fake.calls[0]!.init?.method).toBe('DELETE');
  });

  it('downloadGrant returns the URL from the grant', async () => {
    const { api, fake } = makeApi(() => ({ ok: true, url: 'http://127.0.0.1:8100/dl?ut=t' }));
    await expect(api.downloadGrant('file-1')).resolves.toBe('http://127.0.0.1:8100/dl?ut=t');
    expect(fake.calls[0]!.path).toBe('/api/files/file-1/download-grant');
    expect(fake.calls[0]!.init?.method).toBe('POST');
  });
});

describe('ProductApi error mapping', () => {
  it('surfaces the server error message VERBATIM with status and code (413 upload too large)', async () => {
    const serverMessage =
      'Upload too large: this file is 2,000,000 bytes and the Default upload limit is 1,285,214 bytes. Pro accounts have no upload limit.';
    const { api } = makeApi(() => {
      throw gatewayError(413, {
        ok: false,
        error: serverMessage,
        code: 'UPLOAD_TOO_LARGE',
        limit: 1_285_214,
        size: 2_000_000,
        tier: 'default',
      });
    });
    const err = await api.uploadGrant('big.xlsx', 2_000_000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProductApiError);
    const perr = err as ProductApiError;
    expect(perr.status).toBe(413);
    expect(perr.code).toBe('UPLOAD_TOO_LARGE');
    expect(perr.message).toBe(serverMessage);
  });

  it('surfaces FILE_LIMIT_REACHED verbatim on create (409)', async () => {
    const serverMessage =
      'File limit reached: Default accounts hold at most 10 files. Upgrade to Pro for unlimited files.';
    const { api } = makeApi(() => {
      throw gatewayError(409, {
        ok: false,
        error: serverMessage,
        code: 'FILE_LIMIT_REACHED',
        limit: 10,
        count: 10,
        tier: 'default',
      });
    });
    const err = await api.createFile('One too many').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProductApiError);
    expect((err as ProductApiError).status).toBe(409);
    expect((err as ProductApiError).code).toBe('FILE_LIMIT_REACHED');
    expect((err as ProductApiError).message).toBe(serverMessage);
  });
});

describe('ProductApi.uploadFile', () => {
  const GRANT = {
    ok: true,
    fileId: 'file-9',
    object: 'uploads/ab/file-9.xlsx',
    upload: {
      url: 'http://127.0.0.1:8100/uploads/stage/uploads%2Fab%2Ffile-9.xlsx?ut=token-1',
      expiresAt: 1_800_000_000_000,
      method: 'PUT' as const,
    },
  };

  function uploadHandler(path: string) {
    if (path === '/api/files/upload-grant') return GRANT;
    if (path === '/api/files/file-9/complete-upload') {
      return { ok: true, file: makeRecord({ fileId: 'file-9', name: 'book.xlsx' }) };
    }
    throw new Error(`unexpected path ${path}`);
  }

  it('grant → PUT bytes to the signed URL with NO gateway auth headers → complete', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchFn);
    const { api, fake } = makeApi(uploadHandler);
    const file = new File(['hello'], 'book.xlsx');

    const record = await api.uploadFile(file);

    expect(record.fileId).toBe('file-9');
    // The gateway funnel was used for grant + complete only.
    expect(fake.calls.map((c) => c.path)).toEqual([
      '/api/files/upload-grant',
      '/api/files/file-9/complete-upload',
    ]);
    expect(fake.calls[0]!.body).toEqual({ name: 'book.xlsx', size: 5 });
    expect(fake.calls[1]!.body).toEqual({ name: 'book.xlsx' });
    // The raw PUT went to the grant URL, with the file as the body and
    // no Authorization header (the signed URL is the grant).
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      { method: string; body: unknown; headers?: Record<string, string> },
    ];
    expect(url).toBe(GRANT.upload.url);
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(file);
    expect(init.headers?.['authorization']).toBeUndefined();
  });

  it('uploadFile with a File named data.csv runs the same grant → PUT → complete flow (grant requested with the csv name)', async () => {
    const csvRecord = makeRecord({
      fileId: 'file-9',
      name: 'data.csv',
      sourceFormat: 'csv',
    });
    const csvHandler = (path: string) => {
      if (path === '/api/files/upload-grant') return GRANT;
      if (path === '/api/files/file-9/complete-upload') return { ok: true, file: csvRecord };
      throw new Error(`unexpected path ${path}`);
    };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchFn);
    const { api, fake } = makeApi(csvHandler);
    const file = new File(['a,b\n1,2'], 'data.csv', { type: 'text/csv' });

    const record = await api.uploadFile(file);

    expect(record).toEqual(csvRecord);
    expect(record.sourceFormat).toBe('csv');
    expect(fake.calls.map((c) => c.path)).toEqual([
      '/api/files/upload-grant',
      '/api/files/file-9/complete-upload',
    ]);
    // The grant was requested with the csv name and size…
    expect(fake.calls[0]!.body).toEqual({ name: 'data.csv', size: file.size });
    // …and complete-upload carries the same csv name.
    expect(fake.calls[1]!.body).toEqual({ name: 'data.csv' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      { method: string; body: unknown; headers?: Record<string, string> },
    ];
    expect(url).toBe(GRANT.upload.url);
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(file);
    expect(init.headers?.['authorization']).toBeUndefined();
  });

  it('a failed staging PUT surfaces the staging error verbatim', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 413,
      text: async () =>
        JSON.stringify({ ok: false, error: 'staging: object exceeds grant', code: 'UPLOAD_TOO_LARGE' }),
    }));
    vi.stubGlobal('fetch', fetchFn);
    const { api } = makeApi(uploadHandler);
    const err = await api.uploadFile(new File(['hello'], 'book.xlsx')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProductApiError);
    expect((err as ProductApiError).status).toBe(413);
    expect((err as ProductApiError).code).toBe('UPLOAD_TOO_LARGE');
    expect((err as ProductApiError).message).toBe('staging: object exceeds grant');
  });
});

// ---------------------------------------------------------------------------
// Workspace settings (workspace-settings brief)
// ---------------------------------------------------------------------------

describe('ProductApi settings', () => {
  const SETTINGS_RESPONSE = {
    ok: true,
    settings: {
      user: { displayName: 'Ada L.', email: 'ada@example.com', googleName: 'Ada Lovelace' },
      office: { theme: 'dark' },
      updatedAt: 4242,
    },
  };

  it('getSettings maps the envelope to the view', async () => {
    const { api, fake } = makeApi(() => SETTINGS_RESPONSE);
    const view = await api.getSettings();
    expect(view).toEqual({
      hasRecord: true,
      displayName: 'Ada L.',
      email: 'ada@example.com',
      googleName: 'Ada Lovelace',
      theme: 'dark',
    });
    expect(fake.calls[0]!.path).toBe('/api/settings');
    expect(fake.calls[0]!.init?.method).toBe('GET');
  });

  it('getSettings maps 404 (nothing saved) to the default view, not an error', async () => {
    const { api } = makeApi(() => {
      throw gatewayError(404, { ok: false, error: 'no settings saved yet', code: 'SETTINGS_NOT_FOUND' });
    });
    const view = await api.getSettings();
    expect(view).toEqual({
      hasRecord: false,
      displayName: null,
      email: null,
      googleName: null,
      theme: 'system',
    });
  });

  it('getSettings fills the default view with the caller identity echoed in the 404 body (D4)', async () => {
    const { api } = makeApi(() => {
      throw gatewayError(404, {
        ok: false,
        error: 'no settings saved yet',
        code: 'SETTINGS_NOT_FOUND',
        user: { email: 'ada@example.com', googleName: 'Ada Lovelace' },
      });
    });
    const view = await api.getSettings();
    expect(view).toEqual({
      hasRecord: false,
      displayName: null,
      email: 'ada@example.com',
      googleName: 'Ada Lovelace',
      theme: 'system',
    });
  });

  it('getSettings propagates real failures', async () => {
    const { api } = makeApi(() => {
      throw gatewayError(503, { ok: false, error: 'user settings unavailable' });
    });
    await expect(api.getSettings()).rejects.toBeInstanceOf(ProductApiError);
  });

  it('updateSettings sends only the patched scopes and never an email', async () => {
    const { api, fake } = makeApi(() => SETTINGS_RESPONSE);
    await api.updateSettings({ theme: 'dark' });
    expect(fake.calls[0]!.init?.method).toBe('PUT');
    expect(fake.calls[0]!.body).toEqual({ office: { theme: 'dark' } });
    await api.updateSettings({ displayName: 'Ada L.' });
    expect(fake.calls[1]!.body).toEqual({ user: { displayName: 'Ada L.' } });
    await api.updateSettings({ displayName: null, theme: 'system' });
    expect(fake.calls[2]!.body).toEqual({
      user: { displayName: null },
      office: { theme: 'system' },
    });
    for (const c of fake.calls) {
      expect(JSON.stringify(c.body)).not.toContain('email');
    }
  });

  it('deleteAccount issues DELETE /api/account and returns the counts', async () => {
    const { api, fake } = makeApi(() => ({
      ok: true,
      deleted: { files: 2, storedObjects: 1, shares: 0, settings: true, tierRecord: true },
    }));
    const res = await api.deleteAccount();
    expect(res.deleted['files']).toBe(2);
    expect(res.deleted['settings']).toBe(true);
    expect(fake.calls[0]!.path).toBe('/api/account');
    expect(fake.calls[0]!.init?.method).toBe('DELETE');
  });
});
