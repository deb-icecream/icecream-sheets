/**
 * Geocoding adapters for 3D Maps (track 17 `three-d-maps`).
 *
 * Provider seam (mirrors the dataTypes.ts provider pattern):
 *   - `GeocodeProvider` — forward (name/address -> lat/lon) and reverse
 *     (lat/lon -> name). Pluggable via the `GeocodeService` constructor or the
 *     module-level `setGeocodeProvider` / `useBundledGeocodeProvider` /
 *     `resetGeocodeProviders` helpers.
 *   - The default live provider is OpenStreetMap Nominatim (free, no API key).
 *     It identifies with a User-Agent per the Nominatim usage policy (browsers
 *     strip the header and send the page Referer instead, which also satisfies
 *     the policy), and it self-throttles to at most one request per
 *     `minIntervalMs` (default 1100ms) to stay within the 1 req/s limit.
 *   - Every lookup goes through `GeocodeService`, which layers an in-memory +
 *     localStorage result cache over the live provider and falls back to the
 *     bundled coordinate table when the network is unreachable. Bundled
 *     results are clearly marked `provenance: 'bundled'`; a place the bundled
 *     table does not know returns null — never a silent wrong answer.
 *
 * Tests inject `fetchImpl`; the real API is never hit in tests.
 */

import type { LatLong } from './globe';

/** A resolved place: coordinates plus where they came from. */
export interface GeocodeResult {
  /** Display name (provider's best label for the place). */
  name: string;
  lat: number;
  lon: number;
  /**
   * 'live' — resolved over the network. 'bundled' — served from the bundled
   * sample table because the network was unavailable. Bundled results are
   * always shown with an explicit offline indication in the UI.
   */
  provenance: 'live' | 'bundled';
}

/** Pluggable geocode provider seam: forward + reverse geocoding. */
export interface GeocodeProvider {
  readonly id: string;
  readonly displayName: string;
  /** Name/address -> coordinates, or null when unknown. */
  forward(name: string): Promise<GeocodeResult | null>;
  /** Coordinates -> best place name, or null when unknown. */
  reverse(lat: number, lon: number): Promise<string | null>;
}

export interface GeocodeDeps {
  /** Injectable fetch (tests); defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Defaults to 8000ms. */
  timeoutMs?: number;
  /**
   * Minimum gap between request starts (Nominatim policy: max 1 req/s).
   * Defaults to 1100ms.
   */
  minIntervalMs?: number;
  /**
   * User-Agent identifying the application (Nominatim usage policy).
   * Browsers forbid setting User-Agent via fetch — the header is silently
   * dropped there and the page Referer is sent instead. Defaults to
   * 'icecream-sheets/1.0'.
   */
  userAgent?: string;
  now?: () => number;
}

/** HTTP error with a status code, so callers can classify failures. */
export class GeocodeHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GeocodeHttpError';
    this.status = status;
  }
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

interface NominatimSearchHit {
  name?: string;
  lat: string;
  lon: string;
  display_name: string;
}

/**
 * Live geocode provider via OpenStreetMap Nominatim (no API key).
 * Self-throttles to respect the 1 request/second usage policy; concurrent
 * callers are serialized through the same throttle.
 */
export function createNominatimGeocodeProvider(deps: GeocodeDeps = {}): GeocodeProvider {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = deps.timeoutMs ?? 8000;
  const minIntervalMs = deps.minIntervalMs ?? 1100;
  const userAgent = deps.userAgent ?? 'icecream-sheets/1.0';
  const now = deps.now ?? Date.now;

  // Serialized throttle: at most one request starts per minIntervalMs.
  let chain: Promise<unknown> = Promise.resolve();
  let lastStart = 0;
  const throttle = <T>(fn: () => Promise<T>): Promise<T> => {
    const run: Promise<T> = chain.then(async () => {
      const wait = Math.max(0, lastStart + minIntervalMs - now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastStart = now();
      return fn();
    });
    chain = run.catch(() => undefined);
    return run;
  };

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (userAgent) headers['User-Agent'] = userAgent;

  async function getJson(url: string): Promise<unknown> {
    const res = await fetchWithTimeout(fetchImpl, url, timeoutMs, { headers });
    if (!res.ok) throw new GeocodeHttpError(res.status, `Nominatim HTTP ${res.status}`);
    return res.json();
  }

  return {
    id: 'nominatim',
    displayName: 'OpenStreetMap Nominatim',
    forward: (name: string): Promise<GeocodeResult | null> =>
      throttle(async () => {
        const q = name.trim();
        if (!q) return null;
        const url =
          `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1` +
          `&q=${encodeURIComponent(q)}`;
        const json = await getJson(url);
        if (!Array.isArray(json) || json.length === 0) return null;
        const hit = json[0] as NominatimSearchHit;
        const lat = parseFloat(hit.lat);
        const lon = parseFloat(hit.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
        return {
          name: (hit.display_name ?? '').split(',')[0].trim() || q,
          lat,
          lon,
          provenance: 'live',
        };
      }),
    reverse: (lat: number, lon: number): Promise<string | null> =>
      throttle(async () => {
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
        const url =
          `https://nominatim.openstreetmap.org/reverse?format=jsonv2` +
          `&lat=${lat}&lon=${lon}`;
        const json = await getJson(url);
        if (!json || typeof json !== 'object') return null;
        const display = (json as { display_name?: string }).display_name;
        return typeof display === 'string' && display.trim() !== '' ? display : null;
      }),
  };
}

/* ------------------------------------------------------------------ */
/* Bundled sample coordinate table (offline fallback).                  */
/* ------------------------------------------------------------------ */

/** Well-known major cities; used only when the network is unreachable. */
const BUNDLED_PLACES: { name: string; lat: number; lon: number }[] = [
  { name: 'New York', lat: 40.7128, lon: -74.006 },
  { name: 'Los Angeles', lat: 34.0522, lon: -118.2437 },
  { name: 'Chicago', lat: 41.8781, lon: -87.6298 },
  { name: 'San Francisco', lat: 37.7749, lon: -122.4194 },
  { name: 'Boston', lat: 42.3601, lon: -71.0589 },
  { name: 'Seattle', lat: 47.6062, lon: -122.3321 },
  { name: 'Washington DC', lat: 38.9072, lon: -77.0369 },
  { name: 'Miami', lat: 25.7617, lon: -80.1918 },
  { name: 'Toronto', lat: 43.6532, lon: -79.3832 },
  { name: 'Vancouver', lat: 49.2827, lon: -123.1207 },
  { name: 'Mexico City', lat: 19.4326, lon: -99.1332 },
  { name: 'São Paulo', lat: -23.5558, lon: -46.6396 },
  { name: 'Rio de Janeiro', lat: -22.9068, lon: -43.1729 },
  { name: 'Buenos Aires', lat: -34.6037, lon: -58.3816 },
  { name: 'Bogotá', lat: 4.711, lon: -74.0721 },
  { name: 'Lima', lat: -12.0464, lon: -77.0428 },
  { name: 'Santiago', lat: -33.4489, lon: -70.6693 },
  { name: 'London', lat: 51.5074, lon: -0.1278 },
  { name: 'Paris', lat: 48.8566, lon: 2.3522 },
  { name: 'Berlin', lat: 52.52, lon: 13.405 },
  { name: 'Madrid', lat: 40.4168, lon: -3.7038 },
  { name: 'Rome', lat: 41.9028, lon: 12.4964 },
  { name: 'Amsterdam', lat: 52.3676, lon: 4.9041 },
  { name: 'Moscow', lat: 55.7558, lon: 37.6173 },
  { name: 'Dublin', lat: 53.3498, lon: -6.2603 },
  { name: 'Stockholm', lat: 59.3293, lon: 18.0686 },
  { name: 'Zurich', lat: 47.3769, lon: 8.5417 },
  { name: 'Vienna', lat: 48.2082, lon: 16.3738 },
  { name: 'Warsaw', lat: 52.2297, lon: 21.0122 },
  { name: 'Athens', lat: 37.9838, lon: 23.7275 },
  { name: 'Lisbon', lat: 38.7223, lon: -9.1393 },
  { name: 'Reykjavik', lat: 64.1466, lon: -21.9426 },
  { name: 'Tokyo', lat: 35.6762, lon: 139.6503 },
  { name: 'Beijing', lat: 39.9042, lon: 116.4074 },
  { name: 'Shanghai', lat: 31.2304, lon: 121.4737 },
  { name: 'Delhi', lat: 28.6139, lon: 77.209 },
  { name: 'Mumbai', lat: 19.076, lon: 72.8777 },
  { name: 'Singapore', lat: 1.3521, lon: 103.8198 },
  { name: 'Seoul', lat: 37.5665, lon: 126.978 },
  { name: 'Hong Kong', lat: 22.3193, lon: 114.1694 },
  { name: 'Bangkok', lat: 13.7563, lon: 100.5018 },
  { name: 'Jakarta', lat: -6.2088, lon: 106.8456 },
  { name: 'Dubai', lat: 25.2048, lon: 55.2708 },
  { name: 'Istanbul', lat: 41.0082, lon: 28.9784 },
  { name: 'Cairo', lat: 30.0444, lon: 31.2357 },
  { name: 'Lagos', lat: 6.5244, lon: 3.3792 },
  { name: 'Nairobi', lat: -1.2921, lon: 36.8219 },
  { name: 'Johannesburg', lat: -26.2041, lon: 28.0473 },
  { name: 'Sydney', lat: -33.8688, lon: 151.2093 },
  { name: 'Melbourne', lat: -37.8136, lon: 144.9631 },
  { name: 'Auckland', lat: -36.8485, lon: 174.7633 },
];

/** Common short aliases that map to bundled entries. */
const BUNDLED_ALIASES: Record<string, string> = {
  nyc: 'New York',
  'new york city': 'New York',
  sf: 'San Francisco',
  la: 'Los Angeles',
  dc: 'Washington DC',
  washington: 'Washington DC',
  rio: 'Rio de Janeiro',
  'hongkong': 'Hong Kong',
  'hong kong sar': 'Hong Kong',
  saopaulo: 'São Paulo',
  'sao paulo': 'São Paulo',
  bogota: 'Bogotá',
};

/** Normalize a place query for table lookup: case/diacritic/whitespace insensitive. */
export function normalizePlaceQuery(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks
    .replace(/\s+/g, ' ');
}

const BUNDLED_INDEX: Map<string, { name: string; lat: number; lon: number }> = (() => {
  const m = new Map<string, { name: string; lat: number; lon: number }>();
  for (const p of BUNDLED_PLACES) m.set(normalizePlaceQuery(p.name), p);
  for (const [alias, target] of Object.entries(BUNDLED_ALIASES)) {
    const hit = m.get(normalizePlaceQuery(target));
    if (hit) m.set(normalizePlaceQuery(alias), hit);
  }
  return m;
})();

/** Names of all bundled places (for UI hints / tests). */
export function bundledPlaceNames(): string[] {
  return BUNDLED_PLACES.map((p) => p.name);
}

/**
 * Offline sample provider: the bundled table only. Results are marked
 * `provenance: 'bundled'`. Unknown names return null — never a guess.
 */
export const bundledCoordinateProvider: GeocodeProvider = {
  id: 'bundled',
  displayName: 'Bundled sample coordinates (offline)',
  forward: async (name: string): Promise<GeocodeResult | null> => {
    const hit = BUNDLED_INDEX.get(normalizePlaceQuery(name));
    if (!hit) return null;
    return { name: hit.name, lat: hit.lat, lon: hit.lon, provenance: 'bundled' };
  },
  reverse: async (lat: number, lon: number): Promise<string | null> => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    let best: { name: string; lat: number; lon: number } | null = null;
    let bestDist = 2; // degrees — beyond this, refuse to guess
    for (const p of BUNDLED_PLACES) {
      const d = Math.hypot(p.lat - lat, p.lon - lon);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    return best?.name ?? null;
  },
};

/* ------------------------------------------------------------------ */
/* Result cache (in-memory + optional localStorage persistence).       */
/* ------------------------------------------------------------------ */

export interface GeocodeCacheOptions {
  /** Persist entries in localStorage across sessions. Defaults to true. */
  persist?: boolean;
  /** localStorage key. Defaults to 'icecream.geocodeCache.v1'. */
  storageKey?: string;
  /** Entry TTL. Defaults to 30 days. */
  ttlMs?: number;
  now?: () => number;
  /**
   * Storage override (tests, non-browser runtimes). Pass null to disable
   * persistence even when localStorage exists.
   */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
}

interface CacheEntry {
  result: GeocodeResult | null;
  ts: number;
}

/**
 * Query-result cache. Keys are normalized queries; both hits and definitive
 * misses (null) are cached so the same query never re-hits the API.
 */
export class GeocodeCache {
  private readonly mem = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly storageKey: string;
  private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  private readonly now: () => number;
  private loadedPersisted = false;
  /**
   * Batch-geocoding thousands of names calls set() once per unique name;
   * re-serializing the whole map to localStorage on every set is O(n^2) and
   * blocks the main thread. Persistence is therefore throttled: a synchronous
   * save happens at most every SAVE_EVERY_SETS sets, plus an explicit flush()
   * (e.g. after a batch completes). The cache is best-effort — losing the last
   * few entries on a tab crash costs only re-resolution.
   */
  private static readonly SAVE_EVERY_SETS = 25;
  private dirty = false;
  private setsSinceSave = 0;

  constructor(opts: GeocodeCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 30 * 86400_000;
    this.storageKey = opts.storageKey ?? 'icecream.geocodeCache.v1';
    this.now = opts.now ?? Date.now;
    if (opts.storage !== undefined) {
      this.storage = opts.storage;
    } else if (opts.persist === false) {
      this.storage = null;
    } else {
      try {
        this.storage =
          typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null;
      } catch {
        this.storage = null;
      }
    }
  }

  private ensureLoaded(): void {
    if (this.loadedPersisted || !this.storage) return;
    this.loadedPersisted = true;
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, CacheEntry>;
      const t = this.now();
      for (const [k, e] of Object.entries(parsed)) {
        if (e && typeof e.ts === 'number' && t - e.ts < this.ttlMs) this.mem.set(k, e);
      }
    } catch {
      // Corrupt cache: start clean.
    }
  }

  private save(): void {
    if (!this.storage || !this.dirty) return;
    try {
      const obj: Record<string, CacheEntry> = {};
      for (const [k, e] of this.mem) obj[k] = e;
      this.storage.setItem(this.storageKey, JSON.stringify(obj));
      this.dirty = false;
    } catch {
      // Quota or privacy mode: caching degrades to in-memory only.
    }
  }

  /**
   * Persist any pending entries now. Called automatically every
   * SAVE_EVERY_SETS sets; call explicitly after a batch of sets to avoid
   * losing the tail of the batch.
   */
  flush(): void {
    this.ensureLoaded();
    this.save();
  }

  /** undefined = cache miss; null = cached definitive miss. */
  get(query: string): GeocodeResult | null | undefined {
    this.ensureLoaded();
    const e = this.mem.get(normalizePlaceQuery(query));
    if (!e) return undefined;
    if (this.now() - e.ts >= this.ttlMs) {
      this.mem.delete(normalizePlaceQuery(query));
      return undefined;
    }
    return e.result;
  }

  set(query: string, result: GeocodeResult | null): void {
    this.ensureLoaded();
    this.mem.set(normalizePlaceQuery(query), { result, ts: this.now() });
    this.dirty = true;
    this.setsSinceSave += 1;
    // Always persist the first set synchronously (single-lookup callers and
    // tests read it back immediately); throttle the rest during batches.
    // The counter is never reset by save() — only by clear() — so batch
    // saves land on sets 1, 25, 50, ... instead of every set.
    if (this.setsSinceSave === 1 || this.setsSinceSave % GeocodeCache.SAVE_EVERY_SETS === 0) {
      this.save();
    }
  }

  clear(): void {
    this.mem.clear();
    this.dirty = false;
    this.setsSinceSave = 0;
    if (this.storage) {
      try {
        this.storage.removeItem(this.storageKey);
      } catch {
        /* ignore */
      }
    }
  }

  get size(): number {
    this.ensureLoaded();
    return this.mem.size;
  }
}

/* ------------------------------------------------------------------ */
/* GeocodeService: cache -> live -> bundled fallback composition.      */
/* ------------------------------------------------------------------ */

export interface GeocodeServiceOptions {
  live?: GeocodeProvider;
  fallback?: GeocodeProvider;
  cache?: GeocodeCache;
  /** How long to skip the live provider after a network failure (default 60s). */
  offlineCooldownMs?: number;
  now?: () => number;
}

/** Network-level failures: fetch threw, timed out, or the server errored. */
export function isNetworkFailure(err: unknown): boolean {
  if (err instanceof GeocodeHttpError) return err.status === 429 || err.status >= 500;
  if (err instanceof Error) {
    // fetch() rejects with TypeError on network failure; AbortError on timeout.
    return err.name === 'AbortError' || err instanceof TypeError;
  }
  return false;
}

/**
 * The composition used by 3D Maps: cache -> live provider -> bundled
 * offline fallback. After a network failure the live provider is skipped for
 * `offlineCooldownMs` so offline use stays snappy.
 */
export class GeocodeService implements GeocodeProvider {
  readonly id = 'geocode-service';
  readonly displayName = 'Geocode service (cache + live + offline fallback)';
  private live: GeocodeProvider | null;
  private readonly fallback: GeocodeProvider;
  private readonly cache: GeocodeCache;
  private readonly offlineCooldownMs: number;
  private readonly now: () => number;
  private offlineSince: number | null = null;
  /** In-flight forward() calls, deduped by normalized query. */
  private readonly inflight = new Map<string, Promise<GeocodeResult | null>>();

  constructor(opts: GeocodeServiceOptions = {}) {
    this.live = opts.live ?? createNominatimGeocodeProvider();
    this.fallback = opts.fallback ?? bundledCoordinateProvider;
    this.cache = opts.cache ?? new GeocodeCache();
    this.offlineCooldownMs = opts.offlineCooldownMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  get liveProviderId(): string {
    return this.live?.id ?? 'none';
  }

  /** Swap the live provider (custom deployments, tests). Null = bundled only. */
  setLiveProvider(p: GeocodeProvider | null): void {
    this.live = p;
    this.offlineSince = null;
  }

  /** True when the last live attempt failed with a network failure and the cooldown has not elapsed. */
  isOffline(): boolean {
    return (
      this.offlineSince !== null && this.now() - this.offlineSince < this.offlineCooldownMs
    );
  }

  clearCache(): void {
    this.cache.clear();
  }

  /** Persist any cache entries still waiting on the throttled write path. */
  flushCache(): void {
    this.cache.flush();
  }

  forward(name: string): Promise<GeocodeResult | null> {
    const key = normalizePlaceQuery(name);
    if (!key) return Promise.resolve(null);
    const cached = this.cache.get(name);
    if (cached !== undefined) return Promise.resolve(cached);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = this.resolveForward(name, key).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }

  private async resolveForward(name: string, key: string): Promise<GeocodeResult | null> {
    if (this.live && !this.isOffline()) {
      try {
        const r = await this.live.forward(name);
        this.offlineSince = null;
        this.cache.set(key, r);
        return r;
      } catch (err) {
        if (!isNetworkFailure(err)) {
          // Definitive lookup failure (e.g. HTTP 400): no fallback guessing.
          this.cache.set(key, null);
          return null;
        }
        this.offlineSince = this.now();
        // Fall through to the bundled table below.
      }
    }
    const fb = await this.fallback.forward(name);
    this.cache.set(key, fb);
    return fb;
  }

  async reverse(lat: number, lon: number): Promise<string | null> {
    if (this.live && !this.isOffline()) {
      try {
        const r = await this.live.reverse(lat, lon);
        this.offlineSince = null;
        return r;
      } catch (err) {
        if (!isNetworkFailure(err)) return null;
        this.offlineSince = this.now();
      }
    }
    return this.fallback.reverse(lat, lon);
  }
}

/* ------------------------------------------------------------------ */
/* Module-level default service (mirrors dataTypes.ts provider seam).  */
/* ------------------------------------------------------------------ */

let defaultService: GeocodeService | null = null;

/** The shared service used by the 3D Maps UI. */
export function getGeocodeService(): GeocodeService {
  if (!defaultService) defaultService = new GeocodeService();
  return defaultService;
}

/** Swap the live provider on the default service (custom deployments, tests). Null = bundled only. */
export function setGeocodeProvider(p: GeocodeProvider | null): void {
  getGeocodeService().setLiveProvider(p);
}

/** Pin the bundled sample data (offline kiosks, deterministic tests). */
export function useBundledGeocodeProvider(): void {
  getGeocodeService().setLiveProvider(null);
}

/** Restore the live default (Nominatim). */
export function resetGeocodeProviders(): void {
  getGeocodeService().setLiveProvider(createNominatimGeocodeProvider());
}

export function geocodeProviderId(): string {
  return getGeocodeService().liveProviderId;
}

/* ------------------------------------------------------------------ */
/* Batch geocoding for a column of location names.                     */
/* ------------------------------------------------------------------ */

export interface BatchGeocodeItem {
  query: string;
  result: GeocodeResult | null;
}

export interface GeocodeBatchOptions {
  /** Called after each unique name resolves: (done, total). */
  onProgress?: (done: number, total: number) => void;
  /**
   * Minimum gap between onProgress callbacks (default 150ms). Batch-
   * geocoding thousands of names would otherwise trigger a React re-render
   * per name. The final callback always fires.
   */
  progressIntervalMs?: number;
  /**
   * Yield to the event loop (zero-delay macrotask) every this many items
   * (default 50). Awaiting a resolved promise only schedules a microtask,
   * which never lets the browser render, paint progress, or service input —
   * a 30k-name batch would otherwise wedge the tab until the whole loop
   * finishes.
   */
  yieldEvery?: number;
  now?: () => number;
}

/**
 * Geocode a column of location names. Duplicate names are resolved once and
 * shared; the live provider's own throttle keeps batch requests within the
 * provider's rate limit. Results are in first-seen order of unique names.
 */
export async function geocodeBatch(
  service: GeocodeService,
  names: string[],
  opts: GeocodeBatchOptions = {},
): Promise<BatchGeocodeItem[]> {
  const seen = new Map<string, string>(); // normalized -> original first spelling
  for (const n of names) {
    const key = normalizePlaceQuery(n);
    if (!key || seen.has(key)) continue;
    seen.set(key, n.trim());
  }
  const unique = [...seen.values()];
  const out: BatchGeocodeItem[] = [];
  const onProgress = opts.onProgress;
  const progressIntervalMs = opts.progressIntervalMs ?? 150;
  const yieldEvery = opts.yieldEvery ?? 50;
  const now = opts.now ?? Date.now;
  let lastProgress = 0;
  const report = (done: number, total: number): void => {
    if (!onProgress) return;
    const t = now();
    if (done >= total || t - lastProgress >= progressIntervalMs) {
      lastProgress = t;
      onProgress(done, total);
    }
  };
  for (let i = 0; i < unique.length; i++) {
    const query = unique[i];
    const result = await service.forward(query);
    out.push({ query, result });
    report(i + 1, unique.length);
    // Yield to the event loop periodically (see yieldEvery above).
    if (yieldEvery > 0 && (i + 1) % yieldEvery === 0 && i + 1 < unique.length) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  // Persist the tail of the throttled cache-write path.
  service.flushCache();
  return out;
}

/**
 * Map successful batch results to globe points. The label is the provider's
 * display name; an optional per-query value (e.g. a size-by column) can be
 * attached via `values`.
 */
export function geocodedToLatLong(
  items: BatchGeocodeItem[],
  values?: Map<string, number>,
): LatLong[] {
  const out: LatLong[] = [];
  for (const item of items) {
    const r = item.result;
    if (!r) continue;
    const v = values?.get(normalizePlaceQuery(item.query));
    out.push({
      lat: r.lat,
      long: r.lon,
      label: r.name,
      value: v !== undefined && Number.isFinite(v) ? v : undefined,
    });
  }
  return out;
}
