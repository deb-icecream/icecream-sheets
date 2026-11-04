/**
 * marketdata connector — historical OHLCV quotes as a typed table.
 *
 * Params:
 * - symbol (required): ticker, e.g. "AAPL" (".us" is assumed for bare
 *   US tickers; pass "AAPL.US" explicitly if you prefer).
 * - start / end (optional): YYYY-MM-DD bounds. Default: last 90 days.
 * - interval (optional): 'd' (default) | 'w' | 'm'.
 * - provider (optional): 'stooq' (default, free, no key) | 'alphavantage'.
 *
 * Providers are pluggable: register more via MarketDataProviders.register().
 * 'alphavantage' needs an API key — pass credentialRef on the spec and the
 * resolver's secret is sent as the `apikey` query parameter (transient —
 * never persisted, never logged). Without a wired resolver and a
 * credentialRef present, fetch fails closed.
 *
 * This is the connector behind STOCKHISTORY (packages/engine): hosts fetch
 * through here and publish the bars into the engine via
 * publishMarketHistory() (see marketTableToBars() in the engine's
 * extended-functions11 for the TableData -> MarketBar conversion).
 */
import type { ConnectorKind, ConnectorSpec } from './spec.js';
import { makeTableData, type TableCell, type TableData } from './table.js';
import type { Connector, ResolvedConnectorDeps } from './registry.js';

export type MarketDataInterval = 'd' | 'w' | 'm';

export interface QuoteBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** A market-data provider: symbol+range -> bars. */
export interface MarketDataQuoteProvider {
  readonly id: string;
  fetchQuotes(
    symbol: string,
    start: string,
    end: string,
    interval: MarketDataInterval,
    deps: ResolvedConnectorDeps,
    apiKey: string | null,
  ): Promise<QuoteBar[]>;
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultRange(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end.getTime() - 90 * 86400 * 1000);
  return { start: toIso(start), end: toIso(end) };
}

function parseInterval(raw: string | undefined): MarketDataInterval {
  const t = (raw ?? 'd').trim().toLowerCase();
  if (t === 'w' || t === 'weekly') return 'w';
  if (t === 'm' || t === 'monthly') return 'm';
  return 'd';
}

function stooqSymbol(symbol: string): string {
  const s = symbol.trim().toLowerCase();
  return s.includes('.') ? s : `${s}.us`;
}

/** Parse a Stooq daily CSV (Date,Open,High,Low,Close,Volume). */
export function parseStooqCsv(csv: string): QuoteBar[] {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bars: QuoteBar[] = [];
  for (const line of lines.slice(1)) {
    const [date, open, high, low, close, volume] = line.split(',');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (open === 'N/D' || close === 'N/D') continue; // Stooq marks gaps as N/D
    const num = (v: string | undefined): number => {
      const n = parseFloat(v ?? '');
      return Number.isFinite(n) ? n : 0;
    };
    bars.push({
      date,
      open: num(open),
      high: num(high),
      low: num(low),
      close: num(close),
      volume: num(volume),
    });
  }
  return bars;
}

const stooqProvider: MarketDataQuoteProvider = {
  id: 'stooq',
  async fetchQuotes(symbol, start, end, interval, deps): Promise<QuoteBar[]> {
    const d1 = start.replace(/-/g, '');
    const d2 = end.replace(/-/g, '');
    const url =
      `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol(symbol))}` +
      `&d1=${d1}&d2=${d2}&i=${interval}`;
    const text = await deps.fetchText(url);
    return parseStooqCsv(text).filter((b) => b.date >= start && b.date <= end);
  },
};

/** Parse an Alpha Vantage TIME_SERIES_DAILY(_ADJUSTED) JSON payload. */
export function parseAlphaVantageJson(doc: unknown): QuoteBar[] {
  if (typeof doc !== 'object' || doc === null) throw new Error('not a JSON object');
  const rec = doc as Record<string, unknown>;
  const series = rec['Time Series (Daily)'] ?? rec['Time Series (Daily Adjusted)'];
  if (typeof series !== 'object' || series === null) {
    const note = typeof rec['Note'] === 'string' ? ` (${rec['Note']})` : '';
    const err = typeof rec['Error Message'] === 'string' ? `: ${rec['Error Message']}` : '';
    throw new Error(`no daily time series in response${note}${err}`);
  }
  const bars: QuoteBar[] = [];
  for (const [date, raw] of Object.entries(series as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const num = (k: string): number => {
      const n = parseFloat(String(r[k] ?? ''));
      return Number.isFinite(n) ? n : 0;
    };
    bars.push({
      date,
      open: num('1. open'),
      high: num('2. high'),
      low: num('3. low'),
      close: num('4. close'),
      volume: num('6. volume') || num('5. volume'),
    });
  }
  bars.sort((a, b) => (a.date < b.date ? -1 : 1));
  return bars;
}

const alphaVantageProvider: MarketDataQuoteProvider = {
  id: 'alphavantage',
  async fetchQuotes(symbol, start, end, interval, deps, apiKey): Promise<QuoteBar[]> {
    if (!apiKey) {
      throw new Error(
        'alphavantage needs an API key: put a credentialRef on the spec and wire a CredentialResolver',
      );
    }
    const fn =
      interval === 'd' ? 'TIME_SERIES_DAILY_ADJUSTED' : interval === 'w' ? 'TIME_SERIES_WEEKLY' : 'TIME_SERIES_MONTHLY';
    const url =
      `https://www.alphavantage.co/query?function=${fn}` +
      `&symbol=${encodeURIComponent(symbol.trim().toUpperCase())}` +
      `&apikey=${encodeURIComponent(apiKey)}&outputsize=full&datatype=json`;
    const text = await deps.fetchText(url);
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new Error('alphavantage response is not valid JSON');
    }
    return parseAlphaVantageJson(doc).filter((b) => b.date >= start && b.date <= end);
  },
};

/** Pluggable provider registry (tests / hosts register more). */
export const MarketDataProviders = {
  _providers: new Map<string, MarketDataQuoteProvider>([
    ['stooq', stooqProvider],
    ['alphavantage', alphaVantageProvider],
  ]),
  register(p: MarketDataQuoteProvider): void {
    this._providers.set(p.id.toLowerCase(), p);
  },
  get(id: string): MarketDataQuoteProvider | undefined {
    return this._providers.get(id.toLowerCase());
  },
  ids(): string[] {
    return [...this._providers.keys()];
  },
};

export class MarketDataConnector implements Connector {
  readonly kind: ConnectorKind = 'marketdata';
  readonly displayName = 'Market data (OHLCV)';
  readonly paramHelp =
    'symbol: ticker (required). start/end: YYYY-MM-DD (optional, default last 90d). ' +
    'interval: d|w|m (default d). provider: stooq (default, free) | alphavantage (needs credentialRef API key).';

  async fetch(spec: ConnectorSpec, deps: ResolvedConnectorDeps): Promise<TableData> {
    const symbol = (spec.params['symbol'] ?? '').trim();
    if (symbol === '') throw new Error('param "symbol" is required');
    const range = defaultRange();
    const start = (spec.params['start'] ?? '').trim() || range.start;
    const end = (spec.params['end'] ?? '').trim() || range.end;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      throw new Error('params "start"/"end" must be YYYY-MM-DD');
    }
    if (start > end) throw new Error('param "start" must not be after "end"');
    const interval = parseInterval(spec.params['interval']);
    const providerId = ((spec.params['provider'] ?? 'stooq').trim() || 'stooq').toLowerCase();
    const provider = MarketDataProviders.get(providerId);
    if (!provider) {
      throw new Error(
        `unknown market-data provider "${providerId}" (known: ${MarketDataProviders.ids().join(', ')})`,
      );
    }
    let apiKey: string | null = null;
    if (spec.credentialRef) {
      if (!deps.resolveCredential) {
        throw new Error(
          `spec needs credential "${spec.credentialRef}" but no credential resolver is wired`,
        );
      }
      apiKey = await deps.resolveCredential.resolveCredential(spec.credentialRef);
    }
    const bars = await provider.fetchQuotes(symbol, start, end, interval, deps, apiKey);
    const columns = ['Date', 'Open', 'High', 'Low', 'Close', 'Volume'];
    const rows: TableCell[][] = bars.map((b) => [b.date, b.open, b.high, b.low, b.close, b.volume]);
    return makeTableData(columns, rows);
  }
}
