/**
 * Token-bucket rate limiter, keyed by principal (IP fallback at the
 * gateway). Pure logic — no HTTP — so it is unit-testable.
 *
 * Each key owns a bucket holding up to `points` tokens. Tokens refill
 * continuously at `points / perSeconds` tokens per second. A request
 * consumes one token; when the bucket is empty the request is denied with
 * the number of milliseconds until the next token is available
 * (retryAfterMs).
 */

export interface RateLimiterOptions {
  /** Bucket capacity (max burst). Must be >= 1. */
  points: number;
  /** Window in which `points` tokens refill. Must be > 0. */
  perSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until at least one token is available (0 when allowed). */
  retryAfterMs: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export interface RateLimiter {
  take(key: string, nowMs?: number): RateLimitResult;
  /** Inspect remaining tokens (for tests / status pages). */
  remaining(key: string, nowMs?: number): number;
  /** Forget a key's bucket (for tests). */
  reset(key: string): void;
  /** Forget all buckets (for tests). */
  resetAll(): void;
}

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const { points, perSeconds } = opts;
  if (!Number.isFinite(points) || points < 1) throw new Error('rateLimit: points must be >= 1');
  if (!Number.isFinite(perSeconds) || perSeconds <= 0) throw new Error('rateLimit: perSeconds must be > 0');

  const refillPerMs = points / (perSeconds * 1000);
  const buckets = new Map<string, Bucket>();

  function bucketFor(key: string, nowMs: number): Bucket {
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: points, lastRefillMs: nowMs };
      buckets.set(key, b);
      return b;
    }
    const elapsed = Math.max(0, nowMs - b.lastRefillMs);
    if (elapsed > 0) {
      b.tokens = Math.min(points, b.tokens + elapsed * refillPerMs);
      b.lastRefillMs = nowMs;
    }
    return b;
  }

  return {
    take(key: string, nowMs: number = Date.now()): RateLimitResult {
      const b = bucketFor(key, nowMs);
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return { allowed: true, retryAfterMs: 0 };
      }
      // Time until the next token becomes available.
      const retryAfterMs = Math.max(1, Math.ceil((1 - b.tokens) / refillPerMs));
      return { allowed: false, retryAfterMs };
    },
    remaining(key: string, nowMs: number = Date.now()): number {
      return Math.floor(bucketFor(key, nowMs).tokens);
    },
    reset(key: string): void {
      buckets.delete(key);
    },
    resetAll(): void {
      buckets.clear();
    },
  };
}
