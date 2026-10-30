import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { RateLimiter, callerKey, chargeKeys, emailKey, ipKey } from '../../../src/identity/rate-limit.js';
import { scopeOf } from '../../../src/tenancy/scope.js';

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
  it('peeks without taking an attempt', () => {
    const { limit, tick } = limiter();
    expect(limit.peek('k').allowed).toBe(true);
    for (let i = 0; i < 10; i += 1) limit.take('k');
    for (let i = 0; i < 3; i += 1) expect(limit.peek('k').allowed).toBe(false);
    expect(limit.peek('k').retryAfterSeconds).toBeGreaterThanOrEqual(1);
    tick(6_000);
    expect(limit.peek('k').allowed).toBe(true);
    expect(limit.peek('k').allowed).toBe(true);
    expect(limit.take('k').allowed).toBe(true);
    expect(limit.peek('k').allowed).toBe(false);
  });
});

describe('the sign-in limiter keys (hosted edition spec §19.8 guard 5)', () => {
  const ONE = scopeOf({ id: '00000000-0000-4000-8000-000000000001', slug: 'one' });
  const TWO = scopeOf({ id: '00000000-0000-4000-8000-000000000002', slug: 'two' });
  /** One address, one email and one user id, sent to the tenant `tenant`. */
  const request = (tenant: typeof ONE) =>
    ({
      tenant,
      ip: '203.0.113.7',
      body: { email: 'Ada@Example.com' },
      caller: { id: '01JB3Z9K7Q4ZJ6X1V8W2M5N0AA' },
    }) as unknown as FastifyRequest;

  it('lead with the tenant id, so the same address, email or user in two tenants are two keys', () => {
    expect(ipKey(request(ONE))).toBe(`${ONE.tenantId}:ip:203.0.113.7`);
    expect(emailKey(request(ONE))).toBe(`${ONE.tenantId}:email:ada@example.com`);
    expect(callerKey(request(ONE))).toBe(`${ONE.tenantId}:user:01JB3Z9K7Q4ZJ6X1V8W2M5N0AA`);
    for (const key of [ipKey, emailKey, callerKey]) expect(key(request(ONE))).not.toBe(key(request(TWO)));
  });

  it("never let one tenant's attempts use up another's", () => {
    const limiter = new RateLimiter({ capacity: 10, refillPerMs: 10 / 60_000, now: () => 0 });
    const keys = (tenant: typeof ONE) => [ipKey(request(tenant)), emailKey(request(tenant))];
    for (let i = 0; i < 10; i += 1) expect(chargeKeys(limiter, keys(ONE))).toBe(0);
    expect(chargeKeys(limiter, keys(ONE))).toBeGreaterThan(0);
    expect(chargeKeys(limiter, keys(TWO))).toBe(0);
  });
});
