/**
 * svc 'gateway' transport tests (stream 1: Workspace-in-desktop).
 *
 * The desktop shell proxies gateway-NATIVE routes (/api/files,
 * /api/settings, /api/account, collab joins) for the renderer, which
 * never holds the JWT. Unlike the service families (which throw on HTTP
 * errors), the gateway family returns a { status, body } envelope so the
 * renderer's GatewayClient can reproduce its fetch semantics exactly —
 * the Workspace surfaces server errors verbatim.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'icecream-svc-gw-'));

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Uint8Array) => Buffer.from(b).toString('utf8'),
  },
}));

const { serviceCall, saveToken, clearToken, loadToken } = await import('../src/services.js');

interface FetchCall {
  url: string;
  method: string;
  auth: string | null;
  body: string | null;
}

function stubFetch(handler: (call: FetchCall) => { status: number; text: string }) {
  const calls: FetchCall[] = [];
  const fetchFn = vi.fn(async (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }) => {
    const call: FetchCall = {
      url,
      method: init?.method ?? 'GET',
      auth: init?.headers?.['authorization'] ?? null,
      body: init?.body ?? null,
    };
    calls.push(call);
    const r = handler(call);
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      text: async () => r.text,
      json: async () => JSON.parse(r.text) as unknown,
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchFn);
  return calls;
}

beforeEach(() => {
  process.env.ICECREAM_GATEWAY_URL = 'http://gw.test:8100';
  clearToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ICECREAM_GATEWAY_URL;
});

describe("serviceCall('gateway', …)", () => {
  it('fails closed when signed out — no request is made', async () => {
    const calls = stubFetch(() => ({ status: 200, text: '{}' }));
    await expect(serviceCall('gateway', '/api/files', 'GET')).rejects.toThrow(/not signed in/i);
    expect(calls).toHaveLength(0);
  });

  it('returns a { status, body } envelope with the JWT attached', async () => {
    saveToken('tok-test');
    const calls = stubFetch(() => ({ status: 200, text: '{"ok":true,"files":[]}' }));
    const res = await serviceCall('gateway', '/api/files', 'GET');
    expect(res).toEqual({ status: 200, body: { ok: true, files: [] } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://gw.test:8100/api/files');
    expect(calls[0].auth).toBe('Bearer tok-test');
  });

  it('does NOT throw on HTTP errors — the renderer needs them verbatim', async () => {
    saveToken('tok-test');
    stubFetch(() => ({ status: 400, text: '{"ok":false,"error":"fileId is required"}' }));
    const res = await serviceCall('gateway', '/api/files', 'DELETE');
    expect(res).toEqual({ status: 400, body: { ok: false, error: 'fileId is required' } });
  });

  it('keeps a non-JSON body as raw text', async () => {
    saveToken('tok-test');
    stubFetch(() => ({ status: 502, text: 'bad gateway' }));
    const res = await serviceCall('gateway', '/api/files', 'GET');
    expect(res).toEqual({ status: 502, body: 'bad gateway' });
  });

  it('a 401 clears the stored token (dead session hygiene)', async () => {
    saveToken('tok-test');
    stubFetch(() => ({ status: 401, text: '{"ok":false}' }));
    const res = await serviceCall('gateway', '/api/files', 'GET');
    expect(res).toEqual({ status: 401, body: { ok: false } });
    expect(loadToken()).toBeNull();
  });

  it('rejects paths outside /api/', async () => {
    saveToken('tok-test');
    const calls = stubFetch(() => ({ status: 200, text: '{}' }));
    await expect(serviceCall('gateway', 'api/files', 'GET')).rejects.toThrow(/\/api\//);
    await expect(serviceCall('gateway', '/admin', 'GET')).rejects.toThrow(/\/api\//);
    expect(calls).toHaveLength(0);
  });

  it('forwards the JSON body on writes', async () => {
    saveToken('tok-test');
    const calls = stubFetch(() => ({ status: 201, text: '{"ok":true,"id":"n1"}' }));
    const res = await serviceCall('gateway', '/api/files', 'POST', { name: 'Budget' });
    expect(res).toEqual({ status: 201, body: { ok: true, id: 'n1' } });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toBe('{"name":"Budget"}');
  });
});

describe('service families are unchanged (regression)', () => {
  it("'meta' still returns the parsed body directly and throws on !ok", async () => {
    saveToken('tok-test');
    stubFetch((call) =>
      call.url.endsWith('/api/meta/ping')
        ? { status: 200, text: '{"ok":true}' }
        : { status: 500, text: 'boom' },
    );
    await expect(serviceCall('meta', '/ping', 'GET')).resolves.toEqual({ ok: true });
    await expect(serviceCall('meta', '/other', 'GET')).rejects.toThrow(/500/);
  });
});

describe("serviceCall 401 session-loss hook (#101/#102)", () => {
  // The hook import lives beside serviceCall in the same module import
  // above; re-import here keeps this block self-contained.
  afterEach(async () => {
    const { setSessionLostHandler } = await import('../src/services.js');
    setSessionLostHandler(null);
  });

  it("gateway 401 clears the token, returns the envelope, AND fires the session-lost hook", async () => {
    const { setSessionLostHandler, loadToken } = await import('../src/services.js');
    const hook = vi.fn();
    setSessionLostHandler(hook);
    saveToken('tok-test');
    stubFetch(() => ({ status: 401, text: '{"error":"expired"}' }));
    const res = await serviceCall('gateway', '/api/files', 'GET');
    expect(res).toEqual({ status: 401, body: { error: 'expired' } });
    expect(loadToken()).toBeNull();
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("service-family 401 clears the token, throws Session expired, AND fires the hook", async () => {
    const { setSessionLostHandler, loadToken } = await import('../src/services.js');
    const hook = vi.fn();
    setSessionLostHandler(hook);
    saveToken('tok-test');
    stubFetch(() => ({ status: 401, text: 'nope' }));
    await expect(serviceCall('meta', '/ping', 'GET')).rejects.toThrow(/Session expired/);
    expect(loadToken()).toBeNull();
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("non-401 responses never fire the hook", async () => {
    const { setSessionLostHandler } = await import('../src/services.js');
    const hook = vi.fn();
    setSessionLostHandler(hook);
    saveToken('tok-test');
    stubFetch(() => ({ status: 200, text: '{"ok":true}' }));
    await serviceCall('gateway', '/api/files', 'GET');
    expect(hook).not.toHaveBeenCalled();
  });

  it("a throwing hook never breaks the caller's error path", async () => {
    const { setSessionLostHandler } = await import('../src/services.js');
    setSessionLostHandler(() => {
      throw new Error('hook blew up');
    });
    saveToken('tok-test');
    stubFetch(() => ({ status: 401, text: 'nope' }));
    await expect(serviceCall('meta', '/ping', 'GET')).rejects.toThrow(/Session expired/);
  });
});
