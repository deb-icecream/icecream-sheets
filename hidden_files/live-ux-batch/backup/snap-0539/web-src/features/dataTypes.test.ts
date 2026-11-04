import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveStock,
  resolveGeography,
  stockSymbols,
  placeNames,
  dataTypeField,
  dtCellKey,
  createStooqStockProvider,
  createNominatimGeographyProvider,
  setStockProvider,
  setGeographyProvider,
  resetDataTypeProviders,
  useSampleDataTypeProviders,
  resolveStockLive,
  resolveGeographyLive,
  stockProviderId,
  geographyProviderId,
} from './dataTypes';

afterEach(() => {
  resetDataTypeProviders();
});

describe('dataTypes', () => {
  it('resolves a known stock symbol (case-insensitive)', () => {
    const v = resolveStock('aapl');
    expect(v).not.toBeNull();
    expect(v!.kind).toBe('stock');
    expect(v!.display).toBe('AAPL');
    expect(v!.fields.length).toBeGreaterThan(0);
  });
  it('returns null for unknown symbols', () => {
    expect(resolveStock('ZZZZ')).toBeNull();
  });
  it('stock fields include price and change', () => {
    const v = resolveStock('MSFT')!;
    expect(dataTypeField(v, 'Price')).toMatch(/^\$/);
    expect(dataTypeField(v, 'Company')).toContain('Microsoft');
  });
  it('resolves a known place', () => {
    const v = resolveGeography('Tokyo')!;
    expect(v).not.toBeNull();
    expect(v.kind).toBe('geography');
    expect(dataTypeField(v, 'Country')).toBe('Japan');
    expect(dataTypeField(v, 'Latitude')).toBe('35.6762');
  });
  it('returns null for unknown places', () => {
    expect(resolveGeography('Atlantis')).toBeNull();
  });
  it('field lookup is case-insensitive, null when missing', () => {
    const v = resolveStock('NVDA')!;
    expect(dataTypeField(v, 'price')).toMatch(/^\$/);
    expect(dataTypeField(v, 'Nope')).toBeNull();
  });
  it('cell keys are unique per sheet/row/col', () => {
    expect(dtCellKey('S1', 0, 0)).not.toBe(dtCellKey('S1', 0, 1));
    expect(dtCellKey('S1', 0, 0)).not.toBe(dtCellKey('S2', 0, 0));
  });
});

function mockFetch(handler: (url: string) => { ok: boolean; status?: number; text?: string; json?: unknown }): typeof fetch {
  return (async (url: string) => {
    const r = handler(url);
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      text: async () => r.text ?? '',
      json: async () => r.json,
    };
  }) as unknown as typeof fetch;
}

describe('dataTypes live providers', () => {
  it('defaults are the live providers', () => {
    expect(stockProviderId()).toBe('stooq');
    expect(geographyProviderId()).toBe('nominatim');
  });

  it('stooq provider parses daily CSV and computes change', async () => {
    const csv = 'Date,Open,High,Low,Close,Volume\n2024-06-13,100,101,99,100.5,1000000\n2024-06-14,101,103,100,102.25,2000000\n';
    const p = createStooqStockProvider({
      fetchImpl: mockFetch((url) => {
        expect(url).toContain('stooq.com');
        expect(url).toContain('s=aapl.us');
        return { ok: true, text: csv };
      }),
    });
    const q = await p.resolveStock('aapl');
    expect(q).not.toBeNull();
    expect(q!.symbol).toBe('AAPL');
    expect(q!.price).toBe(102.25);
    expect(q!.change).toBeCloseTo(1.75, 10);
    expect(q!.changePct).toBeCloseTo(1.7413, 3);
    expect(q!.volume).toBe('2.0M');
    // Known symbol keeps the bundled company name.
    expect(q!.name).toBe('Apple Inc.');
  });

  it('stooq provider returns null for garbage responses', async () => {
    const p = createStooqStockProvider({ fetchImpl: mockFetch(() => ({ ok: true, text: 'nope' })) });
    expect(await p.resolveStock('AAPL')).toBeNull();
  });

  it('stooq provider rejects malformed symbols without fetching', async () => {
    let fetched = false;
    const p = createStooqStockProvider({
      fetchImpl: mockFetch(() => { fetched = true; return { ok: true, text: '' }; }),
    });
    expect(await p.resolveStock('!!!')).toBeNull();
    expect(fetched).toBe(false);
  });

  it('nominatim provider parses geocoding results', async () => {
    const p = createNominatimGeographyProvider({
      fetchImpl: mockFetch((url) => {
        expect(url).toContain('nominatim.openstreetmap.org');
        return {
          ok: true,
          json: [{ name: 'Paris', lat: '48.8566', lon: '2.3522', display_name: 'Paris, France', address: { country: 'France' } }],
        };
      }),
    });
    const g = await p.resolveGeography('Paris');
    expect(g).not.toBeNull();
    expect(g!.latitude).toBeCloseTo(48.8566, 4);
    expect(g!.longitude).toBeCloseTo(2.3522, 4);
    expect(g!.country).toBe('France');
    // Known place keeps bundled population/timezone.
    expect(g!.population).toBe('2.1M');
    expect(g!.timezone).toBe('UTC+1');
  });

  it('nominatim provider returns null when nothing found', async () => {
    const p = createNominatimGeographyProvider({ fetchImpl: mockFetch(() => ({ ok: true, json: [] })) });
    expect(await p.resolveGeography('Atlantis')).toBeNull();
  });

  it('resolveStockLive falls back to sample data when offline', async () => {
    setStockProvider(createStooqStockProvider({
      fetchImpl: mockFetch(() => { throw new Error('network down'); }),
    }));
    const v = await resolveStockLive('AAPL');
    expect(v).not.toBeNull();
    expect(v!.provenance).toBe('sample');
    expect(dataTypeField(v!, 'Company')).toBe('Apple Inc.');
  });

  it('resolveStockLive uses live data when reachable', async () => {
    const csv = 'Date,Open,High,Low,Close,Volume\n2024-06-14,101,103,100,102.25,2000000\n';
    setStockProvider(createStooqStockProvider({ fetchImpl: mockFetch(() => ({ ok: true, text: csv })) }));
    const v = await resolveStockLive('AAPL');
    expect(v!.provenance).toBe('live');
    expect(dataTypeField(v!, 'Price')).toBe('$102.25');
  });

  it('resolveGeographyLive falls back to sample data when offline', async () => {
    setGeographyProvider(createNominatimGeographyProvider({
      fetchImpl: mockFetch(() => ({ ok: false, status: 503 })),
    }));
    const v = await resolveGeographyLive('Tokyo');
    expect(v).not.toBeNull();
    expect(v!.provenance).toBe('sample');
    expect(dataTypeField(v!, 'Country')).toBe('Japan');
  });

  it('resolveGeographyLive never rejects', async () => {
    setGeographyProvider(createNominatimGeographyProvider({
      fetchImpl: mockFetch(() => { throw new Error('offline'); }),
    }));
    await expect(resolveGeographyLive('Nowhere XYZ')).resolves.toBeNull();
  });

  it('provider seam accepts custom providers and sample pinning', async () => {
    setStockProvider({ id: 'custom', resolveStock: async () => null });
    expect(stockProviderId()).toBe('custom');
    // null custom provider -> sample fallback, still marked sample.
    setStockProvider(null);
    const v = await resolveStockLive('MSFT');
    expect(v!.provenance).toBe('sample');
    useSampleDataTypeProviders();
    expect(stockProviderId()).toBe('sample');
    expect(geographyProviderId()).toBe('sample');
    resetDataTypeProviders();
    expect(stockProviderId()).toBe('stooq');
  });
});
