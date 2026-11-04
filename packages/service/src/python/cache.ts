/**
 * Content-addressed result cache + dependency-graph invalidation for PY().
 *
 * Browser-safe (no Node imports): a host may keep the cache in the page or
 * on the server. Entries are keyed by sha256(envFingerprint + code + args),
 * so a cache hit is only possible when the exact code ran with the exact
 * arguments in the exact pinned environment — HyperFormula's dependency
 * graph drives invalidation naturally (a changed precedent re-runs PY with
 * new args, which misses the cache), and PyDependencyIndex below gives
 * hosts an explicit "which cached results went stale" API for code edits.
 */
import type { Persistence } from '../metadataStore.js';
import { KeyManager } from '../crypto.js';
import {
  EncryptedPersistence,
  SERVICE_SCOPE_ID,
  type AsyncPersistence,
} from '../secureStore.js';

// ---------------------------------------------------------------------------
// Pure-TypeScript SHA-256 (sync, dependency-free; matches node:crypto).
// ---------------------------------------------------------------------------

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** SHA-256 of a UTF-8 string, lowercase hex. */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLen = bytes.length * 8;
  // Padding: 0x80, zeros, then 64-bit big-endian length.
  const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const msg = new Uint8Array(paddedLen);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  const view = new DataView(msg.buffer);
  // 64-bit length: high 32 bits then low 32 (safe for realistic inputs).
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(paddedLen - 4, bitLen >>> 0);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Array<number>(64);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + w[i]!) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((x) => (x >>> 0).toString(16).padStart(8, '0'))
    .join('');
}

/** Cache key: sha256(envFingerprint + code + argsJson). */
export function pythonCacheKey(envFingerprint: string, code: string, argsJson: string): string {
  return sha256Hex(`pyresult/v1\n${envFingerprint}\n${code}\n${argsJson}`);
}

export interface CachedPythonResult {
  key: string;
  value: unknown;
  /** Base64 PNG plot when the run produced one (plots-in-cells). */
  plot?: string;
  envFingerprint: string;
  codeHash: string;
  ranAt: string;
}

export interface PythonResultCacheOptions {
  /** Max entries before oldest-first eviction. Defaults to 500. */
  maxEntries?: number;
  /** Max total bytes (value JSON + plot) before eviction. Defaults to 32 MiB. */
  maxBytes?: number;
  /** Storage key for persistence. Defaults to 'icecream-sheets.py-cache.v1'. */
  cacheKey?: string;
}

/**
 * Options for a persisted (warm-start) cache. Cached results may contain
 * copies of cell values, so persistence is ALWAYS encrypted at rest: the
 * raw adapter is wrapped in EncryptedPersistence, which is why `keys` is
 * required whenever `persistence` is given (no plaintext fallback).
 */
export interface PersistedPythonResultCacheOptions extends PythonResultCacheOptions {
  /** Raw persistence adapter for warm starts. */
  persistence: Persistence;
  /** KeyManager for the at-rest encryption. Required with persistence. */
  keys: KeyManager;
  /** KeyManager scope for the encrypted cache. Defaults to SERVICE_SCOPE_ID. */
  scopeId?: string;
}

const CACHE_STORE_VERSION = 1;

function entryBytes(e: CachedPythonResult): number {
  // JSON.stringify returns undefined (not a string) for undefined values;
  // the lib types say string, so narrow explicitly instead of ??.
  const json: string | undefined = JSON.stringify(e.value) as string | undefined;
  return e.key.length + (e.plot?.length ?? 0) + (json === undefined ? 0 : json.length);
}

export class PythonResultCache {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private backend: AsyncPersistence | null;
  private readonly cacheKey: string;
  /** Insertion-ordered map = LRU (get() re-inserts). */
  private entries = new Map<string, CachedPythonResult>();
  private bytes = 0;

  /**
   * In-memory cache (no persistence). For a warm-start cache backed by
   * encrypted storage, use the async `PythonResultCache.create()`.
   */
  constructor(opts: PythonResultCacheOptions = {}) {
    this.maxEntries = Math.max(1, opts.maxEntries ?? 500);
    this.maxBytes = Math.max(1024, opts.maxBytes ?? 32 * 1024 * 1024);
    this.backend = null;
    this.cacheKey = opts.cacheKey ?? 'icecream-sheets.py-cache.v1';
  }

  /**
   * Persisted cache: the raw adapter is wrapped in EncryptedPersistence so
   * every stored entry is AES-256-GCM ciphertext (§3). Loads previously
   * persisted entries; fail-closed on tampered envelopes.
   */
  static async create(opts: PersistedPythonResultCacheOptions): Promise<PythonResultCache> {
    if (!opts.persistence) throw new Error('python cache: persistence adapter is required');
    if (!opts.keys) throw new Error('python cache: persistence requires a KeyManager (no plaintext fallback)');
    const scopeId = opts.scopeId ?? SERVICE_SCOPE_ID;
    const backend = await EncryptedPersistence.create(opts.persistence, opts.keys, scopeId);
    const cache = new PythonResultCache(opts);
    cache.backend = backend;
    await cache.loadPersisted();
    return cache;
  }

  get(key: string): CachedPythonResult | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    // LRU touch.
    this.entries.delete(key);
    this.entries.set(key, e);
    return e;
  }

  /**
   * Store an entry. The in-memory update is synchronous; the encrypted
   * persistence write completes before the returned promise resolves.
   * Callers on sync hot paths (e.g. the engine's PythonProvider) may
   * fire-and-forget the promise — persistence is best-effort and never
   * rejects, and the in-memory cache works regardless.
   */
  async set(entry: CachedPythonResult): Promise<void> {
    const prev = this.entries.get(entry.key);
    if (prev) this.bytes -= entryBytes(prev);
    this.entries.delete(entry.key);
    this.entries.set(entry.key, entry);
    this.bytes += entryBytes(entry);
    this.evict();
    await this.persist();
  }

  /** Remove entries matching a predicate (default: all). Returns removed count. */
  async invalidate(predicate?: (e: CachedPythonResult) => boolean): Promise<number> {
    let removed = 0;
    for (const [k, e] of this.entries) {
      if (!predicate || predicate(e)) {
        this.entries.delete(k);
        this.bytes -= entryBytes(e);
        removed++;
      }
    }
    if (removed > 0) await this.persist();
    return removed;
  }

  async clear(): Promise<void> {
    await this.invalidate();
  }

  size(): number {
    return this.entries.size;
  }

  private evict(): void {
    while ((this.entries.size > this.maxEntries || this.bytes > this.maxBytes) && this.entries.size > 0) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const e = this.entries.get(oldest.value)!;
      this.entries.delete(oldest.value);
      this.bytes -= entryBytes(e);
    }
  }

  private async persist(): Promise<void> {
    if (!this.backend) return;
    try {
      await this.backend.save(
        this.cacheKey,
        JSON.stringify({ version: CACHE_STORE_VERSION, entries: [...this.entries.values()] }),
      );
    } catch {
      // Persistence is best-effort; the in-memory cache still works.
      // Never rejects, so fire-and-forget callers are safe.
    }
  }

  private async loadPersisted(): Promise<void> {
    if (!this.backend) return;
    try {
      const raw = await this.backend.load(this.cacheKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { version?: number; entries?: CachedPythonResult[] };
      if (parsed.version !== CACHE_STORE_VERSION || !Array.isArray(parsed.entries)) return;
      for (const e of parsed.entries) {
        if (e && typeof e.key === 'string') {
          this.entries.set(e.key, e);
          this.bytes += entryBytes(e);
        }
      }
      this.evict();
    } catch {
      // Corrupt cache never breaks startup.
    }
  }
}

// ---------------------------------------------------------------------------
// Dependency-graph invalidation index.
// ---------------------------------------------------------------------------

/**
 * Explicit dependency-graph invalidation for cached PY() results.
 *
 * The cache key already covers (envFingerprint, code, args), so a changed
 * precedent misses automatically on recalc. This index covers the
 * remaining case the key cannot see: the FORMULA TEXT of a PY cell changed
 * (or the cell was deleted), leaving an orphaned cache entry behind.
 * Hosts feed it the current PY formulas per recalc; it reports the
 * addresses whose cached results are stale so the host can drop them.
 */
export class PyDependencyIndex {
  /** addressKey -> { codeHash, cacheKey } */
  private readonly seen = new Map<string, { codeHash: string; cacheKey: string }>();

  /** Record that addressKey evaluated code (with this cache key). */
  noteEvaluated(addressKey: string, code: string, cacheKey: string): void {
    this.seen.set(addressKey, { codeHash: sha256Hex(code), cacheKey });
  }

  /**
   * Compare against the current PY formulas (addressKey -> code).
   * Returns stale entries: { addressKey, cacheKey, reason } where reason is
   * 'code-changed' or 'formula-removed'. The caller drops the cache keys.
   */
  staleAddresses(
    current: Map<string, string>,
  ): { addressKey: string; cacheKey: string; reason: 'code-changed' | 'formula-removed' }[] {
    const stale: { addressKey: string; cacheKey: string; reason: 'code-changed' | 'formula-removed' }[] = [];
    const currentHashes = new Map<string, string>();
    for (const [addr, code] of current) currentHashes.set(addr, sha256Hex(code));
    for (const [addr, rec] of this.seen) {
      const now = currentHashes.get(addr);
      if (now === undefined) {
        stale.push({ addressKey: addr, cacheKey: rec.cacheKey, reason: 'formula-removed' });
      } else if (now !== rec.codeHash) {
        stale.push({ addressKey: addr, cacheKey: rec.cacheKey, reason: 'code-changed' });
      }
    }
    return stale;
  }

  /** Forget one address (after its cache entries were dropped). */
  drop(addressKey: string): void {
    this.seen.delete(addressKey);
  }

  /** Forget everything (workbook closed). */
  clear(): void {
    this.seen.clear();
  }

  size(): number {
    return this.seen.size;
  }
}
