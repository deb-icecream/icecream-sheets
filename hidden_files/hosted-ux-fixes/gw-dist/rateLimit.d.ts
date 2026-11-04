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
export interface RateLimiter {
    take(key: string, nowMs?: number): RateLimitResult;
    /** Inspect remaining tokens (for tests / status pages). */
    remaining(key: string, nowMs?: number): number;
    /** Forget a key's bucket (for tests). */
    reset(key: string): void;
    /** Forget all buckets (for tests). */
    resetAll(): void;
}
export declare function createRateLimiter(opts: RateLimiterOptions): RateLimiter;
