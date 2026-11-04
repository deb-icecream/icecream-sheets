/**
 * marketdata connector tests (packages/service/src/connectors/marketdata.ts).
 * All network access is faked via injected fetchText — no live HTTP.
 */
import { describe, expect, it } from 'vitest';
import {
  MarketDataConnector,
  MarketDataProviders,
  parseStooqCsv,
  parseAlphaVantageJson,
} from '../src/connectors/marketdata.js';
import { resolveDeps, type ResolvedConnectorDeps } from '../src/connectors/registry.js';
import type { ConnectorSpec } from '../src/connectors/spec.js';

const SPEC_VERSION = 1;

function spec(params: Record<string, string>, credentialRef?: string): ConnectorSpec {
  return {
    version: SPEC_VERSION,
    kind: 'marketdata',
    label: 'test',
    params,
    ...(credentialRef ? { credentialRef } : {}),
  } as ConnectorSpec;
}

function deps(fetchText: (url: string) => Promise<string>): ResolvedConnectorDeps {
  return resolveDeps({ fetchText });
}

const STOOQ_CSV =
  'Date,Open,High,Low,Close,Volume\n' +
  '2024-01-02,182.50,183.10,181.00,182.90,50000\n' +
  '2024-01-03,183.00,184.00,182.00,183.50,60000\n';

describe('parseStooqCsv', () => {
  it('parses Date,Open,High,Low,Close,Volume rows', () => {
    const bars = parseStooqCsv(STOOQ_CSV);
    expect(bars.length).toBe(2);
    expect(bars[0]).toEqual({
      date: '2024-01-02',
      open: 182.5,
      high: 183.1,
      low: 181,
      close: 182.9,
      volume: 50000,
    });
  });
  it('skips N/D gap rows', () => {
    const bars = parseStooqCsv('Date,Open,High,Low,Close,Volume\n2024-01-04,N/D,N/D,N/D,N/D,N/D\n');
    expect(bars).toEqual([]);
  });
});

describe('parseAlphaVantageJson', () => {
  it('parses TIME_SERIES_DAILY payloads', () => {
    const doc = {
      'Time Series (Daily)': {
        '2024-01-03': {
          '1. open': '183.00',
          '2. high': '184.00',
          '3. low': '182.00',
          '4. close': '183.50',
          '5. volume': '60000',
        },
      },
    };
    const bars = parseAlphaVantageJson(doc);
    expect(bars.length).toBe(1);
    expect(bars[0]).toEqual({
      date: '2024-01-03',
      open: 183,
      high: 184,
      low: 182,
      close: 183.5,
      volume: 60000,
    });
  });
  it('throws a clear error when the payload has no series', () => {
    expect(() => parseAlphaVantageJson({ Note: 'rate limit' })).toThrow(/no daily time series/);
  });
});

describe('MarketDataConnector (stooq default)', () => {
  it('fetches Stooq CSV and returns an OHLCV table', async () => {
    let seenUrl = '';
    const d = deps(async (url) => {
      seenUrl = url;
      return STOOQ_CSV;
    });
    const table = await new MarketDataConnector().fetch(
      spec({ symbol: 'AAPL', start: '2024-01-02', end: '2024-01-03' }),
      d,
    );
    expect(seenUrl).toContain('stooq.com');
    expect(seenUrl).toContain('s=aapl.us');
    expect(table.columns).toEqual(['Date', 'Open', 'High', 'Low', 'Close', 'Volume']);
    expect(table.rows.length).toBe(2);
    expect(table.rows[0]![4]).toBe(182.9);
  });
  it('requires a symbol', async () => {
    const d = deps(async () => STOOQ_CSV);
    await expect(new MarketDataConnector().fetch(spec({}), d)).rejects.toThrow(/symbol/);
  });
  it('rejects unknown providers', async () => {
    const d = deps(async () => STOOQ_CSV);
    await expect(
      new MarketDataConnector().fetch(spec({ symbol: 'AAPL', provider: 'nope' }), d),
    ).rejects.toThrow(/unknown market-data provider/);
  });
  it('alphavantage fails closed without a credential resolver', async () => {
    const d = deps(async () => '{}');
    await expect(
      new MarketDataConnector().fetch(
        spec({ symbol: 'AAPL', provider: 'alphavantage' }, 'my-key'),
        d,
      ),
    ).rejects.toThrow(/no credential resolver/);
  });
  it('alphavantage uses the vault secret as apikey', async () => {
    let seenUrl = '';
    const d = resolveDeps({
      fetchText: async (url) => {
        seenUrl = url;
        return JSON.stringify({
          'Time Series (Daily)': {
            '2024-01-02': {
              '1. open': '100',
              '2. high': '110',
              '3. low': '90',
              '4. close': '105',
              '5. volume': '1000',
            },
          },
        });
      },
      resolveCredential: { resolveCredential: async () => 'SECRET123' },
    });
    const table = await new MarketDataConnector().fetch(
      spec({ symbol: 'MSFT', provider: 'alphavantage', start: '2024-01-02', end: '2024-01-02' }, 'k'),
      d,
    );
    expect(seenUrl).toContain('apikey=SECRET123');
    expect(table.rows[0]).toEqual(['2024-01-02', 100, 110, 90, 105, 1000]);
  });
});

describe('MarketDataProviders', () => {
  it('ships stooq and alphavantage, accepts custom providers', () => {
    expect(MarketDataProviders.ids()).toContain('stooq');
    expect(MarketDataProviders.ids()).toContain('alphavantage');
    MarketDataProviders.register({
      id: 'custom',
      fetchQuotes: async () => [],
    });
    expect(MarketDataProviders.get('custom')).toBeDefined();
  });
});
