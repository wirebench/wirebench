import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../../src/identity/rate-limit.js';

describe('RateLimiter (§3.6)', () => {
  const limiter = (start = 0) => {
    let now = start;
    const limit = new RateLimiter({ capacity: 10, refillPerMs: 10 / 60_000, now: () => now });
    return { limit, tick: (ms: number) => (now += ms) };
  };
  it('allows ten attempts a minute per key, then refuses with a Retry-After', () => {
    const { limit } = limiter();
    for (let i = 0; i < 10; i += 1) expect(limit.take('ip:1').allowed).toBe(true);
    const refused = limit.take('ip:1');
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(6);
    expect(limit.take('ip:2').allowed).toBe(true);
  });
  it('refills one attempt every six seconds and never beyond the capacity', () => {
    const { limit, tick } = limiter();
    for (let i = 0; i < 10; i += 1) limit.take('k');
    tick(6_000);
    expect(limit.take('k').allowed).toBe(true);
    expect(limit.take('k').allowed).toBe(false);
    tick(600_000);
    for (let i = 0; i < 10; i += 1) expect(limit.take('k').allowed).toBe(true);
    expect(limit.take('k').allowed).toBe(false);
  });
});
