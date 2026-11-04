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
export function createRateLimiter(opts) {
    const { points, perSeconds } = opts;
    if (!Number.isFinite(points) || points < 1)
        throw new Error('rateLimit: points must be >= 1');
    if (!Number.isFinite(perSeconds) || perSeconds <= 0)
        throw new Error('rateLimit: perSeconds must be > 0');
    const refillPerMs = points / (perSeconds * 1000);
    const buckets = new Map();
    function bucketFor(key, nowMs) {
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
        take(key, nowMs = Date.now()) {
            const b = bucketFor(key, nowMs);
            if (b.tokens >= 1) {
                b.tokens -= 1;
                return { allowed: true, retryAfterMs: 0 };
            }
            // Time until the next token becomes available.
            const retryAfterMs = Math.max(1, Math.ceil((1 - b.tokens) / refillPerMs));
            return { allowed: false, retryAfterMs };
        },
        remaining(key, nowMs = Date.now()) {
            return Math.floor(bucketFor(key, nowMs).tokens);
        },
        reset(key) {
            buckets.delete(key);
        },
        resetAll() {
            buckets.clear();
        },
    };
}
