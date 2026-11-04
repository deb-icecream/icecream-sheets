/**
 * Leg 1 (deploy follow-up) — gateway Google ID token for the
 * service-family proxy.
 *
 * Production failure being pinned: the combined service-package Cloud
 * Run service grants roles/run.invoker ONLY to the gateway SA, so
 * Cloud Run's platform layer 401s any proxied request without a Google
 * ID token (audience = the service URL) in Authorization — the gateway
 * attached none, and every /api/{vault,meta,etl,agent,addons,
 * connectors,automation} call died at the platform.
 *
 * Pinned here:
 * (provider) metadata identity fetch shape (URL, audience encoding,
 *   Metadata-Flavor header), per-audience cache, refresh shortly
 *   before the JWT exp, fail-soft null + negative cache when the
 *   metadata server is absent/errors.
 * (proxy)    service-family upstreams get `Authorization: Bearer
 *   <id-token>` with audience = the configured upstream's origin;
 *   end-user identity still rides x-principal; NON-service upstreams
 *   (engine) are untouched (gateway JWT passes through, provider never
 *   consulted); automation owner-routed to an ENGINE is untouched;
 *   provider-null (local dev) leaves service requests byte-identical
 *   to the pre-fix proxy behavior.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createGateway } from '../src/gateway.js';
import {
  createMetadataIdTokenProvider,
  idTokenExpiryMs,
  metadataIdentityUrl,
} from '../src/serviceIdToken.js';
import { MemoryFileRegistry } from '../src/deploy/fileRegistry.js';
import { httpJson, startEchoBackend, startServer, stop, type EchoBackend, type Started } from './helpers.js';

const SECRET = 'test-leg1-secret';

function fakeJwt(expSec: number): string {
  const seg = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${seg({ alg: 'RS256', typ: 'JWT' })}.${seg({ exp: expSec, aud: 'x' })}.fakesig`;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

describe('createMetadataIdTokenProvider', () => {
  it('fetches from the metadata identity endpoint with the audience encoded and caches per audience', async () => {
    const calls: { url: string; flavor: string | null }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        flavor: (init.headers as Record<string, string>)['Metadata-Flavor'] ?? null,
      });
      return {
        ok: true,
        status: 200,
        text: async () => fakeJwt(Math.floor(Date.now() / 1000) + 3600),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const provider = createMetadataIdTokenProvider({ fetchImpl });
    const aud = 'https://icecream-sheet-service-abc-uc.a.run.app';
    const token = await provider(aud);
    expect(token).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(metadataIdentityUrl(aud));
    expect(calls[0]?.url).toContain(`audience=${encodeURIComponent(aud)}`);
    expect(calls[0]?.url).toContain('format=full');
    expect(calls[0]?.flavor).toBe('Google');

    // Cache: same audience again → no second fetch; a different
    // audience is a different cache entry → one more fetch, with
    // THAT audience in the query.
    expect(await provider(aud)).toBe(token);
    expect(calls).toHaveLength(1);
    const other = 'https://other-service-xyz-uc.a.run.app';
    await provider(other);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe(metadataIdentityUrl(other));
  });

  it('refreshes shortly before expiry (inside the skew window)', async () => {
    let now = 1_700_000_000_000;
    let fetches = 0;
    const fetchImpl = (async () => {
      fetches += 1;
      return {
        ok: true,
        status: 200,
        text: async () => fakeJwt(Math.floor(now / 1000) + 3600),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const provider = createMetadataIdTokenProvider({ fetchImpl, nowMs: () => now });
    const aud = 'https://svc.example.run.app';
    const first = await provider(aud);
    expect(fetches).toBe(1);
    // 10 minutes before expiry: still cached (skew is 5 minutes).
    now += 50 * 60_000;
    expect(await provider(aud)).toBe(first);
    expect(fetches).toBe(1);
    // 4 minutes before expiry: inside the skew → refetch, new token.
    now += 6 * 60_000;
    const refreshed = await provider(aud);
    expect(fetches).toBe(2);
    expect(refreshed).not.toBe(first);
  });

  it('fails soft to null when the metadata server is absent, and negative-caches briefly', async () => {
    let now = 1_700_000_000_000;
    let fetches = 0;
    const fetchImpl = (async () => {
      fetches += 1;
      throw new Error('getaddrinfo ENOTFOUND metadata.google.internal');
    }) as unknown as typeof fetch;
    const provider = createMetadataIdTokenProvider({ fetchImpl, nowMs: () => now });
    const aud = 'https://svc.example.run.app';
    expect(await provider(aud)).toBeNull();
    // Immediate retry is served by the negative cache — local dev
    // must not pay a dead lookup on every proxied request.
    expect(await provider(aud)).toBeNull();
    expect(fetches).toBe(1);
    // After the negative TTL it retries (a transient prod failure
    // recovers instead of pinning).
    now += 31_000;
    expect(await provider(aud)).toBeNull();
    expect(fetches).toBe(2);
  });

  it('fails soft to null on a non-OK metadata response', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 404,
      text: async () => 'not found',
    })) as unknown as typeof fetch;
    const provider = createMetadataIdTokenProvider({ fetchImpl });
    expect(await provider('https://svc.example.run.app')).toBeNull();
  });

  it('idTokenExpiryMs decodes exp and rejects garbage', () => {
    expect(idTokenExpiryMs(fakeJwt(1_700_000_000))).toBe(1_700_000_000_000);
    expect(idTokenExpiryMs('not-a-jwt')).toBeNull();
    expect(idTokenExpiryMs('a.b.c')).toBeNull();
    expect(idTokenExpiryMs('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Proxy integration
// ---------------------------------------------------------------------------

describe('gateway proxy service ID token (Leg 1)', () => {
  const started: Started[] = [];
  afterEach(async () => {
    while (started.length) await stop(started.pop()!);
  });

  async function boot(listener: Parameters<typeof startServer>[0]): Promise<Started> {
    const s = await startServer(listener);
    started.push(s);
    return s;
  }
  async function bootEcho(): Promise<EchoBackend> {
    const b = await startEchoBackend();
    started.push(b);
    return b;
  }

  async function gatewayWith(
    routes: Record<string, string>,
    serviceIdTokenProvider?: (audience: string) => Promise<string | null>,
    extra: Record<string, unknown> = {},
  ): Promise<{ url: string; auth: Record<string, string>; jwt: string }> {
    const gw = await boot(
      createGateway({
        devLoginEnabled: true,
        authSecret: SECRET,
        routes,
        rateLimit: { points: 1000, perSeconds: 60 },
        ...(serviceIdTokenProvider ? { serviceIdTokenProvider } : {}),
        ...extra,
      }),
    );
    const login = await httpJson('POST', `${gw.url}/auth/login`, { body: { userId: 'leg1' } });
    expect(login.status).toBe(200);
    const jwt = (login.json as { token: string }).token;
    return { url: gw.url, auth: { Authorization: `Bearer ${jwt}` }, jwt };
  }

  it('attaches Bearer <id-token> (audience = upstream origin) to service-family routes only; x-principal preserved', async () => {
    const agent = await bootEcho();
    const meta = await bootEcho();
    const engine = await bootEcho();
    const audiences: string[] = [];
    const provider = async (audience: string) => {
      audiences.push(audience);
      return `id-token-for:${audience}`;
    };
    const gw = await gatewayWith(
      { '/api/agent': agent.url, '/api/meta': meta.url, '/api/engine': engine.url },
      provider,
    );

    // Service-family: Authorization REPLACED by the ID token for THIS
    // upstream's origin; the end-user identity rides x-principal.
    const r1 = await httpJson('POST', `${gw.url}/api/agent/message`, {
      headers: gw.auth,
      body: { text: 'hi' },
    });
    expect(r1.status).toBe(200);
    expect(agent.last?.headers['authorization']).toBe(`Bearer id-token-for:${agent.url}`);
    expect(agent.last?.headers['x-principal']).toBe('user:leg1');

    // A second service upstream gets a token for ITS origin (per-audience).
    const r2 = await httpJson('GET', `${gw.url}/api/meta/health`, { headers: gw.auth });
    expect(r2.status).toBe(200);
    expect(meta.last?.headers['authorization']).toBe(`Bearer id-token-for:${meta.url}`);
    expect(meta.last?.headers['x-principal']).toBe('user:leg1');

    // Engine: NOT a service upstream — provider never consulted for
    // it and the caller's gateway JWT passes through exactly as
    // before (engines use the signed-URL flow + their own tokens).
    const r3 = await httpJson('GET', `${gw.url}/api/engine/health`, { headers: gw.auth });
    expect(r3.status).toBe(200);
    expect(engine.last?.headers['authorization']).toBe(`Bearer ${gw.jwt}`);
    expect(engine.last?.headers['x-principal']).toBe('user:leg1');
    expect(audiences).toEqual([agent.url, meta.url]);
  });

  it('provider null (metadata absent / local dev): service requests proxied exactly as before', async () => {
    const agent = await bootEcho();
    const gw = await gatewayWith(
      { '/api/agent': agent.url },
      async () => null,
    );
    const r = await httpJson('POST', `${gw.url}/api/agent/message`, {
      headers: gw.auth,
      body: { text: 'hi' },
    });
    expect(r.status).toBe(200);
    expect(agent.last?.headers['authorization']).toBe(`Bearer ${gw.jwt}`);
    expect(agent.last?.headers['x-principal']).toBe('user:leg1');
  });

  it('automation owner-routed to an engine gets NO service ID token', async () => {
    const serviceBackend = await bootEcho();
    const engineOwner = await bootEcho();
    const registry = new MemoryFileRegistry(60_000);
    const claimed = await registry.claim(
      {
        fileId: 'file-leg1',
        sessionId: 'sess-leg1',
        ownerInstance: 'engine-1',
        ownerEndpoint: engineOwner.url,
        leaseExpiry: Date.now() + 60_000,
        ownershipEpoch: 1,
        currentRevision: 0,
        storedRevision: 0,
        updatedAt: Date.now(),
        creatorPrincipal: 'user:leg1',
      },
      null,
    );
    expect(claimed).toBe(true);
    const audiences: string[] = [];
    const gw = await gatewayWith(
      { '/api/automation': serviceBackend.url },
      async (audience: string) => {
        audiences.push(audience);
        return 'id-token-should-not-be-used';
      },
      { fileRegistry: registry },
    );

    // With a live owner + fileId: routed to the ENGINE — no ID token,
    // gateway JWT passes through as today.
    const r1 = await httpJson('GET', `${gw.url}/api/automation/triggers?fileId=file-leg1`, {
      headers: gw.auth,
    });
    expect(r1.status).toBe(200);
    expect(engineOwner.last?.headers['authorization']).toBe(`Bearer ${gw.jwt}`);
    expect(audiences).toEqual([]);

    // Without a fileId: stays on the configured SERVICE backend and
    // DOES get the ID token for that backend's origin.
    const r2 = await httpJson('GET', `${gw.url}/api/automation/triggers`, { headers: gw.auth });
    expect(r2.status).toBe(200);
    expect(serviceBackend.last?.headers['authorization']).toBe('Bearer id-token-should-not-be-used');
    expect(audiences).toEqual([serviceBackend.url]);
  });
});
