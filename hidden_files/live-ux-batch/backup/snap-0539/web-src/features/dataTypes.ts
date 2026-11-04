/**
 * Linked data types (track 15 `linked-data-types`): typed rich cell values
 * backed by provider data with cached snapshots and refresh.
 *
 * Provider model: stock and geography resolution go through a pluggable
 * provider seam (`setStockProvider` / `setGeographyProvider`, mirroring the
 * engine's `setWebFetchProvider` pattern). The DEFAULT providers are live:
 * stocks via Stooq's free quote CSV (no API key) and geography via
 * OpenStreetMap Nominatim (no API key). Both fail gracefully: any network
 * error, timeout, or unparseable response falls back to the bundled sample
 * tables, so the feature works offline exactly as before. Call
 * `useSampleDataTypeProviders()` to pin the sample data (tests, offline
 * kiosks); `resetDataTypeProviders()` restores the live defaults.
 */

export type DataTypeKind = 'stock' | 'geography';

export interface DataTypeField {
  label: string;
  value: string;
}

export interface DataTypeValue {
  kind: DataTypeKind;
  key: string; // symbol or place name
  display: string;
  fields: DataTypeField[];
  refreshedAt: number;
  /** 'live' when resolved from a network provider, 'sample' for bundled data. */
  provenance?: 'live' | 'sample';
}

export interface StockQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePct: number;
  volume: string;
  marketCap: string;
}

const STOCKS: Record<string, StockQuote> = {
  AAPL: { symbol: 'AAPL', name: 'Apple Inc.', price: 232.87, change: 1.24, changePct: 0.54, volume: '58.2M', marketCap: '$3.55T' },
  MSFT: { symbol: 'MSFT', name: 'Microsoft Corp.', price: 428.15, change: -2.31, changePct: -0.54, volume: '21.7M', marketCap: '$3.18T' },
  GOOGL: { symbol: 'GOOGL', name: 'Alphabet Inc.', price: 178.42, change: 0.86, changePct: 0.48, volume: '24.9M', marketCap: '$2.19T' },
  AMZN: { symbol: 'AMZN', name: 'Amazon.com Inc.', price: 197.12, change: 2.05, changePct: 1.05, volume: '38.4M', marketCap: '$2.06T' },
  TSLA: { symbol: 'TSLA', name: 'Tesla Inc.', price: 248.5, change: -5.2, changePct: -2.05, volume: '92.1M', marketCap: '$795B' },
  NVDA: { symbol: 'NVDA', name: 'NVIDIA Corp.', price: 138.25, change: 3.41, changePct: 2.53, volume: '241M', marketCap: '$3.39T' },
  META: { symbol: 'META', name: 'Meta Platforms Inc.', price: 591.7, change: 4.12, changePct: 0.7, volume: '12.8M', marketCap: '$1.49T' },
  NFLX: { symbol: 'NFLX', name: 'Netflix Inc.', price: 762.34, change: -1.88, changePct: -0.25, volume: '3.1M', marketCap: '$328B' },
};

export interface GeoPlace {
  name: string;
  country: string;
  population: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

const PLACES: Record<string, GeoPlace> = {
  'New York': { name: 'New York', country: 'United States', population: '8.3M', latitude: 40.7128, longitude: -74.006, timezone: 'UTC-5' },
  London: { name: 'London', country: 'United Kingdom', population: '8.9M', latitude: 51.5074, longitude: -0.1278, timezone: 'UTC+0' },
  Tokyo: { name: 'Tokyo', country: 'Japan', population: '13.9M', latitude: 35.6762, longitude: 139.6503, timezone: 'UTC+9' },
  Paris: { name: 'Paris', country: 'France', population: '2.1M', latitude: 48.8566, longitude: 2.3522, timezone: 'UTC+1' },
  Sydney: { name: 'Sydney', country: 'Australia', population: '5.3M', latitude: -33.8688, longitude: 151.2093, timezone: 'UTC+10' },
  Mumbai: { name: 'Mumbai', country: 'India', population: '20.7M', latitude: 19.076, longitude: 72.8777, timezone: 'UTC+5:30' },
  'São Paulo': { name: 'São Paulo', country: 'Brazil', population: '12.3M', latitude: -23.5558, longitude: -46.6396, timezone: 'UTC-3' },
  Cairo: { name: 'Cairo', country: 'Egypt', population: '9.5M', latitude: 30.0444, longitude: 31.2357, timezone: 'UTC+2' },
};

export function stockSymbols(): string[] {
  return Object.keys(STOCKS);
}

export function placeNames(): string[] {
  return Object.keys(PLACES);
}

function stockQuoteToValue(q: StockQuote, provenance: 'live' | 'sample'): DataTypeValue {
  const sign = q.change >= 0 ? '+' : '';
  return {
    kind: 'stock',
    key: q.symbol,
    display: q.symbol,
    refreshedAt: Date.now(),
    provenance,
    fields: [
      { label: 'Company', value: q.name },
      { label: 'Price', value: `$${q.price.toFixed(2)}` },
      { label: 'Change', value: `${sign}${q.change.toFixed(2)} (${sign}${q.changePct.toFixed(2)}%)` },
      { label: 'Volume', value: q.volume },
      { label: 'Market Cap', value: q.marketCap },
    ],
  };
}

function geoPlaceToValue(p: GeoPlace, provenance: 'live' | 'sample'): DataTypeValue {
  return {
    kind: 'geography',
    key: p.name,
    display: p.name,
    refreshedAt: Date.now(),
    provenance,
    fields: [
      { label: 'Country', value: p.country },
      { label: 'Population', value: p.population },
      { label: 'Latitude', value: String(p.latitude) },
      { label: 'Longitude', value: String(p.longitude) },
      { label: 'Timezone', value: p.timezone },
    ],
  };
}

/** Resolve a stock symbol to a rich data-type value (sample provider). */
export function resolveStock(symbol: string): DataTypeValue | null {
  const q = STOCKS[symbol.trim().toUpperCase()];
  if (!q) return null;
  return stockQuoteToValue(q, 'sample');
}

/** Resolve a place name to a rich data-type value (sample provider). */
export function resolveGeography(name: string): DataTypeValue | null {
  const p = PLACES[name.trim()];
  if (!p) return null;
  return geoPlaceToValue(p, 'sample');
}

/** Cell key for the data-type map. */
export function dtCellKey(sheet: string, row: number, col: number): string {
  return `${sheet}:${row}:${col}`;
}

/** Extract a single field value from a data-type value (for formulas like =A1.Price). */
export function dataTypeField(value: DataTypeValue, fieldLabel: string): string | null {
  const f = value.fields.find((x) => x.label.toLowerCase() === fieldLabel.toLowerCase());
  return f ? f.value : null;
}

// ---------------------------------------------------------------------------
// Provider seam — live data with graceful offline fallback
// ---------------------------------------------------------------------------

/** A stock quote provider: symbol -> quote, or null when unknown/unreachable. */
export interface StockQuoteProvider {
  readonly id: string;
  resolveStock(symbol: string): Promise<StockQuote | null>;
}

/** A geography provider: place name -> place, or null when unknown/unreachable. */
export interface GeographyProvider {
  readonly id: string;
  resolveGeography(name: string): Promise<GeoPlace | null>;
}

export interface LiveProviderDeps {
  /** Injectable fetch (tests); defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Defaults to 8000ms. */
  timeoutMs?: number;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<string> {
  const res = await fetchWithTimeout(fetchImpl, url, timeoutMs, { headers: { Accept: 'text/csv' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fetchJson(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetchWithTimeout(fetchImpl, url, timeoutMs, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function formatVolume(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

interface StooqBar { date: string; close: number; volume: number; }

function parseStooqDailyCsv(csv: string): StooqBar[] {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bars: StooqBar[] = [];
  for (const line of lines.slice(1)) {
    const [date, , , , close, volume] = line.split(',');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (close === 'N/D') continue;
    const c = parseFloat(close ?? '');
    if (!Number.isFinite(c)) continue;
    bars.push({ date, close: c, volume: parseFloat(volume ?? '') || 0 });
  }
  return bars;
}

/**
 * Live stock provider via Stooq's free daily CSV (no API key).
 * Change is computed from the last two closes; company name comes from the
 * bundled table when the symbol is known, otherwise the symbol itself.
 */
export function createStooqStockProvider(deps: LiveProviderDeps = {}): StockQuoteProvider {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = deps.timeoutMs ?? 8000;
  return {
    id: 'stooq',
    async resolveStock(symbol: string): Promise<StockQuote | null> {
      const sym = symbol.trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9.\-^]*$/.test(sym)) return null;
      const end = new Date();
      const start = new Date(end.getTime() - 14 * 86400_000);
      const iso = (d: Date): string => d.toISOString().slice(0, 10).replace(/-/g, '');
      const url =
        `https://stooq.com/q/d/l/?s=${encodeURIComponent(sym.toLowerCase())}.us` +
        `&d1=${iso(start)}&d2=${iso(end)}&i=d`;
      const csv = await fetchText(fetchImpl, url, timeoutMs);
      const bars = parseStooqDailyCsv(csv);
      if (bars.length === 0) return null;
      const last = bars[bars.length - 1];
      const prev = bars.length > 1 ? bars[bars.length - 2] : null;
      const change = prev ? last.close - prev.close : 0;
      const changePct = prev && prev.close !== 0 ? (change / prev.close) * 100 : 0;
      const known = STOCKS[sym];
      return {
        symbol: sym,
        name: known?.name ?? sym,
        price: last.close,
        change,
        changePct,
        volume: formatVolume(last.volume),
        marketCap: known?.marketCap ?? '—',
      };
    },
  };
}

interface NominatimResult {
  name?: string;
  lat: string;
  lon: string;
  display_name: string;
  address?: { country?: string };
}

/**
 * Live geography provider via OpenStreetMap Nominatim (no API key).
 * Population/timezone come from the bundled table when the place is known;
 * otherwise they are reported as '—' rather than invented.
 */
export function createNominatimGeographyProvider(deps: LiveProviderDeps = {}): GeographyProvider {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = deps.timeoutMs ?? 8000;
  return {
    id: 'nominatim',
    async resolveGeography(name: string): Promise<GeoPlace | null> {
      const q = name.trim();
      if (!q) return null;
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&q=${encodeURIComponent(q)}`;
      const json = await fetchJson(fetchImpl, url, timeoutMs);
      if (!Array.isArray(json) || json.length === 0) return null;
      const r = json[0] as NominatimResult;
      const lat = parseFloat(r.lat);
      const lon = parseFloat(r.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const known = PLACES[q] ?? PLACES[r.name ?? ''];
      const display = r.name ?? r.display_name.split(',')[0].trim() ?? q;
      return {
        name: display,
        country: r.address?.country ?? known?.country ?? '—',
        population: known?.population ?? '—',
        latitude: lat,
        longitude: lon,
        timezone: known?.timezone ?? '—',
      };
    },
  };
}

/** Sample-data providers (offline baseline; also the graceful fallback). */
export const sampleStockProvider: StockQuoteProvider = {
  id: 'sample',
  resolveStock: async (symbol: string) => STOCKS[symbol.trim().toUpperCase()] ?? null,
};

export const sampleGeographyProvider: GeographyProvider = {
  id: 'sample',
  resolveGeography: async (name: string) => PLACES[name.trim()] ?? null,
};

let stockProvider: StockQuoteProvider = createStooqStockProvider();
let geographyProvider: GeographyProvider = createNominatimGeographyProvider();

/** Swap the stock provider (custom deployments, tests). Pass null to use sample data. */
export function setStockProvider(p: StockQuoteProvider | null): void {
  stockProvider = p ?? sampleStockProvider;
}

/** Swap the geography provider (custom deployments, tests). Pass null to use sample data. */
export function setGeographyProvider(p: GeographyProvider | null): void {
  geographyProvider = p ?? sampleGeographyProvider;
}

/** Restore the live defaults (Stooq + Nominatim). */
export function resetDataTypeProviders(): void {
  stockProvider = createStooqStockProvider();
  geographyProvider = createNominatimGeographyProvider();
}

/** Pin the bundled sample data (offline kiosks, deterministic tests). */
export function useSampleDataTypeProviders(): void {
  stockProvider = sampleStockProvider;
  geographyProvider = sampleGeographyProvider;
}

export function stockProviderId(): string {
  return stockProvider.id;
}

export function geographyProviderId(): string {
  return geographyProvider.id;
}

/**
 * Resolve a stock symbol through the configured provider.
 * Any failure (offline, timeout, bad response, unknown symbol) falls back
 * to the bundled sample table, so this never rejects.
 */
export async function resolveStockLive(symbol: string): Promise<DataTypeValue | null> {
  try {
    const q = await stockProvider.resolveStock(symbol);
    if (q) return stockQuoteToValue(q, stockProvider.id === 'sample' ? 'sample' : 'live');
  } catch {
    // Graceful offline: fall through to the sample table.
  }
  return resolveStock(symbol);
}

/**
 * Resolve a place name through the configured provider, with the same
 * graceful offline fallback as resolveStockLive.
 */
export async function resolveGeographyLive(name: string): Promise<DataTypeValue | null> {
  try {
    const p = await geographyProvider.resolveGeography(name);
    if (p) return geoPlaceToValue(p, geographyProvider.id === 'sample' ? 'sample' : 'live');
  } catch {
    // Graceful offline: fall through to the sample table.
  }
  return resolveGeography(name);
}
