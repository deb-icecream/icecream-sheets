/**
 * SignedEngineTransport tests: the production signed-access pattern —
 * token issuance through the gateway, DIRECT engine calls with the
 * token, one re-issue + retry on 401, session introduction at load,
 * rehydrate mismatch surfacing, and the beacon release form.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayClient, type EngineAccessGrant } from './gatewayClient';
import { SignedEngineTransport } from './signedEngineTransport';

const GRANT: EngineAccessGrant = {
  ok: true,
  accessToken: 'tok-1',
  engineUrl: 'http://127.0.0.1:8201',
  sessionId: 'sess_1',
  tier: 'standard',
  expiresAt: Date.now() + 600_000,
  expiresInSeconds: 600,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeTransport(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  const client = new GatewayClient('http://127.0.0.1:8200');
  const grants: EngineAccessGrant[] = [];
  vi.spyOn(client, 'engineAccess').mockImplementation(async () => {
    const g = { ...GRANT, accessToken: `tok-${grants.length + 1}` };
    grants.push(g);
    return g;
  });
  const fetchSpy = vi.fn(fetchImpl);
  vi.stubGlobal('fetch', fetchSpy);
  return { transport: new SignedEngineTransport(client), fetchSpy, grants };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SignedEngineTransport', () => {
  it('issues once, then calls the DIRECT engine URL with the bearer token', async () => {
    const { transport, fetchSpy, grants } = makeTransport(async () =>
      jsonResponse(200, { sheets: ['Sheet1'] }),
    );
    expect(await transport.sheetNames()).toEqual(['Sheet1']);
    expect(await transport.sheetNames()).toEqual(['Sheet1']);
    expect(grants).toHaveLength(1); // cached grant reused
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8201/sheets'); // direct — NOT via the gateway :8200
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
  });

  it('load introduces the grant session: body carries sessionId === token scope', async () => {
    let loadBody: Record<string, unknown> | null = null;
    const { transport } = makeTransport(async (_url, init) => {
      loadBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(200, {
        ok: true,
        sheets: ['Sheet1'],
        file: { sheets: [], metadata: {} },
        columnCounts: {},
        sessionId: 'sess_1',
      });
    });
    const result = await transport.loadXlsx('AAAA');
    expect(loadBody).toMatchObject({ format: 'xlsx', sessionId: 'sess_1' });
    expect(result.sessionId).toBe('sess_1');
    expect(transport.currentSessionId).toBe('sess_1');
  });

  it('on 401 it re-issues via the gateway ONCE and retries with the fresh token', async () => {
    let attempt = 0;
    const seenAuth: Array<string | undefined> = [];
    const { transport, grants } = makeTransport(async (_url, init) => {
      attempt++;
      seenAuth.push((init?.headers as Record<string, string>)?.authorization);
      return attempt === 1
        ? jsonResponse(401, { ok: false, error: 'expired' })
        : jsonResponse(200, { sheets: [] });
    });
    expect(await transport.sheetNames()).toEqual([]);
    expect(attempt).toBe(2);
    expect(grants).toHaveLength(2);
    expect(seenAuth).toEqual(['Bearer tok-1', 'Bearer tok-2']);
  });

  it('a second 401 is surfaced, never looped', async () => {
    const { transport } = makeTransport(async () => jsonResponse(401, { ok: false }));
    await expect(transport.sheetNames()).rejects.toThrowError(/401/);
  });

  it('rehydrate returns the mismatch shape instead of throwing', async () => {
    const { transport } = makeTransport(async () =>
      jsonResponse(409, {
        ok: false,
        sessionId: 'sess_1',
        revision: 0,
        checksum: null,
        checksumVerified: false,
        replayedOps: 0,
        error: 'rehydrate checksum mismatch',
      }),
    );
    const out = await transport.sessionRehydrate('sess_1');
    expect(out).toMatchObject({ ok: false, checksumVerified: false });
  });

  it('concurrent first calls share ONE grant mint (Worker F, F3)', async () => {
    const { transport, grants } = makeTransport(async () =>
      jsonResponse(200, { sheets: ['Sheet1'] }),
    );
    // Four reads racing a cold grant cache (first paint / post-bind):
    // pre-fix each minted its own grant and all but one were discarded.
    const results = await Promise.all([
      transport.sheetNames(),
      transport.sheetNames(),
      transport.sheetNames(),
      transport.sheetNames(),
    ]);
    expect(results).toEqual([['Sheet1'], ['Sheet1'], ['Sheet1'], ['Sheet1']]);
    expect(grants).toHaveLength(1);
  });

  it('a mint resolving after bindSession does not clobber the bound scope (Worker F, F3)', async () => {
    const client = new GatewayClient('http://127.0.0.1:8200');
    const seenScopes: Array<string | undefined> = [];
    let releaseFirstMint: ((g: EngineAccessGrant) => void) | null = null;
    vi.spyOn(client, 'engineAccess').mockImplementation((opts?: { sessionId?: string }) => {
      seenScopes.push(opts?.sessionId);
      if (seenScopes.length === 1) {
        // The pre-bind mint: hangs until the test releases it.
        return new Promise<EngineAccessGrant>((resolve) => {
          releaseFirstMint = resolve;
        });
      }
      return Promise.resolve({
        ...GRANT,
        accessToken: `tok-scoped-${seenScopes.length}`,
        sessionId: opts?.sessionId ?? 'sess_random',
      });
    });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { sheets: [] })));
    const transport = new SignedEngineTransport(client);
    const pending = transport.ensureGrant(); // unscoped mint, in flight
    transport.bindSession('sess_file'); // the join handshake lands mid-mint
    releaseFirstMint!({ ...GRANT, accessToken: 'tok-stale', sessionId: 'sess_random' });
    const settled = await pending;
    // The stale random-scope grant was discarded; the caller re-resolved
    // against the bound session instead of adopting it.
    expect(settled.sessionId).toBe('sess_file');
    expect(transport.currentSessionId).toBe('sess_file');
    expect(seenScopes).toEqual([undefined, 'sess_file']);
    // And the cache now serves the bound scope with no further mint.
    const again = await transport.ensureGrant();
    expect(again.sessionId).toBe('sess_file');
    expect(seenScopes).toHaveLength(2);
  });

  it('beacon release posts to the direct engine URL with ?access_token=', async () => {
    const beacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    const { transport } = makeTransport(async () => jsonResponse(200, { sheets: [] }));
    await transport.sheetNames(); // establishes the cached grant
    expect(transport.releaseBeacon('sess_1', 'tab-close')).toBe(true);
    const [url] = beacon.mock.calls[0] as unknown as [string, unknown];
    expect(url).toBe('http://127.0.0.1:8201/session/release?access_token=tok-1');
  });
});

describe('SignedEngineTransport progressive load failure (issue #18)', () => {
  const ndjson = (lines: unknown[]) =>
    new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    });

  it('an error chunk after a meta chunk REJECTS — never resolves as a partial load', async () => {
    const { transport } = makeTransport(async () =>
      ndjson([
        { type: 'meta', sheets: ['Sheet1'], totalSheets: 1, totalCells: 0, metadata: {}, progress: { sheetsDone: 0, cellsDone: 0, totalSheets: 1, totalCells: 0 } },
        { type: 'error', error: 'failed to parse xlsx: not a readable spreadsheet package' },
      ]),
    );
    await expect(transport.loadXlsxProgressive('AAAA', () => {})).rejects.toThrowError(
      /failed to parse xlsx/,
    );
  });

  it('an error-only stream REJECTS — never resolves as an empty workbook', async () => {
    const { transport } = makeTransport(async () =>
      ndjson([{ type: 'error', error: 'failed to parse xlsx: boom' }]),
    );
    await expect(transport.loadXlsxProgressive('AAAA', () => {})).rejects.toThrowError(
      /failed to parse xlsx: boom/,
    );
  });
});
