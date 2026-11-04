import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../src/rateLimit.js';

describe('createRateLimiter', () => {
  it('allows up to `points` requests, then denies', () => {
    const rl = createRateLimiter({ points: 3, perSeconds: 60 });
    expect(rl.take('a').allowed).toBe(true);
    expect(rl.take('a').allowed).toBe(true);
    expect(rl.take('a').allowed).toBe(true);
    const denied = rl.take('a');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills the bucket over time', () => {
    const rl = createRateLimiter({ points: 2, perSeconds: 10 }); // 0.2 tokens/ms... 2 per 10s
    const t0 = 1_000_000;
    expect(rl.take('a', t0).allowed).toBe(true);
    expect(rl.take('a', t0).allowed).toBe(true);
    expect(rl.take('a', t0).allowed).toBe(false);
    // Half the window later: one token refilled.
    expect(rl.take('a', t0 + 5000).allowed).toBe(true);
    expect(rl.take('a', t0 + 5000).allowed).toBe(false);
    // Full window later: bucket full again.
    expect(rl.take('a', t0 + 15000).allowed).toBe(true);
    expect(rl.take('a', t0 + 15000).allowed).toBe(true);
    expect(rl.take('a', t0 + 15000).allowed).toBe(false);
  });

  it('isolates buckets per key', () => {
    const rl = createRateLimiter({ points: 1, perSeconds: 60 });
    expect(rl.take('alice').allowed).toBe(true);
    expect(rl.take('alice').allowed).toBe(false);
    expect(rl.take('bob').allowed).toBe(true);
    expect(rl.take('bob').allowed).toBe(false);
  });

  it('reports retryAfterMs until the next token', () => {
    const rl = createRateLimiter({ points: 1, perSeconds: 2 }); // 1 token per 2s
    const t0 = 5_000_000;
    expect(rl.take('k', t0).allowed).toBe(true);
    const denied = rl.take('k', t0);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(2000);
    // After 2s a token is available again.
    expect(rl.take('k', t0 + 2000).allowed).toBe(true);
  });

  it('never exceeds capacity after long idle', () => {
    const rl = createRateLimiter({ points: 2, perSeconds: 60 });
    const t0 = 9_000_000;
    expect(rl.take('k', t0).allowed).toBe(true);
    // Idle for an hour: bucket refills to exactly capacity, no more.
    expect(rl.remaining('k', t0 + 3_600_000)).toBe(2);
  });

  it('rejects invalid options', () => {
    expect(() => createRateLimiter({ points: 0, perSeconds: 60 })).toThrow();
    expect(() => createRateLimiter({ points: 5, perSeconds: 0 })).toThrow();
  });

  it('reset clears a key', () => {
    const rl = createRateLimiter({ points: 1, perSeconds: 60 });
    expect(rl.take('k').allowed).toBe(true);
    expect(rl.take('k').allowed).toBe(false);
    rl.reset('k');
    expect(rl.take('k').allowed).toBe(true);
  });
});
