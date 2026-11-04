import { describe, expect, it, vi } from 'vitest';
import {
  GeocodeCache,
  GeocodeHttpError,
  GeocodeService,
  bundledCoordinateProvider,
  bundledPlaceNames,
  createNominatimGeocodeProvider,
  geocodeBatch,
  geocodedToLatLong,
  isNetworkFailure,
  normalizePlaceQuery,
  type GeocodeProvider,
  type GeocodeResult,
} from './geocode';

function mockFetch(
  handler: (url: string, init?: RequestInit) => { ok: boolean; status?: number; json?: unknown },
): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const r = handler(url as string, init);
    if (!r.ok) {
      return { ok: false, status: r.status ?? 500, json: async () => r.json } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => r.json } as unknown as Response;
  }) as unknown as typeof fetch;
}

function throwingFetch(err: unknown): typeof fetch {
  return (async () => {
    throw err;
  }) as unknown as typeof fetch;
}

const PARIS_HIT = [
  { name: 'Paris', lat: '48.8566', lon: '2.3522', display_name: 'Paris, Île-de-France, France' },
];

function liveProviderFor(handler: (url: string) => { ok: boolean; status?: number; json?: unknown }) {
  return createNominatimGeocodeProvider({
    fetchImpl: mockFetch(handler),
    timeoutMs: 1000,
    minIntervalMs: 0, // no throttle in tests unless testing the throttle itself
  });
}

function serviceWith(opts: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  offlineCooldownMs?: number;
}): { service: GeocodeService; calls: string[] } {
  const calls: string[] = [];
  const inner = opts.fetchImpl ?? mockFetch(() => ({ ok: true, json: PARIS_HIT }));
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push(String(url));
    return (inner as (u: unknown, i?: RequestInit) => Promise<Response>)(url, init);
  }) as unknown as typeof fetch;
  const service = new GeocodeService({
    live: createNominatimGeocodeProvider({
      fetchImpl,
      timeoutMs: 1000,
      minIntervalMs: 0,
    }),
    cache: new GeocodeCache({ storage: null }),
    now: opts.now,
    offlineCooldownMs: opts.offlineCooldownMs,
  });
  return { service, calls };
}

describe('normalizePlaceQuery', () => {
  it('is case/diacritic/whitespace insensitive', () => {
    expect(normalizePlaceQuery('  São   Paulo ')).toBe('sao paulo');
    expect(normalizePlaceQuery('ZÜRICH')).toBe('zurich');
    expect(normalizePlaceQuery('Bogotá')).toBe('bogota');
  });
});

describe('createNominatimGeocodeProvider forward', () => {
  it('parses a search hit into a live result', async () => {
    const p = liveProviderFor(() => ({ ok: true, json: PARIS_HIT }));
    const r = await p.forward('Paris');
    expect(r).toEqual({ name: 'Paris', lat: 48.8566, lon: 2.3522, provenance: 'live' });
  });

  it('returns null for empty results', async () => {
    const p = liveProviderFor(() => ({ ok: true, json: [] }));
    expect(await p.forward('Xyzzy Notaplace')).toBeNull();
  });

  it('returns null for unparseable coordinates', async () => {
    const p = liveProviderFor(() => ({
      ok: true,
      json: [{ display_name: 'Nowhere', lat: 'abc', lon: 'def' }],
    }));
    expect(await p.forward('Nowhere')).toBeNull();
  });

  it('returns null for blank queries without fetching', async () => {
    let fetched = false;
    const p = createNominatimGeocodeProvider({
      fetchImpl: mockFetch(() => {
        fetched = true;
        return { ok: true, json: [] };
      }),
      minIntervalMs: 0,
    });
    expect(await p.forward('   ')).toBeNull();
    expect(fetched).toBe(false);
  });

  it('throws GeocodeHttpError on HTTP errors', async () => {
    const p = liveProviderFor(() => ({ ok: false, status: 429 }));
    await expect(p.forward('Paris')).rejects.toBeInstanceOf(GeocodeHttpError);
  });

  it('sends a User-Agent identifying the app', async () => {
    let seen: Record<string, string> | undefined;
    const p = createNominatimGeocodeProvider({
      fetchImpl: mockFetch((_url, init) => {
        seen = (init?.headers ?? {}) as Record<string, string>;
        return { ok: true, json: [] };
      }),
      minIntervalMs: 0,
      userAgent: 'icecream-sheets-test/1.0',
    });
    await p.forward('Paris');
    expect(seen?.['User-Agent']).toBe('icecream-sheets-test/1.0');
    expect(seen?.['Accept']).toBe('application/json');
  });

  it('throttles requests to the configured interval', async () => {
    const p = createNominatimGeocodeProvider({
      fetchImpl: mockFetch(() => ({ ok: true, json: PARIS_HIT })),
      minIntervalMs: 120,
    });
    const t0 = Date.now();
    await Promise.all([p.forward('Paris'), p.forward('London'), p.forward('Tokyo')]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
  }, 10000);
});

describe('createNominatimGeocodeProvider reverse', () => {
  it('returns the display name', async () => {
    const p = liveProviderFor((url) =>
      url.includes('/reverse?')
        ? { ok: true, json: { display_name: 'Paris, Île-de-France, France' } }
        : { ok: true, json: PARIS_HIT },
    );
    expect(await p.reverse(48.85, 2.35)).toBe('Paris, Île-de-France, France');
  });

  it('returns null for invalid coordinates without fetching', async () => {
    let fetched = false;
    const p = createNominatimGeocodeProvider({
      fetchImpl: mockFetch(() => {
        fetched = true;
        return { ok: true, json: {} };
      }),
      minIntervalMs: 0,
    });
    expect(await p.reverse(999, 0)).toBeNull();
    expect(await p.reverse(NaN, 0)).toBeNull();
    expect(fetched).toBe(false);
  });
});

describe('bundledCoordinateProvider', () => {
  it('resolves well-known cities as bundled', async () => {
    const r = await bundledCoordinateProvider.forward('Paris');
    expect(r?.lat).toBeCloseTo(48.8566, 3);
    expect(r?.lon).toBeCloseTo(2.3522, 3);
    expect(r?.provenance).toBe('bundled');
  });

  it('is diacritic/case insensitive and resolves aliases', async () => {
    expect((await bundledCoordinateProvider.forward('sao paulo'))?.name).toBe('São Paulo');
    expect((await bundledCoordinateProvider.forward('NYC'))?.name).toBe('New York');
    expect((await bundledCoordinateProvider.forward('sf'))?.name).toBe('San Francisco');
  });

  it('returns null for unknown places — never a guess', async () => {
    expect(await bundledCoordinateProvider.forward('Atlantis')).toBeNull();
    expect(await bundledCoordinateProvider.forward('Springfield')).toBeNull();
  });

  it('reverse finds the nearest bundled city within tolerance', async () => {
    expect(await bundledCoordinateProvider.reverse(48.86, 2.35)).toBe('Paris');
    // Mid-Atlantic (0,0)-ish ocean: no bundled city within 2 degrees.
    expect(await bundledCoordinateProvider.reverse(0, -30)).toBeNull();
  });

  it('covers a healthy spread of cities', () => {
    expect(bundledPlaceNames().length).toBeGreaterThanOrEqual(40);
  });
});

describe('GeocodeService composition', () => {
  it('caches live results: same query hits fetch once', async () => {
    const { service, calls } = serviceWith({});
    const a = await service.forward('Paris');
    const b = await service.forward('paris'); // different case, same normalized key
    expect(a?.provenance).toBe('live');
    expect(b).toEqual(a);
    expect(calls).toHaveLength(1);
  });

  it('caches definitive misses: unknown place hits fetch once', async () => {
    const { service, calls } = serviceWith({
      fetchImpl: mockFetch(() => ({ ok: true, json: [] })),
    });
    expect(await service.forward('Xyzzy Notaplace')).toBeNull();
    expect(await service.forward('Xyzzy Notaplace')).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('falls back to bundled with offline indication on network failure', async () => {
    const { service, calls } = serviceWith({
      fetchImpl: throwingFetch(new TypeError('fetch failed')),
      offlineCooldownMs: 60_000,
    });
    const r = await service.forward('Paris');
    expect(r?.provenance).toBe('bundled');
    expect(r?.lat).toBeCloseTo(48.8566, 2);
    expect(service.isOffline()).toBe(true);
    // Within cooldown the live provider is not retried.
    await service.forward('London');
    expect(calls).toHaveLength(1);
  });

  it('returns null (not a guess) for unknown places while offline', async () => {
    const { service } = serviceWith({ fetchImpl: throwingFetch(new TypeError('down')) });
    expect(await service.forward('Atlantis')).toBeNull();
    expect(service.isOffline()).toBe(true);
  });

  it('recovers: a later success clears the offline flag', async () => {
    let fail = true;
    let t = 1_000_000;
    const { service } = serviceWith({
      fetchImpl: mockFetch(() => {
        if (fail) throw new TypeError('down');
        return { ok: true, json: PARIS_HIT };
      }),
      now: () => t,
      offlineCooldownMs: 60_000,
    });
    await service.forward('Tokyo'); // fails -> offline, bundled fallback
    expect(service.isOffline()).toBe(true);
    t += 61_000; // cooldown elapses
    expect(service.isOffline()).toBe(false);
    fail = false;
    const r = await service.forward('Osaka');
    expect(r?.provenance).toBe('live');
    expect(service.isOffline()).toBe(false);
  });

  it('treats HTTP 400 as a definitive miss (no offline fallback)', async () => {
    const { service } = serviceWith({
      fetchImpl: mockFetch(() => ({ ok: false, status: 400 })),
    });
    expect(await service.forward('Paris')).toBeNull();
    expect(service.isOffline()).toBe(false);
  });

  it('dedupes concurrent identical queries into one fetch', async () => {
    const { service, calls } = serviceWith({});
    const [a, b] = await Promise.all([service.forward('Paris'), service.forward('Paris')]);
    expect(a).toEqual(b);
    expect(calls).toHaveLength(1);
  });

  it('reverse falls back to bundled when offline', async () => {
    const { service } = serviceWith({ fetchImpl: throwingFetch(new TypeError('down')) });
    expect(await service.reverse(48.86, 2.35)).toBe('Paris');
  });

  it('setLiveProvider(null) pins bundled-only mode', async () => {
    const { service, calls } = serviceWith({});
    service.setLiveProvider(null);
    expect(service.liveProviderId).toBe('none');
    const r = await service.forward('Tokyo');
    expect(r?.provenance).toBe('bundled');
    expect(calls).toHaveLength(0);
  });
});

describe('isNetworkFailure', () => {
  it('classifies network failures', () => {
    expect(isNetworkFailure(new TypeError('fetch failed'))).toBe(true);
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(isNetworkFailure(abort)).toBe(true);
    expect(isNetworkFailure(new GeocodeHttpError(503, 'x'))).toBe(true);
    expect(isNetworkFailure(new GeocodeHttpError(429, 'x'))).toBe(true);
    expect(isNetworkFailure(new GeocodeHttpError(400, 'x'))).toBe(false);
    expect(isNetworkFailure(new Error('weird'))).toBe(false);
  });
});

describe('GeocodeCache', () => {
  it('returns undefined on miss, caches hits and misses', () => {
    const c = new GeocodeCache({ storage: null });
    expect(c.get('Paris')).toBeUndefined();
    const r: GeocodeResult = { name: 'Paris', lat: 1, lon: 2, provenance: 'live' };
    c.set('Paris', r);
    c.set('Nowhere', null);
    expect(c.get('paris')).toEqual(r);
    expect(c.get('NOWHERE')).toBeNull();
    expect(c.size).toBe(2);
    c.clear();
    expect(c.size).toBe(0);
  });

  it('persists across instances via injected storage', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const r: GeocodeResult = { name: 'Paris', lat: 1, lon: 2, provenance: 'live' };
    const c1 = new GeocodeCache({ storage, now: () => 1000 });
    c1.set('Paris', r);
    const c2 = new GeocodeCache({ storage, now: () => 2000 });
    expect(c2.get('paris')).toEqual(r);
  });

  it('expires entries past the TTL', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const c1 = new GeocodeCache({ storage, ttlMs: 100, now: () => 0 });
    c1.set('Paris', { name: 'Paris', lat: 1, lon: 2, provenance: 'live' });
    const c2 = new GeocodeCache({ storage, ttlMs: 100, now: () => 10_000 });
    expect(c2.get('paris')).toBeUndefined();
  });

  it('survives corrupt persisted data', () => {
    const storage = {
      getItem: () => 'not-json{{{',
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    const c = new GeocodeCache({ storage });
    expect(c.get('Paris')).toBeUndefined();
    expect(c.size).toBe(0);
  });
});

describe('geocodeBatch', () => {
  function batchService(): { service: GeocodeService; calls: string[] } {
    const calls: string[] = [];
    const live: GeocodeProvider = {
      id: 'fake',
      displayName: 'fake',
      forward: async (name: string) => {
        calls.push(name);
        await new Promise((r) => setTimeout(r, 5));
        if (name === 'Nowhere') return null;
        return { name, lat: 10, lon: 20, provenance: 'live' as const };
      },
      reverse: async () => null,
    };
    const service = new GeocodeService({ live, cache: new GeocodeCache({ storage: null }) });
    return { service, calls };
  }

  it('resolves each unique name once and reports progress', async () => {
    const { service, calls } = batchService();
    const progress: [number, number][] = [];
    const items = await geocodeBatch(service, ['Paris', 'Paris', 'Nowhere', '  paris '], {
      onProgress: (d, t) => progress.push([d, t]),
    });
    expect(items).toHaveLength(2); // deduped: Paris + Nowhere
    expect(items[0]).toEqual({
      query: 'Paris',
      result: { name: 'Paris', lat: 10, lon: 20, provenance: 'live' },
    });
    expect(items[1].result).toBeNull();
    expect(calls).toEqual(['Paris', 'Nowhere']);
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it('skips blank names', async () => {
    const { service } = batchService();
    const items = await geocodeBatch(service, ['', '   ']);
    expect(items).toHaveLength(0);
  });
});

describe('geocodedToLatLong', () => {
  it('maps successful results to globe points with labels and values', () => {
    const pts = geocodedToLatLong(
      [
        { query: 'Paris', result: { name: 'Paris', lat: 48.8, lon: 2.3, provenance: 'live' } },
        { query: 'Nowhere', result: null },
      ],
      new Map([['paris', 42]]),
    );
    expect(pts).toHaveLength(1);
    expect(pts[0]).toEqual({ lat: 48.8, long: 2.3, label: 'Paris', value: 42 });
  });

  it('omits non-finite values', () => {
    const pts = geocodedToLatLong(
      [{ query: 'Paris', result: { name: 'Paris', lat: 48.8, lon: 2.3, provenance: 'live' } }],
      new Map([['paris', NaN]]),
    );
    expect(pts[0].value).toBeUndefined();
  });
});

describe('module seam helpers', () => {
  it('vi can stub a custom provider end to end', async () => {
    const custom: GeocodeProvider = {
      id: 'custom',
      displayName: 'custom',
      forward: vi.fn(async (name: string) => ({
        name,
        lat: 1,
        lon: 2,
        provenance: 'live' as const,
      })),
      reverse: vi.fn(async () => 'Somewhere'),
    };
    const service = new GeocodeService({ live: custom, cache: new GeocodeCache({ storage: null }) });
    await service.forward('X');
    expect(custom.forward).toHaveBeenCalledTimes(1);
    expect(service.liveProviderId).toBe('custom');
  });
});

describe('GeocodeCache throttled persistence', () => {
  function memStorage() {
    const store = new Map<string, string>();
    let writes = 0;
    return {
      writes: () => writes,
      storage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { writes += 1; store.set(k, v); },
        removeItem: (k: string) => void store.delete(k),
      },
      raw: () => store.get('icecream.geocodeCache.v1'),
    };
  }
  const res = (n: string): GeocodeResult => ({ name: n, lat: 1, lon: 2, provenance: 'bundled' });

  it('persists the first set synchronously, then throttles batch writes', () => {
    const m = memStorage();
    const c = new GeocodeCache({ storage: m.storage, now: () => 0 });
    for (let i = 0; i < 60; i++) c.set(`City${i}`, res(`City${i}`));
    // Saves land on sets 1, 25, 50 — not on every set (O(n^2) avoided).
    expect(m.writes()).toBe(3);
    // The persisted snapshot lags the in-memory tail until flush().
    const snap = JSON.parse(m.raw() as string) as Record<string, { result: GeocodeResult | null }>;
    expect(Object.keys(snap)).toHaveLength(50);
    c.flush();
    expect(m.writes()).toBe(4);
    const snap2 = JSON.parse(m.raw() as string) as Record<string, { result: GeocodeResult | null }>;
    expect(Object.keys(snap2)).toHaveLength(60);
    // A fresh instance sees everything after the flush.
    const c2 = new GeocodeCache({ storage: m.storage, now: () => 0 });
    expect(c2.get('city59')).toEqual(res('City59'));
  });

  it('flush() is a no-op when nothing is dirty', () => {
    const m = memStorage();
    const c = new GeocodeCache({ storage: m.storage, now: () => 0 });
    c.flush();
    expect(m.writes()).toBe(0);
  });
});

describe('geocodeBatch progress throttling', () => {
  it('throttles onProgress but always reports the final count', async () => {
    const live: GeocodeProvider = {
      id: 'fake',
      displayName: 'fake',
      forward: async (name: string) => ({ name, lat: 1, lon: 2, provenance: 'bundled' as const }),
      reverse: async () => null,
    };
    let t = 0;
    const service = new GeocodeService({ live, cache: new GeocodeCache({ storage: null }), now: () => t });
    const calls: Array<[number, number]> = [];
    const names = Array.from({ length: 100 }, (_, i) => `City${i}`);
    await geocodeBatch(service, names, {
      onProgress: (d, tot) => { calls.push([d, tot]); },
      progressIntervalMs: 150,
      now: () => t,
    });
    // First call immediate, then throttled while time is frozen, final always fires.
    expect(calls.length).toBeLessThan(10);
    expect(calls[calls.length - 1]).toEqual([100, 100]);
    // Advancing time lets intermediate reports through.
    t = 1000;
    const calls2: Array<[number, number]> = [];
    await geocodeBatch(service, names.slice(0, 10), {
      onProgress: (d, tot) => { calls2.push([d, tot]); t += 200; },
      progressIntervalMs: 150,
      now: () => t,
    });
    expect(calls2.length).toBeGreaterThan(2);
  });
});

describe('geocodeBatch event-loop yield', () => {
  it('yields to the event loop during large batches so the UI stays alive', async () => {
    const live: GeocodeProvider = {
      id: 'fake',
      displayName: 'fake',
      forward: async (name: string) => ({ name, lat: 1, lon: 2, provenance: 'bundled' as const }),
      reverse: async () => null,
    };
    const service = new GeocodeService({ live, cache: new GeocodeCache({ storage: null }) });
    const spy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const names = Array.from({ length: 120 }, (_, i) => `City${i}`);
      await geocodeBatch(service, names, {});
      // Yields at items 50 and 100 (not after the final item).
      const zeroDelay = spy.mock.calls.filter((c) => c[1] === 0);
      expect(zeroDelay.length).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not yield for small batches', async () => {
    const live: GeocodeProvider = {
      id: 'fake',
      displayName: 'fake',
      forward: async (name: string) => ({ name, lat: 1, lon: 2, provenance: 'bundled' as const }),
      reverse: async () => null,
    };
    const service = new GeocodeService({ live, cache: new GeocodeCache({ storage: null }) });
    const spy = vi.spyOn(globalThis, 'setTimeout');
    try {
      await geocodeBatch(service, ['A', 'B', 'C'], {});
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
